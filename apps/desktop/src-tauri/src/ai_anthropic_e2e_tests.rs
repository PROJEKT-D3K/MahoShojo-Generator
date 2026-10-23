//! Saved Anthropic profiles over real loopback HTTP/SSE, without provider calls.
use super::*;
use serde_json::{json, Value};
use std::time::Duration;

const FIXTURE: &str =
    include_str!("../../../../packages/contracts/fixtures/anthropic-messages-stream.json");
const API_KEY: &str = "synthetic-anthropic-key";

#[derive(Default)]
struct Wire {
    bytes: Vec<u8>,
    byte_chunks: bool,
    hold_open: bool,
    delay_headers: bool,
    status: Option<u16>,
    content_type: Option<&'static str>,
    location: Option<String>,
}

struct Observation {
    transport: ServerObservation,
    headers: BTreeMap<String, String>,
    body: Value,
}

struct MessagesServer {
    base_url: String,
    observed: oneshot::Receiver<Observation>,
    request_received: oneshot::Receiver<()>,
}

async fn messages_server(wire: Wire) -> MessagesServer {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!(
        "http://{}/prefix/v1///?ignored=query#ignored-fragment",
        listener.local_addr().unwrap()
    );
    let (tx, observed) = oneshot::channel();
    let (received_tx, request_received) = oneshot::channel();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut received = Vec::new();
        let mut buffer = [0_u8; 2048];
        let header_end = loop {
            let n = stream.read(&mut buffer).await.unwrap();
            assert!(n > 0, "request ended before headers");
            received.extend_from_slice(&buffer[..n]);
            if let Some(pos) = received.windows(4).position(|v| v == b"\r\n\r\n") {
                break pos + 4;
            }
            assert!(received.len() < 64 * 1024, "bounded test request headers");
        };
        let head = String::from_utf8(received[..header_end].to_vec()).unwrap();
        let mut headers = BTreeMap::<String, String>::new();
        for line in head.lines().skip(1) {
            if let Some((name, value)) = line.split_once(':') {
                headers
                    .entry(name.to_ascii_lowercase())
                    .and_modify(|existing| {
                        existing.push_str(", ");
                        existing.push_str(value.trim());
                    })
                    .or_insert_with(|| value.trim().into());
            }
        }
        let length: usize = headers["content-length"].parse().unwrap();
        while received.len() < header_end + length {
            let n = stream.read(&mut buffer).await.unwrap();
            assert!(n > 0, "request ended before body");
            received.extend_from_slice(&buffer[..n]);
        }
        let body = serde_json::from_slice(&received[header_end..header_end + length]).unwrap();
        let line = head.lines().next().unwrap().to_string();
        let auth = headers.contains_key("authorization");
        let _ = received_tx.send(());
        if !wire.delay_headers {
            let status = wire.status.unwrap_or(200);
            let content_type = wire
                .content_type
                .unwrap_or("text/event-stream; charset=utf-8");
            let transfer = if wire.byte_chunks {
                "Transfer-Encoding: chunked\r\n"
            } else {
                ""
            };
            let location = wire
                .location
                .map(|url| format!("Location: {url}\r\n"))
                .unwrap_or_default();
            let head = format!("HTTP/1.1 {status} Test\r\nContent-Type: {content_type}\r\n{transfer}{location}Connection: close\r\n\r\n");
            let _ = stream.write_all(head.as_bytes()).await;
            if wire.byte_chunks {
                for byte in wire.bytes {
                    if stream
                        .write_all(&[b'1', b'\r', b'\n', byte, b'\r', b'\n'])
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                if !wire.hold_open {
                    let _ = stream.write_all(b"0\r\n\r\n").await;
                }
            } else {
                let _ = stream.write_all(&wire.bytes).await;
            }
            let _ = stream.flush().await;
            if !wire.hold_open {
                let _ = stream.shutdown().await;
            }
        }
        let mut transport = observe_disconnect(stream, line, auth).await;
        while let Ok(Ok(_)) =
            tokio::time::timeout(Duration::from_millis(25), listener.accept()).await
        {
            transport.request_count += 1;
        }
        let _ = tx.send(Observation {
            transport,
            headers,
            body,
        });
    });
    MessagesServer {
        base_url,
        observed,
        request_received,
    }
}

fn profile(base_url: &str) -> Value {
    let mut profile: Value =
        serde_json::from_str(&stored_profile("anthropic", base_url, true)).unwrap();
    profile["adapter"] = json!("anthropic");
    // Saved preferences are not an arbitrary native request-field bag.
    profile["generationDefaults"] =
        json!({"temperature":0.9,"maxOutputTokens":999,"tools":[{"name":"never-send"}]});
    profile
}

fn saved_store(profile: &Value) -> (LocalStore, TestSecretStore) {
    let store = LocalStore::open_in_memory().unwrap();
    store.put("anthropic", &profile.to_string(), "t").unwrap();
    let secrets = TestSecretStore::default();
    secrets.set("provider:anthropic:api-key", API_KEY).unwrap();
    secrets
        .set("provider:anthropic:gateway", "synthetic-gateway-key")
        .unwrap();
    (store, secrets)
}

fn wire_events(events: &[Value], multiline: bool) -> Vec<u8> {
    events
        .iter()
        .map(|event| {
            if let Some(marker) = event.as_str() {
                format!("data: {marker}\n\n")
            } else if multiline {
                // The parser joins data lines with a newline; JSON whitespace is legal.
                let lines = serde_json::to_string_pretty(event)
                    .unwrap()
                    .lines()
                    .map(|line| format!("data: {line}\r\n"))
                    .collect::<String>();
                format!("event: {}\r\n{lines}\r\n", event["type"].as_str().unwrap())
            } else {
                format!("data: {event}\n\n")
            }
        })
        .collect::<String>()
        .into_bytes()
}

fn message_start() -> Value {
    json!({"type":"message_start","message":{"id":"msg_loopback","type":"message","role":"assistant","model":"test-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}})
}

fn text_events(text: &str, stop_reason: &str) -> Vec<Value> {
    vec![
        message_start(),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":stop_reason,"stop_sequence":null},"usage":{"output_tokens":2}}),
        json!({"type":"message_stop"}),
    ]
}

fn text_delta(events: &[AiStreamEvent]) -> String {
    events
        .iter()
        .filter_map(|event| match event {
            AiStreamEvent::TextDelta { delta, .. } => Some(delta.as_str()),
            _ => None,
        })
        .collect()
}

fn reasoning_delta(events: &[AiStreamEvent]) -> String {
    events
        .iter()
        .filter_map(|event| match event {
            AiStreamEvent::ReasoningDelta { delta, .. } => Some(delta.as_str()),
            _ => None,
        })
        .collect()
}

fn assert_failure(events: &[AiStreamEvent], code: &str) {
    assert!(
        matches!(terminals(events)[0], AiExecutionResult::Failed(result) if result.error.code == code),
        "expected {code}, got {:?}",
        terminals(events)[0]
    );
    let serialized = serde_json::to_string(events).unwrap();
    for secret in [API_KEY, "synthetic-gateway-key", "synthetic-opaque"] {
        assert!(
            !serialized.contains(secret),
            "upstream private data must not leak"
        );
    }
}

async fn execute(wire: Wire, req: AiExecutionRequest) -> (Vec<AiStreamEvent>, Observation) {
    execute_with_profile(wire, req, |_| {}).await
}

async fn execute_with_profile(
    wire: Wire,
    req: AiExecutionRequest,
    configure: impl FnOnce(&mut Value),
) -> (Vec<AiStreamEvent>, Observation) {
    let server = messages_server(wire).await;
    let mut document = profile(&server.base_url);
    configure(&mut document);
    let (store, secrets) = saved_store(&document);
    let registry = RequestRegistry::default();
    let sink = CollectingSink::default();
    tokio::time::timeout(
        Duration::from_secs(10),
        stream_direct_ai("anthropic", req.clone(), &store, &secrets, &registry, &sink),
    )
    .await
    .expect("typed terminal must not wait for HTTP EOF")
    .unwrap();
    let events = sink.snapshot();
    assert_well_formed(&events, &req.request_id);
    assert_eq!(registry.len(), 0);
    let observation = tokio::time::timeout(Duration::from_secs(5), server.observed)
        .await
        .unwrap()
        .unwrap();
    assert!(
        observation.transport.client_disconnected,
        "execution must drop the response body"
    );
    assert_eq!(observation.transport.request_count, 1, "no silent retry");
    assert_eq!(
        observation.transport.request_line,
        "POST /prefix/v1/messages HTTP/1.1"
    );
    assert_eq!(observation.headers["x-api-key"], API_KEY);
    assert!(
        !observation.transport.saw_authorization,
        "apiKeyRef must not also create Bearer auth"
    );
    assert_eq!(observation.headers["anthropic-version"], "2026-10-21");
    assert_eq!(observation.headers["accept"], "text/event-stream");
    assert_eq!(observation.headers["content-type"], "application/json");
    assert_eq!(observation.body["stream"], true);
    for field in [
        "temperature",
        "top_p",
        "top_k",
        "tools",
        "tool_choice",
        "thinking",
        "response_format",
        "text",
        "output_config",
        "stream_options",
        "input",
        "store",
    ] {
        assert!(
            observation.body.get(field).is_none(),
            "unexpected Messages field {field}"
        );
    }
    let expected_resolves = 1 + document
        .get("secretHeaderRefs")
        .and_then(Value::as_object)
        .map_or(0, |headers| headers.len());
    assert_eq!(
        secrets
            .resolve_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        expected_resolves,
        "one credential snapshot, no hidden credential refresh or retry"
    );
    (events, observation)
}

#[tokio::test]
async fn anthropic_saved_profile_projects_messages_system_defaults_and_json_instruction() {
    for json_mode in [false, true] {
        let mut req = request("anthropic-request-projection");
        req.messages = [
            ("system", "第一条系统指令"),
            ("system", "第二条系统指令"),
            ("user", "开头"),
            ("assistant", "之前的回答"),
            ("user", "续问"),
            ("user", "最后补充"),
        ]
        .into_iter()
        .map(|(role, content)| AiExecutionMessage {
            role: role.into(),
            content: content.into(),
        })
        .collect();
        req.temperature = Some(0.65);
        if json_mode {
            req.model_id = Some("custom-fixture-model".into());
            req.max_output_tokens = Some(1234);
            req.response_format = Some("json".into());
        }
        let output = if json_mode {
            r#"{"name":"魔法少女"}"#
        } else {
            "魔法少女"
        };
        let (events, observed) = execute_with_profile(Wire {
            bytes: wire_events(&text_events(output, "end_turn"), false),
            hold_open: true,
            ..Wire::default()
        }, req.clone(), |profile| {
            profile["publicHeaders"] = json!({"Anthropic-Version":"2026-10-21","Accept":"text/event-stream","Content-Type":"application/json","anthropic-workspace-id":"workspace-loopback"});
            profile["secretHeaderRefs"] = json!({"x-gateway-key":"provider:anthropic:gateway"});
        }).await;
        assert!(
            matches!(terminals(&events)[0], AiExecutionResult::Completed(result) if result.output.text.as_deref() == Some(output))
        );
        assert_eq!(
            observed.body["model"],
            if json_mode {
                "custom-fixture-model"
            } else {
                "test-model"
            }
        );
        assert_eq!(
            observed.body["max_tokens"],
            if json_mode { 1234 } else { 4096 }
        );
        assert_eq!(
            observed.body["messages"],
            serde_json::to_value(&req.messages[2..]).unwrap()
        );
        let system = observed.body["system"]
            .as_array()
            .expect("system is a text-block array");
        assert_eq!(system[0], json!({"type":"text","text":"第一条系统指令"}));
        assert_eq!(system[1], json!({"type":"text","text":"第二条系统指令"}));
        if json_mode {
            assert!(system.iter().any(|block| block["text"].as_str().is_some_and(|text| text.to_ascii_lowercase().contains("json"))),
                "JSON mode needs an explicit textual instruction, not a fictitious structured-output field");
        } else {
            assert_eq!(system.len(), 2);
        }
        assert_eq!(
            observed.headers["anthropic-workspace-id"],
            "workspace-loopback"
        );
        assert_eq!(observed.headers["x-gateway-key"], "synthetic-gateway-key");
    }
}

#[tokio::test]
async fn anthropic_official_shaped_fixture_matches_the_normalized_consumer_contract() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let req: AiExecutionRequest = serde_json::from_value(case["request"].clone()).unwrap();
        let (events, _) = execute(
            Wire {
                bytes: wire_events(case["upstreamEvents"].as_array().unwrap(), false),
                hold_open: true,
                ..Wire::default()
            },
            req,
        )
        .await;
        let expected = &case["events"].as_array().unwrap().last().unwrap()["result"];
        assert_eq!(
            serde_json::to_value(terminals(&events)[0]).unwrap(),
            *expected,
            "{}",
            case["name"]
        );
        assert_eq!(
            text_delta(&events),
            expected["output"]["text"].as_str().unwrap()
        );
        assert_eq!(
            reasoning_delta(&events),
            expected["output"]["reasoning"].as_str().unwrap_or("")
        );
        assert!(!serde_json::to_string(&events)
            .unwrap()
            .contains("synthetic-opaque"));
        if let Ok(directory) = std::env::var("MAHO_NATIVE_EVENT_FIXTURE_DIR") {
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(
                std::path::Path::new(&directory)
                    .join(format!("anthropic-{}.json", case["name"].as_str().unwrap())),
                serde_json::to_vec_pretty(&events).unwrap(),
            )
            .unwrap();
        }
    }
}

async fn assert_no_dispatch(
    document: Value,
    req: AiExecutionRequest,
    listener: TcpListener,
    request_error: bool,
) {
    let (store, secrets) = saved_store(&document);
    let registry = RequestRegistry::default();
    let sink = CollectingSink::default();
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        stream_direct_ai("anthropic", req.clone(), &store, &secrets, &registry, &sink),
    )
    .await
    .unwrap();
    let events = sink.snapshot();
    if let Err(error) = result {
        let error = serde_json::to_value(error).unwrap();
        assert_eq!(
            error["code"],
            if request_error {
                "unsupported-request"
            } else {
                "profile-rejected"
            }
        );
        assert!(
            events.is_empty(),
            "pre-registration rejection must not leave partial lifecycle events"
        );
    } else {
        assert_well_formed(&events, &req.request_id);
        assert_failure(&events, "invalid-request");
    }
    assert_eq!(registry.len(), 0);
    assert!(
        tokio::time::timeout(Duration::from_millis(25), listener.accept())
            .await
            .is_err(),
        "invalid request or profile must not contact its configured endpoint"
    );
}

#[tokio::test]
async fn anthropic_invalid_roles_midstream_system_prefill_and_zero_limit_never_dispatch() {
    for roles in [
        vec!["developer", "user"],
        vec!["tool", "user"],
        vec!["function", "user"],
        vec!["assistant", "user"],
        vec!["user", "system", "user"],
        vec!["user", "assistant"],
        vec!["system"],
        vec!["unknown"],
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let document = profile(&format!("http://{}/v1", listener.local_addr().unwrap()));
        let mut req = request("anthropic-invalid-message");
        req.messages = roles
            .into_iter()
            .map(|role| AiExecutionMessage {
                role: role.into(),
                content: "fixture".into(),
            })
            .collect();
        assert_no_dispatch(document, req, listener, true).await;
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let document = profile(&format!("http://{}/v1", listener.local_addr().unwrap()));
    let mut req = request("anthropic-zero-limit");
    req.max_output_tokens = Some(0);
    assert_no_dispatch(document, req, listener, true).await;
}

#[tokio::test]
async fn anthropic_conflicting_version_transport_headers_and_duplicate_api_key_never_dispatch() {
    for patch in [
        json!({"publicHeaders":{"Anthropic-Version":"2023-06-01"}}),
        json!({"publicHeaders":{"Accept":"application/json"}}),
        json!({"publicHeaders":{"Content-Type":"text/plain"}}),
        json!({"secretHeaderRefs":{"X-API-Key":"provider:anthropic:gateway"}}),
        json!({"secretHeaderRefs":{"Anthropic-Version":"provider:anthropic:gateway"}}),
        json!({"secretHeaderRefs":{"Accept":"provider:anthropic:gateway"}}),
        json!({"secretHeaderRefs":{"Content-Type":"provider:anthropic:gateway"}}),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut document = profile(&format!("http://{}/v1", listener.local_addr().unwrap()));
        for (key, value) in patch.as_object().unwrap() {
            document[key] = value.clone();
        }
        assert_no_dispatch(
            document,
            request("anthropic-header-conflict"),
            listener,
            false,
        )
        .await;
    }
}

#[tokio::test]
async fn anthropic_utf8_every_byte_multiline_frames_and_initial_text_are_preserved_once() {
    let mut upstream = text_events("少女・かなé🪄", "end_turn");
    upstream[1]["content_block"]["text"] = json!("魔法");
    let (events, _) = execute(
        Wire {
            bytes: wire_events(&upstream, true),
            byte_chunks: true,
            ..Wire::default()
        },
        request("anthropic-unicode"),
    )
    .await;
    assert_eq!(text_delta(&events), "魔法少女・かなé🪄");
    assert!(
        matches!(terminals(&events)[0], AiExecutionResult::Completed(result) if result.output.text.as_deref() == Some("魔法少女・かなé🪄"))
    );
    for bytes in [vec![0xff], vec![0xf0, 0x9f]] {
        let (events, _) = execute(
            Wire {
                bytes,
                byte_chunks: true,
                ..Wire::default()
            },
            request("anthropic-bad-utf8"),
        )
        .await;
        assert_failure(&events, "invalid-response");
    }
}

#[tokio::test]
async fn anthropic_stop_reasons_fail_honestly_and_keep_partial_text() {
    for (reason, code) in [
        ("max_tokens", "output-too-large"),
        ("model_context_window_exceeded", "output-too-large"),
        ("refusal", "content-filtered"),
        ("tool_use", "invalid-response"),
        ("pause_turn", "invalid-response"),
        ("unknown-reason", "invalid-response"),
    ] {
        let (events, _) = execute(
            Wire {
                bytes: wire_events(&text_events("保留已经投递的正文", reason), false),
                hold_open: true,
                ..Wire::default()
            },
            request("anthropic-stop-reason"),
        )
        .await;
        assert_failure(&events, code);
        assert_eq!(text_delta(&events), "保留已经投递的正文");
    }
}

#[tokio::test]
async fn anthropic_eof_chat_done_and_http_200_errors_cannot_complete_partial_text() {
    for (ending, code) in [
        (Vec::new(), "invalid-response"),
        (b"data: [DONE]\n\n".to_vec(), "invalid-response"),
        (
            wire_events(
                &[json!({"type":"error","error":{"type":"rate_limit_error","message":API_KEY}})],
                false,
            ),
            "rate-limited",
        ),
        (
            wire_events(
                &[json!({"type":"error","error":{"type":"overloaded_error","message":API_KEY}})],
                false,
            ),
            "service-unavailable",
        ),
    ] {
        let mut bytes = wire_events(&text_events("半截正文", "end_turn")[..3], false);
        bytes.extend_from_slice(&ending);
        let (events, _) = execute(
            Wire {
                bytes,
                ..Wire::default()
            },
            request("anthropic-partial-failure"),
        )
        .await;
        assert_failure(&events, code);
        assert_eq!(text_delta(&events), "半截正文");
    }
    let all = text_events("不能提前成功", "end_turn");
    let mut bytes = wire_events(&all[..all.len() - 1], false);
    bytes.extend_from_slice(b"data: [DONE]\n\n");
    bytes.extend_from_slice(&wire_events(&all[all.len() - 1..], false));
    let (events, _) = execute(
        Wire {
            bytes,
            ..Wire::default()
        },
        request("anthropic-done-before-stop"),
    )
    .await;
    assert_failure(&events, "invalid-response");
}

#[tokio::test]
async fn anthropic_unsupported_blocks_and_invalid_lifecycles_are_not_silent_successes() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    for case in fixture["failureCases"].as_array().unwrap() {
        // The reducer rejects data after a terminal. HTTP transport instead stops
        // consuming at its first terminal, as the late-events test below proves.
        if case["name"] == "duplicate-message-stop" {
            continue;
        }
        let req = request(&format!(
            "anthropic-failure-{}",
            case["name"].as_str().unwrap()
        ));
        let (events, _) = execute(
            Wire {
                bytes: wire_events(case["upstreamEvents"].as_array().unwrap(), false),
                ..Wire::default()
            },
            req.clone(),
        )
        .await;
        assert_failure(&events, case["expectedCode"].as_str().unwrap());
        if let Ok(directory) = std::env::var("MAHO_NATIVE_EVENT_FIXTURE_DIR") {
            std::fs::create_dir_all(&directory).unwrap();
            let packet = json!({"request":req,"events":events,"expectedCode":case["expectedCode"]});
            std::fs::write(
                std::path::Path::new(&directory).join(format!(
                    "anthropic-failure-{}.json",
                    case["name"].as_str().unwrap()
                )),
                serde_json::to_vec_pretty(&packet).unwrap(),
            )
            .unwrap();
        }
    }
    for block in [
        json!({"type":"tool_use","id":"tool_fixture","name":"unsupported","input":{}}),
        json!({"type":"server_tool_use","id":"tool_fixture","name":"web_search","input":{}}),
        json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"synthetic-opaque"}}),
        json!({"type":"future_content","value":"synthetic-opaque"}),
    ] {
        let mut upstream = text_events("已输出正文", "end_turn")[..4].to_vec();
        upstream.push(json!({"type":"content_block_start","index":1,"content_block":block}));
        let (events, _) = execute(
            Wire {
                bytes: wire_events(&upstream, false),
                ..Wire::default()
            },
            request("anthropic-unsupported-block"),
        )
        .await;
        assert_failure(&events, "invalid-response");
        assert_eq!(text_delta(&events), "已输出正文");
    }
}

#[tokio::test]
async fn anthropic_typed_terminal_is_exactly_once_and_drops_late_events_without_waiting_for_eof() {
    let mut upstream = text_events("完成", "end_turn");
    upstream.extend([
        json!({"type":"message_stop"}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"late"}}),
        json!({"type":"error","error":{"type":"api_error","message":API_KEY}}),
    ]);
    let (events, _) = execute(
        Wire {
            bytes: wire_events(&upstream, false),
            hold_open: true,
            ..Wire::default()
        },
        request("anthropic-late-events"),
    )
    .await;
    assert_eq!(text_delta(&events), "完成");
    assert!(
        matches!(terminals(&events)[0], AiExecutionResult::Completed(result) if result.output.text.as_deref() == Some("完成"))
    );
}

#[tokio::test]
async fn anthropic_http_errors_and_wrong_mime_are_safe_failures_without_retry() {
    for (status, code) in [
        (400, "invalid-request"),
        (401, "authentication-failed"),
        (403, "permission-denied"),
        (413, "output-too-large"),
        (429, "rate-limited"),
        (503, "service-unavailable"),
    ] {
        let (events, _) = execute(
            Wire {
                bytes: API_KEY.as_bytes().to_vec(),
                status: Some(status),
                ..Wire::default()
            },
            request("anthropic-http-error"),
        )
        .await;
        assert_failure(&events, code);
    }
    for content_type in [
        "application/json",
        "text/html",
        "text/event-stream-not-really",
    ] {
        let (events, _) = execute(
            Wire {
                bytes: wire_events(&text_events("must-not-be-accepted", "end_turn"), false),
                content_type: Some(content_type),
                ..Wire::default()
            },
            request("anthropic-wrong-mime"),
        )
        .await;
        assert_failure(&events, "invalid-response");
        assert_eq!(
            text_delta(&events),
            "",
            "do not parse non-SSE payloads as a valid provider stream"
        );
    }
}

#[tokio::test]
async fn anthropic_redirects_do_not_leak_saved_credentials_or_prompts_to_another_origin() {
    for max_redirects in [0, 3] {
        let other_origin = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (events, _) = execute_with_profile(
            Wire {
                status: Some(307),
                location: Some(format!(
                    "http://{}/capture",
                    other_origin.local_addr().unwrap()
                )),
                ..Wire::default()
            },
            request("anthropic-cross-origin"),
            |profile| {
                profile["transport"] = json!({"maxRedirects":max_redirects});
                profile["secretHeaderRefs"] = json!({"x-gateway-key":"provider:anthropic:gateway"});
            },
        )
        .await;
        assert!(matches!(
            terminals(&events)[0],
            AiExecutionResult::Failed(_)
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(25), other_origin.accept())
                .await
                .is_err(),
            "cross-origin redirects must not receive any prompt or secret header"
        );
    }
}

struct CancellingSink {
    registry: RequestRegistry,
    sink: CollectingSink,
    on_start: bool,
}

impl EventSink for CancellingSink {
    fn send(&self, event: AiStreamEvent) -> Result<(), ()> {
        if matches!(&event, AiStreamEvent::Started { .. }) && self.on_start
            || matches!(&event, AiStreamEvent::TextDelta { .. }) && !self.on_start
        {
            assert!(self.registry.cancel(event.identity().0));
        }
        self.sink.send(event)
    }
}

#[tokio::test]
async fn anthropic_cancellation_on_start_never_posts_and_clears_registration() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (store, secrets) = saved_store(&profile(&format!(
        "http://{}/v1",
        listener.local_addr().unwrap()
    )));
    let registry = RequestRegistry::default();
    let sink = CancellingSink {
        registry: registry.clone(),
        sink: CollectingSink::default(),
        on_start: true,
    };
    stream_direct_ai(
        "anthropic",
        request("anthropic-early-cancel"),
        &store,
        &secrets,
        &registry,
        &sink,
    )
    .await
    .unwrap();
    let events = sink.sink.snapshot();
    assert_well_formed(&events, "anthropic-early-cancel");
    assert!(matches!(
        terminals(&events)[0],
        AiExecutionResult::Cancelled(_)
    ));
    assert!(
        tokio::time::timeout(Duration::from_millis(25), listener.accept())
            .await
            .is_err()
    );
    assert_eq!(registry.len(), 0);
}

#[tokio::test]
async fn anthropic_cancellation_drops_pending_headers_and_idle_body_retaining_partial_text() {
    for delay_headers in [true, false] {
        let server = messages_server(Wire {
            bytes: wire_events(&text_events("部分正文", "end_turn")[..3], false),
            hold_open: true,
            delay_headers,
            ..Wire::default()
        })
        .await;
        let (store, secrets) = saved_store(&profile(&server.base_url));
        let registry = RequestRegistry::default();
        let sink = CollectingSink::default();
        let stream = stream_direct_ai(
            "anthropic",
            request("anthropic-running-cancel"),
            &store,
            &secrets,
            &registry,
            &sink,
        );
        tokio::pin!(stream);
        tokio::select! {
            result = &mut stream => panic!("unexpected completion before cancellation: {result:?}"),
            _ = async {
                server.request_received.await.unwrap();
                if !delay_headers {
                    tokio::time::timeout(Duration::from_secs(5), async {
                        while text_delta(&sink.snapshot()).is_empty() {
                            tokio::time::sleep(Duration::from_millis(5)).await;
                        }
                    }).await.expect("idle body must not prevent timed delta flush");
                }
            } => {}
        }
        assert!(registry.cancel("anthropic-running-cancel"));
        tokio::time::timeout(Duration::from_secs(5), stream)
            .await
            .unwrap()
            .unwrap();
        let events = sink.snapshot();
        assert_well_formed(&events, "anthropic-running-cancel");
        assert!(matches!(
            terminals(&events)[0],
            AiExecutionResult::Cancelled(_)
        ));
        assert_eq!(
            text_delta(&events),
            if delay_headers { "" } else { "部分正文" }
        );
        assert_eq!(registry.len(), 0);
        let observed = tokio::time::timeout(Duration::from_secs(5), server.observed)
            .await
            .unwrap()
            .unwrap();
        assert!(observed.transport.client_disconnected);
        assert_eq!(observed.transport.request_count, 1);
    }
}

#[tokio::test]
async fn anthropic_cancellation_wins_when_text_flush_and_message_stop_share_a_tick() {
    // Short text flushes during terminal finalization; longer text crosses the
    // aggregation threshold in the same read as message_stop. Cancellation wins
    // over both successful and failed provider endings, including final flushes.
    for (text, reason) in ["end_turn", "refusal", "max_tokens"]
        .into_iter()
        .flat_map(|reason| [("同轮取消".to_string(), reason), ("x".repeat(64), reason)])
    {
        let server = messages_server(Wire {
            bytes: wire_events(&text_events(&text, reason), false),
            hold_open: true,
            ..Wire::default()
        })
        .await;
        let (store, secrets) = saved_store(&profile(&server.base_url));
        let registry = RequestRegistry::default();
        let sink = CancellingSink {
            registry: registry.clone(),
            sink: CollectingSink::default(),
            on_start: false,
        };
        tokio::time::timeout(
            Duration::from_secs(5),
            stream_direct_ai(
                "anthropic",
                request("anthropic-terminal-cancel"),
                &store,
                &secrets,
                &registry,
                &sink,
            ),
        )
        .await
        .unwrap()
        .unwrap();
        let events = sink.sink.snapshot();
        assert_well_formed(&events, "anthropic-terminal-cancel");
        assert!(
            matches!(terminals(&events)[0], AiExecutionResult::Cancelled(_)),
            "cancellation cannot publish a late success"
        );
        assert_eq!(text_delta(&events), text);
        assert_eq!(registry.len(), 0);
        assert!(
            tokio::time::timeout(Duration::from_secs(5), server.observed)
                .await
                .unwrap()
                .unwrap()
                .transport
                .client_disconnected
        );
    }
}

#[tokio::test]
async fn anthropic_arena_fixed_content_budget_and_utf16_ipc_limit_are_enforced() {
    for (size, accepted) in [
        (crate::ai::ARENA_OUTPUT_CONTENT_BYTES, true),
        (crate::ai::ARENA_OUTPUT_CONTENT_BYTES + 1, false),
    ] {
        let text = "x".repeat(size);
        let mut upstream = text_events(&text[1..], "end_turn");
        upstream[1]["content_block"]["text"] = json!("x");
        let (events, _) = execute(
            Wire {
                bytes: wire_events(&upstream, false),
                ..Wire::default()
            },
            arena_request("anthropic-arena-limit"),
        )
        .await;
        if accepted {
            assert!(
                matches!(terminals(&events)[0], AiExecutionResult::Completed(result) if result.output.text.as_deref() == Some(text.as_str()))
            );
            assert_eq!(text_delta(&events).len(), size);
        } else {
            assert_failure(&events, "output-too-large");
            assert_eq!(
                text_delta(&events),
                "x",
                "overflow retains previously accepted text, never the overflowing delta"
            );
        }
        assert!(events.iter().all(|event| match event {
            AiStreamEvent::TextDelta { delta, .. }
            | AiStreamEvent::ReasoningDelta { delta, .. } =>
                delta.encode_utf16().count() <= crate::ai::AI_STREAM_MAX_DELTA_UTF16_UNITS,
            _ => true,
        }));
    }
    let text = "🪄".repeat(crate::ai::AI_STREAM_MAX_DELTA_UTF16_UNITS);
    let (events, _) = execute(
        Wire {
            bytes: wire_events(&text_events(&text, "end_turn"), false),
            ..Wire::default()
        },
        arena_request("anthropic-arena-surrogates"),
    )
    .await;
    assert_eq!(text_delta(&events), text);
    assert!(events.iter().all(|event| match event {
        AiStreamEvent::TextDelta { delta, .. } =>
            delta.encode_utf16().count() <= crate::ai::AI_STREAM_MAX_DELTA_UTF16_UNITS,
        _ => true,
    }));
}

fn opaque_payload(size: usize) -> String {
    let prefix = "synthetic-opaque";
    assert!(size >= prefix.len());
    format!("{prefix}{}", "x".repeat(size - prefix.len()))
}

fn opaque_events(
    signature_chunks: &[String],
    redacted_blocks: &[String],
    initial_signature: bool,
) -> Vec<Value> {
    let mut upstream = text_events("保留正文", "end_turn")[..4].to_vec();
    let initial = if initial_signature {
        signature_chunks.first().map(String::as_str).unwrap_or("")
    } else {
        ""
    };
    upstream.push(json!({"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":"","signature":initial}}));
    for signature in signature_chunks.iter().skip(usize::from(initial_signature)) {
        upstream.push(json!({"type":"content_block_delta","index":1,"delta":{"type":"signature_delta","signature":signature}}));
    }
    upstream.push(json!({"type":"content_block_stop","index":1}));
    for (offset, data) in redacted_blocks.iter().enumerate() {
        let index = offset + 2;
        upstream.push(json!({"type":"content_block_start","index":index,"content_block":{"type":"redacted_thinking","data":data}}));
        upstream.push(json!({"type":"content_block_stop","index":index}));
    }
    upstream.extend(text_events("", "end_turn")[4..].iter().cloned());
    upstream
}

#[tokio::test]
async fn anthropic_large_signed_and_redacted_thinking_stays_opaque_within_its_own_budget() {
    // Opaque reasoning is not ordinary metadata. Cover an initial signature,
    // a full-budget single delta frame, and exact combined signature/redacted
    // budget across smaller frames, in both normal and Arena request modes.
    for (signature, redacted, initial) in [
        (
            vec![opaque_payload(32 * 1024), opaque_payload(64 * 1024)],
            vec![opaque_payload(128 * 1024)],
            true,
        ),
        (vec![opaque_payload(4 * 1024 * 1024)], Vec::new(), false),
        (
            vec![opaque_payload(64 * 1024); 32],
            vec![opaque_payload(128 * 1024); 16],
            true,
        ),
    ] {
        for req in [
            request("anthropic-large-opaque"),
            arena_request("anthropic-arena-large-opaque"),
        ] {
            let (events, _) = execute(
                Wire {
                    bytes: wire_events(&opaque_events(&signature, &redacted, initial), false),
                    hold_open: true,
                    ..Wire::default()
                },
                req,
            )
            .await;
            assert!(
                matches!(terminals(&events)[0], AiExecutionResult::Completed(result)
                if result.output.text.as_deref() == Some("保留正文") && result.output.reasoning.is_none())
            );
            assert_eq!(text_delta(&events), "保留正文");
            assert_eq!(reasoning_delta(&events), "");
            assert!(
                !serde_json::to_string(&events)
                    .unwrap()
                    .contains("synthetic-opaque"),
                "opaque reasoning must neither become an event nor be persisted in the result"
            );
        }
    }
}

#[tokio::test]
async fn anthropic_arena_signature_and_redacted_chunks_share_a_four_mib_budget() {
    // Each frame is comfortably below the parser cap. Overflow is cumulative,
    // including the mixed case in which neither individual category exceeds it.
    for (signature, redacted) in [
        (vec![opaque_payload(64 * 1024); 65], Vec::new()),
        (Vec::new(), vec![opaque_payload(128 * 1024); 33]),
        (
            vec![opaque_payload(64 * 1024); 33],
            vec![opaque_payload(128 * 1024); 16],
        ),
    ] {
        let (events, _) = execute(
            Wire {
                bytes: wire_events(&opaque_events(&signature, &redacted, false), false),
                hold_open: true,
                ..Wire::default()
            },
            arena_request("anthropic-arena-opaque-limit"),
        )
        .await;
        assert_failure(&events, "output-too-large");
        assert_eq!(text_delta(&events), "保留正文");
        assert_eq!(
            reasoning_delta(&events),
            "",
            "opaque signature/redacted data is never readable reasoning"
        );
    }
}

#[tokio::test]
async fn anthropic_arena_small_unknown_frames_keep_the_separate_metadata_budget() {
    let mut upstream = text_events("保留正文", "end_turn")[..4].to_vec();
    for _ in 0..20 {
        upstream.push(json!({"type":"future_metadata","opaque":opaque_payload(1024)}));
    }
    let (events, _) = execute(
        Wire {
            bytes: wire_events(&upstream, false),
            hold_open: true,
            ..Wire::default()
        },
        arena_request("anthropic-arena-metadata-limit"),
    )
    .await;
    assert_failure(&events, "output-too-large");
    assert_eq!(text_delta(&events), "保留正文");
    assert_eq!(reasoning_delta(&events), "");
}

#[tokio::test]
async fn anthropic_ignored_comments_still_consume_the_cumulative_wire_budget() {
    let mut bytes = wire_events(&text_events("保留正文", "end_turn")[..4], false);
    // Every complete frame is small. SSE comments disappear before typed event
    // reduction, so only a transport-level wire counter can catch this stream.
    let comment = format!(": {}\n\n", "x".repeat(16 * 1024));
    while bytes.len() <= crate::ai::ARENA_MAX_WIRE_BYTES {
        bytes.extend_from_slice(comment.as_bytes());
    }
    for req in [
        request("anthropic-wire-budget"),
        arena_request("anthropic-arena-wire-budget"),
    ] {
        let (events, _) = execute(
            Wire {
                bytes: bytes.clone(),
                hold_open: true,
                ..Wire::default()
            },
            req,
        )
        .await;
        assert_failure(&events, "output-too-large");
        assert_eq!(text_delta(&events), "保留正文");
    }
}
