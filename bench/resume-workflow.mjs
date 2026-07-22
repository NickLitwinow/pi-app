#!/usr/bin/env node

/** Resume an interrupted in-harness evaluator from its existing Pi session. */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxedPiCommand } from "./macos-sandbox.mjs";

const benchDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(benchDir, "..");
const argv = process.argv.slice(2);
const reportPath = argv[0] ? resolve(argv[0]) : null;
const option = (name, fallback) => {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 ? argv[index + 1] : fallback;
};
if (!reportPath) throw new Error("usage: node bench/resume-workflow.mjs <report.json> [--model provider/id] [--thinking high] [--timeout 3600]");

const model = option("model", "ollama/ThinkingCap-Qwen3.6-27B-oQ4e-M4Q-DWQ-MTP-Vision");
const thinking = option("thinking", "high");
const timeoutMs = Math.max(60_000, Number(option("timeout", "3600")) * 1_000 || 3_600_000);
const sourceAgentRoot = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const row = report.results?.find((candidate) => candidate.success && candidate.workflowCompleted !== true && candidate.workspace && existsSync(candidate.workspace));
if (!row) throw new Error("No successful outcome with an interrupted/rejected workflow and preserved workspace was found");

const workspace = resolve(row.workspace);
const agentRoot = join(workspace, ".pi", "agent");
const sessionRoot = join(agentRoot, "sessions");
const scratchRoot = join(workspace, ".pi", "tmp");
mkdirSync(scratchRoot, { recursive: true });

function newestSession(root) {
	return readdirSync(root)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => ({ path: join(root, name), time: statSync(join(root, name)).mtimeMs }))
		.sort((left, right) => right.time - left.time)[0]?.path;
}

function latestWorkflow(path) {
	let workflow = null;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry.type === "custom" && entry.customType === "pi-app-workflow-state" && entry.data?.version === 3) workflow = entry.data;
	}
	if (!workflow) return null;
	return {
		runId: workflow.runId,
		profile: workflow.profile,
		approved: workflow.approved,
		autoLoops: workflow.autoLoops ?? 0,
		loopSignals: workflow.loopSignals ?? 0,
		changedFiles: workflow.changedFiles ?? [],
		steps: (workflow.steps ?? []).map(({ id, status, attempts }) => ({ id, status, attempts })),
	};
}

function harnessHash() {
	const hash = createHash("sha256");
	for (const file of ["index.ts", "policy.ts", "workflow.ts", "workspace.ts"]) hash.update(readFileSync(join(repoRoot, "harness-extension", file)));
	return hash.digest("hex");
}

function writeAtomic() {
	const temporary = `${reportPath}.tmp-${process.pid}`;
	writeFileSync(temporary, JSON.stringify(report, null, 2));
	renameSync(temporary, reportPath);
}

const sessionFile = newestSession(sessionRoot);
if (!sessionFile) throw new Error(`No Pi session found in ${sessionRoot}`);
const activeSkill = row.skillResource?.targetSkill && existsSync(row.skillResource.targetSkill) ? row.skillResource.targetSkill : null;
const piArgs = [
	"--mode", "rpc",
	"--no-approve",
	"--no-extensions",
	"--extension", join(repoRoot, "harness-extension", "index.ts"),
	"--extension", join(sourceAgentRoot, "git/github.com/DietrichGebert/ponytail/pi-extension/index.js"),
	"--extension", join(sourceAgentRoot, "npm/node_modules/@tintinweb/pi-subagents/src/index.ts"),
	"--no-skills",
	"--session", sessionFile,
	"--session-dir", sessionRoot,
	"--thinking", thinking,
	"--model", model,
];
if (activeSkill) piArgs.push("--skill", activeSkill);
const invocation = sandboxedPiCommand(piArgs, repoRoot, true, workspace, activeSkill ? [dirname(activeSkill)] : []);
const startedAt = Date.now();
const child = spawn(invocation.command, invocation.args, {
	cwd: workspace,
	detached: true,
	stdio: ["pipe", "pipe", "pipe"],
	env: {
		...process.env,
		PI_CODING_AGENT_DIR: agentRoot,
		TMPDIR: scratchRoot,
		TMP: scratchRoot,
		TEMP: scratchRoot,
		PI_APP_HARNESS_PROFILE: "workflow",
		PI_APP_HARNESS_LOG: "1",
		PI_APP_HARNESS_EVALUATOR_TIMEOUT_MS: String(Math.min(timeoutMs, 1_800_000)),
		PI_APP_HARNESS_REPAIR_TIMEOUT_MS: String(Math.min(timeoutMs, 1_800_000)),
		PI_RETRY_STALL_TIMEOUT_MS: "0",
		PONYTAIL_DEFAULT_MODE: row.arm === "no-ponytail" ? "off" : "full",
	},
});

let buffer = "";
let output = "";
let response = null;
child.stdout.on("data", (chunk) => {
	const text = String(chunk);
	process.stdout.write(text);
	output = `${output}${text}`.slice(-80_000);
	buffer += text;
	let newline;
	while ((newline = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, newline).replace(/\r$/, "");
		buffer = buffer.slice(newline + 1);
		let event;
		try { event = JSON.parse(line); } catch { continue; }
		if (event.type === "response" && event.id === "resume-workflow") response = event;
	}
});
child.stderr.on("data", (chunk) => {
	const text = String(chunk);
	process.stderr.write(text);
	output = `${output}${text}`.slice(-80_000);
});

let timedOut = false;
const exitCode = await new Promise((resolveExit, reject) => {
	let poll;
	const timer = setTimeout(() => {
		timedOut = true;
		try { process.kill(-child.pid, "SIGKILL"); } catch { /* already stopped */ }
	}, timeoutMs);
	child.once("error", (error) => {
		clearTimeout(timer);
		if (poll) clearInterval(poll);
		reject(error);
	});
	child.once("close", (code) => {
		clearTimeout(timer);
		if (poll) clearInterval(poll);
		resolveExit(code ?? 1);
	});
	child.stdin.write(`${JSON.stringify({ id: "resume-workflow", type: "prompt", message: "/pi-workflow retry-gates" })}\n`);
	poll = setInterval(() => {
		if (!response) return;
		clearInterval(poll);
		child.stdin.end();
	}, 250);
});

const workflow = latestWorkflow(sessionFile);
const workflowCompleted = Boolean(workflow?.steps?.length && workflow.steps.every((step) => ["passed", "skipped"].includes(step.status)));
row.workflow = workflow;
row.workflowCompleted = workflowCompleted;
row.treatmentSuccess = Boolean(row.success && row.treatmentAdherence?.passed !== false && workflowCompleted);
row.workflowRecovery = {
	at: new Date().toISOString(),
	durationS: Math.round((Date.now() - startedAt) / 10) / 100,
	model,
	thinking,
	harnessHash: harnessHash(),
	sessionFile,
	sameSession: true,
	sandbox: invocation.mode,
	commandAccepted: response?.success === true,
	exitCode,
	timedOut,
	outputTail: output.trim().split("\n").slice(-20),
};
report.treatmentPassed = report.results.filter((candidate) => candidate.treatmentSuccess).length;
if (report.byArm?.[row.arm]) {
	report.byArm[row.arm].treatmentPassed = report.results.filter((candidate) => candidate.arm === row.arm && candidate.treatmentSuccess).length;
	report.byArm[row.arm].workflowCompleted = report.results.filter((candidate) => candidate.arm === row.arm && candidate.workflowCompleted).length;
}
report.workflowRecovery = { updatedAt: new Date().toISOString(), recovered: workflowCompleted ? 1 : 0, attempted: 1 };
writeAtomic();

console.log(JSON.stringify({ report: reportPath, workflowCompleted, treatmentSuccess: row.treatmentSuccess, workflow, recovery: row.workflowRecovery }, null, 2));
if (!workflowCompleted || !row.treatmentSuccess) process.exitCode = 1;
