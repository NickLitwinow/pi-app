use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::sessions::agent_dir;

fn deserialize_agent_sandbox_mode<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<String>::deserialize(deserializer)?
        .filter(|value| value == "workspace-write" || value == "unrestricted")
        .unwrap_or_else(|| "workspace-write".into()))
}

const DEFAULT_APP_ICON_BACKGROUND: &str = "#171A24";

fn normalize_app_icon_background(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "auto" | "liquid-glass" => DEFAULT_APP_ICON_BACKGROUND.into(),
        "aurora" => "#4057E8".into(),
        "graphite" => "#34363D".into(),
        _ if raw.len() == 7
            && raw.starts_with('#')
            && raw.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit) =>
        {
            raw.to_ascii_uppercase()
        }
        _ => DEFAULT_APP_ICON_BACKGROUND.into(),
    }
}

fn deserialize_app_icon_background<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(normalize_app_icon_background(&String::deserialize(
        deserializer,
    )?))
}

// ---------- pi config files (settings.json / models.json / mcp.json) ----------

fn pi_config_path(name: &str) -> Result<PathBuf, String> {
    match name {
        "settings" | "models" | "mcp" => Ok(agent_dir().join(format!("{name}.json"))),
        _ => Err(format!("unknown config: {name}")),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    pub path: String,
    pub content: String,
    pub exists: bool,
}

#[tauri::command]
pub fn read_pi_config(name: String) -> Result<ConfigFile, String> {
    let path = pi_config_path(&name)?;
    let exists = path.exists();
    let content = if exists {
        fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        "{}".to_string()
    };
    Ok(ConfigFile {
        path: path.to_string_lossy().into_owned(),
        content,
        exists,
    })
}

#[tauri::command]
pub fn read_project_settings(cwd: String) -> Result<ConfigFile, String> {
    read_project_pi_config(cwd, "settings".into())
}

#[tauri::command]
pub fn read_project_pi_config(cwd: String, name: String) -> Result<ConfigFile, String> {
    if !matches!(name.as_str(), "settings" | "mcp") {
        return Err(format!("unknown project config: {name}"));
    }
    let root = PathBuf::from(cwd);
    if !root.is_dir() {
        return Err("workspace не существует".into());
    }
    let path = root.join(".pi").join(format!("{name}.json"));
    let exists = path.exists();
    let content = if exists {
        fs::read_to_string(&path).map_err(|error| error.to_string())?
    } else {
        "{}".into()
    };
    Ok(ConfigFile {
        path: path.to_string_lossy().into_owned(),
        content,
        exists,
    })
}

#[tauri::command]
pub async fn write_project_settings(cwd: String, content: String) -> Result<(), String> {
    write_project_pi_config(cwd, "settings".into(), content).await
}

#[tauri::command]
pub async fn write_project_pi_config(
    cwd: String,
    name: String,
    content: String,
) -> Result<(), String> {
    let _lifecycle_lock = crate::extension_lifecycle::acquire_lifecycle_lock().await?;
    write_project_pi_config_impl(cwd, name, content)
}

#[tauri::command]
pub async fn write_project_pi_config_if_unchanged(
    cwd: String,
    name: String,
    expected_content: String,
    content: String,
) -> Result<(), String> {
    let _lifecycle_lock = crate::extension_lifecycle::acquire_lifecycle_lock().await?;
    if !matches!(name.as_str(), "settings" | "mcp") {
        return Err(format!("unknown project config: {name}"));
    }
    let root = PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err("workspace не существует".into());
    }
    let path = root.join(".pi").join(format!("{name}.json"));
    ensure_config_unchanged(&path, &expected_content)?;
    write_project_pi_config_impl(cwd, name, content)
}

fn write_project_pi_config_impl(cwd: String, name: String, content: String) -> Result<(), String> {
    if !matches!(name.as_str(), "settings" | "mcp") {
        return Err(format!("unknown project config: {name}"));
    }
    let root = PathBuf::from(cwd);
    if !root.is_dir() {
        return Err("workspace не существует".into());
    }
    let path = root.join(".pi").join(format!("{name}.json"));
    validate_config_object(&name, &content)?;
    if name == "settings" {
        reject_unmanaged_package_change(&path, &content)?;
    }
    write_json_atomic(&path, &content)
}

/// Validate JSON, back up the previous version, then write atomically (tmp + rename).
pub fn write_json_atomic(path: &Path, content: &str) -> Result<(), String> {
    static WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
    serde_json::from_str::<Value>(content).map_err(|e| format!("невалидный JSON: {e}"))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        if path.exists() {
            let backup = path.with_extension("json.pi-app.bak");
            fs::copy(path, &backup).map_err(|e| format!("backup failed: {e}"))?;
        }
        let tmp = parent.join(format!(
            ".{}.tmp-{}-{}",
            path.file_name().unwrap_or_default().to_string_lossy(),
            std::process::id(),
            WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed),
        ));
        fs::write(&tmp, content).map_err(|e| e.to_string())?;
        if let Err(error) = fs::rename(&tmp, path) {
            let _ = fs::remove_file(&tmp);
            return Err(error.to_string());
        }
        Ok(())
    } else {
        Err("invalid path".into())
    }
}

#[tauri::command]
pub async fn write_pi_config(name: String, content: String) -> Result<(), String> {
    let _lifecycle_lock = crate::extension_lifecycle::acquire_lifecycle_lock().await?;
    let path = pi_config_path(&name)?;
    validate_config_object(&name, &content)?;
    if name == "settings" {
        reject_unmanaged_package_change(&path, &content)?;
    }
    write_json_atomic(&path, &content)
}

#[tauri::command]
pub async fn write_pi_config_if_unchanged(
    name: String,
    expected_content: String,
    content: String,
) -> Result<(), String> {
    let _lifecycle_lock = crate::extension_lifecycle::acquire_lifecycle_lock().await?;
    let path = pi_config_path(&name)?;
    ensure_config_unchanged(&path, &expected_content)?;
    validate_config_object(&name, &content)?;
    if name == "settings" {
        reject_unmanaged_package_change(&path, &content)?;
    }
    write_json_atomic(&path, &content)
}

fn ensure_config_unchanged(path: &Path, expected_content: &str) -> Result<(), String> {
    let current = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => "{}".into(),
        Err(error) => return Err(error.to_string()),
    };
    if current != expected_content {
        return Err(
            "CONFIG_CONFLICT: файл изменился после чтения; перечитайте его и повторите действие"
                .into(),
        );
    }
    Ok(())
}

fn validate_config_object(name: &str, content: &str) -> Result<(), String> {
    let value: Value =
        serde_json::from_str(content).map_err(|error| format!("невалидный JSON: {error}"))?;
    if !value.is_object() {
        return Err(format!("{name}.json: корень должен быть объектом"));
    }
    Ok(())
}

fn reject_unmanaged_package_change(path: &Path, content: &str) -> Result<(), String> {
    let next: Value =
        serde_json::from_str(content).map_err(|error| format!("невалидный JSON: {error}"))?;
    let current: Value = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if current.get("packages") != next.get("packages") {
        return Err(
            "Список packages управляется транзакционно через Library; используйте установку, удаление или переключатель ресурса там"
                .into(),
        );
    }
    Ok(())
}

// ---------- app's own config ----------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub editor: String,
    pub process_limit: u32,
    /// При локальном endpoint ограничивать параллелизм одним агентом.
    pub process_limit_auto: bool,
    /// Filesystem write boundary for newly spawned agents. On macOS,
    /// "workspace-write" is enforced by sandbox-exec for the whole process
    /// tree; "unrestricted" preserves the legacy behavior.
    #[serde(deserialize_with = "deserialize_agent_sandbox_mode")]
    pub agent_sandbox_mode: String,
    pub idle_kill_secs: u64,
    pub preview_idle_kill_secs: u64,
    pub theme: String,
    pub ui_scale: f64,
    /// Явно заданный пользователем путь к бинарю pi (приоритетнее авто-детекта).
    pub pi_path: Option<String>,
    pub sidebar_collapsed: bool,
    pub sidebar_width: u32,
    /// Каталог исходников pi-app для локального самообновления (ребилд из исходников).
    pub source_repo_path: Option<String>,
    /// Автоматически скачать и установить готовый GitHub Release в фоне.
    pub automatic_updates: bool,
    /// Имя для приветствия на стартовом экране (как в Claude for Mac).
    pub display_name: Option<String>,
    /// Язык интерфейса. None сохраняет автоопределение по системной локали.
    pub lang: Option<String>,
    /// Таймаут «сторожа зависаний» провайдера (@narumitw/pi-retry), мс.
    /// 0 (по умолчанию) — сторож ВЫКЛЮЧЕН: локальные reasoning-модели думают
    /// непредсказуемо долго, и любой конечный таймаут рано или поздно ложно
    /// оборвёт долгое размышление. Отключение снимает только stall-abort —
    /// прочие ретраи расширения (empty-detail, websocket-limit) продолжают
    /// работать. Ненулевое значение осмысленно для облачных провайдеров.
    /// Прокидывается в pi как PI_RETRY_STALL_TIMEOUT_MS.
    pub pi_retry_stall_timeout_ms: u64,
    /// UI-only aliases: provider/model-id -> friendly display name.
    /// Never written to models.json and never sent to the provider.
    pub model_aliases: HashMap<String, String>,
    pub accent_color: String,
    pub icon_color: String,
    /// Background color of the minimalist Bundle/Dock icon.
    #[serde(
        alias = "appIconStyle",
        deserialize_with = "deserialize_app_icon_background"
    )]
    pub app_icon_background: String,
    /// UI surface preset; independent from runtime model/provider selection.
    pub appearance_preset: String,
    pub visual_effects: bool,
    pub interface_density: String,
    pub transcript_mode: String,
    /// Composer send shortcut: "enter" or "mod-enter" (Cmd/Ctrl+Enter).
    pub send_key_behavior: String,
    /// Resolved GUI palette derived from a pi theme. Kept separate from the
    /// original pi theme JSON because ANSI indexes are resolved for WebView.
    pub custom_theme: Option<HashMap<String, String>>,
    /// The Library explains package scopes and trust boundaries on first use.
    pub library_onboarding_seen: bool,
    /// Per-model visual identity keyed by provider/model-id. Image paths stay
    /// in app config and are never copied into the user's repository.
    pub model_avatars: HashMap<String, AvatarConfig>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AvatarConfig {
    pub kind: Option<String>,
    pub value: Option<String>,
    pub working_kind: Option<String>,
    pub working_value: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            editor: "code".into(),
            process_limit: 2,
            process_limit_auto: true,
            agent_sandbox_mode: "workspace-write".into(),
            idle_kill_secs: 900,
            preview_idle_kill_secs: 600,
            theme: "system".into(),
            ui_scale: 1.0,
            pi_path: None,
            sidebar_collapsed: false,
            sidebar_width: 240,
            source_repo_path: None,
            automatic_updates: true,
            display_name: None,
            lang: None,
            pi_retry_stall_timeout_ms: 0, // сторож зависаний выключен по умолчанию
            model_aliases: HashMap::new(),
            accent_color: "#8b5cf6".into(),
            icon_color: "#8b5cf6".into(),
            app_icon_background: DEFAULT_APP_ICON_BACKGROUND.into(),
            appearance_preset: "chatgpt".into(),
            visual_effects: true,
            interface_density: "comfortable".into(),
            transcript_mode: "normal".into(),
            send_key_behavior: "enter".into(),
            custom_theme: None,
            library_onboarding_seen: false,
            model_avatars: HashMap::new(),
        }
    }
}

fn normalize_hex_color(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() == 7
        && trimmed.starts_with('#')
        && trimmed.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
    {
        trimmed.to_ascii_uppercase()
    } else {
        fallback.into()
    }
}

fn normalize_app_config(mut cfg: AppConfig) -> AppConfig {
    if !matches!(
        cfg.editor.as_str(),
        "code" | "cursor" | "windsurf" | "zed" | "subl" | "idea"
    ) {
        cfg.editor = "code".into();
    }
    cfg.process_limit = cfg.process_limit.clamp(1, 8);
    cfg.idle_kill_secs = cfg.idle_kill_secs.clamp(60, 7 * 24 * 60 * 60);
    cfg.preview_idle_kill_secs = cfg.preview_idle_kill_secs.min(7 * 24 * 60 * 60);
    cfg.pi_retry_stall_timeout_ms = cfg.pi_retry_stall_timeout_ms.min(24 * 60 * 60 * 1000);
    if !matches!(cfg.theme.as_str(), "system" | "dark" | "light") {
        cfg.theme = "system".into();
    }
    if !cfg.ui_scale.is_finite() {
        cfg.ui_scale = 1.0;
    }
    cfg.ui_scale = cfg.ui_scale.clamp(0.7, 1.6);
    cfg.sidebar_width = cfg.sidebar_width.clamp(190, 400);
    cfg.accent_color = normalize_hex_color(&cfg.accent_color, "#8B5CF6");
    cfg.icon_color = normalize_hex_color(&cfg.icon_color, &cfg.accent_color);
    if !matches!(
        cfg.appearance_preset.as_str(),
        "chatgpt" | "claude" | "gemini" | "custom"
    ) {
        cfg.appearance_preset = "chatgpt".into();
    }
    if !matches!(cfg.interface_density.as_str(), "compact" | "comfortable") {
        cfg.interface_density = "comfortable".into();
    }
    if !matches!(cfg.transcript_mode.as_str(), "normal" | "compact") {
        cfg.transcript_mode = "normal".into();
    }
    if !matches!(cfg.send_key_behavior.as_str(), "enter" | "mod-enter") {
        cfg.send_key_behavior = "enter".into();
    }
    cfg
}

/// Локальный provider обычно делит один GPU/model server; два параллельных pi
/// процесса дают swap/очередь без выигрыша. Не делаем HTTP-запросов — читаем
/// только models.json.
pub fn local_provider_configured() -> bool {
    local_provider_configured_in(&agent_dir())
}

fn local_provider_configured_in(dir: &Path) -> bool {
    let Ok(text) = fs::read_to_string(dir.join("models.json")) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    let Some(providers) = value.get("providers").and_then(Value::as_object) else {
        return false;
    };
    providers.iter().any(|(name, cfg)| {
        let name = name.to_ascii_lowercase();
        let base = cfg
            .get("baseUrl")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        matches!(name.as_str(), "ollama" | "omlx" | "lmstudio" | "lm-studio")
            || base.contains("127.0.0.1")
            || base.contains("localhost")
            || base.contains("0.0.0.0")
    })
}

/// Имя пользователя ОС с заглавной буквы — дефолт для приветствия.
fn os_display_name() -> Option<String> {
    let raw = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .ok()?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let mut chars = raw.chars();
    let first = chars.next()?.to_uppercase().to_string();
    Some(first + chars.as_str())
}

fn app_config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("pi-app")
        .join("config.json")
}

pub fn load_app_config() -> AppConfig {
    let cfg: AppConfig = fs::read_to_string(app_config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let mut cfg = normalize_app_config(cfg);
    // приветствие по умолчанию — имя пользователя ОС (пока не задано вручную)
    if cfg.display_name.as_deref().unwrap_or("").trim().is_empty() {
        cfg.display_name = os_display_name();
    }
    cfg
}

#[tauri::command]
pub fn read_app_config() -> AppConfig {
    load_app_config()
}

#[tauri::command]
pub fn write_app_config(config: AppConfig) -> Result<(), String> {
    let path = app_config_path();
    let config = normalize_app_config(config);
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    write_json_atomic(&path, &content)
}

// ---------- session flags (pin/archive/groups/pinned-messages — app-side metadata) ----------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionGroup {
    pub id: String,
    pub name: String,
    pub cwd: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PinnedMessage {
    pub id: String,
    pub text: String,
    pub role: String,
    pub ts: i64,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionFlags {
    pub pinned: Vec<String>,
    pub archived: Vec<String>,
    /// Пользовательские группы (папки) сессий внутри проекта.
    pub groups: Vec<SessionGroup>,
    /// sessionPath → groupId.
    pub group_of: HashMap<String, String>,
    /// sessionPath → закреплённые сообщения (компактный виджет в чате).
    pub pinned_messages: HashMap<String, Vec<PinnedMessage>>,
    /// cwd проектов, скрытых пользователем из сайдбара (файлы сессий не трогаем).
    pub hidden_projects: Vec<String>,
}

fn bounded_string(value: String, max_chars: usize) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.chars().take(max_chars).collect())
    }
}

fn bounded_unique_strings(values: Vec<String>, limit: usize, max_chars: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter_map(|value| bounded_string(value, max_chars))
        .filter(|value| seen.insert(value.clone()))
        .take(limit)
        .collect()
}

fn normalize_session_flags(mut flags: SessionFlags) -> SessionFlags {
    flags.pinned = bounded_unique_strings(flags.pinned, 5_000, 4_096);
    flags.archived = bounded_unique_strings(flags.archived, 5_000, 4_096);
    flags.hidden_projects = bounded_unique_strings(flags.hidden_projects, 1_000, 4_096);

    let mut group_ids = HashSet::new();
    flags.groups = flags
        .groups
        .into_iter()
        .filter_map(|group| {
            let id = bounded_string(group.id, 128)?;
            let name = bounded_string(group.name, 200)?;
            let cwd = bounded_string(group.cwd, 4_096)?;
            group_ids
                .insert(id.clone())
                .then_some(SessionGroup { id, name, cwd })
        })
        .take(500)
        .collect();

    flags.group_of = flags
        .group_of
        .into_iter()
        .filter_map(|(path, group_id)| {
            let path = bounded_string(path, 4_096)?;
            let group_id = bounded_string(group_id, 128)?;
            group_ids.contains(&group_id).then_some((path, group_id))
        })
        .take(5_000)
        .collect();

    flags.pinned_messages = flags
        .pinned_messages
        .into_iter()
        .filter_map(|(path, messages)| {
            let path = bounded_string(path, 4_096)?;
            let messages: Vec<_> = messages
                .into_iter()
                .filter_map(|message| {
                    Some(PinnedMessage {
                        id: bounded_string(message.id, 256)?,
                        text: bounded_string(message.text, 20_000)?,
                        role: bounded_string(message.role, 32)?,
                        ts: message.ts.max(0),
                    })
                })
                .take(100)
                .collect();
            (!messages.is_empty()).then_some((path, messages))
        })
        .take(1_000)
        .collect();
    flags
}

fn session_flags_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("pi-app")
        .join("session-flags.json")
}

#[tauri::command]
pub fn read_session_flags() -> SessionFlags {
    fs::read_to_string(session_flags_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .map(normalize_session_flags)
        .unwrap_or_default()
}

#[tauri::command]
pub fn write_session_flags(flags: SessionFlags) -> Result<(), String> {
    let flags = normalize_session_flags(flags);
    let content = serde_json::to_string_pretty(&flags).map_err(|e| e.to_string())?;
    write_json_atomic(&session_flags_path(), &content)
}

// ---------- agent permission-mode presets (@gotgenes/pi-permission-system) ----------

const PRESET_ASK: &str = r#"{
  "yoloMode": false,
  "permission": {
    "*": "allow",
    "read": "allow",
    "write": "ask",
    "edit": "ask",
    "external_directory": "ask",
    "bash": {
      "*": "ask",
      "git status*": "allow", "git diff*": "allow", "git log*": "allow", "git show*": "allow",
      "ls*": "allow", "cat *": "allow", "head *": "allow", "tail *": "allow", "wc *": "allow",
      "rg *": "allow", "grep *": "allow", "find *": "allow", "pwd": "allow", "echo *": "allow"
    }
  }
}"#;

const PRESET_ACCEPT_EDITS: &str = r#"{
  "yoloMode": false,
  "permission": {
    "*": "allow",
    "read": "allow",
    "write": "allow",
    "edit": "allow",
    "external_directory": "ask",
    "bash": {
      "*": "ask",
      "git status*": "allow", "git diff*": "allow", "git log*": "allow", "git show*": "allow",
      "ls*": "allow", "cat *": "allow", "head *": "allow", "tail *": "allow", "wc *": "allow",
      "rg *": "allow", "grep *": "allow", "find *": "allow", "pwd": "allow", "echo *": "allow"
    }
  }
}"#;

const PRESET_AUTO: &str = r#"{
  "yoloMode": false,
  "permission": {
    "*": "allow",
    "external_directory": "ask",
    "bash": {
      "*": "allow",
      "rm -rf *": "ask", "rm -fr *": "ask", "sudo *": "ask",
      "git push*": "ask", "git reset --hard*": "ask", "git clean*": "ask",
      "*> /dev/*": "ask", "shutdown*": "deny", "reboot*": "deny"
    }
  }
}"#;

const PRESET_BYPASS: &str = r#"{
  "yoloMode": true
}"#;

const PERMISSION_EXT_ID: &str = "pi-permission-system";

/// New-style config locations used by @gotgenes/pi-permission-system ≥0.4:
/// global — ~/.pi/agent/extensions/pi-permission-system/config.json,
/// project — <cwd>/.pi/extensions/pi-permission-system/config.json.
fn project_permission_dir(cwd: &str) -> PathBuf {
    Path::new(cwd)
        .join(".pi")
        .join("extensions")
        .join(PERMISSION_EXT_ID)
}

/// Move a legacy policy file out of the extension's detection path: into the
/// new location when it's free, otherwise to a .migrated backup next to it.
fn migrate_legacy_file(legacy: &Path, new: &Path, log: &mut Vec<String>) {
    if !legacy.exists() {
        return;
    }
    if let Some(parent) = new.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if !new.exists() && fs::rename(legacy, new).is_ok() {
        log.push(format!("{} → {}", legacy.display(), new.display()));
        return;
    }
    // new config already exists — just get the legacy file out of the way
    let backup = legacy.with_extension("jsonc.migrated-by-pi-app");
    if fs::rename(legacy, &backup).is_ok() {
        log.push(format!(
            "{} → {} (новый конфиг уже существует)",
            legacy.display(),
            backup.display()
        ));
    }
}

/// Migrate legacy pi-permission-system files so the extension stops warning
/// («Legacy global/project policy found…») on every session start.
/// Safe to call repeatedly; returns a list of performed actions.
#[tauri::command]
pub fn migrate_permission_configs(cwd: Option<String>) -> Vec<String> {
    migrate_permission_configs_in(&agent_dir(), cwd)
}

pub fn migrate_permission_configs_in(agent_dir: &Path, cwd: Option<String>) -> Vec<String> {
    let mut log = Vec::new();

    // global: <agent_dir>/pi-permissions.jsonc
    migrate_legacy_file(
        &agent_dir.join("pi-permissions.jsonc"),
        &agent_dir
            .join("extensions")
            .join(PERMISSION_EXT_ID)
            .join("config.json"),
        &mut log,
    );

    if let Some(cwd) = cwd {
        migrate_project_permission_files(&cwd, &mut log);
    }
    log
}

fn migrate_project_permission_files(cwd: &str, log: &mut Vec<String>) {
    let legacy_dir = Path::new(cwd).join(".pi").join("agent");
    migrate_legacy_file(
        &legacy_dir.join("pi-permissions.jsonc"),
        &project_permission_dir(cwd).join("config.json"),
        log,
    );
    // маркер режима pi-app переезжает вместе с конфигом
    let legacy_marker = legacy_dir.join(".pi-app-permission-mode");
    if legacy_marker.exists() {
        let new_marker = project_permission_dir(cwd).join(".pi-app-mode");
        if let Some(parent) = new_marker.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if !new_marker.exists() {
            let _ = fs::rename(&legacy_marker, &new_marker);
        } else {
            let _ = fs::remove_file(&legacy_marker);
        }
    }
    // старые артефакты pi-app в legacy-каталоге больше не нужны
    for stale in [
        "pi-permissions.json.pi-app.bak",
        "pi-permissions.user-backup.jsonc",
    ] {
        let p = legacy_dir.join(stale);
        if p.exists() && fs::remove_file(&p).is_ok() {
            log.push(format!("удалён {}", p.display()));
        }
    }
}

/// Write the project-local permission preset for @gotgenes/pi-permission-system.
/// A user-authored config (no marker file) is backed up once before overwrite.
/// Возвращает необязательное сообщение пользователю от контракта гейтов.
#[tauri::command]
pub fn write_permission_preset(cwd: String, mode: String) -> Result<Option<String>, String> {
    write_permission_preset_in(&agent_dir(), &cwd, &mode)
}

pub fn write_permission_preset_in(
    agent_dir: &Path,
    cwd: &str,
    mode: &str,
) -> Result<Option<String>, String> {
    let content = match mode {
        "ask" => PRESET_ASK,
        "accept-edits" => PRESET_ACCEPT_EDITS,
        "auto" => PRESET_AUTO,
        "bypass" => PRESET_BYPASS,
        _ => return Err(format!("unknown mode: {mode}")),
    };
    // сперва убрать проектные legacy-файлы, чтобы расширение не ругалось и не мержило их
    migrate_project_permission_files(cwd, &mut Vec::new());

    let dir = project_permission_dir(cwd);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let config_path = dir.join("config.json");
    let marker = dir.join(".pi-app-mode");

    if config_path.exists() && !marker.exists() {
        let backup = dir.join("config.user-backup.json");
        if !backup.exists() {
            fs::copy(&config_path, &backup).map_err(|e| format!("backup failed: {e}"))?;
        }
    }
    write_json_atomic(&config_path, content)?;
    fs::write(&marker, mode).map_err(|e| e.to_string())?;
    Ok(sync_gate_configs(agent_dir, cwd, mode))
}

// ---------- контракт гейтов (ROADMAP §5.10-2, E2) ----------
//
// Режим разрешений pi-app — контракт со ВСЕМИ гейтующими расширениями, а не
// только с pi-permission-system. Известный сторонний гейт: @aliou/pi-guardrails.
// Его проектный конфиг — <cwd>/.pi/extensions/guardrails.json; поле
// `enabled: false` глушит все проверки (включая блокировку .env в bypass).

const GUARDRAILS_OFF: &str = "{\n  \"enabled\": false\n}\n";

fn guardrails_local_config(cwd: &str) -> PathBuf {
    Path::new(cwd)
        .join(".pi")
        .join("extensions")
        .join("guardrails.json")
}

fn guardrails_override_marker(cwd: &str) -> PathBuf {
    Path::new(cwd)
        .join(".pi")
        .join("extensions")
        .join(".pi-app-guardrails-override")
}

/// Файл — наш bypass-override: ровно один ключ, `{"enabled": false}`.
/// Всё остальное считается пользовательским конфигом и не трогается.
fn is_pi_app_guardrails_override(path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    v.as_object()
        .is_some_and(|m| m.len() == 1 && m.get("enabled").and_then(|b| b.as_bool()) == Some(false))
}

/// Установлен ли guardrails: ищем в packages глобальных и проектных настроек pi.
fn guardrails_installed(agent_dir: &Path, cwd: &str) -> bool {
    let listed = |p: &Path| {
        fs::read_to_string(p)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v.get("packages").map(|pkgs| pkgs.to_string()))
            .is_some_and(|s| s.contains("pi-guardrails"))
    };
    listed(&agent_dir.join("settings.json"))
        || listed(&Path::new(cwd).join(".pi").join("settings.json"))
}

/// bypass → отключить guardrails project-locally; другие режимы → снять наш
/// override (пользовательский конфиг не трогаем никогда). Возвращает сообщение
/// для тоста: info об отключении или warning о чужом конфиге.
fn sync_gate_configs(agent_dir: &Path, cwd: &str, mode: &str) -> Option<String> {
    let path = guardrails_local_config(cwd);
    let marker = guardrails_override_marker(cwd);
    if mode == "bypass" {
        if !guardrails_installed(agent_dir, cwd) {
            return None;
        }
        // Ownership is proven by a separate marker. Content alone is insufficient:
        // a user may legitimately maintain the same {enabled:false} config.
        if path.exists() && (!marker.exists() || !is_pi_app_guardrails_override(&path)) {
            let _ = fs::remove_file(&marker);
            return Some(
                "Bypass: найден пользовательский .pi/extensions/guardrails.json — pi-app его не трогает, guardrails может продолжать блокировать (например, .env)".into(),
            );
        }
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(&path, GUARDRAILS_OFF).is_ok() {
            if fs::write(&marker, "managed-by=pi-app\n").is_ok() {
                return Some("Bypass: pi-guardrails отключён для этого проекта (.pi/extensions/guardrails.json)".into());
            }
            // Не оставляем неотличимый от пользовательского файл, если ownership
            // marker записать не удалось.
            let _ = fs::remove_file(&path);
        }
        None
    } else {
        if marker.exists() && path.exists() && is_pi_app_guardrails_override(&path) {
            let _ = fs::remove_file(&path);
        }
        let _ = fs::remove_file(&marker);
        None
    }
}

/// Current preset mode for a workspace, if pi-app manages it.
#[tauri::command]
pub fn read_permission_mode(cwd: String) -> Option<String> {
    let new_marker = project_permission_dir(&cwd).join(".pi-app-mode");
    let legacy_marker = Path::new(&cwd)
        .join(".pi")
        .join("agent")
        .join(".pi-app-permission-mode");
    fs::read_to_string(new_marker)
        .or_else(|_| fs::read_to_string(legacy_marker))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_validates_and_backs_up() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.json");

        // invalid JSON is rejected
        assert!(write_json_atomic(&path, "{oops").is_err());
        assert!(!path.exists());

        // first write
        write_json_atomic(&path, r#"{"a":1}"#).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"a":1}"#);

        // second write creates a backup of the previous content
        write_json_atomic(&path, r#"{"a":2}"#).unwrap();
        let backup = path.with_extension("json.pi-app.bak");
        assert_eq!(fs::read_to_string(&backup).unwrap(), r#"{"a":1}"#);
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"a":2}"#);
    }

    #[test]
    fn generic_settings_editor_cannot_bypass_package_lifecycle() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.json");
        fs::write(&path, r#"{"theme":"dark","packages":["npm:one"]}"#).unwrap();
        assert!(reject_unmanaged_package_change(
            &path,
            r#"{"theme":"light","packages":["npm:one"]}"#
        )
        .is_ok());
        assert!(reject_unmanaged_package_change(
            &path,
            r#"{"theme":"dark","packages":["npm:two"]}"#
        )
        .unwrap_err()
        .contains("Library"));
    }

    #[test]
    fn concurrent_atomic_writes_use_distinct_temp_files() {
        let tmp = tempfile::tempdir().unwrap();
        let path = std::sync::Arc::new(tmp.path().join("settings.json"));
        write_json_atomic(&path, r#"{"value":0}"#).unwrap();
        let handles: Vec<_> = (1..=12)
            .map(|value| {
                let path = std::sync::Arc::clone(&path);
                std::thread::spawn(move || {
                    write_json_atomic(&path, &format!(r#"{{"value":{value}}}"#))
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap().unwrap();
        }
        let final_value: Value =
            serde_json::from_str(&fs::read_to_string(&*path).unwrap()).unwrap();
        assert!(final_value.get("value").and_then(Value::as_u64).is_some());
        assert!(fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .all(|entry| !entry.file_name().to_string_lossy().contains(".tmp-")));
    }

    #[test]
    fn app_config_defaults() {
        let c = AppConfig::default();
        assert_eq!(c.editor, "code");
        assert_eq!(c.process_limit, 2);
        assert!(c.process_limit_auto);
        assert_eq!(c.agent_sandbox_mode, "workspace-write");
        assert_eq!(c.idle_kill_secs, 900);
        assert_eq!(c.preview_idle_kill_secs, 600);
        assert!(c.lang.is_none());
        assert!(c.model_aliases.is_empty());
        assert!(c.model_avatars.is_empty());
        assert_eq!(c.accent_color, "#8b5cf6");
        assert_eq!(c.app_icon_background, DEFAULT_APP_ICON_BACKGROUND);
        assert_eq!(c.appearance_preset, "chatgpt");
        assert!(c.visual_effects);
        assert_eq!(c.interface_density, "comfortable");
        assert_eq!(c.transcript_mode, "normal");
    }

    #[test]
    fn app_config_new_fields_default_for_existing_files() {
        let c: AppConfig = serde_json::from_str(r#"{"editor":"zed","processLimit":3}"#).unwrap();
        assert!(c.process_limit_auto);
        assert_eq!(c.agent_sandbox_mode, "workspace-write");
        assert_eq!(c.preview_idle_kill_secs, 600);
        assert_eq!(c.editor, "zed");
        assert_eq!(c.process_limit, 3);
        assert!(c.model_aliases.is_empty());
        assert!(c.model_avatars.is_empty());
        assert_eq!(c.appearance_preset, "chatgpt");
        assert_eq!(c.app_icon_background, DEFAULT_APP_ICON_BACKGROUND);
        assert_eq!(c.transcript_mode, "normal");
    }

    #[test]
    fn app_config_migrates_legacy_icon_families_to_background_colors() {
        let aurora: AppConfig = serde_json::from_str(r#"{"appIconStyle":"aurora"}"#).unwrap();
        let graphite: AppConfig = serde_json::from_str(r#"{"appIconStyle":"graphite"}"#).unwrap();
        let custom: AppConfig =
            serde_json::from_str(r##"{"appIconBackground":"#4a62ff"}"##).unwrap();
        assert_eq!(aurora.app_icon_background, "#4057E8");
        assert_eq!(graphite.app_icon_background, "#34363D");
        assert_eq!(custom.app_icon_background, "#4A62FF");
    }

    #[test]
    fn app_config_tolerates_legacy_null_sandbox_mode_without_dropping_other_settings() {
        let c: AppConfig = serde_json::from_str(
            r#"{"editor":"zed","processLimit":3,"idleKillSecs":9000,"agentSandboxMode":null}"#,
        )
        .unwrap();
        assert_eq!(c.agent_sandbox_mode, "workspace-write");
        assert_eq!(c.idle_kill_secs, 9000);
        assert_eq!(c.editor, "zed");
        assert_eq!(c.process_limit, 3);
    }

    #[test]
    fn app_config_normalizes_out_of_range_and_injectable_values() {
        let mut c = AppConfig {
            editor: "$(touch /tmp/nope)".into(),
            process_limit: 999,
            idle_kill_secs: 0,
            preview_idle_kill_secs: u64::MAX,
            theme: "javascript:alert(1)".into(),
            ui_scale: 100.0,
            sidebar_width: 2,
            pi_retry_stall_timeout_ms: u64::MAX,
            accent_color: "url(https://tracker.invalid)".into(),
            icon_color: "red; color: blue".into(),
            appearance_preset: "unknown".into(),
            interface_density: "unknown".into(),
            transcript_mode: "unknown".into(),
            send_key_behavior: "unknown".into(),
            ..AppConfig::default()
        };
        c = normalize_app_config(c);
        assert_eq!(c.editor, "code");
        assert_eq!(c.process_limit, 8);
        assert_eq!(c.idle_kill_secs, 60);
        assert_eq!(c.preview_idle_kill_secs, 7 * 24 * 60 * 60);
        assert_eq!(c.theme, "system");
        assert_eq!(c.ui_scale, 1.6);
        assert_eq!(c.sidebar_width, 190);
        assert_eq!(c.pi_retry_stall_timeout_ms, 24 * 60 * 60 * 1000);
        assert_eq!(c.accent_color, "#8B5CF6");
        assert_eq!(c.icon_color, "#8B5CF6");
        assert_eq!(c.appearance_preset, "chatgpt");
        assert_eq!(c.interface_density, "comfortable");
        assert_eq!(c.transcript_mode, "normal");
        assert_eq!(c.send_key_behavior, "enter");
    }

    #[test]
    fn session_flags_are_bounded_and_drop_dangling_groups() {
        let flags = normalize_session_flags(SessionFlags {
            pinned: vec![" /one ".into(), "/one".into(), " ".into()],
            archived: (0..5_100).map(|index| format!("/s/{index}")).collect(),
            groups: vec![
                SessionGroup {
                    id: "valid".into(),
                    name: " QA ".into(),
                    cwd: "/repo".into(),
                },
                SessionGroup {
                    id: "valid".into(),
                    name: "duplicate".into(),
                    cwd: "/repo".into(),
                },
            ],
            group_of: HashMap::from([
                ("/s/1".into(), "valid".into()),
                ("/s/2".into(), "missing".into()),
            ]),
            pinned_messages: HashMap::from([(
                "/s/1".into(),
                vec![
                    PinnedMessage {
                        id: "p1".into(),
                        text: "hello".into(),
                        role: "assistant".into(),
                        ts: -10,
                    },
                    PinnedMessage {
                        id: " ".into(),
                        text: "invalid".into(),
                        role: "assistant".into(),
                        ts: 1,
                    },
                ],
            )]),
            hidden_projects: vec!["/repo".into(), "/repo".into()],
        });
        assert_eq!(flags.pinned, vec!["/one"]);
        assert_eq!(flags.archived.len(), 5_000);
        assert_eq!(flags.groups.len(), 1);
        assert_eq!(flags.groups[0].name, "QA");
        assert_eq!(
            flags.group_of,
            HashMap::from([("/s/1".into(), "valid".into())])
        );
        assert_eq!(flags.pinned_messages["/s/1"].len(), 1);
        assert_eq!(flags.pinned_messages["/s/1"][0].ts, 0);
        assert_eq!(flags.hidden_projects, vec!["/repo"]);
    }

    #[test]
    fn detects_local_model_provider_without_network_probe() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(
            tmp.path().join("models.json"),
            r#"{"providers":{"custom":{"baseUrl":"http://127.0.0.1:8003/v1"}}}"#,
        )
        .unwrap();
        assert!(local_provider_configured_in(tmp.path()));
        fs::write(
            tmp.path().join("models.json"),
            r#"{"providers":{"cloud":{"baseUrl":"https://api.example.com/v1"}}}"#,
        )
        .unwrap();
        assert!(!local_provider_configured_in(tmp.path()));
    }

    #[test]
    fn migrates_legacy_permission_files() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("proj");
        let legacy_dir = cwd.join(".pi").join("agent");
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(
            legacy_dir.join("pi-permissions.jsonc"),
            r#"{"yoloMode":true}"#,
        )
        .unwrap();
        fs::write(legacy_dir.join(".pi-app-permission-mode"), "bypass").unwrap();
        // глобальный legacy-файл в изолированном agent_dir
        let fake_agent = tmp.path().join("agent");
        fs::create_dir_all(&fake_agent).unwrap();
        fs::write(
            fake_agent.join("pi-permissions.jsonc"),
            r#"{"yoloMode":false}"#,
        )
        .unwrap();

        let log =
            migrate_permission_configs_in(&fake_agent, Some(cwd.to_string_lossy().into_owned()));
        assert!(!log.is_empty());
        assert!(!fake_agent.join("pi-permissions.jsonc").exists());
        assert!(fake_agent
            .join("extensions")
            .join(PERMISSION_EXT_ID)
            .join("config.json")
            .exists());
        assert!(!legacy_dir.join("pi-permissions.jsonc").exists());
        let new_cfg = cwd
            .join(".pi")
            .join("extensions")
            .join(PERMISSION_EXT_ID)
            .join("config.json");
        assert_eq!(
            fs::read_to_string(&new_cfg).unwrap(),
            r#"{"yoloMode":true}"#
        );
        // маркер переехал и режим читается
        assert_eq!(
            read_permission_mode(cwd.to_string_lossy().into_owned()).as_deref(),
            Some("bypass")
        );

        // повторный вызов — no-op
        assert!(migrate_permission_configs_in(
            &fake_agent,
            Some(cwd.to_string_lossy().into_owned())
        )
        .is_empty());

        // пресет пишется в новый путь
        write_permission_preset(cwd.to_string_lossy().into_owned(), "ask".into()).unwrap();
        assert_eq!(
            read_permission_mode(cwd.to_string_lossy().into_owned()).as_deref(),
            Some("ask")
        );
        let content = fs::read_to_string(&new_cfg).unwrap();
        assert!(content.contains("\"write\": \"ask\""));
    }

    #[test]
    fn gate_contract_bypass_toggles_guardrails() {
        let tmp = tempfile::tempdir().unwrap();
        let agent = tmp.path().join("agent");
        fs::create_dir_all(&agent).unwrap();
        fs::write(
            agent.join("settings.json"),
            r#"{"packages":["npm:@aliou/pi-guardrails"]}"#,
        )
        .unwrap();
        let proj = tmp.path().join("proj");
        fs::create_dir_all(&proj).unwrap();
        let cwd = proj.to_string_lossy().into_owned();
        let gpath = proj.join(".pi").join("extensions").join("guardrails.json");
        let marker = guardrails_override_marker(&cwd);

        // bypass выключает guardrails своим override-файлом
        let notice = write_permission_preset_in(&agent, &cwd, "bypass").unwrap();
        assert!(notice.unwrap().contains("отключён"));
        assert!(is_pi_app_guardrails_override(&gpath));
        assert!(marker.exists());

        // возврат в ask снимает наш override
        assert!(write_permission_preset_in(&agent, &cwd, "ask")
            .unwrap()
            .is_none());
        assert!(!gpath.exists());
        assert!(!marker.exists());

        // пользовательский конфиг: не трогаем и предупреждаем
        fs::create_dir_all(gpath.parent().unwrap()).unwrap();
        fs::write(&gpath, r#"{"enabled": true, "policies": {"rules": []}}"#).unwrap();
        let notice = write_permission_preset_in(&agent, &cwd, "bypass").unwrap();
        assert!(notice.unwrap().contains("не трогает"));
        write_permission_preset_in(&agent, &cwd, "ask").unwrap();
        assert!(gpath.exists(), "чужой файл сохранён");
        fs::remove_file(&gpath).unwrap();

        // Даже идентичный нашему по содержанию пользовательский файл не наш:
        // без marker он сохраняется при входе и выходе из bypass.
        fs::write(&gpath, GUARDRAILS_OFF).unwrap();
        let notice = write_permission_preset_in(&agent, &cwd, "bypass").unwrap();
        assert!(notice.unwrap().contains("не трогает"));
        assert!(!marker.exists());
        write_permission_preset_in(&agent, &cwd, "ask").unwrap();
        assert!(gpath.exists(), "идентичный пользовательский файл сохранён");
        fs::remove_file(&gpath).unwrap();

        // guardrails не установлен → bypass не создаёт файл и молчит
        fs::write(
            agent.join("settings.json"),
            r#"{"packages":["npm:pi-mcp-adapter"]}"#,
        )
        .unwrap();
        assert!(write_permission_preset_in(&agent, &cwd, "bypass")
            .unwrap()
            .is_none());
        assert!(!gpath.exists());

        // ...но проектные packages тоже учитываются
        fs::create_dir_all(proj.join(".pi")).unwrap();
        fs::write(
            proj.join(".pi").join("settings.json"),
            r#"{"packages":["npm:@aliou/pi-guardrails"]}"#,
        )
        .unwrap();
        assert!(write_permission_preset_in(&agent, &cwd, "bypass")
            .unwrap()
            .is_some());
        assert!(gpath.exists());
    }

    #[test]
    fn project_config_is_scoped_and_rejects_unknown_names() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().to_string_lossy().into_owned();
        write_project_pi_config_impl(cwd.clone(), "mcp".into(), "{\"mcpServers\":{}}".into())
            .unwrap();
        let read = read_project_pi_config(cwd.clone(), "mcp".into()).unwrap();
        assert!(read.path.ends_with(".pi/mcp.json"));
        assert!(read.content.contains("mcpServers"));
        assert!(read_project_pi_config(cwd, "../models".into()).is_err());
    }

    #[test]
    fn config_root_must_be_a_json_object() {
        assert!(validate_config_object("settings", r#"{"theme":"dark"}"#).is_ok());
        assert!(validate_config_object("settings", "[]")
            .unwrap_err()
            .contains("корень должен быть объектом"));
        assert!(validate_config_object("settings", "null").is_err());
        assert!(validate_config_object("settings", "{").is_err());
    }

    #[test]
    fn conditional_config_write_detects_stale_content_and_missing_files() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        assert!(ensure_config_unchanged(&path, "{}").is_ok());
        fs::write(&path, r#"{"theme":"dark"}"#).unwrap();
        assert!(ensure_config_unchanged(&path, r#"{"theme":"dark"}"#).is_ok());
        assert!(ensure_config_unchanged(&path, "{}")
            .unwrap_err()
            .starts_with("CONFIG_CONFLICT:"));
    }
}
