// 在 cloud::tests 内包含，复用实际 loopback server 与 MemorySecrets。
fn avatar_fixture() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/desktop-profile-avatar.json"
    ))
    .unwrap()
}
fn avatar_request(value: &str) -> CloudSaveAvatarRequest {
    CloudSaveAvatarRequest {
        expected_user_id: 7,
        avatar_webp_base64: value.to_string(),
    }
}
#[test]
fn profile_avatar_request_and_confirmation_match_shared_fixture() {
    let fixture = avatar_fixture();
    assert_eq!(
        fixture["maxBase64Length"].as_u64(),
        Some(PROFILE_AVATAR_MAX_BASE64_LENGTH as u64)
    );
    for value in fixture["validPayloads"].as_array().unwrap() {
        assert!(valid_avatar_base64(value.as_str().unwrap()));
    }
    for value in fixture["invalidPayloads"].as_array().unwrap() {
        assert!(!valid_avatar_base64(value.as_str().unwrap()), "{value}");
    }
    assert!(valid_avatar_base64(
        &"A".repeat(PROFILE_AVATAR_MAX_BASE64_LENGTH)
    ));
    assert!(!valid_avatar_base64(
        &"A".repeat(PROFILE_AVATAR_MAX_BASE64_LENGTH + 4)
    ));
    for value in fixture["validSaveRequests"].as_array().unwrap() {
        let request: CloudSaveAvatarRequest = serde_json::from_value(value.clone()).unwrap();
        validate_profile_owner(request.expected_user_id).unwrap();
        assert!(valid_avatar_base64(&request.avatar_webp_base64));
    }
    for value in fixture["validClearRequests"].as_array().unwrap() {
        let request: CloudClearAvatarRequest = serde_json::from_value(value.clone()).unwrap();
        validate_profile_owner(request.expected_user_id).unwrap();
    }
    for owner in fixture["invalidOwners"].as_array().unwrap() {
        let request = serde_json::from_value::<CloudClearAvatarRequest>(
            serde_json::json!({"expectedUserId":owner}),
        );
        assert!(
            request.is_err() || validate_profile_owner(request.unwrap().expected_user_id).is_err()
        );
    }
    for (key, value) in fixture["forbiddenFields"].as_object().unwrap() {
        let mut save = serde_json::json!({"expectedUserId":7,"avatarWebpBase64":"QUJD"});
        save[key] = value.clone();
        assert!(
            serde_json::from_value::<CloudSaveAvatarRequest>(save).is_err(),
            "{key}"
        );
        let mut clear = serde_json::json!({"expectedUserId":7});
        clear[key] = value.clone();
        assert!(
            serde_json::from_value::<CloudClearAvatarRequest>(clear).is_err(),
            "{key}"
        );
    }
    assert!(serde_json::from_value::<CloudClearAvatarRequest>(
        serde_json::json!({"expectedUserId":7,"avatarWebpBase64":"QUJD"})
    )
    .is_err());
    for body in fixture["invalidSaveResponses"].as_array().unwrap() {
        assert!(confirmed_avatar(body, false).is_err());
    }
    for body in fixture["invalidClearResponses"].as_array().unwrap() {
        assert!(confirmed_avatar(body, true).is_err());
    }
    assert_eq!(serde_json::to_value(CloudAvatarResult {user_id:7, avatar_data_url:confirmed_avatar(&serde_json::json!({"success":true,"avatarDataUrl":"data:image/webp;base64,QUJD","cookie":"not projected"}),false).unwrap()}).unwrap(),fixture["validSaveResult"]);
    assert_eq!(
        serde_json::to_value(CloudAvatarResult {
            user_id: 7,
            avatar_data_url: confirmed_avatar(&serde_json::json!({"success":true}), true).unwrap()
        })
        .unwrap(),
        fixture["validClearResult"]
    );
}

#[test]
fn profile_avatar_fixed_put_delete_cookie_and_server_confirmation() {
    rt().block_on(async {
        let server = spawn_mock_server(); let state = CloudState::with_origin(&server.origin); let secrets = MemorySecrets::new();
        store_session(&secrets, &stored_test_session()).unwrap();
        for payload in ["QUJD".to_string(), "A".repeat(PROFILE_AVATAR_MAX_BASE64_LENGTH)] {
            *server.me_profile_override.lock().unwrap() = Some((200, r#"{"success":true,"avatarDataUrl":"data:image/webp;base64,bmV3","cookie":"do not leak"}"#.to_string()));
            let result = cloud_save_me_profile_avatar(&state, &secrets, avatar_request(&payload)).await.unwrap();
            assert_eq!(result.user_id,7); assert_eq!(result.avatar_data_url.as_deref(),Some("data:image/webp;base64,bmV3"));
            let head = server.last_me_profile_head.lock().unwrap().clone().unwrap();
            assert!(head.starts_with("PUT /api/me/profile/avatar HTTP/1.1"));
            assert!(head.to_ascii_lowercase().contains("cookie: better-auth.session_token=native.tok"));
            assert!(head.to_ascii_lowercase().contains("content-type: application/json"));
            assert!(head.contains(&format!("origin: {}", server.origin)));
            assert_eq!(*server.last_me_profile_body.lock().unwrap(),Some(serde_json::json!({"avatarWebpBase64":payload})));
        }
        *server.me_profile_override.lock().unwrap() = Some((200,r#"{"success":true}"#.to_string()));
        let result=cloud_clear_me_profile_avatar(&state,&secrets,CloudClearAvatarRequest{expected_user_id:7}).await.unwrap();
        assert_eq!(serde_json::to_value(result).unwrap(),serde_json::json!({"userId":7,"avatarDataUrl":null}));
        let head=server.last_me_profile_head.lock().unwrap().clone().unwrap();
        assert!(head.starts_with("DELETE /api/me/profile/avatar HTTP/1.1"));
        assert!(head.contains("better-auth.session_token=native.tok"));
        assert!(server.last_me_profile_body.lock().unwrap().is_none());
        assert_eq!(server.me_profile_count.load(Ordering::SeqCst),3);
    });
}

#[test]
fn profile_avatar_invalid_input_wrong_owner_and_missing_session_send_nothing() {
    rt().block_on(async {
        let server = spawn_mock_server();
        let state = CloudState::with_origin(&server.origin);
        let secrets = MemorySecrets::new();
        assert_eq!(
            cloud_save_me_profile_avatar(&state, &secrets, avatar_request("QUJD"))
                .await
                .unwrap_err()
                .code,
            CloudErrorCode::NotAuthenticated
        );
        assert_eq!(
            cloud_clear_me_profile_avatar(
                &state,
                &secrets,
                CloudClearAvatarRequest {
                    expected_user_id: 7
                }
            )
            .await
            .unwrap_err()
            .code,
            CloudErrorCode::NotAuthenticated
        );
        store_session(&secrets, &stored_test_session()).unwrap();
        for owner in [0, 8, MAX_SAFE_USER_ID + 1] {
            let expected = if owner == 8 {
                CloudErrorCode::NotAuthenticated
            } else {
                CloudErrorCode::InvalidRequest
            };
            assert_eq!(
                cloud_save_me_profile_avatar(
                    &state,
                    &secrets,
                    CloudSaveAvatarRequest {
                        expected_user_id: owner,
                        avatar_webp_base64: "QUJD".into()
                    }
                )
                .await
                .unwrap_err()
                .code,
                expected
            );
            assert_eq!(
                cloud_clear_me_profile_avatar(
                    &state,
                    &secrets,
                    CloudClearAvatarRequest {
                        expected_user_id: owner
                    }
                )
                .await
                .unwrap_err()
                .code,
                expected
            );
        }
        for payload in [
            String::new(),
            "AB==".into(),
            "A".repeat(PROFILE_AVATAR_MAX_BASE64_LENGTH + 4),
        ] {
            assert_eq!(
                cloud_save_me_profile_avatar(&state, &secrets, avatar_request(&payload))
                    .await
                    .unwrap_err()
                    .code,
                CloudErrorCode::InvalidRequest
            );
        }
        assert_eq!(server.me_profile_count.load(Ordering::SeqCst), 0);
    });
}

#[test]
fn profile_avatar_errors_never_fake_success_retry_redirect_or_delete_credentials() {
    rt().block_on(async {
        let server=spawn_mock_server(); let state=CloudState::with_origin(&server.origin); let secrets=MemorySecrets::new();
        store_session(&secrets,&stored_test_session()).unwrap(); let mut count=0;
        for clear in [false,true] {
            let mut cases=vec![(401,"{}".into(),CloudErrorCode::NotAuthenticated),(429,"{}".into(),CloudErrorCode::ServerUnavailable),(503,"{}".into(),CloudErrorCode::ServerUnavailable),(302,"{}".into(),CloudErrorCode::ServerUnavailable),(200,"<html>bad</html>".into(),CloudErrorCode::InvalidResponse),(200,"x".repeat(ME_PROFILE_RESPONSE_MAX_BYTES+1),CloudErrorCode::InvalidResponse)];
            for body in avatar_fixture()[if clear {"invalidClearResponses"} else {"invalidSaveResponses"}].as_array().unwrap() { cases.push((200,body.to_string(),CloudErrorCode::InvalidResponse)); }
            if !clear { cases.push((200,serde_json::json!({"success":true,"avatarDataUrl":format!("data:image/webp;base64,{}","A".repeat(PROFILE_AVATAR_MAX_BASE64_LENGTH+4))}).to_string(),CloudErrorCode::InvalidResponse)); }
            for (status,body,code) in cases {
                *server.me_profile_override.lock().unwrap()=Some((status,body));
                let result=if clear { cloud_clear_me_profile_avatar(&state,&secrets,CloudClearAvatarRequest{expected_user_id:7}).await } else { cloud_save_me_profile_avatar(&state,&secrets,avatar_request("QUJD")).await };
                assert_eq!(result.unwrap_err().code,code); count+=1;
                assert_eq!(server.me_profile_count.load(Ordering::SeqCst),count,"no retry/redirect");
                assert_eq!(load_session(&secrets).unwrap().unwrap().cookie,stored_test_session().cookie);
                assert_eq!(secrets.deletions.load(Ordering::SeqCst),0);
            }
        }
    });
}

#[test]
fn profile_avatar_late_writes_and_profile_get_keep_new_credentials() {
    rt().block_on(async {
        for operation in ["upload","clear","get"] {
            for status in [200,401] {
                let server=spawn_mock_server(); let state=CloudState::with_origin(&server.origin); let secrets=MemorySecrets::new();
                store_session(&secrets,&stored_test_session()).unwrap();
                *server.me_profile_override.lock().unwrap()=Some((status,r#"{"success":true,"avatarDataUrl":"data:image/webp;base64,bmV3","profile":{"signature":"old","avatarDataUrl":"data:image/webp;base64,QUJD"}}"#.into()));
                let (release,wait)=std::sync::mpsc::channel(); *server.me_profile_reply_gate.lock().unwrap()=Some(wait);
                let change=async {
                    tokio::time::timeout(Duration::from_secs(3),async { while server.last_me_profile_head.lock().unwrap().is_none() {tokio::time::sleep(Duration::from_millis(5)).await;} }).await.unwrap();
                    let mut next=stored_test_session(); next.account.user_id=8; next.cookie="better-auth.session_token=new-session".into(); store_session(&secrets,&next).unwrap(); release.send(()).unwrap();
                };
                let request=async {
                    match operation {
                        "get"=>cloud_me_profile(&state,&secrets).await.map(|v|v.user_id),
                        "clear"=>cloud_clear_me_profile_avatar(&state,&secrets,CloudClearAvatarRequest{expected_user_id:7}).await.map(|v|v.user_id),
                        _=>cloud_save_me_profile_avatar(&state,&secrets,avatar_request("QUJD")).await.map(|v|v.user_id),
                    }
                };
                let (result,())=tokio::join!(request,change);
                if status==200 {assert_eq!(result.unwrap(),7);} else {assert_eq!(result.unwrap_err().code,CloudErrorCode::NotAuthenticated);}
                assert_eq!(load_session(&secrets).unwrap().unwrap().cookie,"better-auth.session_token=new-session");
                assert_eq!(secrets.deletions.load(Ordering::SeqCst),0);
                assert!(server.last_me_profile_head.lock().unwrap().as_ref().unwrap().contains("native.tok"));
                assert_eq!(server.me_profile_count.load(Ordering::SeqCst),1);
            }
        }
    });
}

#[test]
fn profile_avatar_network_failure_preserves_session_without_replay() {
    rt().block_on(async {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let state = CloudState::with_origin(&format!("http://{address}"));
        let secrets = MemorySecrets::new();
        store_session(&secrets, &stored_test_session()).unwrap();
        assert_eq!(
            cloud_save_me_profile_avatar(&state, &secrets, avatar_request("QUJD"))
                .await
                .unwrap_err()
                .code,
            CloudErrorCode::NetworkError
        );
        assert_eq!(
            cloud_clear_me_profile_avatar(
                &state,
                &secrets,
                CloudClearAvatarRequest {
                    expected_user_id: 7
                }
            )
            .await
            .unwrap_err()
            .code,
            CloudErrorCode::NetworkError
        );
        assert_eq!(secrets.deletions.load(Ordering::SeqCst), 0);
    });
}

#[test]
fn profile_avatar_timeout_is_unknown_and_not_retried() {
    rt().block_on(async {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (release, wait) = std::sync::mpsc::channel();
        let accepts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = accepts.clone();
        let server = std::thread::spawn(move || {
            let (_socket, _) = listener.accept().unwrap();
            counter.fetch_add(1, Ordering::SeqCst);
            let _ = wait.recv_timeout(Duration::from_secs(20));
        });
        let state = CloudState::with_origin(&origin);
        let secrets = MemorySecrets::new();
        store_session(&secrets, &stored_test_session()).unwrap();
        let error = cloud_save_me_profile_avatar(&state, &secrets, avatar_request("QUJD"))
            .await
            .unwrap_err();
        assert_eq!(error.code, CloudErrorCode::NetworkError);
        assert_eq!(accepts.load(Ordering::SeqCst), 1);
        assert_eq!(secrets.deletions.load(Ordering::SeqCst), 0);
        release.send(()).unwrap();
        server.join().unwrap();
    });
}

#[test]
fn profile_snapshot_corrupt_read_never_deletes_a_concurrently_replaced_session() {
    struct ReplacedDuringResolve {
        inner: MemorySecrets,
        swapped: std::sync::atomic::AtomicBool,
    }
    impl SecretStore for ReplacedDuringResolve {
        fn set(&self, key: &str, value: &str) -> Result<(), SecretStoreError> {
            self.inner.set(key, value)
        }
        fn exists(&self, key: &str) -> Result<bool, SecretStoreError> {
            self.inner.exists(key)
        }
        fn delete(&self, key: &str) -> Result<(), SecretStoreError> {
            self.inner.delete(key)
        }
        fn resolve(&self, key: &str) -> Result<Option<String>, SecretStoreError> {
            if !self.swapped.swap(true, Ordering::SeqCst) {
                let mut next = stored_test_session();
                next.account.user_id = 8;
                next.cookie = "better-auth.session_token=new-after-corrupt".into();
                store_session(&self.inner, &next).unwrap();
                return Ok(Some("{corrupt old record".into()));
            }
            self.inner.resolve(key)
        }
    }
    rt().block_on(async {
        let server = spawn_mock_server();
        let state = CloudState::with_origin(&server.origin);
        for operation in ["get", "upload", "clear"] {
            let secrets = ReplacedDuringResolve {
                inner: MemorySecrets::new(),
                swapped: std::sync::atomic::AtomicBool::new(false),
            };
            let result = match operation {
                "get" => cloud_me_profile(&state, &secrets).await.map(|v| v.user_id),
                "upload" => cloud_save_me_profile_avatar(&state, &secrets, avatar_request("QUJD"))
                    .await
                    .map(|v| v.user_id),
                _ => cloud_clear_me_profile_avatar(
                    &state,
                    &secrets,
                    CloudClearAvatarRequest {
                        expected_user_id: 7,
                    },
                )
                .await
                .map(|v| v.user_id),
            };
            assert_eq!(result.unwrap_err().code, CloudErrorCode::NotAuthenticated);
            assert_eq!(secrets.inner.deletions.load(Ordering::SeqCst), 0);
            assert_eq!(
                load_session(&secrets.inner).unwrap().unwrap().cookie,
                "better-auth.session_token=new-after-corrupt"
            );
        }
        assert_eq!(server.me_profile_count.load(Ordering::SeqCst), 0);
    });
}
