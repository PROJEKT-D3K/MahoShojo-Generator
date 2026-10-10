//! Closed, read-only originals export. Only sealed exact pending rows are readable;
//! no path, SQL identifier, credentials, claim or executable permit crosses this API.
use super::*;
use crate::arena_story::markdown_export::StoryPendingExportSource;

/// Native advances use a small fixed frame even though the existing IPC upload
/// ceiling is larger. No frame bytes are returned to the renderer.
pub(crate) const FRAME_BYTES: usize = 64 * 1024;

pub(crate) struct Prepared {
    pub sealed_token: String,
    pub byte_length: u64,
    pub digest: String,
    pub manifest_bytes: Option<Vec<u8>>,
}

fn checked(
    connection: &Connection,
    source: &StoryPendingExportSource,
) -> Result<Stored, StoryError> {
    let key = source.key();
    if !request_id(&key.request_id)
        || !(1..=MAX_SAFE_INTEGER).contains(&key.pending_revision)
        || !valid_digest(source.input_digest())
    {
        return Err(StoryError::Invalid);
    }
    if let StoryPendingExportSource::Part {
        byte_length,
        digest,
        ..
    } = source
    {
        if *byte_length == 0 || !valid_digest(digest) {
            return Err(StoryError::Invalid);
        }
        if *byte_length > CANDIDATE_COMMIT_BYTES {
            return Err(StoryError::TooLarge);
        }
    }
    let row = exact(connection, key)?;
    if row.snapshot.manifest.input_digest != source.input_digest() {
        return Err(StoryError::Stale);
    }
    // Restored, save-unknown and abandon-requested originals remain readable.
    Ok(row)
}

fn checked_part(
    connection: &Connection,
    row: &Stored,
    kind: PendingKind,
    byte_length: u64,
    expected_digest: &str,
) -> Result<i64, StoryError> {
    let declaration = row
        .snapshot
        .manifest
        .parts
        .iter()
        .find(|p| p.kind == kind)
        .ok_or(StoryError::Missing)?;
    if declaration.byte_length != byte_length || declaration.digest != expected_digest {
        return Err(StoryError::Stale);
    }
    let (id, actual_length, received, actual_digest) = part_row(connection, &row.token, kind)?;
    if actual_length != byte_length || received != byte_length || actual_digest != expected_digest {
        return Err(StoryError::Corrupt);
    }
    let blob = connection
        .blob_open("main", "arena_story_pending_part", "payload", id, true)
        .map_err(|_| StoryError::Io)?;
    if blob.len() as u64 != byte_length {
        return Err(StoryError::Corrupt);
    }
    Ok(id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OriginalManifest<'a> {
    format: &'static str,
    product: Product,
    request_id: &'a str,
    pending_revision: u64,
    input_digest: &'a str,
    session_id: &'a str,
    operation_id: &'a str,
    model_completed: bool,
    role_state: RoleState,
    frozen_commit: bool,
    save_attempt_present: bool,
    restored: bool,
    abandon_requested: bool,
    parts: &'a [PendingPart],
    notice: &'static str,
}

fn manifest_bytes(snapshot: &PendingSnapshot) -> Result<Vec<u8>, StoryError> {
    let manifest = &snapshot.manifest;
    // Explicit allowlist: do not serialize PendingSnapshot or PendingManifest.
    // In particular createClaim, actor, saveAttemptId and Native secrets/permits
    // are deliberately absent. This file is documentation, never an import format.
    let bytes = serde_json::to_vec(&OriginalManifest {
        format: "arena-story-pending-originals-v1",
        product: manifest.product,
        request_id: &manifest.request_id,
        pending_revision: manifest.pending_revision,
        input_digest: &manifest.input_digest,
        session_id: &manifest.session_id,
        operation_id: &manifest.operation_id,
        model_completed: manifest.model_completed,
        role_state: manifest.role_state,
        frozen_commit: manifest.commit_manifest.is_some(),
        save_attempt_present: snapshot.save_attempt_id.is_some(),
        restored: snapshot.restored,
        abandon_requested: snapshot.abandon_requested,
        parts: &manifest.parts,
        notice: "Uncommitted local candidate originals. Save state may be unknown. Each file requires its own successful export receipt. Not an executable backup or import format.",
    }).map_err(|_| StoryError::Corrupt)?;
    if bytes.len() > METADATA_BYTES {
        return Err(StoryError::TooLarge);
    }
    Ok(bytes)
}

pub(crate) fn prepare(
    connection: &Connection,
    source: &StoryPendingExportSource,
) -> Result<Prepared, StoryError> {
    let row = checked(connection, source)?;
    match source {
        StoryPendingExportSource::Part {
            kind,
            byte_length,
            digest,
            ..
        } => {
            checked_part(connection, &row, *kind, *byte_length, digest)?;
            Ok(Prepared {
                sealed_token: row.token,
                byte_length: *byte_length,
                digest: digest.clone(),
                manifest_bytes: None,
            })
        }
        StoryPendingExportSource::Manifest { .. } => {
            let bytes = manifest_bytes(&row.snapshot)?;
            Ok(Prepared {
                sealed_token: row.token,
                byte_length: bytes.len() as u64,
                digest: digest(&bytes),
                manifest_bytes: Some(bytes),
            })
        }
    }
}

/// Rechecks exact identity at begin, every advance and immediately before publish.
/// Caller retains its connection lock through the following read/publication.
pub(crate) fn assert_scope(
    connection: &Connection,
    source: &StoryPendingExportSource,
    sealed_token: &str,
    expected_manifest: Option<&[u8]>,
) -> Result<Option<i64>, StoryError> {
    let row = checked(connection, source)?;
    if row.token != sealed_token {
        return Err(StoryError::Stale);
    }
    match source {
        StoryPendingExportSource::Part {
            kind,
            byte_length,
            digest,
            ..
        } => checked_part(connection, &row, *kind, *byte_length, digest).map(Some),
        StoryPendingExportSource::Manifest { .. } => {
            if Some(manifest_bytes(&row.snapshot)?.as_slice()) != expected_manifest {
                return Err(StoryError::Stale);
            }
            Ok(None)
        }
    }
}

pub(crate) fn read_frame(
    connection: &Connection,
    source: &StoryPendingExportSource,
    sealed_token: &str,
    expected_manifest: Option<&[u8]>,
    offset: u64,
) -> Result<Vec<u8>, StoryError> {
    let id = assert_scope(connection, source, sealed_token, expected_manifest)?;
    match source {
        StoryPendingExportSource::Part { byte_length, .. } => {
            if offset >= *byte_length {
                return Err(StoryError::Invalid);
            }
            let mut blob = connection
                .blob_open(
                    "main",
                    "arena_story_pending_part",
                    "payload",
                    id.ok_or(StoryError::Corrupt)?,
                    true,
                )
                .map_err(|_| StoryError::Io)?;
            blob.seek(SeekFrom::Start(offset))
                .map_err(|_| StoryError::Io)?;
            let mut bytes = vec![0; ((*byte_length - offset) as usize).min(FRAME_BYTES)];
            blob.read_exact(&mut bytes).map_err(|_| StoryError::Io)?;
            Ok(bytes)
        }
        StoryPendingExportSource::Manifest { .. } => {
            let bytes = expected_manifest.ok_or(StoryError::Corrupt)?;
            let offset = usize::try_from(offset).map_err(|_| StoryError::Invalid)?;
            if offset >= bytes.len() {
                return Err(StoryError::Invalid);
            }
            Ok(bytes[offset..(offset + FRAME_BYTES).min(bytes.len())].to_vec())
        }
    }
}
