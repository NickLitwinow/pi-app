#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxedPiCommand } from "./macos-sandbox.mjs";

const benchDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(benchDir, "..");
const sourceAgentRoot = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const timeoutMs = Number(process.env.PI_COMPACTION_TIMEOUT_MS ?? 600_000);
const thinking = process.env.PI_COMPACTION_THINKING ?? "high";
const startupOnly = process.env.PI_COMPACTION_STARTUP_ONLY === "1";

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walkJsonl(root) {
	const files = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...walkJsonl(path));
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
	}
	return files;
}

function selectSourceSession() {
	const explicit = process.env.PI_COMPACTION_SOURCE;
	if (explicit) return resolve(explicit);
	return walkJsonl(join(sourceAgentRoot, "sessions"))
		.map((path) => ({ path, text: readFileSync(path, "utf8"), size: statSync(path).size }))
		.filter(({ text }) => (text.match(/"role":"user"/g)?.length ?? 0) >= 3 && !text.includes('"type":"compaction"'))
		.sort((left, right) => right.size - left.size)[0]?.path;
}

const sourceSession = selectSourceSession();
if (!sourceSession || !existsSync(sourceSession)) throw new Error("No uncompacted source session with at least three user turns was found");
const sourceHashBefore = sha256(sourceSession);

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-compaction-smoke-")));
const agentRoot = join(root, ".pi", "agent");
const sessionRoot = join(agentRoot, "sessions");
const sessionFile = join(sessionRoot, "compaction-smoke.jsonl");
mkdirSync(sessionRoot, { recursive: true });
for (const file of ["models.json", "auth.json"]) {
	if (existsSync(join(sourceAgentRoot, file))) cpSync(join(sourceAgentRoot, file), join(agentRoot, file));
}
writeFileSync(join(agentRoot, "settings.json"), JSON.stringify({
	defaultProvider: "ollama",
	defaultModel: "ThinkingCap-Qwen3.6-27B-oQ4e-M4Q-DWQ-MTP-Vision",
	defaultThinkingLevel: thinking,
	packages: [],
	compaction: { enabled: true, reserveTokens: 32768, keepRecentTokens: 24000 },
}, null, 2));
cpSync(sourceSession, sessionFile);

const args = [
	"--mode", "rpc",
	"--no-approve",
	"--no-extensions",
	"--extension", join(repoRoot, "harness-extension", "index.ts"),
	"--no-skills",
	"--no-context-files",
	"--session", sessionFile,
	"--session-dir", sessionRoot,
	"--model", "ollama/ThinkingCap-Qwen3.6-27B-oQ4e-M4Q-DWQ-MTP-Vision",
	"--thinking", thinking,
];
const invocation = sandboxedPiCommand(args, repoRoot, true, root);
mkdirSync(join(root, ".pi", "tmp"), { recursive: true });
const child = spawn(invocation.command, invocation.args, {
	cwd: root,
	detached: true,
	stdio: ["pipe", "pipe", "pipe"],
	env: {
		...process.env,
		PI_CODING_AGENT_DIR: agentRoot,
		TMPDIR: join(root, ".pi", "tmp"),
		TMP: join(root, ".pi", "tmp"),
		TEMP: join(root, ".pi", "tmp"),
		PI_APP_HARNESS_PROFILE: "workflow",
		PI_RETRY_STALL_TIMEOUT_MS: "0",
	},
});

let stdout = "";
let stderr = "";
let buffer = "";
let compactResponse = null;
let compactionEnd = null;
let startupResponse = null;
const compactCommand = {
	id: "compact-smoke",
	type: "compact",
	customInstructions: "Preserve the objective, constraints, completed and pending work, verification evidence, changed files, and exact next step. The Markdown result must contain these exact headings: ## Goal, ## Progress, ## Key Decisions, ## Next Steps.",
};
child.stdout.on("data", (chunk) => {
	const text = String(chunk);
	stdout += text;
	buffer += text;
	let newline;
	while ((newline = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, newline).replace(/\r$/, "");
		buffer = buffer.slice(newline + 1);
		let event;
		try { event = JSON.parse(line); } catch { continue; }
		if (event.type === "compaction_end") compactionEnd = event;
		if (event.type === "response" && event.command === "get_state" && event.id === "compaction-startup") {
			startupResponse = event;
			if (!event.success || /EPERM:.*settings\.json\.lock/i.test(stderr)) child.stdin.end();
			else if (startupOnly) child.stdin.end();
			else child.stdin.write(`${JSON.stringify(compactCommand)}\n`);
		}
		if (event.type === "response" && event.command === "compact" && event.id === "compact-smoke") {
			compactResponse = event;
			child.stdin.end();
		}
	}
});
child.stderr.on("data", (chunk) => { stderr += String(chunk); });

const exitCode = await new Promise((resolveExit, reject) => {
	const timer = setTimeout(() => {
		try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
		reject(new Error(`Compaction timed out after ${timeoutMs}ms\n${stderr.slice(-4000)}`));
	}, timeoutMs);
	child.once("error", reject);
	child.once("close", (code) => {
		clearTimeout(timer);
		resolveExit(code);
	});
	child.stdin.write(`${JSON.stringify({ id: "compaction-startup", type: "get_state" })}\n`);
});

const sessionText = readFileSync(sessionFile, "utf8");
const entries = sessionText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
const compaction = [...entries].reverse().find((entry) => entry.type === "compaction");
const record = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === "pi-app-compaction-record");
const summary = String(compaction?.summary ?? compactResponse?.data?.summary ?? "");
const requiredSections = ["## Goal", "## Progress", "## Key Decisions", "## Next Steps"];
const missingSections = requiredSections.filter((section) => !summary.includes(section));
const sourceHashAfter = sha256(sourceSession);
const startupPassed = Boolean(startupResponse?.success && !/EPERM:.*settings\.json\.lock/i.test(stderr));
const passed = startupOnly
	? Boolean(startupPassed && exitCode === 0 && sourceHashAfter === sourceHashBefore)
	: Boolean(
		startupPassed
		&& compactResponse?.success
		&& compactionEnd?.result
		&& compaction
		&& record
		&& Number(compaction.tokensBefore) > 0
		&& compaction.firstKeptEntryId
		&& sourceHashAfter === sourceHashBefore
		&& missingSections.length === 0,
	);
const keepFixture = process.env.PI_COMPACTION_KEEP_FIXTURE === "1" || !passed;
const result = {
	passed,
	mode: startupOnly ? "startup-only" : "full-compaction",
	startupPassed,
	thinking,
	exitCode,
	sandbox: invocation.mode,
	sourceSession,
	sourceUnchanged: sourceHashAfter === sourceHashBefore,
	sourceHashBefore,
	sourceHashAfter,
	isolatedSession: keepFixture ? sessionFile : null,
	fixtureRetained: keepFixture,
	tokensBefore: compaction?.tokensBefore ?? null,
	firstKeptEntryId: compaction?.firstKeptEntryId ?? null,
	estimatedTokensAfter: compactResponse?.data?.estimatedTokensAfter ?? null,
	customRecord: Boolean(record),
	missingSections,
	summaryPreview: summary.slice(0, 1000),
	protocolTail: stdout.trim().split("\n").slice(-4),
	rpcResponse: compactResponse ? { success: compactResponse.success, error: compactResponse.error ?? null } : null,
	compactionError: compactionEnd?.errorMessage ?? null,
	stderr: stderr.slice(-2000),
};
console.log(JSON.stringify(result, null, 2));
if (!keepFixture) rmSync(root, { recursive: true, force: true });
if (!passed) process.exitCode = 1;
