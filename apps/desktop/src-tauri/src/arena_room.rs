//! 固定 Room consumer 编排。所有权限、凭据、Document 与连接代次保留在 Native。
//! HTTP 成功不表示在线；只有当前连接的 snapshot + 受检 presence 可以建立在线状态。

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::arena_room_http::{HttpRequest, RoomHttp};
use crate::arena_room_protocol::{
    self as protocol, Action, Operation, Request, RoomError, SubscribeRequest,
};
use crate::arena_room_socket::RoomSocket;
use crate::arena_room_state::{
    DeliveryQueue, DocumentId, DocumentProof, DocumentState, InstanceToken,
};

pub(crate) type Notify = Arc<dyn Fn(String) -> Result<(), RoomError> + Send + Sync>;
type AccountCheck = Arc<dyn Fn() -> Result<bool, RoomError> + Send + Sync>;

/// 私有受保护槽的 lease 适配；故意不实现 Debug/Serialize。
/// current/clear 由平台层捕获原 lease 调用，禁止把 IO 错误伪装成凭据失效。
pub(crate) struct AccountAccess {
    pub(crate) user_id: u64,
    pub(crate) epoch: u64,
    pub(crate) cancel: CancellationToken,
    cookie: String,
    current: AccountCheck,
    clear: AccountCheck,
}

impl AccountAccess {
    pub(crate) fn new(
        user_id: u64,
        epoch: u64,
        cancel: CancellationToken,
        cookie: String,
        current: AccountCheck,
        clear: AccountCheck,
    ) -> Self {
        Self {
            user_id,
            epoch,
            cancel,
            cookie,
            current,
            clear,
        }
    }

    pub(crate) fn is_current(&self) -> Result<bool, RoomError> {
        if self.cancel.is_cancelled() {
            return Ok(false);
        }
        (self.current)()
    }
}

pub(crate) enum EngineReply {
    Small(Value),
    /// 已按完整序列化输出计费，Tauri 必须作为 Json 原样返回，不能再封套或转义。
    Json(String),
}

pub(crate) struct RoomState {
    http: Arc<RoomHttp>,
    instances: Mutex<HashMap<InstanceToken, Weak<RoomInstance>>>,
}

impl RoomState {
    pub(crate) fn new() -> Result<Self, RoomError> {
        Ok(Self {
            http: Arc::new(RoomHttp::new()?),
            instances: Mutex::new(HashMap::new()),
        })
    }

    /// token 只能来自真实 ResourceTable marker；父层禁止从 renderer/label 派生。
    pub(crate) fn instance(&self, token: InstanceToken) -> Arc<RoomInstance> {
        let mut instances = self
            .instances
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(instance) = instances.get(&token).and_then(Weak::upgrade) {
            return instance;
        }
        instances.retain(|_, instance| instance.strong_count() > 0);
        let instance = Arc::new(RoomInstance::new(token, self.http.clone()));
        instances.insert(token, Arc::downgrade(&instance));
        instance
    }
}

#[derive(Clone)]
struct ScopeContext {
    handle: String,
    subscription_id: String,
    proof: DocumentProof,
    account: Arc<AccountAccess>,
    cancel: CancellationToken,
}

struct Scope {
    context: ScopeContext,
    notify: Notify,
    session: Option<Authority>,
    socket_cancel: Option<CancellationToken>,
}

#[derive(Clone)]
struct IntentReceipt {
    document: DocumentId,
    handle: String,
    subscription_id: String,
    batch_id: String,
    sequence: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum IntentPhase {
    InFlight,
    AwaitingAck,
    Unknown,
}

struct PendingIntent {
    id: String,
    operation: Operation,
    room_id: Option<String>,
    frozen_request: Value,
    account: Arc<AccountAccess>,
    phase: IntentPhase,
    receipt: Option<IntentReceipt>,
}

impl PendingIntent {
    fn public(&self) -> Value {
        json!({"intentId":self.id,"operation":self.operation.as_str(),"roomId":self.room_id})
    }
}

struct Inner {
    delivery: DeliveryQueue,
    scope: Option<Scope>,
    pending: Option<PendingIntent>,
    destroyed: bool,
}

pub(crate) struct RoomInstance {
    token: InstanceToken,
    pub(crate) document: Mutex<DocumentState>,
    inner: Mutex<Inner>,
    http: Arc<RoomHttp>,
    // 真实任务持有 permit。退休/cancel/Document 重建不能凭空释放容量。
    http_slot: Arc<Semaphore>,
    socket_slot: Arc<Semaphore>,
    #[cfg(test)]
    test_socket: Option<std::net::SocketAddr>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
fn stale() -> RoomError {
    RoomError::new("scope-changed", "not-applicable")
}
fn busy() -> RoomError {
    RoomError::new("busy", "not-applied")
}
fn invalid() -> RoomError {
    RoomError::new("invalid-response", "not-applicable")
}
pub(crate) fn random_id() -> Result<String, RoomError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| RoomError::new("internal-error", "not-applicable"))?;
    let mut result = String::with_capacity(64);
    for byte in bytes {
        use std::fmt::Write;
        write!(&mut result, "{byte:02x}")
            .map_err(|_| RoomError::new("internal-error", "not-applicable"))?;
    }
    Ok(result)
}

impl RoomInstance {
    fn new(token: InstanceToken, http: Arc<RoomHttp>) -> Self {
        Self {
            token,
            document: Mutex::new(DocumentState::new(token)),
            inner: Mutex::new(Inner {
                delivery: DeliveryQueue::new(token),
                scope: None,
                pending: None,
                destroyed: false,
            }),
            http,
            http_slot: Arc::new(Semaphore::new(1)),
            socket_slot: Arc::new(Semaphore::new(1)),
            #[cfg(test)]
            test_socket: None,
        }
    }

    pub(crate) fn instance_token(&self) -> InstanceToken {
        self.token
    }

    /// 新 attach 的 Document 证明推进后立即撤销旧网络，不等下一帧。
    pub(crate) fn revoke_stale_scope(&self) {
        let mut inner = lock(&self.inner);
        let stale = inner.scope.as_ref().is_some_and(|scope| {
            !lock(&self.document).is_current(&scope.context.proof, scope.context.account.epoch)
        });
        if stale {
            Self::retire_locked(&mut inner);
        }
    }

    fn retire_locked(inner: &mut Inner) {
        if let Some(scope) = inner.scope.take() {
            // A retired ACK can prove only discarded bytes were released, not that the
            // current consumer accepted the mutation's result. Keep its original intent.
            Self::delivery_failed(inner, &scope.context);
            scope.context.cancel.cancel();
            if let Some(socket) = scope.socket_cancel {
                socket.cancel();
            }
        }
        inner.delivery.retire();
    }

    pub(crate) fn page_started(&self) -> Result<(), RoomError> {
        let mut inner = lock(&self.inner);
        Self::retire_locked(&mut inner);
        inner.delivery.revoke_document(self.token);
        lock(&self.document).page_started(self.token)
    }

    pub(crate) fn page_finished(&self) -> Result<DocumentId, RoomError> {
        let mut inner = lock(&self.inner);
        Self::retire_locked(&mut inner);
        inner.delivery.revoke_document(self.token);
        lock(&self.document).page_finished(self.token)
    }

    pub(crate) fn destroyed(&self) -> bool {
        let mut inner = lock(&self.inner);
        if inner.destroyed {
            return false;
        }
        Self::retire_locked(&mut inner);
        inner.destroyed = true;
        inner.pending = None;
        inner.delivery.destroy(self.token);
        lock(&self.document).destroyed(self.token)
    }

    pub(crate) fn finish_attach(
        self: &Arc<Self>,
        proof: DocumentProof,
        account: Arc<AccountAccess>,
        notify: Notify,
    ) -> Result<Value, RoomError> {
        if !account.is_current()? {
            return Err(stale());
        }
        let handle = random_id()?;
        let subscription_id = random_id()?;
        let batch_prefix = random_id()?;
        let mut inner = lock(&self.inner);
        if inner.destroyed
            || !lock(&self.document).is_current(&proof, account.epoch)
            || !account.is_current()?
        {
            return Err(stale());
        }
        Self::retire_locked(&mut inner);
        if inner.pending.as_ref().is_some_and(|pending| {
            pending.account.user_id != account.user_id
                || pending.account.epoch != account.epoch
                || pending.account.cancel.is_cancelled()
        }) {
            inner.pending = None;
        }
        if let Some(pending) = &mut inner.pending {
            if pending.phase == IntentPhase::AwaitingAck {
                pending.phase = IntentPhase::Unknown;
                pending.receipt = None;
            }
        }
        inner.delivery.activate(
            proof.document,
            handle.clone(),
            subscription_id.clone(),
            batch_prefix,
        )?;
        let pending = inner
            .pending
            .as_ref()
            .map(PendingIntent::public)
            .unwrap_or(Value::Null);
        let context = ScopeContext {
            handle: handle.clone(),
            subscription_id: subscription_id.clone(),
            proof,
            cancel: account.cancel.child_token(),
            account,
        };
        inner.scope = Some(Scope {
            context: context.clone(),
            notify,
            session: None,
            socket_cancel: None,
        });
        drop(inner);
        // The account token actively cancels sockets/HTTP even with no incoming frames.
        self.watch_account(context);
        Ok(json!({"handle":handle,"subscriptionId":subscription_id,"pendingIntent":pending}))
    }

    fn watch_account(self: &Arc<Self>, context: ScopeContext) {
        let this = self.clone();
        tokio::spawn(async move {
            tokio::select! {
                biased;
                _ = context.account.cancel.cancelled() => {
                    let mut inner = lock(&this.inner);
                    if inner.scope.as_ref().is_some_and(|scope| scope.context.handle == context.handle
                        && scope.context.subscription_id == context.subscription_id) {
                        Self::retire_locked(&mut inner);
                        let _ = lock(&this.document).revoke_account(this.token);
                        if inner.pending.as_ref().is_some_and(|pending| pending.account.epoch == context.account.epoch
                            && pending.account.user_id == context.account.user_id) { inner.pending = None; }
                    }
                }
                _ = context.cancel.cancelled() => {}
            }
        });
    }

    fn identity_current_locked(&self, inner: &Inner, context: &ScopeContext) -> bool {
        !inner.destroyed
            && !context.cancel.is_cancelled()
            && !context.account.cancel.is_cancelled()
            && lock(&self.document).is_current(&context.proof, context.account.epoch)
            && inner.scope.as_ref().is_some_and(|scope| {
                scope.context.handle == context.handle
                    && scope.context.subscription_id == context.subscription_id
            })
    }

    fn delivery_failed(inner: &mut Inner, context: &ScopeContext) {
        if let Some(pending) = &mut inner.pending {
            if pending.receipt.as_ref().is_some_and(|receipt| {
                receipt.handle == context.handle
                    && receipt.subscription_id == context.subscription_id
            }) {
                pending.phase = IntentPhase::Unknown;
                pending.receipt = None;
            }
        }
    }

    fn notify_identity_locked(
        &self,
        inner: &mut Inner,
        context: &ScopeContext,
    ) -> Result<(), RoomError> {
        if !self.identity_current_locked(inner, context) {
            return Err(stale());
        }
        let notify = inner.scope.as_ref().ok_or_else(stale)?.notify.clone();
        if let Some(notification) = inner.delivery.take_notification(
            context.proof.document,
            &context.handle,
            &context.subscription_id,
        )? {
            if let Err(error) = notify(notification) {
                Self::delivery_failed(inner, context);
                Self::retire_locked(inner);
                return Err(error);
            }
        }
        Ok(())
    }

    fn current_locked(&self, inner: &Inner, context: &ScopeContext) -> Result<(), RoomError> {
        if inner.destroyed
            || context.cancel.is_cancelled()
            || !context.account.is_current()?
            || !lock(&self.document).is_current(&context.proof, context.account.epoch)
            || !inner.scope.as_ref().is_some_and(|scope| {
                scope.context.handle == context.handle
                    && scope.context.subscription_id == context.subscription_id
            })
        {
            return Err(stale());
        }
        Ok(())
    }

    fn scope_for(
        &self,
        inner: &Inner,
        document: DocumentId,
        handle: &str,
    ) -> Result<ScopeContext, RoomError> {
        let context = inner.scope.as_ref().ok_or_else(stale)?.context.clone();
        if context.handle != handle || context.proof.document != document {
            return Err(stale());
        }
        self.current_locked(inner, &context)?;
        Ok(context)
    }

    fn current(&self, context: &ScopeContext) -> Result<(), RoomError> {
        self.current_locked(&lock(&self.inner), context)
    }

    fn notify_locked(&self, inner: &mut Inner, context: &ScopeContext) -> Result<(), RoomError> {
        self.current_locked(inner, context)?;
        let notify = inner.scope.as_ref().ok_or_else(stale)?.notify.clone();
        let notification = inner.delivery.take_notification(
            context.proof.document,
            &context.handle,
            &context.subscription_id,
        )?;
        if let Some(notification) = notification {
            // Callback must be a non-reentrant platform send. Debt has already been reserved.
            if notify(notification).is_err() {
                Self::delivery_failed(inner, context);
                Self::retire_locked(inner);
                return Err(RoomError::new("network-error", "not-applicable"));
            }
        }
        Ok(())
    }

    fn publish(&self, context: &ScopeContext, event: &Value) -> Result<(), RoomError> {
        let mut inner = lock(&self.inner);
        self.current_locked(&inner, context)?;
        if let Err(error) = inner.delivery.enqueue(event) {
            Self::delivery_failed(&mut inner, context);
            if let Some(scope) = &mut inner.scope {
                if let Some(cancel) = scope.socket_cancel.take() {
                    cancel.cancel();
                }
                if let Some(session) = &mut scope.session {
                    session.offline();
                }
            }
            let _ = self.notify_locked(&mut inner, context);
            return Err(error);
        }
        self.notify_locked(&mut inner, context)
    }

    fn status(
        &self,
        context: &ScopeContext,
        state: &str,
        code: Option<&str>,
    ) -> Result<(), RoomError> {
        let mut event = json!({"kind":"status","state":state});
        if let Some(code) = code {
            event["code"] = json!(code);
        }
        self.publish(context, &event)
    }

    pub(crate) fn detach(&self, document: DocumentId, handle: &str) -> Result<Value, RoomError> {
        let mut inner = lock(&self.inner);
        let detached = inner.scope.as_ref().is_some_and(|scope| {
            scope.context.handle == handle && scope.context.proof.document == document
        });
        if detached {
            Self::retire_locked(&mut inner);
        }
        Ok(json!({"detached":detached}))
    }

    pub(crate) fn request(
        self: &Arc<Self>,
        document: DocumentId,
        input: Request,
    ) -> Result<EngineReply, RoomError> {
        match input.action {
            Action::Pull { subscription_id } => {
                let mut inner = lock(&self.inner);
                let context = inner.scope.as_ref().ok_or_else(stale)?.context.clone();
                if context.handle != input.handle
                    || context.proof.document != document
                    || context.subscription_id != subscription_id
                {
                    return Err(stale());
                }
                self.current_locked(&inner, &context)?;
                let body = inner
                    .delivery
                    .pull(document, &input.handle, &subscription_id)?;
                Ok(match body {
                    Some(body) => EngineReply::Json(body),
                    None => EngineReply::Small(
                        json!({"kind":"empty","handle":input.handle,"subscriptionId":subscription_id}),
                    ),
                })
            }
            Action::Ack {
                subscription_id,
                batch_id,
                sequence,
            } => {
                let mut inner = lock(&self.inner);
                // Retired same-Document ack is local only; it cannot require/renew an account lease.
                let accepted = match inner.delivery.ack(
                    document,
                    &input.handle,
                    &subscription_id,
                    &batch_id,
                    sequence,
                ) {
                    Ok(accepted) => accepted,
                    Err(error) => {
                        if let Some(context) =
                            inner.scope.as_ref().map(|scope| scope.context.clone())
                        {
                            Self::delivery_failed(&mut inner, &context);
                        }
                        return Err(error);
                    }
                };
                if accepted
                    && inner.pending.as_ref().is_some_and(|pending| {
                        pending.phase == IntentPhase::AwaitingAck
                            && pending.receipt.as_ref().is_some_and(|receipt| {
                                receipt.document == document
                                    && receipt.handle == input.handle
                                    && receipt.subscription_id == subscription_id
                                    && receipt.batch_id == batch_id
                                    && receipt.sequence == sequence
                            })
                    })
                {
                    inner.pending = None;
                }
                if let Some(context) = inner
                    .scope
                    .as_ref()
                    .filter(|scope| {
                        scope.context.handle == input.handle
                            && scope.context.subscription_id == subscription_id
                    })
                    .map(|scope| scope.context.clone())
                {
                    self.notify_locked(&mut inner, &context)?;
                }
                Ok(EngineReply::Small(
                    json!({"kind":"acknowledged","handle":input.handle,
                    "subscriptionId":subscription_id,"batchId":batch_id,"sequence":sequence,"accepted":accepted}),
                ))
            }
            action => self.start_http(document, input.handle, action),
        }
    }

    fn start_http(
        self: &Arc<Self>,
        document: DocumentId,
        handle: String,
        action: Action,
    ) -> Result<EngineReply, RoomError> {
        let permit = self
            .http_slot
            .clone()
            .try_acquire_owned()
            .map_err(|_| busy())?;
        let mut inner = lock(&self.inner);
        let context = self.scope_for(&inner, document, &handle)?;
        if inner.pending.as_ref().is_some_and(|pending| {
            pending.account.cancel.is_cancelled()
                || pending.account.epoch != context.account.epoch
                || pending.account.user_id != context.account.user_id
        }) {
            inner.pending = None;
        }
        let resume_id = if let Action::ResumeCreate { intent_id } = &action {
            Some(intent_id.clone())
        } else {
            None
        };
        let request = match action {
            Action::Discover { query } => HttpRequest {
                operation: Operation::Discover,
                room_id: None,
                request: query,
                resume_only: false,
            },
            Action::Create { request } => HttpRequest {
                operation: Operation::Create,
                room_id: None,
                request,
                resume_only: false,
            },
            Action::ResumeCreate { intent_id } => {
                let pending = inner
                    .pending
                    .as_ref()
                    .ok_or_else(|| RoomError::new("invalid-request", "not-applied"))?;
                if pending.id != intent_id
                    || pending.operation != Operation::Create
                    || pending.phase != IntentPhase::Unknown
                    || !pending.account.is_current()?
                {
                    return Err(busy());
                }
                HttpRequest {
                    operation: Operation::Create,
                    room_id: None,
                    request: pending.frozen_request.clone(),
                    resume_only: true,
                }
            }
            Action::Join { room_id, request } => HttpRequest {
                operation: Operation::Join,
                room_id: Some(room_id),
                request,
                resume_only: false,
            },
            Action::Session { room_id } => HttpRequest {
                operation: Operation::Session,
                room_id: Some(room_id),
                request: json!({}),
                resume_only: false,
            },
            Action::Leave {
                room_id,
                expected_room_epoch,
            } => HttpRequest {
                operation: Operation::Leave,
                room_id: Some(room_id),
                request: json!({"expectedRoomEpoch":expected_room_epoch}),
                resume_only: false,
            },
            Action::Close {
                room_id,
                expected_room_epoch,
            } => HttpRequest {
                operation: Operation::Close,
                room_id: Some(room_id),
                request: json!({"expectedRoomEpoch":expected_room_epoch}),
                resume_only: false,
            },
            Action::Pull { .. } | Action::Ack { .. } => {
                return Err(RoomError::new("invalid-request", "not-applied"))
            }
        };
        if request.operation.is_post() && inner.pending.is_some() && resume_id.is_none() {
            return Err(busy());
        }
        if matches!(request.operation, Operation::Leave | Operation::Close) {
            let session = inner
                .scope
                .as_ref()
                .and_then(|scope| scope.session.as_ref())
                .ok_or_else(stale)?;
            if request.room_id.as_deref() != Some(session.room_id.as_str())
                || request.request["expectedRoomEpoch"].as_str()
                    != Some(session.room_epoch.as_str())
                || (request.operation == Operation::Close && session.self_role != "host")
            {
                return Err(stale());
            }
        }
        let request_id = random_id()?;
        let new_intent_id = if request.operation.is_post() {
            Some(resume_id.unwrap_or(random_id()?))
        } else {
            None
        };
        if let Err(error) = inner
            .delivery
            .reserve_http_terminal(&request_id, request.operation)
        {
            Self::delivery_failed(&mut inner, &context);
            if let Some(scope) = &mut inner.scope {
                if let Some(cancel) = scope.socket_cancel.take() {
                    cancel.cancel();
                }
                if let Some(session) = &mut scope.session {
                    session.offline();
                }
            }
            let _ = self.notify_locked(&mut inner, &context);
            return Err(error);
        }
        let intent_id = if request.operation.is_post() {
            let id = new_intent_id.expect("mutation identifier prepared");
            inner.pending = Some(PendingIntent {
                id: id.clone(),
                operation: request.operation,
                room_id: request.room_id.clone(),
                frozen_request: request.request.clone(),
                account: context.account.clone(),
                phase: IntentPhase::InFlight,
                receipt: None,
            });
            Some(id)
        } else {
            None
        };
        if request.operation != Operation::Discover {
            if let Some(scope) = &mut inner.scope {
                if let Some(socket) = scope.socket_cancel.take() {
                    socket.cancel();
                }
                if let Some(session) = &mut scope.session {
                    session.offline();
                }
            }
        }
        let accepted = json!({"kind":"accepted","handle":handle,"subscriptionId":context.subscription_id,"requestId":request_id});
        drop(inner);
        let this = self.clone();
        tokio::spawn(async move {
            this.run_http(context, request_id, request, intent_id, permit)
                .await;
        });
        Ok(EngineReply::Small(accepted))
    }

    async fn run_http(
        self: Arc<Self>,
        context: ScopeContext,
        request_id: String,
        request: HttpRequest,
        intent_id: Option<String>,
        _permit: OwnedSemaphorePermit,
    ) {
        let operation = request.operation;
        let mut outcome = match self.current(&context) {
            Ok(()) => {
                self.http
                    .execute(
                        &request,
                        context.account.user_id,
                        &context.account.cookie,
                        &context.cancel,
                    )
                    .await
            }
            Err(mut error) => {
                error.outcome = if operation.is_post() {
                    "not-applied"
                } else {
                    "not-applicable"
                };
                Err(error)
            }
        };
        let account_current = context.account.is_current();
        let fresh = self.current(&context);
        if fresh.is_ok() {
            if let Ok(response) = &outcome {
                if let Err(mut error) = self.install_http(&context, &request, response) {
                    error.outcome = if operation.is_post() {
                        "unknown"
                    } else {
                        "not-applicable"
                    };
                    outcome = Err(error);
                }
            }
        }
        let not_applied = outcome
            .as_ref()
            .is_err_and(|error| error.outcome == "not-applied");
        let unknown = outcome
            .as_ref()
            .is_err_and(|error| error.outcome == "unknown");
        if let Err(error) = &outcome {
            if error.code == "not-authenticated"
                && fresh.is_ok()
                && account_current.as_ref().is_ok_and(|current| *current)
            {
                // This path has its own reserved, body-free terminal notification. A
                // credential cancellation cannot swallow an already accepted request.
                let _ = self.revoke_http_auth(
                    &context,
                    error,
                    intent_id.as_deref(),
                    request.resume_only,
                    false,
                );
                return;
            }
        }
        // A failing keyring read permits only a fixed local failure, never the HTTP body.
        let storage_error = account_current
            .as_ref()
            .err()
            .filter(|error| error.code == "storage-unavailable")
            .cloned()
            .or_else(|| {
                fresh
                    .as_ref()
                    .err()
                    .filter(|error| error.code == "storage-unavailable")
                    .cloned()
            })
            .or_else(|| {
                outcome
                    .as_ref()
                    .err()
                    .filter(|error| error.code == "storage-unavailable")
                    .cloned()
            });
        let pending = {
            let mut inner = lock(&self.inner);
            let current = self.current_locked(&inner, &context);
            let storage_error = storage_error.or_else(|| {
                current
                    .as_ref()
                    .err()
                    .filter(|error| error.code == "storage-unavailable")
                    .cloned()
            });
            let may_deliver = match &current {
                Ok(()) => true,
                Err(error) if error.code == "storage-unavailable" => {
                    self.identity_current_locked(&inner, &context)
                }
                Err(_) => false,
            };
            if let Some(mut error) = storage_error {
                error.outcome = if operation.is_post() {
                    if not_applied {
                        "not-applied"
                    } else {
                        "unknown"
                    }
                } else {
                    "not-applicable"
                };
                if may_deliver {
                    let _ = self.revoke_http_storage_locked(
                        &mut inner,
                        &context,
                        &error,
                        intent_id.as_deref(),
                        request.resume_only,
                    );
                } else if inner
                    .pending
                    .as_ref()
                    .is_some_and(|pending| intent_id.as_ref() == Some(&pending.id))
                {
                    if not_applied && !request.resume_only {
                        inner.pending = None;
                    } else {
                        let pending = inner.pending.as_mut().expect("matching pending");
                        pending.phase = IntentPhase::Unknown;
                        pending.receipt = None;
                    }
                }
                return;
            }
            let event = match &outcome {
                Ok(response) => {
                    json!({"kind":"http-result","requestId":request_id,"operation":operation.as_str(),"response":response})
                }
                Err(error) => {
                    json!({"kind":"request-error","requestId":request_id,"operation":operation.as_str(),"error":error})
                }
            };
            let mut receipt = None;
            let original_queued = if may_deliver {
                match inner.delivery.finish_http_terminal(&event) {
                    Ok(original) => {
                        receipt =
                            inner
                                .delivery
                                .http_terminal_batch()
                                .map(|(batch_id, sequence)| IntentReceipt {
                                    document: context.proof.document,
                                    handle: context.handle.clone(),
                                    subscription_id: context.subscription_id.clone(),
                                    batch_id,
                                    sequence,
                                });
                        original
                    }
                    Err(_) => false,
                }
            } else {
                false
            };
            // Install the receipt before notifying: an immediate renderer ACK must see it.
            if let Some(id) = &intent_id {
                if inner
                    .pending
                    .as_ref()
                    .is_some_and(|pending| pending.id == *id)
                {
                    if matches!(account_current, Ok(false)) || (not_applied && !request.resume_only)
                    {
                        inner.pending = None;
                    } else if unknown || fresh.is_err() || !original_queued || outcome.is_err() {
                        let pending = inner.pending.as_mut().expect("matching pending");
                        pending.phase = IntentPhase::Unknown;
                        pending.receipt = None;
                    } else {
                        let pending = inner.pending.as_mut().expect("matching pending");
                        pending.phase = IntentPhase::AwaitingAck;
                        pending.receipt = receipt;
                    }
                }
            } else if operation == Operation::Session && fresh.is_ok() && original_queued {
                let absence = outcome.as_ref().is_err_and(|error| {
                    error.code == "service-rejected"
                        && matches!(error.server_code, Some("ROOM_NOT_FOUND" | "ROOM_FORBIDDEN"))
                });
                if (absence || outcome.is_ok())
                    && inner.pending.as_ref().is_some_and(|pending| {
                        pending.phase == IntentPhase::Unknown
                            && pending.operation != Operation::Create
                            && pending.room_id == request.room_id
                            && pending.account.user_id == context.account.user_id
                            && pending.account.epoch == context.account.epoch
                    })
                {
                    let pending = inner.pending.as_mut().expect("matched reconciliation");
                    pending.phase = IntentPhase::AwaitingAck;
                    pending.receipt = receipt;
                    if absence {
                        if let Some(scope) = &mut inner.scope {
                            scope.session = None;
                        }
                    }
                }
            }
            if may_deliver {
                // The raw lease was checked in this critical section. Do not open
                // another keyring failure window after consuming the terminal reserve.
                if self.notify_identity_locked(&mut inner, &context).is_err() {
                    Self::delivery_failed(&mut inner, &context);
                }
            }
            inner
                .pending
                .as_ref()
                .filter(|pending| {
                    intent_id.as_ref() == Some(&pending.id) && pending.phase == IntentPhase::Unknown
                })
                .map(PendingIntent::public)
        };
        if let Some(mut pending) = pending {
            pending["kind"] = json!("mutation-unknown");
            let _ = self.publish(&context, &pending);
        }
    }

    /// Fixed storage failures must bypass unconsumed bodies using the original
    /// terminal reserve; retirement never refunds bytes already handed to Tauri.
    fn revoke_http_storage_locked(
        &self,
        inner: &mut Inner,
        context: &ScopeContext,
        failure: &RoomError,
        intent_id: Option<&str>,
        resume_only: bool,
    ) -> Result<(), RoomError> {
        if inner
            .pending
            .as_ref()
            .is_some_and(|pending| intent_id == Some(pending.id.as_str()))
        {
            if failure.outcome == "not-applied" && !resume_only {
                inner.pending = None;
            } else {
                let pending = inner.pending.as_mut().expect("matching pending");
                pending.phase = IntentPhase::Unknown;
                pending.receipt = None;
            }
        }
        if !self.identity_current_locked(inner, context) {
            return Err(stale());
        }
        let notify = inner.scope.as_ref().expect("matched scope").notify.clone();
        let sent = match inner.delivery.take_http_revoked(failure) {
            Ok(notification) => notify(notification),
            Err(error) => Err(error),
        };
        Self::retire_locked(inner);
        sent
    }

    fn revoke_http_auth(
        &self,
        context: &ScopeContext,
        failure: &RoomError,
        intent_id: Option<&str>,
        resume_only: bool,
        subscription: bool,
    ) -> Result<(), RoomError> {
        let mut inner = lock(&self.inner);
        if let Err(mut error) = self.current_locked(&inner, context) {
            if !subscription && error.code == "storage-unavailable" {
                error.outcome = failure.outcome;
                return self.revoke_http_storage_locked(
                    &mut inner,
                    context,
                    &error,
                    intent_id,
                    resume_only,
                );
            }
            drop(inner);
            if subscription {
                self.subscription_error(context, &error);
            }
            return Err(error);
        }
        let notify = inner.scope.as_ref().ok_or_else(stale)?.notify.clone();
        // No network await under this lock. The conditional keyring operation and
        // immediate token cancellation are serialized against the watcher retirement.
        let clear = (context.account.clear)();
        let notification_error = match clear {
            Ok(false) => {
                // Another raw+epoch already won. Never emit a new-owner authentication
                // claim or clear that account through this old completion.
                Self::retire_locked(&mut inner);
                return Err(stale());
            }
            Ok(true) => {
                if inner.pending.as_ref().is_some_and(|pending| {
                    pending.account.epoch == context.account.epoch
                        && pending.account.user_id == context.account.user_id
                }) {
                    let pending = inner.pending.as_mut().expect("matched original owner");
                    pending.phase = IntentPhase::Unknown;
                    pending.receipt = None;
                }
                failure.clone()
            }
            Err(mut storage) => {
                storage.outcome = failure.outcome;
                if let Some(pending) = &mut inner.pending {
                    if intent_id == Some(pending.id.as_str()) {
                        pending.phase = IntentPhase::Unknown;
                        pending.receipt = None;
                    }
                }
                if failure.outcome == "not-applied"
                    && !resume_only
                    && inner
                        .pending
                        .as_ref()
                        .is_some_and(|pending| intent_id == Some(pending.id.as_str()))
                {
                    inner.pending = None;
                }
                storage
            }
        };
        // The lease may now be cancelled by OUR successful clear. Only this closed
        // fixed failure is sent; no account authority is renewed and no body is read.
        let notification = match if subscription {
            inner
                .delivery
                .take_subscription_revoked(&notification_error)
        } else {
            inner.delivery.take_http_revoked(&notification_error)
        } {
            Ok(notification) => notification,
            Err(error) => {
                Self::retire_locked(&mut inner);
                return Err(error);
            }
        };
        let sent = notify(notification);
        Self::retire_locked(&mut inner);
        sent
    }

    /// Storage read failures do not authorize credential deletion or response bodies.
    /// The subscription's pre-reserved small terminal is safe only for its original
    /// Document and uncancelled lease identity. A racing retirement wins atomically.
    fn subscription_error(&self, context: &ScopeContext, failure: &RoomError) {
        if failure.code != "storage-unavailable" {
            return;
        }
        let mut inner = lock(&self.inner);
        if !self.identity_current_locked(&inner, context) {
            return;
        }
        let notify = inner.scope.as_ref().expect("matched scope").notify.clone();
        if let Ok(notification) = inner.delivery.take_subscription_revoked(failure) {
            let _ = notify(notification);
        }
        Self::retire_locked(&mut inner);
    }

    fn subscription_current(&self, context: &ScopeContext) -> Result<(), RoomError> {
        let result = self.current(context);
        if let Err(error) = &result {
            self.subscription_error(context, error);
        }
        result
    }

    fn subscription_status(
        &self,
        context: &ScopeContext,
        status: &str,
        code: Option<&'static str>,
    ) -> Result<(), RoomError> {
        let result = self.status(context, status, code);
        if let Err(error) = &result {
            self.subscription_error(context, error);
        }
        result
    }

    fn install_http(
        &self,
        context: &ScopeContext,
        request: &HttpRequest,
        response: &Value,
    ) -> Result<(), RoomError> {
        let mut inner = lock(&self.inner);
        self.current_locked(&inner, context)?;
        let result = &response["result"];
        match request.operation {
            Operation::Create | Operation::Join | Operation::Session => {
                let authority = Authority::from_session(result)?;
                if request
                    .room_id
                    .as_deref()
                    .is_some_and(|room| room != authority.room_id)
                {
                    return Err(RoomError::new(
                        "invalid-response",
                        if request.operation.is_post() {
                            "unknown"
                        } else {
                            "not-applicable"
                        },
                    ));
                }
                inner.scope.as_mut().ok_or_else(stale)?.session = Some(authority);
            }
            Operation::Leave | Operation::Close => {
                if result["roomId"].as_str() != request.room_id.as_deref() {
                    return Err(RoomError::new("invalid-response", "unknown"));
                }
                inner.scope.as_mut().ok_or_else(stale)?.session = None;
            }
            Operation::Discover => {}
            Operation::Ticket => return Err(invalid()),
        }
        Ok(())
    }

    pub(crate) fn subscribe(
        self: &Arc<Self>,
        document: DocumentId,
        input: SubscribeRequest,
    ) -> Result<Value, RoomError> {
        let mut inner = lock(&self.inner);
        let old = self.scope_for(&inner, document, &input.handle)?;
        let scope = inner.scope.as_mut().ok_or_else(stale)?;
        let mut authority = scope.session.clone().ok_or_else(stale)?;
        if authority.room_id != input.room_id || authority.room_epoch != input.expected_room_epoch {
            return Err(stale());
        }
        if let Some(cancel) = scope.socket_cancel.take() {
            cancel.cancel();
        }
        authority.offline();
        if let Some(current) = &mut scope.session {
            current.offline();
        }
        // Never release old socket capacity merely because cancellation was requested.
        let socket_permit = self
            .socket_slot
            .clone()
            .try_acquire_owned()
            .map_err(|_| busy())?;
        let notify = scope.notify.clone();
        let subscription_id = random_id()?;
        let batch_prefix = random_id()?;
        Self::retire_locked(&mut inner);
        inner.delivery.activate(
            document,
            old.handle.clone(),
            subscription_id.clone(),
            batch_prefix,
        )?;
        if let Err(error) = inner.delivery.reserve_subscription_terminal() {
            inner.delivery.retire();
            return Err(error);
        }
        let context = ScopeContext {
            subscription_id: subscription_id.clone(),
            cancel: old.account.cancel.child_token(),
            ..old
        };
        let socket_cancel = context.cancel.child_token();
        inner.scope = Some(Scope {
            context: context.clone(),
            notify,
            session: Some(authority),
            socket_cancel: Some(socket_cancel.clone()),
        });
        drop(inner);
        self.watch_account(context.clone());
        let this = self.clone();
        tokio::spawn(async move {
            this.run_socket(context, socket_cancel, socket_permit).await;
        });
        Ok(json!({"handle":input.handle,"subscriptionId":subscription_id}))
    }

    async fn ticket(
        &self,
        context: &ScopeContext,
        cancel: &CancellationToken,
    ) -> Result<(protocol::RoomTicket, Instant), RoomError> {
        self.subscription_current(context)?;
        let permit = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(stale()),
            permit = self.http_slot.clone().acquire_owned() => permit.map_err(|_| stale())?,
        };
        self.subscription_current(context)?;
        let input = {
            let mut inner = lock(&self.inner);
            if let Err(error) = self.current_locked(&inner, context) {
                drop(inner);
                self.subscription_error(context, &error);
                return Err(error);
            }
            let session = inner
                .scope
                .as_ref()
                .and_then(|scope| scope.session.as_ref())
                .ok_or_else(stale)?;
            let input = HttpRequest {
                operation: Operation::Ticket,
                room_id: Some(session.room_id.clone()),
                request: json!({"reconnect":{"control":{"roomEpoch":session.room_epoch,"controlSeq":session.control_seq}}}),
                resume_only: false,
            };
            inner.delivery.reserve_subscription_terminal()?;
            input
        };
        // Start conservatively at dispatch, never after owner recheck or scheduling delays.
        let received_at = Instant::now();
        let response = self
            .http
            .execute(
                &input,
                context.account.user_id,
                &context.account.cookie,
                cancel,
            )
            .await;
        drop(permit);
        if let Err(error) = &response {
            if error.code == "not-authenticated" && self.subscription_current(context).is_ok() {
                let _ = self.revoke_http_auth(context, error, None, true, true);
                return Err(error.clone());
            }
        }
        self.subscription_current(context)?;
        response.and_then(|response| {
            protocol::parse_ticket(&response).map(|ticket| (ticket, received_at))
        })
    }

    async fn connect_socket(
        &self,
        ticket: protocol::RoomTicket,
        received_at: Instant,
        cancel: CancellationToken,
    ) -> Result<RoomSocket, RoomError> {
        if Instant::now()
            .checked_duration_since(received_at)
            .is_some_and(|elapsed| elapsed >= Duration::from_secs(ticket.expires_in_seconds))
        {
            return Err(RoomError::new("service-rejected", "not-applicable"));
        }
        #[cfg(test)]
        if let Some(address) = self.test_socket {
            let stream = tokio::net::TcpStream::connect(address)
                .await
                .map_err(|_| RoomError::new("network-error", "not-applicable"))?;
            return RoomSocket::from_test_stream(stream, ticket, received_at, cancel).await;
        }
        RoomSocket::connect(ticket, received_at, cancel).await
    }

    async fn run_socket(
        self: Arc<Self>,
        context: ScopeContext,
        cancel: CancellationToken,
        _permit: OwnedSemaphorePermit,
    ) {
        let mut failures = 0u32;
        loop {
            if self.subscription_current(&context).is_err() || cancel.is_cancelled() {
                return;
            }
            if self
                .subscription_status(
                    &context,
                    if failures == 0 {
                        "connecting"
                    } else {
                        "reconnecting"
                    },
                    None,
                )
                .is_err()
            {
                return;
            }
            let result = async {
                let (ticket, received_at) = self.ticket(&context, &cancel).await?;
                self.subscription_current(&context)?;
                let mut socket = self
                    .connect_socket(ticket, received_at, cancel.child_token())
                    .await?;
                let result = async {
                    self.subscription_current(&context)?;
                    socket.request_resync().await?;
                    self.subscription_current(&context)?;
                    loop {
                        let message = socket
                            .next()
                            .await?
                            .ok_or_else(|| RoomError::new("network-error", "not-applicable"))?;
                        self.subscription_current(&context)?;
                        if cancel.is_cancelled() {
                            return Err(stale());
                        }
                        let closed = self.process_socket(&context, &cancel, &message)?;
                        if closed {
                            return Ok::<bool, RoomError>(true);
                        }
                    }
                }
                .await;
                // Revoke the Native presence projection before waiting for the driver close.
                self.clear_presence(&context);
                socket.shutdown().await;
                result
            }
            .await;
            self.clear_presence(&context);
            if let Err(error) = &result {
                self.subscription_error(&context, error);
            }
            if cancel.is_cancelled() || self.subscription_current(&context).is_err() {
                return;
            }
            if matches!(result, Ok(true)) {
                return;
            }
            let error = result.err().unwrap_or_else(invalid);
            let retry = error.code == "network-error";
            if !retry {
                let _ = self.subscription_status(&context, "resync-required", Some(error.code));
                return;
            }
            failures += 1;
            let _ = self.subscription_status(&context, "offline", Some(error.code));
            if failures >= 3 {
                return;
            }
            let delay = Duration::from_millis(250 * (1u64 << (failures - 1)));
            tokio::select! { biased; _ = cancel.cancelled() => return, _ = tokio::time::sleep(delay) => {} }
        }
    }

    fn clear_presence(&self, context: &ScopeContext) {
        let mut inner = lock(&self.inner);
        if self.identity_current_locked(&inner, context) {
            if let Some(session) = inner
                .scope
                .as_mut()
                .and_then(|scope| scope.session.as_mut())
            {
                session.offline();
            }
        }
    }

    fn process_socket(
        &self,
        context: &ScopeContext,
        cancel: &CancellationToken,
        message: &Value,
    ) -> Result<bool, RoomError> {
        let mut inner = lock(&self.inner);
        self.current_locked(&inner, context)?;
        if cancel.is_cancelled() {
            return Err(stale());
        }
        let effect = inner
            .scope
            .as_mut()
            .and_then(|scope| scope.session.as_mut())
            .ok_or_else(stale)?
            .apply(message)?;
        let enqueue = inner
            .delivery
            .enqueue(&json!({"kind":"socket","message":message}));
        if let Err(error) = enqueue {
            Self::delivery_failed(&mut inner, context);
            let _ = self.notify_locked(&mut inner, context);
            return Err(error);
        }
        if effect.closed {
            inner
                .delivery
                .enqueue(&json!({"kind":"status","state":"closed"}))?;
            if let Some(scope) = &mut inner.scope {
                scope.session = None;
            }
        } else if effect.online {
            inner
                .delivery
                .enqueue(&json!({"kind":"status","state":"online"}))?;
        } else if effect.offline {
            inner
                .delivery
                .enqueue(&json!({"kind":"status","state":"offline"}))?;
        }
        self.notify_locked(&mut inner, context)?;
        Ok(effect.closed)
    }
}

#[derive(Default)]
struct SocketEffect {
    online: bool,
    offline: bool,
    closed: bool,
}

#[derive(Clone)]
struct Authority {
    room_id: String,
    room_epoch: String,
    self_id: String,
    self_role: String,
    members: BTreeMap<String, (String, String)>,
    control_seq: u64,
    snapshot_seen: bool,
    presence_seen: bool,
    online: BTreeSet<String>,
}

impl Authority {
    fn from_session(session: &Value) -> Result<Self, RoomError> {
        let self_id = session["self"]["userId"]
            .as_str()
            .ok_or_else(invalid)?
            .to_owned();
        let self_role = session["self"]["role"]
            .as_str()
            .ok_or_else(invalid)?
            .to_owned();
        let mut authority = Self {
            room_id: session["roomId"].as_str().ok_or_else(invalid)?.to_owned(),
            room_epoch: session["roomEpoch"]
                .as_str()
                .ok_or_else(invalid)?
                .to_owned(),
            self_id,
            self_role,
            members: BTreeMap::new(),
            control_seq: 0,
            snapshot_seen: false,
            presence_seen: false,
            online: BTreeSet::new(),
        };
        authority.replace_snapshot(&session["snapshot"])?;
        Ok(authority)
    }

    fn replace_snapshot(&mut self, snapshot: &Value) -> Result<(), RoomError> {
        if snapshot["roomId"].as_str() != Some(self.room_id.as_str())
            || snapshot["roomEpoch"].as_str() != Some(self.room_epoch.as_str())
        {
            return Err(stale());
        }
        let sequence = snapshot["controlSeq"].as_u64().ok_or_else(invalid)?;
        if sequence < self.control_seq {
            return Err(stale());
        }
        let mut members = BTreeMap::new();
        for member in snapshot["members"].as_array().ok_or_else(invalid)? {
            let id = member["userId"].as_str().ok_or_else(invalid)?.to_owned();
            let role = member["role"].as_str().ok_or_else(invalid)?.to_owned();
            let membership = member["membershipState"]
                .as_str()
                .ok_or_else(invalid)?
                .to_owned();
            if members.insert(id, (role, membership)).is_some() {
                return Err(invalid());
            }
        }
        if !members
            .get(&self.self_id)
            .is_some_and(|(role, state)| role == &self.self_role && state == "active")
        {
            return Err(stale());
        }
        self.members = members;
        self.control_seq = sequence;
        self.online.retain(|id| {
            self.members
                .get(id)
                .is_some_and(|(_, state)| state == "active")
        });
        Ok(())
    }

    fn offline(&mut self) {
        self.snapshot_seen = false;
        self.presence_seen = false;
        self.online.clear();
    }

    fn apply(&mut self, message: &Value) -> Result<SocketEffect, RoomError> {
        let kind = message["type"].as_str().ok_or_else(invalid)?;
        if kind == "room.resync.required" {
            return Err(RoomError::new("service-rejected", "not-applicable"));
        }
        if message["roomId"].as_str() != Some(self.room_id.as_str())
            || message["roomEpoch"].as_str() != Some(self.room_epoch.as_str())
        {
            return Err(stale());
        }
        if kind == "room.snapshot" {
            self.replace_snapshot(&message["payload"])?;
            self.snapshot_seen = true;
            return Ok(SocketEffect::default());
        }
        if kind == "room.presence" {
            if !self.snapshot_seen {
                return Err(stale());
            }
            let ids = message["onlineUserIds"].as_array().ok_or_else(invalid)?;
            let mut online = BTreeSet::new();
            for id in ids {
                let id = id.as_str().ok_or_else(invalid)?;
                if !self
                    .members
                    .get(id)
                    .is_some_and(|(_, state)| state == "active")
                    || !online.insert(id.to_owned())
                {
                    return Err(invalid());
                }
            }
            let was_online = self.presence_seen && self.online.contains(&self.self_id);
            let now_online = online.contains(&self.self_id);
            self.online = online;
            self.presence_seen = true;
            return Ok(SocketEffect {
                online: !was_online && now_online,
                offline: was_online && !now_online,
                closed: false,
            });
        }
        if kind == "story.delta" {
            // Story is validated and forwarded only through the bounded queue; no transcript
            // or story reconnect cursor is retained or claimed recoverable.
            return if self.snapshot_seen {
                Ok(SocketEffect::default())
            } else {
                Err(stale())
            };
        }
        let sequence = message["controlSeq"].as_u64().ok_or_else(invalid)?;
        if sequence != self.control_seq.checked_add(1).ok_or_else(invalid)? {
            return Err(stale());
        }
        match kind {
            "room.member.joined" | "room.member.left" | "room.host.offline"
            | "room.host.online" => {
                let member = &message["payload"]["member"];
                let id = member["userId"].as_str().ok_or_else(invalid)?.to_owned();
                let role = member["role"].as_str().ok_or_else(invalid)?.to_owned();
                let state = member["membershipState"]
                    .as_str()
                    .ok_or_else(invalid)?
                    .to_owned();
                if id == self.self_id && role != self.self_role {
                    return Err(stale());
                }
                let self_revoked = id == self.self_id && state != "active";
                self.members.insert(id.clone(), (role, state.clone()));
                if state != "active" {
                    self.online.remove(&id);
                }
                if self.members.len() > 32 {
                    return Err(invalid());
                }
                if self_revoked {
                    self.control_seq = sequence;
                    self.offline();
                    return Ok(SocketEffect {
                        closed: true,
                        ..SocketEffect::default()
                    });
                }
            }
            "room.closing" => {
                self.control_seq = sequence;
                self.offline();
                return Ok(SocketEffect {
                    closed: true,
                    ..SocketEffect::default()
                });
            }
            "room.config.updated"
            | "proposal.submitted"
            | "proposal.updated"
            | "proposal.resolved"
            | "generation.started"
            | "generation.completed"
            | "generation.failed" => {}
            _ => return Err(invalid()),
        }
        self.control_seq = sequence;
        Ok(SocketEffect::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::{mpsc, oneshot};
    use tokio_tungstenite::tungstenite::Message;

    struct SelectPresence;
    impl tokio_tungstenite::tungstenite::handshake::server::Callback for SelectPresence {
        fn on_request(
            self,
            _request: &tokio_tungstenite::tungstenite::handshake::server::Request,
            mut response: tokio_tungstenite::tungstenite::handshake::server::Response,
        ) -> Result<
            tokio_tungstenite::tungstenite::handshake::server::Response,
            tokio_tungstenite::tungstenite::handshake::server::ErrorResponse,
        > {
            response.headers_mut().insert(
                "sec-websocket-protocol",
                protocol::PRESENCE_PROTOCOL.parse().unwrap(),
            );
            Ok(response)
        }
    }

    fn fixture(operation: Operation, field: &str) -> Value {
        let all: Value = serde_json::from_str(include_str!(
            "../../../../packages/contracts/fixtures/desktop-room-session.json"
        ))
        .unwrap();
        all["operations"][operation.as_str()][field].clone()
    }
    fn room() -> &'static str {
        "room_01JARENAEXAMPLE"
    }
    fn epoch() -> &'static str {
        "epoch_01JARENA"
    }
    fn snapshot() -> Value {
        let payload = fixture(Operation::Session, "success")["result"]["snapshot"].clone();
        json!({"protocolVersion":1,"type":"room.snapshot","roomId":room(),"roomEpoch":epoch(),
            "controlSeq":payload["controlSeq"],"timestamp":"2026-10-12T00:00:00Z","payload":payload})
    }
    fn presence(users: &[&str]) -> Value {
        json!({"protocolVersion":1,"type":"room.presence","roomId":room(),"roomEpoch":epoch(),"onlineUserIds":users})
    }
    fn closing() -> Value {
        json!({"protocolVersion":1,"type":"room.closing","roomId":room(),"roomEpoch":epoch(),
            "controlSeq":25,"timestamp":"2026-10-12T00:00:00Z","payload":{}})
    }
    fn auth_failure(operation: Operation) -> Value {
        json!({"desktopRoom":{"version":protocol::PROTOCOL_VERSION,"viewerUserId":null},
            "error":{"code":"ROOM_AUTHENTICATION_REQUIRED","message":"需要登录",
                "outcome":if operation.is_post() {"not-applied"} else {"not-applicable"}}})
    }
    fn create_action() -> Action {
        Action::Create {
            request: fixture(Operation::Create, "request")["request"].clone(),
        }
    }
    fn session_action() -> Action {
        Action::Session {
            room_id: room().into(),
        }
    }
    fn error_code<T>(value: Result<T, RoomError>) -> &'static str {
        match value {
            Ok(_) => panic!("expected fixed error"),
            Err(error) => error.code,
        }
    }

    struct SyntheticAccount {
        access: Arc<AccountAccess>,
        actual_epoch: Arc<AtomicU64>,
        io_error: Arc<AtomicBool>,
        clear_error: Arc<AtomicBool>,
        clears: Arc<AtomicU64>,
    }
    fn synthetic_account(epoch: u64) -> SyntheticAccount {
        let actual_epoch = Arc::new(AtomicU64::new(epoch));
        let io_error = Arc::new(AtomicBool::new(false));
        let clears = Arc::new(AtomicU64::new(0));
        let current_epoch = actual_epoch.clone();
        let current_error = io_error.clone();
        let clear_count = clears.clone();
        let clear_epoch = actual_epoch.clone();
        let clear_failure = Arc::new(AtomicBool::new(false));
        let clear_error = clear_failure.clone();
        let cancel = CancellationToken::new();
        let clear_cancel = cancel.clone();
        let access = Arc::new(AccountAccess::new(
            42,
            epoch,
            cancel,
            "synthetic-room-cookie=canary".into(),
            Arc::new(move || {
                if current_error.load(Ordering::SeqCst) {
                    return Err(RoomError::new("storage-unavailable", "not-applicable"));
                }
                Ok(current_epoch.load(Ordering::SeqCst) == epoch)
            }),
            Arc::new(move || {
                if clear_error.load(Ordering::SeqCst) {
                    return Err(RoomError::new("storage-unavailable", "not-applicable"));
                }
                if clear_epoch.load(Ordering::SeqCst) != epoch {
                    return Ok(false);
                }
                clear_count.fetch_add(1, Ordering::SeqCst);
                clear_cancel.cancel();
                Ok(true)
            }),
        ));
        SyntheticAccount {
            access,
            actual_epoch,
            io_error,
            clear_error: clear_failure,
            clears,
        }
    }

    fn fail_read_once(
        account: &mut SyntheticAccount,
        on_failure: impl Fn() + Send + Sync + 'static,
    ) -> Arc<AtomicU64> {
        let remaining = Arc::new(AtomicU64::new(0));
        let fault = remaining.clone();
        let access = Arc::get_mut(&mut account.access).unwrap();
        let current = access.current.clone();
        access.current = Arc::new(move || {
            let mut observed = fault.load(Ordering::SeqCst);
            let failed = loop {
                let Some(next) = observed.checked_sub(1) else {
                    break false;
                };
                match fault.compare_exchange(observed, next, Ordering::SeqCst, Ordering::SeqCst) {
                    Ok(previous) => break previous == 1,
                    Err(actual) => observed = actual,
                }
            };
            if failed {
                on_failure();
                return Err(RoomError::new("storage-unavailable", "not-applicable"));
            }
            current()
        });
        remaining
    }

    fn http_action(operation: Operation) -> Action {
        match operation {
            Operation::Discover => Action::Discover {
                query: json!({"limit":20}),
            },
            Operation::Create => create_action(),
            Operation::Join => Action::Join {
                room_id: room().into(),
                request: fixture(operation, "request")["request"].clone(),
            },
            Operation::Session => session_action(),
            Operation::Leave => Action::Leave {
                room_id: room().into(),
                expected_room_epoch: epoch().into(),
            },
            Operation::Close => Action::Close {
                room_id: room().into(),
                expected_room_epoch: epoch().into(),
            },
            Operation::Ticket => panic!("ticket is not renderer HTTP"),
        }
    }

    fn accepted_id(reply: EngineReply) -> String {
        let EngineReply::Small(value) = reply else {
            panic!("expected accepted request")
        };
        assert_eq!(value["kind"], "accepted");
        value["requestId"].as_str().unwrap().into()
    }

    async fn create_unknown(attached: &mut Attached) -> (String, Value) {
        attached.request(create_action()).unwrap();
        let error = attached.event().await;
        assert_eq!(error["error"]["outcome"], "unknown");
        assert_eq!(attached.event().await["kind"], "mutation-unknown");
        wait_http_idle(&attached.instance).await;
        let inner = lock(&attached.instance.inner);
        let pending = inner.pending.as_ref().unwrap();
        assert!(pending.phase == IntentPhase::Unknown);
        (pending.id.clone(), pending.frozen_request.clone())
    }

    fn assert_unknown(instance: &RoomInstance, id: &str, request: &Value) {
        let inner = lock(&instance.inner);
        let pending = inner.pending.as_ref().unwrap();
        assert_eq!(pending.id, id);
        assert_eq!(&pending.frozen_request, request);
        assert!(pending.phase == IntentPhase::Unknown);
        assert!(pending.receipt.is_none());
    }

    struct Attached {
        instance: Arc<RoomInstance>,
        document: DocumentId,
        handle: String,
        subscription: String,
        notifications: mpsc::UnboundedReceiver<String>,
        attach_value: Value,
        observed_notifications: Vec<Value>,
        observed_pulls: Vec<Value>,
    }
    fn attach(instance: Arc<RoomInstance>, account: Arc<AccountAccess>, intent: u64) -> Attached {
        let (sender, notifications) = mpsc::unbounded_channel();
        let proof = {
            let mut state = lock(&instance.document);
            let attempt = state
                .begin_attach(
                    instance.token,
                    "a".repeat(64),
                    intent,
                    account.epoch,
                    format!("challenge-{intent}"),
                )
                .unwrap();
            state
                .complete_eval(
                    &attempt,
                    instance.token,
                    account.epoch,
                    Some(&attempt.document_nonce),
                    Some(&attempt.challenge),
                )
                .unwrap()
        };
        let document = proof.document;
        let notify: Notify = Arc::new(move |raw| sender.send(raw).map_err(|_| stale()));
        let response = instance.finish_attach(proof, account, notify).unwrap();
        Attached {
            instance,
            document,
            handle: response["handle"].as_str().unwrap().into(),
            subscription: response["subscriptionId"].as_str().unwrap().into(),
            notifications,
            attach_value: response,
            observed_notifications: Vec::new(),
            observed_pulls: Vec::new(),
        }
    }
    fn make_instance(
        address: std::net::SocketAddr,
        socket: Option<std::net::SocketAddr>,
    ) -> Arc<RoomInstance> {
        let mut instance =
            RoomInstance::new(InstanceToken::new(1), Arc::new(RoomHttp::loopback(address)));
        instance.test_socket = socket;
        instance.page_finished().unwrap();
        Arc::new(instance)
    }
    impl Attached {
        fn request(&self, action: Action) -> Result<EngineReply, RoomError> {
            self.instance.request(
                self.document,
                Request {
                    handle: self.handle.clone(),
                    action,
                },
            )
        }
        async fn batch(&mut self) -> Value {
            let notification =
                tokio::time::timeout(Duration::from_secs(3), self.notifications.recv())
                    .await
                    .unwrap()
                    .unwrap();
            let notification: Value = serde_json::from_str(&notification).unwrap();
            assert_eq!(notification["subscriptionId"], self.subscription);
            self.observed_notifications.push(notification);
            let reply = self
                .request(Action::Pull {
                    subscription_id: self.subscription.clone(),
                })
                .unwrap();
            let EngineReply::Json(raw) = reply else {
                panic!("expected batch");
            };
            let pull: Value = serde_json::from_str(&raw).unwrap();
            let batch = pull["batch"].clone();
            self.observed_pulls.push(pull);
            batch
        }
        async fn revocation(&mut self) -> Value {
            let raw = tokio::time::timeout(Duration::from_secs(3), self.notifications.recv())
                .await
                .unwrap()
                .unwrap();
            let value: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(value["type"], "revoked");
            self.observed_notifications.push(value.clone());
            value
        }
        fn ack(&self, batch: &Value) -> Result<EngineReply, RoomError> {
            self.request(Action::Ack {
                subscription_id: batch["subscriptionId"].as_str().unwrap().into(),
                batch_id: batch["batchId"].as_str().unwrap().into(),
                sequence: batch["sequence"].as_u64().unwrap(),
            })
        }
        async fn event(&mut self) -> Value {
            let batch = self.batch().await;
            self.ack(&batch).unwrap();
            batch["event"].clone()
        }
        fn subscribe(&mut self) {
            let response = self
                .instance
                .subscribe(
                    self.document,
                    SubscribeRequest {
                        handle: self.handle.clone(),
                        room_id: room().into(),
                        expected_room_epoch: epoch().into(),
                    },
                )
                .unwrap();
            self.subscription = response["subscriptionId"].as_str().unwrap().into();
        }
    }

    async fn read_http(stream: &mut TcpStream) -> Vec<u8> {
        let mut raw = Vec::new();
        loop {
            let mut buffer = [0; 4096];
            let size = stream.read(&mut buffer).await.unwrap();
            assert!(size > 0);
            raw.extend_from_slice(&buffer[..size]);
            assert!(raw.len() <= protocol::MAX_REQUEST_BYTES + 16 * 1024);
            if let Some(end) = raw.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&raw[..end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|value| value.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if raw.len() >= end + 4 + length {
                    return raw;
                }
            }
        }
    }
    fn request_body(raw: &[u8]) -> Value {
        let end = raw
            .windows(4)
            .position(|bytes| bytes == b"\r\n\r\n")
            .unwrap();
        serde_json::from_slice(&raw[end + 4..]).unwrap()
    }
    async fn send_http(stream: &mut TcpStream, status: u16, body: &Value) {
        let body = serde_json::to_vec(body).unwrap();
        let header = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
        stream.write_all(header.as_bytes()).await.unwrap();
        stream.write_all(&body).await.unwrap();
        stream.shutdown().await.unwrap();
    }
    async fn wait_http_idle(instance: &RoomInstance) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while instance.http_slot.available_permits() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[test]
    fn http_authority_is_offline_and_presence_requires_active_self() {
        let mut state =
            Authority::from_session(&fixture(Operation::Session, "success")["result"]).unwrap();
        assert!(!state.snapshot_seen && !state.presence_seen && state.online.is_empty());
        assert!(state.apply(&presence(&["user-host"])).is_err());
        state.apply(&snapshot()).unwrap();
        assert!(!state.apply(&presence(&[])).unwrap().online);
        assert!(!state.apply(&presence(&["user-member"])).unwrap().online);
        assert!(
            state
                .apply(&presence(&["user-host", "user-member"]))
                .unwrap()
                .online
        );
        assert!(!state.apply(&presence(&["user-host"])).unwrap().online);
        assert!(state.apply(&presence(&[])).unwrap().offline);
        assert!(state.apply(&presence(&["unknown-member"])).is_err());
    }

    #[test]
    fn control_gap_and_epoch_change_require_authoritative_resync() {
        let mut state =
            Authority::from_session(&fixture(Operation::Session, "success")["result"]).unwrap();
        state.apply(&snapshot()).unwrap();
        let mut gap = closing();
        gap["controlSeq"] = json!(26);
        assert_eq!(error_code(state.apply(&gap)), "scope-changed");
        let mut other = snapshot();
        other["roomEpoch"] = json!("another-epoch");
        assert_eq!(error_code(state.apply(&other)), "scope-changed");
        assert_eq!(state.control_seq, 24);
    }

    #[test]
    fn closing_and_self_revocation_are_terminal_authoritative_events() {
        let mut state =
            Authority::from_session(&fixture(Operation::Session, "success")["result"]).unwrap();
        state.apply(&snapshot()).unwrap();
        assert!(state.apply(&closing()).unwrap().closed);
        let mut state =
            Authority::from_session(&fixture(Operation::Session, "success")["result"]).unwrap();
        state.apply(&snapshot()).unwrap();
        let mut left = closing();
        left["type"] = json!("room.member.left");
        let mut member = fixture(Operation::Session, "success")["result"]["self"].clone();
        member["membershipState"] = json!("left");
        left["payload"] = json!({"member":member});
        assert!(state.apply(&left).unwrap().closed);
        assert!(state.online.is_empty());
    }

    #[tokio::test]
    async fn real_http_result_uses_notify_pull_ack_and_never_sets_online() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let raw = read_http(&mut stream).await;
            assert!(
                String::from_utf8_lossy(&raw).contains("x-mahoshojo-room-expected-user-id: v1:42")
            );
            send_http(&mut stream, 200, &fixture(Operation::Session, "success")).await;
            let (mut stream, _) = listener.accept().await.unwrap();
            read_http(&mut stream).await;
            send_http(&mut stream, 401, &auth_failure(Operation::Discover)).await;
        });
        let account = synthetic_account(1);
        let mut attached = attach(make_instance(address, None), account.access.clone(), 1);
        assert!(matches!(
            attached.request(session_action()).unwrap(),
            EngineReply::Small(_)
        ));
        let event = attached.event().await;
        assert_eq!(event["kind"], "http-result");
        assert_eq!(event["operation"], "session");
        {
            let inner = lock(&attached.instance.inner);
            let authority = inner.scope.as_ref().unwrap().session.as_ref().unwrap();
            assert!(
                !authority.snapshot_seen && !authority.presence_seen && authority.online.is_empty()
            );
            assert_eq!(inner.delivery.delivered_unacked_bytes(), 0);
        }
        assert_eq!(account.clears.load(Ordering::SeqCst), 0);
        wait_http_idle(&attached.instance).await;
        attached
            .request(Action::Discover {
                query: json!({"limit": 20}),
            })
            .unwrap();
        let revoked = attached.revocation().await;
        assert_eq!(revoked["operation"], "discover");
        assert_eq!(revoked["error"]["code"], "not-authenticated");
        assert!(account.access.cancel.is_cancelled());
        attached.ack(&revoked).unwrap();
        assert_eq!(account.clears.load(Ordering::SeqCst), 1);
        if let Some(path) = std::env::var_os("MAHO_ROOM_NATIVE_IPC_FIXTURE") {
            // These are exact parsed objects from real engine notification/pull bytes above,
            // not a hand-authored copy of the TypeScript fixture.
            let output = json!({"expectedUserId":42,"attach":attached.attach_value,
                "notifications":attached.observed_notifications,"pulls":attached.observed_pulls});
            std::fs::write(path, serde_json::to_vec_pretty(&output).unwrap()).unwrap();
        }
        attached.instance.destroyed();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn create_receipt_retains_frozen_intent_until_exact_ack_and_duplicates_do_not_clear_new_intent(
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                read_http(&mut stream).await;
                send_http(&mut stream, 201, &fixture(Operation::Create, "success")).await;
            }
        });
        let account = synthetic_account(1);
        let mut attached = attach(make_instance(address, None), account.access, 1);
        attached.request(create_action()).unwrap();
        let first = attached.batch().await;
        {
            let inner = lock(&attached.instance.inner);
            let pending = inner.pending.as_ref().unwrap();
            assert!(pending.phase == IntentPhase::AwaitingAck);
            assert_eq!(
                pending.frozen_request,
                fixture(Operation::Create, "request")["request"]
            );
        }
        attached.ack(&first).unwrap();
        assert!(lock(&attached.instance.inner).pending.is_none());
        wait_http_idle(&attached.instance).await;
        attached.request(create_action()).unwrap();
        let second = attached.batch().await;
        let second_id = lock(&attached.instance.inner)
            .pending
            .as_ref()
            .unwrap()
            .id
            .clone();
        attached.ack(&first).unwrap();
        assert_eq!(
            lock(&attached.instance.inner).pending.as_ref().unwrap().id,
            second_id
        );
        attached.ack(&second).unwrap();
        assert!(lock(&attached.instance.inner).pending.is_none());
        attached.instance.destroyed();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn wrong_room_response_preserves_unknown_original_mutation_and_emits_closed_error() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_http(&mut stream).await;
            send_http(&mut stream, 200, &fixture(Operation::Join, "success")).await;
        });
        let account = synthetic_account(1);
        let mut attached = attach(make_instance(address, None), account.access, 1);
        attached
            .request(Action::Join {
                room_id: "different-room".into(),
                request: json!({"displayName":"成员"}),
            })
            .unwrap();
        let event = attached.event().await;
        assert_eq!(event["kind"], "request-error");
        assert_eq!(event["error"]["outcome"], "unknown");
        assert!(
            lock(&attached.instance.inner)
                .pending
                .as_ref()
                .unwrap()
                .phase
                == IntentPhase::Unknown
        );
        assert!(lock(&attached.instance.inner)
            .scope
            .as_ref()
            .unwrap()
            .session
            .is_none());
        attached.instance.destroyed();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn unknown_create_resume_uses_original_body_and_mode_and_reload_keeps_intent() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (seen, mut requests) = mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let raw = read_http(&mut stream).await;
            seen.send(request_body(&raw)).unwrap();
            send_http(&mut stream, 201, &json!({"unexpected":"legacy"})).await;
            let (mut stream, _) = listener.accept().await.unwrap();
            let raw = read_http(&mut stream).await;
            seen.send(request_body(&raw)).unwrap();
            send_http(&mut stream, 201, &fixture(Operation::Create, "success")).await;
        });
        let account = synthetic_account(1);
        let instance = make_instance(address, None);
        let mut first = attach(instance.clone(), account.access.clone(), 1);
        first.request(create_action()).unwrap();
        let error = first.event().await;
        assert_eq!(error["error"]["outcome"], "unknown");
        wait_http_idle(&instance).await;
        assert_eq!(error_code(first.request(create_action())), "busy");
        let id = lock(&instance.inner).pending.as_ref().unwrap().id.clone();
        instance.page_started().unwrap();
        instance.page_finished().unwrap();
        let mut renewed = attach(instance.clone(), account.access, 1);
        renewed
            .request(Action::ResumeCreate {
                intent_id: id.clone(),
            })
            .unwrap();
        let batch = renewed.batch().await;
        let original = requests.recv().await.unwrap();
        let resumed = requests.recv().await.unwrap();
        assert_eq!(original["request"], resumed["request"]);
        assert_eq!(original["desktopRoom"]["createMode"], "new");
        assert_eq!(resumed["desktopRoom"]["createMode"], "resume-only");
        assert_eq!(lock(&instance.inner).pending.as_ref().unwrap().id, id);
        renewed.ack(&batch).unwrap();
        assert!(lock(&instance.inner).pending.is_none());
        instance.destroyed();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn keyring_io_failure_retains_original_intent_and_only_delivers_fixed_error() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (arrived, received) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_http(&mut stream).await;
            arrived.send(()).unwrap();
            released.await.unwrap();
            send_http(&mut stream, 201, &fixture(Operation::Create, "success")).await;
        });
        let account = synthetic_account(1);
        let instance = make_instance(address, None);
        let mut attached = attach(instance.clone(), account.access.clone(), 1);
        attached.request(create_action()).unwrap();
        received.await.unwrap();
        account.io_error.store(true, Ordering::SeqCst);
        release.send(()).unwrap();
        let revoked = attached.revocation().await;
        assert_eq!(revoked["error"]["code"], "storage-unavailable");
        assert_eq!(revoked["error"]["outcome"], "unknown");
        assert!(revoked.get("response").is_none());
        attached.ack(&revoked).unwrap();
        let id = lock(&instance.inner).pending.as_ref().unwrap().id.clone();
        assert!(lock(&instance.inner).pending.as_ref().unwrap().phase == IntentPhase::Unknown);
        account.io_error.store(false, Ordering::SeqCst);
        let _renewed = attach(instance.clone(), account.access, 2);
        assert_eq!(lock(&instance.inner).pending.as_ref().unwrap().id, id);
        assert_eq!(account.clears.load(Ordering::SeqCst), 0);
        instance.destroyed();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn resume_only_401_single_read_io_revokes_and_preserves_original_creation() {
        for read in 1..=3 {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (arrived, received) = oneshot::channel();
            let (release, released) = oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let original = request_body(&read_http(&mut stream).await);
                send_http(&mut stream, 201, &json!({"legacy":"unpaired"})).await;
                let (mut stream, _) = listener.accept().await.unwrap();
                let resumed = request_body(&read_http(&mut stream).await);
                assert_eq!(original["request"], resumed["request"]);
                assert_eq!(resumed["desktopRoom"]["createMode"], "resume-only");
                arrived.send(()).unwrap();
                released.await.unwrap();
                send_http(&mut stream, 401, &auth_failure(Operation::Create)).await;
            });
            let mut account = synthetic_account(1);
            let fault = fail_read_once(&mut account, || {});
            let instance = make_instance(address, None);
            let mut attached = attach(instance.clone(), account.access.clone(), 1);
            let (id, frozen) = create_unknown(&mut attached).await;
            let request_id = accepted_id(
                attached
                    .request(Action::ResumeCreate {
                        intent_id: id.clone(),
                    })
                    .unwrap(),
            );
            received.await.unwrap();
            fault.store(read, Ordering::SeqCst);
            release.send(()).unwrap();
            wait_http_idle(&instance).await;
            let revoked = attached.revocation().await;
            assert_eq!(revoked["requestId"], request_id);
            assert_eq!(revoked["operation"], "create");
            assert_eq!(revoked["error"]["code"], "storage-unavailable");
            assert_eq!(revoked["error"]["outcome"], "not-applied");
            assert!(revoked.get("response").is_none());
            assert_eq!(fault.load(Ordering::SeqCst), 0);
            assert_eq!(account.clears.load(Ordering::SeqCst), 0);
            assert!(!account.access.cancel.is_cancelled());
            assert!(lock(&instance.inner).scope.is_none());
            assert_unknown(&instance, &id, &frozen);
            let debt = lock(&instance.inner).delivery.delivered_unacked_bytes();
            assert!(debt > 0);
            let mut wrong = revoked.clone();
            wrong["batchId"] = json!("wrong-revocation");
            assert_eq!(error_code(attached.ack(&wrong)), "invalid-request");
            assert_eq!(
                lock(&instance.inner).delivery.delivered_unacked_bytes(),
                debt
            );
            attached.ack(&revoked).unwrap();
            attached.ack(&revoked).unwrap();
            assert_eq!(lock(&instance.inner).delivery.delivered_unacked_bytes(), 0);
            assert_unknown(&instance, &id, &frozen);
            assert!(attached.notifications.try_recv().is_err());
            let renewed = attach(instance.clone(), account.access.clone(), 2);
            assert_eq!(renewed.attach_value["pendingIntent"]["intentId"], id);
            assert_unknown(&instance, &id, &frozen);
            instance.destroyed();
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn successful_http_single_read_io_revokes_at_every_postresponse_check() {
        for operation in [
            Operation::Session,
            Operation::Discover,
            Operation::Create,
            Operation::Join,
            Operation::Leave,
            Operation::Close,
        ] {
            for read in 1..=4 {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let address = listener.local_addr().unwrap();
                let needs_session = matches!(operation, Operation::Leave | Operation::Close);
                let (arrived, received) = oneshot::channel();
                let (release, released) = oneshot::channel();
                let server = tokio::spawn(async move {
                    if needs_session {
                        let (mut stream, _) = listener.accept().await.unwrap();
                        read_http(&mut stream).await;
                        send_http(&mut stream, 200, &fixture(Operation::Session, "success")).await;
                    }
                    let (mut stream, _) = listener.accept().await.unwrap();
                    read_http(&mut stream).await;
                    arrived.send(()).unwrap();
                    released.await.unwrap();
                    send_http(
                        &mut stream,
                        if operation == Operation::Create {
                            201
                        } else {
                            200
                        },
                        &fixture(operation, "success"),
                    )
                    .await;
                });
                let mut account = synthetic_account(1);
                let fault = fail_read_once(&mut account, || {});
                let instance = make_instance(address, None);
                let mut attached = attach(instance.clone(), account.access.clone(), 1);
                if needs_session {
                    attached.request(session_action()).unwrap();
                    attached.event().await;
                    wait_http_idle(&instance).await;
                }
                let request_id = accepted_id(attached.request(http_action(operation)).unwrap());
                let original = lock(&instance.inner)
                    .pending
                    .as_ref()
                    .map(|pending| (pending.id.clone(), pending.frozen_request.clone()));
                received.await.unwrap();
                fault.store(read, Ordering::SeqCst);
                release.send(()).unwrap();
                wait_http_idle(&instance).await;
                let revoked = attached.revocation().await;
                assert_eq!(revoked["requestId"], request_id);
                assert_eq!(revoked["operation"], operation.as_str());
                assert_eq!(revoked["error"]["code"], "storage-unavailable");
                assert_eq!(
                    revoked["error"]["outcome"],
                    if operation.is_post() {
                        "unknown"
                    } else {
                        "not-applicable"
                    }
                );
                assert!(revoked.get("response").is_none());
                assert_eq!(fault.load(Ordering::SeqCst), 0);
                assert_eq!(account.clears.load(Ordering::SeqCst), 0);
                assert!(!account.access.cancel.is_cancelled());
                assert!(lock(&instance.inner).scope.is_none());
                attached.ack(&revoked).unwrap();
                if let Some((id, frozen)) = original {
                    assert_unknown(&instance, &id, &frozen);
                }
                assert!(attached.notifications.try_recv().is_err());
                instance.destroyed();
                server.await.unwrap();
            }
        }
    }

    #[tokio::test]
    async fn storage_revocation_bypasses_old_delivery_and_retains_exact_debt_on_send_failure() {
        for authenticated_response in [false, true] {
            for pulled in [false, true] {
                for send_fails in [false, true] {
                    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                    let address = listener.local_addr().unwrap();
                    let (arrived, received) = oneshot::channel();
                    let (release, released) = oneshot::channel();
                    let server = tokio::spawn(async move {
                        let (mut stream, _) = listener.accept().await.unwrap();
                        read_http(&mut stream).await;
                        send_http(&mut stream, 201, &json!({"legacy":"unpaired"})).await;
                        let (mut stream, _) = listener.accept().await.unwrap();
                        read_http(&mut stream).await;
                        arrived.send(()).unwrap();
                        released.await.unwrap();
                        if authenticated_response {
                            send_http(&mut stream, 201, &fixture(Operation::Create, "success"))
                                .await;
                        } else {
                            send_http(&mut stream, 401, &auth_failure(Operation::Create)).await;
                        }
                    });
                    let mut account = synthetic_account(1);
                    let fault = fail_read_once(&mut account, || {});
                    let instance = make_instance(address, None);
                    let mut attached = attach(instance.clone(), account.access.clone(), 1);
                    let (id, frozen) = create_unknown(&mut attached).await;
                    let context = lock(&instance.inner)
                        .scope
                        .as_ref()
                        .unwrap()
                        .context
                        .clone();
                    instance
                        .publish(&context, &json!({"kind":"status","state":"connecting"}))
                        .unwrap();
                    let old_batch = if pulled {
                        attached.batch().await
                    } else {
                        let raw = attached.notifications.recv().await.unwrap();
                        let available: Value = serde_json::from_str(&raw).unwrap();
                        assert_eq!(available["type"], "available");
                        let (batch_id, sequence) =
                            lock(&instance.inner).delivery.peek_batch_id().unwrap();
                        json!({"subscriptionId":attached.subscription,"batchId":batch_id,"sequence":sequence})
                    };
                    let old_debt = lock(&instance.inner).delivery.delivered_unacked_bytes();
                    assert!(old_debt > 0);
                    let failed_notification = Arc::new(Mutex::new(None::<String>));
                    if send_fails {
                        let recorded = failed_notification.clone();
                        lock(&instance.inner).scope.as_mut().unwrap().notify =
                            Arc::new(move |raw| {
                                *lock(&recorded) = Some(raw);
                                Err(stale())
                            });
                    }
                    let request_id = accepted_id(
                        attached
                            .request(Action::ResumeCreate {
                                intent_id: id.clone(),
                            })
                            .unwrap(),
                    );
                    received.await.unwrap();
                    fault.store(if authenticated_response { 4 } else { 3 }, Ordering::SeqCst);
                    release.send(()).unwrap();
                    wait_http_idle(&instance).await;
                    let revoked: Value = if send_fails {
                        serde_json::from_str(lock(&failed_notification).as_ref().unwrap()).unwrap()
                    } else {
                        attached.revocation().await
                    };
                    assert_eq!(revoked["type"], "revoked");
                    assert_eq!(revoked["requestId"], request_id);
                    assert_eq!(revoked["error"]["code"], "storage-unavailable");
                    assert_eq!(
                        revoked["error"]["outcome"],
                        if authenticated_response {
                            "unknown"
                        } else {
                            "not-applied"
                        }
                    );
                    assert!(revoked.get("response").is_none());
                    assert_eq!(fault.load(Ordering::SeqCst), 0);
                    assert_eq!(account.clears.load(Ordering::SeqCst), 0);
                    assert!(!account.access.cancel.is_cancelled());
                    assert!(lock(&instance.inner).scope.is_none());
                    assert_unknown(&instance, &id, &frozen);
                    let revoked_debt = serde_json::to_string(&revoked).unwrap().len();
                    assert_eq!(
                        lock(&instance.inner).delivery.delivered_unacked_bytes(),
                        old_debt + revoked_debt
                    );
                    assert_eq!(lock(&instance.inner).delivery.native_queued_bytes(), 0);
                    assert_eq!(
                        error_code(attached.request(Action::Pull {
                            subscription_id: attached.subscription.clone(),
                        })),
                        "scope-changed"
                    );
                    if !send_fails {
                        attached.ack(&revoked).unwrap();
                        attached.ack(&revoked).unwrap();
                        assert_eq!(
                            lock(&instance.inner).delivery.delivered_unacked_bytes(),
                            old_debt
                        );
                    }
                    if pulled {
                        attached.ack(&old_batch).unwrap();
                        attached.ack(&old_batch).unwrap();
                    } else {
                        assert_eq!(error_code(attached.ack(&old_batch)), "invalid-request");
                    }
                    assert_eq!(
                        lock(&instance.inner).delivery.delivered_unacked_bytes(),
                        (if pulled { 0 } else { old_debt })
                            + if send_fails { revoked_debt } else { 0 }
                    );
                    assert_unknown(&instance, &id, &frozen);
                    assert!(attached.notifications.try_recv().is_err());
                    instance.destroyed();
                    server.await.unwrap();
                }
            }
        }
    }

    #[tokio::test]
    async fn last_401_read_io_cannot_notify_or_clear_a_changed_document_or_cancelled_account() {
        for change_document in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (arrived, received) = oneshot::channel();
            let (release, released) = oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                read_http(&mut stream).await;
                send_http(&mut stream, 201, &json!({"legacy":"unpaired"})).await;
                let (mut stream, _) = listener.accept().await.unwrap();
                read_http(&mut stream).await;
                arrived.send(()).unwrap();
                released.await.unwrap();
                send_http(&mut stream, 401, &auth_failure(Operation::Create)).await;
            });
            let instance = make_instance(address, None);
            let mut account = synthetic_account(1);
            let cancel = account.access.cancel.clone();
            let changing = Arc::downgrade(&instance);
            let fault = fail_read_once(&mut account, move || {
                if change_document {
                    let instance = changing.upgrade().unwrap();
                    // Change proof at the exact credential-read boundary, without
                    // trying to re-enter the engine's already-held inner lock.
                    lock(&instance.document)
                        .page_started(instance.token)
                        .unwrap();
                } else {
                    cancel.cancel();
                }
            });
            let mut attached = attach(instance.clone(), account.access.clone(), 1);
            let (id, frozen) = create_unknown(&mut attached).await;
            attached
                .request(Action::ResumeCreate {
                    intent_id: id.clone(),
                })
                .unwrap();
            received.await.unwrap();
            fault.store(3, Ordering::SeqCst);
            release.send(()).unwrap();
            wait_http_idle(&instance).await;
            assert_eq!(fault.load(Ordering::SeqCst), 0);
            assert_eq!(account.clears.load(Ordering::SeqCst), 0);
            assert!(attached.notifications.try_recv().is_err());
            assert_eq!(lock(&instance.inner).delivery.delivered_unacked_bytes(), 0);
            if change_document {
                assert_unknown(&instance, &id, &frozen);
                instance.revoke_stale_scope();
            }
            instance.destroyed();
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn http_terminal_notify_does_not_reread_credentials_but_pull_still_does() {
        for operation in [Operation::Session, Operation::Discover, Operation::Create] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (arrived, received) = oneshot::channel();
            let (release, released) = oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                read_http(&mut stream).await;
                arrived.send(()).unwrap();
                released.await.unwrap();
                send_http(
                    &mut stream,
                    if operation == Operation::Create {
                        201
                    } else {
                        200
                    },
                    &fixture(operation, "success"),
                )
                .await;
            });
            let mut account = synthetic_account(1);
            let fault = fail_read_once(&mut account, || {});
            let instance = make_instance(address, None);
            let mut attached = attach(instance.clone(), account.access.clone(), 1);
            let request_id = accepted_id(attached.request(http_action(operation)).unwrap());
            received.await.unwrap();
            fault.store(5, Ordering::SeqCst);
            release.send(()).unwrap();
            wait_http_idle(&instance).await;
            assert_eq!(fault.load(Ordering::SeqCst), 1);
            let raw = attached.notifications.recv().await.unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&raw).unwrap()["type"],
                "available"
            );
            let notification_debt = lock(&instance.inner).delivery.delivered_unacked_bytes();
            assert_eq!(
                error_code(attached.request(Action::Pull {
                    subscription_id: attached.subscription.clone(),
                })),
                "storage-unavailable"
            );
            assert_eq!(
                lock(&instance.inner).delivery.delivered_unacked_bytes(),
                notification_debt
            );
            let EngineReply::Json(raw) = attached
                .request(Action::Pull {
                    subscription_id: attached.subscription.clone(),
                })
                .unwrap()
            else {
                panic!("expected authorized HTTP body")
            };
            let reply: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(reply["batch"]["event"]["requestId"], request_id);
            assert_eq!(reply["batch"]["event"]["kind"], "http-result");
            attached.ack(&reply["batch"]).unwrap();
            assert_eq!(account.clears.load(Ordering::SeqCst), 0);
            instance.destroyed();
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn predispatch_read_io_releases_only_a_proven_unapplied_new_creation() {
        for resume in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                if resume {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    read_http(&mut stream).await;
                    send_http(&mut stream, 201, &json!({"legacy":"unpaired"})).await;
                }
                assert!(
                    tokio::time::timeout(Duration::from_millis(50), listener.accept())
                        .await
                        .is_err()
                );
            });
            let mut account = synthetic_account(1);
            let fault = fail_read_once(&mut account, || {});
            let instance = make_instance(address, None);
            let mut attached = attach(instance.clone(), account.access.clone(), 1);
            let original = if resume {
                Some(create_unknown(&mut attached).await)
            } else {
                None
            };
            let action =
                original
                    .as_ref()
                    .map_or_else(create_action, |(id, _)| Action::ResumeCreate {
                        intent_id: id.clone(),
                    });
            let request_id = accepted_id(attached.request(action).unwrap());
            // Current-thread scheduling keeps this before run_http's dispatch check.
            fault.store(1, Ordering::SeqCst);
            wait_http_idle(&instance).await;
            let revoked = attached.revocation().await;
            assert_eq!(revoked["requestId"], request_id);
            assert_eq!(revoked["error"]["code"], "storage-unavailable");
            assert_eq!(revoked["error"]["outcome"], "not-applied");
            attached.ack(&revoked).unwrap();
            if let Some((id, frozen)) = original {
                assert_unknown(&instance, &id, &frozen);
            } else {
                assert!(lock(&instance.inner).pending.is_none());
                let renewed = attach(instance.clone(), account.access.clone(), 2);
                assert!(renewed.attach_value["pendingIntent"].is_null());
            }
            assert_eq!(account.clears.load(Ordering::SeqCst), 0);
            instance.destroyed();
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn same_account_new_epoch_cannot_restore_old_intent_or_scope() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let account = synthetic_account(1);
        let instance = make_instance(address, None);
        let old = attach(instance.clone(), account.access.clone(), 1);
        {
            let mut inner = lock(&instance.inner);
            inner.pending = Some(PendingIntent {
                id: "old-intent".into(),
                operation: Operation::Create,
                room_id: None,
                frozen_request: fixture(Operation::Create, "request")["request"].clone(),
                account: account.access.clone(),
                phase: IntentPhase::Unknown,
                receipt: None,
            });
        }
        account.actual_epoch.store(2, Ordering::SeqCst);
        account.access.cancel.cancel();
        let replacement = synthetic_account(2);
        let renewed = attach(instance.clone(), replacement.access, 2);
        assert!(lock(&instance.inner).pending.is_none());
        assert_eq!(error_code(old.request(session_action())), "scope-changed");
        assert_ne!(old.handle, renewed.handle);
        instance.destroyed();
    }

    #[tokio::test]
    async fn session_not_found_reconciles_only_matching_noncreate_unknown_after_ack() {
        for code in ["ROOM_NOT_FOUND", "ROOM_FORBIDDEN"] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                read_http(&mut stream).await;
                send_http(
                    &mut stream,
                    if code == "ROOM_NOT_FOUND" { 404 } else { 403 },
                    &json!({
                    "desktopRoom":{"version":protocol::PROTOCOL_VERSION,"viewerUserId":42},
                    "error":{"code":code,"message":"已结束或无权限","outcome":"not-applicable"}}),
                )
                .await;
            });
            let account = synthetic_account(1);
            let instance = make_instance(address, None);
            let mut attached = attach(instance.clone(), account.access.clone(), 1);
            lock(&instance.inner).pending = Some(PendingIntent {
                id: "original-leave".into(),
                operation: Operation::Leave,
                room_id: Some(room().into()),
                frozen_request: json!({"expectedRoomEpoch":epoch()}),
                account: account.access,
                phase: IntentPhase::Unknown,
                receipt: None,
            });
            attached.request(session_action()).unwrap();
            let batch = attached.batch().await;
            assert_eq!(batch["event"]["kind"], "request-error");
            assert_eq!(batch["event"]["error"]["serverCode"], code);
            assert!(lock(&instance.inner).pending.is_some());
            attached.ack(&batch).unwrap();
            assert!(lock(&instance.inner).pending.is_none());
            instance.destroyed();
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn real_engine_socket_requires_snapshot_presence_and_forwards_authoritative_close() {
        let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http_address = http.local_addr().unwrap();
        let websocket = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let socket_address = websocket.local_addr().unwrap();
        let http_server = tokio::spawn(async move {
            for operation in [Operation::Session, Operation::Ticket] {
                let (mut stream, _) = http.accept().await.unwrap();
                let raw = read_http(&mut stream).await;
                if operation == Operation::Ticket {
                    assert_eq!(
                        request_body(&raw)["request"]["reconnect"]["control"]["controlSeq"],
                        24
                    );
                }
                send_http(&mut stream, 200, &fixture(operation, "success")).await;
            }
        });
        let websocket_server = tokio::spawn(async move {
            let (stream, _) = websocket.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(stream, SelectPresence)
                .await
                .unwrap();
            let resync = socket.next().await.unwrap().unwrap();
            let resync: Value = serde_json::from_str(resync.to_text().unwrap()).unwrap();
            assert_eq!(
                resync,
                json!({"protocolVersion":1,"type":"room.resync.request"})
            );
            for message in [
                snapshot(),
                presence(&["user-host", "user-member"]),
                closing(),
            ] {
                socket
                    .send(Message::Text(
                        serde_json::to_string(&message).unwrap().into(),
                    ))
                    .await
                    .unwrap();
            }
            while let Some(message) = socket.next().await {
                if matches!(message.unwrap(), Message::Close(_)) {
                    break;
                }
            }
        });
        let account = synthetic_account(1);
        let mut attached = attach(
            make_instance(http_address, Some(socket_address)),
            account.access,
            1,
        );
        attached.request(session_action()).unwrap();
        assert_eq!(attached.event().await["kind"], "http-result");
        wait_http_idle(&attached.instance).await;
        attached.subscribe();
        let mut events = Vec::new();
        loop {
            let event = attached.event().await;
            let closed = event["kind"] == "status" && event["state"] == "closed";
            events.push(event);
            if closed {
                break;
            }
        }
        let snapshot_at = events
            .iter()
            .position(|event| event["message"]["type"] == "room.snapshot")
            .unwrap();
        let presence_at = events
            .iter()
            .position(|event| event["message"]["type"] == "room.presence")
            .unwrap();
        let online_at = events
            .iter()
            .position(|event| event["state"] == "online")
            .unwrap();
        let closed_at = events
            .iter()
            .position(|event| event["message"]["type"] == "room.closing")
            .unwrap();
        assert!(snapshot_at < presence_at && presence_at < online_at && online_at < closed_at);
        assert!(lock(&attached.instance.inner)
            .scope
            .as_ref()
            .unwrap()
            .session
            .is_none());
        attached.instance.destroyed();
        http_server.await.unwrap();
        websocket_server.await.unwrap();
    }
    #[tokio::test]
    async fn complete_ipc_wrapper_overflow_preserves_original_create_as_unknown() {
        let mut response = fixture(Operation::Create, "success");
        let proposals: Vec<Value> = (0..5).map(|index| json!({
            "proposalVersion":1,"proposalId":format!("proposal-{index}"),"roomId":room(),"authorUserId":"user-host",
            "baseRevision":7,"status":"rejected","changes":[{"changeId":format!("change-{index}"),
                "type":"setUserGuidance","value":"next","expectedBase":{"kind":"value","value":""}}],
            "createdAt":format!("2026-10-12T00:00:00.{}Z", if index < 4 { "0".repeat(50_000) } else { "0".into() })
        })).collect();
        response["result"]["snapshot"]["proposals"] = json!(proposals);
        let current = serde_json::to_vec(&response).unwrap().len();
        response["result"]["snapshot"]["proposals"][4]["createdAt"] = json!(format!(
            "2026-10-12T00:00:00.{}Z",
            "0".repeat(1 + protocol::MAX_RESPONSE_BYTES - current)
        ));
        let raw = serde_json::to_vec(&response).unwrap();
        assert_eq!(raw.len(), protocol::MAX_RESPONSE_BYTES);
        protocol::validate_http_response(Operation::Create, 201, &raw, 42).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_http(&mut stream).await;
            send_http(&mut stream, 201, &response).await;
        });
        let account = synthetic_account(1);
        let instance = make_instance(address, None);
        let mut attached = attach(instance.clone(), account.access, 1);
        attached.request(create_action()).unwrap();
        let batch = attached.batch().await;
        assert_eq!(batch["event"]["kind"], "request-error");
        assert_eq!(batch["event"]["error"]["code"], "backpressure");
        assert_eq!(batch["event"]["error"]["outcome"], "unknown");
        assert_eq!(error_code(attached.ack(&batch)), "backpressure");
        {
            let inner = lock(&instance.inner);
            let pending = inner.pending.as_ref().unwrap();
            assert!(pending.phase == IntentPhase::Unknown);
            assert_eq!(
                pending.frozen_request,
                fixture(Operation::Create, "request")["request"]
            );
        }
        instance.destroyed();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn failed_notify_retains_original_creation_intent_for_explicit_recovery() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_http(&mut stream).await;
            send_http(&mut stream, 201, &fixture(Operation::Create, "success")).await;
        });
        let account = synthetic_account(1);
        let instance = make_instance(address, None);
        let attached = attach(instance.clone(), account.access.clone(), 1);
        lock(&instance.inner).scope.as_mut().unwrap().notify = Arc::new(|_| Err(stale()));
        attached.request(create_action()).unwrap();
        wait_http_idle(&instance).await;
        assert!(lock(&instance.inner).pending.as_ref().unwrap().phase == IntentPhase::Unknown);
        assert!(lock(&instance.inner).scope.is_none());
        let id = lock(&instance.inner).pending.as_ref().unwrap().id.clone();
        let _renewed = attach(instance.clone(), account.access, 2);
        assert_eq!(lock(&instance.inner).pending.as_ref().unwrap().id, id);
        instance.destroyed();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn no_http_is_accepted_without_reserved_terminal_capacity() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let account = synthetic_account(1);
        let instance = make_instance(address, None);
        let attached = attach(instance.clone(), account.access, 1);
        lock(&instance.inner)
            .delivery
            .enqueue(&json!({"text":"x".repeat(256 * 1024 - 1024)}))
            .unwrap();
        let error = attached.request(create_action()).err().unwrap();
        assert_eq!(error.code, "backpressure");
        assert_eq!(error.outcome, "not-applied");
        assert!(lock(&instance.inner).pending.is_none());
        assert_eq!(instance.http_slot.available_permits(), 1);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), listener.accept())
                .await
                .is_err()
        );
        instance.destroyed();
    }

    #[tokio::test]
    async fn retired_same_document_discard_ack_only_refunds_bytes_not_creation_intent() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_http(&mut stream).await;
            send_http(&mut stream, 201, &fixture(Operation::Create, "success")).await;
        });
        let account = synthetic_account(1);
        let instance = make_instance(address, None);
        let mut attached = attach(instance.clone(), account.access.clone(), 1);
        attached.request(create_action()).unwrap();
        let batch = attached.batch().await;
        let id = lock(&instance.inner).pending.as_ref().unwrap().id.clone();
        instance
            .detach(attached.document, &attached.handle)
            .unwrap();
        attached.ack(&batch).unwrap();
        {
            let inner = lock(&instance.inner);
            assert_eq!(inner.delivery.delivered_unacked_bytes(), 0);
            let pending = inner.pending.as_ref().unwrap();
            assert_eq!(pending.id, id);
            assert!(pending.phase == IntentPhase::Unknown);
            assert!(pending.receipt.is_none());
        }
        let _renewed = attach(instance.clone(), account.access, 2);
        assert_eq!(lock(&instance.inner).pending.as_ref().unwrap().id, id);
        instance.destroyed();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn reload_before_result_ack_preserves_unknown_and_rejects_cross_document_ack() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_http(&mut stream).await;
            send_http(&mut stream, 201, &fixture(Operation::Create, "success")).await;
        });
        let account = synthetic_account(1);
        let instance = make_instance(address, None);
        let mut attached = attach(instance.clone(), account.access.clone(), 1);
        attached.request(create_action()).unwrap();
        let batch = attached.batch().await;
        let id = lock(&instance.inner).pending.as_ref().unwrap().id.clone();
        let debt = lock(&instance.inner).delivery.delivered_unacked_bytes();
        instance.page_started().unwrap();
        instance.page_finished().unwrap();
        let renewed = attach(instance.clone(), account.access, 1);
        assert_eq!(error_code(attached.ack(&batch)), "scope-changed");
        {
            let inner = lock(&instance.inner);
            assert_eq!(inner.delivery.delivered_unacked_bytes(), debt);
            assert_eq!(inner.pending.as_ref().unwrap().id, id);
            assert!(inner.pending.as_ref().unwrap().phase == IntentPhase::Unknown);
            assert_ne!(attached.document, renewed.document);
        }
        instance.destroyed();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn resume_only_not_applied_does_not_erase_prior_unknown_create() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (requests, mut observed) = mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let raw = read_http(&mut stream).await;
            requests.send(request_body(&raw)).unwrap();
            send_http(&mut stream, 201, &json!({"legacy":"unpaired"})).await;
            let (mut stream, _) = listener.accept().await.unwrap();
            let raw = read_http(&mut stream).await;
            requests.send(request_body(&raw)).unwrap();
            send_http(&mut stream, 429, &json!({"desktopRoom":{"version":protocol::PROTOCOL_VERSION,"viewerUserId":42},
                "error":{"code":"ROOM_RATE_LIMITED","message":"稍后重试","outcome":"not-applied","retryAfterSeconds":1}})).await;
            assert!(
                tokio::time::timeout(Duration::from_millis(30), listener.accept())
                    .await
                    .is_err()
            );
        });
        let account = synthetic_account(1);
        let instance = make_instance(address, None);
        let mut attached = attach(instance.clone(), account.access, 1);
        attached.request(create_action()).unwrap();
        assert_eq!(attached.event().await["error"]["outcome"], "unknown");
        // Drain the matching mutation-unknown status before the explicit retry.
        assert_eq!(attached.event().await["kind"], "mutation-unknown");
        wait_http_idle(&instance).await;
        let id = lock(&instance.inner).pending.as_ref().unwrap().id.clone();
        attached
            .request(Action::ResumeCreate {
                intent_id: id.clone(),
            })
            .unwrap();
        let event = attached.event().await;
        assert_eq!(event["error"]["outcome"], "not-applied");
        assert_eq!(event["error"]["serverCode"], "ROOM_RATE_LIMITED");
        wait_http_idle(&instance).await;
        let first = observed.recv().await.unwrap();
        let resume = observed.recv().await.unwrap();
        assert_eq!(first["request"], resume["request"]);
        assert_eq!(resume["desktopRoom"]["createMode"], "resume-only");
        assert_eq!(lock(&instance.inner).pending.as_ref().unwrap().id, id);
        assert!(lock(&instance.inner).pending.as_ref().unwrap().phase == IntentPhase::Unknown);
        assert_eq!(error_code(attached.request(create_action())), "busy");
        instance.destroyed();
        server.await.unwrap();
    }
    #[tokio::test]
    async fn ticket_age_survives_owner_recheck_and_connection_preparation() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let instance = make_instance(address, Some(address));
        let account = synthetic_account(1);
        let _attached = attach(instance.clone(), account.access.clone(), 1);
        // Represents the unchanged dispatch timestamp after an intervening owner check
        // or scheduler delay. The engine must not restart this ticket's one-second TTL.
        let dispatched_at = Instant::now() - Duration::from_secs(2);
        assert!(account.access.is_current().unwrap());
        let result = instance
            .connect_socket(
                protocol::RoomTicket {
                    token: "synthetic-expired-ticket".into(),
                    expires_in_seconds: 1,
                },
                dispatched_at,
                CancellationToken::new(),
            )
            .await;
        assert_eq!(error_code(result), "service-rejected");
        assert!(
            tokio::time::timeout(Duration::from_millis(20), listener.accept())
                .await
                .is_err()
        );
        instance.destroyed();
    }
    #[tokio::test]
    async fn current_401_revocation_bypasses_unacked_body_and_exact_ack_refunds_only_its_own_debt()
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_http(&mut stream).await;
            send_http(&mut stream, 200, &fixture(Operation::Session, "success")).await;
            let (mut stream, _) = listener.accept().await.unwrap();
            read_http(&mut stream).await;
            send_http(&mut stream, 401, &auth_failure(Operation::Discover)).await;
        });
        let account = synthetic_account(1);
        let instance = make_instance(address, None);
        let mut attached = attach(instance.clone(), account.access.clone(), 1);
        attached.request(session_action()).unwrap();
        let body = attached.batch().await;
        let old_debt = lock(&instance.inner).delivery.delivered_unacked_bytes();
        wait_http_idle(&instance).await;
        attached
            .request(Action::Discover {
                query: json!({"limit":20}),
            })
            .unwrap();
        let revoked = attached.revocation().await;
        assert!(lock(&instance.inner).scope.is_none());
        assert!(account.access.cancel.is_cancelled());
        let debt = lock(&instance.inner).delivery.delivered_unacked_bytes();
        assert!(debt > old_debt);
        let mut wrong = revoked.clone();
        wrong["batchId"] = json!("wrong-batch");
        assert_eq!(error_code(attached.ack(&wrong)), "invalid-request");
        assert_eq!(
            lock(&instance.inner).delivery.delivered_unacked_bytes(),
            debt
        );
        attached.ack(&revoked).unwrap();
        assert_eq!(
            lock(&instance.inner).delivery.delivered_unacked_bytes(),
            old_debt
        );
        attached.ack(&revoked).unwrap();
        assert_eq!(
            lock(&instance.inner).delivery.delivered_unacked_bytes(),
            old_debt
        );
        attached.ack(&body).unwrap();
        assert_eq!(lock(&instance.inner).delivery.delivered_unacked_bytes(), 0);
        instance.destroyed();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn cleanup_io_revocation_and_uncertain_send_keep_prior_unknown_creation_intent() {
        for send_fails in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let raw = read_http(&mut stream).await;
                assert_eq!(
                    request_body(&raw)["desktopRoom"]["createMode"],
                    "resume-only"
                );
                send_http(&mut stream, 401, &auth_failure(Operation::Create)).await;
            });
            let account = synthetic_account(1);
            account.clear_error.store(true, Ordering::SeqCst);
            let instance = make_instance(address, None);
            let mut attached = attach(instance.clone(), account.access.clone(), 1);
            lock(&instance.inner).pending = Some(PendingIntent {
                id: "prior-create".into(),
                operation: Operation::Create,
                room_id: None,
                frozen_request: fixture(Operation::Create, "request")["request"].clone(),
                account: account.access.clone(),
                phase: IntentPhase::Unknown,
                receipt: None,
            });
            let failed_bytes = Arc::new(AtomicU64::new(0));
            if send_fails {
                let observed = failed_bytes.clone();
                lock(&instance.inner).scope.as_mut().unwrap().notify = Arc::new(move |raw| {
                    observed.store(raw.len() as u64, Ordering::SeqCst);
                    Err(stale())
                });
            }
            attached
                .request(Action::ResumeCreate {
                    intent_id: "prior-create".into(),
                })
                .unwrap();
            wait_http_idle(&instance).await;
            if !send_fails {
                let revoked = attached.revocation().await;
                assert_eq!(revoked["error"]["code"], "storage-unavailable");
                attached.ack(&revoked).unwrap();
            } else {
                assert!(failed_bytes.load(Ordering::SeqCst) > 0);
                assert_eq!(
                    lock(&instance.inner).delivery.delivered_unacked_bytes(),
                    failed_bytes.load(Ordering::SeqCst) as usize
                );
            }
            assert!(!account.access.cancel.is_cancelled());
            assert_eq!(account.clears.load(Ordering::SeqCst), 0);
            {
                let inner = lock(&instance.inner);
                let pending = inner.pending.as_ref().unwrap();
                assert_eq!(pending.id, "prior-create");
                assert!(pending.phase == IntentPhase::Unknown);
                assert_eq!(
                    pending.frozen_request,
                    fixture(Operation::Create, "request")["request"]
                );
            }
            instance.destroyed();
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn conditional_clear_losing_same_account_aba_does_not_revoke_new_lease_or_emit_old_claim()
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_http(&mut stream).await;
            send_http(&mut stream, 401, &auth_failure(Operation::Discover)).await;
        });
        let mut old_account = synthetic_account(1);
        let new_account = synthetic_account(2);
        let new_cancel = new_account.access.cancel.clone();
        let old_cancel = old_account.access.cancel.clone();
        let epoch = old_account.actual_epoch.clone();
        Arc::get_mut(&mut old_account.access).unwrap().clear = Arc::new(move || {
            epoch.store(2, Ordering::SeqCst);
            old_cancel.cancel();
            assert!(!new_cancel.is_cancelled());
            Ok(false)
        });
        let instance = make_instance(address, None);
        let mut old = attach(instance.clone(), old_account.access, 1);
        old.request(Action::Discover {
            query: json!({"limit":20}),
        })
        .unwrap();
        wait_http_idle(&instance).await;
        assert!(old.notifications.try_recv().is_err());
        assert_eq!(lock(&instance.inner).delivery.delivered_unacked_bytes(), 0);
        let new = attach(instance.clone(), new_account.access.clone(), 2);
        assert!(!new_account.access.cancel.is_cancelled());
        let context = lock(&instance.inner)
            .scope
            .as_ref()
            .unwrap()
            .context
            .clone();
        assert!(instance.current(&context).is_ok());
        assert_ne!(old.handle, new.handle);
        instance.destroyed();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn successful_credential_clear_with_failed_revocation_send_does_not_confirm_original_create(
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_http(&mut stream).await;
            send_http(&mut stream, 401, &auth_failure(Operation::Create)).await;
        });
        let account = synthetic_account(1);
        let instance = make_instance(address, None);
        let attached = attach(instance.clone(), account.access.clone(), 1);
        {
            let mut inner = lock(&instance.inner);
            inner.pending = Some(PendingIntent {
                id: "prior-create".into(),
                operation: Operation::Create,
                room_id: None,
                frozen_request: fixture(Operation::Create, "request")["request"].clone(),
                account: account.access.clone(),
                phase: IntentPhase::Unknown,
                receipt: None,
            });
            inner.scope.as_mut().unwrap().notify = Arc::new(|_| Err(stale()));
        }
        attached
            .request(Action::ResumeCreate {
                intent_id: "prior-create".into(),
            })
            .unwrap();
        wait_http_idle(&instance).await;
        tokio::task::yield_now().await;
        assert!(account.access.cancel.is_cancelled());
        {
            let inner = lock(&instance.inner);
            let pending = inner.pending.as_ref().unwrap();
            assert_eq!(pending.id, "prior-create");
            assert!(pending.phase == IntentPhase::Unknown);
            assert!(pending.receipt.is_none());
            assert!(inner.delivery.delivered_unacked_bytes() > 0);
        }
        let replacement = synthetic_account(2);
        let _new = attach(instance.clone(), replacement.access, 2);
        assert!(lock(&instance.inner).pending.is_none());
        instance.destroyed();
        server.await.unwrap();
    }
    #[tokio::test]
    async fn ticket_401_uses_reserved_subscription_revocation_without_exposing_ticket() {
        for clear_fails in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                read_http(&mut stream).await;
                send_http(&mut stream, 200, &fixture(Operation::Session, "success")).await;
                let (mut stream, _) = listener.accept().await.unwrap();
                let request = read_http(&mut stream).await;
                assert!(String::from_utf8_lossy(&request)
                    .starts_with("POST /api/arena/rooms/v1/room_01JARENAEXAMPLE/ticket "));
                send_http(&mut stream, 401, &auth_failure(Operation::Ticket)).await;
            });
            let account = synthetic_account(1);
            account.clear_error.store(clear_fails, Ordering::SeqCst);
            let instance = make_instance(address, None);
            let mut attached = attach(instance.clone(), account.access.clone(), 1);
            attached.request(session_action()).unwrap();
            attached.event().await;
            wait_http_idle(&instance).await;
            attached.subscribe();
            let revoked = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let raw = attached.notifications.recv().await.unwrap();
                    let value: Value = serde_json::from_str(&raw).unwrap();
                    if value["type"] == "revoked" {
                        break value;
                    }
                }
            })
            .await
            .unwrap();
            assert_eq!(revoked["operation"], "subscribe");
            assert!(revoked["requestId"].is_null());
            assert_eq!(revoked["subscriptionId"], attached.subscription);
            assert_eq!(revoked["error"]["outcome"], "not-applicable");
            assert_eq!(
                revoked["error"]["code"],
                if clear_fails {
                    "storage-unavailable"
                } else {
                    "not-authenticated"
                }
            );
            assert!(!serde_json::to_string(&revoked).unwrap().contains("ticket"));
            attached.ack(&revoked).unwrap();
            assert!(lock(&instance.inner).scope.is_none());
            assert_eq!(account.access.cancel.is_cancelled(), !clear_fails);
            instance.destroyed();
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn ticket_is_not_dispatched_without_subscription_terminal_capacity() {
        use crate::arena_room_state::MAX_DELIVERED_BYTES;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let account = synthetic_account(1);
        let instance = make_instance(listener.local_addr().unwrap(), None);
        let attached = attach(instance.clone(), account.access.clone(), 1);
        {
            let mut inner = lock(&instance.inner);
            inner.scope.as_mut().unwrap().session = Some(
                Authority::from_session(&fixture(Operation::Session, "success")["result"]).unwrap(),
            );
            // Charge actual serialized notify + pull bytes across four retired scopes.
            // No synthetic debt counter mutation bypasses the production ledger.
            for index in 0..4 {
                let handle = format!("debt-h{index}");
                let subscription = format!("debt-s{index}");
                let prefix = format!("debt-b{index}");
                inner
                    .delivery
                    .activate(
                        attached.document,
                        handle.clone(),
                        subscription.clone(),
                        prefix.clone(),
                    )
                    .unwrap();
                let notification = json!({"type":"available","handle":handle,"subscriptionId":subscription,"sequence":1});
                let notification_bytes = serde_json::to_vec(&notification).unwrap().len();
                let empty = json!({"kind":"batch","batch":{"handle":handle,"subscriptionId":subscription,"batchId":format!("{prefix}:1"),"sequence":1,"event":{"text":""}}});
                let overhead = serde_json::to_vec(&empty).unwrap().len();
                inner.delivery.enqueue(&json!({"text":"x".repeat(MAX_DELIVERED_BYTES / 4 - notification_bytes - overhead)})).unwrap();
                inner
                    .delivery
                    .take_notification(attached.document, &handle, &subscription)
                    .unwrap()
                    .unwrap();
                inner
                    .delivery
                    .pull(attached.document, &handle, &subscription)
                    .unwrap()
                    .unwrap();
                inner.delivery.retire();
            }
            assert_eq!(
                inner.delivery.delivered_unacked_bytes(),
                MAX_DELIVERED_BYTES
            );
        }
        let result = instance.subscribe(
            attached.document,
            SubscribeRequest {
                handle: attached.handle.clone(),
                room_id: room().into(),
                expected_room_epoch: epoch().into(),
            },
        );
        assert_eq!(error_code(result), "backpressure");
        assert_eq!(instance.socket_slot.available_permits(), 1);
        assert!(
            tokio::time::timeout(Duration::from_millis(30), listener.accept())
                .await
                .is_err()
        );
        assert_eq!(account.clears.load(Ordering::SeqCst), 0);
        assert_eq!(
            lock(&instance.inner).delivery.delivered_unacked_bytes(),
            MAX_DELIVERED_BYTES
        );
        instance.destroyed();
    }

    #[tokio::test]
    async fn subscription_read_io_before_and_after_ticket_has_reserved_body_free_terminal() {
        for before_dispatch in [true, false] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let socket_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let account = synthetic_account(1);
            let io_error = account.io_error.clone();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                read_http(&mut stream).await;
                send_http(&mut stream, 200, &fixture(Operation::Session, "success")).await;
                if before_dispatch {
                    assert!(
                        tokio::time::timeout(Duration::from_millis(50), listener.accept())
                            .await
                            .is_err()
                    );
                } else {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let raw = read_http(&mut stream).await;
                    assert!(String::from_utf8_lossy(&raw).contains("/ticket "));
                    io_error.store(true, Ordering::SeqCst);
                    send_http(&mut stream, 200, &fixture(Operation::Ticket, "success")).await;
                }
            });
            let instance = make_instance(address, Some(socket_listener.local_addr().unwrap()));
            let mut attached = attach(instance.clone(), account.access.clone(), 1);
            attached.request(session_action()).unwrap();
            attached.event().await;
            wait_http_idle(&instance).await;
            attached.subscribe();
            if before_dispatch {
                // Current-thread scheduling guarantees the accepted subscribe exists,
                // but no background account read or ticket dispatch has run yet.
                account.io_error.store(true, Ordering::SeqCst);
            }
            let revoked = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let raw = attached.notifications.recv().await.unwrap();
                    let value: Value = serde_json::from_str(&raw).unwrap();
                    if value["type"] == "revoked" {
                        break value;
                    }
                }
            })
            .await
            .unwrap();
            assert_eq!(revoked["operation"], "subscribe");
            assert!(revoked["requestId"].is_null());
            assert_eq!(revoked["error"]["code"], "storage-unavailable");
            assert_eq!(revoked["error"]["outcome"], "not-applicable");
            assert_eq!(revoked["subscriptionId"], attached.subscription);
            assert_eq!(account.clears.load(Ordering::SeqCst), 0);
            assert!(!account.access.cancel.is_cancelled());
            assert!(lock(&instance.inner).scope.is_none());
            attached.ack(&revoked).unwrap();
            attached.ack(&revoked).unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(20), socket_listener.accept())
                    .await
                    .is_err()
            );
            instance.destroyed();
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn competing_http_auth_and_subscription_io_emit_one_terminal_and_keep_old_body_debt() {
        for subscription_wins in [true, false] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let account = synthetic_account(1);
            let instance = make_instance(listener.local_addr().unwrap(), None);
            let mut attached = attach(instance.clone(), account.access.clone(), 1);
            let context = lock(&instance.inner)
                .scope
                .as_ref()
                .unwrap()
                .context
                .clone();
            instance
                .publish(&context, &json!({"kind":"status","state":"connecting"}))
                .unwrap();
            let old_body = attached.batch().await;
            let old_debt = lock(&instance.inner).delivery.delivered_unacked_bytes();
            {
                let mut inner = lock(&instance.inner);
                inner.delivery.reserve_subscription_terminal().unwrap();
                inner
                    .delivery
                    .reserve_http_terminal("http-request", Operation::Create)
                    .unwrap();
            }
            let storage = RoomError::new("storage-unavailable", "not-applicable");
            let authentication = RoomError::new("not-authenticated", "not-applied");
            if subscription_wins {
                instance.subscription_error(&context, &storage);
                assert!(instance
                    .revoke_http_auth(&context, &authentication, None, true, false)
                    .is_err());
            } else {
                instance
                    .revoke_http_auth(&context, &authentication, None, true, false)
                    .unwrap();
                instance.subscription_error(&context, &storage);
            }
            let revoked = attached.revocation().await;
            assert_eq!(
                revoked["operation"],
                if subscription_wins {
                    "subscribe"
                } else {
                    "create"
                }
            );
            assert_eq!(
                account.clears.load(Ordering::SeqCst),
                u64::from(!subscription_wins)
            );
            assert!(attached.notifications.try_recv().is_err());
            attached.ack(&revoked).unwrap();
            attached.ack(&revoked).unwrap();
            assert_eq!(
                lock(&instance.inner).delivery.delivered_unacked_bytes(),
                old_debt
            );
            attached.ack(&old_body).unwrap();
            assert_eq!(lock(&instance.inner).delivery.delivered_unacked_bytes(), 0);
            instance.destroyed();
        }
    }

    #[tokio::test]
    async fn online_socket_read_io_consumes_long_lived_subscription_terminal() {
        let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http_address = http.local_addr().unwrap();
        let websocket = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let socket_address = websocket.local_addr().unwrap();
        let (send_next, next) = tokio::sync::oneshot::channel();
        let http_server = tokio::spawn(async move {
            for operation in [Operation::Session, Operation::Ticket] {
                let (mut stream, _) = http.accept().await.unwrap();
                read_http(&mut stream).await;
                send_http(&mut stream, 200, &fixture(operation, "success")).await;
            }
        });
        let socket_server = tokio::spawn(async move {
            let (stream, _) = websocket.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(stream, SelectPresence)
                .await
                .unwrap();
            socket.next().await.unwrap().unwrap();
            for message in [snapshot(), presence(&["user-host", "user-member"])] {
                socket
                    .send(Message::Text(
                        serde_json::to_string(&message).unwrap().into(),
                    ))
                    .await
                    .unwrap();
            }
            next.await.unwrap();
            socket
                .send(Message::Text(
                    serde_json::to_string(&presence(&["user-host"]))
                        .unwrap()
                        .into(),
                ))
                .await
                .unwrap();
            while let Some(message) = socket.next().await {
                if matches!(message.unwrap(), Message::Close(_)) {
                    break;
                }
            }
        });
        let account = synthetic_account(1);
        let instance = make_instance(http_address, Some(socket_address));
        let mut attached = attach(instance.clone(), account.access.clone(), 1);
        attached.request(session_action()).unwrap();
        attached.event().await;
        wait_http_idle(&instance).await;
        attached.subscribe();
        loop {
            let event = attached.event().await;
            if event["kind"] == "status" && event["state"] == "online" {
                break;
            }
        }
        account.io_error.store(true, Ordering::SeqCst);
        send_next.send(()).unwrap();
        let revoked = attached.revocation().await;
        assert_eq!(revoked["operation"], "subscribe");
        assert_eq!(revoked["error"]["code"], "storage-unavailable");
        assert_eq!(account.clears.load(Ordering::SeqCst), 0);
        assert!(!account.access.cancel.is_cancelled());
        attached.ack(&revoked).unwrap();
        assert!(lock(&instance.inner).scope.is_none());
        assert_eq!(lock(&instance.inner).delivery.delivered_unacked_bytes(), 0);
        http_server.await.unwrap();
        socket_server.await.unwrap();
        instance.destroyed();
    }
}
