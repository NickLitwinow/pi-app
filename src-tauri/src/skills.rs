use ignore::WalkBuilder;
use serde::Serialize;
use serde_json::Value;
use serde_yaml::Value as YamlValue;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use crate::packages::{
    configured_packages, dedupe_configured_packages, installed_display_name, package_dir_for_root,
    package_identity_for_root, ConfiguredPackage,
};
use crate::sessions::agent_dir;

const MAX_SKILLS: usize = 500;
const MAX_SCAN_ENTRIES: usize = 10_000;
const MAX_SETTINGS_BYTES: u64 = 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_SKILL_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    name: String,
    description: String,
    path: String,
    source_dir: String,
    scope: String,
    origin: String,
    package_name: Option<String>,
    enabled: bool,
    valid: bool,
    warning: Option<String>,
    disable_model_invocation: bool,
    shadowed_by: Option<String>,
}

#[derive(Clone)]
struct SkillCandidate {
    path: PathBuf,
    source_dir: String,
    scope: String,
    origin: String,
    package_name: Option<String>,
    enabled: bool,
}

#[derive(Default)]
struct ParsedSkill {
    name: String,
    description: String,
    valid: bool,
    warning: Option<String>,
    disable_model_invocation: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SkillDirectoryMode {
    Pi,
    Agents,
}

fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit {
        return Err(format!("{} превышает лимит {} байт", path.display(), limit));
    }
    Ok(bytes)
}

fn read_json_limited(path: &Path, limit: u64) -> Option<Value> {
    let bytes = read_limited(path, limit).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn read_settings(path: &Path) -> Result<Option<Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = read_limited(path, MAX_SETTINGS_BYTES)?;
    let mut value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("{}: невалидный JSON: {error}", path.display()))?;
    if !value.is_object() {
        return Err(format!("{}: корень должен быть объектом", path.display()));
    }
    migrate_legacy_skill_settings(&mut value, path)?;
    validate_string_entries(&value, "skills", path)?;
    if let Some(packages) = value.get("packages") {
        let packages = packages
            .as_array()
            .ok_or_else(|| format!("{}: packages должен быть массивом", path.display()))?;
        for package in packages {
            if package.as_str().is_some() {
                continue;
            }
            let object = package.as_object().ok_or_else(|| {
                format!(
                    "{}: элементы packages должны быть строками или объектами",
                    path.display()
                )
            })?;
            if !object.get("source").is_some_and(Value::is_string) {
                return Err(format!(
                    "{}: package object должен содержать строковый source",
                    path.display()
                ));
            }
            if object
                .get("autoload")
                .is_some_and(|autoload| !autoload.is_boolean())
            {
                return Err(format!(
                    "{}: package.autoload должен быть boolean",
                    path.display()
                ));
            }
            if let Some(skills) = object.get("skills") {
                validate_string_array(skills, "package.skills", path)?;
            }
        }
    }
    Ok(Some(value))
}

fn migrate_legacy_skill_settings(value: &mut Value, path: &Path) -> Result<(), String> {
    let Some(legacy) = value.get("skills").and_then(Value::as_object) else {
        return Ok(());
    };
    let custom_directories = legacy.get("customDirectories").cloned();
    if let Some(custom_directories) = custom_directories.as_ref() {
        validate_string_array(custom_directories, "skills.customDirectories", path)?;
    }
    let object = value.as_object_mut().expect("validated settings object");
    let replacement = match custom_directories {
        Some(Value::Array(directories)) if !directories.is_empty() => {
            Some(Value::Array(directories))
        }
        _ => None,
    };
    match replacement {
        Some(directories) => {
            object.insert("skills".into(), directories);
        }
        None => {
            object.remove("skills");
        }
    }
    Ok(())
}

fn validate_string_entries(value: &Value, key: &str, path: &Path) -> Result<(), String> {
    if let Some(entries) = value.get(key) {
        validate_string_array(entries, key, path)?;
    }
    Ok(())
}

fn validate_string_array(value: &Value, key: &str, path: &Path) -> Result<(), String> {
    let entries = value
        .as_array()
        .ok_or_else(|| format!("{}: {key} должен быть массивом", path.display()))?;
    if entries.iter().any(|entry| !entry.is_string()) {
        return Err(format!(
            "{}: элементы {key} должны быть строками",
            path.display()
        ));
    }
    Ok(())
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

fn yaml_string(mapping: &serde_yaml::Mapping, key: &str) -> Option<String> {
    mapping
        .get(YamlValue::String(key.to_string()))
        .and_then(YamlValue::as_str)
        .map(str::to_string)
}

fn yaml_bool(mapping: &serde_yaml::Mapping, key: &str) -> bool {
    mapping
        .get(YamlValue::String(key.to_string()))
        .and_then(YamlValue::as_bool)
        .unwrap_or(false)
}

fn skill_fallback_name(path: &Path) -> String {
    path.parent()
        .and_then(Path::file_name)
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

fn parse_skill(path: &Path) -> ParsedSkill {
    let fallback = skill_fallback_name(path);
    let bytes = match read_limited(path, MAX_SKILL_BYTES) {
        Ok(bytes) => bytes,
        Err(error) => {
            return ParsedSkill {
                name: fallback,
                warning: Some(error),
                ..ParsedSkill::default()
            }
        }
    };
    let content = match String::from_utf8(bytes) {
        Ok(content) => content.replace("\r\n", "\n").replace('\r', "\n"),
        Err(error) => {
            return ParsedSkill {
                name: fallback,
                warning: Some(format!("SKILL.md не UTF-8: {error}")),
                ..ParsedSkill::default()
            }
        }
    };
    let mapping = if content.starts_with("---") {
        let end = content
            .get(3..)
            .and_then(|tail| tail.find("\n---").map(|offset| offset + 3));
        let Some(end) = end else {
            return ParsedSkill {
                name: fallback,
                warning: Some("frontmatter не закрыт маркером ---".into()),
                ..ParsedSkill::default()
            };
        };
        let yaml = content.get(4..end).unwrap_or_default();
        match serde_yaml::from_str::<YamlValue>(yaml) {
            Ok(YamlValue::Mapping(mapping)) => mapping,
            Ok(_) => {
                return ParsedSkill {
                    name: fallback,
                    warning: Some("frontmatter должен быть YAML-объектом".into()),
                    ..ParsedSkill::default()
                }
            }
            Err(error) => {
                return ParsedSkill {
                    name: fallback,
                    warning: Some(format!("невалидный YAML frontmatter: {error}")),
                    ..ParsedSkill::default()
                }
            }
        }
    } else {
        serde_yaml::Mapping::new()
    };

    if mapping
        .get(YamlValue::String("name".into()))
        .is_some_and(|name| !name.is_string() && !name.is_null())
    {
        return ParsedSkill {
            name: fallback,
            warning: Some("frontmatter.name должен быть строкой".into()),
            ..ParsedSkill::default()
        };
    }
    let name = yaml_string(&mapping, "name")
        .filter(|name| !name.is_empty())
        .unwrap_or(fallback);
    let description = yaml_string(&mapping, "description").unwrap_or_default();
    let mut warnings = Vec::new();
    if description.trim().is_empty() {
        warnings.push("description обязателен; Pi не загрузит этот skill".to_string());
    } else if description.chars().count() > 1024 {
        warnings.push(format!(
            "description длиннее 1024 символов ({})",
            description.chars().count()
        ));
    }
    if name.chars().count() > 64 {
        warnings.push(format!(
            "name длиннее 64 символов ({})",
            name.chars().count()
        ));
    }
    if !name.chars().all(|character| {
        character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
    }) {
        warnings.push("name может содержать только lowercase a-z, 0-9 и дефисы".into());
    }
    if name.starts_with('-') || name.ends_with('-') {
        warnings.push("name не должен начинаться или заканчиваться дефисом".into());
    }
    if name.contains("--") {
        warnings.push("name не должен содержать два дефиса подряд".into());
    }
    ParsedSkill {
        name,
        description: description.clone(),
        valid: !description.trim().is_empty(),
        warning: (!warnings.is_empty()).then(|| warnings.join(" · ")),
        disable_model_invocation: yaml_bool(&mapping, "disable-model-invocation"),
    }
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
}

fn collect_skill_directory(
    root: &Path,
    mode: SkillDirectoryMode,
    visited: &mut usize,
) -> Vec<PathBuf> {
    if !root.is_dir() || *visited >= MAX_SCAN_ENTRIES {
        return Vec::new();
    }
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(true)
        .parents(false)
        .git_global(false)
        .git_exclude(false)
        .follow_links(true)
        .add_custom_ignore_filename(".fdignore")
        .filter_entry(|entry| entry.file_name() != "node_modules");

    let mut files = Vec::new();
    for entry in builder.build().flatten() {
        if *visited >= MAX_SCAN_ENTRIES {
            break;
        }
        *visited += 1;
        if entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
        {
            files.push(entry.into_path());
        }
    }
    files.sort();

    let mut skill_files = files
        .iter()
        .filter(|path| path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md"))
        .cloned()
        .collect::<Vec<_>>();
    skill_files.sort_by(|left, right| {
        left.components()
            .count()
            .cmp(&right.components().count())
            .then_with(|| left.cmp(right))
    });

    let mut skill_roots: Vec<PathBuf> = Vec::new();
    let mut selected = Vec::new();
    for path in skill_files {
        let parent = path.parent().unwrap_or(root);
        if skill_roots
            .iter()
            .any(|skill_root| parent.starts_with(skill_root))
        {
            continue;
        }
        skill_roots.push(parent.to_path_buf());
        selected.push(path);
        if selected.len() >= MAX_SKILLS {
            return selected;
        }
    }
    if mode == SkillDirectoryMode::Pi && !skill_roots.iter().any(|path| path == root) {
        for path in files {
            if path.parent() == Some(root) && is_markdown(&path) && !selected.contains(&path) {
                selected.push(path);
                if selected.len() >= MAX_SKILLS {
                    break;
                }
            }
        }
    }
    selected.sort();
    selected
}

fn collect_skill_path(path: &Path, mode: SkillDirectoryMode, visited: &mut usize) -> Vec<PathBuf> {
    if path.is_file() {
        if *visited >= MAX_SCAN_ENTRIES {
            return Vec::new();
        }
        *visited += 1;
        return if is_markdown(path) {
            vec![path.to_path_buf()]
        } else {
            Vec::new()
        };
    }
    collect_skill_directory(path, mode, visited)
}

fn expand_path(raw: &str, base: &Path, home: &Path) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let expanded = if trimmed == "~" {
        home.to_path_buf()
    } else if let Some(relative) = trimmed.strip_prefix("~/") {
        home.join(relative)
    } else {
        PathBuf::from(trimmed)
    };
    Some(normalize_lexical(if expanded.is_absolute() {
        expanded
    } else {
        base.join(expanded)
    }))
}

fn normalize_lexical(path: PathBuf) -> PathBuf {
    let absolute = path.is_absolute();
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                let last = normalized.components().next_back();
                if matches!(last, Some(Component::Normal(_))) {
                    normalized.pop();
                } else if !absolute
                    && (last.is_none() || matches!(last, Some(Component::ParentDir)))
                {
                    normalized.push(component.as_os_str());
                }
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn is_pattern(value: &str) -> bool {
    value.starts_with(['!', '+', '-']) || value.contains(['*', '?'])
}

fn has_glob(value: &str) -> bool {
    value.contains(['*', '?'])
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn matches_pattern(path: &Path, pattern: &str, base: &Path, exact: bool) -> bool {
    let relative = path
        .strip_prefix(base)
        .map(normalize_path)
        .unwrap_or_default();
    let absolute = normalize_path(path);
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let is_skill_file = name == "SKILL.md";
    let parent = is_skill_file.then(|| path.parent()).flatten();
    let parent_relative = parent
        .and_then(|parent| parent.strip_prefix(base).ok())
        .map(normalize_path)
        .unwrap_or_default();
    let parent_name = parent
        .and_then(Path::file_name)
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let parent_absolute = parent.map(normalize_path).unwrap_or_default();

    if exact {
        let normalized = pattern
            .strip_prefix("./")
            .or_else(|| pattern.strip_prefix(".\\"))
            .unwrap_or(pattern)
            .replace('\\', "/");
        return [relative.as_str(), absolute.as_str()].contains(&normalized.as_str())
            || (is_skill_file
                && [parent_relative.as_str(), parent_absolute.as_str()]
                    .contains(&normalized.as_str()));
    }
    let normalized = pattern.replace('\\', "/");
    glob::Pattern::new(&normalized).is_ok_and(|pattern| {
        [relative.as_str(), name.as_str(), absolute.as_str()]
            .into_iter()
            .chain(
                is_skill_file
                    .then_some([
                        parent_relative.as_str(),
                        parent_name.as_str(),
                        parent_absolute.as_str(),
                    ])
                    .into_iter()
                    .flatten(),
            )
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
                    .any(|pattern| matches_pattern(path, pattern, base, false))
        })
        .cloned()
        .collect::<HashSet<_>>();
    enabled.retain(|path| {
        !excludes
            .iter()
            .any(|pattern| matches_pattern(path, pattern, base, false))
    });
    for path in paths {
        if force_includes
            .iter()
            .any(|pattern| matches_pattern(path, pattern, base, true))
        {
            enabled.insert(path.clone());
        }
    }
    enabled.retain(|path| {
        !force_excludes
            .iter()
            .any(|pattern| matches_pattern(path, pattern, base, true))
    });
    enabled
}

fn enabled_by_overrides(path: &Path, patterns: &[String], base: &Path) -> bool {
    let mut enabled = true;
    if patterns
        .iter()
        .filter_map(|pattern| pattern.strip_prefix('!'))
        .any(|pattern| matches_pattern(path, pattern, base, false))
    {
        enabled = false;
    }
    if patterns
        .iter()
        .filter_map(|pattern| pattern.strip_prefix('+'))
        .any(|pattern| matches_pattern(path, pattern, base, true))
    {
        enabled = true;
    }
    if patterns
        .iter()
        .filter_map(|pattern| pattern.strip_prefix('-'))
        .any(|pattern| matches_pattern(path, pattern, base, true))
    {
        enabled = false;
    }
    enabled
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
            if matches_pattern(path, target, base, exact) {
                states.insert(path.clone(), enabled);
            }
        }
    }
    states
}

fn collect_source_paths(
    entries: &[String],
    base: &Path,
    home: &Path,
    visited: &mut usize,
) -> Vec<(PathBuf, String)> {
    let mut paths = Vec::new();
    for entry in entries.iter().filter(|entry| !is_pattern(entry)) {
        let Some(resolved) = expand_path(entry, base, home) else {
            continue;
        };
        for path in collect_skill_path(&resolved, SkillDirectoryMode::Pi, visited) {
            paths.push((path, entry.clone()));
            if paths.len() >= MAX_SKILLS {
                return paths;
            }
        }
    }
    paths
}

fn collect_manifest_paths(
    entries: &[String],
    package_root: &Path,
    visited: &mut usize,
) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for entry in entries
        .iter()
        .filter(|entry| !entry.starts_with(['!', '+', '-']))
    {
        if entry.trim().is_empty() {
            continue;
        }
        let raw = PathBuf::from(entry);
        let expanded = normalize_lexical(if raw.is_absolute() {
            raw
        } else {
            package_root.join(raw)
        });
        let resolved = if has_glob(entry) {
            let pattern = expanded.to_string_lossy().into_owned();
            glob::glob(&pattern)
                .ok()
                .into_iter()
                .flatten()
                .flatten()
                .collect::<Vec<_>>()
        } else {
            vec![expanded]
        };
        for resolved in resolved {
            paths.extend(collect_skill_path(
                &resolved,
                SkillDirectoryMode::Pi,
                visited,
            ));
            if paths.len() >= MAX_SKILLS {
                break;
            }
        }
    }
    let patterns = entries
        .iter()
        .filter(|entry| entry.starts_with(['!', '+', '-']))
        .cloned()
        .collect::<Vec<_>>();
    let enabled = enabled_by_patterns(&paths, &patterns, package_root);
    paths.retain(|path| enabled.contains(path));
    paths
}

fn package_manifest(package_root: &Path) -> Option<Value> {
    read_json_limited(&package_root.join("package.json"), MAX_MANIFEST_BYTES)?
        .get("pi")
        .cloned()
}

enum ManifestSkillEntries {
    Missing,
    Invalid,
    Entries(Vec<String>),
}

fn manifest_skill_entries(manifest: &Value) -> ManifestSkillEntries {
    let Some(skills) = manifest.get("skills") else {
        return ManifestSkillEntries::Missing;
    };
    let Some(entries) = skills.as_array() else {
        return ManifestSkillEntries::Invalid;
    };
    if entries.iter().any(|entry| !entry.is_string()) {
        return ManifestSkillEntries::Invalid;
    }
    ManifestSkillEntries::Entries(
        entries
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
    )
}

fn package_skill_paths(
    package_root: &Path,
    filter_present: bool,
    object_package: bool,
    visited: &mut usize,
) -> Vec<PathBuf> {
    let manifest = package_manifest(package_root);
    let declaration = manifest
        .as_ref()
        .map(manifest_skill_entries)
        .unwrap_or(ManifestSkillEntries::Missing);
    if matches!(&declaration, ManifestSkillEntries::Invalid) {
        return Vec::new();
    }
    if filter_present {
        if let ManifestSkillEntries::Entries(entries) = &declaration {
            if entries.is_empty() {
                return collect_skill_directory(
                    &package_root.join("skills"),
                    SkillDirectoryMode::Pi,
                    visited,
                );
            }
            return collect_manifest_paths(entries, package_root, visited);
        }
        return collect_skill_directory(
            &package_root.join("skills"),
            SkillDirectoryMode::Pi,
            visited,
        );
    }
    if manifest.is_some() {
        if let ManifestSkillEntries::Entries(entries) = &declaration {
            return collect_manifest_paths(entries, package_root, visited);
        }
        if !object_package {
            return Vec::new();
        }
    }
    collect_skill_directory(
        &package_root.join("skills"),
        SkillDirectoryMode::Pi,
        visited,
    )
}

fn add_package_candidates(
    global_root: &Path,
    project_root: Option<&Path>,
    global_settings: Option<&Value>,
    project_settings: Option<&Value>,
    candidates: &mut Vec<SkillCandidate>,
    visited: &mut usize,
) {
    let global = configured_packages(global_root, global_settings, false);
    let project = project_root
        .map(|root| configured_packages(root, project_settings, true))
        .unwrap_or_default();
    let packages = dedupe_configured_packages(project, &global);

    for package in packages {
        let identity = package_identity_for_root(&package.root, &package.source);
        let delta_base = package
            .autoload_disabled()
            .then(|| {
                global.iter().find(|candidate| {
                    package_identity_for_root(&candidate.root, &candidate.source) == identity
                })
            })
            .flatten();
        let resolved: &ConfiguredPackage = delta_base.unwrap_or(&package);
        let Some(package_root) = package_dir_for_root(&resolved.root, &resolved.source) else {
            continue;
        };
        let filter = package
            .spec
            .as_object()
            .and_then(|spec| spec.get("skills"))
            .map(|value| string_array(Some(value)));
        let paths = package_skill_paths(
            &package_root,
            filter.is_some(),
            package.spec.is_object(),
            visited,
        );
        let package_name = installed_display_name(&package.source);

        if package.autoload_disabled() {
            let states =
                delta_pattern_states(&paths, filter.as_deref().unwrap_or_default(), &package_root);
            for path in paths {
                let Some(enabled) = states.get(&path).copied() else {
                    continue;
                };
                candidates.push(SkillCandidate {
                    path,
                    source_dir: package.source.clone(),
                    scope: "project".into(),
                    origin: "package".into(),
                    package_name: Some(package_name.clone()),
                    enabled,
                });
            }
            continue;
        }

        let enabled = match filter.as_ref() {
            Some(patterns) if patterns.is_empty() => HashSet::new(),
            Some(patterns) => enabled_by_patterns(&paths, patterns, &package_root),
            None => paths.iter().cloned().collect(),
        };
        for path in paths {
            candidates.push(SkillCandidate {
                enabled: enabled.contains(&path),
                path,
                source_dir: package.source.clone(),
                scope: if package.project {
                    "project".into()
                } else {
                    "global".into()
                },
                origin: "package".into(),
                package_name: Some(package_name.clone()),
            });
        }
    }
}

fn add_configured_candidates(
    root: &Path,
    scope: &str,
    settings: Option<&Value>,
    home: &Path,
    candidates: &mut Vec<SkillCandidate>,
    visited: &mut usize,
) {
    let configured = string_array(settings.and_then(|settings| settings.get("skills")));
    let paths_with_sources = collect_source_paths(&configured, root, home, visited);
    let paths = paths_with_sources
        .iter()
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();
    let patterns = configured
        .iter()
        .filter(|entry| is_pattern(entry))
        .cloned()
        .collect::<Vec<_>>();
    let enabled = enabled_by_patterns(&paths, &patterns, root);
    for (path, source) in paths_with_sources {
        candidates.push(SkillCandidate {
            enabled: enabled.contains(&path),
            path,
            source_dir: source,
            scope: scope.into(),
            origin: "configured".into(),
            package_name: None,
        });
    }
}

fn add_auto_directory(
    directory: &Path,
    mode: SkillDirectoryMode,
    base: &Path,
    scope: &str,
    settings: Option<&Value>,
    candidates: &mut Vec<SkillCandidate>,
    visited: &mut usize,
) {
    let overrides = string_array(settings.and_then(|settings| settings.get("skills")));
    let paths = collect_skill_directory(directory, mode, visited);
    for path in paths {
        candidates.push(SkillCandidate {
            enabled: enabled_by_overrides(&path, &overrides, base),
            path,
            source_dir: directory.to_string_lossy().into_owned(),
            scope: scope.into(),
            origin: "auto".into(),
            package_name: None,
        });
    }
}

fn find_git_root(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        if current.join(".git").exists() {
            return Some(current);
        }
        let parent = current.parent()?.to_path_buf();
        if parent == current {
            return None;
        }
        current = parent;
    }
}

fn ancestor_agents_skill_dirs(cwd: &Path) -> Vec<PathBuf> {
    let stop = find_git_root(cwd);
    let mut current = cwd.to_path_buf();
    let mut directories = Vec::new();
    loop {
        directories.push(current.join(".agents/skills"));
        if stop.as_ref().is_some_and(|stop| stop == &current) {
            break;
        }
        let Some(parent) = current.parent() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent.to_path_buf();
    }
    directories
}

fn precedence(candidate: &SkillCandidate) -> usize {
    if candidate.origin == "package" {
        return 4;
    }
    match (candidate.scope.as_str(), candidate.origin.as_str()) {
        ("project", "configured") => 0,
        ("project", _) => 1,
        ("global", "configured") => 2,
        _ => 3,
    }
}

fn finalize_candidates(mut candidates: Vec<SkillCandidate>) -> Vec<SkillInfo> {
    candidates.sort_by_key(precedence);
    let mut seen = HashSet::new();
    let mut loaded_names: HashMap<String, String> = HashMap::new();
    let mut out = Vec::new();
    for candidate in candidates {
        let identity = candidate
            .path
            .canonicalize()
            .unwrap_or_else(|_| candidate.path.clone());
        if !seen.insert(identity) {
            continue;
        }
        let mut parsed = parse_skill(&candidate.path);
        let shadowed_by = if candidate.enabled && parsed.valid {
            if let Some(winner) = loaded_names.get(&parsed.name) {
                Some(winner.clone())
            } else {
                loaded_names.insert(
                    parsed.name.clone(),
                    candidate.path.to_string_lossy().into_owned(),
                );
                None
            }
        } else {
            None
        };
        if let Some(winner) = shadowed_by.as_ref() {
            let collision = format!("name collision: Pi использует {winner}");
            parsed.warning = Some(match parsed.warning {
                Some(warning) => format!("{warning} · {collision}"),
                None => collision,
            });
        }
        out.push(SkillInfo {
            name: parsed.name,
            description: parsed.description,
            path: candidate.path.to_string_lossy().into_owned(),
            source_dir: candidate.source_dir,
            scope: candidate.scope,
            origin: candidate.origin,
            package_name: candidate.package_name,
            enabled: candidate.enabled,
            valid: parsed.valid,
            warning: parsed.warning,
            disable_model_invocation: parsed.disable_model_invocation,
            shadowed_by,
        });
        if out.len() >= MAX_SKILLS {
            break;
        }
    }
    out.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.path.cmp(&right.path))
    });
    out
}

fn list_skills_in(
    agent_root: &Path,
    cwd: Option<&Path>,
    home: &Path,
) -> Result<Vec<SkillInfo>, String> {
    let global_settings = read_settings(&agent_root.join("settings.json"))?;
    let project_trusted = cwd
        .map(|cwd| {
            crate::resources::project_is_trusted(agent_root, cwd, home, global_settings.as_ref())
        })
        .transpose()?
        .unwrap_or(false);
    let project_root = cwd.filter(|_| project_trusted).map(|cwd| cwd.join(".pi"));
    let project_settings = project_root
        .as_deref()
        .map(|root| read_settings(&root.join("settings.json")))
        .transpose()?
        .flatten();
    let mut candidates = Vec::new();
    let mut visited = 0usize;

    add_package_candidates(
        agent_root,
        project_root.as_deref(),
        global_settings.as_ref(),
        project_settings.as_ref(),
        &mut candidates,
        &mut visited,
    );
    if let Some(project_root) = project_root.as_deref() {
        add_configured_candidates(
            project_root,
            "project",
            project_settings.as_ref(),
            home,
            &mut candidates,
            &mut visited,
        );
    }
    add_configured_candidates(
        agent_root,
        "global",
        global_settings.as_ref(),
        home,
        &mut candidates,
        &mut visited,
    );

    if let (Some(cwd), Some(project_root)) = (cwd, project_root.as_deref()) {
        add_auto_directory(
            &project_root.join("skills"),
            SkillDirectoryMode::Pi,
            project_root,
            "project",
            project_settings.as_ref(),
            &mut candidates,
            &mut visited,
        );
        let user_agents = home.join(".agents/skills");
        for directory in ancestor_agents_skill_dirs(cwd) {
            let same_as_user = directory
                .canonicalize()
                .ok()
                .zip(user_agents.canonicalize().ok())
                .is_some_and(|(left, right)| left == right)
                || directory == user_agents;
            if same_as_user {
                continue;
            }
            let base = directory.parent().unwrap_or(&directory);
            add_auto_directory(
                &directory,
                SkillDirectoryMode::Agents,
                base,
                "project",
                project_settings.as_ref(),
                &mut candidates,
                &mut visited,
            );
        }
    }
    add_auto_directory(
        &agent_root.join("skills"),
        SkillDirectoryMode::Pi,
        agent_root,
        "global",
        global_settings.as_ref(),
        &mut candidates,
        &mut visited,
    );
    let user_agents = home.join(".agents/skills");
    let user_agents_base = user_agents.parent().unwrap_or(&user_agents);
    add_auto_directory(
        &user_agents,
        SkillDirectoryMode::Agents,
        user_agents_base,
        "global",
        global_settings.as_ref(),
        &mut candidates,
        &mut visited,
    );

    if visited >= MAX_SCAN_ENTRIES {
        return Err(format!(
            "discovery skills остановлен после {MAX_SCAN_ENTRIES} файлов; сократите configured/package paths"
        ));
    }
    Ok(finalize_candidates(candidates))
}

#[tauri::command]
pub fn list_skills(cwd: Option<String>) -> Result<Vec<SkillInfo>, String> {
    let home = dirs::home_dir().ok_or("не удалось определить домашний каталог")?;
    list_skills_in(&agent_dir(), cwd.as_deref().map(Path::new), &home)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(path: &Path, name: &str, description: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            path,
            format!("---\nname: {name}\ndescription: {description}\n---\n# {name}\n"),
        )
        .unwrap();
    }

    fn trust_project(agent: &Path, project: &Path) {
        let project = project.canonicalize().unwrap();
        fs::create_dir_all(agent).unwrap();
        fs::write(
            agent.join("trust.json"),
            format!(
                "{{{}:true}}",
                serde_json::to_string(&project.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
    }

    fn by_name<'a>(skills: &'a [SkillInfo], name: &str) -> &'a SkillInfo {
        skills.iter().find(|skill| skill.name == name).unwrap()
    }

    #[test]
    fn discovers_configured_auto_and_agents_skills_with_pi_precedence() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let agent = home.join(".pi/agent");
        let repo = tmp.path().join("repo");
        let nested = repo.join("packages/app");
        fs::create_dir_all(nested.join(".pi")).unwrap();
        fs::create_dir_all(repo.join(".git")).unwrap();

        write_skill(
            &agent.join("configured/SKILL.md"),
            "configured-global",
            "Configured globally",
        );
        write_skill(
            &agent.join("skills/global-auto/SKILL.md"),
            "global-auto",
            "Global auto",
        );
        write_skill(
            &nested.join(".pi/skills/project-auto/SKILL.md"),
            "project-auto",
            "Project auto",
        );
        write_skill(
            &nested.join(".pi/manual/SKILL.md"),
            "configured-global",
            "Project collision winner",
        );
        write_skill(
            &repo.join(".agents/skills/ancestor/SKILL.md"),
            "ancestor",
            "Ancestor agent skill",
        );
        write_skill(
            &home.join(".agents/skills/user/SKILL.md"),
            "user-agent",
            "User agent skill",
        );
        fs::create_dir_all(&agent).unwrap();
        fs::write(
            agent.join("settings.json"),
            r#"{"skills":["configured","!global-auto"]}"#,
        )
        .unwrap();
        fs::write(
            nested.join(".pi/settings.json"),
            r#"{"skills":["manual","-skills/project-auto"]}"#,
        )
        .unwrap();
        trust_project(&agent, &nested);

        let skills = list_skills_in(&agent, Some(&nested), &home).unwrap();
        assert_eq!(skills.len(), 6);
        let project_winner = skills
            .iter()
            .find(|skill| skill.name == "configured-global" && skill.scope == "project")
            .unwrap();
        let global_loser = skills
            .iter()
            .find(|skill| skill.name == "configured-global" && skill.scope == "global")
            .unwrap();
        assert_eq!(project_winner.origin, "configured");
        assert_eq!(
            global_loser.shadowed_by.as_deref(),
            Some(project_winner.path.as_str())
        );
        assert!(!by_name(&skills, "global-auto").enabled);
        assert!(!by_name(&skills, "project-auto").enabled);
        assert_eq!(by_name(&skills, "ancestor").scope, "project");
        assert_eq!(by_name(&skills, "user-agent").scope, "global");
    }

    #[test]
    fn package_manifest_filters_and_omitted_manifest_resources_match_pi() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let agent = home.join(".pi/agent");
        let package = agent.join("npm/node_modules/demo-skills");
        write_skill(
            &package.join("skill-set/on/SKILL.md"),
            "package-on",
            "Enabled package skill",
        );
        write_skill(
            &package.join("skill-set/off/SKILL.md"),
            "package-off",
            "Disabled package skill",
        );
        fs::write(
            package.join("package.json"),
            r#"{"name":"demo-skills","pi":{"skills":["skill-*"]}}"#,
        )
        .unwrap();

        let no_skills = agent.join("npm/node_modules/no-skills");
        write_skill(
            &no_skills.join("skills/hidden/SKILL.md"),
            "should-not-load",
            "Manifest omission is authoritative",
        );
        fs::write(
            no_skills.join("package.json"),
            r#"{"name":"no-skills","pi":{"extensions":["index.js"]}}"#,
        )
        .unwrap();

        let invalid_manifest = agent.join("npm/node_modules/invalid-skills");
        write_skill(
            &invalid_manifest.join("skills/unsafe-fallback/SKILL.md"),
            "unsafe-fallback",
            "Invalid manifests must fail closed",
        );
        fs::write(
            invalid_manifest.join("package.json"),
            r#"{"name":"invalid-skills","pi":{"skills":["skills",42]}}"#,
        )
        .unwrap();

        fs::create_dir_all(&agent).unwrap();
        fs::write(
            agent.join("settings.json"),
            r#"{"packages":[{"source":"npm:demo-skills","skills":["-skill-set/off"]},"npm:no-skills",{"source":"npm:invalid-skills","skills":["*"]}]}"#,
        )
        .unwrap();
        let skills = list_skills_in(&agent, None, &home).unwrap();
        assert_eq!(skills.len(), 2);
        assert!(by_name(&skills, "package-on").enabled);
        assert!(!by_name(&skills, "package-off").enabled);
        assert!(skills
            .iter()
            .all(|skill| skill.package_name.as_deref() == Some("demo-skills")));
    }

    #[test]
    fn project_autoload_delta_only_overrides_mentioned_global_package_skills() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let agent = home.join(".pi/agent");
        let project = tmp.path().join("project");
        let package = agent.join("npm/node_modules/delta-skills");
        write_skill(
            &package.join("skills/on/SKILL.md"),
            "delta-on",
            "Inherited global skill",
        );
        write_skill(
            &package.join("skills/off/SKILL.md"),
            "delta-off",
            "Project-disabled skill",
        );
        fs::write(package.join("package.json"), r#"{"name":"delta-skills"}"#).unwrap();
        fs::create_dir_all(&agent).unwrap();
        fs::write(
            agent.join("settings.json"),
            r#"{"packages":["npm:delta-skills"]}"#,
        )
        .unwrap();
        fs::create_dir_all(project.join(".pi")).unwrap();
        fs::write(
            project.join(".pi/settings.json"),
            r#"{"packages":[{"source":"npm:delta-skills","autoload":false,"skills":["-skills/off"]}]}"#,
        )
        .unwrap();
        trust_project(&agent, &project);

        let skills = list_skills_in(&agent, Some(&project), &home).unwrap();
        assert_eq!(skills.len(), 2);
        assert!(by_name(&skills, "delta-on").enabled);
        assert_eq!(by_name(&skills, "delta-on").scope, "global");
        assert!(!by_name(&skills, "delta-off").enabled);
        assert_eq!(by_name(&skills, "delta-off").scope, "project");
    }

    #[test]
    fn honors_ignore_files_recursion_and_reports_invalid_skills() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let agent = home.join(".pi/agent");
        write_skill(
            &agent.join("skills/visible/deep/SKILL.md"),
            "deep",
            "Recursive discovery",
        );
        write_skill(
            &agent.join("skills/ignored/SKILL.md"),
            "ignored",
            "Must stay hidden",
        );
        fs::write(agent.join("skills/.ignore"), "ignored/\n").unwrap();
        fs::write(
            agent.join("skills/root-command.md"),
            "---\nname: root-command\ndescription: Root markdown skill\n---\n",
        )
        .unwrap();
        fs::create_dir_all(agent.join("skills/broken")).unwrap();
        fs::write(
            agent.join("skills/broken/SKILL.md"),
            "---\nname: broken\n---\n",
        )
        .unwrap();
        fs::create_dir_all(agent.join("skills/non-string-name")).unwrap();
        fs::write(
            agent.join("skills/non-string-name/SKILL.md"),
            "---\nname: [unsafe]\ndescription: Must not load\n---\n",
        )
        .unwrap();

        let skills = list_skills_in(&agent, None, &home).unwrap();
        assert_eq!(skills.len(), 4);
        assert!(skills.iter().all(|skill| skill.name != "ignored"));
        assert!(!by_name(&skills, "broken").valid);
        assert!(by_name(&skills, "broken")
            .warning
            .as_deref()
            .unwrap()
            .contains("Pi не загрузит"));
        assert!(!by_name(&skills, "non-string-name").valid);
        assert!(by_name(&skills, "non-string-name")
            .warning
            .as_deref()
            .unwrap()
            .contains("должен быть строкой"));
    }

    #[test]
    fn malformed_skill_settings_fail_closed() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let agent = home.join(".pi/agent");
        fs::create_dir_all(&agent).unwrap();
        fs::write(agent.join("settings.json"), r#"{"skills":"oops"}"#).unwrap();
        assert!(list_skills_in(&agent, None, &home)
            .unwrap_err()
            .contains("skills должен быть массивом"));
    }

    #[test]
    fn migrates_legacy_custom_directories_like_pi_settings_manager() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let agent = home.join(".pi/agent");
        write_skill(
            &agent.join("legacy/SKILL.md"),
            "legacy-skill",
            "Legacy custom directory",
        );
        fs::write(
            agent.join("settings.json"),
            r#"{"skills":{"enableSkillCommands":true,"customDirectories":["legacy"]}}"#,
        )
        .unwrap();
        let skills = list_skills_in(&agent, None, &home).unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "legacy-skill");
        assert_eq!(skills[0].origin, "configured");
    }

    #[test]
    #[ignore = "requires the user's installed Pi packages and skill settings"]
    fn live_discovery_matches_installed_pi_skill_surface() {
        let cwd = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let skills = list_skills(Some(cwd.to_string_lossy().into_owned())).unwrap();
        let enabled = skills
            .iter()
            .filter(|skill| skill.enabled && skill.valid)
            .collect::<Vec<_>>();
        assert!(
            enabled.len() >= 3,
            "expected configured and installed package skills, got {}",
            enabled.len()
        );
        assert!(
            enabled.iter().any(|skill| skill.origin == "package"),
            "installed package skills were not resolved"
        );
        for skill in &enabled {
            assert!(Path::new(&skill.path).is_file(), "missing {}", skill.path);
        }
        eprintln!(
            "{}",
            enabled
                .iter()
                .map(|skill| format!("{}|{}|{}", skill.path, skill.scope, skill.origin))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
}
