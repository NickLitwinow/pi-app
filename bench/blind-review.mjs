#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { tasks } from "./tasks.mjs";
import { longTasks } from "./long-tasks.mjs";
import { advancedTasks } from "./advanced-tasks.mjs";

const reportPath = process.argv[2];
if (!reportPath) throw new Error("usage: node bench/blind-review.mjs <benchmark-report.json>");

const report = JSON.parse(readFileSync(reportPath, "utf8"));
if (!Array.isArray(report.results)) throw new Error("benchmark report has no results array");
const tasksById = new Map([...tasks, ...longTasks, ...advancedTasks].map((task) => [task.id, task]));

function hash(value) {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function gitDiff(cwd) {
	try {
		return execFileSync("git", ["diff", "--no-ext-diff", "--", "."], {
			cwd,
			encoding: "utf8",
			maxBuffer: 2 * 1024 * 1024,
		}).slice(0, 120_000);
	} catch (error) {
		return `DIFF UNAVAILABLE: ${String(error?.message ?? error).slice(0, 1_000)}`;
	}
}

const packets = report.results.map((result, index) => {
	const reviewId = result.humanJudge?.reviewId ?? `review-${hash(`${report.date}-${index}-${result.workspace}`)}`;
	result.humanJudge = {
		status: "pending-independent-review",
		reviewId,
		blindPacket: "separate-file",
	};
	return {
		reviewId,
		status: "pending-independent-review",
		rubric: [
			"Does the observable outcome satisfy the original request, including implicit edge cases?",
			"Is the implementation coherent, safe, and appropriately scoped?",
			"Is the verification evidence sufficient and free of masked failures?",
			"Are UI/UX or human-facing behaviors understandable and reversible?",
		],
		taskId: result.id,
		objective: tasksById.get(result.id)?.prompt ?? "Objective unavailable; use taskId and deterministic evidence.",
		imageFiles: tasksById.get(result.id)?.imageFiles ?? [],
		deterministicEvidence: result.checks,
		diff: gitDiff(result.workspace),
		reviewerFields: {
			verdict: "PENDING",
			scores: { outcome: null, coherence: null, evidence: null, uxSafety: null },
			blockingFindings: [],
			notes: "",
		},
	};
}).sort((left, right) => left.reviewId.localeCompare(right.reviewId));

const extension = extname(reportPath);
const stem = basename(reportPath, extension);
const blindPath = join(dirname(reportPath), `${stem}-human-review-blind${extension}`);
writeFileSync(reportPath, JSON.stringify(report, null, 2));
writeFileSync(blindPath, JSON.stringify({
	label: "blind-independent-review",
	instructions: "Score packets without opening the paired benchmark report. Arm, trial, workspace, and scheduling order are intentionally omitted.",
	packets,
}, null, 2));
console.log(JSON.stringify({ passed: true, reportPath, blindPath, packets: packets.length }));
