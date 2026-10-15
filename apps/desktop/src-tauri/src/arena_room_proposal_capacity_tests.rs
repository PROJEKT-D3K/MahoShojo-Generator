use super::*;

fn size(value: &Value) -> usize {
    serde_json::to_vec(value).unwrap().len()
}

fn maximum_key() -> String {
    "\0".repeat(256)
}

fn maximum_change_ids() -> Vec<String> {
    let alphabet = [
        0u8, 1, 2, 3, 4, 5, 6, 7, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
        30, 31,
    ];
    (0..32)
        .map(|index| {
            let mut id = "\0".repeat(254);
            id.push(char::from(alphabet[index / alphabet.len()]));
            id.push(char::from(alphabet[index % alphabet.len()]));
            assert_eq!(size(&json!(id)), 1538);
            id
        })
        .collect()
}

fn large_changes(ids: &[String]) -> Value {
    json!(ids
        .iter()
        .enumerate()
        .map(|(index, id)| json!({
            "changeId": id, "type": "addTeam", "teamKey": format!("team-{index}"),
            "displayName": "a", "expectedBase": {"kind": "absent"}
        }))
        .collect::<Vec<_>>())
}

fn fill_changes(mut value: Value, maximum: usize) -> Value {
    let count = value["changes"].as_array().unwrap().len();
    for index in 0..count {
        let remaining = maximum.checked_sub(size(&value)).unwrap();
        if remaining == 0 {
            break;
        }
        let mut display = value["changes"][index]["displayName"]
            .as_str()
            .unwrap()
            .to_owned();
        display.push_str(&"\0".repeat(199.min(remaining / 6)));
        value["changes"][index]["displayName"] = json!(display);
        let remaining = maximum - size(&value);
        if (1..6).contains(&remaining) && display.len() + remaining <= 200 {
            display.push_str(&"x".repeat(remaining));
            value["changes"][index]["displayName"] = json!(display);
        }
    }
    assert_eq!(size(&value), maximum);
    value
}

fn submit(ids: &[String]) -> Value {
    json!({"proposalId": maximum_key(), "expectedRoomEpoch": maximum_key(),
        "baseRevision": protocol::MAX_SAFE_INTEGER, "changes": large_changes(ids)})
}

fn submitted(request: &Value, timestamp: &str) -> Value {
    json!({"proposalVersion": 1, "proposalId": request["proposalId"],
        "roomId": maximum_key(), "authorUserId": maximum_key(),
        "baseRevision": request["baseRevision"], "status": "submitted",
        "changes": request["changes"], "createdAt": timestamp})
}

fn service_request(operation: Operation, request: &Value) -> Result<Value, RoomError> {
    protocol::validate_service_request(
        operation,
        &json!({
            "desktopRoom": {"version": protocol::PROTOCOL_VERSION, "expectedUserId": protocol::MAX_SAFE_INTEGER},
            "request": request
        }),
        protocol::MAX_SAFE_INTEGER,
    )
}

fn session_envelope() -> Value {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../packages/contracts/fixtures/desktop-room-session.json"
    ))
    .unwrap();
    fixture["operations"]["session"]["success"].clone()
}

fn validate_maximum_proposal(proposal: &Value) -> Result<Value, RoomError> {
    let mut envelope = session_envelope();
    envelope["result"]["roomId"] = proposal["roomId"].clone();
    envelope["result"]["roomEpoch"] = json!(maximum_key());
    envelope["result"]["self"]["userId"] = proposal["authorUserId"].clone();
    let member = envelope["result"]["self"].clone();
    envelope["result"]["snapshot"]["roomId"] = proposal["roomId"].clone();
    envelope["result"]["snapshot"]["roomEpoch"] = json!(maximum_key());
    envelope["result"]["snapshot"]["members"] = json!([member]);
    envelope["result"]["snapshot"]["proposals"] = json!([proposal]);
    protocol::validate_http_response(
        Operation::Session,
        200,
        &serde_json::to_vec(&envelope).unwrap(),
        42,
    )
}

#[test]
fn maximum_submit_retains_full_request_and_derived_identity() {
    assert_eq!(proposal::MAX_FROZEN_PROPOSAL_BYTES, 192 * 1024);
    let request = fill_changes(
        submit(&maximum_change_ids()),
        protocol::MAX_ORIGINAL_REQUEST_BYTES,
    );
    assert_eq!(
        service_request(Operation::ProposalSubmit, &request).unwrap()["request"],
        request
    );
    let basis = ProposalBasis::new(
        "proposalSubmit",
        &maximum_key(),
        &maximum_key(),
        &maximum_key(),
        &maximum_key(),
        &request,
        None,
    )
    .unwrap();
    assert_eq!(size(basis.identity().unwrap()), 67_099);
    assert_eq!(basis.frozen_bytes(), 138_941);
    assert_eq!(basis.request(), &request);
    assert_eq!(basis.identity().unwrap()["changes"], request["changes"]);
    // A legal request can later exceed the server proposal ceiling once server
    // metadata is added. It must still fit the frozen client target.
    let server_proposal = submitted(&request, "2026-10-15T20:31:45.000Z");
    assert_eq!(size(&server_proposal), 67_159);
    assert!(validate_maximum_proposal(&server_proposal).is_err());
    let mut over = request;
    over["changes"][31]["displayName"] = json!("ax");
    assert_eq!(size(&over), protocol::MAX_ORIGINAL_REQUEST_BYTES + 1);
    assert!(service_request(Operation::ProposalSubmit, &over).is_err());
}

#[test]
fn full_server_proposal_with_longest_scope_fits_submit_basis() {
    let server_proposal = fill_changes(
        submitted(&submit(&maximum_change_ids()), "2026-10-15T20:31:45.000Z"),
        protocol::MAX_WEBSOCKET_BYTES,
    );
    validate_maximum_proposal(&server_proposal).unwrap();
    let request = json!({"proposalId": maximum_key(), "expectedRoomEpoch": maximum_key(),
        "baseRevision": protocol::MAX_SAFE_INTEGER, "changes": server_proposal["changes"]});
    assert_eq!(size(&request), 63_913);
    service_request(Operation::ProposalSubmit, &request).unwrap();
    let basis = ProposalBasis::new(
        "proposalSubmit",
        &maximum_key(),
        &maximum_key(),
        &maximum_key(),
        &maximum_key(),
        &request,
        None,
    )
    .unwrap();
    assert_eq!(basis.frozen_bytes(), 135_695);
    assert!(basis.matches_proposal(&server_proposal));
    let mut over = server_proposal;
    over["changes"][31]["displayName"] = json!("ax");
    assert_eq!(size(&over), protocol::MAX_WEBSOCKET_BYTES + 1);
    assert!(validate_maximum_proposal(&over).is_err());
}

#[test]
fn maximum_resolve_request_counts_selection_and_override_copies() {
    let mut ids = maximum_change_ids();
    assert_eq!(size(&json!(ids)), 49_249);
    let full_selection_request = json!({"expectedRoomEpoch": maximum_key(), "expectedRevision": protocol::MAX_SAFE_INTEGER,
        "resolution": "accept-selected", "selectedChangeIds": ids, "overrideChangeIds": &ids[..9]});
    service_request(Operation::ProposalResolve, &full_selection_request).unwrap();
    let full_selection_proposal = fill_changes(
        submitted(&submit(&ids), "2026-10-15T20:31Z"),
        protocol::MAX_WEBSOCKET_BYTES,
    );
    validate_maximum_proposal(&full_selection_proposal).unwrap();
    let full_selection_basis = ProposalBasis::new(
        "proposalResolve",
        &maximum_key(),
        &maximum_key(),
        &maximum_key(),
        &maximum_key(),
        &full_selection_request,
        Some(&full_selection_proposal),
    )
    .unwrap();
    assert_eq!(full_selection_basis.frozen_bytes(), 185_817);
    // Ten full-length overrides would exceed the request ceiling by 773 bytes.
    // Shorten one selected+overridden ID by 386 bytes and the revision by one.
    ids[0] = format!("xxxx{}", &ids[0][65..]);
    let request = json!({"expectedRoomEpoch": maximum_key(), "expectedRevision": 100_000_000_000_000u64,
        "resolution": "accept-selected", "selectedChangeIds": ids, "overrideChangeIds": &ids[..10]});
    assert_eq!(size(&request), protocol::MAX_ORIGINAL_REQUEST_BYTES);
    assert_eq!(size(&request["selectedChangeIds"]), 48_863);
    service_request(Operation::ProposalResolve, &request).unwrap();
    let server_proposal = fill_changes(
        submitted(&submit(&ids), "2026-10-15T20:31Z"),
        protocol::MAX_WEBSOCKET_BYTES,
    );
    validate_maximum_proposal(&server_proposal).unwrap();
    let basis = ProposalBasis::new(
        "proposalResolve",
        &maximum_key(),
        &maximum_key(),
        &maximum_key(),
        &maximum_key(),
        &request,
        Some(&server_proposal),
    )
    .unwrap();
    assert_eq!(size(basis.identity().unwrap()), 65_483);
    assert_eq!(basis.frozen_bytes(), 186_197);
    assert!(basis.frozen_bytes() < proposal::MAX_FROZEN_PROPOSAL_BYTES);
    assert_eq!(basis.request(), &request);
    assert!(basis.matches_proposal(&server_proposal));
    let mut over = request;
    over["expectedRevision"] = json!(protocol::MAX_SAFE_INTEGER);
    assert_eq!(size(&over), protocol::MAX_ORIGINAL_REQUEST_BYTES + 1);
    assert!(service_request(Operation::ProposalResolve, &over).is_err());
}

fn indexed_proposal(id: &str, room_id: &str, author: &str, maximum: Option<usize>) -> Value {
    let mut proposal = json!({"proposalVersion": 1, "proposalId": id, "roomId": room_id,
        "authorUserId": author, "baseRevision": 7, "status": "submitted",
        "changes": [{"changeId": "change", "type": "setUserGuidance", "value": "next",
            "expectedBase": {"kind": "value", "value": "before"}}],
        "createdAt": "2026-10-15T20:31:45.0Z"});
    if let Some(maximum) = maximum {
        let padding = maximum.checked_sub(size(&proposal)).unwrap();
        proposal["createdAt"] = json!(format!("2026-10-15T20:31:45.{}Z", "0".repeat(padding + 1)));
        assert_eq!(size(&proposal), maximum);
    }
    proposal
}

#[test]
fn authority_accepts_multiple_proposals_over_single_proposal_budget_without_truncation() {
    let mut envelope = session_envelope();
    let room = envelope["result"]["roomId"].as_str().unwrap();
    let author = envelope["result"]["self"]["userId"].as_str().unwrap();
    let proposals: Vec<_> = (0..3)
        .map(|index| indexed_proposal(&format!("large-{index}"), room, author, Some(40_000)))
        .collect();
    envelope["result"]["snapshot"]["proposals"] = json!(proposals);
    let validated = protocol::validate_http_response(
        Operation::Session,
        200,
        &serde_json::to_vec(&envelope).unwrap(),
        42,
    )
    .unwrap();
    let authority = Authority::from_session(&validated["result"]).unwrap();
    assert!(size(&json!(proposals)) > protocol::MAX_WEBSOCKET_BYTES);
    assert_eq!(authority.proposals.len(), 3);
    assert_eq!(
        authority.proposals.values().cloned().collect::<Vec<_>>(),
        proposals
    );
}

#[test]
fn proposal_index_retains_all_256_and_rejects_257_without_evicting() {
    let mut envelope = session_envelope();
    let room = envelope["result"]["roomId"].as_str().unwrap().to_owned();
    let mut members = Vec::new();
    let mut proposals = Vec::new();
    for member_index in 0..32 {
        let member_id = format!("member-{member_index}");
        members.push(
            json!({"userId": member_id, "role": if member_index == 0 {"host"} else {"member"},
            "displayName": "member", "membershipState": "active"}),
        );
        for slot in 0..8 {
            proposals.push(indexed_proposal(
                &format!("proposal-{member_index:02}-{slot}"),
                &room,
                &member_id,
                None,
            ));
        }
    }
    envelope["result"]["self"] = members[0].clone();
    envelope["result"]["snapshot"]["members"] = json!(members);
    envelope["result"]["snapshot"]["proposals"] = json!(proposals);
    let validated = protocol::validate_http_response(
        Operation::Session,
        200,
        &serde_json::to_vec(&envelope).unwrap(),
        42,
    )
    .unwrap();
    let mut authority = Authority::from_session(&validated["result"]).unwrap();
    assert_eq!(authority.proposals.len(), 256);
    assert_eq!(
        authority.proposals.values().cloned().collect::<Vec<_>>(),
        proposals
    );
    let previous = authority.proposals.clone();
    let seq = authority.control_seq;
    let extra = indexed_proposal("proposal-overflow", &room, "member-0", None);
    assert!(authority
        .apply(&json!({"type": "proposal.submitted", "roomId": room,
        "roomEpoch": authority.room_epoch, "controlSeq": seq + 1, "payload": {"proposal": extra}}))
        .is_err());
    assert_eq!(authority.proposals, previous);
    assert_eq!(authority.control_seq, seq);
    proposals.push(extra);
    assert!(checked_proposal_index(&proposals, &BTreeMap::new()).is_err());
}

#[test]
fn proposal_index_exact_byte_budget_rejects_one_more_byte() {
    // Isolate the index budget. A real HTTP response still has its independent
    // complete-envelope ceiling and cannot contain this exact-size array.
    let mut proposals: Vec<_> = (0..4)
        .map(|index| {
            indexed_proposal(
                &format!("proposal-{index}"),
                "room",
                "author",
                Some(if index == 3 { 65_531 } else { 65_536 }),
            )
        })
        .collect();
    for proposal in &proposals {
        validate_maximum_proposal(proposal).unwrap();
    }
    assert_eq!(size(&json!(proposals)), protocol::MAX_RESPONSE_BYTES);
    let index = checked_proposal_index(&proposals, &BTreeMap::new()).unwrap();
    assert_eq!(index.len(), 4);
    assert_eq!(index.values().cloned().collect::<Vec<_>>(), proposals);
    // Changing only time keeps full proposal identity unchanged and each
    // proposal below 64 KiB, while the index grows by exactly one byte.
    let time = proposals[3]["createdAt"]
        .as_str()
        .unwrap()
        .replace('Z', "0Z");
    proposals[3]["createdAt"] = json!(time);
    assert_eq!(size(&json!(proposals)), protocol::MAX_RESPONSE_BYTES + 1);
    assert!(checked_proposal_index(&proposals, &index).is_err());
    assert_eq!(index.len(), 4);
}
