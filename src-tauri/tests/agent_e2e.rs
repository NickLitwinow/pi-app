//! End-to-end test of the production agent pipeline: a mock Tauri app hosts the
//! real Supervisor, which spawns the actual `pi --mode rpc` binary, talks JSONL
//! to it, and (when explicitly requested) drives a full prompt turn.
//!
//! The LLM leg is opt-in (`PI_APP_RUN_LLM_E2E=1`). A listening TCP port does not
//! prove that the configured model is loaded or has enough memory, and treating
//! it as readiness made ordinary `cargo test` hang for three minutes.

use pi_app_lib::supervisor::{self, SpawnOpts, Supervisor};
use std::fs;
use std::net::TcpListener;
use std::time::Duration;
use tauri::Manager;

fn run_llm_e2e() -> bool {
    std::env::var("PI_APP_RUN_LLM_E2E").as_deref() == Ok("1")
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
    let port = TcpListener::bind("127.0.0.1:0")
        .expect("reserve preview port")
        .local_addr()
        .unwrap()
        .port();
    fs::create_dir_all(tmp.path().join(".claude")).unwrap();
    fs::write(
        tmp.path().join(".claude/launch.json"),
        serde_json::to_vec(&serde_json::json!({
            "version": "0.0.1",
            "configurations": [{
                "name": "bridge-e2e",
                "runtimeExecutable": "/usr/bin/python3",
                "runtimeArgs": ["-m", "http.server", port.to_string(), "--bind", "127.0.0.1"],
                "port": port
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let bridge_extension = tmp.path().join("preview-bridge-probe.mjs");
    fs::write(
        &bridge_extension,
        r#"
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const PREFIX = "__PI_APP_NATIVE_PREVIEW_V1__:";
export default function (pi) {
  pi.registerCommand("native-preview-probe", {
    description: "exercise pi-app native preview bridge",
    handler: async (_args, ctx) => {
      const start = await ctx.ui.input(PREFIX + JSON.stringify({ action: "start", name: "bridge-e2e", waitMs: 15000 }), "");
      const startReply = JSON.parse(start || "{}");
      const serverId = startReply?.data?.serverId;
      const repeated = await ctx.ui.input(PREFIX + JSON.stringify({ action: "start", name: "bridge-e2e", waitMs: 15000 }), "");
      const stop = serverId
        ? await ctx.ui.input(PREFIX + JSON.stringify({ action: "stop", serverId }), "")
        : undefined;
      writeFileSync(join(ctx.cwd, "preview-bridge-result.json"), JSON.stringify({ start: startReply, repeated: JSON.parse(repeated || "{}"), stop: JSON.parse(stop || "{}") }));
    },
  });
}
"#,
    )
    .unwrap();

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
            "--extension".into(),
            bridge_extension.to_string_lossy().into_owned(),
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

    // --- hidden extension input → native preview manager → same command reply ---
    supervisor::agent_send_impl(
        sup.inner(),
        agent_id.clone(),
        r#"{"type":"prompt","id":"preview","message":"/native-preview-probe"}"#.into(),
    )
    .await
    .expect("agent_send preview command");
    let preview_result_path = tmp.path().join("preview-bridge-result.json");
    for _ in 0..80 {
        if preview_result_path.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let preview_result: serde_json::Value = serde_json::from_slice(
        &fs::read(&preview_result_path).expect("preview bridge command completed"),
    )
    .unwrap();
    assert_eq!(
        preview_result
            .pointer("/start/success")
            .and_then(|value| value.as_bool()),
        Some(true)
    );
    assert_eq!(
        preview_result
            .pointer("/start/data/ready")
            .and_then(|value| value.as_bool()),
        Some(true),
        "native manager waited for real HTTP readiness: {preview_result}"
    );
    assert_eq!(
        preview_result
            .pointer("/stop/success")
            .and_then(|value| value.as_bool()),
        Some(true)
    );
    assert_eq!(
        preview_result.pointer("/start/data/serverId"),
        preview_result.pointer("/repeated/data/serverId"),
        "repeated start reuses the native process instead of duplicating a dev server"
    );

    // --- full prompt round-trip through the configured model (explicit opt-in) ---
    if run_llm_e2e() {
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
        assert!(
            saw_streaming,
            "agent_start was observed (event pipeline works)"
        );
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
        eprintln!("SKIP LLM round-trip: set PI_APP_RUN_LLM_E2E=1 to exercise the configured model");
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
