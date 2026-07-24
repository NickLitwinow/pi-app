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
    enabled: bool,
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

fn parse_theme(
    path: &Path,
    source: &str,
    package_name: Option<String>,
    enabled: bool,
) -> PiThemeInfo {
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
                enabled,
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
        enabled,
    }
}

const MAX_THEMES: usize = 500;
const MAX_THEME_SCAN_ENTRIES: usize = 5_000;

#[derive(Clone)]
struct ThemeCandidate {
    path: PathBuf,
    source: String,
    package_name: Option<String>,
    enabled: bool,
}

fn theme_path_key(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn push_candidate(
    path: PathBuf,
    source: &str,
    package_name: Option<String>,
    enabled: bool,
    candidates: &mut Vec<ThemeCandidate>,
    indexes: &mut HashMap<PathBuf, usize>,
    replace_enabled: bool,
) {
    if path.extension().and_then(|value| value.to_str()) != Some("json") {
        return;
    }
    let key = theme_path_key(&path);
    if let Some(index) = indexes.get(&key).copied() {
        if replace_enabled {
            candidates[index].enabled = enabled;
        }
        return;
    }
    if candidates.len() >= MAX_THEMES {
        return;
    }
    indexes.insert(key, candidates.len());
    candidates.push(ThemeCandidate {
        path,
        source: source.into(),
        package_name,
        enabled,
    });
}

fn collect_theme_files(path: &Path, recursive: bool, out: &mut Vec<PathBuf>, visited: &mut usize) {
    if *visited >= MAX_THEME_SCAN_ENTRIES || out.len() >= MAX_THEMES {
        return;
    }
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if metadata.is_file() {
        *visited += 1;
        if path.extension().and_then(|value| value.to_str()) == Some("json") {
            out.push(path.to_path_buf());
        }
        return;
    }
    if !metadata.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    let mut entries = entries.flatten().collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if *visited >= MAX_THEME_SCAN_ENTRIES || out.len() >= MAX_THEMES {
            return;
        }
        *visited += 1;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        if path.is_file() && path.extension().and_then(|value| value.to_str()) == Some("json") {
            out.push(path);
        } else if recursive && path.is_dir() {
            collect_theme_files(&path, true, out, visited);
        }
    }
}

fn expand_theme_path(raw: &str, base: &Path) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let expanded = if let Some(relative) = trimmed.strip_prefix("~/") {
        dirs::home_dir()?.join(relative)
    } else {
        PathBuf::from(trimmed)
    };
    Some(if expanded.is_absolute() {
        expanded
    } else {
        base.join(expanded)
    })
}

fn is_pattern(value: &str) -> bool {
    value.starts_with(['!', '+', '-']) || value.contains(['*', '?'])
}

fn has_glob(value: &str) -> bool {
    value.contains(['*', '?'])
}

fn normalize_match_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn pattern_matches(path: &Path, pattern: &str, base: &Path, exact: bool) -> bool {
    let normalized = pattern
        .strip_prefix("./")
        .unwrap_or(pattern)
        .replace('\\', "/");
    let relative = path
        .strip_prefix(base)
        .map(normalize_match_path)
        .unwrap_or_default();
    let absolute = normalize_match_path(path);
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    if exact {
        return [relative.as_str(), absolute.as_str(), name.as_str()]
            .contains(&normalized.as_str());
    }
    glob::Pattern::new(&normalized).is_ok_and(|pattern| {
        [relative.as_str(), absolute.as_str(), name.as_str()]
            .into_iter()
            .any(|candidate| pattern.matches(candidate))
    })
}

fn enabled_by_patterns(paths: &[PathBuf], patterns: &[String], base: &Path) -> HashSet<PathBuf> {
    let includes = patterns
        .iter()
        .filter(|pattern| !pattern.starts_with(['!', '+', '-']))
        .collect::<Vec<_>>();
    let excludes = patterns
        .iter()
        .filter_map(|pattern| pattern.strip_prefix('!'))
        .collect::<Vec<_>>();
    let force_includes = patterns
        .iter()
        .filter_map(|pattern| pattern.strip_prefix('+'))
        .collect::<Vec<_>>();
    let force_excludes = patterns
        .iter()
        .filter_map(|pattern| pattern.strip_prefix('-'))
        .collect::<Vec<_>>();
    let mut enabled = paths
        .iter()
        .filter(|path| {
            includes.is_empty()
                || includes
                    .iter()
                    .any(|pattern| pattern_matches(path, pattern, base, false))
        })
        .cloned()
        .collect::<HashSet<_>>();
    enabled.retain(|path| {
        !excludes
            .iter()
            .any(|pattern| pattern_matches(path, pattern, base, false))
    });
    for path in paths {
        if force_includes
            .iter()
            .any(|pattern| pattern_matches(path, pattern, base, true))
        {
            enabled.insert(path.clone());
        }
    }
    enabled.retain(|path| {
        !force_excludes
            .iter()
            .any(|pattern| pattern_matches(path, pattern, base, true))
    });
    enabled
}

fn collect_source_entries(entries: &[String], base: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut visited = 0usize;
    for entry in entries
        .iter()
        .filter(|entry| !entry.starts_with(['!', '+', '-']))
    {
        if has_glob(entry) {
            let Some(pattern) = expand_theme_path(entry, base) else {
                continue;
            };
            let pattern = pattern.to_string_lossy().into_owned();
            let Ok(matches) = glob::glob(&pattern) else {
                continue;
            };
            for matched in matches.flatten() {
                collect_theme_files(&matched, true, &mut paths, &mut visited);
                if paths.len() >= MAX_THEMES {
                    break;
                }
            }
        } else if let Some(path) = expand_theme_path(entry, base) {
            collect_theme_files(&path, true, &mut paths, &mut visited);
        }
        if paths.len() >= MAX_THEMES {
            break;
        }
    }
    paths
}

fn read_json_limited(path: &Path) -> Option<Value> {
    let mut file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(256 * 1024)
        .read_to_end(&mut bytes)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn package_theme_paths(package_root: &Path, convention_if_omitted: bool) -> Vec<PathBuf> {
    let manifest = read_json_limited(&package_root.join("package.json"));
    let package_manifest = manifest
        .as_ref()
        .and_then(|manifest| manifest.get("pi").or_else(|| manifest.get("pi-package")));
    if let Some(package_manifest) = package_manifest {
        let entries = string_array(package_manifest.get("themes"));
        if entries.is_empty() {
            if !convention_if_omitted {
                return Vec::new();
            }
        } else {
            let paths = collect_source_entries(&entries, package_root);
            let overrides = entries
                .into_iter()
                .filter(|entry| entry.starts_with(['!', '+', '-']))
                .collect::<Vec<_>>();
            let enabled = enabled_by_patterns(&paths, &overrides, package_root);
            return paths
                .into_iter()
                .filter(|path| enabled.contains(path))
                .collect();
        }
    }
    let mut paths = Vec::new();
    let mut visited = 0usize;
    collect_theme_files(&package_root.join("themes"), true, &mut paths, &mut visited);
    paths
}

fn settings_value(root: &Path) -> Option<Value> {
    read_json_limited(&root.join("settings.json"))
}

fn add_configured_themes(
    root: &Path,
    source: &str,
    settings: Option<&Value>,
    candidates: &mut Vec<ThemeCandidate>,
    indexes: &mut HashMap<PathBuf, usize>,
) {
    let configured = string_array(settings.and_then(|settings| settings.get("themes")));
    let explicit_entries = configured
        .iter()
        .filter(|entry| !is_pattern(entry))
        .cloned()
        .collect::<Vec<_>>();
    let explicit_patterns = configured
        .iter()
        .filter(|entry| is_pattern(entry))
        .cloned()
        .collect::<Vec<_>>();
    let explicit = collect_source_entries(&explicit_entries, root);
    let enabled_explicit = enabled_by_patterns(&explicit, &explicit_patterns, root);
    for path in explicit {
        push_candidate(
            path.clone(),
            source,
            None,
            enabled_explicit.contains(&path),
            candidates,
            indexes,
            false,
        );
    }
}

fn add_auto_themes(
    root: &Path,
    source: &str,
    settings: Option<&Value>,
    candidates: &mut Vec<ThemeCandidate>,
    indexes: &mut HashMap<PathBuf, usize>,
) {
    let configured = string_array(settings.and_then(|settings| settings.get("themes")));
    let mut auto = Vec::new();
    let mut visited = 0usize;
    collect_theme_files(&root.join("themes"), false, &mut auto, &mut visited);
    let overrides = configured
        .into_iter()
        .filter(|entry| entry.starts_with(['!', '+', '-']))
        .collect::<Vec<_>>();
    let enabled_auto = enabled_by_patterns(&auto, &overrides, root);
    for path in auto {
        push_candidate(
            path.clone(),
            source,
            None,
            enabled_auto.contains(&path),
            candidates,
            indexes,
            false,
        );
    }
}

#[derive(Clone)]
struct ConfiguredPackage {
    spec: Value,
    source: String,
    root: PathBuf,
    project: bool,
}

impl ConfiguredPackage {
    fn autoload_disabled(&self) -> bool {
        self.spec
            .get("autoload")
            .and_then(Value::as_bool)
            .is_some_and(|autoload| !autoload)
    }
}

fn configured_packages(
    root: &Path,
    settings: Option<&Value>,
    project: bool,
) -> Vec<ConfiguredPackage> {
    settings
        .and_then(|settings| settings.get("packages"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|spec| {
            let source = spec
                .as_str()
                .or_else(|| spec.get("source").and_then(Value::as_str))?
                .to_string();
            Some(ConfiguredPackage {
                spec: spec.clone(),
                source,
                root: root.to_path_buf(),
                project,
            })
        })
        .collect()
}

fn dedupe_packages(
    project: Vec<ConfiguredPackage>,
    global: &[ConfiguredPackage],
) -> Vec<ConfiguredPackage> {
    let mut out = Vec::new();
    let mut indexes = HashMap::new();
    for package in project.into_iter().chain(global.iter().cloned()) {
        let Some(identity) =
            crate::packages::package_identity_for_root(&package.root, &package.source)
        else {
            continue;
        };
        if let Some(index) = indexes.get(&identity).copied() {
            let existing: &ConfiguredPackage = &out[index];
            if existing.project && !package.project && existing.autoload_disabled() {
                out.push(package);
            }
            continue;
        }
        indexes.insert(identity, out.len());
        out.push(package);
    }
    out
}

fn delta_pattern_states(
    paths: &[PathBuf],
    patterns: &[String],
    base: &Path,
) -> HashMap<PathBuf, bool> {
    let mut states = HashMap::new();
    for pattern in patterns {
        let exact = pattern.starts_with(['+', '-']);
        let enabled = !pattern.starts_with(['!', '-']);
        let target = pattern
            .strip_prefix(['!', '+', '-'])
            .unwrap_or(pattern.as_str());
        for path in paths {
            if pattern_matches(path, target, base, exact) {
                states.insert(path.clone(), enabled);
            }
        }
    }
    states
}

fn add_package_themes(
    global_root: &Path,
    project_root: Option<&Path>,
    global_settings: Option<&Value>,
    project_settings: Option<&Value>,
    candidates: &mut Vec<ThemeCandidate>,
    indexes: &mut HashMap<PathBuf, usize>,
) {
    let global = configured_packages(global_root, global_settings, false);
    let project = project_root
        .map(|root| configured_packages(root, project_settings, true))
        .unwrap_or_default();
    let packages = dedupe_packages(project, &global);

    for package in packages {
        let identity = crate::packages::package_identity_for_root(&package.root, &package.source);
        let delta_base = package
            .autoload_disabled()
            .then(|| {
                global.iter().find(|candidate| {
                    crate::packages::package_identity_for_root(&candidate.root, &candidate.source)
                        == identity
                })
            })
            .flatten();
        let resolved = delta_base.unwrap_or(&package);
        let Some(package_root) =
            crate::packages::package_dir_for_root(&resolved.root, &resolved.source)
        else {
            continue;
        };
        let filter = package
            .spec
            .as_object()
            .and_then(|spec| spec.get("themes"))
            .map(|value| string_array(Some(value)));
        let paths = package_theme_paths(&package_root, package.spec.is_object());
        let package_name = crate::packages::installed_display_name(&package.source);

        if package.autoload_disabled() {
            let states =
                delta_pattern_states(&paths, filter.as_deref().unwrap_or_default(), &package_root);
            for path in paths {
                let Some(enabled) = states.get(&path).copied() else {
                    continue;
                };
                push_candidate(
                    path,
                    "package",
                    Some(package_name.clone()),
                    enabled,
                    candidates,
                    indexes,
                    false,
                );
            }
            continue;
        }

        let enabled = match filter.as_ref() {
            Some(patterns) if patterns.is_empty() => HashSet::new(),
            Some(patterns) => enabled_by_patterns(&paths, patterns, &package_root),
            None => paths.iter().cloned().collect(),
        };
        for path in paths {
            push_candidate(
                path.clone(),
                "package",
                Some(package_name.clone()),
                enabled.contains(&path),
                candidates,
                indexes,
                false,
            );
        }
    }
}

fn list_pi_themes_in(root: &Path, cwd: Option<&Path>) -> Vec<PiThemeInfo> {
    let mut candidates = Vec::new();
    let mut indexes = HashMap::new();
    let global_settings = settings_value(root);
    let project_root = cwd.map(|cwd| cwd.join(".pi"));
    let project_settings = project_root.as_deref().and_then(settings_value);

    add_package_themes(
        root,
        project_root.as_deref(),
        global_settings.as_ref(),
        project_settings.as_ref(),
        &mut candidates,
        &mut indexes,
    );

    if let Some(project_root) = project_root.as_deref() {
        add_configured_themes(
            project_root,
            "project",
            project_settings.as_ref(),
            &mut candidates,
            &mut indexes,
        );
    }
    add_configured_themes(
        root,
        "global",
        global_settings.as_ref(),
        &mut candidates,
        &mut indexes,
    );

    if let Some(project_root) = project_root.as_deref() {
        add_auto_themes(
            project_root,
            "project",
            project_settings.as_ref(),
            &mut candidates,
            &mut indexes,
        );
    }
    add_auto_themes(
        root,
        "global",
        global_settings.as_ref(),
        &mut candidates,
        &mut indexes,
    );

    let mut out = candidates
        .into_iter()
        .map(|candidate| {
            parse_theme(
                &candidate.path,
                &candidate.source,
                candidate.package_name,
                candidate.enabled,
            )
        })
        .collect::<Vec<_>>();
    out.sort_by_key(|theme| theme.name.to_lowercase());
    out
}

#[tauri::command]
pub fn list_pi_themes(cwd: Option<String>) -> Vec<PiThemeInfo> {
    let root = agent_dir();
    let cwd = cwd.as_deref().map(Path::new);
    list_pi_themes_in(&root, cwd)
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

    fn write_valid_theme(path: &Path, name: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let colors = THEME_TOKENS
            .iter()
            .map(|token| ((*token).to_string(), json!("#112233")))
            .collect::<Map<String, Value>>();
        fs::write(
            path,
            serde_json::to_string(&json!({ "name": name, "colors": colors })).unwrap(),
        )
        .unwrap();
    }

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

    #[test]
    fn discovers_effective_global_project_and_arbitrary_package_themes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("agent");
        let workspace = temp.path().join("workspace");
        let project_root = workspace.join(".pi");
        let local_package = temp.path().join("local-theme-package");
        let disabled_package = root.join("npm/node_modules/disabled-theme");
        let delta_package = root.join("npm/node_modules/delta-theme");
        let filtered_convention = root.join("npm/node_modules/filtered-convention");
        let hidden_convention = root.join("npm/node_modules/hidden-convention");
        let global_replacement = root.join("npm/node_modules/replacement-theme");
        let project_package = project_root.join("project-theme-package");
        let project_replacement = project_root.join("npm/node_modules/replacement-theme");

        write_valid_theme(&root.join("themes/auto.json"), "auto-global");
        write_valid_theme(&root.join("shared/nested/direct.json"), "direct-global");
        write_valid_theme(
            &local_package.join("assets/nested/local.json"),
            "local-package",
        );
        write_valid_theme(
            &disabled_package.join("assets/disabled.json"),
            "disabled-package",
        );
        write_valid_theme(&delta_package.join("assets/delta.json"), "delta-package");
        write_valid_theme(
            &filtered_convention.join("themes/convention.json"),
            "filtered-convention",
        );
        write_valid_theme(
            &hidden_convention.join("themes/hidden.json"),
            "hidden-convention",
        );
        write_valid_theme(
            &global_replacement.join("themes/global.json"),
            "global-replacement",
        );
        write_valid_theme(
            &project_package.join("custom/project.json"),
            "project-package",
        );
        write_valid_theme(
            &project_replacement.join("themes/project.json"),
            "project-replacement",
        );
        write_valid_theme(
            &project_root.join("themes/project-auto.json"),
            "auto-project",
        );
        fs::write(
            local_package.join("package.json"),
            r#"{"name":"local-theme-package","pi":{"themes":["assets/**/*.json"]}}"#,
        )
        .unwrap();
        fs::write(
            disabled_package.join("package.json"),
            r#"{"name":"disabled-theme","pi":{"themes":["assets/disabled.json"]}}"#,
        )
        .unwrap();
        fs::write(
            delta_package.join("package.json"),
            r#"{"name":"delta-theme","pi":{"themes":["assets/delta.json"]}}"#,
        )
        .unwrap();
        fs::write(
            filtered_convention.join("package.json"),
            r#"{"name":"filtered-convention","pi":{"extensions":["index.js"]}}"#,
        )
        .unwrap();
        fs::write(
            hidden_convention.join("package.json"),
            r#"{"name":"hidden-convention","pi":{"extensions":["index.js"]}}"#,
        )
        .unwrap();
        fs::write(
            global_replacement.join("package.json"),
            r#"{"name":"replacement-theme","pi":{"themes":["themes/global.json"]}}"#,
        )
        .unwrap();
        fs::write(
            project_package.join("package.json"),
            r#"{"name":"project-theme-package","pi":{"themes":["custom"]}}"#,
        )
        .unwrap();
        fs::write(
            project_replacement.join("package.json"),
            r#"{"name":"replacement-theme","pi":{"themes":["themes/project.json"]}}"#,
        )
        .unwrap();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("settings.json"),
            serde_json::to_string(&json!({
                "themes": ["shared"],
                "packages": [
                    local_package.to_string_lossy(),
                    {"source": "npm:disabled-theme", "themes": []},
                    "npm:delta-theme",
                    {"source": "npm:filtered-convention", "extensions": []},
                    "npm:hidden-convention",
                    "npm:replacement-theme"
                ]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::create_dir_all(&project_root).unwrap();
        fs::write(
            project_root.join("settings.json"),
            r#"{"packages":[
                "./project-theme-package",
                {"source":"npm:delta-theme","autoload":false,"themes":["-assets/delta.json"]},
                "npm:replacement-theme"
            ]}"#,
        )
        .unwrap();

        let themes = list_pi_themes_in(&root, Some(&workspace));
        let by_name = themes
            .iter()
            .map(|theme| (theme.name.as_str(), theme))
            .collect::<HashMap<_, _>>();
        for name in [
            "auto-global",
            "direct-global",
            "local-package",
            "disabled-package",
            "delta-package",
            "filtered-convention",
            "project-package",
            "project-replacement",
            "auto-project",
        ] {
            assert!(by_name.contains_key(name), "missing {name}");
        }
        assert!(!by_name["disabled-package"].enabled);
        assert!(!by_name["delta-package"].enabled);
        assert!(by_name["local-package"].enabled);
        assert!(!by_name.contains_key("hidden-convention"));
        assert!(!by_name.contains_key("global-replacement"));
        assert_eq!(
            by_name["local-package"].package_name.as_deref(),
            Some("local-theme-package")
        );
        assert_eq!(by_name["auto-project"].source, "project");
        assert!(themes.iter().all(|theme| theme.valid));
    }
}
