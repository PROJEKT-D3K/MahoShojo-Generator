//! Fixed Native Room HTTP transport. Credentials and raw transport failures stay native.
use std::time::Duration;

use futures_util::StreamExt;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use reqwest::{header, Client, Method};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::arena_room_generation::{
    validate_generation_response, GenerationReadTarget, GenerationViewMeta,
    MAX_GENERATION_RESPONSE_BYTES,
};
use crate::arena_room_protocol::{
    self as protocol, Operation, RoomError, EXPECTED_USER_ID_HEADER, MAX_REQUEST_BYTES,
    MAX_RESPONSE_BYTES, PROTOCOL_HEADER, PROTOCOL_VERSION,
};

const HTTP_DEADLINE: Duration = Duration::from_secs(15);
const MAX_RESPONSE_HEADERS: usize = 16 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
// Match encodeURIComponent, including punctuation that URL path-segment encoding leaves raw.
const CANONICAL_PATH_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

// These are build-time repository inputs, never renderer or environment overrides.
pub(crate) fn service_origin() -> Result<Url, RoomError> {
    let config: Value =
        serde_json::from_str(include_str!("../../../../config/hosted-routing.json"))
            .map_err(|_| RoomError::new("internal-error", "not-applicable"))?;
    fixed_https_origin(config.pointer("/origins/primary").and_then(Value::as_str))
}
pub(crate) fn caller_origin() -> Result<String, RoomError> {
    let config: Value =
        serde_json::from_str(include_str!("../../../../config/arena-room-origins.json"))
            .map_err(|_| RoomError::new("internal-error", "not-applicable"))?;
    let origin = fixed_https_origin(
        config
            .pointer("/targets/production/allowedWebOrigins/0")
            .and_then(Value::as_str),
    )?;
    Ok(origin.origin().ascii_serialization())
}
fn fixed_https_origin(raw: Option<&str>) -> Result<Url, RoomError> {
    let invalid = || RoomError::new("internal-error", "not-applicable");
    let url = Url::parse(raw.ok_or_else(invalid)?).map_err(|_| invalid())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return Err(invalid());
    }
    Ok(url)
}

/// Only the engine constructs these fixed operations, using already validated IPC input.
/// `request` is the original DTO; the transport supplies the account negotiation envelope.
pub(crate) struct HttpRequest {
    pub operation: Operation,
    pub room_id: Option<String>,
    pub proposal_id: Option<String>,
    pub request: Value,
    pub resume_only: bool,
}

#[derive(Debug)]
pub(crate) struct GenerationReadResponse {
    pub(crate) raw: String,
    pub(crate) meta: GenerationViewMeta,
    pub(crate) digest: String,
}

pub(crate) struct RoomHttp {
    client: Client,
    origin: Url,
    caller: String,
}

fn client_builder() -> reqwest::ClientBuilder {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(HTTP_DEADLINE)
        .timeout(HTTP_DEADLINE)
        .tls_sslkeylogfile(false)
        .tls_sni(true)
        .connection_verbose(false)
}

impl RoomHttp {
    pub(crate) fn new() -> Result<Self, RoomError> {
        Ok(Self {
            client: client_builder()
                .https_only(true)
                .build()
                .map_err(|_| RoomError::new("internal-error", "not-applicable"))?,
            origin: service_origin()?,
            caller: caller_origin()?,
        })
    }

    pub(crate) async fn execute(
        &self,
        input: &HttpRequest,
        expected_user_id: u64,
        cookie: &str,
        cancel: &CancellationToken,
    ) -> Result<Value, RoomError> {
        let operation = input.operation;
        let not_sent = if operation.is_post() {
            "not-applied"
        } else {
            "not-applicable"
        };
        // The complete report must never enter the generic Value response path.
        if matches!(
            operation,
            Operation::GenerationRead | Operation::GenerationStart
        ) {
            return Err(RoomError::new("invalid-request", not_sent));
        }
        if cancel.is_cancelled() {
            return Err(RoomError::new("scope-changed", not_sent));
        }
        let request = self.prepare(input, expected_user_id, cookie)?;
        // A polled send may have dispatched even when no response or headers arrive.
        let unknown = if operation.is_post() {
            "unknown"
        } else {
            "not-applicable"
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(RoomError::new("scope-changed", unknown)),
            result = tokio::time::timeout(HTTP_DEADLINE, self.receive(request, operation, expected_user_id)) => {
                result.unwrap_or_else(|_| Err(RoomError::new("network-error", unknown)))
            }
        };
        if cancel.is_cancelled() {
            return Err(RoomError::new("scope-changed", unknown));
        }
        result
    }

    /// The caller owns the shared physical HTTP permit and the immutable original wire.
    /// reqwest receives at most one send copy, bounded by that same permit until completion.
    pub(crate) async fn execute_generation_start(
        &self,
        room: &str,
        wire: &std::sync::Arc<Vec<u8>>,
        owner: u64,
        cookie: &str,
        cancel: &CancellationToken,
    ) -> Result<Value, RoomError> {
        let invalid = || RoomError::new("invalid-request", "not-applied");
        if !protocol::canonical_path_id(room)
            || owner == 0
            || owner > MAX_SAFE_INTEGER
            || cookie.is_empty()
            || cookie.len() > 16 * 1024
            || wire.len() > protocol::MAX_START_REQUEST_BYTES
        {
            return Err(invalid());
        }
        if cancel.is_cancelled() {
            return Err(RoomError::new("scope-changed", "not-applied"));
        }
        let room = utf8_percent_encode(room, CANONICAL_PATH_ENCODE_SET);
        let mut url = self.origin.clone();
        url.set_path(&format!("/api/arena/rooms/v1/{room}/generations"));
        let mut credential = header::HeaderValue::from_str(cookie).map_err(|_| invalid())?;
        credential.set_sensitive(true);
        let request = self
            .client
            .post(url)
            .header(header::ORIGIN, &self.caller)
            .header(header::COOKIE, credential)
            .header(header::ACCEPT, "application/json; arena-error-taxonomy=2")
            .header(header::ACCEPT_ENCODING, "identity")
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION)
            .header(EXPECTED_USER_ID_HEADER, format!("v1:{owner}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(wire.as_ref().clone())
            .build()
            .map_err(|_| invalid())?;
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(RoomError::new("scope-changed", "unknown")),
            result = tokio::time::timeout(HTTP_DEADLINE, self.receive(request, Operation::GenerationStart, owner)) => {
                result.unwrap_or_else(|_| Err(RoomError::new("network-error", "unknown")))
            }
        }
    }

    pub(crate) async fn execute_generation_read(
        &self,
        input: &HttpRequest,
        expected_user_id: u64,
        cookie: &str,
        cancel: &CancellationToken,
        target: &GenerationReadTarget,
    ) -> Result<GenerationReadResponse, RoomError> {
        let cancelled = || RoomError::new("scope-changed", "not-applicable");
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        if input.operation != Operation::GenerationRead
            || input.room_id.as_deref() != Some(target.room_id.as_str())
            || input.request.get("generationId").and_then(Value::as_str)
                != Some(target.generation_id.as_str())
        {
            return Err(RoomError::new("invalid-request", "not-applicable"));
        }
        let request = self.prepare(input, expected_user_id, cookie)?;
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(cancelled()),
            result = tokio::time::timeout(
                HTTP_DEADLINE,
                self.receive_generation_read(request, expected_user_id),
            ) => result.unwrap_or_else(|_| Err(RoomError::new("network-error", "not-applicable"))),
        };
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        let body = result?;
        // Conversion reuses the single bounded wire buffer. Neither validation nor
        // hashing owns detached work: the caller keeps its in-flight permit until
        // this future really finishes, even if cancellation arrives during parsing.
        let raw = String::from_utf8(body)
            .map_err(|_| RoomError::new("invalid-response", "not-applicable"))?;
        let result = validate_generation_response(&raw, expected_user_id, target);
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        let meta = result?;
        let mut hash = Sha256::new();
        for chunk in raw.as_bytes().chunks(64 * 1024) {
            tokio::task::yield_now().await;
            if cancel.is_cancelled() {
                return Err(cancelled());
            }
            hash.update(chunk);
        }
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        Ok(GenerationReadResponse {
            raw,
            meta,
            digest: format!("{:x}", hash.finalize()),
        })
    }

    fn prepare(
        &self,
        input: &HttpRequest,
        owner: u64,
        cookie: &str,
    ) -> Result<reqwest::Request, RoomError> {
        let operation = input.operation;
        let outcome = if operation.is_post() {
            "not-applied"
        } else {
            "not-applicable"
        };
        let invalid = || RoomError::new("invalid-request", outcome);
        if owner == 0
            || owner > MAX_SAFE_INTEGER
            || cookie.is_empty()
            || cookie.len() > 16 * 1024
            || (input.resume_only && operation != Operation::Create)
            || (input.proposal_id.is_some()
                != matches!(
                    operation,
                    Operation::ProposalWithdraw | Operation::ProposalResolve
                ))
        {
            return Err(invalid());
        }
        let mut url = self.origin.clone();
        {
            let mut path = url.path_segments_mut().map_err(|_| invalid())?;
            path.clear().extend(["api", "arena", "rooms", "v1"]);
            match operation {
                Operation::Discover | Operation::Create => {
                    if input.room_id.is_some() {
                        return Err(invalid());
                    }
                }
                _ => {
                    let room = input.room_id.as_deref().ok_or_else(invalid)?;
                    // URL segment encoding prevents route injection, including slash and query.
                    if room.is_empty()
                        || room.encode_utf16().count() > 256
                        || room == "."
                        || room == ".."
                    {
                        return Err(invalid());
                    }
                    path.push(room).push(operation.as_str());
                }
            }
        }
        if matches!(
            operation,
            Operation::ProposalSubmit | Operation::ProposalWithdraw | Operation::ProposalResolve
        ) {
            let room = input.room_id.as_deref().ok_or_else(invalid)?;
            if !protocol::canonical_path_id(room) {
                return Err(invalid());
            }
            let room = utf8_percent_encode(room, CANONICAL_PATH_ENCODE_SET);
            let mut path = format!("/api/arena/rooms/v1/{room}/proposals");
            if operation != Operation::ProposalSubmit {
                let proposal = input.proposal_id.as_deref().ok_or_else(invalid)?;
                if !protocol::canonical_path_id(proposal) {
                    return Err(invalid());
                }
                let proposal = utf8_percent_encode(proposal, CANONICAL_PATH_ENCODE_SET);
                let action = if operation == Operation::ProposalWithdraw {
                    "withdraw"
                } else {
                    "resolve"
                };
                path.push_str(&format!("/{proposal}/{action}"));
            }
            url.set_path(&path);
        }
        if matches!(
            operation,
            Operation::GenerationRead | Operation::GenerationCancel
        ) {
            let room = input.room_id.as_deref().ok_or_else(invalid)?;
            let fields = input.request.as_object().ok_or_else(invalid)?;
            let generation = fields
                .get("generationId")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?;
            if fields.len()
                != if operation == Operation::GenerationCancel {
                    2
                } else {
                    1
                }
                || !protocol::canonical_path_id(room)
                || !protocol::canonical_path_id(generation)
            {
                return Err(invalid());
            }
            let room = utf8_percent_encode(room, CANONICAL_PATH_ENCODE_SET);
            let generation = utf8_percent_encode(generation, CANONICAL_PATH_ENCODE_SET);
            let suffix = if operation == Operation::GenerationCancel {
                "/cancel"
            } else {
                ""
            };
            url.set_path(&format!(
                "/api/arena/rooms/v1/{room}/generations/{generation}{suffix}"
            ));
        }
        if operation == Operation::Discover {
            let query = protocol::validate_discover_query(&input.request).map_err(|_| invalid())?;
            let limit = query["limit"].as_u64().ok_or_else(invalid)?.to_string();
            let mut pairs = url.query_pairs_mut();
            pairs.append_pair("limit", &limit);
            if let Some(cursor) = query.get("cursor").and_then(Value::as_str) {
                pairs.append_pair("cursor", cursor);
            }
        }
        let method = if operation.is_post() {
            Method::POST
        } else {
            Method::GET
        };
        let mut credential = header::HeaderValue::from_str(cookie).map_err(|_| invalid())?;
        credential.set_sensitive(true);
        let mut request = self
            .client
            .request(method, url)
            .header(header::ORIGIN, &self.caller)
            .header(header::COOKIE, credential)
            .header(header::ACCEPT, "application/json; arena-error-taxonomy=2")
            .header(header::ACCEPT_ENCODING, "identity")
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION)
            .header(EXPECTED_USER_ID_HEADER, format!("v1:{owner}"));
        if operation.is_post() {
            let mut metadata = json!({"version":PROTOCOL_VERSION,"expectedUserId":owner});
            if operation == Operation::Create {
                metadata["createMode"] = json!(if input.resume_only {
                    "resume-only"
                } else {
                    "new"
                });
            }
            let body = if operation == Operation::GenerationCancel {
                json!({"expectedRoomEpoch":input.request["expectedRoomEpoch"]})
            } else {
                input.request.clone()
            };
            let envelope = json!({"desktopRoom":metadata,"request":body});
            // The protocol checks original compact bytes before any trim/default projection.
            let validated = protocol::validate_service_request(operation, &envelope, owner)?;
            let bytes = serde_json::to_vec(&validated).map_err(|_| invalid())?;
            if bytes.len() > MAX_REQUEST_BYTES {
                return Err(invalid());
            }
            request = request
                .header(header::CONTENT_TYPE, "application/json")
                .body(bytes);
        } else if !matches!(operation, Operation::Discover | Operation::GenerationRead)
            && input
                .request
                .as_object()
                .is_none_or(|object| !object.is_empty())
        {
            return Err(invalid());
        }
        request.build().map_err(|_| invalid())
    }

    async fn receive_generation_read(
        &self,
        request: reqwest::Request,
        owner: u64,
    ) -> Result<Vec<u8>, RoomError> {
        let outcome = "not-applicable";
        let response = self
            .client
            .execute(request)
            .await
            .map_err(|_| RoomError::new("network-error", outcome))?;
        let status = response.status().as_u16();
        validate_response_headers(&response, outcome)?;
        // Only the dedicated 200 report path receives the larger wire budget.
        // Every service error and every other status retains the original 256 KiB.
        let limit = if status == 200 {
            MAX_GENERATION_RESPONSE_BYTES
        } else {
            MAX_RESPONSE_BYTES
        };
        if response
            .content_length()
            .is_some_and(|length| length > limit as u64)
        {
            return Err(RoomError::new("response-too-large", outcome));
        }
        let mut body = Vec::new();
        if let Some(length) = response.content_length() {
            body.try_reserve_exact(length as usize)
                .map_err(|_| RoomError::new("internal-error", outcome))?;
        }
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| RoomError::new("network-error", outcome))?;
            reserve_generation_bytes(&mut body, chunk.len(), limit)?;
            body.extend_from_slice(&chunk);
        }
        if status != 200 {
            let response =
                protocol::validate_http_response(Operation::GenerationRead, status, &body, owner)?;
            return Err(
                checked_service_error(Operation::GenerationRead, status, &response)?
                    .ok_or_else(|| RoomError::new("invalid-response", outcome))?,
            );
        }
        Ok(body)
    }

    async fn receive(
        &self,
        request: reqwest::Request,
        operation: Operation,
        owner: u64,
    ) -> Result<Value, RoomError> {
        let outcome = if operation.is_post() {
            "unknown"
        } else {
            "not-applicable"
        };
        let response = self
            .client
            .execute(request)
            .await
            .map_err(|_| RoomError::new("network-error", outcome))?;
        let status = response.status().as_u16();
        validate_response_headers(&response, outcome)?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(RoomError::new("response-too-large", outcome));
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| RoomError::new("network-error", outcome))?;
            if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(body.len()) {
                return Err(RoomError::new("response-too-large", outcome));
            }
            body.extend_from_slice(&chunk);
        }
        let response = protocol::validate_http_response(operation, status, &body, owner)?;
        if let Some(error) = checked_service_error(operation, status, &response)? {
            return Err(error);
        }
        Ok(response)
    }

    #[cfg(test)]
    pub(crate) fn loopback(address: std::net::SocketAddr) -> Self {
        assert!(address.ip().is_loopback());
        Self {
            client: client_builder().build().unwrap(),
            origin: Url::parse(&format!("http://{address}")).unwrap(),
            caller: caller_origin().unwrap(),
        }
    }
}

fn reserve_generation_bytes(
    body: &mut Vec<u8>,
    additional: usize,
    limit: usize,
) -> Result<(), RoomError> {
    let next_len = body
        .len()
        .checked_add(additional)
        .filter(|length| *length <= limit)
        .ok_or_else(|| RoomError::new("response-too-large", "not-applicable"))?;
    if next_len > body.capacity() {
        // Geometric growth avoids repeatedly copying a chunked large report, but
        // its explicit ceiling never asks Vec to double beyond the wire budget.
        let capacity = body.capacity().saturating_mul(2).max(next_len).min(limit);
        body.try_reserve_exact(capacity - body.len())
            .map_err(|_| RoomError::new("internal-error", "not-applicable"))?;
    }
    Ok(())
}

fn validate_response_headers(response: &reqwest::Response, outcome: &str) -> Result<(), RoomError> {
    let invalid = || RoomError::new("invalid-response", outcome);
    // Never follow Location, retry, or interpret raw server text as an error message.
    if response.status().is_redirection() {
        return Err(invalid());
    }
    let headers = response.headers();
    if headers
        .iter()
        .map(|(key, value)| key.as_str().len() + value.as_bytes().len() + 4)
        .sum::<usize>()
        > MAX_RESPONSE_HEADERS
    {
        return Err(invalid());
    }
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim);
    if !content_type.is_some_and(|value| value.eq_ignore_ascii_case("application/json"))
        || headers.get_all(header::CONTENT_TYPE).iter().count() != 1
        || headers
            .get_all(header::CONTENT_ENCODING)
            .iter()
            .any(|value| value != "identity")
    {
        return Err(invalid());
    }
    Ok(())
}

// Call only after the closed protocol validator has accepted the error envelope.
fn checked_service_error(
    operation: Operation,
    status: u16,
    response: &Value,
) -> Result<Option<RoomError>, RoomError> {
    let Some(error) = response.get("error") else {
        return Ok(None);
    };
    let invalid = || {
        RoomError::new(
            "invalid-response",
            if operation.is_post() {
                "unknown"
            } else {
                "not-applicable"
            },
        )
    };
    let code = error["code"].as_str().ok_or_else(invalid)?;
    let declared_outcome = error["outcome"].as_str().ok_or_else(invalid)?;
    let cleanup_safe = status == 401
        && code == "ROOM_AUTHENTICATION_REQUIRED"
        && response["desktopRoom"]["viewerUserId"].is_null()
        && declared_outcome
            == if operation.is_post() {
                "not-applied"
            } else {
                "not-applicable"
            };
    Ok(Some(
        RoomError::new(
            if cleanup_safe {
                "not-authenticated"
            } else {
                "service-rejected"
            },
            declared_outcome,
        )
        .with_server_code(code),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn fixture(operation: Operation, field: &str) -> Value {
        if matches!(
            operation,
            Operation::ProposalSubmit | Operation::ProposalWithdraw | Operation::ProposalResolve
        ) {
            let all: Value = serde_json::from_str(include_str!(
                "../../../../packages/contracts/fixtures/desktop-room-proposals.json"
            ))
            .unwrap();
            return all[operation.as_str()][field].clone();
        }
        let all: Value = serde_json::from_str(include_str!(
            "../../../../packages/contracts/fixtures/desktop-room-session.json"
        ))
        .unwrap();
        all["operations"][operation.as_str()][field].clone()
    }
    fn input(operation: Operation) -> HttpRequest {
        let request = if operation.is_post() {
            fixture(operation, "request")["request"].clone()
        } else {
            json!({})
        };
        HttpRequest {
            operation,
            room_id: if matches!(operation, Operation::Discover | Operation::Create) {
                None
            } else {
                Some("room_01JARENAEXAMPLE".into())
            },
            proposal_id: if matches!(
                operation,
                Operation::ProposalWithdraw | Operation::ProposalResolve
            ) {
                Some("desktop-proposal-1".into())
            } else {
                None
            },
            request,
            resume_only: false,
        }
    }
    async fn read_request(stream: &mut tokio::net::TcpStream) -> Vec<u8> {
        let mut result = Vec::new();
        let mut expected = None;
        loop {
            let mut chunk = [0; 4096];
            let count = tokio::time::timeout(Duration::from_secs(3), stream.read(&mut chunk))
                .await
                .unwrap()
                .unwrap();
            if count == 0 {
                break;
            }
            result.extend_from_slice(&chunk[..count]);
            assert!(result.len() < MAX_REQUEST_BYTES + 16 * 1024);
            if let Some(end) = result.windows(4).position(|part| part == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&result[..end]);
                let length = head
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                expected = Some(end + 4 + length);
            }
            if expected.is_some_and(|length| result.len() >= length) {
                break;
            }
        }
        result
    }
    async fn server(
        status: u16,
        body: Vec<u8>,
        headers: &str,
    ) -> (RoomHttp, tokio::task::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = RoomHttp::loopback(listener.local_addr().unwrap());
        let headers = headers.to_owned();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_request(&mut stream).await;
            let head = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n", body.len());
            stream.write_all(head.as_bytes()).await.unwrap();
            let _ = stream.write_all(&body).await;
            request
        });
        (client, task)
    }
    async fn roundtrip(operation: Operation, status: u16, body: Value) -> Result<Value, RoomError> {
        let (client, task) = server(status, serde_json::to_vec(&body).unwrap(), "").await;
        let result = client
            .execute(
                &input(operation),
                42,
                "better-auth.session_token=synthetic-only",
                &CancellationToken::new(),
            )
            .await;
        task.await.unwrap();
        result
    }

    fn generation_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../packages/contracts/fixtures/desktop-room-generation-read.json"
        ))
        .unwrap()
    }

    fn generation_input() -> HttpRequest {
        let mut value = input(Operation::GenerationRead);
        value.request = json!({"generationId": "generation-1"});
        value
    }

    #[test]
    fn generation_chunked_capacity_grows_geometrically_with_a_hard_ceiling() {
        let mut body = Vec::new();
        let mut capacities = Vec::new();
        for _ in 0..1000 {
            let old = body.capacity();
            reserve_generation_bytes(&mut body, 1, 1000).unwrap();
            body.push(b' ');
            assert!(body.capacity() <= 1000);
            if body.capacity() != old {
                capacities.push(body.capacity());
            }
        }
        assert_eq!(capacities, [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1000]);
        let error = reserve_generation_bytes(&mut body, 1, 1000).unwrap_err();
        assert_eq!(error.code, "response-too-large");
        assert_eq!((body.len(), body.capacity()), (1000, 1000));
        assert!(reserve_generation_bytes(&mut body, usize::MAX, 1000).is_err());
        let mut larger_chunk = Vec::new();
        reserve_generation_bytes(&mut larger_chunk, 700, 1000).unwrap();
        larger_chunk.resize(700, b' ');
        reserve_generation_bytes(&mut larger_chunk, 300, 1000).unwrap();
        assert_eq!(larger_chunk.capacity(), 1000);
    }

    fn generation_target() -> GenerationReadTarget {
        GenerationReadTarget {
            room_id: "room_01JARENAEXAMPLE".into(),
            room_epoch: "epoch_01JARENA".into(),
            generation_id: "generation-1".into(),
            attempt: 1,
        }
    }

    async fn generation_roundtrip(
        status: u16,
        body: Vec<u8>,
        headers: &str,
    ) -> Result<GenerationReadResponse, RoomError> {
        let (client, task) = server(status, body, headers).await;
        let result = client
            .execute_generation_read(
                &generation_input(),
                42,
                "session=private-generation-read",
                &CancellationToken::new(),
                &generation_target(),
            )
            .await;
        task.await.unwrap();
        result
    }

    #[test]
    fn generation_get_is_fixed_canonical_bodyless_and_closed() {
        let client = RoomHttp::new().unwrap();
        let request = client
            .prepare(&generation_input(), 42, "session=test")
            .unwrap();
        assert_eq!(request.method(), Method::GET);
        assert_eq!(
            request.url().path(),
            "/api/arena/rooms/v1/room_01JARENAEXAMPLE/generations/generation-1"
        );
        assert_eq!(request.url().origin(), service_origin().unwrap().origin());
        assert_eq!(request.url().query(), None);
        assert_eq!(request.url().fragment(), None);
        assert!(request.body().is_none());
        assert!(request.headers()[header::COOKIE].is_sensitive());
        assert_eq!(request.headers()[EXPECTED_USER_ID_HEADER], "v1:42");
        assert_eq!(request.headers()[PROTOCOL_HEADER], PROTOCOL_VERSION);
        assert_eq!(request.headers()[header::ACCEPT_ENCODING], "identity");

        let mut value = generation_input();
        value.room_id = Some("房间 空格😀".into());
        value.request = json!({"generationId": "g?x#y&z+a=b:@$;,[]!~*'()_-\t\0."});
        let request = client.prepare(&value, 42, "session=test").unwrap();
        assert_eq!(request.url().path(), "/api/arena/rooms/v1/%E6%88%BF%E9%97%B4%20%E7%A9%BA%E6%A0%BC%F0%9F%98%80/generations/g%3Fx%23y%26z%2Ba%3Db%3A%40%24%3B%2C%5B%5D!~*'()_-%09%00.");
        assert_eq!(request.url().query(), None);
        assert_eq!(request.url().fragment(), None);
        for invalid in [
            "", ".", "..", " room", "room ", "%2e", "%252f", "a/b", "a\\b",
        ] {
            for room in [true, false] {
                let mut value = generation_input();
                if room {
                    value.room_id = Some(invalid.into());
                } else {
                    value.request["generationId"] = json!(invalid);
                }
                let error = client.prepare(&value, 42, "session=test").unwrap_err();
                assert_eq!(
                    (error.code, error.outcome),
                    ("invalid-request", "not-applicable")
                );
            }
        }
        for request in [
            json!({}),
            json!({"generationId": 1}),
            json!({"generationId":"generation-1","cursor":"history"}),
            json!({"generationId":"generation-1","url":"https://unapproved.example"}),
        ] {
            let mut value = generation_input();
            value.request = request;
            assert!(client.prepare(&value, 42, "session=test").is_err());
        }
        let mut value = generation_input();
        value.proposal_id = Some("unexpected".into());
        assert!(client.prepare(&value, 42, "session=test").is_err());
        let mut value = generation_input();
        value.resume_only = true;
        assert!(client.prepare(&value, 42, "session=test").is_err());
    }

    #[tokio::test]
    async fn generation_raw_wire_and_sha_are_preserved_without_value_reencoding() {
        let fixture = generation_fixture();
        let raw = fixture["rawEnvelope"].as_str().unwrap();
        let (client, task) = server(200, raw.as_bytes().to_vec(), "").await;
        let response = client
            .execute_generation_read(
                &generation_input(),
                42,
                "session=private-generation-read",
                &CancellationToken::new(),
                &generation_target(),
            )
            .await
            .unwrap();
        assert_eq!(response.raw, raw);
        assert_eq!(
            response.digest,
            fixture["descriptor"]["digest"].as_str().unwrap()
        );
        assert_eq!(response.meta.generation["generationId"], "generation-1");
        let request = String::from_utf8(task.await.unwrap()).unwrap();
        assert!(request.starts_with(
            "GET /api/arena/rooms/v1/room_01JARENAEXAMPLE/generations/generation-1 HTTP/1.1\r\n"
        ));
        assert!(request
            .to_ascii_lowercase()
            .contains("cookie: session=private-generation-read\r\n"));
        assert!(request.ends_with("\r\n\r\n"));
        let spaced = format!(" \n{raw}\t\r\n");
        let response = generation_roundtrip(200, spaced.as_bytes().to_vec(), "")
            .await
            .unwrap();
        assert_eq!(response.raw, spaced);
        assert_eq!(
            response.digest,
            format!("{:x}", Sha256::digest(spaced.as_bytes()))
        );
        assert_ne!(
            response.digest,
            fixture["descriptor"]["digest"].as_str().unwrap()
        );
    }

    #[tokio::test]
    async fn generation_errors_only_clear_auth_for_strict_checked_401() {
        let auth = json!({"desktopRoom":{"version":PROTOCOL_VERSION,"viewerUserId":null},"error":{"code":"ROOM_AUTHENTICATION_REQUIRED","message":"must not escape","outcome":"not-applicable"}});
        let error = generation_roundtrip(401, serde_json::to_vec(&auth).unwrap(), "")
            .await
            .unwrap_err();
        assert_eq!(
            (error.code, error.outcome, error.server_code),
            (
                "not-authenticated",
                "not-applicable",
                Some("ROOM_AUTHENTICATION_REQUIRED")
            )
        );
        let rate_limited = generation_fixture()["operation"]["error"].clone();
        let error = generation_roundtrip(429, serde_json::to_vec(&rate_limited).unwrap(), "")
            .await
            .unwrap_err();
        assert_eq!(
            (error.code, error.server_code),
            ("service-rejected", Some("ROOM_RATE_LIMITED"))
        );
        let mut owner = auth.clone();
        owner["desktopRoom"]["viewerUserId"] = json!(42);
        let mut outcome = auth.clone();
        outcome["error"]["outcome"] = json!("not-applied");
        let mut version = auth.clone();
        version["desktopRoom"]["version"] = json!("wrong");
        let mut unknown = auth.clone();
        unknown["desktopRoom"]["unknown"] = json!(true);
        for (status, body) in [
            (200, auth.clone()),
            (403, auth),
            (401, owner),
            (401, outcome),
            (401, version),
            (401, unknown),
        ] {
            let error = generation_roundtrip(status, serde_json::to_vec(&body).unwrap(), "")
                .await
                .unwrap_err();
            assert_eq!(
                (error.code, error.outcome, error.server_code),
                ("invalid-response", "not-applicable", None)
            );
        }
        let mut padded = serde_json::to_vec(&rate_limited).unwrap();
        padded.resize(MAX_RESPONSE_BYTES, b' ');
        let error = generation_roundtrip(429, padded, "").await.unwrap_err();
        assert_eq!(error.code, "service-rejected");
        let error = generation_roundtrip(401, vec![b' '; MAX_RESPONSE_BYTES + 1], "")
            .await
            .unwrap_err();
        assert_eq!(
            (error.code, error.server_code),
            ("response-too-large", None)
        );
    }

    #[tokio::test]
    async fn generation_large_timestamp_keeps_raw_hash_without_duplicating_authority_metadata() {
        let raw = generation_fixture()["rawEnvelope"]
            .as_str()
            .unwrap()
            .replace(
                "2026-10-12T00:00:00.000Z",
                &format!("2026-10-12T00:00:00.{}Z", "1".repeat(MAX_RESPONSE_BYTES)),
            );
        assert!(raw.len() > MAX_RESPONSE_BYTES);
        let response = generation_roundtrip(200, raw.as_bytes().to_vec(), "")
            .await
            .unwrap();
        assert_eq!(response.raw, raw);
        assert_eq!(
            response.digest,
            format!("{:x}", Sha256::digest(raw.as_bytes()))
        );
        assert!(response.meta.generation.get("startedAt").is_none());
        assert!(response.meta.generation.get("finishedAt").is_none());
        assert_eq!(response.meta.generation["generationId"], "generation-1");
    }

    #[tokio::test]
    async fn generation_rejects_wrong_status_headers_utf8_identity_and_duplicates() {
        let raw = generation_fixture()["rawEnvelope"]
            .as_str()
            .unwrap()
            .to_owned();
        for (status, body, headers) in [
            (201, raw.as_bytes().to_vec(), ""),
            (204, Vec::new(), ""),
            (200, raw.as_bytes().to_vec(), "Content-Type: text/plain\r\n"),
            (200, raw.as_bytes().to_vec(), "Content-Encoding: gzip\r\n"),
            (200, vec![0xff, 0xfe], ""),
            (
                200,
                raw.replace("\"viewerUserId\":42", "\"viewerUserId\":43")
                    .into_bytes(),
                "",
            ),
            (
                200,
                raw.replace(
                    "\"generationId\":\"generation-1\"",
                    "\"generationId\":\"generation-2\"",
                )
                .into_bytes(),
                "",
            ),
            (
                200,
                raw.replacen(
                    "\"roomEpoch\":\"epoch_01JARENA\"",
                    "\"roomEpoch\":\"wrong\"",
                    1,
                )
                .into_bytes(),
                "",
            ),
            (
                200,
                raw.replacen("\"attempt\":1", "\"attempt\":2", 1)
                    .into_bytes(),
                "",
            ),
            (
                200,
                raw.replacen(
                    "\"viewerUserId\":42",
                    "\"viewerUserId\":42,\"viewerUserId\":42",
                    1,
                )
                .into_bytes(),
                "",
            ),
        ] {
            let error = generation_roundtrip(status, body, headers)
                .await
                .unwrap_err();
            assert_eq!(
                (error.code, error.outcome),
                ("invalid-response", "not-applicable")
            );
        }
        let headers = format!("X-Untrusted: {}\r\n", "a".repeat(MAX_RESPONSE_HEADERS));
        let error = generation_roundtrip(200, raw.into_bytes(), &headers)
            .await
            .unwrap_err();
        assert_eq!(error.code, "invalid-response");
    }

    #[tokio::test]
    async fn generation_cancel_and_generic_dispatch_send_no_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = RoomHttp::loopback(listener.local_addr().unwrap());
        let error = client
            .execute(
                &generation_input(),
                42,
                "session=test",
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "invalid-request");
        let cancel = CancellationToken::new();
        cancel.cancel();
        let error = client
            .execute_generation_read(
                &generation_input(),
                42,
                "session=test",
                &cancel,
                &generation_target(),
            )
            .await
            .unwrap_err();
        assert_eq!(
            (error.code, error.outcome),
            ("scope-changed", "not-applicable")
        );
        let mut target = generation_target();
        target.generation_id = "other-generation".into();
        let error = client
            .execute_generation_read(
                &generation_input(),
                42,
                "session=test",
                &CancellationToken::new(),
                &target,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "invalid-request");
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );

        let cancel = CancellationToken::new();
        let server_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_request(&mut stream).await;
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n").await.unwrap();
            server_cancel.cancel();
            let mut byte = [0];
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(2), stream.read(&mut byte))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
        });
        let error = client
            .execute_generation_read(
                &generation_input(),
                42,
                "session=test",
                &cancel,
                &generation_target(),
            )
            .await
            .unwrap_err();
        assert_eq!(
            (error.code, error.outcome),
            ("scope-changed", "not-applicable")
        );
        task.await.unwrap();
    }

    #[tokio::test]
    async fn generation_redirect_and_network_loss_never_retry() {
        let redirected = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let location = format!(
            "Location: http://{}/credential-leak\r\n",
            redirected.local_addr().unwrap()
        );
        let error = generation_roundtrip(307, Vec::new(), &location)
            .await
            .unwrap_err();
        assert_eq!(
            (error.code, error.outcome),
            ("invalid-response", "not-applicable")
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), redirected.accept())
                .await
                .is_err()
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = RoomHttp::loopback(listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_request(&mut stream).await;
            drop(stream);
            assert!(
                tokio::time::timeout(Duration::from_millis(100), listener.accept())
                    .await
                    .is_err()
            );
        });
        let error = client
            .execute_generation_read(
                &generation_input(),
                42,
                "session=test",
                &CancellationToken::new(),
                &generation_target(),
            )
            .await
            .unwrap_err();
        assert_eq!(
            (error.code, error.outcome),
            ("network-error", "not-applicable")
        );
        task.await.unwrap();
    }

    #[tokio::test]
    async fn generation_http_deadline_covers_stalled_body() {
        assert_eq!(HTTP_DEADLINE, Duration::from_secs(15));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = RoomHttp::loopback(listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_request(&mut stream).await;
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{").await.unwrap();
            let mut byte = [0];
            assert_eq!(stream.read(&mut byte).await.unwrap(), 0);
        });
        let error = tokio::time::timeout(
            Duration::from_secs(20),
            client.execute_generation_read(
                &generation_input(),
                42,
                "session=test",
                &CancellationToken::new(),
                &generation_target(),
            ),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert_eq!(
            (error.code, error.outcome),
            ("network-error", "not-applicable")
        );
        task.await.unwrap();
    }

    #[tokio::test]
    async fn generation_success_wire_cap_is_exact_and_chunked_plus_one_is_rejected() {
        let raw = generation_fixture()["rawEnvelope"]
            .as_str()
            .unwrap()
            .to_owned();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = RoomHttp::loopback(listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_request(&mut stream).await;
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                MAX_GENERATION_RESPONSE_BYTES + 1,
            );
            stream.write_all(head.as_bytes()).await.unwrap();
        });
        let error = client
            .execute_generation_read(
                &generation_input(),
                42,
                "session=test",
                &CancellationToken::new(),
                &generation_target(),
            )
            .await
            .unwrap_err();
        assert_eq!(
            (error.code, error.outcome),
            ("response-too-large", "not-applicable")
        );
        task.await.unwrap();
        for chunked in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let client = RoomHttp::loopback(listener.local_addr().unwrap());
            let prefix = raw.clone();
            let task = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                read_request(&mut stream).await;
                let length = MAX_GENERATION_RESPONSE_BYTES + usize::from(chunked);
                let framing = if chunked {
                    "Transfer-Encoding: chunked".to_owned()
                } else {
                    format!("Content-Length: {length}")
                };
                let head = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{framing}\r\nConnection: close\r\n\r\n");
                stream.write_all(head.as_bytes()).await.unwrap();
                if chunked {
                    stream
                        .write_all(format!("{length:X}\r\n").as_bytes())
                        .await
                        .unwrap();
                }
                stream.write_all(prefix.as_bytes()).await.unwrap();
                let padding = [b' '; 64 * 1024];
                let mut left = length - prefix.len();
                while left > 0 {
                    let count = left.min(padding.len());
                    if stream.write_all(&padding[..count]).await.is_err() {
                        break;
                    }
                    left -= count;
                }
                if chunked {
                    let _ = stream.write_all(b"\r\n0\r\n\r\n").await;
                }
            });
            let result = client
                .execute_generation_read(
                    &generation_input(),
                    42,
                    "session=test",
                    &CancellationToken::new(),
                    &generation_target(),
                )
                .await;
            if chunked {
                let error = result.unwrap_err();
                assert_eq!(
                    (error.code, error.outcome),
                    ("response-too-large", "not-applicable")
                );
            } else {
                let response = result.unwrap();
                assert_eq!(response.raw.len(), MAX_GENERATION_RESPONSE_BYTES);
                assert!(response.raw.starts_with(&raw));
                assert!(response.raw[raw.len()..].bytes().all(|byte| byte == b' '));
                let mut hash = Sha256::new();
                hash.update(raw.as_bytes());
                let padding = [b' '; 64 * 1024];
                let mut left = MAX_GENERATION_RESPONSE_BYTES - raw.len();
                while left > 0 {
                    let count = left.min(padding.len());
                    hash.update(&padding[..count]);
                    left -= count;
                }
                assert_eq!(response.digest, format!("{:x}", hash.finalize()));
            }
            task.await.unwrap();
        }
    }

    #[test]
    fn proposal_routes_use_exact_canonical_segments_and_original_dtos() {
        let client = RoomHttp::new().unwrap();
        for (op, suffix) in [
            (Operation::ProposalSubmit, ""),
            (Operation::ProposalWithdraw, "/desktop-proposal-1/withdraw"),
            (Operation::ProposalResolve, "/desktop-proposal-1/resolve"),
        ] {
            let value = input(op);
            let request = client.prepare(&value, 42, "session=test").unwrap();
            assert_eq!(request.method(), Method::POST);
            assert_eq!(
                request.url().path(),
                format!("/api/arena/rooms/v1/room_01JARENAEXAMPLE/proposals{suffix}")
            );
            let body: Value =
                serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
            assert_eq!(body, fixture(op, "request"));
            assert_eq!(request.headers()[PROTOCOL_HEADER], PROTOCOL_VERSION);
            assert_eq!(request.headers()[EXPECTED_USER_ID_HEADER], "v1:42");
        }
        let mut value = input(Operation::ProposalResolve);
        value.room_id = Some("房间 空格😀".into());
        value.proposal_id = Some("p?x#y&z+a=b:@$;,[]!~*'()_-\t\0.".into());
        let request = client.prepare(&value, 42, "session=test").unwrap();
        assert_eq!(request.url().path(), "/api/arena/rooms/v1/%E6%88%BF%E9%97%B4%20%E7%A9%BA%E6%A0%BC%F0%9F%98%80/proposals/p%3Fx%23y%26z%2Ba%3Db%3A%40%24%3B%2C%5B%5D!~*'()_-%09%00./resolve");
        assert_eq!(request.url().query(), None);
        assert_eq!(request.url().fragment(), None);
        assert_eq!(request.url().origin(), service_origin().unwrap().origin());
        for op in [
            Operation::ProposalSubmit,
            Operation::ProposalWithdraw,
            Operation::ProposalResolve,
        ] {
            for invalid in [
                "", ".", "..", " room", "room ", "%2e", "%252f", "a/b", "a\\b",
            ] {
                let mut value = input(op);
                value.room_id = Some(invalid.into());
                assert_eq!(
                    client
                        .prepare(&value, 42, "session=test")
                        .unwrap_err()
                        .outcome,
                    "not-applied"
                );
                if op != Operation::ProposalSubmit {
                    let mut value = input(op);
                    value.proposal_id = Some(invalid.into());
                    assert!(client.prepare(&value, 42, "session=test").is_err());
                }
            }
            let mut value = input(op);
            value.resume_only = true;
            assert!(client.prepare(&value, 42, "session=test").is_err());
            let mut value = input(op);
            value.room_id = None;
            assert!(client.prepare(&value, 42, "session=test").is_err());
            let mut value = input(op);
            value.proposal_id = if op == Operation::ProposalSubmit {
                Some("not-a-path-target".into())
            } else {
                None
            };
            assert!(client.prepare(&value, 42, "session=test").is_err());
        }
        let mut legacy = input(Operation::Join);
        legacy.proposal_id = Some("extra".into());
        assert!(client.prepare(&legacy, 42, "session=test").is_err());
    }
    #[tokio::test]
    async fn proposal_loopback_accepts_negotiated_receipts_and_fails_closed_without_fallback() {
        for op in [
            Operation::ProposalSubmit,
            Operation::ProposalWithdraw,
            Operation::ProposalResolve,
        ] {
            let success = fixture(op, "success");
            assert_eq!(roundtrip(op, 200, success.clone()).await.unwrap(), success);
            let error = roundtrip(op, 429, fixture(op, "error")).await.unwrap_err();
            assert_eq!(error.outcome, "not-applied");
            assert_eq!(error.server_code, Some("ROOM_RATE_LIMITED"));
            let error = roundtrip(op, 200, success["result"].clone())
                .await
                .unwrap_err();
            assert_eq!(error.code, "invalid-response");
            assert_eq!(error.outcome, "unknown");
            let mut wrong_owner = success.clone();
            wrong_owner["desktopRoom"]["viewerUserId"] = json!(43);
            let error = roundtrip(op, 200, wrong_owner).await.unwrap_err();
            assert_eq!(error.outcome, "unknown");
        }
    }
    #[test]
    fn production_targets_and_requests_are_fixed() {
        assert_eq!(
            service_origin().unwrap().as_str(),
            "https://homura.colanns.me/"
        );
        assert_eq!(caller_origin().unwrap(), "https://mahoshojo.colanns.me");
        let client = RoomHttp::new().unwrap();
        for operation in [
            Operation::Discover,
            Operation::Create,
            Operation::Join,
            Operation::Session,
            Operation::Ticket,
            Operation::Leave,
            Operation::Close,
        ] {
            let request = client
                .prepare(&input(operation), 42, "better-auth.session_token=test")
                .unwrap();
            assert_eq!(request.url().origin(), service_origin().unwrap().origin());
            assert_eq!(request.headers()[header::ORIGIN], caller_origin().unwrap());
            assert!(request.headers()[header::COOKIE].is_sensitive());
            assert_eq!(request.headers()[PROTOCOL_HEADER], PROTOCOL_VERSION);
            assert_eq!(request.headers()[EXPECTED_USER_ID_HEADER], "v1:42");
            assert_eq!(
                request.method(),
                if operation.is_post() {
                    Method::POST
                } else {
                    Method::GET
                }
            );
            if operation.is_post() {
                let envelope: Value =
                    serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
                assert_eq!(envelope["desktopRoom"]["expectedUserId"], 42);
                assert_eq!(
                    envelope["desktopRoom"].get("createMode").is_some(),
                    operation == Operation::Create
                );
            }
        }
        let mut resume = input(Operation::Create);
        resume.resume_only = true;
        let built = client.prepare(&resume, 42, "session=test").unwrap();
        let body: Value =
            serde_json::from_slice(built.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(body["desktopRoom"]["createMode"], "resume-only");
        let mut escaped = input(Operation::Session);
        escaped.room_id = Some("room/../../ticket?token=secret#part".into());
        let request = client.prepare(&escaped, 42, "session=test").unwrap();
        assert_eq!(request.url().query(), None);
        assert_eq!(request.url().fragment(), None);
        assert!(request.url().path().contains("%2F"));
    }

    #[test]
    fn discovery_url_contains_only_canonical_limit_and_optional_cursor() {
        let client = RoomHttp::new().unwrap();
        let defaults = client
            .prepare(&input(Operation::Discover), 42, "session=test")
            .unwrap();
        assert_eq!(defaults.url().query(), Some("limit=20"));
        let mut discover = input(Operation::Discover);
        discover.request = json!({"limit":50,"cursor":"next_page-01"});
        let request = client.prepare(&discover, 42, "session=test").unwrap();
        assert_eq!(request.url().path(), "/api/arena/rooms/v1");
        assert_eq!(request.url().query(), Some("limit=50&cursor=next_page-01"));
        assert_eq!(request.url().origin(), service_origin().unwrap().origin());
        assert!(request.body().is_none());
        discover.request = json!({"cursor":"next&injected=true"});
        assert!(client.prepare(&discover, 42, "session=test").is_err());
        for operation in [
            Operation::Create,
            Operation::Join,
            Operation::Session,
            Operation::Ticket,
            Operation::Leave,
            Operation::Close,
        ] {
            assert!(client
                .prepare(&input(operation), 42, "session=test")
                .unwrap()
                .url()
                .query()
                .is_none());
        }
    }

    #[test]
    fn request_budget_and_closed_inputs_are_checked_before_any_send() {
        let client = RoomHttp::new().unwrap();
        let mut request = input(Operation::Join);
        request.request["displayName"] = json!(" ".repeat(protocol::MAX_ORIGINAL_REQUEST_BYTES));
        let error = client.prepare(&request, 42, "session=test").unwrap_err();
        assert_eq!(error.outcome, "not-applied");
        request = input(Operation::Join);
        request.request["url"] = json!("https://unapproved.example");
        assert!(client.prepare(&request, 42, "session=test").is_err());
        assert!(client
            .prepare(
                &input(Operation::Join),
                42,
                "session=test\r\nX-Injection: yes"
            )
            .is_err());
        assert!(client
            .prepare(
                &input(Operation::Join),
                MAX_SAFE_INTEGER + 1,
                "session=test"
            )
            .is_err());
        let mut discover = input(Operation::Discover);
        discover.request = json!({"search":"unapproved"});
        assert!(client.prepare(&discover, 42, "session=test").is_err());
    }

    #[tokio::test]
    async fn all_seven_real_http_replies_validate_and_inject_private_lease() {
        for operation in [
            Operation::Discover,
            Operation::Create,
            Operation::Join,
            Operation::Session,
            Operation::Ticket,
            Operation::Leave,
            Operation::Close,
        ] {
            let expected = fixture(operation, "success");
            let status = if operation == Operation::Create {
                201
            } else {
                200
            };
            let (client, task) = server(status, serde_json::to_vec(&expected).unwrap(), "").await;
            assert_eq!(
                client
                    .execute(
                        &input(operation),
                        42,
                        "session=private-lease",
                        &CancellationToken::new()
                    )
                    .await
                    .unwrap(),
                expected
            );
            let request = String::from_utf8(task.await.unwrap()).unwrap();
            let head = request
                .split("\r\n\r\n")
                .next()
                .unwrap()
                .to_ascii_lowercase();
            assert!(head
                .lines()
                .any(|line| line == "cookie: session=private-lease"));
            assert!(head
                .lines()
                .any(|line| line == "x-mahoshojo-room-expected-user-id: v1:42"));
        }
    }

    #[tokio::test]
    async fn malformed_version_owner_dto_and_missing_reply_are_unknown_for_posts() {
        for operation in [
            Operation::Create,
            Operation::Join,
            Operation::Ticket,
            Operation::Leave,
            Operation::Close,
        ] {
            let valid = fixture(operation, "success");
            let mut wrong_owner = valid.clone();
            wrong_owner["desktopRoom"]["viewerUserId"] = json!(43);
            let mut wrong_version = valid.clone();
            wrong_version["desktopRoom"]["version"] = json!("future-version");
            let mut wrong_dto = valid.clone();
            wrong_dto["result"]["unapproved"] = json!(true);
            for body in [json!({}), wrong_owner, wrong_version, wrong_dto] {
                let error = roundtrip(
                    operation,
                    if operation == Operation::Create {
                        201
                    } else {
                        200
                    },
                    body,
                )
                .await
                .unwrap_err();
                assert_eq!(error.code, "invalid-response");
                assert_eq!(error.outcome, "unknown");
            }
        }
        let error = roundtrip(Operation::Discover, 200, json!({}))
            .await
            .unwrap_err();
        assert_eq!(error.outcome, "not-applicable");
    }

    #[tokio::test]
    async fn only_exact_validated_required401_marks_credential_cleanup_safe() {
        let body = |code, outcome| {
            json!({"desktopRoom":{"version":PROTOCOL_VERSION,"viewerUserId":null},
            "error":{"code":code,"message":"synthetic server text must not escape","outcome":outcome}})
        };
        let valid = body("ROOM_AUTHENTICATION_REQUIRED", "not-applied");
        let error = roundtrip(Operation::Join, 401, valid.clone())
            .await
            .unwrap_err();
        assert_eq!(error.code, "not-authenticated");
        assert_eq!(error.outcome, "not-applied");
        let denied = roundtrip(
            Operation::Join,
            403,
            body("ROOM_AUTHENTICATION_DENIED", "not-applied"),
        )
        .await
        .unwrap_err();
        assert_eq!(denied.code, "service-rejected");
        for (status, body) in [
            (200, valid.clone()),
            (403, valid),
            (401, body("ROOM_AUTHENTICATION_REQUIRED", "unknown")),
        ] {
            let error = roundtrip(Operation::Join, status, body).await.unwrap_err();
            assert_eq!(error.code, "invalid-response");
            assert_eq!(error.outcome, "unknown");
        }
    }

    #[tokio::test]
    async fn redirects_and_oversize_never_retry_and_preserve_unknown() {
        let redirected = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let location = format!(
            "Location: http://{}/credential-leak\r\n",
            redirected.local_addr().unwrap()
        );
        let (client, task) = server(307, Vec::new(), &location).await;
        let error = client
            .execute(
                &input(Operation::Join),
                42,
                "session=private",
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!((error.code, error.outcome), ("invalid-response", "unknown"));
        task.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(50), redirected.accept())
                .await
                .is_err()
        );
        for operation in [Operation::Discover, Operation::Create] {
            let (client, task) = server(200, vec![b' '; MAX_RESPONSE_BYTES + 1], "").await;
            let error = client
                .execute(
                    &input(operation),
                    42,
                    "session=private",
                    &CancellationToken::new(),
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, "response-too-large");
            assert_eq!(
                error.outcome,
                if operation.is_post() {
                    "unknown"
                } else {
                    "not-applicable"
                }
            );
            task.await.unwrap();
        }
    }

    #[tokio::test]
    async fn chunked_response_counts_actual_bytes_and_network_loss_does_not_retry() {
        for chunked in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let client = RoomHttp::loopback(listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                read_request(&mut stream).await;
                if chunked {
                    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
                    let bytes = vec![b' '; MAX_RESPONSE_BYTES + 1];
                    let _ = stream
                        .write_all(format!("{:X}\r\n", bytes.len()).as_bytes())
                        .await;
                    let _ = stream.write_all(&bytes).await;
                    let _ = stream.write_all(b"\r\n0\r\n\r\n").await;
                }
                drop(stream);
                assert!(
                    tokio::time::timeout(Duration::from_millis(100), listener.accept())
                        .await
                        .is_err()
                );
            });
            let error = client
                .execute(
                    &input(Operation::Join),
                    42,
                    "session=private",
                    &CancellationToken::new(),
                )
                .await
                .unwrap_err();
            assert_eq!(error.outcome, "unknown");
            assert_eq!(
                error.code,
                if chunked {
                    "response-too-large"
                } else {
                    "network-error"
                }
            );
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn cancellation_interrupts_inflight_http_and_predispatch_cancel_sends_nothing() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = RoomHttp::loopback(listener.local_addr().unwrap());
        let cancel = CancellationToken::new();
        cancel.cancel();
        let error = client
            .execute(&input(Operation::Join), 42, "session=private", &cancel)
            .await
            .unwrap_err();
        assert_eq!(
            (error.code, error.outcome),
            ("scope-changed", "not-applied")
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
        let cancel = CancellationToken::new();
        let server_cancel = cancel.clone();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_request(&mut stream).await;
            server_cancel.cancel();
            let mut byte = [0];
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(2), stream.read(&mut byte))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
        });
        let error = client
            .execute(&input(Operation::Join), 42, "session=private", &cancel)
            .await
            .unwrap_err();
        assert_eq!((error.code, error.outcome), ("scope-changed", "unknown"));
        server.await.unwrap();
    }
}
