import { existsSync, realpathSync } from "node:fs";
import { platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const quote = (value) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

/** sandbox-exec compares canonical kernel paths. macOS exposes its temp root as
 * both /var/folders and /private/var/folders, so profiles built from the former
 * silently deny writes performed through the latter. Resolve the deepest
 * existing ancestor and retain any not-yet-created suffix (for lock files). */
export function canonicalSandboxPath(input) {
	let cursor = resolve(input);
	const suffix = [];
	while (!existsSync(cursor)) {
		const parent = dirname(cursor);
		if (parent === cursor) break;
		suffix.unshift(basename(cursor));
		cursor = parent;
	}
	let canonical = cursor;
	try { canonical = realpathSync(cursor); } catch { /* resolved absolute fallback */ }
	return suffix.length > 0 ? join(canonical, ...suffix) : canonical;
}

export function workspaceWriteProfile(writablePaths, protectedPaths = []) {
	const rules = [...new Set(writablePaths.map(canonicalSandboxPath))].map((path) => `(subpath "${quote(path)}")`).join(" ");
	const protectedRules = [...new Set(protectedPaths.map(canonicalSandboxPath))].map((path) => `(subpath "${quote(path)}")`).join(" ");
	return `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* ${rules} (literal "/dev/null") (literal "/dev/tty"))${protectedRules ? `\n(deny file-write* ${protectedRules})` : ""}`;
}

/** Benchmark children may write their temp fixture, sessions and tool scratch,
 * but never the shared source checkout that owns the harness and skills. */
export function sandboxedPiCommand(piArgs, protectedRepo, enabled = process.env.PI_BENCH_SANDBOX !== "0", workspaceRoot, protectedPaths = [], additionalWritablePaths = []) {
	if (!enabled || platform() !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
		return { command: "pi", args: piArgs, mode: "unavailable-or-disabled" };
	}
	if (workspaceRoot) {
		return {
			command: "/usr/bin/sandbox-exec",
			args: ["-p", workspaceWriteProfile([workspaceRoot, ...additionalWritablePaths], [protectedRepo, ...protectedPaths]), "pi", ...piArgs],
			mode: "darwin-workspace-write",
		};
	}
	const profile = `(version 1)\n(allow default)\n(deny file-write* (subpath "${quote(canonicalSandboxPath(protectedRepo))}"))`;
	return {
		command: "/usr/bin/sandbox-exec",
		args: ["-p", profile, "pi", ...piArgs],
		mode: "darwin-deny-shared-repo-write",
	};
}

/** A blind judge may read the target but can write only disposable scratch. */
export function sandboxedReadOnlyPiCommand(piArgs, protectedRepo, targetRoots, writableScratch, enabled = process.env.PI_BENCH_SANDBOX !== "0") {
	if (!enabled || platform() !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
		return { command: "pi", args: piArgs, mode: "unavailable-or-disabled" };
	}
	return {
		command: "/usr/bin/sandbox-exec",
		args: ["-p", workspaceWriteProfile([writableScratch], [protectedRepo, ...targetRoots]), "pi", ...piArgs],
		mode: "darwin-read-only-target",
	};
}
