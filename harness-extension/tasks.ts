export type TaskPriority = "high" | "normal" | "low";

export type QueueTask = {
	id: string;
	status: "queued" | "running" | "completed" | "failed" | "cancelled";
	type?: string;
	priority?: TaskPriority;
	startedAt?: number;
	completedAt?: number;
	durationMs?: number;
	queuePosition?: number;
	etaMs?: number;
	blockedReason?: string;
};

/** Add honest, display-only queue evidence without mutating the scheduler record. */
export function decorateTaskQueue<T extends QueueTask>(tasks: T[], maxConcurrent = 2): Array<T & QueueTask> {
	const concurrency = Math.max(1, Math.floor(maxConcurrent) || 1);
	const observedDurations = tasks
		.map((task) => task.durationMs ?? (task.startedAt != null && task.completedAt != null ? task.completedAt - task.startedAt : undefined))
		.filter((duration): duration is number => typeof duration === "number" && duration > 0);
	const averageDuration = observedDurations.length > 0
		? Math.round(observedDurations.reduce((sum, duration) => sum + duration, 0) / observedDurations.length)
		: undefined;
	const running = tasks.filter((task) => task.status === "running").length;
	let queuePosition = 0;
	return tasks.map((task): T & QueueTask => {
		const priority = task.priority ?? (task.type === "independent-evaluator" ? "high" : "normal");
		if (task.status !== "queued") return { ...task, priority, queuePosition: undefined, etaMs: undefined, blockedReason: undefined };
		queuePosition++;
		const batchesAhead = Math.max(0, Math.ceil((running + queuePosition - concurrency) / concurrency));
		return {
			...task,
			priority,
			queuePosition,
			etaMs: averageDuration == null ? undefined : averageDuration * batchesAhead,
			blockedReason: running >= concurrency || queuePosition > concurrency - running
				? `Waiting for an available worker slot (${queuePosition} in queue).`
				: "Queued by the background scheduler; a worker slot is available.",
		};
	});
}
