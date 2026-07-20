#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageSkillForTrial } from "./skill-resource.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-bench-skill-resource-"));
const source = join(root, "source", "demo");
const fixture = join(root, "fixture");
mkdirSync(source, { recursive: true });
mkdirSync(join(fixture, ".git"), { recursive: true });
writeFileSync(join(source, "SKILL.md"), "---\nname: demo\n---\nread only\n");
writeFileSync(join(source, "reference.md"), "reference\n");

const staged = stageSkillForTrial(fixture, join(source, "SKILL.md"));
assert.ok(staged.targetSkill.startsWith(join(fixture, ".git", "pi-bench-skills")));
assert.equal(readFileSync(staged.targetSkill, "utf8"), readFileSync(join(source, "SKILL.md"), "utf8"));
assert.equal(statSync(staged.targetSkill).mode & 0o777, 0o444);
assert.throws(() => writeFileSync(staged.targetSkill, "corrupt\n"));
assert.equal(staged.sourceHash, staged.targetHash);

// Restore owner write permission only for deterministic cleanup of this exact
// temporary test tree.
const makeWritable = (path) => {
  chmodSync(path, 0o755);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) makeWritable(child);
    else chmodSync(child, 0o644);
  }
};
makeWritable(join(staged.targetSkill, ".."));
rmSync(root, { recursive: true, force: true });
console.log("skill resource sandbox smoke passed");
