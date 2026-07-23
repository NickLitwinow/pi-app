const ICON_SVG_TEMPLATE: &str = include_str!("../../src/assets/app-icons/pi-minimal.svg");
static ICON_UPDATE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[cfg(target_os = "macos")]
const BUNDLE_ICON_SCHEMA: &str = "pi-minimal-v2";

fn normalize_background(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.len() == 7
        && value.starts_with('#')
        && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
    {
        Ok(value.to_ascii_uppercase())
    } else {
        Err("фон иконки должен быть цветом в формате #RRGGBB".into())
    }
}

fn foreground_for(background: &str) -> &'static str {
    let channel = |offset: usize| {
        let value =
            u8::from_str_radix(&background[offset..offset + 2], 16).unwrap_or(0) as f64 / 255.0;
        if value <= 0.04045 {
            value / 12.92
        } else {
            ((value + 0.055) / 1.055).powf(2.4)
        }
    };
    let luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
    if luminance > 0.48 {
        "#17191F"
    } else {
        "#FFFFFF"
    }
}

fn icon_svg(background: &str) -> Result<Vec<u8>, String> {
    let background = normalize_background(background)?;
    Ok(ICON_SVG_TEMPLATE
        .replacen("fill=\"#171A24\"", &format!("fill=\"{background}\""), 1)
        .replacen(
            "<g fill=\"#FFF\">",
            &format!("<g fill=\"{}\">", foreground_for(&background)),
            1,
        )
        .into_bytes())
}

#[cfg(target_os = "macos")]
const ICONSET_FILES: &[(&str, u32)] = &[
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
];

#[cfg(target_os = "macos")]
fn run_icon_command(command: &mut std::process::Command, label: &str) -> Result<(), String> {
    let output = command
        .output()
        .map_err(|error| format!("{label}: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    Err(format!(
        "{label} завершился с {}: {}{}",
        output.status,
        stdout.trim(),
        stderr.trim()
    ))
}

#[cfg(target_os = "macos")]
fn render_icns(
    svg: &[u8],
    work_dir: &std::path::Path,
    output_path: &std::path::Path,
) -> Result<(), String> {
    let svg_path = work_dir.join("icon.svg");
    let source_png = work_dir.join("icon-1024.png");
    let iconset = work_dir.join("Pi.iconset");
    std::fs::create_dir_all(&iconset).map_err(|error| error.to_string())?;
    std::fs::write(&svg_path, svg).map_err(|error| error.to_string())?;
    run_icon_command(
        std::process::Command::new("/usr/bin/sips")
            .args(["-s", "format", "png"])
            .arg(&svg_path)
            .arg("--out")
            .arg(&source_png),
        "не удалось растрировать SVG иконки",
    )?;
    for (name, size) in ICONSET_FILES {
        run_icon_command(
            std::process::Command::new("/usr/bin/sips")
                .args(["-z", &size.to_string(), &size.to_string()])
                .arg(&source_png)
                .arg("--out")
                .arg(iconset.join(name)),
            &format!("не удалось создать {name}"),
        )?;
    }
    run_icon_command(
        std::process::Command::new("/usr/bin/iconutil")
            .args(["-c", "icns"])
            .arg(&iconset)
            .arg("-o")
            .arg(output_path),
        "не удалось собрать icon.icns",
    )?;
    let bytes = std::fs::read(output_path).map_err(|error| error.to_string())?;
    if bytes.len() < 8 || &bytes[..4] != b"icns" {
        return Err("iconutil создал некорректный ICNS".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn icon_fingerprint(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016X}")
}

#[cfg(target_os = "macos")]
fn persist_bundle_icon(
    bundle_path: &std::path::Path,
    svg: &[u8],
    background: &str,
) -> Result<(), String> {
    let resources = bundle_path.join("Contents").join("Resources");
    let target = resources.join("icon.icns");
    let marker = resources.join(".pi-icon-state");
    let marker_prefix = format!("{BUNDLE_ICON_SCHEMA} {background} ");
    if let (Ok(icon), Ok(state)) = (std::fs::read(&target), std::fs::read_to_string(&marker)) {
        let fingerprint = icon_fingerprint(&icon);
        if state.trim_end().strip_prefix(&marker_prefix) == Some(fingerprint.as_str()) {
            return Ok(());
        }
    }
    if !resources.is_dir() {
        return Err(format!(
            "ресурсы bundle не найдены: {}",
            resources.display()
        ));
    }

    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let work_dir = std::env::temp_dir().join(format!("pi-app-icon-{}-{nonce}", std::process::id()));
    std::fs::create_dir_all(&work_dir).map_err(|error| error.to_string())?;
    let staged_icon = resources.join(format!(".icon.icns.{}-{nonce}.tmp", std::process::id()));
    let staged_marker =
        resources.join(format!(".pi-icon-state.{}-{nonce}.tmp", std::process::id()));
    let result: Result<(), String> = (|| {
        let generated = work_dir.join("icon.icns");
        render_icns(svg, &work_dir, &generated)?;
        let generated_bytes = std::fs::read(&generated).map_err(|error| error.to_string())?;
        let expected_marker = format!("{marker_prefix}{}\n", icon_fingerprint(&generated_bytes));
        std::fs::copy(&generated, &staged_icon).map_err(|error| {
            format!(
                "не удалось подготовить постоянную иконку {}: {error}",
                staged_icon.display()
            )
        })?;
        std::fs::write(&staged_marker, &expected_marker).map_err(|error| {
            format!(
                "не удалось подготовить состояние иконки {}: {error}",
                staged_marker.display()
            )
        })?;
        std::fs::rename(&staged_icon, &target).map_err(|error| {
            format!(
                "не удалось заменить bundle-иконку {}: {error}",
                target.display()
            )
        })?;
        std::fs::rename(&staged_marker, &marker).map_err(|error| {
            format!(
                "не удалось сохранить состояние bundle-иконки {}: {error}",
                marker.display()
            )
        })?;
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&work_dir);
    if result.is_err() {
        let _ = std::fs::remove_file(&staged_icon);
        let _ = std::fs::remove_file(&staged_marker);
    }
    result?;

    // A pinned Dock tile resolves its idle image through LaunchServices and
    // CFBundleIconFile, not through NSApplication's running-process image.
    // Refresh both the bundle mtime and LaunchServices after the atomic swap.
    let _ = std::process::Command::new("/usr/bin/touch")
        .arg(bundle_path)
        .status();
    let lsregister = std::path::Path::new(
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    );
    if lsregister.is_file() {
        let _ = std::process::Command::new(lsregister)
            .args(["-f", "-r"])
            .arg(bundle_path)
            .status();
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn current_app_bundle() -> Option<std::path::PathBuf> {
    std::env::current_exe().ok()?.ancestors().find_map(|path| {
        (path.extension().and_then(|value| value.to_str()) == Some("app"))
            .then(|| path.to_path_buf())
    })
}

#[cfg(target_os = "macos")]
fn apply_macos_icon(bytes: &[u8], bundle_path: Option<&std::path::Path>) -> Result<(), String> {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage, NSWorkspace, NSWorkspaceIconCreationOptions};
    use objc2_foundation::{NSData, NSString};

    let marker = MainThreadMarker::new()
        .ok_or_else(|| "смена Dock-иконки должна выполняться в main thread".to_string())?;
    let app = NSApplication::sharedApplication(marker);
    let data = NSData::with_bytes(bytes);
    let image = NSImage::initWithData(NSImage::alloc(), &data)
        .ok_or_else(|| "macOS не смогла декодировать SVG иконки".to_string())?;
    unsafe { app.setApplicationIconImage(Some(&image)) };

    // NSApplication only changes the running process. Finder metadata is kept
    // as a second persistence path; persist_bundle_icon updates CFBundleIconFile
    // separately because pinned Dock tiles use that resource after process exit.
    if let Some(bundle_path) = bundle_path {
        let path = NSString::from_str(&bundle_path.to_string_lossy());
        let workspace = NSWorkspace::sharedWorkspace();
        let persisted = workspace.setIcon_forFile_options(
            Some(&image),
            &path,
            NSWorkspaceIconCreationOptions::empty(),
        );
        if !persisted {
            return Err(format!(
                "иконка применена к запущенному приложению, но macOS не смогла сохранить её для {} — bundle должен быть доступен для записи",
                bundle_path.display()
            ));
        }
        workspace.noteFileSystemChanged_(&path);
    }
    Ok(())
}

/// Rebuilds the minimalist Dock icon with a user-selected background. The
/// running app and its writable .app bundle both receive the generated image.
#[tauri::command]
pub async fn set_app_icon(app: tauri::AppHandle, background: String) -> Result<(), String> {
    let background = normalize_background(&background)?;
    let bytes = icon_svg(&background)?;
    // Tauri commands may overlap when a user changes colors quickly. Keep the
    // complete persistence + runtime update FIFO so the latest invocation wins.
    let _update_guard = ICON_UPDATE_LOCK.lock().await;

    #[cfg(target_os = "macos")]
    {
        let bundle_path = current_app_bundle();
        let persistence = if let Some(path) = bundle_path.clone() {
            let persistent_bytes = bytes.clone();
            let persistent_background = background.clone();
            tokio::task::spawn_blocking(move || {
                persist_bundle_icon(&path, &persistent_bytes, &persistent_background)
            })
            .await
            .map_err(|error| {
                format!("задача сохранения bundle-иконки завершилась аварийно: {error}")
            })?
        } else {
            Ok(())
        };
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(apply_macos_icon(&bytes, bundle_path.as_deref()));
        })
        .map_err(|error| error.to_string())?;
        receiver
            .await
            .map_err(|_| "main thread завершился до смены Dock-иконки".to_string())??;
        persistence
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = bytes;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_arbitrary_safe_backgrounds() {
        let dark = String::from_utf8(icon_svg("#171A24").unwrap()).unwrap();
        let custom = String::from_utf8(icon_svg("#4a62ff").unwrap()).unwrap();
        assert!(dark.contains("fill=\"#171A24\""));
        assert!(dark.contains("fill=\"#FFFFFF\""));
        assert!(custom.contains("fill=\"#4A62FF\""));
        assert_ne!(dark, custom);
    }

    #[test]
    fn uses_dark_glyph_on_light_background_and_rejects_injection() {
        let light = String::from_utf8(icon_svg("#F3F1EA").unwrap()).unwrap();
        assert!(light.contains("fill=\"#17191F\""));
        assert!(icon_svg("red").is_err());
        assert!(icon_svg("#fff\"/><script>").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn builds_complete_persistent_macos_icon() {
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("custom.icns");
        render_icns(&icon_svg("#2563D9").unwrap(), temp.path(), &output).unwrap();
        let bytes = std::fs::read(output).unwrap();
        assert_eq!(&bytes[..4], b"icns");
        assert!(bytes.len() > 32_000);
        assert_eq!(ICONSET_FILES.len(), 10);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn replaces_bundle_icon_and_records_exact_background() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = temp.path().join("Pi.app");
        let resources = bundle.join("Contents").join("Resources");
        std::fs::create_dir_all(&resources).unwrap();
        std::fs::write(resources.join("icon.icns"), b"old").unwrap();

        persist_bundle_icon(&bundle, &icon_svg("#4A62FF").unwrap(), "#4A62FF").unwrap();

        let icon = std::fs::read(resources.join("icon.icns")).unwrap();
        assert_eq!(&icon[..4], b"icns");
        assert!(icon.len() > 32_000);
        assert_eq!(
            std::fs::read_to_string(resources.join(".pi-icon-state")).unwrap(),
            format!("pi-minimal-v2 #4A62FF {}\n", icon_fingerprint(&icon))
        );

        // An app updater may replace icon.icns while leaving app data in place.
        // A stale marker must not suppress restoration of the selected color.
        std::fs::write(resources.join("icon.icns"), b"overwritten").unwrap();
        persist_bundle_icon(&bundle, &icon_svg("#4A62FF").unwrap(), "#4A62FF").unwrap();
        assert_eq!(std::fs::read(resources.join("icon.icns")).unwrap(), icon);
    }
}
