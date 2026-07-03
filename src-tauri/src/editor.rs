use std::process::{Command, Stdio};

fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

pub fn shell_escape_pub(s: &str) -> String {
    shell_escape(s)
}

/// Read a file as base64 with a guessed mime type (image attachments).
#[tauri::command]
pub fn read_file_base64(path: String) -> Result<serde_json::Value, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 10_000_000 {
        return Err("файл больше 10 МБ".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let ext = std::path::Path::new(&path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    };
    Ok(serde_json::json!({ "data": base64_encode(&bytes), "mimeType": mime }))
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(CHARS[(n >> 18) as usize & 63] as char);
        out.push(CHARS[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { CHARS[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { CHARS[n as usize & 63] as char } else { '=' });
    }
    out
}

fn spawn_shell(cmd: String) -> Result<(), String> {
    Command::new("/bin/zsh")
        .args(["-lc", &cmd])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Валидация внешних ссылок: только web/mailto — никаких file:/javascript:
/// и прочих схем, способных навредить.
fn is_safe_external_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:"))
        && !lower.contains('\n')
        && !lower.contains('\r')
}

/// Open a URL in the system default browser (ссылки из чата/настроек не должны
/// перекрывать webview самого приложения).
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !is_safe_external_url(&url) {
        return Err(format!("недопустимый URL: {url}"));
    }
    Command::new("/usr/bin/open")
        .arg(&url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Open a file (optionally at a line) in the configured external editor.
#[tauri::command]
pub fn open_in_editor(editor: String, path: String, line: Option<u32>) -> Result<(), String> {
    let ln = line.unwrap_or(1);
    let p = shell_escape(&path);
    let cmd = match editor.as_str() {
        "code" | "cursor" | "windsurf" => format!("{editor} --goto {p}:{ln}"),
        "zed" => format!("zed {p}:{ln}"),
        "subl" => format!("subl {p}:{ln}"),
        "idea" => format!("idea --line {ln} {p}"),
        _ => format!("open {p}"),
    };
    spawn_shell(cmd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_shell_args() {
        assert_eq!(shell_escape("simple"), "'simple'");
        assert_eq!(shell_escape("it's"), r"'it'\''s'");
        assert_eq!(shell_escape("path with spaces/f.txt"), "'path with spaces/f.txt'");
    }

    #[test]
    fn validates_external_urls() {
        assert!(is_safe_external_url("https://pi.dev/docs"));
        assert!(is_safe_external_url("http://localhost:8099/v1"));
        assert!(is_safe_external_url("mailto:dev@example.com"));
        assert!(is_safe_external_url("  HTTPS://Example.com  "));
        assert!(!is_safe_external_url("file:///etc/passwd"));
        assert!(!is_safe_external_url("javascript:alert(1)"));
        assert!(!is_safe_external_url("ftp://host/x"));
        assert!(!is_safe_external_url("https://x.com\nrm -rf /"));
        assert!(!is_safe_external_url(""));
    }
}
