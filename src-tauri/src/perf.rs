use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadyMarker {
    pid: u32,
    ready_unix_ms: u128,
}

/// Perf-smoke handshake. In normal runs this is a no-op: the destination is
/// supplied only by the benchmark launcher, never by WebView input.
#[tauri::command]
pub fn perf_ready() -> Result<(), String> {
    let Ok(path) = std::env::var("PI_APP_PERF_READY_FILE") else {
        return Ok(());
    };
    let ready_unix_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let payload = ReadyMarker {
        pid: std::process::id(),
        ready_unix_ms,
    };
    let json = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::ReadyMarker;

    #[test]
    fn ready_marker_uses_frontend_contract_names() {
        let json = serde_json::to_value(ReadyMarker {
            pid: 7,
            ready_unix_ms: 9,
        })
        .unwrap();
        assert_eq!(json["pid"], 7);
        assert_eq!(json["readyUnixMs"], 9);
    }
}
