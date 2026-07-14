// Marketplace backend: pi.dev community packages are npm packages tagged with
// the `pi-package` keyword plus a type keyword (`pi-extension`, `pi-skill`,
// `pi-theme`, `pi-prompt`). We query the public npm registry search API — the
// same data source pi.dev's catalog is built from — via system curl, matching
// probe_url's approach (no HTTP/TLS stack pulled into the binary).

use serde::Serialize;
use serde_json::Value;
use std::process::Stdio;
use tokio::process::Command;
use tokio::task::JoinSet;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiPackage {
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
        .args(["-s", "--compressed", "--max-time", "15", &url])
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
        .args(["-s", "--compressed", "--max-time", "12", &url])
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
    Some((name.to_string(), pinned))
}

fn installed_version(name: &str) -> Option<String> {
    let package_json = crate::sessions::agent_dir()
        .join("npm")
        .join("node_modules")
        .join(name)
        .join("package.json");
    let text = std::fs::read_to_string(package_json).ok()?;
    serde_json::from_str::<Value>(&text)
        .ok()?
        .get("version")?
        .as_str()
        .map(str::to_string)
}

/// Resolve metadata for a list of installed package specs (from settings.json
/// `packages`) — used by the "Installed" view so it lists every installed
/// package, not just those surfaced by a catalog search. Fetched concurrently.
#[tauri::command]
pub async fn pi_packages_meta(names: Vec<String>) -> Vec<PiPackage> {
    let mut set = JoinSet::new();
    for spec in names.into_iter().take(80) {
        set.spawn(async move {
            let (name, pinned) = npm_name_and_pin(&spec)?;
            let local = installed_version(&name);
            let mut package = fetch_one(spec).await?;
            package.installed_version = local.clone();
            package.pinned = pinned;
            package.update_available = !pinned
                && local
                    .as_deref()
                    .is_some_and(|version| version != package.version);
            Some(package)
        });
    }
    let mut out = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok(Some(p)) = res {
            out.push(p);
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
    }
}
