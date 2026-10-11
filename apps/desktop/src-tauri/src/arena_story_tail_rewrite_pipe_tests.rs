//! Explicit synthetic-library stdin bridge. Never a registered IPC or release
//! feature flag; schema 11 is scoped to this test thread only.
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
        "tail-source" | "tail-rewrite-source" => {
            encoded(store.resolve_tail_rewrite_source(&parse(request, "request")?))
        }
        "tail-begin" | "tail-rewrite-begin" => {
            let fields = authority(request, &["manifest"])?;
            let manifest = TailRewriteManifest::decode(
                fields.get("manifest").ok_or(StoryError::Invalid)?.get(),
            )?;
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
        "tail-end" | "tail-rewrite-end" => {
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
            encoded(store.end_tail_rewrite_with_hook(&parse::<String>(request,"token")?,Instant::now(),&mut |step,c|{
                if fault=="rollback"&&step=="before-commit"{return Err(StoryError::Busy);}
                if fault=="commit-unknown"&&step=="after-commit"{return Err(StoryError::Io);}
                if fault=="rollback-failed"&&step=="before-commit"{c.execute_batch("ROLLBACK").map_err(|_|StoryError::Io)?;return Err(StoryError::Busy);}
                if fault=="commit-failed"&&step=="before-commit"{c.execute("DELETE FROM arena_story_checkpoint WHERE id IN (SELECT working_checkpoint_id FROM arena_story_session)",[]).map_err(|_|StoryError::Io)?;}
                Ok(())
            }))
        }
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
#[test]
#[ignore = "requires explicit private-root stdin runner; not Tauri or Windows acceptance"]
fn real_store_tail_rewrite_completion_pipe() {
    crate::store::with_history_schema_for_test(|| {
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
    });
}
