#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-task-controls-smoke-")));
const project = join(root, "project");
const sibling = join(root, "sibling");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

try {
	git("init", "-q", ".");
	const parentBranch = git("symbolic-ref", "--short", "HEAD");
	mkdirSync(project);
	mkdirSync(sibling);
	writeFileSync(join(project, "package.json"), JSON.stringify({
		scripts: {
			test: "node -e \"const fs=require('fs');if(fs.readFileSync('value.txt','utf8').trim()!=='two')process.exit(1)\"",
		},
	}, null, 2));
	writeFileSync(join(project, "value.txt"), "one\n");
	writeFileSync(join(sibling, "notes.txt"), "clean sibling\n");
	git("add", "-A");
	git("-c", "user.name=smoke", "-c", "user.email=smoke@local", "commit", "-qm", "fixture");
	const baseSha = git("rev-parse", "HEAD");
	const branch = "agent/task-controls-smoke";
	git("switch", "-qc", branch);
	writeFileSync(join(project, "value.txt"), "two\n");
	git("add", "project/value.txt");
	git("-c", "user.name=smoke", "-c", "user.email=smoke@local", "commit", "-qm", "candidate");
	git("switch", "-q", parentBranch);
	writeFileSync(join(sibling, "notes.txt"), "unrelated parent edit\n");

	const sessionPath = join(root, ".git", "task-controls-smoke.jsonl");
	const sessionId = randomUUID();
	const taskId = "smoke-agent";
	const lines = [
		{ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: project },
		{
			type: "custom",
			customType: "pi-app-background-record",
			data: { id: taskId, type: "worker", description: "Apply verified value change", status: "completed", branch, baseSha, prompt: "Change value to two and verify it." },
			id: "task0001",
			parentId: null,
			timestamp: new Date().toISOString(),
		},
	];
	writeFileSync(sessionPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

	const child = spawn("pi", ["--mode", "rpc", "--session", sessionPath, "--offline", "-a"], {
		cwd: project,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, PI_APP_HARNESS_PROFILE: "workflow", PONYTAIL_DEFAULT_MODE: "off" },
	});
	let stdout = "";
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const response = new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`task control RPC timeout: ${stderr.slice(-2_000)}`)), 90_000);
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			let newline;
			while ((newline = stdout.indexOf("\n")) >= 0) {
				const line = stdout.slice(0, newline);
				stdout = stdout.slice(newline + 1);
				let event;
				try { event = JSON.parse(line); } catch { continue; }
				if (event.type !== "response" || event.id !== "merge") continue;
				clearTimeout(timer);
				if (!event.success) reject(new Error(event.error ?? "merge command failed"));
				else resolve(event);
			}
		});
	});
	child.stdin.write(`${JSON.stringify({ id: "merge", type: "prompt", message: `/pi-task merge ${taskId} confirmed` })}\n`);
	await response;
	child.kill("SIGTERM");

	assert.equal(readFileSync(join(project, "value.txt"), "utf8"), "two\n");
	assert.equal(readFileSync(join(sibling, "notes.txt"), "utf8"), "unrelated parent edit\n");
	assert.equal(git("status", "--porcelain", "--", "project"), "");
	assert.match(git("status", "--porcelain", "--", "sibling"), /sibling\/notes\.txt/);
	assert.equal(git("rev-list", "--parents", "-n", "1", "HEAD").split(/\s+/).length, 3, "verified integration should preserve a two-parent merge commit");
	console.log("direct task merge control smoke passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
