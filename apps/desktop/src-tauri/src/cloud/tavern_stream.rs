//! Tavern-only opt-in transport. Legacy Hosted SSE keeps its permissive parser.
use super::*;
use futures_util::StreamExt;

const COMPLETION_HEADER: &str = "x-mahoshojo-tavern-completion";
const COMPLETION_VERSION: &str = "v1";

// Keep the protocol-NACK policy explicit: reqwest's default can replay a POST.
pub(super) fn client_builder() -> reqwest::ClientBuilder {
    cloud_client_builder().retry(reqwest::retry::never())
}

fn before_dispatch_cancelled() -> CloudError {
    CloudError::new(
        CloudErrorCode::CancelledBeforeDispatch,
        "已取消，生成请求尚未发送",
    )
}

fn emit(sink: &dyn HostedEventSink, event: HostedSseEvent) -> Result<(), CloudError> {
    sink.send(event)
        .map_err(|_| CloudError::invalid_response("Tavern 事件通道已关闭"))
}

fn fail(sink: &dyn HostedEventSink, message: &str, code: &str) -> Result<(), CloudError> {
    emit(sink, hosted_error_event(message, code))
}

fn has_version(response: &reqwest::Response) -> bool {
    let mut versions = response.headers().get_all(COMPLETION_HEADER).iter();
    versions
        .next()
        .is_some_and(|value| value == COMPLETION_VERSION)
        && versions.next().is_none()
}

fn valid_capability(value: &serde_json::Value) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == 2
            && value["protocol"] == "tavern-completion"
            && value["version"].as_f64() == Some(1.0)
    })
}

async fn probe(state: &CloudState, http: &reqwest::Client) -> Result<(), CloudError> {
    // No business body, provider key, or session cookie belongs in this capability probe.
    let response = base_request(
        http,
        reqwest::Method::GET,
        &state.origin,
        HOSTED_TAVERN_CONVERT_STREAM_PATH,
    )
    .header(COMPLETION_HEADER, COMPLETION_VERSION)
    .timeout(SHORT_REQUEST_TIMEOUT)
    .send()
    .await
    .map_err(|_| {
        CloudError::new(
            CloudErrorCode::ServerUnavailable,
            "Tavern 流式能力探测不可达",
        )
    })?;
    if !response.status().is_success() {
        return Err(CloudError::new(
            CloudErrorCode::ServerUnavailable,
            "Tavern 流式能力暂不可用",
        ));
    }
    if !has_version(&response) {
        return Err(CloudError::new(
            CloudErrorCode::ProtocolMismatch,
            "服务器未确认 Tavern v1 流式协议",
        ));
    }
    let value = read_bounded_json(response, "Tavern 能力探测", HOSTED_ERROR_BODY_MAX_BYTES)
        .await
        .map_err(|error| {
            CloudError::new(
                if error.code == CloudErrorCode::NetworkError {
                    CloudErrorCode::ServerUnavailable
                } else {
                    CloudErrorCode::ProtocolMismatch
                },
                "Tavern 流式能力响应无效",
            )
        })?;
    if !valid_capability(&value) {
        return Err(CloudError::new(
            CloudErrorCode::ProtocolMismatch,
            "Tavern 流式能力响应不兼容",
        ));
    }
    Ok(())
}

fn positive_seconds(value: &serde_json::Value) -> Option<u32> {
    let seconds = match value {
        serde_json::Value::String(value) => integer_seconds(value)?,
        serde_json::Value::Number(value) => u32::try_from(value.as_u64()?).ok()?,
        _ => return None,
    };
    (seconds > 0).then_some(seconds)
}

fn integer_seconds(value: &str) -> Option<u32> {
    let value = value.trim();
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse::<u32>().ok().filter(|seconds| *seconds > 0)
}

fn retry_seconds(body: Option<&serde_json::Value>, header: Option<u32>) -> Option<u32> {
    body.and_then(|body| {
        body.get("retryAfterSeconds")
            .filter(|value| !value.is_null())
            .or_else(|| body.get("retryAfter"))
    })
    .and_then(positive_seconds)
    .or(header)
}

fn server_error(data: &serde_json::Value, is_byok: bool) -> HostedSseEvent {
    let message = if is_byok {
        "供应商生成失败，请检查凭据、模型或稍后重试"
    } else {
        data.get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("服务器生成失败，请稍后重试")
    };
    // A server-supplied code can never masquerade as a Native preparation rejection.
    hosted_error_event(message, "server-rejected")
}

fn valid_done(value: &serde_json::Value) -> bool {
    let Some(done) = value.as_object() else {
        return false;
    };
    let Some(completion) = value
        .get("tavernCompletion")
        .and_then(serde_json::Value::as_object)
    else {
        return false;
    };
    done.len() == 2
        && value["ok"] == true
        && completion.len() == 2
        && completion
            .get("version")
            .and_then(serde_json::Value::as_f64)
            == Some(1.0)
        && completion.get("finishReason").is_some_and(|reason| {
            reason.is_null()
                || matches!(
                    reason.as_str(),
                    Some(
                        "stop"
                            | "length"
                            | "content-filter"
                            | "tool-calls"
                            | "error"
                            | "other"
                            | "unknown"
                    )
                )
        })
}

/// Buffer bytes only until the next frame. Decode/dispatch each frame before looking at the
/// following one, so a valid prefix survives bad UTF-8/JSON and a terminal ignores all tail bytes.
#[derive(Default)]
struct Parser {
    buffer: Vec<u8>,
}

impl Parser {
    fn push(
        &mut self,
        bytes: &[u8],
        sink: &dyn HostedEventSink,
        is_byok: bool,
        token: &CancellationToken,
    ) -> Result<bool, StreamFailure> {
        for byte in bytes {
            self.buffer.push(*byte);
            let delimiter = if self.buffer.ends_with(b"\n\n") {
                2
            } else if self.buffer.ends_with(b"\r\n\r\n") {
                4
            } else {
                0
            };
            if delimiter == 0 {
                if self.buffer.len() > HOSTED_SSE_MAX_BUFFER_BYTES {
                    return Err(StreamFailure::Protocol("生成流缓冲超出大小上限"));
                }
                continue;
            }
            if token.is_cancelled() {
                return Err(StreamFailure::Cancelled);
            }
            let end = self.buffer.len() - delimiter;
            if end > HOSTED_SSE_MAX_FRAME_BYTES {
                return Err(StreamFailure::Protocol("生成流单帧超出大小上限"));
            }
            let frame = std::str::from_utf8(&self.buffer[..end])
                .map_err(|_| StreamFailure::Protocol("流包含非法 UTF-8"))?;
            let mut name = None;
            let mut data = Vec::new();
            for line in frame.lines() {
                if let Some(value) = line.strip_prefix("event:") {
                    name = Some(value.trim());
                } else if let Some(value) = line.strip_prefix("data:") {
                    data.push(value.trim_start());
                }
            }
            if let Some(name) = name.filter(|name| HOSTED_EVENT_NAMES.contains(name)) {
                let value: serde_json::Value = serde_json::from_str(&data.join("\n"))
                    .map_err(|_| StreamFailure::Protocol("生成流事件不是合法 JSON"))?;
                if name == "markdown"
                    && !value
                        .as_object()
                        .is_some_and(|object| object.len() == 1 && value["chunk"].is_string())
                {
                    return Err(StreamFailure::Protocol("Tavern 正文事件无效"));
                }
                if name == "done" && !valid_done(&value) {
                    return Err(StreamFailure::Protocol("Tavern 完成证据无效"));
                }
                let event = if name == "error" {
                    server_error(&value, is_byok)
                } else {
                    HostedSseEvent {
                        event: name.to_string(),
                        data: value,
                    }
                };
                let terminal = is_hosted_terminal_event(&event);
                if token.is_cancelled() {
                    return Err(StreamFailure::Cancelled);
                }
                emit(sink, event).map_err(StreamFailure::Sink)?;
                self.buffer.clear();
                if terminal {
                    return Ok(true);
                }
            } else {
                self.buffer.clear();
            }
        }
        Ok(false)
    }
}

enum StreamFailure {
    Cancelled,
    Protocol(&'static str),
    Sink(CloudError),
}

pub(super) async fn stream(
    state: &CloudState,
    secrets: &dyn SecretStore,
    registry: &crate::ai::RequestRegistry,
    request: CloudHostedGenerateRequest,
    sink: &dyn HostedEventSink,
) -> Result<(), CloudError> {
    let token = registry
        .register(&request.request_id)
        .map_err(|_| invalid_request("requestId 已在执行中"))?;
    let outcome = async {
        let (body, session) = tokio::select! {
            biased;
            _ = token.cancelled() => return Err(before_dispatch_cancelled()),
            prepared = prepare_hosted_dispatch(state, secrets, &request, HOSTED_STREAM_ROUTES) => prepared?,
        };
        let http = client_builder().build().map_err(|_| CloudError::new(
            CloudErrorCode::ServerUnavailable, "Tavern 传输客户端初始化失败，生成请求尚未发送",
        ))?;
        tokio::select! {
            biased;
            _ = token.cancelled() => return Err(before_dispatch_cancelled()),
            result = probe(state, &http) => result?,
        }
        let serialized = serde_json::to_vec(&body).map_err(|_| invalid_request("生成请求序列化失败"))?;
        if token.is_cancelled() { return Err(before_dispatch_cancelled()); }
        let path = format!("{HOSTED_TAVERN_CONVERT_STREAM_PATH}?format=sse");
        let builder = match &session {
            Some(session) => authed_request(&http, reqwest::Method::POST, &state.origin, &path, session),
            None => base_request(&http, reqwest::Method::POST, &state.origin, &path),
        }.header(COMPLETION_HEADER, COMPLETION_VERSION)
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(serialized);
        // From construction/polling of send onward, only events describe dispatch failures.
        let response = tokio::select! {
            biased;
            _ = token.cancelled() => return fail(sink, "已取消", "cancelled"),
            response = builder.send() => match response {
                Ok(response) => response,
                Err(_) => return fail(sink, "生成请求发送失败", "network-error"),
            },
        };
        let status = response.status();
        let version_ok = has_version(&response);
        let sse = response.headers().get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()).and_then(|value| value.split(';').next())
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/event-stream"));
        let retry_header = (status.as_u16() == 429).then(|| response.headers().get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok()).and_then(integer_seconds)).flatten();
        if !version_ok || !status.is_success() || !sse {
            let is_byok = request.preset_config.is_some();
            let body = if !version_ok || is_byok || status.is_success() { None } else {
                let text = tokio::select! {
                    biased;
                    _ = token.cancelled() => return fail(sink, "已取消", "cancelled"),
                    text = read_bounded_text(response, HOSTED_ERROR_BODY_MAX_BYTES) => text,
                };
                serde_json::from_str::<serde_json::Value>(&text).ok()
            };
            let code = if !version_ok || status.is_success() { "invalid-response" }
                else if status.as_u16() == 429 { "rate-limited" } else { "server-rejected" };
            let message = if !version_ok { "服务器未确认 Tavern v1 流式协议" }
                else if status.is_success() { "服务器未返回 Tavern SSE 流" }
                else if is_byok { "供应商生成失败，请检查凭据、模型或稍后重试" }
                else { body.as_ref().and_then(|body| body.get("error")).and_then(serde_json::Value::as_str)
                    .unwrap_or("生成服务拒绝请求") };
            let mut event = hosted_error_event(message, code);
            if status.as_u16() == 429 {
                if let Some(seconds) = retry_seconds(body.as_ref(), retry_header) {
                    event.data["retryAfterSeconds"] = serde_json::json!(seconds);
                }
            }
            return emit(sink, event);
        }
        let mut parser = Parser::default();
        let mut stream = response.bytes_stream();
        loop {
            let next = tokio::select! {
                biased;
                _ = token.cancelled() => return fail(sink, "已取消", "cancelled"),
                next = stream.next() => next,
            };
            let chunk = match next {
                Some(Ok(chunk)) => chunk,
                Some(Err(_)) => return fail(sink, "生成流读取中断", "network-error"),
                None => return fail(sink, "生成流未送达完整终态事件", "invalid-response"),
            };
            match parser.push(&chunk, sink, request.preset_config.is_some(), &token) {
                Ok(true) => return Ok(()),
                Ok(false) => {},
                Err(StreamFailure::Protocol(message)) => return fail(sink, message, "invalid-response"),
                Err(StreamFailure::Sink(error)) => return Err(error),
                Err(StreamFailure::Cancelled) => return fail(sink, "已取消", "cancelled"),
            }
        }
    }.await;
    registry.finish(&request.request_id);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Sink {
        events: Mutex<Vec<HostedSseEvent>>,
        cancel_on_markdown: Option<CancellationToken>,
    }
    impl HostedEventSink for Sink {
        fn send(&self, event: HostedSseEvent) -> Result<(), ()> {
            let markdown = event.event == "markdown";
            self.events.lock().unwrap().push(event);
            if markdown {
                if let Some(token) = &self.cancel_on_markdown {
                    token.cancel();
                }
            }
            Ok(())
        }
    }
    const MARKDOWN: &[u8] = b"event: markdown\ndata: {\"chunk\":\"prefix\"}\n\n";
    const DONE: &[u8] = b"event: done\ndata: {\"ok\":true,\"tavernCompletion\":{\"version\":1,\"finishReason\":\"stop\"}}\n\n";

    #[test]
    fn one_push_preserves_prefix_and_stops_at_the_first_terminal() {
        for tail in [
            b"event: markdown\ndata: {bad}\n\n".as_slice(),
            b"event: markdown\ndata: \xff\n\n".as_slice(),
        ] {
            let sink = Sink::default();
            assert!(matches!(
                Parser::default().push(
                    &[MARKDOWN, tail].concat(),
                    &sink,
                    false,
                    &CancellationToken::new()
                ),
                Err(StreamFailure::Protocol(_))
            ));
            assert_eq!(sink.events.lock().unwrap().len(), 1);
            assert_eq!(sink.events.lock().unwrap()[0].event, "markdown");
            let sink = Sink::default();
            assert!(matches!(
                Parser::default().push(
                    &[DONE, tail].concat(),
                    &sink,
                    false,
                    &CancellationToken::new()
                ),
                Ok(true)
            ));
            assert_eq!(sink.events.lock().unwrap().len(), 1);
            assert_eq!(sink.events.lock().unwrap()[0].event, "done");
        }
    }

    #[test]
    fn one_push_cancellation_after_markdown_cannot_emit_done() {
        let token = CancellationToken::new();
        let sink = Sink {
            cancel_on_markdown: Some(token.clone()),
            ..Sink::default()
        };
        assert!(matches!(
            Parser::default().push(&[MARKDOWN, DONE].concat(), &sink, false, &token),
            Err(StreamFailure::Cancelled)
        ));
        assert_eq!(sink.events.lock().unwrap().len(), 1);
        assert_eq!(sink.events.lock().unwrap()[0].event, "markdown");
    }
}
