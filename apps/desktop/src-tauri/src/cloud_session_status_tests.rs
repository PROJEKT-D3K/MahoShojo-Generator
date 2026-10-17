// Included in cloud::tests; exercise the real Native command with synthetic loopback responses.

#[test]
fn auth_status_missing_session_allows_login_without_manual_signout() {
    rt().block_on(async {
        // Better Auth 1.6 returns HTTP 200 null for expired, revoked and invalid cookies.
        // Keep the older explicit empty envelope compatible, without accepting missing fields.
        for (status, body) in [
            (200, "null"),
            (200, r#"{"session":null,"user":null}"#),
            (401, r#"{"error":"unauthorized"}"#),
        ] {
            let server = spawn_mock_server();
            let state = CloudState::with_origin(&server.origin);
            let secrets = MemorySecrets::new();
            store_session(&secrets, &stored_test_session()).unwrap();
            secrets
                .set("provider-key:test", "synthetic-provider-key")
                .unwrap();
            *server.get_session_override.lock().unwrap() = Some((status, body.into()));

            assert!(cloud_cached_account(&state, &secrets).unwrap().is_some());
            assert!(matches!(
                cloud_auth_status(&state, &secrets).await.unwrap(),
                CloudSessionStatus::Expired
            ));
            assert!(cloud_cached_account(&state, &secrets).unwrap().is_none());
            assert!(matches!(
                cloud_auth_status(&state, &secrets).await.unwrap(),
                CloudSessionStatus::SignedOut
            ));
            assert_eq!(secrets.deletions.load(Ordering::SeqCst), 1);
            assert!(secrets.exists("provider-key:test").unwrap());

            // Recovery uses the normal PKCE/callback/exchange flow, without a sign-out command.
            *server.get_session_override.lock().unwrap() = None;
            complete_session_cleanup_login(&state, &secrets).await;
            assert!(matches!(
                cloud_auth_status(&state, &secrets).await.unwrap(),
                CloudSessionStatus::Active { .. }
            ));
            assert_eq!(cloud_me_profile(&state, &secrets).await.unwrap().user_id, 7);
            assert!(server.sign_out_requests.lock().unwrap().is_empty());
        }
    });
}

#[test]
fn auth_status_invalid_response_keeps_credentials_and_never_verifies_account() {
    rt().block_on(async {
        for body in [
            "",
            " ",
            "<html>upstream error</html>",
            "{",
            "{}",
            r#"{"error":"backend failure"}"#,
            r#"{"session":null}"#,
            r#"{"user":null}"#,
            r#"{"session":null,"user":{"id":"au_1"}}"#,
            r#"{"session":{"id":"s1","userId":"au_1"},"user":null}"#,
            r#"{"session":true,"user":{"id":"au_1"}}"#,
            r#"{"session":[],"user":{"id":"au_1"}}"#,
            r#"{"session":{},"user":{}}"#,
            r#"{"session":{"id":1,"userId":"au_1","expiresAt":"2099-01-01T00:00:00Z"},"user":{"id":"au_1"}}"#,
            r#"{"session":{"id":"","userId":"au_1","expiresAt":"2099-01-01T00:00:00Z"},"user":{"id":"au_1"}}"#,
            r#"{"session":{"id":"s1","userId":"au_1","expiresAt":"2099-01-01T00:00:00Z"},"user":{"id":"other"}}"#,
            r#"{"session":{"id":"s1","userId":"","expiresAt":"2099-01-01T00:00:00Z"},"user":{"id":""}}"#,
            r#"{"session":{"id":"s1","userId":"au_1"},"user":{"id":"au_1"}}"#,
            r#"{"session":{"id":"s1","userId":"au_1","expiresAt":"not-a-date"},"user":{"id":"au_1"}}"#,
            r#"{"session":{"id":"s1","userId":"au_1","expiresAt":0},"user":{"id":"au_1"}}"#,
            "false",
            "[]",
        ] {
            let server = spawn_mock_server();
            let state = CloudState::with_origin(&server.origin);
            let secrets = MemorySecrets::new();
            store_session(&secrets, &stored_test_session()).unwrap();
            let original = secrets.resolve(ACCOUNT_SESSION_REF).unwrap();
            *server.get_session_override.lock().unwrap() = Some((200, body.into()));

            let error = cloud_auth_status(&state, &secrets).await.unwrap_err();
            assert_eq!(error.code, CloudErrorCode::InvalidResponse, "{body}");
            assert_eq!(error.message, "会话状态查询 返回了无法识别的响应");
            assert_eq!(secrets.resolve(ACCOUNT_SESSION_REF).unwrap(), original, "{body}");
            assert_eq!(secrets.deletions.load(Ordering::SeqCst), 0);
        }
    });
}

#[test]
fn auth_status_server_failure_keeps_credentials() {
    rt().block_on(async {
        for status in [403, 429, 500, 502, 503] {
            let server = spawn_mock_server();
            let state = CloudState::with_origin(&server.origin);
            let secrets = MemorySecrets::new();
            store_session(&secrets, &stored_test_session()).unwrap();
            let original = secrets.resolve(ACCOUNT_SESSION_REF).unwrap();
            *server.get_session_override.lock().unwrap() = Some((status, "null".into()));

            assert!(matches!(
                cloud_auth_status(&state, &secrets).await.unwrap(),
                CloudSessionStatus::Unreachable
            ));
            assert_eq!(secrets.resolve(ACCOUNT_SESSION_REF).unwrap(), original);
            assert_eq!(secrets.deletions.load(Ordering::SeqCst), 0);
        }
    });
}

#[test]
fn auth_status_profile_rejection_converges_on_expired() {
    rt().block_on(async {
        let server = spawn_mock_server();
        let state = CloudState::with_origin(&server.origin);
        let secrets = MemorySecrets::new();
        store_session(&secrets, &stored_test_session()).unwrap();
        let original = secrets.resolve(ACCOUNT_SESSION_REF).unwrap();
        *server.me_profile_override.lock().unwrap() =
            Some((401, r#"{"error":"unauthorized"}"#.into()));
        *server.get_session_override.lock().unwrap() = Some((200, "null".into()));

        assert_eq!(
            cloud_me_profile(&state, &secrets).await.unwrap_err().code,
            CloudErrorCode::NotAuthenticated
        );
        // Profile reads report rejection; the session authority performs the guarded cleanup.
        assert_eq!(secrets.resolve(ACCOUNT_SESSION_REF).unwrap(), original);
        assert!(matches!(
            cloud_auth_status(&state, &secrets).await.unwrap(),
            CloudSessionStatus::Expired
        ));
        assert!(!secrets.exists(ACCOUNT_SESSION_REF).unwrap());
    });
}

#[test]
fn auth_status_active_session_does_not_trust_old_cached_expiry() {
    rt().block_on(async {
        for expires_at in [
            "2099-01-01T00:00:00Z",
            "2099-01-01T00:00:00.123Z",
            "2099-01-01T08:00:00+08:00",
            "2098-12-31T18:30:00-05:30",
        ] {
            let server = spawn_mock_server();
            let state = CloudState::with_origin(&server.origin);
            let secrets = MemorySecrets::new();
            let mut session = stored_test_session();
            session.session_expires_at = Some("2000-01-01T00:00:00Z".into());
            store_session(&secrets, &session).unwrap();
            // Better Auth can extend expiry while retaining the same session cookie.
            *server.get_session_override.lock().unwrap() = Some((
                200,
                serde_json::json!({
                    "session": {"id":"s1", "userId":"au_1", "expiresAt":expires_at, "futureField":true},
                    "user": {"id":"au_1", "futureField":true},
                    "needsRefresh": true
                }).to_string(),
            ));
            assert!(matches!(
                cloud_auth_status(&state, &secrets).await.unwrap(),
                CloudSessionStatus::Active { .. }
            ));
            assert!(secrets.exists(ACCOUNT_SESSION_REF).unwrap());
            assert_eq!(secrets.deletions.load(Ordering::SeqCst), 0);
        }
    });
}
