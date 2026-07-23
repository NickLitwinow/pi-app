import { useCallback, useEffect, useRef, useState } from "react";
import { getBackend } from "../lib/backend";
import { messageDialog } from "../lib/dialog";
import type { LaunchConfig, PreviewHandle, PreviewStatus } from "../lib/types";
import { openExternalUrl, setSessionPreviewRuntime, useStore } from "../state/store";
import { useInstalledPackages, useRunPi } from "./Marketplace";
import { ExternalIcon, MinusIcon, MobileIcon, PreviewIcon, RefreshIcon, StopIcon, TabletIcon } from "./icons";

type Device = "desktop" | "tablet" | "mobile";

const DEVICE_WIDTH: Record<Device, string> = {
  desktop: "100%",
  tablet: "834px",
  mobile: "400px",
};

// Браузерные расширения pi, дающие агенту нативный контроль над превью
// (навигация, чтение DOM/консоли, скриншоты) — как в Claude Preview.
const BROWSER_EXTENSIONS = [
  {
    pkg: "pi-agent-browser-native",
    name: "pi-agent-browser-native",
    desc: "Нативный инструмент агента поверх agent-browser: навигация, чтение DOM/консоли, скриншоты, автоматизация.",
  },
  {
    pkg: "pi-chrome",
    name: "pi-chrome",
    desc: "Использовать уже авторизованный профиль Chrome — агент управляет реальным браузером.",
  },
];

/** Live-превью dev-сервера как сплит-панель рядом с чатом (в стиле Claude Preview). */
export default function PreviewPane({ onClose }: { onClose: () => void }) {
  const cwd = useStore((s) => s.currentCwd);
  const harnessPreview = useStore((s) => cwd ? s.chats[cwd]?.chat.previewRuntime ?? null : null);
  const [configs, setConfigs] = useState<LaunchConfig[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [url, setUrl] = useState("");
  const [address, setAddress] = useState("");
  const [server, setServer] = useState<PreviewHandle | null>(null);
  const [starting, setStarting] = useState(false);
  const [ready, setReady] = useState(false);
  const [device, setDevice] = useState<Device>("desktop");
  const [iframeKey, setIframeKey] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // зеркалим serverId в ref, чтобы гасить процесс из cleanup/при смене проекта
  const serverRef = useRef<string | null>(null);

  const killServer = useCallback(async (id: string) => {
    const be = await getBackend();
    await be.invoke("preview_stop", { serverId: id }).catch(() => {});
  }, []);
  const applyServer = useCallback((h: PreviewHandle | null) => {
    serverRef.current = h?.serverId ?? null;
    setServer(h);
  }, []);

  const { installed, reload: reloadInstalled } = useInstalledPackages();
  const { runPi, running: installing, log: installLog, logRef: installLogRef } = useRunPi(() => reloadInstalled());
  const hasBrowserExt = BROWSER_EXTENSIONS.some((e) => installed.has(e.pkg));

  // Конфигурации dev-сервера из .claude/launch.json проекта. Switching the
  // visible workspace detaches this pane but does not kill another session's
  // leased QA server; each workspace is managed independently by the backend.
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    applyServer(null);
    setReady(false);
    setUrl("");
    setLogs([]);
    void (async () => {
      const be = await getBackend();
      const cfgs = await be.invoke<LaunchConfig[]>("preview_configs", { cwd }).catch(() => []);
      if (cancelled) return;
      setConfigs(cfgs);
      if (cfgs[0]) {
        setSelected(cfgs[0].name);
        setAddress(`http://localhost:${cfgs[0].port}`);
      } else {
        setSelected("");
        setAddress("");
      }
      const active = await be.invoke<PreviewStatus | null>("preview_status", { cwd, serverId: null }).catch(() => null);
      if (cancelled) return;
      if (active?.running) {
        applyServer({ serverId: active.serverId, url: active.url, port: active.port });
        setUrl(active.url);
        setAddress(active.url);
        setReady(active.ready);
        setLogs(active.logs ?? []);
      }
    })();
    return () => { cancelled = true; };
  }, [cwd, applyServer]);

  // поток логов dev-сервера
  useEffect(() => {
    let un: (() => void) | undefined;
    void (async () => {
      const be = await getBackend();
      un = await be.listen("preview-output", (p) => {
        const activeId = serverRef.current;
        if (!activeId || p.serverId !== activeId) return;
        if (p.done) {
          setLogs((l) => [...l, `— сервер остановлен (код ${String(p.code ?? "?")})`]);
          if (serverRef.current === p.serverId) {
            applyServer(null);
            setReady(false);
            if (cwd) {
              const prior = useStore.getState().chats[cwd]?.chat.previewRuntime;
              if (prior && prior.serverId === p.serverId) {
                setSessionPreviewRuntime(cwd, { ...prior, source: prior.source ?? "agent", status: "stopped", running: false, ready: false, updatedAt: Date.now() });
              }
            }
          }
        } else if (p.line) {
          setLogs((l) => [...l.slice(-300), String(p.line)]);
        }
      });
    })();
    return () => un?.();
  }, [applyServer, cwd]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  // Closing the split only hides the view. The explicit Stop button and the
  // native idle reaper own process lifetime, so an agent's active QA run is not
  // interrupted just because the user temporarily closes the pane.

  const start = useCallback(async () => {
    if (!cwd) return;
    if (serverRef.current) await killServer(serverRef.current); // не плодим процессы
    setStarting(true);
    setLogs([]);
    setShowLogs(true);
    try {
      const be = await getBackend();
      const handle = await be.invoke<PreviewHandle>("preview_start", { cwd, name: selected || null });
      applyServer(handle);
      setReady(false);
      setUrl(handle.url);
      setAddress(handle.url);
      // перезагружаем iframe по фактической готовности порта, а не по таймеру:
      // dev-серверы поднимаются от сотен мс до десятков секунд
      void (async () => {
        for (let i = 0; i < 60; i++) {
          if (serverRef.current !== handle.serverId) return; // сервер сменили/остановили
          const code = await be.invoke<string>("probe_url", { url: handle.url }).catch(() => null);
          if (code) {
            setReady(true);
            setIframeKey((k) => k + 1);
            return;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      })();
    } catch (e) {
      void messageDialog(String(e), { kind: "error" });
    } finally {
      setStarting(false);
    }
  }, [cwd, selected, killServer, applyServer]);

  const stop = useCallback(async () => {
    if (!cwd || !serverRef.current) return;
    const stoppedId = serverRef.current;
    await killServer(stoppedId);
    applyServer(null);
    setReady(false);
    const prior = useStore.getState().chats[cwd]?.chat.previewRuntime;
    if (prior && prior.serverId === stoppedId) {
      setSessionPreviewRuntime(cwd, { ...prior, source: prior.source ?? "agent", status: "stopped", running: false, ready: false, updatedAt: Date.now() });
    }
  }, [cwd, killServer, applyServer]);

  useEffect(() => {
    if (harnessPreview?.status === "failed") {
      setReady(false);
      setShowLogs(true);
      if (harnessPreview.error) setLogs((current) => [...current.slice(-319), `— ${harnessPreview.error}`]);
      return;
    }
    if (!harnessPreview?.serverId || !harnessPreview.url || harnessPreview.running === false) return;
    if (serverRef.current !== harnessPreview.serverId) {
      applyServer({ serverId: harnessPreview.serverId, url: harnessPreview.url, port: harnessPreview.port ?? 0 });
      setUrl(harnessPreview.url);
      setAddress(harnessPreview.url);
    }
    setReady(harnessPreview.ready === true);
    if (harnessPreview.logs?.length) setLogs(harnessPreview.logs);
  }, [harnessPreview, applyServer]);

  const touchServer = useCallback(() => {
    const id = serverRef.current;
    if (!id) return;
    void getBackend().then((be) => be.invoke("preview_touch", { serverId: id })).catch(() => {});
  }, []);

  // События внутри cross-origin iframe не всплывают в React-дерево. Пока
  // iframe в фокусе, отправляем редкий heartbeat, иначе активный просмотр мог
  // бы ошибочно считаться бездействием.
  useEffect(() => {
    if (!server) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && document.activeElement === iframeRef.current) {
        touchServer();
      }
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [server, touchServer]);

  const reload = () => setIframeKey((k) => k + 1);
  const go = () => {
    setUrl(address);
    setIframeKey((k) => k + 1);
  };

  const sendToAgent = () => {
    if (!cwd || !url) return;
    const prompt = `Открой это превью через браузерные инструменты pi и продолжай разработку UI, сверяясь с реальным рендером: перейди на ${url}, осмотри DOM и консоль, при необходимости сделай скриншот. Адрес обслуживается локальным dev-сервером этого проекта.`;
    useStore.getState().set({ pendingInsert: prompt });
  };

  return (
    <div className="preview-pane" onPointerDown={touchServer} onKeyDown={touchServer}>
      <div className="pv-header">
        <PreviewIcon size={14} />
        <span className="pv-title">Превью</span>
        {cwd && <span className="pv-sub">{cwd.split("/").pop()}</span>}
        {server && <span className={`pv-runtime ${ready ? "ready" : "starting"}`}>{ready ? "ready" : "starting"}</span>}
        {!server && harnessPreview?.status === "failed" && <span className="pv-runtime failed">failed</span>}
        {harnessPreview?.browserInspected && <span className="pv-runtime inspected">agent checked</span>}
        <div className="grow" />
        <button title="Закрыть превью" onClick={onClose}>
          <MinusIcon size={14} />
        </button>
      </div>

      <div className="pv-toolbar">
        {configs.length > 0 && (
          <select value={selected} onChange={(e) => setSelected(e.target.value)} disabled={Boolean(server)} title="Конфигурация из .claude/launch.json">
            {configs.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} :{c.port}
              </option>
            ))}
          </select>
        )}
        {server ? (
          <button className="danger" onClick={() => void stop()} title="Остановить dev-сервер">
            <StopIcon size={13} /> Стоп
          </button>
        ) : (
          <button className="primary" disabled={starting || configs.length === 0} onClick={() => void start()} title="Запустить dev-сервер">
            {starting ? "запуск…" : "▶ Запустить"}
          </button>
        )}

        <input
          className="pv-address"
          value={address}
          placeholder="http://localhost:3000"
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
        />
        <button onClick={reload} title="Перезагрузить">
          <RefreshIcon size={13} />
        </button>

        <div className="pv-devices">
          <button className={device === "desktop" ? "active" : ""} onClick={() => setDevice("desktop")} title="Десктоп">
            <PreviewIcon size={13} />
          </button>
          <button className={device === "tablet" ? "active" : ""} onClick={() => setDevice("tablet")} title="Планшет">
            <TabletIcon size={13} />
          </button>
          <button className={device === "mobile" ? "active" : ""} onClick={() => setDevice("mobile")} title="Телефон">
            <MobileIcon size={13} />
          </button>
        </div>

        <div className="grow" />
        <button onClick={sendToAgent} title="Вставить адрес превью в чат для агента">
          Агенту →
        </button>
        <button onClick={() => url && void openExternalUrl(url)} title="Открыть в системном браузере">
          <ExternalIcon size={13} />
        </button>
        <button className={showLogs ? "active" : ""} onClick={() => setShowLogs(!showLogs)} title="Логи dev-сервера">
          Логи
        </button>
      </div>

      {!hasBrowserExt && (
        <div className="pv-extbar">
          <PreviewIcon size={14} />
          <span>Чтобы агент сам осматривал DOM/консоль и делал скриншоты — установите нативное браузерное расширение:</span>
          {BROWSER_EXTENSIONS.map((e) => (
            <button key={e.pkg} className="chip" disabled={installing} title={e.desc} onClick={() => void runPi(["install", `npm:${e.pkg}`])}>
              + {e.name}
            </button>
          ))}
        </div>
      )}

      <div className="pv-stage">
        {url ? (
          <iframe
            ref={iframeRef}
            key={iframeKey}
            className="pv-frame"
            src={url}
            title="preview"
            style={{ width: DEVICE_WIDTH[device], maxWidth: "100%" }}
            onPointerEnter={touchServer}
            onLoad={touchServer}
          />
        ) : (
          <div className="empty" style={{ height: "100%" }}>
            <div className="e-icon">
              <PreviewIcon size={40} />
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>Live-превью интерфейса</div>
            <div>
              {configs.length > 0
                ? "Нажмите «Запустить» — dev-сервер поднимется из .claude/launch.json."
                : "Укажите адрес dev-сервера выше или создайте .claude/launch.json в проекте."}
            </div>
          </div>
        )}
      </div>

      {showLogs && (
        <div className="pv-logs" ref={logRef}>
          {[...logs, ...(installLog.length ? ["", "— установка расширения —", ...installLog] : [])].join("\n") || "нет вывода"}
          <div ref={installLogRef} />
        </div>
      )}
    </div>
  );
}
