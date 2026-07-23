/**
 * pi-app workflow harness v3.
 *
 * The model receives a compact capability contract. The harness owns durable workflow
 * state, deterministic project gates, evaluator hand-off, background task controls,
 * structured context checkpoints, and same-session rewind transactions.
 *
 * Environment:
 *   PI_APP_HARNESS=0                       disable everything
 *   PI_APP_HARNESS_PROFILE=baseline        retain session/task commands only
 *   PI_APP_HARNESS_MAX_LOOPS=4             bounded repair continuations (0..4)
 *   PI_APP_HARNESS_EVALUATOR_TIMEOUT_MS=1800000 local high-reasoning evaluator timeout
 *   PI_APP_HARNESS_WAIT_FOR_BACKGROUND=1 keep headless print-mode alive for workers
 *   PI_APP_HARNESS_ABLATIONS=a,b           classifier,repair-loop,semantic-gates,ponytail
 *   PI_APP_HARNESS_LOG=1                   append .pi/harness.log
 */

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildIndependentEvaluatorPrompt, buildIndependentFalsifierPrompt, classifyPreviewBrowserEvidence, executionFailed, independentEvaluationAccepted, independentEvaluationRepairPrompt, parseBackgroundAgentId } from "./policy.js";
import {
	attachVerifierSteps,
	createWorkflowState,
	loadVerifierManifest,
	normalizeWorkflowState,
	readySteps,
	updateWorkflowStep,
	type WorkflowState,
	type WorkflowStep,
} from "./workflow.js";
import { fingerprintWorkspace, isWorkspacePath, rebaseWorktreePrompt } from "./workspace.js";
import { decorateTaskQueue, type TaskPriority } from "./tasks.js";
import { registerSessionAutoName } from "./auto-name.js";

type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
type BackgroundTask = {
	id: string;
	type: string;
	description: string;
	status: TaskStatus;
	result?: string;
	error?: string;
	startedAt?: number;
	completedAt?: number;
	durationMs?: number;
	tokens?: number;
	branch?: string;
	baseSha?: string;
	worktreePath?: string;
	outputFile?: string;
	prompt?: string;
	transcript?: string;
	diff?: string;
	mergedCommit?: string;
	evaluatorProtocolVersion?: number;
	evaluatorQuorum?: boolean;
	priority?: TaskPriority;
	queuePosition?: number;
	etaMs?: number;
	blockedReason?: string;
};

type LiveSubagentRecord = {
	id: string;
	type?: string;
	description?: string;
	status?: string;
	result?: string;
	error?: string;
	startedAt?: number;
	completedAt?: number;
	toolUses?: number;
	outputFile?: string;
	pendingSteers?: string[];
	session?: { steer(message: string): Promise<void> };
	worktree?: { path: string; branch: string; baseSha: string; workPath: string };
	worktreeResult?: { hasChanges: boolean; branch?: string };
	lifetimeUsage?: { input?: number; output?: number; cacheWrite?: number };
};

type SubagentRegistry = {
	getRecord(id: string): LiveSubagentRecord | undefined;
	waitForAll(): Promise<void>;
};

type RpcReply<T> = { success: true; data?: T } | { success: false; error: string };
type ContinuationWaiter = {
	started: boolean;
	finish(completed: boolean): void;
};

type PreviewRuntime = {
	status: "idle" | "starting" | "running" | "ready" | "stopped" | "failed";
	serverId?: string;
	configName?: string;
	cwd?: string;
	url?: string;
	port?: number;
	running?: boolean;
	ready?: boolean;
	httpStatus?: string;
	startedAtMs?: number;
	lastActivityMs?: number;
	leaseUntilMs?: number;
	logs?: string[];
	browserOpened?: boolean;
	browserInspected?: boolean;
	evidence?: string[];
	error?: string;
	updatedAt: number;
	source: "agent";
};

type NativePreviewReply = { success: true; data: unknown } | { success: false; error: string };

const MAX_AUTO_LOOPS = Math.min(4, Math.max(0, Number(process.env.PI_APP_HARNESS_MAX_LOOPS ?? 4) || 0));
const CHECKPOINT_PERCENT = 75;
const ABLATIONS = new Set((process.env.PI_APP_HARNESS_ABLATIONS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const WRITE_TOOLS = new Set(["edit", "write", "apply_patch", "multi_edit"]);
const PREVIEW_BRIDGE_PREFIX = "__PI_APP_NATIVE_PREVIEW_V1__:";

const WORKFLOW_GUIDANCE = `
Workflow contract:
- Treat the supplied workflow as a dependency graph. Complete only ready steps and satisfy each acceptance gate with evidence.
- For coupled work, establish a short plan and observable done state before editing. Keep the implementation incremental.
- Turn every normative behavior into a clause matrix before implementation. Probe valid and adversarial invalid boundaries; keep input type/grammar, coerced value range, discriminators, idempotency, and side effects as separate obligations. Discriminators are strict typed literals unless the authoritative contract explicitly permits coercion; never use Number/String/loose equality to broaden them. Unless a contract narrows the term, blank strings include empty and whitespace-only values.
- Preserve pre-existing public modules and capabilities. Repair drifted siblings by delegating to the canonical implementation; do not delete them unless removal is explicitly requested and all callers/contracts are migrated.
- The harness runs declared lint/typecheck/test/build gates itself after edits. Read failures, repair the cause, and never mask an exit code.
- Green tests prove only what they assert. An independent evaluator reviews successful builds; completion requires deterministic gates and clause-by-clause evaluator acceptance.
- Background workers are bounded, isolated workstreams. Preserve their transcript and reconcile their output before merge.
- For a legitimately long-running command requested by the user, delegate it as a background task and omit the bash timeout (or set it above the declared runtime). Never poll it with sleep loops; rely on task lifecycle events, transcript output, and completion notification.
- For visual/frontend work, use live_preview to start the project-configured native dev server. Once it is ready, inspect the real render with agent_browser or the chrome_* tools (DOM/snapshot, console/network, and screenshot when relevant). Do not claim visual completion from source inspection alone.
- At high context usage, leave a structured checkpoint: objective, decisions, changed files, gate evidence, risks, and next ready step.`;

const PONYTAIL_POLICY = `
Ponytail is mandatory for this run: preserve explicit user scope and acceptance criteria, prefer reuse and the smallest coherent change, inspect before editing, verify observed outcomes, and never trade away safety or correctness merely to reduce code. Ponytail skills and commands are available for deeper audit/review.`;

const LOOP_NOTE = "The same operation is repeating without new evidence. Reuse prior evidence or change strategy; do not retry an unchanged call.";
const MALFORMED_NOTE = "Tool calls were missing required arguments. Emit one valid tool call using the exact schema and all required fields.";

function outputText(value: unknown, limit = 8_000): string {
	try {
		const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
		return text.length > limit ? `${text.slice(0, limit)}\n…truncated` : text;
	} catch {
		return "";
	}
}

function changedPath(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const value = args as Record<string, unknown>;
	const path = value.path ?? value.file_path ?? value.filePath;
	return typeof path === "string" && path.trim() ? path : undefined;
}

function toolPaths(args: unknown, depth = 0): string[] {
	if (!args || typeof args !== "object" || depth > 4) return [];
	const paths: string[] = [];
	for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
		if (/^(?:path|file_?path|file)$/i.test(key) && typeof value === "string" && value.trim()) paths.push(value);
		else if (Array.isArray(value)) for (const item of value) paths.push(...toolPaths(item, depth + 1));
		else if (value && typeof value === "object") paths.push(...toolPaths(value, depth + 1));
	}
	return paths;
}

function patchPaths(args: unknown): string[] {
	if (!args || typeof args !== "object") return [];
	const value = args as Record<string, unknown>;
	const patch = [value.patch, value.input].find((item): item is string => typeof item === "string") ?? "";
	return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)].map((match) => match[1].trim());
}

function sessionEntryPreview(entry: unknown): string | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const message = (entry as Record<string, unknown>).message;
	if (!message || typeof message !== "object") return undefined;
	const content = (message as Record<string, unknown>).content;
	if (typeof content === "string") return content.replace(/\s+/g, " ").trim().slice(0, 240) || undefined;
	if (!Array.isArray(content)) return undefined;
	const text = content.map((block) => block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string"
		? (block as Record<string, string>).text
		: "").join(" ").replace(/\s+/g, " ").trim();
	return text.slice(0, 240) || undefined;
}

function evaluatorPassed(result: string): boolean {
	return independentEvaluationAccepted(result);
}

function subagentRegistry(): SubagentRegistry | undefined {
	return (globalThis as Record<symbol, SubagentRegistry | undefined>)[Symbol.for("pi-subagents:manager")];
}

function normalizedTaskStatus(status: unknown): TaskStatus {
	if (status === "queued") return "queued";
	if (status === "running" || status === "steered") return "running";
	if (status === "completed") return "completed";
	if (status === "aborted" || status === "stopped" || status === "cancelled") return "cancelled";
	return "failed";
}

function phaseText(state: WorkflowState): string {
	if (state.status === "blocked") return `blocked · ${state.blockedStepId ?? "workflow"}`;
	if (state.status === "needs-human") return `needs human · ${state.blockedStepId ?? "approval"}`;
	if (state.status === "completed") return "verified";
	const failed = state.steps.find((step) => step.status === "failed");
	if (failed) return `failed · ${failed.label}`;
	const running = state.steps.find((step) => step.status === "running");
	if (running) return `running · ${running.label}`;
	const waiting = state.steps.find((step) => step.status === "waiting");
	if (waiting) return `waiting · ${waiting.label}`;
	if (state.steps.length > 0 && state.steps.every((step) => ["passed", "skipped"].includes(step.status))) return "verified";
	return state.profile;
}

export default function harness(pi: ExtensionAPI) {
	registerSessionAutoName(pi);
	if (process.env.PI_APP_HARNESS === "0") return;
	const enabled = process.env.PI_APP_HARNESS_PROFILE !== "baseline";
	const debugLog = process.env.PI_APP_HARNESS_LOG === "1";
	let state = createWorkflowState("");
	let pendingNotes: string[] = [];
	let lastCallSignature = "";
	let repeatStreak = 0;
	let malformedStreak = 0;
	let continuationQueued = false;
	let verifierRunning = false;
	let activeCwd = process.cwd();
	let isolatedWorktree = false;
	let parentWorkspaceRoot = "";
	let activeModelPattern = "";
	let workspaceBaselineFingerprint = "";
	let lastObservedFingerprint = "";
	let continuationWaiter: ContinuationWaiter | undefined;
	let taskUi: { setWidget(key: string, value: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void; setStatus(key: string, value: string | undefined): void } | undefined;
	let backgroundHeartbeat: ReturnType<typeof setInterval> | undefined;
	let previewRuntime: PreviewRuntime = { status: "idle", updatedAt: Date.now(), source: "agent" };
	const toolArgs = new Map<string, unknown>();
	const backgroundTasks = new Map<string, BackgroundTask>();

	const log = (line: string) => {
		if (!debugLog) return;
		try {
			mkdirSync(join(activeCwd, ".pi"), { recursive: true });
			appendFileSync(join(activeCwd, ".pi", "harness.log"), `${new Date().toISOString()} ${line}\n`);
		} catch {
			// Diagnostics never affect a run.
		}
	};

	/**
	 * Extension sendMessage is intentionally fire-and-forget. Print mode would
	 * otherwise dispose the runtime as soon as the current agent_settled handler
	 * returns. Keep that handler pending until the triggered repair turn settles.
	 */
	const requestContinuation = (content: string, details: Record<string, unknown>): Promise<boolean> => {
		if (continuationWaiter) return Promise.resolve(false);
		continuationQueued = true;
		return new Promise((resolve) => {
			let settled = false;
			const timeoutMs = Math.max(30_000, Number(process.env.PI_APP_HARNESS_REPAIR_TIMEOUT_MS ?? 1_800_000) || 1_800_000);
			const timer = setTimeout(() => finish(false), timeoutMs);
			const finish = (completed: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				continuationWaiter = undefined;
				if (!completed) log(`repair continuation timed out after ${timeoutMs}ms`);
				resolve(completed);
			};
			continuationWaiter = { started: false, finish };
			pi.sendMessage({ customType: "pi-app-workflow", content, display: false, details }, { triggerTurn: true, deliverAs: "followUp" });
		});
	};

	const workspaceSnapshot = async (): Promise<{ fingerprint: string; files: string[]; head: string }> => {
		try {
			const [diff, status, head] = await Promise.all([
				pi.exec("git", ["diff", "--binary", "HEAD", "--"], { cwd: activeCwd, timeout: 30_000 }),
				pi.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: activeCwd, timeout: 30_000 }),
				pi.exec("git", ["rev-parse", "HEAD"], { cwd: activeCwd, timeout: 30_000 }),
			]);
			const revision = head.code === 0 ? head.stdout.trim() : "";
			const snapshot = fingerprintWorkspace(activeCwd, diff.stdout, status.stdout, revision);
			let committedFiles: string[] = [];
			if (state.baseRevision && revision && state.baseRevision !== revision) {
				const names = await pi.exec("git", ["diff", "--name-only", state.baseRevision, revision, "--"], { cwd: activeCwd, timeout: 30_000 });
				if (names.code === 0) committedFiles = names.stdout.split("\n").map((value) => value.trim()).filter(Boolean);
			}
			return { ...snapshot, head: revision, files: [...new Set([...snapshot.files, ...committedFiles])] };
		} catch {
			return { fingerprint: "", files: [], head: "" };
		}
	};

	const publishState = () => {
		state.updatedAt = Date.now();
		try {
			pi.appendEntry("pi-app-workflow-state", state);
		} catch {
			// In-memory state remains authoritative until the next successful checkpoint.
		}
		if (taskUi) {
			taskUi.setStatus("pi-app-workflow", `workflow: ${phaseText(state)}`);
			taskUi.setWidget("pi-app-workflow-state", [JSON.stringify(state)], { placement: "aboveEditor" });
		}
	};

	const publishTasks = () => {
		if (!taskUi) return;
		const maxConcurrent = Number(process.env.PI_APP_HARNESS_MAX_CONCURRENT ?? 2);
		const now = Date.now();
		const tasks = decorateTaskQueue([...backgroundTasks.values()].slice(-50), maxConcurrent).map((task) =>
			task.status === "queued" || task.status === "running" ? { ...task, heartbeatAt: now } : task);
		taskUi.setWidget("pi-app-background-state", tasks.length > 0 ? [JSON.stringify(tasks)] : undefined, { placement: "aboveEditor" });
	};

	const publishPreview = () => {
		if (!taskUi) return;
		taskUi.setWidget(
			"pi-app-preview-state",
			previewRuntime.status === "idle" ? undefined : [JSON.stringify(previewRuntime)],
			{ placement: "aboveEditor" },
		);
	};

	const nativePreviewRequest = async (
		ctx: { ui: { input(title: string, placeholder?: string): Promise<string | undefined> } },
		request: Record<string, unknown>,
	): Promise<unknown> => {
		const raw = await ctx.ui.input(`${PREVIEW_BRIDGE_PREFIX}${JSON.stringify(request)}`, "");
		if (!raw) throw new Error("Native preview bridge is unavailable. Run this tool from the pi-app desktop session.");
		let reply: NativePreviewReply;
		try {
			reply = JSON.parse(raw) as NativePreviewReply;
		} catch {
			throw new Error("Native preview bridge returned malformed JSON.");
		}
		if (!reply || reply.success !== true) {
			throw new Error(reply && "error" in reply ? reply.error : "Native preview request failed.");
		}
		return reply.data;
	};

	const startBackgroundHeartbeat = () => {
		if (backgroundHeartbeat) clearInterval(backgroundHeartbeat);
		backgroundHeartbeat = setInterval(() => {
			if ([...backgroundTasks.values()].some((task) => task.status === "queued" || task.status === "running")) {
				publishTasks();
			}
		}, 30_000);
		(backgroundHeartbeat as unknown as { unref?: () => void }).unref?.();
	};

	const rememberTask = (task: BackgroundTask, persist = true) => {
		backgroundTasks.set(task.id, { ...backgroundTasks.get(task.id), ...task });
		while (backgroundTasks.size > 50) {
			const oldest = backgroundTasks.keys().next().value as string | undefined;
			if (!oldest) break;
			backgroundTasks.delete(oldest);
		}
		if (persist) {
			try { pi.appendEntry("pi-app-background-record", backgroundTasks.get(task.id)); } catch { /* UI history is best effort */ }
		}
	};

	const rpc = <T,>(channel: string, payload: Record<string, unknown>, timeoutMs = 4_000): Promise<T> => new Promise((resolve, reject) => {
		const requestId = `harness-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const replyChannel = `${channel}:reply:${requestId}`;
		let settled = false;
		const unsubscribe = pi.events.on(replyChannel, (raw) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			const reply = raw as RpcReply<T>;
			if (reply?.success) resolve(reply.data as T);
			else reject(new Error(reply && "error" in reply ? reply.error : `No reply from ${channel}`));
		});
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			unsubscribe();
			reject(new Error(`${channel} timed out`));
		}, timeoutMs);
		pi.events.emit(channel, { ...payload, requestId });
	});

	const stopTask = async (id: string) => {
		const prior = backgroundTasks.get(id);
		const live = subagentRegistry()?.getRecord(id);
		if (!live && prior && (prior.status === "queued" || prior.status === "running")) {
			rememberTask({ ...prior, status: "cancelled", error: prior.error ?? "Task process is no longer live; stale state recovered.", completedAt: Date.now() });
			publishTasks();
			return;
		}
		await rpc<void>("subagents:rpc:stop", { agentId: id });
		if (prior) rememberTask({ ...prior, status: "cancelled", completedAt: Date.now() });
		publishTasks();
	};

	const spawnTask = async (type: string, prompt: string, description: string, isBackground = true, isolation?: "worktree"): Promise<string> => {
		const reply = await rpc<{ id: string }>("subagents:rpc:spawn", {
			type,
			prompt,
			priority: type === "independent-evaluator" ? "high" : "normal",
			options: { isBackground, cwd: activeCwd, description, isolation },
		}, 8_000);
		const live = subagentRegistry()?.getRecord(reply.id);
		rememberTask({
			id: reply.id,
			type,
			description,
			status: normalizedTaskStatus(live?.status ?? "queued"),
			startedAt: live?.startedAt ?? Date.now(),
			prompt,
			branch: live?.worktreeResult?.branch ?? live?.worktree?.branch,
			baseSha: live?.worktree?.baseSha,
			worktreePath: live?.worktree?.path,
			outputFile: live?.outputFile,
		});
		publishTasks();
		return reply.id;
	};

	const taskData = (data: unknown): BackgroundTask => {
		const value = (data ?? {}) as Record<string, unknown>;
		const id = String(value.id ?? "");
		const live = id ? subagentRegistry()?.getRecord(id) : undefined;
		const lifetime = live?.lifetimeUsage;
		const liveTokens = lifetime ? (lifetime.input ?? 0) + (lifetime.output ?? 0) + (lifetime.cacheWrite ?? 0) : undefined;
		const startedAt = typeof value.startedAt === "number" ? value.startedAt : live?.startedAt;
		const completedAt = typeof value.completedAt === "number" ? value.completedAt : live?.completedAt;
		return {
			id,
			type: String(value.type ?? live?.type ?? "agent"),
			description: String(value.description ?? live?.description ?? "background work"),
			status: normalizedTaskStatus(value.status ?? live?.status ?? "queued"),
			result: value.result == null ? live?.result : outputText(value.result, 20_000),
			error: value.error == null ? live?.error : outputText(value.error, 4_000),
			startedAt,
			completedAt,
			durationMs: typeof value.durationMs === "number" ? value.durationMs : startedAt ? (completedAt ?? Date.now()) - startedAt : undefined,
			tokens: typeof value.tokens === "number"
				? value.tokens
				: value.tokens && typeof value.tokens === "object" && typeof (value.tokens as Record<string, unknown>).total === "number"
					? (value.tokens as Record<string, number>).total
					: liveTokens,
			branch: typeof value.branch === "string" ? value.branch : live?.worktreeResult?.branch ?? live?.worktree?.branch,
			baseSha: typeof value.baseSha === "string" ? value.baseSha : live?.worktree?.baseSha,
			worktreePath: typeof value.worktreePath === "string" ? value.worktreePath : live?.worktree?.path,
			outputFile: typeof value.outputFile === "string" ? value.outputFile : live?.outputFile,
			prompt: typeof value.prompt === "string" ? value.prompt : undefined,
			transcript: typeof value.transcript === "string" ? value.transcript : undefined,
			diff: typeof value.diff === "string" ? value.diff : undefined,
			mergedCommit: typeof value.mergedCommit === "string" ? value.mergedCommit : undefined,
			priority: ["high", "normal", "low"].includes(String(value.priority)) ? String(value.priority) as TaskPriority : undefined,
			queuePosition: typeof value.queuePosition === "number" ? value.queuePosition : undefined,
			etaMs: typeof value.etaMs === "number" ? value.etaMs : undefined,
			blockedReason: typeof value.blockedReason === "string" ? value.blockedReason : undefined,
			evaluatorProtocolVersion: typeof value.evaluatorProtocolVersion === "number" ? value.evaluatorProtocolVersion : undefined,
			evaluatorQuorum: typeof value.evaluatorQuorum === "boolean" ? value.evaluatorQuorum : undefined,
		};
	};

	pi.events.on("subagents:created", (data) => {
		const task = taskData(data);
		if (!task.id) return;
		rememberTask({ ...task, status: "queued" });
		publishTasks();
	});
	pi.events.on("subagents:started", (data) => {
		const task = taskData(data);
		if (!task.id) return;
		rememberTask({ ...task, status: "running" });
		publishTasks();
	});
	for (const [channel, fallback] of [["subagents:completed", "completed"], ["subagents:failed", "failed"]] as const) {
		pi.events.on(channel, (data) => {
			const task = taskData(data);
			if (!task.id) return;
			const status = task.status === "failed" || task.status === "cancelled" ? task.status : fallback;
			rememberTask({ ...task, status });
			publishTasks();

			if (task.id !== state.evaluatorTaskId) return;
			state.evaluatorTaskId = undefined;
			if (status === "completed" && evaluatorPassed(task.result ?? "")) {
				state = updateWorkflowStep(state, "evaluate", "passed", "Independent evaluator accepted the implementation.");
				const review = state.steps.find((step) => step.id === "review");
				if (review) state = updateWorkflowStep(state, "review", "passed", "Workflow evidence is ready for handoff.");
				state.editsPending = false;
				publishState();
				return;
			}
			state = updateWorkflowStep(state, "evaluate", "failed", task.error || task.result || "Evaluator did not return VERDICT: PASS.");
			state.editsPending = true;
			publishState();
			if (!ABLATIONS.has("repair-loop") && state.autoLoops < MAX_AUTO_LOOPS) {
				state.autoLoops++;
				pi.sendMessage({
					customType: "pi-app-workflow",
					content: independentEvaluationRepairPrompt(task.error || task.result || "No evaluator details"),
					display: false,
					details: { reason: "evaluator-rejected", evaluatorTaskId: task.id },
				}, { triggerTurn: true, deliverAs: "followUp" });
			}
		});
	}

	const stopActiveTasks = async (): Promise<string[]> => {
		const active = [...backgroundTasks.values()].filter((task) => task.status === "queued" || task.status === "running");
		const stopped: string[] = [];
		for (const task of active) {
			try {
				await stopTask(task.id);
				stopped.push(task.id);
			} catch (error) {
				log(`failed to stop ${task.id}: ${String(error)}`);
				throw error;
			}
		}
		return stopped;
	};

	pi.registerTool({
		name: "live_preview",
		label: "Live Preview",
		description: "Control pi-app's native project preview without starting a duplicate server. List .claude/launch.json configs, start and wait for HTTP readiness, inspect status/recent logs, or stop it. For visual completion, follow a ready start with agent_browser or chrome_* DOM/console/screenshot inspection.",
		promptSnippet: "Start, observe and stop the desktop app's native live preview for visual development and QA.",
		promptGuidelines: [
			"Use action=configs before start when the launch configuration name is unknown.",
			"After action=start reports ready=true, use agent_browser or chrome_navigate plus chrome_snapshot/chrome_inspect/chrome_screenshot against the returned URL.",
			"Use status for readiness and recent dev-server logs; do not start a shell dev server in parallel.",
			"Stop the preview when it is no longer needed, unless the user is actively viewing it.",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("configs"),
				Type.Literal("start"),
				Type.Literal("status"),
				Type.Literal("stop"),
			]),
			name: Type.Optional(Type.String({ maxLength: 500, description: "Launch configuration name for start" })),
			serverId: Type.Optional(Type.String({ maxLength: 200, description: "Known native preview server id" })),
			waitMs: Type.Optional(Type.Number({ minimum: 0, maximum: 120_000, description: "How long start waits for HTTP readiness (default 60000)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = String(params.action);
			if (action === "start") {
				previewRuntime = {
					status: "starting",
					configName: params.name,
					updatedAt: Date.now(),
					source: "agent",
					evidence: [],
					browserOpened: false,
					browserInspected: false,
				};
				const previewStep = state.steps.find((step) => step.id === "preview");
				if (enabled && previewStep && previewStep.status !== "running") {
					state = updateWorkflowStep(state, "preview", "running", "Starting the native dev preview and waiting for HTTP readiness.");
					publishState();
				}
				publishPreview();
			}
			try {
				const data = await nativePreviewRequest(ctx, {
					action,
					...(params.name ? { name: params.name } : {}),
					...(params.serverId || previewRuntime.serverId ? { serverId: params.serverId ?? previewRuntime.serverId } : {}),
					...(params.waitMs != null ? { waitMs: params.waitMs } : {}),
				});
				if (action === "configs") {
					const configurations = Array.isArray(data) ? data : [];
					const guidance = configurations.length > 0
						? "Start one of these exact configuration names."
						: "No launch configuration exists. Add .claude/launch.json with version 0.0.1 and a configurations entry containing name, runtimeExecutable, runtimeArgs, and port; then call configs again. Keep the command project-scoped and review it like executable code.";
					return { content: [{ type: "text" as const, text: `${JSON.stringify({ configurations }, null, 2)}\n\n${guidance}` }], details: { action, data: configurations } };
				}
				if (action === "stop") {
					previewRuntime = {
						...previewRuntime,
						status: "stopped",
						running: false,
						ready: false,
						updatedAt: Date.now(),
						source: "agent",
					};
					publishPreview();
					return { content: [{ type: "text" as const, text: `Native preview stopped.\n${JSON.stringify(data, null, 2)}` }], details: { action, data } };
				}
				if (!data || typeof data !== "object") {
					previewRuntime = { status: "idle", updatedAt: Date.now(), source: "agent" };
					publishPreview();
					return { content: [{ type: "text" as const, text: "No native preview is active for this workspace." }], details: { action, data: null } };
				}
				const status = data as Record<string, unknown>;
				const ready = status.ready === true;
				previewRuntime = {
					...previewRuntime,
					status: ready ? "ready" : status.running === false ? "stopped" : "running",
					serverId: typeof status.serverId === "string" ? status.serverId : previewRuntime.serverId,
					configName: typeof status.configName === "string" ? status.configName : previewRuntime.configName,
					cwd: typeof status.cwd === "string" ? status.cwd : activeCwd,
					url: typeof status.url === "string" ? status.url : previewRuntime.url,
					port: typeof status.port === "number" ? status.port : previewRuntime.port,
					running: status.running !== false,
					ready,
					httpStatus: typeof status.httpStatus === "string" ? status.httpStatus : undefined,
					startedAtMs: typeof status.startedAtMs === "number" ? status.startedAtMs : previewRuntime.startedAtMs,
					lastActivityMs: typeof status.lastActivityMs === "number" ? status.lastActivityMs : previewRuntime.lastActivityMs,
					leaseUntilMs: typeof status.leaseUntilMs === "number" ? status.leaseUntilMs : previewRuntime.leaseUntilMs,
					logs: Array.isArray(status.logs) ? status.logs.filter((line): line is string => typeof line === "string").slice(-320) : previewRuntime.logs,
					updatedAt: Date.now(),
					source: "agent",
				};
				publishPreview();
				const next = ready
					? "Preview is HTTP-ready. Inspect the returned URL now with agent_browser or chrome_navigate and a snapshot/inspect/screenshot tool; source-only review does not satisfy the visual gate."
					: "Preview process is running but not HTTP-ready yet. Read recent logs, repair startup if needed, then call status.";
				return {
					content: [{ type: "text" as const, text: `${JSON.stringify(previewRuntime, null, 2)}\n\n${next}` }],
					details: { action, data: previewRuntime },
				};
			} catch (error) {
				previewRuntime = {
					...previewRuntime,
					status: "failed",
					running: false,
					ready: false,
					error: error instanceof Error ? error.message : String(error),
					updatedAt: Date.now(),
					source: "agent",
				};
				if (enabled && state.steps.some((step) => step.id === "preview")) {
					state = updateWorkflowStep(state, "preview", "failed", previewRuntime.error);
					publishState();
				}
				publishPreview();
				throw error;
			}
		},
	});

	pi.registerCommand("pi-rewind", {
		description: "Rewind inside the current session; cancel background work atomically",
		handler: async (args, ctx) => {
			const [entryId, preStoppedCsv = ""] = args.trim().split(/\s+/, 2);
			if (!entryId) return ctx.ui.notify("pi-rewind: missing entryId", "warning");
			const target = ctx.sessionManager.getEntry(entryId)?.parentId ?? null;
			if (!target) return ctx.ui.notify("pi-rewind: cannot navigate before the first entry", "warning");
			const branch = ctx.sessionManager.getBranch();
			const abandonedLeaf = branch.at(-1)?.id ?? null;
			const targetIndex = branch.findIndex((entry) => entry.id === entryId);
			const abandonedEntries = targetIndex >= 0 ? branch.slice(targetIndex) : [];
			const abandonedUserMessages = abandonedEntries
				.filter((entry) => entry.type === "message" && (entry as { message?: { role?: string } }).message?.role === "user")
				.map(sessionEntryPreview)
				.filter((text): text is string => Boolean(text))
				.slice(0, 8);
			let stopped: string[];
			try {
				stopped = [...new Set([...preStoppedCsv.split(",").filter(Boolean), ...await stopActiveTasks()])];
			} catch (error) {
				ctx.ui.notify(`Rewind aborted: a background task could not be cancelled (${String(error)})`, "error");
				return;
			}
			const result = await ctx.navigateTree(target, { summarize: false, label: "rewind" });
			if (result.cancelled) return ctx.ui.notify("pi-rewind: cancelled", "info");
			const record = {
				version: 1,
				at: Date.now(),
				type: "rewind" as const,
				targetEntryId: entryId,
				targetPreview: sessionEntryPreview(ctx.sessionManager.getEntry(entryId)),
				newLeafId: target,
				abandonedLeafId: abandonedLeaf,
				abandonedEntryCount: abandonedEntries.length,
				abandonedUserMessages,
				stoppedTaskIds: stopped,
			};
			pi.appendEntry("pi-app-rewind-record", record);
			state = createWorkflowState("");
			pendingNotes = [];
			toolArgs.clear();
			publishState();
		},
	});

	pi.registerCommand("pi-branch-return", {
		description: "Return to a saved leaf in the current session",
		handler: async (args, ctx) => {
			const leaf = args.trim();
			if (!leaf || !ctx.sessionManager.getEntry(leaf)) return ctx.ui.notify("Branch leaf is unavailable", "warning");
			await stopActiveTasks();
			const result = await ctx.navigateTree(leaf, { summarize: false, label: "branch return" });
			if (!result.cancelled) pi.appendEntry("pi-app-branch-record", { version: 1, at: Date.now(), type: "return", leafId: leaf });
		},
	});

	pi.registerCommand("pi-workflow", {
		description: "Workflow control: approve-plan | retry-gates",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "approve-plan") {
				state.approved = true;
				if (state.steps.some((step) => step.id === "plan" && step.status !== "passed")) state = updateWorkflowStep(state, "plan", "passed", "Plan approved in pi-app.");
				if (state.steps.some((step) => step.id === "approve")) state = updateWorkflowStep(state, "approve", "passed", "Human approval recorded in session.");
				publishState();
				ctx.ui.notify("Workflow plan approved", "info");
				return;
			}
			if (action === "retry-gates") {
				// A project may add its verifier manifest during the implementation
				// turn. Replace the generic no-verifier placeholder before retrying.
				state = attachVerifierSteps(state, loadVerifierManifest(activeCwd));
				for (const step of state.steps.filter((item) => item.kind === "gate" && item.status === "failed")) state = updateWorkflowStep(state, step.id, "pending", "Gate queued for retry.");
				if (state.steps.some((step) => step.id === "evaluate" && ["failed", "running"].includes(step.status))) {
					state = updateWorkflowStep(state, "evaluate", "pending", "Interrupted or rejected evaluator queued for retry.");
				}
				state.evaluatorTaskId = undefined;
				state.editsPending = true;
				// Protocol/parser upgrades must not spend another model turn when the
				// same session already contains a complete, machine-checkable review.
				// Re-evaluate only retained independent-evaluator output; semantic FAILs
				// and incomplete prose remain rejected by evaluatorPassed().
				const replay = [...backgroundTasks.values()]
					.filter((task) => task.type === "independent-evaluator"
						&& task.status === "completed"
						&& task.evaluatorProtocolVersion === 2
						&& task.evaluatorQuorum === true
						&& Boolean(task.result))
					.sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0))
					.find((task) => evaluatorPassed(task.result ?? ""));
				if (replay && !state.steps.some((step) => step.kind === "gate" && !["passed", "skipped"].includes(step.status))) {
					state = updateWorkflowStep(state, "evaluate", "passed", `Replayed accepted evaluator evidence from ${replay.id} under the current protocol.`);
					if (state.steps.some((step) => step.id === "review")) state = updateWorkflowStep(state, "review", "passed", "Workflow evidence is ready for handoff.");
					state.editsPending = false;
					pi.appendEntry("pi-app-evaluator-replay-record", { version: 1, at: Date.now(), evaluatorTaskId: replay.id, runId: state.runId });
					publishState();
					ctx.ui.notify("Stored evaluator evidence accepted; workflow recovered in this session", "info");
					return;
				}
				publishState();
				await runDeterministicGates();
				return;
			}
			ctx.ui.notify("Usage: /pi-workflow approve-plan | retry-gates", "warning");
		},
	});

	const liveTaskRecord = (task: BackgroundTask): LiveSubagentRecord | undefined => subagentRegistry()?.getRecord(task.id);

	const refreshTaskEvidence = (task: BackgroundTask): BackgroundTask => {
		const live = liveTaskRecord(task);
		if (!live) return task;
		const lifetime = live.lifetimeUsage;
		return {
			...task,
			status: normalizedTaskStatus(live.status),
			result: live.result ?? task.result,
			error: live.error ?? task.error,
			startedAt: live.startedAt ?? task.startedAt,
			completedAt: live.completedAt ?? task.completedAt,
			tokens: lifetime ? (lifetime.input ?? 0) + (lifetime.output ?? 0) + (lifetime.cacheWrite ?? 0) : task.tokens,
			branch: live.worktreeResult?.branch ?? live.worktree?.branch ?? task.branch,
			baseSha: live.worktree?.baseSha ?? task.baseSha,
			worktreePath: live.worktree?.path ?? task.worktreePath,
			outputFile: live.outputFile ?? task.outputFile,
		};
	};

	const collectTranscript = (task: BackgroundTask): string => {
		const current = refreshTaskEvidence(task);
		let transcript = "";
		if (current.outputFile) {
			try { transcript = readFileSync(current.outputFile, "utf8"); } catch { /* completed result remains available */ }
		}
		if (!transcript.trim()) transcript = current.result || current.error || `Task ${current.status}; no retained transcript is available.`;
		return transcript.length > 30_000 ? `…earlier transcript omitted\n${transcript.slice(-30_000)}` : transcript;
	};

	const collectTaskDiff = async (task: BackgroundTask): Promise<string> => {
		const current = refreshTaskEvidence(task);
		if (!current.branch) throw new Error("This task has no isolated worktree branch; a task-specific diff cannot be proven.");
		let base = current.baseSha;
		if (!base) {
			const mergeBase = await pi.exec("git", ["merge-base", "HEAD", current.branch], { cwd: activeCwd, timeout: 30_000 });
			if (mergeBase.code !== 0) throw new Error(`Cannot resolve merge base for ${current.branch}: ${mergeBase.stderr}`);
			base = mergeBase.stdout.trim();
		}
		const [stat, diff] = await Promise.all([
			pi.exec("git", ["diff", "--stat", `${base}...${current.branch}`, "--"], { cwd: activeCwd, timeout: 30_000 }),
			pi.exec("git", ["diff", "--no-ext-diff", `${base}...${current.branch}`, "--"], { cwd: activeCwd, timeout: 30_000 }),
		]);
		if (stat.code !== 0 || diff.code !== 0) throw new Error((stat.stderr || diff.stderr || "Task diff failed").trim());
		const evidence = `${current.branch} from ${base}\n\n${stat.stdout.trim() || "No changed files."}\n\n${diff.stdout.trim() || "No diff."}`;
		return evidence.length > 40_000 ? `${evidence.slice(0, 40_000)}\n…diff truncated` : evidence;
	};

	const runVerifierManifestAt = async (cwd: string): Promise<string> => {
		const manifest = loadVerifierManifest(cwd);
		const required = manifest.commands.filter((command) => command.required !== false);
		if (required.length === 0) throw new Error("Merge refused: the candidate has no required verifier manifest or conventional project scripts.");
		const evidence: string[] = [];
		for (const command of required) {
			const result = await pi.exec("/bin/zsh", ["-lc", command.command], { cwd, timeout: command.timeoutMs ?? 300_000 });
			const detail = `$ ${command.command}\nexit ${result.code}${result.killed ? " (killed)" : ""}\n${result.stdout}\n${result.stderr}`.trim().slice(-12_000);
			evidence.push(detail);
			if (result.code !== 0 || result.killed) throw new Error(`Merge verifier failed (${command.label}).\n${detail}`);
		}
		return evidence.join("\n\n");
	};

	const mergeTaskBranch = async (task: BackgroundTask): Promise<string> => {
		const current = refreshTaskEvidence(task);
		if (current.status !== "completed") throw new Error(`Merge refused: task status is ${current.status}.`);
		if (!current.branch) throw new Error("Merge refused: the task did not produce an isolated branch.");
		const parentStatus = await pi.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: activeCwd, timeout: 30_000 });
		if (parentStatus.code !== 0) throw new Error(parentStatus.stderr || "Cannot inspect parent worktree.");
		if (parentStatus.stdout.length > 0) throw new Error("Merge refused: the parent worktree is dirty. Commit or stash its changes first.");
		const branchRef = `refs/heads/${current.branch}`;
		const branchProbe = await pi.exec("git", ["show-ref", "--verify", branchRef], { cwd: activeCwd, timeout: 30_000 });
		if (branchProbe.code !== 0) throw new Error(`Merge refused: branch ${current.branch} is unavailable.`);

		const scratchRoot = mkdtempSync(join(tmpdir(), "pi-app-merge-"));
		const integrationWorktree = join(scratchRoot, "candidate");
		let attached = false;
		try {
			const add = await pi.exec("git", ["worktree", "add", "--detach", integrationWorktree, "HEAD"], { cwd: activeCwd, timeout: 60_000 });
			if (add.code !== 0) throw new Error(`Cannot create merge sandbox: ${add.stderr}`);
			attached = true;
			const merge = await pi.exec("git", ["merge", "--no-ff", "--no-commit", current.branch], { cwd: integrationWorktree, timeout: 60_000 });
			if (merge.code !== 0) throw new Error(`Candidate conflicts with the parent branch.\n${merge.stdout}\n${merge.stderr}`);
			const headBefore = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: integrationWorktree, timeout: 30_000 });
			const staged = await pi.exec("git", ["diff", "--cached", "--quiet", "--exit-code"], { cwd: integrationWorktree, timeout: 30_000 });
			if (staged.code === 0) return `Branch ${current.branch} is already integrated at ${headBefore.stdout.trim()}.`;
			if (staged.code !== 1) throw new Error(`Cannot inspect staged merge result: ${staged.stderr}`);
			const verifierEvidence = await runVerifierManifestAt(integrationWorktree);
			const commit = await pi.exec("git", ["-c", "user.name=pi-app", "-c", "user.email=pi-app@local", "commit", "-m", `Merge background task ${task.id}: ${task.description}`], { cwd: integrationWorktree, timeout: 60_000 });
			if (commit.code !== 0) throw new Error(`Cannot commit verified candidate: ${commit.stderr}`);
			const merged = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: integrationWorktree, timeout: 30_000 });
			const mergedCommit = merged.stdout.trim();
			const parentStatusAgain = await pi.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: activeCwd, timeout: 30_000 });
			if (parentStatusAgain.code !== 0 || parentStatusAgain.stdout.length > 0) throw new Error("Parent worktree changed during verification; merge was not applied.");
			const fastForward = await pi.exec("git", ["merge", "--ff-only", mergedCommit], { cwd: activeCwd, timeout: 60_000 });
			if (fastForward.code !== 0) throw new Error(`Verified merge could not fast-forward the parent: ${fastForward.stderr}`);
			rememberTask({ ...current, mergedCommit, result: `${current.result ? `${current.result}\n\n` : ""}Merged as ${mergedCommit}.\n\n${verifierEvidence}` });
			publishTasks();
			return `Merged ${current.branch} as ${mergedCommit}; every required verifier passed in an isolated integration worktree.`;
		} finally {
			if (attached) await pi.exec("git", ["worktree", "remove", "--force", integrationWorktree], { cwd: activeCwd, timeout: 60_000 }).catch(() => undefined);
			rmSync(scratchRoot, { recursive: true, force: true });
		}
	};

	pi.registerCommand("pi-task", {
		description: "Background task: cancel|steer|transcript|diff|retry|merge <id> [message]",
		handler: async (args, ctx) => {
			const [action, id, ...rest] = args.trim().split(/\s+/);
			const task = backgroundTasks.get(id);
			if (!action || !id || !task) return ctx.ui.notify("Task not found", "warning");
			if (action === "cancel") {
				try { await stopTask(id); } catch (error) { ctx.ui.notify(String(error), "error"); }
				return;
			}
			if (action === "retry") {
				try {
					const prompt = task.prompt || `Retry this bounded workstream and satisfy its original description with evidence: ${task.description}`;
					const nextId = await spawnTask(task.type, prompt, `Retry: ${task.description}`, true, task.branch || task.worktreePath ? "worktree" : undefined);
					ctx.ui.notify(`Task retried as ${nextId}`, "info");
				} catch (error) { ctx.ui.notify(String(error), "error"); }
				return;
			}
			const message = rest.join(" ").trim();
			try {
				if (action === "steer") {
					const live = liveTaskRecord(task);
					if (!live || !["queued", "running", "steered"].includes(live.status ?? "")) throw new Error("Task is no longer live and cannot be steered.");
					const guidance = message || "Report current evidence, then continue toward the original acceptance criteria.";
					if (live.session) await live.session.steer(guidance);
					else (live.pendingSteers ??= []).push(guidance);
					ctx.ui.notify(`Guidance delivered directly to ${id}`, "info");
					return;
				}
				if (action === "transcript") {
					const current = refreshTaskEvidence(task);
					rememberTask({ ...current, transcript: collectTranscript(current) });
					publishTasks();
					return;
				}
				if (action === "diff") {
					const current = refreshTaskEvidence(task);
					rememberTask({ ...current, diff: await collectTaskDiff(current) });
					publishTasks();
					return;
				}
				if (action === "merge") {
					if (message !== "confirmed") throw new Error("Merge requires an explicit UI confirmation.");
					ctx.ui.notify(await mergeTaskBranch(task), "info");
					return;
				}
				ctx.ui.notify("Unknown task action", "warning");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		activeCwd = ctx.cwd;
		isolatedWorktree = false;
		parentWorkspaceRoot = "";
		try {
			isolatedWorktree = /^gitdir:\s*/i.test(readFileSync(join(activeCwd, ".git"), "utf8"));
			if (isolatedWorktree) {
				const common = await pi.exec("git", ["rev-parse", "--git-common-dir"], { cwd: activeCwd, timeout: 30_000 });
				if (common.code === 0) parentWorkspaceRoot = dirname(resolve(activeCwd, common.stdout.trim()));
			}
		} catch {
			// A normal checkout has a .git directory; only linked worktrees need this boundary.
		}
		taskUi = ctx.ui;
		startBackgroundHeartbeat();
		const branch = ctx.sessionManager.getBranch();
		const saved = [...branch].reverse().find((entry) => entry.type === "custom" && entry.customType === "pi-app-workflow-state") as { data?: WorkflowState } | undefined;
		if (saved?.data?.version === 3) state = normalizeWorkflowState(saved.data);
		for (const entry of branch) {
			if (entry.type !== "custom" || !["subagents:record", "pi-app-background-record", "pi-app-evaluator-record"].includes(entry.customType)) continue;
			const task = taskData(entry.data);
			if (task.id) rememberTask(task, false);
		}
		for (const task of backgroundTasks.values()) {
			if (task.status !== "queued" && task.status !== "running") continue;
			const live = liveTaskRecord(task);
			if (live) rememberTask(refreshTaskEvidence(task), false);
			else {
				rememberTask({ ...task, status: "cancelled", completedAt: Date.now(), error: task.error ?? "Interrupted before this session resumed; no live process was found." }, false);
				if (task.id === state.evaluatorTaskId) {
					state.evaluatorTaskId = undefined;
					if (state.steps.some((step) => step.id === "evaluate" && step.status === "running")) {
						state = updateWorkflowStep(state, "evaluate", "failed", "Evaluator process was interrupted; retry resumes from deterministic gates without creating a new session.");
					}
				}
			}
		}
		const restoredSnapshot = await workspaceSnapshot();
		if (!state.baseRevision) state.baseRevision = restoredSnapshot.head || undefined;
		// A resumed workflow can contain an unverified diff whose original baseline is
		// no longer in memory. Preserve that persisted pending state and run its gates.
		workspaceBaselineFingerprint = state.editsPending && state.changedFiles.length > 0 ? "" : restoredSnapshot.fingerprint;
		lastObservedFingerprint = restoredSnapshot.fingerprint;
		if (enabled) publishState();
		publishTasks();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled) return;
		activeModelPattern = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
		const prompt = event.prompt.trim();
		if (!prompt || prompt.startsWith("/")) return;
		const resumes = state.editsPending && /^(?:continue|resume|go on|продолж(?:ай|и)?|дальше)\b/i.test(prompt);
		if (!resumes) {
			const classifierAblated = ABLATIONS.has("classifier");
			const routingPrompt = classifierAblated ? "Implement the requested repository change with verification." : prompt;
			state = createWorkflowState(routingPrompt);
			if (classifierAblated) state.objective = prompt.slice(0, 2_000);
			if (state.intent.allowsMutation) {
				const manifest = loadVerifierManifest(ctx.cwd);
				state = createWorkflowState(routingPrompt, Date.now(), manifest.profile);
				if (classifierAblated) state.objective = prompt.slice(0, 2_000);
				state = attachVerifierSteps(state, manifest);
			}
			const baseline = await workspaceSnapshot();
			state.baseRevision = baseline.head || undefined;
			workspaceBaselineFingerprint = baseline.fingerprint;
			lastObservedFingerprint = workspaceBaselineFingerprint;
		}
		pendingNotes = [];
		lastCallSignature = "";
		repeatStreak = 0;
		malformedStreak = 0;
		continuationQueued = false;
		toolArgs.clear();
		publishState();
		let addition = WORKFLOW_GUIDANCE;
		let systemPrompt = event.systemPrompt;
		if (isolatedWorktree && parentWorkspaceRoot) {
			// Append-mode subagents inherit a generated parent environment block. Rebase
			// exact parent-root references without corrupting the child path nested below
			// it, then make the worktree boundary explicit at the end of the prompt.
			systemPrompt = rebaseWorktreePrompt(systemPrompt, parentWorkspaceRoot, activeCwd);
			addition += `\nIsolated child boundary: ${activeCwd} is the authoritative project root. Every project read, write, patch, and shell operation must stay inside it. Never access or modify the parent checkout directly.`;
		}
		if (!ABLATIONS.has("ponytail")) addition += PONYTAIL_POLICY;
		addition += `\nActive profile: ${state.profile}. Risk: ${state.intent.risk}. Research: ${state.intent.needsResearch}. Mutation: ${state.intent.allowsMutation}. Deletion authorized: ${state.intent.allowsDeletion}. Human approval: ${state.intent.requiresHumanApproval}.`;
		return { systemPrompt: systemPrompt + `\n\n${addition}` };
	});

	pi.on("agent_start", async () => {
		continuationQueued = false;
		if (continuationWaiter) continuationWaiter.started = true;
	});

	pi.on("tool_call", async (event) => {
		const name = String(event.toolName ?? "").toLowerCase();
		if (isolatedWorktree) {
			const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
			const paths = [...toolPaths(input), ...(name === "apply_patch" ? patchPaths(input) : [])];
			const escapedPath = paths.find((path) => !isWorkspacePath(activeCwd, path));
			if (escapedPath) {
				const reason = `Isolated worktree boundary: ${escapedPath} is outside ${activeCwd}. Use the current child working directory; never access the parent checkout directly.`;
				log(`blocked worktree path escape tool=${name} path=${escapedPath}`);
				return { block: true, reason };
			}
			if (name === "bash") {
				const command = typeof input.command === "string" ? input.command : "";
				const withoutWorktree = command.split(activeCwd).join("$WORKTREE");
				const redirects = [...command.matchAll(/(?:^|[^>])>>?\s*['\"]?(\/[^\s'\";|&]+)/g)].map((match) => match[1]);
				const escapesParent = Boolean(parentWorkspaceRoot && withoutWorktree.includes(parentWorkspaceRoot));
				const escapesTraversal = /(?:^|[\s'\"=])\.\.\//.test(command);
				const escapedRedirect = redirects.find((path) => !isWorkspacePath(activeCwd, path));
				if (escapesParent || escapesTraversal || escapedRedirect) {
					const reason = "Isolated worktree boundary: shell commands may not address the parent checkout, traverse above the child root, or redirect output outside the child worktree.";
					log(`blocked worktree shell escape parent=${escapesParent} traversal=${escapesTraversal} redirect=${escapedRedirect ?? ""}`);
					return { block: true, reason };
				}
			}
		}
		if (!enabled) return;
		if (state.intent.requiresHumanApproval && !state.approved && (WRITE_TOOLS.has(name) || ["bash", "agent", "live_preview"].includes(name))) {
			const reason = "Workflow approval gate: approve the persisted plan in pi-app before mutation, shell execution, or delegated work.";
			state.events = [...state.events, { id: `gate-${Date.now().toString(36)}`, stepId: "approve", type: "waiting", at: Date.now(), message: reason }].slice(-160);
			publishState();
			return { block: true, reason };
		}
		let signature = name;
		try { signature += `:${JSON.stringify(event.input ?? {})}`; } catch { /* weak signal */ }
		repeatStreak = signature === lastCallSignature ? repeatStreak + 1 : 1;
		lastCallSignature = signature;
		if (repeatStreak === 2 && state.loopSignals === 0) {
			state.loopSignals++;
			pendingNotes.push(LOOP_NOTE);
			publishState();
		}
	});

	pi.on("message_end", async (event) => {
		if (!enabled) return;
		const message = event.message as { role?: string; content?: unknown };
		if (message.role !== "assistant" || !Array.isArray(message.content)) return;
		const calls = (message.content as Array<{ type?: string; name?: string; arguments?: unknown }>).filter((block) => block?.type === "toolCall");
		if (calls.length === 0) return;
		const broken = calls.some((block) => ["read", "write", "edit", "bash"].includes(String(block.name ?? "").toLowerCase()) &&
			(block.arguments == null || (typeof block.arguments === "object" && Object.keys(block.arguments as object).length === 0)));
		malformedStreak = broken ? malformedStreak + 1 : 0;
		if (malformedStreak === 2 && state.loopSignals === 0) pendingNotes.push(MALFORMED_NOTE);
	});

	pi.on("tool_execution_start", async (event) => { toolArgs.set(event.toolCallId, event.args); });

	pi.on("tool_execution_end", async (event) => {
		const name = String(event.toolName ?? "").toLowerCase();
		const args = toolArgs.get(event.toolCallId);
		toolArgs.delete(event.toolCallId);
		if (!event.isError && previewRuntime.ready && previewRuntime.url) {
			const { opened, inspected, summary } = classifyPreviewBrowserEvidence(name, args, previewRuntime.url);
			if (opened || inspected) {
				previewRuntime = {
					...previewRuntime,
					browserOpened: previewRuntime.browserOpened || opened,
					browserInspected: previewRuntime.browserInspected || inspected,
					evidence: [
						...(previewRuntime.evidence ?? []),
						summary,
					].slice(-12),
					updatedAt: Date.now(),
				};
				if (previewRuntime.browserOpened && previewRuntime.browserInspected) {
					const step = state.steps.find((item) => item.id === "preview");
					if (enabled && step && step.status !== "passed") {
						state = updateWorkflowStep(
							state,
							"preview",
							"passed",
							`HTTP ${previewRuntime.httpStatus ?? "ready"} at ${previewRuntime.url}; browser navigation and rendered UI inspection completed with ${name}.`,
						);
						publishState();
					}
				}
				publishPreview();
			}
		}
		if (name === "agent" && !event.isError && args && typeof args === "object") {
			const value = args as Record<string, unknown>;
			const result = outputText(event.result, 20_000);
			const id = parseBackgroundAgentId(result);
			if (id) {
				const live = subagentRegistry()?.getRecord(id);
				rememberTask({
					id,
					type: String(value.subagent_type ?? value.type ?? live?.type ?? "agent"),
					description: String(value.description ?? live?.description ?? "background work"),
					status: normalizedTaskStatus(live?.status ?? "running"),
					startedAt: live?.startedAt ?? Date.now(),
					prompt: typeof value.prompt === "string" ? value.prompt : undefined,
					branch: live?.worktreeResult?.branch ?? live?.worktree?.branch,
					baseSha: live?.worktree?.baseSha,
					worktreePath: live?.worktree?.path,
					outputFile: live?.outputFile,
				});
				publishTasks();
			}
		}
		if (!enabled) return;
		if (WRITE_TOOLS.has(name) && !event.isError) {
			const path = changedPath(args);
			if (path && !state.changedFiles.includes(path)) state.changedFiles.push(path);
			for (const planId of ["plan", "reproduce"]) {
				if (state.steps.some((step) => step.id === planId && step.status === "pending")) state = updateWorkflowStep(state, planId, "passed", "Planning boundary completed before first edit.");
			}
			if (state.steps.some((step) => step.id === "build" && step.status !== "running")) state = updateWorkflowStep(state, "build", "running", "Implementation changed project files.");
			state.editsPending = true;
			publishState();
			return;
		}
		if (state.steps.some((step) => step.kind === "gate" && step.status === "passed") && executionFailed(event.isError, event.result)) {
			state.editsPending = true;
			for (const step of state.steps.filter((item) => item.kind === "gate" && item.status === "passed")) state = updateWorkflowStep(state, step.id, "pending", "A later direct probe invalidated the previous green gate.");
			publishState();
		}
	});

	pi.on("context", async (event, ctx) => {
		if (!enabled) return;
		const usage = ctx.getContextUsage();
		if (!state.contextCheckpointed && usage?.percent != null && usage.percent >= CHECKPOINT_PERCENT) {
			state.contextCheckpointed = true;
			const next = readySteps(state).map((step) => step.id);
			const checkpoint = {
				version: 1,
				at: Date.now(),
				runId: state.runId,
				objective: state.objective,
				profile: state.profile,
				changedFiles: state.changedFiles,
				decisions: state.events.filter((item) => item.type === "passed" || item.type === "note").slice(-12).map((item) => item.message),
				gateEvidence: state.steps.filter((item) => item.kind === "gate").map(({ id, status, command, detail }) => ({ id, status, command, detail })),
				risks: state.steps.filter((item) => item.status === "failed" || item.status === "waiting").map((item) => `${item.label}: ${item.detail ?? item.acceptance}`),
				steps: state.steps.map(({ id, status, detail }) => ({ id, status, detail })),
				nextReadySteps: next,
				nextAction: next.length > 0 ? `Continue ${next.join(", ")}` : "Resolve waiting/failed gates or hand off the verified result.",
				context: { percent: usage.percent, tokens: usage.tokens, contextWindow: usage.contextWindow },
			};
			pi.appendEntry("pi-app-checkpoint", checkpoint);
			taskUi?.setWidget("pi-app-checkpoint-state", [JSON.stringify(checkpoint)], { placement: "aboveEditor" });
			pendingNotes.push("Context is past 75%. Finish the current atomic step and preserve this structured checkpoint before opening another workstream.");
			publishState();
		}
		if (pendingNotes.length === 0) return;
		const notes = pendingNotes.splice(0);
		const reminder = { role: "user", content: [{ type: "text", text: `<system-reminder source="pi-app-workflow">${notes.join("\n\n")}</system-reminder>` }], timestamp: Date.now() } as unknown as (typeof event.messages)[number];
		return { messages: [...event.messages, reminder] };
	});

	pi.on("session_compact", async (event) => {
		state.contextCheckpointed = false;
		pi.appendEntry("pi-app-compaction-record", {
			version: 1,
			at: Date.now(),
			reason: event.reason,
			tokensBefore: event.compactionEntry.tokensBefore,
			summary: event.compactionEntry.summary,
			firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
		});
		publishState();
	});

	const runEvaluator = async (): Promise<"passed" | "repaired" | "failed"> => {
		if (ABLATIONS.has("semantic-gates") || !state.intent.requiresEvaluator) {
			if (state.steps.some((step) => step.id === "evaluate")) state = updateWorkflowStep(state, "evaluate", "skipped", "Independent evaluator disabled for this ablation/profile.");
			if (state.steps.some((step) => step.id === "review")) state = updateWorkflowStep(state, "review", "passed", "Deterministic workflow complete.");
			state.editsPending = false;
			publishState();
			return "passed";
		}
		if (state.evaluatorTaskId) return "failed";
		if (!state.steps.some((step) => step.id === "evaluate")) return "passed";
		state = updateWorkflowStep(state, "evaluate", "running", "Independent read-only evaluator is inspecting the contract, diff and gate evidence.");
		const evidence = state.steps.filter((step) => step.kind === "gate" || step.kind === "preview").map((step) => `${step.label}: ${step.status}\n${step.detail ?? ""}`).join("\n\n");
		const evaluatorId = `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const description = `Independent evaluation: ${state.objective.slice(0, 120)}`;
		state.evaluatorTaskId = evaluatorId;
		rememberTask({ id: evaluatorId, type: "independent-evaluator", description, status: "running", startedAt: Date.now() });
		publishState();
		publishTasks();
		try {
			const diffBase = state.baseRevision || "HEAD";
			const diffResult = await pi.exec("git", ["diff", "--no-ext-diff", diffBase, "--"], { cwd: activeCwd, timeout: 30_000 });
			const deletionResult = await pi.exec("git", ["diff", "--name-status", "--diff-filter=D", diffBase, "--"], { cwd: activeCwd, timeout: 30_000 });
			const deletedFiles = deletionResult.stdout.split("\n").map((line) => line.split("\t").at(-1)?.trim()).filter((path): path is string => Boolean(path));
			const promptInput = {
				objective: state.objective,
				profile: state.profile,
				changedFiles: state.changedFiles,
				evidence,
				diff: diffResult.stdout,
			};
			const prompt = buildIndependentEvaluatorPrompt(promptInput);
			const evaluatorThinking = process.env.PI_APP_HARNESS_EVALUATOR_THINKING ?? "high";
			const args = ["-a", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--tools", "read,grep,find,ls", "--thinking", evaluatorThinking];
			if (activeModelPattern) args.push("--model", activeModelPattern);
			args.push("-p", prompt);
			let result: { stdout: string; stderr: string; code: number; killed?: boolean };
			if (deletedFiles.length > 0 && state.intent.allowsDeletion !== true) {
				const blocked = `Tracked pre-existing files were deleted without explicit deletion authorization: ${deletedFiles.join(", ")}. Restore the public surface and repair drift by delegation.\n\nCLAUSE public-surface: FAIL\nBLOCKING: unauthorized tracked-file deletion\nPROTOCOL: COMPLETE\nVERDICT: FAIL`;
				result = { stdout: blocked, stderr: "", code: 0, killed: false };
				log(`semantic preflight blocked evaluator ${evaluatorId}: deleted=${deletedFiles.join(",")}`);
			} else {
				log(`waiting for evaluator ${evaluatorId}`);
				result = await pi.exec("pi", args, { cwd: activeCwd, timeout: Math.max(30_000, Number(process.env.PI_APP_HARNESS_EVALUATOR_TIMEOUT_MS ?? 1_800_000) || 1_800_000) });
			}
			let verdict = `${result.stdout}\n${result.stderr}`.trim();
			let quorumCompleted = false;
			let passed = false;
			if (result.code === 0 && !result.killed && evaluatorPassed(verdict)) {
				const falsifierArgs = args.slice(0, -2);
				falsifierArgs.push("-p", buildIndependentFalsifierPrompt(promptInput, verdict));
				log(`waiting for evaluator falsifier ${evaluatorId}`);
				const falsifier = await pi.exec("pi", falsifierArgs, { cwd: activeCwd, timeout: Math.max(30_000, Number(process.env.PI_APP_HARNESS_EVALUATOR_TIMEOUT_MS ?? 1_800_000) || 1_800_000) });
				const falsifierVerdict = `${falsifier.stdout}\n${falsifier.stderr}`.trim();
				quorumCompleted = true;
				passed = falsifier.code === 0 && !falsifier.killed && evaluatorPassed(falsifierVerdict);
				result = falsifier;
				verdict = `PRIMARY EVALUATOR:\n${verdict}\n\nCOUNTEREXAMPLE FALSIFIER:\n${falsifierVerdict}`;
			}
			const task: BackgroundTask = {
				...backgroundTasks.get(evaluatorId)!,
				status: passed ? "completed" : "failed",
				result: verdict.slice(-20_000),
				error: result.code === 0 ? undefined : `Evaluator exit ${result.code}${result.killed ? " (killed)" : ""}`,
				completedAt: Date.now(),
				durationMs: Date.now() - (backgroundTasks.get(evaluatorId)?.startedAt ?? Date.now()),
				evaluatorProtocolVersion: 2,
				evaluatorQuorum: quorumCompleted,
			};
			rememberTask(task);
			pi.appendEntry("pi-app-evaluator-record", task);
			state.evaluatorTaskId = undefined;
			if (passed) {
				state = updateWorkflowStep(state, "evaluate", "passed", "Independent evaluator accepted the implementation.");
				if (state.steps.some((step) => step.id === "review")) state = updateWorkflowStep(state, "review", "passed", "Workflow evidence is ready for handoff.");
				state.editsPending = false;
			} else {
				state = updateWorkflowStep(state, "evaluate", "failed", verdict || task.error || "Evaluator returned no accepted verdict.");
				state.editsPending = true;
				if (!ABLATIONS.has("repair-loop") && state.autoLoops < MAX_AUTO_LOOPS) {
					state.autoLoops++;
					publishTasks();
					publishState();
					log(`evaluator ${evaluatorId} completed pass=${passed}; starting repair ${state.autoLoops}/${MAX_AUTO_LOOPS}`);
					const repaired = await requestContinuation(
						independentEvaluationRepairPrompt(verdict),
						{ reason: "evaluator-rejected", evaluatorTaskId: evaluatorId },
					);
					return repaired ? "repaired" : "failed";
				}
			}
			publishTasks();
			publishState();
			log(`evaluator ${evaluatorId} completed pass=${passed}`);
			return passed ? "passed" : "failed";
		} catch (error) {
			const prior = backgroundTasks.get(evaluatorId);
			if (prior) rememberTask({
				...prior,
				status: "failed",
				error: String(error),
				completedAt: Date.now(),
				durationMs: Date.now() - (prior.startedAt ?? Date.now()),
			});
			state.evaluatorTaskId = undefined;
			publishTasks();
			if (state.steps.some((step) => step.id === "evaluate" && step.status === "running")) {
				state = updateWorkflowStep(state, "evaluate", "failed", `Evaluator could not complete: ${String(error)}`);
				publishState();
			}
			return "failed";
		}
	};

	const runDeterministicGates = async () => {
		if (verifierRunning) return;
		verifierRunning = true;
		try {
			while (true) {
				const satisfied = new Set(state.steps.filter((step) => ["passed", "skipped"].includes(step.status)).map((step) => step.id));
				const queuedGates = state.steps.filter((step) => step.kind === "gate" && step.command && ["pending", "failed"].includes(step.status));
				const gates = queuedGates.filter((step) => step.deps.every((dep) => satisfied.has(dep)));
				if (gates.length === 0 && queuedGates.length > 0) {
					log(`deterministic gates waiting for dependencies: ${queuedGates.map((step) => `${step.id}<-${step.deps.join(",")}`).join(";")}`);
					return;
				}
				if (gates.length === 0) {
					const waiting = state.steps.find((step) => step.kind === "gate" && step.status === "waiting");
					if (waiting) {
						state = updateWorkflowStep(state, waiting.id, "failed", "No executable project verifier manifest was found. Add .pi/verifiers.json or conventional package scripts.");
						publishState();
						return;
					}
				}
				let repairedGate = false;
				for (const candidate of gates) {
				const current = state.steps.find((step) => step.id === candidate.id);
				if (!current || !current.command) continue;
				state = updateWorkflowStep(state, current.id, "running", `$ ${current.command}`);
				publishState();
				const result = await pi.exec("/bin/zsh", ["-lc", current.command], { cwd: activeCwd, timeout: current.timeoutMs ?? 300_000 });
				const details = `$ ${current.command}\nexit ${result.code}${result.killed ? " (killed)" : ""}\n${result.stdout}\n${result.stderr}`.trim().slice(-12_000);
				if (result.code === 0 && !result.killed) {
					state = updateWorkflowStep(state, current.id, "passed", details);
					publishState();
					continue;
				}
				state = updateWorkflowStep(state, current.id, "failed", details);
				state.editsPending = true;
				publishState();
				if (!ABLATIONS.has("repair-loop") && !continuationQueued && state.autoLoops < MAX_AUTO_LOOPS) {
					state.autoLoops++;
					publishState();
					const repaired = await requestContinuation(
						`Continue the existing objective. Declared project gate failed (${state.autoLoops}/${MAX_AUTO_LOOPS}). Repair the cause in scope, then let the harness rerun every required gate. Do not mask the exit code.\n\n${details.slice(-6_000)}`,
						{ reason: "verifier-failed", gate: current.id },
					);
					repairedGate = repaired;
				}
				break;
			}
				if (repairedGate) continue;
				if (state.steps.some((step) => step.kind === "gate" && step.status === "failed")) return;
				const evaluatorOutcome = await runEvaluator();
				if (evaluatorOutcome === "repaired") continue;
				return;
			}
		} finally {
			verifierRunning = false;
		}
	};

	pi.on("agent_settled", async (_event, ctx) => {
		if (!enabled || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		if (!state.intent.allowsMutation) {
			for (const step of state.steps) if (step.status === "pending") state = updateWorkflowStep(state, step.id, "passed", "Read-only workflow completed by the agent.");
			publishState();
			return;
		}
		const activeDelegatedWork = [...backgroundTasks.values()].filter((task) =>
			task.type !== "independent-evaluator"
			&& (task.startedAt ?? state.createdAt) >= state.createdAt
			&& (task.status === "queued" || task.status === "running"));
		if (activeDelegatedWork.length > 0) {
			if (state.steps.some((step) => step.id === "build" && step.status !== "waiting")) {
				state = updateWorkflowStep(
					state,
					"build",
					"waiting",
					`Waiting for ${activeDelegatedWork.length} delegated background task(s) before observing the parent workspace and running gates.`,
				);
			}
			state.editsPending = true;
			publishState();
			// Interactive/RPC app processes remain alive naturally. Headless print-mode
			// would dispose the extension as soon as this handler returns and abort
			// every genuine background worker. The benchmark opts into this settlement
			// barrier so it can observe real overlapping work without inventing a
			// foreground Agent call or a polling model turn.
			if (process.env.PI_APP_HARNESS_WAIT_FOR_BACKGROUND === "1") {
				log(`waiting for ${activeDelegatedWork.length} background task(s) before headless settlement`);
				await subagentRegistry()?.waitForAll();
				log("background settlement barrier released");
				await requestContinuation(
					"All delegated background tasks have settled. Continue the existing objective now: inspect their retained branch/diff evidence, integrate only accepted isolated worktree branches into the parent, then run every declared gate. Do not reimplement their work in the parent.",
					{ reason: "background-completed", taskIds: activeDelegatedWork.map((task) => task.id) },
				);
			}
			return;
		}
		const currentWorkspace = await workspaceSnapshot();
		const changedThisTurn = Boolean(currentWorkspace.fingerprint && currentWorkspace.fingerprint !== lastObservedFingerprint);
		const hasObjectiveDiff = Boolean(currentWorkspace.fingerprint && currentWorkspace.fingerprint !== workspaceBaselineFingerprint);
		lastObservedFingerprint = currentWorkspace.fingerprint || lastObservedFingerprint;
		if (changedThisTurn) {
			for (const step of state.steps.filter((item) => item.kind === "gate" && item.status === "passed")) {
				state = updateWorkflowStep(state, step.id, "pending", "Repository changed after this gate passed; verification must run again.");
			}
		}
		if (hasObjectiveDiff) {
			state.changedFiles = [...new Set([...state.changedFiles, ...currentWorkspace.files])].slice(-200);
			for (const planId of ["plan", "reproduce"]) {
				if (state.steps.some((step) => step.id === planId && step.status === "pending")) state = updateWorkflowStep(state, planId, "passed", "Planning boundary completed before observed repository change.");
			}
			if (state.steps.some((step) => step.id === "build" && step.status !== "running")) state = updateWorkflowStep(state, "build", "running", "Repository diff changed during the implementation turn.");
			state.editsPending = true;
		} else {
			state.editsPending = false;
		}
		if (!state.editsPending) {
			if (state.steps.some((step) => step.id === "build")) state = updateWorkflowStep(state, "build", "failed", "The implementation turn settled without an observed repository change.");
			if (!ABLATIONS.has("repair-loop") && !continuationQueued && state.autoLoops < MAX_AUTO_LOOPS) {
				state.autoLoops++;
				state.editsPending = true;
				publishState();
				await requestContinuation(
					`Continue the existing objective. No repository change was observed (${state.autoLoops}/${MAX_AUTO_LOOPS}). Inspect the current state, make the smallest supported implementation change, then let the harness run declared gates.`,
					{ reason: "no-observed-mutation" },
				);
			}
			publishState();
			return;
		}
		if (!state.approved) return;
		if (state.steps.some((step) => step.id === "build" && step.status === "running")) state = updateWorkflowStep(state, "build", "passed", "Implementation turn settled; deterministic gates are next.");
		const previewStep = state.steps.find((step) => step.id === "preview");
		if (previewStep && previewStep.status !== "passed" && previewStep.status !== "skipped") {
			if (!continuationQueued && state.autoLoops < MAX_AUTO_LOOPS) {
				state.autoLoops++;
				publishState();
				await requestContinuation(
					`Continue the existing objective. Visual work requires native live-preview evidence (${state.autoLoops}/${MAX_AUTO_LOOPS}). Use live_preview to list/start the project configuration and wait for HTTP readiness. Then navigate to its URL with agent_browser or chrome_navigate and inspect the actual rendered page with snapshot/inspect/console/screenshot tools. Repair any observed issue. Do not start a duplicate dev server in bash and do not claim visual completion from source inspection.`,
					{ reason: "preview-evidence-missing", previewStep: previewStep.id },
				);
				return;
			}
			if (previewStep.status !== "failed") {
				state = updateWorkflowStep(state, previewStep.id, "failed", "Native preview and rendered browser inspection evidence were not completed before the retry budget ended.");
			}
			publishState();
			return;
		}
		publishState();
		await runDeterministicGates();
	});

	// Registered after the workflow handler: a nested repair turn first updates
	// fingerprints/state, then releases the outer print-mode settlement barrier.
	pi.on("agent_settled", async () => {
		if (continuationWaiter?.started) continuationWaiter.finish(true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (backgroundHeartbeat) clearInterval(backgroundHeartbeat);
		backgroundHeartbeat = undefined;
		ctx.ui.setStatus("pi-app-workflow", undefined);
		for (const key of ["pi-app-workflow-state", "pi-app-background-state", "pi-app-checkpoint-state", "pi-app-preview-state"]) ctx.ui.setWidget(key, undefined);
		taskUi = undefined;
		backgroundTasks.clear();
	});

	log(`loaded v3 profile=${enabled ? "workflow" : "baseline"} maxLoops=${MAX_AUTO_LOOPS} ablations=${[...ABLATIONS].join(",")}`);
}
