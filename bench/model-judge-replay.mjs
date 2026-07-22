#!/usr/bin/env node

/** Resume missing blind model judgments from preserved benchmark workspaces. */

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tasks } from "./tasks.mjs";
import { longTasks } from "./long-tasks.mjs";
import { advancedTasks } from "./advanced-tasks.mjs";
import { sandboxedReadOnlyPiCommand } from "./macos-sandbox.mjs";

const benchDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(benchDir);
const argv = process.argv.slice(2);
const reportPath = argv[0];
const option = (name, fallback) => {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 ? argv[index + 1] : fallback;
};
if (!reportPath) throw new Error("usage: node bench/model-judge-replay.mjs <report.json> [--model provider/id] [--thinking high] [--timeout 1800]");

const model = option("model", "ollama/ThinkingCap-Qwen3.6-27B-oQ4e-M4Q-DWQ-MTP-Vision");
const thinking = option("thinking", "high");
const timeoutS = Math.max(30, Number(option("timeout", "1800")) || 1_800);
const retryFailed = argv.includes("--retry-failed");
const sourceAgentRoot = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const taskById = new Map([...tasks, ...longTasks, ...advancedTasks].map((task) => [task.id, task]));
const report = JSON.parse(readFileSync(reportPath, "utf8"));
if (!Array.isArray(report.results)) throw new Error("benchmark report has no results array");

function writeAtomic() {
	const temporary = `${reportPath}.tmp-${process.pid}`;
	writeFileSync(temporary, JSON.stringify(report, null, 2));
	renameSync(temporary, reportPath);
}

function needsJudge(row) {
	return !row.modelJudge || row.modelJudge.verdict === "missing" || row.modelJudge.unavailableReason || (retryFailed && row.modelJudge.verdict === "fail");
}

async function judge(row) {
	const task = taskById.get(row.id);
	if (!task) throw new Error(`Unknown task ${row.id}`);
	if (!row.workspace || !existsSync(row.workspace)) throw new Error(`Preserved workspace unavailable: ${row.workspace}`);

	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-model-judge-replay-")));
	const blindWorkspace = join(scratch, "target");
	const judgeAgentRoot = join(scratch, "agent");
	cpSync(row.workspace, blindWorkspace, { recursive: true });
	// Hide treatment/session artifacts while retaining the committed fixture and
	// uncommitted implementation diff the judge must inspect.
	rmSync(join(blindWorkspace, ".pi"), { recursive: true, force: true });
	rmSync(join(blindWorkspace, ".git", "pi-bench-skills"), { recursive: true, force: true });
	mkdirSync(judgeAgentRoot, { recursive: true });
	for (const file of ["models.json", "auth.json"]) {
		if (existsSync(join(sourceAgentRoot, file))) cpSync(join(sourceAgentRoot, file), join(judgeAgentRoot, file));
	}
	const [provider, modelId] = model.includes("/") ? model.split(/\/(.+)/) : ["ollama", model];
	writeFileSync(join(judgeAgentRoot, "settings.json"), JSON.stringify({
		defaultProvider: provider,
		defaultModel: modelId,
		defaultThinkingLevel: thinking,
		packages: [],
	}, null, 2));

	const prompt = [
		"You are an independent read-only judge. Inspect the actual repository and judge the original contract, hidden-risk boundaries, regressions, and security.",
		"Do not modify files. Deterministic verification results are supplied below; inspect source with read-only tools and do not trust the executor's final prose.",
		`Original task:\n${task.prompt}`,
		`Deterministic grader results:\n${JSON.stringify(row.checks ?? [], null, 2)}`,
		"End with exactly JUDGE: PASS or JUDGE: FAIL and concise evidence.",
	].join("\n\n");
	const piArgs = ["-a", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--tools", "read,grep,find,ls", "--thinking", thinking, "--model", model, "-p", prompt];
	const invocation = sandboxedReadOnlyPiCommand(piArgs, repoRoot, [blindWorkspace], scratch);
	const started = Date.now();
	try {
		const run = await new Promise((resolve) => {
			const child = spawn(invocation.command, invocation.args, {
				cwd: blindWorkspace,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
				env: { ...process.env, PI_CODING_AGENT_DIR: judgeAgentRoot, PONYTAIL_DEFAULT_MODE: "off", TMPDIR: scratch, TMP: scratch, TEMP: scratch },
			});
			let output = "";
			child.stdout.on("data", (chunk) => { output += chunk; });
			child.stderr.on("data", (chunk) => { output += chunk; });
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
			}, timeoutS * 1_000);
			child.on("close", (exitCode) => {
				clearTimeout(timer);
				resolve({ output: output.trim(), timedOut, exitCode });
			});
		});
		const verdicts = [...run.output.matchAll(/\bJUDGE\s*:\s*(PASS|FAIL)\b/gi)];
		const verdict = verdicts.at(-1)?.[1]?.toLowerCase() ?? "missing";
		return {
			passed: verdict === "pass",
			failed: verdict === "fail",
			verdict,
			timedOut: run.timedOut,
			exitCode: run.exitCode,
			durationS: Math.round((Date.now() - started) / 10) / 100,
			sandbox: invocation.mode,
			replayed: true,
			output: run.output.slice(-8_000),
		};
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

const missing = report.results.filter(needsJudge);
console.log(`model-judge replay: ${missing.length} missing verdict(s)`);
for (const row of missing) {
	process.stdout.write(`▶ ${row.id} trial ${row.trial} … `);
	try {
		row.modelJudge = await judge(row);
		console.log(`${row.modelJudge.verdict.toUpperCase()} ${row.modelJudge.durationS}s`);
	} catch (error) {
		row.modelJudge = { verdict: "missing", replayed: true, error: String(error) };
		console.log(`ERROR ${String(error)}`);
	}
	report.modelJudgeReplay = { updatedAt: new Date().toISOString(), model, thinking, timeoutS, completed: report.results.filter((row) => !needsJudge(row)).length, total: report.results.length };
	writeAtomic();
}
report.modelJudgeReplay = {
	updatedAt: new Date().toISOString(),
	model,
	thinking,
	timeoutS,
	completed: report.results.filter((row) => !needsJudge(row)).length,
	total: report.results.length,
};
writeAtomic();
console.log(JSON.stringify(report.modelJudgeReplay, null, 2));
if (report.results.some(needsJudge)) process.exitCode = 1;
