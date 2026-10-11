//! Real historical files restored through the startup boundary into candidate 11.
//! All data is synthetic; release opens and the original schema-10 matrix stay unchanged.
use super::*;
use crate::arena_story::{branch, pending, StoryError};
use crate::maintenance::InstanceGuard;
use crate::store::{applied_migrations, with_history_schema_for_test, StoreError};
use rusqlite::{params, types::Value};
use std::sync::{Arc, Mutex};

const WHEN: &str = "2026-10-03T00:00:00Z";
const PROFILE: &str =
    r#"{"id":"historical","extension":{"opaque":1,"opaque":2,"\u0078":"escaped\\value"}}"#;
const RAW: &str = r#"{"opaque":1,"opaque":"\ud800","\u0078":"escaped\\value"}"#;

fn rows(connection: &Connection, sql: &str) -> Vec<Vec<Value>> {
    let mut statement = connection.prepare(sql).unwrap();
    let count = statement.column_count();
    statement
        .query_map([], |row| {
            (0..count)
                .map(|i| row.get(i))
                .collect::<rusqlite::Result<Vec<Value>>>()
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

// Explicit historical projections make the old-byte claim independent of new 11
// columns. Restore fences and unpublished-upload reclamation are checked separately.
fn originals(c: &Connection, version: i64, include_uploads: bool) -> Vec<Vec<Vec<Value>>> {
    let mut queries = vec![
        "SELECT id,document,updated_at FROM provider_profile ORDER BY id".into(),
        format!("SELECT version,applied_at FROM schema_migration WHERE version<={version} ORDER BY version"),
    ];
    for (introduced, sql) in [
        (2, "SELECT id,document,card_type,updated_at,updated_at_sort,deleted_at,content_digest FROM local_card ORDER BY id"),
        (3, "SELECT digest,byte_length,created_at,last_referenced_at FROM blob ORDER BY digest"),
        (4, "SELECT id,document,ref_digest,updated_at,updated_at_sort,deleted_at,archive_byte_length FROM local_web_package ORDER BY id"),
        (4, "SELECT package_id,digest FROM web_package_archive_ref ORDER BY package_id"),
        (5, "SELECT id,document,document_bytes,document_digest,seed_document,seed_bytes,seed_digest,revision,title_preview,title_truncated,mode,chapter_plan,created_at,updated_at,chapter_count,last_chapter_id,working_checkpoint_id,last_input_checkpoint_id FROM arena_story_session ORDER BY id"),
        (5, "SELECT id,session_id,chapter_index,action,source_chapter_id,title_preview,title_truncated,created_at,markdown_bytes,document,document_bytes,document_digest,operation_id,operation_digest,receipt FROM arena_story_chapter ORDER BY id"),
        (5, "SELECT id,session_id,boundary_index,chapter_id,document,document_bytes,document_digest FROM arena_story_checkpoint ORDER BY id"),
    ] {
        if version >= introduced { queries.push(sql.into()); }
    }
    if version >= 6 {
        let filter = if include_uploads { "1" } else { "active=1" };
        let claim = if version >= 7 { "create_claim" } else { "NULL" };
        let abandon = if version >= 8 {
            "abandon_requested"
        } else {
            "0"
        };
        queries.push(format!("SELECT token,product,request_id,revision,active,metadata,total_bytes,save_attempt,{claim},{abandon} FROM arena_story_pending WHERE {filter} ORDER BY token"));
        queries.push(format!("SELECT id,token,kind,byte_length,received_bytes,digest,payload FROM arena_story_pending_part WHERE token IN (SELECT token FROM arena_story_pending WHERE {filter}) ORDER BY id"));
    }
    queries.iter().map(|sql| rows(c, sql)).collect()
}

fn refresh_manifest(directory: &Path) {
    let path = directory.join(MANIFEST_FILE);
    let mut manifest: BackupManifest = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let (length, digest) = digest_file(&directory.join(DATABASE_FILE)).unwrap();
    manifest.database.byte_length = length;
    manifest.database.digest = digest;
    fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
}

fn populated_backup(root: &Path, version: i64, format: u32) -> String {
    let id = super::tests::historical_backup(root, version, format);
    let directory = root.join(BACKUPS_DIRECTORY).join(&id);
    // The original store producers work with their historical columns; wrapping
    // an already migrated connection here does not run LocalLibrary::open.
    {
        let c = Connection::open(directory.join(DATABASE_FILE)).unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        let shared = Arc::new(Mutex::new(c));
        crate::store::LocalStore::new(Arc::clone(&shared))
            .put("historical", PROFILE, WHEN)
            .unwrap();
        if version >= 2 {
            let store = crate::local_card::LocalCardStore::new(Arc::clone(&shared));
            for (id, deleted) in [("lc_backup_live", None), ("lc_backup_deleted", Some(WHEN))] {
                let digest = crate::blob::digest_of(RAW.as_bytes());
                let tombstone = deleted
                    .map(|date| format!(r#","deletedAt":"{date}""#))
                    .unwrap_or_default();
                let document = format!(
                    r#"{{"id":"{id}","schemaVersion":1,"storageLocation":"local","cardType":"character","title":"备份卡","data":{RAW},"contentDigest":"{digest}","provenance":{{"kind":"unsigned","execution":"imported"}},"createdAt":"{WHEN}","updatedAt":"{WHEN}"{tombstone}}}"#
                );
                store
                    .put(
                        &document,
                        &crate::local_card::LocalCardIndex {
                            id: id.into(),
                            card_type: "character".into(),
                            updated_at: WHEN.into(),
                            deleted_at: deleted.map(str::to_owned),
                            content_digest: digest,
                        },
                    )
                    .unwrap();
            }
        }
        if version >= 4 {
            let blobs =
                crate::blob::open(BlobPaths::under(&directory), Arc::clone(&shared)).unwrap();
            let store = crate::web_package::WebPackageStore::new(Arc::clone(&shared));
            let html = b"<p>backup</p>";
            let manifest = serde_json::json!({
                "format": "mahoshojo-web-package", "formatVersion": 1,
                "id": "backup", "version": "1.0.0", "name": "备份包", "entry": "index.html",
                "generation": {"target": "index.html", "mode": "replace", "mediaType": "text/html"},
                "capabilities": [],
                "files": [{"path": "index.html", "mediaType": "text/html", "digest": crate::blob::digest_of(html), "size": html.len()}],
            }).to_string();
            let digest = crate::blob::digest_of(manifest.as_bytes());
            let id = format!("wp_{}", &parse_digest(&digest).unwrap()[..32]);
            // Archive payload is opaque to these storage/restore producers.
            let archive = b"historical blob";
            let document = format!(
                r#"{{"id":"{id}","schemaVersion":1,"storageLocation":"local","entityKind":"web-package","title":"备份包","summary":"backup@1.0.0","ref":{{"id":"backup","version":"1.0.0","digest":"{digest}"}},"manifest":{manifest},"contentDigest":"{digest}","archiveByteLength":{},"provenance":{{"kind":"unsigned"}},"createdAt":"{WHEN}","updatedAt":"{WHEN}","deletedAt":"{WHEN}"}}"#,
                archive.len()
            );
            store
                .save(
                    &blobs,
                    &document,
                    &crate::web_package::WebPackageIndex {
                        id,
                        updated_at: WHEN.into(),
                        deleted_at: Some(WHEN.into()),
                        content_digest: digest,
                    },
                    archive,
                    WHEN,
                )
                .unwrap();
        }
    }
    let c = Connection::open(directory.join(DATABASE_FILE)).unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    if version >= 5 {
        branch::schema::tests::fixture(&c, version >= 9);
        // The graph fixture already preserves duplicate keys and lone surrogate
        // escapes. Add nonempty body/summary originals, retaining those raw bytes.
        let document: String = c
            .query_row("SELECT document FROM arena_story_session", [], |r| r.get(0))
            .unwrap();
        let document = format!(
            r#"{},"sessionSummary":"完整摘要🙂","summaryMeta":{{"coveredUntilChapterIndex":2,"coveredChapterIds":["{}","{}"],"mode":"deterministic-fallback","refreshedAt":0}}}}"#,
            &document[..document.len() - 1],
            if version >= 9 {
                c.query_row(
                    "SELECT id FROM arena_story_chapter WHERE chapter_index=1",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .unwrap()
            } else {
                "first".into()
            },
            if version >= 9 {
                "new-chapter"
            } else {
                "second"
            }
        );
        c.execute(
            "UPDATE arena_story_session SET document=?1,document_bytes=?2,document_digest=?3",
            params![
                document,
                document.len(),
                crate::blob::digest_of(document.as_bytes())
            ],
        )
        .unwrap();
        let chapter_rows = rows(
            &c,
            "SELECT id,document FROM arena_story_chapter ORDER BY id",
        );
        for row in chapter_rows {
            let (Value::Text(id), Value::Text(document)) = (&row[0], &row[1]) else {
                panic!("chapter text");
            };
            let markdown = "恢复正文🙂\n";
            let mut value: serde_json::Value = serde_json::from_str(document).unwrap();
            value["markdown"] = serde_json::json!(markdown);
            value["markdownByteLength"] = serde_json::json!(markdown.len());
            let document = value.to_string();
            let document = format!("{},\"extension\":{RAW}}}", &document[..document.len() - 1]);
            c.execute("UPDATE arena_story_chapter SET markdown_bytes=?1,document=?2,document_bytes=?3,document_digest=?4 WHERE id=?5", params![markdown.len(),document,document.len(),crate::blob::digest_of(document.as_bytes()),id]).unwrap();
        }
    }
    if version >= 6 {
        pending::seed_historical_backup(&c, version, format == MANIFEST_VERSION);
    }
    // A mislabeled modern database would fail these absence checks.
    for (introduced, table) in [
        (2, "local_card"),
        (3, "blob"),
        (4, "local_web_package"),
        (5, "arena_story_session"),
        (6, "arena_story_pending"),
    ] {
        let exists: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(exists, version >= introduced);
    }
    if version >= 6 {
        let names: Vec<String> = c
            .prepare("SELECT name FROM pragma_table_info('arena_story_pending')")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(names.iter().any(|s| s == "create_claim"), version >= 7);
        assert_eq!(names.iter().any(|s| s == "abandon_requested"), version >= 8);
    }
    assert_eq!(verify_sqlite(&c), Ok(version));
    assert_eq!(
        applied_migrations(&c).unwrap(),
        (1..=version).collect::<Vec<_>>()
    );
    drop(c);
    refresh_manifest(&directory);
    verify_backup(root, &id).unwrap();
    id
}

fn backup_bytes(directory: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut paths = vec![directory.join(DATABASE_FILE), directory.join(MANIFEST_FILE)];
    paths.extend(
        fs::read_dir(directory.join(BACKUP_BLOBS_DIRECTORY))
            .unwrap()
            .map(|e| e.unwrap().path()),
    );
    paths.sort();
    paths
        .into_iter()
        .map(|p| {
            let bytes = fs::read(&p).unwrap();
            (p, bytes)
        })
        .collect()
}

fn assert_pending(c: &Connection, version: i64, opened: bool, format: u32) {
    if version < 6 {
        return;
    }
    assert_eq!(rows(c, "SELECT active,restored,count(*) FROM arena_story_pending GROUP BY active,restored ORDER BY active"),
        if opened { vec![vec![Value::Integer(1),Value::Integer(1),Value::Integer(2)]] } else { vec![vec![Value::Integer(0),Value::Integer(0),Value::Integer(1)], vec![Value::Integer(1),Value::Integer(1),Value::Integer(2)]] });
    assert_eq!(
        rows(
            c,
            "SELECT count(*) FROM arena_story_pending WHERE save_attempt IS NOT NULL"
        ),
        vec![vec![Value::Integer(i64::from(format == MANIFEST_VERSION))]]
    );
    if opened || version >= 7 {
        assert_eq!(
            rows(
                c,
                "SELECT count(*) FROM arena_story_pending WHERE create_claim IS NOT NULL"
            ),
            vec![vec![Value::Integer(i64::from(version >= 7))]]
        );
    }
    if opened || version >= 8 {
        assert_eq!(
            rows(
                c,
                "SELECT count(*) FROM arena_story_pending WHERE abandon_requested=1"
            ),
            vec![vec![Value::Integer(i64::from(version >= 8))]]
        );
    }
    pending::audit(c).unwrap();
}

fn assert_candidate(c: &Connection, version: i64, format: u32) {
    assert_eq!(verify_sqlite(c), Ok(11));
    assert_eq!(applied_migrations(c).unwrap(), (1..=11).collect::<Vec<_>>());
    branch::history::verify_schema(c, 11).unwrap();
    branch::history::audit_relations(c).unwrap();
    assert!(rows(c, "PRAGMA foreign_key_check").is_empty());
    assert_eq!(
        rows(c, "PRAGMA integrity_check"),
        vec![vec![Value::Text("ok".into())]]
    );
    assert_pending(c, version, true, format);
    if version >= 5 {
        assert_eq!(rows(c, "SELECT status,superseded_by_chapter_id,committed_revision FROM arena_story_chapter ORDER BY chapter_index"), vec![
            vec![Value::Text("active".into()),Value::Null,if version >= 9 { Value::Null } else { Value::Integer(1) }],
            vec![Value::Text("active".into()),Value::Null,Value::Integer(2)],
        ]);
        for sql in [
            "UPDATE arena_story_chapter SET status='superseded' WHERE chapter_index=2",
            "UPDATE arena_story_chapter SET committed_revision=0 WHERE chapter_index=2",
            "UPDATE arena_story_chapter SET committed_revision=2 WHERE chapter_index=1",
            "UPDATE arena_story_chapter SET chapter_index=1 WHERE chapter_index=2",
            "UPDATE arena_story_checkpoint SET boundary_index=0 WHERE boundary_index=2",
        ] {
            assert!(c.execute(sql, []).is_err(), "candidate constraint: {sql}");
            assert!(c.is_autocommit());
        }
    }
}

#[test]
fn populated_historical_schemas_restore_into_candidate11_with_both_manifests() {
    assert_eq!(crate::store::supported_schema_version(), 10);
    for version in 1..=SCHEMA_VERSION {
        for format in [1, MANIFEST_VERSION] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path();
            let _instance = InstanceGuard::acquire(root).unwrap();
            let safety = with_history_schema_for_test(|| {
                let live = LocalLibrary::open(root).unwrap();
                live.profiles()
                    .put("pre-restore", r#"{"id":"pre-restore"}"#, WHEN)
                    .unwrap();
                let id = populated_backup(root, version, format);
                let directory = root.join(BACKUPS_DIRECTORY).join(&id);
                let bytes = backup_bytes(&directory);
                let source = open_immutable_database(&directory.join(DATABASE_FILE)).unwrap();
                let expected = originals(&source, version, false);
                let before_open = originals(&source, version, true);
                drop(source);
                let prepared = crate::restore::prepare_restore(&live, &id).unwrap();
                let safety = prepared.response.pre_restore_backup_id.clone();
                verify_backup(root, &safety).unwrap();
                drop(prepared);
                drop(live);
                crate::restore::recover_pending(root).unwrap();
                let installed = Connection::open(root.join(DATABASE_FILE)).unwrap();
                assert_eq!(verify_sqlite(&installed), Ok(version));
                assert_eq!(originals(&installed, version, true), before_open);
                assert_pending(&installed, version, false, format);
                drop(installed);
                for reopen in 0..2 {
                    let restored = LocalLibrary::open(root).unwrap();
                    let c = restored.connection().lock().unwrap();
                    assert_candidate(&c, version, format);
                    assert_eq!(
                        originals(&c, version, false),
                        expected,
                        "v{version}/format{format}"
                    );
                    drop(c);
                    if version >= 6 {
                        let snapshot = restored
                            .stories()
                            .pending_describe(pending::Product::Battle)
                            .unwrap()
                            .unwrap();
                        assert_eq!(
                            snapshot.save_attempt_id.is_some(),
                            format == MANIFEST_VERSION
                        );
                        assert!(snapshot.restored);
                        let digest = snapshot
                            .manifest
                            .commit_manifest
                            .as_ref()
                            .unwrap()
                            .wire_digest()
                            .unwrap();
                        assert_eq!(
                            restored
                                .stories()
                                .pending_prepare_save(&snapshot.manifest.key(), &digest)
                                .err(),
                            Some(StoryError::CommitUnknown)
                        );
                        for part in &snapshot.manifest.parts {
                            let payload = restored
                                .stories()
                                .pending_read(
                                    &snapshot.manifest.key(),
                                    part.kind,
                                    0,
                                    part.byte_length as usize,
                                )
                                .unwrap();
                            assert_eq!(crate::blob::digest_of(&payload), part.digest);
                        }
                    }
                    assert_eq!(
                        restored.profiles().get("historical").unwrap().as_deref(),
                        Some(PROFILE)
                    );
                    restored
                        .profiles()
                        .put("write-probe", r#"{"id":"write-probe"}"#, WHEN)
                        .unwrap();
                    assert!(restored.profiles().get("write-probe").unwrap().is_some());
                    if version >= 3 {
                        assert_eq!(
                            restored
                                .blobs()
                                .read(&crate::blob::digest_of(b"historical blob"))
                                .unwrap(),
                            b"historical blob"
                        );
                    }
                    if reopen == 0 {
                        restored.profiles().delete("write-probe").unwrap();
                    }
                    drop(restored);
                }
                let reopened = LocalLibrary::open(root).unwrap();
                assert_eq!(
                    reopened.profiles().get("write-probe").unwrap().as_deref(),
                    Some(r#"{"id":"write-probe"}"#)
                );
                drop(reopened);
                assert_eq!(backup_bytes(&directory), bytes);
                verify_backup(root, &id).unwrap();
                verify_backup(root, &safety).unwrap();
                safety
            });
            assert_eq!(crate::store::supported_schema_version(), 10);
            assert_eq!(
                LocalLibrary::open(root).err(),
                Some(StoreError::Unavailable)
            );
            assert_eq!(
                verify_backup(root, &safety),
                Err(BackupError::UnsupportedVersion)
            );
        }
    }
}

#[test]
fn restored_old_backup_journal_failure_rolls_back_only_candidate11_and_retries() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let _instance = InstanceGuard::acquire(root).unwrap();
    // Version 8 forces the real 9/10 commits before the injected 11 failure.
    let version = 8;
    with_history_schema_for_test(|| {
        let live = LocalLibrary::open(root).unwrap();
        live.profiles()
            .put("pre-restore", r#"{"id":"pre-restore"}"#, WHEN)
            .unwrap();
        let id = populated_backup(root, version, MANIFEST_VERSION);
        let directory = root.join(BACKUPS_DIRECTORY).join(&id);
        let c = Connection::open(directory.join(DATABASE_FILE)).unwrap();
        c.execute_batch("CREATE TRIGGER migration_journal_fault BEFORE INSERT ON schema_migration WHEN NEW.version=11 BEGIN SELECT RAISE(ABORT,'synthetic journal failure'); END;").unwrap();
        let expected = originals(&c, version, false);
        let uploads = originals(&c, version, true);
        drop(c);
        refresh_manifest(&directory);
        verify_backup(root, &id).unwrap();
        let bytes = backup_bytes(&directory);
        let prepared = crate::restore::prepare_restore(&live, &id).unwrap();
        let safety = prepared.response.pre_restore_backup_id.clone();
        let old = root
            .join(".restore-old")
            .join(&prepared.response.restore_id)
            .join(DATABASE_FILE);
        drop(prepared);
        drop(live);
        crate::restore::recover_pending(root).unwrap();
        assert_eq!(LocalLibrary::open(root).err(), Some(StoreError::Failure));
        let c = Connection::open(root.join(DATABASE_FILE)).unwrap();
        assert!(c.is_autocommit());
        assert_eq!(verify_sqlite(&c), Ok(10));
        assert_eq!(
            applied_migrations(&c).unwrap(),
            (1..=10).collect::<Vec<_>>()
        );
        branch::history::verify_schema(&c, 10).unwrap();
        assert_eq!(originals(&c, version, true), uploads);
        assert_pending(&c, version, false, MANIFEST_VERSION);
        assert!(rows(&c, "SELECT name FROM sqlite_master WHERE name LIKE '%_v11'").is_empty());
        assert!(rows(&c, "PRAGMA foreign_key_check").is_empty());
        verify_backup(root, &id).unwrap();
        verify_backup(root, &safety).unwrap();
        let old = open_immutable_database(&old).unwrap();
        assert_eq!(verify_sqlite(&old), Ok(11));
        assert_eq!(
            rows(&old, "SELECT id FROM provider_profile"),
            vec![vec![Value::Text("pre-restore".into())]]
        );
        drop(old);
        assert!(
            !root.join("restore.intent").exists(),
            "restore committed before migration failed"
        );
        c.execute_batch("DROP TRIGGER migration_journal_fault")
            .unwrap();
        drop(c);
        let retry = LocalLibrary::open(root).unwrap();
        let c = retry.connection().lock().unwrap();
        assert_candidate(&c, version, MANIFEST_VERSION);
        assert_eq!(originals(&c, version, false), expected);
        drop(c);
        drop(retry);
        assert_eq!(backup_bytes(&directory), bytes);
        verify_backup(root, &id).unwrap();
    });
    assert_eq!(crate::store::supported_schema_version(), 10);
}
