use super::*;
use crate::arena_story::digest;
use crate::arena_story::pending::{Actor, PendingManifest, PendingPart, RoleState, WriteOptions};
use crate::library::LocalLibrary;
use serde_json::json;

fn fixture(markdown: &str) -> (tempfile::TempDir, LocalLibrary, PendingManifest, String) {
    let root = tempfile::tempdir().unwrap();
    let library = LocalLibrary::open(root.path()).unwrap();
    // Opaque user data, Unicode escapes and whitespace must remain original bytes.
    let input = r#" {"version":1,"sessionId":"pending-story","generationRequestId":"pending-request-1","action":"start","chapterIndex":1,"chapterContext":{"recentWindow":[],"workingCombatants":[{"data":{"name":"角色\ud800","x":1,"x":2}}]},"seed":{"combatants":[{"data":{"name":"角色\ud800","x":1,"x":2}}],"mode":"classic","storyLength":"default","language":"zh-CN","settings":{"readArenaHistory":false,"writeArenaHistory":false,"readCurrentState":true,"writeCurrentState":false,"readNarrativeHistory":false,"writeNarrativeHistory":false}}} "#.to_string();
    let manifest = PendingManifest {
        local_assembly: None,
        version: 1,
        product: Product::Battle,
        request_id: "pending-request-1".into(),
        actor: Actor::Anonymous,
        pending_revision: 1,
        session_id: "pending-story".into(),
        operation_id: "pending-operation".into(),
        output_checkpoint_id: "pending-output".into(),
        initial_checkpoint_id: Some("pending-input".into()),
        created_at: 100,
        expected_revision: 0,
        expected_last_chapter_id: None,
        last_input_checkpoint_id: "pending-input".into(),
        input_digest: digest(input.as_bytes()),
        write_options: WriteOptions {
            write_arena_history: false,
            write_current_state: false,
            write_narrative_history: false,
        },
        model_completed: true,
        role_state: RoleState::NotRequested,
        role_input_digest: None,
        parts: [
            (PendingKind::Input, input.as_str()),
            (PendingKind::Markdown, markdown),
        ]
        .into_iter()
        .map(|(kind, bytes)| PendingPart {
            kind,
            byte_length: bytes.len() as u64,
            digest: digest(bytes.as_bytes()),
        })
        .collect(),
        commit_manifest: None,
    };
    let token = library
        .stories()
        .pending_begin(manifest.clone())
        .unwrap()
        .token;
    for (kind, bytes) in [
        (PendingKind::Input, input.as_bytes()),
        (PendingKind::Markdown, markdown.as_bytes()),
    ] {
        for (index, chunk) in bytes.chunks(CANDIDATE_FRAME_BYTES).enumerate() {
            library
                .stories()
                .pending_append(&token, kind, (index * CANDIDATE_FRAME_BYTES) as u64, chunk)
                .unwrap();
        }
    }
    library.stories().pending_seal(&token).unwrap();
    (root, library, manifest, input)
}

fn source(manifest: &PendingManifest, kind: PendingKind) -> StoryPendingExportSource {
    let part = manifest
        .parts
        .iter()
        .find(|part| part.kind == kind)
        .unwrap();
    StoryPendingExportSource::Part {
        key: manifest.key(),
        input_digest: manifest.input_digest.clone(),
        kind,
        byte_length: part.byte_length,
        digest: part.digest.clone(),
    }
}
fn manifest_source(manifest: &PendingManifest) -> StoryPendingExportSource {
    StoryPendingExportSource::Manifest {
        key: manifest.key(),
        input_digest: manifest.input_digest.clone(),
    }
}
fn entries(root: &Path) -> Vec<PathBuf> {
    fs::read_dir(root.join("exports"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect()
}
fn target(store: &StoryStore) -> PathBuf {
    store
        .markdown_export
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .target
        .clone()
}
fn advance_all(store: &StoryStore, begin: &StoryPendingExportBegin, now: Instant) {
    let mut offset = 0;
    while offset < begin.expected_byte_length {
        let progress = store
            .advance_pending_export(&begin.token, offset, now)
            .unwrap();
        assert_eq!(progress.token, begin.token);
        assert!(progress.received_bytes > offset);
        assert!(progress.received_bytes - offset <= pending_export::FRAME_BYTES as u64);
        offset = progress.received_bytes;
    }
    assert_eq!(offset, begin.expected_byte_length);
}
fn abandon(store: &StoryStore, manifest: &PendingManifest) {
    let request = crate::arena_story::pending::AbandonRequest {
        key: manifest.key(),
        input_digest: manifest.input_digest.clone(),
        actor: manifest.actor.clone(),
    };
    let guard = store.pending_admission(manifest.product).unwrap();
    store.pending_begin_abandon(&guard, &request).unwrap();
    // Storage-only fixture has no Flight or OS-secret. Both preconditions hold.
    store.pending_finish_abandon(&guard, &request).unwrap();
}

#[test]
fn pending_export_native_frames_preserve_unicode_nul_and_opaque_json_bytes() {
    let markdown = "🙂字\0\n".repeat(pending_export::FRAME_BYTES / 4);
    let (root, library, manifest, input) = fixture(&markdown);
    let store = library.stories();
    let now = Instant::now();
    for (kind, expected) in [
        (PendingKind::Input, input.as_bytes()),
        (PendingKind::Markdown, markdown.as_bytes()),
    ] {
        let begin = store
            .begin_pending_export(source(&manifest, kind), now)
            .unwrap();
        assert_eq!(begin.expected_byte_length, expected.len() as u64);
        assert_eq!(begin.digest, digest(expected));
        assert!(begin.token.starts_with(&format!("{}-", store.instance)));
        let path = target(store);
        assert!(!path.exists());
        advance_all(store, &begin, now);
        assert!(!path.exists());
        let receipt = store.end_pending_export(&begin.token, now).unwrap();
        assert_eq!(receipt.token, begin.token);
        assert_eq!(receipt.digest, begin.digest);
        assert_eq!(receipt.byte_length, begin.expected_byte_length);
        assert_eq!(fs::read(&receipt.absolute_path).unwrap(), expected);
        assert!(Path::new(&receipt.absolute_path).is_absolute());
        assert!(path
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("story-pending-"));
    }
    assert_eq!(entries(root.path()).len(), 2);
    assert_eq!(
        lock_connection(&store.connection)
            .unwrap()
            .query_row("SELECT count(*) FROM arena_story_session", [], |row| row
                .get::<_, u64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn pending_export_source_is_closed_and_identity_hash_length_are_exact() {
    let (root, library, manifest, _) = fixture("original");
    let store = library.stories();
    let now = Instant::now();
    let wire = serde_json::to_value(source(&manifest, PendingKind::Markdown)).unwrap();
    assert_eq!(wire["scope"], "pending-part");
    assert_eq!(wire["inputDigest"], manifest.input_digest);
    assert_eq!(wire["byteLength"], 8);
    for (field, value) in [
        ("path", json!("/tmp/other")),
        ("bytes", json!([1])),
        ("length", json!(1)),
        ("createClaim", json!({})),
    ] {
        let mut malicious = wire.clone();
        malicious[field] = value;
        assert!(serde_json::from_value::<StoryPendingExportSource>(malicious).is_err());
    }
    for mutation in [
        "product",
        "request",
        "revision",
        "inputDigest",
        "digest",
        "byteLength",
        "kind",
    ] {
        let mut changed = wire.clone();
        match mutation {
            "product" => changed["key"]["product"] = json!("arena"),
            "request" => changed["key"]["requestId"] = json!("different-request"),
            "revision" => changed["key"]["pendingRevision"] = json!(2),
            "inputDigest" | "digest" => changed[mutation] = json!(digest(b"different")),
            "byteLength" => changed[mutation] = json!(7),
            "kind" => changed[mutation] = json!("reasoning"),
            _ => unreachable!(),
        }
        assert!(matches!(
            store.begin_pending_export(serde_json::from_value(changed).unwrap(), now),
            Err(StoryError::Stale | StoryError::Missing)
        ));
        assert!(entries(root.path()).is_empty());
    }
    let mut bad_scope = wire.clone();
    bad_scope["scope"] = json!("file");
    assert!(serde_json::from_value::<StoryPendingExportSource>(bad_scope).is_err());
    let mut bad_kind = wire;
    bad_kind["kind"] = json!("../../secrets");
    assert!(serde_json::from_value::<StoryPendingExportSource>(bad_kind).is_err());
}

#[test]
fn pending_export_manifest_is_small_allowlisted_and_non_executable() {
    let (_root, library, manifest, _) = fixture("original");
    let store = library.stories();
    let now = Instant::now();
    let claim = json!({"version":1,"attemptId":format!("{}-{}",store.instance,"f".repeat(32)),
        "storyProtocolVersion":"arena-story-v1","inputDigest":manifest.input_digest,
        "clientBodyHash":"a".repeat(64),"funding":{"mode":"system","providerId":"system","modelId":"CLAIM_CANARY"},"observedGeneration":null});
    lock_connection(&store.connection).unwrap().execute(
        "UPDATE arena_story_pending SET create_claim=?1,save_attempt='SAVE_CANARY',restored=1,abandon_requested=1 WHERE active=1",
        [claim.to_string()]).unwrap();
    for item in [
        source(&manifest, PendingKind::Markdown),
        manifest_source(&manifest),
    ] {
        let begin = store.begin_pending_export(item.clone(), now).unwrap();
        advance_all(store, &begin, now);
        let receipt = store.end_pending_export(&begin.token, now).unwrap();
        let bytes = fs::read(receipt.absolute_path).unwrap();
        if matches!(item, StoryPendingExportSource::Manifest { .. }) {
            assert!(bytes.len() <= crate::arena_story::pending::METADATA_BYTES);
            assert_eq!(digest(&bytes), receipt.digest);
            let text = String::from_utf8(bytes).unwrap();
            for excluded in [
                "createClaim",
                "actor",
                "funding",
                "saveAttemptId",
                "CLAIM_CANARY",
                "SAVE_CANARY",
            ] {
                assert!(!text.contains(excluded), "{excluded}");
            }
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(value["format"], "arena-story-pending-originals-v1");
            assert_eq!(
                value["parts"],
                serde_json::to_value(&manifest.parts).unwrap()
            );
            assert_eq!(value["restored"], true);
            assert_eq!(value["abandonRequested"], true);
            assert_eq!(value["saveAttemptPresent"], true);
        } else {
            assert_eq!(bytes, b"original");
        }
    }
}

#[test]
fn pending_export_and_story_export_cannot_mix_sources_or_double_reserve() {
    let (root, library, manifest, _) = fixture("original");
    let store = library.stories();
    let now = Instant::now();
    let begin = store
        .begin_pending_export(source(&manifest, PendingKind::Markdown), now)
        .unwrap();
    assert_eq!(
        store.begin_pending_export(manifest_source(&manifest), now),
        Err(StoryError::Busy)
    );
    assert_eq!(
        store.append_markdown_export(&begin.token, 0, b"original", now),
        Err(StoryError::Invalid)
    );
    assert_eq!(
        store.end_markdown_export(&begin.token, &digest(b"original"), now),
        Err(StoryError::Invalid)
    );
    assert_eq!(
        store.advance_pending_export("wrong-token", 0, now),
        Err(StoryError::Stale)
    );
    assert_eq!(
        store.expire_markdown_export("wrong-token", now + IDLE_TIMEOUT),
        Ok(None)
    );
    store.abort_pending_export("wrong-token").unwrap();
    advance_all(store, &begin, now);
    store.end_pending_export(&begin.token, now).unwrap();
    assert_eq!(entries(root.path()).len(), 1);
    // Existing full-story fixtures exercise the inverse route without faking a session.
    let (_story_root, story_library) = super::tests::library();
    let story = story_library.stories();
    let token = super::tests::begin(story, b"abc", now);
    assert_eq!(
        story.advance_pending_export(&token, 0, now),
        Err(StoryError::Invalid)
    );
    assert_eq!(
        story.end_pending_export(&token, now),
        Err(StoryError::Invalid)
    );
    assert_eq!(story.abort_pending_export(&token), Err(StoryError::Invalid));
    story
        .append_markdown_export(&token, 0, b"abc", now)
        .unwrap();
    story
        .end_markdown_export(&token, &digest(b"abc"), now)
        .unwrap();
}

#[test]
fn pending_export_invalid_offset_incomplete_end_and_expiry_do_not_publish() {
    let (root, library, manifest, _) = fixture("original");
    let store = library.stories();
    let now = Instant::now();
    let begin = store
        .begin_pending_export(source(&manifest, PendingKind::Markdown), now)
        .unwrap();
    let late = now + IDLE_TIMEOUT - Duration::from_secs(1);
    assert_eq!(
        store.advance_pending_export(&begin.token, 1, late),
        Err(StoryError::Invalid)
    );
    assert_eq!(
        store.end_pending_export(&begin.token, late),
        Err(StoryError::Incomplete)
    );
    assert_eq!(
        store.expire_markdown_export(&begin.token, now + IDLE_TIMEOUT),
        Ok(None)
    );
    assert!(entries(root.path()).is_empty());
    assert_eq!(
        store.end_pending_export(&begin.token, now),
        Err(StoryError::Stale)
    );
    let current = store
        .begin_pending_export(source(&manifest, PendingKind::Markdown), now)
        .unwrap();
    store.abort_pending_export(&begin.token).unwrap();
    advance_all(store, &current, now);
    assert_eq!(
        store.advance_pending_export(&current.token, current.expected_byte_length, now),
        Err(StoryError::Invalid)
    );
    store.abort_pending_export(&current.token).unwrap();
    assert!(entries(root.path()).is_empty());
}

#[test]
fn pending_export_byte_corruption_cannot_pass_native_digest_check() {
    let (root, library, manifest, _) = fixture("original");
    let store = library.stories();
    let now = Instant::now();
    let begin = store
        .begin_pending_export(source(&manifest, PendingKind::Markdown), now)
        .unwrap();
    lock_connection(&store.connection)
        .unwrap()
        .execute(
            "UPDATE arena_story_pending_part SET payload=?1 WHERE kind='markdown'",
            [b"tampered".as_slice()],
        )
        .unwrap();
    advance_all(store, &begin, now);
    assert_eq!(
        store.end_pending_export(&begin.token, now),
        Err(StoryError::Corrupt)
    );
    assert!(entries(root.path()).is_empty());
}

#[test]
fn pending_export_incomplete_sealed_part_and_declaration_corruption_are_rejected() {
    for column in ["received_bytes", "digest"] {
        let (root, library, manifest, _) = fixture("original");
        let store = library.stories();
        let connection = lock_connection(&store.connection).unwrap();
        if column == "received_bytes" {
            connection
                .execute(
                    "UPDATE arena_story_pending_part SET received_bytes=0 WHERE kind='markdown'",
                    [],
                )
                .unwrap();
        } else {
            connection
                .execute(
                    "UPDATE arena_story_pending_part SET digest=?1 WHERE kind='markdown'",
                    [digest(b"wrong")],
                )
                .unwrap();
        }
        drop(connection);
        assert_eq!(
            store.begin_pending_export(source(&manifest, PendingKind::Markdown), Instant::now()),
            Err(StoryError::Corrupt)
        );
        assert!(entries(root.path()).is_empty());
    }
}

#[test]
fn pending_export_abandon_after_begin_or_during_fsync_prevents_late_publication() {
    for during_sync in [false, true] {
        let (root, library, manifest, _) = fixture("original");
        let store = library.stories();
        let now = Instant::now();
        let begin = store
            .begin_pending_export(source(&manifest, PendingKind::Markdown), now)
            .unwrap();
        if during_sync {
            advance_all(store, &begin, now);
            let mut hook = |point, _: &mut File| {
                if point == IoPoint::Sync {
                    abandon(store, &manifest);
                }
                Ok(())
            };
            assert_eq!(
                store.end_export_with_hook(&begin.token, None, now, &mut hook),
                Err(StoryError::Missing)
            );
        } else {
            abandon(store, &manifest);
            assert_eq!(
                store.advance_pending_export(&begin.token, 0, now),
                Err(StoryError::Missing)
            );
        }
        assert!(entries(root.path()).is_empty());
        assert_eq!(
            store.end_pending_export(&begin.token, now),
            Err(StoryError::Stale)
        );
    }
}

#[test]
fn pending_export_publication_holds_same_product_admission_until_visible() {
    let (_root, library, manifest, _) = fixture("original");
    let store = library.stories();
    let now = Instant::now();
    let begin = store
        .begin_pending_export(source(&manifest, PendingKind::Markdown), now)
        .unwrap();
    advance_all(store, &begin, now);
    let mut reached = false;
    let mut hook = |point, _: &mut File| {
        if point == IoPoint::Persist {
            reached = true;
            assert!(matches!(
                store.pending_admission[0].try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            ));
        }
        Ok(())
    };
    let receipt = store
        .end_export_with_hook(&begin.token, None, now, &mut hook)
        .unwrap();
    assert!(reached);
    abandon(store, &manifest);
    assert_eq!(fs::read(receipt.absolute_path).unwrap(), b"original");
}

#[test]
fn pending_export_replacement_and_manifest_status_changes_reject_exact_end() {
    for change_revision in [false, true] {
        let (root, library, mut manifest, _) = fixture("original");
        let store = library.stories();
        let now = Instant::now();
        let begin = store
            .begin_pending_export(
                if change_revision {
                    source(&manifest, PendingKind::Markdown)
                } else {
                    manifest_source(&manifest)
                },
                now,
            )
            .unwrap();
        advance_all(store, &begin, now);
        let connection = lock_connection(&store.connection).unwrap();
        if change_revision {
            manifest.pending_revision = 2;
            connection
                .execute(
                    "UPDATE arena_story_pending SET revision=2,metadata=?1 WHERE active=1",
                    [serde_json::to_string(&manifest).unwrap()],
                )
                .unwrap();
        } else {
            connection
                .execute(
                    "UPDATE arena_story_pending SET abandon_requested=1 WHERE active=1",
                    [],
                )
                .unwrap();
        }
        drop(connection);
        assert_eq!(
            store.end_pending_export(&begin.token, now),
            Err(StoryError::Stale)
        );
        assert!(entries(root.path()).is_empty());
    }
}

#[test]
fn pending_export_maintenance_is_retryable_and_files_have_individual_receipts() {
    let (root, library, manifest, _) = fixture("original");
    let store = library.stories();
    let now = Instant::now();
    let maintenance = library.enter_maintenance("pending-export-test").unwrap();
    let begin = store
        .begin_pending_export(source(&manifest, PendingKind::Markdown), now)
        .unwrap();
    advance_all(store, &begin, now);
    assert_eq!(
        store.end_pending_export(&begin.token, now),
        Err(StoryError::Maintenance)
    );
    assert!(!target(store).exists());
    drop(maintenance);
    let receipt = store.end_pending_export(&begin.token, now).unwrap();
    let next = store
        .begin_pending_export(manifest_source(&manifest), now)
        .unwrap();
    advance_all(store, &next, now);
    store.abort_pending_export(&next.token).unwrap();
    assert_eq!(
        entries(root.path()),
        vec![PathBuf::from(receipt.absolute_path)]
    );
}

#[test]
fn pending_export_reuses_disk_space_no_clobber_and_io_failure_cleanup() {
    for failure in [IoPoint::Write, IoPoint::Sync, IoPoint::Persist] {
        let (root, library, manifest, _) = fixture("original");
        let store = library.stories();
        let now = Instant::now();
        let source = source(&manifest, PendingKind::Markdown);
        assert_eq!(
            store.begin_pending_export_with_space(source.clone(), now, &mut |_| Ok(0)),
            Err(StoryError::ExportNoSpace)
        );
        assert!(entries(root.path()).is_empty());
        let begin = store.begin_pending_export(source, now).unwrap();
        let mut hook = |point, file: &mut File| {
            if point == failure {
                if point == IoPoint::Write {
                    file.write_all(b"partial").unwrap();
                }
                Err(StoryError::Io)
            } else {
                Ok(())
            }
        };
        if failure == IoPoint::Write {
            assert_eq!(
                store.advance_pending_export_with_hook(&begin.token, 0, now, &mut hook),
                Err(StoryError::Io)
            );
        } else {
            advance_all(store, &begin, now);
            assert_eq!(
                store.end_export_with_hook(&begin.token, None, now, &mut hook),
                Err(StoryError::Io)
            );
        }
        assert!(entries(root.path()).is_empty());
    }
    let (root, library, manifest, _) = fixture("original");
    let store = library.stories();
    let now = Instant::now();
    let begin = store
        .begin_pending_export(source(&manifest, PendingKind::Markdown), now)
        .unwrap();
    let occupied = target(store);
    fs::write(&occupied, b"keep").unwrap();
    advance_all(store, &begin, now);
    assert_eq!(
        store.end_pending_export(&begin.token, now),
        Err(StoryError::Conflict)
    );
    assert_eq!(fs::read(&occupied).unwrap(), b"keep");
    assert_eq!(entries(root.path()), vec![occupied]);
}

#[test]
fn pending_export_restart_reclaims_own_temp_and_rejects_old_token() {
    let (root, library, manifest, _) = fixture("original");
    let now = Instant::now();
    let old = library
        .stories()
        .begin_pending_export(source(&manifest, PendingKind::Markdown), now)
        .unwrap();
    library
        .stories()
        .advance_pending_export(&old.token, 0, now)
        .unwrap();
    drop(library);
    let library = LocalLibrary::open(root.path()).unwrap();
    assert!(entries(root.path()).is_empty());
    let begin = library
        .stories()
        .begin_pending_export(source(&manifest, PendingKind::Markdown), now)
        .unwrap();
    assert_ne!(old.token, begin.token);
    assert_eq!(
        library.stories().advance_pending_export(&old.token, 0, now),
        Err(StoryError::Stale)
    );
    advance_all(library.stories(), &begin, now);
    library
        .stories()
        .end_pending_export(&begin.token, now)
        .unwrap();
}

#[test]
fn pending_export_recreated_identical_key_does_not_reuse_old_lifecycle() {
    let (root, library, manifest, input) = fixture("original");
    let store = library.stories();
    let now = Instant::now();
    let begin = store
        .begin_pending_export(source(&manifest, PendingKind::Markdown), now)
        .unwrap();
    advance_all(store, &begin, now);
    abandon(store, &manifest);
    // No permanent request ledger is introduced. Even an identical new sealed
    // row must not make the previous export's completion claim true again.
    let upload = store.pending_begin(manifest.clone()).unwrap().token;
    for (kind, bytes) in [
        (PendingKind::Input, input.as_bytes()),
        (PendingKind::Markdown, b"original".as_slice()),
    ] {
        store.pending_append(&upload, kind, 0, bytes).unwrap();
    }
    store.pending_seal(&upload).unwrap();
    assert_eq!(
        store.end_pending_export(&begin.token, now),
        Err(StoryError::Stale)
    );
    assert!(entries(root.path()).is_empty());
    let fresh = store
        .begin_pending_export(source(&manifest, PendingKind::Markdown), now)
        .unwrap();
    advance_all(store, &fresh, now);
    store.end_pending_export(&fresh.token, now).unwrap();
}

#[test]
fn pending_export_unsealed_rows_and_changed_blob_length_never_export() {
    for inactive in [false, true] {
        let (root, library, manifest, _) = fixture("original");
        let store = library.stories();
        let connection = lock_connection(&store.connection).unwrap();
        if inactive {
            connection
                .execute("UPDATE arena_story_pending SET active=0", [])
                .unwrap();
        } else {
            connection.execute("UPDATE arena_story_pending_part SET byte_length=7,received_bytes=7,payload=substr(payload,1,7) WHERE kind='markdown'", []).unwrap();
        }
        drop(connection);
        assert_eq!(
            store.begin_pending_export(source(&manifest, PendingKind::Markdown), Instant::now()),
            Err(if inactive {
                StoryError::Missing
            } else {
                StoryError::Corrupt
            })
        );
        assert!(entries(root.path()).is_empty());
    }
}

#[test]
fn pending_export_manifest_rechecks_status_on_each_advance() {
    let (root, library, manifest, _) = fixture("original");
    let store = library.stories();
    let now = Instant::now();
    let begin = store
        .begin_pending_export(manifest_source(&manifest), now)
        .unwrap();
    lock_connection(&store.connection)
        .unwrap()
        .execute("UPDATE arena_story_pending SET restored=1", [])
        .unwrap();
    assert_eq!(
        store.advance_pending_export(&begin.token, 0, now),
        Err(StoryError::Stale)
    );
    assert!(entries(root.path()).is_empty());
    let fresh = store
        .begin_pending_export(manifest_source(&manifest), now)
        .unwrap();
    advance_all(store, &fresh, now);
    store.end_pending_export(&fresh.token, now).unwrap();
}
