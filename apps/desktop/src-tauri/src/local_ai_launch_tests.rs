use super::*;
use serde_json::{json, Value};
use std::{
    net::{SocketAddr, TcpListener as StdListener},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Condvar,
    },
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn request() -> RuntimeRequest {
    RuntimeRequest {
        contract_version: 1,
        runtime_id: RuntimeId::Ollama,
    }
}
fn start_request(snapshot: &LaunchSnapshot) -> LaunchRequest {
    LaunchRequest {
        contract_version: 1,
        runtime_id: RuntimeId::Ollama,
        operation_id: snapshot.operation_id.clone().unwrap(),
        installation_id: snapshot
            .installation
            .as_ref()
            .unwrap()
            .installation_id
            .clone(),
    }
}
fn operation(snapshot: &LaunchSnapshot) -> OperationRequest {
    OperationRequest {
        contract_version: 1,
        runtime_id: RuntimeId::Ollama,
        operation_id: snapshot.operation_id.clone().unwrap(),
    }
}
fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/local-ai-launch.json")).unwrap()
}
fn validate_snapshot(snapshot: &LaunchSnapshot) -> bool {
    use LaunchPhase::*;
    if snapshot.contract_version != 1 {
        return false;
    }
    if snapshot.state == Idle {
        return snapshot.operation_id.is_none()
            && snapshot.installation.is_none()
            && snapshot.service.is_none()
            && snapshot.error_code.is_none();
    }
    if !snapshot.operation_id.as_deref().is_some_and(valid_id) {
        return false;
    }
    if matches!(snapshot.state, Prepared | Starting | Ready) && snapshot.installation.is_none() {
        return false;
    }
    if matches!(snapshot.state, Preparing | Stopped | Cancelled | External)
        && snapshot.installation.is_some()
    {
        return false;
    }
    if snapshot
        .installation
        .as_ref()
        .is_some_and(|i| i.product != "Ollama" || !valid_id(&i.installation_id))
    {
        return false;
    }
    if matches!(snapshot.state, Ready | External) != snapshot.service.is_some() {
        return false;
    }
    if (snapshot.state == Failed) != snapshot.error_code.is_some() {
        return false;
    }
    true
}
#[test]
fn same_ts_native_wire_fixture_and_injection_rejections() {
    let f = fixture();
    for v in f["runtimeRequests"].as_array().unwrap() {
        let parsed: RuntimeRequest = serde_json::from_value(v.clone()).unwrap();
        parsed.validate().unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), *v);
    }
    for v in f["startRequests"].as_array().unwrap() {
        let parsed: LaunchRequest = serde_json::from_value(v.clone()).unwrap();
        parsed.validate().unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), *v);
    }
    for v in f["operationRequests"].as_array().unwrap() {
        let parsed: OperationRequest = serde_json::from_value(v.clone()).unwrap();
        parsed.validate().unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), *v);
    }
    for v in f["snapshots"].as_array().unwrap() {
        let parsed: LaunchSnapshot = serde_json::from_value(v.clone()).unwrap();
        assert!(validate_snapshot(&parsed), "{v}");
        assert_eq!(serde_json::to_value(parsed).unwrap(), *v);
    }
    for v in f["invalidRuntimeRequests"].as_array().unwrap() {
        assert!(
            serde_json::from_value::<RuntimeRequest>(v.clone())
                .map_or(true, |r| r.validate().is_err()),
            "{v}"
        );
    }
    for v in f["invalidStartRequests"].as_array().unwrap() {
        assert!(
            serde_json::from_value::<LaunchRequest>(v.clone())
                .map_or(true, |r| r.validate().is_err()),
            "{v}"
        );
    }
    for v in f["invalidOperationRequests"].as_array().unwrap() {
        assert!(
            serde_json::from_value::<OperationRequest>(v.clone())
                .map_or(true, |r| r.validate().is_err()),
            "{v}"
        );
    }
    for v in f["invalidSnapshots"].as_array().unwrap() {
        assert!(
            serde_json::from_value::<LaunchSnapshot>(v.clone())
                .map_or(true, |r| !validate_snapshot(&r)),
            "{v}"
        );
    }
}

#[derive(Default)]
struct Gate {
    entered: tokio::sync::Notify,
    open: Mutex<bool>,
    changed: Condvar,
}
impl Gate {
    fn wait(&self) {
        self.entered.notify_one();
        let mut open = self.open.lock().unwrap();
        while !*open {
            open = self.changed.wait(open).unwrap();
        }
    }
    fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.changed.notify_all();
    }
}
struct FakeState {
    address: SocketAddr,
    spawns: AtomicUsize,
    stops: AtomicUsize,
    drops: AtomicUsize,
    owns: AtomicBool,
    exited: AtomicBool,
    stop_fails: AtomicBool,
    spawn_gate: Option<Arc<Gate>>,
    stop_gate: Option<Arc<Gate>>,
    serve: bool,
    body: String,
    status: u16,
    hits: Arc<Mutex<Vec<String>>>,
    spawn_error: Option<LaunchErrorCode>,
    startup_error: Option<LaunchErrorCode>,
}
impl FakeState {
    fn new() -> Self {
        let listener = StdListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        Self {
            address,
            spawns: AtomicUsize::new(0),
            stops: AtomicUsize::new(0),
            drops: AtomicUsize::new(0),
            owns: AtomicBool::new(true),
            exited: AtomicBool::new(false),
            stop_fails: AtomicBool::new(false),
            spawn_gate: None,
            stop_gate: None,
            serve: true,
            body: json!({"models":[{"model":"local-model"}]}).to_string(),
            status: 200,
            hits: Arc::new(Mutex::new(vec![])),
            spawn_error: None,
            startup_error: None,
        }
    }
    fn probe(&self) -> OllamaProbe {
        OllamaProbe::fixture(format!("http://{}", self.address))
    }
}
struct FakeInstallation(Arc<FakeState>);
impl InstalledRuntime for FakeInstallation {
    fn source(&self) -> InstallationSource {
        InstallationSource::RegisteredLocation
    }
    fn spawn(&self, token: &CancellationToken) -> Result<Box<dyn OwnedRuntime>, LaunchErrorCode> {
        self.0.spawns.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = &self.0.spawn_gate {
            gate.wait();
        }
        if token.is_cancelled() {
            return Err(LaunchErrorCode::Cancelled);
        }
        if let Some(code) = self.0.spawn_error {
            return Err(code);
        }
        let service = CancellationToken::new();
        if self.0.serve {
            serve(
                self.0.address,
                self.0.body.clone(),
                self.0.status,
                self.0.hits.clone(),
                service.clone(),
            );
        }
        Ok(Box::new(FakeProcess {
            state: self.0.clone(),
            service,
        }))
    }
}
struct FakeProcess {
    state: Arc<FakeState>,
    service: CancellationToken,
}
impl OwnedRuntime for FakeProcess {
    fn startup_error(&self) -> Option<LaunchErrorCode> {
        self.state.startup_error
    }
    fn exited(&mut self) -> Result<bool, LaunchErrorCode> {
        Ok(self.state.exited.load(Ordering::SeqCst))
    }
    fn owns_listener(&self) -> Result<bool, LaunchErrorCode> {
        Ok(self.state.owns.load(Ordering::SeqCst))
    }
    fn stop(&mut self) -> Result<(), LaunchErrorCode> {
        self.state.stops.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = &self.state.stop_gate {
            gate.wait();
        }
        if self.state.stop_fails.load(Ordering::SeqCst) {
            return Err(LaunchErrorCode::StopFailed);
        }
        self.service.cancel();
        Ok(())
    }
}
impl Drop for FakeProcess {
    fn drop(&mut self) {
        self.service.cancel();
        self.state.drops.fetch_add(1, Ordering::SeqCst);
    }
}
fn serve(
    address: SocketAddr,
    body: String,
    status: u16,
    hits: Arc<Mutex<Vec<String>>>,
    token: CancellationToken,
) {
    let listener = StdListener::bind(address).unwrap();
    listener.set_nonblocking(true).unwrap();
    let listener = tokio::net::TcpListener::from_std(listener).unwrap();
    tokio::spawn(async move {
        loop {
            let accept = tokio::select! { biased; _ = token.cancelled() => break, accept = listener.accept() => accept };
            let Ok((mut socket, _)) = accept else {
                break;
            };
            let body = body.clone();
            let hits = hits.clone();
            let token = token.clone();
            tokio::spawn(async move {
                tokio::select! { biased; _ = token.cancelled() => {}, _ = async {
                    let mut data = vec![];
                    while !data.windows(4).any(|v| v == b"\r\n\r\n") {
                        let mut bytes = [0; 1024]; let n = socket.read(&mut bytes).await.unwrap(); if n == 0 { return; } data.extend_from_slice(&bytes[..n]);
                    }
                    let request = String::from_utf8(data).unwrap();
                    let version = request.starts_with("GET /api/version ");
                    hits.lock().unwrap().push(request);
                    let body = if version && status == 200 { r#"{"version":"fixture"}"#.into() } else { body };
                    let _ = socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\nLocation: http://127.0.0.1:9/never\r\n\r\n{body}", body.len()).as_bytes()).await;
                } => {} }
            });
        }
    });
}
async fn prepare(registry: &LaunchRegistry, fake: Arc<FakeState>) -> LaunchSnapshot {
    registry
        .prepare_with(request(), move || {
            Ok(Some(Box::new(FakeInstallation(fake))))
        })
        .await
        .unwrap()
}
async fn start(
    registry: &LaunchRegistry,
    ticket: &LaunchSnapshot,
    fake: &FakeState,
) -> LaunchSnapshot {
    registry
        .start_with(
            start_request(ticket),
            fake.probe(),
            Duration::from_secs(2),
            Duration::from_millis(5),
        )
        .await
        .unwrap()
}
#[tokio::test]
async fn prepare_never_executes_and_cancelled_ticket_cannot_start() {
    let registry = LaunchRegistry::default();
    let fake = Arc::new(FakeState::new());
    let ticket = prepare(&registry, fake.clone()).await;
    assert_eq!(ticket.state, LaunchPhase::Prepared);
    assert_eq!(fake.spawns.load(Ordering::SeqCst), 0);
    assert_eq!(
        registry.cancel(operation(&ticket)).unwrap().state,
        LaunchPhase::Cancelled
    );
    assert_eq!(
        registry
            .start_with(
                start_request(&ticket),
                fake.probe(),
                LAUNCH_BUDGET,
                POLL_INTERVAL
            )
            .await
            .unwrap_err()
            .code,
        LaunchErrorCode::InvalidOperation
    );
    assert_eq!(fake.spawns.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn changed_expired_replaced_and_cross_session_tickets_cannot_spawn() {
    let registry = LaunchRegistry::default();
    let fake = Arc::new(FakeState::new());
    let first = prepare(&registry, fake.clone()).await;
    let mut wrong = start_request(&first);
    wrong.installation_id = "other".into();
    assert_eq!(
        registry
            .start_with(wrong, fake.probe(), LAUNCH_BUDGET, POLL_INTERVAL)
            .await
            .unwrap_err()
            .code,
        LaunchErrorCode::InvalidOperation
    );
    assert_eq!(
        LaunchRegistry::default()
            .start_with(
                start_request(&first),
                fake.probe(),
                LAUNCH_BUDGET,
                POLL_INTERVAL
            )
            .await
            .unwrap_err()
            .code,
        LaunchErrorCode::InvalidOperation
    );
    let second = prepare(&registry, fake.clone()).await;
    assert_eq!(
        registry
            .start_with(
                start_request(&first),
                fake.probe(),
                LAUNCH_BUDGET,
                POLL_INTERVAL
            )
            .await
            .unwrap_err()
            .code,
        LaunchErrorCode::InvalidOperation
    );
    registry.lock().unwrap().ticket.as_mut().unwrap().expires = Instant::now();
    assert_eq!(
        start(&registry, &second, &fake).await.error_code,
        Some(LaunchErrorCode::Expired)
    );
    assert_eq!(fake.spawns.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn late_prepare_cancel_and_shutdown_do_not_create_executable_permission() {
    for shutdown in [false, true] {
        let registry = LaunchRegistry::default();
        let gate = Arc::new(Gate::default());
        let fake = Arc::new(FakeState::new());
        let task = {
            let registry = registry.clone();
            let gate = gate.clone();
            let fake = fake.clone();
            tokio::spawn(async move {
                registry
                    .prepare_with(request(), move || {
                        gate.wait();
                        Ok(Some(Box::new(FakeInstallation(fake))))
                    })
                    .await
                    .unwrap()
            })
        };
        gate.entered.notified().await;
        let pending = registry.status(request()).await.unwrap();
        assert_eq!(pending.state, LaunchPhase::Preparing);
        assert_eq!(
            registry
                .prepare_with(request(), || Ok(None))
                .await
                .unwrap_err()
                .code,
            LaunchErrorCode::Busy
        );
        if shutdown {
            registry.shutdown();
        } else {
            registry.cancel(operation(&pending)).unwrap();
        }
        gate.release();
        let terminal = task.await.unwrap();
        assert_eq!(terminal.state, LaunchPhase::Cancelled);
        assert_eq!(fake.spawns.load(Ordering::SeqCst), 0);
    }
}
#[tokio::test]
async fn production_http_ready_reuses_models_and_stop_is_owned_idempotent() {
    let registry = LaunchRegistry::default();
    let fake = Arc::new(FakeState::new());
    let ticket = prepare(&registry, fake.clone()).await;
    let ready = start(&registry, &ticket, &fake).await;
    assert_eq!(ready.state, LaunchPhase::Ready);
    assert_eq!(ready.service.as_ref().unwrap().models[0].id, "local-model");
    let hits = fake.hits.lock().unwrap().clone();
    assert_eq!(hits.len(), 2);
    assert!(hits[0].starts_with("GET /api/version "));
    assert!(hits[1].starts_with("GET /api/tags "));
    assert!(!hits
        .iter()
        .any(|hit| hit.to_ascii_lowercase().contains("authorization:")));
    assert_eq!(
        registry.cancel(operation(&ticket)).unwrap().state,
        LaunchPhase::Ready
    );
    assert_eq!(fake.stops.load(Ordering::SeqCst), 0);
    assert_eq!(
        registry
            .prepare_with(request(), || Ok(None))
            .await
            .unwrap_err()
            .code,
        LaunchErrorCode::Busy
    );
    assert_eq!(
        registry.stop(operation(&ticket)).await.unwrap().state,
        LaunchPhase::Stopped
    );
    assert_eq!(
        registry.stop(operation(&ticket)).await.unwrap().state,
        LaunchPhase::Stopped
    );
    assert_eq!(fake.stops.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn existing_external_http_never_spawns_or_exposes_owned_stop() {
    for (status, body, state) in [
        (200, r#"{"models":[]}"#, ServiceState::NoModels),
        (401, "private", ServiceState::AuthRequired),
        (403, "private", ServiceState::AccessDenied),
        (302, "", ServiceState::Failed),
    ] {
        let registry = LaunchRegistry::default();
        let fake = Arc::new(FakeState::new());
        let external = CancellationToken::new();
        serve(
            fake.address,
            body.into(),
            status,
            fake.hits.clone(),
            external.clone(),
        );
        let ticket = prepare(&registry, fake.clone()).await;
        let result = start(&registry, &ticket, &fake).await;
        if status == 302 {
            assert_eq!(result.state, LaunchPhase::Failed);
            assert_eq!(result.error_code, Some(LaunchErrorCode::PortInUse));
        } else {
            assert_eq!(result.state, LaunchPhase::External);
            assert_eq!(result.service.as_ref().unwrap().state, state);
        }
        registry.stop(operation(&ticket)).await.unwrap();
        registry.shutdown();
        assert_eq!(fake.spawns.load(Ordering::SeqCst), 0);
        assert_eq!(fake.stops.load(Ordering::SeqCst), 0);
        assert!(!external.is_cancelled());
        external.cancel();
    }
}
#[tokio::test]
async fn no_models_and_remote_models_are_ready_not_download_requests() {
    for body in [
        r#"{"models":[]}"#,
        r#"{"models":[{"model":"remote:cloud"}]}"#,
    ] {
        let registry = LaunchRegistry::default();
        let fake = Arc::new(FakeState {
            body: body.into(),
            ..FakeState::new()
        });
        let ticket = prepare(&registry, fake.clone()).await;
        let result = start(&registry, &ticket, &fake).await;
        assert_eq!(result.state, LaunchPhase::Ready);
        assert!(fake
            .hits
            .lock()
            .unwrap()
            .iter()
            .all(|hit| hit.starts_with("GET /api/")));
        registry.shutdown();
    }
}
#[tokio::test]
async fn single_flight_duplicate_start_cancel_during_spawn_and_late_invoke() {
    let registry = LaunchRegistry::default();
    let gate = Arc::new(Gate::default());
    let fake = Arc::new(FakeState {
        spawn_gate: Some(gate.clone()),
        ..FakeState::new()
    });
    let ticket = prepare(&registry, fake.clone()).await;
    let task = {
        let registry = registry.clone();
        let ticket = ticket.clone();
        let fake = fake.clone();
        tokio::spawn(async move { start(&registry, &ticket, &fake).await })
    };
    gate.entered.notified().await;
    assert_eq!(
        registry
            .start_with(
                start_request(&ticket),
                fake.probe(),
                LAUNCH_BUDGET,
                POLL_INTERVAL
            )
            .await
            .unwrap_err()
            .code,
        LaunchErrorCode::InvalidOperation
    );
    assert_eq!(
        registry.cancel(operation(&ticket)).unwrap().state,
        LaunchPhase::Stopping
    );
    gate.release();
    assert_eq!(task.await.unwrap().state, LaunchPhase::Cancelled);
    assert_eq!(fake.spawns.load(Ordering::SeqCst), 1);
    // Losing the waiter does not cancel the internal owner task or allow a replay.
    let fake = Arc::new(FakeState::new());
    let ticket = prepare(&registry, fake.clone()).await;
    let waiter = {
        let registry = registry.clone();
        let ticket = ticket.clone();
        let fake = fake.clone();
        tokio::spawn(async move { start(&registry, &ticket, &fake).await })
    };
    while registry.status(request()).await.unwrap().state == LaunchPhase::Prepared {
        tokio::task::yield_now().await;
    }
    waiter.abort();
    tokio::time::timeout(Duration::from_secs(2), async {
        while registry.status(request()).await.unwrap().state != LaunchPhase::Ready {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(fake.spawns.load(Ordering::SeqCst), 1);
    registry.shutdown();
}
#[tokio::test]
async fn timeout_child_exit_identity_error_and_unowned_listener_only_cleanup_own_child() {
    for mode in 0..4 {
        let registry = LaunchRegistry::default();
        let mut fake = FakeState::new();
        let expected = match mode {
            0 => {
                fake.serve = false;
                LaunchErrorCode::TimedOut
            }
            1 => {
                fake.exited.store(true, Ordering::SeqCst);
                LaunchErrorCode::ProcessExited
            }
            2 => {
                fake.owns.store(false, Ordering::SeqCst);
                LaunchErrorCode::OwnershipUnverified
            }
            _ => {
                fake.spawn_error = Some(LaunchErrorCode::InstallationChanged);
                LaunchErrorCode::InstallationChanged
            }
        };
        let fake = Arc::new(fake);
        let ticket = prepare(&registry, fake.clone()).await;
        let mut result = registry
            .start_with(
                start_request(&ticket),
                fake.probe(),
                // Only the timeout case has an artificial short budget. The other
                // cases assert failure causes, not scheduler speed under CPU load.
                if mode == 0 {
                    Duration::from_millis(50)
                } else {
                    Duration::from_secs(2)
                },
                Duration::from_millis(5),
            )
            .await
            .unwrap();
        if result.state == LaunchPhase::Stopping {
            result = wait_terminal(&registry).await;
        }
        assert_eq!(result.state, LaunchPhase::Failed);
        assert_eq!(result.error_code, Some(expected));
        assert_eq!(fake.stops.load(Ordering::SeqCst), usize::from(mode != 3));
    }
}
#[tokio::test]
async fn cancelling_http_readiness_releases_owned_child_and_no_late_ready() {
    let registry = LaunchRegistry::default();
    let fake = Arc::new(FakeState {
        serve: false,
        ..FakeState::new()
    });
    let ticket = prepare(&registry, fake.clone()).await;
    let task = {
        let registry = registry.clone();
        let ticket = ticket.clone();
        let fake = fake.clone();
        tokio::spawn(async move { start(&registry, &ticket, &fake).await })
    };
    while fake.spawns.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    registry.cancel(operation(&ticket)).unwrap();
    assert_eq!(task.await.unwrap().state, LaunchPhase::Cancelled);
    assert_eq!(
        registry.status(request()).await.unwrap().state,
        LaunchPhase::Cancelled
    );
    assert!(fake.stops.load(Ordering::SeqCst) <= 1);
}
#[tokio::test]
async fn stopping_is_queryable_and_failed_cleanup_retains_handle_until_retry() {
    let registry = LaunchRegistry::default();
    let gate = Arc::new(Gate::default());
    let fake = Arc::new(FakeState {
        stop_gate: Some(gate.clone()),
        ..FakeState::new()
    });
    let ticket = prepare(&registry, fake.clone()).await;
    start(&registry, &ticket, &fake).await;
    let stop = {
        let registry = registry.clone();
        let request = operation(&ticket);
        tokio::spawn(async move { registry.stop(request).await.unwrap() })
    };
    gate.entered.notified().await;
    assert_eq!(
        registry.status(request()).await.unwrap().state,
        LaunchPhase::Stopping
    );
    assert_eq!(
        registry.stop(operation(&ticket)).await.unwrap().state,
        LaunchPhase::Stopping
    );
    assert_eq!(
        registry
            .prepare_with(request(), || Ok(None))
            .await
            .unwrap_err()
            .code,
        LaunchErrorCode::Busy
    );
    fake.stop_fails.store(true, Ordering::SeqCst);
    gate.release();
    assert_eq!(stop.await.unwrap().state, LaunchPhase::Stopping);
    assert_eq!(fake.drops.load(Ordering::SeqCst), 0);
    fake.stop_fails.store(false, Ordering::SeqCst);
    assert_eq!(
        registry.stop(operation(&ticket)).await.unwrap().state,
        LaunchPhase::Stopped
    );
    assert_eq!(fake.drops.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn status_detects_late_exit_and_real_shutdown_keeps_no_owned_session() {
    let registry = LaunchRegistry::default();
    let fake = Arc::new(FakeState::new());
    let ticket = prepare(&registry, fake.clone()).await;
    start(&registry, &ticket, &fake).await;
    fake.exited.store(true, Ordering::SeqCst);
    assert_eq!(
        registry.status(request()).await.unwrap().error_code,
        Some(LaunchErrorCode::ProcessExited)
    );
    let fake = Arc::new(FakeState::new());
    let ticket = prepare(&registry, fake.clone()).await;
    start(&registry, &ticket, &fake).await;
    registry.shutdown();
    assert_eq!(fake.stops.load(Ordering::SeqCst), 1);
    assert_eq!(
        registry.status(request()).await.unwrap().state,
        LaunchPhase::Stopped
    );
    assert_eq!(
        registry
            .prepare_with(request(), || Ok(None))
            .await
            .unwrap_err()
            .code,
        LaunchErrorCode::Cancelled
    );
    assert_eq!(
        LaunchRegistry::default()
            .status(request())
            .await
            .unwrap()
            .state,
        LaunchPhase::Idle
    );
}
#[tokio::test]
async fn unsupported_untrusted_missing_and_permission_errors_remain_distinct() {
    for code in [
        LaunchErrorCode::UnsupportedPlatform,
        LaunchErrorCode::InstallationUntrusted,
        LaunchErrorCode::PermissionDenied,
    ] {
        let registry = LaunchRegistry::default();
        let result = registry
            .prepare_with(request(), move || Err(code))
            .await
            .unwrap();
        assert_eq!(result.error_code, Some(code));
    }
    let registry = LaunchRegistry::default();
    assert_eq!(
        registry
            .prepare_with(request(), || Ok(None))
            .await
            .unwrap()
            .error_code,
        Some(LaunchErrorCode::InstallationNotFound)
    );
}

async fn wait_terminal(registry: &LaunchRegistry) -> LaunchSnapshot {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let snapshot = registry.status(request()).await.unwrap();
            if !matches!(
                snapshot.state,
                LaunchPhase::Starting | LaunchPhase::Preparing | LaunchPhase::Stopping
            ) {
                return snapshot;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn slow_system_verification_times_out_without_releasing_single_flight_or_spawning() {
    let registry = LaunchRegistry::default();
    let gate = Arc::new(Gate::default());
    let fake = Arc::new(FakeState::new());
    let pending = {
        let registry = registry.clone();
        let gate = gate.clone();
        let fake = fake.clone();
        tokio::spawn(async move {
            registry
                .prepare_with(request(), move || {
                    gate.wait();
                    Ok(Some(Box::new(FakeInstallation(fake))))
                })
                .await
                .unwrap()
        })
    };
    gate.entered.notified().await;
    tokio::time::pause();
    tokio::time::advance(LAUNCH_BUDGET + Duration::from_secs(1)).await;
    let pending_snapshot = pending.await.unwrap();
    assert_eq!(pending_snapshot.state, LaunchPhase::Stopping);
    assert_eq!(
        registry
            .prepare_with(request(), || Ok(None))
            .await
            .unwrap_err()
            .code,
        LaunchErrorCode::Busy
    );
    tokio::time::resume();
    gate.release();
    let terminal = wait_terminal(&registry).await;
    assert_eq!(terminal.state, LaunchPhase::Failed);
    assert_eq!(terminal.error_code, Some(LaunchErrorCode::TimedOut));
    assert_eq!(fake.spawns.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn slow_pre_spawn_revalidation_keeps_original_ticket_until_cancelled_worker_returns() {
    let registry = LaunchRegistry::default();
    let gate = Arc::new(Gate::default());
    let fake = Arc::new(FakeState {
        spawn_gate: Some(gate.clone()),
        ..FakeState::new()
    });
    let ticket = prepare(&registry, fake.clone()).await;
    let pending = {
        let registry = registry.clone();
        let ticket = ticket.clone();
        let fake = fake.clone();
        tokio::spawn(async move {
            registry
                .start_with(
                    start_request(&ticket),
                    fake.probe(),
                    Duration::from_millis(100),
                    Duration::from_millis(5),
                )
                .await
                .unwrap()
        })
    };
    gate.entered.notified().await;
    assert_eq!(pending.await.unwrap().state, LaunchPhase::Stopping);
    assert_eq!(
        registry
            .prepare_with(request(), || Ok(None))
            .await
            .unwrap_err()
            .code,
        LaunchErrorCode::Busy
    );
    assert_eq!(
        registry.stop(operation(&ticket)).await.unwrap().state,
        LaunchPhase::Stopping
    );
    gate.release();
    let terminal = wait_terminal(&registry).await;
    assert_eq!(terminal.state, LaunchPhase::Failed);
    assert_eq!(terminal.error_code, Some(LaunchErrorCode::TimedOut));
    assert_eq!(fake.drops.load(Ordering::SeqCst), 0); // token checked before any process was created
}

#[tokio::test]
async fn lost_waiters_still_revoke_slow_os_checks_at_owner_deadline() {
    for preparing in [true, false] {
        let registry = LaunchRegistry::default();
        let gate = Arc::new(Gate::default());
        let fake = Arc::new(FakeState {
            spawn_gate: if preparing { None } else { Some(gate.clone()) },
            ..FakeState::new()
        });
        let waiter = if preparing {
            let registry = registry.clone();
            let gate = gate.clone();
            let fake = fake.clone();
            tokio::spawn(async move {
                registry
                    .prepare_with(request(), move || {
                        gate.wait();
                        Ok(Some(Box::new(FakeInstallation(fake))))
                    })
                    .await
                    .unwrap()
            })
        } else {
            let ticket = prepare(&registry, fake.clone()).await;
            let registry = registry.clone();
            let fake = fake.clone();
            tokio::spawn(async move {
                registry
                    .start_with(
                        start_request(&ticket),
                        fake.probe(),
                        LAUNCH_BUDGET,
                        POLL_INTERVAL,
                    )
                    .await
                    .unwrap()
            })
        };
        gate.entered.notified().await;
        waiter.abort();
        let _ = waiter.await;
        tokio::time::pause();
        tokio::time::advance(LAUNCH_BUDGET + Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        let snapshot = registry.status(request()).await;
        let cancelled = registry
            .lock()
            .unwrap()
            .ticket
            .as_ref()
            .unwrap()
            .token
            .is_cancelled();
        let duplicate = registry.prepare_with(request(), || Ok(None)).await;
        tokio::time::resume();
        gate.release();
        assert_eq!(snapshot.unwrap().state, LaunchPhase::Stopping);
        assert!(cancelled);
        assert_eq!(duplicate.unwrap_err().code, LaunchErrorCode::Busy);
        let terminal = wait_terminal(&registry).await;
        assert_eq!(terminal.error_code, Some(LaunchErrorCode::TimedOut));
        assert_eq!(fake.drops.load(Ordering::SeqCst), 0); // no FakeProcess was created/resumed
    }
}
#[tokio::test]
async fn startup_failure_keeps_owned_handle_and_first_reason_through_cleanup_retry() {
    let registry = LaunchRegistry::default();
    let fake = Arc::new(FakeState {
        startup_error: Some(LaunchErrorCode::OwnershipUnverified),
        serve: false,
        ..FakeState::new()
    });
    fake.stop_fails.store(true, Ordering::SeqCst);
    let ticket = prepare(&registry, fake.clone()).await;
    assert_eq!(
        start(&registry, &ticket, &fake).await.state,
        LaunchPhase::Stopping
    );
    assert_eq!(fake.drops.load(Ordering::SeqCst), 0);
    assert_eq!(
        registry
            .prepare_with(request(), || Ok(None))
            .await
            .unwrap_err()
            .code,
        LaunchErrorCode::Busy
    );
    fake.stop_fails.store(false, Ordering::SeqCst);
    let ended = registry.stop(operation(&ticket)).await.unwrap();
    assert_eq!(ended.state, LaunchPhase::Failed);
    assert_eq!(ended.error_code, Some(LaunchErrorCode::OwnershipUnverified));
    assert_eq!(fake.drops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn expired_prepare_deadline_does_not_cancel_a_later_start_phase() {
    let registry = LaunchRegistry::default();
    let gate = Arc::new(Gate::default());
    let fake = Arc::new(FakeState {
        spawn_gate: Some(gate.clone()),
        ..FakeState::new()
    });
    let ticket = prepare(&registry, fake.clone()).await;
    let pending = {
        let registry = registry.clone();
        let ticket = ticket.clone();
        let fake = fake.clone();
        tokio::spawn(async move { start(&registry, &ticket, &fake).await })
    };
    gate.entered.notified().await;
    let snapshot = registry.timeout(
        ticket.operation_id.as_deref().unwrap(),
        LaunchPhase::Preparing,
    );
    let cancelled = registry
        .lock()
        .unwrap()
        .ticket
        .as_ref()
        .unwrap()
        .token
        .is_cancelled();
    gate.release();
    assert_eq!(snapshot.unwrap().state, LaunchPhase::Starting);
    assert!(!cancelled);
    assert_eq!(pending.await.unwrap().state, LaunchPhase::Ready);
    registry.stop(operation(&ticket)).await.unwrap();
}

#[tokio::test]
async fn ui_destroyed_during_failed_cleanup_drops_the_late_owned_job() {
    let registry = LaunchRegistry::default();
    let gate = Arc::new(Gate::default());
    let fake = Arc::new(FakeState {
        stop_gate: Some(gate.clone()),
        ..FakeState::new()
    });
    let ticket = prepare(&registry, fake.clone()).await;
    assert_eq!(
        start(&registry, &ticket, &fake).await.state,
        LaunchPhase::Ready
    );
    fake.stop_fails.store(true, Ordering::SeqCst);
    let stopping = {
        let registry = registry.clone();
        let request = operation(&ticket);
        tokio::spawn(async move { registry.stop(request).await.unwrap() })
    };
    gate.entered.notified().await;
    registry.shutdown();
    let during_shutdown = registry.status(request()).await;
    gate.release();
    assert_eq!(during_shutdown.unwrap().state, LaunchPhase::Stopping);
    assert_eq!(stopping.await.unwrap().state, LaunchPhase::Stopping);
    assert_eq!(fake.drops.load(Ordering::SeqCst), 1);
    assert!(registry
        .lock()
        .unwrap()
        .ticket
        .as_ref()
        .unwrap()
        .process
        .is_none());
    assert_eq!(
        registry
            .prepare_with(request(), || Ok(None))
            .await
            .unwrap_err()
            .code,
        LaunchErrorCode::Cancelled
    );
}
