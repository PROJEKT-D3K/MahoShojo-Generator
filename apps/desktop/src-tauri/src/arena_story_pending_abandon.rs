//! Explicit local cleanup, bound to a still-durable original. The Native intent
//! bit remains on that row until cross-store cleanup is positively established.
use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AbandonRequest {
    pub key: PendingKey,
    pub input_digest: String,
    pub actor: Actor,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AbandonState {
    Abandoned,
    CleanupPending,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AbandonFlight {
    Released,
    ForeignRetained,
    Unresolved,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AbandonSecret {
    Cleared,
    Absent,
    ForeignRetained,
    NotApplicable,
    Unresolved,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AbandonCandidate {
    Removed,
    Retained,
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AbandonOutcome {
    pub key: PendingKey,
    pub input_digest: String,
    pub actor: Actor,
    pub state: AbandonState,
    pub flight: AbandonFlight,
    pub secret: AbandonSecret,
    pub candidate: AbandonCandidate,
}
fn checked(connection: &Connection, request: &AbandonRequest) -> Result<Stored, StoryError> {
    let row = exact(connection, &request.key)?;
    if row.snapshot.manifest.input_digest != request.input_digest
        || row.snapshot.manifest.actor != request.actor
    {
        return Err(StoryError::Stale);
    }
    Ok(row)
}
fn same_original(left: &PendingManifest, right: &PendingManifest) -> bool {
    left.product == right.product
        && left.request_id == right.request_id
        && left.actor == right.actor
        && left.input_digest == right.input_digest
        && left.session_id == right.session_id
        && left.operation_id == right.operation_id
        && left.created_at == right.created_at
        && left.output_checkpoint_id == right.output_checkpoint_id
        && left.initial_checkpoint_id == right.initial_checkpoint_id
        && left.expected_revision == right.expected_revision
        && left.expected_last_chapter_id == right.expected_last_chapter_id
        && left.last_input_checkpoint_id == right.last_input_checkpoint_id
        && left.write_options == right.write_options
}
impl StoryStore {
    /// Caller owns same-product admission. No secret access occurs while the
    /// connection is held; setting the bit is not permission to forget identity.
    pub(crate) fn pending_begin_abandon(
        &self,
        guard: &AdmissionGuard<'_>,
        request: &AbandonRequest,
    ) -> Result<PendingSnapshot, StoryError> {
        guard.check(self, request.key.product)?;
        let mut connection = lock_connection(&self.connection).map_err(StoryError::from_store)?;
        let mut row = checked(&connection, request)?;
        if !row.snapshot.abandon_requested {
            let tx = connection.transaction().map_err(|_| StoryError::Io)?;
            let changed = tx.execute(
                "UPDATE arena_story_pending SET abandon_requested=1 WHERE token=?1 AND active=1",
                [&row.token],
            ).map_err(|_| StoryError::Io)?;
            if changed != 1 {
                return Err(StoryError::Stale);
            }
            tx.commit().map_err(|_| StoryError::CommitUnknown)?;
            row.snapshot.abandon_requested = true;
        }
        Ok(row.snapshot)
    }
    /// Call only after exact Flight invalidation and positive OS-secret outcome.
    /// There is deliberately no public clear-bit, delete-by-product, or retry-save.
    pub(crate) fn pending_finish_abandon(
        &self,
        guard: &AdmissionGuard<'_>,
        request: &AbandonRequest,
    ) -> Result<(), StoryError> {
        self.pending_finish_abandon_with_hook(guard, request, &mut |_| Ok(()))
    }
    pub(super) fn pending_finish_abandon_with_hook(
        &self,
        guard: &AdmissionGuard<'_>,
        request: &AbandonRequest,
        hook: &mut impl FnMut(&str) -> Result<(), StoryError>,
    ) -> Result<(), StoryError> {
        guard.check(self, request.key.product)?;
        let mut attempts = self.pending_attempts.lock().map_err(|_| StoryError::Io)?;
        let mut inputs = self.pending_inputs.lock().map_err(|_| StoryError::Io)?;
        let mut connection = lock_connection(&self.connection).map_err(StoryError::from_store)?;
        let row = checked(&connection, request)?;
        if !row.snapshot.abandon_requested {
            return Err(StoryError::Conflict);
        }
        let mut tokens = vec![row.token.clone()];
        let uploads = {
            let mut statement = connection.prepare(
                "SELECT token FROM arena_story_pending WHERE active=0 AND product=?1 AND request_id=?2",
            ).map_err(|_| StoryError::Io)?;
            let rows = statement
                .query_map(
                    params![request.key.product.sql(), request.key.request_id],
                    |r| r.get::<_, String>(0),
                )
                .map_err(|_| StoryError::Io)?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|_| StoryError::Io)?
        };
        for token in uploads {
            let upload = load(&connection, &token)?;
            if same_original(&row.snapshot.manifest, &upload.snapshot.manifest) {
                tokens.push(token);
            }
        }
        let tx = connection.transaction().map_err(|_| StoryError::Io)?;
        for token in &tokens {
            tx.execute("DELETE FROM arena_story_pending WHERE token=?1", [token])
                .map_err(|_| StoryError::Io)?;
        }
        hook("before-commit")?;
        let committed = tx
            .commit()
            .map_err(|_| StoryError::CommitUnknown)
            .and_then(|()| hook("after-commit"));
        if committed.is_err() {
            // A successful COMMIT can lose its acknowledgment. Retain the exact
            // token set and both memory locks until every deletion is established.
            // Never inspect rows from an unresolved transaction as durable proof.
            if !connection.is_autocommit() {
                return Err(StoryError::ConnectionUnresolved);
            }
            for token in &tokens {
                let exists: bool = connection
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM arena_story_pending WHERE token=?1)",
                        [token],
                        |r| r.get(0),
                    )
                    .map_err(|_| StoryError::CommitUnknown)?;
                if exists {
                    return Err(StoryError::CommitUnknown);
                }
            }
        }
        inputs.retain(|(token, _), _| !tokens.contains(token));
        attempts.retain(|_, token| !tokens.contains(token));
        Ok(())
    }
}
