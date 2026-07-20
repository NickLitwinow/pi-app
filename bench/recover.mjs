#!/usr/bin/env node

/**
 * Recover deterministic benchmark evidence from preserved fixture workspaces.
 *
 * This is intentionally read-mostly: it re-runs declared graders and reads the
 * session/diff. It cannot invent lost blind-judge output or point-in-time load,
 * and marks both fields as unavailable in the recovered report.
 *
 * Example:
 *   node bench/recover.mjs --suite long --only config-migration \
 *     --label interrupted --workspace baseline:1:/private/... \
 *     --workspace full:1:/private/...
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cpus, freemem, loadavg, platform, release, totalmem, uptime } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tasks } from "./tasks.mjs";
import { longTasks } from "./long-tasks.mjs";
import { advancedTasks } from "./advanced-tasks.mjs";

const benchDir = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const value = (name, fallback = "") => {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 ? argv[index + 1] : fallback;
};
const values = (name) => argv.flatMap((entry, index) => entry === `--${name}` ? [argv[index + 1]] : []).filter(Boolean);
const suite = value("suite", "smoke");
const taskId = value("only");
const label = value("label", "recovered");
const model = value("model", "unknown");
const thinking = value("thinking", "unknown");
const provenancePath = value("provenance");
const workspaceSpecs = values("workspace");
if (!taskId || workspaceSpecs.length === 0) {
	throw new Error("usage: recover.mjs --suite <suite> --only <task> --workspace <arm:trial:absolute-path> [...]");
}

const suiteTasks = suite === "long" ? longTasks : suite === "advanced" ? advancedTasks : suite === "all" ? [...tasks, ...longTasks, ...advancedTasks] : tasks;
const task = suiteTasks.find((candidate) => candidate.id === taskId);
if (!task) throw new Error(`Unknown ${suite} task: ${taskId}`);

function snapshot() {
	return {
		at: new Date().toISOString(),
		platform: platform(),
		release: release(),
		cpuModel: cpus()[0]?.model ?? "unknown",
		cpuCount: cpus().length,
		loadAverage: loadavg(),
		freeMemory: freemem(),
		totalMemory: totalmem(),
		uptime: uptime(),
	};
}

function parseWorkspace(spec) {
	const match = spec.match(/^([^:]+):(\d+):(\/.*)$/);
	if (!match) throw new Error(`Invalid --workspace value: ${spec}`);
	return { arm: match[1], trial: Number(match[2]), workspace: match[3] };
}

function newestSession(root) {
	const directory = join(root, ".pi", "agent", "sessions");
	return readdirSync(directory)
		.filter((file) => file.endsWith(".jsonl"))
		.map((file) => ({ path: join(directory, file), mtime: statSync(join(directory, file)).mtimeMs }))
		.sort((left, right) => right.mtime - left.mtime)[0]?.path;
}

function sessionMetrics(path) {
	const metrics = { turns: 0, toolCalls: 0, toolErrors: 0, skillReads: 0, loopScore: 0, outTokens: 0, finalCtx: 0, workflow: null, evaluatorRecords: [], checkpointRecords: 0 };
	let previousTool = "";
	for (const line of readFileSync(path, "utf8").split("\n")) {
		let entry;
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry.type === "custom" && entry.customType === "pi-app-workflow-state") metrics.workflow = entry.data;
		if (entry.type === "custom" && entry.customType === "pi-app-checkpoint") metrics.checkpointRecords++;
		if (entry.type === "custom" && ["subagents:record", "pi-app-evaluator-record"].includes(entry.customType) && entry.data?.type === "independent-evaluator") {
			metrics.evaluatorRecords.push(entry.data);
		}
		const message = entry.message;
		if (entry.type !== "message" || !message) continue;
		if (message.role === "toolResult" && message.isError) metrics.toolErrors++;
		if (message.role !== "assistant") continue;
		metrics.turns++;
		metrics.outTokens += message.usage?.output ?? 0;
		metrics.finalCtx = (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0);
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (block?.type !== "toolCall") continue;
			metrics.toolCalls++;
			const args = block.arguments ?? block.input ?? {};
			const resource = String(args.path ?? args.file_path ?? args.filePath ?? "");
			if (block.name === "read" && resource.includes("pi-bench-skills")) metrics.skillReads++;
			const signature = `${block.name}:${JSON.stringify(args)}`;
			if (signature === previousTool) metrics.loopScore++;
			previousTool = signature;
		}
	}
	return metrics;
}

function grade(root) {
	const checks = (task.criteria ?? [{ id: "check", command: task.check }]).map((criterion) => {
		try {
			execSync(criterion.command, { cwd: root, stdio: "pipe", timeout: 60_000 });
			return { id: criterion.id, kind: criterion.kind ?? "outcome", passed: true };
		} catch (error) {
			return {
				id: criterion.id,
				kind: criterion.kind ?? "outcome",
				passed: false,
				output: `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`.trim().slice(-1_000),
			};
		}
	});
	return {
		checks,
		graders: Object.fromEntries(["outcome", "static", "security"].map((kind) => {
			const rows = checks.filter((check) => check.kind === kind);
			return [kind, { score: rows.filter((check) => check.passed).length, maxScore: rows.length, passed: rows.every((check) => check.passed) }];
		})),
		score: checks.filter((check) => check.passed).length,
		maxScore: checks.length,
		success: checks.every((check) => check.passed),
	};
}

function diff(root) {
	const patch = execSync("git diff --no-ext-diff -- .", { cwd: root, encoding: "utf8" });
	const numstat = execSync("git diff --numstat", { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean);
	let insertions = 0;
	let deletions = 0;
	for (const row of numstat) {
		const [added, removed] = row.split("\t");
		if (/^\d+$/.test(added)) insertions += Number(added);
		if (/^\d+$/.test(removed)) deletions += Number(removed);
	}
	return { patch, changedFiles: numstat.length, insertions, deletions, churn: insertions + deletions };
}

const recoveredAt = new Date().toISOString();
const results = [];
const packets = [];
for (const spec of workspaceSpecs.map(parseWorkspace)) {
	const session = newestSession(spec.workspace);
	const metrics = sessionMetrics(session);
	const objective = grade(spec.workspace);
	const changed = diff(spec.workspace);
	const sessionStat = statSync(session);
	const workspaceStat = statSync(spec.workspace);
	const durationS = Math.round((sessionStat.mtimeMs - workspaceStat.birthtimeMs) / 10) / 100;
	const reviewId = `review-${createHash("sha256").update(spec.workspace).digest("hex").slice(0, 16)}`;
	const workflowCompleted = metrics.workflow
		? (metrics.workflow.steps ?? []).length > 0 && metrics.workflow.steps.every((step) => ["passed", "skipped"].includes(step.status))
		: spec.arm === "baseline" ? null : false;
	results.push({
		id: task.id,
		category: task.category ?? suite,
		arm: spec.arm,
		trial: spec.trial,
		...objective,
		durationS,
		timedOut: false,
		turns: metrics.turns,
		toolCalls: metrics.toolCalls,
		toolErrors: metrics.toolErrors,
		skillReads: metrics.skillReads,
		loopScore: metrics.loopScore,
		outTokens: metrics.outTokens,
		finalCtx: metrics.finalCtx,
		workflow: metrics.workflow,
		workflowCompleted,
		treatmentSuccess: objective.success && (spec.arm === "baseline" || workflowCompleted === true),
		evaluatorRecords: metrics.evaluatorRecords.length,
		independentEvaluator: metrics.evaluatorRecords.at(-1) ?? null,
		checkpointRecords: metrics.checkpointRecords,
		diff: { changedFiles: changed.changedFiles, insertions: changed.insertions, deletions: changed.deletions, churn: changed.churn },
		workspace: spec.workspace,
		modelJudge: { verdict: "missing", unavailableReason: "Parent process ended before final report; blind-judge stdout was not persisted." },
		humanJudge: { status: "pending-independent-review", reviewId, blindPacket: "separate-file" },
		systemBefore: { unavailable: true, reason: "Point-in-time snapshot existed only in interrupted parent memory." },
		systemAfter: { unavailable: true, reason: "Point-in-time snapshot existed only in interrupted parent memory." },
	});
	packets.push({
		reviewId,
		status: "pending-independent-review",
		rubric: ["Outcome satisfies the contract and edge cases", "Implementation is coherent and safe", "Evidence is sufficient and unmasked", "Human-facing behavior is reversible"],
		taskId: task.id,
		objective: task.prompt,
		deterministicEvidence: objective.checks,
		diff: changed.patch.slice(0, 120_000),
		reviewerFields: { verdict: "PENDING", scores: { outcome: null, coherence: null, evidence: null, uxSafety: null }, blockingFindings: [], notes: "" },
	});
}

results.sort((left, right) => left.trial - right.trial || left.arm.localeCompare(right.arm));
const armNames = [...new Set(results.map((row) => row.arm))];
const capturedProvenance = provenancePath ? JSON.parse(readFileSync(provenancePath, "utf8")) : {};
const report = {
	label,
	suite,
	date: recoveredAt,
	model,
	thinking,
	repeats: Math.max(...results.map((row) => row.trial)),
	arms: armNames.map((name) => ({ name })),
	judgeMode: "all",
	recovered: true,
	recoveryLimitations: [
		"Executor workspaces, sessions, diffs, internal evaluator records, and deterministic graders were recovered.",
		"Blind model-judge stdout and per-trial system snapshots were not persisted by the interrupted runner and are explicitly missing.",
	],
	provenance: { ...capturedProvenance, recoveredAt },
	finalSystem: snapshot(),
	passed: results.filter((row) => row.success).length,
	treatmentPassed: results.filter((row) => row.treatmentSuccess).length,
	total: results.length,
	byArm: Object.fromEntries(armNames.map((arm) => {
		const rows = results.filter((row) => row.arm === arm);
		return [arm, {
			passed: rows.filter((row) => row.success).length,
			treatmentPassed: rows.filter((row) => row.treatmentSuccess).length,
			workflowCompleted: rows.filter((row) => row.workflowCompleted === true).length,
			total: rows.length,
			meanScore: rows.reduce((sum, row) => sum + row.score / row.maxScore, 0) / rows.length,
			meanDurationS: rows.reduce((sum, row) => sum + row.durationS, 0) / rows.length,
			meanSkillReads: rows.reduce((sum, row) => sum + row.skillReads, 0) / rows.length,
		}];
	})),
	results,
};

const outputDirectory = join(benchDir, "results");
mkdirSync(outputDirectory, { recursive: true });
const stamp = recoveredAt.replace(/[:.]/g, "-");
const reportPath = join(outputDirectory, `${stamp}-${label}.json`);
const packetPath = join(outputDirectory, `${stamp}-${label}-human-review-blind.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 2));
writeFileSync(packetPath, JSON.stringify({
	label: "blind-independent-review",
	instructions: "Score without opening the paired report. Arm, trial, workspace, and order are omitted.",
	packets: packets.sort((left, right) => left.reviewId.localeCompare(right.reviewId)),
}, null, 2));
console.log(JSON.stringify({ reportPath, packetPath, passed: report.passed, total: report.total, byArm: report.byArm }, null, 2));
