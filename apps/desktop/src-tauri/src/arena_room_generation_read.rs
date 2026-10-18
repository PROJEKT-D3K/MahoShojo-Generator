//! 当前战报的单原件、按精确 ACK 推进的窄读取路径；不改变房间在线权威。
use super::*;
use crate::arena_room_generation::{GenerationReadTarget, MAX_GENERATION_FRAGMENT_BYTES};
use crate::arena_room_http::GenerationReadResponse;
use crate::arena_room_state::GenerationReplacement;

const TRANSFER_IDLE: Duration = Duration::from_secs(30);
const TRANSFER_LIFETIME: Duration = Duration::from_secs(300);

pub(super) struct GenerationCompletion {
    request_id: String,
    cancel_intent_id: Option<String>,
    receipt: (String, u64),
}

pub(super) struct GenerationTransfer {
    request_id: String,
    target: GenerationReadTarget,
    expected: Value,
    response: Option<GenerationReadResponse>,
    receipt: Option<(String, u64)>,
    cursor: usize,
    final_fragment: bool,
    started: Instant,
    progress: Instant,
    cancel: CancellationToken,
}

pub(super) fn same_generation(left: &Value, right: &Value) -> bool {
    [
        "generationRequestId",
        "generationId",
        "attempt",
        "configRevision",
        "snapshotDigest",
        "collaborativeInfluence",
        "participantUserIds",
        "hostAccountUserId",
    ]
    .iter()
    .all(|field| left[*field] == right[*field])
}
pub(super) fn terminal_barrier(generation: &Value) -> Option<Value> {
    if !terminal(&generation["state"]) {
        return None;
    }
    let mut mirror = generation.clone();
    if let Some(fields) = mirror.as_object_mut() {
        fields.remove("startedAt");
        fields.remove("finishedAt");
    }
    Some(mirror)
}
pub(super) fn terminal(state: &Value) -> bool {
    matches!(state.as_str(), Some("completed" | "failed" | "cancelled"))
}

impl RoomInstance {
    fn generation_current_locked(
        &self,
        inner: &Inner,
        context: &ScopeContext,
        transfer: &GenerationTransfer,
    ) -> Result<(), RoomError> {
        self.current_locked(inner, context)?;
        let authority = inner
            .scope
            .as_ref()
            .and_then(|scope| scope.session.as_ref())
            .ok_or_else(stale)?;
        let generation = authority.generation.as_ref().ok_or_else(stale)?;
        if !authority.generation_fresh
            || authority.room_id != transfer.target.room_id
            || authority.room_epoch != transfer.target.room_epoch
            || !authority
                .members
                .get(&authority.self_id)
                .is_some_and(|(role, state)| role == &authority.self_role && state == "active")
            || !same_generation(generation, &transfer.expected)
        {
            return Err(stale());
        }
        if let Some(basis) = inner
            .pending
            .as_ref()
            .and_then(|pending| pending.cancel_basis.as_ref())
        {
            if !basis.matches(authority) {
                return Err(stale());
            }
        }
        if let Some(response) = &transfer.response {
            if authority
                .generation_read_terminal
                .as_ref()
                .is_some_and(|known| {
                    !same_generation(known, &response.meta.generation)
                        || known["state"] != response.meta.generation["state"]
                })
            {
                return Err(stale());
            }
            if !same_generation(generation, &response.meta.generation)
                || (terminal(&generation["state"])
                    && generation["state"] != response.meta.generation["state"])
            {
                return Err(stale());
            }
        }
        Ok(())
    }

    pub(super) fn start_generation_read(
        self: &Arc<Self>,
        document: DocumentId,
        handle: String,
        generation_id: String,
        expected_room_epoch: String,
        expected_attempt: u64,
    ) -> Result<EngineReply, RoomError> {
        let permit = self
            .http_slot
            .clone()
            .try_acquire_owned()
            .map_err(|_| RoomError::new("busy", "not-applicable"))?;
        let mut inner = lock(&self.inner);
        let context = self.scope_for(&inner, document, &handle)?;
        if inner.generation.is_some() || inner.generation_completion.is_some() {
            return Err(RoomError::new("busy", "not-applicable"));
        }
        let authority = inner
            .scope
            .as_ref()
            .and_then(|scope| scope.session.as_ref())
            .ok_or_else(stale)?;
        let expected = authority.generation.clone().ok_or_else(stale)?;
        if authority.room_epoch != expected_room_epoch
            || expected["generationId"].as_str() != Some(generation_id.as_str())
            || expected["attempt"].as_u64() != Some(expected_attempt)
            || !protocol::canonical_path_id(&authority.room_id)
        {
            return Err(stale());
        }
        if inner.pending.as_ref().is_some_and(|pending| {
            pending.cancel_basis.as_ref().is_none_or(|basis| {
                !basis.read_matches(&authority.room_id, &expected_room_epoch, &expected)
            })
        }) {
            return Err(RoomError::new("busy", "not-applicable"));
        }
        let target = GenerationReadTarget {
            room_id: authority.room_id.clone(),
            room_epoch: expected_room_epoch,
            generation_id,
            attempt: expected_attempt,
        };
        let request_id = random_id()?;
        let transfer = GenerationTransfer {
            request_id: request_id.clone(),
            target: target.clone(),
            expected,
            response: None,
            receipt: None,
            cursor: 0,
            final_fragment: false,
            started: Instant::now(),
            progress: Instant::now(),
            cancel: context.cancel.child_token(),
        };
        self.generation_current_locked(&inner, &context, &transfer)?;
        if let Err(mut error) = inner
            .delivery
            .reserve_http_terminal(&request_id, Operation::GenerationRead)
        {
            error.outcome = "not-applicable";
            if error.code == "backpressure" {
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
            }
            return Err(error);
        }
        let cancel = transfer.cancel.clone();
        inner.generation = Some(transfer);
        let request = HttpRequest {
            operation: Operation::GenerationRead,
            room_id: Some(target.room_id.clone()),
            proposal_id: None,
            request: json!({"generationId":target.generation_id}),
            resume_only: false,
        };
        let accepted = json!({"kind":"accepted","handle":handle,
            "subscriptionId":context.subscription_id,"requestId":request_id});
        drop(inner);
        let this = self.clone();
        let timer_context = context.clone();
        let timer_id = request_id.clone();
        tokio::spawn(async move {
            this.run_generation_read(context, request_id, request, target, cancel, permit)
                .await;
        });
        let this = self.clone();
        tokio::spawn(async move {
            this.watch_generation_read(timer_context, timer_id).await;
        });
        Ok(EngineReply::Small(accepted))
    }

    async fn run_generation_read(
        self: Arc<Self>,
        context: ScopeContext,
        request_id: String,
        request: HttpRequest,
        target: GenerationReadTarget,
        cancel: CancellationToken,
        _permit: OwnedSemaphorePermit,
    ) {
        // HTTP、完整 DTO 校验和 SHA 都在 Room 锁外；permit 仅覆盖真实 HTTP 工作。
        let outcome = match self.current(&context) {
            Ok(()) => {
                self.http
                    .execute_generation_read(
                        &request,
                        context.account.user_id,
                        &context.account.cookie,
                        &cancel,
                        &target,
                    )
                    .await
            }
            Err(error) => Err(error),
        };
        if cancel.is_cancelled() {
            return;
        }
        let account_current = context.account.is_current();
        let fresh = self.current(&context);
        let mut inner = lock(&self.inner);
        if inner.generation.as_ref().is_none_or(|transfer| {
            transfer.request_id != request_id
                || transfer.cancel.is_cancelled()
                || transfer.receipt.is_some()
        }) {
            return;
        }
        let current = self.current_locked(&inner, &context);
        let storage = account_current
            .as_ref()
            .err()
            .into_iter()
            .chain(fresh.as_ref().err())
            .chain(current.as_ref().err())
            .chain(outcome.as_ref().err())
            .find(|error| error.code == "storage-unavailable")
            .cloned();
        if let Some(error) = storage {
            let _ = self.revoke_http_storage_locked(&mut inner, &context, &error, None, false);
            return;
        }
        if current.is_err() {
            Self::retire_locked(&mut inner);
            return;
        }
        if let Err(error) = &outcome {
            if error.code == "not-authenticated" {
                // reader nonce、cancel、原账号与真实 Document 在同一锁区再次确认；
                // 中途取消的旧 GET 不可清凭据或撤销仍有效的 socket。
                let _ = self.revoke_http_auth_current_locked(
                    &mut inner, &context, error, None, false, false,
                );
                return;
            }
        }
        match outcome {
            Err(error) => {
                let _ = self.abort_generation_locked(&mut inner, &context, &error);
            }
            Ok(response) => {
                let transfer = inner.generation.as_mut().expect("matched reader");
                transfer.response = Some(response);
                let transfer = inner.generation.as_ref().expect("matched reader");
                if let Err(error) = self.generation_current_locked(&inner, &context, transfer) {
                    let _ = self.abort_generation_locked(&mut inner, &context, &error);
                    return;
                }
                let response = transfer.response.as_ref().expect("validated response");
                let descriptor = json!({"kind":"generation-descriptor","requestId":request_id,
                    "roomId":target.room_id,"roomEpoch":target.room_epoch,"generationId":target.generation_id,
                    "attempt":target.attempt,"byteLength":response.raw.len(),"digest":response.digest});
                match inner.delivery.finish_http_terminal(&descriptor) {
                    Ok(true) => {
                        let receipt = inner.delivery.http_terminal_batch();
                        let transfer = inner.generation.as_mut().expect("matched reader");
                        transfer.receipt = receipt;
                        transfer.progress = Instant::now();
                        if self.notify_identity_locked(&mut inner, &context).is_err() {
                            Self::retire_locked(&mut inner);
                        }
                    }
                    Ok(false) => {
                        inner.generation = None;
                        let _ = self.notify_identity_locked(&mut inner, &context);
                    }
                    Err(_) => Self::retire_locked(&mut inner),
                }
            }
        }
    }

    /// 先销毁唯一原件/取消本机 GET，再替换或追加固定错误；不撤销服务器生成。
    pub(super) fn abort_generation_locked(
        &self,
        inner: &mut Inner,
        context: &ScopeContext,
        failure: &RoomError,
    ) -> Result<(), RoomError> {
        let Some(transfer) = inner.generation.take() else {
            return Ok(());
        };
        transfer.cancel.cancel();
        let request_id = transfer.request_id.clone();
        let receipt = transfer.receipt.clone();
        let final_fragment = transfer.final_fragment;
        if transfer.final_fragment {
            if let Some(receipt) = receipt.clone() {
                let cancel_intent_id = inner
                    .pending
                    .as_ref()
                    .filter(|pending| {
                        pending.cancel_basis.as_ref().is_some_and(|basis| {
                            basis.read_matches(
                                &transfer.target.room_id,
                                &transfer.target.room_epoch,
                                &transfer.expected,
                            )
                        })
                    })
                    .map(|pending| pending.id.clone());
                inner.generation_completion = Some(GenerationCompletion {
                    request_id: request_id.clone(),
                    cancel_intent_id,
                    receipt,
                });
            }
        }
        drop(transfer);
        if !self.identity_current_locked(inner, context) {
            return Err(stale());
        }
        let error = json!({"kind":"request-error","requestId":request_id,
            "operation":"generationRead","error":failure});
        let result = match receipt {
            None => inner.delivery.finish_http_terminal(&error).map(|_| ()),
            Some((batch_id, sequence)) => {
                match inner.delivery.replace_generation_error(
                    context.proof.document,
                    &context.handle,
                    &context.subscription_id,
                    (&batch_id, sequence),
                    &request_id,
                    failure,
                ) {
                    Ok(GenerationReplacement::Replaced) => Ok(()),
                    Ok(GenerationReplacement::AlreadyPulled) if final_fragment => Ok(()),
                    Ok(GenerationReplacement::AlreadyPulled) => inner.delivery.enqueue(&error),
                    Ok(GenerationReplacement::NotCurrent) => Err(stale()),
                    Err(error) => Err(error),
                }
            }
        };
        if let Err(error) = result {
            Self::retire_locked(inner);
            return Err(error);
        }
        if let Err(error) = self.notify_identity_locked(inner, context) {
            Self::retire_locked(inner);
            return Err(error);
        }
        Ok(())
    }

    /// 每次 pull/ACK 之前重新校验，已撤销成员或 generation 绝不再交正文。
    pub(super) fn check_generation_locked(
        &self,
        inner: &mut Inner,
        context: &ScopeContext,
    ) -> Result<(), RoomError> {
        let checked = inner
            .generation
            .as_ref()
            .map(|transfer| self.generation_current_locked(inner, context, transfer));
        if let Some(Err(error)) = checked {
            if error.code == "storage-unavailable" {
                let notify = inner.scope.as_ref().map(|scope| scope.notify.clone());
                if self.identity_current_locked(inner, context) {
                    if let (Some(notify), Ok(notification)) =
                        (notify, inner.delivery.take_subscription_revoked(&error))
                    {
                        let _ = notify(notification);
                    }
                }
                Self::retire_locked(inner);
                return Err(error);
            }
            if !self.identity_current_locked(inner, context) {
                Self::retire_locked(inner);
                return Err(error);
            }
            self.abort_generation_locked(inner, context, &error)?;
        }
        Ok(())
    }

    pub(super) fn generation_ack_matches(
        inner: &Inner,
        batch_id: &str,
        sequence: u64,
        accepted: bool,
    ) -> bool {
        accepted
            && inner.generation.as_ref().is_some_and(|transfer| {
                transfer
                    .receipt
                    .as_ref()
                    .is_some_and(|receipt| receipt.0 == batch_id && receipt.1 == sequence)
            })
    }

    pub(super) fn generation_cancel_ack_intent(
        inner: &Inner,
        batch_id: &str,
        sequence: u64,
        accepted: bool,
    ) -> Option<String> {
        if !accepted {
            return None;
        }
        if let Some(completion) = inner.generation_completion.as_ref().filter(|completion| {
            completion.receipt.0 == batch_id && completion.receipt.1 == sequence
        }) {
            return completion.cancel_intent_id.clone();
        }
        let transfer = inner.generation.as_ref().filter(|transfer| {
            transfer.final_fragment
                && transfer
                    .receipt
                    .as_ref()
                    .is_some_and(|receipt| receipt.0 == batch_id && receipt.1 == sequence)
        })?;
        inner
            .pending
            .as_ref()
            .filter(|pending| {
                pending.cancel_basis.as_ref().is_some_and(|basis| {
                    basis.read_matches(
                        &transfer.target.room_id,
                        &transfer.target.room_epoch,
                        &transfer.expected,
                    )
                })
            })
            .map(|pending| pending.id.clone())
    }

    pub(super) fn acknowledge_generation_locked(
        &self,
        inner: &mut Inner,
        context: &ScopeContext,
        batch_id: &str,
        sequence: u64,
        accepted: bool,
    ) -> Result<Option<Value>, RoomError> {
        if accepted
            && inner
                .generation_completion
                .as_ref()
                .is_some_and(|completion| {
                    completion.receipt.0 == batch_id && completion.receipt.1 == sequence
                })
        {
            let completion = inner
                .generation_completion
                .take()
                .expect("matched completion");
            return Ok(Some(
                json!({"requestId":completion.request_id,"current":false}),
            ));
        }
        let matches = accepted
            && inner.generation.as_ref().is_some_and(|transfer| {
                transfer
                    .receipt
                    .as_ref()
                    .is_some_and(|receipt| receipt.0 == batch_id && receipt.1 == sequence)
            });
        if !matches {
            return Ok(None);
        }
        let checked = self.generation_current_locked(
            inner,
            context,
            inner.generation.as_ref().expect("matched reader"),
        );
        if let Err(error) = checked {
            self.check_generation_locked(inner, context)?;
            if let Some(completion) = inner.generation_completion.take() {
                return Ok(Some(
                    json!({"requestId":completion.request_id,"current":false}),
                ));
            }
            if error.code == "storage-unavailable" {
                return Err(error);
            }
            return Ok(None);
        }
        let transfer = inner.generation.as_mut().expect("matched reader");
        if transfer.final_fragment {
            let completion = json!({"requestId":transfer.request_id,"current":true});
            let generation = &transfer
                .response
                .as_ref()
                .expect("validated response")
                .meta
                .generation;
            let barrier = terminal(&generation["state"]).then(|| generation.clone());
            if let Some(barrier) = barrier {
                let settle_cancel = inner
                    .pending
                    .as_ref()
                    .and_then(|pending| pending.cancel_basis.as_ref())
                    .is_some_and(|basis| {
                        basis.read_matches(
                            &transfer.target.room_id,
                            &transfer.target.room_epoch,
                            &barrier,
                        )
                    });
                inner
                    .scope
                    .as_mut()
                    .and_then(|scope| scope.session.as_mut())
                    .expect("current authority")
                    .generation_read_terminal = Some(barrier);
                if settle_cancel {
                    inner.pending = None;
                }
            }
            inner.generation = None;
            return Ok(Some(completion));
        }
        let raw = &transfer.response.as_ref().ok_or_else(invalid)?.raw;
        let offset = transfer.cursor;
        let mut end = (offset + MAX_GENERATION_FRAGMENT_BYTES).min(raw.len());
        while !raw.is_char_boundary(end) {
            end -= 1;
        }
        if end <= offset {
            return Err(invalid());
        }
        let final_fragment = end == raw.len();
        let event = json!({"kind":"generation-fragment","requestId":transfer.request_id,
            "offset":offset,"text":&raw[offset..end],"final":final_fragment});
        let receipt = match inner.delivery.enqueue_receipted(&event) {
            Ok(receipt) => receipt,
            Err(error) => {
                Self::retire_locked(inner);
                return Err(error);
            }
        };
        let transfer = inner.generation.as_mut().expect("matched reader");
        transfer.receipt = Some(receipt);
        transfer.cursor = end;
        transfer.final_fragment = final_fragment;
        transfer.progress = Instant::now();
        Ok(None)
    }

    async fn watch_generation_read(self: Arc<Self>, context: ScopeContext, request_id: String) {
        loop {
            tokio::select! {
                _ = context.cancel.cancelled() => return,
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            }
            let mut inner = lock(&self.inner);
            let Some(transfer) = inner
                .generation
                .as_ref()
                .filter(|transfer| transfer.request_id == request_id)
            else {
                return;
            };
            let timed_out = transfer.started.elapsed() >= TRANSFER_LIFETIME
                || transfer.progress.elapsed() >= TRANSFER_IDLE;
            if timed_out {
                if self.check_generation_locked(&mut inner, &context).is_ok() {
                    let _ = self.abort_generation_locked(
                        &mut inner,
                        &context,
                        &RoomError::new("network-error", "not-applicable"),
                    );
                }
                return;
            }
            if self.check_generation_locked(&mut inner, &context).is_err() {
                return;
            }
        }
    }
}
