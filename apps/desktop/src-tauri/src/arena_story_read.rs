//! Narrow summary and immutable-record reads. No renderer SQL, path or rowid.
use std::io::{Read, Seek, SeekFrom};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use super::branch::BranchSource;
use super::{valid_id, StoryError, StoryStore, CANDIDATE_FRAME_BYTES, CANDIDATE_PAGE_BYTES};
use crate::store::lock_connection;

pub const DEFAULT_PAGE_SIZE: u32 = 25;
pub const MAX_PAGE_SIZE: u32 = 50;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCursor {
    pub updated_at: u64,
    pub id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChapterCursor {
    pub index: u64,
    pub id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionHead {
    pub id: String,
    pub revision: u64,
    pub title_preview: String,
    pub title_truncated: bool,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chapter_plan: Option<super::StoryChapterPlan>,
    pub created_at: u64,
    pub updated_at: u64,
    pub chapter_count: u64,
    pub last_chapter_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChapterHead {
    pub id: String,
    pub index: u64,
    pub action: String,
    pub status: String,
    pub title_preview: String,
    pub title_truncated: bool,
    pub created_at: u64,
    pub markdown_byte_length: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionPage {
    pub rows: Vec<SessionHead>,
    pub next_cursor: Option<SessionCursor>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChapterPage {
    pub session_id: String,
    pub revision: u64,
    pub rows: Vec<ChapterHead>,
    pub next_cursor: Option<ChapterCursor>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecordKind {
    Session,
    Seed,
    Chapter,
    Checkpoint,
}
impl RecordKind {
    // Fixed native allowlist only. Never interpolate caller-supplied identifiers.
    fn storage(self) -> (&'static str, &'static str, &'static str, &'static str) {
        match self {
            Self::Session => (
                "arena_story_session",
                "document",
                "document_bytes",
                "document_digest",
            ),
            Self::Seed => (
                "arena_story_session",
                "seed_document",
                "seed_bytes",
                "seed_digest",
            ),
            Self::Chapter => (
                "arena_story_chapter",
                "document",
                "document_bytes",
                "document_digest",
            ),
            Self::Checkpoint => (
                "arena_story_checkpoint",
                "document",
                "document_bytes",
                "document_digest",
            ),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordDescriptor {
    pub instance: String,
    pub session_id: String,
    pub record_id: String,
    pub revision: u64,
    pub kind: RecordKind,
    pub byte_length: u64,
    pub digest: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContinueDescriptors {
    pub session: RecordDescriptor,
    pub seed: RecordDescriptor,
    pub checkpoint: RecordDescriptor,
    pub recent_chapters: Vec<RecordDescriptor>,
    pub head: SessionHead,
}

/// Bounded, read-only source identity for the dedicated branch anchor command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BranchAnchorRequest {
    pub session_id: String,
    pub revision: u64,
    pub expected_last_chapter_id: String,
    pub expected_chapter_count: u64,
    pub anchor_chapter_id: String,
    pub anchor_index: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BranchAnchorDescriptors {
    pub source: BranchSource,
    pub recent_chapters: Vec<RecordDescriptor>,
}

// Inspect only the selected chapter, borrowing its SQLite row. Reuse the raw
// scanner so escaped authority keys and opaque lone-surrogate extensions retain
// the same meaning as the writer; never hydrate the historical prefix.
fn check_branch_anchor(raw: &RawValue, request: &BranchAnchorRequest) -> Result<(), StoryError> {
    let names = [
        "id",
        "sessionId",
        "index",
        "status",
        "supersededByChapterId",
    ];
    let mut fields = [None; 5];
    for member in super::pending::member_iter(raw).map_err(|_| StoryError::Corrupt)? {
        let (key, value) =
            super::pending::raw_member_parts(member).map_err(|_| StoryError::Corrupt)?;
        for (index, name) in names.iter().enumerate() {
            if super::pending::raw_key_equals(key, name).map_err(|_| StoryError::Corrupt)? {
                if fields[index].replace(value).is_some() {
                    return Err(StoryError::Corrupt);
                }
                break;
            }
        }
    }
    for (index, expected) in [
        (0, request.anchor_chapter_id.as_str()),
        (1, request.session_id.as_str()),
        (3, "active"),
    ] {
        if !super::pending::raw_key_equals(fields[index].ok_or(StoryError::Corrupt)?, expected)
            .map_err(|_| StoryError::Corrupt)?
        {
            return Err(StoryError::Corrupt);
        }
    }
    if serde_json::from_str::<u64>(fields[2].ok_or(StoryError::Corrupt)?.get())
        .map_err(|_| StoryError::Corrupt)?
        != request.anchor_index
        || fields[4].is_some_and(|value| value.get() != "null")
    {
        return Err(StoryError::Corrupt);
    }
    Ok(())
}

fn check_branch_window_predecessor(raw: &RawValue, expected: &str) -> Result<(), StoryError> {
    let mut source = None;
    for member in super::pending::member_iter(raw).map_err(|_| StoryError::Corrupt)? {
        let (key, value) =
            super::pending::raw_member_parts(member).map_err(|_| StoryError::Corrupt)?;
        if super::pending::raw_key_equals(key, "sourceChapterId")
            .map_err(|_| StoryError::Corrupt)?
            && source.replace(value).is_some()
        {
            return Err(StoryError::Corrupt);
        }
    }
    if !super::pending::raw_key_equals(source.ok_or(StoryError::Corrupt)?, expected)
        .map_err(|_| StoryError::Corrupt)?
    {
        return Err(StoryError::Corrupt);
    }
    Ok(())
}

fn page_limit(limit: Option<u32>) -> Result<u32, StoryError> {
    let limit = limit.unwrap_or(DEFAULT_PAGE_SIZE);
    if limit == 0 || limit > MAX_PAGE_SIZE {
        Err(StoryError::Invalid)
    } else {
        Ok(limit)
    }
}
fn bounded_page<T: Serialize>(value: T) -> Result<T, StoryError> {
    if serde_json::to_vec(&value)
        .map_err(|_| StoryError::Corrupt)?
        .len()
        > CANDIDATE_PAGE_BYTES
    {
        return Err(StoryError::TooLarge);
    }
    Ok(value)
}
fn session_head(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionHead> {
    Ok(SessionHead {
        id: row.get(0)?,
        revision: row.get(1)?,
        title_preview: row.get(2)?,
        title_truncated: row.get(3)?,
        mode: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        chapter_count: row.get(7)?,
        last_chapter_id: row.get(8)?,
        chapter_plan: row
            .get::<_, Option<String>>(9)?
            .map(|value| {
                serde_json::from_str(&value).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        9,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
            })
            .transpose()?,
    })
}
fn assert_revision(
    connection: &Connection,
    session_id: &str,
    revision: u64,
) -> Result<(), StoryError> {
    let actual: Option<u64> = connection
        .query_row(
            "SELECT revision FROM arena_story_session WHERE id=?1",
            [session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| StoryError::Io)?;
    match actual {
        Some(value) if value == revision => Ok(()),
        Some(_) => Err(StoryError::Stale),
        None => Err(StoryError::Missing),
    }
}
fn record_metadata(
    connection: &Connection,
    session_id: &str,
    record_id: &str,
    kind: RecordKind,
) -> Result<(i64, u64, String), StoryError> {
    let (table, _, length, digest) = kind.storage();
    let predicate = if matches!(kind, RecordKind::Session | RecordKind::Seed) {
        "id=?1 AND id=?2"
    } else {
        "session_id=?1 AND id=?2"
    };
    connection
        .query_row(
            &format!("SELECT rowid,{length},{digest} FROM {table} WHERE {predicate}"),
            params![session_id, record_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|_| StoryError::Io)?
        .ok_or(StoryError::Missing)
}
impl StoryStore {
    /// Freeze one arbitrary active anchor and its bounded prompt window under a
    /// single connection lock. Full-session head/count remain in BranchSource;
    /// the writer must recheck that source CAS when saving the generated branch.
    pub(crate) fn resolve_branch_anchor(
        &self,
        request: &BranchAnchorRequest,
    ) -> Result<BranchAnchorDescriptors, StoryError> {
        if !valid_id(&request.session_id)
            || !valid_id(&request.expected_last_chapter_id)
            || !valid_id(&request.anchor_chapter_id)
            || !(1..=super::MAX_SAFE_INTEGER).contains(&request.revision)
            || request.expected_chapter_count != request.revision
            || !(1..super::MAX_SAFE_INTEGER).contains(&request.anchor_index)
            || request.anchor_index > request.expected_chapter_count
        {
            return Err(StoryError::Invalid);
        }
        let connection = lock_connection(&self.connection).map_err(StoryError::from_store)?;
        let current: Option<(u64, u64, String)> = connection
            .query_row(
                "SELECT revision,chapter_count,CASE WHEN length(last_chapter_id)<=128 THEN last_chapter_id END FROM arena_story_session WHERE id=?1",
                [&request.session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|_| StoryError::Corrupt)?;
        let (revision, count, head) = current.ok_or(StoryError::Missing)?;
        if revision != request.revision
            || count != request.expected_chapter_count
            || head != request.expected_last_chapter_id
        {
            return Err(StoryError::Stale);
        }
        let descriptor = |kind, id: &str| -> Result<RecordDescriptor, StoryError> {
            let (_, byte_length, digest) =
                record_metadata(&connection, &request.session_id, id, kind)?;
            if !valid_id(id)
                || !(1..=super::CANDIDATE_COMMIT_BYTES).contains(&byte_length)
                || !super::valid_digest(&digest)
            {
                return Err(StoryError::Corrupt);
            }
            Ok(RecordDescriptor {
                instance: self.instance.clone(),
                session_id: request.session_id.clone(),
                record_id: id.to_string(),
                revision,
                kind,
                byte_length,
                digest,
            })
        };
        let anchor = descriptor(RecordKind::Chapter, &request.anchor_chapter_id)?;
        // No receipt check: legitimate copied active chapters use copy markers,
        // not success receipts, and are valid branch anchors themselves.
        connection
            .query_row(
                "SELECT CASE WHEN document_bytes BETWEEN 1 AND ?4 AND length(CAST(document AS BLOB))=document_bytes THEN document END FROM arena_story_chapter WHERE session_id=?1 AND id=?2 AND chapter_index=?3",
                params![request.session_id, request.anchor_chapter_id, request.anchor_index, super::CANDIDATE_COMMIT_BYTES],
                |row| {
                    Ok((|| {
                        let document = row.get_ref(0).map_err(|_| StoryError::Corrupt)?
                            .as_str().map_err(|_| StoryError::Corrupt)?;
                        if super::digest(document.as_bytes()) != anchor.digest {
                            return Err(StoryError::Corrupt);
                        }
                        let raw: &RawValue = serde_json::from_str(document).map_err(|_| StoryError::Corrupt)?;
                        check_branch_anchor(raw, request)
                    })())
                },
            )
            .optional()
            .map_err(|_| StoryError::Corrupt)?
            .ok_or(StoryError::Stale)??;
        let checkpoint: Option<String> = connection
            .query_row(
                "SELECT CASE WHEN length(id)<=128 THEN id END FROM arena_story_checkpoint WHERE session_id=?1 AND boundary_index=?2 AND chapter_id=?3",
                params![request.session_id, request.anchor_index, request.anchor_chapter_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| StoryError::Corrupt)?;
        let checkpoint = checkpoint.ok_or(StoryError::Corrupt)?;
        let mut statement = connection.prepare(
            "SELECT CASE WHEN length(id)<=128 THEN id END FROM arena_story_chapter WHERE session_id=?1 AND chapter_index<=?2 ORDER BY chapter_index DESC LIMIT 12",
        ).map_err(|_| StoryError::Io)?;
        let ids = statement
            .query_map(params![request.session_id, request.anchor_index], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|_| StoryError::Io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| StoryError::Corrupt)?;
        let recent_chapters = ids
            .iter()
            .rev()
            .map(|id| descriptor(RecordKind::Chapter, id))
            .collect::<Result<Vec<_>, _>>()?;
        if request.anchor_index > 12 {
            // The renderer cannot compare the first window row with an omitted
            // predecessor. Check just this edge against the real index-1 row;
            // neither that predecessor's document nor the prefix is hydrated.
            let first = recent_chapters.first().ok_or(StoryError::Corrupt)?;
            connection
                .query_row(
                    "SELECT CASE WHEN c.document_bytes BETWEEN 1 AND ?4 AND length(CAST(c.document AS BLOB))=c.document_bytes THEN c.document END,CASE WHEN length(p.id)<=128 THEN p.id END FROM arena_story_chapter c JOIN arena_story_chapter p ON p.session_id=c.session_id AND p.chapter_index=c.chapter_index-1 WHERE c.session_id=?1 AND c.id=?2 AND c.chapter_index=?3 AND c.source_chapter_id=p.id",
                    params![request.session_id, first.record_id, request.anchor_index - 11, super::CANDIDATE_COMMIT_BYTES],
                    |row| {
                        Ok((|| {
                            let document = row.get_ref(0).map_err(|_| StoryError::Corrupt)?
                                .as_str().map_err(|_| StoryError::Corrupt)?;
                            let previous = row.get_ref(1).map_err(|_| StoryError::Corrupt)?
                                .as_str().map_err(|_| StoryError::Corrupt)?;
                            if !valid_id(previous) || super::digest(document.as_bytes()) != first.digest {
                                return Err(StoryError::Corrupt);
                            }
                            let raw: &RawValue = serde_json::from_str(document).map_err(|_| StoryError::Corrupt)?;
                            check_branch_window_predecessor(raw, previous)
                        })())
                    },
                )
                .optional()
                .map_err(|_| StoryError::Corrupt)?
                .ok_or(StoryError::Corrupt)??;
        }
        bounded_page(BranchAnchorDescriptors {
            source: BranchSource {
                session: descriptor(RecordKind::Session, &request.session_id)?,
                seed: descriptor(RecordKind::Seed, &request.session_id)?,
                expected_last_chapter_id: head,
                expected_chapter_count: count,
                anchor,
                anchor_index: request.anchor_index,
                checkpoint: descriptor(RecordKind::Checkpoint, &checkpoint)?,
            },
            recent_chapters,
        })
    }

    pub fn list_sessions(
        &self,
        cursor: Option<SessionCursor>,
        limit: Option<u32>,
    ) -> Result<SessionPage, StoryError> {
        let limit = page_limit(limit)?;
        if cursor
            .as_ref()
            .is_some_and(|c| !valid_id(&c.id) || c.updated_at > super::MAX_SAFE_INTEGER)
        {
            return Err(StoryError::Invalid);
        }
        let connection = lock_connection(&self.connection).map_err(StoryError::from_store)?;
        let mut statement = connection.prepare("SELECT id,revision,title_preview,title_truncated,mode,created_at,updated_at,chapter_count,last_chapter_id,chapter_plan FROM arena_story_session WHERE (?1 IS NULL OR updated_at < ?1 OR (updated_at=?1 AND id<?2)) ORDER BY updated_at DESC,id DESC LIMIT ?3").map_err(|_| StoryError::Io)?;
        let mut rows = statement
            .query_map(
                params![
                    cursor.as_ref().map(|c| c.updated_at),
                    cursor.as_ref().map(|c| &c.id),
                    limit + 1
                ],
                session_head,
            )
            .map_err(|_| StoryError::Io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| StoryError::Corrupt)?;
        let next_cursor = if rows.len() > limit as usize {
            rows.pop();
            rows.last().map(|row| SessionCursor {
                updated_at: row.updated_at,
                id: row.id.clone(),
            })
        } else {
            None
        };
        bounded_page(SessionPage { rows, next_cursor })
    }
    pub fn list_chapters(
        &self,
        session_id: &str,
        revision: u64,
        cursor: Option<ChapterCursor>,
        limit: Option<u32>,
    ) -> Result<ChapterPage, StoryError> {
        let limit = page_limit(limit)?;
        if !valid_id(session_id)
            || cursor
                .as_ref()
                .is_some_and(|c| !valid_id(&c.id) || c.index > super::MAX_SAFE_INTEGER)
        {
            return Err(StoryError::Invalid);
        }
        let connection = lock_connection(&self.connection).map_err(StoryError::from_store)?;
        assert_revision(&connection, session_id, revision)?;
        let mut statement = connection.prepare("SELECT id,chapter_index,action,title_preview,title_truncated,created_at,markdown_bytes FROM arena_story_chapter WHERE session_id=?1 AND (?2 IS NULL OR chapter_index>?2 OR (chapter_index=?2 AND id>?3)) ORDER BY chapter_index ASC,id ASC LIMIT ?4").map_err(|_| StoryError::Io)?;
        let mut rows = statement
            .query_map(
                params![
                    session_id,
                    cursor.as_ref().map(|c| c.index),
                    cursor.as_ref().map(|c| &c.id),
                    limit + 1
                ],
                |row| {
                    Ok(ChapterHead {
                        id: row.get(0)?,
                        index: row.get(1)?,
                        action: row.get(2)?,
                        status: "active".to_string(),
                        title_preview: row.get(3)?,
                        title_truncated: row.get(4)?,
                        created_at: row.get(5)?,
                        markdown_byte_length: row.get(6)?,
                    })
                },
            )
            .map_err(|_| StoryError::Io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| StoryError::Corrupt)?;
        let next_cursor = if rows.len() > limit as usize {
            rows.pop();
            rows.last().map(|row| ChapterCursor {
                index: row.index,
                id: row.id.clone(),
            })
        } else {
            None
        };
        bounded_page(ChapterPage {
            session_id: session_id.to_string(),
            revision,
            rows,
            next_cursor,
        })
    }
    pub fn describe_record(
        &self,
        session_id: &str,
        revision: u64,
        kind: RecordKind,
        record_id: &str,
    ) -> Result<RecordDescriptor, StoryError> {
        if !valid_id(session_id) || !valid_id(record_id) {
            return Err(StoryError::Invalid);
        }
        let connection = lock_connection(&self.connection).map_err(StoryError::from_store)?;
        assert_revision(&connection, session_id, revision)?;
        let (_, byte_length, digest) = record_metadata(&connection, session_id, record_id, kind)?;
        Ok(RecordDescriptor {
            instance: self.instance.clone(),
            session_id: session_id.to_string(),
            record_id: record_id.to_string(),
            revision,
            kind,
            byte_length,
            digest,
        })
    }
    /// Raw return bytes; no number[], base64, full-record JSON or caller file path.
    /// A blob handle exists only under this read's connection lock and never crosses
    /// IPC calls, append commits, maintenance/restore or process restart.
    pub fn read_record_chunk(
        &self,
        descriptor: &RecordDescriptor,
        offset: u64,
        length: usize,
    ) -> Result<Vec<u8>, StoryError> {
        if descriptor.instance != self.instance
            || !valid_id(&descriptor.session_id)
            || !valid_id(&descriptor.record_id)
        {
            return Err(StoryError::Stale);
        }
        if length == 0 || length > CANDIDATE_FRAME_BYTES || offset >= descriptor.byte_length {
            return Err(StoryError::Invalid);
        }
        let connection = lock_connection(&self.connection).map_err(StoryError::from_store)?;
        assert_revision(&connection, &descriptor.session_id, descriptor.revision)?;
        let (rowid, byte_length, digest) = record_metadata(
            &connection,
            &descriptor.session_id,
            &descriptor.record_id,
            descriptor.kind,
        )?;
        if byte_length != descriptor.byte_length || digest != descriptor.digest {
            return Err(StoryError::Stale);
        }
        let (table, column, _, _) = descriptor.kind.storage();
        let mut blob = connection
            .blob_open("main", table, column, rowid, true)
            .map_err(|_| StoryError::Corrupt)?;
        if blob.len() as u64 != byte_length {
            return Err(StoryError::Corrupt);
        }
        blob.seek(SeekFrom::Start(offset))
            .map_err(|_| StoryError::Io)?;
        let count = length.min((byte_length - offset) as usize);
        let mut bytes = vec![0; count];
        blob.read_exact(&mut bytes).map_err(|_| StoryError::Io)?;
        Ok(bytes)
    }
    /// Only twelve immutable chapter identities and the current checkpoint. The TS
    /// domain owns the two-full-text / digest context projection and final 12MiB gate.
    pub fn continue_descriptors(
        &self,
        session_id: &str,
        revision: u64,
        expected_head: &str,
    ) -> Result<ContinueDescriptors, StoryError> {
        if !valid_id(session_id) || !valid_id(expected_head) {
            return Err(StoryError::Invalid);
        }
        let connection = lock_connection(&self.connection).map_err(StoryError::from_store)?;
        assert_revision(&connection, session_id, revision)?;
        let head = connection.query_row("SELECT id,revision,title_preview,title_truncated,mode,created_at,updated_at,chapter_count,last_chapter_id,chapter_plan FROM arena_story_session WHERE id=?1",[session_id],session_head).map_err(|_| StoryError::Io)?;
        if head.last_chapter_id != expected_head {
            return Err(StoryError::Stale);
        }
        let checkpoint: String = connection
            .query_row(
                "SELECT working_checkpoint_id FROM arena_story_session WHERE id=?1",
                [session_id],
                |row| row.get(0),
            )
            .map_err(|_| StoryError::Io)?;
        let descriptor = |kind, id: &str| -> Result<RecordDescriptor, StoryError> {
            let (_, byte_length, digest) = record_metadata(&connection, session_id, id, kind)?;
            Ok(RecordDescriptor {
                instance: self.instance.clone(),
                session_id: session_id.to_string(),
                record_id: id.to_string(),
                revision,
                kind,
                byte_length,
                digest,
            })
        };
        let mut statement = connection.prepare("SELECT id FROM arena_story_chapter WHERE session_id=?1 ORDER BY chapter_index DESC LIMIT 12").map_err(|_|StoryError::Io)?;
        let ids = statement
            .query_map([session_id], |row| row.get::<_, String>(0))
            .map_err(|_| StoryError::Io)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| StoryError::Corrupt)?;
        let recent_chapters = ids
            .iter()
            .rev()
            .map(|id| descriptor(RecordKind::Chapter, id))
            .collect::<Result<Vec<_>, _>>()?;
        bounded_page(ContinueDescriptors {
            session: descriptor(RecordKind::Session, session_id)?,
            seed: descriptor(RecordKind::Seed, session_id)?,
            checkpoint: descriptor(RecordKind::Checkpoint, &checkpoint)?,
            recent_chapters,
            head,
        })
    }
}
