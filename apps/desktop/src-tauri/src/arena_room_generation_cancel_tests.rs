use super::*;

fn mirror(state: &str) -> Value {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/desktop-room-generation-read.json"
    ))
    .unwrap();
    let mut generation = fixture["operation"]["success"]["result"]["generation"].clone();
    generation["state"] = json!(state);
    if !generation_read::terminal(&generation["state"]) {
        generation.as_object_mut().unwrap().remove("finishedAt");
    }
    generation
}
fn receipt(status: &str) -> Value {
    let state = match status {
        "reserved" => "starting",
        "running" | "finalizing" => "running",
        "producer_lost" => "failed",
        other => other,
    };
    json!({"desktopRoom":{"version":protocol::PROTOCOL_VERSION,"viewerUserId":42},
        "result":{"protocolVersion":1,"roomId":room(),"roomEpoch":epoch(),"generation":mirror(state),"status":status}})
}
fn action() -> Action {
    Action::GenerationCancel {
        room_id: room().into(),
        generation_id: "generation-1".into(),
        expected_room_epoch: epoch().into(),
        expected_attempt: 1,
    }
}
fn seed(instance: &RoomInstance) {
    let mut session = fixture(Operation::Session, "success")["result"].clone();
    session["snapshot"]["activeGeneration"] = mirror("running");
    let mut authority = Authority::from_session(&session).unwrap();
    authority.snapshot_seen = true;
    authority.presence_seen = true;
    authority.online.insert(authority.self_id.clone());
    let mut inner = lock(&instance.inner);
    let scope = inner.scope.as_mut().unwrap();
    scope.session = Some(authority);
    scope.socket_cancel = Some(CancellationToken::new());
}
fn pending(instance: &RoomInstance) -> Value {
    lock(&instance.inner)
        .pending
        .as_ref()
        .map(PendingIntent::public)
        .unwrap_or(Value::Null)
}
fn setup(address: std::net::SocketAddr) -> Attached {
    let instance = make_instance(address, None);
    let attached = attach(instance.clone(), synthetic_account(1).access, 1);
    seed(&instance);
    attached
}
fn socket(instance: &RoomInstance, state: &str) -> Result<bool, RoomError> {
    let mut message = snapshot();
    message["payload"]["activeGeneration"] = mirror(state);
    let context = lock(&instance.inner)
        .scope
        .as_ref()
        .unwrap()
        .context
        .clone();
    instance.process_socket(&context, &CancellationToken::new(), &message)
}
fn assert_cancel_request(raw: &[u8]) {
    let text = String::from_utf8_lossy(raw);
    assert!(text.starts_with("POST /api/arena/rooms/v1/room_01JARENAEXAMPLE/generations/generation-1/cancel HTTP/1.1\r\n"));
    assert!(!text.contains("/start") && !text.contains("/models") && !text.contains('?'));
    assert_eq!(
        request_body(raw),
        json!({"desktopRoom":{"version":protocol::PROTOCOL_VERSION,"expectedUserId":42},"request":{"expectedRoomEpoch":epoch()}})
    );
}
async fn unknown() -> Attached {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut attached = setup(listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        assert_cancel_request(&read_http(&mut stream).await);
        send_http(&mut stream, 200, &receipt("running")).await;
    });
    attached.request(action()).unwrap();
    let result = attached.event().await;
    assert_eq!(result["operation"], "generationCancel");
    assert_eq!(attached.event().await["kind"], "mutation-unknown");
    wait_http_idle(&attached.instance).await;
    server.await.unwrap();
    attached
}

#[test]
fn generation_cancel_closed_protocol_mapping_and_canonical_targets() {
    for status in [
        "reserved",
        "running",
        "finalizing",
        "producer_lost",
        "completed",
        "failed",
        "cancelled",
    ] {
        let good = receipt(status);
        assert_eq!(
            protocol::validate_http_response(
                Operation::GenerationCancel,
                200,
                &serde_json::to_vec(&good).unwrap(),
                42
            )
            .unwrap(),
            good
        );
        for pointer in ["", "/desktopRoom", "/result", "/result/generation"] {
            let mut bad = good.clone();
            bad.pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("unexpected".into(), json!(true));
            assert!(protocol::validate_http_response(
                Operation::GenerationCancel,
                200,
                &serde_json::to_vec(&bad).unwrap(),
                42
            )
            .is_err());
        }
        for extra in ["markdown", "result", "nextChunkSeq", "finalAuthoritative"] {
            let mut bad = good.clone();
            bad["result"][extra] = json!("must-not-leak");
            assert!(protocol::validate_http_response(
                Operation::GenerationCancel,
                200,
                &serde_json::to_vec(&bad).unwrap(),
                42
            )
            .is_err());
        }
        let mut bad = good.clone();
        bad["result"]["generation"]["state"] = json!("wrong");
        assert!(protocol::validate_http_response(
            Operation::GenerationCancel,
            200,
            &serde_json::to_vec(&bad).unwrap(),
            42
        )
        .is_err());
    }
    let good = json!({"handle":"h","request":{"kind":"generation-cancel","roomId":room(),"generationId":"generation-1","expectedRoomEpoch":epoch(),"expectedAttempt":1}});
    assert!(protocol::parse_request(&good).is_ok());
    for field in ["roomId", "generationId"] {
        for bad_id in ["", ".", "..", "x/y", "x%2fy", " x", "x "] {
            let mut bad = good.clone();
            bad["request"][field] = json!(bad_id);
            assert!(protocol::parse_request(&bad).is_err(), "{field}: {bad_id}");
        }
    }
    for bad_attempt in [
        json!(0),
        json!(-1),
        json!(1.5),
        json!(9_007_199_254_740_992u64),
    ] {
        let mut bad = good.clone();
        bad["request"]["expectedAttempt"] = bad_attempt;
        assert!(protocol::parse_request(&bad).is_err());
    }
    let mut bad = good;
    bad["request"]["url"] = json!("https://untrusted.invalid");
    assert!(protocol::parse_request(&bad).is_err());
    let oversized = vec![b' '; protocol::MAX_RESPONSE_BYTES + 1];
    assert_eq!(
        protocol::validate_http_response(Operation::GenerationCancel, 200, &oversized, 42)
            .unwrap_err()
            .code,
        "response-too-large"
    );
}

#[tokio::test]
async fn generation_cancel_admission_requires_live_current_active_host() {
    for case in [
        "offline", "snapshot", "presence", "fresh", "member", "removed", "terminal", "barrier",
        "epoch", "target", "attempt",
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
                "removed" => {
                    a.members.get_mut(&a.self_id).unwrap().1 = "left".into();
                }
                "terminal" => a.generation = Some(mirror("cancelled")),
                "barrier" => a.generation_read_terminal = Some(mirror("cancelled")),
                "epoch" => a.room_epoch = "other".into(),
                "target" => a.generation.as_mut().unwrap()["generationId"] = json!("other"),
                "attempt" => a.generation.as_mut().unwrap()["attempt"] = json!(2),
                _ => unreachable!(),
            }
        }
        assert_eq!(
            error_code(attached.request(action())),
            "scope-changed",
            "{case}"
        );
        assert!(pending(&attached.instance).is_null());
        attached.instance.destroyed();
    }
}

#[tokio::test]
async fn generation_cancel_dispatch_rechecks_target_permission_and_document_before_network() {
    for case in ["target", "epoch", "permission", "terminal", "document"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let attached = setup(listener.local_addr().unwrap());
        attached.request(action()).unwrap();
        if case == "document" {
            attached.instance.page_started().unwrap();
        } else {
            let mut inner = lock(&attached.instance.inner);
            let a = inner.scope.as_mut().unwrap().session.as_mut().unwrap();
            match case {
                "target" => a.generation.as_mut().unwrap()["snapshotDigest"] = json!("changed"),
                "epoch" => a.room_epoch = "new-epoch".into(),
                "permission" => a.members.get_mut(&a.self_id).unwrap().1 = "left".into(),
                "terminal" => a.generation = Some(mirror("cancelled")),
                _ => unreachable!(),
            }
        }
        wait_http_idle(&attached.instance).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(20), listener.accept())
                .await
                .is_err(),
            "{case}"
        );
        assert!(pending(&attached.instance).is_null());
        attached.instance.destroyed();
    }
}

#[tokio::test]
async fn generation_cancel_nonterminal_post_preserves_socket_online_and_unknown_never_reposts() {
    let attached = unknown().await;
    let value = pending(&attached.instance);
    assert_eq!(
        value["generationTarget"],
        json!({"roomEpoch":epoch(),"generationId":"generation-1","attempt":1})
    );
    assert_eq!(value.as_object().unwrap().len(), 4);
    assert_eq!(error_code(attached.request(action())), "busy");
    let inner = lock(&attached.instance.inner);
    let scope = inner.scope.as_ref().unwrap();
    let a = scope.session.as_ref().unwrap();
    assert!(!scope.socket_cancel.as_ref().unwrap().is_cancelled());
    assert!(a.snapshot_seen && a.presence_seen && a.online.contains(&a.self_id));
    assert!(inner.pending.as_ref().unwrap().phase == IntentPhase::Unknown);
}

#[tokio::test]
async fn generation_cancel_terminal_post_settles_only_its_exact_ack() {
    for status in ["cancelled", "completed", "failed", "producer_lost"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut attached = setup(listener.local_addr().unwrap());
        let body = receipt(status);
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert_cancel_request(&read_http(&mut stream).await);
            send_http(&mut stream, 200, &body).await;
        });
        let EngineReply::Small(accepted) = attached.request(action()).unwrap() else {
            panic!()
        };
        assert_eq!(
            pending(&attached.instance)["intentId"],
            accepted["requestId"]
        );
        let batch = attached.batch().await;
        assert!(!pending(&attached.instance).is_null());
        assert_eq!(batch["event"]["response"]["result"]["status"], status);
        assert!(
            lock(&attached.instance.inner)
                .pending
                .as_ref()
                .unwrap()
                .phase
                == IntentPhase::AwaitingAck
        );
        let intent = pending(&attached.instance)["intentId"].clone();
        let EngineReply::Small(ack) = attached.ack(&batch).unwrap() else {
            panic!()
        };
        assert_eq!(
            ack["generationCancel"],
            json!({"intentId":intent,"current":true})
        );
        assert!(pending(&attached.instance).is_null());
        let EngineReply::Small(duplicate) = attached.ack(&batch).unwrap() else {
            panic!()
        };
        assert!(duplicate.get("generationCancel").is_none());
        assert!(pending(&attached.instance).is_null());
        server.await.unwrap();
        attached.instance.destroyed();
    }
}

#[tokio::test]
async fn generation_cancel_socket_terminal_wins_late_post_without_downgrade_or_resurrection() {
    for acknowledge_first in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut attached = setup(listener.local_addr().unwrap());
        let (sent, received) = oneshot::channel();
        let (release, resume) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert_cancel_request(&read_http(&mut stream).await);
            sent.send(()).unwrap();
            resume.await.unwrap();
            send_http(&mut stream, 200, &receipt("running")).await;
        });
        attached.request(action()).unwrap();
        received.await.unwrap();
        socket(&attached.instance, "cancelled").unwrap();
        let batch = attached.batch().await;
        assert_eq!(batch["event"]["kind"], "socket");
        if acknowledge_first {
            attached.ack(&batch).unwrap();
            assert!(pending(&attached.instance).is_null());
        }
        release.send(()).unwrap();
        wait_http_idle(&attached.instance).await;
        if !acknowledge_first {
            assert!(
                lock(&attached.instance.inner)
                    .pending
                    .as_ref()
                    .unwrap()
                    .phase
                    == IntentPhase::AwaitingAck
            );
            attached.ack(&batch).unwrap();
            assert!(pending(&attached.instance).is_null());
        }
        assert_eq!(attached.event().await["error"]["code"], "invalid-response");
        assert!(pending(&attached.instance).is_null());
        assert_eq!(
            lock(&attached.instance.inner)
                .scope
                .as_ref()
                .unwrap()
                .session
                .as_ref()
                .unwrap()
                .generation
                .as_ref()
                .unwrap()["state"],
            "cancelled"
        );
        server.await.unwrap();
        attached.instance.destroyed();
    }
}

#[tokio::test]
async fn generation_cancel_full_identity_conflicts_never_reach_renderer() {
    for field in [
        "generationRequestId",
        "configRevision",
        "snapshotDigest",
        "collaborativeInfluence",
        "participantUserIds",
        "hostAccountUserId",
    ] {
        let mut attached = unknown().await;
        let mut message = snapshot();
        message["payload"]["activeGeneration"] = mirror("cancelled");
        let value = &mut message["payload"]["activeGeneration"][field];
        *value = match field {
            "configRevision" => json!(8),
            "collaborativeInfluence" => json!(!value.as_bool().unwrap()),
            "participantUserIds" => json!([42, 43]),
            "hostAccountUserId" => json!(43),
            _ => json!("changed"),
        };
        let context = lock(&attached.instance.inner)
            .scope
            .as_ref()
            .unwrap()
            .context
            .clone();
        assert!(
            attached
                .instance
                .process_socket(&context, &CancellationToken::new(), &message)
                .is_err(),
            "{field}"
        );
        assert!(attached.notifications.try_recv().is_err());
        let mut response = fixture(Operation::Session, "success");
        response["result"]["snapshot"] = message["payload"].clone();
        let request = HttpRequest {
            operation: Operation::Session,
            room_id: Some(room().into()),
            proposal_id: None,
            request: json!({}),
            resume_only: false,
        };
        assert!(
            attached
                .instance
                .install_http(&context, &request, &response)
                .is_err(),
            "{field}"
        );
        let mut body = receipt("cancelled");
        body["result"]["generation"] = message["payload"]["activeGeneration"].clone();
        let basis = lock(&attached.instance.inner)
            .pending
            .as_ref()
            .unwrap()
            .cancel_basis
            .clone()
            .unwrap();
        assert!(
            attached
                .instance
                .install_cancel_receipt(&context, &basis, &body)
                .is_err(),
            "{field}"
        );
        assert!(!pending(&attached.instance).is_null());
        attached.instance.destroyed();
    }
}

#[tokio::test]
async fn generation_cancel_nonmatching_target_epoch_or_permission_cannot_settle() {
    for case in ["target", "attempt", "epoch", "permission", "absent"] {
        let attached = unknown().await;
        let context = lock(&attached.instance.inner)
            .scope
            .as_ref()
            .unwrap()
            .context
            .clone();
        let mut response = fixture(Operation::Session, "success");
        response["result"]["snapshot"]["activeGeneration"] = mirror("cancelled");
        match case {
            "target" => {
                response["result"]["snapshot"]["activeGeneration"]["generationId"] = json!("other")
            }
            "attempt" => response["result"]["snapshot"]["activeGeneration"]["attempt"] = json!(2),
            "epoch" => {
                response["result"]["roomEpoch"] = json!("other");
                response["result"]["snapshot"]["roomEpoch"] = json!("other");
            }
            "permission" => {
                let id = response["result"]["self"]["userId"].clone();
                for m in response["result"]["snapshot"]["members"]
                    .as_array_mut()
                    .unwrap()
                {
                    if m["userId"] == id {
                        m["membershipState"] = json!("left");
                    }
                }
            }
            "absent" => response["result"]["snapshot"]["activeGeneration"] = Value::Null,
            _ => unreachable!(),
        }
        let request = HttpRequest {
            operation: Operation::Session,
            room_id: Some(room().into()),
            proposal_id: None,
            request: json!({}),
            resume_only: false,
        };
        let installed = attached
            .instance
            .install_http(&context, &request, &response);
        if case == "permission" {
            assert!(installed.is_err());
        } else {
            installed.unwrap();
        }
        assert!(
            !RoomInstance::cancel_terminal_current(&lock(&attached.instance.inner), &context),
            "{case}"
        );
        assert!(!pending(&attached.instance).is_null());
        attached.instance.destroyed();
    }
}

#[tokio::test]
async fn generation_cancel_terminal_socket_ack_after_target_change_or_detach_cannot_settle() {
    for case in ["target", "permission", "detach"] {
        let mut attached = unknown().await;
        socket(&attached.instance, "cancelled").unwrap();
        let batch = attached.batch().await;
        if case == "detach" {
            attached
                .instance
                .detach(attached.document, &attached.handle)
                .unwrap();
        } else {
            let mut inner = lock(&attached.instance.inner);
            let a = inner.scope.as_mut().unwrap().session.as_mut().unwrap();
            if case == "target" {
                a.generation.as_mut().unwrap()["generationId"] = json!("new-target");
            } else {
                a.members.get_mut(&a.self_id).unwrap().1 = "left".into();
            }
        }
        let intent = pending(&attached.instance)["intentId"].clone();
        let EngineReply::Small(ack) = attached.ack(&batch).unwrap() else {
            panic!()
        };
        if case == "detach" {
            assert!(ack.get("generationCancel").is_none());
        } else {
            assert_eq!(
                ack["generationCancel"],
                json!({"intentId":intent,"current":false})
            );
        }
        assert!(!pending(&attached.instance).is_null(), "{case}");
        assert!(
            lock(&attached.instance.inner)
                .pending
                .as_ref()
                .unwrap()
                .phase
                == IntentPhase::Unknown
        );
        attached.instance.destroyed();
    }
}

#[tokio::test]
async fn generation_cancel_session_running_and_404_stay_unknown_terminal_exact_ack_settles() {
    for case in ["running", "404", "terminal"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut attached = setup(listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert_cancel_request(&read_http(&mut stream).await);
            send_http(&mut stream, 200, &receipt("running")).await;
            let (mut stream, _) = listener.accept().await.unwrap();
            let raw = read_http(&mut stream).await;
            assert!(String::from_utf8_lossy(&raw)
                .starts_with("GET /api/arena/rooms/v1/room_01JARENAEXAMPLE/session HTTP/1.1"));
            if case == "404" {
                send_http(&mut stream,404,&json!({"desktopRoom":{"version":protocol::PROTOCOL_VERSION,"viewerUserId":42},"error":{"code":"ROOM_NOT_FOUND","message":"missing","outcome":"not-applicable"}})).await;
            } else {
                let mut response = fixture(Operation::Session, "success");
                response["result"]["snapshot"]["activeGeneration"] =
                    mirror(if case == "terminal" {
                        "cancelled"
                    } else {
                        "running"
                    });
                send_http(&mut stream, 200, &response).await;
            }
        });
        attached.request(action()).unwrap();
        attached.event().await;
        attached.event().await;
        wait_http_idle(&attached.instance).await;
        attached.request(session_action()).unwrap();
        let batch = attached.batch().await;
        assert!(!pending(&attached.instance).is_null());
        attached.ack(&batch).unwrap();
        assert_eq!(
            pending(&attached.instance).is_null(),
            case == "terminal",
            "{case}"
        );
        server.await.unwrap();
        attached.instance.destroyed();
    }
}

#[tokio::test]
async fn generation_cancel_exact_generation_read_clears_only_current_final_fragment_ack() {
    for failure in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut attached = setup(listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert_cancel_request(&read_http(&mut stream).await);
            send_http(&mut stream, 200, &receipt("running")).await;
            let (mut stream, _) = listener.accept().await.unwrap();
            let raw = read_http(&mut stream).await;
            assert!(String::from_utf8_lossy(&raw).starts_with(
                "GET /api/arena/rooms/v1/room_01JARENAEXAMPLE/generations/generation-1 HTTP/1.1"
            ));
            let mut body = receipt("cancelled");
            body["result"]["markdown"] = json!("x".repeat(40_000));
            body["result"]["nextChunkSeq"] = json!(1);
            body["result"]["finalAuthoritative"] = json!(false);
            send_http(&mut stream, 200, &body).await;
        });
        attached.request(action()).unwrap();
        attached.event().await;
        attached.event().await;
        wait_http_idle(&attached.instance).await;
        assert_eq!(
            error_code(attached.request(Action::GenerationRead {
                generation_id: "other".into(),
                expected_room_epoch: epoch().into(),
                expected_attempt: 1
            })),
            "scope-changed"
        );
        attached
            .request(Action::GenerationRead {
                generation_id: "generation-1".into(),
                expected_room_epoch: epoch().into(),
                expected_attempt: 1,
            })
            .unwrap();
        let descriptor = attached.batch().await;
        assert_eq!(descriptor["event"]["kind"], "generation-descriptor");
        let EngineReply::Small(descriptor_ack) = attached.ack(&descriptor).unwrap() else {
            panic!()
        };
        assert!(descriptor_ack.get("generationCancel").is_none());
        assert!(!pending(&attached.instance).is_null());
        loop {
            let batch = attached.batch().await;
            let final_fragment = batch["event"]["final"] == true;
            assert!(!pending(&attached.instance).is_null());
            if final_fragment && failure {
                let mut inner = lock(&attached.instance.inner);
                inner
                    .scope
                    .as_mut()
                    .unwrap()
                    .session
                    .as_mut()
                    .unwrap()
                    .generation
                    .as_mut()
                    .unwrap()["generationId"] = json!("new-target");
            }
            let EngineReply::Small(ack) = attached.ack(&batch).unwrap() else {
                panic!()
            };
            if final_fragment {
                assert_eq!(ack["generationRead"]["current"], !failure);
                assert_eq!(ack["generationCancel"]["current"], !failure);
                assert!(ack["generationCancel"]["intentId"].is_string());
                assert_eq!(pending(&attached.instance).is_null(), !failure);
                break;
            }
            assert!(ack.get("generationCancel").is_none());
            assert!(!pending(&attached.instance).is_null());
        }
        server.await.unwrap();
        attached.instance.destroyed();
    }
}

#[tokio::test]
async fn generation_cancel_sent_error_never_clears_or_reposts_and_reload_keeps_target() {
    for case in ["404", "forbidden", "malformed", "drop"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut attached = setup(listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert_cancel_request(&read_http(&mut stream).await);
            match case {
                "404"=>send_http(&mut stream,404,&json!({"desktopRoom":{"version":protocol::PROTOCOL_VERSION,"viewerUserId":42},"error":{"code":"ROOM_NOT_FOUND","message":"missing","outcome":"not-applied"}})).await,
                "forbidden"=>send_http(&mut stream,403,&json!({"desktopRoom":{"version":protocol::PROTOCOL_VERSION,"viewerUserId":42},"error":{"code":"ROOM_FORBIDDEN","message":"forbidden","outcome":"not-applied"}})).await,
                "malformed"=>send_http(&mut stream,200,&json!({"raw":"do not expose"})).await,
                "drop"=>stream.shutdown().await.unwrap(),_=>unreachable!()
            }
            assert!(
                tokio::time::timeout(Duration::from_millis(40), listener.accept())
                    .await
                    .is_err()
            );
        });
        attached.request(action()).unwrap();
        let error = attached.event().await;
        assert_eq!(error["kind"], "request-error");
        assert_eq!(error["error"]["outcome"], "unknown");
        let unknown = attached.event().await;
        assert_eq!(unknown["kind"], "mutation-unknown");
        assert_eq!(
            unknown["generationTarget"],
            pending(&attached.instance)["generationTarget"]
        );
        wait_http_idle(&attached.instance).await;
        assert_eq!(error_code(attached.request(action())), "busy");
        let before = pending(&attached.instance);
        attached
            .instance
            .detach(attached.document, &attached.handle)
            .unwrap();
        let next = attach(attached.instance.clone(), synthetic_account(1).access, 2);
        assert_eq!(pending(&next.instance), before);
        server.await.unwrap();
        next.instance.destroyed();
    }
}

#[tokio::test]
async fn generation_cancel_completed_and_failed_socket_events_require_exact_ack() {
    for state in ["completed", "failed"] {
        let mut attached = unknown().await;
        let context = lock(&attached.instance.inner)
            .scope
            .as_ref()
            .unwrap()
            .context
            .clone();
        let mut payload = mirror(state);
        let object = payload.as_object_mut().unwrap();
        object.remove("state");
        object.remove("startedAt");
        object.remove("finishedAt");
        if state == "completed" {
            payload["generationRecordId"] = json!("record");
        } else {
            payload["errorCode"] = json!("generation-failed");
        }
        let message = json!({"protocolVersion":1,"type":format!("generation.{state}"),"roomId":room(),"roomEpoch":epoch(),"controlSeq":25,"timestamp":"2026-10-12T00:00:00Z","payload":payload});
        let message =
            protocol::parse_server_message(&serde_json::to_vec(&message).unwrap()).unwrap();
        attached
            .instance
            .process_socket(&context, &CancellationToken::new(), &message)
            .unwrap();
        let batch = attached.batch().await;
        assert!(!pending(&attached.instance).is_null());
        assert_eq!(
            batch["event"]["message"]["type"],
            format!("generation.{state}")
        );
        attached.ack(&batch).unwrap();
        assert!(pending(&attached.instance).is_null());
        attached.instance.destroyed();
    }
}

#[tokio::test]
async fn generation_cancel_false_ack_rearms_terminal_receipt_and_retains_barrier() {
    let mut attached = unknown().await;
    socket(&attached.instance, "cancelled").unwrap();
    let batch = attached.batch().await;
    {
        let mut inner = lock(&attached.instance.inner);
        inner
            .scope
            .as_mut()
            .unwrap()
            .session
            .as_mut()
            .unwrap()
            .generation_fresh = false;
    }
    let EngineReply::Small(ack) = attached.ack(&batch).unwrap() else {
        panic!()
    };
    assert_eq!(ack["generationCancel"]["current"], false);
    assert!(
        lock(&attached.instance.inner)
            .pending
            .as_ref()
            .unwrap()
            .phase
            == IntentPhase::Unknown
    );
    assert!(socket(&attached.instance, "running").is_err());
    socket(&attached.instance, "cancelled").unwrap();
    let batch = attached.batch().await;
    let EngineReply::Small(ack) = attached.ack(&batch).unwrap() else {
        panic!()
    };
    assert_eq!(ack["generationCancel"]["current"], true);
    assert!(pending(&attached.instance).is_null());
    attached.instance.destroyed();
}

#[tokio::test]
async fn generation_cancel_ack_account_failure_never_confirms_settlement() {
    for storage in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let instance = make_instance(listener.local_addr().unwrap(), None);
        let account = synthetic_account(1);
        let mut attached = attach(instance.clone(), account.access.clone(), 1);
        seed(&instance);
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert_cancel_request(&read_http(&mut stream).await);
            send_http(&mut stream, 200, &receipt("cancelled")).await;
        });
        attached.request(action()).unwrap();
        let batch = attached.batch().await;
        if storage {
            account.io_error.store(true, Ordering::SeqCst);
        } else {
            account.actual_epoch.store(2, Ordering::SeqCst);
        }
        match attached.ack(&batch) {
            Ok(EngineReply::Small(ack)) => assert_ne!(ack["generationCancel"]["current"], true),
            Err(error) => assert!(matches!(
                error.code,
                "scope-changed" | "storage-unavailable"
            )),
            _ => panic!(),
        }
        assert!(!pending(&instance).is_null());
        server.await.unwrap();
        instance.destroyed();
    }
}

#[tokio::test]
async fn generation_cancel_predispatch_terminal_is_known_not_sent_and_old_ack_cannot_clear_successor(
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut attached = setup(listener.local_addr().unwrap());
    attached.request(action()).unwrap();
    socket(&attached.instance, "cancelled").unwrap();
    assert!(
        lock(&attached.instance.inner)
            .pending
            .as_ref()
            .unwrap()
            .phase
            == IntentPhase::AwaitingAck
    );
    wait_http_idle(&attached.instance).await;
    assert!(pending(&attached.instance).is_null());
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
    let old = attached.batch().await;
    assert_eq!(old["event"]["kind"], "socket");
    let EngineReply::Small(ack) = attached.ack(&old).unwrap() else {
        panic!()
    };
    assert!(ack.get("generationCancel").is_none());
    let error = attached.event().await;
    assert_eq!(error["error"]["outcome"], "not-applied");
    assert!(pending(&attached.instance).is_null());
    {
        let mut inner = lock(&attached.instance.inner);
        let a = inner.scope.as_mut().unwrap().session.as_mut().unwrap();
        let mut next = mirror("running");
        next["generationId"] = json!("generation-2");
        a.generation = Some(next);
        a.generation_read_terminal = None;
    }
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let raw = read_http(&mut stream).await;
        assert!(String::from_utf8_lossy(&raw).starts_with("POST /api/arena/rooms/v1/room_01JARENAEXAMPLE/generations/generation-2/cancel HTTP/1.1"));
        let mut body = receipt("running");
        body["result"]["generation"]["generationId"] = json!("generation-2");
        send_http(&mut stream, 200, &body).await;
    });
    let EngineReply::Small(accepted) = attached
        .request(Action::GenerationCancel {
            room_id: room().into(),
            generation_id: "generation-2".into(),
            expected_room_epoch: epoch().into(),
            expected_attempt: 1,
        })
        .unwrap()
    else {
        panic!()
    };
    let successor = pending(&attached.instance);
    assert_eq!(successor["intentId"], accepted["requestId"]);
    let EngineReply::Small(duplicate) = attached.ack(&old).unwrap() else {
        panic!()
    };
    assert_eq!(duplicate["accepted"], false);
    assert!(duplicate.get("generationCancel").is_none());
    assert_eq!(pending(&attached.instance), successor);
    attached.event().await;
    attached.event().await;
    assert_eq!(pending(&attached.instance), successor);
    server.await.unwrap();
    attached.instance.destroyed();
}
