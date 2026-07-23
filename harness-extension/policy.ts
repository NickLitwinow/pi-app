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

export function classifyPreviewBrowserEvidence(
	toolName: string,
	args: unknown,
	previewUrl: string,
): { opened: boolean; inspected: boolean; summary: string } {
	const name = toolName.toLowerCase();
	let summaryInput = "";
	try {
		summaryInput = JSON.stringify(args ?? {});
	} catch {
		return { opened: false, inspected: false, summary: `${name}: unreadable input` };
	}
	const input = args && typeof args === "object" && !Array.isArray(args)
		? args as Record<string, unknown>
		: {};
	const sameUrl = (value: unknown) => {
		if (typeof value !== "string") return false;
		try {
			return new URL(value).href === new URL(previewUrl).href;
		} catch {
			return value === previewUrl;
		}
	};
	const chromeOpened = (name === "chrome_navigate" || name === "chrome_launch")
		&& [input.url, input.href, input.targetUrl].some(sameUrl);
	const chromeInspected = [
		"chrome_snapshot",
		"chrome_inspect",
		"chrome_screenshot",
		"chrome_list_console_messages",
		"chrome_list_network_requests",
	].includes(name);
	if (name !== "agent_browser") {
		return {
			opened: chromeOpened,
			inspected: chromeInspected,
			summary: `${name}: ${summaryInput.slice(0, 800)}`,
		};
	}

	const inspectionCommands = new Set(["snapshot", "screenshot", "console", "errors"]);
	const classifyCommand = (tokens: unknown[]): { opened: boolean; inspected: boolean } => {
		const values = tokens.filter((value): value is string => typeof value === "string");
		const flagsWithValues = new Set([
			"--session", "--namespace", "--profile", "--state", "--provider", "-p",
			"--executable-path", "--allowed-domains", "--config",
		]);
		let index = 0;
		while (index < values.length && values[index].startsWith("-")) {
			index += flagsWithValues.has(values[index]) ? 2 : 1;
		}
		const command = values[index];
		const rest = values.slice(index + 1);
		return {
			opened: command === "open" && sameUrl(rest[0]),
			inspected: inspectionCommands.has(command)
				|| (command === "network" && rest[0] === "requests"),
		};
	};

	let opened = false;
	let inspected = false;
	if (Array.isArray(input.args)) {
		({ opened, inspected } = classifyCommand(input.args));
		if (input.args.includes("batch") && typeof input.stdin === "string") {
			try {
				const steps = JSON.parse(input.stdin) as unknown;
				if (Array.isArray(steps)) {
					for (const step of steps) {
						if (!Array.isArray(step)) continue;
						const evidence = classifyCommand(step);
						opened ||= evidence.opened;
						inspected ||= evidence.inspected;
					}
				}
			} catch { /* malformed batch input is not evidence */ }
		}
	}
	const qa = input.qa && typeof input.qa === "object" && !Array.isArray(input.qa)
		? input.qa as Record<string, unknown>
		: undefined;
	if (qa) {
		const targetsPreview = sameUrl(qa.url);
		opened ||= targetsPreview;
		inspected ||= targetsPreview;
	}
	const job = input.job && typeof input.job === "object" && !Array.isArray(input.job)
		? input.job as Record<string, unknown>
		: undefined;
	if (job && Array.isArray(job.steps)) {
		for (const rawStep of job.steps) {
			if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) continue;
			const step = rawStep as Record<string, unknown>;
			opened ||= step.action === "open" && sameUrl(step.url);
			inspected ||= ["snapshot", "screenshot", "assertText", "assertSelector"].includes(String(step.action));
		}
	}
	return { opened, inspected, summary: `${name}: ${summaryInput.slice(0, 800)}` };
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
	needsPreview: boolean;
	allowsMutation: boolean;
	allowsDeletion: boolean;
	requiresPlan: boolean;
	requiresSandbox: boolean;
	requiresEvaluator: boolean;
	requiresHumanApproval: boolean;
	signals: string[];
};

const RESEARCH = /(найди в (?:интернете|сети)|погугли|доресерч|актуальн\w*\s+(?:данн|верси)|latest|current[^.\n]{0,100}(?:documentation|docs|guidance|standards?|spec(?:ification)?|version|limits)|compare[^.\n]{0,100}(?:official\s+)?(?:documentation|docs|guidance|standards?|spec(?:ification)?)|search the web|research\b|best[- ]practice)/i;
const EXTERNAL_SOURCE_CUE = /(?:\b(?:online|internet|web sources?|official\s+(?:rfc|spec(?:ification)?|standard|source|documentation|docs)|current\s+rfc|latest\s+rfc|up[- ]to[- ]date)\b|официальн\w*\s+(?:rfc|спецификац|стандарт|источник)|в\s+интернете|в\s+сети)/i;
const ASSESS = /(ознакомься|проанализир|аудит|ревью|объясни|почему|диагностир|inspect|audit|review|explain|diagnos|верифицир)/i;
const IMPLICIT_REQUEST = /(?:\b(?:please|needs?|should|must|required?|would\s+be\s+useful|can\s+we\s+have|could\s+you|can\s+you)\b|(?:нужен|нужна|нужно|должен|должна|должно|стоит\s+сделать)(?=\s|[.,!?]|$))/i;
const MUTATE_ACTION = /(?:^|[\n.;!?]\s*|\b(?:please|then|and|also|now)\s+)(?:fix|implement|change|build|refactor|redesign|migrate|add|create|update|rename|remove|delete|drop|repair|write|edit|modify|upgrade|format|revert|rollback|commit|push|merge|ship|deploy|rotate|make)\b|\b(?:task|goal|request)\s+(?:is\s+)?(?:for\s+you\s+)?(?:to\s+)?(?:fix|implement|change|build|refactor|redesign|migrate|add|create|update|rename|remove|delete|drop|repair|write|edit|modify|upgrade|format)\b|\bcontinue\s+(?:implementing|building|editing|fixing|working)\b|исправ|реализуй|реализовать|реализир|внеси|измени|переработ|почин|рефактор|мигрир|передел|добавь|создай|переимен|удал|замени|настрой|обнови|сделай|задеплой/i;
const REPAIR_ACTION = /(?:^|[\n.;!?]\s*|\b(?:please|then|and|also|now)\s+)(?:fix|repair|correct|debug|resolve)\b|\b(?:find|diagnose|identify)[^.\n]{0,100}\b(?:and\s+)?(?:fix|repair|correct|resolve)\b|исправ|почин|устрани\s+(?:ошиб|баг|дефект)/i;
const NEW_CAPABILITY = /(?:^|[\n.;!?]\s*|\b(?:please|then|and|also|now)\s+)(?:create|build|implement|add)\s+(?:(?:a|an|the)\s+)?(?:new\s+)?(?:capability|feature|application|app|game|dashboard|panel|screen|component|command|cli|api|endpoint|service|module|format|export|integration|authentication|login|website|site|tool)\b|создай|реализуй\s+нов|добавь\s+нов/i;
const DEBUG = /(баг|ошибк|краш|падает|не\s+работает|слома|дефект|регресс|почин|исправ|\b(?:bug|crash|broken|debug|regression|fix)\b)/i;
const BUILD_SCOPE = /(миграц|миграт|переработ|рефактор|redesign|migrat|refactor|архитектур|workflow|воркфлоу)/i;
const HOTFIX = /(?:\b(?:production|live)\b[^.\n]{0,100}\b(?:down|outage|failing|corrupt|incident|breach)\b|\b(?:urgent|emergency|contain(?:ment)?)\b[^.\n]{0,100}\b(?:hotfix|rollback|fix)\b|\b(?:apply|ship|deploy)\b[^.\n]{0,80}\bhotfix\b|security incident|активн\w*\s+уязвим|авар(?:ия|ийн)\w*|инцидент\w*\s+(?:в\s+)?продакшн)/i;
const HIGH_RISK = /(production|продакшн|deploy|релиз|\blive\s+(?:release|service|system|site)\b|миграц\w*\s+(?:данн|баз)|drop[^.\n]{0,40}\b(?:table|database)|delete\s+(?:data|database|account)|удал\w*\s+(?:данн|баз|аккаунт)|платеж|billing|секрет|credential|security incident|уязвим|destructive)/i;
const APPROVAL_REQUIRED = /(deploy|задеплой|drop[^.\n]{0,40}\b(?:table|database)|delete\s+(?:data|database|account)|удал\w*\s+(?:данн|баз|аккаунт)|rotate\s+(?:secret|credential)|ротац\w*\s+(?:секрет|ключ)|платеж|billing|security incident)/i;
const EXTERNAL_ACTION_DENIAL = /(?:\b(?:do not|don't|must not|nothing\s+should|without)\s+(?:be\s+)?(?:deploy|publish|push|drop|delete|rotate)|не\s+(?:деплой|публикуй|пуш|удаляй|ротируй))/i;
const DELIVERY_CONTEXT = /\bshould\s+be\s+(?:deployed|published|pushed|merged)\b/i;
const CHORE = /(chore|dependency|dependencies|зависимост|конфиг|config|format|lint|rename|переимен)/i;
const MAINTENANCE = /(?:^|[\n.;!?]\s*|\b(?:please|then|and|also|now)\s+)(?:upgrade\s+(?:the\s+)?(?:dependency|dependencies|package)|rename\b|refactor\b|format\b|update\s+(?:the\s+)?(?:lockfile|readme|documentation|docs|config(?:uration)?|snapshots?)|add\s+(?:contract|regression|unit|integration|snapshot)\s+tests?\b|delete\s+(?:the\s+)?obsolete\b|drop[^.\n]{0,40}\b(?:table|database)\b|revert\b|rollback\b|commit\b|push\b|merge\b|deploy\b|ship\b|publish\b|create\s+(?:a\s+)?pull request\b)|\bupdate\b[^.\n]{0,70}\b(?:lockfile|readme|documentation|docs|config(?:uration)?|snapshots?)\b|\bwithout\s+changing\s+(?:its\s+)?behavio(?:u)?r\b|обнови\s+(?:зависимост|конфиг|документац)|переимен|рефактор|отформат|сделай\s+коммит|запуш/i;
const MAINTENANCE_CONTEXT = /(?:\b(?:package-lock|lockfile|readme|snapshot files?|lint warnings?|repository formatter|internal helper name|pull request|test registry|dependency update|review findings?)\b|(?:typescript|eslint|vite|build)\s+config(?:uration)?\b|\bwithout\s+changing\s+(?:the\s+)?public\s+api\b|обновлени\w*\s+зависимост|линт(?:ер)?\w*\s+предупрежден)/i;
const BUG_REPORT = /(?:\b(?:throws?\s+(?:an?\s+)?(?:type)?error|crashes?|fails?|hangs?|drops?|loses?|duplicates?|corrupts?|leaks?)\b|\b(?:is|are)\s+(?:broken|invisible|missing|stale|wrong|incorrect|unresponsive)\b|падает|выбрасывает\s+ошибк|теряет|дублирует|повреждает|не\s+виден|устарел)/i;
const INFORMATIONAL_QUESTION = /^(?!(?:can\s+we\s+have|can\s+you|could\s+you|would\s+you)\b)(?:what|why|how|where|which|who|is|are|does|do|did|can|could|would|should|may|might|was|were)\b|^(?:почему|как|что|где|какие?|может\s+ли|можно\s+ли|является\s+ли)(?=\s|[.,!?]|$)/i;
const HISTORICAL_CONTEXT = /^(?:yesterday|last\s+(?:week|month|year)|previously|earlier|we\s+already|вчера|раньше|на\s+прошлой\s+неделе|мы\s+уже)\b/i;
const DELETE_EXPLICIT = /\b(?:delete|remove|drop)\b|удал\w*|убер(?:и|ите)\b/i;
const DELETE_DENIAL = /\b(?:do not|don't|without)\s+(?:delete|remove)\b|не\s+(?:удал\w*|убира\w*)/i;
const MUTATION_DENIAL = /(?:\bread[- ]only\b|(?:do not|don't|must not)[^.\n]{0,80}\b(?:modify|change|edit|write(?:\s+to)?|touch)\b[^.\n]{0,50}\b(?:files?|repository|repo|workspace|codebase)\b|\bwithout\s+(?:modifying|changing|editing|writing\s+to|touching)\s+(?:any\s+|the\s+)?(?:files?|repository|repo|workspace|codebase)|(?:explain|review|analy[sz]e|diagnose)\s+only\b|без\s+изменени\w*|ничего\s+не\s+меня[яй]|только\s+(?:объясни|проанализируй|проверь|диагностируй)|не\s+(?:изменяй|редактируй|трогай|записывай)[^.\n]{0,60}(?:файл|репозитор|код))/i;
const VISUAL_PREVIEW = /(?:\bui\b|\bux\b|\bcanvas\b|\bhtml\b|\bvisual\b|\bwebsite\b|\b(?:documentation|docs|interactive)\s+site\b|\bweb\s+app\b|\bdashboard\b|\bpanel\b|\bscreen\b|\bbutton\b|\bbadge\b|\bcss\b|\bstyles?\b|browser[- ]?(?:game|app)|frontend|front-end|live[- ]?preview|screenshot|responsive|visual regression|интерфейс|визуаль|в[её]рстк|превью|скриншот|адаптив|иконк|кнопк|топ[- ]?бар|панел|браузерн\w*\s+(?:игр|прилож))/i;
const PREVIEW_DENIAL = /(?:(?:may|might|will)\s+not\s+have\s+access\s+to[^.\n]{0,160}\b(?:browser|dev(?:elopment)?\s+server|vision tools?)\b|(?:do not|don't|must not|cannot|can't)\s+(?:rely\s+on\s+)?[^.\n]{0,140}\b(?:browser|dev(?:elopment)?\s+server|vision tools?|visually inspect(?:ing|ion)?)\b|(?:browser|dev(?:elopment)?\s+server|vision tools?|visual tools?)[^.\n]{0,60}\b(?:unavailable|not available|cannot be used)\b|(?:не\s+(?:используй|запускай|открывай|полагайся)|без)[^.\n]{0,140}(?:браузер|dev[- ]?server|vision|визуальн\w*\s+проверк))/i;

export function inferTaskIntent(prompt: string): TaskIntent {
	const text = prompt.trim();
	// Quoted UI text, logs, examples, and code spans are data rather than
	// authority to mutate or delete repository state.
	const actionText = text
		.replace(/`[^`]*`/gs, " ")
		.replace(/“[^”]*”|«[^»]*»|"[^"]*"/gs, " ");
	// Desired quality is not evidence of a live incident or deployment request.
	const riskText = actionText.replace(/\bproduction[-\s]ready\b/gi, "");
	const externalSourceCue = EXTERNAL_SOURCE_CUE.test(actionText);
	const needsResearch = RESEARCH.test(actionText) || externalSourceCue;
	const asksAssessment = ASSESS.test(actionText);
	const implicitRequest = IMPLICIT_REQUEST.test(actionText);
	const informationalQuestion = INFORMATIONAL_QUESTION.test(actionText.trim());
	const historicalContext = HISTORICAL_CONTEXT.test(actionText.trim());
	const approvalTrigger = APPROVAL_REQUIRED.test(riskText) && !EXTERNAL_ACTION_DENIAL.test(riskText);
	const mutationDenied = MUTATION_DENIAL.test(actionText);
	const mutationExplicit = MUTATE_ACTION.test(actionText);
	const allowsMutation = mutationExplicit && !mutationDenied;
	const allowsDeletion = allowsMutation && DELETE_EXPLICIT.test(actionText) && !DELETE_DENIAL.test(actionText);
	const previewDenied = PREVIEW_DENIAL.test(text);
	const visualContext = VISUAL_PREVIEW.test(text);
	const needsPreview = allowsMutation && visualContext && !previewDenied;
	const debugSignal = DEBUG.test(actionText);
	const bugReportSignal = BUG_REPORT.test(actionText);
	const hotfixSignal = HOTFIX.test(riskText);
	const highRiskSignal = HIGH_RISK.test(riskText);
	const buildScopeSignal = BUILD_SCOPE.test(actionText);
	const maintenanceSignal = MAINTENANCE.test(actionText)
		|| MAINTENANCE_CONTEXT.test(actionText)
		|| (DELIVERY_CONTEXT.test(actionText) && !EXTERNAL_ACTION_DENIAL.test(actionText));
	const repairSignal = allowsMutation && REPAIR_ACTION.test(actionText);
	const newCapabilitySignal = allowsMutation && NEW_CAPABILITY.test(actionText);
	const listItems = (text.match(/(^|\n)\s*(\d+[.)]|[-*•])\s+/g) ?? []).length;
	const coupled = text.length >= 220 || listItems >= 2;

	let primary: TaskKind = "trivial";
	if (allowsMutation) primary = debugSignal && !coupled && !needsResearch && !buildScopeSignal ? "debug" : "build";
	else if (needsResearch) primary = "research";
	else if (asksAssessment || debugSignal) primary = "assessment";

	let profile: WorkflowProfile;
	if (hotfixSignal && allowsMutation) profile = "hotfix";
	else if (allowsMutation && maintenanceSignal) profile = "chore";
	else if (newCapabilitySignal) profile = "feature";
	else if (repairSignal) profile = "bug";
	else if (allowsMutation && CHORE.test(actionText) && !coupled) profile = "chore";
	else if (allowsMutation) profile = "feature";
	else if (needsResearch) profile = "research";
	else profile = "assessment";

	const risk: TaskRisk = highRiskSignal ? "high" : coupled || allowsMutation ? "medium" : "low";
	const signals = [
		needsResearch && "research",
		externalSourceCue && "external-source-cue",
		asksAssessment && "assessment",
		implicitRequest && "implicit-request",
		informationalQuestion && "informational-question",
		historicalContext && "historical-context",
		allowsMutation && "mutation",
		mutationExplicit && "mutation-explicit",
		mutationDenied && "mutation-denied",
		allowsDeletion && "deletion-authorized",
		debugSignal && "debug",
		bugReportSignal && "bug-report",
		repairSignal && "repair",
		newCapabilitySignal && "new-capability",
		hotfixSignal && "hotfix",
		highRiskSignal && "high-risk",
		approvalTrigger && "approval-trigger",
		coupled && "coupled",
		buildScopeSignal && "architectural",
		maintenanceSignal && "maintenance",
		visualContext && "visual-context",
		needsPreview && "visual-preview",
		previewDenied && "preview-denied",
	].filter((value): value is string => Boolean(value));

	return {
		primary,
		profile,
		risk,
		needsResearch,
		needsPreview,
		allowsMutation,
		allowsDeletion,
		requiresPlan: allowsMutation && (coupled || risk !== "low"),
		requiresSandbox: allowsMutation && (coupled || risk === "high"),
		requiresEvaluator: allowsMutation,
		requiresHumanApproval: allowsMutation && (profile === "hotfix" || approvalTrigger),
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
