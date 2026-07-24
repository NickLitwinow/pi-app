// Marketplace backend: pi.dev community packages are npm packages tagged with
// the `pi-package` keyword plus a type keyword (`pi-extension`, `pi-skill`,
// `pi-theme`, `pi-prompt`). We query the public npm registry search API — the
// same data source pi.dev's catalog is built from — via system curl, matching
// probe_url's approach (no HTTP/TLS stack pulled into the binary).

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;
use tokio::task::JoinSet;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiPackage {
    /// Exact settings.json spec for installed rows. Catalog rows have no source.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub downloads_monthly: u64,
    pub npm_url: String,
    pub repo_url: Option<String>,
    pub homepage: Option<String>,
    pub keywords: Vec<String>,
    pub updated: Option<String>,
    /// npm score popularity 0..1 (для сортировки/бейджей).
    pub popularity: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    pub update_available: bool,
    pub pinned: bool,
    /// Resource kinds exposed by the installed manifest or conventional
    /// resource directories. None means discovery was inconclusive; Some([])
    /// is a known package that exposes no Pi resources.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_kinds: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSearch {
    pub total: u64,
    pub objects: Vec<PiPackage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageDetails {
    pub readme: Option<String>,
    pub changelog: Option<String>,
}

async fn fetch_package_markdown(url: String) -> Option<String> {
    let out = Command::new("/usr/bin/curl")
        .args([
            "-s",
            "--fail",
            "--compressed",
            "--max-time",
            "12",
            "--max-filesize",
            "524288",
            &url,
        ])
        .stdin(Stdio::null())
        .output()
        .await
        .ok()?;
    if !out.status.success() || out.stdout.is_empty() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?;
    Some(text.chars().take(60_000).collect())
}

/// README and changelog shipped in the latest npm tarball. Fetching from
/// unpkg avoids downloading the complete registry history for popular packages.
#[tauri::command]
pub async fn pi_package_details(name: String) -> Result<PackageDetails, String> {
    let (name, _) =
        npm_name_and_pin(&name).ok_or_else(|| "некорректное имя npm-пакета".to_string())?;
    let encoded = name.replace('@', "%40").replace('/', "%2F");
    let base = format!("https://unpkg.com/{encoded}@latest");
    let (readme, changelog) = tokio::join!(
        fetch_package_markdown(format!("{base}/README.md")),
        fetch_package_markdown(format!("{base}/CHANGELOG.md")),
    );
    Ok(PackageDetails { readme, changelog })
}

/// Map a marketplace tab to the npm keyword pi.dev filters by.
fn keyword_for(kind: &str) -> &'static str {
    match kind {
        "skill" => "pi-skill",
        "theme" => "pi-theme",
        "prompt" => "pi-prompt",
        _ => "pi-extension",
    }
}

/// Percent-encode a search-query fragment (spaces and reserved chars) so the
/// npm `text` parameter stays a single well-formed value.
fn encode_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn as_str(v: &Value, ptr: &str) -> Option<String> {
    v.pointer(ptr)
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

fn parse_object(o: &Value) -> Option<PiPackage> {
    let pkg = o.get("package")?;
    let name = pkg.get("name")?.as_str()?.to_string();
    let author = as_str(pkg, "/publisher/username")
        .or_else(|| {
            pkg.pointer("/maintainers/0/username")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_default();
    let keywords = pkg
        .get("keywords")
        .and_then(|k| k.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    // downloads.monthly появился недавно; на старых зеркалах может отсутствовать
    let downloads_monthly = o
        .pointer("/downloads/monthly")
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    Some(PiPackage {
        source: None,
        npm_url: as_str(pkg, "/links/npm")
            .unwrap_or_else(|| format!("https://www.npmjs.com/package/{name}")),
        // npm отдаёт repository как git+https://…​.git — нормализуем, иначе open не откроет
        repo_url: as_str(pkg, "/links/repository").and_then(|s| clean_git_url(&s)),
        homepage: as_str(pkg, "/links/homepage"),
        version: pkg
            .get("version")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        description: pkg
            .get("description")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        updated: o
            .get("updated")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        popularity: o
            .pointer("/score/detail/popularity")
            .and_then(|x| x.as_f64())
            .unwrap_or(0.0),
        name,
        author,
        downloads_monthly,
        keywords,
        installed_version: None,
        update_available: false,
        pinned: false,
        resource_kinds: None,
    })
}

/// Search pi.dev community packages of a given kind (extension/skill/theme/prompt)
/// via the npm registry. `query` narrows by free text; `from`/`size` paginate.
#[tauri::command]
pub async fn search_pi_packages(
    kind: String,
    query: String,
    from: usize,
    size: usize,
) -> Result<PackageSearch, String> {
    let keyword = keyword_for(&kind);
    let size = size.clamp(1, 100);
    let text = if query.trim().is_empty() {
        format!("keywords:{keyword}")
    } else {
        format!("keywords:{keyword} {}", query.trim())
    };
    let url = format!(
        "https://registry.npmjs.org/-/v1/search?text={}&size={}&from={}",
        encode_query(&text),
        size,
        from
    );

    let out = Command::new("/usr/bin/curl")
        .args([
            "-s",
            "--compressed",
            "--max-time",
            "15",
            "--max-filesize",
            "4194304",
            &url,
        ])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("не удалось связаться с реестром npm".into());
    }
    let body = String::from_utf8_lossy(&out.stdout);
    let v: Value =
        serde_json::from_str(&body).map_err(|e| format!("невалидный ответ реестра: {e}"))?;
    let total = v.get("total").and_then(|t| t.as_u64()).unwrap_or(0);
    let objects = v
        .get("objects")
        .and_then(|o| o.as_array())
        .map(|arr| arr.iter().filter_map(parse_object).collect())
        .unwrap_or_default();
    Ok(PackageSearch { total, objects })
}

/// Привести git-URL пакета к открываемому в браузере https-виду. npm отдаёт
/// `repository` как `git+https://…​.git`, `git://…`, `git@github.com:…` — такие
/// схемы система open/браузер не откроют, поэтому нормализуем в https.
fn clean_git_url(raw: &str) -> Option<String> {
    let cleaned = raw
        .trim()
        .trim_start_matches("git+")
        .trim_end_matches(".git")
        .replace("git://", "https://")
        .replace("git@github.com:", "https://github.com/")
        .replace("ssh://git@github.com/", "https://github.com/");
    // открываем только http(s) — прочие схемы (напр. нераспарсенный git@) отбрасываем
    if cleaned.starts_with("http://") || cleaned.starts_with("https://") {
        Some(cleaned)
    } else {
        None
    }
}

/// Repository URL из документа версии npm (строка или `{ "url": "git+https://…" }`).
fn clean_repo(v: &Value, key: &str) -> Option<String> {
    let raw = match v.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(o)) => o.get("url").and_then(|u| u.as_str())?.to_string(),
        _ => return None,
    };
    clean_git_url(&raw)
}

/// Fetch metadata for one installed package spec (npm:name / bare name; git specs
/// are skipped) from the npm registry's per-version document.
async fn fetch_one(spec: String) -> Option<PiPackage> {
    let (name, _) = npm_name_and_pin(&spec)?;
    // git/URL/tarball specs не резолвим через реестр
    if name.contains("://") || name.contains(':') || name.starts_with('.') || name.is_empty() {
        return None;
    }
    let enc = name.replace('/', "%2F");
    let url = format!("https://registry.npmjs.org/{enc}/latest");
    let out = Command::new("/usr/bin/curl")
        .args([
            "-s",
            "--compressed",
            "--max-time",
            "12",
            "--max-filesize",
            "2097152",
            &url,
        ])
        .stdin(Stdio::null())
        .output()
        .await
        .ok()?;
    let v: Value = serde_json::from_slice(&out.stdout).ok()?;
    let name = v.get("name")?.as_str()?.to_string();
    let author = v
        .pointer("/author/name")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("author").and_then(|a| a.as_str()))
        .unwrap_or_default()
        .to_string();
    let keywords = v
        .get("keywords")
        .and_then(|k| k.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    Some(PiPackage {
        source: None,
        npm_url: format!("https://www.npmjs.com/package/{name}"),
        repo_url: clean_repo(&v, "repository"),
        homepage: v
            .get("homepage")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        version: v
            .get("version")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        description: v
            .get("description")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        updated: None,
        popularity: 0.0,
        downloads_monthly: 0,
        name,
        author,
        keywords,
        installed_version: None,
        update_available: false,
        pinned: false,
        resource_kinds: None,
    })
}

fn npm_name_and_pin(spec: &str) -> Option<(String, bool)> {
    let raw = spec.strip_prefix("npm:").unwrap_or(spec).trim();
    if raw.is_empty() || raw.contains("://") || raw.starts_with('.') {
        return None;
    }
    let version_at = if raw.starts_with('@') {
        raw.find('/')
            .and_then(|slash| raw[slash + 1..].find('@').map(|at| slash + 1 + at))
    } else {
        raw.find('@')
    };
    let (name, pinned) = version_at
        .map(|at| (&raw[..at], true))
        .unwrap_or((raw, false));
    let parts: Vec<&str> = name.split('/').collect();
    let valid = if name.starts_with('@') {
        parts.len() == 2 && parts[0].len() > 1
    } else {
        parts.len() == 1
    } && parts
        .iter()
        .all(|part| !part.is_empty() && *part != "." && *part != ".." && !part.contains('\\'));
    if !valid {
        return None;
    }
    Some((name.to_string(), pinned))
}

fn installed_version(root: &Path, name: &str) -> Option<String> {
    let package_json = package_dir_for_root(root, &format!("npm:{name}"))?.join("package.json");
    let text = std::fs::read_to_string(package_json).ok()?;
    serde_json::from_str::<Value>(&text)
        .ok()?
        .get("version")?
        .as_str()
        .map(str::to_string)
}

fn clean_package_spec_path(raw: &str) -> &str {
    raw.split(['?', '#']).next().unwrap_or_default()
}

#[derive(Debug, PartialEq, Eq)]
struct GitPackageSource {
    host: String,
    path: String,
    pinned: bool,
}

/// Parse the Git source forms accepted by Pi's package manager. Settings keep
/// the original spelling, so this must cover both `git:` shorthand and direct
/// protocol URLs instead of assuming every checkout starts with `git:`.
fn git_package_source(spec: &str) -> Option<GitPackageSource> {
    let spec = spec.trim();
    let (raw, explicit_git) = spec
        .strip_prefix("git:")
        .map_or((spec, false), |raw| (raw.trim(), true));
    let protocol = ["https://", "http://", "ssh://", "git://"]
        .into_iter()
        .find(|prefix| raw.to_ascii_lowercase().starts_with(prefix));
    if !explicit_git && protocol.is_none() {
        return None;
    }

    let (host, raw_path) = if let Some(scp) = raw.strip_prefix("git@") {
        let (host, path) = scp.split_once(':')?;
        (host, path)
    } else if raw.contains("://") {
        let (_, authority_and_path) = raw.split_once("://")?;
        let (authority, path) = authority_and_path.split_once('/')?;
        let authority = authority.rsplit('@').next().unwrap_or(authority);
        let host = authority.split(':').next().unwrap_or(authority);
        (host, path)
    } else {
        raw.split_once('/')?
    };

    let fragment_pinned = raw_path
        .split_once('#')
        .is_some_and(|(_, reference)| !reference.is_empty());
    let clean = raw_path.split(['?', '#']).next().unwrap_or_default();
    let (clean, at_pinned) = clean
        .split_once('@')
        .map_or((clean, false), |(path, reference)| {
            (path, !reference.is_empty())
        });
    let path = clean.trim_matches(['/', '\\']).trim_end_matches(".git");
    let valid_host =
        !host.is_empty() && host != "." && host != ".." && !host.contains(['/', '\\', '\0']);
    let components = path.split('/').collect::<Vec<_>>();
    let valid_path = components.len() >= 2
        && components.iter().all(|part| {
            !part.is_empty() && *part != "." && *part != ".." && !part.contains(['\\', '\0'])
        });
    (valid_host && valid_path).then(|| GitPackageSource {
        host: host.to_string(),
        path: path.to_string(),
        pinned: fragment_pinned || at_pinned,
    })
}

pub(crate) fn package_dir_for_root(root: &Path, spec: &str) -> Option<PathBuf> {
    if let Some(raw) = spec.strip_prefix("npm:") {
        let (name, _) = npm_name_and_pin(raw)?;
        return Some(root.join("npm").join("node_modules").join(name));
    }
    if let Some(git) = git_package_source(spec) {
        return Some(root.join("git").join(git.host).join(git.path));
    }
    let raw = clean_package_spec_path(spec.strip_prefix("file:").unwrap_or(spec));
    let expanded = if let Some(relative) = raw.strip_prefix("~/") {
        dirs::home_dir()?.join(relative)
    } else {
        PathBuf::from(raw)
    };
    Some(if expanded.is_absolute() {
        expanded
    } else {
        root.join(expanded)
    })
}

pub(crate) fn package_identity_for_root(root: &Path, spec: &str) -> Option<String> {
    if let Some(raw) = spec.strip_prefix("npm:") {
        let (name, _) = npm_name_and_pin(raw)?;
        return Some(format!("npm:{name}"));
    }
    if let Some(git) = git_package_source(spec) {
        return Some(format!("git:{}/{}", git.host, git.path));
    }
    let path = package_dir_for_root(root, spec)?;
    let resolved = path.canonicalize().unwrap_or(path);
    Some(format!("local:{}", resolved.to_string_lossy()))
}

/// A package entry together with the settings root that gives relative local
/// sources their meaning. Resource resolvers share this because Pi applies the
/// same project-over-user package precedence to extensions, skills, prompts,
/// and themes.
#[derive(Clone)]
pub(crate) struct ConfiguredPackage {
    pub(crate) spec: Value,
    pub(crate) source: String,
    pub(crate) root: PathBuf,
    pub(crate) project: bool,
}

impl ConfiguredPackage {
    pub(crate) fn autoload_disabled(&self) -> bool {
        self.spec
            .get("autoload")
            .and_then(Value::as_bool)
            .is_some_and(|autoload| !autoload)
    }
}

pub(crate) fn configured_packages(
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

pub(crate) fn dedupe_configured_packages(
    project: Vec<ConfiguredPackage>,
    global: &[ConfiguredPackage],
) -> Vec<ConfiguredPackage> {
    let mut out = Vec::new();
    let mut indexes = HashMap::new();
    for package in project.into_iter().chain(global.iter().cloned()) {
        let Some(identity) = package_identity_for_root(&package.root, &package.source) else {
            continue;
        };
        if let Some(index) = indexes.get(&identity).copied() {
            let existing: &ConfiguredPackage = &out[index];
            // A project autoload:false entry is a delta over the matching user
            // package, so both entries must survive resolution.
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

fn read_json_limited(path: &Path) -> Option<Value> {
    let mut file = File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(256 * 1024)
        .read_to_end(&mut bytes)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn convention_has_resources(package_dir: &Path, key: &str) -> Option<bool> {
    let directory = package_dir.join(key);
    if !directory.is_dir() {
        return Some(false);
    }
    let entries = std::fs::read_dir(&directory).ok()?;
    if key == "prompts" || key == "themes" {
        let extension = if key == "prompts" { "md" } else { "json" };
        return Some(entries.flatten().any(|entry| {
            entry.path().is_file()
                && entry
                    .path()
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case(extension))
        }));
    }
    if key == "extensions" {
        return Some(entries.flatten().any(|entry| {
            let path = entry.path();
            if path.is_file() {
                return path
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| matches!(value, "ts" | "js"));
            }
            path.is_dir()
                && (path.join("index.ts").is_file()
                    || path.join("index.js").is_file()
                    || read_json_limited(&path.join("package.json"))
                        .and_then(|manifest| {
                            manifest.get("pi")?.get("extensions")?.as_array().cloned()
                        })
                        .is_some_and(|entries| !entries.is_empty()))
        }));
    }

    // Skills recurse in Pi. Bound the metadata probe so a hostile package
    // cannot turn opening Library into an unbounded filesystem walk.
    let mut pending = vec![(directory, 0usize)];
    let mut visited = 0usize;
    while let Some((directory, depth)) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > 1_000 {
                return None;
            }
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            if path.is_file()
                && (name == "SKILL.md"
                    || (depth == 0
                        && path
                            .extension()
                            .and_then(|value| value.to_str())
                            .is_some_and(|value| value.eq_ignore_ascii_case("md"))))
            {
                return Some(true);
            }
            if path.is_dir() && depth < 16 {
                pending.push((path, depth + 1));
            }
        }
    }
    Some(false)
}

fn resource_kinds_from_package(package_dir: &Path) -> Option<Vec<String>> {
    let manifest: Value = read_json_limited(&package_dir.join("package.json"))?;
    let manifest_config = manifest.get("pi").or_else(|| manifest.get("pi-package"));
    let config = manifest_config.and_then(Value::as_object);
    let mut kinds = Vec::new();
    for (key, kind) in [
        ("extensions", "extension"),
        ("skills", "skill"),
        ("themes", "theme"),
        ("prompts", "prompt"),
    ] {
        // Pi treats the presence of a `pi` manifest as authoritative for every
        // resource type. A missing key does not fall back to a same-named
        // directory, otherwise stray build/example files appear installed in
        // Library even though Pi never loads them.
        let declared = if manifest_config.is_some() {
            config
                .and_then(|config| config.get(key))
                .and_then(Value::as_array)
                .is_some_and(|entries| {
                    entries
                        .iter()
                        .any(|entry| entry.as_str().is_some_and(|entry| !entry.trim().is_empty()))
                })
        } else {
            convention_has_resources(package_dir, key)?
        };
        if declared {
            kinds.push(kind.to_string());
        }
    }
    Some(kinds)
}

fn installed_resource_kinds(root: &Path, spec: &str) -> Option<Vec<String>> {
    let directory = package_dir_for_root(root, spec)?;
    resource_kinds_from_package(&directory)
}

pub(crate) fn installed_display_name(spec: &str) -> String {
    if let Some(raw) = spec.strip_prefix("npm:") {
        return npm_name_and_pin(raw)
            .map(|(name, _)| name)
            .unwrap_or_else(|| raw.to_string());
    }
    if let Some(git) = git_package_source(spec) {
        return git.path.rsplit('/').next().unwrap_or(&git.path).to_string();
    }
    let raw = spec
        .trim()
        .strip_prefix("file:")
        .unwrap_or(spec.trim())
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .trim_end_matches(['/', '\\']);
    raw.rsplit(['/', '\\'])
        .next()
        .unwrap_or(raw)
        .strip_suffix(".git")
        .unwrap_or_else(|| raw.rsplit(['/', '\\']).next().unwrap_or(raw))
        .to_string()
}

fn installed_fallback(root: &Path, spec: &str) -> PiPackage {
    let name = installed_display_name(spec);
    let git = git_package_source(spec);
    let npm_name = spec
        .strip_prefix("npm:")
        .and_then(|raw| npm_name_and_pin(raw).map(|(name, _)| name));
    let repo_url = git
        .as_ref()
        .map(|source| format!("https://{}/{}", source.host, source.path));
    PiPackage {
        source: Some(spec.to_string()),
        name: name.clone(),
        version: String::new(),
        description: if spec.starts_with("npm:") {
            format!("Установленный npm-пакет {name}; метаданные реестра недоступны.")
        } else if git.is_some() {
            format!("Установленный Git-пакет: {spec}")
        } else {
            format!("Локальный пакет: {spec}")
        },
        author: String::new(),
        downloads_monthly: 0,
        npm_url: npm_name
            .as_deref()
            .map(|name| format!("https://www.npmjs.com/package/{name}"))
            .unwrap_or_default(),
        repo_url,
        homepage: None,
        keywords: Vec::new(),
        updated: None,
        popularity: 0.0,
        installed_version: npm_name
            .as_deref()
            .and_then(|name| installed_version(root, name)),
        update_available: false,
        pinned: git.as_ref().is_some_and(|source| source.pinned),
        resource_kinds: installed_resource_kinds(root, spec),
    }
}

async fn resolve_installed_package(root: PathBuf, spec: String) -> Option<PiPackage> {
    let Some(raw_npm) = spec.strip_prefix("npm:") else {
        return Some(installed_fallback(&root, &spec));
    };
    let Some((name, pinned)) = npm_name_and_pin(raw_npm) else {
        return Some(installed_fallback(&root, &spec));
    };
    let local = installed_version(&root, &name);
    let mut package = fetch_one(spec.clone())
        .await
        .unwrap_or_else(|| installed_fallback(&root, &spec));
    package.resource_kinds = installed_resource_kinds(&root, &spec);
    package.source = Some(spec);
    package.installed_version = local.clone();
    package.pinned = pinned;
    package.update_available = !pinned
        && local
            .as_deref()
            .is_some_and(|version| version != package.version);
    Some(package)
}

/// Resolve metadata for a list of installed package specs (from settings.json
/// `packages`) — used by the "Installed" view so it lists every installed
/// package, not just those surfaced by a catalog search. Fetched concurrently.
#[tauri::command]
pub async fn pi_packages_meta(names: Vec<String>, cwd: Option<String>) -> Vec<PiPackage> {
    const MAX_PACKAGES: usize = 500;
    const MAX_REGISTRY_FETCHES: usize = 80;
    const MAX_CONCURRENT_FETCHES: usize = 8;
    // Pi resolves project-scoped npm/git/local package sources relative to
    // <cwd>/.pi; user-scoped packages use the agent directory.
    let root = cwd
        .filter(|value| !value.trim().is_empty())
        .map(|value| PathBuf::from(value).join(".pi"))
        .unwrap_or_else(crate::sessions::agent_dir);
    // Registry enrichment is bounded, but every accepted installed entry still
    // receives local fallback metadata. Previously the 81st package vanished
    // from Library entirely, even though Pi loaded it.
    let mut remote = Vec::new();
    let mut out = Vec::new();
    for spec in names.into_iter().take(MAX_PACKAGES) {
        if spec.starts_with("npm:") && remote.len() < MAX_REGISTRY_FETCHES {
            remote.push(spec);
        } else {
            out.push(installed_fallback(&root, &spec));
        }
    }
    let mut pending = remote.into_iter();
    let mut set = JoinSet::new();
    for spec in pending.by_ref().take(MAX_CONCURRENT_FETCHES) {
        set.spawn(resolve_installed_package(root.clone(), spec));
    }
    while let Some(res) = set.join_next().await {
        if let Ok(Some(p)) = res {
            out.push(p);
        }
        if let Some(spec) = pending.next() {
            set.spawn(resolve_installed_package(root.clone(), spec));
        }
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_git_repo_urls() {
        // именно такой вид отдаёт npm search в links.repository — раньше open его не открывал
        assert_eq!(
            clean_git_url("git+https://github.com/tintinweb/pi-subagents.git").as_deref(),
            Some("https://github.com/tintinweb/pi-subagents"),
        );
        assert_eq!(
            clean_git_url("git://github.com/foo/bar.git").as_deref(),
            Some("https://github.com/foo/bar"),
        );
        assert_eq!(
            clean_git_url("git@github.com:foo/bar.git").as_deref(),
            Some("https://github.com/foo/bar"),
        );
        assert_eq!(
            clean_git_url("https://gitlab.com/x/y").as_deref(),
            Some("https://gitlab.com/x/y"),
        );
        // нераспознанные схемы не открываем
        assert_eq!(clean_git_url("git@bitbucket.org:foo/bar.git"), None);
    }

    #[test]
    fn parse_object_cleans_repository_link() {
        let o = serde_json::json!({
            "package": {
                "name": "pi-x",
                "version": "1.0.0",
                "links": { "repository": "git+https://github.com/u/pi-x.git" }
            }
        });
        let p = parse_object(&o).unwrap();
        assert_eq!(p.repo_url.as_deref(), Some("https://github.com/u/pi-x"));
    }

    #[test]
    fn parses_scoped_and_pinned_npm_specs() {
        assert_eq!(
            npm_name_and_pin("npm:pi-web-access"),
            Some(("pi-web-access".into(), false))
        );
        assert_eq!(
            npm_name_and_pin("npm:pi-web-access@1.2.3"),
            Some(("pi-web-access".into(), true))
        );
        assert_eq!(
            npm_name_and_pin("npm:@scope/pkg"),
            Some(("@scope/pkg".into(), false))
        );
        assert_eq!(
            npm_name_and_pin("npm:@scope/pkg@2.0.0"),
            Some(("@scope/pkg".into(), true))
        );
        assert_eq!(npm_name_and_pin("npm:pkg/../../outside"), None);
        assert_eq!(npm_name_and_pin("npm:@scope/../outside"), None);
        assert_eq!(npm_name_and_pin("npm:pkg\\..\\outside"), None);
    }

    #[test]
    fn installed_fallback_preserves_npm_git_and_local_sources() {
        let root = Path::new("/agent");
        let npm = installed_fallback(root, "npm:@scope/pkg@2.0.0");
        assert_eq!(npm.name, "@scope/pkg");
        assert_eq!(npm.source.as_deref(), Some("npm:@scope/pkg@2.0.0"));
        assert_eq!(npm.npm_url, "https://www.npmjs.com/package/@scope/pkg");

        let git = installed_fallback(root, "git:github.com/DietrichGebert/ponytail.git");
        assert_eq!(git.name, "ponytail");
        assert_eq!(
            git.repo_url.as_deref(),
            Some("https://github.com/DietrichGebert/ponytail")
        );

        let protocol =
            installed_fallback(root, "ssh://git@gitlab.com/owner/browser-kit.git@stable");
        assert_eq!(protocol.name, "browser-kit");
        assert_eq!(
            protocol.repo_url.as_deref(),
            Some("https://gitlab.com/owner/browser-kit")
        );
        assert!(protocol.pinned);

        let local = installed_fallback(root, "../../GithubControl/pi-app/harness-extension/");
        assert_eq!(local.name, "harness-extension");
        assert_eq!(
            local.source.as_deref(),
            Some("../../GithubControl/pi-app/harness-extension/")
        );
        assert!(local.npm_url.is_empty());
    }

    #[test]
    fn resolves_npm_git_and_local_manifest_directories() {
        let root = Path::new("/agent");
        assert_eq!(
            package_dir_for_root(root, "npm:@scope/pkg@2.0.0"),
            Some(PathBuf::from("/agent/npm/node_modules/@scope/pkg"))
        );
        assert_eq!(
            package_dir_for_root(root, "git:github.com/owner/repo.git#main"),
            Some(PathBuf::from("/agent/git/github.com/owner/repo"))
        );
        assert_eq!(
            package_dir_for_root(root, "https://github.com/owner/protocol.git@release"),
            Some(PathBuf::from("/agent/git/github.com/owner/protocol"))
        );
        assert_eq!(
            package_dir_for_root(root, "git:git@gitlab.com:owner/scp.git@main"),
            Some(PathBuf::from("/agent/git/gitlab.com/owner/scp"))
        );
        assert_eq!(
            package_dir_for_root(root, "../../workspace/custom-package"),
            Some(PathBuf::from("/agent/../../workspace/custom-package"))
        );
        assert_eq!(
            package_identity_for_root(root, "npm:@scope/pkg@2.0.0").as_deref(),
            Some("npm:@scope/pkg")
        );
        assert_eq!(
            package_identity_for_root(root, "git:github.com/owner/repo.git#main").as_deref(),
            Some("git:github.com/owner/repo")
        );
    }

    #[test]
    fn parses_only_safe_pi_git_source_forms() {
        assert_eq!(
            git_package_source("git:github.com/owner/repo.git@v2"),
            Some(GitPackageSource {
                host: "github.com".into(),
                path: "owner/repo".into(),
                pinned: true,
            })
        );
        assert_eq!(
            git_package_source("ssh://git@gitlab.com/team/repo.git#main"),
            Some(GitPackageSource {
                host: "gitlab.com".into(),
                path: "team/repo".into(),
                pinned: true,
            })
        );
        assert!(git_package_source("github.com/owner/repo").is_none());
        assert!(git_package_source("git:github.com/../outside").is_none());
        assert!(git_package_source("git:../owner/repo").is_none());
    }

    #[tokio::test]
    async fn installed_metadata_does_not_drop_packages_after_the_old_limit() {
        let project = tempfile::tempdir().unwrap();
        let names = (0..81)
            .map(|index| format!("./package-{index}"))
            .collect::<Vec<_>>();
        let packages =
            pi_packages_meta(names, Some(project.path().to_string_lossy().into_owned())).await;
        assert_eq!(packages.len(), 81);
        assert!(packages.iter().any(|package| package.name == "package-80"));
    }

    #[test]
    fn discovers_project_scoped_packages_from_the_project_pi_root() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().join(".pi");
        let package = root.join("npm/node_modules/project-skill");
        std::fs::create_dir_all(package.join("skills/review")).unwrap();
        std::fs::write(package.join("package.json"), r#"{"name":"project-skill"}"#).unwrap();
        std::fs::write(package.join("skills/review/SKILL.md"), "# Review").unwrap();

        assert_eq!(
            installed_resource_kinds(&root, "npm:project-skill"),
            Some(vec!["skill".to_string()])
        );
    }

    #[test]
    fn reads_declared_resource_kinds_from_package_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let manifest = temp.path().join("package.json");
        std::fs::write(
            &manifest,
            r#"{
                "name": "multi",
                "pi": {
                    "extensions": ["./index.ts"],
                    "skills": ["./skills"],
                    "themes": [],
                    "prompts": ["./prompts"]
                }
            }"#,
        )
        .unwrap();
        assert_eq!(
            resource_kinds_from_package(temp.path()),
            Some(vec![
                "extension".to_string(),
                "skill".to_string(),
                "prompt".to_string()
            ])
        );

        std::fs::write(&manifest, r#"{"name":"plain"}"#).unwrap();
        assert_eq!(resource_kinds_from_package(temp.path()), Some(Vec::new()));
        std::fs::write(&manifest, "{invalid").unwrap();
        assert_eq!(resource_kinds_from_package(temp.path()), None);
    }

    #[test]
    fn discovers_convention_resources_but_respects_explicit_empty_filters() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("extensions")).unwrap();
        std::fs::create_dir_all(temp.path().join("skills/review")).unwrap();
        std::fs::create_dir(temp.path().join("themes")).unwrap();
        std::fs::write(temp.path().join("extensions/index.ts"), "export default {}").unwrap();
        std::fs::write(
            temp.path().join("skills/review/SKILL.md"),
            "---\nname: review\n---",
        )
        .unwrap();
        std::fs::write(temp.path().join("themes/quiet.json"), "{}").unwrap();
        std::fs::write(temp.path().join("package.json"), r#"{"name":"convention"}"#).unwrap();
        assert_eq!(
            resource_kinds_from_package(temp.path()),
            Some(vec![
                "extension".to_string(),
                "skill".to_string(),
                "theme".to_string()
            ])
        );

        std::fs::write(
            temp.path().join("package.json"),
            r#"{"name":"filtered","pi":{"extensions":[],"skills":[],"themes":[]}}"#,
        )
        .unwrap();
        assert_eq!(resource_kinds_from_package(temp.path()), Some(Vec::new()));

        std::fs::write(
            temp.path().join("package.json"),
            r#"{"name":"manifest-wins","pi":{"extensions":["./extensions/index.ts"]}}"#,
        )
        .unwrap();
        assert_eq!(
            resource_kinds_from_package(temp.path()),
            Some(vec!["extension".to_string()])
        );
    }
}
