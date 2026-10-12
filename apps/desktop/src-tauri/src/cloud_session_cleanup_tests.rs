// Included in cloud::tests; only synthetic credentials and loopback HTTP are used.
async fn complete_session_cleanup_login(state: &CloudState, secrets: &dyn SecretStore) {
    let begin = cloud_login_begin(state).await.unwrap();
    let authorize = url::Url::parse(&begin.authorize_url).unwrap();
    let query: HashMap<_, _> = authorize.query_pairs().into_owned().collect();
    let callback = format!(
        "{}?code={}&state={}",
        query["redirect_uri"],
        "c".repeat(43),
        query["state"]
    );
    let (outcome, response) = tokio::join!(
        cloud_login_await(state, &begin.flow_id, secrets),
        reqwest::Client::new().get(callback).send(),
    );
    assert!(response.unwrap().status().is_success());
    assert!(matches!(
        outcome.unwrap(),
        CloudLoginOutcome::SignedIn { .. }
    ));
}

#[test]
fn session_cleanup_late_required_401_preserves_same_bytes_relogin() {
    rt().block_on(async {
        let server = spawn_mock_server();
        let state = CloudState::with_origin(&server.origin);
        let secrets = MemorySecrets::new();
        complete_session_cleanup_login(&state, &secrets).await;
        let original = secrets.resolve(ACCOUNT_SESSION_REF).unwrap();
        let fingerprint = arena_account_snapshot(&state, &secrets)
            .unwrap()
            .fingerprint;
        *server.card_response_override.lock().unwrap() =
            Some((401, r#"{"error":"expired"}"#.into()));
        let (seen, ready) = oneshot::channel();
        *server.card_request_seen.lock().unwrap() = Some(seen);
        let (release, wait) = std::sync::mpsc::channel();
        *server.card_reply_gate.lock().unwrap() = Some(wait);
        let relogin = async {
            tokio::time::timeout(Duration::from_secs(3), ready)
                .await
                .unwrap()
                .unwrap();
            complete_session_cleanup_login(&state, &secrets).await;
            assert_eq!(secrets.resolve(ACCOUNT_SESSION_REF).unwrap(), original);
            assert_ne!(
                arena_account_snapshot(&state, &secrets)
                    .unwrap()
                    .fingerprint,
                fingerprint
            );
            release.send(()).unwrap();
        };
        let (response, ()) = tokio::join!(
            cloud_messages_request(&state, &secrets, card_request("messages.read")),
            relogin,
        );
        assert_eq!(response.unwrap().status, 401);
        assert_eq!(secrets.resolve(ACCOUNT_SESSION_REF).unwrap(), original);
        assert_eq!(secrets.deletions.load(Ordering::SeqCst), 0);
    });
}

fn next_cleanup_session(original: &StoredSession, replacement: &str) -> StoredSession {
    let mut next = original.clone();
    if replacement != "same-bytes" {
        next.cookie = "better-auth.session_token=replacement".into();
    }
    if replacement == "new-account" {
        next.account.user_id = 8;
        next.account.username = "madoka".into();
    }
    next
}

#[test]
fn session_cleanup_late_required_401_keeps_replacement_after_signout() {
    rt().block_on(async {
        for route in ["messages.read", "messages.read-all", "favorites.query"] {
            for replacement in ["new-cookie", "new-account"] {
                let server = spawn_mock_server();
                let state = CloudState::with_origin(&server.origin);
                let secrets = MemorySecrets::new();
                complete_session_cleanup_login(&state, &secrets).await;
                let original = load_session(&secrets).unwrap().unwrap();
                *server.exchange_session_override.lock().unwrap() =
                    Some(next_cleanup_session(&original, replacement));
                *server.card_response_override.lock().unwrap() =
                    Some((401, r#"{"error":"expired"}"#.into()));
                let (seen, ready) = oneshot::channel();
                *server.card_request_seen.lock().unwrap() = Some(seen);
                let (release, wait) = std::sync::mpsc::channel();
                *server.card_reply_gate.lock().unwrap() = Some(wait);
                let relogin = async {
                    tokio::time::timeout(Duration::from_secs(3), ready)
                        .await
                        .unwrap()
                        .unwrap();
                    assert!(cloud_sign_out(&state, &secrets).await.unwrap().revoked);
                    complete_session_cleanup_login(&state, &secrets).await;
                    let fresh = secrets.resolve(ACCOUNT_SESSION_REF).unwrap();
                    release.send(()).unwrap();
                    fresh
                };
                let request = async {
                    if route == "favorites.query" {
                        let cache = TestCache::new("cleanup-late-favorites");
                        cloud_card_library_request(
                            &state,
                            &secrets,
                            cache.get(),
                            card_request(route),
                        )
                        .await
                    } else {
                        cloud_messages_request(&state, &secrets, card_request(route)).await
                    }
                };
                let (response, fresh) = tokio::join!(request, relogin);
                assert_eq!(response.unwrap().status, 401, "{route}/{replacement}");
                assert_eq!(
                    secrets.resolve(ACCOUNT_SESSION_REF).unwrap(),
                    fresh,
                    "{route}/{replacement}"
                );
                assert_eq!(
                    secrets.deletions.load(Ordering::SeqCst),
                    1,
                    "only explicit signout deletes"
                );
                assert!(server
                    .last_card_request
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .1
                    .contains(&original.cookie));
            }
        }
    });
}

#[test]
fn session_cleanup_native_late_status_expiry_keeps_new_login() {
    // Native concurrent commands. The single renderer store waits for statusPromise
    // before requestAuth; this does not claim that UI login bypasses that wait.
    rt().block_on(async {
        for status in [401, 200] {
            for replacement in ["same-bytes", "new-cookie", "new-account"] {
                let server = spawn_mock_server();
                let state = CloudState::with_origin(&server.origin);
                let secrets = MemorySecrets::new();
                complete_session_cleanup_login(&state, &secrets).await;
                let original = load_session(&secrets).unwrap().unwrap();
                *server.exchange_session_override.lock().unwrap() =
                    Some(next_cleanup_session(&original, replacement));
                *server.get_session_override.lock().unwrap() =
                    Some((status, r#"{"session":null,"user":null}"#.into()));
                let (seen, ready) = oneshot::channel();
                *server.get_session_request_seen.lock().unwrap() = Some(seen);
                let (release, wait) = std::sync::mpsc::channel();
                *server.get_session_reply_gate.lock().unwrap() = Some(wait);
                let relogin = async {
                    tokio::time::timeout(Duration::from_secs(3), ready)
                        .await
                        .unwrap()
                        .unwrap();
                    complete_session_cleanup_login(&state, &secrets).await;
                    let fresh = secrets.resolve(ACCOUNT_SESSION_REF).unwrap();
                    release.send(()).unwrap();
                    fresh
                };
                let (result, fresh) = tokio::join!(cloud_auth_status(&state, &secrets), relogin);
                assert!(matches!(result.unwrap(), CloudSessionStatus::Expired));
                assert_eq!(
                    secrets.resolve(ACCOUNT_SESSION_REF).unwrap(),
                    fresh,
                    "{status}/{replacement}"
                );
                assert_eq!(secrets.deletions.load(Ordering::SeqCst), 0);
            }
        }
    });
}

// Capture a copy, release the map mutex, then pause. This deliberately cannot
// provide the writer exclusion being tested: only ACCOUNT_SESSION_GATE can do so.
struct CleanupProbeSecrets {
    inner: MemorySecrets,
    pause: Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
    operations: Mutex<Vec<&'static str>>,
    delete_gate_held: std::sync::atomic::AtomicBool,
}
impl CleanupProbeSecrets {
    fn new() -> Self {
        Self {
            inner: MemorySecrets::new(),
            pause: Mutex::new(None),
            operations: Mutex::new(Vec::new()),
            delete_gate_held: std::sync::atomic::AtomicBool::new(false),
        }
    }
    fn pause_next_resolve(&self) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
        let (seen, ready) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        *self.pause.lock().unwrap() = Some((seen, wait));
        (ready, release)
    }
}
impl SecretStore for CleanupProbeSecrets {
    fn set(&self, key: &str, value: &str) -> Result<(), SecretStoreError> {
        self.operations.lock().unwrap().push("set");
        self.inner.set(key, value)
    }
    fn resolve(&self, key: &str) -> Result<Option<String>, SecretStoreError> {
        let raw = self.inner.resolve(key)?;
        let pause = self.pause.lock().unwrap().take();
        if let Some((seen, wait)) = pause {
            seen.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(3)).unwrap();
        }
        Ok(raw)
    }
    fn exists(&self, key: &str) -> Result<bool, SecretStoreError> {
        self.inner.exists(key)
    }
    fn delete(&self, key: &str) -> Result<(), SecretStoreError> {
        self.delete_gate_held
            .store(ACCOUNT_SESSION_GATE.try_lock().is_err(), Ordering::SeqCst);
        self.operations.lock().unwrap().push("delete");
        self.inner.delete(key)
    }
}

#[test]
fn session_cleanup_corrupt_read_cannot_delete_later_valid_login() {
    let state = CloudState::with_origin("http://127.0.0.1:1");
    let secrets = CleanupProbeSecrets::new();
    secrets.inner.set(ACCOUNT_SESSION_REF, "{broken").unwrap();
    let (ready, release) = secrets.pause_next_resolve();
    std::thread::scope(|threads| {
        let read = threads.spawn(|| load_session(&secrets));
        ready.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(
            secrets.inner.entries.try_lock().is_ok(),
            "resolver released its map lock"
        );
        store_login_session(&state, &secrets, &stored_test_session()).unwrap();
        release.send(()).unwrap();
        assert!(read.join().unwrap().unwrap().is_none());
    });
    assert_eq!(
        load_session(&secrets).unwrap().unwrap().cookie,
        stored_test_session().cookie
    );
    assert_eq!(secrets.inner.deletions.load(Ordering::SeqCst), 0);
}

#[test]
fn session_cleanup_gate_excludes_login_between_comparison_and_delete() {
    let state = CloudState::with_origin("http://127.0.0.1:1");
    let secrets = CleanupProbeSecrets::new();
    store_session(&secrets.inner, &stored_test_session()).unwrap();
    let raw = secrets.inner.resolve(ACCOUNT_SESSION_REF).unwrap().unwrap();
    let (ready, release) = secrets.pause_next_resolve();
    let (attempted, attempt) = std::sync::mpsc::channel();
    std::thread::scope(|threads| {
        let cleanup = threads.spawn(|| clear_session_if_current(&secrets, &raw, Some((&state, 0))));
        ready.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(
            secrets.inner.entries.try_lock().is_ok(),
            "not protected by the map mutex"
        );
        let login = threads.spawn(|| {
            attempted
                .send(ACCOUNT_SESSION_GATE.try_lock().is_err())
                .unwrap();
            store_login_session(&state, &secrets, &stored_test_session())
        });
        let blocked = attempt.recv_timeout(Duration::from_secs(3)).unwrap();
        release.send(()).unwrap();
        assert!(cleanup.join().unwrap().unwrap());
        login.join().unwrap().unwrap();
        assert!(
            blocked,
            "production session gate was held during comparison"
        );
    });
    assert!(secrets.delete_gate_held.load(Ordering::SeqCst));
    assert_eq!(*secrets.operations.lock().unwrap(), ["delete", "set"]);
    assert!(load_session(&secrets).unwrap().is_some());
    assert_eq!(state.account_epoch.load(Ordering::SeqCst), 1);
}

#[test]
fn session_cleanup_raw_changes_and_independent_state_epochs_are_distinct() {
    let state = CloudState::with_origin("http://127.0.0.1:1");
    let other_state = CloudState::with_origin("http://127.0.0.1:1");
    let secrets = MemorySecrets::new();
    let other_secrets = MemorySecrets::new();
    store_login_session(&state, &secrets, &stored_test_session()).unwrap();
    store_login_session(&other_state, &other_secrets, &stored_test_session()).unwrap();
    let frozen = load_session_snapshot(&state, &secrets).unwrap().unwrap();
    let other_frozen = load_session_snapshot(&other_state, &other_secrets)
        .unwrap()
        .unwrap();
    // Change raw without changing this state's generation: raw comparison is necessary.
    store_session(
        &secrets,
        &next_cleanup_session(&frozen.session, "new-cookie"),
    )
    .unwrap();
    assert!(
        !clear_session_if_current(&secrets, &frozen.raw, Some((&state, frozen.epoch))).unwrap()
    );
    // A login in one test/store must not suppress valid cleanup in another.
    store_login_session(&state, &secrets, &stored_test_session()).unwrap();
    assert!(clear_session_if_current(
        &other_secrets,
        &other_frozen.raw,
        Some((&other_state, other_frozen.epoch))
    )
    .unwrap());
    assert!(secrets.exists(ACCOUNT_SESSION_REF).unwrap());
    assert!(!other_secrets.exists(ACCOUNT_SESSION_REF).unwrap());
}

#[test]
fn session_cleanup_current_status_expiry_and_offline_signout_still_delete() {
    rt().block_on(async {
        let server = spawn_mock_server();
        let state = CloudState::with_origin(&server.origin);
        let secrets = MemorySecrets::new();
        for status in [401, 200] {
            store_login_session(&state, &secrets, &stored_test_session()).unwrap();
            *server.get_session_override.lock().unwrap() =
                Some((status, r#"{"session":null}"#.into()));
            assert!(matches!(
                cloud_auth_status(&state, &secrets).await.unwrap(),
                CloudSessionStatus::Expired
            ));
            assert!(!secrets.exists(ACCOUNT_SESSION_REF).unwrap());
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let offline =
            CloudState::with_origin(&format!("http://{}", listener.local_addr().unwrap()));
        drop(listener);
        store_login_session(&offline, &secrets, &stored_test_session()).unwrap();
        assert!(!cloud_sign_out(&offline, &secrets).await.unwrap().revoked);
        assert!(!secrets.exists(ACCOUNT_SESSION_REF).unwrap());
    });
}

#[test]
fn session_cleanup_store_failures_release_gate_and_preserve_recovery() {
    struct FailOnceSecrets {
        inner: MemorySecrets,
        failure: Mutex<Option<&'static str>>,
    }
    impl FailOnceSecrets {
        fn check(&self, operation: &str) -> Result<(), SecretStoreError> {
            let mut failure = self.failure.lock().unwrap();
            if *failure == Some(operation) {
                *failure = None;
                Err(SecretStoreError::failure_for_test())
            } else {
                Ok(())
            }
        }
    }
    impl SecretStore for FailOnceSecrets {
        fn set(&self, key: &str, value: &str) -> Result<(), SecretStoreError> {
            self.check("set")?;
            self.inner.set(key, value)
        }
        fn resolve(&self, key: &str) -> Result<Option<String>, SecretStoreError> {
            self.check("resolve")?;
            self.inner.resolve(key)
        }
        fn exists(&self, key: &str) -> Result<bool, SecretStoreError> {
            self.inner.exists(key)
        }
        fn delete(&self, key: &str) -> Result<(), SecretStoreError> {
            self.check("delete")?;
            self.inner.delete(key)
        }
    }
    let state = CloudState::with_origin("http://127.0.0.1:1");
    let secrets = FailOnceSecrets {
        inner: MemorySecrets::new(),
        failure: Mutex::new(Some("set")),
    };
    assert!(store_login_session(&state, &secrets, &stored_test_session()).is_err());
    assert_eq!(state.account_epoch.load(Ordering::SeqCst), 0);
    store_login_session(&state, &secrets, &stored_test_session()).unwrap();
    *secrets.failure.lock().unwrap() = Some("resolve");
    assert!(load_session_snapshot(&state, &secrets).is_err());
    let frozen = load_session_snapshot(&state, &secrets).unwrap().unwrap();
    *secrets.failure.lock().unwrap() = Some("delete");
    assert!(clear_session_if_current(&secrets, &frozen.raw, Some((&state, frozen.epoch))).is_err());
    assert_eq!(
        secrets.resolve(ACCOUNT_SESSION_REF).unwrap().as_deref(),
        Some(frozen.raw.as_str())
    );
    assert!(clear_session_if_current(&secrets, &frozen.raw, Some((&state, frozen.epoch))).unwrap());
    secrets.inner.set(ACCOUNT_SESSION_REF, "{corrupt").unwrap();
    *secrets.failure.lock().unwrap() = Some("delete");
    assert!(
        load_session(&secrets).unwrap().is_none(),
        "corrupt cleanup failure stays best-effort"
    );
    assert!(secrets.exists(ACCOUNT_SESSION_REF).unwrap());
    assert!(load_session(&secrets).unwrap().is_none());
    assert!(!secrets.exists(ACCOUNT_SESSION_REF).unwrap());
}
