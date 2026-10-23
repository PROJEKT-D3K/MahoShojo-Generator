//! In-process production command/ACL verification. No installed executable is inspected or run.
use super::*;
use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
fn call(
    webview: &tauri::WebviewWindow<MockRuntime>,
    command: &str,
    request: Value,
) -> Result<InvokeResponseBody, Value> {
    get_ipc_response(
        webview,
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body: InvokeBody::Json(json!({"request":request})),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
}
#[test]
fn local_launch_commands_require_main_ui_and_reject_execution_authority() {
    let app = mock_builder()
        .manage(local_ai_launch::LaunchRegistry::default())
        .invoke_handler(tauri::generate_handler![
            prepare_local_ai_launch,
            start_local_ai,
            get_local_ai_launch_status,
            cancel_local_ai_launch,
            stop_local_ai
        ])
        .build(tauri::generate_context!())
        .unwrap();
    let main = tauri::WebviewWindowBuilder::new(&app, "main-ui", Default::default())
        .build()
        .unwrap();
    let untrusted = tauri::WebviewWindowBuilder::new(&app, "untrusted", Default::default())
        .build()
        .unwrap();
    let runtime = json!({"contractVersion":1,"runtimeId":"ollama"});
    for command in [
        "prepare_local_ai_launch",
        "start_local_ai",
        "get_local_ai_launch_status",
        "cancel_local_ai_launch",
        "stop_local_ai",
    ] {
        let mut valid = runtime.clone();
        if matches!(
            command,
            "start_local_ai" | "cancel_local_ai_launch" | "stop_local_ai"
        ) {
            valid["operationId"] = json!("unknown");
        }
        if command == "start_local_ai" {
            valid["installationId"] = json!("unknown");
        }
        let denied = call(&untrusted, command, valid.clone()).unwrap_err();
        assert!(
            denied
                .as_str()
                .is_some_and(|text| text.contains("not allowed")),
            "{command}: {denied}"
        );
        let mut invalid = valid;
        invalid["path"] = json!("C:/untrusted.exe");
        assert!(call(&main, command, invalid).is_err());
    }
    let snapshot = call(&main, "get_local_ai_launch_status", runtime)
        .unwrap()
        .deserialize::<Value>()
        .unwrap();
    assert_eq!(
        snapshot,
        json!({"contractVersion":1,"runtimeId":"ollama","state":"idle"})
    );
    let unknown = json!({"contractVersion":1,"runtimeId":"ollama","operationId":"unknown","installationId":"unknown"});
    assert_eq!(
        call(&main, "start_local_ai", unknown).unwrap_err()["code"],
        "invalid-operation"
    );
    for command in ["cancel_local_ai_launch", "stop_local_ai"] {
        assert_eq!(
            call(
                &main,
                command,
                json!({"contractVersion":1,"runtimeId":"ollama","operationId":"unknown"})
            )
            .unwrap_err()["code"],
            "invalid-operation"
        );
    }
}
