use std::process::Command;

fn main() {
    // Встраиваем git-коммит и ветку сборки, чтобы приложение могло сравнить
    // себя с последней версией в удалённом репозитории (self-update).
    let sha = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=PI_APP_GIT_SHA={sha}");

    // Пересобираемся, если сменился HEAD (обновляем встроенный sha).
    if let Ok(git_dir) = std::fs::read_to_string("../.git/HEAD") {
        let head = git_dir.trim();
        if let Some(rf) = head.strip_prefix("ref: ") {
            println!("cargo:rerun-if-changed=../.git/{rf}");
        }
    }
    println!("cargo:rerun-if-changed=../.git/HEAD");

    tauri_build::build()
}
