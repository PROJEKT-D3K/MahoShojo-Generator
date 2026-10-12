//! Optional public settlement feedback. Invalid business data never invalidates the report.
use serde_json::{json, Map, Value};

type FieldCheck = (&'static str, fn(&Value) -> bool);

fn nullable_string(value: &Value) -> bool {
    value.is_null() || value.is_string()
}
fn nullable_number(value: &Value) -> bool {
    value.is_null() || value.is_number()
}
fn strings(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
}
fn fields(value: &Value, checks: &[FieldCheck]) -> Option<Map<String, Value>> {
    let source = value.as_object()?;
    let mut out = Map::new();
    for (key, valid) in checks {
        let value = source.get(*key)?;
        if !valid(value) {
            return None;
        }
        out.insert((*key).to_string(), value.clone());
    }
    Some(out)
}
fn queue(value: &Value) -> Option<Value> {
    let out = fields(
        value,
        &[
            ("eligible", Value::is_boolean),
            ("ineligibleReasons", strings),
            ("eventStatus", Value::is_string),
            ("skipReason", nullable_string),
            ("rating", nullable_number),
            ("games", nullable_number),
            ("tier", nullable_string),
            ("delta", nullable_number),
            ("rank", nullable_number),
            ("total", nullable_number),
            ("rankDelta", nullable_number),
        ],
    )?;
    if !matches!(
        out.get("eventStatus")?.as_str()?,
        "missing" | "pending" | "applied" | "skipped" | "failed"
    ) {
        return None;
    }
    Some(Value::Object(out))
}
fn participant(value: &Value) -> Option<Value> {
    let mut out = fields(
        value,
        &[
            ("displayName", Value::is_string),
            ("entityType", Value::is_string),
            ("entityId", nullable_string),
            ("entityKey", nullable_string),
            ("dataCardId", nullable_string),
            ("presetId", nullable_string),
            ("techScore", nullable_number),
            ("techLevel", nullable_string),
        ],
    )?;
    if !matches!(
        out.get("entityType")?.as_str()?,
        "data_card" | "preset" | "unknown"
    ) {
        return None;
    }
    let queues = value.get("queues")?.as_object()?;
    out.insert(
        "queues".to_string(),
        json!({
            "strict": queue(queues.get("strict")?)?, "free": queue(queues.get("free")?)?,
        }),
    );
    Some(Value::Object(out))
}

/// Mirror contracts/arena-generation-ranking's public JSON projection, then bind the
/// optional result to this Native flight. Never forward raw private/unknown fields.
pub(super) fn project(value: &Value, generation_id: Option<&str>) -> Option<Value> {
    let id = value.get("generationId")?.as_str()?;
    if Some(id) != generation_id || id.trim().is_empty() {
        return None;
    }
    let success = value.get("success")?.as_bool()?;
    if !success {
        return Some(
            json!({"success": false, "generationId": id, "error": value.get("error")?.as_str()?}),
        );
    }
    match value.get("state")?.as_str()? {
        "pending" => Some(
            json!({"success": true, "generationId": id, "state": "pending", "message": value.get("message")?.as_str()?}),
        ),
        "ready" => {
            let snapshot = fields(
                value.get("snapshot")?,
                &[
                    ("status", nullable_string),
                    ("combatantCount", nullable_number),
                ],
            )?;
            let participants = value
                .get("participants")?
                .as_array()?
                .iter()
                .map(participant)
                .collect::<Option<Vec<_>>>()?;
            Some(
                json!({"success": true, "generationId": id, "state": "ready", "snapshot": snapshot, "participants": participants}),
            )
        }
        _ => None,
    }
}
