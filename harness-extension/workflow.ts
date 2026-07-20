import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inferTaskIntent, type TaskIntent, type WorkflowProfile } from "./policy.js";

export type WorkflowStepStatus = "pending" | "running" | "waiting" | "passed" | "failed" | "skipped";
export type WorkflowStepKind = "plan" | "research" | "build" | "gate" | "evaluate" | "review";
export type WorkflowRunStatus = "active" | "needs-human" | "blocked" | "completed";

export type WorkflowStep = {
	id: string;
	label: string;
	kind: WorkflowStepKind;
	deps: string[];
	status: WorkflowStepStatus;
	acceptance: string;
	required: boolean;
	owner: "orchestrator" | "researcher" | "executor" | "gate-runner" | "evaluator" | "human";
	/** Total attempts, including the initial attempt. */
	maxAttempts: number;
	command?: string;
	timeoutMs?: number;
	attempts: number;
	detail?: string;
	failureReason?: string;
	startedAt?: number;
	completedAt?: number;
};

export type WorkflowEvent = {
	id: string;
	stepId?: string;
	type: "created" | "started" | "passed" | "failed" | "waiting" | "note" | "rewound";
	at: number;
	message: string;
};

export type WorkflowState = {
	version: 3;
	runId: string;
	createdAt: number;
	updatedAt: number;
	objective: string;
	intent: TaskIntent;
	profile: WorkflowProfile;
	status: WorkflowRunStatus;
	blockedStepId?: string;
	blockedReason?: string;
	terminationReason?: string;
	approved: boolean;
	editsPending: boolean;
	autoLoops: number;
	loopSignals: number;
	contextCheckpointed: boolean;
	changedFiles: string[];
	/** Git revision at objective creation; committed worktree merges remain observable. */
	baseRevision?: string;
	evaluatorTaskId?: string;
	steps: WorkflowStep[];
	events: WorkflowEvent[];
};

export type VerifierSpec = {
	id: string;
	label: string;
	command: string;
	acceptance?: string;
	required?: boolean;
	timeoutMs?: number;
};

export type VerifierManifest = {
	version: 1;
	profile?: WorkflowProfile;
	commands: VerifierSpec[];
	evaluator?: { enabled?: boolean; agent?: string };
	humanApproval?: boolean;
	source: "project" | "detected" | "empty";
	path?: string;
};

type StepTemplate = Omit<WorkflowStep, "status" | "attempts">;

const STEP_RUNTIME: Record<WorkflowStepKind, Pick<WorkflowStep, "owner" | "maxAttempts">> = {
	plan: { owner: "orchestrator", maxAttempts: 2 },
	research: { owner: "researcher", maxAttempts: 3 },
	build: { owner: "executor", maxAttempts: 5 },
	gate: { owner: "gate-runner", maxAttempts: 5 },
	evaluate: { owner: "evaluator", maxAttempts: 5 },
	review: { owner: "human", maxAttempts: 1 },
};

function withRuntime(step: Omit<StepTemplate, "owner" | "maxAttempts"> & Partial<Pick<StepTemplate, "owner" | "maxAttempts">>): StepTemplate {
	return { ...STEP_RUNTIME[step.kind], ...step } as StepTemplate;
}

const PROFILE_STEPS: Record<WorkflowProfile, StepTemplate[]> = Object.fromEntries(Object.entries({
	feature: [
		{ id: "plan", label: "Plan", kind: "plan", deps: [], acceptance: "Scope, dependencies and observable done state are explicit.", required: true },
		{ id: "build", label: "Build", kind: "build", deps: ["plan"], acceptance: "Implementation satisfies the approved plan and stated contract.", required: true },
		{ id: "verify", label: "Deterministic gates", kind: "gate", deps: ["build"], acceptance: "All required project verifier commands exit successfully.", required: true },
		{ id: "evaluate", label: "Independent evaluation", kind: "evaluate", deps: ["verify"], acceptance: "An isolated evaluator finds no blocking contract, regression or safety issue.", required: true },
		{ id: "review", label: "Engineer review", kind: "review", deps: ["evaluate"], acceptance: "Diff, evidence and residual risks are ready for handoff.", required: true },
	],
	bug: [
		{ id: "reproduce", label: "Reproduce", kind: "plan", deps: [], acceptance: "The failing boundary and regression signal are identified.", required: true },
		{ id: "build", label: "Fix root cause", kind: "build", deps: ["reproduce"], acceptance: "The cause is fixed in the smallest coherent scope.", required: true },
		{ id: "verify", label: "Regression gates", kind: "gate", deps: ["build"], acceptance: "Targeted regression and relevant broader gates pass.", required: true },
		{ id: "evaluate", label: "Independent evaluation", kind: "evaluate", deps: ["verify"], acceptance: "Evaluator confirms the failure is fixed without sibling regressions.", required: true },
		{ id: "review", label: "Engineer review", kind: "review", deps: ["evaluate"], acceptance: "Evidence and residual risks are documented.", required: true },
	],
	chore: [
		{ id: "plan", label: "Impact check", kind: "plan", deps: [], acceptance: "Affected surfaces and compatibility constraints are known.", required: true },
		{ id: "build", label: "Apply change", kind: "build", deps: ["plan"], acceptance: "Change is complete and scoped.", required: true },
		{ id: "verify", label: "Project gates", kind: "gate", deps: ["build"], acceptance: "Required project gates pass.", required: true },
		{ id: "evaluate", label: "Independent evaluation", kind: "evaluate", deps: ["verify"], acceptance: "Evaluator confirms compatibility and scope.", required: true },
	],
	hotfix: [
		{ id: "plan", label: "Containment plan", kind: "plan", deps: [], acceptance: "Blast radius, rollback and evidence plan are explicit.", required: true },
		{ id: "approve", label: "Approve plan", kind: "review", deps: ["plan"], acceptance: "A human explicitly approves the high-risk plan.", required: true },
		{ id: "build", label: "Apply hotfix", kind: "build", deps: ["approve"], acceptance: "Minimal reversible fix is applied.", required: true },
		{ id: "verify", label: "Safety gates", kind: "gate", deps: ["build"], acceptance: "Regression, security and rollback probes pass.", required: true },
		{ id: "evaluate", label: "Independent evaluation", kind: "evaluate", deps: ["verify"], acceptance: "Evaluator confirms containment and no blocking risk.", required: true },
		{ id: "review", label: "Ship review", kind: "review", deps: ["evaluate"], acceptance: "Human reviews evidence before ship.", required: true },
	],
	research: [
		{ id: "research", label: "Primary-source research", kind: "research", deps: [], acceptance: "Current primary evidence and source links support every unstable claim.", required: true },
		{ id: "review", label: "Evidence review", kind: "review", deps: ["research"], acceptance: "Facts, inference and open uncertainty are separated.", required: true },
	],
	assessment: [
		{ id: "inspect", label: "Inspect", kind: "research", deps: [], acceptance: "Primary local evidence has been inspected without mutation.", required: true },
		{ id: "review", label: "Assessment", kind: "review", deps: ["inspect"], acceptance: "Findings cite evidence, impact and actionable next steps.", required: true },
	],
}).map(([profile, steps]) => [profile, steps.map((step) => withRuntime(step as Parameters<typeof withRuntime>[0]))])) as Record<WorkflowProfile, StepTemplate[]>;

function lifecycle(steps: WorkflowStep[]): Pick<WorkflowState, "status" | "blockedStepId" | "blockedReason" | "terminationReason"> {
	const required = steps.filter((step) => step.required);
	const satisfied = new Set(steps.filter((step) => step.status === "passed" || step.status === "skipped").map((step) => step.id));
	const exhausted = required.find((step) => step.status === "failed" && step.attempts >= (step.maxAttempts ?? STEP_RUNTIME[step.kind].maxAttempts));
	if (exhausted) return {
		status: "blocked",
		blockedStepId: exhausted.id,
		blockedReason: exhausted.failureReason ?? exhausted.detail ?? `${exhausted.label} exhausted its retry budget.`,
		terminationReason: `Automatic retry budget exhausted at ${exhausted.id}.`,
	};
	const waiting = required.find((step) => step.status === "waiting" && step.deps.every((dep) => satisfied.has(dep)));
	if (waiting) return { status: "needs-human", blockedStepId: waiting.id, blockedReason: waiting.detail ?? waiting.acceptance, terminationReason: undefined };
	if (required.length > 0 && required.every((step) => step.status === "passed" || step.status === "skipped")) {
		return { status: "completed", blockedStepId: undefined, blockedReason: undefined, terminationReason: "Every required workflow step passed or was explicitly skipped." };
	}
	return { status: "active", blockedStepId: undefined, blockedReason: undefined, terminationReason: undefined };
}

/** Upgrade persisted v3 records created before lifecycle metadata was added. */
export function normalizeWorkflowState(state: WorkflowState): WorkflowState {
	const steps = state.steps.map((step) => ({ ...STEP_RUNTIME[step.kind], ...step }));
	return { ...state, steps, ...lifecycle(steps) };
}

function eventId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createWorkflowState(prompt: string, now = Date.now(), profileOverride?: WorkflowProfile): WorkflowState {
	const inferred = inferTaskIntent(prompt);
	const intent = profileOverride ? { ...inferred, profile: profileOverride } : inferred;
	const approved = !intent.requiresHumanApproval;
	const steps = PROFILE_STEPS[intent.profile].map((step) => ({
		...step,
		status: step.id === "approve" ? "waiting" as const : "pending" as const,
		attempts: 0,
	}));
	return {
		version: 3,
		runId: `wf-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		createdAt: now,
		updatedAt: now,
		objective: prompt.trim().slice(0, 2_000),
		intent,
		profile: intent.profile,
		...lifecycle(steps),
		approved,
		editsPending: false,
		autoLoops: 0,
		loopSignals: 0,
		contextCheckpointed: false,
		changedFiles: [],
		baseRevision: undefined,
		evaluatorTaskId: undefined,
		steps,
		events: [{ id: eventId(), type: "created", at: now, message: `${intent.profile} workflow created` }],
	};
}

export function updateWorkflowStep(
	state: WorkflowState,
	stepId: string,
	status: WorkflowStepStatus,
	detail?: string,
	now = Date.now(),
): WorkflowState {
	const steps = state.steps.map((rawStep) => {
		const step = { ...STEP_RUNTIME[rawStep.kind], ...rawStep };
		return step.id !== stepId ? step : {
		...step,
		status,
		detail: detail ?? step.detail,
		failureReason: status === "failed" ? (detail ?? step.failureReason ?? `${step.label} failed.`) : undefined,
		attempts: status === "running" ? step.attempts + 1 : step.attempts,
		startedAt: status === "running" ? now : step.startedAt,
		completedAt: ["passed", "failed", "skipped"].includes(status) ? now : undefined,
	};
	});
	const type: WorkflowEvent["type"] = status === "running" ? "started" : status === "passed" ? "passed" : status === "failed" ? "failed" : status === "waiting" ? "waiting" : "note";
	return {
		...state,
		...lifecycle(steps),
		updatedAt: now,
		steps,
		events: [...state.events, { id: eventId(), stepId, type, at: now, message: detail ?? `${stepId}: ${status}` }].slice(-160),
	};
}

function parseProjectManifest(path: string): VerifierManifest | undefined {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<VerifierManifest>;
		if (raw.version !== 1 || !Array.isArray(raw.commands)) return undefined;
		const commands = raw.commands.filter((item): item is VerifierSpec => Boolean(
			item && typeof item.id === "string" && typeof item.label === "string" && typeof item.command === "string",
		));
		return { ...raw, version: 1, commands, source: "project", path } as VerifierManifest;
	} catch {
		return undefined;
	}
}

function detectedPackageCommands(cwd: string): VerifierSpec[] {
	const path = join(cwd, "package.json");
	if (!existsSync(path)) return [];
	try {
		const pkg = JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, string> };
		const scripts = pkg.scripts ?? {};
		return ["lint", "typecheck", "check", "test", "build"]
			.filter((name) => typeof scripts[name] === "string")
			.map((name) => ({ id: name, label: name, command: `npm run ${name}`, required: true, timeoutMs: name === "test" || name === "build" ? 300_000 : 180_000 }));
	} catch {
		return [];
	}
}

/** Load explicit project gates first; otherwise detect only conventional project scripts. */
export function loadVerifierManifest(cwd: string): VerifierManifest {
	for (const relative of [".pi/verifiers.json", ".pi/workflow.json"]) {
		const path = join(cwd, relative);
		if (!existsSync(path)) continue;
		const manifest = parseProjectManifest(path);
		if (manifest) return manifest;
	}
	const commands = detectedPackageCommands(cwd);
	return { version: 1, commands, source: commands.length > 0 ? "detected" : "empty" };
}

export function attachVerifierSteps(state: WorkflowState, manifest: VerifierManifest): WorkflowState {
	const gateIndex = state.steps.findIndex((step) => step.id === "verify");
	if (gateIndex < 0) return state;
	const gate = state.steps[gateIndex];
	const verifierSteps = manifest.commands.map((spec) => ({
		id: `verify:${spec.id}`,
		label: spec.label,
		kind: "gate" as const,
		deps: [...gate.deps],
		status: "pending" as const,
		acceptance: spec.acceptance ?? `Command exits zero: ${spec.command}`,
		required: spec.required !== false,
		...STEP_RUNTIME.gate,
		command: spec.command,
		timeoutMs: spec.timeoutMs,
		attempts: 0,
	}));
	const downstream = state.steps.map((step, index) => {
		if (index === gateIndex) return undefined;
		if (!step.deps.includes("verify")) return step;
		return { ...step, deps: step.deps.flatMap((dep) => dep === "verify" ? verifierSteps.map((item) => item.id) : [dep]) };
	}).filter((step): step is WorkflowStep => Boolean(step));
	let steps = verifierSteps.length > 0
		? [...downstream.slice(0, gateIndex), ...verifierSteps, ...downstream.slice(gateIndex)]
		: state.steps.map((step) => step.id === "verify" ? { ...step, status: "waiting" as const, detail: "No verifier manifest or conventional scripts found." } : step);
	const requiresHumanApproval = manifest.humanApproval ?? state.intent.requiresHumanApproval;
	if (requiresHumanApproval && !steps.some((step) => step.id === "approve")) {
		const buildIndex = steps.findIndex((step) => step.kind === "build");
		if (buildIndex >= 0) {
			const build = steps[buildIndex];
			const approval: WorkflowStep = {
				id: "approve",
				label: "Approve plan",
				kind: "review",
				deps: [...build.deps],
				status: "waiting",
				acceptance: "A human explicitly approves the plan before repository mutation.",
				required: true,
				...STEP_RUNTIME.review,
				attempts: 0,
			};
			steps = [...steps.slice(0, buildIndex), approval, { ...build, deps: ["approve"] }, ...steps.slice(buildIndex + 1)];
		}
	} else if (!requiresHumanApproval) {
		steps = steps.map((step) => step.id === "approve"
			? { ...step, status: "skipped" as const, detail: "Project workflow explicitly does not require human approval." }
			: step);
	}
	const requiresEvaluator = manifest.evaluator?.enabled ?? state.intent.requiresEvaluator;
	return {
		...state,
		...lifecycle(steps),
		updatedAt: Date.now(),
		approved: requiresHumanApproval ? false : true,
		intent: { ...state.intent, requiresHumanApproval, requiresEvaluator },
		steps,
	};
}

export function readySteps(state: WorkflowState): WorkflowStep[] {
	const passed = new Set(state.steps.filter((step) => step.status === "passed" || step.status === "skipped").map((step) => step.id));
	return state.steps.filter((step) => step.status === "pending" && step.deps.every((dep) => passed.has(dep)));
}
