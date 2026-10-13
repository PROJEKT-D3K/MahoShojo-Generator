use super::*;
use crate::library::LocalLibrary;
use serde_json::json;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/desktop-magic-tea-party.json"
    ))
    .unwrap()
}
fn setup() -> (SharedConnection, TeaStore) {
    let c = crate::store::open_in_memory_connection().unwrap();
    let store = TeaStore::open(Arc::clone(&c), MaintenanceGate::shared()).unwrap();
    (c, store)
}
fn session(sid: &str) -> Value {
    let mut value = fixture()["session"].clone();
    value["id"] = json!(sid);
    value
}
fn message(sid: &str, mid: &str, role: &str, text: &str) -> Value {
    json!({"id":mid,"sessionId":sid,"role":role,"content":text,"createdAt":2,"status":"done"})
}
fn request(value: Value) -> Value {
    json!({"version":1,"request":value})
}
fn create(store: &TeaStore, sid: &str) -> Value {
    store
        .mutate(request(json!({"action":"create","session":session(sid)})))
        .unwrap()["result"]
        .clone()
}
fn head(store: &TeaStore, sid: &str) -> Value {
    store
        .read(request(
            json!({"action":"session","sessionId":sid,"expectedCatalogRevision":null}),
        ))
        .unwrap()["result"]["record"]
        .clone()
}
fn list(store: &TeaStore) -> Value {
    store
        .read(request(
            json!({"action":"list","cursor":null,"expectedCatalogRevision":null,"limit":50}),
        ))
        .unwrap()["result"]
        .clone()
}
fn pages(
    store: &TeaStore,
    sid: &str,
    head: &Value,
    cursor: Value,
    limit: usize,
) -> Result<Value, TeaError> {
    store.read(request(json!({"action":"messages","sessionId":sid,"instance":head["instance"],"expectedRevision":head["revision"],"cursor":cursor,"expectedCatalogRevision":null,"limit":limit})))
}
fn target_request(action: &str, sid: &str, head: &Value) -> Value {
    json!({"action":action,"sessionId":sid,"instance":head["instance"],"expectedRevision":head["revision"]})
}
fn import(sid: &str) -> Value {
    request(
        json!({"action":"import","operationId":format!("import-{sid}"),"entries":[{"session":session(sid),"messages":[message(sid,&format!("m-{sid}"),"user","保留正文")]}]}),
    )
}
fn receipt(store: &TeaStore, write: Value) -> Result<Value, TeaError> {
    store.read(request(json!({"action":"receipt","write":write})))
}
fn begin(store: &TeaStore, sid: &str) -> (Value, Value) {
    let h = head(store, sid);
    let mut begin = target_request("begin-generation", sid, &h);
    begin["operationId"] = json!(format!("begin-{sid}"));
    begin["session"] = h["session"].clone();
    begin["userMessage"] = message(sid, &format!("user-{sid}"), "user", "你好");
    begin["assistantMessage"] = json!({"id":format!("assistant-{sid}"),"sessionId":sid,"role":"assistant","content":"","createdAt":3,"status":"streaming"});
    let wire = request(begin);
    let result = store.mutate(wire.clone()).unwrap()["result"].clone();
    (wire, result)
}
fn finish(sid: &str, h: &Value, content: &str) -> Value {
    let mut finish = target_request("finish-generation", sid, h);
    finish["operationId"] = json!(format!("finish-{sid}"));
    finish["beginOperationId"] = json!(format!("begin-{sid}"));
    finish["session"] = session(sid);
    finish["assistantMessage"] = json!({"id":format!("assistant-{sid}"),"sessionId":sid,"role":"assistant","content":content,"createdAt":3,"status":"done"});
    request(finish)
}
fn snapshot(c: &SharedConnection) -> String {
    let c = lock_connection(c).unwrap();
    let mut result = Vec::new();
    for table in [
        "magic_tea_session",
        "magic_tea_message",
        "magic_tea_receipt",
        "magic_tea_catalog",
    ] {
        let mut query = c
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1"))
            .unwrap();
        let cols = query.column_count();
        let rows = query
            .query_map([], |row| {
                (0..cols)
                    .map(|i| row.get::<_, rusqlite::types::Value>(i))
                    .collect::<Result<Vec<_>, _>>()
            })
            .unwrap();
        result.push(format!(
            "{table}:{:?}",
            rows.collect::<Result<Vec<_>, _>>().unwrap()
        ));
    }
    result.join("\n")
}

#[test]
fn shared_fixture_documents_round_trip_and_two_commands_are_closed() {
    let (_, store) = setup();
    let write = import("fixture");
    let result = store.mutate(write.clone()).unwrap();
    assert_eq!(result["result"]["action"], "import");
    assert_eq!(head(&store, "fixture")["session"], session("fixture"));
    assert_eq!(
        receipt(&store, write).unwrap()["result"]["receipt"]["result"],
        result["result"]
    );
    assert_eq!(
        store.read(request(json!({"action":"arbitrary","sql":"SELECT 1"}))),
        Err(TeaError::Invalid)
    );
    assert_eq!(store.mutate(json!({"version":1,"request":{"action":"create","session":session("b"),"path":"elsewhere"}})),Err(TeaError::Invalid));
    assert_eq!(
        store.mutate(json!({"version":2,"request":{"action":"create","session":session("b")}})),
        Err(TeaError::Invalid)
    );
}
#[test]
fn import_receipt_is_atomic_exact_and_survives_deletion_without_resurrection() {
    let (c, store) = setup();
    let write = import("a");
    let first = store.mutate(write.clone()).unwrap();
    let before = snapshot(&c);
    assert_eq!(store.mutate(write.clone()).unwrap(), first);
    assert_eq!(snapshot(&c), before);
    let mut changed = write.clone();
    changed["request"]["entries"][0]["messages"][0]["content"] = json!("changed");
    assert_eq!(
        receipt(&store, changed.clone()),
        Err(TeaError::OperationMismatch)
    );
    assert_eq!(store.mutate(changed), Err(TeaError::OperationMismatch));
    assert_eq!(snapshot(&c), before);
    let h = head(&store, "a");
    store
        .mutate(request(target_request("delete", "a", &h)))
        .unwrap();
    let deleted = snapshot(&c);
    assert_eq!(store.mutate(write.clone()).unwrap(), first);
    assert_eq!(
        receipt(&store, write).unwrap()["result"]["receipt"]["result"],
        first["result"]
    );
    assert_eq!(snapshot(&c), deleted);
    assert!(head(&store, "a").is_null());
    verify_schema(&lock_connection(&c).unwrap(), 11).unwrap();
    let miss = receipt(&store, import("absent")).unwrap();
    assert!(miss["result"]["receipt"].is_null());
    assert_eq!(snapshot(&c), deleted);
}
#[test]
fn import_preflight_and_late_sql_failure_roll_back_entire_batch() {
    let (c, store) = setup();
    let initial = snapshot(&c);
    let mut write = import("a");
    write["request"]["entries"]
        .as_array_mut()
        .unwrap()
        .push(json!({"session":session("b"),"messages":[message("b","m-b","user","other")]}));
    let mut invalid = write.clone();
    invalid["request"]["entries"][1]["messages"][0]["sessionId"] = json!("a");
    assert_eq!(store.mutate(invalid), Err(TeaError::Invalid));
    assert_eq!(snapshot(&c), initial);
    let mut duplicate = write.clone();
    duplicate["request"]["entries"][1]["messages"][0]["id"] = json!("m-a");
    assert_eq!(store.mutate(duplicate), Err(TeaError::Invalid));
    assert_eq!(snapshot(&c), initial);
    lock_connection(&c).unwrap().execute_batch("CREATE TRIGGER fail_import BEFORE INSERT ON magic_tea_message WHEN NEW.session_id='b' BEGIN SELECT RAISE(ABORT,'synthetic'); END;").unwrap();
    assert_eq!(store.mutate(write.clone()), Err(TeaError::Io));
    assert_eq!(snapshot(&c), initial);
    lock_connection(&c)
        .unwrap()
        .execute_batch("DROP TRIGGER fail_import")
        .unwrap();
    assert_eq!(
        store.mutate(write).unwrap()["result"]["sessions"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
#[test]
fn begin_commit_precedes_generation_finish_and_stale_or_deleted_results_cannot_write() {
    let (c, store) = setup();
    create(&store, "a");
    let (wire, started) = begin(&store, "a");
    let rows = pages(&store, "a", &started, Value::Null, 100).unwrap();
    assert_eq!(rows["result"]["rows"].as_array().unwrap().len(), 2);
    assert_eq!(rows["result"]["rows"][1]["message"]["status"], "streaming");
    let before = snapshot(&c);
    assert_eq!(store.mutate(wire).unwrap()["result"], started);
    assert_eq!(snapshot(&c), before);
    let mut wrong = finish("a", &started, "answer");
    wrong["request"]["assistantMessage"]["id"] = json!("wrong");
    assert_eq!(store.mutate(wrong), Err(TeaError::Stale));
    assert_eq!(snapshot(&c), before);
    let final_write = finish("a", &started, "已完成 🍵");
    let done = store.mutate(final_write.clone()).unwrap()["result"].clone();
    assert_eq!(done["revision"], 3);
    assert_eq!(
        pages(&store, "a", &done, Value::Null, 100).unwrap()["result"]["rows"][1]["message"]
            ["content"],
        "已完成 🍵"
    );
    store
        .mutate(request(target_request("delete", "a", &done)))
        .unwrap();
    let deleted = snapshot(&c);
    assert_eq!(store.mutate(final_write).unwrap()["result"], done);
    assert_eq!(snapshot(&c), deleted);
    let fresh = create(&store, "a");
    assert_ne!(fresh["instance"], done["instance"]);
    assert_eq!(
        store.mutate(finish("a", &started, "late")),
        Err(TeaError::OperationMismatch)
    );
}
#[test]
fn current_write_failure_retains_placeholder_and_exact_storage_retry_does_not_rebegin() {
    let (c, store) = setup();
    create(&store, "a");
    let (_, started) = begin(&store, "a");
    let before = snapshot(&c);
    let write = finish("a", &started, "保存重试");
    lock_connection(&c).unwrap().execute_batch("CREATE TRIGGER fail_finish BEFORE UPDATE ON magic_tea_message BEGIN SELECT RAISE(ABORT,'synthetic'); END;").unwrap();
    assert_eq!(store.mutate(write.clone()), Err(TeaError::Io));
    assert_eq!(snapshot(&c), before);
    assert!(receipt(&store, write.clone()).unwrap()["result"]["receipt"].is_null());
    lock_connection(&c)
        .unwrap()
        .execute_batch("DROP TRIGGER fail_finish")
        .unwrap();
    store.mutate(write.clone()).unwrap();
    assert_eq!(
        pages(&store, "a", &head(&store, "a"), Value::Null, 100).unwrap()["result"]["rows"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(receipt(&store, write).unwrap()["result"]["receipt"].is_object());
}
#[test]
fn restart_recovers_streaming_and_invalidates_old_finish_without_reissuing_begin() {
    let (c, store) = setup();
    create(&store, "a");
    let (wire, started) = begin(&store, "a");
    let old_catalog = list(&store)["catalogRevision"].as_i64().unwrap();
    drop(store);
    let reopened = TeaStore::open(Arc::clone(&c), MaintenanceGate::shared()).unwrap();
    let h = head(&reopened, "a");
    assert_eq!(h["revision"], 3);
    let rows = pages(&reopened, "a", &h, Value::Null, 100).unwrap();
    let recovered = &rows["result"]["rows"][1]["message"];
    assert_eq!(recovered["status"], "error");
    assert_eq!(recovered["meta"]["completion"], "interrupted");
    assert_eq!(list(&reopened)["catalogRevision"], old_catalog + 1);
    assert_eq!(
        reopened.mutate(finish("a", &started, "late")),
        Err(TeaError::Stale)
    );
    let before = snapshot(&c);
    assert_eq!(reopened.mutate(wire).unwrap()["result"], started);
    assert_eq!(snapshot(&c), before);
    verify_schema(&lock_connection(&c).unwrap(), 11).unwrap();
}
#[test]
fn generation_placeholder_rejects_extensions_without_creating_unrecoverable_rows() {
    let (c, store) = setup();
    create(&store, "a");
    let h = head(&store, "a");
    let mut operation = target_request("begin-generation", "a", &h);
    operation["operationId"] = json!("begin-a");
    operation["session"] = session("a");
    operation["userMessage"] = Value::Null;
    operation["assistantMessage"] = json!({"id":"assistant-a","sessionId":"a","role":"assistant","createdAt":3,"status":"streaming","content":"","meta":{"future":"not-a-placeholder"}});
    let before = snapshot(&c);
    assert_eq!(store.mutate(request(operation)), Err(TeaError::Invalid));
    assert_eq!(snapshot(&c), before);
}
#[test]
fn omitted_and_null_optional_user_have_same_native_receipt_normalization() {
    let (c, store) = setup();
    create(&store, "a");
    let h = head(&store, "a");
    let mut operation = target_request("begin-generation", "a", &h);
    operation["operationId"] = json!("begin-a");
    operation["session"] = session("a");
    operation["assistantMessage"] = json!({"id":"assistant-a","sessionId":"a","role":"assistant","createdAt":3,"status":"streaming","content":""});
    let write = request(operation);
    let done = store.mutate(write.clone()).unwrap();
    let before = snapshot(&c);
    assert_eq!(
        receipt(&store, write.clone()).unwrap()["result"]["receipt"]["result"],
        done["result"]
    );
    let mut null = write;
    null["request"]["userMessage"] = Value::Null;
    assert_eq!(
        receipt(&store, null.clone()).unwrap()["result"]["receipt"]["result"],
        done["result"]
    );
    assert_eq!(store.mutate(null).unwrap(), done);
    assert_eq!(snapshot(&c), before);
}
#[test]
fn catalog_and_session_cursors_fence_every_page_and_same_id_recreation() {
    let (_, store) = setup();
    store.mutate(import("a")).unwrap();
    let first = list(&store);
    let h = head(&store, "a");
    let page = pages(&store, "a", &h, Value::Null, 1).unwrap();
    assert!(page["result"]["nextCursor"].is_null());
    let mut update = target_request("update", "a", &h);
    update["session"] = h["session"].clone();
    update["session"]["title"] = json!("changed");
    store.mutate(request(update)).unwrap();
    assert_eq!(pages(&store, "a", &h, Value::Null, 1), Err(TeaError::Stale));
    assert_eq!(store.read(request(json!({"action":"list","cursor":null,"expectedCatalogRevision":first["catalogRevision"],"limit":1}))),Err(TeaError::Stale));
    let h2 = head(&store, "a");
    store
        .mutate(request(target_request("delete", "a", &h2)))
        .unwrap();
    create(&store, "a");
    assert_eq!(
        pages(&store, "a", &h2, Value::Null, 1),
        Err(TeaError::Stale)
    );
    assert_eq!(
        pages(&store, "a", &head(&store, "a"), Value::Null, 1).unwrap()["result"]["rows"],
        json!([])
    );
}
#[test]
fn unsafe_keys_media_depth_and_wrong_relationships_fail_before_writes() {
    let (c, store) = setup();
    let before = snapshot(&c);
    for bad in [
        json!({"tachieAssets":[]}),
        serde_json::from_str(r#"{"future":{"__proto__":{"x":1}}}"#).unwrap(),
    ] {
        let mut doc = session("a");
        for (k, v) in bad.as_object().unwrap() {
            doc[k] = v.clone();
        }
        assert_eq!(
            store.mutate(request(json!({"action":"create","session":doc}))),
            Err(TeaError::Invalid)
        );
    }
    let mut write = import("a");
    write["request"]["entries"][0]["messages"][0]["tachieId"] = json!("image");
    assert_eq!(store.mutate(write), Err(TeaError::Invalid));
    assert_eq!(snapshot(&c), before);
    assert!(serde_json::from_str::<Value>(r#"{"text":"\ud800"}"#).is_err());
    assert!(serde_json::from_str::<Value>(r#"{"\udfff":"key"}"#).is_err());
}
#[test]
fn backup_shape_rejects_corrupt_receipts_but_accepts_historical_deleted_sessions() {
    let (c, store) = setup();
    store.mutate(import("a")).unwrap();
    verify_schema(&lock_connection(&c).unwrap(), 11).unwrap();
    lock_connection(&c)
        .unwrap()
        .execute(
            "UPDATE magic_tea_receipt SET result=?1",
            [r#"{"action":"import","operationId":"import-a","sessions":[{}]}"#],
        )
        .unwrap();
    assert_eq!(
        verify_schema(&lock_connection(&c).unwrap(), 11),
        Err(StoreError::InvalidDocument)
    );
}
#[test]
fn maintenance_and_safe_integer_overflow_fail_without_partial_commit() {
    let c = crate::store::open_in_memory_connection().unwrap();
    let gate = MaintenanceGate::shared();
    let store = TeaStore::open(Arc::clone(&c), Arc::clone(&gate)).unwrap();
    let permit = gate.enter_maintenance("synthetic").unwrap();
    assert_eq!(store.mutate(import("a")), Err(TeaError::Maintenance));
    drop(permit);
    lock_connection(&c)
        .unwrap()
        .execute("UPDATE magic_tea_catalog SET revision=?1", [MAX_SAFE])
        .unwrap();
    let before = snapshot(&c);
    assert_eq!(store.mutate(import("a")), Err(TeaError::TooLarge));
    assert_eq!(snapshot(&c), before);
}

fn padded_message(sid: &str, mid: &str, bytes: usize) -> Value {
    let mut value = message(sid, mid, "assistant", "");
    let overhead = encoded(&value).unwrap().len();
    value["content"] = json!("a".repeat(bytes - overhead));
    assert_eq!(encoded(&value).unwrap().len(), bytes);
    value
}
#[test]
fn exact_document_and_full_write_budgets_still_allow_original_body_receipt_and_progressing_pages() {
    let (_, store) = setup();
    let sid = "s".repeat(128);
    let first_id = "a".repeat(128);
    let second_id = "b".repeat(128);
    let first = padded_message(&sid, &first_id, MESSAGE_BYTES);
    let mut second = message(&sid, &second_id, "assistant", "");
    let mut write = request(
        json!({"action":"import","operationId":"o".repeat(128),"entries":[{"session":session(&sid),"messages":[first,second]}]}),
    );
    let missing = WRITE_BYTES - encoded(&json!({"request":&write})).unwrap().len();
    second = write["request"]["entries"][0]["messages"][1].clone();
    second["content"] = json!("b".repeat(missing));
    write["request"]["entries"][0]["messages"][1] = second;
    assert_eq!(
        encoded(&json!({"request":&write})).unwrap().len(),
        WRITE_BYTES
    );
    assert!(
        encoded(&write["request"]["entries"][0]["messages"][1])
            .unwrap()
            .len()
            <= MESSAGE_BYTES
    );
    let result = store.mutate(write.clone()).unwrap();
    let query = request(json!({"action":"receipt","write":&write}));
    let query_bytes = encoded(&json!({"request":&query})).unwrap().len();
    assert!(query_bytes > WRITE_BYTES && query_bytes <= RECEIPT_READ_BYTES);
    assert_eq!(
        store.read(query).unwrap()["result"]["receipt"]["result"],
        result["result"]
    );
    let h = head(&store, &sid);
    let one = pages(&store, &sid, &h, Value::Null, 100).unwrap();
    assert_eq!(one["result"]["rows"].as_array().unwrap().len(), 1);
    assert!(encoded(&one).unwrap().len() <= PAGE_BYTES);
    assert_eq!(one["result"]["rows"][0]["message"]["id"], first_id);
    let two = pages(&store, &sid, &h, one["result"]["nextCursor"].clone(), 100).unwrap();
    assert_eq!(two["result"]["rows"].as_array().unwrap().len(), 1);
    assert_eq!(two["result"]["rows"][0]["message"]["id"], second_id);
    assert!(two["result"]["nextCursor"].is_null());
    let original = write["request"]["entries"][0]["messages"][1]["content"]
        .as_str()
        .unwrap()
        .to_owned();
    write["request"]["entries"][0]["messages"][1]["content"] = json!(original + "x");
    assert_eq!(store.mutate(write), Err(TeaError::TooLarge));
    let too_large = padded_message("small", "message", MESSAGE_BYTES + 1);
    assert_eq!(
        validate_message(&too_large, "small"),
        Err(TeaError::TooLarge)
    );
}
#[test]
fn large_short_line_projection_fits_declared_nodes_without_changing_its_segments() {
    let mut message = message("large", "m-large", "assistant", &"a\n".repeat(500_000));
    message["segments"] = Value::Array(
        (0..500_000)
            .map(|_| json!({"type":"narration","text":"a"}))
            .collect(),
    );
    let text = validate_message(&message, "large").unwrap();
    assert!(text.len() > 16 * 1024 * 1024);
    assert!(text.len() < MESSAGE_BYTES);
    assert_eq!(message["segments"].as_array().unwrap().len(), 500_000);
}
#[test]
fn nonempty_tea_backup_restores_records_receipts_and_recovers_interrupted_generation() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let guard = crate::maintenance::InstanceGuard::acquire(root).unwrap();
    let library = LocalLibrary::open(root).unwrap();
    let imported = import("a");
    library.tea().mutate(imported.clone()).unwrap();
    begin(library.tea(), "a");
    // The public backup API snapshots the same SQLite file with the Tea tables included.
    let backup = crate::backup::create_backup(&library).unwrap();
    let verified = crate::backup::verify_backup(root, &backup.backup_id).unwrap();
    assert_eq!(verified.backup_id, backup.backup_id);
    let stored = head(library.tea(), "a");
    create(library.tea(), "after-backup");
    let prepared = crate::restore::prepare_restore(&library, &backup.backup_id).unwrap();
    drop(library);
    drop(prepared.permit);
    drop(guard);
    let _restart_guard = crate::maintenance::InstanceGuard::acquire(root).unwrap();
    crate::restore::recover_pending(root).unwrap();
    let reopened = LocalLibrary::open(root).unwrap();
    assert!(head(reopened.tea(), "after-backup").is_null());
    let recovered = head(reopened.tea(), "a");
    assert_eq!(
        recovered["revision"].as_i64().unwrap(),
        stored["revision"].as_i64().unwrap() + 1
    );
    assert!(receipt(reopened.tea(), imported).unwrap()["result"]["receipt"].is_object());
}
#[test]
fn actual_native_tea_wire_is_emitted_only_from_real_storage_results() {
    let (c, store) = setup();
    let mut wire = import("tea-fixture");
    wire["request"]["entries"][0]["messages"] = fixture()["messages"].clone();
    let imported = store.mutate(wire.clone()).unwrap();
    let actual_list = store
        .read(request(
            json!({"action":"list","cursor":null,"expectedCatalogRevision":null,"limit":50}),
        ))
        .unwrap();
    let session_query = request(
        json!({"action":"session","sessionId":"tea-fixture","expectedCatalogRevision":null}),
    );
    let actual_session = store.read(session_query.clone()).unwrap();
    let record = head(&store, "tea-fixture");
    let messages = pages(&store, "tea-fixture", &record, Value::Null, 100).unwrap();
    let import_query = request(json!({"action":"receipt","write":wire}));
    let imported_receipt = store.read(import_query.clone()).unwrap();
    let (begin_wire, started) = begin(&store, "tea-fixture");
    let begin_response = response(started.clone(), DIRECTORY_BYTES).unwrap();
    let begin_query = request(json!({"action":"receipt","write":begin_wire}));
    let begin_receipt = store.read(begin_query.clone()).unwrap();
    let finish_wire = finish("tea-fixture", &started, "真实已保存文本 🍵");
    let finished = store.mutate(finish_wire.clone()).unwrap();
    let finish_query = request(json!({"action":"receipt","write":finish_wire}));
    let finish_receipt = store.read(finish_query.clone()).unwrap();
    let mut stale = target_request("update", "tea-fixture", &record);
    stale["session"] = session("tea-fixture");
    let stale_wire = request(stale);
    let stale_error = store.mutate(stale_wire.clone()).unwrap_err();
    assert_eq!(stale_error, TeaError::Stale);
    verify_schema(&lock_connection(&c).unwrap(), 11).unwrap();
    if let Some(directory) = std::env::var_os("MAGIC_TEA_PARTY_NATIVE_WIRE_OUTPUT") {
        let directory = std::path::PathBuf::from(directory);
        assert!(directory.is_dir());
        let rows = [
            ("import-request", wire),
            ("import", imported),
            ("list", actual_list),
            ("session", actual_session),
            ("messages", messages),
            ("receipt-request", import_query),
            ("receipt", imported_receipt),
            ("begin-request", begin_wire),
            ("begin", begin_response),
            ("begin-receipt-request", begin_query),
            ("begin-receipt", begin_receipt),
            ("finish-request", finish_wire),
            ("finish", finished),
            ("finish-receipt-request", finish_query),
            ("finish-receipt", finish_receipt),
            ("stale-request", stale_wire),
            ("stale-error", serde_json::to_value(stale_error).unwrap()),
        ];
        for (name, value) in rows {
            std::fs::write(
                directory.join(format!("{name}.json")),
                serde_json::to_vec(&value).unwrap(),
            )
            .unwrap();
        }
    }
}

#[test]
fn escaped_directory_previews_paginate_by_actual_wire_without_loss_or_empty_loops() {
    let (_, store) = setup();
    for index in 0..50 {
        let sid = format!("session-{index:02}");
        let mut doc = session(&sid);
        doc["title"] = json!("\u{1}".repeat(192));
        doc["roles"] = json!((0..8).map(|role| json!({"id":format!("role-{role}"),"name":"\u{2}".repeat(192),"source":"local","card":{}})).collect::<Vec<_>>());
        doc["scenario"] =
            json!({"id":"scenario","title":"\u{3}".repeat(192),"source":"local","card":{}});
        store
            .mutate(request(json!({"action":"create","session":doc})))
            .unwrap();
    }
    let mut cursor = Value::Null;
    let mut seen = HashSet::new();
    let mut count = 0;
    loop {
        let page = store
            .read(request(
                json!({"action":"list","cursor":cursor,"expectedCatalogRevision":null,"limit":50}),
            ))
            .unwrap();
        assert!(encoded(&page).unwrap().len() <= DIRECTORY_BYTES);
        let rows = page["result"]["rows"].as_array().unwrap();
        assert!(!rows.is_empty());
        for row in rows {
            assert!(seen.insert(row["id"].as_str().unwrap().to_owned()));
        }
        count += 1;
        assert!(count <= 50);
        cursor = page["result"]["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(seen.len(), 50);
    assert!(count > 1);
}
fn nested_json(depth: usize) -> Value {
    let mut value = json!("leaf");
    for _ in 0..depth {
        value = json!({"nested":value});
    }
    value
}
#[test]
fn deepest_admitted_begin_user_and_finish_message_are_readable_with_fixed_response_shell() {
    let (_, store) = setup();
    create(&store, "deep");
    let h = head(&store, "deep");
    let mut operation = target_request("begin-generation", "deep", &h);
    operation["operationId"] = json!("begin-deep");
    operation["session"] = session("deep");
    let mut user = message("deep", "user-deep", "user", "text");
    user["future"] = nested_json(60);
    operation["userMessage"] = user;
    operation["assistantMessage"] = json!({"id":"assistant-deep","sessionId":"deep","role":"assistant","createdAt":3,"status":"streaming","content":""});
    let write = request(operation);
    assert!(json_boundary(&json!({"request":&write}), WRITE_BYTES, ENVELOPE_NODES).is_ok());
    let mut beyond = write.clone();
    beyond["request"]["userMessage"]["future"] = nested_json(61);
    assert_eq!(store.mutate(beyond), Err(TeaError::TooLarge));
    let started = store.mutate(write).unwrap()["result"].clone();
    assert!(pages(&store, "deep", &started, Value::Null, 100).is_ok());
    let mut finish = finish("deep", &started, "done");
    finish["request"]["assistantMessage"]["future"] = nested_json(60);
    let done = store.mutate(finish).unwrap()["result"].clone();
    let page = pages(&store, "deep", &done, Value::Null, 100).unwrap();
    assert!(json_boundary(&page, PAGE_BYTES, ENVELOPE_NODES).is_err());
    assert!(json_boundary_depth(&page, PAGE_BYTES, ENVELOPE_NODES, 68).is_ok());
}
#[test]
fn real_deferred_commit_failure_rolls_back_all_tables_and_allows_exact_storage_retry() {
    let (c, store) = setup();
    let before = snapshot(&c);
    lock_connection(&c).unwrap().execute_batch("CREATE TABLE fault_parent(id INTEGER PRIMARY KEY); CREATE TABLE fault_child(parent INTEGER REFERENCES fault_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fault_commit AFTER INSERT ON magic_tea_session BEGIN INSERT INTO fault_child(parent) VALUES(999); END;").unwrap();
    let write = import("deferred");
    assert_eq!(store.mutate(write.clone()), Err(TeaError::CommitUnknown));
    assert_eq!(snapshot(&c), before);
    assert!(lock_connection(&c).unwrap().is_autocommit());
    assert!(receipt(&store, write.clone()).unwrap()["result"]["receipt"].is_null());
    lock_connection(&c)
        .unwrap()
        .execute_batch(
            "DROP TRIGGER fault_commit; DROP TABLE fault_child; DROP TABLE fault_parent;",
        )
        .unwrap();
    let committed = store.mutate(write.clone()).unwrap();
    let after = snapshot(&c);
    assert_eq!(
        receipt(&store, write.clone()).unwrap()["result"]["receipt"]["result"],
        committed["result"]
    );
    assert_eq!(store.mutate(write).unwrap(), committed);
    assert_eq!(snapshot(&c), after);
}
