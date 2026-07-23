import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { getBackend } from "../lib/backend";
import { confirmDialog, messageDialog } from "../lib/dialog";
import { stripAnsi } from "../lib/markdown";
import { contentText } from "../lib/reducer";
import { modelAliasKey, modelDisplayName, modelIdDisplayName } from "../lib/models";
import type { BackgroundTaskView, ComposerAttachment, ExtUiRequest, GitSummary, ModelInfo } from "../lib/types";
import { formatRunDuration } from "../lib/turn-timing";
import {
  abortAgent,
  activeBackgroundTaskCount,
  compactContext,
  controlBackgroundTask,
  controlWorkflow,
  isBrowsingAway,
  loadModelsAndCommands,
  msgPinId,
  newSession,
  notifyChat,
  refreshStats,
  respondToUiRequest,
  returnToSessionBranch,
  returnToLiveSession,
  selectWorkspace,
  sendFollowUp,
  sendPrompt,
  setAgentMode,
  setAutoCompaction,
  setModel,
  setThinkingLevel,
  toggleMessagePin,
  updateAppConfig,
  useStore,
  emptyWorkspaceChat,
  effectiveModel,
  effectiveThinking,
  type AgentMode,
  type WorkspaceChat,
} from "../state/store";
import { ExpandedProvider, MessageView, RunActivitySummary, RunFilesCard, Toasts } from "./MessageView";
import { buildTranscript } from "../lib/transcript";
import StartScreen from "./StartScreen";
import PreviewPane from "./PreviewView";
import { ModelAvatar, ModelAvatarPicker } from "./AgentAvatar";
import { ChevronIcon, EditIcon, ImageIcon, MinusIcon, ModelIcon, PaperclipIcon, PinIcon, PlusIcon, PreviewIcon, SendIcon, ShieldIcon, SteerIcon, StopIcon, TasksIcon } from "./icons";

// ---------- agent mode selector ----------

const MODES: { id: AgentMode; label: string; desc: string }[] = [
  { id: "ask", label: "Ask permissions", desc: "Правки и команды — с подтверждением" },
  { id: "accept-edits", label: "Accept edits", desc: "Правки файлов без вопросов, команды — с подтверждением" },
  { id: "plan", label: "Plan mode", desc: "Только исследование и план, без изменений (plannotator)" },
  { id: "auto", label: "Auto mode", desc: "Всё разрешено, опасные команды — с подтверждением" },
  { id: "bypass", label: "Bypass permissions", desc: "Без ограничений (yolo) — на свой риск" },
];

const TRANSCRIPT_MODES = [
  { id: "summary", label: "Summary", title: "Только ответы, активные и ошибочные инструменты" },
  { id: "normal", label: "Normal", title: "Ответы и свёрнутые карточки инструментов" },
  { id: "verbose", label: "Verbose", title: "Полный thinking и раскрытые результаты инструментов" },
] as const;

function PillSelect<T extends string>({
  value,
  options,
  onChange,
  title,
  disabled,
}: {
  value: T;
  options: readonly { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
  title: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="inline-select" ref={rootRef}>
      <button type="button" className="chip" disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)}>
        {current?.label}<ChevronIcon size={11} open={open} />
      </button>
      {open && (
        <div className="inline-select-menu" role="listbox" aria-label={title}>
          {options.map((option) => (
            <button
              type="button"
              key={option.value}
              className={option.value === value ? "active" : ""}
              role="option"
              aria-selected={option.value === value}
              onClick={() => { setOpen(false); onChange(option.value); }}
            >
              <span className="inline-select-option"><strong>{option.label}</strong>{option.title && <small>{option.title}</small>}</span>
              {option.value === value && <span>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TranscriptModeSelector() {
  const value = useStore((s) => s.appConfig.transcriptMode ?? "normal");
  return (
    <PillSelect
      value={value}
      title="Режим ленты"
      options={TRANSCRIPT_MODES.map((mode) => ({ value: mode.id, label: mode.label, title: mode.title }))}
      onChange={(transcriptMode) => void updateAppConfig({ transcriptMode })}
    />
  );
}

function ModeSelector({ cwd, ws }: { cwd: string; ws: WorkspaceChat }) {
  const [open, setOpen] = useState(false);
  const current = MODES.find((m) => m.id === ws.mode) ?? MODES[0];
  const planActive = Object.values(ws.chat.statusEntries).some((s) => stripAnsi(s).includes("plan"));
  const backgroundCount = activeBackgroundTaskCount(ws);

  return (
    <div style={{ position: "relative" }}>
      <button
        className="chip"
        title={current.desc}
        disabled={ws.chat.isStreaming || backgroundCount > 0}
        onClick={() => setOpen(!open)}
        style={ws.mode === "bypass" ? { color: "var(--warn)" } : ws.mode === "plan" || planActive ? { color: "var(--accent)" } : undefined}
      >
        ⌁ {current.label}
      </button>
      {open && (
        <div className="dropdown" onMouseLeave={() => setOpen(false)}>
          <div className="dd-list">
            {MODES.map((m) => (
              <div
                key={m.id}
                className={`dd-item ${ws.mode === m.id ? "sel" : ""}`}
                onClick={() => {
                  setOpen(false);
                  void setAgentMode(cwd, m.id).catch((error) =>
                    notifyChat(cwd, "warning", error instanceof Error ? error.message : String(error)));
                }}
              >
	                <div>
                  <div>{m.label}</div>
                  <div className="dd-sub">{m.desc}</div>
                </div>
              </div>
            ))}
            <div className="dd-sub" style={{ padding: "6px 10px" }}>
              Permission-режимы используют @gotgenes/pi-permission-system (project-конфиг + перезапуск),
              Plan mode — /plannotator.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- git status bar (в стиле Claude for Mac) ----------

function GitBar({ cwd, ws }: { cwd: string; ws: WorkspaceChat }) {
  const [sum, setSum] = useState<GitSummary | null>(null);
  const [prOpen, setPrOpen] = useState(false);
  const streaming = ws.chat.isStreaming;

  const refresh = useCallback(async () => {
    const be = await getBackend();
    const s = await be.invoke<GitSummary>("git_summary", { cwd }).catch(() => null);
    setSum(s);
  }, [cwd]);

  useEffect(() => {
    if (!streaming) void refresh();
  }, [refresh, streaming]);

  if (!sum?.isRepo || (sum.insertions === 0 && sum.deletions === 0)) return null;

  const createPrViaAgent = () => {
    setPrOpen(false);
    void sendPrompt(
      cwd,
      "Подготовь pull/merge request по текущим незакоммиченным изменениям: если мы на main/master — создай ветку с осмысленным именем; сделай коммит(ы) с внятными сообщениями; запушь в origin. Затем открой запрос средствами, доступными в этом окружении: для GitHub — `gh pr create --fill`, для GitLab — `glab mr create --fill` (или push-опция), для остального — просто дай ссылку на страницу создания PR/MR. Используй существующую авторизацию пользователя (gh/glab/git), ничего не хардкодь. Перед этим кратко перечисли, что войдёт в запрос.",
    ).catch((e) => notifyChat(cwd, "warning", e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="gitbar">
      <span className="gb-proj">{cwd.split("/").pop()}</span>
      <span className="gb-branch">{sum.branch}</span>
      {(sum.ahead > 0 || sum.behind > 0) && (
        <span className="hint" title="Коммиты впереди/позади upstream">
          {sum.ahead > 0 ? `↑${sum.ahead}` : ""}
          {sum.behind > 0 ? ` ↓${sum.behind}` : ""}
        </span>
      )}
      <span className="gb-add">+{sum.insertions.toLocaleString("en-US")}</span>
      <span className="gb-del">−{sum.deletions.toLocaleString("en-US")}</span>
      <div className="grow" />
      <div style={{ position: "relative", display: "flex" }}>
        <button className="gb-pr" onClick={createPrViaAgent} title="Агент создаст ветку, коммит и PR">
          Create PR
        </button>
        <button className="gb-pr gb-pr-caret" onClick={() => setPrOpen(!prOpen)}>
          ▾
        </button>
        {prOpen && (
          <div className="menu" style={{ bottom: "100%", top: "auto", right: 0 }} onMouseLeave={() => setPrOpen(false)}>
            <button onClick={createPrViaAgent}>Через агента (ветка + коммит + PR/MR)</button>
            <button
              onClick={() => {
                setPrOpen(false);
                void (async () => {
                  const be = await getBackend();
                  await be.invoke("git_open_pr", { cwd }).catch((e) => messageDialog(String(e), { kind: "error" }));
                })();
              }}
            >
              Открыть PR/MR в браузере
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const EMPTY_WS = emptyWorkspaceChat();
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

function useWorkspace(cwd: string | null): WorkspaceChat {
  const chats = useStore((s) => s.chats);
  return (cwd && chats[cwd]) || EMPTY_WS;
}

// ---------- model picker ----------

function ModelPicker({ cwd, ws }: { cwd: string; ws: WorkspaceChat }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [aliasModel, setAliasModel] = useState<ModelInfo | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const piDefaults = useStore((s) => s.piDefaults);
  // до старта агента список берём из models.json, а текущую — из дефолтов pi
  const current = effectiveModel(ws, piDefaults);
  const aliases = useStore((s) => s.appConfig.modelAliases ?? {});

  const filtered = useMemo(() => {
    const list = ws.models.length > 0 ? ws.models : piDefaults.catalog;
    const query = q.toLowerCase();
    return query
      ? list.filter((m) => `${m.provider}/${m.id} ${modelDisplayName(m, aliases)}`.toLowerCase().includes(query))
      : list;
  }, [ws.models, piDefaults.catalog, q, aliases]);

  const pick = async (m: ModelInfo) => {
    setOpen(false);
    await setModel(cwd, m.provider, m.id).catch(() => {});
  };

  const editAlias = (m: ModelInfo) => {
    setAliasModel(m);
    setAliasDraft(aliases[modelAliasKey(m.provider, m.id)] ?? "");
  };

  const saveAlias = async () => {
    if (!aliasModel) return;
    const key = modelAliasKey(aliasModel.provider, aliasModel.id);
    const next = { ...aliases };
    if (aliasDraft.trim()) next[key] = aliasDraft.trim();
    else delete next[key];
    await updateAppConfig({ modelAliases: next });
    setAliasModel(null);
  };

  return (
    <div style={{ position: "relative" }}>
      <button
        className="chip"
        title={current ? `${current.provider}/${current.id}` : "Модель"}
        onClick={async () => {
          setOpen(!open);
          if (!open && ws.models.length === 0 && ws.alive) await loadModelsAndCommands(cwd);
        }}
      >
        {current
          ? <ModelAvatar modelKey={modelAliasKey(current.provider, current.id)} size={17} />
          : <ModelIcon size={12} motion={open ? "pulse" : undefined} />}
        {current ? shortModel(modelDisplayName(current, aliases)) : "модель"}
      </button>
      {open && (
        <div className="dropdown" onMouseLeave={() => setOpen(false)}>
          <input autoFocus placeholder="Поиск модели…" value={q} onChange={(e) => setQ(e.target.value)} />
          {aliasModel && (
            <div className="model-alias-editor">
              <ModelAvatarPicker modelKey={modelAliasKey(aliasModel.provider, aliasModel.id)} size={32} />
              <div>
                <strong>Название в интерфейсе</strong>
                <span>{aliasModel.provider}/{aliasModel.id}</span>
              </div>
              <input
                autoFocus
                placeholder="Например: Claude Opus 4.7"
                value={aliasDraft}
                onChange={(e) => setAliasDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveAlias();
                  if (e.key === "Escape") setAliasModel(null);
                }}
              />
              <div className="row">
                <button onClick={() => setAliasModel(null)}>Отмена</button>
                <button className="primary" onClick={() => void saveAlias()}>Сохранить</button>
              </div>
            </div>
          )}
          <div className="dd-list">
            {filtered.length === 0 && (
              <div className="dd-item">{ws.alive || piDefaults.catalog.length > 0 ? "Нет моделей" : "Модели не найдены в models.json"}</div>
            )}
            {filtered.map((m) => (
              <div
                key={`${m.provider}/${m.id}`}
                className={`dd-item ${current?.id === m.id ? "sel" : ""}`}
                onClick={() => void pick(m)}
              >
                <ModelAvatar modelKey={modelAliasKey(m.provider, m.id)} size={25} />
                <div className="model-option-copy">
                  <div>{modelDisplayName(m, aliases)}</div>
                  <div className="dd-sub">
                    {m.provider}/{m.id}
                    {m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k ctx` : ""}
                    {m.reasoning ? " · reasoning" : ""}
                  </div>
                </div>
                <button
                  className="model-alias-button"
                  title="Задать отображаемое название"
                  onClick={(e) => {
                    e.stopPropagation();
                    editAlias(m);
                  }}
                >
                  <EditIcon size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function shortModel(id: string): string {
  return id.length > 28 ? id.slice(0, 26) + "…" : id;
}

// ---------- extension UI dock (не блокирует чат: панель над composer) ----------

/** Обратный отсчёт до автоответа pi; работает и в свёрнутом виде. */
function useRequestCountdown(cwd: string, req: ExtUiRequest | undefined): number | null {
  const timeout = req?.timeout;
  const id = req?.id;
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!timeout || !id) {
      setLeft(null);
      return;
    }
    setLeft(Math.ceil(timeout / 1000));
    const started = Date.now();
    const t = setInterval(() => {
      const remain = Math.ceil((timeout - (Date.now() - started)) / 1000);
      setLeft(remain);
      if (remain <= 0) {
        clearInterval(t);
        // pi auto-resolves on timeout; just drop the dialog locally
        respondToUiRequest(cwd, id, { cancelled: true });
      }
    }, 500);
    return () => clearInterval(t);
  }, [cwd, id, timeout]);
  return left;
}

function ExtensionUIPanel({ cwd, req, count, left }: { cwd: string; req: ExtUiRequest; count: number; left: number | null }) {
  const [value, setValue] = useState(req.prefill ?? "");
  const [sel, setSel] = useState(0);
  const options = Array.isArray(req.options) ? req.options.map(String) : [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // хоткеи панели работают, только если фокус не в текстовом поле:
      // composer остаётся полноценным (можно печатать и steer'ить агента)
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (req.method === "select") {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSel((s) => Math.min(s + 1, options.length - 1));
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSel((s) => Math.max(s - 1, 0));
        }
        if (e.key === "Enter" && options[sel] != null) {
          e.preventDefault();
          respondToUiRequest(cwd, req.id, { value: options[sel] });
        }
        const n = parseInt(e.key, 10);
        if (n >= 1 && n <= options.length) {
          e.preventDefault();
          respondToUiRequest(cwd, req.id, { value: options[n - 1] });
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        respondToUiRequest(cwd, req.id, { cancelled: true });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cwd, req, sel, options]);

  return (
    <div className="perm-panel">
      <div className="pp-head">
        <ShieldIcon size={14} />
        <span className="pp-title">{req.title ?? "Запрос расширения"}</span>
        {count > 1 && <span className="badge">{count}</span>}
        {left != null && left > 0 && <span className="hint">автоответ {left}с</span>}
        <button
          title="Свернуть — чат останется доступным"
          onClick={() => useStore.getState().set({ permCollapsed: true })}
        >
          <MinusIcon size={13} />
        </button>
      </div>
      {req.message && <div className="pp-msg">{stripAnsi(String(req.message))}</div>}

      {req.method === "select" && (
        <div className="m-opts">
          {options.map((o, i) => (
            <button
              key={i}
              className={`m-opt ${i === sel ? "sel" : ""}`}
              onClick={() => respondToUiRequest(cwd, req.id, { value: o })}
            >
              {i < 9 ? `${i + 1}. ` : ""}
              {o}
            </button>
          ))}
        </div>
      )}

      {req.method === "confirm" && (
        <div className="m-actions">
          <button onClick={() => respondToUiRequest(cwd, req.id, { confirmed: false })}>Нет</button>
          <button className="primary" onClick={() => respondToUiRequest(cwd, req.id, { confirmed: true })}>
            Да
          </button>
        </div>
      )}

      {req.method === "input" && (
        <>
          <input
            autoFocus
            placeholder={req.placeholder ?? ""}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && respondToUiRequest(cwd, req.id, { value })}
          />
          <div className="m-actions">
            <button onClick={() => respondToUiRequest(cwd, req.id, { cancelled: true })}>Отмена</button>
            <button className="primary" onClick={() => respondToUiRequest(cwd, req.id, { value })}>
              OK
            </button>
          </div>
        </>
      )}

      {req.method === "editor" && (
        <>
          <textarea autoFocus value={value} onChange={(e) => setValue(e.target.value)} style={{ minHeight: 110 }} />
          <div className="m-actions">
            <button onClick={() => respondToUiRequest(cwd, req.id, { cancelled: true })}>Отмена</button>
            <button className="primary" onClick={() => respondToUiRequest(cwd, req.id, { value })}>
              Сохранить
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ExtensionUIDock({ cwd, ws }: { cwd: string; ws: WorkspaceChat }) {
  const collapsed = useStore((s) => s.permCollapsed);
  const req = ws.chat.uiRequests[0];
  const count = ws.chat.uiRequests.length;
  const left = useRequestCountdown(cwd, req);
  if (!req) return null;

  if (collapsed) {
    return (
      <button className="perm-pill" onClick={() => useStore.getState().set({ permCollapsed: false })}>
        <ShieldIcon size={13} />
        <span className="pp-title">{req.title ?? "Запрос разрешения"}</span>
        {count > 1 && <span className="badge">{count}</span>}
        {left != null && left > 0 && <span className="hint">{left}с</span>}
        <span className="hint">развернуть</span>
      </button>
    );
  }
  return <ExtensionUIPanel key={req.id} cwd={cwd} req={req} count={count} left={left} />;
}

// ---------- composer ----------

type Attachment = ComposerAttachment;

type WorkflowTab = "tasks" | "plan" | "workflow" | "context" | "branches";

type LocatedBackgroundTask = { cwd: string; task: BackgroundTaskView };

function BackgroundTasksTopbar({ currentCwd, tasks }: { currentCwd: string; tasks: LocatedBackgroundTask[] }) {
  const [open, setOpen] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const [cancelling, setCancelling] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = tasks.filter(({ task }) => task.status === "queued" || task.status === "running");
  const running = active.filter(({ task }) => task.status === "running").length;

  useEffect(() => {
    if (active.length === 0) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active.length]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (active.length === 0) setOpen(false);
  }, [active.length]);

  if (active.length === 0) return null;

  const cancel = (cwd: string, task: BackgroundTaskView) => {
    const key = `${cwd}:${task.id}`;
    setCancelling(key);
    void controlBackgroundTask(cwd, "cancel", task.id)
      .catch((error) => notifyChat(cwd, "warning", error instanceof Error ? error.message : String(error)))
      .finally(() => setCancelling(null));
  };

  return (
    <div className="background-topbar" ref={rootRef}>
      <button
        type="button"
        className={`chip background-task-trigger ${running > 0 ? "running" : "queued"}`}
        aria-label={`Фоновые задачи: ${active.length}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="background-task-pulse" />
        <TasksIcon size={13} />
        <span className="background-task-label">{active.length === 1 ? "Background task" : `${active.length} background`}</span>
        <ChevronIcon size={11} open={open} />
      </button>
      {open && (
        <section className="background-task-popover" role="dialog" aria-label="Активные фоновые задачи">
          <header>
            <div><strong>Background tasks</strong><small>Продолжаются после завершения хода</small></div>
            <span>{running} running · {active.length - running} queued</span>
          </header>
          <div className="background-task-list">
            {active.map(({ cwd, task }) => {
              const elapsed = task.startedAt == null ? 0 : Math.max(0, clock - task.startedAt);
              const heartbeatAge = task.heartbeatAt == null ? null : Math.max(0, clock - task.heartbeatAt);
              const heartbeatFresh = heartbeatAge == null || heartbeatAge < 90_000;
              return (
                <article key={`${cwd}:${task.id}`} className="background-task-row">
                  <span className={`step-state ${task.status}`} />
                  <div>
                    <strong>{task.description}</strong>
                    <small>{cwd.split("/").pop()} · {task.type} · {task.status}{elapsed > 0 ? ` · ${formatRunDuration(elapsed)}` : ""}</small>
                    {task.status === "running" && <em className={heartbeatFresh ? "live" : "stale"}>{heartbeatFresh ? "Protected · live" : "Heartbeat delayed"}</em>}
                    {task.status === "queued" && task.queuePosition != null && <em>Queue #{task.queuePosition}</em>}
                  </div>
                  <button type="button" disabled={cancelling === `${cwd}:${task.id}`} onClick={() => cancel(cwd, task)}>
                    {cancelling === `${cwd}:${task.id}` ? "Stopping…" : "Stop"}
                  </button>
                </article>
              );
            })}
          </div>
          <footer>
            <span>Idle cleanup и session eviction отключены, пока задачи активны.</span>
            <button type="button" onClick={() => {
              setOpen(false);
              const target = active.find((item) => item.cwd === currentCwd) ?? active[0];
              if (target && target.cwd !== currentCwd) selectWorkspace(target.cwd);
              window.setTimeout(() => window.dispatchEvent(new CustomEvent("pi:open-background-tasks")), 0);
            }}>Task center</button>
          </footer>
        </section>
      )}
    </div>
  );
}

function WorkflowDock({ cwd, ws }: { cwd: string; ws: WorkspaceChat }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<WorkflowTab>("workflow");
  const [steerId, setSteerId] = useState<string | null>(null);
  const [steerText, setSteerText] = useState("");
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [taskEvidence, setTaskEvidence] = useState<"transcript" | "diff">("transcript");
  const [clock, setClock] = useState(() => Date.now());
  const workflow = ws.chat.workflow;
  const plannedTasks = ws.chat.plannedTasks.filter((task) => task.status !== "deleted");
  const tasks = ws.chat.backgroundTasks;
  const compactions = ws.chat.compactions;
  const checkpoints = ws.chat.structuredCheckpoints;
  const branches = ws.chat.branches;
  const liveContext = ws.stats?.contextUsage;
  const activeTasks = tasks.filter((task) => task.status === "queued" || task.status === "running").length;
  useEffect(() => {
    if (activeTasks === 0) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activeTasks]);
  useEffect(() => {
    const openTasks = () => {
      setTab("tasks");
      setOpen(true);
    };
    window.addEventListener("pi:open-background-tasks", openTasks);
    return () => window.removeEventListener("pi:open-background-tasks", openTasks);
  }, []);
  if (!workflow && plannedTasks.length === 0 && tasks.length === 0 && compactions.length === 0 && checkpoints.length === 0 && branches.length === 0) return null;
  const failedSteps = workflow?.steps.filter((step) => step.status === "failed").length ?? 0;
  const tabs: Array<{ id: WorkflowTab; label: string; count?: number }> = [
    { id: "tasks", label: "Tasks", count: activeTasks || tasks.length },
    { id: "plan", label: "Plan", count: plannedTasks.length || workflow?.steps.filter((step) => step.kind === "plan" || step.id === "approve").length },
    { id: "workflow", label: "Workflow", count: failedSteps || workflow?.steps.length },
    { id: "context", label: "Context", count: compactions.length + checkpoints.length },
    { id: "branches", label: "Branches", count: branches.length },
  ];
  const invoke = (fn: () => Promise<void>) => void fn().catch((error) => notifyChat(cwd, "warning", error instanceof Error ? error.message : String(error)));

  return (
    <section className={`workflow-dock ${open ? "open" : ""}`} aria-label="Workflow control center">
      <button className="workflow-summary" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className={`workflow-pulse ${failedSteps ? "failed" : activeTasks ? "running" : ""}`} />
        <strong>{workflow ? `${workflow.profile} · ${workflow.status ?? "active"} · ${workflow.steps.filter((step) => step.status === "passed" || step.status === "skipped").length}/${workflow.steps.length}` : "Session workflow"}</strong>
        {activeTasks > 0 && <span>{activeTasks} active</span>}
        {failedSteps > 0 && <span className="workflow-error">{failedSteps} failed</span>}
        <ChevronIcon size={12} open={open} />
      </button>
      {open && (
        <div className="workflow-panel">
          <nav className="workflow-tabs">
            {tabs.map((item) => (
              <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>
                {item.label}{item.count ? <small>{item.count}</small> : null}
              </button>
            ))}
          </nav>

          {tab === "tasks" && (
            <div className="workflow-list">
              {tasks.length === 0 && <p className="workflow-empty">Фоновых задач пока нет.</p>}
              {[...tasks].reverse().map((task) => (
                <article className="task-card" key={task.id}>
                  <div className="task-head">
                    <span className={`step-state ${task.status}`} />
                    <strong>{task.description}</strong><small>{task.type} · {task.status}</small>
                  </div>
                  <div className="task-meta">
					{(task.durationMs != null || task.startedAt != null) && <span>{Math.max(1, Math.round((task.durationMs ?? Math.max(0, clock - task.startedAt!)) / 1000))}s</span>}
                    {task.tokens != null && <span>{task.tokens.toLocaleString()} tok</span>}
					{task.priority && <span>priority: {task.priority}</span>}
					{task.queuePosition != null && <span>queue #{task.queuePosition}</span>}
					{task.etaMs != null && <span title="Estimated from completed task durations">ETA ≈ {Math.max(1, Math.ceil(task.etaMs / 60_000))}m</span>}
					{task.type === "independent-evaluator" && <span>read-only · tied to current run</span>}
                    {task.branch && <span title={task.baseSha}>branch: {task.branch}</span>}
                    {task.mergedCommit && <span>merged: {task.mergedCommit.slice(0, 10)}</span>}
                  </div>
				  {task.blockedReason && <small className="workflow-error">{task.blockedReason}</small>}
                  <div className="task-actions">
					{task.type !== "independent-evaluator" && (task.status === "queued" || task.status === "running") && <button onClick={() => invoke(() => controlBackgroundTask(cwd, "cancel", task.id))}>Cancel</button>}
					{task.type !== "independent-evaluator" && (task.status === "queued" || task.status === "running") && <button onClick={() => setSteerId(steerId === task.id ? null : task.id)}>Steer</button>}
                    <button onClick={() => {
                      setExpandedTask(expandedTask === task.id ? null : task.id);
                      setTaskEvidence("transcript");
                      if (!task.transcript) invoke(() => controlBackgroundTask(cwd, "transcript", task.id));
                    }}>Transcript</button>
                    <button disabled={!task.branch} title={task.branch ? "Inspect isolated branch diff" : "Task has no isolated branch"} onClick={() => {
                      setExpandedTask(task.id);
                      setTaskEvidence("diff");
                      invoke(() => controlBackgroundTask(cwd, "diff", task.id));
                    }}>Diff</button>
					{task.type !== "independent-evaluator" && <button onClick={() => invoke(() => controlBackgroundTask(cwd, "retry", task.id))}>Retry</button>}
                    <button disabled={task.status !== "completed" || !task.branch || Boolean(task.mergedCommit)} onClick={() => invoke(async () => {
                      const ok = await confirmDialog(
                        `Слить проверенную ветку «${task.branch}» из фоновой задачи?\n\n${task.description}\n\nMerge будет выполнен только из чистого parent worktree и только после прохождения обязательных verifier-команд в отдельном integration worktree.`,
                        { title: "Merge background task", kind: "warning", okLabel: "Verify & Merge" },
                      );
                      if (ok) await controlBackgroundTask(cwd, "merge", task.id, "confirmed");
                    })}>Merge</button>
                  </div>
                  {steerId === task.id && <div className="task-steer"><input value={steerText} onChange={(event) => setSteerText(event.target.value)} placeholder="Новая инструкция задаче" /><button onClick={() => { invoke(() => controlBackgroundTask(cwd, "steer", task.id, steerText)); setSteerId(null); setSteerText(""); }}>Send</button></div>}
                  {expandedTask === task.id && <pre className="task-transcript">{
                    taskEvidence === "diff"
                      ? task.diff || "Diff evidence is being collected from the isolated branch."
                      : task.transcript || task.result || task.error || "Transcript evidence is being collected directly from the task record."
                  }</pre>}
                </article>
              ))}
            </div>
          )}

          {tab === "plan" && (
            <div className="workflow-list">
              {!workflow && <p className="workflow-empty">Workflow ещё не создан.</p>}
              {workflow && <article className="workflow-objective">
                <strong>{workflow.objective || "Current session objective"}</strong>
                <small>{workflow.intent.primary} · risk {workflow.intent.risk} · {workflow.intent.signals.join(", ") || "no special routing signals"}</small>
              </article>}
              {workflow?.steps.filter((step) => step.kind === "plan" || step.id === "approve").map((step) => (
                <article className="workflow-step" key={step.id}>
                  <span className={`step-state ${step.status}`} /><div><strong>{step.label}</strong><p>{step.acceptance}</p><small>deps: {step.deps.join(", ") || "none"}</small></div><b>{step.status}</b>
                </article>
              ))}
              {plannedTasks.length > 0 && <div className="plan-backlog-head"><strong>Execution backlog</strong><small>{plannedTasks.filter((task) => task.status === "completed").length}/{plannedTasks.length} complete</small></div>}
              {plannedTasks.map((task) => (
                <article className="workflow-step plan-task" key={`plan-task-${task.id}`}>
                  <span className={`step-state ${task.status}`} />
                  <div className="plan-task-body">
                    <strong>#{task.id} {task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject}</strong>
                    {task.description && <p>{task.description}</p>}
                    <small>{task.blockedBy?.length ? `blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ")}` : "ready"}{task.owner ? ` · ${task.owner}` : ""}</small>
                  </div>
                  <b>{task.status.replace("_", " ")}</b>
                </article>
              ))}
              {workflow && !workflow.approved && <button className="workflow-primary" onClick={() => invoke(() => controlWorkflow(cwd, "approve-plan"))}>Approve plan</button>}
              {workflow?.approved && workflow.intent.requiresPlan && <p className="workflow-empty">Plan approved · workflow can continue.</p>}
            </div>
          )}

          {tab === "workflow" && (
            <div className="workflow-list">
              {workflow?.steps.map((step) => (
                <article className="workflow-step" key={step.id} title={step.detail}>
                  <span className={`step-state ${step.status}`} /><div><strong>{step.label}</strong><p>{step.acceptance}</p><small>{step.deps.length ? `after ${step.deps.join(", ")}` : "ready first"}{step.command ? ` · ${step.command}` : ""} · {step.owner ?? "orchestrator"} · attempt {step.attempts}/{step.maxAttempts ?? "?"}</small>{step.failureReason && <small className="workflow-error">{step.failureReason}</small>}</div><b>{step.status}</b>
                </article>
              ))}
              {workflow?.blockedReason && <article className="workflow-objective"><strong>{workflow.status === "needs-human" ? "Human input required" : "Workflow blocked"}</strong><p>{workflow.blockedReason}</p>{workflow.terminationReason && <small>{workflow.terminationReason}</small>}</article>}
              {workflow?.events.length ? <details className="workflow-timeline"><summary>Timeline · {workflow.events.length} events</summary>{[...workflow.events].reverse().slice(0, 40).map((event) => <div key={event.id}><time>{new Date(event.at).toLocaleTimeString()}</time><span>{event.message}</span></div>)}</details> : null}
              {failedSteps > 0 && <button className="workflow-primary" onClick={() => invoke(() => controlWorkflow(cwd, "retry-gates"))}>Retry failed gates</button>}
            </div>
          )}

          {tab === "context" && (
            <div className="workflow-list">
              {liveContext && <article className="context-live">
                <div><strong>Live context</strong><span>{liveContext.percent?.toFixed(1) ?? "?"}%</span></div>
                <progress max={100} value={liveContext.percent ?? 0} />
                <small>{liveContext.tokens?.toLocaleString() ?? "?"} / {liveContext.contextWindow?.toLocaleString() ?? ws.agentState?.model?.contextWindow?.toLocaleString() ?? "?"} tokens · checkpoint at 75% · compact at window − configured reserve</small>
              </article>}
              {[...checkpoints].reverse().map((item) => <details key={`cp-${item.at}`} className="context-record"><summary>Checkpoint · {new Date(item.at).toLocaleTimeString()} · {item.context?.percent?.toFixed(0) ?? "?"}%</summary><p>{item.objective}</p><small>{item.nextAction ?? `next: ${item.nextReadySteps?.join(", ") || "none"}`}</small><pre>{JSON.stringify({ decisions: item.decisions, gates: item.gateEvidence, risks: item.risks, steps: item.steps }, null, 2)}</pre></details>)}
              {[...compactions].reverse().map((item) => <details key={`compact-${item.at}`} className="context-record"><summary>Compaction · {item.tokensBefore?.toLocaleString() ?? "?"} tokens</summary><p>{item.summary}</p></details>)}
              {checkpoints.length + compactions.length === 0 && <p className="workflow-empty">Сжатий и checkpoint пока нет.</p>}
            </div>
          )}

          {tab === "branches" && (
            <div className="workflow-list">
              {[...branches].reverse().map((item) => (
                <article className="branch-card" key={`${item.at}-${item.abandonedLeafId ?? item.leafId}`}>
                  <div>
                    <strong>{item.abandonedLeafId ? "Rewind" : "Branch return"}</strong>
                    <p>{item.targetPreview || item.abandonedUserMessages?.[0] || new Date(item.at).toLocaleString()}</p>
                    <small>{new Date(item.at).toLocaleString()} · removed entries: {item.abandonedEntryCount ?? "?"} · stopped tasks: {item.stoppedTaskIds?.length ?? 0}</small>
                  </div>
                  {item.abandonedLeafId && <button onClick={() => invoke(() => returnToSessionBranch(cwd, item.abandonedLeafId!))}>Return</button>}
                </article>
              ))}
              {branches.length === 0 && <p className="workflow-empty">В этой сессии ещё нет rewind-веток.</p>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Composer({ cwd, ws }: { cwd: string; ws: WorkspaceChat }) {
  const piDefaults = useStore((s) => s.piDefaults);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [contextFiles, setContextFiles] = useState<string[]>([]);
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const [palIdx, setPalIdx] = useState(0);
  // Esc скрывает палитру команд, НЕ стирая ввод; следующее изменение текста показывает снова
  const [palHidden, setPalHidden] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const streaming = ws.chat.isStreaming;
  const pendingInsert = useStore((s) => s.pendingInsert);
  const pendingFiles = useStore((s) => s.pendingFiles);
  const sendKeyBehavior = useStore((s) => s.appConfig.sendKeyBehavior ?? "enter");
  const canSendImages = ws.agentState?.model?.input?.includes("image") ?? true;

  // автофокус при смене workspace / открытии чата
  useEffect(() => {
    taRef.current?.focus();
  }, [cwd]);

  // вставка из drag&drop (пути файлов)
  useEffect(() => {
    if (pendingInsert) {
      setText((t) => (t ? `${t} ${pendingInsert}` : pendingInsert));
      useStore.getState().set({ pendingInsert: null });
      taRef.current?.focus();
    }
  }, [pendingInsert]);

  // Finder drop: vision models receive image blocks; everything else stays as
  // an explicit path-context chip instead of leaking base64 into the prompt.
  useEffect(() => {
    if (!pendingFiles?.length) return;
    useStore.getState().set({ pendingFiles: null });
    void (async () => {
      const be = await getBackend();
      const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
      const paths: string[] = [];
      for (const path of pendingFiles) {
        const extension = path.split(".").pop()?.toLowerCase() ?? "";
        if (canSendImages && imageExtensions.has(extension)) {
          const file = await be.invoke<{ data: string; mimeType: string }>("read_file_base64", { path }).catch(() => null);
          if (file) {
            setAttachments((current) => [...current, { ...file, name: path.split("/").pop() ?? path }]);
            continue;
          }
        }
        paths.push(path);
      }
      if (paths.length) setContextFiles((current) => [...new Set([...current, ...paths])]);
      taRef.current?.focus();
    })();
  }, [pendingFiles, canSendImages]);

  // extension prefill (set_editor_text)
  useEffect(() => {
    if (ws.chat.editorPrefill != null) {
      setText(ws.chat.editorPrefill);
      if (ws.chat.editorAttachments != null) setAttachments(ws.chat.editorAttachments);
      if (ws.chat.editorContextFiles != null) setContextFiles(ws.chat.editorContextFiles);
      const s = useStore.getState();
      const w = s.chats[cwd];
      if (w) s.set({ chats: { ...s.chats, [cwd]: { ...w, chat: { ...w.chat, editorPrefill: null, editorAttachments: null, editorContextFiles: null } } } });
    }
  }, [ws.chat.editorPrefill, ws.chat.editorAttachments, ws.chat.editorContextFiles, cwd]);

  useEffect(() => {
    const ta = taRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 220) + "px";
    }
  }, [text]);

  const paletteItems = useMemo(() => {
    if (palHidden) return [];
    if (!text.startsWith("/") || text.includes(" ") || text.includes("\n")) return [];
    const q = text.slice(1).toLowerCase();
    return ws.commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 12);
  }, [text, ws.commands, palHidden]);

  // @-меншены файлов (E4): токен «@…» перед курсором (концом текста)
  const [repoFiles, setRepoFiles] = useState<string[]>([]);
  const [atIdx, setAtIdx] = useState(0);
  const atQuery = useMemo(() => {
    const m = /(?:^|\s)@([^\s@]*)$/.exec(text);
    return m ? m[1] : null;
  }, [text]);

  // список файлов подгружаем один раз при первом «@» в этом workspace
  useEffect(() => {
    if (atQuery == null || repoFiles.length > 0) return;
    void (async () => {
      const be = await getBackend();
      setRepoFiles(await be.invoke<string[]>("list_workspace_files", { cwd }).catch(() => []));
    })();
  }, [atQuery, repoFiles.length, cwd]);
  // смена workspace сбрасывает кэш файлов
  useEffect(() => setRepoFiles([]), [cwd]);

  const atItems = useMemo(() => {
    if (atQuery == null) return [] as string[];
    const q = atQuery.toLowerCase();
    const scored = repoFiles
      .filter((f) => f.toLowerCase().includes(q))
      // короче путь и совпадение в basename — выше
      .sort((a, b) => {
        const ab = a.split("/").pop()!.toLowerCase().startsWith(q) ? 0 : 1;
        const bb = b.split("/").pop()!.toLowerCase().startsWith(q) ? 0 : 1;
        return ab - bb || a.length - b.length;
      });
    return scored.slice(0, 10);
  }, [atQuery, repoFiles]);

  const applyMention = (path: string) => {
    // заменяем хвост «@token» на «@path » (pi прочитает файл по пути)
    setText((t) => t.replace(/(^|\s)@([^\s@]*)$/, `$1@${path} `));
    setAtIdx(0);
    taRef.current?.focus();
  };

  useEffect(() => setPalIdx(0), [paletteItems.length]);
  useEffect(() => setAtIdx(0), [atItems.length]);

  const submit = async (followUp = false) => {
    const t = text.trim();
    if (!t) return;
    const prompt = contextFiles.length > 0
      ? `${t}\n\n${contextFiles.map((path) => path.includes(" ") ? `"${path}"` : path).join("\n")}`
      : t;
    setText("");
    const imgs = attachments;
    setAttachments([]);
    const files = contextFiles;
    setContextFiles([]);
    try {
      if (followUp) await sendFollowUp(cwd, prompt);
      else await sendPrompt(cwd, prompt, imgs.length ? imgs : undefined);
    } catch (e) {
      // вернуть текст и attachments, показать причину (напр. агент занят другой сессией)
      setText(t);
      setAttachments(imgs);
      setContextFiles(files);
      notifyChat(cwd, "warning", e instanceof Error ? e.message : String(e));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (atItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAtIdx((i) => Math.min(i + 1, atItems.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAtIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        applyMention(atItems[atIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setRepoFiles([]); // прячем палитру, не стирая текст (пере-подтянется на новый @)
        return;
      }
    }
    if (paletteItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPalIdx((i) => Math.min(i + 1, paletteItems.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPalIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        setText(`/${paletteItems[palIdx].name} `);
        return;
      }
      if (e.key === "Escape") {
        setPalHidden(true);
        return;
      }
    }
    if (e.key === "ArrowUp" && !text && !streaming) {
      const last = [...ws.chat.items].reverse().find((item) => item.msg.role === "user" && !item.viaExtension);
      const previous = last ? contentText(last.msg.content) : "";
      if (previous) {
        e.preventDefault();
        setText(previous);
      }
      return;
    }
    if (e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey) && streaming) {
      e.preventDefault();
      void submit(false);
      return;
    }
    if (e.key === "Enter") {
      const mod = e.metaKey || e.ctrlKey;
      const shouldSend = sendKeyBehavior === "mod-enter" ? mod : !e.shiftKey && !mod;
      if (shouldSend) {
        e.preventDefault();
        void submit(streaming && e.altKey);
      }
    }
    if (e.key === "Escape" && streaming) {
      void abortAgent(cwd);
    }
  };

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result ?? "");
        const b64 = url.split(",")[1] ?? "";
        setAttachments((a) => [...a, { data: b64, mimeType: f.type, name: f.name }]);
      };
      reader.readAsDataURL(f);
    }
  };

  // прикрепление: изображения → base64 (для vision-моделей), остальное → путь в тексте (pi прочитает сам)
  const attachViaDialog = async () => {
    const be = await getBackend();
    if (be.isMock) {
      fileRef.current?.click();
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ multiple: true, title: "Прикрепить файлы" }).catch(() => null);
    const paths = Array.isArray(sel) ? sel : typeof sel === "string" ? [sel] : [];
    const imgExts = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
    const textParts: string[] = [];
    for (const p of paths) {
      const ext = p.split(".").pop()?.toLowerCase() ?? "";
      if (imgExts.has(ext) && canSendImages) {
        const f = await be.invoke<{ data: string; mimeType: string }>("read_file_base64", { path: p }).catch(() => null);
        if (f) setAttachments((a) => [...a, { ...f, name: p.split("/").pop() ?? p }]);
      } else {
        textParts.push(p);
      }
    }
    if (textParts.length) {
      setContextFiles((current) => [...new Set([...current, ...textParts])]);
      taRef.current?.focus();
    }
  };

  return (
    <div className="composer-wrap">
      <ExtensionUIDock cwd={cwd} ws={ws} />
      <GitBar cwd={cwd} ws={ws} />
      <WorkflowDock cwd={cwd} ws={ws} />
      {Object.entries(ws.chat.widgets).map(([k, v]) => (
        <div key={k} className="widgetbar">
          {stripAnsi(v)}
        </div>
      ))}
      {(ws.chat.queue.steering.length > 0 || ws.chat.queue.followUp.length > 0) && (
        <div className="queue" aria-label="Очередь сообщений агенту">
          {ws.chat.queue.steering.map((m, i) => (
            <div key={`s${i}`} className="q-item steer"><SteerIcon size={12} /> <span>Вмешательство</span><strong>{m.slice(0, 120)}</strong></div>
          ))}
          {ws.chat.queue.followUp.map((m, i) => (
            <div key={`f${i}`} className="q-item follow"><SendIcon size={12} /> <span>Следом</span><strong>{m.slice(0, 120)}</strong></div>
          ))}
        </div>
      )}
      <div className="composer" style={{ position: "relative" }}>
        {atItems.length > 0 && (
          <div className="palette">
            {atItems.map((f, i) => (
              <div
                key={f}
                className={`p-item ${i === atIdx ? "sel" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyMention(f);
                }}
              >
                <span className="p-name">@{f.split("/").pop()}</span>
                <span className="p-desc">{f}</span>
              </div>
            ))}
          </div>
        )}
        {paletteItems.length > 0 && (
          <div className="palette">
            {paletteItems.map((c, i) => (
              <div
                key={c.name}
                className={`p-item ${i === palIdx ? "sel" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setText(`/${c.name} `);
                  taRef.current?.focus();
                }}
              >
                <span className="p-name">/{c.name}</span>
                <span className="p-desc">{c.description ?? ""}</span>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          rows={1}
          placeholder={
            streaming
              ? `${sendKeyBehavior === "mod-enter" ? "⌘Enter" : "Enter"} — вмешаться (steer), ⌥ — после завершения, Esc — стоп`
              : `Сообщение для агента в ${cwd.split("/").pop()}… (/ — команды)`
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => addFiles(e.clipboardData.files)}
        />
        {attachments.length > 0 && (
          <div className="row" style={{ flexWrap: "wrap", marginTop: 4 }}>
            {attachments.map((a, i) => (
              <span key={i} className="chip attachment-chip image" style={{ background: "var(--accent-soft)" }}>
                <button className="attachment-open" title={`Открыть ${a.name}`} onClick={() => setPreviewAttachment(a)}><ImageIcon size={12} /> {a.name}</button>
                <small className="attachment-mode">vision</small>
                <button onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
            {contextFiles.map((path) => (
              <span key={path} className="chip attachment-chip">
                <PaperclipIcon size={11} /> <span title={path}>{path.split("/").pop()}</span><small className="attachment-mode">path</small>
                <button onClick={() => setContextFiles(contextFiles.filter((item) => item !== path))}>×</button>
              </span>
            ))}
          </div>
        )}
        {attachments.length === 0 && contextFiles.length > 0 && (
          <div className="row context-file-row">
            {contextFiles.map((path) => (
              <span key={path} className="chip attachment-chip"><PaperclipIcon size={11} /><span title={path}>{path.split("/").pop()}</span><small className="attachment-mode">path</small><button onClick={() => setContextFiles(contextFiles.filter((item) => item !== path))}>×</button></span>
            ))}
          </div>
        )}
        <div className="c-row">
          <ModelPicker cwd={cwd} ws={ws} />
          <ModeSelector cwd={cwd} ws={ws} />
          {/* до старта агента доступен: значение из дефолтов pi, выбор применится при спавне */}
          <PillSelect
            value={effectiveThinking(ws, piDefaults)}
            title="Уровень размышлений"
            options={THINKING_LEVELS.map((level) => ({ value: level, label: `thinking: ${level}` }))}
            onChange={(level) => void setThinkingLevel(cwd, level).catch(() => {})}
          />
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => addFiles(e.target.files)} />
          <button
            title={canSendImages ? "Прикрепить файлы или изображения" : "Прикрепить файлы (пути — модель text-only)"}
            onClick={() => void attachViaDialog()}
          >
            <PaperclipIcon size={14} />
          </button>
          <div className="grow" />
          {ws.chat.isCompacting && <span className="hint">Сжатие контекста…</span>}
          {ws.chat.retryInfo && <span className="hint" style={{ color: "var(--warn)" }}>{ws.chat.retryInfo}</span>}
          {streaming ? (
            <>
              <button
                className="steer-action"
                title={`Вмешаться в текущий ход (${sendKeyBehavior === "mod-enter" ? "⌘Enter" : "Enter"})`}
                disabled={!text.trim()}
                onClick={() => void submit(false)}
              >
                <SteerIcon size={14} motion="lift" /> Steer
              </button>
              <button
                title="Поставить сообщение после текущего хода (⌥Enter)"
                disabled={!text.trim()}
                onClick={() => void submit(true)}
              >
                Затем
              </button>
              <button className="danger" title="Остановить (Esc)" onClick={() => void abortAgent(cwd)}>
                <StopIcon size={15} />
              </button>
            </>
          ) : (
            <button className="primary" title={`Отправить (${sendKeyBehavior === "mod-enter" ? "⌘Enter" : "Enter"})`} disabled={!text.trim()} onClick={() => void submit()}>
              <SendIcon size={14} motion={text.trim() ? "lift" : undefined} />
            </button>
          )}
        </div>
      </div>
      {previewAttachment && (
        <div className="attachment-lightbox" role="dialog" aria-modal="true" aria-label={previewAttachment.name} onClick={() => setPreviewAttachment(null)}>
          <button className="attachment-lightbox-close" title="Закрыть" onClick={() => setPreviewAttachment(null)}>×</button>
          <img src={`data:${previewAttachment.mimeType};base64,${previewAttachment.data}`} alt={previewAttachment.name} onClick={(event) => event.stopPropagation()} />
          <span>{previewAttachment.name}</span>
        </div>
      )}
      <StatusLine ws={ws} cwd={cwd} />
    </div>
  );
}

// ---------- context window gauge (кольцевая диаграмма, как в Claude for Mac) ----------

function ContextRing({ pct, size = 15 }: { pct: number; size?: number }) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const color = clamped >= 95 ? "var(--danger)" : clamped >= 80 ? "var(--warn)" : "currentColor";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--bg-active)" strokeWidth="2.5" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${(c * clamped) / 100} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dasharray 0.4s ease" }}
      />
    </svg>
  );
}

function ContextGauge({ cwd, ws }: { cwd: string; ws: WorkspaceChat }) {
  const [open, setOpen] = useState(false);
  // popover позиционируем fixed по координатам чипа: строка статуса обрезает
  // overflow (иначе длинные статусы расширений вылезают на превью), поэтому
  // абсолютный popover внутри неё клипался. fixed не зависит от overflow предков.
  const chipRef = useRef<HTMLButtonElement>(null);
  const [popStyle, setPopStyle] = useState<React.CSSProperties>({});
  useLayoutEffect(() => {
    if (!open || !chipRef.current) return;
    const r = chipRef.current.getBoundingClientRect();
    setPopStyle({
      right: Math.max(8, Math.round(window.innerWidth - r.right)),
      bottom: Math.round(window.innerHeight - r.top + 8),
    });
  }, [open]);
  const stats = ws.stats;
  const usage = stats?.contextUsage;
  const alive = ws.alive;

  // держим статистику свежей, пока агент жив (окно видимо)
  useEffect(() => {
    if (!alive) return;
    const t = setInterval(() => {
      if (!document.hidden) void refreshStats(cwd);
    }, 10000);
    return () => clearInterval(t);
  }, [cwd, alive]);

  const window_ = usage?.contextWindow ?? ws.agentState?.model?.contextWindow;
  const tokens = usage?.tokens ?? null;
  const pct =
    usage?.percent ?? (tokens != null && window_ ? Math.round((tokens / window_) * 100) : null);
  if (!alive || pct == null) return null;

  const t = stats?.tokens;
  const autoCompact = ws.agentState?.autoCompactionEnabled;

  return (
    <div style={{ position: "relative", display: "flex" }}>
      <button
        ref={chipRef}
        className="ctx-chip"
        title={`Контекст: ${pct}%${tokens != null && window_ ? ` (${fmtNum(tokens)} из ${fmtNum(window_)})` : ""}`}
        onClick={() => setOpen(!open)}
      >
        <ContextRing pct={pct} />
        <span>{pct}%</span>
      </button>
      {open && (
        <div className="ctx-pop" style={popStyle} onMouseLeave={() => setOpen(false)}>
          <div className="cp-row cp-head">
            <ContextRing pct={pct} size={22} />
            <div>
              <div style={{ fontWeight: 600 }}>Контекстное окно: {pct}%</div>
              <div className="hint">
                {tokens != null && window_
                  ? `${tokens.toLocaleString("ru-RU")} из ${window_.toLocaleString("ru-RU")} токенов`
                  : "оценка появится после ответа модели"}
              </div>
            </div>
          </div>
          {t && (
            <div className="cp-row">
              <span className="hint">Токены сессии</span>
              <span className="grow" />
              <span>↑{fmtNum(t.input ?? 0)} ↓{fmtNum(t.output ?? 0)}</span>
            </div>
          )}
          {t && (t.cacheRead ?? 0) + (t.cacheWrite ?? 0) > 0 && (
            <div className="cp-row">
              <span className="hint">Кэш</span>
              <span className="grow" />
              <span>чтение {fmtNum(t.cacheRead ?? 0)} · запись {fmtNum(t.cacheWrite ?? 0)}</span>
            </div>
          )}
          {typeof stats?.cost === "number" && stats.cost > 0 && (
            <div className="cp-row">
              <span className="hint">Стоимость</span>
              <span className="grow" />
              <span>${stats.cost.toFixed(3)}</span>
            </div>
          )}
          {stats?.totalMessages != null && (
            <div className="cp-row">
              <span className="hint">Сообщений</span>
              <span className="grow" />
              <span>
                {stats.totalMessages}
                {stats.toolCalls != null ? ` · инструментов ${stats.toolCalls}` : ""}
              </span>
            </div>
          )}
          <div className="cp-row">
            <span className="hint">Авто-компакция</span>
            <span className="grow" />
            <button
              className="chip"
              title="Автоматически сжимать контекст при заполнении окна (pi core)"
              onClick={() => void setAutoCompaction(cwd, !(autoCompact ?? true)).catch(() => {})}
            >
              {(autoCompact ?? true) ? "вкл" : "выкл"}
            </button>
          </div>
          <div className="cp-row" style={{ marginTop: 4 }}>
            <button
              className="primary"
              style={{ flex: 1 }}
              disabled={ws.chat.isStreaming || ws.chat.isCompacting}
              onClick={() => {
                setOpen(false);
                void compactContext(cwd);
              }}
            >
              Сжать контекст сейчас
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusLine({ ws, cwd }: { ws: WorkspaceChat; cwd: string }) {
  const entries = Object.values(ws.chat.statusEntries);
  const stats = ws.stats;
  const tokens = stats?.tokens as { input?: number; output?: number } | undefined;
  const cost = typeof stats?.cost === "number" ? (stats.cost as number) : undefined;
  return (
    <div className="statusline">
      {ws.alive ? <span className="dot live" /> : <span className="dot idle" />}
      {/* спавн ленивый (R1-A): до первого сообщения это норма, а не сбой */}
      <span className="sl-fixed">{ws.alive ? "агент активен" : "агент запустится с первым сообщением"}</span>
      {tokens?.input != null && <span className="sl-fixed">↑{fmtNum(tokens.input)} ↓{fmtNum(tokens.output ?? 0)}</span>}
      {cost != null && cost > 0 && <span className="sl-fixed">${cost.toFixed(3)}</span>}
      {entries.map((e, i) => {
        const text = stripAnsi(e);
        return (
          <span key={i} className="sl-entry" title={text}>
            {text}
          </span>
        );
      })}
      <span className="grow" />
      <ContextGauge cwd={cwd} ws={ws} />
      {ws.alive && (
        <button className="hint sl-fixed" onClick={() => void compactContext(cwd)} title="Сжать контекст">
          compact
        </button>
      )}
    </div>
  );
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

// ---------- processing indicator ----------

export const MODEL_ACTIVITY_LABELS = [
  "размышляет",
  "анализирует запрос",
  "изучает контекст",
  "осматривается",
  "планирует шаги",
  "проверяет детали",
  "исследует варианты",
  "сопоставляет данные",
  "формулирует ответ",
] as const;

function ProcessingIndicator({ startedAt, model }: { startedAt: number | null; model?: ModelInfo }) {
  const [now, setNow] = useState(Date.now());
  const [activityIndex, setActivityIndex] = useState(() => Math.floor(Math.random() * MODEL_ACTIVITY_LABELS.length));
  const aliases = useStore((state) => state.appConfig.modelAliases ?? {});
  const modelKey = model ? modelAliasKey(model.provider, model.id) : null;
  const avatarConfig = useStore((state) => modelKey ? state.appConfig.modelAvatars?.[modelKey] : undefined);
  const hasWorkingAvatar = Boolean(avatarConfig?.workingKind && avatarConfig.workingValue);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setActivityIndex((current) => {
        if (MODEL_ACTIVITY_LABELS.length < 2) return current;
        const next = Math.floor(Math.random() * (MODEL_ACTIVITY_LABELS.length - 1));
        return next >= current ? next + 1 : next;
      });
    }, 3_400);
    return () => window.clearInterval(timer);
  }, []);
  const secs = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  const modelName = model ? modelDisplayName(model, aliases) : "Модель";
  return (
    <div className="processing">
      {modelKey && hasWorkingAvatar ? (
        <ModelAvatar modelKey={modelKey} size={22} working title={`${modelName} работает`} />
      ) : (
        <span className="pdots" aria-hidden="true"><i /><i /><i /></span>
      )}
      <span className="p-label">{modelName} {MODEL_ACTIVITY_LABELS[activityIndex]}{secs > 2 ? ` · ${secs} с` : "…"}</span>
    </div>
  );
}

function ChatListHeader() {
  return <div style={{ height: 18 }} />;
}
const CHAT_LIST_COMPONENTS = { Header: ChatListHeader };

// ---------- pinned messages widget (компактный, слева сверху — как в Claude for Mac) ----------

function PinnedWidget({
  cwd,
  ws,
  onJump,
}: {
  cwd: string;
  ws: WorkspaceChat;
  onJump: (pinId: string) => void;
}) {
  const sessionPath = ws.sessionPath;
  const pins = useStore((s) => (sessionPath ? s.sessionFlags.pinnedMessages[sessionPath] : undefined));
  const [open, setOpen] = useState(false);
  if (!sessionPath || !pins || pins.length === 0) return null;

  const unpin = (id: string) => {
    const target = pins.find((p) => p.id === id);
    if (!target) return;
    void toggleMessagePin(cwd, { role: target.role, content: [{ type: "text", text: target.text }] });
  };

  if (!open) {
    return (
      <button className="pins-mini" title={`Закреплённые сообщения: ${pins.length}`} onClick={() => setOpen(true)}>
        {pins.slice(0, 4).map((p) => (
          <span key={p.id} className="pins-line" style={{ width: 10 + Math.min(14, p.text.length / 20) }} />
        ))}
      </button>
    );
  }
  return (
    <div className="pins-panel">
      <div className="pins-head">
        <PinIcon size={12} />
        <span>Закреплено · {pins.length}</span>
        <span className="grow" />
        <button title="Свернуть" onClick={() => setOpen(false)}>
          <MinusIcon size={12} />
        </button>
      </div>
      {pins.map((p) => (
        <div key={p.id} className="pins-item" onClick={() => onJump(p.id)} title="Перейти к сообщению">
          <span className="pins-text">{p.text.slice(0, 140)}</span>
          <button
            title="Открепить"
            onClick={(e) => {
              e.stopPropagation();
              unpin(p.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------- message list ----------

function MessageList({ cwd, ws }: { cwd: string; ws: WorkspaceChat }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const virtRef = useRef<VirtuosoHandle>(null);
  const [pinned, setPinned] = useState(true);
  const transcriptMode = useStore((s) => s.appConfig.transcriptMode ?? "normal");

  const jumpToPin = (pinId: string) => {
    const index = ws.chat.items.findIndex((it) => msgPinId(it.msg) === pinId);
    if (index < 0) return;
    setPinned(false);
    virtRef.current?.scrollToIndex({ index, align: "center", behavior: "smooth" });
    setTimeout(() => {
      const el = rootRef.current?.querySelector(`[data-pin="${pinId}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
  };

  // ⌘F: поиск по сообщениям текущей сессии (E5-2)
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchPos, setMatchPos] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  /** Для какого query уже прыгали: первый Enter идёт к текущему матчу, не к следующему. */
  const jumpedFor = useRef("");

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!searchOpen || q.length < 2) return [] as number[];
    const out: number[] = [];
    ws.chat.items.forEach((it, i) => {
      if (contentText(it.msg.content).toLowerCase().includes(q)) out.push(i);
    });
    return out;
  }, [searchOpen, query, ws.chat.items]);

  const gotoMatch = (pos: number) => {
    if (matches.length === 0) return;
    const p = ((pos % matches.length) + matches.length) % matches.length;
    setMatchPos(p);
    const it = ws.chat.items[matches[p]];
    if (it) jumpToPin(msgPinId(it.msg));
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
    setMatchPos(0);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 40);
      } else if (e.key === "Escape" && searchOpen) {
        closeSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    const onNativeFind = () => {
      setSearchOpen(true);
      setTimeout(() => searchInputRef.current?.focus(), 40);
    };
    window.addEventListener("pi:find-session", onNativeFind);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pi:find-session", onNativeFind);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen]);

  // подсветка текущего совпадения (после jumpToPin и коммита расширенного окна)
  useEffect(() => {
    if (!searchOpen || matches.length === 0) return;
    const it = ws.chat.items[matches[matchPos]];
    if (!it) return;
    let el: HTMLElement | null = null;
    const t = setTimeout(() => {
      const found = rootRef.current?.querySelector(`[data-pin="${msgPinId(it.msg)}"]`);
      if (found instanceof HTMLElement) {
        el = found;
        el.classList.add("search-hit");
      }
    }, 120);
    return () => {
      clearTimeout(t);
      el?.classList.remove("search-hit");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen, matchPos, matches]);

  const empty = ws.chat.items.length === 0 && !ws.chat.streaming;
  const items = ws.chat.items;
  const displayItems = useMemo(() => (
    ws.chat.isStreaming || ws.chat.streaming || ws.chat.lastError
      ? [...items, { key: "__live__", live: true as const }]
      : items
  ), [items, ws.chat.isStreaming, ws.chat.streaming, ws.chat.lastError]);
  const userIndexes = useMemo(() => {
    let userCounter = 0;
    // Extension follow-ups are implementation details, not user-editable turns.
    // Excluding them keeps the UI index aligned with get_fork_messages and
    // prevents rewind from selecting the wrong duplicate prompt.
    return items.map((it) => (it.msg.role === "user" && !it.viaExtension ? userCounter++ : undefined));
  }, [items]);
  // Аватар модели — на первом сообщении каждой группы ответов (как в ChatGPT/
  // Claude): user-сообщение или смена модели начинает новую группу. Модель
  // берётся из msg.provider/msg.model — pi персистит их в файле сессии, так что
  // авторство переживает перезапуски и смену активной модели.
  const modelHeaderFlags = useMemo(() => {
    let prevKey: string | null = null;
    return items.map((it) => {
      if (it.msg.role !== "assistant") {
        if (it.msg.role === "user") prevKey = null;
        return false;
      }
      const key = `${String(it.msg.provider ?? "")}/${String(it.msg.model ?? "")}`;
      const show = key !== prevKey;
      prevKey = key;
      return show;
    });
  }, [items]);
  // Codex-style сворачивание ходов: раскладку считает чистая buildTranscript
  // (src/lib/transcript.ts) — её гоняют тесты на РЕАЛЬНОМ потоке событий pi.
  const toolExecs = ws.chat.toolExecs;
  const isStreaming = ws.chat.isStreaming;
  const aliases = useStore((s) => s.appConfig.modelAliases ?? {});
  const runPresentation = useMemo(
    () => buildTranscript(items, toolExecs, isStreaming, transcriptMode),
    [items, toolExecs, isStreaming, transcriptMode],
  );

  return (
    <div ref={rootRef} style={{ position: "relative", flex: 1, minHeight: 0, display: "flex" }}>
      {searchOpen && (
        <div className="chat-search">
          <input
            ref={searchInputRef}
            placeholder="Поиск по сессии…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setMatchPos(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (jumpedFor.current !== query) {
                  jumpedFor.current = query;
                  gotoMatch(matchPos);
                } else {
                  gotoMatch(e.shiftKey ? matchPos - 1 : matchPos + 1);
                }
              }
            }}
          />
          <span className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>
            {matches.length ? matchPos + 1 : 0}/{matches.length}
          </span>
          <button title="Предыдущее (⇧Enter)" onClick={() => gotoMatch(matchPos - 1)}>↑</button>
          <button title="Следующее (Enter)" onClick={() => gotoMatch(matchPos + 1)}>↓</button>
          <button title="Закрыть (Esc)" onClick={closeSearch}>✕</button>
        </div>
      )}
      <PinnedWidget cwd={cwd} ws={ws} onJump={jumpToPin} />
      {empty ? (
        <div className="msg-scroll" style={{ flex: 1 }}><StartScreen /></div>
      ) : (
        // Провайдер ВЫШЕ списка: раскрытые сводки/карточки переживают
        // размонтирование виртуальных элементов при скролле
        <ExpandedProvider>
        <Virtuoso
          ref={virtRef}
          className="msg-scroll"
          style={{ flex: 1 }}
          data={displayItems}
          computeItemKey={(_index, it) => it.key}
          initialTopMostItemIndex={Math.max(0, displayItems.length - 1)}
          followOutput={pinned ? "auto" : false}
          atBottomStateChange={setPinned}
          increaseViewportBy={{ top: 500, bottom: 700 }}
          itemContent={(index, it) => {
            if ("live" in it) {
              return (
                <div className="virtual-message virtual-footer">
                  {ws.chat.streaming && (
                    <MessageView
                      msg={ws.chat.streaming}
                      execs={ws.chat.toolExecs}
                      streaming
                      cwd={cwd}
                      transcriptMode={transcriptMode}
                      /* пока идёт ход, модель представляет «рабочий» аватар в индикаторе ниже */
                      showModelHeader={false}
                      liveTurn
                      fallbackModel={ws.agentState?.model}
                    />
                  )}
                  {/* Персистентный индикатор работы: держим его всё время стрима,
                      чтобы «модель думает» не мигало между сообщениями хода. */}
                  {ws.chat.isStreaming && (
                    <ProcessingIndicator startedAt={ws.chat.streamStartedAt} model={ws.agentState?.model} />
                  )}
                  {ws.chat.lastError && (
                    <div className="card" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
                      {ws.chat.lastError}
                    </div>
                  )}
                </div>
              );
            }
            const mode = runPresentation.renderMode.get(index) ?? "full";
            const summary = runPresentation.summaryAt.get(index);
            const filesRun = runPresentation.filesAt.get(index);
            return (
            <div className="virtual-message">
              {summary && (
                <>
                  {summary.modelId && (
                    <div className="msg-model">
                      <ModelAvatar
                        modelKey={summary.provider ? modelAliasKey(summary.provider, summary.modelId) : summary.modelId}
                        size={20}
                        title={`Автор ответа: ${summary.provider ? `${summary.provider}/${summary.modelId}` : summary.modelId}`}
                      />
                      <span>
                        {modelIdDisplayName(
                          summary.provider ? modelAliasKey(summary.provider, summary.modelId) : summary.modelId,
                          aliases,
                        )}
                      </span>
                    </div>
                  )}
                  {/* id сводки = ключ первого сообщения хода: состояние «раскрыто»
                      живёт в MessageList и переживает размонтирование виртуального
                      элемента при скролле */}
                  <RunActivitySummary
                    summaryId={it.key}
                    steps={summary.steps}
                    durationMs={summary.durationMs}
                    actionCount={summary.actionCount}
                    failedCount={summary.failedCount}
                    cwd={cwd}
                  />
                </>
              )}
              <MessageView
                msg={it.msg}
                execs={ws.chat.toolExecs}
                cwd={cwd}
                userIndex={userIndexes[index]}
                busy={ws.chat.isStreaming}
                viaExtension={it.viaExtension}
                transcriptMode={transcriptMode}
                showModelHeader={!summary && modelHeaderFlags[index] && !runPresentation.liveTurnIndexes.has(index)}
                liveTurn={runPresentation.liveTurnIndexes.has(index)}
                render={mode}
              />
              {filesRun && <RunFilesCard run={filesRun} cwd={cwd} />}
            </div>
          );}}
          components={CHAT_LIST_COMPONENTS}
        />
        </ExpandedProvider>
      )}
      {!pinned && (
        <button
          className="newmsg-pill"
          onClick={() => {
            virtRef.current?.scrollToIndex({ index: Math.max(0, displayItems.length - 1), align: "end", behavior: "smooth" });
            setPinned(true);
          }}
        >
          ↓ к последним
        </button>
      )}
    </div>
  );
}

// ---------- chat view ----------

export default function ChatView() {
  const cwd = useStore((s) => s.currentCwd);
  const ws = useWorkspace(cwd);
  const chats = useStore((s) => s.chats);
  const previewOpen = useStore((s) => s.previewOpen);
  const set = useStore((s) => s.set);
  const uiScale = useStore((s) => s.appConfig.uiScale || 1);
  const [previewWidth, setPreviewWidth] = useState(560);
  const backgroundTasks = useMemo(
    () => Object.entries(chats).flatMap(([taskCwd, workspace]) =>
      workspace.chat.backgroundTasks.map((task) => ({ cwd: taskCwd, task }))),
    [chats],
  );
  const nativePreview = ws.chat.previewRuntime;
  useEffect(() => {
    if (!nativePreview || !["starting", "running", "ready"].includes(nativePreview.status)) return;
    set({ previewOpen: true });
  }, [nativePreview?.updatedAt, nativePreview?.status, set]);

  // drag-resize границы сплита чат/превью (физические координаты → делим на uiScale)
  const onSplitResize = (e: React.MouseEvent) => {
    e.preventDefault();
    // предел считаем по ширине области чата (не окна!), чтобы всегда оставить
    // панели чата ≥360px — иначе при открытом сайдбаре она схлопывается в кашу
    const body = (e.currentTarget as HTMLElement).parentElement;
    const avail = body?.clientWidth ?? window.innerWidth;
    const maxPreview = Math.max(320, avail - 360 - 6);
    const startX = e.clientX;
    const startW = previewWidth;
    const move = (ev: MouseEvent) => {
      const next = Math.round(Math.min(maxPreview, Math.max(320, startW - (ev.clientX - startX) / uiScale)));
      setPreviewWidth(next);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // Агент НЕ спавнится при простом открытии workspace (pi-процесс с расширениями —
  // сотни МБ): ленивый спавн происходит в sendPrompt/ensureAgent по первому сообщению.

  // drag&drop файлов из Finder → composer выбирает image block или path chip
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const be = await getBackend();
      if (be.isMock) return;
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const un = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "drop") {
            const paths = event.payload.paths ?? [];
            if (paths.length > 0) {
              useStore.getState().set({ pendingFiles: paths, view: "chat" });
            }
          }
        });
        if (cancelled) un();
        else unlisten = un;
      } catch {
        /* drag&drop недоступен — не критично */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  if (!cwd) {
    return (
      <div className="empty" style={{ flex: 1 }}>
        <div className="e-icon">π</div>
        <div>Откройте папку проекта в сайдбаре, чтобы начать.</div>
      </div>
    );
  }

  const sessionName = ws.agentState?.sessionName ?? (ws.sessionPath ? "Сессия" : "Новая сессия");
  const browsing = isBrowsingAway(ws);
  return (
    <div className="chat">
      <div className="topbar" data-tauri-drag-region>
        <span className="title">{cwd.split("/").pop()}</span>
        <span className="sub">{String(sessionName)}</span>
        <div className="spacer" data-tauri-drag-region />
        <BackgroundTasksTopbar currentCwd={cwd} tasks={backgroundTasks} />
        <TranscriptModeSelector />
        <button
          className={`chip ${previewOpen ? "active" : ""}`}
          onClick={() => set({ previewOpen: !previewOpen })}
          title="Live-превью рядом с чатом (сплит-скрин)"
        >
          <PreviewIcon size={13} /> Превью{nativePreview?.ready ? " · ready" : nativePreview?.status === "starting" || nativePreview?.status === "running" ? " · starting" : nativePreview?.status === "failed" ? " · failed" : ""}
        </button>
        <button className="chip" onClick={() => void newSession(cwd)} title="Новая сессия">
          <PlusIcon size={13} /> Новая сессия
        </button>
      </div>
      {browsing && (
        <div className="browse-banner">
          <span className="spinner" />
          <span>
            Просмотр другой сессии{ws.liveStreaming ? " — агент работает в фоне" : " — фоновая сессия простаивает"}
          </span>
          <div className="grow" />
          <button className="chip" onClick={() => void returnToLiveSession(cwd)}>
            Вернуться к активной
          </button>
        </div>
      )}
      <div className="chat-body">
        <div className="chat-pane">
          <MessageList cwd={cwd} ws={ws} />
          <Composer cwd={cwd} ws={ws} />
          <Toasts cwd={cwd} />
        </div>
        {previewOpen && (
          <>
            <div className="chat-vresize" onMouseDown={onSplitResize} title="Потяните, чтобы изменить ширину превью" />
            <div className="preview-col" style={{ width: previewWidth }}>
              <PreviewPane onClose={() => set({ previewOpen: false })} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
