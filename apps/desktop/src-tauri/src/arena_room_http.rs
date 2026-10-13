//! Fixed Native Room HTTP transport. Credentials and raw transport failures stay native.
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{header, Client, Method};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::arena_room_protocol::{
    self as protocol, Operation, RoomError, EXPECTED_USER_ID_HEADER, MAX_REQUEST_BYTES,
    MAX_RESPONSE_BYTES, PROTOCOL_HEADER, PROTOCOL_VERSION,
};

const HTTP_DEADLINE: Duration = Duration::from_secs(15);
const MAX_RESPONSE_HEADERS: usize = 16 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

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
    pub request: Value,
    pub resume_only: bool,
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
            let envelope = json!({"desktopRoom":metadata,"request":input.request});
            // The protocol checks original compact bytes before any trim/default projection.
            let validated = protocol::validate_service_request(operation, &envelope, owner)?;
            let bytes = serde_json::to_vec(&validated).map_err(|_| invalid())?;
            if bytes.len() > MAX_REQUEST_BYTES {
                return Err(invalid());
            }
            request = request
                .header(header::CONTENT_TYPE, "application/json")
                .body(bytes);
        } else if operation != Operation::Discover
            && input
                .request
                .as_object()
                .is_none_or(|object| !object.is_empty())
        {
            return Err(invalid());
        }
        request.build().map_err(|_| invalid())
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
        let invalid = || RoomError::new("invalid-response", outcome);
        let response = self
            .client
            .execute(request)
            .await
            .map_err(|_| RoomError::new("network-error", outcome))?;
        let status = response.status().as_u16();
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
        if let Some(error) = response.get("error") {
            let code = error["code"].as_str().ok_or_else(invalid)?;
            let declared_outcome = error["outcome"].as_str().ok_or_else(invalid)?;
            let authentication = status == 401 && code == "ROOM_AUTHENTICATION_REQUIRED";
            let cleanup_safe = authentication
                && response["desktopRoom"]["viewerUserId"].is_null()
                && declared_outcome
                    == if operation.is_post() {
                        "not-applied"
                    } else {
                        "not-applicable"
                    };
            return Err(RoomError::new(
                if cleanup_safe {
                    "not-authenticated"
                } else {
                    "service-rejected"
                },
                declared_outcome,
            )
            .with_server_code(code));
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn fixture(operation: Operation, field: &str) -> Value {
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
