import { describe, expect, it } from "vitest";
import { checkpointForUserTurn } from "./rewind";
import type { TimelineItem } from "./types";

const item = (role: string, checkpoint?: string, viaExtension = false): TimelineItem => ({
  key: `${role}-${checkpoint ?? "none"}-${viaExtension}`,
  msg: {
    role,
    content: [{ type: "text", text: role }],
    ...(checkpoint ? { run: { id: checkpoint, durationMs: 1, toolCallIds: [], checkpoint } } : {}),
  },
  viaExtension,
});

describe("rewind file checkpoint selection", () => {
  it("uses the checkpoint of the selected user turn, not a later turn", () => {
    const items = [item("user"), item("assistant"), item("toolResult"), item("assistant", "cp-1"), item("user"), item("assistant", "cp-2")];
    expect(checkpointForUserTurn(items, 0)).toBe("cp-1");
    expect(checkpointForUserTurn(items, 4)).toBe("cp-2");
  });

  it("ignores extension user messages and fails closed without a checkpoint", () => {
    const items = [item("user"), item("user", undefined, true), item("assistant", "cp"), item("user")];
    expect(checkpointForUserTurn(items, 0)).toBe("cp");
    expect(checkpointForUserTurn(items, 3)).toBeNull();
    expect(checkpointForUserTurn(items, -1)).toBeNull();
  });
});
