import { execFileSync } from "node:child_process";

/**
 * Create the immutable baseline used by a benchmark workspace.
 *
 * Vision-only tasks intentionally start without text files.  `--allow-empty`
 * still gives those workspaces a real HEAD, so later `git diff`/worktree
 * operations have exactly the same semantics as file-backed fixtures.
 */
export function commitFixtureBaseline(cwd) {
	execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe" });
	execFileSync("git", [
		"-c", "user.name=pi-bench",
		"-c", "user.email=pi-bench@local",
		"commit", "--allow-empty", "-qm", "fixture",
	], { cwd, stdio: "pipe" });
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

/** Make newly created files visible to `git diff <baseline>` without staging
 * their contents or creating another commit. */
export function exposeUntrackedFixtureFiles(cwd) {
	execFileSync("git", ["add", "-N", "--", "."], { cwd, stdio: "pipe" });
}
