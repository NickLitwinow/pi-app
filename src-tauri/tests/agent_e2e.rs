//! End-to-end test of the production agent pipeline: a mock Tauri app hosts the
//! real Supervisor, which spawns the actual `pi --mode rpc` binary, talks JSONL
//! to it, and (when the local model server is up) drives a full prompt turn.
//!
//! Skips gracefully when pi is not installed; skips the LLM round-trip when the
//! model server at 127.0.0.1:8003 is down.

use pi_app_lib::supervisor::{self, SpawnOpts, Supervisor};
use std::time::Duration;
use tauri::Manager;

fn model_server_up() -> bool {
    "127.0.0.1:8003"
        .parse()
        .ok()
        .and_then(|addr| std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(800)).ok())
        .is_some()
}

#[tokio::test(flavor = "multi_thread")]
async fn real_pi_agent_roundtrip() {
    if supervisor::find_pi_binary().is_none() {
        eprintln!("SKIP: pi binary not installed");
        return;
    }

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock tauri app");
    let handle = app.handle().clone();
    handle.manage(Supervisor::new(handle.clone()));

    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().to_string_lossy().into_owned();
    let session_dir = tmp.path().join("sessions");

    // --- spawn the real pi process through the production command ---
    let opts = SpawnOpts {
        cwd: cwd.clone(),
        session_path: None,
        extra_args: vec![
            "--session-dir".into(),
            session_dir.to_string_lossy().into_owned(),
            "-ne".into(),
            "-ns".into(),
            "--thinking".into(),
            "minimal".into(),
        ],
    };
    let sup = handle.state::<Supervisor<tauri::test::MockRuntime>>();
    let agent_id = supervisor::spawn_agent_impl(handle.clone(), sup.inner(), opts)
        .await
        .expect("spawn_agent");

    // --- get_state: proves stdin write + stdout JSONL framing + response parse ---
    supervisor::agent_send_impl(
        sup.inner(),
        agent_id.clone(),
        r#"{"type":"get_state","id":"t1"}"#.into(),
    )
    .await
    .expect("agent_send get_state");

    let mut session_path: Option<String> = None;
    for _ in 0..60 {
        let agents = supervisor::list_agents_impl(sup.inner()).await.unwrap();
        match agents.iter().find(|a| a.id == agent_id) {
            Some(a) => {
                if a.session_path.is_some() {
                    session_path = a.session_path.clone();
                    break;
                }
            }
            None => panic!("agent exited prematurely"),
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let session_path = session_path
        .expect("sessionFile sniffed from a parsed get_state response (stdout pipeline works)");
    assert!(
        session_path.contains("sessions"),
        "session stored in our --session-dir: {session_path}"
    );

    // --- full prompt round-trip through the local model (if it is running) ---
    if model_server_up() {
        supervisor::agent_send_impl(
            sup.inner(),
            agent_id.clone(),
            r#"{"type":"prompt","id":"t2","message":"Reply with exactly: PI-APP-E2E-OK"}"#.into(),
        )
        .await
        .expect("agent_send prompt");

        // streaming flag flips on at agent_start and off at agent_end
        let mut saw_streaming = false;
        let mut turn_done = false;
        for _ in 0..360 {
            // up to 3 min: local 35B model can be slow to first token
            let agents = supervisor::list_agents_impl(sup.inner()).await.unwrap();
            let a = agents
                .iter()
                .find(|a| a.id == agent_id)
                .expect("agent stays alive during the turn");
            if a.streaming {
                saw_streaming = true;
            } else if saw_streaming {
                turn_done = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        assert!(saw_streaming, "agent_start was observed (event pipeline works)");
        assert!(turn_done, "agent_end was observed (turn completed)");

        // the assistant's reply must be persisted in the pi session file
        let full_path = if session_path.starts_with('/') {
            std::path::PathBuf::from(&session_path)
        } else {
            tmp.path().join(&session_path)
        };
        let content = std::fs::read_to_string(&full_path).expect("session file readable");
        assert!(
            content.contains("PI-APP-E2E-OK"),
            "assistant reply persisted in session file {full_path:?}"
        );
        eprintln!("LLM round-trip OK");
    } else {
        eprintln!("SKIP LLM round-trip: model server at 127.0.0.1:8003 is down");
    }

    // --- teardown through the production kill path ---
    supervisor::kill_agent_impl(handle.clone(), sup.inner(), agent_id.clone())
        .await
        .expect("kill_agent");
    tokio::time::sleep(Duration::from_millis(600)).await;
    let agents = supervisor::list_agents_impl(sup.inner()).await.unwrap();
    assert!(
        agents.iter().all(|a| a.id != agent_id),
        "agent removed after kill"
    );
}
