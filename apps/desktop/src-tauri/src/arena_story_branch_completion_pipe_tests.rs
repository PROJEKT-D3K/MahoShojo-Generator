//! Opt-in, bounded stdin bridge to the actual store. No IPC registration, SQL from
//! the caller, external service or user database. The runner owns a private root.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::de::DeserializeOwned;
use std::io::{BufRead, Read, Write};

fn parse<T: DeserializeOwned>(value: &Value) -> Result<T, StoryError> {
    serde_json::from_value(value.clone()).map_err(|_| StoryError::Invalid)
}
fn encoded<T: Serialize>(value: Result<T, StoryError>) -> Result<Value, StoryError> {
    serde_json::to_value(value?).map_err(|_| StoryError::Invalid)
}
fn call(store: &StoryStore, request: &Value) -> Result<Value, StoryError> {
    let text = |key: &str| request[key].as_str().ok_or(StoryError::Invalid);
    let number = |key: &str| request[key].as_u64().ok_or(StoryError::Invalid);
    match text("op")? {
        "linear-begin" => encoded(store.begin(parse(&request["manifest"])?, Instant::now())),
        "branch-begin" => encoded(store.begin_branch(parse(&request["manifest"])?, Instant::now())),
        "branch-anchor" => encoded(store.resolve_branch_anchor(&parse(&request["request"])?)),
        "append" => {
            let bytes = STANDARD
                .decode(text("bytes")?)
                .map_err(|_| StoryError::Invalid)?;
            if bytes.len() > CANDIDATE_FRAME_BYTES {
                return Err(StoryError::TooLarge);
            }
            encoded(store.append(
                text("token")?,
                parse(&request["kind"])?,
                number("offset")?,
                &bytes,
                Instant::now(),
            ))
        }
        "abort" => encoded(store.abort(text("token")?)),
        "linear-end" => encoded(store.end(text("token")?, Instant::now())),
        "branch-end" => {
            let fault = request["fault"].as_str().unwrap_or("");
            if !["", "rollback", "commit-unknown"].contains(&fault) {
                return Err(StoryError::Invalid);
            }
            encoded(
                store.end_branch_with_hook(text("token")?, Instant::now(), &mut |step, _| {
                    if (fault == "rollback" && step == "before-commit")
                        || (fault == "commit-unknown" && step == "after-commit")
                    {
                        Err(StoryError::Busy)
                    } else {
                        Ok(())
                    }
                }),
            )
        }
        "branch-receipt" => encoded(store.branch_receipt(
            text("sessionId")?,
            text("operationId")?,
            text("requestDigest")?,
        )),
        "linear-receipt" => encoded(store.receipt(text("sessionId")?, text("operationId")?)),
        "sessions" => encoded(
            store.list_sessions(
                parse(&request["cursor"])?,
                Some(
                    number("limit")?
                        .try_into()
                        .map_err(|_| StoryError::Invalid)?,
                ),
            ),
        ),
        "chapters" => encoded(
            store.list_chapters(
                text("sessionId")?,
                number("revision")?,
                parse(&request["cursor"])?,
                Some(
                    number("limit")?
                        .try_into()
                        .map_err(|_| StoryError::Invalid)?,
                ),
            ),
        ),
        "describe" => encoded(store.describe_record(
            text("sessionId")?,
            number("revision")?,
            parse(&request["kind"])?,
            text("recordId")?,
        )),
        "read" => {
            let bytes = store.read_record_chunk(
                &parse(&request["descriptor"])?,
                number("offset")?,
                number("length")?
                    .try_into()
                    .map_err(|_| StoryError::Invalid)?,
            )?;
            Ok(json!(STANDARD.encode(bytes)))
        }
        "continue" => encoded(store.continue_descriptors(
            text("sessionId")?,
            number("revision")?,
            text("expectedHead")?,
        )),
        "delete" => encoded(store.delete_session(&parse(&request["target"])?, Instant::now())),
        _ => Err(StoryError::Invalid),
    }
}

#[test]
#[ignore = "requires explicit private-root stdin runner; not Tauri or Windows acceptance"]
fn real_store_branch_completion_pipe() {
    let root = std::path::PathBuf::from(
        std::env::var_os("MAHO_BRANCH_COMPLETION_PIPE_ROOT").expect("private root"),
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
        let request: Value = serde_json::from_str(&line).unwrap();
        let result = match request["op"].as_str() {
            Some("backup") if pending_restore.is_none() => {
                encoded(crate::backup::create_backup(&library).map_err(|_| StoryError::Io))
            }
            Some("prepare-restore") if pending_restore.is_none() => {
                let prepared = request["backupId"]
                    .as_str()
                    .ok_or(StoryError::Invalid)
                    .and_then(|id| {
                        crate::restore::prepare_restore(&library, id).map_err(|_| StoryError::Io)
                    });
                match prepared {
                    Ok(prepared) => {
                        let value = serde_json::to_value(&prepared.response)
                            .map_err(|_| StoryError::Invalid);
                        // The real maintenance permit stays held until this process exits.
                        pending_restore = Some(prepared);
                        value
                    }
                    Err(error) => Err(error),
                }
            }
            _ if pending_restore.is_some() => Err(StoryError::Busy),
            _ => call(library.stories(), &request),
        };
        let response = match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error}),
        };
        println!("BRANCH_PIPE {}", response);
        std::io::stdout().flush().unwrap();
    }
}
