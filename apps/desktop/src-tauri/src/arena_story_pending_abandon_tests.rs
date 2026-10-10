use super::*;

fn request(m: &PendingManifest) -> AbandonRequest {
    AbandonRequest {
        key: m.key(),
        input_digest: m.input_digest.clone(),
        actor: m.actor.clone(),
    }
}
#[test]
fn durable_abandon_fences_every_write_and_keeps_originals_until_final_delete() {
    let (_root, lib) = fixture();
    let store = lib.stories();
    let (manifest, parts) = candidate(Product::Battle, false);
    let token = upload(store, &manifest, &parts);
    store.pending_seal(&token).unwrap();
    let mut next = manifest.clone();
    next.pending_revision += 1;
    let upload_token = upload(store, &next, &parts);
    let mut another = manifest.clone();
    another.product = Product::Arena;
    let another_token = upload(store, &another, &parts);
    store.pending_seal(&another_token).unwrap();
    {
        let guard = store.pending_admission(manifest.product).unwrap();
        let begun = store
            .pending_begin_abandon(&guard, &request(&manifest))
            .unwrap();
        assert!(begun.abandon_requested);
        assert_eq!(
            store
                .pending_begin_abandon(&guard, &request(&manifest))
                .unwrap(),
            begun
        );
    }
    assert!(store.pending_seal(&token).is_err());
    assert!(store.pending_seal(&upload_token).is_err());
    assert!(store.pending_begin(next).is_err());
    assert!(store
        .pending_append(&upload_token, PendingKind::Input, 0, parts[0].1.as_bytes())
        .is_err());
    assert_eq!(
        store
            .pending_read(&manifest.key(), PendingKind::Markdown, 0, 64)
            .unwrap(),
        parts[1].1.as_bytes()
    );
    assert!(store.pending_describe(Product::Arena).unwrap().is_some());
    {
        let guard = store.pending_admission(manifest.product).unwrap();
        store
            .pending_finish_abandon(&guard, &request(&manifest))
            .unwrap();
    }
    assert!(store.pending_describe(Product::Battle).unwrap().is_none());
    assert!(store.pending_upload(&upload_token).is_err());
    assert!(store.pending_seal(&upload_token).is_err());
    assert!(store
        .pending_inputs
        .lock()
        .unwrap()
        .keys()
        .all(|(t, _)| t != &upload_token));
    assert!(store.pending_describe(Product::Arena).unwrap().is_some());
}

#[test]
fn abandon_unknown_save_never_mutates_committed_receipt_or_issues_new_attempt() {
    let (_root, lib) = fixture();
    let store = lib.stories();
    // Commit one independent, known story; later abandoning a candidate must not
    // touch any chapter, checkpoint or receipt from it.
    let (saved_key, saved_digest) = frozen(store);
    let saved_attempt = store
        .pending_prepare_save(&saved_key, &saved_digest)
        .unwrap();
    let receipt = store
        .pending_save(&saved_key, &saved_digest, &saved_attempt.attempt_id)
        .unwrap();
    let (manifest, parts) = candidate(Product::Arena, true);
    let token = upload(store, &manifest, &parts);
    store.pending_seal(&token).unwrap();
    let digest = manifest
        .commit_manifest
        .as_ref()
        .unwrap()
        .wire_digest()
        .unwrap();
    let attempt = store
        .pending_prepare_save(&manifest.key(), &digest)
        .unwrap();
    {
        let guard = store.pending_admission(manifest.product).unwrap();
        store
            .pending_begin_abandon(&guard, &request(&manifest))
            .unwrap();
    }
    assert!(store
        .pending_prepare_save(&manifest.key(), &digest)
        .is_err());
    assert!(store
        .pending_save(&manifest.key(), &digest, &attempt.attempt_id)
        .is_err());
    {
        let guard = store.pending_admission(manifest.product).unwrap();
        store
            .pending_finish_abandon(&guard, &request(&manifest))
            .unwrap();
    }
    assert!(store
        .pending_prepare_save(&manifest.key(), &digest)
        .is_err());
    let connection = lock_connection(&store.connection).unwrap();
    assert_eq!(
        read_receipt(&connection, &receipt.session_id, &receipt.operation_id).unwrap(),
        Some(receipt)
    );
    let chapters: u64 = connection
        .query_row("SELECT count(*) FROM arena_story_chapter", [], |r| r.get(0))
        .unwrap();
    assert_eq!(chapters, 1);
}

#[test]
fn restored_schema8_backup_keeps_cleanup_intent_and_original_actor_fence() {
    let (root, lib) = fixture();
    let (manifest, parts) = unstarted(Product::Battle);
    let token = upload(lib.stories(), &manifest, &parts);
    lib.stories().pending_seal(&token).unwrap();
    {
        let guard = lib.stories().pending_admission(manifest.product).unwrap();
        lib.stories()
            .pending_begin_abandon(&guard, &request(&manifest))
            .unwrap();
    }
    let backup = crate::backup::create_backup(&lib).unwrap();
    let prepared = crate::restore::prepare_restore(&lib, &backup.backup_id).unwrap();
    drop(prepared);
    drop(lib);
    run_boundary_child(root.path(), "restore");
    let lib = LocalLibrary::open(root.path()).unwrap();
    let snapshot = lib
        .stories()
        .pending_describe(manifest.product)
        .unwrap()
        .unwrap();
    assert!(snapshot.restored && snapshot.abandon_requested);
    assert_eq!(snapshot.manifest, manifest);
    assert_eq!(
        lib.stories()
            .pending_read(&manifest.key(), PendingKind::Input, 0, 64)
            .unwrap(),
        parts[0].1.as_bytes()[..64]
    );
    let guard = lib.stories().pending_admission(manifest.product).unwrap();
    let mut wrong = request(&manifest);
    wrong.actor = Actor::Account {
        expected_user_id: 999,
    };
    assert!(lib.stories().pending_begin_abandon(&guard, &wrong).is_err());
    assert!(lib
        .stories()
        .pending_finish_abandon(&guard, &wrong)
        .is_err());
    lib.stories()
        .pending_finish_abandon(&guard, &request(&manifest))
        .unwrap();
}

#[test]
fn abandon_commit_ack_loss_clears_original_upload_buffers_and_attempts_before_success() {
    let (_root, lib) = fixture();
    let store = lib.stories();
    let (manifest, parts) = candidate(Product::Battle, false);
    let token = upload(store, &manifest, &parts);
    store.pending_seal(&token).unwrap();
    let mut next = manifest.clone();
    next.pending_revision += 1;
    let upload_token = store.pending_begin(next).unwrap().token;
    store
        .pending_append(
            &upload_token,
            PendingKind::Input,
            0,
            &parts[0].1.as_bytes()[..32],
        )
        .unwrap();
    assert!(store
        .pending_inputs
        .lock()
        .unwrap()
        .contains_key(&(upload_token.clone(), PendingKind::Input)));
    // Exact in-memory attempt cleanup is independently checked; authority is
    // still only the durable row and this cannot manufacture a valid save.
    store
        .pending_attempts
        .lock()
        .unwrap()
        .insert("synthetic-attempt".into(), token.clone());
    let guard = store.pending_admission(manifest.product).unwrap();
    store
        .pending_begin_abandon(&guard, &request(&manifest))
        .unwrap();
    store
        .pending_finish_abandon_with_hook(&guard, &request(&manifest), &mut |point| {
            if point == "after-commit" {
                Err(StoryError::CommitUnknown)
            } else {
                Ok(())
            }
        })
        .unwrap();
    assert!(store.pending_describe_admitted(&guard).unwrap().is_none());
    assert!(store.pending_upload(&upload_token).is_err());
    assert!(store
        .pending_inputs
        .lock()
        .unwrap()
        .keys()
        .all(|(t, _)| t != &upload_token));
    assert!(store
        .pending_attempts
        .lock()
        .unwrap()
        .values()
        .all(|t| t != &token));
}

#[test]
fn abandon_precommit_failure_retains_durable_identity_and_all_original_buffers() {
    let (_root, lib) = fixture();
    let store = lib.stories();
    let (manifest, parts) = candidate(Product::Battle, false);
    let token = upload(store, &manifest, &parts);
    store.pending_seal(&token).unwrap();
    let mut next = manifest.clone();
    next.pending_revision += 1;
    let upload_token = store.pending_begin(next).unwrap().token;
    store
        .pending_append(
            &upload_token,
            PendingKind::Input,
            0,
            &parts[0].1.as_bytes()[..32],
        )
        .unwrap();
    let guard = store.pending_admission(manifest.product).unwrap();
    store
        .pending_begin_abandon(&guard, &request(&manifest))
        .unwrap();
    assert!(store
        .pending_finish_abandon_with_hook(&guard, &request(&manifest), &mut |point| {
            if point == "before-commit" {
                Err(StoryError::Io)
            } else {
                Ok(())
            }
        })
        .is_err());
    assert!(
        store
            .pending_describe_admitted(&guard)
            .unwrap()
            .unwrap()
            .abandon_requested
    );
    assert!(store.pending_upload(&upload_token).is_ok());
    assert!(store
        .pending_inputs
        .lock()
        .unwrap()
        .contains_key(&(upload_token.clone(), PendingKind::Input)));
    store
        .pending_finish_abandon(&guard, &request(&manifest))
        .unwrap();
}
