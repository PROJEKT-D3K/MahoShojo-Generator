// 合成 HTTP 与真实 WebSocket driver 的并行验收；test stream 不包含生产 TLS。
use super::*;

#[derive(Default)]
struct Traffic {
    http: Mutex<Vec<String>>,
    frames: Mutex<Vec<Value>>,
    interrupted_body: AtomicBool,
}
impl Traffic {
    fn assert_read_only(&self) {
        let http = lock(&self.http);
        let frames = lock(&self.frames);
        let start = http
            .iter()
            .filter(|line| {
                line.starts_with("POST ")
                    && line.contains("/generations")
                    && !line.contains("/cancel")
            })
            .count()
            + frames
                .iter()
                .filter(|frame| frame["type"] == "generation.start")
                .count();
        let cancel = http.iter().filter(|line| line.contains("/cancel")).count()
            + frames
                .iter()
                .filter(|frame| frame["type"] == "generation.cancel")
                .count();
        let model = http
            .iter()
            .filter(|line| {
                line.contains("/generate-")
                    || line.contains("/models")
                    || line.contains("/chat/completions")
            })
            .count();
        assert_eq!(
            (start, cancel, model),
            (0, 0, 0),
            "read/recovery must not invoke producer work"
        );
        assert_eq!(
            http.as_slice(),
            [
                format!("GET /api/arena/rooms/v1/{}/session HTTP/1.1", room()),
                format!("POST /api/arena/rooms/v1/{}/ticket HTTP/1.1", room()),
                format!(
                    "GET /api/arena/rooms/v1/{}/generations/generation-1 HTTP/1.1",
                    room()
                ),
            ]
        );
        assert_eq!(
            frames.as_slice(),
            [json!({"protocolVersion":1,"type":"room.resync.request"})]
        );
    }
}

fn report_fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/desktop-room-generation-read.json"
    ))
    .unwrap()
}
fn report_action() -> Action {
    Action::GenerationRead {
        generation_id: "generation-1".into(),
        expected_room_epoch: epoch().into(),
        expected_attempt: 1,
    }
}
fn report_snapshot() -> Value {
    let mut value = snapshot();
    value["payload"]["activeGeneration"] =
        report_fixture()["operation"]["success"]["result"]["generation"].clone();
    value
}
fn control_frame(kind: &str, payload: Value) -> Value {
    json!({"protocolVersion":1,"type":kind,"roomId":room(),"roomEpoch":epoch(),
        "controlSeq":25,"timestamp":"2026-10-12T00:02:00Z","payload":payload})
}
fn changed_generation() -> Value {
    let mut generation = report_fixture()["operation"]["success"]["result"]["generation"].clone();
    let fields = generation.as_object_mut().unwrap();
    fields.remove("state");
    fields.remove("startedAt");
    fields.remove("finishedAt");
    fields.insert("generationId".into(), json!("generation-2"));
    fields.insert("generationRequestId".into(), json!("generation-request-2"));
    control_frame("generation.started", generation)
}
fn revoked_member() -> Value {
    let mut member = snapshot()["payload"]["members"][0].clone();
    member["membershipState"] = json!("revoked");
    control_frame("room.member.left", json!({"member":member}))
}

struct LiveRead {
    attached: Attached,
    traffic: Arc<Traffic>,
    raw: String,
    socket_send: mpsc::UnboundedSender<Value>,
    finish_body: Option<oneshot::Sender<()>>,
    read_started: Option<oneshot::Receiver<()>>,
    stop: CancellationToken,
    http_task: tokio::task::JoinHandle<()>,
    socket_task: tokio::task::JoinHandle<()>,
}
impl LiveRead {
    async fn online() -> Self {
        let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let websocket = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http_address = http.local_addr().unwrap();
        let socket_address = websocket.local_addr().unwrap();
        let traffic = Arc::new(Traffic::default());
        let raw = report_fixture()["rawEnvelope"]
            .as_str()
            .unwrap()
            .replace("# 当前战报😀", &"战报😀".repeat(30_000));
        assert!(raw.len() > protocol::MAX_RESPONSE_BYTES);
        let body = raw.clone();
        let (finish_body, release_body) = oneshot::channel();
        let (started, read_started) = oneshot::channel();
        let stop = CancellationToken::new();
        let server_stop = stop.clone();
        let requests = traffic.clone();
        let http_task = tokio::spawn(async move {
            let mut release_body = Some(release_body);
            let mut started = Some(started);
            loop {
                let accepted = tokio::select! {
                    _ = server_stop.cancelled() => break,
                    accepted = http.accept() => accepted.unwrap(),
                };
                let (mut stream, _) = accepted;
                let request = read_http(&mut stream).await;
                let first = String::from_utf8(request)
                    .unwrap()
                    .lines()
                    .next()
                    .unwrap()
                    .to_owned();
                lock(&requests.http).push(first.clone());
                if first == format!("GET /api/arena/rooms/v1/{}/session HTTP/1.1", room()) {
                    let mut session = fixture(Operation::Session, "success");
                    session["result"]["snapshot"] = report_snapshot()["payload"].clone();
                    send_http(&mut stream, 200, &session).await;
                } else if first == format!("POST /api/arena/rooms/v1/{}/ticket HTTP/1.1", room()) {
                    send_http(&mut stream, 200, &fixture(Operation::Ticket, "success")).await;
                } else if first
                    == format!(
                        "GET /api/arena/rooms/v1/{}/generations/generation-1 HTTP/1.1",
                        room()
                    )
                {
                    let headers = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                    stream.write_all(headers.as_bytes()).await.unwrap();
                    let first_bytes = 16 * 1024;
                    stream
                        .write_all(&body.as_bytes()[..first_bytes])
                        .await
                        .unwrap();
                    if let Some(started) = started.take() {
                        started.send(()).unwrap();
                    }
                    let mut byte = [0];
                    let released = tokio::select! {
                        result = release_body.take().expect("one generation GET") => result.is_ok(),
                        result = stream.read(&mut byte) => {
                            assert_eq!(result.unwrap(), 0);
                            requests.interrupted_body.store(true, Ordering::SeqCst);
                            false
                        },
                        _ = server_stop.cancelled() => false,
                    };
                    if released {
                        let _ = stream.write_all(&body.as_bytes()[first_bytes..]).await;
                        let _ = stream.shutdown().await;
                    }
                } else {
                    send_http(&mut stream, 400, &json!({})).await;
                }
            }
        });
        let (socket_send, mut socket_receive) = mpsc::unbounded_channel::<Value>();
        let observed = traffic.clone();
        let socket_task = tokio::spawn(async move {
            let (stream, _) = websocket.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(stream, SelectPresence)
                .await
                .unwrap();
            let request = socket.next().await.unwrap().unwrap();
            lock(&observed.frames).push(serde_json::from_str(request.to_text().unwrap()).unwrap());
            for value in [report_snapshot(), presence(&["user-host", "user-member"])] {
                socket
                    .send(Message::Text(serde_json::to_string(&value).unwrap().into()))
                    .await
                    .unwrap();
            }
            loop {
                tokio::select! {
                    Some(message) = socket_receive.recv() => {
                        socket.send(Message::Text(serde_json::to_string(&message).unwrap().into())).await.unwrap();
                    },
                    message = socket.next() => {
                        match message {
                            Some(Ok(Message::Text(text))) => lock(&observed.frames).push(serde_json::from_str(&text).unwrap()),
                            Some(Ok(Message::Close(_))) | None => break,
                            Some(Ok(_)) => {},
                            Some(Err(error)) => panic!("unexpected synthetic socket failure: {error}"),
                        }
                    }
                }
            }
        });
        let account = synthetic_account(1);
        let mut attached = attach(
            make_instance(http_address, Some(socket_address)),
            account.access,
            1,
        );
        attached.request(session_action()).unwrap();
        assert_eq!(attached.event().await["kind"], "http-result");
        wait_http_idle(&attached.instance).await;
        attached.subscribe();
        loop {
            let event = attached.event().await;
            if event["kind"] == "status" && event["state"] == "online" {
                break;
            }
        }
        Self {
            attached,
            traffic,
            raw,
            socket_send,
            finish_body: Some(finish_body),
            read_started: Some(read_started),
            stop,
            http_task,
            socket_task,
        }
    }
    async fn begin(&mut self) -> String {
        let id = accepted_id(self.attached.request(report_action()).unwrap());
        tokio::time::timeout(Duration::from_secs(3), self.read_started.take().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(self.attached.instance.http_slot.available_permits(), 0);
        id
    }
    fn release(&mut self) {
        self.finish_body.take().unwrap().send(()).unwrap();
    }
    async fn finish(self) {
        self.attached.instance.destroyed();
        wait_http_idle(&self.attached.instance).await;
        tokio::time::timeout(Duration::from_secs(3), self.socket_task)
            .await
            .unwrap()
            .unwrap();
        self.stop.cancel();
        tokio::time::timeout(Duration::from_secs(3), self.http_task)
            .await
            .unwrap()
            .unwrap();
        self.traffic.assert_read_only();
    }
}

async fn authority_observed(instance: &RoomInstance, predicate: impl Fn(&Inner) -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if predicate(&lock(&instance.inner)) {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn socket_control_interleaves_with_large_get_and_ack_fragments_without_http_authority() {
    let mut live = LiveRead::online().await;
    let id = live.begin().await;
    let mut config = snapshot()["payload"]["sharedConfig"].clone();
    config["userGuidance"] = json!("socket remains authoritative during GET");
    live.socket_send
        .send(control_frame(
            "room.config.updated",
            json!({"revision":8,"sharedConfig":config}),
        ))
        .unwrap();
    let event = live.attached.event().await;
    assert_eq!(event["message"]["type"], "room.config.updated");
    assert_eq!(live.attached.instance.http_slot.available_permits(), 0);
    {
        let inner = lock(&live.attached.instance.inner);
        let authority = inner.scope.as_ref().unwrap().session.as_ref().unwrap();
        assert_eq!((authority.control_seq, authority.revision), (25, 8));
        assert!(authority.snapshot_seen && authority.presence_seen);
        assert!(authority.online.contains("user-host"));
    }
    live.release();
    let descriptor = live.attached.event().await;
    assert_eq!(descriptor["kind"], "generation-descriptor");
    assert_eq!(descriptor["requestId"], id);
    assert_eq!(descriptor["byteLength"], live.raw.len());
    assert_eq!(
        descriptor["digest"],
        format!("{:x}", Sha256::digest(live.raw.as_bytes()))
    );
    let first = live.attached.batch().await;
    assert_eq!(first["event"]["kind"], "generation-fragment");
    assert_eq!(first["event"]["offset"], 0);
    let mut rebuilt = first["event"]["text"].as_str().unwrap().to_owned();
    live.socket_send.send(presence(&["user-host"])).unwrap();
    authority_observed(&live.attached.instance, |inner| {
        inner
            .scope
            .as_ref()
            .unwrap()
            .session
            .as_ref()
            .unwrap()
            .online
            .len()
            == 1
    })
    .await;
    live.attached.ack(&first).unwrap();
    // The socket event entered the queue before the next fragment was ACK-created.
    assert_eq!(
        live.attached.event().await["message"]["type"],
        "room.presence"
    );
    loop {
        let batch = live.attached.batch().await;
        let event = &batch["event"];
        assert_eq!(event["kind"], "generation-fragment");
        assert_eq!(event["requestId"], id);
        assert_eq!(event["offset"].as_u64().unwrap() as usize, rebuilt.len());
        rebuilt.push_str(event["text"].as_str().unwrap());
        let EngineReply::Small(ack) = live.attached.ack(&batch).unwrap() else {
            panic!("expected ACK");
        };
        if event["final"] == true {
            assert_eq!(
                ack["generationRead"],
                json!({"requestId":id,"current":true})
            );
            break;
        }
    }
    assert_eq!(rebuilt, live.raw);
    {
        let inner = lock(&live.attached.instance.inner);
        let authority = inner.scope.as_ref().unwrap().session.as_ref().unwrap();
        assert_eq!((authority.control_seq, authority.revision), (25, 8));
        assert_eq!(authority.config_digest, Some(exact_config_digest(&config)));
        assert_eq!(authority.online, BTreeSet::from(["user-host".to_owned()]));
        assert!(authority.snapshot_seen && authority.presence_seen);
        assert!(inner.generation.is_none());
        assert_eq!(inner.delivery.delivered_unacked_bytes(), 0);
    }
    live.finish().await;
}

#[tokio::test]
async fn socket_new_generation_or_revoked_member_stops_an_already_pulled_raw_transfer() {
    for revoke in [false, true] {
        let mut live = LiveRead::online().await;
        let id = live.begin().await;
        live.release();
        assert_eq!(live.attached.event().await["kind"], "generation-descriptor");
        let held = live.attached.batch().await;
        assert_eq!(held["event"]["kind"], "generation-fragment");
        assert_eq!(held["event"]["final"], false);
        live.socket_send
            .send(if revoke {
                revoked_member()
            } else {
                changed_generation()
            })
            .unwrap();
        authority_observed(&live.attached.instance, |inner| inner.generation.is_none()).await;
        live.attached.ack(&held).unwrap();
        let mut saw_socket = false;
        let mut saw_closed = false;
        loop {
            let event = live.attached.event().await;
            assert_ne!(
                event["kind"], "generation-fragment",
                "revoked transfer must never advance its raw cursor"
            );
            saw_socket |= event["kind"] == "socket";
            saw_closed |= event["kind"] == "status" && event["state"] == "closed";
            if event["kind"] == "request-error" {
                assert_eq!(event["requestId"], id);
                assert_eq!(event["operation"], "generationRead");
                assert_eq!(event["error"]["code"], "scope-changed");
                break;
            }
        }
        assert!(saw_socket);
        assert_eq!(saw_closed, revoke);
        {
            let inner = lock(&live.attached.instance.inner);
            assert!(inner.generation.is_none());
            if revoke {
                assert!(inner.scope.as_ref().unwrap().session.is_none());
            } else {
                let authority = inner.scope.as_ref().unwrap().session.as_ref().unwrap();
                assert_eq!(
                    authority.generation.as_ref().unwrap()["generationId"],
                    "generation-2"
                );
                assert_eq!(authority.control_seq, 25);
                assert!(authority.online.contains("user-host"));
            }
        }
        live.finish().await;
    }
}

#[tokio::test]
async fn detaching_subscription_cancels_local_get_and_socket_without_server_generation_actions() {
    let mut live = LiveRead::online().await;
    live.begin().await;
    let detached = live
        .attached
        .instance
        .detach(live.attached.document, &live.attached.handle)
        .unwrap();
    assert_eq!(detached, json!({"detached":true}));
    wait_http_idle(&live.attached.instance).await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while !live.traffic.interrupted_body.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(lock(&live.attached.instance.inner).generation.is_none());
    assert!(lock(&live.attached.instance.inner).scope.is_none());
    assert!(live.attached.notifications.try_recv().is_err());
    live.finish().await;
}

#[tokio::test]
async fn socket_new_generation_or_revocation_cancels_an_inflight_http_body_before_raw_delivery() {
    for revoke in [false, true] {
        let mut live = LiveRead::online().await;
        let id = live.begin().await;
        live.socket_send
            .send(if revoke {
                revoked_member()
            } else {
                changed_generation()
            })
            .unwrap();
        let mut saw_socket = false;
        let mut saw_error = false;
        let mut saw_closed = false;
        while !saw_socket || !saw_error || (revoke && !saw_closed) {
            let event = live.attached.event().await;
            assert_ne!(event["kind"], "generation-descriptor");
            assert_ne!(event["kind"], "generation-fragment");
            saw_socket |= event["kind"] == "socket";
            saw_closed |= event["kind"] == "status" && event["state"] == "closed";
            if event["kind"] == "request-error" {
                assert_eq!(event["requestId"], id);
                assert_eq!(event["operation"], "generationRead");
                assert_eq!(event["error"]["code"], "scope-changed");
                saw_error = true;
            }
        }
        wait_http_idle(&live.attached.instance).await;
        tokio::time::timeout(Duration::from_secs(3), async {
            while !live.traffic.interrupted_body.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(lock(&live.attached.instance.inner).generation.is_none());
        live.finish().await;
    }
}
