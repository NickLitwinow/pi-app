/** Pure policy helpers kept separate from the Pi extension so they can be tested. */

const VERIFY_COMMAND = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|build|typecheck)\b|(?:vitest|jest|pytest|eslint|ruff|mypy|ctest|phpunit)\b|(?:node|deno)\s+--?test\b|python(?:3)?\s+-m\s+(?:pytest|unittest)\b|cargo\s+(?:test|check|clippy|build)\b|go\s+(?:test|vet|build)\b|dotnet\s+(?:test|build)\b|composer\s+(?:test|check)\b|tsc\b|make\s+(?:test|check|lint|build)\b|(?:\.\/)?gradlew?\s+(?:test|check|build)\b|mvn\s+(?:test|verify)\b|swift\s+(?:test|build)\b)/i;

export type TaskKind = "trivial" | "assessment" | "research" | "debug" | "build";
export type WorkflowProfile = "feature" | "bug" | "chore" | "hotfix" | "research" | "assessment";
export type TaskRisk = "low" | "medium" | "high";

/**
 * Agent tool results can arrive either as plain text or as a JSON-rendered value
 * whose newlines are still escaped ("\\n"). Restrict the identifier grammar so
 * presentation text such as `Type:` can never become part of a persisted task ID.
 */
export function parseBackgroundAgentId(result: string): string | undefined {
	return /Agent ID:\s*([A-Za-z0-9][A-Za-z0-9._-]*)/i.exec(result)?.[1];
}

/**
 * A task can require several capabilities at once. Keeping those axes independent
 * prevents words such as "research" or "bug" from accidentally discarding an
 * explicit implementation request.
 */
export type TaskIntent = {
	primary: TaskKind;
	profile: WorkflowProfile;
	risk: TaskRisk;
	needsResearch: boolean;
	allowsMutation: boolean;
	allowsDeletion: boolean;
	requiresPlan: boolean;
	requiresSandbox: boolean;
	requiresEvaluator: boolean;
	requiresHumanApproval: boolean;
	signals: string[];
};

const RESEARCH = /(найди в (?:интернете|сети)|погугли|доресерч|актуальн\w*\s+(?:данн|верси)|latest|search the web|research\b|best[- ]practice)/i;
const ASSESS = /(ознакомься|проанализир|аудит|ревью|объясни|почему|диагностир|inspect|audit|review|explain|diagnos|верифицир)/i;
const MUTATE = /(исправ|реализуй|реализовать|реализир|внеси|измени|переработ|почин|рефактор|мигрир|передел|добавь|создай|переимен|удал|замени|настрой|обнови|fix|implement|change|build|refactor|redesign|migrate|add\b|create\b|update\b|rename\b|remove\b|delete\b)/i;
const DEBUG = /(баг|ошибк|краш|падает|не\s+работает|слома|дефект|регресс|почин|исправ|bug|crash|broken|debug|regression|fix\b)/i;
const BUILD_SCOPE = /(миграц|миграт|переработ|рефактор|redesign|migrat|refactor|архитектур|workflow|воркфлоу)/i;
const HOTFIX = /(hotfix|аварийн|инцидент|production|продакшн|security incident|уязвим)/i;
const HIGH_RISK = /(production|продакшн|deploy|релиз|миграц\w*\s+(?:данн|баз)|drop\s+(?:table|database)|delete\s+(?:data|database|account)|удал\w*\s+(?:данн|баз|аккаунт)|платеж|billing|секрет|credential|security incident|уязвим|destructive)/i;
const APPROVAL_REQUIRED = /(production|продакшн|deploy|релиз|drop\s+(?:table|database)|delete\s+(?:data|database|account)|удал\w*\s+(?:данн|баз|аккаунт)|rotate\s+(?:secret|credential)|ротац\w*\s+(?:секрет|ключ)|платеж|billing|security incident)/i;
const CHORE = /(chore|dependency|dependencies|зависимост|конфиг|config|format|lint|rename|переимен)/i;
const DELETE_EXPLICIT = /\b(?:delete|remove)\b|удал\w*|убер(?:и|ите)\b/i;
const DELETE_DENIAL = /\b(?:do not|don't|without)\s+(?:delete|remove)\b|не\s+(?:удал\w*|убира\w*)/i;

export function inferTaskIntent(prompt: string): TaskIntent {
	const text = prompt.trim();
	// Desired quality is not evidence of a live incident or deployment request.
	const riskText = text.replace(/\bproduction[-\s]ready\b/gi, "");
	const needsResearch = RESEARCH.test(text);
	const asksAssessment = ASSESS.test(text);
	const allowsMutation = MUTATE.test(text);
	const allowsDeletion = allowsMutation && DELETE_EXPLICIT.test(text) && !DELETE_DENIAL.test(text);
	const debugSignal = DEBUG.test(text);
	const hotfixSignal = HOTFIX.test(riskText);
	const highRiskSignal = HIGH_RISK.test(riskText);
	const buildScopeSignal = BUILD_SCOPE.test(text);
	const listItems = (text.match(/(^|\n)\s*(\d+[.)]|[-*•])\s+/g) ?? []).length;
	const coupled = text.length >= 220 || listItems >= 2;

	let primary: TaskKind = "trivial";
	if (allowsMutation) primary = debugSignal && !coupled && !needsResearch && !buildScopeSignal ? "debug" : "build";
	else if (needsResearch) primary = "research";
	else if (asksAssessment || debugSignal) primary = "assessment";

	let profile: WorkflowProfile;
	if (hotfixSignal && allowsMutation) profile = "hotfix";
	else if (debugSignal && allowsMutation) profile = "bug";
	else if (allowsMutation && CHORE.test(text) && !coupled) profile = "chore";
	else if (allowsMutation) profile = "feature";
	else if (needsResearch) profile = "research";
	else profile = "assessment";

	const risk: TaskRisk = highRiskSignal ? "high" : coupled || allowsMutation ? "medium" : "low";
	const signals = [
		needsResearch && "research",
		asksAssessment && "assessment",
		allowsMutation && "mutation",
		allowsDeletion && "deletion-authorized",
		debugSignal && "debug",
		hotfixSignal && "hotfix",
		highRiskSignal && "high-risk",
		coupled && "coupled",
		buildScopeSignal && "architectural",
	].filter((value): value is string => Boolean(value));

	return {
		primary,
		profile,
		risk,
		needsResearch,
		allowsMutation,
		allowsDeletion,
		requiresPlan: allowsMutation && (coupled || risk !== "low"),
		requiresSandbox: allowsMutation && (coupled || risk === "high"),
		requiresEvaluator: allowsMutation,
		requiresHumanApproval: allowsMutation && (profile === "hotfix" || APPROVAL_REQUIRED.test(riskText)),
		signals,
	};
}

/** Backwards-compatible projection for extensions/tests that only need the primary route. */
export function classifyTask(prompt: string): TaskKind {
	return inferTaskIntent(prompt).primary;
}

/**
 * Accept a real verification command, optionally after setup commands joined with `&&`.
 * Refuse shell constructs that can hide the verifier's non-zero exit status.
 */
export function isVerifyCommand(command: string): boolean {
	const cmd = command.trim();
	if (!cmd) return false;
	if (/\|\|\s*(?:true\b|:|exit\s+0\b)|;\s*exit\s+0\b/i.test(cmd)) return false;

	return cmd
		.split(/&&|;|\n/)
		.map((part) => part.trim().replace(/^\(+\s*/, ""))
		.some((part) => VERIFY_COMMAND.test(part));
}

function resultText(result: unknown): string {
	try {
		return typeof result === "string" ? result : JSON.stringify(result ?? "");
	} catch {
		return "";
	}
}

function explicitExitCode(result: unknown): number | undefined {
	if (!result || typeof result !== "object") return undefined;
	const queue: unknown[] = [result];
	const seen = new Set<unknown>();
	while (queue.length > 0) {
		const value = queue.shift();
		if (!value || typeof value !== "object" || seen.has(value)) continue;
		seen.add(value);
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			if (/^(?:exitCode|exit_code|statusCode)$/i.test(key) && typeof child === "number") return child;
			if (child && typeof child === "object") queue.push(child);
		}
	}
	return undefined;
}

/** A failed probe invalidates an earlier green gate even when it is not a test-runner command. */
export function executionFailed(isError: boolean, result: unknown): boolean {
	if (isError) return true;
	const code = explicitExitCode(result);
	if (code !== undefined && code !== 0) return true;

	const text = resultText(result);
	const textualExit = /(?:process|command)?\s*(?:exited|exit(?:ed)?\s+code|status)\D{0,12}([1-9]\d*)/i.exec(text);
	if (textualExit) return true;
	if (/\b[1-9]\d*\s+(?:tests?\s+)?failed\b|\bFAIL(?:ED)?\s+(?:tests?\b|[^\n]{0,80}\.(?:test|spec)\.)|command failed/i.test(text)) {
		return true;
	}
	return false;
}

/** A successful-looking tool envelope is not enough: reject explicit non-zero exits and failed suites. */
export function verificationSucceeded(command: string, isError: boolean, result: unknown): boolean {
	return isVerifyCommand(command) && !executionFailed(isError, result);
}

/** Use the last explicit evaluator verdict so quoted instructions cannot create a pass. */
export function parseIndependentVerdict(result: string): "pass" | "fail" | undefined {
	let verdict: "pass" | "fail" | undefined;
	const pattern = /\bVERDICT\s*:\s*(PASS|FAIL)\b|["']verdict["']\s*:\s*["'](pass|fail)["']/gi;
	for (const match of result.matchAll(pattern)) {
		const value = (match[1] ?? match[2])?.toLowerCase();
		if (value === "pass" || value === "fail") verdict = value;
	}
	return verdict;
}

/** A PASS is fail-closed unless the evaluator completed the required protocol. */
export function independentEvaluationAccepted(result: string): boolean {
	// Models often decorate required control lines with Markdown even when asked
	// for exact text. Normalize presentation only; do not weaken their meaning.
	const controlLines: string[] = [];
	const headingVerdicts: Array<{ id: string; verdict: "PASS" | "FAIL" }> = [];
	let pendingClauseId: string | undefined;
	for (const line of result.split(/\r?\n/)) {
		const unprefixed = line.trim().replace(/^(?:#{1,6}|[-+*>])\s+/, "");
		const undecorated = unprefixed.replace(/\*\*|__|`/g, "").trim();
		// ThinkingCap frequently emits the required clause records as a Markdown
		// table. Accept only an unambiguous verdict in the second cell. Evidence
		// columns containing words such as PASS do not count, and a FAIL row still
		// invalidates the complete review below.
		if (/^\|.*\|$/.test(undecorated)) {
			const cells = undecorated.slice(1, -1).split("|").map((cell) => cell.trim());
			const verdict = /^(PASS|FAIL)$/i.exec(cells[1] ?? "")?.[1]?.toUpperCase();
			const id = /^(?!CLAUSE\b|ID\b)([A-Za-z][A-Za-z0-9_.-]*|\d+)\b/i.exec(cells[0] ?? "")?.[1];
			if (id && verdict) {
				pendingClauseId = undefined;
				controlLines.push(`CLAUSE ${id}: ${verdict}`);
				continue;
			}
		}
		// ThinkingCap reliably emits "Verdict: CLAUSE C1: PASS" after a full
		// matrix. Normalize only that explicit clause record. A prose
		// "Verdict: PASS" under a clause heading remains insufficient.
		const clauseRecord = undecorated.replace(/^(?:STATUS|VERDICT|RESULT)\s*:\s*(?=CLAUSE\s+[^:\n]+\s*:\s*(?:PASS|FAIL)\b)/i, "");
		if (/^CLAUSE\s+[^:\n]+\s*:\s*(?:PASS|FAIL)\b/i.test(clauseRecord)) {
			pendingClauseId = undefined;
			controlLines.push(clauseRecord);
			continue;
		}
		// A clause heading with an explicit terminal verdict is also
		// machine-checkable: `CLAUSE R1: Reject absolute paths — PASS`.
		// Require the verdict at end-of-line so PASS mentioned in evidence cannot
		// manufacture acceptance.
		const inlineHeadingVerdict = /^CLAUSE\s+([^:\n]+):\s*.+?\s+[—–-]\s*(PASS|FAIL)[.!]?$/i.exec(undecorated);
		if (inlineHeadingVerdict) {
			pendingClauseId = undefined;
			controlLines.push(`CLAUSE ${inlineHeadingVerdict[1].trim()}: ${inlineHeadingVerdict[2].toUpperCase()}`);
			continue;
		}
		// ThinkingCap also emits a Markdown clause heading followed, after its
		// evidence, by a standalone bold PASS/FAIL line. Bind only that bare
		// control token to the nearest heading immediately. A repeated per-heading
		// "Verdict: PASS" form is accepted below only for a long matrix, so a lone
		// global-looking verdict cannot manufacture clause evidence.
		const clauseHeading = /^CLAUSE\s+([^:\n]+)(?::\s+.+)?$/i.exec(undecorated);
		if (clauseHeading) pendingClauseId = clauseHeading[1].trim();
		const standaloneVerdict = /^(PASS|FAIL)$/i.exec(undecorated)?.[1]?.toUpperCase();
		if (pendingClauseId && standaloneVerdict) {
			controlLines.push(`CLAUSE ${pendingClauseId}: ${standaloneVerdict}`);
			pendingClauseId = undefined;
			continue;
		}
		// Bind a verdict with a clearly delimited explanatory suffix to its nearest
		// clause heading. ThinkingCap commonly emits `Verdict: PASS — evidence`.
		// Free prose such as `PASS if ...` is still rejected, and positive heading
		// pairs only count when a long (8+) matrix makes the structure unambiguous.
		const labelledHeadingVerdict = /^(?:STATUS|VERDICT|RESULT)\s*:\s*(PASS|FAIL)(?:[.!]|\s*[—–-]\s*.+)?$/i
			.exec(undecorated)?.[1]?.toUpperCase() as "PASS" | "FAIL" | undefined;
		if (pendingClauseId && labelledHeadingVerdict) {
			headingVerdicts.push({ id: pendingClauseId, verdict: labelledHeadingVerdict });
			pendingClauseId = undefined;
			continue;
		}
		controlLines.push(/^(?:BLOCKING\b|PROTOCOL\b|VERDICT\b)/i.test(clauseRecord)
			? clauseRecord
			: unprefixed);
	}
	// Eight repeated heading/verdict pairs are an unambiguous long clause matrix.
	// Always preserve an explicit per-heading FAIL, even in a shorter review.
	if (headingVerdicts.length >= 8) {
		controlLines.push(...headingVerdicts.map(({ id, verdict }) => `CLAUSE ${id}: ${verdict}`));
	} else {
		controlLines.push(...headingVerdicts
			.filter(({ verdict }) => verdict === "FAIL")
			.map(({ id, verdict }) => `CLAUSE ${id}: ${verdict}`));
	}
	const control = controlLines.join("\n");
	if (parseIndependentVerdict(control) !== "pass") return false;
	const passedClauses = new Set([...control.matchAll(/^CLAUSE(?:\s+([^:\n]+))?:\s*PASS\b/gim)]
		.map((match) => (match[1] ?? "unnamed").trim().toLowerCase()));
	// A long, explicit clause control matrix is itself machine-checkable proof that
	// the protocol ran. ThinkingCap occasionally omits only the ceremonial marker
	// after emitting 10+ clause records. Small reviews still require the marker.
	if (!/^PROTOCOL:\s*COMPLETE\s*$/im.test(control) && passedClauses.size < 8) return false;
	if (passedClauses.size === 0) return false;
	if (/^CLAUSE(?:\s+[^:\n]+)?:\s*FAIL\b/im.test(control)) return false;
	const blocking = /^BLOCKING(?:\s+FINDINGS?)?:\s*(.*)$/im.exec(control)?.[1]?.trim();
	if (!blocking || !/^(?:NONE|\[\s*\])\.?$/i.test(blocking)) return false;
	return true;
}

/**
 * Never feed a malformed positive review back to the builder as if it were a
 * supported finding. Local models otherwise anchor on the quoted PASS and make
 * no change. A real FAIL keeps its evidence; an invalid PASS is discarded and
 * replaced with a fresh adversarial audit instruction.
 */
export function independentEvaluationRepairPrompt(result: string, limit = 6_000): string {
	if (parseIndependentVerdict(result) === "pass" && !independentEvaluationAccepted(result)) {
		return `Continue the existing objective. The evaluator claimed PASS but its output was discarded because it did not complete the required machine-checkable clause protocol. The quoted positive review is not evidence and must not be treated as acceptance.

Perform a fresh adversarial audit against the authoritative contract before claiming there is nothing to repair. Trace strict typed version/state discriminators, wrong-type default inputs, scalar coercions, idempotency, mutation and nested aliasing, state-transition identity/round trips, invalid handles or targets, side effects, and preserved sibling APIs through the actual expressions. Audit every removed export or entrypoint line in the git diff: a refactor must preserve each pre-existing exported symbol, callable signature, and require-main guard unless the objective explicitly authorizes its removal. An exported main(argv) must remain safe to call as a library: it returns an exit code and must not read process.argv or call process.exit; only the require-main wrapper may set process.exitCode. For path boundaries, separately probe absolute paths targeting both inside and outside the allowed root, traversal segments that normalize both inside and outside it, and lexical root aliases whose realpath differs (for example macOS /var versus /private/var). Exact literals do not permit coercible substitutes unless the contract explicitly permits coercion. Repair every violation you can reproduce, add focused regression probes, and rerun every declared gate.`;
	}
	const details = result.trim().slice(-Math.max(0, limit));
	return `Continue the existing objective. Independent evaluator rejected the build. Repair every supported finding and preserve the original contract. Turn every concrete failing input/output pair named by the evaluator into a verbatim regression probe before editing; do not reinterpret, weaken, or silently drop an enumerated counterexample. Then perform a fresh full clause-matrix and coercion-corpus audit before rerunning every declared gate: evaluator evidence may stop at the first blocker, so do not stop after the quoted clause. Recheck analogous defaults, typed discriminators, boundary representations, idempotency, nested aliasing, state-transition identity/round trips, invalid handles or targets, side effects, and preserved sibling APIs. Audit every removed export or entrypoint line in the git diff: preserve each pre-existing exported symbol, callable signature, and require-main guard unless the objective explicitly authorizes its removal. An exported main(argv) must return an exit code and remain safe to call as a library: it must not read process.argv or call process.exit; only the require-main wrapper may set process.exitCode. For path boundaries, separately probe absolute paths targeting both inside and outside the allowed root, traversal segments that normalize both inside and outside it, and lexical root aliases whose realpath differs (for example macOS /var versus /private/var). Unless the authoritative contract narrows the term, blank strings include both empty and whitespace-only values.${details ? `\n\n${details}` : ""}`;
}

export type IndependentEvaluatorPromptInput = {
	objective: string;
	profile: string;
	changedFiles: string[];
	evidence: string;
	diff: string;
};

export function buildIndependentFalsifierPrompt(input: IndependentEvaluatorPromptInput, candidate: string): string {
	return `You are the second, independent counterexample falsifier. Another evaluator proposed PASS; that proposal is untrusted and may contain a confident semantic mistake.

Original objective:
${input.objective}

Deterministic gate evidence:
${input.evidence}

Actual git diff:
${input.diff.slice(-30_000)}

Candidate evaluation (untrusted):
${candidate.slice(-12_000)}

Inspect the authoritative contract and actual repository expressions with read-only tools. Do not modify files and do not merely repeat the candidate review.

Your primary job is falsification. For every normative clause, try to construct the smallest counterexample that the implementation accepts but the contract rejects, or rejects but the contract accepts. Treat words such as only, exactly, every, anything else, never, missing, blank, integer, decimal digit string, and exact version/state literals as set boundaries:
- State the allowed representation set and its complement separately from the numeric/value domain.
- "Only when missing or blank" means every supplied non-blank wrong-type value is outside the defaulting set unless the contract explicitly says otherwise.
- Unless the authoritative contract narrows the word, a blank string includes both empty and whitespace-only strings.
- "Decimal digit string" means the stated digit grammar; do not invent canonical-format restrictions such as banning leading zeroes unless the contract states them.
- An input contract naming version: 1 does not authorize a catch-all non-v2 branch. Trace true, false, null, undefined, {}, [], "1", "2", "01", 0, 1, 2, and 3 through the actual discriminator.
- For every branch, undo/redo, rewind/return, checkpoint/restore, or other state transition, verify the round trip restores identity tokens as well as payload. Probe unknown and wrong-kind handles, same-session invariants, and nested mutable aliases back to the source state.
- For every filesystem containment clause, distinguish syntactic rejection from containment after normalization. Probe absolute paths targeting both inside and outside the root, traversal segments that normalize back inside as well as escape outside, symlink targets, and lexical root aliases whose realpath differs (for example macOS /var versus /private/var).
- Audit every removed export or entrypoint line in the actual git diff. Before PASS, enumerate each pre-existing module.exports/exports./ES export, exported callable signature, and require-main guard and prove it remains callable unless the objective explicitly authorizes removal. An exported main(argv) must return an exit code and must not read process.argv or call process.exit; only its require-main wrapper may assign process.exitCode. Replacing it with a process-global-only or host-terminating function is a blocking regression.
- Any explicit violation is blocking. Never relabel a known violation as lenient, minor, harmless for valid inputs, or non-blocking.

Report every obligation as CLAUSE <id>: PASS or CLAUSE <id>: FAIL. Report BLOCKING: NONE only if no counterexample survives. Emit PROTOCOL: COMPLETE after the matrix. The final line must be exactly VERDICT: PASS or VERDICT: FAIL.`;
}

/**
 * Contract-first evaluation prevents a common semantic false positive: proving
 * only the range of a coerced value while the contract also constrains the
 * accepted input representation or type.
 */
export function buildIndependentEvaluatorPrompt(input: IndependentEvaluatorPromptInput): string {
	return `You are an independent read-only evaluator. You did not implement this change.

Original objective:
${input.objective}

Profile: ${input.profile}
Changed files:
${input.changedFiles.join("\n") || "none recorded"}

Deterministic gate evidence:
${input.evidence}

Actual git diff:
${input.diff.slice(-30_000)}

Inspect the authoritative contract and relevant repository files with read-only tools. Do not modify files.

Required evaluation protocol:
1. Extract every normative clause into a clause matrix. Include input representation/type grammar, value domain/range, defaults, version or state discriminators, mutation/nested aliasing, state-transition identity and round trips, invalid handles/targets, idempotency and serialization, side effects/atomicity, sibling implementations, public API/capability preservation, regressions, security, and scope when applicable.
2. For each clause cite the actual implementing expression or report it missing. A test count, a green suite, or plausible prose is not implementation evidence.
3. For every validation clause enumerate representative valid values plus adversarial invalid values at both boundaries. Keep representation/type grammar separate from the range of a coerced value: for example, Number.isInteger(Number(x)) does not prove that x was an allowed integer or decimal digit string.
4. For every scalar parser, trace every applicable member of this coercion corpus through the actual expression: boolean true and false; null; undefined; {}; []; a boxed primitive; strings "", " ", "+1", "-1", "1.0", "1e3", "0x10", "01"; numbers -1, 0, 1 and each domain boundary ±1. Keep the value and its runtime type visible. Do not substitute easier examples. If there is no scalar parser, state why the corpus is not applicable.
5. Treat every version/state/kind discriminator as its own strict input boundary. Unless the authoritative contract explicitly permits coercion, an exact literal such as version: 1 means the number 1 only: strings "1"/"01", booleans, null, boxed values and other coercible representations must be rejected. Trace at least true, false, null, undefined, {}, [], "1", "2", "01", 0, 1, 2, 3 through the actual discriminator expression. Number(x), String(x), loose equality, truthiness, or a downstream successful parse is evidence of coercion, not proof of acceptance.
6. Treat defaults as a separate acceptance boundary. If a contract says a value defaults only when missing or blank, trace missing, undefined, null, empty string, whitespace-only string, valid string, number, boolean, array, and object. Unless the authoritative contract narrows the word, blank includes both empty and whitespace-only strings. A supplied wrong-type value must not silently receive the default unless the contract explicitly authorizes that behavior. Also check fresh-value/no-mutation behavior and stable repeated normalization or serialization explicitly when the contract mentions them.
7. Interpret normative representation sets literally. "Decimal digit string" means the stated digit grammar; do not invent a canonical-format restriction such as banning leading zeroes unless the contract says so. "Only when missing or blank" makes every supplied non-blank wrong-type value part of the rejected complement. A contract naming input version: 1 does not authorize a catch-all non-v2 branch.
8. For every branch, undo/redo, rewind/return, checkpoint/restore, or other state transition, execute a conceptual round trip: verify the selected identity token, payload, parent/session identity, and composer/metadata are restored together. Probe unknown and wrong-kind handles and mutate returned nested objects to detect aliases into the source state. Restoring only payload while leaving the wrong active identity is a blocking violation.
9. For every filesystem containment clause, distinguish syntactic rejection from containment after normalization. Trace absolute paths targeting both inside and outside the allowed root, traversal segments that normalize back inside as well as escape outside, symlink targets, and lexical root aliases whose realpath differs (for example macOS /var versus /private/var). A containment check alone does not prove a clause that requires rejecting the syntax itself.
10. Audit every removed export or entrypoint line in the actual git diff. Enumerate each pre-existing module.exports/exports./ES export, exported callable signature, and require-main guard and prove it remains callable unless the objective explicitly authorizes removal. An exported main(argv) must return an exit code and must not read process.argv or call process.exit; only its require-main wrapper may assign process.exitCode. Replacing it with a process-global-only or host-terminating function, or dropping the require-main guard, is a blocking public-API and testability regression.
11. Treat every unmet explicit contract clause, observable regression, unsafe side effect, deleted or broken pre-existing public module/capability, or unsupported completion claim as blocking. Repair a drifted sibling by delegating it to the canonical implementation; deleting the sibling is not a valid fix unless the objective explicitly removes that capability and repository evidence proves all callers/contracts/tests migrated. Never downgrade a known contract violation to minor, lenient, harmless for valid inputs, or non-blocking. If your findings conflict with PASS, the verdict must be FAIL.
12. Report each obligation as CLAUSE <id>: PASS or CLAUSE <id>: FAIL and report BLOCKING: NONE or the findings. Emit PROTOCOL: COMPLETE only after the full matrix and coercion corpus are present. The final line must be exactly VERDICT: PASS or VERDICT: FAIL.`;
}
