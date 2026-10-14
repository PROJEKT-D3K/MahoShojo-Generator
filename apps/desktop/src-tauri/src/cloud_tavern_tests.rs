fn tavern_request() -> CloudHostedGenerateRequest {
    serde_json::from_value(serde_json::json!({
        "requestId": "tavern-contract", "routeId": HOSTED_ROUTE_TAVERN,
        "body": {"template":"general","language":"zh-CN","sourceName":"Alice","attachments":[]}
    }))
    .unwrap()
}

#[test]
fn tavern_contract_rejects_before_credentials_session_or_probe() {
    rt().block_on(async {
        let server = spawn_mock_server();
        let _shutdown = server.shutdown.clone().drop_guard();
        let state = CloudState::with_origin(&server.origin);
        let secrets = MemorySecrets::new();
        let registry = crate::ai::RequestRegistry::default();
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/contracts/fixtures/desktop-hosted-tavern.json"
        ))
        .unwrap();
        for entry in fixture["invalid"].as_array().unwrap() {
            if let Ok(mut request) =
                serde_json::from_value::<CloudHostedGenerateRequest>(entry["request"].clone())
            {
                // Supply a real preset identity so business validation cannot hide behind a missing key.
                if request.system_config.is_none() && request.preset_config.is_none() {
                    request.preset_config = Some(CloudHostedPresetConfig {
                        provider_id: "deepseek".into(),
                        model_id: "deepseek-chat".into(),
                        generation_overrides: None,
                    });
                }
                assert_eq!(
                    hosted_ai_request(&state, &secrets, &registry, request)
                        .await
                        .unwrap_err()
                        .code,
                    CloudErrorCode::InvalidRequest,
                    "{}",
                    entry["label"]
                );
            }
            assert_eq!(registry.len(), 0);
        }
        for entry in fixture["valid"].as_array().unwrap() {
            let request = serde_json::from_value(entry["request"].clone()).unwrap();
            build_hosted_request_body(&request)
                .unwrap_or_else(|error| panic!("{}: {error:?}", entry["label"]));
        }
        for content in [
            "中".repeat(1024 * 1024 / 3 + 1),
            "a".repeat(HOSTED_BODY_TAVERN_MAX_BYTES),
        ] {
            let mut request = tavern_request();
            request.body["attachments"] = serde_json::json!([{"name":"x","content":content}]);
            assert_eq!(
                hosted_ai_request(&state, &secrets, &registry, request)
                    .await
                    .unwrap_err()
                    .code,
                CloudErrorCode::InvalidRequest
            );
        }
        let mut request = tavern_request();
        request.body["attachments"] = serde_json::json!([
            {"name":"x","content":"a".repeat(512 * 1024)},
            {"name":"y","content":"a".repeat(512 * 1024 + 1)}
        ]);
        assert_eq!(
            hosted_ai_request(&state, &secrets, &registry, request)
                .await
                .unwrap_err()
                .code,
            CloudErrorCode::InvalidRequest
        );
        let mut request = tavern_request();
        request.preset_config = Some(CloudHostedPresetConfig {
            provider_id: "deepseek".into(),
            model_id: "deepseek-chat".into(),
            generation_overrides: Some(serde_json::json!({"unknown":true})),
        });
        assert_eq!(
            hosted_ai_request(&state, &secrets, &registry, request)
                .await
                .unwrap_err()
                .code,
            CloudErrorCode::InvalidRequest
        );
        let request = tavern_request();
        assert_eq!(
            stream_hosted_ai(&state, &secrets, &registry, request, &VecSink::new())
                .await
                .unwrap_err()
                .code,
            CloudErrorCode::InvalidRequest
        );
        assert_eq!(secrets.resolves.load(Ordering::SeqCst), 0);
        assert_eq!(server.readiness_count.load(Ordering::SeqCst), 0);
        assert!(server.last_generate_body.lock().unwrap().is_none());
        assert_eq!(registry.len(), 0);
    });
}

#[test]
fn tavern_templates_system_and_preset_use_fixed_json_path() {
    rt().block_on(async {
        let server = spawn_mock_server();
        let _shutdown = server.shutdown.clone().drop_guard();
        let state = CloudState::with_origin(&server.origin);
        let secrets = MemorySecrets::new();
        secrets.set(&crate::provider_target::preset_secret_ref("deepseek").unwrap(), "fake-tavern-key").unwrap();
        let registry = crate::ai::RequestRegistry::default();
        let response_body = serde_json::json!({"data":{"name":"Alice","templateId":"通用角色"},"aiMeta":{"model":"test"}});
        *server.hosted_json_response.lock().unwrap() = Some((200, response_body.to_string()));
        for template in ["general", "general-scenario"] {
            for preset in [false, true] {
                let mut request = tavern_request();
                request.body["template"] = serde_json::json!(template);
                if preset {
                    request.preset_config = Some(CloudHostedPresetConfig {
                        provider_id: "deepseek".into(), model_id: "deepseek-chat".into(), generation_overrides: None,
                    });
                } else {
                    request.system_config = Some(CloudHostedSystemConfig {
                        model_id: Some("test-system-model".into()), generation_overrides: None,
                    });
                }
                let response = hosted_ai_request(&state, &secrets, &registry, request).await.unwrap();
                assert_eq!(response.body, response_body);
                let sent = server.last_generate_body.lock().unwrap().clone().unwrap();
                assert_eq!(sent["template"], template);
                assert_eq!(sent["customProvider"]["providerId"], if preset {"deepseek"} else {"system"});
                assert_eq!(sent["customProvider"]["apiKey"], if preset {"fake-tavern-key"} else {""});
                assert!(sent.get("raw").is_none());
                let headers = server.last_generate_headers.lock().unwrap().clone().unwrap().to_lowercase();
                assert!(headers.starts_with("post /api/tavern/convert http/1.1"));
                assert!(!headers.contains("fake-tavern-key"));
            }
        }
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../../../../packages/contracts/fixtures/desktop-cloud.json")).unwrap();
        assert_eq!(fixture["paths"]["hostedTavernConvert"], HOSTED_TAVERN_CONVERT_PATH);
        assert_eq!(registry.len(), 0);
    });
}

#[test]
fn tavern_serialized_budget_is_checked_after_native_injection() {
    rt().block_on(async {
        let mut request = tavern_request();
        request.body["attachments"] =
            serde_json::json!([{"name":"x","content":"\0".repeat(1024 * 1024)}]);
        let body = build_hosted_request_body(&request).unwrap();
        assert!(serde_json::to_vec(&body).unwrap().len() > HOSTED_BODY_DEFAULT_MAX_BYTES);
        assert!(serde_json::to_vec(&body).unwrap().len() < HOSTED_BODY_TAVERN_MAX_BYTES);
        assert_eq!(hosted_body_max_bytes(HOSTED_ROUTE_NAME), 256 * 1024);
        assert_eq!(hosted_body_max_bytes(HOSTED_ROUTE_DETAILS), 256 * 1024);
        let server = spawn_mock_server();
        let _shutdown = server.shutdown.clone().drop_guard();
        let state = CloudState::with_origin(&server.origin);
        let secrets = MemorySecrets::new();
        secrets
            .set(
                &crate::provider_target::preset_secret_ref("deepseek").unwrap(),
                &"k".repeat(3 * 1024 * 1024),
            )
            .unwrap();
        request.preset_config = Some(CloudHostedPresetConfig {
            provider_id: "deepseek".into(),
            model_id: "deepseek-chat".into(),
            generation_overrides: None,
        });
        let registry = crate::ai::RequestRegistry::default();
        assert_eq!(
            hosted_ai_request(&state, &secrets, &registry, request)
                .await
                .unwrap_err()
                .code,
            CloudErrorCode::InvalidRequest
        );
        assert_eq!(
            secrets.resolves.load(Ordering::SeqCst),
            1,
            "only the preset key, never the session"
        );
        assert_eq!(server.readiness_count.load(Ordering::SeqCst), 0);
        assert!(server.last_generate_body.lock().unwrap().is_none());
        assert_eq!(registry.len(), 0);
    });
}

#[test]
fn tavern_response_budgets_do_not_follow_request_budget() {
    rt().block_on(async {
        let server = spawn_mock_server();
        let _shutdown = server.shutdown.clone().drop_guard();
        let state = CloudState::with_origin(&server.origin);
        let secrets = MemorySecrets::new();
        let registry = crate::ai::RequestRegistry::default();
        // Exactly 4 MiB JSON succeeds; one byte over fails despite the 8 MiB request budget.
        for extra in [0, 1] {
            let body = format!(
                "\"{}\"",
                "x".repeat(HOSTED_JSON_RESPONSE_MAX_BYTES - 2 + extra)
            );
            *server.hosted_json_response.lock().unwrap() = Some((200, body));
            let response = hosted_ai_request(&state, &secrets, &registry, tavern_request()).await;
            if extra == 0 {
                assert!(response.is_ok());
            } else {
                assert_eq!(response.unwrap_err().code, CloudErrorCode::InvalidResponse);
            }
        }
        for extra in [0, 1] {
            let body = format!(
                "\"{}\"",
                "x".repeat(HOSTED_ERROR_BODY_MAX_BYTES - 2 + extra)
            );
            *server.hosted_json_response.lock().unwrap() = Some((429, body));
            *server.hosted_json_extra_headers.lock().unwrap() =
                vec![("Retry-After".into(), "60".into())];
            let response = hosted_ai_request(&state, &secrets, &registry, tavern_request())
                .await
                .unwrap();
            assert_eq!(response.status, 429);
            assert_eq!(response.retry_after_seconds, Some(60));
            assert_eq!(response.body.is_null(), extra == 1);
            if extra == 1 {
                let old_route =
                    hosted_ai_request(&state, &secrets, &registry, hosted_json_request())
                        .await
                        .unwrap();
                assert!(
                    old_route.body.is_string(),
                    "existing routes retain their 4 MiB error cap"
                );
            }
        }
        assert_eq!(registry.len(), 0);
    });
}

#[test]
fn tavern_malformed_readiness_is_pre_dispatch_but_posted_invalid_json_is_uncertain() {
    rt().block_on(async {
        let server = spawn_mock_server();
        let _shutdown = server.shutdown.clone().drop_guard();
        let state = CloudState::with_origin(&server.origin);
        let secrets = MemorySecrets::new();
        let registry = crate::ai::RequestRegistry::default();
        *server.readiness_override.lock().unwrap() = Some((200, "not-json".into()));
        assert_eq!(
            hosted_ai_request(&state, &secrets, &registry, tavern_request())
                .await
                .unwrap_err()
                .code,
            CloudErrorCode::ProtocolMismatch
        );
        assert!(server.last_generate_body.lock().unwrap().is_none());
        assert_eq!(
            hosted_ai_request(&state, &secrets, &registry, hosted_json_request())
                .await
                .unwrap_err()
                .code,
            CloudErrorCode::InvalidResponse,
            "existing routes keep their preparation error semantics"
        );
        assert!(server.last_generate_body.lock().unwrap().is_none());
        *server.readiness_override.lock().unwrap() = None;
        *server.hosted_json_response.lock().unwrap() = Some((200, "not-json".into()));
        assert_eq!(
            hosted_ai_request(&state, &secrets, &registry, tavern_request())
                .await
                .unwrap_err()
                .code,
            CloudErrorCode::InvalidResponse,
            "a posted request must remain uncertain in the renderer"
        );
        assert!(server.last_generate_body.lock().unwrap().is_some());
        assert_eq!(registry.len(), 0);
    });
}

/// Explicit TS runner only: real native dispatch, in-memory secrets, owned loopback HTTP.
#[test]
#[ignore = "requires the explicit Tavern TS stdin runner; not Tauri/Windows acceptance"]
fn real_tavern_hosted_pipe() {
    use std::io::{BufRead, Read, Write};
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Frame {
        request: CloudHostedGenerateRequest,
        #[serde(default)]
        response_body: Option<serde_json::Value>,
    }
    let runtime = rt();
    let server = spawn_mock_server();
    let _shutdown = server.shutdown.clone().drop_guard();
    let state = CloudState::with_origin(&server.origin);
    let secrets = MemorySecrets::new();
    secrets
        .set(
            &crate::provider_target::preset_secret_ref("deepseek").unwrap(),
            "fake-tavern-key",
        )
        .unwrap();
    let registry = crate::ai::RequestRegistry::default();
    println!("TAVERN_HOSTED_READY");
    std::io::stdout().flush().unwrap();
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    loop {
        let mut line = String::new();
        let bytes = (&mut input)
            .take((HOSTED_BODY_TAVERN_MAX_BYTES + 64 * 1024 + 1) as u64)
            .read_line(&mut line)
            .unwrap();
        if bytes == 0 {
            break;
        }
        assert!(
            bytes <= HOSTED_BODY_TAVERN_MAX_BYTES + 64 * 1024 && line.ends_with('\n'),
            "bounded complete test frame"
        );
        let frame: Frame = serde_json::from_str(&line).expect("closed test frame");
        assert_eq!(
            frame.request.route_id, HOSTED_ROUTE_TAVERN,
            "Tavern-only test runner"
        );
        *server.last_generate_body.lock().unwrap() = None;
        *server.last_generate_headers.lock().unwrap() = None;
        *server.hosted_json_response.lock().unwrap() = Some((
            200,
            frame
                .response_body
                .unwrap_or_else(|| serde_json::json!({"name":"Alice"}))
                .to_string(),
        ));
        let result = runtime.block_on(hosted_ai_request(
            &state,
            &secrets,
            &registry,
            frame.request,
        ));
        let headers = server
            .last_generate_headers
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_default();
        let mut parts = headers
            .lines()
            .next()
            .unwrap_or_default()
            .split_whitespace();
        let observed = serde_json::json!({
            "method": parts.next(), "path": parts.next(),
            "body": server.last_generate_body.lock().unwrap().clone(),
        });
        let frame = match result {
            Ok(response) => serde_json::json!({"response":response,"observed":observed}),
            Err(error) => serde_json::json!({"error":error,"observed":observed}),
        };
        println!("TAVERN_HOSTED_RESULT {}", frame);
        std::io::stdout().flush().unwrap();
        assert_eq!(registry.len(), 0);
    }
}
