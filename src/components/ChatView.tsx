import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getBackend } from "../lib/backend";
import { messageDialog } from "../lib/dialog";
import { stripAnsi } from "../lib/markdown";
import { contentText } from "../lib/reducer";
import type { ExtUiRequest, GitSummary, ModelInfo } from "../lib/types";
import {
  abortAgent,
  compactContext,
  isBrowsingAway,
  loadModelsAndCommands,
  msgPinId,
  newSession,
  notifyChat,
  refreshStats,
  respondToUiRequest,
  returnToLiveSession,
  sendFollowUp,
  sendPrompt,
  setAgentMode,
  setAutoCompaction,
  setModel,
  setThinkingLevel,
  toggleMessagePin,
  useStore,
  emptyWorkspaceChat,
  type AgentMode,
  type WorkspaceChat,
} from "../state/store";
import { MessageView, Toasts } from "./MessageView";
import StartScreen from "./StartScreen";
import PreviewPane from "./PreviewView";
import { ImageIcon, MinusIcon, ModelIcon, PaperclipIcon, PinIcon, PlusIcon, PreviewIcon, SendIcon, ShieldIcon, StopIcon } from "./icons";

// ---------- agent mode selector ----------

const MODES: { id: AgentMode; label: string; desc: string }[] = [
  { id: "ask", label: "Ask permissions", desc: "Правки и команды — с подтверждением" },
  { id: "accept-edits", label: "Accept edits", desc: "Правки файлов без вопросов, команды — с подтверждением" },
  { id: "plan", label: "Plan mode", desc: "Только исследование и план, без изменений (plannotator)" },
  { id: "auto", label: "Auto mode", desc: "Всё разрешено, опасные команды — с подтверждением" },
  { id: "bypass", label: "Bypass permissions", desc: "Без ограничений (yolo) — на свой риск" },
];

function ModeSelector({ cwd, ws }: { cwd: string; ws: WorkspaceChat }) {
  const [open, setOpen] = useState(false);
  const current = MODES.find((m) => m.id === ws.mode) ?? MODES[0];
  const planActive = Object.values(ws.chat.statusEntries).some((s) => stripAnsi(s).includes("plan"));

  return (
    <div style={{ position: "relative" }}>
      <button
        className="chip"
        title={current.desc}
        disabled={ws.chat.isStreaming}
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
                  void setAgentMode(cwd, m.id).catch(() => {});
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
  const current = ws.agentState?.model;

  const filtered = useMemo(() => {
    const list = ws.models;
    const query = q.toLowerCase();
    return query ? list.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(query)) : list;
  }, [ws.models, q]);

  const pick = async (m: ModelInfo) => {
    setOpen(false);
    await setModel(cwd, m.provider, m.id).catch(() => {});
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
        <ModelIcon size={12} /> {current ? shortModel(current.id) : "модель"}
      </button>
      {open && (
        <div className="dropdown" onMouseLeave={() => setOpen(false)}>
          <input autoFocus placeholder="Поиск модели…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="dd-list">
            {filtered.length === 0 && <div className="dd-item">{ws.alive ? "Нет моделей" : "Агент не запущен"}</div>}
            {filtered.map((m) => (
              <div
                key={`${m.provider}/${m.id}`}
                className={`dd-item ${current?.id === m.id ? "sel" : ""}`}
                onClick={() => void pick(m)}
              >
                <div>
                  <div>{m.id}</div>
                  <div className="dd-sub">
                    {m.provider}
                    {m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k ctx` : ""}
                    {m.reasoning ? " · reasoning" : ""}
                  </div>
                </div>
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

interface Attachment {
  data: string;
  mimeType: string;
  name: string;
}

function Composer({ cwd, ws }: { cwd: string; ws: WorkspaceChat }) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [palIdx, setPalIdx] = useState(0);
  // Esc скрывает палитру команд, НЕ стирая ввод; следующее изменение текста показывает снова
  const [palHidden, setPalHidden] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const streaming = ws.chat.isStreaming;
  const pendingInsert = useStore((s) => s.pendingInsert);

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

  // extension prefill (set_editor_text)
  useEffect(() => {
    if (ws.chat.editorPrefill != null) {
      setText(ws.chat.editorPrefill);
      const s = useStore.getState();
      const w = s.chats[cwd];
      if (w) s.set({ chats: { ...s.chats, [cwd]: { ...w, chat: { ...w.chat, editorPrefill: null } } } });
    }
  }, [ws.chat.editorPrefill, cwd]);

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

  useEffect(() => setPalIdx(0), [paletteItems.length]);

  const canSendImages = ws.agentState?.model?.input?.includes("image") ?? true;

  const submit = async (followUp = false) => {
    const t = text.trim();
    if (!t) return;
    setText("");
    const imgs = attachments;
    setAttachments([]);
    try {
      if (followUp) await sendFollowUp(cwd, t);
      else await sendPrompt(cwd, t, imgs.length ? imgs : undefined);
    } catch (e) {
      // вернуть текст и attachments, показать причину (напр. агент занят другой сессией)
      setText(t);
      setAttachments(imgs);
      notifyChat(cwd, "warning", e instanceof Error ? e.message : String(e));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit(e.altKey);
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
        textParts.push(p.includes(" ") ? `"${p}"` : p);
      }
    }
    if (textParts.length) {
      setText((t) => (t ? `${t} ${textParts.join(" ")}` : textParts.join(" ")));
      taRef.current?.focus();
    }
  };

  return (
    <div className="composer-wrap">
      <ExtensionUIDock cwd={cwd} ws={ws} />
      <GitBar cwd={cwd} ws={ws} />
      {Object.entries(ws.chat.widgets).map(([k, v]) => (
        <div key={k} className="widgetbar">
          {stripAnsi(v)}
        </div>
      ))}
      {(ws.chat.queue.steering.length > 0 || ws.chat.queue.followUp.length > 0) && (
        <div className="queue">
          {ws.chat.queue.steering.map((m, i) => (
            <div key={`s${i}`} className="q-item">steer » {m.slice(0, 120)}</div>
          ))}
          {ws.chat.queue.followUp.map((m, i) => (
            <div key={`f${i}`} className="q-item">затем ↳ {m.slice(0, 120)}</div>
          ))}
        </div>
      )}
      <div className="composer" style={{ position: "relative" }}>
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
              ? "Enter — вмешаться (steer), ⌥Enter — после завершения, Esc — стоп"
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
              <span key={i} className="chip" style={{ background: "var(--accent-soft)" }}>
                <ImageIcon size={12} /> {a.name}
                <button onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
          </div>
        )}
        <div className="c-row">
          <ModelPicker cwd={cwd} ws={ws} />
          <ModeSelector cwd={cwd} ws={ws} />
          <select
            className="chip"
            style={{ border: "none", background: "none", padding: "3px 4px" }}
            value={ws.agentState?.thinkingLevel ?? "high"}
            disabled={!ws.alive}
            onChange={(e) => void setThinkingLevel(cwd, e.target.value).catch(() => {})}
            title="Уровень размышлений"
          >
            {THINKING_LEVELS.map((l) => (
              <option key={l} value={l}>
                thinking: {l}
              </option>
            ))}
          </select>
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
            <button className="danger" title="Остановить (Esc)" onClick={() => void abortAgent(cwd)}>
              <StopIcon size={15} />
            </button>
          ) : (
            <button className="primary" title="Отправить (Enter)" disabled={!text.trim()} onClick={() => void submit()}>
              <SendIcon size={14} />
            </button>
          )}
        </div>
      </div>
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

function ProcessingIndicator({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  return (
    <div className="processing">
      <span className="pdots">
        <i />
        <i />
        <i />
      </span>
      <span className="p-label">pi работает{secs > 2 ? ` · ${secs} с` : "…"}</span>
    </div>
  );
}

/** Есть ли у стримящегося сообщения видимый контент (текст/thinking/tool call). */
function hasLiveContent(ws: WorkspaceChat): boolean {
  const s = ws.chat.streaming;
  if (!s) return false;
  if (contentText(s.content).trim()) return true;
  if (Array.isArray(s.content)) {
    return s.content.some(
      (b) =>
        (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) ||
        b.type === "toolCall",
    );
  }
  return false;
}

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

/** Окно рендера: длинные сессии не раздувают DOM (данные остаются в store). */
const RENDER_WINDOW = 80;

function MessageList({ cwd, ws }: { cwd: string; ws: WorkspaceChat }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  // сколько сообщений держим в DOM: инкрементально расширяем по «показать
  // предыдущие», а не рендерим сразу тысячи (подсветка кода раздувает память).
  const [renderLimit, setRenderLimit] = useState(RENDER_WINDOW);

  useEffect(() => {
    if (pinned && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [ws.chat.seq, pinned]);

  // при смене сессии окно рендера сбрасывается
  useEffect(() => setRenderLimit(RENDER_WINDOW), [cwd, ws.sessionPath]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const jumpToPin = (pinId: string) => {
    setRenderLimit(ws.chat.items.length); // раскрыть всё, чтобы долистать до пина
    setPinned(false);
    // после расширения окна нужен коммит React — ждём кадр с запасом
    setTimeout(() => {
      const el = ref.current?.querySelector(`[data-pin="${pinId}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
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
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen]);

  // подсветка текущего совпадения (после jumpToPin и коммита расширенного окна)
  useEffect(() => {
    if (!searchOpen || matches.length === 0) return;
    const it = ws.chat.items[matches[matchPos]];
    if (!it) return;
    let el: HTMLElement | null = null;
    const t = setTimeout(() => {
      const found = ref.current?.querySelector(`[data-pin="${msgPinId(it.msg)}"]`);
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
  const visible = items.length <= renderLimit ? items : items.slice(items.length - renderLimit);
  const hiddenCount = items.length - visible.length;
  // rewind/fork оперируют номером среди ВСЕХ пользовательских сообщений ветки
  let userCounter = items.slice(0, hiddenCount).filter((it) => it.msg.role === "user").length;

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex" }}>
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
      <div className="msg-scroll" ref={ref} onScroll={onScroll} style={{ flex: 1 }}>
        {empty ? (
          <StartScreen />
        ) : (
          <div className="msg-col">
            {hiddenCount > 0 && (
              <button className="show-earlier" onClick={() => setRenderLimit((l) => l + 200)}>
                Показать предыдущие сообщения ({hiddenCount})
              </button>
            )}
            {visible.map((it) => (
              <MessageView
                key={it.key}
                msg={it.msg}
                execs={ws.chat.toolExecs}
                cwd={cwd}
                userIndex={it.msg.role === "user" ? userCounter++ : undefined}
                busy={ws.chat.isStreaming}
                viaExtension={it.viaExtension}
              />
            ))}
            {ws.chat.streaming && (
              <MessageView msg={ws.chat.streaming} execs={ws.chat.toolExecs} streaming cwd={cwd} />
            )}
            {ws.chat.isStreaming && !hasLiveContent(ws) && (
              <ProcessingIndicator startedAt={ws.chat.streamStartedAt} />
            )}
            {ws.chat.lastError && (
              <div className="card" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
                {ws.chat.lastError}
              </div>
            )}
          </div>
        )}
      </div>
      {!pinned && (
        <button
          className="newmsg-pill"
          onClick={() => {
            if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
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
  const previewOpen = useStore((s) => s.previewOpen);
  const set = useStore((s) => s.set);
  const uiScale = useStore((s) => s.appConfig.uiScale || 1);
  const [previewWidth, setPreviewWidth] = useState(560);

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

  // drag&drop файлов из Finder → пути вставляются в composer
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
              useStore.getState().set({
                pendingInsert: paths.map((p) => (p.includes(" ") ? `"${p}"` : p)).join(" "),
                view: "chat",
              });
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
        <button
          className={`chip ${previewOpen ? "active" : ""}`}
          onClick={() => set({ previewOpen: !previewOpen })}
          title="Live-превью рядом с чатом (сплит-скрин)"
        >
          <PreviewIcon size={13} /> Превью
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
