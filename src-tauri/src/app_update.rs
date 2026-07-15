use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

static RUN_COUNTER: AtomicU64 = AtomicU64::new(1);
static RUNNING_GROUPS: LazyLock<Mutex<std::collections::HashSet<u32>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

/// App-exit cleanup for git/npm/cargo/ditto and their descendants.
pub fn stop_all_runs() {
    let pids: Vec<u32> = RUNNING_GROUPS
        .lock()
        .map(|mut s| s.drain().collect())
        .unwrap_or_default();
    #[cfg(unix)]
    {
        for pid in &pids {
            unsafe { libc::kill(-(*pid as i32), libc::SIGTERM) };
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        for pid in pids {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
}

/// Версия текущей сборки (из Cargo) + встроенный git-sha (из build.rs).
fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
fn current_sha() -> String {
    option_env!("PI_APP_GIT_SHA")
        .unwrap_or("unknown")
        .to_string()
}

/// Каталог исходников, из которого собрано приложение (родитель src-tauri).
fn embedded_source_repo() -> Option<PathBuf> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest.parent().map(|p| p.to_path_buf())
}

/// owner/repo для GitHub API: из origin-remote исходников, иначе — репозиторий проекта.
async fn repo_slug(source_repo: &Path) -> String {
    if let Ok(out) = Command::new("git")
        .args([
            "-C",
            &source_repo.to_string_lossy(),
            "remote",
            "get-url",
            "origin",
        ])
        .output()
        .await
    {
        if out.status.success() {
            let url = String::from_utf8_lossy(&out.stdout);
            if let Some((_, web)) = crate::gitops::remote_web_base(url.trim()) {
                // web = https://host/owner/repo
                if let Some(path) = web.splitn(4, '/').nth(3) {
                    if !path.is_empty() {
                        return path.to_string();
                    }
                }
            }
        }
    }
    "NickLitwinow/pi-app".to_string()
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub current_sha: String,
    pub source_repo: Option<String>,
    /// Есть ли валидный каталог исходников для локального ребилда.
    pub source_repo_valid: bool,
    pub latest: Option<String>,
    /// "release" | "commit" | "none"
    pub latest_kind: String,
    pub notes: String,
    pub html_url: String,
    /// Готовый macOS .dmg из GitHub Releases. Если есть, приложение можно
    /// скачать и установить в фоне без локальной сборки и ручного drag&drop.
    pub asset_url: Option<String>,
    pub update_available: bool,
    /// Удалось ли определить статус (локальный git или GitHub).
    pub checked: bool,
    /// Коммитов позади/впереди upstream (локальный git-путь; 0 в fallback).
    pub behind: u64,
    pub ahead: u64,
    /// Незакоммиченные правки пользователя: `git pull --ff-only` их не переживёт,
    /// а трогать их мы не имеем права — сборку из исходников надо блокировать.
    pub dirty_files: Vec<String>,
    /// Испорченные пайплайном артефакты сборки — откатим сами (с бэкапом).
    pub auto_resettable_files: Vec<String>,
    /// Ветки разошлись (ahead>0 && behind>0) — ff-only невозможен в принципе.
    pub diverged: bool,
    pub error: Option<String>,
}

fn release_dmg(v: &Value) -> Option<String> {
    let assets = v.get("assets")?.as_array()?;
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x64"
    };
    assets
        .iter()
        .filter_map(|asset| {
            let name = asset.get("name")?.as_str()?.to_ascii_lowercase();
            let url = asset.get("browser_download_url")?.as_str()?.to_string();
            name.ends_with(".dmg").then_some((name, url))
        })
        .max_by_key(|(name, _)| {
            if name.contains(arch) {
                3
            } else if name.contains("universal") {
                2
            } else {
                1
            }
        })
        .map(|(_, url)| url)
}

/// GET к GitHub API через системный curl (не тянем HTTP-стек в бинарь).
async fn github_get(url: &str) -> Result<(u16, String), String> {
    let out = Command::new("/usr/bin/curl")
        .args([
            "-sSL",
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            "User-Agent: pi-app-updater",
            "--max-time",
            "15",
            "-w",
            "\n%{http_code}",
            url,
        ])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let body = String::from_utf8_lossy(&out.stdout).into_owned();
    let (json, code) = body.rsplit_once('\n').unwrap_or((body.as_str(), ""));
    let status: u16 = code.trim().parse().unwrap_or(0);
    Ok((status, json.to_string()))
}

/// Запустить git в `repo`, вернуть stdout как есть при коде 0.
async fn git_capture_raw(repo: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        None
    }
}

/// То же, но trimmed — удобно для одиночных значений (sha, имя ветки).
/// ВНИМАНИЕ: для `status --porcelain` не годится — trim съедает ведущий пробел
/// статуса первой строки (`" M path"`), и разбор уезжает на символ.
async fn git_capture(repo: &Path, args: &[&str]) -> Option<String> {
    git_capture_raw(repo, args)
        .await
        .map(|out| out.trim().to_string())
}

/// Upstream-ref, который отслеживает репозиторий: @{upstream} текущей ветки,
/// иначе — ветка по умолчанию origin (origin/HEAD). Напр. "origin/main".
async fn upstream_ref(repo: &Path) -> Option<String> {
    if let Some(u) = git_capture(
        repo,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .await
    {
        if !u.is_empty() && u != "@{upstream}" {
            return Some(u);
        }
    }
    git_capture(repo, &["rev-parse", "--abbrev-ref", "origin/HEAD"])
        .await
        .filter(|s| !s.is_empty() && s != "origin/HEAD")
}

struct LocalStatus {
    behind: u64,
    ahead: u64,
    up_sha: String,
    notes: String,
    dirty: Vec<String>,
    auto_resettable: Vec<String>,
}

/// Файлы, которые портит сам пайплайн обновления: `npm install` переписывал
/// package-lock.json, `tauri build` — Cargo.lock. Оба затрекано в git, поэтому
/// СЛЕДУЮЩИЙ `git pull --ff-only` падал с «Your local changes to the following
/// files would be overwritten by merge» — первое обновление у пользователя
/// проходило, все последующие нет. Шаг npm переведён на `npm ci` (lockfile не
/// трогает), а уже испорченные копии чиним откатом с бэкапом.
const BUILD_ARTIFACTS: &[&str] = &["package-lock.json", "src-tauri/Cargo.lock"];

#[derive(Default, PartialEq, Debug)]
struct DirtyState {
    /// Артефакты сборки — можно откатить (с бэкапом) и продолжить.
    auto_resettable: Vec<String>,
    /// Всё остальное — работа пользователя, трогать нельзя.
    blocking: Vec<String>,
}

/// Разбор `git status --porcelain`. Untracked (`??`) не учитываем: они ломают
/// ff-only только при коллизии с входящим коммитом — тогда пусть говорит сам
/// git, а не мы запрещаем обновление из-за постороннего файла в каталоге.
fn classify_porcelain(porcelain: &str) -> DirtyState {
    let mut state = DirtyState::default();
    for line in porcelain.lines() {
        if line.len() < 4 || line.starts_with("??") || line.starts_with("!!") {
            continue;
        }
        // "XY path" либо "XY orig -> path" (переименование).
        let path = line[3..].split(" -> ").last().unwrap_or_default().trim();
        let path = path.trim_matches('"');
        if path.is_empty() {
            continue;
        }
        if BUILD_ARTIFACTS.contains(&path) {
            state.auto_resettable.push(path.to_string());
        } else {
            state.blocking.push(path.to_string());
        }
    }
    state
}

/// Состояние рабочей копии исходников (для честного статуса в UI).
async fn dirty_state(repo: &Path) -> DirtyState {
    match git_capture_raw(repo, &["status", "--porcelain"]).await {
        Some(out) => classify_porcelain(&out),
        None => DirtyState::default(),
    }
}

/// Локальный git-взгляд на то, отстаёт ли репозиторий исходников от remote —
/// это источник истины для «доступно обновление» (то же, что сделал бы
/// `git pull` при ребилде). Корректно НЕ предлагает обновление, когда локальная
/// версия впереди или совпадает. None — если upstream/remote не определить.
async fn local_update_status(repo: &Path) -> Option<LocalStatus> {
    let upstream = upstream_ref(repo).await?;
    let remote = upstream
        .split_once('/')
        .map(|(r, _)| r.to_string())
        .unwrap_or_else(|| "origin".into());
    // best-effort fetch (с таймаутом) — освежить remote-tracking ref.
    // kill_on_drop обязателен: без него дроп future по таймауту оставлял
    // git-процесс жить (check_app_update зовётся на каждом старте — на медленном
    // или битом remote такие fetch'и копились).
    let _ = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let _ = Command::new("git")
            .args(["fetch", "--quiet", &remote])
            .current_dir(repo)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output()
            .await;
    })
    .await;

    // "<ahead> <behind>": слева — коммиты HEAD не в upstream, справа — наоборот
    let counts = git_capture(
        repo,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("HEAD...{upstream}"),
        ],
    )
    .await?;
    let mut it = counts.split_whitespace();
    let ahead: u64 = it.next()?.parse().ok()?;
    let behind: u64 = it.next()?.parse().ok()?;
    let up_sha = git_capture(repo, &["rev-parse", "--short", &upstream])
        .await
        .unwrap_or_default();
    let notes = git_capture(
        repo,
        &[
            "log",
            "--format=%h %s",
            "-n",
            "20",
            &format!("HEAD..{upstream}"),
        ],
    )
    .await
    .unwrap_or_default();
    let dirty = dirty_state(repo).await;
    Some(LocalStatus {
        behind,
        ahead,
        up_sha,
        notes,
        dirty: dirty.blocking,
        auto_resettable: dirty.auto_resettable,
    })
}

/// Web-URL репозитория из origin-remote (для кнопки «Открыть на GitHub»).
async fn repo_web_url(repo: &Path) -> Option<String> {
    let url = git_capture(repo, &["remote", "get-url", "origin"]).await?;
    crate::gitops::remote_web_base(url.trim()).map(|(_, web)| web)
}

fn source_repo_valid(repo: &Path) -> bool {
    if !repo.join(".git").exists() {
        return false;
    }
    // package.json с именем pi-app — защита от запуска сборки в произвольной папке
    std::fs::read_to_string(repo.join("package.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| {
            v.get("name")
                .and_then(|n| n.as_str())
                .map(|s| s.to_string())
        })
        .map(|n| n == "pi-app")
        .unwrap_or(false)
        && repo.join("src-tauri").join("tauri.conf.json").exists()
}

/// Проверить наличие обновления приложения на GitHub (release или новый коммит).
#[tauri::command]
pub async fn check_app_update(source_repo: Option<String>) -> AppUpdateInfo {
    let repo = source_repo.map(PathBuf::from).or_else(embedded_source_repo);
    let repo_valid = repo.as_deref().map(source_repo_valid).unwrap_or(false);

    let mut info = AppUpdateInfo {
        current_version: current_version(),
        current_sha: current_sha(),
        source_repo: repo.as_ref().map(|p| p.to_string_lossy().into_owned()),
        source_repo_valid: repo_valid,
        latest_kind: "none".into(),
        ..Default::default()
    };

    // Основной путь: локальная git-ancestry. Достоверно отражает, что сделает
    // `git pull` при ребилде — и не предлагает «обновиться», когда локально
    // версия свежее/совпадает (главная жалоба на прежнюю логику сравнения с main).
    if repo_valid {
        if let Some(r) = repo.as_deref() {
            if let Some(head) = git_capture(r, &["rev-parse", "--short", "HEAD"]).await {
                info.current_sha = head; // локальный HEAD надёжнее встроенного build-sha
            }
            if let Some(st) = local_update_status(r).await {
                info.checked = true;
                info.behind = st.behind;
                info.ahead = st.ahead;
                info.latest = Some(st.up_sha);
                info.latest_kind = "commit".into();
                info.update_available = st.behind > 0;
                info.diverged = st.behind > 0 && st.ahead > 0;
                info.dirty_files = st.dirty;
                info.auto_resettable_files = st.auto_resettable;
                info.notes = if st.behind > 0 {
                    st.notes
                } else if st.ahead > 0 {
                    format!(
                        "Локальная версия впереди на {} коммит(ов) — обновление не требуется.",
                        st.ahead
                    )
                } else {
                    "Установлена последняя версия.".into()
                };
                info.html_url = repo_web_url(r).await.unwrap_or_default();
                return info;
            }
        }
    }

    // Fallback: нет локальных исходников или upstream не определить (напр.,
    // распространяемый .app без git) — спрашиваем GitHub API.
    let slug = match &repo {
        Some(r) => repo_slug(r).await,
        None => "NickLitwinow/pi-app".to_string(),
    };

    // 1) последний релиз
    match github_get(&format!(
        "https://api.github.com/repos/{slug}/releases/latest"
    ))
    .await
    {
        Ok((200, body)) => {
            if let Ok(v) = serde_json::from_str::<Value>(&body) {
                let tag = v
                    .get("tag_name")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .trim_start_matches('v')
                    .to_string();
                info.checked = true;
                info.latest = Some(tag.clone());
                info.latest_kind = "release".into();
                info.notes = v
                    .get("body")
                    .and_then(|b| b.as_str())
                    .unwrap_or("")
                    .chars()
                    .take(4000)
                    .collect();
                info.html_url = v
                    .get("html_url")
                    .and_then(|u| u.as_str())
                    .unwrap_or("")
                    .to_string();
                info.asset_url = release_dmg(&v);
                info.update_available = !tag.is_empty() && tag != info.current_version;
                return info;
            }
        }
        Ok((404, _)) => { /* релизов нет — падаем на коммиты */ }
        Ok((code, _)) => {
            info.error = Some(format!("GitHub API вернул {code}"));
        }
        Err(e) => {
            info.error = Some(e);
        }
    }

    // 2) последний коммит ветки main (по умолчанию)
    match github_get(&format!(
        "https://api.github.com/repos/{slug}/commits?per_page=1"
    ))
    .await
    {
        Ok((200, body)) => {
            if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(&body) {
                if let Some(c) = arr.first() {
                    let sha_full = c.get("sha").and_then(|s| s.as_str()).unwrap_or("");
                    let short = &sha_full[..sha_full.len().min(7)];
                    info.checked = true;
                    info.latest = Some(short.to_string());
                    info.latest_kind = "commit".into();
                    info.notes = c
                        .pointer("/commit/message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("")
                        .chars()
                        .take(2000)
                        .collect();
                    info.html_url = c
                        .get("html_url")
                        .and_then(|u| u.as_str())
                        .unwrap_or("")
                        .to_string();
                    // сравниваем со встроенным sha (если он известен)
                    info.update_available = info.current_sha != "unknown"
                        && !short.starts_with(&info.current_sha)
                        && !info.current_sha.starts_with(short);
                    info.error = None;
                }
            }
        }
        Ok((code, _)) => {
            if info.error.is_none() {
                info.error = Some(format!("GitHub API вернул {code}"));
            }
        }
        Err(e) => {
            if info.error.is_none() {
                info.error = Some(e);
            }
        }
    }
    info
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateOutput {
    run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<String>,
    done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<i32>,
}

/// Путь к текущему .app-бандлу (для замены), либо /Applications/Pi.app.
fn current_app_bundle() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        // exe = <Bundle>.app/Contents/MacOS/pi-app
        if let Some(bundle) = exe
            .ancestors()
            .find(|p| p.extension().map(|e| e == "app").unwrap_or(false))
        {
            return bundle.to_path_buf();
        }
    }
    PathBuf::from("/Applications/Pi.app")
}

/// Подготовка рабочей копии к `git pull --ff-only`.
///
/// Артефакты сборки, испорченные прошлым запуском обновления, откатываем —
/// сохранив копию рядом (`*.pi-app.bak`, та же механика, что у config.rs).
/// На правках пользователя останавливаемся, не тронув ни файла: молча
/// затирать чужую работу ради обновления недопустимо.
async fn reset_build_artifacts(repo: &Path) -> Result<Vec<String>, Vec<String>> {
    let state = dirty_state(repo).await;
    if !state.blocking.is_empty() {
        return Err(state.blocking);
    }
    let mut reset = Vec::new();
    for path in state.auto_resettable {
        let full = repo.join(&path);
        let mut backup = full.clone().into_os_string();
        backup.push(".pi-app.bak");
        let _ = std::fs::copy(&full, PathBuf::from(backup));
        if git_capture(repo, &["checkout", "--", &path])
            .await
            .is_some()
        {
            reset.push(path);
        }
    }
    Ok(reset)
}

/// Локальное обновление: git pull → npm ci → tauri build → замена бандла.
/// Каждый шаг стримит вывод событием `app-update-output`. Возвращает run id.
#[tauri::command]
pub async fn app_update_run(app: AppHandle, source_repo: String) -> Result<String, String> {
    app_update_run_impl(app, source_repo).await
}

/// Скачать .dmg из GitHub Releases, смонтировать его и атомарно скопировать
/// .app поверх текущего бандла. Текущее приложение продолжает работать; новая
/// версия подхватится после обычного перезапуска.
#[tauri::command]
pub async fn app_update_install_release(
    app: AppHandle,
    asset_url: String,
) -> Result<String, String> {
    if !asset_url.starts_with("https://github.com/NickLitwinow/pi-app/releases/download/")
        || !asset_url.to_ascii_lowercase().ends_with(".dmg")
    {
        return Err("разрешена установка только .dmg из официальных GitHub Releases pi-app".into());
    }
    let run_id = format!("release-{}", RUN_COUNTER.fetch_add(1, Ordering::Relaxed));
    let bundle = current_app_bundle();
    let tmp = std::env::temp_dir().join(format!("pi-app-update-{}", std::process::id()));
    let dmg = tmp.join("Pi-update.dmg");
    let mount = tmp.join("mount");
    let command = format!(
        "set -e; mounted=0; cleanup() {{ \
           if [ \"$mounted\" = 1 ]; then /usr/bin/hdiutil detach {mount} >/dev/null 2>&1 || true; fi; \
           /bin/rm -rf {tmp}; \
         }}; trap cleanup EXIT; /bin/rm -rf {tmp}; /bin/mkdir -p {mount}; \
         /usr/bin/curl -fL --progress-bar {url} -o {dmg}; \
         /usr/bin/hdiutil attach -nobrowse -readonly -mountpoint {mount} {dmg}; mounted=1; \
         candidate=$(/usr/bin/find {mount} -maxdepth 1 -type d -name '*.app' -print -quit); \
         test -n \"$candidate\"; \
         test \"$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \"$candidate/Contents/Info.plist\")\" = 'dev.litwein.piapp'; \
         /usr/bin/codesign --verify --deep --strict \"$candidate\"; \
         /usr/bin/ditto \"$candidate\" {bundle}; \
         /usr/bin/hdiutil detach {mount}; mounted=0",
        tmp = shell_quote(&tmp.to_string_lossy()),
        mount = shell_quote(&mount.to_string_lossy()),
        dmg = shell_quote(&dmg.to_string_lossy()),
        url = shell_quote(&asset_url),
        bundle = shell_quote(&bundle.to_string_lossy()),
    );
    let app2 = app.clone();
    let run_id2 = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let _ = app2.emit(
            "app-update-output",
            UpdateOutput {
                run_id: run_id2.clone(),
                line: Some("▶ Фоновая загрузка и установка готового релиза".into()),
                done: false,
                code: None,
            },
        );
        let code = stream_shell(&app2, &run_id2, "/", &command).await;
        let line = if code == 0 {
            "✓ Новая версия установлена. Перезапустите приложение, когда будет удобно."
        } else {
            "✗ Не удалось установить релиз. Можно использовать пересборку из исходников."
        };
        let _ = app2.emit(
            "app-update-output",
            UpdateOutput {
                run_id: run_id2.clone(),
                line: Some(line.into()),
                done: false,
                code: None,
            },
        );
        let _ = app2.emit(
            "app-update-output",
            UpdateOutput {
                run_id: run_id2,
                line: None,
                done: true,
                code: Some(code),
            },
        );
    });
    Ok(run_id)
}

pub async fn app_update_run_impl<R: Runtime>(
    app: AppHandle<R>,
    source_repo: String,
) -> Result<String, String> {
    let repo = PathBuf::from(&source_repo);
    if !source_repo_valid(&repo) {
        return Err("указанный каталог не является исходниками pi-app (нужен git-репозиторий с package.json name=pi-app)".into());
    }
    let run_id = format!("upd-{}", RUN_COUNTER.fetch_add(1, Ordering::Relaxed));
    let bundle = current_app_bundle();
    let repo_str = repo.to_string_lossy().into_owned();

    let app2 = app.clone();
    let run_id2 = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let emit_line = |line: String| {
            let _ = app2.emit(
                "app-update-output",
                UpdateOutput {
                    run_id: run_id2.clone(),
                    line: Some(line),
                    done: false,
                    code: None,
                },
            );
        };
        let emit_done = |code: i32| {
            let _ = app2.emit(
                "app-update-output",
                UpdateOutput {
                    run_id: run_id2.clone(),
                    line: None,
                    done: true,
                    code: Some(code),
                },
            );
        };

        // Рабочая копия должна пережить `git pull --ff-only`, иначе шаг 1 упадёт
        // с «local changes would be overwritten by merge» и обновление умрёт
        // здесь — ровно тот отказ, который ловили пользователи.
        match reset_build_artifacts(&repo).await {
            Err(blocking) => {
                emit_line(
                    "✗ В каталоге исходников есть незакоммиченные правки — обновление остановлено, чтобы их не потерять:".into(),
                );
                for file in blocking.iter().take(20) {
                    emit_line(format!("   · {file}"));
                }
                if blocking.len() > 20 {
                    emit_line(format!("   … и ещё {}", blocking.len() - 20));
                }
                emit_line(
                    "Закоммитьте их или уберите (git stash), затем повторите обновление.".into(),
                );
                emit_done(1);
                return;
            }
            Ok(reset) if !reset.is_empty() => {
                emit_line(format!(
                    "▶ Откат артефактов сборки перед обновлением: {} (копии сохранены рядом как *.pi-app.bak)",
                    reset.join(", ")
                ));
            }
            Ok(_) => {}
        }

        // шаги пайплайна; каждая команда через login-shell (нужен PATH к node/npm/cargo)
        let steps: Vec<(String, String)> = vec![
            (
                "Обновление исходников (git pull)".into(),
                "git pull --ff-only".into(),
            ),
            (
                // Именно `npm ci`, а не `npm install`: install переписывал
                // затреканный package-lock.json (все зависимости на ^-диапазонах)
                // и тем ломал следующий запуск обновления.
                "Установка зависимостей (npm ci)".into(),
                "npm ci --no-audit --no-fund".into(),
            ),
            (
                "Сборка приложения (tauri build) — это займёт несколько минут".into(),
                "npm run tauri build".into(),
            ),
        ];

        for (title, cmd) in steps {
            emit_line(format!("▶ {title}"));
            emit_line(format!("$ {cmd}"));
            let code = stream_shell(&app2, &run_id2, &repo_str, &cmd).await;
            if code != 0 {
                emit_line(format!(
                    "✗ шаг завершился с кодом {code} — обновление прервано"
                ));
                emit_done(code);
                return;
            }
        }

        // замена установленного бандла свежесобранным
        let built = format!("{repo_str}/src-tauri/target/release/bundle/macos/Pi.app");
        if !Path::new(&built).exists() {
            emit_line("✗ собранный Pi.app не найден — проверьте вывод сборки".into());
            emit_done(1);
            return;
        }
        emit_line(format!("▶ Установка новой версии в {}", bundle.display()));
        let ditto = format!(
            "/usr/bin/ditto {} {}",
            shell_quote(&built),
            shell_quote(&bundle.to_string_lossy())
        );
        let code = stream_shell(&app2, &run_id2, &repo_str, &ditto).await;
        if code != 0 {
            emit_line(format!("✗ установка не удалась (код {code})"));
        } else {
            emit_line(
                "✓ Готово. Нажмите «Перезапустить», чтобы запустить обновлённую версию.".into(),
            );
        }
        emit_done(code);
    });

    Ok(run_id)
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Запустить команду в login-shell с cwd=repo, стримя stdout+stderr. Возвращает код.
async fn stream_shell<R: Runtime>(app: &AppHandle<R>, run_id: &str, cwd: &str, cmd: &str) -> i32 {
    let full = format!("cd {} && {}", shell_quote(cwd), cmd);
    let mut command = Command::new("/bin/zsh");
    command
        .args(["-lc", &full])
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
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
    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = app.emit(
                "app-update-output",
                UpdateOutput {
                    run_id: run_id.to_string(),
                    line: Some(format!("ошибка запуска: {e}")),
                    done: false,
                    code: None,
                },
            );
            return 127;
        }
    };
    let child_pid = child.id();
    if let Some(pid) = child_pid {
        if let Ok(mut groups) = RUNNING_GROUPS.lock() {
            groups.insert(pid);
        }
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    for reader in [
        stdout.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        stderr.map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let app = app.clone();
        let run_id = run_id.to_string();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(mut line)) = lines.next_line().await {
                crate::text::truncate_bytes(&mut line, 4000);
                let _ = app.emit(
                    "app-update-output",
                    UpdateOutput {
                        run_id: run_id.clone(),
                        line: Some(line),
                        done: false,
                        code: None,
                    },
                );
            }
        });
    }
    let code = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
    if let Some(pid) = child_pid {
        if let Ok(mut groups) = RUNNING_GROUPS.lock() {
            groups.remove(&pid);
        }
    }
    code
}

/// Перезапустить приложение (после установки обновления).
#[tauri::command]
pub fn relaunch_app(app: AppHandle) {
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    #[test]
    fn selects_arch_specific_release_dmg() {
        let arch = if cfg!(target_arch = "aarch64") {
            "aarch64"
        } else {
            "x64"
        };
        let value = serde_json::json!({ "assets": [
            { "name": "Pi-universal.dmg", "browser_download_url": "https://x/universal.dmg" },
            { "name": format!("Pi-{arch}.dmg"), "browser_download_url": "https://x/native.dmg" }
        ]});
        assert_eq!(release_dmg(&value).as_deref(), Some("https://x/native.dmg"));
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = StdCommand::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git run")
            .status
            .success();
        assert!(ok, "git {args:?} failed in {}", dir.display());
    }

    /// Ядро проверки обновлений: локальный git-ancestry не предлагает обновление,
    /// когда локальная ветка впереди/совпадает с upstream (главная регрессия).
    #[tokio::test]
    async fn local_status_does_not_offer_update_when_ahead() {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin.git");
        StdCommand::new("git")
            .args(["init", "--bare", "-q", origin.to_str().unwrap()])
            .output()
            .unwrap();
        let work = tmp.path().join("work");
        StdCommand::new("git")
            .args([
                "clone",
                "-q",
                origin.to_str().unwrap(),
                work.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        git(&work, &["config", "user.email", "t@t.dev"]);
        git(&work, &["config", "user.name", "t"]);
        std::fs::write(work.join("a.txt"), "1\n").unwrap();
        git(&work, &["add", "."]);
        git(&work, &["commit", "-q", "-m", "c1"]);
        git(&work, &["push", "-q", "-u", "origin", "HEAD"]);

        // синхронизировано: ни позади, ни впереди → обновления нет
        let st = local_update_status(&work).await.expect("status");
        assert_eq!((st.behind, st.ahead), (0, 0));

        // локально впереди на один коммит → НЕ предлагать обновление
        std::fs::write(work.join("a.txt"), "2\n").unwrap();
        git(&work, &["commit", "-qam", "c2"]);
        let st = local_update_status(&work).await.expect("status");
        assert_eq!(st.behind, 0, "ahead-версия не должна считаться отстающей");
        assert_eq!(st.ahead, 1);
    }

    #[test]
    fn classifies_build_artifacts_apart_from_user_work() {
        let state = classify_porcelain(
            " M package-lock.json\n M src-tauri/Cargo.lock\n M src/App.tsx\n?? scratch.txt\nA  src/new.rs\n",
        );
        assert_eq!(
            state.auto_resettable,
            vec!["package-lock.json", "src-tauri/Cargo.lock"]
        );
        // untracked не блокирует; правки пользователя — блокируют
        assert_eq!(state.blocking, vec!["src/App.tsx", "src/new.rs"]);
    }

    #[test]
    fn classifies_renames_and_empty_output() {
        let state = classify_porcelain("R  old/name.rs -> src/renamed.rs\n");
        assert_eq!(state.blocking, vec!["src/renamed.rs"]);
        assert_eq!(classify_porcelain(""), DirtyState::default());
    }

    /// Ведущий пробел статуса значим: на trimmed-выводе разбор съедал первую
    /// букву пути («ackage-lock.json») и артефакт уезжал в blocking.
    #[test]
    fn keeps_paths_intact_for_unstaged_first_line() {
        let state = classify_porcelain(" M package-lock.json\n");
        assert_eq!(state.auto_resettable, vec!["package-lock.json"]);
        assert!(state.blocking.is_empty());
    }

    #[test]
    fn keeps_paths_with_spaces() {
        let state = classify_porcelain(" M src/some file.tsx\n");
        assert_eq!(state.blocking, vec!["src/some file.tsx"]);
    }

    /// Регрессия на присланный отказ: `git pull --ff-only` падал с «Your local
    /// changes to package-lock.json would be overwritten by merge», потому что
    /// прошлый прогон обновления сам переписал lockfile через `npm install`.
    #[tokio::test]
    async fn resets_lockfile_dirtied_by_previous_update_run() {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin.git");
        StdCommand::new("git")
            .args(["init", "--bare", "-q", origin.to_str().unwrap()])
            .output()
            .unwrap();
        let work = tmp.path().join("work");
        StdCommand::new("git")
            .args([
                "clone",
                "-q",
                origin.to_str().unwrap(),
                work.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        git(&work, &["config", "user.email", "t@t.dev"]);
        git(&work, &["config", "user.name", "t"]);
        std::fs::write(work.join("package-lock.json"), "{\"v\":1}\n").unwrap();
        git(&work, &["add", "."]);
        git(&work, &["commit", "-q", "-m", "c1"]);
        git(&work, &["push", "-q", "-u", "origin", "HEAD"]);

        // прошлый `npm install` переписал затреканный lockfile
        std::fs::write(work.join("package-lock.json"), "{\"v\":2}\n").unwrap();
        assert!(!dirty_state(&work).await.auto_resettable.is_empty());

        let reset = reset_build_artifacts(&work).await.expect("не блокирует");
        assert_eq!(reset, vec!["package-lock.json"]);
        // рабочая копия снова чистая → git pull --ff-only пройдёт
        assert_eq!(dirty_state(&work).await, DirtyState::default());
        assert_eq!(
            std::fs::read_to_string(work.join("package-lock.json")).unwrap(),
            "{\"v\":1}\n"
        );
        // и правка не потеряна безвозвратно
        assert_eq!(
            std::fs::read_to_string(work.join("package-lock.json.pi-app.bak")).unwrap(),
            "{\"v\":2}\n"
        );
    }

    /// Правки пользователя обновление не трогает — оно останавливается.
    #[tokio::test]
    async fn refuses_to_touch_user_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("work");
        std::fs::create_dir_all(work.join("src")).unwrap();
        StdCommand::new("git")
            .args(["init", "-q", work.to_str().unwrap()])
            .output()
            .unwrap();
        git(&work, &["config", "user.email", "t@t.dev"]);
        git(&work, &["config", "user.name", "t"]);
        std::fs::write(work.join("src/App.tsx"), "v1\n").unwrap();
        std::fs::write(work.join("package-lock.json"), "{\"v\":1}\n").unwrap();
        git(&work, &["add", "."]);
        git(&work, &["commit", "-q", "-m", "c1"]);

        std::fs::write(work.join("src/App.tsx"), "работа пользователя\n").unwrap();
        std::fs::write(work.join("package-lock.json"), "{\"v\":2}\n").unwrap();

        let blocked = reset_build_artifacts(&work)
            .await
            .expect_err("должен блокировать");
        assert_eq!(blocked, vec!["src/App.tsx"]);
        // ничего не откачено — ни правка, ни даже артефакт рядом с ней
        assert_eq!(
            std::fs::read_to_string(work.join("src/App.tsx")).unwrap(),
            "работа пользователя\n"
        );
        assert_eq!(
            std::fs::read_to_string(work.join("package-lock.json")).unwrap(),
            "{\"v\":2}\n"
        );
    }

    /// Обратный случай: origin ушёл вперёд → обновление доступно (behind > 0).
    #[tokio::test]
    async fn local_status_detects_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin.git");
        StdCommand::new("git")
            .args(["init", "--bare", "-q", origin.to_str().unwrap()])
            .output()
            .unwrap();
        // первый клон делает коммит и пушит
        let a = tmp.path().join("a");
        StdCommand::new("git")
            .args(["clone", "-q", origin.to_str().unwrap(), a.to_str().unwrap()])
            .output()
            .unwrap();
        git(&a, &["config", "user.email", "t@t.dev"]);
        git(&a, &["config", "user.name", "t"]);
        std::fs::write(a.join("f.txt"), "1\n").unwrap();
        git(&a, &["add", "."]);
        git(&a, &["commit", "-q", "-m", "c1"]);
        git(&a, &["push", "-q", "-u", "origin", "HEAD"]);

        // второй клон отстаёт после нового коммита в origin через первый клон
        let b = tmp.path().join("b");
        StdCommand::new("git")
            .args(["clone", "-q", origin.to_str().unwrap(), b.to_str().unwrap()])
            .output()
            .unwrap();
        git(&b, &["config", "user.email", "t@t.dev"]);
        git(&b, &["config", "user.name", "t"]);

        std::fs::write(a.join("f.txt"), "2\n").unwrap();
        git(&a, &["commit", "-qam", "c2"]);
        git(&a, &["push", "-q"]);

        let st = local_update_status(&b).await.expect("status");
        assert_eq!(st.behind, 1, "b отстаёт на один коммит");
        assert_eq!(st.ahead, 0);
    }
}
