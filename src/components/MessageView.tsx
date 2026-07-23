import { createContext, memo, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getBackend } from "../lib/backend";
import { confirmDialog, messageDialog } from "../lib/dialog";
import { pluralRu } from "../lib/i18n";
import { stripAnsi } from "../lib/markdown";
import { modelAliasKey, modelIdDisplayName } from "../lib/models";
import { contentText } from "../lib/reducer";
import { checkpointForUserTurn } from "../lib/rewind";
import { parseSequentialThought, type SequentialThought } from "../lib/sequential-thinking";
import {
  formatRunDuration,
  parseTurnTiming,
  splitTrailingTurnTiming,
  timingFromWorkedMeta,
  type TurnTiming,
} from "../lib/turn-timing";
import type { AppConfig, ChatMessage, ContentBlock, ModelInfo, RunMeta, ToolExec } from "../lib/types";
import type { ActivityStep } from "../lib/transcript";
import { forkFromMessage, msgPinId, notifyChat, rewindToMessage, toggleMessagePin, useStore } from "../state/store";
import { ModelAvatar } from "./AgentAvatar";
import {
  CheckIcon,
  ChevronIcon,
  CopyIcon,
  ErrorIcon,
  ExternalIcon,
  FilesIcon,
  ForkIcon,
  InfoIcon,
  PinIcon,
  PinOffIcon,
  RewindIcon,
  RevertIcon,
  ReviewIcon,
  SuccessIcon,
  TimeIcon,
  WarnIcon,
} from "./icons";
import { Markdown } from "./Markdown";

// ---------- expand state shared across virtual scrolling ----------

/**
 * Лента виртуализирована: Virtuoso размонтирует ушедшие с экрана элементы. Если
 * держать «раскрыто» в локальном useState, то (1) раскрытая сводка схлопывается
 * при возврате скроллом и (2) её высота скачет относительно кэша размеров
 * Virtuoso — лента начинает дёргаться и не даёт долистать до низа. Поэтому
 * состояние живёт выше списка и переживает размонтирование.
 */
const ExpandedCtx = createContext<{ isOpen: (id: string) => boolean; toggle: (id: string) => void } | null>(null);

export function ExpandedProvider({ children }: { children: ReactNode }) {
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const value = useMemo(
    () => ({
      isOpen: (id: string) => openIds.has(id),
      toggle: (id: string) =>
        setOpenIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        }),
    }),
    [openIds],
  );
  return <ExpandedCtx.Provider value={value}>{children}</ExpandedCtx.Provider>;
}

/** Раскрытие по стабильному id; без провайдера/id — обычный локальный стейт. */
function useExpanded(id: string | undefined): [boolean, () => void] {
  const ctx = useContext(ExpandedCtx);
  const [local, setLocal] = useState(false);
  if (!ctx || !id) return [local, () => setLocal((value) => !value)];
  return [ctx.isOpen(id), () => ctx.toggle(id)];
}

// ---------- thinking ----------

function ThinkingBlock({
  text,
  streaming,
  forceOpen,
  blockId,
}: {
  text: string;
  streaming?: boolean;
  forceOpen?: boolean;
  blockId?: string;
}) {
  const [open, toggle] = useExpanded(blockId);
  // forceOpen — идущий ход: рассуждения видны живьём до самого конца хода
  // (иначе они схлопывались, едва начинал приходить текст), затем уезжают в «Worked for».
  const shown = open || streaming || forceOpen;
  return (
    <div className="thinking">
      <div className="t-head" onClick={toggle}>
        <ChevronIcon open={shown} />
        {streaming ? "Размышляет…" : `Размышления (${text.trim().length} символов)`}
      </div>
      {shown && <div className="t-body">{stripAnsi(text.trim())}</div>}
    </div>
  );
}

// ---------- tool call cards ----------

function argPath(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  for (const k of ["path", "file_path", "filePath", "file"]) {
    if (typeof args[k] === "string") return args[k] as string;
  }
  return null;
}

function toolSummary(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  if (name === "bash" && typeof args.command === "string") return args.command;
  const p = argPath(args);
  if (p) return p;
  try {
    const s = JSON.stringify(args);
    return s.length > 120 ? s.slice(0, 120) + "…" : s;
  } catch {
    return "";
  }
}

function MiniDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const dels = oldText.split("\n").slice(0, 40);
  const adds = newText.split("\n").slice(0, 40);
  return (
    <div className="minidiff">
      {dels.map((l, i) => (
        <div key={`d${i}`} className="dl del">
          - {l}
        </div>
      ))}
      {adds.map((l, i) => (
        <div key={`a${i}`} className="dl add">
          + {l}
        </div>
      ))}
    </div>
  );
}

async function openPath(cwd: string | undefined, rawPath: string) {
  const editor = useStore.getState().appConfig.editor;
  const path = rawPath.startsWith("/") || !cwd ? rawPath : `${cwd.replace(/\/$/, "")}/${rawPath}`;
  const be = await getBackend();
  await be.invoke("open_in_editor", { editor, path, line: null }).catch(() => {});
}

function SequentialThoughtCard({
  thought,
  running,
  isError,
  expanded,
  cardId,
}: {
  thought: SequentialThought;
  running: boolean;
  isError: boolean;
  expanded?: boolean;
  cardId?: string;
}) {
  const [open, toggle] = useExpanded(cardId);
  const shown = open || expanded;
  return (
    <div className={`thought-card ${isError ? "error" : ""}`}>
      <button className="thought-card-head" onClick={toggle} aria-expanded={shown}>
        <span className="thought-node">{running ? <span className="spinner" /> : thought.thoughtNumber}</span>
        <span className="thought-title">Мысль {thought.thoughtNumber}/{thought.totalThoughts}</span>
        {thought.isRevision && <span className="thought-badge revision">ревизия {thought.revisesThought ?? ""}</span>}
        {thought.branchId && <span className="thought-badge">ветка {thought.branchId}</span>}
        <span className="thought-preview">{thought.thought}</span>
        <ChevronIcon open={shown} />
      </button>
      {shown && (
        <div className="thought-card-body">
          <div>{thought.thought}</div>
          <footer>
            {thought.branchFromThought != null && <span>Ответвление от мысли {thought.branchFromThought}</span>}
            {thought.needsMoreThoughts && <span>Цепочка расширена</span>}
            <span className={thought.nextThoughtNeeded ? "active" : "done"}>
              {thought.nextThoughtNeeded ? "Следующий шаг нужен" : "Цепочка завершена"}
            </span>
          </footer>
        </div>
      )}
    </div>
  );
}

export function ToolCallCard({
  block,
  exec,
  cwd,
  expanded,
}: {
  block: ContentBlock;
  exec: ToolExec | undefined;
  cwd?: string;
  expanded?: boolean;
}) {
  const blockId = typeof block.id === "string" ? block.id : undefined;
  const [open, toggle] = useExpanded(blockId);
  const name = (block.name as string) || exec?.name || "tool";
  const args = (block.arguments ?? exec?.args) as Record<string, unknown> | undefined;
  const summary = toolSummary(name, args);
  const running = exec ? !exec.done : false;
  const isError = exec?.isError ?? false;
  const output = exec?.output ?? "";
  const path = argPath(args);
  const sequentialThought = parseSequentialThought(name, args);

  if (sequentialThought) {
    return <SequentialThoughtCard thought={sequentialThought} running={running} isError={isError} expanded={expanded} cardId={blockId} />;
  }

  const oldText = typeof args?.oldText === "string" ? (args.oldText as string) : typeof args?.old_string === "string" ? (args.old_string as string) : null;
  const newText = typeof args?.newText === "string" ? (args.newText as string) : typeof args?.new_string === "string" ? (args.new_string as string) : null;

  return (
    <div className="toolcard">
      <div className="tc-head" onClick={toggle}>
        {running ? (
          <span className="spinner" />
        ) : (
          <span className={`dot ${isError ? "err" : "live"}`} style={isError ? {} : { boxShadow: "none" }} />
        )}
        <span className="tc-name">{name}</span>
        <span className="tc-sum">{summary}</span>
        {path && (
          <button
            title="Открыть в редакторе"
            onClick={(e) => {
              e.stopPropagation();
              void openPath(cwd, path);
            }}
          >
            <ExternalIcon size={13} />
          </button>
        )}
        <ChevronIcon open={open} />
      </div>
      {(open || expanded) && (
        <div className="tc-body">
          {name === "edit" && oldText != null && newText != null ? (
            <MiniDiff oldText={oldText} newText={newText} />
          ) : name === "write" && typeof args?.content === "string" ? (
            <MiniDiff oldText="" newText={args.content as string} />
          ) : (
            args != null && <pre>{JSON.stringify(args, null, 2)}</pre>
          )}
          {output && (
            <pre style={isError ? { color: "var(--danger)" } : undefined}>{stripAnsi(output).slice(0, 20000)}</pre>
          )}
          {running && !output && <div className="hint">Выполняется…</div>}
        </div>
      )}
    </div>
  );
}

// Разбор/форматирование тайминга живёт в lib/turn-timing; реэкспорт — для тестов
// и существующих импортов.
export { formatRunDuration, parseTurnTiming, type TurnTiming };


/**
 * Свёрнутая сводка хода в стиле Codex: пока модель работает — процесс виден живьём
 * в ленте; по завершении весь процесс (мысли + выполнение инструментов + промежуточные
 * реплики) сворачивается сюда, а итоговый ответ показывается отдельно под ней.
 */
export function RunActivitySummary({
  summaryId,
  steps,
  durationMs,
  actionCount,
  failedCount,
  cwd,
}: {
  /** Стабильный id хода — «раскрыто» переживает виртуальный скролл. */
  summaryId?: string;
  steps: ActivityStep[];
  durationMs: number;
  actionCount: number;
  failedCount: number;
  cwd?: string;
}) {
  const [open, toggle] = useExpanded(summaryId);
  const label = actionCount > 0 ? "Worked for" : "Thought for";
  const meta = actionCount > 0
    ? `${actionCount} ${actionCount === 1 ? "action" : "actions"}${failedCount ? ` · ${failedCount} failed` : ""}`
    : null;
  return (
    <section className={`run-summary ${failedCount ? "has-errors" : ""} ${open ? "open" : ""}`}>
      <button className="run-summary-head" onClick={toggle} aria-expanded={open}>
        <ChevronIcon open={open} size={12} />
        <TimeIcon size={13} />
        <strong>{label} {formatRunDuration(durationMs)}</strong>
        {meta && <span>· {meta}</span>}
      </button>
      {open && (
        <div className="run-summary-body">
          {steps.map((step) => {
            if (step.kind === "thinking") return <ThinkingBlock key={step.key} text={step.text} blockId={step.key} />;
            if (step.kind === "text") {
              return <div key={step.key} className="run-step-note"><Markdown source={step.text} final /></div>;
            }
            return <ToolCallCard key={step.key} block={step.block} exec={step.exec} cwd={cwd} />;
          })}
        </div>
      )}
    </section>
  );
}

export function RunFilesCard({ run, cwd }: { run: RunMeta; cwd: string }) {
  const files = run.files ?? [];
  const [expanded, setExpanded] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [undone, setUndone] = useState(false);
  if (files.length === 0) return null;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const shown = expanded ? files : files.slice(0, 3);
  return (
    <section className="run-files-card">
      <header>
        <span className="run-files-icon"><FilesIcon size={17} /></span>
        <div>
          <strong>Edited {files.length} {files.length === 1 ? "file" : "files"}</strong>
          <span><b className="add">+{additions}</b> <b className="del">−{deletions}</b></span>
        </div>
        {run.checkpoint && (
          <button
            className="run-undo"
            disabled={undoing || undone}
            onClick={() => void (async () => {
              if (!(await confirmDialog(`Откатить ${files.length} ${pluralRu(files.length, ["файл", "файла", "файлов"])} к состоянию до этого хода?`, { kind: "warning" }))) return;
              setUndoing(true);
              try {
                const backend = await getBackend();
                await backend.invoke("git_restore_run_files", { cwd, gitref: run.checkpoint, files: files.map((file) => file.path) });
                setUndone(true);
              } catch (error) {
                void messageDialog(String(error), { kind: "error" });
              } finally {
                setUndoing(false);
              }
            })()}
          >
            <RevertIcon size={14} /> {undone ? "Undone" : undoing ? "Undoing…" : "Undo"}
          </button>
        )}
        <button
          className="run-review"
          onClick={() => useStore.getState().set({ view: "review", reviewCheckpoint: run.checkpoint ?? null })}
        >
          <ReviewIcon size={14} /> Review
        </button>
      </header>
      <div className="run-files-list">
        {shown.map((file) => (
          <button key={file.path} onClick={() => void openPath(cwd, file.path)} title="Открыть в редакторе">
            <span>{file.path}</span>
            <b className="add">+{file.additions}</b>
            <b className="del">−{file.deletions}</b>
          </button>
        ))}
      </div>
      {files.length > 3 && (
        <button className="run-files-more" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show less" : `Show ${files.length - 3} more ${files.length - 3 === 1 ? "file" : "files"}`}
          <ChevronIcon open={expanded} />
        </button>
      )}
    </section>
  );
}

function TurnTimingCard({ timing }: { timing: TurnTiming }) {
  return (
    <div className="turn-timing-card" title="Длительность хода (pi-claude-style-tools)">
      <TimeIcon size={12} />
      <span className="tt-main">{timing.turn}</span>
      {timing.total != null && <span className="tt-sep">·</span>}
      {timing.total != null && <span className="tt-dim">итого {timing.total}</span>}
      {timing.turns != null && <span className="tt-sep">·</span>}
      {timing.turns != null && (
        <span className="tt-dim">{timing.turns} {pluralRu(timing.turns, ["ход", "хода", "ходов"])}</span>
      )}
    </div>
  );
}

// ---------- message ----------

function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="tool-btn"
      title="Скопировать ответ"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
    </button>
  );
}

// ---------- per-message actions (Copy / Rewind / Fork / Pin) ----------

function UserMessageActions({
  cwd,
  msg,
  userIndex,
  busy,
}: {
  cwd: string;
  msg: ChatMessage;
  userIndex: number;
  busy: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [working, setWorking] = useState(false);
  const text = contentText(msg.content);
  const allItems = useStore((s) => s.chats[cwd]?.chat.items ?? []);
  const backgroundTasks = useStore((s) => s.chats[cwd]?.chat.backgroundTasks ?? []);

  const run = (fn: () => Promise<void>) => {
    setWorking(true);
    void fn()
      .catch((e) => {
        const raw = e instanceof Error ? e.message : String(e);
        // таймаут — не жёсткая ошибка: медленная модель/занятый агент; операция
        // могла продолжиться в фоне. Показываем ненавязчивый тост, не модалку.
        const msg = /RPC timeout/i.test(raw)
          ? "Операция не завершилась вовремя (медленная модель или агент занят). Дождитесь простоя агента и повторите."
          : raw;
        notifyChat(cwd, "warning", msg);
      })
      .finally(() => setWorking(false));
  };

  return (
    <div className="msg-actions">
      <button
        title="Скопировать сообщение"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
      </button>
      <button
        title="Изменить и повторить отсюда — в этой же сессии"
        disabled={working}
        onClick={() => run(async () => {
          const userTurns = allItems.filter((item) => item.msg.role === "user" && !item.viaExtension);
          const laterUserTurns = userTurns.slice(userIndex + 1);
          const laterTurns = laterUserTurns.length;
          const currentItemIndex = allItems.findIndex((item) => item.msg === msg);
          const fileCheckpoint = checkpointForUserTurn(allItems, currentItemIndex);
          let fileDiff = "";
          if (fileCheckpoint) {
            const backend = await getBackend();
            fileDiff = await backend.invoke<string>("git_review_diff", { cwd, base: fileCheckpoint });
          }
          const hasFileChanges = fileDiff.trim().length > 0;
          const abandonedItems = currentItemIndex >= 0 ? allItems.slice(currentItemIndex + 1) : [];
          const assistantTurns = abandonedItems.filter((item) => item.msg.role === "assistant").length;
          const toolCalls = abandonedItems.reduce((count, item) => count + (
            Array.isArray(item.msg.content)
              ? item.msg.content.filter((block) => block.type === "toolCall").length
              : 0
          ), 0);
          const promptDiff = laterUserTurns
            .slice(0, 4)
            .map((item) => `− ${contentText(item.msg.content).replace(/\s+/g, " ").slice(0, 120)}`)
            .join("\n");
          const imageCount = Array.isArray(msg.content) ? msg.content.filter((block) => block.type === "image").length : 0;
          const activeTasks = backgroundTasks.filter((task) => task.status === "queued" || task.status === "running").length;
          const preview = [
            `Session diff: −${laterTurns} запросов, −${assistantTurns} ответов, −${toolCalls} tool calls.`,
            promptDiff || "Последующих пользовательских запросов нет.",
            `Текст и вложения (${imageCount}) вернутся в composer.`,
            activeTasks > 0 ? `Фоновые задачи будут транзакционно остановлены: ${activeTasks}.` : "Активных фоновых задач нет.",
            busy ? "Текущий ход модели будет остановлен перед rewind." : "Текущий ход модели уже завершён.",
            hasFileChanges
              ? "У вас остались незакоммиченные изменения относительно выбранного сообщения. Они будут потеряны. Продолжить?"
              : fileCheckpoint
                ? "Файлы уже совпадают с checkpoint выбранного сообщения."
                : "Для этого старого сообщения файловый checkpoint недоступен; изменится только conversation branch.",
            "",
            `Запрос: ${text.slice(0, 500)}`,
          ].join("\n");
          const confirmed = await confirmDialog(preview, {
            title: "Rewind preview",
            kind: "warning",
            okLabel: hasFileChanges ? "Да" : "Отменить и изменить",
            cancelLabel: hasFileChanges ? "Нет" : "Оставить как есть",
          });
          if (confirmed) await rewindToMessage(cwd, userIndex, msg, { fileCheckpoint, confirmedFileChanges: hasFileChanges });
        })}
      >
        <RewindIcon size={12} />
      </button>
      <button
        title="Форк отсюда: новая сессия с историей до этого сообщения"
        disabled={busy || working}
        onClick={() => run(() => forkFromMessage(cwd, userIndex, text))}
      >
        <ForkIcon size={12} />
      </button>
    </div>
  );
}

function PinMessageButton({ cwd, msg }: { cwd: string; msg: ChatMessage }) {
  const sessionPath = useStore((s) => s.chats[cwd]?.sessionPath ?? null);
  const pins = useStore((s) => (sessionPath ? s.sessionFlags.pinnedMessages[sessionPath] : undefined));
  const id = useMemo(() => msgPinId(msg), [msg]);
  if (!sessionPath) return null;
  const pinned = pins?.some((p) => p.id === id) ?? false;
  return (
    <button
      className="tool-btn"
      title={pinned ? "Открепить сообщение" : "Закрепить сообщение (виджет слева сверху)"}
      style={pinned ? { color: "var(--accent)" } : undefined}
      onClick={() => void toggleMessagePin(cwd, msg).catch((error) => {
        void messageDialog(`Не удалось изменить закрепление сообщения: ${String(error)}`, { kind: "error" });
      })}
    >
      {pinned ? <PinOffIcon size={12} /> : <PinIcon size={12} />}
    </button>
  );
}

/** Id инструментов, на которые ссылается сообщение (для точечного сравнения execs). */
function toolCallIds(msg: ChatMessage): string[] {
  if (!Array.isArray(msg.content)) return [];
  const ids: string[] = [];
  for (const b of msg.content) {
    if (b.type === "toolCall" && typeof b.id === "string") ids.push(b.id);
  }
  return ids;
}

const MessageViewImpl = function MessageView({
  msg,
  execs,
  streaming,
  cwd,
  userIndex,
  busy,
  viaExtension,
  transcriptMode = "normal",
  hiddenToolIds,
  showModelHeader,
  fallbackModel,
  render = "full",
  liveTurn,
}: {
  msg: ChatMessage;
  execs: Record<string, ToolExec>;
  streaming?: boolean;
  cwd?: string;
  /** Порядковый номер среди пользовательских сообщений (для rewind/fork). */
  userIndex?: number;
  /** Агент занят — деструктивные действия недоступны. */
  busy?: boolean;
  /** Сообщение отправлено расширением (pi-goal и т.п.), а не пользователем. */
  viaExtension?: boolean;
  transcriptMode?: NonNullable<AppConfig["transcriptMode"]>;
  /** Tool calls rendered once in the compact run summary instead. */
  hiddenToolIds?: ReadonlySet<string>;
  /** Первый ответ группы: показать аватар и имя модели, написавшей сообщение. */
  showModelHeader?: boolean;
  /** Модель для live-сообщения, если partial ещё не несёт provider/model. */
  fallbackModel?: ModelInfo;
  /** Codex-режим ленты: "full" — всё живьём; "answer" — только итоговый текст
   *  (мысли/инструменты уехали в свёрнутую сводку); "hidden" — сообщение целиком
   *  внутри сводки, в ленте ничего не рисуем. */
  render?: "full" | "answer" | "hidden";
  /** Сообщение принадлежит идущему ходу — рассуждения держим раскрытыми. */
  liveTurn?: boolean;
}) {
  const pinId = useMemo(() => msgPinId(msg), [msg]);
  const aliases = useStore((s) => s.appConfig.modelAliases ?? {});

  if (msg.role === "user") {
    return (
      <div className="msg user" data-pin={pinId}>
        {cwd != null && userIndex != null && (
          <UserMessageActions cwd={cwd} msg={msg} userIndex={userIndex} busy={busy ?? false} />
        )}
        <div className="bubble">
          {viaExtension && <div className="via-ext">⚙ отправлено расширением</div>}
          {/* ввод пользователя — плоский текст, НЕ markdown: «# заметка» не должна
              превращаться в заголовок (паритет с Claude Code) */}
          <div className="user-plain">{contentText(msg.content)}</div>
        </div>
      </div>
    );
  }

  // весь процесс сообщения уехал в свёрнутую сводку хода — в ленте ничего не рисуем
  if (render === "hidden") return null;

  const blocks: ContentBlock[] = Array.isArray(msg.content)
    ? msg.content
    : [{ type: "text", text: String(msg.content ?? "") }];

  // «✻ Turn took…» pi-claude-style-tools дописывает в конец текстового блока —
  // вырезаем из текста и рисуем структурной карточкой (ChatGPT/Claude-стиль).
  let timing: TurnTiming | null = null;
  const displayBlocks = blocks.map((b) => {
    if (b.type !== "text" || typeof b.text !== "string" || !b.text.includes("Turn took")) return b;
    const split = splitTrailingTurnTiming(b.text);
    if (!split.timing) return b;
    timing = split.timing;
    return { ...b, text: split.body };
  });
  const hasToolCalls = blocks.some((b) => b.type === "toolCall");
  // строка отключена в конфиге расширения, но метаданные пишутся — используем их
  // (только на финальном сообщении хода: у промежуточных есть toolCall-блоки)
  if (!timing && !streaming && !hasToolCalls) timing = timingFromWorkedMeta(msg);

  const fullText = contentText(displayBlocks);
  const provider = typeof msg.provider === "string" && msg.provider ? msg.provider : fallbackModel?.provider;
  const modelId = typeof msg.model === "string" && msg.model ? msg.model : fallbackModel?.id;
  const modelKey = modelId ? (provider ? modelAliasKey(provider, modelId) : modelId) : null;
  const modelName = modelId ? modelIdDisplayName(modelKey ?? modelId, aliases) : null;

  const hasVisibleContent =
    Boolean(fullText.trim()) ||
    hasToolCalls ||
    blocks.some((b) => b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim());

  if (timing && !hasVisibleContent) {
    return <div className="msg assistant turn-timing" data-pin={pinId}><TurnTimingCard timing={timing} /></div>;
  }

  return (
    <div className={`msg assistant ${streaming ? "streaming" : ""}`} data-pin={pinId}>
      {showModelHeader && modelKey && (
        <div className="msg-model">
          <ModelAvatar modelKey={modelKey} size={20} title={`Автор ответа: ${provider ? `${provider}/${modelId}` : modelId}`} />
          <span>{modelName}</span>
        </div>
      )}
      {!streaming && fullText.trim() && (
        <div className="msg-tools">
          {cwd != null && <PinMessageButton cwd={cwd} msg={msg} />}
          <CopyMessageButton text={stripAnsi(fullText)} />
        </div>
      )}
      {displayBlocks.map((b, i) => {
        if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
          // в "answer" мысли уже в свёрнутой сводке хода
          if (render === "answer" || transcriptMode === "summary") return null;
          return (
            <ThinkingBlock
              key={i}
              text={b.thinking}
              streaming={streaming && i === blocks.length - 1}
              forceOpen={liveTurn}
              blockId={`${pinId}-think-${i}`}
            />
          );
        }
        if (b.type === "text" && typeof b.text === "string" && stripAnsi(b.text).trim()) {
          return (
            <span key={i}>
              <Markdown source={b.text} final={!streaming} />
              {streaming && i === blocks.length - 1 && <span className="stream-caret" />}
            </span>
          );
        }
        if (b.type === "toolCall") {
          // в "answer" инструменты уже в свёрнутой сводке хода
          if (render === "answer") return null;
          const id = typeof b.id === "string" ? b.id : undefined;
          if (id && hiddenToolIds?.has(id)) return null;
          const exec = id ? execs[id] : undefined;
          if (transcriptMode === "summary" && exec?.done && !exec.isError) return null;
          return <ToolCallCard key={id ?? i} block={b} exec={exec} cwd={cwd} expanded={transcriptMode === "verbose"} />;
        }
        return null;
      })}
      {timing && (
        <div className="turn-timing-wrap">
          <TurnTimingCard timing={timing} />
        </div>
      )}
    </div>
  );
};

/** Пропускаем ре-рендер, если поменялась только ссылка на общий `execs`, но не те
 *  инструменты, которые рисует ЭТО сообщение. Во время стрима `flushAgentEvents`
 *  создаёт новый объект execs каждые 33мс — без этого перерисовывались бы все
 *  сообщения окна (CPU/GC), хотя завершённые не меняются. */
export const MessageView = memo(MessageViewImpl, (prev, next) => {
  if (
    prev.msg !== next.msg ||
    prev.streaming !== next.streaming ||
    prev.busy !== next.busy ||
    prev.userIndex !== next.userIndex ||
    prev.cwd !== next.cwd
    || prev.transcriptMode !== next.transcriptMode
    || prev.hiddenToolIds !== next.hiddenToolIds
    || prev.showModelHeader !== next.showModelHeader
    || prev.render !== next.render
    || prev.liveTurn !== next.liveTurn
    // agentState пересоздаётся при каждом get_state — сравниваем по идентичности модели
    || prev.fallbackModel?.provider !== next.fallbackModel?.provider
    || prev.fallbackModel?.id !== next.fallbackModel?.id
  ) {
    return false;
  }
  if (prev.execs === next.execs) return true;
  for (const id of toolCallIds(next.msg)) {
    if (prev.execs[id] !== next.execs[id]) return false;
  }
  return true;
});

// ---------- toasts ----------

const EMPTY_TOASTS: import("../lib/types").Toast[] = [];

const TOAST_ICONS = {
  info: InfoIcon,
  success: SuccessIcon,
  warning: WarnIcon,
  error: ErrorIcon,
} as const;

export function Toasts({ cwd }: { cwd: string }) {
  const toasts = useStore((s) => s.chats[cwd]?.chat.toasts ?? EMPTY_TOASTS);

  useEffect(() => {
    if (toasts.length === 0) return;
    const t = setTimeout(() => {
      const s = useStore.getState();
      const ws = s.chats[cwd];
      if (!ws) return;
      s.set({
        chats: {
          ...s.chats,
          [cwd]: { ...ws, chat: { ...ws.chat, toasts: ws.chat.toasts.slice(1), seq: ws.chat.seq + 1 } },
        },
      });
    }, 5000);
    return () => clearTimeout(t);
  }, [toasts, cwd]);

  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => {
        const Icon = TOAST_ICONS[t.kind] ?? InfoIcon;
        return (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span className="toast-icon">
              <Icon size={14} />
            </span>
            <span className="toast-text">{t.text}</span>
          </div>
        );
      })}
    </div>
  );
}
