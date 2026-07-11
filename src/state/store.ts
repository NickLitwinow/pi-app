import { create } from "zustand";
import { getBackend } from "../lib/backend";
import { notifyOS } from "../lib/notify";
import { addUserMessage, applyAgentEvent, contentText, entriesToChatState } from "../lib/reducer";
import {
  emptyChatState,
  type AgentState,
  type AppConfig,
  type ChatState,
  type Checkpoint,
  type ChatMessage,
  type ModelInfo,
  type PiInfo,
  type PinnedMessage,
  type ProjectInfo,
  type SessionGroup,
  type SessionMeta,
  type SessionStats,
} from "../lib/types";

export type View = "chat" | "review" | "settings";

export interface SessionFlags {
  pinned: string[];
  archived: string[];
  groups: SessionGroup[];
  groupOf: Record<string, string>;
  pinnedMessages: Record<string, PinnedMessage[]>;
  hiddenProjects: string[];
}

export function emptySessionFlags(): SessionFlags {
  return { pinned: [], archived: [], groups: [], groupOf: {}, pinnedMessages: {}, hiddenProjects: [] };
}

/** Нормализация flags из конфига (старые файлы без новых полей). */
function normalizeFlags(f: Partial<SessionFlags> | null | undefined): SessionFlags {
  return { ...emptySessionFlags(), ...(f ?? {}) };
}

export type AgentMode = "ask" | "accept-edits" | "plan" | "auto" | "bypass";

export interface WorkspaceChat {
  chat: ChatState;
  agentId: string | null;
  alive: boolean;
  agentState: AgentState | null;
  models: ModelInfo[];
  commands: { name: string; description?: string }[];
  stats: SessionStats | null;
  /** Отображаемая сейчас сессия (может отличаться от той, где работает агент). */
  sessionPath: string | null;
  /** Сессия, в которой реально открыт живой процесс агента. */
  liveSessionPath: string | null;
  /** Агент сейчас стримит — трекается всегда, даже когда смотрим другую сессию. */
  liveStreaming: boolean;
  checkpoints: Checkpoint[];
  stderrLog: string[];
  mode: AgentMode;
}

/** Толерантное сравнение путей сессий. pi в get_state может вернуть `sessionFile`
 *  в чуть иной форме, чем путь из листинга (симлинки, /private, разное кодирование
 *  каталога) — но имя файла сессии (uuid.jsonl) уникально, поэтому совпадение
 *  basename трактуем как одну и ту же сессию. Это чинит «живой» индикатор,
 *  подсветку активной и определение browse при расхождении форм пути. */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const fa = a.slice(a.lastIndexOf("/") + 1);
  const fb = b.slice(b.lastIndexOf("/") + 1);
  return fa.length > 0 && fa === fb;
}

/** Просматриваем ли мы сессию, отличную от той, где занят живой агент.
 *  null-путь = ещё не сохранённая новая сессия (агент только что стартовал) —
 *  это НЕ browse, такой вид усыновляет live-файл. */
export function isBrowsingAway(ws: WorkspaceChat): boolean {
  return Boolean(ws.alive && ws.liveSessionPath && ws.sessionPath && !samePath(ws.sessionPath, ws.liveSessionPath));
}

export function emptyWorkspaceChat(): WorkspaceChat {
  return {
    chat: emptyChatState(),
    agentId: null,
    alive: false,
    agentState: null,
    models: [],
    commands: [],
    stats: null,
    sessionPath: null,
    liveSessionPath: null,
    liveStreaming: false,
    checkpoints: [],
    stderrLog: [],
    mode: "ask",
  };
}

interface Store {
  ready: boolean;
  isMock: boolean;
  piInfo: PiInfo | null;
  appConfig: AppConfig;
  projects: ProjectInfo[];
  extraWorkspaces: ProjectInfo[];
  currentCwd: string | null;
  view: View;
  chats: Record<string, WorkspaceChat>;
  sessions: Record<string, SessionMeta[]>;
  /** Текст для вставки в composer (drag&drop путей и т.п.); composer забирает и обнуляет. */
  pendingInsert: string | null;
  sessionFlags: SessionFlags;
  /** Панель permission-запроса свёрнута в чип (чат остаётся читаемым). */
  permCollapsed: boolean;
  /** Сплит-скрин: панель live-превью открыта рядом с чатом. */
  previewOpen: boolean;
  /** Инкремент при внешнем изменении конфигов pi (config-changed) — зависимость перечитывающих вкладок. */
  configVersion: number;
  set: (patch: Partial<Store>) => void;
}

export const useStore = create<Store>((set) => ({
  ready: false,
  isMock: false,
  piInfo: null,
  appConfig: { editor: "code", processLimit: 2, idleKillSecs: 900, theme: "system", uiScale: 1 },
  projects: [],
  extraWorkspaces: [],
  currentCwd: null,
  view: "chat",
  chats: {},
  sessions: {},
  pendingInsert: null,
  sessionFlags: emptySessionFlags(),
  permCollapsed: false,
  previewOpen: false,
  configVersion: 0,
  set: (patch) => set(patch),
}));

export async function updateAppConfig(patch: Partial<AppConfig>): Promise<void> {
  const next = { ...useStore.getState().appConfig, ...patch };
  useStore.setState({ appConfig: next });
  const be = await getBackend();
  await be.invoke("write_app_config", { config: next }).catch(() => {});
}

export function insertIntoComposer(text: string): void {
  useStore.setState({ pendingInsert: text });
}

/** Открыть URL в системном браузере (не в webview приложения). */
export async function openExternalUrl(url: string): Promise<void> {
  const be = await getBackend();
  await be.invoke("open_external", { url }).catch(() => {});
}

// ---------- module-level plumbing ----------

const agentToCwd = new Map<string, string>();
const pending = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let reqCounter = 0;

function getChat(cwd: string): WorkspaceChat {
  const s = useStore.getState();
  return s.chats[cwd] ?? emptyWorkspaceChat();
}

function setChat(cwd: string, ws: WorkspaceChat) {
  const s = useStore.getState();
  useStore.setState({ chats: { ...s.chats, [cwd]: ws } });
}

function updateChat(cwd: string, fn: (ws: WorkspaceChat) => WorkspaceChat) {
  setChat(cwd, fn({ ...getChat(cwd) }));
}

// ---------- agent event coalescing ----------
// pi шлёт десятки message_update в секунду; применяем их пачкой раз в кадр,
// чтобы React делал одну реконсиляцию вместо N (CPU/память при стриминге).

const eventQueue = new Map<string, Record<string, unknown>[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function queueAgentEvent(cwd: string, event: Record<string, unknown>) {
  const q = eventQueue.get(cwd);
  if (q) q.push(event);
  else eventQueue.set(cwd, [event]);
  if (flushTimer == null) flushTimer = setTimeout(flushAgentEvents, 33);
}

/** Выбросить недоставленные события workspace — вызывается при подмене чата
 *  (открытие другой сессии), чтобы события старой не попали в новую. */
function discardQueuedEvents(cwd: string) {
  eventQueue.delete(cwd);
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

function flushAgentEvents() {
  flushTimer = null;
  if (eventQueue.size === 0) return;
  const s = useStore.getState();
  const nextChats = { ...s.chats };
  const finishedRuns: string[] = [];
  let newDialog = false;
  // уведомления ОС: ход завершён / агент ждёт разрешения, когда пользователь
  // не смотрит (окно без фокуса или открыт другой workspace)
  const osNotes: { cwd: string; kind: "end" | "perm" }[] = [];
  const noteOnce = (cwd: string, kind: "end" | "perm") => {
    const away = !document.hasFocus() || s.currentCwd !== cwd;
    if (away && !osNotes.some((n) => n.cwd === cwd && n.kind === kind)) osNotes.push({ cwd, kind });
  };
  for (const [cwd, events] of eventQueue) {
    const ws = nextChats[cwd] ?? emptyWorkspaceChat();
    // Гейт: когда пользователь смотрит другую сессию (browse), богатые события
    // живого агента НЕ применяем к отображаемому чату — иначе фоновая сессия
    // затирает просматриваемую. Но lifecycle (стрим on/off) трекаем всегда,
    // чтобы сайдбар показывал занятость фонового агента.
    const applyToView = !isBrowsingAway(ws);
    let chat = ws.chat;
    let applied = false;
    let liveStreaming = ws.liveStreaming;
    for (const ev of events) {
      const t = ev.type as string;
      if (t === "agent_start") liveStreaming = true;
      else if (t === "agent_end") liveStreaming = false;
      // Разрешительные диалоги/уведомления применяем всегда — иначе фоновый
      // агент зависнет в ожидании ответа, пока смотрим другую сессию.
      const isActionable = t === "extension_ui_request" || t === "error";
      if (applyToView || isActionable) {
        if (!applied) {
          chat = { ...ws.chat };
          applied = true;
        }
        chat = applyAgentEvent(chat, ev);
        if (applyToView && (t === "agent_start" || t === "agent_end" || t === "turn_end" || t === "compaction_end")) {
          if (!finishedRuns.includes(cwd)) finishedRuns.push(cwd);
        }
        if (t === "extension_ui_request" && DIALOG_METHODS.has(String(ev.method))) {
          newDialog = true;
          noteOnce(cwd, "perm");
        }
      } else if (t === "agent_end" || t === "turn_end" || t === "compaction_end") {
        // фоновая сессия завершила ход — обновим её стату (без изменения вида)
        if (!finishedRuns.includes(cwd)) finishedRuns.push(cwd);
      }
      if (t === "agent_end") noteOnce(cwd, "end");
    }
    if (applied || liveStreaming !== ws.liveStreaming) {
      nextChats[cwd] = { ...ws, chat, liveStreaming };
    }
  }
  eventQueue.clear();
  // новый диалоговый запрос разворачивает свёрнутую панель разрешений
  useStore.setState(newDialog ? { chats: nextChats, permCollapsed: false } : { chats: nextChats });
  for (const cwd of finishedRuns) {
    void refreshAgentMeta(cwd);
  }
  for (const n of osNotes) {
    const name = n.cwd.split("/").pop() || n.cwd;
    void notifyOS(name, n.kind === "perm" ? "Агент ждёт подтверждения" : "Агент завершил ход");
  }
}

// ---------- init ----------

let initialized = false;

export async function initApp(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const be = await getBackend();

  await be.listen("agent-event", (payload) => {
    const agentId = String(payload.agentId ?? "");
    const event = (payload.event ?? {}) as Record<string, unknown>;
    if (event.type === "response" && event.id != null) {
      const key = `${agentId}:${String(event.id)}`;
      const p = pending.get(key);
      if (p) {
        pending.delete(key);
        clearTimeout(p.timer);
        if (event.success === false) p.reject(new Error(String(event.error ?? "RPC error")));
        else p.resolve((event.data ?? {}) as Record<string, unknown>);
        return;
      }
    }
    const cwd = agentToCwd.get(agentId);
    if (!cwd) return;
    queueAgentEvent(cwd, event);
  });

  // файловый watcher бэкенда: сессии изменились (в т.ч. извне) → обновить списки
  await be.listen("sessions-changed", () => {
    scheduleSessionsRefresh();
  });

  await be.listen("agent-stderr", (payload) => {
    const cwd = agentToCwd.get(String(payload.agentId ?? ""));
    if (!cwd) return;
    updateChat(cwd, (ws) => ({
      ...ws,
      stderrLog: [...ws.stderrLog, String(payload.line ?? "")].slice(-200),
    }));
  });

  await be.listen("config-changed", (payload) => {
    // конфиги pi изменены снаружи (TUI/редактор): UI перечитает при следующем
    // открытии вкладок; работающие агенты живут со старым конфигом до рестарта
    const files = Array.isArray(payload.files) ? payload.files.join(", ") : "конфиг";
    useStore.setState((s) => ({ configVersion: (s.configVersion ?? 0) + 1 }));
    const cwd = useStore.getState().currentCwd;
    if (cwd) {
      notifyChat(
        cwd,
        "info",
        `${files} изменён вне приложения — подхвачено. Новые сессии агента будут использовать обновлённый конфиг.`,
      );
    }
  });

  await be.listen("agent-exit", (payload) => {
    const agentId = String(payload.agentId ?? "");
    // отклонить зависшие RPC этого агента — иначе операции молча ждут таймаута (до 180с)
    for (const [key, p] of [...pending]) {
      if (key.startsWith(`${agentId}:`)) {
        pending.delete(key);
        clearTimeout(p.timer);
        p.reject(new Error("агент завершился во время запроса"));
      }
    }
    const cwd = agentToCwd.get(agentId);
    if (!cwd) return;
    agentToCwd.delete(agentId);
    const reason = String(payload.reason ?? "");
    updateChat(cwd, (ws) => {
      if (ws.agentId !== agentId) return ws;
      const next = { ...ws, agentId: null, alive: false, liveStreaming: false, liveSessionPath: null };
      // о явном kill не уведомляем; о простое/вытеснении/падении — да
      if (reason !== "killed") {
        const text =
          reason === "idle"
            ? "Агент остановлен из-за простоя — продолжится с того же места при следующем сообщении"
            : reason === "evicted"
              ? "Агент выгружен по лимиту процессов"
              : `Агент завершился (код ${String(payload.code ?? "?")})`;
        next.chat = {
          ...next.chat,
          toasts: [
            ...next.chat.toasts,
            { id: Date.now(), kind: (reason === "exited" ? "warning" : "info") as "info", text },
          ].slice(-5),
          seq: next.chat.seq + 1,
        };
      }
      return next;
    });
  });

  const [piInfo, appConfig, projects, rawFlags] = await Promise.all([
    be.invoke<PiInfo>("resolve_pi").catch(() => null),
    be.invoke<AppConfig>("read_app_config").catch(() => null),
    be.invoke<ProjectInfo[]>("list_projects").catch(() => [] as ProjectInfo[]),
    be.invoke<Partial<SessionFlags>>("read_session_flags").catch(() => null),
  ]);

  const currentCwd = projects[0]?.cwd ?? null;
  useStore.setState({
    ready: true,
    isMock: be.isMock,
    piInfo,
    appConfig: appConfig ?? useStore.getState().appConfig,
    projects,
    currentCwd,
    sessionFlags: normalizeFlags(rawFlags),
  });
  // убрать legacy-конфиги pi-permission-system (глобальный + текущий проект),
  // иначе расширение сыплет «Legacy policy found…» при каждом старте сессии
  void be.invoke("migrate_permission_configs", { cwd: currentCwd }).catch(() => {});
  if (currentCwd) {
    void refreshSessions(currentCwd);
    void loadPermissionMode(currentCwd);
  }
}

// ---------- live session list refresh ----------

let sessionsRefreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Дебаунс-обновление проектов и списков сессий всех загруженных workspace. */
function scheduleSessionsRefresh(): void {
  if (sessionsRefreshTimer != null) return;
  sessionsRefreshTimer = setTimeout(() => {
    sessionsRefreshTimer = null;
    void refreshProjects();
    const s = useStore.getState();
    const loaded = new Set<string>(Object.keys(s.sessions));
    if (s.currentCwd) loaded.add(s.currentCwd);
    for (const cwd of loaded) void refreshSessions(cwd);
  }, 250);
}

// ---------- agent lifecycle ----------

const spawnInFlight = new Map<string, Promise<string>>();

export async function ensureAgent(cwd: string, sessionPath?: string | null): Promise<string> {
  // Serialize concurrent calls (React StrictMode double-effects, rapid sends):
  // otherwise two pi processes get spawned for the same workspace.
  const inFlight = spawnInFlight.get(cwd);
  if (inFlight) return inFlight;

  const ws = getChat(cwd);
  if (ws.alive && ws.agentId && (sessionPath === undefined || sessionPath === ws.sessionPath)) {
    return ws.agentId;
  }

  const promise = (async () => {
    const be = await getBackend();
    if (ws.agentId) {
      await be.invoke("kill_agent", { agentId: ws.agentId }).catch(() => {});
      agentToCwd.delete(ws.agentId);
    }
    const spawnSession = sessionPath ?? ws.sessionPath ?? null;
    const agentId = await be.invoke<string>("spawn_agent", {
      opts: { cwd, sessionPath: spawnSession, extraArgs: [] },
    });
    agentToCwd.set(agentId, cwd);
    // агент открыт в spawnSession — это и есть live-сессия (для новой узнаем из get_state)
    updateChat(cwd, (w) => ({ ...w, agentId, alive: true, liveSessionPath: spawnSession ?? w.sessionPath }));
    await refreshAgentMeta(cwd);
    // спавн ленивый (по первому сообщению) — модели/команды тянем после него
    void loadModelsAndCommands(cwd);
    return agentId;
  })();
  spawnInFlight.set(cwd, promise);
  try {
    return await promise;
  } finally {
    spawnInFlight.delete(cwd);
  }
}

export async function rpcRequest(
  cwd: string,
  command: Record<string, unknown>,
  // Дефолт щедрый: локальные модели медленны, а часть RPC (set_model, new_session,
  // fork) обслуживается агентом между ходами — короткий таймаут даёт ложные «RPC timeout».
  timeoutMs = 60000,
): Promise<Record<string, unknown>> {
  const ws = getChat(cwd);
  const agentId = ws.agentId;
  if (!agentId || !ws.alive) throw new Error("agent not running");
  const be = await getBackend();
  const id = `r${++reqCounter}`;
  const line = JSON.stringify({ ...command, id });
  const key = `${agentId}:${id}`;
  const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(key);
      reject(new Error(`RPC timeout: ${String(command.type)}`));
    }, timeoutMs);
    pending.set(key, { resolve, reject, timer });
  });
  await be.invoke("agent_send", { agentId, line });
  return promise;
}

/** Fire-and-forget RPC command (no response correlation needed). */
export async function rpcSend(cwd: string, command: Record<string, unknown>): Promise<void> {
  const ws = getChat(cwd);
  if (!ws.agentId || !ws.alive) throw new Error("agent not running");
  const be = await getBackend();
  await be.invoke("agent_send", { agentId: ws.agentId, line: JSON.stringify(command) });
}

async function refreshAgentMeta(cwd: string): Promise<void> {
  try {
    const state = (await rpcRequest(cwd, { type: "get_state" }, 10000)) as AgentState;
    const live = (state.sessionFile ?? state.sessionPath ?? null) as string | null;
    updateChat(cwd, (ws) => {
      // Сохраняем форму пути из листинга, когда pi сообщил ту же сессию (иначе
      // подсветка активной/«живой» строки в сайдбаре ломается из-за расхождения
      // формы пути). Новую сессию (когда пути ещё нет) — усыновляем как есть.
      const liveSessionPath =
        live == null || samePath(live, ws.liveSessionPath) ? ws.liveSessionPath ?? live : live;
      // ВАЖНО: выбор сессии пользователем авторитетен для вида. Никогда не уводим
      // sessionPath на live-сессию агента здесь — иначе при двух одноимённых
      // сессиях (или если switch_session не сработал / pi вернул иную форму пути)
      // вид «перекидывало» на живую сессию. sessionPath меняют только явные
      // действия (openSession/newSession/returnToLiveSession); тут лишь усыновляем
      // live, когда своего вида ещё нет (новая, только что созданная сессия).
      const sessionPath = ws.sessionPath ?? liveSessionPath;
      return { ...ws, agentState: state, liveSessionPath, sessionPath };
    });
  } catch {
    /* agent may be busy or dead */
  }
  // статистику фоновой (не отображаемой) сессии не тянем — она про live-агента,
  // но покажется неверно для просматриваемой; обновляем только когда вид = live
  if (!isBrowsingAway(getChat(cwd))) await refreshStats(cwd);
}

/** Обновить статистику сессии (токены/стоимость/заполнение контекста). */
export async function refreshStats(cwd: string): Promise<void> {
  try {
    const data = await rpcRequest(cwd, { type: "get_session_stats" }, 10000);
    updateChat(cwd, (ws) => ({ ...ws, stats: data as SessionStats }));
  } catch {
    /* optional */
  }
}

/** Вкл/выкл авто-компакцию у живого агента (pi core: set_auto_compaction). */
export async function setAutoCompaction(cwd: string, enabled: boolean): Promise<void> {
  await rpcRequest(cwd, { type: "set_auto_compaction", enabled });
  await refreshAgentMeta(cwd);
}

export async function loadModelsAndCommands(cwd: string): Promise<void> {
  try {
    const data = await rpcRequest(cwd, { type: "get_available_models" }, 15000);
    const models = (data.models ?? data) as ModelInfo[];
    if (Array.isArray(models)) updateChat(cwd, (ws) => ({ ...ws, models }));
  } catch {
    /* non-fatal */
  }
  try {
    const data = await rpcRequest(cwd, { type: "get_commands" }, 15000);
    const raw = (data.commands ?? data) as unknown;
    if (Array.isArray(raw)) {
      const commands = raw
        .map((c) => (typeof c === "string" ? { name: c } : (c as { name: string; description?: string })))
        .filter((c) => c.name);
      updateChat(cwd, (ws) => ({ ...ws, commands }));
    }
  } catch {
    /* non-fatal */
  }
}

// ---------- chat actions ----------

export async function sendPrompt(cwd: string, text: string, images?: { data: string; mimeType: string }[]): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  // отправка в просматриваемую сессию, отличную от той, где занят агент
  const before = getChat(cwd);
  if (before.alive && before.agentId && isBrowsingAway(before)) {
    if (before.liveStreaming) {
      throw new Error(
        "Агент занят в другой сессии этой папки. Дождитесь завершения или нажмите «Вернуться к активной».",
      );
    }
    // агент простаивает — переносим его в открытую сессию, затем отправляем
    await rpcRequest(cwd, { type: "switch_session", sessionPath: before.sessionPath! }, 15000).catch(() => {});
    updateChat(cwd, (w) => ({ ...w, liveSessionPath: before.sessionPath }));
  }

  await ensureAgent(cwd);
  const ws = getChat(cwd);
  const streaming = ws.chat.isStreaming;

  if (!streaming) {
    updateChat(cwd, (w) => ({ ...w, chat: addUserMessage({ ...w.chat }, trimmed) }));
    void makeCheckpoint(cwd, "turn");
    const cmd: Record<string, unknown> = { type: "prompt", message: trimmed };
    if (images?.length) cmd.images = images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
    await rpcSend(cwd, cmd);
  } else {
    updateChat(cwd, (w) => ({ ...w, chat: addUserMessage({ ...w.chat }, trimmed) }));
    await rpcSend(cwd, { type: "steer", message: trimmed });
  }
}

export async function sendFollowUp(cwd: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  updateChat(cwd, (w) => ({ ...w, chat: addUserMessage({ ...w.chat }, trimmed) }));
  await rpcSend(cwd, { type: "follow_up", message: trimmed });
}

export async function abortAgent(cwd: string): Promise<void> {
  await rpcSend(cwd, { type: "abort" }).catch(() => {});
}

export async function setModel(cwd: string, provider: string, modelId: string): Promise<void> {
  await rpcRequest(cwd, { type: "set_model", provider, modelId });
  await refreshAgentMeta(cwd);
}

export async function setThinkingLevel(cwd: string, level: string): Promise<void> {
  await rpcRequest(cwd, { type: "set_thinking_level", level });
  await refreshAgentMeta(cwd);
}

export async function compactContext(cwd: string): Promise<void> {
  await rpcSend(cwd, { type: "compact" });
}

export async function newSession(cwd: string): Promise<void> {
  const ws = getChat(cwd);
  useStore.setState({ currentCwd: cwd, view: "chat" });
  // нельзя увести занятого агента с текущей задачи
  if (ws.alive && ws.agentId && ws.liveStreaming) {
    updateChat(cwd, (w) => ({
      ...w,
      chat: {
        ...w.chat,
        toasts: [
          ...w.chat.toasts,
          { id: Date.now(), kind: "warning" as const, text: "Агент занят — дождитесь завершения, чтобы начать новую сессию" },
        ].slice(-5),
        seq: w.chat.seq + 1,
      },
    }));
    return;
  }
  discardQueuedEvents(cwd);
  if (ws.alive && ws.agentId) {
    await rpcRequest(cwd, { type: "new_session" }).catch(() => {});
    updateChat(cwd, (w) => ({ ...w, chat: emptyChatState(), sessionPath: null, liveSessionPath: null, checkpoints: [], stats: null }));
    await refreshAgentMeta(cwd);
  } else {
    updateChat(cwd, (w) => ({ ...w, chat: emptyChatState(), sessionPath: null, liveSessionPath: null, checkpoints: [], stats: null }));
    await ensureAgent(cwd, null);
  }
  void loadModelsAndCommands(cwd);
}

export function respondToUiRequest(cwd: string, id: string, response: Record<string, unknown>): void {
  updateChat(cwd, (w) => ({
    ...w,
    chat: { ...w.chat, uiRequests: w.chat.uiRequests.filter((r) => r.id !== id), seq: w.chat.seq + 1 },
  }));
  void rpcSend(cwd, { type: "extension_ui_response", id, ...response }).catch(() => {});
}

export function dismissToast(cwd: string, toastId: number): void {
  updateChat(cwd, (w) => ({
    ...w,
    chat: { ...w.chat, toasts: w.chat.toasts.filter((t) => t.id !== toastId), seq: w.chat.seq + 1 },
  }));
}

/** Показать тост в чате workspace (напр. пояснение, почему нельзя отправить). */
export function notifyChat(cwd: string, kind: "info" | "warning" | "error", text: string): void {
  updateChat(cwd, (w) => ({
    ...w,
    chat: {
      ...w.chat,
      toasts: [...w.chat.toasts, { id: Date.now() + Math.random(), kind, text }].slice(-5),
      seq: w.chat.seq + 1,
    },
  }));
}

// ---------- sessions / workspaces ----------

export async function refreshProjects(): Promise<void> {
  const be = await getBackend();
  const projects = await be.invoke<ProjectInfo[]>("list_projects").catch(() => [] as ProjectInfo[]);
  useStore.setState({ projects });
}

export async function refreshSessions(cwd: string): Promise<void> {
  const be = await getBackend();
  // резолв каталога сессий по cwd на стороне бэкенда: работает и для только что
  // добавленных workspace, у которых ещё нет записи в projects
  const sessions = await be.invoke<SessionMeta[]>("list_sessions_for_cwd", { cwd }).catch(() => [] as SessionMeta[]);
  useStore.setState({ sessions: { ...useStore.getState().sessions, [cwd]: sessions } });
}

/**
 * Освободить память фоновых workspace: у не-текущих БЕЗ живого агента
 * сбрасываем тяжёлую историю (items/toolExecs/streaming/stderr) до лёгкого
 * состояния. Полная история вернётся из файла при повторном открытии сессии.
 * Живые агенты (в т.ч. фоновые стримящие) не трогаем.
 */
function evictBackgroundWorkspaces(keepCwd: string): void {
  const s = useStore.getState();
  let mutated = false;
  const chats = { ...s.chats };
  for (const [cwd, ws] of Object.entries(s.chats)) {
    if (cwd === keepCwd || ws.alive) continue;
    if (ws.chat.items.length === 0 && ws.stderrLog.length === 0 && !ws.stats) continue; // уже лёгкий
    chats[cwd] = {
      ...ws,
      chat: emptyChatState(),
      stats: null,
      stderrLog: [],
      // sessionPath сохраняем — при возврате перечитаем историю из файла
    };
    mutated = true;
  }
  if (mutated) useStore.setState({ chats });
}

export function selectWorkspace(cwd: string): void {
  const prev = useStore.getState().currentCwd;
  useStore.setState({ currentCwd: cwd });
  if (prev && prev !== cwd) evictBackgroundWorkspaces(cwd);
  void refreshSessions(cwd);
  void loadPermissionMode(cwd);
  // если историю этого workspace ранее выгрузили — вернуть её из файла
  const ws = getChat(cwd);
  if (ws.sessionPath && ws.chat.items.length === 0 && !ws.liveStreaming) {
    void loadSessionFromFile(ws.sessionPath).then((chat) => {
      const cur = getChat(cwd);
      if (cur.sessionPath === ws.sessionPath && cur.chat.items.length === 0) {
        updateChat(cwd, (w) => ({ ...w, chat }));
      }
    });
  }
  void (async () => {
    const be = await getBackend();
    await be.invoke("migrate_permission_configs", { cwd }).catch(() => {});
  })();
}

async function loadPermissionMode(cwd: string): Promise<void> {
  const be = await getBackend();
  const mode = await be.invoke<string | null>("read_permission_mode", { cwd }).catch(() => null);
  if (mode && ["ask", "accept-edits", "auto", "bypass"].includes(mode)) {
    updateChat(cwd, (w) => ({ ...w, mode: mode as AgentMode }));
  }
}

/** Переключение режима работы агента. Permission-режимы пишут project-local
 *  пресет для @gotgenes/pi-permission-system и перезапускают агента (сессия
 *  сохраняется); plan mode — это toggle /plannotator на живом агенте. */
export async function setAgentMode(cwd: string, mode: AgentMode): Promise<void> {
  const prev = getChat(cwd).mode;
  if (prev === mode) return;
  updateChat(cwd, (w) => ({ ...w, mode }));

  // Контракт гейтов (§5.10-2): write_permission_preset сам синхронизирует
  // конфиги известных сторонних гейтов (pi-guardrails) и возвращает сообщение.

  if (mode === "plan") {
    await ensureAgent(cwd);
    await rpcSend(cwd, { type: "prompt", message: "/plannotator" }).catch(() => {});
    return;
  }
  if (prev === "plan" && getChat(cwd).alive) {
    // выйти из plan mode перед сменой политики
    await rpcSend(cwd, { type: "prompt", message: "/plannotator" }).catch(() => {});
  }

  const be = await getBackend();
  const gateNotice = await be.invoke<string | null>("write_permission_preset", { cwd, mode });
  if (gateNotice) {
    // «не трогает» = чужой конфиг guardrails остался активен — это предупреждение
    notifyChat(cwd, gateNotice.includes("не трогает") ? "warning" : "info", gateNotice);
  }

  // перезапуск с той же сессией, чтобы permission-гейт перечитал конфиг
  const ws = getChat(cwd);
  if (ws.alive && ws.agentId) {
    await be.invoke("kill_agent", { agentId: ws.agentId }).catch(() => {});
    agentToCwd.delete(ws.agentId);
    updateChat(cwd, (w) => ({ ...w, agentId: null, alive: false, liveStreaming: false, liveSessionPath: null }));
    await ensureAgent(cwd, ws.sessionPath);
    void loadModelsAndCommands(cwd);
  }
}

export function addWorkspace(cwd: string): void {
  const s = useStore.getState();
  // повторное добавление ранее скрытой папки — снова показываем её
  const flags = s.sessionFlags;
  if (flags.hiddenProjects.includes(cwd)) {
    void persistFlags({ ...flags, hiddenProjects: flags.hiddenProjects.filter((p) => p !== cwd) });
  }
  if ([...s.projects, ...s.extraWorkspaces].some((p) => p.cwd === cwd)) {
    useStore.setState({ currentCwd: cwd, view: "chat" });
    return;
  }
  const name = cwd.split("/").filter(Boolean).pop() ?? cwd;
  const ws: ProjectInfo = { dir: "(new)", cwd, name, sessionCount: 0, lastModifiedMs: Date.now() };
  useStore.setState({ extraWorkspaces: [...s.extraWorkspaces, ws], currentCwd: cwd, view: "chat" });
}

/** Убрать проект из сайдбара: гасим его агента, чистим состояние чата,
 *  для найденных проектов запоминаем как скрытый. Файлы сессий не трогаем. */
export async function removeWorkspace(cwd: string): Promise<void> {
  const s = useStore.getState();
  // остановить живого агента этого workspace
  const ws = s.chats[cwd];
  if (ws?.agentId) {
    const be = await getBackend();
    await be.invoke("kill_agent", { agentId: ws.agentId }).catch(() => {});
    agentToCwd.delete(ws.agentId);
  }
  discardQueuedEvents(cwd);

  const chats = { ...s.chats };
  delete chats[cwd];
  const sessions = { ...s.sessions };
  delete sessions[cwd];
  const extraWorkspaces = s.extraWorkspaces.filter((p) => p.cwd !== cwd);
  const isDiscovered = s.projects.some((p) => p.cwd === cwd);

  // следующий доступный workspace становится активным
  const remaining = [...extraWorkspaces, ...s.projects.filter((p) => p.cwd !== cwd)];
  const nextCwd = s.currentCwd === cwd ? (remaining[0]?.cwd ?? null) : s.currentCwd;

  useStore.setState({ chats, sessions, extraWorkspaces, currentCwd: nextCwd });

  if (isDiscovered) {
    const flags = useStore.getState().sessionFlags;
    if (!flags.hiddenProjects.includes(cwd)) {
      await persistFlags({ ...flags, hiddenProjects: [...flags.hiddenProjects, cwd] });
    }
  }
  if (nextCwd) void refreshSessions(nextCwd);
}

// ---------- session management (sidebar) ----------

/** Прочитать полную историю активной ветки сессии из файла (быстрый путь). */
async function loadSessionFromFile(path: string): Promise<ChatState> {
  const be = await getBackend();
  const entries = await be
    .invoke<Record<string, unknown>[]>("read_session_thread", { path })
    .catch(() => [] as Record<string, unknown>[]);
  return entriesToChatState(entries);
}

/** Монотонный токен: если пользователь быстро кликает по разным сессиям (частая
 *  причина «закидывает на одну» — особенно у сессий с одинаковым именем), к виду
 *  применяется только последний open, ранние асинхронные результаты отбрасываются. */
let openToken = 0;

/**
 * Открыть сессию в чате.
 *  - вернулись в live-сессию → показываем её живой чат КАК ЕСТЬ (не перечитываем
 *    из файла: файл не содержит in-flight сообщений, иначе поток «замирает»);
 *  - другая сессия, агент простаивает → мгновенно рендерим из файла и переносим
 *    агента в неё (switch_session);
 *  - агент занят другой сессией → показываем открытую read-only (browse),
 *    живой процесс не трогаем, он продолжает работу в фоне.
 */
export async function openSession(cwd: string, meta: SessionMeta): Promise<void> {
  const token = ++openToken;
  const prev = useStore.getState().currentCwd;
  useStore.setState({ currentCwd: cwd, view: "chat" });
  if (prev && prev !== cwd) evictBackgroundWorkspaces(cwd);
  const ws = getChat(cwd);

  // Клик по УЖЕ активной live-сессии (мы её и смотрим) — no-op: не перечитываем
  // из файла, чтобы не терять живой стрим/in-flight сообщения. Только мета.
  if (
    ws.alive &&
    ws.agentId &&
    samePath(ws.sessionPath, meta.path) &&
    samePath(ws.liveSessionPath, meta.path)
  ) {
    void refreshAgentMeta(cwd);
    return;
  }

  // 1) мгновенный рендер полной истории из файла (активная ветка)
  const fileChat = await loadSessionFromFile(meta.path);
  if (token !== openToken) return; // клик перекрыт более новым — не применяем
  const cur = getChat(cwd);
  // возврат в live-сессию (из browse/другого вида): файл не несёт флаг стрима и
  // in-flight сообщения — восстанавливаем состояние стрима из live-трекинга, а
  // pending-диалоги живого агента переносим в новый вид.
  const returningToLive = cur.alive && Boolean(cur.agentId) && samePath(cur.liveSessionPath, meta.path);
  const willBrowse =
    cur.alive && Boolean(cur.liveSessionPath) && !samePath(cur.liveSessionPath, meta.path) && cur.liveStreaming;
  if ((returningToLive || willBrowse) && cur.chat.uiRequests.length > 0) {
    fileChat.uiRequests = cur.chat.uiRequests;
  }
  if (returningToLive) {
    fileChat.isStreaming = cur.liveStreaming;
    fileChat.streamStartedAt = cur.liveStreaming ? Date.now() : null;
  }
  updateChat(cwd, (w) => ({
    ...w,
    chat: fileChat,
    sessionPath: meta.path,
    // при возврате в live сохраняем чекпоинты/стату — refreshAgentMeta их освежит
    checkpoints: returningToLive ? w.checkpoints : [],
    stats: returningToLive ? w.stats : null,
  }));

  if (!cur.alive || !cur.agentId) {
    // живого агента нет — файлового вида достаточно; агент поднимется при отправке
    return;
  }

  if (returningToLive) {
    // это live-сессия — освежим мету (стрим продолжит применяться к виду)
    void refreshAgentMeta(cwd);
    return;
  }

  if (!cur.liveStreaming) {
    // агент простаивает — безопасно перенести его в открытую сессию
    try {
      await rpcRequest(cwd, { type: "switch_session", sessionPath: meta.path }, 15000);
      if (token !== openToken) return;
      updateChat(cwd, (w) => ({ ...w, liveSessionPath: meta.path }));
      // перечитаем из файла после switch — на случай, если pi что-то дописал
      const after = await loadSessionFromFile(meta.path);
      if (token !== openToken) return;
      updateChat(cwd, (w) => (samePath(w.sessionPath, meta.path) ? { ...w, chat: after } : w));
      void refreshAgentMeta(cwd);
    } catch {
      /* switch не удался — остаёмся на файловом виде */
    }
    return;
  }

  // агент занят в другой сессии — оставляем его работать, показываем read-only.
  // (browse-режим: isBrowsingAway(ws) === true, события агента не трогают вид)
}

/** Вернуться к сессии, в которой сейчас работает живой агент. */
export async function returnToLiveSession(cwd: string): Promise<void> {
  const ws = getChat(cwd);
  if (!ws.liveSessionPath) return;
  const live = ws.liveSessionPath;
  const token = ++openToken;
  const pendingUi = ws.chat.uiRequests; // диалоги живого агента переносим
  const fileChat = await loadSessionFromFile(live);
  if (token !== openToken) return;
  if (pendingUi.length > 0) fileChat.uiRequests = pendingUi;
  // Восстанавливаем флаг стрима из независимого live-трекинга: файл его не несёт,
  // иначе кнопка «стоп»/индикатор пропали бы, хотя агент ещё работает. Следующий
  // message_update (pi шлёт полный снапшот) вернёт само стримящееся сообщение.
  const streaming = getChat(cwd).liveStreaming;
  updateChat(cwd, (w) => ({
    ...w,
    chat: { ...fileChat, isStreaming: streaming, streamStartedAt: streaming ? Date.now() : null },
    sessionPath: live,
  }));
  void refreshAgentMeta(cwd);
}

export async function deleteSessionAction(cwd: string, path: string): Promise<void> {
  const be = await getBackend();
  const ws = getChat(cwd);
  // если удаляем открытую/активную сессию — сначала гасим агента
  // (samePath: pi может вернуть иную форму пути, чем листинг)
  if (samePath(ws.sessionPath, path)) {
    if (ws.agentId) {
      await be.invoke("kill_agent", { agentId: ws.agentId }).catch(() => {});
      agentToCwd.delete(ws.agentId);
    }
    discardQueuedEvents(cwd);
    updateChat(cwd, (w) => ({ ...w, chat: emptyChatState(), sessionPath: null, liveSessionPath: null, liveStreaming: false, agentId: null, alive: false, checkpoints: [], stats: null }));
  }
  await be.invoke("delete_session", { path });
  // подчистить флаги
  const flags = useStore.getState().sessionFlags;
  const groupOf = { ...flags.groupOf };
  delete groupOf[path];
  const pinnedMessages = { ...flags.pinnedMessages };
  delete pinnedMessages[path];
  await persistFlags({
    ...flags,
    pinned: flags.pinned.filter((p) => p !== path),
    archived: flags.archived.filter((p) => p !== path),
    groupOf,
    pinnedMessages,
  });
  await refreshSessions(cwd);
  await refreshProjects();
}

export async function renameSessionAction(cwd: string, path: string, name: string): Promise<void> {
  const ws = getChat(cwd);
  if (ws.alive && ws.agentId && ws.sessionPath === path) {
    await rpcRequest(cwd, { type: "set_session_name", name }, 10000).catch(async () => {
      const be = await getBackend();
      await be.invoke("rename_session", { path, name });
    });
    await refreshAgentMeta(cwd);
  } else {
    const be = await getBackend();
    await be.invoke("rename_session", { path, name });
  }
  await refreshSessions(cwd);
}

async function persistFlags(flags: SessionFlags): Promise<void> {
  useStore.setState({ sessionFlags: flags });
  const be = await getBackend();
  await be.invoke("write_session_flags", { flags }).catch(() => {});
}

export async function togglePinned(path: string): Promise<void> {
  const f = useStore.getState().sessionFlags;
  const pinned = f.pinned.includes(path) ? f.pinned.filter((p) => p !== path) : [...f.pinned, path];
  await persistFlags({ ...f, pinned });
}

export async function toggleArchived(path: string): Promise<void> {
  const f = useStore.getState().sessionFlags;
  const archived = f.archived.includes(path) ? f.archived.filter((p) => p !== path) : [...f.archived, path];
  await persistFlags({ ...f, archived });
}

// ---------- session groups (папки сессий внутри проекта) ----------

export async function createGroup(cwd: string, name: string): Promise<string> {
  const f = useStore.getState().sessionFlags;
  const id = `g${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
  await persistFlags({ ...f, groups: [...f.groups, { id, name: name.trim(), cwd }] });
  return id;
}

export async function renameGroup(groupId: string, name: string): Promise<void> {
  const f = useStore.getState().sessionFlags;
  await persistFlags({
    ...f,
    groups: f.groups.map((g) => (g.id === groupId ? { ...g, name: name.trim() } : g)),
  });
}

/** Удалить группу: её сессии возвращаются в общий список. */
export async function deleteGroup(groupId: string): Promise<void> {
  const f = useStore.getState().sessionFlags;
  const groupOf = Object.fromEntries(Object.entries(f.groupOf).filter(([, g]) => g !== groupId));
  await persistFlags({ ...f, groups: f.groups.filter((g) => g.id !== groupId), groupOf });
}

export async function moveSessionToGroup(path: string, groupId: string | null): Promise<void> {
  const f = useStore.getState().sessionFlags;
  const groupOf = { ...f.groupOf };
  if (groupId) groupOf[path] = groupId;
  else delete groupOf[path];
  await persistFlags({ ...f, groupOf });
}

// ---------- fork / rewind (pi core: fork {entryId}, get_fork_messages) ----------

/** Полный форк сессии из сайдбара: копия файла с новым id, открывается сразу. */
export async function forkSessionAction(cwd: string, meta: SessionMeta): Promise<void> {
  const be = await getBackend();
  const forked = await be.invoke<SessionMeta>("fork_session", { path: meta.path, upToEntryId: null });
  await refreshSessions(cwd);
  await openSession(cwd, forked);
}

function pickForkEntry(
  msgs: { entryId: string; text: string }[],
  userIndex: number,
  text: string,
): { entryId: string; text: string } | undefined {
  const wanted = text.trim();
  if (msgs[userIndex]?.text?.trim() === wanted) return msgs[userIndex];
  const byText = msgs.filter((m) => m.text.trim() === wanted);
  if (byText.length === 1) return byText[0];
  return msgs[userIndex];
}

/** «Rewind to here»: откат активной сессии к пользовательскому сообщению
 *  (pi fork создаёт ветку; pi-rewind, если установлен, предложит вернуть файлы).
 *  Текст сообщения попадает в composer для правки и повторной отправки. */
export async function rewindToMessage(cwd: string, userIndex: number, text: string): Promise<void> {
  const ws = getChat(cwd);
  if (ws.liveStreaming) throw new Error("Агент занят — дождитесь завершения перед откатом");
  if (isBrowsingAway(ws)) throw new Error("Сначала вернитесь к активной сессии");
  await ensureAgent(cwd, ws.sessionPath);
  const data = await rpcRequest(cwd, { type: "get_fork_messages" }, 45000);
  const msgs = (data.messages ?? []) as { entryId: string; text: string }[];
  const target = pickForkEntry(msgs, userIndex, text);
  if (!target) throw new Error("Сообщение для отката не найдено");
  // fork с pi-rewind восстанавливает файлы + может ждать подтверждения — на
  // медленной модели/большой сессии это долго, поэтому таймаут щедрый.
  const res = (await rpcRequest(cwd, { type: "fork", entryId: target.entryId }, 180000)) as {
    text?: string;
    cancelled?: boolean;
  };
  if (res.cancelled) return;
  discardQueuedEvents(cwd);
  // полная история новой активной ветки — из файла живого агента
  const live = getChat(cwd).liveSessionPath ?? ws.sessionPath;
  const chat = live ? await loadSessionFromFile(live) : emptyChatState();
  chat.editorPrefill = res.text ?? target.text;
  updateChat(cwd, (w) => ({ ...w, chat }));
  await refreshAgentMeta(cwd);
}

/** «Fork from here»: новая сессия с историей строго до выбранного сообщения;
 *  исходная сессия не меняется, текст сообщения — в composer новой. */
export async function forkFromMessage(cwd: string, userIndex: number, text: string): Promise<void> {
  const ws = getChat(cwd);
  if (!ws.sessionPath) throw new Error("Сессия ещё не сохранена на диск");
  if (ws.liveStreaming) throw new Error("Агент занят — дождитесь завершения перед форком");
  if (isBrowsingAway(ws)) throw new Error("Сначала вернитесь к активной сессии");
  await ensureAgent(cwd, ws.sessionPath);
  const data = await rpcRequest(cwd, { type: "get_fork_messages" }, 45000);
  const msgs = (data.messages ?? []) as { entryId: string; text: string }[];
  const target = pickForkEntry(msgs, userIndex, text);
  if (!target) throw new Error("Сообщение для форка не найдено");
  const be = await getBackend();
  const forked = await be.invoke<SessionMeta>("fork_session", {
    path: ws.sessionPath,
    upToEntryId: target.entryId,
  });
  await refreshSessions(cwd);
  await openSession(cwd, forked);
  updateChat(cwd, (w) => ({ ...w, chat: { ...w.chat, editorPrefill: target.text, seq: w.chat.seq + 1 } }));
}

// ---------- pinned messages (закреплённые ответы — виджет в чате) ----------

/** Стабильный id сообщения по содержимому (переживает перезагрузку сессии). */
export function msgPinId(msg: ChatMessage): string {
  const s = `${msg.role}:${contentText(msg.content)}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `p${(h >>> 0).toString(36)}-${s.length.toString(36)}`;
}

export async function toggleMessagePin(cwd: string, msg: ChatMessage): Promise<void> {
  const ws = getChat(cwd);
  const key = ws.sessionPath;
  if (!key) return; // сессия ещё не сохранена — закреплять нечего
  const id = msgPinId(msg);
  const f = useStore.getState().sessionFlags;
  const list = f.pinnedMessages[key] ?? [];
  const next = list.some((p) => p.id === id)
    ? list.filter((p) => p.id !== id)
    : [...list, { id, text: contentText(msg.content), role: String(msg.role), ts: Date.now() }].slice(-20);
  const pinnedMessages = { ...f.pinnedMessages };
  if (next.length > 0) pinnedMessages[key] = next;
  else delete pinnedMessages[key];
  await persistFlags({ ...f, pinnedMessages });
}

// ---------- code review ----------

export async function makeCheckpoint(cwd: string, label: string): Promise<void> {
  try {
    const be = await getBackend();
    const isRepo = await be.invoke<boolean>("git_is_repo", { cwd });
    if (!isRepo) return;
    const hash = await be.invoke<string>("git_checkpoint", { cwd, label });
    updateChat(cwd, (ws) => {
      const cps = ws.checkpoints;
      if (cps.length > 0 && cps[cps.length - 1].hash === hash) return ws;
      return { ...ws, checkpoints: [...cps, { hash, label, ts: Date.now() }].slice(-100) };
    });
  } catch {
    /* review is best-effort */
  }
}
