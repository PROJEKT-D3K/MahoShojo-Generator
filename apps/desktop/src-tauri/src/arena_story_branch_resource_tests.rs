//! Opt-in, process-isolated resource evidence. No production limits or hooks.
use super::*;
use std::io::Write;

#[path = "arena_story_branch_sqlite_probe.rs"]
mod sqlite_probe;

fn mark(phase: &str, extra: Value) {
    let memory = std::fs::read_to_string("/proc/self/status")
        .unwrap_or_default()
        .lines()
        .filter(|line| line.starts_with("VmHWM:") || line.starts_with("VmRSS:"))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    println!(
        "RECORD_RESOURCE {}",
        json!({"phase":phase,"memory":memory,"extra":extra})
    );
    std::io::stdout().flush().unwrap();
}

fn extension(shape: &str, budget: usize) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(budget + 64);
    match shape {
        "string" => {
            out.push_str(",\"opaque\":\"");
            out.extend(std::iter::repeat_n('x', budget - 12));
            out.push('"');
        }
        "escapes" => {
            out.push_str(",\"opaque\":\"");
            while out.len() + 13 <= budget {
                out.push_str("\\ud800\\u0000");
            }
            out.push('"');
        }
        "members" => {
            let mut n = 0;
            while out.len() + 24 <= budget {
                write!(out, ",\"u{n:x}\":0").unwrap();
                n += 1;
            }
        }
        "duplicates" => {
            while out.len() + 6 <= budget {
                out.push_str(",\"u\":0");
            }
        }
        "key" => {
            out.push_str(",\"");
            out.extend(std::iter::repeat_n('k', budget - 6));
            out.push_str("\":0");
        }
        _ => panic!("unknown shape"),
    }
    assert!(out.len() <= budget);
    out
}

fn upload_frames(store: &StoryStore, token: &str, parts: &[(PartKind, String)]) {
    for (kind, document) in parts {
        for (i, bytes) in document
            .as_bytes()
            .chunks(CANDIDATE_FRAME_BYTES)
            .enumerate()
        {
            store
                .append(
                    token,
                    *kind,
                    (i * CANDIDATE_FRAME_BYTES) as u64,
                    bytes,
                    Instant::now(),
                )
                .unwrap();
        }
    }
}

// Hash actual source bytes, plus persisted digest, one record at a time. This is
// deliberately verification-phase work, outside the independent branch process.
pub(super) fn source_fingerprint(store: &StoryStore) -> String {
    use sha2::{Digest, Sha256};
    let c = lock_connection(&store.connection).unwrap();
    let mut hash = Sha256::new();
    for sql in [
        "SELECT document,document_digest FROM arena_story_session WHERE id='source' UNION ALL SELECT seed_document,seed_digest FROM arena_story_session WHERE id='source'",
        "SELECT document,document_digest FROM arena_story_chapter WHERE session_id='source' ORDER BY chapter_index",
        "SELECT document,document_digest FROM arena_story_checkpoint WHERE session_id='source' ORDER BY boundary_index",
    ] {
        let mut q = c.prepare(sql).unwrap();
        let mut rows = q.query([]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            let doc: String = row.get(0).unwrap();
            let saved: String = row.get(1).unwrap();
            assert_eq!(digest(doc.as_bytes()), saved);
            hash.update((doc.len() as u64).to_be_bytes());
            hash.update(doc.as_bytes());
            hash.update(saved.as_bytes());
        }
    }
    // Bind every persisted source column, including receipts, provenance,
    // lengths and indexes; type/length tags avoid concatenation ambiguity.
    for sql in [
        "SELECT * FROM arena_story_session WHERE id='source' ORDER BY id",
        "SELECT * FROM arena_story_chapter WHERE session_id='source' ORDER BY id",
        "SELECT * FROM arena_story_checkpoint WHERE session_id='source' ORDER BY id",
    ] {
        hash.update((sql.len() as u64).to_be_bytes());
        hash.update(sql.as_bytes());
        let mut q = c.prepare(sql).unwrap();
        let columns = q.column_count();
        let mut rows = q.query([]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            hash.update(b"row");
            for i in 0..columns {
                use rusqlite::types::ValueRef;
                match row.get_ref(i).unwrap() {
                    ValueRef::Null => hash.update(b"n"),
                    ValueRef::Integer(v) => {
                        hash.update(b"i");
                        hash.update(v.to_be_bytes());
                    }
                    ValueRef::Real(v) => {
                        hash.update(b"r");
                        hash.update(v.to_bits().to_be_bytes());
                    }
                    ValueRef::Text(v) => {
                        hash.update(b"t");
                        hash.update((v.len() as u64).to_be_bytes());
                        hash.update(v);
                    }
                    ValueRef::Blob(v) => {
                        hash.update(b"b");
                        hash.update((v.len() as u64).to_be_bytes());
                        hash.update(v);
                    }
                }
            }
        }
    }
    format!("{:x}", hash.finalize())
}

fn raw_key_token(member: &str) -> &str {
    assert!(member.starts_with('"'));
    let mut escaped = false;
    for (index, byte) in member.bytes().enumerate().skip(1) {
        if escaped {
            escaped = false;
        } else if byte == b'\\' {
            escaped = true;
        } else if byte == b'"' {
            return &member[..=index];
        }
    }
    panic!("missing key token end")
}

fn verify_copy(store: &StoryStore, table: &str, order: &str, allowed: &[&str]) {
    let c = lock_connection(&store.connection).unwrap();
    let mut q = c.prepare(&format!("SELECT s.document,t.document,t.document_bytes,t.document_digest FROM {table} s JOIN {table} t ON s.{order}=t.{order} WHERE s.session_id='source' AND t.session_id='target' ORDER BY s.{order}")).unwrap();
    let mut rows = q.query([]).unwrap();
    let mut matched = 0u64;
    while let Some(row) = rows.next().unwrap() {
        matched += 1;
        let a: String = row.get(0).unwrap();
        let b: String = row.get(1).unwrap();
        assert_eq!(b.len() as u64, row.get::<_, u64>(2).unwrap());
        assert_eq!(digest(b.as_bytes()), row.get::<_, String>(3).unwrap());
        let raw_a = serde_json::from_str(&a).unwrap();
        let raw_b = serde_json::from_str(&b).unwrap();
        let unchanged = |member: &&str| {
            let (key, _) = crate::arena_story::pending::raw_member(member).unwrap();
            !allowed
                .iter()
                .any(|name| key.iter().copied().eq(name.encode_utf16()))
        };
        let aa = crate::arena_story::pending::members(raw_a).unwrap();
        let bb = crate::arena_story::pending::members(raw_b).unwrap();
        assert!(bb.len() >= aa.len());
        for (source, target) in aa.iter().zip(&bb) {
            assert_eq!(
                raw_key_token(source),
                raw_key_token(target),
                "original key token changed"
            );
        }
        for appended in &bb[aa.len()..] {
            let (key, value) = crate::arena_story::pending::raw_member(appended).unwrap();
            assert!(["sourceChapterId", "supersededByChapterId", "chapterId"]
                .iter()
                .any(|name| key.iter().copied().eq(name.encode_utf16())));
            assert_eq!(value.get(), "null");
        }
        assert!(
            aa.into_iter()
                .filter(unchanged)
                .eq(bb.into_iter().filter(unchanged)),
            "raw tokens/order changed beyond allowed identities"
        );
    }
    let expected: u64 = c
        .query_row(
            &format!("SELECT count(*) FROM {table} WHERE session_id='source'"),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(matched, expected, "raw-copy JOIN omitted source records");
}

#[test]
#[ignore = "isolated resource probe; use serial runner, explicit phase/root/shape/bytes/part and disk fuse"]
fn real_store_long_record_shape_resource_probe() {
    let phase = std::env::var("MAHO_PROBE_PHASE").unwrap();
    let root = std::path::PathBuf::from(std::env::var("MAHO_PROBE_ROOT").unwrap());
    let shape = std::env::var("MAHO_PROBE_SHAPE").unwrap();
    let bytes: usize = std::env::var("MAHO_PROBE_BYTES").unwrap().parse().unwrap();
    let part = std::env::var("MAHO_PROBE_PART").unwrap();
    mark(
        "process-start",
        json!({"phase":phase,"shape":shape,"bytes":bytes,"part":part,"debugAssertions":cfg!(debug_assertions)}),
    );
    let lib = LocalLibrary::open(&root).unwrap();
    let store = lib.stories();
    if phase == "fixture" {
        commit(store, "source", 1);
        let mut parts = crate::arena_story::tests::fixture("source", 2);
        let selected = match part.as_str() {
            "chapter" => PartKind::Chapter,
            "checkpoint" => PartKind::Checkpoint1,
            _ => panic!("unknown part"),
        };
        let ext = extension(&shape, bytes);
        let ext_bytes = ext.len();
        let doc = &mut parts
            .iter_mut()
            .find(|(kind, _)| *kind == selected)
            .unwrap()
            .1;
        doc.pop();
        doc.push_str(&ext);
        doc.push('}');
        drop(ext);
        assert_eq!(parts.len(), 3);
        let package_bytes: usize = parts.iter().map(|(_, doc)| doc.len()).sum();
        assert!(package_bytes as u64 <= CANDIDATE_COMMIT_BYTES);
        mark(
            "fixture-save-start",
            json!({"packageBytes":package_bytes,"extensionBytes":ext_bytes,"parts":parts.iter().map(|(k,d)|format!("{k:?}:{}",d.len())).collect::<Vec<_>>()}),
        );
        let selected_doc = &parts.iter().find(|(kind, _)| *kind == selected).unwrap().1;
        let expected_length = selected_doc.len() as u64;
        let expected_digest = digest(selected_doc.as_bytes());
        let m = crate::arena_story::tests::manifest("source", 2, &parts);
        let token = store.begin(m, Instant::now()).unwrap().token;
        upload_frames(store, &token, &parts);
        store.end(&token, Instant::now()).unwrap();
        drop(parts);
        let (record_kind, record_id) = if selected == PartKind::Chapter {
            (RecordKind::Chapter, "source-chapter-2")
        } else {
            (RecordKind::Checkpoint, "source-checkpoint-2")
        };
        let persisted = store
            .describe_record("source", 2, record_kind, record_id)
            .unwrap();
        assert_eq!(persisted.byte_length, expected_length);
        assert_eq!(persisted.digest, expected_digest);
        mark(
            "fixture-save-end",
            json!({"storedRecordBytes":persisted.byte_length,"storedRecordDigest":persisted.digest}),
        );
        std::fs::write(root.join("source-fingerprint"), source_fingerprint(store)).unwrap();
    } else if phase == "branch" || phase == "rollback" {
        let (m, parts) = fixture(store, "source", 2, 2, "target");
        let request_digest = m.request_digest().unwrap();
        assert!(parts.iter().map(|(_, d)| d.len() as u64).sum::<u64>() <= CANDIDATE_COMMIT_BYTES);
        let token = store.begin_branch(m.clone(), Instant::now()).unwrap().token;
        upload_frames(store, &token, &parts);
        drop(parts);
        mark("end-start", json!({}));
        let start = Instant::now();
        let result = store.end_branch_with_hook(&token, Instant::now(), &mut |step, _| {
            if phase == "rollback" && step == "before-commit" {
                Err(StoryError::Busy)
            } else {
                Ok(())
            }
        });
        let elapsed = start.elapsed().as_micros();
        mark(
            "end-return",
            json!({"endElapsedUs":elapsed,"notLockTime":true}),
        );
        if phase == "rollback" {
            assert!(matches!(result, Err(StoryError::Busy)));
            assert_eq!(counts(store, "target"), (0, 0, 0));
            assert_eq!(
                store
                    .branch_receipt("target", &m.operation_id, &request_digest)
                    .unwrap(),
                None
            );
        } else {
            let receipt = result.unwrap();
            assert_eq!(counts(store, "target"), (1, 3, 4));
            assert_eq!(
                store
                    .branch_receipt("target", &m.operation_id, &request_digest)
                    .unwrap(),
                Some(receipt)
            );
            std::fs::write(root.join("request-digest"), request_digest).unwrap();
        }
    } else if phase == "verify" || phase == "verify-rollback" {
        assert_eq!(
            source_fingerprint(store),
            std::fs::read_to_string(root.join("source-fingerprint")).unwrap()
        );
        assert_eq!(counts(store, "source"), (1, 2, 3));
        if phase == "verify-rollback" {
            assert_eq!(counts(store, "target"), (0, 0, 0));
        } else {
            assert_eq!(counts(store, "target"), (1, 3, 4));
            assert!(store
                .branch_receipt(
                    "target",
                    "target-chapter-3",
                    &std::fs::read_to_string(root.join("request-digest")).unwrap()
                )
                .unwrap()
                .is_some());
            let c = lock_connection(&store.connection).unwrap();
            let sums = |session: &str| -> (u64, u64, u64, u64, u64) {
                c.query_row("SELECT (SELECT document_bytes FROM arena_story_session WHERE id=?1),(SELECT seed_bytes FROM arena_story_session WHERE id=?1),(SELECT sum(document_bytes) FROM arena_story_chapter WHERE session_id=?1),(SELECT sum(document_bytes) FROM arena_story_checkpoint WHERE session_id=?1),(SELECT coalesce(sum(document_bytes),0) FROM arena_story_chapter WHERE session_id=?1 AND chapter_index<=2)+(SELECT coalesce(sum(document_bytes),0) FROM arena_story_checkpoint WHERE session_id=?1 AND boundary_index<=2)+(SELECT seed_bytes FROM arena_story_session WHERE id=?1)", [session], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap()
            };
            mark(
                "verified-byte-totals",
                json!({"columns":["session","seed","chapters","checkpoints","copiedPrefixIncludingSeed"],"source":sums("source"),"target":sums("target")}),
            );
            drop(c);
            verify_copy(
                store,
                "arena_story_chapter",
                "chapter_index",
                &[
                    "id",
                    "sessionId",
                    "sourceChapterId",
                    "status",
                    "supersededByChapterId",
                ],
            );
            verify_copy(
                store,
                "arena_story_checkpoint",
                "boundary_index",
                &["id", "sessionId", "chapterId"],
            );
        }
        crate::arena_story::branch::audit::audit_relations(
            &lock_connection(&store.connection).unwrap(),
        )
        .unwrap();
    } else {
        panic!("unknown phase");
    }
    mark("process-end", json!({"phase":phase}));
}

// A bounded real-process lifecycle probe. All coordination and process ownership
// live in the opt-in runner; production has no new timing or failure hooks.
fn lifecycle_mark(phase: &str, extra: Value) {
    println!(
        "LIFECYCLE {}",
        json!({"phase":phase,"extra":extra,
        "pid":std::process::id(), "nonce":std::env::var("MAHO_LIFECYCLE_NONCE").unwrap(),
        "case":std::env::var("MAHO_LIFECYCLE_CASE").unwrap()})
    );
    std::io::stdout().flush().unwrap();
}
fn lifecycle_wait(expected: &str) {
    let mut line = String::new();
    assert!(std::io::stdin().read_line(&mut line).unwrap() > 0);
    assert_eq!(line.trim(), expected);
}
fn lifecycle_save(root: &std::path::Path, name: &str, value: &impl serde::Serialize) {
    let mut file = std::fs::File::create(root.join(name)).unwrap();
    serde_json::to_writer_pretty(&mut file, value).unwrap();
    file.sync_all().unwrap();
}
fn lifecycle_health(store: &StoryStore, root: &std::path::Path) {
    assert_eq!(counts(store, "source"), (1, 4, 5));
    assert_eq!(
        source_fingerprint(store),
        serde_json::from_slice::<String>(
            &std::fs::read(root.join("source-fingerprint.json")).unwrap()
        )
        .unwrap()
    );
    let c = lock_connection(&store.connection).unwrap();
    assert_eq!(
        c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert!(!c
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    crate::arena_story::branch::audit::audit_relations(&c).unwrap();
}
fn lifecycle_expected(m: &BranchManifest) -> BranchReceipt {
    let k = m.source.anchor_index;
    BranchReceipt {
        version: 2,
        kind: BranchKind::Branch,
        operation_id: m.operation_id.clone(),
        session_id: m.session_id.clone(),
        chapter_id: m.operation_id.clone(),
        chapter_index: k + 1,
        revision: k + 1,
        chapter_count: k + 1,
        prefix_end_index: k,
        anchor_chapter_id: copy_id(&m.session_id, CopyKind::Chapter, k).unwrap(),
        anchor_checkpoint_id: copy_id(&m.session_id, CopyKind::Checkpoint, k).unwrap(),
        checkpoint_id: format!("{}-checkpoint-{}", m.session_id, k + 1),
        request_digest: m.request_digest().unwrap(),
    }
}
fn lifecycle_files(root: &std::path::Path) -> Value {
    json!(
        ["library.sqlite", "library.sqlite-wal", "library.sqlite-shm"].map(|name| (
            name,
            std::fs::metadata(root.join(name))
                .map(|m| m.len())
                .unwrap_or(0)
        ))
    )
}
fn lifecycle_checkpoint(store: &StoryStore, mode: &str) -> (i64, i64, i64) {
    assert!(["PASSIVE", "TRUNCATE"].contains(&mode));
    lock_connection(&store.connection)
        .unwrap()
        .query_row(&format!("PRAGMA wal_checkpoint({mode})"), [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap()
}

#[test]
#[ignore = "real SIGKILL and bounded WAL reader; run native-branch-lifecycle-probe.py serially"]
fn real_store_branch_lifecycle_probe() {
    let root = std::path::PathBuf::from(std::env::var("MAHO_LIFECYCLE_ROOT").unwrap());
    let phase = std::env::var("MAHO_LIFECYCLE_PHASE").unwrap();
    let case = std::env::var("MAHO_LIFECYCLE_CASE").unwrap();
    lifecycle_mark(
        "process-start",
        json!({"phase":phase,"debugAssertions":cfg!(debug_assertions)}),
    );
    let lib = LocalLibrary::open(&root).unwrap();
    let store = lib.stories();
    if phase == "fixture" {
        for index in 1..=4 {
            let mut parts = crate::arena_story::tests::fixture("source", index);
            let doc = &mut parts
                .iter_mut()
                .find(|(k, _)| *k == PartKind::Chapter)
                .unwrap()
                .1;
            doc.pop();
            doc.push_str(",\"opaque\":\"");
            let padding = 2 * 1024 * 1024 - doc.len() - 2;
            doc.extend(std::iter::repeat_n('x', padding));
            doc.push_str("\"}");
            assert_eq!(doc.len(), 2 * 1024 * 1024);
            let m = crate::arena_story::tests::manifest("source", index, &parts);
            let token = store.begin(m, Instant::now()).unwrap().token;
            upload_frames(store, &token, &parts);
            store.end(&token, Instant::now()).unwrap();
        }
        lifecycle_save(&root, "source-fingerprint.json", &source_fingerprint(store));
        lifecycle_health(store, &root);
    } else if phase == "crash-writer" {
        assert!(["copy-chapter", "before-commit", "after-commit"].contains(&case.as_str()));
        let (m, parts) = fixture(store, "source", 4, 4, "target");
        lifecycle_save(&root, "frozen-manifest.json", &m);
        lifecycle_save(&root, "frozen-parts.json", &parts);
        lifecycle_save(&root, "frozen-receipt.json", &lifecycle_expected(&m));
        lifecycle_save(&root, "frozen-digest.json", &m.request_digest().unwrap());
        lifecycle_save(&root, "frozen-instance.json", &store.instance);
        lifecycle_health(store, &root);
        let token = store.begin_branch(m, Instant::now()).unwrap().token;
        upload_frames(store, &token, &parts);
        store
            .end_branch_with_hook(&token, Instant::now(), &mut |step, _| {
                if step == case {
                    lifecycle_mark(
                        "crash-ready",
                        json!({"step":step,"files":lifecycle_files(&root)}),
                    );
                    // Runner must kill its own matched Popen child. EOF is a failure,
                    // never a substitute for SIGKILL or an automatic continuation.
                    lifecycle_wait("never-resume-crash-writer");
                    panic!("crash writer unexpectedly resumed");
                }
                Ok(())
            })
            .unwrap();
        panic!("requested crash boundary was not reached");
    } else if phase == "reopen" {
        let m: BranchManifest =
            serde_json::from_slice(&std::fs::read(root.join("frozen-manifest.json")).unwrap())
                .unwrap();
        let parts: Vec<(PartKind, String)> =
            serde_json::from_slice(&std::fs::read(root.join("frozen-parts.json")).unwrap())
                .unwrap();
        let expected: BranchReceipt =
            serde_json::from_slice(&std::fs::read(root.join("frozen-receipt.json")).unwrap())
                .unwrap();
        let frozen_digest: String =
            serde_json::from_slice(&std::fs::read(root.join("frozen-digest.json")).unwrap())
                .unwrap();
        assert_eq!(m.request_digest().unwrap(), frozen_digest);
        assert_ne!(store.instance, m.source.session.instance);
        assert_eq!(std::fs::read_dir(&store.staging_root).unwrap().count(), 0);
        let before = lock_connection(&store.connection).unwrap().total_changes();
        for _ in 0..3 {
            assert_eq!(
                store
                    .branch_receipt("target", &m.operation_id, &frozen_digest)
                    .unwrap(),
                if case == "after-commit" {
                    Some(expected.clone())
                } else {
                    None
                }
            );
        }
        assert_eq!(
            lock_connection(&store.connection).unwrap().total_changes(),
            before
        );
        if case == "after-commit" {
            assert_eq!(counts(store, "target"), (1, 5, 6));
            verify_copy(
                store,
                "arena_story_chapter",
                "chapter_index",
                &[
                    "id",
                    "sessionId",
                    "sourceChapterId",
                    "status",
                    "supersededByChapterId",
                ],
            );
            verify_copy(
                store,
                "arena_story_checkpoint",
                "boundary_index",
                &["id", "sessionId", "chapterId"],
            );
        } else {
            assert_eq!(counts(store, "target"), (0, 0, 0));
            let token = store.begin_branch(m, Instant::now()).unwrap().token;
            upload_frames(store, &token, &parts);
            let mut hooks = 0;
            assert_eq!(
                store.end_branch_with_hook(&token, Instant::now(), &mut |_, _| {
                    hooks += 1;
                    Ok(())
                }),
                Err(StoryError::Stale)
            );
            assert_eq!(hooks, 0);
            assert_eq!(
                lock_connection(&store.connection).unwrap().total_changes(),
                before
            );
            store.abort(&token).unwrap();
            assert_eq!(counts(store, "target"), (0, 0, 0));
        }
        lifecycle_health(store, &root);
        lifecycle_mark(
            "reopen-verified",
            json!({"oldInstance":m_source_instance(&root),"newInstance":store.instance,"targetCounts":counts(store,"target"),"temporaryFiles":std::fs::read_dir(&store.staging_root).unwrap().count(),"receipt":if case=="after-commit" {Some(expected)} else {None}}),
        );
    } else if phase == "wal-writer" {
        // LocalLibrary is opened before the readonly process; only this writer
        // runs startup cleanup. Private fixtures and serial runner ownership
        // provide isolation; LocalLibrary::open itself does not acquire InstanceGuard.
        lifecycle_mark(
            "writer-ready",
            json!({"database":root.join("library.sqlite")}),
        );
        lifecycle_wait("reader-ready");
        let mut blocked = false;
        for i in 1..=3 {
            let target = format!("target{i}");
            // The source is still the four-record 8MiB fixture. Copy k=1 so the
            // three bounded commits plus WAL stay below this runner's fuse.
            let (m, parts) = fixture(store, "source", 4, 1, &target);
            let expected = lifecycle_expected(&m);
            lifecycle_save(&root, &format!("{target}-manifest.json"), &m);
            lifecycle_save(&root, &format!("{target}-receipt.json"), &expected);
            assert_eq!(branch(store, m, &parts), expected);
            let checkpoint = lifecycle_checkpoint(store, "PASSIVE");
            blocked |= checkpoint.1 > checkpoint.2;
            lifecycle_mark(
                "wal-commit",
                json!({"target":target,"checkpoint":checkpoint,"files":lifecycle_files(&root)}),
            );
        }
        assert!(blocked, "no measured blocked checkpoint: evidence invalid");
        lifecycle_mark("commits-ready", json!({}));
        lifecycle_wait("reader-released");
        let checkpoint = lifecycle_checkpoint(store, "TRUNCATE");
        assert_eq!(checkpoint, (0, 0, 0));
        assert_eq!(
            std::fs::metadata(root.join("library.sqlite-wal"))
                .unwrap()
                .len(),
            0
        );
        lifecycle_mark(
            "wal-truncated",
            json!({"checkpoint":checkpoint,"files":lifecycle_files(&root)}),
        );
        lifecycle_health(store, &root);
    } else if phase == "wal-reopen" {
        for i in 1..=3 {
            let target = format!("target{i}");
            let expected: BranchReceipt = serde_json::from_slice(
                &std::fs::read(root.join(format!("{target}-receipt.json"))).unwrap(),
            )
            .unwrap();
            assert_eq!(counts(store, &target), (1, 2, 3));
            assert_eq!(
                store
                    .branch_receipt(&target, &expected.operation_id, &expected.request_digest)
                    .unwrap(),
                Some(expected)
            );
        }
        lifecycle_health(store, &root);
        lifecycle_mark("wal-reopen-verified", json!({"targets":3}));
    } else {
        panic!("unknown lifecycle phase");
    }
    lifecycle_mark("process-end", json!({"phase":phase}));
}
fn m_source_instance(root: &std::path::Path) -> String {
    serde_json::from_slice(&std::fs::read(root.join("frozen-instance.json")).unwrap()).unwrap()
}

fn short_mark(phase: &str, extra: Value) {
    println!(
        "SHORT_HISTORY {}",
        json!({"phase":phase,"extra":extra,"pid":std::process::id(),"nonce":std::env::var("MAHO_SHORT_NONCE").unwrap(),"chapters":std::env::var("MAHO_SHORT_CHAPTERS").unwrap().parse::<u64>().unwrap()})
    );
    std::io::stdout().flush().unwrap();
}
fn short_totals(store: &StoryStore, session: &str) -> Value {
    let c = lock_connection(&store.connection).unwrap();
    let (document,seed,chapters,checkpoints):(u64,u64,u64,u64) = c.query_row("SELECT (SELECT document_bytes FROM arena_story_session WHERE id=?1),(SELECT seed_bytes FROM arena_story_session WHERE id=?1),(SELECT coalesce(sum(document_bytes),0) FROM arena_story_chapter WHERE session_id=?1),(SELECT coalesce(sum(document_bytes),0) FROM arena_story_checkpoint WHERE session_id=?1)", [session], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
    json!({"sessionDocumentBytes":document,"seedDocumentBytes":seed,"chapterDocumentBytes":chapters,"checkpointDocumentBytes":checkpoints,"sumDocumentBytes":document+seed+chapters+checkpoints,"sourcePrefixIncludingSeedBytes":seed+chapters+checkpoints})
}
fn short_index_storage(store: &StoryStore) -> Value {
    let c = lock_connection(&store.connection).unwrap();
    let (pages, bytes): (i64, i64) = c.query_row("SELECT count(*),coalesce(sum(pgsize),0) FROM dbstat WHERE name='arena_story_chapter_source'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    json!({"index":"arena_story_chapter_source","pages":pages,"bytes":bytes,"scope":"dbstat logical index pages after measured work; includes all persisted sessions"})
}
fn short_health(store: &StoryStore, root: &std::path::Path, n: u64) {
    assert_eq!(counts(store, "source"), (1, n, n + 1));
    assert_eq!(
        source_fingerprint(store),
        std::fs::read_to_string(root.join("source-fingerprint")).unwrap()
    );
    let c = lock_connection(&store.connection).unwrap();
    assert_eq!(
        c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert!(!c
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    crate::arena_story::branch::audit::audit_relations(&c).unwrap();
}
fn short_calibration() -> Value {
    // This reports call-loop overhead, not a correction to measured lock times.
    let start = Instant::now();
    for _ in 0..32_000 {
        probe::mark("calibration");
    }
    let disabled = start.elapsed().as_nanos();
    let mut enabled = 0;
    for _ in 0..1000 {
        probe::enable();
        let start = Instant::now();
        for _ in 0..32 {
            probe::mark("calibration");
        }
        enabled += start.elapsed().as_nanos();
        assert_eq!(probe::take().len(), 32);
    }
    json!({"calls":32000,"disabledLoopNs":disabled,"enabledLoopNs":enabled,"scope":"debug call-loop overhead; clock and fixed-slot bookkeeping included; not subtracted from measurements"})
}
#[test]
#[ignore = "serial short-history resource probe; explicit root/count/phase/nonce and bounded runner required"]
fn real_store_short_history_resource_probe() {
    let root = std::path::PathBuf::from(std::env::var("MAHO_SHORT_ROOT").unwrap());
    let n: u64 = std::env::var("MAHO_SHORT_CHAPTERS")
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        [100, 1000, 10000].contains(&n),
        "fixture tiers, not a product limit"
    );
    let phase = std::env::var("MAHO_SHORT_PHASE").unwrap();
    short_mark(
        "process-start",
        json!({"phase":phase,"debugAssertions":cfg!(debug_assertions)}),
    );
    let lib = LocalLibrary::open(&root).unwrap();
    let store = lib.stories();
    if phase == "fixture" {
        let start = Instant::now();
        for index in 1..=n {
            commit(store, "source", index);
            if index % 100 == 0 {
                short_mark(
                    "fixture-progress",
                    json!({"saved":index,"elapsedUs":start.elapsed().as_micros()}),
                );
            }
        }
        let save_elapsed = start.elapsed().as_micros();
        std::fs::write(root.join("source-fingerprint"), source_fingerprint(store)).unwrap();
        short_health(store, &root, n);
        short_mark(
            "fixture-verified",
            json!({"source":short_totals(store,"source"),"saveElapsedUs":save_elapsed}),
        );
        let sqlite = sqlite_probe::inspect(&lock_connection(&store.connection).unwrap(), "source");
        short_mark("sqlite-diagnostics", sqlite);
        short_mark("index-storage", short_index_storage(store));
    } else if phase == "rollback" || phase == "branch" {
        let (m, parts) = fixture(store, "source", n, n, "target");
        let digest = m.request_digest().unwrap();
        std::fs::write(
            root.join("request-identity.json"),
            serde_json::to_vec(&json!({"operation":m.operation_id,"digest":digest})).unwrap(),
        )
        .unwrap();
        let token = store.begin_branch(m.clone(), Instant::now()).unwrap().token;
        upload_frames(store, &token, &parts);
        drop(parts);
        short_mark("calibration", short_calibration());
        let mut copied = 0u64;
        probe::enable();
        let start = Instant::now();
        let result = store.end_branch_with_hook(&token, Instant::now(), &mut |step, _| {
            if step == "copy-chapter" {
                copied += 1;
                if phase == "rollback" && copied == n / 2 {
                    return Err(StoryError::Busy);
                }
            }
            Ok(())
        });
        let elapsed = start.elapsed().as_nanos();
        let events = probe::take();
        probe::validate(
            &events,
            if phase == "branch" {
                "commit"
            } else {
                "rollback"
            },
        );
        short_mark(
            "end-return",
            json!({"elapsedNs":elapsed,"copiedChapters":copied,"events":events,"result":format!("{result:?}"),"scope":"fresh uncontended end; acquired/release boundary brackets include observer overhead; permit is not a held gate mutex"}),
        );
        if phase == "rollback" {
            assert_eq!(copied, n / 2);
            assert_eq!(result, Err(StoryError::Busy));
            assert_eq!(counts(store, "target"), (0, 0, 0));
            assert_eq!(
                store
                    .branch_receipt("target", &m.operation_id, &digest)
                    .unwrap(),
                None
            );
            store.abort(&token).unwrap();
        } else {
            assert_eq!(copied, n);
            let receipt = result.unwrap();
            assert_eq!(
                store
                    .branch_receipt("target", &m.operation_id, &digest)
                    .unwrap(),
                Some(receipt.clone())
            );
            assert_eq!(counts(store, "target"), (1, n + 1, n + 2));
            std::fs::write(
                root.join("expected-receipt.json"),
                serde_json::to_vec(&receipt).unwrap(),
            )
            .unwrap();
        }
        assert!(lock_connection(&store.connection).unwrap().is_autocommit());
    } else if phase == "verify-rollback" || phase == "verify" {
        short_health(store, &root, n);
        short_mark("index-storage", short_index_storage(store));
        if phase == "verify-rollback" {
            assert_eq!(counts(store, "target"), (0, 0, 0));
            let identity: Value =
                serde_json::from_slice(&std::fs::read(root.join("request-identity.json")).unwrap())
                    .unwrap();
            assert_eq!(
                store
                    .branch_receipt(
                        "target",
                        identity["operation"].as_str().unwrap(),
                        identity["digest"].as_str().unwrap()
                    )
                    .unwrap(),
                None
            );
        } else {
            let receipt: BranchReceipt =
                serde_json::from_slice(&std::fs::read(root.join("expected-receipt.json")).unwrap())
                    .unwrap();
            assert_eq!(counts(store, "target"), (1, n + 1, n + 2));
            assert_eq!(
                store
                    .branch_receipt("target", &receipt.operation_id, &receipt.request_digest)
                    .unwrap(),
                Some(receipt)
            );
            verify_copy(
                store,
                "arena_story_chapter",
                "chapter_index",
                &[
                    "id",
                    "sessionId",
                    "sourceChapterId",
                    "status",
                    "supersededByChapterId",
                ],
            );
            verify_copy(
                store,
                "arena_story_checkpoint",
                "boundary_index",
                &["id", "sessionId", "chapterId"],
            );
            let c = lock_connection(&store.connection).unwrap();
            let seeds_equal: bool = c.query_row("SELECT CAST(s.seed_document AS BLOB)=CAST(t.seed_document AS BLOB) FROM arena_story_session s JOIN arena_story_session t ON t.id='target' WHERE s.id='source'", [], |r| r.get(0)).unwrap();
            assert!(seeds_equal, "copied seed raw bytes changed");
            let copied:(u64,u64,u64)=c.query_row("SELECT (SELECT seed_bytes FROM arena_story_session WHERE id='target'),(SELECT sum(document_bytes) FROM arena_story_chapter WHERE session_id='target' AND chapter_index<=?1),(SELECT sum(document_bytes) FROM arena_story_checkpoint WHERE session_id='target' AND boundary_index<=?1)",[n],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
            drop(c);
            short_mark(
                "verified-copy-bytes",
                json!({"source":short_totals(store,"source"),"target":short_totals(store,"target"),"targetCopiedPrefixBytesIncludingSeed":copied.0+copied.1+copied.2,"copiedChapterRows":n,"copiedCheckpointRows":n+1,"scope":"persisted raw document byte totals, not physical device write counts"}),
            );
        }
        assert_eq!(std::fs::read_dir(&store.staging_root).unwrap().count(), 0);
    } else {
        panic!("unknown phase");
    }
    short_mark("process-end", json!({"phase":phase}));
}
