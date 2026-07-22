import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { getBackend } from "./lib/backend";
import { confirmDialog } from "./lib/dialog";
import { useT } from "./lib/i18n";
import { notifyOS } from "./lib/notify";
import { stripAnsi } from "./lib/markdown";
import type { AppUpdateInfo } from "./lib/types";
import { applyAppearanceConfig, resolveAppIconStyle } from "./lib/theme";
import { contentText } from "./lib/reducer";
import { splitTrailingTurnTiming } from "./lib/turn-timing";
import { closeCurrentSession, initApp, newSession, selectWorkspace, updateAppConfig, useStore } from "./state/store";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import { SidebarIcon } from "./components/icons";

const ReviewView = lazy(() => import("./components/ReviewView"));
const SettingsView = lazy(() => import("./components/SettingsView"));
const LibraryView = lazy(() => import("./components/LibraryView"));

function toggleSidebar() {
  const s = useStore.getState();
  void updateAppConfig({ sidebarCollapsed: !(s.appConfig.sidebarCollapsed ?? false) });
}

export default function App() {
  const ready = useStore((s) => s.ready);
  const view = useStore((s) => s.view);
  const theme = useStore((s) => s.appConfig.theme);
  const uiScale = useStore((s) => s.appConfig.uiScale);
  const accentColor = useStore((s) => s.appConfig.accentColor ?? "#8b5cf6");
  const iconColor = useStore((s) => s.appConfig.iconColor ?? s.appConfig.accentColor ?? "#8b5cf6");
  const appIconStyle = useStore((s) => s.appConfig.appIconStyle ?? "auto");
  const appearancePreset = useStore((s) => s.appConfig.appearancePreset ?? "chatgpt");
  const visualEffects = useStore((s) => s.appConfig.visualEffects !== false);
  const interfaceDensity = useStore((s) => s.appConfig.interfaceDensity ?? "comfortable");
  const customTheme = useStore((s) => s.appConfig.customTheme ?? null);
  const sidebarCollapsed = useStore((s) => s.appConfig.sidebarCollapsed ?? false);
  const sidebarWidth = useStore((s) => s.appConfig.sidebarWidth ?? 240);
  const automaticUpdates = useStore((s) => s.appConfig.automaticUpdates !== false);
  const sourceRepoPath = useStore((s) => s.appConfig.sourceRepoPath ?? null);
  // читшит хоткеев (⌘/); ref — чтобы keydown-эффект с пустыми deps видел актуальное
  const [hkOpen, setHkOpen] = useState(false);
  const hkOpenRef = useRef(false);
  hkOpenRef.current = hkOpen;
  // ⌘K командная палитра
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const cmdkOpenRef = useRef(false);
  cmdkOpenRef.current = cmdkOpen;
  const actionRef = useRef<(action: string) => void>(() => {});

  actionRef.current = (action: string) => {
    const s = useStore.getState();
    const cwd = s.currentCwd;
    if (action === "command-palette") return setCmdkOpen((value) => !value);
    if (action === "hotkeys") return setHkOpen((value) => !value);
    if (action === "toggle-sidebar") return toggleSidebar();
    if (action === "focus-composer") {
      s.set({ view: "chat" });
      window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(), 60);
      return;
    }
    if (action === "copy-last-answer") {
      const items = cwd ? s.chats[cwd]?.chat.items ?? [] : [];
      const last = [...items].reverse().find((item) => item.msg.role === "assistant");
      // без ANSI и служебной строки «✻ Turn took…» — копируем то, что видит пользователь
      const answer = last ? splitTrailingTurnTiming(stripAnsi(contentText(last.msg.content))).body : "";
      if (answer) void navigator.clipboard.writeText(answer);
      return;
    }
    if (action === "new-session" && cwd) {
      s.set({ view: "chat" });
      void newSession(cwd);
      return;
    }
    if (action === "close-session" && cwd) {
      void closeCurrentSession(cwd);
      return;
    }
    if (action === "find-session") {
      s.set({ view: "chat" });
      window.setTimeout(() => window.dispatchEvent(new CustomEvent("pi:find-session")), 60);
      return;
    }
    if (action === "code-review") return s.set({ view: "review" });
    if (action === "toggle-preview") return s.set({ view: "chat", previewOpen: !s.previewOpen });
    if (action === "settings") return s.set({ view: "settings" });
    const workspaceMatch = action.match(/^workspace-(\d)$/);
    if (workspaceMatch) {
      const hidden = new Set(s.sessionFlags.hiddenProjects);
      const ordered = [...s.extraWorkspaces, ...s.projects].filter(
        (workspace, index, all) => !hidden.has(workspace.cwd)
          && all.findIndex((candidate) => candidate.cwd === workspace.cwd) === index,
      );
      const workspace = ordered[Number(workspaceMatch[1]) - 1];
      if (workspace) selectWorkspace(workspace.cwd);
    }
  };

  useEffect(() => {
    void initApp();
  }, []);

  useEffect(() => {
    if (!ready) return;
    void getBackend().then((be) => {
      if (!be.isMock) return be.invoke("perf_ready");
    });
  }, [ready]);

  // Native quit is paused by the Rust supervisor while background work is
  // active. Obtain one explicit decision in the web UI, then use the
  // programmatic exit path so the process group is terminated deliberately.
  useEffect(() => {
    if (!ready) return;
    let unsubscribe: (() => void) | undefined;
    let deciding = false;
    void getBackend().then(async (be) => {
      if (be.isMock) return;
      unsubscribe = await be.listen("background-exit-requested", (payload) => {
        if (deciding) return;
        deciding = true;
        const reported = Number(payload.taskCount ?? 0);
        const active = Object.values(useStore.getState().chats)
          .flatMap((workspace) => workspace.chat.backgroundTasks)
          .filter((task) => task.status === "queued" || task.status === "running");
        const count = Math.max(reported, active.length);
        const names = active.slice(0, 5).map((task) => `• ${task.description}`).join("\n");
        void confirmDialog(
          `${count} ${count === 1 ? "фоновая задача ещё выполняется" : "фоновых задач ещё выполняются"}. При выходе процессы будут остановлены.${names ? `\n\n${names}` : ""}\n\nВыйти и остановить задачи?`,
          { title: "Background tasks are running", kind: "warning", okLabel: "Выйти и остановить", cancelLabel: "Оставить работать" },
        ).then((confirmed) => {
          if (confirmed) return be.invoke("confirm_app_exit");
        }).finally(() => { deciding = false; });
      });
    });
    return () => unsubscribe?.();
  }, [ready]);

  // Готовый GitHub Release скачивается и устанавливается поверх текущего .app
  // в фоне. Работающая копия не прерывается; новый бандл запустится при
  // следующем обычном перезапуске приложения.
  useEffect(() => {
    if (!ready || !automaticUpdates) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      void (async () => {
        const be = await getBackend();
        if (be.isMock || cancelled) return;
        const info = await be.invoke<AppUpdateInfo>("check_app_update", { sourceRepo: sourceRepoPath }).catch(() => null);
        if (cancelled || !info?.updateAvailable || !info.assetUrl) return;
        const key = `pi-app-auto-update:${info.latest ?? info.assetUrl}`;
        if (sessionStorage.getItem(key)) return;
        sessionStorage.setItem(key, "installing");
        let runId: string | null = null;
        const buffered: Record<string, unknown>[] = [];
        const handle = (payload: Record<string, unknown>) => {
          if (runId == null) {
            buffered.push(payload);
            return;
          }
          if (payload.runId !== runId || !payload.done) return;
          if (payload.code === 0) {
            sessionStorage.setItem(key, "installed");
            void notifyOS("Pi App обновлён", "Новая версия установлена в фоне и запустится после перезапуска.");
          } else {
            sessionStorage.removeItem(key);
          }
          unsubscribe?.();
        };
        unsubscribe = await be.listen("app-update-output", handle);
        try {
          runId = await be.invoke<string>("app_update_install_release", { assetUrl: info.assetUrl });
          for (const payload of buffered.splice(0)) handle(payload);
        } catch {
          sessionStorage.removeItem(key);
          unsubscribe?.();
        }
      })();
    }, 8_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      unsubscribe?.();
    };
  }, [ready, automaticUpdates, sourceRepoPath]);

  useEffect(() => {
    const el = document.documentElement;
    if (theme === "dark" || theme === "light") el.setAttribute("data-theme", theme);
    else el.removeAttribute("data-theme");
  }, [theme]);

  useEffect(() => {
    const el = document.documentElement;
    el.dataset.preset = appearancePreset;
    el.dataset.effects = visualEffects ? "on" : "off";
    el.dataset.density = interfaceDensity;
    applyAppearanceConfig({ ...useStore.getState().appConfig, appearancePreset, accentColor, iconColor, appIconStyle, customTheme });
  }, [accentColor, iconColor, appIconStyle, appearancePreset, visualEffects, interfaceDensity, customTheme]);

  useEffect(() => {
    if (!ready) return;
    const style = resolveAppIconStyle({ appIconStyle, appearancePreset });
    void getBackend().then((be) => be.invoke("set_app_icon", { style })).catch(() => {});
  }, [ready, appIconStyle, appearancePreset]);

  useEffect(() => {
    if (!visualEffects || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const selector = [
      ".card", ".settings-group", ".customization-panel", ".appearance-preview",
      ".ss-card", ".composer", ".difffile", ".app-modal", ".theme-preset",
      ".mk-card", ".update-section", ".chat-msg", ".sidebar .navitem",
      ".sidebar .ws", ".sidebar .sess-row", ".profile-card", ".library-onboarding", ".gitbar",
      ".toolcard", ".agent-avatar", ".advanced-editor", ".commit-box", "button",
    ].join(",");
    let active: HTMLElement | null = null;
    let frame = 0;
    let next: { element: HTMLElement; x: number; y: number } | null = null;
    const paint = () => {
      frame = 0;
      if (!next) return;
      if (active !== next.element) {
        active?.classList.remove("pointer-glow");
        active = next.element;
        active.classList.add("pointer-glow");
      }
      const rect = next.element.getBoundingClientRect();
      next.element.style.setProperty("--pointer-x", `${next.x - rect.left}px`);
      next.element.style.setProperty("--pointer-y", `${next.y - rect.top}px`);
    };
    const onMove = (event: PointerEvent) => {
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null;
      if (!element) {
        active?.classList.remove("pointer-glow");
        active = null;
        next = null;
        return;
      }
      next = { element, x: event.clientX, y: event.clientY };
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const clear = () => {
      active?.classList.remove("pointer-glow");
      active = null;
      next = null;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("blur", clear);
    document.addEventListener("pointerleave", clear);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("blur", clear);
      document.removeEventListener("pointerleave", clear);
      if (frame) cancelAnimationFrame(frame);
      clear();
    };
  }, [visualEffects]);

  // Масштаб интерфейса (⌘+ / ⌘− / ⌘0). CSS zoom в WKWebView глючит с layout,
  // поэтому масштабируем корень через transform + компенсацию размеров.
  // --ui-scale позволяет контр-масштабировать физические константы (например,
  // зону системных traffic lights, которые transform не трогает).
  useEffect(() => {
    const root = document.getElementById("root");
    if (!root) return;
    const s = uiScale || 1;
    document.documentElement.style.setProperty("--ui-scale", String(s));
    if (Math.abs(s - 1) < 0.01) {
      root.style.transform = "";
      root.style.transformOrigin = "";
      root.style.width = "";
      root.style.height = "";
    } else {
      root.style.transform = `scale(${s})`;
      root.style.transformOrigin = "0 0";
      root.style.width = `${100 / s}%`;
      root.style.height = `${100 / s}%`;
    }
  }, [uiScale]);

  // ширина сайдбара (drag-resize пишет live в ту же переменную)
  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-w", `${sidebarWidth}px`);
  }, [sidebarWidth]);

  // Нативное меню и web-view используют одну таблицу действий.
  useEffect(() => {
    let un: (() => void) | undefined;
    void getBackend().then(async (be) => {
      if (be.isMock) return;
      un = await be.listen("menu-action", (payload) => {
        if (typeof payload.action === "string") actionRef.current(payload.action);
      });
    });
    return () => un?.();
  }, []);

  // Надёжный drag окна за шапку: свой обработчик поверх data-tauri-drag-region
  // (штатный инжект в WKWebView срабатывает не всегда). Двойной клик — maximize.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let win: { startDragging(): Promise<void>; toggleMaximize(): Promise<void> } | null = null;
    void import("@tauri-apps/api/window").then((m) => (win = m.getCurrentWindow()));

    const isDragTarget = (t: EventTarget | null): boolean =>
      t instanceof HTMLElement && t.hasAttribute("data-tauri-drag-region");

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || !isDragTarget(e.target)) return;
      if (e.detail === 2) void win?.toggleMaximize();
      else void win?.startDragging();
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && hkOpenRef.current) {
        setHkOpen(false);
        return;
      }
      if (e.key === "Escape" && cmdkOpenRef.current) {
        setCmdkOpen(false);
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      const s = useStore.getState();

      if (e.key === "k") {
        e.preventDefault();
        actionRef.current("command-palette");
        return;
      }
      if (e.key.toLowerCase() === "c" && e.shiftKey) {
        const cwd = s.currentCwd;
        const items = cwd ? s.chats[cwd]?.chat.items ?? [] : [];
        const last = [...items].reverse().find((item) => item.msg.role === "assistant");
        const answer = last ? contentText(last.msg.content) : "";
        if (answer) {
          e.preventDefault();
          actionRef.current("copy-last-answer");
        }
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        actionRef.current("hotkeys");
        return;
      }
      if (e.key === "l") {
        e.preventDefault();
        actionRef.current("focus-composer");
        return;
      }

      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        void updateAppConfig({ uiScale: Math.min(1.6, Math.round(((s.appConfig.uiScale || 1) + 0.1) * 10) / 10) });
        return;
      }
      if (e.key === "-") {
        e.preventDefault();
        void updateAppConfig({ uiScale: Math.max(0.7, Math.round(((s.appConfig.uiScale || 1) - 0.1) * 10) / 10) });
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        void updateAppConfig({ uiScale: 1 });
        return;
      }
      if (e.key === "b") {
        e.preventDefault();
        actionRef.current("toggle-sidebar");
        return;
      }
      if ((e.key.toLowerCase() === "t" || e.key.toLowerCase() === "n") && s.currentCwd) {
        e.preventDefault();
        actionRef.current("new-session");
        return;
      }
      if (e.key.toLowerCase() === "w" && s.currentCwd) {
        e.preventDefault();
        actionRef.current("close-session");
        return;
      }
      if (e.key === ",") {
        e.preventDefault();
        actionRef.current("settings");
        return;
      }
      if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        actionRef.current("code-review");
        return;
      }
      if (e.key.toLowerCase() === "e") {
        e.preventDefault();
        actionRef.current("toggle-preview");
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        actionRef.current(`workspace-${e.key}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!ready) {
    return (
      <div className="empty" style={{ height: "100%" }}>
        <div className="spinner" style={{ width: 20, height: 20 }} />
        <div>Запуск…</div>
      </div>
    );
  }

  return (
    <div className={`app ${sidebarCollapsed ? "no-sidebar" : ""}`}>
      {!sidebarCollapsed && <Sidebar />}
      {sidebarCollapsed && (
        <button className="sidebar-expand" title="Показать боковую панель (⌘B)" onClick={toggleSidebar}>
          <SidebarIcon size={15} />
        </button>
      )}
      <div className="main">
        <Suspense fallback={<div className="empty">Загрузка…</div>}>
          {view === "chat" && <ChatView />}
          {view === "review" && <ReviewView />}
          {view === "library" && <LibraryView />}
          {view === "settings" && <SettingsView />}
        </Suspense>
      </div>
      {hkOpen && <HotkeysOverlay onClose={() => setHkOpen(false)} />}
      {cmdkOpen && <CommandPalette onClose={() => setCmdkOpen(false)} />}
    </div>
  );
}

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  const t = useT();
  const projects = useStore((s) => s.projects);
  const extra = useStore((s) => s.extraWorkspaces);
  const hiddenProjects = useStore((s) => s.sessionFlags.hiddenProjects);
  const currentCwd = useStore((s) => s.currentCwd);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 30);
  }, []);

  const cmds = useMemo<Cmd[]>(() => {
    const s = useStore.getState();
    const go = (patch: Parameters<typeof s.set>[0]) => {
      s.set(patch);
      onClose();
    };
    const list: Cmd[] = [
      { id: "chat", label: t("Перейти: Чат"), run: () => go({ view: "chat" }) },
      { id: "review", label: t("Перейти: Code Review"), hint: "⌘R", run: () => go({ view: "review" }) },
      { id: "library", label: t("Перейти: Library"), run: () => go({ view: "library" }) },
      { id: "settings", label: t("Перейти: Настройки"), hint: "⌘,", run: () => go({ view: "settings" }) },
      { id: "preview", label: t("Переключить live-превью (сплит)"), hint: "⌘E", run: () => go({ view: "chat", previewOpen: !s.previewOpen }) },
      { id: "sidebar", label: t("Переключить боковую панель"), hint: "⌘B", run: () => { toggleSidebar(); onClose(); } },
      {
        id: "newsession",
        label: t("Новая сессия"),
        hint: "⌘T",
        run: () => { if (currentCwd) void newSession(currentCwd); onClose(); },
      },
      {
        id: "closesession",
        label: t("Закрыть текущую сессию"),
        hint: "⌘W",
        run: () => { if (currentCwd) void closeCurrentSession(currentCwd); onClose(); },
      },
    ];
    const seen = new Set<string>();
    const hidden = new Set(hiddenProjects);
    for (const p of [...extra, ...projects]) {
      if (hidden.has(p.cwd)) continue;
      if (seen.has(p.cwd)) continue;
      seen.add(p.cwd);
      const number = seen.size;
      list.push({
        id: `ws:${p.cwd}`,
        label: `${t("Проект")}: ${p.name}`,
        hint: number <= 9 ? `⌘${number}${p.cwd === currentCwd ? ` · ${t("текущий")}` : ""}` : p.cwd === currentCwd ? t("текущий") : undefined,
        run: () => { selectWorkspace(p.cwd); onClose(); },
      });
    }
    return list;
  }, [projects, extra, hiddenProjects, currentCwd, onClose, t]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return cmds;
    return cmds.filter((c) => c.label.toLowerCase().includes(query));
  }, [q, cmds]);

  useEffect(() => setIdx(0), [q]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); filtered[idx]?.run(); }
  };

  return (
    <div className="hk-overlay" onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder={t("Команда или проект…")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="cmdk-list">
          {filtered.length === 0 && <div className="muted" style={{ padding: "10px 12px" }}>{t("Ничего не найдено")}</div>}
          {filtered.map((c, i) => (
            <div
              key={c.id}
              className={`cmdk-item ${i === idx ? "sel" : ""}`}
              onMouseEnter={() => setIdx(i)}
              onMouseDown={(e) => { e.preventDefault(); c.run(); }}
            >
              <span>{c.label}</span>
              {c.hint && <span className="muted" style={{ fontSize: "var(--text-xs)" }}>{c.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const HOTKEYS: Array<[string, string]> = [
  ["⌘K", "Командная палитра (навигация, проекты)"],
  ["⌘F", "Поиск по сессии"],
  ["⌘1 … ⌘9", "Переключить workspace по номеру"],
  ["⌘R", "Открыть Code Review"],
  ["⌘E", "Live-превью рядом с чатом (сплит)"],
  ["⌘B", "Свернуть/показать сайдбар"],
  ["⌘T", "Новая сессия в текущем проекте"],
  ["⌘W", "Закрыть сессию без удаления истории"],
  ["⇧⌘C", "Скопировать последний ответ агента"],
  ["⌘L", "Фокус в поле сообщения"],
  ["⌘,", "Настройки"],
  ["⌘+ / ⌘− / ⌘0", "Масштаб интерфейса"],
  ["Enter / ⌘Enter", "Отправка настраивается; вторая комбинация — перенос"],
  ["⇧⌘Enter", "Steer во время текущего хода"],
  ["/", "Палитра команд в композере (Esc — закрыть, текст сохранится)"],
  ["⌘/", "Эта справка"],
];

function HotkeysOverlay({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <div className="hk-overlay" onClick={onClose}>
      <div className="hk-panel" onClick={(e) => e.stopPropagation()}>
        <div className="c-title" style={{ marginBottom: 10 }}>{t("Горячие клавиши")}</div>
        {HOTKEYS.map(([keys, desc]) => (
          <div key={keys} className="hk-row">
            <span className="hk-keys">{keys}</span>
            <span className="hk-desc">{t(desc)}</span>
          </div>
        ))}
        <div className="muted" style={{ marginTop: 10, fontSize: 11 }}>{t("Esc или клик мимо — закрыть")}</div>
      </div>
    </div>
  );
}
