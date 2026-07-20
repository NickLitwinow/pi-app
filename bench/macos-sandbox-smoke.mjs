#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalSandboxPath, sandboxedPiCommand, sandboxedReadOnlyPiCommand, workspaceWriteProfile } from "./macos-sandbox.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const protectedProbe = join(repo, ".pi", "bench", `sandbox-denied-${process.pid}`);
const allowedDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-bench-sandbox-allowed-")));
const allowedProbe = join(allowedDir, "created");
const protectedInsideAllowed = join(allowedDir, "protected");
const protectedInsideProbe = join(protectedInsideAllowed, "blocked");
mkdirSync(join(repo, ".pi", "bench"), { recursive: true });
mkdirSync(protectedInsideAllowed, { recursive: true });

const wrapped = sandboxedPiCommand([], repo);
if (wrapped.mode === "unavailable-or-disabled") {
  console.log("macOS sandbox smoke skipped: sandbox-exec unavailable or disabled");
  process.exit(0);
}
const profile = wrapped.args[1];
assert.throws(() => execFileSync(wrapped.command, ["-p", profile, "/usr/bin/touch", protectedProbe], { stdio: "pipe" }));
execFileSync(wrapped.command, ["-p", profile, "/usr/bin/touch", allowedProbe], { stdio: "pipe" });
assert.equal(existsSync(protectedProbe), false);
assert.equal(existsSync(allowedProbe), true);

const workspaceProfile = workspaceWriteProfile([allowedDir]);
const deniedByDefault = join(repo, ".pi", "bench", `workspace-denied-${process.pid}`);
execFileSync("/usr/bin/sandbox-exec", ["-p", workspaceProfile, "/bin/sh", "-c", "printf sandbox-stdout"], { stdio: "pipe" });
assert.throws(() => execFileSync("/usr/bin/sandbox-exec", ["-p", workspaceProfile, "/usr/bin/touch", deniedByDefault], { stdio: "pipe" }));
assert.equal(existsSync(deniedByDefault), false);
const tempAlias = allowedDir.replace(/^\/private\/var\//, "/var/");
assert.equal(canonicalSandboxPath(tempAlias), allowedDir);
const aliasProfile = workspaceWriteProfile([tempAlias]);
const aliasProbe = join(allowedDir, "alias-created");
execFileSync("/usr/bin/sandbox-exec", ["-p", aliasProfile, "/usr/bin/touch", aliasProbe], { stdio: "pipe" });
assert.equal(existsSync(aliasProbe), true, "a /var profile input must permit its /private/var kernel path");
const nestedProtectionProfile = workspaceWriteProfile([allowedDir], [protectedInsideAllowed]);
assert.throws(() => execFileSync("/usr/bin/sandbox-exec", ["-p", nestedProtectionProfile, "/usr/bin/touch", protectedInsideProbe], { stdio: "pipe" }));
assert.equal(existsSync(protectedInsideProbe), false);
const readOnlyTarget = sandboxedReadOnlyPiCommand([], repo, [protectedInsideAllowed], allowedDir);
assert.equal(readOnlyTarget.mode, "darwin-read-only-target");
const readOnlyProfile = readOnlyTarget.args[1];
assert.throws(() => execFileSync(readOnlyTarget.command, ["-p", readOnlyProfile, "/usr/bin/touch", protectedInsideProbe], { stdio: "pipe" }));
execFileSync(readOnlyTarget.command, ["-p", readOnlyProfile, "/usr/bin/touch", allowedProbe], { stdio: "pipe" });
assert.equal(existsSync(protectedInsideProbe), false);
rmSync(allowedDir, { recursive: true, force: true });
console.log("macOS shared-repo write sandbox smoke passed");
