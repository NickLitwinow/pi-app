import { useEffect, useRef, useState, type ReactElement } from "react";
import { getBackend } from "../lib/backend";
import { confirmDialog, messageDialog } from "../lib/dialog";
import type { SearchHit, SessionGroup, SessionMeta } from "../lib/types";
import {
  addWorkspace,
  createGroup,
  deleteGroup,
  deleteSessionAction,
  forkSessionAction,
  moveSessionToGroup,
  newSession,
  openSession,
  refreshSessions,
  removeWorkspace,
  renameGroup,
  renameSessionAction,
  samePath,
  selectWorkspace,
  toggleArchived,
  togglePinned,
  updateAppConfig,
  useStore,
  type View,
} from "../state/store";
import {
  ChartIcon,
  ChatIcon,
  ChevronIcon,
  FolderIcon,
  GearIcon,
  GroupIcon,
  PlusIcon,
  ReviewIcon,
  SidebarIcon,
  UpdateIcon,
} from "./icons";
import UpdateModal from "./UpdateModal";

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
  streaming = false,
  pinned,
  archived,
  groups,
  groupId,
}: {
  cwd: string;
  s: SessionMeta;
  active: boolean;
  live: boolean;
  streaming?: boolean;
  pinned: boolean;
  archived: boolean;
  groups: SessionGroup[];
  groupId: string | null;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<"main" | "group">("main");
  const [newGroupName, setNewGroupName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    setMenuView("main");
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

  const submitNewGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    const id = await createGroup(cwd, name);
    await moveSessionToGroup(s.path, id);
    setNewGroupName("");
    setMenuOpen(false);
  };

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
      {streaming ? <span className="spinner" /> : live ? <span className="dot live" /> : pinned ? <span className="sess-pin">›</span> : <span className="sess-pin" />}
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
          {menuView === "main" ? (
            <>
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
                  void forkSessionAction(cwd, s).catch((e) => void messageDialog(String(e), { kind: "error" }));
                }}
              >
                Форк сессии
              </button>
              <button onClick={() => setMenuView("group")}>В группу… {groupId ? "›" : "›"}</button>
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
                  void confirmDialog(`Удалить сессию «${sessionTitle(s)}» безвозвратно?`, { kind: "warning" }).then((ok) => {
                    if (ok) void deleteSessionAction(cwd, s.path);
                  });
                }}
              >
                Удалить
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setMenuView("main")}>‹ Назад</button>
              {groups.map((g) => (
                <button
                  key={g.id}
                  onClick={() => {
                    setMenuOpen(false);
                    void moveSessionToGroup(s.path, g.id);
                  }}
                >
                  {groupId === g.id ? "✓ " : ""}
                  {g.name}
                </button>
              ))}
              {groupId && (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    void moveSessionToGroup(s.path, null);
                  }}
                >
                  Убрать из группы
                </button>
              )}
              <div className="menu-input">
                <input
                  autoFocus={groups.length === 0}
                  placeholder="Новая группа…"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitNewGroup();
                  }}
                />
                <button disabled={!newGroupName.trim()} onClick={() => void submitNewGroup()}>
                  +
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- group section ----------

function GroupSection({
  cwd,
  group,
  sessions,
  render,
}: {
  cwd: string;
  group: SessionGroup;
  sessions: SessionMeta[];
  render: (s: SessionMeta) => ReactElement;
}) {
  const [open, setOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(group.name);
  const menuRef = useRef<HTMLDivElement>(null);
  void cwd;

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const commitRename = () => {
    setRenaming(false);
    const name = draft.trim();
    if (name && name !== group.name) void renameGroup(group.id, name);
  };

  if (renaming) {
    return (
      <div className="sess-group">
        <div className="sess-row group-head">
          <GroupIcon size={12} />
          <input
            autoFocus
            className="sess-rename"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setRenaming(false);
            }}
            onBlur={commitRename}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="sess-group">
      <div className="sess-row group-head" onClick={() => setOpen(!open)}>
        <ChevronIcon open={open} size={11} />
        <GroupIcon size={12} />
        <span className="sess-title">{group.name}</span>
        <span className="sess-when">{sessions.length}</span>
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
                setDraft(group.name);
                setRenaming(true);
              }}
            >
              Переименовать группу
            </button>
            <button
              className="danger"
              onClick={() => {
                setMenuOpen(false);
                void confirmDialog(`Удалить группу «${group.name}»? Сессии останутся в проекте.`).then((ok) => {
                  if (ok) void deleteGroup(group.id);
                });
              }}
            >
              Удалить группу
            </button>
          </div>
        )}
      </div>
      {open && <div className="group-body">{sessions.map(render)}</div>}
    </div>
  );
}

// ---------- project block ----------

async function revealProject(cwd: string) {
  const be = await getBackend();
  await be.invoke("reveal_in_finder", { path: cwd }).catch(() => {});
}

function ProjectBlock({ cwd, name, count }: { cwd: string; name: string; count: number }) {
  const currentCwd = useStore((s) => s.currentCwd);
  const ws = useStore((s) => s.chats[cwd]);
  const sessions = useStore((s) => s.sessions[cwd] ?? EMPTY_SESSIONS);
  const flags = useStore((s) => s.sessionFlags);
  const [expanded, setExpanded] = useState(cwd === currentCwd);
  const [showArchived, setShowArchived] = useState(false);
  const [projMenu, setProjMenu] = useState(false);
  const projMenuRef = useRef<HTMLDivElement>(null);

  const isCurrent = currentCwd === cwd;

  useEffect(() => {
    if (expanded) void refreshSessions(cwd);
  }, [expanded, cwd]);

  useEffect(() => {
    if (!projMenu) return;
    const close = (e: MouseEvent) => {
      if (!projMenuRef.current?.contains(e.target as Node)) setProjMenu(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [projMenu]);

  const pinnedSet = new Set(flags.pinned);
  const archivedSet = new Set(flags.archived);
  const groups = flags.groups.filter((g) => g.cwd === cwd);
  const groupIds = new Set(groups.map((g) => g.id));
  const groupOf = (s: SessionMeta): string | null => {
    const g = flags.groupOf[s.path];
    return g && groupIds.has(g) ? g : null;
  };

  const visible = sessions.filter((s) => !archivedSet.has(s.path));
  const archived = sessions.filter((s) => archivedSet.has(s.path));
  const sorted = [
    ...visible.filter((s) => pinnedSet.has(s.path)),
    ...visible.filter((s) => !pinnedSet.has(s.path)),
  ];
  const ungrouped = sorted.filter((s) => groupOf(s) == null);

  const renderRow = (s: SessionMeta) => (
    <SessionRow
      key={s.path}
      cwd={cwd}
      s={s}
      active={isCurrent && samePath(ws?.sessionPath, s.path)}
      live={Boolean(ws?.alive && samePath(ws?.liveSessionPath, s.path))}
      streaming={Boolean(ws?.liveStreaming && samePath(ws?.liveSessionPath, s.path))}
      pinned={pinnedSet.has(s.path)}
      archived={false}
      groups={groups}
      groupId={groupOf(s)}
    />
  );

  return (
    <div className="proj">
      <div
        className={`ws proj-head ${isCurrent ? "active" : ""}`}
        onClick={() => {
          selectWorkspace(cwd);
          setExpanded(isCurrent ? !expanded : true);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setProjMenu(true);
        }}
        title={cwd}
      >
        <span className="ws-name">
          {ws?.liveStreaming ? <span className="spinner" /> : ws?.alive ? <span className="dot live" /> : <ChevronIcon open={expanded} />}
          {name}
          <span className="ws-count">{count > 0 ? count : ""}</span>
        </span>
        <button
          className="sess-more"
          onClick={(e) => {
            e.stopPropagation();
            setProjMenu(!projMenu);
          }}
        >
          ⋯
        </button>
        {projMenu && (
          <div className="menu" ref={projMenuRef} onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => {
                setProjMenu(false);
                void revealProject(cwd);
              }}
            >
              Открыть в Finder
            </button>
            <button
              className="danger"
              onClick={() => {
                setProjMenu(false);
                void confirmDialog(
                  `Открепить «${name}» от сайдбара?\n\nЭто только убирает проект из списка — папка проекта и файлы сессий на диске НЕ удаляются. Проект вернётся, если снова открыть его папку.`,
                  { title: "Открепить проект", kind: "info", okLabel: "Открепить", cancelLabel: "Отмена" },
                ).then((ok) => {
                  if (ok) void removeWorkspace(cwd);
                });
              }}
            >
              Открепить от сайдбара
            </button>
          </div>
        )}
      </div>
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
          {groups.map((g) => (
            <GroupSection
              key={g.id}
              cwd={cwd}
              group={g}
              sessions={sorted.filter((s) => groupOf(s) === g.id)}
              render={renderRow}
            />
          ))}
          {ungrouped.map(renderRow)}
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
                    active={isCurrent && samePath(ws?.sessionPath, s.path)}
                    live={false}
                    pinned={false}
                    archived
                    groups={groups}
                    groupId={groupOf(s)}
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
  const width = useStore((s) => s.appConfig.sidebarWidth ?? 240);
  const uiScale = useStore((s) => s.appConfig.uiScale || 1);
  const hidden = useStore((s) => s.sessionFlags.hiddenProjects);
  const [query, setQuery] = useState("");
  const [updateOpen, setUpdateOpen] = useState(false);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const hiddenSet = new Set(hidden);
  const all = [...extra, ...projects.filter((p) => !extra.some((e) => e.cwd === p.cwd))].filter(
    (p) => !hiddenSet.has(p.cwd),
  );

  // drag-resize правой кромки (координаты мыши физические → делим на uiScale)
  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: width };
    const move = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const next = Math.round(Math.min(400, Math.max(190, d.startW + (ev.clientX - d.startX) / uiScale)));
      document.documentElement.style.setProperty("--sidebar-w", `${next}px`);
    };
    const up = (ev: MouseEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (d) {
        const next = Math.round(Math.min(400, Math.max(190, d.startW + (ev.clientX - d.startX) / uiScale)));
        void updateAppConfig({ sidebarWidth: next });
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div className="sidebar" data-tauri-drag-region>
      <div className="side-top" data-tauri-drag-region>
        <button
          className="collapse-btn"
          title="Свернуть боковую панель (⌘B)"
          onClick={() => void updateAppConfig({ sidebarCollapsed: true })}
        >
          <SidebarIcon size={15} />
        </button>
      </div>
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
        <span className="footer-text">
          {piInfo?.path ? (
            <>pi {piInfo.version ?? "?"} · {isMock ? "demo" : "готов"}</>
          ) : (
            <span style={{ color: "var(--danger)" }}>pi не найден — установите с pi.dev</span>
          )}
        </span>
        <div className="grow" />
        <button className="footer-update" title="Проверить обновления Pi" onClick={() => setUpdateOpen(true)}>
          <UpdateIcon size={13} /> Обновления
        </button>
      </div>
      <div className="side-resize" onMouseDown={onResizeStart} title="Потяните, чтобы изменить ширину" />
      {updateOpen && <UpdateModal onClose={() => setUpdateOpen(false)} />}
    </div>
  );
}
