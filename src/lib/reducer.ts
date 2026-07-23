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
  type PreviewRuntimeView,
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

function boundedString(value: unknown, max = 20_000): string {
  return asString(value).slice(0, max);
}

function extensionKey(value: unknown, fallback: string): string {
  const key = boundedString(value ?? fallback, 200).trim();
  if (!key || key === "__proto__" || key === "prototype" || key === "constructor" || /[\u0000-\u001f]/.test(key)) return "";
  return key;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringList(value: unknown, maxItems = 100, maxLength = 1_000): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((item) => boundedString(item, maxLength)).filter(Boolean);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeWorkflowPayload(value: unknown): WorkflowViewState | null {
  const root = objectValue(value);
  const intent = objectValue(root?.intent);
  if (!root || !intent || !Array.isArray(root.steps) || !Array.isArray(root.events)) return null;
  const stepStatuses = new Set(["pending", "running", "waiting", "passed", "failed", "skipped"]);
  const stepKinds = new Set(["plan", "research", "build", "preview", "gate", "evaluate", "review"]);
  const owners = new Set(["orchestrator", "researcher", "executor", "preview-runner", "gate-runner", "evaluator", "human"]);
  const steps = root.steps.slice(0, 200).flatMap((raw) => {
    const step = objectValue(raw);
    const id = boundedString(step?.id, 200);
    if (!step || !id) return [];
    const status = boundedString(step.status, 30);
    const kind = boundedString(step.kind, 30);
    const owner = boundedString(step.owner, 30);
    return [{
      id,
      label: boundedString(step.label, 500),
      kind: (stepKinds.has(kind) ? kind : "build") as WorkflowViewState["steps"][number]["kind"],
      deps: stringList(step.deps, 100, 200),
      status: (stepStatuses.has(status) ? status : "pending") as WorkflowViewState["steps"][number]["status"],
      acceptance: boundedString(step.acceptance, 4_000),
      required: step.required !== false,
      owner: (owners.has(owner) ? owner : "orchestrator") as WorkflowViewState["steps"][number]["owner"],
      maxAttempts: finiteNumber(step.maxAttempts) ?? 1,
      command: boundedString(step.command, 4_000) || undefined,
      attempts: finiteNumber(step.attempts) ?? 0,
      detail: boundedString(step.detail, 8_000) || undefined,
      failureReason: boundedString(step.failureReason, 8_000) || undefined,
      startedAt: finiteNumber(step.startedAt),
      completedAt: finiteNumber(step.completedAt),
    }];
  });
  const events = root.events.slice(-300).flatMap((raw) => {
    const event = objectValue(raw);
    const id = boundedString(event?.id, 200);
    if (!event || !id) return [];
    return [{
      id,
      stepId: boundedString(event.stepId, 200) || undefined,
      type: boundedString(event.type, 30) as WorkflowViewState["events"][number]["type"],
      at: finiteNumber(event.at) ?? 0,
      message: boundedString(event.message, 4_000),
    }];
  });
  const profiles = new Set(["feature", "bug", "chore", "hotfix", "research", "assessment"]);
  const statuses = new Set(["active", "needs-human", "blocked", "completed"]);
  const primaries = new Set(["trivial", "assessment", "research", "debug", "build"]);
  const risks = new Set(["low", "medium", "high"]);
  const profile = boundedString(root.profile, 30);
  const status = boundedString(root.status, 30);
  const primary = boundedString(intent.primary, 30);
  const risk = boundedString(intent.risk, 30);
  return {
    version: 3,
    runId: boundedString(root.runId, 200),
    createdAt: finiteNumber(root.createdAt) ?? 0,
    updatedAt: finiteNumber(root.updatedAt) ?? 0,
    objective: boundedString(root.objective, 20_000),
    profile: (profiles.has(profile) ? profile : "chore") as WorkflowViewState["profile"],
    status: (statuses.has(status) ? status : "active") as WorkflowViewState["status"],
    blockedStepId: boundedString(root.blockedStepId, 200) || undefined,
    blockedReason: boundedString(root.blockedReason, 8_000) || undefined,
    terminationReason: boundedString(root.terminationReason, 8_000) || undefined,
    approved: root.approved === true,
    editsPending: root.editsPending === true,
    changedFiles: stringList(root.changedFiles, 500, 1_000),
    evaluatorTaskId: boundedString(root.evaluatorTaskId, 200) || undefined,
    intent: {
      primary: (primaries.has(primary) ? primary : "build") as WorkflowViewState["intent"]["primary"],
      profile: (profiles.has(profile) ? profile : "chore") as WorkflowViewState["profile"],
      risk: (risks.has(risk) ? risk : "medium") as WorkflowViewState["intent"]["risk"],
      needsResearch: intent.needsResearch === true,
      needsPreview: intent.needsPreview === true,
      allowsMutation: intent.allowsMutation === true,
      allowsDeletion: intent.allowsDeletion === true,
      requiresPlan: intent.requiresPlan === true,
      requiresSandbox: intent.requiresSandbox === true,
      requiresEvaluator: intent.requiresEvaluator === true,
      requiresHumanApproval: intent.requiresHumanApproval === true,
      signals: stringList(intent.signals, 100, 500),
    },
    steps,
    events,
  };
}

function normalizePreviewRuntime(value: unknown): PreviewRuntimeView | null {
  const item = objectValue(value);
  if (!item) return null;
  const statuses = new Set(["idle", "starting", "running", "ready", "stopped", "failed"]);
  const status = boundedString(item.status, 30);
  if (!statuses.has(status)) return null;
  return {
    status: status as PreviewRuntimeView["status"],
    serverId: boundedString(item.serverId, 200) || undefined,
    configName: boundedString(item.configName, 500) || undefined,
    cwd: boundedString(item.cwd, 4_000) || undefined,
    url: boundedString(item.url, 2_048) || undefined,
    port: finiteNumber(item.port),
    running: typeof item.running === "boolean" ? item.running : undefined,
    ready: typeof item.ready === "boolean" ? item.ready : undefined,
    httpStatus: boundedString(item.httpStatus, 10) || undefined,
    startedAtMs: finiteNumber(item.startedAtMs),
    lastActivityMs: finiteNumber(item.lastActivityMs),
    leaseUntilMs: finiteNumber(item.leaseUntilMs),
    logs: stringList(item.logs, 320, 4_000),
    browserOpened: item.browserOpened === true,
    browserInspected: item.browserInspected === true,
    evidence: stringList(item.evidence, 20, 2_000),
    error: boundedString(item.error, 8_000) || undefined,
    updatedAt: finiteNumber(item.updatedAt) ?? 0,
    source: "agent",
  };
}

function normalizeBackgroundTasks(value: unknown): BackgroundTaskView[] | null {
  if (!Array.isArray(value)) return null;
  const statuses = new Set(["queued", "running", "completed", "failed", "cancelled"]);
  return value.slice(-200).flatMap((raw) => {
    const task = objectValue(raw);
    const id = boundedString(task?.id, 200);
    const status = boundedString(task?.status, 30);
    if (!task || !id || !statuses.has(status)) return [];
    return [{
      id,
      type: boundedString(task.type, 200),
      description: boundedString(task.description, 4_000),
      status: status as BackgroundTaskView["status"],
      result: boundedString(task.result, 60_000) || undefined,
      error: boundedString(task.error, 20_000) || undefined,
      startedAt: finiteNumber(task.startedAt),
      completedAt: finiteNumber(task.completedAt),
      heartbeatAt: finiteNumber(task.heartbeatAt),
      durationMs: finiteNumber(task.durationMs),
      tokens: finiteNumber(task.tokens),
      branch: boundedString(task.branch, 1_000) || undefined,
      baseSha: boundedString(task.baseSha, 200) || undefined,
      worktreePath: boundedString(task.worktreePath, 2_000) || undefined,
      outputFile: boundedString(task.outputFile, 2_000) || undefined,
      prompt: boundedString(task.prompt, 20_000) || undefined,
      transcript: boundedString(task.transcript, 60_000) || undefined,
      diff: boundedString(task.diff, 60_000) || undefined,
      mergedCommit: boundedString(task.mergedCommit, 200) || undefined,
      evaluatorProtocolVersion: finiteNumber(task.evaluatorProtocolVersion),
      evaluatorQuorum: typeof task.evaluatorQuorum === "boolean" ? task.evaluatorQuorum : undefined,
      priority: ["high", "normal", "low"].includes(String(task.priority)) ? task.priority as BackgroundTaskView["priority"] : undefined,
      queuePosition: finiteNumber(task.queuePosition),
      etaMs: finiteNumber(task.etaMs),
      blockedReason: boundedString(task.blockedReason, 8_000) || undefined,
    }];
  });
}

function normalizeCheckpoint(value: unknown): StructuredCheckpoint | null {
  const item = objectValue(value);
  const at = finiteNumber(item?.at);
  if (!item || at == null) return null;
  const context = objectValue(item.context);
  return {
    version: finiteNumber(item.version),
    at,
    runId: boundedString(item.runId, 200) || undefined,
    objective: boundedString(item.objective, 20_000),
    profile: boundedString(item.profile, 100) || undefined,
    changedFiles: stringList(item.changedFiles, 500, 1_000),
    decisions: stringList(item.decisions, 200, 4_000),
    risks: stringList(item.risks, 200, 4_000),
    nextReadySteps: stringList(item.nextReadySteps, 200, 1_000),
    nextAction: boundedString(item.nextAction, 4_000) || undefined,
    context: context ? {
      percent: finiteNumber(context.percent),
      tokens: finiteNumber(context.tokens),
      contextWindow: finiteNumber(context.contextWindow),
    } : undefined,
  };
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
  const clean = (stripLeadingEmoji(text).trim() || text.trim()).slice(0, 4_000);
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
  chat.plannedTasks = details.tasks.slice(0, 500).flatMap((task) => {
    const item = objectValue(task);
    const id = finiteNumber(item?.id);
    const status = boundedString(item?.status, 30);
    if (!item || id == null || !["pending", "in_progress", "completed", "deleted"].includes(status)) return [];
    return [{
      id,
      subject: boundedString(item.subject, 2_000),
      description: boundedString(item.description, 8_000) || undefined,
      activeForm: boundedString(item.activeForm, 2_000) || undefined,
      status: status as PlannedTaskView["status"],
      blockedBy: Array.isArray(item.blockedBy) ? item.blockedBy.slice(0, 100).flatMap((value) => finiteNumber(value) ?? []) : undefined,
      owner: boundedString(item.owner, 500) || undefined,
    }];
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
  return stringList(v, 100, 20_000);
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
        const id = boundedString(ev.id, 512);
        if (!id || chat.uiRequests.some((request) => request.id === id)) break;
        const timeout = finiteNumber(ev.timeout);
        const request: ExtUiRequest = {
          id,
          method,
          title: boundedString(ev.title, 500) || undefined,
          message: boundedString(ev.message, 20_000) || undefined,
          options: stringList(ev.options, 100, 2_000),
          placeholder: boundedString(ev.placeholder, 1_000) || undefined,
          prefill: boundedString(ev.prefill, 20_000) || undefined,
          timeout: timeout == null ? undefined : Math.min(86_400_000, Math.max(0, timeout)),
        };
        chat.uiRequests = [...chat.uiRequests, request].slice(-50);
      } else if (method === "notify") {
        const kind = asString(ev.notificationType ?? ev.kind ?? "info");
        const valid = ["info", "error", "success", "warning"].includes(kind) ? kind : "info";
        pushToast(chat, valid as "info", asString(ev.message ?? ev.title ?? ""));
      } else if (method === "setStatus") {
        // real pi 0.80.x wire keys: statusKey / statusText (may contain ANSI)
        const key = extensionKey(ev.statusKey ?? ev.key, "status");
        const text = boundedString(ev.statusText ?? ev.text ?? ev.status ?? ev.message ?? "", 20_000);
        if (!key) break;
        const entries = { ...chat.statusEntries };
        if (text && (key in entries || Object.keys(entries).length < 100)) entries[key] = text;
        else delete entries[key];
        chat.statusEntries = entries;
      } else if (method === "setWidget") {
        const key = extensionKey(ev.widgetKey ?? ev.key, "widget");
        if (!key) break;
        const wireLines = (ev as Record<string, unknown>).widgetLines;
        const text = Array.isArray(wireLines)
          ? stringList(wireLines, 500, 4_000).join("\n").slice(0, 1_000_000)
          : boundedString(ev.widgetText ?? ev.text ?? ev.lines ?? ev.content ?? ev.widget ?? "", 1_000_000);
        if (key === "pi-app-workflow-state") {
          try {
            const normalized = text ? normalizeWorkflowPayload(JSON.parse(text)) : null;
            if (!text || normalized) chat.workflow = normalized;
          } catch { /* keep last valid state */ }
        } else if (key === "pi-app-background-state") {
          try {
            const normalized = text ? normalizeBackgroundTasks(JSON.parse(text)) : [];
            if (normalized) chat.backgroundTasks = normalized;
          } catch { /* keep last valid state */ }
        } else if (key === "pi-app-checkpoint-state") {
          try {
            const checkpoint = normalizeCheckpoint(JSON.parse(text));
            if (checkpoint && !chat.structuredCheckpoints.some((item) => item.at === checkpoint.at)) {
              chat.structuredCheckpoints = [...chat.structuredCheckpoints, checkpoint].slice(-30);
            }
          } catch { /* keep last valid state */ }
        } else if (key === "pi-app-preview-state") {
          try {
            const preview = text ? normalizePreviewRuntime(JSON.parse(text)) : null;
            if (!text || preview) chat.previewRuntime = preview;
          } catch { /* keep last valid state */ }
        } else {
          const widgets = { ...chat.widgets };
          if (text && (key in widgets || Object.keys(widgets).length < 100)) widgets[key] = text.slice(0, 20_000);
          else delete widgets[key];
          chat.widgets = widgets;
        }
      } else if (method === "set_editor_text" || method === "setEditorText") {
        chat.editorPrefill = boundedString(ev.text ?? "", 100_000);
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
