use serde::Serialize;
use serde_json::Value;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::supervisor::{child_path, find_pi_binary};

static RUN_COUNTER: AtomicU64 = AtomicU64::new(1);
static RUNNING_GROUPS: LazyLock<Mutex<std::collections::HashSet<u32>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

/// App-exit cleanup for management commands and any children they spawned.
pub fn stop_all_runs() {
    let pids: Vec<u32> = RUNNING_GROUPS
        .lock()
        .map(|mut s| s.drain().collect())
        .unwrap_or_default();
    #[cfg(unix)]
    {
        for pid in &pids {
            unsafe { libc::kill(-(*pid as i32), libc::SIGTERM) };
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        for pid in pids {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PiCliOutput {
    run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<String>,
    done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<i32>,
}

const ALLOWED: &[&str] = &[
    "install",
    "remove",
    "uninstall",
    "update",
    "list",
    "--version",
    "--list-models",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiUpdateInfo {
    current_version: Option<String>,
    latest_version: Option<String>,
    update_available: bool,
    checked: bool,
    error: Option<String>,
}

fn extract_version(text: &str) -> Option<String> {
    text.split_whitespace()
        .map(|part| {
            part.trim_start_matches('v')
                .trim_matches(|c: char| !(c.is_ascii_digit() || c == '.'))
        })
        .find(|part| {
            part.split('.').count() >= 2 && part.chars().all(|c| c.is_ascii_digit() || c == '.')
        })
        .map(str::to_string)
}

fn version_parts(version: &str) -> Vec<u64> {
    version
        .split('.')
        .map(|part| part.parse().unwrap_or(0))
        .collect()
}

fn version_is_newer(latest: &str, current: &str) -> bool {
    let mut left = version_parts(latest);
    let mut right = version_parts(current);
    let len = left.len().max(right.len());
    left.resize(len, 0);
    right.resize(len, 0);
    left > right
}

/// Compare the installed pi CLI with the current Earendil npm release.
#[tauri::command]
pub async fn check_pi_update() -> PiUpdateInfo {
    let current = match find_pi_binary() {
        Some(pi) => Command::new(pi)
            .arg("--version")
            .env("PATH", child_path())
            .output()
            .await
            .ok()
            .and_then(|out| extract_version(&String::from_utf8_lossy(&out.stdout))),
        None => None,
    };
    let out = Command::new("/usr/bin/curl")
        .args([
            "-sSL",
            "--compressed",
            "--max-time",
            "12",
            "https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest",
        ])
        .stdin(Stdio::null())
        .output()
        .await;
    let latest = out
        .ok()
        .and_then(|response| serde_json::from_slice::<Value>(&response.stdout).ok())
        .and_then(|value| {
            value
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    let checked = current.is_some() && latest.is_some();
    let update_available = current
        .as_deref()
        .zip(latest.as_deref())
        .is_some_and(|(installed, newest)| version_is_newer(newest, installed));
    PiUpdateInfo {
        current_version: current,
        latest_version: latest,
        update_available,
        checked,
        error: (!checked).then(|| "Не удалось определить текущую или последнюю версию pi".into()),
    }
}

/// Run a pi management subcommand (install/remove/update/list), streaming
/// output lines to the WebView as `pi-cli-output` events. Returns a run id.
#[tauri::command]
pub async fn pi_cli_run(
    app: AppHandle,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    pi_cli_run_impl(app, args, cwd).await
}

/// Probe a custom endpoint (проверка «жив ли» remote/локальный LLM-сервер).
/// Uses system curl to avoid pulling an HTTP+TLS stack into the binary.
#[tauri::command]
pub async fn probe_url(url: String) -> Result<String, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("URL должен начинаться с http:// или https://".into());
    }
    let out = Command::new("/usr/bin/curl")
        .args([
            "-s",
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            "--max-time",
            "6",
            &url,
        ])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let code = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if code == "000" || code.is_empty() {
        Err("нет соединения (таймаут или отказ)".into())
    } else {
        Ok(code)
    }
}

pub async fn pi_cli_run_impl<R: Runtime>(
    app: AppHandle<R>,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    if args.is_empty() || !ALLOWED.contains(&args[0].as_str()) {
        return Err("subcommand not allowed".into());
    }
    let pi = find_pi_binary().ok_or("pi binary not found")?;
    let run_id = format!("run-{}", RUN_COUNTER.fetch_add(1, Ordering::Relaxed));

    let mut cmd = Command::new(&pi);
    cmd.args(&args)
        .env("NO_COLOR", "1")
        .env("PATH", child_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        let path = std::path::PathBuf::from(cwd);
        if !path.is_dir() {
            return Err("workspace для локальной установки не существует".into());
        }
        cmd.current_dir(path);
    }
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            libc::setpgid(0, 0);
            Ok(())
        });
    }
    let mut child = cmd.spawn().map_err(|e| format!("failed to run pi: {e}"))?;
    let child_pid = child.id();
    if let Some(pid) = child_pid {
        if let Ok(mut groups) = RUNNING_GROUPS.lock() {
            groups.insert(pid);
        }
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    for (stream_name, reader) in [
        (
            "out",
            stdout.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        ),
        (
            "err",
            stderr.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        ),
    ] {
        if let Some(r) = reader {
            let app = app.clone();
            let run_id = run_id.clone();
            let stream_name = stream_name.to_string();
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(r).lines();
                while let Ok(Some(mut line)) = lines.next_line().await {
                    line.truncate(4000);
                    let _ = app.emit(
                        "pi-cli-output",
                        PiCliOutput {
                            run_id: run_id.clone(),
                            stream: Some(stream_name.clone()),
                            line: Some(line),
                            done: false,
                            code: None,
                        },
                    );
                }
            });
        }
    }

    {
        let app = app.clone();
        let run_id = run_id.clone();
        tauri::async_runtime::spawn(async move {
            let code = child.wait().await.ok().and_then(|s| s.code());
            if let Some(pid) = child_pid {
                if let Ok(mut groups) = RUNNING_GROUPS.lock() {
                    groups.remove(&pid);
                }
            }
            let _ = app.emit(
                "pi-cli-output",
                PiCliOutput {
                    run_id,
                    stream: None,
                    line: None,
                    done: true,
                    code,
                },
            );
        });
    }

    Ok(run_id)
}

#[cfg(test)]
mod version_tests {
    use super::*;

    #[test]
    fn extracts_and_compares_versions() {
        assert_eq!(extract_version("pi 0.80.3"), Some("0.80.3".into()));
        assert_eq!(extract_version("0.80.6\n"), Some("0.80.6".into()));
        assert!(version_is_newer("0.80.10", "0.80.6"));
        assert!(!version_is_newer("0.80.6", "0.80.6"));
        assert!(!version_is_newer("0.79.9", "0.80.0"));
    }
}
