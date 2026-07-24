import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { getBackend } from "../lib/backend";
import { confirmDialog, messageDialog } from "../lib/dialog";
import { firstChangedLine, parseUnifiedDiff, type DiffFile } from "../lib/diff";
import type { BranchInfo, CommitInfo, GitSummary, StatusEntry } from "../lib/types";
import { notifyChat, sendPrompt, useStore } from "../state/store";
import {
  BranchIcon,
  CheckIcon,
  CommentIcon,
  CommitIcon,
  ExternalIcon,
  FetchIcon,
  PlusIcon,
  PullIcon,
  PushIcon,
  RefreshIcon,
  RevertIcon,
  ReviewIcon,
  TrashIcon,
} from "./icons";

interface ReviewComment {
  file: string;
  line: number | null;
  text: string;
}

type DiffRow =
  | { kind: "hunk"; key: string; header: string }
  | {
      kind: "line";
      key: string;
      line: DiffFile["hunks"][number]["lines"][number];
    };

function fmtAgo(tsSec: number): string {
  const d = Date.now() - tsSec * 1000;
  if (d < 3600e3) return `${Math.max(1, Math.round(d / 60e3))} мин`;
  if (d < 86400e3) return `${Math.round(d / 3600e3)} ч`;
  return new Date(tsSec * 1000).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
}

// ---------- branch picker ----------

function BranchPicker({
  cwd,
  summary,
  onChanged,
}: {
  cwd: string;
  summary: GitSummary | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    try {
      const be = await getBackend();
      const next = await be.invoke<BranchInfo[]>("git_branches", { cwd });
      if (generation !== loadGeneration.current) return;
      setBranches(next);
      setError(null);
    } catch (loadError) {
      if (generation !== loadGeneration.current) return;
      setBranches([]);
      setError(`Не удалось загрузить ветки: ${String(loadError)}`);
    }
  }, [cwd]);

  useEffect(() => {
    if (open) {
      setBranches([]);
      setError(null);
    }
    if (open) void load();
    return () => {
      loadGeneration.current++;
    };
  }, [open, load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
      onChanged();
    } catch (e) {
      void messageDialog(String(e), { kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const checkout = (b: BranchInfo) =>
    act(async () => {
      const be = await getBackend();
      await be.invoke("git_checkout_branch", { cwd, name: b.name, remote: b.remote });
      setOpen(false);
    });

  const createBranch = () =>
    act(async () => {
      const name = newName.trim().replace(/\s+/g, "-");
      if (!name) return;
      const be = await getBackend();
      await be.invoke("git_create_branch", { cwd, name, from: null });
      setCreating(false);
      setNewName("");
      setOpen(false);
    });

  const deleteBranch = async (b: BranchInfo) => {
    if (!(await confirmDialog(`Удалить ветку «${b.name}»?`))) return;
    void act(async () => {
      const be = await getBackend();
      try {
        await be.invoke("git_delete_branch", { cwd, name: b.name, force: false });
      } catch (e) {
        if (String(e).includes("not fully merged") && (await confirmDialog(`Ветка «${b.name}» не слита. Удалить принудительно?`, { kind: "warning" }))) {
          await be.invoke("git_delete_branch", { cwd, name: b.name, force: true });
        } else {
          throw e;
        }
      }
    });
  };

  return (
    <div style={{ position: "relative" }}>
      <button className="chip" onClick={() => setOpen(!open)} title="Ветки: переключение, создание, удаление">
        <BranchIcon size={12} /> {summary?.branch ?? "—"}
        {summary && summary.ahead > 0 && <span className="hint">↑{summary.ahead}</span>}
        {summary && summary.behind > 0 && <span className="hint">↓{summary.behind}</span>}
      </button>
      {open && (
        <div className="dropdown" style={{ top: "100%", bottom: "auto", marginTop: 6, left: 0 }} onMouseLeave={() => setOpen(false)}>
          <div className="dd-list" style={{ maxHeight: 320 }}>
            {error && <div className="alert error" style={{ margin: 6 }}>{error}</div>}
            {branches.map((b) => (
              <div
                key={b.name}
                className={`dd-item ${b.current ? "sel" : ""}`}
                role="button"
                tabIndex={b.current || busy ? -1 : 0}
                aria-current={b.current ? "page" : undefined}
                aria-label={`${b.current ? "Текущая ветка" : "Переключиться на ветку"} ${b.name}`}
                onClick={() => !b.current && !busy && void checkout(b)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget || b.current || busy || (e.key !== "Enter" && e.key !== " ")) return;
                  e.preventDefault();
                  void checkout(b);
                }}
              >
                <BranchIcon size={12} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{b.name}</span>
                    {b.remote && <span className="badge">remote</span>}
                    {b.ahead > 0 && <span className="hint">↑{b.ahead}</span>}
                    {b.behind > 0 && <span className="hint">↓{b.behind}</span>}
                  </div>
                  <div className="dd-sub" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {fmtAgo(b.lastTs)} · {b.lastSubject}
                  </div>
                </div>
                {!b.current && !b.remote && (
                  <button
                    className="danger"
                    style={{ padding: "2px 5px" }}
                    title="Удалить ветку"
                    aria-label={`Удалить ветку ${b.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteBranch(b);
                    }}
                  >
                    <TrashIcon size={12} />
                  </button>
                )}
              </div>
            ))}
            {creating ? (
              <div className="dd-item" style={{ gap: 6 }}>
                <input
                  autoFocus
                  placeholder="имя-новой-ветки"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void createBranch();
                    if (e.key === "Escape") setCreating(false);
                  }}
                  style={{ flex: 1, padding: "3px 8px", fontSize: 12 }}
                />
                <button className="primary" disabled={!newName.trim() || busy} onClick={() => void createBranch()}>
                  OK
                </button>
              </div>
            ) : (
              <button type="button" className="dd-item" onClick={() => setCreating(true)}>
                <PlusIcon size={12} /> Новая ветка от текущей…
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- remote actions (fetch / pull / push) ----------

function RemoteActions({ cwd, summary, onChanged }: { cwd: string; summary: GitSummary | null; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (!summary?.hasRemote) return null;

  const run = async (kind: string, cmd: string) => {
    setBusy(kind);
    setNote(null);
    try {
      const be = await getBackend();
      const out = await be.invoke<string | void>(cmd, { cwd });
      if (typeof out === "string" && out.trim()) setNote(out.trim().split("\n").pop() ?? null);
      onChanged();
    } catch (e) {
      void messageDialog(String(e), { kind: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <button className="chip" disabled={busy != null} title="git fetch --all --prune" onClick={() => void run("fetch", "git_fetch")}>
        <FetchIcon size={12} /> fetch
      </button>
      <button className="chip" disabled={busy != null} title="git pull --ff-only" onClick={() => void run("pull", "git_pull")}>
        <PullIcon size={12} /> pull{summary.behind > 0 ? ` ${summary.behind}` : ""}
      </button>
      <button className="chip" disabled={busy != null} title="git push (upstream настроится сам)" onClick={() => void run("push", "git_push")}>
        <PushIcon size={12} /> push{summary.ahead > 0 ? ` ${summary.ahead}` : ""}
      </button>
      {busy && <span className="hint">{busy}…</span>}
      {note && !busy && <span className="hint" title={note}>{note.slice(0, 60)}</span>}
    </>
  );
}

// ---------- diff rendering (общий для всех вкладок) ----------

function DiffFileBlock({
  cwd,
  file,
  onComment,
  actions,
}: {
  cwd: string;
  file: DiffFile;
  onComment: (c: ReviewComment) => void;
  actions?: React.ReactNode;
}) {
  const editor = useStore((s) => s.appConfig.editor);
  const [commentDraft, setCommentDraft] = useState<{ key: string; line: number | null } | null>(null);
  const [draftText, setDraftText] = useState("");
  const totalLines = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  const [expanded, setExpanded] = useState(totalLines <= 400);
  const rows = useMemo<DiffRow[]>(
    () =>
      file.hunks.flatMap((hunk, hunkIndex) => [
        { kind: "hunk" as const, key: `h-${hunkIndex}`, header: hunk.header },
        ...hunk.lines.map((line, lineIndex) => ({
          kind: "line" as const,
          key: `l-${hunkIndex}-${lineIndex}`,
          line,
        })),
      ]),
    [file.hunks],
  );

  const openInEditor = async () => {
    const be = await getBackend();
    const path = `${cwd.replace(/\/$/, "")}/${file.newPath}`;
    await be.invoke("open_in_editor", { editor, path, line: firstChangedLine(file) }).catch((openError) => {
      void messageDialog(`Не удалось открыть файл в редакторе: ${String(openError)}`, { kind: "error" });
    });
  };

  const renderRow = (row: DiffRow) => {
    if (row.kind === "hunk") return <div className="hunk-header">{row.header}</div>;

    const lineNo = row.line.newNo ?? row.line.oldNo;
    const draftOpen = commentDraft?.key === row.key;
    return (
      <div>
        <div className={`dline ${row.line.kind === "add" ? "add" : row.line.kind === "del" ? "del" : ""}`}>
          <span className="no">{row.line.oldNo ?? ""}</span>
          <span className="no">{row.line.newNo ?? ""}</span>
          <span className="dtext">
            {row.line.kind === "add" ? "+" : row.line.kind === "del" ? "−" : " "} {row.line.text}
          </span>
          <button
            className="add-comment"
            title="Комментировать строку"
            onClick={() => {
              setCommentDraft({ key: row.key, line: lineNo });
              setDraftText("");
            }}
          >
            <CommentIcon size={12} />
          </button>
        </div>
        {draftOpen && (
          <div className="comment-box">
            <textarea
              autoFocus
              style={{ width: "100%", minHeight: 50 }}
              placeholder="Что исправить в этой строке?"
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
            />
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 4 }}>
              <button onClick={() => setCommentDraft(null)}>Отмена</button>
              <button
                className="primary"
                onClick={() => {
                  if (draftText.trim()) {
                    onComment({ file: file.newPath, line: commentDraft?.line ?? null, text: draftText.trim() });
                  }
                  setCommentDraft(null);
                }}
              >
                Добавить
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="difffile">
      <div className="df-head">
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{file.newPath}</span>
        <span className="df-stat-add">+{file.additions}</span>
        <span className="df-stat-del">−{file.deletions}</span>
        <button title="Открыть в редакторе" onClick={() => void openInEditor()}>
          <ExternalIcon size={13} />
        </button>
        {actions}
      </div>
      {file.status === "binary" ? (
        <div className="muted" style={{ padding: 12 }}>
          Бинарный файл
        </div>
      ) : !expanded ? (
        <button
          className="muted"
          style={{ display: "block", width: "100%", padding: 12, textAlign: "left" }}
          onClick={() => setExpanded(true)}
        >
          Большой дифф: {totalLines} строк, {file.hunks.length} ханков — показать
        </button>
      ) : totalLines > 400 ? (
        <Virtuoso
          className="virtual-diff"
          style={{ height: `min(70vh, ${Math.max(240, rows.length * 24)}px)` }}
          data={rows}
          computeItemKey={(_index, row) => row.key}
          itemContent={(_index, row) => renderRow(row)}
          increaseViewportBy={300}
        />
      ) : (
        rows.map((row) => <div key={row.key}>{renderRow(row)}</div>)
      )}
    </div>
  );
}

// ---------- вкладка «Изменения»: staging / commit ----------

interface FileRow {
  path: string;
  indexStatus: string; // staged
  worktreeStatus: string; // unstaged / untracked
}

function parseStatusEntries(entries: StatusEntry[]): FileRow[] {
  return entries.map((e) => ({
    path: e.path,
    indexStatus: e.status[0] ?? " ",
    worktreeStatus: e.status[1] ?? " ",
  }));
}

function statusBadge(ch: string): { label: string; cls: string } {
  switch (ch) {
    case "A":
    case "?":
      return { label: "A", cls: "green" };
    case "D":
      return { label: "D", cls: "red" };
    case "R":
      return { label: "R", cls: "" };
    default:
      return { label: "M", cls: "" };
  }
}

function ChangesTab({
  cwd,
  onComment,
  onChanged,
}: {
  cwd: string;
  onComment: (c: ReviewComment) => void;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<FileRow[]>([]);
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null);
  const [diffText, setDiffText] = useState("");
  const [commitMsg, setCommitMsg] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const refreshGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      const be = await getBackend();
      const entries = await be.invoke<StatusEntry[]>("git_status", { cwd });
      if (generation !== refreshGeneration.current) return;
      setRows(parseStatusEntries(entries));
      setStatusError(null);
    } catch (refreshError) {
      if (generation !== refreshGeneration.current) return;
      setStatusError(`Не удалось прочитать состояние Git: ${String(refreshError)}`);
    }
  }, [cwd]);

  useEffect(() => {
    void refresh();
    return () => {
      refreshGeneration.current++;
    };
  }, [refresh]);

  useEffect(() => {
    setRows([]);
    setSelected(null);
    setDiffText("");
    setStatusError(null);
    setDiffError(null);
  }, [cwd]);

  const staged = rows.filter((r) => r.indexStatus !== " " && r.indexStatus !== "?");
  const unstaged = rows.filter((r) => r.worktreeStatus !== " " || r.indexStatus === "?");

  // загрузка diff выбранного файла
  useEffect(() => {
    if (!selected) {
      setDiffText("");
      return;
    }
    let stale = false;
    void (async () => {
      try {
        const be = await getBackend();
        const text = await be.invoke<string>("git_file_diff", { cwd, path: selected.path, staged: selected.staged });
        if (!stale) {
          setDiffText(text);
          setDiffError(null);
        }
      } catch (loadError) {
        if (!stale) {
          setDiffText("");
          setDiffError(`Не удалось загрузить diff: ${String(loadError)}`);
        }
      }
    })();
    return () => {
      stale = true;
    };
  }, [cwd, selected, rows]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
      onChanged();
    } catch (e) {
      void messageDialog(String(e), { kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const stage = (paths: string[]) =>
    act(async () => (await getBackend()).invoke("git_stage", { cwd, paths }));
  const unstage = (paths: string[]) =>
    act(async () => (await getBackend()).invoke("git_unstage", { cwd, paths }));
  const discard = (paths: string[]) => {
    void confirmDialog(`Отменить изменения безвозвратно?\n${paths.join("\n")}`, { kind: "warning" }).then((ok) => {
      if (ok) void act(async () => (await getBackend()).invoke("git_discard", { cwd, paths }));
    });
  };
  const commit = () =>
    act(async () => {
      const be = await getBackend();
      await be.invoke("git_commit", { cwd, message: commitMsg, amend });
      setCommitMsg("");
      setAmend(false);
    });

  const files = useMemo(() => parseUnifiedDiff(diffText), [diffText]);

  return (
    <div className="split">
      <div className="left">
        {statusError && <div className="alert error" style={{ marginBottom: 8 }}>{statusError}</div>}
        <div className="commit-box">
          <textarea
            placeholder={amend ? "Сообщение (amend последнего коммита)…" : "Сообщение коммита…"}
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && (commitMsg.trim() || amend)) void commit();
            }}
          />
          <div className="row" style={{ marginTop: 6 }}>
            <label className="hint" style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} style={{ width: 13, height: 13 }} />
              amend
            </label>
            <div className="grow" />
            <button
              className="primary"
              disabled={busy || staged.length === 0 || (!commitMsg.trim() && !amend)}
              title="⌘Enter"
              onClick={() => void commit()}
            >
              <CommitIcon size={13} /> Commit ({staged.length})
            </button>
          </div>
        </div>

        <div className="row" style={{ padding: "8px 2px 4px" }}>
          <span className="section-title" style={{ padding: 0 }}>Staged · {staged.length}</span>
          <div className="grow" />
          {staged.length > 0 && (
            <button className="hint" disabled={busy} onClick={() => void unstage([])}>
              убрать всё
            </button>
          )}
        </div>
        {staged.map((r) => {
          const b = statusBadge(r.indexStatus);
          const isSel = selected?.path === r.path && selected.staged;
          return (
            <div
              key={`s-${r.path}`}
              className={`file-row ${isSel ? "active" : ""}`}
              role="button"
              tabIndex={0}
              aria-current={isSel ? "true" : undefined}
              aria-label={`Показать staged diff ${r.path}`}
              onClick={() => setSelected({ path: r.path, staged: true })}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                e.preventDefault();
                setSelected({ path: r.path, staged: true });
              }}
              title={r.path}
            >
              <span className={`badge ${b.cls}`}>{b.label}</span>
              <span className="fr-path">{r.path}</span>
              <button title="Unstage" disabled={busy} onClick={(e) => { e.stopPropagation(); void unstage([r.path]); }}>
                −
              </button>
            </div>
          );
        })}
        {staged.length === 0 && <div className="muted" style={{ fontSize: 11.5, padding: "0 2px" }}>индекс пуст</div>}

        <div className="row" style={{ padding: "12px 2px 4px" }}>
          <span className="section-title" style={{ padding: 0 }}>Изменения · {unstaged.length}</span>
          <div className="grow" />
          {unstaged.length > 0 && (
            <button className="hint" disabled={busy} onClick={() => void stage([])}>
              stage всё
            </button>
          )}
        </div>
        {unstaged.map((r) => {
          const b = statusBadge(r.indexStatus === "?" ? "?" : r.worktreeStatus);
          const isSel = selected?.path === r.path && !selected.staged;
          return (
            <div
              key={`u-${r.path}`}
              className={`file-row ${isSel ? "active" : ""}`}
              role="button"
              tabIndex={0}
              aria-current={isSel ? "true" : undefined}
              aria-label={`Показать diff ${r.path}`}
              onClick={() => setSelected({ path: r.path, staged: false })}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                e.preventDefault();
                setSelected({ path: r.path, staged: false });
              }}
              title={r.path}
            >
              <span className={`badge ${b.cls}`}>{b.label}</span>
              <span className="fr-path">{r.path}</span>
              <button title="Stage" disabled={busy} onClick={(e) => { e.stopPropagation(); void stage([r.path]); }}>
                +
              </button>
              <button
                className="danger"
                title="Отменить изменения файла"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  discard([r.path]);
                }}
              >
                <RevertIcon size={12} />
              </button>
            </div>
          );
        })}
        {unstaged.length === 0 && <div className="muted" style={{ fontSize: 11.5, padding: "0 2px" }}>рабочее дерево чистое</div>}
      </div>

      <div className="right" style={{ padding: 14 }}>
        {diffError ? (
          <div className="alert error">{diffError}</div>
        ) : selected == null ? (
          <div className="empty">
            <div className="e-icon"><ReviewIcon size={32} /></div>
            <div>Выберите файл, чтобы посмотреть diff{rows.length > 0 ? "" : " — изменений нет"}.</div>
          </div>
        ) : files.length === 0 ? (
          <div className="empty">
            <div className="muted">Diff пуст{selected.staged ? " (файл не в индексе?)" : ""}.</div>
          </div>
        ) : (
          files.map((f) => <DiffFileBlock key={f.newPath} cwd={cwd} file={f} onComment={onComment} />)
        )}
      </div>
    </div>
  );
}

// ---------- вкладка «История» ----------

function HistoryTab({ cwd, onComment }: { cwd: string; onComment: (c: ReviewComment) => void }) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [diffText, setDiffText] = useState("");
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setCommits([]);
    setSelected(null);
    setDiffText("");
    setHistoryError(null);
    setDiffError(null);
    void (async () => {
      try {
        const be = await getBackend();
        const log = await be.invoke<CommitInfo[]>("git_log", { cwd, limit: 100 });
        if (stale) return;
        setCommits(log);
        setHistoryError(null);
        setSelected(log[0]?.hash ?? null);
      } catch (loadError) {
        if (stale) return;
        setCommits([]);
        setHistoryError(`Не удалось загрузить историю Git: ${String(loadError)}`);
      }
    })();
    return () => {
      stale = true;
    };
  }, [cwd]);

  useEffect(() => {
    if (!selected) {
      setDiffText("");
      setDiffError(null);
      return;
    }
    let stale = false;
    void (async () => {
      try {
        const be = await getBackend();
        const text = await be.invoke<string>("git_show_commit", { cwd, hash: selected });
        if (!stale) {
          setDiffText(text);
          setDiffError(null);
        }
      } catch (loadError) {
        if (!stale) {
          setDiffText("");
          setDiffError(`Не удалось загрузить коммит: ${String(loadError)}`);
        }
      }
    })();
    return () => {
      stale = true;
    };
  }, [cwd, selected]);

  const files = useMemo(() => parseUnifiedDiff(diffText), [diffText]);
  const current = commits.find((c) => c.hash === selected);

  return (
    <div className="split">
      <div className="left">
        {historyError && <div className="alert error" style={{ marginBottom: 8 }}>{historyError}</div>}
        {commits.map((c) => (
          <div
            key={c.hash}
            className={`file-row commit-row ${selected === c.hash ? "active" : ""}`}
            role="button"
            tabIndex={0}
            aria-current={selected === c.hash ? "true" : undefined}
            aria-label={`Показать коммит ${c.shortHash}: ${c.subject}`}
            onClick={() => setSelected(c.hash)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              setSelected(c.hash);
            }}
            title={`${c.shortHash} · ${c.author}`}
          >
            <CommitIcon size={13} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fr-path" style={{ fontFamily: "var(--font-ui)" }}>{c.subject}</div>
              <div className="hint" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.shortHash} · {c.author} · {fmtAgo(c.ts)}
                {c.refs ? ` · ${c.refs}` : ""}
              </div>
            </div>
          </div>
        ))}
        {commits.length === 0 && <div className="muted">Коммитов нет</div>}
      </div>
      <div className="right" style={{ padding: 14 }}>
        {diffError && <div className="alert error" style={{ marginBottom: 8 }}>{diffError}</div>}
        {current && (
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="c-title" style={{ fontSize: 13 }}>{current.subject}</div>
            <div className="c-sub" style={{ fontFamily: "var(--font-mono)" }}>
              {current.shortHash} · {current.author} · {new Date(current.ts * 1000).toLocaleString("ru-RU")}
            </div>
          </div>
        )}
        {files.map((f) => (
          <DiffFileBlock key={f.newPath} cwd={cwd} file={f} onComment={onComment} />
        ))}
        {selected && files.length === 0 && <div className="muted">Пустой diff (merge-коммит?)</div>}
      </div>
    </div>
  );
}

// ---------- вкладка «Чекпоинты» (diff против чекпоинта pi-app) ----------

function CheckpointsTab({ cwd, onComment, onChanged, initialBase }: { cwd: string; onComment: (c: ReviewComment) => void; onChanged: () => void; initialBase?: string | null }) {
  const chats = useStore((s) => s.chats);
  const checkpoints = chats[cwd]?.checkpoints ?? [];
  const [base, setBase] = useState<string>(initialBase ?? "HEAD");
  const [diffText, setDiffText] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    setLoading(true);
    try {
      const be = await getBackend();
      const text = await be.invoke<string>("git_review_diff", { cwd, base: base === "HEAD" ? null : base });
      if (generation !== refreshGeneration.current) return;
      setDiffText(text);
      setError(null);
    } catch (refreshError) {
      if (generation !== refreshGeneration.current) return;
      setDiffText("");
      setError(`Не удалось загрузить diff чекпоинта: ${String(refreshError)}`);
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }, [cwd, base]);

  useEffect(() => {
    void refresh();
    return () => {
      refreshGeneration.current++;
    };
  }, [refresh]);

  useEffect(() => {
    setBase(initialBase ?? "HEAD");
    setDiffText("");
    setSelectedFile(null);
    setError(null);
  }, [cwd, initialBase]);

  const files = useMemo(() => parseUnifiedDiff(diffText), [diffText]);
  const current = files.find((f) => f.newPath === selectedFile) ?? files[0] ?? null;

  const revertFile = async (file: DiffFile) => {
    if (!(await confirmDialog(`Откатить ${file.newPath} к состоянию базы?`, { kind: "warning" }))) return;
    const be = await getBackend();
    await be.invoke("git_checkout_file", { cwd, gitref: base === "HEAD" ? "HEAD" : base, path: file.newPath }).catch((e) => void messageDialog(String(e), { kind: "error" }));
    await refresh();
    onChanged();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="row" style={{ padding: "8px 14px", borderBottom: "1px solid var(--border)" }}>
        <select value={base} onChange={(e) => setBase(e.target.value)} title="База сравнения">
          <option value="HEAD">против HEAD (всё незакоммиченное)</option>
          {[...checkpoints].reverse().map((c, i) => (
            <option key={c.hash + i} value={c.hash}>
              чекпоинт {new Date(c.ts).toLocaleTimeString("ru-RU")} ({c.hash.slice(0, 7)})
            </option>
          ))}
        </select>
        <button onClick={() => void refresh()} title="Обновить">
          <RefreshIcon size={14} />
        </button>
        <span className="hint">Чекпоинты создаются автоматически перед каждым ходом агента</span>
      </div>
      {error ? (
        <div className="alert error" style={{ margin: 14 }}>{error}</div>
      ) : loading && files.length === 0 ? (
        <div className="empty"><div className="spinner" /></div>
      ) : files.length === 0 ? (
        <div className="empty">
          <div className="e-icon"><CheckIcon size={36} /></div>
          <div>Изменений нет.</div>
        </div>
      ) : (
        <div className="split">
          <div className="left">
            {files.map((f) => (
              <div
                key={f.newPath}
                className={`card click ${current?.newPath === f.newPath ? "active" : ""}`}
                style={{ padding: "8px 10px" }}
                role="button"
                tabIndex={0}
                aria-current={current?.newPath === f.newPath ? "true" : undefined}
                aria-label={`Показать diff чекпоинта ${f.newPath}`}
                onClick={() => setSelectedFile(f.newPath)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  setSelectedFile(f.newPath);
                }}
              >
                <div className="c-title" style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}>
                  <span className={`badge ${f.status === "added" ? "green" : f.status === "deleted" ? "red" : ""}`}>
                    {f.status === "added" ? "A" : f.status === "deleted" ? "D" : f.status === "renamed" ? "R" : "M"}
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{f.newPath}</span>
                </div>
                <div className="c-sub">
                  <span className="df-stat-add">+{f.additions}</span> <span className="df-stat-del">−{f.deletions}</span>
                </div>
              </div>
            ))}
            <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
              {files.length} файлов · +{files.reduce((a, f) => a + f.additions, 0)} −{files.reduce((a, f) => a + f.deletions, 0)}
            </div>
          </div>
          <div className="right" style={{ padding: 14 }}>
            {current && (
              <DiffFileBlock
                cwd={cwd}
                file={current}
                onComment={onComment}
                actions={
                  current.status !== "added" ? (
                    <button className="danger" title="Откатить файл к базе" onClick={() => void revertFile(current)}>
                      <RevertIcon size={13} />
                    </button>
                  ) : undefined
                }
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- root ----------

type ReviewTab = "changes" | "history" | "checkpoints";

export default function ReviewView() {
  const cwd = useStore((s) => s.currentCwd);
  const reviewCheckpoint = useStore((s) => s.reviewCheckpoint);
  const [tab, setTab] = useState<ReviewTab>(reviewCheckpoint ? "checkpoints" : "changes");
  const [summary, setSummary] = useState<GitSummary | null>(null);
  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const summaryGeneration = useRef(0);

  const refreshSummary = useCallback(async () => {
    if (!cwd) return;
    const generation = ++summaryGeneration.current;
    try {
      const be = await getBackend();
      const repo = await be.invoke<boolean>("git_is_repo", { cwd });
      if (generation !== summaryGeneration.current) return;
      setIsRepo(repo);
      const nextSummary = repo ? await be.invoke<GitSummary>("git_summary", { cwd }) : null;
      if (generation !== summaryGeneration.current) return;
      setSummary(nextSummary);
      setReviewError(null);
    } catch (refreshError) {
      if (generation !== summaryGeneration.current) return;
      setIsRepo(null);
      setSummary(null);
      setReviewError(`Не удалось прочитать состояние репозитория: ${String(refreshError)}`);
    }
  }, [cwd]);

  useEffect(() => {
    void refreshSummary();
    return () => {
      summaryGeneration.current++;
    };
  }, [refreshSummary, refreshKey]);

  useEffect(() => {
    setSummary(null);
    setIsRepo(null);
    setComments([]);
    setReviewError(null);
  }, [cwd]);

  useEffect(() => {
    if (reviewCheckpoint) setTab("checkpoints");
  }, [reviewCheckpoint]);

  if (!cwd) return <div className="empty">Выберите проект</div>;

  const onGitChanged = () => setRefreshKey((k) => k + 1);
  const addComment = (c: ReviewComment) => setComments((cs) => [...cs, c]);

  const sendComments = async () => {
    if (comments.length === 0) return;
    const lines = comments.map((c) => `- ${c.file}${c.line ? `:${c.line}` : ""} — ${c.text}`);
    const msg = `Комментарии code review, исправь их:\n${lines.join("\n")}`;
    setComments([]);
    useStore.getState().set({ view: "chat" });
    await sendPrompt(cwd, msg);
  };

  // F3 (ROADMAP §6.1): ревью текущего диффа агентом по скиллу code-review
  const reviewByAgent = () => {
    useStore.getState().set({ view: "chat" });
    void sendPrompt(
      cwd,
      "Сделай code review текущих незакоммиченных изменений (staged и unstaged). " +
        "Следуй скиллу code-review: сначала прочитай его SKILL.md. Возьми дифф (git diff и git diff --cached), " +
        "для каждого изменённого файла прочитай окружение правок целиком, проверяй каждую находку перед тем как " +
        "заявить её. Отчёт: file:line — дефект — конкретный сценарий отказа — предлагаемый фикс, по убыванию " +
        "серьёзности; только подтверждённые проблемы, без стилистики. Ничего не редактируй — только отчёт.",
    ).catch((e) => notifyChat(cwd, "warning", e instanceof Error ? e.message : String(e)));
  };

  if (reviewError) {
    return (
      <div className="chat">
        <div className="topbar" data-tauri-drag-region>
          <span className="title">Git</span>
          <span className="sub">{cwd.split("/").pop()}</span>
          <button onClick={() => void refreshSummary()}>Повторить</button>
        </div>
        <div className="alert error" style={{ margin: 14 }}>{reviewError}</div>
      </div>
    );
  }

  if (isRepo === false) {
    return (
      <div className="chat">
        <div className="topbar" data-tauri-drag-region>
          <span className="title">Git</span>
          <span className="sub">{cwd.split("/").pop()}</span>
        </div>
        <div className="empty">
          <div className="e-icon"><ReviewIcon size={36} /></div>
          <div>Папка не является git-репозиторием.</div>
          <div className="muted">Инициализируйте git (git init), чтобы получить чекпоинты, staging и review.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat">
      <div className="topbar" data-tauri-drag-region>
        <span className="title">Git</span>
        <span className="sub">{cwd.split("/").pop()}</span>
        <BranchPicker cwd={cwd} summary={summary} onChanged={onGitChanged} />
        <RemoteActions cwd={cwd} summary={summary} onChanged={onGitChanged} />
        <button onClick={onGitChanged} title="Обновить">
          <RefreshIcon size={14} />
        </button>
        {summary != null && summary.changedFiles > 0 && (
          <button onClick={reviewByAgent} title="Агент проведёт ревью незакоммиченных изменений по скиллу code-review">
            Ревью агентом
          </button>
        )}
        <div className="spacer" data-tauri-drag-region />
        {comments.length > 0 && (
          <button className="primary" onClick={() => void sendComments()}>
            Отправить агенту ({comments.length})
          </button>
        )}
      </div>

      <div className="tabs review-tabs">
        {(
          [
            { id: "changes", label: `Изменения${summary && summary.changedFiles > 0 ? ` · ${summary.changedFiles}` : ""}` },
            { id: "history", label: "История" },
            { id: "checkpoints", label: "Чекпоинты агента" },
          ] as { id: ReviewTab; label: string }[]
        ).map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "active" : ""}
            onClick={() => {
              setTab(t.id);
              if (t.id !== "checkpoints") useStore.getState().set({ reviewCheckpoint: null });
            }}
          >
            {t.label}
          </button>
        ))}
        <div className="grow" />
        {comments.length > 0 && (
          <span className="hint" style={{ alignSelf: "center" }}>
            комментариев: {comments.length}
          </span>
        )}
      </div>

      {tab === "changes" && <ChangesTab key={refreshKey} cwd={cwd} onComment={addComment} onChanged={onGitChanged} />}
      {tab === "history" && <HistoryTab key={refreshKey} cwd={cwd} onComment={addComment} />}
      {tab === "checkpoints" && <CheckpointsTab key={`${refreshKey}:${reviewCheckpoint ?? "HEAD"}`} cwd={cwd} onComment={addComment} onChanged={onGitChanged} initialBase={reviewCheckpoint} />}
    </div>
  );
}
