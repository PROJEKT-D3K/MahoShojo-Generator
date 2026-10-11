use super::*;
use crate::library::LocalLibrary;
use serde_json::json;

fn library() -> (tempfile::TempDir, LocalLibrary) {
    let root = tempfile::tempdir().unwrap();
    let library = LocalLibrary::open(root.path()).unwrap();
    (root, library)
}
fn upload(store: &StoryStore, session: &str, index: u64) -> String {
    let parts = super::super::tests::fixture(session, index);
    let manifest = super::super::tests::manifest(session, index, &parts);
    let token = store.begin(manifest, Instant::now()).unwrap().token;
    for (kind, document) in parts {
        store
            .append(&token, kind, 0, document.as_bytes(), Instant::now())
            .unwrap();
    }
    token
}
fn commit(store: &StoryStore, session: &str, index: u64) {
    let token = upload(store, session, index);
    store.end(&token, Instant::now()).unwrap();
}
fn target(store: &StoryStore, session: &str, index: u64) -> SessionDeleteTarget {
    SessionDeleteTarget {
        session: store
            .describe_record(session, index, RecordKind::Session, session)
            .unwrap(),
        expected_last_chapter_id: format!("{session}-chapter-{index}"),
        expected_chapter_count: index,
    }
}
fn counts(store: &StoryStore, session: &str) -> (u64, u64, u64) {
    lock_connection(&store.connection).unwrap().query_row(
        "SELECT (SELECT count(*) FROM arena_story_session WHERE id=?1),(SELECT count(*) FROM arena_story_chapter WHERE session_id=?1),(SELECT count(*) FROM arena_story_checkpoint WHERE session_id=?1)",
        [session], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap()
}
fn insert_reference(
    store: &StoryStore,
    session: &str,
    product: pending::Product,
    active: bool,
    flags: &str,
) {
    let manifest = pending::PendingManifest {
        version: 1,
        product,
        request_id: "delete-reference-1".into(),
        actor: pending::Actor::Anonymous,
        pending_revision: 1,
        session_id: session.into(),
        operation_id: "reference-operation".into(),
        output_checkpoint_id: "reference-output".into(),
        initial_checkpoint_id: Some("reference-input".into()),
        created_at: 1,
        expected_revision: 0,
        expected_last_chapter_id: None,
        last_input_checkpoint_id: "reference-input".into(),
        input_digest: digest(b"{}"),
        write_options: pending::WriteOptions {
            write_arena_history: false,
            write_current_state: false,
            write_narrative_history: false,
        },
        model_completed: false,
        role_state: pending::RoleState::NotRequested,
        role_input_digest: None,
        parts: vec![pending::PendingPart {
            kind: pending::PendingKind::Input,
            byte_length: 2,
            digest: digest(b"{}"),
        }],
        commit_manifest: None,
        local_assembly: None,
    };
    manifest.validate().unwrap();
    let connection = lock_connection(&store.connection).unwrap();
    connection.execute("INSERT INTO arena_story_pending(token,product,request_id,revision,active,metadata,total_bytes,save_attempt,restored,abandon_requested) VALUES('reference',?1,?2,1,?3,?4,2,?5,?6,?7)",
        params![if product == pending::Product::Battle { "battle" } else { "arena" }, manifest.request_id, active, serde_json::to_string(&manifest).unwrap(),
            (flags == "save-attempt").then_some("attempt"), flags == "restored", flags == "abandon"],
    ).unwrap();
}

#[test]
fn all_own_rows_are_deleted_beyond_pages_with_other_session_bytes_unchanged() {
    let (root, library) = library();
    let store = library.stories();
    for index in 1..=57 {
        commit(store, "story", index);
    }
    commit(store, "other", 1);
    let other = store
        .describe_record("other", 1, RecordKind::Session, "other")
        .unwrap();
    let other_bytes = store
        .read_record_chunk(&other, 0, CANDIDATE_FRAME_BYTES)
        .unwrap();
    let frozen = target(store, "story", 57);
    let result = store.delete_session(&frozen, Instant::now()).unwrap();
    assert_eq!(result.status, SessionDeleteStatus::Deleted);
    assert_eq!(
        (
            result.deleted_chapter_count,
            result.deleted_checkpoint_count
        ),
        (57, 58)
    );
    assert_eq!(counts(store, "story"), (0, 0, 0));
    assert_eq!(counts(store, "other"), (1, 1, 2));
    assert_eq!(
        store
            .read_record_chunk(&other, 0, CANDIDATE_FRAME_BYTES)
            .unwrap(),
        other_bytes
    );
    assert_eq!(store.receipt("story", "story-chapter-57").unwrap(), None);
    assert_eq!(
        store.delete_session(&frozen, Instant::now()).unwrap(),
        SessionDeleteOutcome {
            target: frozen.clone(),
            status: SessionDeleteStatus::CurrentlyAbsent,
            deleted_chapter_count: 0,
            deleted_checkpoint_count: 0,
        }
    );
    let connection = lock_connection(&store.connection).unwrap();
    assert_eq!(
        connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, u64>(0))
            .unwrap(),
        crate::store::SCHEMA_VERSION as u64
    );
    audit_relations(&connection).unwrap();
    assert!(!connection
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    drop(connection);
    drop(library);
    let reopened = LocalLibrary::open(root.path()).unwrap();
    assert_eq!(counts(reopened.stories(), "story"), (0, 0, 0));
    assert_eq!(counts(reopened.stories(), "other"), (1, 1, 2));
    assert_eq!(
        reopened.stories().delete_session(&frozen, Instant::now()),
        Err(StoryError::Stale)
    );
}

#[test]
fn every_delete_boundary_rolls_back_and_commit_ack_loss_is_observed_only() {
    for boundary in [
        "before-checkpoints",
        "after-checkpoints",
        "before-chapters",
        "after-chapters",
        "before-session",
        "after-session",
        "before-commit",
        "after-commit",
    ] {
        let (_root, library) = library();
        let store = library.stories();
        commit(store, "story", 1);
        let frozen = target(store, "story", 1);
        let result = store.delete_session_with_hook(&frozen, Instant::now(), &mut |point| {
            if point == boundary {
                Err(StoryError::Io)
            } else {
                Ok(())
            }
        });
        if boundary == "after-commit" {
            assert_eq!(result, Err(StoryError::CommitUnknown));
            assert_eq!(
                store.describe_record("story", 1, RecordKind::Session, "story"),
                Err(StoryError::Missing)
            );
            assert_eq!(counts(store, "story"), (0, 0, 0));
        } else {
            assert_eq!(result, Err(StoryError::Io));
            assert_eq!(counts(store, "story"), (1, 1, 2));
            assert_eq!(
                store
                    .describe_record("story", 1, RecordKind::Session, "story")
                    .unwrap(),
                frozen.session
            );
        }
        audit_relations(&lock_connection(&store.connection).unwrap()).unwrap();
    }
}

#[test]
fn closed_target_rejects_tampering_and_changed_generation_without_deleting() {
    let (_root, library) = library();
    let store = library.stories();
    commit(store, "story", 1);
    let frozen = target(store, "story", 1);
    for (field, value) in [
        ("unknown", json!(true)),
        ("expectedChapterCount", json!(-1)),
    ] {
        let mut raw = serde_json::to_value(&frozen).unwrap();
        raw[field] = value;
        assert!(serde_json::from_value::<SessionDeleteTarget>(raw).is_err());
    }
    let mut raw = serde_json::to_value(&frozen).unwrap();
    raw["session"]["unknown"] = json!(true);
    assert!(serde_json::from_value::<SessionDeleteTarget>(raw).is_err());
    let mut wrong = frozen.clone();
    wrong.session.record_id = "another".into();
    assert_eq!(
        store.delete_session(&wrong, Instant::now()),
        Err(StoryError::Invalid)
    );
    let mut wrong = frozen.clone();
    wrong.session.kind = RecordKind::Chapter;
    assert_eq!(
        store.delete_session(&wrong, Instant::now()),
        Err(StoryError::Invalid)
    );
    for index in 0..6 {
        let mut wrong = frozen.clone();
        match index {
            0 => wrong.session.instance = "f".repeat(32),
            1 => wrong.session.revision += 1,
            2 => wrong.expected_last_chapter_id = "other-head".into(),
            3 => wrong.expected_chapter_count += 1,
            4 => wrong.session.digest = digest(b"tampered"),
            _ => wrong.session.byte_length += 1,
        }
        assert_eq!(
            store.delete_session(&wrong, Instant::now()),
            Err(StoryError::Stale)
        );
        assert_eq!(counts(store, "story"), (1, 1, 2));
    }
    commit(store, "story", 2);
    assert_eq!(
        store.delete_session(&frozen, Instant::now()),
        Err(StoryError::Stale)
    );
    assert_eq!(counts(store, "story"), (1, 2, 3));
}

#[test]
fn both_products_uploads_active_unknown_assembly_and_pending_flags_block() {
    for product in [pending::Product::Battle, pending::Product::Arena] {
        for (active, flags) in [
            (false, "none"),
            (true, "none"),
            (true, "save-attempt"),
            (true, "restored"),
            (true, "abandon"),
        ] {
            let (_root, library) = library();
            let store = library.stories();
            commit(store, "story", 1);
            insert_reference(store, "story", product, active, flags);
            assert_eq!(
                store.delete_session(&target(store, "story", 1), Instant::now()),
                Err(StoryError::Busy)
            );
            assert_eq!(counts(store, "story"), (1, 1, 2));
            assert_eq!(
                lock_connection(&store.connection)
                    .unwrap()
                    .query_row("SELECT count(*) FROM arena_story_pending", [], |row| row
                        .get::<_, u64>(0))
                    .unwrap(),
                1
            );
        }
    }
}

#[test]
fn unrelated_candidate_survives_but_unreadable_reference_fails_closed() {
    for corrupt in [false, true] {
        let (_root, library) = library();
        let store = library.stories();
        commit(store, "story", 1);
        insert_reference(store, "other", pending::Product::Arena, false, "none");
        if corrupt {
            lock_connection(&store.connection)
                .unwrap()
                .execute("UPDATE arena_story_pending SET metadata='{}'", [])
                .unwrap();
        }
        let before: String = lock_connection(&store.connection)
            .unwrap()
            .query_row("SELECT metadata FROM arena_story_pending", [], |row| {
                row.get(0)
            })
            .unwrap();
        let result = store.delete_session(&target(store, "story", 1), Instant::now());
        if corrupt {
            assert_eq!(result, Err(StoryError::Corrupt));
            assert_eq!(counts(store, "story"), (1, 1, 2));
        } else {
            assert_eq!(result.unwrap().status, SessionDeleteStatus::Deleted);
        }
        assert_eq!(
            lock_connection(&store.connection)
                .unwrap()
                .query_row("SELECT metadata FROM arena_story_pending", [], |row| row
                    .get::<_, String>(
                    0
                ))
                .unwrap(),
            before
        );
    }
}

#[test]
fn matching_stage_blocks_until_expired_and_late_continue_never_recreates() {
    let (_root, library) = library();
    let store = library.stories();
    commit(store, "story", 1);
    let frozen = target(store, "story", 1);
    let live = upload(store, "story", 2);
    assert_eq!(
        store.delete_session(&frozen, Instant::now()),
        Err(StoryError::Busy)
    );
    store
        .delete_session(&frozen, Instant::now() + STAGE_LIFETIME)
        .unwrap();
    assert_eq!(store.end(&live, Instant::now()), Err(StoryError::Stale));
    let late = upload(store, "story", 2);
    assert_eq!(store.end(&late, Instant::now()), Err(StoryError::Conflict));
    store.abort(&late).unwrap();
    assert_eq!(counts(store, "story"), (0, 0, 0));
    commit(store, "other", 1);
    let other_stage = upload(store, "elsewhere", 1);
    store
        .delete_session(&target(store, "other", 1), Instant::now())
        .unwrap();
    store.end(&other_stage, Instant::now()).unwrap();
    assert_eq!(counts(store, "elsewhere"), (1, 1, 2));
}

#[test]
fn rollback_failure_fences_absence_until_safe_reopen() {
    use std::ffi::{c_char, c_int, c_void, CStr};
    unsafe extern "C" fn deny_rollback(
        _: *mut c_void,
        action: c_int,
        first: *const c_char,
        _: *const c_char,
        _: *const c_char,
        _: *const c_char,
    ) -> c_int {
        if action == rusqlite::ffi::SQLITE_TRANSACTION
            && !first.is_null()
            && unsafe { CStr::from_ptr(first) }.to_bytes() == b"ROLLBACK"
        {
            rusqlite::ffi::SQLITE_DENY
        } else {
            rusqlite::ffi::SQLITE_OK
        }
    }
    let (root, library) = library();
    let store = library.stories();
    commit(store, "story", 1);
    let frozen = target(store, "story", 1);
    {
        let connection = lock_connection(&store.connection).unwrap();
        // SAFETY: stateless function pointer installed under the shared connection lock.
        assert_eq!(
            unsafe {
                rusqlite::ffi::sqlite3_set_authorizer(
                    connection.handle(),
                    Some(deny_rollback),
                    std::ptr::null_mut(),
                )
            },
            rusqlite::ffi::SQLITE_OK
        );
    }
    assert_eq!(
        store.delete_session_with_hook(&frozen, Instant::now(), &mut |point| if point
            == "after-session"
        {
            Err(StoryError::Io)
        } else {
            Ok(())
        }),
        Err(StoryError::CommitUnknown)
    );
    assert!(!store.connection.lock().unwrap().is_autocommit());
    assert_eq!(
        store.describe_record("story", 1, RecordKind::Session, "story"),
        Err(StoryError::ConnectionUnresolved)
    );
    assert_eq!(
        store.delete_session(&frozen, Instant::now()),
        Err(StoryError::ConnectionUnresolved)
    );
    drop(library);
    let reopened = LocalLibrary::open(root.path()).unwrap();
    assert_eq!(counts(reopened.stories(), "story"), (1, 1, 2));
    assert_eq!(
        reopened.stories().delete_session(&frozen, Instant::now()),
        Err(StoryError::Stale)
    );
}

#[test]
fn concurrent_begin_waits_for_deletion_then_continuation_cas_fails() {
    let (_root, library) = library();
    let store = library.stories();
    commit(store, "story", 1);
    let frozen = target(store, "story", 1);
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        let deletion = scope.spawn(move || {
            store.delete_session_with_hook(&frozen, Instant::now(), &mut |point| {
                if point == "before-checkpoints" {
                    entered_tx.send(()).unwrap();
                    resume_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                }
                Ok(())
            })
        });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let continuation = scope.spawn(|| {
            let late = upload(store, "story", 2);
            let result = store.end(&late, Instant::now());
            store.abort(&late).unwrap();
            result
        });
        resume_tx.send(()).unwrap();
        assert_eq!(
            deletion.join().unwrap().unwrap().status,
            SessionDeleteStatus::Deleted
        );
        assert_eq!(continuation.join().unwrap(), Err(StoryError::Conflict));
    });
    assert_eq!(counts(store, "story"), (0, 0, 0));
}

#[test]
fn commit_failure_stays_unknown_even_if_drop_rolls_back() {
    use std::ffi::{c_char, c_int, c_void, CStr};
    unsafe extern "C" fn deny_commit(
        _: *mut c_void,
        action: c_int,
        first: *const c_char,
        _: *const c_char,
        _: *const c_char,
        _: *const c_char,
    ) -> c_int {
        if action == rusqlite::ffi::SQLITE_TRANSACTION
            && !first.is_null()
            && unsafe { CStr::from_ptr(first) }.to_bytes() == b"COMMIT"
        {
            rusqlite::ffi::SQLITE_DENY
        } else {
            rusqlite::ffi::SQLITE_OK
        }
    }
    let (_root, library) = library();
    let store = library.stories();
    commit(store, "story", 1);
    let frozen = target(store, "story", 1);
    {
        let connection = lock_connection(&store.connection).unwrap();
        // SAFETY: stateless callback and live handle under the shared connection lock.
        assert_eq!(
            unsafe {
                rusqlite::ffi::sqlite3_set_authorizer(
                    connection.handle(),
                    Some(deny_commit),
                    std::ptr::null_mut(),
                )
            },
            rusqlite::ffi::SQLITE_OK
        );
    }
    assert_eq!(
        store.delete_session(&frozen, Instant::now()),
        Err(StoryError::CommitUnknown)
    );
    assert_eq!(counts(store, "story"), (1, 1, 2));
    assert_eq!(
        store
            .describe_record("story", 1, RecordKind::Session, "story")
            .unwrap(),
        frozen.session
    );
}
