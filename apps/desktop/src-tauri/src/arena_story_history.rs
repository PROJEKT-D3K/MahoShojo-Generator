//! Candidate schema 12 tail-only history relationships. No rewrite producer or IPC is exposed here.
//! Historical receipt identity never depends on the current head or active status.
use super::super::{valid_digest, valid_id, StoryError, MAX_SAFE_INTEGER};
use super::tail_rewrite::{TailRewriteKind, TailRewriteReceipt};
use rusqlite::{params, Connection, OptionalExtension};

/// New-shaped tables must not masquerade as a historical schema. Check partial
/// indexes as well as columns: a full index would silently prohibit history.
pub(crate) fn verify_schema(c: &Connection, version: i64) -> Result<(), StoryError> {
    for (name, kind, required) in [
        ("status", "TEXT", true),
        ("superseded_by_chapter_id", "TEXT", false),
        ("committed_revision", "INTEGER", false),
    ] {
        let actual:Option<(String,bool)>=c.query_row(r#"SELECT type,"notnull" FROM pragma_table_info('arena_story_chapter') WHERE name=?1"#,[name],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_|StoryError::Corrupt)?;
        if (version == 12 && actual != Some((kind.into(), required)))
            || (version < 12 && actual.is_some())
        {
            return Err(StoryError::Corrupt);
        }
    }
    for (name, sql) in [
        ("arena_story_chapter_active","CREATE UNIQUE INDEX arena_story_chapter_active ON arena_story_chapter(session_id,chapter_index) WHERE status='active'"),
        ("arena_story_chapter_revision","CREATE UNIQUE INDEX arena_story_chapter_revision ON arena_story_chapter(session_id,committed_revision) WHERE committed_revision IS NOT NULL"),
        ("arena_story_checkpoint_initial","CREATE UNIQUE INDEX arena_story_checkpoint_initial ON arena_story_checkpoint(session_id) WHERE boundary_index=0"),
        ("arena_story_chapter_history","CREATE INDEX arena_story_chapter_history ON arena_story_chapter(session_id,chapter_index,id)"),
        ("arena_story_chapter_superseder","CREATE INDEX arena_story_chapter_superseder ON arena_story_chapter(session_id,superseded_by_chapter_id)"),
    ] {
        let actual:Option<String>=c.query_row("SELECT sql FROM sqlite_master WHERE type='index' AND name=?1",[name],|r|r.get(0)).optional().map_err(|_|StoryError::Corrupt)?;
        if (version==12 && actual.as_deref()!=Some(sql)) || (version<12 && actual.is_some()) {return Err(StoryError::Corrupt);}
    }
    if version == 12 {
        let has_full_chapter_unique:bool=c.query_row(r#"SELECT EXISTS(SELECT 1 FROM pragma_index_list('arena_story_chapter') i WHERE i."unique"=1 AND i.partial=0 AND (SELECT group_concat(name,',') FROM (SELECT name FROM pragma_index_info(i.name) ORDER BY seqno))='session_id,chapter_index')"#,[],|r|r.get(0)).map_err(|_|StoryError::Corrupt)?;
        if has_full_chapter_unique {
            return Err(StoryError::Corrupt);
        }
        // These table constraints survive the cyclic rebuild. Their ordered
        // columns distinguish the chapter-owned CP key from the old boundary key.
        let mut stmt=c.prepare(r#"SELECT name FROM pragma_index_list('arena_story_checkpoint') WHERE "unique"=1 AND partial=0"#).map_err(|_|StoryError::Corrupt)?;
        let names = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|_| StoryError::Corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| StoryError::Corrupt)?;
        let mut chapter_owned = false;
        for name in names {
            let cols:String=c.query_row("SELECT group_concat(name,',') FROM (SELECT name FROM pragma_index_info(?1) ORDER BY seqno)",[name],|r|r.get(0)).map_err(|_|StoryError::Corrupt)?;
            if cols == "session_id,boundary_index" {
                return Err(StoryError::Corrupt);
            }
            chapter_owned |= cols == "session_id,chapter_id";
        }
        if !chapter_owned {
            return Err(StoryError::Corrupt);
        }
    }
    Ok(())
}

pub(crate) fn enabled(c: &Connection) -> Result<bool, StoryError> {
    match c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)) {
        Ok(5..=11) => Ok(false),
        #[cfg(test)]
        Ok(12) => Ok(true),
        _ => Err(StoryError::Corrupt),
    }
}

pub(crate) fn active_filter(c: &Connection) -> Result<&'static str, StoryError> {
    Ok(if enabled(c)? { "status='active'" } else { "1" })
}

pub(crate) fn audit_relations(c: &Connection) -> Result<(), StoryError> {
    super::audit::audit_scope(c, None, true)
}

pub(crate) fn match_revision(
    c: &Connection,
    session: &str,
    chapter: &str,
    revision: u64,
) -> Result<(), StoryError> {
    let valid: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM arena_story_chapter c JOIN arena_story_session s ON s.id=c.session_id WHERE c.session_id=?1 AND c.id=?2 AND c.committed_revision=?3 AND ?3<=s.revision)",
        params![session, chapter, revision], |r| r.get(0)).map_err(|_| StoryError::Corrupt)?;
    if valid {
        Ok(())
    } else {
        Err(StoryError::Corrupt)
    }
}

pub(super) fn audit_graph(c: &Connection, session: Option<&str>) -> Result<(), StoryError> {
    // Only fixed indexed scalar fields are interpreted here. Full documents are
    // hashed and checked through the shared bounded raw-member auditor afterward.
    let malformed:bool=c.query_row(&super::audit::scope_sql("SELECT EXISTS(SELECT 1 FROM arena_story_chapter WHERE (?1 IS NULL OR session_id=?1) AND (length(CAST(receipt AS BLOB)) NOT BETWEEN 1 AND 2048 OR NOT json_valid(receipt)))",session),[session],|r|r.get(0)).map_err(|_|StoryError::Corrupt)?;
    if malformed {
        return Err(StoryError::Corrupt);
    }
    let sql = super::audit::scope_sql(
        r#"SELECT EXISTS(
        SELECT 1 FROM arena_story_session s
        LEFT JOIN arena_story_chapter h ON h.session_id=s.id AND h.id=s.last_chapter_id
        LEFT JOIN arena_story_checkpoint w ON w.session_id=s.id AND w.id=s.working_checkpoint_id
        LEFT JOIN arena_story_checkpoint i ON i.session_id=s.id AND i.id=s.last_input_checkpoint_id
        WHERE (?1 IS NULL OR s.id=?1) AND (
            h.status IS NOT 'active' OR h.chapter_index IS NOT s.chapter_count OR h.committed_revision IS NOT s.revision
            OR w.chapter_id IS NOT h.id OR w.boundary_index IS NOT s.chapter_count
            OR i.boundary_index IS NOT s.chapter_count-1
            OR (s.chapter_count=1 AND i.chapter_id IS NOT NULL)
            OR (s.chapter_count>1 AND NOT EXISTS(SELECT 1 FROM arena_story_chapter p WHERE p.session_id=s.id AND p.id=i.chapter_id AND p.status='active' AND p.chapter_index=s.chapter_count-1))
            OR s.chapter_count != (SELECT count(*) FROM arena_story_chapter a WHERE a.session_id=s.id AND a.status='active')
            OR 1 IS NOT (SELECT min(chapter_index) FROM arena_story_chapter a WHERE a.session_id=s.id AND a.status='active')
            OR s.chapter_count IS NOT (SELECT max(chapter_index) FROM arena_story_chapter a WHERE a.session_id=s.id AND a.status='active')
            OR s.seed_bytes<=0 OR s.revision<s.chapter_count
            OR s.revision IS NOT (SELECT max(committed_revision) FROM arena_story_chapter a WHERE a.session_id=s.id)
)
        UNION ALL
        SELECT 1 FROM arena_story_chapter a
        LEFT JOIN arena_story_chapter n ON n.session_id=a.session_id AND n.id=a.superseded_by_chapter_id
        LEFT JOIN arena_story_chapter p ON p.session_id=a.session_id AND p.id=a.source_chapter_id
        WHERE (?1 IS NULL OR a.session_id=?1) AND (
            a.status NOT IN ('active','superseded')
            OR (a.status='active' AND a.superseded_by_chapter_id IS NOT NULL)
            OR (a.status='superseded' AND (n.action IS NOT 'rewrite' OR n.chapter_index IS NOT a.chapter_index OR n.source_chapter_id IS NOT a.id OR n.committed_revision<=coalesce(a.committed_revision,0)))
            OR (a.committed_revision IS NULL) != (json_extract(a.receipt,'$.kind') IS 'branch-copy')
            OR (a.committed_revision IS NOT NULL AND a.committed_revision NOT BETWEEN 1 AND 9007199254740991)
            OR (a.action='start' AND (a.chapter_index!=1 OR a.source_chapter_id IS NOT NULL OR (a.committed_revision IS NOT NULL AND a.committed_revision!=1)))
            OR (a.action IN ('continue','rewrite') AND a.committed_revision IS NOT NULL AND NOT EXISTS(SELECT 1 FROM arena_story_chapter previous WHERE previous.session_id=a.session_id AND previous.committed_revision=a.committed_revision-1))
            OR (a.action IN ('continue','branch') AND (a.chapter_index<=1 OR p.chapter_index IS NOT a.chapter_index-1))
            OR (a.action='rewrite' AND (
                (a.committed_revision IS NULL AND a.source_chapter_id IS NOT NULL)
                OR (a.committed_revision IS NOT NULL AND (p.chapter_index IS NOT a.chapter_index OR p.superseded_by_chapter_id IS NOT a.id))))
            OR (a.committed_revision IS NOT NULL AND a.source_chapter_id IS NOT NULL AND (
                coalesce(p.committed_revision,0)>=a.committed_revision
                OR EXISTS(SELECT 1 FROM arena_story_chapter q WHERE q.session_id=p.session_id AND q.id=p.superseded_by_chapter_id AND q.committed_revision<a.committed_revision)))
            OR (a.status='active' AND a.action IN ('continue','branch') AND p.status IS NOT 'active')
            OR 1 != (SELECT count(*) FROM arena_story_checkpoint p WHERE p.session_id=a.session_id AND p.chapter_id=a.id AND p.boundary_index=a.chapter_index))
        UNION ALL
        SELECT 1 FROM arena_story_checkpoint p
        LEFT JOIN arena_story_chapter a ON a.session_id=p.session_id AND a.id=p.chapter_id
        WHERE (?1 IS NULL OR p.session_id=?1) AND (
            (p.boundary_index=0 AND p.chapter_id IS NOT NULL)
            OR (p.boundary_index>0 AND a.chapter_index IS NOT p.boundary_index))
    )"#,
        session,
    );
    let invalid: bool = c
        .query_row(&sql, [session], |r| r.get(0))
        .map_err(|_| StoryError::Corrupt)?;
    if invalid {
        return Err(StoryError::Corrupt);
    }
    Ok(())
}

pub(super) fn audit_rewrite_receipt(
    c: &Connection,
    session: &str,
    id: &str,
    index: u64,
    action: &str,
    digest: &str,
    document: &str,
) -> Result<(), StoryError> {
    let r = TailRewriteReceipt::decode(document)?;
    if r.version != 3
        || r.kind != TailRewriteKind::TailRewrite
        || action != "rewrite"
        || r.operation_id != id
        || r.chapter_id != id
        || r.session_id != session
        || r.chapter_index != index
        || r.chapter_count != index
        || !(1..=MAX_SAFE_INTEGER).contains(&r.revision)
        || r.revision <= index
        || r.request_digest != digest
        || !valid_digest(digest)
        || [
            &r.operation_id,
            &r.session_id,
            &r.chapter_id,
            &r.target_chapter_id,
            &r.input_checkpoint_id,
            &r.checkpoint_id,
        ]
        .iter()
        .any(|id| !valid_id(id))
        || r.chapter_id == r.target_chapter_id
        || r.checkpoint_id == r.input_checkpoint_id
    {
        return Err(StoryError::Corrupt);
    }
    match_revision(c, session, id, r.revision)?;
    let valid: bool=c.query_row(r#"SELECT EXISTS(
        SELECT 1 FROM arena_story_chapter a
        JOIN arena_story_chapter t ON t.session_id=a.session_id AND t.id=a.source_chapter_id
        JOIN arena_story_checkpoint o ON o.session_id=a.session_id AND o.chapter_id=a.id AND o.boundary_index=a.chapter_index
        JOIN arena_story_checkpoint i ON i.session_id=a.session_id AND i.boundary_index=a.chapter_index-1
        WHERE a.session_id=?1 AND a.id=?2 AND t.id=?3 AND t.committed_revision=a.committed_revision-1 AND t.superseded_by_chapter_id=a.id AND t.chapter_index=a.chapter_index AND o.id=?4 AND i.id=?5
            AND (i.boundary_index=0 OR EXISTS(SELECT 1 FROM arena_story_chapter p WHERE p.session_id=a.session_id AND p.id=i.chapter_id AND coalesce(p.committed_revision,0)<a.committed_revision AND (p.superseded_by_chapter_id IS NULL OR EXISTS(SELECT 1 FROM arena_story_chapter q WHERE q.session_id=p.session_id AND q.id=p.superseded_by_chapter_id AND q.committed_revision>a.committed_revision))))
            AND NOT EXISTS(SELECT 1 FROM arena_story_chapter later WHERE later.session_id=a.session_id AND later.chapter_index>a.chapter_index AND coalesce(later.committed_revision,0)<a.committed_revision AND (later.superseded_by_chapter_id IS NULL OR EXISTS(SELECT 1 FROM arena_story_chapter q WHERE q.session_id=later.session_id AND q.id=later.superseded_by_chapter_id AND q.committed_revision>=a.committed_revision)))
    )"#,params![session,id,r.target_chapter_id,r.checkpoint_id,r.input_checkpoint_id],|row|row.get(0)).map_err(|_|StoryError::Corrupt)?;
    if valid {
        Ok(())
    } else {
        Err(StoryError::Corrupt)
    }
}

#[cfg(test)]
#[path = "arena_story_history_tests.rs"]
pub(crate) mod tests;
