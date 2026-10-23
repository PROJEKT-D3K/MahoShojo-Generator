use super::*;
use crate::secret::SecretStoreError;
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};

#[derive(Default)]
struct Secrets(AtomicUsize);
impl SecretStore for Secrets {
    fn set(&self, _: &str, _: &str) -> Result<(), SecretStoreError> {
        unreachable!()
    }
    fn exists(&self, _: &str) -> Result<bool, SecretStoreError> {
        unreachable!()
    }
    fn delete(&self, _: &str) -> Result<(), SecretStoreError> {
        unreachable!()
    }
    fn resolve(&self, _: &str) -> Result<Option<String>, SecretStoreError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(Some("fixture-only-key".into()))
    }
}
fn profile(base: &str) -> DirectProviderExecutionProfile {
    serde_json::from_value(json!({"id":"fixture", "name":"fixture", "adapter":"openai-compatible", "baseUrl":base,"modelId":"existing", "apiKeyRef":"fixture:key"})).unwrap()
}
fn request(id: &str) -> DiscoveryRequest {
    DiscoveryRequest {
        contract_version: 1,
        request_id: id.into(),
        target: DiscoveryTarget::Profile {
            profile_id: "fixture".into(),
        },
    }
}
fn store(base: &str) -> LocalStore {
    let store = LocalStore::open_in_memory().unwrap();
    store
        .put(
            "fixture",
            &serde_json::to_string(&profile(base)).unwrap(),
            "t",
        )
        .unwrap();
    store
}
fn completed(response: DiscoveryResponse) -> Service {
    match response {
        DiscoveryResponse::Completed { service, .. } => service,
        _ => panic!("expected completion"),
    }
}

async fn discover(
    request: DiscoveryRequest,
    store: LocalStore,
    secrets: Arc<Secrets>,
    registry: &DiscoveryRegistry,
) -> Result<DiscoveryResponse, DiscoveryError> {
    discover_with_plan(request, registry, move |request| {
        plan(request, &store, secrets.as_ref())
    })
    .await
}

#[test]
fn strict_request_rejects_overrides() {
    for extra in ["baseUrl", "headers", "apiKey", "secretRef", "port", "path"] {
        let mut value = json!({"contractVersion":1,"requestId":"test","target":{"kind":"candidate","candidateId":"ollama"}});
        value["target"][extra] = json!("malicious");
        assert!(serde_json::from_value::<DiscoveryRequest>(value).is_err());
    }
    assert!(serde_json::from_value::<DiscoveryCancelRequest>(
        json!({"requestId":"x","target":"x"})
    )
    .is_err());
    assert!(!valid_identity("a/b", 128));
    assert!(!valid_identity(&"a".repeat(129), 128));
    assert!(valid_identity("a.A_0:-", 128));
}
#[test]
fn numeric_loopback_and_original_path_are_authority() {
    for base in [
        "http://localhost:1234/v1",
        "http://127.1/v1",
        "http://2130706433/v1",
        "http://0177.0.0.1/v1",
        "http://192.168.1.1/v1",
        "https://example.invalid/v1",
        "http://127.0.0.1/a/../v1",
        "http://127.0.0.1/%2e%2e/v1",
        "http://127.0.0.1/v1?key=x",
        "http://127.0.0.1/v1#x",
        "http://u:p@127.0.0.1/v1",
        "http://127.0.0.1/a%2fb",
        "http://127.0.0.1/a/.\n./v1",
    ] {
        assert!(profile_endpoint(&profile(base)).is_err(), "{base}");
    }
    assert_eq!(
        profile_endpoint(&profile("http://127.23.4.5:7777/proxy/v1/")).unwrap(),
        "http://127.23.4.5:7777/proxy/v1/models"
    );
    assert_eq!(
        profile_endpoint(&profile("https://[::1]:7777/proxy/v1")).unwrap(),
        "https://[::1]:7777/proxy/v1/models"
    );
}
#[test]
fn rejected_target_never_resolves_secrets() {
    let secrets = Secrets::default();
    for base in [
        "http://localhost/v1",
        "https://example.invalid/v1",
        "http://127.0.0.1/a/../v1",
    ] {
        assert!(plan(&request("id"), &store(base), &secrets).is_err());
    }
    let mut invalid = profile("http://127.0.0.1/v1");
    invalid.secret_header_refs = Some(std::collections::BTreeMap::from([(
        "Cookie".into(),
        "fixture:cookie".into(),
    )]));
    let store = LocalStore::open_in_memory().unwrap();
    store
        .put("fixture", &serde_json::to_string(&invalid).unwrap(), "t")
        .unwrap();
    assert!(plan(&request("id"), &store, &secrets).is_err());
    assert_eq!(secrets.0.load(Ordering::SeqCst), 0);
}
#[test]
fn controlled_headers_are_rejected_before_credentials_and_accept_is_json() {
    let secrets = Secrets::default();
    for name in [
        "Host",
        "Connection",
        "Content-Length",
        "Cookie",
        "Cookie2",
        "Proxy-Authorization",
    ] {
        for secret_header in [false, true] {
            let mut profile = profile("http://127.0.0.1/v1");
            let headers = std::collections::BTreeMap::from([(
                name.to_owned(),
                if secret_header {
                    "fixture:header"
                } else {
                    "untrusted"
                }
                .to_owned(),
            )]);
            if secret_header {
                profile.secret_header_refs = Some(headers);
            } else {
                profile.public_headers = Some(headers);
            }
            let store = LocalStore::open_in_memory().unwrap();
            store
                .put("fixture", &serde_json::to_string(&profile).unwrap(), "t")
                .unwrap();
            assert!(plan(&request("id"), &store, &secrets).is_err(), "{name}");
        }
    }
    assert_eq!(secrets.0.load(Ordering::SeqCst), 0);
    let mut profile = profile("http://127.0.0.1/v1");
    profile.public_headers = Some(std::collections::BTreeMap::from([(
        "Accept".into(),
        "text/event-stream".into(),
    )]));
    let store = LocalStore::open_in_memory().unwrap();
    store
        .put("fixture", &serde_json::to_string(&profile).unwrap(), "t")
        .unwrap();
    let plan = plan(&request("id"), &store, &secrets).unwrap();
    assert_eq!(plan.headers.get(ACCEPT).unwrap(), "application/json");
    assert!(plan.headers.get(CONTENT_TYPE).is_none());
}

#[test]
fn bounded_projection_retains_exact_ids_and_marks_remote() {
    let service = project(Protocol::OllamaNative, &json!({"models":[{"model":"exact:tag"},{"name":"fallback"},{"model":"x:cloud"},{"model":"remote","remote_host":"https://do-not-fetch.invalid"}]})).unwrap();
    assert_eq!(service.models[0].id, "exact:tag");
    assert_eq!(service.models[1].id, "fallback");
    assert_eq!(service.models[2].execution, "remote-indicated");
    assert_eq!(service.models[3].execution, "remote-indicated");
    for id in [
        "".into(),
        " model".into(),
        "model ".into(),
        "a\nb".into(),
        "a\u{85}b".into(),
        "😀".repeat(101),
    ] {
        assert!(project(Protocol::OpenaiCompatible, &json!({"data":[{"id":id}]})).is_err());
    }
    assert!(project(
        Protocol::OpenaiCompatible,
        &json!({"data": vec![json!({"id":"model"});257]})
    )
    .is_err());
    for value in [
        json!({}),
        json!({"data":null}),
        json!({"data":{}}),
        json!({"data":[null]}),
    ] {
        assert!(project(Protocol::OpenaiCompatible, &value).is_err());
    }
    assert_eq!(
        project(Protocol::OpenaiCompatible, &json!({"data":[]}))
            .unwrap()
            .state,
        ServiceState::NoModels
    );
    let service = project(Protocol::LmStudioNative, &json!({"models":[{"key":"embedding", "type":"embedding"},{"key":"decision", "type":"decision"}]})).unwrap();
    assert_eq!(service.state, ServiceState::NoCompatibleModels);
    let service = project(Protocol::LmStudioNative, &json!({"models":[{"key":"a", "type":"llm", "loaded_instances":[]},{"key":"b","type":"llm","loaded_instances":[{}]},{"key":"embedding-in-name-only"}]})).unwrap();
    assert_eq!(service.models[0].loaded, "no");
    assert_eq!(service.models[1].loaded, "yes");
    assert_eq!(service.models[2].kind, "unknown");
}

/// In-process fixture only; no installed service or real credentials involved.
async fn server(replies: Vec<(u16, String)>) -> (String, tokio::task::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut requests = vec![];
        for (status, body) in replies {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![];
            loop {
                let mut chunk = [0; 1024];
                let n = socket.read(&mut chunk).await.unwrap();
                assert_ne!(n, 0);
                request.extend_from_slice(&chunk[..n]);
                if request.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            requests.push(String::from_utf8(request).unwrap());
            socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\nLocation: http://127.0.0.1:9/not-followed\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
        requests
    });
    (base, task)
}
#[tokio::test]
async fn profile_get_preserves_base_and_credential_snapshot() {
    let (base, task) = server(vec![(200, r#"{"data":[{"id":"model"}]}"#.into())]).await;
    let secrets = Arc::new(Secrets::default());
    let response = discover(
        request("id"),
        store(&format!("{base}/proxy/v1")),
        secrets.clone(),
        &DiscoveryRegistry::default(),
    )
    .await
    .unwrap();
    assert_eq!(completed(response).state, ServiceState::Reachable);
    let requests = task.await.unwrap();
    assert!(requests[0].starts_with("GET /proxy/v1/models HTTP/1.1"));
    assert!(requests[0].contains("authorization: Bearer fixture-only-key"));
    assert!(requests[0].contains("accept: application/json"));
    assert!(!requests[0].contains("text/event-stream"));
    assert!(!requests[0].contains("cookie:"));
    assert_eq!(secrets.0.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn version_404_and_lm_fallback_only_use_fixed_paths() {
    for protocol in [Protocol::OllamaNative, Protocol::LmStudioNative] {
        let body = if matches!(protocol, Protocol::OllamaNative) {
            r#"{"models":[{"model":"a"}]}"#
        } else {
            r#"{"data":[{"id":"a"}]}"#
        };
        let (base, task) = server(vec![(404, "".into()), (200, body.into())]).await;
        let result = execute(
            &client().unwrap(),
            &Plan {
                protocol,
                base,
                headers: HeaderMap::new(),
                authenticated: false,
            },
        )
        .await;
        assert_eq!(result.state, ServiceState::Reachable);
        let paths: Vec<_> = task
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.lines().next().unwrap().to_owned())
            .collect();
        assert_eq!(
            paths,
            if matches!(protocol, Protocol::OllamaNative) {
                vec!["GET /api/version HTTP/1.1", "GET /api/tags HTTP/1.1"]
            } else {
                vec!["GET /api/v1/models HTTP/1.1", "GET /v1/models HTTP/1.1"]
            }
        );
    }
}
#[tokio::test]
async fn authentication_denial_and_redirect_never_fallback() {
    for (status, auth, expected) in [
        (401, false, ServiceState::AuthRequired),
        (401, true, ServiceState::AuthRejected),
        (403, true, ServiceState::AccessDenied),
        (302, false, ServiceState::UnsupportedResponse),
    ] {
        let (base, task) = server(vec![(
            status,
            "untrusted diagnostic fixture-only-key".into(),
        )])
        .await;
        let service = execute(
            &client().unwrap(),
            &Plan {
                protocol: Protocol::LmStudioNative,
                base,
                headers: HeaderMap::new(),
                authenticated: auth,
            },
        )
        .await;
        assert_eq!(service.state, expected);
        assert!(!serde_json::to_string(&service)
            .unwrap()
            .contains("fixture-only-key"));
        assert_eq!(task.await.unwrap().len(), 1);
    }
}
#[tokio::test]
async fn oversized_response_fails_instead_of_truncating() {
    let (base, task) = server(vec![(200, " ".repeat(MAX_BODY + 1))]).await;
    let service = execute(
        &client().unwrap(),
        &Plan {
            protocol: Protocol::OpenaiCompatible,
            base,
            headers: HeaderMap::new(),
            authenticated: false,
        },
    )
    .await;
    assert_eq!(service.error_code.as_deref(), Some("response-too-large"));
    // Client may close before the fixture finishes writing the rejected oversized body.
    let _ = task.await;
}
#[tokio::test]
async fn cancellation_interrupts_headers_and_body_and_releases_single_flight() {
    for body_started in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let store = store(&format!("http://{}/v1", listener.local_addr().unwrap()));
        let (ready_tx, ready_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![];
            loop {
                let mut b = [0; 1024];
                let n = socket.read(&mut b).await.unwrap();
                bytes.extend_from_slice(&b[..n]);
                if bytes.windows(4).any(|v| v == b"\r\n\r\n") {
                    break;
                }
            }
            if body_started {
                socket
                    .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n")
                    .await
                    .unwrap();
            }
            ready_tx.send(()).unwrap();
            let mut b = [0; 1];
            matches!(
                tokio::time::timeout(Duration::from_secs(1), socket.read(&mut b))
                    .await
                    .unwrap(),
                Ok(0) | Err(_)
            )
        });
        let registry = Arc::new(DiscoveryRegistry::default());
        assert!(!registry.cancel("before-register").unwrap());
        let secrets = Arc::new(Secrets::default());
        let discovery = discover(request("id"), store, secrets, &registry);
        let cancel = async {
            ready_rx.await.unwrap();
            assert!(matches!(
                registry.register("duplicate"),
                Err(DiscoveryError {
                    code: DiscoveryErrorCode::Busy
                })
            ));
            assert!(registry.cancel("id").unwrap());
            assert!(registry.cancel("id").unwrap());
        };
        let (response, _) = tokio::join!(discovery, cancel);
        assert!(matches!(
            response.unwrap(),
            DiscoveryResponse::Cancelled { .. }
        ));
        assert!(server.await.unwrap());
        assert!(!registry.cancel("id").unwrap());
        assert!(registry.register("next").is_ok());
    }
}

#[tokio::test]
async fn chunked_body_enforces_actual_bytes_without_content_length() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1/models", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = vec![];
        loop {
            let mut b = [0; 1024];
            let n = socket.read(&mut b).await.unwrap();
            request.extend_from_slice(&b[..n]);
            if request.windows(4).any(|v| v == b"\r\n\r\n") {
                break;
            }
        }
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
            .await
            .unwrap();
        let chunk = vec![b' '; 65536];
        for _ in 0..17 {
            if socket.write_all(b"10000\r\n").await.is_err()
                || socket.write_all(&chunk).await.is_err()
                || socket.write_all(b"\r\n").await.is_err()
            {
                return;
            }
        }
        let _ = socket.write_all(b"0\r\n\r\n").await;
    });
    let result = get(&client().unwrap(), &endpoint, &HeaderMap::new()).await;
    assert!(matches!(
        result,
        Err(ReadError(
            ServiceState::UnsupportedResponse,
            "response-too-large"
        ))
    ));
    let _ = task.await;
}

#[tokio::test]
async fn unmatched_preregister_cancel_has_bounded_network_fallback() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let store = store(&format!("http://{}/v1", listener.local_addr().unwrap()));
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = vec![];
        loop {
            let mut b = [0; 1024];
            let n = socket.read(&mut b).await.unwrap();
            request.extend_from_slice(&b[..n]);
            if request.windows(4).any(|v| v == b"\r\n\r\n") {
                break;
            }
        }
        // No headers: per-GET bound must drop the connection, without a matching cancel.
        let mut b = [0; 1];
        matches!(
            tokio::time::timeout(Duration::from_secs(7), socket.read(&mut b))
                .await
                .unwrap(),
            Ok(0) | Err(_)
        )
    });
    let registry = DiscoveryRegistry::default();
    assert!(!registry.cancel("id").unwrap());
    let response = tokio::time::timeout(
        Duration::from_secs(7),
        discover(
            request("id"),
            store,
            Arc::new(Secrets::default()),
            &registry,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(completed(response).state, ServiceState::TimedOut);
    assert!(server.await.unwrap());
    assert!(registry.register("next").is_ok());
}

#[test]
fn native_matches_shared_request_and_response_fixtures() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../../../../fixtures/local-ai-discovery.json")).unwrap();
    for value in fixtures["requests"].as_array().unwrap() {
        let request: DiscoveryRequest = serde_json::from_value(value.clone()).unwrap();
        request.validate().unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), *value);
    }
    for value in fixtures["invalidRequests"].as_array().unwrap() {
        assert!(serde_json::from_value::<DiscoveryRequest>(value.clone())
            .map(|request| request.validate().is_err())
            .unwrap_or(true));
    }
    let mut service = project(
        Protocol::OllamaNative,
        &json!({"models":[{"model":"qwen3:8b","name":"Qwen 3"}]}),
    )
    .unwrap();
    service.version = Some("0.6.0".into());
    let response = DiscoveryResponse::Completed {
        contract_version: 1,
        request_id: "candidate-ollama".into(),
        service,
    };
    assert_eq!(
        serde_json::to_value(response).unwrap(),
        fixtures["responses"][0]
    );
    let response = DiscoveryResponse::Cancelled {
        contract_version: 1,
        request_id: "cancel_1".into(),
    };
    assert_eq!(
        serde_json::to_value(response).unwrap(),
        fixtures["responses"][1]
    );
    // Native only serializes response DTOs; TS validates untrusted responses.
    // Native parser independently rejects the same invalid model IDs.
    for index in [1, 2] {
        let id = &fixtures["invalidResponses"][index]["service"]["models"][0]["id"];
        assert!(project(Protocol::OpenaiCompatible, &json!({"data":[{"id":id}]})).is_err());
    }
}

#[test]
fn duplicate_ids_merge_conservatively_and_explicit_embedding_is_unselectable() {
    let service = project(
        Protocol::OllamaNative,
        &json!({"models":[
            {"model":"duplicate","name":"first"},
            {"model":"duplicate","remote_host":"https://never-follow.invalid"},
            {"model":"embedding","capabilities":["embedding"]},
            {"model":"llm","capabilities":["completion","vision"]},
            {"model":"embedding","capabilities":["completion"]}
        ]}),
    )
    .unwrap();
    assert_eq!(service.models.len(), 2);
    assert_eq!(service.models[0].label.as_deref(), Some("first"));
    assert_eq!(service.models[0].execution, "remote-indicated");
    assert_eq!(service.models[1].kind, "llm");
    let service = project(Protocol::LmStudioNative, &json!({"models":[
        {"key":"conflict","type":"llm"}, {"key":"conflict","type":"embedding"},
        {"key":"loaded","type":"llm","loaded_instances":[{}]}, {"key":"loaded","type":"llm","loaded_instances":[]}
    ]})).unwrap();
    assert_eq!(service.models.len(), 1);
    assert_eq!(service.models[0].id, "loaded");
    assert_eq!(service.models[0].loaded, "unknown");
}

#[tokio::test]
async fn blocked_preparation_cancels_promptly_but_keeps_single_flight_until_read_finishes() {
    assert_blocking_preparation_is_bounded(false).await;
}
#[tokio::test]
async fn blocked_preparation_has_six_second_budget_without_unbounded_worker_retries() {
    assert_blocking_preparation_is_bounded(true).await;
}
async fn assert_blocking_preparation_is_bounded(expire: bool) {
    let registry = DiscoveryRegistry::default();
    let (started_tx, started_rx) = oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let discovery = discover_with_plan(request("blocking"), &registry, move |_| {
        started_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(10)).unwrap(); // Bounded fixture for an unrevocable OS read.
        Err(DiscoveryErrorCode::Failed.into())
    });
    let interrupt = async {
        started_rx.await.unwrap();
        if !expire {
            assert!(registry.cancel("blocking").unwrap());
        }
    };
    let started = std::time::Instant::now();
    let (response, _) = tokio::time::timeout(Duration::from_secs(8), async {
        tokio::join!(discovery, interrupt)
    })
    .await
    .expect("discovery must return before the blocking read finishes");
    if expire {
        assert!(started.elapsed() >= Duration::from_secs(6));
        assert_eq!(completed(response.unwrap()).state, ServiceState::TimedOut);
    } else {
        assert!(matches!(
            response.unwrap(),
            DiscoveryResponse::Cancelled { .. }
        ));
    }
    assert!(matches!(
        registry.register("retry"),
        Err(DiscoveryError {
            code: DiscoveryErrorCode::Busy
        })
    ));
    // The terminal response has returned; the outstanding OS read still owns the slot.
    release_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if let Ok(lease) = registry.register("after-read") {
                drop(lease);
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
}

#[test]
fn mismatched_persisted_identity_cannot_resolve_another_profiles_credentials() {
    let store = LocalStore::open_in_memory().unwrap();
    let mut mismatched = profile("http://127.0.0.1/v1");
    mismatched.id = "another-profile".into();
    store
        .put("fixture", &serde_json::to_string(&mismatched).unwrap(), "t")
        .unwrap();
    let secrets = Secrets::default();
    assert!(matches!(
        plan(&request("id"), &store, &secrets),
        Err(DiscoveryError {
            code: DiscoveryErrorCode::ProfileRejected
        })
    ));
    assert_eq!(secrets.0.load(Ordering::SeqCst), 0);
}
