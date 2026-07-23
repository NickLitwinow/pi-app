#!/usr/bin/env node

/** Prove that a nested-project workflow ignores sibling Git changes and that
 * merely opening the saved run never starts repair/evaluator work. */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const benchDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(benchDir, "..");
const root = mkdtempSync(join(tmpdir(), "pi-workflow-scope-smoke-"));
const project = join(root, "project");
const sibling = join(root, "sibling");
const agentRoot = join(root, ".pi-agent");
const sessionRoot = join(agentRoot, "sessions");
const sessionFile = join(sessionRoot, "scope.jsonl");
mkdirSync(project, { recursive: true });
mkdirSync(sibling, { recursive: true });
mkdirSync(sessionRoot, { recursive: true });
writeFileSync(join(project, "fixture.js"), "export const value = 1;\n");
writeFileSync(join(sibling, "private.txt"), "do not touch\n");
execFileSync("git", ["init", "-q"], { cwd: root });
execFileSync("git", ["add", "."], { cwd: root });
execFileSync("git", ["-c", "user.name=pi-bench", "-c", "user.email=pi-bench@local", "commit", "-qm", "fixture"], { cwd: root });
const baseRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
writeFileSync(join(project, "fixture.js"), "export const value = 2;\n");
mkdirSync(join(project, ".pi", "extensions", "pi-permission-system"), { recursive: true });
writeFileSync(join(project, ".DS_Store"), "finder metadata");
writeFileSync(join(project, ".pi", "extensions", "pi-permission-system", "config.json"), "{}\n");
rmSync(join(sibling, "private.txt"));

const now = Date.now();
const step = (id, label, kind, status, attempts = 0, detail) => ({
	id, label, kind, deps: [], status, acceptance: "smoke", required: true,
	owner: kind === "evaluate" ? "evaluator" : kind === "review" ? "human" : kind === "gate" ? "gate-runner" : kind === "build" ? "executor" : "orchestrator",
	maxAttempts: 5, attempts, detail,
});
const legacyFailure = "Tracked pre-existing files were deleted without explicit deletion authorization: sibling/private.txt. Restore the public surface and repair drift by delegation.";
const workflow = {
	version: 3,
	runId: "wf-scope-smoke",
	createdAt: now - 1_000,
	updatedAt: now,
	objective: "Fix the nested project only.",
	intent: {
		primary: "build", profile: "bug", risk: "medium", needsResearch: false, needsPreview: false,
		allowsMutation: true, allowsDeletion: false, requiresPlan: true, requiresSandbox: false,
		requiresEvaluator: true, requiresHumanApproval: false, signals: ["mutation", "debug"],
	},
	profile: "bug",
	status: "active",
	approved: true,
	editsPending: true,
	autoLoops: 4,
	loopSignals: 0,
	contextCheckpointed: false,
	changedFiles: ["project/fixture.js", "sibling/private.txt"],
	baseRevision,
	steps: [
		step("reproduce", "Reproduce", "plan", "passed"),
		step("build", "Fix root cause", "build", "passed", 1),
		step("verify", "Regression gates", "gate", "skipped"),
		step("evaluate", "Independent evaluation", "evaluate", "failed", 4, legacyFailure),
		step("review", "Engineer review", "review", "pending"),
	],
	events: [],
};
const entries = [
	{ type: "session", version: 3, id: randomUUID(), timestamp: new Date(now).toISOString(), cwd: project },
	{ type: "custom", customType: "pi-app-workflow-state", data: workflow, id: randomUUID(), parentId: null, timestamp: new Date(now).toISOString() },
];
writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
const initialSession = readFileSync(sessionFile, "utf8");

const child = spawn("pi", [
	"--mode", "rpc", "--offline", "--no-approve", "--no-extensions",
	"--extension", join(repoRoot, "harness-extension", "index.ts"),
	"--no-skills", "--session", sessionFile, "--session-dir", sessionRoot,
], {
	cwd: project,
	stdio: ["pipe", "pipe", "pipe"],
	env: { ...process.env, PI_CODING_AGENT_DIR: agentRoot, PI_APP_HARNESS_PROFILE: "workflow", PONYTAIL_DEFAULT_MODE: "off" },
});

let buffer = "";
let stderr = "";
let latestWidget;
const response = new Promise((resolveResponse, reject) => {
	const timer = setTimeout(() => reject(new Error(`workflow scope RPC timeout: ${stderr.slice(-2_000)}`)), 60_000);
	child.stderr.on("data", (chunk) => { stderr += String(chunk); });
	child.stdout.on("data", (chunk) => {
		buffer += String(chunk);
		let newline;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			let event;
			try { event = JSON.parse(line); } catch { continue; }
			if (event.type === "extension_ui_request" && event.method === "setWidget"
				&& event.widgetKey === "pi-app-workflow-state" && Array.isArray(event.widgetLines)) {
				latestWidget = JSON.parse(event.widgetLines.join("\n"));
			}
			if (event.type !== "response" || event.id !== "scope-state") continue;
			clearTimeout(timer);
			if (!event.success) reject(new Error(event.error ?? "get_state failed"));
			else resolveResponse(event);
		}
	});
});

try {
	child.stdin.write(`${JSON.stringify({ id: "scope-state", type: "get_state" })}\n`);
	await response;
	await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	const startupEntries = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const initialEntryCount = initialSession.split("\n").filter(Boolean).length;
	assert.ok(
		startupEntries.slice(initialEntryCount).every((entry) => entry.type === "thinking_level_change"),
		"opening the session must not append workflow/evaluator state or start recovery",
	);
	assert.ok(latestWidget, "restored workflow widget was not published");
	assert.deepEqual(latestWidget.changedFiles, ["fixture.js"], "sibling paths leaked into nested-project evidence");
	assert.equal(latestWidget.steps.find((item) => item.id === "evaluate")?.status, "pending", "legacy sibling deletion failure was not cleared");
	assert.equal(latestWidget.autoLoops, 0, "legacy false repair loops were not reset");
	assert.equal(latestWidget.evaluatorTaskId, undefined);
	console.log(JSON.stringify({
		passed: true,
		startupReadOnly: true,
		workspaceScoped: true,
		changedFiles: latestWidget.changedFiles,
		evaluatorStatus: latestWidget.steps.find((item) => item.id === "evaluate")?.status,
	}));
} finally {
	child.kill("SIGTERM");
	rmSync(root, { recursive: true, force: true });
}
