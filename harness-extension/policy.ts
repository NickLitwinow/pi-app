/** Pure policy helpers kept separate from the pi extension so they can be unit-tested. */

const VERIFY_COMMAND = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|build|typecheck)\b|(?:vitest|jest|pytest|eslint|ruff|mypy|ctest)\b|cargo\s+(?:test|check|clippy|build)\b|go\s+(?:test|vet|build)\b|tsc\b|make\s+(?:test|check|lint|build)\b|(?:\.\/)?gradlew?\s+(?:test|check|build)\b|mvn\s+(?:test|verify)\b|swift\s+(?:test|build)\b)/i;

/**
 * Accept a real verification command, optionally after setup commands joined with `&&`.
 * Refuse shell constructs that can hide the verifier's non-zero exit status.
 */
export function isVerifyCommand(command: string): boolean {
	const cmd = command.trim();
	if (!cmd) return false;
	if (/\|\|\s*(?:true\b|:|exit\s+0\b)|;\s*exit\s+0\b/i.test(cmd)) return false;

	return cmd
		.split(/&&|;|\n/)
		.map((part) => part.trim().replace(/^\(+\s*/, ""))
		.some((part) => VERIFY_COMMAND.test(part));
}

/** Hard tool blocking is opt-in. The default harness must help execution, not
 * become a second permission system on top of the user's configured one. */
export function isStrictHarness(value: string | undefined): boolean {
	return value === "1" || value?.toLowerCase() === "true";
}

/** Sequential thinking is useful for architecture and genuinely complex plans,
 * but becomes token-heavy noise on ordinary edits. Keep the trigger narrow. */
export function needsSequentialThinking(prompt: string): boolean {
	if (/(архитектур|сложн[а-яё]*\s+рефактор|системн[а-яё]*\s+дизайн|architecture|complex\s+refactor|system\s+design)/i.test(prompt)) {
		return true;
	}
	const asksForPlan = /(спланируй|план\w*\s+(миграц|рефактор|переработ)|plan\w*\s+(migration|refactor|redesign))/i.test(prompt);
	const listMarkers = (prompt.match(/(^|\n)\s*(\d+[.)]|[-*•])\s+/g) ?? []).length;
	return asksForPlan && (prompt.length >= 160 || listMarkers >= 2);
}
