use super::*;
use crate::arena_story::{
    pending, tests as linear_tests, CommitManifest, PartDeclaration, PartKind, StoryReceipt,
    StoryStore, STAGE_LIFETIME,
};
use crate::library::LocalLibrary;
use crate::store::{lock_connection, with_history_schema_for_test, SCHEMA_VERSION};
use rusqlite::params;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn library() -> (tempfile::TempDir, LocalLibrary) {
    let root = tempfile::tempdir().unwrap();
    let library = LocalLibrary::open(root.path()).unwrap();
    (root, library)
}

fn upload_parts(store: &StoryStore, token: &str, parts: &[(PartKind, String)]) {
    for (kind, document) in parts {
        for (index, bytes) in document.as_bytes().chunks(31).enumerate() {
            store
                .append(token, *kind, (index * 31) as u64, bytes, Instant::now())
                .unwrap();
        }
    }
}

fn commit(store: &StoryStore, session: &str, index: u64) -> StoryReceipt {
    let parts = linear_tests::fixture(session, index);
    let token = store
        .begin(
            linear_tests::manifest(session, index, &parts),
            Instant::now(),
        )
        .unwrap()
        .token;
    upload_parts(store, &token, &parts);
    store.end(&token, Instant::now()).unwrap()
}

fn raw(store: &StoryStore, table: &str, id: &str) -> String {
    assert!([
        "arena_story_session",
        "arena_story_chapter",
        "arena_story_checkpoint"
    ]
    .contains(&table));
    lock_connection(&store.connection)
        .unwrap()
        .query_row(
            &format!("SELECT document FROM {table} WHERE id=?1"),
            [id],
            |row| row.get(0),
        )
        .unwrap()
}

fn replace_raw(store: &StoryStore, table: &str, id: &str, document: &str) {
    assert!([
        "arena_story_session",
        "arena_story_chapter",
        "arena_story_checkpoint"
    ]
    .contains(&table));
    lock_connection(&store.connection)
        .unwrap()
        .execute(
            &format!(
                "UPDATE {table} SET document=?2,document_bytes=?3,document_digest=?4 WHERE id=?1"
            ),
            params![
                id,
                document,
                document.len() as u64,
                digest(document.as_bytes())
            ],
        )
        .unwrap();
}

fn state(store: &StoryStore, session: &str) -> (u64, u64, String, String, String) {
    lock_connection(&store.connection).unwrap().query_row(
        "SELECT revision,chapter_count,last_chapter_id,last_input_checkpoint_id,working_checkpoint_id FROM arena_story_session WHERE id=?1",
        [session], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).unwrap()
}

fn source(store: &StoryStore, session: &str) -> TailRewriteSourceDescriptors {
    let (revision, count, head, _, _) = state(store, session);
    store
        .resolve_tail_rewrite_source(&TailRewriteSourceRequest {
            session_id: session.into(),
            expected_revision: revision,
            expected_chapter_count: count,
            target_chapter_id: head,
        })
        .unwrap()
}

fn declarations(parts: &[(PartKind, String)]) -> Vec<PartDeclaration> {
    parts
        .iter()
        .map(|(kind, document)| PartDeclaration {
            kind: *kind,
            byte_length: document.len() as u64,
            digest: digest(document.as_bytes()),
        })
        .collect()
}

fn part_mut(parts: &mut [(PartKind, String)], kind: PartKind) -> &mut String {
    &mut parts
        .iter_mut()
        .find(|(candidate, _)| *candidate == kind)
        .unwrap()
        .1
}

fn edit_part(parts: &mut [(PartKind, String)], kind: PartKind, edit: impl FnOnce(&mut Value)) {
    let document = part_mut(parts, kind);
    let mut value: Value = serde_json::from_str(document).unwrap();
    edit(&mut value);
    *document = value.to_string();
}

fn fixture(
    store: &StoryStore,
    session: &str,
    operation: &str,
) -> (TailRewriteManifest, Vec<(PartKind, String)>) {
    let resolved = source(store, session);
    let (revision, count, head, input, _) = state(store, session);
    let checkpoint = format!("cp-{operation}");
    let mut session_document: Value =
        serde_json::from_str(&raw(store, "arena_story_session", session)).unwrap();
    session_document["revision"] = json!(revision + 1);
    session_document["lastChapterId"] = json!(operation);
    session_document["workingCheckpointId"] = json!(checkpoint);
    session_document["lastInputCheckpointId"] = json!(input);
    session_document["updatedAt"] = json!(1000 + revision);
    let covered = session_document["summaryMeta"]["coveredUntilChapterIndex"].as_u64();
    if covered.unwrap_or(0) >= count {
        session_document
            .as_object_mut()
            .unwrap()
            .remove("sessionSummary");
        session_document
            .as_object_mut()
            .unwrap()
            .remove("summaryMeta");
    }
    let parts = vec![
        (PartKind::Session, session_document.to_string()),
        (PartKind::Chapter, json!({
            "id":operation,"sessionId":session,"index":count,"action":"rewrite","status":"active",
            "sourceChapterId":head,"title":"重写章","titlePreview":"重写章","titleTruncated":false,
            "markdown":"新版正文🙂","markdownByteLength":"新版正文🙂".len(),"reportJson":{"output":"new"},
            "deterministicDigest":{"chapterTitle":"重写章"},"cardSnapshot":{"output":"new"},"createdAt":1000+revision,
        }).to_string()),
        (PartKind::Checkpoint1, json!({
            "id":checkpoint,"sessionId":session,"boundaryIndex":count,"chapterId":operation,
            "combatants":[{"data":{"name":"重写后的角色","state":"new"}}],"createdAt":1000+revision,
        }).to_string()),
    ];
    (
        TailRewriteManifest {
            version: 3,
            kind: TailRewriteKind::TailRewrite,
            operation_id: operation.into(),
            session_id: session.into(),
            source: resolved.source,
            parts: declarations(&parts),
        },
        parts,
    )
}

fn upload(
    store: &StoryStore,
    manifest: &TailRewriteManifest,
    parts: &[(PartKind, String)],
) -> String {
    let token = store
        .begin_tail_rewrite(manifest.clone(), Instant::now())
        .unwrap()
        .token;
    upload_parts(store, &token, parts);
    token
}

fn rewrite(
    store: &StoryStore,
    manifest: &TailRewriteManifest,
    parts: &[(PartKind, String)],
) -> TailRewriteReceipt {
    let token = upload(store, manifest, parts);
    store.end_tail_rewrite(&token, Instant::now()).unwrap()
}

pub(crate) fn continue_after(store: &StoryStore, session: &str, operation: &str) -> StoryReceipt {
    let (revision, count, head, _, input) = state(store, session);
    let mut parts = linear_tests::fixture(session, count + 1);
    let checkpoint = format!("cp-{operation}");
    let source_session: Value =
        serde_json::from_str(&raw(store, "arena_story_session", session)).unwrap();
    edit_part(&mut parts, PartKind::Session, |value| {
        value["revision"] = json!(revision + 1);
        value["updatedAt"] = json!(2000 + revision);
        value["lastChapterId"] = json!(operation);
        value["workingCheckpointId"] = json!(checkpoint);
        value["lastInputCheckpointId"] = json!(input);
        if let Some(origin) = source_session.get("branchOf") {
            value["branchOf"] = origin.clone();
        }
    });
    edit_part(&mut parts, PartKind::Chapter, |value| {
        value["id"] = json!(operation);
        value["createdAt"] = json!(2000 + revision);
        value["sourceChapterId"] = json!(head);
    });
    edit_part(&mut parts, PartKind::Checkpoint1, |value| {
        value["id"] = json!(checkpoint);
        value["createdAt"] = json!(2000 + revision);
        value["chapterId"] = json!(operation);
    });
    let manifest = CommitManifest {
        version: 1,
        operation_id: operation.into(),
        session_id: session.into(),
        expected_revision: revision,
        expected_last_chapter_id: Some(head),
        parts: declarations(&parts),
    };
    let token = store.begin(manifest, Instant::now()).unwrap().token;
    upload_parts(store, &token, &parts);
    store.end(&token, Instant::now()).unwrap()
}

fn snapshot(store: &StoryStore) -> Vec<Vec<String>> {
    let c = lock_connection(&store.connection).unwrap();
    [
        "SELECT hex(document)||':'||hex(seed_document)||':'||document_bytes||':'||document_digest||':'||revision||':'||chapter_count||':'||last_chapter_id||':'||working_checkpoint_id||':'||last_input_checkpoint_id FROM arena_story_session ORDER BY id",
        "SELECT hex(document)||':'||document_bytes||':'||document_digest||':'||hex(receipt)||':'||operation_id||':'||operation_digest||':'||status||':'||coalesce(superseded_by_chapter_id,'')||':'||coalesce(committed_revision,0) FROM arena_story_chapter ORDER BY id",
        "SELECT hex(document)||':'||document_bytes||':'||document_digest||':'||boundary_index||':'||coalesce(chapter_id,'') FROM arena_story_checkpoint ORDER BY id",
    ].iter().map(|sql| c.prepare(sql).unwrap().query_map([], |row| row.get(0)).unwrap().collect::<Result<Vec<String>, _>>().unwrap()).collect()
}

fn assert_rejected_without_writes(
    store: &StoryStore,
    manifest: &TailRewriteManifest,
    parts: &[(PartKind, String)],
) {
    let before = snapshot(store);
    if let Ok(begin) = store.begin_tail_rewrite(manifest.clone(), Instant::now()) {
        upload_parts(store, &begin.token, parts);
        assert!(store
            .end_tail_rewrite(&begin.token, Instant::now())
            .is_err());
        store.abort(&begin.token).unwrap();
    }
    assert_eq!(snapshot(store), before);
    assert!(lock_connection(&store.connection).unwrap().is_autocommit());
}

#[test]
fn first_and_later_tail_rewrites_keep_count_then_continue_the_active_lineage() {
    with_history_schema_for_test(|| {
        for count in [1, 3, 15] {
            let (_root, lib) = library();
            let store = lib.stories();
            let original_receipts = (1..=count)
                .map(|index| commit(store, "source", index))
                .collect::<Vec<_>>();
            let initial_input = state(store, "source").3;
            let input_bytes = raw(store, "arena_story_checkpoint", &initial_input);
            let initial_chapters = (1..count)
                .map(|i| raw(store, "arena_story_chapter", &format!("source-chapter-{i}")))
                .collect::<Vec<_>>();
            let mut rewrites = Vec::new();
            for number in 1..=3 {
                let operation = format!("rewrite-{number}");
                let resolved = source(store, "source");
                assert_eq!(resolved.source.expected_revision, count + number - 1);
                assert_eq!(resolved.source.expected_chapter_count, count);
                assert_eq!(resolved.source.expected_instance, store.instance);
                assert_eq!(resolved.source.input_checkpoint_id, initial_input);
                assert_eq!(resolved.recent_chapters.len(), count.min(12) as usize);
                assert_eq!(
                    resolved.recent_chapters.last().unwrap().record_id,
                    resolved.source.target_chapter_id
                );
                let (manifest, parts) = fixture(store, "source", &operation);
                let receipt = rewrite(store, &manifest, &parts);
                assert_eq!(receipt.version, 3);
                assert_eq!(receipt.kind, TailRewriteKind::TailRewrite);
                assert_eq!(receipt.chapter_index, count);
                assert_eq!(receipt.chapter_count, count);
                assert_eq!(receipt.revision, count + number);
                assert_eq!(receipt.target_chapter_id, manifest.source.target_chapter_id);
                assert_eq!(receipt.input_checkpoint_id, initial_input);
                assert_eq!(receipt.request_digest, manifest.request_digest().unwrap());
                assert_eq!(
                    state(store, "source"),
                    (
                        count + number,
                        count,
                        operation.clone(),
                        initial_input.clone(),
                        format!("cp-{operation}")
                    )
                );
                assert_eq!(
                    raw(store, "arena_story_checkpoint", &initial_input),
                    input_bytes
                );
                let active = store
                    .list_chapters("source", count + number, None, None)
                    .unwrap();
                assert_eq!(active.rows.len(), count as usize);
                assert_eq!(active.rows.last().unwrap().id, operation);
                let old: Value = serde_json::from_str(&raw(
                    store,
                    "arena_story_chapter",
                    &manifest.source.target_chapter_id,
                ))
                .unwrap();
                assert_eq!(old["status"], "superseded");
                assert_eq!(old["supersededByChapterId"], operation);
                rewrites.push((manifest, parts, receipt));
            }
            for (index, expected) in (1..count).zip(initial_chapters) {
                assert_eq!(
                    raw(
                        store,
                        "arena_story_chapter",
                        &format!("source-chapter-{index}")
                    ),
                    expected
                );
            }
            let next = continue_after(store, "source", "continued");
            assert_eq!((next.revision, next.chapter_index), (count + 4, count + 1));
            let continuation: Value =
                serde_json::from_str(&raw(store, "arena_story_chapter", "continued")).unwrap();
            assert_eq!(continuation["sourceChapterId"], "rewrite-3");
            for receipt in original_receipts {
                assert_eq!(
                    store.receipt("source", &receipt.operation_id).unwrap(),
                    Some(receipt)
                );
            }
            for (manifest, parts, receipt) in rewrites {
                assert_eq!(
                    store
                        .tail_rewrite_receipt(
                            "source",
                            &manifest.operation_id,
                            &manifest.request_digest().unwrap()
                        )
                        .unwrap(),
                    Some(receipt.clone())
                );
                let before = snapshot(store);
                assert_eq!(rewrite(store, &manifest, &parts), receipt);
                assert_eq!(snapshot(store), before);
            }
            super::super::history::audit_relations(&lock_connection(&store.connection).unwrap())
                .unwrap();
        }
    });
}

#[test]
fn old_linear_and_branch_receipts_survive_real_rewrites_and_restart() {
    for branch in [false, true] {
        let (root, lib) = library();
        {
            let c = lock_connection(&lib.stories().connection).unwrap();
            super::super::schema::tests::fixture(&c, branch);
            crate::store::migrate_history_candidate_for_test(&c).unwrap();
        }
        with_history_schema_for_test(|| {
            let store = lib.stories();
            let historical = state(store, "target").2;
            let old_receipt = raw_receipt(store, &historical);
            // The schema fixture deliberately contains lone-surrogate extension data.
            // Temporarily build a candidate without interpreting those opaque tokens.
            let original_session = raw(store, "arena_story_session", "target");
            let parseable = original_session.replace("\"\\ud800\"", "\"opaque\"");
            replace_raw(store, "arena_story_session", "target", &parseable);
            let (mut manifest, parts) = fixture(store, "target", "rewritten-branch-tail");
            replace_raw(store, "arena_story_session", "target", &original_session);
            manifest.source = source(store, "target").source;
            let receipt = rewrite(store, &manifest, &parts);
            assert_eq!(raw_receipt(store, &historical), old_receipt);
            if branch {
                assert!(store
                    .branch_receipt("target", &historical, &digest(b"frozen branch request"))
                    .unwrap()
                    .is_some());
            } else {
                assert!(store.receipt("target", &historical).unwrap().is_some());
            }
            drop(lib);
            let reopened = LocalLibrary::open(root.path()).unwrap();
            let store = reopened.stories();
            assert_ne!(store.instance, manifest.source.expected_instance);
            assert_eq!(
                store
                    .tail_rewrite_receipt(
                        "target",
                        &manifest.operation_id,
                        &manifest.request_digest().unwrap()
                    )
                    .unwrap(),
                Some(receipt.clone())
            );
            let before = snapshot(store);
            assert_eq!(rewrite(store, &manifest, &parts), receipt);
            assert_eq!(snapshot(store), before);
            assert_eq!(raw_receipt(store, &historical), old_receipt);
        });
    }
}

fn raw_receipt(store: &StoryStore, operation: &str) -> String {
    lock_connection(&store.connection)
        .unwrap()
        .query_row(
            "SELECT receipt FROM arena_story_chapter WHERE operation_id=?1",
            [operation],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn source_proofs_reject_hash_length_head_revision_count_input_and_instance_changes() {
    with_history_schema_for_test(|| {
        let (_root, lib) = library();
        let store = lib.stories();
        commit(store, "source", 1);
        commit(store, "source", 2);
        let (manifest, parts) = fixture(store, "source", "new-tail");
        for case in 0..12 {
            let mut bad = manifest.clone();
            match case {
                0 => bad.source.session.digest = digest(b"wrong-session"),
                1 => bad.source.chapter.digest = digest(b"wrong-chapter"),
                2 => bad.source.input_checkpoint.digest = digest(b"wrong-input"),
                3 => bad.source.session.byte_length += 1,
                4 => bad.source.chapter.byte_length += 1,
                5 => bad.source.input_checkpoint.byte_length += 1,
                6 => bad.source.expected_revision += 1,
                7 => bad.source.expected_chapter_count = 1,
                8 => bad.source.target_chapter_id = "source-chapter-1".into(),
                9 => bad.source.input_checkpoint_id = "source-checkpoint-2".into(),
                10 => {
                    bad.source.expected_instance =
                        if manifest.source.expected_instance == "0".repeat(32) {
                            "1".repeat(32)
                        } else {
                            "0".repeat(32)
                        }
                }
                11 => bad.session_id = "other".into(),
                _ => unreachable!(),
            }
            assert_rejected_without_writes(store, &bad, &parts);
        }
        for case in 0..3 {
            let mut request = TailRewriteSourceRequest {
                session_id: "source".into(),
                expected_revision: 2,
                expected_chapter_count: 2,
                target_chapter_id: "source-chapter-2".into(),
            };
            match case {
                0 => request.expected_revision = 1,
                1 => request.expected_chapter_count = 1,
                2 => request.target_chapter_id = "source-chapter-1".into(),
                _ => unreachable!(),
            }
            assert!(store.resolve_tail_rewrite_source(&request).is_err());
        }
        let token = upload(store, &manifest, &parts);
        commit(store, "source", 3);
        let before = snapshot(store);
        assert_eq!(
            store.end_tail_rewrite(&token, Instant::now()),
            Err(StoryError::Stale)
        );
        assert_eq!(snapshot(store), before);
    });
}

#[test]
fn stored_source_bytes_and_metadata_are_verified_before_mutation() {
    with_history_schema_for_test(|| {
        for table in [
            "arena_story_session",
            "arena_story_chapter",
            "arena_story_checkpoint",
        ] {
            for corruption in ["document", "document_bytes", "document_digest"] {
                let (_root, lib) = library();
                let store = lib.stories();
                commit(store, "source", 1);
                let (manifest, parts) = fixture(store, "source", "new-tail");
                let token = upload(store, &manifest, &parts);
                let id = match table {
                    "arena_story_session" => "source",
                    "arena_story_chapter" => "source-chapter-1",
                    _ => "source-checkpoint-0",
                };
                let expression = match corruption {
                    "document" => "document||' '",
                    "document_bytes" => "document_bytes+1",
                    _ => {
                        "'sha256:0000000000000000000000000000000000000000000000000000000000000000'"
                    }
                };
                lock_connection(&store.connection)
                    .unwrap()
                    .execute(
                        &format!("UPDATE {table} SET {corruption}={expression} WHERE id=?1"),
                        [id],
                    )
                    .unwrap();
                let before = snapshot(store);
                assert!(
                    store.end_tail_rewrite(&token, Instant::now()).is_err(),
                    "{table}/{corruption}"
                );
                assert_eq!(snapshot(store), before);
            }
        }
    });
}

#[test]
fn replacement_chapter_and_checkpoint_identities_must_be_fresh() {
    with_history_schema_for_test(|| {
        let (_root, lib) = library();
        let store = lib.stories();
        commit(store, "source", 1);
        commit(store, "source", 2);
        commit(store, "other", 1);
        let (manifest, parts) = fixture(store, "source", "fresh-tail");
        for existing in ["source-chapter-2", "source-chapter-1", "other-chapter-1"] {
            let mut bad = manifest.clone();
            let mut changed = parts.clone();
            bad.operation_id = existing.into();
            edit_part(&mut changed, PartKind::Session, |value| {
                value["lastChapterId"] = json!(existing)
            });
            edit_part(&mut changed, PartKind::Chapter, |value| {
                value["id"] = json!(existing)
            });
            edit_part(&mut changed, PartKind::Checkpoint1, |value| {
                value["chapterId"] = json!(existing)
            });
            bad.parts = declarations(&changed);
            assert_rejected_without_writes(store, &bad, &changed);
        }
        for existing in [
            "source-checkpoint-1",
            "source-checkpoint-2",
            "other-checkpoint-1",
            "fresh-tail",
        ] {
            let mut bad = manifest.clone();
            let mut changed = parts.clone();
            edit_part(&mut changed, PartKind::Session, |value| {
                value["workingCheckpointId"] = json!(existing)
            });
            edit_part(&mut changed, PartKind::Checkpoint1, |value| {
                value["id"] = json!(existing)
            });
            bad.parts = declarations(&changed);
            assert_rejected_without_writes(store, &bad, &changed);
        }
    });
}

#[test]
fn immutable_session_and_replacement_graph_fields_cannot_be_changed() {
    with_history_schema_for_test(|| {
        let (_root, lib) = library();
        let store = lib.stories();
        commit(store, "source", 1);
        let (manifest, parts) = fixture(store, "source", "new-tail");
        let changes = [
            (PartKind::Session, "title", json!("renamed")),
            (PartKind::Session, "mode", json!("changed")),
            (PartKind::Session, "createdAt", json!(91)),
            (PartKind::Session, "chapterCount", json!(2)),
            (
                PartKind::Session,
                "branchOf",
                json!({"sessionId":"other","chapterId":"other-tail","chapterIndex":1}),
            ),
            (PartKind::Session, "revision", json!(3)),
            (
                PartKind::Session,
                "lastInputCheckpointId",
                json!("source-checkpoint-1"),
            ),
            (PartKind::Chapter, "sourceChapterId", json!("other")),
            (PartKind::Chapter, "index", json!(2)),
            (PartKind::Chapter, "action", json!("continue")),
            (PartKind::Chapter, "status", json!("superseded")),
            (PartKind::Chapter, "markdownByteLength", json!(0)),
            (
                PartKind::Checkpoint1,
                "chapterId",
                json!("source-chapter-1"),
            ),
            (PartKind::Checkpoint1, "boundaryIndex", json!(0)),
        ];
        for (kind, field, value) in changes {
            let mut bad = manifest.clone();
            let mut changed = parts.clone();
            edit_part(&mut changed, kind, |document| document[field] = value);
            bad.parts = declarations(&changed);
            assert_rejected_without_writes(store, &bad, &changed);
        }
    });
}

#[test]
fn raw_opaque_members_and_historical_receipt_bytes_survive_the_transaction() {
    with_history_schema_for_test(|| {
        let (_root, lib) = library();
        let store = lib.stories();
        commit(store, "source", 1);
        let (mut manifest, mut parts) = fixture(store, "source", "new-tail");
        let opaque = r#", "\ud800":"\udfff", "dup":1,"dup":2,"opaque":{"x":1,"x":2},"text":"\u0000中😀\n\u4e2d" "#;
        let decorate =
            |document: &str| format!(" \n{}{} }}\t", &document[..document.len() - 1], opaque);
        let old_receipt = raw_receipt(store, "source-chapter-1");
        let old_session = decorate(&raw(store, "arena_story_session", "source"));
        let old_chapter = decorate(&raw(store, "arena_story_chapter", "source-chapter-1"))
            .replace("\"status\"", "\"st\\u0061tus\"");
        let old_input = decorate(&raw(store, "arena_story_checkpoint", "source-checkpoint-0"));
        replace_raw(store, "arena_story_session", "source", &old_session);
        replace_raw(
            store,
            "arena_story_chapter",
            "source-chapter-1",
            &old_chapter,
        );
        replace_raw(
            store,
            "arena_story_checkpoint",
            "source-checkpoint-0",
            &old_input,
        );
        for kind in [PartKind::Chapter, PartKind::Checkpoint1] {
            let document = part_mut(&mut parts, kind);
            *document = decorate(document);
        }
        manifest.source = source(store, "source").source;
        manifest.parts = declarations(&parts);
        rewrite(store, &manifest, &parts);
        let superseded = raw(store, "arena_story_chapter", "source-chapter-1");
        let expected = old_chapter
            .replacen("\"active\"", "\"superseded\"", 1)
            .replace("}\t", ",\"supersededByChapterId\":\"new-tail\"}\t");
        assert_eq!(superseded, expected);
        assert_eq!(raw_receipt(store, "source-chapter-1"), old_receipt);
        assert_eq!(
            raw(store, "arena_story_checkpoint", "source-checkpoint-0"),
            old_input
        );
        assert!(raw(store, "arena_story_session", "source").contains(opaque));
        for (kind, id, table) in [
            (PartKind::Chapter, "new-tail", "arena_story_chapter"),
            (
                PartKind::Checkpoint1,
                "cp-new-tail",
                "arena_story_checkpoint",
            ),
        ] {
            assert_eq!(raw(store, table, id), *part_mut(&mut parts, kind));
        }
        super::super::history::audit_relations(&lock_connection(&store.connection).unwrap())
            .unwrap();
    });
}

#[test]
fn summary_is_preserved_only_when_its_coverage_precedes_the_rewritten_tail() {
    with_history_schema_for_test(|| {
        for covered in [1, 2] {
            let (_root, lib) = library();
            let store = lib.stories();
            commit(store, "source", 1);
            commit(store, "source", 2);
            let mut session: Value =
                serde_json::from_str(&raw(store, "arena_story_session", "source")).unwrap();
            session["summaryMeta"]["coveredUntilChapterIndex"] = json!(covered);
            session["summaryMeta"]["coveredChapterIds"] =
                json!([format!("source-chapter-{covered}")]);
            replace_raw(store, "arena_story_session", "source", &session.to_string());
            let (manifest, parts) = fixture(store, "source", "new-tail");
            rewrite(store, &manifest, &parts);
            let result: Value =
                serde_json::from_str(&raw(store, "arena_story_session", "source")).unwrap();
            if covered < 2 {
                assert_eq!(result["sessionSummary"], session["sessionSummary"]);
                assert_eq!(result["summaryMeta"], session["summaryMeta"]);
            } else {
                assert!(result.get("sessionSummary").is_none());
                assert!(result.get("summaryMeta").is_none());
            }
        }
    });
}

#[test]
fn each_transaction_hook_rolls_back_every_original_and_candidate_row() {
    with_history_schema_for_test(|| {
        let (_root, lib) = library();
        let store = lib.stories();
        commit(store, "source", 1);
        let (manifest, parts) = fixture(store, "source", "new-tail");
        let token = upload(store, &manifest, &parts);
        assert_eq!(store.end(&token, Instant::now()), Err(StoryError::Invalid));
        let before = snapshot(store);
        for boundary in [
            "source-cas",
            "validated",
            "superseded",
            "chapter",
            "checkpoint",
            "session",
            "audited",
            "before-commit",
        ] {
            let mut hit = false;
            let result =
                store.end_tail_rewrite_with_hook(&token, Instant::now(), &mut |step, _| {
                    if step == boundary {
                        hit = true;
                        Err(StoryError::Busy)
                    } else {
                        Ok(())
                    }
                });
            assert!(hit, "missing fault-injection boundary {boundary}");
            assert_eq!(result, Err(StoryError::Busy), "{boundary}");
            assert_eq!(snapshot(store), before, "{boundary}");
            assert!(lock_connection(&store.connection).unwrap().is_autocommit());
            assert_eq!(
                store
                    .tail_rewrite_receipt(
                        "source",
                        &manifest.operation_id,
                        &manifest.request_digest().unwrap()
                    )
                    .unwrap(),
                None
            );
        }
        store.end_tail_rewrite(&token, Instant::now()).unwrap();
    });
}

// Actual SQLite transaction-boundary faults, not an emulation of physical I/O or IPC loss.
fn force_unknown(store: &StoryStore, token: &str, checkpoint: &str, fault: u8) {
    let result =
        store.end_tail_rewrite_with_hook(token, Instant::now(), &mut |step, connection| {
            if step == "before-commit" && fault == 0 {
                connection
                    .execute(
                        "DELETE FROM arena_story_checkpoint WHERE id=?1",
                        [checkpoint],
                    )
                    .unwrap();
            }
            if step == "before-commit" && fault == 1 {
                connection.execute_batch("ROLLBACK").unwrap();
                return Err(StoryError::Busy);
            }
            if step == "after-commit" && fault == 2 {
                return Err(StoryError::Io);
            }
            Ok(())
        });
    assert_eq!(result, Err(StoryError::CommitUnknown));
}

fn assert_fenced(store: &StoryStore) {
    let stages = store.stages.lock().unwrap();
    assert!(stages.is_empty());
    assert_eq!(stages.admission_slots(), 1);
    assert_eq!(stages.branch_unknown.len(), 1);
    assert!(stages
        .branch_unknown
        .values()
        .all(|fence| fence.tokens.len() <= crate::arena_story::MAX_STAGES));
    assert_eq!(std::fs::read_dir(&store.staging_root).unwrap().count(), 0);
}

#[test]
fn unknown_outcomes_survive_abort_expiry_new_begin_and_prebuilt_linear_tokens() {
    with_history_schema_for_test(|| {
        for fault in 0..=2 {
            for second_kind in 0..=2 {
                let (_root, lib) = library();
                let store = lib.stories();
                commit(store, "source", 1);
                let before = snapshot(store);
                let (manifest, parts) = fixture(store, "source", "new-tail");
                let request_digest = manifest.request_digest().unwrap();
                let token = upload(store, &manifest, &parts);
                let mut changed = manifest.clone();
                changed.parts[0].digest = digest(b"changed");
                let second = match second_kind {
                    0 => {
                        store
                            .begin_tail_rewrite(manifest.clone(), Instant::now())
                            .unwrap()
                            .token
                    }
                    1 => {
                        store
                            .begin_tail_rewrite(changed.clone(), Instant::now())
                            .unwrap()
                            .token
                    }
                    _ => {
                        let linear_parts = linear_tests::fixture("linear", 1);
                        let mut linear = linear_tests::manifest("linear", 1, &linear_parts);
                        linear.operation_id = manifest.operation_id.clone();
                        store.begin(linear, Instant::now()).unwrap().token
                    }
                };
                force_unknown(store, &token, "cp-new-tail", fault);
                assert_fenced(store);
                if fault != 2 {
                    assert_eq!(snapshot(store), before);
                }
                store.abort(&token).unwrap();
                store.abort(&second).unwrap();
                let later = Instant::now() + STAGE_LIFETIME + Duration::from_secs(1);
                let receipt = store
                    .tail_rewrite_receipt("source", &manifest.operation_id, &request_digest)
                    .unwrap();
                assert_eq!(receipt.is_some(), fault == 2);
                let stable = snapshot(store);
                for replay in [&token, &second] {
                    let mut writes = 0;
                    let result = store.end_tail_rewrite_with_hook(replay, later, &mut |_, _| {
                        writes += 1;
                        Ok(())
                    });
                    if replay == &second && second_kind != 0 {
                        assert_eq!(result, Err(StoryError::Stale));
                    } else {
                        assert_eq!(result, receipt.clone().ok_or(StoryError::CommitUnknown));
                    }
                    assert_eq!(writes, 0);
                    assert!(store
                        .append(replay, PartKind::Session, 0, b"x", later)
                        .is_err());
                    assert!(store.end(replay, later).is_err());
                }
                assert_eq!(
                    store.begin_tail_rewrite(manifest.clone(), later),
                    Err(StoryError::CommitUnknown)
                );
                assert_eq!(
                    store.begin_tail_rewrite(changed, later),
                    Err(StoryError::OperationMismatch)
                );
                assert_eq!(
                    store.tail_rewrite_receipt("other", &manifest.operation_id, &request_digest),
                    Err(StoryError::OperationMismatch)
                );
                assert_eq!(
                    store.tail_rewrite_receipt("source", &manifest.operation_id, &digest(b"other")),
                    Err(StoryError::OperationMismatch)
                );
                let linear_parts = linear_tests::fixture("linear", 1);
                let mut linear = linear_tests::manifest("linear", 1, &linear_parts);
                linear.operation_id = manifest.operation_id.clone();
                assert_eq!(
                    store.begin(linear, later),
                    Err(StoryError::OperationMismatch)
                );
                assert_eq!(snapshot(store), stable);
                commit(store, "unrelated", 1);
                assert_fenced(store);
            }
        }
    });
}

#[test]
fn unknown_fence_blocks_all_pending_lifecycles_without_losing_originals() {
    with_history_schema_for_test(|| {
        for fault in 0..=2 {
            for lifecycle in 0..=3 {
                let (_root, lib) = library();
                let store = lib.stories();
                commit(store, "source", 1);
                let (manifest, parts) = fixture(store, "source", "new-tail");
                let (pending, originals) = pending::tests::with_operation(&manifest.operation_id);
                let wire = pending
                    .commit_manifest
                    .as_ref()
                    .unwrap()
                    .wire_digest()
                    .unwrap();
                let mut pending_token = None;
                let mut attempt = None;
                if lifecycle > 0 {
                    let token = pending::tests::upload(store, &pending, &originals);
                    if lifecycle > 1 {
                        store.pending_seal(&token).unwrap();
                    }
                    if lifecycle > 2 {
                        attempt = Some(store.pending_prepare_save(&pending.key(), &wire).unwrap());
                    }
                    pending_token = Some(token);
                }
                let token = upload(store, &manifest, &parts);
                force_unknown(store, &token, "cp-new-tail", fault);
                let pending_token = pending_token
                    .unwrap_or_else(|| pending::tests::upload(store, &pending, &originals));
                store.pending_seal(&pending_token).unwrap();
                let attempt = attempt
                    .unwrap_or_else(|| store.pending_prepare_save(&pending.key(), &wire).unwrap());
                let before = store.pending_describe(pending.product).unwrap().unwrap();
                let db_before = snapshot(store);
                let changes = lock_connection(&store.connection).unwrap().total_changes();
                assert_eq!(
                    store.pending_save(&pending.key(), &wire, &attempt.attempt_id),
                    Err(StoryError::CommitUnknown),
                    "fault={fault}, lifecycle={lifecycle}"
                );
                assert_eq!(
                    lock_connection(&store.connection).unwrap().total_changes(),
                    changes
                );
                assert_eq!(snapshot(store), db_before);
                assert_eq!(
                    store.pending_describe(pending.product).unwrap().unwrap(),
                    before
                );
                for (kind, body) in &originals {
                    assert_eq!(
                        store
                            .pending_read(&pending.key(), *kind, 0, body.len())
                            .unwrap(),
                        body.as_bytes()
                    );
                }
                assert_eq!(
                    store.pending_save(&pending.key(), &wire, &attempt.attempt_id),
                    Err(StoryError::CommitUnknown)
                );
                assert_eq!(
                    store.pending_prepare_save(&pending.key(), &wire),
                    Err(StoryError::CommitUnknown)
                );
                assert_fenced(store);
            }
        }
    });
}

#[test]
fn restart_reads_exact_success_but_rejects_old_instance_for_absent_receipt() {
    with_history_schema_for_test(|| {
        for fault in 0..=2 {
            let (root, lib) = library();
            let store = lib.stories();
            commit(store, "source", 1);
            let (manifest, parts) = fixture(store, "source", "new-tail");
            let token = upload(store, &manifest, &parts);
            force_unknown(store, &token, "cp-new-tail", fault);
            let receipt = store
                .tail_rewrite_receipt(
                    "source",
                    &manifest.operation_id,
                    &manifest.request_digest().unwrap(),
                )
                .unwrap();
            let before = snapshot(store);
            drop(lib);
            let reopened = LocalLibrary::open(root.path()).unwrap();
            let store = reopened.stories();
            assert_ne!(store.instance, manifest.source.expected_instance);
            assert!(store.stages.lock().unwrap().branch_unknown.is_empty());
            assert_eq!(
                store
                    .tail_rewrite_receipt(
                        "source",
                        &manifest.operation_id,
                        &manifest.request_digest().unwrap()
                    )
                    .unwrap(),
                receipt
            );
            let token = upload(store, &manifest, &parts);
            let mut writes = 0;
            let result = store.end_tail_rewrite_with_hook(&token, Instant::now(), &mut |_, _| {
                writes += 1;
                Ok(())
            });
            assert_eq!(result, receipt.ok_or(StoryError::Stale));
            assert_eq!(writes, 0);
            assert_eq!(snapshot(store), before);
            store.abort(&token).unwrap();
            commit(store, "unrelated", 1);
            if fault != 2 {
                let (fresh, fresh_parts) = fixture(store, "source", "fresh-after-restart");
                rewrite(store, &fresh, &fresh_parts);
            }
        }
    });
}

#[test]
fn production_schema_and_maintenance_keep_rewrite_admission_closed() {
    let (manifest, parts) = with_history_schema_for_test(|| {
        let (_root, lib) = library();
        commit(lib.stories(), "source", 1);
        fixture(lib.stories(), "source", "new-tail")
    });
    let (_root, lib) = library();
    commit(lib.stories(), "source", 1);
    assert_eq!(
        lock_connection(&lib.stories().connection)
            .unwrap()
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        SCHEMA_VERSION
    );
    assert!(lib
        .stories()
        .begin_tail_rewrite(manifest, Instant::now())
        .is_err());
    assert!(lib
        .stories()
        .resolve_tail_rewrite_source(&TailRewriteSourceRequest {
            session_id: "source".into(),
            expected_revision: 1,
            expected_chapter_count: 1,
            target_chapter_id: "source-chapter-1".into(),
        })
        .is_err());
    assert!(lib.stories().stages.lock().unwrap().is_empty());
    drop(parts);
    with_history_schema_for_test(|| {
        let (_root, lib) = library();
        let store = lib.stories();
        commit(store, "source", 1);
        let (manifest, parts) = fixture(store, "source", "new-tail");
        let token = upload(store, &manifest, &parts);
        let before = snapshot(store);
        let maintenance = lib.enter_maintenance("tail rewrite test").unwrap();
        assert_eq!(
            store.begin_tail_rewrite(manifest.clone(), Instant::now()),
            Err(StoryError::Maintenance)
        );
        assert_eq!(
            store.end_tail_rewrite(&token, Instant::now()),
            Err(StoryError::Maintenance)
        );
        assert_eq!(snapshot(store), before);
        drop(maintenance);
        store.end_tail_rewrite(&token, Instant::now()).unwrap();
    });
}

fn golden() -> Value {
    serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/desktop-story-tail-rewrite-storage.json"
    ))
    .unwrap()
}

fn golden_parts(value: &Value) -> Vec<(PartKind, String)> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|part| {
            (
                serde_json::from_value(part["kind"].clone()).unwrap(),
                part["document"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

#[test]
fn shared_contract_goldens_match_closed_native_wire_digest_and_receipt_bytes() {
    let golden = golden();
    for case in golden["cases"].as_array().unwrap() {
        let manifest: TailRewriteManifest =
            serde_json::from_value(case["manifest"].clone()).unwrap();
        assert_eq!(
            serde_json::to_string(&manifest).unwrap(),
            case["manifestJson"].as_str().unwrap()
        );
        assert_eq!(
            manifest.request_digest().unwrap(),
            case["requestDigest"].as_str().unwrap()
        );
        assert_eq!(declarations(&golden_parts(&case["parts"])), manifest.parts);
        let receipt = TailRewriteReceipt::decode(case["receiptJson"].as_str().unwrap()).unwrap();
        assert_eq!(serde_json::to_value(&receipt).unwrap(), case["receipt"]);
        assert_eq!(
            receipt.encode().unwrap(),
            case["receiptJson"].as_str().unwrap()
        );
        for field in [
            "version",
            "kind",
            "operationId",
            "sessionId",
            "source",
            "parts",
        ] {
            let mut missing = case["manifest"].clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(
                serde_json::from_value::<TailRewriteManifest>(missing).is_err(),
                "{field}"
            );
        }
        for field in ["arbitraryPath", "keepHistory", "force", "copySource"] {
            let mut unknown = case["manifest"].clone();
            unknown[field] = json!(true);
            assert!(
                serde_json::from_value::<TailRewriteManifest>(unknown).is_err(),
                "{field}"
            );
        }
        let serialized = case["manifestJson"].as_str().unwrap();
        for duplicate in [
            serialized.replacen('{', "{\"version\":3,", 1),
            serialized.replace(
                "\"expectedRevision\":",
                "\"expected\\u0052evision\":1,\"expectedRevision\":",
            ),
            serialized.replacen(
                "\"byteLength\":",
                "\"byte\\u004cength\":1,\"byteLength\":",
                1,
            ),
        ] {
            assert!(serde_json::from_str::<TailRewriteManifest>(&duplicate).is_err());
        }
        let receipt_json = case["receiptJson"].as_str().unwrap();
        assert!(
            TailRewriteReceipt::decode(&receipt_json.replacen('{', "{\"version\":3,", 1)).is_err()
        );
        assert!(
            TailRewriteReceipt::decode(&format!("{}{}", receipt_json, " ".repeat(2048))).is_err()
        );
    }
}

#[test]
fn shared_domain_goldens_commit_to_sqlite_with_original_source_tokens_retained() {
    with_history_schema_for_test(|| {
        let golden = golden();
        for case in golden["cases"].as_array().unwrap() {
            let (_root, lib) = library();
            let store = lib.stories();
            let count = case["sourceCommitCount"].as_u64().unwrap();
            for source in golden["sourceCommits"]
                .as_array()
                .unwrap()
                .iter()
                .take(count as usize)
            {
                let manifest: CommitManifest =
                    serde_json::from_value(source["manifest"].clone()).unwrap();
                assert_eq!(
                    manifest.wire_digest().unwrap(),
                    source["wireDigest"].as_str().unwrap()
                );
                let token = store.begin(manifest, Instant::now()).unwrap().token;
                upload_parts(store, &token, &golden_parts(&source["parts"]));
                store.end(&token, Instant::now()).unwrap();
            }
            let mut manifest: TailRewriteManifest =
                serde_json::from_value(case["manifest"].clone()).unwrap();
            manifest.source.expected_instance = store.instance.clone();
            assert_eq!(source(store, "golden-source").source, manifest.source);
            let parts = golden_parts(&case["parts"]);
            let source_document = raw(store, "arena_story_session", "golden-source");
            let receipt = rewrite(store, &manifest, &parts);
            let mut expected: TailRewriteReceipt =
                serde_json::from_value(case["receipt"].clone()).unwrap();
            expected.request_digest = manifest.request_digest().unwrap();
            assert_eq!(receipt, expected);
            let session = raw(store, "arena_story_session", "golden-source");
            for retained in [
                r#""opaque":1e+02"#,
                r#""opaque":{"lone":"\ud800"}"#,
                r#""opaque":{"escaped":"\u4e2d","duplicate":1,"duplicate":2}"#,
            ] {
                assert!(source_document.contains(retained));
                assert!(session.contains(retained), "{}", case["name"]);
            }
            for (kind, document) in &parts {
                match kind {
                    PartKind::Chapter => assert_eq!(
                        raw(store, "arena_story_chapter", &receipt.chapter_id),
                        *document
                    ),
                    PartKind::Checkpoint1 => assert_eq!(
                        raw(store, "arena_story_checkpoint", &receipt.checkpoint_id),
                        *document
                    ),
                    _ => {}
                }
            }
            let summary = r#""summaryMeta":{"coveredUntilChapterIndex":1,"coveredChapterIds":["source-c1"],"refreshedAt":1,"mode":"deterministic-fallback","extension":{"keep":"保留"}}"#;
            assert_eq!(session.contains(summary), count > 1);
            super::super::history::audit_relations(&lock_connection(&store.connection).unwrap())
                .unwrap();
        }
    });
}

#[test]
fn exact_unknown_success_does_not_regrant_writes_after_continuation_and_deletion() {
    with_history_schema_for_test(|| {
        let (_root, lib) = library();
        let store = lib.stories();
        commit(store, "source", 1);
        let (manifest, parts) = fixture(store, "source", "new-tail");
        let token = upload(store, &manifest, &parts);
        force_unknown(store, &token, "cp-new-tail", 2);
        let receipt = store.end_tail_rewrite(&token, Instant::now()).unwrap();
        continue_after(store, "source", "continued");
        store.abort(&token).unwrap();
        assert_eq!(
            store.end_tail_rewrite(&token, Instant::now() + STAGE_LIFETIME),
            Ok(receipt)
        );
        let (revision, count, head, _, _) = state(store, "source");
        store
            .delete_session(
                &crate::arena_story::delete::SessionDeleteTarget {
                    session: store
                        .describe_record(
                            "source",
                            revision,
                            crate::arena_story::read::RecordKind::Session,
                            "source",
                        )
                        .unwrap(),
                    expected_last_chapter_id: head,
                    expected_chapter_count: count,
                },
                Instant::now(),
            )
            .unwrap();
        assert_eq!(
            store
                .tail_rewrite_receipt(
                    "source",
                    &manifest.operation_id,
                    &manifest.request_digest().unwrap()
                )
                .unwrap(),
            None
        );
        assert_eq!(
            store.end_tail_rewrite(&token, Instant::now()),
            Err(StoryError::CommitUnknown)
        );
        assert_eq!(
            store.begin_tail_rewrite(manifest, Instant::now()),
            Err(StoryError::CommitUnknown)
        );
        assert_fenced(store);
    });
}

#[test]
fn malformed_receipts_never_match_or_unlock_an_unknown_operation() {
    with_history_schema_for_test(|| {
        let (_root, lib) = library();
        let store = lib.stories();
        commit(store, "source", 1);
        let (manifest, parts) = fixture(store, "source", "new-tail");
        let token = upload(store, &manifest, &parts);
        force_unknown(store, &token, "cp-new-tail", 2);
        let good = raw_receipt(store, &manifest.operation_id);
        let digest = manifest.request_digest().unwrap();
        for bad in [
            good.replace("\"version\":3", "\"version\":2"),
            good.replace("\"tail-rewrite\"", "\"branch\""),
            good.replace(
                "\"targetChapterId\":\"source-chapter-1\"",
                "\"targetChapterId\":\"other\"",
            ),
            good.replace("\"revision\":2", "\"revision\":3"),
            format!("{good}{}", " ".repeat(2048)),
        ] {
            lock_connection(&store.connection)
                .unwrap()
                .execute(
                    "UPDATE arena_story_chapter SET receipt=?2 WHERE operation_id=?1",
                    params![manifest.operation_id, bad],
                )
                .unwrap();
            assert!(store
                .tail_rewrite_receipt("source", &manifest.operation_id, &digest)
                .is_err());
            assert!(store.end_tail_rewrite(&token, Instant::now()).is_err());
            assert_eq!(
                store.begin_tail_rewrite(manifest.clone(), Instant::now()),
                Err(StoryError::CommitUnknown)
            );
            assert_fenced(store);
        }
        lock_connection(&store.connection)
            .unwrap()
            .execute(
                "UPDATE arena_story_chapter SET receipt=?2 WHERE operation_id=?1",
                params![manifest.operation_id, good],
            )
            .unwrap();
        assert!(store.end_tail_rewrite(&token, Instant::now()).is_ok());
        assert_fenced(store);
    });
}

#[test]
fn provider_selection_changes_preserve_nested_source_and_safe_summary_tokens() {
    with_history_schema_for_test(|| {
        let (_root, lib) = library();
        let store = lib.stories();
        for index in 1..=3 {
            commit(store, "source", index);
        }
        let mut initial: Value =
            serde_json::from_str(&raw(store, "arena_story_session", "source")).unwrap();
        initial["summaryMeta"]["coveredUntilChapterIndex"] = json!(1);
        initial["summaryMeta"]["coveredChapterIds"] = json!(["source-chapter-1"]);
        replace_raw(store, "arena_story_session", "source", &initial.to_string());
        let (mut manifest, mut parts) = fixture(store, "source", "new-tail");
        let original_source = initial["source"].to_string();
        let original_summary = initial["summaryMeta"].to_string();
        let opaque = r#", "extension":{"dup":1,"dup":2,"\ud800":"\udfff","number":1.2300e+02},"same":1,"same":2"#;
        let decorated_source = format!(
            "{}{} }}",
            &original_source[..original_source.len() - 1],
            opaque
        )
        .replace("\"providerId\"", "\"provider\\u0049d\"");
        let decorated_summary = format!(
            "{}{} }}",
            &original_summary[..original_summary.len() - 1],
            opaque
        );
        let source_document = initial
            .to_string()
            .replace(&original_source, &decorated_source)
            .replace(&original_summary, &decorated_summary);
        replace_raw(store, "arena_story_session", "source", &source_document);
        edit_part(&mut parts, PartKind::Session, |session| {
            session["source"]["providerMode"] = json!("hosted");
            session["source"]["providerId"] = json!("next-provider");
            session["source"]["modelId"] = json!("next-model");
            // A projected candidate cannot round-trip the opaque source extensions.
            session["summaryMeta"]
                .as_object_mut()
                .unwrap()
                .remove("extension");
        });
        manifest.source = source(store, "source").source;
        manifest.parts = declarations(&parts);
        rewrite(store, &manifest, &parts);
        let result = raw(store, "arena_story_session", "source");
        let expected_source = decorated_source
            .replace("\"direct\"", "\"hosted\"")
            .replace("\"non-secret\"", "\"next-provider\"")
            .replace("\"test\"", "\"next-model\"");
        assert!(result.contains(&expected_source));
        assert!(result.contains(&decorated_summary));
        assert_eq!(result.matches(opaque).count(), 2);
        super::super::history::audit_relations(&lock_connection(&store.connection).unwrap())
            .unwrap();
    });
}

#[test]
fn authority_alias_duplicates_and_immutable_source_options_fail_closed() {
    with_history_schema_for_test(|| {
        let (_root, lib) = library();
        let store = lib.stories();
        commit(store, "source", 1);
        let (manifest, parts) = fixture(store, "source", "new-tail");
        for (field, value) in [
            ("mode", json!("daily")),
            ("language", json!("en")),
            ("storyLength", json!("long")),
            ("customStoryLength", json!("changed")),
            ("generationMode", json!("changed")),
        ] {
            let mut changed = parts.clone();
            edit_part(&mut changed, PartKind::Session, |session| {
                session["source"][field] = value
            });
            let mut bad = manifest.clone();
            bad.parts = declarations(&changed);
            assert_rejected_without_writes(store, &bad, &changed);
        }
        for (kind, field, alias, value) in [
            (PartKind::Session, "revision", "revis\\u0069on", "2"),
            (PartKind::Chapter, "action", "act\\u0069on", "\"rewrite\""),
            (PartKind::Checkpoint1, "id", "\\u0069d", "\"cp-new-tail\""),
        ] {
            let mut changed = parts.clone();
            let document = part_mut(&mut changed, kind);
            *document = document.replacen(
                &format!("\"{field}\":"),
                &format!("\"{alias}\":{value},\"{field}\":"),
                1,
            );
            let mut bad = manifest.clone();
            bad.parts = declarations(&changed);
            assert_rejected_without_writes(store, &bad, &changed);
        }
        let mut changed = parts.clone();
        let document = part_mut(&mut changed, PartKind::Session);
        *document = document.replace(
            "\"providerMode\":",
            "\"provider\\u004dode\":\"direct\",\"providerMode\":",
        );
        let mut bad = manifest;
        bad.parts = declarations(&changed);
        assert_rejected_without_writes(store, &bad, &changed);
    });
}

#[test]
fn tail_stages_share_two_slots_and_aggregate_budget_with_linear_and_pending_uploads() {
    with_history_schema_for_test(|| {
        let (_root, lib) = library();
        let store = lib.stories();
        commit(store, "source", 1);
        let (manifest, _) = fixture(store, "source", "new-tail");
        let linear_parts = linear_tests::fixture("linear", 1);
        let linear = linear_tests::manifest("linear", 1, &linear_parts);
        let tail = store
            .begin_tail_rewrite(manifest.clone(), Instant::now())
            .unwrap();
        let second = store.begin(linear.clone(), Instant::now()).unwrap();
        assert_eq!(
            store.begin_tail_rewrite(manifest.clone(), Instant::now()),
            Err(StoryError::Busy)
        );
        store.abort(&tail.token).unwrap();
        store.abort(&second.token).unwrap();
        let mut large = manifest.clone();
        let other_bytes: u64 = large
            .parts
            .iter()
            .skip(1)
            .map(|part| part.byte_length)
            .sum();
        large.parts[0].byte_length = crate::arena_story::CANDIDATE_COMMIT_BYTES - other_bytes;
        let stage = store.begin_tail_rewrite(large, Instant::now()).unwrap();
        assert_eq!(
            stage.total_bytes,
            crate::arena_story::CANDIDATE_COMMIT_BYTES
        );
        assert_eq!(
            store.begin(linear.clone(), Instant::now()),
            Err(StoryError::Busy)
        );
        let (pending, _) = pending::tests::candidate(pending::Product::Battle, false);
        assert_eq!(store.pending_begin(pending.clone()), Err(StoryError::Busy));
        // Declarations reserve bytes without writing a large temporary payload.
        let too_big = vec![b'x'; crate::arena_story::CANDIDATE_FRAME_BYTES + 1];
        assert_eq!(
            store.append(&stage.token, PartKind::Session, 0, &too_big, Instant::now()),
            Err(StoryError::TooLarge)
        );
        store.abort(&stage.token).unwrap();
        let upload = store.pending_begin(pending).unwrap();
        let tail = store.begin_tail_rewrite(manifest, Instant::now()).unwrap();
        assert_eq!(store.begin(linear, Instant::now()), Err(StoryError::Busy));
        store.abort(&tail.token).unwrap();
        store.pending_abort(&upload.token).unwrap();
        assert!(store.stages.lock().unwrap().is_empty());
    });
}

#[test]
fn manifest_requires_exact_ordered_parts_and_bounded_byte_declarations() {
    with_history_schema_for_test(|| {
        let (_root, lib) = library();
        let store = lib.stories();
        commit(store, "source", 1);
        let (manifest, _) = fixture(store, "source", "new-tail");
        for case in 0..8 {
            let mut bad = manifest.clone();
            match case {
                0 => {
                    bad.parts.swap(0, 1);
                }
                1 => {
                    bad.parts.remove(2);
                }
                2 => {
                    bad.parts.push(bad.parts[0].clone());
                }
                3 => bad.parts[2].kind = PartKind::Checkpoint0,
                4 => bad.parts[0].byte_length = 0,
                5 => bad.parts[0].byte_length = crate::arena_story::CANDIDATE_COMMIT_BYTES,
                6 => bad.parts[0].digest = "sha256:bad".into(),
                7 => bad.version = 2,
                _ => unreachable!(),
            }
            assert!(
                store.begin_tail_rewrite(bad, Instant::now()).is_err(),
                "{case}"
            );
            assert!(store.stages.lock().unwrap().is_empty());
        }
    });
}

#[test]
fn legacy_summary_numeric_lexemes_follow_js_safe_integer_semantics() {
    with_history_schema_for_test(|| {
        for count in [1, 2] {
            for lexeme in ["1.0", "1e0", "1E+0"] {
                let (_root, lib) = library();
                let store = lib.stories();
                for index in 1..=count {
                    commit(store, "source", index);
                }
                let mut value: Value =
                    serde_json::from_str(&raw(store, "arena_story_session", "source")).unwrap();
                value["summaryMeta"]["coveredUntilChapterIndex"] = json!(1);
                value["summaryMeta"]["coveredChapterIds"] = json!(["source-chapter-1"]);
                replace_raw(store, "arena_story_session", "source", &value.to_string());
                let (mut manifest, parts) = fixture(store, "source", "new-tail");
                let original = value.to_string().replace(
                    "\"coveredUntilChapterIndex\":1",
                    &format!("\"coveredUntilChapterIndex\":{lexeme}"),
                );
                replace_raw(store, "arena_story_session", "source", &original);
                // Real historical writer/auditor accepts this stored original,
                // while the prior u64 coverage parser incorrectly rejected it.
                let c = lock_connection(&store.connection).unwrap();
                super::super::history::audit_relations(&c).unwrap();
                let stored: String = c
                    .query_row(
                        "SELECT document FROM arena_story_session WHERE id='source'",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(stored, original);
                assert!(serde_json::from_str::<u64>(lexeme).is_err());
                drop(c);
                manifest.source = source(store, "source").source;
                rewrite(store, &manifest, &parts);
                let result = raw(store, "arena_story_session", "source");
                if count == 1 {
                    let value: Value = serde_json::from_str(&result).unwrap();
                    assert!(value.get("sessionSummary").is_none());
                    assert!(value.get("summaryMeta").is_none());
                } else {
                    assert!(result.contains(&format!("\"coveredUntilChapterIndex\":{lexeme}")));
                    assert!(result.contains("\"sessionSummary\""));
                }
            }
        }
        for lexeme in ["-1", "1.5", "9007199254740992", "1e400"] {
            let (_root, lib) = library();
            let store = lib.stories();
            commit(store, "source", 1);
            commit(store, "source", 2);
            let (mut manifest, parts) = fixture(store, "source", "new-tail");
            let original = raw(store, "arena_story_session", "source").replace(
                "\"coveredUntilChapterIndex\":2",
                &format!("\"coveredUntilChapterIndex\":{lexeme}"),
            );
            replace_raw(store, "arena_story_session", "source", &original);
            manifest.source = source(store, "source").source;
            assert_rejected_without_writes(store, &manifest, &parts);
        }
    });
}

/// Share the real internal producer with branch compatibility tests.
pub(crate) fn rewrite_for_branch(
    store: &StoryStore,
    session: &str,
    operation: &str,
) -> TailRewriteReceipt {
    let (mut manifest, mut parts) = fixture(store, session, operation);
    let original: Value =
        serde_json::from_str(&raw(store, "arena_story_session", session)).unwrap();
    let timestamp = original["updatedAt"].as_u64().unwrap() + 1;
    edit_part(&mut parts, PartKind::Session, |v| {
        v["updatedAt"] = json!(timestamp)
    });
    for kind in [PartKind::Chapter, PartKind::Checkpoint1] {
        edit_part(&mut parts, kind, |v| v["createdAt"] = json!(timestamp));
    }
    manifest.parts = declarations(&parts);
    rewrite(store, &manifest, &parts)
}

#[path = "arena_story_history_resource_tests.rs"]
mod resource_probes;
