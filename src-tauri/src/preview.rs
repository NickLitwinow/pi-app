// Preview panel backend: launches a project's dev server (from .claude/launch.json,
// the same format the preview tooling uses) so the app can embed it in an iframe
// for live UI development. Output is streamed to the WebView as `preview-output`
// events. DOM/console inspection for the *agent* is provided natively by browser
// extensions (pi-agent-browser-native / pi-chrome) installed from the panel — an
// iframe to localhost is cross-origin, so the app itself cannot read into it.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

use crate::supervisor::child_path;

static RUN_COUNTER: AtomicU64 = AtomicU64::new(1);
// serverId → (kill-signal sender, pid лидера группы, label=cwd). Задача-владелец
// ждёт сигнал; pid нужен для SIGKILL группе при выходе и для процесс-панели.
struct ServerRecord {
    kill_tx: oneshot::Sender<()>,
    pid: Option<u32>,
    cwd: String,
    config_name: String,
    url: String,
    port: u16,
    logs: VecDeque<String>,
    started_at_ms: i64,
    last_activity_ms: i64,
    lease_until_ms: Option<i64>,
}

static SERVERS: Mutex<Option<HashMap<String, ServerRecord>>> = Mutex::new(None);

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn idle_expired(last_activity_ms: i64, current_ms: i64, timeout_secs: u64) -> bool {
    timeout_secs > 0
        && current_ms.saturating_sub(last_activity_ms) >= timeout_secs.saturating_mul(1000) as i64
}

fn idle_expired_with_lease(
    last_activity_ms: i64,
    current_ms: i64,
    timeout_secs: u64,
    lease_until_ms: Option<i64>,
) -> bool {
    if lease_until_ms
        .map(|lease_until| current_ms < lease_until)
        .unwrap_or(false)
    {
        return false;
    }
    idle_expired(last_activity_ms, current_ms, timeout_secs)
}

/// Снимок работающих dev-серверов для процесс-панели: (serverId, label, pid).
pub fn server_list() -> Vec<(String, String, Option<u32>, i64)> {
    SERVERS
        .lock()
        .unwrap()
        .as_ref()
        .map(|m| {
            m.iter()
                .map(|(id, record)| {
                    (
                        id.clone(),
                        record.cwd.clone(),
                        record.pid,
                        record.started_at_ms,
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Mark explicit interaction with the preview pane so the idle reaper does not
/// stop a server the user is actively inspecting.
#[tauri::command]
pub fn preview_touch(server_id: String) -> Result<(), String> {
    if let Some(record) = SERVERS
        .lock()
        .unwrap()
        .as_mut()
        .and_then(|m| m.get_mut(&server_id))
    {
        record.last_activity_ms = now_ms();
    }
    Ok(())
}

/// Завершить dev-сервер со всей process group (npm → vite/node): SIGTERM группе,
/// до 1с грейса, затем безусловный SIGKILL — иначе дети переживают лидера и
/// держат порт/память.
async fn kill_child_group(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let pgid = -(pid as i32);
        unsafe { libc::kill(pgid, libc::SIGTERM) };
        let _ = tokio::time::timeout(std::time::Duration::from_secs(1), child.wait()).await;
        unsafe { libc::kill(pgid, libc::SIGKILL) };
        let _ = child.try_wait();
        return;
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
}

/// Аварийная остановка всех dev-серверов при выходе приложения: сигнал задачам
/// плюс немедленный SIGKILL группам (задачи могут не успеть до завершения процесса).
pub fn stop_all_servers() {
    let entries: Vec<ServerRecord> = SERVERS
        .lock()
        .unwrap()
        .as_mut()
        .map(|m| m.drain().map(|(_, v)| v).collect())
        .unwrap_or_default();
    let pids: Vec<u32> = entries.iter().filter_map(|record| record.pid).collect();
    for record in entries {
        let _ = record.kill_tx.send(());
    }
    #[cfg(unix)]
    {
        for pid in &pids {
            unsafe { libc::kill(-(*pid as i32), libc::SIGTERM) };
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        for pid in pids {
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        }
    }
    #[cfg(not(unix))]
    let _ = pids;
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LaunchConfig {
    pub name: String,
    pub runtime_executable: String,
    #[serde(default)]
    pub runtime_args: Vec<String>,
    pub port: u16,
}

fn launch_json_path(cwd: &str) -> PathBuf {
    Path::new(cwd).join(".claude").join("launch.json")
}

/// Read dev-server configurations from a project's .claude/launch.json.
#[tauri::command]
pub fn preview_configs(cwd: String) -> Vec<LaunchConfig> {
    let Ok(text) = std::fs::read_to_string(launch_json_path(&cwd)) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    v.get("configurations")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| serde_json::from_value(c.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// Create or update (matched by name) a dev-server configuration.
#[tauri::command]
pub fn preview_save_config(cwd: String, config: LaunchConfig) -> Result<(), String> {
    let path = launch_json_path(&cwd);
    let mut configs = preview_configs(cwd.clone());
    if let Some(existing) = configs.iter_mut().find(|c| c.name == config.name) {
        *existing = config;
    } else {
        configs.push(config);
    }
    let doc = serde_json::json!({ "version": "0.0.1", "configurations": configs });
    let content = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewOutput {
    server_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<String>,
    done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<i32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewHandle {
    pub server_id: String,
    pub url: String,
    pub port: u16,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStatus {
    pub server_id: String,
    pub config_name: String,
    pub cwd: String,
    pub url: String,
    pub port: u16,
    pub running: bool,
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<String>,
    pub started_at_ms: i64,
    pub last_activity_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_until_ms: Option<i64>,
    pub logs: Vec<String>,
}

fn status_snapshot(cwd: &str, server_id: Option<&str>) -> Option<PreviewStatus> {
    SERVERS.lock().unwrap().as_ref().and_then(|servers| {
        servers
            .iter()
            .find(|(id, record)| {
                record.cwd == cwd
                    && server_id
                        .map(|wanted| wanted == id.as_str())
                        .unwrap_or(true)
            })
            .map(|(id, record)| PreviewStatus {
                server_id: id.clone(),
                config_name: record.config_name.clone(),
                cwd: record.cwd.clone(),
                url: record.url.clone(),
                port: record.port,
                running: true,
                ready: false,
                http_status: None,
                started_at_ms: record.started_at_ms,
                last_activity_ms: record.last_activity_ms,
                lease_until_ms: record.lease_until_ms,
                logs: record.logs.iter().cloned().collect(),
            })
    })
}

pub fn preview_belongs_to(server_id: &str, cwd: &str) -> bool {
    SERVERS
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|servers| servers.get(server_id))
        .map(|record| record.cwd == cwd)
        .unwrap_or(false)
}

pub fn preview_set_lease(server_id: &str, cwd: &str, lease_secs: u64) -> Result<i64, String> {
    let lease_secs = lease_secs.min(8 * 60 * 60);
    let lease_until_ms = now_ms().saturating_add(lease_secs.saturating_mul(1_000) as i64);
    let mut guard = SERVERS.lock().unwrap();
    let record = guard
        .as_mut()
        .and_then(|servers| servers.get_mut(server_id))
        .filter(|record| record.cwd == cwd)
        .ok_or("preview server does not belong to this agent workspace")?;
    record.lease_until_ms = Some(lease_until_ms);
    record.last_activity_ms = now_ms();
    Ok(lease_until_ms)
}

/// Return agent-owned previews to the ordinary UI idle policy when the owning
/// Pi process has no foreground or background work left. A currently focused
/// Preview pane keeps the server alive through `preview_touch` heartbeats.
pub fn preview_release_lease_for_cwd(cwd: &str) {
    let current_ms = now_ms();
    if let Some(servers) = SERVERS.lock().unwrap().as_mut() {
        for record in servers.values_mut() {
            if record.cwd == cwd && record.lease_until_ms.is_some() {
                record.lease_until_ms = None;
                record.last_activity_ms = current_ms;
            }
        }
    }
}

/// Return the active server for this workspace and probe its HTTP endpoint.
/// The status call is shared by the UI and the model-facing harness bridge, so
/// both observe the same process, logs and readiness boundary.
#[tauri::command]
pub async fn preview_status(
    cwd: String,
    server_id: Option<String>,
) -> Result<Option<PreviewStatus>, String> {
    let Some(mut status) = status_snapshot(&cwd, server_id.as_deref()) else {
        return Ok(None);
    };
    match crate::pi_cli::probe_url(status.url.clone()).await {
        Ok(code) => {
            status.ready = true;
            status.http_status = Some(code);
        }
        Err(_) => {}
    }
    Ok(Some(status))
}

/// Start a dev server by config name (or the first config if `name` is None).
/// Streams stdout/stderr as `preview-output` events; returns the local URL.
#[tauri::command]
pub async fn preview_start(
    app: AppHandle,
    cwd: String,
    name: Option<String>,
) -> Result<PreviewHandle, String> {
    preview_start_impl(app, cwd, name).await
}

pub async fn preview_start_impl<R: Runtime>(
    app: AppHandle<R>,
    cwd: String,
    name: Option<String>,
) -> Result<PreviewHandle, String> {
    let configs = preview_configs(cwd.clone());
    let cfg = match &name {
        Some(n) => configs.into_iter().find(|c| &c.name == n),
        None => configs.into_iter().next(),
    }
    .ok_or("конфигурация запуска не найдена в .claude/launch.json")?;

    let existing = {
        let guard = SERVERS.lock().unwrap();
        guard.as_ref().and_then(|servers| {
            servers.iter().find_map(|(id, record)| {
                (record.cwd == cwd && record.config_name == cfg.name).then(|| PreviewHandle {
                    server_id: id.clone(),
                    url: record.url.clone(),
                    port: record.port,
                })
            })
        })
    };
    if let Some(existing) = existing {
        preview_touch(existing.server_id.clone())?;
        return Ok(existing);
    }

    let server_id = format!("prev-{}", RUN_COUNTER.fetch_add(1, Ordering::Relaxed));
    let port = cfg.port;
    let url = format!("http://localhost:{port}");

    #[cfg(target_os = "macos")]
    let sandbox_profile = (crate::config::load_app_config().agent_sandbox_mode
        == "workspace-write"
        && Path::new("/usr/bin/sandbox-exec").exists())
    .then(|| crate::supervisor::workspace_sandbox_profile(Path::new(&cwd), None));
    #[cfg(target_os = "macos")]
    let mut cmd = if let Some(profile) = sandbox_profile.as_ref() {
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command.args(["-p", profile, &cfg.runtime_executable]);
        command
    } else {
        Command::new(&cfg.runtime_executable)
    };
    #[cfg(not(target_os = "macos"))]
    let mut cmd = Command::new(&cfg.runtime_executable);
    cmd.args(&cfg.runtime_args)
        .current_dir(&cwd)
        .env("PATH", child_path())
        .env("NO_COLOR", "1")
        .env("BROWSER", "none") // не открывать системный браузер (CRA/vite)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // собственная process group — см. kill_child_group
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            libc::setpgid(0, 0);
            Ok(())
        });
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("не удалось запустить «{}»: {e}", cfg.runtime_executable))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    let child_pid = child.id();
    SERVERS
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(
            server_id.clone(),
            ServerRecord {
                kill_tx,
                pid: child_pid,
                cwd: cwd.clone(),
                config_name: cfg.name.clone(),
                url: url.clone(),
                port,
                logs: VecDeque::with_capacity(320),
                started_at_ms: now_ms(),
                last_activity_ms: now_ms(),
                lease_until_ms: None,
            },
        );

    for reader in [
        stdout.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        stderr.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let app = app.clone();
        let server_id = server_id.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(mut line)) = lines.next_line().await {
                crate::text::truncate_bytes(&mut line, 4000);
                if let Some(record) = SERVERS
                    .lock()
                    .unwrap()
                    .as_mut()
                    .and_then(|servers| servers.get_mut(&server_id))
                {
                    if record.logs.len() >= 320 {
                        record.logs.pop_front();
                    }
                    record.logs.push_back(line.clone());
                }
                let _ = app.emit(
                    "preview-output",
                    PreviewOutput {
                        server_id: server_id.clone(),
                        line: Some(line),
                        done: false,
                        code: None,
                    },
                );
            }
        });
    }

    // Открытая, но забытая панель больше не держит dev-server бесконечно.
    // 0 отключает reaper; UI по умолчанию выставляет 10 минут.
    {
        let server_id = server_id.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                let timeout_secs = crate::config::load_app_config().preview_idle_kill_secs;
                if timeout_secs == 0 {
                    continue;
                }
                let expired = SERVERS.lock().unwrap().as_ref().and_then(|m| {
                    m.get(&server_id).map(|record| {
                        idle_expired_with_lease(
                            record.last_activity_ms,
                            now_ms(),
                            timeout_secs,
                            record.lease_until_ms,
                        )
                    })
                });
                match expired {
                    None => break,
                    Some(true) => {
                        let _ = preview_stop(server_id.clone());
                        break;
                    }
                    Some(false) => {}
                }
            }
        });
    }

    {
        let app = app.clone();
        let server_id = server_id.clone();
        tauri::async_runtime::spawn(async move {
            let code = tokio::select! {
                status = child.wait() => status.ok().and_then(|s| s.code()),
                _ = kill_rx => {
                    kill_child_group(&mut child).await;
                    None
                }
            };
            if let Some(map) = SERVERS.lock().unwrap().as_mut() {
                map.remove(&server_id);
            }
            let _ = app.emit(
                "preview-output",
                PreviewOutput {
                    server_id,
                    line: None,
                    done: true,
                    code,
                },
            );
        });
    }

    Ok(PreviewHandle {
        server_id,
        url,
        port,
    })
}

/// Stop a running dev server started with preview_start.
#[tauri::command]
pub fn preview_stop(server_id: String) -> Result<(), String> {
    let entry = SERVERS
        .lock()
        .unwrap()
        .as_mut()
        .and_then(|m| m.remove(&server_id));
    if let Some(record) = entry {
        let _ = record.kill_tx.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{idle_expired, idle_expired_with_lease};

    #[test]
    fn preview_idle_timeout_is_disabled_at_zero_and_saturates() {
        assert!(!idle_expired(1_000, 99_000, 0));
        assert!(!idle_expired(1_000, 60_999, 60));
        assert!(idle_expired(1_000, 61_000, 60));
        assert!(!idle_expired(10_000, 5_000, 1));
        assert!(
            !idle_expired_with_lease(1_000, 10_000_000, 60, Some(10_000_001)),
            "an agent-owned preview survives ordinary UI idle cleanup during its bounded lease"
        );
        assert!(idle_expired_with_lease(
            1_000,
            10_000_000,
            60,
            Some(9_999_999)
        ));
    }
}
