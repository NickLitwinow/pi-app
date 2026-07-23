import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

export type PorcelainSnapshot = { files: string[]; untracked: string[] };

/** Git reports porcelain paths relative to the repository root even when the
 * command runs in a nested project. Convert those paths back to the active
 * workspace so evidence and untracked-content hashing cannot leak across
 * sibling projects in a monorepo. */
export function stripGitPrefix(path: string, prefix = ""): string | undefined {
	const normalizedPrefix = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
	if (!normalizedPrefix) return path;
	if (path === normalizedPrefix) return "";
	const marker = `${normalizedPrefix}/`;
	return path.startsWith(marker) ? path.slice(marker.length) : undefined;
}

/** Resolve a tool-supplied path against the session cwd and reject escapes. */
export function isWorkspacePath(cwd: string, candidate: string): boolean {
	const absolute = resolve(cwd, candidate);
	const inside = relative(cwd, absolute);
	return inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`));
}

/** Canonical path used by workflow evidence and UI. */
export function workspaceRelativePath(cwd: string, candidate: string): string | undefined {
	if (!candidate || !isWorkspacePath(cwd, candidate)) return undefined;
	const path = relative(cwd, resolve(cwd, candidate));
	return path && path !== "." ? path : undefined;
}

/** Rebase an append-mode parent's absolute project references onto its child worktree. */
export function rebaseWorktreePrompt(prompt: string, parentRoot: string, worktreeRoot: string): string {
	if (!parentRoot || !worktreeRoot || parentRoot === worktreeRoot) return prompt;
	const marker = `__PI_APP_ACTIVE_WORKTREE_${createHash("sha256").update(worktreeRoot).digest("hex").slice(0, 16)}__`;
	return prompt
		.split(worktreeRoot).join(marker)
		.split(parentRoot).join(worktreeRoot)
		.split(marker).join(worktreeRoot);
}

/** Parse `git status --porcelain=v1 -z --untracked-files=all` without trimming
 * its significant leading status column. Extra NUL fields emitted for renames
 * do not match the XY prefix and are intentionally ignored. */
export function parsePorcelainZ(status: string, prefix = ""): PorcelainSnapshot {
	const files: string[] = [];
	const untracked: string[] = [];
	for (const record of status.split("\0")) {
		if (!/^[ MADRCU?!]{2} /.test(record)) continue;
		const code = record.slice(0, 2);
		const path = stripGitPrefix(record.slice(3), prefix);
		if (!path) continue;
		files.push(path);
		if (code === "??") untracked.push(path);
	}
	return { files: [...new Set(files)], untracked: [...new Set(untracked)] };
}

/** Tracked changes are represented by `git diff`; untracked file contents need
 * their own digest because porcelain status otherwise stays `?? path` forever. */
export function fingerprintWorkspace(cwd: string, diff: string, status: string, revision = "", prefix = ""): { fingerprint: string; files: string[] } {
	const parsed = parsePorcelainZ(status, prefix);
	const hash = createHash("sha256")
		.update(revision)
		.update("\n--revision--\n")
		.update(diff)
		.update("\n--status-z--\n")
		.update(status);
	for (const path of [...parsed.untracked].sort()) {
		try {
			const absolute = resolve(cwd, path);
			const inside = relative(cwd, absolute);
			if (inside === ".." || inside.startsWith(`..${sep}`) || inside === "") continue;
			const stat = statSync(absolute);
			if (!stat.isFile()) continue;
			hash.update(`\n--untracked--\n${path}\n${stat.size}\n`);
			if (stat.size <= 32 * 1024 * 1024) hash.update(readFileSync(absolute));
			else hash.update(`${stat.mtimeMs}`);
		} catch {
			// A concurrently removed file is already represented by the status text.
		}
	}
	return { fingerprint: hash.digest("hex"), files: parsed.files };
}
