// Раскладка ленты чата (Codex-стиль). Чистая функция — её гоняют тесты на
// РЕАЛЬНОМ потоке событий pi, потому что баг «в процессе ничего не видно»
// живёт именно здесь, а не в reducer'е.

import { stripAnsi } from "./markdown";
import { workedDurationMs } from "./turn-timing";
import type { ChatMessage, ContentBlock, RunMeta, ToolExec } from "./types";

export type ActivityStep =
  | { kind: "thinking"; text: string; key: string }
  | { kind: "text"; text: string; key: string }
  | { kind: "tool"; block: ContentBlock; exec: ToolExec | undefined; key: string };

export interface TurnSummary {
  steps: ActivityStep[];
  durationMs: number;
  actionCount: number;
  failedCount: number;
  provider: string;
  modelId: string;
}

export type RenderMode = "full" | "answer" | "hidden";

export interface Transcript {
  /** Как рисовать сообщение по индексу (по умолчанию "full"). */
  renderMode: Map<number, RenderMode>;
  /** Свёрнутая сводка хода — на индексе ПЕРВОГО сообщения хода. */
  summaryAt: Map<number, TurnSummary>;
  /** Карточка изменённых файлов — на индексе последнего сообщения хода. */
  filesAt: Map<number, RunMeta>;
  /** Сообщения идущего хода: рассуждения раскрыты, статичные шапки скрыты. */
  liveTurnIndexes: Set<number>;
}

function turnModel(items: { msg: ChatMessage }[], first: number, last: number): { provider: string; modelId: string } {
  for (let k = last; k >= first; k--) {
    const m = items[k].msg;
    if (typeof m.model === "string" && m.model) {
      return { provider: typeof m.provider === "string" ? m.provider : "", modelId: m.model };
    }
  }
  return { provider: "", modelId: "" };
}

/**
 * Ход = user → серия assistant-сообщений. Пока ход идёт, показываем весь процесс
 * живьём; по завершении процесс сворачивается в «Worked for», а итоговый текст
 * последнего сообщения остаётся отдельным ответом.
 *
 * `isStreaming` обязан быть true в течение ВСЕГО хода: pi шлёт turn_end/turn_start
 * между шагами (LLM-вызов + инструменты), и ход не должен схлопываться на середине.
 */
export function buildTranscript(
  items: { msg: ChatMessage }[],
  toolExecs: Record<string, ToolExec>,
  isStreaming: boolean,
  transcriptMode: "summary" | "normal" | "verbose",
): Transcript {
  const renderMode = new Map<number, RenderMode>();
  const summaryAt = new Map<number, TurnSummary>();
  const filesAt = new Map<number, RunMeta>();
  const liveTurnIndexes = new Set<number>();

  let i = 0;
  while (i < items.length) {
    if (items[i].msg.role !== "assistant") {
      i++;
      continue;
    }
    const first = i;
    let j = i;
    while (j < items.length && items[j].msg.role === "assistant") j++;
    const last = j - 1;

    // живой ход: агент стримит и эта группа — хвост ленты (нового user ещё нет)
    const isLive = isStreaming && last === items.length - 1;
    if (isLive) for (let k = first; k <= last; k++) liveTurnIndexes.add(k);

    const steps: ActivityStep[] = [];
    let actionCount = 0;
    let failedCount = 0;
    for (let k = first; k <= last; k++) {
      const m: ChatMessage = items[k].msg;
      if (!Array.isArray(m.content)) continue;
      m.content.forEach((b, bi) => {
        if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
          steps.push({ kind: "thinking", text: b.thinking, key: `t${k}-${bi}` });
        } else if (b.type === "toolCall" && typeof b.id === "string") {
          const exec = toolExecs[b.id];
          steps.push({ kind: "tool", block: b, exec, key: b.id });
          actionCount++;
          if (exec?.isError) failedCount++;
        } else if (b.type === "text" && typeof b.text === "string" && stripAnsi(b.text).trim()) {
          // текст ПОСЛЕДНЕГО сообщения = итоговый ответ, не шаг процесса
          if (k !== last) steps.push({ kind: "text", text: b.text, key: `x${k}-${bi}` });
        }
      });
    }

    const hasProcess = steps.some((s) => s.kind === "thinking" || s.kind === "tool");
    const run = items[last].msg.run;
    if (hasProcess && !isLive && transcriptMode !== "verbose") {
      const { provider, modelId } = turnModel(items, first, last);
      summaryAt.set(first, {
        steps,
        durationMs: run?.durationMs ?? workedDurationMs(items[last].msg) ?? 0,
        actionCount,
        failedCount,
        provider,
        modelId,
      });
      for (let k = first; k < last; k++) renderMode.set(k, "hidden");
      renderMode.set(last, "answer");
    }
    if (run?.files?.length) filesAt.set(last, run);
    i = j;
  }
  return { renderMode, summaryAt, filesAt, liveTurnIndexes };
}
