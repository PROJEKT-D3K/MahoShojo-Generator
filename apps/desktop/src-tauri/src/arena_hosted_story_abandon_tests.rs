use super::*;
use pending::{AbandonCandidate, AbandonFlight, AbandonRequest, AbandonSecret, AbandonState};

fn abandon_request(manifest: &pending::PendingManifest) -> AbandonRequest {
    AbandonRequest {
        key: manifest.key(),
        input_digest: manifest.input_digest.clone(),
        actor: manifest.actor.clone(),
    }
}
fn claimed_flight(
    state: &ArenaState,
    cloud: &CloudState,
    secrets: &dyn SecretStore,
    manifest: &pending::PendingManifest,
) -> (pending::CreatePermit, Arc<Mutex<Flight>>) {
    let guard = state.stories.pending_admission(manifest.product).unwrap();
    let funding = default_funding(false);
    let permit = state
        .stories
        .pending_claim_create(
            &guard,
            &manifest.key(),
            &manifest.actor,
            &manifest.input_digest,
            &story::intent_hash(&manifest.input_digest, &funding).unwrap(),
            funding,
        )
        .unwrap();
    let (attempt_id, input_digest) = permit.identity();
    let request = story_request(manifest, false);
    let flight = state
        .prepare_unchecked(
            &request,
            cloud,
            secrets,
            Some(story::Binding {
                attempt_id: attempt_id.into(),
                input_digest: input_digest.into(),
            }),
        )
        .unwrap();
    story::bind_existing(state, &guard, &request, &flight).unwrap();
    (permit, flight)
}
#[test]
fn abandon_exact_actor_product_matrix_releases_only_original_and_burns_permit() {
    for product in [Product::Battle, Product::Arena] {
        for account in [false, true] {
            let state = ArenaState::isolated();
            let cloud = CloudState::new().unwrap();
            let secrets = Secrets::default();
            secrets.set("provider:unrelated:api-key", KEY).unwrap();
            if account {
                login(&secrets, 42);
            }
            let other_product = if product == Product::Battle {
                Product::Arena
            } else {
                Product::Battle
            };
            secrets
                .set(other_product.slot(), "UNRELATED-OPAQUE-SLOT")
                .unwrap();
            let (manifest, parts) = candidate(product, account, false, story_input(false));
            seal(&state, &manifest, &parts);
            let (permit, flight) = claimed_flight(&state, &cloud, &secrets, &manifest);
            let subscription = Arc::new(CancellationToken::new());
            flight.lock().unwrap().subscription = Some(subscription.clone());
            let before_cookie = secrets.resolve("account-session:web-v1").unwrap();
            let result =
                abandon_story_pending(&state, &state.stories, &secrets, abandon_request(&manifest))
                    .unwrap();
            assert_eq!(result.state, AbandonState::Abandoned);
            assert_eq!(result.candidate, AbandonCandidate::Removed);
            assert_eq!(result.flight, AbandonFlight::Released);
            assert_eq!(
                result.secret,
                if account {
                    AbandonSecret::NotApplicable
                } else {
                    AbandonSecret::Cleared
                }
            );
            assert!(subscription.is_cancelled());
            assert!(state
                .is_current(product, &flight, &cloud, &secrets)
                .is_err());
            assert!(flight.lock().unwrap().anonymous.is_none());
            assert!(state
                .stories
                .pending_describe(manifest.product)
                .unwrap()
                .is_none());
            assert_eq!(
                secrets.resolve(other_product.slot()).unwrap().as_deref(),
                Some("UNRELATED-OPAQUE-SLOT")
            );
            assert_eq!(
                secrets
                    .resolve("provider:unrelated:api-key")
                    .unwrap()
                    .as_deref(),
                Some(KEY)
            );
            assert_eq!(
                secrets.resolve("account-session:web-v1").unwrap(),
                before_cookie
            );
            let guard = state.stories.pending_admission(manifest.product).unwrap();
            assert!(state
                .stories
                .pending_consume_create(
                    &guard,
                    &manifest.key(),
                    &manifest.actor,
                    &manifest.input_digest,
                    permit
                )
                .is_err());
            // A late header cannot repopulate the released original slot.
            assert!(state
                .capture_response_token(
                    product,
                    &flight,
                    &cloud,
                    &secrets,
                    &reqwest::header::HeaderMap::new()
                )
                .is_err());
        }
    }
}

#[test]
fn abandon_identity_mismatch_never_sets_intent_or_touches_credentials() {
    let state = ArenaState::isolated();
    let cloud = CloudState::new().unwrap();
    let secrets = Secrets::default();
    let (manifest, parts) = candidate(Product::Battle, false, false, story_input(false));
    seal(&state, &manifest, &parts);
    let (_, flight) = claimed_flight(&state, &cloud, &secrets, &manifest);
    let before = secrets.resolve(Product::Battle.slot()).unwrap();
    for mode in 0..5 {
        let mut request = abandon_request(&manifest);
        match mode {
            0 => request.key.request_id = "different_request_1234".into(),
            1 => request.key.pending_revision += 1,
            2 => request.key.product = pending::Product::Arena,
            3 => request.input_digest = format!("sha256:{}", "0".repeat(64)),
            _ => {
                request.actor = pending::Actor::Account {
                    expected_user_id: 42,
                }
            }
        }
        assert!(abandon_story_pending(&state, &state.stories, &secrets, request).is_err());
        assert!(
            !state
                .stories
                .pending_describe(manifest.product)
                .unwrap()
                .unwrap()
                .abandon_requested
        );
        assert_eq!(secrets.resolve(Product::Battle.slot()).unwrap(), before);
        assert!(state
            .is_current(Product::Battle, &flight, &cloud, &secrets)
            .is_ok());
    }
}

struct DeleteFailure {
    inner: Secrets,
    fail_delete: AtomicBool,
    removed_error: AtomicBool,
}
impl Default for DeleteFailure {
    fn default() -> Self {
        Self {
            inner: Secrets::default(),
            fail_delete: AtomicBool::new(false),
            removed_error: AtomicBool::new(false),
        }
    }
}
impl SecretStore for DeleteFailure {
    fn set(&self, k: &str, v: &str) -> Result<(), SecretStoreError> {
        self.inner.set(k, v)
    }
    fn resolve(&self, k: &str) -> Result<Option<String>, SecretStoreError> {
        self.inner.resolve(k)
    }
    fn exists(&self, k: &str) -> Result<bool, SecretStoreError> {
        self.inner.exists(k)
    }
    fn delete(&self, k: &str) -> Result<(), SecretStoreError> {
        if self.fail_delete.load(Ordering::SeqCst) {
            return Err(SecretStoreError::failure_for_test());
        }
        self.inner.delete(k)?;
        if self.removed_error.load(Ordering::SeqCst) {
            return Err(SecretStoreError::failure_for_test());
        }
        Ok(())
    }
}
#[test]
fn abandon_failed_secret_cleanup_survives_reopen_and_requires_same_explicit_identity() {
    let root = tempfile::tempdir().unwrap();
    let library = LocalLibrary::open(root.path()).unwrap();
    let state = ArenaState::new(library.shared_stories()).unwrap();
    let secrets = DeleteFailure::default();
    let cloud = CloudState::new().unwrap();
    let (manifest, parts) = candidate(Product::Battle, false, false, story_input(false));
    seal(&state, &manifest, &parts);
    let (permit, _) = claimed_flight(&state, &cloud, &secrets, &manifest);
    secrets.fail_delete.store(true, Ordering::SeqCst);
    let result =
        abandon_story_pending(&state, &state.stories, &secrets, abandon_request(&manifest))
            .unwrap();
    assert_eq!(result.state, AbandonState::CleanupPending);
    assert_eq!(result.secret, AbandonSecret::Unresolved);
    assert_eq!(result.candidate, AbandonCandidate::Retained);
    let snapshot = state
        .stories
        .pending_describe(manifest.product)
        .unwrap()
        .unwrap();
    assert!(snapshot.abandon_requested);
    assert_eq!(
        state
            .stories
            .pending_read(&manifest.key(), pending::PendingKind::Input, 0, 64)
            .unwrap(),
        parts[0].1.as_bytes()[..64]
    );
    assert!(state
        .prepare(
            &story_control(&manifest, "lookup-request"),
            &cloud,
            &secrets
        )
        .is_err());
    assert!(state.stories.pending_begin(manifest.clone()).is_err());
    {
        let guard = state.stories.pending_admission(manifest.product).unwrap();
        assert!(state
            .stories
            .pending_consume_create(
                &guard,
                &manifest.key(),
                &manifest.actor,
                &manifest.input_digest,
                permit
            )
            .is_err());
    }
    drop(state);
    drop(library);
    let library = LocalLibrary::open(root.path()).unwrap();
    let state = ArenaState::new(library.shared_stories()).unwrap();
    assert!(
        state
            .stories
            .pending_describe(manifest.product)
            .unwrap()
            .unwrap()
            .abandon_requested
    );
    assert!(secrets.resolve(Product::Battle.slot()).unwrap().is_some());
    secrets.fail_delete.store(false, Ordering::SeqCst);
    let result =
        abandon_story_pending(&state, &state.stories, &secrets, abandon_request(&manifest))
            .unwrap();
    assert_eq!(result.state, AbandonState::Abandoned);
    assert_eq!(result.secret, AbandonSecret::Cleared);
    assert!(secrets.resolve(Product::Battle.slot()).unwrap().is_none());
}

#[test]
fn abandon_positive_readback_handles_missing_and_failed_delete_ack() {
    for remove_first in [false, true] {
        let state = ArenaState::isolated();
        let cloud = CloudState::new().unwrap();
        let secrets = DeleteFailure::default();
        let (manifest, parts) = candidate(Product::Battle, false, false, story_input(false));
        seal(&state, &manifest, &parts);
        let _ = claimed_flight(&state, &cloud, &secrets, &manifest);
        if remove_first {
            secrets.inner.delete(Product::Battle.slot()).unwrap();
        } else {
            secrets.removed_error.store(true, Ordering::SeqCst);
        }
        let result =
            abandon_story_pending(&state, &state.stories, &secrets, abandon_request(&manifest))
                .unwrap();
        assert_eq!(result.state, AbandonState::Abandoned);
        assert_eq!(
            result.secret,
            if remove_first {
                AbandonSecret::Absent
            } else {
                AbandonSecret::Cleared
            }
        );
    }
}

#[test]
fn abandon_preserves_unbound_or_replaced_secret_then_new_create_requires_explicit_replacement() {
    for mode in 0..4 {
        let state = ArenaState::isolated();
        let cloud = CloudState::new().unwrap();
        let secrets = Secrets::default();
        let (manifest, parts) = candidate(Product::Battle, false, false, story_input(false));
        seal(&state, &manifest, &parts);
        let _ = claimed_flight(&state, &cloud, &secrets, &manifest);
        let mut record = load_anonymous(Product::Battle, &secrets).unwrap().unwrap();
        match mode {
            0 => record.story_binding = None,
            1 => {
                record.story_binding.as_mut().unwrap().attempt_id =
                    format!("{}-{}", "a".repeat(32), "b".repeat(32))
            }
            2 => {
                record.story_binding.as_mut().unwrap().input_digest =
                    format!("sha256:{}", "0".repeat(64))
            }
            _ => record.request_id = "newer_anonymous_request_1234".into(),
        }
        save_anonymous(&record, &secrets).unwrap();
        let before = secrets.resolve(Product::Battle.slot()).unwrap();
        let result =
            abandon_story_pending(&state, &state.stories, &secrets, abandon_request(&manifest))
                .unwrap();
        assert_eq!(result.state, AbandonState::Abandoned);
        assert_eq!(result.secret, AbandonSecret::ForeignRetained);
        assert_eq!(secrets.resolve(Product::Battle.slot()).unwrap(), before);
        let mut next: ArenaRequest =
            serde_json::from_value(fixture()["validOperations"][0].clone()).unwrap();
        // Use a known ordinary create shape rather than making the story helper
        // manufacture another pending or revive the abandoned originals.
        if let ArenaRequest::CreateStream {
            request_id,
            actor,
            replace_request_id,
            ..
        } = &mut next
        {
            *request_id = "new_explicit_request_1234".into();
            *actor = Actor::Anonymous;
            *replace_request_id = None;
        } else {
            panic!("fixture must begin with create-stream");
        }
        assert!(state.prepare(&next, &cloud, &secrets).is_err());
        if let ArenaRequest::CreateStream {
            replace_request_id, ..
        } = &mut next
        {
            *replace_request_id = Some(record.request_id);
        }
        assert!(state.prepare(&next, &cloud, &secrets).is_ok());
    }
}

#[test]
fn abandon_input_only_cannot_clear_anonymous_same_name_slot() {
    let state = ArenaState::isolated();
    let secrets = Secrets::default();
    let (manifest, parts) = candidate(Product::Battle, false, false, story_input(false));
    seal(&state, &manifest, &parts);
    let record = AnonymousRecord {
        version: 1,
        product: Product::Battle,
        request_id: manifest.request_id.clone(),
        bootstrap: bootstrap_uuid().unwrap(),
        first_dispatched_at: now_ms(),
        token: None,
        token_expires_at: None,
        story_binding: None,
    };
    save_anonymous(&record, &secrets).unwrap();
    let before = secrets.resolve(Product::Battle.slot()).unwrap();
    let result =
        abandon_story_pending(&state, &state.stories, &secrets, abandon_request(&manifest))
            .unwrap();
    assert_eq!(result.secret, AbandonSecret::ForeignRetained);
    assert_eq!(secrets.resolve(Product::Battle.slot()).unwrap(), before);
}

#[test]
fn abandon_releases_native_flight_when_post_prepare_actor_check_failed_before_bind() {
    let state = ArenaState::isolated();
    let cloud = CloudState::new().unwrap();
    let secrets = Secrets::default();
    let (manifest, parts) = candidate(Product::Battle, false, false, story_input(false));
    seal(&state, &manifest, &parts);
    let flight = {
        let guard = state.stories.pending_admission(manifest.product).unwrap();
        let funding = default_funding(false);
        let permit = state
            .stories
            .pending_claim_create(
                &guard,
                &manifest.key(),
                &manifest.actor,
                &manifest.input_digest,
                &story::intent_hash(&manifest.input_digest, &funding).unwrap(),
                funding,
            )
            .unwrap();
        let (attempt_id, input_digest) = permit.identity();
        let flight = state
            .prepare_unchecked(
                &story_request(&manifest, false),
                &cloud,
                &secrets,
                Some(story::Binding {
                    attempt_id: attempt_id.into(),
                    input_digest: input_digest.into(),
                }),
            )
            .unwrap();
        assert!(flight.lock().unwrap().story.is_some());
        // Login changed immediately after Native installed the Flight and before
        // check_actor/bind_existing. That preflight returns stale with no bind.
        login(&secrets, 42);
        assert!(state
            .is_current(Product::Battle, &flight, &cloud, &secrets)
            .is_err());
        flight
    };
    let token = Arc::new(CancellationToken::new());
    flight.lock().unwrap().subscription = Some(token.clone());
    let current_login = secrets.resolve("account-session:web-v1").unwrap();
    let result =
        abandon_story_pending(&state, &state.stories, &secrets, abandon_request(&manifest))
            .unwrap();
    assert_eq!(result.state, AbandonState::Abandoned);
    assert_eq!(result.flight, AbandonFlight::Released);
    assert_eq!(result.secret, AbandonSecret::Cleared);
    assert!(token.is_cancelled());
    assert!(flight.lock().unwrap().anonymous.is_none());
    assert!(state.flights.lock().unwrap().is_empty());
    assert_eq!(
        secrets.resolve("account-session:web-v1").unwrap(),
        current_login
    );
}

#[test]
fn abandon_reopen_after_secret_removed_before_final_database_cleanup_is_safe() {
    let root = tempfile::tempdir().unwrap();
    let library = LocalLibrary::open(root.path()).unwrap();
    let state = ArenaState::new(library.shared_stories()).unwrap();
    let secrets = Secrets::default();
    let cloud = CloudState::new().unwrap();
    let (manifest, parts) = candidate(Product::Battle, false, false, story_input(false));
    seal(&state, &manifest, &parts);
    let _ = claimed_flight(&state, &cloud, &secrets, &manifest);
    {
        let guard = state.stories.pending_admission(manifest.product).unwrap();
        state
            .stories
            .pending_begin_abandon(&guard, &abandon_request(&manifest))
            .unwrap();
    }
    // Simulates the durable resources left at the post-secret/pre-SQLite crash
    // boundary. Ordinary process shutdown cannot substitute for the stored bit.
    secrets.delete(Product::Battle.slot()).unwrap();
    drop(state);
    drop(library);
    let library = LocalLibrary::open(root.path()).unwrap();
    let state = ArenaState::new(library.shared_stories()).unwrap();
    assert!(
        state
            .stories
            .pending_describe(manifest.product)
            .unwrap()
            .unwrap()
            .abandon_requested
    );
    let result =
        abandon_story_pending(&state, &state.stories, &secrets, abandon_request(&manifest))
            .unwrap();
    assert_eq!(result.state, AbandonState::Abandoned);
    assert_eq!(result.secret, AbandonSecret::Absent);
    assert!(state
        .stories
        .pending_describe(manifest.product)
        .unwrap()
        .is_none());
}

struct AbandoningSink<'a> {
    state: &'a ArenaState,
    secrets: &'a dyn SecretStore,
    request: AbandonRequest,
    events: Mutex<Vec<Value>>,
    abandoned: AtomicBool,
}
impl EventSink for AbandoningSink<'_> {
    fn send(&self, event: ChannelEvent) -> Result<(), ArenaError> {
        let first_fragment = matches!(event, ChannelEvent::SseFragment { .. });
        self.events
            .lock()
            .unwrap()
            .push(serde_json::to_value(event).unwrap());
        if first_fragment && !self.abandoned.swap(true, Ordering::SeqCst) {
            let outcome = abandon_story_pending(
                self.state,
                &self.state.stories,
                self.secrets,
                self.request.clone(),
            )
            .unwrap();
            assert_eq!(outcome.state, AbandonState::Abandoned);
        }
        Ok(())
    }
}
#[tokio::test]
async fn abandon_first_sse_callback_rejects_second_same_chunk_event_after_secret_erasure() {
    let srv = server(2, |index, request| {
        if index == 0 {
            return story_capability();
        }
        let bootstrap = request.headers[ACTOR_HEADER].clone();
        let mut reply = story_sse();
        // All bytes in one small body write. parser.push produces both decoded
        // events before sink callback 1 abandons the original Native Flight.
        reply.body = event("1-0", "markdown", json!({"chunk":"safe-first-event"}))
            + &event("2-0", "markdown", json!({"chunk":bootstrap}))
            + &event("3-0", "done", json!({"ok":true,"status":"completed"}));
        reply
    })
    .await;
    let state = ArenaState::with_origin(srv.origin.clone());
    let secrets = Secrets::default();
    let cloud = CloudState::new().unwrap();
    let (manifest, parts) = candidate(Product::Battle, false, false, story_input(false));
    seal(&state, &manifest, &parts);
    let sink = AbandoningSink {
        state: &state,
        secrets: &secrets,
        request: abandon_request(&manifest),
        events: Mutex::new(Vec::new()),
        abandoned: AtomicBool::new(false),
    };
    assert!(stream(
        &state,
        &cloud,
        &secrets,
        story_request(&manifest, false),
        &sink
    )
    .await
    .is_err());
    srv.task.await.unwrap();
    let events = sink.events.lock().unwrap();
    let text = serde_json::to_string(&*events).unwrap();
    assert!(sink.abandoned.load(Ordering::SeqCst));
    assert!(text.contains("safe-first-event"));
    assert!(!text.contains("bootstrap."));
    assert_eq!(
        events
            .iter()
            .filter(|event| event["kind"] == "sse-fragment")
            .count(),
        1
    );
    assert!(!events.iter().any(|event| event["kind"] == "stream-end"));
    assert!(state.flights.lock().unwrap().is_empty());
    assert!(secrets.resolve(Product::Battle.slot()).unwrap().is_none());
}

#[test]
fn revoked_decoded_events_raw_json_auth_and_capture_fail_closed_without_harming_new_flight() {
    let state = ArenaState::isolated();
    let secrets = Secrets::default();
    let cloud = CloudState::new().unwrap();
    let (manifest, parts) = candidate(Product::Battle, false, false, story_input(false));
    seal(&state, &manifest, &parts);
    let (_, old) = claimed_flight(&state, &cloud, &secrets, &manifest);
    let bootstrap = old
        .lock()
        .unwrap()
        .anonymous
        .as_ref()
        .unwrap()
        .bootstrap
        .clone();
    old.lock().unwrap().secrets_to_redact.push(KEY.into());
    let queued = ChannelEvent::SseFragment {
        request_id: manifest.request_id.clone(),
        sequence: 9,
        text: format!("queued {bootstrap} {KEY}"),
        r#final: true,
    };
    // The callback was already decoded/current-checked, but has not reached the
    // renderer. Revocation must still fence it after all plaintext was erased.
    state
        .is_current(Product::Battle, &old, &cloud, &secrets)
        .unwrap();
    abandon_story_pending(&state, &state.stories, &secrets, abandon_request(&manifest)).unwrap();
    assert!(old.lock().unwrap().revoked);
    assert!(old.lock().unwrap().secrets_to_redact.is_empty());
    let sink = Sink::default();
    assert!(emit(&sink, queued, &old).is_err());
    assert!(emit_block(
        &sink,
        &manifest.request_id,
        &mut 0,
        &"safe".repeat(IPC_TEXT_BYTES),
        &old
    )
    .is_err());
    assert!(
        json_delivery::reject_json_secret_echo(&json!({"data":bootstrap}).to_string(), &old)
            .is_err()
    );
    assert!(json_delivery::reject_json_secret_echo("{\"safe\":true}", &old).is_err());
    assert!(state
        .authenticated(reqwest::Method::GET, "/synthetic-only", &old)
        .is_err());
    assert!(capture_token(&reqwest::header::HeaderMap::new(), &old, &secrets).is_err());
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(ACTOR_HEADER, "invalid-synthetic-token".parse().unwrap());
    assert!(capture_token(&headers, &old, &secrets).is_err());
    assert!(sink.events.lock().unwrap().is_empty());
    let mut next: ArenaRequest =
        serde_json::from_value(fixture()["validOperations"][0].clone()).unwrap();
    if let ArenaRequest::CreateStream {
        request_id,
        actor,
        replace_request_id,
        ..
    } = &mut next
    {
        *request_id = "next_distinct_request_1234".into();
        *actor = Actor::Anonymous;
        *replace_request_id = None;
    } else {
        panic!("fixture must start with create-stream");
    }
    let fresh = state.prepare(&next, &cloud, &secrets).unwrap();
    assert!(!Arc::ptr_eq(&fresh, &old));
    assert!(!fresh.lock().unwrap().revoked);
    state
        .is_current(Product::Battle, &fresh, &cloud, &secrets)
        .unwrap();
    emit(
        &sink,
        ChannelEvent::StreamEnd {
            request_id: "next_distinct_request_1234".into(),
            sequence: 0,
        },
        &fresh,
    )
    .unwrap();
    assert_eq!(sink.events.lock().unwrap().len(), 1);
    assert!(emit(
        &sink,
        ChannelEvent::StreamEnd {
            request_id: manifest.request_id,
            sequence: 10
        },
        &old
    )
    .is_err());
}
