use super::*;

fn generation_fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/desktop-room-generation-read.json"
    ))
    .unwrap()
}
fn generation_raw(large: bool) -> String {
    let raw = generation_fixture()["rawEnvelope"]
        .as_str()
        .unwrap()
        .to_owned();
    if large {
        raw.replace("# 当前战报😀", &format!("# {}", "片😀\\n".repeat(40_000)))
    } else {
        raw
    }
}
fn seed_generation(instance: &RoomInstance) {
    let mut session = fixture(Operation::Session, "success")["result"].clone();
    session["snapshot"]["activeGeneration"] =
        generation_fixture()["operation"]["success"]["result"]["generation"].clone();
    let mut authority = Authority::from_session(&session).unwrap();
    authority.snapshot_seen = true;
    authority.presence_seen = true;
    authority.online.insert(authority.self_id.clone());
    lock(&instance.inner).scope.as_mut().unwrap().session = Some(authority);
}
fn read_action() -> Action {
    Action::GenerationRead {
        generation_id: "generation-1".into(),
        expected_room_epoch: epoch().into(),
        expected_attempt: 1,
    }
}
fn small(reply: EngineReply) -> Value {
    match reply {
        EngineReply::Small(value) => value,
        EngineReply::Json(_) => panic!("expected small reply"),
    }
}
async fn read_setup(raw: String) -> (Attached, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let instance = make_instance(listener.local_addr().unwrap(), None);
    let attached = attach(instance.clone(), synthetic_account(1).access, 1);
    seed_generation(&instance);
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = read_http(&mut stream).await;
        let request = String::from_utf8(request).unwrap();
        assert!(request.starts_with(
            "GET /api/arena/rooms/v1/room_01JARENAEXAMPLE/generations/generation-1 HTTP/1.1\r\n"
        ));
        assert!(!request.contains("?"));
        assert!(!request.contains("start") && !request.contains("cancel"));
        let header = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", raw.len());
        stream.write_all(header.as_bytes()).await.unwrap();
        stream.write_all(raw.as_bytes()).await.unwrap();
        stream.shutdown().await.unwrap();
    });
    (attached, server)
}

#[tokio::test]
async fn generation_read_raw_round_trip_demand_ack_and_complete_fence() {
    let raw = generation_raw(true);
    assert!(raw.len() > protocol::MAX_RESPONSE_BYTES);
    let (mut attached, server) = read_setup(raw.clone()).await;
    let accepted = small(attached.request(read_action()).unwrap());
    let id = accepted["requestId"].clone();
    let descriptor = attached.batch().await;
    assert_eq!(descriptor["event"]["kind"], "generation-descriptor");
    assert_eq!(descriptor["event"]["byteLength"], raw.len());
    assert_eq!(
        descriptor["event"]["digest"],
        format!("{:x}", Sha256::digest(raw.as_bytes()))
    );
    wait_http_idle(&attached.instance).await;
    assert_eq!(error_code(attached.request(read_action())), "busy");
    let online_before = lock(&attached.instance.inner)
        .scope
        .as_ref()
        .unwrap()
        .session
        .as_ref()
        .unwrap()
        .online
        .clone();
    assert!(!online_before.is_empty());
    // 没有 ACK 不物化下一片；重复 pull 不复制原批次。
    assert_eq!(
        small(
            attached
                .request(Action::Pull {
                    subscription_id: attached.subscription.clone()
                })
                .unwrap()
        )["kind"],
        "empty"
    );
    assert!(attached.notifications.try_recv().is_err());
    let mut acks = vec![small(attached.ack(&descriptor).unwrap())];
    assert_eq!(small(attached.ack(&descriptor).unwrap())["accepted"], false);
    let mut received = String::new();
    loop {
        let batch = attached.batch().await;
        let event = &batch["event"];
        assert_eq!(event["kind"], "generation-fragment");
        assert_eq!(event["requestId"], id);
        assert_eq!(event["offset"], received.len());
        let text = event["text"].as_str().unwrap();
        assert!(!text.is_empty() && text.len() <= 16 * 1024);
        received.push_str(text);
        let ack = small(attached.ack(&batch).unwrap());
        let final_fragment = event["final"] == true;
        if final_fragment {
            assert_eq!(
                ack["generationRead"],
                json!({"requestId":id,"current":true})
            );
            let duplicate = small(attached.ack(&batch).unwrap());
            assert_eq!(duplicate["accepted"], false);
            assert!(duplicate.get("generationRead").is_none());
        } else {
            assert!(ack.get("generationRead").is_none());
        }
        acks.push(ack);
        if final_fragment {
            break;
        }
    }
    assert_eq!(received, raw);
    {
        let inner = lock(&attached.instance.inner);
        assert!(inner.generation.is_none() && inner.generation_completion.is_none());
        assert_eq!(
            inner
                .scope
                .as_ref()
                .unwrap()
                .session
                .as_ref()
                .unwrap()
                .online,
            online_before
        );
    }
    if let Ok(path) = std::env::var("MAHO_ROOM_GENERATION_OUTPUT") {
        std::fs::write(path, serde_json::to_vec(&json!({"rawEnvelope":raw,"notifications":attached.observed_notifications,
            "pulls":attached.observed_pulls,"acks":acks,"accepted":accepted,"attach":attached.attach_value})).unwrap()).unwrap();
    }
    server.await.unwrap();
}

#[tokio::test]
async fn generation_read_cancel_before_descriptor_pull_replaces_only_own_body() {
    let (mut attached, server) = read_setup(generation_raw(false)).await;
    attached.request(read_action()).unwrap();
    // 等通知已计债，但仍不 pull descriptor。
    let notice = attached.notifications.recv().await.unwrap();
    attached
        .observed_notifications
        .push(serde_json::from_str(&notice).unwrap());
    {
        let mut inner = lock(&attached.instance.inner);
        let context = inner.scope.as_ref().unwrap().context.clone();
        inner
            .scope
            .as_mut()
            .unwrap()
            .session
            .as_mut()
            .unwrap()
            .generation
            .as_mut()
            .unwrap()["generationId"] = json!("generation-2");
        attached
            .instance
            .check_generation_locked(&mut inner, &context)
            .unwrap();
        assert!(inner.generation.is_none());
        assert!(inner.scope.is_some());
    }
    let EngineReply::Json(body) = attached
        .request(Action::Pull {
            subscription_id: attached.subscription.clone(),
        })
        .unwrap()
    else {
        panic!("batch")
    };
    let batch: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(batch["batch"]["event"]["kind"], "request-error");
    assert_eq!(
        batch["batch"]["event"]["error"]["outcome"],
        "not-applicable"
    );
    assert!(!body.contains("markdown"));
    attached.ack(&batch["batch"]).unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn generation_read_final_already_pulled_invalidated_ack_does_not_grant_result() {
    let (mut attached, server) = read_setup(generation_raw(false)).await;
    let accepted = small(attached.request(read_action()).unwrap());
    let descriptor = attached.batch().await;
    attached.ack(&descriptor).unwrap();
    let final_batch = attached.batch().await;
    assert_eq!(final_batch["event"]["final"], true);
    {
        let mut inner = lock(&attached.instance.inner);
        let context = inner.scope.as_ref().unwrap().context.clone();
        inner
            .scope
            .as_mut()
            .unwrap()
            .session
            .as_mut()
            .unwrap()
            .generation
            .as_mut()
            .unwrap()["attempt"] = json!(2);
        attached
            .instance
            .check_generation_locked(&mut inner, &context)
            .unwrap();
        assert!(inner.generation.is_none() && inner.generation_completion.is_some());
    }
    assert_eq!(error_code(attached.request(read_action())), "busy");
    let ack = small(attached.ack(&final_batch).unwrap());
    assert_eq!(ack["accepted"], true);
    assert_eq!(
        ack["generationRead"],
        json!({"requestId":accepted["requestId"],"current":false})
    );
    assert!(lock(&attached.instance.inner).scope.is_some());
    assert!(lock(&attached.instance.inner)
        .generation_completion
        .is_none());
    assert!(attached.notifications.try_recv().is_err());
    server.await.unwrap();
}

#[tokio::test]
async fn generation_read_final_unpulled_member_revocation_replaces_short_fragment() {
    let (mut attached, server) = read_setup(generation_raw(false)).await;
    attached.request(read_action()).unwrap();
    let descriptor = attached.batch().await;
    attached.ack(&descriptor).unwrap();
    let notification = attached.notifications.recv().await.unwrap();
    assert!(notification.contains("available"));
    {
        let mut inner = lock(&attached.instance.inner);
        let context = inner.scope.as_ref().unwrap().context.clone();
        let authority = inner.scope.as_mut().unwrap().session.as_mut().unwrap();
        authority.members.get_mut(&authority.self_id).unwrap().1 = "revoked".into();
        attached
            .instance
            .check_generation_locked(&mut inner, &context)
            .unwrap();
    }
    let EngineReply::Json(raw) = attached
        .request(Action::Pull {
            subscription_id: attached.subscription.clone(),
        })
        .unwrap()
    else {
        panic!("batch")
    };
    assert!(!raw.contains("generation-fragment") && !raw.contains("markdown"));
    let value: Value = serde_json::from_str(&raw).unwrap();
    let ack = small(attached.ack(&value["batch"]).unwrap());
    assert_eq!(ack["generationRead"]["current"], false);
    server.await.unwrap();
}

#[tokio::test]
async fn generation_read_retires_on_real_document_change_without_refunding_old_ack() {
    let (mut attached, server) = read_setup(generation_raw(false)).await;
    attached.request(read_action()).unwrap();
    let descriptor = attached.batch().await;
    attached.ack(&descriptor).unwrap();
    let final_batch = attached.batch().await;
    attached.instance.page_started().unwrap();
    assert!(lock(&attached.instance.inner).generation.is_none());
    // 新 Document 不可借旧身份清债；scope 退休也不伪造一次 ACK 成功。
    assert_eq!(error_code(attached.ack(&final_batch)), "scope-changed");
    assert_eq!(error_code(attached.ack(&final_batch)), "scope-changed");
    server.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn generation_read_stalled_local_consumer_releases_raw_and_emits_failure() {
    let (mut attached, server) = read_setup(generation_raw(false)).await;
    attached.request(read_action()).unwrap();
    let descriptor = attached.batch().await;
    // 固定最大片只持本机原件，不让无 ACK 消费者永久占槽。
    tokio::time::advance(Duration::from_secs(31)).await;
    tokio::task::yield_now().await;
    assert!(lock(&attached.instance.inner).generation.is_none());
    attached.ack(&descriptor).unwrap();
    assert_eq!(attached.event().await["error"]["code"], "network-error");
    server.await.unwrap();
}

#[tokio::test]
async fn generation_read_account_storage_failure_before_final_ack_never_grants_result() {
    let raw = generation_raw(false);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let instance = make_instance(listener.local_addr().unwrap(), None);
    let account = synthetic_account(1);
    let mut attached = attach(instance.clone(), account.access.clone(), 1);
    seed_generation(&instance);
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_http(&mut stream).await;
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            raw.len()
        );
        stream.write_all(header.as_bytes()).await.unwrap();
        stream.write_all(raw.as_bytes()).await.unwrap();
    });
    attached.request(read_action()).unwrap();
    let descriptor = attached.batch().await;
    attached.ack(&descriptor).unwrap();
    let final_batch = attached.batch().await;
    account.io_error.store(true, Ordering::SeqCst);
    assert_eq!(
        error_code(attached.ack(&final_batch)),
        "storage-unavailable"
    );
    assert_eq!(account.clears.load(Ordering::SeqCst), 0);
    assert!(lock(&instance.inner).generation.is_none());
    server.await.unwrap();
}

async fn two_read_server(listener: TcpListener, bodies: Vec<String>) {
    for raw in bodies {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_http(&mut stream).await;
        let header = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", raw.len());
        stream.write_all(header.as_bytes()).await.unwrap();
        stream.write_all(raw.as_bytes()).await.unwrap();
        stream.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn generation_read_drain_does_not_block_ordinary_http_recovery() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let instance = make_instance(listener.local_addr().unwrap(), None);
    let mut attached = attach(instance.clone(), synthetic_account(1).access, 1);
    seed_generation(&instance);
    let server = tokio::spawn(two_read_server(
        listener,
        vec![
            generation_raw(true),
            fixture(Operation::Session, "success").to_string(),
        ],
    ));
    attached.request(read_action()).unwrap();
    let descriptor = attached.batch().await;
    attached.ack(&descriptor).unwrap();
    wait_http_idle(&instance).await;
    // 普通 session GET 可以中止本机大原件；不被剩余数千片 ACK 占住 HTTP 槽。
    assert_eq!(
        small(attached.request(session_action()).unwrap())["kind"],
        "accepted"
    );
    assert!(lock(&instance.inner).generation.is_none());
    assert_eq!(attached.event().await["kind"], "request-error");
    assert_eq!(attached.event().await["operation"], "session");
    server.await.unwrap();
}

#[tokio::test]
async fn generation_read_confirmed_terminal_blocks_later_running_without_socket_terminal() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let instance = make_instance(listener.local_addr().unwrap(), None);
    let mut attached = attach(instance.clone(), synthetic_account(1).access, 1);
    seed_generation(&instance);
    {
        let mut inner = lock(&instance.inner);
        let authority = inner.scope.as_mut().unwrap().session.as_mut().unwrap();
        authority.generation_read_terminal = None;
        let mirror = authority.generation.as_mut().unwrap();
        mirror["state"] = json!("running");
        mirror.as_object_mut().unwrap().remove("finishedAt");
    }
    let mut running = generation_fixture()["operation"]["success"].clone();
    running["result"]["generation"]["state"] = json!("running");
    running["result"]["generation"]
        .as_object_mut()
        .unwrap()
        .remove("finishedAt");
    running["result"]["status"] = json!("running");
    running["result"]["finalAuthoritative"] = json!(false);
    running["result"]
        .as_object_mut()
        .unwrap()
        .remove("generationRecordId");
    running["result"].as_object_mut().unwrap().remove("result");
    let server = tokio::spawn(two_read_server(
        listener,
        vec![generation_raw(false), running.to_string()],
    ));
    attached.request(read_action()).unwrap();
    let descriptor = attached.batch().await;
    attached.ack(&descriptor).unwrap();
    let final_batch = attached.batch().await;
    assert_eq!(
        small(attached.ack(&final_batch).unwrap())["generationRead"]["current"],
        true
    );
    wait_http_idle(&instance).await;
    assert_eq!(
        lock(&instance.inner)
            .scope
            .as_ref()
            .unwrap()
            .session
            .as_ref()
            .unwrap()
            .generation
            .as_ref()
            .unwrap()["state"],
        "running"
    );
    attached.request(read_action()).unwrap();
    let error = attached.event().await;
    assert_eq!(error["kind"], "request-error");
    assert_eq!(error["error"]["code"], "scope-changed");
    server.await.unwrap();
}

#[tokio::test]
async fn generation_read_revoked_snapshot_error_does_not_reuse_old_membership() {
    let (mut attached, server) = read_setup(generation_raw(false)).await;
    attached.request(read_action()).unwrap();
    let descriptor = attached.batch().await;
    attached.ack(&descriptor).unwrap();
    let final_batch = attached.batch().await;
    let context = lock(&attached.instance.inner)
        .scope
        .as_ref()
        .unwrap()
        .context
        .clone();
    let self_id = lock(&attached.instance.inner)
        .scope
        .as_ref()
        .unwrap()
        .session
        .as_ref()
        .unwrap()
        .self_id
        .clone();
    let mut changed = snapshot();
    changed["payload"]["activeGeneration"] =
        generation_fixture()["operation"]["success"]["result"]["generation"].clone();
    for member in changed["payload"]["members"].as_array_mut().unwrap() {
        if member["userId"] == self_id {
            member["membershipState"] = json!("revoked");
        }
    }
    assert!(attached
        .instance
        .process_socket(&context, &CancellationToken::new(), &changed)
        .is_err());
    assert!(lock(&attached.instance.inner).generation.is_none());
    let ack = small(attached.ack(&final_batch).unwrap());
    assert_eq!(ack["generationRead"]["current"], false);
    assert_eq!(error_code(attached.request(read_action())), "scope-changed");
    server.await.unwrap();
}

#[test]
fn generation_read_socket_terminal_survives_same_sequence_old_running_snapshot() {
    let mut session = fixture(Operation::Session, "success")["result"].clone();
    session["snapshot"]["activeGeneration"] =
        generation_fixture()["operation"]["success"]["result"]["generation"].clone();
    let mut authority = Authority::from_session(&session).unwrap();
    let known = authority.generation_read_terminal.clone().unwrap();
    let mut old = session["snapshot"].clone();
    old["activeGeneration"]["state"] = json!("running");
    old["activeGeneration"]
        .as_object_mut()
        .unwrap()
        .remove("finishedAt");
    authority.replace_snapshot(&old).unwrap();
    assert_eq!(authority.generation_read_terminal, Some(known));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn generation_read_cancel_between_checked_401_and_auth_finish_never_clears_account() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let instance = make_instance(listener.local_addr().unwrap(), None);
    let mut account = synthetic_account(1);
    let armed = Arc::new(AtomicBool::new(false));
    let (entered_tx, entered_rx) = oneshot::channel();
    let entered_tx = Arc::new(Mutex::new(Some(entered_tx)));
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release_rx = Arc::new(Mutex::new(release_rx));
    let current = account.access.current.clone();
    let gate = armed.clone();
    Arc::get_mut(&mut account.access).unwrap().current = Arc::new(move || {
        let result = current();
        if gate.swap(false, Ordering::SeqCst) {
            if let Some(sender) = lock(&entered_tx).take() {
                let _ = sender.send(());
            }
            lock(&release_rx)
                .recv_timeout(Duration::from_secs(3))
                .unwrap();
        }
        result
    });
    let mut attached = attach(instance.clone(), account.access.clone(), 1);
    seed_generation(&instance);
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_http(&mut stream).await;
        armed.store(true, Ordering::SeqCst);
        send_http(&mut stream, 401, &auth_failure(Operation::GenerationRead)).await;
    });
    attached.request(read_action()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), entered_rx)
        .await
        .unwrap()
        .unwrap();
    {
        let mut inner = lock(&instance.inner);
        let context = inner.scope.as_ref().unwrap().context.clone();
        instance
            .abort_generation_locked(&mut inner, &context, &stale())
            .unwrap();
    }
    release_tx.send(()).unwrap();
    wait_http_idle(&instance).await;
    assert_eq!(account.clears.load(Ordering::SeqCst), 0);
    assert!(lock(&instance.inner).scope.is_some());
    assert_eq!(attached.event().await["error"]["code"], "scope-changed");
    server.await.unwrap();
}

#[test]
fn generation_read_install_session_keeps_new_terminal_without_previous_barrier() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let _guard = runtime.enter();
    let instance = make_instance("127.0.0.1:9".parse().unwrap(), None);
    let attached = attach(instance.clone(), synthetic_account(1).access, 1);
    seed_config_authority(&instance);
    let context = lock(&instance.inner)
        .scope
        .as_ref()
        .unwrap()
        .context
        .clone();
    let mut response = fixture(Operation::Session, "success");
    response["result"]["snapshot"]["activeGeneration"] =
        generation_fixture()["operation"]["success"]["result"]["generation"].clone();
    instance
        .install_http(
            &context,
            &HttpRequest {
                operation: Operation::Session,
                room_id: Some(room().into()),
                proposal_id: None,
                request: json!({}),
                resume_only: false,
            },
            &response,
        )
        .unwrap();
    assert_eq!(
        lock(&instance.inner)
            .scope
            .as_ref()
            .unwrap()
            .session
            .as_ref()
            .unwrap()
            .generation_read_terminal
            .as_ref()
            .unwrap()["state"],
        "completed"
    );
    drop(attached);
}

#[tokio::test]
async fn generation_read_changed_raw_without_epoch_never_delivers_prior_ordinary_body() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let instance = make_instance(listener.local_addr().unwrap(), None);
    let mut account = synthetic_account(1);
    let raw_current = Arc::new(AtomicBool::new(true));
    let check = raw_current.clone();
    Arc::get_mut(&mut account.access).unwrap().current =
        Arc::new(move || Ok(check.load(Ordering::SeqCst)));
    let attached = attach(instance.clone(), account.access.clone(), 1);
    seed_generation(&instance);
    {
        let mut inner = lock(&instance.inner);
        let context = inner.scope.as_ref().unwrap().context.clone();
        inner
            .delivery
            .enqueue(&json!({"kind":"socket","message":snapshot()}))
            .unwrap();
        instance.notify_locked(&mut inner, &context).unwrap();
    }
    attached.request(read_action()).unwrap();
    raw_current.store(false, Ordering::SeqCst);
    assert_eq!(
        error_code(attached.request(Action::Pull {
            subscription_id: attached.subscription.clone()
        })),
        "scope-changed"
    );
    assert!(lock(&instance.inner).generation.is_none());
    assert_eq!(account.access.epoch, 1);
    assert!(!account.access.cancel.is_cancelled());
    instance.destroyed();
}
