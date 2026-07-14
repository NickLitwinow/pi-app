#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const STARTUP_LIMIT_MS = Number(process.env.PI_APP_STARTUP_BUDGET_MS || 1_000);
const RSS_LIMIT_MB = Number(process.env.PI_APP_IDLE_RSS_BUDGET_MB || 180);
const READY_TIMEOUT_MS = Number(process.env.PI_APP_READY_TIMEOUT_MS || 10_000);
const IDLE_SETTLE_MS = Number(process.env.PI_APP_IDLE_SETTLE_MS || 3_000);
const appPath = resolve(process.argv[2] || "src-tauri/target/release/bundle/macos/Pi.app");
const executable = join(appPath, "Contents", "MacOS", "pi-app");

if (process.platform !== "darwin") {
  throw new Error("perf-smoke measures WKWebView and must run on macOS");
}
if (!existsSync(executable)) {
  throw new Error(`app executable not found: ${executable}`);
}

const workDir = mkdtempSync(join(tmpdir(), "pi-app-perf-"));
const readyFile = join(workDir, "ready.json");
const baselinePids = new Set(processSnapshot().map((proc) => proc.pid));
const started = performance.now();
const child = spawn(executable, [], {
  detached: true,
  env: { ...process.env, PI_APP_PERF_READY_FILE: readyFile },
  stdio: "ignore",
});

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function processSnapshot() {
  const text = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8" });
  return text
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), command: match[4] }));
}

function descendants(snapshot, rootPid) {
  const included = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const proc of snapshot) {
      if (!included.has(proc.pid) && included.has(proc.ppid)) {
        included.add(proc.pid);
        changed = true;
      }
    }
  }
  return snapshot.filter((proc) => included.has(proc.pid));
}

let failed = false;
try {
  while (!existsSync(readyFile) && performance.now() - started < READY_TIMEOUT_MS) {
    if (child.exitCode != null) throw new Error(`app exited before ready (code ${child.exitCode})`);
    await delay(20);
  }
  if (!existsSync(readyFile)) throw new Error(`app did not become ready within ${READY_TIMEOUT_MS} ms`);

  const startupMs = performance.now() - started;
  const marker = JSON.parse(readFileSync(readyFile, "utf8"));
  await delay(IDLE_SETTLE_MS);
  const snapshot = processSnapshot();
  const tree = descendants(snapshot, marker.pid);
  // WKWebView XPC helpers are reparented to launchd (ppid=1), so they are not
  // descendants of the app. On an isolated smoke runner, newly-created WebKit
  // helpers belong to this launch and must be counted in UI idle memory.
  const webkitHelpers = snapshot.filter(
    (proc) => !baselinePids.has(proc.pid) && proc.command.includes("/com.apple.WebKit."),
  );
  const measured = [...tree, ...webkitHelpers.filter((proc) => !tree.some((item) => item.pid === proc.pid))];
  const rssMb = measured.reduce((sum, proc) => sum + proc.rssKb, 0) / 1024;

  failed = startupMs >= STARTUP_LIMIT_MS || rssMb >= RSS_LIMIT_MB;
  console.log(JSON.stringify({
    startupMs: Math.round(startupMs),
    startupBudgetMs: STARTUP_LIMIT_MS,
    idleRssMb: Number(rssMb.toFixed(1)),
    idleRssBudgetMb: RSS_LIMIT_MB,
    processCount: measured.length,
    processes: measured.map(({ pid, ppid, rssKb, command }) => ({ pid, ppid, rssMb: Number((rssKb / 1024).toFixed(1)), command })),
  }, null, 2));
} finally {
  try {
    process.kill(-child.pid, "SIGTERM");
    await delay(400);
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The app may already be gone; cleanup is best-effort.
  }
  rmSync(workDir, { recursive: true, force: true });
}

if (failed) process.exitCode = 1;
