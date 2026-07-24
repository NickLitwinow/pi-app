// ---------- pi RPC / session domain types ----------

export type Role = "user" | "assistant" | "toolResult";

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  [k: string]: unknown;
}

export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { input?: number; output?: number; total?: number };
}

export interface RunFileChange {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "binary";
  additions: number;
  deletions: number;
}

export interface RunMeta {
  id: string;
  durationMs: number;
  toolCallIds: string[];
  checkpoint?: string | null;
  files?: RunFileChange[];
}

export interface ChatMessage {
  role: Role | string;
  content: ContentBlock[] | string;
  usage?: Usage;
  model?: string;
  provider?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
  /** pi-app-only live metadata; persisted pi messages remain untouched. */
  run?: RunMeta;
  [k: string]: unknown;
}

export interface ModelInfo {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  [k: string]: unknown;
}

export interface AgentState {
  model?: ModelInfo;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  steeringMode?: string;
  followUpMode?: string;
  sessionId?: string;
  sessionPath?: string;
  sessionFile?: string;
  sessionName?: string;
  autoCompactionEnabled?: boolean;
  messageCount?: number;
  pendingMessageCount?: number;
  [k: string]: unknown;
}

export interface ContextUsage {
  tokens?: number | null;
  contextWindow?: number;
  percent?: number | null;
}

export interface SessionStats {
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  cost?: number;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  totalMessages?: number;
  contextUsage?: ContextUsage;
  [k: string]: unknown;
}

// ---------- live chat view model ----------

export interface ToolExec {
  callId: string;
  name: string;
  args: unknown;
  output: string;
  isError: boolean;
  done: boolean;
}

export interface ExtUiRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  [k: string]: unknown;
}

export interface Toast {
  id: number;
  kind: "info" | "error" | "success" | "warning";
  text: string;
}

export interface TimelineItem {
  key: string;
  msg: ChatMessage;
  /** Добавлено оптимистично при отправке; эхо от pi «поглощает» ровно один такой элемент. */
  optimistic?: boolean;
  /** User-эхо без optimistic-пары: сообщение в сессию отправило расширение (pi-goal и т.п.). */
  viaExtension?: boolean;
}

export interface ComposerAttachment {
  data: string;
  mimeType: string;
  name: string;
  /** Original decoded byte size when known. Persisted with the Pi image block
   * so rewind/history can present useful metadata without decoding base64. */
  sizeBytes?: number;
}

export type WorkflowStepStatus = "pending" | "running" | "waiting" | "passed" | "failed" | "skipped";

export interface WorkflowStepView {
  id: string;
  label: string;
  kind: "plan" | "research" | "build" | "preview" | "gate" | "evaluate" | "review";
  deps: string[];
  status: WorkflowStepStatus;
  acceptance: string;
  required: boolean;
  owner: "orchestrator" | "researcher" | "executor" | "preview-runner" | "gate-runner" | "evaluator" | "human";
  maxAttempts: number;
  command?: string;
  attempts: number;
  detail?: string;
  failureReason?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface WorkflowEventView {
  id: string;
  stepId?: string;
  type: "created" | "started" | "passed" | "failed" | "waiting" | "note" | "rewound";
  at: number;
  message: string;
}

export interface WorkflowViewState {
  version: 3;
  runId: string;
  createdAt: number;
  updatedAt: number;
  objective: string;
  profile: "feature" | "bug" | "chore" | "hotfix" | "research" | "assessment";
  status: "active" | "needs-human" | "blocked" | "completed";
  blockedStepId?: string;
  blockedReason?: string;
  terminationReason?: string;
  approved: boolean;
  editsPending: boolean;
  changedFiles: string[];
  evaluatorTaskId?: string;
  intent: {
    primary: "trivial" | "assessment" | "research" | "debug" | "build";
    profile: WorkflowViewState["profile"];
    risk: "low" | "medium" | "high";
    needsResearch: boolean;
    needsPreview: boolean;
    allowsMutation: boolean;
    allowsDeletion: boolean;
    requiresPlan: boolean;
    requiresSandbox: boolean;
    requiresEvaluator: boolean;
    requiresHumanApproval: boolean;
    signals: string[];
  };
  steps: WorkflowStepView[];
  events: WorkflowEventView[];
}

export interface PreviewRuntimeView {
  status: "idle" | "starting" | "running" | "ready" | "stopped" | "failed";
  serverId?: string;
  configName?: string;
  cwd?: string;
  url?: string;
  port?: number;
  running?: boolean;
  ready?: boolean;
  httpStatus?: string;
  startedAtMs?: number;
  lastActivityMs?: number;
  leaseUntilMs?: number;
  logs?: string[];
  browserOpened?: boolean;
  browserInspected?: boolean;
  evidence?: string[];
  error?: string;
  updatedAt: number;
  source: "agent" | "user";
}

export interface BackgroundTaskView {
  id: string;
  type: string;
  description: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  result?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  /** Last liveness signal from the harness for a queued/running task. */
  heartbeatAt?: number;
  durationMs?: number;
  tokens?: number;
  branch?: string;
  baseSha?: string;
  worktreePath?: string;
  outputFile?: string;
  prompt?: string;
  transcript?: string;
  diff?: string;
  mergedCommit?: string;
  evaluatorProtocolVersion?: number;
  evaluatorQuorum?: boolean;
  priority?: "high" | "normal" | "low";
  queuePosition?: number;
  etaMs?: number;
  blockedReason?: string;
}

export interface CompactionRecord {
  version?: number;
  at: number;
  reason?: string;
  summary: string;
  tokensBefore?: number;
  firstKeptEntryId?: string;
}

export interface BranchRecord {
  version?: number;
  at: number;
  type?: "rewind" | "return";
  targetEntryId?: string;
  newLeafId?: string | null;
  abandonedLeafId?: string | null;
  leafId?: string;
  stoppedTaskIds?: string[];
  targetPreview?: string;
  abandonedEntryCount?: number;
  abandonedUserMessages?: string[];
}

export interface StructuredCheckpoint {
  version?: number;
  at: number;
  runId?: string;
  objective: string;
  profile?: string;
  changedFiles?: string[];
  decisions?: string[];
  gateEvidence?: Array<{ id: string; status: WorkflowStepStatus; command?: string; detail?: string }>;
  risks?: string[];
  steps?: Array<{ id: string; status: WorkflowStepStatus; detail?: string }>;
  nextReadySteps?: string[];
  nextAction?: string;
  context?: { percent?: number; tokens?: number | null; contextWindow?: number };
}

export interface PlannedTaskView {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatState {
  items: TimelineItem[];
  toolExecs: Record<string, ToolExec>;
  /** Live partial assistant message (pi sends the full accumulated message in each update). */
  streaming: ChatMessage | null;
  /** Ход идёт: строго agent_start … agent_end. Между шагами хода pi шлёт
   *  turn_end/turn_start — они ход НЕ завершают. */
  isStreaming: boolean;
  /** Когда агент начал текущий ран (для таймера в processing-индикаторе). */
  streamStartedAt: number | null;
  activeRunId: string | null;
  activeRunToolIds: string[];
  /** Ран, прикреплённый к сообщению последним agent_end (для post-run артефактов). */
  lastRunId: string | null;
  isCompacting: boolean;
  retryActive: boolean;
  retryInfo: string | null;
  queue: { steering: string[]; followUp: string[] };
  uiRequests: ExtUiRequest[];
  toasts: Toast[];
  statusEntries: Record<string, string>;
  widgets: Record<string, string>;
  workflow: WorkflowViewState | null;
  /** Native dev-server state emitted by the harness for this session. */
  previewRuntime: PreviewRuntimeView | null;
  /** Latest persisted snapshot emitted by rpiv-todo's model-facing tool. */
  plannedTasks: PlannedTaskView[];
  backgroundTasks: BackgroundTaskView[];
  compactions: CompactionRecord[];
  branches: BranchRecord[];
  structuredCheckpoints: StructuredCheckpoint[];
  editorPrefill: string | null;
  editorAttachments: ComposerAttachment[] | null;
  editorContextFiles: string[] | null;
  lastError: string | null;
  seq: number;
}

export function emptyChatState(): ChatState {
  return {
    items: [],
    toolExecs: {},
    streaming: null,
    isStreaming: false,
    streamStartedAt: null,
    activeRunId: null,
    activeRunToolIds: [],
    lastRunId: null,
    isCompacting: false,
    retryActive: false,
    retryInfo: null,
    queue: { steering: [], followUp: [] },
    uiRequests: [],
    toasts: [],
    statusEntries: {},
    widgets: {},
    workflow: null,
    previewRuntime: null,
    plannedTasks: [],
    backgroundTasks: [],
    compactions: [],
    branches: [],
    structuredCheckpoints: [],
    editorPrefill: null,
    editorAttachments: null,
    editorContextFiles: null,
    lastError: null,
    seq: 0,
  };
}

// ---------- backend (Rust) DTOs ----------

export interface PiInfo {
  path: string | null;
  version: string | null;
  agentDir: string;
}

export interface ProjectInfo {
  dir: string;
  cwd: string;
  name: string;
  sessionCount: number;
  lastModifiedMs: number;
}

export interface SessionMeta {
  path: string;
  id: string;
  cwd: string;
  name: string | null;
  createdAt: string | null;
  modifiedMs: number;
  messageCount: number;
  userSnippet: string | null;
  costTotal: number;
  tokensIn: number;
  tokensOut: number;
}

export interface SearchHit {
  path: string;
  cwd: string;
  entryId: string | null;
  timestamp: string | null;
  role: string;
  snippet: string;
}

export interface AppConfig {
  editor: string;
  processLimit: number;
  processLimitAuto?: boolean;
  /** Write boundary for newly spawned agent process trees. */
  agentSandboxMode?: "workspace-write" | "unrestricted";
  idleKillSecs: number;
  previewIdleKillSecs?: number;
  theme: string;
  uiScale: number;
  piPath?: string | null;
  sidebarCollapsed?: boolean;
  sidebarWidth?: number;
  sourceRepoPath?: string | null;
  automaticUpdates?: boolean;
  displayName?: string | null;
  piRetryStallTimeoutMs?: number;
  /** Язык интерфейса: "ru" | "en"; не задан → авто по локали ОС (§5.11-7). */
  lang?: string;
  /** UI-only aliases keyed by provider/model-id; runtime model identity is unchanged. */
  modelAliases?: Record<string, string>;
  accentColor?: string;
  /** Optional icon accent for the Custom appearance preset. */
  iconColor?: string;
  /** Background color of the minimalist App/Dock icon. */
  appIconBackground?: string;
  /** Visual surface preset. Does not affect the runtime model/provider. */
  appearancePreset?: "chatgpt" | "claude" | "gemini" | "custom";
  visualEffects?: boolean;
  interfaceDensity?: "compact" | "comfortable";
  transcriptMode?: "summary" | "normal" | "verbose";
  /** Composer send shortcut; the other Enter variant inserts a newline. */
  sendKeyBehavior?: "enter" | "mod-enter";
  /** Resolved GUI palette derived from a pi theme or the built-in editor. */
  customTheme?: AppThemePalette | null;
  libraryOnboardingSeen?: boolean;
  /** Visual identity keyed by the stable provider/model-id pair. */
  modelAvatars?: Record<string, ModelAvatarConfig>;
}

export interface ModelAvatarConfig {
  kind?: "preset" | "path";
  value?: string;
  workingKind?: "preset" | "path";
  workingValue?: string;
}

export interface AppThemePalette {
  name: string;
  background: string;
  sidebar: string;
  raised: string;
  active: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
}

export interface PiThemeInfo {
  name: string;
  path: string;
  source: "global" | "project" | "package";
  packageName: string | null;
  colors: Record<string, string | number>;
  resolvedColors: Record<string, string>;
  valid: boolean;
  error: string | null;
}

export interface AppUpdateInfo {
  currentVersion: string;
  currentSha: string;
  sourceRepo: string | null;
  sourceRepoValid: boolean;
  latest: string | null;
  latestKind: "release" | "commit" | "none";
  notes: string;
  htmlUrl: string;
  assetUrl: string | null;
  updateAvailable: boolean;
  checked: boolean;
  /** Коммитов позади/впереди upstream (локальный git-путь). */
  behind: number;
  ahead: number;
  /** Незакоммиченные правки пользователя — пересборка из исходников невозможна. */
  dirtyFiles: string[];
  /** Артефакты сборки, которые обновление откатит само (с бэкапом). */
  autoResettableFiles: string[];
  /** Ветки разошлись — `git pull --ff-only` не пройдёт. */
  diverged: boolean;
  error: string | null;
}

export interface SessionGroup {
  id: string;
  name: string;
  cwd: string;
}

export interface PinnedMessage {
  id: string;
  text: string;
  role: string;
  ts: number;
}

export interface StatusEntry {
  status: string;
  path: string;
}

export interface DayStat {
  date: string;
  cost: number;
  messages: number;
  input: number;
  output: number;
  /** Сессии, стартовавшие в этот день. */
  sessions: number;
}

export interface AnalyticsOverview {
  totals: {
    cost: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    sessions: number;
    messages: number;
  };
  perDay: DayStat[];
  perModel: { model: string; cost: number; input: number; output: number; messages: number }[];
  /** Сообщения по часу суток (24 значения) — для «пикового часа». */
  perHour: number[];
}

// ---------- marketplace (pi.dev community packages via npm registry) ----------

export type PackageKind = "extension" | "skill" | "theme" | "prompt";

export type PackageSetting =
  | string
  | ({ source: string } & Partial<Record<"extensions" | "skills" | "themes" | "prompts", string[]>>);

export interface PiPackage {
  /** Exact settings.json package spec for installed rows (npm/git/local). */
  source?: string | null;
  name: string;
  version: string;
  description: string;
  author: string;
  downloadsMonthly: number;
  npmUrl: string;
  repoUrl: string | null;
  homepage: string | null;
  keywords: string[];
  updated: string | null;
  popularity: number;
  /** Installed version from pi's private npm root; absent for catalog-only rows. */
  installedVersion?: string | null;
  updateAvailable?: boolean;
  pinned?: boolean;
  /** Resource kinds exposed by the installed manifest or conventional resource
   * directories. Missing means discovery was inconclusive, so keep it visible. */
  resourceKinds?: PackageKind[] | null;
}

export interface PiUpdateInfo {
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  checked: boolean;
  error: string | null;
}

export interface PackageSearch {
  total: number;
  objects: PiPackage[];
}

export interface PackageDetails {
  readme: string | null;
  changelog: string | null;
}

// ---------- preview (dev-server launcher) ----------

export interface LaunchConfig {
  name: string;
  runtimeExecutable: string;
  runtimeArgs: string[];
  port: number;
}

export interface PreviewHandle {
  serverId: string;
  url: string;
  port: number;
}

export interface PreviewStatus extends PreviewHandle {
  configName: string;
  cwd: string;
  running: boolean;
  ready: boolean;
  httpStatus?: string;
  startedAtMs: number;
  lastActivityMs: number;
  leaseUntilMs?: number;
  logs: string[];
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  sourceDir: string;
  scope: "global" | "project" | string;
}

export interface ConfigFile {
  path: string;
  content: string;
  exists: boolean;
}

export interface Checkpoint {
  hash: string;
  label: string;
  ts: number;
}

export interface GitSummary {
  isRepo: boolean;
  branch: string;
  insertions: number;
  deletions: number;
  changedFiles: number;
  hasRemote: boolean;
  ahead: number;
  behind: number;
}

export interface BranchInfo {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  lastSubject: string;
  lastTs: number;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  ts: number;
  subject: string;
  refs: string;
}
