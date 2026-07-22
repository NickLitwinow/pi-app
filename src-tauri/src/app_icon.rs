const LIQUID_GLASS: &[u8] = include_bytes!("../../src/assets/app-icons/pi-liquid-glass.png");
const AURORA: &[u8] = include_bytes!("../../src/assets/app-icons/pi-aurora.png");
const GRAPHITE: &[u8] = include_bytes!("../../src/assets/app-icons/pi-graphite.png");

fn icon_bytes(style: &str) -> Result<&'static [u8], String> {
    match style {
        "liquid-glass" => Ok(LIQUID_GLASS),
        "aurora" => Ok(AURORA),
        "graphite" => Ok(GRAPHITE),
        _ => Err(format!("неизвестный стиль иконки: {style}")),
    }
}

#[cfg(target_os = "macos")]
fn apply_macos_icon(bytes: &'static [u8]) -> Result<(), String> {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let marker = MainThreadMarker::new()
        .ok_or_else(|| "смена Dock-иконки должна выполняться в main thread".to_string())?;
    let app = NSApplication::sharedApplication(marker);
    let data = NSData::with_bytes(bytes);
    let image = NSImage::initWithData(NSImage::alloc(), &data)
        .ok_or_else(|| "macOS не смогла декодировать PNG иконки".to_string())?;
    unsafe { app.setApplicationIconImage(Some(&image)) };
    Ok(())
}

/// Applies an alternate Dock icon immediately on macOS. The persisted config
/// invokes this again at startup, while the bundle default stays Liquid Glass.
#[tauri::command]
pub async fn set_app_icon(app: tauri::AppHandle, style: String) -> Result<(), String> {
    let bytes = icon_bytes(&style)?;

    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(apply_macos_icon(bytes));
        })
        .map_err(|error| error.to_string())?;
        return receiver
            .await
            .map_err(|_| "main thread завершился до смены Dock-иконки".to_string())?;
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
    fn embeds_every_supported_icon_style() {
        let styles = ["liquid-glass", "aurora", "graphite"];
        for style in styles {
            let bytes = icon_bytes(style).unwrap();
            assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
            assert!(bytes.len() > 100_000);
        }
        assert_ne!(
            icon_bytes(styles[0]).unwrap(),
            icon_bytes(styles[1]).unwrap()
        );
        assert_ne!(
            icon_bytes(styles[1]).unwrap(),
            icon_bytes(styles[2]).unwrap()
        );
        assert!(icon_bytes("unknown").is_err());
    }
}
