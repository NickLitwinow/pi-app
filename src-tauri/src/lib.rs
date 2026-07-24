pub mod app_icon;
pub mod app_update;
pub mod avatars;
pub mod config;
pub mod editor;
pub mod extension_lifecycle;
pub mod gitops;
pub mod jsonl;
pub mod packages;
pub mod perf;
pub mod pi_cli;
pub mod preview;
pub mod sessions;
pub mod supervisor;
pub mod text;
pub mod themes;
pub mod watcher;

use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // A crash or force-quit during a package mutation must restore the
            // last known-good extension generation before any agent can start.
            if let Err(error) = extension_lifecycle::reconcile_startup() {
                eprintln!("extension lifecycle startup reconciliation failed: {error}");
            }
            let sup = supervisor::Supervisor::new(app.handle().clone());
            app.manage(sup);
            watcher::start_sessions_watcher(app.handle().clone());
            watcher::start_config_watcher(app.handle().clone());

            // Нативное меню повторяет карту действий web-view. Источником
            // истины остаются action id — App.tsx обрабатывает и menu, и keydown.
            let menu = Menu::default(app.handle())?;
            let new_session = MenuItemBuilder::with_id("new-session", "New Session")
                .accelerator("CmdOrCtrl+T")
                .build(app)?;
            let close_session = MenuItemBuilder::with_id("close-session", "Close Session")
                .accelerator("CmdOrCtrl+W")
                .build(app)?;
            let find_session = MenuItemBuilder::with_id("find-session", "Find in Session")
                .accelerator("CmdOrCtrl+F")
                .build(app)?;
            let focus_composer = MenuItemBuilder::with_id("focus-composer", "Focus Composer")
                .accelerator("CmdOrCtrl+L")
                .build(app)?;
            let copy_last = MenuItemBuilder::with_id("copy-last-answer", "Copy Last Answer")
                .accelerator("CmdOrCtrl+Shift+C")
                .build(app)?;
            let session_menu = SubmenuBuilder::new(app, "Session")
                .items(&[
                    &new_session,
                    &close_session,
                    &find_session,
                    &focus_composer,
                    &copy_last,
                ])
                .build()?;
            menu.append(&session_menu)?;

            let toggle = MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar")
                .accelerator("CmdOrCtrl+B")
                .build(app)?;
            let code_review = MenuItemBuilder::with_id("code-review", "Code Review")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            let preview = MenuItemBuilder::with_id("toggle-preview", "Toggle Live Preview")
                .accelerator("CmdOrCtrl+E")
                .build(app)?;
            let palette = MenuItemBuilder::with_id("command-palette", "Command Palette")
                .accelerator("CmdOrCtrl+K")
                .build(app)?;
            let hotkeys = MenuItemBuilder::with_id("hotkeys", "Keyboard Shortcuts")
                .accelerator("CmdOrCtrl+/")
                .build(app)?;
            let settings = MenuItemBuilder::with_id("settings", "Settings")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let navigate_menu = SubmenuBuilder::new(app, "Navigate")
                .items(&[
                    &toggle,
                    &code_review,
                    &preview,
                    &palette,
                    &hotkeys,
                    &settings,
                ])
                .build()?;
            menu.append(&navigate_menu)?;

            for number in 1..=9 {
                let id = format!("workspace-{number}");
                let label = format!("Workspace {number}");
                let accelerator = format!("CmdOrCtrl+{number}");
                let item = MenuItemBuilder::with_id(id, label)
                    .accelerator(accelerator)
                    .build(app)?;
                // Workspace navigation lives in Navigate after its fixed actions.
                navigate_menu.append(&item)?;
            }
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                let action = event.id().as_ref();
                if matches!(
                    action,
                    "new-session"
                        | "close-session"
                        | "find-session"
                        | "focus-composer"
                        | "copy-last-answer"
                        | "toggle-sidebar"
                        | "code-review"
                        | "toggle-preview"
                        | "command-palette"
                        | "hotkeys"
                        | "settings"
                ) || action.starts_with("workspace-")
                {
                    let _ = app.emit("menu-action", serde_json::json!({ "action": action }));
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            supervisor::resolve_pi,
            supervisor::set_pi_path,
            supervisor::spawn_agent,
            supervisor::agent_send,
            supervisor::kill_agent,
            supervisor::list_agents,
            supervisor::confirm_app_exit,
            supervisor::process_stats,
            sessions::list_projects,
            sessions::list_sessions,
            sessions::list_sessions_for_cwd,
            sessions::fork_session,
            sessions::read_session_thread,
            sessions::delete_session,
            sessions::rename_session,
            sessions::search_sessions,
            sessions::analytics_overview,
            config::read_pi_config,
            config::read_project_settings,
            config::write_project_settings,
            config::read_project_pi_config,
            config::write_project_pi_config,
            config::read_session_flags,
            config::write_session_flags,
            config::write_pi_config,
            config::read_app_config,
            config::write_app_config,
            app_icon::set_app_icon,
            config::write_permission_preset,
            config::read_permission_mode,
            config::migrate_permission_configs,
            config::list_skills,
            pi_cli::pi_cli_run,
            extension_lifecycle::set_extension_resource_enabled,
            pi_cli::check_pi_update,
            pi_cli::probe_url,
            packages::search_pi_packages,
            packages::pi_packages_meta,
            packages::pi_package_details,
            perf::perf_ready,
            preview::preview_configs,
            preview::preview_save_config,
            preview::preview_start,
            preview::preview_status,
            preview::preview_stop,
            preview::preview_touch,
            gitops::git_is_repo,
            gitops::list_workspace_files,
            gitops::git_status,
            gitops::git_checkpoint,
            gitops::git_review_diff,
            gitops::git_checkout_file,
            gitops::git_restore_run_files,
            gitops::git_restore_checkpoint,
            gitops::git_summary,
            gitops::git_open_pr,
            gitops::git_branches,
            gitops::git_checkout_branch,
            gitops::git_create_branch,
            gitops::git_delete_branch,
            gitops::git_stage,
            gitops::git_unstage,
            gitops::git_discard,
            gitops::git_commit,
            gitops::git_push,
            gitops::git_pull,
            gitops::git_fetch,
            gitops::git_log,
            gitops::git_show_commit,
            gitops::git_file_diff,
            editor::open_in_editor,
            editor::open_external,
            editor::reveal_in_finder,
            editor::read_file_base64,
            app_update::check_app_update,
            avatars::read_avatar_data,
            app_update::app_update_run,
            app_update::app_update_install_release,
            app_update::relaunch_app,
            themes::list_pi_themes,
            themes::save_pi_theme,
            themes::delete_pi_theme,
            themes::export_pi_theme_package,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // A background task is a live workload even when the foreground
            // model turn has settled. Keep the app/process group alive until
            // the frontend obtains an explicit quit confirmation.
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = &event
            {
                let sup = app_handle.state::<supervisor::Supervisor<tauri::Wry>>();
                let task_count =
                    tauri::async_runtime::block_on(supervisor::active_background_task_count(&sup));
                if task_count > 0 {
                    api.prevent_exit();
                    let _ = app_handle.emit(
                        "background-exit-requested",
                        supervisor::BackgroundExitRequestedPayload { task_count },
                    );
                    return;
                }
            }
            // Выход приложения: гасим все process group'ы (агенты pi + dev-серверы),
            // иначе их дети (MCP-серверы, vite) переживают выход и копят память.
            if let tauri::RunEvent::Exit = event {
                let sup = app_handle.state::<supervisor::Supervisor<tauri::Wry>>();
                tauri::async_runtime::block_on(supervisor::kill_all_agents(&sup));
                preview::stop_all_servers();
                pi_cli::stop_all_runs();
                app_update::stop_all_runs();
            }
        });
}
