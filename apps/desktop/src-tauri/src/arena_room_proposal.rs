//! Native-only mirror of multiplayer-core proposal reconciliation. Every input must
//! already have passed the Room protocol parser and current authority checks.
//! Observations describe business state; they never prove delivery of a POST.

use std::collections::BTreeSet;
use std::io::{self, Write};

use serde::Serialize;
use serde_json::{json, Value};

use crate::arena_room_protocol::RoomError;

pub(super) const MAX_FROZEN_PROPOSAL_BYTES: usize = 192 * 1024;
const IDENTITY_FIELDS: [&str; 6] = [
    "proposalVersion",
    "proposalId",
    "roomId",
    "authorUserId",
    "baseRevision",
    "changes",
];

pub(super) fn identity_of(proposal: &Value) -> Value {
    Value::Object(
        IDENTITY_FIELDS
            .into_iter()
            .map(|field| (field.to_owned(), proposal[field].clone()))
            .collect(),
    )
}

// Object key order is irrelevant; array order is identity. The protocol parser
// bounds JSON integers to JavaScript's safe range and normalizes numeric fields.
fn json_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len() && left.iter().zip(right).all(|(a, b)| json_equal(a, b))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, value)| {
                    right.get(key).is_some_and(|other| json_equal(value, other))
                })
        }
        _ => left == right,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FrozenTarget {
    room_id: String,
    room_epoch: String,
    self_user_id: String,
    operation: &'static str,
    request: Value,
    proposal_id: String,
    identity: Option<Value>,
    resolution: Option<String>,
    selected_change_ids: Option<Vec<String>>,
    linked: bool,
}

/// One frozen target per pending intent. No renderer-controlled linkage input,
/// serialization API, durable ledger, or reconstructed target from later evidence.
pub(super) struct ProposalBasis {
    target: FrozenTarget,
    linked: bool,
    #[cfg(test)]
    frozen_bytes: usize,
}

struct BoundedSize(usize);
impl Write for BoundedSize {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self.0.saturating_add(bytes.len());
        if self.0 > MAX_FROZEN_PROPOSAL_BYTES {
            return Err(io::Error::other("proposal target exceeds budget"));
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl ProposalBasis {
    pub(super) fn new(
        operation: &str,
        room_id: &str,
        room_epoch: &str,
        self_user_id: &str,
        proposal_id: &str,
        request: &Value,
        pending: Option<&Value>,
    ) -> Result<Self, RoomError> {
        let invalid = || RoomError::new("invalid-request", "not-applied");
        let operation = match operation {
            "proposalSubmit" => "submit",
            "proposalWithdraw" => "withdraw",
            "proposalResolve" => "resolve",
            _ => return Err(invalid()),
        };
        if request["expectedRoomEpoch"].as_str() != Some(room_epoch)
            || (operation == "submit" && request["proposalId"].as_str() != Some(proposal_id))
        {
            return Err(invalid());
        }
        let identity = if operation == "submit" {
            Some(json!({
                "proposalVersion": 1,
                "proposalId": proposal_id,
                "roomId": room_id,
                "authorUserId": self_user_id,
                "baseRevision": request["baseRevision"],
                "changes": request["changes"],
            }))
        } else {
            pending
                .filter(|proposal| {
                    proposal["status"] == "submitted"
                        && proposal["roomId"] == room_id
                        && proposal["proposalId"] == proposal_id
                })
                .map(identity_of)
        };
        let linked = operation != "submit" && identity.is_some();
        let resolution = if operation == "resolve" {
            Some(
                request["resolution"]
                    .as_str()
                    .ok_or_else(invalid)?
                    .to_owned(),
            )
        } else {
            None
        };
        let selected_change_ids = if operation == "resolve" {
            request
                .get("selectedChangeIds")
                .map(|ids| {
                    ids.as_array()
                        .ok_or_else(invalid)?
                        .iter()
                        .map(|id| id.as_str().map(str::to_owned).ok_or_else(invalid))
                        .collect::<Result<Vec<_>, _>>()
                })
                .transpose()?
        } else {
            None
        };
        let target = FrozenTarget {
            room_id: room_id.to_owned(),
            room_epoch: room_epoch.to_owned(),
            self_user_id: self_user_id.to_owned(),
            operation,
            request: request.clone(),
            proposal_id: proposal_id.to_owned(),
            identity,
            resolution,
            selected_change_ids,
            linked,
        };
        let mut size = BoundedSize(0);
        // Count without allocating another serialized copy of the frozen payload.
        serde_json::to_writer(&mut size, &target).map_err(|_| invalid())?;
        Ok(Self {
            target,
            linked,
            #[cfg(test)]
            frozen_bytes: size.0,
        })
    }

    /// Failed current-scope authority must not leave an old ID-only association usable.
    /// Only subsequent exact full identity evidence can restore this linkage.
    pub(super) fn invalidate_linkage(&mut self) {
        self.linked = false;
    }

    pub(super) fn matches_scope(
        &self,
        room_id: &str,
        room_epoch: &str,
        self_user_id: &str,
    ) -> bool {
        self.target.room_id == room_id
            && self.target.room_epoch == room_epoch
            && self.target.self_user_id == self_user_id
    }

    pub(super) fn identity(&self) -> Option<&Value> {
        self.target.identity.as_ref()
    }
    pub(super) fn matches_proposal(&self, proposal: &Value) -> bool {
        self.identity().is_some_and(|identity| {
            IDENTITY_FIELDS
                .iter()
                .all(|field| json_equal(&proposal[*field], &identity[*field]))
        })
    }
    pub(super) fn proposal_id(&self) -> &str {
        &self.target.proposal_id
    }
    #[cfg(test)]
    pub(super) fn request(&self) -> &Value {
        &self.target.request
    }
    #[cfg(test)]
    pub(super) fn frozen_bytes(&self) -> usize {
        self.frozen_bytes
    }

    pub(super) fn observe_snapshot(
        &mut self,
        room_id: &str,
        room_epoch: &str,
        self_user_id: &str,
        snapshot: &Value,
    ) -> Value {
        self.observe(
            room_id,
            room_epoch,
            self_user_id,
            snapshot["proposals"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            None,
        )
    }

    pub(super) fn observe_event(
        &mut self,
        room_id: &str,
        room_epoch: &str,
        self_user_id: &str,
        event: &Value,
    ) -> Value {
        self.observe(room_id, room_epoch, self_user_id, &[], Some(event))
    }

    fn result(
        &self,
        observation: &str,
        settle: bool,
        outcome: Option<&str>,
        status: Option<&str>,
    ) -> Value {
        json!({
            "observation": observation,
            "linked": self.linked,
            "settle": settle,
            "outcome": outcome,
            "terminalStatus": status,
        })
    }

    fn terminal_outcome(&self, status: &str) -> &'static str {
        match self.target.operation {
            "submit" => return "satisfied",
            "withdraw" => {
                return if status == "withdrawn" {
                    "satisfied"
                } else {
                    "different"
                }
            }
            _ => {}
        }
        if self.target.resolution.as_deref() == Some("reject") {
            return if status == "rejected" {
                "satisfied"
            } else {
                "different"
            };
        }
        if status == "partially_accepted" {
            return "scope-unverified";
        }
        if status != "accepted" {
            return "different";
        }
        let Some(selected) = &self.target.selected_change_ids else {
            return "satisfied";
        };
        let all = self
            .target
            .identity
            .as_ref()
            .and_then(|identity| identity["changes"].as_array());
        let selected: BTreeSet<&str> = selected.iter().map(String::as_str).collect();
        if all.is_some_and(|all| {
            selected.len() == all.len()
                && all.iter().all(|change| {
                    change["changeId"]
                        .as_str()
                        .is_some_and(|id| selected.contains(id))
                })
        }) {
            "satisfied"
        } else {
            "different"
        }
    }

    fn observe(
        &mut self,
        room_id: &str,
        room_epoch: &str,
        self_user_id: &str,
        proposals: &[Value],
        event: Option<&Value>,
    ) -> Value {
        if room_id != self.target.room_id
            || room_epoch != self.target.room_epoch
            || self_user_id != self.target.self_user_id
            || event.is_some_and(|event| {
                event["roomId"] != self.target.room_id
                    || event["roomEpoch"] != self.target.room_epoch
            })
        {
            self.linked = false;
            return self.result("scope-changed", false, None, None);
        }
        if self.target.identity.is_none() {
            return self.result("target-unavailable", false, None, None);
        }
        // Borrow evidence instead of copying authoritative proposal payloads.
        let mut proposals: Vec<&Value> = proposals.iter().collect();
        if let Some(event) = event {
            match event["type"].as_str() {
                Some("room.snapshot") => {
                    if let Some(snapshot) = event["payload"]["proposals"].as_array() {
                        proposals.extend(snapshot.iter());
                    }
                }
                Some("proposal.submitted" | "proposal.updated") => {
                    proposals.push(&event["payload"]["proposal"])
                }
                _ => {}
            }
        }
        let matching: Vec<&Value> = proposals
            .into_iter()
            .filter(|proposal| proposal["proposalId"] == self.target.proposal_id)
            .collect();
        // Full conflicting content wins over ID-only terminals and invalidates linkage.
        if matching
            .iter()
            .any(|proposal| !self.matches_proposal(proposal))
        {
            self.linked = false;
            return self.result("conflict", false, None, None);
        }
        if matching
            .iter()
            .any(|proposal| proposal["status"] != "draft")
        {
            self.linked = true;
        }
        let terminal = matching
            .iter()
            .find(|proposal| proposal["status"] != "submitted" && proposal["status"] != "draft")
            .and_then(|proposal| proposal["status"].as_str())
            .or_else(|| {
                event
                    .filter(|event| {
                        event["type"] == "proposal.resolved"
                            && event["payload"]["proposalId"] == self.target.proposal_id
                    })
                    .and_then(|event| event["payload"]["status"].as_str())
            });
        if self.linked {
            if let Some(status) = terminal {
                return self.result(
                    "terminal",
                    true,
                    Some(self.terminal_outcome(status)),
                    Some(status),
                );
            }
        }
        if matching
            .iter()
            .any(|proposal| proposal["status"] == "submitted")
        {
            return if self.target.operation == "submit" {
                self.result("submitted", true, Some("satisfied"), None)
            } else {
                self.result("pending", false, None, None)
            };
        }
        self.result("absent", false, None, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../packages/contracts/fixtures/arena-room-proposal-reconciliation.json"
        ))
        .unwrap()
    }

    fn basis(input: &Value) -> ProposalBasis {
        let operation = match input["operation"].as_str().unwrap() {
            "submit" => "proposalSubmit",
            "withdraw" => "proposalWithdraw",
            "resolve" => "proposalResolve",
            _ => panic!("unsupported fixture operation"),
        };
        let proposal_id = if operation == "proposalSubmit" {
            &input["request"]["proposalId"]
        } else {
            &input["proposalId"]
        };
        ProposalBasis::new(
            operation,
            input["roomId"].as_str().unwrap(),
            input["request"]["expectedRoomEpoch"].as_str().unwrap(),
            input["selfUserId"].as_str().unwrap(),
            proposal_id.as_str().unwrap(),
            &input["request"],
            input.get("pendingProposal"),
        )
        .unwrap()
    }

    #[test]
    fn shares_all_typescript_business_observation_golden_cases() {
        let fixture = fixture();
        for case in fixture["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let mut basis = basis(&fixture["targets"][case["target"].as_str().unwrap()]);
            for (index, step) in case["steps"].as_array().unwrap().iter().enumerate() {
                let evidence = &step["evidence"];
                let before = evidence.clone();
                let actual = basis.observe(
                    evidence["roomId"].as_str().unwrap(),
                    evidence["roomEpoch"].as_str().unwrap(),
                    evidence["selfUserId"].as_str().unwrap(),
                    evidence["proposals"]
                        .as_array()
                        .map(Vec::as_slice)
                        .unwrap_or(&[]),
                    evidence.get("event"),
                );
                assert_eq!(actual, step["expected"], "{name}, step {index}");
                assert_eq!(evidence, &before, "evidence mutated: {name}");
            }
        }
    }

    #[test]
    fn snapshot_and_event_entry_points_share_the_same_observer() {
        let fixture = fixture();
        for case in fixture["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            // Mixed evidence is exercised above. Every production entry point is
            // additionally checked on complete single-source sequences.
            let steps = case["steps"].as_array().unwrap();
            if steps.iter().any(|step| {
                step["evidence"].get("proposals").is_some()
                    && step["evidence"].get("event").is_some()
            }) {
                continue;
            }
            let mut basis = basis(&fixture["targets"][case["target"].as_str().unwrap()]);
            for step in steps {
                let evidence = &step["evidence"];
                let (room, epoch, viewer) = (
                    evidence["roomId"].as_str().unwrap(),
                    evidence["roomEpoch"].as_str().unwrap(),
                    evidence["selfUserId"].as_str().unwrap(),
                );
                let actual = if let Some(event) = evidence.get("event") {
                    basis.observe_event(room, epoch, viewer, event)
                } else {
                    basis.observe_snapshot(room, epoch, viewer, evidence)
                };
                assert_eq!(actual, step["expected"], "{name}");
            }
        }
    }

    #[test]
    fn freezes_complete_request_identity_selection_and_revision_independently() {
        let fixture = fixture();
        let mut input = fixture["targets"]["accept-subset"].clone();
        let basis = basis(&input);
        let original_request = input["request"].clone();
        let original_identity = identity_of(&input["pendingProposal"]);
        input["pendingProposal"]["changes"]
            .as_array_mut()
            .unwrap()
            .reverse();
        input["request"]["selectedChangeIds"] = json!(["guidance-1", "guidance-2"]);
        input["request"]["overrideChangeIds"] = json!(["guidance-2"]);
        input["request"]["expectedRevision"] = json!(99);
        assert_eq!(basis.request(), &original_request);
        assert_eq!(basis.identity(), Some(&original_identity));
        assert_eq!(basis.proposal_id(), "proposal-1");
        assert!(!basis.matches_proposal(&input["pendingProposal"]));
        assert_eq!(basis.terminal_outcome("accepted"), "different");
        assert_eq!(
            basis.terminal_outcome("partially_accepted"),
            "scope-unverified"
        );
        assert_eq!(
            basis.frozen_bytes(),
            serde_json::to_vec(&basis.target).unwrap().len()
        );
    }

    #[test]
    fn submit_freezes_request_before_caller_mutates_order_or_scope() {
        let fixture = fixture();
        let mut input = fixture["targets"]["submit"].clone();
        let basis = basis(&input);
        let original = input["request"].clone();
        input["request"]["changes"]
            .as_array_mut()
            .unwrap()
            .reverse();
        input["request"]["baseRevision"] = json!(99);
        input["request"]["expectedRoomEpoch"] = json!("other");
        assert_eq!(basis.request(), &original);
        assert_eq!(basis.identity().unwrap()["changes"], original["changes"]);
        assert_eq!(basis.identity().unwrap()["authorUserId"], "member-1");
        assert!(!basis.linked);
    }

    #[test]
    fn rejects_inconsistent_creation_coordinates_before_target_can_be_used() {
        let fixture = fixture();
        let request = &fixture["targets"]["submit"]["request"];
        for (operation, epoch, proposal_id) in [
            ("proposalSubmit", "other", "proposal-1"),
            ("proposalSubmit", "epoch-1", "other"),
            ("join", "epoch-1", "proposal-1"),
        ] {
            assert!(ProposalBasis::new(
                operation,
                "room-1",
                epoch,
                "member-1",
                proposal_id,
                request,
                None
            )
            .is_err());
        }
    }

    #[test]
    fn full_frozen_target_has_an_explicit_serialized_budget() {
        let fixture = fixture();
        let mut input = fixture["targets"]["submit"].clone();
        input["request"]["changes"][0]["value"] = json!("x".repeat(MAX_FROZEN_PROPOSAL_BYTES));
        let error = ProposalBasis::new(
            "proposalSubmit",
            "room-1",
            "epoch-1",
            "member-1",
            "proposal-1",
            &input["request"],
            None,
        )
        .err()
        .unwrap();
        assert_eq!(error.code, "invalid-request");
        assert_eq!(error.outcome, "not-applied");

        let mut exact = BoundedSize(0);
        assert_eq!(
            exact.write(&vec![0; MAX_FROZEN_PROPOSAL_BYTES]).unwrap(),
            MAX_FROZEN_PROPOSAL_BYTES
        );
        assert!(exact.write(&[0]).is_err());
    }

    #[test]
    fn invalidated_linkage_cannot_settle_on_absence_or_id_only_terminal() {
        let fixture = fixture();
        let mut basis = basis(&fixture["targets"]["withdraw"]);
        let event = json!({"type":"proposal.resolved","roomId":"room-1","roomEpoch":"epoch-1",
            "payload":{"proposalId":"proposal-1","status":"withdrawn"}});
        basis.invalidate_linkage();
        assert_eq!(
            basis.observe_snapshot("room-1", "epoch-1", "member-1", &json!({"proposals":[]}))
                ["settle"],
            false
        );
        assert_eq!(
            basis.observe_event("room-1", "epoch-1", "member-1", &event)["settle"],
            false
        );
        let exact = json!({"proposals":[fixture["targets"]["withdraw"]["pendingProposal"]]});
        assert_eq!(
            basis.observe_snapshot("room-1", "epoch-1", "member-1", &exact)["linked"],
            true
        );
        assert_eq!(
            basis.observe_event("room-1", "epoch-1", "member-1", &event)["settle"],
            true
        );
    }

    #[test]
    fn numeric_json_representation_is_not_proposal_identity() {
        let fixture = fixture();
        let mut proposal = fixture["targets"]["withdraw"]["pendingProposal"].clone();
        let basis = basis(&fixture["targets"]["submit"]);
        proposal["baseRevision"] = serde_json::from_str("7.0").unwrap();
        assert!(basis.matches_proposal(&proposal));
    }
}
