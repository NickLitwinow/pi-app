/** Deterministic Latin-style rotation used to balance arm warm-up order. */
export function rotatedArmOrder(arms, trial, taskIndex = 0) {
	if (!Array.isArray(arms) || arms.length === 0) return [];
	const rotate = (trial + taskIndex - 1) % arms.length;
	return [...arms.slice(rotate), ...arms.slice(0, rotate)];
}
