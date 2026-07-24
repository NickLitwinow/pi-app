// Backend abstraction ("SessionDriver"): the UI talks only to this interface.
// In Tauri it maps to invoke/listen; in a plain browser (vite preview) a mock
// backend with scripted demo data keeps the whole UI usable for development.

import type {
  AnalyticsOverview,
  AppConfig,
  ConfigFile,
  LaunchConfig,
  PackageSearch,
  PackageDetails,
  PiInfo,
  PiPackage,
  PiUpdateInfo,
  PreviewHandle,
  PreviewStatus,
  ProjectInfo,
  SessionMeta,
  SkillInfo,
} from "./types";
import { packageNameFromSpec } from "./marketplace";

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

export class MockBackend implements Backend {
  isMock = true;
  private handlers = new Map<string, Set<Handler>>();
  private agentSeq = 1;
  private uiSeq = 1;
  private pendingUi = new Map<string, (resp: Record<string, unknown>) => void>();
  private agentSessions = new Map<string, string>();
  private agentCwds = new Map<string, string>();
  private steerQueues = new Map<string, { text: string; images: Record<string, unknown>[] }[]>();
  private followUpQueues = new Map<string, { text: string; images: Record<string, unknown>[] }[]>();
  private flags: Record<string, unknown> = { pinned: [], archived: [], groups: [], groupOf: {}, pinnedMessages: {}, hiddenProjects: [] };
  private deleted = new Set<string>();
  private renamed = new Map<string, string>();
  private forked: SessionMeta[] = [];
  private deletedThemes = new Set<string>();
  private rewindTargetBySession = new Map<string, string>();
  private permissionModes = new Map<string, string>();
  private previewRuntime: PreviewStatus | null = null;
  private projectSettings = new Map<string, string>([
    ["/Users/dev/pi-app", JSON.stringify({ packages: ["npm:pi-skill-code-review"] }, null, 2)],
  ]);
  private projectSettingsExists = new Set<string>(["/Users/dev/pi-app"]);
  private projectMcp = new Map<string, string>();
  private projectMcpExists = new Set<string>();
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
        "npm:@gotgenes/pi-permission-system",
        "npm:pi-claude-style-tools",
        "npm:@narumitw/pi-retry",
        "npm:@narumitw/pi-statusline",
        "npm:@plannotator/pi-extension",
        "../../GithubControl/pi-app/harness-extension",
        "git:github.com/DietrichGebert/ponytail",
        "npm:pi-chrome",
        "npm:pi-agent-browser-native",
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
  // Несколько провайдеров и моделей: до спавна агента каталог берётся ИМЕННО
  // отсюда (models.json), поэтому одномодельный мок скрывал бы баги выбора.
  private models = JSON.stringify(
    {
      providers: {
        ollama: {
          baseUrl: "http://127.0.0.1:8099/v1",
          api: "openai-completions",
          models: [
            { id: "qwen-local", reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 16384 },
            { id: "qwen-coder-30b", reasoning: false, contextWindow: 262144, maxTokens: 16384 },
          ],
        },
        anthropic: {
          api: "anthropic-messages",
          models: [
            { id: "claude-sonnet-4", reasoning: true, contextWindow: 200000, maxTokens: 64000 },
            { id: "claude-opus-4-8", reasoning: true, contextWindow: 200000, maxTokens: 64000 },
          ],
        },
      },
    },
    null,
    2,
  );

  private mockSessionRoot(cwd: string): string {
    if (cwd === "/Users/dev/pi-app") return "/mock/a";
    if (cwd === "/Users/dev/website") return "/mock/b";
    return `/mock/workspaces/${encodeURIComponent(cwd)}`;
  }

  private agentQueue(
    queues: Map<string, { text: string; images: Record<string, unknown>[] }[]>,
    agentId: string,
  ): { text: string; images: Record<string, unknown>[] }[] {
    let queue = queues.get(agentId);
    if (!queue) {
      queue = [];
      queues.set(agentId, queue);
    }
    return queue;
  }

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

  /** Суммарное «работал»-время и счётчик ходов (как pi-claude-style-tools). */
  private workedTotalMs = 0;
  private turnCount = 0;

  private async runScript(agentId: string, prompt: string) {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const steerQueue = this.agentQueue(this.steerQueues, agentId);
    const followUpQueue = this.agentQueue(this.followUpQueues, agentId);
    const runStartedAt = Date.now();
    const streamDelay = prompt.includes("цепочку") ? 120 : 30;
    const respond = (id: unknown, command: string, data: Record<string, unknown> = {}) =>
      this.emitAgent(agentId, { type: "response", id, command, success: true, data });
    void respond;
    if (prompt.includes("[mock-preview]")) {
      const now = Date.now();
      this.previewRuntime = {
        serverId: "prev-agent",
        configName: "pi-app-ui",
        cwd: "/Users/demo/pi-app",
        url: "http://localhost:1420",
        port: 1420,
        running: true,
        ready: true,
        httpStatus: "200",
        startedAtMs: now - 2_000,
        lastActivityMs: now,
        logs: ["> vite", "VITE ready in 240 ms", "➜ Local: http://localhost:1420/"],
      };
      this.emitAgent(agentId, {
        type: "extension_ui_request",
        method: "setWidget",
        widgetKey: "pi-app-preview-state",
        widgetLines: [JSON.stringify({
          ...this.previewRuntime,
          status: "ready",
          browserOpened: true,
          browserInspected: true,
          evidence: ["chrome_navigate", "chrome_snapshot"],
          updatedAt: now,
          source: "agent",
        })],
      });
    }
    if (prompt.includes("[mock-workflow-retry]")) {
      this.emitAgent(agentId, {
        type: "message_end",
        message: {
          role: "user",
          customType: "pi-app-workflow",
          content: "Continue the existing objective. The evaluator claimed PASS but its output was discarded because it did not complete the required machine-checkable clause protocol.\n\nPerform a fresh adversarial audit against the authoritative contract before claiming there is nothing to repair.",
          display: false,
          details: { reason: "evaluator-rejected", evaluatorTaskId: "eval-mock" },
        },
      });
    }
    if (prompt.includes("[mock-workflow]")) {
      const now = Date.now();
      const workflow = {
        version: 3,
        runId: "wf-mock",
        createdAt: now - 20_000,
        updatedAt: now,
        objective: "Build and verify the session workflow control center",
        profile: "feature",
        status: "active",
        approved: true,
        editsPending: true,
        changedFiles: ["src/session.ts", "src/WorkflowDock.tsx"],
        intent: { primary: "build", profile: "feature", risk: "medium", needsResearch: false, allowsMutation: true, allowsDeletion: false, requiresPlan: true, requiresSandbox: true, requiresEvaluator: true, requiresHumanApproval: false, signals: ["mutation", "coupled"] },
        steps: [
          { id: "plan", label: "Plan", kind: "plan", deps: [], status: "passed", acceptance: "Scope and observable done state are explicit.", required: true, owner: "orchestrator", maxAttempts: 2, attempts: 1 },
          { id: "build", label: "Build", kind: "build", deps: ["plan"], status: "running", acceptance: "Implementation satisfies the approved plan.", required: true, owner: "executor", maxAttempts: 5, attempts: 1 },
          { id: "verify:test", label: "Tests", kind: "gate", deps: ["build"], status: "pending", acceptance: "All tests pass.", command: "npm test", required: true, owner: "gate-runner", maxAttempts: 5, attempts: 0 },
          { id: "evaluate", label: "Independent evaluation", kind: "evaluate", deps: ["verify:test"], status: "pending", acceptance: "Read-only evaluator accepts the outcome.", required: true, owner: "evaluator", maxAttempts: 5, attempts: 0 },
          { id: "review", label: "Engineer review", kind: "review", deps: ["evaluate"], status: "pending", acceptance: "Evidence is ready for handoff.", required: true, owner: "human", maxAttempts: 1, attempts: 0 },
        ],
        events: [
          { id: "e1", type: "created", at: now - 20_000, message: "feature workflow created" },
          { id: "e2", stepId: "plan", type: "passed", at: now - 10_000, message: "Plan approved" },
          { id: "e3", stepId: "build", type: "started", at: now, message: "Implementation changed project files" },
        ],
      };
      const tasks = [{
        id: "agent-mock",
        type: "reviewer",
        description: "Review rewind transaction",
        status: "running",
        startedAt: now - 5_000,
        durationMs: 5_000,
        tokens: 4_218,
        priority: "normal",
        branch: "pi-agent/rewind-review",
        baseSha: "abc1234",
        transcript: `Independent evaluation\n${"clause-with-an-intentionally-long-unbroken-proof-segment-".repeat(180)}`,
      }];
      this.emitAgent(agentId, { type: "extension_ui_request", method: "setWidget", widgetKey: "pi-app-workflow-state", widgetLines: [JSON.stringify(workflow)] });
      this.emitAgent(agentId, { type: "extension_ui_request", method: "setWidget", widgetKey: "pi-app-background-state", widgetLines: [JSON.stringify(tasks)] });
      this.emitAgent(agentId, {
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "todo-mock",
          toolName: "todo",
          content: [{ type: "text", text: "Execution backlog updated" }],
          details: {
            tasks: [
              { id: 1, subject: "Inspect session contracts", status: "completed" },
              { id: 2, subject: "Implement workflow controls", activeForm: "implementing workflow controls", status: "in_progress", blockedBy: [1], owner: "main" },
              { id: 3, subject: "Verify rewind and merge", status: "pending", blockedBy: [2] },
            ],
          },
        },
      });
      this.emitAgent(agentId, {
        type: "extension_ui_request",
        method: "setWidget",
        widgetKey: "pi-app-checkpoint-state",
        widgetLines: [JSON.stringify({
          version: 1,
          at: now - 2_000,
          runId: "wf-mock",
          objective: workflow.objective,
          profile: "feature",
          decisions: ["Same-session rewind remains append-only"],
          gateEvidence: [{ id: "verify:test", status: "pending", command: "npm test" }],
          risks: ["Evaluator has not run yet"],
          steps: workflow.steps.map(({ id, status }) => ({ id, status })),
          nextReadySteps: ["build"],
          nextAction: "Finish build, then run deterministic gates.",
          context: { percent: 75.4, tokens: 197_656, contextWindow: 262_144 },
        })],
      });
      this.emitAgent(agentId, {
        type: "compaction_end",
        reason: "manual",
        result: {
          tokensBefore: 229_440,
          summary: "## Goal\nPreserve the session workflow.\n\n## Progress\nPlan approved.\n\n## Key Decisions\nRewind stays in-session.\n\n## Next Steps\nRun gates and evaluator.",
        },
      });
    }
    this.emitAgent(agentId, { type: "agent_start" });
    this.emitAgent(agentId, { type: "turn_start" });
    this.emitAgent(agentId, { type: "message_start" });
    await sleep(200);
    const think = "Пользователь просит продемонстрировать интерфейс. Покажу стриминг, вызов инструмента и markdown.";
    let thinkAcc = "";
    for (const ch of chunks(think, 24)) {
      thinkAcc += ch;
      this.emitAgent(agentId, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: ch, partial: { role: "assistant", content: [{ type: "thinking", thinking: thinkAcc }] } } });
      await sleep(streamDelay);
    }
    const reply = `Это **демо-режим** (mock backend): интерфейс работает без Tauri.\n\nВы написали:\n\n> ${prompt.slice(0, 200)}\n\nПример кода:\n\n\`\`\`typescript\nconst answer: number = 42;\nexport function demo() {\n  return answer;\n}\n\`\`\`\n\nСейчас вызову инструмент bash…`;
    let replyAcc = "";
    for (const ch of chunks(reply, 18)) {
      replyAcc += ch;
      this.emitAgent(agentId, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: ch, partial: { role: "assistant", content: [{ type: "thinking", thinking: think }, { type: "text", text: replyAcc }] } } });
      await sleep(Math.max(25, streamDelay - 10));
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
        model: "qwen-local", provider: "ollama",
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

    // Второй шаг создаёт настоящую цепочку действий для compact run-summary.
    const editArgs = { path: "src/lib/reducer.ts", oldText: "function old(): void {}", newText: "function applyEvent(): void {}" };
    this.emitAgent(agentId, { type: "message_start" });
    this.emitAgent(agentId, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Проверяю результат и вношу точечную правку." },
          { type: "toolCall", id: "call_demo2", name: "edit", arguments: editArgs },
        ],
        model: "qwen-local", provider: "ollama",
      },
    });
    this.emitAgent(agentId, { type: "tool_execution_start", toolCallId: "call_demo2", toolName: "edit", args: editArgs });
    await sleep(220);
    this.emitAgent(agentId, {
      type: "tool_execution_end",
      toolCallId: "call_demo2",
      isError: false,
      result: { content: [{ type: "text", text: "Updated src/lib/reducer.ts" }] },
    });
    this.emitAgent(agentId, {
      type: "message_end",
      message: { role: "toolResult", toolCallId: "call_demo2", toolName: "edit", content: [{ type: "text", text: "Updated src/lib/reducer.ts" }] },
    });

    // обработать steer, если пользователь вмешался во время рана
    if (steerQueue.length > 0) {
      const steer = steerQueue.splice(0);
      this.emitAgent(agentId, { type: "queue_update", steering: [], followUp: followUpQueue.map((item) => item.text) });
      for (const item of steer) {
        this.emitAgent(agentId, {
          type: "message_end",
          message: { role: "user", content: [{ type: "text", text: item.text }, ...item.images] },
        });
      }
      this.emitAgent(agentId, { type: "message_start" });
      const ack = `Принял поправку: «${steer[steer.length - 1].text.slice(0, 80)}» — учитываю.`;
      for (const ch of chunks(ack, 14)) {
        this.emitAgent(agentId, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: ch, partial: { role: "assistant", content: [{ type: "text", text: ack }] } } });
        await sleep(30);
      }
      this.emitAgent(agentId, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: ack }], model: "qwen-local", provider: "ollama" } });
    }

    this.emitAgent(agentId, { type: "message_start" });
    const tail = blocked
      ? "Команда была заблокирована — продолжаю без неё."
      : "Готово — всё работает. Это финальное сообщение после tool call.";
    let acc = "";
    for (const ch of chunks(tail, 12)) {
      acc += ch;
      this.emitAgent(agentId, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: ch, partial: { role: "assistant", content: [{ type: "text", text: acc }], model: "qwen-local", provider: "ollama" } } });
      await sleep(30);
    }
    // финал хода — как pi-claude-style-tools: ANSI-строка тайминга в хвосте
    // последнего текстового блока + message-level метаданные
    const workedMs = Date.now() - runStartedAt;
    this.workedTotalMs += workedMs;
    this.turnCount += 1;
    const timingLine = `\u001b[38;2;140;140;140m✻ Turn took ${mockDuration(workedMs)} (Total time ${mockDuration(this.workedTotalMs)} · ${this.turnCount} turn${this.turnCount === 1 ? "" : "s"})\u001b[0m`;
    this.emitAgent(agentId, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${tail}\n\n${timingLine}` }],
        model: "qwen-local", provider: "ollama",
        usage: { input: 1500, output: 40, cost: { total: 0 } },
        _piClaudeStyleWorkedDurationMs: workedMs,
        _piClaudeStyleWorkedSessionTotalMs: this.workedTotalMs,
        _piClaudeStyleWorkedTurns: this.turnCount,
      },
    });
    this.emitAgent(agentId, { type: "turn_end" });

    // Pi drains follow_up only after the current turn. Keep the mock lifecycle
    // honest so queued image blocks are echoed from the same payload rather
    // than appearing to succeed only because the UI added an optimistic row.
    const followUps = followUpQueue.splice(0);
    if (followUps.length > 0) {
      this.emitAgent(agentId, {
        type: "queue_update",
        steering: steerQueue.map((item) => item.text),
        followUp: [],
      });
      for (const item of followUps) {
        this.emitAgent(agentId, { type: "turn_start" });
        this.emitAgent(agentId, {
          type: "message_end",
          message: { role: "user", content: [{ type: "text", text: item.text }, ...item.images] },
        });
        const summary = item.text.trim()
          ? `Выполняю следующий запрос: «${item.text.slice(0, 80)}».`
          : `Выполняю следующий запрос с изображениями (${item.images.length}).`;
        this.emitAgent(agentId, { type: "message_start" });
        this.emitAgent(agentId, {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: summary }],
            model: "qwen-local",
            provider: "ollama",
          },
        });
        this.emitAgent(agentId, { type: "turn_end" });
      }
    }

    this.emitAgent(agentId, { type: "agent_end" });
    this.emitAgent(agentId, { type: "extension_ui_request", method: "notify", notificationType: "success", message: "Ран завершён" });
  }

  async invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    switch (cmd) {
      case "resolve_pi":
        return { path: "/opt/homebrew/bin/pi", version: "0.80.3 (mock)", agentDir: "~/.pi/agent" } satisfies PiInfo as T;
      case "read_app_config":
        return { editor: "code", processLimit: 2, processLimitAuto: true, agentSandboxMode: "workspace-write", idleKillSecs: 900, previewIdleKillSecs: 600, theme: "system", uiScale: 1, displayName: "Nikita", piRetryStallTimeoutMs: 0, modelAliases: { "ollama/qwen-local": "ThinkingCap 27B" }, modelAvatars: {}, accentColor: "#8b5cf6", iconColor: "#8b5cf6", appIconBackground: "#171A24", appearancePreset: "chatgpt", visualEffects: true, interfaceDensity: "comfortable", transcriptMode: "normal", sendKeyBehavior: "enter", libraryOnboardingSeen: true } satisfies AppConfig as T;
      case "write_app_config":
        return undefined as T;
      case "set_app_icon":
        return undefined as T;
      case "read_avatar_data": {
        // Реальный бэкенд читает файл и отдаёт data-URL. В моке файловой системы
        // нет, поэтому по расширению отдаём образцы: так путь «анимированный SVG /
        // Lottie» проверяем в браузерном превью без Tauri.
        const path = String(args.path);
        const ext = path.split(".").pop()?.toLowerCase() ?? "";
        if (ext === "svg") return `data:image/svg+xml;base64,${btoa(MOCK_ANIMATED_SVG)}` as T;
        if (ext === "json") return `data:application/json;base64,${btoa(MOCK_LOTTIE_JSON)}` as T;
        if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
          return `data:image/svg+xml;base64,${btoa(MOCK_ANIMATED_SVG)}` as T;
        }
        throw new Error("поддерживаются PNG, JPEG, GIF, WebP, анимированный SVG и Lottie (JSON)");
      }
      case "list_projects":
        return [
          { dir: "/mock/a", cwd: "/Users/dev/pi-app", name: "pi-app", sessionCount: 4, lastModifiedMs: Date.now() - 3600e3 },
          { dir: "/mock/b", cwd: "/Users/dev/website", name: "website", sessionCount: 2, lastModifiedMs: Date.now() - 86400e3 },
        ] satisfies ProjectInfo[] as T;
      case "list_sessions_for_cwd":
      case "list_sessions": {
        const piAppSessions: SessionMeta[] = [
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
          {
            path: "/mock/a/rewind.jsonl", id: "rewind", cwd: "/Users/dev/pi-app", name: "Rewind transaction",
            createdAt: new Date(Date.now() - 90e3).toISOString(), modifiedMs: Date.now() - 30e3,
            messageCount: 4, userSnippet: "Второй запрос с изображением", costTotal: 0, tokensIn: 4000, tokensOut: 300,
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
        const websiteSessions: SessionMeta[] = [
          {
            path: "/mock/b/accessibility.jsonl", id: "web-a11y", cwd: "/Users/dev/website", name: "Landing page accessibility",
            createdAt: new Date(Date.now() - 5400e3).toISOString(), modifiedMs: Date.now() - 2700e3,
            messageCount: 12, userSnippet: "Проверь доступность лендинга", costTotal: 0.12, tokensIn: 42000, tokensOut: 3100,
          },
          {
            path: "/mock/b/deploy.jsonl", id: "web-deploy", cwd: "/Users/dev/website", name: "Deploy preview",
            createdAt: new Date(Date.now() - 1800e3).toISOString(), modifiedMs: Date.now() - 600e3,
            messageCount: 8, userSnippet: "Подготовь preview deploy", costTotal: 0.04, tokensIn: 18000, tokensOut: 1400,
          },
        ];
        const requestedCwd = cmd === "list_sessions_for_cwd" ? String(args.cwd ?? "") : null;
        return [...this.forked, ...piAppSessions, ...websiteSessions]
          .filter((session) => requestedCwd == null || session.cwd === requestedCwd)
          .filter((s) => !this.deleted.has(s.path))
          .map((s) => (this.renamed.has(s.path) ? { ...s, name: this.renamed.get(s.path)! } : s)) as T;
      }
      case "fork_session": {
        const src = String(args.path);
        const sourceRoot = src.startsWith("/mock/b/") ? "/mock/b" : "/mock/a";
        const sourceCwd = src.startsWith("/mock/b/") ? "/Users/dev/website" : "/Users/dev/pi-app";
        const id = `fork-${Date.now().toString(36)}`;
        const meta: SessionMeta = {
          path: `${sourceRoot}/${id}.jsonl`, id, cwd: sourceCwd,
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
        const now = Date.now();
        if (p.endsWith("/rewind.jsonl")) {
          const first = [
            { type: "message", id: "rewind-u1", parentId: "root", timestamp: now - 60_000, message: { role: "user", content: [{ type: "text", text: "Первый запрос остаётся в активной ветке" }] } },
            { type: "message", id: "rewind-a1", parentId: "rewind-u1", timestamp: now - 55_000, message: { role: "assistant", content: [{ type: "text", text: "Первый ответ остаётся." }], model: "qwen-local", provider: "ollama" } },
          ];
          if (this.rewindTargetBySession.get(p) === "rewind-u2") return first as T;
          return [...first,
            { type: "message", id: "rewind-u2", parentId: "rewind-a1", timestamp: now - 30_000, message: { role: "user", content: [
              { type: "text", text: "Второй запрос с изображением" },
              { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nUwAAAAASUVORK5CYII=", mimeType: "image/png" },
            ] } },
            { type: "message", id: "rewind-a2", parentId: "rewind-u2", timestamp: now - 25_000, message: { role: "assistant", content: [{ type: "text", text: "Второй ответ будет оставлен в abandoned branch." }], model: "qwen-local", provider: "ollama", run: { id: "rewind-run-2", durationMs: 5_000, toolCallIds: [], checkpoint: "abc1234" } } },
          ] as T;
        }
        // как реальный pi 0.80.x: assistant несёт provider/model, у финального
        // сообщения — метаданные pi-claude-style-tools и ANSI-строка тайминга
        // ОДИН ход = user → серия assistant-сообщений (мысли/инструменты) →
        // финальный ответ. Финальный текст ВСЕГДА последним: GUI сворачивает всё
        // до него в «Worked for» (Codex-стиль). Проверка группировки хода.
        const messages: Record<string, unknown>[] = [
          { type: "message", timestamp: now - 60_000, message: { role: "user", content: [{ type: "text", text: `Открыта сессия ${p} (mock)` }] } },
          { type: "message", timestamp: now - 55_000, message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Смотрю reducer и прогоняю тесты, чтобы убедиться в отсутствии регрессий." },
              { type: "text", text: "Смотрю проект и прогоняю тесты…" },
              { type: "toolCall", id: "hist-1", name: "read", arguments: { path: "src/lib/reducer.ts" } },
              { type: "toolCall", id: "hist-2", name: "bash", arguments: { command: "npm test" } },
            ],
            model: "qwen-local", provider: "ollama",
          } },
          { type: "message", timestamp: now - 53_000, message: { role: "toolResult", toolCallId: "hist-1", toolName: "read", content: [{ type: "text", text: "export function applyAgentEvent(…) { /* 300 строк */ }" }], isError: false } },
          { type: "message", timestamp: now - 49_000, message: { role: "toolResult", toolCallId: "hist-2", toolName: "bash", content: [{ type: "text", text: "Test Files  8 passed (8)\nTests  57 passed (57)" }], isError: false } },
        ];
        if (p.endsWith("/s3.jsonl")) {
          messages.push(
            { type: "message", timestamp: now - 52_000, message: { role: "assistant", content: [{ type: "toolCall", id: "seq-3", name: "mcp", arguments: { tool: "sequential-thinking_sequentialthinking", args: JSON.stringify({ thought: "Проверяю границы ответственности и риск гонки при завершении дочерних процессов.", thoughtNumber: 3, totalThoughts: 7, nextThoughtNeeded: true, isRevision: true, revisesThought: 2 }) } }] }, model: "qwen-local", provider: "ollama" },
            { type: "message", timestamp: now - 51_000, message: { role: "toolResult", toolCallId: "seq-3", toolName: "mcp", content: [{ type: "text", text: "{\"thoughtNumber\":3,\"totalThoughts\":7,\"nextThoughtNeeded\":true}" }], isError: false } },
          );
        }
        // финальный ответ — всегда последним; несёт метаданные и ANSI-строку тайминга
        messages.push({ type: "message", timestamp: now - 48_000, message: {
          role: "assistant",
          content: [{ type: "text", text: `Это содержимое файла ${p}. **Markdown** работает.\n\n\u001b[38;2;140;140;140m✻ Turn took 12s (Total time 47s · 2 turns)\u001b[0m` }],
          model: "qwen-local", provider: "ollama",
          _piClaudeStyleWorkedDurationMs: 12_400,
          _piClaudeStyleWorkedSessionTotalMs: 47_000,
          _piClaudeStyleWorkedTurns: 2,
        } });
        return messages as T;
      }
      case "search_sessions":
        return [
          { path: "/mock/a/s1.jsonl", cwd: "/Users/dev/pi-app", entryId: "e1", timestamp: new Date().toISOString(), role: "user", snippet: `…найдено: ${String(args.query)}…` },
        ] as T;
      case "analytics_overview": {
        const days: AnalyticsOverview["perDay"] = [];
        for (let i = 180; i >= 0; i--) {
          const d = new Date(Date.now() - i * 86400e3);
          // Mock analytics must be deterministic: otherwise every visual run
          // produces a different heatmap and hides real UI regressions in noise.
          if ((i * 17 + 3) % 20 > 6) {
            const messages = ((i * 29 + 11) % 40) + 1;
            days.push({
              date: d.toISOString().slice(0, 10),
              cost: ((i * 13 + 5) % 200) / 100,
              messages,
              input: messages * 40000,
              output: messages * 3000,
              sessions: (i * 7 + 1) % 10 > 5 ? 1 + (i % 2) : 0,
            });
          }
        }
        const perHour = Array.from({ length: 24 }, (_, h) =>
          Math.floor((h >= 9 && h <= 23 ? 1 : 0.15) * (30 + ((h * 47 + 19) % 120))),
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
        const kind = String(args.kind);
        // Let an initial Extensions request finish after a quick switch to
        // Skills so UI tests catch stale catalog responses deterministically.
        await sleep(kind === "extension" ? 420 : 70);
        const from = Number(args.from ?? 0);
        const ext: PiPackage[] = [
          { name: "pi-web-access", version: "0.13.0", description: "Web search, URL fetching, GitHub repo cloning, PDF extraction, YouTube video understanding.", author: "nicopreme", downloadsMonthly: 126000, npmUrl: "https://www.npmjs.com/package/pi-web-access", repoUrl: "https://github.com/nicobailon/pi-web-access", homepage: null, keywords: ["pi-extension", "web-search"], updated: new Date().toISOString(), popularity: 1 },
          { name: "pi-agent-browser-native", version: "0.2.71", description: "Exposes agent-browser as a native tool for browser automation — navigate, inspect DOM, screenshot.", author: "fitchmultz", downloadsMonthly: 12300, npmUrl: "https://www.npmjs.com/package/pi-agent-browser-native", repoUrl: null, homepage: null, keywords: ["pi-extension", "browser"], updated: new Date().toISOString(), popularity: 0.8 },
          { name: "@gotgenes/pi-permission-system", version: "20.10.0", description: "Permission enforcement extension for Pi coding agent.", author: "gotgenes", downloadsMonthly: 20500, npmUrl: "https://www.npmjs.com/package/@gotgenes/pi-permission-system", repoUrl: null, homepage: null, keywords: ["pi-extension", "permissions"], updated: new Date().toISOString(), popularity: 0.9 },
          { name: "pi-lens", version: "3.8.71", description: "Real-time code feedback for pi — LSP, linters, formatters, type-checking, structural analysis.", author: "apmantza", downloadsMonthly: 24200, npmUrl: "https://www.npmjs.com/package/pi-lens", repoUrl: null, homepage: null, keywords: ["pi-extension", "lsp"], updated: new Date().toISOString(), popularity: 0.85 },
        ];
        const skill: PiPackage[] = [
          { name: "mitsupi", version: "1.6.0", description: "Armin's pi coding agent commands, skills, extensions, and themes.", author: "mitsuhiko", downloadsMonthly: 4188, npmUrl: "https://www.npmjs.com/package/mitsupi", repoUrl: "https://github.com/mitsuhiko/agent-stuff", homepage: null, keywords: ["pi-skill", "pi-theme"], updated: new Date().toISOString(), popularity: 0.7 },
          { name: "pi-skill-code-review", version: "0.2.0", description: "Review the current diff for correctness bugs and cleanups.", author: "community", downloadsMonthly: 1200, npmUrl: "https://www.npmjs.com/package/pi-skill-code-review", repoUrl: null, homepage: null, keywords: ["pi-skill"], updated: new Date().toISOString(), popularity: 0.5 },
        ];
        const theme: PiPackage[] = [
          { name: "pi-theme-aurora", version: "1.3.0", description: "A polished low-contrast theme for long coding sessions.", author: "community", downloadsMonthly: 3400, npmUrl: "https://www.npmjs.com/package/pi-theme-aurora", repoUrl: null, homepage: null, keywords: ["pi-theme"], updated: new Date().toISOString(), popularity: 0.65 },
        ];
        const prompt: PiPackage[] = [
          { name: "pi-prompts-review", version: "0.8.0", description: "Focused review and implementation prompt presets for pi.", author: "community", downloadsMonthly: 1900, npmUrl: "https://www.npmjs.com/package/pi-prompts-review", repoUrl: null, homepage: null, keywords: ["pi-prompt"], updated: new Date().toISOString(), popularity: 0.55 },
        ];
        const list = kind === "skill" ? skill : kind === "theme" ? theme : kind === "prompt" ? prompt : ext;
        return { total: list.length, objects: from > 0 ? [] : list } satisfies PackageSearch as T;
      }
      case "pi_packages_meta": {
        await sleep(200);
        const names = (args.names as string[]) ?? [];
        return names
          .map((source, index) => {
            const npm = source.startsWith("npm:");
            const name = packageNameFromSpec(source) ?? source;
            const resourceKinds = name === "pi-web-access" || name === "ponytail"
              ? ["extension", "skill"] as const
              : name === "pi-skill-code-review"
                ? ["skill"] as const
                : ["extension"] as const;
            return {
            source,
            name,
            version: npm ? (index === 0 ? "2.1.0" : "1.0.0") : "",
            installedVersion: npm ? (index === 0 ? "2.0.0" : "1.0.0") : null,
            updateAvailable: npm && index === 0,
            pinned: false,
            description: `Установленный пакет ${name} (mock-метаданные).`,
            author: name.startsWith("@") ? name.slice(1).split("/")[0] : "community",
            downloadsMonthly: 0,
            npmUrl: npm ? `https://www.npmjs.com/package/${name}` : "",
            repoUrl: source.startsWith("git:github.com/") ? `https://${source.slice(4)}` : null,
            homepage: null,
            keywords: [],
            updated: null,
            popularity: 0,
            resourceKinds: [...resourceKinds],
          }}) satisfies PiPackage[] as T;
      }
      case "pi_package_details":
        await sleep(160);
        return {
          readme: `# ${String(args.name)}\n\nГотовый пакет экосистемы pi.dev.\n\n## Возможности\n\n- Нативная интеграция с pi\n- Настройка через Library`,
          changelog: "## 1.0.0\n\n- Первый стабильный релиз.",
        } satisfies PackageDetails as T;
      case "list_pi_themes":
        return [
          {
            name: "midnight-aurora",
            path: "/mock/themes/midnight-aurora.json",
            source: "global",
            packageName: null,
            colors: { accent: "#62d6b5", border: "#34504b", borderMuted: "#283d3a", success: "#4ade80", error: "#fb7185", warning: "#fbbf24", muted: "#94a3b8", text: "#f8fafc", selectedBg: "#223532", userMessageBg: "#1d2928", customMessageBg: "#111918", toolPendingBg: "#111918" },
            resolvedColors: { accent: "#62d6b5", border: "#34504b", borderMuted: "#283d3a", success: "#4ade80", error: "#fb7185", warning: "#fbbf24", muted: "#94a3b8", text: "#f8fafc", selectedBg: "#223532", userMessageBg: "#1d2928", customMessageBg: "#111918", toolPendingBg: "#111918" },
            valid: true,
            error: null,
            enabled: true,
          },
        ].filter((theme) => !this.deletedThemes.has(theme.path)) as T;
      case "save_pi_theme":
        return `/Users/dev/.pi/agent/themes/${String((args.draft as { name?: string })?.name ?? "custom")}.json` as T;
      case "delete_pi_theme":
        this.deletedThemes.add(String(args.path));
        return undefined as T;
      case "export_pi_theme_package":
        return `${String(args.destination ?? "/Users/dev/Desktop")}/pi-theme-custom` as T;
      case "preview_configs":
        return [
          { name: "pi-app-ui", runtimeExecutable: "npm", runtimeArgs: ["run", "dev"], port: 1420 },
        ] satisfies LaunchConfig[] as T;
      case "preview_save_config":
        return undefined as T;
      case "preview_start": {
        const requestedCwd = String(args.cwd ?? "/Users/dev/pi-app");
        // Keep the original workspace start in flight long enough for the
        // switching regression test to prove that its response cannot attach
        // a server to another workspace's Preview pane.
        await sleep(requestedCwd.endsWith("/pi-app") ? 220 : 30);
        const serverId = `prev-${Date.now()}`;
        this.previewRuntime = {
          serverId,
          configName: String(args.name ?? "pi-app-ui"),
          cwd: requestedCwd,
          url: "http://localhost:1420",
          port: 1420,
          running: true,
          ready: true,
          httpStatus: "200",
          startedAtMs: Date.now(),
          lastActivityMs: Date.now(),
          logs: ["> vite", "VITE ready in 240 ms", "➜ Local: http://localhost:1420/"],
        };
        void (async () => {
          for (const l of ["> vite", "VITE ready in 240 ms", "➜ Local: http://localhost:1420/"]) {
            await sleep(300);
            this.emit("preview-output", { serverId, line: l, done: false });
          }
        })();
        return { serverId, url: "http://localhost:1420", port: 1420 } satisfies PreviewHandle as T;
      }
      case "preview_status":
        return (this.previewRuntime && this.previewRuntime.cwd === String(args.cwd)
          ? this.previewRuntime
          : null) as T;
      case "preview_stop":
        this.previewRuntime = null;
        return undefined as T;
      case "preview_touch":
        if (this.previewRuntime) this.previewRuntime.lastActivityMs = Date.now();
        return undefined as T;
      case "read_pi_config": {
        const name = String(args.name);
        const content = name === "settings" ? this.settings : name === "mcp" ? this.mcp : this.models;
        // Keep reads observably asynchronous so UI regressions cannot assume
        // that config I/O always wins a race against a user's next edit.
        await sleep(80);
        return { path: `~/.pi/agent/${name}.json`, content, exists: true } satisfies ConfigFile as T;
      }
      case "read_project_settings": {
        const cwd = String(args.cwd);
        return {
          path: `${cwd}/.pi/settings.json`,
          content: this.projectSettings.get(cwd) ?? "{}",
          exists: this.projectSettingsExists.has(cwd),
        } satisfies ConfigFile as T;
      }
      case "write_project_settings": {
        const cwd = String(args.cwd);
        this.projectSettings.set(cwd, String(args.content));
        this.projectSettingsExists.add(cwd);
        return undefined as T;
      }
      case "read_project_pi_config": {
        const cwd = String(args.cwd);
        const name = String(args.name);
        return {
          path: `${cwd}/.pi/${name}.json`,
          content: name === "settings"
            ? this.projectSettings.get(cwd) ?? "{}"
            : this.projectMcp.get(cwd) ?? "{}",
          exists: name === "settings"
            ? this.projectSettingsExists.has(cwd)
            : this.projectMcpExists.has(cwd),
        } satisfies ConfigFile as T;
      }
      case "write_project_pi_config":
      case "write_project_pi_config_if_unchanged": {
        const cwd = String(args.cwd);
        const name = String(args.name);
        const current = name === "settings"
          ? this.projectSettings.get(cwd) ?? "{}"
          : this.projectMcp.get(cwd) ?? "{}";
        if (cmd === "write_project_pi_config_if_unchanged" && current !== String(args.expectedContent)) {
          throw new Error("CONFIG_CONFLICT: файл изменился после чтения");
        }
        if (name === "settings") {
          this.projectSettings.set(cwd, String(args.content));
          this.projectSettingsExists.add(cwd);
        } else {
          this.projectMcp.set(cwd, String(args.content));
          this.projectMcpExists.add(cwd);
        }
        return undefined as T;
      }
      case "write_pi_config":
      case "write_pi_config_if_unchanged": {
        const name = String(args.name);
        const content = String(args.content);
        const current = name === "settings" ? this.settings : name === "mcp" ? this.mcp : this.models;
        if (cmd === "write_pi_config_if_unchanged" && current !== String(args.expectedContent)) {
          throw new Error("CONFIG_CONFLICT: файл изменился после чтения");
        }
        if (name === "settings") this.settings = content;
        else if (name === "mcp") this.mcp = content;
        else this.models = content;
        return undefined as T;
      }
      case "set_extension_resource_enabled": {
        const projectScope = String(args.scope) === "project";
        const cwd = String(args.cwd ?? "");
        const parsed = JSON.parse(
          projectScope ? this.projectSettings.get(cwd) ?? "{}" : this.settings,
        ) as Record<string, unknown>;
        const key = ({ extension: "extensions", skill: "skills", theme: "themes", prompt: "prompts" } as const)[String(args.kind) as "extension" | "skill" | "theme" | "prompt"];
        const identifier = String(args.packageIdentifier);
        let matched = false;
        const packages = Array.isArray(parsed.packages) ? parsed.packages.map((raw) => {
          const source = typeof raw === "string" ? raw : raw && typeof raw === "object" && "source" in raw ? String(raw.source) : "";
          if (source !== identifier && packageNameFromSpec(source) !== identifier) return raw;
          if (String(args.kind) === "extension" && args.enabled === false && source.includes("harness-extension")) {
            throw new Error("harness-extension является ядром приложения и не может быть отключён");
          }
          matched = true;
          const next: Record<string, unknown> = typeof raw === "string" ? { source: raw } : { ...raw as Record<string, unknown> };
          if (Boolean(args.enabled)) delete next[key];
          else next[key] = [];
          return Object.keys(next).length === 1 ? source : next;
        }) : [];
        if (!matched) throw new Error(`package is not configured: ${identifier}`);
        const content = JSON.stringify({ ...parsed, packages }, null, 2) + "\n";
        if (projectScope) {
          this.projectSettings.set(cwd, content);
          this.projectSettingsExists.add(cwd);
        } else this.settings = content;
        return content as T;
      }
      case "list_skills":
        return [
          {
            name: "code-review",
            description: "Review the current diff for bugs",
            path: "/mock/skills/code-review/SKILL.md",
            sourceDir: "~/GithubControl/pi-app/agent-skills/code-review/SKILL.md",
            scope: "global",
            origin: "configured",
            packageName: null,
            enabled: true,
            valid: true,
            warning: null,
            disableModelInvocation: false,
            shadowedBy: null,
          },
          {
            name: "librarian",
            description: "Search the web and build a cited research answer",
            path: "/mock/packages/pi-web-access/skills/librarian/SKILL.md",
            sourceDir: "npm:pi-web-access",
            scope: "global",
            origin: "package",
            packageName: "pi-web-access",
            enabled: true,
            valid: true,
            warning: null,
            disableModelInvocation: false,
            shadowedBy: null,
          },
          {
            name: "ship",
            description: "Verify and prepare a finished change",
            path: "/mock/skills/ship/SKILL.md",
            sourceDir: "~/GithubControl/pi-app/agent-skills/ship/SKILL.md",
            scope: "global",
            origin: "configured",
            packageName: null,
            enabled: true,
            valid: true,
            warning: null,
            disableModelInvocation: true,
            shadowedBy: null,
          },
          {
            name: "project-audit",
            description: "Audit project-local changes",
            path: "/Users/dev/pi-app/.agents/skills/project-audit/SKILL.md",
            sourceDir: "/Users/dev/pi-app/.agents/skills",
            scope: "project",
            origin: "auto",
            packageName: null,
            enabled: true,
            valid: true,
            warning: null,
            disableModelInvocation: false,
            shadowedBy: null,
          },
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
          { kind: "agent", id: "mock-agent-1", label: "/Users/demo/pi-app", pid: 4242, rssMb: 412.5, procs: 6, uptimeMs: 754000 },
          { kind: "preview", id: "srv-1", label: "/Users/demo/pi-app", pid: 4310, rssMb: 156.2, procs: 3, uptimeMs: 182000 },
          { kind: "app", id: "app", label: "pi-app (процесс приложения)", pid: 100, rssMb: 220.7, procs: 1, uptimeMs: 3600000 },
        ] as T;
      case "spawn_agent": {
        const id = `mock-agent-${this.agentSeq++}`;
        // как реальный pi: агент открывается на переданной сессии (get_state
        // затем вернёт её в sessionFile). null → новая сессия.
        const opts = (args.opts ?? {}) as { cwd?: string; sessionPath?: string | null };
        const cwd = opts.cwd ?? "/Users/dev/pi-app";
        this.agentCwds.set(id, cwd);
        this.agentSessions.set(id, opts.sessionPath ?? `${this.mockSessionRoot(cwd)}/new-${Date.now()}.jsonl`);
        this.steerQueues.set(id, []);
        this.followUpQueues.set(id, []);
        return id as T;
      }
      case "agent_send": {
        const line = JSON.parse(String(args.line));
        const agentId = String(args.agentId);
        let currentSession = this.agentSessions.get(agentId) ?? "/mock/a/live.jsonl";
        const steerQueue = this.agentQueue(this.steerQueues, agentId);
        const followUpQueue = this.agentQueue(this.followUpQueues, agentId);
        if (line.type === "prompt") {
          const prompt = String(line.message ?? "");
          if (prompt.startsWith("/pi-rewind ")) {
            this.rewindTargetBySession.set(currentSession, prompt.slice("/pi-rewind ".length).trim());
            this.emitAgent(agentId, { type: "response", id: line.id, command: "prompt", success: true, data: { sameSession: true } });
          } else {
            void this.runScript(agentId, prompt);
          }
        } else if (line.type === "steer") {
          steerQueue.push({
            text: String(line.message ?? ""),
            images: Array.isArray(line.images) ? line.images as Record<string, unknown>[] : [],
          });
          this.emitAgent(agentId, {
            type: "queue_update",
            steering: steerQueue.map((item) => item.text),
            followUp: followUpQueue.map((item) => item.text),
          });
        } else if (line.type === "follow_up") {
          followUpQueue.push({
            text: String(line.message ?? ""),
            images: Array.isArray(line.images) ? line.images as Record<string, unknown>[] : [],
          });
          this.emitAgent(agentId, {
            type: "queue_update",
            steering: steerQueue.map((item) => item.text),
            followUp: followUpQueue.map((item) => item.text),
          });
        } else if (line.type === "extension_ui_response") {
          this.pendingUi.get(String(line.id))?.(line as Record<string, unknown>);
        } else if (line.type === "switch_session" && line.id) {
          currentSession = String(line.sessionPath ?? currentSession);
          this.agentSessions.set(agentId, currentSession);
          this.emitAgent(agentId, { type: "response", id: line.id, command: "switch_session", success: true, data: { cancelled: false } });
        } else if (line.type === "new_session" && line.id) {
          const cwd = this.agentCwds.get(agentId) ?? "/Users/dev/pi-app";
          currentSession = `${this.mockSessionRoot(cwd)}/new-${Date.now()}.jsonl`;
          this.agentSessions.set(agentId, currentSession);
          this.emitAgent(agentId, { type: "response", id: line.id, command: "new_session", success: true, data: {} });
        } else if (line.id) {
          await sleep(30);
          const data: Record<string, unknown> =
            line.type === "get_state"
              ? {
                  model: { id: "qwen-local", provider: "ollama", contextWindow: 262144, input: ["text", "image"] },
                  thinkingLevel: "high", isStreaming: false, sessionId: agentId, sessionFile: currentSession, messageCount: 2,
                }
              : line.type === "get_available_models"
                ? { models: [
                    { id: "qwen-local", provider: "ollama", reasoning: true, contextWindow: 262144, input: ["text", "image"] },
                    { id: "claude-sonnet-4", provider: "anthropic", reasoning: true, contextWindow: 200000 },
                  ] }
                : line.type === "get_session_stats"
                  ? {
                      tokens: { input: 12000, output: 800, cacheRead: 9000, cacheWrite: 400 },
                      cost: 0.05, userMessages: 3, assistantMessages: 3, toolCalls: 2, totalMessages: 8,
                      contextUsage: { tokens: 89_129, contextWindow: 262_144, percent: 34 },
                    }
                  : line.type === "set_auto_compaction"
                    ? {}
                  : line.type === "get_fork_messages"
                    ? { messages: currentSession.endsWith("/rewind.jsonl") ? [
                        { entryId: "rewind-u1", text: "Первый запрос остаётся в активной ветке" },
                        { entryId: "rewind-u2", text: "Второй запрос с изображением" },
                      ] : [
                        { entryId: "fe1", text: "Восстановленная сессия: что мы делали?" },
                        { entryId: "fe2", text: "Покажи демо стриминга" },
                      ] }
                  : line.type === "fork"
                    ? { text: "Покажи демо стриминга", cancelled: false }
                  : line.type === "get_commands"
                    ? { commands: [{ name: "plan", description: "Plan mode" }, { name: "review", description: "Review diff" }, { name: "pi-rewind", description: "Same-session rewind" }] }
                    : line.type === "get_messages"
                      ? {
                          messages: [
                            { role: "user", content: [{ type: "text", text: "Восстановленная сессия: что мы делали?" }] },
                            { role: "assistant", content: [{ type: "text", text: "Мы чинили гонку в супервизоре. История загружена через `get_messages` — можно продолжать." }], model: "qwen-local", provider: "ollama" },
                          ],
                        }
                      : {};
          this.emitAgent(agentId, { type: "response", id: line.id, command: line.type, success: true, data });
        }
        return undefined as T;
      }
      case "kill_agent": {
        const agentId = String(args.agentId);
        this.agentSessions.delete(agentId);
        this.agentCwds.delete(agentId);
        this.steerQueues.delete(agentId);
        this.followUpQueues.delete(agentId);
        return undefined as T;
      }
      case "list_agents":
        return [] as T;
      case "git_is_repo":
        return true as T;
      case "git_summary": {
        const cwd = String(args.cwd ?? "");
        await sleep(cwd.endsWith("/pi-app") ? 240 : 30);
        return {
          isRepo: true,
          branch: cwd.endsWith("/website") ? "website-main" : "main",
          insertions: 14723,
          deletions: 1,
          changedFiles: 2,
          hasRemote: true,
          ahead: 2,
          behind: 0,
        } as T;
      }
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
          assetUrl: "https://github.com/NickLitwinow/pi-app/releases/download/v0.2.0/Pi-universal.dmg",
          checked: true, behind: 2, ahead: 0,
          dirtyFiles: [], autoResettableFiles: [], diverged: false, error: null,
        } as T;
      }
      case "check_pi_update": {
        await sleep(220);
        return {
          currentVersion: "0.80.3",
          latestVersion: "0.80.6",
          updateAvailable: true,
          checked: true,
          error: null,
        } satisfies PiUpdateInfo as T;
      }
      case "app_update_run": {
        const runId = `upd-${Date.now()}`;
        void (async () => {
          for (const l of ["▶ Обновление исходников (git pull)", "$ git pull --ff-only", "Already up to date.", "▶ Установка зависимостей (npm ci)", "$ npm ci --no-audit --no-fund", "▶ Сборка приложения (tauri build)", "Compiling pi-app…", "✓ Готово. Нажмите «Перезапустить»."]) {
            await sleep(500);
            this.emit("app-update-output", { runId, line: l, done: false });
          }
          await sleep(400);
          this.emit("app-update-output", { runId, done: true, code: 0 });
        })();
        return runId as T;
      }
      case "app_update_install_release": {
        const runId = `release-${Date.now()}`;
        void (async () => {
          for (const l of ["▶ Фоновая загрузка и установка готового релиза", "Downloading Pi-universal.dmg…", "✓ Новая версия установлена. Перезапустите приложение, когда будет удобно."]) {
            await sleep(350);
            this.emit("app-update-output", { runId, line: l, done: false });
          }
          this.emit("app-update-output", { runId, done: true, code: 0 });
        })();
        return runId as T;
      }
      case "relaunch_app":
        return undefined as T;
      case "set_pi_path":
        return { path: String(args.path ?? "/opt/homebrew/bin/pi"), version: "0.80.3 (mock)", agentDir: "~/.pi/agent" } satisfies PiInfo as T;
      case "write_permission_preset":
        this.permissionModes.set(String(args.cwd), String(args.mode));
        return undefined as T;
      case "read_permission_mode":
        return (this.permissionModes.get(String(args.cwd)) ?? null) as T;
      case "read_file_base64":
        return { data: "iVBORw0KGgo=", mimeType: "image/png", sizeBytes: 8 } as T;
      case "git_checkpoint":
        return "abc1234" as T;
      case "git_status": {
        const cwd = String(args.cwd ?? "");
        await sleep(cwd.endsWith("/pi-app") ? 240 : 30);
        return (cwd.endsWith("/website")
          ? [
              { status: " M", path: "src/site.css" },
              { status: "??", path: "src/Hero.tsx" },
            ]
          : [
              { status: " M", path: "src/lib/reducer.ts" },
              { status: "??", path: "src/components/NewFile.tsx" },
            ]) as T;
      }
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
      case "git_restore_run_files":
      case "git_restore_checkpoint":
      case "confirm_app_exit":
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

/** Образец анимированного SVG (SMIL) — проверка пути «векторный аватар» в моке. */
const MOCK_ANIMATED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<g fill="none" stroke="#d97757" stroke-width="8" stroke-linecap="round">' +
  '<line x1="50" y1="50" x2="50" y2="10"/><line x1="50" y1="50" x2="90" y2="50"/>' +
  '<line x1="50" y1="50" x2="50" y2="90"/><line x1="50" y1="50" x2="10" y2="50"/>' +
  '<animateTransform attributeName="transform" type="rotate" from="0 50 50" to="360 50 50" dur="3s" repeatCount="indefinite"/>' +
  "</g></svg>";

/** Минимальный валидный Lottie: квадрат меняет прозрачность (проверка плеера). */
const MOCK_LOTTIE_JSON = JSON.stringify({
  v: "5.7.4", fr: 30, ip: 0, op: 60, w: 100, h: 100, nm: "mock", ddd: 0, assets: [],
  layers: [{
    ddd: 0, ind: 1, ty: 4, nm: "sq", sr: 1,
    ks: {
      o: { a: 1, k: [{ t: 0, s: [100], e: [20] }, { t: 60, s: [20] }] },
      r: { a: 0, k: 0 }, p: { a: 0, k: [50, 50, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] },
    },
    ao: 0,
    shapes: [{
      ty: "gr",
      it: [
        { ty: "rc", d: 1, s: { a: 0, k: [60, 60] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 12 } },
        { ty: "fl", c: { a: 0, k: [0.85, 0.47, 0.34, 1] }, o: { a: 0, k: 100 } },
        { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
      ],
    }],
    ip: 0, op: 60, st: 0, bm: 0,
  }],
});

/** Формат длительности как у pi-claude-style-tools: 6s / 2m 57s / 1h 2m 3s. */
function mockDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

let backendPromise: Promise<Backend> | null = null;

export function getBackend(): Promise<Backend> {
  if (!backendPromise) {
    backendPromise = isTauri() ? makeTauriBackend() : Promise.resolve(new MockBackend());
  }
  return backendPromise;
}
