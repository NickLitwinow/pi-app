import { describe, expect, it } from "vitest";
import { activeBackgroundTaskCount, emptyWorkspaceChat, workspaceHasActiveWork } from "../state/store";

describe("background work lifecycle", () => {
  it("keeps the workspace busy after the foreground turn ends", () => {
    const ws = emptyWorkspaceChat();
    ws.chat.backgroundTasks = [
      { id: "long-build", type: "builder", description: "Eight-hour build", status: "running" },
      { id: "finished", type: "reviewer", description: "Finished review", status: "completed" },
    ];

    expect(ws.liveStreaming).toBe(false);
    expect(activeBackgroundTaskCount(ws)).toBe(1);
    expect(workspaceHasActiveWork(ws)).toBe(true);
  });

  it("releases session protection only after every task is terminal", () => {
    const ws = emptyWorkspaceChat();
    ws.chat.backgroundTasks = [
      { id: "queued", type: "builder", description: "Queued build", status: "queued" },
    ];
    expect(workspaceHasActiveWork(ws)).toBe(true);

    ws.chat.backgroundTasks[0].status = "cancelled";
    expect(activeBackgroundTaskCount(ws)).toBe(0);
    expect(workspaceHasActiveWork(ws)).toBe(false);
  });
});
