import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { getBackend } from "../lib/backend";
import type { AppThemePalette, ConfigFile, PiInfo, PiThemeInfo, SkillInfo } from "../lib/types";
import { confirmDialog, messageDialog } from "../lib/dialog";
import { appIconForeground, applyAppThemePalette, applyAppearanceConfig, completePiThemeColors, paletteFromPiColors, resolveAppIconBackground } from "../lib/theme";
import { modelAliasKey } from "../lib/models";
import { updateAppConfig, useStore } from "../state/store";
import { ModelAvatarPicker } from "./AgentAvatar";
import Marketplace, { type Recommended } from "./Marketplace";
import { AppearanceIcon, CheckIcon, ErrorIcon, FolderIcon, RefreshIcon, SendIcon, UpdateIcon } from "./icons";

type Tab = "general" | "extensions" | "skills" | "themes" | "prompts" | "mcp" | "models" | "proc" | "app";

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
  const committed = useRef(value);
  useEffect(() => {
    // внешнее изменение (перечитали файл) — синхронизируем локальное значение
    if (value !== committed.current) {
      committed.current = value;
      setLocal(value);
    }
  }, [value]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const set = (v: string) => {
    setLocal(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      committed.current = v;
      commit(v);
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

  const refresh = useCallback(async () => {
    const be = await getBackend();
    setRows(await be.invoke<ProcStat[]>("process_stats").catch(() => []));
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const kill = async (r: ProcStat) => {
    const be = await getBackend();
    if (r.kind === "agent") await be.invoke("kill_agent", { agentId: r.id }).catch(() => {});
    else if (r.kind === "preview") await be.invoke("preview_stop", { serverId: r.id }).catch(() => {});
    void refresh();
  };

  const total = (rows ?? []).reduce((n, r) => n + r.rssMb, 0);

  return (
    <div>
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
            <button onClick={() => void kill(r)} title={r.kind === "agent" ? "Остановить агента" : "Остановить dev-сервер"}>
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
      JSON.parse(t);
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

function useSettingsJson(): [PiSettings | null, (patch: Partial<PiSettings>) => Promise<void>, () => Promise<void>] {
  const [parsed, setParsed] = useState<PiSettings | null>(null);

  const reload = useCallback(async () => {
    const be = await getBackend();
    const f = await be.invoke<ConfigFile>("read_pi_config", { name: "settings" });
    try {
      setParsed(JSON.parse(f.content) as PiSettings);
    } catch {
      setParsed(null);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const update = useCallback(async (patch: Partial<PiSettings>) => {
    const be = await getBackend();
    // перечитать перед записью, чтобы не затереть внешние изменения
    const f = await be.invoke<ConfigFile>("read_pi_config", { name: "settings" });
    let latest: PiSettings = {};
    try {
      latest = JSON.parse(f.content) as PiSettings;
    } catch {
      /* повреждённый файл перезапишем патчем */
    }
    const next = { ...latest, ...patch };
    setParsed(next);
    await be.invoke("write_pi_config", { name: "settings", content: JSON.stringify(next, null, 2) }).catch(() => {});
  }, []);

  return [parsed, update, reload];
}

// ---------- general ----------

function GeneralTab() {
  const [parsed, update, reload] = useSettingsJson();
  const [modelCatalog, setModelCatalog] = useState<Record<string, { models?: { id?: string }[] }>>({});
  const compaction = parsed?.compaction ?? {};
  const compactionEnabled = compaction.enabled !== false;
  const [prov, setProv] = useDebouncedField(String(parsed?.defaultProvider ?? ""), (v) => void update({ defaultProvider: v }));
  const [model, setModel] = useDebouncedField(String(parsed?.defaultModel ?? ""), (v) => void update({ defaultModel: v }));
  const [tuiTheme, setTuiTheme] = useDebouncedField(String(parsed?.theme ?? ""), (v) => void update({ theme: v }));

  useEffect(() => {
    void (async () => {
      const be = await getBackend();
      const file = await be.invoke<ConfigFile>("read_pi_config", { name: "models" }).catch(() => null);
      try {
        const next = JSON.parse(file?.content ?? "{}") as { providers?: Record<string, { models?: { id?: string }[] }> };
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

      {parsed && (
        <>
          <SettingsGroup title="Новая сессия" description="Применяется автоматически при следующем запуске агента">
          <div className="form-row">
            <label>Провайдер <small>Ключ из models.json</small></label>
            <select aria-label="Провайдер по умолчанию" value={prov} onChange={(e) => setProv(e.target.value)}>
              {providerOptions.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
            </select>
          </div>
          <div className="form-row">
            <label>Модель <small>Runtime ID, без UI-псевдонима</small></label>
            <select aria-label="Модель по умолчанию" value={model} onChange={(e) => setModel(e.target.value)}>
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
            <select aria-label="Тема pi TUI" value={tuiTheme} onChange={(e) => setTuiTheme(e.target.value)}>
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

// ---------- extensions marketplace (pi.dev community catalog) ----------

/** Расширения, на которые опирается функциональность самого клиента. */
const RECOMMENDED_EXTENSIONS: Recommended[] = [
  {
    pkg: "npm:@gotgenes/pi-permission-system",
    name: "pi-permission-system",
    desc: "Права на инструменты: без него не работают режимы Ask / Accept edits / Auto / Bypass в чате.",
  },
  {
    pkg: "npm:@plannotator/pi-extension",
    name: "plannotator",
    desc: "Plan mode: агент сначала составляет план с аннотациями, затем правит код (/plannotator).",
  },
  {
    pkg: "npm:@tintinweb/pi-subagents",
    name: "pi-subagents",
    desc: "Очередь фоновых агентов, worktree-изоляция, steering и session-scoped расписания.",
  },
];

/** Рекомендуемое ядро (ROADMAP §5.9): пакеты вне списка — кандидаты в per-workspace.
 *  Матчинг по подстроке, чтобы покрыть и npm-имена, и локальные пути. */
const CORE_PACKAGES = [
  "pi-mcp-adapter",
  "rpiv-todo",
  "rpiv-ask-user-question",
  "pi-permission-system",
  "pi-claude-style-tools",
  "pi-retry",
  "pi-statusline",
  "plannotator",
  "harness",
  "pi-web-access", // возвращён в ядро (H4): без него модель не может в web-факты
  "pi-subagents",
  "DietrichGebert/ponytail", // официальный git-пакет; full policy инъектируется перед каждым model turn
];

/** Грубая оценка токенов текста (≈4 символа/токен для английских описаний). */
function estTokens(s: string): number {
  return Math.max(1, Math.round(s.length / 4));
}

function ExtensionsTab() {
  const [pkgs, setPkgs] = useState<string[] | null>(null);

  useEffect(() => {
    void (async () => {
      const be = await getBackend();
      const f = await be.invoke<ConfigFile>("read_pi_config", { name: "settings" }).catch(() => null);
      try {
        setPkgs((JSON.parse(f?.content ?? "{}").packages ?? []) as string[]);
      } catch {
        setPkgs([]);
      }
    })();
  }, []);

  const extras = (pkgs ?? []).filter((p) => !CORE_PACKAGES.some((c) => p.includes(c)));

  return (
    <div>
      {pkgs != null && pkgs.length > 0 && (
        <div className="card" style={{ padding: "10px 12px", marginBottom: 12 }}>
          <div className="c-title" style={{ fontSize: 13 }}>
            Куратор окружения: {pkgs.length} глобальных пакетов · {extras.length} вне рекомендуемого ядра
          </div>
          {extras.length > 0 ? (
            <div className="c-sub">
              Каждое расширение добавляет свои инструкции в стартовый промпт каждой сессии («fewest tools
              wins» для локальной 35B). Кандидаты на перенос в проектный <code>.pi/settings.json</code>:{" "}
              {extras.join(", ")}. Обоснование — docs/ROADMAP.md §5.9.
            </div>
          ) : (
            <div className="c-sub">Все пакеты в пределах рекомендуемого ядра pi-app.</div>
          )}
        </div>
      )}
      <Marketplace
        kind="extension"
        recommended={RECOMMENDED_EXTENSIONS}
        installHint="Маркетплейс сообщества pi.dev. Установка выполняет «pi install»; изменения подхватываются новыми сессиями агента."
      />
    </div>
  );
}

// ---------- skills marketplace + locally installed ----------

function SkillsTab() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const editor = useStore((s) => s.appConfig.editor);

  useEffect(() => {
    void (async () => {
      const be = await getBackend();
      setSkills(await be.invoke<SkillInfo[]>("list_skills").catch(() => []));
    })();
  }, []);

  const open = async (path: string) => {
    const be = await getBackend();
    await be.invoke("open_in_editor", { editor, path, line: null }).catch(() => {});
  };

  const grouped = skills.reduce<Record<string, SkillInfo[]>>((acc, s) => {
    (acc[s.sourceDir] ??= []).push(s);
    return acc;
  }, {});

  return (
    <div>
      <Marketplace
        kind="skill"
        installHint="Skills-пакеты из маркетплейса pi.dev. Ниже — skills, уже установленные локально в ваших каталогах."
      />
      <div className="section-title" style={{ padding: "16px 2px 6px" }}>
        Установленные локально · {skills.length}
        {skills.length > 0 &&
          ` · описания ≈ ${skills.reduce((n, s) => n + estTokens(s.name + s.description), 0)} ток. в каждом системном промпте`}
      </div>
      <div className="hint" style={{ marginBottom: 10 }}>
        Каталоги skills настраиваются в settings.json → «skills» (вкладка «Общие»). Описание каждого скилла
        pi кладёт в стартовый промпт целиком — длинные описания стоят токенов в каждой сессии.
      </div>
      {Object.entries(grouped).map(([dir, list]) => (
        <div key={dir}>
          <div className="section-title" style={{ padding: "10px 2px 6px" }}>
            {dir} · {list.length}
          </div>
          {list.map((s) => (
            <div key={s.path} className="card click" style={{ padding: "8px 12px" }} onClick={() => void open(s.path)}>
              <div className="c-title" style={{ fontSize: 13 }}>
                {s.name}
                <span className="muted" style={{ fontWeight: 400, fontSize: 11, marginLeft: 8 }}>
                  ≈{estTokens(s.name + s.description)} ток.
                </span>
              </div>
              {s.description && <div className="c-sub">{s.description}</div>}
            </div>
          ))}
        </div>
      ))}
      {skills.length === 0 && <div className="muted">Локальные skills не найдены</div>}
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

  const load = useCallback(async () => {
    const be = await getBackend();
    setThemes(await be.invoke<PiThemeInfo[]>("list_pi_themes", { cwd }).catch(() => []));
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

  const writeActiveTheme = async (name: string) => {
    const be = await getBackend();
    const file = await be.invoke<ConfigFile>("read_pi_config", { name: "settings" });
    const settings = JSON.parse(file.content || "{}") as Record<string, unknown>;
    settings.theme = name;
    await be.invoke("write_pi_config", { name: "settings", content: JSON.stringify(settings, null, 2) });
  };

  const applyInstalled = async (theme: PiThemeInfo) => {
    const palette = paletteFromPiColors(theme.name, theme.resolvedColors);
    await writeActiveTheme(theme.name);
    await updateAppConfig({ appearancePreset: "custom", accentColor: palette.accent, customTheme: palette });
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
      await writeActiveTheme(draft.name);
      await updateAppConfig({ appearancePreset: "custom", accentColor: previewPalette.accent, customTheme: previewPalette });
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
            <select value={scope} onChange={(event) => setScope(event.target.value as "global" | "project")}>
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

function PromptsTab() {
  return (
    <Marketplace
      kind="prompt"
      installHint="Prompt- и AGENTS.md-пакеты сообщества. После установки пресет доступен новым сессиям; держите активным только нужный набор, чтобы не раздувать системный контекст."
    />
  );
}

// ---------- MCP ----------

function McpTab() {
  const [servers, setServers] = useState<Record<string, Record<string, unknown>>>({});
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    void (async () => {
      const be = await getBackend();
      const f = await be.invoke<ConfigFile>("read_pi_config", { name: "mcp" });
      try {
        const parsed = JSON.parse(f.content) as { mcpServers?: Record<string, Record<string, unknown>> };
        setServers(parsed.mcpServers ?? {});
      } catch {
        setServers({});
      }
    })();
  }, [reloadKey]);

  const removeServer = async (name: string) => {
    if (!(await confirmDialog(`Удалить MCP-сервер «${name}» из mcp.json?`))) return;
    const be = await getBackend();
    const f = await be.invoke<ConfigFile>("read_pi_config", { name: "mcp" });
    const parsed = JSON.parse(f.content) as { mcpServers?: Record<string, unknown> };
    if (parsed.mcpServers) delete parsed.mcpServers[name];
    await be.invoke("write_pi_config", { name: "mcp", content: JSON.stringify(parsed, null, 2) });
    setReloadKey((k) => k + 1);
  };

  return (
    <div>
      {Object.entries(servers).map(([name, cfg]) => (
        <div key={name} className="card">
          <div className="row">
            <span className="c-title">{name}</span>
            <span className="badge">{String(cfg.lifecycle ?? "eager")}</span>
            <div className="grow" />
            <button className="danger" onClick={() => void removeServer(name)}>
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
          <button onClick={() => void check()} title="GET {baseUrl}/models">
            Проверить
          </button>
        )}
        <button className="danger" onClick={onDelete}>
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

function AddProviderForm({ onAdd }: { onAdd: (name: string, cfg: ProviderCfg) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [api, setApi] = useState("openai-completions");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState("");
  const [ctx, setCtx] = useState("");
  const [reasoning, setReasoning] = useState(false);

  if (!open) {
    return (
      <button className="primary" onClick={() => setOpen(true)} style={{ marginBottom: 12 }}>
        + Добавить провайдер / эндпоинт
      </button>
    );
  }

  const submit = () => {
    const n = name.trim();
    if (!n || !baseUrl.trim()) return;
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
    onAdd(n, cfg);
    setOpen(false);
    setName("");
    setBaseUrl("");
    setApiKey("");
    setModels("");
    setCtx("");
    setReasoning(false);
  };

  return (
    <div className="card" style={{ borderColor: "var(--accent)" }}>
      <div className="c-title" style={{ marginBottom: 8 }}>Новый провайдер</div>
      <div className="form-row">
        <label>Имя (ключ в models.json)</label>
        <input placeholder="my-remote" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="form-row">
        <label>Base URL</label>
        <input placeholder="https://llm.example.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      </div>
      <div className="form-row">
        <label>API</label>
        <select value={api} onChange={(e) => setApi(e.target.value)}>
          {API_TYPES.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label>API-ключ ($ENV_VAR или значение)</label>
        <input placeholder="$MY_API_KEY (пусто = «none» для локальных)" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </div>
      <div className="form-row">
        <label>Модели (id через запятую)</label>
        <input placeholder="qwen3-32b, llama3.1:8b" value={models} onChange={(e) => setModels(e.target.value)} />
      </div>
      <div className="form-row">
        <label>Контекстное окно (токенов)</label>
        <input type="number" placeholder="128000" value={ctx} onChange={(e) => setCtx(e.target.value)} />
      </div>
      <div className="form-row">
        <label>Reasoning-модели</label>
        <input type="checkbox" style={{ flex: "none", width: 16 }} checked={reasoning} onChange={(e) => setReasoning(e.target.checked)} />
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button onClick={() => setOpen(false)}>Отмена</button>
        <button className="primary" disabled={!name.trim() || !baseUrl.trim()} onClick={submit}>
          Добавить
        </button>
      </div>
    </div>
  );
}

function ModelsTab() {
  const [providers, setProviders] = useState<Record<string, ProviderCfg>>({});
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    void (async () => {
      const be = await getBackend();
      const f = await be.invoke<ConfigFile>("read_pi_config", { name: "models" });
      try {
        const parsed = JSON.parse(f.content) as { providers?: Record<string, ProviderCfg> };
        setProviders(parsed.providers ?? {});
      } catch {
        setProviders({});
      }
    })();
  }, [reloadKey]);

  const writeProviders = async (next: Record<string, ProviderCfg>) => {
    const be = await getBackend();
    const f = await be.invoke<ConfigFile>("read_pi_config", { name: "models" });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(f.content) as Record<string, unknown>;
    } catch {
      /* повреждённый файл пересоберём */
    }
    parsed.providers = next;
    await be.invoke("write_pi_config", { name: "models", content: JSON.stringify(parsed, null, 2) });
    setReloadKey((k) => k + 1);
  };

  const addProvider = (name: string, cfg: ProviderCfg) => {
    void writeProviders({ ...providers, [name]: cfg });
  };

  const removeProvider = (name: string) => {
    void confirmDialog(`Удалить провайдер «${name}» из models.json?`).then((ok) => {
      if (!ok) return;
      const next = { ...providers };
      delete next[name];
      void writeProviders(next);
    });
  };

  return (
    <div>
      <div className="hint" style={{ marginBottom: 12 }}>
        Кастомные эндпоинты (удалённые серверы, Ollama, vLLM, LM Studio, прокси) настраиваются здесь и попадают в{" "}
        <code>models.json</code>. Модели появятся в селекторе чата после перезапуска сессии.
      </div>
      <AddProviderForm onAdd={addProvider} />
      {Object.entries(providers).map(([name, cfg]) => (
        <ProviderCard key={name} name={name} cfg={cfg} onDelete={() => removeProvider(name)} />
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
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <rect x="5" y="5" width="54" height="54" rx="13" fill={background} />
      <path d="M5 5h54v15C47 12 32 9 18 11 12 12 8 14 5 16V5Z" fill="#fff" opacity=".075" />
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
  useEffect(() => {
    const onStatus = (event: Event) => setAppIconApplyStatus((event as CustomEvent<AppIconApplyStatus>).detail);
    window.addEventListener("pi:app-icon-status", onStatus);
    return () => window.removeEventListener("pi:app-icon-status", onStatus);
  }, []);
  const setCustomAccent = (color: string) => void updateAppConfig({
    accentColor: color,
    appearancePreset: "custom",
    customTheme: appConfig.customTheme ? { ...appConfig.customTheme, accent: color } : appConfig.customTheme,
  });

  return (
    <div className="settings-page">
      <SettingsGroup title="Приложение и runtime" description="Настройки сохраняются сразу; процессы пересчитываются без перезапуска UI">
      <div className="form-row">
        <label>Имя для приветствия <small>Стартовый экран</small></label>
        <input placeholder="Как к вам обращаться" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="form-row">
        <label>Внешний редактор <small>Открытие файлов и diff</small></label>
        <select value={appConfig.editor} onChange={(e) => void updateAppConfig({ editor: e.target.value })}>
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
          min={1}
          max={8}
          value={appConfig.processLimit}
          onChange={(e) => void updateAppConfig({ processLimit: Math.max(1, Number(e.target.value) || 1) })}
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
          min={60}
          step={60}
          value={appConfig.idleKillSecs}
          onChange={(e) => void updateAppConfig({ idleKillSecs: Math.max(60, Number(e.target.value) || 900) })}
        />
      </div>
      <div className="form-row">
        <label>Idle Preview timeout <small>0 отключает автоостановку</small></label>
        <input
          type="number"
          min={0}
          step={60}
          value={appConfig.previewIdleKillSecs ?? 600}
          onChange={(e) => void updateAppConfig({ previewIdleKillSecs: Math.max(0, Number(e.target.value) || 0) })}
        />
      </div>
      <div className="form-row">
        <label>Provider watchdog <small>Секунды, 0 — выключен</small></label>
        <input
          type="number"
          min={0}
          step={30}
          value={Math.round((appConfig.piRetryStallTimeoutMs ?? 0) / 1000)}
          onChange={(e) =>
            void updateAppConfig({ piRetryStallTimeoutMs: Math.max(0, Number(e.target.value) || 0) * 1000 })
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
            {!appIconApplyStatus && "Выбор применяется к Dock сразу и сохраняется после перезапуска"}
            {appIconApplyStatus?.state === "applying" && "Применяем новую иконку…"}
            {appIconApplyStatus?.state === "applied" && "Иконка Dock обновлена"}
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
        {effective === "extensions" && <ExtensionsTab />}
        {effective === "skills" && <SkillsTab />}
        {effective === "themes" && <ThemesTab />}
        {effective === "prompts" && <PromptsTab />}
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
