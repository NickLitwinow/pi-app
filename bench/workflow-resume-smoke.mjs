#!/usr/bin/env node

/** Prove parser-upgrade recovery inside one existing Pi session, without a model turn. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const benchDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(benchDir, "..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-workflow-resume-smoke-")));
const agentRoot = join(root, ".pi", "agent");
const sessionRoot = join(agentRoot, "sessions");
const sessionFile = join(sessionRoot, "resume.jsonl");
mkdirSync(sessionRoot, { recursive: true });
execFileSync("git", ["init", "-q", "."], { cwd: root });

const now = Date.now();
const acceptedWithoutCeremonialMarker = [
	"CLAUSE C1: PASS",
	"CLAUSE C2: PASS",
	"CLAUSE C3: PASS",
	"CLAUSE C4: PASS",
	"CLAUSE C5: PASS",
	"CLAUSE C6: PASS",
	"CLAUSE C7: PASS",
	"CLAUSE C8: PASS",
	"BLOCKING: NONE",
	"VERDICT: PASS",
].join("\n");
const baseStep = (id, label, kind, status, attempts = 0) => ({
	id, label, kind, deps: [], status, acceptance: "smoke", required: true, attempts,
});
const workflow = {
	version: 3,
	runId: "wf-resume-smoke",
	createdAt: now - 1_000,
	updatedAt: now,
	objective: "Fix the fixture and verify it.",
	intent: {
		primary: "build", profile: "bug", risk: "medium", needsResearch: false,
		allowsMutation: true, allowsDeletion: false, requiresPlan: true,
		requiresSandbox: false, requiresEvaluator: true, requiresHumanApproval: false,
		signals: ["mutation", "debug"],
	},
	profile: "bug",
	approved: true,
	editsPending: true,
	autoLoops: 1,
	loopSignals: 0,
	contextCheckpointed: false,
	changedFiles: ["fixture.js"],
	evaluatorTaskId: "eval-interrupted",
	steps: [
		baseStep("reproduce", "Reproduce", "plan", "passed"),
		baseStep("build", "Fix root cause", "build", "passed", 1),
		{ ...baseStep("verify:test", "Tests", "gate", "passed", 1), command: "node --test" },
		baseStep("evaluate", "Independent evaluation", "evaluate", "running", 2),
		baseStep("review", "Engineer review", "review", "pending"),
	],
	events: [],
};
const entries = [
	{ type: "session", version: 3, id: randomUUID(), timestamp: new Date(now).toISOString(), cwd: root },
	{
		type: "custom", customType: "pi-app-evaluator-record",
		data: { id: "eval-replayable", type: "independent-evaluator", description: "stored quorum review", status: "completed", result: acceptedWithoutCeremonialMarker, evaluatorProtocolVersion: 2, evaluatorQuorum: true, startedAt: now - 900, completedAt: now - 500 },
		id: "entry-evaluator", parentId: null, timestamp: new Date(now - 500).toISOString(),
	},
	{
		type: "custom", customType: "pi-app-evaluator-record",
		data: { id: "eval-legacy-single", type: "independent-evaluator", description: "legacy single review", status: "completed", result: acceptedWithoutCeremonialMarker, startedAt: now - 450, completedAt: now - 425 },
		id: "entry-legacy", parentId: "entry-evaluator", timestamp: new Date(now - 425).toISOString(),
	},
	{
		type: "custom", customType: "pi-app-evaluator-record",
		data: { id: "eval-failed-quorum", type: "independent-evaluator", description: "malformed falsifier", status: "failed", result: `PRIMARY EVALUATOR:\n${acceptedWithoutCeremonialMarker}\n\nCOUNTEREXAMPLE FALSIFIER:\nno protocol`, evaluatorProtocolVersion: 2, evaluatorQuorum: true, startedAt: now - 420, completedAt: now - 410 },
		id: "entry-failed-quorum", parentId: "entry-legacy", timestamp: new Date(now - 410).toISOString(),
	},
	{
		type: "custom", customType: "pi-app-background-record",
		data: { id: "eval-interrupted", type: "independent-evaluator", description: "interrupted review", status: "running", startedAt: now - 400 },
		id: "entry-interrupted", parentId: "entry-failed-quorum", timestamp: new Date(now - 400).toISOString(),
	},
	{
		type: "custom", customType: "pi-app-workflow-state", data: workflow,
		id: "entry-workflow", parentId: "entry-interrupted", timestamp: new Date(now).toISOString(),
	},
];
writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
const initialSessionText = readFileSync(sessionFile, "utf8");

const child = spawn("pi", [
	"--mode", "rpc", "--offline", "--no-approve", "--no-extensions",
	"--extension", join(repoRoot, "harness-extension", "index.ts"),
	"--no-skills", "--session", sessionFile, "--session-dir", sessionRoot,
], {
	cwd: root,
	stdio: ["pipe", "pipe", "pipe"],
	env: { ...process.env, PI_CODING_AGENT_DIR: agentRoot, PI_APP_HARNESS_PROFILE: "workflow", PONYTAIL_DEFAULT_MODE: "off" },
});

async function freshSessionWorkflowWidgetCount() {
	const fresh = spawn("pi", [
		"--mode", "rpc", "--offline", "--no-approve", "--no-extensions",
		"--extension", join(repoRoot, "harness-extension", "index.ts"),
		"--no-skills", "--no-session",
	], {
		cwd: root,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, PI_CODING_AGENT_DIR: agentRoot, PI_APP_HARNESS_PROFILE: "workflow", PONYTAIL_DEFAULT_MODE: "off" },
	});
	let freshBuffer = "";
	let freshStderr = "";
	let widgets = 0;
	const complete = new Promise((resolveComplete, reject) => {
		const timer = setTimeout(() => reject(new Error(`fresh workflow RPC timeout: ${freshStderr.slice(-2_000)}`)), 60_000);
		fresh.stderr.on("data", (chunk) => { freshStderr += String(chunk); });
		fresh.stdout.on("data", (chunk) => {
			freshBuffer += String(chunk);
			let newline;
			while ((newline = freshBuffer.indexOf("\n")) >= 0) {
				const line = freshBuffer.slice(0, newline);
				freshBuffer = freshBuffer.slice(newline + 1);
				let event;
				try { event = JSON.parse(line); } catch { continue; }
				if (event.type === "extension_ui_request" && event.method === "setWidget"
					&& event.widgetKey === "pi-app-workflow-state" && Array.isArray(event.widgetLines)) widgets++;
				if (event.type !== "response" || event.id !== "fresh-state") continue;
				clearTimeout(timer);
				resolveComplete();
			}
		});
	});
	try {
		fresh.stdin.write(`${JSON.stringify({ id: "fresh-state", type: "get_state" })}\n`);
		await complete;
		return widgets;
	} finally {
		fresh.kill("SIGTERM");
	}
}

let buffer = "";
let stderr = "";
const workflowWidgets = [];
let resolveStartup;
let rejectStartup;
const startupResponse = new Promise((resolve, reject) => {
	resolveStartup = resolve;
	rejectStartup = reject;
});
const response = new Promise((resolveResponse, reject) => {
	const timer = setTimeout(() => reject(new Error(`workflow resume RPC timeout: ${stderr.slice(-2_000)}`)), 60_000);
	const startupTimer = setTimeout(() => rejectStartup(new Error(`workflow startup RPC timeout: ${stderr.slice(-2_000)}`)), 60_000);
	child.stderr.on("data", (chunk) => { stderr += String(chunk); });
	child.stdout.on("data", (chunk) => {
		buffer += String(chunk);
		let newline;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			let event;
			try { event = JSON.parse(line); } catch { continue; }
			if (event.type === "extension_ui_request" && event.method === "setWidget" && event.widgetKey === "pi-app-workflow-state") {
				const text = Array.isArray(event.widgetLines) ? event.widgetLines.join("\n") : "";
				if (text) workflowWidgets.push(JSON.parse(text));
			}
			if (event.type === "response" && event.id === "startup-state") {
				clearTimeout(startupTimer);
				if (!event.success) rejectStartup(new Error(event.error ?? "startup get_state failed"));
				else resolveStartup(event);
				continue;
			}
			if (event.type !== "response" || event.id !== "resume-smoke") continue;
			clearTimeout(timer);
			clearTimeout(startupTimer);
			if (!event.success) reject(new Error(event.error ?? "retry-gates failed"));
			else resolveResponse(event);
		}
	});
});

try {
	child.stdin.write(`${JSON.stringify({ id: "startup-state", type: "get_state" })}\n`);
	await startupResponse;
	const startupEntries = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const initialEntryCount = initialSessionText.split("\n").filter(Boolean).length;
	assert.ok(
		startupEntries.slice(initialEntryCount).every((entry) => entry.type === "thinking_level_change"),
		"opening a saved session must not append workflow/evaluator state or start recovery",
	);
	child.stdin.write(`${JSON.stringify({ id: "resume-smoke", type: "prompt", message: "/pi-workflow retry-gates" })}\n`);
	await response;
	child.stdin.end();
	await new Promise((resolveClose) => {
		const timer = setTimeout(() => { child.kill("SIGTERM"); resolveClose(); }, 5_000);
		child.once("close", () => { clearTimeout(timer); resolveClose(); });
	});
	const files = readdirSync(sessionRoot).filter((name) => name.endsWith(".jsonl"));
	const saved = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const latest = [...saved].reverse().find((entry) => entry.customType === "pi-app-workflow-state")?.data;
	const replay = [...saved].reverse().find((entry) => entry.customType === "pi-app-evaluator-replay-record")?.data;
	assert.deepEqual(files, ["resume.jsonl"], "recovery must not create another session");
	assert.ok(latest?.steps?.every((step) => ["passed", "skipped"].includes(step.status)), JSON.stringify(latest));
	assert.equal(latest.status, "completed", "restored legacy workflow must derive a completed run lifecycle");
	assert.ok(latest.steps.every((step) => step.owner && step.maxAttempts > 0), "legacy steps must be upgraded with owner and retry budget");
	assert.match(latest.terminationReason, /Every required workflow step/);
	assert.equal(latest.editsPending, false);
	assert.equal(replay?.evaluatorTaskId, "eval-replayable");
	assert.ok(workflowWidgets.length > 0, "restored workflow must be published to the RPC UI");
	assert.ok(workflowWidgets.every((item) => item.runId === workflow.runId && item.objective === workflow.objective), "RPC UI must never receive a synthetic empty workflow");
	assert.equal(await freshSessionWorkflowWidgetCount(), 0, "a fresh session must not publish an empty assessment workflow before the first prompt");
	console.log(JSON.stringify({ passed: true, sameSession: true, startupReadOnly: true, status: latest.status, lifecycleUpgraded: true, rpcWorkflowSynchronized: true, freshSessionEmpty: true, evaluatorTaskId: replay.evaluatorTaskId }));
} finally {
	if (child.exitCode == null) child.kill("SIGTERM");
	rmSync(root, { recursive: true, force: true });
}
