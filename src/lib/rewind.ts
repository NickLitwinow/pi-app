import type { TimelineItem } from "./types";

/** Checkpoint captured immediately before the selected user turn executed. */
export function checkpointForUserTurn(items: TimelineItem[], itemIndex: number): string | null {
  if (itemIndex < 0 || items[itemIndex]?.msg.role !== "user") return null;
  for (let index = itemIndex + 1; index < items.length; index++) {
    const item = items[index];
    if (item.msg.role === "user" && !item.viaExtension) break;
    if (item.msg.role === "assistant" && item.msg.run?.checkpoint) return item.msg.run.checkpoint;
  }
  return null;
}
