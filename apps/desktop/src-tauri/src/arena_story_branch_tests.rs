use super::*;

fn chapter(index: u64) -> String {
    format!(
        r#"{{"id":"c{index}","sessionId":"source","index":{index},"action":"{}","status":"active","sourceChapterId":{},"titlePreview":"章","titleTruncated":false,"createdAt":1,"markdownByteLength":0,"markdown":"","reportJson":{{}},"deterministicDigest":{{}}}}"#,
        if index == 1 { "start" } else { "continue" },
        if index == 1 {
            "null".into()
        } else {
            format!("\"c{}\"", index - 1)
        }
    )
}
fn copy(document: &str) -> Result<CopyRecord, StoryError> {
    let raw = serde_json::from_str(document).map_err(|_| StoryError::Corrupt)?;
    let index = chapter_index(&authority(raw, CHAPTER_AUTHORITY)?)?;
    copy_chapter(
        CheckedCopySource::checked(
            document,
            document.len() as u64,
            &digest(document.as_bytes()),
        )?,
        &index,
        index.source_chapter_id.as_deref(),
        "target",
        false,
    )
}
fn checkpoint(index: u64) -> String {
    format!(
        r#"{{"id":"p{index}","sessionId":"source","boundaryIndex":{index},"chapterId":{},"combatants":[{{"\ud800":"\udfff","x":1,"x":2}}],"createdAt":1}}"#,
        if index == 0 {
            "null".into()
        } else {
            format!("\"c{index}\"")
        }
    )
}
fn copy_cp(document: &str) -> Result<CopyRecord, StoryError> {
    let raw = serde_json::from_str(document).map_err(|_| StoryError::Corrupt)?;
    let index = checkpoint_index(&authority(raw, CHECKPOINT_AUTHORITY)?)?;
    copy_checkpoint(
        CheckedCopySource::checked(
            document,
            document.len() as u64,
            &digest(document.as_bytes()),
        )?,
        &index,
        index.chapter_id.as_deref(),
        "target",
    )
}

#[test]
fn raw_copy_preserves_opaque_tokens_and_historical_generation() {
    let source = chapter(2)
        .replace("\"continue\"", "\"branch\"")
        .replace("\"id\"", "\"\\u0069d\"");
    let extension = r#", "generationId":"historic", "\ud800":"\udfff", "opaque":{"id":"c2","x":1,"x":2},"dup":1,"dup":2,"text":"\u0000中😀\n\u4e2d" "#;
    let source = format!(" \n{}{} }}\t", &source[..source.len() - 1], extension);
    let result = copy(&source).unwrap();
    assert!(result.document.contains(extension));
    assert!(result.document.contains("\"\\u0069d\""));
    assert!(result.document.contains("\"action\":\"branch\""));
    assert_eq!(
        result.document,
        source
            .replacen("\"c2\"", &json(&result.id).unwrap(), 1)
            .replacen("\"source\"", "\"target\"", 1)
            .replacen(
                "\"c1\"",
                &json(&copy_id("target", CopyKind::Chapter, 1).unwrap()).unwrap(),
                1
            )
            .replace("}\t", ",\"supersededByChapterId\":null}\t")
    );
    assert_eq!(result.byte_length, result.document.len() as u64);
    assert_eq!(result.digest, digest(result.document.as_bytes()));
}

#[test]
fn copy_rejects_every_duplicate_authority_alias_but_not_opaque_duplicates() {
    for name in CHAPTER_AUTHORITY {
        let source = chapter(1);
        // Duplicate absent optionals as well as members already present.
        let source = if source.contains(&format!("\"{name}\":")) {
            source
        } else {
            format!("{},\"{name}\":null}}", &source[..source.len() - 1])
        };
        let alias = format!("\\u{:04x}{}", name.as_bytes()[0], &name[1..]);
        let source = format!("{},\"{alias}\":null}}", &source[..source.len() - 1]);
        assert!(copy(&source).is_err(), "{name}");
    }
    for name in CHECKPOINT_AUTHORITY {
        let source = checkpoint(1);
        let alias = format!("\\u{:04x}{}", name.as_bytes()[0], &name[1..]);
        let source = format!("{},\"{alias}\":null}}", &source[..source.len() - 1]);
        assert!(copy_cp(&source).is_err(), "{name}");
    }
}

#[test]
fn full_prefix_ids_and_checkpoint_relations_match_without_a_map() {
    for i in 1..=40 {
        let result = copy(&chapter(i)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&result.document).unwrap();
        assert_eq!(
            value["id"],
            copy_id("target", CopyKind::Chapter, i).unwrap()
        );
        assert_eq!(value["sessionId"], "target");
        assert_eq!(value["status"], "active");
        assert!(value["supersededByChapterId"].is_null());
        if i == 1 {
            assert!(value["sourceChapterId"].is_null());
        } else {
            assert_eq!(
                value["sourceChapterId"],
                copy_id("target", CopyKind::Chapter, i - 1).unwrap()
            );
        }
    }
    for i in 0..=40 {
        let result = copy_cp(&checkpoint(i)).unwrap();
        // Borrow carrier metadata; unknown lone surrogate remains untouched.
        let value: CheckpointIndex = serde_json::from_str(&result.document).unwrap();
        assert_eq!(
            value.id,
            copy_id("target", CopyKind::Checkpoint, i).unwrap()
        );
        assert_eq!(value.session_id, "target");
        assert_eq!(
            value.chapter_id,
            if i == 0 {
                None
            } else {
                Some(copy_id("target", CopyKind::Chapter, i).unwrap())
            }
        );
        assert!(result
            .document
            .contains(r#"{"\ud800":"\udfff","x":1,"x":2}"#));
    }
}

#[test]
fn missing_optional_links_are_normalized_like_domain() {
    let source = chapter(1).replace(",\"sourceChapterId\":null", "");
    let result = copy(&source).unwrap();
    assert!(result.document.contains("\"sourceChapterId\":null"));
    let source = checkpoint(0).replace(",\"chapterId\":null", "");
    let result = copy_cp(&source).unwrap();
    assert!(result.document.contains("\"chapterId\":null"));
}

#[test]
fn corrupt_bytes_hash_and_index_relationship_fail_closed() {
    let document = chapter(2);
    let mut index: ChapterIndex = serde_json::from_str(&document).unwrap();
    let hash = digest(document.as_bytes());
    let run = |index: &ChapterIndex, previous, byte_length, hash: &str| {
        copy_chapter(
            CheckedCopySource::checked(&document, byte_length, hash)?,
            index,
            previous,
            "target",
            false,
        )
    };
    assert!(run(&index, Some("wrong"), document.len() as u64, &hash).is_err());
    assert!(run(&index, Some("c1"), document.len() as u64 - 1, &hash).is_err());
    assert!(run(&index, Some("c1"), document.len() as u64, &digest(b"wrong")).is_err());
    index.index = 3;
    assert!(run(&index, Some("c1"), document.len() as u64, &hash).is_err());
    for source in [
        chapter(1).replace("\"start\"", "\"branch\""),
        chapter(2).replace("\"continue\"", "\"rewrite\""),
        chapter(2).replace("\"active\"", "\"superseded\""),
        chapter(2).replace("\"c1\"", "null"),
    ] {
        assert!(copy(&source).is_err());
    }
    assert!(copy_cp(&checkpoint(1).replace("\"c1\"", "null")).is_err());
    assert!(copy_cp(&checkpoint(0).replace("\"chapterId\":null", "\"chapterId\":\"c1\"")).is_err());
}

#[test]
fn bounded_namespace_is_stable_distinct_and_does_not_restrict_source_id_length() {
    let session = "s".repeat(128);
    let id = copy_id(&session, CopyKind::Chapter, MAX_SAFE_INTEGER).unwrap();
    assert!(valid_id(&id));
    assert_eq!(id.len(), 71);
    assert_ne!(
        id,
        copy_id(&session, CopyKind::Checkpoint, MAX_SAFE_INTEGER).unwrap()
    );
    assert_ne!(
        id,
        copy_id("other", CopyKind::Chapter, MAX_SAFE_INTEGER).unwrap()
    );
    assert!(copy_id("bad/namespace", CopyKind::Chapter, 1).is_err());
    assert!(copy_id("target", CopyKind::Chapter, 0).is_err());
    assert!(copy_id("target", CopyKind::Checkpoint, MAX_SAFE_INTEGER + 1).is_err());
}

#[test]
fn native_physical_copy_matches_the_real_domain_shared_fixture() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/desktop-story-branch-copy.json"
    ))
    .unwrap();
    let target = fixture["targetSession"].as_str().unwrap();
    for (source, expected) in fixture["chapters"]
        .as_array()
        .unwrap()
        .iter()
        .zip(fixture["expectedChapters"].as_array().unwrap())
    {
        let document = source.to_string();
        let indexed: ChapterIndex = serde_json::from_value(source.clone()).unwrap();
        let copied = copy_chapter(
            CheckedCopySource::checked(
                &document,
                document.len() as u64,
                &digest(document.as_bytes()),
            )
            .unwrap(),
            &indexed,
            indexed.source_chapter_id.as_deref(),
            target,
            false,
        )
        .unwrap();
        assert_eq!(
            &serde_json::from_str::<serde_json::Value>(&copied.document).unwrap(),
            expected
        );
    }
    for (source, expected) in fixture["checkpoints"]
        .as_array()
        .unwrap()
        .iter()
        .zip(fixture["expectedCheckpoints"].as_array().unwrap())
    {
        let document = source.to_string();
        let indexed: CheckpointIndex = serde_json::from_value(source.clone()).unwrap();
        let copied = copy_checkpoint(
            CheckedCopySource::checked(
                &document,
                document.len() as u64,
                &digest(document.as_bytes()),
            )
            .unwrap(),
            &indexed,
            indexed.chapter_id.as_deref(),
            target,
        )
        .unwrap();
        assert_eq!(
            &serde_json::from_str::<serde_json::Value>(&copied.document).unwrap(),
            expected
        );
    }
}

#[test]
fn checked_source_borrows_exact_bytes_and_rejects_invalid_object_evidence() {
    let document = format!(" \n{}\t", chapter(1));
    let hash = digest(document.as_bytes());
    let source = CheckedCopySource::checked(&document, document.len() as u64, &hash).unwrap();
    assert_eq!(source.document().as_ptr(), document.as_ptr());
    assert_eq!(source.document(), document);
    assert_eq!(source.byte_length(), document.len() as u64);
    assert_eq!(source.digest(), hash);
    let start = source.raw().get().as_ptr() as usize - document.as_ptr() as usize;
    assert_eq!(
        &document[start..start + source.raw().get().len()],
        source.raw().get()
    );
    for invalid in ["{", "{\"x\":}", "{} trailing", "[]", "null", "\"object\""] {
        assert!(matches!(
            CheckedCopySource::checked(invalid, invalid.len() as u64, &digest(invalid.as_bytes())),
            Err(StoryError::Corrupt)
        ));
    }
    for length in [0, CANDIDATE_COMMIT_BYTES + 1] {
        assert!(matches!(
            CheckedCopySource::checked(&document, length, &hash),
            Err(StoryError::TooLarge)
        ));
    }
    assert!(matches!(
        CheckedCopySource::checked(&document, document.len() as u64, "sha256:bad"),
        Err(StoryError::Corrupt)
    ));
}

#[test]
fn verified_bytes_do_not_bypass_copy_authority_or_checkpoint_relationships() {
    let document = chapter(1);
    let chapter_index: ChapterIndex = serde_json::from_str(&document).unwrap();
    for name in CHAPTER_AUTHORITY {
        let alias = format!("\\u{:04x}{}", name.as_bytes()[0], &name[1..]);
        let document = if document.contains(&format!("\"{name}\":")) {
            document.clone()
        } else {
            format!("{},\"{name}\":null}}", &document[..document.len() - 1])
        };
        let document = format!("{},\"{alias}\":null}}", &document[..document.len() - 1]);
        let hash = digest(document.as_bytes());
        let checked = CheckedCopySource::checked(&document, document.len() as u64, &hash).unwrap();
        assert!(
            matches!(
                copy_chapter(checked, &chapter_index, None, "target", false),
                Err(StoryError::Corrupt)
            ),
            "{name}"
        );
    }
    let document = checkpoint(1);
    let mut checkpoint_index: CheckpointIndex = serde_json::from_str(&document).unwrap();
    for name in CHECKPOINT_AUTHORITY {
        let alias = format!("\\u{:04x}{}", name.as_bytes()[0], &name[1..]);
        let document = format!("{},\"{alias}\":null}}", &document[..document.len() - 1]);
        let hash = digest(document.as_bytes());
        let checked = CheckedCopySource::checked(&document, document.len() as u64, &hash).unwrap();
        assert!(
            matches!(
                copy_checkpoint(checked, &checkpoint_index, Some("c1"), "target"),
                Err(StoryError::Corrupt)
            ),
            "{name}"
        );
    }
    let hash = digest(document.as_bytes());
    let checked = || CheckedCopySource::checked(&document, document.len() as u64, &hash).unwrap();
    assert!(matches!(
        copy_checkpoint(checked(), &checkpoint_index, Some("wrong"), "target"),
        Err(StoryError::Corrupt)
    ));
    checkpoint_index.boundary_index = 2;
    assert!(matches!(
        copy_checkpoint(checked(), &checkpoint_index, Some("c1"), "target"),
        Err(StoryError::Corrupt)
    ));
}

#[test]
fn streaming_authority_copy_matches_independent_full_raw_goldens() {
    // Literal complete oracles: neither member scanner nor optimized authority
    // projection generates any expected byte, including the fixed namespace IDs.
    let chapter = r#"
{ "\u0069d" : "c1", "session\u0049d":"source", "index":1,"action":"start",
"status":"active","titlePreview":"章","titleTruncated":false,"createdAt":1,
"markdownByteLength":0,"markdown":"","reportJson":{"a":[{"text":",:\"\\"}]},"deterministicDigest":{},
"\ud800":"\udfff", "dup":1,"dup":2,"😀":{"x":1,"x":2} }	"#;
    let expected = r#"
{ "\u0069d" : "branch_c3b7134cee1c92a57c77fc71a4416fb7d248f37a464a50e8cdb7113e8b163886", "session\u0049d":"target", "index":1,"action":"start",
"status":"active","titlePreview":"章","titleTruncated":false,"createdAt":1,
"markdownByteLength":0,"markdown":"","reportJson":{"a":[{"text":",:\"\\"}]},"deterministicDigest":{},
"\ud800":"\udfff", "dup":1,"dup":2,"😀":{"x":1,"x":2} ,"sourceChapterId":null,"supersededByChapterId":null}	"#;
    assert_eq!(copy(chapter).unwrap().document, expected);
    let checkpoint = r#" {"\u0069d":"p0", "sessionId" : "source", "boundaryIndex":0,
"combatants":[{"x":1,"x":2,"\udfff":"\ud800","nested":[[[{}]]]}],"createdAt":1,"unknown":1,"unknown":2} "#;
    let expected = r#" {"\u0069d":"branch_66689c0eccd23c3da199dada91e4b3c82e9854adf5b5a413a6b53e981f369ea7", "sessionId" : "target", "boundaryIndex":0,
"combatants":[{"x":1,"x":2,"\udfff":"\ud800","nested":[[[{}]]]}],"createdAt":1,"unknown":1,"unknown":2,"chapterId":null} "#;
    assert_eq!(copy_cp(checkpoint).unwrap().document, expected);
}

#[test]
fn streaming_authority_matches_all_escaped_names_and_ignores_long_unknowns() {
    for names in [CHAPTER_AUTHORITY, CHECKPOINT_AUTHORITY] {
        for name in names {
            let escaped = name
                .bytes()
                .map(|c| format!("\\u{c:04x}"))
                .collect::<String>();
            let text = format!(r#"{{"{escaped}":{{"opaque":"\ud800"}}}}"#);
            let raw = serde_json::from_str(&text).unwrap();
            let fields = authority(raw, names).unwrap();
            assert_eq!(fields.len(), 1);
            assert_eq!(fields[name].get(), r#"{"opaque":"\ud800"}"#);
        }
    }
    let long = format!("id{}\\ud800", "x".repeat(128 * 1024));
    let raw_text =
        format!(r#"{{"{long}":1,"{long}":2,"id\u0000":3,"i":4,"":5,"\ud800":6,"\udfff":7}}"#);
    let raw = serde_json::from_str(&raw_text).unwrap();
    assert!(authority(raw, CHAPTER_AUTHORITY).unwrap().is_empty());
    let nested = format!("{}0{}", "[".repeat(96), "]".repeat(96));
    let raw_text = format!(r#"{{"unknown":{nested},"\u0069d":"c1"}}"#);
    let raw = serde_json::from_str(&raw_text).unwrap();
    assert_eq!(
        authority(raw, CHAPTER_AUTHORITY).unwrap()["id"].get(),
        r#""c1""#
    );
}
