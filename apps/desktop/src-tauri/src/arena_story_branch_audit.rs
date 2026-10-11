//! Schema-9 target-local audit. The historical v5–8 audit is deliberately unchanged.
use super::super::{read_receipt, valid_digest, StoryError, CANDIDATE_COMMIT_BYTES};
use super::receipt::{BranchReceipt, CopyMarker};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::io::Read;

pub(crate) fn audit_relations(connection: &Connection) -> Result<(), StoryError> {
    audit_scope(connection, None, false)
}

pub(crate) fn audit_session(connection: &Connection, session_id: &str) -> Result<(), StoryError> {
    if !super::super::valid_id(session_id) {
        return Err(StoryError::Invalid);
    }
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM arena_story_session WHERE id=?1)",
            [session_id],
            |r| r.get(0),
        )
        .map_err(|_| StoryError::Corrupt)?;
    if !exists {
        return Err(StoryError::Corrupt);
    }
    audit_scope(
        connection,
        Some(session_id),
        super::history::enabled(connection)?,
    )
}

pub(super) fn audit_scope(
    connection: &Connection,
    session: Option<&str>,
    history: bool,
) -> Result<(), StoryError> {
    // The same bounded metadata accepted by end must remain bounded after restore;
    // never fetch an attacker-sized preview before applying the page byte policy.
    for sql in [
        "SELECT EXISTS(SELECT 1 FROM arena_story_session WHERE (?1 IS NULL OR id=?1) AND (length(id) NOT BETWEEN 1 AND 128 OR id GLOB '*[^A-Za-z0-9_-]*' OR revision NOT BETWEEN 1 AND 9007199254740991 OR chapter_count NOT BETWEEN 1 AND 9007199254740991 OR created_at NOT BETWEEN 0 AND 9007199254740991 OR updated_at NOT BETWEEN created_at AND 9007199254740991 OR length(CAST(title_preview AS BLOB))>192 OR title_truncated NOT IN (0,1) OR mode NOT IN ('classic','kizuna','daily','scenario') OR length(CAST(chapter_plan AS BLOB))>512 OR (chapter_plan IS NOT NULL AND (NOT json_valid(chapter_plan) OR json_type(chapter_plan,'$.totalChapters') IS NOT 'integer' OR json_extract(chapter_plan,'$.totalChapters') NOT BETWEEN 1 AND 20 OR json_type(chapter_plan,'$.source') IS NOT 'text' OR json_extract(chapter_plan,'$.source') NOT IN ('user','scenario') OR json_type(chapter_plan,'$.locked') IS NULL OR json_type(chapter_plan,'$.locked') NOT IN ('true','false')))))",
        "SELECT EXISTS(SELECT 1 FROM arena_story_chapter WHERE (?1 IS NULL OR session_id=?1) AND (length(id) NOT BETWEEN 1 AND 128 OR id GLOB '*[^A-Za-z0-9_-]*' OR chapter_index NOT BETWEEN 1 AND 9007199254740991 OR created_at NOT BETWEEN 0 AND 9007199254740991 OR markdown_bytes NOT BETWEEN 0 AND 9007199254740991 OR length(CAST(title_preview AS BLOB))>192 OR title_truncated NOT IN (0,1) OR action NOT IN ('start','continue','branch')))",
        "SELECT EXISTS(SELECT 1 FROM arena_story_checkpoint WHERE (?1 IS NULL OR session_id=?1) AND (length(id) NOT BETWEEN 1 AND 128 OR id GLOB '*[^A-Za-z0-9_-]*' OR boundary_index NOT BETWEEN 0 AND 9007199254740991))",
    ] { let sql = if history {sql.replace("('start','continue','branch')", "('start','continue','branch','rewrite')")} else {sql.to_owned()}; if connection.query_row(&scope_sql(&sql,session),[session],|row|row.get::<_,bool>(0)).map_err(|_|StoryError::Corrupt)? { return Err(StoryError::Corrupt); } }

    if history {
        super::history::audit_graph(connection, session)?;
    } else {
        let invalid: bool = connection.query_row(&scope_sql(r#"SELECT EXISTS(
        SELECT 1 FROM arena_story_session s
        LEFT JOIN arena_story_chapter h ON h.session_id=s.id AND h.id=s.last_chapter_id
        LEFT JOIN arena_story_checkpoint w ON w.session_id=s.id AND w.id=s.working_checkpoint_id
        LEFT JOIN arena_story_checkpoint i ON i.session_id=s.id AND i.id=s.last_input_checkpoint_id
        WHERE (?1 IS NULL OR s.id=?1) AND (h.chapter_index IS NOT s.chapter_count OR w.boundary_index IS NOT s.chapter_count
           OR w.chapter_id IS NOT h.id OR i.boundary_index IS NOT s.chapter_count-1
           OR s.chapter_count != (SELECT count(*) FROM arena_story_chapter c WHERE c.session_id=s.id)
           OR s.chapter_count+1 != (SELECT count(*) FROM arena_story_checkpoint p WHERE p.session_id=s.id)
           OR s.seed_bytes <= 0 OR s.revision != s.chapter_count)
        UNION ALL
        SELECT 1 FROM arena_story_chapter c
        LEFT JOIN arena_story_chapter p ON p.session_id=c.session_id AND p.chapter_index=c.chapter_index-1
        WHERE (?1 IS NULL OR c.session_id=?1) AND ((c.chapter_index=1 AND (c.action!='start' OR c.source_chapter_id IS NOT NULL))
           OR (c.chapter_index>1 AND (c.action NOT IN ('continue','branch') OR c.source_chapter_id IS NOT p.id OR p.id IS NULL)))
        UNION ALL
        SELECT 1 FROM arena_story_checkpoint p
        LEFT JOIN arena_story_chapter c ON c.session_id=p.session_id AND c.id=p.chapter_id
        WHERE (?1 IS NULL OR p.session_id=?1) AND ((p.boundary_index=0 AND p.chapter_id IS NOT NULL)
           OR (p.boundary_index>0 AND (c.chapter_index IS NOT p.boundary_index)))
    )"#, session), [session], |row| row.get(0)).map_err(|_| StoryError::Corrupt)?;
        if invalid {
            return Err(StoryError::Corrupt);
        }
    }
    audit_receipts(connection, session, history)?;
    // Hash one fixed column through SQLite's incremental read API. Backup validation
    // never accumulates all stories, all records or a large binary+Value duplicate.
    for (table, column, length_column, digest_column) in [
        (
            "arena_story_session",
            "document",
            "document_bytes",
            "document_digest",
        ),
        (
            "arena_story_session",
            "seed_document",
            "seed_bytes",
            "seed_digest",
        ),
        (
            "arena_story_chapter",
            "document",
            "document_bytes",
            "document_digest",
        ),
        (
            "arena_story_checkpoint",
            "document",
            "document_bytes",
            "document_digest",
        ),
    ] {
        let session_column = if table == "arena_story_session" {
            "id"
        } else {
            "session_id"
        };
        let mut statement = connection
            .prepare(&scope_sql(&format!(
                "SELECT rowid,{length_column},{digest_column} FROM {table} WHERE (?1 IS NULL OR {session_column}=?1)"
            ),session))
            .map_err(|_| StoryError::Corrupt)?;
        let rows = statement
            .query_map([session], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, u64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|_| StoryError::Corrupt)?;
        for row in rows {
            let (rowid, length, expected) = row.map_err(|_| StoryError::Corrupt)?;
            if length == 0 || length > CANDIDATE_COMMIT_BYTES || !valid_digest(&expected) {
                return Err(StoryError::Corrupt);
            }
            let mut blob = connection
                .blob_open("main", table, column, rowid, true)
                .map_err(|_| StoryError::Corrupt)?;
            if blob.len() as u64 != length {
                return Err(StoryError::Corrupt);
            }
            let mut hash = Sha256::new();
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let n = blob.read(&mut buffer).map_err(|_| StoryError::Corrupt)?;
                if n == 0 {
                    break;
                }
                hash.update(&buffer[..n]);
            }
            if format!("sha256:{:x}", hash.finalize()) != expected {
                return Err(StoryError::Corrupt);
            }
            drop(blob);
            // One bounded original record at a time. Do not deserialize opaque
            // keys/values: lone surrogates and unknown duplicates are legal.
            let document: String = connection
                .query_row(
                    &format!("SELECT {column} FROM {table} WHERE rowid=?1"),
                    [rowid],
                    |r| r.get(0),
                )
                .map_err(|_| StoryError::Corrupt)?;
            audit_document(connection, table, column, rowid, &document, history)?;
        }
    }
    Ok(())
}

fn audit_receipts(
    connection: &Connection,
    session: Option<&str>,
    history: bool,
) -> Result<(), StoryError> {
    // Bound every receipt before fetching or using JSON extraction in group checks.
    let invalid: bool = connection.query_row(
        &scope_sql("SELECT EXISTS(SELECT 1 FROM arena_story_chapter WHERE (?1 IS NULL OR session_id=?1) AND (length(CAST(receipt AS BLOB)) NOT BETWEEN 1 AND 2048 OR NOT json_valid(receipt)))",session),
        [session], |r| r.get(0)).map_err(|_| StoryError::Corrupt)?;
    if invalid {
        return Err(StoryError::Corrupt);
    }
    let mut statement = connection.prepare(&scope_sql(
        "SELECT session_id,id,chapter_index,action,operation_id,operation_digest,receipt FROM arena_story_chapter WHERE (?1 IS NULL OR session_id=?1) ORDER BY session_id,chapter_index",session
    )).map_err(|_| StoryError::Corrupt)?;
    let rows = statement
        .query_map([session], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, u64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
            ))
        })
        .map_err(|_| StoryError::Corrupt)?;
    for row in rows {
        let (session, id, index, action, operation, operation_digest, document) =
            row.map_err(|_| StoryError::Corrupt)?;
        if operation != id {
            return Err(StoryError::Corrupt);
        }
        let discriminator: serde_json::Value =
            serde_json::from_str(&document).map_err(|_| StoryError::Corrupt)?;
        match (
            discriminator.get("version").and_then(|v| v.as_u64()),
            discriminator.get("kind").and_then(|v| v.as_str()),
        ) {
            (Some(1), None) => {
                if action == "branch" || action == "rewrite" {
                    return Err(StoryError::Corrupt);
                }
                read_receipt(connection, &session, &operation)?.ok_or(StoryError::Corrupt)?;
            }
            (Some(2), Some("branch")) => {
                let receipt = BranchReceipt::decode(&document)?;
                if action != "branch"
                    || receipt.session_id != session
                    || receipt.chapter_id != id
                    || receipt.chapter_index != index
                    || receipt.request_digest != operation_digest
                {
                    return Err(StoryError::Corrupt);
                }
                if history {
                    super::history::match_revision(connection, &session, &id, receipt.revision)?;
                }
                audit_branch_receipt(connection, &receipt)?;
            }
            (Some(2), Some("branch-copy")) => {
                let marker = CopyMarker::decode(&document)?;
                if marker.session_id != session
                    || marker.chapter_id != id
                    || marker.chapter_index != index
                    || marker.request_digest != operation_digest
                    || marker.chapter_id
                        != super::copy_id(&session, super::CopyKind::Chapter, index)?
                {
                    return Err(StoryError::Corrupt);
                }
                let parent = branch_receipt(connection, &session, &marker.branch_operation_id)?;
                if index > parent.prefix_end_index || marker.request_digest != parent.request_digest
                {
                    return Err(StoryError::Corrupt);
                }
                let checkpoint: Option<String> = connection.query_row(
                    "SELECT id FROM arena_story_checkpoint WHERE session_id=?1 AND chapter_id=?2 AND boundary_index=?3",
                    params![session,id,index], |r|r.get(0)).optional().map_err(|_|StoryError::Corrupt)?;
                if checkpoint.as_deref()
                    != Some(super::copy_id(&session, super::CopyKind::Checkpoint, index)?.as_str())
                {
                    return Err(StoryError::Corrupt);
                }
            }
            (Some(3), Some("tail-rewrite")) if history => {
                super::history::audit_rewrite_receipt(
                    connection,
                    &session,
                    &id,
                    index,
                    &action,
                    &operation_digest,
                    &document,
                )?;
            }
            _ => return Err(StoryError::Corrupt),
        }
    }
    Ok(())
}

/// Never follows a source/provenance identity. Only a target-local generation row
/// can own markers; a copied historical branch action cannot masquerade as one.
fn branch_receipt(
    connection: &Connection,
    session: &str,
    operation: &str,
) -> Result<BranchReceipt, StoryError> {
    let row: Option<(String,String,String,u64)> = connection.query_row(
        "SELECT receipt,id,operation_digest,chapter_index FROM arena_story_chapter WHERE session_id=?1 AND operation_id=?2 AND action='branch' AND length(CAST(receipt AS BLOB))<=2048",
        params![session,operation], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))
        .optional().map_err(|_| StoryError::Corrupt)?;
    let (document, id, digest, index) = row.ok_or(StoryError::Corrupt)?;
    let receipt = BranchReceipt::decode(&document)?;
    if receipt.session_id != session
        || receipt.operation_id != operation
        || receipt.chapter_id != id
        || receipt.request_digest != digest
        || receipt.chapter_index != index
    {
        return Err(StoryError::Corrupt);
    }
    Ok(receipt)
}

fn audit_branch_receipt(
    connection: &Connection,
    receipt: &BranchReceipt,
) -> Result<(), StoryError> {
    let k = receipt.prefix_end_index;
    if receipt.anchor_chapter_id
        != super::copy_id(&receipt.session_id, super::CopyKind::Chapter, k)?
        || receipt.anchor_checkpoint_id
            != super::copy_id(&receipt.session_id, super::CopyKind::Checkpoint, k)?
    {
        return Err(StoryError::Corrupt);
    }
    let matches: bool=connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM arena_story_chapter a JOIN arena_story_checkpoint p ON p.session_id=a.session_id AND p.boundary_index=a.chapter_index AND p.chapter_id=a.id JOIN arena_story_checkpoint n ON n.session_id=a.session_id AND n.boundary_index=a.chapter_index+1 JOIN arena_story_checkpoint z ON z.session_id=a.session_id AND z.boundary_index=0 WHERE a.session_id=?1 AND a.chapter_index=?2 AND a.id=?3 AND p.id=?4 AND n.id=?5 AND n.chapter_id=?6 AND z.id=?7)",
        params![receipt.session_id,k,receipt.anchor_chapter_id,receipt.anchor_checkpoint_id,
            receipt.checkpoint_id,receipt.chapter_id,super::copy_id(&receipt.session_id,super::CopyKind::Checkpoint,0)?],
        |r|r.get(0)).map_err(|_|StoryError::Corrupt)?;
    if !matches {
        return Err(StoryError::Corrupt);
    }
    // A branch starts an independent session. Exactly its complete prefix consists
    // of copy markers; later appends remain the original v1 receipt shape.
    let (count,first_source,last_source):(u64,Option<String>,Option<String>)=connection.query_row(
        "SELECT count(*),min(json_extract(receipt,'$.sourceSessionId')),max(json_extract(receipt,'$.sourceSessionId')) FROM arena_story_chapter WHERE session_id=?1 AND chapter_index BETWEEN 1 AND ?2 AND json_extract(receipt,'$.kind')='branch-copy' AND json_extract(receipt,'$.branchOperationId')=?3 AND json_extract(receipt,'$.requestDigest')=?4",
        params![receipt.session_id,k,receipt.operation_id,receipt.request_digest],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|StoryError::Corrupt)?;
    if count != k || first_source.is_none() || first_source != last_source {
        return Err(StoryError::Corrupt);
    }
    let branches:u64=connection.query_row(
        "SELECT count(*) FROM arena_story_chapter WHERE session_id=?1 AND json_extract(receipt,'$.kind')='branch'",
        [&receipt.session_id],|r|r.get(0)).map_err(|_|StoryError::Corrupt)?;
    if branches != 1 {
        return Err(StoryError::Corrupt);
    }
    Ok(())
}

fn audit_document(
    c: &Connection,
    table: &str,
    column: &str,
    rowid: i64,
    document: &str,
    history: bool,
) -> Result<(), StoryError> {
    use super::authority;
    use serde_json::value::RawValue;
    let raw: &RawValue = serde_json::from_str(document).map_err(|_| StoryError::Corrupt)?;
    let matches=match (table,column) {
        ("arena_story_chapter",_) => {
            let fields=authority(raw,super::CHAPTER_AUTHORITY)?;
            let v=super::chapter_index(&fields)?;
            super::super::validate_chapter_carrier(
                fields.get("markdown").ok_or(StoryError::Corrupt)?,
                fields.get("reportJson").ok_or(StoryError::Corrupt)?,
                fields.get("deterministicDigest").ok_or(StoryError::Corrupt)?,
            ).map_err(|_|StoryError::Corrupt)?;
            let units=super::super::pending::string_units(fields.get("markdown").ok_or(StoryError::Corrupt)?)?;
            let markdown_bytes:u64=char::decode_utf16(units).map(|value| value.unwrap_or('\u{fffd}').len_utf8() as u64).sum();
            if markdown_bytes!=v.markdown_byte_length {return Err(StoryError::Corrupt);}
            let superseder=super::optional_id(&fields,"supersededByChapterId")?;
            if history {
                let matches:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM arena_story_chapter WHERE rowid=?1 AND status=?2 AND superseded_by_chapter_id IS ?3)",params![rowid,v.status,superseder],|r|r.get(0)).map_err(|_|StoryError::Corrupt)?;
                if !matches {return Err(StoryError::Corrupt);}
            } else if v.status!="active" || superseder.is_some() {return Err(StoryError::Corrupt);}
            c.query_row("SELECT EXISTS(SELECT 1 FROM arena_story_chapter WHERE rowid=?1 AND id=?2 AND session_id=?3 AND chapter_index=?4 AND action=?5 AND source_chapter_id IS ?6 AND title_preview=?7 AND title_truncated=?8 AND created_at=?9 AND markdown_bytes=?10)",
                params![rowid,v.id,v.session_id,v.index,v.action,v.source_chapter_id,v.title_preview,v.title_truncated,v.created_at,v.markdown_byte_length],|r|r.get::<_,bool>(0))
        }
        ("arena_story_checkpoint",_) => {
            let fields=authority(raw,super::CHECKPOINT_AUTHORITY)?;
            let v=super::checkpoint_index(&fields)?;
            super::super::validate_checkpoint_carrier(fields.get("combatants").ok_or(StoryError::Corrupt)?)
                .map_err(|_|StoryError::Corrupt)?;
            c.query_row("SELECT EXISTS(SELECT 1 FROM arena_story_checkpoint WHERE rowid=?1 AND id=?2 AND session_id=?3 AND boundary_index=?4 AND chapter_id IS ?5)",
                params![rowid,v.id,v.session_id,v.boundary_index,v.chapter_id],|r|r.get::<_,bool>(0))
        }
        ("arena_story_session","seed_document") => {
            let fields=authority(raw,&["combatants"])?;
            return super::super::validate_checkpoint_carrier(fields.get("combatants").ok_or(StoryError::Corrupt)?)
                .map_err(|_|StoryError::Corrupt);
        }
        ("arena_story_session","document") => {
            let v=session_index(raw)?;
            audit_branch_origin(c,&v.id,raw)?;
            if v.source.mode!=v.mode {return Err(StoryError::Corrupt);}
            let indexed:Option<String>=c.query_row("SELECT chapter_plan FROM arena_story_session WHERE rowid=?1",[rowid],|r|r.get(0)).map_err(|_|StoryError::Corrupt)?;
            match (&v.chapter_plan,indexed) {
                (None,None)=>{},
                (Some(plan),Some(indexed))=>{
                    let indexed:super::super::StoryChapterPlan=serde_json::from_str(&indexed).map_err(|_|StoryError::Corrupt)?;
                    if plan.total_chapters!=indexed.total_chapters || plan.source!=indexed.source || plan.locked!=indexed.locked {return Err(StoryError::Corrupt);}
                },
                _=>return Err(StoryError::Corrupt),
            }
            c.query_row("SELECT EXISTS(SELECT 1 FROM arena_story_session WHERE rowid=?1 AND id=?2 AND revision=?3 AND chapter_count=?4 AND last_chapter_id=?5 AND working_checkpoint_id=?6 AND last_input_checkpoint_id=?7 AND title_preview=?8 AND title_truncated=?9 AND mode=?10 AND created_at=?11 AND updated_at=?12)",
                params![rowid,v.id,v.revision,v.chapter_count,v.last_chapter_id,v.working_checkpoint_id,v.last_input_checkpoint_id,v.title_preview,v.title_truncated,v.mode,v.created_at,v.updated_at],|r|r.get::<_,bool>(0))
        }
        _=>return Err(StoryError::Corrupt),
    }.map_err(|_|StoryError::Corrupt)?;
    if matches {
        Ok(())
    } else {
        Err(StoryError::Corrupt)
    }
}

/// Fixed authoritative session projection; opaque fields stay raw. Shared with
/// branch stage validation so neither reader rejects unknown lone-surrogate keys.
pub(super) fn session_index(
    raw: &serde_json::value::RawValue,
) -> Result<super::super::SessionIndex, StoryError> {
    use super::{authority, required};
    let fields = authority(
        raw,
        &[
            "id",
            "revision",
            "chapterCount",
            "lastChapterId",
            "workingCheckpointId",
            "lastInputCheckpointId",
            "titlePreview",
            "titleTruncated",
            "mode",
            "source",
            "chapterPlan",
            "createdAt",
            "updatedAt",
            "seed",
            "workingCombatants",
            "lastChapterInputCombatants",
            "branchOf",
        ],
    )?;
    if ["seed", "workingCombatants", "lastChapterInputCombatants"]
        .iter()
        .any(|k| fields.contains_key(k))
    {
        return Err(StoryError::Corrupt);
    }
    let source = authority(fields.get("source").ok_or(StoryError::Corrupt)?, &["mode"])?;
    let chapter_plan = fields
        .get("chapterPlan")
        .filter(|v| v.get() != "null")
        .map(|raw| {
            let fields = authority(raw, &["totalChapters", "source", "locked"])?;
            Ok::<_, StoryError>(super::super::StoryChapterPlan {
                total_chapters: required(&fields, "totalChapters")?,
                source: required(&fields, "source")?,
                locked: required(&fields, "locked")?,
            })
        })
        .transpose()?;
    Ok(super::super::SessionIndex {
        id: required(&fields, "id")?,
        revision: required(&fields, "revision")?,
        chapter_count: required(&fields, "chapterCount")?,
        last_chapter_id: required(&fields, "lastChapterId")?,
        working_checkpoint_id: required(&fields, "workingCheckpointId")?,
        last_input_checkpoint_id: required(&fields, "lastInputCheckpointId")?,
        title_preview: required(&fields, "titlePreview")?,
        title_truncated: required(&fields, "titleTruncated")?,
        mode: required(&fields, "mode")?,
        source: super::super::SourceIndex {
            mode: required(&source, "mode")?,
        },
        chapter_plan,
        created_at: required(&fields, "createdAt")?,
        updated_at: required(&fields, "updatedAt")?,
        _seed: (),
        _working_combatants: (),
        _last_chapter_input_combatants: (),
    })
}

// Emit an equality predicate for the target path, so SQLite can use its session
// indexes instead of walking every unrelated row for a nullable OR predicate.
pub(super) fn scope_sql(sql: &str, session: Option<&str>) -> String {
    if session.is_none() {
        return sql.to_owned();
    }
    let mut sql = sql.to_owned();
    for column in [
        "id",
        "session_id",
        "s.id",
        "c.session_id",
        "p.session_id",
        "a.session_id",
    ] {
        sql = sql.replace(
            &format!("(?1 IS NULL OR {column}=?1)"),
            &format!("{column}=?1"),
        );
    }
    sql
}

pub(crate) fn audit_branch_origin(
    c: &Connection,
    session: &str,
    raw: &serde_json::value::RawValue,
) -> Result<(), StoryError> {
    use super::{authority, required};
    let document:Option<String>=c.query_row(
        "SELECT receipt FROM arena_story_chapter WHERE session_id=?1 AND json_extract(receipt,'$.kind')='branch' AND length(CAST(receipt AS BLOB))<=2048",
        [session],|r|r.get(0)).optional().map_err(|_|StoryError::Corrupt)?;
    // A legacy linear session may already carry provenance. Only native v2
    // branch sessions acquire this durable target-local provenance invariant.
    let Some(document) = document else {
        return Ok(());
    };
    let branch = BranchReceipt::decode(&document)?;
    let marker:String=c.query_row(
        "SELECT receipt FROM arena_story_chapter WHERE session_id=?1 AND id=?2 AND length(CAST(receipt AS BLOB))<=2048",
        params![session,branch.anchor_chapter_id],|r|r.get(0)).map_err(|_|StoryError::Corrupt)?;
    let marker = CopyMarker::decode(&marker)?;
    let fields = authority(raw, &["branchOf"])?;
    let origin = authority(
        fields.get("branchOf").ok_or(StoryError::Corrupt)?,
        &["sessionId", "chapterId", "chapterIndex"],
    )?;
    if required::<String>(&origin, "sessionId")? != marker.source_session_id
        || required::<String>(&origin, "chapterId")? != marker.source_chapter_id
        || required::<u64>(&origin, "chapterIndex")? != branch.prefix_end_index
    {
        return Err(StoryError::Corrupt);
    }
    Ok(())
}
