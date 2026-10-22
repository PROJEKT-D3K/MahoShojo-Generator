use super::*;
use crate::library::LocalLibrary;
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/local-image-assets.json"
    ))
    .unwrap()
}
fn fixture_request() -> SaveRequest {
    let f = fixture();
    serde_json::from_value(json!({"title":f["asset"]["title"],"payload":f["payload"]})).unwrap()
}
fn bytes_request(bytes: &[u8]) -> SaveRequest {
    SaveRequest {
        title: "test".into(),
        payload: Payload {
            encoding: "base64".into(),
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
            byte_length: bytes.len(),
        },
    }
}
fn setup() -> (tempfile::TempDir, LocalLibrary) {
    let root = tempfile::tempdir().unwrap();
    let lib = LocalLibrary::open(root.path()).unwrap();
    (root, lib)
}
fn list(view: &str) -> ListRequest {
    ListRequest {
        view: view.into(),
        limit: 100,
        cursor: None,
    }
}

#[test]
fn shared_fixture_native_save_reopen_export_and_idempotency() {
    let (root, lib) = setup();
    let first = lib.images().save(lib.blobs(), fixture_request()).unwrap();
    assert_eq!(first.outcome, "stored");
    let mut value = serde_json::to_value(&first.asset).unwrap();
    value["createdAt"] = fixture()["asset"]["createdAt"].clone();
    assert_eq!(value, fixture()["asset"]);
    let bytes = lib.images().read(root.path(), &first.asset.id).unwrap().1;
    let mut repeat = bytes_request(&bytes);
    repeat.title = "new name".into();
    let repeated = lib.images().save(lib.blobs(), repeat).unwrap();
    assert_eq!(repeated.asset, first.asset);
    assert_eq!(repeated.outcome, "already-present");
    let output = lib.images().export(root.path(), &first.asset.id).unwrap();
    let output2 = lib.images().export(root.path(), &first.asset.id).unwrap();
    assert_ne!(output.absolute_path, output2.absolute_path);
    assert_eq!(std::fs::read(output.absolute_path).unwrap(), bytes);
    assert_eq!(
        lib.images().list(list("active")).unwrap().items,
        vec![first.asset.clone()]
    );
    drop(lib);
    let reopened = LocalLibrary::open(root.path()).unwrap();
    assert_eq!(
        reopened
            .images()
            .read(root.path(), &first.asset.id)
            .unwrap(),
        (first.asset, bytes)
    );
}

#[test]
fn supported_formats_require_actual_decode_and_original_bytes_survive() {
    let (root, lib) = setup();
    for (format, mime) in [
        (ImageFormat::Png, "image/png"),
        (ImageFormat::Jpeg, "image/jpeg"),
        (ImageFormat::WebP, "image/webp"),
    ] {
        let mut out = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(4, 5)
            .write_to(&mut out, format)
            .unwrap();
        let bytes = out.into_inner();
        let result = lib
            .images()
            .save(lib.blobs(), bytes_request(&bytes))
            .unwrap();
        assert_eq!(
            (
                result.asset.mime_type.as_str(),
                result.asset.width,
                result.asset.height
            ),
            (mime, 4, 5)
        );
        assert_eq!(
            lib.images().read(root.path(), &result.asset.id).unwrap().1,
            bytes
        );
    }
}

#[test]
fn rejects_disguised_animated_truncated_and_oversized_media() {
    assert_eq!(decode(b"<svg/>"), Err(ImageError::Unsupported));
    assert_eq!(decode(b"GIF89a"), Err(ImageError::Unsupported));
    assert_eq!(decode(&[]), Err(ImageError::Invalid));
    assert_eq!(decode(&vec![0; MAX_BYTES + 1]), Err(ImageError::TooLarge));
    assert!(dimensions(MAX_EDGE, MAX_EDGE).is_err());
    assert!(dimensions(MAX_EDGE + 1, 1).is_err());
    assert!(dimensions(4096, 4096).is_ok());
    assert!(dimensions(4096, 4097).is_err());
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(fixture()["payload"]["data"].as_str().unwrap())
        .unwrap();
    for length in [8, 33, bytes.len() - 1] {
        assert!(decode(&bytes[..length]).is_err());
    }
    let mut fake = bytes.clone();
    fake[42] ^= 0xff;
    assert_eq!(decode(&fake), Err(ImageError::Decode));
    let mut trailing = bytes.clone();
    trailing.push(0);
    assert_eq!(decode(&trailing), Err(ImageError::Decode));
    let mut nonempty_end = bytes.clone();
    let end = nonempty_end.len() - 12;
    nonempty_end[end + 3] = 1;
    nonempty_end.insert(end + 8, 0);
    assert_eq!(decode(&nonempty_end), Err(ImageError::Decode));
    let mut animated = bytes.clone();
    animated.splice(33..33, [0, 0, 0, 0, b'a', b'c', b'T', b'L', 0, 0, 0, 0]);
    assert_eq!(decode(&animated), Err(ImageError::Unsupported));
    let animated_webp = b"RIFF\x16\0\0\0WEBPVP8X\x0a\0\0\0\x02\0\0\0\x01\0\0\x01\0\0";
    assert_eq!(decode(animated_webp), Err(ImageError::Unsupported));
    let (root, lib) = setup();
    let mut request = fixture_request();
    request.payload.byte_length += 1;
    assert_eq!(
        lib.images().save(lib.blobs(), request).unwrap_err(),
        ImageError::Invalid
    );
    let mut request = fixture_request();
    request.title = "bad\nname".into();
    assert_eq!(
        lib.images().save(lib.blobs(), request).unwrap_err(),
        ImageError::Invalid
    );
    assert!(lib.images().list(list("active")).unwrap().items.is_empty());
    drop(root);
}

#[test]
fn soft_delete_repeat_does_not_restore_and_purge_defers_to_gc() {
    let (root, lib) = setup();
    let asset = lib
        .images()
        .save(lib.blobs(), fixture_request())
        .unwrap()
        .asset;
    assert_eq!(lib.images().purge(&asset.id), Err(ImageError::NotDeleted));
    lib.images().transition(&asset.id, false).unwrap();
    lib.images().transition(&asset.id, false).unwrap();
    let repeated = lib.images().save(lib.blobs(), fixture_request()).unwrap();
    assert!(repeated.asset.deleted_at.is_some());
    assert!(lib.images().list(list("active")).unwrap().items.is_empty());
    assert_eq!(lib.images().list(list("trash")).unwrap().items.len(), 1);
    let paths = blob::BlobPaths::under(root.path());
    assert_eq!(
        crate::gc::collect(&paths, lib.connection())
            .unwrap()
            .reclaimed,
        0
    );
    lib.images().transition(&asset.id, true).unwrap();
    lib.images().transition(&asset.id, true).unwrap();
    assert_eq!(lib.images().list(list("active")).unwrap().items.len(), 1);
    lib.images().transition(&asset.id, false).unwrap();
    lib.images().purge(&asset.id).unwrap();
    lib.images().purge(&asset.id).unwrap();
    assert!(blob::blob_path(&paths, &asset.digest).unwrap().exists());
    assert_eq!(
        crate::gc::collect(&paths, lib.connection())
            .unwrap()
            .reclaimed,
        1
    );
    assert_eq!(
        lib.images().read(root.path(), &asset.id).unwrap_err(),
        ImageError::NotFound
    );
}

#[test]
fn corrupt_blob_fails_closed_correct_upload_repairs_and_metadata_stays() {
    let (root, lib) = setup();
    let asset = lib
        .images()
        .save(lib.blobs(), fixture_request())
        .unwrap()
        .asset;
    let path = blob::blob_path(&blob::BlobPaths::under(root.path()), &asset.digest).unwrap();
    std::fs::write(&path, b"damaged").unwrap();
    assert_eq!(
        lib.images().read(root.path(), &asset.id).unwrap_err(),
        ImageError::Corrupt
    );
    assert_eq!(
        lib.images().export(root.path(), &asset.id).unwrap_err(),
        ImageError::Corrupt
    );
    let report = crate::audit::audit(
        lib.blobs(),
        &blob::BlobPaths::under(root.path()),
        lib.connection(),
    )
    .unwrap();
    assert_eq!(report.image_asset_count, 1);
    assert_eq!(report.count_of("image-reference-bytes-mismatch"), 1);
    assert!(crate::backup::create_backup(&lib).is_err());
    let repaired = lib.images().save(lib.blobs(), fixture_request()).unwrap();
    assert_eq!(repaired.outcome, "repaired");
    assert_eq!(repaired.asset, asset);
    std::fs::remove_file(path).unwrap();
    assert_eq!(
        lib.images()
            .save(lib.blobs(), fixture_request())
            .unwrap()
            .outcome,
        "repaired"
    );
}

#[test]
fn record_failure_only_leaves_unreferenced_blob_and_decoder_is_single_flight() {
    let (root, lib) = setup();
    {
        let _decode = lib.images().decode_gate.lock().unwrap();
        assert_eq!(
            lib.images()
                .save(lib.blobs(), fixture_request())
                .unwrap_err(),
            ImageError::Unavailable
        );
    }
    lock_connection(lib.connection()).unwrap().execute_batch("CREATE TRIGGER fail_image BEFORE INSERT ON local_image_asset BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
    assert!(lib.images().save(lib.blobs(), fixture_request()).is_err());
    assert!(lib.images().list(list("active")).unwrap().items.is_empty());
    let report = crate::audit::audit(
        lib.blobs(),
        &blob::BlobPaths::under(root.path()),
        lib.connection(),
    )
    .unwrap();
    assert_eq!(report.count_of("unreferenced-metadata"), 1);
    lock_connection(lib.connection())
        .unwrap()
        .execute_batch("DROP TRIGGER fail_image")
        .unwrap();
    assert_eq!(
        lib.images()
            .save(lib.blobs(), fixture_request())
            .unwrap()
            .outcome,
        "stored"
    );
}

#[test]
fn dual_consumer_gc_keeps_shared_bytes_until_both_are_purged() {
    let (root, lib) = setup();
    let asset = lib
        .images()
        .save(lib.blobs(), fixture_request())
        .unwrap()
        .asset;
    let bytes = lib.images().read(root.path(), &asset.id).unwrap().1;
    let md = blob::digest_of(b"package manifest");
    let doc=json!({"id":"package","contentDigest":md,"updatedAt":"2026-10-22T00:00:00Z","archiveByteLength":bytes.len()}).to_string();
    lib.packages()
        .save(
            lib.blobs(),
            &doc,
            &crate::web_package::WebPackageIndex {
                id: "package".into(),
                updated_at: "2026-10-22T00:00:00Z".into(),
                deleted_at: None,
                content_digest: md,
            },
            &bytes,
            "2026-10-22T00:00:00Z",
        )
        .unwrap();
    lib.images().transition(&asset.id, false).unwrap();
    lib.images().purge(&asset.id).unwrap();
    let paths = blob::BlobPaths::under(root.path());
    assert_eq!(
        crate::gc::collect(&paths, lib.connection())
            .unwrap()
            .reclaimed,
        0
    );
    lock_connection(lib.connection())
        .unwrap()
        .execute("DELETE FROM local_web_package WHERE id='package'", [])
        .unwrap();
    assert_eq!(
        crate::gc::collect(&paths, lib.connection())
            .unwrap()
            .reclaimed,
        1
    );
}

#[test]
fn backup_restores_active_and_trash_images_through_startup_generation_swap() {
    let (root, lib) = setup();
    let asset = lib
        .images()
        .save(lib.blobs(), fixture_request())
        .unwrap()
        .asset;
    lib.images().transition(&asset.id, false).unwrap();
    let backup = crate::backup::create_backup(&lib).unwrap();
    crate::backup::verify_backup(root.path(), &backup.backup_id).unwrap();
    lib.images().purge(&asset.id).unwrap();
    crate::gc::collect(&blob::BlobPaths::under(root.path()), lib.connection()).unwrap();
    let prepared = crate::restore::prepare_restore(&lib, &backup.backup_id).unwrap();
    drop(prepared);
    drop(lib);
    crate::restore::recover_pending(root.path()).unwrap();
    let restored = LocalLibrary::open(root.path()).unwrap();
    assert_eq!(
        restored.images().list(list("trash")).unwrap().items.len(),
        1
    );
    assert_eq!(
        restored
            .images()
            .read(root.path(), &asset.id)
            .unwrap()
            .1
            .len(),
        asset.byte_length as usize
    );
}

#[test]
fn every_old_schema_migrates_to_images_without_enabling_candidate_and_shape_cannot_masquerade() {
    for version in 1..=11 {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        crate::store::migrate_to_version_for_test(&c, version);
        crate::backup::verify_sqlite(&c).unwrap();
        crate::store::migrate(&c).unwrap();
        assert_eq!(crate::backup::verify_sqlite(&c).unwrap(), 12);
        verify_schema(&c, 12).unwrap();
        assert!(!crate::arena_story::branch::history::enabled(&c).unwrap());
    }
    let c = Connection::open_in_memory().unwrap();
    crate::store::migrate_to_version_for_test(&c, 12);
    c.execute_batch("DROP INDEX image_asset_blob_ref_by_digest")
        .unwrap();
    assert!(crate::store::migrate(&c).is_err());
    let c = Connection::open_in_memory().unwrap();
    crate::store::migrate_to_version_for_test(&c, 11);
    c.execute_batch("PRAGMA user_version=12;INSERT INTO schema_migration VALUES(12,'test')")
        .unwrap();
    assert!(crate::store::migrate(&c).is_err());
    c.execute_batch("PRAGMA user_version=13").unwrap();
    assert!(crate::store::migrate(&c).is_err());
}

#[test]
fn missing_ref_and_mismatched_metadata_are_diagnosed_and_rejected_by_backup() {
    let (root, lib) = setup();
    let asset = lib
        .images()
        .save(lib.blobs(), fixture_request())
        .unwrap()
        .asset;
    lock_connection(lib.connection())
        .unwrap()
        .execute(
            "DELETE FROM image_asset_blob_ref WHERE image_id=?1",
            [&asset.id],
        )
        .unwrap();
    let report = crate::audit::audit(
        lib.blobs(),
        &blob::BlobPaths::under(root.path()),
        lib.connection(),
    )
    .unwrap();
    assert_eq!(report.count_of("image-record-without-reference"), 1);
    assert!(crate::backup::create_backup(&lib).is_err());
    assert_eq!(
        lib.images().read(root.path(), &asset.id).unwrap_err(),
        ImageError::Corrupt
    );
}

#[test]
fn pagination_uses_exclusive_stable_id_cursor_and_rejects_invalid_input() {
    let (_, lib) = setup();
    for width in 1..=3 {
        let mut out = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(width, 1)
            .write_to(&mut out, ImageFormat::Png)
            .unwrap();
        lib.images()
            .save(lib.blobs(), bytes_request(out.get_ref()))
            .unwrap();
    }
    let first = lib
        .images()
        .list(ListRequest {
            view: "active".into(),
            limit: 2,
            cursor: None,
        })
        .unwrap();
    let second = lib
        .images()
        .list(ListRequest {
            view: "active".into(),
            limit: 2,
            cursor: first.next_cursor,
        })
        .unwrap();
    assert_eq!(first.items.len(), 2);
    assert_eq!(second.items.len(), 1);
    assert!(first.items[1].id < second.items[0].id);
    assert!(second.next_cursor.is_none());
    assert!(lib
        .images()
        .list(ListRequest {
            view: "active".into(),
            limit: 0,
            cursor: None
        })
        .is_err());
    assert!(lib
        .images()
        .list(ListRequest {
            view: "active".into(),
            limit: 1,
            cursor: Some("../path".into())
        })
        .is_err());
}

#[test]
fn malformed_record_and_reference_only_emit_safe_invalid_finding() {
    for bad_id in [Some("broken"), Some(""), None] {
        let (root, lib) = setup();
        let asset = lib
            .images()
            .save(lib.blobs(), fixture_request())
            .unwrap()
            .asset;
        let c = lock_connection(lib.connection()).unwrap();
        c.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
        if let Some(bad_id) = bad_id {
            c.execute(
                "UPDATE local_image_asset SET id=?1 WHERE id=?2",
                [bad_id, &asset.id],
            )
            .unwrap();
        } else {
            c.execute(
                "UPDATE image_asset_blob_ref SET digest='not-a-digest' WHERE image_id=?1",
                [&asset.id],
            )
            .unwrap();
        }
        c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        drop(c);
        let report = crate::audit::audit(
            lib.blobs(),
            &blob::BlobPaths::under(root.path()),
            lib.connection(),
        )
        .unwrap();
        assert_eq!(report.count_of("image-record-invalid"), 1);
        assert_eq!(report.count_of("image-reference-file-missing"), 0);
        assert_eq!(report.count_of("image-reference-bytes-mismatch"), 0);
        assert_eq!(report.count_of("image-record-without-reference"), 0);
    }
}

#[test]
fn valid_but_wrong_dimensions_fail_read_audit_and_backup() {
    let (root, lib) = setup();
    let asset = lib
        .images()
        .save(lib.blobs(), fixture_request())
        .unwrap()
        .asset;
    lock_connection(lib.connection())
        .unwrap()
        .execute(
            "UPDATE local_image_asset SET width=width+1 WHERE id=?1",
            [&asset.id],
        )
        .unwrap();
    assert_eq!(
        lib.images().read(root.path(), &asset.id).unwrap_err(),
        ImageError::Corrupt
    );
    let report = crate::audit::audit(
        lib.blobs(),
        &blob::BlobPaths::under(root.path()),
        lib.connection(),
    )
    .unwrap();
    assert_eq!(report.count_of("image-record-invalid"), 1);
    assert!(crate::backup::create_backup(&lib).is_err());
    // Enumeration stays metadata-only; selecting the image surfaces its integrity error.
    assert_eq!(lib.images().list(list("active")).unwrap().items.len(), 1);
}
