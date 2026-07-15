import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getBackend } from "../lib/backend";
import { messageDialog } from "../lib/dialog";
import type { AppUpdateInfo, PiPackage, PiUpdateInfo } from "../lib/types";
import { openExternalUrl, updateAppConfig, useStore } from "../state/store";
import { CheckIcon, ExternalIcon, FolderIcon, PackageIcon, RefreshIcon } from "./icons";
import { useInstalledPackages, useRunPi } from "./Marketplace";

export default function UpdateModal({ onClose }: { onClose: () => void }) {
  const configuredRepo = useStore((s) => s.appConfig.sourceRepoPath ?? null);
  const automaticUpdates = useStore((s) => s.appConfig.automaticUpdates !== false);
  const [appInfo, setAppInfo] = useState<AppUpdateInfo | null>(null);
  const [piInfo, setPiInfo] = useState<PiUpdateInfo | null>(null);
  const [packageInfo, setPackageInfo] = useState<PiPackage[]>([]);
  const [checking, setChecking] = useState(true);
  const [appRunning, setAppRunning] = useState(false);
  const [appDone, setAppDone] = useState(false);
  const [appOk, setAppOk] = useState(false);
  const [appLog, setAppLog] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const { specs, reload: reloadInstalled } = useInstalledPackages();
  const specsKey = specs.join("\u0000");

  const check = useCallback(async () => {
    setChecking(true);
    const be = await getBackend();
    const [app, pi, packages] = await Promise.all([
      be.invoke<AppUpdateInfo>("check_app_update", { sourceRepo: configuredRepo }).catch(() => null),
      be.invoke<PiUpdateInfo>("check_pi_update").catch(() => null),
      specs.length > 0
        ? be.invoke<PiPackage[]>("pi_packages_meta", { names: specs }).catch(() => [])
        : Promise.resolve([] as PiPackage[]),
    ]);
    setAppInfo(app);
    setPiInfo(pi);
    setPackageInfo(packages);
    setChecking(false);
    // specsKey intentionally makes installed package changes retrigger the check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configuredRepo, specsKey]);

  const piRun = useRunPi(() => {
    reloadInstalled();
    void check();
  });

  useEffect(() => void check(), [check]);
  useEffect(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }), [appLog]);

  const repoPath = appInfo?.sourceRepo ?? configuredRepo ?? null;
  const packageUpdates = packageInfo.filter((item) => item.updateAvailable);

  // Пересборка начинается с `git pull --ff-only`: на незакоммиченных правках или
  // разошедшихся ветках она обречена. Раньше это выяснялось только из лога с
  // кодом 1 — теперь говорим до нажатия. Готовый DMG этим не блокируется: он
  // ставится мимо исходников.
  const sourceBlock = appInfo?.diverged
    ? "Локальная ветка разошлась с upstream — быстрый перемотка-pull невозможен. Слейте или сбросьте ветку вручную."
    : appInfo && appInfo.dirtyFiles.length > 0
      ? `Незакоммиченные правки в исходниках (${appInfo.dirtyFiles.slice(0, 3).join(", ")}${appInfo.dirtyFiles.length > 3 ? ` и ещё ${appInfo.dirtyFiles.length - 3}` : ""}). Закоммитьте или уберите их (git stash) — обновление их не тронет.`
      : null;
  const sourceUpdateBlocked = sourceBlock != null && !appInfo?.assetUrl;

  const pickRepo = async () => {
    const be = await getBackend();
    if (be.isMock) {
      await updateAppConfig({ sourceRepoPath: "/Users/dev/pi-app" });
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, multiple: false, title: "Каталог исходников pi-app" }).catch(() => null);
    if (typeof dir === "string" && dir) await updateAppConfig({ sourceRepoPath: dir });
  };

  const runAppCommand = async (command: "app_update_run" | "app_update_install_release", args: Record<string, unknown>) => {
    setAppRunning(true);
    setAppDone(false);
    setAppLog([]);
    const be = await getBackend();
    let un: (() => void) | null = null;
    try {
      let runId: string | null = null;
      const buffered: Record<string, unknown>[] = [];
      let finish: () => void = () => {};
      const donePromise = new Promise<void>((resolve) => (finish = resolve));
      const handle = (payload: Record<string, unknown>) => {
        if (runId == null) {
          buffered.push(payload);
          return;
        }
        if (payload.runId !== runId) return;
        if (payload.done) {
          setAppOk(payload.code === 0);
          setAppDone(true);
          finish();
        } else if (payload.line) {
          setAppLog((lines) => [...lines.slice(-500), String(payload.line)]);
        }
      };
      un = await be.listen("app-update-output", handle);
      runId = await be.invoke<string>(command, args);
      for (const payload of buffered.splice(0)) handle(payload);
      await donePromise;
    } catch (error) {
      setAppLog((lines) => [...lines, `ошибка: ${String(error)}`]);
      setAppDone(true);
      setAppOk(false);
    } finally {
      un?.();
      setAppRunning(false);
    }
  };

  const updateApp = async () => {
    if (appInfo?.assetUrl) {
      await runAppCommand("app_update_install_release", { assetUrl: appInfo.assetUrl });
      return;
    }
    if (!repoPath) {
      await messageDialog("Нет готового DMG и не задан каталог исходников pi-app.", { kind: "warning" });
      return;
    }
    await runAppCommand("app_update_run", { sourceRepo: repoPath });
  };

  const relaunch = async () => {
    const be = await getBackend();
    await be.invoke("relaunch_app").catch(() => {});
  };

  const modal = (
    <div className="app-modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && !appRunning && !piRun.running && onClose()}>
      <div className="app-modal update-center">
        <div className="am-head">
          <div>
            <div className="am-title">Центр обновлений</div>
            <div className="hint">Приложение, pi CLI и community-пакеты в одном месте</div>
          </div>
          <div className="grow" />
          <button className="iconbtn" disabled={appRunning || piRun.running} onClick={onClose} aria-label="Закрыть">✕</button>
        </div>

        <div className="am-body update-sections">
          <section className="update-section">
            <div className="update-section-head">
              <div className="update-section-icon">✦</div>
              <div className="update-section-copy">
                <strong>Pi App</strong>
                <span className="hint">
                  {checking && !appInfo ? "Проверка…" : appInfo ? `${appInfo.currentVersion} · ${appInfo.currentSha}` : "Статус недоступен"}
                </span>
              </div>
              {appInfo?.updateAvailable ? <span className="badge update">Доступно</span> : appInfo?.checked ? <span className="badge installed">Актуально</span> : null}
            </div>
            {appInfo && (
              <>
                <div className="update-detail-row">
                  <span className="hint">Последняя версия</span>
                  <span className="mono">{appInfo.latest ?? "—"}{appInfo.latestKind !== "none" ? ` · ${appInfo.latestKind === "release" ? "релиз" : "коммит"}` : ""}</span>
                </div>
                {appInfo.notes && <div className="am-notes">{appInfo.notes}</div>}
                {appInfo.updateAvailable && sourceBlock && <div className="am-notes update-warn">⚠ {sourceBlock}</div>}
                <div className="update-inline-actions">
                  {appInfo.htmlUrl && <button className="hint" onClick={() => void openExternalUrl(appInfo.htmlUrl)}><ExternalIcon size={12} /> GitHub</button>}
                  <button
                    className="primary"
                    disabled={appRunning || sourceUpdateBlocked || (!appInfo.assetUrl && !appInfo.sourceRepoValid)}
                    title={sourceUpdateBlocked ? sourceBlock ?? undefined : undefined}
                    onClick={() => void updateApp()}
                  >
                    {appRunning ? <><span className="spinner" /> Установка…</> : <><CheckIcon size={13} /> {appInfo.assetUrl ? "Установить в фоне" : "Обновить из исходников"}</>}
                  </button>
                </div>
              </>
            )}
            <label className="update-auto-row">
              <span><strong>Автообновление в фоне</strong><small>Готовый релиз установится без закрытия приложения и drag&amp;drop DMG.</small></span>
              <input type="checkbox" checked={automaticUpdates} onChange={(e) => void updateAppConfig({ automaticUpdates: e.target.checked })} />
            </label>
            <details className="update-advanced">
              <summary>Пересборка из исходников</summary>
              <div className="row update-repo-row">
                <span className="mono" title={repoPath ?? ""}>{repoPath ?? "каталог не задан"}</span>
                <button onClick={() => void pickRepo()}><FolderIcon size={13} /> Изменить</button>
              </div>
            </details>
          </section>

          <section className="update-section">
            <div className="update-section-head">
              <div className="update-section-icon"><PackageIcon size={16} /></div>
              <div className="update-section-copy">
                <strong>pi CLI</strong>
                <span className="hint">{piInfo?.currentVersion ?? "Версия не определена"}{piInfo?.latestVersion ? ` → ${piInfo.latestVersion}` : ""}</span>
              </div>
              {piInfo?.updateAvailable ? <span className="badge update">Доступно</span> : piInfo?.checked ? <span className="badge installed">Актуально</span> : null}
              <button className="primary" disabled={piRun.running || !piInfo?.updateAvailable} onClick={() => void piRun.runPi(["update", "--self"])}>
                {piRun.running ? <span className="spinner" /> : <RefreshIcon size={13} />} Обновить pi
              </button>
            </div>
          </section>

          <section className="update-section">
            <div className="update-section-head">
              <div className="update-section-icon"><PackageIcon size={16} /></div>
              <div className="update-section-copy">
                <strong>Расширения и skills</strong>
                <span className="hint">{specs.length} установлено · {packageUpdates.length} обновлений</span>
              </div>
              <button className="primary" disabled={piRun.running || packageUpdates.length === 0} onClick={() => void piRun.runPi(["update", "--extensions"])}>
                Обновить всё
              </button>
            </div>
            {packageUpdates.length > 0 ? (
              <div className="update-package-list">
                {packageUpdates.map((pkg) => (
                  <div className="update-package-row" key={pkg.name}>
                    <span className="mono">{pkg.name}</span>
                    <span className="hint">{pkg.installedVersion ?? "?"} → {pkg.version}</span>
                    <button disabled={piRun.running} onClick={() => void piRun.runPi(["update", `npm:${pkg.name}`])}>Обновить</button>
                  </div>
                ))}
              </div>
            ) : !checking && <div className="hint update-empty">Все незакреплённые community-пакеты актуальны.</div>}
          </section>

          {(appLog.length > 0 || piRun.log.length > 0) && (
            <div className="console update-console" ref={logRef}>{[...appLog, ...piRun.log].join("\n")}</div>
          )}
        </div>

        <div className="am-actions">
          <button disabled={checking || appRunning || piRun.running} onClick={() => void check()}><RefreshIcon size={13} /> Проверить всё</button>
          <div className="grow" />
          {appDone && appOk && <button className="primary" onClick={() => void relaunch()}>Перезапустить Pi App</button>}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
