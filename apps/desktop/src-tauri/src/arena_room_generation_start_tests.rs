use super::*;

fn config() -> Value {
    let mut value =
        fixture(Operation::Session, "success")["result"]["snapshot"]["sharedConfig"].clone();
    value["battleMode"] = json!("daily");
    value["combatants"].as_array_mut().unwrap().truncate(1);
    value["teams"] = json!([]);
    value
}
fn dto() -> Value {
    json!({"expectedRoomEpoch":epoch(),"expectedRevision":7,"expectedControlSeq":24,"generationRequestId":"generation-request-1",
        "sharedConfig":config(),"hostLocalPayloads":[],"generation":{"narrativeHistory":[{"text":"完整原文😀"}]}})
}
fn raw(handle: &str) -> Value {
    json!({"handle":handle,"request":{"kind":"generation-start","roomId":room(),"request":dto()}})
}
fn start(attached: &Attached) -> Result<EngineReply, RoomError> {
    attached
        .instance
        .request_owned(attached.document, raw(&attached.handle))
}
fn seed(instance: &RoomInstance) {
    let mut session = fixture(Operation::Session, "success")["result"].clone();
    session["snapshot"]["sharedConfig"] = config();
    let mut a = Authority::from_session(&session).unwrap();
    a.snapshot_seen = true;
    a.presence_seen = true;
    a.online.insert(a.self_id.clone());
    let mut inner = lock(&instance.inner);
    let scope = inner.scope.as_mut().unwrap();
    scope.session = Some(a);
    scope.socket_cancel = Some(CancellationToken::new());
}
fn setup(address: std::net::SocketAddr) -> Attached {
    let attached = attach(make_instance(address, None), synthetic_account(1).access, 1);
    seed(&attached.instance);
    attached
}
fn mirror(state: &str) -> Value {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/desktop-room-generation-read.json"
    ))
    .unwrap();
    let mut value = fixture["operation"]["success"]["result"]["generation"].clone();
    value["state"] = json!(state);
    value["configRevision"] = json!(7);
    value["hostAccountUserId"] = json!(42);
    if !generation_read::terminal(&value["state"]) {
        value.as_object_mut().unwrap().remove("finishedAt");
    }
    value
}
fn receipt(state: &str) -> Value {
    json!({"desktopRoom":{"version":protocol::PROTOCOL_VERSION,"viewerUserId":42},"result":{"protocolVersion":1,"roomId":room(),"roomEpoch":epoch(),"generation":mirror(state),"status":if state == "starting" { "reserved" } else { state }}})
}
fn pending(instance: &RoomInstance) -> Value {
    lock(&instance.inner)
        .pending
        .as_ref()
        .map(PendingIntent::public)
        .unwrap_or(Value::Null)
}
fn retry(attached: &Attached) -> Result<EngineReply, RoomError> {
    attached.request(Action::RetryGenerationStart {
        intent_id: pending(&attached.instance)["intentId"]
            .as_str()
            .unwrap()
            .into(),
    })
}
fn socket(attached: &Attached, generation: Value) -> Result<bool, RoomError> {
    let mut message = snapshot();
    message["payload"]["sharedConfig"] = config();
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
}
async fn unknown() -> Attached {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut attached = setup(listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_http(&mut stream).await;
        stream.shutdown().await.unwrap();
    });
    start(&attached).unwrap();
    assert_eq!(attached.event().await["error"]["outcome"], "unknown");
    assert_eq!(attached.event().await["kind"], "mutation-unknown");
    wait_http_idle(&attached.instance).await;
    server.await.unwrap();
    attached
}

#[test]
fn start_owned_protocol_preserves_runtime_and_rejects_provider_overrides() {
    let good = raw("handle");
    let input = protocol::parse_generation_start_owned(good.clone()).unwrap();
    assert_eq!(input.request, dto());
    assert!(protocol::parse_request(&good).is_err());
    for field in [
        "systemConfig",
        "presetConfig",
        "customProvider",
        "modelId",
        "overrides",
        "endpoint",
        "apiKey",
    ] {
        for target in [
            "/request",
            "/request/request",
            "/request/request/generation",
        ] {
            let mut bad = good.clone();
            bad.pointer_mut(target).unwrap()[field] = json!({"secret":"never-send"});
            assert!(
                protocol::parse_generation_start_owned(bad).is_err(),
                "{target}/{field}"
            );
        }
    }
    for field in [
        "request",
        "systemConfig",
        "generationRequestId",
        "expectedRoomEpoch",
        "roomId",
    ] {
        let mut retry = json!({"handle":"handle","request":{"kind":"retry-generation-start","intentId":"intent"}});
        retry["request"][field] = json!("override");
        assert!(protocol::parse_request(&retry).is_err());
    }
    assert!(protocol::parse_request(
        &json!({"handle":"handle","request":{"kind":"retry-generation-start","intentId":"intent"}})
    )
    .is_ok());
}

#[test]
fn start_complete_utf8_dto_budget_and_safe_json_fences() {
    for unit in ["a", "中", "😀", "\n", "\u{0001}"] {
        let mut request = dto();
        request["generation"]["narrativeHistory"] = json!("");
        let base = serde_json::to_vec(&request).unwrap().len();
        let unit_bytes = serde_json::to_vec(&json!(unit)).unwrap().len() - 2;
        let space = protocol::MAX_START_ORIGINAL_REQUEST_BYTES - base;
        request["generation"]["narrativeHistory"] = json!(format!(
            "{}{}",
            unit.repeat(space / unit_bytes),
            "a".repeat(space % unit_bytes)
        ));
        assert_eq!(
            serde_json::to_vec(&request).unwrap().len(),
            protocol::MAX_START_ORIGINAL_REQUEST_BYTES
        );
        let input = json!({"handle":"handle","request":{"kind":"generation-start","roomId":room(),"request":request}});
        let parsed = protocol::parse_generation_start_owned(input).unwrap();
        let mut too_big = parsed.request.clone();
        let extra = format!(
            "{}a",
            too_big["generation"]["narrativeHistory"].as_str().unwrap()
        );
        too_big["generation"]["narrativeHistory"] = json!(extra);
        assert!(protocol::parse_generation_start_owned(json!({"handle":"handle","request":{"kind":"generation-start","roomId":room(),"request":too_big}})).is_err());
        let wire = protocol::freeze_generation_start(parsed.request, 42).unwrap();
        assert!(wire.len() <= protocol::MAX_START_REQUEST_BYTES);
        assert_eq!(Arc::strong_count(&wire), 1);
    }
    for bad in [json!({"constructor":true}), json!(9_007_199_254_740_992u64)] {
        let mut input = raw("handle");
        input["request"]["request"]["generation"]["narrativeHistory"] = bad;
        assert!(protocol::parse_generation_start_owned(input).is_err());
    }
    let mut nested = json!({});
    for _ in 0..66 {
        nested = json!({"child":nested});
    }
    let mut input = raw("handle");
    input["request"]["request"]["generation"]["narrativeHistory"] = nested;
    assert!(protocol::parse_generation_start_owned(input).is_err());
    assert!(serde_json::from_str::<Value>("{\"text\":\"\\ud800\"}").is_err());
}

#[test]
fn start_202_only_small_closed_receipt() {
    for state in ["starting", "running", "completed", "failed", "cancelled"] {
        let good = serde_json::to_vec(&receipt(state)).unwrap();
        assert!(
            protocol::validate_http_response(Operation::GenerationStart, 202, &good, 42).is_ok()
        );
        for status in [200, 201, 204] {
            assert_eq!(
                protocol::validate_http_response(Operation::GenerationStart, status, &good, 42)
                    .unwrap_err()
                    .outcome,
                "unknown"
            );
        }
    }
    for pointer in ["", "/desktopRoom", "/result", "/result/generation"] {
        let mut bad = receipt("starting");
        bad.pointer_mut(pointer).unwrap()["unexpected"] = json!(true);
        assert!(protocol::validate_http_response(
            Operation::GenerationStart,
            202,
            &serde_json::to_vec(&bad).unwrap(),
            42
        )
        .is_err());
    }
    for (pointer, value) in [
        ("/desktopRoom/viewerUserId", json!(43)),
        ("/desktopRoom/version", json!("old")),
        ("/result/status", json!("completed")),
    ] {
        let mut bad = receipt("starting");
        *bad.pointer_mut(pointer).unwrap() = value;
        assert!(protocol::validate_http_response(
            Operation::GenerationStart,
            202,
            &serde_json::to_vec(&bad).unwrap(),
            42
        )
        .is_err());
    }
    assert_eq!(
        protocol::validate_http_response(
            Operation::GenerationStart,
            202,
            &vec![b' '; protocol::MAX_RESPONSE_BYTES + 1],
            42
        )
        .unwrap_err()
        .outcome,
        "unknown"
    );
}

#[tokio::test]
async fn start_requires_current_live_host_exact_tuple_and_readiness() {
    for case in [
        "offline", "snapshot", "presence", "fresh", "member", "removed", "epoch", "revision",
        "control", "digest", "active",
    ] {
        let attached = setup("127.0.0.1:9".parse().unwrap());
        {
            let mut inner = lock(&attached.instance.inner);
            let a = inner.scope.as_mut().unwrap().session.as_mut().unwrap();
            match case {
                "offline" => a.online.clear(),
                "snapshot" => a.snapshot_seen = false,
                "presence" => a.presence_seen = false,
                "fresh" => a.generation_fresh = false,
                "member" => a.self_role = "member".into(),
                "removed" => a.members.get_mut(&a.self_id).unwrap().1 = "revoked".into(),
                "epoch" => a.room_epoch = "next".into(),
                "revision" => a.revision += 1,
                "control" => a.control_seq += 1,
                "digest" => a.config_digest = None,
                "active" => a.generation = Some(mirror("running")),
                _ => unreachable!(),
            }
        }
        assert!(start(&attached).is_err(), "{case}");
        assert!(pending(&attached.instance).is_null());
        assert_eq!(attached.instance.http_slot.available_permits(), 1);
        attached.instance.destroyed();
    }
    for case in ["empty", "classic-one", "scenario-none", "missing-local"] {
        let attached = setup("127.0.0.1:9".parse().unwrap());
        let mut input = raw(&attached.handle);
        let c = &mut input["request"]["request"]["sharedConfig"];
        match case {
            "empty" => c["combatants"] = json!([]),
            "classic-one" => c["battleMode"] = json!("classic"),
            "scenario-none" => {
                c["battleMode"] = json!("scenario");
                c["scenario"] = Value::Null;
            }
            "missing-local" => {
                c["combatants"] = json!([{"key":"host-local:one","type":"magical-girl","displayName":"One","source":"host-local","contentVersion":format!("sha256:{}","a".repeat(64))}])
            }
            _ => unreachable!(),
        }
        lock(&attached.instance.inner)
            .scope
            .as_mut()
            .unwrap()
            .session
            .as_mut()
            .unwrap()
            .config_digest = Some(exact_config_digest(c));
        assert!(
            attached
                .instance
                .request_owned(attached.document, input)
                .is_err(),
            "{case}"
        );
        attached.instance.destroyed();
    }
}

#[tokio::test]
async fn start_receipt_ack_settles_without_fabricating_authority_or_losing_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut attached = setup(listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = read_http(&mut stream).await;
        assert!(String::from_utf8_lossy(&request).starts_with(&format!(
            "POST /api/arena/rooms/v1/{}/generations HTTP/1.1\r\n",
            room()
        )));
        assert_eq!(
            request_body(&request),
            json!({"desktopRoom":{"version":protocol::PROTOCOL_VERSION,"expectedUserId":42},"request":dto()})
        );
        send_http(&mut stream, 202, &receipt("running")).await;
    });
    let id = accepted_id(start(&attached).unwrap());
    let batch = attached.batch().await;
    assert_eq!(batch["event"]["operation"], "generationStart");
    assert_eq!(pending(&attached.instance)["intentId"], id);
    {
        let inner = lock(&attached.instance.inner);
        let scope = inner.scope.as_ref().unwrap();
        let a = scope.session.as_ref().unwrap();
        assert!(a.snapshot_seen && a.presence_seen && a.generation.is_none());
        assert_eq!(a.control_seq, 24);
        assert!(!scope.socket_cancel.as_ref().unwrap().is_cancelled());
    }
    let EngineReply::Small(ack) = attached.ack(&batch).unwrap() else {
        panic!()
    };
    assert_eq!(
        ack["generationStart"],
        json!({"intentId":id,"current":true})
    );
    assert!(pending(&attached.instance).is_null());
    wait_http_idle(&attached.instance).await;
    server.await.unwrap();
    attached.instance.destroyed();
}

#[tokio::test]
async fn start_response_loss_retry_uses_exact_wire_and_not_applied_preserves_original_unknown() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut attached = setup(listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut first, _) = listener.accept().await.unwrap();
        let original = request_body(&read_http(&mut first).await);
        first.shutdown().await.unwrap();
        let (mut second, _) = listener.accept().await.unwrap();
        assert_eq!(request_body(&read_http(&mut second).await), original);
        send_http(&mut second,409,&json!({"desktopRoom":{"version":protocol::PROTOCOL_VERSION,"viewerUserId":42},"error":{"code":"ROOM_CONFLICT","message":"safe","outcome":"not-applied"}})).await;
    });
    let id = accepted_id(start(&attached).unwrap());
    assert_eq!(attached.event().await["error"]["outcome"], "unknown");
    attached.event().await;
    wait_http_idle(&attached.instance).await;
    assert_eq!(
        pending(&attached.instance)["generationStart"]["retryable"],
        true
    );
    assert_ne!(accepted_id(retry(&attached).unwrap()), id);
    assert_eq!(attached.event().await["error"]["outcome"], "not-applied");
    attached.event().await;
    wait_http_idle(&attached.instance).await;
    assert_eq!(pending(&attached.instance)["intentId"], id);
    assert_eq!(
        pending(&attached.instance)["generationStart"]["retryable"],
        true
    );
    assert_eq!(error_code(start(&attached)), "busy");
    server.await.unwrap();
    attached.instance.destroyed();
}

#[tokio::test]
async fn start_first_checked_not_applied_clears_but_malformed_202_remains_unknown() {
    for status in [409, 200] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut attached = setup(listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_http(&mut stream).await;
            let body = if status == 409 {
                json!({"desktopRoom":{"version":protocol::PROTOCOL_VERSION,"viewerUserId":42},"error":{"code":"ROOM_CONFLICT","message":"safe","outcome":"not-applied"}})
            } else {
                receipt("starting")
            };
            send_http(&mut stream, status, &body).await;
        });
        start(&attached).unwrap();
        let event = attached.event().await;
        assert_eq!(
            event["error"]["outcome"],
            if status == 409 {
                "not-applied"
            } else {
                "unknown"
            }
        );
        if status == 200 {
            attached.event().await;
        }
        wait_http_idle(&attached.instance).await;
        assert_eq!(pending(&attached.instance).is_null(), status == 409);
        server.await.unwrap();
        attached.instance.destroyed();
    }
}

#[tokio::test]
async fn start_unknown_empty_and_wrong_request_session_never_unlocks() {
    for generation in [Value::Null, {
        let mut g = mirror("running");
        g["generationRequestId"] = json!("other-request");
        g
    }] {
        let mut attached = unknown().await;
        let id = pending(&attached.instance)["intentId"].clone();
        socket(&attached, generation).unwrap();
        let batch = attached.batch().await;
        let EngineReply::Small(ack) = attached.ack(&batch).unwrap() else {
            panic!()
        };
        assert!(ack.get("generationStart").is_none());
        assert_eq!(pending(&attached.instance)["intentId"], id);
        assert_eq!(error_code(start(&attached)), "busy");
        attached.instance.destroyed();
    }
}

#[tokio::test]
async fn start_matching_authority_requires_exact_ack_and_full_identity_is_frozen() {
    let mut attached = unknown().await;
    let id = pending(&attached.instance)["intentId"].clone();
    socket(&attached, mirror("running")).unwrap();
    let batch = attached.batch().await;
    for field in [
        "snapshotDigest",
        "configRevision",
        "participantUserIds",
        "hostAccountUserId",
        "generationId",
        "attempt",
    ] {
        let mut bad = mirror("running");
        bad[field] = match field {
            "configRevision" => json!(8),
            "participantUserIds" => json!([42, 43]),
            "hostAccountUserId" => json!(43),
            "attempt" => json!(2),
            _ => json!("other"),
        };
        assert!(socket(&attached, bad).is_err(), "{field}");
    }
    assert_eq!(pending(&attached.instance)["intentId"], id);
    let EngineReply::Small(ack) = attached.ack(&batch).unwrap() else {
        panic!()
    };
    assert_eq!(
        ack["generationStart"],
        json!({"intentId":id,"current":true})
    );
    assert!(pending(&attached.instance).is_null());
    attached.instance.destroyed();
}

#[tokio::test]
async fn start_single_physical_slot_survives_retire_and_repeated_admission() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let attached = setup(listener.local_addr().unwrap());
    start(&attached).unwrap();
    assert_eq!(attached.instance.http_slot.available_permits(), 0);
    for _ in 0..16 {
        assert_eq!(error_code(start(&attached)), "busy");
    }
    attached
        .instance
        .detach(attached.document, &attached.handle)
        .unwrap();
    assert_eq!(attached.instance.http_slot.available_permits(), 0);
    let replacement = attach(attached.instance.clone(), synthetic_account(1).access, 2);
    seed(&replacement.instance);
    for _ in 0..16 {
        assert_eq!(error_code(start(&replacement)), "busy");
    }
    wait_http_idle(&replacement.instance).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
    replacement.instance.destroyed();
}

#[tokio::test]
async fn start_document_and_credential_epoch_retire_wire_without_clearing_unknown_fence() {
    for change in ["document", "credential"] {
        let attached = unknown().await;
        let id = pending(&attached.instance)["intentId"].clone();
        if change == "document" {
            attached.instance.page_started().unwrap();
            attached.instance.page_finished().unwrap();
        }
        let replacement = attach(
            attached.instance.clone(),
            synthetic_account(if change == "credential" { 2 } else { 1 }).access,
            2,
        );
        seed(&replacement.instance);
        assert!(pending(&replacement.instance).is_null());
        assert_eq!(replacement.attach_value["generationStartBlocked"], true);
        assert_eq!(
            replacement.attach_value["generationStartFence"]["roomId"],
            room()
        );
        assert!(replacement
            .request(Action::RetryGenerationStart {
                intent_id: id.as_str().unwrap().into()
            })
            .is_err());
        assert_eq!(error_code(start(&replacement)), "busy");
        replacement.instance.destroyed();
    }
}

#[tokio::test]
async fn start_unknown_host_or_epoch_change_disables_retry() {
    for change in ["epoch", "host"] {
        let attached = unknown().await;
        {
            let mut inner = lock(&attached.instance.inner);
            let a = inner.scope.as_mut().unwrap().session.as_mut().unwrap();
            if change == "epoch" {
                a.room_epoch = "next".into();
            } else {
                a.self_role = "member".into();
            }
            RoomInstance::observe_start_locked(&mut inner).unwrap();
        }
        assert_eq!(
            pending(&attached.instance)["generationStart"]["retryable"],
            false
        );
        assert!(retry(&attached).is_err());
        assert_eq!(error_code(start(&attached)), "busy");
        attached.instance.destroyed();
    }
}

#[tokio::test]
async fn start_dispatch_rechecks_authority_before_first_network_poll() {
    for change in ["control", "revision", "host", "document"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let attached = setup(listener.local_addr().unwrap());
        start(&attached).unwrap();
        if change == "document" {
            attached.instance.page_started().unwrap();
        } else {
            let mut inner = lock(&attached.instance.inner);
            let a = inner.scope.as_mut().unwrap().session.as_mut().unwrap();
            match change {
                "control" => a.control_seq += 1,
                "revision" => a.revision += 1,
                "host" => a.self_role = "member".into(),
                _ => unreachable!(),
            }
        }
        wait_http_idle(&attached.instance).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(30), listener.accept())
                .await
                .is_err()
        );
        attached.instance.destroyed();
    }
}

#[tokio::test]
async fn start_reserved_receipt_keeps_wire_until_current_not_found_explicit_retry() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut attached = setup(listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut first, _) = listener.accept().await.unwrap();
        let original = request_body(&read_http(&mut first).await);
        send_http(&mut first, 202, &receipt("starting")).await;
        let (mut get, _) = listener.accept().await.unwrap();
        let request = read_http(&mut get).await;
        assert!(String::from_utf8_lossy(&request).starts_with("GET "));
        send_http(&mut get,404,&json!({"desktopRoom":{"version":protocol::PROTOCOL_VERSION,"viewerUserId":42},"error":{"code":"ROOM_NOT_FOUND","message":"not found","outcome":"not-applicable"}})).await;
        let (mut retry, _) = listener.accept().await.unwrap();
        assert_eq!(request_body(&read_http(&mut retry).await), original);
        send_http(&mut retry, 202, &receipt("running")).await;
    });
    let id = accepted_id(start(&attached).unwrap());
    let batch = attached.batch().await;
    let EngineReply::Small(ack) = attached.ack(&batch).unwrap() else {
        panic!()
    };
    assert!(ack.get("generationStart").is_none());
    assert_eq!(
        attached.event().await["generationStart"]["retryable"],
        false
    );
    wait_http_idle(&attached.instance).await;
    assert_eq!(pending(&attached.instance)["intentId"], id);
    assert!(retry(&attached).is_err());
    socket(&attached, mirror("starting")).unwrap();
    attached.event().await;
    attached.event().await;
    attached
        .request(Action::GenerationRead {
            generation_id: "generation-1".into(),
            expected_room_epoch: epoch().into(),
            expected_attempt: 1,
        })
        .unwrap();
    assert_eq!(attached.event().await["kind"], "request-error");
    assert_eq!(attached.event().await["generationStart"]["retryable"], true);
    wait_http_idle(&attached.instance).await;
    assert_ne!(accepted_id(retry(&attached).unwrap()), id);
    let batch = attached.batch().await;
    let EngineReply::Small(ack) = attached.ack(&batch).unwrap() else {
        panic!()
    };
    assert_eq!(
        ack["generationStart"],
        json!({"intentId":id,"current":true})
    );
    wait_http_idle(&attached.instance).await;
    assert!(pending(&attached.instance).is_null());
    server.await.unwrap();
    attached.instance.destroyed();
}

#[tokio::test]
async fn start_frozen_buffer_and_physical_permit_observation_survives_retirement() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let attached = setup(listener.local_addr().unwrap());
    let mut input = raw(&attached.handle);
    input["request"]["request"]["generation"]["narrativeHistory"] =
        json!("a".repeat(protocol::MAX_START_ORIGINAL_REQUEST_BYTES - 4096));
    attached
        .instance
        .request_owned(attached.document, input)
        .unwrap();
    let (weak, bytes, references) = {
        let inner = lock(&attached.instance.inner);
        let pending = inner.pending.as_ref().unwrap();
        assert!(pending.frozen_request.is_null());
        pending
            .start_basis
            .as_ref()
            .unwrap()
            .frozen_observation()
            .unwrap()
    };
    assert_eq!(references, 2);
    assert!(bytes <= protocol::MAX_START_REQUEST_BYTES);
    assert_eq!(attached.instance.http_slot.available_permits(), 0);
    eprintln!("start-resource accepted frozen_buffers=1 frozen_bytes={bytes} frozen_references={references} physical_permits=1 serialized_wire_buffers=1");
    attached.instance.page_started().unwrap();
    assert_eq!(weak.strong_count(), 1);
    assert_eq!(attached.instance.http_slot.available_permits(), 0);
    assert!(pending(&attached.instance).is_null());
    assert!(lock(&attached.instance.inner).start_fence.is_some());
    eprintln!("start-resource retired frozen_buffers=1 frozen_bytes={bytes} pending_references=0 in_flight_references=1 physical_permits=1");
    wait_http_idle(&attached.instance).await;
    assert_eq!(weak.strong_count(), 0);
    assert!(weak.upgrade().is_none());
    eprintln!("start-resource settled frozen_buffers=0 frozen_bytes=0 physical_permits=0");
    attached.instance.destroyed();
}

fn json_nodes(value: &Value) -> usize {
    1 + match value {
        Value::Array(values) => values.iter().map(json_nodes).sum::<usize>(),
        Value::Object(values) => values.values().map(json_nodes).sum::<usize>(),
        _ => 0,
    }
}
fn dense_dto(object: bool) -> Value {
    let mut value = dto();
    for index in 0..10 {
        let payload = if object {
            Value::Object(
                (0..8999)
                    .map(|i| (format!("key{i}"), json!("😀")))
                    .collect(),
            )
        } else {
            json!({"items":vec![json!("中");8998]})
        };
        value["hostLocalPayloads"].as_array_mut().unwrap().push(
            json!({"key":format!("host-local:dense-{index}"),"kind":"material","payload":payload}),
        );
    }
    let remaining = protocol::MAX_START_JSON_NODES - json_nodes(&value);
    value["generation"]["questionnaires"] = json!(vec![Value::Null; remaining - 1]);
    assert_eq!(json_nodes(&value), protocol::MAX_START_JSON_NODES);
    value
}
#[test]
fn start_dense_small_nodes_preserve_owned_request_without_node_stack_amplification() {
    for object in [false, true] {
        let mut input = raw("h");
        input["request"]["request"] = dense_dto(object);
        let parsed = protocol::parse_generation_start_owned(input).unwrap();
        assert_eq!(json_nodes(&parsed.request), 100_000);
        let wire = protocol::freeze_generation_start(parsed.request, 42).unwrap();
        assert_eq!(Arc::strong_count(&wire), 1);
        eprintln!("start-resource bounded_total_nodes=100000 object_dense={object} frozen_buffers=1 frozen_bytes={}",wire.len());
    }
}
#[test]
fn start_total_and_per_value_nodes_exact_boundary_without_truncation() {
    let mut dto = dense_dto(false);
    dto["generation"]["questionnaires"]
        .as_array_mut()
        .unwrap()
        .push(Value::Null);
    assert_eq!(json_nodes(&dto), 100_001);
    assert!(protocol::parse_generation_start_owned(json!({"handle":"h","request":{"kind":"generation-start","roomId":room(),"request":dto.clone()}})).is_err());
    assert!(protocol::freeze_generation_start(dto, 42).is_err());
    for field in [
        "narrativeHistory",
        "adjudicationEvents",
        "questionnaireSelections",
        "questionnaires",
    ] {
        let mut raw = raw("h");
        raw["request"]["request"]["generation"][field] = json!(vec![0; 9999]);
        assert!(protocol::parse_generation_start_owned(raw.clone()).is_ok());
        raw["request"]["request"]["generation"][field]
            .as_array_mut()
            .unwrap()
            .push(json!(0));
        assert!(protocol::parse_generation_start_owned(raw).is_err());
    }
    let mut raw = raw("h");
    raw["request"]["request"]["hostLocalPayloads"] = json!([{"key":"host-local:node-boundary","kind":"material","payload":{"items":vec![0;9998]}}]);
    assert!(protocol::parse_generation_start_owned(raw.clone()).is_ok());
    raw["request"]["request"]["hostLocalPayloads"][0]["payload"]["items"]
        .as_array_mut()
        .unwrap()
        .push(json!(0));
    assert!(protocol::parse_generation_start_owned(raw).is_err());
}

#[tokio::test]
async fn start_session_absence_and_other_request_cannot_settle_or_drop_socket() {
    for generation in [Value::Null, {
        let mut g = mirror("running");
        g["generationRequestId"] = json!("other-request");
        g
    }] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut attached = setup(listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.unwrap();
            read_http(&mut first).await;
            first.shutdown().await.unwrap();
            let (mut second, _) = listener.accept().await.unwrap();
            assert!(String::from_utf8_lossy(&read_http(&mut second).await).starts_with("GET "));
            let mut response = fixture(Operation::Session, "success");
            response["result"]["snapshot"]["sharedConfig"] = config();
            response["result"]["snapshot"]["activeGeneration"] = generation;
            send_http(&mut second, 200, &response).await;
        });
        start(&attached).unwrap();
        attached.event().await;
        attached.event().await;
        wait_http_idle(&attached.instance).await;
        let id = pending(&attached.instance)["intentId"].clone();
        attached.request(session_action()).unwrap();
        assert_eq!(attached.event().await["operation"], "session");
        attached.event().await;
        wait_http_idle(&attached.instance).await;
        assert_eq!(pending(&attached.instance)["intentId"], id);
        assert_eq!(error_code(start(&attached)), "busy");
        assert!(!lock(&attached.instance.inner)
            .scope
            .as_ref()
            .unwrap()
            .socket_cancel
            .as_ref()
            .unwrap()
            .is_cancelled());
        {
            let inner = lock(&attached.instance.inner);
            let a = inner.scope.as_ref().unwrap().session.as_ref().unwrap();
            assert!(a.snapshot_seen && a.presence_seen && a.online.contains(&a.self_id));
        }

        server.await.unwrap();
        attached.instance.destroyed();
    }
}

#[tokio::test]
async fn start_matching_wss_ack_wins_late_unknown_and_retired_ack_cannot_settle() {
    for retire in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut attached = setup(listener.local_addr().unwrap());
        let (release, wait) = oneshot::channel();
        let (sent, ready) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_http(&mut stream).await;
            sent.send(()).unwrap();
            wait.await.unwrap();
            stream.shutdown().await.unwrap();
        });
        start(&attached).unwrap();
        ready.await.unwrap();
        socket(&attached, mirror("running")).unwrap();
        let batch = attached.batch().await;
        if retire {
            attached
                .instance
                .detach(attached.document, &attached.handle)
                .unwrap();
        }
        let EngineReply::Small(ack) = attached.ack(&batch).unwrap() else {
            panic!()
        };
        if retire {
            assert!(ack.get("generationStart").is_none());
            assert!(!pending(&attached.instance).is_null());
        } else {
            assert_eq!(ack["generationStart"]["current"], true);
            assert!(pending(&attached.instance).is_null());
        }
        release.send(()).unwrap();
        wait_http_idle(&attached.instance).await;
        assert_eq!(pending(&attached.instance).is_null(), !retire);
        server.await.unwrap();
        attached.instance.destroyed();
    }
}

#[tokio::test]
async fn start_unknown_temporary_credential_io_does_not_delete_frozen_material() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let account = synthetic_account(1);
    let mut attached = attach(
        make_instance(listener.local_addr().unwrap(), None),
        account.access.clone(),
        1,
    );
    seed(&attached.instance);
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_http(&mut stream).await;
        stream.shutdown().await.unwrap();
    });
    start(&attached).unwrap();
    attached.event().await;
    attached.event().await;
    wait_http_idle(&attached.instance).await;
    account.io_error.store(true, Ordering::SeqCst);
    assert_eq!(error_code(retry(&attached)), "storage-unavailable");
    assert_eq!(account.clears.load(Ordering::SeqCst), 0);
    assert!(lock(&attached.instance.inner)
        .pending
        .as_ref()
        .unwrap()
        .start_basis
        .as_ref()
        .unwrap()
        .frozen_observation()
        .is_some());
    account.io_error.store(false, Ordering::SeqCst);
    assert_eq!(
        pending(&attached.instance)["generationStart"]["retryable"],
        true
    );
    server.await.unwrap();
    attached.instance.destroyed();
}

#[tokio::test]
async fn start_current_starting_unavailable_never_enables_retry() {
    let mut attached = unknown().await;
    socket(&attached, mirror("starting")).unwrap();
    attached.event().await;
    attached.event().await;
    let target = crate::arena_room_generation::GenerationReadTarget {
        room_id: room().into(),
        room_epoch: epoch().into(),
        generation_id: "generation-1".into(),
        attempt: 1,
    };
    {
        let mut inner = lock(&attached.instance.inner);
        RoomInstance::start_read_not_found(
            &mut inner,
            &target,
            &RoomError::new("service-rejected", "not-applicable")
                .with_server_code("ROOM_UNAVAILABLE"),
        );
    }
    assert_eq!(
        pending(&attached.instance)["generationStart"]["retryable"],
        false
    );
    assert!(retry(&attached).is_err());
    attached.instance.destroyed();
}

#[test]
fn start_consumes_shared_typescript_golden_action_wire_and_receipt() {
    let golden: Value = serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/desktop-room-generation-start.json"
    ))
    .unwrap();
    let input = protocol::parse_generation_start_owned(
        json!({"handle":"golden-handle","request":golden["action"]}),
    )
    .unwrap();
    assert_eq!(input.request, golden["operation"]["request"]["request"]);
    let wire = protocol::freeze_generation_start(input.request, 42).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&wire).unwrap(),
        golden["operation"]["request"]
    );
    assert_eq!(
        protocol::validate_http_response(
            Operation::GenerationStart,
            202,
            &serde_json::to_vec(&golden["operation"]["success"]).unwrap(),
            42
        )
        .unwrap(),
        golden["operation"]["success"]
    );
}

#[tokio::test]
async fn start_revoked_snapshot_destroys_wire_even_when_authority_install_is_rejected() {
    let attached = unknown().await;
    let mut message = snapshot();
    message["payload"]["sharedConfig"] = config();
    message["payload"]["members"][0]["membershipState"] = json!("revoked");
    let context = lock(&attached.instance.inner)
        .scope
        .as_ref()
        .unwrap()
        .context
        .clone();
    assert!(attached
        .instance
        .process_socket(&context, &CancellationToken::new(), &message)
        .is_err());
    let inner = lock(&attached.instance.inner);
    assert!(inner
        .pending
        .as_ref()
        .unwrap()
        .start_basis
        .as_ref()
        .unwrap()
        .frozen_observation()
        .is_none());
    drop(inner);
    assert_eq!(
        pending(&attached.instance)["generationStart"]["retryable"],
        false
    );
    assert!(retry(&attached).is_err());
    attached.instance.destroyed();
}

#[tokio::test]
async fn start_raw_credential_change_before_retry_discards_wire_without_resigning() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let account = synthetic_account(1);
    let mut attached = attach(
        make_instance(listener.local_addr().unwrap(), None),
        account.access.clone(),
        1,
    );
    seed(&attached.instance);
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_http(&mut stream).await;
        stream.shutdown().await.unwrap();
    });
    start(&attached).unwrap();
    attached.event().await;
    attached.event().await;
    wait_http_idle(&attached.instance).await;
    account.actual_epoch.store(2, Ordering::SeqCst);
    assert_eq!(error_code(retry(&attached)), "scope-changed");
    assert!(pending(&attached.instance).is_null());
    assert!(lock(&attached.instance.inner).start_fence.is_some());
    assert_eq!(account.clears.load(Ordering::SeqCst), 0);
    server.await.unwrap();
    attached.instance.destroyed();
}

fn end_tracking(attached: &Attached) -> Value {
    let id = pending(&attached.instance)["intentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let EngineReply::Json(result) = attached
        .request(Action::EndGenerationStartTracking { intent_id: id })
        .unwrap()
    else {
        panic!()
    };
    serde_json::from_str(&result).unwrap()
}
fn other_owner(epoch: u64) -> Arc<AccountAccess> {
    Arc::new(AccountAccess::new(
        43,
        epoch,
        CancellationToken::new(),
        "synthetic-second-owner".into(),
        Arc::new(|| Ok(true)),
        Arc::new(|| Ok(true)),
    ))
}
#[test]
fn start_end_tracking_is_closed_intent_only_protocol() {
    assert!(matches!(protocol::parse_request(&json!({"handle":"h","request":{"kind":"end-generation-start-tracking","intentId":"id"}})).unwrap().action, Action::EndGenerationStartTracking { .. }));
    for key in ["request", "roomId", "cancelServer", "forgetFence"] {
        let mut value = json!({"handle":"h","request":{"kind":"end-generation-start-tracking","intentId":"id"}});
        value["request"][key] = json!(true);
        assert!(protocol::parse_request(&value).is_err());
    }
}
#[tokio::test]
async fn start_end_drops_retry_material_and_keeps_owner_scoped_single_slot() {
    let attached = unknown().await;
    let id = pending(&attached.instance)["intentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let weak = lock(&attached.instance.inner)
        .pending
        .as_ref()
        .unwrap()
        .start_basis
        .as_ref()
        .unwrap()
        .frozen_observation()
        .unwrap()
        .0;
    let result = end_tracking(&attached);
    assert_eq!(result["generationStartBlocked"], true);
    assert_eq!(
        result["generationStartFence"],
        json!({"roomId":room(),"generationRequestId":"generation-request-1"})
    );
    assert!(pending(&attached.instance).is_null());
    assert!(weak.upgrade().is_none());
    assert!(lock(&attached.instance.inner)
        .scope
        .as_ref()
        .unwrap()
        .socket_cancel
        .as_ref()
        .is_some_and(|c| !c.is_cancelled()));
    assert!(attached
        .request(Action::RetryGenerationStart { intent_id: id })
        .is_err());
    assert_eq!(error_code(start(&attached)), "busy");
    let next = attach(attached.instance.clone(), other_owner(2), 2);
    assert!(next.attach_value["pendingIntent"].is_null());
    assert_eq!(next.attach_value["generationStartBlocked"], true);
    assert!(next.attach_value["generationStartFence"].is_null());
    assert!(!next
        .attach_value
        .to_string()
        .contains("generation-request-1"));
    assert_eq!(error_code(start(&next)), "busy");
    next.instance.destroyed();
}
#[tokio::test]
async fn start_fence_only_blocks_start_not_discover_session_join_create_leave_close() {
    for operation in [
        Operation::Discover,
        Operation::Session,
        Operation::Join,
        Operation::Create,
        Operation::Leave,
        Operation::Close,
    ] {
        let attached = unknown().await;
        end_tracking(&attached);
        let next = attach(attached.instance.clone(), synthetic_account(1).access, 2);
        seed(&next.instance);
        assert!(
            next.request(http_action(operation)).is_ok(),
            "{} was blocked by start fence",
            operation.as_str()
        );
        next.instance.destroyed();
        wait_http_idle(&next.instance).await;
    }
}
#[tokio::test]
async fn start_fence_requires_current_owner_exact_generation_and_ack() {
    for wrong in [
        "owner", "epoch", "request", "tuple", "starting", "empty", "none",
    ] {
        let attached = unknown().await;
        // Establish original full tuple without settling the starting reservation.
        socket(&attached, mirror("starting")).unwrap();
        end_tracking(&attached);
        let account = if wrong == "owner" {
            other_owner(2)
        } else {
            synthetic_account(1).access
        };
        let mut next = attach(attached.instance.clone(), account, 2);
        seed(&next.instance);
        let mut generation = mirror("running");
        match wrong {
            "epoch" => {
                lock(&next.instance.inner)
                    .scope
                    .as_mut()
                    .unwrap()
                    .session
                    .as_mut()
                    .unwrap()
                    .room_epoch = "next-epoch".into();
            }
            "request" => generation["generationRequestId"] = json!("another-request"),
            "tuple" => generation["snapshotDigest"] = json!("another-snapshot"),
            "starting" => generation = mirror("starting"),
            "empty" => generation = Value::Null,
            _ => {}
        }
        // Use a fully checked snapshot in the current room epoch, not an unauthenticated hint.
        let mut message = snapshot();
        message["payload"]["sharedConfig"] = config();
        message["payload"]["activeGeneration"] = generation;
        if wrong == "epoch" {
            message["roomEpoch"] = json!("next-epoch");
            message["payload"]["roomEpoch"] = json!("next-epoch");
        }
        let context = lock(&next.instance.inner)
            .scope
            .as_ref()
            .unwrap()
            .context
            .clone();
        next.instance
            .process_socket(&context, &CancellationToken::new(), &message)
            .unwrap();
        let batch = next.batch().await;
        assert!(lock(&next.instance.inner).start_fence.is_some());
        let EngineReply::Small(ack) = next.ack(&batch).unwrap() else {
            panic!()
        };
        if wrong == "none" {
            assert_eq!(ack["generationStartFence"]["cleared"], true);
            assert!(lock(&next.instance.inner).start_fence.is_none());
        } else {
            assert!(ack.get("generationStartFence").is_none());
            assert!(lock(&next.instance.inner).start_fence.is_some());
        }
        next.instance.destroyed();
    }
}
#[tokio::test]
async fn start_fence_retired_ack_cannot_clear_or_expose_to_another_owner() {
    let attached = unknown().await;
    end_tracking(&attached);
    let mut owner = attach(attached.instance.clone(), synthetic_account(1).access, 2);
    seed(&owner.instance);
    socket(&owner, mirror("running")).unwrap();
    let batch = owner.batch().await;
    let other = attach(owner.instance.clone(), other_owner(2), 3);
    let EngineReply::Small(ack) = owner.ack(&batch).unwrap() else {
        panic!()
    };
    assert!(ack.get("generationStartFence").is_none());
    assert!(!ack.to_string().contains("generation-request-1"));
    assert!(lock(&other.instance.inner).start_fence.is_some());
    assert!(other.attach_value["generationStartFence"].is_null());
    other.instance.destroyed();
}
#[tokio::test]
async fn start_fence_close_requires_exact_closed_outcome_current_ack() {
    for outcome in ["left", "closed"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut attached = setup(listener.local_addr().unwrap());
        let response = json!({"desktopRoom":{"version":protocol::PROTOCOL_VERSION,"viewerUserId":42},"result":{"protocolVersion":1,"roomId":room(),"outcome":outcome}});
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_http(&mut stream).await;
            stream.shutdown().await.unwrap();
            let (mut stream, _) = listener.accept().await.unwrap();
            read_http(&mut stream).await;
            send_http(&mut stream, 200, &response).await;
        });
        start(&attached).unwrap();
        attached.event().await;
        attached.event().await;
        wait_http_idle(&attached.instance).await;
        end_tracking(&attached);
        // Even an epoch change does not bypass the fence; a real Close of that room may end it.
        lock(&attached.instance.inner)
            .scope
            .as_mut()
            .unwrap()
            .session
            .as_mut()
            .unwrap()
            .room_epoch = "next-epoch".into();
        attached
            .request(Action::Close {
                room_id: room().into(),
                expected_room_epoch: "next-epoch".into(),
            })
            .unwrap();
        let batch = attached.batch().await;
        assert!(lock(&attached.instance.inner).start_fence.is_some());
        let EngineReply::Small(ack) = attached.ack(&batch).unwrap() else {
            panic!()
        };
        assert_eq!(
            ack.get("generationStartFence").is_some(),
            outcome == "closed"
        );
        assert_eq!(
            lock(&attached.instance.inner).start_fence.is_none(),
            outcome == "closed"
        );
        server.await.unwrap();
        attached.instance.destroyed();
    }
}

#[test]
fn start_rejects_downgrade_and_free_ranking_execution_overrides() {
    for field in ["isDowngrade", "arenaFreeRankingEnabled"] {
        let mut value = raw("h");
        value["request"]["request"]["generation"][field] = json!(true);
        assert!(protocol::parse_generation_start_owned(value.clone()).is_err());
        value["request"]["request"]["generation"][field] = json!(false);
        assert!(protocol::parse_generation_start_owned(value).is_ok());
    }
}

#[test]
fn start_consumes_actual_api_serializer_wire_when_supplied() {
    let Some(directory) = std::env::var_os("MAHO_ROOM_CONFIG_PRODUCER_DIR") else {
        return;
    };
    let directory = std::path::PathBuf::from(directory);
    let request: Value = serde_json::from_slice(
        &std::fs::read(directory.join("generationStart.request.json")).unwrap(),
    )
    .unwrap();
    let input = protocol::parse_generation_start_owned(json!({"handle":"producer-handle","request":{"kind":"generation-start","roomId":room(),"request":request["request"]}})).unwrap();
    let frozen = protocol::freeze_generation_start(input.request, 42).unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&frozen).unwrap(), request);
    for (file, status) in [
        ("generationStart.response.json", 202),
        ("generationStart.error.json", 429),
    ] {
        protocol::validate_http_response(
            Operation::GenerationStart,
            status,
            &std::fs::read(directory.join(file)).unwrap(),
            42,
        )
        .unwrap();
    }
}

#[tokio::test]
async fn start_account_cancel_auto_retires_pending_without_retaining_its_account() {
    let attached = unknown().await;
    let (account, weak) = {
        let inner = lock(&attached.instance.inner);
        let account = inner.pending.as_ref().unwrap().account.clone();
        let weak = Arc::downgrade(&account);
        (account, weak)
    };
    account.cancel.cancel();
    tokio::time::timeout(Duration::from_secs(1), async {
        while lock(&attached.instance.inner).pending.is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(lock(&attached.instance.inner).start_fence.is_some());
    drop(account);
    tokio::time::timeout(Duration::from_secs(1), async {
        while weak.strong_count() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    attached.instance.destroyed();
}
#[tokio::test]
async fn start_fence_exact_session_ack_reconciles_new_document_without_replaying() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut original = setup(listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_http(&mut stream).await;
        stream.shutdown().await.unwrap();
        let (mut stream, _) = listener.accept().await.unwrap();
        let raw = read_http(&mut stream).await;
        assert!(raw.starts_with(b"GET "));
        let mut response = fixture(Operation::Session, "success");
        response["result"]["snapshot"]["sharedConfig"] = config();
        response["result"]["snapshot"]["activeGeneration"] = mirror("completed");
        send_http(&mut stream, 200, &response).await;
    });
    start(&original).unwrap();
    original.event().await;
    original.event().await;
    wait_http_idle(&original.instance).await;
    original.instance.page_started().unwrap();
    original.instance.page_finished().unwrap();
    let mut next = attach(original.instance.clone(), synthetic_account(1).access, 2);
    assert!(next.attach_value["pendingIntent"].is_null());
    next.request(session_action()).unwrap();
    let batch = next.batch().await;
    assert!(lock(&next.instance.inner).start_fence.is_some());
    let EngineReply::Small(ack) = next.ack(&batch).unwrap() else {
        panic!()
    };
    assert_eq!(ack["generationStartFence"]["cleared"], true);
    assert!(lock(&next.instance.inner).start_fence.is_none());
    server.await.unwrap();
    next.instance.destroyed();
}
#[tokio::test]
async fn start_fence_duplicate_old_ack_does_not_settle_a_later_start() {
    let mut attached = unknown().await;
    end_tracking(&attached);
    socket(&attached, mirror("running")).unwrap();
    let batch = attached.batch().await;
    attached.ack(&batch).unwrap();
    seed(&attached.instance);
    start(&attached).unwrap();
    let new_id = pending(&attached.instance)["intentId"].clone();
    let _ = attached.ack(&batch);
    assert_eq!(pending(&attached.instance)["intentId"], new_id);
    assert_eq!(attached.instance.http_slot.available_permits(), 0);
    attached.instance.destroyed();
    wait_http_idle(&attached.instance).await;
}

#[test]
fn start_complexity_failure_is_small_stable_and_not_applied() {
    let mut value = raw("h");
    value["request"]["request"]["generation"]["questionnaires"] =
        json!(vec!["sensitive-canary"; 10000]);
    let error = match protocol::parse_generation_start_owned(value) {
        Err(error) => error,
        Ok(_) => panic!(),
    };
    assert_eq!(error.code, "input-too-complex");
    assert_eq!(error.outcome, "not-applied");
    assert!(!serde_json::to_string(&error)
        .unwrap()
        .contains("sensitive-canary"));
}

#[test]
fn start_combined_exact_byte_and_node_limits_keep_one_owned_wire() {
    let mut dto = dense_dto(false);
    dto["generation"]["narrativeHistory"][0]["text"] = json!("");
    let base = serde_json::to_vec(&dto).unwrap().len();
    dto["generation"]["narrativeHistory"][0]["text"] =
        json!("a".repeat(protocol::MAX_START_ORIGINAL_REQUEST_BYTES - base));
    assert_eq!(json_nodes(&dto), protocol::MAX_START_JSON_NODES);
    assert_eq!(
        serde_json::to_vec(&dto).unwrap().len(),
        protocol::MAX_START_ORIGINAL_REQUEST_BYTES
    );
    let mut input = raw("combined-limit");
    input["request"]["request"] = dto;
    let parsed = protocol::parse_generation_start_owned(input).unwrap();
    let wire = protocol::freeze_generation_start(parsed.request, 42).unwrap();
    assert_eq!(Arc::strong_count(&wire), 1);
    assert!(wire.len() <= protocol::MAX_START_REQUEST_BYTES);
    eprintln!("start-resource combined original_dto_bytes={} total_nodes={} frozen_buffers=1 frozen_bytes={} send_copy_bound_bytes={} initial_tauri_parse_rss=unclaimed",protocol::MAX_START_ORIGINAL_REQUEST_BYTES,protocol::MAX_START_JSON_NODES,wire.len(),wire.len());
    assert_eq!(
        RoomError::new("input-too-large", "not-applied").code,
        "input-too-large"
    );
}

mod byok_tests {
    include!("arena_room_generation_byok_tests.rs");
}

mod starting_cancel_tests {
    include!("arena_room_starting_cancel_tests.rs");
}
