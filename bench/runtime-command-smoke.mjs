#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxedPiCommand } from "./macos-sandbox.mjs";

const required = [
	"pi-rewind",
	"pi-workflow",
	"pi-task",
	"pi-branch-return",
	"ponytail",
	"ponytail-review",
	"ponytail-audit",
	"skill:ponytail",
	"skill:ponytail-review",
	"skill:ponytail-audit",
];

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-runtime-command-smoke-")));
const scratch = join(cwd, ".pi", "tmp");
mkdirSync(scratch, { recursive: true });
// Force Pi's normal project-trust lookup instead of testing only a workspace
// without local resources (which never touches trust.json.lock).
writeFileSync(join(cwd, ".pi", "settings.json"), "{}\n");
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const runtimeState = [
  "settings.json.lock",
  "auth.json",
  "auth.json.lock",
  "models-store.json",
  "models-store.json.lock",
  "trust.json",
  "trust.json.lock",
  "mcp-cache.json",
  "mcp-npx-cache.json",
  "mcp-onboarding.json",
  "mcp-oauth",
].map((name) => join(agentDir, name));
// Keep the normal project-trust path enabled. Pi 0.81+ takes a trust.json.lock
// even for read-only trust lookup, so --no-approve would hide a broken sandbox
// allowlist and let the exact app-start regression escape this smoke test.
const invocation = sandboxedPiCommand(["--mode", "rpc", "--no-session", "--offline"], repoRoot, true, cwd, [], runtimeState);
const child = spawn(invocation.command, invocation.args, {
	cwd,
	stdio: ["pipe", "pipe", "pipe"],
	env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
});
let buffer = "";
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });

const result = await new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error(`RPC timeout: ${stderr.slice(-1_000)}`)), 30_000);
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let newline;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			let event;
			try { event = JSON.parse(line); } catch { continue; }
			if (event.type !== "response" || event.id !== "commands") continue;
			clearTimeout(timer);
			if (!event.success) reject(new Error(event.error ?? "get_commands failed"));
			else resolve(event.data);
		}
	});
	child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
});

child.kill("SIGTERM");
rmSync(cwd, { recursive: true, force: true });
const names = (result.commands ?? []).map((command) => command.name);
const missing = required.filter((name) => !names.includes(name));
if (missing.length > 0) throw new Error(`Missing runtime commands: ${missing.join(", ")}\nLoaded: ${names.join(", ")}\n${stderr.slice(-4_000)}`);
console.log(JSON.stringify({ passed: true, commandCount: names.length, required }));
