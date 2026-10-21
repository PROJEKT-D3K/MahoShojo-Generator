//! 只用合成凭据与 loopback，测试与生产共用换证/持久化/租约代码。
use super::*;

#[derive(Default)]
struct Secrets(Mutex<HashMap<String, String>>);
impl SecretStore for Secrets {
    fn set(&self, key: &str, value: &str) -> Result<(), SecretStoreError> {
        self.0.lock().unwrap().insert(key.into(), value.into());
        Ok(())
    }
    fn resolve(&self, key: &str) -> Result<Option<String>, SecretStoreError> {
        Ok(self.0.lock().unwrap().get(key).cloned())
    }
    fn exists(&self, key: &str) -> Result<bool, SecretStoreError> {
        Ok(self.0.lock().unwrap().contains_key(key))
    }
    fn delete(&self, key: &str) -> Result<(), SecretStoreError> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
}
fn token(expires: &str) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::json!({"v":1,"userId":42,"issuedAt":"2026-01-01T00:00:00Z","expiresAt":expires,"signature":"SYNTHETIC-NOT-A-VALID-SIGNATURE"}).to_string())
}
fn session() -> StoredSession {
    StoredSession {
        cookie: "better-auth.session_token=SYNTHETIC-COOKIE".into(),
        activity_token: None,
        auth_key: None,
        session_expires_at: None,
        account: CloudAccountRecord {
            user_id: 42,
            username: "synthetic".into(),
            display_name: None,
        },
    }
}
fn credentials() -> serde_json::Value {
    serde_json::json!({"success":true,"user":{"id":42},"activityToken":token("9999-01-01T00:00:00Z"),"authKey":"SYNTHETIC-AUTH-KEY"})
}
async fn verify_server(
    status: u16,
    body: serde_json::Value,
    release: Option<oneshot::Receiver<()>>,
) -> (
    String,
    oneshot::Receiver<()>,
    tokio::task::JoinHandle<String>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (seen, received) = oneshot::channel();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut wire = Vec::new();
        let mut buf = [0; 1024];
        while !wire.windows(4).any(|part| part == b"\r\n\r\n") {
            let n = stream.read(&mut buf).await.unwrap();
            assert_ne!(n, 0);
            wire.extend_from_slice(&buf[..n]);
        }
        let _ = seen.send(());
        if let Some(release) = release {
            let _ = release.await;
        }
        let body = body.to_string();
        let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let _ = stream.write_all(response.as_bytes()).await;
        String::from_utf8(wire).unwrap()
    });
    (origin, received, task)
}

#[test]
fn activity_expiry_is_only_a_cache_refresh_hint() {
    assert!(activity_token_needs_refresh(None));
    assert!(activity_token_needs_refresh(Some("not-base64")));
    assert!(activity_token_needs_refresh(Some(&token(
        "2000-01-01T00:00:00Z"
    ))));
    assert!(activity_token_needs_refresh(Some(&token("invalid"))));
    // 假签名仍可作为缓存提示：实际派发后必须由服务端验签，不在 native 授权。
    assert!(!activity_token_needs_refresh(Some(&token(
        "9999-01-01T00:00:00Z"
    ))));
}

#[tokio::test]
async fn room_legacy_verify_merges_credentials_without_changing_lease() {
    let (origin, _, server) = verify_server(200, credentials(), None).await;
    let state = CloudState::with_origin(&origin);
    let secrets = Secrets::default();
    store_login_session(&state, &secrets, &session()).unwrap();
    let before = load_session_snapshot(&state, &secrets).unwrap().unwrap();
    let fingerprint = arena_account_snapshot(&state, &secrets)
        .unwrap()
        .fingerprint;
    let lease = room_account_lease(&state, &secrets, 42).unwrap();
    assert_eq!(
        room_auth_key(&state, &secrets, &lease).await.unwrap(),
        "SYNTHETIC-AUTH-KEY"
    );
    let head = server.await.unwrap().to_ascii_lowercase();
    assert!(head.starts_with("post /api/auth/verify "));
    assert!(head.contains("cookie: better-auth.session_token=synthetic-cookie\r\n"));
    assert!(!head.contains("authorization:"));
    assert!(lease.is_current(&state, &secrets).unwrap());
    assert!(before.is_current(&state, &secrets).unwrap());
    assert_eq!(
        arena_account_snapshot(&state, &secrets)
            .unwrap()
            .fingerprint,
        fingerprint
    );
    let saved = load_session_for(&state, &secrets).unwrap().unwrap();
    assert_eq!(saved.auth_key.as_deref(), Some("SYNTHETIC-AUTH-KEY"));
    assert!(saved.activity_token.is_some());
    // server 已退出；复用缓存不得发生第二次网络请求。
    assert_eq!(
        room_auth_key(&state, &secrets, &lease).await.unwrap(),
        "SYNTHETIC-AUTH-KEY"
    );
}

#[tokio::test]
async fn room_new_session_uses_stored_bearer_without_verify() {
    let state = CloudState::with_origin("http://127.0.0.1:1");
    let secrets = Secrets::default();
    let mut fresh = session();
    fresh.activity_token = Some(token("9999-01-01T00:00:00Z"));
    fresh.auth_key = Some("SYNTHETIC-NEW-SESSION-KEY".into());
    store_login_session(&state, &secrets, &fresh).unwrap();
    let lease = room_account_lease(&state, &secrets, 42).unwrap();
    assert_eq!(
        room_auth_key(&state, &secrets, &lease).await.unwrap(),
        "SYNTHETIC-NEW-SESSION-KEY"
    );
    assert!(lease.is_current(&state, &secrets).unwrap());
}

#[test]
fn credential_merge_preserves_other_fields_but_rejects_new_login() {
    let state = CloudState::with_origin("http://127.0.0.1:1");
    let secrets = Secrets::default();
    store_login_session(&state, &secrets, &session()).unwrap();
    let snapshot = load_session_snapshot(&state, &secrets).unwrap().unwrap();
    persist_session_credentials(
        &state,
        &secrets,
        &snapshot,
        &SessionCredentials {
            activity_token: Some(token("9999-01-01T00:00:00Z")),
            auth_key: None,
        },
    )
    .unwrap();
    persist_session_credentials(
        &state,
        &secrets,
        &snapshot,
        &SessionCredentials {
            activity_token: None,
            auth_key: Some("SYNTHETIC-AUTH-KEY".into()),
        },
    )
    .unwrap();
    let saved = load_session_for(&state, &secrets).unwrap().unwrap();
    assert!(saved.activity_token.is_some());
    assert!(saved.auth_key.is_some());
    assert!(snapshot.is_current(&state, &secrets).unwrap());
    store_login_session(&state, &secrets, &session()).unwrap();
    assert!(!snapshot.is_current(&state, &secrets).unwrap());
    assert_eq!(
        persist_session_credentials(
            &state,
            &secrets,
            &snapshot,
            &SessionCredentials {
                activity_token: None,
                auth_key: Some("OLD-KEY".into())
            }
        )
        .unwrap_err()
        .code,
        CloudErrorCode::StateMismatch
    );
    assert!(load_session_for(&state, &secrets)
        .unwrap()
        .unwrap()
        .auth_key
        .is_none());
}

#[tokio::test]
async fn room_verify_failures_never_install_credentials() {
    for (status, body, expected) in [
        (
            200,
            serde_json::json!({"user":{"id":99},"authKey":"WRONG-OWNER"}),
            CloudErrorCode::StateMismatch,
        ),
        (
            200,
            serde_json::json!({"user":{"id":42},"authKey":null}),
            CloudErrorCode::InvalidResponse,
        ),
        (401, serde_json::json!({}), CloudErrorCode::NotAuthenticated),
        (
            500,
            serde_json::json!({}),
            CloudErrorCode::ServerUnavailable,
        ),
    ] {
        let (origin, _, server) = verify_server(status, body, None).await;
        let state = CloudState::with_origin(&origin);
        let secrets = Secrets::default();
        store_login_session(&state, &secrets, &session()).unwrap();
        let lease = room_account_lease(&state, &secrets, 42).unwrap();
        assert_eq!(
            room_auth_key(&state, &secrets, &lease)
                .await
                .unwrap_err()
                .code,
            expected
        );
        server.await.unwrap();
        assert!(load_session_for(&state, &secrets)
            .unwrap()
            .unwrap()
            .auth_key
            .is_none());
    }
}

#[tokio::test]
async fn room_verify_network_failure_keeps_session_and_has_no_business_dispatch() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let state = CloudState::with_origin(&origin);
    let secrets = Secrets::default();
    store_login_session(&state, &secrets, &session()).unwrap();
    let before = secrets.resolve(ACCOUNT_SESSION_REF).unwrap();
    let lease = room_account_lease(&state, &secrets, 42).unwrap();
    assert_eq!(
        room_auth_key(&state, &secrets, &lease)
            .await
            .unwrap_err()
            .code,
        CloudErrorCode::NetworkError
    );
    assert_eq!(secrets.resolve(ACCOUNT_SESSION_REF).unwrap(), before);
    assert!(lease.is_current(&state, &secrets).unwrap());
}

#[tokio::test]
async fn room_late_verify_cannot_revive_logout_or_same_account_relogin() {
    for logout in [true, false] {
        let (release, gate) = oneshot::channel();
        let (origin, seen, server) = verify_server(200, credentials(), Some(gate)).await;
        let state = CloudState::with_origin(&origin);
        let secrets = Secrets::default();
        store_login_session(&state, &secrets, &session()).unwrap();
        let lease = room_account_lease(&state, &secrets, 42).unwrap();
        let request = room_auth_key(&state, &secrets, &lease);
        tokio::pin!(request);
        tokio::select! { result = &mut request => panic!("unexpected completion: {}", result.is_ok()), _ = seen => {} }
        if logout {
            clear_session_if_current(&secrets, &lease.raw, Some((&state, lease.epoch))).unwrap();
        } else {
            store_login_session(&state, &secrets, &session()).unwrap();
        }
        release.send(()).unwrap();
        assert_eq!(
            request.await.unwrap_err().code,
            CloudErrorCode::StateMismatch
        );
        server.await.unwrap();
        assert!(load_session_for(&state, &secrets)
            .unwrap()
            .is_none_or(|saved| saved.auth_key.is_none()));
    }
}

#[tokio::test]
async fn expired_activity_refreshes_and_preserves_room_key() {
    let (origin, _, server) = verify_server(200, credentials(), None).await;
    let state = CloudState::with_origin(&origin);
    let secrets = Secrets::default();
    let mut old = session();
    old.activity_token = Some(token("2000-01-01T00:00:00Z"));
    old.auth_key = Some("SYNTHETIC-AUTH-KEY".into());
    store_login_session(&state, &secrets, &old).unwrap();
    let result = arena_activity_token(&state, &secrets, 42).await.unwrap();
    assert!(!activity_token_needs_refresh(Some(&result)));
    server.await.unwrap();
    assert_eq!(
        load_session_for(&state, &secrets)
            .unwrap()
            .unwrap()
            .auth_key,
        old.auth_key
    );
}
