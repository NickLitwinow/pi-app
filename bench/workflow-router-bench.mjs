import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inferTaskIntent } from "../harness-extension/policy.ts";
import {
	mergeSemanticRoute,
	parseSemanticRoute,
	SEMANTIC_ROUTER_SYSTEM_PROMPT,
	shouldUseSemanticRouter,
} from "../harness-extension/semantic-router-policy.ts";
import {
	deterministicRouterScenarios,
	routerScenarios,
	semanticAmbiguityScenarios,
} from "./router-scenarios.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = new Set(process.argv.slice(2));
const hybrid = args.has("--hybrid");
const withLlm = args.has("--llm") || hybrid;
const baseUrl = process.env.PI_APP_ROUTER_BASE_URL ?? "http://127.0.0.1:8003/v1";
const modelOverride = process.env.PI_APP_ROUTER_MODEL;
const timeoutMs = Math.max(5_000, Number(process.env.PI_APP_ROUTER_TIMEOUT_MS ?? 30_000) || 30_000);
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
const repeatsArg = process.argv.find((arg) => arg.startsWith("--repeats="));
const suiteArg = process.argv.find((arg) => arg.startsWith("--suite="));
const repeats = Math.max(1, Number(repeatsArg?.split("=")[1] ?? 1) || 1);
const only = new Set(onlyArg?.slice("--only=".length).split(",").filter(Boolean) ?? []);
const suite = suiteArg?.split("=")[1] ?? (withLlm ? "all" : "deterministic");
const suiteScenarios = suite === "ambiguous"
	? semanticAmbiguityScenarios
	: suite === "deterministic"
		? deterministicRouterScenarios
		: routerScenarios;
const selectedScenarios = only.size > 0 ? suiteScenarios.filter((scenario) => only.has(scenario.id)) : suiteScenarios;
const scenarios = selectedScenarios.slice(0, limitArg ? Math.max(1, Number(limitArg.split("=")[1]) || 1) : undefined);

function mismatches(intent, expected) {
	const failures = [];
	if (intent.profile !== expected.profile) failures.push(`profile ${intent.profile} != ${expected.profile}`);
	if (intent.allowsMutation !== expected.mutation) failures.push(`mutation ${intent.allowsMutation} != ${expected.mutation}`);
	if (expected.preview != null && intent.needsPreview !== expected.preview) failures.push(`preview ${intent.needsPreview} != ${expected.preview}`);
	if (expected.research != null && intent.needsResearch !== expected.research) failures.push(`research ${intent.needsResearch} != ${expected.research}`);
	if (expected.deletion != null && intent.allowsDeletion !== expected.deletion) failures.push(`deletion ${intent.allowsDeletion} != ${expected.deletion}`);
	if (expected.approval != null && intent.requiresHumanApproval !== expected.approval) failures.push(`approval ${intent.requiresHumanApproval} != ${expected.approval}`);
	return failures;
}

async function selectedModel() {
	if (modelOverride) return modelOverride;
	const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) throw new Error(`models endpoint returned ${response.status}`);
	const body = await response.json();
	const ids = Array.isArray(body.data) ? body.data.map((item) => item?.id).filter(Boolean) : [];
	return ids.find((id) => id.includes("ThinkingCap-Qwen3.6-27B") && id.includes("Vision"))
		?? ids.find((id) => id.includes("ThinkingCap-Qwen3.6-27B"))
		?? ids[0]
		?? (() => { throw new Error("No model is available"); })();
}

async function semanticDecision(model, prompt) {
	const startedAt = Date.now();
	const response = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: "Bearer sk-local" },
		signal: AbortSignal.timeout(timeoutMs),
		body: JSON.stringify({
			model,
			temperature: 0,
			max_tokens: 192,
			stream: false,
			chat_template_kwargs: { enable_thinking: false },
			messages: [
				{ role: "system", content: SEMANTIC_ROUTER_SYSTEM_PROMPT },
				{ role: "user", content: prompt },
			],
		}),
	});
	if (!response.ok) throw new Error(`router HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
	const body = await response.json();
	const text = body?.choices?.[0]?.message?.content;
	if (typeof text !== "string") throw new Error("router response has no text content");
	return { route: parseSemanticRoute(text), latencyMs: Date.now() - startedAt, raw: text.slice(0, 1_000) };
}

const model = withLlm ? await selectedModel() : undefined;
const rows = [];
const trials = scenarios.flatMap((scenario) => Array.from({ length: repeats }, (_, trial) => ({ scenario, trial: trial + 1 })));
for (let index = 0; index < trials.length; index++) {
	const { scenario, trial } = trials[index];
	const fallback = inferTaskIntent(scenario.prompt);
	let intent = fallback;
	let semantic;
	let latencyMs = 0;
	let error;
	const semanticRequested = withLlm && (!hybrid || shouldUseSemanticRouter(fallback, "hybrid"));
	if (semanticRequested) {
		try {
			const result = await semanticDecision(model, scenario.prompt);
			semantic = result.route;
			latencyMs = result.latencyMs;
			if (!semantic) error = `invalid semantic JSON: ${result.raw}`;
			else intent = semantic.confidence >= 0.55 ? mergeSemanticRoute(fallback, semantic) : fallback;
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		}
	}
	const failures = mismatches(intent, scenario.expect);
	rows.push({
		id: scenario.id,
		trial,
		expected: scenario.expect,
		actual: {
			profile: intent.profile,
			mutation: intent.allowsMutation,
			preview: intent.needsPreview,
			research: intent.needsResearch,
			deletion: intent.allowsDeletion,
			approval: intent.requiresHumanApproval,
		},
		semantic,
		routedBy: semanticRequested ? "semantic" : "deterministic-consensus",
		latencyMs,
		error,
		failures,
	});
	const mark = failures.length === 0 ? "✓" : "✗";
	process.stdout.write(`[${index + 1}/${trials.length}] ${mark} ${scenario.id}${repeats > 1 ? ` · trial ${trial}` : ""}${failures.length ? ` — ${failures.join("; ")}` : ""}${error ? ` — ${error}` : ""}\n`);
}

const failed = rows.filter((row) => row.failures.length > 0 || row.error);
const latencies = rows.map((row) => row.latencyMs).filter((value) => value > 0).sort((a, b) => a - b);
const report = {
	version: 1,
	at: new Date().toISOString(),
	mode: hybrid ? "runtime-hybrid" : withLlm ? "semantic-hybrid" : "deterministic",
	model,
	scenarioCount: scenarios.length,
	repeats,
	total: rows.length,
	passed: rows.length - failed.length,
	failed: failed.length,
	accuracy: rows.length ? (rows.length - failed.length) / rows.length : 0,
	invalidResponses: rows.filter((row) => row.error).length,
	latencyMs: latencies.length ? {
		min: latencies[0],
		median: latencies[Math.floor(latencies.length / 2)],
		p95: latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))],
		max: latencies.at(-1),
		total: latencies.reduce((sum, value) => sum + value, 0),
	} : undefined,
	rows,
};
const resultsDir = join(root, "bench", "results");
mkdirSync(resultsDir, { recursive: true });
const modelSlug = model ? model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) : "";
const modeSlug = hybrid ? `runtime-hybrid-${modelSlug}` : withLlm ? `semantic-${modelSlug}` : "deterministic";
const selectedIdsSlug = [...only].sort().join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80);
const scopeSlug = only.size > 0
	? `targeted-${selectedIdsSlug}`
	: !withLlm && suite === "deterministic"
		? "contract"
		: suite;
const timestampSlug = report.at.replace(/[:.]/g, "-");
const reportPath = join(resultsDir, `workflow-router-${modeSlug}-${scopeSlug}-${timestampSlug}.json`);
const latestPath = join(resultsDir, `workflow-router-${modeSlug}-${scopeSlug}-latest.json`);
const reportText = `${JSON.stringify(report, null, 2)}\n`;
writeFileSync(reportPath, reportText);
writeFileSync(latestPath, reportText);
// Keep the original canonical name for consumers that predate scoped reports,
// but only a complete all-scenario run may update it.
if (only.size === 0 && (suite === "all" || (!withLlm && suite === "deterministic"))) {
	writeFileSync(join(resultsDir, `workflow-router-${modeSlug}-latest.json`), reportText);
}
console.log(JSON.stringify({ ...report, rows: undefined, reportPath, latestPath }, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;
