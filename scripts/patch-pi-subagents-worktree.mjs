#!/usr/bin/env node

/** Maintain the declarative pi-subagents worktree-cwd overlay used by pi-app. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const checkOnly = process.argv.includes("--check");
const agentRoot = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(repoRoot, "extension-overlays", "pi-subagents-worktree.json"), "utf8"));
const packageRoot = join(agentRoot, manifest.packageRoot);

let changed = 0;
for (const patch of manifest.patches) {
  const target = join(packageRoot, patch.path);
  if (!existsSync(target)) throw new Error(`pi-subagents source is missing: ${target}`);
  const source = readFileSync(target, "utf8");
  if (source.includes(patch.marker)) continue;
  if (!source.includes(patch.before)) {
    throw new Error(`pi-subagents changed upstream; cannot safely apply overlay ${manifest.id}: ${target}`);
  }
  if (checkOnly) throw new Error(`pi-subagents worktree overlay is not applied: ${target}`);
  writeFileSync(target, source.replace(patch.before, patch.after));
  changed++;
}

console.log(JSON.stringify({ passed: true, checkOnly, changed, overlay: manifest.id, packageRoot }));
