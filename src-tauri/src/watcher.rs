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
