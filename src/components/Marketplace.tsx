import { useCallback, useEffect, useRef, useState } from "react";
import { getBackend } from "../lib/backend";
import { confirmDialog } from "../lib/dialog";
import type { ConfigFile, PackageDetails, PackageKind, PackageSearch, PackageSetting, PiPackage } from "../lib/types";
import { openExternalUrl } from "../state/store";
import { CheckIcon, ExternalIcon, PackageIcon, RefreshIcon } from "./icons";
import { Markdown } from "./Markdown";

// ---------- installed packages (settings.json → packages[]) ----------

const RESOURCE_KEY: Record<PackageKind, "extensions" | "skills" | "themes" | "prompts"> = {
  extension: "extensions",
  skill: "skills",
  theme: "themes",
  prompt: "prompts",
};

function packageSource(spec: PackageSetting): string {
  return typeof spec === "string" ? spec : spec.source;
}

/** Convert package specs into the stable display/resource-filter name. */
export function packageNameFromSpec(spec: PackageSetting | unknown): string | null {
  const sourceSpec = typeof spec === "string"
    ? spec
    : spec && typeof spec === "object" && "source" in spec && typeof spec.source === "string"
      ? spec.source
      : "";
  if (sourceSpec.startsWith("git:")) {
    const clean = sourceSpec.slice(4).split(/[?#]/, 1)[0].replace(/\/$/, "");
    const name = clean.slice(clean.lastIndexOf("/") + 1).replace(/\.git$/, "");
    return name || null;
  }
  if (sourceSpec.startsWith("npm:")) {
    const source = sourceSpec.slice(4);
    if (source.startsWith("@")) {
      const versionSeparator = source.indexOf("@", source.indexOf("/") + 1);
      return versionSeparator > 0 ? source.slice(0, versionSeparator) : source;
    }
    const versionSeparator = source.indexOf("@");
    return versionSeparator > 0 ? source.slice(0, versionSeparator) : source;
  }
  // Pi also accepts local package directories. Keep those visible in the
  // Installed view instead of silently dropping every non-npm/non-git spec.
  const clean = sourceSpec.trim().replace(/^file:/, "").split(/[?#]/, 1)[0].replace(/[\\/]+$/, "");
  const name = clean.split(/[\\/]/).pop()?.replace(/\.git$/, "");
  return name || null;
}

export function isPackageResourceEnabled(spec: PackageSetting, kind: PackageKind): boolean {
  if (typeof spec === "string") return true;
  const filter = spec[RESOURCE_KEY[kind]];
  return filter === undefined || filter.length > 0;
}

export function setPackageResourceEnabled(
  packages: PackageSetting[],
  packageIdentifier: string,
  kind: PackageKind,
  enabled: boolean,
): PackageSetting[] {
  const key = RESOURCE_KEY[kind];
  return packages.map((spec) => {
    if (packageSource(spec) !== packageIdentifier && packageNameFromSpec(spec) !== packageIdentifier) return spec;
    const next: Exclude<PackageSetting, string> = typeof spec === "string" ? { source: spec } : { ...spec };
    if (enabled) delete next[key];
    else next[key] = [];
    return Object.keys(next).length === 1 ? next.source : next;
  });
}

export function packageCliSource(pkg: Pick<PiPackage, "name" | "source">): string {
  return pkg.source || `npm:${pkg.name}`;
}

/** Unknown manifests remain visible so custom package layouts are manageable;
 * a successfully inspected manifest with no matching resource is filtered. */
export function packageProvidesResource(
  pkg: Pick<PiPackage, "resourceKinds">,
  kind: PackageKind,
): boolean {
  return !Array.isArray(pkg.resourceKinds) || pkg.resourceKinds.includes(kind);
}

function isHarnessCorePackage(pkg: Pick<PiPackage, "name" | "source">): boolean {
  return pkg.name === "harness-extension" && Boolean(pkg.source && !pkg.source.startsWith("npm:"));
}

/** Installed packages plus scoped, atomic resource controls. */
export function useInstalledPackages(scope: "global" | "project" = "global", cwd?: string | null): {
  installed: Set<string>;
  specs: string[];
  entries: PackageSetting[];
  reload: () => void;
  setResourceEnabled: (packageName: string, kind: PackageKind, enabled: boolean) => Promise<void>;
} {
  const [entries, setEntries] = useState<PackageSetting[]>([]);
  const reload = useCallback(() => {
    void (async () => {
      const be = await getBackend();
      const f = scope === "project" && cwd
        ? await be.invoke<ConfigFile>("read_project_settings", { cwd }).catch(() => null)
        : await be.invoke<ConfigFile>("read_pi_config", { name: "settings" }).catch(() => null);
      try {
        const parsed = f ? (JSON.parse(f.content) as Record<string, unknown>) : {};
        const packages = Array.isArray(parsed.packages)
          ? parsed.packages.filter((item): item is PackageSetting =>
            typeof item === "string" || Boolean(item && typeof item === "object" && "source" in item && typeof item.source === "string"))
          : [];
        setEntries(packages);
      } catch {
        setEntries([]);
      }
    })();
  }, [scope, cwd]);
  useEffect(reload, [reload]);
  const installed = new Set(entries.map(packageNameFromSpec).filter((name): name is string => Boolean(name)));
  const specs = entries.map(packageSource);
  const setResourceEnabled = useCallback(async (packageName: string, kind: PackageKind, enabled: boolean) => {
    try {
      const be = await getBackend();
      if (scope === "project" && !cwd) throw new Error("Сначала откройте проект");
      const content = await be.invoke<string>("set_extension_resource_enabled", {
        scope,
        cwd: cwd ?? null,
        packageIdentifier: packageName,
        kind,
        enabled,
      });
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const packages = Array.isArray(parsed.packages)
        ? parsed.packages.filter((item): item is PackageSetting =>
          typeof item === "string" || Boolean(item && typeof item === "object" && "source" in item && typeof item.source === "string"))
        : [];
      setEntries(packages);
    } catch (error) {
      reload();
      throw error;
    }
  }, [cwd, reload, scope]);
  return { installed, specs, entries, reload, setResourceEnabled };
}

// ---------- pi CLI run (install / remove / update) with streamed log ----------

export function useRunPi(onDone?: () => void) {
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const runPi = async (args: string[], cwd?: string | null) => {
    setRunning(true);
    setLog((l) => [...l, `$ pi ${args.join(" ")}`]);
    const be = await getBackend();
    let un: (() => void) | null = null;
    let succeeded = false;
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
          setLog((l) => [...l, `— завершено (код ${String(p.code ?? "?")})`]);
          succeeded = Number(p.code ?? 1) === 0;
          finish();
        } else if (p.line) {
          setLog((l) => [...l.slice(-400), String(p.line)]);
        }
      };
      un = await be.listen("pi-cli-output", handle);
      runId = await be.invoke<string>("pi_cli_run", { args, cwd: cwd ?? null });
      for (const p of buffered.splice(0)) handle(p);
      await donePromise;
    } catch (e) {
      setLog((l) => [...l, `ошибка: ${String(e)}`]);
    } finally {
      un?.();
      setRunning(false);
      onDone?.();
    }
    return succeeded;
  };

  return { log, running, runPi, logRef, clearLog: () => setLog([]) };
}

// ---------- marketplace ----------

type Sort = "relevance" | "downloads" | "recent";

const SORTS: { id: Sort; label: string }[] = [
  { id: "relevance", label: "По релевантности" },
  { id: "downloads", label: "По загрузкам" },
  { id: "recent", label: "Свежие" },
];

function fmtDl(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function sortPackages(list: PiPackage[], sort: Sort): PiPackage[] {
  if (sort === "downloads") return [...list].sort((a, b) => b.downloadsMonthly - a.downloadsMonthly);
  if (sort === "recent") return [...list].sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
  return list;
}

export interface Recommended {
  pkg: string;
  name: string;
  desc: string;
}

const PAGE = 30;
const KIND_LABEL: Record<PackageKind, string> = {
  extension: "расширения",
  skill: "skills",
  theme: "темы",
  prompt: "prompts и AGENTS.md",
};

const KIND_RISK: Record<PackageKind, { label: string; title: string; className: string }> = {
  extension: { label: "исполняет код", title: "Расширение исполняется с правами текущего пользователя", className: "danger" },
  skill: { label: "контекст модели", title: "Описание и инструкции skill влияют на системный контекст", className: "context" },
  theme: { label: "только оформление", title: "Тема меняет палитру и оформление", className: "safe" },
  prompt: { label: "инструкции модели", title: "Prompt меняет инструкции, передаваемые модели", className: "context" },
};

const INSTALLED_PACKAGE_RISK = {
  label: "может исполнять код",
  title: "Установленный pi-пакет может одновременно содержать extensions, skills, themes и prompts; эта вкладка управляет только выбранным типом ресурса",
  className: "danger",
};

export function packageRisk(kind: PackageKind, installed: boolean) {
  return installed ? INSTALLED_PACKAGE_RISK : KIND_RISK[kind];
}

export default function Marketplace({
  kind,
  recommended,
  installHint,
  scope = "global",
  cwd = null,
}: {
  kind: PackageKind;
  recommended?: Recommended[];
  installHint?: string;
  scope?: "global" | "project";
  cwd?: string | null;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sort, setSort] = useState<Sort>("relevance");
  const [results, setResults] = useState<PiPackage[]>([]);
  const [total, setTotal] = useState(0);
  const [from, setFrom] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlyInstalled, setOnlyInstalled] = useState(false);
  const [installedRefresh, setInstalledRefresh] = useState(0);
  const [expandedPackage, setExpandedPackage] = useState<string | null>(null);
  const [packageDetails, setPackageDetails] = useState<Record<string, PackageDetails | null>>({});

  const { installed, specs, entries, reload, setResourceEnabled } = useInstalledPackages(scope, cwd);
  const { log, running, runPi, logRef } = useRunPi(() => {
    reload();
    setInstalledRefresh((value) => value + 1);
  });

  // Полный список установленных пакетов (из settings.json) с метаданными — чтобы
  // фильтр «Установленные» показывал ВСЕ пакеты, а не только те, что попали в
  // текущую страницу поиска по каталогу.
  const [installedMeta, setInstalledMeta] = useState<PiPackage[]>([]);
  const [loadingInstalled, setLoadingInstalled] = useState(false);
  const [resourceBusy, setResourceBusy] = useState<string | null>(null);
  const specsKey = specs.join("\u0000");
  const loadInstalledMeta = useCallback(async () => {
    if (specs.length === 0) {
      setInstalledMeta([]);
      return;
    }
    setLoadingInstalled(true);
    try {
      const be = await getBackend();
      setInstalledMeta(await be.invoke<PiPackage[]>("pi_packages_meta", {
        names: specs,
        cwd: scope === "project" ? cwd : null,
      }));
    } catch {
      setInstalledMeta([]);
    } finally {
      setLoadingInstalled(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specsKey, scope, cwd]);

  useEffect(() => {
    void loadInstalledMeta();
  }, [loadInstalledMeta, installedRefresh]);

  const requiredNames = new Set((recommended ?? []).map((r) => r.pkg.replace(/^npm:/, "")));

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 350);
    return () => clearTimeout(t);
  }, [query]);

  const fetchPage = useCallback(
    async (nextFrom: number, append: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const be = await getBackend();
        const res = await be.invoke<PackageSearch>("search_pi_packages", {
          kind,
          query: debounced,
          from: nextFrom,
          size: PAGE,
        });
        setTotal(res.total);
        setResults((prev) => (append ? [...prev, ...res.objects] : res.objects));
        setFrom(nextFrom);
      } catch (e) {
        setError(String(e));
        if (!append) setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [kind, debounced],
  );

  useEffect(() => {
    void fetchPage(0, false);
  }, [fetchPage]);

  const missingRec = (recommended ?? []).filter((r) => !installed.has(r.pkg.replace(/^npm:/, "")));
  const installedForKind = installedMeta.filter((pkg) => packageProvidesResource(pkg, kind));
  const shown = onlyInstalled ? sortPackages(installedForKind, sort) : sortPackages(results, sort);
  const canLoadMore = !onlyInstalled && results.length < total;

  const install = (name: string) => void runPi(["install", ...(scope === "project" ? ["-l"] : []), `npm:${name}`], scope === "project" ? cwd : null);
  const updatePackage = (p: PiPackage) => void runPi(["update", "--extension", packageCliSource(p)], scope === "project" ? cwd : null);
  const remove = async (p: PiPackage) => {
    if (requiredNames.has(p.name) || isHarnessCorePackage(p)) {
      const ok = await confirmDialog(
        `«${p.name}» используется этим клиентом — без него могут перестать работать функции приложения. Всё равно удалить?`,
        { kind: "warning" },
      );
      if (!ok) return;
    }
    void runPi(["remove", ...(scope === "project" ? ["-l"] : []), packageCliSource(p)], scope === "project" ? cwd : null);
  };

  const toggleResource = async (name: string, enabled: boolean) => {
    setResourceBusy(name);
    setError(null);
    try {
      await setResourceEnabled(name, kind, enabled);
    } catch (toggleError) {
      setError(`Не удалось изменить ресурс: ${String(toggleError)}`);
    } finally {
      setResourceBusy(null);
    }
  };

  const toggleDetails = async (p: PiPackage) => {
    const identifier = p.source ?? p.name;
    if (expandedPackage === identifier) {
      setExpandedPackage(null);
      return;
    }
    setExpandedPackage(identifier);
    if (Object.prototype.hasOwnProperty.call(packageDetails, identifier)) return;
    setPackageDetails((current) => ({ ...current, [identifier]: null }));
    try {
      const be = await getBackend();
      const details = await be.invoke<PackageDetails>("pi_package_details", { name: p.name });
      setPackageDetails((current) => ({ ...current, [identifier]: details }));
    } catch (detailsError) {
      setError(`Не удалось загрузить README: ${String(detailsError)}`);
      setExpandedPackage(null);
      setPackageDetails((current) => {
        const next = { ...current };
        delete next[identifier];
        return next;
      });
    }
  };

  const renderCard = (p: PiPackage) => {
    const isInstalled = installed.has(p.name);
    const risk = packageRisk(kind, isInstalled);
    const isRequired = requiredNames.has(p.name) || isHarnessCorePackage(p);
    const installedInfo = installedMeta.find((item) => p.source ? item.source === p.source : item.name === p.name);
    const updateAvailable = installedInfo?.updateAvailable === true;
    const packageIdentifier = p.source ?? p.name;
    const installedSpec = entries.find((spec) => packageSource(spec) === packageIdentifier || packageNameFromSpec(spec) === p.name);
    const resourceEnabled = installedSpec ? isPackageResourceEnabled(installedSpec, kind) : true;
    const coreResource = isHarnessCorePackage(p) && kind === "extension";
    return (
      <div key={packageIdentifier} className="card mk-card">
        <div className="mk-card-head">
          <div className="mk-card-identity">
            <PackageIcon size={15} />
            <div className="mk-card-copy">
              <div className="mk-card-titleline">
                <span className="c-title">{p.name}</span>
                {p.downloadsMonthly > 0 && (
                  <span className="mk-dl" title="Загрузок в месяц">↓ {fmtDl(p.downloadsMonthly)}/мес</span>
                )}
              </div>
              <div className="mk-card-badges">
                <span className={`badge mk-risk ${risk.className}`} title={risk.title}>{risk.label}</span>
                {isRequired && <span className="badge" style={{ color: "var(--warn)" }} title="Нужно для работы этого клиента">нужно приложению</span>}
                {isInstalled && <span className="badge green">установлено</span>}
                {updateAvailable && <span className="badge update">доступно {installedInfo?.version}</span>}
                {installedInfo?.pinned && <span className="badge">закреплено</span>}
              </div>
            </div>
          </div>
          <div className="mk-card-actions">
          {p.repoUrl && (
            <button className="hint" title="Открыть репозиторий" onClick={() => void openExternalUrl(p.repoUrl!)}>
              <ExternalIcon size={12} /> repo
            </button>
          )}
          {p.npmUrl && (
            <button className="hint" title="Открыть на npm" onClick={() => void openExternalUrl(p.npmUrl)}>
              npm ↗
            </button>
          )}
          {p.npmUrl && (
            <button className={expandedPackage === packageIdentifier ? "active" : "hint"} title="README и история изменений" onClick={() => void toggleDetails(p)}>
              {expandedPackage === packageIdentifier ? "Скрыть" : "README"}
            </button>
          )}
          {isInstalled ? (
            <>
              <button
                className={`resource-toggle ${resourceEnabled ? "on" : ""}`}
                disabled={running || resourceBusy !== null || coreResource}
                aria-pressed={resourceEnabled}
                title={coreResource
                  ? "Ядро harness всегда активно"
                  : `${resourceEnabled ? "Отключить" : "Включить"} ${KIND_LABEL[kind]} пакета в этом scope`}
                onClick={() => void toggleResource(packageIdentifier, !resourceEnabled)}
              >
                <span aria-hidden="true" /> {resourceEnabled ? "Активно" : "Выключено"}
              </button>
              {updateAvailable && (
                <button className="primary" disabled={running || resourceBusy !== null} onClick={() => updatePackage(p)}>Обновить</button>
              )}
              <button
                className="danger"
                disabled={running || resourceBusy !== null || isHarnessCorePackage(p)}
                title={isHarnessCorePackage(p) ? "Ядро harness нельзя удалить" : "Удалить пакет и его ресурсы"}
                onClick={() => void remove(p)}
              >
                Удалить
              </button>
            </>
          ) : (
            <button className="primary" disabled={running || resourceBusy !== null} onClick={() => install(p.name)}>
              Установить
            </button>
          )}
          </div>
        </div>
        {p.description && <div className="c-sub">{p.description}</div>}
        <div className="mk-tags">
          {(kind === "skill" || kind === "prompt") && p.description && <span className="mk-tag context-cost">≈{Math.max(1, Math.round(p.description.length / 4))} ток. описания</span>}
          {p.author && <span className="mk-tag">@{p.author}</span>}
          {p.version && <span className="mk-tag mono">v{p.version}</span>}
          {p.source && !p.source.startsWith("npm:") && <span className="mk-tag mono">{p.source}</span>}
          {p.keywords.filter((k) => k !== "pi-package" && k !== `pi-${kind}`).slice(0, 4).map((k) => (
            <span key={k} className="mk-tag">{k}</span>
          ))}
        </div>
        {expandedPackage === packageIdentifier && (
          <div className="package-details">
            {!packageDetails[packageIdentifier] ? <div className="muted">Загрузка документации…</div> : (
              <>
                <div className="package-details-head">
                  <strong>README</strong>
                  <div>
                    {packageDetails[packageIdentifier]?.changelog && <a href="#package-changelog">Changelog</a>}
                    {p.repoUrl && <button className="hint" onClick={() => void openExternalUrl(`${p.repoUrl}/releases`)}>Releases ↗</button>}
                  </div>
                </div>
                {packageDetails[packageIdentifier]?.readme
                  ? <div className="package-markdown"><Markdown source={packageDetails[packageIdentifier]!.readme!} final /></div>
                  : <div className="muted">README не включён в npm-пакет.</div>}
                {packageDetails[packageIdentifier]?.changelog && (
                  <details id="package-changelog" className="package-changelog">
                    <summary>Changelog из пакета</summary>
                    <div className="package-markdown"><Markdown source={packageDetails[packageIdentifier]!.changelog!} final /></div>
                  </details>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="market">
      {installHint && <div className="hint" style={{ marginBottom: 10 }}>{installHint}</div>}

      {missingRec.length > 0 && !debounced && (
        <>
          <div className="section-title" style={{ padding: "2px 2px 8px" }}>
            Рекомендуемые (используются этим клиентом)
          </div>
          {missingRec.map((r) => (
            <div key={r.pkg} className="card mk-card">
              <div className="row">
                <span className="c-title">{r.name}</span>
                <span className="badge">не установлено</span>
                <div className="grow" />
                <button className="primary" disabled={running} onClick={() => install(r.pkg.replace(/^npm:/, ""))}>
                  Установить
                </button>
              </div>
              <div className="c-sub">{r.desc}</div>
              <div className="c-sub" style={{ fontFamily: "var(--font-mono)" }}>{r.pkg}</div>
            </div>
          ))}
        </>
      )}

      <div className="mk-toolbar">
        <input
          className="grow"
          placeholder={`Поиск в маркетплейсе pi.dev — ${KIND_LABEL[kind]}…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          {SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <button className={onlyInstalled ? "active" : ""} onClick={() => setOnlyInstalled(!onlyInstalled)} title="Только установленные">
          <CheckIcon size={13} /> Установленные
        </button>
        <button disabled={running || resourceBusy !== null} onClick={() => void runPi(["update", "--extensions"], scope === "project" ? cwd : null)} title="Обновить все незакреплённые пакеты">
          <RefreshIcon size={13} /> Обновить всё
        </button>
      </div>

      <div className="mk-meta">
        {onlyInstalled
          ? loadingInstalled
            ? "загрузка установленных…"
            : `Пакеты с ресурсом «${KIND_LABEL[kind]}»: ${installedForKind.length}`
          : loading && results.length === 0
            ? "загрузка каталога…"
            : `${total.toLocaleString("ru-RU")} пакетов в каталоге pi.dev`}
      </div>

      {error && <div className="card" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>{error}</div>}

      {shown.map(renderCard)}

      {shown.length === 0 && !loading && !loadingInstalled && (
        <div className="muted">{onlyInstalled ? "Пакетов с ресурсами этого типа нет" : "Ничего не найдено"}</div>
      )}

      {canLoadMore && (
        <button className="mk-more" disabled={loading} onClick={() => void fetchPage(from + PAGE, true)}>
          {loading ? "загрузка…" : `Показать ещё (${results.length} из ${total})`}
        </button>
      )}

      {log.length > 0 && (
        <div className="console" ref={logRef} style={{ marginTop: 14 }}>
          {log.join("\n")}
        </div>
      )}
    </div>
  );
}
