use super::super::receipt::{BranchKind, BranchReceipt, CopyKind as MarkerKind, CopyMarker};
use super::super::{copy_id, CopyKind};
use crate::arena_story::{digest, StoryError, StoryReceipt};
use rusqlite::{params, Connection};
use serde_json::json;

pub(crate) fn connection(version: i64) -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    crate::store::migrate_to_version_for_test(&c, version);
    c
}
pub(crate) fn fixture(c: &Connection, branch: bool) {
    let session = "target";
    let ids = if branch {
        vec![
            copy_id(session, CopyKind::Chapter, 1).unwrap(),
            "new-chapter".into(),
        ]
    } else {
        vec!["first".into(), "second".into()]
    };
    let cps = if branch {
        vec![
            copy_id(session, CopyKind::Checkpoint, 0).unwrap(),
            copy_id(session, CopyKind::Checkpoint, 1).unwrap(),
            "new-checkpoint".into(),
        ]
    } else {
        vec!["cp0".into(), "cp1".into(), "cp2".into()]
    };
    let request = digest(b"frozen branch request");
    let mut document = json!({"id":session,"revision":2,"chapterCount":2,"lastChapterId":ids[1],
        "workingCheckpointId":cps[2],"lastInputCheckpointId":cps[1],"titlePreview":"","titleTruncated":false,
        "mode":"classic","source":{"mode":"classic"},"createdAt":0,"updatedAt":0});
    if branch {
        document["branchOf"] =
            json!({"sessionId":"deleted-source","chapterId":"old-chapter","chapterIndex":1});
    }
    let document = document.to_string();
    // Preserve opaque duplicate members, escaped key spelling and lone surrogate.
    let document = format!(
        "{},\"opaque\":1,\"opaque\":\"\\ud800\",\"\\u0078\":2}}",
        &document[..document.len() - 1]
    );
    let seed = "{\"combatants\":[],\"opaque\":\"\\ud800\"}";
    c.execute_batch("BEGIN").unwrap();
    c.execute("INSERT INTO arena_story_session VALUES (?1,?2,?3,?4,?5,?6,?7,2,'',0,'classic',NULL,0,0,2,?8,?9,?10)",
        params![session,document,document.len(),digest(document.as_bytes()),seed,seed.len(),digest(seed.as_bytes()),ids[1],cps[2],cps[1]]).unwrap();
    for i in 1..=2usize {
        let action = if i == 1 {
            "start"
        } else if branch {
            "branch"
        } else {
            "continue"
        };
        let previous = if i == 1 { None } else { Some(&ids[0]) };
        let doc=json!({"id":ids[i-1],"sessionId":session,"index":i,"action":action,"sourceChapterId":previous,
            "status":"active","titlePreview":"","titleTruncated":false,"createdAt":0,"markdownByteLength":0,"markdown":"","generationId":"historical-generation","reportJson":{},"deterministicDigest":{}}).to_string();
        let receipt = if branch && i == 1 {
            CopyMarker {
                version: 2,
                kind: MarkerKind::Copy,
                branch_operation_id: ids[1].clone(),
                session_id: session.into(),
                chapter_id: ids[0].clone(),
                chapter_index: 1,
                source_session_id: "deleted-source".into(),
                source_chapter_id: "old-chapter".into(),
                request_digest: request.clone(),
            }
            .encode()
            .unwrap()
        } else if branch {
            BranchReceipt {
                version: 2,
                kind: BranchKind::Branch,
                operation_id: ids[1].clone(),
                session_id: session.into(),
                chapter_id: ids[1].clone(),
                chapter_index: 2,
                revision: 2,
                chapter_count: 2,
                prefix_end_index: 1,
                anchor_chapter_id: ids[0].clone(),
                anchor_checkpoint_id: cps[1].clone(),
                checkpoint_id: cps[2].clone(),
                request_digest: request.clone(),
            }
            .encode()
            .unwrap()
        } else {
            serde_json::to_string(&StoryReceipt {
                version: 1,
                operation_id: ids[i - 1].clone(),
                session_id: session.into(),
                chapter_id: ids[i - 1].clone(),
                chapter_index: i as u64,
                revision: i as u64,
                chapter_count: i as u64,
                checkpoint_ids: if i == 1 {
                    cps[..2].to_vec()
                } else {
                    vec![cps[2].clone()]
                },
                wire_digest: request.clone(),
            })
            .unwrap()
        };
        c.execute(
            "INSERT INTO arena_story_chapter VALUES (?1,?2,?3,?4,?5,'',0,0,0,?6,?7,?8,?1,?9,?10)",
            params![
                ids[i - 1],
                session,
                i,
                action,
                previous,
                doc,
                doc.len(),
                digest(doc.as_bytes()),
                request,
                receipt
            ],
        )
        .unwrap();
    }
    for i in 0..=2usize {
        let chapter = if i == 0 { None } else { Some(&ids[i - 1]) };
        let doc=json!({"id":cps[i],"sessionId":session,"boundaryIndex":i,"chapterId":chapter,"combatants":[]}).to_string();
        c.execute(
            "INSERT INTO arena_story_checkpoint VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                cps[i],
                session,
                i,
                chapter,
                doc,
                doc.len(),
                digest(doc.as_bytes())
            ],
        )
        .unwrap();
    }
    c.execute_batch("COMMIT").unwrap();
}
fn snapshots(c: &Connection) -> Vec<Vec<String>> {
    ["SELECT hex(document)||':'||hex(seed_document)||':'||document_digest||':'||seed_digest FROM arena_story_session ORDER BY id",
        "SELECT hex(document)||':'||hex(receipt)||':'||hex(operation_id)||':'||operation_digest||':'||document_digest FROM arena_story_chapter ORDER BY id",
        "SELECT hex(document)||':'||document_digest FROM arena_story_checkpoint ORDER BY id"].iter().map(|sql| {
            c.prepare(sql).unwrap().query_map([],|r|r.get(0)).unwrap().collect::<Result<Vec<String>,_>>().unwrap()
        }).collect()
}
#[test]
fn schema9_migrates_real_cyclic_rows_with_foreign_keys_on_and_preserves_bytes() {
    let c = connection(8);
    fixture(&c, false);
    crate::arena_story::audit_relations(&c).unwrap();
    let before = snapshots(&c);
    crate::store::migrate(&c).unwrap();
    assert_eq!(before, snapshots(&c));
    assert_eq!(
        c.query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        crate::store::SCHEMA_VERSION
    );
    assert!(!c
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    super::super::audit::audit_relations(&c).unwrap();
    crate::store::migrate(&c).unwrap();
    assert_eq!(before, snapshots(&c));
}
#[test]
fn failed_schema9_migration_restores_version_rows_and_cyclic_schema() {
    let c = connection(8);
    fixture(&c, false);
    let before = snapshots(&c);
    c.execute_batch("CREATE TABLE arena_story_chapter_v9 (collision TEXT)")
        .unwrap();
    assert!(crate::store::migrate(&c).is_err());
    assert!(c.is_autocommit());
    assert_eq!(before, snapshots(&c));
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        8
    );
    assert!(!c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='arena_story_session_v9')",
            [],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
    assert!(!c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migration WHERE version=9)",
            [],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
    c.execute_batch("DROP TABLE arena_story_chapter_v9")
        .unwrap();
    crate::store::migrate(&c).unwrap();
    assert_eq!(before, snapshots(&c));
}
#[test]
fn branch_audit_is_source_independent_and_old_schema_audit_stays_strict() {
    let c = connection(9);
    fixture(&c, true);
    super::super::audit::audit_relations(&c).unwrap();
    assert_eq!(
        crate::arena_story::audit_relations(&c),
        Err(StoryError::Corrupt)
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM arena_story_session", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn branch_audit_rejects_forged_receipts_hashes_ranges_and_copy_ownership() {
    for sql in [
        "UPDATE arena_story_chapter SET receipt=json_set(receipt,'$.requestDigest','sha256:0000000000000000000000000000000000000000000000000000000000000000') WHERE chapter_index=1",
        "UPDATE arena_story_chapter SET receipt=json_set(receipt,'$.branchOperationId','other') WHERE chapter_index=1",
        "UPDATE arena_story_chapter SET receipt=json_set(receipt,'$.kind','branch') WHERE chapter_index=1",
        "UPDATE arena_story_chapter SET receipt=json_set(receipt,'$.prefixEndIndex',2) WHERE chapter_index=2",
        "UPDATE arena_story_chapter SET receipt=json_set(receipt,'$.sourceSessionId','target') WHERE chapter_index=1",
        "UPDATE arena_story_chapter SET operation_id='other' WHERE chapter_index=1",
        "UPDATE arena_story_chapter SET receipt=receipt||printf('%2049s','') WHERE chapter_index=1",
        "UPDATE arena_story_session SET seed_digest='sha256:0000000000000000000000000000000000000000000000000000000000000000'",
        "UPDATE arena_story_checkpoint SET document_digest='sha256:0000000000000000000000000000000000000000000000000000000000000000' WHERE boundary_index=0",
        "UPDATE arena_story_chapter SET receipt=json_set(receipt,'$.checkpointId','bad') WHERE chapter_index=2",
    ] {
        let c=connection(9);fixture(&c,true);c.execute_batch(sql).unwrap();
        assert_eq!(super::super::audit::audit_relations(&c),Err(StoryError::Corrupt),"{sql}");
    }
}

#[test]
fn branch_audit_preserves_escaped_authority_keys_and_opaque_surrogates() {
    let c = connection(9);
    fixture(&c, true);
    for table in [
        "arena_story_session",
        "arena_story_chapter",
        "arena_story_checkpoint",
    ] {
        let rows: Vec<(i64, String)> = c
            .prepare(&format!("SELECT rowid,document FROM {table}"))
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for (rowid, document) in rows {
            let document = document.replace("\"id\":", "\"\\u0069d\":");
            let document = format!(
                "{},\"\\ud800\":1,\"opaqueExtension\":1,\"opaqueExtension\":\"\\ud800\"}}",
                &document[..document.len() - 1]
            );
            c.execute(&format!("UPDATE {table} SET document=?1,document_bytes=?2,document_digest=?3 WHERE rowid=?4"),params![document,document.len(),digest(document.as_bytes()),rowid]).unwrap();
        }
    }
    super::super::audit::audit_relations(&c).unwrap();
    let document: String = c
        .query_row(
            "SELECT document FROM arena_story_chapter WHERE chapter_index=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let bad = format!(
        "{},\"id\":\"duplicate-authority\"}}",
        &document[..document.len() - 1]
    );
    c.execute("UPDATE arena_story_chapter SET document=?1,document_bytes=?2,document_digest=?3 WHERE chapter_index=1",params![bad,bad.len(),digest(bad.as_bytes())]).unwrap();
    assert_eq!(
        super::super::audit::audit_relations(&c),
        Err(StoryError::Corrupt)
    );
}

#[test]
fn target_audit_does_not_read_unrelated_corrupt_history() {
    let c = connection(9);
    fixture(&c, true);
    c.execute_batch("BEGIN; INSERT INTO arena_story_session VALUES ('unrelated','{}',2,'bad','{}',2,'bad',1,'',0,'classic',NULL,0,0,1,'missing-chapter','missing-working','missing-input');").unwrap();
    super::super::audit::audit_session(&c, "target").unwrap();
    assert_eq!(
        super::super::audit::audit_relations(&c),
        Err(StoryError::Corrupt)
    );
    assert_eq!(
        super::super::audit::audit_session(&c, "missing"),
        Err(StoryError::Corrupt)
    );
    c.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn markdown_byte_audit_matches_sqlite_for_lone_surrogates_pairs_and_nul() {
    for (markdown, expected) in [
        (r#""\ud800""#, 3u64),
        (r#""\udc00""#, 3),
        (r#""\ud800\udc00""#, 4),
        (r#""\u0000""#, 1),
        (r#""\ud800a\udc00""#, 7),
        (r#""a\u0000b""#, 3),
    ] {
        let c = connection(9);
        fixture(&c, true);
        let sqlite_bytes: u64 = c
            .query_row(
                "SELECT length(CAST(json_extract(?1,'$') AS BLOB))",
                [markdown],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sqlite_bytes, expected);
        let document: String = c
            .query_row(
                "SELECT document FROM arena_story_chapter WHERE chapter_index=1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let document = document
            .replace("\"markdown\":\"\"", &format!("\"markdown\":{markdown}"))
            .replace(
                "\"markdownByteLength\":0",
                &format!("\"markdownByteLength\":{expected}"),
            );
        c.execute("UPDATE arena_story_chapter SET document=?1,document_bytes=?2,document_digest=?3,markdown_bytes=?4 WHERE chapter_index=1",params![document,document.len(),digest(document.as_bytes()),expected]).unwrap();
        super::super::audit::audit_relations(&c).unwrap();
        assert_eq!(
            document,
            c.query_row(
                "SELECT document FROM arena_story_chapter WHERE chapter_index=1",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap()
        );
    }
}

pub(crate) fn all_column_hashes(c: &Connection) -> Vec<String> {
    use rusqlite::types::ValueRef;
    use sha2::{Digest, Sha256};
    let mut result = Vec::new();
    for table in [
        "arena_story_session",
        "arena_story_chapter",
        "arena_story_checkpoint",
    ] {
        let mut statement = c
            .prepare(&format!("SELECT * FROM {table} ORDER BY id"))
            .unwrap();
        let columns = statement.column_count();
        let mut rows = statement.query([]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            let mut hash = Sha256::new();
            hash.update(table.as_bytes());
            for column in 0..columns {
                match row.get_ref(column).unwrap() {
                    ValueRef::Null => hash.update([0]),
                    ValueRef::Integer(value) => {
                        hash.update([1]);
                        hash.update(value.to_be_bytes());
                    }
                    ValueRef::Real(value) => {
                        hash.update([2]);
                        hash.update(value.to_bits().to_be_bytes());
                    }
                    ValueRef::Text(value) => {
                        hash.update([3]);
                        hash.update((value.len() as u64).to_be_bytes());
                        hash.update(value);
                    }
                    ValueRef::Blob(value) => {
                        hash.update([4]);
                        hash.update((value.len() as u64).to_be_bytes());
                        hash.update(value);
                    }
                }
            }
            result.push(format!("{table}:{:x}", hash.finalize()));
        }
    }
    result
}

#[test]
#[ignore = "serial capacity probe"]
fn schema9_page_capacity_failure_reopens_v8_bytes_then_retries_medium_history() {
    use std::time::Instant;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("library.sqlite");
    let c = Connection::open(&path).unwrap();
    c.execute_batch("PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;")
        .unwrap();
    crate::store::migrate_to_version_for_test(&c, 8);
    fixture(&c, false);
    let payload = "x".repeat(8 * 1024 * 1024);
    for index in 1..=2 {
        let document: String = c
            .query_row(
                "SELECT document FROM arena_story_chapter WHERE chapter_index=?1",
                [index],
                |r| r.get(0),
            )
            .unwrap();
        let document = format!(
            "{},\"largeOpaqueExtension\":\"{payload}\"}}",
            &document[..document.len() - 1]
        );
        c.execute("UPDATE arena_story_chapter SET document=?1,document_bytes=?2,document_digest=?3 WHERE chapter_index=?4",params![document,document.len(),digest(document.as_bytes()),index]).unwrap();
    }
    drop(payload);
    let before = all_column_hashes(&c);
    let mut observed = [0u64; 3];
    let sample = |observed: &mut [u64; 3]| {
        for (index, suffix) in ["", "-wal", "-shm"].iter().enumerate() {
            let bytes = std::fs::metadata(format!("{}{suffix}", path.display()))
                .map(|m| m.len())
                .unwrap_or(0);
            observed[index] = observed[index].max(bytes);
        }
    };
    sample(&mut observed);
    let pages: i64 = c.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    let limited: i64 = c
        .query_row(&format!("PRAGMA max_page_count={}", pages + 4), [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(limited, pages + 4);
    let failed_start = Instant::now();
    assert!(crate::store::migrate(&c).is_err());
    let failed_elapsed = failed_start.elapsed();
    sample(&mut observed);
    assert!(c.is_autocommit());
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        8
    );
    assert_eq!(before, all_column_hashes(&c));
    assert!(!c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name IN ('arena_story_session_v9','arena_story_chapter_v9','arena_story_checkpoint_v9'))",[],|r|r.get::<_,bool>(0)).unwrap());
    assert!(!c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migration WHERE version=9)",
            [],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
    drop(c);
    let c = Connection::open(&path).unwrap();
    c.execute_batch("PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;")
        .unwrap();
    sample(&mut observed);
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        8
    );
    assert_eq!(before, all_column_hashes(&c));
    assert!(!c
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    assert!(!c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name IN ('arena_story_session_v9','arena_story_chapter_v9','arena_story_checkpoint_v9'))",[],|r|r.get::<_,bool>(0)).unwrap());
    c.execute_batch("PRAGMA max_page_count=2147483647;")
        .unwrap();
    let success_start = Instant::now();
    crate::store::migrate(&c).unwrap();
    let success_elapsed = success_start.elapsed();
    sample(&mut observed);
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        crate::store::SCHEMA_VERSION
    );
    assert_eq!(before, all_column_hashes(&c));
    assert!(!c
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    println!("schema9 16MiB history capacity injection (not real ENOSPC): original_pages={pages}, failed_ms={}, retry_ms={}, sampled_max_main_bytes={}, sampled_max_wal_bytes={}, sampled_max_shm_bytes={}",failed_elapsed.as_millis(),success_elapsed.as_millis(),observed[0],observed[1],observed[2]);
}

#[test]
fn native_branch_origin_is_required_and_matches_target_prefix_provenance() {
    for expression in [
        "json_remove(document,'$.branchOf')",
        "json_set(document,'$.branchOf.sessionId','other-source')",
        "json_set(document,'$.branchOf.chapterId','other-anchor')",
        "json_set(document,'$.branchOf.chapterIndex',2)",
    ] {
        let c = connection(9);
        fixture(&c, true);
        let document: String = c
            .query_row(
                &format!("SELECT {expression} FROM arena_story_session WHERE id='target'"),
                [],
                |r| r.get(0),
            )
            .unwrap();
        c.execute("UPDATE arena_story_session SET document=?1,document_bytes=?2,document_digest=?3 WHERE id='target'",params![document,document.len(),digest(document.as_bytes())]).unwrap();
        assert_eq!(
            super::super::audit::audit_session(&c, "target"),
            Err(StoryError::Corrupt),
            "{expression}"
        );
    }
    let c = connection(9);
    fixture(&c, false);
    let document:String=c.query_row("SELECT json_set(document,'$.branchOf',json('{\"legacy\":true}')) FROM arena_story_session",[],|r|r.get(0)).unwrap();
    c.execute(
        "UPDATE arena_story_session SET document=?1,document_bytes=?2,document_digest=?3",
        params![document, document.len(), digest(document.as_bytes())],
    )
    .unwrap();
    super::super::audit::audit_session(&c, "target").unwrap();
}

fn assert_schema10_index(c: &Connection) {
    let columns: Vec<String> = c
        .prepare("SELECT name FROM pragma_index_info('arena_story_chapter_source') ORDER BY seqno")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(columns, ["session_id", "source_chapter_id"]);
    let unique: i64 = c.query_row("SELECT \"unique\" FROM pragma_index_list('arena_story_chapter') WHERE name='arena_story_chapter_source'", [], |r| r.get(0)).unwrap();
    assert_eq!(unique, 0);
}

#[test]
fn schema10_indexes_both_linear_and_branch_rows_without_changing_any_column() {
    for branch in [false, true] {
        let c = connection(9);
        fixture(&c, branch);
        let before = all_column_hashes(&c);
        crate::store::migrate_to_version_for_test(&c, 10);
        assert_schema10_index(&c);
        assert_eq!(before, all_column_hashes(&c));
        assert_eq!(
            c.query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(!c
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
        super::super::audit::audit_relations(&c).unwrap();
        crate::store::migrate_to_version_for_test(&c, 10);
        assert_eq!(before, all_column_hashes(&c));
        assert_eq!(
            crate::store::applied_migrations(&c).unwrap(),
            (1..=10).collect::<Vec<_>>()
        );
    }
}

#[test]
fn failed_schema10_migration_leaves_version_journal_rows_and_foreign_keys_intact() {
    let c = connection(9);
    fixture(&c, true);
    let before = all_column_hashes(&c);
    c.execute_batch("CREATE TABLE arena_story_chapter_source(collision TEXT)")
        .unwrap();
    assert!(crate::store::migrate(&c).is_err());
    assert!(c.is_autocommit());
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        9
    );
    assert_eq!(
        crate::store::applied_migrations(&c).unwrap(),
        (1..=9).collect::<Vec<_>>()
    );
    assert_eq!(before, all_column_hashes(&c));
    assert_eq!(
        c.query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    c.execute_batch("DROP TABLE arena_story_chapter_source")
        .unwrap();
    crate::store::migrate_to_version_for_test(&c, 10);
    assert_schema10_index(&c);
    assert_eq!(before, all_column_hashes(&c));
}

#[test]
fn schema10_sqlite_full_index_failure_rolls_back_before_successful_retry() {
    let c = connection(9);
    fixture(&c, true);
    // Remove pages left free by historical table rebuilds so max_page_count
    // genuinely stops this new index's first allocation.
    c.execute_batch("VACUUM").unwrap();
    let before = all_column_hashes(&c);
    let pages: i64 = c.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    let free: i64 = c
        .query_row("PRAGMA freelist_count", [], |r| r.get(0))
        .unwrap();
    assert_eq!(free, 0, "fixture must actually require a new index page");
    let limit: i64 = c
        .query_row(&format!("PRAGMA max_page_count={pages}"), [], |r| r.get(0))
        .unwrap();
    assert_eq!(limit, pages);
    c.execute_batch("BEGIN").unwrap();
    let error = c.execute_batch(super::MIGRATION_10).unwrap_err();
    assert_eq!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DiskFull)
    );
    if !c.is_autocommit() {
        c.execute_batch("ROLLBACK").unwrap();
    }
    assert!(crate::store::migrate(&c).is_err());
    assert!(c.is_autocommit());
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        9
    );
    assert_eq!(
        crate::store::applied_migrations(&c).unwrap(),
        (1..=9).collect::<Vec<_>>()
    );
    assert_eq!(before, all_column_hashes(&c));
    assert_eq!(
        c.query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(!c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='arena_story_chapter_source')",
            [],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
    c.execute_batch("PRAGMA max_page_count=2147483647").unwrap();
    crate::store::migrate_to_version_for_test(&c, 10);
    assert_schema10_index(&c);
    assert_eq!(before, all_column_hashes(&c));
}

#[test]
fn schema10_reverse_index_keeps_null_links_and_cross_session_fk_rejection() {
    let c = connection(10);
    fixture(&c, false);
    assert_schema10_index(&c);
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM arena_story_chapter WHERE source_chapter_id IS NULL",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    // SQL-level FK fixture only: the second session's parent ID exists globally
    // but cannot satisfy a child reference in the first session.
    c.execute_batch("BEGIN;
        INSERT INTO arena_story_session SELECT 'other',document,document_bytes,document_digest,seed_document,seed_bytes,seed_digest,1,title_preview,title_truncated,mode,chapter_plan,created_at,updated_at,1,'other-chapter','other-cp','other-cp' FROM arena_story_session WHERE id='target';
        INSERT INTO arena_story_chapter SELECT 'other-chapter','other',1,'start',NULL,title_preview,title_truncated,created_at,markdown_bytes,document,document_bytes,document_digest,'other-operation',operation_digest,receipt FROM arena_story_chapter WHERE id='first';
        INSERT INTO arena_story_checkpoint SELECT 'other-cp','other',0,NULL,document,document_bytes,document_digest FROM arena_story_checkpoint WHERE id='cp0';
        COMMIT;").unwrap();
    let before = all_column_hashes(&c);
    for bad_parent in ["other-chapter", "missing-parent"] {
        c.execute_batch("BEGIN").unwrap();
        c.execute(
            "UPDATE arena_story_chapter SET source_chapter_id=?1 WHERE id='second'",
            [bad_parent],
        )
        .unwrap();
        assert_eq!(
            c.execute_batch("COMMIT").unwrap_err().sqlite_error_code(),
            Some(rusqlite::ErrorCode::ConstraintViolation)
        );
        c.execute_batch("ROLLBACK").unwrap();
        assert_eq!(before, all_column_hashes(&c));
        assert!(!c
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
    }
}

#[test]
#[ignore = "serial migration cost on an externally prepared legal schema-9 fixture"]
fn schema10_migration_cost_preserves_real_history_and_reports_index_pages() {
    use std::time::Instant;
    let root = std::path::PathBuf::from(std::env::var("MAHO_MIGRATION_ROOT").unwrap());
    let path = root.join("library.sqlite");
    let c = Connection::open(&path).unwrap();
    c.execute_batch("PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON")
        .unwrap();
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        9
    );
    super::super::audit::audit_relations(&c).unwrap();
    let before = all_column_hashes(&c);
    let pages_before: i64 = c.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    let page_size: i64 = c.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap();
    let chapters: i64 = c
        .query_row("SELECT count(*) FROM arena_story_chapter", [], |r| r.get(0))
        .unwrap();
    let start = Instant::now();
    crate::store::migrate_to_version_for_test(&c, 10);
    let elapsed = start.elapsed().as_nanos();
    let pages_after: i64 = c.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    let index_pages: i64 = c
        .query_row(
            "SELECT count(*) FROM dbstat WHERE name='arena_story_chapter_source'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let index_bytes: i64 = c
        .query_row(
            "SELECT sum(pgsize) FROM dbstat WHERE name='arena_story_chapter_source'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(index_pages > 0);
    assert_eq!(index_bytes, index_pages * page_size);
    assert_schema10_index(&c);
    assert_eq!(before, all_column_hashes(&c));
    assert!(!c
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    super::super::audit::audit_relations(&c).unwrap();
    let wal_bytes = std::fs::metadata(root.join("library.sqlite-wal"))
        .map(|m| m.len())
        .unwrap_or(0);
    drop(c);
    let c = Connection::open(&path).unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    assert_schema10_index(&c);
    assert_eq!(before, all_column_hashes(&c));
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        10
    );
    println!(
        "SCHEMA10_MIGRATION_COST {}",
        json!({"chapters":chapters,"elapsedNs":elapsed,"pageSize":page_size,"pagesBefore":pages_before,"pagesAfter":pages_after,"indexPages":index_pages,"indexBytes":index_bytes,"walBytesAfterCommit":wal_bytes,"rawColumnsPreserved":true,"reopenVerified":true,"scope":"single debug migration on actual legal schema-9 history; logical pages and post-commit WAL length, not absolute peak or SLO"})
    );
}
