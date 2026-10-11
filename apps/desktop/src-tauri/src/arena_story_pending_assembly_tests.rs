use super::*;

fn local_plan() -> LocalChapterPlan {
    LocalChapterPlan {
        total_chapters: 7,
        source: LocalChapterPlanSource::Scenario,
        locked: true,
    }
}
fn assembly(plan: Option<LocalChapterPlan>) -> LocalAssembly {
    LocalAssembly {
        version: 1,
        chapter_plan: plan,
    }
}
fn planned_candidate(frozen: bool) -> (PendingManifest, Vec<(PendingKind, String)>) {
    let (mut manifest, mut parts) = candidate(Product::Battle, frozen);
    manifest.local_assembly = Some(assembly(Some(local_plan())));
    let mut input: serde_json::Value = serde_json::from_str(&parts[0].1).unwrap();
    input["chapterPlan"] = json!({"totalChapters":7});
    parts[0].1 = input.to_string();
    if let Some((_, raw)) = parts
        .iter_mut()
        .find(|(kind, _)| *kind == PendingKind::Session)
    {
        let mut session: serde_json::Value = serde_json::from_str(raw).unwrap();
        session["chapterPlan"] = serde_json::to_value(local_plan()).unwrap();
        *raw = session.to_string();
    }
    refresh(&mut manifest, &parts);
    (manifest, parts)
}

#[test]
fn local_assembly_missing_null_and_value_round_trip_without_changing_schema_or_parts() {
    let (legacy, _) = candidate(Product::Battle, false);
    let wire = serde_json::to_value(&legacy).unwrap();
    assert!(wire.get("localAssembly").is_none());
    assert_eq!(
        serde_json::from_value::<PendingManifest>(wire.clone()).unwrap(),
        legacy
    );
    for plan in [
        None,
        Some(local_plan()),
        Some(LocalChapterPlan {
            total_chapters: 1,
            source: LocalChapterPlanSource::User,
            locked: false,
        }),
        Some(LocalChapterPlan {
            total_chapters: 20,
            ..local_plan()
        }),
    ] {
        let mut current = legacy.clone();
        current.local_assembly = Some(assembly(plan));
        let value = serde_json::to_value(&current).unwrap();
        assert_eq!(value["version"], 1);
        assert!(value["localAssembly"].get("chapterPlan").is_some());
        assert_eq!(
            serde_json::from_value::<PendingManifest>(value).unwrap(),
            current
        );
        assert_eq!(current.parts, legacy.parts);
        current.validate().unwrap();
    }
    for extension in [
        json!(null),
        json!(false),
        json!("plan"),
        json!([]),
        json!([1, null]),
        json!({}),
        json!({"version":1}),
        json!({"version":2,"chapterPlan":null}),
        json!({"version":"1","chapterPlan":null}),
        json!({"version":1,"chapterPlan":false}),
        json!({"version":1,"chapterPlan":[7,"scenario",true]}),
        json!({"version":1,"chapterPlan":{"totalChapters":0,"source":"user","locked":false}}),
        json!({"version":1,"chapterPlan":{"totalChapters":21,"source":"user","locked":false}}),
        json!({"version":1,"chapterPlan":{"totalChapters":1.5,"source":"user","locked":false}}),
        json!({"version":1,"chapterPlan":{"totalChapters":"7","source":"user","locked":false}}),
        json!({"version":1,"chapterPlan":{"totalChapters":7,"source":"inferred","locked":false}}),
        json!({"version":1,"chapterPlan":{"totalChapters":7,"source":"user","locked":1}}),
        json!({"version":1,"chapterPlan":{"totalChapters":7,"source":"user","locked":false,"extra":true}}),
        json!({"version":1,"chapterPlan":null,"snapshot":{}}),
    ] {
        let mut value = wire.clone();
        value["localAssembly"] = extension.clone();
        assert!(
            serde_json::from_value::<PendingManifest>(value).is_err(),
            "{extension}"
        );
    }
    for extension in [
        LocalAssembly {
            version: 2,
            chapter_plan: None,
        },
        assembly(Some(LocalChapterPlan {
            total_chapters: 21,
            ..local_plan()
        })),
    ] {
        let mut current = legacy.clone();
        current.local_assembly = Some(extension);
        assert_eq!(current.validate(), Err(StoryError::Invalid));
    }
}

#[test]
fn local_assembly_revision_replacement_never_backfills_or_changes_intent() {
    let (legacy, _) = candidate(Product::Battle, false);
    let intents = [
        None,
        Some(assembly(None)),
        Some(assembly(Some(local_plan()))),
    ];
    for old_intent in &intents {
        let mut old = PendingSnapshot {
            manifest: legacy.clone(),
            save_attempt_id: None,
            restored: false,
            abandon_requested: false,
            create_claim: None,
        };
        old.manifest.local_assembly = old_intent.clone();
        for next_intent in &intents {
            let mut next = old.manifest.clone();
            next.pending_revision += 1;
            next.local_assembly = next_intent.clone();
            assert_eq!(
                compatible(&old, &next),
                if old_intent == next_intent {
                    Ok(())
                } else {
                    Err(StoryError::Conflict)
                }
            );
        }
    }
    let mut old = PendingSnapshot {
        manifest: planned_candidate(false).0,
        save_attempt_id: None,
        restored: false,
        abandon_requested: false,
        create_claim: None,
    };
    for plan in [
        LocalChapterPlan {
            total_chapters: 8,
            ..local_plan()
        },
        LocalChapterPlan {
            source: LocalChapterPlanSource::User,
            ..local_plan()
        },
        LocalChapterPlan {
            locked: false,
            ..local_plan()
        },
    ] {
        let mut next = old.manifest.clone();
        next.pending_revision += 1;
        next.local_assembly = Some(assembly(Some(plan)));
        assert_eq!(compatible(&old, &next), Err(StoryError::Conflict));
    }
    // The same immutable extension may be carried into the final frozen revision.
    let mut next = planned_candidate(true).0;
    next.pending_revision = 2;
    assert_eq!(compatible(&old, &next), Ok(()));
    old.manifest = next.clone();
    next.pending_revision = 3;
    assert_eq!(compatible(&old, &next), Err(StoryError::Conflict));
}

#[test]
fn local_assembly_input_requires_the_exact_plan_count_or_explicit_no_plan() {
    let (mut m, parts) = planned_candidate(false);
    validate_input(parts[0].1.as_bytes(), &m).unwrap();
    m.local_assembly = Some(assembly(None));
    assert_eq!(
        validate_input(parts[0].1.as_bytes(), &m),
        Err(StoryError::Invalid)
    );
    m.local_assembly = Some(assembly(Some(LocalChapterPlan {
        total_chapters: 8,
        ..local_plan()
    })));
    assert_eq!(
        validate_input(parts[0].1.as_bytes(), &m),
        Err(StoryError::Invalid)
    );
    m.local_assembly = None;
    validate_input(parts[0].1.as_bytes(), &m).unwrap(); // Legacy means unknown.
    let (mut m, parts) = candidate(Product::Battle, false);
    m.local_assembly = Some(assembly(None));
    validate_input(parts[0].1.as_bytes(), &m).unwrap();
    m.local_assembly = Some(assembly(Some(local_plan())));
    assert_eq!(
        validate_input(parts[0].1.as_bytes(), &m),
        Err(StoryError::Invalid)
    );
}

#[test]
fn local_assembly_checks_actual_frozen_session_before_seal_audit_and_save() {
    for fault in [
        "none", "count", "source", "locked", "missing", "null", "extra",
    ] {
        let (_root, lib) = fixture();
        let (mut m, mut parts) = planned_candidate(true);
        let (_, raw) = parts
            .iter_mut()
            .find(|(kind, _)| *kind == PendingKind::Session)
            .unwrap();
        let mut session: serde_json::Value = serde_json::from_str(raw).unwrap();
        match fault {
            "count" => session["chapterPlan"]["totalChapters"] = json!(8),
            "source" => session["chapterPlan"]["source"] = json!("user"),
            "locked" => session["chapterPlan"]["locked"] = json!(false),
            "missing" => {
                session.as_object_mut().unwrap().remove("chapterPlan");
            }
            "null" => session["chapterPlan"] = json!(null),
            "extra" => session["chapterPlan"]["extra"] = json!(true),
            _ => {}
        }
        *raw = session.to_string();
        refresh(&mut m, &parts);
        let token = upload(lib.stories(), &m, &parts);
        if fault == "none" {
            lib.stories().pending_seal(&token).unwrap();
            audit(&lock_connection(lib.connection()).unwrap()).unwrap();
            let wire = m.commit_manifest.as_ref().unwrap().wire_digest().unwrap();
            let attempt = lib.stories().pending_prepare_save(&m.key(), &wire).unwrap();
            lib.stories()
                .pending_save(&m.key(), &wire, &attempt.attempt_id)
                .unwrap();
            let connection = lock_connection(lib.connection()).unwrap();
            let plan: String = connection
                .query_row(
                    "SELECT chapter_plan FROM arena_story_session WHERE id='story'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                serde_json::from_str::<LocalChapterPlan>(&plan).unwrap(),
                local_plan()
            );
        } else {
            assert_eq!(
                lib.stories().pending_seal(&token),
                Err(StoryError::Invalid),
                "{fault}"
            );
            // A corrupt backup must not hide the mismatch by claiming it was sealed.
            let connection = lock_connection(lib.connection()).unwrap();
            connection
                .execute(
                    "UPDATE arena_story_pending SET active=1 WHERE token=?1",
                    [&token],
                )
                .unwrap();
            assert!(audit(&connection).is_err(), "{fault}");
            drop(connection);
            let wire = m.commit_manifest.as_ref().unwrap().wire_digest().unwrap();
            let attempt = lib.stories().pending_prepare_save(&m.key(), &wire).unwrap();
            assert_eq!(
                lib.stories()
                    .pending_save(&m.key(), &wire, &attempt.attempt_id),
                Err(StoryError::Invalid),
                "{fault}"
            );
        }
    }
}

#[test]
fn local_assembly_explicit_no_plan_rejects_a_new_frozen_plan() {
    for with_plan in [false, true] {
        let (_root, lib) = fixture();
        let (mut m, mut parts) = candidate(Product::Battle, true);
        m.local_assembly = Some(assembly(None));
        if with_plan {
            let (_, raw) = parts
                .iter_mut()
                .find(|(kind, _)| *kind == PendingKind::Session)
                .unwrap();
            let mut session: serde_json::Value = serde_json::from_str(raw).unwrap();
            session["chapterPlan"] = serde_json::to_value(local_plan()).unwrap();
            *raw = session.to_string();
            refresh(&mut m, &parts);
        }
        let token = upload(lib.stories(), &m, &parts);
        assert_eq!(lib.stories().pending_seal(&token).is_ok(), !with_plan);
    }
}

#[test]
fn local_assembly_continuation_matches_the_existing_session_plan() {
    for fault in ["none", "missing", "count", "source", "locked"] {
        let (_root, lib) = fixture();
        // Commit the first chapter through the existing storage contract.
        let mut first = super::super::super::tests::fixture("story", 1);
        let mut session: serde_json::Value = serde_json::from_str(&first[0].1).unwrap();
        session["chapterPlan"] = serde_json::to_value(local_plan()).unwrap();
        first[0].1 = session.to_string();
        let manifest = super::super::super::tests::manifest("story", 1, &first);
        let now = Instant::now();
        let token = lib.stories().begin(manifest, now).unwrap().token;
        for (kind, body) in &first {
            lib.stories()
                .append(&token, *kind, 0, body.as_bytes(), now)
                .unwrap();
        }
        lib.stories().end(&token, now).unwrap();
        let (mut m, mut parts) = planned_candidate(false);
        m.expected_revision = 1;
        m.expected_last_chapter_id = Some("story-chapter-1".into());
        m.initial_checkpoint_id = None;
        m.last_input_checkpoint_id = "story-checkpoint-1".into();
        m.output_checkpoint_id = "story-checkpoint-2".into();
        m.operation_id = "story-chapter-2".into();
        let plan = match fault {
            "missing" => None,
            "count" => Some(LocalChapterPlan {
                total_chapters: 8,
                ..local_plan()
            }),
            "source" => Some(LocalChapterPlan {
                source: LocalChapterPlanSource::User,
                ..local_plan()
            }),
            "locked" => Some(LocalChapterPlan {
                locked: false,
                ..local_plan()
            }),
            _ => Some(local_plan()),
        };
        m.local_assembly = Some(assembly(plan.clone()));
        let mut input: serde_json::Value = serde_json::from_str(&parts[0].1).unwrap();
        input["action"] = json!("continue");
        input["chapterIndex"] = json!(2);
        input["sourceChapterId"] = json!("story-chapter-1");
        input["chapterContext"]["recentWindow"] = json!([{"chapterId":"story-chapter-1","chapterIndex":1,"title":"one","mode":"full","text":"original","truncated":false}]);
        if let Some(plan) = plan {
            input["chapterPlan"] = json!({"totalChapters":plan.total_chapters});
        } else {
            input.as_object_mut().unwrap().remove("chapterPlan");
        }
        parts[0].1 = input.to_string();
        refresh(&mut m, &parts);
        let token = upload(lib.stories(), &m, &parts);
        if fault == "none" {
            lib.stories().pending_seal(&token).unwrap();
        } else {
            assert_eq!(
                lib.stories().pending_seal(&token),
                Err(StoryError::Invalid),
                "{fault}"
            );
        }
    }
}

#[test]
fn local_assembly_metadata_and_native_claim_keep_the_exact_shared_64k_boundary() {
    for with_claim in [false, true] {
        let (_root, lib) = fixture();
        let (mut m, parts) = unstarted(Product::Battle);
        m.local_assembly = Some(assembly(None));
        let token = upload(lib.stories(), &m, &parts);
        lib.stories().pending_seal(&token).unwrap();
        if with_claim {
            let guard = lib.stories().pending_admission(m.product).unwrap();
            drop(
                lib.stories()
                    .pending_claim_create(
                        &guard,
                        &m.key(),
                        &m.actor,
                        &m.input_digest,
                        &"a".repeat(64),
                        native_funding(),
                    )
                    .unwrap(),
            );
        }
        let connection = lock_connection(lib.connection()).unwrap();
        let claim: Option<String> = connection
            .query_row(
                "SELECT create_claim FROM arena_story_pending WHERE token=?1",
                [&token],
                |r| r.get(0),
            )
            .unwrap();
        let mut metadata = serde_json::to_string(&m).unwrap();
        metadata.push_str(
            &" ".repeat(METADATA_BYTES - claim.as_ref().map_or(0, String::len) - metadata.len()),
        );
        assert_eq!(
            metadata.len() + claim.as_ref().map_or(0, String::len),
            65536
        );
        connection
            .execute(
                "UPDATE arena_story_pending SET metadata=?2 WHERE token=?1",
                params![token, metadata],
            )
            .unwrap();
        native::metadata_budget(&connection, &token, claim.as_deref()).unwrap();
        audit(&connection).unwrap();
        assert_eq!(
            load(&connection, &token)
                .unwrap()
                .snapshot
                .manifest
                .local_assembly,
            m.local_assembly
        );
        if with_claim {
            connection.execute("UPDATE arena_story_pending SET create_claim=create_claim || ' ' WHERE token=?1", [&token]).unwrap();
            let enlarged = format!("{} ", claim.unwrap());
            assert_eq!(
                native::metadata_budget(&connection, &token, Some(&enlarged)),
                Err(StoryError::TooLarge)
            );
            assert!(audit(&connection).is_err());
        } else {
            assert!(connection
                .execute(
                    "UPDATE arena_story_pending SET metadata=metadata || ' ' WHERE token=?1",
                    [&token]
                )
                .is_err());
        }
    }
}

#[test]
fn local_assembly_new_backup_restore_keeps_explicit_and_legacy_intent() {
    for intent in [
        None,
        Some(assembly(None)),
        Some(assembly(Some(local_plan()))),
    ] {
        let (root, lib) = fixture();
        let (mut m, parts) = if intent
            .as_ref()
            .is_some_and(|value| value.chapter_plan.is_some())
        {
            planned_candidate(true)
        } else {
            candidate(Product::Battle, true)
        };
        m.local_assembly = intent.clone();
        let token = upload(lib.stories(), &m, &parts);
        lib.stories().pending_seal(&token).unwrap();
        let backup = crate::backup::create_backup(&lib).unwrap();
        crate::backup::verify_backup(root.path(), &backup.backup_id).unwrap();
        let prepared = crate::restore::prepare_restore(&lib, &backup.backup_id).unwrap();
        drop(prepared);
        drop(lib);
        crate::restore::recover_pending(root.path()).unwrap();
        let restored = LocalLibrary::open(root.path()).unwrap();
        let snapshot = restored
            .stories()
            .pending_describe(Product::Battle)
            .unwrap()
            .unwrap();
        assert!(snapshot.restored);
        assert_eq!(snapshot.manifest.local_assembly, intent);
        assert_eq!(
            schema_version(&lock_connection(restored.connection()).unwrap()).unwrap(),
            crate::store::SCHEMA_VERSION
        );
    }
}

#[test]
fn local_assembly_old_schema_six_through_eight_pending_remains_unknown_after_audit_and_migration() {
    for version in 6..=8 {
        let (m, parts) = unstarted(Product::Battle);
        let token = format!("{}-{}", "a".repeat(32), "b".repeat(32));
        let old = Connection::open_in_memory().unwrap();
        crate::store::migrate_to_version_for_test(&old, version);
        let metadata = serde_json::to_string(&m).unwrap();
        assert!(!metadata.contains("localAssembly"));
        old.execute("INSERT INTO arena_story_pending(token,product,request_id,revision,active,metadata,total_bytes) VALUES(?1,'battle',?2,1,1,?3,?4)", params![token,m.request_id,metadata,m.validate().unwrap()]).unwrap();
        for (kind, body) in &parts {
            old.execute("INSERT INTO arena_story_pending_part(token,kind,byte_length,received_bytes,digest,payload) VALUES(?1,?2,?3,?3,?4,?5)", params![token,kind.sql(),body.len() as u64,digest(body.as_bytes()),body.as_bytes()]).unwrap();
        }
        audit(&old).unwrap();
        assert_eq!(schema_version(&old).unwrap(), version);
        assert!(load(&old, &token)
            .unwrap()
            .snapshot
            .manifest
            .local_assembly
            .is_none());
        crate::store::migrate(&old).unwrap();
        audit(&old).unwrap();
        assert!(load(&old, &token)
            .unwrap()
            .snapshot
            .manifest
            .local_assembly
            .is_none());
    }
}

#[test]
fn local_assembly_failed_replacement_preserves_the_exact_active_candidate() {
    for intent in [
        None,
        Some(assembly(None)),
        Some(assembly(Some(local_plan()))),
    ] {
        let (_root, lib) = fixture();
        let (mut m, parts) = if intent
            .as_ref()
            .is_some_and(|value| value.chapter_plan.is_some())
        {
            planned_candidate(false)
        } else {
            candidate(Product::Battle, false)
        };
        m.local_assembly = intent;
        let token = upload(lib.stories(), &m, &parts);
        let original = lib.stories().pending_seal(&token).unwrap();
        let mut replacement = m.clone();
        replacement.pending_revision += 1;
        replacement.local_assembly = if m.local_assembly.is_none() {
            Some(assembly(None))
        } else {
            None
        };
        assert_eq!(
            lib.stories().pending_begin(replacement),
            Err(StoryError::Conflict)
        );
        assert_eq!(
            lib.stories().pending_describe(m.product).unwrap(),
            Some(original)
        );
    }
}

#[test]
fn local_assembly_input_mismatch_cannot_write_the_original_carrier() {
    let (_root, lib) = fixture();
    let (mut m, parts) = planned_candidate(false);
    m.local_assembly = Some(assembly(Some(LocalChapterPlan {
        total_chapters: 8,
        ..local_plan()
    })));
    let token = lib.stories().pending_begin(m).unwrap().token;
    assert_eq!(
        lib.stories()
            .pending_append(&token, PendingKind::Input, 0, parts[0].1.as_bytes()),
        Err(StoryError::Invalid)
    );
    assert_eq!(
        lib.stories().pending_upload(&token).unwrap().received_bytes[0].received_bytes,
        0
    );
    let connection = lock_connection(lib.connection()).unwrap();
    let bytes: Vec<u8> = connection
        .query_row(
            "SELECT payload FROM arena_story_pending_part WHERE token=?1 AND kind='input'",
            [&token],
            |r| r.get(0),
        )
        .unwrap();
    assert!(bytes.iter().all(|byte| *byte == 0));
}

#[test]
fn local_assembly_backup_audit_rejects_unknown_version_and_wrong_metadata_type() {
    for extension in [
        json!(null),
        json!([1, null]),
        json!({"version":2,"chapterPlan":null}),
        json!({"version":1,"chapterPlan":[7,"scenario",true]}),
        json!({"version":1,"chapterPlan":{"totalChapters":7,"source":"scenario","locked":"true"}}),
    ] {
        let (_root, lib) = fixture();
        let (m, parts) = candidate(Product::Battle, false);
        let token = upload(lib.stories(), &m, &parts);
        lib.stories().pending_seal(&token).unwrap();
        let mut metadata = serde_json::to_value(&m).unwrap();
        metadata["localAssembly"] = extension;
        let connection = lock_connection(lib.connection()).unwrap();
        connection
            .execute(
                "UPDATE arena_story_pending SET metadata=?2 WHERE token=?1",
                params![token, metadata.to_string()],
            )
            .unwrap();
        assert!(audit(&connection).is_err());
        drop(connection);
        assert!(crate::backup::create_backup(&lib).is_err());
    }
}
