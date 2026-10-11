use super::*;
use crate::library::LocalLibrary;
use serde_json::{json, Value};

fn library() -> (tempfile::TempDir, LocalLibrary) {
    let root = tempfile::tempdir().unwrap();
    let library = LocalLibrary::open(root.path()).unwrap();
    (root, library)
}
fn commit(store: &StoryStore, session: &str, index: u64) {
    let mut parts = crate::arena_story::tests::fixture(session, index);
    let origin: Option<Option<String>> = lock_connection(&store.connection)
        .unwrap()
        .query_row(
            "SELECT json_extract(document,'$.branchOf') FROM arena_story_session WHERE id=?1",
            [session],
            |r| r.get(0),
        )
        .optional()
        .unwrap();
    if let Some(Some(origin)) = origin {
        let document = &mut parts
            .iter_mut()
            .find(|(kind, _)| *kind == PartKind::Session)
            .unwrap()
            .1;
        let mut value: Value = serde_json::from_str(document).unwrap();
        value["branchOf"] = serde_json::from_str(&origin).unwrap();
        *document = value.to_string();
    }
    let m = crate::arena_story::tests::manifest(session, index, &parts);
    let token = store.begin(m, Instant::now()).unwrap().token;
    upload_parts(store, &token, &parts);
    store.end(&token, Instant::now()).unwrap();
}
fn upload_parts(store: &StoryStore, token: &str, parts: &[(PartKind, String)]) {
    for (kind, document) in parts {
        store
            .append(token, *kind, 0, document.as_bytes(), Instant::now())
            .unwrap();
    }
}
fn fixture(
    store: &StoryStore,
    source: &str,
    count: u64,
    anchor: u64,
    target: &str,
) -> (BranchManifest, Vec<(PartKind, String)>) {
    let connection = lock_connection(&store.connection).unwrap();
    let (anchor_id,cp_id):(String,String)=connection.query_row(
        "SELECT c.id,p.id FROM arena_story_chapter c JOIN arena_story_checkpoint p ON p.session_id=c.session_id AND p.boundary_index=c.chapter_index WHERE c.session_id=?1 AND c.chapter_index=?2",params![source,anchor],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    let head: String = connection
        .query_row(
            "SELECT last_chapter_id FROM arena_story_session WHERE id=?1",
            [source],
            |r| r.get(0),
        )
        .unwrap();
    drop(connection);
    let new_index = anchor + 1;
    let mut parts = crate::arena_story::tests::fixture(target, new_index);
    for (kind, document) in &mut parts {
        let mut value: Value = serde_json::from_str(document).unwrap();
        if *kind == PartKind::Session {
            value["lastInputCheckpointId"] =
                json!(copy_id(target, CopyKind::Checkpoint, anchor).unwrap());
            value["branchOf"] =
                json!({"sessionId":source,"chapterId":anchor_id,"chapterIndex":anchor});
        }
        if *kind == PartKind::Chapter {
            value["action"] = json!("branch");
            value["sourceChapterId"] = json!(copy_id(target, CopyKind::Chapter, anchor).unwrap());
        }
        *document = value.to_string();
    }
    let m = BranchManifest {
        version: 2,
        operation_id: format!("{target}-chapter-{new_index}"),
        session_id: target.into(),
        source: BranchSource {
            session: store
                .describe_record(source, count, RecordKind::Session, source)
                .unwrap(),
            seed: store
                .describe_record(source, count, RecordKind::Seed, source)
                .unwrap(),
            expected_last_chapter_id: head,
            expected_chapter_count: count,
            anchor: store
                .describe_record(source, count, RecordKind::Chapter, &anchor_id)
                .unwrap(),
            anchor_index: anchor,
            checkpoint: store
                .describe_record(source, count, RecordKind::Checkpoint, &cp_id)
                .unwrap(),
        },
        parts: parts
            .iter()
            .map(|(kind, document)| PartDeclaration {
                kind: *kind,
                byte_length: document.len() as u64,
                digest: digest(document.as_bytes()),
            })
            .collect(),
    };
    (m, parts)
}
fn branch(store: &StoryStore, m: BranchManifest, parts: &[(PartKind, String)]) -> BranchReceipt {
    let token = store.begin_branch(m, Instant::now()).unwrap().token;
    upload_parts(store, &token, parts);
    store.end_branch(&token, Instant::now()).unwrap()
}
fn counts(store: &StoryStore, session: &str) -> (u64, u64, u64) {
    lock_connection(&store.connection).unwrap().query_row("SELECT (SELECT count(*) FROM arena_story_session WHERE id=?1),(SELECT count(*) FROM arena_story_chapter WHERE session_id=?1),(SELECT count(*) FROM arena_story_checkpoint WHERE session_id=?1)",[session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap()
}
fn delete(store: &StoryStore, session: &str, count: u64) {
    let connection = lock_connection(&store.connection).unwrap();
    let head = connection
        .query_row(
            "SELECT last_chapter_id FROM arena_story_session WHERE id=?1",
            [session],
            |r| r.get(0),
        )
        .unwrap();
    drop(connection);
    store
        .delete_session(
            &crate::arena_story::delete::SessionDeleteTarget {
                session: store
                    .describe_record(session, count, RecordKind::Session, session)
                    .unwrap(),
                expected_last_chapter_id: head,
                expected_chapter_count: count,
            },
            Instant::now(),
        )
        .unwrap();
}
#[test]
fn branch_is_independent_replay_survives_source_deletion_restart_and_target_continue() {
    let (root, lib) = library();
    let store = lib.stories();
    for i in 1..=3 {
        commit(store, "source", i);
    }
    let (m, parts) = fixture(store, "source", 3, 2, "target");
    let digest = m.request_digest().unwrap();
    let receipt = branch(store, m.clone(), &parts);
    assert_eq!(counts(store, "source"), (1, 3, 4));
    assert_eq!(counts(store, "target"), (1, 3, 4));
    let copied = copy_id("target", CopyKind::Chapter, 1).unwrap();
    assert!(store.receipt("target", &copied).is_err());
    assert!(store.branch_receipt("target", &copied, &digest).is_err());
    commit(store, "target", 4);
    assert_eq!(
        store
            .branch_receipt("target", &m.operation_id, &digest)
            .unwrap(),
        Some(receipt.clone())
    );
    delete(store, "source", 3);
    assert_eq!(counts(store, "source"), (0, 0, 0));
    assert_eq!(
        store
            .branch_receipt("target", &m.operation_id, &digest)
            .unwrap(),
        Some(receipt.clone())
    );
    drop(lib);
    let lib = LocalLibrary::open(root.path()).unwrap();
    let store = lib.stories();
    assert_ne!(m.source.session.instance, store.instance);
    assert_eq!(
        store
            .branch_receipt("target", &m.operation_id, &digest)
            .unwrap(),
        Some(receipt.clone())
    );
    assert_eq!(branch(store, m.clone(), &parts), receipt);
    assert_eq!(counts(store, "target"), (1, 4, 5));
    assert!(store
        .branch_receipt(
            "target",
            &m.operation_id,
            &crate::arena_story::digest(b"different")
        )
        .is_err());
    let (second, parts) = fixture(store, "target", 4, 3, "second");
    branch(store, second, &parts);
    delete(store, "target", 4);
    assert_eq!(counts(store, "second"), (1, 4, 5));
    super::super::audit::audit_relations(&lock_connection(&store.connection).unwrap()).unwrap();
    delete(store, "second", 4);
    assert_eq!(counts(store, "second"), (0, 0, 0));
}

#[test]
fn copy_cancellation_rolls_back_all_rows_and_unknown_commit_recovers_exactly() {
    let (_root, lib) = library();
    let store = lib.stories();
    for i in 1..=3 {
        commit(store, "source", i);
    }
    let (m, parts) = fixture(store, "source", 3, 2, "target");
    let token = store.begin_branch(m.clone(), Instant::now()).unwrap().token;
    upload_parts(store, &token, &parts);
    assert!(matches!(
        store.end(&token, Instant::now()),
        Err(StoryError::Invalid)
    ));
    for boundary in [
        "source-cas",
        "session",
        "seed",
        "copy-chapter",
        "copy-checkpoint",
        "chapter",
        "checkpoint",
        "before-commit",
    ] {
        let result = store.end_branch_with_hook(&token, Instant::now(), &mut |step, _| {
            if step == boundary {
                Err(StoryError::Busy)
            } else {
                Ok(())
            }
        });
        assert!(
            matches!(result, Err(StoryError::Busy)),
            "{boundary}: {result:?}"
        );
        assert_eq!(counts(store, "target"), (0, 0, 0));
        assert_eq!(counts(store, "source"), (1, 3, 4));
    }
    let result = store.end_branch_with_hook(&token, Instant::now(), &mut |step, _| {
        if step == "after-commit" {
            Err(StoryError::Io)
        } else {
            Ok(())
        }
    });
    assert!(matches!(result, Err(StoryError::CommitUnknown)));
    assert_eq!(counts(store, "target"), (1, 3, 4));
    let receipt = store
        .branch_receipt("target", &m.operation_id, &m.request_digest().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(store.end_branch(&token, Instant::now()).unwrap(), receipt);
}

#[test]
fn source_suffix_write_and_tampered_frozen_bytes_conflict_without_targets() {
    let (_root, lib) = library();
    let store = lib.stories();
    for i in 1..=3 {
        commit(store, "source", i);
    }
    let (m, parts) = fixture(store, "source", 3, 2, "target");
    let token = store.begin_branch(m, Instant::now()).unwrap().token;
    upload_parts(store, &token, &parts);
    commit(store, "source", 4);
    assert!(matches!(
        store.end_branch(&token, Instant::now()),
        Err(StoryError::Stale)
    ));
    assert_eq!(counts(store, "target"), (0, 0, 0));
    store.abort(&token).unwrap();
    let (m, parts) = fixture(store, "source", 4, 2, "target");
    let token = store.begin_branch(m, Instant::now()).unwrap().token;
    upload_parts(store, &token, &parts);
    lock_connection(&store.connection).unwrap().execute("UPDATE arena_story_chapter SET document=replace(document,'标题','破坏') WHERE id='source-chapter-2'",[]).unwrap();
    assert!(matches!(
        store.end_branch(&token, Instant::now()),
        Err(StoryError::Corrupt)
    ));
    assert_eq!(counts(store, "target"), (0, 0, 0));
}

#[test]
fn shared_staging_reservation_and_closed_manifest_validation() {
    let (_root, lib) = library();
    let store = lib.stories();
    commit(store, "source", 1);
    let (m, parts) = fixture(store, "source", 1, 1, "target");
    let a = store.begin_branch(m.clone(), Instant::now()).unwrap().token;
    let b = store.begin_branch(m.clone(), Instant::now()).unwrap().token;
    assert!(matches!(
        store.begin_branch(m.clone(), Instant::now()),
        Err(StoryError::Busy)
    ));
    store.abort(&a).unwrap();
    store.abort(&b).unwrap();
    let mut bad = m.clone();
    bad.source.anchor_index = MAX_SAFE_INTEGER;
    assert!(store.begin_branch(bad, Instant::now()).is_err());
    let mut bad = m.clone();
    bad.parts.push(bad.parts[0].clone());
    assert!(store.begin_branch(bad, Instant::now()).is_err());
    let mut bad = m;
    bad.source.session.instance = "f".repeat(32);
    bad.source.seed.instance = "f".repeat(32);
    bad.source.anchor.instance = "f".repeat(32);
    bad.source.checkpoint.instance = "f".repeat(32);
    let token = store.begin_branch(bad, Instant::now()).unwrap().token;
    upload_parts(store, &token, &parts);
    assert!(matches!(
        store.end_branch(&token, Instant::now()),
        Err(StoryError::Stale)
    ));
}

#[test]
fn new_branch_uses_the_same_required_carriers_as_linear_commits() {
    let (_root, lib) = library();
    let store = lib.stories();
    commit(store, "source", 1);
    for (kind, key, value) in [
        (PartKind::Chapter, "reportJson", Value::Null),
        (PartKind::Chapter, "deterministicDigest", json!(1)),
        (PartKind::Chapter, "markdown", json!({})),
        (PartKind::Checkpoint1, "combatants", Value::Null),
    ] {
        let (mut m, mut parts) = fixture(store, "source", 1, 1, "target");
        let document = &mut parts.iter_mut().find(|(k, _)| *k == kind).unwrap().1;
        let mut parsed: Value = serde_json::from_str(document).unwrap();
        parsed[key] = value;
        *document = parsed.to_string();
        m.parts = parts
            .iter()
            .map(|(kind, document)| PartDeclaration {
                kind: *kind,
                byte_length: document.len() as u64,
                digest: digest(document.as_bytes()),
            })
            .collect();
        let token = store.begin_branch(m, Instant::now()).unwrap().token;
        upload_parts(store, &token, &parts);
        assert!(store.end_branch(&token, Instant::now()).is_err(), "{key}");
        assert_eq!(counts(store, "target"), (0, 0, 0));
        store.abort(&token).unwrap();
    }
}

#[test]
fn branch_and_linear_staging_share_the_same_byte_reservation() {
    let (_root, lib) = library();
    let store = lib.stories();
    commit(store, "source", 1);
    let (mut m, _) = fixture(store, "source", 1, 1, "target");
    let half = CANDIDATE_COMMIT_BYTES / 2;
    let other: u64 = m.parts.iter().skip(1).map(|p| p.byte_length).sum();
    m.parts[0].byte_length = half - other;
    let token = store.begin_branch(m, Instant::now()).unwrap().token;
    let parts = crate::arena_story::tests::fixture("linear", 1);
    let mut linear = crate::arena_story::tests::manifest("linear", 1, &parts);
    let other: u64 = linear.parts.iter().skip(1).map(|p| p.byte_length).sum();
    linear.parts[0].byte_length = half - other + 1;
    assert!(matches!(
        store.begin(linear.clone(), Instant::now()),
        Err(StoryError::Busy)
    ));
    linear.parts[0].byte_length -= 1;
    let admitted = store.begin(linear, Instant::now()).unwrap();
    assert_eq!(admitted.total_bytes, half);
    store.abort(&token).unwrap();
    store.abort(&admitted.token).unwrap();
}

#[test]
fn real_backup_restore_preserves_branch_history_after_source_is_deleted() {
    let (root, lib) = library();
    let store = lib.stories();
    for i in 1..=2 {
        commit(store, "source", i);
    }
    let (m, parts) = fixture(store, "source", 2, 1, "target");
    let receipt = branch(store, m.clone(), &parts);
    delete(store, "source", 2);
    let backup = crate::backup::create_backup(&lib).unwrap();
    crate::backup::verify_backup(root.path(), &backup.backup_id).unwrap();
    delete(store, "target", 2);
    let prepared = crate::restore::prepare_restore(&lib, &backup.backup_id).unwrap();
    drop(prepared);
    drop(lib);
    crate::restore::recover_pending(root.path()).unwrap();
    let restored = LocalLibrary::open(root.path()).unwrap();
    let store = restored.stories();
    assert_eq!(counts(store, "source"), (0, 0, 0));
    assert_eq!(counts(store, "target"), (1, 2, 3));
    assert_eq!(
        store
            .branch_receipt("target", &m.operation_id, &m.request_digest().unwrap())
            .unwrap(),
        Some(receipt)
    );
    commit(store, "target", 3);
    crate::backup::create_backup(&restored).unwrap();
}

fn commit_with_padding(store: &StoryStore, session: &str, index: u64, padding: usize) {
    let mut parts = crate::arena_story::tests::fixture(session, index);
    let document = &mut parts
        .iter_mut()
        .find(|(kind, _)| *kind == PartKind::Chapter)
        .unwrap()
        .1;
    document.pop();
    document.push_str(",\"opaquePadding\":\"");
    document.push_str(&"x".repeat(padding));
    document.push_str("\"}");
    let manifest = crate::arena_story::tests::manifest(session, index, &parts);
    let token = store.begin(manifest, Instant::now()).unwrap().token;
    upload_parts(store, &token, &parts);
    store.end(&token, Instant::now()).unwrap();
}

#[test]
fn sqlite_page_capacity_failure_never_commits_a_partial_branch() {
    let (_root, lib) = library();
    let store = lib.stories();
    commit_with_padding(store, "source", 1, 1024 * 1024);
    let (m, parts) = fixture(store, "source", 1, 1, "target");
    let token = store.begin_branch(m.clone(), Instant::now()).unwrap().token;
    upload_parts(store, &token, &parts);
    {
        let c = lock_connection(&store.connection).unwrap();
        let pages: u64 = c.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
        c.execute_batch(&format!("PRAGMA max_page_count={}", pages + 4))
            .unwrap();
    }
    assert!(store.end_branch(&token, Instant::now()).is_err());
    assert_eq!(counts(store, "source"), (1, 1, 2));
    assert_eq!(counts(store, "target"), (0, 0, 0));
    assert_eq!(
        store
            .branch_receipt("target", &m.operation_id, &m.request_digest().unwrap())
            .unwrap(),
        None
    );
    assert!(lock_connection(&store.connection).unwrap().is_autocommit());
}

#[test]
#[ignore = "serial capacity probe; requires at least 550 MiB free disk, no concurrent resource probes"]
fn real_store_copies_more_than_128_mib_without_a_history_total_cap() {
    let (root, lib) = library();
    let store = lib.stories();
    for i in 1..=129 {
        commit_with_padding(store, "source", i, 1024 * 1024);
    }
    let source_bytes: u64 = lock_connection(&store.connection)
        .unwrap()
        .query_row(
            "SELECT sum(document_bytes) FROM arena_story_chapter WHERE session_id='source'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(source_bytes > CANDIDATE_COMMIT_BYTES);
    let (m, parts) = fixture(store, "source", 129, 129, "target");
    let token = store.begin_branch(m.clone(), Instant::now()).unwrap().token;
    upload_parts(store, &token, &parts);
    let size = || -> Vec<u64> {
        ["library.sqlite", "library.sqlite-wal", "library.sqlite-shm"]
            .iter()
            .map(|name| {
                std::fs::metadata(root.path().join(name))
                    .map(|m| m.len())
                    .unwrap_or(0)
            })
            .collect()
    };
    let baseline = size();
    let mut maxima = baseline.clone();
    let mut copied = 0;
    let start = Instant::now();
    let cancelled = store.end_branch_with_hook(&token, Instant::now(), &mut |step, _| {
        if step == "copy-chapter" {
            copied += 1;
            if copied == 65 {
                return Err(StoryError::Busy);
            }
        }
        Ok(())
    });
    assert!(matches!(cancelled, Err(StoryError::Busy)));
    let cancelled_ms = start.elapsed().as_millis();
    let rollback_files = size();
    assert_eq!(counts(store, "target"), (0, 0, 0));
    assert_eq!(counts(store, "source"), (1, 129, 130));
    let start = Instant::now();
    let receipt = store
        .end_branch_with_hook(&token, Instant::now(), &mut |_, _| {
            for (max, value) in maxima.iter_mut().zip(size()) {
                *max = (*max).max(value);
            }
            Ok(())
        })
        .unwrap();
    let elapsed = start.elapsed().as_millis();
    for (max, value) in maxima.iter_mut().zip(size()) {
        *max = (*max).max(value);
    }
    assert_eq!(counts(store, "target"), (1, 130, 131));
    let copied_bytes:u64=lock_connection(&store.connection).unwrap().query_row(
        "SELECT sum(document_bytes) FROM arena_story_chapter WHERE session_id='target' AND chapter_index<=129",[],|r|r.get(0)).unwrap();
    assert!(copied_bytes > CANDIDATE_COMMIT_BYTES);
    assert_eq!(
        store
            .branch_receipt("target", &m.operation_id, &m.request_digest().unwrap())
            .unwrap(),
        Some(receipt)
    );
    let memory = std::fs::read_to_string("/proc/self/status")
        .unwrap_or_default()
        .lines()
        .filter(|line| line.starts_with("VmHWM:") || line.starts_with("VmRSS:"))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    println!(
        "BRANCH_RESOURCE {}",
        json!({"sourceChapterBytes":source_bytes,"copiedChapterBytes":copied_bytes,
        "baselineMainWalShm":baseline,"sampledMaxMainWalShm":maxima,"rollbackMainWalShm":rollback_files,
        "copyTransactionMs":elapsed,"cancelAfter65TransactionMs":cancelled_ms,"processMemory":memory,
        "scope":"real source staging, schema9, Native branch storage; not Tauri/renderer or filesystem ENOSPC"})
    );
}

#[test]
fn continuation_cannot_erase_or_change_native_branch_provenance() {
    let (_root, lib) = library();
    let store = lib.stories();
    commit(store, "source", 1);
    let (m, parts) = fixture(store, "source", 1, 1, "target");
    branch(store, m, &parts);
    for origin in [
        None,
        Some(json!({"sessionId":"wrong","chapterId":"source-chapter-1","chapterIndex":1})),
    ] {
        let mut parts = crate::arena_story::tests::fixture("target", 3);
        if let Some(origin) = origin {
            let document = &mut parts
                .iter_mut()
                .find(|(kind, _)| *kind == PartKind::Session)
                .unwrap()
                .1;
            let mut value: Value = serde_json::from_str(document).unwrap();
            value["branchOf"] = origin;
            *document = value.to_string();
        }
        let manifest = crate::arena_story::tests::manifest("target", 3, &parts);
        let token = store.begin(manifest, Instant::now()).unwrap().token;
        upload_parts(store, &token, &parts);
        assert!(store.end(&token, Instant::now()).is_err());
        assert_eq!(counts(store, "target"), (1, 2, 3));
        store.abort(&token).unwrap();
    }
    commit(store, "target", 3);
}

#[test]
fn unknown_commit_or_failed_rollback_fences_the_same_stage_when_receipt_is_absent() {
    for fail_commit in [true, false] {
        let (_root, lib) = library();
        let store = lib.stories();
        commit(store, "source", 1);
        let (m, parts) = fixture(store, "source", 1, 1, "target");
        let token = store.begin_branch(m.clone(), Instant::now()).unwrap().token;
        upload_parts(store, &token, &parts);
        let result=store.end_branch_with_hook(&token,Instant::now(),&mut |step,connection| {
            if step=="before-commit" {
                if fail_commit {
                    // Real deferred-FK COMMIT failure, followed by Transaction drop rollback.
                    connection.execute("DELETE FROM arena_story_checkpoint WHERE session_id='target' AND boundary_index=2",[]).unwrap();
                } else {
                    // Make the writer's explicit ROLLBACK fail (already ended),
                    // without pretending to emulate a filesystem I/O failure.
                    connection.execute_batch("ROLLBACK").unwrap();
                    return Err(StoryError::Busy);
                }
            }
            Ok(())
        });
        assert!(matches!(result, Err(StoryError::CommitUnknown)));
        assert_eq!(counts(store, "target"), (0, 0, 0));
        assert_eq!(
            store
                .branch_receipt("target", &m.operation_id, &m.request_digest().unwrap())
                .unwrap(),
            None
        );
        let mut writes = 0;
        let again = store.end_branch_with_hook(&token, Instant::now(), &mut |_, _| {
            writes += 1;
            Ok(())
        });
        assert!(matches!(again, Err(StoryError::CommitUnknown)));
        assert_eq!(writes, 0);
        assert_eq!(counts(store, "target"), (0, 0, 0));
    }
}

#[test]
fn source_read_and_copy_share_one_check_for_chapter_and_checkpoint() {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            "CREATE TABLE source (id TEXT PRIMARY KEY, document TEXT, bytes INTEGER, hash TEXT)",
        )
        .unwrap();
    let chapter = r#"{"id":"c1","sessionId":"source","index":1,"action":"start","status":"active","sourceChapterId":null,"titlePreview":"t","titleTruncated":false,"createdAt":1,"markdownByteLength":0}"#;
    let checkpoint = r#"{"id":"p0","sessionId":"source","boundaryIndex":0,"chapterId":null,"opaque":{"x":1,"x":2,"\ud800":"\udfff"}}"#;
    for document in [chapter, checkpoint] {
        connection
            .execute(
                "INSERT OR REPLACE INTO source VALUES ('row',?1,?2,?3)",
                params![document, document.len() as u64, digest(document.as_bytes())],
            )
            .unwrap();
        let before = verified_source::check_count();
        let copied = read_document(
            &connection,
            "source",
            "document",
            "bytes",
            "hash",
            "row",
            |source| {
                assert_eq!(verified_source::check_count(), before + 1);
                if document == chapter {
                    let index = chapter_index(&authority(source.raw(), CHAPTER_AUTHORITY)?)?;
                    copy_chapter(source, &index, None, "target")
                } else {
                    let index = checkpoint_index(&authority(source.raw(), CHECKPOINT_AUTHORITY)?)?;
                    copy_checkpoint(source, &index, None, "target")
                }
            },
        )
        .unwrap();
        assert_eq!(verified_source::check_count(), before + 1);
        assert_eq!(copied.digest, digest(copied.document.as_bytes()));
        if document == checkpoint {
            assert!(copied
                .document
                .contains(r#""opaque":{"x":1,"x":2,"\ud800":"\udfff"}"#));
        }
    }
    // A callback must never see unchecked bytes, even with internally consistent metadata.
    for (document, hash) in [
        ("{}", digest(b"wrong")),
        ("{", digest(b"{")),
        ("[]", digest(b"[]")),
    ] {
        connection
            .execute(
                "UPDATE source SET document=?1,bytes=?2,hash=?3",
                params![document, document.len() as u64, hash],
            )
            .unwrap();
        let result = read_document(
            &connection,
            "source",
            "document",
            "bytes",
            "hash",
            "row",
            |_| -> Result<(), StoryError> { panic!("corrupt source reached consumer") },
        );
        assert!(matches!(result, Err(StoryError::Corrupt)));
    }
}
