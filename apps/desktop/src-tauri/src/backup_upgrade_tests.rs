//! Synthetic file-open tests for the Tea11 and candidate-history12 backup barriers.
use super::*;

fn install_historical(root: &Path, version: i64) -> String {
    let id = populated_backup(root, version, MANIFEST_VERSION);
    let directory = root.join(BACKUPS_DIRECTORY).join(&id);
    fs::copy(directory.join(DATABASE_FILE), root.join(DATABASE_FILE)).unwrap();
    if version >= 3 {
        fs::create_dir(root.join(BACKUP_BLOBS_DIRECTORY)).unwrap();
        for entry in fs::read_dir(directory.join(BACKUP_BLOBS_DIRECTORY)).unwrap() {
            let entry = entry.unwrap();
            fs::copy(
                entry.path(),
                root.join(BACKUP_BLOBS_DIRECTORY).join(entry.file_name()),
            )
            .unwrap();
        }
    }
    id
}

fn added_backup(root: &Path, before: &[String]) -> BackupSummary {
    let added: Vec<_> = list_backups(root)
        .unwrap()
        .backups
        .into_iter()
        .filter(|item| !before.contains(&item.backup_id))
        .collect();
    assert_eq!(added.len(), 1);
    added.into_iter().next().unwrap()
}

fn backup_ids(root: &Path) -> Vec<String> {
    list_backups(root)
        .unwrap()
        .backups
        .into_iter()
        .map(|b| b.backup_id)
        .collect()
}

fn assert_upgrade_pending(c: &Connection, version: i64, opened: bool) {
    if version < 6 {
        return;
    }
    assert_eq!(rows(c, "SELECT active,restored,count(*) FROM arena_story_pending GROUP BY active,restored ORDER BY active"),
        if opened { vec![vec![Value::Integer(1),Value::Integer(0),Value::Integer(2)]] }
        else { vec![vec![Value::Integer(0),Value::Integer(0),Value::Integer(1)],vec![Value::Integer(1),Value::Integer(0),Value::Integer(2)]] });
    pending::audit(c).unwrap();
}

#[test]
fn pre_upgrade_snapshot_preserves_each_original_schema_and_uncheckpointed_wal() {
    for version in 1..=10 {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let _instance = InstanceGuard::acquire(root).unwrap();
        let previous = install_historical(root, version);
        let writer = Connection::open(root.join(DATABASE_FILE)).unwrap();
        writer
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        writer
            .execute(
                "INSERT INTO provider_profile VALUES ('wal-only',?1,?2)",
                params![PROFILE, WHEN],
            )
            .unwrap();
        assert!(fs::metadata(root.join("library.sqlite-wal")).unwrap().len() > 32);
        let main = open_immutable_database(&root.join(DATABASE_FILE)).unwrap();
        assert!(rows(&main, "SELECT id FROM provider_profile WHERE id='wal-only'").is_empty());
        drop(main);
        let expected = originals(&writer, version, true);
        let upgraded = LocalLibrary::open(root).unwrap();
        let backup = added_backup(root, &[previous]);
        // The snapshot retains the exact historical schema before Tea 11.
        let directory = Path::new(&backup.absolute_path);
        let snapshot = open_immutable_database(&directory.join(DATABASE_FILE)).unwrap();
        assert_eq!(verify_sqlite(&snapshot), Ok(version));
        assert_eq!(originals(&snapshot, version, true), expected);
        assert_upgrade_pending(&snapshot, version, false);
        let manifest: BackupManifest =
            serde_json::from_slice(&fs::read(directory.join(MANIFEST_FILE)).unwrap()).unwrap();
        assert_eq!(manifest.format_version, MANIFEST_VERSION);
        assert_eq!(manifest.schema_version, Some(version));
        for blob in manifest.blobs {
            let name = parse_digest(&blob.digest).unwrap();
            assert_eq!(
                fs::read(directory.join("blobs").join(name)).unwrap(),
                fs::read(root.join("blobs").join(name)).unwrap()
            );
        }
        drop(snapshot);
        let c = upgraded.connection().lock().unwrap();
        assert_eq!(
            rows(&c, "SELECT id FROM provider_profile WHERE id='wal-only'"),
            vec![vec![Value::Text("wal-only".into())]]
        );
        assert_upgrade_pending(&c, version, true);
        drop(c);
        drop(upgraded);
        drop(writer);
        let before = backup_ids(root);
        drop(LocalLibrary::open(root).unwrap());
        assert_eq!(
            backup_ids(root),
            before,
            "already 11 does not back up again"
        );
        let reopened = LocalLibrary::open(root).unwrap();
        assert_eq!(
            verify_sqlite(&reopened.connection().lock().unwrap()),
            Ok(11)
        );
    }
}

#[test]
fn pre_upgrade_failure_never_migrates_or_reclaims_pending_and_can_retry() {
    for fault in [
        "blob-digest",
        "missing-blob",
        "missing-directory",
        "space-preflight",
        "journal",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let _instance = InstanceGuard::acquire(root).unwrap();
        let previous = install_historical(root, 8);
        let c = Connection::open(root.join(DATABASE_FILE)).unwrap();
        let blob = root
            .join("blobs")
            .join(parse_digest(&crate::blob::digest_of(b"historical blob")).unwrap());
        match fault {
            "blob-digest" => fs::write(&blob, b"damaged").unwrap(),
            "missing-blob" => fs::rename(&blob, root.join("saved-blob")).unwrap(),
            "missing-directory" => {
                fs::rename(root.join("blobs"), root.join("saved-blobs")).unwrap()
            }
            // Synthetic metadata exercises the real available-space comparison;
            // no huge file or real disk exhaustion is created.
            "space-preflight" => {
                c.execute("UPDATE blob SET byte_length=?1", [i64::MAX])
                    .unwrap();
            }
            "journal" => {
                c.execute("DELETE FROM schema_migration WHERE version=4", [])
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let before = originals(&c, 8, true);
        let schema = rows(
            &c,
            "SELECT type,name,sql FROM sqlite_master ORDER BY type,name",
        );
        let error = LocalLibrary::open(root).err().unwrap();
        assert!(
            matches!(error, StoreError::UpgradeBackup(_)),
            "{fault}: {error:?}"
        );
        if fault == "space-preflight" {
            assert_eq!(
                error,
                StoreError::UpgradeBackup(BackupError::SourceUnavailable)
            );
        }
        assert_eq!(error.code(), "upgrade-backup-failed");
        assert!(error.message().contains("No migration started"));
        assert_eq!(
            rows(&c, "PRAGMA user_version"),
            vec![vec![Value::Integer(8)]]
        );
        assert_eq!(originals(&c, 8, true), before);
        assert_eq!(
            rows(
                &c,
                "SELECT type,name,sql FROM sqlite_master ORDER BY type,name"
            ),
            schema
        );
        assert_upgrade_pending(&c, 8, false);
        verify_backup(root, &previous).unwrap();
        assert_eq!(list_backups(root).unwrap().invalid_count, 1);
        if fault == "blob-digest" {
            fs::write(&blob, b"historical blob").unwrap();
            drop(LocalLibrary::open(root).unwrap());
            assert_eq!(
                list_backups(root).unwrap().invalid_count,
                1,
                "failed directory retained"
            );
            let retry = added_backup(root, &[previous]);
            assert_eq!(
                verify_sqlite(
                    &open_immutable_database(&Path::new(&retry.absolute_path).join(DATABASE_FILE))
                        .unwrap()
                ),
                Ok(8)
            );
        }
    }
}

#[test]
fn pre_upgrade_unusable_destination_retains_source_and_blocker() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let _instance = InstanceGuard::acquire(root).unwrap();
    install_historical(root, 8);
    fs::rename(root.join(BACKUPS_DIRECTORY), root.join("saved-backups")).unwrap();
    fs::write(root.join(BACKUPS_DIRECTORY), b"keep this blocker").unwrap();
    let c = Connection::open(root.join(DATABASE_FILE)).unwrap();
    let expected = originals(&c, 8, true);
    assert!(matches!(
        LocalLibrary::open(root).err(),
        Some(StoreError::UpgradeBackup(_))
    ));
    assert_eq!(verify_sqlite(&c), Ok(8));
    assert_eq!(originals(&c, 8, true), expected);
    assert_eq!(
        fs::read(root.join(BACKUPS_DIRECTORY)).unwrap(),
        b"keep this blocker"
    );
    assert_upgrade_pending(&c, 8, false);
}

#[test]
fn pre_upgrade_migration_failure_retains_old_backup_and_real_restore_can_reupgrade() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let _instance = InstanceGuard::acquire(root).unwrap();
    let previous = install_historical(root, 8);
    let c = Connection::open(root.join(DATABASE_FILE)).unwrap();
    c.execute_batch("CREATE TRIGGER migration_journal_fault BEFORE INSERT ON schema_migration WHEN NEW.version=11 BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
    let expected = originals(&c, 8, true);
    assert_eq!(LocalLibrary::open(root).err(), Some(StoreError::Failure));
    assert_eq!(verify_sqlite(&c), Ok(10));
    let old_backup = added_backup(root, &[previous]);
    let old_directory = Path::new(&old_backup.absolute_path);
    let snapshot = open_immutable_database(&old_directory.join(DATABASE_FILE)).unwrap();
    assert_eq!(verify_sqlite(&snapshot), Ok(8));
    assert_eq!(originals(&snapshot, 8, true), expected);
    drop(snapshot);
    let old_bytes = backup_bytes(old_directory);
    c.execute_batch("DROP TRIGGER migration_journal_fault")
        .unwrap();
    drop(c);
    let before = backup_ids(root);
    let live = LocalLibrary::open(root).unwrap();
    let retry = added_backup(root, &before);
    assert_eq!(
        verify_sqlite(
            &open_immutable_database(&Path::new(&retry.absolute_path).join(DATABASE_FILE)).unwrap()
        ),
        Ok(10)
    );
    // Restoring the old backup also restores its deliberate Tea journal fault.
    drop(crate::restore::prepare_restore(&live, &old_backup.backup_id).unwrap());
    drop(live);
    crate::restore::recover_pending(root).unwrap();
    assert_eq!(LocalLibrary::open(root).err(), Some(StoreError::Failure));
    let c = Connection::open(root.join(DATABASE_FILE)).unwrap();
    assert_eq!(verify_sqlite(&c), Ok(10));
    assert_eq!(
        originals(&c, 8, false),
        originals(
            &open_immutable_database(&old_directory.join(DATABASE_FILE)).unwrap(),
            8,
            false
        )
    );
    assert_pending(&c, 8, false, MANIFEST_VERSION);
    c.execute_batch("DROP TRIGGER migration_journal_fault")
        .unwrap();
    drop(c);
    let before = backup_ids(root);
    let restored = LocalLibrary::open(root).unwrap();
    assert_eq!(
        verify_sqlite(&restored.connection().lock().unwrap()),
        Ok(11)
    );
    assert_pending(
        &restored.connection().lock().unwrap(),
        8,
        true,
        MANIFEST_VERSION,
    );
    let reupgrade = added_backup(root, &before);
    assert_eq!(
        verify_sqlite(
            &open_immutable_database(&Path::new(&reupgrade.absolute_path).join(DATABASE_FILE))
                .unwrap()
        ),
        Ok(10)
    );
    assert_eq!(backup_bytes(old_directory), old_bytes);
}

#[test]
fn pre_upgrade_fresh_is_narrow_and_formal11_reopen_does_not_backup_again() {
    for existing_empty in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let _instance = InstanceGuard::acquire(root).unwrap();
        if existing_empty {
            drop(Connection::open(root.join(DATABASE_FILE)).unwrap());
        }
        drop(LocalLibrary::open(root).unwrap());
        assert!(!root.join(BACKUPS_DIRECTORY).exists());
    }
    for asset in ["object", "zero-blob", "blob", "wal", "shm"] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let _instance = InstanceGuard::acquire(root).unwrap();
        match asset {
            "object" => Connection::open(root.join(DATABASE_FILE)).unwrap().execute_batch("CREATE TABLE unknown_user_data (original TEXT); INSERT INTO unknown_user_data VALUES ('keep');").unwrap(),
            "blob" | "zero-blob" => {
                if asset == "zero-blob" { drop(Connection::open(root.join(DATABASE_FILE)).unwrap()); }
                fs::create_dir(root.join("blobs")).unwrap();
                fs::write(root.join("blobs/keep"), b"original").unwrap();
            }
            "wal" => fs::write(root.join("library.sqlite-wal"), b"original").unwrap(),
            "shm" => fs::write(root.join("library.sqlite-shm"), b"original").unwrap(),
            _ => unreachable!(),
        }
        assert!(matches!(
            LocalLibrary::open(root).err(),
            Some(StoreError::UpgradeBackup(_))
        ));
        assert!(!root.join(BACKUPS_DIRECTORY).exists());
        if asset == "object" || asset == "zero-blob" {
            let c = Connection::open(root.join(DATABASE_FILE)).unwrap();
            assert_eq!(
                rows(&c, "PRAGMA user_version"),
                vec![vec![Value::Integer(0)]]
            );
            if asset == "object" {
                assert_eq!(
                    rows(&c, "SELECT original FROM unknown_user_data"),
                    vec![vec![Value::Text("keep".into())]]
                );
            }
        } else {
            assert!(
                !root.join(DATABASE_FILE).exists(),
                "do not manufacture main DB"
            );
        }
    }
    for version in 1..=SCHEMA_VERSION {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let _instance = InstanceGuard::acquire(root).unwrap();
        let previous = install_historical(root, version);
        let live = LocalLibrary::open(root).unwrap();
        assert_eq!(verify_sqlite(&live.connection().lock().unwrap()), Ok(11));
        if version < 11 {
            let backup = added_backup(root, &[previous]);
            assert_eq!(
                verify_sqlite(
                    &open_immutable_database(&Path::new(&backup.absolute_path).join(DATABASE_FILE))
                        .unwrap()
                ),
                Ok(version)
            );
        } else {
            assert_eq!(backup_ids(root), vec![previous]);
        }
        drop(live);
        let before = backup_ids(root);
        drop(LocalLibrary::open(root).unwrap());
        assert_eq!(backup_ids(root), before);
    }
}

#[test]
fn pre_upgrade_empty_main_with_original_sidecars_is_rejected_without_mutation() {
    for header in [false, true] {
        for sidecar in ["library.sqlite-wal", "library.sqlite-shm"] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path();
            let _instance = InstanceGuard::acquire(root).unwrap();
            if header {
                Connection::open(root.join(DATABASE_FILE))
                    .unwrap()
                    .execute_batch("VACUUM")
                    .unwrap();
            } else {
                fs::write(root.join(DATABASE_FILE), b"").unwrap();
            }
            let original_main = fs::read(root.join(DATABASE_FILE)).unwrap();
            fs::write(root.join(sidecar), b"original unresolved sidecar").unwrap();
            assert!(matches!(
                LocalLibrary::open(root).err(),
                Some(StoreError::UpgradeBackup(_))
            ));
            assert_eq!(fs::read(root.join(DATABASE_FILE)).unwrap(), original_main);
            assert_eq!(
                fs::read(root.join(sidecar)).unwrap(),
                b"original unresolved sidecar"
            );
            assert!(!root.join(BACKUPS_DIRECTORY).exists());
        }
    }
}

#[test]
fn every_historical_version_stays_byte_exact_when_upgrade_backup_is_blocked() {
    for version in 1..=10 {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let _instance = InstanceGuard::acquire(root).unwrap();
        install_historical(root, version);
        fs::rename(root.join(BACKUPS_DIRECTORY), root.join("saved-backups")).unwrap();
        fs::write(root.join(BACKUPS_DIRECTORY), b"retained blocker").unwrap();
        let c = Connection::open(root.join(DATABASE_FILE)).unwrap();
        c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0")
            .unwrap();
        c.execute(
            "INSERT INTO provider_profile VALUES ('wal-only',?1,?2)",
            params![PROFILE, WHEN],
        )
        .unwrap();
        let main = fs::read(root.join(DATABASE_FILE)).unwrap();
        let wal = fs::read(root.join("library.sqlite-wal")).unwrap();
        let expected = originals(&c, version, true);
        assert!(matches!(
            LocalLibrary::open(root).err(),
            Some(StoreError::UpgradeBackup(_))
        ));
        assert_eq!(verify_sqlite(&c), Ok(version));
        assert_eq!(originals(&c, version, true), expected);
        assert_eq!(fs::read(root.join(DATABASE_FILE)).unwrap(), main);
        assert_eq!(fs::read(root.join("library.sqlite-wal")).unwrap(), wal);
        assert_eq!(
            fs::read(root.join(BACKUPS_DIRECTORY)).unwrap(),
            b"retained blocker"
        );
    }
}

#[test]
fn synthetic_history11_cannot_open_migrate_or_backup_as_tea11() {
    for with_tea in [false, true] {
        for wal in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path();
            let _instance = InstanceGuard::acquire(root).unwrap();
            let c = Connection::open(root.join(DATABASE_FILE)).unwrap();
            c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
            crate::store::migrate_to_version_for_test(&c, if with_tea { 11 } else { 10 });
            branch::schema::tests::fixture(&c, true);
            pending::seed_historical_backup(&c, if with_tea { 11 } else { 10 }, true);
            if wal {
                c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0")
                    .unwrap();
            }
            c.execute_batch("BEGIN IMMEDIATE").unwrap();
            c.execute_batch(branch::schema::MIGRATION_12).unwrap();
            c.execute_batch("INSERT OR IGNORE INTO schema_migration VALUES (11,'old-history'); PRAGMA user_version=11; COMMIT").unwrap();
            // Reproduce the unpublished history11 shape, and also prove that
            // merely adding valid Tea tables cannot disguise the history columns.
            branch::history::verify_schema(&c, 12).unwrap();
            let main = fs::read(root.join(DATABASE_FILE)).unwrap();
            let wal_bytes = fs::read(root.join("library.sqlite-wal")).ok();
            let data = originals(&c, 11, true);
            let schema = rows(
                &c,
                "SELECT type,name,sql FROM sqlite_master ORDER BY type,name",
            );
            let changes = c.total_changes();
            assert_eq!(verify_sqlite(&c), Err(BackupError::Corrupt));
            assert_eq!(
                backup_before_history_upgrade(root, &c, wal),
                Err(BackupError::Corrupt)
            );
            assert_eq!(crate::store::migrate(&c), Err(StoreError::InvalidDocument));
            assert_eq!(
                crate::store::configure_and_migrate(&c),
                Err(StoreError::InvalidDocument)
            );
            assert_eq!(
                LocalLibrary::open(root).err(),
                Some(StoreError::UpgradeBackup(BackupError::Corrupt))
            );
            assert_eq!(c.total_changes(), changes);
            assert_eq!(originals(&c, 11, true), data);
            assert_eq!(
                rows(
                    &c,
                    "SELECT type,name,sql FROM sqlite_master ORDER BY type,name"
                ),
                schema
            );
            assert_eq!(fs::read(root.join(DATABASE_FILE)).unwrap(), main);
            assert_eq!(fs::read(root.join("library.sqlite-wal")).ok(), wal_bytes);
            assert!(!root.join(BACKUPS_DIRECTORY).exists());
        }
    }
}

fn seed_upgrade_tea(library: &LocalLibrary) {
    library
        .tea()
        .mutate(serde_json::json!({
            "version": 1,
            "request": {
                "action": "import", "operationId": "tea-upgrade-import",
                "entries": [{
                    "session": {
                        "id": "tea-upgrade", "title": "迁移前茶会", "createdAt": 1, "updatedAt": 1,
                        "roles": [], "settings": {"providerId": "custom", "modelId": "test"},
                        "draft": "保留草稿", "extension": {"opaque": [true, "原文"]}
                    },
                    "messages": [{
                        "id": "tea-message", "sessionId": "tea-upgrade", "role": "assistant",
                        "content": "备份中的茶会正文 🍵", "createdAt": 1, "status": "done"
                    }]
                }]
            }
        }))
        .unwrap();
}

fn tea_rows(c: &Connection) -> Vec<Vec<Vec<Value>>> {
    [
        "SELECT * FROM magic_tea_session ORDER BY id",
        "SELECT * FROM magic_tea_message ORDER BY id",
        "SELECT * FROM magic_tea_receipt ORDER BY operation_id",
        "SELECT * FROM magic_tea_catalog ORDER BY singleton",
    ]
    .iter()
    .map(|sql| rows(c, sql))
    .collect()
}

#[test]
fn candidate12_failure_rolls_back_to_nonempty_tea11_with_verified_prebackup() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let _instance = InstanceGuard::acquire(root).unwrap();
    let previous = install_historical(root, 10);
    let tea = LocalLibrary::open(root).unwrap();
    seed_upgrade_tea(&tea);
    drop(tea);
    let tea_backup = added_backup(root, &[previous]);
    assert_eq!(
        verify_sqlite(
            &open_immutable_database(&Path::new(&tea_backup.absolute_path).join(DATABASE_FILE))
                .unwrap()
        ),
        Ok(10)
    );
    let c = Connection::open(root.join(DATABASE_FILE)).unwrap();
    c.execute_batch("CREATE TRIGGER migration_journal_fault BEFORE INSERT ON schema_migration WHEN NEW.version=12 BEGIN SELECT RAISE(ABORT,'candidate failure'); END;").unwrap();
    let data = originals(&c, 11, true);
    let expected_tea = tea_rows(&c);
    let schema = rows(
        &c,
        "SELECT type,name,sql FROM sqlite_master ORDER BY type,name",
    );
    let before = backup_ids(root);
    assert_eq!(
        with_history_schema_for_test(|| LocalLibrary::open(root).err()),
        Some(StoreError::Failure)
    );
    assert!(c.is_autocommit());
    assert_eq!(verify_sqlite(&c), Ok(11));
    assert_eq!(originals(&c, 11, true), data);
    assert_eq!(tea_rows(&c), expected_tea);
    assert_eq!(
        rows(
            &c,
            "SELECT type,name,sql FROM sqlite_master ORDER BY type,name"
        ),
        schema
    );
    let prebackup = added_backup(root, &before);
    let snapshot =
        open_immutable_database(&Path::new(&prebackup.absolute_path).join(DATABASE_FILE)).unwrap();
    assert_eq!(verify_sqlite(&snapshot), Ok(11));
    assert_eq!(tea_rows(&snapshot), expected_tea);
    assert_eq!(originals(&snapshot, 11, true), data);
    drop(snapshot);
    c.execute_batch("DROP TRIGGER migration_journal_fault")
        .unwrap();
    drop(c);
    let before = backup_ids(root);
    with_history_schema_for_test(|| {
        let live = LocalLibrary::open(root).unwrap();
        let c = live.connection().lock().unwrap();
        assert_eq!(verify_sqlite(&c), Ok(12));
        assert_eq!(tea_rows(&c), expected_tea);
    });
    let retry_backup = added_backup(root, &before);
    let snapshot =
        open_immutable_database(&Path::new(&retry_backup.absolute_path).join(DATABASE_FILE))
            .unwrap();
    assert_eq!(verify_sqlite(&snapshot), Ok(11));
    assert_eq!(tea_rows(&snapshot), expected_tea);
    drop(snapshot);
    let before = backup_ids(root);
    with_history_schema_for_test(|| drop(LocalLibrary::open(root).unwrap()));
    assert_eq!(backup_ids(root), before);
    assert_eq!(
        LocalLibrary::open(root).err(),
        Some(StoreError::Unavailable)
    );
}

#[test]
fn nonempty_tea11_candidate_prebackup_failure_leaves_db_wal_and_pending_untouched() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let _instance = InstanceGuard::acquire(root).unwrap();
    let library = LocalLibrary::open(root).unwrap();
    seed_upgrade_tea(&library);
    drop(library);
    let c = Connection::open(root.join(DATABASE_FILE)).unwrap();
    c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0")
        .unwrap();
    pending::seed_historical_backup(&c, 11, true);
    c.execute(
        "INSERT INTO provider_profile VALUES ('wal-only',?1,?2)",
        params![PROFILE, WHEN],
    )
    .unwrap();
    fs::write(root.join(BACKUPS_DIRECTORY), b"retained candidate blocker").unwrap();
    let main = fs::read(root.join(DATABASE_FILE)).unwrap();
    let wal = fs::read(root.join("library.sqlite-wal")).unwrap();
    let expected = originals(&c, 11, true);
    let expected_tea = tea_rows(&c);
    assert!(matches!(
        with_history_schema_for_test(|| LocalLibrary::open(root).err()),
        Some(StoreError::UpgradeBackup(_))
    ));
    assert_eq!(verify_sqlite(&c), Ok(11));
    assert_eq!(originals(&c, 11, true), expected);
    assert_eq!(tea_rows(&c), expected_tea);
    assert_eq!(fs::read(root.join(DATABASE_FILE)).unwrap(), main);
    assert_eq!(fs::read(root.join("library.sqlite-wal")).unwrap(), wal);
    assert_upgrade_pending(&c, 11, false);
    assert_eq!(
        fs::read(root.join(BACKUPS_DIRECTORY)).unwrap(),
        b"retained candidate blocker"
    );
}
