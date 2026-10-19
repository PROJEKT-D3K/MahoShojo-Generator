use super::*;

fn cancel_start(attached: &Attached, original: &str) -> Result<EngineReply, RoomError> {
    attached.request(Action::CancelGenerationStart {
        intent_id: original.into(),
    })
}
async fn ready() -> (Attached, TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut attached = setup(listener.local_addr().unwrap());
    start(&attached).unwrap();
    let (mut stream, _) = listener.accept().await.unwrap();
    read_http(&mut stream).await;
    stream.shutdown().await.unwrap();
    attached.event().await;
    attached.event().await;
    wait_http_idle(&attached.instance).await;
    let id = pending(&attached.instance)["intentId"]
        .as_str()
        .unwrap()
        .to_owned();
    socket(&attached, mirror("starting")).unwrap();
    assert_eq!(attached.event().await["kind"], "socket");
    assert_eq!(attached.event().await["kind"], "mutation-unknown");
    (attached, listener, id)
}
async fn unknown_cancel() -> (Attached, String, String) {
    let (mut attached, listener, original) = ready().await;
    let id = accepted_id(cancel_start(&attached, &original).unwrap());
    let (mut stream, _) = listener.accept().await.unwrap();
    let body = request_body(&read_http(&mut stream).await);
    assert_eq!(body["desktopRoom"]["cancelMode"], "starting-v1");
    assert_eq!(
        body["request"]["expectedGeneration"]["generationRequestId"],
        "generation-request-1"
    );
    assert!(body["request"]["expectedGeneration"].get("state").is_none());
    stream.shutdown().await.unwrap();
    assert_eq!(attached.event().await["error"]["outcome"], "unknown");
    let unknown = attached.event().await;
    assert_eq!(unknown["cancelMode"], "starting-v1");
    assert_eq!(unknown["startIntentId"], original);
    wait_http_idle(&attached.instance).await;
    (attached, original, id)
}

#[test]
fn starting_cancel_protocol_fixture_and_strict_body_are_shared() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/desktop-room-starting-cancel.json"
    ))
    .unwrap();
    let raw = json!({"handle":"h","request":fixture["action"]});
    assert!(matches!(
        protocol::parse_request(&raw).unwrap().action,
        Action::CancelGenerationStart { .. }
    ));
    for field in ["request", "roomId", "generationId", "apiKey", "cancelMode"] {
        let mut bad = raw.clone();
        bad["request"][field] = json!("x");
        assert!(protocol::parse_request(&bad).is_err());
    }
    let wire = &fixture["operation"]["request"];
    assert_eq!(
        &protocol::validate_service_request(Operation::GenerationCancel, wire, 42).unwrap(),
        wire
    );
    for field in ["state", "startedAt", "gate", "token", "digest"] {
        let mut bad = wire.clone();
        bad["request"]["expectedGeneration"][field] = json!("x");
        assert!(protocol::validate_service_request(Operation::GenerationCancel, &bad, 42).is_err());
    }
    let mut bad = wire.clone();
    bad["desktopRoom"]
        .as_object_mut()
        .unwrap()
        .remove("cancelMode");
    assert!(protocol::validate_service_request(Operation::GenerationCancel, &bad, 42).is_err());
    let mut bad = wire.clone();
    bad["desktopRoom"]["cancelMode"] = json!("legacy");
    assert!(protocol::validate_service_request(Operation::GenerationCancel, &bad, 42).is_err());
    assert!(protocol::validate_service_request(Operation::GenerationCancel, wire, 43).is_err());
    assert!(protocol::validate_service_request(Operation::Close, wire, 42).is_err());
}

#[tokio::test]
async fn starting_cancel_handoff_is_once_irreversible_and_retains_socket() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/desktop-room-starting-cancel.json"
    ))
    .unwrap();
    // Use the golden identity unchanged, including its absent optional host ID.
    let mut generation = fixture["operation"]["success"]["result"]["generation"].clone();
    generation["state"] = json!("starting");
    generation.as_object_mut().unwrap().remove("finishedAt");
    let revision = generation["configRevision"].as_u64().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut attached = setup(listener.local_addr().unwrap());
    lock(&attached.instance.inner)
        .scope
        .as_mut()
        .unwrap()
        .session
        .as_mut()
        .unwrap()
        .revision = revision;
    let mut input = raw(&attached.handle);
    input["request"]["request"]["expectedRevision"] = json!(revision);
    attached
        .instance
        .request_owned(attached.document, input)
        .unwrap();
    let (mut stream, _) = listener.accept().await.unwrap();
    read_http(&mut stream).await;
    stream.shutdown().await.unwrap();
    attached.event().await;
    attached.event().await;
    wait_http_idle(&attached.instance).await;
    let original = pending(&attached.instance)["intentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut message = snapshot();
    message["payload"]["revision"] = json!(revision);
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
        .unwrap();
    assert_eq!(attached.event().await["kind"], "socket");
    assert_eq!(attached.event().await["kind"], "mutation-unknown");
    let wire = lock(&attached.instance.inner)
        .pending
        .as_ref()
        .unwrap()
        .start_basis
        .as_ref()
        .unwrap()
        .frozen_observation()
        .unwrap()
        .0;
    let socket = lock(&attached.instance.inner)
        .scope
        .as_ref()
        .unwrap()
        .socket_cancel
        .clone()
        .unwrap();
    let id = accepted_id(cancel_start(&attached, &original).unwrap());
    assert_ne!(id, original);
    assert!(wire.upgrade().is_none());
    assert!(!socket.is_cancelled());
    {
        let inner = lock(&attached.instance.inner);
        assert!(RoomInstance::linked_start_cancel(&inner, &id));
        assert!(inner.pending.as_ref().unwrap().start_basis.is_none());
        assert!(inner.pending.as_ref().unwrap().frozen_request.is_null());
    }
    assert!(cancel_start(&attached, &original).is_err());
    assert!(attached
        .request(Action::RetryGenerationStart {
            intent_id: original.clone()
        })
        .is_err());
    let (mut stream, _) = listener.accept().await.unwrap();
    let raw = read_http(&mut stream).await;
    assert!(String::from_utf8_lossy(&raw).starts_with(
        "POST /api/arena/rooms/v1/room_01JARENAEXAMPLE/generations/generation-1/cancel "
    ));
    assert_eq!(request_body(&raw), fixture["operation"]["request"]);
    send_http(&mut stream, 400, &json!({"desktopRoom":{"version":protocol::PROTOCOL_VERSION,"viewerUserId":42},"error":{"code":"ROOM_INVALID_REQUEST","message":"unsupported","outcome":"not-applied"}})).await;
    assert_eq!(attached.event().await["error"]["outcome"], "unknown");
    attached.event().await;
    wait_http_idle(&attached.instance).await;
    assert_eq!(pending(&attached.instance)["cancelMode"], "starting-v1");
    assert!(attached
        .request(Action::RetryGenerationStart {
            intent_id: original.clone()
        })
        .is_err());
    assert!(cancel_start(&attached, &original).is_err());
    assert!(
        tokio::time::timeout(Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
    attached.instance.destroyed();
}

#[tokio::test]
async fn starting_cancel_requires_original_matching_live_start_and_real_permit() {
    for failure in [
        "no-mirror",
        "wrong-request",
        "wrong-identity",
        "running",
        "host",
        "offline",
        "epoch",
        "intent",
        "permit",
    ] {
        let (attached, _listener, original) = ready().await;
        let held = if failure == "permit" {
            Some(
                attached
                    .instance
                    .http_slot
                    .clone()
                    .try_acquire_owned()
                    .unwrap(),
            )
        } else {
            None
        };
        {
            let mut inner = lock(&attached.instance.inner);
            let a = inner.scope.as_mut().unwrap().session.as_mut().unwrap();
            match failure {
                "no-mirror" => a.generation = None,
                "wrong-request" => {
                    a.generation.as_mut().unwrap()["generationRequestId"] =
                        json!("different-request")
                }
                "wrong-identity" => {
                    a.generation.as_mut().unwrap()["snapshotDigest"] = json!("different")
                }
                "running" => a.generation.as_mut().unwrap()["state"] = json!("running"),
                "host" => a.self_role = "member".into(),
                "offline" => a.online.clear(),
                "epoch" => a.room_epoch = "different".into(),
                _ => {}
            }
        }
        assert!(
            cancel_start(
                &attached,
                if failure == "intent" {
                    "wrong"
                } else {
                    &original
                }
            )
            .is_err(),
            "{failure}"
        );
        assert_eq!(
            pending(&attached.instance)["operation"],
            "generationStart",
            "{failure}"
        );
        assert!(lock(&attached.instance.inner)
            .pending
            .as_ref()
            .unwrap()
            .start_basis
            .as_ref()
            .unwrap()
            .frozen_observation()
            .is_some());
        assert!(lock(&attached.instance.inner).start_fence.is_none());
        drop(held);
        attached.instance.destroyed();
    }
}

#[tokio::test]
async fn starting_cancel_running_and_old_ack_never_clear_but_terminal_ack_clears_both() {
    let (mut attached, _original, id) = unknown_cancel().await;
    socket(&attached, mirror("running")).unwrap();
    let running = attached.batch().await;
    let EngineReply::Small(ack) = attached.ack(&running).unwrap() else {
        panic!()
    };
    assert!(ack.get("generationCancel").is_none());
    assert!(lock(&attached.instance.inner).start_fence.is_some());
    socket(&attached, mirror("cancelled")).unwrap();
    let terminal = attached.batch().await;
    attached.ack(&running).unwrap();
    assert!(RoomInstance::linked_start_cancel(
        &lock(&attached.instance.inner),
        &id
    ));
    let EngineReply::Small(ack) = attached.ack(&terminal).unwrap() else {
        panic!()
    };
    assert_eq!(
        ack["generationCancel"],
        json!({"intentId":id,"current":true})
    );
    assert!(ack.get("generationStartFence").is_none());
    assert!(lock(&attached.instance.inner).pending.is_none());
    assert!(lock(&attached.instance.inner).start_fence.is_none());
    attached.instance.destroyed();
}

#[tokio::test]
async fn starting_cancel_end_and_document_retirement_keep_owner_fence_and_drop_access() {
    for retire in ["end", "document", "account"] {
        let (attached, _original, id) = unknown_cancel().await;
        let old_account = Arc::downgrade(
            &lock(&attached.instance.inner)
                .pending
                .as_ref()
                .unwrap()
                .account,
        );
        match retire {
            "end" => {
                let EngineReply::Json(raw) = attached
                    .request(Action::EndGenerationStartTracking {
                        intent_id: id.clone(),
                    })
                    .unwrap()
                else {
                    panic!()
                };
                let ended: Value = serde_json::from_str(&raw).unwrap();
                assert_eq!(ended["generationStartFence"]["cancelIntentId"], id);
            }
            "document" => {
                attached.instance.page_started().unwrap();
                attached.instance.page_finished().unwrap();
            }
            _ => {
                lock(&attached.instance.inner)
                    .pending
                    .as_ref()
                    .unwrap()
                    .account
                    .cancel
                    .cancel();
                tokio::task::yield_now().await;
            }
        }
        for _ in 0..20 {
            if old_account.upgrade().is_none() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(lock(&attached.instance.inner).pending.is_none(), "{retire}");
        assert!(
            lock(&attached.instance.inner).start_fence.is_some(),
            "{retire}"
        );
        assert!(old_account.upgrade().is_none(), "{retire}");
        let other = attach(attached.instance.clone(), other_owner(2), 2);
        assert_eq!(other.attach_value["generationStartBlocked"], true);
        assert!(other.attach_value["generationStartFence"].is_null());
        assert!(cancel_start(&other, &id).is_err());
        let mut owner = attach(attached.instance.clone(), synthetic_account(3).access, 3);
        seed(&owner.instance);
        socket(&owner, mirror("running")).unwrap();
        owner.event().await;
        assert!(lock(&owner.instance.inner).start_fence.is_some());
        socket(&owner, mirror("cancelled")).unwrap();
        let batch = owner.batch().await;
        let EngineReply::Small(ack) = owner.ack(&batch).unwrap() else {
            panic!()
        };
        assert_eq!(
            ack["generationCancel"],
            json!({"intentId":id,"current":true})
        );
        assert!(ack.get("generationStartFence").is_none());
        assert!(lock(&owner.instance.inner).start_fence.is_none());
        owner.instance.destroyed();
    }
}

#[tokio::test]
async fn starting_cancel_terminal_read_final_ack_clears_linked_records() {
    let (mut attached, listener, original) = ready().await;
    let id = accepted_id(cancel_start(&attached, &original).unwrap());
    let (mut stream, _) = listener.accept().await.unwrap();
    read_http(&mut stream).await;
    send_http(&mut stream, 200, &receipt("running")).await;
    attached.event().await;
    attached.event().await;
    wait_http_idle(&attached.instance).await;
    attached
        .request(Action::GenerationRead {
            generation_id: "generation-1".into(),
            expected_room_epoch: epoch().into(),
            expected_attempt: 1,
        })
        .unwrap();
    let (mut stream, _) = listener.accept().await.unwrap();
    read_http(&mut stream).await;
    let mut body = receipt("cancelled");
    body["result"]["markdown"] = json!("x".repeat(40_000));
    body["result"]["nextChunkSeq"] = json!(1);
    body["result"]["finalAuthoritative"] = json!(false);
    send_http(&mut stream, 200, &body).await;
    let descriptor = attached.batch().await;
    attached.ack(&descriptor).unwrap();
    loop {
        let batch = attached.batch().await;
        assert!(lock(&attached.instance.inner).start_fence.is_some());
        let EngineReply::Small(ack) = attached.ack(&batch).unwrap() else {
            panic!()
        };
        if batch["event"]["final"] == true {
            assert_eq!(
                ack["generationCancel"],
                json!({"intentId":id,"current":true})
            );
            assert!(lock(&attached.instance.inner).pending.is_none());
            assert!(lock(&attached.instance.inner).start_fence.is_none());
            break;
        }
        assert!(ack.get("generationCancel").is_none());
    }
    attached.instance.destroyed();
}

#[tokio::test]
async fn starting_cancel_byok_handoff_never_reads_provider_and_destroys_key_guard() {
    use crate::secret::SecretStore;
    let store = Arc::new(crate::hosted_preset::tests::SyntheticStore::default());
    store
        .set(
            "preset:deepseek:api-key",
            "synthetic-starting-cancel-private-key",
        )
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let instance = RoomInstance::new(
        InstanceToken::new(1),
        Arc::new(RoomHttp::loopback(listener.local_addr().unwrap())),
        store.clone(),
    );
    instance.page_finished().unwrap();
    let mut attached = attach(Arc::new(instance), synthetic_account(1).access, 1);
    seed(&attached.instance);
    let mut input = raw(&attached.handle);
    input["request"]["presetConfig"] =
        json!({"providerId":"deepseek","modelId":"deepseek-v4-flash"});
    attached
        .instance
        .request_owned(attached.document, input)
        .unwrap();
    let (mut stream, _) = listener.accept().await.unwrap();
    read_http(&mut stream).await;
    stream.shutdown().await.unwrap();
    attached.event().await;
    attached.event().await;
    wait_http_idle(&attached.instance).await;
    socket(&attached, mirror("starting")).unwrap();
    attached.event().await;
    attached.event().await;
    let original = pending(&attached.instance)["intentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let wire = lock(&attached.instance.inner)
        .pending
        .as_ref()
        .unwrap()
        .start_basis
        .as_ref()
        .unwrap()
        .frozen_observation()
        .unwrap()
        .0;
    assert!(lock(&attached.instance.inner)
        .pending
        .as_ref()
        .unwrap()
        .start_basis
        .as_ref()
        .unwrap()
        .has_key_guard());
    let reads = store.reads.lock().unwrap().len();
    store.fail.store(true, Ordering::SeqCst);
    cancel_start(&attached, &original).unwrap();
    let (mut stream, _) = listener.accept().await.unwrap();
    let body = request_body(&read_http(&mut stream).await);
    assert!(!body
        .to_string()
        .contains("synthetic-starting-cancel-private-key"));
    assert!(!body.to_string().contains("apiKey"));
    assert!(wire.upgrade().is_none());
    assert_eq!(store.reads.lock().unwrap().len(), reads);
    send_http(&mut stream, 200, &receipt("cancelled")).await;
    let batch = attached.batch().await;
    attached.ack(&batch).unwrap();
    assert!(lock(&attached.instance.inner).pending.is_none());
    assert!(lock(&attached.instance.inner).start_fence.is_none());
    assert_eq!(store.reads.lock().unwrap().len(), reads);
    attached.instance.destroyed();
}

#[tokio::test]
async fn starting_cancel_before_send_failure_keeps_irreversible_unknown() {
    let (mut attached, listener, original) = ready().await;
    let id = accepted_id(cancel_start(&attached, &original).unwrap());
    // Current-thread executor has not polled the spawned HTTP task yet.
    lock(&attached.instance.inner)
        .scope
        .as_mut()
        .unwrap()
        .session
        .as_mut()
        .unwrap()
        .online
        .clear();
    assert_eq!(attached.event().await["error"]["outcome"], "unknown");
    attached.event().await;
    wait_http_idle(&attached.instance).await;
    assert!(RoomInstance::linked_start_cancel(
        &lock(&attached.instance.inner),
        &id
    ));
    assert!(attached
        .request(Action::RetryGenerationStart {
            intent_id: original
        })
        .is_err());
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
    attached.instance.destroyed();
}

#[tokio::test]
async fn starting_cancel_retired_fence_only_read_and_exact_closed_ack_are_small() {
    for mode in ["read", "close"] {
        let (mut attached, listener, original) = ready().await;
        let id = accepted_id(cancel_start(&attached, &original).unwrap());
        let (mut stream, _) = listener.accept().await.unwrap();
        read_http(&mut stream).await;
        stream.shutdown().await.unwrap();
        attached.event().await;
        attached.event().await;
        wait_http_idle(&attached.instance).await;
        attached
            .request(Action::EndGenerationStartTracking {
                intent_id: id.clone(),
            })
            .unwrap();
        let mut owner = attach(attached.instance.clone(), synthetic_account(2).access, 2);
        seed(&owner.instance);
        socket(&owner, mirror("running")).unwrap();
        owner.event().await;
        if mode == "close" {
            // Recovery may advance the room epoch. A canonical current-host Close of
            // the original owner+room clears local tracking, not a model-stop claim.
            lock(&owner.instance.inner)
                .scope
                .as_mut()
                .unwrap()
                .session
                .as_mut()
                .unwrap()
                .room_epoch = "recovered-epoch-2".into();
            owner
                .request(Action::Close {
                    room_id: room().into(),
                    expected_room_epoch: "recovered-epoch-2".into(),
                })
                .unwrap();
            let (mut stream, _) = listener.accept().await.unwrap();
            read_http(&mut stream).await;
            send_http(&mut stream, 200, &fixture(Operation::Close, "success")).await;
        } else {
            owner
                .request(Action::GenerationRead {
                    generation_id: "generation-1".into(),
                    expected_room_epoch: epoch().into(),
                    expected_attempt: 1,
                })
                .unwrap();
            let (mut stream, _) = listener.accept().await.unwrap();
            read_http(&mut stream).await;
            let mut body = receipt("cancelled");
            body["result"]["markdown"] = json!("final report");
            body["result"]["nextChunkSeq"] = json!(1);
            body["result"]["finalAuthoritative"] = json!(false);
            send_http(&mut stream, 200, &body).await;
            let descriptor = owner.batch().await;
            owner.ack(&descriptor).unwrap();
        }
        let batch = owner.batch().await;
        assert!(lock(&owner.instance.inner).start_fence.is_some());
        let EngineReply::Small(ack) = owner.ack(&batch).unwrap() else {
            panic!()
        };
        assert_eq!(
            ack["generationCancel"],
            json!({"intentId":id,"current":true}),
            "{mode}"
        );
        assert!(ack.get("generationStartFence").is_none());
        assert!(serde_json::to_vec(&ack).unwrap().len() <= 1024);
        assert!(lock(&owner.instance.inner).start_fence.is_none());
        owner.instance.destroyed();
    }
}

#[tokio::test]
async fn starting_cancel_max_escaped_identity_projection_and_old_debt_are_bounded() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut original = setup(listener.local_addr().unwrap());
    let opaque = "\u{0001}".repeat(256);
    let request_id = "r".repeat(128);
    let mut input = raw(&original.handle);
    input["request"]["roomId"] = json!(opaque);
    input["request"]["request"]["expectedRoomEpoch"] = json!(opaque);
    input["request"]["request"]["generationRequestId"] = json!(request_id);
    {
        let mut inner = lock(&original.instance.inner);
        let a = inner.scope.as_mut().unwrap().session.as_mut().unwrap();
        a.room_id = opaque.clone();
        a.room_epoch = opaque.clone();
    }
    original
        .instance
        .request_owned(original.document, input)
        .unwrap();
    let (mut stream, _) = listener.accept().await.unwrap();
    read_http(&mut stream).await;
    stream.shutdown().await.unwrap();
    let old_batch = original.batch().await;
    wait_http_idle(&original.instance).await;
    let old_debt = lock(&original.instance.inner)
        .delivery
        .delivered_unacked_bytes();
    assert!(old_debt > 0);
    let mut attached = attach(original.instance.clone(), synthetic_account(1).access, 2);
    seed(&attached.instance);
    let mut generation = mirror("starting");
    generation["generationRequestId"] = json!(request_id);
    generation["generationId"] = json!(opaque);
    generation["snapshotDigest"] = json!(opaque);
    {
        let mut inner = lock(&attached.instance.inner);
        let a = inner.scope.as_mut().unwrap().session.as_mut().unwrap();
        a.room_id = opaque.clone();
        a.room_epoch = opaque.clone();
    }
    let mut message = snapshot();
    message["roomId"] = json!(opaque);
    message["roomEpoch"] = json!(opaque);
    message["payload"]["roomId"] = json!(opaque);
    message["payload"]["roomEpoch"] = json!(opaque);
    message["payload"]["sharedConfig"] = config();
    message["payload"]["activeGeneration"] = generation.clone();
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
    let start_id = pending(&attached.instance)["intentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let id = accepted_id(cancel_start(&attached, &start_id).unwrap());
    let (mut stream, _) = listener.accept().await.unwrap();
    let body = request_body(&read_http(&mut stream).await);
    assert_eq!(
        body["request"]["expectedGeneration"]["generationId"],
        opaque
    );
    stream.shutdown().await.unwrap();
    attached.event().await;
    attached.event().await;
    wait_http_idle(&attached.instance).await;
    {
        let inner = lock(&attached.instance.inner);
        let encoded = protocol::encode_attach_response(&json!({"handle":attached.handle,"subscriptionId":attached.subscription,"pendingIntent":inner.pending.as_ref().unwrap().public(),"generationStartBlocked":true,"generationStartFence":RoomInstance::start_fence_public(&inner,42)})).unwrap();
        assert!(
            encoded.len() > 1024 && encoded.len() <= protocol::MAX_START_RECOVERY_RESPONSE_BYTES
        );
    }
    assert_eq!(
        lock(&attached.instance.inner)
            .delivery
            .delivered_unacked_bytes(),
        old_debt
    );
    let EngineReply::Small(ack) = original.ack(&old_batch).unwrap() else {
        panic!()
    };
    assert!(ack.get("generationCancel").is_none());
    assert_eq!(
        lock(&attached.instance.inner)
            .delivery
            .delivered_unacked_bytes(),
        0
    );
    assert!(RoomInstance::linked_start_cancel(
        &lock(&attached.instance.inner),
        &id
    ));
    let EngineReply::Json(ended) = attached
        .request(Action::EndGenerationStartTracking {
            intent_id: id.clone(),
        })
        .unwrap()
    else {
        panic!()
    };
    assert!(ended.len() <= protocol::MAX_START_RECOVERY_RESPONSE_BYTES);
    let mut owner = attach(attached.instance.clone(), synthetic_account(2).access, 3);
    seed(&owner.instance);
    {
        let mut inner = lock(&owner.instance.inner);
        let a = inner.scope.as_mut().unwrap().session.as_mut().unwrap();
        a.room_id = opaque.clone();
        a.room_epoch = opaque.clone();
    }
    generation["state"] = json!("cancelled");
    message["payload"]["activeGeneration"] = generation;
    let context = lock(&owner.instance.inner)
        .scope
        .as_ref()
        .unwrap()
        .context
        .clone();
    owner
        .instance
        .process_socket(&context, &CancellationToken::new(), &message)
        .unwrap();
    let batch = owner.batch().await;
    let EngineReply::Small(ack) = owner.ack(&batch).unwrap() else {
        panic!()
    };
    assert_eq!(
        ack["generationCancel"],
        json!({"intentId":id,"current":true})
    );
    assert!(serde_json::to_vec(&ack).unwrap().len() <= 1024);
    assert!(lock(&owner.instance.inner).start_fence.is_none());
    owner.instance.destroyed();
}

#[tokio::test]
async fn starting_cancel_waits_for_actual_start_http_settle_and_bound_mirror() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut attached = setup(listener.local_addr().unwrap());
    let original = accepted_id(start(&attached).unwrap());
    let (mut stream, _) = listener.accept().await.unwrap();
    read_http(&mut stream).await;
    socket(&attached, mirror("starting")).unwrap();
    attached.event().await;
    assert_eq!(error_code(cancel_start(&attached, &original)), "busy");
    assert_eq!(pending(&attached.instance)["operation"], "generationStart");
    assert!(lock(&attached.instance.inner).start_fence.is_none());
    send_http(&mut stream, 202, &receipt("starting")).await;
    attached.event().await;
    attached.event().await;
    wait_http_idle(&attached.instance).await;
    cancel_start(&attached, &original).unwrap();
    let (mut stream, _) = listener.accept().await.unwrap();
    read_http(&mut stream).await;
    send_http(&mut stream, 200, &receipt("cancelled")).await;
    attached.event().await;
    wait_http_idle(&attached.instance).await;
    assert!(lock(&attached.instance.inner).start_fence.is_none());
    attached.instance.destroyed();
    let attached = unknown().await;
    lock(&attached.instance.inner)
        .scope
        .as_mut()
        .unwrap()
        .session
        .as_mut()
        .unwrap()
        .generation = Some(mirror("starting"));
    let original = pending(&attached.instance)["intentId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(cancel_start(&attached, &original).is_err());
    assert_eq!(pending(&attached.instance)["operation"], "generationStart");
    attached.instance.destroyed();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn starting_cancel_and_start_retry_have_one_physical_linearization_point() {
    let (mut attached, listener, original) = ready().await;
    let mut error = RoomError::new("service-rejected", "not-applicable");
    error.server_code = Some("ROOM_NOT_FOUND");
    RoomInstance::start_read_not_found(
        &mut lock(&attached.instance.inner),
        &crate::arena_room_generation::GenerationReadTarget {
            room_id: room().into(),
            room_epoch: epoch().into(),
            generation_id: "generation-1".into(),
            attempt: 1,
        },
        &error,
    );
    assert_eq!(
        pending(&attached.instance)["generationStart"]["retryable"],
        true
    );
    let barrier = Arc::new(tokio::sync::Barrier::new(3));
    let mut tasks = Vec::new();
    for cancelling in [false, true] {
        let instance = attached.instance.clone();
        let document = attached.document;
        let handle = attached.handle.clone();
        let id = original.clone();
        let barrier = barrier.clone();
        tasks.push(tokio::spawn(async move {
            barrier.wait().await;
            (
                cancelling,
                instance
                    .request(
                        document,
                        Request {
                            handle,
                            action: if cancelling {
                                Action::CancelGenerationStart { intent_id: id }
                            } else {
                                Action::RetryGenerationStart { intent_id: id }
                            },
                        },
                    )
                    .is_ok(),
            )
        }));
    }
    barrier.wait().await;
    let first = tasks.remove(0).await.unwrap();
    let second = tasks.remove(0).await.unwrap();
    assert_ne!(first.1, second.1);
    let cancellation_won = second.1;
    let (mut stream, _) = listener.accept().await.unwrap();
    let body = request_body(&read_http(&mut stream).await);
    assert_eq!(
        body["desktopRoom"]["cancelMode"] == "starting-v1",
        cancellation_won
    );
    send_http(
        &mut stream,
        if cancellation_won { 200 } else { 202 },
        &receipt(if cancellation_won {
            "cancelled"
        } else {
            "starting"
        }),
    )
    .await;
    attached.event().await;
    if !cancellation_won {
        attached.event().await;
    }
    wait_http_idle(&attached.instance).await;
    if cancellation_won {
        assert!(attached
            .request(Action::RetryGenerationStart {
                intent_id: original
            })
            .is_err());
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
    attached.instance.destroyed();
}

#[test]
fn starting_cancel_recovery_projection_keeps_exact_eight_kib_gate() {
    let mut projection = json!({"pendingIntent":{"operation":"generationCancel","cancelMode":"starting-v1","startIntentId":"original"},"generationStartFence":null,"pad":""});
    let base = serde_json::to_vec(&projection).unwrap().len();
    projection["pad"] = json!("x".repeat(protocol::MAX_START_RECOVERY_RESPONSE_BYTES - base));
    assert_eq!(
        protocol::encode_attach_response(&projection).unwrap().len(),
        protocol::MAX_START_RECOVERY_RESPONSE_BYTES
    );
    projection["pad"].as_str().unwrap();
    projection["pad"] = json!("x".repeat(protocol::MAX_START_RECOVERY_RESPONSE_BYTES - base + 1));
    assert!(protocol::encode_attach_response(&projection).is_err());
    projection["pendingIntent"]
        .as_object_mut()
        .unwrap()
        .remove("cancelMode");
    assert!(protocol::encode_attach_response(&projection).is_err());
}

#[tokio::test]
async fn starting_cancel_retired_terminal_fence_does_not_regress_across_documents() {
    let (mut attached, _original, id) = unknown_cancel().await;
    socket(&attached, mirror("cancelled")).unwrap();
    let old = attached.batch().await;
    attached.instance.page_started().unwrap();
    attached.instance.page_finished().unwrap();
    let mut owner = attach(attached.instance.clone(), synthetic_account(2).access, 2);
    seed(&owner.instance);
    assert!(socket(&owner, mirror("running")).is_err());
    assert!(owner.notifications.try_recv().is_err());
    assert!(owner
        .request(Action::GenerationRead {
            generation_id: "generation-1".into(),
            expected_room_epoch: epoch().into(),
            expected_attempt: 1
        })
        .is_err());
    assert!(lock(&owner.instance.inner).start_fence.is_some());
    let old_ack = attached.ack(&old);
    if let Ok(EngineReply::Small(ack)) = old_ack {
        assert!(ack.get("generationCancel").is_none());
    }
    assert_eq!(
        RoomInstance::start_fence_public(&lock(&owner.instance.inner), 42)["cancelIntentId"],
        id
    );
    socket(&owner, mirror("cancelled")).unwrap();
    let batch = owner.batch().await;
    let EngineReply::Small(ack) = owner.ack(&batch).unwrap() else {
        panic!()
    };
    assert_eq!(
        ack["generationCancel"],
        json!({"intentId":id,"current":true})
    );
    assert!(lock(&owner.instance.inner).start_fence.is_none());
    owner.instance.destroyed();
}

#[tokio::test]
async fn starting_cancel_http_terminal_survives_retirement_before_ack() {
    let (mut attached, listener, original) = ready().await;
    let id = accepted_id(cancel_start(&attached, &original).unwrap());
    let (mut stream, _) = listener.accept().await.unwrap();
    read_http(&mut stream).await;
    send_http(&mut stream, 200, &receipt("cancelled")).await;
    let old = attached.batch().await;
    assert_eq!(
        old["event"]["response"]["result"]["generation"]["state"],
        "cancelled"
    );
    wait_http_idle(&attached.instance).await;
    for (index, state) in ["running", "completed"].iter().enumerate() {
        attached.instance.page_started().unwrap();
        attached.instance.page_finished().unwrap();
        let account_epoch = index as u64 + 2;
        let mut owner = attach(
            attached.instance.clone(),
            synthetic_account(account_epoch).access,
            account_epoch,
        );
        seed(&owner.instance);
        if index == 0 {
            let inner = lock(&owner.instance.inner);
            let fence = inner.start_fence.as_ref().unwrap();
            for difference in ["owner", "room", "epoch", "generation", "attempt"] {
                let mut candidate = inner
                    .scope
                    .as_ref()
                    .unwrap()
                    .session
                    .as_ref()
                    .unwrap()
                    .clone();
                candidate.generation = Some(mirror("running"));
                let account_user_id = if difference == "owner" { 43 } else { 42 };
                match difference {
                    "room" => candidate.room_id = "another-room".into(),
                    "epoch" => candidate.room_epoch = "another-epoch".into(),
                    "generation" => {
                        candidate.generation.as_mut().unwrap()["generationId"] =
                            json!("another-generation")
                    }
                    "attempt" => candidate.generation.as_mut().unwrap()["attempt"] = json!(2),
                    _ => {}
                }
                assert!(
                    fence
                        .check_cancel_candidate(account_user_id, &candidate)
                        .is_ok(),
                    "{difference}"
                );
            }
        }
        if index == 0 {
            if let Ok(EngineReply::Small(ack)) = attached.ack(&old) {
                assert!(ack.get("generationCancel").is_none());
            }
        }
        assert!(socket(&owner, mirror(state)).is_err());
        assert!(owner.notifications.try_recv().is_err());
        assert!(lock(&owner.instance.inner)
            .scope
            .as_ref()
            .unwrap()
            .session
            .as_ref()
            .unwrap()
            .generation
            .is_none());
        owner.request(http_action(Operation::Session)).unwrap();
        let (mut stream, _) = listener.accept().await.unwrap();
        read_http(&mut stream).await;
        let mut response = fixture(Operation::Session, "success");
        response["result"]["snapshot"]["sharedConfig"] = config();
        response["result"]["snapshot"]["activeGeneration"] = mirror(state);
        send_http(&mut stream, 200, &response).await;
        let event = owner.event().await;
        assert_eq!(event["kind"], "request-error");
        assert!(event.get("response").is_none());
        wait_http_idle(&owner.instance).await;
        assert!(lock(&owner.instance.inner)
            .scope
            .as_ref()
            .unwrap()
            .session
            .as_ref()
            .unwrap()
            .generation
            .is_none());
        assert!(
            owner
                .request(Action::GenerationRead {
                    generation_id: "generation-1".into(),
                    expected_room_epoch: epoch().into(),
                    expected_attempt: 1,
                })
                .is_err(),
            "{state} must not replace the retained HTTP terminal"
        );
        assert!(lock(&owner.instance.inner).start_fence.is_some());
    }
    attached.instance.page_started().unwrap();
    attached.instance.page_finished().unwrap();
    let mut owner = attach(attached.instance.clone(), synthetic_account(4).access, 4);
    seed(&owner.instance);
    let mut conflict = mirror("cancelled");
    conflict["snapshotDigest"] = json!("different-snapshot");
    assert!(socket(&owner, conflict).is_err());
    assert!(owner.notifications.try_recv().is_err());
    socket(&owner, mirror("cancelled")).unwrap();
    let batch = owner.batch().await;
    let EngineReply::Small(ack) = owner.ack(&batch).unwrap() else {
        panic!()
    };
    assert_eq!(
        ack["generationCancel"],
        json!({"intentId":id,"current":true})
    );
    assert!(lock(&owner.instance.inner).start_fence.is_none());
    owner.instance.destroyed();
}

#[tokio::test]
async fn starting_cancel_cannot_be_bypassed_by_legacy_cancel_from_a_tombstone() {
    let (attached, _original, id) = unknown_cancel().await;
    attached
        .request(Action::EndGenerationStartTracking { intent_id: id })
        .unwrap();
    let mut owner = attach(attached.instance.clone(), synthetic_account(2).access, 2);
    seed(&owner.instance);
    for state in ["starting", "running"] {
        socket(&owner, mirror(state)).unwrap();
        owner.event().await;
        assert!(owner
            .request(Action::GenerationCancel {
                room_id: room().into(),
                generation_id: "generation-1".into(),
                expected_room_epoch: epoch().into(),
                expected_attempt: 1
            })
            .is_err());
        assert!(lock(&owner.instance.inner).pending.is_none());
        assert!(lock(&owner.instance.inner).start_fence.is_some());
    }
    owner.instance.destroyed();
    // §12 still permits a separate observed starting target without this mode/fence.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut fresh = setup(listener.local_addr().unwrap());
    socket(&fresh, mirror("starting")).unwrap();
    fresh.event().await;
    fresh
        .request(Action::GenerationCancel {
            room_id: room().into(),
            generation_id: "generation-1".into(),
            expected_room_epoch: epoch().into(),
            expected_attempt: 1,
        })
        .unwrap();
    let (mut stream, _) = listener.accept().await.unwrap();
    let body = request_body(&read_http(&mut stream).await);
    assert!(body["desktopRoom"].get("cancelMode").is_none());
    assert_eq!(body["request"], json!({"expectedRoomEpoch":epoch()}));
    send_http(&mut stream, 200, &receipt("cancelled")).await;
    fresh.event().await;
    wait_http_idle(&fresh.instance).await;
    fresh.instance.destroyed();
}
