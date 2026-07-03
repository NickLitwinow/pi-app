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
}

export interface ChatState {
  items: TimelineItem[];
  toolExecs: Record<string, ToolExec>;
  /** Live partial assistant message (pi sends the full accumulated message in each update). */
  streaming: ChatMessage | null;
  isStreaming: boolean;
  /** Когда агент начал текущий ран (для таймера в processing-индикаторе). */
  streamStartedAt: number | null;
  isCompacting: boolean;
  retryActive: boolean;
  retryInfo: string | null;
  queue: { steering: string[]; followUp: string[] };
  uiRequests: ExtUiRequest[];
  toasts: Toast[];
  statusEntries: Record<string, string>;
  widgets: Record<string, string>;
  editorPrefill: string | null;
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
    isCompacting: false,
    retryActive: false,
    retryInfo: null,
    queue: { steering: [], followUp: [] },
    uiRequests: [],
    toasts: [],
    statusEntries: {},
    widgets: {},
    editorPrefill: null,
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
  idleKillSecs: number;
  theme: string;
  uiScale: number;
  piPath?: string | null;
  sidebarCollapsed?: boolean;
  sidebarWidth?: number;
  sourceRepoPath?: string | null;
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
  updateAvailable: boolean;
  checked: boolean;
  /** Коммитов позади/впереди upstream (локальный git-путь). */
  behind: number;
  ahead: number;
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
  perDay: { date: string; cost: number; messages: number }[];
  perModel: { model: string; cost: number; input: number; output: number; messages: number }[];
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  sourceDir: string;
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
