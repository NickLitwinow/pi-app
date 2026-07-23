import { describe, expect, it } from "vitest";
import { addUserMessage, applyAgentEvent, contentText, entriesToChatState, stripLeadingEmoji } from "./reducer";
import { emptyChatState } from "./types";

// Event shapes below mirror real pi 0.80.3 RPC output captured from a live probe.

const assistantPartial = (blocks: unknown[]) => ({
  role: "assistant",
  content: blocks,
  model: "qwen-test",
});

describe("applyAgentEvent — streaming lifecycle", () => {
  it("handles the full real-world event sequence", () => {
    let chat = emptyChatState();
    const apply = (ev: Record<string, unknown>) => {
      chat = applyAgentEvent({ ...chat }, ev);
    };

    apply({ type: "agent_start" });
    expect(chat.isStreaming).toBe(true);

    // user message echo (message_start/end fire for user messages too)
    apply({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
    expect(chat.streaming).toBeNull();
    apply({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
    expect(chat.items).toHaveLength(1);

    // assistant streaming via partial snapshots
    apply({ type: "message_start", message: assistantPartial([]) });
    expect(chat.streaming).not.toBeNull();

    apply({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "think",
        partial: assistantPartial([{ type: "thinking", thinking: "think" }]),
      },
    });
    expect(chat.streaming?.content).toHaveLength(1);

    apply({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Hel",
        partial: assistantPartial([
          { type: "thinking", thinking: "think" },
          { type: "text", text: "Hel" },
        ]),
      },
    });
    expect(contentText(chat.streaming?.content)).toBe("Hel");

    apply({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        toolCall: { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
        partial: assistantPartial([
          { type: "thinking", thinking: "think" },
          { type: "text", text: "Hello" },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
        ]),
      },
    });

    const finalAssistant = assistantPartial([
      { type: "thinking", thinking: "think" },
      { type: "text", text: "Hello" },
      { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
    ]);
    apply({ type: "message_end", message: finalAssistant });
    expect(chat.items).toHaveLength(2);
    expect(chat.streaming).toBeNull();

    // tool execution
    apply({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } });
    expect(chat.toolExecs.call_1.done).toBe(false);

    apply({
      type: "tool_execution_update",
      toolCallId: "call_1",
      partialResult: { content: [{ type: "text", text: "file1\n" }] },
    });
    expect(chat.toolExecs.call_1.output).toBe("file1\n");

    apply({
      type: "tool_execution_end",
      toolCallId: "call_1",
      result: { content: [{ type: "text", text: "file1\nfile2\n" }] },
      isError: false,
    });
    expect(chat.toolExecs.call_1.done).toBe(true);
    expect(chat.toolExecs.call_1.output).toBe("file1\nfile2\n");

    // toolResult message folds into the exec, not the timeline
    apply({
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "file1\nfile2\n" }],
        isError: false,
      },
    });
    expect(chat.items).toHaveLength(2);

    apply({ type: "agent_end", messages: [] });
    expect(chat.isStreaming).toBe(false);
    expect(chat.streaming).toBeNull();
    expect(chat.items[1].msg.run?.toolCallIds).toEqual(["call_1"]);
    expect(chat.items[1].msg.run?.durationMs).toBeGreaterThanOrEqual(0);
    expect(chat.activeRunId).toBeNull();
  });

  it("dedupes the user echo after an optimistic add", () => {
    let chat = emptyChatState();
    chat = addUserMessage({ ...chat }, "do the thing");
    chat = applyAgentEvent({ ...chat }, {
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "do the thing" }] },
    });
    expect(chat.items).toHaveLength(1);
  });

  it("replaces an optimistic vision prompt with the authoritative image echo", () => {
    let chat = addUserMessage(emptyChatState(), "inspect", [{ data: "abc", mimeType: "image/png" }]);
    chat = applyAgentEvent({ ...chat }, {
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "inspect" }, { type: "image", data: "abc", mimeType: "image/png" }] },
    });
    expect(chat.items).toHaveLength(1);
    expect(Array.isArray(chat.items[0].msg.content) && chat.items[0].msg.content[1]).toMatchObject({
      type: "image",
      data: "abc",
      mimeType: "image/png",
    });
  });

  it("keeps two identical consecutive user messages (each echo consumes one optimistic)", () => {
    let chat = emptyChatState();
    chat = addUserMessage({ ...chat }, "again");
    chat = addUserMessage({ ...chat }, "again");
    const echo = { type: "message_end", message: { role: "user", content: [{ type: "text", text: "again" }] } };
    chat = applyAgentEvent({ ...chat }, echo);
    chat = applyAgentEvent({ ...chat }, echo);
    expect(chat.items).toHaveLength(2);
    expect(chat.items.every((it) => !it.optimistic && !it.viaExtension)).toBe(true);
  });

  it("extension-rewritten echo replaces the pending optimistic item (pi-goal scenario)", () => {
    let chat = emptyChatState();
    chat = addUserMessage({ ...chat }, "/goal ship the feature");
    chat = applyAgentEvent({ ...chat }, {
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "[GOAL] ship the feature\nGuidelines: …" }] },
    });
    expect(chat.items).toHaveLength(1);
    expect(contentText(chat.items[0].msg.content)).toContain("[GOAL]");
    expect(chat.items[0].viaExtension).toBeUndefined();
  });

  it("marks a user echo without an optimistic pair as sent by an extension", () => {
    let chat = emptyChatState();
    chat = applyAgentEvent({ ...chat }, {
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "Continue working on the active goal." }] },
    });
    expect(chat.items).toHaveLength(1);
    expect(chat.items[0].viaExtension).toBe(true);
  });

  it("salvages a streamed message when message_end never arrives", () => {
    let chat = emptyChatState();
    chat = applyAgentEvent({ ...chat }, { type: "agent_start" });
    chat = applyAgentEvent({ ...chat }, {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "partial answer",
        partial: assistantPartial([{ type: "text", text: "partial answer" }]),
      },
    });
    chat = applyAgentEvent({ ...chat }, { type: "agent_end" });
    expect(chat.items).toHaveLength(1);
    expect(contentText(chat.items[0].msg.content)).toBe("partial answer");
  });
});

describe("applyAgentEvent — auxiliary events", () => {
  it("tracks queue updates", () => {
    const chat = applyAgentEvent(emptyChatState(), {
      type: "queue_update",
      steering: ["stop that"],
      followUp: [{ text: "and then this" }],
    });
    expect(chat.queue.steering).toEqual(["stop that"]);
    expect(chat.queue.followUp).toEqual(["and then this"]);
  });

  it("collects extension UI dialogs and notifications", () => {
    let chat = applyAgentEvent(emptyChatState(), {
      type: "extension_ui_request",
      id: "u1",
      method: "select",
      title: "Allow?",
      options: ["Allow", "Block"],
    });
    expect(chat.uiRequests).toHaveLength(1);
    expect(chat.uiRequests[0].options).toEqual(["Allow", "Block"]);

    chat = applyAgentEvent({ ...chat }, {
      type: "extension_ui_request",
      method: "notify",
      message: "done!",
      notificationType: "success",
    });
    expect(chat.toasts.at(-1)?.text).toBe("done!");
    expect(chat.toasts.at(-1)?.kind).toBe("success");

    // real wire format uses statusKey/statusText and widgetKey
    chat = applyAgentEvent({ ...chat }, {
      type: "extension_ui_request",
      method: "setStatus",
      statusKey: "lens",
      statusText: "3 findings",
    });
    expect(chat.statusEntries.lens).toBe("3 findings");

    // setStatus without text clears the entry
    chat = applyAgentEvent({ ...chat }, { type: "extension_ui_request", method: "setStatus", statusKey: "lens" });
    expect(chat.statusEntries.lens).toBeUndefined();

    chat = applyAgentEvent({ ...chat }, {
      type: "extension_ui_request",
      method: "setWidget",
      widgetKey: "todos",
      widgetText: "TODO: 2/5",
    });
    expect(chat.widgets.todos).toBe("TODO: 2/5");
    chat = applyAgentEvent({ ...chat }, {
      type: "extension_ui_request",
      method: "setWidget",
      widgetKey: "agents",
      widgetLines: ["Background tasks", "● running · reviewer"],
    });
    expect(chat.widgets.agents).toBe("Background tasks\n● running · reviewer");
    chat = applyAgentEvent({ ...chat }, { type: "extension_ui_request", method: "setWidget", widgetKey: "todos" });
    expect(chat.widgets.todos).toBeUndefined();
  });

  it("bounds untrusted extension dialogs, status entries, and widgets", () => {
    let chat = applyAgentEvent(emptyChatState(), {
      type: "extension_ui_request",
      id: "request-1",
      method: "select",
      title: "t".repeat(2_000),
      message: "m".repeat(40_000),
      options: Array.from({ length: 150 }, (_, index) => `option-${index}-${"x".repeat(3_000)}`),
    });
    expect(chat.uiRequests).toHaveLength(1);
    expect(chat.uiRequests[0].title).toHaveLength(500);
    expect(chat.uiRequests[0].message).toHaveLength(20_000);
    expect(chat.uiRequests[0].options).toHaveLength(100);
    expect(chat.uiRequests[0].options?.[0]).toHaveLength(2_000);

    chat = applyAgentEvent({ ...chat }, { type: "extension_ui_request", id: "request-1", method: "confirm" });
    expect(chat.uiRequests).toHaveLength(1);

    chat = applyAgentEvent({ ...chat }, {
      type: "extension_ui_request",
      method: "setWidget",
      widgetKey: "third-party",
      widgetText: "w".repeat(50_000),
    });
    expect(chat.widgets["third-party"]).toHaveLength(20_000);
    chat = applyAgentEvent({ ...chat }, {
      type: "extension_ui_request",
      method: "setWidget",
      widgetKey: "__proto__",
      widgetText: "pollute",
    });
    expect(Object.prototype).not.toHaveProperty("pollute");
    expect(Object.keys(chat.widgets)).toEqual(["third-party"]);
  });

  it("validates reserved harness widget payloads before exposing them to the UI", () => {
    let chat = applyAgentEvent(emptyChatState(), {
      type: "extension_ui_request",
      method: "setWidget",
      widgetKey: "pi-app-workflow-state",
      widgetText: JSON.stringify({ steps: "not-an-array", events: [], intent: {} }),
    });
    expect(chat.workflow).toBeNull();

    chat = applyAgentEvent({ ...chat }, {
      type: "extension_ui_request",
      method: "setWidget",
      widgetKey: "pi-app-workflow-state",
      widgetText: JSON.stringify({
        runId: "run-1",
        objective: "Verify extension input",
        profile: "bug",
        status: "active",
        approved: false,
        intent: { primary: "debug", risk: "high", signals: ["extension"] },
        steps: [{ id: "gate", label: "Gate", kind: "gate", deps: [], status: "running", acceptance: "passes", owner: "gate-runner", attempts: 1 }],
        events: [],
      }),
    });
    expect(chat.workflow?.steps[0].id).toBe("gate");
    expect(chat.workflow?.intent.signals).toEqual(["extension"]);

    chat = applyAgentEvent({ ...chat }, {
      type: "extension_ui_request",
      method: "setWidget",
      widgetKey: "pi-app-background-state",
      widgetText: JSON.stringify({ id: "not-an-array" }),
    });
    expect(chat.backgroundTasks).toEqual([]);

    chat = applyAgentEvent({ ...chat }, {
      type: "extension_ui_request",
      method: "setWidget",
      widgetKey: "pi-app-background-state",
      widgetText: JSON.stringify([
        { id: "task-1", type: "reviewer", description: "Review", status: "running", transcript: "x".repeat(80_000) },
        { id: "task-2", status: "unknown" },
      ]),
    });
    expect(chat.backgroundTasks).toHaveLength(1);
    expect(chat.backgroundTasks[0].transcript).toHaveLength(60_000);

    chat = applyAgentEvent({ ...chat }, {
      type: "extension_ui_request",
      method: "setWidget",
      widgetKey: "pi-app-preview-state",
      widgetLines: [JSON.stringify({
        status: "ready",
        serverId: "prev-1",
        url: "http://localhost:1420",
        port: 1420,
        running: true,
        ready: true,
        browserOpened: true,
        browserInspected: true,
        logs: ["ready"],
        updatedAt: 123,
        source: "agent",
      })],
    });
    expect(chat.previewRuntime).toMatchObject({
      status: "ready",
      serverId: "prev-1",
      ready: true,
      browserInspected: true,
    });

    chat = applyAgentEvent({ ...chat }, {
      type: "extension_ui_request",
      method: "setWidget",
      widgetKey: "pi-app-preview-state",
      widgetText: JSON.stringify({ status: "unknown", serverId: "spoof" }),
    });
    expect(chat.previewRuntime?.serverId).toBe("prev-1");
  });

  it("strips leading emoji from toasts and dedupes repeats", () => {
    let chat = applyAgentEvent(emptyChatState(), {
      type: "extension_ui_request",
      method: "notify",
      message: "🧠 Session backfill complete: 0 indexed",
      notificationType: "info",
    });
    expect(chat.toasts.at(-1)?.text).toBe("Session backfill complete: 0 indexed");

    // повтор того же текста не создаёт второй тост
    chat = applyAgentEvent({ ...chat }, {
      type: "extension_ui_request",
      method: "notify",
      message: "🧠 Session backfill complete: 0 indexed",
      notificationType: "info",
    });
    expect(chat.toasts).toHaveLength(1);

    expect(stripLeadingEmoji("✅ done")).toBe("done");
    expect(stripLeadingEmoji("обычный текст")).toBe("обычный текст");
    expect(stripLeadingEmoji("⚠️  warning text")).toBe("warning text");
  });

  it("caps giant tool outputs (head + tail)", () => {
    const big = "x".repeat(400_000);
    const chat = applyAgentEvent(emptyChatState(), {
      type: "tool_execution_end",
      toolCallId: "c9",
      result: { content: [{ type: "text", text: big }] },
      isError: false,
    });
    expect(chat.toolExecs.c9.output.length).toBeLessThan(120_000);
    expect(chat.toolExecs.c9.output).toContain("вывод усечён");
  });

  it("prunes outputs of the oldest tool execs to bound memory", () => {
    let chat = emptyChatState();
    for (let i = 0; i < 360; i++) {
      chat = applyAgentEvent({ ...chat }, {
        type: "tool_execution_end",
        toolCallId: `t${i}`,
        result: { content: [{ type: "text", text: `output-of-${i} ${"y".repeat(500)}` }] },
        isError: false,
      });
    }
    // самый старый вывод выгружен до маркера, свежий — цел
    expect(chat.toolExecs.t0.output).toContain("выгружен для экономии памяти");
    expect(chat.toolExecs.t359.output).toContain("output-of-359");
    // структура (имя/статус) сохранена даже у выгруженных
    expect(chat.toolExecs.t0.done).toBe(true);
  });

  it("tracks compaction and retry state", () => {
    let chat = applyAgentEvent(emptyChatState(), { type: "compaction_start", reason: "threshold" });
    expect(chat.isCompacting).toBe(true);
    chat = applyAgentEvent({ ...chat }, { type: "compaction_end", summary: "..." });
    expect(chat.isCompacting).toBe(false);
    expect(chat.compactions.at(-1)?.summary).toBe("...");

    chat = applyAgentEvent({ ...chat }, { type: "auto_retry_start", attempt: 2 });
    expect(chat.retryActive).toBe(true);
    chat = applyAgentEvent({ ...chat }, { type: "auto_retry_end", success: true });
    expect(chat.retryActive).toBe(false);
  });

  it("tracks the latest model-generated todo backlog live", () => {
    const chat = applyAgentEvent(emptyChatState(), {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "todo-1",
        toolName: "todo",
        content: [{ type: "text", text: "Created #2" }],
        details: {
          tasks: [
            { id: 1, subject: "Inspect contract", status: "completed" },
            { id: 2, subject: "Implement migration", activeForm: "implementing migration", status: "in_progress", blockedBy: [1] },
          ],
        },
      },
    });
    expect(chat.plannedTasks).toEqual([
      expect.objectContaining({ id: 1, status: "completed" }),
      expect.objectContaining({ id: 2, activeForm: "implementing migration", blockedBy: [1] }),
    ]);
  });
});

describe("entriesToChatState", () => {
  it("restores workflow, tasks, compaction, checkpoint, and rewind metadata", () => {
    const workflow = {
      version: 3,
      runId: "wf-1",
      profile: "feature",
      approved: true,
      steps: [],
      events: [],
      intent: {},
    };
    const chat = entriesToChatState([
      { type: "custom", customType: "pi-app-workflow-state", data: workflow },
      { type: "custom", customType: "subagents:record", data: { id: "a1", type: "reviewer", description: "review", status: "completed", result: "ok" } },
      { type: "compaction", timestamp: "2026-07-18T00:00:00Z", summary: "compact summary", tokensBefore: 200000, firstKeptEntryId: "e1" },
      { type: "custom", customType: "pi-app-checkpoint", data: { at: 2, objective: "ship", nextReadySteps: ["verify"] } },
      { type: "custom", customType: "pi-app-rewind-record", data: { at: 3, abandonedLeafId: "leaf-old", targetEntryId: "u1", stoppedTaskIds: ["a1"] } },
      { type: "message", message: { role: "toolResult", toolCallId: "todo-1", toolName: "todo", content: [], details: { tasks: [{ id: 1, subject: "Verify UI", status: "pending", owner: "main" }] } } },
    ]);
    expect(chat.workflow?.runId).toBe("wf-1");
    expect(chat.backgroundTasks[0]).toMatchObject({ id: "a1", result: "ok" });
    expect(chat.compactions[0]).toMatchObject({ summary: "compact summary", tokensBefore: 200000 });
    expect(chat.structuredCheckpoints[0].nextReadySteps).toEqual(["verify"]);
    expect(chat.branches[0]).toMatchObject({ abandonedLeafId: "leaf-old", stoppedTaskIds: ["a1"] });
    expect(chat.plannedTasks[0]).toMatchObject({ id: 1, subject: "Verify UI", owner: "main" });
  });

  it("builds a read-only timeline from session JSONL entries", () => {
    const chat = entriesToChatState([
      { type: "session", id: "s1", cwd: "/tmp" },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "q" }] } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "a" },
            { type: "toolCall", id: "c1", name: "bash", arguments: { command: "pwd" } },
          ],
        },
      },
      {
        type: "message",
        message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "/tmp" }], isError: false },
      },
      { type: "model_change", provider: "x", modelId: "y" },
    ]);
    expect(chat.items).toHaveLength(2);
    expect(chat.toolExecs.c1.output).toBe("/tmp");
    expect(chat.toolExecs.c1.done).toBe(true);
  });

  it("reconstructs run summaries («Worked for») so they survive app restarts", () => {
    // два хода: у первого длительность из метаданных pi-claude-style-tools,
    // у второго — из разницы timestamp'ов записей
    const chat = entriesToChatState([
      { type: "message", timestamp: "2026-07-11T18:49:54.978Z", message: { role: "user", content: [{ type: "text", text: "сделай" }] } },
      {
        type: "message",
        timestamp: "2026-07-11T18:49:56.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "смотрю" },
            { type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } },
            { type: "toolCall", id: "r2", name: "bash", arguments: { command: "ls" } },
          ],
        },
      },
      { type: "message", timestamp: "2026-07-11T18:49:58.000Z", message: { role: "toolResult", toolCallId: "r1", content: [{ type: "text", text: "ok" }] } },
      { type: "message", timestamp: "2026-07-11T18:49:59.000Z", message: { role: "toolResult", toolCallId: "r2", content: [{ type: "text", text: "ok" }] } },
      {
        type: "message",
        timestamp: "2026-07-11T18:50:01.783Z",
        message: { role: "assistant", content: [{ type: "text", text: "готово" }], _piClaudeStyleWorkedDurationMs: 6807 },
      },
      { type: "message", timestamp: "2026-07-11T18:55:00.000Z", message: { role: "user", content: [{ type: "text", text: "ещё" }] } },
      {
        type: "message",
        timestamp: "2026-07-11T18:55:09.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "и это" },
            { type: "toolCall", id: "r3", name: "edit", arguments: {} },
          ],
        },
      },
    ]);
    expect(chat.items).toHaveLength(5);
    // ран прикреплён к ПОСЛЕДНЕМУ assistant-сообщению хода со всеми инструментами
    const firstRun = chat.items[2].msg.run;
    expect(firstRun?.toolCallIds).toEqual(["r1", "r2"]);
    expect(firstRun?.durationMs).toBe(6807);
    expect(chat.items[1].msg.run).toBeUndefined();
    // второй ход: длительность из timestamp'ов (9с)
    const secondRun = chat.items[4].msg.run;
    expect(secondRun?.toolCallIds).toEqual(["r3"]);
    expect(secondRun?.durationMs).toBe(9000);
  });

  it("does not attach runs to tool-less turns", () => {
    const chat = entriesToChatState([
      { type: "message", message: { role: "user", content: [{ type: "text", text: "привет" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Привет!" }] } },
    ]);
    expect(chat.items[1].msg.run).toBeUndefined();
  });
});

describe("agent_end run attachment", () => {
  it("uses pi-claude-style worked duration when present and records lastRunId", () => {
    let chat = emptyChatState();
    chat = applyAgentEvent({ ...chat }, { type: "agent_start" });
    chat = applyAgentEvent({ ...chat }, {
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "go" }] },
    });
    chat = applyAgentEvent({ ...chat }, { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} });
    chat = applyAgentEvent({ ...chat }, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }], _piClaudeStyleWorkedDurationMs: 4321 },
    });
    chat = applyAgentEvent({ ...chat }, { type: "agent_end" });
    const run = chat.items.at(-1)?.msg.run;
    expect(run?.durationMs).toBe(4321);
    expect(chat.lastRunId).toBe(run?.id ?? null);
  });

  it("does not steal the run onto the previous turn when aborted before a reply", () => {
    let chat = emptyChatState();
    // прошлый ход с прикреплённым раном
    chat = applyAgentEvent({ ...chat }, { type: "agent_start" });
    chat = applyAgentEvent({ ...chat }, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "первый" }] } });
    chat = applyAgentEvent({ ...chat }, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ответ" }] } });
    chat = applyAgentEvent({ ...chat }, { type: "agent_end" });
    const prevRunId = chat.items.at(-1)?.msg.run?.id;
    expect(prevRunId).toBeTruthy();

    // новый ход: prompt отправлен, но прерван до первого ответа
    chat = applyAgentEvent({ ...chat }, { type: "agent_start" });
    chat = applyAgentEvent({ ...chat }, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "второй" }] } });
    chat = applyAgentEvent({ ...chat }, { type: "agent_end" });

    // ран прошлого хода не перезаписан пустым, lastRunId не выставлен
    expect(chat.items[1].msg.run?.id).toBe(prevRunId);
    expect(chat.lastRunId).toBeNull();
  });
});
