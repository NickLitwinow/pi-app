#!/usr/bin/env node

/** Maintain the narrow pi-subagents worktree-cwd safety patch used by pi-app. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const checkOnly = process.argv.includes("--check");
const agentRoot = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const packageRoot = join(agentRoot, "npm", "node_modules", "@tintinweb", "pi-subagents");

const patches = [
  {
    path: join(packageRoot, "src", "agent-runner.ts"),
    marker: "pi-app worktree cwd rebase",
    before: `  // Get parent system prompt for append-mode agents
  const parentSystemPrompt = ctx.getSystemPrompt();`,
    after: `  // pi-app worktree cwd rebase: append-mode inherits the parent's generated
  // environment block, including its absolute cwd. Rebase exact references so
  // local models cannot mistake the parent checkout for the isolated child.
  const rawParentSystemPrompt = ctx.getSystemPrompt();
  const parentSystemPrompt = effectiveCwd === ctx.cwd
    ? rawParentSystemPrompt
    : rawParentSystemPrompt.split(ctx.cwd).join(effectiveCwd);`,
  },
  {
    path: join(packageRoot, "src", "prompts.ts"),
    marker: "The Environment working directory below is authoritative.",
    before: `- Make independent tool calls in parallel
- Use absolute file paths
- Do not use emojis`,
    after: `- Make independent tool calls in parallel
- The Environment working directory below is authoritative. Keep every project
  read and write inside it; ignore any different workspace path inherited from
  the parent and never modify the parent worktree directly.
- Use absolute file paths rooted at that authoritative working directory
- Do not use emojis`,
  },
];

let changed = 0;
for (const patch of patches) {
  if (!existsSync(patch.path)) throw new Error(`pi-subagents source is missing: ${patch.path}`);
  const source = readFileSync(patch.path, "utf8");
  if (source.includes(patch.marker)) continue;
  if (!source.includes(patch.before)) {
    throw new Error(`pi-subagents changed upstream; cannot safely apply the worktree patch: ${patch.path}`);
  }
  if (checkOnly) throw new Error(`pi-subagents worktree patch is not applied: ${patch.path}`);
  writeFileSync(patch.path, source.replace(patch.before, patch.after));
  changed++;
}

console.log(JSON.stringify({ passed: true, checkOnly, changed, packageRoot }));
