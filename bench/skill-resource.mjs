import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");

function makeReadOnlyTree(path) {
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) {
			makeReadOnlyTree(child);
			chmodSync(child, 0o555);
		} else {
			chmodSync(child, 0o444);
		}
	}
	chmodSync(path, 0o555);
}
/** Copy a skill into the trial's git metadata so its path remains inside the
 * fixture but it cannot pollute the task diff or the shared source checkout. */
export function stageSkillForTrial(cwd, sourceSkill) {
	const sourceDir = dirname(sourceSkill);
	const sourceHash = hash(readFileSync(sourceSkill));
	const targetDir = join(cwd, ".git", "pi-bench-skills", `${sourceHash.slice(0, 12)}-${basename(sourceDir)}`);
	mkdirSync(dirname(targetDir), { recursive: true });
	cpSync(sourceDir, targetDir, { recursive: true, force: false, errorOnExist: true });
	makeReadOnlyTree(targetDir);
	const targetSkill = join(targetDir, "SKILL.md");
	if (!existsSync(targetSkill)) throw new Error(`Staged skill has no SKILL.md: ${targetSkill}`);
	return { sourceSkill, sourceHash, targetSkill, targetHash: hash(readFileSync(targetSkill)), readOnly: true };
}
