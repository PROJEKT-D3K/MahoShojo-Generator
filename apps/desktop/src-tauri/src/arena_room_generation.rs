//! Closed current-generation DTO validation over borrowed JSON. The complete wire
//! buffer stays with the caller; only the small authority mirror is materialized.
use crate::arena_room_protocol::{
    validate_generation_mirror, RoomError, MAX_JSON_DEPTH, MAX_SAFE_INTEGER, PROTOCOL_VERSION,
};
use serde::de::{DeserializeSeed, Error as _, MapAccess, SeqAccess, Visitor};
use serde::Deserializer as _;
use serde_json::{value::RawValue, Value};
use std::collections::BTreeMap;
use std::fmt;

pub(crate) const MAX_GENERATION_RESPONSE_BYTES: usize = 76_711_888;
pub(crate) const MAX_GENERATION_FRAGMENT_BYTES: usize = 16 * 1024;
const MAX_MARKDOWN_UNITS: usize = 12 * 1024 * 1024;

#[derive(Clone, Debug)]
pub(crate) struct GenerationReadTarget {
    pub(crate) room_id: String,
    pub(crate) room_epoch: String,
    pub(crate) generation_id: String,
    pub(crate) attempt: u64,
}
#[derive(Clone, Debug)]
pub(crate) struct GenerationViewMeta {
    pub(crate) generation: Value,
}

type Check<T = ()> = Result<T, RoomError>;
fn invalid() -> RoomError {
    RoomError::new("invalid-response", "not-applicable")
}
fn ensure(ok: bool) -> Check {
    if ok {
        Ok(())
    } else {
        Err(invalid())
    }
}

// A resource preflight, not a JSON parser. RawValue must subsequently establish
// syntax, escape and complete-input validity. Closed DTO keys cannot exceed this
// bound even when every character uses a six-byte Unicode escape.
fn resource_bounds(raw: &str) -> Check {
    let bytes = raw.as_bytes();
    let mut quoted = false;
    let mut escaped = false;
    let mut depth = 0usize;
    let mut start = 0;
    for (index, byte) in bytes.iter().copied().enumerate() {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
                let mut next = index + 1;
                while bytes.get(next).is_some_and(u8::is_ascii_whitespace) {
                    next += 1;
                }
                if bytes.get(next) == Some(&b':') {
                    ensure(index - start <= 256)?;
                }
            }
        } else {
            match byte {
                b'"' => {
                    quoted = true;
                    start = index;
                }
                b'{' | b'[' => {
                    depth += 1;
                    ensure(depth <= MAX_JSON_DEPTH)?;
                }
                b'}' | b']' => {
                    depth = depth.checked_sub(1).ok_or_else(invalid)?;
                }
                _ => {}
            }
        }
    }
    ensure(!quoted && depth == 0)
}

type Fields<'a> = BTreeMap<String, &'a RawValue>;
struct Object<'a> {
    required: &'a [&'a str],
    optional: &'a [&'a str],
}
impl<'de> Visitor<'de> for Object<'_> {
    type Value = Fields<'de>;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a closed generation DTO object")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut fields = BTreeMap::new();
        while let Some(key) = map.next_key::<String>()? {
            if (!self.required.contains(&key.as_str()) && !self.optional.contains(&key.as_str()))
                || fields.contains_key(&key)
            {
                return Err(A::Error::custom("invalid generation field"));
            }
            fields.insert(key, map.next_value::<&RawValue>()?);
        }
        if !self.required.iter().all(|key| fields.contains_key(*key)) {
            return Err(A::Error::custom("missing generation field"));
        }
        Ok(fields)
    }
}
fn fields<'a>(raw: &'a RawValue, required: &[&str], optional: &[&str]) -> Check<Fields<'a>> {
    serde_json::Deserializer::from_str(raw.get())
        .deserialize_map(Object { required, optional })
        .map_err(|_| invalid())
}
fn field<'a>(fields: &Fields<'a>, key: &str) -> Check<&'a RawValue> {
    fields.get(key).copied().ok_or_else(invalid)
}
fn optional(fields: &Fields<'_>, key: &str, check: impl FnOnce(&RawValue) -> Check) -> Check {
    if let Some(raw) = fields.get(key) {
        check(raw)?;
    }
    Ok(())
}

struct Array<F> {
    maximum: usize,
    check: F,
}
impl<'de, F: FnMut(&'de RawValue) -> Check> Visitor<'de> for Array<F> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a bounded generation DTO array")
    }
    fn visit_seq<A: SeqAccess<'de>>(mut self, mut seq: A) -> Result<(), A::Error> {
        let mut count = 0;
        while let Some(raw) = seq.next_element::<&RawValue>()? {
            count += 1;
            if count > self.maximum || (self.check)(raw).is_err() {
                return Err(A::Error::custom("invalid generation item"));
            }
        }
        Ok(())
    }
}
impl<'de, F: FnMut(&'de RawValue) -> Check> DeserializeSeed<'de> for Array<F> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_seq(self)
    }
}
fn array<'a>(raw: &'a RawValue, maximum: usize, check: impl FnMut(&'a RawValue) -> Check) -> Check {
    Array { maximum, check }
        .deserialize(&mut serde_json::Deserializer::from_str(raw.get()))
        .map_err(|_| invalid())
}

// Iterate JavaScript string code units without creating a decoded String. In
// particular, an escaped lone surrogate is one valid unit, not a Rust char.
struct Units<'a> {
    chars: std::str::Chars<'a>,
    pending: Option<u16>,
}
impl Iterator for Units<'_> {
    type Item = u16;
    fn next(&mut self) -> Option<u16> {
        if let Some(unit) = self.pending.take() {
            return Some(unit);
        }
        let ch = self.chars.next()?;
        if ch == '\\' {
            return match self.chars.next()? {
                'u' => {
                    let mut unit = 0u16;
                    for _ in 0..4 {
                        unit = (unit << 4) | self.chars.next()?.to_digit(16)? as u16;
                    }
                    Some(unit)
                }
                '"' => Some(34),
                '\\' => Some(92),
                '/' => Some(47),
                'b' => Some(8),
                'f' => Some(12),
                'n' => Some(10),
                'r' => Some(13),
                't' => Some(9),
                _ => None, // RawValue has already excluded invalid escapes.
            };
        }
        let mut buffer = [0u16; 2];
        let units = ch.encode_utf16(&mut buffer);
        if units.len() == 2 {
            self.pending = Some(units[1]);
        }
        Some(units[0])
    }
}
fn units(raw: &RawValue) -> Check<Units<'_>> {
    let raw = raw.get();
    ensure(raw.len() >= 2 && raw.starts_with('"') && raw.ends_with('"'))?;
    Ok(Units {
        chars: raw[1..raw.len() - 1].chars(),
        pending: None,
    })
}
fn whitespace(unit: u16) -> bool {
    matches!(unit, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a
        | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
fn text_span(raw: &RawValue, min: usize, max: usize, trim: bool) -> Check<(usize, usize)> {
    let mut first = None;
    let mut end = 0;
    for (index, unit) in units(raw)?.enumerate() {
        if !trim || !whitespace(unit) {
            let start = *first.get_or_insert(index);
            end = index + 1;
            ensure(end - start <= max)?;
        }
    }
    let start = first.unwrap_or(0);
    ensure(end - start >= min)?;
    Ok((start, end))
}
fn text(raw: &RawValue, min: usize, max: usize, trim: bool) -> Check {
    text_span(raw, min, max, trim).map(|_| ())
}
fn text_units(raw: &RawValue, min: usize, max: usize, trim: bool) -> Check<Vec<u16>> {
    let (start, end) = text_span(raw, min, max, trim)?;
    Ok(units(raw)?.skip(start).take(end - start).collect())
}
fn one_of<'a>(raw: &RawValue, choices: &'a [&'a str]) -> Check<&'a str> {
    for choice in choices {
        if units(raw)?.eq(choice.encode_utf16()) {
            return Ok(choice);
        }
    }
    Err(invalid())
}
fn key_matches(raw: &RawValue, expected: &str) -> Check {
    ensure(
        text_units(raw, 1, 256, true)?
            .into_iter()
            .eq(expected.encode_utf16()),
    )
}
fn number(raw: &RawValue, min: u64, max: u64) -> Check<u64> {
    let value: serde_json::Number = serde_json::from_str(raw.get()).map_err(|_| invalid())?;
    let n = if let Some(n) = value.as_u64() {
        n
    } else {
        let n = value.as_f64().ok_or_else(invalid)?;
        ensure(n.is_finite() && n.fract() == 0.0 && n >= 0.0 && n <= MAX_SAFE_INTEGER as f64)?;
        n as u64
    };
    ensure(n >= min && n <= max && n <= MAX_SAFE_INTEGER)?;
    Ok(n)
}
fn boolean(raw: &RawValue) -> Check<bool> {
    match raw.get() {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(invalid()),
    }
}
fn stable_key(raw: &RawValue) -> Check {
    let key = text_units(raw, 1, 256, true)?;
    ensure(
        ["data-card:", "preset:", "host-local:"]
            .iter()
            .any(|prefix| {
                key.len() > prefix.len()
                    && key
                        .iter()
                        .copied()
                        .take(prefix.len())
                        .eq(prefix.encode_utf16())
            })
            && !key
                .iter()
                .any(|unit| matches!(unit, 10 | 13 | 0x2028 | 0x2029)),
    )
}
fn digest(raw: &RawValue) -> Check {
    let s = text_units(raw, 71, 71, false)?;
    ensure(
        s[..7].iter().copied().eq("sha256:".encode_utf16())
            && s[7..].iter().all(|c| matches!(c, 48..=57 | 97..=102)),
    )
}
fn package_identity(raw: &RawValue) -> Check {
    let s = text_units(raw, 1, 128, false)?;
    let alnum = |unit: &u16| matches!(unit, 48..=57 | 65..=90 | 97..=122);
    ensure(alnum(&s[0]) && s.iter().all(|u| alnum(u) || matches!(u, 46 | 95 | 45)))
}
fn target_path(raw: &RawValue) -> Check {
    let s = text_units(raw, 1, 512, false)?;
    ensure(!s.iter().any(|u| {
        matches!(
            u,
            0..=31 | 127 | 60 | 62 | 58 | 34 | 124 | 63 | 42 | 37 | 92
        )
    }))?;
    let ascii_lower = |u: u16| if (65..=90).contains(&u) { u + 32 } else { u };
    ensure(
        !s.iter()
            .copied()
            .map(ascii_lower)
            .eq("web-package.json".encode_utf16()),
    )?;
    for part in s.split(|u| *u == 47) {
        ensure(
            !part.is_empty()
                && part != [46]
                && part != [46, 46]
                && !matches!(part.last(), Some(46 | 32)),
        )?;
        let stem: Vec<u16> = part
            .iter()
            .copied()
            .take_while(|u| *u != 46)
            .map(ascii_lower)
            .collect();
        ensure(
            !["con", "prn", "aux", "nul"]
                .iter()
                .any(|name| stem.iter().copied().eq(name.encode_utf16()))
                && !(stem.len() == 4
                    && matches!(stem[3], 49..=57)
                    && (stem[..3] == [99, 111, 109] || stem[..3] == [108, 112, 116])),
        )?;
    }
    Ok(())
}
fn web_package(raw: &RawValue) -> Check {
    let f = fields(
        raw,
        &[
            "packageRef",
            "targetPath",
            "targetMediaType",
            "generatedDigest",
        ],
        &[],
    )?;
    let reference = fields(field(&f, "packageRef")?, &["id", "version", "digest"], &[])?;
    package_identity(field(&reference, "id")?)?;
    package_identity(field(&reference, "version")?)?;
    digest(field(&reference, "digest")?)?;
    target_path(field(&f, "targetPath")?)?;
    one_of(
        field(&f, "targetMediaType")?,
        &[
            "text/html",
            "text/plain",
            "text/markdown",
            "text/css",
            "text/javascript",
            "application/javascript",
            "application/json",
            "image/svg+xml",
        ],
    )?;
    digest(field(&f, "generatedDigest")?)
}
fn adjudication(raw: &RawValue) -> Check {
    let f = fields(
        raw,
        &["depth", "description", "type", "roll", "outcome", "details"],
        &[],
    )?;
    number(field(&f, "depth")?, 0, 20)?;
    number(field(&f, "roll")?, 1, 100)?;
    one_of(field(&f, "type")?, &["binary", "custom"])?;
    for key in ["description", "outcome", "details"] {
        text(field(&f, key)?, 0, 2000, false)?;
    }
    Ok(())
}
fn generation_result(raw: &RawValue) -> Check {
    let f = fields(
        raw,
        &["version", "format", "mode"],
        &[
            "webPackage",
            "reporterInfo",
            "scenarioDisplayName",
            "sharedGuidance",
            "characterGuidances",
            "language",
            "storyLength",
            "adjudicationResults",
            "narrativeHistoryReadCount",
            "report",
            "ai",
            "combatantUpdates",
        ],
    )?;
    number(field(&f, "version")?, 1, 1)?;
    let format = one_of(field(&f, "format")?, &["stream-markdown", "stream-web"])?;
    one_of(
        field(&f, "mode")?,
        &["classic", "kizuna", "daily", "scenario"],
    )?;
    optional(&f, "webPackage", |raw| {
        ensure(format == "stream-web")?;
        web_package(raw)
    })?;
    optional(&f, "reporterInfo", |raw| {
        let f = fields(raw, &["name", "publication"], &[])?;
        text(field(&f, "name")?, 0, 300, false)?;
        text(field(&f, "publication")?, 0, 300, false)
    })?;
    optional(&f, "scenarioDisplayName", |raw| text(raw, 1, 200, true))?;
    optional(&f, "sharedGuidance", |raw| text(raw, 0, 200, false))?;
    optional(&f, "characterGuidances", |raw| {
        array(raw, 32, |raw| {
            let f = fields(raw, &["combatantKey", "displayName", "guidance"], &[])?;
            stable_key(field(&f, "combatantKey")?)?;
            text(field(&f, "displayName")?, 1, 200, true)?;
            text(field(&f, "guidance")?, 0, 100, false)
        })
    })?;
    optional(&f, "language", |raw| text(raw, 1, 64, true))?;
    optional(&f, "storyLength", |raw| text(raw, 1, 32, true))?;
    optional(&f, "adjudicationResults", |raw| {
        array(raw, 2100, adjudication)
    })?;
    optional(&f, "narrativeHistoryReadCount", |raw| {
        number(raw, 0, 1_000_000).map(|_| ())
    })?;
    optional(&f, "report", |raw| {
        let f = fields(raw, &[], &["headline", "winner"])?;
        for key in ["headline", "winner"] {
            optional(&f, key, |raw| text(raw, 0, 300, false))?;
        }
        Ok(())
    })?;
    optional(&f, "ai", |raw| {
        let f = fields(raw, &[], &["model", "usage"])?;
        optional(&f, "model", |raw| text(raw, 0, 256, false))?;
        optional(&f, "usage", |raw| {
            let f = fields(
                raw,
                &[],
                &[
                    "textTokens",
                    "promptTokens",
                    "completionTokens",
                    "totalTokens",
                    "cachedTokens",
                    "reasoningTokens",
                ],
            )?;
            for raw in f.values() {
                number(raw, 0, MAX_SAFE_INTEGER)?;
            }
            Ok(())
        })
    })?;
    optional(&f, "combatantUpdates", |raw| {
        array(raw, 32, |raw| {
            let f = fields(
                raw,
                &["combatantKey", "displayName"],
                &["impact", "currentStateSummary"],
            )?;
            stable_key(field(&f, "combatantKey")?)?;
            text(field(&f, "displayName")?, 1, 200, true)?;
            for key in ["impact", "currentStateSummary"] {
                optional(&f, key, |raw| text(raw, 0, 2000, false))?;
            }
            Ok(())
        })
    })
}
// Match the Room protocol's ISO grammar over decoded code units. Fractional
// precision is intentionally unlimited, and even escaped digits stay borrowed.
fn timestamp(raw: &RawValue) -> Check {
    fn digits(input: &mut impl Iterator<Item = u16>, count: usize) -> Check<u32> {
        let mut value = 0;
        for _ in 0..count {
            let unit = input.next().ok_or_else(invalid)?;
            ensure(matches!(unit, 48..=57))?;
            value = value * 10 + u32::from(unit - 48);
        }
        Ok(value)
    }
    let mut input = units(raw)?.peekable();
    let year = digits(&mut input, 4)?;
    ensure(input.next() == Some(45))?;
    let month = digits(&mut input, 2)?;
    ensure(input.next() == Some(45))?;
    let day = digits(&mut input, 2)?;
    ensure(input.next() == Some(84))?;
    let hour = digits(&mut input, 2)?;
    ensure(input.next() == Some(58))?;
    let minute = digits(&mut input, 2)?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        _ => 0,
    };
    ensure(day >= 1 && day <= days && hour <= 23 && minute <= 59)?;
    if input.peek() == Some(&58) {
        input.next();
        ensure(digits(&mut input, 2)? <= 59)?;
        if input.peek() == Some(&46) {
            input.next();
            let mut any = false;
            while input.peek().is_some_and(|unit| matches!(unit, 48..=57)) {
                any = true;
                input.next();
            }
            ensure(any)?;
        }
    }
    match input.next() {
        Some(90) => {}
        Some(43 | 45) => {
            ensure(digits(&mut input, 2)? <= 23)?;
            ensure(input.next() == Some(58))?;
            ensure(digits(&mut input, 2)? <= 59)?;
        }
        _ => return Err(invalid()),
    }
    ensure(input.next().is_none())
}

fn mirror(raw: &RawValue) -> Check<Value> {
    // Bound the shape before constructing even this small Value: an invalid
    // participant list or opaque field must not allocate a second large tree.
    let f = fields(
        raw,
        &[
            "generationRequestId",
            "generationId",
            "attempt",
            "state",
            "configRevision",
            "snapshotDigest",
            "collaborativeInfluence",
            "participantUserIds",
            "startedAt",
        ],
        &["hostAccountUserId", "finishedAt"],
    )?;
    for key in ["generationRequestId", "generationId", "snapshotDigest"] {
        text(field(&f, key)?, 1, 256, true)?;
    }
    number(field(&f, "attempt")?, 1, MAX_SAFE_INTEGER)?;
    number(field(&f, "configRevision")?, 0, MAX_SAFE_INTEGER)?;
    one_of(
        field(&f, "state")?,
        &["starting", "running", "completed", "failed", "cancelled"],
    )?;
    boolean(field(&f, "collaborativeInfluence")?)?;
    array(field(&f, "participantUserIds")?, 32, |raw| {
        number(raw, 0, MAX_SAFE_INTEGER).map(|_| ())
    })?;
    optional(&f, "hostAccountUserId", |raw| {
        number(raw, 1, MAX_SAFE_INTEGER).map(|_| ())
    })?;
    timestamp(field(&f, "startedAt")?)?;
    optional(&f, "finishedAt", timestamp)?;
    // Meta only contains bounded CAS/authority fields, not the complete DTO.
    // Real timestamps have just been validated without decoding or retaining
    // their potentially enormous fractional portions.
    let mut mirror = serde_json::Map::new();
    for (key, raw) in f {
        if matches!(key.as_str(), "startedAt" | "finishedAt") {
            continue;
        }
        let value = if matches!(
            key.as_str(),
            "generationRequestId" | "generationId" | "snapshotDigest"
        ) {
            // Trim before materializing identity text, so even an adversarial
            // amount of surrounding whitespace cannot create a second large copy.
            Value::String(
                String::from_utf16(&text_units(raw, 1, 256, true)?).map_err(|_| invalid())?,
            )
        } else {
            serde_json::from_str(raw.get()).map_err(|_| invalid())?
        };
        mirror.insert(key, value);
    }
    // Reuse the existing closed mirror's identity and participant invariants.
    // Its mandatory timestamp is a temporary placeholder only: the real fields
    // were checked above, and no timestamp is exposed in the returned meta.
    mirror.insert(
        "startedAt".into(),
        Value::String("2000-01-01T00:00:00Z".into()),
    );
    let mut value = Value::Object(mirror);
    validate_generation_mirror(&mut value).map_err(|_| invalid())?;
    value
        .as_object_mut()
        .ok_or_else(invalid)?
        .remove("startedAt");
    Ok(value)
}

pub(crate) fn validate_generation_response(
    raw: &str,
    expected_user_id: u64,
    target: &GenerationReadTarget,
) -> Check<GenerationViewMeta> {
    if raw.len() > MAX_GENERATION_RESPONSE_BYTES {
        return Err(RoomError::new("response-too-large", "not-applicable"));
    }
    resource_bounds(raw)?;
    let raw: &RawValue = serde_json::from_str(raw).map_err(|_| invalid())?;
    let envelope = fields(raw, &["desktopRoom", "result"], &[])?;
    let owner = fields(
        field(&envelope, "desktopRoom")?,
        &["version", "viewerUserId"],
        &[],
    )?;
    one_of(field(&owner, "version")?, &[PROTOCOL_VERSION])?;
    ensure(number(field(&owner, "viewerUserId")?, 1, MAX_SAFE_INTEGER)? == expected_user_id)?;
    let response = fields(
        field(&envelope, "result")?,
        &[
            "protocolVersion",
            "roomId",
            "roomEpoch",
            "generation",
            "status",
            "markdown",
            "nextChunkSeq",
            "finalAuthoritative",
        ],
        &["generationRecordId", "result", "errorCode"],
    )?;
    number(field(&response, "protocolVersion")?, 1, 1)?;
    key_matches(field(&response, "roomId")?, &target.room_id)?;
    key_matches(field(&response, "roomEpoch")?, &target.room_epoch)?;
    let generation = mirror(field(&response, "generation")?)?;
    ensure(
        generation["generationId"].as_str() == Some(target.generation_id.as_str())
            && generation["attempt"].as_u64() == Some(target.attempt),
    )?;
    let status = one_of(
        field(&response, "status")?,
        &[
            "reserved",
            "running",
            "finalizing",
            "completed",
            "failed",
            "cancelled",
            "producer_lost",
        ],
    )?;
    let state = match status {
        "reserved" => "starting",
        "running" | "finalizing" => "running",
        "completed" => "completed",
        "failed" | "producer_lost" => "failed",
        "cancelled" => "cancelled",
        _ => return Err(invalid()),
    };
    ensure(generation["state"].as_str() == Some(state))?;
    text(field(&response, "markdown")?, 0, MAX_MARKDOWN_UNITS, false)?;
    number(field(&response, "nextChunkSeq")?, 0, MAX_SAFE_INTEGER)?;
    let final_authoritative = boolean(field(&response, "finalAuthoritative")?)?;
    let completed = status == "completed";
    ensure(
        final_authoritative == completed
            && response.contains_key("generationRecordId") == completed
            && response.contains_key("result") == completed,
    )?;
    optional(&response, "generationRecordId", |raw| {
        text(raw, 1, 256, true)
    })?;
    optional(&response, "result", generation_result)?;
    ensure(response.contains_key("errorCode") == matches!(status, "failed" | "producer_lost"))?;
    optional(&response, "errorCode", |raw| text(raw, 1, 200, true))?;
    Ok(GenerationViewMeta { generation })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn target() -> GenerationReadTarget {
        GenerationReadTarget {
            room_id: "room-1".into(),
            room_epoch: "epoch-1".into(),
            generation_id: "generation-1".into(),
            attempt: 1,
        }
    }
    fn success() -> Value {
        json!({
            "desktopRoom": {"version": "desktop-room-session-v1", "viewerUserId": 42},
            "result": {
                "protocolVersion": 1, "roomId": "room-1", "roomEpoch": "epoch-1",
                "generation": {
                    "generationRequestId": "request-1", "generationId": "generation-1", "attempt": 1,
                    "state": "completed", "configRevision": 3, "snapshotDigest": "snapshot-1",
                    "collaborativeInfluence": false, "participantUserIds": [42, 43], "hostAccountUserId": 42,
                    "startedAt": "2026-10-12T00:00:00.000Z", "finishedAt": "2026-10-12T00:01:00.000Z"
                },
                "status": "completed", "markdown": "markdown-marker", "nextChunkSeq": 5,
                "finalAuthoritative": true, "generationRecordId": "record-1",
                "result": {
                    "version": 1, "format": "stream-markdown", "mode": "classic",
                    "reporterInfo": {"name": "name", "publication": "publication"},
                    "scenarioDisplayName": "scenario", "sharedGuidance": "guidance",
                    "characterGuidances": [{"combatantKey": "data-card:character-1", "displayName": "character", "guidance": ""}],
                    "language": "zh-CN", "storyLength": "standard",
                    "adjudicationResults": [{"depth": 0, "description": "description-marker", "type": "binary", "roll": 1, "outcome": "outcome", "details": "details"}],
                    "narrativeHistoryReadCount": 1, "report": {"headline": "headline", "winner": "winner"},
                    "ai": {"model": "model", "usage": {"textTokens": 0, "promptTokens": 1, "completionTokens": 2, "totalTokens": 3, "cachedTokens": 0, "reasoningTokens": 0}},
                    "combatantUpdates": [{"combatantKey": "host-local:character-1", "displayName": "character", "impact": "impact", "currentStateSummary": "summary"}]
                }
            }
        })
    }
    fn validate(value: &Value) -> Check<GenerationViewMeta> {
        validate_generation_response(&serde_json::to_string(value).unwrap(), 42, &target())
    }
    fn reject(pointer: &str, value: Value) {
        let mut dto = success();
        *dto.pointer_mut(pointer).expect("fixture pointer") = value;
        assert!(validate(&dto).is_err(), "accepted invalid {pointer}");
    }
    fn with_package() -> Value {
        let mut dto = success();
        dto["result"]["result"]["format"] = json!("stream-web");
        dto["result"]["result"]["webPackage"] = json!({
            "packageRef": {"id": "sample", "version": "v1", "digest": format!("sha256:{}", "a".repeat(64))},
            "targetPath": "generated/page.html", "targetMediaType": "text/html",
            "generatedDigest": format!("sha256:{}", "b".repeat(64))
        });
        dto
    }

    #[test]
    fn consumes_the_shared_generation_read_fixture_without_rewriting_raw_text() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../packages/contracts/fixtures/desktop-room-generation-read.json"
        ))
        .unwrap();
        let raw = fixture["rawEnvelope"].as_str().unwrap();
        assert!(raw.contains(r"\ud800"));
        let before = raw.as_bytes().to_vec();
        let response = &fixture["operation"]["success"]["result"];
        let target = GenerationReadTarget {
            room_id: response["roomId"].as_str().unwrap().into(),
            room_epoch: response["roomEpoch"].as_str().unwrap().into(),
            generation_id: response["generation"]["generationId"]
                .as_str()
                .unwrap()
                .into(),
            attempt: response["generation"]["attempt"].as_u64().unwrap(),
        };
        let meta =
            validate_generation_response(raw, fixture["expectedUserId"].as_u64().unwrap(), &target)
                .unwrap();
        let mut expected = response["generation"].clone();
        expected.as_object_mut().unwrap().remove("startedAt");
        expected.as_object_mut().unwrap().remove("finishedAt");
        assert_eq!(meta.generation, expected);
        assert_eq!(raw.as_bytes(), before);
    }

    #[test]
    fn validates_complete_success_and_returns_only_authority_metadata() {
        let result = validate(&success()).unwrap();
        assert_eq!(result.generation["configRevision"], 3);
        assert!(serde_json::to_string(&result.generation).unwrap().len() < 1024);
        assert!(validate(&with_package()).is_ok());
    }
    #[test]
    fn normalizes_small_mirror_identities_before_materializing_them() {
        let mut dto = success();
        dto["result"]["generation"]["generationId"] = json!(format!(
            "{}generation-1{}",
            " ".repeat(150_000),
            "\u{feff}".repeat(100_000)
        ));
        dto["result"]["generation"]["startedAt"] =
            json!(format!("2026-10-12T00:00:00.{}Z", "1".repeat(300)));
        let meta = validate(&dto).unwrap();
        assert_eq!(meta.generation["generationId"], "generation-1");
        assert!(meta.generation.to_string().len() < 1024);
    }

    #[test]
    fn validates_multimegabyte_timestamp_fractions_without_retaining_them() {
        let expected = validate(&success()).unwrap().generation;
        let raw = success()
            .to_string()
            .replace(
                "2026-10-12T00:00:00.000Z",
                &format!("2026-10-12T00:00:00.{}Z", "1".repeat(3 * 1024 * 1024)),
            )
            .replace(
                "2026-10-12T00:01:00.000Z",
                &format!(
                    r"2026-10-12T00:01:00.{}+23:59",
                    r"\u0031".repeat(512 * 1024)
                ),
            );
        assert!(raw.len() > 6 * 1024 * 1024);
        let original_length = raw.len();
        let original_pointer = raw.as_ptr();
        let meta = validate_generation_response(&raw, 42, &target()).unwrap();
        assert_eq!(meta.generation, expected);
        assert_eq!(
            meta.generation.to_string().len(),
            expected.to_string().len()
        );
        assert!(meta.generation.get("startedAt").is_none());
        assert!(meta.generation.get("finishedAt").is_none());
        assert_eq!(raw.len(), original_length);
        assert_eq!(raw.as_ptr(), original_pointer);
    }

    #[test]
    fn borrowed_timestamp_grammar_matches_the_existing_mirror_validator() {
        for candidate in [
            "0000-02-29T00:00Z",
            "2000-02-29T23:59:59Z",
            "2026-10-12T00:00:00.12345678901234567890+23:59",
            "1900-02-28T00:00-23:59",
            "2026-10-12T00:00:00.0-00:00",
            "1900-02-29T00:00:00Z",
            "2026-00-12T00:00:00Z",
            "2026-13-12T00:00:00Z",
            "2026-10-00T00:00:00Z",
            "2026-04-31T00:00:00Z",
            "2026-10-12T24:00:00Z",
            "2026-10-12T00:60:00Z",
            "2026-10-12T00:00:60Z",
            "2026-10-12T00:00:00.Z",
            "2026-10-12T00:00.1Z",
            "2026-10-12T00:00:00.1",
            "2026-10-12T00:00:00+24:00",
            "2026-10-12T00:00:00+00:60",
            "2026-10-12T00:00:00+0000",
            "2026-10-12T00:00:00z",
            "2026-10-12T00:00:00ZZ",
            " 2026-10-12T00:00:00Z",
            "2026-10-12T00:00:00Z ",
            "2026-10-12t00:00:00Z",
            "10000-10-12T00:00:00Z",
            "2026-10-12T00:00:00.１２Z",
        ] {
            let mut original = success()["result"]["generation"].clone();
            original["startedAt"] = json!(candidate);
            let expected = validate_generation_mirror(&mut original).is_ok();
            let encoded = serde_json::to_string(candidate).unwrap();
            let raw: &RawValue = serde_json::from_str(&encoded).unwrap();
            assert_eq!(timestamp(raw).is_ok(), expected, "timestamp {candidate}");
            for field in ["startedAt", "finishedAt"] {
                let mut dto = success();
                dto["result"]["generation"][field] = json!(candidate);
                assert_eq!(
                    validate(&dto).is_ok(),
                    expected,
                    "timestamp {field}: {candidate}"
                );
            }
        }
        let escaped: &RawValue =
            serde_json::from_str(r#""\u0032\u0030\u0032\u0036-10-12T00:00:00.\u0031Z""#).unwrap();
        assert!(timestamp(escaped).is_ok());
        let surrogate: &RawValue =
            serde_json::from_str(r#""2026-10-12T00:00:00.\ud800Z""#).unwrap();
        assert!(timestamp(surrogate).is_err());
    }

    #[test]
    fn binds_owner_room_epoch_generation_and_attempt() {
        for (path, value) in [
            ("/desktopRoom/viewerUserId", json!(43)),
            ("/desktopRoom/version", json!("next")),
            ("/result/protocolVersion", json!(2)),
            ("/result/roomId", json!("other")),
            ("/result/roomEpoch", json!("other")),
            ("/result/generation/generationId", json!("other")),
            ("/result/generation/attempt", json!(2)),
        ] {
            reject(path, value);
        }
        assert!(validate_generation_response(&success().to_string(), 0, &target()).is_err());
    }
    #[test]
    fn enforces_every_status_state_authority_and_error_relationship() {
        for (status, state) in [
            ("reserved", "starting"),
            ("running", "running"),
            ("finalizing", "running"),
            ("completed", "completed"),
            ("failed", "failed"),
            ("producer_lost", "failed"),
            ("cancelled", "cancelled"),
        ] {
            let mut dto = success();
            dto["result"]["status"] = json!(status);
            dto["result"]["generation"]["state"] = json!(state);
            let completed = status == "completed";
            if !completed {
                dto["result"]["finalAuthoritative"] = json!(false);
                dto["result"].as_object_mut().unwrap().remove("result");
                dto["result"]
                    .as_object_mut()
                    .unwrap()
                    .remove("generationRecordId");
            }
            let needs_error = matches!(status, "failed" | "producer_lost");
            if needs_error {
                dto["result"]["errorCode"] = json!("generation-failed");
            }
            assert!(validate(&dto).is_ok(), "status {status}");
            let mut changed = dto.clone();
            changed["result"]["generation"]["state"] = json!(if state == "running" {
                "completed"
            } else {
                "running"
            });
            assert!(validate(&changed).is_err());
            let mut changed = dto.clone();
            changed["result"]["finalAuthoritative"] = json!(!completed);
            assert!(validate(&changed).is_err());
            let mut changed = dto.clone();
            if needs_error {
                changed["result"]
                    .as_object_mut()
                    .unwrap()
                    .remove("errorCode");
            } else {
                changed["result"]["errorCode"] = json!("unexpected");
            }
            assert!(validate(&changed).is_err());
            for field in ["result", "generationRecordId"] {
                let mut changed = dto.clone();
                if completed {
                    changed["result"].as_object_mut().unwrap().remove(field);
                } else {
                    changed["result"][field] = success()["result"][field].clone();
                }
                assert!(validate(&changed).is_err());
            }
        }
        reject("/result/status", json!("done"));
        reject("/result/generation/state", json!("reserved"));
    }
    #[test]
    fn rejects_unknown_duplicate_and_escaped_duplicate_keys() {
        for path in [
            "",
            "/desktopRoom",
            "/result",
            "/result/generation",
            "/result/result",
            "/result/result/reporterInfo",
            "/result/result/characterGuidances/0",
            "/result/result/adjudicationResults/0",
            "/result/result/report",
            "/result/result/ai",
            "/result/result/ai/usage",
            "/result/result/combatantUpdates/0",
        ] {
            let mut dto = success();
            dto.pointer_mut(path)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("unknown".into(), json!(0));
            assert!(validate(&dto).is_err(), "unknown field at {path}");
        }
        let encoded = success().to_string();
        for key in ["mode", r"m\u006fde"] {
            let raw = encoded.replace(
                r#""mode":"classic""#,
                &format!(r#""mode":"classic","{key}":"daily""#),
            );
            assert!(validate_generation_response(&raw, 42, &target()).is_err());
        }
        let raw = encoded.replace(r#""mode":"classic""#, r#""m\u006fde":"classic""#);
        assert!(validate_generation_response(&raw, 42, &target()).is_ok());
    }
    #[test]
    fn treats_optional_null_as_invalid_and_checks_all_scalar_types() {
        for path in [
            "/result/generationRecordId",
            "/result/result",
            "/result/result/reporterInfo",
            "/result/result/scenarioDisplayName",
            "/result/result/sharedGuidance",
            "/result/result/characterGuidances",
            "/result/result/language",
            "/result/result/storyLength",
            "/result/result/adjudicationResults",
            "/result/result/narrativeHistoryReadCount",
            "/result/result/report",
            "/result/result/ai",
            "/result/result/combatantUpdates",
            "/result/generation/hostAccountUserId",
            "/result/generation/finishedAt",
        ] {
            reject(path, Value::Null);
        }
        for (path, value) in [
            ("/result/markdown", json!([])),
            ("/result/finalAuthoritative", json!(1)),
            ("/result/result/version", json!(2)),
            ("/result/result/format", json!("html")),
            ("/result/result/mode", json!("arena")),
            ("/result/result/language", json!(" \t")),
            ("/result/result/storyLength", json!("")),
            ("/result/result/scenarioDisplayName", json!("")),
            (
                "/result/result/characterGuidances/0/combatantKey",
                json!("data-card:"),
            ),
            (
                "/result/result/characterGuidances/0/combatantKey",
                json!("data-card:x\ny"),
            ),
            (
                "/result/result/combatantUpdates/0/displayName",
                json!(false),
            ),
            ("/result/result/reporterInfo/name", json!(3)),
            ("/result/result/report/headline", json!(false)),
            ("/result/result/ai/model", json!(1)),
            ("/result/result/adjudicationResults/0/type", json!("dice")),
            ("/result/result/adjudicationResults/0/roll", json!(0)),
            ("/result/result/adjudicationResults/0/roll", json!(101)),
            ("/result/result/adjudicationResults/0/depth", json!(21)),
            ("/result/result/narrativeHistoryReadCount", json!(1_000_001)),
            ("/result/generation/participantUserIds", json!([42, 42])),
            ("/result/generation/hostAccountUserId", json!(44)),
            (
                "/result/generation/startedAt",
                json!("2026-02-30T00:00:00Z"),
            ),
            ("/result/generation/finishedAt", json!({"unexpected": []})),
        ] {
            reject(path, value);
        }
    }
    #[test]
    fn validates_portable_web_package_references_without_content() {
        for path in [
            "/absolute",
            "a//b",
            "./a",
            "../a",
            "a/../b",
            "a\\b",
            "a%20b",
            "a:b",
            "a?b",
            "a\u{007f}b",
            "a ",
            "a.",
            "CON.txt",
            "a/com1",
            "LPT9.log",
            "Web-Package.JSON",
        ] {
            let mut dto = with_package();
            dto["result"]["result"]["webPackage"]["targetPath"] = json!(path);
            assert!(validate(&dto).is_err(), "path {path}");
        }
        for (key, value) in [
            ("targetMediaType", json!("application/octet-stream")),
            (
                "generatedDigest",
                json!(format!("sha256:{}", "A".repeat(64))),
            ),
            ("generatedContent", json!("must not be exposed")),
            ("files", json!([])),
        ] {
            let mut dto = with_package();
            dto["result"]["result"]["webPackage"][key] = value;
            assert!(validate(&dto).is_err());
        }
        for key in ["id", "version", "digest", "unknown"] {
            let mut dto = with_package();
            dto["result"]["result"]["webPackage"]["packageRef"][key] = json!("bad/value");
            assert!(validate(&dto).is_err());
        }
        let mut dto = with_package();
        dto["result"]["result"]["format"] = json!("stream-markdown");
        assert!(validate(&dto).is_err());
    }
    #[test]
    fn checks_safe_integer_boundaries_in_every_numeric_surface() {
        for path in [
            "/desktopRoom/viewerUserId",
            "/result/nextChunkSeq",
            "/result/generation/attempt",
            "/result/generation/configRevision",
            "/result/generation/participantUserIds/0",
            "/result/generation/hostAccountUserId",
            "/result/result/narrativeHistoryReadCount",
            "/result/result/ai/usage/textTokens",
            "/result/result/ai/usage/promptTokens",
            "/result/result/ai/usage/completionTokens",
            "/result/result/ai/usage/totalTokens",
            "/result/result/ai/usage/cachedTokens",
            "/result/result/ai/usage/reasoningTokens",
        ] {
            for n in [
                json!(MAX_SAFE_INTEGER + 1),
                json!(-1),
                json!(0.5),
                json!("1"),
            ] {
                reject(path, n);
            }
        }
        let mut dto = success();
        dto["result"]["nextChunkSeq"] = json!(MAX_SAFE_INTEGER);
        dto["result"]["result"]["ai"]["usage"]["totalTokens"] = json!(MAX_SAFE_INTEGER);
        assert!(validate(&dto).is_ok());
        let encoded = success()
            .to_string()
            .replace(r#""nextChunkSeq":5"#, r#""nextChunkSeq":5e0"#);
        assert!(validate_generation_response(&encoded, 42, &target()).is_ok());
    }
    #[test]
    fn accepts_large_markdown_and_uses_utf16_instead_of_utf8_limits() {
        let mut dto = success();
        dto["result"]["markdown"] = json!("正文😀".repeat(100_000));
        assert!(dto.to_string().len() > 256 * 1024);
        assert!(validate(&dto).is_ok());
        for (path, limit) in [
            ("/result/result/reporterInfo/name", 300),
            ("/result/result/reporterInfo/publication", 300),
            ("/result/result/scenarioDisplayName", 200),
            ("/result/result/sharedGuidance", 200),
            ("/result/result/characterGuidances/0/displayName", 200),
            ("/result/result/characterGuidances/0/guidance", 100),
            ("/result/result/language", 64),
            ("/result/result/storyLength", 32),
            ("/result/result/adjudicationResults/0/description", 2000),
            ("/result/result/adjudicationResults/0/outcome", 2000),
            ("/result/result/adjudicationResults/0/details", 2000),
            ("/result/result/report/headline", 300),
            ("/result/result/report/winner", 300),
            ("/result/result/ai/model", 256),
            ("/result/result/combatantUpdates/0/impact", 2000),
            (
                "/result/result/combatantUpdates/0/currentStateSummary",
                2000,
            ),
        ] {
            let mut dto = success();
            *dto.pointer_mut(path).unwrap() = json!("😀".repeat(limit / 2));
            assert!(validate(&dto).is_ok(), "max at {path}");
            *dto.pointer_mut(path).unwrap() = json!(format!("{}a", "😀".repeat(limit / 2)));
            assert!(validate(&dto).is_err(), "max + 1 at {path}");
        }
    }
    #[test]
    fn preserves_json_escapes_lone_surrogates_and_js_trim_rules() {
        let encoded = success().to_string();
        for escape in [r"\ud800", r"\udfff", r"\ud83d\ude00", r#"\u4e2d\n\t\"\/"#] {
            let raw = encoded
                .replace("markdown-marker", escape)
                .replace("description-marker", escape);
            assert!(
                validate_generation_response(&raw, 42, &target()).is_ok(),
                "escape {escape}"
            );
        }
        let raw = encoded.replace("description-marker", &r"\ud800".repeat(2000));
        assert!(validate_generation_response(&raw, 42, &target()).is_ok());
        let raw = encoded.replace("description-marker", &r"\ud800".repeat(2001));
        assert!(validate_generation_response(&raw, 42, &target()).is_err());
        let raw = encoded.replace("description-marker", &r"\ud83d\ude00".repeat(1001));
        assert!(validate_generation_response(&raw, 42, &target()).is_err());
        let mut dto = success();
        dto["result"]["roomId"] = json!("\u{feff}room-1\u{00a0}");
        dto["result"]["result"]["language"] = json!(format!("\u{feff}{}\u{00a0}", "语".repeat(64)));
        assert!(validate(&dto).is_ok());
        dto["result"]["result"]["language"] = json!("\u{feff}\u{00a0}");
        assert!(validate(&dto).is_err());
    }
    #[test]
    fn checks_each_large_adjudication_node_and_array_limits() {
        let mut dto = success();
        let item = json!({"depth":20, "description":"字".repeat(2000), "type":"custom", "roll":100,
            "outcome":"😀".repeat(1000), "details":"d".repeat(2000)});
        dto["result"]["result"]["adjudicationResults"] = json!(vec![item.clone(); 2100]);
        assert!(validate(&dto).is_ok());
        for index in [0, 1049, 2099] {
            let saved = dto["result"]["result"]["adjudicationResults"][index]["roll"].take();
            dto["result"]["result"]["adjudicationResults"][index]["roll"] = json!(101);
            assert!(validate(&dto).is_err());
            dto["result"]["result"]["adjudicationResults"][index]["roll"] = saved;
        }
        dto["result"]["result"]["adjudicationResults"]
            .as_array_mut()
            .unwrap()
            .push(item);
        assert!(validate(&dto).is_err());
        for key in ["characterGuidances", "combatantUpdates"] {
            let mut dto = success();
            let item = dto["result"]["result"][key][0].clone();
            dto["result"]["result"][key] = json!(vec![item.clone(); 32]);
            assert!(validate(&dto).is_ok());
            dto["result"]["result"][key]
                .as_array_mut()
                .unwrap()
                .push(item);
            assert!(validate(&dto).is_err());
        }
    }
    #[test]
    fn applies_markdown_utf16_limit_and_complete_wire_byte_limit() {
        let mut dto = success();
        dto["result"]["markdown"] = json!("x".repeat(MAX_MARKDOWN_UNITS));
        assert!(validate(&dto).is_ok());
        dto["result"]["markdown"] = json!("x".repeat(MAX_MARKDOWN_UNITS + 1));
        assert!(validate(&dto).is_err());
        let mut raw = success().to_string();
        raw.extend(std::iter::repeat_n(
            ' ',
            MAX_GENERATION_RESPONSE_BYTES - raw.len(),
        ));
        assert!(validate_generation_response(&raw, 42, &target()).is_ok());
        raw.push(' ');
        assert_eq!(
            validate_generation_response(&raw, 42, &target())
                .unwrap_err()
                .code,
            "response-too-large"
        );
    }
    #[test]
    fn never_confuses_resource_preflight_with_json_syntax_validation() {
        let raw = success().to_string();
        for invalid_raw in [
            format!("{raw} null"),
            format!("{raw},"),
            raw[..raw.len() - 1].to_owned(),
            raw.replace("markdown-marker", r"\uZZZZ"),
            raw.replace("markdown-marker", r"\x41"),
            raw.replace("markdown-marker", "literal\nline"),
            raw.replace(r#""nextChunkSeq":5"#, r#""nextChunkSeq":01"#),
            raw.replace(r#""nextChunkSeq":5"#, r#""nextChunkSeq":1e9999"#),
        ] {
            assert!(validate_generation_response(&invalid_raw, 42, &target()).is_err());
        }
        let deep = format!(
            "{}0{}",
            "[".repeat(MAX_JSON_DEPTH + 1),
            "]".repeat(MAX_JSON_DEPTH + 1)
        );
        assert!(validate_generation_response(
            &raw.replace(r#""markdown-marker""#, &deep),
            42,
            &target()
        )
        .is_err());
        assert!(validate_generation_response(
            &raw.replace("mode", &"x".repeat(257)),
            42,
            &target()
        )
        .is_err());
    }
}
