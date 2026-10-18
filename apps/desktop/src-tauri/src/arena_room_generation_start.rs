//! 固定 system-default 启动：唯一冻结 wire、原 Document/凭据围栏与显式同意图重试。
use super::*;
use generation_read::{same_generation, terminal};

pub(super) struct StartBasis {
    room_id: String,
    room_epoch: String,
    request_id: String,
    self_id: String,
    account_user_id: u64,
    revision: u64,
    control_seq: u64,
    config_digest: [u8; 32],
    pub(super) document: DocumentId,
    generation: Option<Value>,
    read_not_found: bool,
    wire: Option<Arc<Vec<u8>>>,
}
impl StartBasis {
    fn prepare(
        authority: &Authority,
        document: DocumentId,
        account_user_id: u64,
        room: &str,
        request: &Value,
    ) -> Result<Self, RoomError> {
        let basis = Self {
            room_id: room.into(),
            room_epoch: request["expectedRoomEpoch"]
                .as_str()
                .ok_or_else(invalid)?
                .into(),
            request_id: request["generationRequestId"]
                .as_str()
                .ok_or_else(invalid)?
                .into(),
            self_id: authority.self_id.clone(),
            account_user_id,
            revision: request["expectedRevision"].as_u64().ok_or_else(invalid)?,
            control_seq: request["expectedControlSeq"].as_u64().ok_or_else(invalid)?,
            config_digest: exact_config_digest(&request["sharedConfig"]),
            document,
            generation: None,
            read_not_found: false,
            wire: None,
        };
        basis.first_dispatch(authority)?;
        let config = &request["sharedConfig"];
        let combatants = config["combatants"].as_array().ok_or_else(invalid)?;
        let minimum = match config["battleMode"].as_str() {
            Some("classic" | "kizuna") => 2,
            Some("daily" | "scenario") => 1,
            _ => return Err(stale()),
        };
        if combatants.len() < minimum
            || combatants.len() > 32
            || (config["battleMode"] == "scenario" && config["scenario"].is_null())
        {
            return Err(RoomError::new("invalid-request", "not-applied"));
        }
        // Exact key/kind coverage is checked before dispatch; authoritative materialization
        // additionally checks payload digest, type, references and runtime budgets.
        let mut local = BTreeMap::new();
        for (entries, kind) in [
            ("combatants", "character"),
            ("auxScenarios", "scenario"),
            ("materials", "material"),
        ] {
            for entry in config[entries].as_array().ok_or_else(invalid)? {
                if entry["source"] == "host-local"
                    && (entry["contentVersion"].is_null()
                        || local
                            .insert(entry["key"].as_str().ok_or_else(invalid)?, kind)
                            .is_some())
                {
                    return Err(stale());
                }
            }
        }
        let scenario = &config["scenario"];
        if scenario["source"] == "host-local"
            && (scenario["contentVersion"].is_null()
                || local
                    .insert(scenario["key"].as_str().ok_or_else(invalid)?, "scenario")
                    .is_some())
        {
            return Err(stale());
        }
        let payloads = request["hostLocalPayloads"]
            .as_array()
            .ok_or_else(invalid)?;
        if payloads.len() != local.len()
            || payloads.iter().any(|entry| {
                local.get(entry["key"].as_str().unwrap_or("")).copied() != entry["kind"].as_str()
            })
        {
            return Err(stale());
        }
        Ok(basis)
    }
    fn scope_matches(&self, authority: &Authority) -> bool {
        authority.room_id == self.room_id
            && authority.room_epoch == self.room_epoch
            && authority.self_id == self.self_id
            && authority.self_role == "host"
            && authority
                .members
                .get(&self.self_id)
                .is_some_and(|(role, state)| role == "host" && state == "active")
    }
    fn live_host(&self, authority: &Authority) -> bool {
        self.scope_matches(authority)
            && authority.snapshot_seen
            && authority.presence_seen
            && authority.online.contains(&self.self_id)
            && authority.generation_fresh
            && authority.proposals_fresh
    }
    fn first_dispatch(&self, authority: &Authority) -> Result<(), RoomError> {
        if !self.live_host(authority)
            || authority.revision != self.revision
            || authority.control_seq != self.control_seq
            || authority.config_digest != Some(self.config_digest)
            || authority
                .generation
                .as_ref()
                .is_some_and(|g| !terminal(&g["state"]))
        {
            return Err(stale());
        }
        Ok(())
    }
    fn retry_ready(&self) -> bool {
        self.wire.is_some()
            && self
                .generation
                .as_ref()
                .is_none_or(|g| g["state"] == "starting" && self.read_not_found)
    }
    fn retry_dispatch(&self, authority: &Authority) -> Result<(), RoomError> {
        if !self.live_host(authority) || !self.retry_ready() {
            return Err(stale());
        }
        if let Some(generation) = &authority.generation {
            if generation["generationRequestId"] == self.request_id {
                if self
                    .generation
                    .as_ref()
                    .is_none_or(|known| !same_generation(known, generation))
                    || generation["state"] != "starting"
                    || !self.read_not_found
                {
                    return Err(stale());
                }
            } else if !terminal(&generation["state"]) {
                return Err(stale());
            }
        }
        Ok(())
    }
    fn check_mirror(&self, generation: &Value) -> Result<(), RoomError> {
        if generation["generationRequestId"] != self.request_id
            || generation["configRevision"] != self.revision
            || generation
                .get("hostAccountUserId")
                .is_some_and(|id| id.as_u64() != Some(self.account_user_id))
            || self.generation.as_ref().is_some_and(|known| {
                !same_generation(known, generation)
                    || (terminal(&known["state"]) && known["state"] != generation["state"])
            })
        {
            return Err(invalid());
        }
        Ok(())
    }
    fn observe(&mut self, generation: &Value) -> Result<(), RoomError> {
        self.check_mirror(generation)?;
        if self.generation.as_ref().is_none_or(|known| {
            known["state"] == "starting"
                || (known["state"] == "running" && generation["state"] != "starting")
        }) {
            let mut identity = serde_json::Map::new();
            for key in [
                "generationRequestId",
                "generationId",
                "attempt",
                "configRevision",
                "snapshotDigest",
                "collaborativeInfluence",
                "participantUserIds",
                "hostAccountUserId",
                "state",
            ] {
                if let Some(value) = generation.get(key) {
                    identity.insert(key.into(), value.clone());
                }
            }
            self.generation = Some(Value::Object(identity));
        }
        if generation["state"] != "starting" {
            self.read_not_found = false;
        }
        Ok(())
    }
    pub(super) fn public(&self, phase: IntentPhase) -> Value {
        json!({"roomEpoch":self.room_epoch,"generationRequestId":self.request_id,"retryable":phase == IntentPhase::Unknown && self.retry_ready()})
    }
    pub(super) fn target(&self) -> Option<Value> {
        self.generation.as_ref().map(|generation| json!({"roomEpoch":self.room_epoch,"generationId":generation["generationId"],"attempt":generation["attempt"]}))
    }
    pub(super) fn read_matches(&self, room: &str, epoch: &str, generation: &Value) -> bool {
        self.room_id == room
            && self.room_epoch == epoch
            && self
                .generation
                .as_ref()
                .is_some_and(|known| same_generation(known, generation))
    }
    #[cfg(test)]
    pub(super) fn frozen_observation(&self) -> Option<(std::sync::Weak<Vec<u8>>, usize, usize)> {
        self.wire
            .as_ref()
            .map(|wire| (Arc::downgrade(wire), wire.len(), Arc::strong_count(wire)))
    }
    pub(super) fn revoke(&mut self) {
        self.wire = None;
        self.read_not_found = false;
    }
}

impl RoomInstance {
    pub(crate) fn request_owned(
        self: &Arc<Self>,
        document: DocumentId,
        raw: Value,
    ) -> Result<EngineReply, RoomError> {
        if raw["request"]["kind"] != "generation-start" {
            return self.request(document, protocol::parse_request(&raw)?);
        }
        // Acquire before normalization, DTO validation and freezing; old retired tasks still own it.
        let permit = self
            .http_slot
            .clone()
            .try_acquire_owned()
            .map_err(|_| busy())?;
        // Reject occupied/unacknowledged original before doing expensive work on a second AST.
        {
            let inner = lock(&self.inner);
            if inner.start_fence.is_some()
                || inner.pending.is_some()
                || inner.generation.is_some()
                || inner.generation_completion.is_some()
            {
                return Err(busy());
            }
        }
        let input = protocol::parse_generation_start_owned(raw)?;
        let mut inner = lock(&self.inner);
        let context = self.scope_for(&inner, document, &input.handle)?;
        if inner.start_fence.is_some()
            || inner.pending.is_some()
            || inner.generation.is_some()
            || inner.generation_completion.is_some()
        {
            return Err(busy());
        }
        let scope = inner.scope.as_ref().ok_or_else(stale)?;
        if scope
            .socket_cancel
            .as_ref()
            .is_none_or(|socket| socket.is_cancelled())
        {
            return Err(stale());
        }
        let mut basis = StartBasis::prepare(
            scope.session.as_ref().ok_or_else(stale)?,
            document,
            context.account.user_id,
            &input.room_id,
            &input.request,
        )?;
        let wire = protocol::freeze_generation_start(input.request, context.account.user_id)?;
        basis.wire = Some(wire.clone());
        let request_id = random_id()?;
        inner
            .delivery
            .reserve_http_terminal(&request_id, Operation::GenerationStart)?;
        inner.pending = Some(PendingIntent {
            id: request_id.clone(),
            operation: Operation::GenerationStart,
            room_id: Some(input.room_id.clone()),
            frozen_request: Value::Null,
            config_basis: None,
            proposal_basis: None,
            cancel_basis: None,
            start_basis: Some(basis),
            proposal_scope: None,
            account: context.account.clone(),
            phase: IntentPhase::InFlight,
            receipt: None,
        });
        let request = HttpRequest {
            operation: Operation::GenerationStart,
            room_id: Some(input.room_id),
            proposal_id: None,
            request: Value::Null,
            resume_only: false,
        };
        let reply = json!({"kind":"accepted","handle":input.handle,"subscriptionId":context.subscription_id,"requestId":request_id});
        drop(inner);
        let this = self.clone();
        tokio::spawn(async move {
            this.run_http(
                context,
                request_id.clone(),
                request,
                Some(request_id),
                MutationDispatch::Start(wire),
                permit,
            )
            .await;
        });
        Ok(EngineReply::Small(reply))
    }
    pub(super) fn retry_generation_start(
        self: &Arc<Self>,
        document: DocumentId,
        handle: String,
        intent: String,
    ) -> Result<EngineReply, RoomError> {
        let permit = self
            .http_slot
            .clone()
            .try_acquire_owned()
            .map_err(|_| busy())?;
        let mut inner = lock(&self.inner);
        let original_current = inner
            .pending
            .as_ref()
            .filter(|p| p.start_basis.is_some())
            .map(|p| p.account.is_current())
            .transpose()?;
        if original_current == Some(false) {
            Self::retire_start_locked(&mut inner);
            return Err(stale());
        }
        let context = self.scope_for(&inner, document, &handle)?;
        let pending = inner
            .pending
            .as_ref()
            .filter(|p| {
                p.id == intent
                    && p.operation == Operation::GenerationStart
                    && p.phase == IntentPhase::Unknown
            })
            .ok_or_else(stale)?;
        if pending.account.epoch != context.account.epoch
            || pending.account.user_id != context.account.user_id
            || pending.account.cookie != context.account.cookie
            || !pending.account.is_current()?
            || inner.generation.is_some()
            || inner.generation_completion.is_some()
        {
            return Err(stale());
        }
        let basis = pending.start_basis.as_ref().ok_or_else(stale)?;
        if basis.document != document {
            return Err(stale());
        }
        let scope = inner.scope.as_ref().ok_or_else(stale)?;
        if scope
            .socket_cancel
            .as_ref()
            .is_none_or(|socket| socket.is_cancelled())
        {
            return Err(stale());
        }
        basis.retry_dispatch(scope.session.as_ref().ok_or_else(stale)?)?;
        let wire = basis.wire.clone().ok_or_else(stale)?;
        let request = HttpRequest {
            operation: Operation::GenerationStart,
            room_id: Some(basis.room_id.clone()),
            proposal_id: None,
            request: Value::Null,
            resume_only: true,
        };
        let request_id = random_id()?;
        inner
            .delivery
            .reserve_http_terminal(&request_id, Operation::GenerationStart)?;
        let pending = inner.pending.as_mut().unwrap();
        pending.phase = IntentPhase::InFlight;
        pending.receipt = None;
        let reply = json!({"kind":"accepted","handle":handle,"subscriptionId":context.subscription_id,"requestId":request_id});
        drop(inner);
        let this = self.clone();
        tokio::spawn(async move {
            this.run_http(
                context,
                request_id,
                request,
                Some(intent),
                MutationDispatch::Start(wire),
                permit,
            )
            .await;
        });
        Ok(EngineReply::Small(reply))
    }
    pub(super) fn check_start_dispatch(
        &self,
        context: &ScopeContext,
        intent: &str,
        retry: bool,
    ) -> Result<(), RoomError> {
        let inner = lock(&self.inner);
        self.current_locked(&inner, context)?;
        let pending = inner
            .pending
            .as_ref()
            .filter(|p| p.id == intent && p.phase == IntentPhase::InFlight)
            .ok_or_else(stale)?;
        if !pending.account.is_current()?
            || pending.account.epoch != context.account.epoch
            || pending.account.user_id != context.account.user_id
            || pending.account.cookie != context.account.cookie
        {
            return Err(stale());
        }
        let basis = pending.start_basis.as_ref().ok_or_else(stale)?;
        let scope = inner.scope.as_ref().ok_or_else(stale)?;
        if basis.document != context.proof.document
            || basis.wire.is_none()
            || scope
                .socket_cancel
                .as_ref()
                .is_none_or(|socket| socket.is_cancelled())
        {
            return Err(stale());
        }
        if retry {
            basis.retry_dispatch(scope.session.as_ref().ok_or_else(stale)?)
        } else {
            basis.first_dispatch(scope.session.as_ref().ok_or_else(stale)?)
        }
    }
    pub(super) fn check_start_candidate(
        inner: &Inner,
        candidate: &Authority,
    ) -> Result<(), RoomError> {
        if let Some(basis) = inner.pending.as_ref().and_then(|p| p.start_basis.as_ref()) {
            if basis.scope_matches(candidate) {
                if let Some(generation) = candidate
                    .generation
                    .as_ref()
                    .filter(|g| g["generationRequestId"] == basis.request_id)
                {
                    basis.check_mirror(generation)?;
                }
            }
        }
        Ok(())
    }
    pub(super) fn inspect_start_scope_message(inner: &mut Inner, message: &Value) {
        let Some(basis) = inner.pending.as_mut().and_then(|p| p.start_basis.as_mut()) else {
            return;
        };
        if message["roomId"] == basis.room_id {
            let lost =
                message["roomEpoch"] != basis.room_epoch
                    || match message["type"].as_str() {
                        Some("room.snapshot") => message["payload"]["members"]
                            .as_array()
                            .is_some_and(|members| {
                                members
                                    .iter()
                                    .find(|member| member["userId"] == basis.self_id)
                                    .is_none_or(|member| {
                                        member["role"] != "host"
                                            || member["membershipState"] != "active"
                                    })
                            }),
                        Some("room.member.left" | "room.member.joined") => {
                            message["payload"]["member"]["userId"] == basis.self_id
                                && (message["payload"]["member"]["role"] != "host"
                                    || message["payload"]["member"]["membershipState"] != "active")
                        }
                        _ => false,
                    };
            if lost {
                basis.revoke();
            }
        }
    }
    pub(super) fn observe_start_locked(inner: &mut Inner) -> Result<(), RoomError> {
        if let (Some(fence), Some(scope)) = (&mut inner.start_fence, &inner.scope) {
            if fence.basis.account_user_id == scope.context.account.user_id {
                if let Some(authority) = scope.session.as_ref().filter(|a| {
                    a.room_id == fence.basis.room_id
                        && a.room_epoch == fence.basis.room_epoch
                        && a.generation_fresh
                }) {
                    if let Some(generation) = &authority.generation {
                        // A starting reservation binds the complete identity but never frees
                        // capacity. Conflicting unrelated authority remains readable.
                        let _ = fence.basis.observe(generation);
                    }
                }
            }
        }
        let authority = inner.scope.as_ref().and_then(|s| s.session.as_ref());
        let Some(basis) = inner.pending.as_mut().and_then(|p| p.start_basis.as_mut()) else {
            return Ok(());
        };
        if let Some(authority) = authority {
            if !basis.scope_matches(authority) {
                basis.revoke();
            } else if authority.generation_fresh {
                if let Some(generation) = authority
                    .generation
                    .as_ref()
                    .filter(|g| g["generationRequestId"] == basis.request_id)
                {
                    basis.observe(generation)?;
                }
            }
        }
        Ok(())
    }
    pub(super) fn install_start_receipt(
        &self,
        context: &ScopeContext,
        response: &Value,
    ) -> Result<(), RoomError> {
        let mut inner = lock(&self.inner);
        self.current_locked(&inner, context)?;
        Self::check_start_receipt(&inner, context, response)?;
        let basis = inner
            .pending
            .as_mut()
            .and_then(|p| p.start_basis.as_mut())
            .ok_or_else(stale)?;
        basis.observe(&response["result"]["generation"])
    }
    pub(super) fn check_start_receipt(
        inner: &Inner,
        context: &ScopeContext,
        response: &Value,
    ) -> Result<(), RoomError> {
        let basis = inner
            .pending
            .as_ref()
            .and_then(|p| p.start_basis.as_ref())
            .ok_or_else(stale)?;
        let authority = inner
            .scope
            .as_ref()
            .and_then(|s| s.session.as_ref())
            .ok_or_else(stale)?;
        let result = &response["result"];
        if basis.document != context.proof.document
            || !basis.scope_matches(authority)
            || result["roomId"] != basis.room_id
            || result["roomEpoch"] != basis.room_epoch
        {
            return Err(stale());
        }
        basis.check_mirror(&result["generation"])
    }
    pub(super) fn start_current(inner: &Inner, context: &ScopeContext) -> bool {
        inner.pending.as_ref().is_some_and(|p| {
            p.account.epoch == context.account.epoch
                && p.account.user_id == context.account.user_id
                && p.account.cookie == context.account.cookie
                && p.start_basis.as_ref().is_some_and(|basis| {
                    basis.document == context.proof.document
                        && basis
                            .generation
                            .as_ref()
                            .is_some_and(|generation| generation["state"] != "starting")
                        && inner
                            .scope
                            .as_ref()
                            .and_then(|s| s.session.as_ref())
                            .is_some_and(|a| basis.scope_matches(a))
                })
        })
    }
    pub(super) fn start_authority_current(inner: &Inner, context: &ScopeContext) -> bool {
        Self::start_current(inner, context)
            && inner
                .pending
                .as_ref()
                .and_then(|p| p.start_basis.as_ref())
                .is_some_and(|basis| {
                    inner
                        .scope
                        .as_ref()
                        .and_then(|s| s.session.as_ref())
                        .is_some_and(|a| {
                            a.generation_fresh
                                && a.generation.as_ref().is_some_and(|g| {
                                    basis
                                        .generation
                                        .as_ref()
                                        .is_some_and(|known| same_generation(known, g))
                                })
                        })
                })
    }
    pub(super) fn receipt_start_locked(
        inner: &mut Inner,
        context: &ScopeContext,
        receipt: IntentReceipt,
    ) {
        if !Self::start_current(inner, context) {
            return;
        }
        let pending = inner.pending.as_mut().unwrap();
        if pending.phase != IntentPhase::AwaitingAck {
            pending.phase = IntentPhase::AwaitingAck;
            pending.receipt = Some(receipt);
        }
    }
    pub(super) fn publish_start_unknown_locked(
        inner: &mut Inner,
        context: &ScopeContext,
    ) -> Result<(), RoomError> {
        if let Some(pending) = inner.pending.as_ref().filter(|p| {
            p.start_basis.is_some()
                && p.phase == IntentPhase::Unknown
                && p.account.epoch == context.account.epoch
                && p.account.user_id == context.account.user_id
                && p.account.cookie == context.account.cookie
        }) {
            let mut event = pending.public();
            event["kind"] = json!("mutation-unknown");
            inner.delivery.enqueue(&event)?;
        }
        Ok(())
    }
    pub(super) fn revoke_start_locked(inner: &mut Inner) {
        if let Some(basis) = inner.pending.as_mut().and_then(|p| p.start_basis.as_mut()) {
            basis.revoke();
        }
    }
    pub(super) fn start_read_not_found(
        inner: &mut Inner,
        target: &crate::arena_room_generation::GenerationReadTarget,
        error: &RoomError,
    ) {
        if let Some(basis) = inner.pending.as_mut().and_then(|p| p.start_basis.as_mut()) {
            if basis.room_id == target.room_id
                && basis.room_epoch == target.room_epoch
                && basis.generation.as_ref().is_some_and(|g| {
                    g["generationId"] == target.generation_id
                        && g["attempt"] == target.attempt
                        && g["state"] == "starting"
                })
            {
                basis.read_not_found =
                    error.server_code == Some("ROOM_NOT_FOUND") && error.code == "service-rejected";
            }
        }
    }
}

// A single logical start slot is reserved at admission (pending or tombstone).
// Retirement keeps only the original owner/room/request identity, never credentials or wire.
pub(super) struct StartTombstone {
    basis: StartBasis,
    receipt: Option<IntentReceipt>,
    closed: bool,
}
impl RoomInstance {
    pub(super) fn retire_start_locked(inner: &mut Inner) {
        if inner
            .pending
            .as_ref()
            .is_none_or(|p| p.start_basis.is_none())
        {
            return;
        }
        // Admission never allows a second start while this single slot is occupied.
        debug_assert!(inner.start_fence.is_none());
        let mut pending = inner.pending.take().expect("start reservation");
        let mut basis = pending.start_basis.take().expect("start basis");
        basis.revoke();
        inner.start_fence = Some(StartTombstone {
            basis,
            receipt: None,
            closed: false,
        });
        // pending.account is dropped here. Physical HTTP and handed-out delivery debt
        // remain held by their original task/queue and are not touched by this transition.
    }
    pub(super) fn start_fence_public(inner: &Inner, owner: u64) -> Value {
        inner
            .start_fence
            .as_ref()
            .filter(|f| f.basis.account_user_id == owner)
            .map(|f| json!({"roomId":f.basis.room_id,"generationRequestId":f.basis.request_id}))
            .unwrap_or(Value::Null)
    }
    pub(super) fn end_generation_start_tracking(
        &self,
        document: DocumentId,
        handle: String,
        intent_id: String,
    ) -> Result<EngineReply, RoomError> {
        let mut inner = lock(&self.inner);
        let context = self.scope_for(&inner, document, &handle)?;
        let pending = inner.pending.as_ref().ok_or_else(stale)?;
        if pending.id != intent_id
            || pending.phase != IntentPhase::Unknown
            || pending.account.user_id != context.account.user_id
            || pending.account.epoch != context.account.epoch
            || pending.account.cookie != context.account.cookie
            || !pending.account.is_current()?
            || pending
                .start_basis
                .as_ref()
                .is_none_or(|b| b.document != document)
        {
            return Err(stale());
        }
        Self::retire_start_locked(&mut inner);
        Ok(EngineReply::Small(
            json!({"kind":"generation-start-tracking-ended","intentId":intent_id,"ended":true,"generationStartBlocked":true,"generationStartFence":Self::start_fence_public(&inner, context.account.user_id)}),
        ))
    }
    pub(super) fn fail_start_fence_receipt(inner: &mut Inner, context: &ScopeContext) {
        if let Some(fence) = inner.start_fence.as_mut().filter(|f| {
            f.receipt.as_ref().is_some_and(|r| {
                r.handle == context.handle && r.subscription_id == context.subscription_id
            })
        }) {
            fence.receipt = None;
            fence.closed = false;
        }
    }
    pub(super) fn start_fence_authority_current(inner: &Inner, context: &ScopeContext) -> bool {
        let Some(fence) = &inner.start_fence else {
            return false;
        };
        let basis = &fence.basis;
        basis.account_user_id == context.account.user_id
            && inner
                .scope
                .as_ref()
                .and_then(|s| s.session.as_ref())
                .is_some_and(|a| {
                    a.room_id == basis.room_id
                        && a.room_epoch == basis.room_epoch
                        && a.members
                            .get(&a.self_id)
                            .is_some_and(|(_, state)| state == "active")
                        && a.generation_fresh
                        && a.generation.as_ref().is_some_and(|g| {
                            g["state"] != "starting" && basis.check_mirror(g).is_ok()
                        })
                })
    }
    pub(super) fn receipt_start_fence_generation(
        inner: &mut Inner,
        context: &ScopeContext,
        receipt: IntentReceipt,
    ) {
        if !Self::start_fence_authority_current(inner, context) {
            return;
        }
        let generation = inner
            .scope
            .as_ref()
            .and_then(|s| s.session.as_ref())
            .and_then(|a| a.generation.as_ref())
            .unwrap();
        let fence = inner.start_fence.as_mut().unwrap();
        if fence.basis.observe(generation).is_ok() && fence.receipt.is_none() {
            fence.receipt = Some(receipt);
            fence.closed = false;
        }
    }
    pub(super) fn receipt_start_fence_http(
        inner: &mut Inner,
        context: &ScopeContext,
        request: &HttpRequest,
        response: &Value,
        receipt: IntentReceipt,
    ) {
        let result = &response["result"];
        if request.operation == Operation::Session
            && Self::start_fence_authority_current(inner, context)
        {
            let basis = &inner.start_fence.as_ref().unwrap().basis;
            if result["roomId"] == basis.room_id
                && result["roomEpoch"] == basis.room_epoch
                && basis
                    .check_mirror(&result["snapshot"]["activeGeneration"])
                    .is_ok()
                && result["snapshot"]["activeGeneration"]["state"] != "starting"
            {
                Self::receipt_start_fence_generation(inner, context, receipt);
            }
        } else if request.operation == Operation::Close && result["outcome"] == "closed" {
            if let Some(fence) = inner.start_fence.as_mut().filter(|f| {
                f.basis.account_user_id == context.account.user_id
                    && request.room_id.as_deref() == Some(f.basis.room_id.as_str())
                    && result["roomId"] == f.basis.room_id
            }) {
                // The canonical Close dispatch checked the current authenticated host and
                // exact expected room epoch. Its closed outcome is not a cancellation claim.
                fence.receipt = Some(receipt);
                fence.closed = true;
            }
        }
    }
    pub(super) fn ack_start_fence_locked(
        &self,
        inner: &mut Inner,
        document: DocumentId,
        handle: &str,
        subscription: &str,
        batch: &str,
        sequence: u64,
    ) -> Option<Value> {
        inner.start_fence.as_ref()?;
        let context = inner.scope.as_ref()?.context.clone();
        if context.proof.document != document
            || context.handle != handle
            || context.subscription_id != subscription
            || self.current_locked(inner, &context).is_err()
        {
            return None;
        }
        let fence = inner.start_fence.as_ref()?;
        if fence.basis.account_user_id != context.account.user_id
            || fence.receipt.as_ref().is_none_or(|r| {
                r.document != document
                    || r.handle != handle
                    || r.subscription_id != subscription
                    || r.batch_id != batch
                    || r.sequence != sequence
            })
            || (!fence.closed && !Self::start_fence_authority_current(inner, &context))
        {
            return None;
        }
        let fence = inner.start_fence.take().unwrap();
        Some(
            json!({"roomId":fence.basis.room_id,"generationRequestId":fence.basis.request_id,"cleared":true}),
        )
    }
}
