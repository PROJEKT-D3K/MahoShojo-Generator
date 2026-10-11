//! Schema-11 candidate behind the explicit version gate. A rewrite preserves every historical record
//! and receipt, replacing only the current tail and its working checkpoint.
use super::{authority, chapter_index, checkpoint_index, materialize, optional_id, required};
use crate::arena_story::read::{RecordDescriptor, RecordKind};
use crate::arena_story::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

const WIRE_BYTES: usize = 2048;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum TailRewriteKind {
    #[serde(rename = "tail-rewrite")]
    TailRewrite,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceProof {
    pub byte_length: u64,
    pub digest: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TailRewriteSource {
    pub expected_instance: String,
    pub expected_revision: u64,
    pub expected_chapter_count: u64,
    pub target_chapter_id: String,
    pub input_checkpoint_id: String,
    pub session: SourceProof,
    pub chapter: SourceProof,
    pub input_checkpoint: SourceProof,
}
impl TailRewriteSource {
    fn validate(&self) -> Result<(), StoryError> {
        if self.expected_instance.len() != 32
            || !self
                .expected_instance
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !(1..MAX_SAFE_INTEGER).contains(&self.expected_revision)
            || !(1..=self.expected_revision).contains(&self.expected_chapter_count)
            || !valid_id(&self.target_chapter_id)
            || !valid_id(&self.input_checkpoint_id)
        {
            return Err(StoryError::Invalid);
        }
        for proof in [&self.session, &self.chapter, &self.input_checkpoint] {
            if !(1..=CANDIDATE_COMMIT_BYTES).contains(&proof.byte_length)
                || !valid_digest(&proof.digest)
            {
                return Err(StoryError::Invalid);
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TailRewriteManifest {
    pub version: u32,
    pub kind: TailRewriteKind,
    pub operation_id: String,
    pub session_id: String,
    pub source: TailRewriteSource,
    pub parts: Vec<PartDeclaration>,
}
impl TailRewriteManifest {
    pub(crate) fn decode(text: &str) -> Result<Self, StoryError> {
        if text.len() > WIRE_BYTES {
            return Err(StoryError::TooLarge);
        }
        let manifest: Self = serde_json::from_str(text).map_err(|_| StoryError::Invalid)?;
        manifest.linear_carrier()?;
        Ok(manifest)
    }
    fn linear_carrier(&self) -> Result<CommitManifest, StoryError> {
        self.source.validate()?;
        if self.version != 3
            || self.operation_id == self.source.target_chapter_id
            || self.operation_id == self.source.input_checkpoint_id
        {
            return Err(StoryError::Invalid);
        }
        let carrier = CommitManifest {
            version: 1,
            operation_id: self.operation_id.clone(),
            session_id: self.session_id.clone(),
            expected_revision: self.source.expected_revision,
            expected_last_chapter_id: Some(self.source.target_chapter_id.clone()),
            parts: self.parts.clone(),
        };
        carrier.validate()?;
        if serde_json::to_vec(self)
            .map_err(|_| StoryError::Invalid)?
            .len()
            > WIRE_BYTES
        {
            return Err(StoryError::TooLarge);
        }
        Ok(carrier)
    }
    pub(crate) fn request_digest(&self) -> Result<String, StoryError> {
        self.linear_carrier()?;
        // Closed Rust struct field order is the protocol order; no arbitrary
        // JSON object map or optional serde preserve_order feature participates.
        let mut hash = Sha256::new();
        hash.update(b"arena-story-tail-rewrite-wire-v3\n");
        hash.update(serde_json::to_vec(self).map_err(|_| StoryError::Invalid)?);
        Ok(format!("sha256:{:x}", hash.finalize()))
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TailRewriteReceipt {
    pub version: u32,
    pub kind: TailRewriteKind,
    pub operation_id: String,
    pub session_id: String,
    pub chapter_id: String,
    pub chapter_index: u64,
    pub revision: u64,
    pub chapter_count: u64,
    pub target_chapter_id: String,
    pub input_checkpoint_id: String,
    pub checkpoint_id: String,
    pub request_digest: String,
}
impl TailRewriteReceipt {
    pub(super) fn validate(&self) -> Result<(), StoryError> {
        if self.version != 3
            || self.operation_id != self.chapter_id
            || !(1..=MAX_SAFE_INTEGER).contains(&self.chapter_index)
            || self.chapter_count != self.chapter_index
            || !(1..=MAX_SAFE_INTEGER).contains(&self.revision)
            || self.revision <= self.chapter_count
            || !valid_digest(&self.request_digest)
            || [
                &self.operation_id,
                &self.session_id,
                &self.chapter_id,
                &self.target_chapter_id,
                &self.input_checkpoint_id,
                &self.checkpoint_id,
            ]
            .iter()
            .any(|id| !valid_id(id))
            || self.chapter_id == self.target_chapter_id
            || self.checkpoint_id == self.input_checkpoint_id
            || self.checkpoint_id == self.chapter_id
            || self.input_checkpoint_id == self.chapter_id
        {
            return Err(StoryError::Corrupt);
        }
        Ok(())
    }
    pub(crate) fn encode(&self) -> Result<String, StoryError> {
        self.validate()?;
        let text = serde_json::to_string(self).map_err(|_| StoryError::Corrupt)?;
        if text.len() > WIRE_BYTES {
            return Err(StoryError::TooLarge);
        }
        Ok(text)
    }
    pub(super) fn decode(text: &str) -> Result<Self, StoryError> {
        if text.len() > WIRE_BYTES {
            return Err(StoryError::Corrupt);
        }
        let receipt: Self = serde_json::from_str(text).map_err(|_| StoryError::Corrupt)?;
        receipt.validate()?;
        Ok(receipt)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TailRewriteSourceRequest {
    pub session_id: String,
    pub expected_revision: u64,
    pub expected_chapter_count: u64,
    pub target_chapter_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TailRewriteSourceDescriptors {
    pub source: TailRewriteSource,
    pub seed: RecordDescriptor,
    pub recent_chapters: Vec<RecordDescriptor>,
}
fn schema_gate(c: &Connection) -> Result<(), StoryError> {
    if !super::history::enabled(c)? {
        return Err(StoryError::Invalid);
    }
    super::history::verify_schema(c, 11)
}
fn proof(
    c: &Connection,
    session: &str,
    id: &str,
    kind: RecordKind,
) -> Result<SourceProof, StoryError> {
    let (_, byte_length, digest) = read::record_metadata(c, session, id, kind)?;
    if !(1..=CANDIDATE_COMMIT_BYTES).contains(&byte_length) || !valid_digest(&digest) {
        return Err(StoryError::Corrupt);
    }
    Ok(SourceProof {
        byte_length,
        digest,
    })
}
fn checked_source<T>(
    c: &Connection,
    kind: RecordKind,
    id: &str,
    proof: &SourceProof,
    use_source: impl FnOnce(super::CheckedCopySource<'_>) -> Result<T, StoryError>,
) -> Result<T, StoryError> {
    let table = match kind {
        RecordKind::Session => "arena_story_session",
        RecordKind::Chapter => "arena_story_chapter",
        RecordKind::Checkpoint => "arena_story_checkpoint",
        _ => return Err(StoryError::Invalid),
    };
    super::storage::read_document(
        c,
        table,
        "document",
        "document_bytes",
        "document_digest",
        id,
        |source| {
            if source.byte_length() != proof.byte_length || source.digest() != proof.digest {
                return Err(StoryError::Stale);
            }
            use_source(source)
        },
    )
}
fn check_source(c: &Connection, session: &str, s: &TailRewriteSource) -> Result<(), StoryError> {
    let valid: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM arena_story_session s JOIN arena_story_chapter t ON t.session_id=s.id AND t.id=s.last_chapter_id JOIN arena_story_checkpoint p ON p.session_id=s.id AND p.id=s.last_input_checkpoint_id WHERE s.id=?1 AND s.revision=?2 AND s.chapter_count=?3 AND t.id=?4 AND t.chapter_index=s.chapter_count AND t.status='active' AND t.superseded_by_chapter_id IS NULL AND t.committed_revision=s.revision AND p.id=?5 AND p.boundary_index=s.chapter_count-1 AND ((p.boundary_index=0 AND p.chapter_id IS NULL) OR EXISTS(SELECT 1 FROM arena_story_chapter a WHERE a.session_id=s.id AND a.id=p.chapter_id AND a.chapter_index=p.boundary_index AND a.status='active'))) ", params![session,s.expected_revision,s.expected_chapter_count,s.target_chapter_id,s.input_checkpoint_id],|r| r.get(0)).map_err(|_| StoryError::Corrupt)?;
    if !valid {
        return Err(StoryError::Stale);
    }
    for (kind, id, p) in [
        (RecordKind::Session, session, &s.session),
        (
            RecordKind::Chapter,
            s.target_chapter_id.as_str(),
            &s.chapter,
        ),
        (
            RecordKind::Checkpoint,
            s.input_checkpoint_id.as_str(),
            &s.input_checkpoint,
        ),
    ] {
        checked_source(c, kind, id, p, |_| Ok(()))?;
    }
    // Includes indexed/raw agreement, all receipt versions, chapter-owned CPs,
    // and immutable provenance. The auditor keeps only one large record at once.
    super::audit::audit_session(c, session)
}
impl StoryStore {
    pub(crate) fn resolve_tail_rewrite_source(
        &self,
        request: &TailRewriteSourceRequest,
    ) -> Result<TailRewriteSourceDescriptors, StoryError> {
        if !valid_id(&request.session_id)
            || !valid_id(&request.target_chapter_id)
            || !(1..MAX_SAFE_INTEGER).contains(&request.expected_revision)
            || !(1..=request.expected_revision).contains(&request.expected_chapter_count)
        {
            return Err(StoryError::Invalid);
        }
        let _permit = self
            .gate
            .enter_write()
            .map_err(|_| StoryError::Maintenance)?;
        let c = lock_connection(&self.connection).map_err(StoryError::from_store)?;
        schema_gate(&c)?;
        let input: Option<String> = c.query_row("SELECT last_input_checkpoint_id FROM arena_story_session WHERE id=?1 AND revision=?2 AND chapter_count=?3 AND last_chapter_id=?4",params![request.session_id,request.expected_revision,request.expected_chapter_count,request.target_chapter_id],|r|r.get(0)).optional().map_err(|_|StoryError::Corrupt)?;
        let input = input.ok_or(StoryError::Stale)?;
        let s = TailRewriteSource {
            expected_instance: self.instance.clone(),
            expected_revision: request.expected_revision,
            expected_chapter_count: request.expected_chapter_count,
            target_chapter_id: request.target_chapter_id.clone(),
            input_checkpoint_id: input.clone(),
            session: proof(
                &c,
                &request.session_id,
                &request.session_id,
                RecordKind::Session,
            )?,
            chapter: proof(
                &c,
                &request.session_id,
                &request.target_chapter_id,
                RecordKind::Chapter,
            )?,
            input_checkpoint: proof(&c, &request.session_id, &input, RecordKind::Checkpoint)?,
        };
        s.validate()?;
        check_source(&c, &request.session_id, &s)?;
        let descriptor = |kind, id: &str| -> Result<RecordDescriptor, StoryError> {
            let p = proof(&c, &request.session_id, id, kind)?;
            Ok(RecordDescriptor {
                instance: self.instance.clone(),
                session_id: request.session_id.clone(),
                record_id: id.into(),
                revision: request.expected_revision,
                kind,
                byte_length: p.byte_length,
                digest: p.digest,
            })
        };
        let mut statement=c.prepare("SELECT id FROM arena_story_chapter WHERE session_id=?1 AND status='active' AND chapter_index BETWEEN ?2 AND ?3 ORDER BY chapter_index").map_err(|_|StoryError::Corrupt)?;
        let ids = statement
            .query_map(
                params![
                    request.session_id,
                    request.expected_chapter_count.saturating_sub(11).max(1),
                    request.expected_chapter_count
                ],
                |r| r.get::<_, String>(0),
            )
            .map_err(|_| StoryError::Corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| StoryError::Corrupt)?;
        if ids.len() != request.expected_chapter_count.min(12) as usize
            || ids.last() != Some(&request.target_chapter_id)
        {
            return Err(StoryError::Corrupt);
        }
        Ok(TailRewriteSourceDescriptors {
            source: s,
            seed: descriptor(RecordKind::Seed, &request.session_id)?,
            recent_chapters: ids
                .iter()
                .map(|id| descriptor(RecordKind::Chapter, id))
                .collect::<Result<Vec<_>, _>>()?,
        })
    }
    pub(crate) fn begin_tail_rewrite(
        &self,
        manifest: TailRewriteManifest,
        now: Instant,
    ) -> Result<BeginOutcome, StoryError> {
        let carrier = manifest.linear_carrier()?;
        let _permit = self
            .gate
            .enter_write()
            .map_err(|_| StoryError::Maintenance)?;
        {
            let c = lock_connection(&self.connection).map_err(StoryError::from_store)?;
            schema_gate(&c)?;
        }
        self.begin_stage(carrier, None, Some(manifest), now)
    }
    pub(crate) fn tail_rewrite_receipt(
        &self,
        session: &str,
        operation: &str,
        request_digest: &str,
    ) -> Result<Option<TailRewriteReceipt>, StoryError> {
        if !valid_id(session) || !valid_id(operation) || !valid_digest(request_digest) {
            return Err(StoryError::Invalid);
        }
        let stages = self.stages.lock().map_err(|_| StoryError::Io)?;
        if let Some(fence) = stages.branch_unknown.get(operation) {
            if fence.session_id != session || fence.request_digest != request_digest {
                return Err(StoryError::OperationMismatch);
            }
        }
        let c = lock_connection(&self.connection).map_err(StoryError::from_store)?;
        read_tail_rewrite_receipt(&c, session, operation, request_digest)
    }
    pub(crate) fn end_tail_rewrite(
        &self,
        token: &str,
        now: Instant,
    ) -> Result<TailRewriteReceipt, StoryError> {
        self.end_tail_rewrite_with_hook(token, now, &mut |_, _| Ok(()))
    }
    fn end_tail_rewrite_with_hook(
        &self,
        token: &str,
        now: Instant,
        hook: &mut impl FnMut(&str, &Connection) -> Result<(), StoryError>,
    ) -> Result<TailRewriteReceipt, StoryError> {
        let mut stages = self.stages.lock().map_err(|_| StoryError::Io)?;
        stages.retain(|_, s| now.saturating_duration_since(s.created_at) < STAGE_LIFETIME);
        if let Some((operation, fence)) = stages
            .branch_unknown
            .iter()
            .find(|(_, f)| f.tokens.iter().any(|old| old == token))
        {
            let c = lock_connection(&self.connection).map_err(StoryError::from_store)?;
            return read_tail_rewrite_receipt(
                &c,
                &fence.session_id,
                operation,
                &fence.request_digest,
            )?
            .ok_or(StoryError::CommitUnknown);
        }
        let stage = stages.get_mut(token).ok_or(StoryError::Stale)?;
        let m = stage.tail_rewrite.clone().ok_or(StoryError::Invalid)?;
        let request_digest = m.request_digest()?;
        let mut unknown = false;
        let result = (|| {
            let _permit = self
                .gate
                .enter_write()
                .map_err(|_| StoryError::Maintenance)?;
            let mut c = lock_connection(&self.connection).map_err(StoryError::from_store)?;
            schema_gate(&c)?;
            let tx = c
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|_| StoryError::Io)?;
            // Receipt lookup precedes instance, source CAS, and upload completeness.
            let outcome = (|| {
                if let Some(receipt) =
                    read_tail_rewrite_receipt(&tx, &m.session_id, &m.operation_id, &request_digest)?
                {
                    return Ok((receipt, true));
                }
                if m.source.expected_instance != self.instance {
                    return Err(StoryError::Stale);
                }
                if stage.current != stage.parts.len() {
                    return Err(StoryError::Incomplete);
                }
                check_source(&tx, &m.session_id, &m.source)?;
                hook("source-cas", &tx)?;
                let validated = validate_stage(&tx, stage, &m, request_digest.clone())?;
                hook("validated", &tx)?;
                write_stage(&tx, stage, &m, &validated, &mut |step| hook(step, &tx))?;
                hook("before-commit", &tx)?;
                Ok((validated.receipt, false))
            })();
            let (receipt, replay) = match outcome {
                Ok(value) => value,
                Err(error) => {
                    tx.rollback().map_err(|_| {
                        unknown = true;
                        StoryError::CommitUnknown
                    })?;
                    return Err(error);
                }
            };
            if replay {
                tx.rollback().map_err(|_| {
                    unknown = true;
                    StoryError::CommitUnknown
                })?;
                return Ok(receipt);
            }
            unknown = true;
            tx.commit().map_err(|_| StoryError::CommitUnknown)?;
            hook("after-commit", &c).map_err(|_| StoryError::CommitUnknown)?;
            Ok(receipt)
        })();
        if unknown && result.is_err() {
            stages.fence_operation(&m.operation_id, &m.session_id, request_digest);
        } else if result.is_ok() {
            stages.remove(token);
        }
        result
    }
}
pub(super) fn read_tail_rewrite_receipt(
    c: &Connection,
    session: &str,
    operation: &str,
    expected: &str,
) -> Result<Option<TailRewriteReceipt>, StoryError> {
    schema_gate(c)?;
    type Row = (String, String, u64, String, Option<String>, String);
    let row:Option<Row>=c.query_row("SELECT session_id,id,chapter_index,operation_digest,CASE WHEN length(CAST(receipt AS BLOB))<=2048 THEN receipt END,action FROM arena_story_chapter WHERE operation_id=?1",[operation],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(|_|StoryError::Corrupt)?;
    row.map(|(stored_session, id, index, digest, document, action)| {
        if stored_session != session || digest != expected {
            return Err(StoryError::OperationMismatch);
        }
        let document = document.ok_or(StoryError::Corrupt)?;
        let receipt = TailRewriteReceipt::decode(&document)?;
        super::history::audit_rewrite_receipt(c, session, &id, index, &action, &digest, &document)?;
        if receipt.operation_id != operation {
            return Err(StoryError::Corrupt);
        }
        Ok(receipt)
    })
    .transpose()
}

#[path = "arena_story_tail_rewrite_raw.rs"]
mod raw;

struct ValidatedTailRewrite {
    session: SessionIndex,
    session_document: String,
    chapter: ChapterIndex,
    checkpoint: CheckpointIndex,
    receipt: TailRewriteReceipt,
}
fn staged(stage: &mut Stage, kind: PartKind) -> Result<String, StoryError> {
    read_part(
        stage
            .parts
            .iter_mut()
            .find(|part| part.declaration.kind == kind)
            .ok_or(StoryError::Invalid)?,
    )
}
fn validate_stage(
    c: &Connection,
    stage: &mut Stage,
    m: &TailRewriteManifest,
    request_digest: String,
) -> Result<ValidatedTailRewrite, StoryError> {
    let session_document = {
        let candidate = staged(stage, PartKind::Session)?;
        checked_source(
            c,
            RecordKind::Session,
            &m.session_id,
            &m.source.session,
            |source| {
                raw::merge_session(
                    source.document(),
                    &candidate,
                    m.source.expected_chapter_count,
                )
            },
        )?
    };
    let session = super::audit::session_index(
        serde_json::from_str(&session_document).map_err(|_| StoryError::Invalid)?,
    )?;
    let chapter = {
        let document = staged(stage, PartKind::Chapter)?;
        let raw = serde_json::from_str(&document).map_err(|_| StoryError::Invalid)?;
        let fields = authority(raw, super::CHAPTER_AUTHORITY)?;
        validate_chapter_carrier(
            fields.get("markdown").ok_or(StoryError::Invalid)?,
            fields.get("reportJson").ok_or(StoryError::Invalid)?,
            fields
                .get("deterministicDigest")
                .ok_or(StoryError::Invalid)?,
        )?;
        if optional_id(&fields, "supersededByChapterId")?.is_some() {
            return Err(StoryError::Invalid);
        }
        if let Some(value) = fields
            .get("generationId")
            .filter(|value| value.get() != "null")
        {
            pending::string_units(value)?;
        }
        if fields
            .get("cardSnapshot")
            .is_some_and(|value| !value.get().starts_with('{'))
        {
            return Err(StoryError::Invalid);
        }
        pending::string_units(fields.get("title").ok_or(StoryError::Invalid)?)?;
        let chapter = chapter_index(&fields)?;
        let markdown_bytes: u64 = char::decode_utf16(pending::string_units(
            fields.get("markdown").ok_or(StoryError::Invalid)?,
        )?)
        .map(|value| value.unwrap_or('\u{fffd}').len_utf8() as u64)
        .sum();
        if markdown_bytes != chapter.markdown_byte_length {
            return Err(StoryError::Invalid);
        }
        chapter
    };
    let checkpoint = {
        let document = staged(stage, PartKind::Checkpoint1)?;
        let raw = serde_json::from_str(&document).map_err(|_| StoryError::Invalid)?;
        let fields = authority(raw, super::CHECKPOINT_AUTHORITY)?;
        validate_checkpoint_carrier(fields.get("combatants").ok_or(StoryError::Invalid)?)?;
        if required::<u64>(&fields, "createdAt")? != session.updated_at {
            return Err(StoryError::Invalid);
        }
        checkpoint_index(&fields)?
    };
    let s = &m.source;
    let original = checked_source(
        c,
        RecordKind::Session,
        &m.session_id,
        &s.session,
        |source| super::audit::session_index(source.raw()),
    )?;
    if session.id != m.session_id
        || session.revision != s.expected_revision + 1
        || session.chapter_count != s.expected_chapter_count
        || session.last_chapter_id != m.operation_id
        || session.working_checkpoint_id != checkpoint.id
        || session.last_input_checkpoint_id != s.input_checkpoint_id
        || session.created_at != original.created_at
        || session.updated_at < original.updated_at
        || session.updated_at > MAX_SAFE_INTEGER
        || session.created_at > session.updated_at
        || !preview_valid(&session.title_preview)
        || !["classic", "kizuna", "daily", "scenario"].contains(&session.mode.as_str())
        || session.source.mode != session.mode
        || session.chapter_plan.as_ref().is_some_and(|p| {
            !(1..=20).contains(&p.total_chapters)
                || p.total_chapters < session.chapter_count
                || !["user", "scenario"].contains(&p.source.as_str())
        })
        || chapter.id != m.operation_id
        || chapter.session_id != m.session_id
        || chapter.index != s.expected_chapter_count
        || chapter.action != "rewrite"
        || chapter.status != "active"
        || chapter.source_chapter_id.as_deref() != Some(&s.target_chapter_id)
        || chapter.created_at != session.updated_at
        || !preview_valid(&chapter.title_preview)
        || chapter.markdown_byte_length > MAX_SAFE_INTEGER
        || !valid_id(&checkpoint.id)
        || checkpoint.session_id != m.session_id
        || checkpoint.boundary_index != s.expected_chapter_count
        || checkpoint.chapter_id.as_deref() != Some(&m.operation_id)
        || checkpoint.id == s.input_checkpoint_id
        || checkpoint.id == m.operation_id
    {
        return Err(StoryError::Invalid);
    }
    let collision:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM arena_story_chapter WHERE id IN (?1,?2) OR operation_id IN (?1,?2) UNION ALL SELECT 1 FROM arena_story_checkpoint WHERE id IN (?1,?2))",params![m.operation_id,checkpoint.id],|r|r.get(0)).map_err(|_|StoryError::Corrupt)?;
    if collision {
        return Err(StoryError::Conflict);
    }
    let receipt = TailRewriteReceipt {
        version: 3,
        kind: TailRewriteKind::TailRewrite,
        operation_id: m.operation_id.clone(),
        session_id: m.session_id.clone(),
        chapter_id: m.operation_id.clone(),
        chapter_index: s.expected_chapter_count,
        revision: s.expected_revision + 1,
        chapter_count: s.expected_chapter_count,
        target_chapter_id: s.target_chapter_id.clone(),
        input_checkpoint_id: s.input_checkpoint_id.clone(),
        checkpoint_id: checkpoint.id.clone(),
        request_digest,
    };
    receipt.encode()?;
    Ok(ValidatedTailRewrite {
        session,
        session_document,
        chapter,
        checkpoint,
        receipt,
    })
}
fn write_stage(
    c: &Connection,
    stage: &mut Stage,
    m: &TailRewriteManifest,
    v: &ValidatedTailRewrite,
    hook: &mut impl FnMut(&str) -> Result<(), StoryError>,
) -> Result<(), StoryError> {
    checked_source(
        c,
        RecordKind::Chapter,
        &m.source.target_chapter_id,
        &m.source.chapter,
        |source| {
            let fields = authority(source.raw(), super::CHAPTER_AUTHORITY)?;
            let document = materialize(
                source.document(),
                &fields,
                &[
                    ("status", "\"superseded\"".into()),
                    (
                        "supersededByChapterId",
                        serde_json::to_string(&m.operation_id).map_err(|_| StoryError::Invalid)?,
                    ),
                ],
            )?;
            let changed=c.execute("UPDATE arena_story_chapter SET status='superseded',superseded_by_chapter_id=?2,document=?3,document_bytes=?4,document_digest=?5 WHERE id=?1 AND session_id=?6 AND status='active' AND superseded_by_chapter_id IS NULL",params![m.source.target_chapter_id,m.operation_id,document,document.len() as u64,digest(document.as_bytes()),m.session_id]).map_err(|_|StoryError::Io)?;
            if changed != 1 {
                return Err(StoryError::Conflict);
            }
            Ok(())
        },
    )?;
    hook("superseded")?;
    {
        let a = &v.chapter;
        let document = staged(stage, PartKind::Chapter)?;
        c.execute("INSERT INTO arena_story_chapter (id,session_id,chapter_index,action,source_chapter_id,title_preview,title_truncated,created_at,markdown_bytes,document,document_bytes,document_digest,operation_id,operation_digest,receipt,status,superseded_by_chapter_id,committed_revision) VALUES (?1,?2,?3,'rewrite',?4,?5,?6,?7,?8,?9,?10,?11,?1,?12,?13,'active',NULL,?14)",params![a.id,a.session_id,a.index,a.source_chapter_id,a.title_preview,a.title_truncated,a.created_at,a.markdown_byte_length,document,document.len() as u64,digest(document.as_bytes()),v.receipt.request_digest,v.receipt.encode()?,v.receipt.revision]).map_err(|_|StoryError::Io)?;
    }
    hook("chapter")?;
    {
        let p = &v.checkpoint;
        let document = staged(stage, PartKind::Checkpoint1)?;
        c.execute("INSERT INTO arena_story_checkpoint (id,session_id,boundary_index,chapter_id,document,document_bytes,document_digest) VALUES (?1,?2,?3,?4,?5,?6,?7)",params![p.id,p.session_id,p.boundary_index,p.chapter_id,document,document.len() as u64,digest(document.as_bytes())]).map_err(|_|StoryError::Io)?;
    }
    hook("checkpoint")?;
    let s = &v.session;
    let document = &v.session_document;
    let changed=c.execute("UPDATE arena_story_session SET document=?2,document_bytes=?3,document_digest=?4,revision=?5,updated_at=?6,last_chapter_id=?7,working_checkpoint_id=?8,last_input_checkpoint_id=?9 WHERE id=?1 AND revision=?10 AND chapter_count=?11 AND last_chapter_id=?12",params![s.id,document,document.len() as u64,digest(document.as_bytes()),s.revision,s.updated_at,s.last_chapter_id,s.working_checkpoint_id,s.last_input_checkpoint_id,m.source.expected_revision,m.source.expected_chapter_count,m.source.target_chapter_id]).map_err(|_|StoryError::Io)?;
    if changed != 1 {
        return Err(StoryError::Conflict);
    }
    hook("session")?;
    super::audit::audit_session(c, &m.session_id)?;
    hook("audited")
}

#[cfg(test)]
#[path = "arena_story_tail_rewrite_tests.rs"]
pub(crate) mod tests;

#[cfg(test)]
#[path = "arena_story_tail_rewrite_pipe_tests.rs"]
mod completion_pipe;
