#!/usr/bin/env node

import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { workspaceWriteProfile } from "./macos-sandbox.mjs";

const runFile = promisify(execFile);
const stateDir = join(homedir(), ".agent-browser");
const scratch = mkdtempSync(join(tmpdir(), "pi-live-preview-browser-"));
const screenshot = join(scratch, "preview.png");
const session = `pi-app-live-preview-${process.pid}`;
const sandboxAvailable = platform() === "darwin" && existsSync("/usr/bin/sandbox-exec");
const browser = execFileSync("/usr/bin/which", ["agent-browser"], { encoding: "utf8" }).trim();
const originalBrowserArgs = process.env.AGENT_BROWSER_ARGS?.trim() ?? "";
const browserArgs = sandboxAvailable && !originalBrowserArgs
	.split(/[,\n]/)
	.some((value) => value.trim() === "--no-sandbox")
	? [originalBrowserArgs, "--no-sandbox"].filter(Boolean).join(",")
	: originalBrowserArgs;
/* Chromium cannot initialize a nested Seatbelt from the outer macOS profile.
 * Only that path disables the redundant browser layer. */
const hasOuterSandboxFlag = browserArgs
	.split(/[,\n]/)
	.some((value) => value.trim() === "--no-sandbox");

mkdirSync(stateDir, { recursive: true });

const server = createServer((_request, response) => {
	response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	response.end("<!doctype html><title>Harness preview smoke</title><main><h1>Harness live preview smoke</h1><button>Inspect me</button></main>");
});
await new Promise((resolve, reject) => {
	server.once("error", reject);
	server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("fixture server did not expose a TCP port");
const url = `http://127.0.0.1:${address.port}/`;
const profile = workspaceWriteProfile([scratch, stateDir, tmpdir(), "/tmp", "/private/tmp"]);
const env = browserArgs ? { ...process.env, AGENT_BROWSER_ARGS: browserArgs } : { ...process.env };

async function browserCommand(args, tolerateFailure = false) {
	const command = sandboxAvailable ? "/usr/bin/sandbox-exec" : browser;
	const commandArgs = sandboxAvailable ? ["-p", profile, browser, ...args] : args;
	try {
		return await runFile(command, commandArgs, {
			env,
			timeout: 60_000,
			maxBuffer: 4 * 1024 * 1024,
		});
	} catch (error) {
		if (tolerateFailure) return { stdout: "", stderr: String(error) };
		throw error;
	}
}

let result;
try {
	const opened = await browserCommand(["--session", session, "open", url]);
	const snapshot = await browserCommand(["--session", session, "snapshot", "-c", "-d", "3"]);
	const consoleOutput = await browserCommand(["--session", session, "console"]);
	const currentUrl = await browserCommand(["--session", session, "get", "url"]);
	await browserCommand(["--session", session, "screenshot", screenshot]);
	const screenshotBytes = statSync(screenshot).size;
	const passed = opened.stdout.includes(url)
		&& snapshot.stdout.includes("Harness live preview smoke")
		&& currentUrl.stdout.trim() === url
		&& screenshotBytes > 1_000;
	result = {
		passed,
		sandbox: sandboxAvailable ? "darwin-workspace-write" : "unavailable-or-disabled",
		outerSandboxBrowserFlag: sandboxAvailable ? hasOuterSandboxFlag : null,
		url,
		snapshotMatched: snapshot.stdout.includes("Harness live preview smoke"),
		consoleReadable: typeof consoleOutput.stdout === "string",
		screenshotBytes,
	};
	if (!passed) process.exitCode = 1;
} finally {
	await browserCommand(["--session", session, "close"], true);
	await new Promise((resolve) => server.close(resolve));
	rmSync(scratch, { recursive: true, force: true });
}

console.log(JSON.stringify(result, null, 2));
