//! Test-only TS owner bridge to the real Tea store and Direct AI HTTP implementation.
//! No IPC registration, external origin, OS credential or production profile is accepted.
use crate::ai::{stream_direct_ai, AiExecutionRequest, AiStreamEvent, EventSink, RequestRegistry};
use crate::library::LocalLibrary;
use crate::maintenance::InstanceGuard;
use crate::secret::{SecretStore, SecretStoreError};
use crate::store::lock_connection;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::io::{BufRead, Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

const PROFILE: &str = "tea-loopback";
const SECRET_REF: &str = "provider:tea-loopback:api-key";
const SYNTHETIC_KEY: &str = "synthetic-tea-key-not-a-real-credential";
const FRAME_BYTES: u64 = 70 * 1024 * 1024;
type Output = Arc<Mutex<()>>;
type PipeResult = Result<Value, Value>;

fn failure(code: &str) -> Value {
    json!({"code":code,"message":"Synthetic Tea journey boundary failure","writeEvidence":"not-written"})
}
fn emit(output: &Output, value: Value) -> Result<(), ()> {
    let _guard = output.lock().map_err(|_| ())?;
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "\n{value}").map_err(|_| ())?;
    stdout.flush().map_err(|_| ())
}
fn reply(output: &Output, id: u64, result: PipeResult) {
    let frame = match result {
        Ok(value) => json!({"id":id,"ok":true,"value":value}),
        Err(error) => json!({"id":id,"ok":false,"error":error}),
    };
    emit(output, frame).expect("pipe output remains writable");
}
struct PipeSink {
    id: u64,
    output: Output,
}
impl EventSink for PipeSink {
    fn send(&self, event: AiStreamEvent) -> Result<(), ()> {
        emit(&self.output, json!({"id":self.id,"event":event}))
    }
}
#[derive(Default)]
struct MemorySecrets(Mutex<BTreeMap<String, String>>);
impl SecretStore for MemorySecrets {
    fn set(&self, key: &str, value: &str) -> Result<(), SecretStoreError> {
        self.0
            .lock()
            .map_err(|_| SecretStoreError::failure_for_test())?
            .insert(key.into(), value.into());
        Ok(())
    }
    fn exists(&self, key: &str) -> Result<bool, SecretStoreError> {
        Ok(self
            .0
            .lock()
            .map_err(|_| SecretStoreError::failure_for_test())?
            .contains_key(key))
    }
    fn delete(&self, key: &str) -> Result<(), SecretStoreError> {
        self.0
            .lock()
            .map_err(|_| SecretStoreError::failure_for_test())?
            .remove(key);
        Ok(())
    }
    fn resolve(&self, key: &str) -> Result<Option<String>, SecretStoreError> {
        Ok(self
            .0
            .lock()
            .map_err(|_| SecretStoreError::failure_for_test())?
            .get(key)
            .cloned())
    }
}
#[derive(Clone)]
struct Model {
    chunks: Vec<String>,
    gate: watch::Sender<bool>,
}
impl Default for Model {
    fn default() -> Self {
        Self {
            chunks: vec![
                "{\"type\":\"narration\",\"text\":\"真实管道中的茶香\"}\n".into(),
                "{\"type\":\"dialogue\",\"speakerId\":\"role\",\"text\":\"欢迎来到茶会\"}\n".into(),
                "{\"type\":\"choices\",\"items\":[{\"id\":\"next\",\"text\":\"继续\"}]}\n".into(),
            ],
            gate: watch::channel(true).0,
        }
    }
}
#[derive(Default)]
struct Observations {
    count: usize,
    disconnected: usize,
    requests: Vec<Value>,
}

async fn receive_request(stream: &mut TcpStream) -> Result<Value, ()> {
    let mut bytes = Vec::new();
    let boundary = loop {
        if bytes.len() > 32 * 1024 {
            return Err(());
        }
        let mut chunk = [0; 4096];
        let count = stream.read(&mut chunk).await.map_err(|_| ())?;
        if count == 0 {
            return Err(());
        }
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let header = std::str::from_utf8(&bytes[..boundary]).map_err(|_| ())?;
    if !header.starts_with("POST /v1/chat/completions HTTP/1.1\r\n") {
        return Err(());
    }
    let mut length = None;
    let mut authorized = false;
    for line in header.lines() {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse::<usize>().ok();
            }
            if name.eq_ignore_ascii_case("authorization") {
                authorized = value.trim() == format!("Bearer {SYNTHETIC_KEY}");
            }
        }
    }
    let length = length.ok_or(())?;
    if length > FRAME_BYTES as usize || !authorized {
        return Err(());
    }
    while bytes.len() < boundary + length {
        let mut chunk = [0; 8192];
        let count = stream.read(&mut chunk).await.map_err(|_| ())?;
        if count == 0 {
            return Err(());
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    serde_json::from_slice(&bytes[boundary..boundary + length]).map_err(|_| ())
}
async fn serve_model(mut stream: TcpStream, model: Model, observations: Arc<Mutex<Observations>>) {
    let request =
        match tokio::time::timeout(Duration::from_secs(10), receive_request(&mut stream)).await {
            Ok(Ok(request)) => request,
            _ => return,
        };
    {
        let mut observations = observations.lock().unwrap();
        observations.requests.push(request);
    }
    if stream
        .write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
        )
        .await
        .is_err()
    {
        return;
    }
    let mut gate = model.gate.subscribe();
    for (index, content) in model.chunks.iter().enumerate() {
        let frame = format!(
            "data: {}\n\n",
            json!({"choices":[{"index":0,"delta":{"content":content}}]})
        );
        if stream.write_all(frame.as_bytes()).await.is_err() {
            observations.lock().unwrap().disconnected += 1;
            return;
        }
        if index == 0 {
            loop {
                if *gate.borrow() {
                    break;
                }
                let mut byte = [0];
                tokio::select! {
                    changed = gate.changed() => if changed.is_err() { return; },
                    read = stream.read(&mut byte) => {
                        if !matches!(read, Ok(1)) { observations.lock().unwrap().disconnected += 1; return; }
                    }
                }
            }
        }
    }
    let terminal = "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":9,\"total_tokens\":16}}\n\ndata: [DONE]\n\n";
    let _ = stream.write_all(terminal.as_bytes()).await;
    let _ = stream.shutdown().await;
}
fn open_library(root: &Path, base_url: &str) -> Arc<LocalLibrary> {
    crate::restore::recover_pending(root).expect("real restore recovery");
    let library = LocalLibrary::open(root).expect("real file-backed library");
    let profile = json!({"version":1,"id":PROFILE,"name":"Synthetic Tea loopback","adapter":"openai-compatible","baseUrl":base_url,"modelId":"tea-test-model","apiKeyRef":SECRET_REF,"createdAt":"2026-10-13T00:00:00.000Z","updatedAt":"2026-10-13T00:00:00.000Z"});
    library
        .profiles()
        .put(PROFILE, &profile.to_string(), "2026-10-13T00:00:00.000Z")
        .unwrap();
    Arc::new(library)
}
fn snapshot(library: &LocalLibrary) -> PipeResult {
    let connection = lock_connection(library.connection()).map_err(|_| failure("tea-io"))?;
    let mut sessions = Vec::new();
    let mut query = connection.prepare("SELECT document,instance,revision,active_begin,active_message FROM magic_tea_session ORDER BY id").map_err(|_| failure("tea-io"))?;
    let rows = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|_| failure("tea-io"))?;
    for row in rows {
        let (document, instance, revision, active_begin, active_message) =
            row.map_err(|_| failure("tea-io"))?;
        sessions.push(json!({"session":serde_json::from_str::<Value>(&document).map_err(|_| failure("tea-io"))?,"instance":instance,"revision":revision,"activeBegin":active_begin,"activeMessage":active_message}));
    }
    let mut messages = Vec::new();
    let mut query = connection
        .prepare("SELECT document,ordinal FROM magic_tea_message ORDER BY session_id,ordinal")
        .map_err(|_| failure("tea-io"))?;
    let rows = query
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|_| failure("tea-io"))?;
    for row in rows {
        let (document, ordinal) = row.map_err(|_| failure("tea-io"))?;
        messages.push(json!({"message":serde_json::from_str::<Value>(&document).map_err(|_| failure("tea-io"))?,"ordinal":ordinal}));
    }
    let receipts: i64 = connection
        .query_row("SELECT count(*) FROM magic_tea_receipt", [], |row| {
            row.get(0)
        })
        .map_err(|_| failure("tea-io"))?;
    let catalog: i64 = connection
        .query_row(
            "SELECT revision FROM magic_tea_catalog WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(|_| failure("tea-io"))?;
    Ok(
        json!({"sessions":sessions,"messages":messages,"receiptCount":receipts,"catalogRevision":catalog}),
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Frame {
    id: u64,
    command: String,
    args: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StreamArgs {
    profile_id: String,
    request: AiExecutionRequest,
}
fn stop_streams(
    runtime: &tokio::runtime::Runtime,
    registry: &RequestRegistry,
    tasks: &mut Vec<(String, tokio::task::JoinHandle<()>)>,
) {
    for (request_id, _) in tasks.iter() {
        registry.cancel(request_id);
    }
    for (request_id, mut task) in tasks.drain(..) {
        runtime.block_on(async {
            if tokio::time::timeout(Duration::from_secs(3), &mut task)
                .await
                .is_err()
            {
                task.abort();
                let _ = task.await;
            }
        });
        registry.finish(&request_id);
    }
}
#[test]
#[ignore = "requires MAHO_TEA_JOURNEY_ROOT and an explicit TS stdin runner; not Tauri/Windows acceptance"]
fn real_tea_journey_pipe() {
    let root = std::path::PathBuf::from(
        std::env::var_os("MAHO_TEA_JOURNEY_ROOT").expect("private test root required"),
    );
    assert!(
        root.is_absolute()
            && std::fs::symlink_metadata(&root)
                .unwrap()
                .file_type()
                .is_dir()
    );
    assert_eq!(
        std::fs::read_to_string(root.join(".tea-journey-test-root")).unwrap(),
        "synthetic-tea-journey-v1\n",
        "owned synthetic library only"
    );
    let _instance = InstanceGuard::acquire(&root).unwrap();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let listener = runtime.block_on(TcpListener::bind("127.0.0.1:0")).unwrap();
    let base_url = format!(
        "http://127.0.0.1:{}/v1",
        listener.local_addr().unwrap().port()
    );
    let model = Arc::new(Mutex::new(Model::default()));
    let observations = Arc::new(Mutex::new(Observations::default()));
    let (model_server, observed) = (Arc::clone(&model), Arc::clone(&observations));
    let server = runtime.spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            observed.lock().unwrap().count += 1;
            let model = model_server.lock().unwrap().clone();
            tokio::spawn(serve_model(stream, model, Arc::clone(&observed)));
        }
    });
    let secrets = Arc::new(MemorySecrets::default());
    secrets.set(SECRET_REF, SYNTHETIC_KEY).unwrap();
    let registry = RequestRegistry::default();
    let output = Arc::new(Mutex::new(()));
    let mut library = Some(open_library(&root, &base_url));
    let mut pending_restore = None;
    let mut streams = Vec::new();
    let mut ids = HashSet::new();
    let mut drop_reply: Option<String> = None;
    reply(
        &output,
        0,
        Ok(json!({"marker":"magic-tea-party-journey-ready","version":1,"profileId":PROFILE})),
    );
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    loop {
        let mut line = String::new();
        let bytes = (&mut input)
            .take(FRAME_BYTES + 1)
            .read_line(&mut line)
            .unwrap();
        if bytes == 0 {
            break;
        }
        assert!(
            bytes as u64 <= FRAME_BYTES && line.ends_with('\n'),
            "bounded complete stdin frame"
        );
        let frame: Frame = serde_json::from_str(&line).expect("closed test frame");
        assert!(
            frame.id > 0 && ids.insert(frame.id),
            "unique positive frame id"
        );
        if frame.command == "stream_direct_ai" {
            let args = serde_json::from_value::<StreamArgs>(frame.args);
            if pending_restore.is_some() || !matches!(&args, Ok(args) if args.profile_id == PROFILE)
            {
                reply(&output, frame.id, Err(failure("tea-invalid")));
                continue;
            }
            let args = args.unwrap();
            let request_id = args.request.request_id.clone();
            let (library, secrets, registry, output) = (
                Arc::clone(library.as_ref().unwrap()),
                Arc::clone(&secrets),
                registry.clone(),
                Arc::clone(&output),
            );
            let task = runtime.spawn(async move {
                let sink = PipeSink {
                    id: frame.id,
                    output: Arc::clone(&output),
                };
                let result = stream_direct_ai(
                    PROFILE,
                    args.request,
                    library.profiles(),
                    secrets.as_ref(),
                    &registry,
                    &sink,
                )
                .await;
                reply(
                    &output,
                    frame.id,
                    result
                        .map(|_| Value::Null)
                        .map_err(|error| serde_json::to_value(error).unwrap()),
                );
            });
            streams.push((request_id, task));
            continue;
        }
        let current = library.as_ref().unwrap();
        let result = match frame.command.as_str() {
            "read_magic_tea_party" => current
                .tea()
                .read(frame.args["request"].clone())
                .map_err(|error| serde_json::to_value(error).unwrap()),
            "mutate_magic_tea_party" => match current.tea().mutate(frame.args["request"].clone()) {
                Ok(_)
                    if drop_reply.as_deref().is_some_and(|action| {
                        action == "*"
                            || frame.args["request"]["request"]["action"].as_str() == Some(action)
                    }) =>
                {
                    drop_reply = None;
                    Err(
                        json!({"code":"tea-io","message":"Synthetic reply loss after real commit","writeEvidence":"unknown"}),
                    )
                }
                result => result.map_err(|error| serde_json::to_value(error).unwrap()),
            },
            "cancel_direct_ai" => frame.args["requestId"]
                .as_str()
                .map(|id| json!(registry.cancel(id)))
                .ok_or_else(|| failure("tea-invalid")),
            "requestCount" => {
                let observed = observations.lock().unwrap();
                Ok(
                    json!({"count":observed.count,"requests":observed.requests,"disconnected":observed.disconnected,"active":registry.len()}),
                )
            }
            "snapshot" => snapshot(current),
            "drop-next-write-reply" => {
                let action = frame.args["action"].as_str().unwrap_or("*");
                if [
                    "*",
                    "begin",
                    "finish",
                    "begin-generation",
                    "finish-generation",
                    "import",
                    "create",
                    "update",
                    "delete",
                ]
                .contains(&action)
                {
                    drop_reply = Some(
                        match action {
                            "begin" => "begin-generation",
                            "finish" => "finish-generation",
                            other => other,
                        }
                        .into(),
                    );
                    Ok(Value::Null)
                } else {
                    Err(failure("tea-invalid"))
                }
            }
            "checkpoint" => match frame.args["action"].as_str() {
                Some("backup") if pending_restore.is_none() => {
                    crate::backup::create_backup(current)
                        .map(|value| serde_json::to_value(value).unwrap())
                        .map_err(|_| failure("tea-io"))
                }
                Some("prepare-restore") if pending_restore.is_none() => {
                    match frame.args["backupId"]
                        .as_str()
                        .ok_or_else(|| failure("tea-invalid"))
                        .and_then(|id| {
                            crate::restore::prepare_restore(current, id)
                                .map_err(|_| failure("tea-io"))
                        }) {
                        Ok(prepared) => {
                            let value = serde_json::to_value(&prepared.response).unwrap();
                            pending_restore = Some(prepared);
                            Ok(value)
                        }
                        Err(error) => Err(error),
                    }
                }
                Some("release") => {
                    model.lock().unwrap().gate.send_replace(true);
                    Ok(Value::Null)
                }
                Some("model") => {
                    let chunks = frame
                        .args
                        .get("chunks")
                        .cloned()
                        .map(serde_json::from_value::<Vec<String>>)
                        .transpose();
                    match chunks {
                        Ok(chunks)
                            if chunks.as_ref().is_none_or(|chunks| {
                                !chunks.is_empty()
                                    && chunks.len() <= 32
                                    && chunks.iter().map(String::len).sum::<usize>() <= 1024 * 1024
                            }) =>
                        {
                            let mut next = Model::default();
                            if let Some(chunks) = chunks {
                                next.chunks = chunks;
                            }
                            next.gate.send_replace(frame.args["deferred"] != true);
                            *model.lock().unwrap() = next;
                            Ok(Value::Null)
                        }
                        _ => Err(failure("tea-invalid")),
                    }
                }
                _ => Err(failure("tea-invalid")),
            },
            "reopen" => {
                stop_streams(&runtime, &registry, &mut streams);
                drop(library.take());
                drop(pending_restore.take());
                library = Some(open_library(&root, &base_url));
                Ok(Value::Null)
            }
            "close" => {
                reply(&output, frame.id, Ok(Value::Null));
                break;
            }
            _ => Err(failure("tea-invalid")),
        };
        reply(&output, frame.id, result);
    }
    stop_streams(&runtime, &registry, &mut streams);
    server.abort();
    drop(library);
    drop(pending_restore);
    runtime.shutdown_timeout(Duration::from_secs(3));
}
