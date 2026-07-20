#!/usr/bin/env node

/** Re-run current deterministic graders against preserved benchmark workspaces. */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tasks } from "./tasks.mjs";
import { longTasks } from "./long-tasks.mjs";
import { advancedTasks } from "./advanced-tasks.mjs";
import { materializeTaskVerifierManifest } from "./task-verifiers.mjs";

const benchDir = dirname(fileURLToPath(import.meta.url));
const reportPath = process.argv[2] ? resolve(process.argv[2]) : null;
if (!reportPath) throw new Error("usage: node bench/regrade-report.mjs <report.json>");
const report = JSON.parse(readFileSync(reportPath, "utf8"));
if (!Array.isArray(report.results)) throw new Error("benchmark report has no results array");
const taskById = new Map([...tasks, ...longTasks, ...advancedTasks].map((task) => [task.id, task]));

function writeAtomic(path, value) {
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, JSON.stringify(value, null, 2));
	renameSync(temporary, path);
}

function grade(task, cwd) {
	const checks = (task.criteria ?? [{ id: "check", command: task.check }]).map((criterion) => {
		try {
			execSync(criterion.command, { cwd, stdio: "pipe", timeout: 60_000 });
			return { id: criterion.id, kind: criterion.kind ?? "outcome", passed: true };
		} catch (error) {
			return { id: criterion.id, kind: criterion.kind ?? "outcome", passed: false, output: `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`.trim().slice(-1_000) };
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

let changed = 0;
for (const row of report.results) {
	const task = taskById.get(row.id);
	if (!task || !row.workspace || !existsSync(row.workspace)) continue;
	materializeTaskVerifierManifest(row.workspace, task);
	const prior = JSON.stringify({ checks: row.checks, score: row.score, maxScore: row.maxScore, success: row.success });
	Object.assign(row, grade(task, row.workspace));
	const current = JSON.stringify({ checks: row.checks, score: row.score, maxScore: row.maxScore, success: row.success });
	if (prior !== current) {
		changed++;
		row.modelJudge = {
			verdict: "missing",
			unavailableReason: "Deterministic evidence changed after a grader correction; the prior judgment was invalidated.",
		};
	}
	row.treatmentSuccess = Boolean(row.success && row.treatmentAdherence?.passed !== false && (row.arm === "baseline" || row.workflowCompleted === true));
}

report.passed = report.results.filter((row) => row.success).length;
report.treatmentPassed = report.results.filter((row) => row.treatmentSuccess).length;
for (const [arm, summary] of Object.entries(report.byArm ?? {})) {
	const rows = report.results.filter((row) => row.arm === arm);
	summary.passed = rows.filter((row) => row.success).length;
	summary.treatmentPassed = rows.filter((row) => row.treatmentSuccess).length;
	summary.workflowCompleted = rows.filter((row) => row.workflowCompleted === true).length;
}
const suiteFile = report.suite === "advanced" ? "advanced-tasks.mjs" : report.suite === "long" ? "long-tasks.mjs" : "tasks.mjs";
const taskSuiteHash = createHash("sha256").update(readFileSync(join(benchDir, suiteFile))).digest("hex");
const previousTaskSuiteHash = report.provenance?.taskSuiteHash ?? null;
report.provenance = { ...(report.provenance ?? {}), taskSuiteHash };
report.regrade = { at: new Date().toISOString(), changed, previousTaskSuiteHash, taskSuiteHash };
writeAtomic(reportPath, report);

const reviewPath = reportPath.replace(/\.json$/, "-human-review-blind.json");
if (existsSync(reviewPath)) {
	const review = JSON.parse(readFileSync(reviewPath, "utf8"));
	for (const packet of review.packets ?? []) {
		const row = report.results.find((candidate) => candidate.humanJudge?.reviewId === packet.reviewId);
		if (row) packet.deterministicEvidence = row.checks;
	}
	writeAtomic(reviewPath, review);
}

console.log(JSON.stringify({ report: reportPath, changed, passed: report.passed, total: report.total, taskSuiteHash }, null, 2));
if (report.results.some((row) => !row.success)) process.exitCode = 1;
