//! Real Tauri host boundary: private instance marker, stable Document proof and four commands.
use std::borrow::Cow;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody, Response};
use tauri::{Manager, Resource, Webview};

use crate::arena_room::{AccountAccess, EngineReply, Notify, RoomInstance, RoomState};
use crate::arena_room_protocol::{self as protocol, RoomError};
use crate::arena_room_state::InstanceToken;
use crate::cloud::{self, CloudErrorCode, CloudState};
use crate::secret::SharedSecretStore;

const MAIN_WEBVIEW: &str = "main-ui";
const MARKER_NAME: &str = "mahoshojo-private-room-instance-v1";
const EVAL_TIMEOUT: Duration = Duration::from_secs(5);
static NEXT_INSTANCE: AtomicU64 = AtomicU64::new(1);
// Strongly retain this feature's only main-ui ledger until true destruction.
// Removing a ResourceTable marker or reloading is never a debt-reset mechanism.
static HOST_MARKER: OnceLock<Mutex<Option<Arc<InstanceMarker>>>> = OnceLock::new();
fn host_marker() -> &'static Mutex<Option<Arc<InstanceMarker>>> {
    HOST_MARKER.get_or_init(|| Mutex::new(None))
}

// Wry on Windows does not enforce for_main_frame_only for these scripts.
// An immutable main-frame nonce is readable by the trusted UI but grants no network authority.
// Tauri appends this verbatim after its IPC IIFE; delimit both script boundaries.
pub(crate) const DOCUMENT_SCRIPT: &str = r#";(()=>{if(window.top!==window)return;const k='__MAHOSHOJO_ROOM_DOCUMENT_V1__';if(Object.prototype.hasOwnProperty.call(window,k))return;const b=new Uint8Array(32);crypto.getRandomValues(b);Object.defineProperty(window,k,{value:Array.from(b,x=>x.toString(16).padStart(2,'0')).join(''),writable:false,configurable:false,enumerable:false});})();"#;

struct InstanceMarker {
    room: Arc<RoomInstance>,
}
impl Resource for InstanceMarker {
    fn name(&self) -> Cow<'_, str> {
        Cow::Borrowed(MARKER_NAME)
    }
}

fn unavailable() -> RoomError {
    RoomError::new("document-unavailable", "not-applicable")
}

fn read_marker(webview: &Webview) -> Option<Arc<InstanceMarker>> {
    let table = webview.resources_table();
    let marker = table.names().find_map(|(id, name)| {
        (name == MARKER_NAME)
            .then(|| table.get::<InstanceMarker>(id).ok())
            .flatten()
    });
    marker
}

/// Only a trusted host lifecycle may initialize the currently registered instance.
/// Old callbacks/commands use read-only lookup and never register into a replacement label.
fn marker(webview: &Webview, initialize: bool) -> Result<Arc<InstanceMarker>, RoomError> {
    if webview.label() != MAIN_WEBVIEW {
        return Err(unavailable());
    }
    let current = webview
        .app_handle()
        .get_webview_window(MAIN_WEBVIEW)
        .ok_or_else(unavailable)?;
    let mut created = None;
    let mut host = host_marker().lock().map_err(|_| unavailable())?;
    let caller = {
        // Initialize only the supplied physical Webview's table, never the object
        // found by label. A late old PageLoad callback cannot initialize a new view.
        let mut table = webview.resources_table();
        let existing = table.names().find_map(|(id, name)| {
            (name == MARKER_NAME)
                .then(|| table.get::<InstanceMarker>(id).ok())
                .flatten()
        });
        match existing {
            Some(value) if host.as_ref().is_some_and(|host| Arc::ptr_eq(host, &value)) => value,
            Some(_) => return Err(unavailable()),
            None if initialize && host.is_none() => {
                let mut observed = NEXT_INSTANCE.load(Ordering::SeqCst);
                let id = loop {
                    let next = observed.checked_add(1).ok_or_else(unavailable)?;
                    match NEXT_INSTANCE.compare_exchange(
                        observed,
                        next,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    ) {
                        Ok(previous) => break previous,
                        Err(actual) => observed = actual,
                    }
                };
                let state = webview.app_handle().state::<Arc<RoomState>>();
                let value = Arc::new(InstanceMarker {
                    room: state.instance(InstanceToken::new(id)),
                });
                let rid = table.add_arc(value.clone());
                *host = Some(value.clone());
                created = Some((rid, value.clone()));
                value
            }
            None => return Err(unavailable()),
        }
    }; // Never hold both ResourceTable locks: clones share the same mutex.
    drop(host);
    let registered = read_marker(current.as_ref());
    if !registered.is_some_and(|registered| Arc::ptr_eq(&caller, &registered)) {
        if let Some((rid, created)) = created {
            let _ = webview.resources_table().take::<InstanceMarker>(rid);
            created.room.destroyed();
            if let Ok(mut host) = host_marker().lock() {
                if host
                    .as_ref()
                    .is_some_and(|host| Arc::ptr_eq(host, &created))
                {
                    *host = None;
                }
            }
        }
        return Err(unavailable());
    }
    if let Some((_, created)) = created {
        // Register on the captured physical parent window, not a fresh label lookup.
        webview.window().on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                // Tauri removed/purged this actual Webview before this callback.
                created.room.destroyed();
                if let Ok(mut host) = host_marker().lock() {
                    if host
                        .as_ref()
                        .is_some_and(|host| Arc::ptr_eq(host, &created))
                    {
                        *host = None;
                    }
                }
            }
        });
    }
    Ok(caller)
}

pub(crate) fn page_load(webview: &Webview, event: tauri::webview::PageLoadEvent) {
    let Ok(current) = marker(webview, true) else {
        return;
    };
    match event {
        tauri::webview::PageLoadEvent::Started => {
            let _ = current.room.page_started();
        }
        tauri::webview::PageLoadEvent::Finished => {
            let _ = current.room.page_finished();
        }
    }
}

fn map_cloud(error: cloud::CloudError) -> RoomError {
    let code = match error.code {
        CloudErrorCode::NotAuthenticated => "not-authenticated",
        CloudErrorCode::StateMismatch => "scope-changed",
        CloudErrorCode::StorageUnavailable => "storage-unavailable",
        _ => "internal-error",
    };
    RoomError::new(code, "not-applicable")
}

fn account(webview: &Webview, expected: u64) -> Result<Arc<AccountAccess>, RoomError> {
    let app = webview.app_handle();
    let secrets = app.state::<SharedSecretStore>().inner().clone();
    let lease = cloud::room_account_lease(&app.state::<CloudState>(), secrets.as_ref(), expected)
        .map_err(map_cloud)?;
    let current_lease = lease.clone();
    let current_app = app.clone();
    let current_secrets = secrets.clone();
    let clear_lease = lease.clone();
    let clear_app = app.clone();
    let access = AccountAccess::new(
        lease.user_id,
        lease.epoch,
        lease.cancel.clone(),
        lease.cookie().to_owned(),
        Arc::new(move || {
            current_lease
                .is_current(&current_app.state::<CloudState>(), current_secrets.as_ref())
                .map_err(map_cloud)
        }),
        Arc::new(move || {
            clear_lease
                .clear_if_current(&clear_app.state::<CloudState>(), secrets.as_ref())
                .map_err(map_cloud)
        }),
    );
    Ok(Arc::new(access))
}

fn response(reply: EngineReply) -> Result<Response, RoomError> {
    let body = match reply {
        EngineReply::Small(value) => {
            let body = serde_json::to_string(&value)
                .map_err(|_| RoomError::new("internal-error", "not-applicable"))?;
            if body.len() > 1024 {
                return Err(RoomError::new("internal-error", "not-applicable"));
            }
            body
        }
        EngineReply::Json(body) => body,
    };
    Ok(Response::new(InvokeResponseBody::Json(body)))
}

pub(crate) async fn attach(
    webview: Webview,
    request: Value,
    on_event: Channel<Value>,
) -> Result<Response, RoomError> {
    let request = protocol::parse_attach(&request)?;
    let current = marker(&webview, false)?;
    let access = account(&webview, request.expected_user_id)?;
    let challenge = crate::arena_room::random_id()?;
    let attempt_result = current
        .room
        .document
        .lock()
        .map_err(|_| unavailable())?
        .begin_attach(
            current.room.instance_token(),
            request.document_nonce,
            request.attach_intent,
            access.epoch,
            challenge.clone(),
        );
    current.room.revoke_stale_scope();
    let attempt = attempt_result?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let callback_sender = Mutex::new(Some(tx));
    let callback_marker = current.clone();
    let callback_view = webview.clone();
    let callback_attempt = attempt.clone();
    let callback_access = access.clone();
    let script = format!("(()=>{{if(window.top!==window)return null;const n=window.__MAHOSHOJO_ROOM_DOCUMENT_V1__;return typeof n==='string'?{{nonce:n,challenge:'{challenge}'}}:null;}})()");
    let queued = webview.eval_with_callback(script, move |raw| {
        let Some(tx) = callback_sender
            .lock()
            .ok()
            .and_then(|mut sender| sender.take())
        else {
            return;
        };
        // This physical callback releases only its own slot, even after logical timeout.
        let valid_instance =
            marker(&callback_view, false).is_ok_and(|live| Arc::ptr_eq(&live, &callback_marker));
        let account_result = if valid_instance {
            callback_access.is_current()
        } else {
            Ok(false)
        };
        let valid_account = matches!(account_result, Ok(true));
        let decoded = if raw.len() <= 1024 {
            serde_json::from_str::<Value>(&raw).ok()
        } else {
            None
        };
        let valid_shape = decoded
            .as_ref()
            .and_then(Value::as_object)
            .is_some_and(|o| {
                o.len() == 2 && o.contains_key("nonce") && o.contains_key("challenge")
            });
        let nonce = if valid_instance && valid_account && valid_shape {
            decoded
                .as_ref()
                .and_then(|v| v.get("nonce"))
                .and_then(Value::as_str)
        } else {
            None
        };
        let challenge = if valid_instance && valid_account && valid_shape {
            decoded
                .as_ref()
                .and_then(|v| v.get("challenge"))
                .and_then(Value::as_str)
        } else {
            None
        };
        let proof = callback_marker
            .room
            .document
            .lock()
            .map_err(|_| unavailable())
            .and_then(|mut doc| {
                doc.complete_eval(
                    &callback_attempt,
                    callback_marker.room.instance_token(),
                    callback_access.epoch,
                    nonce,
                    challenge,
                )
            });
        let result = match account_result {
            Err(error) => Err(error),
            Ok(false) => Err(RoomError::new("scope-changed", "not-applicable")),
            Ok(true) => proof,
        };
        let _ = tx.send(result);
    });
    if queued.is_err() {
        // An enqueue error does not prove a platform callback was physically released.
        current
            .room
            .document
            .lock()
            .map_err(|_| unavailable())?
            .eval_timed_out(&attempt);
        return Err(unavailable());
    }
    let proof = match tokio::time::timeout(EVAL_TIMEOUT, rx).await {
        Ok(Ok(result)) => result?,
        _ => {
            current
                .room
                .document
                .lock()
                .map_err(|_| unavailable())?
                .eval_timed_out(&attempt);
            return Err(unavailable());
        }
    };
    let verified = marker(&webview, false)?;
    if !Arc::ptr_eq(&verified, &current) {
        return Err(unavailable());
    }
    let notify: Notify = Arc::new(move |raw| {
        if raw.len() > 1024 {
            return Err(RoomError::new("backpressure", "not-applicable"));
        }
        let message: Value = serde_json::from_str(&raw).map_err(|_| unavailable())?;
        on_event.send(message).map_err(|_| unavailable())
    });
    let attached = current.room.finish_attach(proof, access, notify)?;
    response(EngineReply::Json(protocol::encode_attach_response(
        &attached,
    )?))
}

pub(crate) fn request(webview: Webview, request: Value) -> Result<Response, RoomError> {
    let current = marker(&webview, false)?;
    let document = current
        .room
        .document
        .lock()
        .map_err(|_| unavailable())?
        .current_document(current.room.instance_token())?;
    response(current.room.request_owned(document, request)?)
}
pub(crate) fn subscribe(webview: Webview, request: Value) -> Result<Response, RoomError> {
    let request = protocol::parse_subscribe(&request)?;
    let current = marker(&webview, false)?;
    let document = current
        .room
        .document
        .lock()
        .map_err(|_| unavailable())?
        .current_document(current.room.instance_token())?;
    response(EngineReply::Small(
        current.room.subscribe(document, request)?,
    ))
}
pub(crate) fn detach(webview: Webview, request: Value) -> Result<Response, RoomError> {
    let handle = protocol::parse_detach(&request)?;
    let current = marker(&webview, false)?;
    let document = current
        .room
        .document
        .lock()
        .map_err(|_| unavailable())?
        .current_document(current.room.instance_token())?;
    response(EngineReply::Small(current.room.detach(document, &handle)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn script_is_fixed_main_frame_only_and_immutable() {
        assert!(DOCUMENT_SCRIPT.contains("window.top!==window"));
        assert!(DOCUMENT_SCRIPT.contains("writable:false,configurable:false"));
        assert!(!DOCUMENT_SCRIPT.contains("invoke"));
        assert!(DOCUMENT_SCRIPT.contains("crypto.getRandomValues"));
    }
}
