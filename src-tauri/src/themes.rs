use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::config::write_json_atomic;
use crate::sessions::agent_dir;

pub const THEME_TOKENS: &[&str] = &[
    "accent",
    "border",
    "borderAccent",
    "borderMuted",
    "success",
    "error",
    "warning",
    "muted",
    "dim",
    "text",
    "thinkingText",
    "selectedBg",
    "userMessageBg",
    "userMessageText",
    "customMessageBg",
    "customMessageText",
    "customMessageLabel",
    "toolPendingBg",
    "toolSuccessBg",
    "toolErrorBg",
    "toolTitle",
    "toolOutput",
    "mdHeading",
    "mdLink",
    "mdLinkUrl",
    "mdCode",
    "mdCodeBlock",
    "mdCodeBlockBorder",
    "mdQuote",
    "mdQuoteBorder",
    "mdHr",
    "mdListBullet",
    "toolDiffAdded",
    "toolDiffRemoved",
    "toolDiffContext",
    "syntaxComment",
    "syntaxKeyword",
    "syntaxFunction",
    "syntaxVariable",
    "syntaxString",
    "syntaxNumber",
    "syntaxType",
    "syntaxOperator",
    "syntaxPunctuation",
    "thinkingOff",
    "thinkingMinimal",
    "thinkingLow",
    "thinkingMedium",
    "thinkingHigh",
    "thinkingXhigh",
    "bashMode",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiThemeInfo {
    name: String,
    path: String,
    source: String,
    package_name: Option<String>,
    colors: Map<String, Value>,
    resolved_colors: HashMap<String, String>,
    valid: bool,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeDraft {
    name: String,
    colors: Map<String, Value>,
}

fn ansi_color(index: u64) -> String {
    const BASE: [&str; 16] = [
        "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
        "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
    ];
    if index < 16 {
        return BASE[index as usize].into();
    }
    if index <= 231 {
        let n = index - 16;
        let levels = [0, 95, 135, 175, 215, 255];
        return format!(
            "#{:02x}{:02x}{:02x}",
            levels[(n / 36) as usize],
            levels[((n / 6) % 6) as usize],
            levels[(n % 6) as usize]
        );
    }
    let gray = 8 + (index.min(255) - 232) * 10;
    format!("#{gray:02x}{gray:02x}{gray:02x}")
}

fn resolve_value(value: &Value, vars: &Map<String, Value>, dark: bool, depth: usize) -> String {
    if depth > 4 {
        return if dark { "#f4f4f5" } else { "#18181b" }.into();
    }
    if let Some(index) = value.as_u64() {
        return ansi_color(index);
    }
    let Some(raw) = value.as_str() else {
        return if dark { "#f4f4f5" } else { "#18181b" }.into();
    };
    if raw.is_empty() {
        return if dark { "#f4f4f5" } else { "#18181b" }.into();
    }
    if let Some(variable) = vars.get(raw) {
        return resolve_value(variable, vars, dark, depth + 1);
    }
    raw.to_string()
}

fn passive_css_color(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    !value.is_empty()
        && value.len() <= 200
        && !value.contains([';', '{', '}', '\'', '"', '\\'])
        && !["url(", "var(", "expression("]
            .iter()
            .any(|needle| lower.contains(needle))
}

fn parse_theme(path: &Path, source: &str, package_name: Option<String>) -> PiThemeInfo {
    let fallback_name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("theme")
        .to_string();
    let parsed = fs::File::open(path)
        .map_err(|error| error.to_string())
        .and_then(|file| {
            let mut bytes = Vec::new();
            file.take(2 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
            if bytes.len() > 2 * 1024 * 1024 {
                return Err("файл темы превышает лимит 2 MiB".into());
            }
            String::from_utf8(bytes).map_err(|error| error.to_string())
        })
        .and_then(|text| serde_json::from_str::<Value>(&text).map_err(|error| error.to_string()));
    let value = match parsed {
        Ok(value) => value,
        Err(error) => {
            return PiThemeInfo {
                name: fallback_name,
                path: path.to_string_lossy().into_owned(),
                source: source.into(),
                package_name,
                colors: Map::new(),
                resolved_colors: HashMap::new(),
                valid: false,
                error: Some(error),
            }
        }
    };
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&fallback_name)
        .trim()
        .chars()
        .take(120)
        .collect();
    let vars = value
        .get("vars")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let colors = value
        .get("colors")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let resolved_colors: HashMap<String, String> = THEME_TOKENS
        .iter()
        .filter_map(|token| {
            colors
                .get(*token)
                .map(|value| ((*token).to_string(), resolve_value(value, &vars, true, 0)))
        })
        .collect();
    let missing: Vec<&str> = THEME_TOKENS
        .iter()
        .copied()
        .filter(|token| !colors.contains_key(*token))
        .collect();
    let unsafe_tokens: Vec<&str> = resolved_colors
        .iter()
        .filter_map(|(token, value)| (!passive_css_color(value)).then_some(token.as_str()))
        .collect();
    let mut errors = Vec::new();
    if !missing.is_empty() {
        errors.push(format!("нет обязательных токенов: {}", missing.join(", ")));
    }
    if !unsafe_tokens.is_empty() {
        errors.push(format!(
            "небезопасные CSS-значения: {}",
            unsafe_tokens.join(", ")
        ));
    }
    PiThemeInfo {
        name,
        path: path.to_string_lossy().into_owned(),
        source: source.into(),
        package_name,
        colors,
        resolved_colors,
        valid: errors.is_empty(),
        error: (!errors.is_empty()).then(|| errors.join("; ")),
    }
}

fn scan_dir(
    dir: &Path,
    source: &str,
    package_name: Option<String>,
    out: &mut Vec<PiThemeInfo>,
    seen: &mut HashSet<PathBuf>,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json")
            || !seen.insert(path.clone())
        {
            continue;
        }
        out.push(parse_theme(&path, source, package_name.clone()));
    }
}

fn package_name(spec: &Value) -> Option<String> {
    let raw = spec
        .as_str()
        .or_else(|| spec.get("source").and_then(Value::as_str))?;
    let raw = raw.strip_prefix("npm:")?;
    let version_at = if raw.starts_with('@') {
        raw.find('/')
            .and_then(|slash| raw[slash + 1..].find('@').map(|at| slash + 1 + at))
    } else {
        raw.find('@')
    };
    let name = version_at.map(|index| &raw[..index]).unwrap_or(raw);
    let parts: Vec<&str> = name.split('/').collect();
    let valid = if name.starts_with('@') {
        parts.len() == 2 && parts[0].len() > 1
    } else {
        parts.len() == 1
    } && parts
        .iter()
        .all(|part| !part.is_empty() && *part != "." && *part != ".." && !part.contains('\\'));
    valid.then(|| name.to_string())
}

#[tauri::command]
pub fn list_pi_themes(cwd: Option<String>) -> Vec<PiThemeInfo> {
    let root = agent_dir();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    scan_dir(&root.join("themes"), "global", None, &mut out, &mut seen);
    if let Some(cwd) = cwd {
        scan_dir(
            &PathBuf::from(cwd).join(".pi/themes"),
            "project",
            None,
            &mut out,
            &mut seen,
        )
    }
    let settings = fs::read_to_string(root.join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    if let Some(packages) = settings
        .as_ref()
        .and_then(|value| value.get("packages"))
        .and_then(Value::as_array)
    {
        for spec in packages {
            let Some(name) = package_name(spec) else {
                continue;
            };
            scan_dir(
                &root.join("npm/node_modules").join(&name).join("themes"),
                "package",
                Some(name),
                &mut out,
                &mut seen,
            );
        }
    }
    out.sort_by_key(|theme| theme.name.to_lowercase());
    out
}

fn validate_draft(draft: &ThemeDraft) -> Result<String, String> {
    let name = draft.name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err("имя темы не должно быть пустым и не может содержать / или \\".into());
    }
    if name.chars().count() > 100 {
        return Err("имя темы не должно быть длиннее 100 символов".into());
    }
    let missing: Vec<&str> = THEME_TOKENS
        .iter()
        .copied()
        .filter(|token| !draft.colors.contains_key(*token))
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "не заданы обязательные токены: {}",
            missing.join(", ")
        ));
    }
    let invalid: Vec<&str> = THEME_TOKENS
        .iter()
        .copied()
        .filter(|token| !match draft.colors.get(*token) {
            Some(Value::Number(value)) => value.as_u64().is_some_and(|index| index <= 255),
            Some(Value::String(value)) => passive_css_color(value),
            _ => false,
        })
        .collect();
    if !invalid.is_empty() {
        return Err(format!(
            "некорректные или небезопасные значения цветов: {}",
            invalid.join(", ")
        ));
    }
    Ok(name.to_string())
}

fn theme_json(draft: &ThemeDraft, name: &str) -> Value {
    json!({
        "$schema": "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
        "name": name, "colors": draft.colors,
    })
}

#[tauri::command]
pub fn save_pi_theme(
    draft: ThemeDraft,
    scope: String,
    cwd: Option<String>,
) -> Result<String, String> {
    let name = validate_draft(&draft)?;
    let dir = if scope == "project" {
        PathBuf::from(cwd.ok_or("для project-темы нужен workspace")?).join(".pi/themes")
    } else {
        agent_dir().join("themes")
    };
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(format!("{name}.json"));
    write_json_atomic(
        &path,
        &serde_json::to_string_pretty(&theme_json(&draft, &name))
            .map_err(|error| error.to_string())?,
    )?;
    Ok(path.to_string_lossy().into_owned())
}

fn delete_theme_in_roots(path: &Path, roots: &[PathBuf]) -> Result<(), String> {
    if path.extension().and_then(|value| value.to_str()) != Some("json") {
        return Err("можно удалить только JSON-файл темы".into());
    }
    let resolved = path
        .canonicalize()
        .map_err(|error| format!("тема недоступна: {error}"))?;
    let parent = resolved
        .parent()
        .ok_or("у темы нет родительского каталога")?;
    let allowed = roots.iter().any(|root| {
        root.canonicalize()
            .is_ok_and(|resolved_root| parent == resolved_root)
    });
    if !allowed {
        return Err("удаление разрешено только для пользовательских тем global/project".into());
    }
    fs::remove_file(resolved).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_pi_theme(path: String, cwd: Option<String>) -> Result<(), String> {
    let mut roots = vec![agent_dir().join("themes")];
    if let Some(cwd) = cwd {
        roots.push(PathBuf::from(cwd).join(".pi/themes"));
    }
    delete_theme_in_roots(Path::new(&path), &roots)
}

#[tauri::command]
pub fn export_pi_theme_package(destination: String, draft: ThemeDraft) -> Result<String, String> {
    let name = validate_draft(&draft)?;
    let slug: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        return Err("имя темы не содержит допустимых символов".into());
    }
    let package_dir = PathBuf::from(destination).join(format!("pi-theme-{slug}"));
    if package_dir.exists() {
        return Err("каталог экспортируемого пакета уже существует".into());
    }
    fs::create_dir_all(package_dir.join("themes")).map_err(|error| error.to_string())?;
    write_json_atomic(
        &package_dir.join("themes").join(format!("{slug}.json")),
        &serde_json::to_string_pretty(&theme_json(&draft, &name))
            .map_err(|error| error.to_string())?,
    )?;
    let manifest = json!({
        "name": format!("pi-theme-{slug}"), "version": "0.1.0", "description": format!("{name} theme for pi"),
        "license": "MIT", "keywords": ["pi-package", "pi-theme"], "files": ["themes", "README.md"],
        "pi": { "themes": [format!("themes/{slug}.json")] }
    });
    write_json_atomic(
        &package_dir.join("package.json"),
        &serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?,
    )?;
    fs::write(package_dir.join("README.md"), format!("# {name}\n\nA custom theme for [pi](https://pi.dev).\n\n```bash\npi install npm:pi-theme-{slug}\n```\n"))
        .map_err(|error| error.to_string())?;
    Ok(package_dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_ansi_and_theme_vars() {
        let vars = serde_json::from_value(json!({"blue": 33})).unwrap();
        assert_eq!(resolve_value(&json!("blue"), &vars, true, 0), "#0087ff");
        assert_eq!(resolve_value(&json!(196), &Map::new(), true, 0), "#ff0000");
        assert!(passive_css_color("color(display-p3 0.3 0.6 1 / 0.8)"));
        assert!(!passive_css_color("url(https://tracker.invalid/pixel)"));
    }

    #[test]
    fn validates_all_required_tokens() {
        let mut colors = Map::new();
        for token in THEME_TOKENS {
            colors.insert((*token).into(), json!("#112233"));
        }
        let valid = ThemeDraft {
            name: "aurora".into(),
            colors,
        };
        assert!(validate_draft(&valid).is_ok());
        let mut unsafe_draft = valid;
        unsafe_draft
            .colors
            .insert("accent".into(), json!("url(https://tracker.invalid/pixel)"));
        assert!(validate_draft(&unsafe_draft).is_err());
    }

    #[test]
    fn package_theme_names_reject_path_traversal() {
        assert_eq!(
            package_name(&json!("npm:plain@1.0.0")),
            Some("plain".into())
        );
        assert_eq!(
            package_name(&json!("npm:@scope/theme@2.0.0")),
            Some("@scope/theme".into())
        );
        assert_eq!(package_name(&json!("npm:../../outside")), None);
        assert_eq!(package_name(&json!("npm:@scope/../outside")), None);
        assert_eq!(package_name(&json!("npm:..\\outside")), None);
    }

    #[test]
    fn deletes_only_direct_json_children_of_allowed_theme_roots() {
        let temp = tempfile::tempdir().unwrap();
        let themes = temp.path().join("themes");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&themes).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let allowed = themes.join("custom.json");
        let forbidden = outside.join("custom.json");
        fs::write(&allowed, "{}").unwrap();
        fs::write(&forbidden, "{}").unwrap();

        assert!(delete_theme_in_roots(&forbidden, std::slice::from_ref(&themes)).is_err());
        assert!(forbidden.exists());
        assert!(delete_theme_in_roots(&allowed, &[themes]).is_ok());
        assert!(!allowed.exists());
    }
}
