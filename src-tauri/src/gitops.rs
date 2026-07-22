use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::process::Command;

static CHECKPOINT_INDEX_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct TemporaryGitIndex {
    directory: PathBuf,
    path: PathBuf,
}

impl Drop for TemporaryGitIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn temporary_git_index() -> Result<TemporaryGitIndex, String> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    for _ in 0..128 {
        let sequence = CHECKPOINT_INDEX_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "pi-app-checkpoint-{}-{timestamp}-{sequence}",
            std::process::id()
        ));
        match std::fs::create_dir(&directory) {
            Ok(()) => {
                return Ok(TemporaryGitIndex {
                    path: directory.join("index"),
                    directory,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("cannot reserve temporary Git index: {error}")),
        }
    }
    Err("cannot reserve a unique temporary Git index after 128 attempts".into())
}

async fn run_git(cwd: &str, args: &[&str]) -> Result<(String, String, i32), String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("git failed to start: {e}"))?;
    Ok((
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
        out.status.code().unwrap_or(-1),
    ))
}

async fn git_ok(cwd: &str, args: &[&str]) -> Result<String, String> {
    let (stdout, stderr, code) = run_git(cwd, args).await?;
    if code == 0 {
        Ok(stdout)
    } else {
        Err(if stderr.trim().is_empty() {
            format!("git exited with {code}")
        } else {
            stderr.trim().to_string()
        })
    }
}

#[tauri::command]
pub async fn git_is_repo(cwd: String) -> Result<bool, String> {
    match run_git(&cwd, &["rev-parse", "--is-inside-work-tree"]).await {
        Ok((out, _, 0)) => Ok(out.trim() == "true"),
        _ => Ok(false),
    }
}

/// Список файлов рабочего каталога для @-меншенов (E4). В git-репо —
/// `git ls-files` tracked + untracked с учётом .gitignore; иначе — ограниченный
/// обход. Возвращает относительные пути, капнутые числом (фронт делает fuzzy).
#[tauri::command]
pub async fn list_workspace_files(cwd: String) -> Result<Vec<String>, String> {
    const CAP: usize = 4000;
    if let Ok((out, _, 0)) = run_git(
        &cwd,
        &["ls-files", "--cached", "--others", "--exclude-standard"],
    )
    .await
    {
        let mut files: Vec<String> = out
            .lines()
            .filter(|l| !l.is_empty())
            .map(|s| s.to_string())
            .collect();
        files.truncate(CAP);
        return Ok(files);
    }
    // не git — ограниченный обход, пропуская тяжёлые каталоги
    let root = std::path::PathBuf::from(&cwd);
    let mut out = Vec::new();
    let skip = [
        "node_modules",
        ".git",
        "target",
        "dist",
        "build",
        ".venv",
        "__pycache__",
    ];
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        if out.len() >= CAP {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') && name != ".env" {
                continue;
            }
            if p.is_dir() {
                if !skip.contains(&name.as_str()) {
                    stack.push(p);
                }
            } else if let Ok(rel) = p.strip_prefix(&root) {
                out.push(rel.to_string_lossy().into_owned());
                if out.len() >= CAP {
                    break;
                }
            }
        }
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub status: String,
    pub path: String,
}

pub fn parse_porcelain(out: &str) -> Vec<StatusEntry> {
    let mut entries = Vec::new();
    for line in out.lines() {
        if line.len() < 4 {
            continue;
        }
        let status = line[..2].to_string();
        let rest = &line[3..];
        // renames come as "old -> new"; show the new path
        let path = rest.split(" -> ").last().unwrap_or(rest).trim().to_string();
        let path = path.trim_matches('"').to_string();
        entries.push(StatusEntry { status, path });
    }
    entries
}

#[tauri::command]
pub async fn git_status(cwd: String) -> Result<Vec<StatusEntry>, String> {
    // untracked-files=all: файлы внутри новых каталогов видны пофайлово
    let out = git_ok(&cwd, &["status", "--porcelain=v1", "--untracked-files=all"]).await?;
    Ok(parse_porcelain(&out))
}

async fn worktree_snapshot(cwd: &str) -> Result<String, String> {
    let head = git_ok(cwd, &["rev-parse", "HEAD"])
        .await
        .map_err(|_| "репозиторий без коммитов — сделайте первый commit, чтобы включить чекпоинты")?
        .trim()
        .to_string();
    // `git stash create` ignores untracked files, so a file that existed before
    // the run would be falsely attributed to the agent. A temporary index lets
    // us snapshot tracked + untracked (respecting .gitignore) without touching
    // the user's real index or working tree.
    // Reserve a unique directory atomically. SystemTime alone has insufficient
    // resolution on some filesystems, so concurrent checkpoint calls used to
    // race on the same `<index>.lock` path. The guard also removes stale lock
    // files on every return path.
    let temporary_index = temporary_git_index()?;
    let index_path = &temporary_index.path;
    let run_index = |args: &[&str]| {
        let mut command = Command::new("git");
        command
            .args(args)
            .current_dir(cwd)
            .env("GIT_INDEX_FILE", &index_path);
        command
    };
    let read = run_index(&["read-tree", &head])
        .output()
        .await
        .map_err(|error| error.to_string())?;
    if !read.status.success() {
        return Err(String::from_utf8_lossy(&read.stderr).trim().to_string());
    }
    // First update only paths already present in HEAD (including deletions).
    let add = run_index(&["add", "-u"])
        .output()
        .await
        .map_err(|error| error.to_string())?;
    if !add.status.success() {
        return Err(String::from_utf8_lossy(&add.stderr).trim().to_string());
    }
    // Then add existing tracked/staged files and small untracked files. Large
    // untracked artefacts are intentionally skipped so a checkpoint cannot
    // copy multi-GB build outputs into the Git object database.
    let cached = git_ok(cwd, &["ls-files", "--cached"]).await?;
    let untracked = git_ok(cwd, &["ls-files", "--others", "--exclude-standard"]).await?;
    let root = std::path::Path::new(cwd);
    let mut paths: Vec<String> = cached
        .lines()
        .filter(|path| root.join(path).is_file())
        .map(str::to_string)
        .collect();
    paths.extend(untracked.lines().filter_map(|path| {
        let metadata = std::fs::metadata(root.join(path)).ok()?;
        (metadata.is_file() && metadata.len() <= 2_000_000).then(|| path.to_string())
    }));
    for chunk in paths.chunks(200) {
        let mut command = run_index(&["add", "--"]);
        command.args(chunk);
        let output = command.output().await.map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
    }
    let tree_out = run_index(&["write-tree"])
        .output()
        .await
        .map_err(|error| error.to_string())?;
    if !tree_out.status.success() {
        return Err(String::from_utf8_lossy(&tree_out.stderr).trim().to_string());
    }
    let tree = String::from_utf8_lossy(&tree_out.stdout).trim().to_string();
    let commit = Command::new("git")
        .args([
            "commit-tree",
            &tree,
            "-p",
            &head,
            "-m",
            "pi-app pre-run checkpoint",
        ])
        .current_dir(cwd)
        .env("GIT_AUTHOR_NAME", "Pi App")
        .env("GIT_AUTHOR_EMAIL", "pi-app@local")
        .env("GIT_COMMITTER_NAME", "Pi App")
        .env("GIT_COMMITTER_EMAIL", "pi-app@local")
        .output()
        .await
        .map_err(|error| error.to_string())?;
    if !commit.status.success() {
        return Err(String::from_utf8_lossy(&commit.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&commit.stdout).trim().to_string())
}

/// Snapshot the current working tree without touching the index or HEAD.
/// Returns the checkpoint commit hash, pinned under refs/pi-app/checkpoints/.
#[tauri::command]
pub async fn git_checkpoint(cwd: String, label: String) -> Result<String, String> {
    let hash = worktree_snapshot(&cwd).await?;
    let safe_label: String = label
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(40)
        .collect();
    let refname = format!(
        "refs/pi-app/checkpoints/{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        safe_label
    );
    git_ok(&cwd, &["update-ref", &refname, &hash]).await?;
    Ok(hash)
}

/// Unified diff of the complete working tree vs a base ref (defaults to HEAD).
/// Both sides are trees, so pre-existing untracked files are handled correctly.
#[tauri::command]
pub async fn git_review_diff(cwd: String, base: Option<String>) -> Result<String, String> {
    let base_ref = base.unwrap_or_else(|| "HEAD".to_string());
    let current = worktree_snapshot(&cwd).await?;
    let (diff, _, code) = run_git(&cwd, &["diff", &base_ref, &current]).await?;
    if code > 1 {
        return Err(format!("git diff failed (exit {code})"));
    }
    Ok(diff)
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitSummary {
    pub is_repo: bool,
    pub branch: String,
    pub insertions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub has_remote: bool,
    pub ahead: u64,
    pub behind: u64,
}

/// Compact working-tree summary for the chat status bar:
/// branch + uncommitted +/− (tracked diff vs HEAD, plus untracked file lines).
#[tauri::command]
pub async fn git_summary(cwd: String) -> Result<GitSummary, String> {
    let mut s = GitSummary::default();
    match run_git(&cwd, &["rev-parse", "--is-inside-work-tree"]).await {
        Ok((out, _, 0)) if out.trim() == "true" => s.is_repo = true,
        _ => return Ok(s),
    }
    if let Ok((out, _, 0)) = run_git(&cwd, &["branch", "--show-current"]).await {
        s.branch = out.trim().to_string();
    }
    if s.branch.is_empty() {
        s.branch = "detached".into();
    }
    s.has_remote =
        matches!(run_git(&cwd, &["remote"]).await, Ok((out, _, 0)) if !out.trim().is_empty());

    // ahead/behind относительно upstream (если он настроен)
    if let Ok((out, _, 0)) = run_git(
        &cwd,
        &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
    )
    .await
    {
        let mut it = out.split_whitespace();
        s.behind = it.next().and_then(|n| n.parse().ok()).unwrap_or(0);
        s.ahead = it.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    }

    // tracked changes vs HEAD: "N files changed, X insertions(+), Y deletions(-)"
    if let Ok((out, _, code)) = run_git(&cwd, &["diff", "--shortstat", "HEAD"]).await {
        if code <= 1 {
            for part in out.split(',') {
                let part = part.trim();
                let num: u64 = part
                    .split(' ')
                    .next()
                    .and_then(|n| n.parse().ok())
                    .unwrap_or(0);
                if part.contains("insertion") {
                    s.insertions += num;
                } else if part.contains("deletion") {
                    s.deletions += num;
                } else if part.contains("changed") {
                    s.changed_files += num;
                }
            }
        }
    }
    // untracked files count as additions (like Claude's counter)
    if let Ok(status) = git_ok(&cwd, &["status", "--porcelain=v1", "--untracked-files=all"]).await {
        for entry in parse_porcelain(&status) {
            if entry.status != "??" {
                continue;
            }
            let full = std::path::Path::new(&cwd).join(&entry.path);
            if let Ok(meta) = std::fs::metadata(&full) {
                if meta.is_file() && meta.len() <= 2_000_000 {
                    if let Ok(content) = std::fs::read_to_string(&full) {
                        s.changed_files += 1;
                        s.insertions += content.lines().count() as u64;
                    }
                }
            }
        }
    }
    Ok(s)
}

/// Normalize a git remote URL (ssh or https) to its https web base without
/// trailing `.git`. Returns (host, "https://host/owner/repo").
pub fn remote_web_base(remote: &str) -> Option<(String, String)> {
    let r = remote.trim();
    let stripped = r.strip_suffix(".git").unwrap_or(r);
    // scp-like: git@host:owner/repo
    let https = if let Some(rest) = stripped.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        format!("https://{host}/{path}")
    } else if let Some(rest) = stripped.strip_prefix("ssh://git@") {
        format!("https://{}", rest)
    } else if stripped.starts_with("https://") || stripped.starts_with("http://") {
        stripped.to_string()
    } else {
        return None;
    };
    let host = https
        .strip_prefix("https://")
        .or_else(|| https.strip_prefix("http://"))
        .and_then(|s| s.split('/').next())
        .unwrap_or("")
        .to_string();
    if host.is_empty() {
        None
    } else {
        Some((host, https))
    }
}

/// Build the provider-specific "create PR/MR" web URL for a branch.
fn create_pr_url(host: &str, web_base: &str, branch: &str) -> String {
    let b = urlencode(branch);
    if host.contains("gitlab") {
        format!("{web_base}/-/merge_requests/new?merge_request%5Bsource_branch%5D={b}")
    } else if host.contains("bitbucket") {
        format!("{web_base}/pull-requests/new?source={b}")
    } else {
        // github и совместимые
        format!("{web_base}/compare/{b}?expand=1")
    }
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

async fn has_cli(name: &str) -> bool {
    matches!(
        tokio::process::Command::new("/bin/zsh")
            .args(["-lc", &format!("command -v {name}")])
            .output()
            .await,
        Ok(out) if out.status.success() && !out.stdout.is_empty()
    )
}

/// Open a "create PR/MR" flow for the current branch using whatever the user's
/// own setup provides — GitHub (gh), GitLab (glab), or the provider's web page
/// opened in the default browser. Никакой привязки к конкретному аккаунту: всё
/// опирается на origin-remote репозитория и локальную авторизацию пользователя.
#[tauri::command]
pub async fn git_open_pr(cwd: String) -> Result<(), String> {
    let remote = git_ok(&cwd, &["remote", "get-url", "origin"])
        .await
        .map_err(|_| {
            "у репозитория нет remote «origin» — добавьте его (git remote add origin …)".to_string()
        })?;
    let (host, web_base) = remote_web_base(remote.trim())
        .ok_or_else(|| format!("не удалось разобрать URL remote: {}", remote.trim()))?;

    // нативные CLI дают лучший UX (заполняют заголовок/тело) — если установлены
    if host.contains("github") && has_cli("gh").await {
        return spawn_detached(&format!(
            "cd {} && gh pr create --web",
            crate::editor::shell_escape_pub(&cwd)
        ));
    }
    if host.contains("gitlab") && has_cli("glab").await {
        return spawn_detached(&format!(
            "cd {} && glab mr create --web",
            crate::editor::shell_escape_pub(&cwd)
        ));
    }

    // универсальный путь: открыть страницу создания PR/MR в браузере
    let branch = git_ok(&cwd, &["branch", "--show-current"])
        .await?
        .trim()
        .to_string();
    if branch.is_empty() {
        return Err("вы в состоянии detached HEAD — переключитесь на ветку".into());
    }
    let url = create_pr_url(&host, &web_base, &branch);
    crate::editor::open_external(url)
}

fn spawn_detached(cmd: &str) -> Result<(), String> {
    std::process::Command::new("/bin/zsh")
        .args(["-lc", cmd])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Restore a single file from a ref (checkpoint revert).
#[tauri::command]
pub async fn git_checkout_file(cwd: String, gitref: String, path: String) -> Result<(), String> {
    git_ok(&cwd, &["checkout", &gitref, "--", &path]).await?;
    Ok(())
}

/// Restore every file changed during one agent run to its pre-run checkpoint.
/// Files absent from the checkpoint (created by the run) are removed. Paths are
/// restricted to the workspace to keep the bulk action safe.
#[tauri::command]
pub async fn git_restore_run_files(
    cwd: String,
    gitref: String,
    files: Vec<String>,
) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    let root = std::path::Path::new(&cwd);
    for path in files {
        let candidate = std::path::Path::new(&path);
        if candidate.is_absolute()
            || candidate
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
            || path.contains(['\n', '\r', '\0'])
        {
            return Err(format!("небезопасный путь: {path}"));
        }
        let object = format!("{gitref}:{path}");
        let (_, _, exists_code) = run_git(&cwd, &["cat-file", "-e", &object]).await?;
        if exists_code == 0 {
            git_ok(&cwd, &["checkout", &gitref, "--", &path]).await?;
        } else {
            let full = root.join(candidate);
            if full.is_file() || full.is_symlink() {
                std::fs::remove_file(&full)
                    .map_err(|error| format!("{}: {error}", full.display()))?;
            }
        }
    }
    Ok(())
}

/// Restore the complete checkpointed workspace tree without moving HEAD.
/// Returns the paths whose contents were changed. The checkpoint is resolved to
/// a commit first, so user-controlled ref syntax cannot be interpreted as a path.
#[tauri::command]
pub async fn git_restore_checkpoint(cwd: String, gitref: String) -> Result<Vec<String>, String> {
    let object = format!("{gitref}^{{commit}}");
    let resolved = git_ok(&cwd, &["rev-parse", "--verify", &object])
        .await?
        .trim()
        .to_string();
    if resolved.is_empty() {
        return Err("checkpoint не найден".into());
    }
    let current = worktree_snapshot(&cwd).await?;
    let (names, stderr, code) =
        run_git(&cwd, &["diff", "--name-only", "-z", &resolved, &current]).await?;
    if code != 0 {
        return Err(if stderr.trim().is_empty() {
            format!("git diff failed (exit {code})")
        } else {
            stderr.trim().to_string()
        });
    }
    let mut files: Vec<String> = names
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect();
    files.sort();
    files.dedup();
    git_restore_run_files(cwd, resolved, files.clone()).await?;
    Ok(files)
}

// ---------- full git view: branches / staging / commits ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub current: bool,
    pub remote: bool,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
    pub last_subject: String,
    pub last_ts: i64,
}

fn parse_track(track: &str) -> (u64, u64) {
    // "[ahead 2, behind 1]" / "[ahead 3]" / "[behind 4]" / "[gone]" / ""
    let mut ahead = 0;
    let mut behind = 0;
    for part in track.trim_matches(['[', ']']).split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

#[tauri::command]
pub async fn git_branches(cwd: String) -> Result<Vec<BranchInfo>, String> {
    const SEP: char = '\u{1f}';
    let fmt = "%(refname:short)\u{1f}%(HEAD)\u{1f}%(upstream:short)\u{1f}%(upstream:track)\u{1f}%(subject)\u{1f}%(committerdate:unix)";
    let mut out = Vec::new();

    let local = git_ok(
        &cwd,
        &[
            "for-each-ref",
            "refs/heads",
            "--sort=-committerdate",
            &format!("--format={fmt}"),
        ],
    )
    .await?;
    for line in local.lines() {
        let f: Vec<&str> = line.split(SEP).collect();
        if f.len() < 6 {
            continue;
        }
        let (ahead, behind) = parse_track(f[3]);
        out.push(BranchInfo {
            name: f[0].to_string(),
            current: f[1] == "*",
            remote: false,
            upstream: if f[2].is_empty() {
                None
            } else {
                Some(f[2].to_string())
            },
            ahead,
            behind,
            last_subject: f[4].to_string(),
            last_ts: f[5].trim().parse().unwrap_or(0),
        });
    }

    let locals: std::collections::HashSet<String> = out.iter().map(|b| b.name.clone()).collect();
    let remote = git_ok(
        &cwd,
        &[
            "for-each-ref",
            "refs/remotes",
            "--sort=-committerdate",
            &format!("--format={fmt}"),
        ],
    )
    .await?;
    for line in remote.lines() {
        let f: Vec<&str> = line.split(SEP).collect();
        if f.len() < 6 || f[0].ends_with("/HEAD") {
            continue;
        }
        // скрыть удалённые ветки, у которых уже есть локальный трек
        let short = f[0].split_once('/').map(|(_, b)| b).unwrap_or(f[0]);
        if locals.contains(short) {
            continue;
        }
        out.push(BranchInfo {
            name: f[0].to_string(),
            current: false,
            remote: true,
            upstream: None,
            ahead: 0,
            behind: 0,
            last_subject: f[4].to_string(),
            last_ts: f[5].trim().parse().unwrap_or(0),
        });
    }
    Ok(out)
}

/// Checkout a branch; remote branches get a local tracking branch.
#[tauri::command]
pub async fn git_checkout_branch(cwd: String, name: String, remote: bool) -> Result<(), String> {
    if remote {
        let local = name
            .split_once('/')
            .map(|(_, b)| b.to_string())
            .unwrap_or_else(|| name.clone());
        git_ok(&cwd, &["checkout", "-B", &local, "--track", &name]).await?;
    } else {
        git_ok(&cwd, &["checkout", &name]).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_create_branch(
    cwd: String,
    name: String,
    from: Option<String>,
) -> Result<(), String> {
    let mut args = vec!["checkout", "-b", name.as_str()];
    if let Some(ref f) = from {
        args.push(f.as_str());
    }
    git_ok(&cwd, &args).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_delete_branch(cwd: String, name: String, force: bool) -> Result<(), String> {
    git_ok(&cwd, &["branch", if force { "-D" } else { "-d" }, &name]).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_stage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        git_ok(&cwd, &["add", "-A"]).await?;
    } else {
        let mut args: Vec<&str> = vec!["add", "--"];
        args.extend(paths.iter().map(|s| s.as_str()));
        git_ok(&cwd, &args).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_unstage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["reset", "-q", "HEAD", "--"];
    if paths.is_empty() {
        args.pop();
        git_ok(&cwd, &args).await?;
    } else {
        args.extend(paths.iter().map(|s| s.as_str()));
        git_ok(&cwd, &args).await?;
    }
    Ok(())
}

/// Discard working-tree changes for the given paths: restore tracked files,
/// delete untracked ones. Destructive — the UI confirms first.
#[tauri::command]
pub async fn git_discard(cwd: String, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("пустой список файлов".into());
    }
    let status = git_ok(&cwd, &["status", "--porcelain=v1", "--untracked-files=all"]).await?;
    let untracked: std::collections::HashSet<String> = parse_porcelain(&status)
        .into_iter()
        .filter(|e| e.status == "??")
        .map(|e| e.path)
        .collect();
    let mut tracked: Vec<&str> = Vec::new();
    for p in &paths {
        if untracked.contains(p) {
            let full = std::path::Path::new(&cwd).join(p);
            std::fs::remove_file(&full)
                .or_else(|_| std::fs::remove_dir_all(&full))
                .map_err(|e| format!("{p}: {e}"))?;
        } else {
            tracked.push(p.as_str());
        }
    }
    if !tracked.is_empty() {
        // worktree ← index: staged-часть файла не трогаем
        let mut args: Vec<&str> = vec!["checkout", "--"];
        args.extend(tracked);
        git_ok(&cwd, &args).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_commit(cwd: String, message: String, amend: bool) -> Result<String, String> {
    if message.trim().is_empty() && !amend {
        return Err("пустое сообщение коммита".into());
    }
    let mut args: Vec<&str> = vec!["commit", "-m", &message];
    if amend {
        args.push("--amend");
    }
    git_ok(&cwd, &args).await?;
    Ok(git_ok(&cwd, &["rev-parse", "HEAD"])
        .await?
        .trim()
        .to_string())
}

/// Push the current branch; sets upstream automatically when missing.
#[tauri::command]
pub async fn git_push(cwd: String) -> Result<String, String> {
    let (out, err, code) = run_git(&cwd, &["push"]).await?;
    if code == 0 {
        return Ok(if err.trim().is_empty() { out } else { err });
    }
    if err.contains("no upstream") || err.contains("--set-upstream") {
        let branch = git_ok(&cwd, &["branch", "--show-current"])
            .await?
            .trim()
            .to_string();
        if branch.is_empty() {
            return Err(err.trim().to_string());
        }
        return git_ok(&cwd, &["push", "-u", "origin", &branch])
            .await
            .map(|o| o.trim().to_string());
    }
    Err(err.trim().to_string())
}

#[tauri::command]
pub async fn git_pull(cwd: String) -> Result<String, String> {
    let (out, err, code) = run_git(&cwd, &["pull", "--ff-only"]).await?;
    if code == 0 {
        Ok(if out.trim().is_empty() {
            err.trim().to_string()
        } else {
            out.trim().to_string()
        })
    } else {
        Err(if err.trim().is_empty() {
            format!("git pull failed ({code})")
        } else {
            err.trim().to_string()
        })
    }
}

#[tauri::command]
pub async fn git_fetch(cwd: String) -> Result<(), String> {
    git_ok(&cwd, &["fetch", "--all", "--prune"]).await?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub ts: i64,
    pub subject: String,
    pub refs: String,
}

#[tauri::command]
pub async fn git_log(cwd: String, limit: Option<u32>) -> Result<Vec<CommitInfo>, String> {
    let n = limit.unwrap_or(50).clamp(1, 500).to_string();
    let (out, _, code) = run_git(
        &cwd,
        &[
            "log",
            "--format=%H\u{1f}%h\u{1f}%an\u{1f}%at\u{1f}%s\u{1f}%D",
            "-n",
            &n,
        ],
    )
    .await?;
    if code != 0 {
        return Ok(Vec::new()); // репозиторий без коммитов
    }
    Ok(out
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\u{1f}').collect();
            if f.len() < 6 {
                return None;
            }
            Some(CommitInfo {
                hash: f[0].to_string(),
                short_hash: f[1].to_string(),
                author: f[2].to_string(),
                ts: f[3].parse().unwrap_or(0),
                subject: f[4].to_string(),
                refs: f[5].to_string(),
            })
        })
        .collect())
}

/// Diff of a single commit (for the history pane).
#[tauri::command]
pub async fn git_show_commit(cwd: String, hash: String) -> Result<String, String> {
    git_ok(
        &cwd,
        &[
            "show",
            &hash,
            "--format=commit %H%nAuthor: %an%nDate: %ad%n%n    %s%n",
        ],
    )
    .await
}

/// Diff for one file: staged (index vs HEAD) or unstaged (worktree vs index);
/// untracked files diff against /dev/null.
#[tauri::command]
pub async fn git_file_diff(cwd: String, path: String, staged: bool) -> Result<String, String> {
    if staged {
        let (out, _, code) = run_git(&cwd, &["diff", "--cached", "--", &path]).await?;
        if code > 1 {
            return Err(format!("git diff failed ({code})"));
        }
        return Ok(out);
    }
    let (out, _, code) = run_git(&cwd, &["diff", "--", &path]).await?;
    if code > 1 {
        return Err(format!("git diff failed ({code})"));
    }
    if !out.trim().is_empty() {
        return Ok(out);
    }
    // возможно, файл не отслеживается
    let (u, _, u_code) = run_git(&cwd, &["diff", "--no-index", "--", "/dev/null", &path]).await?;
    if u_code <= 1 {
        Ok(u)
    } else {
        Ok(String::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::fs;

    #[test]
    fn temporary_git_indexes_are_unique_and_cleaned() {
        let guards: Vec<_> = (0..32)
            .map(|_| std::thread::spawn(temporary_git_index))
            .map(|thread| thread.join().unwrap().unwrap())
            .collect();
        let directories: HashSet<_> = guards.iter().map(|guard| guard.directory.clone()).collect();
        assert_eq!(directories.len(), guards.len());
        assert!(directories.iter().all(|directory| directory.is_dir()));
        drop(guards);
        assert!(directories.iter().all(|directory| !directory.exists()));
    }

    async fn init_repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().to_str().unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "t@t.dev"],
            vec!["config", "user.name", "t"],
        ] {
            git_ok(cwd, &args).await.unwrap();
        }
        fs::write(tmp.path().join("a.txt"), "line1\nline2\n").unwrap();
        git_ok(cwd, &["add", "."]).await.unwrap();
        git_ok(cwd, &["commit", "-q", "-m", "init"]).await.unwrap();
        tmp
    }

    #[tokio::test]
    async fn checkpoint_and_diff_roundtrip() {
        let tmp = init_repo().await;
        let cwd = tmp.path().to_str().unwrap().to_string();

        // checkpoint on clean tree = HEAD
        let cp0 = git_checkpoint(cwd.clone(), "turn0".into()).await.unwrap();
        assert!(!cp0.is_empty());

        // modify tracked + add untracked
        fs::write(tmp.path().join("a.txt"), "line1\nCHANGED\n").unwrap();
        fs::write(tmp.path().join("new.txt"), "brand new\n").unwrap();

        let diff = git_review_diff(cwd.clone(), Some(cp0.clone()))
            .await
            .unwrap();
        assert!(
            diff.contains("CHANGED"),
            "diff should contain tracked change: {diff}"
        );
        assert!(
            diff.contains("brand new"),
            "diff should contain untracked file: {diff}"
        );

        // checkpoint with dirty tree, then more changes diff against it
        let cp1 = git_checkpoint(cwd.clone(), "turn1".into()).await.unwrap();
        assert_ne!(cp1, cp0);
        fs::write(tmp.path().join("a.txt"), "line1\nCHANGED-AGAIN\n").unwrap();
        let diff2 = git_review_diff(cwd.clone(), Some(cp1.clone()))
            .await
            .unwrap();
        assert!(diff2.contains("CHANGED-AGAIN"));
        assert!(
            !diff2.contains("brand new"),
            "pre-existing untracked file must be part of the checkpoint: {diff2}"
        );

        // revert the file back to cp1 state
        git_checkout_file(cwd.clone(), cp1, "a.txt".into())
            .await
            .unwrap();
        let content = fs::read_to_string(tmp.path().join("a.txt")).unwrap();
        assert!(content.contains("CHANGED") && !content.contains("CHANGED-AGAIN"));
    }

    #[tokio::test]
    async fn restore_run_files_restores_tracked_and_removes_created() {
        let tmp = init_repo().await;
        let cwd = tmp.path().to_str().unwrap().to_string();
        let checkpoint = git_checkpoint(cwd.clone(), "before-run".into())
            .await
            .unwrap();
        fs::write(tmp.path().join("a.txt"), "changed by agent\n").unwrap();
        fs::write(tmp.path().join("created.txt"), "new\n").unwrap();

        git_restore_run_files(cwd, checkpoint, vec!["a.txt".into(), "created.txt".into()])
            .await
            .unwrap();

        assert_eq!(
            fs::read_to_string(tmp.path().join("a.txt")).unwrap(),
            "line1\nline2\n"
        );
        assert!(!tmp.path().join("created.txt").exists());
    }

    #[tokio::test]
    async fn restore_checkpoint_restores_the_complete_snapshot_diff() {
        let tmp = init_repo().await;
        let cwd = tmp.path().to_str().unwrap().to_string();
        let checkpoint = git_checkpoint(cwd.clone(), "rewind-target".into())
            .await
            .unwrap();

        fs::write(tmp.path().join("a.txt"), "after\n").unwrap();
        fs::write(tmp.path().join("created.txt"), "new\n").unwrap();
        let restored = git_restore_checkpoint(cwd.clone(), checkpoint)
            .await
            .unwrap();

        assert_eq!(restored, vec!["a.txt", "created.txt"]);
        assert_eq!(
            fs::read_to_string(tmp.path().join("a.txt")).unwrap(),
            "line1\nline2\n"
        );
        assert!(!tmp.path().join("created.txt").exists());
    }

    #[tokio::test]
    async fn branch_stage_commit_log_roundtrip() {
        let tmp = init_repo().await;
        let cwd = tmp.path().to_str().unwrap().to_string();

        // ветки: одна текущая
        let branches = git_branches(cwd.clone()).await.unwrap();
        assert_eq!(branches.len(), 1);
        assert!(branches[0].current);

        // создать ветку, изменить файл, застейджить, закоммитить
        git_create_branch(cwd.clone(), "feature-x".into(), None)
            .await
            .unwrap();
        fs::write(tmp.path().join("a.txt"), "line1\nfeature\n").unwrap();
        fs::write(tmp.path().join("new.txt"), "u\n").unwrap();

        // staged diff пуст до add, файл виден как unstaged
        let d0 = git_file_diff(cwd.clone(), "a.txt".into(), false)
            .await
            .unwrap();
        assert!(d0.contains("feature"));
        let untracked = git_file_diff(cwd.clone(), "new.txt".into(), false)
            .await
            .unwrap();
        assert!(untracked.contains("+u"));

        git_stage(cwd.clone(), vec!["a.txt".into()]).await.unwrap();
        let staged = git_file_diff(cwd.clone(), "a.txt".into(), true)
            .await
            .unwrap();
        assert!(staged.contains("feature"));

        // unstage → снова в worktree
        git_unstage(cwd.clone(), vec!["a.txt".into()])
            .await
            .unwrap();
        assert!(git_file_diff(cwd.clone(), "a.txt".into(), true)
            .await
            .unwrap()
            .trim()
            .is_empty());

        git_stage(cwd.clone(), vec![]).await.unwrap(); // add -A
        let hash = git_commit(cwd.clone(), "feat: x".into(), false)
            .await
            .unwrap();
        assert_eq!(hash.len(), 40);

        let log = git_log(cwd.clone(), Some(10)).await.unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].subject, "feat: x");
        let show = git_show_commit(cwd.clone(), log[0].hash.clone())
            .await
            .unwrap();
        assert!(show.contains("feature"));

        // discard: изменить + выбросить
        fs::write(tmp.path().join("a.txt"), "garbage\n").unwrap();
        fs::write(tmp.path().join("junk.txt"), "j\n").unwrap();
        git_discard(cwd.clone(), vec!["a.txt".into(), "junk.txt".into()])
            .await
            .unwrap();
        assert!(fs::read_to_string(tmp.path().join("a.txt"))
            .unwrap()
            .contains("feature"));
        assert!(!tmp.path().join("junk.txt").exists());

        // переключение и удаление ветки
        let main = branches[0].name.clone();
        git_checkout_branch(cwd.clone(), main, false).await.unwrap();
        git_delete_branch(cwd.clone(), "feature-x".into(), true)
            .await
            .unwrap();
        assert_eq!(git_branches(cwd.clone()).await.unwrap().len(), 1);
    }

    #[test]
    fn normalizes_remotes_and_builds_pr_urls() {
        // ssh и https формы → одинаковая web-база
        let (h, base) = remote_web_base("git@github.com:NickLitwinow/pi-app.git").unwrap();
        assert_eq!(h, "github.com");
        assert_eq!(base, "https://github.com/NickLitwinow/pi-app");
        let (_, base2) = remote_web_base("https://github.com/NickLitwinow/pi-app.git").unwrap();
        assert_eq!(base2, base);

        // GitHub compare-URL
        assert_eq!(
            create_pr_url("github.com", &base, "feat/x y"),
            "https://github.com/NickLitwinow/pi-app/compare/feat%2Fx%20y?expand=1"
        );
        // GitLab MR-URL
        let (gh, gbase) = remote_web_base("git@gitlab.com:acme/app.git").unwrap();
        assert_eq!(gh, "gitlab.com");
        assert_eq!(
            create_pr_url(&gh, &gbase, "topic"),
            "https://gitlab.com/acme/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=topic"
        );

        // мусор не парсится
        assert!(remote_web_base("not-a-url").is_none());
    }

    #[test]
    fn parses_upstream_track() {
        assert_eq!(parse_track("[ahead 2, behind 1]"), (2, 1));
        assert_eq!(parse_track("[ahead 3]"), (3, 0));
        assert_eq!(parse_track("[behind 4]"), (0, 4));
        assert_eq!(parse_track(""), (0, 0));
        assert_eq!(parse_track("[gone]"), (0, 0));
    }

    #[test]
    fn parses_porcelain_status() {
        let entries = parse_porcelain(" M src/a.rs\n?? new file.txt\nR  old.txt -> new.txt\n");
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].status, " M");
        assert_eq!(entries[0].path, "src/a.rs");
        assert_eq!(entries[1].status, "??");
        assert_eq!(entries[1].path, "new file.txt");
        assert_eq!(entries[2].path, "new.txt");
    }
}
