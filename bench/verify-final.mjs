#!/usr/bin/env node

/** Resumable high-reasoning verification for the complete pi-app harness. */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { advancedTasks } from "./advanced-tasks.mjs";

const benchDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(benchDir, "..");
const resultsDir = join(benchDir, "results");
const argv = process.argv.slice(2);
const option = (name, fallback) => {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const model = option("model", "ollama/ThinkingCap-Qwen3.6-27B-oQ4e-M4Q-DWQ-MTP-Vision");
const modelId = model.split("/").at(-1);
const statePath = resolve(option("state", join(resultsDir, "final-verification-state.json")));
const reportPath = resolve(option("report", join(resultsDir, "final-verification-report.json")));
const logDir = resolve(option("log-dir", join(resultsDir, "final-verification-logs")));
const reset = new Set(option("reset", "").split(",").map((value) => value.trim()).filter(Boolean));
const onlyStages = new Set(option("only-stages", "").split(",").map((value) => value.trim()).filter(Boolean));
const quickOnly = has("quick-only");
const continueOnFailure = has("continue-on-failure");
const sourceAgentRoot = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const expectedPonytailHead = "16f29800fd2681bdf24f3eb4ccffe38be3baec6b";

mkdirSync(resultsDir, { recursive: true });
mkdirSync(logDir, { recursive: true });
mkdirSync(dirname(statePath), { recursive: true });
mkdirSync(dirname(reportPath), { recursive: true });

function readJson(path, fallback = null) {
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function writeAtomic(path, value) {
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, JSON.stringify(value, null, 2));
	renameSync(temporary, path);
}

function hashText(value) {
	return createHash("sha256").update(value).digest("hex");
}

function readOptional(path) {
	try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function gitHead(directory) {
	try { return execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; }
}

const harnessFiles = ["index.ts", "policy.ts", "workflow.ts", "workspace.ts", "tasks.ts"];
function currentHarnessHash(joined) {
	const values = harnessFiles.map((file) => readOptional(join(repoRoot, "harness-extension", file)));
	return hashText(joined ? values.join("\n---\n") : values.join(""));
}

function currentTaskSuiteHash(reportKind) {
	const files = reportKind === "advanced" ? ["advanced-tasks.mjs"] : ["long-tasks.mjs"];
	return hashText(files.map((file) => readOptional(join(benchDir, file))).join("\n---\n"));
}

function currentCompactionInputFingerprint() {
	const paths = [
		join(benchDir, "compaction-smoke.mjs"),
		join(benchDir, "macos-sandbox.mjs"),
		...harnessFiles.map((file) => join(repoRoot, "harness-extension", file)),
		join(sourceAgentRoot, "models.json"),
		join(sourceAgentRoot, "settings.json"),
	];
	const hash = createHash("sha256");
	for (const path of paths) hash.update(path).update("\0").update(readOptional(path)).update("\0");
	hash.update(execFileSync("pi", ["--version"], { encoding: "utf8" }).trim());
	return hash.digest("hex");
}

function currentSourceFingerprint() {
	const hash = createHash("sha256");
	const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: repoRoot })
		.toString("utf8").split("\0").filter(Boolean).sort();
	for (const relative of listed) {
		const path = join(repoRoot, relative);
		if (!existsSync(path) || statSync(path).isDirectory()) continue;
		hash.update(relative).update("\0").update(readFileSync(path)).update("\0");
	}
	for (const path of [
		join(sourceAgentRoot, "models.json"),
		join(sourceAgentRoot, "settings.json"),
		join(sourceAgentRoot, "AGENTS.md"),
		join(sourceAgentRoot, "subagents.json"),
		join(homedir(), ".config", "ponytail", "config.json"),
		join(sourceAgentRoot, "git/github.com/DietrichGebert/ponytail/skills/ponytail/SKILL.md"),
		join(sourceAgentRoot, "npm/node_modules/@tintinweb/pi-subagents/src/agent-runner.ts"),
		join(sourceAgentRoot, "npm/node_modules/@tintinweb/pi-subagents/src/prompts.ts"),
	]) {
		if (existsSync(path)) hash.update(path).update("\0").update(readFileSync(path)).update("\0");
	}
	for (const directory of [
		join(sourceAgentRoot, "git/github.com/DietrichGebert/ponytail"),
	]) {
		try { hash.update(directory).update("\0").update(execFileSync("git", ["-C", directory, "rev-parse", "HEAD"])).update("\0"); } catch { /* preflight reports a missing checkout */ }
	}
	return hash.digest("hex");
}

const sourceFingerprint = currentSourceFingerprint();

const state = readJson(statePath, {
	version: 1,
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	model,
	stages: {},
});
if (state.version !== 1) throw new Error(`Unsupported verification state version in ${statePath}`);
state.model = model;
state.sourceFingerprint = sourceFingerprint;
function persistState() {
	state.updatedAt = new Date().toISOString();
	writeAtomic(statePath, state);
}

function newestUsableSession(root) {
	const found = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				const text = readFileSync(path, "utf8");
				const userMessages = text.split("\n").filter(Boolean).reduce((count, line) => {
					try {
						const entry = JSON.parse(line);
						return count + (entry.type === "message" && entry.message?.role === "user" ? 1 : 0);
					} catch { return count; }
				}, 0);
				if (userMessages >= 2) found.push({ path, time: statSync(path).mtimeMs });
			}
		}
	};
	try { walk(root); } catch { return null; }
	return found.sort((left, right) => right.time - left.time)[0]?.path ?? null;
}

function nodeStage(id, script, args = [], options = {}) {
	return { id, command: process.execPath, args: [join(benchDir, script), ...args], cwd: repoRoot, ...options };
}

function recoverableWorkflowArtifact(stageId) {
	const artifact = state.stages[stageId]?.artifact;
	const report = artifact && existsSync(artifact) ? readJson(artifact) : null;
	const row = report?.results?.find((candidate) => candidate.success && candidate.workflowCompleted !== true);
	if (!row || report.model !== model || row.treatmentAdherence?.passed !== true || !row.workspace || !existsSync(row.workspace)) return null;
	return artifact;
}

function workflowBenchmarkStage(id, args, options) {
	const artifact = recoverableWorkflowArtifact(id);
	if (!artifact) return nodeStage(id, "run.mjs", args, options);
	const prior = state.stages[id] ?? {};
	return nodeStage(id, "workflow-recovery.mjs", [artifact, "--model", model, "--thinking", "high", "--timeout", "3600", "--judge-timeout", "1800"], {
		...options,
		artifact,
		blindReview: prior.blindReview ?? null,
		recovery: "same-session-workflow",
	});
}

const quickStages = [
	{ id: "unit", command: "npm", args: ["test"], cwd: repoRoot },
	{ id: "web-build", command: "npm", args: ["run", "build"], cwd: repoRoot },
	{ id: "visual", command: "npm", args: ["run", "test:visual"], cwd: repoRoot },
	{ id: "rust-format", command: "cargo", args: ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--check"], cwd: repoRoot },
	{ id: "rust-tests", command: "cargo", args: ["test", "--manifest-path", "src-tauri/Cargo.toml"], cwd: repoRoot },
	{ id: "tauri-release", command: "npm", args: ["run", "tauri", "build", "--", "--no-bundle"], cwd: repoRoot },
	nodeStage("runtime-commands", "runtime-command-smoke.mjs"),
	nodeStage("task-controls", "task-controls-smoke.mjs"),
	nodeStage("sandbox", "macos-sandbox-smoke.mjs"),
	nodeStage("skill-resource", "skill-resource-smoke.mjs"),
	nodeStage("fixture-git", "fixture-git-smoke.mjs"),
	nodeStage("schedule", "schedule-smoke.mjs"),
	nodeStage("workflow-resume", "workflow-resume-smoke.mjs"),
];
const rewindSource = newestUsableSession(join(sourceAgentRoot, "sessions"));
quickStages.push(rewindSource
	? nodeStage("same-session-rewind", "rewind-smoke.mjs", [rewindSource])
	: { id: "same-session-rewind", internalError: `No usable session found under ${join(sourceAgentRoot, "sessions")}` });

// ThinkingCap can legitimately spend ~8 minutes per independent evaluation.
// Three evaluator/repair cycles plus the executor exceeded the historical one-hour
// wrapper by only a few minutes, so the trial budget must cover its own nested caps.
const commonBench = ["--model", model, "--thinking", "high", "--timeout", "5400", "--judge-timeout", "1800", "--repeats", "1"];
const modelStages = [
	workflowBenchmarkStage("postfix-config-migration", [
		"--suite", "long", "--only", "config-migration", "--arms", "full", "--judge", "all",
		"--label", "final-postfix-config-migration", ...commonBench,
	], { reportKind: "postfix" }),
	nodeStage("live-compaction", "compaction-smoke.mjs", [], {
		env: { PI_COMPACTION_TIMEOUT_MS: "900000" },
		inputFingerprint: currentCompactionInputFingerprint(),
	}),
	...advancedTasks.map((task) => workflowBenchmarkStage(`advanced-${task.id}`, [
		"--suite", "advanced", "--only", task.id, "--arms", "full", "--judge", "all",
		"--label", `final-advanced-${task.id}`, ...commonBench,
	], { reportKind: "advanced", expectedTask: task.id })),
	...(["full", "no-classifier", "no-repair-loop", "no-semantic-gates", "no-ponytail"].map((arm) =>
		nodeStage(`ablation-${arm}`, "run.mjs", [
			"--suite", "long", "--only", "config-migration", "--arms", arm, "--judge", "model",
			"--label", `final-ablation-${arm}`, ...commonBench,
		], { reportKind: "ablation", expectedArm: arm }))),
];

function benchmarkEvidenceError(stage, artifact) {
	const report = artifact ? readJson(artifact) : null;
	const row = report?.results?.[0];
	if (!row) return "Benchmark command exited zero but produced no readable result";
	if (stage.expectedTask && row.id !== stage.expectedTask) return `Unexpected benchmark task ${row.id}; expected ${stage.expectedTask}`;
	if (stage.expectedArm && row.arm !== stage.expectedArm) return `Unexpected benchmark arm ${row.arm}; expected ${stage.expectedArm}`;
	if (row.treatmentAdherence?.passed !== true) return "Required skill treatment adherence failed";
	if (stage.reportKind === "ablation" && !["pass", "fail"].includes(row.modelJudge?.verdict)) return "Ablation model judge is missing";
	if (stage.reportKind !== "ablation" && (!row.success || row.treatmentSuccess !== true || row.workflowCompleted !== true || row.modelJudge?.verdict !== "pass")) {
		return `Evidence rejected: score=${row.score}/${row.maxScore}, outcome=${row.success}, treatment=${row.treatmentSuccess}, workflow=${row.workflowCompleted}, judge=${row.modelJudge?.verdict ?? "missing"}`;
	}
	return null;
}

/** Reuse expensive accepted evidence after verifier/UI-only edits, but never after
 * the model, task suite, harness, Pi runtime, or Ponytail inputs changed. */
function reusableArtifact(stage, record) {
	// A failed/interrupted stage may later be repaired in-place by deterministic
	// regrade + same-session recovery. Trust the artifact only after every current
	// evidence/provenance check below passes; the stale state label is not evidence.
	if (!stage.reportKind || record?.model !== model || !record.artifact) return null;
	const report = readJson(record.artifact);
	const row = report?.results?.[0];
	const evidenceError = benchmarkEvidenceError(stage, record.artifact);
	if (evidenceError || !row || !report?.provenance) return null;
	const provenance = report.provenance;
	const mismatches = [];
	if (report.model !== model) mismatches.push("model");
	if (report.thinking !== "high") mismatches.push("thinking");
	const recoveredHarnessHash = row.workflowRecovery?.harnessHash;
	if (recoveredHarnessHash) {
		if (recoveredHarnessHash !== currentHarnessHash(false)) mismatches.push("recovery-harness");
	} else if (provenance.harnessHash !== currentHarnessHash(true)) mismatches.push("harness");
	if (provenance.taskSuiteHash !== currentTaskSuiteHash(stage.reportKind)) mismatches.push("task-suite");
	if (provenance.modelConfigHash !== hashText(readOptional(join(sourceAgentRoot, "models.json")))) mismatches.push("model-config");
	if (provenance.settingsHash !== hashText(readOptional(join(sourceAgentRoot, "settings.json")))) mismatches.push("settings");
	if (provenance.piVersion !== execFileSync("pi", ["--version"], { encoding: "utf8" }).trim()) mismatches.push("pi-version");
	if (provenance.ponytailHead !== gitHead(join(sourceAgentRoot, "git/github.com/DietrichGebert/ponytail"))) mismatches.push("ponytail");
	return mismatches.length === 0 ? { artifact: record.artifact, evidence: "accepted artifact; execution inputs unchanged" } : null;
}

/** A live compaction has no benchmark report, so validate its structured RPC
 * transcript and the exact source session. Old successful records are accepted
 * once and migrated to the component fingerprint used by subsequent runs. */
function reusableCompaction(stage, record) {
	if (stage.id !== "live-compaction" || record?.status !== "passed" || record.model !== model || !record.log) return null;
	if (record.inputFingerprint && record.inputFingerprint !== stage.inputFingerprint) return null;
	const result = readJson(record.log);
	if (!result
		|| result.passed !== true
		|| result.mode !== "full-compaction"
		|| result.startupPassed !== true
		|| result.exitCode !== 0
		|| result.sourceUnchanged !== true
		|| !result.sourceSession
		|| !existsSync(result.sourceSession)
		|| !result.sourceHashBefore
		|| result.sourceHashBefore !== result.sourceHashAfter
		|| createHash("sha256").update(readFileSync(result.sourceSession)).digest("hex") !== result.sourceHashAfter
		|| !(Number(result.tokensBefore) > 0)
		|| !result.firstKeptEntryId
		|| !(Number(result.estimatedTokensAfter) > 0)
		|| result.customRecord !== true
		|| !Array.isArray(result.missingSections)
		|| result.missingSections.length !== 0
		|| result.rpcResponse?.success !== true
		|| result.compactionError
		|| String(result.stderr ?? "").trim()) return null;
	if (platform() === "darwin" && result.sandbox !== "darwin-workspace-write") return null;
	return {
		evidence: record.inputFingerprint
			? "accepted compaction transcript; execution inputs and source session unchanged"
			: "accepted compaction transcript; migrated to component-scoped fingerprint",
		inputFingerprint: stage.inputFingerprint,
	};
}

function reusableEvidence(stage, record) {
	return reusableArtifact(stage, record) ?? reusableCompaction(stage, record);
}

function stageCommand(stage) {
	if (stage.internalError) return `[internal] ${stage.internalError}`;
	return [stage.command, ...stage.args].join(" ");
}

if (has("list")) {
	console.log(JSON.stringify({
		statePath,
		reportPath,
		model,
		onlyStages: [...onlyStages],
		quick: quickStages.map((stage) => ({ id: stage.id, command: stageCommand(stage) })),
		expensive: modelStages.map((stage) => ({
			id: stage.id,
			command: stageCommand(stage),
			reusableEvidence: reusableEvidence(stage, state.stages[stage.id])?.evidence ?? null,
		})),
	}, null, 2));
	process.exit(0);
}

function preflight() {
	const failures = [];
	const modelsConfig = readJson(join(sourceAgentRoot, "models.json"), {});
	const settings = readJson(join(sourceAgentRoot, "settings.json"), {});
	const subagents = readJson(join(sourceAgentRoot, "subagents.json"), {});
	const ponytailConfig = readJson(join(homedir(), ".config", "ponytail", "config.json"), {});
	const subagentRunnerText = readOptional(join(sourceAgentRoot, "npm/node_modules/@tintinweb/pi-subagents/src/agent-runner.ts"));
	const subagentPromptText = readOptional(join(sourceAgentRoot, "npm/node_modules/@tintinweb/pi-subagents/src/prompts.ts"));
	const agentText = existsSync(join(sourceAgentRoot, "AGENTS.md")) ? readFileSync(join(sourceAgentRoot, "AGENTS.md"), "utf8") : "";
	const agentWordCount = agentText.trim().split(/\s+/).filter(Boolean).length;
	const provider = modelsConfig.providers?.ollama;
	const configured = provider?.models?.find((item) => item.id === modelId);
	if (!configured) failures.push(`Model ${modelId} is absent from ${join(sourceAgentRoot, "models.json")}`);
	if (configured?.contextWindow !== 262144) failures.push(`contextWindow=${configured?.contextWindow}; expected 262144`);
	if ((configured?.maxTokens ?? 0) < 16384) failures.push(`maxTokens=${configured?.maxTokens}; expected at least 16384`);
	if (!configured?.reasoning) failures.push("model reasoning capability is not enabled");
	if (!configured?.input?.includes("image")) failures.push("model image input capability is not enabled");
	if (settings.defaultModel !== modelId || settings.defaultProvider !== "ollama") failures.push("ThinkingCap is not the configured Pi default");
	if (settings.defaultThinkingLevel !== "high") failures.push(`defaultThinkingLevel=${settings.defaultThinkingLevel}; expected high`);
	if (settings.compaction?.reserveTokens !== 32768 || settings.compaction?.keepRecentTokens !== 24000) failures.push("Pi compaction reserve/keep settings do not match 32768/24000");
	if (!agentText) failures.push("Global AGENTS.md is missing");
	if (agentWordCount > 450) failures.push(`Global AGENTS.md has ${agentWordCount} words; expected at most 450`);
	if (!agentText.includes("262144")) failures.push("Global AGENTS.md does not record the ThinkingCap context window");
	if (!settings.packages?.some((item) => String(item).includes("ponytail"))) failures.push("Ponytail package is not enabled");
	if (ponytailConfig.defaultMode !== "full") failures.push(`Ponytail defaultMode=${ponytailConfig.defaultMode}; expected full`);
	if (!settings.packages?.some((item) => String(item).includes("harness-extension"))) failures.push("pi-app harness extension is not enabled");
	if (!Number.isInteger(subagents.maxConcurrent) || subagents.maxConcurrent < 2) {
		failures.push(`subagent maxConcurrent=${subagents.maxConcurrent}; expected at least 2 for real background overlap`);
	}
	if (!subagentRunnerText.includes("pi-app worktree cwd rebase") || !subagentPromptText.includes("The Environment working directory below is authoritative.")) {
		failures.push("pi-subagents worktree cwd safety patch is missing; run npm run patch:pi-subagents");
	}
	const ponytailDir = join(sourceAgentRoot, "git/github.com/DietrichGebert/ponytail");
	if (!existsSync(ponytailDir)) failures.push(`Required treatment resource is missing: ${ponytailDir}`);
	const head = (directory) => {
		try { return execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; }
	};
	const ponytailHead = head(ponytailDir);
	if (ponytailHead !== expectedPonytailHead) failures.push(`Ponytail HEAD=${ponytailHead}; expected ${expectedPonytailHead}`);
	return { passed: failures.length === 0, failures, modelConfig: configured ?? null, endpoint: provider?.baseUrl ?? null, agentWordCount, subagentMaxConcurrent: subagents.maxConcurrent ?? null, ponytailMode: ponytailConfig.defaultMode ?? null, ponytailHead };
}

const preflightResult = preflight();
state.preflight = { ...preflightResult, checkedAt: new Date().toISOString() };
persistState();
if (!preflightResult.passed) {
	console.error(`Preflight failed:\n- ${preflightResult.failures.join("\n- ")}`);
	process.exit(1);
}

try {
	const response = await fetch("http://localhost:8003/v1/models", { signal: AbortSignal.timeout(10_000) });
	const catalog = await response.json();
	const live = catalog.data?.find((item) => item.id === modelId);
	if (!response.ok || !live || Number(live.max_model_len ?? 0) < 262144) throw new Error(`live model=${JSON.stringify(live)}`);
	state.preflight.liveEndpoint = { passed: true, maxModelLen: live.max_model_len, checkedAt: new Date().toISOString() };
	persistState();
} catch (error) {
	state.preflight.liveEndpoint = { passed: false, error: String(error), checkedAt: new Date().toISOString() };
	persistState();
	console.error(`Local model endpoint preflight failed: ${String(error)}`);
	process.exit(1);
}

if (has("preflight-only")) {
	console.log(JSON.stringify(state.preflight, null, 2));
	process.exit(0);
}

const lockPath = `${statePath}.lock`;
function acquireLock() {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(lockPath, "wx");
			writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), statePath }));
			closeSync(fd);
			return;
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			const prior = readJson(lockPath, {});
			let alive = false;
			if (Number.isInteger(prior.pid)) {
				try { process.kill(prior.pid, 0); alive = true; } catch { /* stale lock */ }
			}
			if (alive) throw new Error(`Final verification is already running as PID ${prior.pid}`);
			unlinkSync(lockPath);
		}
	}
}
acquireLock();
let ownsLock = true;
const releaseLock = () => {
	if (!ownsLock) return;
	ownsLock = false;
	try { unlinkSync(lockPath); } catch { /* exact lock is already gone */ }
};
process.on("exit", releaseLock);
if (platform() === "darwin" && !has("allow-sleep") && existsSync("/usr/bin/caffeinate")) {
	const wakeGuard = spawn("/usr/bin/caffeinate", ["-dimsu", "-w", String(process.pid)], { stdio: "ignore" });
	wakeGuard.unref();
	state.wakeGuard = "caffeinate -dimsu";
	persistState();
}

let activeChild = null;
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		if (activeChild?.pid) {
			try { process.kill(-activeChild.pid, "SIGTERM"); } catch { /* already stopped */ }
		}
		persistState();
		process.exit(signal === "SIGINT" ? 130 : 143);
	});
}

async function runStage(stage) {
	if (reset.has(stage.id)) delete state.stages[stage.id];
	const existingRecord = state.stages[stage.id];
	if (existingRecord?.status === "passed"
		&& existingRecord?.sourceFingerprint === sourceFingerprint
		&& existingRecord?.model === model) {
		console.log(`↷ ${stage.id} already passed`);
		return true;
	}
	const reusable = reusableEvidence(stage, existingRecord);
	if (reusable) {
		state.stages[stage.id] = {
			...existingRecord,
			sourceFingerprint,
			model,
			inputFingerprint: reusable.inputFingerprint ?? existingRecord.inputFingerprint ?? null,
			reusedAt: new Date().toISOString(),
			reuseEvidence: reusable.evidence,
		};
		persistState();
		console.log(`↷ ${stage.id} reused (${reusable.evidence})`);
		return true;
	}
	if (stage.internalError) {
		state.stages[stage.id] = { status: "failed", error: stage.internalError, completedAt: new Date().toISOString() };
		persistState();
		return false;
	}
	const priorRecord = state.stages[stage.id] ?? {};
	const logPath = join(logDir, `${stage.id}.log`);
	const startedAt = Date.now();
	state.stages[stage.id] = {
		...priorRecord,
		status: "running",
		command: stageCommand(stage),
		sourceFingerprint,
		model,
		startedAt: new Date(startedAt).toISOString(),
		log: logPath,
		artifact: stage.artifact ?? priorRecord.artifact ?? null,
		blindReview: stage.blindReview ?? priorRecord.blindReview ?? null,
		recovery: stage.recovery ?? null,
		inputFingerprint: stage.inputFingerprint ?? priorRecord.inputFingerprint ?? null,
	};
	persistState();
	console.log(`\n▶ ${stage.id}`);
	const log = createWriteStream(logPath, { flags: "w" });
	let output = "";
	const exitCode = await new Promise((resolveExit, reject) => {
		const child = spawn(stage.command, stage.args, {
			cwd: stage.cwd,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...(stage.env ?? {}) },
		});
		activeChild = child;
		const onData = (chunk) => {
			const text = String(chunk);
			process.stdout.write(text);
			log.write(text);
			output = `${output}${text}`.slice(-100_000);
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.once("error", reject);
		child.once("close", (code) => {
			activeChild = null;
			log.end();
			resolveExit(code ?? 1);
		});
	});
	const reportMatches = [...output.matchAll(/(?:отчёт|report):\s*(\/[^\n]+\.json)\s*$/gim)];
	const blindMatches = [...output.matchAll(/Blind human review:\s*(\/[^\n]+\.json)\s*$/gim)];
	const artifact = reportMatches.at(-1)?.[1]?.trim() ?? stage.artifact ?? null;
	const evidenceError = exitCode === 0 && stage.reportKind ? benchmarkEvidenceError(stage, artifact) : null;
	const stagePassed = exitCode === 0 && !evidenceError;
	state.stages[stage.id] = {
		...state.stages[stage.id],
		status: stagePassed ? "passed" : "failed",
		exitCode,
		error: evidenceError,
		completedAt: new Date().toISOString(),
		durationS: Math.round((Date.now() - startedAt) / 10) / 100,
		artifact,
		blindReview: blindMatches.at(-1)?.[1]?.trim() ?? stage.blindReview ?? priorRecord.blindReview ?? null,
		tail: output.trim().split("\n").slice(-12),
	};
	persistState();
	if (evidenceError) console.error(`\n${stage.id}: ${evidenceError}`);
	return stagePassed;
}

let commandFailures = 0;
const availableStages = [...quickStages, ...(quickOnly ? [] : modelStages)];
const knownStageIds = new Set([...quickStages, ...modelStages].map((stage) => stage.id));
const unknownOnlyStages = [...onlyStages].filter((id) => !knownStageIds.has(id));
if (unknownOnlyStages.length > 0) throw new Error(`Unknown --only-stages values: ${unknownOnlyStages.join(", ")}`);
const selectedStages = onlyStages.size > 0
	? availableStages.filter((stage) => onlyStages.has(stage.id))
	: availableStages;
if (onlyStages.size > 0 && selectedStages.length === 0) throw new Error("--only-stages selected no runnable stages");
const selectedStageIds = new Set(selectedStages.map((stage) => stage.id));
for (const [index, stage] of selectedStages.entries()) {
	console.log(`\n[${index + 1}/${selectedStages.length}] ${stage.id}`);
	const passed = await runStage(stage);
	if (!passed) {
		commandFailures++;
		if (!continueOnFailure) break;
	}
}

function inspectTrialStage(stageId, kind) {
	const record = state.stages[stageId];
	const current = Boolean(record && record.sourceFingerprint === sourceFingerprint && record.model === model);
	const report = record?.artifact ? readJson(record.artifact) : null;
	const row = report?.results?.[0];
	const findings = [];
	if (!record || !current) {
		return {
			stageId, kind, status: "pending", passed: null, findings: [],
			report: record?.artifact ?? null, blindReview: record?.blindReview ?? null, row: null,
		};
	}
	if (record.status !== "passed") findings.push(`stage ${record.status}${record.error ? `: ${record.error}` : ""}`);
	if (!report || !row) findings.push("benchmark report/result missing");
	else {
		if (kind !== "ablation" && !row.success) findings.push(`deterministic outcome ${row.score}/${row.maxScore}`);
		if (kind !== "ablation" && row.treatmentSuccess !== true) findings.push("treatment workflow was not accepted");
		if (kind !== "ablation" && row.workflowCompleted !== true) findings.push("persisted workflow did not complete");
		if (kind !== "ablation" && row.modelJudge?.verdict !== "pass") findings.push(`model judge=${row.modelJudge?.verdict ?? "missing"}`);
		if (kind === "ablation" && !row.arm) findings.push("ablation arm missing");
		if (kind === "ablation" && !["pass", "fail"].includes(row.modelJudge?.verdict)) findings.push("ablation model judge missing");
		if (row.treatmentAdherence?.passed !== true) findings.push("skill treatment adherence failed or missing");
	}
	return {
		stageId, kind, status: findings.length === 0 ? "passed" : "failed", passed: findings.length === 0, findings,
		report: record?.artifact ?? null, blindReview: record?.blindReview ?? null,
		row: row ? {
			id: row.id, arm: row.arm, score: row.score, maxScore: row.maxScore,
			scoreRate: row.score / Math.max(1, row.maxScore), success: row.success,
			treatmentSuccess: row.treatmentSuccess, treatmentAdherence: row.treatmentAdherence ?? null,
			workflowCompleted: row.workflowCompleted, modelJudge: row.modelJudge?.verdict ?? "missing",
			durationS: row.durationS, toolCalls: row.toolCalls, toolErrors: row.toolErrors,
			outTokens: row.outTokens, skillReads: row.skillReads, diffChurn: row.diff?.churn ?? null,
		} : null,
	};
}

const trialChecks = [];
if (!quickOnly) {
	if (selectedStageIds.has("postfix-config-migration")) trialChecks.push(inspectTrialStage("postfix-config-migration", "postfix"));
	for (const task of advancedTasks) {
		const stageId = `advanced-${task.id}`;
		if (selectedStageIds.has(stageId)) trialChecks.push(inspectTrialStage(stageId, "advanced"));
	}
	for (const arm of ["full", "no-classifier", "no-repair-loop", "no-semantic-gates", "no-ponytail"]) {
		const stageId = `ablation-${arm}`;
		if (selectedStageIds.has(stageId)) trialChecks.push(inspectTrialStage(stageId, "ablation"));
	}
}
const failedStages = Object.entries(state.stages)
	.filter(([id, value]) => selectedStageIds.has(id)
		&& value.sourceFingerprint === sourceFingerprint
		&& value.model === model
		&& value.status !== "passed")
	.map(([id, value]) => ({ id, status: value.status, exitCode: value.exitCode ?? null, error: value.error ?? null }));
const hardFindings = [
	...failedStages.map((item) => `stage ${item.id}: ${item.status}`),
	...trialChecks.filter((item) => item.passed === false).map((item) => `${item.stageId}: ${item.findings.join("; ")}`),
];
const currentStageRecords = selectedStages.map((stage) => ({ stage, record: state.stages[stage.id] }))
	.filter(({ record }) => record?.sourceFingerprint === sourceFingerprint && record?.model === model);
const pendingStages = selectedStages
	.filter((stage) => {
		const record = state.stages[stage.id];
		return !record || record.sourceFingerprint !== sourceFingerprint || record.model !== model;
	})
	.map((stage) => stage.id);
const pendingTrialChecks = trialChecks.filter((item) => item.passed === null).map((item) => item.stageId);
const blindReviews = trialChecks.map((item) => item.blindReview).filter(Boolean);
const ablationRows = trialChecks.filter((item) => item.kind === "ablation" && item.row).map((item) => item.row);
const ablationReference = ablationRows.find((row) => row.arm === "full");
const ablationAnalysis = ablationReference ? Object.fromEntries(ablationRows.map((row) => [row.arm, {
	scoreRate: row.scoreRate,
	scoreRateDeltaVsFull: row.scoreRate - ablationReference.scoreRate,
	success: row.success,
	treatmentSuccess: row.treatmentSuccess,
	workflowCompleted: row.workflowCompleted,
	modelJudge: row.modelJudge,
	durationS: row.durationS,
	durationDeltaVsFullS: row.durationS - ablationReference.durationS,
	toolCalls: row.toolCalls,
	toolCallDeltaVsFull: row.toolCalls - ablationReference.toolCalls,
	toolErrors: row.toolErrors,
	outTokens: row.outTokens,
	diffChurn: row.diffChurn,
	diffChurnDeltaVsFull: row.diffChurn - ablationReference.diffChurn,
}])) : null;
const finalReport = {
	version: 1,
	generatedAt: new Date().toISOString(),
	status: hardFindings.length > 0
		? "failed"
		: pendingStages.length > 0 || pendingTrialChecks.length > 0
			? "incomplete"
			: blindReviews.length > 0 ? "passed-pending-human-review" : "passed",
	quickOnly,
	onlyStages: [...onlyStages],
	model,
	sourceFingerprint,
	state: statePath,
	preflight: state.preflight,
	stageCounts: {
		total: selectedStages.length,
		passed: currentStageRecords.filter(({ record }) => record.status === "passed").length,
		failed: currentStageRecords.filter(({ record }) => record.status !== "passed").length,
		pending: pendingStages.length,
	},
	hardFindings,
	pendingStages,
	pendingTrialChecks,
	trialChecks,
	ablationAnalysis,
	independentHumanReview: {
		status: blindReviews.length > 0 ? "pending-independent-review" : "not-generated",
		packets: blindReviews,
		importCommand: "node bench/import-human-review.mjs <benchmark-report.json> <completed-blind-review.json>",
	},
};
writeAtomic(reportPath, finalReport);
state.finalReport = reportPath;
state.finalStatus = finalReport.status;
persistState();

console.log(`\nFinal verification: ${finalReport.status}`);
console.log(`State: ${statePath}`);
console.log(`Report: ${reportPath}`);
if (hardFindings.length > 0) console.error(`Blocking findings:\n- ${hardFindings.join("\n- ")}`);
if (pendingStages.length > 0) console.log(`Pending after fail-fast: ${pendingStages.join(", ")}`);
if (blindReviews.length > 0) console.log(`Independent human review remains intentionally pending (${blindReviews.length} packet files).`);
if (commandFailures > 0 || hardFindings.length > 0 || finalReport.status === "incomplete") process.exitCode = 1;
