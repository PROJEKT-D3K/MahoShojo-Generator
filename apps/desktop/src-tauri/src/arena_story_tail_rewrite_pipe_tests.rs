//! Explicit synthetic-library stdin bridge. Never a registered IPC or release
//! feature flag; schema 13 is scoped to this test thread only.
use super::*;
use crate::library::LocalLibrary;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::io::{BufRead, Read, Write};

fn parse<T: serde::de::DeserializeOwned>(
    request: &RawValue,
    key: &'static str,
) -> Result<T, StoryError> {
    let fields = authority(request, &[key])?;
    serde_json::from_str(fields.get(key).ok_or(StoryError::Invalid)?.get())
        .map_err(|_| StoryError::Invalid)
}
fn encoded<T: Serialize>(result: Result<T, StoryError>) -> Result<Value, StoryError> {
    serde_json::to_value(result?).map_err(|_| StoryError::Invalid)
}
fn call(store: &StoryStore, request: &RawValue) -> Result<Value, StoryError> {
    let op: String = parse(request, "op")?;
    match op.as_str() {
        "linear-begin" => encoded(store.begin(parse(request, "manifest")?, Instant::now())),
        "branch-begin" => encoded(store.begin_branch(parse(request, "manifest")?, Instant::now())),
        "branch-anchor" => encoded(store.resolve_branch_anchor(&parse(request, "request")?)),
        "branch-end" => {
            encoded(store.end_branch(&parse::<String>(request, "token")?, Instant::now()))
        }
        "branch-receipt" => encoded(store.branch_receipt(
            &parse::<String>(request, "sessionId")?,
            &parse::<String>(request, "operationId")?,
            &parse::<String>(request, "requestDigest")?,
        )),
        "tail-source" | "tail-rewrite-source" | "resolve_arena_story_tail_rewrite_source" => {
            encoded(store.resolve_tail_rewrite_source(&parse(request, "request")?))
        }
        "tail-begin" | "tail-rewrite-begin" => {
            let fields = authority(request, &["manifest"])?;
            let manifest = TailRewriteManifest::decode(
                fields.get("manifest").ok_or(StoryError::Invalid)?.get(),
            )?;
            encoded(store.begin_tail_rewrite(manifest, Instant::now()))
        }
        "begin_arena_story_tail_rewrite_commit" => {
            let manifest_json: String = parse(request, "manifestJson")?;
            let manifest = TailRewriteManifest::decode(&manifest_json)?;
            encoded(store.begin_tail_rewrite(manifest, Instant::now()))
        }
        "append" => {
            let text: String = parse(request, "bytes")?;
            let bytes = STANDARD.decode(text).map_err(|_| StoryError::Invalid)?;
            encoded(store.append(
                &parse::<String>(request, "token")?,
                parse(request, "kind")?,
                parse(request, "offset")?,
                &bytes,
                Instant::now(),
            ))
        }
        "abort" => encoded(store.abort(&parse::<String>(request, "token")?)),
        "linear-end" => encoded(store.end(&parse::<String>(request, "token")?, Instant::now())),
        "tail-end" | "tail-rewrite-end" | "end_arena_story_tail_rewrite_commit" => {
            let fields = authority(request, &["fault"])?;
            let fault = fields
                .get("fault")
                .map(|raw| {
                    serde_json::from_str::<String>(raw.get()).map_err(|_| StoryError::Invalid)
                })
                .transpose()?
                .unwrap_or_default();
            if ![
                "",
                "rollback",
                "commit-unknown",
                "commit-failed",
                "rollback-failed",
            ]
            .contains(&fault.as_str())
            {
                return Err(StoryError::Invalid);
            }
            let receipt = store.end_tail_rewrite_with_hook(&parse::<String>(request,"token")?,Instant::now(),&mut |step,c|{
                if fault=="rollback"&&step=="before-commit"{return Err(StoryError::Busy);}
                if fault=="commit-unknown"&&step=="after-commit"{return Err(StoryError::Io);}
                if fault=="rollback-failed"&&step=="before-commit"{c.execute_batch("ROLLBACK").map_err(|_|StoryError::Io)?;return Err(StoryError::Busy);}
                if fault=="commit-failed"&&step=="before-commit"{c.execute("DELETE FROM arena_story_checkpoint WHERE id IN (SELECT working_checkpoint_id FROM arena_story_session)",[]).map_err(|_|StoryError::Io)?;}
                Ok(())
            })?;
            if op == "end_arena_story_tail_rewrite_commit" {
                encoded(receipt.encode())
            } else {
                encoded(Ok(receipt))
            }
        }
        "query_arena_story_tail_rewrite_receipt" => encoded(
            store
                .tail_rewrite_receipt(
                    &parse::<String>(request, "sessionId")?,
                    &parse::<String>(request, "operationId")?,
                    &parse::<String>(request, "requestDigest")?,
                )?
                .map(|receipt| receipt.encode())
                .transpose(),
        ),
        "snapshot" => snapshot(store),
        "tail-receipt" | "tail-rewrite-receipt" => encoded(store.tail_rewrite_receipt(
            &parse::<String>(request, "sessionId")?,
            &parse::<String>(request, "operationId")?,
            &parse::<String>(request, "requestDigest")?,
        )),
        "linear-receipt" => encoded(store.receipt(
            &parse::<String>(request, "sessionId")?,
            &parse::<String>(request, "operationId")?,
        )),
        "describe" => encoded(store.describe_record(
            &parse::<String>(request, "sessionId")?,
            parse(request, "revision")?,
            parse(request, "kind")?,
            &parse::<String>(request, "recordId")?,
        )),
        "read" => Ok(json!(STANDARD.encode(store.read_record_chunk(
            &parse(request, "descriptor")?,
            parse(request, "offset")?,
            parse(request, "length")?
        )?))),
        "sessions" => {
            encoded(store.list_sessions(parse(request, "cursor")?, parse(request, "limit")?))
        }
        "chapters" => encoded(store.list_chapters(
            &parse::<String>(request, "sessionId")?,
            parse(request, "revision")?,
            parse(request, "cursor")?,
            parse(request, "limit")?,
        )),
        "continue" => encoded(store.continue_descriptors(
            &parse::<String>(request, "sessionId")?,
            parse(request, "revision")?,
            &parse::<String>(request, "expectedHead")?,
        )),
        "delete" => encoded(store.delete_session(&parse(request, "target")?, Instant::now())),
        _ => Err(StoryError::Invalid),
    }
}
fn snapshot(store: &StoryStore) -> Result<Value, StoryError> {
    let stages = store.stages.lock().map_err(|_| StoryError::Io)?.len();
    let c = lock_connection(&store.connection).map_err(StoryError::from_store)?;
    let version: i64 = c
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|_| StoryError::Io)?;
    let mut graph = serde_json::Map::new();
    for table in [
        "sqlite_schema",
        "arena_story_session",
        "arena_story_chapter",
        "arena_story_checkpoint",
    ] {
        let order = if table == "sqlite_schema" {
            "name"
        } else {
            "id"
        };
        let mut statement = c
            .prepare(&format!("SELECT * FROM {table} ORDER BY {order}"))
            .map_err(|_| StoryError::Io)?;
        let columns = statement.column_count();
        let mut rows = statement.query([]).map_err(|_| StoryError::Io)?;
        let mut hash = Sha256::new();
        let mut count = 0;
        while let Some(row) = rows.next().map_err(|_| StoryError::Io)? {
            count += 1;
            for index in 0..columns {
                use rusqlite::types::ValueRef;
                match row.get_ref(index).map_err(|_| StoryError::Io)? {
                    ValueRef::Null => hash.update(b"null"),
                    ValueRef::Integer(value) => {
                        hash.update(b"integer");
                        hash.update(value.to_le_bytes());
                    }
                    ValueRef::Real(value) => {
                        hash.update(b"real");
                        hash.update(value.to_le_bytes());
                    }
                    ValueRef::Text(value) | ValueRef::Blob(value) => {
                        hash.update(b"bytes");
                        hash.update((value.len() as u64).to_le_bytes());
                        hash.update(value);
                    }
                }
            }
        }
        graph.insert(
            table.into(),
            json!({"rows":count,"digest":format!("sha256:{:x}", hash.finalize())}),
        );
    }
    Ok(json!({"version":version,"stages":stages,"graph":graph}))
}
#[test]
#[ignore = "requires explicit private-root stdin runner; not Tauri or Windows acceptance"]
fn real_store_tail_rewrite_completion_pipe() {
    crate::store::with_history_schema_for_test(run_pipe);
}
#[test]
#[ignore = "requires explicit private-root stdin runner; default schema stays closed"]
fn real_store_tail_rewrite_default_schema_pipe() {
    run_pipe();
}
fn run_pipe() {
    let root = std::path::PathBuf::from(
        std::env::var_os("MAHO_TAIL_REWRITE_PIPE_ROOT").expect("private root"),
    );
    assert!(root.is_absolute() && root.is_dir());
    crate::restore::recover_pending(&root).unwrap();
    let library = LocalLibrary::open(&root).unwrap();
    let mut pending_restore = None;
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    loop {
        let mut line = String::new();
        let bytes = (&mut input)
            .take(8 * 1024 * 1024 + 1)
            .read_line(&mut line)
            .unwrap();
        if bytes == 0 {
            break;
        }
        assert!(
            bytes <= 8 * 1024 * 1024 && line.ends_with('\n'),
            "bounded complete frame"
        );
        let request: &RawValue = serde_json::from_str(&line).unwrap();
        let op: Result<String, StoryError> = parse(request, "op");
        let result = match op.as_deref() {
            Ok("backup") if pending_restore.is_none() => {
                encoded(crate::backup::create_backup(&library).map_err(|_| StoryError::Io))
            }
            Ok("prepare-restore") if pending_restore.is_none() => {
                let prepared = parse::<String>(request, "backupId").and_then(|id| {
                    crate::restore::prepare_restore(&library, &id).map_err(|_| StoryError::Io)
                });
                match prepared {
                    Ok(prepared) => {
                        let value = serde_json::to_value(&prepared.response)
                            .map_err(|_| StoryError::Invalid);
                        pending_restore = Some(prepared);
                        value
                    }
                    Err(error) => Err(error),
                }
            }
            _ if pending_restore.is_some() => Err(StoryError::Busy),
            _ => call(library.stories(), request),
        };
        let response = match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error}),
        };
        println!("TAIL_REWRITE_PIPE {}", response);
        std::io::stdout().flush().unwrap();
    }
}
