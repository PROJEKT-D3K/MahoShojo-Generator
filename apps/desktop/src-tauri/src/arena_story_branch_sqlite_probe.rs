//! Test-only plans and statement work from the project's bundled SQLite.
//! Inspection is read-only; the separate opt-in mechanism experiment rolls back
//! all SQL-only fixture changes, including its temporary index.
//! EXPLAIN INSERT does not execute a write. Reverse-FK SELECT work is a diagnostic
//! analogue, not a measurement of the writer's actual INSERT VM work.
use rusqlite::{types::Value as SqlValue, Connection, StatementStatus};
use serde_json::{json, Value};

const ORIGIN: &str = "SELECT receipt FROM arena_story_chapter WHERE session_id=?1 AND json_extract(receipt,'$.kind')='branch' AND length(CAST(receipt AS BLOB))<=2048";

fn explain(c: &Connection, sql: &str) -> Value {
    let mut statement = c.prepare(&format!("EXPLAIN {sql}")).unwrap();
    let parameters = vec![SqlValue::Null; statement.parameter_count()];
    let mut rows = statement
        .query(rusqlite::params_from_iter(parameters.iter()))
        .unwrap();
    let mut opcodes = Vec::new();
    while let Some(row) = rows.next().unwrap() {
        assert!(opcodes.len() < 1024, "bounded diagnostic opcode list");
        opcodes.push(json!({
            "address":row.get::<_,i64>(0).unwrap(),
            "opcode":row.get::<_,String>(1).unwrap(),
            "p1":row.get::<_,i64>(2).unwrap(),
            "p2":row.get::<_,i64>(3).unwrap(),
            "p3":row.get::<_,i64>(4).unwrap(),
            "p4":row.get::<_,Option<String>>(5).unwrap(),
            "p5":row.get::<_,i64>(6).unwrap()
        }));
    }
    json!({"sql":sql,"opcodes":opcodes})
}

fn query_work(c: &Connection, sql: &str, parameters: &[&str]) -> Value {
    let mut statement = c.prepare(sql).unwrap();
    let mut count = 0u64;
    {
        let mut rows = statement
            .query(rusqlite::params_from_iter(parameters.iter()))
            .unwrap();
        while rows.next().unwrap().is_some() {
            count += 1;
        }
    }
    json!({"sql":sql,"returnedRows":count,
        "vmSteps":statement.get_status(StatementStatus::VmStep),
        "fullscanSteps":statement.get_status(StatementStatus::FullscanStep),
        "scope":"executed read-only query; fullscanSteps excludes indexed range visits"})
}

pub(super) fn inspect(c: &Connection, session: &str) -> Value {
    assert!(
        c.is_autocommit(),
        "diagnostics must stay outside measured writes"
    );
    let foreign_keys: i64 = c
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap();
    assert_eq!(foreign_keys, 1);
    let sqlite: (String, String) = c
        .query_row("SELECT sqlite_version(), sqlite_source_id()", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    let mut statement = c.prepare("SELECT name,tbl_name,rootpage,sql FROM sqlite_schema WHERE tbl_name IN ('arena_story_session','arena_story_chapter','arena_story_checkpoint') ORDER BY name").unwrap();
    let schema = statement
        .query_map([], |r| {
            Ok(
                json!({"name":r.get::<_,String>(0)?,"table":r.get::<_,String>(1)?,
                "rootpage":r.get::<_,i64>(2)?,"sql":r.get::<_,Option<String>>(3)?}),
            )
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let reverse_chapter =
        "SELECT rowid FROM arena_story_chapter WHERE session_id=?1 AND source_chapter_id=?2";
    let reverse_checkpoint =
        "SELECT rowid FROM arena_story_checkpoint WHERE session_id=?1 AND chapter_id=?2";
    // Same explicit column order as copy-chapter INSERT. EXPLAIN binds NULLs only
    // to obtain the full VM, including deferred-FK handling; no row is inserted.
    let insert_chapter = "INSERT INTO arena_story_chapter (id,session_id,chapter_index,action,source_chapter_id,title_preview,title_truncated,created_at,markdown_bytes,document,document_bytes,document_digest,operation_id,operation_digest,receipt) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?1,?13,?14)";
    json!({"sqliteVersion":sqlite.0,"sqliteSourceId":sqlite.1,"foreignKeys":foreign_keys,
        "schema":schema,
        "plans":[explain(c,ORIGIN),explain(c,reverse_chapter),explain(c,reverse_checkpoint),explain(c,insert_chapter)],
        "readWork":[query_work(c,ORIGIN,&[session]),
            query_work(c,reverse_chapter,&[session,"absent-probe-chapter"]),
            query_work(c,reverse_checkpoint,&[session,"absent-probe-chapter"])],
        "scope":"bundled SQLite read diagnostics after independent fixture setup; no write/FK/index changes"})
}

#[test]
fn plans_are_bounded_read_only_and_foreign_keys_remain_enabled() {
    assert!(include_str!("arena_story_branch_audit.rs").contains(ORIGIN));
    let c = crate::arena_story::branch::schema::tests::connection(crate::store::SCHEMA_VERSION);
    crate::arena_story::branch::schema::tests::fixture(&c, false);
    let before = c.total_changes();
    let value = inspect(&c, "target");
    assert_eq!(c.total_changes(), before);
    assert!(c.is_autocommit());
    assert_eq!(value["foreignKeys"], 1);
    assert_eq!(value["readWork"][0]["returnedRows"], 0);
    assert_eq!(value["plans"].as_array().unwrap().len(), 4);
}

#[test]
#[ignore = "serial bundled-SQLite mechanism experiment; explicit heavy-work lease required"]
fn deferred_fk_insert_vm_work_isolates_reverse_chapter_lookup() {
    let sqlite_source_id: String = Connection::open_in_memory()
        .unwrap()
        .query_row("SELECT sqlite_source_id()", [], |r| r.get(0))
        .unwrap();
    let mut results = Vec::new();
    for n in [100u64, 1000, 10000] {
        for deferred_debt in [false, true] {
            for reverse_index in [false, true] {
                // This intentionally uses schema-9 SQL fixtures, not supported
                // StoryStore commits. It isolates SQLite's FK VM mechanism only.
                let c = crate::arena_story::branch::schema::tests::connection(9);
                crate::arena_story::branch::schema::tests::fixture(&c, false);
                c.execute_batch("BEGIN").unwrap();
                if reverse_index {
                    c.execute_batch("CREATE INDEX probe_chapter_reverse ON arena_story_chapter(session_id,source_chapter_id)").unwrap();
                }
                if deferred_debt {
                    // The final INSERT resolves this exact FK debt naturally.
                    // No FK pragma is disabled and no impossible orphan is used.
                    c.execute(
                        "UPDATE arena_story_session SET last_chapter_id=?1 WHERE id='target'",
                        [format!("probe-chapter-{n}")],
                    )
                    .unwrap();
                }
                let initial_fk_violations: i64 = c
                    .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
                        r.get(0)
                    })
                    .unwrap();
                assert_eq!(initial_fk_violations, i64::from(deferred_debt));
                let index_exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='probe_chapter_reverse' AND type='index')", [], |r| r.get(0)).unwrap();
                assert_eq!(index_exists, reverse_index);
                let before = c.total_changes();
                let mut previous = "second".to_owned();
                let mut total_vm_steps = 0u64;
                let mut last_vm_steps = 0i32;
                let mut first_vm_steps = 0i32;
                let mut penultimate_vm_steps = 0i32;
                for i in 1..=n {
                    let id = format!("probe-chapter-{i}");
                    // Read/parse/hash work is excluded; production INSERT column
                    // set and FK relationships are preserved, with tiny opaque
                    // SQL-only document/receipt placeholders. Each INSERT gets
                    // a fresh statement, like Connection::execute in the writer.
                    let mut insert = c.prepare("INSERT INTO arena_story_chapter (id,session_id,chapter_index,action,source_chapter_id,title_preview,title_truncated,created_at,markdown_bytes,document,document_bytes,document_digest,operation_id,operation_digest,receipt) VALUES (?1,'target',?2,'continue',?3,'',0,0,0,'{}',2,'sql-only-probe',?1,'sql-only-probe','{}')").unwrap();
                    insert
                        .execute(rusqlite::params![id, i + 2, previous])
                        .unwrap();
                    let steps = insert.get_status(StatementStatus::VmStep);
                    assert!(steps > 0);
                    total_vm_steps += steps as u64;
                    if i == 1 {
                        first_vm_steps = steps;
                    }
                    if i == n - 1 {
                        penultimate_vm_steps = steps;
                    }
                    last_vm_steps = steps;
                    previous = id;
                }
                assert_eq!(c.total_changes() - before, n);
                let fk_violations: i64 = c
                    .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
                        r.get(0)
                    })
                    .unwrap();
                assert_eq!(fk_violations, 0, "the final INSERT must resolve the debt");
                let target_rows: i64 = c
                    .query_row(
                        "SELECT count(*) FROM arena_story_chapter WHERE session_id='target'",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(target_rows as u64, n + 2);
                c.execute_batch("ROLLBACK").unwrap();
                assert!(c.is_autocommit());
                let rows: i64 = c
                    .query_row("SELECT count(*) FROM arena_story_chapter", [], |r| r.get(0))
                    .unwrap();
                assert_eq!(rows, 2);
                let restored_head: String = c
                    .query_row(
                        "SELECT last_chapter_id FROM arena_story_session WHERE id='target'",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(restored_head, "second");
                let remaining_probe_indexes: i64 = c
                    .query_row(
                        "SELECT count(*) FROM sqlite_schema WHERE name='probe_chapter_reverse'",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(remaining_probe_indexes, 0);
                assert_eq!(
                    c.query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0))
                        .unwrap(),
                    1
                );
                results.push(json!({"insertedChapters":n,"deferredDebt":deferred_debt,"chapterReverseIndex":reverse_index,
                    "totalInsertVmSteps":total_vm_steps,"firstInsertVmSteps":first_vm_steps,"penultimateInsertVmSteps":penultimate_vm_steps,"lastInsertVmSteps":last_vm_steps,
                    "initialForeignKeyViolations":initial_fk_violations,"finalForeignKeyViolations":fk_violations,"targetChapterRowsBeforeRollback":target_rows,"observedReverseIndex":index_exists,
                    "targetChapterRowsAfterRollback":rows,"rollbackVerified":true,"foreignKeys":true}));
            }
        }
    }
    println!(
        "SQLITE_FK_MECHANISM {}",
        json!({"sqliteVersion":rusqlite::version(),"sqliteSourceId":sqlite_source_id,"results":results,
        "scope":"schema-9 raw-SQL mechanism experiment, not application-valid history, writer timings, or resource acceptance"})
    );
}
