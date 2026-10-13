//! Schema 9 adds only the branch action. Historical migration bytes stay frozen.
//! Rebuild the entire cyclic FK component with foreign_keys ON. Rebuilding only
//! chapter leaves SQLite deferred FK counters outstanding even when FK check is empty.
//! INSERT SELECT preserves every document, receipt, operation and digest byte.
pub(crate) const MIGRATION_9: &str = r#"
CREATE TABLE arena_story_session_v9 (
    id TEXT PRIMARY KEY NOT NULL,
    document TEXT NOT NULL, document_bytes INTEGER NOT NULL, document_digest TEXT NOT NULL,
    seed_document TEXT NOT NULL, seed_bytes INTEGER NOT NULL, seed_digest TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    title_preview TEXT NOT NULL, title_truncated INTEGER NOT NULL CHECK(title_truncated IN (0,1)),
    mode TEXT NOT NULL, chapter_plan TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    chapter_count INTEGER NOT NULL CHECK(chapter_count > 0),
    last_chapter_id TEXT NOT NULL, working_checkpoint_id TEXT NOT NULL, last_input_checkpoint_id TEXT NOT NULL,
    FOREIGN KEY(id,last_chapter_id) REFERENCES arena_story_chapter_v9(session_id,id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY(id,working_checkpoint_id) REFERENCES arena_story_checkpoint_v9(session_id,id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY(id,last_input_checkpoint_id) REFERENCES arena_story_checkpoint_v9(session_id,id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE arena_story_chapter_v9 (
    id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, chapter_index INTEGER NOT NULL CHECK(chapter_index > 0),
    action TEXT NOT NULL CHECK(action IN ('start','continue','branch')), source_chapter_id TEXT,
    title_preview TEXT NOT NULL, title_truncated INTEGER NOT NULL CHECK(title_truncated IN (0,1)),
    created_at INTEGER NOT NULL, markdown_bytes INTEGER NOT NULL CHECK(markdown_bytes >= 0),
    document TEXT NOT NULL, document_bytes INTEGER NOT NULL, document_digest TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE, operation_digest TEXT NOT NULL, receipt TEXT NOT NULL,
    UNIQUE(session_id,id), UNIQUE(session_id,chapter_index),
    FOREIGN KEY(session_id) REFERENCES arena_story_session_v9(id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY(session_id,source_chapter_id) REFERENCES arena_story_chapter_v9(session_id,id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE arena_story_checkpoint_v9 (
    id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, boundary_index INTEGER NOT NULL CHECK(boundary_index >= 0),
    chapter_id TEXT, document TEXT NOT NULL, document_bytes INTEGER NOT NULL, document_digest TEXT NOT NULL,
    UNIQUE(session_id,id), UNIQUE(session_id,boundary_index),
    FOREIGN KEY(session_id) REFERENCES arena_story_session_v9(id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY(session_id,chapter_id) REFERENCES arena_story_chapter_v9(session_id,id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

INSERT INTO arena_story_session_v9 SELECT * FROM arena_story_session;
INSERT INTO arena_story_chapter_v9 SELECT * FROM arena_story_chapter;
INSERT INTO arena_story_checkpoint_v9 SELECT * FROM arena_story_checkpoint;
DROP TABLE arena_story_session;
DROP TABLE arena_story_chapter;
DROP TABLE arena_story_checkpoint;
ALTER TABLE arena_story_session_v9 RENAME TO arena_story_session;
ALTER TABLE arena_story_chapter_v9 RENAME TO arena_story_chapter;
ALTER TABLE arena_story_checkpoint_v9 RENAME TO arena_story_checkpoint;
CREATE INDEX arena_story_session_updated ON arena_story_session(updated_at DESC,id DESC);
"#;

/// Resolve deferred chapter-parent debt through the full child key. This is a
/// non-unique lookup index only; record bytes and all FK constraints stay intact.
pub(crate) const MIGRATION_10: &str = r#"
CREATE INDEX arena_story_chapter_source ON arena_story_chapter(session_id,source_chapter_id);
"#;

#[cfg(test)]
#[path = "arena_story_branch_schema_tests.rs"]
pub(crate) mod tests;

/// Candidate history migration. The caller must audit Tea schema 11 before executing
/// this SQL, then audit the copied schema 12 graph before committing its journal.
/// Original JSON, receipts, operation identities and digests remain byte-exact.
/// Session copy leaves deferred FK debt while chapters are copied, so both
/// reverse chapter keys must already be indexed. Temporary names avoid the old
/// schema's source index and are removed before recreating the final definitions.
/// The old checkpoint child key also needs an index for DROP chapter's implicit
/// FK-checked deletes. Dropping the old checkpoint table removes that index.
#[cfg(test)]
pub(crate) const MIGRATION_12: &str = r#"
CREATE TABLE arena_story_session_v12 (
    id TEXT PRIMARY KEY NOT NULL,
    document TEXT NOT NULL, document_bytes INTEGER NOT NULL, document_digest TEXT NOT NULL,
    seed_document TEXT NOT NULL, seed_bytes INTEGER NOT NULL, seed_digest TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    title_preview TEXT NOT NULL, title_truncated INTEGER NOT NULL CHECK(title_truncated IN (0,1)),
    mode TEXT NOT NULL, chapter_plan TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    chapter_count INTEGER NOT NULL CHECK(chapter_count > 0),
    last_chapter_id TEXT NOT NULL, working_checkpoint_id TEXT NOT NULL, last_input_checkpoint_id TEXT NOT NULL,
    FOREIGN KEY(id,last_chapter_id) REFERENCES arena_story_chapter_v12(session_id,id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY(id,working_checkpoint_id) REFERENCES arena_story_checkpoint_v12(session_id,id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY(id,last_input_checkpoint_id) REFERENCES arena_story_checkpoint_v12(session_id,id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE arena_story_chapter_v12 (
    id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, chapter_index INTEGER NOT NULL CHECK(chapter_index > 0),
    action TEXT NOT NULL CHECK(action IN ('start','continue','branch','rewrite')), source_chapter_id TEXT,
    title_preview TEXT NOT NULL, title_truncated INTEGER NOT NULL CHECK(title_truncated IN (0,1)),
    created_at INTEGER NOT NULL, markdown_bytes INTEGER NOT NULL CHECK(markdown_bytes >= 0),
    document TEXT NOT NULL, document_bytes INTEGER NOT NULL, document_digest TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE, operation_digest TEXT NOT NULL, receipt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded')),
    superseded_by_chapter_id TEXT,
    committed_revision INTEGER CHECK(committed_revision BETWEEN 1 AND 9007199254740991),
    CHECK((status='active' AND superseded_by_chapter_id IS NULL) OR (status='superseded' AND superseded_by_chapter_id IS NOT NULL)),
    UNIQUE(session_id,id),
    FOREIGN KEY(session_id,superseded_by_chapter_id) REFERENCES arena_story_chapter_v12(session_id,id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY(session_id) REFERENCES arena_story_session_v12(id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY(session_id,source_chapter_id) REFERENCES arena_story_chapter_v12(session_id,id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE arena_story_checkpoint_v12 (
    id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, boundary_index INTEGER NOT NULL CHECK(boundary_index >= 0),
    chapter_id TEXT, document TEXT NOT NULL, document_bytes INTEGER NOT NULL, document_digest TEXT NOT NULL,
    UNIQUE(session_id,id), UNIQUE(session_id,chapter_id),
    CHECK((boundary_index=0 AND chapter_id IS NULL) OR (boundary_index>0 AND chapter_id IS NOT NULL)),
    FOREIGN KEY(session_id) REFERENCES arena_story_session_v12(id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY(session_id,chapter_id) REFERENCES arena_story_chapter_v12(session_id,id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX arena_story_chapter_source_v12 ON arena_story_chapter_v12(session_id,source_chapter_id);
CREATE INDEX arena_story_chapter_superseder_v12 ON arena_story_chapter_v12(session_id,superseded_by_chapter_id);
CREATE INDEX arena_story_checkpoint_chapter_v12 ON arena_story_checkpoint(session_id,chapter_id);
INSERT INTO arena_story_session_v12 SELECT * FROM arena_story_session;
INSERT INTO arena_story_chapter_v12
SELECT *, 'active', NULL,
    CASE WHEN json_extract(receipt,'$.kind')='branch-copy' THEN NULL ELSE json_extract(receipt,'$.revision') END
FROM arena_story_chapter;
INSERT INTO arena_story_checkpoint_v12 SELECT * FROM arena_story_checkpoint;
DROP TABLE arena_story_session;
DROP TABLE arena_story_chapter;
DROP TABLE arena_story_checkpoint;
ALTER TABLE arena_story_session_v12 RENAME TO arena_story_session;
ALTER TABLE arena_story_chapter_v12 RENAME TO arena_story_chapter;
ALTER TABLE arena_story_checkpoint_v12 RENAME TO arena_story_checkpoint;
DROP INDEX arena_story_chapter_source_v12;
DROP INDEX arena_story_chapter_superseder_v12;
CREATE INDEX arena_story_session_updated ON arena_story_session(updated_at DESC,id DESC);
CREATE INDEX arena_story_chapter_source ON arena_story_chapter(session_id,source_chapter_id);
CREATE INDEX arena_story_chapter_history ON arena_story_chapter(session_id,chapter_index,id);
CREATE INDEX arena_story_chapter_superseder ON arena_story_chapter(session_id,superseded_by_chapter_id);
CREATE UNIQUE INDEX arena_story_chapter_active ON arena_story_chapter(session_id,chapter_index) WHERE status='active';
CREATE UNIQUE INDEX arena_story_chapter_revision ON arena_story_chapter(session_id,committed_revision) WHERE committed_revision IS NOT NULL;
CREATE UNIQUE INDEX arena_story_checkpoint_initial ON arena_story_checkpoint(session_id) WHERE boundary_index=0;
"#;
