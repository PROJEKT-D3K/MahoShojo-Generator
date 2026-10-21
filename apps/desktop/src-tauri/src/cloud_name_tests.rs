fn name_request() -> CloudHostedGenerateRequest {
    serde_json::from_value(serde_json::json!({
        "requestId": "name-contract", "routeId": HOSTED_ROUTE_NAME,
        "body": {"name": "\u{feff} 小满 \u{feff}", "language": " ja "}
    }))
    .unwrap()
}

#[test]
fn name_contract_rejects_before_credentials_session_or_probe() {
    rt().block_on(async {
        let server = spawn_mock_server();
        let state = CloudState::with_origin(&server.origin);
        let secrets = MemorySecrets::new();
        let registry = crate::ai::RequestRegistry::default();
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/contracts/fixtures/desktop-hosted-name.json"
        ))
        .unwrap();
        for entry in fixture["invalid"].as_array().unwrap() {
            if let Ok(request) =
                serde_json::from_value::<CloudHostedGenerateRequest>(entry["request"].clone())
            {
                let error = hosted_ai_request(&state, &secrets, &registry, request)
                    .await
                    .unwrap_err();
                assert_eq!(
                    error.code,
                    CloudErrorCode::InvalidRequest,
                    "{}",
                    entry["label"]
                );
            }
            assert_eq!(registry.len(), 0);
        }
        assert_eq!(
            secrets.resolves.load(Ordering::SeqCst),
            0,
            "invalid requests must not read any credentials"
        );
        assert_eq!(server.readiness_count.load(Ordering::SeqCst), 0);
        assert!(server.last_generate_body.lock().unwrap().is_none());
        for entry in fixture["valid"].as_array().unwrap() {
            let request: CloudHostedGenerateRequest =
                serde_json::from_value(entry["request"].clone()).unwrap();
            let body = build_hosted_request_body(&request)
                .unwrap_or_else(|error| panic!("{}: {error:?}", entry["label"]));
            assert_eq!(body.as_object().unwrap().len(), 2);
            assert_eq!(
                body["name"],
                trim_ecmascript(request.body["name"].as_str().unwrap())
            );
        }
    });
}

#[test]
fn name_native_json_preserves_signed_response_and_optional_cookie() {
    rt().block_on(async {
        let server = spawn_mock_server();
        let state = CloudState::with_origin(&server.origin);
        let secrets = MemorySecrets::new();
        let registry = crate::ai::RequestRegistry::default();
        let signed = serde_json::json!({"flowerName":"铃兰","signature":"synthetic.sig","templateId":"名字生成"});
        *server.hosted_json_response.lock().unwrap() = Some((200, signed.to_string()));
        for logged_in in [false, true] {
            if logged_in {
                store_session(&secrets, &StoredSession {
                    cookie: "better-auth.session_token=synthetic-name-session".into(),
                    activity_token: None,
                    auth_key: None,
                    session_expires_at: None,
                    account: CloudAccountRecord { user_id: 7, username: "test".into(), display_name: None },
                }).unwrap();
            }
            let response = hosted_ai_request(&state, &secrets, &registry, name_request()).await.unwrap();
            assert_eq!(response.body, signed);
            assert_eq!(response.status, 200);
            assert_eq!(server.last_generate_body.lock().unwrap().as_ref().unwrap(), &serde_json::json!({"name":"小满","language":"ja"}));
            let head = server.last_generate_headers.lock().unwrap().clone().unwrap().to_lowercase();
            assert!(head.starts_with("post /api/generate-magical-girl http/1.1"));
            assert_eq!(head.contains("cookie: better-auth.session_token=synthetic-name-session"), logged_in);
            assert!(!head.contains("authorization:"));
            assert!(!head.contains("activity-token"));
            assert_eq!(registry.len(), 0);
        }
        assert_eq!(server.readiness_count.load(Ordering::SeqCst), 2);
    });
}

#[test]
fn name_unknown_contract_never_dispatches() {
    rt().block_on(async {
        let server = spawn_mock_server();
        let state = CloudState::with_origin(&server.origin);
        let secrets = MemorySecrets::new();
        let registry = crate::ai::RequestRegistry::default();
        for body in [
            "not-json".to_string(),
            serde_json::json!({"ok":true}).to_string(),
            serde_json::json!({"ok":true,"contractVersion":"g99e9-v9"}).to_string(),
        ] {
            *server.readiness_override.lock().unwrap() = Some((200, body.to_string()));
            assert_eq!(
                hosted_ai_request(&state, &secrets, &registry, name_request())
                    .await
                    .unwrap_err()
                    .code,
                CloudErrorCode::ProtocolMismatch
            );
            assert!(server.last_generate_body.lock().unwrap().is_none());
        }
    });
}

#[test]
fn name_prepare_cancellation_proves_no_generation_post() {
    rt().block_on(async {
        let server = spawn_mock_server();
        let state = CloudState::with_origin(&server.origin);
        let secrets = MemorySecrets::new();
        let registry = crate::ai::RequestRegistry::default();
        let (release, gate) = std::sync::mpsc::channel();
        let (seen, ready) = oneshot::channel();
        *server.readiness_reply_gate.lock().unwrap() = Some(gate);
        *server.readiness_seen.lock().unwrap() = Some(seen);
        let operation = hosted_ai_request(&state, &secrets, &registry, name_request());
        tokio::pin!(operation);
        tokio::select! {
            result = &mut operation => panic!("readiness should wait: {result:?}"),
            result = ready => result.unwrap(),
        }
        assert!(registry.cancel("name-contract"));
        release.send(()).unwrap();
        assert_eq!(
            operation.await.unwrap_err().code,
            CloudErrorCode::CancelledBeforeDispatch
        );
        assert!(server.last_generate_body.lock().unwrap().is_none());
        assert_eq!(registry.len(), 0);
    });
}

#[test]
fn name_http_errors_preserve_status_and_retry_after_header() {
    rt().block_on(async {
        let server = spawn_mock_server();
        let state = CloudState::with_origin(&server.origin);
        let secrets = MemorySecrets::new();
        let registry = crate::ai::RequestRegistry::default();
        *server.hosted_json_response.lock().unwrap() = Some((429, "".into()));
        *server.hosted_json_extra_headers.lock().unwrap() =
            vec![("Retry-After".into(), "60".into())];
        let response = hosted_ai_request(&state, &secrets, &registry, name_request())
            .await
            .unwrap();
        assert_eq!(response.status, 429);
        assert!(response.body.is_null());
        assert_eq!(response.retry_after_seconds, Some(60));
        for (status, body) in [
            (400, "{\"error\":\"bad name\"}"),
            (500, "server unavailable"),
            (524, "<html>timeout</html>"),
        ] {
            *server.hosted_json_response.lock().unwrap() = Some((status, body.into()));
            let response = hosted_ai_request(&state, &secrets, &registry, name_request())
                .await
                .unwrap();
            assert_eq!(response.status, status);
            assert_eq!(response.retry_after_seconds, None);
        }
        *server.hosted_json_response.lock().unwrap() = Some((200, "not-json".into()));
        assert_eq!(
            hosted_ai_request(&state, &secrets, &registry, name_request())
                .await
                .unwrap_err()
                .code,
            CloudErrorCode::InvalidResponse
        );
    });
}
