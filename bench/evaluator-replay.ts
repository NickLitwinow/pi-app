#!/usr/bin/env -S vite-node

/** Replay the production evaluator protocol against a preserved workspace. */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndependentEvaluatorPrompt, independentEvaluationAccepted, parseIndependentVerdict } from "../harness-extension/policy";
import { longTasks } from "./long-tasks.mjs";
import { sandboxedReadOnlyPiCommand } from "./macos-sandbox.mjs";

const benchDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(benchDir);
const argv = process.argv.slice(2);
const option = (name: string, fallback = "") => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};

const workspace = option("workspace");
const taskId = option("only", "config-migration");
const model = option("model", "ollama/ThinkingCap-Qwen3.6-27B-oQ4e-M4Q-DWQ-MTP-Vision");
const thinking = option("thinking", "high");
const timeoutS = Math.max(30, Number(option("timeout", "1800")) || 1_800);
const label = option("label", "evaluator-replay");
if (!workspace.startsWith("/")) throw new Error("--workspace must be an absolute preserved fixture path");
const task = longTasks.find((candidate) => candidate.id === taskId);
if (!task) throw new Error(`Unknown long task: ${taskId}`);

const diff = spawnSyncText("git", ["diff", "--no-ext-diff", "--", "."], workspace);
const prompt = buildIndependentEvaluatorPrompt({
  objective: task.prompt,
  profile: "feature",
  changedFiles: diffChangedFiles(diff),
  evidence: "Project verifier `npm test`: passed (exit 0). This proves only the visible suite.",
  diff,
});

const args = [
  "-a",
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-context-files",
  "--tools",
  "read,grep,find,ls",
  "--thinking",
  thinking,
  "--model",
  model,
  "-p",
  prompt,
];
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-evaluator-replay-")));
const invocation = sandboxedReadOnlyPiCommand(args, repoRoot, [workspace], scratch);
const startedAt = new Date().toISOString();
const started = Date.now();
const result = await run(invocation.command, invocation.args, workspace, timeoutS * 1_000, scratch);
const verdict = parseIndependentVerdict(result.output) ?? "missing";
const accepted = independentEvaluationAccepted(result.output);
const report = {
  label,
  taskId,
  workspace,
  model,
  thinking,
  startedAt,
  completedAt: new Date().toISOString(),
  durationS: Math.round((Date.now() - started) / 10) / 100,
  sandbox: invocation.mode,
  exitCode: result.exitCode,
  timedOut: result.timedOut,
  verdict,
  accepted,
  output: result.output.slice(-20_000),
};
const outputDirectory = join(benchDir, "results");
mkdirSync(outputDirectory, { recursive: true });
const stamp = report.completedAt.replace(/[:.]/g, "-");
const outputPath = join(outputDirectory, `${stamp}-${label}.json`);
const temporary = `${outputPath}.tmp-${process.pid}`;
writeFileSync(temporary, JSON.stringify(report, null, 2));
renameSync(temporary, outputPath);
rmSync(scratch, { recursive: true, force: true });
console.log(JSON.stringify({ outputPath, verdict, accepted, exitCode: result.exitCode, timedOut: result.timedOut, durationS: report.durationS }, null, 2));

function spawnSyncText(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", timeout: 30_000 });
}

function diffChangedFiles(patch: string): string[] {
  return [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => match[2]);
}

function run(command: string, args: string[], cwd: string, timeoutMs: number, scratch: string): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already exited */ }
    }, timeoutMs);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ output: output.trim(), exitCode, timedOut });
    });
  });
}
