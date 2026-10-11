//! Candidate-11 compatibility through the actual native writers, not SQL-created
//! ideal branch rows. The TypeScript pipe independently checks domain projection.
use super::*;
use crate::arena_story::branch::tail_rewrite::tests::{continue_after, rewrite_for_branch};
use crate::arena_story::read::BranchAnchorRequest;
use crate::store::with_history_schema_for_test;

fn snapshot(store: &StoryStore, session: &str) -> Vec<Vec<String>> {
    let c = lock_connection(&store.connection).unwrap();
    [
        "SELECT hex(document)||':'||hex(seed_document)||':'||document_digest||':'||seed_digest FROM arena_story_session WHERE id=?1 ORDER BY id",
        "SELECT id||':'||hex(document)||':'||hex(receipt)||':'||operation_id||':'||operation_digest||':'||document_digest||':'||status||':'||coalesce(superseded_by_chapter_id,'')||':'||coalesce(committed_revision,0) FROM arena_story_chapter WHERE session_id=?1 ORDER BY id",
        "SELECT id||':'||hex(document)||':'||document_digest FROM arena_story_checkpoint WHERE session_id=?1 ORDER BY id",
    ].iter().map(|sql| c.prepare(sql).unwrap().query_map([session], |r| r.get(0)).unwrap().collect::<Result<Vec<String>, _>>().unwrap()).collect()
}

fn resolve(
    store: &StoryStore,
    source: &BranchSource,
) -> Result<crate::arena_story::read::BranchAnchorDescriptors, StoryError> {
    store.resolve_branch_anchor(&BranchAnchorRequest {
        session_id: source.session.session_id.clone(),
        revision: source.session.revision,
        expected_last_chapter_id: source.expected_last_chapter_id.clone(),
        expected_chapter_count: source.expected_chapter_count,
        anchor_chapter_id: source.anchor.record_id.clone(),
        anchor_index: source.anchor_index,
    })
}

fn raw(store: &StoryStore, id: &str) -> String {
    lock_connection(&store.connection)
        .unwrap()
        .query_row(
            "SELECT document FROM arena_story_chapter WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
}

#[test]
fn repeated_rewrites_copy_only_active_prefix_then_continue_and_rebranch() {
    with_history_schema_for_test(|| {
        for count in [1, 3, 15] {
            let (_root, lib) = library();
            let store = lib.stories();
            for index in 1..=count {
                commit(store, "source", index);
            }
            let first = rewrite_for_branch(store, "source", "rewrite-first");
            let latest = rewrite_for_branch(store, "source", "rewrite-latest");
            let original = raw(store, "rewrite-latest");
            let opaque = r#", "generationId" : "original-generation", "opaque" : {"x":1e+02,"x":2,"\ud800":"\udfff"}, "\udfff": "\ud800" }"#;
            let document = format!("{}{opaque}", original.trim_end_matches('}'));
            lock_connection(&store.connection).unwrap().execute("UPDATE arena_story_chapter SET document=?2,document_bytes=?3,document_digest=?4 WHERE id=?1", params!["rewrite-latest",document,document.len(),digest(document.as_bytes())]).unwrap();
            let before = snapshot(store, "source");
            for anchor in [1, count] {
                let target = format!("target-{anchor}-{count}");
                // Avoid the duplicate anchor for a single-chapter source.
                if counts(store, &target).0 != 0 {
                    continue;
                }
                let (manifest, parts) = fixture(store, "source", count, anchor, &target);
                assert_eq!(manifest.source.session.revision, count + 2);
                let source = resolve(store, &manifest.source).unwrap();
                assert_eq!(source.recent_chapters.len() as u64, anchor.min(12));
                assert_eq!(
                    source.recent_chapters.last().unwrap().record_id,
                    manifest.source.anchor.record_id
                );
                let receipt = branch(store, manifest.clone(), &parts);
                assert_eq!(receipt.chapter_count, anchor + 1);
                assert_eq!(receipt.revision, anchor + 1);
                assert_eq!(snapshot(store, "source"), before);
                assert_eq!(counts(store, &target), (1, anchor + 1, anchor + 2));
                if anchor == count {
                    let copied = copy_id(&target, CopyKind::Chapter, anchor).unwrap();
                    let copied_raw = raw(store, &copied);
                    assert!(
                        copied_raw.contains(opaque.trim_start_matches(", ").trim_end_matches(" }"))
                    );
                    let fields = authority(
                        serde_json::from_str(&copied_raw).unwrap(),
                        CHAPTER_AUTHORITY,
                    )
                    .unwrap();
                    let index = chapter_index(&fields).unwrap();
                    assert_eq!(index.action, "rewrite");
                    assert_eq!(index.source_chapter_id, None);
                    let c = lock_connection(&store.connection).unwrap();
                    let (revision, marker): (Option<u64>, String) = c.query_row("SELECT committed_revision,receipt FROM arena_story_chapter WHERE id=?1", [&copied], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
                    assert_eq!(revision, None);
                    let marker = CopyMarker::decode(&marker).unwrap();
                    assert_eq!(marker.source_chapter_id, "rewrite-latest");
                    assert_eq!(marker.source_session_id, "source");
                    drop(c);
                    assert!(store.receipt(&target, &copied).is_err());
                    assert!(store
                        .branch_receipt(&target, &copied, &manifest.request_digest().unwrap())
                        .is_err());
                    assert_eq!(
                        store.tail_rewrite_receipt(
                            &target,
                            &latest.operation_id,
                            &latest.request_digest
                        ),
                        Err(StoryError::OperationMismatch)
                    );
                    continue_after(store, &target, &format!("continued-{count}"));
                    // Copied rewrite/null can itself be an arbitrary branch anchor.
                    let second = format!("second-{count}");
                    let (m, p) = fixture(store, &target, anchor + 2, anchor, &second);
                    resolve(store, &m.source).unwrap();
                    branch(store, m, &p);
                    assert_eq!(
                        chapter_index(
                            &authority(
                                serde_json::from_str(&raw(
                                    store,
                                    &copy_id(&second, CopyKind::Chapter, anchor).unwrap()
                                ))
                                .unwrap(),
                                CHAPTER_AUTHORITY
                            )
                            .unwrap()
                        )
                        .unwrap()
                        .source_chapter_id,
                        None
                    );
                }
            }
            assert_eq!(
                store
                    .tail_rewrite_receipt("source", &first.operation_id, &first.request_digest)
                    .unwrap(),
                Some(first)
            );
            assert_eq!(
                store
                    .tail_rewrite_receipt("source", &latest.operation_id, &latest.request_digest)
                    .unwrap(),
                Some(latest)
            );
            continue_after(store, "source", "after-rewrite");
            let (m, p) = fixture(store, "source", count + 1, count + 1, "after-continue");
            branch(store, m, &p);
            super::super::super::history::audit_relations(
                &lock_connection(&store.connection).unwrap(),
            )
            .unwrap();
        }
    });
}

#[test]
fn rewritten_branch_full_history_cas_digest_and_instance_remain_required() {
    with_history_schema_for_test(|| {
        let (root, lib) = library();
        let store = lib.stories();
        for index in 1..=3 {
            commit(store, "source", index);
        }
        rewrite_for_branch(store, "source", "rewrite-one");
        let (m, p) = fixture(store, "source", 3, 1, "target");
        let token = store.begin_branch(m.clone(), Instant::now()).unwrap().token;
        upload_parts(store, &token, &p);
        // A suffix rewrite invalidates an early anchor's entire frozen source.
        rewrite_for_branch(store, "source", "rewrite-two");
        assert_eq!(
            store.end_branch(&token, Instant::now()),
            Err(StoryError::Stale)
        );
        store.abort(&token).unwrap();
        let (m, p) = fixture(store, "source", 3, 1, "target");
        for (table, column, id, expression) in [
            (
                "arena_story_chapter",
                "document_digest",
                "rewrite-one",
                "'sha256:0000000000000000000000000000000000000000000000000000000000000000'",
            ),
            (
                "arena_story_chapter",
                "receipt",
                "rewrite-one",
                "json_set(receipt,'$.targetChapterId','wrong')",
            ),
            (
                "arena_story_checkpoint",
                "document",
                "source-checkpoint-3",
                "document||' '",
            ),
            (
                "arena_story_chapter",
                "source_chapter_id",
                "rewrite-two",
                "'source-chapter-1'",
            ),
        ] {
            let original: String;
            {
                let c = lock_connection(&store.connection).unwrap();
                original = c
                    .query_row(
                        &format!("SELECT {column} FROM {table} WHERE id=?1"),
                        [id],
                        |r| r.get(0),
                    )
                    .unwrap();
                c.execute(
                    &format!("UPDATE {table} SET {column}={expression} WHERE id=?1"),
                    [id],
                )
                .unwrap();
            }
            assert!(resolve(store, &m.source).is_err(), "{table}/{column}");
            assert!(
                check_source(&lock_connection(&store.connection).unwrap(), &m).is_err(),
                "{table}/{column}"
            );
            lock_connection(&store.connection)
                .unwrap()
                .execute(
                    &format!("UPDATE {table} SET {column}=?2 WHERE id=?1"),
                    params![id, original],
                )
                .unwrap();
        }
        let before = snapshot(store, "source");
        drop(lib);
        let reopened = LocalLibrary::open(root.path()).unwrap();
        let store = reopened.stories();
        let token = store.begin_branch(m, Instant::now()).unwrap().token;
        upload_parts(store, &token, &p);
        assert_eq!(
            store.end_branch(&token, Instant::now()),
            Err(StoryError::Stale)
        );
        assert_eq!(counts(store, "target"), (0, 0, 0));
        assert_eq!(snapshot(store, "source"), before);
    });
}

#[test]
fn rewrite_copy_requires_exact_marker_and_null_local_lineage() {
    with_history_schema_for_test(|| {
        let (_root, lib) = library();
        let store = lib.stories();
        for index in 1..=2 {
            commit(store, "source", index);
        }
        rewrite_for_branch(store, "source", "rewritten");
        let (m, p) = fixture(store, "source", 2, 2, "target");
        branch(store, m, &p);
        let copied = copy_id("target", CopyKind::Chapter, 2).unwrap();
        let c = lock_connection(&store.connection).unwrap();
        for assignment in [
            "receipt='{}'",
            "receipt=json_set(receipt,'$.kind','tail-rewrite','$.version',3)",
            "receipt=json_set(receipt,'$.chapterId','forged')",
            "receipt=json_set(receipt,'$.chapterIndex',1)",
            "receipt=json_set(receipt,'$.sourceSessionId','other')",
            "receipt=json_set(receipt,'$.sourceChapterId','other')",
            "receipt=json_set(receipt,'$.branchOperationId','other')",
            "receipt=json_set(receipt,'$.requestDigest','sha256:0000000000000000000000000000000000000000000000000000000000000000')",
            "receipt=json_remove(receipt,'$.sourceChapterId')",
            "committed_revision=2",
            "action='continue'",
            "source_chapter_id=(SELECT id FROM arena_story_chapter WHERE session_id='target' AND chapter_index=1)",
        ] {
            c.execute_batch("SAVEPOINT forged_copy").unwrap();
            c.execute(&format!("UPDATE arena_story_chapter SET {assignment} WHERE id=?1"), [&copied]).unwrap();
            assert!(super::super::super::audit::audit_session(&c, "target").is_err(), "{assignment}");
            c.execute_batch("ROLLBACK TO forged_copy; RELEASE forged_copy").unwrap();
        }
        super::super::super::history::audit_relations(&c).unwrap();
        // Keep raw JSON, hashes and indexed fields consistent: these must fail
        // on lineage/receipt semantics rather than an incidental column mismatch.
        let previous = copy_id("target", CopyKind::Chapter, 1).unwrap();
        for (id, action, source) in [
            (copied.as_str(), "rewrite", Some(previous.as_str())),
            (copied.as_str(), "continue", None),
            ("rewritten", "rewrite", None),
        ] {
            c.execute_batch("SAVEPOINT consistent_forgery").unwrap();
            let document: String = c
                .query_row(
                    "SELECT document FROM arena_story_chapter WHERE id=?1",
                    [id],
                    |r| r.get(0),
                )
                .unwrap();
            let mut value: Value = serde_json::from_str(&document).unwrap();
            value["action"] = json!(action);
            value["sourceChapterId"] = json!(source);
            let document = value.to_string();
            c.execute("UPDATE arena_story_chapter SET action=?2,source_chapter_id=?3,document=?4,document_bytes=?5,document_digest=?6 WHERE id=?1", params![id,action,source,document,document.len(),digest(document.as_bytes())]).unwrap();
            assert!(
                super::super::super::history::audit_relations(&c).is_err(),
                "{id}/{action}/{source:?}"
            );
            c.execute_batch("ROLLBACK TO consistent_forgery; RELEASE consistent_forgery")
                .unwrap();
        }
        // A real rewrite generation cannot adopt the copy/null exception.
        c.execute_batch("SAVEPOINT forged_generation").unwrap();
        c.execute(
            "UPDATE arena_story_chapter SET source_chapter_id=NULL WHERE id='rewritten'",
            [],
        )
        .unwrap();
        assert!(super::super::super::history::audit_relations(&c).is_err());
        c.execute_batch("ROLLBACK TO forged_generation; RELEASE forged_generation")
            .unwrap();
    });
}

#[test]
fn old_schema_branch_auditors_still_reject_rewrite_copy_shape() {
    for version in [9, 10] {
        let (_root, lib) = library();
        let store = lib.stories();
        commit(store, "source", 1);
        let (m, p) = fixture(store, "source", 1, 1, "target");
        branch(store, m, &p);
        let copied = copy_id("target", CopyKind::Chapter, 1).unwrap();
        let c = lock_connection(&store.connection).unwrap();
        c.execute_batch("PRAGMA ignore_check_constraints=ON")
            .unwrap();
        c.pragma_update(None, "user_version", version).unwrap();
        let document: String = c
            .query_row(
                "SELECT document FROM arena_story_chapter WHERE id=?1",
                [&copied],
                |r| r.get(0),
            )
            .unwrap();
        let document = document.replace("\"start\"", "\"rewrite\"");
        c.execute("UPDATE arena_story_chapter SET action='rewrite',document=?2,document_bytes=?3,document_digest=?4 WHERE id=?1", params![copied,document,document.len(),digest(document.as_bytes())]).unwrap();
        assert!(super::super::super::audit::audit_session(&c, "target").is_err());
    }
}

#[test]
fn old_schema_resolver_rejects_rewrite_raw_before_prompt_for_anchor_and_window() {
    for version in [9, 10] {
        for (count, bad_index) in [(1, 1), (15, 14)] {
            let (_root, lib) = library();
            let store = lib.stories();
            for index in 1..=count {
                commit(store, "source", index);
            }
            let (m, _) = fixture(store, "source", count, count, "target");
            assert!(resolve(store, &m.source).is_ok());
            let id = format!("source-chapter-{bad_index}");
            let original = raw(store, &id);
            let mut document: Value = serde_json::from_str(&original).unwrap();
            document["action"] = json!("rewrite");
            document["sourceChapterId"] = Value::Null;
            let document = document.to_string();
            {
                let c = lock_connection(&store.connection).unwrap();
                c.pragma_update(None, "user_version", version).unwrap();
                // Index remains legal legacy action; recompute the original's
                // hash so the resolver must actually inspect the raw action.
                c.execute("UPDATE arena_story_chapter SET document=?2,document_bytes=?3,document_digest=?4 WHERE id=?1", params![id,document,document.len(),digest(document.as_bytes())]).unwrap();
            }
            assert_eq!(
                resolve(store, &m.source).err(),
                Some(StoryError::Corrupt),
                "schema {version}, chapter {bad_index}"
            );
            assert_eq!(counts(store, "target"), (0, 0, 0));
        }
    }
}

#[test]
fn rewritten_branch_survives_source_deletion_backup_restore_and_historical_receipts() {
    with_history_schema_for_test(|| {
        let (root, lib) = library();
        let store = lib.stories();
        commit(store, "source", 1);
        rewrite_for_branch(store, "source", "rewritten");
        let (m, p) = fixture(store, "source", 1, 1, "target");
        let receipt = branch(store, m.clone(), &p);
        let rewritten = rewrite_for_branch(store, "target", "target-rewritten");
        let continued = continue_after(store, "target", "target-continued");
        let before = snapshot(store, "target");
        let backup = crate::backup::create_backup(&lib).unwrap();
        let late = rewrite_for_branch(store, "target", "post-backup");
        drop(crate::restore::prepare_restore(&lib, &backup.backup_id).unwrap());
        drop(lib);
        crate::restore::recover_pending(root.path()).unwrap();
        let restored = LocalLibrary::open(root.path()).unwrap();
        let store = restored.stories();
        assert_eq!(snapshot(store, "target"), before);
        assert_eq!(
            store
                .branch_receipt("target", &receipt.operation_id, &receipt.request_digest)
                .unwrap(),
            Some(receipt.clone())
        );
        assert_eq!(
            store
                .tail_rewrite_receipt("target", &rewritten.operation_id, &rewritten.request_digest)
                .unwrap(),
            Some(rewritten)
        );
        assert_eq!(
            store.receipt("target", &continued.operation_id).unwrap(),
            Some(continued)
        );
        assert_eq!(
            store
                .tail_rewrite_receipt("target", &late.operation_id, &late.request_digest)
                .unwrap(),
            None
        );
        let session = store
            .describe_record("source", 2, RecordKind::Session, "source")
            .unwrap();
        let removed = store
            .delete_session(
                &crate::arena_story::delete::SessionDeleteTarget {
                    session,
                    expected_last_chapter_id: "rewritten".into(),
                    expected_chapter_count: 1,
                },
                Instant::now(),
            )
            .unwrap();
        assert_eq!(counts(store, "source"), (0, 0, 0));
        let _ = removed;
        assert_eq!(
            store
                .branch_receipt("target", &receipt.operation_id, &receipt.request_digest)
                .unwrap(),
            Some(receipt)
        );
        let page = store.list_chapters("target", 4, None, None).unwrap();
        assert_eq!(page.rows.len(), 3);
        assert_eq!(page.rows[0].action, "rewrite");
        assert!(store
            .describe_record("target", 4, RecordKind::Chapter, &m.operation_id)
            .is_ok());
        let markdown = b"# active rewritten branch\n";
        let exported = store
            .begin_markdown_export(
                crate::arena_story::markdown_export::StoryMarkdownExportManifest {
                    session_id: "target".into(),
                    revision: 4,
                    expected_head: "target-continued".into(),
                    chapter_count: 3,
                    expected_byte_length: markdown.len() as u64,
                },
                Instant::now(),
            )
            .unwrap();
        store
            .append_markdown_export(&exported.token, 0, markdown, Instant::now())
            .unwrap();
        let exported = store
            .end_markdown_export(&exported.token, &digest(markdown), Instant::now())
            .unwrap();
        assert_eq!(std::fs::read(exported.absolute_path).unwrap(), markdown);
        crate::backup::create_backup(&restored).unwrap();
        let session = store
            .describe_record("target", 4, RecordKind::Session, "target")
            .unwrap();
        store
            .delete_session(
                &crate::arena_story::delete::SessionDeleteTarget {
                    session,
                    expected_last_chapter_id: "target-continued".into(),
                    expected_chapter_count: 3,
                },
                Instant::now(),
            )
            .unwrap();
        assert_eq!(counts(store, "target"), (0, 0, 0));
    });
}
