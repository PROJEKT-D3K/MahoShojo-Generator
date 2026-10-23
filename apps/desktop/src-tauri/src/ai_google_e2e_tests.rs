//! Saved Google profiles over real loopback HTTP/SSE, without provider calls.
use super::*;
use serde_json::{json, Value};
use std::time::Duration;

const FIXTURE: &str =
    include_str!("../../../../packages/contracts/fixtures/gemini-generate-content-stream.json");
const API_KEY: &str = "synthetic-gemini-key";

#[derive(Default)]
struct Wire {
    bytes: Vec<u8>,
    byte_chunks: bool,
    hold_open: bool,
    truncated: bool,
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

struct GoogleServer {
    base_url: String,
    observed: oneshot::Receiver<Observation>,
    request_received: oneshot::Receiver<()>,
}

async fn google_server(wire: Wire) -> GoogleServer {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/prefix/v1beta///", listener.local_addr().unwrap());
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
                if !wire.hold_open && !wire.truncated {
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
    GoogleServer {
        base_url,
        observed,
        request_received,
    }
}

fn profile(base_url: &str) -> Value {
    let mut profile: Value =
        serde_json::from_str(&stored_profile("google", base_url, true)).unwrap();
    profile["adapter"] = json!("google");
    // Saved preferences are not an arbitrary native request-field bag.
    profile["generationDefaults"] =
        json!({"temperature":0.9,"maxOutputTokens":999,"tools":[{"name":"never-send"}]});
    profile
}

fn saved_store(profile: &Value) -> (LocalStore, TestSecretStore) {
    let store = LocalStore::open_in_memory().unwrap();
    store.put("google", &profile.to_string(), "t").unwrap();
    let secrets = TestSecretStore::default();
    secrets.set("provider:google:api-key", API_KEY).unwrap();
    secrets
        .set("provider:google:gateway", "synthetic-gateway-key")
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
                let lines = serde_json::to_string_pretty(event)
                    .unwrap()
                    .lines()
                    .map(|line| format!("data: {line}\r\n"))
                    .collect::<String>();
                format!(": heartbeat\r\nevent: message\r\n{lines}\r\n")
            } else {
                format!("data: {event}\n\n")
            }
        })
        .collect::<String>()
        .into_bytes()
}

fn text_events(text: &str, reason: &str) -> Vec<Value> {
    vec![
        json!({"candidates":[{"content":{"parts":[{"text":text}]}}]}),
        json!({"candidates":[{"finishReason":reason}]}),
        json!({"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}),
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
    let server = google_server(wire).await;
    let mut document = profile(&server.base_url);
    configure(&mut document);
    let (store, secrets) = saved_store(&document);
    let registry = RequestRegistry::default();
    let sink = CollectingSink::default();
    tokio::time::timeout(
        Duration::from_secs(10),
        stream_direct_ai("google", req.clone(), &store, &secrets, &registry, &sink),
    )
    .await
    .expect("fixture must complete or fail")
    .unwrap();
    let events = sink.snapshot();
    assert_well_formed(&events, &req.request_id);
    assert_eq!(registry.len(), 0);
    let observation = tokio::time::timeout(Duration::from_secs(5), server.observed)
        .await
        .unwrap()
        .unwrap();
    assert!(observation.transport.client_disconnected);
    assert_eq!(
        observation.transport.request_count, 1,
        "no retry or continuation"
    );
    assert!(!observation.transport.saw_authorization);
    if document.get("apiKeyRef").is_some() {
        assert_eq!(observation.headers["x-goog-api-key"], API_KEY);
    }
    assert!(!observation.transport.request_line.contains(API_KEY));
    assert_eq!(observation.headers["accept"], "text/event-stream");
    assert_eq!(observation.headers["content-type"], "application/json");
    for field in [
        "model",
        "stream",
        "messages",
        "input",
        "store",
        "stream_options",
        "response_format",
        "tools",
        "thinkingConfig",
        "candidateCount",
    ] {
        assert!(
            observation.body.get(field).is_none(),
            "unexpected field {field}"
        );
    }
    (events, observation)
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
        stream_direct_ai("google", req.clone(), &store, &secrets, &registry, &sink),
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
async fn google_request_projects_system_roles_parameters_and_endpoint_model_override() {
    for json_mode in [false, true] {
        let mut req = request("google-request");
        req.messages = [
            ("system", "系统一"),
            ("system", "系统二"),
            ("assistant", "旧回答"),
            ("user", "问一"),
            ("user", "问二"),
            ("assistant", "保留末尾model"),
        ]
        .into_iter()
        .map(|(role, content)| AiExecutionMessage {
            role: role.into(),
            content: content.into(),
        })
        .collect();
        req.model_id = Some("models/custom:model%2Fname".into());
        req.temperature = Some(0.65);
        req.max_output_tokens = json_mode.then_some(1234);
        req.response_format = json_mode.then(|| "json".into());
        let (events, observed) = execute_with_profile(
            Wire {
                bytes: wire_events(&text_events("完成", "STOP"), false),
                ..Wire::default()
            },
            req,
            |profile| {
                profile["publicHeaders"] = json!({"x-gateway-region":"test"});
                profile["secretHeaderRefs"] = json!({"x-gateway-key":"provider:google:gateway"});
            },
        )
        .await;
        assert!(matches!(
            terminals(&events)[0],
            AiExecutionResult::Completed(_)
        ));
        assert_eq!(observed.transport.request_line, "POST /prefix/v1beta/models/custom%3Amodel%252Fname:streamGenerateContent?alt=sse HTTP/1.1");
        assert_eq!(
            observed.body["contents"],
            json!([
            {"role":"model","parts":[{"text":"旧回答"}]},{"role":"user","parts":[{"text":"问一"}]},
            {"role":"user","parts":[{"text":"问二"}]},{"role":"model","parts":[{"text":"保留末尾model"}]}])
        );
        assert_eq!(
            observed.body["systemInstruction"]["parts"][0],
            json!({"text":"系统一"})
        );
        assert_eq!(
            observed.body["systemInstruction"]["parts"][1],
            json!({"text":"系统二"})
        );
        assert_eq!(
            observed.body["generationConfig"]["temperature"],
            json!(0.65)
        );
        assert_eq!(
            observed.body["generationConfig"]["maxOutputTokens"],
            if json_mode { json!(1234) } else { Value::Null }
        );
        assert_eq!(
            observed.body["generationConfig"]["responseMimeType"],
            if json_mode {
                json!("application/json")
            } else {
                Value::Null
            }
        );
        assert!(observed.body["generationConfig"]
            .get("thinkingConfig")
            .is_none());
        assert_eq!(observed.headers["x-gateway-key"], "synthetic-gateway-key");
    }
}

#[tokio::test]
async fn google_official_shaped_fixture_matches_shared_normalized_contract_and_exports_actual_events(
) {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let req: AiExecutionRequest = serde_json::from_value(case["request"].clone()).unwrap();
        let (events, _) = execute(
            Wire {
                bytes: wire_events(case["upstreamEvents"].as_array().unwrap(), false),
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
                    .join(format!("gemini-{}.json", case["name"].as_str().unwrap())),
                serde_json::to_vec_pretty(&events).unwrap(),
            )
            .unwrap();
        }
    }
    for case in fixture["failureCases"].as_array().unwrap() {
        let req = request(&format!(
            "google-failure-{}",
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
        assert!(!serde_json::to_string(&events)
            .unwrap()
            .contains("synthetic-secret"));
        if let Ok(directory) = std::env::var("MAHO_NATIVE_EVENT_FIXTURE_DIR") {
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(
                std::path::Path::new(&directory).join(format!(
                    "gemini-failure-{}.json",
                    case["name"].as_str().unwrap()
                )),
                serde_json::to_vec_pretty(
                    &json!({"request":req,"events":events,"expectedCode":case["expectedCode"]}),
                )
                .unwrap(),
            )
            .unwrap();
        }
    }
}

#[tokio::test]
async fn google_invalid_request_models_roles_settings_and_profile_headers_never_dispatch() {
    for model in [
        ".",
        "..",
        "models/../x",
        "models/models/x",
        "https://evil.invalid/x",
        "a/b",
        "a\\b",
        "a?key=secret",
        "a#x",
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let document = profile(&format!("http://{}/v1beta", listener.local_addr().unwrap()));
        let mut req = request("google-invalid-model");
        req.model_id = Some(model.into());
        assert_no_dispatch(document, req, listener, true).await;
    }
    for roles in [
        vec!["system"],
        vec!["user", "system"],
        vec!["developer", "user"],
        vec!["tool", "user"],
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let document = profile(&format!("http://{}/v1beta", listener.local_addr().unwrap()));
        let mut req = request("google-invalid-roles");
        req.messages = roles
            .into_iter()
            .map(|role| AiExecutionMessage {
                role: role.into(),
                content: "test".into(),
            })
            .collect();
        assert_no_dispatch(document, req, listener, true).await;
    }
    for (max, temperature) in [
        (Some(0), None),
        (None, Some(-0.1)),
        (None, Some(2.01)),
        (None, Some(f64::NAN)),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let document = profile(&format!("http://{}/v1beta", listener.local_addr().unwrap()));
        let mut req = request("google-invalid-settings");
        req.max_output_tokens = max;
        req.temperature = temperature;
        assert_no_dispatch(document, req, listener, true).await;
    }
    for patch in [
        json!({"publicHeaders":{"Accept":"application/json"}}),
        json!({"publicHeaders":{"Content-Type":"text/plain"}}),
        json!({"secretHeaderRefs":{"X-Goog-Api-Key":"provider:google:gateway"}}),
        json!({"secretHeaderRefs":{"accept":"provider:google:gateway"}}),
        json!({"secretHeaderRefs":{"x-gateway":"provider:google:gateway","X-Gateway":"provider:google:gateway"}}),
        json!({"publicHeaders":{"x-goog-api-key":"synthetic-secret"}}),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut document = profile(&format!("http://{}/v1beta", listener.local_addr().unwrap()));
        for (key, value) in patch.as_object().unwrap() {
            document[key] = value.clone();
        }
        assert_no_dispatch(document, request("google-invalid-headers"), listener, false).await;
    }
}

#[tokio::test]
async fn google_utf8_multiline_tail_frames_and_late_usage_require_normal_eof() {
    let mut bytes = wire_events(&text_events("魔法少女・かなé🪄", "STOP"), true);
    while bytes
        .last()
        .is_some_and(|value| matches!(value, b'\r' | b'\n'))
    {
        bytes.pop();
    }
    let (events, observed) = execute(
        Wire {
            bytes,
            byte_chunks: true,
            ..Wire::default()
        },
        request("google-unicode"),
    )
    .await;
    assert_eq!(text_delta(&events), "魔法少女・かなé🪄");
    assert!(
        matches!(terminals(&events)[0], AiExecutionResult::Completed(result) if result.usage.as_ref().unwrap().total_tokens == Some(5))
    );
    assert_eq!(
        observed.transport.request_line,
        "POST /prefix/v1beta/models/test-model:streamGenerateContent?alt=sse HTTP/1.1"
    );
    for bytes in [vec![0xff], vec![0xf0, 0x9f], b"data: [DONE]\n\n".to_vec()] {
        let (events, _) = execute(
            Wire {
                bytes,
                byte_chunks: true,
                ..Wire::default()
            },
            request("google-malformed-wire"),
        )
        .await;
        assert_failure(&events, "invalid-response");
    }
    let (events, _) = execute(
        Wire {
            bytes: wire_events(&text_events("保留正文", "STOP"), false),
            byte_chunks: true,
            truncated: true,
            ..Wire::default()
        },
        request("google-truncated-http"),
    )
    .await;
    assert_failure(&events, "service-unavailable");
    assert_eq!(text_delta(&events), "保留正文");
}

#[tokio::test]
async fn google_no_key_proxy_is_allowed_but_missing_secret_fails_before_http() {
    let (events, observed) = execute_with_profile(
        Wire {
            bytes: wire_events(&text_events("ok", "STOP"), false),
            ..Wire::default()
        },
        request("google-keyless"),
        |profile| {
            profile.as_object_mut().unwrap().remove("apiKeyRef");
        },
    )
    .await;
    assert!(matches!(
        terminals(&events)[0],
        AiExecutionResult::Completed(_)
    ));
    assert!(!observed.headers.contains_key("x-goog-api-key"));
    let (events, observed) = execute_with_profile(
        Wire {
            bytes: wire_events(&text_events("ok", "STOP"), false),
            ..Wire::default()
        },
        request("google-header-key"),
        |profile| {
            profile.as_object_mut().unwrap().remove("apiKeyRef");
            profile["secretHeaderRefs"] = json!({"X-Goog-Api-Key":"provider:google:gateway"});
        },
    )
    .await;
    assert!(matches!(
        terminals(&events)[0],
        AiExecutionResult::Completed(_)
    ));
    assert_eq!(observed.headers["x-goog-api-key"], "synthetic-gateway-key");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (store, _) = saved_store(&profile(&format!(
        "http://{}/v1beta",
        listener.local_addr().unwrap()
    )));
    let registry = RequestRegistry::default();
    let sink = CollectingSink::default();
    stream_direct_ai(
        "google",
        request("google-missing-key"),
        &store,
        &TestSecretStore::default(),
        &registry,
        &sink,
    )
    .await
    .unwrap();
    assert_failure(&sink.snapshot(), "authentication-failed");
    assert_eq!(registry.len(), 0);
    assert!(
        tokio::time::timeout(Duration::from_millis(25), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn google_http_error_mime_and_cross_origin_redirects_fail_without_leaks_or_retries() {
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
            request("google-http-error"),
        )
        .await;
        assert_failure(&events, code);
    }
    let (events, _) = execute(
        Wire {
            bytes: wire_events(&text_events("no", "STOP"), false),
            content_type: Some("application/json"),
            ..Wire::default()
        },
        request("google-wrong-mime"),
    )
    .await;
    assert_failure(&events, "invalid-response");
    assert!(text_delta(&events).is_empty());
    for max_redirects in [0, 3] {
        let other = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (events, _) = execute_with_profile(
            Wire {
                status: Some(307),
                location: Some(format!("http://{}/capture", other.local_addr().unwrap())),
                ..Wire::default()
            },
            request("google-redirect"),
            |profile| {
                profile["transport"] = json!({"maxRedirects":max_redirects});
            },
        )
        .await;
        assert!(matches!(
            terminals(&events)[0],
            AiExecutionResult::Failed(_)
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(25), other.accept())
                .await
                .is_err()
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
async fn google_cancellation_before_dispatch_and_during_final_flush_wins_exactly_once() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (store, secrets) = saved_store(&profile(&format!(
        "http://{}/v1beta",
        listener.local_addr().unwrap()
    )));
    let registry = RequestRegistry::default();
    let sink = CancellingSink {
        registry: registry.clone(),
        sink: CollectingSink::default(),
        on_start: true,
    };
    stream_direct_ai(
        "google",
        request("google-early-cancel"),
        &store,
        &secrets,
        &registry,
        &sink,
    )
    .await
    .unwrap();
    assert_well_formed(&sink.sink.snapshot(), "google-early-cancel");
    assert!(matches!(
        terminals(&sink.sink.snapshot())[0],
        AiExecutionResult::Cancelled(_)
    ));
    assert_eq!(registry.len(), 0);
    assert!(
        tokio::time::timeout(Duration::from_millis(25), listener.accept())
            .await
            .is_err()
    );
    for (text, reason) in [
        ("短正文", "STOP"),
        ("短正文", "SAFETY"),
        ("短正文", "MAX_TOKENS"),
        (
            "a very long response crossing the aggregation threshold at once",
            "STOP",
        ),
    ] {
        let server = google_server(Wire {
            bytes: wire_events(&text_events(text, reason), false),
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
        stream_direct_ai(
            "google",
            request("google-final-flush-cancel"),
            &store,
            &secrets,
            &registry,
            &sink,
        )
        .await
        .unwrap();
        let events = sink.sink.snapshot();
        assert_well_formed(&events, "google-final-flush-cancel");
        assert!(matches!(
            terminals(&events)[0],
            AiExecutionResult::Cancelled(_)
        ));
        assert_eq!(text_delta(&events), text);
        assert_eq!(registry.len(), 0);
        assert!(server.observed.await.unwrap().transport.client_disconnected);
    }
}

#[tokio::test]
async fn google_cancellation_drops_headers_idle_body_and_stop_waiting_for_eof() {
    for (delay_headers, stop) in [(true, false), (false, false), (false, true)] {
        let mut upstream = text_events("部分正文", "STOP");
        if !stop {
            upstream.truncate(1);
        }
        let server = google_server(Wire {
            bytes: wire_events(&upstream, false),
            hold_open: true,
            delay_headers,
            ..Wire::default()
        })
        .await;
        let (store, secrets) = saved_store(&profile(&server.base_url));
        let registry = RequestRegistry::default();
        let sink = CollectingSink::default();
        let future = stream_direct_ai(
            "google",
            request("google-running-cancel"),
            &store,
            &secrets,
            &registry,
            &sink,
        );
        tokio::pin!(future);
        tokio::select! {
            result=&mut future=>panic!("must wait for EOF or cancellation: {result:?}"),
            _=async {
                server.request_received.await.unwrap();
                if !delay_headers { tokio::time::timeout(Duration::from_secs(5),async {
                    while text_delta(&sink.snapshot()).is_empty() { tokio::time::sleep(Duration::from_millis(5)).await; }
                }).await.expect("idle body must still flush text"); }
            }=>{}
        }
        assert!(registry.cancel("google-running-cancel"));
        tokio::time::timeout(Duration::from_secs(5), future)
            .await
            .unwrap()
            .unwrap();
        let events = sink.snapshot();
        assert_well_formed(&events, "google-running-cancel");
        assert!(matches!(
            terminals(&events)[0],
            AiExecutionResult::Cancelled(_)
        ));
        assert_eq!(registry.len(), 0);
        assert_eq!(
            text_delta(&events),
            if delay_headers { "" } else { "部分正文" }
        );
        let observed = server.observed.await.unwrap();
        assert!(observed.transport.client_disconnected);
        assert_eq!(observed.transport.request_count, 1);
    }
}

struct ClosedSink;
impl EventSink for ClosedSink {
    fn send(&self, event: AiStreamEvent) -> Result<(), ()> {
        if matches!(event, AiStreamEvent::TextDelta { .. }) {
            Err(())
        } else {
            Ok(())
        }
    }
}

#[tokio::test]
async fn google_closed_channel_aborts_the_upstream_and_clears_registration() {
    let server = google_server(Wire {
        bytes: wire_events(&text_events("partial", "STOP")[..1], false),
        hold_open: true,
        ..Wire::default()
    })
    .await;
    let (store, secrets) = saved_store(&profile(&server.base_url));
    let registry = RequestRegistry::default();
    tokio::time::timeout(
        Duration::from_secs(5),
        stream_direct_ai(
            "google",
            request("google-channel-close"),
            &store,
            &secrets,
            &registry,
            &ClosedSink,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(registry.len(), 0);
    assert!(server.observed.await.unwrap().transport.client_disconnected);
}

#[tokio::test]
async fn google_content_and_shared_result_limits_preserve_prior_text_without_widening_ordinary_tasks(
) {
    for (size, arena, success) in [
        (999_000, false, true),
        (1_000_000, false, false),
        (crate::ai::ARENA_OUTPUT_CONTENT_BYTES, true, true),
        (crate::ai::ARENA_OUTPUT_CONTENT_BYTES + 1, true, false),
    ] {
        let mut upstream = text_events("x", "STOP")[..1].to_vec();
        upstream.extend(text_events(&"x".repeat(size - 1), "STOP"));
        let req = if arena {
            arena_request("google-arena-limit")
        } else {
            request("google-normal-limit")
        };
        let (events, _) = execute(
            Wire {
                bytes: wire_events(&upstream, false),
                ..Wire::default()
            },
            req,
        )
        .await;
        if success {
            assert!(matches!(
                terminals(&events)[0],
                AiExecutionResult::Completed(_)
            ));
            assert_eq!(text_delta(&events).len(), size);
        } else {
            assert_failure(&events, "output-too-large");
            assert_eq!(text_delta(&events).len(), if arena { 1 } else { size });
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
            bytes: wire_events(&text_events(&text, "STOP"), false),
            ..Wire::default()
        },
        request("google-unicode-limit"),
    )
    .await;
    assert_eq!(text_delta(&events), text);
    assert!(events.iter().all(|event| match event {
        AiStreamEvent::TextDelta { delta, .. } =>
            delta.encode_utf16().count() <= crate::ai::AI_STREAM_MAX_DELTA_UTF16_UNITS,
        _ => true,
    }));
}

#[tokio::test]
async fn google_signatures_are_bounded_and_repeated_metadata_is_not_mistaken_for_retained_state() {
    for overflow in [false, true] {
        let mut upstream = text_events("保留正文", "STOP")[..1].to_vec();
        for _ in 0..32 {
            upstream.push(json!({"candidates":[{"content":{"parts":[{"thoughtSignature":"synthetic-opaque".repeat(8192)}]}}]}));
        }
        // Exactly four MiB of signatures across complete frames.
        let consumed = 32 * "synthetic-opaque".len() * 8192;
        upstream.push(json!({"candidates":[{"content":{"parts":[{"thoughtSignature":"s".repeat(4*1024*1024-consumed+usize::from(overflow))}]}}]}));
        for _ in 0..100 {
            upstream.push(json!({"modelVersion":"m".repeat(1024),"usageMetadata":{},"candidates":[{"index":5,"content":{"parts":[{"text":"not-selected"}]}}]}));
        }
        upstream.extend(text_events("", "STOP")[1..].iter().cloned());
        let (events, _) = execute(
            Wire {
                bytes: wire_events(&upstream, false),
                ..Wire::default()
            },
            request("google-opaque"),
        )
        .await;
        if overflow {
            assert_failure(&events, "output-too-large");
        } else {
            assert!(matches!(
                terminals(&events)[0],
                AiExecutionResult::Completed(_)
            ));
        }
        assert_eq!(text_delta(&events), "保留正文");
        assert!(reasoning_delta(&events).is_empty());
        assert!(!serde_json::to_string(&events)
            .unwrap()
            .contains("synthetic-opaque"));
    }
}

#[tokio::test]
async fn google_unselected_candidates_unknown_metadata_and_comments_still_count_toward_wire_limit()
{
    for payload in [
        format!(": {}\n\n", "x".repeat(16 * 1024)),
        format!(
            "data: {}\n\n",
            json!({"futureMetadata":"x".repeat(16*1024)})
        ),
        format!(
            "data: {}\n\n",
            json!({"candidates":[{"index":7,"content":{"parts":[{"text":"x".repeat(16*1024)}]}}]})
        ),
    ] {
        let mut bytes = wire_events(&text_events("保留正文", "STOP")[..1], false);
        while bytes.len() <= crate::ai::ARENA_MAX_WIRE_BYTES {
            bytes.extend_from_slice(payload.as_bytes());
        }
        let (events, _) = execute(
            Wire {
                bytes,
                hold_open: true,
                ..Wire::default()
            },
            request("google-wire-limit"),
        )
        .await;
        assert_failure(&events, "output-too-large");
        assert_eq!(text_delta(&events), "保留正文");
    }
}
