/**
 * Engineering Organisation Extension
 *
 * Provides a team roster and a `delegate` tool so the engineering manager
 * (the top-level pi session) can dispatch work to specialised team members.
 *
 * Each team member maps to a role definition in `.pi/agents/<role>.md`.
 * Delegation spawns an isolated `pi` subprocess using the role's system prompt.
 *
 * Commands:
 *   /team    — show current roster
 *   /hire    — hire a team member for a role
 *   /fire    — remove a team member
 *   /roles   — list available roles
 *
 * Tool:
 *   delegate — single / parallel / chain delegation modes
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parseFrontmatter, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { UsageStats, fmtTokens, formatUsage } from "./utils.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	memory?: boolean;
}

export type { UsageStats };

interface RunResult {
	exitCode: number;
	output: string;
	stderr: string;
	usage: UsageStats;
}

type StreamEvent =
	| { kind: "text"; text: string }
	| { kind: "tool"; name: string; summary: string };

// ─── Name Pool ────────────────────────────────────────────────────────────────

const NAME_POOL = [
	"Alex Rivera",
	"Sam Chen",
	"Jordan Blake",
	"Casey Kim",
	"Morgan Ellis",
	"Riley Torres",
	"Avery Walsh",
	"Quinn Patel",
	"Drew Nakamura",
	"Sage Okonkwo",
	"Rowan Fernandez",
	"Skyler Nguyen",
	"Blake O'Brien",
	"Remy Osei",
	"Finley Park",
	"Hayden Yamamoto",
	"Kendall Mbeki",
	"Jesse Andersen",
	"Reese Kapoor",
	"Emery Vidal",
	"Caden Zhao",
	"Noel Achebe",
	"Tatum Larsson",
	"Lennox Ibrahim",
	"Scout Petrov",
	"Blaine Mwangi",
	"Mercer Lin",
	"Darcy Oduya",
	"Vale Hassan",
	"Zion Bergström",
];

// ─── Roster helpers ───────────────────────────────────────────────────────────

export interface TeamMember {
	id: string;
	name: string;
	role: string;
	hiredAt: string;
}

export interface Roster {
	members: TeamMember[];
	usedNames: string[];
}

function getRosterPath(cwd: string): string {
	return path.join(cwd, ".pi", "roster.json");
}

export function loadRoster(cwd: string): Roster {
	const p = getRosterPath(cwd);
	if (!fs.existsSync(p)) return { members: [], usedNames: [] };
	try {
		const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<Roster>;
		return {
			members: Array.isArray(parsed.members) ? parsed.members : [],
			usedNames: Array.isArray(parsed.usedNames) ? parsed.usedNames : [],
		};
	} catch {
		return { members: [], usedNames: [] };
	}
}

export async function saveRoster(cwd: string, roster: Roster): Promise<void> {
	const p = getRosterPath(cwd);
	await withFileMutationQueue(p, () =>
		fs.promises.writeFile(p, JSON.stringify(roster, null, 2), "utf-8"),
	);
}

export function pickUnusedName(usedNames: string[]): string | null {
	const available = NAME_POOL.filter((n) => !usedNames.includes(n));
	if (available.length === 0) return null;
	return available[Math.floor(Math.random() * available.length)];
}

export function nameToId(name: string): string {
	return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

// ─── Agent config helpers ─────────────────────────────────────────────────────

function getAgentsDir(cwd: string): string {
	return path.join(cwd, ".pi", "agents");
}

export function loadAgentConfig(cwd: string, roleName: string): AgentConfig | null {
	const filePath = path.join(getAgentsDir(cwd), `${roleName}.md`);
	if (!fs.existsSync(filePath)) return null;
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(raw);
		if (!frontmatter.name || !frontmatter.description) return null;
		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);
		return {
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools?.length ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			memory: frontmatter.memory === "true" || frontmatter.memory === true,
		};
	} catch {
		return null;
	}
}

export function listAvailableRoles(cwd: string): string[] {
	const dir = getAgentsDir(cwd);
	if (!fs.existsSync(dir)) return [];
	try {
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => f.slice(0, -3));
	} catch {
		return [];
	}
}

// ─── Memory helpers ──────────────────────────────────────────────────────────

function memberMemoryPath(cwd: string, memberName: string): string {
	const id = memberName.toLowerCase().replace(/\s+/g, '-');
	return path.join(cwd, '.pi', 'memory', `${id}.md`);
}

// ─── Subagent spawning ────────────────────────────────────────────────────────

async function writeTempPrompt(name: string, content: string): Promise<{ dir: string; file: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-org-"));
	const file = path.join(dir, `${name.replace(/[^\w.-]+/g, "_")}.md`);
	await withFileMutationQueue(file, () =>
		fs.promises.writeFile(file, content, { encoding: "utf-8", mode: 0o600 }),
	);
	return { dir, file };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	const isBunVirtual = script?.startsWith("/$bunfs/root/");
	if (script && !isBunVirtual && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (/^(node|bun)(\.exe)?$/.test(execName)) return { command: "pi", args };
	return { command: process.execPath, args };
}

export type JsonMessage = { role: string; content: { type: string; text?: string }[] };

export function getFinalOutput(messages: JsonMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text) return part.text;
			}
		}
	}
	return "";
}

async function runTask(
	config: AgentConfig,
	memberName: string,
	task: string,
	cwd: string,
	signal?: AbortSignal,
	onProgress?: (text: string) => void,
	onStream?: (event: StreamEvent) => void,
): Promise<RunResult> {
	const args: string[] = ["--mode", "json", "-p", "--no-session", "--system-prompt", "", "--no-context-files"];
	if (config.model) args.push("--model", config.model);
	if (config.tools?.length) args.push("--tools", config.tools.join(","));

	const usage: UsageStats = {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
		cost: 0, contextTokens: 0
	};
	let tmpDir: string | null = null;
	let tmpFile: string | null = null;
	const messages: JsonMessage[] = [];
	let stderr = "";

	try {
		let promptContent = config.systemPrompt;
		// Per-member memory injection (always on)
		const memPath = memberMemoryPath(cwd, memberName);
		try {
			let memBlock = `\n\n---\n## Your Identity & Memory\n\nYour name is ${memberName}. Your memory file is at ${memPath}.\n\nAt the start of each task, read your memory file if it exists to recall relevant context. At the end of each task, update your memory file directly using your write/edit tools to record anything useful — decisions made, pitfalls encountered, codebase landmarks discovered. You own this file; maintain it however works best for you.`;
			if (fs.existsSync(memPath)) {
				const raw = fs.readFileSync(memPath, 'utf-8');
				if (raw.trim()) {
					memBlock += `\n\n${raw.trim()}`;
				}
			}
			promptContent += memBlock;
		} catch {
			// Memory read failure is non-fatal — proceed without it
		}

		if (promptContent.trim()) {
			const tmp = await writeTempPrompt(config.name, promptContent);
			tmpDir = tmp.dir;
			tmpFile = tmp.file;
			args.push("--append-system-prompt", tmpFile);
		}

		args.push(`Task for ${memberName}: ${task}`);

		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const inv = getPiInvocation(args);
			const proc = spawn(inv.command, inv.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buf = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let ev: any;
				try {
					ev = JSON.parse(line);
				} catch {
					return;
				}
				if (ev.type === "message_end" && ev.message) {
					messages.push(ev.message as JsonMessage);
					if (ev.message.role === "assistant") {
						const out = getFinalOutput(messages);
						if (out) onProgress?.(out);
						if (out) onStream?.({ kind: "text", text: out });
						const u = (ev.message as any).usage;
						if (u) {
							usage.input      += u.input       ?? 0;
							usage.output     += u.output      ?? 0;
							usage.cacheRead  += u.cacheRead   ?? 0;
							usage.cacheWrite += u.cacheWrite  ?? 0;
							usage.cost       += u.cost?.total ?? 0;
							usage.contextTokens = u.totalTokens ?? 0;
						}
					}
				}
				if (ev.type === "tool_result_end" && ev.message) {
					messages.push(ev.message as JsonMessage);
				}
				// Tool call streaming indicator
				const toolName = ev.name ?? ev.tool_name ?? ev.tool;
				if (toolName && typeof toolName === "string" &&
					(ev.type === "tool_use" || ev.type === "tool_use_start" || ev.type === "tool_call")) {
					onStream?.({ kind: "tool", name: toolName, summary: "" });
				}
			};

			proc.stdout.on("data", (d: Buffer) => {
				buf += d.toString();
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (d: Buffer) => {
				stderr += d.toString();
			});

			proc.on("close", (code) => {
				if (buf.trim()) processLine(buf);
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			if (signal) {
				const kill = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) kill();
				else signal.addEventListener("abort", kill, { once: true });
			}
		});

		if (wasAborted) throw new Error("Task aborted");
		const rawOutput = getFinalOutput(messages);
		const finalOutput = rawOutput;
		return { exitCode, output: finalOutput, stderr, usage };
	} finally {
		if (tmpFile) {
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				/* ignore */
			}
		}
		if (tmpDir) {
			try {
				fs.rmdirSync(tmpDir);
			} catch {
				/* ignore */
			}
		}
	}
}

// ─── Stream snippet helpers ──────────────────────────────────────────────────

const ANSI_STRIP_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

function lastMeaningfulLine(text: string, maxLen: number): string {
	const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
	const last = lines[lines.length - 1] ?? "";
	// If last "line" is a lone bracket/punctuation char, fall back to tail of full text
	if (last.length <= 1) {
		const full = text.replace(ANSI_STRIP_RE, "").trim();
		return full.length > maxLen ? full.slice(-maxLen) : full;
	}
	return last.length > maxLen ? last.slice(-maxLen) : last;
}

function extractStreamSnippet(ev: StreamEvent): string {
	if (ev.kind === "tool") return `⚙ ${ev.name}`;
	if (ev.kind === "text") return lastMeaningfulLine(ev.text.replace(ANSI_STRIP_RE, ""), 80);
	return "";
}

// ─── Tool parameter schemas ───────────────────────────────────────────────────

const AssigneeFields = {
	member: Type.Optional(
		Type.String({
			description: "Team member's full name (e.g. 'Casey Kim'). Use /team to see the roster.",
		}),
	),
	role: Type.Optional(
		Type.String({
			description:
				"Role name (e.g. 'typescript-engineer'). Delegates to the first team member with that role. Use /roles to see available roles.",
		}),
	),
	task: Type.String({
		description:
			"The task to delegate. Be self-contained — include all context the team member needs (relevant files, specs, constraints).",
	}),
	cwd: Type.Optional(Type.String({ description: "Override working directory for this task." })),
};

const DelegateParams = Type.Object({
	// Single mode
	member: Type.Optional(AssigneeFields.member),
	role: Type.Optional(AssigneeFields.role),
	task: Type.Optional(AssigneeFields.task),
	cwd: Type.Optional(AssigneeFields.cwd),
	// Parallel mode
	tasks: Type.Optional(
		Type.Array(Type.Object(AssigneeFields), {
			description: "Run multiple tasks in parallel. Max 8.",
		}),
	),
	// Async mode
	async: Type.Optional(Type.Boolean({
		description: "If true, start tasks in background and return immediately. Results are delivered into the conversation when each task completes. Default: false (blocking).",
	})),
	// Chain mode
	chain: Type.Optional(
		Type.Array(
			Type.Object({
				...AssigneeFields,
				task: Type.String({
					description:
						"Task for this step. Use {previous} to reference the previous step's output.",
				}),
			}),
			{
				description: "Run tasks sequentially; each step can reference {previous}.",
			},
		),
	),
});

// ─── Team state & widget ─────────────────────────────────────────────────────

type MemberStatus = "idle" | "working" | "done" | "error";
interface MemberState {
	status: MemberStatus;
	task?: string;       // brief snippet of current/last task
	streaming?: string;  // last live snippet from subprocess; only meaningful when status === "working"
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let asyncMode = true;
	const memberState = new Map<string, MemberState>();
	const memberUsage = new Map<string, UsageStats>();
	const memberTimers = new Map<string, ReturnType<typeof setTimeout>>();
	let lastCtx: any = null;

	const scalingLocks = new Map<string, Promise<void>>();

	function withScalingLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
		const prior = scalingLocks.get(cwd) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>(res => { release = res; });
		scalingLocks.set(cwd, prior.then(() => gate));
		return prior.then(async () => {
			try { return await fn(); }
			finally { release(); }
		});
	}

	function accumulateUsage(memberName: string, delta: UsageStats): void {
		const existing = memberUsage.get(memberName) ?? {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
			cost: 0, contextTokens: 0
		};
		memberUsage.set(memberName, {
			input:         existing.input        + delta.input,
			output:        existing.output       + delta.output,
			cacheRead:     existing.cacheRead    + delta.cacheRead,
			cacheWrite:    existing.cacheWrite   + delta.cacheWrite,
			cost:          existing.cost         + delta.cost,
			contextTokens: delta.contextTokens,  // take latest, not sum
		});
	}

	// ─── Streaming refresh & wrapper ─────────────────────────────────────────────

	const STREAM_REFRESH_INTERVAL_MS = 150;
	let widgetRefreshScheduled = false;

	function scheduleWidgetRefresh(): void {
		if (widgetRefreshScheduled) return;
		widgetRefreshScheduled = true;
		setTimeout(() => {
			widgetRefreshScheduled = false;
			if (lastCtx) updateWidget(lastCtx);
		}, STREAM_REFRESH_INTERVAL_MS);
	}

	function runTaskWithStreaming(
		config: AgentConfig,
		memberName: string,
		task: string,
		cwd: string,
		signal?: AbortSignal,
		onProgress?: (text: string) => void,
	): Promise<RunResult> {
		return runTask(config, memberName, task, cwd, signal, onProgress, (ev) => {
			const snippet = extractStreamSnippet(ev);
			if (!snippet) return;
			const state = memberState.get(memberName);
			if (state?.status === "working") {
				memberState.set(memberName, { ...state, streaming: snippet });
				scheduleWidgetRefresh();
			}
		});
	}

	function buildWidgetLines(cwd: string, width: number = 120): string[] {
		const roster = loadRoster(cwd);
		const lines: string[] = [`  Engineering Manager  (async: ${asyncMode ? "on" : "off"})`];

		if (roster.members.length === 0) {
			lines.push("  └─ (no team members — use /hire <role>)");
			return lines;
		}

		const STATUS_SYMBOLS: Record<MemberStatus, string> = {
			idle:    "○",
			working: "●",
			done:    "✓",
			error:   "✗",
		};

		roster.members.forEach((m, i) => {
			const isLast = i === roster.members.length - 1;
			const prefix = isLast ? "  └─ " : "  ├─ ";
			const state = memberState.get(m.name) ?? { status: "idle" };
			const symbol = STATUS_SYMBOLS[state.status];
			const namePart = m.name.padEnd(20);
			const rolePart = m.role.padEnd(22);
			const usage = memberUsage.get(m.name);
			const usageStr = usage && (usage.input > 0 || usage.output > 0)
				? `  ${formatUsage(usage)}`
				: "";
			const fixed = prefix.length + 20 + 22 + 1 + 1 + state.status.length;
			// usageStr contains only ASCII and narrow unicode (↑, ↓, digits, k, M, $, spaces),
			// so String.length equals visible character width — safe to use directly.
			const availableForTask = width - fixed - usageStr.length - 2;
			const rawTask = (state.status === "working" && state.streaming)
				? state.streaming
				: (state.task ?? "");
			const sanitizedTask = rawTask.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
			let taskNote = "";
			if (sanitizedTask && state.status !== "idle" && availableForTask > 3) {
				const snippet = sanitizedTask.length > availableForTask
					? sanitizedTask.slice(0, availableForTask - 1) + "…"
					: sanitizedTask;
				taskNote = `: ${snippet}`;
			}
			lines.push(`${prefix}${namePart}${rolePart}${symbol} ${state.status}${taskNote}${usageStr}`);
		});

		return lines.map(line => truncateToWidth(line, width));
	}

	let rosterWatcher: fs.FSWatcher | null = null;

	function scheduleDoneReset(memberName: string): void {
		const existing = memberTimers.get(memberName);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			const state = memberState.get(memberName);
			if (state?.status === "done") {
				memberState.set(memberName, { status: "idle" });
				if (lastCtx) updateWidget(lastCtx);
			}
			memberTimers.delete(memberName);
		}, 5 * 60 * 1000);
		memberTimers.set(memberName, timer);
	}

	function deliverResult(memberName: string, roleName: string, content: string): void {
		const header = `Background task completed — **${memberName}** (${roleName}):\n\n`;
		pi.sendUserMessage(header + content, { deliverAs: "followUp" });
	}

	function updateWidget(ctx: any): void {
		let hasUI: boolean;
		try {
			hasUI = ctx?.hasUI;
		} catch {
			return;
		}
		if (!hasUI) return;
		lastCtx = ctx;
		ctx.ui.setWidget("org-team", (_tui: any, _theme: any) => ({
			render(width: number): string[] {
				return buildWidgetLines(ctx.cwd, width);
			},
			invalidate() {}
		}), { placement: "belowEditor" });
	}

	// Show roster on startup and watch roster.json for external changes
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup" && event.reason !== "resume" && event.reason !== "reload") return;
		// Reset all state to idle on (re)start
		asyncMode = true;
		memberState.clear();
		memberUsage.clear();
		memberTimers.clear();
		const roster = loadRoster(ctx.cwd);
		if (roster.members.length > 0) {
			const lines = roster.members.map((m) => `  • ${m.name} (${m.role})`).join("\n");
			ctx.ui.notify(`Your team:\n${lines}`, "info");
		}
		updateWidget(ctx);

		// Watch roster.json so external changes (direct edits, scripts) update the widget
		rosterWatcher?.close();
		const rosterPath = getRosterPath(ctx.cwd);
		if (fs.existsSync(rosterPath)) {
			try {
				rosterWatcher = fs.watch(rosterPath, () => updateWidget(ctx));
			} catch {
				// Watcher unavailable in this environment — silently skip
			}
		}
	});

	pi.on("session_shutdown", async () => {
		rosterWatcher?.close();
		rosterWatcher = null;
		for (const timer of memberTimers.values()) clearTimeout(timer);
		memberTimers.clear();
	});

	// ── /team ──────────────────────────────────────────────────────────────────

	pi.registerCommand("team", {
		description: "Show the current team roster",
		handler: async (_args, ctx) => {
			const roster = loadRoster(ctx.cwd);
			if (roster.members.length === 0) {
				ctx.ui.notify("No team members yet. Use /hire <role> to bring someone on.", "info");
				return;
			}
			const roles = new Set(listAvailableRoles(ctx.cwd));
			const lines = roster.members.map((m) => {
				const ok = roles.has(m.role) ? "✓" : "⚠ missing role definition";
				return `${ok}  ${m.name} — ${m.role}`;
			});
			ctx.ui.notify(`Team roster (${roster.members.length} member${roster.members.length !== 1 ? "s" : ""}):\n${lines.join("\n")}`, "info");
		},
	});

	// ── /roles ─────────────────────────────────────────────────────────────────

	pi.registerCommand("roles", {
		description: "List available role definitions",
		handler: async (_args, ctx) => {
			const roleNames = listAvailableRoles(ctx.cwd);
			if (roleNames.length === 0) {
				ctx.ui.notify("No role definitions found in .pi/agents/", "info");
				return;
			}
			const roster = loadRoster(ctx.cwd);
			const lines = roleNames.map((r) => {
				const config = loadAgentConfig(ctx.cwd, r);
				const members = roster.members.filter((m) => m.role === r).map((m) => m.name);
				const staffed = members.length > 0 ? ` [${members.join(", ")}]` : " [unstaffed]";
				return `  ${r}${staffed}\n    ${config?.description ?? "(no description)"}`;
			});
			ctx.ui.notify(`Available roles:\n${lines.join("\n")}`, "info");
		},
	});

	// ── /hire ──────────────────────────────────────────────────────────────────

	pi.registerCommand("hire", {
		description: "Hire a team member: /hire <role-name>",
		handler: async (args, ctx) => {
			const roleName = args.trim();
			if (!roleName) {
				const roleNames = listAvailableRoles(ctx.cwd);
				ctx.ui.notify(
					`Usage: /hire <role-name>\n\nAvailable roles:\n${roleNames.map((r) => `  • ${r}`).join("\n") || "  (none found in .pi/agents/)"}`,
					"info",
				);
				return;
			}

			const config = loadAgentConfig(ctx.cwd, roleName);
			if (!config) {
				const roleNames = listAvailableRoles(ctx.cwd);
				ctx.ui.notify(
					`Role "${roleName}" not found in .pi/agents/\n\nAvailable: ${roleNames.join(", ") || "none"}`,
					"error",
				);
				return;
			}

			const roster = loadRoster(ctx.cwd);
			const name = pickUnusedName(roster.usedNames);
			if (!name) {
				ctx.ui.notify("Name pool exhausted — maximum team size reached.", "error");
				return;
			}

			const member: TeamMember = {
				id: nameToId(name),
				name,
				role: roleName,
				hiredAt: new Date().toISOString(),
			};

			roster.members.push(member);
			roster.usedNames.push(name);
			await saveRoster(ctx.cwd, roster);

			memberState.set(name, { status: "idle" });
			ctx.ui.notify(
				`Welcome aboard, ${name}!\nRole: ${roleName}\n${config.description}`,
				"success",
			);
			updateWidget(ctx);
		},
	});

	// ── /async ────────────────────────────────────────────────────────────────

	pi.registerCommand("async", {
		description: "Toggle async delegation on/off. When on, delegate returns immediately and delivers results as follow-up messages.",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") asyncMode = true;
			else if (arg === "off") asyncMode = false;
			else if (arg === "") asyncMode = !asyncMode;
			else {
				ctx.ui.notify("Usage: /async [on|off]", "info");
				return;
			}
			updateWidget(ctx);
			ctx.ui.notify(`Async delegation: ${asyncMode ? "on" : "off"}`, "info");
		},
	});

	// ── /fire ──────────────────────────────────────────────────────────────────

	pi.registerCommand("fire", {
		description: "Let go of a team member: /fire <name>",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) {
				ctx.ui.notify("Usage: /fire <member name>", "error");
				return;
			}

			const roster = loadRoster(ctx.cwd);
			const idx = roster.members.findIndex(
				(m) => m.name.toLowerCase() === query.toLowerCase(),
			);
			if (idx === -1) {
				const names = roster.members.map((m) => m.name).join(", ");
				ctx.ui.notify(`"${query}" not found.\nCurrent team: ${names || "none"}`, "error");
				return;
			}

			const member = roster.members[idx];
			const confirmed = await ctx.ui.confirm(
				"Remove team member?",
				`Let go of ${member.name} (${member.role})?`,
			);
			if (!confirmed) {
				ctx.ui.notify("Cancelled.", "info");
				return;
			}

			roster.members.splice(idx, 1);
			// Keep name in usedNames so it won't be re-assigned
			await saveRoster(ctx.cwd, roster);
			memberState.delete(member.name);
			// Clean up member memory file if it exists
			try {
				await fs.promises.unlink(memberMemoryPath(ctx.cwd, member.name));
			} catch {
				// File may not exist — that's fine
			}
			ctx.ui.notify(`${member.name} has left the team.`, "info");
			updateWidget(ctx);
		},
	});

	// ── hire tool ───────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "hire",
		label: "Hire",
		description: "Hire a new team member into a role. Use /roles to see available roles.",
		promptSnippet: "Hire a new team member into a role",
		parameters: Type.Object({
			role: Type.String({ description: "Role name to hire for (e.g. 'typescript-engineer'). Must match a file in .pi/agents/." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = loadAgentConfig(ctx.cwd, params.role);
			if (!config) {
				const available = listAvailableRoles(ctx.cwd).join(", ") || "none";
				throw new Error(`Role "${params.role}" not found. Available: ${available}`);
			}
			const roster = loadRoster(ctx.cwd);
			const name = pickUnusedName(roster.usedNames);
			if (!name) throw new Error("Name pool exhausted — maximum team size reached.");

			const member: TeamMember = {
				id: nameToId(name),
				name,
				role: params.role,
				hiredAt: new Date().toISOString(),
			};
			roster.members.push(member);
			roster.usedNames.push(name);
			await saveRoster(ctx.cwd, roster);
			memberState.set(name, { status: "idle" });
			updateWidget(ctx);

			return {
				content: [{ type: "text", text: `Hired ${name} as ${params.role}.` }],
				details: { member },
			};
		},
	});

	// ── fire tool ─────────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "fire",
		label: "Fire",
		description: "Remove a team member. Their name is permanently retired from the name pool.",
		promptSnippet: "Remove a team member from the roster",
		parameters: Type.Object({
			member: Type.String({ description: "Full name of the team member to remove (e.g. 'Casey Kim')." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const roster = loadRoster(ctx.cwd);
			const idx = roster.members.findIndex(
				m => m.name.toLowerCase() === params.member.toLowerCase()
			);
			if (idx === -1) {
				const names = roster.members.map(m => m.name).join(", ") || "none";
				throw new Error(`"${params.member}" not found. Current team: ${names}`);
			}
			const member = roster.members[idx];
			roster.members.splice(idx, 1);
			// Name stays in usedNames — permanently retired
			await saveRoster(ctx.cwd, roster);
			memberState.delete(member.name);
			// Clean up member memory file if it exists
			try {
				await fs.promises.unlink(memberMemoryPath(ctx.cwd, member.name));
			} catch {
				// File may not exist — that's fine
			}
			updateWidget(ctx);

			return {
				content: [{ type: "text", text: `${member.name} (${member.role}) has left the team.` }],
				details: { member },
			};
		},
	});

	// ── delegate tool ──────────────────────────────────────────────────────────

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: [
			"Delegate tasks to team members.",
			"Single: { member, task } or { role, task }.",
			"Parallel: { tasks: [{member|role, task}] } — up to 8 concurrent.",
			"Chain: { chain: [{member|role, task}] } — sequential, supports {previous} placeholder.",
			"Use /team to see the roster and /roles to see available roles.",
			"Add async: true to fire in background and return immediately — results are delivered into the conversation when complete.",
		].join(" "),
		parameters: DelegateParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Resolve a member+config from member name or role name, auto-scaling when all are busy
			async function resolveOrScale(
				member?: string,
				role?: string,
			): Promise<{ member: TeamMember; config: AgentConfig; hired: boolean } | { error: string }> {
				if (!member && !role) return { error: "Specify either member name or role." };

				// Named-member path
				if (member) {
					const roster = loadRoster(ctx.cwd);
					const m = roster.members.find(x => x.name.toLowerCase() === member.toLowerCase());
					if (!m) {
						const names = roster.members.map(x => x.name).join(", ") || "none";
						return { error: `Team member "${member}" not found. Current team: ${names}` };
					}
					const state = memberState.get(m.name) ?? { status: "idle" };
					if (state.status !== "working") {
						const config = loadAgentConfig(ctx.cwd, m.role);
						if (!config) return { error: `Role definition ".pi/agents/${m.role}.md" not found for ${m.name}.` };
						memberState.set(m.name, { status: "working" });
						return { member: m, config, hired: false };
					}
					// Member is busy — fall through to role-based path with their role
					role = m.role;
				}

				// Role-based path (with scaling lock to prevent parallel hire races)
				return withScalingLock(ctx.cwd, async () => {
					const roster = loadRoster(ctx.cwd);
					const roleMembers = roster.members.filter(x => x.role === role);

					// Find an idle member
					const idle = roleMembers.find(x =>
						(memberState.get(x.name) ?? { status: "idle" }).status !== "working"
					);
					if (idle) {
						const config = loadAgentConfig(ctx.cwd, idle.role);
						if (!config) return { error: `Role definition ".pi/agents/${idle.role}.md" not found for ${idle.name}.` };
						memberState.set(idle.name, { status: "working" });
						return { member: idle, config, hired: false };
					}

					// All busy — auto-hire
					const config = loadAgentConfig(ctx.cwd, role!);
					if (!config) return { error: `Role definition ".pi/agents/${role}.md" not found — cannot auto-hire for "${role}".` };

					const name = pickUnusedName(roster.usedNames);
					if (!name) {
						return { error: `Name pool exhausted — cannot auto-hire for role "${role}". The team has reached the 30-member lifetime limit. Use /fire to remove members (note: names are permanently retired).` };
					}

					const newMember: TeamMember = {
						id: nameToId(name),
						name,
						role: role!,
						hiredAt: new Date().toISOString(),
					};
					roster.members.push(newMember);
					roster.usedNames.push(name);

					// Write directly rather than via saveRoster: we are inside withScalingLock,
					// and while withFileMutationQueue (used by saveRoster) is orthogonal and would
					// not deadlock, writing here keeps the roster mutation atomic within the lock.
					// The practical risk of a concurrent /hire or /fire racing this write is
					// negligible — interactive commands do not overlap with in-flight delegation.
					await fs.promises.writeFile(
						getRosterPath(ctx.cwd),
						JSON.stringify(roster, null, 2),
						"utf-8"
					);

					memberState.set(newMember.name, { status: "working" });
					updateWidget(ctx); // immediate update; watcher will also fire
					return { member: newMember, config, hired: true };
				});
			}

			// ── Async: single mode ──────────────────────────────────────────
			if ((params.async ?? asyncMode) && params.task) {
				const r = await resolveOrScale(params.member, params.role);
				if ("error" in r) {
					return { content: [{ type: "text", text: r.error }], details: {}, isError: true };
				}
				const hiredNote = r.hired ? `Auto-hired ${r.member.name} (${r.config.name}) — ` : "";
				memberState.set(r.member.name, { status: "working", task: params.task });
				updateWidget(ctx);

				runTaskWithStreaming(r.config, r.member.name, params.task, params.cwd ?? ctx.cwd, signal)
					.then(result => {
						const status = result.exitCode === 0 ? "done" : "error";
						memberState.set(r.member.name, { status, task: params.task });
						accumulateUsage(r.member.name, result.usage);
						if (result.exitCode === 0) {
							scheduleDoneReset(r.member.name);
						}
						updateWidget(lastCtx);
						const content = result.exitCode === 0
							? result.output
							: `Error:\n${result.output || result.stderr || "(no output)"}`;
						deliverResult(r.member.name, r.config.name, content);
					})
					.catch(err => {
						memberState.set(r.member.name, { status: "error", task: params.task });
						updateWidget(lastCtx);
						deliverResult(r.member.name, r.config.name, `Task threw unexpectedly: ${err?.message ?? err}`);
					});

				return {
					content: [{ type: "text", text: `${hiredNote}Task started in background — ${r.member.name} is working.` }],
					details: {},
				};
			}

			// ── Async: parallel mode ──────────────────────────────────────────
			if ((params.async ?? asyncMode) && params.tasks?.length) {
				if (params.tasks.length > 8) {
					return { content: [{ type: "text", text: "Maximum 8 parallel tasks." }], details: {}, isError: true };
				}

				let started = 0;
				const ackLines: string[] = [];
				for (const [i, t] of params.tasks.entries()) {
					const r = await resolveOrScale(t.member, t.role);
					if ("error" in r) {
						deliverResult(t.member ?? t.role ?? `task ${i + 1}`, "unknown", `Could not start: ${r.error}`);
						continue;
					}
					const hiredNote = r.hired ? `Auto-hired ${r.member.name} (${r.config.name}) — ` : "";
					memberState.set(r.member.name, { status: "working", task: t.task });
					started++;
					ackLines.push(`${hiredNote}${r.member.name} starting in background.`);

					runTaskWithStreaming(r.config, r.member.name, t.task, t.cwd ?? ctx.cwd, signal)
						.then(result => {
							const status = result.exitCode === 0 ? "done" : "error";
							memberState.set(r.member.name, { status, task: t.task });
							accumulateUsage(r.member.name, result.usage);
							if (result.exitCode === 0) {
								scheduleDoneReset(r.member.name);
							}
							updateWidget(lastCtx);
							const content = result.exitCode === 0
								? result.output
								: `Error:\n${result.output || result.stderr || "(no output)"}`;
							deliverResult(r.member.name, r.config.name, content);
						})
						.catch(err => {
							memberState.set(r.member.name, { status: "error", task: t.task });
							updateWidget(lastCtx);
							deliverResult(r.member.name, r.config.name, `Task threw unexpectedly: ${err?.message ?? err}`);
						});
				}

				updateWidget(ctx);
				return {
					content: [{ type: "text", text: ackLines.join("\n") || `${started} task(s) started in background.` }],
					details: {},
				};
			}

			// ── Async: chain mode ─────────────────────────────────────────────
			if ((params.async ?? asyncMode) && params.chain?.length) {
				const chainLength = params.chain.length;

				(async () => {
					let previous = "";
					const sections: string[] = [];

					for (let i = 0; i < chainLength; i++) {
						const step = params.chain![i];
						const r = await resolveOrScale(step.member, step.role);
						if ("error" in r) {
							deliverResult("Chain", "error", `Step ${i + 1} failed to resolve: ${r.error}`);
							return;
						}

						const hiredNote = r.hired ? `Auto-hired ${r.member.name} (${r.config.name}) — ` : "";
						const task = step.task.replace(/\{previous\}/g, previous);
						memberState.set(r.member.name, { status: "working", task });
						updateWidget(lastCtx);
						pi.sendUserMessage(`${hiredNote}[chain ${i + 1}/${chainLength}] ${r.member.name} starting…`, { deliverAs: "followUp" });

						let result: RunResult;
						try {
							result = await runTaskWithStreaming(r.config, r.member.name, task, step.cwd ?? ctx.cwd, signal);
						} catch (err: any) {
							memberState.set(r.member.name, { status: "error", task });
							updateWidget(lastCtx);
							deliverResult("Chain", "error", `Step ${i + 1} (${r.member.name}) threw: ${err?.message ?? err}`);
							return;
						}

						if (result.exitCode !== 0) {
							memberState.set(r.member.name, { status: "error", task });
							updateWidget(lastCtx);
							deliverResult("Chain", "error",
								`Chain stopped at step ${i + 1} (${r.member.name}):\n${result.output || result.stderr || "(no output)"}`
							);
							return;
						}

						memberState.set(r.member.name, { status: "done", task });
						accumulateUsage(r.member.name, result.usage);
						scheduleDoneReset(r.member.name);
						updateWidget(lastCtx);
						previous = result.output;
						sections.push(`## Step ${i + 1}: ${r.member.name} (${r.config.name})\n\n${result.output}`);
					}

					pi.sendUserMessage(
						`Background chain completed (${chainLength} steps):\n\n${sections.join("\n\n---\n\n")}`,
						{ deliverAs: "followUp" }
					);
				})().catch(err => {
					pi.sendUserMessage(
						`Background chain failed unexpectedly: ${err?.message ?? err}`,
						{ deliverAs: "followUp" }
					);
				});

				return {
					content: [{ type: "text", text: `Chain of ${chainLength} steps started in background.` }],
					details: {},
				};
			}

			// ── Chain mode ────────────────────────────────────────────────────
			if (params.chain?.length) {
				const sections: string[] = [];
				let previous = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const r = await resolveOrScale(step.member, step.role);
					if ("error" in r) {
						return {
							content: [{ type: "text", text: `Chain step ${i + 1} failed: ${r.error}` }],
							details: {},
							isError: true,
						};
					}

					const hiredNote = r.hired ? `Auto-hired ${r.member.name} (${r.config.name}) — ` : "";
					const task = step.task.replace(/\{previous\}/g, previous);
					memberState.set(r.member.name, { status: "working", task });
					updateWidget(ctx);
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `${hiredNote}[chain ${i + 1}/${params.chain.length}] ${r.member.name} working...`,
							},
						],
						details: {},
					});

					const result = await runTaskWithStreaming(
						r.config,
						r.member.name,
						task,
						step.cwd ?? ctx.cwd,
						signal,
						(text) =>
							onUpdate?.({
								content: [
									{
										type: "text",
										text: `[chain ${i + 1}] ${r.member.name}: ${text.slice(0, 200)}…`,
									},
								],
								details: {},
							}),
					);

					if (result.exitCode !== 0) {
						memberState.set(r.member.name, { status: "error", task });
						updateWidget(ctx);
						return {
							content: [
								{
									type: "text",
									text: `Chain stopped at step ${i + 1} (${r.member.name}):\n${result.output || result.stderr || "(no output)"}`,
								},
							],
							details: {},
							isError: true,
						};
					}

					memberState.set(r.member.name, { status: "done", task });
					scheduleDoneReset(r.member.name);
					accumulateUsage(r.member.name, result.usage);
					updateWidget(ctx);
					previous = result.output;
					sections.push(
						`## Step ${i + 1}: ${r.member.name} (${r.config.name})\n\n${result.output}`,
					);
				}

				return {
					content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
					details: {},
				};
			}

			// ── Parallel mode ─────────────────────────────────────────────────
			if (params.tasks?.length) {
				if (params.tasks.length > 8) {
					return {
						content: [{ type: "text", text: "Maximum 8 parallel tasks." }],
						details: {},
						isError: true,
					};
				}

				const results = await Promise.all(
					params.tasks.map(async (t, i) => {
						const r = await resolveOrScale(t.member, t.role);
						if ("error" in r) {
							return {
								name: t.member ?? t.role ?? `task ${i + 1}`,
								output: r.error,
								exitCode: 1,
							};
						}
						const hiredNote = r.hired ? `Auto-hired ${r.member.name} (${r.config.name}) — ` : "";
						memberState.set(r.member.name, { status: "working", task: t.task });
						updateWidget(ctx);
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `${hiredNote}[parallel ${i + 1}/${params.tasks!.length}] ${r.member.name} starting…`,
								},
							],
							details: {},
						});
						const result = await runTaskWithStreaming(
							r.config,
							r.member.name,
							t.task,
							t.cwd ?? ctx.cwd,
							signal,
						);
						memberState.set(r.member.name, {
							status: result.exitCode === 0 ? "done" : "error",
							task: t.task,
						});
						if (result.exitCode === 0) scheduleDoneReset(r.member.name);
						accumulateUsage(r.member.name, result.usage);
						updateWidget(ctx);
						return { name: r.member.name, output: result.output, exitCode: result.exitCode };
					}),
				);

				const succeeded = results.filter((r) => r.exitCode === 0).length;
				const body = results
					.map((r) => `## ${r.name} ${r.exitCode === 0 ? "✓" : "✗"}\n\n${r.output}`)
					.join("\n\n---\n\n");

				return {
					content: [
						{
							type: "text",
							text: `${succeeded}/${results.length} tasks succeeded\n\n${body}`,
						},
					],
					details: {},
				};
			}

			// ── Single mode ───────────────────────────────────────────────────
			if (params.task) {
				const r = await resolveOrScale(params.member, params.role);
				if ("error" in r) {
					return { content: [{ type: "text", text: r.error }], details: {}, isError: true };
				}

				const hiredNote = r.hired ? `Auto-hired ${r.member.name} (${r.config.name}) — ` : "";
				memberState.set(r.member.name, { status: "working", task: params.task });
				updateWidget(ctx);
				onUpdate?.({
					content: [{ type: "text", text: `${hiredNote}${r.member.name} starting task…` }],
					details: {},
				});

				const result = await runTaskWithStreaming(
					r.config,
					r.member.name,
					params.task,
					params.cwd ?? ctx.cwd,
					signal,
					(text) =>
						onUpdate?.({
							content: [{ type: "text", text: `${r.member.name}: ${text.slice(0, 300)}…` }],
							details: {},
						}),
				);

				if (result.exitCode !== 0) {
					memberState.set(r.member.name, { status: "error", task: params.task });
					updateWidget(ctx);
					return {
						content: [
							{
								type: "text",
								text: `${r.member.name} encountered an error:\n${result.output || result.stderr || "(no output)"}`,
							},
						],
						details: {},
						isError: true,
					};
				}

				memberState.set(r.member.name, { status: "done", task: params.task });
				scheduleDoneReset(r.member.name);
				accumulateUsage(r.member.name, result.usage);
				updateWidget(ctx);
				return {
					content: [
						{
							type: "text",
							text: `**${r.member.name}** (${r.config.name}):\n\n${result.output}`,
						},
					],
					details: {},
				};
			}

			return {
				content: [
					{
						type: "text",
						text: "Specify task (single), tasks (parallel), or chain. Use /team to see the roster.",
					},
				],
				details: {},
				isError: true,
			};
		},
	});
}
