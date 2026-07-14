import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addUserMessage, applyAgentEvent, contentText } from "./reducer";
import { buildTranscript } from "./transcript";
import { emptyChatState, type ChatState } from "./types";

/**
 * Реальный поток RPC-событий pi 0.80.3, снятый с живого агента (локальная модель
 * + bash-инструмент): `pi --mode rpc` → src/lib/__fixtures__/pi-rpc-turn.jsonl.
 *
 * Мок в backend.ts — упрощение; эти тесты гоняют НАСТОЯЩУЮ последовательность,
 * чтобы «в процессе ничего не видно» не могло вернуться незамеченным.
 */
const events: Record<string, unknown>[] = readFileSync(
  join(__dirname, "__fixtures__", "pi-rpc-turn.jsonl"),
  "utf8",
)
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Record<string, unknown>);

/** Есть ли прямо сейчас что показать в ленте (кроме индикатора «работает»). */
function visibleLiveContent(chat: ChatState): { text: string; thinking: string; toolCalls: number } {
  const blocks = Array.isArray(chat.streaming?.content) ? chat.streaming!.content : [];
  return {
    text: contentText(chat.streaming?.content).trim(),
    thinking: blocks
      .filter((b) => b.type === "thinking" && typeof b.thinking === "string")
      .map((b) => b.thinking as string)
      .join("")
      .trim(),
    toolCalls: blocks.filter((b) => b.type === "toolCall").length,
  };
}

describe("live turn against the real pi RPC stream", () => {
  it("streams reasoning while the model is still working (not only post factum)", () => {
    let chat = emptyChatState();
    chat = addUserMessage({ ...chat }, "Run: cat note.txt  then tell me what it says");

    let sawThinkingWhileStreaming = false;
    let sawToolCallWhileStreaming = false;
    let firstVisibleAt = -1;

    events.forEach((event, index) => {
      chat = applyAgentEvent({ ...chat }, event);
      if (!chat.isStreaming) return;
      const live = visibleLiveContent(chat);
      if (live.thinking) {
        sawThinkingWhileStreaming = true;
        if (firstVisibleAt < 0) firstVisibleAt = index;
      }
      if (live.toolCalls > 0) sawToolCallWhileStreaming = true;
    });

    // до agent_end пользователь обязан видеть и рассуждения, и вызов инструмента
    expect(sawThinkingWhileStreaming).toBe(true);
    expect(sawToolCallWhileStreaming).toBe(true);
    // и это должно случиться рано, а не в самом конце потока
    expect(firstVisibleAt).toBeGreaterThan(0);
    expect(firstVisibleAt).toBeLessThan(events.length / 2);
  });

  it("keeps isStreaming true across the whole multi-step turn", () => {
    let chat = emptyChatState();
    const streamingFlags: boolean[] = [];
    for (const event of events) {
      chat = applyAgentEvent({ ...chat }, event);
      const type = event.type as string;
      // turn_end/turn_start приходят МЕЖДУ шагами одного хода (LLM-вызов + тулы):
      // ход не должен «завершаться» на них, иначе процесс схлопнется на середине
      if (type === "turn_end") streamingFlags.push(chat.isStreaming);
    }
    expect(streamingFlags.length).toBeGreaterThan(1);
    expect(streamingFlags.every(Boolean)).toBe(true);
  });

  it("never collapses the turn into «Worked for» while it is still running", () => {
    let chat = emptyChatState();
    chat = addUserMessage({ ...chat }, "Run: cat note.txt  then tell me what it says");

    let sawVisibleStepInFeed = false;
    for (const event of events) {
      chat = applyAgentEvent({ ...chat }, event);
      const view = buildTranscript(chat.items, chat.toolExecs, chat.isStreaming, "normal");
      if (chat.isStreaming) {
        // пока ход идёт — ничего не свёрнуто и ничего не спрятано
        expect(view.summaryAt.size).toBe(0);
        expect([...view.renderMode.values()]).toEqual([]);
        const assistantCount = chat.items.filter((it) => it.msg.role === "assistant").length;
        if (assistantCount > 0) {
          expect(view.liveTurnIndexes.size).toBeGreaterThan(0);
          sawVisibleStepInFeed = true;
        }
      }
    }
    // промежуточные шаги хода реально доезжали до ленты живьём
    expect(sawVisibleStepInFeed).toBe(true);

    // и только после agent_end ход сворачивается
    const done = buildTranscript(chat.items, chat.toolExecs, chat.isStreaming, "normal");
    expect(chat.isStreaming).toBe(false);
    expect(done.summaryAt.size).toBe(1);
    expect(done.liveTurnIndexes.size).toBe(0);
  });

  it("finalizes the turn once, with every tool call attached to the run", () => {
    let chat = emptyChatState();
    chat = addUserMessage({ ...chat }, "Run: cat note.txt  then tell me what it says");
    for (const event of events) chat = applyAgentEvent({ ...chat }, event);

    expect(chat.isStreaming).toBe(false);
    const assistants = chat.items.filter((it) => it.msg.role === "assistant");
    expect(assistants.length).toBeGreaterThanOrEqual(2);
    const run = assistants.at(-1)!.msg.run;
    expect(run?.toolCallIds.length).toBeGreaterThan(0);
    // toolResult не попадает в ленту — он сворачивается в exec инструмента
    expect(chat.items.some((it) => it.msg.role === "toolResult")).toBe(false);
    for (const id of run!.toolCallIds) expect(chat.toolExecs[id]?.done).toBe(true);
  });
});
