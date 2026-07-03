use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

use crate::config::load_app_config;
use crate::jsonl::LineFramer;

// ---------- pi binary resolution ----------

/// Cached resolution result; `None` means "not resolved yet" (so a user-set
/// path or install can be picked up without restarting the app).
static PI_PATH: std::sync::Mutex<Option<Option<String>>> = std::sync::Mutex::new(None);
static LOGIN_PATH: OnceLock<Option<String>> = OnceLock::new();

/// GUI apps launched from Finder inherit a bare PATH (/usr/bin:/bin) with no
/// Homebrew/nvm entries — so `pi` (a Node script) can't find `node` and dies
/// on startup. Capture the user's login-shell PATH once and hand it to every
/// pi process we spawn.
pub fn login_path() -> Option<String> {
    LOGIN_PATH
        .get_or_init(|| {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            let out = std::process::Command::new(&shell)
                .args(["-lc", "printf %s \"$PATH\""])
                .output()
                .or_else(|_| {
                    std::process::Command::new("/bin/zsh")
                        .args(["-lc", "printf %s \"$PATH\""])
                        .output()
                })
                .ok()?;
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if path.is_empty() {
                None
            } else {
                Some(path)
            }
        })
        .clone()
}

/// PATH to expose to child pi processes: login PATH plus the pi binary's own
/// directory, falling back to the inherited env when the login shell fails.
pub fn child_path() -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(pi) = find_pi_binary() {
        if let Some(dir) = std::path::Path::new(&pi).parent() {
            parts.push(dir.to_string_lossy().into_owned());
        }
    }
    if let Some(lp) = login_path() {
        parts.push(lp);
    } else if let Ok(env) = std::env::var("PATH") {
        parts.push(env);
    }
    parts.push("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin".into());
    // dedupe while preserving order
    let mut seen = std::collections::HashSet::new();
    parts
        .join(":")
        .split(':')
        .filter(|s| !s.is_empty() && seen.insert(s.to_string()))
        .collect::<Vec<_>>()
        .join(":")
}

pub fn find_pi_binary() -> Option<String> {
    if let Ok(guard) = PI_PATH.lock() {
        if let Some(cached) = guard.as_ref() {
            return cached.clone();
        }
    }
    let resolved = resolve_pi_uncached();
    if let Ok(mut guard) = PI_PATH.lock() {
        *guard = Some(resolved.clone());
    }
    resolved
}

/// Drop the cached path so the next lookup re-resolves (после смены настройки
/// или установки pi без перезапуска приложения).
pub fn invalidate_pi_path_cache() {
    if let Ok(mut guard) = PI_PATH.lock() {
        *guard = None;
    }
}

fn resolve_pi_uncached() -> Option<String> {
    // 1. явный путь из настроек приложения
    if let Some(p) = load_app_config().pi_path {
        if !p.is_empty() && std::path::Path::new(&p).exists() {
            return Some(p);
        }
    }
    // 2. env override (тесты / нестандартные окружения)
    if let Ok(p) = std::env::var("PI_APP_PI_PATH") {
        if !p.is_empty() && std::path::Path::new(&p).exists() {
            return Some(p);
        }
    }
    // 3. стандартные места установки
    for cand in ["/opt/homebrew/bin/pi", "/usr/local/bin/pi"] {
        if std::path::Path::new(cand).exists() {
            return Some(cand.to_string());
        }
    }
    if let Some(home) = dirs::home_dir() {
        for rel in [".local/bin/pi", ".pi/bin/pi", ".bun/bin/pi", ".npm-global/bin/pi"] {
            let p = home.join(rel);
            if p.exists() {
                return Some(p.to_string_lossy().into_owned());
            }
        }
    }
    // 4. GUI apps don't inherit the shell PATH; ask a login shell.
    let out = std::process::Command::new("/bin/zsh")
        .args(["-lc", "command -v pi"])
        .output()
        .ok()?;
    if out.status.success() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() {
            return Some(s);
        }
    }
    None
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiInfo {
    pub path: Option<String>,
    pub version: Option<String>,
    pub agent_dir: String,
}

#[tauri::command]
pub async fn resolve_pi() -> Result<PiInfo, String> {
    let path = find_pi_binary();
    let mut version = None;
    if let Some(ref p) = path {
        if let Ok(out) = Command::new(p).arg("--version").env("PATH", child_path()).output().await {
            if out.status.success() {
                version = Some(String::from_utf8_lossy(&out.stdout).trim().to_string());
            }
        }
    }
    Ok(PiInfo {
        path,
        version,
        agent_dir: crate::sessions::agent_dir().to_string_lossy().into_owned(),
    })
}

/// Set (or clear) the user-chosen pi binary path. A provided path is validated
/// by actually running `--version`; on success it's persisted to app config.
#[tauri::command]
pub async fn set_pi_path(path: Option<String>) -> Result<PiInfo, String> {
    let mut cfg = load_app_config();
    match path {
        Some(p) if !p.trim().is_empty() => {
            let p = p.trim().to_string();
            if !std::path::Path::new(&p).exists() {
                return Err(format!("файл не найден: {p}"));
            }
            let out = Command::new(&p)
                .arg("--version")
                .env("PATH", child_path())
                .output()
                .await
                .map_err(|e| format!("не удалось запустить: {e}"))?;
            if !out.status.success() {
                return Err(format!(
                    "«{p}» не похож на pi (--version завершился с ошибкой): {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
            cfg.pi_path = Some(p);
        }
        _ => cfg.pi_path = None,
    }
    crate::config::write_app_config(cfg)?;
    invalidate_pi_path_cache();
    resolve_pi().await
}

// ---------- agent process management ----------

struct Agent {
    id: String,
    cwd: String,
    session_path: Arc<Mutex<Option<String>>>,
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    streaming: Arc<AtomicBool>,
    last_activity: Arc<AtomicI64>,
}

pub struct Supervisor<R: Runtime> {
    app: AppHandle<R>,
    agents: Arc<Mutex<HashMap<String, Agent>>>,
    counter: AtomicU64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentEventPayload {
    agent_id: String,
    event: serde_json::Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStderrPayload {
    agent_id: String,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentExitPayload {
    agent_id: String,
    code: Option<i32>,
    reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub cwd: String,
    pub session_path: Option<String>,
    pub streaming: bool,
    pub last_activity_ms: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOpts {
    pub cwd: String,
    pub session_path: Option<String>,
    #[serde(default)]
    pub extra_args: Vec<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl<R: Runtime> Supervisor<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        let sup = Self {
            app,
            agents: Arc::new(Mutex::new(HashMap::new())),
            counter: AtomicU64::new(1),
        };
        sup.start_reaper();
        sup
    }

    /// Kill agents that have been idle (not streaming, no traffic) past the configured TTL.
    fn start_reaper(&self) {
        let agents = self.agents.clone();
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                let ttl_ms = (load_app_config().idle_kill_secs.max(60) as i64) * 1000;
                let now = now_ms();
                let mut to_kill: Vec<String> = Vec::new();
                {
                    let map = agents.lock().await;
                    for (id, agent) in map.iter() {
                        let idle = now - agent.last_activity.load(Ordering::Relaxed);
                        if !agent.streaming.load(Ordering::Relaxed) && idle > ttl_ms {
                            to_kill.push(id.clone());
                        }
                    }
                }
                for id in to_kill {
                    kill_by_id(&agents, &app, &id, "idle").await;
                }
            }
        });
    }
}

async fn kill_by_id<R: Runtime>(
    agents: &Arc<Mutex<HashMap<String, Agent>>>,
    app: &AppHandle<R>,
    id: &str,
    reason: &str,
) {
    let agent = { agents.lock().await.remove(id) };
    if let Some(agent) = agent {
        let mut child = agent.child.lock().await;
        let _ = child.start_kill();
        let _ = app.emit(
            "agent-exit",
            AgentExitPayload {
                agent_id: id.to_string(),
                code: None,
                reason: reason.to_string(),
            },
        );
    }
}

#[tauri::command]
pub async fn spawn_agent(
    app: AppHandle,
    sup: State<'_, Supervisor<tauri::Wry>>,
    opts: SpawnOpts,
) -> Result<String, String> {
    spawn_agent_impl(app, &sup, opts).await
}

pub async fn spawn_agent_impl<R: Runtime>(
    app: AppHandle<R>,
    sup: &Supervisor<R>,
    opts: SpawnOpts,
) -> Result<String, String> {
    let pi = find_pi_binary().ok_or("pi binary not found — install pi first (brew install pi or see pi.dev)")?;

    // Enforce the process limit: evict the longest-idle non-streaming agent if needed.
    let limit = load_app_config().process_limit.max(1) as usize;
    loop {
        let (count, oldest_idle) = {
            let map = sup.agents.lock().await;
            let mut oldest: Option<(String, i64)> = None;
            for (id, a) in map.iter() {
                if !a.streaming.load(Ordering::Relaxed) {
                    let ts = a.last_activity.load(Ordering::Relaxed);
                    if oldest.as_ref().map(|(_, t)| ts < *t).unwrap_or(true) {
                        oldest = Some((id.clone(), ts));
                    }
                }
            }
            (map.len(), oldest)
        };
        if count < limit {
            break;
        }
        match oldest_idle {
            Some((id, _)) => kill_by_id(&sup.agents, &app, &id, "evicted").await,
            None => return Err(format!("Достигнут лимит одновременных агентов ({limit}), и все заняты. Дождитесь завершения или увеличьте лимит в настройках.")),
        }
    }

    let mut args: Vec<String> = vec!["--mode".into(), "rpc".into()];
    if let Some(ref session) = opts.session_path {
        args.push("--session".into());
        args.push(session.clone());
    }
    args.extend(opts.extra_args.iter().cloned());

    let mut child = Command::new(&pi)
        .args(&args)
        .current_dir(&opts.cwd)
        .env("PATH", child_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to spawn pi: {e}"))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let agent_id = format!(
        "agent-{}-{}",
        now_ms(),
        sup.counter.fetch_add(1, Ordering::Relaxed)
    );

    let agent = Agent {
        id: agent_id.clone(),
        cwd: opts.cwd.clone(),
        session_path: Arc::new(Mutex::new(opts.session_path.clone())),
        stdin: Arc::new(Mutex::new(stdin)),
        child: Arc::new(Mutex::new(child)),
        streaming: Arc::new(AtomicBool::new(false)),
        last_activity: Arc::new(AtomicI64::new(now_ms())),
    };

    // stdout reader: strict JSONL framing, event fan-out to the WebView.
    {
        let app = app.clone();
        let id = agent_id.clone();
        let streaming = agent.streaming.clone();
        let last_activity = agent.last_activity.clone();
        let session_path = agent.session_path.clone();
        let mut reader = stdout;
        tauri::async_runtime::spawn(async move {
            let mut framer = LineFramer::new();
            let mut buf = [0u8; 16384];
            loop {
                match reader.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        last_activity.store(now_ms(), Ordering::Relaxed);
                        for line in framer.push(&buf[..n]) {
                            match serde_json::from_str::<serde_json::Value>(&line) {
                                Ok(event) => {
                                    match event.get("type").and_then(|t| t.as_str()) {
                                        Some("agent_start") => streaming.store(true, Ordering::Relaxed),
                                        Some("agent_end") => streaming.store(false, Ordering::Relaxed),
                                        // Sniff the session path from get_state responses.
                                        Some("response")
                                            if event.get("command").and_then(|c| c.as_str())
                                                == Some("get_state") =>
                                        {
                                            if let Some(p) = event
                                                .pointer("/data/sessionPath")
                                                .or_else(|| event.pointer("/data/sessionFile"))
                                                .and_then(|v| v.as_str())
                                            {
                                                *session_path.lock().await = Some(p.to_string());
                                            }
                                        }
                                        _ => {}
                                    }
                                    let _ = app.emit(
                                        "agent-event",
                                        AgentEventPayload { agent_id: id.clone(), event },
                                    );
                                }
                                Err(_) => {
                                    let _ = app.emit(
                                        "agent-stderr",
                                        AgentStderrPayload {
                                            agent_id: id.clone(),
                                            line: format!("[unparseable] {}", &line[..line.len().min(500)]),
                                        },
                                    );
                                }
                            }
                        }
                    }
                }
            }
        });
    }

    // stderr reader
    {
        let app = app.clone();
        let id = agent_id.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut l = line;
                l.truncate(4000);
                let _ = app.emit("agent-stderr", AgentStderrPayload { agent_id: id.clone(), line: l });
            }
        });
    }

    // exit watcher (poll try_wait so kill_agent can share the Child mutex)
    {
        let app = app.clone();
        let id = agent_id.clone();
        let child = agent.child.clone();
        let agents = sup.agents.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                {
                    let mut c = child.lock().await;
                    match c.try_wait() {
                        Ok(Some(status)) => {
                            let existed = { agents.lock().await.remove(&id).is_some() };
                            if existed {
                                let _ = app.emit(
                                    "agent-exit",
                                    AgentExitPayload {
                                        agent_id: id.clone(),
                                        code: status.code(),
                                        reason: "exited".into(),
                                    },
                                );
                            }
                            break;
                        }
                        Ok(None) => {}
                        Err(_) => break,
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            }
        });
    }

    sup.agents.lock().await.insert(agent_id.clone(), agent);
    Ok(agent_id)
}

#[tauri::command]
pub async fn agent_send(sup: State<'_, Supervisor<tauri::Wry>>, agent_id: String, line: String) -> Result<(), String> {
    agent_send_impl(&sup, agent_id, line).await
}

pub async fn agent_send_impl<R: Runtime>(sup: &Supervisor<R>, agent_id: String, line: String) -> Result<(), String> {
    let (stdin, last_activity) = {
        let map = sup.agents.lock().await;
        let agent = map.get(&agent_id).ok_or("agent not found")?;
        (agent.stdin.clone(), agent.last_activity.clone())
    };
    if line.contains('\n') {
        return Err("RPC command must be a single JSONL line".into());
    }
    let mut w = stdin.lock().await;
    w.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    w.write_all(b"\n").await.map_err(|e| e.to_string())?;
    w.flush().await.map_err(|e| e.to_string())?;
    last_activity.store(now_ms(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn kill_agent(app: AppHandle, sup: State<'_, Supervisor<tauri::Wry>>, agent_id: String) -> Result<(), String> {
    kill_agent_impl(app, &sup, agent_id).await
}

pub async fn kill_agent_impl<R: Runtime>(app: AppHandle<R>, sup: &Supervisor<R>, agent_id: String) -> Result<(), String> {
    kill_by_id(&sup.agents, &app, &agent_id, "killed").await;
    Ok(())
}

#[tauri::command]
pub async fn list_agents(sup: State<'_, Supervisor<tauri::Wry>>) -> Result<Vec<AgentInfo>, String> {
    list_agents_impl(&sup).await
}

pub async fn list_agents_impl<R: Runtime>(sup: &Supervisor<R>) -> Result<Vec<AgentInfo>, String> {
    let map = sup.agents.lock().await;
    let mut out = Vec::new();
    for (id, a) in map.iter() {
        out.push(AgentInfo {
            id: id.clone(),
            cwd: a.cwd.clone(),
            session_path: a.session_path.lock().await.clone(),
            streaming: a.streaming.load(Ordering::Relaxed),
            last_activity_ms: a.last_activity.load(Ordering::Relaxed),
        });
    }
    Ok(out)
}

// Used by integration tests / doctor screen: keep the module self-contained.
#[allow(dead_code)]
fn _assert_agent_fields_used(a: &Agent) -> &str {
    &a.id
}
