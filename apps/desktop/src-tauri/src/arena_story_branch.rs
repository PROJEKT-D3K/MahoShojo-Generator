//! Internal branch materialization primitives, not a command or write capability.
//!
//! The domain projection chooses the prefix and business state. This module only
//! verifies an indexed, hashed Native record and changes its physical identities.
//! The caller must recheck the complete source CAS inside its write transaction.
use std::collections::BTreeMap;

use serde_json::value::RawValue;
use sha2::{Digest, Sha256};

use super::{
    digest, valid_digest, valid_id, ChapterIndex, CheckpointIndex, StoryError,
    CANDIDATE_COMMIT_BYTES, MAX_SAFE_INTEGER,
};

const CHAPTER_AUTHORITY: &[&str] = &[
    "id",
    "sessionId",
    "index",
    "action",
    "status",
    "sourceChapterId",
    "supersededByChapterId",
    "generationId",
    "title",
    "titlePreview",
    "titleTruncated",
    "createdAt",
    "markdownByteLength",
    "markdown",
    "reportJson",
    "deterministicDigest",
    "cardSnapshot",
];
const CHECKPOINT_AUTHORITY: &[&str] = &[
    "id",
    "sessionId",
    "boundaryIndex",
    "chapterId",
    "combatants",
    "createdAt",
];

#[derive(Clone, Copy)]
pub(super) enum CopyKind {
    Chapter,
    Checkpoint,
}

/// Stable target-local identities use only the target session namespace and index.
/// No prefix map or source identities are retained across records.
pub(super) fn copy_id(
    target_session: &str,
    kind: CopyKind,
    index: u64,
) -> Result<String, StoryError> {
    if !valid_id(target_session)
        || index > MAX_SAFE_INTEGER
        || matches!(kind, CopyKind::Chapter) && index == 0
    {
        return Err(StoryError::Invalid);
    }
    let mut hash = Sha256::new();
    hash.update(b"maho:arena-story-branch-record:v1\0");
    hash.update([match kind {
        CopyKind::Chapter => b'c',
        CopyKind::Checkpoint => b'p',
    }]);
    hash.update(index.to_be_bytes());
    hash.update((target_session.len() as u64).to_be_bytes());
    hash.update(target_session.as_bytes());
    Ok(format!("branch_{:x}", hash.finalize()))
}

pub(super) struct CopyRecord {
    pub id: String,
    pub document: String,
    pub byte_length: u64,
    pub digest: String,
}

// Keep the evidence fields in a sibling of storage, not in its parent: Rust
// descendants can access parent-private fields, which would permit forgery here.
#[path = "arena_story_branch_verified_source.rs"]
mod verified_source;
use verified_source::CheckedCopySource;

// Only retain the small allowlist, never opaque members. UTF-16 comparison catches
// escaped aliases while allowing unknown lone-surrogate keys and duplicate keys.
fn authority<'a>(
    raw: &'a RawValue,
    names: &[&'static str],
) -> Result<BTreeMap<&'static str, &'a RawValue>, StoryError> {
    let mut result = BTreeMap::new();
    for member in super::pending::member_iter(raw)? {
        let (key, value) = super::pending::raw_member_parts(member)?;
        for name in names {
            if super::pending::raw_key_equals(key, name)? {
                if result.insert(*name, value).is_some() {
                    return Err(StoryError::Corrupt);
                }
                break;
            }
        }
    }
    Ok(result)
}

fn required<T: serde::de::DeserializeOwned>(
    fields: &BTreeMap<&str, &RawValue>,
    key: &str,
) -> Result<T, StoryError> {
    serde_json::from_str(fields.get(key).ok_or(StoryError::Corrupt)?.get())
        .map_err(|_| StoryError::Corrupt)
}
fn optional_id(
    fields: &BTreeMap<&str, &RawValue>,
    key: &str,
) -> Result<Option<String>, StoryError> {
    fields
        .get(key)
        .map(|raw| serde_json::from_str(raw.get()).map_err(|_| StoryError::Corrupt))
        .unwrap_or(Ok(None))
}
fn chapter_index(fields: &BTreeMap<&str, &RawValue>) -> Result<ChapterIndex, StoryError> {
    Ok(ChapterIndex {
        id: required(fields, "id")?,
        session_id: required(fields, "sessionId")?,
        index: required(fields, "index")?,
        action: required(fields, "action")?,
        status: required(fields, "status")?,
        source_chapter_id: optional_id(fields, "sourceChapterId")?,
        title_preview: required(fields, "titlePreview")?,
        title_truncated: required(fields, "titleTruncated")?,
        created_at: required(fields, "createdAt")?,
        markdown_byte_length: required(fields, "markdownByteLength")?,
    })
}
fn checkpoint_index(fields: &BTreeMap<&str, &RawValue>) -> Result<CheckpointIndex, StoryError> {
    Ok(CheckpointIndex {
        id: required(fields, "id")?,
        session_id: required(fields, "sessionId")?,
        boundary_index: required(fields, "boundaryIndex")?,
        chapter_id: optional_id(fields, "chapterId")?,
    })
}

// Value-span replacement is private and called with fixed identity fields only.
// Original key tokens, separators, whitespace and untouched values remain exact.
fn materialize(
    source: &str,
    fields: &BTreeMap<&str, &RawValue>,
    replacements: &[(&str, String)],
) -> Result<String, StoryError> {
    let mut spans = Vec::new();
    let mut missing = Vec::new();
    let mut size = source.len();
    for (key, replacement) in replacements {
        if let Some(value) = fields.get(key) {
            let start = (value.get().as_ptr() as usize)
                .checked_sub(source.as_ptr() as usize)
                .ok_or(StoryError::Corrupt)?;
            let end = start
                .checked_add(value.get().len())
                .ok_or(StoryError::TooLarge)?;
            if source.get(start..end) != Some(value.get()) {
                return Err(StoryError::Corrupt);
            }
            size = size
                .checked_sub(value.get().len())
                .and_then(|n| n.checked_add(replacement.len()))
                .ok_or(StoryError::TooLarge)?;
            spans.push((start, end, replacement.as_str()));
        } else {
            // All callers have required identity members; a comma is always needed.
            let member = format!(",{}:{}", json(key)?, replacement);
            size = size.checked_add(member.len()).ok_or(StoryError::TooLarge)?;
            missing.push(member);
        }
    }
    if size as u64 > CANDIDATE_COMMIT_BYTES {
        return Err(StoryError::TooLarge);
    }
    spans.sort_unstable_by_key(|span| span.0);
    let mut output = String::new();
    output
        .try_reserve_exact(size)
        .map_err(|_| StoryError::TooLarge)?;
    let mut cursor = 0;
    for (start, end, replacement) in spans {
        output.push_str(source.get(cursor..start).ok_or(StoryError::Corrupt)?);
        output.push_str(replacement);
        cursor = end;
    }
    let close = source.rfind('}').ok_or(StoryError::Corrupt)?;
    output.push_str(source.get(cursor..close).ok_or(StoryError::Corrupt)?);
    for member in missing {
        output.push_str(&member);
    }
    output.push_str(&source[close..]);
    Ok(output)
}
fn json(value: &str) -> Result<String, StoryError> {
    serde_json::to_string(value).map_err(|_| StoryError::Invalid)
}
fn finish(id: String, document: String) -> CopyRecord {
    CopyRecord {
        id,
        byte_length: document.len() as u64,
        digest: digest(document.as_bytes()),
        document,
    }
}

/// `indexed` is the row read inside the same source snapshot; it is not a renderer DTO.
/// `previous_id` is a bounded lookup of source index-1, not an untrusted mapping.
fn copy_chapter(
    source: CheckedCopySource<'_>,
    indexed: &ChapterIndex,
    previous_id: Option<&str>,
    target_session: &str,
) -> Result<CopyRecord, StoryError> {
    let raw = source.raw();
    let fields = authority(raw, CHAPTER_AUTHORITY)?;
    let actual = chapter_index(&fields)?;
    if !valid_id(&indexed.id)
        || !valid_id(&indexed.session_id)
        || indexed.session_id == target_session
        || indexed.index == 0
        || indexed.index > MAX_SAFE_INTEGER
        || indexed.status != "active"
        || actual.id != indexed.id
        || actual.session_id != indexed.session_id
        || actual.index != indexed.index
        || actual.action != indexed.action
        || actual.status != indexed.status
        || actual.source_chapter_id != indexed.source_chapter_id
        || actual.title_preview != indexed.title_preview
        || actual.title_truncated != indexed.title_truncated
        || actual.created_at != indexed.created_at
        || actual.markdown_byte_length != indexed.markdown_byte_length
        || indexed.source_chapter_id.as_deref() != previous_id
        || if indexed.index == 1 {
            indexed.action != "start" || previous_id.is_some()
        } else {
            !["continue", "branch"].contains(&indexed.action.as_str())
                || previous_id.is_none_or(|id| !valid_id(id) || id == indexed.id)
        }
    {
        return Err(StoryError::Corrupt);
    }
    let id = copy_id(target_session, CopyKind::Chapter, indexed.index)?;
    let previous = if indexed.index == 1 {
        "null".into()
    } else {
        json(&copy_id(
            target_session,
            CopyKind::Chapter,
            indexed.index - 1,
        )?)?
    };
    let document = materialize(
        source.document(),
        &fields,
        &[
            ("id", json(&id)?),
            ("sessionId", json(target_session)?),
            ("sourceChapterId", previous),
            ("status", "\"active\"".into()),
            ("supersededByChapterId", "null".into()),
        ],
    )?;
    Ok(finish(id, document))
}

fn copy_checkpoint(
    source: CheckedCopySource<'_>,
    indexed: &CheckpointIndex,
    source_chapter_id: Option<&str>,
    target_session: &str,
) -> Result<CopyRecord, StoryError> {
    let raw = source.raw();
    let fields = authority(raw, CHECKPOINT_AUTHORITY)?;
    let actual = checkpoint_index(&fields)?;
    if !valid_id(&indexed.id)
        || !valid_id(&indexed.session_id)
        || indexed.session_id == target_session
        || indexed.boundary_index > MAX_SAFE_INTEGER
        || actual.id != indexed.id
        || actual.session_id != indexed.session_id
        || actual.boundary_index != indexed.boundary_index
        || actual.chapter_id != indexed.chapter_id
        || indexed.chapter_id.as_deref() != source_chapter_id
        || if indexed.boundary_index == 0 {
            source_chapter_id.is_some()
        } else {
            source_chapter_id.is_none_or(|id| !valid_id(id))
        }
    {
        return Err(StoryError::Corrupt);
    }
    let id = copy_id(target_session, CopyKind::Checkpoint, indexed.boundary_index)?;
    let chapter = if indexed.boundary_index == 0 {
        "null".into()
    } else {
        json(&copy_id(
            target_session,
            CopyKind::Chapter,
            indexed.boundary_index,
        )?)?
    };
    let document = materialize(
        source.document(),
        &fields,
        &[
            ("id", json(&id)?),
            ("sessionId", json(target_session)?),
            ("chapterId", chapter),
        ],
    )?;
    Ok(finish(id, document))
}

#[cfg(test)]
#[path = "arena_story_branch_tests.rs"]
mod tests;

#[path = "arena_story_branch_receipt.rs"]
mod receipt;

#[path = "arena_story_branch_store.rs"]
mod storage;
pub(crate) use storage::BranchManifest;

#[path = "arena_story_branch_audit.rs"]
pub(crate) mod audit;
#[path = "arena_story_branch_schema.rs"]
pub(crate) mod schema;
