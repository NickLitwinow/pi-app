import { create } from "zustand";
import { getBackend } from "../lib/backend";
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

export type View = "chat" | "review" | "analytics" | "settings";

export interface SessionFlags {
  pinned: string[];
  archived: string[];
  groups: SessionGroup[];
  groupOf: Record<string, string>;
  pinnedMessages: Record<string, PinnedMessage[]>;
}

export function emptySessionFlags(): SessionFlags {
  return { pinned: [], archived: [], groups: [], groupOf: {}, pinnedMessages: {} };
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
  sessionPath: string | null;
  checkpoints: Checkpoint[];
  stderrLog: string[];
  mode: AgentMode;
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
  for (const [cwd, events] of eventQueue) {
    const ws = nextChats[cwd] ?? emptyWorkspaceChat();
    let chat = { ...ws.chat };
    for (const ev of events) {
      chat = applyAgentEvent(chat, ev);
      const t = ev.type as string;
      // agent_start: сразу узнаём sessionFile новой сессии (live-точка в сайдбаре);
      // *_end: свежие stats и путь после хода/компакции
      if (t === "agent_start" || t === "agent_end" || t === "turn_end" || t === "compaction_end") {
        if (!finishedRuns.includes(cwd)) finishedRuns.push(cwd);
      }
      if (t === "extension_ui_request" && DIALOG_METHODS.has(String(ev.method))) newDialog = true;
    }
    nextChats[cwd] = { ...ws, chat };
  }
  eventQueue.clear();
  // новый диалоговый запрос разворачивает свёрнутую панель разрешений
  useStore.setState(newDialog ? { chats: nextChats, permCollapsed: false } : { chats: nextChats });
  for (const cwd of finishedRuns) {
    void refreshAgentMeta(cwd);
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

  await be.listen("agent-exit", (payload) => {
    const agentId = String(payload.agentId ?? "");
    const cwd = agentToCwd.get(agentId);
    if (!cwd) return;
    agentToCwd.delete(agentId);
    const reason = String(payload.reason ?? "");
    updateChat(cwd, (ws) => {
      if (ws.agentId !== agentId) return ws;
      const next = { ...ws, agentId: null, alive: false };
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
    const agentId = await be.invoke<string>("spawn_agent", {
      opts: { cwd, sessionPath: sessionPath ?? ws.sessionPath ?? null, extraArgs: [] },
    });
    agentToCwd.set(agentId, cwd);
    updateChat(cwd, (w) => ({ ...w, agentId, alive: true }));
    await refreshAgentMeta(cwd);
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
  timeoutMs = 30000,
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
    const sessionPath = (state.sessionPath ?? state.sessionFile ?? null) as string | null;
    updateChat(cwd, (ws) => ({ ...ws, agentState: state, sessionPath: sessionPath ?? ws.sessionPath }));
  } catch {
    /* agent may be busy or dead */
  }
  await refreshStats(cwd);
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
  discardQueuedEvents(cwd);
  if (ws.alive && ws.agentId) {
    await rpcRequest(cwd, { type: "new_session" }).catch(() => {});
    updateChat(cwd, (w) => ({ ...w, chat: emptyChatState(), sessionPath: null, checkpoints: [], stats: null }));
    await refreshAgentMeta(cwd);
  } else {
    updateChat(cwd, (w) => ({ ...w, chat: emptyChatState(), sessionPath: null, checkpoints: [], stats: null }));
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

export function selectWorkspace(cwd: string): void {
  useStore.setState({ currentCwd: cwd });
  void refreshSessions(cwd);
  void loadPermissionMode(cwd);
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
  await be.invoke("write_permission_preset", { cwd, mode });

  // перезапуск с той же сессией, чтобы permission-гейт перечитал конфиг
  const ws = getChat(cwd);
  if (ws.alive && ws.agentId) {
    await be.invoke("kill_agent", { agentId: ws.agentId }).catch(() => {});
    agentToCwd.delete(ws.agentId);
    updateChat(cwd, (w) => ({ ...w, agentId: null, alive: false }));
    await ensureAgent(cwd, ws.sessionPath);
    void loadModelsAndCommands(cwd);
  }
}

export function addWorkspace(cwd: string): void {
  const s = useStore.getState();
  if ([...s.projects, ...s.extraWorkspaces].some((p) => p.cwd === cwd)) {
    useStore.setState({ currentCwd: cwd });
    return;
  }
  const name = cwd.split("/").filter(Boolean).pop() ?? cwd;
  const ws: ProjectInfo = { dir: "(new)", cwd, name, sessionCount: 0, lastModifiedMs: Date.now() };
  useStore.setState({ extraWorkspaces: [...s.extraWorkspaces, ws], currentCwd: cwd });
}

// ---------- session management (sidebar) ----------

/** Открыть сессию в чате: живой агент переключается через switch_session,
 *  мёртвый — просто читаем файл; агент поднимется лениво при первом сообщении. */
export async function openSession(cwd: string, meta: SessionMeta): Promise<void> {
  const be = await getBackend();
  useStore.setState({ currentCwd: cwd, view: "chat" });

  const ws = getChat(cwd);
  discardQueuedEvents(cwd);
  updateChat(cwd, (w) => ({ ...w, chat: emptyChatState(), sessionPath: meta.path, checkpoints: [], stats: null }));

  if (ws.alive && ws.agentId) {
    try {
      await rpcRequest(cwd, { type: "switch_session", sessionPath: meta.path }, 15000);
      const data = await rpcRequest(cwd, { type: "get_messages" }, 20000);
      const messages = (data.messages ?? data) as { role: string; content: unknown }[];
      if (Array.isArray(messages)) {
        const entries = messages.map((m) => ({ type: "message", message: m }));
        updateChat(cwd, (w) => ({ ...w, chat: entriesToChatState(entries as Record<string, unknown>[]), sessionPath: meta.path }));
      }
      await refreshAgentMeta(cwd);
      return;
    } catch {
      /* агент занят/умер — падаем на файловый путь ниже */
    }
  }

  const entries = await be.invoke<Record<string, unknown>[]>("read_session", { path: meta.path }).catch(() => []);
  updateChat(cwd, (w) => ({
    ...w,
    chat: entriesToChatState(entries as Record<string, unknown>[]),
    sessionPath: meta.path,
  }));
}

export async function deleteSessionAction(cwd: string, path: string): Promise<void> {
  const be = await getBackend();
  const ws = getChat(cwd);
  // если удаляем открытую/активную сессию — сначала гасим агента
  if (ws.sessionPath === path) {
    if (ws.agentId) {
      await be.invoke("kill_agent", { agentId: ws.agentId }).catch(() => {});
      agentToCwd.delete(ws.agentId);
    }
    discardQueuedEvents(cwd);
    updateChat(cwd, (w) => ({ ...w, chat: emptyChatState(), sessionPath: null, agentId: null, alive: false, checkpoints: [], stats: null }));
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
  await ensureAgent(cwd, ws.sessionPath);
  const data = await rpcRequest(cwd, { type: "get_fork_messages" }, 15000);
  const msgs = (data.messages ?? []) as { entryId: string; text: string }[];
  const target = pickForkEntry(msgs, userIndex, text);
  if (!target) throw new Error("Сообщение для отката не найдено");
  const res = (await rpcRequest(cwd, { type: "fork", entryId: target.entryId }, 60000)) as {
    text?: string;
    cancelled?: boolean;
  };
  if (res.cancelled) return;
  const md = await rpcRequest(cwd, { type: "get_messages" }, 20000);
  const messages = (md.messages ?? md) as { role: string; content: unknown }[];
  discardQueuedEvents(cwd);
  updateChat(cwd, (w) => {
    const chat = entriesToChatState(
      (Array.isArray(messages) ? messages : []).map((m) => ({ type: "message", message: m })) as Record<
        string,
        unknown
      >[],
    );
    chat.editorPrefill = res.text ?? target.text;
    return { ...w, chat };
  });
  await refreshAgentMeta(cwd);
}

/** «Fork from here»: новая сессия с историей строго до выбранного сообщения;
 *  исходная сессия не меняется, текст сообщения — в composer новой. */
export async function forkFromMessage(cwd: string, userIndex: number, text: string): Promise<void> {
  const ws = getChat(cwd);
  if (!ws.sessionPath) throw new Error("Сессия ещё не сохранена на диск");
  await ensureAgent(cwd, ws.sessionPath);
  const data = await rpcRequest(cwd, { type: "get_fork_messages" }, 15000);
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
