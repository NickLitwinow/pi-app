import { describe, expect, it } from "vitest";
import {
  activeBackgroundTaskCount,
  emptyWorkspaceChat,
  nextVisibleWorkspace,
  preserveWorkspaceLiveState,
  samePath,
  workspaceHasActiveWork,
} from "../state/store";

describe("background work lifecycle", () => {
  it("keeps the workspace busy after the foreground turn ends", () => {
    const ws = emptyWorkspaceChat();
    ws.alive = true;
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
    ws.alive = true;
    ws.chat.backgroundTasks = [
      { id: "queued", type: "builder", description: "Queued build", status: "queued" },
    ];
    expect(workspaceHasActiveWork(ws)).toBe(true);

    ws.chat.backgroundTasks[0].status = "cancelled";
    expect(activeBackgroundTaskCount(ws)).toBe(0);
    expect(workspaceHasActiveWork(ws)).toBe(false);
  });

  it("does not treat persisted running records from a dead process as live work", () => {
    const ws = emptyWorkspaceChat();
    ws.chat.backgroundTasks = [
      { id: "historical", type: "builder", description: "Interrupted build", status: "running" },
    ];
    expect(activeBackgroundTaskCount(ws)).toBe(0);
    expect(workspaceHasActiveWork(ws)).toBe(false);
  });

  it("keeps the composer in stop mode while a persisted workflow step is running", () => {
    const ws = emptyWorkspaceChat();
    ws.alive = true;
    ws.chat.workflow = {
      version: 3,
      runId: "wf-active",
      createdAt: 1,
      updatedAt: 2,
      objective: "Finish the workflow",
      profile: "feature",
      status: "active",
      approved: true,
      editsPending: true,
      changedFiles: [],
      intent: {
        primary: "build",
        profile: "feature",
        risk: "medium",
        needsResearch: false,
        needsPreview: false,
        allowsMutation: true,
        allowsDeletion: false,
        requiresPlan: true,
        requiresSandbox: true,
        requiresEvaluator: true,
        requiresHumanApproval: false,
        signals: [],
      },
      steps: [{
        id: "evaluate",
        label: "Independent evaluation",
        kind: "evaluate",
        deps: [],
        status: "running",
        acceptance: "Evaluator completes.",
        required: true,
        owner: "evaluator",
        maxAttempts: 5,
        attempts: 1,
      }],
      events: [],
    };

    expect(ws.liveStreaming).toBe(false);
    expect(activeBackgroundTaskCount(ws)).toBe(0);
    expect(workspaceHasActiveWork(ws)).toBe(true);

    ws.alive = false;
    expect(workspaceHasActiveWork(ws)).toBe(false);
  });

  it("restores current background tasks when returning from a browsed session", () => {
    const snapshot = emptyWorkspaceChat().chat;
    snapshot.backgroundTasks = [
      { id: "stale", type: "reviewer", description: "Old task", status: "completed" },
    ];
    const current = emptyWorkspaceChat().chat;
    current.backgroundTasks = [
      { id: "live", type: "builder", description: "Live task", status: "running" },
    ];

    expect(preserveWorkspaceLiveState(snapshot, current).backgroundTasks).toEqual(current.backgroundTasks);
  });

  it("does not select a hidden project after the current workspace is detached", () => {
    const project = (cwd: string) => ({
      cwd,
      dir: cwd,
      name: cwd.slice(1),
      sessionCount: 0,
      lastModifiedMs: 0,
    });
    expect(nextVisibleWorkspace(
      "/current",
      [project("/duplicate")],
      [project("/hidden"), project("/duplicate"), project("/next")],
      ["/hidden"],
    )).toBe("/duplicate");
    expect(nextVisibleWorkspace(
      "/current",
      [],
      [project("/hidden")],
      ["/hidden"],
    )).toBeNull();
  });

  it("recognizes equivalent Pi session paths by their unique JSONL basename", () => {
    expect(samePath(
      "/private/var/folders/agent/sessions/0f4a.jsonl",
      "/var/folders/agent/sessions/0f4a.jsonl",
    )).toBe(true);
    expect(samePath("/sessions/first.jsonl", "/sessions/second.jsonl")).toBe(false);
  });
});
