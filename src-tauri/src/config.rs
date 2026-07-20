use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::sessions::agent_dir;

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
pub fn write_project_settings(cwd: String, content: String) -> Result<(), String> {
    write_project_pi_config(cwd, "settings".into(), content)
}

#[tauri::command]
pub fn write_project_pi_config(cwd: String, name: String, content: String) -> Result<(), String> {
    if !matches!(name.as_str(), "settings" | "mcp") {
        return Err(format!("unknown project config: {name}"));
    }
    let root = PathBuf::from(cwd);
    if !root.is_dir() {
        return Err("workspace не существует".into());
    }
    write_json_atomic(&root.join(".pi").join(format!("{name}.json")), &content)
}

/// Validate JSON, back up the previous version, then write atomically (tmp + rename).
pub fn write_json_atomic(path: &Path, content: &str) -> Result<(), String> {
    serde_json::from_str::<Value>(content).map_err(|e| format!("невалидный JSON: {e}"))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        if path.exists() {
            let backup = path.with_extension("json.pi-app.bak");
            fs::copy(path, &backup).map_err(|e| format!("backup failed: {e}"))?;
        }
        let tmp = parent.join(format!(
            ".{}.tmp-{}",
            path.file_name().unwrap_or_default().to_string_lossy(),
            std::process::id()
        ));
        fs::write(&tmp, content).map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("invalid path".into())
    }
}

#[tauri::command]
pub fn write_pi_config(name: String, content: String) -> Result<(), String> {
    let path = pi_config_path(&name)?;
    write_json_atomic(&path, &content)
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
    let mut cfg: AppConfig = fs::read_to_string(app_config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
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
        .unwrap_or_default()
}

#[tauri::command]
pub fn write_session_flags(flags: SessionFlags) -> Result<(), String> {
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

// ---------- skills discovery ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub path: String,
    pub source_dir: String,
}

fn expand_tilde(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(p)
}

fn parse_skill_md(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(content) = fs::read_to_string(path) else {
        return (None, None);
    };
    let mut name = None;
    let mut description = None;
    let mut in_frontmatter = false;
    for (i, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        if i == 0 && trimmed == "---" {
            in_frontmatter = true;
            continue;
        }
        if in_frontmatter {
            if trimmed == "---" {
                break;
            }
            if let Some(v) = trimmed.strip_prefix("name:") {
                name = Some(v.trim().to_string());
            } else if let Some(v) = trimmed.strip_prefix("description:") {
                let d: String = v.trim().chars().take(240).collect();
                description = Some(d);
            }
        } else if i > 20 {
            break;
        }
    }
    (name, description)
}

#[tauri::command]
pub fn list_skills() -> Vec<SkillInfo> {
    let mut out = Vec::new();
    // skill dirs come from settings.json "skills" array
    let settings_path = agent_dir().join("settings.json");
    let dirs_list: Vec<String> = fs::read_to_string(&settings_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| {
            v.get("skills").and_then(|s| s.as_array()).map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
        })
        .unwrap_or_default();

    for dir_str in &dirs_list {
        let dir = expand_tilde(dir_str);
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            let skill_md = p.join("SKILL.md");
            if skill_md.exists() {
                let (name, description) = parse_skill_md(&skill_md);
                out.push(SkillInfo {
                    name: name.unwrap_or_else(|| {
                        p.file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into_owned()
                    }),
                    description: description.unwrap_or_default(),
                    path: skill_md.to_string_lossy().into_owned(),
                    source_dir: dir_str.clone(),
                });
            }
            if out.len() >= 500 {
                return out;
            }
        }
    }
    out
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
        assert_eq!(c.transcript_mode, "normal");
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
    fn parses_skill_frontmatter() {
        let tmp = tempfile::tempdir().unwrap();
        let md = tmp.path().join("SKILL.md");
        fs::write(
            &md,
            "---\nname: my-skill\ndescription: Does things\n---\n# body\n",
        )
        .unwrap();
        let (name, desc) = parse_skill_md(&md);
        assert_eq!(name.as_deref(), Some("my-skill"));
        assert_eq!(desc.as_deref(), Some("Does things"));
    }

    #[test]
    fn project_config_is_scoped_and_rejects_unknown_names() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().to_string_lossy().into_owned();
        write_project_pi_config(cwd.clone(), "mcp".into(), "{\"mcpServers\":{}}".into()).unwrap();
        let read = read_project_pi_config(cwd.clone(), "mcp".into()).unwrap();
        assert!(read.path.ends_with(".pi/mcp.json"));
        assert!(read.content.contains("mcpServers"));
        assert!(read_project_pi_config(cwd, "../models".into()).is_err());
    }
}
