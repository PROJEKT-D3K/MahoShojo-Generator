//! Test-only stdin transport through Tauri's real command macros and app ACL.
//! The private test library is never selected by a renderer command or path.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, Read, Write};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};

const PIPE_FRAME_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Default, Deserialize)]
enum Caller {
    #[default]
    #[serde(rename = "main-ui")]
    Main,
    #[serde(rename = "untrusted")]
    Untrusted,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Call {
    cmd: String,
    args: Option<Value>,
    raw: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    webview: Caller,
    url: Option<String>,
}

fn app(library: LocalLibrary) -> tauri::App<MockRuntime> {
    mock_builder()
        .manage(library)
        // These are the production command functions, including macro argument
        // decoding, raw Request headers and structured errors. The TS boundary
        // test pins this subset to the production handler and exact app ACL.
        .invoke_handler(tauri::generate_handler![
            begin_arena_story_commit,
            begin_arena_story_branch_commit,
            begin_arena_story_tail_rewrite_commit,
            append_arena_story_part,
            end_arena_story_commit,
            end_arena_story_branch_commit,
            end_arena_story_tail_rewrite_commit,
            abort_arena_story_commit,
            query_arena_story_receipt,
            query_arena_story_branch_receipt,
            query_arena_story_tail_rewrite_receipt,
            resolve_arena_story_branch_anchor,
            resolve_arena_story_tail_rewrite_source,
            list_arena_story_sessions,
            delete_arena_story_session,
            list_arena_story_chapters,
            describe_arena_story_record,
            read_arena_story_record_chunk,
            read_arena_story_continue_state,
        ])
        // Do not use mock_context: its empty authority would skip the app ACL.
        .build(tauri::generate_context!())
        .unwrap()
}

struct Transport {
    main: tauri::WebviewWindow<MockRuntime>,
    untrusted: tauri::WebviewWindow<MockRuntime>,
    _app: tauri::App<MockRuntime>,
}

impl Transport {
    fn new(root: &std::path::Path) -> Self {
        let app = app(LocalLibrary::open(root).unwrap());
        let main = tauri::WebviewWindowBuilder::new(&app, "main-ui", Default::default())
            .build()
            .unwrap();
        let untrusted = tauri::WebviewWindowBuilder::new(&app, "untrusted", Default::default())
            .build()
            .unwrap();
        Self {
            main,
            untrusted,
            _app: app,
        }
    }

    fn call(&self, call: Call) -> Result<InvokeResponseBody, Value> {
        let invalid = || json!({"code":"test-transport-invalid"});
        let body = match (call.args, call.raw) {
            (None, Some(raw)) => {
                let bytes = STANDARD.decode(raw).map_err(|_| invalid())?;
                InvokeBody::Raw(bytes)
            }
            (args, None) => InvokeBody::Json(args.unwrap_or_else(|| json!({}))),
            (Some(_), Some(_)) => return Err(invalid()),
        };
        let mut headers = tauri::http::HeaderMap::new();
        for (name, value) in call.headers {
            headers.insert(
                tauri::http::header::HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| invalid())?,
                tauri::http::HeaderValue::from_str(&value).map_err(|_| invalid())?,
            );
        }
        let local = if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        };
        get_ipc_response(
            match call.webview {
                Caller::Main => &self.main,
                Caller::Untrusted => &self.untrusted,
            },
            tauri::webview::InvokeRequest {
                cmd: call.cmd,
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: call
                    .url
                    .as_deref()
                    .unwrap_or(local)
                    .parse()
                    .map_err(|_| invalid())?,
                body,
                headers,
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
    }

    fn respond(&self, request: Value) -> Value {
        let result = serde_json::from_value(request)
            .map_err(|_| json!({"code":"test-transport-invalid"}))
            .and_then(|call| self.call(call));
        match result {
            Ok(InvokeResponseBody::Json(value)) => {
                json!({"ok":true,"value":serde_json::from_str::<Value>(&value).unwrap()})
            }
            Ok(InvokeResponseBody::Raw(bytes)) => json!({"ok":true,"raw":STANDARD.encode(bytes)}),
            Err(error) => json!({"ok":false,"error":error}),
        }
    }
}

#[test]
fn command_macros_and_app_acl_reject_invalid_or_untrusted_calls() {
    let root = tempfile::tempdir().unwrap();
    let transport = Transport::new(root.path());
    let receipt = json!({
        "cmd":"query_arena_story_branch_receipt",
        "args":{"sessionId":"target","operationId":"operation","requestDigest":format!("sha256:{}", "a".repeat(64))}
    });
    assert_eq!(
        transport.respond(receipt.clone()),
        json!({"ok":true,"value":null})
    );
    let mut denied = receipt.clone();
    denied["webview"] = json!("untrusted");
    let denied = transport.respond(denied);
    assert_eq!(denied["ok"], false);
    assert!(
        denied["error"].is_string(),
        "ACL denial must occur before the store"
    );

    let mut remote = receipt.clone();
    remote["url"] = json!("https://example.invalid");
    let remote = transport.respond(remote);
    assert_eq!(remote["ok"], false);
    assert!(
        remote["error"].is_string(),
        "remote origin must not inherit main-ui authority"
    );

    let mut missing = receipt;
    missing["args"]
        .as_object_mut()
        .unwrap()
        .remove("requestDigest");
    assert!(transport.respond(missing)["error"].is_string());
    let bad_token = transport.respond(json!({
        "cmd":"end_arena_story_branch_commit","args":{"token":"not-a-token"}
    }));
    assert_eq!(bad_token["error"]["code"], "story-invalid");
    let token = format!("{}-{}", "a".repeat(32), "b".repeat(32));
    let json_body = transport.respond(json!({
        "cmd":"append_arena_story_part","args":{"bytes":[1,2,3]},
        "headers":{"x-story-token":token,"x-story-part":"session","x-story-offset":"0"}
    }));
    assert_eq!(json_body["error"]["code"], "story-invalid");
}

#[test]
fn tail_wire_commands_keep_raw_text_and_exact_main_ui_authority() {
    let root = tempfile::tempdir().unwrap();
    let transport = crate::store::with_history_schema_for_test(|| Transport::new(root.path()));
    let golden: Value = serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/desktop-story-tail-rewrite-storage.json"
    ))
    .unwrap();
    let case = &golden["cases"][0];
    let source = &golden["sourceCommits"][0];
    let begin = transport
        .respond(json!({"cmd":"begin_arena_story_commit","args":{"manifest":source["manifest"]}}));
    assert_eq!(begin["ok"], true);
    let token = begin["value"]["token"].as_str().unwrap();
    assert_eq!(
        transport
            .respond(json!({"cmd":"end_arena_story_tail_rewrite_commit","args":{"token":token}}))
            ["error"]["code"],
        "story-invalid"
    );
    for part in source["parts"].as_array().unwrap() {
        let appended = transport.respond(json!({"cmd":"append_arena_story_part","raw":STANDARD.encode(part["document"].as_str().unwrap()),
            "headers":{"x-story-token":token,"x-story-part":part["kind"],"x-story-offset":"0"}}));
        assert_eq!(appended["ok"], true);
    }
    assert_eq!(
        transport.respond(json!({"cmd":"end_arena_story_commit","args":{"token":token}}))["ok"],
        true
    );
    let mut manifest = case["manifest"].clone();
    let request = json!({"sessionId":manifest["sessionId"],"expectedRevision":manifest["source"]["expectedRevision"],
        "expectedChapterCount":manifest["source"]["expectedChapterCount"],"targetChapterId":manifest["source"]["targetChapterId"]});
    let resolved = transport.respond(
        json!({"cmd":"resolve_arena_story_tail_rewrite_source","args":{"request":request}}),
    );
    assert_eq!(resolved["ok"], true);
    manifest["source"] = resolved["value"]["source"].clone();
    let manifest_json = serde_json::to_string(&manifest).unwrap();
    let begin_request = json!({"cmd":"begin_arena_story_tail_rewrite_commit","args":{"manifestJson":manifest_json}});
    for args in [
        json!({"manifest":manifest}),
        json!({"manifest_json":manifest_json}),
        json!({"manifestJson":manifest}),
    ] {
        assert!(transport
            .respond(json!({"cmd":"begin_arena_story_tail_rewrite_commit","args":args}))["error"]
            .is_string());
    }
    for malformed in [
        manifest_json.replacen("\"version\":3", "\"version\":3,\"version\":3", 1),
        manifest_json.replacen("\"version\":3", "\"version\":3,\"\\u0076ersion\":3", 1),
    ] {
        let result = transport.respond(json!({"cmd":"begin_arena_story_tail_rewrite_commit","args":{"manifestJson":malformed}}));
        assert_eq!(result["error"]["code"], "story-invalid");
    }
    let exact = format!("{manifest_json}{}", " ".repeat(2048 - manifest_json.len()));
    assert_eq!(transport.respond(json!({"cmd":"begin_arena_story_tail_rewrite_commit","args":{"manifestJson":format!("{exact} ")}}))["error"]["code"], "story-too-large");
    let begun = transport.respond(
        json!({"cmd":"begin_arena_story_tail_rewrite_commit","args":{"manifestJson":exact}}),
    );
    assert_eq!(begun["ok"], true);
    let token = begun["value"]["token"].as_str().unwrap();
    for part in case["parts"].as_array().unwrap() {
        assert_eq!(transport.respond(json!({"cmd":"append_arena_story_part","raw":STANDARD.encode(part["document"].as_str().unwrap()),
            "headers":{"x-story-token":token,"x-story-part":part["kind"],"x-story-offset":"0"}}))["ok"], true);
    }
    for command in ["end_arena_story_commit", "end_arena_story_branch_commit"] {
        assert_eq!(
            transport.respond(json!({"cmd":command,"args":{"token":token}}))["error"]["code"],
            "story-invalid"
        );
    }
    let end_request = json!({"cmd":"end_arena_story_tail_rewrite_commit","args":{"token":token}});
    let ended = transport.respond(end_request.clone());
    assert_eq!(ended["ok"], true);
    let text = ended["value"].as_str().unwrap();
    assert!(text.len() <= 2048);
    let receipt: Value = serde_json::from_str(text).unwrap();
    assert_eq!(receipt["revision"], 2);
    assert_eq!(receipt["chapterCount"], 1);
    let receipt_request = json!({"cmd":"query_arena_story_tail_rewrite_receipt","args":{"sessionId":manifest["sessionId"],
        "operationId":manifest["operationId"],"requestDigest":receipt["requestDigest"]}});
    assert_eq!(transport.respond(receipt_request.clone())["value"], text);
    let source_request =
        json!({"cmd":"resolve_arena_story_tail_rewrite_source","args":{"request":request}});
    for call in [
        begin_request,
        end_request,
        receipt_request.clone(),
        source_request,
    ] {
        for (field, value) in [("webview", "untrusted"), ("url", "https://example.invalid")] {
            let mut denied = call.clone();
            denied[field] = json!(value);
            let result = transport.respond(denied);
            assert_eq!(result["ok"], false);
            assert!(
                result["error"].is_string(),
                "ACL must reject before Native store dispatch"
            );
        }
    }
    let mut missing = receipt_request;
    missing["args"]
        .as_object_mut()
        .unwrap()
        .remove("requestDigest");
    assert!(transport.respond(missing)["error"].is_string());
    assert_eq!(
        transport.respond(
            json!({"cmd":"end_arena_story_tail_rewrite_commit","args":{"token":"invalid"}})
        )["error"]["code"],
        "story-invalid"
    );

    let default_root = tempfile::tempdir().unwrap();
    let default = Transport::new(default_root.path());
    let rejected = default.respond(
        json!({"cmd":"resolve_arena_story_tail_rewrite_source","args":{"request":request}}),
    );
    assert_eq!(rejected["error"]["code"], "story-invalid");
}

#[test]
#[ignore = "requires explicit private-root command runner; MockRuntime is not Windows/webview acceptance"]
fn real_command_branch_pipe() {
    let root = std::path::PathBuf::from(
        std::env::var_os("MAHO_BRANCH_COMMAND_PIPE_ROOT").expect("private root"),
    );
    assert!(root.is_absolute() && root.is_dir());
    crate::restore::recover_pending(&root).unwrap();
    let transport = Transport::new(&root);
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    loop {
        let mut line = String::new();
        let bytes = (&mut input)
            .take(PIPE_FRAME_BYTES + 1)
            .read_line(&mut line)
            .unwrap();
        if bytes == 0 {
            break;
        }
        assert!(
            bytes as u64 <= PIPE_FRAME_BYTES && line.ends_with('\n'),
            "bounded complete frame"
        );
        let request: Value = serde_json::from_str(&line).unwrap();
        println!("BRANCH_COMMAND_PIPE {}", transport.respond(request));
        std::io::stdout().flush().unwrap();
    }
}
