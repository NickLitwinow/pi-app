import { useCallback, useEffect, useRef, useState } from "react";
import { getBackend } from "../lib/backend";
import type { ConfigFile, PiInfo, SkillInfo } from "../lib/types";
import { confirmDialog } from "../lib/dialog";
import { openExternalUrl, updateAppConfig, useStore } from "../state/store";
import { CheckIcon, ErrorIcon, FolderIcon, RefreshIcon } from "./icons";

type Tab = "general" | "extensions" | "skills" | "mcp" | "models" | "app";

const ALL_TABS: { id: Tab; label: string; needsPi: boolean }[] = [
  { id: "general", label: "Общие", needsPi: false },
  { id: "extensions", label: "Расширения", needsPi: true },
  { id: "skills", label: "Skills", needsPi: true },
  { id: "mcp", label: "MCP", needsPi: true },
  { id: "models", label: "Модели и эндпоинты", needsPi: true },
  { id: "app", label: "Приложение", needsPi: false },
];

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
    <div style={{ marginTop: 16 }}>
      <div className="row" style={{ marginBottom: 6 }}>
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
  const compaction = parsed?.compaction ?? {};
  const compactionEnabled = compaction.enabled !== false;

  return (
    <div>
      <PiInstallCard />

      {parsed && (
        <>
          <div className="section-title" style={{ padding: "12px 2px 8px" }}>Значения по умолчанию</div>
          <div className="form-row">
            <label>Провайдер по умолчанию</label>
            <input
              value={String(parsed.defaultProvider ?? "")}
              onChange={(e) => void update({ defaultProvider: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label>Модель по умолчанию</label>
            <input
              value={String(parsed.defaultModel ?? "")}
              onChange={(e) => void update({ defaultModel: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label>Thinking по умолчанию</label>
            <select
              value={String(parsed.defaultThinkingLevel ?? "high")}
              onChange={(e) => void update({ defaultThinkingLevel: e.target.value })}
            >
              {["off", "minimal", "low", "medium", "high", "xhigh"].map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>Тема pi (TUI)</label>
            <input value={String(parsed.theme ?? "")} onChange={(e) => void update({ theme: e.target.value })} />
          </div>

          <div className="section-title" style={{ padding: "12px 2px 8px" }}>Компакция контекста</div>
          <div className="form-row">
            <label>Авто-компакция при заполнении окна</label>
            <select
              value={compactionEnabled ? "on" : "off"}
              onChange={(e) => void update({ compaction: { ...compaction, enabled: e.target.value === "on" } })}
            >
              <option value="on">Включена (как в Claude Desktop)</option>
              <option value="off">Выключена (только ручной compact)</option>
            </select>
          </div>
          <div className="form-row">
            <label>Резерв под ответ модели (reserveTokens)</label>
            <input
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
            <label>Свежий контекст без сжатия (keepRecentTokens)</label>
            <input
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
        </>
      )}

      <RawJsonEditor name="settings" onSaved={() => void reload()} />
    </div>
  );
}

// ---------- extensions (packages + рекомендуемые) ----------

/** Расширения, на которые опирается функциональность самого клиента. */
const RECOMMENDED_EXTENSIONS: { pkg: string; name: string; desc: string }[] = [
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
    pkg: "npm:pi-rewind",
    name: "pi-rewind",
    desc: "Снапшоты файлов на каждый ход: «Откатить сюда» у сообщений возвращает не только диалог, но и код.",
  },
];

function useRunPi(onDone?: () => void) {
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const runPi = async (args: string[]) => {
    setRunning(true);
    setLog((l) => [...l, `$ pi ${args.join(" ")}`]);
    const be = await getBackend();
    let un: (() => void) | null = null;
    try {
      // subscribe before starting so fast-finishing runs are not missed
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
          finish();
        } else if (p.line) {
          setLog((l) => [...l.slice(-400), String(p.line)]);
        }
      };
      un = await be.listen("pi-cli-output", handle);
      runId = await be.invoke<string>("pi_cli_run", { args });
      for (const p of buffered.splice(0)) handle(p);
      await donePromise;
    } catch (e) {
      setLog((l) => [...l, `ошибка: ${String(e)}`]);
    } finally {
      un?.();
      setRunning(false);
      onDone?.();
    }
  };

  return { log, running, runPi, logRef };
}

function ExtensionsTab() {
  const [parsed, , reload] = useSettingsJson();
  const [newPkg, setNewPkg] = useState("");
  const { log, running, runPi, logRef } = useRunPi(() => void reload());
  const packages = Array.isArray(parsed?.packages) ? parsed.packages : [];

  const missing = RECOMMENDED_EXTENSIONS.filter((r) => !packages.includes(r.pkg));

  return (
    <div>
      {missing.length > 0 && (
        <>
          <div className="section-title" style={{ padding: "2px 2px 8px" }}>
            Рекомендуемые (используются этим клиентом)
          </div>
          {missing.map((r) => (
            <div key={r.pkg} className="card">
              <div className="row">
                <span className="c-title">{r.name}</span>
                <span className="badge">не установлено</span>
                <div className="grow" />
                <button className="primary" disabled={running} onClick={() => void runPi(["install", r.pkg])}>
                  Установить
                </button>
              </div>
              <div className="c-sub">{r.desc}</div>
              <div className="c-sub" style={{ fontFamily: "var(--font-mono)" }}>{r.pkg}</div>
            </div>
          ))}
        </>
      )}

      <div className="section-title" style={{ padding: "10px 2px 8px" }}>Установленные пакеты · {packages.length}</div>
      <div className="row" style={{ marginBottom: 12 }}>
        <input
          className="grow"
          placeholder="npm:имя-пакета или git-URL…"
          value={newPkg}
          onChange={(e) => setNewPkg(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && newPkg.trim() && void runPi(["install", newPkg.trim()])}
        />
        <button className="primary" disabled={running || !newPkg.trim()} onClick={() => void runPi(["install", newPkg.trim()])}>
          Установить
        </button>
        <button disabled={running} onClick={() => void runPi(["update", "--all"])}>
          Обновить всё
        </button>
      </div>

      {packages.map((p) => {
        const rec = RECOMMENDED_EXTENSIONS.find((r) => r.pkg === p);
        return (
          <div key={p} className="card" style={{ padding: "8px 12px" }}>
            <div className="row">
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{p}</span>
              {rec && <span className="badge green">используется клиентом</span>}
              <div className="grow" />
              {p.startsWith("npm:") && (
                <button
                  className="hint"
                  title="Открыть на npmjs.com"
                  onClick={() => void openExternalUrl(`https://www.npmjs.com/package/${p.slice(4)}`)}
                >
                  npm ↗
                </button>
              )}
              <button className="danger" disabled={running} onClick={() => void runPi(["remove", p])}>
                Удалить
              </button>
            </div>
            {rec && <div className="c-sub">{rec.desc}</div>}
          </div>
        );
      })}
      {packages.length === 0 && <div className="muted">Пакеты не установлены</div>}

      {log.length > 0 && (
        <div className="console" ref={logRef} style={{ marginTop: 14 }}>
          {log.join("\n")}
        </div>
      )}
    </div>
  );
}

// ---------- skills ----------

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
      <div className="hint" style={{ marginBottom: 10 }}>
        Каталоги skills настраиваются в settings.json → «skills» (вкладка «Общие»).
      </div>
      {Object.entries(grouped).map(([dir, list]) => (
        <div key={dir}>
          <div className="section-title" style={{ padding: "10px 2px 6px" }}>
            {dir} · {list.length}
          </div>
          {list.map((s) => (
            <div key={s.path} className="card click" style={{ padding: "8px 12px" }} onClick={() => void open(s.path)}>
              <div className="c-title" style={{ fontSize: 13 }}>{s.name}</div>
              {s.description && <div className="c-sub">{s.description}</div>}
            </div>
          ))}
        </div>
      ))}
      {skills.length === 0 && <div className="muted">Skills не найдены</div>}
    </div>
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

function AppTab() {
  const appConfig = useStore((s) => s.appConfig);

  return (
    <div>
      <div className="form-row">
        <label>Внешний редактор</label>
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
        <label>Лимит одновременных агентов</label>
        <input
          type="number"
          min={1}
          max={8}
          value={appConfig.processLimit}
          onChange={(e) => void updateAppConfig({ processLimit: Math.max(1, Number(e.target.value) || 1) })}
        />
      </div>
      <div className="form-row">
        <label>Останавливать простаивающего агента через (сек)</label>
        <input
          type="number"
          min={60}
          step={60}
          value={appConfig.idleKillSecs}
          onChange={(e) => void updateAppConfig({ idleKillSecs: Math.max(60, Number(e.target.value) || 900) })}
        />
      </div>
      <div className="form-row">
        <label>Тема приложения</label>
        <select value={appConfig.theme} onChange={(e) => void updateAppConfig({ theme: e.target.value })}>
          <option value="system">Как в системе</option>
          <option value="dark">Тёмная</option>
          <option value="light">Светлая</option>
        </select>
      </div>
      <div className="form-row">
        <label>Масштаб интерфейса (⌘+ / ⌘− / ⌘0)</label>
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
      <div className="hint" style={{ marginTop: 16 }}>
        Лимит агентов важен для локальных моделей: каждый агент — отдельный pi-процесс, который делит GPU с
        остальными. Idle-агенты убиваются автоматически; сессия возобновляется прозрачно при следующем сообщении.
      </div>
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

  return (
    <div className="chat">
      <div className="topbar" data-tauri-drag-region>
        <span className="title">Настройки</span>
        {!hasPi && <span className="sub" style={{ color: "var(--danger)" }}>pi не найден — доступны не все вкладки</span>}
      </div>
      <div className="view">
        <div className="tabs">
          {tabs.map((t) => (
            <button key={t.id} className={effective === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {effective === "general" && <GeneralTab />}
        {effective === "extensions" && <ExtensionsTab />}
        {effective === "skills" && <SkillsTab />}
        {effective === "mcp" && <McpTab />}
        {effective === "models" && <ModelsTab />}
        {effective === "app" && <AppTab />}
      </div>
    </div>
  );
}
