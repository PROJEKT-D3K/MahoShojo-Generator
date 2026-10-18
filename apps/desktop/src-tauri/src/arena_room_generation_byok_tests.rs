use super::*;
use crate::hosted_preset::tests::SyntheticStore;
use crate::secret::SecretStore;

const CANARY: &str = "synthetic-room-private-provider-canary";
const REFERENCE: &str = "preset:deepseek:api-key";
fn selection() -> Value {
    json!({"providerId":"deepseek","modelId":"deepseek-v4-flash-0731","generationOverrides":{"temperature":0.8,"thinking":{"mode":"enabled","effort":"high"}}})
}
fn byok_raw(handle: &str) -> Value {
    let mut value = raw(handle);
    value["request"]["presetConfig"] = selection();
    value
}
fn setup_store(address: std::net::SocketAddr, store: Arc<SyntheticStore>) -> Attached {
    let instance = RoomInstance::new(
        InstanceToken::new(1),
        Arc::new(RoomHttp::loopback(address)),
        store,
    );
    instance.page_finished().unwrap();
    let attached = attach(Arc::new(instance), synthetic_account(1).access, 1);
    seed(&attached.instance);
    attached
}
fn store() -> Arc<SyntheticStore> {
    let store = Arc::new(SyntheticStore::default());
    store.set(REFERENCE, CANARY).unwrap();
    store
}
fn byok_start(attached: &Attached) -> Result<EngineReply, RoomError> {
    attached
        .instance
        .request_owned(attached.document, byok_raw(&attached.handle))
}
fn no_secret(value: &Value) {
    let text = value.to_string();
    assert!(!text.contains(CANARY));
    assert!(!text.contains(REFERENCE));
    assert!(!text.contains("apiKey"));
    assert!(!text.contains("secretRef"));
}
fn wire_weak(attached: &Attached) -> std::sync::Weak<Vec<u8>> {
    lock(&attached.instance.inner)
        .pending
        .as_ref()
        .unwrap()
        .start_basis
        .as_ref()
        .unwrap()
        .frozen_observation()
        .unwrap()
        .0
}
async fn receive_unknown(attached: &mut Attached) {
    let error = attached.event().await;
    no_secret(&error);
    assert_eq!(error["error"]["outcome"], "unknown");
    no_secret(&attached.event().await);
    wait_http_idle(&attached.instance).await;
}

#[test]
fn byok_parser_only_accepts_small_typed_non_secret_selection() {
    let good = byok_raw("h");
    let parsed = protocol::parse_generation_start_owned(good.clone()).unwrap();
    assert_eq!(
        parsed.preset.unwrap().public_config()["modelId"],
        "deepseek-v4-flash"
    );
    for config in [
        Value::Null,
        json!({}),
        json!({"providerId":"system","modelId":"m"}),
        json!({"providerId":"deepseek","modelId":"__custom_model_id__"}),
        json!({"providerId":"deepseek","modelId":" \u{feff}__custom_model_id__ "}),
        json!({"providerId":"deepseek","modelId":"m","generationOverrides":null}),
        json!({"providerId":"deepseek","modelId":"m","generationOverrides":{"thinking":{"mode":"disabled","effort":"high"}}}),
    ] {
        let mut bad = good.clone();
        bad["request"]["presetConfig"] = config;
        assert!(protocol::parse_generation_start_owned(bad).is_err());
    }
    for field in [
        "apiKey",
        "secretRef",
        "url",
        "baseUrl",
        "headers",
        "customProvider",
        "profileId",
        "systemConfig",
    ] {
        for path in [
            "",
            "/request",
            "/request/presetConfig",
            "/request/request",
            "/request/request/generation",
        ] {
            let mut bad = good.clone();
            bad.pointer_mut(path).unwrap()[field] = json!("forbidden");
            assert!(
                protocol::parse_generation_start_owned(bad).is_err(),
                "{path}/{field}"
            );
        }
    }
    let mut huge = good;
    huge["request"]["presetConfig"]["generationOverrides"] =
        json!({"bad":vec![Value::Null; 100_001]});
    assert!(protocol::parse_generation_start_owned(huge).is_err());
}

#[tokio::test]
async fn byok_preflight_and_invalid_selection_read_no_provider_secret() {
    let store = store();
    let attached = setup_store("127.0.0.1:9".parse().unwrap(), store.clone());
    for bad in [
        json!({"providerId":"unknown","modelId":"m"}),
        json!({"providerId":"deepseek","modelId":"m","generationOverrides":{"temperature":-1}}),
    ] {
        let mut input = byok_raw(&attached.handle);
        input["request"]["presetConfig"] = bad;
        assert!(attached
            .instance
            .request_owned(attached.document, input)
            .is_err());
    }
    lock(&attached.instance.inner)
        .scope
        .as_mut()
        .unwrap()
        .session
        .as_mut()
        .unwrap()
        .self_role = "member".into();
    assert!(byok_start(&attached).is_err());
    assert!(store.reads.lock().unwrap().is_empty());
    attached.instance.destroyed();
}

#[tokio::test]
async fn byok_real_catalog_alias_outbound_and_public_summary_have_no_secret() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let store = store();
    let mut attached = setup_store(listener.local_addr().unwrap(), store.clone());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = request_body(&read_http(&mut stream).await);
        let provider = &request["request"]["generation"]["customProvider"];
        assert!(provider["apiKey"] == CANARY);
        assert_eq!(provider["providerId"], "deepseek");
        assert_eq!(provider["modelId"], "deepseek-v4-flash");
        assert_eq!(provider["generationOverrides"]["temperature"], 0.8);
        assert!(request["request"].get("presetConfig").is_none());
        send_http(&mut stream, 202, &receipt("running")).await;
    });
    byok_start(&attached).unwrap();
    let summary = pending(&attached.instance);
    no_secret(&summary);
    assert_eq!(
        summary["generationStart"]["presetConfig"]["modelId"],
        "deepseek-v4-flash"
    );
    let batch = attached.batch().await;
    no_secret(&batch);
    attached.ack(&batch).unwrap();
    wait_http_idle(&attached.instance).await;
    assert!(pending(&attached.instance).is_null());
    assert_eq!(
        store.reads.lock().unwrap().as_slice(),
        [REFERENCE, REFERENCE]
    );
    server.await.unwrap();
    attached.instance.destroyed();
}

#[tokio::test]
async fn byok_system_never_reads_provider_store_even_when_unavailable() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let store = store();
    store.fail.store(true, Ordering::SeqCst);
    let mut attached = setup_store(listener.local_addr().unwrap(), store.clone());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let value = request_body(&read_http(&mut stream).await);
        assert_eq!(value["request"], dto());
        stream.shutdown().await.unwrap();
    });
    start(&attached).unwrap();
    receive_unknown(&mut attached).await;
    assert!(store.reads.lock().unwrap().is_empty());
    assert!(pending(&attached.instance)["generationStart"]
        .get("presetConfig")
        .is_none());
    server.await.unwrap();
    attached.instance.destroyed();
}

#[tokio::test]
async fn byok_prepare_then_key_change_before_first_dispatch_sends_nothing() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let store = store();
    let mut attached = setup_store(listener.local_addr().unwrap(), store.clone());
    byok_start(&attached).unwrap(); // current-thread runtime: spawned task has not run
    store.set(REFERENCE, "replacement").unwrap();
    let event = attached.event().await;
    no_secret(&event);
    assert_eq!(event["error"]["outcome"], "not-applied");
    wait_http_idle(&attached.instance).await;
    assert!(pending(&attached.instance).is_null());
    assert!(
        tokio::time::timeout(Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
    attached.instance.destroyed();
}

#[tokio::test]
async fn byok_unknown_key_revocation_is_irreversible_and_never_refreezes() {
    for invalid in [
        None,
        Some(String::new()),
        Some("replacement".into()),
        Some(" ".repeat(8193)),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let store = store();
        let mut attached = setup_store(listener.local_addr().unwrap(), store.clone());
        byok_start(&attached).unwrap();
        let (mut stream, _) = listener.accept().await.unwrap();
        read_http(&mut stream).await;
        stream.shutdown().await.unwrap();
        receive_unknown(&mut attached).await;
        let weak = wire_weak(&attached);
        if let Some(key) = invalid {
            store.set(REFERENCE, &key).unwrap();
        } else {
            store.delete(REFERENCE).unwrap();
        }
        retry(&attached).unwrap();
        let event = attached.event().await;
        no_secret(&event);
        assert_eq!(event["error"]["code"], "scope-changed");
        no_secret(&attached.event().await);
        wait_http_idle(&attached.instance).await;
        assert!(weak.upgrade().is_none());
        assert_eq!(
            pending(&attached.instance)["generationStart"]["retryable"],
            false
        );
        store.set(REFERENCE, CANARY).unwrap();
        assert!(retry(&attached).is_err());
        assert_eq!(error_code(byok_start(&attached)), "busy");
        assert!(
            tokio::time::timeout(Duration::from_millis(30), listener.accept())
                .await
                .is_err()
        );
        no_secret(&end_tracking(&attached));
        assert!(lock(&attached.instance.inner).start_fence.is_some());
        attached.instance.destroyed();
    }
}

#[tokio::test]
async fn byok_unknown_storage_io_keeps_original_wire_scope_and_explicit_retry() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let store = store();
    let mut attached = setup_store(listener.local_addr().unwrap(), store.clone());
    byok_start(&attached).unwrap();
    let (mut stream, _) = listener.accept().await.unwrap();
    let first = request_body(&read_http(&mut stream).await);
    stream.shutdown().await.unwrap();
    receive_unknown(&mut attached).await;
    let weak = wire_weak(&attached);
    store.fail.store(true, Ordering::SeqCst);
    retry(&attached).unwrap();
    let event = attached.event().await;
    assert_eq!(event["error"]["code"], "storage-unavailable");
    no_secret(&event);
    no_secret(&attached.event().await);
    wait_http_idle(&attached.instance).await;
    assert!(weak.upgrade().is_some());
    assert_eq!(
        pending(&attached.instance)["generationStart"]["retryable"],
        true
    );
    assert!(lock(&attached.instance.inner).scope.is_some());
    assert!(
        tokio::time::timeout(Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
    store.fail.store(false, Ordering::SeqCst);
    retry(&attached).unwrap();
    let (mut stream, _) = listener.accept().await.unwrap();
    let second = request_body(&read_http(&mut stream).await);
    assert!(first == second, "retry must use the original wire");
    send_http(&mut stream, 202, &receipt("running")).await;
    let batch = attached.batch().await;
    no_secret(&batch);
    attached.ack(&batch).unwrap();
    wait_http_idle(&attached.instance).await;
    assert!(weak.upgrade().is_none());
    attached.instance.destroyed();
}

fn injected(input: Value, key: &str) -> Value {
    let store = SyntheticStore::default();
    store.set(REFERENCE, key).unwrap();
    let mut input = protocol::parse_generation_start_owned(input).unwrap();
    let (provider, _guard) = input.preset.take().unwrap().resolve(&store).unwrap();
    input.request["generation"]["customProvider"] = provider;
    input.request
}
#[test]
fn byok_final_dto_budget_counts_real_escaped_key_and_exact_boundary() {
    for key in [
        "x".repeat(8192),
        "\u{0001}".repeat(8192),
        "\\\"".repeat(4096),
        "中".repeat(2730),
        "😀".repeat(2048),
    ] {
        let mut value = byok_raw("h");
        value["request"]["request"]["generation"]["narrativeHistory"] = json!("");
        let base = serde_json::to_vec(&injected(value.clone(), &key))
            .unwrap()
            .len();
        value["request"]["request"]["generation"]["narrativeHistory"] =
            json!("a".repeat(protocol::MAX_START_ORIGINAL_REQUEST_BYTES - base));
        let request = injected(value.clone(), &key);
        assert_eq!(
            serde_json::to_vec(&request).unwrap().len(),
            protocol::MAX_START_ORIGINAL_REQUEST_BYTES
        );
        let wire = protocol::freeze_generation_start(request, 42).unwrap();
        assert!(wire.len() <= protocol::MAX_START_REQUEST_BYTES);
        let text = format!(
            "{}a",
            value["request"]["request"]["generation"]["narrativeHistory"]
                .as_str()
                .unwrap()
        );
        value["request"]["request"]["generation"]["narrativeHistory"] = json!(text);
        // Original without key fits; trusted injection must independently reject +1.
        let request = injected(value, &key);
        assert!(protocol::freeze_generation_start(request, 42).is_err());
    }
}

#[test]
fn byok_exact_total_node_budget_includes_injected_provider() {
    let mut input = byok_raw("h");
    input["request"]["request"] = dense_dto(false);
    let extra = json_nodes(&injected(byok_raw("h"), CANARY)) - json_nodes(&dto());
    let values = input["request"]["request"]["generation"]["questionnaires"]
        .as_array_mut()
        .unwrap();
    values.truncate(values.len() - extra);
    let request = injected(input.clone(), CANARY);
    assert_eq!(json_nodes(&request), protocol::MAX_START_JSON_NODES);
    assert!(protocol::freeze_generation_start(request, 42).is_ok());
    input["request"]["request"]["generation"]["questionnaires"]
        .as_array_mut()
        .unwrap()
        .push(Value::Null);
    let request = injected(input, CANARY);
    assert_eq!(json_nodes(&request), protocol::MAX_START_JSON_NODES + 1);
    assert_eq!(
        protocol::freeze_generation_start(request, 42)
            .unwrap_err()
            .code,
        "input-too-complex"
    );
}

#[tokio::test]
async fn byok_scope_retirement_drops_guard_wire_but_preserves_original_fence() {
    for change in ["host", "epoch", "document", "credential", "stop"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let store = store();
        let mut attached = setup_store(listener.local_addr().unwrap(), store.clone());
        byok_start(&attached).unwrap();
        let (mut stream, _) = listener.accept().await.unwrap();
        read_http(&mut stream).await;
        stream.shutdown().await.unwrap();
        receive_unknown(&mut attached).await;
        let weak = wire_weak(&attached);
        assert!(lock(&attached.instance.inner)
            .pending
            .as_ref()
            .unwrap()
            .start_basis
            .as_ref()
            .unwrap()
            .has_key_guard());
        match change {
            "host" | "epoch" => {
                let mut inner = lock(&attached.instance.inner);
                let authority = inner.scope.as_mut().unwrap().session.as_mut().unwrap();
                if change == "host" {
                    authority.self_role = "member".into();
                } else {
                    authority.room_epoch = "changed".into();
                }
                RoomInstance::observe_start_locked(&mut inner).unwrap();
                let basis = inner
                    .pending
                    .as_ref()
                    .unwrap()
                    .start_basis
                    .as_ref()
                    .unwrap();
                assert!(!basis.has_key_guard());
                assert!(basis.frozen_observation().is_none());
            }
            "document" => {
                attached.instance.page_started().unwrap();
            }
            "credential" => {
                let next = attach(attached.instance.clone(), synthetic_account(2).access, 2);
                no_secret(&next.attach_value);
                assert_eq!(next.attach_value["generationStartBlocked"], true);
            }
            "stop" => {
                no_secret(&end_tracking(&attached));
            }
            _ => unreachable!(),
        }
        assert!(weak.upgrade().is_none());
        assert_eq!(store.reads.lock().unwrap().len(), 2);
        assert!(byok_start(&attached).is_err());
        attached.instance.destroyed();
    }
}

#[tokio::test]
async fn byok_retirement_does_not_refund_original_physical_http_debt() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let attached = setup_store(listener.local_addr().unwrap(), store());
    byok_start(&attached).unwrap();
    let weak = wire_weak(&attached);
    for _ in 0..16 {
        assert_eq!(error_code(byok_start(&attached)), "busy");
    }
    attached.instance.page_started().unwrap();
    assert!(pending(&attached.instance).is_null());
    assert!(lock(&attached.instance.inner).start_fence.is_some());
    assert_eq!(attached.instance.http_slot.available_permits(), 0);
    assert!(weak.upgrade().is_some()); // original task still owns Arc and permit
    wait_http_idle(&attached.instance).await;
    assert!(weak.upgrade().is_none());
    assert!(
        tokio::time::timeout(Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
    attached.instance.destroyed();
}

#[tokio::test]
async fn byok_initial_missing_empty_oversized_or_io_is_not_applied_without_http() {
    for case in ["missing", "empty", "oversized", "trim-before-limit", "io"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let store = store();
        match case {
            "missing" => store.delete(REFERENCE).unwrap(),
            "empty" => store.set(REFERENCE, " \n").unwrap(),
            "oversized" => store.set(REFERENCE, &"x".repeat(8193)).unwrap(),
            "trim-before-limit" => store
                .set(REFERENCE, &format!(" {} ", "x".repeat(8191)))
                .unwrap(),
            "io" => store.fail.store(true, Ordering::SeqCst),
            _ => unreachable!(),
        }
        let attached = setup_store(listener.local_addr().unwrap(), store.clone());
        let error = match byok_start(&attached) {
            Err(error) => error,
            Ok(_) => panic!(),
        };
        assert_eq!(error.outcome, "not-applied");
        assert_eq!(
            error.code,
            if case == "io" {
                "storage-unavailable"
            } else {
                "invalid-request"
            }
        );
        no_secret(&serde_json::to_value(error).unwrap());
        assert!(pending(&attached.instance).is_null());
        assert_eq!(attached.instance.http_slot.available_permits(), 1);
        assert!(
            tokio::time::timeout(Duration::from_millis(30), listener.accept())
                .await
                .is_err()
        );
        attached.instance.destroyed();
    }
}

#[test]
fn byok_consumes_actual_typescript_action_and_exact_injected_golden_when_supplied() {
    let Some(directory) = std::env::var_os("MAHO_ROOM_BYOK_PRODUCER_DIR") else {
        return;
    };
    let directory = std::path::PathBuf::from(directory);
    let action: Value =
        serde_json::from_slice(&std::fs::read(directory.join("action.json")).unwrap()).unwrap();
    let parsed = protocol::parse_generation_start_owned(
        json!({"handle":"ts-producer", "request":action.clone()}),
    )
    .unwrap();
    let store = store();
    let (provider, _guard) = parsed.preset.unwrap().resolve(store.as_ref()).unwrap();
    assert_eq!(provider["modelId"], "deepseek-v4-flash");
    assert_eq!(
        provider["generationOverrides"],
        action["presetConfig"]["generationOverrides"]
    );

    let expected: Value =
        serde_json::from_slice(&std::fs::read(directory.join("injected-exact.json")).unwrap())
            .unwrap();
    assert_eq!(
        serde_json::to_vec(&expected).unwrap().len(),
        protocol::MAX_START_ORIGINAL_REQUEST_BYTES
    );
    let mut original = expected.clone();
    let provider = original["generation"]
        .as_object_mut()
        .unwrap()
        .remove("customProvider")
        .unwrap();
    assert_eq!(provider["apiKey"].as_str().unwrap().len(), 8192);
    store
        .set(REFERENCE, provider["apiKey"].as_str().unwrap())
        .unwrap();
    let mut action = action;
    action["request"] = original;
    let mut parsed =
        protocol::parse_generation_start_owned(json!({"handle":"ts-producer", "request":action}))
            .unwrap();
    let (native_provider, _guard) = parsed
        .preset
        .take()
        .unwrap()
        .resolve(store.as_ref())
        .unwrap();
    parsed.request["generation"]["customProvider"] = native_provider;
    assert!(
        parsed.request == expected,
        "actual TS and native injected DTO must match"
    );
    let wire = protocol::freeze_generation_start(parsed.request, 42).unwrap();
    assert!(wire.len() <= protocol::MAX_START_REQUEST_BYTES);
    assert_eq!(Arc::strong_count(&wire), 1);
    eprintln!(
        "room-byok-ts-golden injected_bytes={} frozen_wire_bytes={} key_raw_bound=8192",
        protocol::MAX_START_ORIGINAL_REQUEST_BYTES,
        wire.len()
    );
}

#[tokio::test]
async fn byok_same_document_reattach_serializes_full_escaped_identity_and_long_model() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let store = store();
    let mut attached = setup_store(listener.local_addr().unwrap(), store);
    let opaque = "\u{0001}".repeat(256);
    let generation_request_id = "r".repeat(128);
    let mut raw = byok_raw(&attached.handle);
    raw["request"]["roomId"] = json!(opaque);
    raw["request"]["request"]["expectedRoomEpoch"] = json!(opaque);
    raw["request"]["request"]["generationRequestId"] = json!(generation_request_id);
    raw["request"]["presetConfig"]["modelId"] = json!("中".repeat(200));
    raw["request"]["presetConfig"]["generationOverrides"] = json!({"maxOutputTokens":1000000,"temperature":0.12345678901234568,"thinking":{"mode":"enabled","effort":"minimal"}});
    {
        let mut inner = lock(&attached.instance.inner);
        let authority = inner.scope.as_mut().unwrap().session.as_mut().unwrap();
        authority.room_id = opaque.clone();
        authority.room_epoch = opaque.clone();
    }
    attached
        .instance
        .request_owned(attached.document, raw)
        .unwrap();
    let (mut stream, _) = listener.accept().await.unwrap();
    read_http(&mut stream).await;
    stream.shutdown().await.unwrap();
    receive_unknown(&mut attached).await;
    let mut message = snapshot();
    message["roomId"] = json!(opaque);
    message["roomEpoch"] = json!(opaque);
    message["payload"]["roomEpoch"] = json!(opaque);
    message["payload"]["roomId"] = json!(opaque);
    message["payload"]["sharedConfig"] = config();
    let mut generation = mirror("starting");
    generation["generationId"] = json!(opaque);
    generation["generationRequestId"] = json!(generation_request_id);
    message["payload"]["activeGeneration"] = generation;
    let context = lock(&attached.instance.inner)
        .scope
        .as_ref()
        .unwrap()
        .context
        .clone();
    attached
        .instance
        .process_socket(&context, &CancellationToken::new(), &message)
        .unwrap();
    attached.event().await;
    attached.event().await;
    let next = attach(attached.instance.clone(), synthetic_account(1).access, 2);
    assert!(next.document == attached.document);
    assert!(next.attach_value["pendingIntent"]["generationTarget"].is_object());
    assert_eq!(
        next.attach_value["pendingIntent"]["generationStart"]["presetConfig"]["modelId"]
            .as_str()
            .unwrap()
            .encode_utf16()
            .count(),
        200
    );
    no_secret(&next.attach_value);
    let encoded = protocol::encode_attach_response(&next.attach_value).unwrap();
    assert!(encoded.len() > 4096 && encoded.len() <= protocol::MAX_START_RECOVERY_RESPONSE_BYTES);
    eprintln!(
        "room-byok-attach escaped_identity_long_model_bytes={} bounded_cap={}",
        encoded.len(),
        protocol::MAX_START_RECOVERY_RESPONSE_BYTES
    );
    next.instance.destroyed();
}

#[test]
fn byok_attach_byte_gate_is_dedicated_and_exact() {
    for byok in [false, true] {
        let mut value = if byok {
            json!({"pendingIntent":{"operation":"generationStart","generationStart":{"presetConfig":selection()}},"pad":""})
        } else {
            json!({"pad":""})
        };
        let maximum = if byok {
            protocol::MAX_START_RECOVERY_RESPONSE_BYTES
        } else {
            1024
        };
        let base = serde_json::to_vec(&value).unwrap().len();
        value["pad"] = json!("x".repeat(maximum - base));
        assert_eq!(
            protocol::encode_attach_response(&value).unwrap().len(),
            maximum
        );
        value["pad"] = json!("x".repeat(maximum - base + 1));
        assert!(protocol::encode_attach_response(&value).is_err());
    }
}

#[test]
fn byok_complete_ipc_budget_counts_selection_before_normalizing_it() {
    let mut input = byok_raw("h");
    input["request"]["request"]["generation"]["narrativeHistory"] = json!("");
    let dto_base = serde_json::to_vec(&input["request"]["request"])
        .unwrap()
        .len();
    input["request"]["request"]["generation"]["narrativeHistory"] =
        json!("a".repeat(protocol::MAX_START_ORIGINAL_REQUEST_BYTES - dto_base));
    let current = serde_json::to_vec(&json!({"request":&input}))
        .unwrap()
        .len();
    let padding = protocol::MAX_START_IPC_REQUEST_BYTES - current;
    let model = input["request"]["presetConfig"]["modelId"]
        .as_str()
        .unwrap()
        .to_owned();
    input["request"]["presetConfig"]["modelId"] = json!(format!("{}{model}", " ".repeat(padding)));
    assert_eq!(
        serde_json::to_vec(&json!({"request":&input}))
            .unwrap()
            .len(),
        protocol::MAX_START_IPC_REQUEST_BYTES
    );
    assert!(protocol::parse_generation_start_owned(input.clone()).is_ok());
    input["request"]["presetConfig"]["modelId"] =
        json!(format!("{}{model}", " ".repeat(padding + 1)));
    assert!(protocol::parse_generation_start_owned(input).is_err());
}

#[tokio::test]
async fn byok_http_wire_byte_gate_is_inclusive_before_request_copy_or_send() {
    let http = RoomHttp::loopback("127.0.0.1:9".parse().unwrap());
    let cancel = CancellationToken::new();
    cancel.cancel();
    for extra in [0, 1] {
        // Isolate the transport byte gate: cancellation prevents any body clone/network use.
        let wire = Arc::new(vec![b' '; protocol::MAX_START_REQUEST_BYTES + extra]);
        let error = http
            .execute_generation_start(room(), &wire, 42, "synthetic-account", &cancel)
            .await
            .unwrap_err();
        assert_eq!(
            error.code,
            if extra == 0 {
                "scope-changed"
            } else {
                "invalid-request"
            }
        );
        assert_eq!(error.outcome, "not-applied");
        assert_eq!(Arc::strong_count(&wire), 1);
    }
}

#[test]
fn start_recovery_projection_limits_are_exact_and_do_not_expand_other_replies() {
    for kind in ["system-start", "byok-start", "fence", "ordinary", "cancel"] {
        let mut value = match kind {
            "system-start" => json!({"pendingIntent":{"operation":"generationStart"},"pad":""}),
            "byok-start" => {
                json!({"pendingIntent":{"operation":"generationStart","generationStart":{"presetConfig":selection()}},"pad":""})
            }
            "fence" => {
                json!({"pendingIntent":null,"generationStartFence":{"roomId":"r","generationRequestId":"id"},"pad":""})
            }
            "cancel" => {
                json!({"pendingIntent":{"operation":"generationCancel"},"generationStartFence":null,"pad":""})
            }
            _ => json!({"pendingIntent":null,"generationStartFence":null,"pad":""}),
        };
        let maximum = if matches!(kind, "ordinary" | "cancel") {
            1024
        } else {
            protocol::MAX_START_RECOVERY_RESPONSE_BYTES
        };
        let base = serde_json::to_vec(&value).unwrap().len();
        value["pad"] = json!("x".repeat(maximum - base));
        assert_eq!(
            protocol::encode_attach_response(&value).unwrap().len(),
            maximum
        );
        value["pad"] = json!("x".repeat(maximum - base + 1));
        assert!(protocol::encode_attach_response(&value).is_err());
    }
    let mut ended = json!({"kind":"generation-start-tracking-ended","intentId":"id","ended":true,"generationStartBlocked":true,"generationStartFence":{},"pad":""});
    let base = serde_json::to_vec(&ended).unwrap().len();
    ended["pad"] = json!("x".repeat(protocol::MAX_START_RECOVERY_RESPONSE_BYTES - base));
    assert_eq!(
        protocol::encode_start_tracking_ended_response(&ended)
            .unwrap()
            .len(),
        protocol::MAX_START_RECOVERY_RESPONSE_BYTES
    );
    ended["pad"] = json!("x".repeat(protocol::MAX_START_RECOVERY_RESPONSE_BYTES - base + 1));
    assert!(protocol::encode_start_tracking_ended_response(&ended).is_err());
}

#[tokio::test]
async fn start_long_room_recovery_stop_lobby_reattach_and_late_ack_keep_exact_fence_debt() {
    for byok in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut attached = setup_store(listener.local_addr().unwrap(), store());
        let opaque = "\u{0001}".repeat(256);
        let mut input = if byok {
            byok_raw(&attached.handle)
        } else {
            raw(&attached.handle)
        };
        input["request"]["roomId"] = json!(opaque);
        input["request"]["request"]["expectedRoomEpoch"] = json!(opaque);
        input["request"]["request"]["generationRequestId"] = json!("r".repeat(128));
        {
            let mut inner = lock(&attached.instance.inner);
            let authority = inner.scope.as_mut().unwrap().session.as_mut().unwrap();
            authority.room_id = opaque.clone();
            authority.room_epoch = opaque.clone();
        }
        attached
            .instance
            .request_owned(attached.document, input)
            .unwrap();
        let (mut stream, _) = listener.accept().await.unwrap();
        read_http(&mut stream).await;
        stream.shutdown().await.unwrap();
        let old_batch = attached.batch().await; // deliberately keep the original delivery debt
        assert_eq!(old_batch["event"]["error"]["outcome"], "unknown");
        no_secret(&old_batch);
        wait_http_idle(&attached.instance).await;
        let debt = lock(&attached.instance.inner)
            .delivery
            .delivered_unacked_bytes();
        assert!(debt > 0);
        let weak = wire_weak(&attached);
        let recovered = attach(attached.instance.clone(), synthetic_account(1).access, 2);
        assert!(recovered.document == attached.document);
        assert_eq!(
            recovered.attach_value["pendingIntent"]["operation"],
            "generationStart"
        );
        let pending_encoded = protocol::encode_attach_response(&recovered.attach_value).unwrap();
        assert!(
            pending_encoded.len() > 1024
                && pending_encoded.len() <= protocol::MAX_START_RECOVERY_RESPONSE_BYTES
        );
        no_secret(&recovered.attach_value);
        let ended = end_tracking(&recovered);
        assert!(serde_json::to_vec(&ended).unwrap().len() > 1024);
        assert_eq!(ended["generationStartFence"]["roomId"], opaque);
        no_secret(&ended);
        assert!(weak.upgrade().is_none());
        assert_eq!(
            lock(&attached.instance.inner)
                .delivery
                .delivered_unacked_bytes(),
            debt
        );
        recovered
            .instance
            .detach(recovered.document, &recovered.handle)
            .unwrap();
        let mut lobby = attach(attached.instance.clone(), synthetic_account(1).access, 3);
        assert!(lobby.document == attached.document);
        assert!(lobby.attach_value["pendingIntent"].is_null());
        assert_eq!(lobby.attach_value["generationStartBlocked"], true);
        assert_eq!(
            lobby.attach_value["generationStartFence"],
            ended["generationStartFence"]
        );
        let encoded = protocol::encode_attach_response(&lobby.attach_value).unwrap();
        assert!(
            encoded.len() > 1024 && encoded.len() < protocol::MAX_START_RECOVERY_RESPONSE_BYTES
        );
        no_secret(&lobby.attach_value);
        assert_eq!(
            lock(&attached.instance.inner)
                .delivery
                .delivered_unacked_bytes(),
            debt
        );
        // An old ACK releases only the originally handed-out bytes, not the current fence.
        attached.ack(&old_batch).unwrap();
        assert_eq!(
            lock(&attached.instance.inner)
                .delivery
                .delivered_unacked_bytes(),
            0
        );
        assert!(lock(&attached.instance.inner).start_fence.is_some());
        assert_eq!(error_code(start(&lobby)), "busy");
        // The fence cannot strand the user in a room: ordinary lobby discovery remains usable.
        lobby.request(http_action(Operation::Discover)).unwrap();
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = read_http(&mut stream).await;
        assert!(request.starts_with(b"GET "));
        send_http(&mut stream, 200, &fixture(Operation::Discover, "success")).await;
        assert_eq!(lobby.event().await["operation"], "discover");
        wait_http_idle(&lobby.instance).await;
        assert!(lock(&attached.instance.inner).start_fence.is_some());
        eprintln!("room-start-recovery byok={byok} pending_attach_bytes={} ended_bytes={} fence_attach_bytes={} old_delivery_debt_released_only_by_old_ack=true", pending_encoded.len(), serde_json::to_vec(&ended).unwrap().len(), encoded.len());
        lobby.instance.destroyed();
    }
}
