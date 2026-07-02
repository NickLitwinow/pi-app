import { memo, useEffect, useState } from "react";
import { getBackend } from "../lib/backend";
import { stripAnsi } from "../lib/markdown";
import { contentText } from "../lib/reducer";
import type { ChatMessage, ContentBlock, ToolExec } from "../lib/types";
import { useStore } from "../state/store";
import { CheckIcon, ChevronIcon, CopyIcon, ErrorIcon, ExternalIcon, InfoIcon, SuccessIcon, WarnIcon } from "./icons";
import { Markdown } from "./Markdown";

// ---------- thinking ----------

function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const shown = open || streaming;
  return (
    <div className="thinking">
      <div className="t-head" onClick={() => setOpen(!open)}>
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

export function ToolCallCard({
  block,
  exec,
  cwd,
}: {
  block: ContentBlock;
  exec: ToolExec | undefined;
  cwd?: string;
}) {
  const [open, setOpen] = useState(false);
  const name = (block.name as string) || exec?.name || "tool";
  const args = (block.arguments ?? exec?.args) as Record<string, unknown> | undefined;
  const summary = toolSummary(name, args);
  const running = exec ? !exec.done : false;
  const isError = exec?.isError ?? false;
  const output = exec?.output ?? "";
  const path = argPath(args);

  const oldText = typeof args?.oldText === "string" ? (args.oldText as string) : typeof args?.old_string === "string" ? (args.old_string as string) : null;
  const newText = typeof args?.newText === "string" ? (args.newText as string) : typeof args?.new_string === "string" ? (args.new_string as string) : null;

  return (
    <div className="toolcard">
      <div className="tc-head" onClick={() => setOpen(!open)}>
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
      {open && (
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

// ---------- message ----------

function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-btn"
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

export const MessageView = memo(function MessageView({
  msg,
  execs,
  streaming,
  cwd,
}: {
  msg: ChatMessage;
  execs: Record<string, ToolExec>;
  streaming?: boolean;
  cwd?: string;
}) {
  if (msg.role === "user") {
    return (
      <div className="msg user">
        <div className="bubble">
          <Markdown source={contentText(msg.content)} final />
        </div>
      </div>
    );
  }

  const blocks: ContentBlock[] = Array.isArray(msg.content)
    ? msg.content
    : [{ type: "text", text: String(msg.content ?? "") }];

  const fullText = contentText(msg.content);

  return (
    <div className="msg assistant">
      {!streaming && fullText.trim() && <CopyMessageButton text={stripAnsi(fullText)} />}
      {blocks.map((b, i) => {
        if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
          return <ThinkingBlock key={i} text={b.thinking} streaming={streaming && i === blocks.length - 1} />;
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
          const id = typeof b.id === "string" ? b.id : undefined;
          return <ToolCallCard key={id ?? i} block={b} exec={id ? execs[id] : undefined} cwd={cwd} />;
        }
        return null;
      })}
    </div>
  );
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
