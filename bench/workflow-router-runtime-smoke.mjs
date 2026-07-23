#!/usr/bin/env node

/**
 * Exercise the real Pi extension boundary, not only pure policy helpers:
 * RPC prompt -> before_agent_start -> model registry / semantic completion ->
 * persisted workflow widget. The main coding turn is aborted immediately after
 * the route is observed, so this smoke cannot modify the user's workspace.
 */

import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const benchDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(benchDir, "..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-workflow-router-runtime-")));
const agentRoot = join(root, ".pi", "agent");
mkdirSync(agentRoot, { recursive: true });
copyFileSync(join(homedir(), ".pi", "agent", "models.json"), join(agentRoot, "models.json"));
copyFileSync(join(homedir(), ".pi", "agent", "settings.json"), join(agentRoot, "settings.json"));
writeFileSync(join(root, "fixture.txt"), "router runtime smoke\n");
execFileSync("git", ["init", "-q", "."], { cwd: root });
execFileSync("git", ["add", "fixture.txt"], { cwd: root });
execFileSync(
	"git",
	["-c", "user.name=pi-smoke", "-c", "user.email=pi-smoke@local", "commit", "-qm", "fixture"],
	{ cwd: root },
);

async function routeThroughPi(id, prompt, timeoutMs = 90_000) {
	const child = spawn("pi", [
		"--mode", "rpc",
		"--offline",
		"--no-session",
		"--no-approve",
		"--no-extensions",
		"--extension", join(repoRoot, "harness-extension", "index.ts"),
		"--no-skills",
		"--provider", "ollama",
		"--model", "ThinkingCap-Qwen3.6-27B-oQ4e-M4Q-DWQ-MTP-Vision",
	], {
		cwd: root,
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentRoot,
			PI_APP_HARNESS_PROFILE: "workflow",
			PI_APP_HARNESS_ROUTER: "hybrid",
			PI_APP_HARNESS_ROUTER_TIMEOUT_MS: "60000",
			PONYTAIL_DEFAULT_MODE: "off",
		},
	});
	let stdout = "";
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += String(chunk); });
	try {
		const workflow = await new Promise((resolveWorkflow, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`${id} runtime route timeout: ${stderr.slice(-4_000)}`)),
				timeoutMs,
			);
			child.stdout.on("data", (chunk) => {
				stdout += String(chunk);
				let newline;
				while ((newline = stdout.indexOf("\n")) >= 0) {
					const line = stdout.slice(0, newline);
					stdout = stdout.slice(newline + 1);
					let event;
					try { event = JSON.parse(line); } catch { continue; }
					if (
						event.type !== "extension_ui_request"
						|| event.method !== "setWidget"
						|| event.widgetKey !== "pi-app-workflow-state"
						|| !Array.isArray(event.widgetLines)
						|| event.widgetLines.length === 0
					) continue;
					clearTimeout(timer);
					try {
						resolveWorkflow(JSON.parse(event.widgetLines.join("\n")));
					} catch (error) {
						reject(error);
					}
				}
			});
			child.stdin.write(`${JSON.stringify({ id, type: "prompt", message: prompt })}\n`);
		});
		child.stdin.write(`${JSON.stringify({ id: `${id}-abort`, type: "abort" })}\n`);
		return workflow;
	} finally {
		child.kill("SIGTERM");
		await new Promise((resolveClose) => {
			const timer = setTimeout(() => resolveClose(), 2_000);
			child.once("close", () => { clearTimeout(timer); resolveClose(); });
		});
	}
}

try {
	const explicit = await routeThroughPi(
		"explicit",
		"Build a complete procedural dungeon game in one HTML file. Include God Mode for debugging. Browser and visual tools are unavailable.",
		60_000,
	);
	assert.equal(explicit.profile, "feature");
	assert.equal(explicit.intent.allowsMutation, true);
	assert.equal(explicit.intent.needsPreview, false);
	assert.ok(explicit.intent.signals.includes("deterministic-consensus"), JSON.stringify(explicit.intent));

	const implicit = await routeThroughPi(
		"implicit",
		"The settings panel needs a timezone selector and an autosave indicator.",
	);
	assert.equal(implicit.profile, "feature");
	assert.equal(implicit.intent.allowsMutation, true);
	assert.equal(implicit.intent.needsPreview, true);
	assert.ok(implicit.intent.signals.includes("semantic-router"), JSON.stringify(implicit.intent));
	assert.ok(implicit.intent.signals.includes("semantic-primary-model"), JSON.stringify(implicit.intent));

	console.log(JSON.stringify({
		passed: true,
		explicit: {
			profile: explicit.profile,
			preview: explicit.intent.needsPreview,
			router: "deterministic-consensus",
		},
		implicit: {
			profile: implicit.profile,
			preview: implicit.intent.needsPreview,
			router: "semantic-primary-model",
		},
	}));
} finally {
	rmSync(root, { recursive: true, force: true });
}
