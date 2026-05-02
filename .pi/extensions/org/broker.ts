/**
 * Broker — Integration B
 *
 * Watches the beads ready queue and automatically dispatches ready tasks to
 * available team members by their role label. The broker is the sole writer
 * to beads in embedded mode; it serialises all bd writes per-cwd through a
 * promise chain (writeQueue).
 *
 * Usage:
 *   const broker = new Broker(runBd, resolveOrScale, runTaskWithStreaming, memberState, notifyEM);
 *   broker.start(cwd);   // begin polling and event-driven dispatch
 *   broker.stop();       // stop new dispatches; in-flight tasks complete normally
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { RpcClient } from "@mariozechner/pi-coding-agent";

const exec = promisify(execCb);

// ─── Local types (mirrored from index.ts to avoid circular imports) ──────────

interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	memory?: boolean;
}

interface TeamMember {
	id: string;
	name: string;
	role: string;
	hiredAt: string;
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
}

interface RunResult {
	exitCode: number;
	output: string;
	stderr: string;
	usage?: UsageStats;
}

type MemberStatus = "idle" | "working" | "done" | "error";
interface MemberState {
	status: MemberStatus;
	task?: string;
	streaming?: string;
}

type ResolveResult =
	| { member: TeamMember; config: AgentConfig; hired: boolean }
	| { error: string };

type RunBdFn = (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
type ResolveOrScaleFn = (
	cwd: string,
	memberState: Map<string, MemberState>,
	role?: string,
) => Promise<ResolveResult>;
type RunTaskFn = (
	config: AgentConfig,
	memberName: string,
	task: string,
	cwd: string,
) => Promise<RunResult>;

interface BeadsTask {
	id: string;
	title: string;
	labels?: string[];
	[key: string]: unknown;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

async function getHeadCommit(cwd: string): Promise<string | null> {
	try {
		const { stdout } = await exec("git log -1 --format=%H", { cwd });
		return stdout.trim() || null;
	} catch {
		return null; // not a git repo, or no commits yet
	}
}

function summarise(output: string): string {
	const firstLine =
		output.split("\n").find((l) => l.trim().length > 0) ?? "Task completed.";
	return firstLine
		.replace(/[#*`_>]/g, "")
		.trim()
		.slice(0, 150);
}

function extractBlockerContext(d: any): { title: string; summary: string } {
	const title: string = d.title ?? d.id ?? "(unknown)";
	const meta = d.metadata ?? {};
	if (meta.git_commit) return { title, summary: `see commit ${meta.git_commit}` };
	if (meta.result_file) return { title, summary: `see file ${meta.result_file}` };
	if (d.notes) {
		return {
			title,
			summary: (d.notes as string).slice(0, 300).replace(/\n+/g, " ").trim(),
		};
	}
	return { title, summary: "(no result recorded)" };
}

const UPSTREAM_CAP = 2000;

const TEXT_CAP = 40 * 1024; // 40 KB — leaves ~24 KB headroom in the 64 KB notes ceiling

// ─── Broker ───────────────────────────────────────────────────────────────────

export class Broker {
	/** Whether the broker is currently accepting dispatches and polling. */
	active = false;

	/** cwd provided to start(); used by the 30s safety-net poll. */
	private activeCwd: string | null = null;

	/** Handle for the 30s safety-net polling timer. */
	pollingInterval?: ReturnType<typeof setTimeout>;

	/** Per-cwd promise chain — serialises all bd writes. */
	writeQueue = new Map<string, Promise<void>>();

	/** Task IDs currently claimed (in_progress or being dispatched). */
	liveKeys = new Set<string>();

	/** In-memory failure counter per task ID. Reset on broker restart. */
	private failureCounts = new Map<string, number>();

	/** Maps role slug → dispatch verb used in task brief. */
	private static readonly ROLE_VERBS: Record<string, string> = {
		"typescript-engineer": "implement",
		"software-architect": "design",
		"qa-engineer": "test",
		"documentation-steward": "document",
		"technical-writer": "write",
		"prompt-engineer": "implement",
		"pi-specialist": "implement",
		"beads-specialist": "implement",
		"release-engineer": "release",
	};

	// Dependencies injected via configure() rather than the constructor so
	// that broker.ts can export a module-level singleton without circular deps.
	private runBd!: RunBdFn;
	private resolveOrScale!: ResolveOrScaleFn;
	private runTask!: RunTaskFn;
	private memberState!: Map<string, MemberState>;
	private notifyEM!: (msg: string) => void;
	private deliverResult!: (taskId: string, taskTitle: string, role: string, memberName: string, output: string) => void;
	private scheduleDoneReset!: (memberName: string) => void;
	private accumulateMemberUsage!: (memberName: string, usage: UsageStats) => void;
	private getLiveClient!: (cwd: string, memberName: string) => RpcClient | undefined;

	constructor() {}

	/**
	 * Inject runtime dependencies. Must be called before start().
	 * Safe to call again on extension reload with fresh closure references.
	 */
	configure(
		runBd: RunBdFn,
		resolveOrScale: ResolveOrScaleFn,
		runTask: RunTaskFn,
		memberState: Map<string, MemberState>,
		notifyEM: (msg: string) => void,
		deliverResult: (taskId: string, taskTitle: string, role: string, memberName: string, output: string) => void,
		scheduleDoneReset: (memberName: string) => void,
		accumulateMemberUsage: (memberName: string, usage: UsageStats) => void,
		getLiveClient: (cwd: string, memberName: string) => RpcClient | undefined,
	): void {
		this.runBd = runBd;
		this.resolveOrScale = resolveOrScale;
		this.runTask = runTask;
		this.memberState = memberState;
		this.notifyEM = notifyEM;
		this.deliverResult = deliverResult;
		this.scheduleDoneReset = scheduleDoneReset;
		this.accumulateMemberUsage = accumulateMemberUsage;
		this.getLiveClient = getLiveClient;
	}

	/**
	 * Activate the broker for the given cwd. Triggers an immediate dispatch
	 * cycle and schedules the 30s safety-net poll.
	 */
	start(cwd: string): void {
		this.active = true;
		this.activeCwd = cwd;
		this.failureCounts.clear();
		this._schedulePoll();
		this.onTaskCreated(cwd); // immediate cycle on start
	}

	/**
	 * Deactivate the broker. In-flight tasks complete normally; no new
	 * dispatches will be triggered.
	 */
	stop(): void {
		this.active = false;
		if (this.pollingInterval) clearTimeout(this.pollingInterval);
	}

	/**
	 * Called synchronously from bd_task_create after a successful bd write.
	 * Triggers a dispatch cycle to pick up the newly created (or unblocked) task.
	 */
	onTaskCreated(cwd: string): void {
		if (!this.active) return;
		this._enqueueWrite(cwd, () => this._dispatchCycle(cwd));
	}

	/**
	 * Called synchronously from bd_task_update after a successful bd write.
	 * Triggers a dispatch cycle when a task is re-opened (e.g. after manual reset).
	 */
	onTaskUpdated(cwd: string, _taskId: string, status: string): void {
		if (!this.active) return;
		if (status === "open") {
			this._enqueueWrite(cwd, () => this._dispatchCycle(cwd));
		}
	}

	// ─── Internal ──────────────────────────────────────────────────────────────

	private _schedulePoll(ms = 30_000): void {
		this.pollingInterval = setTimeout(() => {
			if (!this.active || !this.activeCwd) return;
			this._enqueueWrite(this.activeCwd, () => this._dispatchCycle(this.activeCwd!));
			this._schedulePoll();
		}, ms);
	}

	/**
	 * Enqueue a bd write on the per-cwd serialisation chain.
	 * The chain stays alive even if `fn` throws.
	 */
	private _enqueueWrite(cwd: string, fn: () => Promise<void>): void {
		const prev = this.writeQueue.get(cwd) ?? Promise.resolve();
		const next = prev.then(fn);
		// Keep the chain alive even on error so future writes are not blocked
		this.writeQueue.set(cwd, next.catch(() => {}));
	}

	/**
	 * Core dispatch loop. Polls bd ready, claims each ready labelled task,
	 * and fires _runAndClose for each. Called inside the write queue so that
	 * claims are serialised.
	 */
	private async _dispatchCycle(cwd: string): Promise<void> {
		let tasks: BeadsTask[];
		try {
			const { stdout } = await this.runBd(cwd, ["ready", "--type=task", "--json"]);
			tasks = JSON.parse(stdout) as BeadsTask[];
		} catch (err: any) {
			this.notifyEM(`Broker: bd ready failed — ${err?.message ?? err}`);
			return;
		}

		for (const task of tasks) {
			// ADR-006: unlabelled task = EM-owned; broker never touches it.
			const role = task.labels?.[0];
			if (!role) continue;

			// Already claimed by a previous dispatch cycle (in_progress).
			if (this.liveKeys.has(task.id)) continue;

			// Hard-stop after 3 failures to prevent infinite retry loops.
			const failures = this.failureCounts.get(task.id) ?? 0;
			if (failures >= 3) {
				this.notifyEM(
					`Broker: task ${task.id} ("${task.title}") has failed ${failures} times and is being skipped. Manual intervention required.`,
				);
				continue;
			}

			// Find or hire a member for this role.
			const r = await this.resolveOrScale(cwd, this.memberState, role);
			if ("error" in r) continue; // no available member; try next cycle

			// Claim before dispatch so that subsequent cycles skip this task.
			this.liveKeys.add(task.id);
			try {
				await this.runBd(cwd, ["update", task.id, "--status=in_progress", "--json"]);
			} catch (err: any) {
				this.liveKeys.delete(task.id);
				this.notifyEM(
					`Broker: failed to claim task ${task.id} — ${err?.message ?? err}`,
				);
				continue;
			}

			// Update member state to working (resolveOrScale sets it too, but we
			// add the task title here for the widget).
			this.memberState.set(r.member.name, {
				status: "working",
				task: task.title,
			});

			// Fire and forget — runTask is NOT serialised through writeQueue.
			this._runAndClose(cwd, task, role, r).catch(() => {});
		}
	}

	/**
	 * Runs a task and captures the result. Runs entirely outside the write queue
	 * (agents execute in parallel). bd writes within this method are re-enqueued
	 * through _enqueueWrite.
	 */
	private async _runAndClose(
		cwd: string,
		task: BeadsTask,
		role: string,
		r: { member: TeamMember; config: AgentConfig; hired: boolean },
	): Promise<void> {
		try {
			// ── 1. Build brief with upstream context ─────────────────────────────
			let blockers: any[] = [];
			try {
				const { stdout: showOut } = await this.runBd(cwd, ["show", task.id, "--json"]);
				const fullTask = (JSON.parse(showOut) as any[])[0];
				blockers = (fullTask?.dependencies ?? []).filter(
					(d: any) => d.dependency_type === "blocks",
				);
			} catch {
				// Non-fatal — proceed without upstream context
			}

			const upstreamContext = this.buildUpstreamContext(blockers);
			const verb = Broker.ROLE_VERBS[role] ?? "complete";
			const beadsDir = path.join(cwd, ".beads");
			let brief = [
				`Your task is described in bead ${task.id}.`,
				`Retrieve the full details (title, description, design, acceptance criteria) with:`,
				`  BEADS_DIR=${beadsDir} bd show ${task.id} --json`,
				`The description field contains the full task specification.`,
				`Then ${verb} as specified.`,
			].join("\n");
			if (upstreamContext) brief += `\n\n${upstreamContext}`;

			// ── 2. Snapshot git HEAD, run task ────────────────────────────────────
			const commitBefore = await getHeadCommit(cwd);
			const result = await this.runTask(r.config, r.member.name, brief, cwd);

			// ── 2b. Memory update phase ────────────────────────────────────────
			// Capture the task output now; the memory phase must not affect what we deliver.
			if (result.exitCode === 0) {
				const liveClient = this.getLiveClient(cwd, r.member.name);
				if (liveClient) {
					try {
						await liveClient.prompt(
							"Memory update phase: review your memory file and update it if anything from the task you just completed is worth recording. Do not include any other commentary.",
						);
						await liveClient.waitForIdle(30_000);
					} catch (err: any) {
						this.notifyEM(
							`Broker: memory update phase failed for ${r.member.name} after task ${task.id} ("${task.title}") — ${err?.message ?? err}`,
						);
					}
				}
			}

			// ── 3. Update member state ────────────────────────────────────────────
			this.memberState.set(r.member.name, {
				status: result.exitCode === 0 ? "done" : "error",
				task: task.title,
			});

			// ── 4. Capture result + deliver to EM, or requeue (serialised through write queue) ─────
			if (result.exitCode === 0) {
				this._enqueueWrite(cwd, async () => {
					try {
						await this.captureResult(cwd, task.id, result.output, commitBefore);
					} catch (err: any) {
						this.notifyEM(
							`Broker: captureResult failed for task ${task.id} ("${task.title}") — ` +
								`task is stuck in_progress and output may be lost. ` +
								`Error: ${err?.message ?? err}`,
						);
						return;
					}
					// Decision 1: deliver full output to EM after beads record is committed.
					this.deliverResult(task.id, task.title, role, r.member.name, result.output);
					// Reset member status to idle after 5 minutes
					this.scheduleDoneReset(r.member.name);
					// Accumulate usage stats
					if (result.usage) {
						this.accumulateMemberUsage(r.member.name, result.usage);
					}
				});
			} else {
				const reason = `exitCode ${result.exitCode}: ${(result.stderr || result.output).slice(0, 200)}`;
				this._enqueueWrite(cwd, () => this._requeueTask(cwd, task.id, reason));
			}
		} catch (err: any) {
			this.memberState.set(r.member.name, { status: "error", task: task.title });
			const reason = err?.message ?? String(err);
			this._enqueueWrite(cwd, () => this._requeueTask(cwd, task.id, reason));
		} finally {
			this.liveKeys.delete(task.id);
		}
	}

	/**
	 * Captures the result of a completed task into beads.
	 *
	 * Branches:
	 * - File-change: a new git commit landed since commitBefore → record SHA in
	 *   metadata.git_commit via `bd update --set-metadata`, then close.
	 * - Text fits (≤40 KB AND fits in remaining notes capacity): append full output
	 *   to notes via `--append-notes`, then close.
	 * - Text too large (>40 KB OR would overflow the 50 KB notes threshold): write
	 *   to `.pi/task-results/<id>.md`, record path in metadata.result_file via
	 *   `bd update --set-metadata`, then close.
	 *
	 * Before appending, a `bd show` call fetches existing notes length to guard
	 * against the retry-overflow scenario (first-run notes + second-run output
	 * exceeding Dolt's 64 KB column ceiling). If `bd show` fails, file-offload
	 * is forced as the safe fallback.
	 *
	 * Must be called inside the write queue (serialised).
	 */
	async captureResult(
		cwd: string,
		taskId: string,
		output: string,
		commitBefore: string | null,
	): Promise<void> {
		// Snapshot git HEAD now (task has already completed by the time this runs).
		const commitAfter = await getHeadCommit(cwd);
		const isFileChange = commitAfter !== null && commitAfter !== commitBefore;

		if (isFileChange) {
			// File-change path: record commit SHA in metadata, then close.
			await this.runBd(cwd, [
				"update",
				taskId,
				"--set-metadata",
				`git_commit=${commitAfter}`,
				"--json",
			]);
		} else {
			// Determine remaining notes capacity before deciding how to store output.
			// Dolt's notes column has a ~64 KB ceiling; use 50 KB as a conservative
			// threshold so accumulated notes from prior attempts are never overflowed.
			let remaining = 0; // conservative default — forces file-offload if fetch fails
			try {
				const { stdout: showOut } = await this.runBd(cwd, ["show", taskId, "--json"]);
				const currentTask = (JSON.parse(showOut) as any[])[0];
				const currentNotesLength =
					(currentTask?.notes as string | null | undefined)?.length ?? 0;
				remaining = 50_000 - currentNotesLength;
			} catch {
				// bd show failed — assume no capacity remains; force file-offload below.
			}

			if (output.length <= TEXT_CAP && output.length <= remaining) {
				// Text-output path: fits within both the 40 KB soft cap and remaining
				// notes capacity — append directly.
				await this.runBd(cwd, [
					"update",
					taskId,
					`--append-notes=${output}`,
					"--json",
				]);
			} else {
				// File-offload path: output exceeds TEXT_CAP or would overflow existing notes.
				const outPath = path.join(cwd, ".pi", "task-results", `${taskId}.md`);
				await fs.mkdir(path.dirname(outPath), { recursive: true });
				await fs.writeFile(outPath, output, "utf8");
				await this.runBd(cwd, [
					"update",
					taskId,
					"--append-notes",
					`[Full output written to file — see metadata.result_file]`,
					"--json",
				]);
				await this.runBd(cwd, [
					"update",
					taskId,
					"--set-metadata",
					`result_file=${outPath}`,
					"--json",
				]);
			}
		}

		// Always close with a one-line human-readable summary.
		await this.runBd(cwd, [
			"close",
			taskId,
			`--reason=${summarise(output)}`,
			"--json",
		]);
	}

	/**
	 * Build an upstream-context block from the resolved blocker objects embedded
	 * in a bd show response. Synchronous — blockers are already full issue objects;
	 * no additional bd show calls needed.
	 *
	 * Filters to dependency_type === 'blocks'; null-checks dependencies array.
	 * Total output capped at UPSTREAM_CAP chars.
	 */
	private buildUpstreamContext(blockers: any[]): string {
		if (blockers.length === 0) return "";
		const contexts = blockers.map(extractBlockerContext);
		const lines = contexts.map((c) => `- ${c.title}: ${c.summary}`);
		const block = `Context from upstream tasks:\n${lines.join("\n")}`;
		return block.slice(0, UPSTREAM_CAP);
	}

	/**
	 * Re-opens or defers a failed task, increments the failure counter, and
	 * notifies the EM. On the 3rd failure the task is deferred (removed from the
	 * ready queue) to prevent infinite re-dispatch cycles; the EM must inspect
	 * the task, fix the brief, and re-open it manually.
	 * Must be called inside the write queue (serialised).
	 */
	private async _requeueTask(
		cwd: string,
		taskId: string,
		reason: string,
	): Promise<void> {
		const count = (this.failureCounts.get(taskId) ?? 0) + 1;
		this.failureCounts.set(taskId, count);

		if (count >= 3) {
			// 3rd failure — defer to stop infinite retry loops
			try {
				await this.runBd(cwd, ["update", taskId, "--status=deferred", "--json"]);
			} catch (err: any) {
				this.notifyEM(
					`Broker: failed to defer task ${taskId} after ${count} failures ` +
						`(task may be stuck in_progress): ${err?.message ?? err}`,
				);
				return;
			}
			this.notifyEM(
				`Broker: task ${taskId} has failed ${count} times and has been DEFERRED. ` +
					`Inspect it with bd_show, fix the brief, then re-open it manually when ready. ` +
					`Last failure reason: ${reason}`,
			);
		} else {
			try {
				await this.runBd(cwd, ["update", taskId, "--status=open", "--json"]);
			} catch (err: any) {
				this.notifyEM(
					`Broker: failed to re-queue task ${taskId} after failure ` +
						`(task may be stuck in_progress): ${err?.message ?? err}`,
				);
				return;
			}
			this.notifyEM(
				`Broker: task ${taskId} failed (attempt ${count}/3) and has been re-queued. Reason: ${reason}`,
			);
		}
	}
}

/** Module-level singleton — configure before calling start(). */
export const broker = new Broker();
