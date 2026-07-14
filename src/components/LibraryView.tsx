import { useCallback, useEffect, useState } from "react";
import { getBackend } from "../lib/backend";
import type { ConfigFile, PackageKind } from "../lib/types";
import { updateAppConfig, useStore } from "../state/store";
import Marketplace, { useInstalledPackages, useRunPi } from "./Marketplace";
import { CheckIcon, PackageIcon } from "./icons";

type LibraryTab = PackageKind | "profiles";

const COLLECTIONS: { id: LibraryTab; label: string; desc: string }[] = [
  { id: "extension", label: "Расширения", desc: "Инструменты и UI" },
  { id: "skill", label: "Skills", desc: "Инструкции модели" },
  { id: "theme", label: "Темы", desc: "TUI и палитры" },
  { id: "prompt", label: "Prompts", desc: "Команды и AGENTS.md" },
  { id: "profiles", label: "Профили", desc: "Готовые связки" },
];

const PROFILES = [
  {
    id: "minimal",
    name: "Minimal",
    desc: "Только разрешения и базовый harness. Минимальный стартовый контекст.",
    packages: ["@gotgenes/pi-permission-system"],
    context: "≈1.2K токенов",
    tone: "lean",
  },
  {
    id: "recommended",
    name: "Recommended",
    desc: "Web access, todo-first, ask-user и безопасные разрешения — ежедневный профиль pi-app.",
    packages: ["@gotgenes/pi-permission-system", "pi-web-access", "@juicesharp/rpiv-todo", "@juicesharp/rpiv-ask-user-question"],
    context: "≈4.8K токенов",
    tone: "recommended",
  },
  {
    id: "reviewer",
    name: "Reviewer",
    desc: "Добавляет структурное ревью и LSP feedback для больших изменений.",
    packages: ["@plannotator/pi-extension", "pi-lens"],
    context: "≈3.1K токенов",
    tone: "review",
  },
];

const REASONING_SERVER = {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
  lifecycle: "eager",
};

function useReasoningPreset(scope: "global" | "project", cwd: string | null) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async () => {
    const be = await getBackend();
    const file = scope === "project" && cwd
      ? await be.invoke<ConfigFile>("read_project_pi_config", { cwd, name: "mcp" })
      : await be.invoke<ConfigFile>("read_pi_config", { name: "mcp" });
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(file.content) as Record<string, unknown>; } catch { /* invalid config stays disabled */ }
    const servers = config.mcpServers && typeof config.mcpServers === "object"
      ? config.mcpServers as Record<string, unknown>
      : {};
    setEnabled(Object.prototype.hasOwnProperty.call(servers, "sequential-thinking"));
  }, [cwd, scope]);

  useEffect(() => { void read(); }, [read]);

  const setPreset = async (nextEnabled: boolean) => {
    if (scope === "project" && !cwd) return;
    setBusy(true);
    setError(null);
    try {
      const be = await getBackend();
      const file = scope === "project"
        ? await be.invoke<ConfigFile>("read_project_pi_config", { cwd, name: "mcp" })
        : await be.invoke<ConfigFile>("read_pi_config", { name: "mcp" });
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(file.content) as Record<string, unknown>;
      } catch {
        throw new Error(`${file.path} содержит невалидный JSON — исправьте его перед применением пресета`);
      }
      const servers = config.mcpServers && typeof config.mcpServers === "object"
        ? { ...config.mcpServers as Record<string, unknown> }
        : {};
      if (nextEnabled) servers["sequential-thinking"] = REASONING_SERVER;
      else delete servers["sequential-thinking"];
      const next = { ...config, mcpServers: servers };
      const content = JSON.stringify(next, null, 2) + "\n";
      if (scope === "project") await be.invoke("write_project_pi_config", { cwd, name: "mcp", content });
      else await be.invoke("write_pi_config", { name: "mcp", content });
      setEnabled(nextEnabled);
    } catch (presetError) {
      setError(String(presetError));
    } finally {
      setBusy(false);
    }
  };

  return { enabled, busy, error, setPreset };
}

function Profiles({ scope, cwd }: { scope: "global" | "project"; cwd: string | null }) {
  const { installed, reload } = useInstalledPackages(scope, cwd);
  const runner = useRunPi(reload);
  const reasoning = useReasoningPreset(scope, cwd);

  const installProfile = async (packages: string[]) => {
    for (const name of packages) {
      if (installed.has(name)) continue;
      await runner.runPi(["install", ...(scope === "project" ? ["-l"] : []), `npm:${name}`], scope === "project" ? cwd : null);
    }
  };

  return (
    <div className="profile-grid">
      {PROFILES.map((profile) => {
        const installedCount = profile.packages.filter((name) => installed.has(name)).length;
        const complete = installedCount === profile.packages.length;
        return (
          <article className={`profile-card ${profile.tone}`} key={profile.id}>
            <div className="profile-orb"><PackageIcon size={18} /></div>
            <div className="profile-copy">
              <div className="profile-title"><strong>{profile.name}</strong>{profile.id === "recommended" && <span className="badge update">Оптимальный</span>}</div>
              <p>{profile.desc}</p>
            </div>
            <div className="profile-metrics">
              <span>{profile.context}</span>
              <span>{profile.packages.length} пак.</span>
            </div>
            <div className="profile-packages">
              {profile.packages.map((name) => <code key={name} className={installed.has(name) ? "installed" : ""}>{installed.has(name) && <CheckIcon size={10} />}{name}</code>)}
            </div>
            <button className={complete ? "" : "primary"} disabled={complete || runner.running || (scope === "project" && !cwd)} onClick={() => void installProfile(profile.packages)}>
              {complete ? "Установлен" : installedCount > 0 ? `Доустановить ${profile.packages.length - installedCount}` : "Установить профиль"}
            </button>
          </article>
        );
      })}
      <article className="profile-card reasoning">
        <div className="profile-orb thought-profile-orb">Σ</div>
        <div className="profile-copy">
          <div className="profile-title"><strong>Local reasoning boost</strong><span className="badge">Опционально</span></div>
          <p>Sequential-thinking для архитектуры и сложных рефакторингов. Harness только предлагает его по узким триггерам — обычные ходы не замедляются.</p>
        </div>
        <div className="profile-metrics"><span>≈1.2K schema</span><span>eager после opt-in</span></div>
        <div className="profile-packages">
          <code className={installed.has("pi-mcp-adapter") ? "installed" : ""}>{installed.has("pi-mcp-adapter") && <CheckIcon size={10} />}pi-mcp-adapter</code>
          <code className={reasoning.enabled ? "installed" : ""}>{reasoning.enabled && <CheckIcon size={10} />}sequential-thinking MCP</code>
        </div>
        <button
          className={reasoning.enabled && installed.has("pi-mcp-adapter") ? "" : "primary"}
          disabled={reasoning.busy || runner.running || (scope === "project" && !cwd)}
          onClick={() => void (async () => {
            const active = reasoning.enabled && installed.has("pi-mcp-adapter");
            if (active) {
              await reasoning.setPreset(false);
              return;
            }
            if (!installed.has("pi-mcp-adapter")) {
              const ok = await runner.runPi(["install", ...(scope === "project" ? ["-l"] : []), "npm:pi-mcp-adapter"], scope === "project" ? cwd : null);
              if (!ok) return;
            }
            await reasoning.setPreset(true);
          })()}
        >
          {reasoning.enabled && installed.has("pi-mcp-adapter") ? "Выключить boost" : "Включить boost"}
        </button>
        {reasoning.error && <div className="profile-error">{reasoning.error}</div>}
      </article>
      {runner.log.length > 0 && <div className="console profile-console" ref={runner.logRef}>{runner.log.join("\n")}</div>}
    </div>
  );
}

export default function LibraryView() {
  const cwd = useStore((state) => state.currentCwd);
  const onboardingSeen = useStore((state) => state.appConfig.libraryOnboardingSeen === true);
  const [tab, setTab] = useState<LibraryTab>("extension");
  const [scope, setScope] = useState<"global" | "project">("global");
  const current = COLLECTIONS.find((item) => item.id === tab) ?? COLLECTIONS[0];

  return (
    <div className="chat library-view">
      <div className="topbar" data-tauri-drag-region><span className="title">Library</span><span className="sub">Экосистема pi.dev</span></div>
      <div className="view library-scroll">
        <header className="library-hero">
          <div><span className="eyebrow">PI ECOSYSTEM</span><h1>Инструменты, навыки и облик агента</h1><p>Четыре типа community-пакетов и готовые harness-профили — с явным scope и стоимостью контекста.</p></div>
          <div className="library-scope" role="group" aria-label="Область установки">
            <button className={scope === "global" ? "active" : ""} onClick={() => setScope("global")}>Все проекты</button>
            <button className={scope === "project" ? "active" : ""} disabled={!cwd} onClick={() => setScope("project")}>Текущий проект</button>
          </div>
        </header>
        {!onboardingSeen && (
          <section className="library-onboarding" aria-label="Знакомство с Library">
            <div className="profile-orb"><PackageIcon size={19} /></div>
            <div>
              <span className="eyebrow">ПЕРВЫЙ ЗАПУСК</span>
              <h2>Соберите окружение без лишнего контекста</h2>
              <p>Выберите scope, проверьте trust-бейдж и начните с Recommended. Любой тип ресурса можно отключить отдельно, не удаляя пакет.</p>
            </div>
            <div className="library-onboarding-actions">
              <button onClick={() => void updateAppConfig({ libraryOnboardingSeen: true })}>Пропустить</button>
              <button className="primary" onClick={() => { setTab("profiles"); void updateAppConfig({ libraryOnboardingSeen: true }); }}>Открыть профили</button>
            </div>
          </section>
        )}
        <div className="library-risk"><span>Безопасность</span> Extensions исполняют код с правами пользователя; Skills и Prompts меняют инструкции модели. Проверяйте repo перед установкой.</div>
        <nav className="library-tabs">
          {COLLECTIONS.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><span>{item.label}</span><small>{item.desc}</small></button>)}
        </nav>
        <main className="library-content">
          <div className="library-content-title"><div><h2>{current.label}</h2><p>{current.desc} · {scope === "project" ? cwd?.split("/").pop() : "глобально"}</p></div><span className="realtime-pill"><span className="dot live" /> Live</span></div>
          {tab === "profiles" ? <Profiles scope={scope} cwd={cwd} /> : (
            <Marketplace kind={tab} scope={scope} cwd={cwd} installHint={
              tab === "extension" ? "Расширения получают полный доступ к системе. Карточки с repo позволяют проверить исходники до установки."
                : tab === "skill" ? "Описание skill добавляется в стартовый контекст; держите активным только нужный набор."
                  : tab === "theme" ? "Темы устанавливаются в выбранный scope; редактор и экспорт доступны в Settings → Темы."
                    : "Prompt templates и AGENTS.md-пресеты для повторяемых рабочих процессов."
            } />
          )}
        </main>
      </div>
    </div>
  );
}
