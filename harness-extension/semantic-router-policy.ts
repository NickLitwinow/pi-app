import type { TaskIntent, TaskRisk, WorkflowProfile } from "./policy.js";

export type RouterMode = "deterministic" | "hybrid" | "semantic";

export type SemanticRoute = {
	profile: WorkflowProfile;
	modifyFiles: boolean;
	externalResearch: boolean;
	visualCheck: "required" | "forbidden" | "not-needed";
	risk: TaskRisk;
	humanApproval: boolean;
	confidence: number;
};

const PROFILES = new Set<WorkflowProfile>(["feature", "bug", "chore", "hotfix", "research", "assessment"]);
const VISUAL_CHECKS = new Set<SemanticRoute["visualCheck"]>(["required", "forbidden", "not-needed"]);
const RISKS = new Set<TaskRisk>(["low", "medium", "high"]);

export const SEMANTIC_ROUTER_SYSTEM_PROMPT = `You are a routing classifier for a coding agent. Classify the user's actual requested action, not words that merely appear in examples, desired UI labels, logs, code, quoted text, or background context.

Return exactly one compact JSON object and nothing else:
{"profile":"feature|bug|chore|hotfix|research|assessment","modifyFiles":true|false,"externalResearch":true|false,"visualCheck":"required|forbidden|not-needed","risk":"low|medium|high","humanApproval":true|false,"confidence":0.0}

Definitions:
- feature: create a new capability, artifact, application, UI, API, or substantial behavior.
- bug: repair an existing defect, failing behavior, crash, or regression. Incidental words such as debugging, bug tracker, error screen, crash analytics, and regression dashboard do not make a feature a bug.
- chore: maintenance, dependency/configuration changes, formatting, renaming, internal refactoring, git delivery, or repository housekeeping.
- hotfix: an urgent live production/security incident or deployment with material external risk.
- research: read-only external/current-source research.
- assessment: read-only local inspection, explanation, diagnosis, review, verification, or conversation.

Rules:
- Obey explicit read-only/no-file-change and no-browser/no-preview constraints.
- modifyFiles is true for every request to create, edit, fix, refactor, rename, configure, test, commit, push, merge, or otherwise change repository state. "Without changing behavior" still modifies files.
- modifyFiles is false only for read-only inspection, explanation, research, or explicit chat/output-only requests.
- externalResearch is true only when current external/web/official-source research is requested; a local code/security audit is assessment, not research.
- visualCheck is required for user-visible UI, web, canvas, styling, layout, dashboard, panel, screen, or visual artifact changes; forbidden only when the user explicitly disallows browser/preview/visual inspection.
- Only mark humanApproval for high-risk production/deployment/destructive external actions.
- Choose the primary route for mixed requests; research may be true alongside feature/bug/chore.
- A direct coding-agent request may be phrased implicitly ("the button needs to be blue", "opening this crashes"); classify the intended work. A hypothetical question, quoted text, log line, title, example, or mere discussion is not authorization to modify files.
- Never infer a bug merely from a noun or from text inside the requested artifact.`;

function extractJson(text: string): unknown {
	const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		return JSON.parse(trimmed.slice(start, end + 1));
	} catch {
		return undefined;
	}
}

export function parseSemanticRoute(text: string): SemanticRoute | undefined {
	const raw = extractJson(text);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const value = raw as Record<string, unknown>;
	if (!PROFILES.has(value.profile as WorkflowProfile)
		|| typeof value.modifyFiles !== "boolean"
		|| typeof value.externalResearch !== "boolean"
		|| !VISUAL_CHECKS.has(value.visualCheck as SemanticRoute["visualCheck"])
		|| !RISKS.has(value.risk as TaskRisk)
		|| typeof value.humanApproval !== "boolean"
		|| typeof value.confidence !== "number"
		|| !Number.isFinite(value.confidence)
		|| value.confidence < 0
		|| value.confidence > 1) return undefined;
	return {
		profile: value.profile as WorkflowProfile,
		modifyFiles: value.modifyFiles,
		externalResearch: value.externalResearch,
		visualCheck: value.visualCheck as SemanticRoute["visualCheck"],
		risk: value.risk as TaskRisk,
		humanApproval: value.humanApproval,
		confidence: value.confidence,
	};
}

export function normalizeRouterMode(value: string | undefined): RouterMode {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "deterministic" || normalized === "semantic") return normalized;
	return "hybrid";
}

/**
 * Hybrid routing pays for a semantic model call only when the prompt does not
 * contain an explicit, deterministic request boundary. Statements such as
 * "the save button is still invisible" or "this needs a CSV export" are useful
 * coding-agent instructions, but are intentionally too implicit for the regex
 * layer to authorize mutation on its own.
 */
export function shouldUseSemanticRouter(fallback: TaskIntent, mode: RouterMode): boolean {
	if (mode === "semantic") return true;
	if (mode === "deterministic") return false;
	if (fallback.signals.includes("mutation-denied")) return false;
	if (fallback.signals.includes("mutation-explicit")) return false;
	if (fallback.signals.includes("implicit-request")) return true;
	if (fallback.needsResearch || fallback.signals.includes("assessment")) return false;
	return fallback.primary === "trivial"
		|| (fallback.primary === "assessment" && fallback.signals.includes("debug"));
}

/**
 * Availability failures must degrade to a useful, deterministic route rather
 * than turning an implicit coding request into a read-only assessment.
 * This proposal is deliberately derived only from the same hard signals used
 * by mergeSemanticRoute; it grants no extra deletion or approval capability.
 */
export function deterministicSemanticFallback(fallback: TaskIntent): SemanticRoute {
	const profile: WorkflowProfile = fallback.signals.includes("hotfix")
		? "hotfix"
		: fallback.signals.includes("maintenance")
			? "chore"
			: fallback.signals.includes("bug-report") || fallback.signals.includes("debug")
				? "bug"
				: fallback.signals.includes("implicit-request")
					? "feature"
					: fallback.needsResearch
						? "research"
						: "assessment";
	const modifyFiles = !fallback.signals.includes("mutation-denied")
		&& !fallback.signals.includes("informational-question")
		&& !fallback.signals.includes("historical-context")
		&& fallback.signals.some((signal) =>
			signal === "implicit-request"
			|| signal === "bug-report"
			|| signal === "hotfix"
			|| signal === "maintenance");
	return {
		profile,
		modifyFiles,
		externalResearch: fallback.needsResearch || fallback.signals.includes("external-source-cue"),
		visualCheck: fallback.signals.includes("preview-denied")
			? "forbidden"
			: fallback.signals.includes("visual-context")
				? "required"
				: "not-needed",
		risk: fallback.risk,
		humanApproval: fallback.requiresHumanApproval,
		confidence: 0.55,
	};
}

/**
 * The model resolves semantic ambiguity; deterministic evidence remains the
 * safety boundary. In particular, the model can never invent deletion
 * authorization or bypass explicit read-only/preview/approval constraints.
 */
export function mergeSemanticRoute(fallback: TaskIntent, semantic: SemanticRoute): TaskIntent {
	const mutationDenied = fallback.signals.includes("mutation-denied");
	const mutationExplicit = fallback.signals.includes("mutation-explicit");
	const informationalQuestion = fallback.signals.includes("informational-question");
	const historicalContext = fallback.signals.includes("historical-context");
	const deterministicImplicitMutation = !informationalQuestion
		&& !historicalContext
		&& fallback.signals.some((signal) =>
			signal === "implicit-request" || signal === "bug-report" || signal === "hotfix");
	const semanticMutationEligible = fallback.signals.some((signal) =>
		signal === "implicit-request"
		|| signal === "bug-report"
		|| signal === "hotfix"
		|| (signal === "maintenance" && !fallback.signals.includes("assessment")));
	const previewDenied = fallback.signals.includes("preview-denied");
	const allowsMutation = !mutationDenied && (
		mutationExplicit
		|| deterministicImplicitMutation
		|| (
			semantic.modifyFiles
			&& semanticMutationEligible
			&& !informationalQuestion
			&& !historicalContext
		)
	);
	const needsResearch = fallback.needsResearch
		|| (semantic.externalResearch && fallback.signals.includes("external-source-cue"));
	let profile: WorkflowProfile;
	if (!allowsMutation) profile = needsResearch ? "research" : "assessment";
	else if (fallback.signals.includes("hotfix")) profile = "hotfix";
	else if (fallback.signals.includes("maintenance")) profile = "chore";
	else if (fallback.signals.includes("repair")) profile = "bug";
	else if (fallback.signals.includes("new-capability")) profile = "feature";
	else if (fallback.signals.includes("bug-report")) profile = "bug";
	else if (fallback.signals.includes("implicit-request") && fallback.signals.includes("visual-context")) profile = "feature";
	else if (["feature", "bug", "chore", "hotfix"].includes(semantic.profile)) profile = semantic.profile;
	else profile = ["feature", "bug", "chore", "hotfix"].includes(fallback.profile) ? fallback.profile : "feature";
	// The model may describe severity, but only deterministic repository/external
	// action evidence may raise safety authority or sandbox requirements.
	const risk: TaskRisk = fallback.signals.includes("high-risk")
		? "high"
		: allowsMutation
			? "medium"
			: fallback.risk;
	const needsPreview = allowsMutation && !previewDenied && (
		fallback.needsPreview
		|| fallback.signals.includes("visual-context")
		|| semantic.visualCheck === "required"
	);
	const requiresHumanApproval = allowsMutation && (
		fallback.requiresHumanApproval
		|| profile === "hotfix"
		|| fallback.signals.includes("approval-trigger")
	);
	const signals = [...new Set([
		...fallback.signals.filter((signal) => signal !== "visual-preview"),
		needsPreview && "visual-preview",
		previewDenied && "preview-denied",
		"semantic-router",
		`semantic:${semantic.profile}`,
		`confidence:${semantic.confidence.toFixed(2)}`,
	].filter((value): value is string => Boolean(value)))];
	return {
		...fallback,
		primary: allowsMutation ? (profile === "bug" ? "debug" : "build") : needsResearch ? "research" : "assessment",
		profile,
		risk,
		needsResearch,
		needsPreview,
		allowsMutation,
		// Deletion is capability-bearing and therefore requires deterministic,
		// explicit authorization even when the semantic model claims it.
		allowsDeletion: allowsMutation && fallback.allowsDeletion,
		requiresPlan: allowsMutation && (fallback.requiresPlan || profile === "feature" || profile === "hotfix"),
		requiresSandbox: allowsMutation && (fallback.requiresSandbox || risk === "high"),
		requiresEvaluator: allowsMutation,
		requiresHumanApproval,
		signals,
	};
}
