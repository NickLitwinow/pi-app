use serde::Serialize;
use serde_json::Value;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter, Runtime, State};
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
pub(crate) struct PiCliOutput {
    run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<String>,
    done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<i32>,
}

pub(crate) const ALLOWED: &[&str] = &[
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
    sup: State<'_, crate::supervisor::Supervisor<tauri::Wry>>,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    validate_management_args(&args, cwd.as_deref())?;
    if crate::extension_lifecycle::is_extension_mutation(&args) {
        return crate::extension_lifecycle::start_extension_mutation(app, &sup, args, cwd).await;
    }
    pi_cli_run_impl(app, args, cwd).await
}

/// Probe a custom endpoint (проверка «жив ли» remote/локальный LLM-сервер).
/// Uses system curl to avoid pulling an HTTP+TLS stack into the binary.
fn validate_probe_url(url: &str) -> Result<(), String> {
    if url.is_empty() || url.len() > 2_048 || url.chars().any(char::is_whitespace) {
        return Err("Некорректный URL (пустой, слишком длинный или содержит пробелы)".into());
    }
    let (scheme, rest) = url
        .split_once("://")
        .ok_or("URL должен начинаться с http:// или https://")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err("URL должен начинаться с http:// или https://".into());
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() {
        return Err("URL должен содержать имя хоста".into());
    }
    if authority.contains('@') {
        return Err("URL с логином или паролем не поддерживается".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn probe_url(url: String) -> Result<String, String> {
    validate_probe_url(&url)?;
    let out = Command::new("/usr/bin/curl")
        .args([
            "-s",
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            "--max-time",
            "6",
            "--",
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

pub(crate) fn validate_management_args(args: &[String], cwd: Option<&str>) -> Result<(), String> {
    if args.is_empty() || !ALLOWED.contains(&args[0].as_str()) {
        return Err("subcommand not allowed".into());
    }
    if let Some(cwd) = cwd {
        if !std::path::Path::new(cwd).is_dir() {
            return Err("workspace для локальной установки не существует".into());
        }
    }
    Ok(())
}

pub(crate) fn next_run_id() -> String {
    format!("run-{}", RUN_COUNTER.fetch_add(1, Ordering::Relaxed))
}

pub(crate) fn emit_cli_line<R: Runtime>(
    app: &AppHandle<R>,
    run_id: &str,
    stream: &str,
    line: impl Into<String>,
) {
    let _ = app.emit(
        "pi-cli-output",
        PiCliOutput {
            run_id: run_id.to_string(),
            stream: Some(stream.to_string()),
            line: Some(line.into()),
            done: false,
            code: None,
        },
    );
}

pub(crate) fn emit_cli_done<R: Runtime>(app: &AppHandle<R>, run_id: &str, code: i32) {
    let _ = app.emit(
        "pi-cli-output",
        PiCliOutput {
            run_id: run_id.to_string(),
            stream: None,
            line: None,
            done: true,
            code: Some(code),
        },
    );
}

pub(crate) async fn run_pi_process<R: Runtime>(
    app: AppHandle<R>,
    run_id: String,
    args: Vec<String>,
    cwd: Option<String>,
    extra_env: Vec<(String, String)>,
) -> Result<i32, String> {
    validate_management_args(&args, cwd.as_deref())?;
    let pi = find_pi_binary().ok_or("pi binary not found")?;
    let mut cmd = Command::new(&pi);
    cmd.args(&args)
        .env("NO_COLOR", "1")
        .env("PATH", child_path())
        .envs(extra_env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
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
    let mut readers = Vec::new();
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
        if let Some(reader) = reader {
            let app = app.clone();
            let run_id = run_id.clone();
            let stream_name = stream_name.to_string();
            readers.push(tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(reader).lines();
                while let Ok(Some(mut line)) = lines.next_line().await {
                    crate::text::truncate_bytes(&mut line, 4000);
                    emit_cli_line(&app, &run_id, &stream_name, line);
                }
            }));
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|error| format!("pi management command failed: {error}"));
    if let Some(pid) = child_pid {
        if let Ok(mut groups) = RUNNING_GROUPS.lock() {
            groups.remove(&pid);
        }
    }
    for reader in readers {
        let _ = reader.await;
    }
    status.map(|value| value.code().unwrap_or(1))
}

pub async fn pi_cli_run_impl<R: Runtime>(
    app: AppHandle<R>,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    validate_management_args(&args, cwd.as_deref())?;
    let run_id = next_run_id();
    let task_run_id = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let code =
            match run_pi_process(app.clone(), task_run_id.clone(), args, cwd, Vec::new()).await {
                Ok(code) => code,
                Err(error) => {
                    emit_cli_line(&app, &task_run_id, "err", error);
                    1
                }
            };
        emit_cli_done(&app, &task_run_id, code);
    });

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

    #[test]
    fn validates_probe_urls_before_passing_them_to_curl() {
        assert!(validate_probe_url("http://127.0.0.1:8080/health").is_ok());
        assert!(validate_probe_url("HTTPS://example.com/models?q=1").is_ok());
        assert!(validate_probe_url("file:///etc/passwd").is_err());
        assert!(validate_probe_url("http:///missing-host").is_err());
        assert!(validate_probe_url("http://user:secret@example.com").is_err());
        assert!(validate_probe_url("http://example.com\n--output=/tmp/x").is_err());
        assert!(validate_probe_url(&format!("https://{}", "a".repeat(2_100))).is_err());
    }
}
