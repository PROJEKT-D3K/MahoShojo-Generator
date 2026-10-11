//! Source-assisted branch storage. Internal only; no IPC command is registered.
use super::receipt::{BranchKind, BranchReceipt, CopyKind as MarkerKind, CopyMarker};
use super::*;
use crate::arena_story::read::{RecordDescriptor, RecordKind};
use crate::arena_story::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BranchSource {
    pub session: RecordDescriptor,
    pub seed: RecordDescriptor,
    pub expected_last_chapter_id: String,
    pub expected_chapter_count: u64,
    pub anchor: RecordDescriptor,
    pub anchor_index: u64,
    pub checkpoint: RecordDescriptor,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BranchManifest {
    pub version: u32,
    pub operation_id: String,
    pub session_id: String,
    pub source: BranchSource,
    pub parts: Vec<PartDeclaration>,
}
impl BranchManifest {
    fn linear_carrier(&self) -> Result<CommitManifest, StoryError> {
        if self.version != 2
            || self.session_id == self.source.session.session_id
            || self.source.anchor_index == 0
            || self.source.anchor_index >= MAX_SAFE_INTEGER
            || self.source.expected_chapter_count < self.source.anchor_index
            || self.source.expected_chapter_count > MAX_SAFE_INTEGER
            || !valid_id(&self.source.expected_last_chapter_id)
        {
            return Err(StoryError::Invalid);
        }
        let s = &self.source;
        for (descriptor, kind) in [
            (&s.session, RecordKind::Session),
            (&s.seed, RecordKind::Seed),
            (&s.anchor, RecordKind::Chapter),
            (&s.checkpoint, RecordKind::Checkpoint),
        ] {
            if descriptor.kind != kind
                || descriptor.session_id != s.session.session_id
                || descriptor.instance != s.session.instance
                || descriptor.revision != s.session.revision
                || !valid_id(&descriptor.record_id)
                || !valid_id(&descriptor.session_id)
                || !(1..=MAX_SAFE_INTEGER).contains(&descriptor.revision)
                || !(1..=CANDIDATE_COMMIT_BYTES).contains(&descriptor.byte_length)
                || !valid_digest(&descriptor.digest)
                || descriptor.instance.len() != 32
                || !descriptor
                    .instance
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            {
                return Err(StoryError::Invalid);
            }
        }
        if s.session.record_id != s.session.session_id
            || s.seed.record_id != s.session.session_id
            || s.session.revision != s.expected_chapter_count
        {
            return Err(StoryError::Invalid);
        }
        let carrier = CommitManifest {
            version: 1,
            operation_id: self.operation_id.clone(),
            session_id: self.session_id.clone(),
            expected_revision: s.anchor_index,
            expected_last_chapter_id: Some(copy_id(
                &self.session_id,
                CopyKind::Chapter,
                s.anchor_index,
            )?),
            parts: self.parts.clone(),
        };
        carrier.validate()?;
        Ok(carrier)
    }
    pub(crate) fn request_digest(&self) -> Result<String, StoryError> {
        self.linear_carrier()?;
        // Field order is the declared closed structs' order. Descriptor/part order
        // is fixed too. No arbitrary JSON value enters this small wire identity.
        let mut hash = Sha256::new();
        hash.update(b"arena-story-branch-wire-v2\n");
        hash.update(serde_json::to_vec(self).map_err(|_| StoryError::Invalid)?);
        Ok(format!("sha256:{:x}", hash.finalize()))
    }
}

impl StoryStore {
    pub(crate) fn begin_branch(
        &self,
        manifest: BranchManifest,
        now: Instant,
    ) -> Result<BeginOutcome, StoryError> {
        let carrier = manifest.linear_carrier()?;
        self.begin_stage(carrier, Some(manifest), now)
    }
    pub(crate) fn branch_receipt(
        &self,
        session: &str,
        operation: &str,
        request_digest: &str,
    ) -> Result<Option<BranchReceipt>, StoryError> {
        if !valid_id(session) || !valid_id(operation) || !valid_digest(request_digest) {
            return Err(StoryError::Invalid);
        }
        let connection = lock_connection(&self.connection).map_err(StoryError::from_store)?;
        read_branch_receipt(&connection, session, operation, request_digest)
    }
    pub(crate) fn end_branch(
        &self,
        token: &str,
        now: Instant,
    ) -> Result<BranchReceipt, StoryError> {
        self.end_branch_with_hook(token, now, &mut |_, _| Ok(()))
    }
    fn end_branch_with_hook(
        &self,
        token: &str,
        now: Instant,
        hook: &mut impl FnMut(&str, &Connection) -> Result<(), StoryError>,
    ) -> Result<BranchReceipt, StoryError> {
        let mut stages = self.stages.lock().map_err(|_| StoryError::Io)?;
        stages.retain(|_, stage| now.saturating_duration_since(stage.created_at) < STAGE_LIFETIME);
        let stage = stages.get_mut(token).ok_or(StoryError::Stale)?;
        if stage.current != stage.parts.len() {
            return Err(StoryError::Incomplete);
        }
        let manifest = stage.branch.clone().ok_or(StoryError::Invalid)?;
        let request_digest = manifest.request_digest()?;
        let _permit = self
            .gate
            .enter_write()
            .map_err(|_| StoryError::Maintenance)?;
        let mut connection = lock_connection(&self.connection).map_err(StoryError::from_store)?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| StoryError::Io)?;
        // Exact durable success precedes source existence, current instance and CAS.
        let replay = read_branch_receipt(
            &tx,
            &manifest.session_id,
            &manifest.operation_id,
            &request_digest,
        );
        match replay {
            Ok(Some(receipt)) => {
                tx.rollback().map_err(|_| {
                    stage.branch_unknown = true;
                    StoryError::CommitUnknown
                })?;
                stages.remove(token);
                return Ok(receipt);
            }
            Err(error) => {
                tx.rollback().map_err(|_| {
                    stage.branch_unknown = true;
                    StoryError::CommitUnknown
                })?;
                return Err(error);
            }
            Ok(None) => {}
        }
        if stage.branch_unknown {
            tx.rollback().map_err(|_| StoryError::CommitUnknown)?;
            return Err(StoryError::CommitUnknown);
        }
        let outcome = (|| {
            if manifest.source.session.instance != self.instance {
                return Err(StoryError::Stale);
            }
            check_source(&tx, &manifest)?;
            hook("source-cas", &tx)?;
            let validated = validate_branch_stage(stage, &manifest, request_digest)?;
            write_branch(&tx, stage, &manifest, &validated, &mut |step| {
                hook(step, &tx)
            })?;
            hook("before-commit", &tx)?;
            Ok(validated.receipt)
        })();
        let receipt = match outcome {
            Ok(receipt) => receipt,
            Err(error) => {
                tx.rollback().map_err(|_| {
                    stage.branch_unknown = true;
                    StoryError::CommitUnknown
                })?;
                return Err(error);
            }
        };
        // Only a real COMMIT attempt or failed explicit rollback makes the stage
        // uncertain. Known rollback/cancellation remains explicitly retryable.
        stage.branch_unknown = true;
        tx.commit().map_err(|_| StoryError::CommitUnknown)?;
        // If an IPC response disappears, only the same target/op/request can recover.
        hook("after-commit", &connection).map_err(|_| StoryError::CommitUnknown)?;
        stages.remove(token);
        Ok(receipt)
    }
}

pub(super) fn read_branch_receipt(
    connection: &Connection,
    session: &str,
    operation: &str,
    expected_digest: &str,
) -> Result<Option<BranchReceipt>, StoryError> {
    type ReceiptRow = (
        String,
        String,
        u64,
        String,
        Option<String>,
        String,
        Option<String>,
    );
    let row: Option<ReceiptRow> = connection.query_row(
        "SELECT session_id,id,chapter_index,operation_digest,CASE WHEN length(CAST(receipt AS BLOB))<=2048 THEN receipt END,action,source_chapter_id FROM arena_story_chapter WHERE operation_id=?1", [operation],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional().map_err(|_|StoryError::Io)?;
    row.map(|(stored_session,id,index,stored_digest,document,action,source)| {
        if stored_session != session || stored_digest != expected_digest { return Err(StoryError::OperationMismatch); }
        let receipt = BranchReceipt::decode(&document.ok_or(StoryError::Corrupt)?)?;
        if receipt.session_id != session || receipt.operation_id != operation || receipt.chapter_id != id
            || receipt.chapter_index != index || receipt.request_digest != expected_digest
            || action != "branch" || source.as_deref() != Some(&receipt.anchor_chapter_id) { return Err(StoryError::Corrupt); }
        let matches: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM arena_story_chapter c JOIN arena_story_checkpoint a ON a.session_id=c.session_id AND a.boundary_index=c.chapter_index AND a.chapter_id=c.id JOIN arena_story_checkpoint p ON p.session_id=c.session_id AND p.boundary_index=?3 AND p.chapter_id=?4 WHERE c.session_id=?1 AND c.chapter_index=?2 AND c.id=?5 AND a.id=?6 AND p.id=?7)",
            params![session,receipt.prefix_end_index,index,id,receipt.anchor_chapter_id,receipt.anchor_checkpoint_id,receipt.checkpoint_id], |r|r.get(0)).map_err(|_|StoryError::Corrupt)?;
        if !matches { return Err(StoryError::Corrupt); }
        Ok(receipt)
    }).transpose()
}

fn check_source(connection: &Connection, m: &BranchManifest) -> Result<(), StoryError> {
    let s = &m.source;
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM arena_story_session WHERE id=?1)",
            [&m.session_id],
            |r| r.get(0),
        )
        .map_err(|_| StoryError::Io)?;
    if exists {
        return Err(StoryError::Conflict);
    }
    let valid: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM arena_story_session s JOIN arena_story_chapter c ON c.session_id=s.id AND c.id=?8 JOIN arena_story_checkpoint p ON p.session_id=s.id AND p.id=?12 WHERE s.id=?1 AND s.revision=?2 AND s.document_bytes=?3 AND s.document_digest=?4 AND s.chapter_count=?5 AND s.last_chapter_id=?6 AND s.seed_bytes=?7 AND c.chapter_index=?9 AND c.document_bytes=?10 AND c.document_digest=?11 AND p.boundary_index=?9 AND p.chapter_id=c.id AND p.document_bytes=?13 AND p.document_digest=?14 AND s.seed_digest=?15)",
        params![s.session.session_id,s.session.revision,s.session.byte_length,s.session.digest,s.expected_chapter_count,s.expected_last_chapter_id,s.seed.byte_length,s.anchor.record_id,s.anchor_index,s.anchor.byte_length,s.anchor.digest,s.checkpoint.record_id,s.checkpoint.byte_length,s.checkpoint.digest,s.seed.digest], |r| r.get(0)).map_err(|_|StoryError::Corrupt)?;
    if !valid {
        return Err(StoryError::Stale);
    }
    // Verify frozen source bytes, not only digest columns. Release each before next.
    for descriptor in [&s.session, &s.seed, &s.anchor, &s.checkpoint] {
        let (table, column, bytes, hash) = match descriptor.kind {
            RecordKind::Session => (
                "arena_story_session",
                "document",
                "document_bytes",
                "document_digest",
            ),
            RecordKind::Seed => (
                "arena_story_session",
                "seed_document",
                "seed_bytes",
                "seed_digest",
            ),
            RecordKind::Chapter => (
                "arena_story_chapter",
                "document",
                "document_bytes",
                "document_digest",
            ),
            RecordKind::Checkpoint => (
                "arena_story_checkpoint",
                "document",
                "document_bytes",
                "document_digest",
            ),
        };
        read_document(
            connection,
            table,
            column,
            bytes,
            hash,
            &descriptor.record_id,
            |document| {
                if document.byte_length() != descriptor.byte_length
                    || document.digest() != descriptor.digest
                {
                    return Err(StoryError::Stale);
                }
                Ok(())
            },
        )?;
    }
    Ok(())
}

struct ValidatedBranch {
    session: SessionIndex,
    chapter: ChapterIndex,
    checkpoint: CheckpointIndex,
    receipt: BranchReceipt,
}
fn stage_document(stage: &mut Stage, kind: PartKind) -> Result<String, StoryError> {
    read_part(
        stage
            .parts
            .iter_mut()
            .find(|p| p.declaration.kind == kind)
            .ok_or(StoryError::Invalid)?,
    )
}
fn validate_branch_stage(
    stage: &mut Stage,
    m: &BranchManifest,
    request_digest: String,
) -> Result<ValidatedBranch, StoryError> {
    let session = {
        let document = stage_document(stage, PartKind::Session)?;
        let raw = serde_json::from_str(&document).map_err(|_| StoryError::Invalid)?;
        let session = super::audit::session_index(raw)?;
        let fields = authority(raw, &["branchOf"])?;
        let origin = fields.get("branchOf").ok_or(StoryError::Invalid)?;
        let origin = authority(
            origin,
            &["sessionId", "chapterId", "chapterIndex", "chapterTitle"],
        )?;
        if required::<String>(&origin, "sessionId")? != m.source.session.session_id
            || required::<String>(&origin, "chapterId")? != m.source.anchor.record_id
            || required::<u64>(&origin, "chapterIndex")? != m.source.anchor_index
        {
            return Err(StoryError::Invalid);
        }
        session
    };
    let chapter = {
        let document = stage_document(stage, PartKind::Chapter)?;
        let raw = serde_json::from_str(&document).map_err(|_| StoryError::Invalid)?;
        let fields = authority(raw, CHAPTER_AUTHORITY)?;
        validate_chapter_carrier(
            fields.get("markdown").ok_or(StoryError::Invalid)?,
            fields.get("reportJson").ok_or(StoryError::Invalid)?,
            fields
                .get("deterministicDigest")
                .ok_or(StoryError::Invalid)?,
        )?;
        chapter_index(&fields)?
    };
    let checkpoint = {
        let document = stage_document(stage, PartKind::Checkpoint1)?;
        let raw = serde_json::from_str(&document).map_err(|_| StoryError::Invalid)?;
        let fields = authority(raw, CHECKPOINT_AUTHORITY)?;
        validate_checkpoint_carrier(fields.get("combatants").ok_or(StoryError::Invalid)?)?;
        checkpoint_index(&fields)?
    };
    let index = m.source.anchor_index + 1;
    let anchor = copy_id(&m.session_id, CopyKind::Chapter, m.source.anchor_index)?;
    let anchor_cp = copy_id(&m.session_id, CopyKind::Checkpoint, m.source.anchor_index)?;
    if session.id != m.session_id
        || session.revision != index
        || session.chapter_count != index
        || session.last_chapter_id != m.operation_id
        || session.working_checkpoint_id != checkpoint.id
        || session.last_input_checkpoint_id != anchor_cp
        || session.created_at > session.updated_at
        || session.updated_at > MAX_SAFE_INTEGER
        || !preview_valid(&session.title_preview)
        || !["classic", "kizuna", "daily", "scenario"].contains(&session.mode.as_str())
        || session.source.mode != session.mode
        || session.chapter_plan.as_ref().is_some_and(|p| {
            !(1..=20).contains(&p.total_chapters)
                || p.total_chapters < index
                || !["user", "scenario"].contains(&p.source.as_str())
        })
        || chapter.id != m.operation_id
        || chapter.session_id != m.session_id
        || chapter.index != index
        || chapter.action != "branch"
        || chapter.status != "active"
        || chapter.source_chapter_id.as_deref() != Some(&anchor)
        || chapter.created_at != session.updated_at
        || !preview_valid(&chapter.title_preview)
        || chapter.markdown_byte_length > MAX_SAFE_INTEGER
        || checkpoint.session_id != m.session_id
        || checkpoint.boundary_index != index
        || checkpoint.chapter_id.as_deref() != Some(&m.operation_id)
        || !valid_id(&checkpoint.id)
        || checkpoint.id == anchor_cp
    {
        return Err(StoryError::Invalid);
    }
    let receipt = BranchReceipt {
        version: 2,
        kind: BranchKind::Branch,
        operation_id: m.operation_id.clone(),
        session_id: m.session_id.clone(),
        chapter_id: m.operation_id.clone(),
        chapter_index: index,
        revision: index,
        chapter_count: index,
        prefix_end_index: m.source.anchor_index,
        anchor_chapter_id: anchor,
        anchor_checkpoint_id: anchor_cp,
        checkpoint_id: checkpoint.id.clone(),
        request_digest,
    };
    receipt.validate()?;
    Ok(ValidatedBranch {
        session,
        chapter,
        checkpoint,
        receipt,
    })
}

// Identifiers here are internal fixed literals only, never command input.
fn read_document<T>(
    connection: &Connection,
    table: &str,
    column: &str,
    bytes: &str,
    hash: &str,
    id: &str,
    use_checked: impl FnOnce(CheckedCopySource<'_>) -> Result<T, StoryError>,
) -> Result<T, StoryError> {
    let (document, length, expected): (Option<String>,u64,String) = connection.query_row(&format!(
        "SELECT CASE WHEN {bytes} BETWEEN 1 AND ?2 AND length(CAST({column} AS BLOB))={bytes} THEN {column} END,{bytes},{hash} FROM {table} WHERE id=?1"),params![id,CANDIDATE_COMMIT_BYTES],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|StoryError::Corrupt)?;
    let document = document.ok_or(StoryError::Corrupt)?;
    // The callback cannot retain a borrow of this local String. All consumers,
    // including CAS and seed copying, receive only the checked immutable view.
    use_checked(CheckedCopySource::checked(&document, length, &expected)?)
}

fn write_branch(
    connection: &Connection,
    stage: &mut Stage,
    m: &BranchManifest,
    v: &ValidatedBranch,
    hook: &mut impl FnMut(&str) -> Result<(), StoryError>,
) -> Result<(), StoryError> {
    let s = &v.session;
    let document = stage_document(stage, PartKind::Session)?;
    connection.execute("INSERT INTO arena_story_session (id,document,document_bytes,document_digest,seed_document,seed_bytes,seed_digest,revision,title_preview,title_truncated,mode,chapter_plan,created_at,updated_at,chapter_count,last_chapter_id,working_checkpoint_id,last_input_checkpoint_id) VALUES (?1,?2,?3,?4,'',0,'',?5,?6,?7,?8,?15,?9,?10,?11,?12,?13,?14)",
        params![s.id,document,document.len() as u64,digest(document.as_bytes()),s.revision,s.title_preview,s.title_truncated,s.mode,s.created_at,s.updated_at,s.chapter_count,s.last_chapter_id,s.working_checkpoint_id,s.last_input_checkpoint_id,s.chapter_plan.as_ref().map(serde_json::to_string).transpose().map_err(|_|StoryError::Invalid)?]).map_err(|_|StoryError::Io)?;
    drop(document);
    hook("session")?;
    read_document(
        connection,
        "arena_story_session",
        "seed_document",
        "seed_bytes",
        "seed_digest",
        &m.source.session.session_id,
        |seed| {
            connection.execute("UPDATE arena_story_session SET seed_document=?2,seed_bytes=?3,seed_digest=?4 WHERE id=?1",params![m.session_id,seed.document(),seed.byte_length(),seed.digest()]).map_err(|_|StoryError::Io)?;
            Ok(())
        },
    )?;
    hook("seed")?;
    // Every iteration reads, checks, transforms and writes exactly one document.
    let mut previous = None;
    for index in 1..=m.source.anchor_index {
        hook("before-copy-chapter")?;
        let indexed=connection.query_row("SELECT id,session_id,chapter_index,action,source_chapter_id,title_preview,title_truncated,created_at,markdown_bytes FROM arena_story_chapter WHERE session_id=?1 AND chapter_index=?2",params![m.source.session.session_id,index],|r|Ok(ChapterIndex{id:r.get(0)?,session_id:r.get(1)?,index:r.get(2)?,action:r.get(3)?,status:"active".into(),source_chapter_id:r.get(4)?,title_preview:r.get(5)?,title_truncated:r.get(6)?,created_at:r.get(7)?,markdown_byte_length:r.get(8)?})).map_err(|_|StoryError::Corrupt)?;
        let copied = read_document(
            connection,
            "arena_story_chapter",
            "document",
            "document_bytes",
            "document_digest",
            &indexed.id,
            |source| copy_chapter(source, &indexed, previous.as_deref(), &m.session_id),
        )?;
        let marker = CopyMarker {
            version: 2,
            kind: MarkerKind::Copy,
            branch_operation_id: m.operation_id.clone(),
            session_id: m.session_id.clone(),
            chapter_id: copied.id.clone(),
            chapter_index: index,
            source_session_id: m.source.session.session_id.clone(),
            source_chapter_id: indexed.id.clone(),
            request_digest: v.receipt.request_digest.clone(),
        };
        let target_previous = if index == 1 {
            None
        } else {
            Some(copy_id(&m.session_id, CopyKind::Chapter, index - 1)?)
        };
        connection.execute("INSERT INTO arena_story_chapter (id,session_id,chapter_index,action,source_chapter_id,title_preview,title_truncated,created_at,markdown_bytes,document,document_bytes,document_digest,operation_id,operation_digest,receipt) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?1,?13,?14)",params![copied.id,m.session_id,index,indexed.action,target_previous,indexed.title_preview,indexed.title_truncated,indexed.created_at,indexed.markdown_byte_length,copied.document,copied.byte_length,copied.digest,v.receipt.request_digest,marker.encode()?]).map_err(|_|StoryError::Io)?;
        previous = Some(indexed.id);
        hook("copy-chapter")?;
    }
    for index in 0..=m.source.anchor_index {
        hook("before-copy-checkpoint")?;
        let indexed=connection.query_row("SELECT id,session_id,boundary_index,chapter_id FROM arena_story_checkpoint WHERE session_id=?1 AND boundary_index=?2",params![m.source.session.session_id,index],|r|Ok(CheckpointIndex{id:r.get(0)?,session_id:r.get(1)?,boundary_index:r.get(2)?,chapter_id:r.get(3)?})).map_err(|_|StoryError::Corrupt)?;
        let chapter = if index == 0 {
            None
        } else {
            Some(connection.query_row("SELECT id FROM arena_story_chapter WHERE session_id=?1 AND chapter_index=?2",params![m.source.session.session_id,index],|r|r.get::<_,String>(0)).map_err(|_|StoryError::Corrupt)?)
        };
        let copied = read_document(
            connection,
            "arena_story_checkpoint",
            "document",
            "document_bytes",
            "document_digest",
            &indexed.id,
            |source| copy_checkpoint(source, &indexed, chapter.as_deref(), &m.session_id),
        )?;
        let target_chapter = if index == 0 {
            None
        } else {
            Some(copy_id(&m.session_id, CopyKind::Chapter, index)?)
        };
        connection.execute("INSERT INTO arena_story_checkpoint (id,session_id,boundary_index,chapter_id,document,document_bytes,document_digest) VALUES (?1,?2,?3,?4,?5,?6,?7)",params![copied.id,m.session_id,index,target_chapter,copied.document,copied.byte_length,copied.digest]).map_err(|_|StoryError::Io)?;
        hook("copy-checkpoint")?;
    }
    let c = &v.chapter;
    let document = stage_document(stage, PartKind::Chapter)?;
    connection.execute("INSERT INTO arena_story_chapter (id,session_id,chapter_index,action,source_chapter_id,title_preview,title_truncated,created_at,markdown_bytes,document,document_bytes,document_digest,operation_id,operation_digest,receipt) VALUES (?1,?2,?3,'branch',?4,?5,?6,?7,?8,?9,?10,?11,?1,?12,?13)",params![c.id,c.session_id,c.index,c.source_chapter_id,c.title_preview,c.title_truncated,c.created_at,c.markdown_byte_length,document,document.len() as u64,digest(document.as_bytes()),v.receipt.request_digest,v.receipt.encode()?]).map_err(|_|StoryError::Io)?;
    drop(document);
    hook("chapter")?;
    let p = &v.checkpoint;
    let document = stage_document(stage, PartKind::Checkpoint1)?;
    connection.execute("INSERT INTO arena_story_checkpoint (id,session_id,boundary_index,chapter_id,document,document_bytes,document_digest) VALUES (?1,?2,?3,?4,?5,?6,?7)",params![p.id,p.session_id,p.boundary_index,p.chapter_id,document,document.len() as u64,digest(document.as_bytes())]).map_err(|_|StoryError::Io)?;
    hook("checkpoint")?;
    // The versioned target audit is also the restore contract; no source dependency.
    super::audit::audit_session(connection, &m.session_id)?;
    Ok(())
}

#[cfg(test)]
#[path = "arena_story_branch_store_tests.rs"]
mod tests;
