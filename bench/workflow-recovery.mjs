#!/usr/bin/env node

/** Complete an interrupted same-session workflow, then refresh its blind judge. */

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const benchDir = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const report = argv[0] ? resolve(argv[0]) : null;
const option = (name, fallback) => {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 ? argv[index + 1] : fallback;
};
if (!report) throw new Error("usage: node bench/workflow-recovery.mjs <report.json> [--model provider/id]");
const model = option("model", "ollama/ThinkingCap-Qwen3.6-27B-oQ4e-DWQ-MTP-Vision");
const thinking = option("thinking", "high");
const timeout = option("timeout", "3600");
const judgeTimeout = option("judge-timeout", "1800");

async function run(script, args) {
	const code = await new Promise((resolveExit, reject) => {
		const child = spawn(process.execPath, [join(benchDir, script), ...args], { stdio: "inherit" });
		child.once("error", reject);
		child.once("close", (value) => resolveExit(value ?? 1));
	});
	if (code !== 0) throw new Error(`${script} exited ${code}`);
}

await run("resume-workflow.mjs", [report, "--model", model, "--thinking", thinking, "--timeout", timeout]);
await run("model-judge-replay.mjs", [report, "--model", model, "--thinking", thinking, "--timeout", judgeTimeout, "--retry-failed"]);
console.log(`workflow recovery complete: ${report}`);
