import { useCallback, useEffect, useRef, useState } from "react";
import { getBackend } from "../lib/backend";
import { messageDialog } from "../lib/dialog";
import type { AppUpdateInfo } from "../lib/types";
import { openExternalUrl, updateAppConfig, useStore } from "../state/store";
import { CheckIcon, ExternalIcon, FolderIcon, RefreshIcon } from "./icons";

export default function UpdateModal({ onClose }: { onClose: () => void }) {
  const configuredRepo = useStore((s) => s.appConfig.sourceRepoPath ?? null);
  const [info, setInfo] = useState<AppUpdateInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [ok, setOk] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  const repoPath = info?.sourceRepo ?? configuredRepo ?? null;

  const check = useCallback(async () => {
    setChecking(true);
    const be = await getBackend();
    const res = await be
      .invoke<AppUpdateInfo>("check_app_update", { sourceRepo: configuredRepo })
      .catch(() => null);
    setInfo(res);
    setChecking(false);
  }, [configuredRepo]);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const pickRepo = async () => {
    const be = await getBackend();
    if (be.isMock) {
      await updateAppConfig({ sourceRepoPath: "/Users/dev/pi-app" });
      void check();
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, multiple: false, title: "Каталог исходников pi-app" }).catch(() => null);
    if (typeof dir === "string" && dir) {
      await updateAppConfig({ sourceRepoPath: dir });
      void check();
    }
  };

  const runUpdate = async () => {
    if (!repoPath) {
      await messageDialog("Не задан каталог исходников pi-app — укажите его, чтобы пересобрать приложение.", { kind: "warning" });
      return;
    }
    setRunning(true);
    setDone(false);
    setLog([]);
    const be = await getBackend();
    let un: (() => void) | null = null;
    try {
      let runId: string | null = null;
      const buffered: Record<string, unknown>[] = [];
      let finish: () => void = () => {};
      const donePromise = new Promise<void>((resolve) => (finish = resolve));
      const handle = (p: Record<string, unknown>) => {
        if (runId == null) {
          buffered.push(p);
          return;
        }
        if (p.runId !== runId) return;
        if (p.done) {
          setOk(p.code === 0);
          setDone(true);
          finish();
        } else if (p.line) {
          setLog((l) => [...l.slice(-500), String(p.line)]);
        }
      };
      un = await be.listen("app-update-output", handle);
      runId = await be.invoke<string>("app_update_run", { sourceRepo: repoPath });
      for (const p of buffered.splice(0)) handle(p);
      await donePromise;
    } catch (e) {
      setLog((l) => [...l, `ошибка: ${String(e)}`]);
      setDone(true);
      setOk(false);
    } finally {
      un?.();
      setRunning(false);
    }
  };

  const relaunch = async () => {
    const be = await getBackend();
    await be.invoke("relaunch_app").catch(() => {});
  };

  const available = info?.updateAvailable ?? false;

  return (
    <div className="app-modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="app-modal">
        <div className="am-head">
          <span className="am-title">Обновление Pi</span>
          <div className="grow" />
          {!running && (
            <button className="hint" onClick={onClose}>
              ✕
            </button>
          )}
        </div>

        <div className="am-body">
          {checking ? (
            <div className="row" style={{ gap: 8 }}>
              <span className="spinner" /> Проверка обновлений…
            </div>
          ) : !info ? (
            <div className="muted">Не удалось проверить обновления.</div>
          ) : (
            <>
              <div className="am-row">
                <span className="hint">Текущая версия</span>
                <span className="grow" />
                <span style={{ fontFamily: "var(--font-mono)" }}>
                  {info.currentVersion} · {info.currentSha}
                </span>
              </div>
              <div className="am-row">
                <span className="hint">Последняя</span>
                <span className="grow" />
                {info.checked ? (
                  <span style={{ fontFamily: "var(--font-mono)" }}>
                    {info.latest ?? "—"} {info.latestKind === "release" ? "(релиз)" : info.latestKind === "commit" ? "(коммит)" : ""}
                  </span>
                ) : (
                  <span className="hint" style={{ color: "var(--warn)" }}>{info.error ?? "GitHub недоступен"}</span>
                )}
              </div>

              {info.checked && (
                <div className="am-status" style={{ color: available ? "var(--warn)" : "var(--ok)" }}>
                  {available ? "● Доступно обновление" : "✓ Установлена последняя версия"}
                </div>
              )}

              {info.notes && (
                <div className="am-notes">{info.notes}</div>
              )}

              {info.htmlUrl && (
                <button className="hint am-link" onClick={() => void openExternalUrl(info.htmlUrl)}>
                  <ExternalIcon size={12} /> Открыть репозиторий на GitHub
                </button>
              )}

              <div className="am-repo">
                <span className="hint">Исходники для сборки</span>
                <div className="row" style={{ marginTop: 4 }}>
                  <span
                    style={{ fontFamily: "var(--font-mono)", fontSize: 11, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={repoPath ?? ""}
                  >
                    {repoPath ?? "не задан"}
                  </span>
                  <button onClick={() => void pickRepo()}>
                    <FolderIcon size={13} /> Изменить
                  </button>
                </div>
                {repoPath && info.sourceRepoValid === false && (
                  <div className="hint" style={{ color: "var(--danger)", marginTop: 4 }}>
                    Это не похоже на репозиторий pi-app — ребилд недоступен.
                  </div>
                )}
              </div>

              {log.length > 0 && (
                <div className="console" ref={logRef} style={{ marginTop: 12, maxHeight: 220 }}>
                  {log.join("\n")}
                </div>
              )}
            </>
          )}
        </div>

        <div className="am-actions">
          <button disabled={checking || running} onClick={() => void check()}>
            <RefreshIcon size={13} /> Проверить снова
          </button>
          <div className="grow" />
          {done && ok ? (
            <button className="primary" onClick={() => void relaunch()}>
              Перезапустить Pi
            </button>
          ) : (
            <button
              className="primary"
              disabled={running || checking || !info?.sourceRepoValid}
              title={!info?.sourceRepoValid ? "Укажите каталог исходников pi-app" : "git pull → npm install → tauri build → замена приложения"}
              onClick={() => void runUpdate()}
            >
              {running ? (
                <>
                  <span className="spinner" /> Обновление…
                </>
              ) : (
                <>
                  <CheckIcon size={13} /> {available ? "Обновить и пересобрать" : "Пересобрать из исходников"}
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
