// Backend abstraction ("SessionDriver"): the UI talks only to this interface.
// In Tauri it maps to invoke/listen; in a plain browser (vite preview) a mock
// backend with scripted demo data keeps the whole UI usable for development.

import type {
  AnalyticsOverview,
  AppConfig,
  ConfigFile,
  LaunchConfig,
  PackageSearch,
  PiInfo,
  PiPackage,
  PreviewHandle,
  ProjectInfo,
  SessionMeta,
  SkillInfo,
} from "./types";

export interface Backend {
  isMock: boolean;
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen(event: string, handler: (payload: Record<string, unknown>) => void): Promise<() => void>;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// ---------- real backend ----------

async function makeTauriBackend(): Promise<Backend> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  return {
    isMock: false,
    invoke: (cmd, args) => invoke(cmd, args),
    listen: async (event, handler) => {
      const un = await listen(event, (e) => handler(e.payload as Record<string, unknown>));
      return un;
    },
  };
}

// ---------- mock backend (browser preview / UI development) ----------

type Handler = (payload: Record<string, unknown>) => void;

class MockBackend implements Backend {
  isMock = true;
  private handlers = new Map<string, Set<Handler>>();
  private agentSeq = 1;
  private uiSeq = 1;
  private pendingUi = new Map<string, (resp: Record<string, unknown>) => void>();
  private steerQueue: string[] = [];
  private flags: Record<string, unknown> = { pinned: [], archived: [], groups: [], groupOf: {}, pinnedMessages: {}, hiddenProjects: [] };
  private deleted = new Set<string>();
  private renamed = new Map<string, string>();
  private forked: SessionMeta[] = [];
  private currentSession = "/mock/a/live.jsonl";
  private permMode: string | null = null;
  private settings = JSON.stringify(
    {
      defaultProvider: "ollama",
      defaultModel: "qwen-local",
      defaultThinkingLevel: "high",
      theme: "dark",
      packages: [
        "npm:pi-mcp-adapter",
        "npm:pi-web-access",
        "npm:@tintinweb/pi-subagents",
        "npm:@juicesharp/rpiv-todo",
        "npm:@juicesharp/rpiv-ask-user-question",
        "npm:pi-lens",
        "npm:pi-hermes-memory",
        "npm:pi-rewind",
        "npm:@gotgenes/pi-permission-system",
        "npm:pi-claude-style-tools",
        "npm:@plannotator/pi-extension",
      ],
      skills: ["~/.claude/skills"],
    },
    null,
    2,
  );
  private mcp = JSON.stringify(
    { mcpServers: { context7: { command: "npx", args: ["-y", "@upstash/context7-mcp@latest"], lifecycle: "lazy" } } },
    null,
    2,
  );
  private models = JSON.stringify(
    {
      providers: {
        ollama: {
          baseUrl: "http://127.0.0.1:8099/v1",
          api: "openai-completions",
          models: [{ id: "qwen-local", reasoning: true, contextWindow: 128000, maxTokens: 16384 }],
        },
      },
    },
    null,
    2,
  );

  private emit(event: string, payload: Record<string, unknown>) {
    this.handlers.get(event)?.forEach((h) => h(payload));
  }

  async listen(event: string, handler: Handler): Promise<() => void> {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  private emitAgent(agentId: string, event: Record<string, unknown>) {
    this.emit("agent-event", { agentId, event });
  }

  /** Диалог расширения (как pi-permission-system): ждёт extension_ui_response. */
  private askPermission(agentId: string, title: string, message: string, options: string[]): Promise<string> {
    const id = `ui-${this.uiSeq++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingUi.delete(id);
        resolve(options[0]);
      }, 20000);
      this.pendingUi.set(id, (resp) => {
        clearTimeout(timer);
        this.pendingUi.delete(id);
        resolve(resp.cancelled ? options[options.length - 1] : String(resp.value ?? options[0]));
      });
      this.emitAgent(agentId, {
        type: "extension_ui_request",
        id,
        method: "select",
        title,
        message,
        options,
        timeout: 20000,
      });
    });
  }

  private async runScript(agentId: string, prompt: string) {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const respond = (id: unknown, command: string, data: Record<string, unknown> = {}) =>
      this.emitAgent(agentId, { type: "response", id, command, success: true, data });
    void respond;
    this.emitAgent(agentId, { type: "agent_start" });
    this.emitAgent(agentId, { type: "turn_start" });
    this.emitAgent(agentId, { type: "message_start" });
    await sleep(200);
    const think = "Пользователь просит продемонстрировать интерфейс. Покажу стриминг, вызов инструмента и markdown.";
    for (const ch of chunks(think, 24)) {
      this.emitAgent(agentId, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: ch } });
      await sleep(30);
    }
    const reply = `Это **демо-режим** (mock backend): интерфейс работает без Tauri.\n\nВы написали:\n\n> ${prompt.slice(0, 200)}\n\nПример кода:\n\n\`\`\`typescript\nconst answer: number = 42;\nexport function demo() {\n  return answer;\n}\n\`\`\`\n\nСейчас вызову инструмент bash…`;
    for (const ch of chunks(reply, 18)) {
      this.emitAgent(agentId, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: ch } });
      await sleep(25);
    }
    this.emitAgent(agentId, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: think },
          { type: "text", text: reply },
          { type: "toolCall", id: "call_demo1", name: "bash", arguments: { command: "ls -la src/" } },
        ],
        model: "qwen-local",
        usage: { input: 1200, output: 180, cost: { total: 0 } },
      },
    });

    // permission-диалог перед выполнением инструмента (как pi-permission-system)
    const verdict = await this.askPermission(
      agentId,
      "Разрешить выполнение команды?",
      "bash: ls -la src/",
      ["Разрешить", "Заблокировать"],
    );
    const blocked = verdict !== "Разрешить";

    this.emitAgent(agentId, { type: "tool_execution_start", toolCallId: "call_demo1", toolName: "bash", args: { command: "ls -la src/" } });
    await sleep(400);
    const toolText = blocked
      ? "Команда заблокирована пользователем"
      : "total 24\n-rw-r--r--  App.tsx\n-rw-r--r--  main.tsx\ndrwxr-xr-x  components/";
    this.emitAgent(agentId, {
      type: "tool_execution_end",
      toolCallId: "call_demo1",
      isError: blocked,
      result: { content: [{ type: "text", text: toolText }] },
    });
    this.emitAgent(agentId, {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "call_demo1",
        toolName: "bash",
        content: [{ type: "text", text: toolText }],
        isError: blocked,
      },
    });

    // обработать steer, если пользователь вмешался во время рана
    if (this.steerQueue.length > 0) {
      const steer = this.steerQueue.splice(0);
      this.emitAgent(agentId, { type: "queue_update", steering: [], followUp: [] });
      for (const s of steer) {
        this.emitAgent(agentId, { type: "message_end", message: { role: "user", content: [{ type: "text", text: s }] } });
      }
      this.emitAgent(agentId, { type: "message_start" });
      const ack = `Принял поправку: «${steer[steer.length - 1].slice(0, 80)}» — учитываю.`;
      for (const ch of chunks(ack, 14)) {
        this.emitAgent(agentId, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: ch, partial: { role: "assistant", content: [{ type: "text", text: ack }] } } });
        await sleep(30);
      }
      this.emitAgent(agentId, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: ack }], model: "qwen-local" } });
    }

    this.emitAgent(agentId, { type: "message_start" });
    const tail = blocked
      ? "Команда была заблокирована — продолжаю без неё."
      : "Готово — всё работает. Это финальное сообщение после tool call.";
    let acc = "";
    for (const ch of chunks(tail, 12)) {
      acc += ch;
      this.emitAgent(agentId, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: ch, partial: { role: "assistant", content: [{ type: "text", text: acc }] } } });
      await sleep(30);
    }
    this.emitAgent(agentId, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: tail }], model: "qwen-local", usage: { input: 1500, output: 40, cost: { total: 0 } } },
    });
    this.emitAgent(agentId, { type: "turn_end" });
    this.emitAgent(agentId, { type: "agent_end" });
    this.emitAgent(agentId, { type: "extension_ui_request", method: "notify", notificationType: "success", message: "Ран завершён" });
  }

  async invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    switch (cmd) {
      case "resolve_pi":
        return { path: "/opt/homebrew/bin/pi", version: "0.80.3 (mock)", agentDir: "~/.pi/agent" } satisfies PiInfo as T;
      case "read_app_config":
        return { editor: "code", processLimit: 2, idleKillSecs: 900, theme: "system", uiScale: 1, displayName: "Nikita", piRetryStallTimeoutMs: 0 } satisfies AppConfig as T;
      case "write_app_config":
        return undefined as T;
      case "list_projects":
        return [
          { dir: "/mock/a", cwd: "/Users/dev/pi-app", name: "pi-app", sessionCount: 4, lastModifiedMs: Date.now() - 3600e3 },
          { dir: "/mock/b", cwd: "/Users/dev/website", name: "website", sessionCount: 2, lastModifiedMs: Date.now() - 86400e3 },
        ] satisfies ProjectInfo[] as T;
      case "list_sessions_for_cwd":
      case "list_sessions": {
        const base: SessionMeta[] = [
          {
            path: "/mock/a/s1.jsonl", id: "s1", cwd: "/Users/dev/pi-app", name: "Fix supervisor race",
            createdAt: new Date(Date.now() - 7200e3).toISOString(), modifiedMs: Date.now() - 3600e3,
            messageCount: 24, userSnippet: "Почини гонку в супервизоре при kill", costTotal: 0.42, tokensIn: 120000, tokensOut: 8000,
          },
          {
            path: "/mock/a/s2.jsonl", id: "s2", cwd: "/Users/dev/pi-app", name: null,
            createdAt: new Date(Date.now() - 90000e3).toISOString(), modifiedMs: Date.now() - 86400e3,
            messageCount: 7, userSnippet: "Добавь тесты для diff-парсера", costTotal: 0.08, tokensIn: 30000, tokensOut: 2000,
          },
          {
            path: "/mock/a/s3.jsonl", id: "s3", cwd: "/Users/dev/pi-app", name: "Старый рефакторинг",
            createdAt: new Date(Date.now() - 200000e3).toISOString(), modifiedMs: Date.now() - 172800e3,
            messageCount: 41, userSnippet: "Рефакторинг supervisor", costTotal: 1.2, tokensIn: 500000, tokensOut: 40000,
          },
          // две одноимённые сессии (одинаковый стартовый промпт Create PR) —
          // воспроизводят баг переключения между сессиями с одинаковым названием
          {
            path: "/mock/a/pr1.jsonl", id: "pr1", cwd: "/Users/dev/pi-app", name: null,
            createdAt: new Date(Date.now() - 600e3).toISOString(), modifiedMs: Date.now() - 300e3,
            messageCount: 3, userSnippet: "Подготовь pull/merge request по текущим изменениям", costTotal: 0.03, tokensIn: 9000, tokensOut: 600,
          },
          {
            path: "/mock/a/pr2.jsonl", id: "pr2", cwd: "/Users/dev/pi-app", name: null,
            createdAt: new Date(Date.now() - 120e3).toISOString(), modifiedMs: Date.now() - 60e3,
            messageCount: 3, userSnippet: "Подготовь pull/merge request по текущим изменениям", costTotal: 0.02, tokensIn: 8000, tokensOut: 500,
          },
        ];
        return [...this.forked, ...base]
          .filter((s) => !this.deleted.has(s.path))
          .map((s) => (this.renamed.has(s.path) ? { ...s, name: this.renamed.get(s.path)! } : s)) as T;
      }
      case "fork_session": {
        const src = String(args.path);
        const id = `fork-${Date.now().toString(36)}`;
        const meta: SessionMeta = {
          path: `/mock/a/${id}.jsonl`, id, cwd: "/Users/dev/pi-app",
          name: `Форк: ${src.split("/").pop()?.replace(".jsonl", "") ?? "сессия"}`,
          createdAt: new Date().toISOString(), modifiedMs: Date.now(),
          messageCount: args.upToEntryId ? 1 : 3, userSnippet: "форк (mock)", costTotal: 0, tokensIn: 0, tokensOut: 0,
        };
        this.forked.unshift(meta);
        return meta as T;
      }
      case "delete_session":
        this.deleted.add(String(args.path));
        return undefined as T;
      case "rename_session":
        this.renamed.set(String(args.path), String(args.name));
        return undefined as T;
      case "read_session_flags":
        return { ...this.flags } as T;
      case "write_session_flags":
        this.flags = args.flags as Record<string, unknown>;
        return undefined as T;
      case "read_session_thread": {
        const p = String(args.path);
        return [
          { type: "message", message: { role: "user", content: [{ type: "text", text: `Открыта сессия ${p} (mock)` }] } },
          { type: "message", message: { role: "assistant", content: [{ type: "text", text: `Это содержимое файла ${p}. **Markdown** работает.` }], model: "qwen-local" } },
        ] as T;
      }
      case "search_sessions":
        return [
          { path: "/mock/a/s1.jsonl", cwd: "/Users/dev/pi-app", entryId: "e1", timestamp: new Date().toISOString(), role: "user", snippet: `…найдено: ${String(args.query)}…` },
        ] as T;
      case "analytics_overview": {
        const days: AnalyticsOverview["perDay"] = [];
        for (let i = 180; i >= 0; i--) {
          const d = new Date(Date.now() - i * 86400e3);
          if (Math.random() > 0.35) {
            const messages = Math.floor(Math.random() * 40) + 1;
            days.push({
              date: d.toISOString().slice(0, 10),
              cost: Math.random() * 2,
              messages,
              input: messages * 40000,
              output: messages * 3000,
              sessions: Math.random() > 0.6 ? 1 + Math.floor(Math.random() * 2) : 0,
            });
          }
        }
        const perHour = Array.from({ length: 24 }, (_, h) =>
          Math.floor((h >= 9 && h <= 23 ? 1 : 0.15) * (30 + Math.random() * 120)),
        );
        return {
          totals: { cost: 12.34, input: 38200000, output: 500000, cacheRead: 900000, cacheWrite: 20000, sessions: 64, messages: 33901 },
          perDay: days,
          perModel: [
            { model: "claude-opus-4-8", cost: 12.34, input: 22000000, output: 300000, messages: 22000 },
            { model: "qwen-local", cost: 0, input: 16200000, output: 200000, messages: 11901 },
          ],
          perHour,
        } satisfies AnalyticsOverview as T;
      }
      case "search_pi_packages": {
        await sleep(250);
        const kind = String(args.kind);
        const from = Number(args.from ?? 0);
        const ext: PiPackage[] = [
          { name: "pi-web-access", version: "2.1.0", description: "Web search, URL fetching, GitHub repo cloning, PDF extraction, YouTube video understanding.", author: "nicopreme", downloadsMonthly: 126000, npmUrl: "https://www.npmjs.com/package/pi-web-access", repoUrl: "https://github.com/nicobailon/pi-web-access", homepage: null, keywords: ["pi-extension", "web-search"], updated: new Date().toISOString(), popularity: 1 },
          { name: "pi-agent-browser-native", version: "0.4.2", description: "Exposes agent-browser as a native tool for browser automation — navigate, inspect DOM, screenshot.", author: "fitchmultz", downloadsMonthly: 12300, npmUrl: "https://www.npmjs.com/package/pi-agent-browser-native", repoUrl: null, homepage: null, keywords: ["pi-extension", "browser"], updated: new Date().toISOString(), popularity: 0.8 },
          { name: "@gotgenes/pi-permission-system", version: "0.5.0", description: "Permission enforcement extension for Pi coding agent.", author: "gotgenes", downloadsMonthly: 20500, npmUrl: "https://www.npmjs.com/package/@gotgenes/pi-permission-system", repoUrl: null, homepage: null, keywords: ["pi-extension", "permissions"], updated: new Date().toISOString(), popularity: 0.9 },
          { name: "pi-lens", version: "1.0.3", description: "Real-time code feedback for pi — LSP, linters, formatters, type-checking, structural analysis.", author: "apmantza", downloadsMonthly: 24200, npmUrl: "https://www.npmjs.com/package/pi-lens", repoUrl: null, homepage: null, keywords: ["pi-extension", "lsp"], updated: new Date().toISOString(), popularity: 0.85 },
        ];
        const skill: PiPackage[] = [
          { name: "mitsupi", version: "1.6.0", description: "Armin's pi coding agent commands, skills, extensions, and themes.", author: "mitsuhiko", downloadsMonthly: 4188, npmUrl: "https://www.npmjs.com/package/mitsupi", repoUrl: "https://github.com/mitsuhiko/agent-stuff", homepage: null, keywords: ["pi-skill", "pi-theme"], updated: new Date().toISOString(), popularity: 0.7 },
          { name: "pi-skill-code-review", version: "0.2.0", description: "Review the current diff for correctness bugs and cleanups.", author: "community", downloadsMonthly: 1200, npmUrl: "https://www.npmjs.com/package/pi-skill-code-review", repoUrl: null, homepage: null, keywords: ["pi-skill"], updated: new Date().toISOString(), popularity: 0.5 },
        ];
        const list = kind === "skill" ? skill : ext;
        return { total: list.length, objects: from > 0 ? [] : list } satisfies PackageSearch as T;
      }
      case "pi_packages_meta": {
        await sleep(200);
        const names = (args.names as string[]) ?? [];
        return names
          .filter((s) => s.startsWith("npm:"))
          .map((s) => s.slice(4))
          .map((name) => ({
            name,
            version: "1.0.0",
            description: `Установленный пакет ${name} (mock-метаданные).`,
            author: name.startsWith("@") ? name.slice(1).split("/")[0] : "community",
            downloadsMonthly: 0,
            npmUrl: `https://www.npmjs.com/package/${name}`,
            repoUrl: null,
            homepage: null,
            keywords: [],
            updated: null,
            popularity: 0,
          })) satisfies PiPackage[] as T;
      }
      case "preview_configs":
        return [
          { name: "pi-app-ui", runtimeExecutable: "npm", runtimeArgs: ["run", "dev"], port: 1420 },
        ] satisfies LaunchConfig[] as T;
      case "preview_save_config":
        return undefined as T;
      case "preview_start": {
        const serverId = `prev-${Date.now()}`;
        void (async () => {
          for (const l of ["> vite", "VITE ready in 240 ms", "➜ Local: http://localhost:1420/"]) {
            await sleep(300);
            this.emit("preview-output", { serverId, line: l, done: false });
          }
        })();
        return { serverId, url: "http://localhost:1420", port: 1420 } satisfies PreviewHandle as T;
      }
      case "preview_stop":
        return undefined as T;
      case "read_pi_config": {
        const name = String(args.name);
        const content = name === "settings" ? this.settings : name === "mcp" ? this.mcp : this.models;
        return { path: `~/.pi/agent/${name}.json`, content, exists: true } satisfies ConfigFile as T;
      }
      case "write_pi_config": {
        const name = String(args.name);
        const content = String(args.content);
        if (name === "settings") this.settings = content;
        else if (name === "mcp") this.mcp = content;
        else this.models = content;
        return undefined as T;
      }
      case "list_skills":
        return [
          { name: "code-review", description: "Review the current diff for bugs", path: "/mock/skills/code-review/SKILL.md", sourceDir: "~/.claude/skills" },
          { name: "verify", description: "Verify a change by running the app", path: "/mock/skills/verify/SKILL.md", sourceDir: "~/.claude/skills" },
        ] satisfies SkillInfo[] as T;
      case "list_workspace_files":
        return [
          "src/App.tsx",
          "src/components/ChatView.tsx",
          "src/components/ReviewView.tsx",
          "src/state/store.ts",
          "src/lib/backend.ts",
          "src-tauri/src/gitops.rs",
          "docs/ROADMAP.md",
          "package.json",
          "README.md",
        ] as T;
      case "process_stats":
        return [
          { kind: "agent", id: "mock-agent-1", label: "/Users/demo/pi-app", pid: 4242, rssMb: 412.5, procs: 6 },
          { kind: "preview", id: "srv-1", label: "/Users/demo/pi-app", pid: 4310, rssMb: 156.2, procs: 3 },
          { kind: "app", id: "app", label: "pi-app (процесс приложения)", pid: 100, rssMb: 220.7, procs: 1 },
        ] as T;
      case "spawn_agent": {
        const id = `mock-agent-${this.agentSeq++}`;
        // как реальный pi: агент открывается на переданной сессии (get_state
        // затем вернёт её в sessionFile). null → новая сессия.
        const opts = (args.opts ?? {}) as { sessionPath?: string | null };
        this.currentSession = opts.sessionPath ?? `/mock/a/new-${Date.now()}.jsonl`;
        return id as T;
      }
      case "agent_send": {
        const line = JSON.parse(String(args.line));
        const agentId = String(args.agentId);
        if (line.type === "prompt") {
          void this.runScript(agentId, String(line.message ?? ""));
        } else if (line.type === "steer") {
          this.steerQueue.push(String(line.message ?? ""));
          this.emitAgent(agentId, { type: "queue_update", steering: [...this.steerQueue], followUp: [] });
        } else if (line.type === "extension_ui_response") {
          this.pendingUi.get(String(line.id))?.(line as Record<string, unknown>);
        } else if (line.type === "switch_session" && line.id) {
          this.currentSession = String(line.sessionPath ?? this.currentSession);
          this.emitAgent(agentId, { type: "response", id: line.id, command: "switch_session", success: true, data: { cancelled: false } });
        } else if (line.type === "new_session" && line.id) {
          this.currentSession = `/mock/a/new-${Date.now()}.jsonl`;
          this.emitAgent(agentId, { type: "response", id: line.id, command: "new_session", success: true, data: {} });
        } else if (line.id) {
          await sleep(30);
          const data: Record<string, unknown> =
            line.type === "get_state"
              ? {
                  model: { id: "qwen-local", provider: "ollama", contextWindow: 128000, input: ["text"] },
                  thinkingLevel: "high", isStreaming: false, sessionId: "mock", sessionFile: this.currentSession, messageCount: 2,
                }
              : line.type === "get_available_models"
                ? { models: [
                    { id: "qwen-local", provider: "ollama", reasoning: true, contextWindow: 128000 },
                    { id: "claude-sonnet-4", provider: "anthropic", reasoning: true, contextWindow: 200000 },
                  ] }
                : line.type === "get_session_stats"
                  ? {
                      tokens: { input: 12000, output: 800, cacheRead: 9000, cacheWrite: 400 },
                      cost: 0.05, userMessages: 3, assistantMessages: 3, toolCalls: 2, totalMessages: 8,
                      contextUsage: { tokens: 43000, contextWindow: 128000, percent: 34 },
                    }
                  : line.type === "set_auto_compaction"
                    ? {}
                  : line.type === "get_fork_messages"
                    ? { messages: [
                        { entryId: "fe1", text: "Восстановленная сессия: что мы делали?" },
                        { entryId: "fe2", text: "Покажи демо стриминга" },
                      ] }
                  : line.type === "fork"
                    ? { text: "Покажи демо стриминга", cancelled: false }
                  : line.type === "get_commands"
                    ? { commands: [{ name: "plan", description: "Plan mode" }, { name: "review", description: "Review diff" }] }
                    : line.type === "get_messages"
                      ? {
                          messages: [
                            { role: "user", content: [{ type: "text", text: "Восстановленная сессия: что мы делали?" }] },
                            { role: "assistant", content: [{ type: "text", text: "Мы чинили гонку в супервизоре. История загружена через `get_messages` — можно продолжать." }], model: "qwen-local" },
                          ],
                        }
                      : {};
          this.emitAgent(agentId, { type: "response", id: line.id, command: line.type, success: true, data });
        }
        return undefined as T;
      }
      case "kill_agent":
        return undefined as T;
      case "list_agents":
        return [] as T;
      case "git_is_repo":
        return true as T;
      case "git_summary":
        return { isRepo: true, branch: "main", insertions: 14723, deletions: 1, changedFiles: 12, hasRemote: true, ahead: 2, behind: 0 } as T;
      case "git_open_pr":
        return undefined as T;
      case "git_branches":
        return [
          { name: "main", current: true, remote: false, upstream: "origin/main", ahead: 2, behind: 0, lastSubject: "fix supervisor race", lastTs: Math.floor(Date.now() / 1000) - 3600 },
          { name: "feature/settings", current: false, remote: false, upstream: null, ahead: 0, behind: 0, lastSubject: "wip settings", lastTs: Math.floor(Date.now() / 1000) - 86400 },
          { name: "origin/release", current: false, remote: true, upstream: null, ahead: 0, behind: 0, lastSubject: "release 0.1", lastTs: Math.floor(Date.now() / 1000) - 172800 },
        ] as T;
      case "git_log":
        return [
          { hash: "a".repeat(40), shortHash: "aaaaaaa", author: "dev", ts: Math.floor(Date.now() / 1000) - 3000, subject: "feat: полный git-вид", refs: "HEAD -> main" },
          { hash: "b".repeat(40), shortHash: "bbbbbbb", author: "dev", ts: Math.floor(Date.now() / 1000) - 90000, subject: "fix: watcher сессий", refs: "" },
        ] as T;
      case "git_show_commit":
      case "git_file_diff":
        return [
          "diff --git a/src/lib/reducer.ts b/src/lib/reducer.ts",
          "--- a/src/lib/reducer.ts",
          "+++ b/src/lib/reducer.ts",
          "@@ -1,3 +1,4 @@",
          " import type { ChatState } from \"./types\";",
          "+// изменение из mock git_file_diff",
          " export {};",
          "",
        ].join("\n") as T;
      case "git_checkout_branch":
      case "git_create_branch":
      case "git_delete_branch":
      case "git_stage":
      case "git_unstage":
      case "git_discard":
      case "git_fetch":
        return undefined as T;
      case "git_commit":
        return "c".repeat(40) as T;
      case "git_push":
        return "pushed (mock)" as T;
      case "git_pull":
        return "Already up to date. (mock)" as T;
      case "migrate_permission_configs":
        return [] as T;
      case "probe_url":
        await sleep(300);
        return "200" as T;
      case "check_app_update": {
        await sleep(400);
        return {
          currentVersion: "0.1.0", currentSha: "abc1234",
          sourceRepo: "/Users/dev/pi-app", sourceRepoValid: true,
          latest: "def5678", latestKind: "commit",
          notes: "def5678 feat: self-update, dialog fixes\nc0ffee0 fix: statusline layout",
          htmlUrl: "https://github.com/NickLitwinow/pi-app", updateAvailable: true,
          checked: true, behind: 2, ahead: 0, error: null,
        } as T;
      }
      case "app_update_run": {
        const runId = `upd-${Date.now()}`;
        void (async () => {
          for (const l of ["▶ Обновление исходников (git pull)", "$ git pull --ff-only", "Already up to date.", "▶ Сборка приложения (tauri build)", "Compiling pi-app…", "✓ Готово. Нажмите «Перезапустить»."]) {
            await sleep(500);
            this.emit("app-update-output", { runId, line: l, done: false });
          }
          await sleep(400);
          this.emit("app-update-output", { runId, done: true, code: 0 });
        })();
        return runId as T;
      }
      case "relaunch_app":
        return undefined as T;
      case "set_pi_path":
        return { path: String(args.path ?? "/opt/homebrew/bin/pi"), version: "0.80.3 (mock)", agentDir: "~/.pi/agent" } satisfies PiInfo as T;
      case "write_permission_preset":
        this.permMode = String(args.mode);
        return undefined as T;
      case "read_permission_mode":
        return (this.permMode ?? null) as T;
      case "read_file_base64":
        return { data: "iVBORw0KGgo=", mimeType: "image/png" } as T;
      case "git_checkpoint":
        return "abc1234" as T;
      case "git_status":
        return [
          { status: " M", path: "src/lib/reducer.ts" },
          { status: "??", path: "src/components/NewFile.tsx" },
        ] as T;
      case "git_review_diff":
        return [
          "diff --git a/src/lib/reducer.ts b/src/lib/reducer.ts",
          "--- a/src/lib/reducer.ts",
          "+++ b/src/lib/reducer.ts",
          "@@ -1,6 +1,8 @@",
          " import type { ChatState } from \"./types\";",
          "-function old(): void {}",
          "+function applyEvent(chat: ChatState): void {",
          "+  // new implementation",
          "+}",
          " export {};",
          "diff --git a/src/components/NewFile.tsx b/src/components/NewFile.tsx",
          "--- /dev/null",
          "+++ b/src/components/NewFile.tsx",
          "@@ -0,0 +1,3 @@",
          "+export function NewFile() {",
          "+  return null;",
          "+}",
          "",
        ].join("\n") as T;
      case "git_checkout_file":
      case "open_in_editor":
      case "reveal_in_finder":
      case "open_external":
        return undefined as T;
      case "pi_cli_run": {
        const runId = `run-${Date.now()}`;
        void (async () => {
          await sleep(300);
          this.emit("pi-cli-output", { runId, stream: "out", line: `mock: pi ${(args.args as string[]).join(" ")}`, done: false });
          await sleep(500);
          this.emit("pi-cli-output", { runId, stream: "out", line: "mock: done", done: false });
          this.emit("pi-cli-output", { runId, done: true, code: 0 });
        })();
        return runId as T;
      }
      default:
        throw new Error(`mock backend: unknown command ${cmd}`);
    }
  }
}

function chunks(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

let backendPromise: Promise<Backend> | null = null;

export function getBackend(): Promise<Backend> {
  if (!backendPromise) {
    backendPromise = isTauri() ? makeTauriBackend() : Promise.resolve(new MockBackend());
  }
  return backendPromise;
}
