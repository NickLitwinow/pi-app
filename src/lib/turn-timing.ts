// Разбор строки «✻ Turn took 49s (Total time 2m 57s · 3 turns)», которую
// расширение pi-claude-style-tools дописывает В КОНЕЦ последнего текстового
// блока финального assistant-сообщения (с ANSI-цветом), и его же message-level
// метаданных _piClaudeStyleWorked*. GUI вырезает строку из текста и рисует
// карточку в стиле ChatGPT/Claude.

import { stripAnsi } from "./markdown";
import type { ChatMessage } from "./types";

export interface TurnTiming {
  turn: string;
  total: string | null;
  turns: number | null;
}

// Message-level ключи pi-claude-style-tools (персистятся в JSONL сессии).
export const WORKED_MS_KEY = "_piClaudeStyleWorkedDurationMs";
export const WORKED_TOTAL_MS_KEY = "_piClaudeStyleWorkedSessionTotalMs";
export const WORKED_TURNS_KEY = "_piClaudeStyleWorkedTurns";

// «(Total time … · N turns)» опционален: расширение печатает его только когда
// знает суммарные значения. Захваты без скобок, чтобы «хвост после скобок» не
// склеивался в turn при бэктрекинге.
const TIMING_RE =
  /^[✻✳*•\s]*Turn took\s+([^()\n]+?)\s*(?:\(Total time\s+([^()·•\n]+?)\s*[·•]\s*(\d+)\s+turns?\s*\))?\s*$/i;

/** Полное совпадение: текст (после stripAnsi/trim) — только строка тайминга. */
export function parseTurnTiming(text: string): TurnTiming | null {
  const match = stripAnsi(text).trim().match(TIMING_RE);
  if (!match || !match[1]) return null;
  return {
    turn: match[1].trim(),
    total: match[2]?.trim() ?? null,
    turns: match[3] != null ? Number(match[3]) : null,
  };
}

/**
 * Отделить хвостовую строку тайминга от текста блока. Возвращает body без
 * timing-строк (и без завершающих пустых строк) и разобранный тайминг
 * последней из них. Если строки нет — body возвращается как есть.
 */
export function splitTrailingTurnTiming(text: string): { body: string; timing: TurnTiming | null } {
  if (!text.includes("Turn took")) return { body: text, timing: null };
  const lines = text.split("\n");
  let timing: TurnTiming | null = null;
  const kept: string[] = [];
  for (const line of lines) {
    const parsed = parseTurnTiming(line);
    if (parsed) {
      timing = parsed; // последняя строка тайминга — актуальная
      continue;
    }
    kept.push(line);
  }
  if (!timing) return { body: text, timing: null };
  const body = kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
  return { body, timing };
}

function numberField(msg: ChatMessage, key: string): number | null {
  const value = msg[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Длительность хода из метаданных pi-claude-style-tools (если записаны). */
export function workedDurationMs(msg: ChatMessage): number | null {
  return numberField(msg, WORKED_MS_KEY);
}

export function formatRunDuration(durationMs: number): string {
  // floor, как у pi-claude-style-tools: иначе «Worked for 22s» спорит со
  // строкой «Turn took 21s» того же хода
  const seconds = Math.max(1, Math.floor(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/**
 * Тайминг из метаданных сообщения — запасной путь, когда текстовой строки нет
 * (например, строка отключена в конфиге расширения, а метаданные пишутся).
 */
export function timingFromWorkedMeta(msg: ChatMessage): TurnTiming | null {
  const ms = workedDurationMs(msg);
  if (ms == null) return null;
  const totalMs = numberField(msg, WORKED_TOTAL_MS_KEY);
  const turns = numberField(msg, WORKED_TURNS_KEY);
  return {
    turn: formatRunDuration(ms),
    total: totalMs != null ? formatRunDuration(totalMs) : null,
    turns: turns != null && turns > 0 ? turns : null,
  };
}
