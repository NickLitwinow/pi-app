import { emptyChatState, type ChatMessage, type ChatState, type ExtUiRequest, type ToolExec } from "./types";

let keyCounter = 0;
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
const TOOL_OUTPUT_CAP = 120_000;
function capOutput(s: string): string {
  if (s.length <= TOOL_OUTPUT_CAP) return s;
  const half = TOOL_OUTPUT_CAP / 2;
  return `${s.slice(0, half)}\n… [вывод усечён: ${s.length.toLocaleString("ru-RU")} символов] …\n${s.slice(-half)}`;
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
}

function resultText(v: unknown): string {
  if (v && typeof v === "object" && "content" in (v as object)) {
    return contentText((v as ChatMessage).content);
  }
  return asString(v);
}

function finalizeMessage(chat: ChatState, msg: ChatMessage) {
  const role = msg.role;
  if (role === "toolResult") {
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
    // user prompts are added optimistically on send; dedupe echoes
    const text = contentText(msg.content);
    const recent = chat.items.slice(-6);
    if (recent.some((it) => it.msg.role === "user" && contentText(it.msg.content) === text)) return;
    chat.items = [...chat.items, { key: nextKey(), msg }];
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
      chat.lastError = null;
      break;
    }
    case "agent_end": {
      chat.isStreaming = false;
      chat.streamStartedAt = null;
      // Defensive: a streamed message that never got its message_end.
      if (chat.streaming && contentText(chat.streaming.content)) {
        finalizeMessage(chat, chat.streaming);
      }
      chat.streaming = null;
      break;
    }
    case "message_start": {
      const msg = ev.message as ChatMessage | undefined;
      const role = msg?.role;
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
        const text = asString(ev.widgetText ?? ev.text ?? ev.lines ?? ev.content ?? ev.widget ?? "");
        const widgets = { ...chat.widgets };
        if (text) widgets[key] = text;
        else delete widgets[key];
        chat.widgets = widgets;
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

/** Convert persisted session entries (JSONL) into timeline items for read-only view. */
export function entriesToChatState(entries: Record<string, unknown>[]): ChatState {
  const chat = emptyChatState();
  for (const e of entries) {
    if (e.type !== "message") continue;
    const msg = e.message as ChatMessage | undefined;
    if (!msg) continue;
    if (msg.role === "toolResult") {
      finalizeMessage(chat, msg);
    } else if (msg.role === "user" || msg.role === "assistant") {
      chat.items = [...chat.items, { key: nextKey(), msg }];
    }
  }
  return chat;
}

/** Add an optimistic user message (used on send). */
export function addUserMessage(chat: ChatState, text: string): ChatState {
  chat.items = [
    ...chat.items,
    { key: nextKey(), msg: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } },
  ];
  chat.seq++;
  return chat;
}
