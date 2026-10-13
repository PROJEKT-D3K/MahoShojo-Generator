//! Ticket-only WSS transport: fixed origin, platform TLS, bounded frames, no renderer send.
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use rustls::pki_types::ServerName;
use rustls_platform_verifier::BuilderVerifierExt;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    error::{Error as WebSocketError, ProtocolError},
    http::{header, Request},
    protocol::{frame::coding::CloseCode, Message, WebSocketConfig},
};
use tokio_tungstenite::{client_async_with_config, WebSocketStream};
use tokio_util::sync::CancellationToken;

use crate::arena_room_http::{caller_origin, service_origin};
use crate::arena_room_protocol::{
    parse_server_message, RoomError, RoomTicket, MAX_TICKET_BYTES, MAX_WEBSOCKET_BYTES,
    PRESENCE_PROTOCOL, WEBSOCKET_PATH,
};

const CONNECT_DEADLINE: Duration = Duration::from_secs(10);
const FLUSH_DEADLINE: Duration = Duration::from_secs(2);
const CLOSE_DEADLINE: Duration = Duration::from_millis(100);
const READ_BUFFER_BYTES: usize = 4096;
const WRITE_BUFFER_BYTES: usize = 1024;

type MessageResult = Result<Option<Value>, RoomError>;
enum Demand {
    Next(oneshot::Sender<MessageResult>),
    Resync(oneshot::Sender<Result<(), RoomError>>),
}
trait TransportStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> TransportStream for T {}
type Stream = Box<dyn TransportStream>;

/// No raw stream or URL is exposed. The driver owns the connection, including when
/// nobody is polling `next`, so cancellation can always revoke an idle socket.
pub(crate) struct RoomSocket {
    demand: mpsc::Sender<Demand>,
    cancel: CancellationToken,
    driver: Option<tokio::task::JoinHandle<()>>,
    ended: bool,
}
impl Drop for RoomSocket {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

impl RoomSocket {
    pub(crate) async fn connect(
        ticket: RoomTicket,
        received_at: Instant,
        cancel: CancellationToken,
    ) -> Result<Self, RoomError> {
        let deadline = ticket_deadline(&ticket, received_at)?;
        let request = handshake_request(&ticket)?;
        let origin = service_origin()?;
        let host = origin.host_str().ok_or_else(internal)?.to_owned();
        let port = origin.port_or_known_default().ok_or_else(internal)?;
        let tls = tls_config()?;
        let connect = async {
            // TcpStream::connect resolves the fixed host; the outer deadline includes DNS.
            // No connect_async means no proxy/environment TLS or redirect path exists.
            let tcp = TcpStream::connect((host.as_str(), port))
                .await
                .map_err(|_| network())?;
            tcp.set_nodelay(true).map_err(|_| network())?;
            let name = ServerName::try_from(host).map_err(|_| internal())?;
            let stream = tokio_rustls::TlsConnector::from(Arc::new(tls))
                .connect(name, tcp)
                .await
                .map_err(|_| network())?;
            let selected = stream.get_ref().1.alpn_protocol();
            if selected.is_some_and(|protocol| protocol != b"http/1.1") {
                return Err(invalid());
            }
            handshake(Box::new(stream), request).await
        };
        let socket = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(stale()),
            result = tokio::time::timeout_at(deadline, connect) => result.map_err(|_| network())??,
        };
        if cancel.is_cancelled() {
            return Err(stale());
        }
        Ok(Self::drive(socket, cancel))
    }

    fn drive(socket: WebSocketStream<Stream>, cancel: CancellationToken) -> Self {
        let cancel = cancel.child_token();
        let (sender, receiver) = mpsc::channel(1);
        let driver = tokio::spawn(driver(socket, receiver, cancel.clone()));
        Self {
            demand: sender,
            cancel,
            driver: Some(driver),
            ended: false,
        }
    }

    pub(crate) async fn next(&mut self) -> MessageResult {
        if self.ended {
            return Ok(None);
        }
        let (sender, receiver) = oneshot::channel();
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => { self.ended = true; return Err(stale()); },
            result = self.demand.send(Demand::Next(sender)) => if result.is_err() {
                self.ended = true;
                return Ok(None);
            },
        }
        let result = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err(stale()),
            result = receiver => result.unwrap_or_else(|_| Err(network())),
        };
        if !matches!(&result, Ok(Some(_))) {
            self.ended = true;
        }
        result
    }

    /// This one fixed control frame requests a fresh snapshot and presence. There is
    /// no caller-supplied payload and no renderer-accessible arbitrary WebSocket send.
    pub(crate) async fn request_resync(&mut self) -> Result<(), RoomError> {
        if self.ended {
            return Err(network());
        }
        let (sender, receiver) = oneshot::channel();
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err(stale()),
            result = self.demand.send(Demand::Resync(sender)) => result.map_err(|_| network())?,
        }
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err(stale()),
            result = receiver => result.unwrap_or_else(|_| Err(network())),
        }
    }

    /// Keep the parent's socket-task permit until this has joined the real driver.
    pub(crate) async fn shutdown(mut self) {
        self.cancel.cancel();
        if let Some(driver) = self.driver.take() {
            let _ = driver.await;
        }
    }

    // Inject only an already connected test stream. The actual production path above
    // always constructs verified TLS and has no flag that could disable it.
    #[cfg(test)]
    pub(crate) async fn from_test_stream<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
        stream: S,
        ticket: RoomTicket,
        received_at: Instant,
        cancel: CancellationToken,
    ) -> Result<Self, RoomError> {
        let deadline = ticket_deadline(&ticket, received_at)?;
        let request = handshake_request(&ticket)?;
        let socket = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(stale()),
            result = tokio::time::timeout_at(deadline, handshake(Box::new(stream), request)) => {
                result.map_err(|_| network())??
            }
        };
        if cancel.is_cancelled() {
            return Err(stale());
        }
        Ok(Self::drive(socket, cancel))
    }
}

fn internal() -> RoomError {
    RoomError::new("internal-error", "not-applicable")
}
fn invalid() -> RoomError {
    RoomError::new("invalid-response", "not-applicable")
}
fn network() -> RoomError {
    RoomError::new("network-error", "not-applicable")
}
fn stale() -> RoomError {
    RoomError::new("scope-changed", "not-applicable")
}

fn tls_config() -> Result<rustls::ClientConfig, RoomError> {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let mut tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| internal())?
        .with_platform_verifier()
        .map_err(|_| internal())?
        .with_no_client_auth();
    tls.key_log = Arc::new(rustls::NoKeyLog {});
    tls.enable_early_data = false;
    tls.enable_secret_extraction = false;
    tls.enable_sni = true;
    tls.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(tls)
}

fn ticket_deadline(ticket: &RoomTicket, received_at: Instant) -> Result<Instant, RoomError> {
    let now = Instant::now();
    if ticket.token.is_empty()
        || ticket.token.len() > MAX_TICKET_BYTES
        || !(1..=60).contains(&ticket.expires_in_seconds)
        || received_at > now
    {
        return Err(RoomError::new("invalid-response", "not-applicable"));
    }
    let expiry = received_at + Duration::from_secs(ticket.expires_in_seconds);
    if expiry <= now {
        return Err(RoomError::new("service-rejected", "not-applicable"));
    }
    Ok(expiry.min(now + CONNECT_DEADLINE))
}

fn handshake_request(ticket: &RoomTicket) -> Result<Request<()>, RoomError> {
    let mut url = service_origin()?;
    url.set_scheme("wss").map_err(|_| internal())?;
    url.set_path(WEBSOCKET_PATH);
    url.query_pairs_mut().append_pair("ticket", &ticket.token);
    let mut request = url.as_str().into_client_request().map_err(|_| internal())?;
    request.headers_mut().insert(
        header::ORIGIN,
        caller_origin()?.parse().map_err(|_| internal())?,
    );
    request.headers_mut().insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        PRESENCE_PROTOCOL.parse().map_err(|_| internal())?,
    );
    Ok(request)
}
fn websocket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .read_buffer_size(READ_BUFFER_BYTES)
        .write_buffer_size(0)
        .max_write_buffer_size(WRITE_BUFFER_BYTES)
        .max_frame_size(Some(MAX_WEBSOCKET_BYTES))
        .max_message_size(Some(MAX_WEBSOCKET_BYTES))
        .accept_unmasked_frames(false)
}
async fn handshake(
    stream: Stream,
    request: Request<()>,
) -> Result<WebSocketStream<Stream>, RoomError> {
    let (socket, response) = client_async_with_config(request, stream, Some(websocket_config()))
        .await
        .map_err(map_socket_error)?;
    let protocols = response.headers().get_all(header::SEC_WEBSOCKET_PROTOCOL);
    if response
        .headers()
        .contains_key(header::SEC_WEBSOCKET_EXTENSIONS)
    {
        return Err(invalid());
    }
    if protocols.iter().count() != 1
        || protocols
            .iter()
            .next()
            .is_none_or(|value| value.as_bytes() != PRESENCE_PROTOCOL.as_bytes())
    {
        return Err(RoomError::new("presence-unsupported", "not-applicable"));
    }
    Ok(socket)
}
fn map_socket_error(error: WebSocketError) -> RoomError {
    match error {
        WebSocketError::Protocol(ProtocolError::SecWebSocketSubProtocolError(_)) => {
            RoomError::new("presence-unsupported", "not-applicable")
        }
        WebSocketError::Capacity(_) => RoomError::new("response-too-large", "not-applicable"),
        WebSocketError::Protocol(_) | WebSocketError::Utf8(_) | WebSocketError::AttackAttempt => {
            invalid()
        }
        // Http may own a response body, HttpFormat may own input, and Io may carry a URL.
        // None is formatted, logged, attached as a source, or copied across IPC.
        _ => network(),
    }
}
async fn close(socket: &mut WebSocketStream<Stream>) {
    let _ = tokio::time::timeout(CLOSE_DEADLINE, socket.close(None)).await;
}
async fn driver(
    mut socket: WebSocketStream<Stream>,
    mut demands: mpsc::Receiver<Demand>,
    cancel: CancellationToken,
) {
    loop {
        let demand = tokio::select! {
            biased;
            _ = cancel.cancelled() => { close(&mut socket).await; return; },
            demand = demands.recv() => match demand {
                Some(demand) => demand,
                None => { close(&mut socket).await; return; },
            },
        };
        match demand {
            Demand::Next(reply) => {
                let result = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => Err(stale()),
                    result = read_message(&mut socket) => result,
                };
                let terminal = !matches!(&result, Ok(Some(_)));
                if reply.send(result).is_err() || terminal {
                    close(&mut socket).await;
                    return;
                }
            }
            Demand::Resync(reply) => {
                let result = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => Err(stale()),
                    result = tokio::time::timeout(FLUSH_DEADLINE, socket.send(Message::Text(
                        r#"{"protocolVersion":1,"type":"room.resync.request"}"#.into(),
                    ))) => result.map_err(|_| network()).and_then(|value| value.map_err(map_socket_error)),
                };
                let terminal = result.is_err();
                if reply.send(result).is_err() || terminal {
                    close(&mut socket).await;
                    return;
                }
            }
        }
    }
}
async fn read_message(socket: &mut WebSocketStream<Stream>) -> MessageResult {
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => {
                return parse_server_message(text.as_bytes()).map(Some)
            }
            Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {
                // Tungstenite queues automatic Pong; flush it without waiting for another frame.
                tokio::time::timeout(FLUSH_DEADLINE, socket.flush())
                    .await
                    .map_err(|_| network())?
                    .map_err(map_socket_error)?;
            }
            Some(Ok(Message::Close(frame))) => {
                let code = frame.map(|frame| frame.code);
                // Never expose or log the peer's freely supplied close reason.
                let _ = tokio::time::timeout(CLOSE_DEADLINE, socket.flush()).await;
                return match code {
                    None | Some(CloseCode::Normal | CloseCode::Away) => Ok(None),
                    Some(CloseCode::Size) => {
                        Err(RoomError::new("response-too-large", "not-applicable"))
                    }
                    Some(CloseCode::Policy) => {
                        Err(RoomError::new("service-rejected", "not-applicable"))
                    }
                    _ => Err(network()),
                };
            }
            Some(Ok(Message::Binary(_))) | Some(Ok(Message::Frame(_))) => return Err(invalid()),
            Some(Err(error)) => return Err(map_socket_error(error)),
            None => return Err(network()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_hdr_async;
    use tokio_tungstenite::tungstenite::{
        handshake::server::{Request as ServerRequest, Response as ServerResponse},
        protocol::{
            frame::{
                coding::{Data, OpCode},
                Frame,
            },
            CloseFrame,
        },
    };

    const TICKET_CANARY: &str = "ROOM_SECRET_TICKET_CANARY_8b1281";
    const FRAME_CANARY: &str = "ROOM_PRIVATE_FRAME_CANARY_116a93";
    const CLOSE_CANARY: &str = "ROOM_PRIVATE_CLOSE_CANARY_c1a9d7";
    fn ticket() -> RoomTicket {
        RoomTicket {
            token: TICKET_CANARY.into(),
            expires_in_seconds: 60,
        }
    }
    fn presence() -> Value {
        json!({"protocolVersion":1,"type":"room.presence","roomId":"room-test","roomEpoch":"epoch-test","onlineUserIds":[FRAME_CANARY]})
    }
    struct TestHandshake {
        protocol: Option<&'static str>,
        extension: Option<&'static str>,
    }
    // The upstream trait fixes ErrorResponse; a named implementation keeps that
    // exact signature without relaxing Clippy for unrelated Result values.
    impl tokio_tungstenite::tungstenite::handshake::server::Callback for TestHandshake {
        fn on_request(
            self,
            request: &ServerRequest,
            mut response: ServerResponse,
        ) -> Result<ServerResponse, tokio_tungstenite::tungstenite::handshake::server::ErrorResponse>
        {
            assert_eq!(request.uri().path(), WEBSOCKET_PATH);
            assert_eq!(request.headers()[header::ORIGIN], caller_origin().unwrap());
            assert_eq!(
                request.headers()[header::SEC_WEBSOCKET_PROTOCOL],
                PRESENCE_PROTOCOL
            );
            assert!(!request.headers().contains_key(header::COOKIE));
            assert!(!request
                .headers()
                .contains_key(header::SEC_WEBSOCKET_EXTENSIONS));
            assert_eq!(
                request.uri().query(),
                Some(format!("ticket={TICKET_CANARY}").as_str())
            );
            if let Some(protocol) = self.protocol {
                response
                    .headers_mut()
                    .insert(header::SEC_WEBSOCKET_PROTOCOL, protocol.parse().unwrap());
            }
            if let Some(extension) = self.extension {
                response
                    .headers_mut()
                    .insert(header::SEC_WEBSOCKET_EXTENSIONS, extension.parse().unwrap());
            }
            Ok(response)
        }
    }
    async fn pair(
        protocol: Option<&'static str>,
        extension: Option<&'static str>,
    ) -> (
        Result<RoomSocket, RoomError>,
        WebSocketStream<TcpStream>,
        CancellationToken,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let cancel = CancellationToken::new();
        let client = async {
            let stream = TcpStream::connect(address).await.unwrap();
            RoomSocket::from_test_stream(stream, ticket(), Instant::now(), cancel.clone()).await
        };
        let server = async {
            let (stream, _) = listener.accept().await.unwrap();
            accept_hdr_async(
                stream,
                TestHandshake {
                    protocol,
                    extension,
                },
            )
            .await
            .unwrap()
        };
        let (client, server) = tokio::join!(client, server);
        (client, server, cancel)
    }

    #[test]
    fn tls_and_buffers_are_explicitly_hardened() {
        let tls = tls_config().unwrap();
        assert!(!tls.enable_early_data);
        assert!(!tls.enable_secret_extraction);
        assert!(tls.enable_sni);
        assert_eq!(tls.alpn_protocols, [b"http/1.1".to_vec()]);
        assert!(!tls.key_log.will_log("CLIENT_RANDOM"));
        let config = websocket_config();
        assert_eq!(config.max_message_size, Some(MAX_WEBSOCKET_BYTES));
        assert_eq!(config.max_frame_size, Some(MAX_WEBSOCKET_BYTES));
        assert_eq!(config.read_buffer_size, READ_BUFFER_BYTES);
        assert_eq!(config.write_buffer_size, 0);
        assert_eq!(config.max_write_buffer_size, WRITE_BUFFER_BYTES);
        assert!(!config.accept_unmasked_frames);
        let escaped = RoomTicket {
            token: "token +/?&秘密".into(),
            expires_in_seconds: 60,
        };
        let request = handshake_request(&escaped).unwrap();
        let url = url::Url::parse(&request.uri().to_string()).unwrap();
        assert_eq!(url.scheme(), "wss");
        assert_eq!(url.host_str(), service_origin().unwrap().host_str());
        assert_eq!(url.path(), WEBSOCKET_PATH);
        assert_eq!(
            url.query_pairs().into_owned().collect::<Vec<_>>(),
            [("ticket".to_owned(), escaped.token)]
        );
    }

    #[tokio::test]
    async fn exact_presence_protocol_required_and_any_extensions_header_rejected() {
        for selected in [None, Some("mahoshojo.arena-room.v1"), Some("unexpected")] {
            let (result, _server, _) = pair(selected, None).await;
            assert_eq!(result.err().unwrap().code, "presence-unsupported");
        }
        for extension in ["", "permessage-deflate"] {
            let (result, _server, _) = pair(Some(PRESENCE_PROTOCOL), Some(extension)).await;
            assert_eq!(result.err().unwrap().code, "invalid-response");
        }
    }

    #[tokio::test]
    async fn ping_is_flushed_before_waiting_for_following_application_frame() {
        let (client, mut server, _) = pair(Some(PRESENCE_PROTOCOL), None).await;
        let mut client = client.unwrap();
        let server = tokio::spawn(async move {
            server
                .send(Message::Ping(b"heartbeat".to_vec().into()))
                .await
                .unwrap();
            let reply = tokio::time::timeout(Duration::from_secs(2), server.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert!(matches!(reply, Message::Pong(bytes) if bytes.as_ref() == b"heartbeat"));
            server
                .send(Message::Text(presence().to_string().into()))
                .await
                .unwrap();
        });
        assert_eq!(client.next().await.unwrap(), Some(presence()));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn resync_has_one_fixed_payload_and_shutdown_joins_driver() {
        let (client, mut server, _) = pair(Some(PRESENCE_PROTOCOL), None).await;
        let mut client = client.unwrap();
        client.request_resync().await.unwrap();
        let message = tokio::time::timeout(Duration::from_secs(2), server.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let Message::Text(text) = message else {
            panic!("expected fixed resync frame")
        };
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap(),
            json!({"protocolVersion":1,"type":"room.resync.request"})
        );
        let driver = client.driver.as_ref().unwrap().abort_handle();
        tokio::time::timeout(Duration::from_secs(2), client.shutdown())
            .await
            .unwrap();
        assert!(driver.is_finished());
        assert!(matches!(
            server.next().await,
            Some(Ok(Message::Close(_))) | None
        ));
    }

    #[tokio::test]
    async fn cancellation_closes_idle_socket_without_any_next_poll_and_drop_also_revokes() {
        for by_drop in [false, true] {
            let (client, mut server, cancel) = pair(Some(PRESENCE_PROTOCOL), None).await;
            let client = client.unwrap();
            if by_drop {
                drop(client);
            } else {
                cancel.cancel();
            }
            let close = tokio::time::timeout(Duration::from_secs(2), server.next())
                .await
                .unwrap();
            assert!(matches!(close, Some(Ok(Message::Close(_))) | None));
        }
    }

    #[tokio::test]
    async fn cancellation_interrupts_pending_message_and_handshake() {
        let (client, _server, cancel) = pair(Some(PRESENCE_PROTOCOL), None).await;
        let mut client = client.unwrap();
        let task = tokio::spawn(async move { client.next().await });
        tokio::task::yield_now().await;
        cancel.cancel();
        assert_eq!(task.await.unwrap().unwrap_err().code, "scope-changed");

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let cancel = CancellationToken::new();
        let other = cancel.clone();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            assert!(stream.read(&mut bytes).await.unwrap() > 0);
            other.cancel();
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(2), stream.read(&mut bytes))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
        });
        let stream = TcpStream::connect(address).await.unwrap();
        let error = RoomSocket::from_test_stream(stream, ticket(), Instant::now(), cancel)
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, "scope-changed");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn ticket_deadline_does_not_restart_at_connect_and_covers_handshake() {
        let expired = RoomTicket {
            token: TICKET_CANARY.into(),
            expires_in_seconds: 1,
        };
        assert_eq!(
            ticket_deadline(&expired, Instant::now() - Duration::from_secs(2))
                .unwrap_err()
                .code,
            "service-rejected"
        );
        let received = Instant::now() - Duration::from_millis(900);
        let deadline = ticket_deadline(&expired, received).unwrap();
        assert_eq!(deadline, received + Duration::from_secs(1));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            assert!(stream.read(&mut bytes).await.unwrap() > 0);
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(2), stream.read(&mut bytes))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
        });
        let stream = TcpStream::connect(address).await.unwrap();
        let result =
            RoomSocket::from_test_stream(stream, expired, Instant::now(), CancellationToken::new())
                .await;
        assert_eq!(result.err().unwrap().code, "network-error");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn frame_and_fragment_aggregate_limits_apply_at_exact_wire_boundary() {
        for fragmented in [false, true] {
            for oversize in [false, true] {
                let (client, mut server, _) = pair(Some(PRESENCE_PROTOCOL), None).await;
                let mut client = client.unwrap();
                let mut bytes = presence().to_string().into_bytes();
                bytes.resize(MAX_WEBSOCKET_BYTES + usize::from(oversize), b' ');
                let server = tokio::spawn(async move {
                    if fragmented {
                        let rest = bytes.split_off(MAX_WEBSOCKET_BYTES / 2);
                        server
                            .send(Message::Frame(Frame::message(
                                bytes,
                                OpCode::Data(Data::Text),
                                false,
                            )))
                            .await
                            .unwrap();
                        server
                            .send(Message::Frame(Frame::message(
                                rest,
                                OpCode::Data(Data::Continue),
                                true,
                            )))
                            .await
                            .unwrap();
                    } else {
                        server
                            .send(Message::Text(String::from_utf8(bytes).unwrap().into()))
                            .await
                            .unwrap();
                    }
                });
                let result = client.next().await;
                if oversize {
                    assert_eq!(result.unwrap_err().code, "response-too-large");
                } else {
                    assert_eq!(result.unwrap(), Some(presence()));
                }
                server.await.unwrap();
            }
        }
    }

    #[tokio::test]
    async fn invalid_frames_and_close_reason_are_never_forwarded() {
        for message in [
            Message::Binary(vec![1, 2, 3].into()),
            Message::Text("{\"unexpected\":\"secret\"}".into()),
            Message::Frame(Frame::message(vec![0xff], OpCode::Data(Data::Text), true)),
        ] {
            let (client, mut server, _) = pair(Some(PRESENCE_PROTOCOL), None).await;
            let mut client = client.unwrap();
            server.send(message).await.unwrap();
            assert_eq!(client.next().await.unwrap_err().code, "invalid-response");
            assert!(client.next().await.unwrap().is_none());
        }
        let (client, mut server, _) = pair(Some(PRESENCE_PROTOCOL), None).await;
        let mut client = client.unwrap();
        server
            .send(Message::Close(Some(CloseFrame {
                code: CloseCode::Policy,
                reason: CLOSE_CANARY.into(),
            })))
            .await
            .unwrap();
        let error = client.next().await.unwrap_err();
        assert_eq!(error.code, "service-rejected");
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains(CLOSE_CANARY));
    }

    #[tokio::test]
    async fn handshake_redirect_and_peer_error_body_remain_fixed_local_errors() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let redirect = target.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            assert!(stream.read(&mut bytes).await.unwrap() > 0);
            stream.write_all(format!("HTTP/1.1 302 Found\r\nLocation: ws://{redirect}/leak?ticket={TICKET_CANARY}\r\nContent-Length: {}\r\n\r\n{CLOSE_CANARY}", CLOSE_CANARY.len()).as_bytes()).await.unwrap();
        });
        let stream = TcpStream::connect(address).await.unwrap();
        let error = RoomSocket::from_test_stream(
            stream,
            ticket(),
            Instant::now(),
            CancellationToken::new(),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error.code, "network-error");
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains(TICKET_CANARY));
        server.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(50), target.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn rejected_expired_or_replayed_ticket_is_not_retried() {
        for status in [401, 403, 409] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = [0; 4096];
                assert!(stream.read(&mut bytes).await.unwrap() > 0);
                stream.write_all(format!("HTTP/1.1 {status} Rejected\r\nContent-Length: {}\r\n\r\n{TICKET_CANARY}", TICKET_CANARY.len()).as_bytes()).await.unwrap();
                drop(stream);
                assert!(
                    tokio::time::timeout(Duration::from_millis(50), listener.accept())
                        .await
                        .is_err()
                );
            });
            let stream = TcpStream::connect(address).await.unwrap();
            let error = RoomSocket::from_test_stream(
                stream,
                ticket(),
                Instant::now(),
                CancellationToken::new(),
            )
            .await
            .err()
            .unwrap();
            assert_eq!(error.code, "network-error");
            assert!(!serde_json::to_string(&error)
                .unwrap()
                .contains(TICKET_CANARY));
            server.await.unwrap();
        }
    }

    struct Capture(Mutex<Vec<String>>);
    impl log::Log for Capture {
        fn enabled(&self, _: &log::Metadata<'_>) -> bool {
            true
        }
        fn log(&self, record: &log::Record<'_>) {
            self.0
                .lock()
                .unwrap()
                .push(format!("{} {}", record.target(), record.args()));
        }
        fn flush(&self) {}
    }
    static CAPTURE: Capture = Capture(Mutex::new(Vec::new()));

    // Execute this exact test independently in BOTH debug and release. It captures
    // the actual dependency handshake/frame/close paths with runtime Trace enabled;
    // merely formatting our own RoomError would not detect dependency log leakage.
    #[tokio::test]
    async fn synthetic_secret_log_canary_actual_handshake_frame_close() {
        assert!(log::STATIC_MAX_LEVEL <= log::LevelFilter::Info);
        log::set_logger(&CAPTURE).expect("the canary must own the test logger");
        let previous = log::max_level();
        log::set_max_level(log::LevelFilter::Trace);
        log::info!(target: "native_room_canary", "capture-live");
        let (client, mut server, _) = pair(Some(PRESENCE_PROTOCOL), None).await;
        let mut client = client.unwrap();
        client.request_resync().await.unwrap();
        assert!(matches!(server.next().await, Some(Ok(Message::Text(_)))));
        server
            .send(Message::Text(presence().to_string().into()))
            .await
            .unwrap();
        assert_eq!(client.next().await.unwrap(), Some(presence()));
        server
            .send(Message::Close(Some(CloseFrame {
                code: CloseCode::Policy,
                reason: CLOSE_CANARY.into(),
            })))
            .await
            .unwrap();
        let error = client.next().await.unwrap_err();
        let public = serde_json::to_string(&error).unwrap();
        log::set_max_level(previous);
        let records = CAPTURE.0.lock().unwrap().join("\n");
        assert!(records.contains("native_room_canary capture-live"));
        for secret in [TICKET_CANARY, FRAME_CANARY, CLOSE_CANARY] {
            assert!(
                !records.contains(secret),
                "transport dependency leaked a synthetic secret"
            );
            assert!(
                !public.contains(secret),
                "transport IPC leaked a synthetic secret"
            );
        }
    }
}
