pub mod app_update;
pub mod config;
pub mod editor;
pub mod gitops;
pub mod jsonl;
pub mod packages;
pub mod pi_cli;
pub mod preview;
pub mod sessions;
pub mod supervisor;
pub mod watcher;

use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind, SubmenuBuilder};
use tauri::{Emitter, Manager};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let sup = supervisor::Supervisor::new(app.handle().clone());
            app.manage(sup);
            watcher::start_sessions_watcher(app.handle().clone());
            watcher::start_config_watcher(app.handle().clone());

            // системное меню: View → Toggle Sidebar (⌘B)
            let menu = Menu::default(app.handle())?;
            let toggle = MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar")
                .accelerator("CmdOrCtrl+B")
                .build(app)?;
            let mut appended = false;
            for item in menu.items()? {
                if let MenuItemKind::Submenu(sub) = item {
                    if sub.text().unwrap_or_default() == "View" {
                        sub.append(&toggle)?;
                        appended = true;
                        break;
                    }
                }
            }
            if !appended {
                let view = SubmenuBuilder::new(app, "View").item(&toggle).build()?;
                menu.append(&view)?;
            }
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                if event.id() == "toggle-sidebar" {
                    let _ = app.emit("menu-toggle-sidebar", serde_json::json!({}));
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
            config::read_session_flags,
            config::write_session_flags,
            config::write_pi_config,
            config::read_app_config,
            config::write_app_config,
            config::write_permission_preset,
            config::read_permission_mode,
            config::migrate_permission_configs,
            config::list_skills,
            pi_cli::pi_cli_run,
            pi_cli::probe_url,
            packages::search_pi_packages,
            packages::pi_packages_meta,
            preview::preview_configs,
            preview::preview_save_config,
            preview::preview_start,
            preview::preview_stop,
            gitops::git_is_repo,
            gitops::list_workspace_files,
            gitops::git_status,
            gitops::git_checkpoint,
            gitops::git_review_diff,
            gitops::git_checkout_file,
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
            app_update::app_update_run,
            app_update::relaunch_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // Выход приложения: гасим все process group'ы (агенты pi + dev-серверы),
            // иначе их дети (MCP-серверы, vite) переживают выход и копят память.
            if let tauri::RunEvent::Exit = event {
                let sup = app_handle.state::<supervisor::Supervisor<tauri::Wry>>();
                tauri::async_runtime::block_on(supervisor::kill_all_agents(&sup));
                preview::stop_all_servers();
            }
        });
}
