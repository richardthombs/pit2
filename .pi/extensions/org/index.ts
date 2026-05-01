/**
 * Engineering Organisation Extension
 *
 * Provides a team roster and a `delegate` tool so the engineering manager
 * (the top-level pi session) can dispatch work to specialised team members.
 *
 * Each team member maps to a role definition in `.pi/agents/<role>.md`.
 * Each team member runs as a persistent RpcClient subprocess, reused across tasks.
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

import { type ChildProcess, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parseFrontmatter, withFileMutationQueue, RpcClient } from "@mariozechner/pi-coding-agent";
import type { RpcClientOptions } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { UsageStats, fmtTokens, formatUsage } from "./utils.js";
import { broker } from "./broker.js";

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

function setMemberStatus(name: string, patch: Partial<MemberState>): void {
	const prev = memberState.get(name) ?? { status: "idle" as MemberStatus };
	memberState.set(name, { ...prev, ...patch });
}

// ─── Subagent persistent clients ────────────────────────────────────────────

/** Timeout for a single task's `waitForIdle()` call (10 minutes). */
const TASK_IDLE_TIMEOUT_MS = 600_000;

/** Timeout for the one-time memory-injection acknowledgement (30 seconds). */
const MEMORY_INIT_TIMEOUT_MS = 30_000;

interface LiveMemberEntry {
	client: RpcClient;
	lastUsed: number;     // Date.now() timestamp; updated at the start of every runTask() call
	initialized: boolean; // true after the one-time memory-injection prompt has been sent
}

// Key format: `${cwd}::${memberName}` — includes cwd so that two projects opened in the
// same pi instance do not share clients.
const liveMembers = new Map<string, LiveMemberEntry>();

function liveMemberKey(cwd: string, memberName: string): string {
	return `${cwd}::${memberName}`;
}

function memberSystemPromptPath(cwd: string, memberName: string): string {
	return path.join(cwd, ".pi", "prompts", "members", `${nameToId(memberName)}.md`);
}

async function buildMemberSystemPromptFile(
	config: AgentConfig,
	memberName: string,
	cwd: string,
): Promise<string> {
	const filePath = memberSystemPromptPath(cwd, memberName);
	const memPath = memberMemoryPath(cwd, memberName);
	let memInstructions: string;
	try {
		const memTemplatePath = path.join(cwd, ".pi", "prompts", "memory.md");
		const template = fs.readFileSync(memTemplatePath, "utf-8");
		memInstructions = `\n\n---\n${template
			.replace(/\[name\]/g, memberName)
			.replace(/\[path\]/g, memPath)}`;
	} catch {
		memInstructions =
			`\n\n---\n## Your Identity & Memory\n\n` +
			`Your name is ${memberName}. Your memory file is at ${memPath}.\n\n` +
			`At the start of each task, read your memory file if it exists to recall relevant context. ` +
			`At the end of each task, update your memory file directly using your write/edit tools to ` +
			`record anything useful — decisions made, pitfalls encountered, codebase landmarks discovered. ` +
			`You own this file; maintain it however works best for you.`;
	}

	const content = config.systemPrompt + memInstructions;
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	await withFileMutationQueue(filePath, () =>
		fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 }),
	);
	return filePath;
}

async function initializeClientMemory(
	client: RpcClient,
	memberName: string,
	cwd: string,
): Promise<void> {
	const memPath = memberMemoryPath(cwd, memberName);
	let memContent: string | null = null;
	try {
		const raw = fs.readFileSync(memPath, "utf-8");
		if (raw.trim()) memContent = raw.trim();
	} catch {
		// No memory file yet — that's fine
	}

	if (!memContent) return;

	await client.prompt(
		`Before your first task, here are your current memory file contents:\n\n${memContent}\n\n` +
		`Please acknowledge this context briefly.`
	);
	await client.waitForIdle(MEMORY_INIT_TIMEOUT_MS);
}

async function getOrCreateClient(
	config: AgentConfig,
	memberName: string,
	cwd: string,
): Promise<RpcClient> {
	// Persistent RPC clients require node as the executor — not supported with bun-compiled pi
	if (process.argv[1]?.startsWith("/$bunfs/root/")) {
		throw new Error(
			"Persistent RPC clients are not supported in bun-compiled pi binaries. " +
			"Use the Node.js pi script or contact the team to patch RpcClient.",
		);
	}

	const key = liveMemberKey(cwd, memberName);
	const existing = liveMembers.get(key);
	if (existing) {
		existing.lastUsed = Date.now();
		return existing.client;
	}

	// Build stable per-member system prompt file (written fresh each time a new client starts)
	const systemPromptFile = await buildMemberSystemPromptFile(config, memberName, cwd);

	const rpcArgs: string[] = [
		"--no-session",
		"--no-context-files",
		"--system-prompt", "",
		"--append-system-prompt", systemPromptFile,
	];
	if (config.tools?.length) {
		rpcArgs.push("--tools", config.tools.join(","));
	}

	const client = new RpcClient({
		cliPath: process.argv[1],
		cwd,
		model: config.model,
		args: rpcArgs,
	});

	await client.start();
	await client.setAutoCompaction(true);

	const entry: LiveMemberEntry = {
		client,
		lastUsed: Date.now(),
		initialized: false,
	};
	liveMembers.set(key, entry);

	// Attach crash recovery listener via private process field.
	// If the process exits between tasks, remove from liveMembers so the next
	// runTask() call creates a fresh client rather than using a dead one.
	const proc = (client as any).process as ChildProcess | null;
	proc?.once("exit", () => {
		if (liveMembers.get(key)?.client === client) {
			liveMembers.delete(key);
		}
	});

	return client;
}

function reapIdleClients(): void {
	const now = Date.now();
	const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
	for (const [key, entry] of liveMembers) {
		if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
			liveMembers.delete(key);
			entry.client.stop().catch(() => {});
		}
	}
}

async function stopLiveClient(cwd: string, memberName: string): Promise<void> {
	const key = liveMemberKey(cwd, memberName);
	const entry = liveMembers.get(key);
	if (entry) {
		liveMembers.delete(key);
		await entry.client.stop().catch(() => {});
	}
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
	// ── 1. Abort early if already cancelled ────────────────────────────────────────────
	if (signal?.aborted) throw new Error("Task aborted");

	// ── 2. Get or create persistent client ─────────────────────────────────────────
	const client = await getOrCreateClient(config, memberName, cwd);
	const key = liveMemberKey(cwd, memberName);
	const entry = liveMembers.get(key)!;
	entry.lastUsed = Date.now();

	// ── 3. Memory initialization (first task on a fresh client only) ─────────────────
	if (!entry.initialized) {
		try {
			await initializeClientMemory(client, memberName, cwd);
			entry.initialized = true;
		} catch (initErr: any) {
			// Memory injection failed — remove the broken client so the next call starts fresh
			await stopLiveClient(cwd, memberName);
			throw initErr;
		}
	}

	// ── 4. Per-task usage accumulator ───────────────────────────────────────────────
	const taskUsage: UsageStats = {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
		cost: 0, contextTokens: 0,
	};

	// ── 5. Register per-task event listener ─────────────────────────────────────────
	const unsubscribe = client.onEvent((ev) => {
		// Accumulate usage from each assistant turn
		if (ev.type === "message_end" && ev.message.role === "assistant") {
			const msg = ev.message as AssistantMessage;
			const u = msg.usage;
			if (u) {
				taskUsage.input      += u.input;
				taskUsage.output     += u.output;
				taskUsage.cacheRead  += u.cacheRead;
				taskUsage.cacheWrite += u.cacheWrite;
				taskUsage.cost       += u.cost?.total ?? 0;
				taskUsage.contextTokens = u.totalTokens; // overwrite — take latest
			}
		}

		// Live text streaming (fires many times per turn as tokens arrive)
		if (ev.type === "message_update" && ev.message.role === "assistant") {
			const msg = ev.message as AssistantMessage;
			const text = msg.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (text) {
				onProgress?.(text);
				onStream?.({ kind: "text", text });
			}
		}

		// Tool call indicator
		if (ev.type === "tool_execution_start") {
			onStream?.({ kind: "tool", name: ev.toolName, summary: "" });
		}
	});

	// ── 6. Cancellation wiring ────────────────────────────────────────────────────
	let aborted = false;
	let abortHandler: (() => void) | null = null;
	if (signal) {
		abortHandler = () => {
			aborted = true;
			client.abort().catch(() => {});
		};
		if (signal.aborted) {
			abortHandler();
		} else {
			signal.addEventListener("abort", abortHandler, { once: true });
		}
	}

	try {
		// ── 7. Send the task prompt ───────────────────────────────────────────────
		await client.prompt(`Task for ${memberName}: ${task}`);

		// ── 8. Wait for completion ─────────────────────────────────────────────────
		await client.waitForIdle(TASK_IDLE_TIMEOUT_MS);

		if (aborted) throw new Error("Task aborted");

		// ── 9. Collect output ──────────────────────────────────────────────────────
		const output = (await client.getLastAssistantText()) ?? "";
		if (!output) {
			// Agent completed but produced no text (e.g. interrupted, only tool calls).
			// Client is still alive — do not remove from liveMembers.
			return {
				exitCode: 1,
				output: "(no output)",
				stderr: client.getStderr(),
				usage: taskUsage,
			};
		}

		return { exitCode: 0, output, stderr: "", usage: taskUsage };
	} catch (err: any) {
		if (aborted || signal?.aborted) throw new Error("Task aborted");

		// Treat any non-abort error as a potential client crash — remove so next call recreates
		if (liveMembers.get(key)?.client === client) {
			liveMembers.delete(key);
			client.stop().catch(() => {});
		}

		const wrapper = new Error(`Member process crashed or disconnected — client removed: ${err?.message ?? err}`);
		(wrapper as any).cause = err;
		throw wrapper;
	} finally {
		unsubscribe();
		if (abortHandler && signal && !signal.aborted) {
			signal.removeEventListener("abort", abortHandler);
		}
	}
}

// ─── Beads helpers ───────────────────────────────────────────────────────────

/**
 * Run a bd command with BEADS_DIR set to <cwd>/.beads.
 * Returns { stdout, stderr } on success.
 * Throws on non-zero exit code (the error object carries .stdout and .stderr).
 */
async function runBd(
	cwd: string,
	args: string[],
): Promise<{ stdout: string; stderr: string }> {
	const beadsDir = path.join(cwd, ".beads");
	return execFile("bd", args, {
		cwd,
		env: { ...process.env, BEADS_DIR: beadsDir },
		timeout: 15_000, // 15 s — bd commands are always fast; treat timeout as an error
	});
}

/**
 * Module-level beads readiness registry.
 * true  = bd is available and .beads/ has been initialised for this cwd.
 * false = bd is unavailable or init failed; tools will surface a friendly error.
 */
const beadsReady = new Map<string, boolean>();

/**
 * Idempotent initialisation. Safe to call on every session_start.
 * On success sets beadsReady(cwd) = true.
 * On failure sets beadsReady(cwd) = false and calls notifyFn with a warning.
 */
async function ensureBeadsInit(
	cwd: string,
	notifyFn: (msg: string, level: "info" | "warn" | "error") => void,
): Promise<void> {
	if (beadsReady.has(cwd)) return; // already attempted this session

	const beadsDir = path.join(cwd, ".beads");

	// .beads/ already exists → assume initialised, no need to re-init
	if (fs.existsSync(beadsDir)) {
		beadsReady.set(cwd, true);
		return;
	}

	try {
		await runBd(cwd, ["init", "--stealth", "--non-interactive"]);
		beadsReady.set(cwd, true);
	} catch (err: any) {
		const msg =
			`Beads init failed (is bd installed and on PATH?): ${err?.message ?? err}. ` +
			`Workstream tracking will be unavailable this session.`;
		notifyFn(msg, "warn");
		beadsReady.set(cwd, false);
	}
}

// ─── Scaling lock (module-scope so resolveOrScale can access it) ───────────

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

// ─── resolveOrScale (module-scope so the broker can call it) ─────────────────

/**
 * Resolve an available member for the given role (or by name), auto-hiring
 * when all matching members are busy.
 *
 * Sets memberState to "working" for the resolved member.
 * Does NOT update the UI widget — callers are responsible for widget updates.
 */
async function resolveOrScale(
	cwd: string,
	memberState: Map<string, MemberState>,
	memberName: string | undefined,
	roleName: string | undefined,
): Promise<{ member: TeamMember; config: AgentConfig; hired: boolean } | { error: string }> {
	if (!memberName && !roleName) return { error: "Specify either member name or role." };

	// Named-member path
	if (memberName) {
		const roster = loadRoster(cwd);
		const m = roster.members.find(x => x.name.toLowerCase() === memberName.toLowerCase());
		if (!m) {
			const names = roster.members.map(x => x.name).join(", ") || "none";
			return { error: `Team member "${memberName}" not found. Current team: ${names}` };
		}
		const state = memberState.get(m.name) ?? { status: "idle" };
		if (state.status !== "working") {
			const config = loadAgentConfig(cwd, m.role);
			if (!config) return { error: `Role definition ".pi/agents/${m.role}.md" not found for ${m.name}.` };
			memberState.set(m.name, { status: "working" });
			return { member: m, config, hired: false };
		}
		// Member is busy — fall through to role-based path with their role
		roleName = m.role;
	}

	// Role-based path (with scaling lock to prevent parallel hire races)
	return withScalingLock(cwd, async () => {
		const roster = loadRoster(cwd);
		const roleMembers = roster.members.filter(x => x.role === roleName);

		// Find an idle member
		const idle = roleMembers.find(x =>
			(memberState.get(x.name) ?? { status: "idle" }).status !== "working"
		);
		if (idle) {
			const config = loadAgentConfig(cwd, idle.role);
			if (!config) return { error: `Role definition ".pi/agents/${idle.role}.md" not found for ${idle.name}.` };
			memberState.set(idle.name, { status: "working" });
			return { member: idle, config, hired: false };
		}

		// All busy — auto-hire
		const config = loadAgentConfig(cwd, roleName!);
		if (!config) return { error: `Role definition ".pi/agents/${roleName}.md" not found — cannot auto-hire for "${roleName}".` };

		const name = pickUnusedName(roster.usedNames);
		if (!name) {
			return { error: `Name pool exhausted — cannot auto-hire for role "${roleName}". The team has reached the 30-member lifetime limit. Use /fire to remove members (note: names are permanently retired).` };
		}

		const newMember: TeamMember = {
			id: nameToId(name),
			name,
			role: roleName!,
			hiredAt: new Date().toISOString(),
		};
		roster.members.push(newMember);
		roster.usedNames.push(name);

		// Write directly rather than via saveRoster: we are inside withScalingLock,
		// and while withFileMutationQueue (used by saveRoster) is orthogonal and would
		// not deadlock, writing here keeps the roster mutation atomic within the lock.
		await fs.promises.writeFile(
			getRosterPath(cwd),
			JSON.stringify(roster, null, 2),
			"utf-8"
		);

		memberState.set(newMember.name, { status: "working" });
		return { member: newMember, config, hired: true };
	});
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
	contextPct?: number | null; // context window usage %: undefined=not polled, null=model doesn't report, number=percentage
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let asyncMode = true;
	const memberState = new Map<string, MemberState>();
	const memberUsage = new Map<string, UsageStats>();
	const memberTimers = new Map<string, ReturnType<typeof setTimeout>>();
	let lastCtx: any = null;
	let reaperInterval: ReturnType<typeof setInterval> | null = null;

	// Configure the module-level broker singleton with closure-scoped deps.
	broker.configure(
		runBd,
		(cwd, ms, role) => resolveOrScale(cwd, ms, undefined, role),
		runTaskWithStreaming,
		memberState,
		(msg) => pi.sendUserMessage(msg, { deliverAs: "followUp" }),
	);

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

	async function runTaskWithStreaming(
		config: AgentConfig,
		memberName: string,
		task: string,
		cwd: string,
		signal?: AbortSignal,
		onProgress?: (text: string) => void,
	): Promise<RunResult> {
		const result = await runTask(config, memberName, task, cwd, signal, onProgress, (ev) => {
			const snippet = extractStreamSnippet(ev);
			if (!snippet) return;
			const state = memberState.get(memberName);
			if (state?.status === "working") {
				memberState.set(memberName, { ...state, streaming: snippet });
				scheduleWidgetRefresh();
			}
		});

		// Post-task: capture context usage percentage from the live client.
		// Must be try/caught — client may have crashed during the task.
		try {
			const entry = liveMembers.get(liveMemberKey(cwd, memberName));
			if (entry) {
				const stats = await entry.client.getSessionStats();
				const pct = stats.contextUsage?.percent ?? null;
				const current = memberState.get(memberName);
				if (current) memberState.set(memberName, { ...current, contextPct: pct });
			}
		} catch {
			// Non-fatal — leave contextPct at last known value
		}

		return result;
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
			// ctx:XX% suffix: shown whenever contextPct is a non-null number.
			const ctxStr = typeof state.contextPct === "number"
				? ` ctx:${Math.round(state.contextPct)}%`
				: "";
			const ctxReserve = typeof state.contextPct === "number" ? 8 : 0;
			const usageStr = (usage && (usage.input > 0 || usage.output > 0)
				? `  ${formatUsage(usage)}`
				: "") + ctxStr;
			const fixed = prefix.length + 20 + 22 + 1 + 1 + state.status.length;
			// usageStr contains only ASCII and narrow unicode (↑, ↓, digits, k, M, $, spaces),
			// so String.length equals visible character width — safe to use directly.
			const availableForTask = width - fixed - usageStr.length - 2 - (ctxReserve - ctxStr.length);
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

		// Start idle reaper (replaces any reaper from a prior session)
		if (reaperInterval) clearInterval(reaperInterval);
		reaperInterval = setInterval(async () => {
			reapIdleClients();

			// Piggyback: refresh context usage for all live members.
			let anyUpdated = false;
			for (const [key, entry] of liveMembers) {
				const sepIdx = key.indexOf("::");
				const name = sepIdx >= 0 ? key.slice(sepIdx + 2) : key;
				try {
					const stats = await entry.client.getSessionStats();
					const pct = stats.contextUsage?.percent ?? null;
					const current = memberState.get(name) ?? { status: "idle" as MemberStatus };
					memberState.set(name, { ...current, contextPct: pct });
					anyUpdated = true;
				} catch {
					// Non-fatal — leave contextPct at last known value
				}
			}
			if (anyUpdated && lastCtx) updateWidget(lastCtx);
		}, 60_000);

		await ensureBeadsInit(ctx.cwd, (msg, level) => ctx.ui.notify(msg, level));
	});

	pi.on("session_shutdown", async () => {
		rosterWatcher?.close();
		rosterWatcher = null;
		for (const timer of memberTimers.values()) clearTimeout(timer);
		memberTimers.clear();

		// Stop the idle reaper
		if (reaperInterval) {
			clearInterval(reaperInterval);
			reaperInterval = null;
		}

		// Stop the broker to prevent orphaned timers
		broker.stop();

		// Stop all live member clients
		await Promise.all([...liveMembers.values()].map(e => e.client.stop().catch(() => {})));
		liveMembers.clear();
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

			await stopLiveClient(ctx.cwd, member.name);
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
			// Clean up member system prompt file if it exists
			try {
				await fs.promises.unlink(memberSystemPromptPath(ctx.cwd, member.name));
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
			await stopLiveClient(ctx.cwd, member.name);
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
			// Clean up member system prompt file if it exists
			try {
				await fs.promises.unlink(memberSystemPromptPath(ctx.cwd, member.name));
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

	// ── beads workstream tools ──────────────────────────────────────────────────

	/** Returns an error result if beads is not available for ctx.cwd. */
	function beadsGuard(cwd: string): { content: [{ type: "text"; text: string }]; details: {}; isError: true } | null {
		if (beadsReady.get(cwd) !== true) {
			return {
				content: [{ type: "text", text: "Beads is not available (bd not installed or init failed). Workstream tracking is disabled." }],
				details: {},
				isError: true,
			};
		}
		return null;
	}

	pi.registerTool({
		name: "bd_workstream_start",
		label: "Workstream Start",
		description:
			"Create a beads epic to represent a new workstream. Call this when initiating any multi-step or multi-session effort. Returns the epic ID, which you must record for attaching tasks.",
		promptSnippet: "Start a tracked workstream",
		parameters: Type.Object({
			title: Type.String({
				description: "Short, unique workstream title. Should match the workstream label you use in your delegation notes (e.g. 'auth-refactor', 'onboarding-docs').",
			}),
			design: Type.Optional(Type.String({
				description: "Rationale for why this workstream is being started; the decision or requirement that prompted it.",
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const guard = beadsGuard(ctx.cwd);
			if (guard) return guard;

			const args = ["create", params.title, "--type=epic", "--json"];
			if (params.design) args.push(`--design=${params.design}`);

			try {
				const { stdout } = await runBd(ctx.cwd, args);
				const result = JSON.parse(stdout) as { id: string; title: string; [k: string]: unknown };
				if (!result?.id) throw new Error(`bd create returned unexpected shape: ${stdout}`);
				return {
					content: [{ type: "text", text: `Epic created. ID: ${result.id} — "${result.title}"` }],
					details: { id: result.id, title: result.title },
				};
			} catch (err: any) {
				throw new Error(`bd_workstream_start failed: ${err?.stderr ?? err?.message ?? err}`);
			}
		},
	});

	pi.registerTool({
		name: "bd_task_create",
		label: "Task Create",
		description:
			"Create a beads task to represent a unit of delegated work. Attach it to an epic with epic_id if this task is part of a tracked workstream. " +
			"Pass role to tag the task for broker dispatch — the broker will automatically delegate it to an available member with that role when it becomes ready. " +
			"Returns the task ID.",
		promptSnippet: "Create a tracked task bead",
		parameters: Type.Object({
			title: Type.String({
				description: "Brief description of the task being delegated.",
			}),
			epic_id: Type.Optional(Type.String({
				description: "ID of the parent epic (from bd_workstream_start). Omit only if this is a standalone task with no workstream.",
			})),
			design: Type.Optional(Type.String({
				description: "Rationale for this task — why it is needed, what decision it implements.",
			})),
			role: Type.Optional(Type.String({
				description:
					"Role slug to assign this task to (e.g. 'typescript-engineer', 'software-architect'). " +
					"If provided and the broker is active, the broker will auto-dispatch to an available member with this role when the task becomes ready. " +
					"Must match an agent slug in .pi/agents/. Use only one label per task.",
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const guard = beadsGuard(ctx.cwd);
			if (guard) return guard;

			const args = ["create", params.title, "--type=task", "--json"];
			if (params.epic_id) args.push(`--parent=${params.epic_id}`);
			if (params.design)  args.push(`--design=${params.design}`);
			if (params.role)    args.push(`--label=${params.role}`);

			try {
				const { stdout } = await runBd(ctx.cwd, args);
				const result = JSON.parse(stdout) as { id: string; title: string; [k: string]: unknown };
				if (!result?.id) throw new Error(`bd create returned unexpected shape: ${stdout}`);

				// Notify broker synchronously after successful write
				if (broker.active) broker.onTaskCreated(ctx.cwd);

				return {
					content: [{ type: "text", text: `Task created. ID: ${result.id} — "${result.title}"` }],
					details: { id: result.id, title: result.title },
				};
			} catch (err: any) {
				throw new Error(`bd_task_create failed: ${err?.stderr ?? err?.message ?? err}`);
			}
		},
	});

	pi.registerTool({
		name: "bd_task_update",
		label: "Task Update",
		description:
			"Update a beads task. Typically called after a delegation completes to close it (status: 'closed') and record key findings. Also use to mark a task in_progress when delegation starts. When status is 'closed', internally uses bd close which sets closed_at correctly.",
		promptSnippet: "Update a beads task status or notes",
		parameters: Type.Object({
			id: Type.String({
				description: "The beads task or epic ID to update.",
			}),
			status: Type.Optional(Type.Union(
				[
					Type.Literal("open"),
					Type.Literal("in_progress"),
					Type.Literal("blocked"),
					Type.Literal("deferred"),
					Type.Literal("closed"),
				],
				{ description: "New status for the issue. Use 'closed' to mark completion (routes to bd close internally)." },
			)),
			notes: Type.Optional(Type.String({
				description: "Key findings or output summary from the completed task. Concise — this is the persistent record.",
			})),
			design: Type.Optional(Type.String({
				description: "Update the design/rationale field (use if the approach changed during execution).",
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const guard = beadsGuard(ctx.cwd);
			if (guard) return guard;

			try {
				let result: { id: string; status: string; [k: string]: unknown };
				if (params.status === "closed") {
					// Use bd close to set closed_at correctly; notes passed as --reason
					const closeArgs = ["close", params.id, "--json"];
					if (params.notes) closeArgs.push(`--reason=${params.notes}`);
					const { stdout } = await runBd(ctx.cwd, closeArgs);
					result = (JSON.parse(stdout) as Array<{ id: string; status: string; [k: string]: unknown }>)[0];
				} else {
					const args = ["update", params.id, "--json"];
					if (params.status) args.push(`--status=${params.status}`);
					if (params.notes) args.push(`--append-notes=${params.notes}`);
					if (params.design) args.push(`--design=${params.design}`);
					const { stdout } = await runBd(ctx.cwd, args);
					result = (JSON.parse(stdout) as Array<{ id: string; status: string; [k: string]: unknown }>)[0];
				}

				// Notify broker after a successful write
				if (broker.active) {
					broker.onTaskUpdated(ctx.cwd, params.id, params.status ?? "");
				}

				return {
					content: [{ type: "text", text: `Updated ${result.id}: status=${result.status}` }],
					details: result,
				};
			} catch (err: any) {
				throw new Error(`bd_task_update failed: ${err?.stderr ?? err?.message ?? err}`);
			}
		},
	});

	pi.registerTool({
		name: "bd_dep_add",
		label: "Dep Add",
		description:
			"Record that one task blocks another (i.e. blocked_id cannot start until blocker_id is done). Use this to encode chain step ordering and parallel-merge gates.",
		promptSnippet: "Add a blocks dependency between tasks",
		parameters: Type.Object({
			blocker_id: Type.String({
				description: "ID of the task that must complete first.",
			}),
			blocked_id: Type.String({
				description: "ID of the task that cannot start until blocker_id is done.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const guard = beadsGuard(ctx.cwd);
			if (guard) return guard;

			try {
				// Argument order: bd dep add <blocked> <blocker> — first arg is the dependent task
				await runBd(ctx.cwd, ["dep", "add", params.blocked_id, params.blocker_id, "--type=blocks"]);
				return {
					content: [{ type: "text", text: `Dependency added: ${params.blocker_id} blocks ${params.blocked_id}` }],
					details: { blocker: params.blocker_id, blocked: params.blocked_id },
				};
			} catch (err: any) {
				throw new Error(`bd_dep_add failed: ${err?.stderr ?? err?.message ?? err}`);
			}
		},
	});

	pi.registerTool({
		name: "bd_list",
		label: "List",
		description:
			"List beads issues. Use to reconstruct workstream state after context compaction. By default returns only open/in_progress issues to reduce noise.",
		promptSnippet: "List beads workstream state",
		parameters: Type.Object({
			type: Type.Optional(Type.Union(
				[Type.Literal("epic"), Type.Literal("task")],
				{ description: "Filter by issue type. Omit to return all." },
			)),
			status: Type.Optional(Type.String({
				description: "Filter by status (e.g. 'open', 'in_progress', 'closed'). Valid values: open, in_progress, blocked, deferred, closed. Defaults to 'open,in_progress' if not specified.",
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const guard = beadsGuard(ctx.cwd);
			if (guard) return guard;

			const args = ["list", "--limit=0", "--json"];
			if (params.type) args.push(`--type=${params.type}`);
			// Default to open+in_progress to prevent returning large completed history.
			// Use comma-separated syntax — repeating the flag returns an empty array.
			args.push(`--status=${params.status ?? "open,in_progress"}`);

			try {
				const { stdout } = await runBd(ctx.cwd, args);
				const items = JSON.parse(stdout) as unknown[];
				return {
					content: [{ type: "text", text: JSON.stringify(items, null, 2) }],
					details: { count: items.length, items },
				};
			} catch (err: any) {
				throw new Error(`bd_list failed: ${err?.stderr ?? err?.message ?? err}`);
			}
		},
	});

	pi.registerTool({
		name: "bd_show",
		label: "Show",
		description:
			"Show full details of a single beads issue, including its design rationale, notes, dependencies, and status. Use when you need to recall the specifics of one workstream or task.",
		promptSnippet: "Show a single beads issue",
		parameters: Type.Object({
			id: Type.String({
				description: "The beads issue ID to retrieve.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const guard = beadsGuard(ctx.cwd);
			if (guard) return guard;

			try {
				const { stdout } = await runBd(ctx.cwd, ["show", params.id, "--json"]);
				const item = (JSON.parse(stdout) as Array<Record<string, unknown>>)[0];
				return {
					content: [{ type: "text", text: JSON.stringify(item, null, 2) }],
					details: item,
				};
			} catch (err: any) {
				throw new Error(`bd_show failed: ${err?.stderr ?? err?.message ?? err}`);
			}
		},
	});

	pi.registerTool({
		name: "bd_ready",
		label: "Ready",
		description:
			"Return the set of tasks that have no unresolved blocking dependencies — i.e. tasks whose prerequisite work is done and that are safe to start. Use to identify what to delegate next in a multi-step workstream.",
		promptSnippet: "Get the beads ready front",
		parameters: Type.Object({
			role: Type.Optional(Type.String({
				description: "Filter to tasks labelled for a specific role (e.g. 'typescript-engineer'). Omit to return all ready tasks.",
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const guard = beadsGuard(ctx.cwd);
			if (guard) return guard;

			try {
				const args = ["ready", "--type=task", "--json"];
				if (params.role) args.push(`--label=${params.role}`);
				const { stdout } = await runBd(ctx.cwd, args);
				const items = JSON.parse(stdout) as unknown[];
				return {
					content: [{ type: "text", text: items.length === 0 ? "No tasks in ready state." : JSON.stringify(items, null, 2) }],
					details: { count: items.length, items },
				};
			} catch (err: any) {
				throw new Error(`bd_ready failed: ${err?.stderr ?? err?.message ?? err}`);
			}
		},
	});

	pi.registerTool({
		name: "bd_broker_start",
		label: "Broker Start",
		description:
			"Activate the beads broker. While active, the broker monitors the beads ready queue and " +
			"automatically dispatches ready tasks to available team members by their role label. " +
			"Use when you have pre-populated a beads queue and want autonomous dispatch. " +
			"Only tasks with a role label (set via bd_task_create role parameter) are dispatched; unlabelled tasks are ignored.",
		promptSnippet: "Activate autonomous broker dispatch",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const guard = beadsGuard(ctx.cwd);
			if (guard) return guard;
			if (broker.active) {
				return {
					content: [{ type: "text", text: "Broker is already active." }],
					details: {},
				};
			}
			broker.start(ctx.cwd);
			return {
				content: [{ type: "text", text: "Broker started. Ready tasks will be dispatched automatically." }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "bd_broker_stop",
		label: "Broker Stop",
		description:
			"Deactivate the beads broker. In-flight tasks will complete normally; no new tasks will be dispatched.",
		promptSnippet: "Deactivate broker dispatch",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			broker.stop();
			return {
				content: [{ type: "text", text: "Broker stopped." }],
				details: {},
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
			// ── Async: single mode ──────────────────────────────────────────
			if ((params.async ?? asyncMode) && params.task) {
				const r = await resolveOrScale(ctx.cwd, memberState, params.member, params.role);
				if ("error" in r) {
					return { content: [{ type: "text", text: r.error }], details: {}, isError: true };
				}
				const hiredNote = r.hired ? `Auto-hired ${r.member.name} (${r.config.name}) — ` : "";
				memberState.set(r.member.name, { status: "working", task: params.task });
				updateWidget(ctx);

				runTaskWithStreaming(r.config, r.member.name, params.task, params.cwd ?? ctx.cwd, signal)
					.then(result => {
						const status = result.exitCode === 0 ? "done" : "error";
						setMemberStatus(r.member.name, { status, task: params.task });
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
						setMemberStatus(r.member.name, { status: "error", task: params.task });
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
					const r = await resolveOrScale(ctx.cwd, memberState, t.member, t.role);
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
							setMemberStatus(r.member.name, { status, task: t.task });
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
							setMemberStatus(r.member.name, { status: "error", task: t.task });
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
						const r = await resolveOrScale(ctx.cwd, memberState, step.member, step.role);
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
							setMemberStatus(r.member.name, { status: "error", task });
							updateWidget(lastCtx);
							deliverResult("Chain", "error", `Step ${i + 1} (${r.member.name}) threw: ${err?.message ?? err}`);
							return;
						}

						if (result.exitCode !== 0) {
							setMemberStatus(r.member.name, { status: "error", task });
							updateWidget(lastCtx);
							deliverResult("Chain", "error",
								`Chain stopped at step ${i + 1} (${r.member.name}):\n${result.output || result.stderr || "(no output)"}`
							);
							return;
						}

						setMemberStatus(r.member.name, { status: "done", task });
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
					const r = await resolveOrScale(ctx.cwd, memberState, step.member, step.role);
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

					setMemberStatus(r.member.name, { status: "done", task });
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
						const r = await resolveOrScale(ctx.cwd, memberState, t.member, t.role);
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
				const r = await resolveOrScale(ctx.cwd, memberState, params.member, params.role);
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
					setMemberStatus(r.member.name, { status: "error", task: params.task });
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

				setMemberStatus(r.member.name, { status: "done", task: params.task });
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
