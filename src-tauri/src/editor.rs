use std::process::{Command, Stdio};

fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

pub fn shell_escape_pub(s: &str) -> String {
    shell_escape(s)
}

const MAX_IMAGE_ATTACHMENT_BYTES: u64 = 10_000_000;

fn detected_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// Read a supported image as base64. MIME is detected from the bytes instead
/// of trusting the extension, so renamed HTML/SVG/arbitrary files cannot enter
/// the provider payload or the WebView preview as a spoofed PNG/JPEG.
#[tauri::command]
pub fn read_file_base64(path: String) -> Result<serde_json::Value, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("путь не является файлом".into());
    }
    if meta.len() == 0 {
        return Err("файл пуст".into());
    }
    if meta.len() > MAX_IMAGE_ATTACHMENT_BYTES {
        return Err("файл больше 10 МБ".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    // Recheck after reading: the file may have changed between metadata() and
    // read(), and that race must not bypass the provider payload limit.
    if bytes.len() as u64 > MAX_IMAGE_ATTACHMENT_BYTES {
        return Err("файл больше 10 МБ".into());
    }
    let mime = detected_image_mime(&bytes)
        .ok_or_else(|| "поддерживаются только PNG, JPEG, GIF и WebP".to_string())?;
    Ok(serde_json::json!({
        "data": base64_encode(&bytes),
        "mimeType": mime,
        "sizeBytes": bytes.len(),
    }))
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(CHARS[(n >> 18) as usize & 63] as char);
        out.push(CHARS[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            CHARS[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            CHARS[n as usize & 63] as char
        } else {
            '='
        });
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

/// Reveal a folder/file in Finder (кнопка «Открыть в Finder» у проектов).
#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    Command::new("/usr/bin/open")
        .arg("-R")
        .arg(&path)
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
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_image_path(extension: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "pi-app-editor-{}-{nonce}.{extension}",
            std::process::id()
        ))
    }

    #[test]
    fn escapes_shell_args() {
        assert_eq!(shell_escape("simple"), "'simple'");
        assert_eq!(shell_escape("it's"), r"'it'\''s'");
        assert_eq!(
            shell_escape("path with spaces/f.txt"),
            "'path with spaces/f.txt'"
        );
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

    #[test]
    fn detects_supported_image_mime_from_bytes() {
        assert_eq!(
            detected_image_mime(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
            Some("image/png")
        );
        assert_eq!(
            detected_image_mime(&[0xff, 0xd8, 0xff, 0x00]),
            Some("image/jpeg")
        );
        assert_eq!(detected_image_mime(b"GIF89a..."), Some("image/gif"));
        assert_eq!(detected_image_mime(b"RIFF0000WEBP"), Some("image/webp"));
        assert_eq!(detected_image_mime(b"<svg></svg>"), None);
    }

    #[test]
    fn attachment_reader_rejects_spoofed_extension() {
        let path = temp_image_path("png");
        std::fs::write(&path, b"<html>not an image</html>").expect("fixture");
        let error = read_file_base64(path.to_string_lossy().into_owned()).expect_err("must reject");
        let _ = std::fs::remove_file(path);
        assert!(error.contains("PNG, JPEG, GIF"));
    }

    #[test]
    fn attachment_reader_reports_detected_mime_size_and_base64() {
        let path = temp_image_path("jpg");
        let png_header = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        std::fs::write(&path, png_header).expect("fixture");
        let value = read_file_base64(path.to_string_lossy().into_owned()).expect("read");
        let _ = std::fs::remove_file(path);
        assert_eq!(value["mimeType"], "image/png");
        assert_eq!(value["sizeBytes"], 8);
        assert_eq!(value["data"], "iVBORw0KGgo=");
    }

    #[test]
    fn attachment_reader_rejects_sparse_file_over_limit_before_reading() {
        let path = temp_image_path("png");
        let file = std::fs::File::create(&path).expect("fixture");
        file.set_len(MAX_IMAGE_ATTACHMENT_BYTES + 1)
            .expect("sparse fixture");
        let error = read_file_base64(path.to_string_lossy().into_owned()).expect_err("must reject");
        let _ = std::fs::remove_file(path);
        assert!(error.contains("10 МБ"));
    }
}
