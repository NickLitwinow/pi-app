import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { getBackend } from "../lib/backend";
import type { AppThemePalette, ConfigFile, PiInfo, PiThemeInfo } from "../lib/types";
import { confirmDialog, messageDialog } from "../lib/dialog";
import { appIconForeground, applyAppThemePalette, applyAppearanceConfig, completePiThemeColors, paletteFromPiColors, resolveAppIconBackground } from "../lib/theme";
import { modelAliasKey, modelForProvider, providerDraftError, type ModelCatalog } from "../lib/models";
import { updateAppConfig, useStore } from "../state/store";
import { ModelAvatarPicker } from "./AgentAvatar";
import Marketplace from "./Marketplace";
import { AppearanceIcon, CheckIcon, ErrorIcon, FolderIcon, RefreshIcon, SendIcon, UpdateIcon } from "./icons";

type Tab = "general" | "themes" | "mcp" | "models" | "proc" | "app";

/** Текстовое поле с отложенной записью: локальное значение мгновенно, коммит в файл —
 *  после паузы ввода (иначе settings.json переписывается на каждую букву — I/O-шторм
 *  и гонка с pi, который тоже пишет этот файл). */
function useDebouncedField(
  value: string,
  commit: (v: string) => void,
  delay = 600,
): [string, (v: string) => void] {
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);
  const committed = useRef(value);
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  }, [commit]);
  useEffect(() => {
    // внешнее изменение (перечитали файл) — синхронизируем локальное значение
    if (value !== committed.current) {
      committed.current = value;
      setLocal(value);
    }
  }, [value]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (pending.current !== null) {
      committed.current = pending.current;
      commitRef.current(pending.current);
      pending.current = null;
    }
  }, []);
  const set = (v: string) => {
    setLocal(v);
    pending.current = v;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      committed.current = v;
      pending.current = null;
      timer.current = null;
      commitRef.current(v);
    }, delay);
  };
  return [local, set];
}

// ---------- процесс-панель (R3-G2): куда уходит память ----------

interface ProcStat {
  kind: "agent" | "preview" | "app" | string;
  id: string;
  label: string;
  pid: number | null;
  rssMb: number;
  procs: number;
  uptimeMs: number;
}

const PROC_KIND_LABEL: Record<string, string> = {
  agent: "Агент pi",
  preview: "Dev-сервер",
  app: "Приложение",
};

function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}ч ${minutes}м`;
  if (minutes > 0) return `${minutes}м ${seconds}с`;
  return `${seconds}с`;
}

function ProcessesTab() {
  const [rows, setRows] = useState<ProcStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const be = await getBackend();
      setRows(await be.invoke<ProcStat[]>("process_stats"));
      setError(null);
    } catch (refreshError) {
      setError(`Не удалось получить список процессов: ${String(refreshError)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const kill = async (r: ProcStat) => {
    try {
      const be = await getBackend();
      if (r.kind === "agent") await be.invoke("kill_agent", { agentId: r.id });
      else if (r.kind === "preview") await be.invoke("preview_stop", { serverId: r.id });
      await refresh();
    } catch (killError) {
      setError(`Не удалось остановить процесс: ${String(killError)}`);
    }
  };

  const total = (rows ?? []).reduce((n, r) => n + r.rssMb, 0);

  return (
    <div>
      {error && <div className="alert error" style={{ marginBottom: 10 }}>{error}</div>}
      <div className="hint" style={{ marginBottom: 10 }}>
        Каждый агент pi — это process group: сам pi плюс его MCP-серверы и хелперы; dev-серверы превью —
        тоже группа (npm + vite/node). WebKit-хелперы macOS живут вне групп приложения и здесь не видны.
        Обновление каждые 3 секунды.
      </div>
      <div className="section-title" style={{ padding: "0 2px 6px" }}>
        Суммарно ≈ {Math.round(total)} МБ
      </div>
      {rows != null && rows.length === 0 && <div className="muted">Нет запущенных процессов.</div>}
      {(rows ?? []).map((r) => (
        <div
          key={`${r.kind}:${r.id}`}
          className="card"
          style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 10 }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="c-title" style={{ fontSize: 13 }}>
              {PROC_KIND_LABEL[r.kind] ?? r.kind}
              <span className="muted" style={{ fontWeight: 400, fontSize: 11, marginLeft: 8 }}>
                {r.pid != null ? `pid ${r.pid}` : "pid —"} · {r.procs} проц. · {formatUptime(r.uptimeMs)}
              </span>
            </div>
            <div className="c-sub" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r.label}
            </div>
          </div>
          <div style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
            {r.rssMb >= 100 ? Math.round(r.rssMb) : r.rssMb.toFixed(1)} МБ
          </div>
          {(r.kind === "agent" || r.kind === "preview") && (
            <button aria-label={`Остановить ${r.label}`} onClick={() => void kill(r)} title={r.kind === "agent" ? "Остановить агента" : "Остановить dev-сервер"}>
              Стоп
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

const ALL_TABS: { id: Tab; label: string; desc: string; needsPi: boolean }[] = [
  { id: "general", label: "Основные", desc: "Модель, thinking и контекст", needsPi: false },
  { id: "app", label: "Интерфейс", desc: "Вид, поведение и процессы", needsPi: false },
  { id: "models", label: "Провайдеры", desc: "Модели и эндпоинты", needsPi: true },
  { id: "themes", label: "Редактор тем", desc: "Палитра, импорт и экспорт", needsPi: true },
  { id: "mcp", label: "MCP", desc: "Подключённые серверы", needsPi: true },
  { id: "proc", label: "Процессы", desc: "Память и активность", needsPi: false },
];

function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <strong>{title}</strong>
        {description && <span>{description}</span>}
      </div>
      <div className="settings-group-body">{children}</div>
    </section>
  );
}

// ---------- pi installation card (детект / ручной выбор пути) ----------

function PiInstallCard() {
  const piInfo = useStore((s) => s.piInfo);
  const appConfig = useStore((s) => s.appConfig);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyPath = async (path: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const be = await getBackend();
      const info = await be.invoke<PiInfo>("set_pi_path", { path });
      useStore.setState({ piInfo: info, appConfig: { ...appConfig, piPath: path } });
      if (!info.path) setError("pi не найден автоматически — укажите путь вручную");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const pickManually = async () => {
    const be = await getBackend();
    if (be.isMock) {
      const p = window.prompt("Путь к бинарю pi:", "/opt/homebrew/bin/pi");
      if (p) await applyPath(p);
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ multiple: false, directory: false, title: "Выберите бинарь pi" }).catch(() => null);
    if (typeof sel === "string" && sel) await applyPath(sel);
  };

  const found = Boolean(piInfo?.path);

  return (
    <div className="card" style={!found ? { borderColor: "var(--danger)" } : undefined}>
      <div className="c-title">
        {found ? <CheckIcon size={14} /> : <ErrorIcon size={14} />}
        Установка pi {found ? "— найдена" : "— не найдена"}
      </div>
      {found ? (
        <>
          <div className="c-sub" style={{ fontFamily: "var(--font-mono)" }}>
            {piInfo?.path} {piInfo?.version ? `· v${piInfo.version}` : ""}
            {appConfig.piPath ? " · путь задан вручную" : " · автоопределение"}
          </div>
          <div className="c-sub" style={{ fontFamily: "var(--font-mono)" }}>{piInfo?.agentDir}</div>
        </>
      ) : (
        <div className="c-sub">
          Клиент работает поверх агента pi. Установите его: <code>npm install -g @earendil-works/pi-coding-agent</code>{" "}
          (или см. pi.dev), либо укажите путь к уже установленному бинарю.
        </div>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <button disabled={busy} onClick={() => void applyPath(null)} title="Сбросить ручной путь и найти pi заново">
          <RefreshIcon size={13} /> Определить автоматически
        </button>
        <button disabled={busy} onClick={() => void pickManually()}>
          <FolderIcon size={13} /> Указать путь вручную…
        </button>
        {busy && <span className="hint">проверяю…</span>}
      </div>
      {error && <div className="c-sub" style={{ color: "var(--danger)", marginTop: 6 }}>{error}</div>}
    </div>
  );
}

// ---------- shared raw JSON editor ----------

function parseJsonObject(content: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label}: корень должен быть объектом`);
  return parsed as Record<string, unknown>;
}

function RawJsonEditor({
  name,
  onSaved,
}: {
  name: "settings" | "mcp" | "models";
  onSaved?: (content: string) => void;
}) {
  const [file, setFile] = useState<ConfigFile | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    const be = await getBackend();
    const f = await be.invoke<ConfigFile>("read_pi_config", { name });
    setFile(f);
    setText(f.content);
    setDirty(false);
    setError(null);
  }, [name]);

  useEffect(() => {
    void load();
  }, [load]);

  const validate = (t: string): string | null => {
    try {
      parseJsonObject(t, `${name}.json`);
      return null;
    } catch (e) {
      return String(e);
    }
  };

  const save = async () => {
    const err = validate(text);
    if (err) {
      setError(err);
      return;
    }
    try {
      const be = await getBackend();
      await be.invoke("write_pi_config", { name, content: text });
      setDirty(false);
      setError(null);
      setSavedAt(Date.now());
      onSaved?.(text);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <details className="advanced-editor">
      <summary>
        <span>
          <strong>Advanced · raw {name}.json</strong>
          <small>Для параметров, которых пока нет в визуальном редакторе</small>
        </span>
        <span className={dirty ? "advanced-state dirty" : "advanced-state"}>{dirty ? "Не сохранено" : "Открыть"}</span>
      </summary>
      <div className="advanced-editor-body">
      <div className="row advanced-toolbar">
        <span className="muted" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
          {file?.path ?? ""}
        </span>
        <div className="grow" />
        {savedAt && !dirty && <span className="hint" style={{ color: "var(--ok)" }}>сохранено ✓</span>}
        <button onClick={() => void load()}>Перечитать</button>
        <button className="primary" disabled={!dirty} onClick={() => void save()}>
          Сохранить
        </button>
      </div>
      {error && (
        <div className="card" style={{ borderColor: "var(--danger)", color: "var(--danger)", fontSize: 12 }}>
          {error}
        </div>
      )}
      <textarea
        className="jsonedit"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
          setError(validate(e.target.value));
        }}
      />
      <div className="hint">Запись атомарная, предыдущая версия сохраняется в *.pi-app.bak. Активному агенту нужен перезапуск сессии, чтобы подхватить изменения.</div>
      </div>
    </details>
  );
}

// ---------- settings.json helpers ----------

type PiSettings = Record<string, unknown> & {
  compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
  packages?: string[];
};

function useSettingsJson(): [PiSettings | null, (patch: Partial<PiSettings>) => Promise<boolean>, () => Promise<void>, string | null] {
  const [parsed, setParsed] = useState<PiSettings | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());

  const reload = useCallback(async () => {
    try {
      const be = await getBackend();
      const f = await be.invoke<ConfigFile>("read_pi_config", { name: "settings" });
      setParsed(parseJsonObject(f.content, "settings.json") as PiSettings);
      setSaveError(null);
    } catch (error) {
      setParsed(null);
      setSaveError(`Не удалось прочитать settings.json: ${String(error)}. Исправьте файл в Advanced-редакторе; визуальные настройки не будут его перезаписывать.`);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const update = useCallback((patch: Partial<PiSettings>) => {
    const run = async (): Promise<boolean> => {
      try {
        const be = await getBackend();
        // Перечитываем перед записью, чтобы не затереть внешние изменения. Если
        // JSON повреждён, визуальный CRUD обязан fail closed, а не стирать ключи,
        // которых не понимает.
        const f = await be.invoke<ConfigFile>("read_pi_config", { name: "settings" });
        const latest = parseJsonObject(f.content, "settings.json") as PiSettings;
        const next = { ...latest, ...patch };
        await be.invoke("write_pi_config", { name: "settings", content: JSON.stringify(next, null, 2) });
        setParsed(next);
        setSaveError(null);
        return true;
      } catch (error) {
        setSaveError(`Не удалось сохранить settings.json: ${String(error)}`);
        return false;
      }
    };
    const result = writeQueue.current.then(run, run);
    writeQueue.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  return [parsed, update, reload, saveError];
}

// ---------- general ----------

function GeneralTab() {
  const [parsed, update, reload, saveError] = useSettingsJson();
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog>({});
  const compaction = parsed?.compaction ?? {};
  const compactionEnabled = compaction.enabled !== false;
  const prov = String(parsed?.defaultProvider ?? "");
  const model = String(parsed?.defaultModel ?? "");
  const tuiTheme = String(parsed?.theme ?? "");

  useEffect(() => {
    void (async () => {
      const be = await getBackend();
      const file = await be.invoke<ConfigFile>("read_pi_config", { name: "models" }).catch(() => null);
      try {
        const next = JSON.parse(file?.content ?? "{}") as { providers?: ModelCatalog };
        setModelCatalog(next.providers ?? {});
      } catch {
        setModelCatalog({});
      }
    })();
  }, []);

  const providerOptions = Array.from(new Set([prov, ...Object.keys(modelCatalog)].filter(Boolean)));
  const modelOptions = Array.from(new Set([
    model,
    ...(modelCatalog[prov]?.models ?? []).map((entry) => entry.id ?? ""),
  ].filter(Boolean)));

  return (
    <div className="settings-page">
      <PiInstallCard />
      {saveError && <div className="card" role="alert" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>{saveError}</div>}

      {parsed && (
        <>
          <SettingsGroup title="Новая сессия" description="Применяется автоматически при следующем запуске агента">
          <div className="form-row">
            <label>Провайдер <small>Ключ из models.json</small></label>
            <select
              aria-label="Провайдер по умолчанию"
              value={prov}
              onChange={(e) => {
                const defaultProvider = e.target.value;
                const defaultModel = modelForProvider(modelCatalog, defaultProvider, model);
                void update({ defaultProvider, defaultModel });
              }}
            >
              {providerOptions.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
            </select>
          </div>
          <div className="form-row">
            <label>Модель <small>Runtime ID, без UI-псевдонима</small></label>
            <select aria-label="Модель по умолчанию" value={model} onChange={(e) => void update({ defaultModel: e.target.value })}>
              {modelOptions.map((modelId) => <option key={modelId} value={modelId}>{modelId}</option>)}
            </select>
          </div>
          {model && (
            <div className="form-row">
              <label>Иконка модели <small>Покой и «LLM работает» — как в чате</small></label>
              <div className="model-avatar-setting">
                <ModelAvatarPicker modelKey={modelAliasKey(prov, model)} size={30} />
                <span className="hint">{prov ? `${prov}/${model}` : model}</span>
              </div>
            </div>
          )}
          <div className="form-row">
            <label>Thinking <small>Глубина рассуждений по умолчанию</small></label>
            <SegmentedControl
              label="Thinking по умолчанию"
              value={String(parsed.defaultThinkingLevel ?? "high")}
              options={["off", "minimal", "low", "medium", "high", "xhigh"].map((value) => ({ value, label: value }))}
              onChange={(defaultThinkingLevel) => void update({ defaultThinkingLevel })}
            />
          </div>
          <div className="form-row">
            <label>Тема pi TUI <small>Отдельна от темы приложения</small></label>
            <select aria-label="Тема pi TUI" value={tuiTheme} onChange={(e) => void update({ theme: e.target.value })}>
              {Array.from(new Set([tuiTheme, "dark", "light"].filter(Boolean))).map((themeName) => (
                <option key={themeName} value={themeName}>{themeName}</option>
              ))}
            </select>
          </div>
          </SettingsGroup>

          <SettingsGroup title="Компакция контекста" description="Изменения пишутся сразу; активной сессии потребуется перезапуск">
          <div className="form-row">
            <label>Авто-компакция <small>Сворачивает старый контекст при заполнении</small></label>
            <GlassSwitch
              label="Авто-компакция при заполнении окна"
              checked={compactionEnabled}
              onChange={(enabled) => void update({ compaction: { ...compaction, enabled } })}
            />
          </div>
          <div className="form-row">
            <label>Резерв ответа <small>reserveTokens</small></label>
            <input
              aria-label="Резерв под ответ модели"
              type="number"
              min={1024}
              step={1024}
              value={compaction.reserveTokens ?? 16384}
              onChange={(e) =>
                void update({ compaction: { ...compaction, reserveTokens: Math.max(1024, Number(e.target.value) || 16384) } })
              }
            />
          </div>
          <div className="form-row">
            <label>Свежий контекст <small>keepRecentTokens</small></label>
            <input
              aria-label="Свежий контекст без сжатия"
              type="number"
              min={2000}
              step={1000}
              value={compaction.keepRecentTokens ?? 20000}
              onChange={(e) =>
                void update({ compaction: { ...compaction, keepRecentTokens: Math.max(2000, Number(e.target.value) || 20000) } })
              }
            />
          </div>
          <div className="hint">
            Компакция — механизм ядра pi: при переполнении контекстного окна старые сообщения сворачиваются в
            структурированное резюме. Порог: contextWindow − reserveTokens. Изменения подхватываются новыми сессиями.
          </div>
          </SettingsGroup>
        </>
      )}

      <RawJsonEditor name="settings" onSaved={() => void reload()} />
    </div>
  );
}

function ThemesTab() {
  const cwd = useStore((s) => s.currentCwd);
  const appConfig = useStore((s) => s.appConfig);
  const [themes, setThemes] = useState<PiThemeInfo[]>([]);
  const [draft, setDraft] = useState<{ name: string; colors: Record<string, string | number> } | null>(null);
  const [scope, setScope] = useState<"global" | "project">("global");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const be = await getBackend();
      setThemes(await be.invoke<PiThemeInfo[]>("list_pi_themes", { cwd }));
      setError(null);
    } catch (loadError) {
      setThemes([]);
      setError(`Не удалось загрузить темы: ${String(loadError)}`);
    }
  }, [cwd]);

  useEffect(() => void load(), [load]);

  const draftResolved = useMemo(
    () => Object.fromEntries(Object.entries(draft?.colors ?? {}).map(([key, value]) => [key, typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : "#8b8b92"])),
    [draft],
  );
  const previewPalette = useMemo(
    () => draft ? paletteFromPiColors(draft.name, draftResolved) : null,
    [draft, draftResolved],
  );

  useEffect(() => {
    if (!previewPalette) return;
    applyAppThemePalette(previewPalette);
    return () => applyAppearanceConfig(useStore.getState().appConfig);
  }, [previewPalette]);

  const writeActiveTheme = async (name: string | undefined): Promise<string | undefined> => {
    const be = await getBackend();
    const file = await be.invoke<ConfigFile>("read_pi_config", { name: "settings" });
    const parsed = JSON.parse(file.content || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("settings.json: корень должен быть объектом");
    const settings = parsed as Record<string, unknown>;
    const previous = typeof settings.theme === "string" ? settings.theme : undefined;
    if (name) settings.theme = name;
    else delete settings.theme;
    await be.invoke("write_pi_config", { name: "settings", content: JSON.stringify(settings, null, 2) });
    return previous;
  };

  const applyInstalled = async (theme: PiThemeInfo) => {
    try {
      const palette = paletteFromPiColors(theme.name, theme.resolvedColors);
      const previous = await writeActiveTheme(theme.name);
      const saved = await updateAppConfig({ appearancePreset: "custom", accentColor: palette.accent, customTheme: palette });
      if (!saved) {
        await writeActiveTheme(previous).catch(() => {});
        throw new Error("палитра приложения не сохранилась; активная тема pi восстановлена");
      }
      setError(null);
    } catch (applyError) {
      setError(`Не удалось применить тему: ${String(applyError)}`);
    }
  };

  const deleteInstalled = async (theme: PiThemeInfo) => {
    try {
      const be = await getBackend();
      const settingsFile = await be.invoke<ConfigFile>("read_pi_config", { name: "settings" });
      const parsed = JSON.parse(settingsFile.content) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("settings.json: корень должен быть объектом");
      const settings = parsed as { theme?: string };
      if (settings.theme === theme.name) {
        setError(`Нельзя удалить активную тему «${theme.name}». Сначала примените другую тему.`);
        return;
      }
      const ok = await confirmDialog(`Удалить пользовательскую тему «${theme.name}»?`);
      if (!ok) return;
      await be.invoke("delete_pi_theme", { path: theme.path, cwd });
      if (draft?.name === theme.name) setDraft(null);
      await load();
    } catch (deleteError) {
      setError(`Не удалось удалить тему: ${String(deleteError)}`);
    }
  };

  const startEditor = (theme?: PiThemeInfo) => {
    const seed = theme?.resolvedColors ?? (appConfig.customTheme ? {
      accent: appConfig.customTheme.accent, borderMuted: appConfig.customTheme.border, success: appConfig.customTheme.success,
      error: appConfig.customTheme.danger, warning: appConfig.customTheme.warning, muted: appConfig.customTheme.muted,
      text: appConfig.customTheme.text, selectedBg: appConfig.customTheme.active, userMessageBg: appConfig.customTheme.raised,
      customMessageBg: appConfig.customTheme.sidebar, toolPendingBg: appConfig.customTheme.background,
    } : {});
    setDraft({ name: theme ? `${theme.name}-custom` : "my-theme", colors: completePiThemeColors(seed) });
  };

  const updateDraftColor = (token: string, value: string) => {
    setDraft((current) => current ? { ...current, colors: { ...current.colors, [token]: value } } : current);
  };

  const saveAndApply = async () => {
    if (!draft || !previewPalette) return;
    setBusy(true);
    try {
      const be = await getBackend();
      await be.invoke("save_pi_theme", { draft, scope, cwd });
      const previous = await writeActiveTheme(draft.name);
      const saved = await updateAppConfig({ appearancePreset: "custom", accentColor: previewPalette.accent, customTheme: previewPalette });
      if (!saved) {
        await writeActiveTheme(previous).catch(() => {});
        throw new Error("палитра приложения не сохранилась; активная тема pi восстановлена");
      }
      await load();
      await messageDialog(`Тема «${draft.name}» сохранена и применена к pi и приложению.`, { kind: "info" });
    } catch (error) {
      await messageDialog(String(error), { kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const exportPackage = async () => {
    if (!draft) return;
    const be = await getBackend();
    let destination = "/Users/dev/Desktop";
    if (!be.isMock) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false, title: "Куда экспортировать пакет pi-theme" }).catch(() => null);
      if (typeof selected !== "string") return;
      destination = selected;
    }
    try {
      const path = await be.invoke<string>("export_pi_theme_package", { destination, draft });
      await messageDialog(`Пакет экспортирован: ${path}\n\nПеред публикацией добавьте author/repository и выполните npm publish.`, { kind: "info" });
    } catch (error) {
      await messageDialog(String(error), { kind: "error" });
    }
  };

  const paletteFields: { token: keyof AppThemePalette | string; label: string; piToken: string }[] = [
    { token: "background", label: "Фон", piToken: "toolPendingBg" },
    { token: "sidebar", label: "Сайдбар", piToken: "customMessageBg" },
    { token: "raised", label: "Карточки", piToken: "userMessageBg" },
    { token: "active", label: "Выделение", piToken: "selectedBg" },
    { token: "text", label: "Основной текст", piToken: "text" },
    { token: "muted", label: "Вторичный текст", piToken: "muted" },
    { token: "border", label: "Границы", piToken: "borderMuted" },
    { token: "accent", label: "Акцент", piToken: "accent" },
    { token: "success", label: "Success", piToken: "success" },
    { token: "warning", label: "Warning", piToken: "warning" },
    { token: "danger", label: "Error", piToken: "error" },
  ];

  return (
    <div className="theme-library">
      <Marketplace
        kind="theme"
        installHint="Темы сообщества pi.dev. Установка добавляет тему в pi; ниже можно применить её одновременно к TUI и интерфейсу приложения."
      />

      {error && <div className="card" role="alert" style={{ borderColor: "var(--danger)", color: "var(--danger)", marginBottom: 10 }}>{error}</div>}

      <div className="section-title theme-local-title">
        Установленные темы · {themes.length}
        <button className="primary" onClick={() => startEditor()}>Создать тему</button>
      </div>
      <div className="theme-local-grid">
        {themes.map((theme) => {
          const palette = paletteFromPiColors(theme.name, theme.resolvedColors);
          return (
            <div className="card pi-theme-card" key={theme.path}>
              <div className="pi-theme-preview" style={{ background: palette.background }}>
                <span style={{ background: palette.sidebar }} />
                <i style={{ background: palette.accent }} />
                <b style={{ background: palette.raised, borderColor: palette.border }} />
              </div>
              <div className="pi-theme-card-copy">
                <strong>{theme.name}</strong>
                <span className="hint">{theme.packageName ?? (theme.source === "project" ? "Проект" : "Глобальная")}</span>
                {!theme.valid && <span className="hint" style={{ color: "var(--warn)" }}>{theme.error}</span>}
              </div>
              <div className="pi-theme-actions">
                <button onClick={() => startEditor(theme)}>Дублировать</button>
                <button className="primary" disabled={!theme.valid} onClick={() => void applyInstalled(theme)}>Применить</button>
                {theme.source !== "package" && <button className="danger" aria-label={`Удалить тему ${theme.name}`} onClick={() => void deleteInstalled(theme)}>Удалить</button>}
              </div>
            </div>
          );
        })}
        {themes.length === 0 && <div className="muted">Локальных тем пока нет — создайте свою или установите пакет из каталога.</div>}
      </div>

      {draft && previewPalette && (
        <section className="theme-editor settings-group">
          <div className="settings-group-head theme-editor-head">
            <span><strong>Редактор темы</strong><small>Live preview применяется ко всему приложению, сохранение — только по кнопке.</small></span>
            <button onClick={() => setDraft(null)}>Закрыть</button>
          </div>
          <div className="theme-editor-preview" style={{ background: previewPalette.background, color: previewPalette.text, borderColor: previewPalette.border }}>
            <div className="theme-editor-preview-sidebar" style={{ background: previewPalette.sidebar }}>
              <span style={{ background: previewPalette.accent }} />
              <span /><span />
            </div>
            <div className="theme-editor-preview-chat">
              <strong>{draft.name}</strong>
              <p style={{ color: previewPalette.muted }}>Pi App · adaptive community theme</p>
              <div style={{ background: previewPalette.raised, borderColor: previewPalette.border }}>Карточка ответа с синхронной палитрой TUI и приложения.</div>
              <button style={{ background: previewPalette.accent }}>Продолжить</button>
            </div>
          </div>
          <div className="theme-editor-fields">
            <label className="theme-name-field">Название<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            {paletteFields.map((field) => (
              <label key={field.piToken}>
                <span>{field.label}<small>{field.piToken}</small></span>
                <input type="color" value={String(draft.colors[field.piToken])} onChange={(event) => updateDraftColor(field.piToken, event.target.value)} />
                <code>{String(draft.colors[field.piToken])}</code>
              </label>
            ))}
          </div>
          <div className="theme-editor-actions">
            <select aria-label="Область сохранения темы" value={scope} onChange={(event) => setScope(event.target.value as "global" | "project")}>
              <option value="global">Для всех проектов</option>
              <option value="project" disabled={!cwd}>Только текущий проект</option>
            </select>
            <button onClick={() => void exportPackage()}>Экспортировать pi-theme</button>
            <button className="primary" disabled={busy} onClick={() => void saveAndApply()}>{busy ? "Сохранение…" : "Сохранить и применить"}</button>
          </div>
        </section>
      )}
    </div>
  );
}

// ---------- MCP ----------

function McpTab() {
  const [servers, setServers] = useState<Record<string, Record<string, unknown>>>({});
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const parseServers = (content: string): { root: Record<string, unknown>; servers: Record<string, Record<string, unknown>> } => {
    const root = JSON.parse(content) as unknown;
    if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("корень mcp.json должен быть объектом");
    const raw = (root as Record<string, unknown>).mcpServers ?? {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("mcpServers должен быть объектом");
    const entries = Object.entries(raw);
    if (entries.some(([, value]) => !value || typeof value !== "object" || Array.isArray(value))) {
      throw new Error("каждый MCP-сервер должен быть объектом");
    }
    return { root: root as Record<string, unknown>, servers: Object.fromEntries(entries) as Record<string, Record<string, unknown>> };
  };

  useEffect(() => {
    void (async () => {
      try {
        const be = await getBackend();
        const f = await be.invoke<ConfigFile>("read_pi_config", { name: "mcp" });
        setServers(parseServers(f.content).servers);
        setError(null);
      } catch (readError) {
        setServers({});
        setError(`Не удалось прочитать mcp.json: ${String(readError)}. Исправьте его в Advanced-редакторе.`);
      }
    })();
  }, [reloadKey]);

  const removeServer = async (name: string) => {
    try {
      if (!(await confirmDialog(`Удалить MCP-сервер «${name}» из mcp.json?`))) return;
      const be = await getBackend();
      const f = await be.invoke<ConfigFile>("read_pi_config", { name: "mcp" });
      const parsed = parseServers(f.content);
      const nextServers = { ...parsed.servers };
      delete nextServers[name];
      await be.invoke("write_pi_config", { name: "mcp", content: JSON.stringify({ ...parsed.root, mcpServers: nextServers }, null, 2) });
      setServers(nextServers);
      setError(null);
      setReloadKey((k) => k + 1);
    } catch (removeError) {
      setError(`Не удалось удалить MCP-сервер: ${String(removeError)}`);
    }
  };

  return (
    <div>
      {error && <div className="card" role="alert" style={{ borderColor: "var(--danger)", color: "var(--danger)", marginBottom: 10 }}>{error}</div>}
      {Object.entries(servers).map(([name, cfg]) => (
        <div key={name} className="card">
          <div className="row">
            <span className="c-title">{name}</span>
            <span className="badge">{String(cfg.lifecycle ?? "eager")}</span>
            <div className="grow" />
            <button className="danger" aria-label={`Удалить MCP-сервер ${name}`} onClick={() => void removeServer(name)}>
              Удалить
            </button>
          </div>
          <div className="c-sub" style={{ fontFamily: "var(--font-mono)" }}>
            {String(cfg.command ?? "")} {Array.isArray(cfg.args) ? (cfg.args as string[]).join(" ") : ""}
          </div>
        </div>
      ))}
      {Object.keys(servers).length === 0 && <div className="muted">MCP-серверы не настроены</div>}
      <RawJsonEditor name="mcp" onSaved={() => setReloadKey((k) => k + 1)} />
    </div>
  );
}

// ---------- models / custom endpoints ----------

interface ProviderCfg {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: { id: string; contextWindow?: number; reasoning?: boolean; [k: string]: unknown }[];
  [k: string]: unknown;
}

const API_TYPES = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];

function ProviderCard({
  name,
  cfg,
  onDelete,
}: {
  name: string;
  cfg: ProviderCfg;
  onDelete: () => void;
}) {
  const [probe, setProbe] = useState<string | null>(null);

  const check = async () => {
    if (!cfg.baseUrl) return;
    setProbe("…");
    const be = await getBackend();
    try {
      const url = cfg.baseUrl.replace(/\/$/, "") + "/models";
      const code = await be.invoke<string>("probe_url", { url });
      setProbe(`HTTP ${code} — эндпоинт отвечает`);
    } catch (e) {
      setProbe(String(e));
    }
  };

  return (
    <div className="card">
      <div className="row">
        <span className="c-title">{name}</span>
        {cfg.api && <span className="badge">{cfg.api}</span>}
        <div className="grow" />
        {cfg.baseUrl && (
          <button aria-label={`Проверить провайдер ${name}`} onClick={() => void check()} title="GET {baseUrl}/models">
            Проверить
          </button>
        )}
        <button className="danger" aria-label={`Удалить провайдер ${name}`} onClick={onDelete}>
          Удалить
        </button>
      </div>
      <div className="c-sub" style={{ fontFamily: "var(--font-mono)" }}>
        {cfg.baseUrl ?? "(baseUrl провайдера по умолчанию)"}
      </div>
      <div className="c-sub">
        {Array.isArray(cfg.models) && cfg.models.length > 0
          ? `Модели: ${cfg.models.map((m) => m.id).join(", ")}`
          : "Переопределение существующего провайдера (модели сохраняются)"}
      </div>
      {probe && <div className="c-sub" style={{ marginTop: 4 }}>{probe}</div>}
    </div>
  );
}

function AddProviderForm({ onAdd, existingNames }: { onAdd: (name: string, cfg: ProviderCfg) => Promise<boolean>; existingNames: string[] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [api, setApi] = useState("openai-completions");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState("");
  const [ctx, setCtx] = useState("");
  const [reasoning, setReasoning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button className="primary" onClick={() => setOpen(true)} style={{ marginBottom: 12 }}>
        + Добавить провайдер / эндпоинт
      </button>
    );
  }

  const validationError = providerDraftError({ name, baseUrl, models, contextWindow: ctx }, existingNames);

  const submit = async () => {
    const n = name.trim();
    if (validationError) {
      setError(validationError);
      return;
    }
    const ids = models
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const ctxNum = Number(ctx) || undefined;
    const cfg: ProviderCfg = {
      baseUrl: baseUrl.trim().replace(/\/$/, ""),
      api,
      apiKey: apiKey.trim() || "none",
      models: ids.map((id) => ({
        id,
        ...(ctxNum ? { contextWindow: ctxNum } : {}),
        ...(reasoning ? { reasoning: true } : {}),
      })),
    };
    if (!await onAdd(n, cfg)) return;
    setOpen(false);
    setName("");
    setBaseUrl("");
    setApiKey("");
    setModels("");
    setCtx("");
    setReasoning(false);
    setError(null);
  };

  return (
    <div className="card" style={{ borderColor: "var(--accent)" }}>
      <div className="c-title" style={{ marginBottom: 8 }}>Новый провайдер</div>
      <div className="form-row">
        <label>Имя (ключ в models.json)</label>
        <input aria-label="Имя нового провайдера" placeholder="my-remote" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} />
      </div>
      <div className="form-row">
        <label>Base URL</label>
        <input aria-label="Base URL нового провайдера" placeholder="https://llm.example.com/v1" value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setError(null); }} />
      </div>
      <div className="form-row">
        <label>API</label>
        <select aria-label="API нового провайдера" value={api} onChange={(e) => setApi(e.target.value)}>
          {API_TYPES.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label>API-ключ ($ENV_VAR или значение)</label>
        <input aria-label="API-ключ нового провайдера" placeholder="$MY_API_KEY (пусто = «none» для локальных)" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </div>
      <div className="form-row">
        <label>Модели (id через запятую)</label>
        <input aria-label="Модели нового провайдера" placeholder="qwen3-32b, llama3.1:8b" value={models} onChange={(e) => { setModels(e.target.value); setError(null); }} />
      </div>
      <div className="form-row">
        <label>Контекстное окно (токенов)</label>
        <input aria-label="Контекстное окно нового провайдера" type="number" min={1024} step={1024} placeholder="128000" value={ctx} onChange={(e) => { setCtx(e.target.value); setError(null); }} />
      </div>
      <div className="form-row">
        <label>Reasoning-модели</label>
        <input aria-label="Reasoning-модели нового провайдера" type="checkbox" style={{ flex: "none", width: 16 }} checked={reasoning} onChange={(e) => setReasoning(e.target.checked)} />
      </div>
      {(error || validationError) && <div className="c-sub" role="alert" style={{ color: "var(--danger)" }}>{error || validationError}</div>}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button onClick={() => setOpen(false)}>Отмена</button>
        <button className="primary" disabled={Boolean(validationError)} onClick={() => void submit()}>
          Добавить
        </button>
      </div>
    </div>
  );
}

function ModelsTab() {
  const [providers, setProviders] = useState<Record<string, ProviderCfg>>({});
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const be = await getBackend();
        const f = await be.invoke<ConfigFile>("read_pi_config", { name: "models" });
        const parsed = parseJsonObject(f.content, "models.json");
        const rawProviders = parsed.providers ?? {};
        if (!rawProviders || typeof rawProviders !== "object" || Array.isArray(rawProviders)) throw new Error("models.json: providers должен быть объектом");
        const entries = Object.entries(rawProviders);
        if (entries.some(([, value]) => !value || typeof value !== "object" || Array.isArray(value))) throw new Error("models.json: каждый провайдер должен быть объектом");
        setProviders(rawProviders as Record<string, ProviderCfg>);
        setError(null);
      } catch (readError) {
        setProviders({});
        setError(`Не удалось прочитать models.json: ${String(readError)}. Визуальный редактор не будет перезаписывать файл.`);
      }
    })();
  }, [reloadKey]);

  const mutateProviders = async (mutate: (current: Record<string, ProviderCfg>) => Record<string, ProviderCfg>): Promise<boolean> => {
    try {
      const be = await getBackend();
      const f = await be.invoke<ConfigFile>("read_pi_config", { name: "models" });
      const parsed = parseJsonObject(f.content, "models.json");
      const rawProviders = parsed.providers ?? {};
      if (!rawProviders || typeof rawProviders !== "object" || Array.isArray(rawProviders)) throw new Error("models.json: providers должен быть объектом");
      if (Object.values(rawProviders).some((value) => !value || typeof value !== "object" || Array.isArray(value))) throw new Error("models.json: каждый провайдер должен быть объектом");
      const current = rawProviders as Record<string, ProviderCfg>;
      const next = mutate(current);
      parsed.providers = next;
      await be.invoke("write_pi_config", { name: "models", content: JSON.stringify(parsed, null, 2) });
      setProviders(next);
      setError(null);
      setReloadKey((k) => k + 1);
      return true;
    } catch (writeError) {
      setError(`Не удалось сохранить models.json: ${String(writeError)}`);
      return false;
    }
  };

  const addProvider = async (name: string, cfg: ProviderCfg) => {
    return mutateProviders((current) => {
      if (Object.prototype.hasOwnProperty.call(current, name)) throw new Error(`Провайдер «${name}» уже существует.`);
      return { ...current, [name]: cfg };
    });
  };

  const removeProvider = async (name: string) => {
    try {
      const be = await getBackend();
      const settings = await be.invoke<ConfigFile>("read_pi_config", { name: "settings" });
      const defaults = parseJsonObject(settings.content, "settings.json") as { defaultProvider?: string };
      if (defaults.defaultProvider === name) {
        setError(`Нельзя удалить активный провайдер «${name}». Сначала выберите другой провайдер в разделе «Основные».`);
        return;
      }
      const ok = await confirmDialog(`Удалить провайдер «${name}» из models.json?`);
      if (!ok) return;
      await mutateProviders((current) => {
        const next = { ...current };
        delete next[name];
        return next;
      });
    } catch (removeError) {
      setError(`Не удалось проверить или удалить провайдер: ${String(removeError)}`);
    }
  };

  return (
    <div>
      <div className="hint" style={{ marginBottom: 12 }}>
        Кастомные эндпоинты (удалённые серверы, Ollama, vLLM, LM Studio, прокси) настраиваются здесь и попадают в{" "}
        <code>models.json</code>. Модели появятся в селекторе чата после перезапуска сессии.
      </div>
      {error && <div className="card" role="alert" style={{ borderColor: "var(--danger)", color: "var(--danger)", marginBottom: 10 }}>{error}</div>}
      <AddProviderForm onAdd={addProvider} existingNames={Object.keys(providers)} />
      {Object.entries(providers).map(([name, cfg]) => (
        <ProviderCard key={name} name={name} cfg={cfg} onDelete={() => void removeProvider(name)} />
      ))}
      {Object.keys(providers).length === 0 && <div className="muted">Кастомные провайдеры не настроены</div>}
      <RawJsonEditor name="models" onSaved={() => setReloadKey((k) => k + 1)} />
    </div>
  );
}

// ---------- app ----------

type AppearancePreset = "chatgpt" | "claude" | "gemini" | "custom";

const APPEARANCE_PRESETS: { id: AppearancePreset; label: string; color: string; color2?: string }[] = [
  { id: "chatgpt", label: "ChatGPT", color: "#10a37f" },
  { id: "claude", label: "Claude", color: "#d97757" },
  { id: "gemini", label: "Gemini", color: "#4e8cff", color2: "#9b72f2" },
  { id: "custom", label: "Custom color", color: "var(--brand)" },
];

const APP_ICON_BACKGROUND_OPTIONS: {
  id: string;
  label: string;
  color: string;
}[] = [
  { id: "midnight", label: "Midnight", color: "#171A24" },
  { id: "violet", label: "Violet", color: "#654FE8" },
  { id: "cobalt", label: "Cobalt", color: "#2563D9" },
  { id: "paper", label: "Paper", color: "#EEEAE0" },
];

type AppIconApplyStatus = { state: "applying" | "applied" | "error"; background: string; message?: string };

function MinimalAppIcon({ background }: { background: string }) {
  const foreground = appIconForeground(background);
  const clipId = `app-icon-${useId().replaceAll(":", "")}`;
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" data-app-icon-preview>
      <defs>
        <clipPath id={clipId}>
          <rect x="6.25" y="6.25" width="51.5" height="51.5" rx="11.56" />
        </clipPath>
      </defs>
      <rect data-app-icon-tile x="6.25" y="6.25" width="51.5" height="51.5" rx="11.56" fill={background} />
      <g clipPath={`url(#${clipId})`}>
        <path d="M6.25 6.25h51.5v13.63C46.75 12.31 32.63 9.13 18.19 10.44c-4.94.44-8.88 1.75-11.94 3.43V6.25Z" fill="#fff" opacity=".075" />
        <path d="M6.25 46.56c10.63 5.88 22.5 7.75 34.56 5.5 7.13-1.31 12.69-3.75 16.94-7v12.69H6.25V46.56Z" fill="#000" opacity=".12" />
      </g>
      <rect x="6.34" y="6.34" width="51.32" height="51.32" rx="11.47" fill="none" stroke="#fff" strokeWidth=".19" opacity=".18" />
      <rect x="18" y="22" width="28" height="6" rx="3" fill={foreground} />
      <path d="M22 27h5v15c0 2-1 3.5-2.5 3.5S22 44 22 42V27Zm15 0h5v15c0 2-1 3.5-2.5 3.5S37 44 37 42V27Z" fill={foreground} />
    </svg>
  );
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented-control" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? "active" : ""}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function GlassSwitch({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      className={`glass-switch ${checked ? "on" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function AppTab() {
  const appConfig = useStore((s) => s.appConfig);
  const [name, setName] = useDebouncedField(appConfig.displayName ?? "", (v) => void updateAppConfig({ displayName: v }));
  const appearancePreset = appConfig.appearancePreset ?? "chatgpt";
  const accentColor = appConfig.accentColor ?? "#8b5cf6";
  const iconColor = appConfig.iconColor ?? accentColor;
  const appIconBackground = resolveAppIconBackground(appConfig);
  const [appIconApplyStatus, setAppIconApplyStatus] = useState<AppIconApplyStatus | null>(null);
  const [configSaveError, setConfigSaveError] = useState<string | null>(null);
  useEffect(() => {
    const onStatus = (event: Event) => setAppIconApplyStatus((event as CustomEvent<AppIconApplyStatus>).detail);
    const onConfigStatus = (event: Event) => setConfigSaveError((event as CustomEvent<{ error: string | null }>).detail.error);
    window.addEventListener("pi:app-icon-status", onStatus);
    window.addEventListener("pi:app-config-status", onConfigStatus);
    return () => {
      window.removeEventListener("pi:app-icon-status", onStatus);
      window.removeEventListener("pi:app-config-status", onConfigStatus);
    };
  }, []);
  const setCustomAccent = (color: string) => void updateAppConfig({
    accentColor: color,
    appearancePreset: "custom",
    customTheme: appConfig.customTheme ? { ...appConfig.customTheme, accent: color } : appConfig.customTheme,
  });

  return (
    <div className="settings-page">
      {configSaveError && <div className="card" role="alert" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>{configSaveError}</div>}
      <SettingsGroup title="Приложение и runtime" description="Настройки сохраняются сразу; процессы пересчитываются без перезапуска UI">
      <div className="form-row">
        <label>Имя для приветствия <small>Стартовый экран</small></label>
        <input placeholder="Как к вам обращаться" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="form-row">
        <label>Внешний редактор <small>Открытие файлов и diff</small></label>
        <select aria-label="Внешний редактор" value={appConfig.editor} onChange={(e) => void updateAppConfig({ editor: e.target.value })}>
          <option value="code">VS Code</option>
          <option value="cursor">Cursor</option>
          <option value="windsurf">Windsurf</option>
          <option value="zed">Zed</option>
          <option value="subl">Sublime Text</option>
          <option value="idea">JetBrains IDEA</option>
        </select>
      </div>
      <div className="form-row">
        <label>Отправка сообщения <small>Перенос строки остаётся на второй комбинации</small></label>
        <SegmentedControl
          label="Горячая клавиша отправки"
          value={appConfig.sendKeyBehavior ?? "enter"}
          options={[
            { value: "enter", label: "Enter" },
            { value: "mod-enter", label: "⌘ Enter" },
          ]}
          onChange={(sendKeyBehavior) => void updateAppConfig({ sendKeyBehavior })}
        />
      </div>
      <div className="form-row">
        <label>Лимит агентов <small>1–8 параллельных процессов</small></label>
        <input
          type="number"
          aria-label="Лимит параллельных агентов"
          min={1}
          max={8}
          value={appConfig.processLimit}
          onChange={(e) => void updateAppConfig({ processLimit: Math.min(8, Math.max(1, Number(e.target.value) || 1)) })}
          disabled={appConfig.processLimitAuto === true}
        />
      </div>
      <div className="form-row">
        <label>Защита локального GPU <small>Один агент для localhost/Ollama/oMLX</small></label>
        <GlassSwitch
          label="Один агент для локальной модели"
          checked={appConfig.processLimitAuto !== false}
          onChange={(processLimitAuto) => void updateAppConfig({ processLimitAuto })}
        />
      </div>
      <div className="hint" style={{ marginTop: -4, marginBottom: 10 }}>
        Если models.json указывает localhost/ollama/oMLX, приложение использует один агент, чтобы процессы не конкурировали за GPU. Снимите флажок для ручного лимита.
      </div>
      <div className="form-row">
        <label>Sandbox агента <small>Применяется к новым процессам</small></label>
        <SegmentedControl
          label="Граница записи агента"
          value={appConfig.agentSandboxMode ?? "workspace-write"}
          options={[
            { value: "workspace-write", label: "Workspace write" },
            { value: "unrestricted", label: "Unrestricted" },
          ]}
          onChange={(agentSandboxMode) => void updateAppConfig({ agentSandboxMode })}
        />
      </div>
      <div className="hint" style={{ marginTop: -4, marginBottom: 10 }}>
        Workspace write разрешает чтение системы, но запись — только в текущий проект, хранилище сессий и временные worktree. Это защищает исходники skills и соседние репозитории от ошибочного tool call. На macOS ограничение наследуют все дочерние процессы агента.
      </div>
      <div className="form-row">
        <label>Idle agent timeout <small>Секунды до остановки</small></label>
        <input
          type="number"
          aria-label="Idle agent timeout в секундах"
          min={60}
          max={604800}
          step={60}
          value={appConfig.idleKillSecs}
          onChange={(e) =>
            void updateAppConfig({ idleKillSecs: Math.min(604800, Math.max(60, Number(e.target.value) || 900)) })
          }
        />
      </div>
      <div className="form-row">
        <label>Idle Preview timeout <small>0 отключает автоостановку</small></label>
        <input
          type="number"
          aria-label="Idle Preview timeout в секундах"
          min={0}
          max={604800}
          step={60}
          value={appConfig.previewIdleKillSecs ?? 600}
          onChange={(e) =>
            void updateAppConfig({ previewIdleKillSecs: Math.min(604800, Math.max(0, Number(e.target.value) || 0)) })
          }
        />
      </div>
      <div className="form-row">
        <label>Provider watchdog <small>Секунды, 0 — выключен</small></label>
        <input
          type="number"
          aria-label="Provider watchdog в секундах"
          min={0}
          max={86400}
          step={30}
          value={Math.round((appConfig.piRetryStallTimeoutMs ?? 0) / 1000)}
          onChange={(e) =>
            void updateAppConfig({
              piRetryStallTimeoutMs: Math.min(86400, Math.max(0, Number(e.target.value) || 0)) * 1000,
            })
          }
        />
      </div>
      <div className="hint">
        Расширение <code>@narumitw/pi-retry</code> обрывает и повторяет запрос, если поток от провайдера молчит дольше
        этого времени (в самом pi — 90с). Локальные reasoning-модели думают непредсказуемо долго, поэтому любой
        конечный таймаут рано или поздно ложно оборвёт размышление («Повтор после ошибки провайдера»). Поэтому по
        умолчанию <b>0 (выкл)</b> — снимается только stall-обрыв, прочие ретраи расширения работают. Ненулевое значение
        (напр. 300–600с) осмысленно для облачных провайдеров, где зависший стрим — обычно реальная сетевая проблема.
      </div>
      </SettingsGroup>
      <div className="settings-section-title">Внешний вид и motion</div>
      <section className="customization-panel" aria-label="Персонализация интерфейса">
        <div className="customization-head">
          <span className="customization-icon"><AppearanceIcon size={17} /></span>
          <div>
            <strong>Персонализация</strong>
            <span>Стиль применяется сразу ко всему приложению</span>
          </div>
        </div>

        <div className="theme-preset-grid" role="group" aria-label="Пресет оформления">
          {APPEARANCE_PRESETS.map((preset) => (
            <button
              type="button"
              key={preset.id}
              className={`theme-preset ${appearancePreset === preset.id ? "active" : ""}`}
              aria-pressed={appearancePreset === preset.id}
              onClick={() => void updateAppConfig({ appearancePreset: preset.id })}
            >
              <span
                className="theme-preset-swatch"
                style={{
                  background: preset.id === "custom"
                    ? accentColor
                    : preset.color2
                      ? `linear-gradient(135deg, ${preset.color}, ${preset.color2})`
                      : preset.color,
                }}
              />
              <span>{preset.label}</span>
              {appearancePreset === preset.id && <CheckIcon size={13} />}
            </button>
          ))}
        </div>

        <div className={`custom-color-row ${appearancePreset === "custom" ? "visible" : ""}`}>
          <div className="custom-color-control">
            <label htmlFor="custom-accent">Акцент кнопок</label>
            <span className="color-picker-shell" style={{ "--picker-color": accentColor } as CSSProperties}>
              <input
                id="custom-accent"
                type="color"
                value={accentColor}
                aria-label="Выбрать цвет кнопок"
                onChange={(e) => setCustomAccent(e.target.value)}
              />
            </span>
            <code>{accentColor.toUpperCase()}</code>
          </div>
          <div className="custom-color-control">
            <label htmlFor="custom-icons">Цвет иконок</label>
            <span className="color-picker-shell" style={{ "--picker-color": iconColor } as CSSProperties}>
              <input
                id="custom-icons"
                type="color"
                value={iconColor}
                aria-label="Выбрать цвет иконок"
                onChange={(e) => void updateAppConfig({ iconColor: e.target.value, appearancePreset: "custom" })}
              />
            </span>
            <code>{iconColor.toUpperCase()}</code>
          </div>
        </div>

        <div className="app-icon-style-section">
          <div className="app-icon-style-heading">
            <div>
              <strong>Фон иконки приложения</strong>
              <span>Минималистичный знак остаётся неизменным — выберите только фон</span>
            </div>
            <span className="app-icon-style-badge">Системный размер</span>
          </div>
          <div className="app-icon-style-grid" role="group" aria-label="Фон иконки приложения">
            {APP_ICON_BACKGROUND_OPTIONS.map((option) => {
              const active = appIconBackground === option.color;
              return (
                <button
                  type="button"
                  key={option.id}
                  className={`app-icon-style-card ${active ? "active" : ""}`}
                  aria-label={`Фон иконки: ${option.label}`}
                  aria-pressed={active}
                  onClick={() => void updateAppConfig({ appIconBackground: option.color })}
                >
                  <span className="app-icon-preview-shell">
                    <MinimalAppIcon background={option.color} />
                  </span>
                  <span className="app-icon-style-copy">
                    <strong>{option.label}</strong>
                    <small>{option.color}</small>
                  </span>
                  {active && <CheckIcon size={13} />}
                </button>
              );
            })}
          </div>
          <div className="app-icon-custom-row">
            <div>
              <strong>Свой цвет</strong>
              <span>Поддерживается любой фон; цвет знака подбирается по контрасту</span>
            </div>
            <label className="app-icon-color-picker" style={{ "--picker-color": appIconBackground } as CSSProperties}>
              <input
                type="color"
                value={appIconBackground}
                aria-label="Выбрать фон иконки приложения"
                onChange={(event) => void updateAppConfig({ appIconBackground: event.target.value.toUpperCase() })}
              />
              <span aria-hidden="true" />
              <code>{appIconBackground}</code>
            </label>
          </div>
          <div className={`app-icon-apply-status ${appIconApplyStatus?.state ?? "idle"}`} role="status" aria-live="polite">
            <span aria-hidden="true" />
            {!appIconApplyStatus && "Выбор применяется сразу и остаётся в Dock даже после выхода"}
            {appIconApplyStatus?.state === "applying" && "Применяем новую иконку…"}
            {appIconApplyStatus?.state === "applied" && "Иконка Dock обновлена и сохранена"}
            {appIconApplyStatus?.state === "error" && (appIconApplyStatus.message || "Не удалось обновить иконку Dock")}
          </div>
        </div>

        <div className="customization-row">
          <div>
            <strong>Режим</strong>
            <span>Системная, тёмная или светлая основа</span>
          </div>
          <SegmentedControl
            label="Тема приложения"
            value={appConfig.theme as "system" | "dark" | "light"}
            options={[
              { value: "system", label: "Auto" },
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
            ]}
            onChange={(theme) => void updateAppConfig({ theme })}
          />
        </div>

        <div className="customization-row">
          <div>
            <strong>Depth & cursor glow</strong>
            <span>Сдержанный blur панелей и световой отклик только под курсором</span>
          </div>
          <GlassSwitch
            label="Глубина панелей и контекстный cursor glow"
            checked={appConfig.visualEffects !== false}
            onChange={(visualEffects) => void updateAppConfig({ visualEffects })}
          />
        </div>

        <div className="customization-row">
          <div>
            <strong>Плотность</strong>
            <span>Больше воздуха или больше контента</span>
          </div>
          <SegmentedControl
            label="Плотность интерфейса"
            value={appConfig.interfaceDensity ?? "comfortable"}
            options={[
              { value: "comfortable", label: "Comfort" },
              { value: "compact", label: "Compact" },
            ]}
            onChange={(interfaceDensity) => void updateAppConfig({ interfaceDensity })}
          />
        </div>

        <div className="appearance-preview">
          <div className="preview-chat">
            <span className="preview-avatar"><UpdateIcon size={13} /></span>
            <span className="preview-answer">Готов помочь с проектом</span>
          </div>
          <div className="preview-composer">
            <span>Сообщение для Pi App…</span>
            <button type="button" tabIndex={-1} aria-hidden="true"><SendIcon size={13} /></button>
          </div>
          <span className="preview-caption">Live preview · contextual glow</span>
        </div>
      </section>
      <SettingsGroup title="Доступность и отображение" description="Масштаб применяется в реальном времени">
      <div className="form-row">
        <label>Масштаб интерфейса <small>⌘+ / ⌘− / ⌘0</small></label>
        <input
          type="range"
          aria-label="Масштаб интерфейса"
          min={0.7}
          max={1.6}
          step={0.1}
          value={appConfig.uiScale || 1}
          onChange={(e) => void updateAppConfig({ uiScale: Number(e.target.value) })}
        />
        <span className="hint" style={{ width: 44 }}>{Math.round((appConfig.uiScale || 1) * 100)}%</span>
      </div>
      <div className="hint">
        Псевдоним модели задаётся кнопкой ✎ прямо в селекторе модели. Он меняет только название в UI и аналитике — provider/model ID остаётся неизменным.
      </div>
      <div className="hint">
        Лимит агентов важен для локальных моделей: каждый агент — отдельный pi-процесс, который делит GPU с
        остальными. Idle-агенты убиваются автоматически; сессия возобновляется прозрачно при следующем сообщении.
      </div>
      </SettingsGroup>
    </div>
  );
}

// ---------- root ----------

export default function SettingsView() {
  const piInfo = useStore((s) => s.piInfo);
  const hasPi = Boolean(piInfo?.path);
  const tabs = ALL_TABS.filter((t) => hasPi || !t.needsPi);
  const [tab, setTab] = useState<Tab>("general");
  const effective = tabs.some((t) => t.id === tab) ? tab : "general";
  const currentTab = tabs.find((t) => t.id === effective) ?? tabs[0];

  return (
    <div className="chat">
      <div className="topbar" data-tauri-drag-region>
        <span className="title">Настройки</span>
        {!hasPi && <span className="sub" style={{ color: "var(--danger)" }}>pi не найден — доступны не все вкладки</span>}
      </div>
      <div className="view settings-view">
        <div className="settings-shell">
        <aside className="settings-nav" aria-label="Разделы настроек">
          {tabs.map((t) => (
            <button key={t.id} className={effective === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
              <span>{t.label}</span>
              <small>{t.desc}</small>
            </button>
          ))}
          <div className="settings-autosave"><CheckIcon size={13} /> Автосохранение включено</div>
        </aside>
        <main className="settings-content">
          <header className="settings-content-head">
            <div>
              <h2>{currentTab.label}</h2>
              <p>{currentTab.desc}</p>
            </div>
            <span className="realtime-pill"><span className="dot live" /> Live</span>
          </header>
        {effective === "general" && <GeneralTab />}
        {effective === "themes" && <ThemesTab />}
        {effective === "mcp" && <McpTab />}
        {effective === "models" && <ModelsTab />}
        {effective === "proc" && <ProcessesTab />}
        {effective === "app" && <AppTab />}
        </main>
        </div>
      </div>
    </div>
  );
}
