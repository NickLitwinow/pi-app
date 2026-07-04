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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSearch {
    pub total: u64,
    pub objects: Vec<PiPackage>,
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
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn as_str(v: &Value, ptr: &str) -> Option<String> {
    v.pointer(ptr).and_then(|x| x.as_str()).map(|s| s.to_string())
}

fn parse_object(o: &Value) -> Option<PiPackage> {
    let pkg = o.get("package")?;
    let name = pkg.get("name")?.as_str()?.to_string();
    let author = as_str(pkg, "/publisher/username")
        .or_else(|| pkg.pointer("/maintainers/0/username").and_then(|x| x.as_str()).map(|s| s.to_string()))
        .unwrap_or_default();
    let keywords = pkg
        .get("keywords")
        .and_then(|k| k.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    // downloads.monthly появился недавно; на старых зеркалах может отсутствовать
    let downloads_monthly = o
        .pointer("/downloads/monthly")
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    Some(PiPackage {
        npm_url: as_str(pkg, "/links/npm").unwrap_or_else(|| format!("https://www.npmjs.com/package/{name}")),
        repo_url: as_str(pkg, "/links/repository"),
        homepage: as_str(pkg, "/links/homepage"),
        version: pkg.get("version").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        description: pkg.get("description").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        updated: o.get("updated").and_then(|x| x.as_str()).map(|s| s.to_string()),
        popularity: o.pointer("/score/detail/popularity").and_then(|x| x.as_f64()).unwrap_or(0.0),
        name,
        author,
        downloads_monthly,
        keywords,
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
    let v: Value = serde_json::from_str(&body).map_err(|e| format!("невалидный ответ реестра: {e}"))?;
    let total = v.get("total").and_then(|t| t.as_u64()).unwrap_or(0);
    let objects = v
        .get("objects")
        .and_then(|o| o.as_array())
        .map(|arr| arr.iter().filter_map(parse_object).collect())
        .unwrap_or_default();
    Ok(PackageSearch { total, objects })
}

/// Repository/homepage URL из документа версии npm (может быть строкой или
/// объектом `{ "url": "git+https://…​.git" }`).
fn clean_repo(v: &Value, key: &str) -> Option<String> {
    let raw = match v.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(o)) => o.get("url").and_then(|u| u.as_str())?.to_string(),
        _ => return None,
    };
    let cleaned = raw
        .trim_start_matches("git+")
        .trim_end_matches(".git")
        .replace("git://", "https://")
        .replace("git@github.com:", "https://github.com/");
    Some(cleaned)
}

/// Fetch metadata for one installed package spec (npm:name / bare name; git specs
/// are skipped) from the npm registry's per-version document.
async fn fetch_one(spec: String) -> Option<PiPackage> {
    let name = spec.strip_prefix("npm:").unwrap_or(&spec);
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
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    Some(PiPackage {
        npm_url: format!("https://www.npmjs.com/package/{name}"),
        repo_url: clean_repo(&v, "repository"),
        homepage: v.get("homepage").and_then(|x| x.as_str()).map(|s| s.to_string()),
        version: v.get("version").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        description: v.get("description").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        updated: None,
        popularity: 0.0,
        downloads_monthly: 0,
        name,
        author,
        keywords,
    })
}

/// Resolve metadata for a list of installed package specs (from settings.json
/// `packages`) — used by the "Installed" view so it lists every installed
/// package, not just those surfaced by a catalog search. Fetched concurrently.
#[tauri::command]
pub async fn pi_packages_meta(names: Vec<String>) -> Vec<PiPackage> {
    let mut set = JoinSet::new();
    for spec in names.into_iter().take(80) {
        set.spawn(fetch_one(spec));
    }
    let mut out = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok(Some(p)) = res {
            out.push(p);
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}
