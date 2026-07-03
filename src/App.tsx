import { useEffect } from "react";
import { getBackend } from "./lib/backend";
import { initApp, newSession, updateAppConfig, useStore } from "./state/store";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import ReviewView from "./components/ReviewView";
import SettingsView from "./components/SettingsView";
import AnalyticsView from "./components/AnalyticsView";
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
      if (!(e.metaKey || e.ctrlKey)) return;
      const s = useStore.getState();

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
      const views = { "1": "chat", "2": "review", "3": "analytics", "4": "settings" } as const;
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
        {view === "analytics" && <AnalyticsView />}
        {view === "settings" && <SettingsView />}
      </div>
    </div>
  );
}
