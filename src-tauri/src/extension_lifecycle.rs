use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::pi_cli::{
    emit_cli_done, emit_cli_line, next_run_id, run_pi_process, validate_management_args,
};
use crate::sessions::agent_dir;
use crate::supervisor::{child_path, find_pi_binary, ExtensionMutationLease, Supervisor};

static LIFECYCLE_LOCK: LazyLock<Arc<tokio::sync::Mutex<()>>> =
    LazyLock::new(|| Arc::new(tokio::sync::Mutex::new(())));
static STARTUP_OVERLAY_BLOCK: LazyLock<StdMutex<Option<String>>> =
    LazyLock::new(|| StdMutex::new(None));

const TRANSACTION_DIR: &str = ".pi-app-extension-transactions";
const MANAGEMENT_DIR: &str = ".pi-app-extension-management";
const PROCESS_LOCK: &str = ".pi-app-extension-lifecycle.lock";
const HEALTH_WIDGET: &str = "pi-app-extension-health";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
const OVERLAY_JSON: &str = include_str!("../../extension-overlays/pi-subagents-worktree.json");

pub(crate) struct LifecycleGuard {
    _memory: tokio::sync::OwnedMutexGuard<()>,
    _process: ProcessLock,
}

#[derive(Debug)]
struct ProcessLock {
    path: PathBuf,
}

impl Drop for ProcessLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn process_is_alive(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as i32, 0) };
        result == 0
            || std::io::Error::last_os_error().kind() == std::io::ErrorKind::PermissionDenied
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn active_process_lock(path: &Path) -> bool {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| text.trim().parse::<u32>().ok())
        .is_some_and(process_is_alive)
}

fn acquire_process_lock(agent_root: &Path) -> Result<ProcessLock, String> {
    fs::create_dir_all(agent_root).map_err(|error| error.to_string())?;
    let path = agent_root.join(PROCESS_LOCK);
    for _ in 0..2 {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                writeln!(file, "{}", std::process::id()).map_err(|error| error.to_string())?;
                file.sync_all().map_err(|error| error.to_string())?;
                return Ok(ProcessLock { path });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if active_process_lock(&path) {
                    return Err(
                        "Дополнения уже изменяются в другом окне Pi; дождитесь завершения".into(),
                    );
                }
                fs::remove_file(&path).map_err(|remove| remove.to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Не удалось получить межпроцессную блокировку дополнений".into())
}

pub(crate) async fn acquire_lifecycle_lock() -> Result<LifecycleGuard, String> {
    let memory = LIFECYCLE_LOCK.clone().lock_owned().await;
    let process = acquire_process_lock(&agent_dir())?;
    Ok(LifecycleGuard {
        _memory: memory,
        _process: process,
    })
}

pub(crate) fn mutation_active_in_another_process() -> bool {
    let path = agent_dir().join(PROCESS_LOCK);
    active_process_lock(&path)
        && fs::read_to_string(path)
            .ok()
            .and_then(|text| text.trim().parse::<u32>().ok())
            != Some(std::process::id())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotEntry {
    live: PathBuf,
    backup: PathBuf,
    existed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransactionJournal {
    version: u32,
    id: String,
    status: String,
    entries: Vec<SnapshotEntry>,
}

struct Snapshot {
    dir: PathBuf,
    journal_path: PathBuf,
    journal: TransactionJournal,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverlayManifest {
    id: String,
    package_root: String,
    patches: Vec<OverlayPatch>,
}

#[derive(Debug, Deserialize)]
struct OverlayPatch {
    path: String,
    marker: String,
    before: String,
    after: String,
}

#[derive(Debug)]
struct HealthReport {
    command_count: usize,
    tool_count: usize,
}

#[derive(Default)]
struct HealthWire {
    commands: Option<Vec<Value>>,
    tools: Option<Vec<Value>>,
    protocol_errors: Vec<String>,
}

struct ExtensionContract {
    package: &'static str,
    commands: &'static [&'static str],
    tools: &'static [&'static str],
}

const EXTENSION_CONTRACTS: &[ExtensionContract] = &[
    ExtensionContract {
        package: "@tintinweb/pi-subagents",
        commands: &["agents"],
        tools: &["Agent", "get_subagent_result", "steer_subagent"],
    },
    ExtensionContract {
        package: "@juicesharp/rpiv-todo",
        commands: &["todos"],
        tools: &["todo"],
    },
    ExtensionContract {
        package: "@juicesharp/rpiv-ask-user-question",
        commands: &[],
        tools: &["ask_user_question"],
    },
    ExtensionContract {
        package: "ponytail",
        commands: &[
            "ponytail",
            "ponytail-review",
            "ponytail-audit",
            "ponytail-gain",
            "ponytail-debt",
            "ponytail-help",
        ],
        tools: &[],
    },
    ExtensionContract {
        package: "pi-web-access",
        commands: &["websearch", "curator", "google-account", "search"],
        tools: &["web_search", "fetch_content", "get_search_content"],
    },
    ExtensionContract {
        package: "@plannotator/pi-extension",
        commands: &[
            "plannotator",
            "plannotator-review",
            "plannotator-annotate",
            "plannotator-last",
        ],
        tools: &["plannotator_submit_plan"],
    },
    ExtensionContract {
        package: "pi-agent-browser-native",
        commands: &[],
        tools: &["agent_browser"],
    },
];

fn now_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("txn-{millis}-{}", std::process::id())
}

fn has_arg(args: &[String], value: &str) -> bool {
    args.iter().any(|arg| arg == value)
}

fn approve_explicit_project_mutation(args: &mut Vec<String>, cwd: Option<&str>) {
    if cwd.is_some()
        && !has_arg(args, "--approve")
        && !has_arg(args, "-a")
        && !has_arg(args, "--no-approve")
        && !has_arg(args, "-na")
    {
        args.push("--approve".into());
    }
}

/// Package mutations must never use the raw Pi CLI path. Self/model updates do
/// not touch the extension tree and remain on the lightweight runner.
pub fn is_extension_mutation(args: &[String]) -> bool {
    match args.first().map(String::as_str) {
        Some("install" | "remove" | "uninstall") => true,
        Some("update") => {
            if has_arg(args, "--models") {
                return false;
            }
            if has_arg(args, "--extensions")
                || has_arg(args, "--extension")
                || has_arg(args, "--all")
            {
                return true;
            }
            args.iter()
                .skip(1)
                .find(|arg| !arg.starts_with('-'))
                .is_some_and(|target| target != "self" && target != "pi")
        }
        _ => false,
    }
}

fn combined_self_and_extension_update(args: &[String]) -> bool {
    args.first().is_some_and(|arg| arg == "update")
        && (has_arg(args, "--all") || (has_arg(args, "--self") && has_arg(args, "--extensions")))
}

fn source_from_mutation(args: &[String]) -> Option<&str> {
    match args.first().map(String::as_str) {
        Some("install" | "remove" | "uninstall") => args
            .iter()
            .skip(1)
            .find(|arg| !arg.starts_with('-'))
            .map(String::as_str),
        Some("update") => {
            if let Some(index) = args.iter().position(|arg| arg == "--extension") {
                return args.get(index + 1).map(String::as_str);
            }
            args.iter()
                .skip(1)
                .find(|arg| !arg.starts_with('-'))
                .map(String::as_str)
        }
        _ => None,
    }
}

fn source_name(source: &str) -> String {
    let source = source.trim();
    if let Some(npm) = source.strip_prefix("npm:") {
        if npm.starts_with('@') {
            let separator = npm
                .find('/')
                .and_then(|slash| npm[slash + 1..].find('@').map(|at| slash + 1 + at));
            return separator.map_or(npm, |index| &npm[..index]).to_string();
        }
        return npm.split('@').next().unwrap_or(npm).to_string();
    }
    let clean = source
        .strip_prefix("file:")
        .unwrap_or(source)
        .split(['?', '#'])
        .next()
        .unwrap_or(source)
        .trim_end_matches(['/', '\\']);
    clean
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(clean)
        .trim_end_matches(".git")
        .to_string()
}

fn is_harness_core(source: &str) -> bool {
    source_name(source) == "harness-extension" && !source.starts_with("npm:")
}

fn mutation_removes_harness(args: &[String]) -> bool {
    matches!(
        args.first().map(String::as_str),
        Some("remove" | "uninstall")
    ) && source_from_mutation(args).is_some_and(is_harness_core)
}

fn management_cwd(agent_root: &Path) -> Result<PathBuf, String> {
    let path = agent_root.join(MANAGEMENT_DIR);
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn package_roots(args: &[String], cwd: Option<&Path>, agent_root: &Path) -> Vec<PathBuf> {
    let local = has_arg(args, "-l") || has_arg(args, "--local");
    let update = args.first().is_some_and(|arg| arg == "update");
    let mut roots = Vec::new();
    if !local {
        roots.push(agent_root.to_path_buf());
    }
    if let Some(cwd) = cwd.filter(|_| local || update) {
        roots.push(cwd.join(".pi"));
    }
    roots
}

fn snapshot_paths(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    roots
        .iter()
        .flat_map(|root| {
            ["settings.json", "npm", "git"]
                .into_iter()
                .map(|name| root.join(name))
        })
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

fn remove_path(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            fs::remove_dir_all(path).map_err(|error| error.to_string())
        }
        Ok(_) => fs::remove_file(path).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(unix)]
fn copy_symlink(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::unix::fs::symlink;
    let link = fs::read_link(source).map_err(|error| error.to_string())?;
    symlink(link, target).map_err(|error| error.to_string())
}

fn copy_tree_fallback(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        #[cfg(unix)]
        {
            return copy_symlink(source, target);
        }
        #[cfg(not(unix))]
        {
            return Err("symbolic-link snapshots are unsupported on this platform".into());
        }
    }
    if metadata.is_file() {
        fs::copy(source, target).map_err(|error| error.to_string())?;
        fs::set_permissions(target, metadata.permissions()).map_err(|error| error.to_string())?;
        return Ok(());
    }
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    fs::set_permissions(target, metadata.permissions()).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        copy_tree_fallback(&entry.path(), &target.join(entry.file_name()))?;
    }
    Ok(())
}

fn clone_tree(source: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if source.is_file() {
        return copy_tree_fallback(source, target);
    }
    #[cfg(target_os = "macos")]
    {
        // APFS clone-on-write keeps a 700+ MB extension tree snapshot cheap
        // while preserving a byte-for-byte rollback point.
        if std::process::Command::new("/bin/cp")
            .args(["-cR", "--"])
            .arg(source)
            .arg(target)
            .status()
            .is_ok_and(|status| status.success())
        {
            return Ok(());
        }
    }
    copy_tree_fallback(source, target)
}

fn write_journal(path: &Path, journal: &TransactionJournal) -> Result<(), String> {
    let content = serde_json::to_string_pretty(journal).map_err(|error| error.to_string())?;
    crate::config::write_json_atomic(path, &(content + "\n"))
}

impl Snapshot {
    fn create(agent_root: &Path, paths: Vec<PathBuf>) -> Result<Self, String> {
        let id = now_id();
        let dir = agent_root.join(TRANSACTION_DIR).join(&id);
        let backup_root = dir.join("backup");
        fs::create_dir_all(&backup_root).map_err(|error| error.to_string())?;
        let mut entries = Vec::new();
        for (index, live) in paths.into_iter().enumerate() {
            let backup = backup_root.join(index.to_string());
            let existed = fs::symlink_metadata(&live).is_ok();
            if existed {
                clone_tree(&live, &backup)
                    .map_err(|error| format!("snapshot failed for {}: {error}", live.display()))?;
            }
            entries.push(SnapshotEntry {
                live,
                backup,
                existed,
            });
        }
        let journal = TransactionJournal {
            version: 1,
            id,
            status: "prepared".into(),
            entries,
        };
        let journal_path = dir.join("journal.json");
        write_journal(&journal_path, &journal)?;
        Ok(Self {
            dir,
            journal_path,
            journal,
        })
    }

    fn set_status(&mut self, status: &str) -> Result<(), String> {
        self.journal.status = status.to_string();
        write_journal(&self.journal_path, &self.journal)
    }

    fn rollback(mut self) -> Result<(), String> {
        self.set_status("rolling-back")?;
        restore_entries(&self.dir, &self.journal.entries)?;
        self.journal.status = "rolled-back".into();
        write_journal(&self.journal_path, &self.journal)?;
        fs::remove_dir_all(&self.dir).map_err(|error| error.to_string())
    }

    fn commit(mut self) -> Result<(), String> {
        self.set_status("committed")?;
        fs::remove_dir_all(&self.dir).map_err(|error| error.to_string())
    }
}

fn recovery_entry_is_safe(transaction_dir: &Path, entry: &SnapshotEntry) -> bool {
    if entry.backup.strip_prefix(transaction_dir).is_err() {
        return false;
    }
    let Some(name) = entry.live.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let transaction_agent_root = transaction_dir.parent().and_then(Path::parent);
    matches!(name, "settings.json" | "npm" | "git")
        && (transaction_agent_root.is_some_and(|root| entry.live.parent() == Some(root))
            || entry
                .live
                .parent()
                .is_some_and(|parent| parent.file_name().is_some_and(|name| name == ".pi"))
            || entry.live.starts_with(agent_dir()))
}

fn restore_entries(transaction_dir: &Path, entries: &[SnapshotEntry]) -> Result<(), String> {
    for entry in entries.iter().rev() {
        if !recovery_entry_is_safe(transaction_dir, entry) {
            return Err(format!(
                "refusing unsafe extension rollback target: {}",
                entry.live.display()
            ));
        }
        remove_path(&entry.live)?;
        if entry.existed {
            if let Some(parent) = entry.live.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::rename(&entry.backup, &entry.live).map_err(|error| {
                format!(
                    "rollback restore failed {} -> {}: {error}",
                    entry.backup.display(),
                    entry.live.display()
                )
            })?;
        }
    }
    Ok(())
}

pub fn reconcile_startup() -> Result<(usize, usize), String> {
    let root = agent_dir();
    let _process_lock = acquire_process_lock(&root)?;
    let recovered = recover_pending_in(&root)?;
    match apply_harness_overlays(std::slice::from_ref(&root)) {
        Ok(applied) => {
            if let Ok(mut blocker) = STARTUP_OVERLAY_BLOCK.lock() {
                *blocker = None;
            }
            Ok((recovered, applied))
        }
        Err(error) => {
            if let Ok(mut blocker) = STARTUP_OVERLAY_BLOCK.lock() {
                *blocker = Some(error.clone());
            }
            Err(error)
        }
    }
}

pub(crate) fn extension_start_blocker() -> Option<String> {
    STARTUP_OVERLAY_BLOCK
        .lock()
        .ok()
        .and_then(|blocker| blocker.clone())
}

fn recover_pending_in(agent_root: &Path) -> Result<usize, String> {
    let root = agent_root.join(TRANSACTION_DIR);
    if !root.exists() {
        return Ok(0);
    }
    let mut recovered = 0;
    for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let journal_path = dir.join("journal.json");
        let journal = match fs::read_to_string(&journal_path)
            .ok()
            .and_then(|text| serde_json::from_str::<TransactionJournal>(&text).ok())
        {
            Some(journal) => journal,
            None => {
                remove_path(&dir)?;
                continue;
            }
        };
        if journal.status != "committed" && journal.status != "rolled-back" {
            restore_entries(&dir, &journal.entries)?;
            recovered += 1;
        }
        remove_path(&dir)?;
    }
    let _ = fs::remove_dir(&root);
    Ok(recovered)
}

fn path_is_relative_safe(path: &str) -> bool {
    !Path::new(path)
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::RootDir))
}

fn write_text_atomic(path: &Path, content: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("overlay target has no parent")?;
    let temp = parent.join(format!(
        ".pi-app-overlay-{}-{}",
        std::process::id(),
        now_id()
    ));
    fs::write(&temp, content).map_err(|error| error.to_string())?;
    if let Ok(metadata) = fs::metadata(path) {
        fs::set_permissions(&temp, metadata.permissions()).map_err(|error| error.to_string())?;
    }
    fs::rename(&temp, path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        error.to_string()
    })
}

fn apply_overlay(root: &Path, manifest: &OverlayManifest) -> Result<usize, String> {
    if !path_is_relative_safe(&manifest.package_root) {
        return Err(format!(
            "unsafe overlay package root: {}",
            manifest.package_root
        ));
    }
    let package_root = root.join(&manifest.package_root);
    if !package_root.exists() {
        return Ok(0);
    }
    let mut changed = 0;
    for patch in &manifest.patches {
        if !path_is_relative_safe(&patch.path) {
            return Err(format!("unsafe overlay target: {}", patch.path));
        }
        let target = package_root.join(&patch.path);
        let source = fs::read_to_string(&target).map_err(|error| {
            format!(
                "{} overlay target is unavailable ({}): {error}",
                manifest.id,
                target.display()
            )
        })?;
        if source.contains(&patch.marker) {
            continue;
        }
        if !source.contains(&patch.before) {
            return Err(format!(
                "{} is incompatible with the installed package; expected anchor is missing in {}",
                manifest.id,
                target.display()
            ));
        }
        write_text_atomic(&target, &source.replacen(&patch.before, &patch.after, 1))?;
        changed += 1;
    }
    Ok(changed)
}

fn apply_harness_overlays(roots: &[PathBuf]) -> Result<usize, String> {
    let manifest: OverlayManifest =
        serde_json::from_str(OVERLAY_JSON).map_err(|error| error.to_string())?;
    roots.iter().try_fold(0, |total, root| {
        apply_overlay(root, &manifest).map(|count| total + count)
    })
}

fn package_extension_enabled(spec: &Value) -> bool {
    spec.as_object()
        .and_then(|object| object.get("extensions"))
        .and_then(Value::as_array)
        .is_none_or(|items| !items.is_empty())
}

fn configured_harness_source(settings_path: &Path) -> Option<String> {
    let settings: Value = serde_json::from_str(&fs::read_to_string(settings_path).ok()?).ok()?;
    settings
        .get("packages")
        .and_then(Value::as_array)?
        .iter()
        .filter(|spec| package_extension_enabled(spec))
        .filter_map(|spec| {
            spec.as_str()
                .or_else(|| spec.get("source").and_then(Value::as_str))
        })
        .find(|source| is_harness_core(source))
        .map(str::to_string)
}

fn expected_harness_source(agent_root: &Path, cwd: &Path) -> Option<String> {
    configured_harness_source(&cwd.join(".pi").join("settings.json"))
        .or_else(|| configured_harness_source(&agent_root.join("settings.json")))
}

fn configured_extension_sources(settings_path: &Path) -> Vec<(String, Option<String>)> {
    let Some(packages) = fs::read_to_string(settings_path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|settings| settings.get("packages").and_then(Value::as_array).cloned())
    else {
        return Vec::new();
    };
    packages
        .iter()
        .filter_map(|spec| {
            let source = setting_source(spec)?;
            Some((
                source_name(source),
                package_extension_enabled(spec).then(|| source.to_string()),
            ))
        })
        .collect()
}

fn active_extension_sources(agent_root: &Path, cwd: &Path) -> HashMap<String, String> {
    let mut active = HashMap::new();
    for settings in [
        agent_root.join("settings.json"),
        cwd.join(".pi").join("settings.json"),
    ] {
        for (name, source) in configured_extension_sources(&settings) {
            match source {
                Some(source) => {
                    active.insert(name, source);
                }
                None => {
                    active.remove(&name);
                }
            }
        }
    }
    active
}

fn source_info(value: &Value) -> Option<&str> {
    value
        .get("sourceInfo")
        .and_then(|info| info.get("source"))
        .and_then(Value::as_str)
        .or_else(|| value.get("source").and_then(Value::as_str))
}

fn verify_harness_surface(
    commands: &[Value],
    tools: &[Value],
    expected_source: Option<&str>,
) -> Result<(), String> {
    let Some(expected) = expected_source else {
        return Ok(());
    };
    for name in ["pi-rewind", "pi-workflow", "pi-task", "pi-branch-return"] {
        let command = commands
            .iter()
            .find(|command| command.get("name").and_then(Value::as_str) == Some(name))
            .ok_or_else(|| format!("harness command disappeared after extension change: {name}"))?;
        if source_info(command) != Some(expected) {
            return Err(format!(
                "harness command conflict for {name}: {:?}, expected {expected}",
                source_info(command)
            ));
        }
    }
    let preview = tools
        .iter()
        .find(|tool| tool.get("name").and_then(Value::as_str) == Some("live_preview"))
        .ok_or("harness tool disappeared after extension change: live_preview")?;
    if source_info(preview) != Some(expected) {
        return Err(format!(
            "harness tool conflict for live_preview: {:?}, expected {expected}",
            source_info(preview)
        ));
    }
    Ok(())
}

fn verify_extension_contracts(
    commands: &[Value],
    tools: &[Value],
    active: &HashMap<String, String>,
) -> Result<(), String> {
    for contract in EXTENSION_CONTRACTS {
        let Some(expected) = active.get(contract.package) else {
            continue;
        };
        for name in contract.commands {
            let command = commands
                .iter()
                .find(|command| command.get("name").and_then(Value::as_str) == Some(*name))
                .ok_or_else(|| {
                    format!(
                        "{} no longer provides required command {name}",
                        contract.package
                    )
                })?;
            if source_info(command) != Some(expected.as_str()) {
                return Err(format!(
                    "command conflict for {name}: {:?}, expected {expected}",
                    source_info(command)
                ));
            }
        }
        for name in contract.tools {
            let tool = tools
                .iter()
                .find(|tool| tool.get("name").and_then(Value::as_str) == Some(*name))
                .ok_or_else(|| {
                    format!(
                        "{} no longer provides required tool {name}",
                        contract.package
                    )
                })?;
            if source_info(tool) != Some(expected.as_str()) {
                return Err(format!(
                    "tool conflict for {name}: {:?}, expected {expected}",
                    source_info(tool)
                ));
            }
        }
    }
    Ok(())
}

fn consume_health_event(wire: &mut HealthWire, event: Value) {
    if event.get("type").and_then(Value::as_str) == Some("response")
        && event.get("id").and_then(Value::as_str) == Some("extension-health-commands")
    {
        if event.get("success").and_then(Value::as_bool) != Some(true) {
            wire.protocol_errors.push(
                event
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("get_commands failed")
                    .to_string(),
            );
        } else {
            wire.commands = event
                .pointer("/data/commands")
                .and_then(Value::as_array)
                .cloned();
        }
    }
    if event.get("type").and_then(Value::as_str) == Some("extension_ui_request")
        && event.get("method").and_then(Value::as_str) == Some("setWidget")
        && event.get("widgetKey").and_then(Value::as_str) == Some(HEALTH_WIDGET)
    {
        let text = event
            .get("widgetLines")
            .and_then(Value::as_array)
            .map(|lines| {
                lines
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        match serde_json::from_str::<Vec<Value>>(&text) {
            Ok(tools) => wire.tools = Some(tools),
            Err(error) => wire
                .protocol_errors
                .push(format!("invalid tool probe: {error}")),
        }
    }
    if matches!(
        event.get("type").and_then(Value::as_str),
        Some("extension_error" | "error")
    ) {
        wire.protocol_errors.push(event.to_string());
    }
}

async fn stop_health_child(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
    }
    #[cfg(not(unix))]
    let _ = child.start_kill();
    if tokio::time::timeout(Duration::from_secs(2), child.wait())
        .await
        .is_err()
    {
        #[cfg(unix)]
        if let Some(pid) = child.id() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}

async fn validate_extension_runtime(
    agent_root: &Path,
    cwd: &Path,
    scratch: &Path,
) -> Result<HealthReport, String> {
    let pi = find_pi_binary().ok_or("pi binary not found")?;
    fs::create_dir_all(scratch).map_err(|error| error.to_string())?;
    let probe = scratch.join("extension-health-probe.mjs");
    fs::write(
        &probe,
        format!(
            "export default function(pi){{pi.on('session_start',(_event,ctx)=>ctx.ui.setWidget('{}',[JSON.stringify(pi.getAllTools().map(tool=>({{name:tool.name,source:tool.sourceInfo?.source}}))) ]));}}\n",
            HEALTH_WIDGET
        ),
    )
    .map_err(|error| error.to_string())?;

    let mut command = Command::new(pi);
    command
        .args([
            "--mode",
            "rpc",
            "--no-session",
            "--offline",
            "--no-context-files",
            "--no-skills",
            "--approve",
            "--extension",
        ])
        .arg(&probe)
        .current_dir(cwd)
        .env("PATH", child_path())
        .env("NO_COLOR", "1")
        .env("PI_APP_EXTENSION_HEALTH", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            libc::setpgid(0, 0);
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("extension health process failed to start: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("extension health stdin missing")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("extension health stdout missing")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("extension health stderr missing")?;
    stdin
        .write_all(b"{\"id\":\"extension-health-commands\",\"type\":\"get_commands\"}\n")
        .await
        .map_err(|error| error.to_string())?;
    stdin.flush().await.map_err(|error| error.to_string())?;

    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut text = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if text.len() < 64_000 {
                text.push_str(&line);
                text.push('\n');
            }
        }
        text
    });
    let read_result = tokio::time::timeout(HEALTH_TIMEOUT, async {
        let mut lines = BufReader::new(stdout).lines();
        let mut wire = HealthWire::default();
        while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
            if let Ok(event) = serde_json::from_str::<Value>(&line) {
                consume_health_event(&mut wire, event);
            }
            if wire.commands.is_some() && wire.tools.is_some() {
                return Ok::<_, String>(wire);
            }
            if !wire.protocol_errors.is_empty() {
                return Err(wire.protocol_errors.join("; "));
            }
        }
        Err("extension health process exited before reporting its surface".into())
    })
    .await;
    stop_health_child(&mut child).await;
    let stderr = stderr_task.await.unwrap_or_default();
    let wire = read_result.map_err(|_| "extension health check timed out".to_string())??;
    let fatal_stderr = [
        "failed to load extension",
        "error loading extension",
        "syntaxerror",
        "err_module_not_found",
        "cannot find module",
    ]
    .into_iter()
    .find(|needle| stderr.to_ascii_lowercase().contains(needle));
    if let Some(needle) = fatal_stderr {
        return Err(format!(
            "extension runtime reported {needle}: {}",
            stderr.trim().chars().take(4_000).collect::<String>()
        ));
    }
    let commands = wire.commands.unwrap_or_default();
    let tools = wire.tools.unwrap_or_default();
    verify_harness_surface(
        &commands,
        &tools,
        expected_harness_source(agent_root, cwd).as_deref(),
    )?;
    verify_extension_contracts(
        &commands,
        &tools,
        &active_extension_sources(agent_root, cwd),
    )?;
    Ok(HealthReport {
        command_count: commands.len(),
        tool_count: tools.len(),
    })
}

async fn run_transaction<R: Runtime>(
    app: AppHandle<R>,
    run_id: String,
    mut args: Vec<String>,
    requested_cwd: Option<String>,
) -> Result<(), String> {
    approve_explicit_project_mutation(&mut args, requested_cwd.as_deref());
    let agent_root = agent_dir();
    let recovered = recover_pending_in(&agent_root)?;
    if recovered > 0 {
        emit_cli_line(
            &app,
            &run_id,
            "out",
            format!("Восстановлено незавершённых extension-транзакций: {recovered}"),
        );
    }
    let project_cwd = requested_cwd.as_deref().map(Path::new);
    let roots = package_roots(&args, project_cwd, &agent_root);
    let mut snapshot = Snapshot::create(&agent_root, snapshot_paths(&roots))?;
    snapshot.set_status("mutating")?;
    emit_cli_line(
        &app,
        &run_id,
        "out",
        format!(
            "Extension transaction {}: snapshot ready",
            snapshot.journal.id
        ),
    );
    let effective_cwd = match requested_cwd {
        Some(cwd) => cwd,
        None => management_cwd(&agent_root)?.to_string_lossy().into_owned(),
    };
    let command_code = match run_pi_process(
        app.clone(),
        run_id.clone(),
        args,
        Some(effective_cwd.clone()),
        vec![
            ("PI_APP_EXTENSION_TRANSACTION".into(), "1".into()),
            // Community package lifecycle scripts execute before an extension
            // can be health-checked and cannot be undone by a filesystem
            // rollback if they write elsewhere. Pi extensions are runtime
            // modules, so install hooks are disabled for managed operations.
            ("npm_config_ignore_scripts".into(), "true".into()),
            ("NPM_CONFIG_IGNORE_SCRIPTS".into(), "true".into()),
        ],
    )
    .await
    {
        Ok(code) => code,
        Err(error) => {
            snapshot.rollback()?;
            return Err(format!(
                "Pi package command could not run: {error}; previous generation restored"
            ));
        }
    };
    if command_code != 0 {
        snapshot.rollback()?;
        return Err(format!(
            "Pi package command failed with code {command_code}; previous generation restored"
        ));
    }
    snapshot.set_status("adapting")?;
    let overlay_count = match apply_harness_overlays(&roots) {
        Ok(count) => count,
        Err(error) => {
            snapshot.rollback()?;
            return Err(format!(
                "Harness compatibility overlay rejected the update: {error}. Previous generation restored"
            ));
        }
    };
    emit_cli_line(
        &app,
        &run_id,
        "out",
        format!("Harness overlays verified ({overlay_count} applied)"),
    );
    snapshot.set_status("validating")?;
    let health = match validate_extension_runtime(
        &agent_root,
        Path::new(&effective_cwd),
        &snapshot.dir.join("health"),
    )
    .await
    {
        Ok(report) => report,
        Err(error) => {
            snapshot.rollback()?;
            return Err(format!(
                "Extension health gate failed: {error}. Previous generation restored"
            ));
        }
    };
    emit_cli_line(
        &app,
        &run_id,
        "out",
        format!(
            "Extension health gate passed: {} commands, {} tools",
            health.command_count, health.tool_count
        ),
    );
    snapshot.commit()?;
    if let Ok(mut blocker) = STARTUP_OVERLAY_BLOCK.lock() {
        *blocker = None;
    }
    Ok(())
}

pub async fn start_extension_mutation<R: Runtime>(
    app: AppHandle<R>,
    sup: &Supervisor<R>,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    validate_management_args(&args, cwd.as_deref())?;
    if combined_self_and_extension_update(&args) {
        return Err(
            "Совмещённое обновление Pi и extensions запрещено: обновите их отдельными транзакциями"
                .into(),
        );
    }
    if mutation_removes_harness(&args) {
        return Err(
            "harness-extension является ядром приложения и не может быть удалён через Library"
                .into(),
        );
    }
    let lifecycle_lock = acquire_lifecycle_lock().await?;
    let lease = sup.begin_extension_mutation()?;
    let restarted = match sup.quiesce_extension_hosts().await {
        Ok(count) => count,
        Err(error) => {
            drop(lease);
            return Err(error);
        }
    };
    let run_id = next_run_id();
    let task_run_id = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let _lifecycle_lock = lifecycle_lock;
        let _lease: ExtensionMutationLease = lease;
        if restarted > 0 {
            emit_cli_line(
                &app,
                &task_run_id,
                "out",
                format!("Перезапущено idle extension hosts: {restarted}"),
            );
        }
        let code = match run_transaction(app.clone(), task_run_id.clone(), args, cwd).await {
            Ok(()) => 0,
            Err(error) => {
                emit_cli_line(&app, &task_run_id, "err", error);
                1
            }
        };
        emit_cli_done(&app, &task_run_id, code);
    });
    Ok(run_id)
}

fn setting_source(spec: &Value) -> Option<&str> {
    spec.as_str()
        .or_else(|| spec.get("source").and_then(Value::as_str))
}

fn set_resource_filter(
    content: &str,
    package_identifier: &str,
    kind: &str,
    enabled: bool,
) -> Result<String, String> {
    let key = match kind {
        "extension" => "extensions",
        "skill" => "skills",
        "theme" => "themes",
        "prompt" => "prompts",
        _ => return Err(format!("unsupported package resource kind: {kind}")),
    };
    let mut settings: Value =
        serde_json::from_str(content).map_err(|error| format!("invalid settings JSON: {error}"))?;
    let packages = settings
        .get_mut("packages")
        .and_then(Value::as_array_mut)
        .ok_or("settings.json has no packages array")?;
    let mut matched = false;
    for spec in packages.iter_mut() {
        let Some(source) = setting_source(spec) else {
            continue;
        };
        if source != package_identifier && source_name(source) != package_identifier {
            continue;
        }
        matched = true;
        if kind == "extension" && !enabled && is_harness_core(source) {
            return Err(
                "harness-extension является ядром приложения и не может быть отключён".into(),
            );
        }
        let source = source.to_string();
        let mut object = spec.as_object().cloned().unwrap_or_else(|| {
            serde_json::Map::from_iter([("source".into(), Value::String(source.clone()))])
        });
        if enabled {
            object.remove(key);
        } else {
            object.insert(key.into(), Value::Array(Vec::new()));
        }
        if object.len() == 1 && object.get("source").and_then(Value::as_str) == Some(&source) {
            *spec = Value::String(source);
        } else {
            *spec = Value::Object(object);
        }
    }
    if !matched {
        return Err(format!("package is not configured: {package_identifier}"));
    }
    serde_json::to_string_pretty(&settings)
        .map(|text| text + "\n")
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn set_extension_resource_enabled(
    sup: State<'_, Supervisor<tauri::Wry>>,
    scope: String,
    cwd: Option<String>,
    package_identifier: String,
    kind: String,
    enabled: bool,
) -> Result<String, String> {
    set_extension_resource_enabled_impl(&sup, scope, cwd, package_identifier, kind, enabled).await
}

pub async fn set_extension_resource_enabled_impl<R: Runtime>(
    sup: &Supervisor<R>,
    scope: String,
    cwd: Option<String>,
    package_identifier: String,
    kind: String,
    enabled: bool,
) -> Result<String, String> {
    let _lifecycle_lock = acquire_lifecycle_lock().await?;
    let agent_root = agent_dir();
    recover_pending_in(&agent_root)?;
    let settings_path = match scope.as_str() {
        "global" => agent_root.join("settings.json"),
        "project" => {
            let cwd = cwd.as_deref().ok_or("project scope requires a workspace")?;
            let root = Path::new(cwd);
            if !root.is_dir() {
                return Err("workspace для project scope не существует".into());
            }
            root.join(".pi").join("settings.json")
        }
        _ => return Err("scope must be global or project".into()),
    };
    let content = fs::read_to_string(&settings_path).unwrap_or_else(|_| "{}".into());
    let next = set_resource_filter(&content, &package_identifier, &kind, enabled)?;
    let lease = sup.begin_extension_mutation()?;
    sup.quiesce_extension_hosts().await?;
    let snapshot = Snapshot::create(&agent_root, vec![settings_path.clone()])?;
    if let Err(error) = crate::config::write_json_atomic(&settings_path, &next) {
        let _ = snapshot.rollback();
        drop(lease);
        return Err(error);
    }
    let health_cwd = match cwd.as_deref() {
        Some(cwd) => PathBuf::from(cwd),
        None => match management_cwd(&agent_root) {
            Ok(path) => path,
            Err(error) => {
                snapshot.rollback()?;
                drop(lease);
                return Err(error);
            }
        },
    };
    match validate_extension_runtime(&agent_root, &health_cwd, &snapshot.dir.join("health")).await {
        Ok(_) => snapshot.commit()?,
        Err(error) => {
            snapshot.rollback()?;
            drop(lease);
            return Err(format!(
                "Изменение отключено проверкой совместимости: {error}. Настройки восстановлены"
            ));
        }
    }
    drop(lease);
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    static TEST_AGENT_ENV_LOCK: LazyLock<Arc<tokio::sync::Mutex<()>>> =
        LazyLock::new(|| Arc::new(tokio::sync::Mutex::new(())));

    struct AgentDirEnv {
        _lock: tokio::sync::OwnedMutexGuard<()>,
        app: Option<std::ffi::OsString>,
        pi: Option<std::ffi::OsString>,
    }

    impl AgentDirEnv {
        async fn current() -> Self {
            Self {
                _lock: TEST_AGENT_ENV_LOCK.clone().lock_owned().await,
                app: std::env::var_os("PI_APP_AGENT_DIR"),
                pi: std::env::var_os("PI_CODING_AGENT_DIR"),
            }
        }

        async fn set(path: &Path) -> Self {
            let previous = Self::current().await;
            std::env::set_var("PI_APP_AGENT_DIR", path);
            std::env::set_var("PI_CODING_AGENT_DIR", path);
            previous
        }
    }

    impl Drop for AgentDirEnv {
        fn drop(&mut self) {
            match self.app.take() {
                Some(value) => std::env::set_var("PI_APP_AGENT_DIR", value),
                None => std::env::remove_var("PI_APP_AGENT_DIR"),
            }
            match self.pi.take() {
                Some(value) => std::env::set_var("PI_CODING_AGENT_DIR", value),
                None => std::env::remove_var("PI_CODING_AGENT_DIR"),
            }
        }
    }

    #[test]
    fn classifies_only_package_mutations() {
        let args = |items: &[&str]| {
            items
                .iter()
                .map(|item| item.to_string())
                .collect::<Vec<_>>()
        };
        assert!(is_extension_mutation(&args(&["install", "npm:one"])));
        assert!(is_extension_mutation(&args(&["update", "--extensions"])));
        assert!(is_extension_mutation(&args(&[
            "update",
            "--extension",
            "npm:one"
        ])));
        assert!(is_extension_mutation(&args(&["update", "npm:one"])));
        assert!(!is_extension_mutation(&args(&["update", "--self"])));
        assert!(!is_extension_mutation(&args(&["update", "--models"])));
        assert!(!is_extension_mutation(&args(&["list"])));
    }

    #[test]
    fn resource_filters_preserve_other_package_capabilities() {
        let input = r#"{"packages":["npm:multi",{"source":"npm:other","skills":[]}]}"#;
        let disabled = set_resource_filter(input, "multi", "extension", false).unwrap();
        let value: Value = serde_json::from_str(&disabled).unwrap();
        assert_eq!(
            value.pointer("/packages/0/extensions"),
            Some(&Value::Array(Vec::new()))
        );
        let enabled = set_resource_filter(&disabled, "npm:multi", "extension", true).unwrap();
        let value: Value = serde_json::from_str(&enabled).unwrap();
        assert_eq!(
            value.pointer("/packages/0"),
            Some(&Value::String("npm:multi".into()))
        );
        assert_eq!(
            value.pointer("/packages/1/skills"),
            Some(&Value::Array(Vec::new()))
        );
    }

    #[test]
    fn core_harness_cannot_be_disabled() {
        let input = r#"{"packages":["../../repo/harness-extension"]}"#;
        assert!(
            set_resource_filter(input, "harness-extension", "extension", false)
                .unwrap_err()
                .contains("ядром")
        );
    }

    #[test]
    fn known_harness_capability_conflicts_fail_closed() {
        let commands = vec![serde_json::json!({
            "name": "agents",
            "sourceInfo": { "source": "npm:shadow-extension" }
        })];
        let tools = ["Agent", "get_subagent_result", "steer_subagent"]
            .into_iter()
            .map(|name| {
                serde_json::json!({
                    "name": name,
                    "source": "npm:@tintinweb/pi-subagents"
                })
            })
            .collect::<Vec<_>>();
        let active = HashMap::from([(
            "@tintinweb/pi-subagents".into(),
            "npm:@tintinweb/pi-subagents".into(),
        )]);
        assert!(verify_extension_contracts(&commands, &tools, &active)
            .unwrap_err()
            .contains("command conflict"));
    }

    #[test]
    fn declarative_overlay_is_idempotent_and_fails_closed() {
        let temp = tempdir().unwrap();
        let manifest: OverlayManifest = serde_json::from_str(OVERLAY_JSON).unwrap();
        let package = temp.path().join(&manifest.package_root);
        for patch in &manifest.patches {
            let target = package.join(&patch.path);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(&target, format!("prefix\n{}\nsuffix\n", patch.before)).unwrap();
        }
        assert_eq!(
            apply_overlay(temp.path(), &manifest).unwrap(),
            manifest.patches.len()
        );
        assert_eq!(apply_overlay(temp.path(), &manifest).unwrap(), 0);
        let target = package.join(&manifest.patches[0].path);
        fs::write(&target, "unknown upstream").unwrap();
        assert!(apply_overlay(temp.path(), &manifest)
            .unwrap_err()
            .contains("expected anchor"));
    }

    #[test]
    fn snapshot_rolls_back_files_directories_and_absence() {
        let temp = tempdir().unwrap();
        let agent = temp.path().join(".pi").join("agent");
        fs::create_dir_all(agent.join("npm")).unwrap();
        fs::write(agent.join("settings.json"), "old").unwrap();
        fs::write(agent.join("npm").join("old.txt"), "old").unwrap();
        let missing = agent.join("git");
        let snapshot = Snapshot::create(
            &agent,
            vec![
                agent.join("settings.json"),
                agent.join("npm"),
                missing.clone(),
            ],
        )
        .unwrap();
        fs::write(agent.join("settings.json"), "new").unwrap();
        fs::remove_dir_all(agent.join("npm")).unwrap();
        fs::create_dir_all(&missing).unwrap();
        fs::write(missing.join("new.txt"), "new").unwrap();
        snapshot.rollback().unwrap();
        assert_eq!(
            fs::read_to_string(agent.join("settings.json")).unwrap(),
            "old"
        );
        assert_eq!(
            fs::read_to_string(agent.join("npm").join("old.txt")).unwrap(),
            "old"
        );
        assert!(!missing.exists());
    }

    #[test]
    fn crash_recovery_restores_prepared_generation() {
        let temp = tempdir().unwrap();
        let agent = temp.path().join(".pi").join("agent");
        fs::create_dir_all(&agent).unwrap();
        let settings = agent.join("settings.json");
        fs::write(&settings, "old").unwrap();
        let snapshot = Snapshot::create(&agent, vec![settings.clone()]).unwrap();
        fs::write(&settings, "new").unwrap();
        std::mem::forget(snapshot);
        assert_eq!(recover_pending_in(&agent).unwrap(), 1);
        assert_eq!(fs::read_to_string(settings).unwrap(), "old");
    }

    #[test]
    fn interprocess_lock_reclaims_stale_owner_and_rejects_live_owner() {
        let temp = tempdir().unwrap();
        let path = temp.path().join(PROCESS_LOCK);
        fs::write(&path, "999999999\n").unwrap();
        let lock = acquire_process_lock(temp.path()).unwrap();
        drop(lock);
        fs::write(&path, format!("{}\n", std::process::id())).unwrap();
        assert!(acquire_process_lock(temp.path())
            .unwrap_err()
            .contains("другом окне"));
        fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    #[ignore = "requires the user's installed Pi runtime and extensions"]
    async fn live_extension_health_gate_loads_the_real_harness_surface() {
        let _env = AgentDirEnv::current().await;
        let workspace = tempdir().unwrap();
        let scratch = tempdir().unwrap();
        let report = validate_extension_runtime(&agent_dir(), workspace.path(), scratch.path())
            .await
            .unwrap();
        assert!(report.command_count > 0);
        assert!(report.tool_count > 0);
    }

    #[tokio::test]
    #[ignore = "spawns the installed Pi CLI in an isolated agent root"]
    async fn real_transaction_installs_valid_extension_and_commits() {
        let temp = tempdir().unwrap();
        let agent = temp.path().join("agent");
        let extension = temp.path().join("fixture-extension.mjs");
        fs::create_dir_all(&agent).unwrap();
        fs::write(agent.join("settings.json"), "{\"packages\":[]}\n").unwrap();
        fs::write(
            &extension,
            "export default function(pi){pi.registerCommand('fixture-ok',{description:'fixture',handler:async()=>{}});}\n",
        )
        .unwrap();
        let _env = AgentDirEnv::set(&agent).await;
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let supervisor = Supervisor::new(app.handle().clone());
        run_transaction(
            app.handle().clone(),
            "test-valid".into(),
            vec!["install".into(), extension.to_string_lossy().into_owned()],
            None,
        )
        .await
        .unwrap();
        let settings = fs::read_to_string(agent.join("settings.json")).unwrap();
        assert!(
            settings.contains("fixture-extension.mjs"),
            "unexpected settings after commit: {settings}"
        );
        let disabled = set_extension_resource_enabled_impl(
            &supervisor,
            "global".into(),
            None,
            "fixture-extension.mjs".into(),
            "extension".into(),
            false,
        )
        .await
        .unwrap();
        let disabled: Value = serde_json::from_str(&disabled).unwrap();
        assert_eq!(
            disabled.pointer("/packages/0/extensions"),
            Some(&Value::Array(Vec::new()))
        );
        set_extension_resource_enabled_impl(
            &supervisor,
            "global".into(),
            None,
            "fixture-extension.mjs".into(),
            "extension".into(),
            true,
        )
        .await
        .unwrap();
        run_transaction(
            app.handle().clone(),
            "test-remove".into(),
            vec!["remove".into(), extension.to_string_lossy().into_owned()],
            None,
        )
        .await
        .unwrap();
        assert!(!fs::read_to_string(agent.join("settings.json"))
            .unwrap()
            .contains("fixture-extension.mjs"));
        assert_eq!(
            fs::read_dir(agent.join(TRANSACTION_DIR))
                .map(|entries| entries.count())
                .unwrap_or(0),
            0
        );
    }

    #[tokio::test]
    #[ignore = "spawns the installed Pi CLI in an isolated agent root"]
    async fn incompatible_vendor_update_rolls_back_the_complete_generation() {
        let temp = tempdir().unwrap();
        let agent = temp.path().join("agent");
        let extension = temp.path().join("fixture-extension.mjs");
        let package = agent.join("npm/node_modules/@tintinweb/pi-subagents/src");
        fs::create_dir_all(&package).unwrap();
        let initial = "{\"packages\":[\"npm:@tintinweb/pi-subagents\"]}\n";
        fs::write(agent.join("settings.json"), initial).unwrap();
        fs::write(package.join("agent-runner.ts"), "unknown upstream").unwrap();
        fs::write(package.join("prompts.ts"), "unknown upstream").unwrap();
        fs::write(
            &extension,
            "export default function(pi){pi.registerCommand('fixture-rollback',{description:'fixture',handler:async()=>{}});}\n",
        )
        .unwrap();
        let _env = AgentDirEnv::set(&agent).await;
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let error = run_transaction(
            app.handle().clone(),
            "test-rollback".into(),
            vec!["install".into(), extension.to_string_lossy().into_owned()],
            None,
        )
        .await
        .unwrap_err();
        assert!(error.contains("compatibility overlay rejected"));
        assert_eq!(
            fs::read_to_string(agent.join("settings.json")).unwrap(),
            initial
        );
        assert_eq!(
            fs::read_dir(agent.join(TRANSACTION_DIR))
                .map(|entries| entries.count())
                .unwrap_or(0),
            0
        );
    }

    #[tokio::test]
    #[ignore = "spawns the installed Pi CLI in isolated global/project roots"]
    async fn project_scoped_install_and_disable_never_touch_global_packages() {
        let temp = tempdir().unwrap();
        let agent = temp.path().join("agent");
        let workspace = temp.path().join("workspace");
        let extension = temp.path().join("project-extension.mjs");
        fs::create_dir_all(workspace.join(".pi")).unwrap();
        fs::create_dir_all(&agent).unwrap();
        fs::write(agent.join("settings.json"), "{\"packages\":[]}\n").unwrap();
        fs::write(workspace.join(".pi/settings.json"), "{\"packages\":[]}\n").unwrap();
        fs::write(
            &extension,
            "export default function(pi){pi.registerCommand('project-fixture',{description:'fixture',handler:async()=>{}});}\n",
        )
        .unwrap();
        let _env = AgentDirEnv::set(&agent).await;
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let supervisor = Supervisor::new(app.handle().clone());
        run_transaction(
            app.handle().clone(),
            "test-project-install".into(),
            vec![
                "install".into(),
                "-l".into(),
                extension.to_string_lossy().into_owned(),
            ],
            Some(workspace.to_string_lossy().into_owned()),
        )
        .await
        .unwrap();
        assert!(fs::read_to_string(workspace.join(".pi/settings.json"))
            .unwrap()
            .contains("project-extension.mjs"));
        assert_eq!(
            fs::read_to_string(agent.join("settings.json")).unwrap(),
            "{\"packages\":[]}\n"
        );
        let disabled = set_extension_resource_enabled_impl(
            &supervisor,
            "project".into(),
            Some(workspace.to_string_lossy().into_owned()),
            "project-extension.mjs".into(),
            "extension".into(),
            false,
        )
        .await
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&disabled)
                .unwrap()
                .pointer("/packages/0/extensions"),
            Some(&Value::Array(Vec::new()))
        );
    }

    #[tokio::test]
    #[ignore = "downloads package updates into an isolated APFS clone"]
    async fn real_three_package_update_passes_transaction_and_overlay_gate() {
        let source_agent = agent_dir();
        let temp = tempdir().unwrap();
        let agent = temp.path().join("agent");
        fs::create_dir_all(&agent).unwrap();
        clone_tree(&source_agent.join("npm"), &agent.join("npm")).unwrap();
        fs::write(
            agent.join("settings.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "packages": [
                    "npm:@juicesharp/rpiv-ask-user-question",
                    "npm:@juicesharp/rpiv-todo",
                    "npm:@tintinweb/pi-subagents"
                ]
            }))
            .unwrap()
                + "\n",
        )
        .unwrap();
        let _env = AgentDirEnv::set(&agent).await;
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        run_transaction(
            app.handle().clone(),
            "test-three-updates".into(),
            vec!["update".into(), "--extensions".into()],
            None,
        )
        .await
        .unwrap();
        for (name, expected) in [
            ("@juicesharp/rpiv-ask-user-question", "2.1.0"),
            ("@juicesharp/rpiv-todo", "2.1.0"),
            ("@tintinweb/pi-subagents", "0.14.3"),
        ] {
            let package: Value = serde_json::from_str(
                &fs::read_to_string(
                    agent
                        .join("npm/node_modules")
                        .join(name)
                        .join("package.json"),
                )
                .unwrap(),
            )
            .unwrap();
            assert_eq!(
                package.get("version").and_then(Value::as_str),
                Some(expected),
                "{name} did not update to the reviewed version"
            );
        }
        let runner = fs::read_to_string(
            agent.join("npm/node_modules/@tintinweb/pi-subagents/src/agent-runner.ts"),
        )
        .unwrap();
        assert!(runner.contains("pi-app worktree cwd rebase"));
    }
}
