import { useEffect, useRef, useState, type ReactElement } from "react";
import { getBackend } from "../lib/backend";
import type { SearchHit, SessionMeta } from "../lib/types";
import {
  addWorkspace,
  deleteSessionAction,
  newSession,
  openSession,
  refreshSessions,
  renameSessionAction,
  selectWorkspace,
  toggleArchived,
  togglePinned,
  useStore,
  type View,
} from "../state/store";
import { ChartIcon, ChatIcon, ChevronIcon, FolderIcon, GearIcon, PlusIcon, ReviewIcon } from "./icons";

const NAV: { view: View; label: string; icon: (p: { size?: number }) => ReactElement }[] = [
  { view: "chat", label: "Чат", icon: ChatIcon },
  { view: "review", label: "Code Review", icon: ReviewIcon },
  { view: "analytics", label: "Аналитика", icon: ChartIcon },
  { view: "settings", label: "Настройки", icon: GearIcon },
];

async function openFolder() {
  const be = await getBackend();
  if (be.isMock) {
    const p = window.prompt("Путь к папке проекта:", "/Users/dev/new-project");
    if (p) addWorkspace(p);
    return;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const dir = await open({ directory: true, multiple: false, title: "Открыть папку проекта" });
  if (typeof dir === "string" && dir) addWorkspace(dir);
}

const EMPTY_SESSIONS: SessionMeta[] = [];

function sessionTitle(s: SessionMeta): string {
  return s.name ?? s.userSnippet ?? s.id.slice(0, 8);
}

function fmtWhen(ms: number): string {
  const d = Date.now() - ms;
  if (d < 3600e3) return `${Math.max(1, Math.round(d / 60e3))} мин`;
  if (d < 86400e3) return `${Math.round(d / 3600e3)} ч`;
  return new Date(ms).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
}

// ---------- session row with ⋯ menu ----------

function SessionRow({
  cwd,
  s,
  active,
  live,
  pinned,
  archived,
}: {
  cwd: string;
  s: SessionMeta;
  active: boolean;
  live: boolean;
  pinned: boolean;
  archived: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const commitRename = async () => {
    setRenaming(false);
    const name = draft.trim();
    if (name && name !== sessionTitle(s)) await renameSessionAction(cwd, s.path, name).catch(() => {});
  };

  if (renaming) {
    return (
      <div className="sess-row">
        <input
          autoFocus
          className="sess-rename"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          onBlur={() => void commitRename()}
        />
      </div>
    );
  }

  return (
    <div
      className={`sess-row ${active ? "active" : ""}`}
      onClick={() => void openSession(cwd, s)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
      title={s.userSnippet ?? s.path}
    >
      {live ? <span className="dot live" /> : pinned ? <span className="sess-pin">›</span> : <span className="sess-pin" />}
      <span className="sess-title">{sessionTitle(s)}</span>
      <span className="sess-when">{fmtWhen(s.modifiedMs)}</span>
      <button
        className="sess-more"
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen(!menuOpen);
        }}
      >
        ⋯
      </button>
      {menuOpen && (
        <div className="menu" ref={menuRef} onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => {
              setMenuOpen(false);
              void togglePinned(s.path);
            }}
          >
            {pinned ? "Открепить" : "Закрепить"}
          </button>
          <button
            onClick={() => {
              setMenuOpen(false);
              setDraft(s.name ?? "");
              setRenaming(true);
            }}
          >
            Переименовать
          </button>
          <button
            onClick={() => {
              setMenuOpen(false);
              void toggleArchived(s.path);
            }}
          >
            {archived ? "Разархивировать" : "Архивировать"}
          </button>
          <button
            className="danger"
            onClick={() => {
              setMenuOpen(false);
              if (window.confirm(`Удалить сессию «${sessionTitle(s)}» безвозвратно?`)) {
                void deleteSessionAction(cwd, s.path);
              }
            }}
          >
            Удалить
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- project block ----------

function ProjectBlock({ cwd, name, count }: { cwd: string; name: string; count: number }) {
  const currentCwd = useStore((s) => s.currentCwd);
  const ws = useStore((s) => s.chats[cwd]);
  const sessions = useStore((s) => s.sessions[cwd] ?? EMPTY_SESSIONS);
  const flags = useStore((s) => s.sessionFlags);
  const [expanded, setExpanded] = useState(cwd === currentCwd);
  const [showArchived, setShowArchived] = useState(false);

  const isCurrent = currentCwd === cwd;

  useEffect(() => {
    if (expanded) void refreshSessions(cwd);
  }, [expanded, cwd]);

  const pinnedSet = new Set(flags.pinned);
  const archivedSet = new Set(flags.archived);
  const visible = sessions.filter((s) => !archivedSet.has(s.path));
  const archived = sessions.filter((s) => archivedSet.has(s.path));
  const sorted = [
    ...visible.filter((s) => pinnedSet.has(s.path)),
    ...visible.filter((s) => !pinnedSet.has(s.path)),
  ];

  return (
    <div className="proj">
      <button
        className={`ws ${isCurrent ? "active" : ""}`}
        onClick={() => {
          selectWorkspace(cwd);
          setExpanded(isCurrent ? !expanded : true);
        }}
        title={cwd}
      >
        <span className="ws-name">
          {ws?.chat.isStreaming ? <span className="spinner" /> : ws?.alive ? <span className="dot live" /> : <ChevronIcon open={expanded} />}
          {name}
          <span className="ws-count">{count > 0 ? count : ""}</span>
        </span>
      </button>
      {expanded && (
        <div className="sess-list">
          <button
            className="sess-row new"
            onClick={() => {
              selectWorkspace(cwd);
              void newSession(cwd);
            }}
          >
            <PlusIcon size={12} />
            <span className="sess-title">Новая сессия</span>
          </button>
          {sorted.map((s) => (
            <SessionRow
              key={s.path}
              cwd={cwd}
              s={s}
              active={isCurrent && ws?.sessionPath === s.path}
              live={Boolean(ws?.alive && ws?.sessionPath === s.path)}
              pinned={pinnedSet.has(s.path)}
              archived={false}
            />
          ))}
          {archived.length > 0 && (
            <>
              <button className="sess-row new" onClick={() => setShowArchived(!showArchived)}>
                <ChevronIcon open={showArchived} size={11} />
                <span className="sess-title" style={{ color: "var(--text-dim)" }}>
                  Архив ({archived.length})
                </span>
              </button>
              {showArchived &&
                archived.map((s) => (
                  <SessionRow
                    key={s.path}
                    cwd={cwd}
                    s={s}
                    active={isCurrent && ws?.sessionPath === s.path}
                    live={false}
                    pinned={false}
                    archived
                  />
                ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- search ----------

function SearchResults({ query }: { query: string }) {
  const [hits, setHits] = useState<SearchHit[] | null>(null);

  useEffect(() => {
    let stale = false;
    const t = setTimeout(async () => {
      const be = await getBackend();
      const res = await be.invoke<SearchHit[]>("search_sessions", { query }).catch(() => []);
      if (!stale) setHits(res as SearchHit[]);
    }, 300);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query]);

  const open = async (h: SearchHit) => {
    const s = useStore.getState();
    if (![...s.projects, ...s.extraWorkspaces].some((p) => p.cwd === h.cwd)) addWorkspace(h.cwd);
    const meta: SessionMeta = {
      path: h.path, id: h.path, cwd: h.cwd, name: null, createdAt: h.timestamp,
      modifiedMs: 0, messageCount: 0, userSnippet: h.snippet, costTotal: 0, tokensIn: 0, tokensOut: 0,
    };
    await openSession(h.cwd, meta);
  };

  if (!hits) return <div className="hint" style={{ padding: "8px 14px" }}>Поиск…</div>;
  if (hits.length === 0) return <div className="hint" style={{ padding: "8px 14px" }}>Ничего не найдено</div>;
  return (
    <>
      {hits.map((h, i) => (
        <button key={i} className="ws" onClick={() => void open(h)} title={h.path}>
          <span className="ws-name" style={{ fontSize: 12 }}>
            {h.cwd.split("/").pop()}
          </span>
          <span className="ws-meta">…{h.snippet.slice(0, 90)}…</span>
        </button>
      ))}
    </>
  );
}

// ---------- sidebar ----------

export default function Sidebar() {
  const view = useStore((s) => s.view);
  const projects = useStore((s) => s.projects);
  const extra = useStore((s) => s.extraWorkspaces);
  const piInfo = useStore((s) => s.piInfo);
  const isMock = useStore((s) => s.isMock);
  const set = useStore((s) => s.set);
  const [query, setQuery] = useState("");

  const all = [...extra, ...projects.filter((p) => !extra.some((e) => e.cwd === p.cwd))];

  return (
    <div className="sidebar" data-tauri-drag-region>
      <div className="nav">
        {NAV.map((n) => (
          <button
            key={n.view}
            className={`navitem ${view === n.view ? "active" : ""}`}
            onClick={() => set({ view: n.view })}
          >
            <n.icon size={15} />
            {n.label}
          </button>
        ))}
      </div>

      <div className="side-search">
        <input
          placeholder="Поиск по сессиям…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
        />
      </div>

      <div className="section-title" data-tauri-drag-region>
        Проекты
      </div>
      <div className="workspaces">
        {query.trim().length >= 2 ? (
          <SearchResults query={query.trim()} />
        ) : (
          <>
            {all.map((p) => (
              <ProjectBlock key={p.cwd} cwd={p.cwd} name={p.name} count={p.sessionCount} />
            ))}
            <button className="ws" onClick={() => void openFolder()}>
              <span className="ws-name" style={{ color: "var(--text-dim)" }}>
                <FolderIcon size={14} />
                Открыть папку…
              </span>
            </button>
          </>
        )}
      </div>

      <div className="footer">
        {piInfo?.path ? (
          <>pi {piInfo.version ?? "?"} · {isMock ? "demo" : "готов"}</>
        ) : (
          <span style={{ color: "var(--danger)" }}>pi не найден — установите с pi.dev</span>
        )}
      </div>
    </div>
  );
}
