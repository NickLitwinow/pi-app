import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Materialize only the public, project-owned gates declared by a benchmark
 * fixture. Hidden/static graders remain outside the agent workspace. */
export function materializeTaskVerifierManifest(cwd, task) {
	const path = join(cwd, ".pi", "verifiers.json");
	if (existsSync(join(cwd, "package.json")) || existsSync(path)) return null;
	const declared = Array.isArray(task.verifiers)
		? task.verifiers
		: task.check ? [{ id: "task-check", label: "Task check", command: task.check }] : [];
	if (declared.length === 0) return null;
	const commands = declared.map((verifier) => ({
		id: verifier.id,
		label: verifier.label ?? verifier.id,
		command: verifier.command,
		acceptance: verifier.acceptance,
		required: verifier.required !== false,
		timeoutMs: verifier.timeoutMs ?? 60_000,
	}));
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({
		version: 1,
		commands,
		evaluator: { enabled: true, agent: "independent-evaluator" },
	}, null, 2));
	return path;
}
