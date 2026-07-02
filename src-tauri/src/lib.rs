pub mod config;
pub mod editor;
pub mod gitops;
pub mod jsonl;
pub mod pi_cli;
pub mod sessions;
pub mod supervisor;
pub mod watcher;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let sup = supervisor::Supervisor::new(app.handle().clone());
            app.manage(sup);
            watcher::start_sessions_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            supervisor::resolve_pi,
            supervisor::set_pi_path,
            supervisor::spawn_agent,
            supervisor::agent_send,
            supervisor::kill_agent,
            supervisor::list_agents,
            sessions::list_projects,
            sessions::list_sessions,
            sessions::list_sessions_for_cwd,
            sessions::read_session,
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
            gitops::git_is_repo,
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
            editor::read_file_base64,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
