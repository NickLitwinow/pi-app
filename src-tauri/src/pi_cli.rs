use serde::Serialize;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::supervisor::{child_path, find_pi_binary};

static RUN_COUNTER: AtomicU64 = AtomicU64::new(1);

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

const ALLOWED: &[&str] = &["install", "remove", "uninstall", "update", "list", "--version", "--list-models"];

/// Run a pi management subcommand (install/remove/update/list), streaming
/// output lines to the WebView as `pi-cli-output` events. Returns a run id.
#[tauri::command]
pub async fn pi_cli_run(app: AppHandle, args: Vec<String>) -> Result<String, String> {
    pi_cli_run_impl(app, args).await
}

/// Probe a custom endpoint (проверка «жив ли» remote/локальный LLM-сервер).
/// Uses system curl to avoid pulling an HTTP+TLS stack into the binary.
#[tauri::command]
pub async fn probe_url(url: String) -> Result<String, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("URL должен начинаться с http:// или https://".into());
    }
    let out = Command::new("/usr/bin/curl")
        .args(["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "6", &url])
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

pub async fn pi_cli_run_impl<R: Runtime>(app: AppHandle<R>, args: Vec<String>) -> Result<String, String> {
    if args.is_empty() || !ALLOWED.contains(&args[0].as_str()) {
        return Err("subcommand not allowed".into());
    }
    let pi = find_pi_binary().ok_or("pi binary not found")?;
    let run_id = format!("run-{}", RUN_COUNTER.fetch_add(1, Ordering::Relaxed));

    let mut child = Command::new(&pi)
        .args(&args)
        .env("NO_COLOR", "1")
        .env("PATH", child_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to run pi: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    for (stream_name, reader) in [("out", stdout.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>)), ("err", stderr.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>))] {
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
            let _ = app.emit(
                "pi-cli-output",
                PiCliOutput { run_id, stream: None, line: None, done: true, code },
            );
        });
    }

    Ok(run_id)
}
