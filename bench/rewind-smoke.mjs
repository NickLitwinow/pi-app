#!/usr/bin/env node

import { copyFileSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";

const source = process.argv[2];
if (!source) throw new Error("usage: node bench/rewind-smoke.mjs <session.jsonl>");

const entries = readFileSync(source, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const header = entries.find((entry) => entry.type === "session");
const sourceUsers = entries.filter((entry) => entry.type === "message" && entry.message?.role === "user");
if (!header?.cwd || sourceUsers.length < 2) throw new Error("session must contain at least two user messages for a mid-session rewind");

const dir = mkdtempSync(join(tmpdir(), "pi-rewind-smoke-"));
const copy = join(dir, basename(source));
copyFileSync(source, copy);

const child = spawn("pi", ["--mode", "rpc", "--session", copy, "--offline", "-a"], {
  cwd: header.cwd,
  stdio: ["pipe", "pipe", "pipe"],
});
const pending = new Map();
let sequence = 0;
let buffer = "";
let stderr = "";

child.stderr.on("data", (chunk) => { stderr += chunk; });
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const waiter = event.id && pending.get(event.id);
    if (!waiter || event.type !== "response") continue;
    pending.delete(event.id);
    if (event.success === false) waiter.reject(new Error(event.error ?? `RPC ${event.command} failed`));
    else waiter.resolve(event.data ?? {});
  }
});

function request(command, timeoutMs = 30_000) {
  const id = `rewind-smoke-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout for ${command.type}${stderr ? `: ${stderr.slice(-500)}` : ""}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
  });
}

try {
  const before = await request({ type: "get_state" });
  const commands = await request({ type: "get_commands" });
  if (!commands.commands?.some((command) => command.name === "pi-rewind")) {
    throw new Error("pi-rewind command is not loaded");
  }
  const forkMessages = await request({ type: "get_fork_messages" });
  const activeForks = forkMessages.messages ?? [];
  if (activeForks.length < 2) throw new Error("active branch must contain at least two rewind targets");
  // Exercise a true mid-session target. Prefer a repeated prompt when the source
  // contains one, because index-vs-text ambiguity caused earlier rewind bugs.
  const repeatedIndex = activeForks.findIndex((candidate, index) => index > 0 && activeForks.slice(0, index).some((prior) => prior.text === candidate.text));
  const targetIndex = repeatedIndex > 0 ? repeatedIndex : 1;
  const target = activeForks[targetIndex];
  const initialMessages = await request({ type: "get_messages" });
  const initialUserMessages = (initialMessages.messages ?? []).filter((message) => message.role === "user").length;
  const beforeFiles = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  await request({ type: "prompt", message: `/pi-rewind ${target.entryId}` }, 60_000);
  const after = await request({ type: "get_state" });
  const messages = await request({ type: "get_messages" });
  const afterFiles = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));

  const sameFile = before.sessionFile === copy && after.sessionFile === copy;
  const noDuplicate = beforeFiles.length === 1 && afterFiles.length === 1 && afterFiles[0] === beforeFiles[0];
  const activeUserMessages = (messages.messages ?? []).filter((message) => message.role === "user").length;
  const persisted = readFileSync(copy, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const rewindRecord = [...persisted].reverse().find((entry) => entry.type === "custom" && entry.customType === "pi-app-rewind-record");
  const abandonedLeafId = rewindRecord?.data?.abandonedLeafId;
  const recordMatches = rewindRecord?.data?.targetEntryId === target.entryId && typeof abandonedLeafId === "string";
  if (!sameFile || !noDuplicate || activeUserMessages !== targetIndex || !recordMatches) {
    throw new Error(JSON.stringify({ sameFile, noDuplicate, initialUserMessages, activeUserMessages, targetIndex, recordMatches, before, after }));
  }
  await request({ type: "prompt", message: `/pi-branch-return ${abandonedLeafId}` }, 60_000);
  const returned = await request({ type: "get_messages" });
  const returnedUserMessages = (returned.messages ?? []).filter((message) => message.role === "user").length;
  const afterReturn = await request({ type: "get_state" });
  const roundTrip = returnedUserMessages === initialUserMessages && afterReturn.sessionFile === copy;
  if (!roundTrip) throw new Error(JSON.stringify({ roundTrip, initialUserMessages, returnedUserMessages, afterReturn }));
  console.log(JSON.stringify({ passed: true, sameFile, noDuplicate, midSession: true, duplicatePromptTarget: repeatedIndex > 0, activeUserMessages, returnedUserMessages, branchRoundTrip: true, recordMatches, sessionFile: copy }));
} finally {
  child.kill("SIGTERM");
}
