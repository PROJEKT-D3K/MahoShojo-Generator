//! Production commands and AppManifest ACL through Tauri's in-process invoke harness.
use super::*;
use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};

fn call(
    webview: &tauri::WebviewWindow<MockRuntime>,
    command: &str,
    request: Value,
) -> Result<InvokeResponseBody, Value> {
    get_ipc_response(
        webview,
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body: InvokeBody::Json(json!({"request":request})),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/local-image-assets.json"
    ))
    .unwrap()
}

#[test]
fn image_asset_production_ipc_roundtrip_acl_and_maintenance_boundary() {
    let root = tempfile::tempdir().unwrap();
    let library = LocalLibrary::open(root.path()).unwrap();
    let app = mock_builder()
        .manage(library)
        .manage(PendingRestore::default())
        .invoke_handler(tauri::generate_handler![
            save_local_image_asset,
            list_local_image_assets,
            read_local_image_asset,
            delete_local_image_asset,
            restore_local_image_asset,
            purge_local_image_asset,
            export_local_image_asset,
        ])
        .build(tauri::generate_context!())
        .unwrap();
    let main = tauri::WebviewWindowBuilder::new(&app, "main-ui", Default::default())
        .build()
        .unwrap();
    let untrusted = tauri::WebviewWindowBuilder::new(&app, "untrusted", Default::default())
        .build()
        .unwrap();
    let f = fixture();
    let save = json!({"title":f["asset"]["title"],"payload":f["payload"]});
    let id = f["asset"]["id"].clone();
    let target = json!({"id":id});
    for command in [
        "save_local_image_asset",
        "list_local_image_assets",
        "read_local_image_asset",
        "delete_local_image_asset",
        "restore_local_image_asset",
        "purge_local_image_asset",
        "export_local_image_asset",
    ] {
        assert!(
            call(&untrusted, command, save.clone()).is_err(),
            "{command} must require main-ui"
        );
    }
    let mut invalid = save.clone();
    invalid["url"] = json!("https://invalid");
    assert_eq!(
        call(&main, "save_local_image_asset", invalid).unwrap_err()["code"],
        "image-invalid-input"
    );
    let response = call(&main, "save_local_image_asset", save.clone())
        .unwrap()
        .deserialize::<Value>()
        .unwrap();
    assert_eq!(response["outcome"], "stored");
    assert_eq!(response["asset"]["id"], id);
    let InvokeResponseBody::Raw(bytes) =
        call(&main, "read_local_image_asset", target.clone()).unwrap()
    else {
        panic!("read must be raw bytes")
    };
    assert_eq!(
        blob::digest_of(&bytes),
        f["asset"]["digest"].as_str().unwrap()
    );
    let exported = call(&main, "export_local_image_asset", target.clone())
        .unwrap()
        .deserialize::<Value>()
        .unwrap();
    assert_eq!(
        std::fs::read(exported["absolutePath"].as_str().unwrap()).unwrap(),
        bytes
    );
    let busy = app
        .state::<LocalLibrary>()
        .enter_maintenance("image-test")
        .unwrap();
    assert_eq!(
        call(&main, "save_local_image_asset", save.clone()).unwrap_err()["code"],
        "maintenance-busy"
    );
    assert!(call(&main, "read_local_image_asset", target.clone()).is_ok());
    drop(busy);
    call(&main, "delete_local_image_asset", target.clone()).unwrap();
    assert!(call(&main, "save_local_image_asset", save.clone())
        .unwrap()
        .deserialize::<Value>()
        .unwrap()["asset"]["deletedAt"]
        .is_string());
    let trash = call(
        &main,
        "list_local_image_assets",
        json!({"view":"trash","limit":100,"cursor":null}),
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    assert_eq!(trash["items"].as_array().unwrap().len(), 1);
    call(&main, "restore_local_image_asset", target.clone()).unwrap();
    assert_eq!(
        call(&main, "purge_local_image_asset", target.clone()).unwrap_err()["code"],
        "image-not-deleted"
    );
    call(&main, "delete_local_image_asset", target.clone()).unwrap();
    call(&main, "purge_local_image_asset", target.clone()).unwrap();
    assert_eq!(
        call(&main, "read_local_image_asset", target.clone()).unwrap_err()["code"],
        "image-not-found"
    );
    let permit = app
        .state::<LocalLibrary>()
        .enter_maintenance("restore-test")
        .unwrap();
    *app.state::<PendingRestore>().0.lock().unwrap() = Some(permit);
    assert_eq!(
        call(&main, "save_local_image_asset", save).unwrap_err()["code"],
        "restore-pending"
    );
    assert_eq!(
        call(&main, "read_local_image_asset", target).unwrap_err()["code"],
        "restore-pending"
    );
}

#[test]
fn image_asset_request_dto_rejects_unknown_paths_urls_and_malformed_envelopes() {
    let f = fixture();
    assert!(serde_json::from_value::<image_asset::SaveRequest>(
        json!({"title":"a","payload":f["payload"],"url":"https://invalid"})
    )
    .is_err());
    assert!(serde_json::from_value::<image_asset::SaveRequest>(json!({"title":"a","payload":{"encoding":"base64","data":"","byteLength":0,"path":"C:/private"}})).is_err());
    assert!(serde_json::from_value::<image_asset::IdRequest>(
        json!({"id":f["asset"]["id"],"path":"C:/private"})
    )
    .is_err());
}
