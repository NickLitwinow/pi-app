use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

use crate::config::load_app_config;
use crate::jsonl::LineFramer;

#[cfg(target_os = "macos")]
fn sandbox_quote(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn sandbox_regex_literal(path: &Path) -> String {
    let mut escaped = String::new();
    for ch in path.to_string_lossy().chars() {
        match ch {
            '\\' | '.' | '+' | '*' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '$' | '|' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            // Keep the Seatbelt #"..." regex literal structurally intact even
            // for unusual user directory names.
            '"' => escaped.push_str("\\x22"),
            '\n' => escaped.push_str("\\x0A"),
            '\r' => escaped.push_str("\\x0D"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

#[cfg(target_os = "macos")]
fn canonical_or_original(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Allow reads everywhere, but keep all writes from the agent and its child
/// tools inside the workspace, durable Pi session storage, and OS scratch.
/// This is deliberately an OS boundary rather than a prompt convention.
#[cfg(target_os = "macos")]
fn workspace_sandbox_profile(cwd: &Path, session_path: Option<&str>) -> String {
    let agent_dir = crate::sessions::agent_dir();
    let mut writable = vec![
        canonical_or_original(cwd),
        canonical_or_original(&agent_dir.join("sessions")),
        canonical_or_original(&agent_dir.join("logs")),
        // Pi uses proper-lockfile even for read-only settings/auth/model-store
        // access. Keep those narrow runtime locks writable without exposing the
        // package, skill, or extension trees under the agent directory.
        agent_dir.join("settings.json.lock"),
        agent_dir.join("auth.json"),
        agent_dir.join("auth.json.lock"),
        agent_dir.join("models-store.json"),
        agent_dir.join("models-store.json.lock"),
        // Pi 0.81+ acquires this lock while resolving project-local resources.
        // Without it, the sandboxed RPC process exits with EPERM before the
        // first prompt can be processed.
        agent_dir.join("trust.json"),
        agent_dir.join("trust.json.lock"),
        agent_dir.join("mcp-cache.json"),
        agent_dir.join("mcp-npx-cache.json"),
        agent_dir.join("mcp-onboarding.json"),
        agent_dir.join("mcp-oauth"),
        canonical_or_original(&std::env::temp_dir()),
        PathBuf::from("/tmp"),
        PathBuf::from("/private/tmp"),
    ];
    if let Some(config_dir) = dirs::config_dir() {
        writable.push(config_dir.join("ponytail"));
    }
    if let Some(parent) = session_path.and_then(|path| Path::new(path).parent()) {
        writable.push(canonical_or_original(parent));
    }
    writable.sort();
    writable.dedup();
    let rules = writable
        .iter()
        .map(|path| format!("(subpath \"{}\")", sandbox_quote(path)))
        .collect::<Vec<_>>()
        .join(" ");
    // pi-mcp-adapter writes these caches atomically next to their final file.
    // The PID is not known until after Seatbelt is configured, so allow only
    // the adapter's exact <name>.<numeric-pid>.tmp shape.
    let agent_dir_pattern = sandbox_regex_literal(&canonical_or_original(&agent_dir));
    let atomic_runtime_rules = ["mcp-cache", "mcp-npx-cache", "mcp-onboarding"]
        .iter()
        .map(|name| format!("(regex #\"^{agent_dir_pattern}/{name}[.]json[.][0-9]+[.]tmp$\")"))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* {rules} {atomic_runtime_rules} (literal \"/dev/null\") (literal \"/dev/tty\"))"
    )
}

// ---------- pi binary resolution ----------

/// Cached resolution result; `None` means "not resolved yet" (so a user-set
/// path or install can be picked up without restarting the app).
static PI_PATH: std::sync::Mutex<Option<Option<String>>> = std::sync::Mutex::new(None);
static LOGIN_PATH: OnceLock<Option<String>> = OnceLock::new();
static APP_STARTED: OnceLock<std::time::Instant> = OnceLock::new();

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
        for rel in [
            ".local/bin/pi",
            ".pi/bin/pi",
            ".bun/bin/pi",
            ".npm-global/bin/pi",
        ] {
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
        if let Ok(out) = Command::new(p)
            .arg("--version")
            .env("PATH", child_path())
            .output()
            .await
        {
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
    /// Number of queued/running harness background tasks hosted by this pi
    /// process. Background work can outlive the foreground model turn, so it
    /// must protect the process from idle cleanup and process-limit eviction.
    background_tasks: Arc<AtomicU64>,
    last_activity: Arc<AtomicI64>,
    started_at_ms: i64,
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
    pub background_tasks: u64,
    pub last_activity_ms: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundExitRequestedPayload {
    pub task_count: u64,
}

fn background_task_count(event: &serde_json::Value) -> Option<u64> {
    if event.get("type").and_then(|value| value.as_str()) != Some("extension_ui_request")
        || event.get("method").and_then(|value| value.as_str()) != Some("setWidget")
        || event.get("widgetKey").and_then(|value| value.as_str())
            != Some("pi-app-background-state")
    {
        return None;
    }
    let text = event
        .get("widgetLines")
        .and_then(|value| value.as_array())
        .map(|lines| {
            lines
                .iter()
                .filter_map(|line| line.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .or_else(|| {
            event
                .get("widgetText")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Some(0);
    }
    let tasks = serde_json::from_str::<Vec<serde_json::Value>>(&text).ok()?;
    Some(
        tasks
            .iter()
            .filter(|task| {
                matches!(
                    task.get("status").and_then(|value| value.as_str()),
                    Some("queued" | "running")
                )
            })
            .count() as u64,
    )
}

fn workload_is_active(streaming: bool, background_tasks: u64) -> bool {
    streaming || background_tasks > 0
}

fn idle_reap_eligible(streaming: bool, background_tasks: u64, idle_ms: i64, ttl_ms: i64) -> bool {
    !workload_is_active(streaming, background_tasks) && idle_ms > ttl_ms
}

fn agent_is_busy(agent: &Agent) -> bool {
    workload_is_active(
        agent.streaming.load(Ordering::Relaxed),
        agent.background_tasks.load(Ordering::Relaxed),
    )
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

    /// Kill agents that have been idle (no foreground turn, background task,
    /// or traffic) past the configured TTL.
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
                        if idle_reap_eligible(
                            agent.streaming.load(Ordering::Relaxed),
                            agent.background_tasks.load(Ordering::Relaxed),
                            idle,
                            ttl_ms,
                        ) {
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

/// Завершить процесс вместе со всей его process group. pi спавнит детей
/// (MCP-серверы, node-хелперы); kill только лидера сиротил их — утечка RAM.
/// SIGTERM группе → до 1с грейса → безусловный SIGKILL группе (группа
/// переживает смерть лидера, поэтому добиваем всегда).
async fn kill_group(child: &Arc<Mutex<Child>>) {
    #[cfg(unix)]
    {
        let pid = { child.lock().await.id() };
        if let Some(pid) = pid {
            let pgid = -(pid as i32);
            unsafe { libc::kill(pgid, libc::SIGTERM) };
            for _ in 0..10 {
                if child.lock().await.try_wait().ok().flatten().is_some() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            unsafe { libc::kill(pgid, libc::SIGKILL) };
            let _ = child.lock().await.try_wait();
            return;
        }
    }
    let _ = child.lock().await.start_kill();
}

/// Завершить всех агентов (выход приложения) — группы целиком.
pub async fn kill_all_agents<R: Runtime>(sup: &Supervisor<R>) {
    let ids: Vec<String> = sup.agents.lock().await.keys().cloned().collect();
    for id in ids {
        kill_by_id(&sup.agents, &sup.app, &id, "killed").await;
    }
}

pub async fn active_background_task_count<R: Runtime>(sup: &Supervisor<R>) -> u64 {
    sup.agents
        .lock()
        .await
        .values()
        .map(|agent| agent.background_tasks.load(Ordering::Relaxed))
        .sum()
}

/// Called only after the user explicitly confirms quitting while long-running
/// background work is active. Programmatic exit carries an exit code, so the
/// RunEvent guard can distinguish it from a fresh user quit request.
#[tauri::command]
pub fn confirm_app_exit(app: AppHandle) {
    app.exit(0);
}

async fn kill_by_id<R: Runtime>(
    agents: &Arc<Mutex<HashMap<String, Agent>>>,
    app: &AppHandle<R>,
    id: &str,
    reason: &str,
) {
    let agent = { agents.lock().await.remove(id) };
    if let Some(agent) = agent {
        kill_group(&agent.child).await;
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
    let pi = find_pi_binary()
        .ok_or("pi binary not found — install pi first (brew install pi or see pi.dev)")?;

    // Enforce the process limit: evict only a genuinely idle process. A pi
    // process hosting background work is busy even after its foreground turn
    // has emitted agent_end.
    let app_config = load_app_config();
    let limit = if app_config.process_limit_auto && crate::config::local_provider_configured() {
        1
    } else {
        app_config.process_limit.max(1) as usize
    };
    loop {
        let (count, oldest_idle) = {
            let map = sup.agents.lock().await;
            let mut oldest: Option<(String, i64)> = None;
            for (id, a) in map.iter() {
                if !agent_is_busy(a) {
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

    // Сторож зависаний @narumitw/pi-retry по умолчанию рвёт стрим после 90с
    // молчания — но локальные reasoning-модели думают непредсказуемо долго, и
    // фиксированный таймаут ложно оборвёт долгое размышление («Повтор после
    // ошибки провайдера»). Задаём порог из конфига (по умолчанию 0 = выкл); 0
    // снимает только stall-abort, прочие ретраи расширения остаются. GUI из
    // Finder не наследует env шелла, поэтому задаём явно.
    let stall_timeout = app_config.pi_retry_stall_timeout_ms;

    #[cfg(target_os = "macos")]
    let sandbox_profile = (app_config.agent_sandbox_mode == "workspace-write"
        && Path::new("/usr/bin/sandbox-exec").exists())
    .then(|| workspace_sandbox_profile(Path::new(&opts.cwd), opts.session_path.as_deref()));
    #[cfg(target_os = "macos")]
    let mut cmd = if let Some(profile) = sandbox_profile.as_ref() {
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command.args(["-p", profile, &pi]);
        command
    } else {
        Command::new(&pi)
    };
    #[cfg(not(target_os = "macos"))]
    let mut cmd = Command::new(&pi);
    cmd.args(&args)
        .current_dir(&opts.cwd)
        .env("PATH", child_path())
        .env("PI_RETRY_STALL_TIMEOUT_MS", stall_timeout.to_string())
        .env(
            "PI_APP_SANDBOX_MODE",
            if app_config.agent_sandbox_mode == "workspace-write" {
                #[cfg(target_os = "macos")]
                {
                    if sandbox_profile.is_some() {
                        "workspace-write"
                    } else {
                        "unavailable"
                    }
                }
                #[cfg(not(target_os = "macos"))]
                {
                    "unavailable"
                }
            } else {
                "unrestricted"
            },
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Собственная process group: без неё kill доставался только лидеру, а его
    // дети (MCP-серверы и пр.) сиротели и продолжали жить (см. kill_group).
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            libc::setpgid(0, 0);
            Ok(())
        });
    }
    let mut child = cmd
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
        background_tasks: Arc::new(AtomicU64::new(0)),
        last_activity: Arc::new(AtomicI64::new(now_ms())),
        started_at_ms: now_ms(),
    };

    // stdout reader: strict JSONL framing, event fan-out to the WebView.
    {
        let app = app.clone();
        let id = agent_id.clone();
        let streaming = agent.streaming.clone();
        let background_tasks = agent.background_tasks.clone();
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
                                    if let Some(count) = background_task_count(&event) {
                                        background_tasks.store(count, Ordering::Relaxed);
                                    }
                                    match event.get("type").and_then(|t| t.as_str()) {
                                        Some("agent_start") => {
                                            streaming.store(true, Ordering::Relaxed)
                                        }
                                        Some("agent_end") => {
                                            streaming.store(false, Ordering::Relaxed)
                                        }
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
                                        AgentEventPayload {
                                            agent_id: id.clone(),
                                            event,
                                        },
                                    );
                                }
                                Err(_) => {
                                    let _ = app.emit(
                                        "agent-stderr",
                                        AgentStderrPayload {
                                            agent_id: id.clone(),
                                            line: format!(
                                                "[unparseable] {}",
                                                crate::text::head_bytes(&line, 500)
                                            ),
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
                crate::text::truncate_bytes(&mut l, 4000);
                let _ = app.emit(
                    "agent-stderr",
                    AgentStderrPayload {
                        agent_id: id.clone(),
                        line: l,
                    },
                );
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
pub async fn agent_send(
    sup: State<'_, Supervisor<tauri::Wry>>,
    agent_id: String,
    line: String,
) -> Result<(), String> {
    agent_send_impl(&sup, agent_id, line).await
}

pub async fn agent_send_impl<R: Runtime>(
    sup: &Supervisor<R>,
    agent_id: String,
    line: String,
) -> Result<(), String> {
    let (stdin, last_activity) = {
        let map = sup.agents.lock().await;
        let agent = map.get(&agent_id).ok_or("agent not found")?;
        (agent.stdin.clone(), agent.last_activity.clone())
    };
    if line.contains('\n') {
        return Err("RPC command must be a single JSONL line".into());
    }
    let mut w = stdin.lock().await;
    w.write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    w.write_all(b"\n").await.map_err(|e| e.to_string())?;
    w.flush().await.map_err(|e| e.to_string())?;
    last_activity.store(now_ms(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn kill_agent(
    app: AppHandle,
    sup: State<'_, Supervisor<tauri::Wry>>,
    agent_id: String,
) -> Result<(), String> {
    kill_agent_impl(app, &sup, agent_id).await
}

pub async fn kill_agent_impl<R: Runtime>(
    app: AppHandle<R>,
    sup: &Supervisor<R>,
    agent_id: String,
) -> Result<(), String> {
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
            background_tasks: a.background_tasks.load(Ordering::Relaxed),
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

// ---------- процесс-панель (R3-G2): RSS по process group ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcStat {
    /// "agent" | "preview" | "app"
    pub kind: String,
    pub id: String,
    /// Человекочитаемая подпись (cwd воркспейса и т.п.)
    pub label: String,
    pub pid: Option<u32>,
    pub rss_mb: f64,
    /// Сколько процессов в группе (pi + его MCP-дети и т.д.)
    pub procs: u32,
    /// Время жизни процесса/группы с момента запуска.
    pub uptime_ms: u64,
}

/// Разбор вывода `ps -axo pid=,pgid=,rss=` (rss в КБ).
/// Возвращает (rss_kb и число процессов по каждой группе; rss_kb по каждому pid).
fn parse_ps(text: &str) -> (HashMap<u32, (u64, u32)>, HashMap<u32, u64>) {
    let mut by_group: HashMap<u32, (u64, u32)> = HashMap::new();
    let mut by_pid: HashMap<u32, u64> = HashMap::new();
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let (Some(pid), Some(pgid), Some(rss)) = (it.next(), it.next(), it.next()) else {
            continue;
        };
        let (Ok(pid), Ok(pgid), Ok(rss)) =
            (pid.parse::<u32>(), pgid.parse::<u32>(), rss.parse::<u64>())
        else {
            continue;
        };
        let e = by_group.entry(pgid).or_insert((0, 0));
        e.0 += rss;
        e.1 += 1;
        by_pid.insert(pid, rss);
    }
    (by_group, by_pid)
}

fn ps_snapshot() -> (HashMap<u32, (u64, u32)>, HashMap<u32, u64>) {
    let out = std::process::Command::new("ps")
        .args(["-axo", "pid=,pgid=,rss="])
        .output();
    match out {
        Ok(o) => parse_ps(&String::from_utf8_lossy(&o.stdout)),
        Err(_) => (HashMap::new(), HashMap::new()),
    }
}

const KB_IN_MB: f64 = 1024.0;

/// Снимок памяти: агенты pi (вся process group — включая MCP-детей),
/// dev-серверы превью (группа) и собственный процесс приложения.
#[tauri::command]
pub async fn process_stats(
    sup: State<'_, Supervisor<tauri::Wry>>,
) -> Result<Vec<ProcStat>, String> {
    process_stats_impl(&sup).await
}

pub async fn process_stats_impl<R: Runtime>(sup: &Supervisor<R>) -> Result<Vec<ProcStat>, String> {
    let (by_group, by_pid) = ps_snapshot();
    let mut out = Vec::new();

    {
        let map = sup.agents.lock().await;
        for (id, a) in map.iter() {
            let pid = a.child.lock().await.id();
            let (kb, n) = pid
                .and_then(|p| by_group.get(&p))
                .copied()
                .unwrap_or((0, 0));
            out.push(ProcStat {
                kind: "agent".into(),
                id: id.clone(),
                label: a.cwd.clone(),
                pid,
                rss_mb: kb as f64 / KB_IN_MB,
                procs: n,
                uptime_ms: now_ms().saturating_sub(a.started_at_ms) as u64,
            });
        }
    }

    for (id, label, pid, started_at_ms) in crate::preview::server_list() {
        let (kb, n) = pid
            .and_then(|p| by_group.get(&p))
            .copied()
            .unwrap_or((0, 0));
        out.push(ProcStat {
            kind: "preview".into(),
            id,
            label,
            pid,
            rss_mb: kb as f64 / KB_IN_MB,
            procs: n,
            uptime_ms: now_ms().saturating_sub(started_at_ms) as u64,
        });
    }

    // собственный процесс (WebKit-хелперы macOS живут вне нашей группы и сюда не входят)
    let own = std::process::id();
    let own_kb = by_pid.get(&own).copied().unwrap_or(0);
    out.push(ProcStat {
        kind: "app".into(),
        id: "app".into(),
        label: "pi-app (процесс приложения; WebView-хелперы macOS не учитываются)".into(),
        pid: Some(own),
        rss_mb: own_kb as f64 / KB_IN_MB,
        procs: 1,
        uptime_ms: APP_STARTED
            .get_or_init(std::time::Instant::now)
            .elapsed()
            .as_millis() as u64,
    });

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{
        background_task_count, idle_reap_eligible, kill_group, parse_ps, workload_is_active,
    };
    use std::process::Stdio;
    use std::sync::Arc;
    use tokio::process::Command;
    use tokio::sync::Mutex;

    #[test]
    fn parse_ps_sums_groups_and_pids() {
        let text =
            "  101  100  2048\n  100  100  1024\n  200  200  512\nмусор строка\n  300  300  abc\n";
        let (groups, pids) = parse_ps(text);
        assert_eq!(groups.get(&100), Some(&(3072, 2)));
        assert_eq!(groups.get(&200), Some(&(512, 1)));
        assert_eq!(groups.get(&300), None, "нечисловой rss пропущен");
        assert_eq!(pids.get(&101), Some(&2048));
        assert_eq!(pids.get(&100), Some(&1024));
    }

    #[test]
    fn harness_background_widget_protects_only_active_tasks() {
        let event = serde_json::json!({
            "type": "extension_ui_request",
            "method": "setWidget",
            "widgetKey": "pi-app-background-state",
            "widgetLines": [serde_json::to_string(&serde_json::json!([
                { "id": "queued", "status": "queued" },
                { "id": "running", "status": "running" },
                { "id": "done", "status": "completed" },
                { "id": "failed", "status": "failed" }
            ])).unwrap()]
        });
        assert_eq!(background_task_count(&event), Some(2));
        assert!(workload_is_active(false, 2));
        assert!(workload_is_active(true, 0));
        assert!(!workload_is_active(false, 0));
    }

    #[test]
    fn background_widget_clear_releases_idle_protection_and_malformed_state_fails_closed() {
        let cleared = serde_json::json!({
            "type": "extension_ui_request",
            "method": "setWidget",
            "widgetKey": "pi-app-background-state"
        });
        let malformed = serde_json::json!({
            "type": "extension_ui_request",
            "method": "setWidget",
            "widgetKey": "pi-app-background-state",
            "widgetLines": ["not-json"]
        });
        assert_eq!(background_task_count(&cleared), Some(0));
        assert_eq!(background_task_count(&malformed), None);
    }

    #[test]
    fn silent_eight_hour_background_task_is_not_idle_reaped() {
        let eight_hours_ms = 8 * 60 * 60 * 1_000;
        let idle_ttl_ms = 15 * 60 * 1_000;

        assert!(!idle_reap_eligible(false, 1, eight_hours_ms, idle_ttl_ms));
        assert!(idle_reap_eligible(false, 0, eight_hours_ms, idle_ttl_ms));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn workspace_sandbox_allows_workspace_and_escapes_paths() {
        use super::workspace_sandbox_profile;
        use std::path::Path;

        let profile = workspace_sandbox_profile(
            Path::new("/tmp/project with \"quote\""),
            Some("/tmp/sessions/example.jsonl"),
        );
        assert!(profile.contains("(deny file-write*)"));
        assert!(profile.contains("project with \\\"quote\\\""));
        assert!(profile.contains("(subpath \"/tmp/sessions\")"));
        assert!(profile.contains("settings.json.lock"));
        assert!(profile.contains("trust.json"));
        assert!(profile.contains("trust.json.lock"));
        assert!(profile.contains("mcp-cache[.]json[.][0-9]+[.]tmp"));
        assert!(profile.contains("mcp-npx-cache[.]json[.][0-9]+[.]tmp"));
        assert!(profile.contains("mcp-onboarding[.]json[.][0-9]+[.]tmp"));
        assert!(profile.contains("ponytail"));
        assert!(profile.contains("(literal \"/dev/null\")"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_group_removes_leader_and_child() {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "sleep 30 & wait"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        unsafe {
            command.pre_exec(|| {
                libc::setpgid(0, 0);
                Ok(())
            });
        }
        let child = command.spawn().expect("spawn process group");
        let pid = child.id().expect("leader pid");
        let child = Arc::new(Mutex::new(child));
        kill_group(&child).await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Signal 0 succeeds while any process in the group still exists.
        let alive = unsafe { libc::kill(-(pid as i32), 0) } == 0;
        assert!(!alive, "process group {pid} survived kill_group");
    }
}
