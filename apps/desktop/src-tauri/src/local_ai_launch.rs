//! LOCAL-2: one in-memory ticket and one owned Ollama child for this app session.
//! No shell, durable journal, PID adoption, automatic restart or renderer path authority.
use crate::local_ai_discovery::{OllamaProbe, Service, ServiceState};
use serde::{Deserialize, Serialize};
use std::{
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[cfg(windows)]
#[path = "local_ai_launch_windows.rs"]
mod platform;
#[cfg(not(windows))]
mod platform {
    use super::*;
    pub(super) fn find_installation() -> Result<Option<Box<dyn InstalledRuntime>>, LaunchErrorCode>
    {
        Err(LaunchErrorCode::UnsupportedPlatform)
    }
}

const TICKET_LIFETIME: Duration = Duration::from_secs(120);
const LAUNCH_BUDGET: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeId {
    Ollama,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeRequest {
    pub contract_version: u8,
    pub runtime_id: RuntimeId,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchRequest {
    pub contract_version: u8,
    pub runtime_id: RuntimeId,
    pub installation_id: String,
    pub operation_id: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationRequest {
    pub contract_version: u8,
    pub runtime_id: RuntimeId,
    pub operation_id: String,
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
}
impl RuntimeRequest {
    fn validate(&self) -> Result<(), LaunchError> {
        if self.contract_version != 1 {
            return Err(LaunchErrorCode::InvalidRequest.into());
        }
        Ok(())
    }
}
impl LaunchRequest {
    fn validate(&self) -> Result<(), LaunchError> {
        if self.contract_version != 1
            || !valid_id(&self.installation_id)
            || !valid_id(&self.operation_id)
        {
            return Err(LaunchErrorCode::InvalidRequest.into());
        }
        Ok(())
    }
}
impl OperationRequest {
    fn validate(&self) -> Result<(), LaunchError> {
        if self.contract_version != 1 || !valid_id(&self.operation_id) {
            return Err(LaunchErrorCode::InvalidRequest.into());
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LaunchErrorCode {
    InvalidRequest,
    Busy,
    UnsupportedPlatform,
    InstallationNotFound,
    InstallationUntrusted,
    InstallationChanged,
    PermissionDenied,
    ExistingProcess,
    InvalidOperation,
    Expired,
    Cancelled,
    PortInUse,
    SpawnFailed,
    ProcessExited,
    OwnershipUnverified,
    TimedOut,
    StopFailed,
    Failed,
}
#[derive(Debug, Serialize)]
pub struct LaunchError {
    pub code: LaunchErrorCode,
}
impl From<LaunchErrorCode> for LaunchError {
    fn from(code: LaunchErrorCode) -> Self {
        Self { code }
    }
}
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum InstallationSource {
    DefaultLocation,
    RegisteredLocation,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallationSummary {
    installation_id: String,
    source: InstallationSource,
    product: String,
}
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LaunchPhase {
    Idle,
    Preparing,
    Prepared,
    Starting,
    Ready,
    External,
    Stopping,
    Stopped,
    Cancelled,
    Failed,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchSnapshot {
    contract_version: u8,
    runtime_id: RuntimeId,
    state: LaunchPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    installation: Option<InstallationSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    service: Option<Service>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<LaunchErrorCode>,
}
impl LaunchSnapshot {
    fn idle() -> Self {
        Self {
            contract_version: 1,
            runtime_id: RuntimeId::Ollama,
            state: LaunchPhase::Idle,
            operation_id: None,
            installation: None,
            service: None,
            error_code: None,
        }
    }
    fn terminal(&mut self, phase: LaunchPhase, code: Option<LaunchErrorCode>) {
        self.state = phase;
        self.service = None;
        self.installation = None;
        self.error_code = code;
    }
}

pub(crate) trait InstalledRuntime: Send + Sync {
    fn source(&self) -> InstallationSource;
    /// Revalidate the retained executable and existing-process/port preconditions.
    /// Establish private job ownership before executing anything; cancellation must be
    /// checked before resuming the child. A returned handle owns the complete process tree.
    fn spawn(&self, token: &CancellationToken) -> Result<Box<dyn OwnedRuntime>, LaunchErrorCode>;
}
pub(crate) trait OwnedRuntime: Send {
    /// Even a suspended child whose startup failed must remain owned until the
    /// shared cleanup confirms its tree has exited. No failure may drop that duty.
    fn startup_error(&self) -> Option<LaunchErrorCode> {
        None
    }
    fn exited(&mut self) -> Result<bool, LaunchErrorCode>;
    fn owns_listener(&self) -> Result<bool, LaunchErrorCode>;
    /// Return Ok only after the owned tree has stopped; failure retains ownership.
    fn stop(&mut self) -> Result<(), LaunchErrorCode>;
}
struct Ticket {
    snapshot: LaunchSnapshot,
    token: CancellationToken,
    expires: Instant,
    installation: Option<Box<dyn InstalledRuntime>>,
    process: Option<Box<dyn OwnedRuntime>>,
    prepare_active: bool,
    launch_active: bool,
    cleanup_active: bool,
    completion_error: Option<LaunchErrorCode>,
}
#[derive(Default)]
struct State {
    ticket: Option<Ticket>,
    shutdown: bool,
}
#[derive(Clone, Default)]
pub struct LaunchRegistry {
    state: Arc<Mutex<State>>,
}
fn random_id(prefix: &str) -> Result<String, LaunchError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| LaunchErrorCode::Failed)?;
    Ok(format!(
        "{prefix}{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}
impl LaunchRegistry {
    fn lock(&self) -> Result<MutexGuard<'_, State>, LaunchError> {
        self.state
            .lock()
            .map_err(|_| LaunchErrorCode::Failed.into())
    }
    fn ticket<'a>(state: &'a mut State, id: &str) -> Result<&'a mut Ticket, LaunchError> {
        state
            .ticket
            .as_mut()
            .filter(|ticket| ticket.snapshot.operation_id.as_deref() == Some(id))
            .ok_or(LaunchErrorCode::InvalidOperation.into())
    }
    pub async fn prepare(&self, request: RuntimeRequest) -> Result<LaunchSnapshot, LaunchError> {
        self.prepare_with(request, platform::find_installation)
            .await
    }
    async fn prepare_with<F>(
        &self,
        request: RuntimeRequest,
        find: F,
    ) -> Result<LaunchSnapshot, LaunchError>
    where
        F: FnOnce() -> Result<Option<Box<dyn InstalledRuntime>>, LaunchErrorCode> + Send + 'static,
    {
        request.validate()?;
        let id = random_id("launch_")?;
        let installation_id = random_id("install_")?;
        let token = CancellationToken::new();
        {
            let mut state = self.lock()?;
            if state.shutdown {
                return Err(LaunchErrorCode::Cancelled.into());
            }
            if state.ticket.as_ref().is_some_and(|ticket| {
                ticket.prepare_active
                    || ticket.process.is_some()
                    || matches!(
                        ticket.snapshot.state,
                        LaunchPhase::Preparing
                            | LaunchPhase::Starting
                            | LaunchPhase::Ready
                            | LaunchPhase::Stopping
                    )
            }) {
                return Err(LaunchErrorCode::Busy.into());
            }
            if let Some(old) = state.ticket.take() {
                old.token.cancel();
            }
            let mut snapshot = LaunchSnapshot::idle();
            snapshot.state = LaunchPhase::Preparing;
            snapshot.operation_id = Some(id.clone());
            state.ticket = Some(Ticket {
                snapshot,
                token: token.clone(),
                expires: Instant::now() + TICKET_LIFETIME,
                installation: None,
                process: None,
                prepare_active: true,
                launch_active: false,
                cleanup_active: false,
                completion_error: None,
            });
        }
        self.arm_deadline(&id, token, LAUNCH_BUDGET, LaunchPhase::Preparing);
        // The detached blocking worker always commits a result. A lost invoke response
        // cannot create an untracked ticket or make a later start implicitly retry.
        let registry = self.clone();
        let operation_id = id.clone();
        let mut pending = tokio::task::spawn_blocking(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(find))
                .unwrap_or(Err(LaunchErrorCode::Failed));
            let mut state = registry.lock()?;
            let shutdown = state.shutdown;
            let ticket = Self::ticket(&mut state, &id)?;
            ticket.prepare_active = false;
            if ticket.token.is_cancelled() || shutdown {
                let code = ticket.completion_error;
                ticket.snapshot.terminal(
                    if code.is_some() {
                        LaunchPhase::Failed
                    } else {
                        LaunchPhase::Cancelled
                    },
                    code,
                );
            } else {
                match result {
                    Ok(Some(installation)) => {
                        ticket.snapshot.installation = Some(InstallationSummary {
                            installation_id,
                            product: "Ollama".into(),
                            source: installation.source(),
                        });
                        ticket.installation = Some(installation);
                        ticket.expires = Instant::now() + TICKET_LIFETIME;
                        ticket.snapshot.state = LaunchPhase::Prepared;
                        let registry = registry.clone();
                        let id = id.clone();
                        let token = ticket.token.clone();
                        tokio::spawn(async move {
                            tokio::select! { biased; _ = token.cancelled() => {}, _ = tokio::time::sleep(TICKET_LIFETIME) => {
                                if let Ok(mut state) = registry.lock() {
                                    if let Ok(ticket) = Self::ticket(&mut state, &id) {
                                        if ticket.snapshot.state == LaunchPhase::Prepared && Instant::now() >= ticket.expires {
                                            ticket.installation = None;
                                            ticket.snapshot.terminal(LaunchPhase::Failed, Some(LaunchErrorCode::Expired));
                                        }
                                    }
                                }
                            } }
                        });
                    }
                    Ok(None) => ticket.snapshot.terminal(
                        LaunchPhase::Failed,
                        Some(LaunchErrorCode::InstallationNotFound),
                    ),
                    Err(code) => ticket.snapshot.terminal(LaunchPhase::Failed, Some(code)),
                }
            }
            Ok(ticket.snapshot.clone())
        });
        tokio::select! {
            result = &mut pending => result.map_err(|_| LaunchErrorCode::Failed)?,
            _ = tokio::time::sleep(LAUNCH_BUDGET) => self.timeout(&operation_id, LaunchPhase::Preparing),
        }
    }
    fn arm_deadline(
        &self,
        id: &str,
        token: CancellationToken,
        budget: Duration,
        phase: LaunchPhase,
    ) {
        let registry = self.clone();
        let id = id.to_owned();
        let deadline = tokio::time::Instant::now() + budget;
        // The owner, not the possibly dropped IPC waiter, must revoke a ticket
        // before a slow OS check can return and resume a child after the budget.
        tokio::spawn(async move {
            tokio::select! { biased;
                _ = token.cancelled() => {},
                _ = tokio::time::sleep_until(deadline) => { let _ = registry.timeout(&id, phase); },
            }
        });
    }
    // OS trust may outlive the UI deadline. Revoke its ticket while keeping the
    // single-flight slot until the worker returns: late verification cannot spawn.
    fn timeout(&self, id: &str, phase: LaunchPhase) -> Result<LaunchSnapshot, LaunchError> {
        let mut state = self.lock()?;
        let ticket = Self::ticket(&mut state, id)?;
        if (phase == LaunchPhase::Preparing && ticket.prepare_active)
            || (phase == LaunchPhase::Starting && ticket.launch_active)
        {
            ticket.completion_error = Some(LaunchErrorCode::TimedOut);
            ticket.token.cancel();
            ticket.snapshot.state = LaunchPhase::Stopping;
            ticket.snapshot.service = None;
        }
        Ok(ticket.snapshot.clone())
    }
    pub async fn start(&self, request: LaunchRequest) -> Result<LaunchSnapshot, LaunchError> {
        request.validate()?;
        let probe = OllamaProbe::new().map_err(|_| LaunchErrorCode::Failed)?;
        self.start_with(request, probe, LAUNCH_BUDGET, POLL_INTERVAL)
            .await
    }
    async fn start_with(
        &self,
        request: LaunchRequest,
        probe: OllamaProbe,
        budget: Duration,
        interval: Duration,
    ) -> Result<LaunchSnapshot, LaunchError> {
        request.validate()?;
        let (installation, token) = {
            let mut state = self.lock()?;
            if state.shutdown {
                return Err(LaunchErrorCode::Cancelled.into());
            }
            let ticket = Self::ticket(&mut state, &request.operation_id)?;
            if ticket.snapshot.state != LaunchPhase::Prepared || ticket.token.is_cancelled() {
                return Err(LaunchErrorCode::InvalidOperation.into());
            }
            if ticket
                .snapshot
                .installation
                .as_ref()
                .map(|value| &value.installation_id)
                != Some(&request.installation_id)
            {
                return Err(LaunchErrorCode::InvalidOperation.into());
            }
            if Instant::now() >= ticket.expires {
                ticket.installation = None;
                ticket
                    .snapshot
                    .terminal(LaunchPhase::Failed, Some(LaunchErrorCode::Expired));
                return Ok(ticket.snapshot.clone());
            }
            let installation = ticket
                .installation
                .take()
                .ok_or(LaunchErrorCode::InvalidOperation)?;
            ticket.snapshot.state = LaunchPhase::Starting;
            ticket.launch_active = true;
            (installation, ticket.token.clone())
        };
        let registry = self.clone();
        let operation_id = request.operation_id.clone();
        self.arm_deadline(&operation_id, token.clone(), budget, LaunchPhase::Starting);
        // This task, not the IPC waiter, owns spawn/readiness/cleanup to terminal state.
        let mut pending = tokio::spawn(async move {
            let id = request.operation_id;
            let outcome = registry
                .launch_worker(&id, installation, &token, probe, budget, interval)
                .await;
            match outcome {
                Ok(service) => {
                    let ready = {
                        let mut state = registry.lock()?;
                        let shutdown = state.shutdown;
                        let ticket = Self::ticket(&mut state, &id)?;
                        if token.is_cancelled() || shutdown {
                            None
                        } else {
                            ticket.launch_active = false;
                            ticket.snapshot.state = if ticket.process.is_some() {
                                LaunchPhase::Ready
                            } else {
                                LaunchPhase::External
                            };
                            if ticket.process.is_none() {
                                ticket.snapshot.installation = None;
                            }
                            ticket.snapshot.service = Some(service);
                            Some(ticket.snapshot.clone())
                        }
                    };
                    match ready {
                        Some(snapshot) => Ok(snapshot),
                        None => registry.cleanup(&id, LaunchPhase::Cancelled, None).await,
                    }
                }
                Err(code) => {
                    registry
                        .cleanup(
                            &id,
                            if code == LaunchErrorCode::Cancelled {
                                LaunchPhase::Cancelled
                            } else {
                                LaunchPhase::Failed
                            },
                            if code == LaunchErrorCode::Cancelled {
                                None
                            } else {
                                Some(code)
                            },
                        )
                        .await
                }
            }
        });
        tokio::select! {
            result = &mut pending => result.map_err(|_| LaunchErrorCode::Failed)?,
            _ = tokio::time::sleep(budget) => self.timeout(&operation_id, LaunchPhase::Starting),
        }
    }
    async fn launch_worker(
        &self,
        id: &str,
        installation: Box<dyn InstalledRuntime>,
        token: &CancellationToken,
        probe: OllamaProbe,
        budget: Duration,
        interval: Duration,
    ) -> Result<Service, LaunchErrorCode> {
        let deadline = tokio::time::Instant::now() + budget;
        let first = tokio::select! {
            biased;
            _ = token.cancelled() => return Err(LaunchErrorCode::Cancelled),
            _ = tokio::time::sleep_until(deadline) => return Err(LaunchErrorCode::TimedOut),
            service = probe.probe() => service,
        };
        if first.state != ServiceState::Unreachable {
            return if matches!(
                first.state,
                ServiceState::TimedOut | ServiceState::Failed | ServiceState::UnsupportedResponse
            ) {
                Err(LaunchErrorCode::PortInUse)
            } else {
                Ok(first)
            };
        }
        let spawn_token = token.clone();
        // Await the actual result even when cancelled, since blocking OS work cannot
        // be revoked by dropping a JoinHandle. The private job is never abandoned.
        let process = tokio::task::spawn_blocking(move || {
            if spawn_token.is_cancelled() {
                return Err(LaunchErrorCode::Cancelled);
            }
            installation.spawn(&spawn_token)
        })
        .await
        .map_err(|_| LaunchErrorCode::SpawnFailed)??;
        let startup_error = process.startup_error();
        {
            let mut state = self.lock().map_err(|_| LaunchErrorCode::Failed)?;
            let ticket =
                Self::ticket(&mut state, id).map_err(|_| LaunchErrorCode::InvalidOperation)?;
            ticket.process = Some(process);
        }
        if let Some(code) = startup_error {
            return Err(code);
        }
        loop {
            if token.is_cancelled() {
                return Err(LaunchErrorCode::Cancelled);
            }
            {
                let mut state = self.lock().map_err(|_| LaunchErrorCode::Failed)?;
                let process = Self::ticket(&mut state, id)
                    .map_err(|_| LaunchErrorCode::InvalidOperation)?
                    .process
                    .as_mut()
                    .ok_or(LaunchErrorCode::ProcessExited)?;
                if process.exited()? {
                    return Err(LaunchErrorCode::ProcessExited);
                }
            }
            let service = tokio::select! {
                biased;
                _ = token.cancelled() => return Err(LaunchErrorCode::Cancelled),
                _ = tokio::time::sleep_until(deadline) => return Err(LaunchErrorCode::TimedOut),
                service = probe.probe() => service,
            };
            if !matches!(
                service.state,
                ServiceState::Unreachable | ServiceState::TimedOut
            ) {
                let mut state = self.lock().map_err(|_| LaunchErrorCode::Failed)?;
                let process = Self::ticket(&mut state, id)
                    .map_err(|_| LaunchErrorCode::InvalidOperation)?
                    .process
                    .as_mut()
                    .ok_or(LaunchErrorCode::ProcessExited)?;
                if process.exited()? {
                    return Err(LaunchErrorCode::ProcessExited);
                }
                if !process.owns_listener()? {
                    return Err(LaunchErrorCode::OwnershipUnverified);
                }
                if matches!(
                    service.state,
                    ServiceState::Failed | ServiceState::UnsupportedResponse
                ) {
                    return Err(LaunchErrorCode::Failed);
                }
                return Ok(service);
            }
            tokio::select! {
                biased;
                _ = token.cancelled() => return Err(LaunchErrorCode::Cancelled),
                _ = tokio::time::sleep_until(deadline) => return Err(LaunchErrorCode::TimedOut),
                _ = tokio::time::sleep(interval) => {},
            }
        }
    }
    async fn cleanup(
        &self,
        id: &str,
        phase: LaunchPhase,
        code: Option<LaunchErrorCode>,
    ) -> Result<LaunchSnapshot, LaunchError> {
        let registry = self.clone();
        let id = id.to_owned();
        let process = {
            let mut state = self.lock()?;
            let ticket = Self::ticket(&mut state, &id)?;
            if ticket.cleanup_active {
                return Ok(ticket.snapshot.clone());
            }
            ticket.launch_active = false;
            ticket.snapshot.state = LaunchPhase::Stopping;
            ticket.snapshot.service = None;
            ticket.installation = None;
            ticket.cleanup_active = true;
            ticket.completion_error = ticket.completion_error.or(code);
            ticket.process.take()
        };
        // Never hold the state mutex during a bounded OS wait: status can report
        // stopping, and duplicate stop/prepare cannot race another owned cleanup.
        tokio::task::spawn_blocking(move || {
            let mut process = process;
            let stopped = process
                .as_mut()
                .is_none_or(|process| process.stop().is_ok());
            let mut state = registry.lock()?;
            let shutdown = state.shutdown;
            let ticket = Self::ticket(&mut state, &id)?;
            ticket.cleanup_active = false;
            if stopped {
                let code = ticket.completion_error.or(code);
                ticket.snapshot.terminal(
                    if code.is_some() {
                        LaunchPhase::Failed
                    } else {
                        phase
                    },
                    code,
                );
            } else if !shutdown {
                // Retain ownership and stopping. Do not permit a second server.
                ticket.process = process;
            }
            // After real UI destruction, a failed late stop must drop its private
            // job instead of retaining it for a retry in a UI that no longer exists.
            Ok(ticket.snapshot.clone())
        })
        .await
        .map_err(|_| LaunchErrorCode::StopFailed)?
    }
    pub fn cancel(&self, request: OperationRequest) -> Result<LaunchSnapshot, LaunchError> {
        request.validate()?;
        let mut state = self.lock()?;
        let ticket = Self::ticket(&mut state, &request.operation_id)?;
        match ticket.snapshot.state {
            LaunchPhase::Preparing | LaunchPhase::Prepared => {
                ticket.token.cancel();
                ticket.installation = None;
                ticket.snapshot.terminal(LaunchPhase::Cancelled, None);
            }
            LaunchPhase::Starting => {
                ticket.token.cancel();
                ticket.snapshot.state = LaunchPhase::Stopping;
            }
            // Late close/cancel MUST NOT kill a successfully ready owned server.
            _ => {}
        }
        Ok(ticket.snapshot.clone())
    }
    pub async fn stop(&self, request: OperationRequest) -> Result<LaunchSnapshot, LaunchError> {
        request.validate()?;
        {
            let mut state = self.lock()?;
            let ticket = Self::ticket(&mut state, &request.operation_id)?;
            if ticket.launch_active
                || matches!(
                    ticket.snapshot.state,
                    LaunchPhase::Preparing | LaunchPhase::Prepared
                )
            {
                drop(state);
                return self.cancel(request);
            }
            if ticket.cleanup_active || ticket.process.is_none() {
                return Ok(ticket.snapshot.clone());
            }
            ticket.token.cancel();
        }
        self.cleanup(&request.operation_id, LaunchPhase::Stopped, None)
            .await
    }
    pub async fn status(&self, request: RuntimeRequest) -> Result<LaunchSnapshot, LaunchError> {
        request.validate()?;
        let exited = {
            let mut state = self.lock()?;
            if let Some(ticket) = state.ticket.as_mut() {
                if ticket.snapshot.state == LaunchPhase::Prepared
                    && Instant::now() >= ticket.expires
                {
                    ticket.installation = None;
                    ticket
                        .snapshot
                        .terminal(LaunchPhase::Failed, Some(LaunchErrorCode::Expired));
                }
                if ticket.snapshot.state == LaunchPhase::Ready {
                    match ticket
                        .process
                        .as_mut()
                        .ok_or(LaunchErrorCode::ProcessExited)?
                        .exited()
                    {
                        Ok(false) => None,
                        _ => ticket.snapshot.operation_id.clone(),
                    }
                } else {
                    None
                }
            } else {
                None
            }
        };
        if let Some(id) = exited {
            return self
                .cleanup(
                    &id,
                    LaunchPhase::Failed,
                    Some(LaunchErrorCode::ProcessExited),
                )
                .await;
        }
        Ok(self
            .lock()?
            .ticket
            .as_ref()
            .map(|ticket| ticket.snapshot.clone())
            .unwrap_or_else(LaunchSnapshot::idle))
    }
    /// Only call after actual main window destruction / final application exit,
    /// never from CloseRequested: the existing renderer guard may deny that close.
    pub fn shutdown(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.shutdown = true;
            if let Some(ticket) = state.ticket.as_mut() {
                ticket.token.cancel();
                ticket.installation = None;
                let stopped = ticket
                    .process
                    .as_mut()
                    .is_none_or(|process| process.stop().is_ok())
                    && !ticket.launch_active
                    && !ticket.cleanup_active;
                ticket.process = None; // private job Drop is the crash/cleanup fallback.
                ticket.snapshot.terminal(
                    if stopped {
                        LaunchPhase::Stopped
                    } else {
                        LaunchPhase::Stopping
                    },
                    None,
                );
            }
        }
    }
}

#[cfg(test)]
#[path = "local_ai_launch_tests.rs"]
mod tests;
