//! Explicitly confirmed whole local-session deletion. No network, replay or ledger.
use super::read::{RecordDescriptor, RecordKind};
use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionDeleteTarget {
    pub session: RecordDescriptor,
    pub expected_last_chapter_id: String,
    pub expected_chapter_count: u64,
}
impl SessionDeleteTarget {
    fn validate(&self) -> Result<(), StoryError> {
        let descriptor = &self.session;
        if descriptor.kind != RecordKind::Session
            || descriptor.record_id != descriptor.session_id
            || !valid_id(&descriptor.session_id)
            || descriptor.instance.len() != 32
            || !descriptor
                .instance
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || !(1..=MAX_SAFE_INTEGER).contains(&descriptor.revision)
            || !(1..=CANDIDATE_COMMIT_BYTES).contains(&descriptor.byte_length)
            || !valid_digest(&descriptor.digest)
            || !valid_id(&self.expected_last_chapter_id)
            || !(1..=MAX_SAFE_INTEGER).contains(&self.expected_chapter_count)
        {
            return Err(StoryError::Invalid);
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionDeleteStatus {
    Deleted,
    CurrentlyAbsent,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionDeleteOutcome {
    pub target: SessionDeleteTarget,
    pub status: SessionDeleteStatus,
    pub deleted_chapter_count: u64,
    pub deleted_checkpoint_count: u64,
}

impl StoryStore {
    pub fn delete_session(
        &self,
        target: &SessionDeleteTarget,
        now: Instant,
    ) -> Result<SessionDeleteOutcome, StoryError> {
        self.delete_session_with_hook(target, now, &mut |_| Ok(()))
    }
    fn delete_session_with_hook(
        &self,
        target: &SessionDeleteTarget,
        now: Instant,
        hook: &mut impl FnMut(&str) -> Result<(), StoryError>,
    ) -> Result<SessionDeleteOutcome, StoryError> {
        target.validate()?;
        if target.session.instance != self.instance {
            return Err(StoryError::Stale);
        }
        // Same lock order as Direct end. No await, and no
        // previously issued live stage may remain able to write after deletion.
        let mut stages = self.stages.lock().map_err(|_| StoryError::Io)?;
        stages.retain(|_, stage| now.saturating_duration_since(stage.created_at) < STAGE_LIFETIME);
        if stages
            .values()
            .any(|stage| stage.manifest.session_id == target.session.session_id)
        {
            return Err(StoryError::Busy);
        }
        let _permit = self
            .gate
            .enter_write()
            .map_err(|_| StoryError::Maintenance)?;
        let mut connection = lock_connection(&self.connection).map_err(StoryError::from_store)?;
        let tx = connection.transaction().map_err(|_| StoryError::Io)?;
        let staged = (|| {
            pending::assert_session_unreferenced(&tx, &target.session.session_id)?;
            // Small metadata only: no seed, chapter, checkpoint or full-story hydration.
            let current: Option<(u64, String, u64, u64, String)> = tx.query_row(
                "SELECT revision,CASE WHEN length(last_chapter_id)<=128 THEN last_chapter_id ELSE NULL END,chapter_count,document_bytes,CASE WHEN length(document_digest)=71 THEN document_digest ELSE NULL END FROM arena_story_session WHERE id=?1",
                [&target.session.session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            ).optional().map_err(|_| StoryError::Corrupt)?;
            let Some((revision, last_chapter_id, chapter_count, byte_length, digest)) = current
            else {
                return Ok(SessionDeleteOutcome {
                    target: target.clone(),
                    status: SessionDeleteStatus::CurrentlyAbsent,
                    deleted_chapter_count: 0,
                    deleted_checkpoint_count: 0,
                });
            };
            if revision != target.session.revision
                || last_chapter_id != target.expected_last_chapter_id
                || chapter_count != target.expected_chapter_count
                || byte_length != target.session.byte_length
                || digest != target.session.digest
            {
                return Err(StoryError::Stale);
            }
            let historical_count: u64 = tx
                .query_row(
                    "SELECT count(*) FROM arena_story_chapter WHERE session_id=?1",
                    [&target.session.session_id],
                    |r| r.get(0),
                )
                .map_err(|_| StoryError::Corrupt)?;
            if historical_count < chapter_count
                || historical_count > MAX_SAFE_INTEGER
                || (!super::branch::history::enabled(&tx)? && historical_count != chapter_count)
            {
                return Err(StoryError::Corrupt);
            }
            hook("before-checkpoints")?;
            let deleted_checkpoint_count = tx
                .execute(
                    "DELETE FROM arena_story_checkpoint WHERE session_id=?1",
                    [&target.session.session_id],
                )
                .map_err(|_| StoryError::Io)? as u64;
            hook("after-checkpoints")?;
            hook("before-chapters")?;
            let deleted_chapter_count = tx
                .execute(
                    "DELETE FROM arena_story_chapter WHERE session_id=?1",
                    [&target.session.session_id],
                )
                .map_err(|_| StoryError::Io)? as u64;
            hook("after-chapters")?;
            hook("before-session")?;
            let deleted_session_count = tx
                .execute(
                    "DELETE FROM arena_story_session WHERE id=?1",
                    [&target.session.session_id],
                )
                .map_err(|_| StoryError::Io)?;
            hook("after-session")?;
            if deleted_session_count != 1
                || deleted_chapter_count != historical_count
                || deleted_checkpoint_count == 0
                || deleted_checkpoint_count > MAX_SAFE_INTEGER
            {
                return Err(StoryError::Corrupt);
            }
            hook("before-commit")?;
            Ok(SessionDeleteOutcome {
                target: target.clone(),
                status: SessionDeleteStatus::Deleted,
                deleted_chapter_count,
                deleted_checkpoint_count,
            })
        })();
        let outcome = match staged {
            Ok(outcome) => outcome,
            Err(error) => {
                // Drop alone cannot establish rollback. A failed rollback remains
                // unknown; lock_connection fences all later reads until restart.
                tx.rollback().map_err(|_| StoryError::CommitUnknown)?;
                return Err(error);
            }
        };
        tx.commit().map_err(|_| StoryError::CommitUnknown)?;
        hook("after-commit").map_err(|_| StoryError::CommitUnknown)?;
        Ok(outcome)
    }
}

#[cfg(test)]
#[path = "arena_story_delete_tests.rs"]
mod tests;
