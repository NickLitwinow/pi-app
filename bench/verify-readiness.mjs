#!/usr/bin/env node

/**
 * Current-code readiness gate without spending local-model inference time.
 * It reruns deterministic checks and reports any retained historical long-run
 * artifacts as optional compatible evidence. Cleaned/archived historical files
 * are evidence gaps, never a reason to reject the current source and runtime.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const benchDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(benchDir, "..");
const resultsDir = join(benchDir, "results");
const evidenceOnly = process.argv.includes("--evidence-only");
const skipRust = process.argv.includes("--skip-rust");
const skipRelease = process.argv.includes("--skip-release");
const reportPath = join(resultsDir, "final-readiness-report.json");
const agentRoot = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const modelId = "ThinkingCap-Qwen3.6-27B-oQ4e-M4Q-DWQ-MTP-Vision";

mkdirSync(resultsDir, { recursive: true });

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const failures = [];
const evidenceGaps = [];
const checks = [];
const record = (id, passed, detail) => {
	checks.push({ id, passed, required: true, detail });
	if (!passed) failures.push(`${id}: ${detail}`);
};
const recordEvidence = (id, passed, detail) => {
	checks.push({ id, passed, required: false, detail });
	if (!passed) evidenceGaps.push(`${id}: ${detail}`);
};

function newestMultiTurnSession(root) {
	const found = [];
	const walk = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				let users = 0;
				for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
					try { const value = JSON.parse(line); if (value.type === "message" && value.message?.role === "user") users++; } catch { /* unusable line */ }
				}
				if (users >= 2) found.push({ path, mtime: statSync(path).mtimeMs });
			}
		}
	};
	try { walk(root); } catch { return null; }
	return found.sort((left, right) => right.mtime - left.mtime)[0]?.path ?? null;
}

function run(id, command, args) {
	const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", env: process.env });
	record(id, result.status === 0, `exit ${result.status ?? "signal"}`);
}

if (!evidenceOnly) {
	run("unit", "npm", ["test"]);
	run("web-build", "npm", ["run", "build"]);
	run("visual", "npm", ["run", "test:visual"]);
	if (!skipRust) {
		run("rust-format", "cargo", ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--check"]);
		run("rust-tests", "cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"]);
	}
	if (!skipRelease) run("tauri-release", "npm", ["run", "tauri", "build", "--", "--no-bundle"]);
	for (const [id, script] of [
		["runtime-commands", "runtime-command-smoke.mjs"],
		["task-controls", "task-controls-smoke.mjs"],
		["sandbox", "macos-sandbox-smoke.mjs"],
		["live-preview-browser-runtime", "live-preview-browser-smoke.mjs"],
		["skill-resource", "skill-resource-smoke.mjs"],
		["fixture-git", "fixture-git-smoke.mjs"],
		["schedule", "schedule-smoke.mjs"],
		["workflow-resume", "workflow-resume-smoke.mjs"],
		["workflow-workspace-scope", "workflow-workspace-scope-smoke.mjs"],
	]) run(id, process.execPath, [join(benchDir, script)]);
	const session = newestMultiTurnSession(join(agentRoot, "sessions"));
	if (session) run("same-session-rewind", process.execPath, [join(benchDir, "rewind-smoke.mjs"), session]);
	else record("same-session-rewind", false, "no multi-turn source session found");
}

try {
	const models = readJson(join(agentRoot, "models.json"));
	const settings = readJson(join(agentRoot, "settings.json"));
	const subagents = readJson(join(agentRoot, "subagents.json"));
	const ponytail = readJson(join(homedir(), ".config", "ponytail", "config.json"));
	const model = models.providers?.ollama?.models?.find((candidate) => candidate.id === modelId);
	record("model-config", Boolean(model?.reasoning && model?.input?.includes("image") && model?.contextWindow === 262144 && model?.maxTokens >= 16384), JSON.stringify(model ?? null));
	record("model-default", settings.defaultProvider === "ollama" && settings.defaultModel === modelId && settings.defaultThinkingLevel === "high", `${settings.defaultProvider}/${settings.defaultModel} thinking=${settings.defaultThinkingLevel}`);
	record("compaction-config", settings.compaction?.reserveTokens === 32768 && settings.compaction?.keepRecentTokens === 24000, JSON.stringify(settings.compaction ?? null));
	record("background-config", Number(subagents.maxConcurrent) >= 2 && subagents.schedulingEnabled === true && subagents.outputTranscript === true, JSON.stringify(subagents));
	record("ponytail-config", ponytail.defaultMode === "full" && settings.packages?.some((item) => String(item).includes("ponytail")), JSON.stringify(ponytail));
	record("live-preview-browser", settings.packages?.some((item) => String(item).includes("pi-agent-browser-native")), JSON.stringify(settings.packages ?? []));
	const productionText = ["package.json", "harness-extension/index.ts", "harness-extension/policy.ts", "harness-extension/workflow.ts"]
		.map((path) => readFileSync(join(repoRoot, path), "utf8")).join("\n");
	record("fable-retired", !/fable/i.test(productionText) && !settings.packages?.some((item) => /fable/i.test(String(item))), "no production reference");
	const agentWords = readFileSync(join(agentRoot, "AGENTS.md"), "utf8").trim().split(/\s+/).filter(Boolean).length;
	record("agent-contract", agentWords <= 450, `${agentWords} words`);
} catch (error) {
	record("production-config", false, String(error));
}

const artifacts = [
	["config-migration", "2026-07-19T16-41-15-213Z-final-postfix-config-migration.json", 9, 9],
	["ui-session-rewind", "2026-07-19T13-58-20-319Z-final-advanced-ui-session-rewind.json", 4, 4],
	["vision-workflow-extraction", "2026-07-19T14-23-40-272Z-final-advanced-vision-workflow-extraction.json", 2, 2],
	["background-worktree-merge", "2026-07-19T04-48-37-681Z-final-advanced-background-worktree-merge.json", 2, 2],
	["compaction-continuity", "2026-07-19T04-59-18-976Z-final-advanced-compaction-continuity.json", 2, 2],
	["security-path-command", "2026-07-19T19-55-13-517Z-final-untested-security-path-command-path-boundaries-v2.json", 4, 4],
];
for (const [id, name, expectedScore, expectedMax] of artifacts) {
	const path = join(resultsDir, name);
	try {
		const report = readJson(path);
		const row = report.results?.find((candidate) => candidate.id === id);
		const passed = report.model === `ollama/${modelId}` && row?.score === expectedScore && row?.maxScore === expectedMax
			&& row?.success === true && row?.treatmentSuccess === true && row?.workflowCompleted === true && row?.modelJudge?.verdict === "pass";
		recordEvidence(`historical:${id}`, passed, path);
	} catch (error) { recordEvidence(`historical:${id}`, false, `${path}: ${String(error)}`); }
}

try {
	const compact = readJson(join(resultsDir, "final-verification-logs", "live-compaction.log"));
	const passed = compact.passed === true && compact.mode === "full-compaction" && compact.sourceUnchanged === true
		&& compact.tokensBefore === 81489 && compact.estimatedTokensAfter === 41921 && compact.customRecord === true
		&& Array.isArray(compact.missingSections) && compact.missingSections.length === 0;
	recordEvidence("historical:live-compaction", passed, `${compact.tokensBefore} -> ${compact.estimatedTokensAfter}`);
} catch (error) { recordEvidence("historical:live-compaction", false, String(error)); }

try {
	const response = await fetch("http://127.0.0.1:8003/v1/models", { signal: AbortSignal.timeout(10_000) });
	const catalog = await response.json();
	const model = catalog.data?.find((candidate) => candidate.id === modelId);
	record("live-model", response.ok && Number(model?.max_model_len) >= 262144, JSON.stringify(model ?? null));
} catch (error) { record("live-model", false, String(error)); }

const report = {
	version: 2,
	generatedAt: new Date().toISOString(),
	status: failures.length === 0
		? evidenceGaps.length === 0 ? "passed-compatible-evidence" : "passed-current-checks-with-evidence-gaps"
		: "failed",
	evidenceMode: "current deterministic checks + optional historical compatible model evidence",
	exactFingerprintRerun: false,
	evidenceOnly,
	checks,
	failures,
	evidenceGaps,
	limitations: [
		"Independent human-review packets remain pending until scored by a human.",
		"Historical model artifacts are not relabeled as an exact rerun after additive lifecycle/UI changes.",
		"Missing historical artifacts remain visible as non-blocking evidence gaps; only a fresh model run can replace them.",
		"Ponytail and classifier component effects are not statistically established by one-trial ablations.",
	],
};
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\nReadiness verification: ${report.status}`);
console.log(`Report: ${reportPath}`);
if (failures.length) {
	console.error(`Failures:\n- ${failures.join("\n- ")}`);
	process.exitCode = 1;
}
if (evidenceGaps.length) console.warn(`Historical evidence gaps (non-blocking):\n- ${evidenceGaps.join("\n- ")}`);
