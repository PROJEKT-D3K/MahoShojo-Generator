//! Account-owned, in-memory report history reader. No generic HTTP or credential mutation.
use super::*;
use futures_util::StreamExt;

const LIST_PATH: &str = "/api/me/battle-reports";
const LIST_MAX_BYTES: usize = 1024 * 1024;
const DETAIL_MAX_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportFilters {
    #[serde(deserialize_with = "read_page_integer")]
    page: u32,
    #[serde(deserialize_with = "read_page_integer")]
    page_size: u32,
    status: String,
    mode: String,
    generation_mode: String,
    pvp_only: bool,
    sort: String,
    q: String,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum ReportOperation {
    List {
        #[serde(rename = "expectedUserId", deserialize_with = "read_user_id")]
        expected_user_id: u64,
        #[serde(deserialize_with = "read_filters")]
        filters: ReportFilters,
    },
    Detail {
        #[serde(rename = "expectedUserId", deserialize_with = "read_user_id")]
        expected_user_id: u64,
        #[serde(rename = "generationId")]
        generation_id: String,
    },
}
// Both the tagged envelope and nested filters are JSON objects, never positional arrays.
#[derive(Debug)]
pub struct BattleReportRequest(ReportOperation);
impl<'de> Deserialize<'de> for BattleReportRequest {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectOnly;
        impl<'de> serde::de::Visitor<'de> for ObjectOnly {
            type Value = BattleReportRequest;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a battle report request object")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                map: A,
            ) -> Result<Self::Value, A::Error> {
                ReportOperation::deserialize(serde::de::value::MapAccessDeserializer::new(map))
                    .map(BattleReportRequest)
            }
        }
        deserializer.deserialize_map(ObjectOnly)
    }
}
fn read_filters<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<ReportFilters, D::Error> {
    struct ObjectOnly;
    impl<'de> serde::de::Visitor<'de> for ObjectOnly {
        type Value = ReportFilters;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("a battle report filter object")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
            ReportFilters::deserialize(serde::de::value::MapAccessDeserializer::new(map))
        }
    }
    deserializer.deserialize_map(ObjectOnly)
}
fn read_page_integer<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    u32::try_from(read_user_id(deserializer)?)
        .map_err(|_| serde::de::Error::custom("invalid report page integer"))
}
fn read_user_id<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    deserialize_expected_user_id(deserializer)?
        .ok_or_else(|| serde::de::Error::custom("missing viewer"))
}
type ReportRoute = (u64, String, Vec<(&'static str, String)>, usize);
impl BattleReportRequest {
    fn route(&self) -> Result<ReportRoute, CloudError> {
        let invalid = || CloudError::new(CloudErrorCode::InvalidRequest, "战报读取参数无效");
        let (owner, path, mut query, budget) = match &self.0 {
            ReportOperation::List {
                expected_user_id,
                filters: f,
            } => {
                if !(1..=10_000).contains(&f.page)
                    || !(1..=30).contains(&f.page_size)
                    || !["", "completed", "aborted", "failed"].contains(&f.status.as_str())
                    || !["", "classic", "kizuna", "daily", "scenario"].contains(&f.mode.as_str())
                    || !["", "stream", "non-stream"].contains(&f.generation_mode.as_str())
                    || !["started_at_desc", "started_at_asc"].contains(&f.sort.as_str())
                    || f.q.encode_utf16().count() > 120
                {
                    return Err(invalid());
                }
                let mut query = vec![
                    ("page", f.page.to_string()),
                    ("pageSize", f.page_size.to_string()),
                    ("sort", f.sort.clone()),
                ];
                for (name, value) in [
                    ("status", &f.status),
                    ("mode", &f.mode),
                    ("generationMode", &f.generation_mode),
                    ("q", &f.q),
                ] {
                    if !value.is_empty() {
                        query.push((name, value.clone()));
                    }
                }
                if f.pvp_only {
                    query.push(("pvpOnly", "1".to_string()));
                }
                (
                    *expected_user_id,
                    LIST_PATH.to_string(),
                    query,
                    LIST_MAX_BYTES,
                )
            }
            ReportOperation::Detail {
                expected_user_id,
                generation_id,
            } => {
                // Existing UUID and request-id producers use path-safe ASCII. Historical list IDs remain unconstrained.
                if generation_id.is_empty()
                    || generation_id.len() > 200
                    || !generation_id.as_bytes()[0].is_ascii_alphanumeric()
                        && !b"_-".contains(&generation_id.as_bytes()[0])
                    || !generation_id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_-.:".contains(&c))
                {
                    return Err(invalid());
                }
                (
                    *expected_user_id,
                    format!("{LIST_PATH}/{generation_id}"),
                    Vec::new(),
                    DETAIL_MAX_BYTES,
                )
            }
        };
        if owner == 0 || owner > MAX_SAFE_USER_ID {
            return Err(invalid());
        }
        query.push(("expectedUserId", owner.to_string()));
        Ok((owner, path, query, budget))
    }
}

// Explicit public projection. Serde ignores unknown upstream keys and never serializes them to IPC.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSummary {
    id: String,
    started_at: String,
    status: String,
    endpoint: String,
    generation_mode: String,
    mode: String,
    headline: Option<String>,
    display_title: Option<String>,
    winner: Option<String>,
    has_preview: bool,
    can_regenerate: bool,
    content_blocked: bool,
    error_message: Option<String>,
    output_has_shield_words: bool,
    pvp_room_id: Option<String>,
    pvp_match_id: Option<String>,
    pvp_round_id: Option<String>,
    source_kind: SourceKind,
    arena_participant_role: Option<ParticipantRole>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum SourceKind {
    Solo,
    ArenaMultiplayer,
    Pvp,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ParticipantRole {
    Host,
    Member,
}
#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum AccessScope {
    Owner,
    ArenaParticipant,
    PvpParticipant,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum OutputSource {
    D1,
    R2,
    None,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportDetail {
    #[serde(flatten)]
    summary: ReportSummary,
    ended_at: String,
    duration_ms: f64,
    scenario_title: Option<String>,
    language: Option<String>,
    story_length: Option<String>,
    output_preview: Option<String>,
    output_source: OutputSource,
    output_read_error: Option<String>,
    content_expired: bool,
    access_scope: AccessScope,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportCombatant {
    sort_index: f64,
    name: String,
    r#type: Option<String>,
    team_id: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    template_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_native: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_preset: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    character_guidance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data_card_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data_card_updated_at: Option<String>,
}
impl ReportCombatant {
    fn remove_private_fields(&mut self) {
        self.template_id = None;
        self.is_native = None;
        self.is_preset = None;
        self.character_guidance = None;
        self.data_card_id = None;
        self.data_card_updated_at = None;
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportListBody {
    success: bool,
    viewer_user_id: u64,
    page: u32,
    page_size: u32,
    total: u64,
    records: Vec<ReportSummary>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportDetailBody {
    success: bool,
    viewer_user_id: u64,
    record: ReportDetail,
    combatants: Vec<ReportCombatant>,
}
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum ReportBody {
    List(ReportListBody),
    Detail(Box<ReportDetailBody>),
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BattleReportResponse {
    user_id: u64,
    data: ReportBody,
}

fn read_snapshot(
    state: &CloudState,
    secrets: &dyn SecretStore,
) -> Result<SessionSnapshot, CloudError> {
    let _guard = account_session_gate()?;
    let raw = secrets
        .resolve(ACCOUNT_SESSION_REF)
        .map_err(|error| CloudError::from_secret_store(&error))?
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
        .map_err(|error| CloudError::from_secret_store(&error))?;
    if state.account_epoch.load(Ordering::SeqCst) != snapshot.epoch
        || current.as_deref() != Some(snapshot.raw.as_str())
    {
        return Err(CloudError::new(
            CloudErrorCode::StateMismatch,
            "账号已变化，旧战报读取已忽略",
        ));
    }
    Ok(())
}

pub async fn read_battle_reports(
    state: &CloudState,
    secrets: &dyn SecretStore,
    request: BattleReportRequest,
) -> Result<BattleReportResponse, CloudError> {
    let (owner, path, query, max_bytes) = request.route()?;
    let snapshot = read_snapshot(state, secrets)?;
    if snapshot.session.account.user_id != owner {
        return Err(CloudError::new(
            CloudErrorCode::StateMismatch,
            "战报所属账号已变化",
        ));
    }
    let encoded_query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(query.iter().map(|(name, value)| (*name, value.as_str())))
        .finish();
    let path = format!("{path}?{encoded_query}");
    let result = async {
        let response = authed_request(
            &state.http,
            reqwest::Method::GET,
            &state.origin,
            &path,
            &snapshot.session,
        )
        .timeout(SHORT_REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| CloudError::new(CloudErrorCode::NetworkError, "战报网络请求失败，请重试"))?;
        let status = response.status();
        if !status.is_success() {
            let (code, message) = match status.as_u16() {
                401 => (
                    CloudErrorCode::NotAuthenticated,
                    "登录已失效，请重新登录后载入战报",
                ),
                403 => (CloudErrorCode::Forbidden, "当前账号无权查看该战报"),
                404 => (CloudErrorCode::NotFound, "战报记录不存在或已清理"),
                409 => (CloudErrorCode::StateMismatch, "服务器账号与当前账号不匹配"),
                _ => (
                    CloudErrorCode::ServerUnavailable,
                    "战报服务暂时不可用，请稍后重试",
                ),
            };
            return Err(CloudError::new(code, message));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| {
                CloudError::new(CloudErrorCode::NetworkError, "战报读取中断，请重试")
            })?;
            if chunk.len() > max_bytes.saturating_sub(bytes.len()) {
                return Err(CloudError::new(
                    CloudErrorCode::ResponseTooLarge,
                    "战报内容过大，暂时无法加载",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let incompatible = || {
            CloudError::new(
                CloudErrorCode::ProtocolMismatch,
                "服务器战报读取协议不兼容，请更新服务后重试",
            )
        };
        let data = match &request.0 {
            ReportOperation::List { filters, .. } => {
                let body: ReportListBody =
                    serde_json::from_slice(&bytes).map_err(|_| incompatible())?;
                if !body.success
                    || body.viewer_user_id != owner
                    || body.page != filters.page
                    || body.page_size != filters.page_size
                    || body.records.len() > filters.page_size as usize
                {
                    return Err(incompatible());
                }
                ReportBody::List(body)
            }
            ReportOperation::Detail { generation_id, .. } => {
                let mut body: ReportDetailBody =
                    serde_json::from_slice(&bytes).map_err(|_| incompatible())?;
                if !body.success
                    || body.viewer_user_id != owner
                    || body.record.summary.id != *generation_id
                {
                    return Err(incompatible());
                }
                if body.record.access_scope == AccessScope::ArenaParticipant {
                    for combatant in &mut body.combatants {
                        combatant.remove_private_fields();
                    }
                }
                if body.record.summary.content_blocked {
                    body.record.output_preview = None;
                }
                ReportBody::Detail(Box::new(body))
            }
        };
        Ok(BattleReportResponse {
            user_id: snapshot.session.account.user_id,
            data,
        })
    }
    .await;
    // All results, including late 401/network failures, are fenced before the renderer sees them.
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
        fn set(&self, _: &str, value: &str) -> Result<(), SecretStoreError> {
            *self.raw.lock().unwrap() = Some(value.to_string());
            Ok(())
        }
        fn exists(&self, _: &str) -> Result<bool, SecretStoreError> {
            Ok(self.raw.lock().unwrap().is_some())
        }
        fn delete(&self, _: &str) -> Result<(), SecretStoreError> {
            self.deletes.fetch_add(1, Ordering::SeqCst);
            *self.raw.lock().unwrap() = None;
            Ok(())
        }
        fn resolve(&self, _: &str) -> Result<Option<String>, SecretStoreError> {
            Ok(self.raw.lock().unwrap().clone())
        }
    }
    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../../packages/contracts/fixtures/battle-report-history.json"
        ))
        .unwrap()
    }
    fn request(kind: &str) -> BattleReportRequest {
        serde_json::from_value(fixture()[format!("{kind}Request")].clone()).unwrap()
    }
    fn secrets() -> Arc<Secrets> {
        let result = Arc::new(Secrets::default());
        let session = StoredSession {
            cookie: "better-auth.session_token=synthetic-only".to_string(),
            session_expires_at: None,
            account: CloudAccountRecord {
                user_id: 42,
                username: "synthetic".to_string(),
                display_name: None,
            },
        };
        store_session(result.as_ref(), &session).unwrap();
        result
    }
    // Real loopback HTTP, chunk boundaries deliberately need not align to UTF-8 characters.
    async fn server(
        status: u16,
        body: Vec<u8>,
        extra: &str,
    ) -> (
        String,
        oneshot::Receiver<String>,
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
            let _ = seen_tx.send(String::from_utf8(head).unwrap());
            let _ = release_rx.await;
            if socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n{extra}\r\n").as_bytes()).await.is_err() { return; }
            for chunk in body.chunks(32_771) {
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
    async fn read(
        status: u16,
        body: Value,
        kind: &str,
    ) -> Result<BattleReportResponse, CloudError> {
        let (origin, _, release, task) = server(status, body.to_string().into_bytes(), "").await;
        let _ = release.send(());
        let result = read_battle_reports(
            &CloudState::with_origin(&origin),
            secrets().as_ref(),
            request(kind),
        )
        .await;
        task.await.unwrap();
        result
    }
    fn write_wire_probe(name: &str, value: &Value) {
        if let Some(directory) = std::env::var_os("BATTLE_REPORT_NATIVE_WIRE_OUTPUT") {
            std::fs::write(
                std::path::PathBuf::from(directory).join(format!("{name}.json")),
                serde_json::to_vec(value).unwrap(),
            )
            .unwrap();
        }
    }
    #[test]
    fn goldens_and_strict_request_boundaries() {
        let f = fixture();
        assert_eq!(f["paths"]["list"], LIST_PATH);
        assert_eq!(f["budgets"]["list"], LIST_MAX_BYTES);
        assert_eq!(f["budgets"]["detail"], DETAIL_MAX_BYTES);
        for kind in ["list", "detail"] {
            request(kind).route().unwrap();
        }
        for field in [
            "kind", "url", "method", "headers", "cookie", "body", "path", "query",
        ] {
            let mut value = f["detailRequest"].clone();
            value[field] = json!("escape");
            assert!(
                serde_json::from_value::<BattleReportRequest>(value).is_err(),
                "{field}"
            );
        }
        for id in [
            "../x",
            "a/b",
            "a\\b",
            "a?b",
            "a#b",
            "%2f",
            "generation-1\n",
            "generation-1\r\n",
            "",
        ] {
            let mut value = f["detailRequest"].clone();
            value["generationId"] = json!(id);
            assert!(serde_json::from_value::<BattleReportRequest>(value)
                .unwrap()
                .route()
                .is_err());
        }
        for (key, value) in [
            ("pageSize", json!(31)),
            ("page", json!(10_001)),
            ("q", json!("😀".repeat(61))),
            ("mode", json!("strict")),
        ] {
            let mut data = f["listRequest"].clone();
            data["filters"][key] = value;
            assert!(serde_json::from_value::<BattleReportRequest>(data)
                .unwrap()
                .route()
                .is_err());
        }
        for value in [
            json!(0),
            json!(-1),
            json!(42.5),
            json!(null),
            json!("42"),
            json!([42]),
            json!(9007199254740992_u64),
        ] {
            let mut data = f["detailRequest"].clone();
            data["expectedUserId"] = value;
            assert!(serde_json::from_value::<BattleReportRequest>(data).is_err());
        }
        for value in [
            json!(["detail", 42, "generation-1"]),
            json!(["list", 42, f["listRequest"]["filters"]]),
            json!({"kind":"list", "expectedUserId":42, "filters":[1,10,"","","",false,"started_at_desc",""]}),
        ] {
            assert!(serde_json::from_value::<BattleReportRequest>(value).is_err());
        }
        let mut extra = f["listRequest"].clone();
        extra["filters"]["cookie"] = json!("escape");
        assert!(serde_json::from_value::<BattleReportRequest>(extra).is_err());
        for field in ["page", "pageSize"] {
            for invalid in [
                json!(0),
                json!(-1),
                json!(1.5),
                json!(null),
                json!("1"),
                json!([1]),
                json!(4294967296_u64),
            ] {
                let mut data = f["listRequest"].clone();
                data["filters"][field] = invalid;
                assert!(serde_json::from_value::<BattleReportRequest>(data).is_err());
            }
        }
        let mut floating = f["listRequest"].clone();
        floating["filters"]["page"] = json!(1.0);
        floating["filters"]["pageSize"] = json!(10.0);
        serde_json::from_value::<BattleReportRequest>(floating)
            .unwrap()
            .route()
            .unwrap();
        let mut data = f["detailRequest"].clone();
        data["expectedUserId"] = json!(42.0);
        assert!(serde_json::from_value::<BattleReportRequest>(data).is_ok());
    }
    #[tokio::test]
    async fn fixed_get_paths_cookie_query_and_typed_projection() {
        for kind in ["list", "detail"] {
            let mut body = fixture()[kind].clone();
            body["cookie"] = json!("must-not-leak");
            if kind == "detail" {
                body["record"]["privateMetadata"] = json!("must-not-leak");
                body["combatants"][0]["apiKey"] = json!("must-not-leak");
            }
            let (origin, seen, release, task) =
                server(200, body.to_string().into_bytes(), "").await;
            let _ = release.send(());
            let mut input = request(kind);
            let title_query = "中文 😀 +%&?#=";
            if let ReportOperation::List { filters, .. } = &mut input.0 {
                filters.q = title_query.to_string();
            }
            let result =
                read_battle_reports(&CloudState::with_origin(&origin), secrets().as_ref(), input)
                    .await
                    .unwrap();
            let head = seen.await.unwrap();
            assert!(head.starts_with("GET /api/me/battle-reports"));
            let target = head
                .lines()
                .next()
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap();
            let parsed_url = url::Url::parse(&format!("http://localhost{target}")).unwrap();
            let query: Vec<_> = parsed_url.query_pairs().collect();
            assert_eq!(
                query
                    .iter()
                    .filter(|(key, _)| key == "expectedUserId")
                    .count(),
                1
            );
            assert_eq!(
                query
                    .iter()
                    .find(|(key, _)| key == "expectedUserId")
                    .unwrap()
                    .1,
                "42"
            );
            if kind == "list" {
                assert_eq!(
                    query.iter().find(|(key, _)| key == "q").unwrap().1,
                    title_query
                );
            } else {
                assert_eq!(query.len(), 1);
            }
            assert!(head.contains("expectedUserId=42"));
            assert!(head
                .to_lowercase()
                .contains("cookie: better-auth.session_token=synthetic-only"));
            assert!(!head.to_lowercase().contains("content-length:"));
            if kind == "detail" {
                assert!(head.starts_with("GET /api/me/battle-reports/generation-1?"));
            }
            let output = serde_json::to_value(result).unwrap();
            assert_eq!(output["userId"], 42);
            assert!(!output.to_string().contains("must-not-leak"));
            assert_eq!(output["data"]["viewerUserId"], 42);
            write_wire_probe(kind, &output);
            task.await.unwrap();
        }
    }
    #[tokio::test]
    async fn participant_and_blocked_projection_never_returns_private_fields_or_body() {
        for blocked in [false, true] {
            let mut body = fixture()["detail"].clone();
            body["record"]["accessScope"] = json!("arena-participant");
            body["record"]["sourceKind"] = json!("arena-multiplayer");
            body["record"]["arenaParticipantRole"] = json!("member");
            body["record"]["contentBlocked"] = json!(blocked);
            let result = serde_json::to_value(read(200, body, "detail").await.unwrap()).unwrap();
            assert_eq!(result["data"]["record"]["outputPreview"].is_null(), blocked);
            let combatant = &result["data"]["combatants"][0];
            for key in [
                "templateId",
                "isNative",
                "isPreset",
                "characterGuidance",
                "dataCardId",
                "dataCardUpdatedAt",
            ] {
                assert!(combatant.get(key).is_none());
            }
            write_wire_probe(if blocked { "blocked" } else { "member" }, &result);
        }
    }
    #[tokio::test]
    async fn server_protocol_viewer_target_and_status_fail_closed() {
        for kind in ["list", "detail"] {
            let mut body = fixture()[kind].clone();
            body.as_object_mut().unwrap().remove("viewerUserId");
            assert_eq!(
                read(200, body, kind).await.unwrap_err().code,
                CloudErrorCode::ProtocolMismatch
            );
            let mut body = fixture()[kind].clone();
            body["viewerUserId"] = json!(43);
            assert_eq!(
                read(200, body, kind).await.unwrap_err().code,
                CloudErrorCode::ProtocolMismatch
            );
        }
        let mut body = fixture()["detail"].clone();
        body["record"]["id"] = json!("wrong");
        assert_eq!(
            read(200, body, "detail").await.unwrap_err().code,
            CloudErrorCode::ProtocolMismatch
        );
        for (status, code) in [
            (401, CloudErrorCode::NotAuthenticated),
            (403, CloudErrorCode::Forbidden),
            (404, CloudErrorCode::NotFound),
            (409, CloudErrorCode::StateMismatch),
            (500, CloudErrorCode::ServerUnavailable),
        ] {
            let error = read(status, json!({"error":"token=must-not-leak"}), "detail")
                .await
                .unwrap_err();
            assert_eq!(error.code, code);
            assert!(!error.message.contains("must-not-leak"));
        }
    }
    #[tokio::test]
    async fn no_session_or_wrong_owner_never_connects_and_corrupt_credentials_are_untouched() {
        let state = CloudState::with_origin("http://127.0.0.1:1");
        let empty = Secrets::default();
        assert_eq!(
            read_battle_reports(&state, &empty, request("list"))
                .await
                .unwrap_err()
                .code,
            CloudErrorCode::NotAuthenticated
        );
        empty.set(ACCOUNT_SESSION_REF, "not-json").unwrap();
        assert_eq!(
            read_battle_reports(&state, &empty, request("list"))
                .await
                .unwrap_err()
                .code,
            CloudErrorCode::NotAuthenticated
        );
        assert_eq!(
            empty.resolve(ACCOUNT_SESSION_REF).unwrap().as_deref(),
            Some("not-json")
        );
        let store = secrets();
        let mut wrong = fixture()["listRequest"].clone();
        wrong["expectedUserId"] = json!(43);
        assert_eq!(
            read_battle_reports(
                &state,
                store.as_ref(),
                serde_json::from_value(wrong).unwrap()
            )
            .await
            .unwrap_err()
            .code,
            CloudErrorCode::StateMismatch
        );
        assert_eq!(empty.deletes.load(Ordering::SeqCst), 0);
        assert_eq!(
            read_battle_reports(&state, store.as_ref(), request("list"))
                .await
                .unwrap_err()
                .code,
            CloudErrorCode::NetworkError
        );
    }
    #[tokio::test]
    async fn late_success_and_401_are_rejected_after_new_owner_or_same_bytes_relogin() {
        for status in [200, 401] {
            for same_bytes in [true, false] {
                let (origin, seen, release, server_task) =
                    server(status, fixture()["list"].to_string().into_bytes(), "").await;
                let state = Arc::new(CloudState::with_origin(&origin));
                let store = secrets();
                let request_state = state.clone();
                let request_store = store.clone();
                let task = tokio::spawn(async move {
                    read_battle_reports(&request_state, request_store.as_ref(), request("list"))
                        .await
                });
                seen.await.unwrap();
                let before = store.resolve(ACCOUNT_SESSION_REF).unwrap().unwrap();
                let mut session: StoredSession = serde_json::from_str(&before).unwrap();
                if !same_bytes {
                    session.account.user_id = 43;
                    session.cookie = "better-auth.session_token=synthetic-new".to_string();
                }
                store_login_session(&state, store.as_ref(), &session).unwrap();
                if same_bytes {
                    assert_eq!(
                        store.resolve(ACCOUNT_SESSION_REF).unwrap().as_deref(),
                        Some(before.as_str())
                    );
                }
                let expected = store.resolve(ACCOUNT_SESSION_REF).unwrap();
                let _ = release.send(());
                assert_eq!(
                    task.await.unwrap().unwrap_err().code,
                    CloudErrorCode::StateMismatch
                );
                assert_eq!(store.resolve(ACCOUNT_SESSION_REF).unwrap(), expected);
                assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
                server_task.await.unwrap();
            }
        }
    }
    #[tokio::test]
    async fn redirects_are_not_followed_or_disclosed() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let location = format!(
            "Location: http://{}/steal\r\n",
            listener.local_addr().unwrap()
        );
        let (origin, _, release, task) = server(302, Vec::new(), &location).await;
        let _ = release.send(());
        assert_eq!(
            read_battle_reports(
                &CloudState::with_origin(&origin),
                secrets().as_ref(),
                request("detail")
            )
            .await
            .unwrap_err()
            .code,
            CloudErrorCode::ServerUnavailable
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
        task.await.unwrap();
    }
    #[tokio::test]
    async fn independent_wire_budgets_accept_exact_chunked_utf8_and_reject_overflow_without_truncation(
    ) {
        for (kind, budget) in [("list", LIST_MAX_BYTES), ("detail", DETAIL_MAX_BYTES)] {
            let mut body = fixture()[kind].clone();
            let field = if kind == "list" {
                &mut body["records"][0]["headline"]
            } else {
                &mut body["record"]["outputPreview"]
            };
            *field = json!("中😀末尾");
            let existing = body.to_string().len();
            let padding = "x".repeat(budget - existing);
            if kind == "list" {
                body["records"][0]["headline"] = json!(format!("中😀末尾{padding}"));
            } else {
                body["record"]["outputPreview"] = json!(format!("中😀末尾{padding}"));
            }
            let exact = body.to_string().into_bytes();
            assert_eq!(exact.len(), budget);
            let (origin, _, release, task) = server(200, exact.clone(), "").await;
            let _ = release.send(());
            assert!(read_battle_reports(
                &CloudState::with_origin(&origin),
                secrets().as_ref(),
                request(kind)
            )
            .await
            .is_ok());
            task.await.unwrap();
            let mut over = exact;
            over.push(b' ');
            let (origin, _, release, task) = server(200, over, "Content-Length: 1\r\n").await;
            let _ = release.send(());
            assert_eq!(
                read_battle_reports(
                    &CloudState::with_origin(&origin),
                    secrets().as_ref(),
                    request(kind)
                )
                .await
                .unwrap_err()
                .code,
                CloudErrorCode::ResponseTooLarge
            );
            task.await.unwrap();
        }
    }
}
