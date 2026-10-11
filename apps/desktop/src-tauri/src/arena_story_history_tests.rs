use super::*;
use crate::arena_story::delete::SessionDeleteTarget;
use crate::arena_story::read::{BranchAnchorRequest, RecordKind};
use crate::arena_story::{digest, CommitManifest, PartDeclaration, PartKind};
use crate::library::LocalLibrary;
use crate::store::lock_connection;
use serde_json::json;
use std::time::Instant;

fn bytes(c: &Connection) -> Vec<String> {
    ["SELECT hex(document)||':'||hex(seed_document) FROM arena_story_session ORDER BY id", "SELECT hex(document)||':'||hex(receipt)||':'||operation_digest FROM arena_story_chapter ORDER BY id", "SELECT hex(document)||':'||document_digest FROM arena_story_checkpoint ORDER BY id"].iter().flat_map(|sql| {
        c.prepare(sql).unwrap().query_map([],|r|r.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap()
    }).collect()
}

/// Fixture-only state transition, deliberately not a production rewrite API.
/// Uses the same raw member replacement primitive to preserve unknown tokens.
pub(crate) fn rewrite_tail(c: &Connection, session: &str, new_id: &str) {
    let (old, index, revision, input, document):(String,u64,u64,String,String)=c.query_row("SELECT last_chapter_id,chapter_count,revision,last_input_checkpoint_id,document FROM arena_story_session WHERE id=?1",[session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
    let cp = format!("cp-{new_id}");
    let source: String = c
        .query_row(
            "SELECT document FROM arena_story_chapter WHERE id=?1",
            [&old],
            |r| r.get(0),
        )
        .unwrap();
    let raw = serde_json::from_str(&source).unwrap();
    let fields = super::super::authority(raw, super::super::CHAPTER_AUTHORITY).unwrap();
    let superseded = super::super::materialize(
        &source,
        &fields,
        &[
            ("status", "\"superseded\"".into()),
            ("supersededByChapterId", json!(new_id).to_string()),
        ],
    )
    .unwrap();
    let new = super::super::materialize(
        &source,
        &fields,
        &[
            ("id", json!(new_id).to_string()),
            ("action", "\"rewrite\"".into()),
            ("sourceChapterId", json!(old).to_string()),
            ("status", "\"active\"".into()),
            ("supersededByChapterId", "null".into()),
        ],
    )
    .unwrap();
    let session_fields = super::super::authority(
        serde_json::from_str(&document).unwrap(),
        &["revision", "lastChapterId", "workingCheckpointId"],
    )
    .unwrap();
    let updated = super::super::materialize(
        &document,
        &session_fields,
        &[
            ("revision", (revision + 1).to_string()),
            ("lastChapterId", json!(new_id).to_string()),
            ("workingCheckpointId", json!(cp).to_string()),
        ],
    )
    .unwrap();
    let receipt=json!({"version":3,"kind":"tail-rewrite","operationId":new_id,"sessionId":session,"chapterId":new_id,"chapterIndex":index,"revision":revision+1,"chapterCount":index,"targetChapterId":old,"inputCheckpointId":input,"checkpointId":cp,"requestDigest":digest(new_id.as_bytes())}).to_string();
    let previous_cp:String=c.query_row("SELECT p.document FROM arena_story_session s JOIN arena_story_checkpoint p ON p.session_id=s.id AND p.id=s.working_checkpoint_id WHERE s.id=?1",[session],|r|r.get(0)).unwrap();
    let cp_fields = super::super::authority(
        serde_json::from_str(&previous_cp).unwrap(),
        super::super::CHECKPOINT_AUTHORITY,
    )
    .unwrap();
    let checkpoint = super::super::materialize(
        &previous_cp,
        &cp_fields,
        &[
            ("id", json!(cp).to_string()),
            ("chapterId", json!(new_id).to_string()),
        ],
    )
    .unwrap();
    c.execute_batch("BEGIN IMMEDIATE").unwrap();
    c.execute("UPDATE arena_story_chapter SET status='superseded',superseded_by_chapter_id=?2,document=?3,document_bytes=?4,document_digest=?5 WHERE id=?1",params![old,new_id,superseded,superseded.len(),digest(superseded.as_bytes())]).unwrap();
    c.execute("INSERT INTO arena_story_chapter SELECT ?2,session_id,chapter_index,'rewrite',id,title_preview,title_truncated,created_at,markdown_bytes,?3,?4,?5,?2,?6,?7,'active',NULL,?8 FROM arena_story_chapter WHERE id=?1",params![old,new_id,new,new.len(),digest(new.as_bytes()),digest(new_id.as_bytes()),receipt,revision+1]).unwrap();
    c.execute(
        "INSERT INTO arena_story_checkpoint VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![
            cp,
            session,
            index,
            new_id,
            checkpoint,
            checkpoint.len(),
            digest(checkpoint.as_bytes())
        ],
    )
    .unwrap();
    c.execute("UPDATE arena_story_session SET revision=?2,last_chapter_id=?3,working_checkpoint_id=?4,document=?5,document_bytes=?6,document_digest=?7 WHERE id=?1",params![session,revision+1,new_id,cp,updated,updated.len(),digest(updated.as_bytes())]).unwrap();
    audit_relations(c).unwrap();
    c.execute_batch("COMMIT").unwrap();
}

#[test]
fn candidate_migration_keeps_original_bytes_and_closed_default() {
    assert_eq!(crate::store::SCHEMA_VERSION, 10);
    for branch in [false, true] {
        let c = super::super::schema::tests::connection(10);
        super::super::schema::tests::fixture(&c, branch);
        let before = bytes(&c);
        crate::store::migrate_history_candidate_for_test(&c).unwrap();
        assert_eq!(bytes(&c), before);
        verify_schema(&c, 11).unwrap();
        audit_relations(&c).unwrap();
        assert!(crate::store::migrate(&c).is_err());
        assert_eq!(
            c.query_row("PRAGMA foreign_keys", [], |r| r.get::<_, u64>(0))
                .unwrap(),
            1
        );
        let copy_null: u64 = c
            .query_row(
                "SELECT count(*) FROM arena_story_chapter WHERE committed_revision IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(copy_null, u64::from(branch));
        assert!(verify_schema(&c, 10).is_err());
    }
}

#[test]
fn history_receipts_read_active_export_continue_and_delete() {
    for branch in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let library = LocalLibrary::open(root.path()).unwrap();
        let store = library.stories();
        let initial;
        {
            let c = lock_connection(&store.connection).unwrap();
            super::super::schema::tests::fixture(&c, branch);
            initial = c
                .query_row(
                    "SELECT last_chapter_id FROM arena_story_session WHERE id='target'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .unwrap();
            crate::store::migrate_history_candidate_for_test(&c).unwrap();
            rewrite_tail(&c, "target", "rewrite-one");
            rewrite_tail(&c, "target", "rewrite-two");
            audit_relations(&c).unwrap();
            // Historical v1/v2 receipts are valid even though the chapter is inactive.
            if branch {
                let hash = digest(b"frozen branch request");
                assert!(
                    super::super::storage::read_branch_receipt(&c, "target", &initial, &hash)
                        .unwrap()
                        .is_some()
                );
            } else {
                assert!(crate::arena_story::read_receipt(&c, "target", &initial)
                    .unwrap()
                    .is_some());
            }
            assert!(super::super::audit::audit_relations(&c).is_err());
        }
        let page = store.list_chapters("target", 4, None, None).unwrap();
        assert_eq!(page.rows.len(), 2);
        assert_eq!(page.rows[1].id, "rewrite-two");
        let historical = store
            .describe_record("target", 4, RecordKind::Chapter, &initial)
            .unwrap();
        let content = store
            .read_record_chunk(&historical, 0, historical.byte_length as usize)
            .unwrap();
        assert!(std::str::from_utf8(&content)
            .unwrap()
            .contains("superseded"));
        let source = store
            .continue_descriptors("target", 4, "rewrite-two")
            .unwrap();
        assert_eq!(source.recent_chapters.len(), 2);
        assert_eq!(source.recent_chapters[1].record_id, "rewrite-two");
        assert!(store
            .resolve_branch_anchor(&BranchAnchorRequest {
                session_id: "target".into(),
                revision: 4,
                expected_last_chapter_id: "rewrite-two".into(),
                expected_chapter_count: 2,
                anchor_chapter_id: "rewrite-two".into(),
                anchor_index: 2
            })
            .is_ok());
        // Native bound traversal must count only current chapters. Renderer owns
        // Markdown formatting; this exercises the actual export file lifecycle.
        let markdown = b"# synthetic active story\n";
        let now = Instant::now();
        let export = store
            .begin_markdown_export(
                crate::arena_story::markdown_export::StoryMarkdownExportManifest {
                    session_id: "target".into(),
                    revision: 4,
                    expected_head: "rewrite-two".into(),
                    chapter_count: 2,
                    expected_byte_length: markdown.len() as u64,
                },
                now,
            )
            .unwrap();
        for (index, chunk) in markdown.chunks(3).enumerate() {
            store
                .append_markdown_export(&export.token, (index * 3) as u64, chunk, now)
                .unwrap();
        }
        let result = store
            .end_markdown_export(&export.token, &digest(markdown), now)
            .unwrap();
        assert_eq!(std::fs::read(result.absolute_path).unwrap(), markdown);
        // Existing real linear writer accepts revision 5 / chapter index 3.
        let parts=vec![(PartKind::Session,json!({"id":"target","revision":5,"chapterCount":3,"lastChapterId":"after-rewrite","workingCheckpointId":"after-cp","lastInputCheckpointId":"cp-rewrite-two","titlePreview":"","titleTruncated":false,"mode":"classic","source":{"mode":"classic"},"createdAt":0,"updatedAt":0,"branchOf":if branch {json!({"sessionId":"deleted-source","chapterId":"old-chapter","chapterIndex":1})} else {serde_json::Value::Null}}).to_string()),(PartKind::Chapter,json!({"id":"after-rewrite","sessionId":"target","index":3,"action":"continue","status":"active","sourceChapterId":"rewrite-two","titlePreview":"","titleTruncated":false,"createdAt":0,"markdownByteLength":0,"markdown":"","reportJson":{},"deterministicDigest":{}}).to_string()),(PartKind::Checkpoint1,json!({"id":"after-cp","sessionId":"target","boundaryIndex":3,"chapterId":"after-rewrite","combatants":[]}).to_string())];
        let manifest = CommitManifest {
            version: 1,
            operation_id: "after-rewrite".into(),
            session_id: "target".into(),
            expected_revision: 4,
            expected_last_chapter_id: Some("rewrite-two".into()),
            parts: parts
                .iter()
                .map(|(kind, doc)| PartDeclaration {
                    kind: *kind,
                    byte_length: doc.len() as u64,
                    digest: digest(doc.as_bytes()),
                })
                .collect(),
        };
        let now = Instant::now();
        let token = store.begin(manifest, now).unwrap().token;
        for (kind, doc) in parts {
            store.append(&token, kind, 0, doc.as_bytes(), now).unwrap();
        }
        let receipt = store.end(&token, now).unwrap();
        assert_eq!((receipt.revision, receipt.chapter_index), (5, 3));
        {
            let c = lock_connection(&store.connection).unwrap();
            audit_relations(&c).unwrap();
            assert!(
                crate::arena_story::read_receipt(&c, "target", "after-rewrite")
                    .unwrap()
                    .is_some()
            );
        }
        if !branch {
            let c = lock_connection(&store.connection).unwrap();
            c.execute_batch("SAVEPOINT bad_cp").unwrap();
            c.execute(
                "UPDATE arena_story_checkpoint SET boundary_index=1 WHERE id='cp2'",
                [],
            )
            .unwrap();
            assert!(crate::arena_story::read_receipt(&c, "target", &initial).is_err());
            c.execute_batch("ROLLBACK TO bad_cp; RELEASE bad_cp")
                .unwrap();
        }
        let target = SessionDeleteTarget {
            session: store
                .describe_record("target", 5, RecordKind::Session, "target")
                .unwrap(),
            expected_last_chapter_id: "after-rewrite".into(),
            expected_chapter_count: 3,
        };
        let deleted = store.delete_session(&target, now).unwrap();
        assert_eq!(
            (
                deleted.deleted_chapter_count,
                deleted.deleted_checkpoint_count
            ),
            (5, 6)
        );
        assert!(store.receipt("target", &initial).is_ok());
        assert_eq!(
            store
                .delete_session(&target, now)
                .unwrap()
                .deleted_chapter_count,
            0
        );
    }
}

#[test]
fn lifecycle_partial_unique_and_checkpoint_corruption_fail_closed() {
    let c = super::super::schema::tests::connection(10);
    super::super::schema::tests::fixture(&c, false);
    crate::store::migrate_history_candidate_for_test(&c).unwrap();
    rewrite_tail(&c, "target", "rewrite-one");
    assert!(c.execute("UPDATE arena_story_chapter SET status='active',superseded_by_chapter_id=NULL WHERE id='second'",[]).is_err());
    for sql in [
        "UPDATE arena_story_chapter SET committed_revision=8 WHERE id='rewrite-one'",
        "UPDATE arena_story_chapter SET source_chapter_id='first' WHERE id='rewrite-one'",
        "UPDATE arena_story_checkpoint SET boundary_index=1 WHERE id='cp-rewrite-one'",
        "DROP INDEX arena_story_chapter_active",
    ] {
        c.execute_batch("SAVEPOINT corrupt").unwrap();
        c.execute_batch(sql).unwrap();
        assert!(
            verify_schema(&c, 11)
                .and_then(|_| audit_relations(&c))
                .is_err(),
            "{sql}"
        );
        c.execute_batch("ROLLBACK TO corrupt; RELEASE corrupt")
            .unwrap();
    }
    audit_relations(&c).unwrap();
}

#[test]
fn every_candidate_ddl_failure_rolls_back_old_file_on_reopen() {
    let statements: Vec<_> = super::super::schema::MIGRATION_11
        .split(';')
        .filter(|s| !s.trim().is_empty())
        .collect();
    for stop in 0..statements.len() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic.sqlite");
        let before;
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
            crate::store::migrate_to_version_for_test(&c, 10);
            super::super::schema::tests::fixture(&c, false);
            before = bytes(&c);
            c.execute_batch("BEGIN IMMEDIATE").unwrap();
            super::super::audit::audit_relations(&c).unwrap();
            for sql in &statements[..stop] {
                c.execute_batch(sql).unwrap();
            }
            assert!(c
                .execute_batch("INSERT INTO missing_migration_fault VALUES(1)")
                .is_err());
            c.execute_batch("ROLLBACK").unwrap();
            assert!(c.is_autocommit());
        }
        let c = Connection::open(path).unwrap();
        assert_eq!(bytes(&c), before);
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            10
        );
        assert_eq!(
            crate::store::applied_migrations(&c).unwrap(),
            (1..=10).collect::<Vec<_>>()
        );
        super::super::audit::audit_relations(&c).unwrap();
    }
}

#[test]
fn real_candidate_journal_failure_rolls_back_schema_version_and_graph() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("synthetic.sqlite");
    let before;
    {
        let c = Connection::open(&path).unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        crate::store::migrate_to_version_for_test(&c, 10);
        super::super::schema::tests::fixture(&c, true);
        before = bytes(&c);
        c.execute_batch("CREATE TRIGGER migration_journal_fault BEFORE INSERT ON schema_migration WHEN NEW.version=11 BEGIN SELECT RAISE(ABORT,'synthetic journal failure'); END;").unwrap();
        assert_eq!(
            crate::store::migrate_history_candidate_for_test(&c),
            Err(crate::store::StoreError::Failure)
        );
        assert!(c.is_autocommit());
    }
    let c = Connection::open(&path).unwrap();
    assert_eq!(bytes(&c), before);
    verify_schema(&c, 10).unwrap();
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        10
    );
    assert_eq!(
        crate::store::applied_migrations(&c).unwrap(),
        (1..=10).collect::<Vec<_>>()
    );
    super::super::audit::audit_relations(&c).unwrap();
}

#[test]
fn first_chapter_rewrites_preserve_initial_checkpoint_and_old_success() {
    let root = tempfile::tempdir().unwrap();
    let lib = LocalLibrary::open(root.path()).unwrap();
    let store = lib.stories();
    let now = Instant::now();
    let parts = crate::arena_story::tests::fixture("first-only", 1);
    let manifest = crate::arena_story::tests::manifest("first-only", 1, &parts);
    let token = store.begin(manifest, now).unwrap().token;
    for (kind, doc) in parts {
        store.append(&token, kind, 0, doc.as_bytes(), now).unwrap();
    }
    let original = store.end(&token, now).unwrap();
    {
        let c = lock_connection(&store.connection).unwrap();
        crate::store::migrate_history_candidate_for_test(&c).unwrap();
        rewrite_tail(&c, "first-only", "first-rewrite");
        rewrite_tail(&c, "first-only", "second-rewrite");
        audit_relations(&c).unwrap();
    }
    assert_eq!(
        store.receipt("first-only", &original.operation_id).unwrap(),
        Some(original)
    );
    assert_eq!(
        store
            .list_chapters("first-only", 3, None, None)
            .unwrap()
            .rows[0]
            .id,
        "second-rewrite"
    );
}

#[test]
fn candidate_backup_restores_complete_history_and_fences_pending_without_release_activation() {
    for branch in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let lib = LocalLibrary::open(root.path()).unwrap();
        let (pending, parts) = crate::arena_story::pending::tests::candidate(
            crate::arena_story::pending::Product::Battle,
            true,
        );
        let token = crate::arena_story::pending::tests::upload(lib.stories(), &pending, &parts);
        lib.stories().pending_seal(&token).unwrap();
        let before;
        {
            let c = lock_connection(lib.connection()).unwrap();
            super::super::schema::tests::fixture(&c, branch);
            crate::store::migrate_history_candidate_for_test(&c).unwrap();
            rewrite_tail(&c, "target", "rewrite-one");
            rewrite_tail(&c, "target", "rewrite-two");
            before = bytes(&c);
        }
        let historical = lib
            .stories()
            .describe_record(
                "target",
                4,
                RecordKind::Chapter,
                if branch { "new-chapter" } else { "second" },
            )
            .unwrap();
        assert_eq!(
            crate::backup::create_backup(&lib).err(),
            Some(crate::backup::BackupError::UnsupportedVersion)
        );
        crate::store::with_history_schema_for_test(|| {
            let backup = crate::backup::create_backup(&lib).unwrap();
            {
                let c = lock_connection(lib.connection()).unwrap();
                rewrite_tail(&c, "target", "post-backup");
            }
            drop(crate::restore::prepare_restore(&lib, &backup.backup_id).unwrap());
            drop(lib);
            crate::restore::recover_pending(root.path()).unwrap();
            let restored = LocalLibrary::open(root.path()).unwrap();
            {
                let c = lock_connection(restored.connection()).unwrap();
                assert_eq!(bytes(&c), before);
                audit_relations(&c).unwrap();
                crate::arena_story::pending::audit(&c).unwrap();
            }
            assert_eq!(
                restored
                    .stories()
                    .list_chapters("target", 4, None, None)
                    .unwrap()
                    .rows
                    .len(),
                2
            );
            assert_eq!(
                restored.stories().read_record_chunk(&historical, 0, 1),
                Err(StoryError::Stale)
            );
            if branch {
                assert!(restored
                    .stories()
                    .branch_receipt("target", "new-chapter", &digest(b"frozen branch request"))
                    .unwrap()
                    .is_some());
            } else {
                assert!(restored
                    .stories()
                    .receipt("target", "second")
                    .unwrap()
                    .is_some());
            }
            let snapshot = restored
                .stories()
                .pending_describe(pending.product)
                .unwrap()
                .unwrap();
            assert!(snapshot.restored);
            let wire = pending
                .commit_manifest
                .as_ref()
                .unwrap()
                .wire_digest()
                .unwrap();
            assert_eq!(
                restored
                    .stories()
                    .pending_prepare_save(&pending.key(), &wire),
                Err(StoryError::CommitUnknown)
            );
            assert!(restored
                .stories()
                .receipt("story", &pending.operation_id)
                .unwrap()
                .is_none());
        });
        assert_eq!(crate::store::supported_schema_version(), 10);
        assert!(LocalLibrary::open(root.path()).is_err());
    }
}

#[test]
fn candidate_schema_rejects_old_full_uniqueness_even_with_new_partial_indexes() {
    let c = super::super::schema::tests::connection(10);
    super::super::schema::tests::fixture(&c, false);
    crate::store::migrate_history_candidate_for_test(&c).unwrap();
    for sql in ["CREATE UNIQUE INDEX forged_old_chapter ON arena_story_chapter(session_id,chapter_index)","CREATE UNIQUE INDEX forged_old_checkpoint ON arena_story_checkpoint(session_id,boundary_index)"] {
        c.execute_batch("SAVEPOINT old_shape").unwrap();c.execute_batch(sql).unwrap();assert!(verify_schema(&c,11).is_err());c.execute_batch("ROLLBACK TO old_shape; RELEASE old_shape").unwrap();
    }
}
