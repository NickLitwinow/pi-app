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
    pub idle_kill_secs: u64,
    pub theme: String,
    pub ui_scale: f64,
    /// Явно заданный пользователем путь к бинарю pi (приоритетнее авто-детекта).
    pub pi_path: Option<String>,
    pub sidebar_collapsed: bool,
    pub sidebar_width: u32,
    /// Каталог исходников pi-app для локального самообновления (ребилд из исходников).
    pub source_repo_path: Option<String>,
    /// Имя для приветствия на стартовом экране (как в Claude for Mac).
    pub display_name: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            editor: "code".into(),
            process_limit: 2,
            idle_kill_secs: 900,
            theme: "system".into(),
            ui_scale: 1.0,
            pi_path: None,
            sidebar_collapsed: false,
            sidebar_width: 240,
            source_repo_path: None,
            display_name: None,
        }
    }
}

/// Имя пользователя ОС с заглавной буквы — дефолт для приветствия.
fn os_display_name() -> Option<String> {
    let raw = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).ok()?;
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
    Path::new(cwd).join(".pi").join("extensions").join(PERMISSION_EXT_ID)
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
        log.push(format!("{} → {} (новый конфиг уже существует)", legacy.display(), backup.display()));
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
        &agent_dir.join("extensions").join(PERMISSION_EXT_ID).join("config.json"),
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
    for stale in ["pi-permissions.json.pi-app.bak", "pi-permissions.user-backup.jsonc"] {
        let p = legacy_dir.join(stale);
        if p.exists() && fs::remove_file(&p).is_ok() {
            log.push(format!("удалён {}", p.display()));
        }
    }
}

/// Write the project-local permission preset for @gotgenes/pi-permission-system.
/// A user-authored config (no marker file) is backed up once before overwrite.
#[tauri::command]
pub fn write_permission_preset(cwd: String, mode: String) -> Result<(), String> {
    let content = match mode.as_str() {
        "ask" => PRESET_ASK,
        "accept-edits" => PRESET_ACCEPT_EDITS,
        "auto" => PRESET_AUTO,
        "bypass" => PRESET_BYPASS,
        _ => return Err(format!("unknown mode: {mode}")),
    };
    // сперва убрать проектные legacy-файлы, чтобы расширение не ругалось и не мержило их
    migrate_project_permission_files(&cwd, &mut Vec::new());

    let dir = project_permission_dir(&cwd);
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
    fs::write(&marker, &mode).map_err(|e| e.to_string())?;
    Ok(())
}

/// Current preset mode for a workspace, if pi-app manages it.
#[tauri::command]
pub fn read_permission_mode(cwd: String) -> Option<String> {
    let new_marker = project_permission_dir(&cwd).join(".pi-app-mode");
    let legacy_marker = Path::new(&cwd).join(".pi").join("agent").join(".pi-app-permission-mode");
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
        let Ok(entries) = fs::read_dir(&dir) else { continue };
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
                        p.file_name().unwrap_or_default().to_string_lossy().into_owned()
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
        assert_eq!(c.idle_kill_secs, 900);
    }

    #[test]
    fn migrates_legacy_permission_files() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("proj");
        let legacy_dir = cwd.join(".pi").join("agent");
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(legacy_dir.join("pi-permissions.jsonc"), r#"{"yoloMode":true}"#).unwrap();
        fs::write(legacy_dir.join(".pi-app-permission-mode"), "bypass").unwrap();
        // глобальный legacy-файл в изолированном agent_dir
        let fake_agent = tmp.path().join("agent");
        fs::create_dir_all(&fake_agent).unwrap();
        fs::write(fake_agent.join("pi-permissions.jsonc"), r#"{"yoloMode":false}"#).unwrap();

        let log = migrate_permission_configs_in(&fake_agent, Some(cwd.to_string_lossy().into_owned()));
        assert!(!log.is_empty());
        assert!(!fake_agent.join("pi-permissions.jsonc").exists());
        assert!(fake_agent.join("extensions").join(PERMISSION_EXT_ID).join("config.json").exists());
        assert!(!legacy_dir.join("pi-permissions.jsonc").exists());
        let new_cfg = cwd.join(".pi").join("extensions").join(PERMISSION_EXT_ID).join("config.json");
        assert_eq!(fs::read_to_string(&new_cfg).unwrap(), r#"{"yoloMode":true}"#);
        // маркер переехал и режим читается
        assert_eq!(read_permission_mode(cwd.to_string_lossy().into_owned()).as_deref(), Some("bypass"));

        // повторный вызов — no-op
        assert!(migrate_permission_configs_in(&fake_agent, Some(cwd.to_string_lossy().into_owned())).is_empty());

        // пресет пишется в новый путь
        write_permission_preset(cwd.to_string_lossy().into_owned(), "ask".into()).unwrap();
        assert_eq!(read_permission_mode(cwd.to_string_lossy().into_owned()).as_deref(), Some("ask"));
        let content = fs::read_to_string(&new_cfg).unwrap();
        assert!(content.contains("\"write\": \"ask\""));
    }

    #[test]
    fn parses_skill_frontmatter() {
        let tmp = tempfile::tempdir().unwrap();
        let md = tmp.path().join("SKILL.md");
        fs::write(&md, "---\nname: my-skill\ndescription: Does things\n---\n# body\n").unwrap();
        let (name, desc) = parse_skill_md(&md);
        assert_eq!(name.as_deref(), Some("my-skill"));
        assert_eq!(desc.as_deref(), Some("Does things"));
    }
}
