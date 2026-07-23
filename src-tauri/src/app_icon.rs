const ICON_SVG_TEMPLATE: &str = include_str!("../../src/assets/app-icons/pi-minimal.svg");

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

    // NSApplication only changes the running process. Assign a Finder custom
    // icon to the writable .app bundle as well so Dock keeps the selected
    // background after the process exits. Signed Contents/Resources remain
    // untouched; macOS stores this as file metadata on the bundle.
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
    let bytes = icon_svg(&background)?;

    #[cfg(target_os = "macos")]
    {
        let bundle_path = current_app_bundle();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(apply_macos_icon(&bytes, bundle_path.as_deref()));
        })
        .map_err(|error| error.to_string())?;
        receiver
            .await
            .map_err(|_| "main thread завершился до смены Dock-иконки".to_string())?
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
}
