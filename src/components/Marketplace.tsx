import { useCallback, useEffect, useRef, useState } from "react";
import { useInstalledPackages, useRunPi } from "../hooks/usePiPackages";
import { getBackend } from "../lib/backend";
import { confirmDialog } from "../lib/dialog";
import {
  isPackageResourceEnabled,
  packageCliSource,
  packageNameFromSpec,
  packageProvidesResource,
  packageRisk,
  packageSource,
} from "../lib/marketplace";
import type { PackageDetails, PackageKind, PackageSearch, PiPackage } from "../lib/types";
import { openExternalUrl } from "../state/store";
import { CheckIcon, ExternalIcon, PackageIcon, RefreshIcon } from "./icons";
import { Markdown } from "./Markdown";

function isHarnessCorePackage(pkg: Pick<PiPackage, "name" | "source">): boolean {
  return pkg.name === "harness-extension" && Boolean(pkg.source && !pkg.source.startsWith("npm:"));
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
  const catalogLoadGeneration = useRef(0);
  const detailsLoadGeneration = useRef(0);

  const {
    installed,
    specs,
    entries,
    loading: installedSettingsLoading,
    error: installedSettingsError,
    reload,
    setResourceEnabled,
  } = useInstalledPackages(scope, cwd);
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
  const installedLoadGeneration = useRef(0);
  const specsKey = specs.join("\u0000");
  const loadInstalledMeta = useCallback(async () => {
    const generation = ++installedLoadGeneration.current;
    if (specs.length === 0) {
      setInstalledMeta([]);
      setLoadingInstalled(false);
      return;
    }
    setLoadingInstalled(true);
    try {
      const be = await getBackend();
      const packages = await be.invoke<PiPackage[]>("pi_packages_meta", {
        names: specs,
        cwd: scope === "project" ? cwd : null,
      });
      if (generation === installedLoadGeneration.current) setInstalledMeta(packages);
    } catch {
      if (generation === installedLoadGeneration.current) setInstalledMeta([]);
    } finally {
      if (generation === installedLoadGeneration.current) setLoadingInstalled(false);
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
      const generation = ++catalogLoadGeneration.current;
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
        if (generation !== catalogLoadGeneration.current) return;
        setTotal(res.total);
        setResults((prev) => (append ? [...prev, ...res.objects] : res.objects));
        setFrom(nextFrom);
      } catch (e) {
        if (generation === catalogLoadGeneration.current) {
          setError(String(e));
          if (!append) setResults([]);
        }
      } finally {
        if (generation === catalogLoadGeneration.current) setLoading(false);
      }
    },
    [kind, debounced],
  );

  useEffect(() => {
    setResults([]);
    setTotal(0);
    setFrom(0);
    void fetchPage(0, false);
    return () => {
      catalogLoadGeneration.current++;
    };
  }, [fetchPage]);

  useEffect(() => {
    detailsLoadGeneration.current++;
    setExpandedPackage(null);
    setPackageDetails({});
  }, [cwd, kind, scope]);

  const missingRec = installedSettingsLoading || installedSettingsError
    ? []
    : (recommended ?? []).filter((r) => !installed.has(r.pkg.replace(/^npm:/, "")));
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
      detailsLoadGeneration.current++;
      setExpandedPackage(null);
      return;
    }
    const generation = ++detailsLoadGeneration.current;
    setExpandedPackage(identifier);
    if (
      Object.prototype.hasOwnProperty.call(packageDetails, identifier)
      && packageDetails[identifier] !== null
    ) return;
    setPackageDetails((current) => ({ ...current, [identifier]: null }));
    try {
      const be = await getBackend();
      const details = await be.invoke<PackageDetails>("pi_package_details", { name: p.name });
      if (generation === detailsLoadGeneration.current) {
        setPackageDetails((current) => ({ ...current, [identifier]: details }));
      }
    } catch (detailsError) {
      if (generation === detailsLoadGeneration.current) {
        setError(`Не удалось загрузить README: ${String(detailsError)}`);
        setExpandedPackage(null);
        setPackageDetails((current) => {
          const next = { ...current };
          delete next[identifier];
          return next;
        });
      }
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
                disabled={installedSettingsLoading || Boolean(installedSettingsError) || running || resourceBusy !== null || coreResource}
                aria-pressed={resourceEnabled}
                title={coreResource
                  ? "Ядро harness всегда активно"
                  : `${resourceEnabled ? "Отключить" : "Включить"} ${KIND_LABEL[kind]} пакета в этом scope`}
                onClick={() => void toggleResource(packageIdentifier, !resourceEnabled)}
              >
                <span aria-hidden="true" /> {resourceEnabled ? "Активно" : "Выключено"}
              </button>
              {updateAvailable && (
                <button className="primary" disabled={installedSettingsLoading || Boolean(installedSettingsError) || running || resourceBusy !== null} onClick={() => updatePackage(p)}>Обновить</button>
              )}
              <button
                className="danger"
                disabled={installedSettingsLoading || Boolean(installedSettingsError) || running || resourceBusy !== null || isHarnessCorePackage(p)}
                title={isHarnessCorePackage(p) ? "Ядро harness нельзя удалить" : "Удалить пакет и его ресурсы"}
                onClick={() => void remove(p)}
              >
                Удалить
              </button>
            </>
          ) : (
            <button className="primary" disabled={installedSettingsLoading || Boolean(installedSettingsError) || running || resourceBusy !== null} onClick={() => install(p.name)}>
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
                <button className="primary" disabled={installedSettingsLoading || Boolean(installedSettingsError) || running} onClick={() => install(r.pkg.replace(/^npm:/, ""))}>
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
        <button disabled={installedSettingsLoading || Boolean(installedSettingsError) || running || resourceBusy !== null} onClick={() => void runPi(["update", "--extensions"], scope === "project" ? cwd : null)} title="Обновить все незакреплённые пакеты">
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
      {installedSettingsError && <div className="card" role="alert" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>{installedSettingsError}</div>}

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
