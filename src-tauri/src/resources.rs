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

const MAX_RESOURCES: usize = 1_000;
const MAX_SCAN_ENTRIES: usize = 10_000;
const MAX_SETTINGS_BYTES: u64 = 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_PROMPT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
enum ResourceKind {
    Extension,
    Prompt,
}

impl ResourceKind {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "extension" => Ok(Self::Extension),
            "prompt" => Ok(Self::Prompt),
            _ => Err(format!(
                "неподдерживаемый resource kind {value:?}; ожидается extension или prompt"
            )),
        }
    }

    fn settings_key(self) -> &'static str {
        match self {
            Self::Extension => "extensions",
            Self::Prompt => "prompts",
        }
    }

    fn directory_name(self) -> &'static str {
        self.settings_key()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiResourceInfo {
    kind: String,
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
    argument_hint: Option<String>,
    shadowed_by: Option<String>,
}

#[derive(Clone)]
struct ResourceCandidate {
    path: PathBuf,
    source_dir: String,
    scope: String,
    origin: String,
    package_name: Option<String>,
    enabled: bool,
}

#[derive(Default)]
struct ParsedResource {
    name: String,
    description: String,
    valid: bool,
    warning: Option<String>,
    argument_hint: Option<String>,
}

enum ManifestEntries {
    Missing,
    Invalid,
    Entries(Vec<String>),
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

fn read_settings(path: &Path, kind: ResourceKind) -> Result<Option<Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = read_limited(path, MAX_SETTINGS_BYTES)?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("{}: невалидный JSON: {error}", path.display()))?;
    if !value.is_object() {
        return Err(format!("{}: корень должен быть объектом", path.display()));
    }
    let key = kind.settings_key();
    if let Some(entries) = value.get(key) {
        validate_string_array(entries, key, path)?;
    }
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
            if let Some(entries) = object.get(key) {
                validate_string_array(entries, &format!("package.{key}"), path)?;
            }
        }
    }
    Ok(Some(value))
}

fn has_trust_requiring_project_resources(cwd: &Path, home: &Path) -> bool {
    let project_config = cwd.join(".pi");
    if [
        "settings.json",
        "extensions",
        "skills",
        "prompts",
        "themes",
        "SYSTEM.md",
        "APPEND_SYSTEM.md",
    ]
    .iter()
    .any(|entry| project_config.join(entry).exists())
    {
        return true;
    }
    let user_agents = home
        .join(".agents/skills")
        .canonicalize()
        .unwrap_or_else(|_| home.join(".agents/skills"));
    let mut current = cwd
        .canonicalize()
        .unwrap_or_else(|_| normalize_lexical(cwd.to_path_buf()));
    loop {
        let agents = current.join(".agents/skills");
        let canonical = agents.canonicalize().unwrap_or_else(|_| agents.clone());
        if canonical != user_agents && agents.exists() {
            return true;
        }
        let Some(parent) = current.parent() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent.to_path_buf();
    }
    false
}

pub(crate) fn project_is_trusted(
    agent_root: &Path,
    cwd: &Path,
    home: &Path,
    global_settings: Option<&Value>,
) -> Result<bool, String> {
    if !has_trust_requiring_project_resources(cwd, home) {
        return Ok(true);
    }
    let trust_path = agent_root.join("trust.json");
    if trust_path.exists() {
        let bytes = read_limited(&trust_path, MAX_SETTINGS_BYTES)?;
        let trust: Value = serde_json::from_slice(&bytes)
            .map_err(|error| format!("{}: невалидный JSON: {error}", trust_path.display()))?;
        let entries = trust
            .as_object()
            .ok_or_else(|| format!("{}: корень должен быть объектом", trust_path.display()))?;
        if entries
            .values()
            .any(|value| !value.is_boolean() && !value.is_null())
        {
            return Err(format!(
                "{}: решения trust должны быть boolean или null",
                trust_path.display()
            ));
        }
        let mut current = cwd
            .canonicalize()
            .unwrap_or_else(|_| normalize_lexical(cwd.to_path_buf()));
        loop {
            if let Some(decision) = entries
                .get(&current.to_string_lossy().into_owned())
                .and_then(Value::as_bool)
            {
                return Ok(decision);
            }
            let Some(parent) = current.parent() else {
                break;
            };
            if parent == current {
                break;
            }
            current = parent.to_path_buf();
        }
    }
    Ok(global_settings
        .and_then(|settings| settings.get("defaultProjectTrust"))
        .and_then(Value::as_str)
        .is_some_and(|decision| decision == "always"))
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

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn is_pattern(value: &str) -> bool {
    value.starts_with(['!', '+', '-']) || value.contains(['*', '?'])
}

fn has_glob(value: &str) -> bool {
    value.contains(['*', '?'])
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
    if exact {
        let normalized = pattern
            .strip_prefix("./")
            .or_else(|| pattern.strip_prefix(".\\"))
            .unwrap_or(pattern)
            .replace('\\', "/");
        return [relative.as_str(), absolute.as_str()].contains(&normalized.as_str());
    }
    let normalized = pattern.replace('\\', "/");
    glob::Pattern::new(&normalized).is_ok_and(|pattern| {
        [relative.as_str(), name.as_str(), absolute.as_str()]
            .iter()
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

fn walk_files(root: &Path, recursive: bool, extension: &str, visited: &mut usize) -> Vec<PathBuf> {
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
    if !recursive {
        builder.max_depth(Some(1));
    }
    let mut paths = Vec::new();
    for entry in builder.build().flatten() {
        if *visited >= MAX_SCAN_ENTRIES {
            break;
        }
        *visited += 1;
        let path = entry.path();
        if path == root || !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        if path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value == extension)
        {
            paths.push(path.to_path_buf());
        }
    }
    paths.sort();
    paths
}

fn manifest(package_root: &Path) -> Option<Value> {
    read_json_limited(&package_root.join("package.json"), MAX_MANIFEST_BYTES)?
        .get("pi")
        .cloned()
}

fn manifest_entries(manifest: &Value, kind: ResourceKind) -> ManifestEntries {
    let Some(entries) = manifest.get(kind.settings_key()) else {
        return ManifestEntries::Missing;
    };
    let Some(entries) = entries.as_array() else {
        return ManifestEntries::Invalid;
    };
    if entries.iter().any(|entry| !entry.is_string()) {
        return ManifestEntries::Invalid;
    }
    ManifestEntries::Entries(
        entries
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
    )
}

fn resolve_extension_entries(directory: &Path, visited: &mut usize) -> Option<Vec<PathBuf>> {
    if *visited >= MAX_SCAN_ENTRIES {
        return Some(Vec::new());
    }
    let package_json = directory.join("package.json");
    if package_json.is_file() {
        *visited += 1;
        if let Some(pi) = manifest(directory) {
            match manifest_entries(&pi, ResourceKind::Extension) {
                ManifestEntries::Entries(entries) if !entries.is_empty() => {
                    let mut resolved = entries
                        .iter()
                        .take(MAX_SCAN_ENTRIES.saturating_sub(*visited).min(MAX_RESOURCES))
                        .map(|entry| normalize_lexical(directory.join(entry)))
                        .filter(|path| path.exists())
                        .collect::<Vec<_>>();
                    resolved.sort();
                    if !resolved.is_empty() {
                        return Some(resolved);
                    }
                }
                ManifestEntries::Invalid => return Some(Vec::new()),
                _ => {}
            }
        }
    }
    for filename in ["index.ts", "index.js"] {
        let path = directory.join(filename);
        if path.is_file() {
            *visited += 1;
            return Some(vec![path]);
        }
    }
    None
}

fn auto_extension_paths(directory: &Path, visited: &mut usize) -> Vec<PathBuf> {
    if !directory.is_dir() || *visited >= MAX_SCAN_ENTRIES {
        return Vec::new();
    }
    if let Some(paths) = resolve_extension_entries(directory, visited) {
        return paths;
    }
    let mut builder = WalkBuilder::new(directory);
    builder
        .hidden(true)
        .parents(false)
        .git_global(false)
        .git_exclude(false)
        .follow_links(true)
        .max_depth(Some(1))
        .add_custom_ignore_filename(".fdignore")
        .filter_entry(|entry| entry.file_name() != "node_modules");
    let mut paths = Vec::new();
    for entry in builder.build().flatten() {
        if *visited >= MAX_SCAN_ENTRIES {
            break;
        }
        *visited += 1;
        let path = entry.path();
        if path == directory {
            continue;
        }
        if entry.file_type().is_some_and(|kind| kind.is_file())
            && path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value == "ts" || value == "js")
        {
            paths.push(path.to_path_buf());
        } else if entry.file_type().is_some_and(|kind| kind.is_dir()) {
            if let Some(resolved) = resolve_extension_entries(path, visited) {
                paths.extend(resolved);
            }
        }
    }
    paths.sort();
    paths
}

fn collect_resource_path(path: &Path, kind: ResourceKind, visited: &mut usize) -> Vec<PathBuf> {
    if *visited >= MAX_SCAN_ENTRIES {
        return Vec::new();
    }
    if path.is_file() {
        *visited += 1;
        return vec![path.to_path_buf()];
    }
    if !path.is_dir() {
        return Vec::new();
    }
    match kind {
        ResourceKind::Extension => auto_extension_paths(path, visited),
        ResourceKind::Prompt => walk_files(path, true, "md", visited),
    }
}

fn collect_manifest_paths(
    entries: &[String],
    package_root: &Path,
    kind: ResourceKind,
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
            glob::glob(&expanded.to_string_lossy())
                .ok()
                .into_iter()
                .flatten()
                .flatten()
                .take(
                    MAX_SCAN_ENTRIES
                        .saturating_sub(*visited)
                        .min(MAX_RESOURCES.saturating_sub(paths.len())),
                )
                .collect::<Vec<_>>()
        } else {
            vec![expanded]
        };
        for resolved in resolved {
            paths.extend(collect_resource_path(&resolved, kind, visited));
            if paths.len() >= MAX_RESOURCES {
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

fn convention_paths(package_root: &Path, kind: ResourceKind, visited: &mut usize) -> Vec<PathBuf> {
    collect_resource_path(&package_root.join(kind.directory_name()), kind, visited)
}

fn package_resource_paths(
    package_root: &Path,
    filter_present: bool,
    object_package: bool,
    kind: ResourceKind,
    visited: &mut usize,
) -> Vec<PathBuf> {
    let pi = manifest(package_root);
    let declaration = pi
        .as_ref()
        .map(|value| manifest_entries(value, kind))
        .unwrap_or(ManifestEntries::Missing);
    if matches!(declaration, ManifestEntries::Invalid) {
        return Vec::new();
    }
    if filter_present {
        if let ManifestEntries::Entries(entries) = &declaration {
            if !entries.is_empty() {
                return collect_manifest_paths(entries, package_root, kind, visited);
            }
        }
        return convention_paths(package_root, kind, visited);
    }
    if pi.is_some() {
        if let ManifestEntries::Entries(entries) = &declaration {
            return collect_manifest_paths(entries, package_root, kind, visited);
        }
        if !object_package {
            return Vec::new();
        }
    }
    convention_paths(package_root, kind, visited)
}

fn add_package_candidates(
    global_root: &Path,
    project_root: Option<&Path>,
    global_settings: Option<&Value>,
    project_settings: Option<&Value>,
    kind: ResourceKind,
    candidates: &mut Vec<ResourceCandidate>,
    visited: &mut usize,
) {
    let global = configured_packages(global_root, global_settings, false);
    let project = project_root
        .map(|root| configured_packages(root, project_settings, true))
        .unwrap_or_default();
    let packages = dedupe_configured_packages(project, &global);
    let key = kind.settings_key();

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
            .and_then(|spec| spec.get(key))
            .map(|value| string_array(Some(value)));
        let paths = package_resource_paths(
            &package_root,
            filter.is_some(),
            package.spec.is_object(),
            kind,
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
                candidates.push(ResourceCandidate {
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
            candidates.push(ResourceCandidate {
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
    kind: ResourceKind,
    candidates: &mut Vec<ResourceCandidate>,
    visited: &mut usize,
) {
    let configured = string_array(settings.and_then(|settings| settings.get(kind.settings_key())));
    let mut discovered = Vec::new();
    for entry in configured.iter().filter(|entry| !is_pattern(entry)) {
        if discovered.len() >= MAX_RESOURCES || *visited >= MAX_SCAN_ENTRIES {
            break;
        }
        let Some(path) = expand_path(entry, root, home) else {
            continue;
        };
        for path in collect_resource_path(&path, kind, visited) {
            discovered.push((path, entry.clone()));
            if discovered.len() >= MAX_RESOURCES {
                break;
            }
        }
    }
    let paths = discovered
        .iter()
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();
    let patterns = configured
        .iter()
        .filter(|entry| is_pattern(entry))
        .cloned()
        .collect::<Vec<_>>();
    let enabled = enabled_by_patterns(&paths, &patterns, root);
    for (path, source) in discovered {
        candidates.push(ResourceCandidate {
            enabled: enabled.contains(&path),
            path,
            source_dir: source,
            scope: scope.into(),
            origin: "configured".into(),
            package_name: None,
        });
    }
}

fn add_auto_candidates(
    root: &Path,
    scope: &str,
    settings: Option<&Value>,
    kind: ResourceKind,
    candidates: &mut Vec<ResourceCandidate>,
    visited: &mut usize,
) {
    let directory = root.join(kind.directory_name());
    let overrides = string_array(settings.and_then(|settings| settings.get(kind.settings_key())));
    let paths = match kind {
        ResourceKind::Extension => auto_extension_paths(&directory, visited),
        ResourceKind::Prompt => walk_files(&directory, false, "md", visited),
    };
    for path in paths {
        candidates.push(ResourceCandidate {
            enabled: enabled_by_overrides(&path, &overrides, root),
            path,
            source_dir: directory.to_string_lossy().into_owned(),
            scope: scope.into(),
            origin: "auto".into(),
            package_name: None,
        });
    }
}

fn precedence(candidate: &ResourceCandidate) -> usize {
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

fn extension_name(path: &Path) -> String {
    let stem = path
        .file_stem()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    if stem == "index" {
        return path
            .parent()
            .and_then(Path::file_name)
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or(stem);
    }
    stem
}

fn parse_prompt(path: &Path) -> ParsedResource {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().trim_end_matches(".md").to_string())
        .unwrap_or_default();
    if path.extension().and_then(|value| value.to_str()) != Some("md") {
        return ParsedResource {
            name,
            warning: Some("Pi загрузит prompt template только из .md файла".into()),
            ..ParsedResource::default()
        };
    }
    let bytes = match read_limited(path, MAX_PROMPT_BYTES) {
        Ok(bytes) => bytes,
        Err(error) => {
            return ParsedResource {
                name,
                warning: Some(error),
                ..ParsedResource::default()
            }
        }
    };
    let content = match String::from_utf8(bytes) {
        Ok(content) => content.replace("\r\n", "\n").replace('\r', "\n"),
        Err(error) => {
            return ParsedResource {
                name,
                warning: Some(format!("prompt не UTF-8: {error}")),
                ..ParsedResource::default()
            }
        }
    };
    let (frontmatter, body) = if content.starts_with("---") {
        match content
            .get(3..)
            .and_then(|tail| tail.find("\n---").map(|offset| offset + 3))
        {
            Some(end) => {
                let yaml = content.get(4..end).unwrap_or_default();
                let parsed = match serde_yaml::from_str::<YamlValue>(yaml) {
                    Ok(YamlValue::Mapping(mapping)) => mapping,
                    Ok(_) => serde_yaml::Mapping::new(),
                    Err(error) => {
                        return ParsedResource {
                            name,
                            warning: Some(format!("невалидный YAML frontmatter: {error}")),
                            ..ParsedResource::default()
                        }
                    }
                };
                (
                    parsed,
                    content
                        .get(end + 4..)
                        .unwrap_or_default()
                        .trim()
                        .to_string(),
                )
            }
            None => (serde_yaml::Mapping::new(), content),
        }
    } else {
        (serde_yaml::Mapping::new(), content)
    };
    let string_field = |key: &str| {
        frontmatter
            .get(YamlValue::String(key.into()))
            .and_then(YamlValue::as_str)
            .map(str::to_string)
    };
    let description = string_field("description").unwrap_or_else(|| {
        let first = body
            .lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("");
        let truncated = first.chars().take(60).collect::<String>();
        if first.chars().count() > 60 {
            format!("{truncated}...")
        } else {
            truncated
        }
    });
    ParsedResource {
        name,
        description,
        valid: true,
        warning: None,
        argument_hint: string_field("argument-hint"),
    }
}

fn parsed_resource(path: &Path, kind: ResourceKind) -> ParsedResource {
    match kind {
        ResourceKind::Extension => ParsedResource {
            name: extension_name(path),
            description: if path.is_dir() {
                "Extension package entry point".into()
            } else {
                "Extension entry point".into()
            },
            valid: path.exists(),
            warning: (!path.exists()).then(|| "extension entry point не существует".into()),
            argument_hint: None,
        },
        ResourceKind::Prompt => parse_prompt(path),
    }
}

fn finalize_candidates(
    mut candidates: Vec<ResourceCandidate>,
    kind: ResourceKind,
) -> Vec<PiResourceInfo> {
    candidates.sort_by_key(precedence);
    let mut seen = HashSet::new();
    let mut prompt_names: HashMap<String, String> = HashMap::new();
    let mut out = Vec::new();
    for candidate in candidates {
        let identity = candidate
            .path
            .canonicalize()
            .unwrap_or_else(|_| candidate.path.clone());
        if !seen.insert(identity) {
            continue;
        }
        let mut parsed = parsed_resource(&candidate.path, kind);
        let shadowed_by = if kind == ResourceKind::Prompt && candidate.enabled && parsed.valid {
            if let Some(winner) = prompt_names.get(&parsed.name) {
                Some(winner.clone())
            } else {
                prompt_names.insert(
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
        out.push(PiResourceInfo {
            kind: kind.settings_key().trim_end_matches('s').into(),
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
            argument_hint: parsed.argument_hint,
            shadowed_by,
        });
        if out.len() >= MAX_RESOURCES {
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

fn list_resources_in(
    agent_root: &Path,
    cwd: Option<&Path>,
    home: &Path,
    kind: ResourceKind,
) -> Result<Vec<PiResourceInfo>, String> {
    let global_settings = read_settings(&agent_root.join("settings.json"), kind)?;
    let project_trusted = cwd
        .map(|cwd| project_is_trusted(agent_root, cwd, home, global_settings.as_ref()))
        .transpose()?
        .unwrap_or(false);
    let project_root = cwd.filter(|_| project_trusted).map(|cwd| cwd.join(".pi"));
    let project_settings = project_root
        .as_deref()
        .map(|root| read_settings(&root.join("settings.json"), kind))
        .transpose()?
        .flatten();
    let mut candidates = Vec::new();
    let mut visited = 0usize;

    add_package_candidates(
        agent_root,
        project_root.as_deref(),
        global_settings.as_ref(),
        project_settings.as_ref(),
        kind,
        &mut candidates,
        &mut visited,
    );
    if let Some(project_root) = project_root.as_deref() {
        add_configured_candidates(
            project_root,
            "project",
            project_settings.as_ref(),
            home,
            kind,
            &mut candidates,
            &mut visited,
        );
    }
    add_configured_candidates(
        agent_root,
        "global",
        global_settings.as_ref(),
        home,
        kind,
        &mut candidates,
        &mut visited,
    );
    if let Some(project_root) = project_root.as_deref() {
        add_auto_candidates(
            project_root,
            "project",
            project_settings.as_ref(),
            kind,
            &mut candidates,
            &mut visited,
        );
    }
    add_auto_candidates(
        agent_root,
        "global",
        global_settings.as_ref(),
        kind,
        &mut candidates,
        &mut visited,
    );

    if visited >= MAX_SCAN_ENTRIES {
        return Err(format!(
            "discovery {} остановлен после {MAX_SCAN_ENTRIES} файлов; сократите configured/package paths",
            kind.settings_key()
        ));
    }
    Ok(finalize_candidates(candidates, kind))
}

#[tauri::command]
pub fn list_pi_resources(kind: String, cwd: Option<String>) -> Result<Vec<PiResourceInfo>, String> {
    let kind = ResourceKind::parse(&kind)?;
    let home = dirs::home_dir().ok_or("не удалось определить домашний каталог")?;
    list_resources_in(&agent_dir(), cwd.as_deref().map(Path::new), &home, kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn trust(agent: &Path, project: &Path) {
        let project = project.canonicalize().unwrap();
        write(
            &agent.join("trust.json"),
            &format!(
                "{{{}:true}}",
                serde_json::to_string(&project.to_string_lossy()).unwrap()
            ),
        );
    }

    fn find<'a>(resources: &'a [PiResourceInfo], suffix: &str) -> &'a PiResourceInfo {
        resources
            .iter()
            .find(|resource| resource.path.ends_with(suffix))
            .unwrap()
    }

    #[test]
    fn resolves_configured_and_auto_extensions_with_pi_discovery_rules() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let agent = home.join(".pi/agent");
        let project = tmp.path().join("repo");
        write(&agent.join("manual/first.ts"), "export default () => {}");
        write(&agent.join("extensions/root.js"), "export default () => {}");
        write(
            &agent.join("extensions/nested/index.ts"),
            "export default () => {}",
        );
        write(
            &agent.join("extensions/deep/no-index.ts"),
            "export default () => {}",
        );
        write(
            &project.join(".pi/extensions/project/index.js"),
            "export default () => {}",
        );
        write(
            &agent.join("settings.json"),
            r#"{"extensions":["manual","-extensions/root.js"]}"#,
        );
        trust(&agent, &project);

        let resources =
            list_resources_in(&agent, Some(&project), &home, ResourceKind::Extension).unwrap();
        assert_eq!(resources.len(), 4);
        assert!(!find(&resources, "extensions/root.js").enabled);
        assert!(find(&resources, "manual/first.ts").enabled);
        assert!(find(&resources, "extensions/nested/index.ts").enabled);
        assert!(find(&resources, ".pi/extensions/project/index.js").enabled);
        assert!(resources
            .iter()
            .all(|resource| !resource.path.ends_with("deep/no-index.ts")));
    }

    #[test]
    fn package_manifests_filters_and_project_delta_match_pi() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let agent = home.join(".pi/agent");
        let project = tmp.path().join("repo");
        let package = agent.join("npm/node_modules/demo");
        write(&package.join("ext/on.ts"), "export default () => {}");
        write(&package.join("ext/off.ts"), "export default () => {}");
        write(
            &package.join("package.json"),
            r#"{"name":"demo","pi":{"extensions":["ext/*.ts"]}}"#,
        );
        write(&agent.join("settings.json"), r#"{"packages":["npm:demo"]}"#);
        write(
            &project.join(".pi/settings.json"),
            r#"{"packages":[{"source":"npm:demo","autoload":false,"extensions":["-ext/off.ts"]}]}"#,
        );
        trust(&agent, &project);

        let resources =
            list_resources_in(&agent, Some(&project), &home, ResourceKind::Extension).unwrap();
        assert_eq!(resources.len(), 2);
        assert!(find(&resources, "ext/on.ts").enabled);
        assert_eq!(find(&resources, "ext/on.ts").scope, "global");
        assert!(!find(&resources, "ext/off.ts").enabled);
        assert_eq!(find(&resources, "ext/off.ts").scope, "project");
    }

    #[test]
    fn prompts_are_non_recursive_for_auto_but_recursive_for_configured_and_report_collisions() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let agent = home.join(".pi/agent");
        let project = tmp.path().join("repo");
        write(
            &project.join(".pi/configured/release.md"),
            "---\ndescription: Project release\nargument-hint: <tag>\n---\nShip $1",
        );
        write(
            &agent.join("prompts/release.md"),
            "# Global collision winner only without project",
        );
        write(
            &agent.join("prompts/nested/hidden.md"),
            "Auto prompts are flat",
        );
        write(
            &project.join(".pi/settings.json"),
            r#"{"prompts":["configured"]}"#,
        );
        trust(&agent, &project);

        let resources =
            list_resources_in(&agent, Some(&project), &home, ResourceKind::Prompt).unwrap();
        assert_eq!(resources.len(), 2);
        let project_prompt = resources
            .iter()
            .find(|resource| resource.scope == "project")
            .unwrap();
        let global_prompt = resources
            .iter()
            .find(|resource| resource.scope == "global")
            .unwrap();
        assert_eq!(project_prompt.description, "Project release");
        assert_eq!(project_prompt.argument_hint.as_deref(), Some("<tag>"));
        assert_eq!(
            global_prompt.shadowed_by.as_deref(),
            Some(project_prompt.path.as_str())
        );
        assert!(resources
            .iter()
            .all(|resource| !resource.path.ends_with("nested/hidden.md")));
    }

    #[test]
    fn malformed_settings_and_prompt_frontmatter_fail_closed() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let agent = home.join(".pi/agent");
        write(&agent.join("settings.json"), r#"{"prompts":"oops"}"#);
        assert!(list_resources_in(&agent, None, &home, ResourceKind::Prompt)
            .unwrap_err()
            .contains("prompts должен быть массивом"));

        write(&agent.join("settings.json"), "{}");
        write(
            &agent.join("prompts/broken.md"),
            "---\ndescription: [unterminated\n---\nbody",
        );
        let resources = list_resources_in(&agent, None, &home, ResourceKind::Prompt).unwrap();
        assert_eq!(resources.len(), 1);
        assert!(!resources[0].valid);
        assert!(resources[0]
            .warning
            .as_deref()
            .unwrap()
            .contains("невалидный YAML"));
    }

    #[test]
    fn untrusted_project_resources_are_not_reported_as_effective() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let agent = home.join(".pi/agent");
        let project = tmp.path().join("repo");
        write(
            &project.join(".pi/extensions/untrusted/index.ts"),
            "export default () => {}",
        );
        write(&project.join(".pi/settings.json"), "{}");
        write(&agent.join("settings.json"), "{}");

        let resources =
            list_resources_in(&agent, Some(&project), &home, ResourceKind::Extension).unwrap();
        assert!(resources.is_empty());

        write(
            &agent.join("settings.json"),
            r#"{"defaultProjectTrust":"always"}"#,
        );
        let resources =
            list_resources_in(&agent, Some(&project), &home, ResourceKind::Extension).unwrap();
        assert_eq!(resources.len(), 1);
        assert_eq!(resources[0].scope, "project");
    }

    #[test]
    #[ignore = "requires the user's installed Pi packages and settings"]
    fn live_extension_surface_matches_installed_pi() {
        let cwd = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let resources =
            list_pi_resources("extension".into(), Some(cwd.to_string_lossy().into_owned()))
                .unwrap();
        let enabled = resources
            .iter()
            .filter(|resource| resource.enabled && resource.valid)
            .collect::<Vec<_>>();
        assert_eq!(enabled.len(), 15);
        let expected_suffixes = [
            "pi-mcp-adapter/index.ts",
            "@juicesharp/rpiv-todo/index.ts",
            "@juicesharp/rpiv-ask-user-question/index.ts",
            "@gotgenes/pi-permission-system/src/index.ts",
            "pi-claude-style-tools/extensions/index.ts",
            "pi-claude-style-tools/extensions/spinner.ts",
            "@narumitw/pi-retry/src/retry.ts",
            "@narumitw/pi-statusline/src/statusline.ts",
            "@plannotator/pi-extension",
            "pi-app/harness-extension/index.ts",
            "pi-web-access/index.ts",
            "@tintinweb/pi-subagents/src/index.ts",
            "DietrichGebert/ponytail/pi-extension/index.js",
            "pi-chrome/extensions/chrome-profile-bridge/index.ts",
            "pi-agent-browser-native/dist/extensions/agent-browser/index.js",
        ];
        for suffix in expected_suffixes {
            assert!(
                enabled
                    .iter()
                    .any(|resource| resource.path.ends_with(suffix)),
                "missing resolved extension {suffix}"
            );
        }
        assert!(enabled
            .iter()
            .all(|resource| Path::new(&resource.path).exists()));
        let prompts =
            list_pi_resources("prompt".into(), Some(cwd.to_string_lossy().into_owned())).unwrap();
        assert!(
            prompts
                .iter()
                .all(|resource| !resource.enabled || !resource.valid),
            "installed Pi surface currently resolves no active prompts"
        );
    }
}
