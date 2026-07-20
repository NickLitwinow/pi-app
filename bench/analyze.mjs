#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const reportPath = process.argv[2];
if (!reportPath) throw new Error("usage: node bench/analyze.mjs <benchmark-report.json>");
const report = JSON.parse(readFileSync(reportPath, "utf8"));
if (!Array.isArray(report.results)) throw new Error("benchmark report has no results array");

function stats(values) {
	const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
	if (clean.length === 0) return null;
	const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
	const middle = Math.floor(clean.length / 2);
	const median = clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
	const variance = clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / clean.length;
	return { n: clean.length, mean, median, stddev: Math.sqrt(variance), min: clean[0], max: clean.at(-1) };
}

function wilson(successes, total, z = 1.959963984540054) {
	if (!total) return null;
	const p = successes / total;
	const denominator = 1 + z ** 2 / total;
	const center = (p + z ** 2 / (2 * total)) / denominator;
	const margin = z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * total)) / total) / denominator;
	return { rate: p, low95: Math.max(0, center - margin), high95: Math.min(1, center + margin) };
}

const armNames = report.arms?.map((arm) => arm.name) ?? [...new Set(report.results.map((row) => row.arm))];
const byArm = Object.fromEntries(armNames.map((arm) => {
	const rows = report.results.filter((row) => row.arm === arm);
	const successes = rows.filter((row) => row.success).length;
	const treatmentSuccesses = rows.filter((row) => row.treatmentSuccess ?? row.success).length;
	return [arm, {
		trials: rows.length,
		outcome: wilson(successes, rows.length),
		treatment: wilson(treatmentSuccesses, rows.length),
		workflowCompletion: {
			completed: rows.filter((row) => row.workflowCompleted === true).length,
			rejected: rows.filter((row) => row.workflowCompleted === false).length,
			notApplicable: rows.filter((row) => row.workflowCompleted == null).length,
		},
		scoreRate: stats(rows.map((row) => row.score / Math.max(1, row.maxScore))),
		durationS: stats(rows.map((row) => row.durationS)),
		turns: stats(rows.map((row) => row.turns)),
		toolCalls: stats(rows.map((row) => row.toolCalls)),
		skillReads: stats(rows.map((row) => row.skillReads)),
		toolErrors: stats(rows.map((row) => row.toolErrors)),
		loopScore: stats(rows.map((row) => row.loopScore)),
		outTokens: stats(rows.map((row) => row.outTokens)),
		diffChurn: stats(rows.map((row) => row.diff?.churn)),
		modelJudge: {
			pass: rows.filter((row) => row.modelJudge?.verdict === "pass" || row.modelJudge?.passed === true).length,
			fail: rows.filter((row) => row.modelJudge?.verdict === "fail" || row.modelJudge?.failed === true).length,
			missing: rows.filter((row) => !row.modelJudge || row.modelJudge?.verdict === "missing" || (!row.modelJudge?.passed && !row.modelJudge?.failed)).length,
			agreesWithDeterministic: rows.filter((row) => (
				(row.success && (row.modelJudge?.verdict === "pass" || row.modelJudge?.passed === true))
				|| (!row.success && (row.modelJudge?.verdict === "fail" || row.modelJudge?.failed === true))
			)).length,
			falsePass: rows.filter((row) => !row.success && (row.modelJudge?.verdict === "pass" || row.modelJudge?.passed === true)).length,
			falseFail: rows.filter((row) => row.success && (row.modelJudge?.verdict === "fail" || row.modelJudge?.failed === true)).length,
		},
		humanReview: {
			pending: rows.filter((row) => row.humanJudge?.status === "pending-independent-review").length,
		},
	}];
}));

const reference = armNames[0];
const comparisons = Object.fromEntries(armNames.slice(1).map((candidate) => {
	const referenceRows = new Map(report.results
		.filter((row) => row.arm === reference)
		.map((row) => [`${row.id}:${row.trial}`, row]));
	const pairs = report.results
		.filter((row) => row.arm === candidate)
		.map((row) => ({ candidate: row, reference: referenceRows.get(`${row.id}:${row.trial}`) }))
		.filter((pair) => pair.reference);
	const delta = (pick) => stats(pairs.map((pair) => pick(pair.candidate) - pick(pair.reference)));
	return [`${candidate}-vs-${reference}`, {
		pairedTrials: pairs.length,
		// Positive score delta is better; negative cost/time/churn deltas are better.
		scoreRateDelta: delta((row) => row.score / Math.max(1, row.maxScore)),
		durationDeltaS: delta((row) => row.durationS),
		toolCallDelta: delta((row) => row.toolCalls),
		skillReadDelta: delta((row) => row.skillReads ?? 0),
		toolErrorDelta: delta((row) => row.toolErrors ?? 0),
		outputTokenDelta: delta((row) => row.outTokens),
		diffChurnDelta: delta((row) => row.diff?.churn ?? 0),
		outcomeWins: pairs.filter((pair) => pair.candidate.success && !pair.reference.success).length,
		outcomeLosses: pairs.filter((pair) => !pair.candidate.success && pair.reference.success).length,
		outcomeTies: pairs.filter((pair) => pair.candidate.success === pair.reference.success).length,
		treatmentWins: pairs.filter((pair) => (pair.candidate.treatmentSuccess ?? pair.candidate.success) && !(pair.reference.treatmentSuccess ?? pair.reference.success)).length,
		treatmentLosses: pairs.filter((pair) => !(pair.candidate.treatmentSuccess ?? pair.candidate.success) && (pair.reference.treatmentSuccess ?? pair.reference.success)).length,
		treatmentTies: pairs.filter((pair) => (pair.candidate.treatmentSuccess ?? pair.candidate.success) === (pair.reference.treatmentSuccess ?? pair.reference.success)).length,
	}];
}));

report.analysis = {
	generatedAt: new Date().toISOString(),
	byArm,
	comparisons,
	caution: report.repeats < 5
		? "Fewer than five repeats: exploratory only."
		: "Small-sample estimates: inspect paired trials and blind review; do not infer population significance from the mean alone.",
};
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.analysis, null, 2));
