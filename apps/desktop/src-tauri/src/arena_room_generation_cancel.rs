//! 当前 host 的一次取消意图。业务取消只发送一次，终态证据须由当前消费者精确确认。
use super::*;
use generation_read::{same_generation, terminal};

#[derive(Clone)]
pub(super) struct StartingCancelLink {
    pub(super) start_intent_id: String,
    pub(super) cancel_intent_id: String,
    pub(super) document: DocumentId,
}

#[derive(Clone)]
pub(super) struct CancelBasis {
    room_id: String,
    room_epoch: String,
    generation: Value,
    terminal_state: Option<String>,
    pub(super) starting: Option<StartingCancelLink>,
}

impl CancelBasis {
    pub(super) fn prepare(
        authority: &Authority,
        room: &str,
        epoch: &str,
        generation: &str,
        attempt: u64,
    ) -> Result<Self, RoomError> {
        let basis = Self {
            room_id: room.into(),
            room_epoch: epoch.into(),
            generation: authority.generation.clone().ok_or_else(stale)?,
            terminal_state: None,
            starting: None,
        };
        if basis.generation["generationId"].as_str() != Some(generation)
            || basis.generation["attempt"].as_u64() != Some(attempt)
        {
            return Err(stale());
        }
        basis.dispatch_current(authority)?;
        Ok(basis)
    }
    pub(super) fn from_start(
        authority: &Authority,
        link: StartingCancelLink,
    ) -> Result<Self, RoomError> {
        let generation = authority.generation.as_ref().ok_or_else(stale)?;
        if generation["state"] != "starting" {
            return Err(stale());
        }
        let mut basis = Self::prepare(
            authority,
            &authority.room_id,
            &authority.room_epoch,
            generation["generationId"].as_str().ok_or_else(stale)?,
            generation["attempt"].as_u64().ok_or_else(stale)?,
        )?;
        basis.starting = Some(link);
        Ok(basis)
    }
    pub(super) fn request(&self) -> HttpRequest {
        let mut expected = self.generation.clone();
        let object = expected.as_object_mut().expect("validated generation");
        object.remove("state");
        object.remove("startedAt");
        object.remove("finishedAt");
        HttpRequest {
            operation: Operation::GenerationCancel,
            room_id: Some(self.room_id.clone()),
            proposal_id: None,
            resume_only: false,
            request: json!({"generationId":self.generation["generationId"],"expectedRoomEpoch":self.room_epoch,"expectedGeneration":expected}),
        }
    }
    pub(super) fn target(&self) -> Value {
        json!({"roomEpoch":self.room_epoch,"generationId":self.generation["generationId"],"attempt":self.generation["attempt"]})
    }
    fn same_tuple(&self, generation: &Value) -> bool {
        generation["generationId"] == self.generation["generationId"]
            && generation["attempt"] == self.generation["attempt"]
    }
    pub(super) fn matches(&self, authority: &Authority) -> bool {
        authority.room_id == self.room_id
            && authority.room_epoch == self.room_epoch
            && authority.generation_fresh
            && authority.self_role == "host"
            && authority
                .members
                .get(&authority.self_id)
                .is_some_and(|(role, state)| role == "host" && state == "active")
            && authority
                .generation
                .as_ref()
                .is_some_and(|generation| same_generation(generation, &self.generation))
    }
    fn dispatch_current(&self, authority: &Authority) -> Result<(), RoomError> {
        if !self.matches(authority)
            || !authority.snapshot_seen
            || !authority.presence_seen
            || !authority.online.contains(&authority.self_id)
            || authority
                .generation
                .as_ref()
                .is_none_or(|generation| terminal(&generation["state"]))
            || authority.generation_read_terminal.is_some()
            || self.terminal_state.is_some()
        {
            return Err(stale());
        }
        Ok(())
    }
    fn check_candidate(&self, authority: &Authority) -> Result<(), RoomError> {
        if authority.room_id == self.room_id && authority.room_epoch == self.room_epoch {
            if let Some(generation) = authority
                .generation
                .as_ref()
                .filter(|generation| self.same_tuple(generation))
            {
                if !same_generation(generation, &self.generation)
                    || self
                        .terminal_state
                        .as_ref()
                        .is_some_and(|state| generation["state"] != *state)
                {
                    return Err(invalid());
                }
            }
        }
        Ok(())
    }
    pub(super) fn terminal_matches(&self, authority: &Authority) -> bool {
        self.matches(authority)
            && authority.generation.as_ref().is_some_and(|generation| {
                terminal(&generation["state"])
                    && self
                        .terminal_state
                        .as_ref()
                        .is_none_or(|state| generation["state"] == *state)
            })
    }
    pub(super) fn read_matches(&self, room: &str, epoch: &str, generation: &Value) -> bool {
        self.room_id == room
            && self.room_epoch == epoch
            && same_generation(&self.generation, generation)
    }
}

impl RoomInstance {
    pub(super) fn check_cancel_dispatch(
        &self,
        context: &ScopeContext,
        basis: &CancelBasis,
        intent: &str,
    ) -> Result<(), RoomError> {
        let inner = lock(&self.inner);
        self.current_locked(&inner, context)?;
        if inner
            .scope
            .as_ref()
            .and_then(|scope| scope.socket_cancel.as_ref())
            .is_none_or(|socket| socket.is_cancelled())
        {
            return Err(stale());
        }
        let pending = inner
            .pending
            .as_ref()
            .filter(|pending| pending.id == intent)
            .ok_or_else(stale)?;
        if pending.phase != IntentPhase::InFlight
            || pending.account.epoch != context.account.epoch
            || pending.account.user_id != context.account.user_id
            || pending.account.cookie != context.account.cookie
            || !pending.account.is_current()?
            || basis.starting.as_ref().is_some_and(|link| {
                link.document != context.proof.document
                    || link.cancel_intent_id != intent
                    || !Self::linked_start_cancel(&inner, intent)
            })
        {
            return Err(stale());
        }
        pending
            .cancel_basis
            .as_ref()
            .ok_or_else(stale)?
            .dispatch_current(
                inner
                    .scope
                    .as_ref()
                    .and_then(|scope| scope.session.as_ref())
                    .ok_or_else(stale)?,
            )?;
        basis.dispatch_current(
            inner
                .scope
                .as_ref()
                .and_then(|scope| scope.session.as_ref())
                .ok_or_else(stale)?,
        )
    }
    pub(super) fn check_cancel_candidate(
        inner: &Inner,
        candidate: &Authority,
    ) -> Result<(), RoomError> {
        if let (Some(fence), Some(scope)) = (&inner.start_fence, &inner.scope) {
            fence.check_cancel_candidate(scope.context.account.user_id, candidate)?;
        }
        if let Some(basis) = inner
            .pending
            .as_ref()
            .and_then(|pending| pending.cancel_basis.as_ref())
        {
            basis.check_candidate(candidate)?;
        }
        // 已观察到的终态是单调围栏，不能被晚到 POST/GET/WSS 降回运行中。
        if let Some(previous) = inner
            .scope
            .as_ref()
            .and_then(|scope| scope.session.as_ref())
        {
            if previous.room_id == candidate.room_id && previous.room_epoch == candidate.room_epoch
            {
                if let (Some(known), Some(generation)) =
                    (&previous.generation_read_terminal, &candidate.generation)
                {
                    if known["generationId"] == generation["generationId"]
                        && known["attempt"] == generation["attempt"]
                        && (!same_generation(known, generation)
                            || known["state"] != generation["state"])
                    {
                        return Err(invalid());
                    }
                }
            }
        }
        Ok(())
    }
    pub(super) fn cancel_receipt_candidate(
        inner: &Inner,
        basis: &CancelBasis,
        response: &Value,
    ) -> Result<Authority, RoomError> {
        let result = &response["result"];
        let previous = inner
            .scope
            .as_ref()
            .and_then(|scope| scope.session.as_ref())
            .ok_or_else(stale)?;
        if result["roomId"] != basis.room_id
            || result["roomEpoch"] != basis.room_epoch
            || !same_generation(&result["generation"], &basis.generation)
            || !basis.matches(previous)
        {
            return Err(invalid());
        }
        let mut candidate = previous.clone();
        candidate.generation = Some(result["generation"].clone());
        Self::check_cancel_candidate(inner, &candidate)?;
        if let Some(barrier) = generation_read::terminal_barrier(&result["generation"]) {
            candidate.generation_read_terminal = Some(barrier);
        }
        Ok(candidate)
    }
    pub(super) fn install_cancel_receipt(
        &self,
        context: &ScopeContext,
        basis: &CancelBasis,
        response: &Value,
    ) -> Result<(), RoomError> {
        let mut inner = lock(&self.inner);
        self.current_locked(&inner, context)?;
        let candidate = Self::cancel_receipt_candidate(&inner, basis, response)?;
        inner.scope.as_mut().ok_or_else(stale)?.session = Some(candidate);
        // Preserve a linked terminal observation before this lock can be retired,
        // even when the HTTP batch has not yet been queued or acknowledged.
        Self::observe_start_locked(&mut inner)?;
        Ok(())
    }
    pub(super) fn cancel_response_terminal(
        inner: &Inner,
        operation: Operation,
        response: &Value,
    ) -> bool {
        let Some(basis) = inner
            .pending
            .as_ref()
            .and_then(|pending| pending.cancel_basis.as_ref())
        else {
            return false;
        };
        let result = &response["result"];
        let generation = if operation == Operation::Session {
            &result["snapshot"]["activeGeneration"]
        } else {
            &result["generation"]
        };
        result["roomId"] == basis.room_id
            && result["roomEpoch"] == basis.room_epoch
            && same_generation(generation, &basis.generation)
            && terminal(&generation["state"])
            && basis
                .terminal_state
                .as_ref()
                .is_none_or(|state| generation["state"] == *state)
    }
    pub(super) fn cancel_terminal_current(inner: &Inner, context: &ScopeContext) -> bool {
        inner.pending.as_ref().is_some_and(|pending| {
            pending.account.user_id == context.account.user_id
                && pending.account.epoch == context.account.epoch
                && pending.account.cookie == context.account.cookie
                && (!pending.is_starting_cancel()
                    || (pending.tracking_document() == Some(context.proof.document)
                        && Self::linked_start_cancel(inner, &pending.id)))
                && pending.cancel_basis.as_ref().is_some_and(|basis| {
                    inner
                        .scope
                        .as_ref()
                        .and_then(|scope| scope.session.as_ref())
                        .is_some_and(|authority| basis.terminal_matches(authority))
                })
        })
    }
    pub(super) fn receipt_cancel_locked(
        inner: &mut Inner,
        context: &ScopeContext,
        receipt: IntentReceipt,
    ) {
        if !Self::cancel_terminal_current(inner, context) {
            return;
        }
        let state = inner
            .scope
            .as_ref()
            .unwrap()
            .session
            .as_ref()
            .unwrap()
            .generation
            .as_ref()
            .unwrap()["state"]
            .as_str()
            .unwrap()
            .to_owned();
        let pending = inner.pending.as_mut().unwrap();
        if pending.phase == IntentPhase::AwaitingAck {
            return;
        }
        pending.cancel_basis.as_mut().unwrap().terminal_state = Some(state);
        pending.phase = IntentPhase::AwaitingAck;
        pending.receipt = Some(receipt.clone());
        if let Some(fence) = inner
            .start_fence
            .as_mut()
            .filter(|fence| fence.cancel_id() == Some(pending.id.as_str()))
        {
            fence.set_receipt(receipt);
        }
    }
}
