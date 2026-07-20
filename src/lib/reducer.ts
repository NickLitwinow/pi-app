import { workedDurationMs } from "./turn-timing";
import {
  emptyChatState,
  type BackgroundTaskView,
  type BranchRecord,
  type ChatMessage,
  type ChatState,
  type CompactionRecord,
  type ExtUiRequest,
  type PlannedTaskView,
  type RunMeta,
  type StructuredCheckpoint,
  type ToolExec,
  type WorkflowViewState,
} from "./types";

let keyCounter = 0;
let runCounter = 0;
function nextKey(): string {
  return `k${++keyCounter}`;
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(asString).join("");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (typeof o.message === "string") return o.message;
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** Extract concatenated text from message content (string or blocks). */
export function contentText(content: ChatMessage["content"] | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/** Убрать ведущие emoji/пиктограммы из текстов расширений («🧠 Session…») —
 *  вид уведомлений задаёт приложение, а не расширение. */
export function stripLeadingEmoji(s: string): string {
  return s.replace(
    /^(?:[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2049}\u{203C}]|\s)+/u,
    "",
  );
}

function pushToast(chat: ChatState, kind: "info" | "error" | "success" | "warning", text: string) {
  const clean = stripLeadingEmoji(text).trim() || text.trim();
  if (!clean) return;
  // дубль уже видимого тоста не добавляем (расширения любят повторять)
  if (chat.toasts.some((t) => t.text === clean)) return;
  chat.toasts = [...chat.toasts, { id: Date.now() + Math.random(), kind, text: clean }].slice(-5);
}

/** Кап накопленного вывода инструмента: голова + хвост, середина заменяется
 *  маркером. Экономит память на мегабайтных выводах bash/read. */
const TOOL_OUTPUT_CAP = 60_000;
function capOutput(s: string): string {
  if (s.length <= TOOL_OUTPUT_CAP) return s;
  const half = TOOL_OUTPUT_CAP / 2;
  return `${s.slice(0, half)}\n… [вывод усечён: ${s.length.toLocaleString("ru-RU")} символов] …\n${s.slice(-half)}`;
}

/** Сколько завершённых tool-выводов держим в памяти целиком. При длинной задаче
 *  (тысячи вызовов) старые «сдуваются» до маркера — полный вывод есть в файле
 *  сессии и вернётся при переоткрытии. Ограничивает рост RAM, не теряя данные. */
const MAX_LIVE_TOOL_OUTPUTS = 300;
const DROPPED_MARKER = "[вывод выгружен для экономии памяти — переоткройте сессию, чтобы загрузить из файла]";

function pruneToolExecs(chat: ChatState) {
  const keys = Object.keys(chat.toolExecs);
  if (keys.length <= MAX_LIVE_TOOL_OUTPUTS) return;
  // объектные ключи хранят порядок вставки — старые идут первыми
  const dropCount = keys.length - MAX_LIVE_TOOL_OUTPUTS;
  let mutated = false;
  const next = { ...chat.toolExecs };
  for (let i = 0; i < dropCount; i++) {
    const k = keys[i];
    const e = next[k];
    if (e && e.done && e.output && e.output !== DROPPED_MARKER && e.output.length > 200) {
      next[k] = { ...e, output: DROPPED_MARKER };
      mutated = true;
    }
  }
  if (mutated) chat.toolExecs = next;
}

function upsertExec(chat: ChatState, callId: string, patch: Partial<ToolExec>) {
  const prev: ToolExec = chat.toolExecs[callId] ?? {
    callId,
    name: "",
    args: undefined,
    output: "",
    isError: false,
    done: false,
  };
  if (typeof patch.output === "string") patch.output = capOutput(patch.output);
  chat.toolExecs = { ...chat.toolExecs, [callId]: { ...prev, ...patch } };
  if (patch.done) pruneToolExecs(chat);
}

function resultText(v: unknown): string {
  if (v && typeof v === "object" && "content" in (v as object)) {
    return contentText((v as ChatMessage).content);
  }
  return asString(v);
}

function capturePlannedTasks(chat: ChatState, msg: ChatMessage) {
  if (msg.toolName !== "todo") return;
  const details = msg.details as { tasks?: unknown } | undefined;
  if (!Array.isArray(details?.tasks)) return;
  chat.plannedTasks = details.tasks.filter((task): task is PlannedTaskView => {
    if (!task || typeof task !== "object") return false;
    const item = task as Partial<PlannedTaskView>;
    return typeof item.id === "number" && typeof item.subject === "string"
      && ["pending", "in_progress", "completed", "deleted"].includes(String(item.status));
  });
}

function finalizeMessage(chat: ChatState, msg: ChatMessage) {
  const role = msg.role;
  if (role === "toolResult") {
    capturePlannedTasks(chat, msg);
    const callId = (msg.toolCallId as string) ?? "";
    if (callId) {
      upsertExec(chat, callId, {
        name: (msg.toolName as string) || chat.toolExecs[callId]?.name || "",
        output: contentText(msg.content) || chat.toolExecs[callId]?.output || "",
        isError: Boolean(msg.isError),
        done: true,
      });
    }
    return;
  }
  if (role === "user") {
    // user prompts are added optimistically on send; эхо от pi поглощает ровно ОДИН
    // непогашенный optimistic-элемент. Сначала точное совпадение текста; если его
    // нет, но optimistic ждёт — расширение переписало prompt (напр. pi-goal
    // оборачивает цель) → эхо считается истиной и ЗАМЕНЯЕТ optimistic-элемент.
    // Эхо вовсе без пары = сообщение отправило расширение, не пользователь —
    // помечаем viaExtension (бейдж в UI вместо маскировки под пользователя).
    const text = contentText(msg.content);
    const from = Math.max(0, chat.items.length - 6);
    for (let i = chat.items.length - 1; i >= from; i--) {
      const it = chat.items[i];
      if (it.optimistic && it.msg.role === "user" && contentText(it.msg.content) === text) {
        const items = [...chat.items];
        // The persisted/runtime echo is authoritative and includes image blocks.
        items[i] = { key: it.key, msg, optimistic: false };
        chat.items = items;
        return;
      }
    }
    for (let i = chat.items.length - 1; i >= from; i--) {
      const it = chat.items[i];
      if (it.optimistic && it.msg.role === "user") {
        const items = [...chat.items];
        items[i] = { key: it.key, msg, optimistic: false };
        chat.items = items;
        return;
      }
    }
    chat.items = [...chat.items, { key: nextKey(), msg, viaExtension: true }];
    return;
  }
  // assistant (and unknown roles worth showing)
  chat.items = [...chat.items, { key: nextKey(), msg }];
  chat.streaming = null;
}

function normalizeQueue(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => asString(x)).filter(Boolean);
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/**
 * Applies one pi RPC event to a chat draft. The store clones the top-level
 * object before calling this; nested collections are replaced immutably so
 * React re-renders on identity change.
 *
 * Wire shapes verified against pi 0.80.3 RPC output:
 *  - message_update carries assistantMessageEvent.partial = the full
 *    accumulated assistant message (authoritative streaming snapshot);
 *  - message_start/message_end fire for user and toolResult messages too;
 *  - tool_execution_update carries partialResult.content blocks.
 */
export function applyAgentEvent(chat: ChatState, ev: Record<string, unknown>): ChatState {
  chat.seq++;
  const type = ev.type as string;

  switch (type) {
    case "agent_start": {
      chat.isStreaming = true;
      chat.streamStartedAt = Date.now();
      chat.activeRunId = `run-${Date.now().toString(36)}-${(++runCounter).toString(36)}`;
      chat.activeRunToolIds = [];
      chat.lastError = null;
      break;
    }
    case "agent_end": {
      const durationMs = chat.streamStartedAt ? Math.max(0, Date.now() - chat.streamStartedAt) : 0;
      // Ход = ровно agent_start … agent_end (проверено захватом живого потока pi,
      // см. __fixtures__/pi-rpc-turn.jsonl): МЕЖДУ шагами хода (LLM-вызов + инструменты)
      // pi шлёт turn_end/turn_start, а agent_end приходит ОДИН раз в самом конце.
      // Поэтому здесь ход честно завершается.
      chat.isStreaming = false;
      // Defensive: a streamed message that never got its message_end.
      if (chat.streaming && contentText(chat.streaming.content)) {
        finalizeMessage(chat, chat.streaming);
      }
      chat.streaming = null;
      chat.lastRunId = null;
      if (chat.activeRunId) {
        for (let index = chat.items.length - 1; index >= 0; index--) {
          const item = chat.items[index];
          // ран прерван до первого ответа — не приписывать его ассистенту ПРОШЛОГО хода
          if (item.msg.role === "user") break;
          if (item.msg.role !== "assistant") continue;
          const items = [...chat.items];
          items[index] = {
            ...item,
            msg: {
              ...item.msg,
              run: {
                id: chat.activeRunId,
                // pi-claude-style-tools пишет точную длительность в метаданные
                // финального сообщения; наш таймер — запасной вариант
                durationMs: workedDurationMs(item.msg) ?? durationMs,
                toolCallIds: [...chat.activeRunToolIds],
              },
            },
          };
          chat.items = items;
          chat.lastRunId = chat.activeRunId;
          break;
        }
      }
      chat.streamStartedAt = null;
      chat.activeRunId = null;
      chat.activeRunToolIds = [];
      break;
    }
    case "message_start": {
      const msg = ev.message as ChatMessage | undefined;
      const role = msg?.role;
      // ВАЖНО: эхо user-сообщения приходит в НАЧАЛЕ хода (сразу после agent_start),
      // а не в конце — завершать ход по нему нельзя, иначе процесс схлопывается
      // на третьем событии, ещё до первого ответа модели.
      if (!role || role === "assistant") {
        chat.streaming = msg ?? { role: "assistant", content: [] };
      }
      break;
    }
    case "message_update": {
      const e = (ev.assistantMessageEvent ?? {}) as Record<string, unknown>;
      const partial = (e.partial ?? ev.message) as ChatMessage | undefined;
      if (partial && partial.role === "assistant") {
        chat.streaming = { ...partial };
      }
      if ((e.type as string) === "error") {
        chat.lastError = asString(e.error ?? e.reason ?? e);
      }
      break;
    }
    case "message_end": {
      const msg = ev.message as ChatMessage | undefined;
      if (msg) finalizeMessage(chat, msg);
      else chat.streaming = null;
      break;
    }
    case "tool_execution_start": {
      const callId = asString(ev.toolCallId ?? ev.id ?? "");
      if (callId) {
        if (!chat.activeRunToolIds.includes(callId)) chat.activeRunToolIds = [...chat.activeRunToolIds, callId];
        upsertExec(chat, callId, {
          name: asString(ev.toolName ?? ev.name ?? ""),
          args: ev.args,
          done: false,
        });
      }
      break;
    }
    case "tool_execution_update": {
      const callId = asString(ev.toolCallId ?? ev.id ?? "");
      if (callId) {
        const text = resultText(ev.partialResult ?? ev.partial ?? ev.result);
        if (text) {
          const prev = chat.toolExecs[callId]?.output ?? "";
          // partial payloads are cumulative; keep the longer variant
          upsertExec(chat, callId, { output: text.length >= prev.length ? text : prev });
        }
      }
      break;
    }
    case "tool_execution_end": {
      const callId = asString(ev.toolCallId ?? ev.id ?? "");
      if (callId) {
        upsertExec(chat, callId, {
          output: resultText(ev.result) || chat.toolExecs[callId]?.output || "",
          isError: Boolean(ev.isError),
          done: true,
        });
      }
      break;
    }
    case "queue_update": {
      chat.queue = {
        steering: normalizeQueue(ev.steering ?? (ev as Record<string, unknown>).steeringMessages),
        followUp: normalizeQueue(ev.followUp ?? (ev as Record<string, unknown>).followUpMessages),
      };
      break;
    }
    case "compaction_start": {
      chat.isCompacting = true;
      break;
    }
    case "compaction_end": {
      chat.isCompacting = false;
      const result = (ev.result ?? {}) as Record<string, unknown>;
      const summary = asString(result.summary ?? ev.summary);
      if (summary) {
        chat.compactions = [...chat.compactions, {
          at: Date.now(),
          reason: asString(ev.reason),
          summary,
          tokensBefore: typeof result.tokensBefore === "number" ? result.tokensBefore : undefined,
        }].slice(-30);
      }
      pushToast(chat, "success", "Контекст сжат");
      break;
    }
    case "auto_retry_start": {
      chat.retryActive = true;
      chat.retryInfo = `Повтор после ошибки провайдера (попытка ${asString(ev.attempt ?? "?")})`;
      break;
    }
    case "auto_retry_end": {
      chat.retryActive = false;
      chat.retryInfo = null;
      break;
    }
    case "extension_error": {
      pushToast(chat, "error", `Расширение: ${asString(ev.error ?? ev.message ?? "ошибка")}`.slice(0, 300));
      break;
    }
    case "extension_ui_request": {
      const method = asString(ev.method);
      if (DIALOG_METHODS.has(method)) {
        chat.uiRequests = [...chat.uiRequests, ev as unknown as ExtUiRequest];
      } else if (method === "notify") {
        const kind = asString(ev.notificationType ?? ev.kind ?? "info");
        const valid = ["info", "error", "success", "warning"].includes(kind) ? kind : "info";
        pushToast(chat, valid as "info", asString(ev.message ?? ev.title ?? ""));
      } else if (method === "setStatus") {
        // real pi 0.80.x wire keys: statusKey / statusText (may contain ANSI)
        const key = asString(ev.statusKey ?? ev.key ?? "status");
        const text = asString(ev.statusText ?? ev.text ?? ev.status ?? ev.message ?? "");
        const entries = { ...chat.statusEntries };
        if (text) entries[key] = text;
        else delete entries[key];
        chat.statusEntries = entries;
      } else if (method === "setWidget") {
        const key = asString(ev.widgetKey ?? ev.key ?? "widget");
        const wireLines = (ev as Record<string, unknown>).widgetLines;
        const text = Array.isArray(wireLines)
          ? wireLines.map(asString).join("\n")
          : asString(ev.widgetText ?? ev.text ?? ev.lines ?? ev.content ?? ev.widget ?? "");
        if (key === "pi-app-workflow-state") {
          try { chat.workflow = text ? JSON.parse(text) as WorkflowViewState : null; } catch { /* keep last valid state */ }
        } else if (key === "pi-app-background-state") {
          try { chat.backgroundTasks = text ? JSON.parse(text) as BackgroundTaskView[] : []; } catch { /* keep last valid state */ }
        } else if (key === "pi-app-checkpoint-state") {
          try {
            const checkpoint = JSON.parse(text) as StructuredCheckpoint;
            if (!chat.structuredCheckpoints.some((item) => item.at === checkpoint.at)) {
              chat.structuredCheckpoints = [...chat.structuredCheckpoints, checkpoint].slice(-30);
            }
          } catch { /* keep last valid state */ }
        } else {
          const widgets = { ...chat.widgets };
          if (text) widgets[key] = text;
          else delete widgets[key];
          chat.widgets = widgets;
        }
      } else if (method === "set_editor_text" || method === "setEditorText") {
        chat.editorPrefill = asString(ev.text ?? "");
      }
      break;
    }
    case "error": {
      chat.lastError = asString(ev.error ?? ev.message ?? ev);
      break;
    }
    default:
      break;
  }
  return chat;
}

function entryTimestampMs(e: Record<string, unknown>): number | null {
  const t = e.timestamp;
  if (typeof t === "number" && Number.isFinite(t)) return t;
  if (typeof t === "string") {
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * Convert persisted session entries (JSONL) into timeline items for read-only view.
 *
 * Run-мета (сводка «Worked for …») живёт только в памяти приложения — pi её не
 * пишет. Восстанавливаем при загрузке: ход = от user-сообщения до следующего
 * user; toolCallIds собираем из assistant-блоков, длительность берём из
 * метаданных pi-claude-style-tools на финальном сообщении, иначе — по разнице
 * timestamp'ов записей. Так сводки переживают перезапуск приложения.
 */
export function entriesToChatState(entries: Record<string, unknown>[]): ChatState {
  const chat = emptyChatState();
  let runStartMs: number | null = null;
  let runEndMs: number | null = null;
  let runWorkedMs: number | null = null;
  let runToolIds: string[] = [];
  let runAssistantIndex = -1;

  const finalizeRun = () => {
    if (runAssistantIndex >= 0 && runToolIds.length > 0) {
      const item = chat.items[runAssistantIndex];
      const durationMs =
        runWorkedMs ??
        (runStartMs != null && runEndMs != null ? Math.max(0, runEndMs - runStartMs) : 0);
      const run: RunMeta = { id: `run-file-${runAssistantIndex}`, durationMs, toolCallIds: runToolIds };
      const items = [...chat.items];
      items[runAssistantIndex] = { ...item, msg: { ...item.msg, run } };
      chat.items = items;
    }
    runStartMs = null;
    runEndMs = null;
    runWorkedMs = null;
    runToolIds = [];
    runAssistantIndex = -1;
  };

  for (const e of entries) {
    if (e.type === "compaction") {
      const record: CompactionRecord = {
        at: entryTimestampMs(e) ?? Date.now(),
        summary: asString(e.summary),
        tokensBefore: typeof e.tokensBefore === "number" ? e.tokensBefore : undefined,
        firstKeptEntryId: asString(e.firstKeptEntryId) || undefined,
      };
      if (record.summary) chat.compactions.push(record);
      continue;
    }
    if (e.type === "custom") {
      const customType = asString(e.customType);
      const data = e.data as Record<string, unknown> | undefined;
      if (customType === "pi-app-workflow-state" && data?.version === 3) chat.workflow = data as unknown as WorkflowViewState;
      else if (["subagents:record", "pi-app-background-record", "pi-app-evaluator-record"].includes(customType) && data?.id) {
        const task = data as unknown as BackgroundTaskView;
        const index = chat.backgroundTasks.findIndex((item) => item.id === task.id);
        if (index >= 0) chat.backgroundTasks[index] = task;
        else chat.backgroundTasks.push(task);
      } else if (customType === "pi-app-rewind-record" || customType === "pi-app-branch-record") {
        if (data) chat.branches.push(data as unknown as BranchRecord);
      } else if (customType === "pi-app-checkpoint") {
        if (data) chat.structuredCheckpoints.push(data as unknown as StructuredCheckpoint);
      } else if (customType === "pi-app-compaction-record" && data) {
        const record = data as unknown as CompactionRecord;
        if (!chat.compactions.some((item) => item.at === record.at)) chat.compactions.push(record);
      }
      continue;
    }
    if (e.type !== "message") continue;
    const msg = e.message as ChatMessage | undefined;
    if (!msg) continue;
    if (msg.role === "toolResult") {
      finalizeMessage(chat, msg);
      runEndMs = entryTimestampMs(e) ?? runEndMs;
    } else if (msg.role === "user") {
      finalizeRun();
      chat.items = [...chat.items, { key: nextKey(), msg }];
      runStartMs = entryTimestampMs(e);
    } else if (msg.role === "assistant") {
      chat.items = [...chat.items, { key: nextKey(), msg }];
      runAssistantIndex = chat.items.length - 1;
      runEndMs = entryTimestampMs(e) ?? runEndMs;
      runWorkedMs = workedDurationMs(msg) ?? runWorkedMs;
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === "toolCall" && typeof b.id === "string") runToolIds = [...runToolIds, b.id];
        }
      }
    }
  }
  finalizeRun();
  return chat;
}

/** Add an optimistic user message (used on send). */
export function addUserMessage(chat: ChatState, text: string, images: Array<{ data: string; mimeType: string }> = []): ChatState {
  const content = [
    { type: "text", text },
    ...images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType })),
  ];
  chat.items = [
    ...chat.items,
    {
      key: nextKey(),
      msg: { role: "user", content, timestamp: Date.now() },
      optimistic: true,
    },
  ];
  chat.seq++;
  return chat;
}
