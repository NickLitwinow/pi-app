use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub fn agent_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("PI_APP_AGENT_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    dirs::home_dir().unwrap_or_default().join(".pi").join("agent")
}

pub fn sessions_root() -> PathBuf {
    agent_dir().join("sessions")
}

/// pi encodes a project's session directory as `--<cwd>--` with the leading
/// slash stripped and `/ \ :` replaced by `-` (see pi session-manager).
pub fn project_dir_name_for_cwd(cwd: &str) -> String {
    let stripped = cwd.trim_start_matches(['/', '\\']);
    let safe: String = stripped
        .chars()
        .map(|c| if c == '/' || c == '\\' || c == ':' { '-' } else { c })
        .collect();
    format!("--{safe}--")
}

/// Resolve the sessions directory for a cwd: exact encoded name first,
/// falling back to a scan of header `cwd` fields (covers older encodings).
pub fn project_dir_for_cwd(root: &Path, cwd: &str) -> Option<PathBuf> {
    let candidate = root.join(project_dir_name_for_cwd(cwd));
    if candidate.is_dir() {
        return Some(candidate);
    }
    for p in list_projects_in(root) {
        if p.cwd == cwd {
            return Some(PathBuf::from(p.dir));
        }
    }
    None
}

fn mtime_ms(p: &Path) -> i64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------- projects ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub dir: String,
    pub cwd: String,
    pub name: String,
    pub session_count: usize,
    pub last_modified_ms: i64,
}

pub fn list_projects_in(root: &Path) -> Vec<ProjectInfo> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return out;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let mut count = 0usize;
        let mut newest_ms = 0i64;
        let mut newest_file: Option<PathBuf> = None;
        if let Ok(files) = fs::read_dir(&dir) {
            for f in files.flatten() {
                let p = f.path();
                if p.extension().map(|e| e == "jsonl").unwrap_or(false) {
                    count += 1;
                    let m = mtime_ms(&p);
                    if m >= newest_ms {
                        newest_ms = m;
                        newest_file = Some(p);
                    }
                }
            }
        }
        if count == 0 {
            continue;
        }
        let cwd = newest_file
            .and_then(|p| read_header_cwd(&p))
            .unwrap_or_else(|| dir.file_name().unwrap_or_default().to_string_lossy().into_owned());
        let name = Path::new(&cwd)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| cwd.clone());
        out.push(ProjectInfo {
            dir: dir.to_string_lossy().into_owned(),
            cwd,
            name,
            session_count: count,
            last_modified_ms: newest_ms,
        });
    }
    out.sort_by_key(|p| std::cmp::Reverse(p.last_modified_ms));
    out
}

fn read_header_cwd(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    v.get("cwd").and_then(|c| c.as_str()).map(|s| s.to_string())
}

#[tauri::command]
pub fn list_projects() -> Vec<ProjectInfo> {
    list_projects_in(&sessions_root())
}

// ---------- sessions ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub path: String,
    pub id: String,
    pub cwd: String,
    pub name: Option<String>,
    pub created_at: Option<String>,
    pub modified_ms: i64,
    pub message_count: usize,
    pub user_snippet: Option<String>,
    pub cost_total: f64,
    pub tokens_in: u64,
    pub tokens_out: u64,
}

/// Metadata cache: parsing a session means reading the whole JSONL file, so
/// re-listing on every refresh would re-read megabytes. Key by (mtime, size).
type MetaCache = HashMap<String, (i64, u64, SessionMeta)>;
static META_CACHE: Mutex<Option<MetaCache>> = Mutex::new(None);

fn file_size(p: &Path) -> u64 {
    fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

pub fn parse_session_meta_cached(path: &Path) -> Option<SessionMeta> {
    let key = path.to_string_lossy().into_owned();
    let mtime = mtime_ms(path);
    let size = file_size(path);
    {
        let cache = META_CACHE.lock().ok()?;
        if let Some(map) = cache.as_ref() {
            if let Some((m, s, meta)) = map.get(&key) {
                if *m == mtime && *s == size {
                    return Some(meta.clone());
                }
            }
        }
    }
    let meta = parse_session_meta(path)?;
    if let Ok(mut cache) = META_CACHE.lock() {
        let map = cache.get_or_insert_with(HashMap::new);
        // держим кэш в рамках: при переполнении выбрасываем самые старые файлы
        if map.len() > 2048 {
            let mut entries: Vec<(String, i64)> = map.iter().map(|(k, (m, _, _))| (k.clone(), *m)).collect();
            entries.sort_by_key(|(_, m)| *m);
            for (k, _) in entries.into_iter().take(map.len() / 2) {
                map.remove(&k);
            }
        }
        map.insert(key, (mtime, size, meta.clone()));
    }
    Some(meta)
}

pub fn parse_session_meta(path: &Path) -> Option<SessionMeta> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut meta = SessionMeta {
        path: path.to_string_lossy().into_owned(),
        id: String::new(),
        cwd: String::new(),
        name: None,
        created_at: None,
        modified_ms: mtime_ms(path),
        message_count: 0,
        user_snippet: None,
        cost_total: 0.0,
        tokens_in: 0,
        tokens_out: 0,
    };
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("session") => {
                meta.id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                meta.cwd = v.get("cwd").and_then(|x| x.as_str()).unwrap_or("").to_string();
                meta.created_at = v.get("timestamp").and_then(|x| x.as_str()).map(|s| s.to_string());
            }
            Some("session_info") => {
                meta.name = v.get("name").and_then(|x| x.as_str()).map(|s| s.to_string());
            }
            Some("message") => {
                meta.message_count += 1;
                let role = v.pointer("/message/role").and_then(|r| r.as_str()).unwrap_or("");
                if role == "user" && meta.user_snippet.is_none() {
                    if let Some(text) = first_text(v.pointer("/message/content")) {
                        let mut s: String = text.chars().take(160).collect();
                        s = s.replace('\n', " ");
                        meta.user_snippet = Some(s);
                    }
                }
                if role == "assistant" {
                    if let Some(u) = v.pointer("/message/usage") {
                        meta.cost_total += u.pointer("/cost/total").and_then(|x| x.as_f64()).unwrap_or(0.0);
                        meta.tokens_in += u.get("input").and_then(|x| x.as_u64()).unwrap_or(0);
                        meta.tokens_out += u.get("output").and_then(|x| x.as_u64()).unwrap_or(0);
                    }
                }
            }
            _ => {}
        }
    }
    if meta.id.is_empty() {
        return None;
    }
    Some(meta)
}

fn first_text(content: Option<&Value>) -> Option<String> {
    match content? {
        Value::String(s) => Some(s.clone()),
        Value::Array(arr) => arr.iter().find_map(|b| {
            if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                b.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
            } else {
                None
            }
        }),
        _ => None,
    }
}

pub fn list_sessions_in(project_dir: &Path) -> Vec<SessionMeta> {
    let mut out = Vec::new();
    if let Ok(files) = fs::read_dir(project_dir) {
        for f in files.flatten() {
            let p = f.path();
            if p.extension().map(|e| e == "jsonl").unwrap_or(false) {
                if let Some(meta) = parse_session_meta_cached(&p) {
                    out.push(meta);
                }
            }
        }
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.modified_ms));
    out
}

#[tauri::command]
pub fn list_sessions(project_dir: String) -> Vec<SessionMeta> {
    list_sessions_in(Path::new(&project_dir))
}

/// Sessions for a workspace by its cwd — независимо от того, знает ли фронтенд
/// каталог сессий (новые workspace получают сессии сразу после первого промпта).
#[tauri::command]
pub fn list_sessions_for_cwd(cwd: String) -> Vec<SessionMeta> {
    match project_dir_for_cwd(&sessions_root(), &cwd) {
        Some(dir) => list_sessions_in(&dir),
        None => Vec::new(),
    }
}

/// Validate that a path points to a real pi session file (header line check).
fn assert_session_file(path: &Path) -> Result<(), String> {
    if path.extension().map(|e| e != "jsonl").unwrap_or(true) {
        return Err("not a .jsonl session file".into());
    }
    let header = read_header_line(path).ok_or("файл не является сессией pi (нет заголовка)")?;
    if header.get("type").and_then(|t| t.as_str()) != Some("session") {
        return Err("файл не является сессией pi".into());
    }
    Ok(())
}

fn read_header_line(path: &Path) -> Option<Value> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    serde_json::from_str(line.trim()).ok()
}

/// Permanently delete a session file (with validation that it IS a session).
#[tauri::command]
pub fn delete_session(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    assert_session_file(p)?;
    fs::remove_file(p).map_err(|e| e.to_string())
}

/// uuid v7-style id (time-ordered + random), как генерирует pi.
fn gen_session_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut rand = [0u8; 10];
    for chunk in rand.chunks_mut(8) {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(ms);
        let v = h.finish().to_le_bytes();
        let n = chunk.len();
        chunk.copy_from_slice(&v[..n]);
    }
    let t = ms.to_be_bytes();
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-7{:01x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        t[2], t[3], t[4], t[5], t[6], t[7],
        rand[0] & 0x0f, rand[1],
        (rand[2] & 0x3f) | 0x80, rand[3],
        rand[4], rand[5], rand[6], rand[7], rand[8], rand[9]
    )
}

/// Fork a session: копия jsonl с новым id (опционально — только записи строго
/// до указанного entry id, «форк с этого места»). Возвращает мету новой сессии.
#[tauri::command]
pub fn fork_session(path: String, up_to_entry_id: Option<String>) -> Result<SessionMeta, String> {
    let src = Path::new(&path);
    assert_session_file(src)?;
    let content = fs::read_to_string(src).map_err(|e| e.to_string())?;
    let new_id = gen_session_id();

    let mut out_lines: Vec<String> = Vec::new();
    let mut last_entry_id: Option<String> = None;
    let mut orig_name: Option<String> = None;
    for (i, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(mut v) = serde_json::from_str::<Value>(line) else { continue };
        if i == 0 {
            // header: новая идентичность сессии
            v["id"] = Value::String(new_id.clone());
            v["timestamp"] = Value::String(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            out_lines.push(v.to_string());
            continue;
        }
        if let Some(stop) = &up_to_entry_id {
            if v.get("id").and_then(|x| x.as_str()) == Some(stop.as_str()) {
                break;
            }
        }
        if v.get("type").and_then(|t| t.as_str()) == Some("session_info") {
            orig_name = v.get("name").and_then(|n| n.as_str()).map(|s| s.to_string());
        }
        if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
            last_entry_id = Some(id.to_string());
        }
        out_lines.push(line.to_string());
    }

    // имя-подсказка, чтобы форк был отличим в списке
    let fork_name = match orig_name {
        Some(n) if !n.is_empty() => format!("Форк: {n}"),
        _ => "Форк".to_string(),
    };
    let name_entry = serde_json::json!({
        "type": "session_info",
        "id": format!("{:08x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u32).unwrap_or(0)),
        "parentId": last_entry_id,
        "timestamp": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "name": fork_name,
    });
    out_lines.push(name_entry.to_string());

    let file_ts = chrono::Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .replace([':', '.'], "-");
    let dst = src
        .parent()
        .ok_or("bad path")?
        .join(format!("{file_ts}_{new_id}.jsonl"));
    fs::write(&dst, out_lines.join("\n") + "\n").map_err(|e| e.to_string())?;
    parse_session_meta(&dst).ok_or_else(|| "не удалось прочитать созданный форк".into())
}

/// Rename a session that has no live agent by appending a `session_info` entry —
/// the same format pi itself writes (name changes are append-only events).
#[tauri::command]
pub fn rename_session(path: String, name: String) -> Result<(), String> {
    use std::io::Write;
    let p = Path::new(&path);
    assert_session_file(p)?;

    // parentId must reference the last entry in the file
    let content = fs::read_to_string(p).map_err(|e| e.to_string())?;
    let last_id = content
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str::<Value>(l).ok())
        .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(|s| s.to_string()));

    let entry_id: String = {
        let ns = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{:08x}", (ns as u32) ^ ((ns >> 32) as u32))
    };
    let entry = serde_json::json!({
        "type": "session_info",
        "id": entry_id,
        "parentId": last_id,
        "timestamp": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "name": name,
    });

    let mut file = fs::OpenOptions::new().append(true).open(p).map_err(|e| e.to_string())?;
    let needs_newline = !content.is_empty() && !content.ends_with('\n');
    let line = format!("{}{}\n", if needs_newline { "\n" } else { "" }, entry);
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

/// Entries of the ACTIVE branch only, in root→leaf order.
///
/// A pi session is an append-only tree; the last written entry sits on the
/// currently active branch. Walking `parentId` from that leaf back to the root
/// yields the full linear conversation — including pre-compaction messages
/// (they remain ancestors) — without mixing in abandoned fork branches, which
/// naive append-order reading would merge together.
pub fn read_session_thread_entries(path: &Path) -> Result<Vec<Value>, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);

    let mut by_id: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    let mut last_id: Option<String> = None;
    let mut root_fallback: Vec<Value> = Vec::new();

    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        match v.get("id").and_then(|i| i.as_str()) {
            Some(id) => {
                let id = id.to_string();
                last_id = Some(id.clone());
                by_id.insert(id, v);
            }
            None => root_fallback.push(v), // на всякий случай, если у записи нет id
        }
        if by_id.len() >= 100_000 {
            break;
        }
    }

    // собрать цепочку leaf → root по parentId
    let mut chain: Vec<Value> = Vec::new();
    let mut cursor = last_id;
    let mut guard = 0usize;
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    while let Some(id) = cursor {
        if !seen.insert(id.clone()) {
            break; // защита от циклов в повреждённом файле
        }
        let Some(v) = by_id.get(&id) else { break };
        let parent = v
            .get("parentId")
            .and_then(|p| p.as_str())
            .map(|s| s.to_string());
        chain.push(v.clone());
        cursor = parent;
        guard += 1;
        if guard >= 100_000 {
            break;
        }
    }
    chain.reverse();
    if chain.is_empty() {
        return Ok(root_fallback);
    }
    Ok(chain)
}

#[tauri::command]
pub fn read_session_thread(path: String) -> Result<Vec<Value>, String> {
    if !path.ends_with(".jsonl") {
        return Err("not a session file".into());
    }
    read_session_thread_entries(Path::new(&path))
}

// ---------- search ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub cwd: String,
    pub entry_id: Option<String>,
    pub timestamp: Option<String>,
    pub role: String,
    pub snippet: String,
}

pub fn search_sessions_in(root: &Path, query: &str, limit: usize) -> Vec<SearchHit> {
    let q = query.to_lowercase();
    let mut hits = Vec::new();
    if q.len() < 2 {
        return hits;
    }
    let Ok(projects) = fs::read_dir(root) else {
        return hits;
    };
    'outer: for proj in projects.flatten() {
        let dir = proj.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(&dir) else { continue };
        for f in files.flatten() {
            let p = f.path();
            if !p.extension().map(|e| e == "jsonl").unwrap_or(false) {
                continue;
            }
            let Ok(file) = fs::File::open(&p) else { continue };
            let reader = BufReader::new(file);
            let mut cwd = String::new();
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if cwd.is_empty() {
                    if let Ok(v) = serde_json::from_str::<Value>(&line) {
                        if v.get("type").and_then(|t| t.as_str()) == Some("session") {
                            cwd = v.get("cwd").and_then(|c| c.as_str()).unwrap_or("").to_string();
                            continue;
                        }
                    }
                }
                if !line.to_lowercase().contains(&q) {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if v.get("type").and_then(|t| t.as_str()) != Some("message") {
                    continue;
                }
                let role = v.pointer("/message/role").and_then(|r| r.as_str()).unwrap_or("");
                if role != "user" && role != "assistant" {
                    continue;
                }
                let Some(text) = collect_text(v.pointer("/message/content")) else { continue };
                let lower = text.to_lowercase();
                let Some(idx) = lower.find(&q) else { continue };
                let start = text[..idx].char_indices().rev().nth(60).map(|(i, _)| i).unwrap_or(0);
                let end_byte = (idx + q.len() + 100).min(text.len());
                let end = if text.is_char_boundary(end_byte) {
                    end_byte
                } else {
                    text[..end_byte].char_indices().last().map(|(i, _)| i).unwrap_or(end_byte)
                };
                let snippet = text[start..end].replace('\n', " ");
                hits.push(SearchHit {
                    path: p.to_string_lossy().into_owned(),
                    cwd: cwd.clone(),
                    entry_id: v.get("id").and_then(|i| i.as_str()).map(|s| s.to_string()),
                    timestamp: v.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string()),
                    role: role.to_string(),
                    snippet,
                });
                if hits.len() >= limit {
                    break 'outer;
                }
            }
        }
    }
    hits
}

fn collect_text(content: Option<&Value>) -> Option<String> {
    match content? {
        Value::String(s) => Some(s.clone()),
        Value::Array(arr) => {
            let joined: Vec<String> = arr
                .iter()
                .filter_map(|b| {
                    if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                        b.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .collect();
            if joined.is_empty() {
                None
            } else {
                Some(joined.join("\n"))
            }
        }
        _ => None,
    }
}

#[tauri::command]
pub fn search_sessions(query: String) -> Vec<SearchHit> {
    search_sessions_in(&sessions_root(), &query, 100)
}

// ---------- analytics ----------

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsTotals {
    pub cost: f64,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub sessions: usize,
    pub messages: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayStat {
    pub date: String,
    pub cost: f64,
    pub messages: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStat {
    pub model: String,
    pub cost: f64,
    pub input: u64,
    pub output: u64,
    pub messages: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsOverview {
    pub totals: AnalyticsTotals,
    pub per_day: Vec<DayStat>,
    pub per_model: Vec<ModelStat>,
}

/// Per-file aggregate (кэшируется по mtime+size: аналитика не перечитывает
/// сотни мегабайт jsonl при каждом открытии вкладки).
#[derive(Clone, Default)]
struct FileAgg {
    cost: f64,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    messages: usize,
    per_day: Vec<(String, f64, usize)>,
    per_model: Vec<(String, f64, u64, u64, usize)>,
}

type AnalyticsCache = HashMap<String, (i64, u64, FileAgg)>;
static ANALYTICS_CACHE: Mutex<Option<AnalyticsCache>> = Mutex::new(None);

fn analyze_session_file(p: &Path) -> FileAgg {
    let mut agg = FileAgg::default();
    let mut per_day: BTreeMap<String, (f64, usize)> = BTreeMap::new();
    let mut per_model: BTreeMap<String, (f64, u64, u64, usize)> = BTreeMap::new();
    let Ok(file) = fs::File::open(p) else { return agg };
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        // cheap pre-filter: only message entries matter
        if !line.contains("\"message\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        agg.messages += 1;
        let day = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .map(|s| s.chars().take(10).collect::<String>())
            .unwrap_or_default();
        let e = per_day.entry(day).or_insert((0.0, 0));
        e.1 += 1;
        if v.pointer("/message/role").and_then(|r| r.as_str()) == Some("assistant") {
            let cost = v.pointer("/message/usage/cost/total").and_then(|x| x.as_f64()).unwrap_or(0.0);
            let input = v.pointer("/message/usage/input").and_then(|x| x.as_u64()).unwrap_or(0);
            let output = v.pointer("/message/usage/output").and_then(|x| x.as_u64()).unwrap_or(0);
            agg.cost += cost;
            agg.input += input;
            agg.output += output;
            agg.cache_read += v.pointer("/message/usage/cacheRead").and_then(|x| x.as_u64()).unwrap_or(0);
            agg.cache_write += v.pointer("/message/usage/cacheWrite").and_then(|x| x.as_u64()).unwrap_or(0);
            e.0 += cost;
            let model = v.pointer("/message/model").and_then(|m| m.as_str()).unwrap_or("unknown").to_string();
            let m = per_model.entry(model).or_insert((0.0, 0, 0, 0));
            m.0 += cost;
            m.1 += input;
            m.2 += output;
            m.3 += 1;
        }
    }
    agg.per_day = per_day.into_iter().map(|(d, (c, n))| (d, c, n)).collect();
    agg.per_model = per_model.into_iter().map(|(m, (c, i, o, n))| (m, c, i, o, n)).collect();
    agg
}

fn analyze_session_file_cached(p: &Path) -> FileAgg {
    let key = p.to_string_lossy().into_owned();
    let mtime = mtime_ms(p);
    let size = file_size(p);
    if let Ok(cache) = ANALYTICS_CACHE.lock() {
        if let Some(map) = cache.as_ref() {
            if let Some((m, s, agg)) = map.get(&key) {
                if *m == mtime && *s == size {
                    return agg.clone();
                }
            }
        }
    }
    let agg = analyze_session_file(p);
    if let Ok(mut cache) = ANALYTICS_CACHE.lock() {
        let map = cache.get_or_insert_with(HashMap::new);
        // ограничиваем рост кэша: при переполнении выбрасываем половину старых по mtime
        if map.len() > 4096 {
            let mut entries: Vec<(String, i64)> = map.iter().map(|(k, (m, _, _))| (k.clone(), *m)).collect();
            entries.sort_by_key(|(_, m)| *m);
            for (k, _) in entries.into_iter().take(map.len() / 2) {
                map.remove(&k);
            }
        }
        map.insert(key, (mtime, size, agg.clone()));
    }
    agg
}

pub fn analytics_in(root: &Path) -> AnalyticsOverview {
    let mut totals = AnalyticsTotals::default();
    let mut per_day: BTreeMap<String, (f64, usize)> = BTreeMap::new();
    let mut per_model: BTreeMap<String, (f64, u64, u64, usize)> = BTreeMap::new();

    if let Ok(projects) = fs::read_dir(root) {
        for proj in projects.flatten() {
            let dir = proj.path();
            if !dir.is_dir() {
                continue;
            }
            let Ok(files) = fs::read_dir(&dir) else { continue };
            for f in files.flatten() {
                let p = f.path();
                if !p.extension().map(|e| e == "jsonl").unwrap_or(false) {
                    continue;
                }
                totals.sessions += 1;
                let agg = analyze_session_file_cached(&p);
                totals.messages += agg.messages;
                totals.cost += agg.cost;
                totals.input += agg.input;
                totals.output += agg.output;
                totals.cache_read += agg.cache_read;
                totals.cache_write += agg.cache_write;
                for (d, c, n) in agg.per_day {
                    let e = per_day.entry(d).or_insert((0.0, 0));
                    e.0 += c;
                    e.1 += n;
                }
                for (model, c, i, o, n) in agg.per_model {
                    let m = per_model.entry(model).or_insert((0.0, 0, 0, 0));
                    m.0 += c;
                    m.1 += i;
                    m.2 += o;
                    m.3 += n;
                }
            }
        }
    }

    let per_day = per_day
        .into_iter()
        .map(|(date, (cost, messages))| DayStat { date, cost, messages })
        .collect();
    let mut per_model: Vec<ModelStat> = per_model
        .into_iter()
        .map(|(model, (cost, input, output, messages))| ModelStat { model, cost, input, output, messages })
        .collect();
    per_model.sort_by_key(|m| std::cmp::Reverse(m.messages));

    AnalyticsOverview { totals, per_day, per_model }
}

#[tauri::command]
pub fn analytics_overview() -> AnalyticsOverview {
    analytics_in(&sessions_root())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture(dir: &Path) -> PathBuf {
        let proj = dir.join("--tmp-proj--");
        fs::create_dir_all(&proj).unwrap();
        let file = proj.join("2026-07-01T00-00-00-000Z_abc123.jsonl");
        let mut f = fs::File::create(&file).unwrap();
        writeln!(f, r#"{{"type":"session","version":3,"id":"abc123","timestamp":"2026-07-01T00:00:00.000Z","cwd":"/tmp/proj"}}"#).unwrap();
        writeln!(f, r#"{{"type":"session_info","id":"e1","parentId":null,"timestamp":"2026-07-01T00:00:01.000Z","name":"Test session"}}"#).unwrap();
        writeln!(f, r#"{{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-07-01T00:00:02.000Z","message":{{"role":"user","content":[{{"type":"text","text":"hello рефакторинг world"}}]}}}}"#).unwrap();
        writeln!(f, r#"{{"type":"message","id":"e3","parentId":"e2","timestamp":"2026-07-01T00:00:03.000Z","message":{{"role":"assistant","content":[{{"type":"text","text":"done"}}],"model":"test-model","usage":{{"input":100,"output":50,"cacheRead":0,"cacheWrite":0,"cost":{{"input":0.1,"output":0.2,"total":0.3}}}}}}}}"#).unwrap();
        file
    }

    #[test]
    fn parses_session_meta() {
        let tmp = tempfile::tempdir().unwrap();
        let file = fixture(tmp.path());
        let meta = parse_session_meta(&file).unwrap();
        assert_eq!(meta.id, "abc123");
        assert_eq!(meta.cwd, "/tmp/proj");
        assert_eq!(meta.name.as_deref(), Some("Test session"));
        assert_eq!(meta.message_count, 2);
        assert!(meta.user_snippet.as_deref().unwrap().contains("hello"));
        assert!((meta.cost_total - 0.3).abs() < 1e-9);
        assert_eq!(meta.tokens_in, 100);
        assert_eq!(meta.tokens_out, 50);
    }

    #[test]
    fn lists_projects_and_sessions() {
        let tmp = tempfile::tempdir().unwrap();
        fixture(tmp.path());
        let projects = list_projects_in(tmp.path());
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].cwd, "/tmp/proj");
        assert_eq!(projects[0].session_count, 1);
        let sessions = list_sessions_in(Path::new(&projects[0].dir));
        assert_eq!(sessions.len(), 1);
    }

    #[test]
    fn searches_across_sessions() {
        let tmp = tempfile::tempdir().unwrap();
        fixture(tmp.path());
        let hits = search_sessions_in(tmp.path(), "рефакторинг", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].role, "user");
        assert!(hits[0].snippet.contains("рефакторинг"));
        assert!(search_sessions_in(tmp.path(), "nonexistent-token", 10).is_empty());
    }

    #[test]
    fn aggregates_analytics() {
        let tmp = tempfile::tempdir().unwrap();
        fixture(tmp.path());
        let a = analytics_in(tmp.path());
        assert_eq!(a.totals.sessions, 1);
        assert_eq!(a.totals.messages, 2);
        assert_eq!(a.totals.input, 100);
        assert!((a.totals.cost - 0.3).abs() < 1e-9);
        assert_eq!(a.per_day.len(), 1);
        assert_eq!(a.per_model.len(), 1);
        assert_eq!(a.per_model[0].model, "test-model");
    }
}

#[cfg(test)]
mod session_ops_tests {
    use super::*;

    #[test]
    fn forks_full_and_partial() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("--p--");
        fs::create_dir_all(&proj).unwrap();
        let file = proj.join("2026-07-01T00-00-00-000Z_orig01.jsonl");
        fs::write(
            &file,
            concat!(
                "{\"type\":\"session\",\"version\":3,\"id\":\"orig01\",\"timestamp\":\"2026-07-01T00:00:00.000Z\",\"cwd\":\"/tmp/p\"}\n",
                "{\"type\":\"session_info\",\"id\":\"e0\",\"parentId\":null,\"timestamp\":\"2026-07-01T00:00:00.500Z\",\"name\":\"Orig\"}\n",
                "{\"type\":\"message\",\"id\":\"e1\",\"parentId\":\"e0\",\"timestamp\":\"2026-07-01T00:00:01.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"first\"}]}}\n",
                "{\"type\":\"message\",\"id\":\"e2\",\"parentId\":\"e1\",\"timestamp\":\"2026-07-01T00:00:02.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"answer\"}]}}\n",
                "{\"type\":\"message\",\"id\":\"e3\",\"parentId\":\"e2\",\"timestamp\":\"2026-07-01T00:00:03.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"second\"}]}}\n",
            ),
        )
        .unwrap();

        // полный форк
        let meta = fork_session(file.to_string_lossy().into_owned(), None).unwrap();
        assert_ne!(meta.id, "orig01");
        assert_eq!(meta.message_count, 3);
        assert_eq!(meta.name.as_deref(), Some("Форк: Orig"));
        assert!(meta.id.len() == 36 && meta.id.chars().nth(14) == Some('7'), "uuid v7-style: {}", meta.id);

        // частичный форк: всё строго до e3 (второго сообщения пользователя)
        let meta2 = fork_session(file.to_string_lossy().into_owned(), Some("e3".into())).unwrap();
        assert_eq!(meta2.message_count, 2);
        let content = fs::read_to_string(Path::new(&meta2.path)).unwrap();
        assert!(!content.contains("second"));
        assert!(content.contains("first") && content.contains("answer"));

        // оригинал не тронут
        assert_eq!(parse_session_meta(&file).unwrap().message_count, 3);
    }

    #[test]
    fn reads_active_branch_thread() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("--t--");
        fs::create_dir_all(&proj).unwrap();
        let file = proj.join("s.jsonl");
        // линейная ветка: header → u1 → a1 → u2, плюс заброшенная форк-ветка от a1 (u2b)
        fs::write(
            &file,
            concat!(
                "{\"type\":\"session\",\"id\":\"h\",\"timestamp\":\"2026-07-01T00:00:00.000Z\",\"cwd\":\"/t\"}\n",
                "{\"type\":\"message\",\"id\":\"u1\",\"parentId\":\"h\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"first\"}]}}\n",
                "{\"type\":\"message\",\"id\":\"a1\",\"parentId\":\"u1\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"reply\"}]}}\n",
                "{\"type\":\"message\",\"id\":\"u2b\",\"parentId\":\"a1\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"ABANDONED\"}]}}\n",
                "{\"type\":\"message\",\"id\":\"u2\",\"parentId\":\"a1\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"active-second\"}]}}\n",
            ),
        )
        .unwrap();

        let thread = read_session_thread_entries(&file).unwrap();
        // активная ветка = h, u1, a1, u2 (u2b — заброшенный форк, исключён)
        let ids: Vec<&str> = thread.iter().filter_map(|v| v.get("id").and_then(|i| i.as_str())).collect();
        assert_eq!(ids, vec!["h", "u1", "a1", "u2"]);
        let joined = thread.iter().map(|v| v.to_string()).collect::<String>();
        assert!(joined.contains("active-second"));
        assert!(!joined.contains("ABANDONED"));
    }

    #[test]
    fn rename_appends_session_info_and_delete_removes() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("--x--");
        fs::create_dir_all(&proj).unwrap();
        let file = proj.join("s.jsonl");
        fs::write(&file, "{\"type\":\"session\",\"version\":3,\"id\":\"abc\",\"timestamp\":\"2026-07-01T00:00:00.000Z\",\"cwd\":\"/tmp/x\"}\n{\"type\":\"message\",\"id\":\"m1\",\"parentId\":null,\"timestamp\":\"2026-07-01T00:00:01.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}\n").unwrap();

        rename_session(file.to_string_lossy().into_owned(), "Новое имя".into()).unwrap();
        let meta = parse_session_meta(&file).unwrap();
        assert_eq!(meta.name.as_deref(), Some("Новое имя"));

        // повторное переименование цепляет parentId за последнюю запись
        rename_session(file.to_string_lossy().into_owned(), "Второе".into()).unwrap();
        let content = fs::read_to_string(&file).unwrap();
        let last: Value = serde_json::from_str(content.lines().last().unwrap()).unwrap();
        assert_eq!(last["name"], "Второе");
        assert!(last["parentId"].is_string());

        // удаление отказывает не-сессиям и удаляет сессию
        let bogus = proj.join("bogus.jsonl");
        fs::write(&bogus, "{\"type\":\"other\"}\n").unwrap();
        assert!(delete_session(bogus.to_string_lossy().into_owned()).is_err());
        delete_session(file.to_string_lossy().into_owned()).unwrap();
        assert!(!file.exists());
    }
}
