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
    chat = applyAgentEvent({ ...chat }, { type: "extension_ui_request", method: "setWidget", widgetKey: "todos" });
    expect(chat.widgets.todos).toBeUndefined();
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
    expect(chat.toolExecs.c9.output.length).toBeLessThan(200_000);
    expect(chat.toolExecs.c9.output).toContain("вывод усечён");
  });

  it("tracks compaction and retry state", () => {
    let chat = applyAgentEvent(emptyChatState(), { type: "compaction_start", reason: "threshold" });
    expect(chat.isCompacting).toBe(true);
    chat = applyAgentEvent({ ...chat }, { type: "compaction_end", summary: "..." });
    expect(chat.isCompacting).toBe(false);

    chat = applyAgentEvent({ ...chat }, { type: "auto_retry_start", attempt: 2 });
    expect(chat.retryActive).toBe(true);
    chat = applyAgentEvent({ ...chat }, { type: "auto_retry_end", success: true });
    expect(chat.retryActive).toBe(false);
  });
});

describe("entriesToChatState", () => {
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
});
