import { useEffect, useRef, useState } from "react";
import { getBackend } from "./lib/backend";
import { initApp, newSession, updateAppConfig, useStore } from "./state/store";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import ReviewView from "./components/ReviewView";
import SettingsView from "./components/SettingsView";
import { SidebarIcon } from "./components/icons";

function toggleSidebar() {
  const s = useStore.getState();
  void updateAppConfig({ sidebarCollapsed: !(s.appConfig.sidebarCollapsed ?? false) });
}

export default function App() {
  const ready = useStore((s) => s.ready);
  const view = useStore((s) => s.view);
  const theme = useStore((s) => s.appConfig.theme);
  const uiScale = useStore((s) => s.appConfig.uiScale);
  const sidebarCollapsed = useStore((s) => s.appConfig.sidebarCollapsed ?? false);
  const sidebarWidth = useStore((s) => s.appConfig.sidebarWidth ?? 240);
  // читшит хоткеев (⌘/); ref — чтобы keydown-эффект с пустыми deps видел актуальное
  const [hkOpen, setHkOpen] = useState(false);
  const hkOpenRef = useRef(false);
  hkOpenRef.current = hkOpen;

  useEffect(() => {
    void initApp();
  }, []);

  useEffect(() => {
    const el = document.documentElement;
    if (theme === "dark" || theme === "light") el.setAttribute("data-theme", theme);
    else el.removeAttribute("data-theme");
  }, [theme]);

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

  // системное меню: View → Toggle Sidebar (эмитится из Rust)
  useEffect(() => {
    let un: (() => void) | undefined;
    void getBackend().then(async (be) => {
      if (be.isMock) return;
      un = await be.listen("menu-toggle-sidebar", () => toggleSidebar());
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
      if (!(e.metaKey || e.ctrlKey)) return;
      const s = useStore.getState();

      if (e.key === "/") {
        e.preventDefault();
        setHkOpen((v) => !v);
        return;
      }
      if (e.key === "l") {
        e.preventDefault();
        s.set({ view: "chat" });
        // после переключения вью композер должен смонтироваться
        setTimeout(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(), 60);
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
        toggleSidebar();
        return;
      }
      if (e.key === "n" && s.currentCwd) {
        e.preventDefault();
        s.set({ view: "chat" });
        void newSession(s.currentCwd);
        return;
      }
      if (e.key === ",") {
        e.preventDefault();
        s.set({ view: "settings" });
        return;
      }
      if (e.key === "3") {
        // ⌘3 — переключить сплит-скрин live-превью рядом с чатом
        e.preventDefault();
        s.set({ view: "chat", previewOpen: !s.previewOpen });
        return;
      }
      const views = { "1": "chat", "2": "review", "4": "settings" } as const;
      const v = views[e.key as keyof typeof views];
      if (v) {
        e.preventDefault();
        s.set({ view: v });
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
        {view === "chat" && <ChatView />}
        {view === "review" && <ReviewView />}
        {view === "settings" && <SettingsView />}
      </div>
      {hkOpen && <HotkeysOverlay onClose={() => setHkOpen(false)} />}
    </div>
  );
}

const HOTKEYS: Array<[string, string]> = [
  ["⌘1 / ⌘2 / ⌘4", "Чат / Code Review / Настройки"],
  ["⌘3", "Live-превью рядом с чатом (сплит)"],
  ["⌘B", "Свернуть/показать сайдбар"],
  ["⌘N", "Новая сессия в текущем проекте"],
  ["⌘L", "Фокус в поле сообщения"],
  ["⌘,", "Настройки"],
  ["⌘+ / ⌘− / ⌘0", "Масштаб интерфейса"],
  ["Enter / ⇧Enter", "Отправить / перенос строки"],
  ["/", "Палитра команд в композере (Esc — закрыть, текст сохранится)"],
  ["⌘/", "Эта справка"],
];

function HotkeysOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="hk-overlay" onClick={onClose}>
      <div className="hk-panel" onClick={(e) => e.stopPropagation()}>
        <div className="c-title" style={{ marginBottom: 10 }}>Горячие клавиши</div>
        {HOTKEYS.map(([keys, desc]) => (
          <div key={keys} className="hk-row">
            <span className="hk-keys">{keys}</span>
            <span className="hk-desc">{desc}</span>
          </div>
        ))}
        <div className="muted" style={{ marginTop: 10, fontSize: 11 }}>Esc или клик мимо — закрыть</div>
      </div>
    </div>
  );
}
