//! Advisory Strict read: fixed Next route, closed DTOs and account-generation fencing.
use super::*;
use futures_util::StreamExt;

const PATH: &str = "/api/arena/strict-preflight";
const VERSION: &str = "desktop-strict-preflight-v1";
const MAX_BYTES: usize = 64 * 1024;

// Derive(Deserialize) alone also accepts positional arrays. Every public and nested
// object passes through this map-only wrapper before its typed fields are decoded.
#[derive(Debug, Serialize)]
#[serde(transparent)]
pub struct Object<T>(T);
impl<'de, T: Deserialize<'de>> Deserialize<'de> for Object<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectVisitor<T>(std::marker::PhantomData<T>);
        impl<'de, T: Deserialize<'de>> serde::de::Visitor<'de> for ObjectVisitor<T> {
            type Value = Object<T>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a Strict preflight object")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                map: A,
            ) -> Result<Self::Value, A::Error> {
                T::deserialize(serde::de::value::MapAccessDeserializer::new(map)).map(Object)
            }
        }
        deserializer.deserialize_map(ObjectVisitor(std::marker::PhantomData))
    }
}
// deserialize_with makes an Option field required while still accepting explicit null.
fn required_nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::deserialize(deserializer)
}
fn present_optional<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}
#[derive(Debug, Serialize)]
#[serde(transparent)]
struct Natural(u64);
impl<'de> Deserialize<'de> for Natural {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let number = serde_json::Number::deserialize(deserializer)?;
        let value = number
            .as_f64()
            .ok_or_else(|| serde::de::Error::custom("invalid integer"))?;
        if value < 0.0 || value > MAX_SAFE_USER_ID as f64 || value.fract() != 0.0 {
            return Err(serde::de::Error::custom("invalid safe integer"));
        }
        Ok(Self(value as u64))
    }
}
fn user_id<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    deserialize_expected_user_id(deserializer)?
        .ok_or_else(|| serde::de::Error::custom("missing viewer"))
}
#[derive(Debug, Serialize)]
#[serde(transparent)]
struct Identifier(String);
impl<'de> Deserialize<'de> for Identifier {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        // ECMAScript trim(), including BOM but excluding Rust's additional U+0085.
        let value = value.trim_matches(|c| {
            matches!(c,
                '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
                '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
                '\u{205f}' | '\u{3000}' | '\u{feff}'
            )
        });
        if value.is_empty() || value.encode_utf16().count() > 256 {
            return Err(serde::de::Error::custom("invalid identifier"));
        }
        Ok(Self(value.to_string()))
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum BattleMode {
    Classic,
    Kizuna,
    Daily,
    Scenario,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum StoryLength {
    Default,
    Short,
    Standard,
    Detailed,
    Long,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestFields {
    #[serde(deserialize_with = "user_id")]
    expected_user_id: u64,
    body: Object<Input>,
}
pub type StrictPreflightRequest = Object<RequestFields>;
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    battle_mode: BattleMode,
    language: String,
    story_length: StoryLength,
    scenario_enabled: bool,
    #[serde(deserialize_with = "required_nullable")]
    scenario_file_name: Option<Identifier>,
    aux_scenario_count: Natural,
    material_count: Natural,
    questionnaire_lore_enabled: bool,
    questionnaire_lore_ids: Vec<Identifier>,
    settings: Object<Settings>,
    combatants: Vec<Object<Combatant>>,
    adjudication_event_count: Natural,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    custom_provider: Option<Object<Provider>>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    user_guidance: String,
    read_arena_history: bool,
    read_current_state: bool,
    read_narrative_history: bool,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Combatant {
    is_preset: bool,
    #[serde(deserialize_with = "required_nullable")]
    filename: Option<Identifier>,
    #[serde(deserialize_with = "required_nullable")]
    source_data_card_id: Option<Identifier>,
    #[serde(deserialize_with = "required_nullable")]
    character_guidance: Option<String>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Provider {
    provider_id: Identifier,
    model_id: Identifier,
}

fn bounded(value: &str, max: usize) -> bool {
    value.encode_utf16().count() <= max
}
impl StrictPreflightRequest {
    fn wire(&self) -> Result<Vec<u8>, CloudError> {
        let invalid = || {
            CloudError::new(
                CloudErrorCode::InvalidRequest,
                "严格排位预检输入超出允许范围",
            )
        };
        let body = &self.0.body.0;
        if body.language.is_empty()
            || !bounded(&body.language, 64)
            || body.aux_scenario_count.0 > 256
            || body.material_count.0 > 256
            || body.adjudication_event_count.0 > 256
            || body.questionnaire_lore_ids.len() > 20
            || body.combatants.len() > 32
            || !bounded(&body.settings.0.user_guidance, 200)
            || body.combatants.iter().any(|c| {
                c.0.character_guidance
                    .as_ref()
                    .is_some_and(|s| !bounded(s, 2000))
            })
        {
            return Err(invalid());
        }
        if serde_json::to_vec(self).map_err(|_| invalid())?.len() > MAX_BYTES {
            return Err(invalid());
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire<'a> {
            expected_user_id: u64,
            #[serde(flatten)]
            body: &'a Input,
        }
        let bytes = serde_json::to_vec(&Wire {
            expected_user_id: self.0.expected_user_id,
            body,
        })
        .map_err(|_| invalid())?;
        if bytes.len() > MAX_BYTES {
            return Err(invalid());
        }
        Ok(bytes)
    }
}

// Upstream additions are ignored, but only these typed fields can cross IPC.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseFields {
    success: bool,
    preflight_version: String,
    #[serde(deserialize_with = "user_id")]
    viewer_user_id: u64,
    will_count: bool,
    reasons: Vec<String>,
    #[serde(deserialize_with = "required_nullable")]
    range: Option<Object<Range>>,
    daily: Object<Daily>,
    pair: Object<Pair>,
}
pub type StrictPreflightResponse = Object<ResponseFields>;
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Range {
    abs_diff: f64,
    max_abs_diff: f64,
    exceeded_by: f64,
    a_rating: f64,
    b_rating: f64,
    a_games: Natural,
    b_games: Natural,
    low_games_tightened: bool,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Daily {
    #[serde(deserialize_with = "required_nullable")]
    used: Option<Natural>,
    limit: Natural,
    #[serde(deserialize_with = "required_nullable")]
    exceeded: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    since_iso: Option<String>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Pair {
    #[serde(deserialize_with = "required_nullable")]
    used: Option<Natural>,
    limit: Natural,
    #[serde(deserialize_with = "required_nullable")]
    exceeded: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    recent_deduped: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    recent_applied_at_iso: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    next_eligible_at_iso: Option<String>,
    window_minutes: Natural,
}
fn decode(bytes: &[u8], owner: u64) -> Result<StrictPreflightResponse, CloudError> {
    let incompatible = || {
        CloudError::new(
            CloudErrorCode::ProtocolMismatch,
            "服务器尚未提供此版本的账号绑定预检，请稍后重试",
        )
    };
    let response: StrictPreflightResponse =
        serde_json::from_slice(bytes).map_err(|_| incompatible())?;
    let body = &response.0;
    if !body.success
        || body.preflight_version != VERSION
        || body.viewer_user_id != owner
        || body.will_count != body.reasons.is_empty()
        || body.reasons.len() > 64
        || body
            .reasons
            .iter()
            .any(|reason| reason.is_empty() || !bounded(reason, 200))
        || [
            &body.daily.0.since_iso,
            &body.pair.0.recent_applied_at_iso,
            &body.pair.0.next_eligible_at_iso,
        ]
        .iter()
        .any(|date| date.as_ref().is_some_and(|s| !bounded(s, 128)))
        || body.range.as_ref().is_some_and(|range| {
            let r = &range.0;
            [r.abs_diff, r.max_abs_diff, r.exceeded_by]
                .iter()
                .any(|v| !v.is_finite() || *v < 0.0 || *v > MAX_SAFE_USER_ID as f64)
                || [r.a_rating, r.b_rating]
                    .iter()
                    .any(|v| !v.is_finite() || v.abs() > MAX_SAFE_USER_ID as f64)
        })
    {
        return Err(incompatible());
    }
    Ok(response)
}
fn read_snapshot(
    state: &CloudState,
    secrets: &dyn SecretStore,
) -> Result<SessionSnapshot, CloudError> {
    let _guard = account_session_gate()?;
    let raw = secrets
        .resolve(ACCOUNT_SESSION_REF)
        .map_err(|e| CloudError::from_secret_store(&e))?
        .ok_or_else(|| CloudError::new(CloudErrorCode::NotAuthenticated, "请先登录云端账号"))?;
    let session = serde_json::from_str::<StoredSession>(&raw).map_err(|_| {
        CloudError::new(CloudErrorCode::NotAuthenticated, "账号凭据无效，请重新登录")
    })?;
    Ok(SessionSnapshot {
        session,
        raw,
        epoch: state.account_epoch.load(Ordering::SeqCst),
    })
}
fn assert_current(
    state: &CloudState,
    secrets: &dyn SecretStore,
    snapshot: &SessionSnapshot,
) -> Result<(), CloudError> {
    let _guard = account_session_gate()?;
    let current = secrets
        .resolve(ACCOUNT_SESSION_REF)
        .map_err(|e| CloudError::from_secret_store(&e))?;
    if state.account_epoch.load(Ordering::SeqCst) != snapshot.epoch
        || current.as_deref() != Some(snapshot.raw.as_str())
    {
        return Err(CloudError::new(
            CloudErrorCode::StateMismatch,
            "账号已变化，旧预检结果已忽略",
        ));
    }
    Ok(())
}
pub async fn read_strict_preflight(
    state: &CloudState,
    secrets: &dyn SecretStore,
    request: StrictPreflightRequest,
) -> Result<StrictPreflightResponse, CloudError> {
    let bytes = request.wire()?;
    let owner = request.0.expected_user_id;
    let snapshot = read_snapshot(state, secrets)?;
    let result = async {
        if snapshot.session.account.user_id != owner {
            return Err(CloudError::new(
                CloudErrorCode::StateMismatch,
                "预检所属账号已变化",
            ));
        }
        let response = authed_request(
            &state.http,
            reqwest::Method::POST,
            &state.origin,
            PATH,
            &snapshot.session,
        )
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(bytes)
        .timeout(SHORT_REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| CloudError::new(CloudErrorCode::NetworkError, "预检网络请求失败，请重试"))?;
        let status = response.status();
        if !status.is_success() {
            let (code, message) = match status.as_u16() {
                400 => (CloudErrorCode::InvalidRequest, "预检参数无效"),
                401 => (
                    CloudErrorCode::NotAuthenticated,
                    "登录已失效，请重新登录后预检",
                ),
                403 => (CloudErrorCode::Forbidden, "当前账号无权进行预检"),
                404 => (CloudErrorCode::NotFound, "服务器尚未提供严格排位预检"),
                409 => (CloudErrorCode::StateMismatch, "服务器账号与当前账号不匹配"),
                _ => (
                    CloudErrorCode::ServerUnavailable,
                    "预检服务暂时不可用，请稍后重试",
                ),
            };
            return Err(CloudError::new(code, message));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| {
                CloudError::new(CloudErrorCode::NetworkError, "预检读取中断，请重试")
            })?;
            if chunk.len() > MAX_BYTES.saturating_sub(bytes.len()) {
                return Err(CloudError::new(
                    CloudErrorCode::ResponseTooLarge,
                    "预检响应过大，暂时无法加载",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        decode(&bytes, owner)
    }
    .await;
    // Fence every outcome, including late 401, decode failure and network errors.
    // Never delete credentials: an old request cannot clear a newer login.
    assert_current(state, secrets, &snapshot)?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::sync::atomic::AtomicUsize;

    #[derive(Default)]
    struct Secrets {
        raw: Mutex<Option<String>>,
        deletes: AtomicUsize,
    }
    impl SecretStore for Secrets {
        fn set(&self, reference: &str, value: &str) -> Result<(), SecretStoreError> {
            assert_eq!(reference, ACCOUNT_SESSION_REF);
            *self.raw.lock().unwrap() = Some(value.to_string());
            Ok(())
        }
        fn exists(&self, reference: &str) -> Result<bool, SecretStoreError> {
            assert_eq!(reference, ACCOUNT_SESSION_REF);
            Ok(self.raw.lock().unwrap().is_some())
        }
        fn delete(&self, reference: &str) -> Result<(), SecretStoreError> {
            assert_eq!(reference, ACCOUNT_SESSION_REF);
            self.deletes.fetch_add(1, Ordering::SeqCst);
            *self.raw.lock().unwrap() = None;
            Ok(())
        }
        fn resolve(&self, reference: &str) -> Result<Option<String>, SecretStoreError> {
            assert_eq!(reference, ACCOUNT_SESSION_REF);
            Ok(self.raw.lock().unwrap().clone())
        }
    }
    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../../packages/contracts/fixtures/arena-strict-preflight.json"
        ))
        .unwrap()
    }
    fn request() -> StrictPreflightRequest {
        serde_json::from_value(fixture()["request"].clone()).unwrap()
    }
    fn projected_golden() -> Value {
        // JSON's 25 and 25.0 are the same JS number; canonicalize through the
        // public typed projection before comparing serde_json::Number variants.
        serde_json::to_value(
            serde_json::from_value::<StrictPreflightResponse>(fixture()["response"].clone())
                .unwrap(),
        )
        .unwrap()
    }
    fn secrets() -> Arc<Secrets> {
        let secrets = Arc::new(Secrets::default());
        store_session(
            secrets.as_ref(),
            &StoredSession {
                cookie: "better-auth.session_token=synthetic-only".to_string(),
                activity_token: None,
                session_expires_at: None,
                account: CloudAccountRecord {
                    user_id: 42,
                    username: "synthetic".to_string(),
                    display_name: None,
                },
            },
        )
        .unwrap();
        secrets
    }
    async fn server(
        status: u16,
        body: Vec<u8>,
        extra: &str,
    ) -> (
        String,
        oneshot::Receiver<(String, Value)>,
        oneshot::Sender<()>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (seen_tx, seen_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let extra = extra.to_string();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut one = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut one).await.unwrap();
                head.push(one[0]);
                assert!(head.len() < 16 * 1024);
            }
            let head = String::from_utf8(head).unwrap();
            let length: usize = head
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap();
            assert!(length <= MAX_BYTES);
            let mut request = vec![0; length];
            socket.read_exact(&mut request).await.unwrap();
            let _ = seen_tx.send((head, serde_json::from_slice(&request).unwrap()));
            let _ = release_rx.await;
            if status == 0 {
                return;
            } // A network failure after an account transition.
            if socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n{extra}\r\n").as_bytes()).await.is_err() { return; }
            for chunk in body.chunks(16_387) {
                if socket
                    .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                    .await
                    .is_err()
                {
                    return;
                }
                if socket.write_all(chunk).await.is_err() {
                    return;
                }
                if socket.write_all(b"\r\n").await.is_err() {
                    return;
                }
            }
            let _ = socket.write_all(b"0\r\n\r\n").await;
        });
        (origin, seen_rx, release_tx, task)
    }
    async fn read(status: u16, body: Vec<u8>) -> Result<StrictPreflightResponse, CloudError> {
        let (origin, _, release, task) = server(status, body, "").await;
        let _ = release.send(());
        let result = read_strict_preflight(
            &CloudState::with_origin(&origin),
            secrets().as_ref(),
            request(),
        )
        .await;
        task.await.unwrap();
        result
    }
    fn accepts(value: Value) -> bool {
        serde_json::from_value::<StrictPreflightRequest>(value).is_ok_and(|r| r.wire().is_ok())
    }
    #[test]
    fn command_and_narrow_main_ui_permission_are_registered() {
        let command = include_str!("../lib.rs");
        assert!(command.contains("async fn cloud_arena_strict_preflight("));
        assert!(command.contains("            cloud_arena_strict_preflight,"));
        assert!(include_str!("../../build.rs").contains("\"cloud_arena_strict_preflight\""));
        let capabilities: Value =
            serde_json::from_str(include_str!("../../capabilities/main-ui.json")).unwrap();
        assert!(capabilities["permissions"]
            .as_array()
            .unwrap()
            .contains(&json!("allow-cloud-arena-strict-preflight")));
        assert_eq!(capabilities["webviews"], json!(["main-ui"]));
        assert!(capabilities.get("windows").is_none());
    }
    #[test]
    fn golden_and_closed_request_objects() {
        let f = fixture();
        assert_eq!(f["path"], PATH);
        assert_eq!(f["maxBytes"], MAX_BYTES);
        assert!(accepts(f["request"].clone()));
        assert_eq!(
            serde_json::to_value(decode(f["response"].to_string().as_bytes(), 42).unwrap())
                .unwrap(),
            projected_golden()
        );
        for field in [
            "url",
            "path",
            "method",
            "headers",
            "cookie",
            "credentials",
            "apiKey",
            "secretRef",
            "endpoint",
            "baseUrl",
            "authorization",
            "expectedUserId",
            "extra",
        ] {
            for pointer in ["", "/body", "/body/settings", "/body/combatants/0"] {
                let mut value = f["request"].clone();
                value.pointer_mut(pointer).unwrap()[field] = json!("escape");
                assert!(!accepts(value), "{pointer}/{field}");
            }
            let mut value = f["request"].clone();
            value["body"]["customProvider"] = json!({"providerId":"test","modelId":"test"});
            value["body"]["customProvider"][field] = json!("escape");
            assert!(!accepts(value), "customProvider/{field}");
        }
        for pointer in ["", "/body", "/body/settings", "/body/combatants/0"] {
            let mut value = f["request"].clone();
            let positional = value
                .pointer(pointer)
                .unwrap()
                .as_object()
                .unwrap()
                .values()
                .cloned()
                .collect::<Vec<_>>();
            *value.pointer_mut(pointer).unwrap() = json!(positional);
            assert!(!accepts(value), "{pointer}");
        }
        for provider in [json!(null), json!(["test", "test"])] {
            let mut value = f["request"].clone();
            value["body"]["customProvider"] = provider;
            assert!(!accepts(value));
        }
        for (pointer, field) in [
            ("/body", "scenarioFileName"),
            ("/body/combatants/0", "filename"),
            ("/body/combatants/0", "sourceDataCardId"),
            ("/body/combatants/0", "characterGuidance"),
        ] {
            let mut value = f["request"].clone();
            value
                .pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(!accepts(value), "{field}");
        }
    }
    #[test]
    fn request_numbers_utf16_and_trim_match_javascript() {
        let f = fixture();
        for pointer in [
            "/expectedUserId",
            "/body/auxScenarioCount",
            "/body/materialCount",
            "/body/adjudicationEventCount",
        ] {
            for invalid in [
                json!(-1),
                json!(7.5),
                json!(9007199254740992_u64),
                json!("7"),
                json!(null),
                json!([7]),
            ] {
                let mut value = f["request"].clone();
                *value.pointer_mut(pointer).unwrap() = invalid;
                assert!(!accepts(value), "{pointer}");
            }
            let mut value = f["request"].clone();
            *value.pointer_mut(pointer).unwrap() = json!(7.0);
            assert!(accepts(value));
        }
        for (pointer, max) in [
            ("/body/language", 64),
            ("/body/settings/userGuidance", 200),
            ("/body/combatants/0/characterGuidance", 2000),
            ("/body/combatants/0/sourceDataCardId", 256),
        ] {
            let mut value = f["request"].clone();
            *value.pointer_mut(pointer).unwrap() = json!("😀".repeat(max / 2));
            assert!(accepts(value.clone()));
            *value.pointer_mut(pointer).unwrap() = json!(format!("{}x", "😀".repeat(max / 2)));
            assert!(!accepts(value));
        }
        let mut value = f["request"].clone();
        value["body"]["combatants"][0]["sourceDataCardId"] = json!("\u{feff}  card-a \u{feff}");
        let parsed: StrictPreflightRequest = serde_json::from_value(value).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&parsed.wire().unwrap()).unwrap()["combatants"][0]
                ["sourceDataCardId"],
            "card-a"
        );
        let mut value = f["request"].clone();
        value["body"]["combatants"][0]["sourceDataCardId"] = json!("\u{feff} \t");
        assert!(!accepts(value));
    }
    #[test]
    fn serialized_request_budget_accepts_exact_limit_and_rejects_one_byte_more() {
        let mut value = fixture()["request"].clone();
        let mut combatant = value["body"]["combatants"][0].clone();
        combatant["characterGuidance"] = json!("x".repeat(2000));
        value["body"]["combatants"] = json!(vec![combatant; 32]);
        value["body"]["combatants"][0]["characterGuidance"] = json!("");
        let short: StrictPreflightRequest = serde_json::from_value(value.clone()).unwrap();
        let padding = MAX_BYTES - serde_json::to_vec(&short).unwrap().len();
        assert!(padding < 2000);
        value["body"]["combatants"][0]["characterGuidance"] = json!("x".repeat(padding));
        let exact: StrictPreflightRequest = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_vec(&exact).unwrap().len(), MAX_BYTES);
        assert!(exact.wire().is_ok());
        value["body"]["combatants"][0]["characterGuidance"] = json!("x".repeat(padding + 1));
        assert!(!accepts(value));
    }
    #[test]
    fn response_metadata_nested_shapes_nullable_and_number_bounds_fail_closed() {
        let f = fixture()["response"].clone();
        for field in [
            "success",
            "preflightVersion",
            "viewerUserId",
            "range",
            "daily",
            "pair",
            "reasons",
        ] {
            let mut body = f.clone();
            body.as_object_mut().unwrap().remove(field);
            assert!(
                decode(body.to_string().as_bytes(), 42).is_err(),
                "missing {field}"
            );
        }
        for (pointer, replacement) in [
            ("/preflightVersion", json!("old")),
            ("/viewerUserId", json!(43)),
            ("/success", json!(false)),
            ("/willCount", json!(false)),
            ("/reasons", json!(["blocked"])),
            ("/reasons", json!([""])),
            ("/daily/limit", json!(1.5)),
            ("/daily/used", json!(9007199254740992_u64)),
            ("/pair/windowMinutes", json!(-1)),
            ("/range/aGames", json!(7.5)),
            ("/range/absDiff", json!(-1)),
            ("/range/bRating", json!(-9007199254740992_i64)),
            ("/range/aRating", json!(9007199254740992_u64)),
            ("/daily/sinceIso", json!("😀".repeat(65))),
        ] {
            let mut body = f.clone();
            *body.pointer_mut(pointer).unwrap() = replacement;
            assert!(
                decode(body.to_string().as_bytes(), 42).is_err(),
                "{pointer}"
            );
        }
        for (pointer, fields) in [
            ("/daily", vec!["used", "exceeded", "sinceIso"]),
            (
                "/pair",
                vec![
                    "used",
                    "exceeded",
                    "recentDeduped",
                    "recentAppliedAtIso",
                    "nextEligibleAtIso",
                ],
            ),
        ] {
            for field in fields {
                let mut body = f.clone();
                body.pointer_mut(pointer)
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .remove(field);
                assert!(
                    decode(body.to_string().as_bytes(), 42).is_err(),
                    "{pointer}/{field}"
                );
            }
        }
        for pointer in ["", "/range", "/daily", "/pair"] {
            let mut body = f.clone();
            let positional = body
                .pointer(pointer)
                .unwrap()
                .as_object()
                .unwrap()
                .values()
                .cloned()
                .collect::<Vec<_>>();
            *body.pointer_mut(pointer).unwrap() = json!(positional);
            assert!(
                decode(body.to_string().as_bytes(), 42).is_err(),
                "{pointer}"
            );
        }
        let mut body = f.clone();
        body["willCount"] = json!(false);
        body["reasons"] = json!(["额度未知"]);
        body["range"] = Value::Null;
        body["daily"]["used"] = Value::Null;
        body["daily"]["exceeded"] = Value::Null;
        body["daily"]["sinceIso"] = Value::Null;
        body["pair"]["used"] = Value::Null;
        body["pair"]["exceeded"] = Value::Null;
        body["pair"]["recentDeduped"] = Value::Null;
        assert!(decode(body.to_string().as_bytes(), 42).is_ok());
        for pointer in [
            "/viewerUserId",
            "/range/aGames",
            "/range/bGames",
            "/daily/used",
            "/daily/limit",
            "/pair/used",
            "/pair/limit",
            "/pair/windowMinutes",
        ] {
            let mut body = f.clone();
            *body.pointer_mut(pointer).unwrap() = json!(7.0);
            assert!(decode(
                body.to_string().as_bytes(),
                if pointer == "/viewerUserId" { 7 } else { 42 }
            )
            .is_ok());
        }
    }
    #[tokio::test]
    async fn fixed_post_cookie_viewer_injection_and_closed_projection() {
        let f = fixture();
        let mut body = f["response"].clone();
        for pointer in ["", "/range", "/daily", "/pair"] {
            body.pointer_mut(pointer).unwrap()["privateMetadata"] = json!("must-not-leak");
        }
        let (origin, seen, release, task) = server(200, body.to_string().into_bytes(), "").await;
        let _ = release.send(());
        let result = read_strict_preflight(
            &CloudState::with_origin(&origin),
            secrets().as_ref(),
            request(),
        )
        .await
        .unwrap();
        let (head, input) = seen.await.unwrap();
        assert!(head.starts_with("POST /api/arena/strict-preflight HTTP/1.1\r\n"));
        assert!(head
            .to_lowercase()
            .contains("cookie: better-auth.session_token=synthetic-only"));
        assert!(head
            .to_lowercase()
            .contains("content-type: application/json"));
        let mut expected = f["request"]["body"].clone();
        expected["expectedUserId"] = json!(42);
        assert_eq!(input, expected);
        let output = serde_json::to_value(result).unwrap();
        assert_eq!(output, projected_golden());
        assert!(!output.to_string().contains("must-not-leak"));
        if let Some(directory) = std::env::var_os("STRICT_PREFLIGHT_NATIVE_WIRE_OUTPUT") {
            std::fs::write(
                std::path::PathBuf::from(directory).join("strict-preflight.json"),
                serde_json::to_vec(&output).unwrap(),
            )
            .unwrap();
        }
        task.await.unwrap();
    }
    #[tokio::test]
    async fn no_session_wrong_owner_and_invalid_request_do_not_connect_or_mutate_credentials() {
        let state = CloudState::with_origin("http://127.0.0.1:1");
        let empty = Secrets::default();
        assert_eq!(
            read_strict_preflight(&state, &empty, request())
                .await
                .unwrap_err()
                .code,
            CloudErrorCode::NotAuthenticated
        );
        empty.set(ACCOUNT_SESSION_REF, "not-json").unwrap();
        assert_eq!(
            read_strict_preflight(&state, &empty, request())
                .await
                .unwrap_err()
                .code,
            CloudErrorCode::NotAuthenticated
        );
        assert_eq!(
            empty.resolve(ACCOUNT_SESSION_REF).unwrap().as_deref(),
            Some("not-json")
        );
        assert_eq!(empty.deletes.load(Ordering::SeqCst), 0);
        let store = secrets();
        let mut wrong = request();
        wrong.0.expected_user_id = 43;
        assert_eq!(
            read_strict_preflight(&state, store.as_ref(), wrong)
                .await
                .unwrap_err()
                .code,
            CloudErrorCode::StateMismatch
        );
        let mut invalid = request();
        invalid.0.body.0.material_count = Natural(257);
        assert_eq!(
            read_strict_preflight(&state, store.as_ref(), invalid)
                .await
                .unwrap_err()
                .code,
            CloudErrorCode::InvalidRequest
        );
        assert_eq!(
            read_strict_preflight(&state, store.as_ref(), request())
                .await
                .unwrap_err()
                .code,
            CloudErrorCode::NetworkError
        );
    }
    #[tokio::test]
    async fn status_errors_never_echo_upstream_secrets_or_clear_sessions() {
        for (status, expected) in [
            (400, CloudErrorCode::InvalidRequest),
            (401, CloudErrorCode::NotAuthenticated),
            (403, CloudErrorCode::Forbidden),
            (404, CloudErrorCode::NotFound),
            (409, CloudErrorCode::StateMismatch),
            (500, CloudErrorCode::ServerUnavailable),
        ] {
            let (origin, _, release, task) =
                server(status, b"token=must-not-leak".to_vec(), "").await;
            let _ = release.send(());
            let store = secrets();
            let before = store.resolve(ACCOUNT_SESSION_REF).unwrap();
            let error =
                read_strict_preflight(&CloudState::with_origin(&origin), store.as_ref(), request())
                    .await
                    .unwrap_err();
            assert_eq!(error.code, expected);
            assert!(!error.message.contains("must-not-leak"));
            assert_eq!(store.resolve(ACCOUNT_SESSION_REF).unwrap(), before);
            assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
            task.await.unwrap();
        }
    }
    #[tokio::test]
    async fn every_late_outcome_is_fenced_on_raw_change_and_same_bytes_relogin() {
        for (status, body) in [
            (200, fixture()["response"].to_string().into_bytes()),
            (200, b"not-json".to_vec()),
            (401, Vec::new()),
            (500, Vec::new()),
            (0, Vec::new()),
            (200, vec![b' '; MAX_BYTES + 1]),
        ] {
            for transition in [
                "same-bytes-relogin",
                "new-owner",
                "raw-only-change",
                "logout",
            ] {
                let (origin, seen, release, server_task) = server(status, body.clone(), "").await;
                let state = Arc::new(CloudState::with_origin(&origin));
                let store = secrets();
                let request_state = state.clone();
                let request_store = store.clone();
                let task = tokio::spawn(async move {
                    read_strict_preflight(&request_state, request_store.as_ref(), request()).await
                });
                seen.await.unwrap();
                let before = store.resolve(ACCOUNT_SESSION_REF).unwrap().unwrap();
                let mut session: StoredSession = serde_json::from_str(&before).unwrap();
                match transition {
                    "same-bytes-relogin" => {
                        store_login_session(&state, store.as_ref(), &session).unwrap()
                    }
                    "new-owner" => {
                        session.account.user_id = 43;
                        session.cookie = "synthetic-new".to_string();
                        store_login_session(&state, store.as_ref(), &session).unwrap();
                    }
                    "raw-only-change" => {
                        session.cookie = "synthetic-rotated".to_string();
                        store_session(store.as_ref(), &session).unwrap();
                    }
                    "logout" => {
                        let _guard = account_session_gate().unwrap();
                        *store.raw.lock().unwrap() = None;
                        state.account_epoch.fetch_add(1, Ordering::SeqCst);
                    }
                    _ => unreachable!(),
                }
                let expected = store.resolve(ACCOUNT_SESSION_REF).unwrap();
                let _ = release.send(());
                assert_eq!(
                    task.await.unwrap().unwrap_err().code,
                    CloudErrorCode::StateMismatch,
                    "{status}/{transition}"
                );
                assert_eq!(store.resolve(ACCOUNT_SESSION_REF).unwrap(), expected);
                assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
                server_task.await.unwrap();
            }
        }
    }
    #[tokio::test]
    async fn chunked_response_budget_is_exact_and_never_truncates() {
        let mut body = fixture()["response"].clone();
        body["ignored"] = json!("中😀末尾");
        let padding = MAX_BYTES - body.to_string().len();
        body["ignored"] = json!(format!("中😀末尾{}", "x".repeat(padding)));
        let exact = body.to_string().into_bytes();
        assert_eq!(exact.len(), MAX_BYTES);
        assert!(read(200, exact.clone()).await.is_ok());
        let mut over = exact;
        over.push(b' ');
        assert_eq!(
            read(200, over).await.unwrap_err().code,
            CloudErrorCode::ResponseTooLarge
        );
    }
    #[tokio::test]
    async fn redirects_do_not_forward_cookie_or_expose_target() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (origin, _, release, task) = server(
            302,
            Vec::new(),
            &format!(
                "Location: http://{}/steal\r\n",
                listener.local_addr().unwrap()
            ),
        )
        .await;
        let _ = release.send(());
        let error = read_strict_preflight(
            &CloudState::with_origin(&origin),
            secrets().as_ref(),
            request(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, CloudErrorCode::ServerUnavailable);
        assert!(!error.message.contains("steal"));
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
        task.await.unwrap();
    }
}
