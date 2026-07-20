#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitFixtureBaseline, exposeUntrackedFixtureFiles } from "./fixture-git.mjs";
import { advancedTasks } from "./advanced-tasks.mjs";
import { materializeTaskVerifierManifest } from "./task-verifiers.mjs";

const workspace = realpathSync(mkdtempSync(join(tmpdir(), "pi-empty-fixture-smoke-")));
try {
	execFileSync("git", ["init", "-q", "."], { cwd: workspace, stdio: "pipe" });
	writeFileSync(join(workspace, ".git", "info", "exclude"), ".pi/\n");
	const baseline = commitFixtureBaseline(workspace);
	assert.equal(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim(), "1");
	assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: workspace, encoding: "utf8" }), "");
	assert.equal(execFileSync("git", ["show", "-s", "--format=%s", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim(), "fixture");
	writeFileSync(join(workspace, "workflow.json"), "{\"nodes\":[]}\n");
	exposeUntrackedFixtureFiles(workspace);
	const diff = execFileSync("git", ["diff", "--no-ext-diff", baseline, "--", "."], { cwd: workspace, encoding: "utf8" });
	assert.match(diff, /diff --git a\/workflow\.json b\/workflow\.json/);
	assert.match(diff, /\+\{"nodes":\[\]\}/);
	const visionTask = advancedTasks.find((task) => task.id === "vision-workflow-extraction");
	assert.ok(visionTask);
	const manifestPath = materializeTaskVerifierManifest(workspace, visionTask);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	assert.deepEqual(manifest.commands.map((command) => command.id), ["vision-contract", "loop-edge"]);
	assert.equal(manifest.commands.every((command) => command.required), true);
	console.log("empty benchmark fixture baseline smoke passed");
} finally {
	rmSync(workspace, { recursive: true, force: true });
}
