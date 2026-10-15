use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const STREAM_PATH: &str = "/api/tavern/convert-stream";
const COMPLETION_HEADER: &str = "x-mahoshojo-tavern-completion";
const PRE_DISPATCH_CODES: [&str; 5] = [
    "invalid-request",
    "protocol-mismatch",
    "server-unavailable",
    "storage-unavailable",
    "cancelled-before-dispatch",
];

#[derive(Clone)]
struct StreamReply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    // Hold either before headers or after an intentionally incomplete response body.
    hold: Option<bool>,
    fragment_width: Option<usize>,
}

impl StreamReply {
    fn json(body: serde_json::Value) -> Self {
        Self {
            status: 200,
            headers: vec![("content-type".into(), "application/json".into())],
            body: body.to_string().into_bytes(),
            hold: None,
            fragment_width: None,
        }
    }
    fn readiness() -> Self {
        Self::json(serde_json::json!({"ok":true,"contractVersion":HOSTED_CONTRACT_VERSION}))
    }
    fn capability() -> Self {
        let mut reply = Self::json(serde_json::json!({"protocol":"tavern-completion","version":1}));
        reply.headers.push((COMPLETION_HEADER.into(), "v1".into()));
        reply
    }
    fn stream(body: impl Into<Vec<u8>>) -> Self {
        Self {
            status: 200,
            headers: vec![
                (
                    "content-type".into(),
                    "text/event-stream; charset=utf-8".into(),
                ),
                (COMPLETION_HEADER.into(), "v1".into()),
            ],
            body: body.into(),
            hold: None,
            fragment_width: None,
        }
    }
    fn error(status: u16, body: serde_json::Value) -> Self {
        let mut reply = Self::json(body);
        reply.status = status;
        reply.headers.push((COMPLETION_HEADER.into(), "v1".into()));
        reply
    }
    fn version(mut self, version: Option<&str>) -> Self {
        self.headers.retain(|(name, _)| name != COMPLETION_HEADER);
        if let Some(version) = version {
            self.headers
                .push((COMPLETION_HEADER.into(), version.into()));
        }
        self
    }
}

#[derive(Clone, serde::Serialize)]
struct StreamObserved {
    method: String,
    path: String,
    headers: String,
    body: Option<serde_json::Value>,
}

struct StreamServer {
    origin: String,
    requests: Arc<Mutex<Vec<StreamObserved>>>,
    changed: Arc<tokio::sync::Notify>,
    disconnected: Arc<AtomicUsize>,
    shutdown: CancellationToken,
}

impl Drop for StreamServer {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

impl StreamServer {
    async fn start(replies: Vec<StreamReply>) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let changed = Arc::new(tokio::sync::Notify::new());
        let disconnected = Arc::new(AtomicUsize::new(0));
        let shutdown = CancellationToken::new();
        let owner = (
            requests.clone(),
            changed.clone(),
            disconnected.clone(),
            shutdown.clone(),
        );
        let replies = Arc::new(Mutex::new(VecDeque::from(replies)));
        tokio::spawn(async move {
            let (requests, changed, disconnected, shutdown) = owner;
            loop {
                let accepted = tokio::select! { biased; _ = shutdown.cancelled() => break, accepted = listener.accept() => accepted };
                let Ok((mut socket, _)) = accepted else { break };
                let (requests, changed, disconnected, shutdown, replies) = (
                    requests.clone(),
                    changed.clone(),
                    disconnected.clone(),
                    shutdown.clone(),
                    replies.clone(),
                );
                tokio::spawn(async move {
                    let operation = async {
                        let mut bytes = Vec::new();
                        let mut chunk = [0u8; 4096];
                        let head_end = loop {
                            let count = socket.read(&mut chunk).await.ok()?;
                            if count == 0
                                || bytes.len() + count > HOSTED_BODY_TAVERN_MAX_BYTES + 64 * 1024
                            {
                                return None;
                            }
                            bytes.extend_from_slice(&chunk[..count]);
                            if let Some(index) = find_subslice(&bytes, b"\r\n\r\n") {
                                break index;
                            }
                        };
                        let headers = String::from_utf8(bytes[..head_end].to_vec()).ok()?;
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|value| value.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if length > HOSTED_BODY_TAVERN_MAX_BYTES + 64 * 1024 {
                            return None;
                        }
                        while bytes.len() < head_end + 4 + length {
                            let count = socket.read(&mut chunk).await.ok()?;
                            if count == 0 {
                                return None;
                            }
                            bytes.extend_from_slice(&chunk[..count]);
                        }
                        let mut parts = headers.lines().next()?.split_whitespace();
                        let observed = StreamObserved {
                            method: parts.next()?.into(),
                            path: parts.next()?.into(),
                            headers: headers.clone(),
                            body: serde_json::from_slice(
                                &bytes[head_end + 4..head_end + 4 + length],
                            )
                            .ok(),
                        };
                        requests.lock().unwrap().push(observed);
                        changed.notify_waiters();
                        let reply = replies.lock().unwrap().pop_front().unwrap_or_else(|| {
                            StreamReply::error(
                                500,
                                serde_json::json!({"error":"unexpected retry or redirect"}),
                            )
                        });
                        if reply.hold != Some(false) {
                            let length = reply.body.len() + usize::from(reply.hold == Some(true));
                            let mut head = format!("HTTP/1.1 {} Test\r\nContent-Length: {length}\r\nConnection: close\r\n", reply.status);
                            for (name, value) in &reply.headers {
                                head.push_str(&format!("{name}: {value}\r\n"));
                            }
                            head.push_str("\r\n");
                            let written = if let Some(width) = reply.fragment_width {
                                // Force byte boundaries through multi-byte UTF-8 and CRLF delimiters.
                                let _ = socket.set_nodelay(true);
                                let mut result = socket.write_all(head.as_bytes()).await;
                                for chunk in reply.body.chunks(width) {
                                    if result.is_err() {
                                        break;
                                    }
                                    result = socket.write_all(chunk).await;
                                    tokio::time::sleep(Duration::from_millis(1)).await;
                                }
                                result
                            } else {
                                // One write exercises legal prefix plus invalid suffix together.
                                let mut wire = head.into_bytes();
                                wire.extend_from_slice(&reply.body);
                                socket.write_all(&wire).await
                            };
                            if written.is_err() {
                                if reply.hold.is_some() {
                                    disconnected.fetch_add(1, Ordering::SeqCst);
                                    changed.notify_waiters();
                                }
                                return None;
                            }
                        }
                        if reply.hold.is_some() {
                            match socket.read(&mut chunk).await {
                                Ok(0) | Err(_) => {
                                    disconnected.fetch_add(1, Ordering::SeqCst);
                                    changed.notify_waiters();
                                }
                                Ok(_) => {}
                            }
                        } else {
                            let _ = socket.shutdown().await;
                        }
                        Some(())
                    };
                    tokio::select! { _ = shutdown.cancelled() => {}, _ = tokio::time::timeout(Duration::from_secs(5), operation) => {} }
                });
            }
        });
        Self {
            origin,
            requests,
            changed,
            disconnected,
            shutdown,
        }
    }
    async fn wait_requests(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let changed = self.changed.notified();
                if self.requests.lock().unwrap().len() >= count {
                    break;
                }
                changed.await;
            }
        })
        .await
        .expect("HTTP stage reached");
    }
    async fn wait_disconnected(&self) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let changed = self.changed.notified();
                if self.disconnected.load(Ordering::SeqCst) > 0 {
                    break;
                }
                changed.await;
            }
        })
        .await
        .expect("upstream socket dropped");
    }
    fn observed(&self) -> Vec<StreamObserved> {
        self.requests.lock().unwrap().clone()
    }
}

fn stream_request() -> CloudHostedGenerateRequest {
    serde_json::from_value(serde_json::json!({"requestId":"tavern-stream-test","routeId":HOSTED_ROUTE_TAVERN_STREAM,"body":{"template":"general","language":"zh-CN","sourceName":"Alice","attachments":[]}})).unwrap()
}
fn frame(event: &str, data: serde_json::Value) -> String {
    format!("event: {event}\ndata: {data}\n\n")
}
fn markdown(text: &str) -> String {
    frame("markdown", serde_json::json!({"chunk":text}))
}
fn done() -> String {
    frame(
        "done",
        serde_json::json!({"ok":true,"tavernCompletion":{"version":1,"finishReason":"stop"}}),
    )
}
fn event_values(sink: &VecSink) -> Vec<serde_json::Value> {
    sink.events
        .lock()
        .unwrap()
        .iter()
        .map(|event| serde_json::to_value(event).unwrap())
        .collect()
}
fn assert_possible_error(events: &[serde_json::Value]) {
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event["event"].as_str(), Some("done" | "error")))
            .count(),
        1,
        "exactly one terminal: {events:?}"
    );
    let last = events.last().unwrap();
    assert_eq!(last["event"], "error");
    assert_eq!(last["data"]["ok"], false);
    assert!(last["data"]["error"].is_string());
    assert!(
        !PRE_DISPATCH_CODES.contains(&last["data"]["code"].as_str().unwrap()),
        "upstream cannot forge pre-dispatch evidence"
    );
    assert!(last["data"]
        .as_object()
        .unwrap()
        .keys()
        .all(|key| matches!(key.as_str(), "ok" | "error" | "code" | "retryAfterSeconds")));
}
async fn run_stream(
    reply: StreamReply,
    preset: bool,
) -> (Vec<serde_json::Value>, Vec<StreamObserved>) {
    let server = StreamServer::start(vec![
        StreamReply::readiness(),
        StreamReply::capability(),
        reply,
    ])
    .await;
    let state = CloudState::with_origin(&server.origin);
    let secrets = MemorySecrets::new();
    let registry = crate::ai::RequestRegistry::default();
    let sink = VecSink::new();
    let mut request = stream_request();
    if preset {
        secrets
            .set(
                &crate::provider_target::preset_secret_ref("deepseek").unwrap(),
                "fake-tavern-stream-key",
            )
            .unwrap();
        request.preset_config = Some(CloudHostedPresetConfig {
            provider_id: "deepseek".into(),
            model_id: "deepseek-chat".into(),
            generation_overrides: None,
        });
    }
    stream_hosted_ai(&state, &secrets, &registry, request, &sink)
        .await
        .unwrap();
    assert_eq!(registry.len(), 0);
    assert_eq!(
        server.observed().len(),
        3,
        "one compatibility GET, one capability GET, one POST; no retries"
    );
    (event_values(&sink), server.observed())
}

#[test]
fn tavern_stream_rejects_invalid_bodies_before_any_credential_or_http_access() {
    rt().block_on(async {
        let server = StreamServer::start(vec![]).await;
        let state = CloudState::with_origin(&server.origin);
        let secrets = MemorySecrets::new();
        let registry = crate::ai::RequestRegistry::default();
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../../../../packages/contracts/fixtures/desktop-hosted-tavern.json")).unwrap();
        for entry in fixture["invalid"].as_array().unwrap() {
            let mut value = entry["request"].clone();
            value["routeId"] = serde_json::json!(HOSTED_ROUTE_TAVERN_STREAM);
            if let Ok(request) = serde_json::from_value::<CloudHostedGenerateRequest>(value) {
                let sink = VecSink::new();
                assert_eq!(stream_hosted_ai(&state, &secrets, &registry, request, &sink).await.unwrap_err().code, CloudErrorCode::InvalidRequest, "{}", entry["label"]);
                assert!(event_values(&sink).is_empty());
            }
            assert_eq!(registry.len(), 0);
        }
        for attachments in [
            serde_json::json!([{"name":"utf8","content":"中".repeat(1024 * 1024 / 3 + 1)}]),
            serde_json::json!([{"name":"a","content":"a".repeat(512 * 1024)},{"name":"b","content":"b".repeat(512 * 1024 + 1)}]),
            serde_json::json!((0..11).map(|_| serde_json::json!({"name":"a","content":""})).collect::<Vec<_>>()),
        ] {
            let mut request = stream_request(); request.body["attachments"] = attachments;
            let sink = VecSink::new();
            assert_eq!(stream_hosted_ai(&state, &secrets, &registry, request, &sink).await.unwrap_err().code, CloudErrorCode::InvalidRequest);
            assert!(event_values(&sink).is_empty());
        }
        for entry in fixture["valid"].as_array().unwrap() {
            let mut value = entry["request"].clone(); value["routeId"] = serde_json::json!(HOSTED_ROUTE_TAVERN_STREAM);
            build_hosted_request_body(&serde_json::from_value(value).unwrap()).unwrap_or_else(|error| panic!("{}: {error:?}", entry["label"]));
        }
        assert_eq!(secrets.resolves.load(Ordering::SeqCst), 0);
        assert!(server.observed().is_empty());
        assert_eq!(registry.len(), 0);
    });
}

#[test]
fn tavern_stream_has_the_same_native_injected_eight_mib_request_budget() {
    rt().block_on(async {
        assert_eq!(
            hosted_body_max_bytes(HOSTED_ROUTE_TAVERN_STREAM),
            8 * 1024 * 1024
        );
        let server = StreamServer::start(vec![]).await;
        let state = CloudState::with_origin(&server.origin);
        let secrets = MemorySecrets::new();
        secrets
            .set(
                &crate::provider_target::preset_secret_ref("deepseek").unwrap(),
                &"k".repeat(3 * 1024 * 1024),
            )
            .unwrap();
        let registry = crate::ai::RequestRegistry::default();
        let mut request = stream_request();
        request.body["attachments"] =
            serde_json::json!([{"name":"escaped","content":"\0".repeat(1024 * 1024)}]);
        assert!(
            serde_json::to_vec(&build_hosted_request_body(&request).unwrap())
                .unwrap()
                .len()
                > 256 * 1024
        );
        request.preset_config = Some(CloudHostedPresetConfig {
            provider_id: "deepseek".into(),
            model_id: "deepseek-chat".into(),
            generation_overrides: None,
        });
        let sink = VecSink::new();
        assert_eq!(
            stream_hosted_ai(&state, &secrets, &registry, request, &sink)
                .await
                .unwrap_err()
                .code,
            CloudErrorCode::InvalidRequest
        );
        assert!(event_values(&sink).is_empty());
        assert_eq!(
            secrets.resolves.load(Ordering::SeqCst),
            1,
            "only preset key; no session access"
        );
        assert!(server.observed().is_empty());
        assert_eq!(registry.len(), 0);
    });
}

#[test]
fn tavern_stream_all_templates_use_the_fixed_two_get_then_post_handshake() {
    rt().block_on(async {
        for (index, template) in [
            "general",
            "general-scenario",
            "scenario",
            "magical-girl",
            "canshou",
        ]
        .into_iter()
        .enumerate()
        {
            let server = StreamServer::start(vec![
                StreamReply::readiness(),
                StreamReply::capability(),
                StreamReply::stream(markdown("正文") + &done()),
            ])
            .await;
            let state = CloudState::with_origin(&server.origin);
            let secrets = MemorySecrets::new();
            secrets
                .set(
                    &crate::provider_target::preset_secret_ref("deepseek").unwrap(),
                    "fake-tavern-stream-key",
                )
                .unwrap();
            let registry = crate::ai::RequestRegistry::default();
            let sink = VecSink::new();
            let mut request = stream_request();
            request.body["template"] = serde_json::json!(template);
            if index % 2 == 0 {
                request.system_config = Some(CloudHostedSystemConfig {
                    model_id: Some("test-model".into()),
                    generation_overrides: None,
                });
            } else {
                request.preset_config = Some(CloudHostedPresetConfig {
                    provider_id: "deepseek".into(),
                    model_id: "deepseek-chat".into(),
                    generation_overrides: None,
                });
            }
            stream_hosted_ai(&state, &secrets, &registry, request, &sink)
                .await
                .unwrap();
            let observed = server.observed();
            assert_eq!(observed.len(), 3);
            assert_eq!(
                (observed[0].method.as_str(), observed[0].path.as_str()),
                ("GET", DR_READINESS_PATH)
            );
            assert_eq!(
                (observed[1].method.as_str(), observed[1].path.as_str()),
                ("GET", STREAM_PATH)
            );
            assert!(
                observed[1].body.is_none(),
                "capability probe cannot contain a model request"
            );
            assert_eq!(
                (observed[2].method.as_str(), observed[2].path.as_str()),
                ("POST", "/api/tavern/convert-stream?format=sse")
            );
            for request in &observed[1..] {
                assert!(request
                    .headers
                    .to_ascii_lowercase()
                    .contains(&format!("{COMPLETION_HEADER}: v1")));
                assert!(!request.headers.contains("fake-tavern-stream-key"));
            }
            assert!(observed[2]
                .headers
                .to_ascii_lowercase()
                .contains("accept: text/event-stream"));
            let body = observed[2].body.as_ref().unwrap();
            assert_eq!(body["template"], template);
            assert!(body.get("raw").is_none());
            assert_eq!(
                body["customProvider"]["providerId"],
                if index % 2 == 0 { "system" } else { "deepseek" }
            );
            assert_eq!(event_values(&sink).last().unwrap()["event"], "done");
            assert_eq!(registry.len(), 0);
        }
    });
}

#[test]
fn tavern_stream_probe_failures_never_post_or_emit() {
    rt().block_on(async {
        let mut invalid = vec![
            StreamReply::capability().version(None),
            StreamReply::capability().version(Some("v2")),
            StreamReply::capability().version(Some("v1, v2")),
        ];
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/contracts/fixtures/desktop-hosted-tavern-stream.json"
        ))
        .unwrap();
        for body in fixture["capability"]["invalidPayloads"].as_array().unwrap() {
            let mut reply = StreamReply::capability();
            reply.body = body.to_string().into_bytes();
            invalid.push(reply);
        }
        let mut bad_json = StreamReply::capability();
        bad_json.body = b"{bad".to_vec();
        invalid.push(bad_json);
        let mut oversized = StreamReply::capability();
        oversized.body.extend(vec![b' '; 64 * 1024 + 1]);
        invalid.push(oversized);
        for status in [302, 404, 405, 429, 500] {
            let mut reply = StreamReply::capability();
            reply.status = status;
            reply.headers.push(("location".into(), STREAM_PATH.into()));
            invalid.push(reply);
        }
        for reply in invalid {
            let expected = if (200..300).contains(&reply.status) {
                CloudErrorCode::ProtocolMismatch
            } else {
                CloudErrorCode::ServerUnavailable
            };
            let server = StreamServer::start(vec![StreamReply::readiness(), reply]).await;
            let state = CloudState::with_origin(&server.origin);
            let registry = crate::ai::RequestRegistry::default();
            let sink = VecSink::new();
            let error = stream_hosted_ai(
                &state,
                &MemorySecrets::new(),
                &registry,
                stream_request(),
                &sink,
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, expected);
            assert!(event_values(&sink).is_empty());
            assert_eq!(registry.len(), 0);
            assert_eq!(
                server.observed().len(),
                2,
                "failed/redirected probe cannot trigger POST or retry"
            );
        }
        let server = StreamServer::start(vec![StreamReply::json(
            serde_json::json!({"ok":true,"contractVersion":"unsupported"}),
        )])
        .await;
        let state = CloudState::with_origin(&server.origin);
        let registry = crate::ai::RequestRegistry::default();
        let sink = VecSink::new();
        assert_eq!(
            stream_hosted_ai(
                &state,
                &MemorySecrets::new(),
                &registry,
                stream_request(),
                &sink
            )
            .await
            .unwrap_err()
            .code,
            CloudErrorCode::ProtocolMismatch
        );
        assert_eq!(server.observed().len(), 1);
        assert!(event_values(&sink).is_empty());
        assert_eq!(registry.len(), 0);
    });
}

#[test]
fn tavern_stream_post_requires_exact_version_on_every_status_and_never_redirects() {
    rt().block_on(async {
        for (status, version) in [
            (200, None),
            (429, Some("v2")),
            (500, Some("v1, v2")),
            (302, Some("v1")),
        ] {
            let mut reply = StreamReply::stream(done()).version(version);
            reply.status = status;
            reply.headers.push(("location".into(), STREAM_PATH.into()));
            let (events, _) = run_stream(reply, false).await;
            assert_possible_error(&events);
        }
        for content_type in [
            "application/json",
            "text/plain",
            "application/x-text/event-stream-invalid",
        ] {
            let mut reply = StreamReply::stream(done());
            reply.headers[0].1 = content_type.into();
            let (events, _) = run_stream(reply, false).await;
            assert_possible_error(&events);
        }
    });
}

#[test]
fn tavern_stream_strict_frames_preserve_a_valid_prefix_before_failure() {
    rt().block_on(async {
        let mut invalid = vec![
            frame("markdown", serde_json::json!({"chunk":7})), frame("markdown", serde_json::json!({"chunk":"text","extra":true})),
            frame("done", serde_json::json!({"ok":true})), frame("done", serde_json::json!({"ok":true,"tavernCompletion":{"version":1,"finishReason":"stop","extra":true}})),
            frame("done", serde_json::json!({"ok":true,"tavernCompletion":{"version":1,"finishReason":"stop"},"extra":true})),
            frame("done", serde_json::json!({"ok":true,"tavernCompletion":{"version":1,"finishReason":"unsupported"}})),
            "event: markdown\ndata: {bad}\n\n".into(),
            done().trim_end_matches('\n').into(),
            "event: markdown\ndata: {\"chunk\":\"unfinished\"}".into(),
            String::new(),
        ];
        invalid.push(markdown(&"x".repeat(512 * 1024)));
        invalid.push(format!(":{}", "x".repeat(1024 * 1024 + 1)));
        for suffix in invalid {
            let (events, _) = run_stream(StreamReply::stream(markdown("kept") + &suffix), false).await;
            assert_eq!(events[0], serde_json::json!({"event":"markdown","data":{"chunk":"kept"}}));
            assert_possible_error(&events); assert_eq!(events.last().unwrap()["data"]["code"], "invalid-response");
        }
        for tail in [vec![0xff], vec![0xe4, 0xb8]] {
            let mut bytes = markdown("kept").into_bytes(); bytes.extend_from_slice(&tail);
            let (events, _) = run_stream(StreamReply::stream(bytes), false).await;
            assert_eq!(events[0]["data"]["chunk"], "kept"); assert_possible_error(&events);
        }
    });
}

#[test]
fn tavern_stream_first_terminal_ignores_later_garbage_and_drops_a_live_body() {
    rt().block_on(async {
        for terminal in [
            done(),
            frame(
                "error",
                serde_json::json!({"ok":false,"error":"failed","code":"upstream-error"}),
            ),
        ] {
            let mut bytes =
                (markdown("kept") + &terminal + "event: done\ndata: {bad}\n\n").into_bytes();
            bytes.push(0xff);
            let mut reply = StreamReply::stream(bytes);
            reply.hold = Some(true);
            let server = StreamServer::start(vec![
                StreamReply::readiness(),
                StreamReply::capability(),
                reply,
            ])
            .await;
            let state = CloudState::with_origin(&server.origin);
            let registry = crate::ai::RequestRegistry::default();
            let sink = VecSink::new();
            tokio::time::timeout(
                Duration::from_secs(1),
                stream_hosted_ai(
                    &state,
                    &MemorySecrets::new(),
                    &registry,
                    stream_request(),
                    &sink,
                ),
            )
            .await
            .expect("terminal must not wait for EOF")
            .unwrap();
            let events = event_values(&sink);
            assert_eq!(events.len(), 2);
            assert_eq!(events[0]["data"]["chunk"], "kept");
            assert_eq!(
                events[1]["event"],
                if terminal.starts_with("event: done") {
                    "done"
                } else {
                    "error"
                }
            );
            assert_eq!(registry.len(), 0);
            server.wait_disconnected().await;
        }
    });
}

#[test]
fn tavern_stream_reasoning_telemetry_unknown_events_do_not_become_markdown() {
    rt().block_on(async {
        let body = frame(
            "reasoning",
            serde_json::json!({"source":"sdk","status":"thinking","chunk":"private reasoning"}),
        ) + &frame(
            "reasoning_done",
            serde_json::json!({"source":"sdk","status":"done"}),
        ) + "event: future_extension\ndata: not-json\n\n"
            + &frame(
                "telemetry",
                serde_json::json!({"version":1,"aiModel":"test"}),
            )
            + &markdown("正文")
            + &done();
        let (events, _) = run_stream(StreamReply::stream(body), false).await;
        let body: String = events
            .iter()
            .filter(|event| event["event"] == "markdown")
            .map(|event| event["data"]["chunk"].as_str().unwrap())
            .collect();
        assert_eq!(body, "正文");
        assert!(events
            .iter()
            .all(|event| event["event"] != "future_extension"));
        assert_eq!(events.last().unwrap()["event"], "done");
    });
}

#[test]
fn tavern_stream_error_codes_cannot_claim_no_dispatch_and_byok_never_echoes_upstream() {
    rt().block_on(async {
        for code in PRE_DISPATCH_CODES {
            let (events, _) = run_stream(StreamReply::stream(frame("error", serde_json::json!({"ok":false,"error":"upstream detail","code":code}))), false).await;
            assert_possible_error(&events);
        }
        for reply in [
            StreamReply::error(500, serde_json::json!({"error":"fake-tavern-stream-key provider diagnostics"})),
            StreamReply::stream(frame("error", serde_json::json!({"ok":false,"error":"fake-tavern-stream-key provider diagnostics","code":"upstream-error"}))),
        ] {
            let (events, _) = run_stream(reply, true).await; assert_possible_error(&events);
            let output = serde_json::to_string(&events).unwrap(); assert!(!output.contains("fake-tavern-stream-key")); assert!(!output.contains("provider diagnostics"));
        }
    });
}

#[test]
fn tavern_stream_429_retry_hints_are_positive_u32_with_body_precedence() {
    rt().block_on(async {
        let cases = [
            (
                serde_json::json!({"retryAfterSeconds":7,"retryAfter":9}),
                "11",
                Some(7),
            ),
            (
                serde_json::json!({"retryAfterSeconds":null,"retryAfter":9}),
                "11",
                Some(9),
            ),
            (
                serde_json::json!({"retryAfterSeconds":0,"retryAfter":9}),
                "11",
                Some(11),
            ),
            (serde_json::json!({"retryAfterSeconds":1.5}), "11", Some(11)),
            (serde_json::json!({"retryAfterSeconds":"7"}), "11", Some(7)),
            (
                serde_json::json!({"retryAfterSeconds":4294967296u64}),
                "11",
                Some(11),
            ),
            (serde_json::json!({}), "0007", Some(7)),
            (serde_json::json!({}), "0", None),
            (serde_json::json!({}), "1.5", None),
            (serde_json::json!({}), "7junk", None),
            (serde_json::json!({}), "+7", None),
            (serde_json::json!({}), "Wed, 21 Oct 2015 07:28:00 GMT", None),
            (serde_json::json!({}), "4294967296", None),
        ];
        for (mut body, header, expected) in cases {
            body["error"] = serde_json::json!("rate limited");
            let mut reply = StreamReply::error(429, body);
            reply.headers.push(("retry-after".into(), header.into()));
            let (events, _) = run_stream(reply, false).await;
            assert_possible_error(&events);
            assert_eq!(
                events.last().unwrap()["data"]
                    .get("retryAfterSeconds")
                    .and_then(serde_json::Value::as_u64),
                expected.map(|value| value as u64),
                "{header}"
            );
        }
        let mut reply = StreamReply::error(
            429,
            serde_json::json!({"error":"provider private","retryAfterSeconds":7}),
        );
        reply.headers.push(("retry-after".into(), "11".into()));
        let (events, _) = run_stream(reply, true).await;
        assert_eq!(events.last().unwrap()["data"]["retryAfterSeconds"], 11);
        assert!(!serde_json::to_string(&events)
            .unwrap()
            .contains("provider private"));
        let mut reply = StreamReply::error(
            429,
            serde_json::json!({"error":"x".repeat(64 * 1024 + 1),"retryAfterSeconds":7}),
        );
        reply.headers.push(("retry-after".into(), "11".into()));
        let (events, _) = run_stream(reply, false).await;
        assert_possible_error(&events);
        assert_eq!(events.last().unwrap()["data"]["retryAfterSeconds"], 11);
        assert!(serde_json::to_string(&events).unwrap().len() < 64 * 1024);
    });
}

#[test]
fn tavern_stream_cancellation_distinguishes_before_and_after_dispatch_and_closes_socket() {
    rt().block_on(async {
        for (stage, after_headers) in [(0, false), (1, false), (2, false), (2, true)] {
            let mut replies = vec![StreamReply::readiness(), StreamReply::capability(), StreamReply::stream(markdown("partial"))];
            replies[stage].hold = Some(after_headers);
            let server = StreamServer::start(replies).await;
            let state = CloudState::with_origin(&server.origin); let secrets = MemorySecrets::new(); let registry = crate::ai::RequestRegistry::default(); let sink = VecSink::new();
            let operation = stream_hosted_ai(&state, &secrets, &registry, stream_request(), &sink); tokio::pin!(operation);
            tokio::select! { result = &mut operation => panic!("request must remain pending: {result:?}"), _ = server.wait_requests(stage + 1) => {} }
            assert!(registry.cancel("tavern-stream-test"));
            let result = tokio::time::timeout(Duration::from_millis(500), &mut operation).await.expect("cancellation promptly drops in-flight request");
            if stage < 2 { assert_eq!(result.unwrap_err().code, CloudErrorCode::CancelledBeforeDispatch); assert!(event_values(&sink).is_empty()); }
            else { result.unwrap(); let events = event_values(&sink); assert_possible_error(&events); assert_eq!(events.last().unwrap()["data"]["code"], "cancelled"); }
            assert_eq!(registry.len(), 0); server.wait_disconnected().await; assert_eq!(server.observed().len(), stage + 1);
        }
    });
}

#[test]
fn tavern_stream_failed_channel_rejects_and_releases_registry_and_socket() {
    struct ClosedChannel;
    impl HostedEventSink for ClosedChannel {
        fn send(&self, _: HostedSseEvent) -> Result<(), ()> {
            Err(())
        }
    }
    rt().block_on(async {
        for body in [
            markdown("partial"),
            done(),
            frame(
                "error",
                serde_json::json!({"ok":false,"error":"failed","code":"upstream-error"}),
            ),
        ] {
            let mut reply = StreamReply::stream(body);
            reply.hold = Some(true);
            let server = StreamServer::start(vec![
                StreamReply::readiness(),
                StreamReply::capability(),
                reply,
            ])
            .await;
            let state = CloudState::with_origin(&server.origin);
            let registry = crate::ai::RequestRegistry::default();
            let error = tokio::time::timeout(
                Duration::from_secs(1),
                stream_hosted_ai(
                    &state,
                    &MemorySecrets::new(),
                    &registry,
                    stream_request(),
                    &ClosedChannel,
                ),
            )
            .await
            .expect("closed Channel must stop reading")
            .unwrap_err();
            assert_eq!(error.code, CloudErrorCode::InvalidResponse);
            assert_eq!(registry.len(), 0);
            server.wait_disconnected().await;
        }
    });
}

#[test]
fn tavern_stream_shared_fixture_completion_and_markdown_match_native() {
    rt().block_on(async {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/contracts/fixtures/desktop-hosted-tavern-stream.json"
        ))
        .unwrap();
        assert_eq!(fixture["routeId"], HOSTED_ROUTE_TAVERN_STREAM);
        assert_eq!(
            fixture["bodyMaxBytes"],
            hosted_body_max_bytes(HOSTED_ROUTE_TAVERN_STREAM)
        );
        assert_eq!(fixture["path"], format!("{STREAM_PATH}?format=sse"));
        for data in fixture["validDone"].as_array().unwrap() {
            let (events, _) =
                run_stream(StreamReply::stream(frame("done", data.clone())), false).await;
            assert_eq!(
                events,
                vec![serde_json::json!({"event":"done","data":data})]
            );
        }
        for data in fixture["validMarkdown"].as_array().unwrap() {
            let (events, _) = run_stream(
                StreamReply::stream(frame("markdown", data.clone()) + &done()),
                false,
            )
            .await;
            assert_eq!(
                events[0],
                serde_json::json!({"event":"markdown","data":data})
            );
        }
        for (key, event) in [("invalidDone", "done"), ("invalidMarkdown", "markdown")] {
            for data in fixture[key].as_array().unwrap() {
                let (events, _) =
                    run_stream(StreamReply::stream(frame(event, data.clone())), false).await;
                assert_possible_error(&events);
                assert_eq!(
                    events.last().unwrap()["data"]["code"],
                    "invalid-response",
                    "{key}: {data}"
                );
            }
        }
    });
}

#[test]
fn tavern_stream_storage_failure_and_post_connection_failure_have_distinct_evidence() {
    struct FailedSecrets;
    impl SecretStore for FailedSecrets {
        fn set(&self, _: &str, _: &str) -> Result<(), SecretStoreError> {
            Err(SecretStoreError::failure_for_test())
        }
        fn exists(&self, _: &str) -> Result<bool, SecretStoreError> {
            Err(SecretStoreError::failure_for_test())
        }
        fn delete(&self, _: &str) -> Result<(), SecretStoreError> {
            Err(SecretStoreError::failure_for_test())
        }
        fn resolve(&self, _: &str) -> Result<Option<String>, SecretStoreError> {
            Err(SecretStoreError::failure_for_test())
        }
    }
    rt().block_on(async {
        for preset in [false, true] {
            let server = StreamServer::start(vec![]).await;
            let state = CloudState::with_origin(&server.origin); let registry = crate::ai::RequestRegistry::default(); let sink = VecSink::new();
            let mut request = stream_request();
            if preset { request.preset_config = Some(CloudHostedPresetConfig { provider_id: "deepseek".into(), model_id: "deepseek-chat".into(), generation_overrides: None }); }
            let error = stream_hosted_ai(&state, &FailedSecrets, &registry, request, &sink).await.unwrap_err();
            assert_eq!(error.code, CloudErrorCode::StorageUnavailable); assert!(event_values(&sink).is_empty()); assert!(server.observed().is_empty()); assert_eq!(registry.len(), 0);
        }
        let mut reply = StreamReply::stream(done()); reply.hold = Some(false);
        let server = StreamServer::start(vec![StreamReply::readiness(), StreamReply::capability(), reply]).await;
        let state = CloudState::with_origin(&server.origin); let secrets = MemorySecrets::new(); let registry = crate::ai::RequestRegistry::default(); let sink = VecSink::new();
        let operation = stream_hosted_ai(&state, &secrets, &registry, stream_request(), &sink); tokio::pin!(operation);
        tokio::select! { result = &mut operation => panic!("POST should be pending: {result:?}"), _ = server.wait_requests(3) => {} }
        server.shutdown.cancel();
        tokio::time::timeout(Duration::from_secs(1), &mut operation).await.expect("broken POST connection must settle").unwrap();
        let events = event_values(&sink); assert_possible_error(&events); assert_eq!(events.last().unwrap()["data"]["code"], "network-error");
        assert_eq!(registry.len(), 0); assert_eq!(server.observed().len(), 3);
    });
}

#[test]
fn tavern_stream_fragment_boundaries_and_large_legal_streams_preserve_completion() {
    rt().block_on(async {
        let mut reply = StreamReply::stream((markdown("正文🌸") + &done()).replace('\n', "\r\n"));
        reply.fragment_width = Some(1);
        let (events, _) = run_stream(reply, false).await;
        assert_eq!(events, vec![serde_json::json!({"event":"markdown","data":{"chunk":"正文🌸"}}), serde_json::json!({"event":"done","data":{"ok":true,"tavernCompletion":{"version":1,"finishReason":"stop"}}})]);
        let chunk = "x".repeat(384 * 1024);
        let body = markdown(&chunk).repeat(3) + &done();
        assert!(body.len() > 1024 * 1024);
        let (events, _) = run_stream(StreamReply::stream(body), false).await;
        assert_eq!(events.len(), 4);
        assert_eq!(events.last().unwrap()["event"], "done");
        assert_eq!(events.iter().take(3).map(|event| event["data"]["chunk"].as_str().unwrap().len()).sum::<usize>(), 3 * chunk.len());
    });
}

fn h2_test_frame(kind: u8, flags: u8, stream: u32, payload: &[u8]) -> Vec<u8> {
    let length = payload.len();
    let mut frame = vec![
        (length >> 16) as u8,
        (length >> 8) as u8,
        length as u8,
        kind,
        flags,
    ];
    frame.extend_from_slice(&stream.to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

async fn h2_refused_request_count(builder: reqwest::ClientBuilder) -> usize {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(AtomicUsize::new(0));
    let shutdown = CancellationToken::new();
    let guard = shutdown.clone().drop_guard();
    let observed = requests.clone();
    let server = tokio::spawn(async move {
        loop {
            let accepted = tokio::select! { _ = shutdown.cancelled() => break, accepted = listener.accept() => accepted };
            let Ok((mut socket, _)) = accepted else {
                break;
            };
            let shutdown = shutdown.clone();
            let observed = observed.clone();
            tokio::spawn(async move {
                let operation = async {
                    let mut preface = [0u8; 24];
                    socket.read_exact(&mut preface).await.ok()?;
                    assert_eq!(&preface, b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
                    socket.write_all(&h2_test_frame(4, 0, 0, &[])).await.ok()?;
                    loop {
                        let mut header = [0u8; 9];
                        if socket.read_exact(&mut header).await.is_err() {
                            break;
                        }
                        let length = (usize::from(header[0]) << 16)
                            | (usize::from(header[1]) << 8)
                            | usize::from(header[2]);
                        assert!(length <= 64 * 1024, "bounded owned H2 frame");
                        let stream =
                            u32::from_be_bytes(header[5..9].try_into().unwrap()) & 0x7fff_ffff;
                        let mut payload = vec![0u8; length];
                        socket.read_exact(&mut payload).await.ok()?;
                        match header[3] {
                            4 if header[4] & 1 == 0 => {
                                socket.write_all(&h2_test_frame(4, 1, 0, &[])).await.ok()?;
                            }
                            6 if header[4] & 1 == 0 => {
                                socket
                                    .write_all(&h2_test_frame(6, 1, 0, &payload))
                                    .await
                                    .ok()?;
                            }
                            1 => {
                                assert!(stream > 0, "request HEADERS must belong to a stream");
                                observed.fetch_add(1, Ordering::SeqCst);
                                // RST_STREAM / REFUSED_STREAM is reqwest's real retryable protocol NACK.
                                socket
                                    .write_all(&h2_test_frame(3, 0, stream, &7u32.to_be_bytes()))
                                    .await
                                    .ok()?;
                            }
                            _ => {}
                        }
                    }
                    Some(())
                };
                tokio::select! { _ = shutdown.cancelled() => {}, _ = operation => {} }
            });
        }
    });
    // Only the test's cleartext loopback selection differs from the production builder.
    let client = builder.http2_prior_knowledge().build().unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        client
            .post(format!("{origin}{STREAM_PATH}?format=sse"))
            .body("{}")
            .send(),
    )
    .await
    .expect("H2 NACK request must settle");
    assert!(result.is_err(), "server never sends a successful response");
    let count = requests.load(Ordering::SeqCst);
    drop(client);
    drop(guard);
    server.await.unwrap();
    count
}

#[test]
fn tavern_stream_client_disables_real_h2_refused_stream_retries() {
    rt().block_on(async {
        let control = h2_refused_request_count(cloud_client_builder()).await;
        assert!(
            control > 1,
            "control must demonstrate an actual default protocol-NACK retry, observed {control}"
        );
        assert_eq!(
            h2_refused_request_count(super::super::tavern_stream::client_builder()).await,
            1,
            "Tavern must never send a second HEADERS after REFUSED_STREAM"
        );
    });
}

#[test]
fn tavern_stream_cancel_from_markdown_sink_prevents_same_chunk_done() {
    struct CancelAfterMarkdown<'a> {
        registry: &'a crate::ai::RequestRegistry,
        inner: VecSink,
    }
    impl HostedEventSink for CancelAfterMarkdown<'_> {
        fn send(&self, event: HostedSseEvent) -> Result<(), ()> {
            let markdown = event.event == "markdown";
            self.inner.send(event)?;
            if markdown {
                assert!(self.registry.cancel("tavern-stream-test"));
            }
            Ok(())
        }
    }
    rt().block_on(async {
        let mut reply = StreamReply::stream(markdown("first") + &done());
        reply.hold = Some(true);
        let server = StreamServer::start(vec![
            StreamReply::readiness(),
            StreamReply::capability(),
            reply,
        ])
        .await;
        let state = CloudState::with_origin(&server.origin);
        let registry = crate::ai::RequestRegistry::default();
        let sink = CancelAfterMarkdown {
            registry: &registry,
            inner: VecSink::new(),
        };
        tokio::time::timeout(
            Duration::from_secs(1),
            stream_hosted_ai(
                &state,
                &MemorySecrets::new(),
                &registry,
                stream_request(),
                &sink,
            ),
        )
        .await
        .expect("same-chunk cancellation must settle")
        .unwrap();
        let events = event_values(&sink.inner);
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[0],
            serde_json::json!({"event":"markdown","data":{"chunk":"first"}})
        );
        assert_possible_error(&events);
        assert_eq!(events[1]["data"]["code"], "cancelled");
        assert_eq!(registry.len(), 0);
        server.wait_disconnected().await;
    });
}

/// An explicit stdin runner drives real native HTTP and Channel serialization from TypeScript.
#[test]
#[ignore = "run only through MAHO_TAVERN_HOSTED_STREAM_BINARY TypeScript pipe test"]
fn real_tavern_hosted_stream_pipe() {
    use std::io::{BufRead, Read, Write};
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Frame {
        request: CloudHostedGenerateRequest,
        response_body: String,
        #[serde(default)]
        response_status: Option<u16>,
        #[serde(default)]
        response_version: Option<String>,
        #[serde(default)]
        capability_version: Option<String>,
        #[serde(default)]
        retry_after: Option<String>,
    }
    let runtime = rt();
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    println!("TAVERN_HOSTED_STREAM_READY");
    std::io::stdout().flush().unwrap();
    loop {
        let mut line = String::new();
        let bytes = (&mut input)
            .take((HOSTED_BODY_TAVERN_MAX_BYTES + 1024 * 1024 + 1) as u64)
            .read_line(&mut line)
            .unwrap();
        if bytes == 0 {
            break;
        }
        assert!(
            bytes <= HOSTED_BODY_TAVERN_MAX_BYTES + 1024 * 1024 && line.ends_with('\n'),
            "bounded complete test frame"
        );
        let frame: Frame = serde_json::from_str(&line).expect("closed test frame");
        assert_eq!(frame.request.route_id, HOSTED_ROUTE_TAVERN_STREAM);
        let reply = runtime.block_on(async {
            let mut response = StreamReply::stream(frame.response_body); response.status = frame.response_status.unwrap_or(200); response = response.version(Some(frame.response_version.as_deref().unwrap_or("v1")));
            if let Some(retry_after) = frame.retry_after { response.headers.push(("retry-after".into(), retry_after)); }
            let capability = StreamReply::capability().version(Some(frame.capability_version.as_deref().unwrap_or("v1")));
            let server = StreamServer::start(vec![StreamReply::readiness(), capability, response]).await;
            let state = CloudState::with_origin(&server.origin); let secrets = MemorySecrets::new(); secrets.set(&crate::provider_target::preset_secret_ref("deepseek").unwrap(), "fake-tavern-stream-key").unwrap();
            let registry = crate::ai::RequestRegistry::default(); let sink = VecSink::new();
            let result = stream_hosted_ai(&state, &secrets, &registry, frame.request, &sink).await; assert_eq!(registry.len(), 0);
            serde_json::json!({"error":result.err(),"events":event_values(&sink),"observed":server.observed()})
        });
        println!("TAVERN_HOSTED_STREAM_RESULT {reply}");
        std::io::stdout().flush().unwrap();
    }
}
