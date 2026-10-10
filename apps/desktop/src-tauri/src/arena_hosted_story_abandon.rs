//! A synchronous, explicit local-only operation. No server stop, refund, receipt
//! mutation, or new execution permission is implied by any successful step.
use super::*;
use crate::arena_story::StoryError;
use story_pending::{
    AbandonCandidate, AbandonFlight, AbandonOutcome, AbandonRequest, AbandonSecret, AbandonState,
};

fn release_original(
    state: &ArenaState,
    secrets: &dyn SecretStore,
    snapshot: &story_pending::PendingSnapshot,
) -> Result<(AbandonFlight, AbandonSecret), ()> {
    let manifest = &snapshot.manifest;
    let product = match manifest.product {
        story_pending::Product::Battle => Product::Battle,
        story_pending::Product::Arena => Product::Arena,
    };
    // The flights mutex also serializes capture_response_token and normal slot
    // replacement. No connection is held while consulting OS credentials.
    let mut flights = state.flights.lock().map_err(|_| ())?;
    let flight_state = if let Some(flight) = flights.get(&product) {
        let mut f = flight.lock().map_err(|_| ())?;
        let bound = match (&f.story, &snapshot.create_claim) {
            (Some(binding), Some(claim)) => {
                binding.attempt_id == claim.attempt_id && binding.input_digest == claim.input_digest
            }
            // Native preflight has no create authority or credentials yet. It is
            // nevertheless this exact local input's cancellable reservation.
            (None, None) => !f.dispatched && f.anonymous.is_none() && f.cookie.is_none(),
            _ => false,
        };
        if f.request_id == manifest.request_id && story::actor(&f.actor) == manifest.actor && bound
        {
            f.revoked = true;
            if let Some(subscription) = f.subscription.take() {
                subscription.cancel();
            }
            f.cookie = None;
            f.anonymous = None;
            f.secrets_to_redact.clear();
            drop(f);
            flights.remove(&product);
            AbandonFlight::Released
        } else {
            AbandonFlight::ForeignRetained
        }
    } else {
        AbandonFlight::Released
    };
    if manifest.actor != story_pending::Actor::Anonymous {
        return Ok((flight_state, AbandonSecret::NotApplicable));
    }
    let record = match load_anonymous(product, secrets) {
        Ok(None) => return Ok((flight_state, AbandonSecret::Absent)),
        Ok(Some(record)) => record,
        Err(_) => return Ok((flight_state, AbandonSecret::Unresolved)),
    };
    let exact = snapshot.create_claim.as_ref().is_some_and(|claim| {
        record.product == product
            && record.request_id == manifest.request_id
            && record.story_binding.as_ref().is_some_and(|binding| {
                binding.attempt_id == claim.attempt_id && binding.input_digest == claim.input_digest
            })
    });
    if !exact {
        return Ok((flight_state, AbandonSecret::ForeignRetained));
    }
    // Never trust only the delete acknowledgment. A failed delete may have taken
    // effect; only a coherent read-back determines whether this step completed.
    let _ = secrets.delete(product.slot());
    let secret_state = match load_anonymous(product, secrets) {
        Ok(None) => AbandonSecret::Cleared,
        Ok(Some(current))
            if current.request_id != record.request_id
                || current.story_binding != record.story_binding
                || current.bootstrap != record.bootstrap =>
        {
            AbandonSecret::ForeignRetained
        }
        Ok(Some(_)) | Err(_) => AbandonSecret::Unresolved,
    };
    Ok((flight_state, secret_state))
}

pub(crate) fn abandon_story_pending(
    state: &ArenaState,
    stories: &StoryStore,
    secrets: &dyn SecretStore,
    request: AbandonRequest,
) -> Result<AbandonOutcome, StoryError> {
    if !std::ptr::eq(stories, state.stories.as_ref()) {
        return Err(StoryError::Stale);
    }
    let guard = stories.pending_admission(request.key.product)?;
    let snapshot = stories.pending_begin_abandon(&guard, &request)?;
    let mut outcome = AbandonOutcome {
        key: request.key.clone(),
        input_digest: request.input_digest.clone(),
        actor: request.actor.clone(),
        state: AbandonState::CleanupPending,
        flight: AbandonFlight::Unresolved,
        secret: AbandonSecret::Unresolved,
        candidate: AbandonCandidate::Retained,
    };
    let Ok((flight, secret)) = release_original(state, secrets, &snapshot) else {
        return Ok(outcome);
    };
    outcome.flight = flight;
    outcome.secret = secret;
    if secret == AbandonSecret::Unresolved {
        return Ok(outcome);
    }
    match stories.pending_finish_abandon(&guard, &request) {
        Ok(()) => {
            outcome.state = AbandonState::Abandoned;
            outcome.candidate = AbandonCandidate::Removed;
        }
        Err(_) => {
            outcome.candidate = match stories.pending_describe_admitted(&guard) {
                Ok(Some(current))
                    if current.manifest.key() == request.key
                        && current.manifest.input_digest == request.input_digest
                        && current.manifest.actor == request.actor =>
                {
                    AbandonCandidate::Retained
                }
                // The storage helper alone owns every deleted token and memory
                // cleanup proof. Active absence here cannot substitute for it.
                _ => AbandonCandidate::Unknown,
            };
        }
    }
    Ok(outcome)
}
