use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::{fs, path::PathBuf};

const MAX_AVATAR_BYTES: u64 = 12 * 1024 * 1024;

#[tauri::command]
pub fn read_avatar_data(path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    let metadata = fs::metadata(&path).map_err(|error| format!("avatar недоступен: {error}"))?;
    if !metadata.is_file() {
        return Err("avatar должен быть файлом".into());
    }
    if metadata.len() > MAX_AVATAR_BYTES {
        return Err("avatar больше 12 МБ".into());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    // Animated SVG (SMIL/CSS) проигрывается прямо в <img>; Lottie (.json) отдаётся
    // как application/json — фронтенд поднимает lottie-плеер только для него.
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "json" => "application/json",
        _ => return Err("поддерживаются PNG, JPEG, GIF, WebP, анимированный SVG и Lottie (JSON)".into()),
    };
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_supported_image_without_copying_it() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("agent.gif");
        fs::write(&path, b"GIF89a").unwrap();
        let data = read_avatar_data(path.to_string_lossy().into_owned()).unwrap();
        assert!(data.starts_with("data:image/gif;base64,"));
        assert!(path.exists());
    }

    #[test]
    fn reads_animated_svg_as_inline_image() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("avatar.svg");
        fs::write(&path, b"<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap();
        let data = read_avatar_data(path.to_string_lossy().into_owned()).unwrap();
        assert!(data.starts_with("data:image/svg+xml;base64,"));
    }

    #[test]
    fn reads_lottie_json_with_dedicated_mime() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("avatar.json");
        fs::write(&path, br#"{"v":"5.7.4","layers":[]}"#).unwrap();
        let data = read_avatar_data(path.to_string_lossy().into_owned()).unwrap();
        assert!(data.starts_with("data:application/json;base64,"));
    }

    #[test]
    fn rejects_unsupported_files() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("avatar.txt");
        fs::write(&path, b"nope").unwrap();
        assert!(read_avatar_data(path.to_string_lossy().into_owned()).is_err());
    }
}
