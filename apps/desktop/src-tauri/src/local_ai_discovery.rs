//! Explicit, bounded, read-only LOCAL-1 discovery. No renderer endpoint authority.
use crate::{
    provider_profile::{DirectProviderExecutionProfile, ProviderAdapter},
    secret::SecretStore,
    store::LocalStore,
};
use futures_util::StreamExt;
use reqwest::{
    header::{HeaderMap, HeaderValue, ACCEPT, CONTENT_TYPE},
    Client,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    net::IpAddr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

const MAX_BODY: usize = 1024 * 1024;
const MAX_MODELS: usize = 256;
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscoveryRequest {
    pub contract_version: u8,
    pub request_id: String,
    pub target: DiscoveryTarget,
}
impl DiscoveryRequest {
    pub(crate) fn validate(&self) -> Result<(), DiscoveryError> {
        if self.contract_version != 1
            || !valid_identity(&self.request_id, 128)
            || matches!(&self.target, DiscoveryTarget::Profile { profile_id } if !valid_identity(profile_id, 256))
        {
            return Err(DiscoveryErrorCode::InvalidRequest.into());
        }
        Ok(())
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DiscoveryTarget {
    Candidate { candidate_id: Candidate },
    Profile { profile_id: String },
}
#[derive(Debug, Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum Candidate {
    Ollama,
    LmStudio,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscoveryCancelRequest {
    pub request_id: String,
}
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DiscoveryErrorCode {
    InvalidRequest,
    Busy,
    ProfileNotFound,
    ProfileRejected,
    MissingSecret,
    Failed,
}
#[derive(Debug, Serialize)]
pub struct DiscoveryError {
    pub code: DiscoveryErrorCode,
}
impl From<DiscoveryErrorCode> for DiscoveryError {
    fn from(code: DiscoveryErrorCode) -> Self {
        Self { code }
    }
}
#[derive(Debug, Serialize)]
#[serde(
    tag = "outcome",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum DiscoveryResponse {
    Completed {
        contract_version: u8,
        request_id: String,
        service: Service,
    },
    Cancelled {
        contract_version: u8,
        request_id: String,
    },
}
#[derive(Debug, Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum Protocol {
    OllamaNative,
    LmStudioNative,
    OpenaiCompatible,
}
#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ServiceState {
    Reachable,
    NoModels,
    NoCompatibleModels,
    AuthRequired,
    AuthRejected,
    AccessDenied,
    Unreachable,
    TimedOut,
    UnsupportedResponse,
    Failed,
}
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Service {
    pub protocol: Protocol,
    pub state: ServiceState,
    pub models: Vec<Model>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Model {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub kind: String,
    pub loaded: String,
    pub execution: String,
}
impl Service {
    fn new(protocol: Protocol, state: ServiceState) -> Self {
        Self {
            protocol,
            state,
            models: vec![],
            version: None,
            error_code: None,
        }
    }
}

#[derive(Clone, Default)]
pub struct DiscoveryRegistry {
    active: Arc<Mutex<Option<(String, CancellationToken)>>>,
}
struct Registration {
    registry: DiscoveryRegistry,
    token: CancellationToken,
}
impl Drop for Registration {
    fn drop(&mut self) {
        self.token.cancel();
        if let Ok(mut active) = self.registry.active.lock() {
            *active = None;
        }
    }
}
impl DiscoveryRegistry {
    fn register(&self, id: &str) -> Result<Registration, DiscoveryError> {
        let mut active = self.active.lock().map_err(|_| DiscoveryErrorCode::Failed)?;
        if active.is_some() {
            return Err(DiscoveryErrorCode::Busy.into());
        }
        let token = CancellationToken::new();
        *active = Some((id.to_owned(), token.clone()));
        Ok(Registration {
            registry: self.clone(),
            token,
        })
    }
    pub fn cancel(&self, id: &str) -> Result<bool, DiscoveryError> {
        if !valid_identity(id, 128) {
            return Err(DiscoveryErrorCode::InvalidRequest.into());
        }
        let active = self.active.lock().map_err(|_| DiscoveryErrorCode::Failed)?;
        Ok(active.as_ref().is_some_and(|(current, token)| {
            if current == id {
                token.cancel();
                true
            } else {
                false
            }
        }))
    }
}
fn valid_identity(id: &str, max: usize) -> bool {
    !id.is_empty()
        && id.len() <= max
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
}
fn valid_model_id(value: &str) -> bool {
    crate::provider_target::normalize_model_id(value).is_ok_and(|normalized| normalized == value)
}
fn valid_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= max
        && !value
            .chars()
            .any(|c| c <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&c))
}

/// Inspect the original authority/path as well as Url: URL parsing normalizes
/// abbreviated IPv4 and dot segments, which must not expand discovery authority.
fn profile_endpoint(profile: &DirectProviderExecutionProfile) -> Result<String, DiscoveryError> {
    profile
        .validate()
        .map_err(|_| DiscoveryErrorCode::ProfileRejected)?;
    crate::provider_target::validate_credential_purpose(
        profile,
        &crate::provider_target::CredentialPurpose::Custom,
    )
    .map_err(|_| DiscoveryErrorCode::ProfileRejected)?;
    if profile.adapter != ProviderAdapter::OpenaiCompatible {
        return Err(DiscoveryErrorCode::ProfileRejected.into());
    }
    let raw = &profile.base_url;
    let url = url::Url::parse(raw).map_err(|_| DiscoveryErrorCode::ProfileRejected)?;
    let rest = raw
        .split_once("://")
        .ok_or(DiscoveryErrorCode::ProfileRejected)?
        .1;
    let authority = rest.split('/').next().unwrap_or("");
    let host = if authority.starts_with('[') {
        authority
            .split_once(']')
            .map(|(host, _)| &host[1..])
            .unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    };
    let ip: IpAddr = host
        .parse()
        .map_err(|_| DiscoveryErrorCode::ProfileRejected)?;
    if !ip.is_loopback()
        || !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || raw.chars().any(char::is_control)
        || raw.contains(['%', '\\'])
        || rest
            .split('/')
            .skip(1)
            .any(|part| matches!(part, "." | ".."))
    {
        return Err(DiscoveryErrorCode::ProfileRejected.into());
    }
    // Cookies and proxy credentials are never discovery credentials.
    if profile
        .public_headers
        .iter()
        .flat_map(|map| map.keys())
        .chain(profile.secret_header_refs.iter().flat_map(|map| map.keys()))
        .any(|key| {
            matches!(
                key.to_ascii_lowercase().as_str(),
                "cookie" | "cookie2" | "set-cookie" | "proxy-authorization"
            )
        })
    {
        return Err(DiscoveryErrorCode::ProfileRejected.into());
    }
    Ok(format!("{}/models", raw.trim_end_matches('/')))
}
pub(crate) struct Plan {
    protocol: Protocol,
    base: String,
    headers: HeaderMap,
    authenticated: bool,
}
pub(crate) fn plan(
    request: &DiscoveryRequest,
    store: &LocalStore,
    secrets: &dyn SecretStore,
) -> Result<Plan, DiscoveryError> {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    match &request.target {
        DiscoveryTarget::Candidate { candidate_id } => Ok(Plan {
            protocol: match candidate_id {
                Candidate::Ollama => Protocol::OllamaNative,
                Candidate::LmStudio => Protocol::LmStudioNative,
            },
            base: match candidate_id {
                Candidate::Ollama => "http://127.0.0.1:11434",
                Candidate::LmStudio => "http://127.0.0.1:1234",
            }
            .into(),
            headers,
            authenticated: false,
        }),
        DiscoveryTarget::Profile { profile_id } => {
            let document = store
                .get(profile_id)
                .map_err(|_| DiscoveryErrorCode::Failed)?
                .ok_or(DiscoveryErrorCode::ProfileNotFound)?;
            let profile = crate::provider_profile::parse_stored_profile(&document)
                .map_err(|_| DiscoveryErrorCode::ProfileRejected)?;
            if profile.id != *profile_id {
                return Err(DiscoveryErrorCode::ProfileRejected.into());
            }
            let base = profile_endpoint(&profile)?;
            headers = crate::ai::build_headers_for_purpose(
                &profile,
                secrets,
                &crate::provider_target::CredentialPurpose::Custom,
            )
            .map_err(|error| match error.code {
                crate::ai::DirectAiErrorCode::MissingSecret => DiscoveryErrorCode::MissingSecret,
                _ => DiscoveryErrorCode::ProfileRejected,
            })?;
            headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
            headers.remove(CONTENT_TYPE);
            Ok(Plan {
                protocol: Protocol::OpenaiCompatible,
                base,
                headers,
                authenticated: profile.api_key_ref.is_some()
                    || profile
                        .secret_header_refs
                        .as_ref()
                        .is_some_and(|map| !map.is_empty()),
            })
        }
    }
}
fn client() -> Result<Client, DiscoveryError> {
    Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        // Windows may defer a refused loopback connect. Keep connection work
        // inside the whole GET budget, without an earlier false timeout.
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|_| DiscoveryErrorCode::Failed.into())
}

/// The worker owns the single-flight lease while synchronous database/keychain
/// work runs. Cancelling the waiter cannot revoke an already-started OS read;
/// keeping its lease prevents retries from spawning unbounded blocking workers.
pub(crate) async fn discover_with_plan<F>(
    request: DiscoveryRequest,
    registry: &DiscoveryRegistry,
    prepare: F,
) -> Result<DiscoveryResponse, DiscoveryError>
where
    F: FnOnce(&DiscoveryRequest) -> Result<Plan, DiscoveryError> + Send + 'static,
{
    request.validate()?;
    let registration = registry.register(&request.request_id)?;
    let token = registration.token.clone();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
    let request_id = request.request_id.clone();
    let protocol = match &request.target {
        DiscoveryTarget::Candidate {
            candidate_id: Candidate::Ollama,
        } => Protocol::OllamaNative,
        DiscoveryTarget::Candidate {
            candidate_id: Candidate::LmStudio,
        } => Protocol::LmStudioNative,
        DiscoveryTarget::Profile { .. } => Protocol::OpenaiCompatible,
    };
    let mut pending = tokio::task::spawn_blocking(move || {
        let result = prepare(&request).and_then(|plan| client().map(|client| (plan, client)));
        (registration, result)
    });
    let (_registration, prepared) = tokio::select! {
        biased;
        _ = token.cancelled() => {
            pending.abort();
            return Ok(DiscoveryResponse::Cancelled { contract_version: 1, request_id });
        },
        _ = tokio::time::sleep_until(deadline) => {
            pending.abort();
            return Ok(DiscoveryResponse::Completed { contract_version: 1, request_id, service: Service::new(protocol, ServiceState::TimedOut) });
        },
        result = &mut pending => result.map_err(|_| DiscoveryErrorCode::Failed)?,
    };
    let (plan, client) = prepared?;
    tokio::select! {
        biased;
        _ = token.cancelled() => Ok(DiscoveryResponse::Cancelled { contract_version: 1, request_id }),
        _ = tokio::time::sleep_until(deadline) => Ok(DiscoveryResponse::Completed { contract_version: 1, request_id, service: Service::new(protocol, ServiceState::TimedOut) }),
        service = execute(&client, &plan) => Ok(DiscoveryResponse::Completed { contract_version: 1, request_id, service }),
    }
}

/// LOCAL-2 reuses exactly the LOCAL-1 fixed Ollama GET/parser/transport budgets.
/// It owns its own launch deadline, never changes the public discovery contract.
pub(crate) struct OllamaProbe {
    client: Client,
    plan: Plan,
}
impl OllamaProbe {
    pub(crate) fn new() -> Result<Self, DiscoveryError> {
        Self::at("http://127.0.0.1:11434".into())
    }
    fn at(base: String) -> Result<Self, DiscoveryError> {
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        Ok(Self {
            client: client()?,
            plan: Plan {
                protocol: Protocol::OllamaNative,
                base,
                headers,
                authenticated: false,
            },
        })
    }
    #[cfg(test)]
    pub(crate) fn fixture(base: String) -> Self {
        Self::at(base).unwrap()
    }
    pub(crate) async fn probe(&self) -> Service {
        tokio::time::timeout(Duration::from_secs(6), execute(&self.client, &self.plan))
            .await
            .unwrap_or_else(|_| {
                failed(
                    Protocol::OllamaNative,
                    ReadError(ServiceState::TimedOut, "timed-out"),
                )
            })
    }
}

struct HttpReply {
    status: u16,
    value: Option<Value>,
}
#[derive(Debug)]
struct ReadError(ServiceState, &'static str);
async fn get(client: &Client, endpoint: &str, headers: &HeaderMap) -> Result<HttpReply, ReadError> {
    let read = async {
        let response = client
            .get(endpoint)
            .headers(headers.clone())
            .send()
            .await
            .map_err(network_error)?;
        let status = response.status().as_u16();
        // Error bodies are never reflected or needed, including authentication challenges.
        if !(200..300).contains(&status) {
            return Ok(HttpReply {
                status,
                value: None,
            });
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_BODY as u64)
        {
            return Err(ReadError(
                ServiceState::UnsupportedResponse,
                "response-too-large",
            ));
        }
        let mut bytes = Vec::new();
        let mut chunks = response.bytes_stream();
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk.map_err(network_error)?;
            if bytes.len().saturating_add(chunk.len()) > MAX_BODY {
                return Err(ReadError(
                    ServiceState::UnsupportedResponse,
                    "response-too-large",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let value = serde_json::from_slice(&bytes)
            .map_err(|_| ReadError(ServiceState::UnsupportedResponse, "invalid-response"))?;
        Ok(HttpReply {
            status,
            value: Some(value),
        })
    };
    tokio::time::timeout(Duration::from_secs(3), read)
        .await
        .unwrap_or(Err(ReadError(ServiceState::TimedOut, "timed-out")))
}
fn network_error(error: reqwest::Error) -> ReadError {
    if error.is_timeout() {
        ReadError(ServiceState::TimedOut, "timed-out")
    } else if error.is_connect() {
        ReadError(ServiceState::Unreachable, "unreachable")
    } else {
        ReadError(ServiceState::Failed, "request-failed")
    }
}
fn failed(protocol: Protocol, error: ReadError) -> Service {
    let mut service = Service::new(protocol, error.0);
    service.error_code = Some(error.1.to_owned());
    service
}
fn status_error(status: u16, authenticated: bool) -> Option<ReadError> {
    if (200..300).contains(&status) {
        return None;
    }
    Some(match status {
        401 if authenticated => ReadError(ServiceState::AuthRejected, "auth-rejected"),
        401 => ReadError(ServiceState::AuthRequired, "auth-required"),
        403 => ReadError(ServiceState::AccessDenied, "access-denied"),
        _ => ReadError(ServiceState::UnsupportedResponse, "unexpected-status"),
    })
}
async fn execute(client: &Client, plan: &Plan) -> Service {
    let mut protocol = plan.protocol;
    let mut version = None;
    let endpoint = match protocol {
        Protocol::OllamaNative => {
            match get(client, &format!("{}/api/version", plan.base), &plan.headers).await {
                Err(error) => return failed(protocol, error),
                Ok(reply) => {
                    if reply.status != 404 {
                        if let Some(error) = status_error(reply.status, plan.authenticated) {
                            return failed(protocol, error);
                        }
                    }
                    if let Some(value) = reply.value {
                        match value.get("version") {
                            Some(Value::String(text)) if valid_text(text, 128) => {
                                version = Some(text.clone())
                            }
                            None if value.is_object() => {}
                            _ => {
                                return failed(
                                    protocol,
                                    ReadError(
                                        ServiceState::UnsupportedResponse,
                                        "invalid-response",
                                    ),
                                )
                            }
                        }
                    }
                }
            }
            format!("{}/api/tags", plan.base)
        }
        Protocol::LmStudioNative => format!("{}/api/v1/models", plan.base),
        Protocol::OpenaiCompatible => plan.base.clone(),
    };
    let mut reply = match get(client, &endpoint, &plan.headers).await {
        Ok(reply) => reply,
        Err(error) => return failed(protocol, error),
    };
    if matches!(protocol, Protocol::LmStudioNative) && matches!(reply.status, 404 | 405) {
        protocol = Protocol::OpenaiCompatible;
        reply = match get(client, &format!("{}/v1/models", plan.base), &plan.headers).await {
            Ok(reply) => reply,
            Err(error) => return failed(protocol, error),
        };
    }
    if let Some(error) = status_error(reply.status, plan.authenticated) {
        return failed(protocol, error);
    }
    let mut service = match project(protocol, reply.value.as_ref().unwrap_or(&Value::Null)) {
        Ok(service) => service,
        Err(error) => return failed(protocol, error),
    };
    service.version = version;
    service
}
fn project(protocol: Protocol, value: &Value) -> Result<Service, ReadError> {
    let invalid = || ReadError(ServiceState::UnsupportedResponse, "invalid-response");
    let entries = value
        .get(if matches!(protocol, Protocol::OpenaiCompatible) {
            "data"
        } else {
            "models"
        })
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if entries.len() > MAX_MODELS {
        return Err(ReadError(
            ServiceState::UnsupportedResponse,
            "too-many-models",
        ));
    }
    let mut models: Vec<Model> = Vec::new();
    let mut positions = std::collections::HashMap::<String, usize>::new();
    let mut excluded = std::collections::HashSet::new();
    for entry in entries {
        let id = match protocol {
            Protocol::OllamaNative => entry.get("model").or_else(|| entry.get("name")),
            Protocol::LmStudioNative => entry.get("key"),
            Protocol::OpenaiCompatible => entry.get("id"),
        }
        .and_then(Value::as_str)
        .filter(|id| valid_model_id(id))
        .ok_or_else(invalid)?;
        let kind = match protocol {
            Protocol::LmStudioNative => match entry.get("type") {
                Some(Value::String(kind)) if kind == "llm" => "llm",
                Some(Value::String(kind))
                    if matches!(
                        kind.as_str(),
                        "embedding" | "embeddings" | "decision" | "reranker" | "rerank"
                    ) =>
                {
                    excluded.insert(id.to_owned());
                    continue;
                }
                None | Some(Value::String(_)) => "unknown",
                _ => return Err(invalid()),
            },
            Protocol::OllamaNative => match entry.get("capabilities") {
                Some(Value::Array(capabilities)) => {
                    let capabilities: Vec<&str> = capabilities
                        .iter()
                        .map(Value::as_str)
                        .collect::<Option<_>>()
                        .ok_or_else(invalid)?;
                    if capabilities.contains(&"completion") {
                        "llm"
                    } else if capabilities.iter().any(|kind| {
                        matches!(
                            *kind,
                            "embedding" | "embeddings" | "decision" | "reranker" | "rerank"
                        )
                    }) {
                        excluded.insert(id.to_owned());
                        continue;
                    } else {
                        "unknown"
                    }
                }
                None => "unknown",
                _ => return Err(invalid()),
            },
            Protocol::OpenaiCompatible => "unknown",
        };
        let loaded = match protocol {
            Protocol::LmStudioNative => match entry.get("loaded_instances") {
                Some(Value::Array(instances)) if instances.is_empty() => "no",
                Some(Value::Array(_)) => "yes",
                None => "unknown",
                _ => return Err(invalid()),
            },
            _ => "unknown",
        };
        let lower = id.to_ascii_lowercase();
        let remote = entry.get("remote_model").is_some_and(|v| !v.is_null())
            || entry.get("remote_host").is_some_and(|v| !v.is_null())
            || lower.ends_with(":cloud")
            || lower.ends_with("-cloud")
            || lower.contains(":cloud-");
        let label = entry
            .get("display_name")
            .or_else(|| entry.get("name"))
            .and_then(Value::as_str)
            .filter(|label| valid_text(label, 200))
            .map(str::to_owned);
        if let Some(index) = positions.get(id) {
            let existing = &mut models[*index];
            if remote {
                existing.execution = "remote-indicated".into();
            }
            if existing.kind != kind {
                existing.kind = "unknown".into();
            }
            if existing.loaded != loaded {
                existing.loaded = "unknown".into();
            }
        } else {
            positions.insert(id.to_owned(), models.len());
            models.push(Model {
                id: id.to_owned(),
                label,
                kind: kind.into(),
                loaded: loaded.into(),
                execution: if remote {
                    "remote-indicated"
                } else {
                    "unknown"
                }
                .into(),
            });
        }
    }
    // Conflicting entries cannot erase explicit incompatible/remote evidence.
    models.retain(|model| !excluded.contains(&model.id));
    let state = if entries.is_empty() {
        ServiceState::NoModels
    } else if !models
        .iter()
        .any(|model| model.execution != "remote-indicated")
    {
        ServiceState::NoCompatibleModels
    } else {
        ServiceState::Reachable
    };
    let mut service = Service::new(protocol, state);
    service.models = models;
    Ok(service)
}

#[cfg(test)]
#[path = "local_ai_discovery_tests.rs"]
mod tests;
