//! Opt-in file-backed growth probes. Fixture generation and measured operations
//! use separate processes; all writes use the real staged store APIs.
use super::*;
use crate::arena_story::read::RecordKind;
use crate::maintenance::InstanceGuard;
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::Path;

fn mark(phase: &str, extra: Value) {
    let memory = std::fs::read_to_string("/proc/self/status")
        .unwrap_or_default()
        .lines()
        .filter(|line| line.starts_with("VmHWM:") || line.starts_with("VmRSS:"))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    println!(
        "HISTORY_RESOURCE {}",
        json!({"phase":phase,"extra":extra,"memory":memory,
        "pid":std::process::id(),"nonce":std::env::var("MAHO_HISTORY_NONCE").unwrap(),
        "axis":std::env::var("MAHO_HISTORY_AXIS").unwrap(),
        "rows":std::env::var("MAHO_HISTORY_ROWS").unwrap().parse::<u64>().unwrap()})
    );
    std::io::stdout().flush().unwrap();
}

fn save(root: &Path, name: &str, value: &impl serde::Serialize) {
    std::fs::write(root.join(name), serde_json::to_vec(value).unwrap()).unwrap();
}
fn load<T: serde::de::DeserializeOwned>(root: &Path, name: &str) -> T {
    serde_json::from_slice(&std::fs::read(root.join(name)).unwrap()).unwrap()
}

// Stream typed original columns one row at a time. The first 15 chapter columns
// are precisely schema 10; candidate schema 12 only adds three derived history columns.
fn fingerprint(c: &Connection, original10: bool, skip: Option<&str>) -> String {
    let mut hash = Sha256::new();
    for table in [
        "arena_story_session",
        "arena_story_chapter",
        "arena_story_checkpoint",
    ] {
        let sql = match (table, skip) {
            ("arena_story_session", Some(_)) => {
                "SELECT seed_document,seed_bytes,seed_digest FROM arena_story_session ORDER BY id"
                    .to_owned()
            }
            ("arena_story_chapter", Some(_)) => {
                "SELECT * FROM arena_story_chapter WHERE id NOT IN (?1,'observed-tail') ORDER BY id"
                    .to_owned()
            }
            ("arena_story_checkpoint", Some(_)) => {
                "SELECT * FROM arena_story_checkpoint WHERE id!='cp-observed-tail' ORDER BY id"
                    .to_owned()
            }
            _ => format!("SELECT * FROM {table} ORDER BY id"),
        };
        hash.update(table.as_bytes());
        let mut query = c.prepare(&sql).unwrap();
        let columns = if original10 && table == "arena_story_chapter" {
            15
        } else {
            query.column_count()
        };
        let mut rows = match (table, skip) {
            ("arena_story_chapter", Some(id)) => query.query([id]).unwrap(),
            _ => query.query([]).unwrap(),
        };
        while let Some(row) = rows.next().unwrap() {
            hash.update(b"row");
            for index in 0..columns {
                use rusqlite::types::ValueRef;
                match row.get_ref(index).unwrap() {
                    ValueRef::Null => hash.update(b"n"),
                    ValueRef::Integer(v) => {
                        hash.update(b"i");
                        hash.update(v.to_be_bytes());
                    }
                    ValueRef::Real(v) => {
                        hash.update(b"r");
                        hash.update(v.to_bits().to_be_bytes());
                    }
                    ValueRef::Text(v) | ValueRef::Blob(v) => {
                        hash.update(
                            if matches!(row.get_ref(index).unwrap(), ValueRef::Text(_)) {
                                b"t"
                            } else {
                                b"b"
                            },
                        );
                        hash.update((v.len() as u64).to_be_bytes());
                        hash.update(v);
                    }
                }
            }
        }
    }
    format!("{:x}", hash.finalize())
}
fn stored_fingerprint(store: &StoryStore, original10: bool, skip: Option<&str>) -> String {
    fingerprint(
        &lock_connection(&store.connection).unwrap(),
        original10,
        skip,
    )
}
fn schema(c: &Connection) -> u64 {
    c.query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap()
}
fn health(store: &StoryStore, version: u64, physical: u64, active: u64) -> Value {
    let c = lock_connection(&store.connection).unwrap();
    assert_eq!(schema(&c), version);
    let (sessions,chapters,checkpoints):(u64,u64,u64) = c.query_row("SELECT (SELECT count(*) FROM arena_story_session),(SELECT count(*) FROM arena_story_chapter),(SELECT count(*) FROM arena_story_checkpoint)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(
        (sessions, chapters, checkpoints),
        (1, physical, physical + 1)
    );
    let count: u64 = c
        .query_row(
            "SELECT chapter_count FROM arena_story_session WHERE id='source'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, active);
    if version == 12 {
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM arena_story_chapter WHERE status='active'",
                [],
                |r| r.get::<_, u64>(0)
            )
            .unwrap(),
            active
        );
    }
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
    if version == 12 {
        crate::arena_story::branch::history::audit_relations(&c).unwrap();
    } else {
        crate::arena_story::branch::audit::audit_relations(&c).unwrap();
    }
    let bytes:(u64,u64) = c.query_row("SELECT (SELECT sum(document_bytes)+sum(seed_bytes) FROM arena_story_session)+(SELECT sum(document_bytes) FROM arena_story_chapter)+(SELECT sum(document_bytes) FROM arena_story_checkpoint), (SELECT page_count*page_size FROM pragma_page_count(),pragma_page_size())",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    json!({"schema":version,"sessionRows":sessions,"chapterRows":chapters,"checkpointRows":checkpoints,"activeChapters":count,"supersededChapters":physical-active,"documentBytes":bytes.0,"databasePageBytes":bytes.1,"integrity":"ok","foreignKeys":"ok","fullStoryAudit":"ok"})
}
fn verify_receipt(store: &StoryStore, receipt: &StoryReceipt) {
    assert_eq!(
        store.receipt("source", &receipt.operation_id).unwrap(),
        Some(receipt.clone())
    );
}
fn verify_tail_receipt(store: &StoryStore, receipt: &TailRewriteReceipt) {
    assert_eq!(
        store
            .tail_rewrite_receipt("source", &receipt.operation_id, &receipt.request_digest)
            .unwrap(),
        Some(receipt.clone())
    );
}
fn unchanged_old_head(before: &str, after: &str, new_id: &str) {
    let keep = |document: &str| {
        pending::members(serde_json::from_str(document).unwrap())
            .unwrap()
            .into_iter()
            .filter(|member| {
                let (key, _) = pending::raw_member(member).unwrap();
                !["status", "supersededByChapterId"]
                    .iter()
                    .any(|name| key.iter().copied().eq(name.encode_utf16()))
            })
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        keep(before),
        keep(after),
        "old head original tokens changed"
    );
    let parsed: Value = serde_json::from_str(after).unwrap();
    assert_eq!(parsed["status"], "superseded");
    assert_eq!(parsed["supersededByChapterId"], new_id);
}
fn rewrite_checked(store: &StoryStore, operation: &str, observed: bool) -> TailRewriteReceipt {
    let start = Instant::now();
    let (manifest, parts) = fixture(store, "source", operation);
    let resolved = start.elapsed().as_nanos();
    let old = raw(
        store,
        "arena_story_chapter",
        &manifest.source.target_chapter_id,
    );
    let old_receipt = lock_connection(&store.connection)
        .unwrap()
        .query_row(
            "SELECT receipt FROM arena_story_chapter WHERE id=?1",
            [&manifest.source.target_chapter_id],
            |r| r.get::<_, String>(0),
        )
        .unwrap();
    let start = Instant::now();
    let token = upload(store, &manifest, &parts);
    let staged = start.elapsed().as_nanos();
    // Existing real transaction hooks only. These are not mutex boundaries.
    let mut hooks = Vec::with_capacity(16);
    let start = Instant::now();
    let receipt = store
        .end_tail_rewrite_with_hook(&token, Instant::now(), &mut |name, _| {
            if observed {
                assert!(hooks.len() < 16);
                let known = [
                    "source-cas",
                    "validated",
                    "superseded",
                    "chapter",
                    "checkpoint",
                    "session",
                    "audited",
                    "before-commit",
                    "after-commit",
                ]
                .into_iter()
                .find(|known| *known == name)
                .unwrap();
                hooks.push((known, start.elapsed().as_nanos()));
            }
            Ok(())
        })
        .unwrap();
    let ended = start.elapsed().as_nanos();
    assert_eq!(receipt.revision, manifest.source.expected_revision + 1);
    assert_eq!(receipt.chapter_count, 3);
    assert_eq!(receipt.request_digest, manifest.request_digest().unwrap());
    verify_tail_receipt(store, &receipt);
    unchanged_old_head(
        &old,
        &raw(
            store,
            "arena_story_chapter",
            &manifest.source.target_chapter_id,
        ),
        operation,
    );
    assert_eq!(
        old_receipt,
        lock_connection(&store.connection)
            .unwrap()
            .query_row(
                "SELECT receipt FROM arena_story_chapter WHERE id=?1",
                [&manifest.source.target_chapter_id],
                |r| r.get::<_, String>(0)
            )
            .unwrap()
    );
    if observed {
        mark(
            "rewrite-return",
            json!({"resolveAndFixtureNs":resolved,"beginAppendNs":staged,"endCallNs":ended,"hooks":hooks,"receipt":receipt,"scope":"uncontended calls and transaction hook offsets; not mutex hold times"}),
        );
    }
    receipt
}
fn read_tail(store: &StoryStore, revision: u64) {
    let start = Instant::now();
    let resolved = source(store, "source");
    let resolve = start.elapsed().as_nanos();
    let start = Instant::now();
    let page = store.list_chapters("source", revision, None, None).unwrap();
    let list = start.elapsed().as_nanos();
    assert_eq!(page.rows.len(), 3);
    assert!(page.next_cursor.is_none());
    let start = Instant::now();
    let descriptor = store
        .describe_record(
            "source",
            revision,
            RecordKind::Chapter,
            &resolved.source.target_chapter_id,
        )
        .unwrap();
    let mut bytes = Vec::new();
    while (bytes.len() as u64) < descriptor.byte_length {
        bytes.extend(
            store
                .read_record_chunk(&descriptor, bytes.len() as u64, 4096)
                .unwrap(),
        );
    }
    assert_eq!(digest(&bytes), descriptor.digest);
    mark(
        "read-return",
        json!({"resolveSourceNs":resolve,"listActiveNs":list,"describeAndReadNs":start.elapsed().as_nanos(),"activeRows":page.rows.len(),"recordBytes":bytes.len()}),
    );
}
fn candidate_open(root: &Path, migration: bool) -> LocalLibrary {
    use crate::arena_story::branch::resource_probe;
    resource_probe::enable();
    let start = Instant::now();
    let lib = with_history_schema_for_test(|| LocalLibrary::open(root).unwrap());
    let elapsed = start.elapsed().as_nanos();
    let events = resource_probe::take();
    let mut expected = vec!["upgrade.pre-backup.before", "upgrade.pre-backup.after"];
    if migration {
        expected.extend([
            "migration12.begin.before",
            "migration12.begin.after",
            "migration12.pre-audit.before",
            "migration12.pre-audit.after",
            "migration12.sql.before",
            "migration12.sql.after",
            "migration12.post-audit.before",
            "migration12.post-audit.after",
            "migration12.commit.before",
            "migration12.commit.after",
        ]);
    }
    assert_eq!(
        events.iter().map(|event| event.name).collect::<Vec<_>>(),
        expected
    );
    assert!(events.windows(2).all(|pair| pair[0].nanos <= pair[1].nanos));
    let phases = events
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            json!({
                "name":pair[0].name.strip_suffix(".before").unwrap(),
                "elapsedNs":pair[1].nanos-pair[0].nanos
            })
        })
        .collect::<Vec<_>>();
    mark(
        "open-return",
        json!({"elapsedNs":elapsed,"phaseCalls":phases,"events":events,
        "scope":"LocalLibrary::open and non-overlapping call brackets; pre-backup means the backup guard call, not InstanceGuard; pre-audit covers old schema/story/pending, post-audit covers new schema/history/FK; SQL excludes journal/user_version gaps; no mutex hold-time claim"}),
    );
    lib
}
fn backup_original(root: &Path, expected: &str) -> crate::backup::BackupSummary {
    let listed = crate::backup::list_backups(root).unwrap();
    assert_eq!(listed.invalid_count, 0);
    assert_eq!(listed.backups.len(), 1);
    let backup = listed.backups.into_iter().next().unwrap();
    assert_eq!(
        crate::backup::verify_backup(root, &backup.backup_id).unwrap(),
        backup
    );
    let c = Connection::open_with_flags(
        Path::new(&backup.absolute_path).join("library.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(schema(&c), 10);
    assert_eq!(fingerprint(&c, true, None), expected);
    backup
}

#[test]
#[ignore = "bounded serial candidate growth runner only; explicit axis/rows/phase/root/nonce"]
fn real_store_candidate_history_resource_probe() {
    let root = std::path::PathBuf::from(std::env::var("MAHO_HISTORY_ROOT").unwrap());
    let axis = std::env::var("MAHO_HISTORY_AXIS").unwrap();
    let phase = std::env::var("MAHO_HISTORY_PHASE").unwrap();
    let n: u64 = std::env::var("MAHO_HISTORY_ROWS").unwrap().parse().unwrap();
    assert!(
        (100..=10000).contains(&n),
        "experimental fixture tiers, not product caps"
    );
    assert!(["upgrade", "history"].contains(&axis.as_str()));
    mark(
        "process-start",
        json!({"phase":phase,"debugAssertions":cfg!(debug_assertions)}),
    );
    let guard_start = Instant::now();
    let _instance = InstanceGuard::acquire(&root).unwrap();
    mark(
        "instance-acquired",
        json!({"elapsedNs":guard_start.elapsed().as_nanos()}),
    );
    if axis == "upgrade" && phase == "fixture" {
        // Same legal linear fixture as the short-history branch probe, using
        // begin/append/end instead of synthesizing database rows.
        let connection = Connection::open(root.join("library.sqlite")).unwrap();
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON",
            )
            .unwrap();
        crate::store::migrate_to_version_for_test(&connection, 10);
        let lib = LocalLibrary::open_with_connection(
            &root,
            std::sync::Arc::new(std::sync::Mutex::new(connection)),
        )
        .unwrap();
        let store = lib.stories();
        let start = Instant::now();
        for i in 1..=n {
            let receipt = commit(store, "source", i);
            if i == n {
                save(&root, "linear-receipt.json", &receipt);
            }
            if i % 100 == 0 {
                mark(
                    "fixture-progress",
                    json!({"physicalChapters":i,"elapsedNs":start.elapsed().as_nanos()}),
                );
            }
        }
        mark(
            "fixture-written",
            json!({"elapsedNs":start.elapsed().as_nanos()}),
        );
        save(
            &root,
            "original-fingerprint.json",
            &stored_fingerprint(store, true, None),
        );
        mark("verified", health(store, 10, n, n));
    } else if axis == "upgrade" && ["upgrade", "reopen"].contains(&phase.as_str()) {
        let lib = candidate_open(&root, phase == "upgrade");
        let store = lib.stories();
        let expected: String = load(&root, "original-fingerprint.json");
        assert_eq!(stored_fingerprint(store, true, None), expected);
        verify_receipt(store, &load(&root, "linear-receipt.json"));
        mark("verified", health(store, 12, n, n));
        let backup = backup_original(&root, &expected);
        mark(
            "backup-verified",
            json!({"backup":backup,"originalColumnsByteExact":true}),
        );
        save(&root, "original-backup.json", &backup);
        if phase == "reopen" {
            let start = Instant::now();
            let prepared = with_history_schema_for_test(|| {
                crate::restore::prepare_restore(&lib, &backup.backup_id).unwrap()
            });
            mark(
                "restore-prepared",
                json!({"elapsedNs":start.elapsed().as_nanos()}),
            );
            drop(lib);
            drop(prepared);
        }
    } else if axis == "upgrade" && phase == "restore" {
        let start = Instant::now();
        crate::restore::recover_pending(&root).unwrap();
        let recovered = start.elapsed().as_nanos();
        let start = Instant::now();
        let lib = LocalLibrary::open(&root).unwrap();
        let store = lib.stories();
        mark(
            "restore-open-return",
            json!({"recoverPendingNs":recovered,"default11OpenNs":start.elapsed().as_nanos()}),
        );
        assert_eq!(
            stored_fingerprint(store, true, None),
            load::<String>(&root, "original-fingerprint.json")
        );
        verify_receipt(store, &load(&root, "linear-receipt.json"));
        mark("verified", health(store, 11, n, n));
        let backup: crate::backup::BackupSummary = load(&root, "original-backup.json");
        assert_eq!(
            crate::backup::verify_backup(&root, &backup.backup_id).unwrap(),
            backup
        );
        mark(
            "restored-original",
            json!({"originalColumnsByteExact":true,"originalBackupStillVerified":true}),
        );
    } else if axis == "history" {
        let lib = candidate_open(&root, phase == "fixture");
        let store = lib.stories();
        if phase == "fixture" {
            let start = Instant::now();
            for i in 1..=3 {
                let receipt = commit(store, "source", i);
                save(&root, &format!("linear-{i}.json"), &receipt);
            }
            for physical in 4..=n {
                let receipt = rewrite_checked(store, &format!("history-{physical}"), false);
                if physical == n {
                    save(&root, "history-receipt.json", &receipt);
                }
                if physical % 100 == 0 {
                    mark(
                        "fixture-progress",
                        json!({"physicalChapters":physical,"rewrites":physical-3,"activeChapters":3,"elapsedNs":start.elapsed().as_nanos()}),
                    );
                }
            }
            mark(
                "fixture-written",
                json!({"elapsedNs":start.elapsed().as_nanos(),"linearWrites":3,"tailRewrites":n-3}),
            );
            save(
                &root,
                "history-fingerprint.json",
                &stored_fingerprint(store, false, None),
            );
            mark("verified", health(store, 12, n, 3));
        } else if phase == "adopt" {
            // A runner-owned copy of an interrupted synthetic fixture, never a
            // user library. Validate the actually persisted count before using it.
            assert_eq!(state(store, "source").0, n);
            assert_eq!(state(store, "source").2, format!("history-{n}"));
            mark("verified", health(store, 12, n, 3));
            let operation = format!("history-{n}");
            let request_digest: String = lock_connection(&store.connection)
                .unwrap()
                .query_row(
                    "SELECT operation_digest FROM arena_story_chapter WHERE id=?1",
                    [&operation],
                    |row| row.get(0),
                )
                .unwrap();
            let receipt = store
                .tail_rewrite_receipt("source", &operation, &request_digest)
                .unwrap()
                .unwrap();
            assert_eq!(receipt.revision, n);
            assert_eq!(receipt.chapter_count, 3);
            save(&root, "history-receipt.json", &receipt);
            save(
                &root,
                "history-fingerprint.json",
                &stored_fingerprint(store, false, None),
            );
            mark(
                "adopted-fixture",
                json!({"actualPhysicalChapters":n,"activeChapters":3,"scope":"validated interrupted synthetic fixture copy; no 1k completion claim"}),
            );
        } else if phase == "rewrite" {
            assert_eq!(
                stored_fingerprint(store, false, None),
                load::<String>(&root, "history-fingerprint.json")
            );
            let old = state(store, "source").2;
            let frozen = stored_fingerprint(store, false, Some(&old));
            read_tail(store, n);
            let receipt = rewrite_checked(store, "observed-tail", true);
            assert_eq!(stored_fingerprint(store, false, Some(&old)), frozen);
            save(&root, "observed-receipt.json", &receipt);
            save(
                &root,
                "observed-fingerprint.json",
                &stored_fingerprint(store, false, None),
            );
            mark("verified", health(store, 12, n + 1, 3));
        } else if phase == "reopen" {
            assert_eq!(
                stored_fingerprint(store, false, None),
                load::<String>(&root, "observed-fingerprint.json")
            );
            for i in 1..=3 {
                verify_receipt(store, &load(&root, &format!("linear-{i}.json")));
            }
            verify_tail_receipt(store, &load(&root, "history-receipt.json"));
            verify_tail_receipt(store, &load(&root, "observed-receipt.json"));
            read_tail(store, n + 1);
            mark("verified", health(store, 12, n + 1, 3));
        } else {
            panic!("unknown history phase");
        }
        assert_eq!(std::fs::read_dir(&store.staging_root).unwrap().count(), 0);
    } else {
        panic!("unknown upgrade phase");
    }
    mark("process-end", json!({"phase":phase}));
}
