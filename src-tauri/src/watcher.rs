use notify::{RecursiveMode, Watcher};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Runtime};

/// Watch ~/.pi/agent/sessions recursively and notify the WebView (debounced)
/// whenever session files change — new sessions, appended messages, renames,
/// deletions, including ones made by pi TUI outside the app.
pub fn start_sessions_watcher<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        let root = crate::sessions::sessions_root();
        let _ = std::fs::create_dir_all(&root);

        let (tx, rx) = mpsc::channel::<()>();
        let mut watcher = match notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            if let Ok(ev) = res {
                // session files are *.jsonl; extension-less paths are (new) project dirs
                let relevant = ev.paths.iter().any(|p| {
                    p.extension().map(|e| e == "jsonl").unwrap_or(true)
                });
                if relevant {
                    let _ = tx.send(());
                }
            }
        }) {
            Ok(w) => w,
            Err(_) => return,
        };
        if watcher.watch(&root, RecursiveMode::Recursive).is_err() {
            return;
        }

        // debounce burst writes: first signal opens a 400ms window, then emit once
        while rx.recv().is_ok() {
            let deadline = Instant::now() + Duration::from_millis(400);
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                match rx.recv_timeout(left) {
                    Ok(()) => continue,
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            let _ = app.emit("sessions-changed", serde_json::json!({}));
        }
    });
}

/// Watch pi agent config files (settings.json, models.json, mcp.json) and
/// notify the WebView (debounced) when they change outside the app — правки
/// из TUI/редактора должны подхватываться без перезапуска (§5.12-5).
pub fn start_config_watcher<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        let dir = crate::sessions::agent_dir();
        let (tx, rx) = mpsc::channel::<String>();
        let mut watcher = match notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            if let Ok(ev) = res {
                for p in &ev.paths {
                    if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                        if matches!(name, "settings.json" | "models.json" | "mcp.json") {
                            let _ = tx.send(name.to_string());
                        }
                    }
                }
            }
        }) {
            Ok(w) => w,
            Err(_) => return,
        };
        if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
            return;
        }

        while let Ok(first) = rx.recv() {
            let mut names = std::collections::HashSet::new();
            names.insert(first);
            let deadline = Instant::now() + Duration::from_millis(500);
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                match rx.recv_timeout(left) {
                    Ok(n) => {
                        names.insert(n);
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            let list: Vec<String> = names.into_iter().collect();
            let _ = app.emit("config-changed", serde_json::json!({ "files": list }));
        }
    });
}
