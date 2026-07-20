#!/usr/bin/env node

/** Validate independently scored blind packets and attach them to a benchmark. */

import { readFileSync, renameSync, writeFileSync } from "node:fs";

const [reportPath, packetPath] = process.argv.slice(2);
if (!reportPath || !packetPath) throw new Error("usage: node bench/import-human-review.mjs <report.json> <scored-blind-packets.json>");
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const packetFile = JSON.parse(readFileSync(packetPath, "utf8"));
if (!Array.isArray(report.results) || !Array.isArray(packetFile.packets)) throw new Error("invalid report or packet file");

const resultByReview = new Map(report.results.map((row) => [row.humanJudge?.reviewId, row]));
const seen = new Set();
for (const packet of packetFile.packets) {
	const id = packet.reviewId;
	if (!id || seen.has(id)) throw new Error(`missing or duplicate reviewId: ${id}`);
	seen.add(id);
	const row = resultByReview.get(id);
	if (!row) throw new Error(`packet ${id} does not belong to this report`);
	const fields = packet.reviewerFields ?? {};
	const verdict = String(fields.verdict ?? "").toUpperCase();
	if (verdict !== "PASS" && verdict !== "FAIL") throw new Error(`packet ${id} is not independently scored (verdict=${verdict || "missing"})`);
	const scores = fields.scores ?? {};
	for (const axis of ["outcome", "coherence", "evidence", "uxSafety"]) {
		const value = scores[axis];
		if (!Number.isFinite(value) || value < 0 || value > 5) throw new Error(`packet ${id} has invalid ${axis} score; expected 0..5`);
	}
	if (!Array.isArray(fields.blockingFindings)) throw new Error(`packet ${id} blockingFindings must be an array`);
	row.humanJudge = {
		status: "completed-independent-review",
		reviewId: id,
		verdict: verdict.toLowerCase(),
		scores,
		blockingFindings: fields.blockingFindings.map(String),
		notes: String(fields.notes ?? ""),
	};
}
if (seen.size !== report.results.length) throw new Error(`expected ${report.results.length} scored packets, received ${seen.size}`);

report.humanJudgeSummary = {
	importedAt: new Date().toISOString(),
	total: report.results.length,
	pass: report.results.filter((row) => row.humanJudge?.verdict === "pass").length,
	fail: report.results.filter((row) => row.humanJudge?.verdict === "fail").length,
	independent: true,
};
const temporary = `${reportPath}.tmp-${process.pid}`;
writeFileSync(temporary, JSON.stringify(report, null, 2));
renameSync(temporary, reportPath);
console.log(JSON.stringify(report.humanJudgeSummary, null, 2));
