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
import { Type } from "typebox";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TeamMember {
	id: string;
	name: string;
	role: string;
	hiredAt: string;
}

interface Roster {
	members: TeamMember[];
	usedNames: string[];
}

interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
}

interface RunResult {
	exitCode: number;
	output: string;
	stderr: string;
}

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

function getRosterPath(cwd: string): string {
	return path.join(cwd, ".pi", "roster.json");
}

function loadRoster(cwd: string): Roster {
	const p = getRosterPath(cwd);
	if (!fs.existsSync(p)) return { members: [], usedNames: [] };
	try {
		return JSON.parse(fs.readFileSync(p, "utf-8")) as Roster;
	} catch {
		return { members: [], usedNames: [] };
	}
}

async function saveRoster(cwd: string, roster: Roster): Promise<void> {
	const p = getRosterPath(cwd);
	await withFileMutationQueue(p, () =>
		fs.promises.writeFile(p, JSON.stringify(roster, null, 2), "utf-8"),
	);
}

function pickUnusedName(usedNames: string[]): string | null {
	const available = NAME_POOL.filter((n) => !usedNames.includes(n));
	if (available.length === 0) return null;
	return available[Math.floor(Math.random() * available.length)];
}

function nameToId(name: string): string {
	return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

// ─── Agent config helpers ─────────────────────────────────────────────────────

function getAgentsDir(cwd: string): string {
	return path.join(cwd, ".pi", "agents");
}

function loadAgentConfig(cwd: string, roleName: string): AgentConfig | null {
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
		};
	} catch {
		return null;
	}
}

function listAvailableRoles(cwd: string): string[] {
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

type JsonMessage = { role: string; content: { type: string; text?: string }[] };

function getFinalOutput(messages: JsonMessage[]): string {
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
): Promise<RunResult> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (config.model) args.push("--model", config.model);
	if (config.tools?.length) args.push("--tools", config.tools.join(","));

	let tmpDir: string | null = null;
	let tmpFile: string | null = null;
	const messages: JsonMessage[] = [];
	let stderr = "";

	try {
		if (config.systemPrompt.trim()) {
			const tmp = await writeTempPrompt(config.name, config.systemPrompt);
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
					}
				}
				if (ev.type === "tool_result_end" && ev.message) {
					messages.push(ev.message as JsonMessage);
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
		return { exitCode, output: getFinalOutput(messages), stderr };
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

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Show roster on startup
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup" && event.reason !== "resume") return;
		const roster = loadRoster(ctx.cwd);
		if (roster.members.length === 0) return;
		const lines = roster.members.map((m) => `  • ${m.name} (${m.role})`).join("\n");
		ctx.ui.notify(`Your team:\n${lines}`, "info");
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

			ctx.ui.notify(
				`Welcome aboard, ${name}!\nRole: ${roleName}\n${config.description}`,
				"success",
			);
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
			ctx.ui.notify(`${member.name} has left the team.`, "info");
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
		].join(" "),
		parameters: DelegateParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const roster = loadRoster(ctx.cwd);

			// Resolve a member+config from member name or role name
			function resolve(
				member?: string,
				role?: string,
			): { member: TeamMember; config: AgentConfig } | { error: string } {
				if (member) {
					const m = roster.members.find(
						(x) => x.name.toLowerCase() === member.toLowerCase(),
					);
					if (!m) {
						const names = roster.members.map((x) => x.name).join(", ") || "none";
						return { error: `Team member "${member}" not found. Current team: ${names}` };
					}
					const config = loadAgentConfig(ctx.cwd, m.role);
					if (!config)
						return {
							error: `Role definition ".pi/agents/${m.role}.md" not found for ${m.name}.`,
						};
					return { member: m, config };
				}
				if (role) {
					const m = roster.members.find((x) => x.role === role);
					if (!m)
						return {
							error: `No team member with role "${role}". Hire one with /hire ${role}.`,
						};
					const config = loadAgentConfig(ctx.cwd, m.role);
					if (!config)
						return {
							error: `Role definition ".pi/agents/${m.role}.md" not found for ${m.name}.`,
						};
					return { member: m, config };
				}
				return { error: "Specify either member name or role." };
			}

			// ── Chain mode ────────────────────────────────────────────────────
			if (params.chain?.length) {
				const sections: string[] = [];
				let previous = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const r = resolve(step.member, step.role);
					if ("error" in r) {
						return {
							content: [{ type: "text", text: `Chain step ${i + 1} failed: ${r.error}` }],
							details: {},
							isError: true,
						};
					}

					const task = step.task.replace(/\{previous\}/g, previous);
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `[chain ${i + 1}/${params.chain.length}] ${r.member.name} working...`,
							},
						],
						details: {},
					});

					const result = await runTask(
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
						const r = resolve(t.member, t.role);
						if ("error" in r) {
							return {
								name: t.member ?? t.role ?? `task ${i + 1}`,
								output: r.error,
								exitCode: 1,
							};
						}
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `[parallel ${i + 1}/${params.tasks!.length}] ${r.member.name} starting…`,
								},
							],
							details: {},
						});
						const result = await runTask(
							r.config,
							r.member.name,
							t.task,
							t.cwd ?? ctx.cwd,
							signal,
						);
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
				const r = resolve(params.member, params.role);
				if ("error" in r) {
					return { content: [{ type: "text", text: r.error }], details: {}, isError: true };
				}

				onUpdate?.({
					content: [{ type: "text", text: `${r.member.name} starting task…` }],
					details: {},
				});

				const result = await runTask(
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
