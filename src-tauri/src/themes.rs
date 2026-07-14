use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
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

fn parse_theme(path: &Path, source: &str, package_name: Option<String>) -> PiThemeInfo {
    let fallback_name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("theme")
        .to_string();
    let parsed = fs::read_to_string(path)
        .map_err(|error| error.to_string())
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
        .to_string();
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
    let resolved_colors = colors
        .iter()
        .map(|(key, value)| (key.clone(), resolve_value(value, &vars, true, 0)))
        .collect();
    let missing: Vec<&str> = THEME_TOKENS
        .iter()
        .copied()
        .filter(|token| !colors.contains_key(*token))
        .collect();
    PiThemeInfo {
        name,
        path: path.to_string_lossy().into_owned(),
        source: source.into(),
        package_name,
        colors,
        resolved_colors,
        valid: missing.is_empty(),
        error: (!missing.is_empty())
            .then(|| format!("нет обязательных токенов: {}", missing.join(", "))),
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
    Some(
        version_at
            .map(|index| &raw[..index])
            .unwrap_or(raw)
            .to_string(),
    )
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
    }

    #[test]
    fn validates_all_required_tokens() {
        let mut colors = Map::new();
        for token in THEME_TOKENS {
            colors.insert((*token).into(), json!("#112233"));
        }
        assert!(validate_draft(&ThemeDraft {
            name: "aurora".into(),
            colors
        })
        .is_ok());
    }
}
