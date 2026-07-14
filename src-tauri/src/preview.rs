// Preview panel backend: launches a project's dev server (from .claude/launch.json,
// the same format the preview tooling uses) so the app can embed it in an iframe
// for live UI development. Output is streamed to the WebView as `preview-output`
// events. DOM/console inspection for the *agent* is provided natively by browser
// extensions (pi-agent-browser-native / pi-chrome) installed from the panel — an
// iframe to localhost is cross-origin, so the app itself cannot read into it.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
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
    label: String,
    started_at_ms: i64,
    last_activity_ms: i64,
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
                        record.label.clone(),
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

/// Start a dev server by config name (or the first config if `name` is None).
/// Streams stdout/stderr as `preview-output` events; returns the local URL.
#[tauri::command]
pub async fn preview_start(
    app: AppHandle,
    cwd: String,
    name: Option<String>,
) -> Result<PreviewHandle, String> {
    let configs = preview_configs(cwd.clone());
    let cfg = match &name {
        Some(n) => configs.into_iter().find(|c| &c.name == n),
        None => configs.into_iter().next(),
    }
    .ok_or("конфигурация запуска не найдена в .claude/launch.json")?;

    let server_id = format!("prev-{}", RUN_COUNTER.fetch_add(1, Ordering::Relaxed));
    let port = cfg.port;

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
                line.truncate(4000);
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
                label: cwd.clone(),
                started_at_ms: now_ms(),
                last_activity_ms: now_ms(),
            },
        );

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
                    m.get(&server_id)
                        .map(|record| idle_expired(record.last_activity_ms, now_ms(), timeout_secs))
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
        url: format!("http://localhost:{port}"),
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
    use super::idle_expired;

    #[test]
    fn preview_idle_timeout_is_disabled_at_zero_and_saturates() {
        assert!(!idle_expired(1_000, 99_000, 0));
        assert!(!idle_expired(1_000, 60_999, 60));
        assert!(idle_expired(1_000, 61_000, 60));
        assert!(!idle_expired(10_000, 5_000, 1));
    }
}
