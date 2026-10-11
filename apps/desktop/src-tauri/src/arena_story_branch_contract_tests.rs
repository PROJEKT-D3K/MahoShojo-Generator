//! One small fixture is emitted by the real TS domain projection and consumed by
//! the real store here. Static descriptor instances prove only the closed codec.
//! Live descriptors below are obtained once, before the new generation is frozen.
use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct RawPart {
    kind: PartKind,
    document: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceCommit {
    manifest: CommitManifest,
    wire_digest: String,
    parts: Vec<RawPart>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Golden {
    name: String,
    manifest: BranchManifest,
    manifest_json: String,
    request_digest: String,
    receipt: BranchReceipt,
    receipt_json: String,
    parts: Vec<RawPart>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopyIdGolden {
    #[serde(rename = "sessionId")]
    session_id: String,
    kind: String,
    index: u64,
    id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Goldens {
    copy_ids: Vec<CopyIdGolden>,
    source_commits: Vec<SourceCommit>,
    cases: Vec<Golden>,
}
fn goldens() -> Goldens {
    serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/desktop-story-branch-storage.json"
    ))
    .unwrap()
}
fn source(store: &StoryStore, fixture: &Goldens) {
    for source in &fixture.source_commits {
        assert_eq!(source.manifest.wire_digest().unwrap(), source.wire_digest);
        let token = store
            .begin(source.manifest.clone(), Instant::now())
            .unwrap()
            .token;
        append(store, &token, &source.parts);
        store.end(&token, Instant::now()).unwrap();
    }
}
fn append(store: &StoryStore, token: &str, parts: &[RawPart]) {
    // Deliberately split inside UTF-8/token boundaries: transport is raw bytes.
    for part in parts {
        for (index, chunk) in part.document.as_bytes().chunks(17).enumerate() {
            store
                .append(token, part.kind, (index * 17) as u64, chunk, Instant::now())
                .unwrap();
        }
    }
}
fn freeze_new_request(store: &StoryStore, golden: &Golden) -> BranchManifest {
    // This constructs the first request for THIS new generation. Never call this
    // after a failed write, restart or unknown result to reauthorize old content.
    let s = &golden.manifest.source;
    let descriptor = |d: &RecordDescriptor| {
        let current = store
            .describe_record(&d.session_id, d.revision, d.kind, &d.record_id)
            .unwrap();
        assert_eq!(current.digest, d.digest);
        assert_eq!(current.byte_length, d.byte_length);
        current
    };
    BranchManifest {
        version: 2,
        operation_id: golden.manifest.operation_id.clone(),
        session_id: golden.manifest.session_id.clone(),
        source: BranchSource {
            session: descriptor(&s.session),
            seed: descriptor(&s.seed),
            expected_last_chapter_id: s.expected_last_chapter_id.clone(),
            expected_chapter_count: s.expected_chapter_count,
            anchor: descriptor(&s.anchor),
            anchor_index: s.anchor_index,
            checkpoint: descriptor(&s.checkpoint),
        },
        parts: golden.manifest.parts.clone(),
    }
}
fn execute(store: &StoryStore, m: &BranchManifest, parts: &[RawPart]) -> BranchReceipt {
    let token = store.begin_branch(m.clone(), Instant::now()).unwrap().token;
    append(store, &token, parts);
    store.end_branch(&token, Instant::now()).unwrap()
}
fn snapshot(store: &StoryStore, session: &str) -> Vec<Vec<String>> {
    let c = lock_connection(&store.connection).unwrap();
    [
        "arena_story_session",
        "arena_story_chapter",
        "arena_story_checkpoint",
    ]
    .into_iter()
    .map(|table| {
        let filter = if table == "arena_story_session" {
            "id"
        } else {
            "session_id"
        };
        let mut statement = c
            .prepare(&format!(
                "SELECT * FROM {table} WHERE {filter}=?1 ORDER BY id"
            ))
            .unwrap();
        let columns = statement.column_count();
        statement
            .query_map([session], |row| {
                Ok((0..columns)
                    .map(|i| format!("{:?}", row.get_ref(i).unwrap()))
                    .collect::<Vec<_>>()
                    .join("\n"))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    })
    .collect()
}
fn raw_record(
    store: &StoryStore,
    session: &str,
    revision: u64,
    kind: RecordKind,
    id: &str,
) -> String {
    let descriptor = store.describe_record(session, revision, kind, id).unwrap();
    let bytes = store
        .read_record_chunk(&descriptor, 0, CANDIDATE_FRAME_BYTES)
        .unwrap();
    assert_eq!(bytes.len() as u64, descriptor.byte_length);
    String::from_utf8(bytes).unwrap()
}

#[test]
fn branch_closed_static_manifest_and_receipt_match_ts_exact_bytes() {
    for golden in goldens().cases {
        assert_eq!(
            serde_json::to_string(&golden.manifest).unwrap(),
            golden.manifest_json,
            "{}",
            golden.name
        );
        assert_eq!(
            golden.manifest.request_digest().unwrap(),
            golden.request_digest
        );
        assert_eq!(golden.receipt.encode().unwrap(), golden.receipt_json);
        assert_eq!(
            BranchReceipt::decode(&golden.receipt_json).unwrap(),
            golden.receipt
        );
        for (part, declaration) in golden.parts.iter().zip(&golden.manifest.parts) {
            assert_eq!(part.kind, declaration.kind);
            assert_eq!(part.document.len() as u64, declaration.byte_length);
            assert_eq!(digest(part.document.as_bytes()), declaration.digest);
        }
    }
}

#[test]
fn branch_closed_raw_duplicate_fields_and_non_integer_tokens_are_rejected_by_serde() {
    let golden = goldens().cases.remove(0);
    for raw in [
        golden
            .manifest_json
            .replacen("\"version\":2", "\"version\":2,\"version\":2", 1),
        golden
            .manifest_json
            .replacen("\"version\":2", "\"version\":2,\"vers\\u0069on\":2", 1),
        golden
            .manifest_json
            .replacen("\"version\":2", "\"version\":2,\"unknown\":null", 1),
        golden
            .manifest_json
            .replacen("\"version\":2", "\"version\":2.0", 1),
        golden
            .manifest_json
            .replacen("\"version\":2", "\"version\":2e0", 1),
        golden
            .manifest_json
            .replacen("\"anchorIndex\":1", "\"anchorIndex\":-0", 1),
        golden.manifest_json.replacen(
            "\"anchorIndex\":1",
            "\"anchorIndex\":1,\"anchorIndex\":1",
            1,
        ),
        golden
            .manifest_json
            .replacen("\"byteLength\":", "\"byteLength\":1,\"byteLength\":", 1),
    ] {
        assert!(
            serde_json::from_str::<BranchManifest>(&raw).is_err(),
            "{raw}"
        );
    }
    for raw in [
        golden
            .receipt_json
            .replacen("\"version\":2", "\"version\":2,\"version\":2", 1),
        golden
            .receipt_json
            .replacen("\"version\":2", "\"version\":2,\"vers\\u0069on\":2", 1),
        golden
            .receipt_json
            .replacen("\"version\":2", "\"version\":2,\"unknown\":null", 1),
        golden
            .receipt_json
            .replacen("\"version\":2", "\"version\":2.0", 1),
        golden
            .receipt_json
            .replacen("\"kind\":\"branch\"", "\"kind\":\"branch-copy\"", 1),
        format!("{}{}", golden.receipt_json, " ".repeat(2049)),
    ] {
        assert!(BranchReceipt::decode(&raw).is_err(), "{raw}");
    }
}

#[test]
fn branch_ts_projected_three_records_reach_real_writer_at_each_saved_anchor() {
    let fixture = goldens();
    for golden in &fixture.cases {
        let (_root, lib) = library();
        let store = lib.stories();
        source(store, &fixture);
        let source_id = &golden.manifest.source.session.session_id;
        let before = snapshot(store, source_id);
        let m = freeze_new_request(store, golden);
        assert_ne!(
            m.source.session.instance,
            golden.manifest.source.session.instance
        );
        let receipt = execute(store, &m, &golden.parts);
        let mut expected = golden.receipt.clone();
        expected.request_digest = m.request_digest().unwrap();
        assert_eq!(receipt, expected);
        assert_eq!(snapshot(store, source_id), before);
        let k = m.source.anchor_index;
        assert_eq!(counts(store, &m.session_id), (1, k + 1, k + 2));
        for part in &golden.parts {
            let (kind, id) = match part.kind {
                PartKind::Session => (RecordKind::Session, &m.session_id),
                PartKind::Chapter => (RecordKind::Chapter, &m.operation_id),
                PartKind::Checkpoint1 => (RecordKind::Checkpoint, &receipt.checkpoint_id),
                _ => panic!("branch fixture has only new three parts"),
            };
            assert_eq!(
                raw_record(store, &m.session_id, k + 1, kind, id),
                part.document
            );
        }
        let source_seed = raw_record(
            store,
            source_id,
            m.source.expected_chapter_count,
            RecordKind::Seed,
            source_id,
        );
        assert_eq!(
            raw_record(store, &m.session_id, k + 1, RecordKind::Seed, &m.session_id),
            source_seed
        );
        for index in 1..=k {
            let c = lock_connection(&store.connection).unwrap();
            let (original_id, original, original_action, generation): (String, String, String, Option<String>) = c.query_row(
                "SELECT id,document,action,json_extract(document,'$.generationId') FROM arena_story_chapter WHERE session_id=?1 AND chapter_index=?2",
                params![source_id, index], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
            let expected_id = copy_id(&m.session_id, CopyKind::Chapter, index).unwrap();
            let (id, document, action, copied_generation, operation, marker): (String,String,String,Option<String>,String,String) = c.query_row(
                "SELECT id,document,action,json_extract(document,'$.generationId'),operation_id,receipt FROM arena_story_chapter WHERE session_id=?1 AND chapter_index=?2",
                params![m.session_id, index], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).unwrap();
            assert_eq!(id, expected_id);
            assert_ne!(id, original_id);
            assert_eq!(operation, id);
            assert_eq!(action, original_action);
            assert_eq!(copied_generation, generation);
            assert!(BranchReceipt::decode(&marker).is_err());
            let copy = CopyMarker::decode(&marker).unwrap();
            assert_eq!(copy.source_chapter_id, original_id);
            assert_eq!(copy.request_digest, receipt.request_digest);
            // Historical unknown raw members must survive physical mapping, not
            // merely compare equal after JSON.parse erases duplicate keys.
            let opaque = r#""opaque":1e+02,"opaque":{"escaped":"\u4e2d","lone":"\ud800","duplicate":1,"duplicate":2}"#;
            assert!(original.contains(opaque));
            assert!(document.contains(opaque));
            let checkpoint_id = copy_id(&m.session_id, CopyKind::Checkpoint, index).unwrap();
            let checkpoint: String = c
                .query_row(
                    "SELECT document FROM arena_story_checkpoint WHERE id=?1",
                    [&checkpoint_id],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(checkpoint.contains(opaque));
            drop(c);
            assert!(store
                .branch_receipt(&m.session_id, &id, &receipt.request_digest)
                .is_err());
        }
    }
}

fn continue_target(store: &StoryStore, m: &BranchManifest, receipt: &BranchReceipt) {
    let next = receipt.chapter_index + 1;
    let mut parts = crate::arena_story::tests::fixture(&m.session_id, next);
    let previous: Value = serde_json::from_str::<Value>(&raw_record(
        store,
        &m.session_id,
        receipt.revision,
        RecordKind::Session,
        &m.session_id,
    ))
    .unwrap();
    for (kind, raw) in &mut parts {
        let mut value: Value = serde_json::from_str(raw).unwrap();
        if *kind == PartKind::Session {
            value["branchOf"] = previous["branchOf"].clone();
            value["createdAt"] = previous["createdAt"].clone();
            value["lastInputCheckpointId"] = json!(receipt.checkpoint_id);
        } else if *kind == PartKind::Chapter {
            value["sourceChapterId"] = json!(receipt.chapter_id);
        }
        *raw = value.to_string();
    }
    let mut manifest = crate::arena_story::tests::manifest(&m.session_id, next, &parts);
    manifest.expected_last_chapter_id = Some(receipt.chapter_id.clone());
    let token = store.begin(manifest, Instant::now()).unwrap().token;
    upload_parts(store, &token, &parts);
    assert_eq!(store.end(&token, Instant::now()).unwrap().version, 1);
}

#[test]
fn branch_ts_request_remains_exact_after_continue_source_delete_and_reopen() {
    let fixture = goldens();
    let golden = &fixture.cases[1];
    let (root, lib) = library();
    let store = lib.stories();
    source(store, &fixture);
    let m = freeze_new_request(store, golden);
    let frozen_bytes = serde_json::to_vec(&m).unwrap();
    let request_digest = m.request_digest().unwrap();
    let receipt = execute(store, &m, &golden.parts);
    continue_target(store, &m, &receipt);
    delete(
        store,
        &m.source.session.session_id,
        m.source.expected_chapter_count,
    );
    assert_eq!(
        store
            .branch_receipt(&m.session_id, &m.operation_id, &request_digest)
            .unwrap(),
        Some(receipt.clone())
    );
    drop(lib);
    let lib = LocalLibrary::open(root.path()).unwrap();
    let store = lib.stories();
    assert_ne!(m.source.session.instance, store.instance);
    assert_eq!(serde_json::to_vec(&m).unwrap(), frozen_bytes);
    assert_eq!(
        store
            .branch_receipt(&m.session_id, &m.operation_id, &request_digest)
            .unwrap(),
        Some(receipt.clone())
    );
    let before = snapshot(store, &m.session_id);
    // Native exact replay is read-only. This is not owner permission to retry an
    // unknown write: the future owner is still required to query only.
    assert_eq!(execute(store, &m, &golden.parts), receipt);
    assert_eq!(snapshot(store, &m.session_id), before);
}

#[test]
fn branch_ts_frozen_source_suffix_change_conflicts_without_target_rows() {
    let fixture = goldens();
    let golden = &fixture.cases[0];
    let (_root, lib) = library();
    let store = lib.stories();
    source(store, &fixture);
    let m = freeze_new_request(store, golden);
    let digest_before = m.request_digest().unwrap();
    let token = store.begin_branch(m.clone(), Instant::now()).unwrap().token;
    append(store, &token, &golden.parts);
    // A legitimate later suffix must conflict even though anchor bytes are unchanged.
    let source_id = &m.source.session.session_id;
    let next = m.source.expected_chapter_count + 1;
    let mut parts = crate::arena_story::tests::fixture(source_id, next);
    let previous: Value = serde_json::from_str::<Value>(&raw_record(
        store,
        source_id,
        m.source.expected_chapter_count,
        RecordKind::Session,
        source_id,
    ))
    .unwrap();
    for (kind, raw) in &mut parts {
        let mut value: Value = serde_json::from_str(raw).unwrap();
        if *kind == PartKind::Chapter {
            value["sourceChapterId"] = json!(m.source.expected_last_chapter_id);
        }
        if *kind == PartKind::Session {
            value["lastInputCheckpointId"] = previous["workingCheckpointId"].clone();
            value["createdAt"] = previous["createdAt"].clone();
        }
        *raw = value.to_string();
    }
    let mut linear = crate::arena_story::tests::manifest(source_id, next, &parts);
    linear.expected_last_chapter_id = Some(m.source.expected_last_chapter_id.clone());
    let later = store.begin(linear, Instant::now()).unwrap().token;
    upload_parts(store, &later, &parts);
    store.end(&later, Instant::now()).unwrap();
    let source_after = snapshot(store, source_id);
    assert!(matches!(
        store.end_branch(&token, Instant::now()),
        Err(StoryError::Stale)
    ));
    assert_eq!(counts(store, &m.session_id), (0, 0, 0));
    assert_eq!(snapshot(store, source_id), source_after);
    assert_eq!(m.request_digest().unwrap(), digest_before);
    assert!(store
        .branch_receipt(&m.session_id, &m.operation_id, &digest_before)
        .unwrap()
        .is_none());
}

#[test]
fn branch_ts_old_instance_without_receipt_cannot_be_refreshed_into_write_authority() {
    let fixture = goldens();
    let golden = &fixture.cases[0];
    let (root, lib) = library();
    source(lib.stories(), &fixture);
    let m = freeze_new_request(lib.stories(), golden);
    let frozen = serde_json::to_vec(&m).unwrap();
    let request_digest = m.request_digest().unwrap();
    drop(lib);
    let lib = LocalLibrary::open(root.path()).unwrap();
    let store = lib.stories();
    let source_before = snapshot(store, &m.source.session.session_id);
    assert_ne!(store.instance, m.source.session.instance);
    assert!(store
        .branch_receipt(&m.session_id, &m.operation_id, &request_digest)
        .unwrap()
        .is_none());
    let token = store.begin_branch(m.clone(), Instant::now()).unwrap().token;
    append(store, &token, &golden.parts);
    assert!(matches!(
        store.end_branch(&token, Instant::now()),
        Err(StoryError::Stale)
    ));
    assert_eq!(counts(store, &m.session_id), (0, 0, 0));
    assert_eq!(snapshot(store, &m.source.session.session_id), source_before);
    assert_eq!(serde_json::to_vec(&m).unwrap(), frozen);
}

#[test]
fn branch_ts_saved_generation_can_be_copied_as_historical_branch_without_receipt_forgery() {
    let fixture = goldens();
    let golden = &fixture.cases[2];
    let (_root, lib) = library();
    let store = lib.stories();
    source(store, &fixture);
    let m = freeze_new_request(store, golden);
    let receipt = execute(store, &m, &golden.parts);
    // An independent later native branch copies the TS-produced branch chapter
    // as history. This native helper is intentionally not labeled a TS projection.
    let (next, parts) = super::fixture(
        store,
        &m.session_id,
        receipt.chapter_count,
        receipt.chapter_count,
        "second-branch",
    );
    let second = branch(store, next.clone(), &parts);
    let c = lock_connection(&store.connection).unwrap();
    let (action, generation, operation, marker): (String, Option<String>, String, String) = c.query_row(
        "SELECT action,json_extract(document,'$.generationId'),operation_id,receipt FROM arena_story_chapter WHERE session_id=?1 AND chapter_index=?2",
        params![next.session_id, receipt.chapter_index], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
    let original: Value = serde_json::from_str(
        &golden
            .parts
            .iter()
            .find(|p| p.kind == PartKind::Chapter)
            .unwrap()
            .document,
    )
    .unwrap();
    assert_eq!(action, "branch");
    assert_eq!(generation.as_deref(), original["generationId"].as_str());
    assert_eq!(
        operation,
        copy_id(&next.session_id, CopyKind::Chapter, receipt.chapter_index).unwrap()
    );
    assert_ne!(operation, next.operation_id);
    assert!(BranchReceipt::decode(&marker).is_err());
    assert_eq!(
        CopyMarker::decode(&marker).unwrap().branch_operation_id,
        second.operation_id
    );
}

#[test]
fn branch_closed_copy_ids_match_ts_u64_be_boundary_vectors() {
    for value in goldens().copy_ids {
        let kind = match value.kind.as_str() {
            "c" => CopyKind::Chapter,
            "p" => CopyKind::Checkpoint,
            _ => panic!("unknown copy kind"),
        };
        assert_eq!(
            copy_id(&value.session_id, kind, value.index).unwrap(),
            value.id
        );
    }
    assert!(copy_id("target", CopyKind::Chapter, 0).is_err());
    assert!(copy_id("target", CopyKind::Checkpoint, MAX_SAFE_INTEGER + 1).is_err());
}
