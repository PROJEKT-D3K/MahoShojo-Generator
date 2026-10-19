//! Native's closed mirror of the existing Room wire contract. No transport or credentials.
//!
//! Keep in step with packages/contracts/src/{desktop-room-session,protocol,
//! shared-config,proposals,websocket-transport}. Validation preserves every
//! accepted field; only the producer's own trim/default normalization is applied.
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) const PROTOCOL_VERSION: &str = "desktop-room-session-v1";
pub(crate) const PROTOCOL_HEADER: &str = "x-mahoshojo-desktop-room-protocol";
pub(crate) const EXPECTED_USER_ID_HEADER: &str = "x-mahoshojo-room-expected-user-id";
pub(crate) const WEBSOCKET_PATH: &str = "/api/arena/rooms/v1/ws";
pub(crate) const WEBSOCKET_PROTOCOL: &str = "mahoshojo.arena-room.v1";
pub(crate) const PRESENCE_PROTOCOL: &str = "mahoshojo.arena-room.presence.v1";
pub(crate) const MAX_ORIGINAL_REQUEST_BYTES: usize = 64 * 1024;
pub(crate) const MAX_REQUEST_BYTES: usize = 65 * 1024;
pub(crate) const MAX_IPC_REQUEST_BYTES: usize = 67 * 1024;
pub(crate) const MAX_START_ORIGINAL_REQUEST_BYTES: usize = 12 * 1024 * 1024;
pub(crate) const MAX_START_REQUEST_BYTES: usize = MAX_START_ORIGINAL_REQUEST_BYTES + 1024;
pub(crate) const MAX_START_IPC_REQUEST_BYTES: usize = MAX_START_ORIGINAL_REQUEST_BYTES + 3 * 1024;
// Only start recovery projections need the larger bounded receipt.
pub(crate) const MAX_START_RECOVERY_RESPONSE_BYTES: usize = 8 * 1024;
pub(crate) const MAX_RESPONSE_BYTES: usize = 256 * 1024;
pub(crate) const MAX_WEBSOCKET_BYTES: usize = 64 * 1024;
pub(crate) const MAX_TICKET_BYTES: usize = 4096;
pub(crate) const MAX_JSON_DEPTH: usize = 64;
pub(crate) const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

const ERROR_CODES: &[&str] = &[
    "input-too-complex",
    "input-too-large",
    "invalid-request",
    "invalid-response",
    "not-authenticated",
    "scope-changed",
    "storage-unavailable",
    "network-error",
    "response-too-large",
    "busy",
    "backpressure",
    "document-unavailable",
    "presence-unsupported",
    "service-rejected",
    "internal-error",
];
const SERVER_CODES: &[&str] = &[
    "ROOM_AUTHENTICATION_REQUIRED",
    "ROOM_AUTHENTICATION_DENIED",
    "ROOM_FORBIDDEN",
    "ROOM_NOT_FOUND",
    "ROOM_PAYLOAD_TOO_LARGE",
    "ROOM_REQUEST_INVALID",
    "ROOM_CONFLICT",
    "ROOM_RATE_LIMITED",
    "ROOM_UNAVAILABLE",
    "ROOM_GENERATION_COMBATANTS_EMPTY",
    "ROOM_GENERATION_COMBATANTS_INSUFFICIENT",
    "ROOM_GENERATION_SCENARIO_REQUIRED",
    "ROOM_GENERATION_COMBATANT_LIMIT",
    "ROOM_GENERATION_RANDOM_COMBATANT_UNRESOLVED",
    "ROOM_GENERATION_RECONCILIATION_REQUIRED",
    "ROOM_MEMBER_LIMIT_REACHED",
    "ROOM_PROPOSAL_PENDING_LIMIT_REACHED",
    "ROOM_PROPOSAL_CHANGE_LIMIT",
    "ROOM_PROPOSAL_BYTE_LIMIT",
    "ROOM_CONFIG_FRAME_TOO_LARGE",
    "ROOM_CONFIG_SHAREABILITY_INVALID",
    "ROOM_CONFIG_COMBATANT_LIMIT",
    "ROOM_CONFIG_REFERENCE_LIMIT",
    "ROOM_HOST_LOCAL_PAYLOAD_MISSING",
    "ROOM_HOST_LOCAL_PAYLOAD_INVALID",
    "ROOM_HOST_LOCAL_KIND_MISMATCH",
    "ROOM_HOST_LOCAL_DIGEST_MISMATCH",
    "ROOM_HOST_LOCAL_TYPE_MISMATCH",
    "ROOM_HOST_LOCAL_PAYLOAD_MISSING_OR_MISMATCH",
    "ROOM_HOST_LOCAL_CONTENT_VERSION_MISSING",
    "ROOM_HOST_LOCAL_CONTENT_VERSION_MISMATCH",
    "ROOM_REFERENCE_VERSION_MISSING",
    "ROOM_REFERENCE_STALE",
    "ROOM_REFERENCE_DENIED",
    "ROOM_RUNTIME_BODY_LIMIT",
    "ROOM_RUNTIME_REFERENCE_LIMIT",
    "ROOM_RUNTIME_ADJUDICATION_LIMIT",
    "ROOM_RUNTIME_PROMPT_BUDGET_EXCEEDED",
    "ROOM_PROVIDER_CONFIG_INVALID",
    "ROOM_DESKTOP_PROTOCOL_INVALID",
    "ROOM_DESKTOP_OWNER_MISMATCH",
    "ROOM_DESKTOP_OPERATION_UNSUPPORTED",
    "ROOM_DESKTOP_RESPONSE_TOO_LARGE",
    "ROOM_DESKTOP_RESPONSE_INVALID",
];
const ARENA_CODES: &[&str] = &[
    "unauthorized",
    "forbidden",
    "capability-denied",
    "stale",
    "precondition-failed",
    "reference-changed",
    "protocol-incompatible",
    "payload-too-large",
    "rate-limited",
    "duplicate",
    "idempotent-replay",
    "not-found",
    "room-closed",
    "generation-failed",
    "web-package-output-invalid",
    "invalid-message",
    "validation-failed",
    "conflict",
];

/// No raw service/error/URL text can be stored in this renderer-visible error.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoomError {
    pub(crate) code: &'static str,
    pub(crate) message: &'static str,
    pub(crate) outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) server_code: Option<&'static str>,
}
impl RoomError {
    pub(crate) fn new(code: &str, outcome: &str) -> Self {
        Self {
            code: ERROR_CODES
                .iter()
                .copied()
                .find(|c| *c == code)
                .unwrap_or("internal-error"),
            message: "多人房间操作未完成",
            outcome: match outcome {
                "unknown" => "unknown",
                "not-applied" => "not-applied",
                _ => "not-applicable",
            },
            server_code: None,
        }
    }
    pub(crate) fn with_server_code(mut self, code: &str) -> Self {
        self.server_code = SERVER_CODES.iter().copied().find(|c| *c == code);
        self
    }
}
impl std::fmt::Display for RoomError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for RoomError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Operation {
    Discover,
    Create,
    Join,
    Session,
    Ticket,
    Leave,
    Close,
    Config,
    #[serde(rename = "proposalSubmit")]
    ProposalSubmit,
    #[serde(rename = "proposalWithdraw")]
    ProposalWithdraw,
    #[serde(rename = "proposalResolve")]
    ProposalResolve,
    #[serde(rename = "generationRead")]
    GenerationRead,
    #[serde(rename = "generationCancel")]
    GenerationCancel,
    #[serde(rename = "generationStart")]
    GenerationStart,
}
impl Operation {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Discover => "discover",
            Self::Create => "create",
            Self::Join => "join",
            Self::Session => "session",
            Self::Ticket => "ticket",
            Self::Leave => "leave",
            Self::Close => "close",
            Self::Config => "config",
            Self::ProposalSubmit => "proposalSubmit",
            Self::ProposalWithdraw => "proposalWithdraw",
            Self::ProposalResolve => "proposalResolve",
            Self::GenerationRead => "generationRead",
            Self::GenerationCancel => "generationCancel",
            Self::GenerationStart => "generationStart",
        }
    }
    pub(crate) fn is_post(self) -> bool {
        !matches!(self, Self::Discover | Self::Session | Self::GenerationRead)
    }
    fn rejected_outcome(self) -> &'static str {
        if self.is_post() {
            "unknown"
        } else {
            "not-applicable"
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct AttachRequest {
    pub(crate) document_nonce: String,
    pub(crate) attach_intent: u64,
    pub(crate) expected_user_id: u64,
}
#[derive(Clone, Debug)]
pub(crate) struct SubscribeRequest {
    pub(crate) handle: String,
    pub(crate) room_id: String,
    pub(crate) expected_room_epoch: String,
}
#[derive(Clone, Debug)]
pub(crate) struct Request {
    pub(crate) handle: String,
    pub(crate) action: Action,
}
#[derive(Clone, Debug)]
pub(crate) enum Action {
    CancelGenerationStart {
        intent_id: String,
    },
    EndGenerationStartTracking {
        intent_id: String,
    },
    RetryGenerationStart {
        intent_id: String,
    },
    GenerationCancel {
        room_id: String,
        generation_id: String,
        expected_room_epoch: String,
        expected_attempt: u64,
    },
    GenerationRead {
        generation_id: String,
        expected_room_epoch: String,
        expected_attempt: u64,
    },
    Discover {
        query: Value,
    },
    Create {
        request: Value,
    },
    ResumeCreate {
        intent_id: String,
    },
    Join {
        room_id: String,
        request: Value,
    },
    Session {
        room_id: String,
    },
    Config {
        room_id: String,
        request: Value,
    },
    ProposalSubmit {
        room_id: String,
        request: Value,
    },
    ProposalWithdraw {
        room_id: String,
        proposal_id: String,
        request: Value,
    },
    ProposalResolve {
        room_id: String,
        proposal_id: String,
        request: Value,
    },
    EndProposalTracking {
        intent_id: String,
    },
    EndConfigTracking {
        intent_id: String,
    },
    Leave {
        room_id: String,
        expected_room_epoch: String,
    },
    Close {
        room_id: String,
        expected_room_epoch: String,
    },
    Pull {
        subscription_id: String,
    },
    Ack {
        subscription_id: String,
        batch_id: String,
        sequence: u64,
    },
}
/// Deliberately neither Debug nor Serialize. Never return this value over IPC.
pub(crate) struct RoomTicket {
    pub(crate) token: String,
    pub(crate) expires_in_seconds: u64,
}

type Check = Result<(), ()>;
fn ensure(ok: bool) -> Check {
    if ok {
        Ok(())
    } else {
        Err(())
    }
}
fn invalid_request() -> RoomError {
    RoomError::new("invalid-request", "not-applied")
}
fn closed(v: &Value, required: &[&str], optional: &[&str]) -> Check {
    let o = v.as_object().ok_or(())?;
    ensure(
        required.iter().all(|k| o.contains_key(*k))
            && o.keys()
                .all(|k| required.contains(&k.as_str()) || optional.contains(&k.as_str())),
    )
}
fn has(v: &Value, key: &str) -> bool {
    v.as_object().is_some_and(|o| o.contains_key(key))
}
fn text(v: &Value) -> Result<&str, ()> {
    v.as_str().ok_or(())
}
fn literal(v: &Value, s: &str) -> Check {
    ensure(v.as_str() == Some(s))
}
fn one_of(v: &Value, choices: &[&str]) -> Check {
    ensure(choices.contains(&text(v)?))
}
fn boolean(v: &Value) -> Check {
    ensure(v.is_boolean())
}
fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn string(v: &mut Value, min: usize, max: usize, trim: bool) -> Check {
    let raw = text(v)?;
    let s = if trim {
        raw.trim_matches(js_whitespace)
    } else {
        raw
    };
    let len = s.encode_utf16().count();
    ensure(len >= min && len <= max)?;
    if s.len() != raw.len() {
        *v = Value::String(s.to_owned());
    }
    Ok(())
}
fn key(v: &mut Value) -> Check {
    string(v, 1, 256, true)
}
/// Mirror DesktopRoomSessionRoomId/ProposalIdSchema without repairing the target.
pub(crate) fn canonical_path_id(raw: &str) -> bool {
    !raw.is_empty()
        && raw.encode_utf16().count() <= 256
        && raw.trim_matches(js_whitespace) == raw
        && !matches!(raw, "." | "..")
        && !raw.contains(['\\', '/', '%'])
}
fn desktop_path_id(v: &Value) -> Check {
    ensure(canonical_path_id(text(v)?))
}
fn display_name(v: &mut Value) -> Check {
    string(v, 1, 200, true)
}
fn safe_u64(v: &Value) -> Result<u64, ()> {
    if let Some(n) = v.as_u64() {
        return if n <= MAX_SAFE_INTEGER {
            Ok(n)
        } else {
            Err(())
        };
    }
    let n = v.as_f64().ok_or(())?;
    if n.is_finite() && n.fract() == 0.0 && n >= 0.0 && n <= MAX_SAFE_INTEGER as f64 {
        Ok(n as u64)
    } else {
        Err(())
    }
}
fn integer(v: &mut Value, min: u64, max: u64) -> Check {
    let n = safe_u64(v)?;
    ensure(n >= min && n <= max)?;
    *v = Value::from(n);
    Ok(())
}
fn version(v: &mut Value) -> Check {
    integer(v, 1, 1)
}
fn id(v: &mut Value, min: usize) -> Check {
    let s = text(v)?;
    ensure(
        s.len() >= min
            && s.len() <= 128
            && s.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c)),
    )
}
fn stable_key(v: &mut Value) -> Check {
    key(v)?;
    let s = text(v)?;
    ensure(
        ["data-card:", "preset:", "host-local:"]
            .iter()
            .any(|p| s.starts_with(p) && s.len() > p.len())
            && !s.contains(['\n', '\r', '\u{2028}', '\u{2029}']),
    )
}
fn digest(v: &Value) -> Check {
    let s = text(v)?;
    ensure(
        s.len() == 71
            && s.starts_with("sha256:")
            && s[7..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
    )
}
fn cursor(v: &Value) -> Check {
    let s = text(v)?;
    ensure(
        !s.is_empty()
            && s.len() <= 512
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
    )
}
fn custom_length(v: &Value) -> Check {
    if v.is_null() {
        return Ok(());
    }
    let s = text(v)?;
    ensure(
        !s.is_empty()
            && s.len() <= 32
            && matches!(s.as_bytes()[0], b'1'..=b'9')
            && s.bytes().all(|b| b.is_ascii_digit()),
    )
}
fn story_length(v: &Value) -> Check {
    one_of(v, &["default", "short", "standard", "detailed", "long"])
}
fn battle_mode(v: &Value) -> Check {
    one_of(v, &["classic", "kizuna", "daily", "scenario"])
}
fn nullable(v: &mut Value, f: fn(&mut Value) -> Check) -> Check {
    if v.is_null() {
        Ok(())
    } else {
        f(v)
    }
}
fn optional(v: &mut Value, name: &str, f: fn(&mut Value) -> Check) -> Check {
    if has(v, name) {
        f(&mut v[name])
    } else {
        Ok(())
    }
}
fn array(v: &mut Value, min: usize, max: usize, f: impl Fn(&mut Value) -> Check) -> Check {
    let items = v.as_array_mut().ok_or(())?;
    ensure(items.len() >= min && items.len() <= max)?;
    for item in items {
        f(item)?;
    }
    Ok(())
}
fn unique_field(v: &Value, field: &str) -> Check {
    let a = v.as_array().ok_or(())?;
    let mut seen = BTreeSet::new();
    for x in a {
        ensure(seen.insert(text(&x[field])?))?;
    }
    Ok(())
}
fn unique_strings(v: &Value) -> Check {
    let a = v.as_array().ok_or(())?;
    let mut seen = BTreeSet::new();
    for x in a {
        ensure(seen.insert(text(x)?))?;
    }
    Ok(())
}
fn byte_len(v: &Value) -> Result<usize, ()> {
    json_size(v, usize::MAX)
}
/// Object-only, JS-safe and depth bounded, before any trimming/defaulting.
fn bounded(v: &Value, maximum: usize) -> Check {
    ensure(v.is_object())?;
    fn visit(value: &Value, depth: usize) -> Check {
        match value {
            Value::Object(fields) => {
                ensure(depth <= MAX_JSON_DEPTH)?;
                for (key, child) in fields {
                    ensure(!matches!(
                        key.as_str(),
                        "__proto__" | "prototype" | "constructor"
                    ))?;
                    visit(child, depth + 1)?;
                }
            }
            Value::Array(items) => {
                ensure(depth <= MAX_JSON_DEPTH)?;
                for child in items {
                    visit(child, depth + 1)?;
                }
            }
            Value::Number(number) => {
                let number = number.as_f64().ok_or(())?;
                ensure(
                    number.is_finite()
                        && (number.fract() != 0.0 || number.abs() <= MAX_SAFE_INTEGER as f64),
                )?;
            }
            _ => {}
        }
        Ok(())
    }
    visit(v, 0)?;
    json_size(v, maximum).map(|_| ())
}
fn decode(raw: &[u8], maximum: usize, outcome: &'static str) -> Result<Value, RoomError> {
    if raw.len() > maximum {
        return Err(RoomError::new("response-too-large", outcome));
    }
    let raw = std::str::from_utf8(raw).map_err(|_| RoomError::new("invalid-response", outcome))?;
    let v: Value =
        serde_json::from_str(raw).map_err(|_| RoomError::new("invalid-response", outcome))?;
    bounded(&v, maximum).map_err(|_| RoomError::new("invalid-response", outcome))?;
    Ok(v)
}

/// Zod's ISO datetime accepts arbitrary fractional precision; do not shorten it
/// through an RFC3339 parser with a fixed nanosecond budget.
fn timestamp(v: &Value) -> Check {
    let s = text(v)?.as_bytes();
    ensure(s.len() >= 17 && s.iter().all(u8::is_ascii))?;
    let digits = |x: &[u8]| -> Option<u32> {
        if !x.iter().all(u8::is_ascii_digit) {
            return None;
        }
        Some(x.iter().fold(0, |n, b| n * 10 + (b - b'0') as u32))
    };
    ensure(s[4] == b'-' && s[7] == b'-' && s[10] == b'T' && s[13] == b':')?;
    let year = digits(&s[0..4]).ok_or(())?;
    let month = digits(&s[5..7]).ok_or(())?;
    let day = digits(&s[8..10]).ok_or(())?;
    let hour = digits(&s[11..13]).ok_or(())?;
    let minute = digits(&s[14..16]).ok_or(())?;
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
    let mut p = 16;
    if s.get(p) == Some(&b':') {
        ensure(s.len() >= p + 3)?;
        ensure(digits(&s[p + 1..p + 3]).ok_or(())? <= 59)?;
        p += 3;
        if s.get(p) == Some(&b'.') {
            p += 1;
            let start = p;
            while s.get(p).is_some_and(u8::is_ascii_digit) {
                p += 1;
            }
            ensure(p > start)?;
        }
    }
    if s.get(p) == Some(&b'Z') {
        return ensure(p + 1 == s.len());
    }
    ensure(matches!(s.get(p), Some(b'+') | Some(b'-')) && p + 6 == s.len() && s[p + 3] == b':')?;
    ensure(digits(&s[p + 1..p + 3]).ok_or(())? <= 23 && digits(&s[p + 4..p + 6]).ok_or(())? <= 59)
}
fn time_field(v: &mut Value) -> Check {
    timestamp(v)
}

fn web_package_ref(v: &mut Value) -> Check {
    closed(v, &["id", "version", "digest"], &[])?;
    for field in ["id", "version"] {
        let s = text(&v[field])?;
        ensure(
            !s.is_empty()
                && s.len() <= 128
                && s.as_bytes()[0].is_ascii_alphanumeric()
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)),
        )?;
    }
    digest(&v["digest"])
}
fn data_ref(v: &mut Value, kind: &str) -> Check {
    closed(v, &["id", "kind", "versionToken"], &[])?;
    key(&mut v["id"])?;
    literal(&v["kind"], kind)?;
    key(&mut v["versionToken"])
}
fn host_stub(v: &mut Value, kind: &str) -> Check {
    let guidance = if kind == "character" {
        "characterGuidance"
    } else {
        "guidance"
    };
    closed(
        v,
        &["key", "displayName", "type", "source"],
        &["contentVersion", guidance],
    )?;
    stable_key(&mut v["key"])?;
    ensure(text(&v["key"])?.starts_with("host-local:"))?;
    display_name(&mut v["displayName"])?;
    if kind == "character" {
        one_of(
            &v["type"],
            &["magical-girl", "canshou", "general-character"],
        )?;
    } else {
        literal(&v["type"], kind)?;
    }
    literal(&v["source"], "host-local")?;
    if has(v, "contentVersion") {
        digest(&v["contentVersion"])?;
    }
    if has(v, guidance) {
        string(&mut v[guidance], 0, 100, false)?;
    }
    Ok(())
}
fn ref_or_stub(v: &mut Value, kind: &str) -> Check {
    if has(v, "source") {
        host_stub(v, kind)
    } else {
        data_ref(v, kind)
    }
}
fn online_key_matches(key: &Value, reference: &Value, allow_preset: bool) -> Check {
    let k = text(key)?;
    let id = text(&reference["id"])?;
    ensure(k == format!("data-card:{id}") || (allow_preset && k == format!("preset:{id}")))
}
fn config_entry(v: &mut Value, kind: &str) -> Check {
    if has(v, "source") {
        return host_stub(v, kind);
    }
    closed(
        v,
        &["key", "ref"],
        if kind == "character" {
            &["characterGuidance"]
        } else {
            &[]
        },
    )?;
    stable_key(&mut v["key"])?;
    data_ref(&mut v["ref"], kind)?;
    online_key_matches(&v["key"], &v["ref"], kind != "material")?;
    if has(v, "characterGuidance") {
        string(&mut v["characterGuidance"], 0, 100, false)?;
    }
    Ok(())
}
fn history_settings(v: &mut Value) -> Check {
    const FLAGS: &[&str] = &[
        "readArenaHistory",
        "isArenaHistoryUnlimited",
        "writeArenaHistory",
        "readCurrentState",
        "writeCurrentState",
        "readNarrativeHistory",
        "isNarrativeHistoryUnlimited",
        "writeNarrativeHistory",
    ];
    let mut fields = FLAGS.to_vec();
    fields.extend(["readArenaHistoryLimit", "readNarrativeHistoryLimit"]);
    closed(v, &fields, &[])?;
    for field in FLAGS {
        boolean(&v[*field])?;
    }
    for field in ["readArenaHistoryLimit", "readNarrativeHistoryLimit"] {
        integer(&mut v[field], 1, 999)?;
    }
    Ok(())
}
fn team(v: &mut Value) -> Check {
    closed(v, &["key", "displayName", "combatantKeys"], &[])?;
    key(&mut v["key"])?;
    display_name(&mut v["displayName"])?;
    array(&mut v["combatantKeys"], 0, 32, stable_key)
}
fn shared_config(v: &mut Value) -> Check {
    closed(
        v,
        &[
            "battleMode",
            "combatants",
            "teams",
            "scenario",
            "auxScenarios",
            "materials",
            "userGuidance",
            "storyLength",
            "customStoryLength",
            "selectedLanguage",
            "historySettings",
        ],
        &["reportFormat", "webPackageRef"],
    )?;
    battle_mode(&v["battleMode"])?;
    if !has(v, "reportFormat") {
        v["reportFormat"] = json!("markdown");
    }
    one_of(&v["reportFormat"], &["markdown", "web"])?;
    optional(v, "webPackageRef", web_package_ref)?;
    if has(v, "webPackageRef") {
        literal(&v["reportFormat"], "web")?;
    }
    array(&mut v["combatants"], 0, 32, |x| {
        config_entry(x, "character")
    })?;
    array(&mut v["teams"], 0, 32, team)?;
    if !v["scenario"].is_null() {
        config_entry(&mut v["scenario"], "scenario")?;
    }
    array(&mut v["auxScenarios"], 0, 256, |x| {
        config_entry(x, "scenario")
    })?;
    array(&mut v["materials"], 0, 256, |x| config_entry(x, "material"))?;
    string(&mut v["userGuidance"], 0, 200, false)?;
    story_length(&v["storyLength"])?;
    custom_length(&v["customStoryLength"])?;
    string(&mut v["selectedLanguage"], 1, 64, true)?;
    history_settings(&mut v["historySettings"])?;
    for field in ["combatants", "teams", "auxScenarios", "materials"] {
        unique_field(&v[field], "key")?;
    }
    ensure(
        v["auxScenarios"].as_array().ok_or(())?.len() + v["materials"].as_array().ok_or(())?.len()
            <= 256,
    )?;
    let known: BTreeSet<_> = v["combatants"]
        .as_array()
        .ok_or(())?
        .iter()
        .map(|x| text(&x["key"]))
        .collect::<Result<_, _>>()?;
    let mut assigned = BTreeSet::new();
    for t in v["teams"].as_array().ok_or(())? {
        for k in t["combatantKeys"].as_array().ok_or(())? {
            let k = text(k)?;
            ensure(known.contains(k) && assigned.insert(k))?;
        }
    }
    Ok(())
}
fn member(v: &mut Value) -> Check {
    closed(
        v,
        &["userId", "role", "displayName", "membershipState"],
        &["joinedAt"],
    )?;
    key(&mut v["userId"])?;
    one_of(&v["role"], &["host", "member"])?;
    display_name(&mut v["displayName"])?;
    one_of(&v["membershipState"], &["active", "revoked"])?;
    optional(v, "joinedAt", time_field)
}
fn generation_fields(v: &mut Value) -> Check {
    for f in ["generationRequestId", "generationId", "snapshotDigest"] {
        key(&mut v[f])?;
    }
    integer(&mut v["attempt"], 1, MAX_SAFE_INTEGER)?;
    integer(&mut v["configRevision"], 0, MAX_SAFE_INTEGER)?;
    boolean(&v["collaborativeInfluence"])?;
    array(&mut v["participantUserIds"], 0, 32, |v| {
        integer(v, 0, MAX_SAFE_INTEGER)
    })?;
    let mut participants = BTreeSet::new();
    for id in v["participantUserIds"].as_array().ok_or(())? {
        ensure(participants.insert(safe_u64(id)?))?;
    }
    if has(v, "hostAccountUserId") {
        integer(&mut v["hostAccountUserId"], 1, MAX_SAFE_INTEGER)?;
        ensure(participants.contains(&safe_u64(&v["hostAccountUserId"])?))?;
    }
    Ok(())
}
pub(crate) fn validate_generation_mirror(v: &mut Value) -> Result<(), ()> {
    generation_mirror(v)
}

fn generation_mirror(v: &mut Value) -> Check {
    closed(
        v,
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
    generation_fields(v)?;
    one_of(
        &v["state"],
        &["starting", "running", "completed", "failed", "cancelled"],
    )?;
    timestamp(&v["startedAt"])?;
    optional(v, "finishedAt", time_field)
}
fn proposal_id(v: &mut Value) -> Check {
    key(v)?;
    ensure(!matches!(text(v)?, "." | ".."))
}
fn resolved_status(v: &Value) -> Check {
    one_of(
        v,
        &[
            "partially_accepted",
            "accepted",
            "rejected",
            "withdrawn",
            "stale",
        ],
    )
}
fn target_matches(target: &Value, reference: &Value) -> Check {
    if has(reference, "key") {
        ensure(target == &reference["key"])
    } else {
        online_key_matches(target, reference, true)
    }
}
fn expected_present(v: &mut Value, kind: &str) -> Check {
    closed(v, &["kind", "ref"], &["key"])?;
    literal(&v["kind"], "present")?;
    if kind == "team" {
        team(&mut v["ref"])?;
    } else {
        ref_or_stub(&mut v["ref"], kind)?;
    }
    optional(v, "key", stable_key)
}
fn check_target_expected(target: &Value, expected: &Value) -> Check {
    target_matches(target, &expected["ref"])?;
    if has(expected, "key") {
        ensure(target == &expected["key"])
    } else {
        ensure(!text(target)?.starts_with("preset:"))
    }
}
fn expected_absent(v: &Value) -> Check {
    closed(v, &["kind"], &[])?;
    literal(&v["kind"], "absent")
}
fn expected_value(v: &mut Value, f: impl Fn(&mut Value) -> Check) -> Check {
    closed(v, &["kind", "value"], &[])?;
    literal(&v["kind"], "value")?;
    f(&mut v["value"])
}
fn proposed_ref_key(v: &Value, allow_preset: bool) -> Check {
    if v["ref"].is_null() {
        return ensure(!has(v, "key"));
    }
    if has(v, "key") {
        online_key_matches(&v["key"], &v["ref"], allow_preset)
    } else {
        Ok(())
    }
}
fn change_shape(v: &Value, required: &[&str], optional: &[&str]) -> Check {
    let mut req = vec!["type", "changeId", "expectedBase"];
    req.extend_from_slice(required);
    let mut opt = vec!["dependsOn", "atomicGroupId"];
    opt.extend_from_slice(optional);
    closed(v, &req, &opt)
}
fn proposal_change(v: &mut Value) -> Check {
    let kind = text(&v["type"])?.to_owned();
    match kind.as_str() {
        "addCombatant" | "addAuxScenario" | "addMaterial" => {
            change_shape(v, &["ref"], &["key"])?;
            let ref_kind = match kind.as_str() {
                "addCombatant" => "character",
                "addMaterial" => "material",
                _ => "scenario",
            };
            data_ref(&mut v["ref"], ref_kind)?;
            optional(v, "key", stable_key)?;
            proposed_ref_key(v, ref_kind != "material")?;
            expected_absent(&v["expectedBase"])?;
        }
        "removeCombatant" | "removeAuxScenario" | "removeMaterial" => {
            let (target, ref_kind) = match kind.as_str() {
                "removeCombatant" => ("combatantKey", "character"),
                "removeMaterial" => ("materialKey", "material"),
                _ => ("scenarioKey", "scenario"),
            };
            change_shape(v, &[target], &[])?;
            stable_key(&mut v[target])?;
            expected_present(&mut v["expectedBase"], ref_kind)?;
            check_target_expected(&v[target], &v["expectedBase"])?;
            if ref_kind == "material" {
                ensure(!text(&v[target])?.starts_with("preset:"))?;
            }
        }
        "setCharacterGuidance" => {
            change_shape(v, &["combatantKey", "value"], &[])?;
            stable_key(&mut v["combatantKey"])?;
            nullable(&mut v["value"], |v| string(v, 0, 100, false))?;
            expected_value(&mut v["expectedBase"], |v| {
                nullable(v, |v| string(v, 0, 100, false))
            })?;
        }
        "assignTeam" => {
            change_shape(v, &["combatantKey", "teamKey"], &[])?;
            stable_key(&mut v["combatantKey"])?;
            nullable(&mut v["teamKey"], key)?;
            expected_value(&mut v["expectedBase"], |v| nullable(v, key))?;
        }
        "addTeam" => {
            change_shape(v, &["teamKey", "displayName"], &[])?;
            key(&mut v["teamKey"])?;
            display_name(&mut v["displayName"])?;
            expected_absent(&v["expectedBase"])?;
        }
        "removeTeam" => {
            change_shape(v, &["teamKey"], &[])?;
            key(&mut v["teamKey"])?;
            expected_present(&mut v["expectedBase"], "team")?;
            ensure(v["teamKey"] == v["expectedBase"]["ref"]["key"])?;
        }
        "renameTeam" => {
            change_shape(v, &["teamKey", "value"], &[])?;
            key(&mut v["teamKey"])?;
            display_name(&mut v["value"])?;
            expected_value(&mut v["expectedBase"], display_name)?;
        }
        "reorderCombatants"
        | "reorderTeams"
        | "reorderTeamCombatants"
        | "reorderAuxScenarios"
        | "reorderMaterials" => {
            let grouped = kind == "reorderTeamCombatants";
            change_shape(
                v,
                if grouped {
                    &["teamKey", "value"]
                } else {
                    &["value"]
                },
                &[],
            )?;
            if grouped {
                key(&mut v["teamKey"])?;
            }
            let min = usize::from(kind == "reorderCombatants");
            let max = if kind == "reorderAuxScenarios" || kind == "reorderMaterials" {
                256
            } else {
                32
            };
            let f = if kind == "reorderTeams" {
                key
            } else {
                stable_key
            };
            array(&mut v["value"], min, max, f)?;
            expected_value(&mut v["expectedBase"], |v| array(v, min, max, f))?;
            unique_strings(&v["value"])?;
            unique_strings(&v["expectedBase"]["value"])?;
            let a = v["value"].as_array().ok_or(())?;
            let b = v["expectedBase"]["value"].as_array().ok_or(())?;
            ensure(a != b && a.len() == b.len() && a.iter().all(|x| b.contains(x)))?;
        }
        "setReportFormat"
        | "setBattleMode"
        | "setSelectedLanguage"
        | "setUserGuidance"
        | "setHistorySettings"
        | "setWebPackageRef" => {
            change_shape(v, &["value"], &[])?;
            let f = |x: &mut Value| match kind.as_str() {
                "setReportFormat" => one_of(x, &["markdown", "web"]),
                "setBattleMode" => battle_mode(x),
                "setSelectedLanguage" => string(x, 1, 64, true),
                "setUserGuidance" => string(x, 0, 200, false),
                "setHistorySettings" => history_settings(x),
                _ => nullable(x, web_package_ref),
            };
            f(&mut v["value"])?;
            expected_value(&mut v["expectedBase"], f)?;
        }
        "setScenario" => {
            change_shape(v, &["ref"], &["key"])?;
            if !v["ref"].is_null() {
                data_ref(&mut v["ref"], "scenario")?;
            }
            optional(v, "key", stable_key)?;
            proposed_ref_key(v, true)?;
            let expected = &mut v["expectedBase"];
            closed(expected, &["kind", "ref"], &["key"])?;
            literal(&expected["kind"], "ref")?;
            if !expected["ref"].is_null() {
                ref_or_stub(&mut expected["ref"], "scenario")?;
            }
            optional(expected, "key", stable_key)?;
            if has(expected, "key") {
                target_matches(&expected["key"], &expected["ref"])?;
            }
        }
        "setStoryLength" => {
            change_shape(v, &["value"], &["customStoryLength"])?;
            story_length(&v["value"])?;
            if has(v, "customStoryLength") {
                custom_length(&v["customStoryLength"])?;
            }
            expected_value(&mut v["expectedBase"], |v| {
                closed(v, &["storyLength", "customStoryLength"], &[])?;
                story_length(&v["storyLength"])?;
                custom_length(&v["customStoryLength"])
            })?;
        }
        _ => return Err(()),
    }
    key(&mut v["changeId"])?;
    optional(v, "atomicGroupId", key)?;
    if has(v, "dependsOn") {
        array(&mut v["dependsOn"], 0, 32, key)?;
        unique_strings(&v["dependsOn"])?;
    }
    Ok(())
}
fn proposal(v: &mut Value) -> Check {
    closed(
        v,
        &[
            "proposalVersion",
            "proposalId",
            "roomId",
            "authorUserId",
            "baseRevision",
            "status",
            "changes",
            "createdAt",
        ],
        &["updatedAt"],
    )?;
    version(&mut v["proposalVersion"])?;
    proposal_id(&mut v["proposalId"])?;
    key(&mut v["roomId"])?;
    key(&mut v["authorUserId"])?;
    integer(&mut v["baseRevision"], 0, MAX_SAFE_INTEGER)?;
    if v["status"] != "submitted" {
        resolved_status(&v["status"])?;
    }
    proposal_changes(&mut v["changes"])?;
    timestamp(&v["createdAt"])?;
    optional(v, "updatedAt", time_field)?;
    ensure(byte_len(v)? <= MAX_WEBSOCKET_BYTES)
}
fn proposal_changes(v: &mut Value) -> Check {
    array(v, 1, 32, proposal_change)?;
    unique_field(v, "changeId")?;
    let changes = v.as_array().ok_or(())?;
    let mut graph = BTreeMap::<&str, Vec<&str>>::new();
    for c in changes {
        let deps = c
            .get("dependsOn")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(text).collect::<Result<Vec<_>, _>>())
            .transpose()?
            .unwrap_or_default();
        graph.insert(text(&c["changeId"])?, deps);
    }
    for (id, deps) in &graph {
        for dep in deps {
            ensure(id != dep && graph.contains_key(dep))?;
        }
    }
    fn visit<'a>(
        id: &'a str,
        graph: &BTreeMap<&'a str, Vec<&'a str>>,
        path: &mut BTreeSet<&'a str>,
        done: &mut BTreeSet<&'a str>,
    ) -> Check {
        if done.contains(id) {
            return Ok(());
        }
        ensure(path.insert(id))?;
        for dep in &graph[id] {
            visit(dep, graph, path, done)?;
        }
        path.remove(id);
        done.insert(id);
        Ok(())
    }
    let mut done = BTreeSet::new();
    for id in graph.keys() {
        visit(id, &graph, &mut BTreeSet::new(), &mut done)?;
    }
    Ok(())
}

fn snapshot(v: &mut Value) -> Check {
    closed(
        v,
        &[
            "protocolVersion",
            "schemaVersion",
            "roomId",
            "roomEpoch",
            "controlSeq",
            "revision",
            "sharedConfig",
            "members",
            "activeGeneration",
        ],
        &["proposals"],
    )?;
    version(&mut v["protocolVersion"])?;
    version(&mut v["schemaVersion"])?;
    key(&mut v["roomId"])?;
    key(&mut v["roomEpoch"])?;
    integer(&mut v["controlSeq"], 0, MAX_SAFE_INTEGER)?;
    integer(&mut v["revision"], 0, MAX_SAFE_INTEGER)?;
    shared_config(&mut v["sharedConfig"])?;
    array(&mut v["members"], 0, 32, member)?;
    unique_field(&v["members"], "userId")?;
    if !has(v, "proposals") {
        v["proposals"] = json!([]);
    }
    array(&mut v["proposals"], 0, 256, proposal)?;
    unique_field(&v["proposals"], "proposalId")?;
    nullable(&mut v["activeGeneration"], generation_mirror)?;
    let members = v["members"].as_array().ok_or(())?;
    ensure(
        members
            .iter()
            .filter(|m| m["role"] == "host" && m["membershipState"] == "active")
            .count()
            == 1,
    )?;
    let ids: BTreeSet<_> = members
        .iter()
        .map(|m| text(&m["userId"]))
        .collect::<Result<_, _>>()?;
    let mut pending = BTreeMap::<&str, usize>::new();
    for p in v["proposals"].as_array().ok_or(())? {
        ensure(p["roomId"] == v["roomId"] && ids.contains(text(&p["authorUserId"])?))?;
        if p["status"] == "submitted" {
            let count = pending.entry(text(&p["authorUserId"])?).or_default();
            *count += 1;
            ensure(*count <= 8)?;
        }
    }
    Ok(())
}
fn session(v: &mut Value) -> Check {
    closed(
        v,
        &["protocolVersion", "roomId", "roomEpoch", "self", "snapshot"],
        &[],
    )?;
    version(&mut v["protocolVersion"])?;
    key(&mut v["roomId"])?;
    key(&mut v["roomEpoch"])?;
    member(&mut v["self"])?;
    snapshot(&mut v["snapshot"])?;
    ensure(v["roomId"] == v["snapshot"]["roomId"] && v["roomEpoch"] == v["snapshot"]["roomEpoch"])?;
    let current = v["snapshot"]["members"]
        .as_array()
        .ok_or(())?
        .iter()
        .find(|m| m["userId"] == v["self"]["userId"])
        .ok_or(())?;
    ensure(current["membershipState"] == "active" && current == &v["self"])
}
fn directory_entry(v: &mut Value) -> Check {
    closed(
        v,
        &[
            "roomId",
            "title",
            "visibility",
            "status",
            "createdAt",
            "lastActivityAt",
        ],
        &["hostDisplayName", "memberCount", "memberLimit"],
    )?;
    key(&mut v["roomId"])?;
    string(&mut v["title"], 1, 80, true)?;
    one_of(&v["visibility"], &["public", "unlisted"])?;
    literal(&v["status"], "open")?;
    timestamp(&v["createdAt"])?;
    timestamp(&v["lastActivityAt"])?;
    optional(v, "hostDisplayName", display_name)?;
    for f in ["memberCount", "memberLimit"] {
        if has(v, f) {
            integer(&mut v[f], 1, 32)?;
        }
    }
    Ok(())
}
fn directory_page(v: &mut Value) -> Check {
    closed(v, &["items", "nextCursor"], &[])?;
    array(&mut v["items"], 0, 50, directory_entry)?;
    if !v["nextCursor"].is_null() {
        cursor(&v["nextCursor"])?;
    }
    Ok(())
}
fn reconnect(v: &mut Value) -> Check {
    closed(v, &[], &["control", "story"])?;
    if has(v, "control") {
        let c = &mut v["control"];
        closed(c, &["roomEpoch", "controlSeq"], &[])?;
        key(&mut c["roomEpoch"])?;
        integer(&mut c["controlSeq"], 0, MAX_SAFE_INTEGER)?;
    }
    if has(v, "story") {
        let s = &mut v["story"];
        closed(s, &["generationId", "chunkSeq"], &[])?;
        key(&mut s["generationId"])?;
        integer(&mut s["chunkSeq"], 0, MAX_SAFE_INTEGER)?;
    }
    Ok(())
}
fn ticket_result(v: &mut Value) -> Check {
    closed(
        v,
        &["protocolVersion", "ticket", "expiresInSeconds", "websocket"],
        &[],
    )?;
    version(&mut v["protocolVersion"])?;
    // Count the ORIGINAL UTF-8 token before the legacy ticket trim normalization.
    ensure(text(&v["ticket"])?.len() <= MAX_TICKET_BYTES)?;
    string(&mut v["ticket"], 1, MAX_TICKET_BYTES, true)?;
    integer(&mut v["expiresInSeconds"], 1, 60)?;
    closed(&v["websocket"], &["path", "protocol"], &[])?;
    literal(&v["websocket"]["path"], WEBSOCKET_PATH)?;
    literal(&v["websocket"]["protocol"], WEBSOCKET_PROTOCOL)
}
fn leave_result(v: &mut Value) -> Check {
    closed(v, &["protocolVersion", "roomId", "outcome"], &[])?;
    version(&mut v["protocolVersion"])?;
    key(&mut v["roomId"])?;
    one_of(&v["outcome"], &["left", "closed"])
}
fn generation_cancel_result(v: &mut Value) -> Check {
    closed(
        v,
        &[
            "protocolVersion",
            "roomId",
            "roomEpoch",
            "generation",
            "status",
        ],
        &[],
    )?;
    version(&mut v["protocolVersion"])?;
    key(&mut v["roomId"])?;
    key(&mut v["roomEpoch"])?;
    generation_mirror(&mut v["generation"])?;
    let expected = match text(&v["status"])? {
        "reserved" => "starting",
        "running" | "finalizing" => "running",
        "producer_lost" | "failed" => "failed",
        "completed" => "completed",
        "cancelled" => "cancelled",
        _ => return Err(()),
    };
    literal(&v["generation"]["state"], expected)
}

fn proposal_result(operation: Operation, v: &mut Value) -> Check {
    closed(
        v,
        &[
            "protocolVersion",
            "roomId",
            "roomEpoch",
            "controlSeq",
            "revision",
            "proposalId",
            "status",
            "result",
        ],
        &["sharedConfig", "snapshot"],
    )?;
    version(&mut v["protocolVersion"])?;
    key(&mut v["roomId"])?;
    key(&mut v["roomEpoch"])?;
    integer(&mut v["controlSeq"], 0, MAX_SAFE_INTEGER)?;
    integer(&mut v["revision"], 0, MAX_SAFE_INTEGER)?;
    proposal_id(&mut v["proposalId"])?;
    one_of(&v["result"], &["applied", "idempotent"])?;
    match operation {
        Operation::ProposalSubmit => literal(&v["status"], "submitted")?,
        Operation::ProposalWithdraw => {
            literal(&v["status"], "withdrawn")?;
            literal(&v["result"], "applied")?;
        }
        Operation::ProposalResolve => {
            one_of(
                &v["status"],
                &["accepted", "partially_accepted", "rejected"],
            )?;
            literal(&v["result"], "applied")?;
            ensure(has(v, "sharedConfig") && has(v, "snapshot"))?;
        }
        _ => return Err(()),
    }
    optional(v, "sharedConfig", shared_config)?;
    if has(v, "snapshot") {
        snapshot(&mut v["snapshot"])?;
        for field in ["roomId", "roomEpoch", "revision", "controlSeq"] {
            ensure(v[field] == v["snapshot"][field])?;
        }
    }
    if operation == Operation::ProposalResolve {
        ensure(v["sharedConfig"] == v["snapshot"]["sharedConfig"])?;
    }
    Ok(())
}
fn original_request(operation: Operation, v: &mut Value) -> Check {
    bounded(v, MAX_ORIGINAL_REQUEST_BYTES)?;
    match operation {
        Operation::Create => {
            closed(
                v,
                &[
                    "creationRequestId",
                    "displayName",
                    "directory",
                    "sharedConfig",
                ],
                &[],
            )?;
            id(&mut v["creationRequestId"], 8)?;
            display_name(&mut v["displayName"])?;
            closed(&v["directory"], &["title", "visibility"], &[])?;
            string(&mut v["directory"]["title"], 1, 80, true)?;
            one_of(&v["directory"]["visibility"], &["public", "unlisted"])?;
            shared_config(&mut v["sharedConfig"])
        }
        Operation::Join => {
            closed(v, &["displayName"], &[])?;
            display_name(&mut v["displayName"])
        }
        Operation::Config => {
            closed(
                v,
                &[
                    "expectedRoomEpoch",
                    "expectedRevision",
                    "expectedControlSeq",
                    "sharedConfig",
                ],
                &[],
            )?;
            key(&mut v["expectedRoomEpoch"])?;
            integer(&mut v["expectedRevision"], 0, MAX_SAFE_INTEGER)?;
            integer(&mut v["expectedControlSeq"], 0, MAX_SAFE_INTEGER)?;
            shared_config(&mut v["sharedConfig"])
        }
        Operation::ProposalSubmit => {
            closed(
                v,
                &["proposalId", "expectedRoomEpoch", "baseRevision", "changes"],
                &[],
            )?;
            desktop_path_id(&v["proposalId"])?;
            key(&mut v["expectedRoomEpoch"])?;
            integer(&mut v["baseRevision"], 0, MAX_SAFE_INTEGER)?;
            proposal_changes(&mut v["changes"])
        }
        Operation::ProposalResolve => {
            closed(
                v,
                &["expectedRoomEpoch", "resolution"],
                &["expectedRevision", "selectedChangeIds", "overrideChangeIds"],
            )?;
            key(&mut v["expectedRoomEpoch"])?;
            if has(v, "expectedRevision") {
                integer(&mut v["expectedRevision"], 0, MAX_SAFE_INTEGER)?;
            }
            one_of(&v["resolution"], &["accept-selected", "reject"])?;
            if has(v, "selectedChangeIds") {
                ensure(v["resolution"] != "reject")?;
                array(&mut v["selectedChangeIds"], 0, 32, key)?;
            }
            if has(v, "overrideChangeIds") {
                ensure(v["resolution"] != "reject")?;
                array(&mut v["overrideChangeIds"], 0, 32, key)?;
                unique_strings(&v["overrideChangeIds"])?;
                let overrides = v["overrideChangeIds"].as_array().ok_or(())?;
                ensure(overrides.is_empty() || has(v, "expectedRevision"))?;
                for id in overrides {
                    ensure(
                        v["selectedChangeIds"]
                            .as_array()
                            .is_some_and(|selected| selected.contains(id)),
                    )?;
                }
            }
            Ok(())
        }
        Operation::Ticket => {
            closed(v, &[], &["reconnect"])?;
            optional(v, "reconnect", reconnect)
        }
        Operation::Leave
        | Operation::Close
        | Operation::ProposalWithdraw
        | Operation::GenerationCancel => {
            closed(v, &["expectedRoomEpoch"], &[])?;
            key(&mut v["expectedRoomEpoch"])
        }
        _ => Err(()),
    }
}

pub(crate) fn validate_discover_query(raw: &Value) -> Result<Value, RoomError> {
    bounded(raw, MAX_IPC_REQUEST_BYTES).map_err(|_| invalid_request())?;
    let mut value = raw.clone();
    let mut validate = || -> Check {
        closed(&value, &[], &["cursor", "limit"])?;
        if has(&value, "cursor") {
            cursor(&value["cursor"])?;
        }
        if !has(&value, "limit") {
            value["limit"] = json!(20);
        }
        integer(&mut value["limit"], 1, 50)
    };
    validate().map_err(|_| invalid_request())?;
    Ok(value)
}
pub(crate) fn validate_service_request(
    operation: Operation,
    raw: &Value,
    expected_user_id: u64,
) -> Result<Value, RoomError> {
    bounded(raw, MAX_REQUEST_BYTES).map_err(|_| invalid_request())?;
    let mut value = raw.clone();
    let mut validate = || -> Check {
        ensure(
            expected_user_id > 0 && expected_user_id <= MAX_SAFE_INTEGER && operation.is_post(),
        )?;
        closed(&value, &["desktopRoom", "request"], &[])?;
        let meta = &mut value["desktopRoom"];
        closed(
            meta,
            if operation == Operation::Create {
                &["version", "expectedUserId", "createMode"]
            } else {
                &["version", "expectedUserId"]
            },
            if operation == Operation::GenerationCancel {
                &["cancelMode"]
            } else {
                &[]
            },
        )?;
        literal(&meta["version"], PROTOCOL_VERSION)?;
        integer(&mut meta["expectedUserId"], 1, MAX_SAFE_INTEGER)?;
        ensure(safe_u64(&meta["expectedUserId"])? == expected_user_id)?;
        if operation == Operation::Create {
            one_of(&meta["createMode"], &["new", "resume-only"])?;
        }
        if operation == Operation::GenerationCancel && has(meta, "cancelMode") {
            literal(&meta["cancelMode"], "starting-v1")?;
            let body = &mut value["request"];
            bounded(body, MAX_ORIGINAL_REQUEST_BYTES)?;
            closed(body, &["expectedRoomEpoch", "expectedGeneration"], &[])?;
            key(&mut body["expectedRoomEpoch"])?;
            let generation = &mut body["expectedGeneration"];
            closed(
                generation,
                &[
                    "generationRequestId",
                    "generationId",
                    "attempt",
                    "configRevision",
                    "snapshotDigest",
                    "collaborativeInfluence",
                    "participantUserIds",
                ],
                &["hostAccountUserId"],
            )?;
            generation_fields(generation)?;
            bounded(body, MAX_ORIGINAL_REQUEST_BYTES)?;
        } else {
            original_request(operation, &mut value["request"])?;
        }
        bounded(&value, MAX_REQUEST_BYTES)
    };
    validate().map_err(|_| invalid_request())?;
    Ok(value)
}
fn status_matches(code: &str, status: u16) -> bool {
    let expected = match code {
        "ROOM_AUTHENTICATION_REQUIRED" => 401,
        "ROOM_AUTHENTICATION_DENIED" | "ROOM_FORBIDDEN" | "ROOM_REFERENCE_DENIED" => 403,
        "ROOM_NOT_FOUND" => 404,
        "ROOM_CONFLICT"
        | "ROOM_GENERATION_COMBATANTS_EMPTY"
        | "ROOM_GENERATION_COMBATANTS_INSUFFICIENT"
        | "ROOM_GENERATION_SCENARIO_REQUIRED"
        | "ROOM_GENERATION_RANDOM_COMBATANT_UNRESOLVED"
        | "ROOM_GENERATION_RECONCILIATION_REQUIRED"
        | "ROOM_MEMBER_LIMIT_REACHED"
        | "ROOM_PROPOSAL_PENDING_LIMIT_REACHED"
        | "ROOM_HOST_LOCAL_DIGEST_MISMATCH"
        | "ROOM_HOST_LOCAL_CONTENT_VERSION_MISMATCH"
        | "ROOM_REFERENCE_STALE"
        | "ROOM_DESKTOP_OWNER_MISMATCH" => 409,
        "ROOM_PAYLOAD_TOO_LARGE"
        | "ROOM_PROPOSAL_BYTE_LIMIT"
        | "ROOM_CONFIG_FRAME_TOO_LARGE"
        | "ROOM_RUNTIME_BODY_LIMIT" => 413,
        "ROOM_RATE_LIMITED" => 429,
        "ROOM_UNAVAILABLE" => 503,
        "ROOM_DESKTOP_RESPONSE_TOO_LARGE" | "ROOM_DESKTOP_RESPONSE_INVALID" => 502,
        _ => 400,
    };
    status == expected
}
fn service_error(operation: Operation, status: u16, v: &mut Value, expected_user_id: u64) -> Check {
    closed(v, &["desktopRoom", "error"], &[])?;
    closed(&v["desktopRoom"], &["version", "viewerUserId"], &[])?;
    literal(&v["desktopRoom"]["version"], PROTOCOL_VERSION)?;
    let unpaired = v["desktopRoom"]["viewerUserId"].is_null();
    if !unpaired {
        integer(&mut v["desktopRoom"]["viewerUserId"], 1, MAX_SAFE_INTEGER)?;
        ensure(safe_u64(&v["desktopRoom"]["viewerUserId"])? == expected_user_id)?;
    }
    let error = &mut v["error"];
    closed(
        error,
        &["code", "message", "outcome"],
        &["retryAfterSeconds"],
    )?;
    one_of(&error["code"], SERVER_CODES)?;
    string(&mut error["message"], 1, 200, true)?;
    one_of(
        &error["outcome"],
        &["not-applied", "unknown", "not-applicable"],
    )?;
    let outcome = text(&error["outcome"])?;
    ensure(if operation.is_post() {
        outcome != "not-applicable"
    } else {
        outcome == "not-applicable"
    })?;
    let code = text(&error["code"])?;
    ensure(status_matches(code, status))?;
    let must_unpair = matches!(
        code,
        "ROOM_AUTHENTICATION_REQUIRED"
            | "ROOM_AUTHENTICATION_DENIED"
            | "ROOM_DESKTOP_OWNER_MISMATCH"
    );
    if unpaired {
        ensure(
            matches!(
                code,
                "ROOM_AUTHENTICATION_REQUIRED"
                    | "ROOM_AUTHENTICATION_DENIED"
                    | "ROOM_DESKTOP_PROTOCOL_INVALID"
                    | "ROOM_DESKTOP_OWNER_MISMATCH"
                    | "ROOM_DESKTOP_OPERATION_UNSUPPORTED"
                    | "ROOM_FORBIDDEN"
                    | "ROOM_UNAVAILABLE"
                    | "ROOM_REQUEST_INVALID"
                    | "ROOM_PAYLOAD_TOO_LARGE"
                    | "ROOM_DESKTOP_RESPONSE_INVALID"
            ) && outcome != "unknown",
        )?;
    } else {
        ensure(!must_unpair)?;
    }
    if has(error, "retryAfterSeconds") {
        integer(&mut error["retryAfterSeconds"], 1, 86_400)?;
    }
    Ok(())
}
/// The caller still owns room/epoch scope binding and conditional auth cleanup.
/// The returned service error is the closed negotiated DTO, not a local error.
pub(crate) fn validate_http_response(
    operation: Operation,
    status: u16,
    raw: &[u8],
    expected_user_id: u64,
) -> Result<Value, RoomError> {
    let outcome = operation.rejected_outcome();
    let mut value = decode(raw, MAX_RESPONSE_BYTES, outcome)?;
    let mut validate = || -> Check {
        ensure(expected_user_id > 0 && expected_user_id <= MAX_SAFE_INTEGER)?;
        if has(&value, "error") {
            return service_error(operation, status, &mut value, expected_user_id);
        }
        ensure(
            status
                == if operation == Operation::Create {
                    201
                } else if operation == Operation::GenerationStart {
                    202
                } else {
                    200
                },
        )?;
        closed(&value, &["desktopRoom", "result"], &[])?;
        closed(&value["desktopRoom"], &["version", "viewerUserId"], &[])?;
        literal(&value["desktopRoom"]["version"], PROTOCOL_VERSION)?;
        integer(
            &mut value["desktopRoom"]["viewerUserId"],
            1,
            MAX_SAFE_INTEGER,
        )?;
        ensure(safe_u64(&value["desktopRoom"]["viewerUserId"])? == expected_user_id)?;
        match operation {
            Operation::GenerationCancel | Operation::GenerationStart => {
                generation_cancel_result(&mut value["result"])
            }
            Operation::GenerationRead => Err(()), // 大原件仅由借用式专用解析器接收
            Operation::Discover => directory_page(&mut value["result"]),
            Operation::Create | Operation::Join | Operation::Session | Operation::Config => {
                session(&mut value["result"])
            }
            Operation::Ticket => ticket_result(&mut value["result"]),
            Operation::ProposalSubmit
            | Operation::ProposalWithdraw
            | Operation::ProposalResolve => proposal_result(operation, &mut value["result"]),
            Operation::Leave | Operation::Close => leave_result(&mut value["result"]),
        }?;
        // Defaults can add bytes; the output also needs the complete wire budget.
        bounded(&value, MAX_RESPONSE_BYTES)
    };
    validate().map_err(|_| RoomError::new("invalid-response", outcome))?;
    Ok(value)
}
pub(crate) fn parse_ticket(response: &Value) -> Result<RoomTicket, RoomError> {
    bounded(response, MAX_RESPONSE_BYTES)
        .map_err(|_| RoomError::new("invalid-response", "unknown"))?;
    // Tickets can only be extracted from the negotiated success envelope.
    let mut result = response
        .get("result")
        .cloned()
        .ok_or_else(|| RoomError::new("invalid-response", "unknown"))?;
    let check = || -> Check {
        bounded(response, MAX_RESPONSE_BYTES)?;
        closed(response, &["desktopRoom", "result"], &[])?;
        closed(&response["desktopRoom"], &["version", "viewerUserId"], &[])?;
        literal(&response["desktopRoom"]["version"], PROTOCOL_VERSION)?;
        ensure(safe_u64(&response["desktopRoom"]["viewerUserId"])? > 0)
    };
    check()
        .and_then(|_| ticket_result(&mut result))
        .map_err(|_| RoomError::new("invalid-response", "unknown"))?;
    Ok(RoomTicket {
        token: text(&result["ticket"])
            .map_err(|_| RoomError::new("invalid-response", "unknown"))?
            .to_owned(),
        expires_in_seconds: safe_u64(&result["expiresInSeconds"])
            .map_err(|_| RoomError::new("invalid-response", "unknown"))?,
    })
}

pub(crate) fn parse_attach(raw: &Value) -> Result<AttachRequest, RoomError> {
    bounded(raw, MAX_IPC_REQUEST_BYTES).map_err(|_| invalid_request())?;
    let mut v = raw.clone();
    let mut check = || -> Check {
        closed(
            &v,
            &["documentNonce", "attachIntent", "expectedUserId"],
            &[],
        )?;
        let nonce = text(&v["documentNonce"])?;
        ensure(
            nonce.len() == 64
                && nonce
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
        )?;
        integer(&mut v["attachIntent"], 1, MAX_SAFE_INTEGER)?;
        integer(&mut v["expectedUserId"], 1, MAX_SAFE_INTEGER)
    };
    check().map_err(|_| invalid_request())?;
    Ok(AttachRequest {
        document_nonce: v["documentNonce"].as_str().unwrap().to_owned(),
        attach_intent: v["attachIntent"].as_u64().unwrap(),
        expected_user_id: v["expectedUserId"].as_u64().unwrap(),
    })
}
pub(crate) fn parse_subscribe(raw: &Value) -> Result<SubscribeRequest, RoomError> {
    bounded(raw, MAX_IPC_REQUEST_BYTES).map_err(|_| invalid_request())?;
    let mut v = raw.clone();
    let mut check = || -> Check {
        closed(&v, &["handle", "roomId", "expectedRoomEpoch"], &[])?;
        id(&mut v["handle"], 1)?;
        key(&mut v["roomId"])?;
        key(&mut v["expectedRoomEpoch"])
    };
    check().map_err(|_| invalid_request())?;
    Ok(SubscribeRequest {
        handle: v["handle"].as_str().unwrap().to_owned(),
        room_id: v["roomId"].as_str().unwrap().to_owned(),
        expected_room_epoch: v["expectedRoomEpoch"].as_str().unwrap().to_owned(),
    })
}
pub(crate) fn parse_detach(raw: &Value) -> Result<String, RoomError> {
    bounded(raw, MAX_IPC_REQUEST_BYTES)
        .and_then(|_| closed(raw, &["handle"], &[]))
        .map_err(|_| invalid_request())?;
    let mut handle = raw["handle"].clone();
    id(&mut handle, 1).map_err(|_| invalid_request())?;
    Ok(handle.as_str().unwrap().to_owned())
}
/// A bounded serializer counts the complete JSON without allocating another full wire.
fn json_size<T: Serialize>(value: &T, limit: usize) -> Result<usize, ()> {
    struct Counter {
        size: usize,
        limit: usize,
    }
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.size = self
                .size
                .checked_add(bytes.len())
                .filter(|size| *size <= self.limit)
                .ok_or_else(|| std::io::Error::other("JSON budget"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter { size: 0, limit };
    serde_json::to_writer(&mut counter, value).map_err(|_| ())?;
    Ok(counter.size)
}

/// The only large-input parser. Move the DTO; never use generic Action's clone path.
pub(crate) struct GenerationStartInput {
    pub(crate) preset: Option<crate::hosted_preset::PreparedPreset>,
    pub(crate) handle: String,
    pub(crate) room_id: String,
    pub(crate) request: Value,
}
pub(crate) const MAX_START_JSON_NODES: usize = 100_000;
const MAX_START_VALUE_NODES: usize = 10_000;
// Counts the original DTO root, every container and scalar, never keys. No
// breadth-sized temporary stack/children array is allocated for dense input.
fn start_nodes(value: &Value, mut limit: usize) -> Result<(), RoomError> {
    fn visit(value: &Value, depth: usize, remaining: &mut usize) -> Result<(), RoomError> {
        if depth > 64 {
            return Err(invalid_request());
        }
        if *remaining == 0 {
            return Err(RoomError::new("input-too-complex", "not-applied"));
        }
        *remaining -= 1;
        match value {
            Value::Array(values) => {
                for value in values {
                    visit(value, depth + 1, remaining)?;
                }
            }
            Value::Object(values) => {
                for value in values.values() {
                    visit(value, depth + 1, remaining)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    visit(value, 0, &mut limit)
}
fn start_complexity(value: &Value) -> Result<(), RoomError> {
    start_nodes(value, MAX_START_JSON_NODES)?;
    if let Some(payloads) = value["hostLocalPayloads"].as_array() {
        for entry in payloads {
            start_nodes(&entry["payload"], MAX_START_VALUE_NODES)?;
        }
    }
    for field in [
        "narrativeHistory",
        "adjudicationEvents",
        "questionnaireSelections",
        "questionnaires",
    ] {
        if let Some(value) = value["generation"].get(field) {
            start_nodes(value, MAX_START_VALUE_NODES)?;
        }
    }
    Ok(())
}
pub(crate) fn parse_generation_start_owned(
    mut raw: Value,
) -> Result<GenerationStartInput, RoomError> {
    #[derive(Serialize)]
    struct Invoke<'a> {
        request: &'a Value,
    }
    // Reject selection siblings before walking/serializing the large business DTO.
    let preset = raw["request"]
        .get("presetConfig")
        .map(|value| {
            start_nodes(value, 128)?;
            bounded(value, 10 * 1024).map_err(|_| invalid_request())?;
            let config: crate::hosted_preset::HostedPresetConfig =
                serde_json::from_value(value.clone()).map_err(|_| invalid_request())?;
            if crate::provider_target::normalize_model_id(&config.model_id)
                .is_ok_and(|id| id == "__custom_model_id__")
            {
                return Err(invalid_request());
            }
            crate::hosted_preset::PreparedPreset::validate(&config).map_err(|_| invalid_request())
        })
        .transpose()?;
    start_complexity(&raw["request"]["request"])?;
    json_size(&Invoke { request: &raw }, MAX_START_IPC_REQUEST_BYTES)
        .map_err(|_| invalid_request())?;
    bounded(&raw, MAX_START_IPC_REQUEST_BYTES).map_err(|_| invalid_request())?;
    let mut validate = || -> Check {
        closed(&raw, &["handle", "request"], &[])?;
        id(&mut raw["handle"], 1)?;
        let action = &mut raw["request"];
        closed(action, &["kind", "roomId", "request"], &["presetConfig"])?;
        literal(&action["kind"], "generation-start")?;
        desktop_path_id(&action["roomId"])?;
        generation_start_request(&mut action["request"])
    };
    validate().map_err(|_| invalid_request())?;
    let handle = raw["handle"].as_str().unwrap().to_owned();
    let room_id = raw["request"]["roomId"].as_str().unwrap().to_owned();
    let request = raw["request"]
        .as_object_mut()
        .unwrap()
        .remove("request")
        .unwrap();
    Ok(GenerationStartInput {
        preset,
        handle,
        room_id,
        request,
    })
}
fn generation_start_request(value: &mut Value) -> Check {
    bounded(value, MAX_START_ORIGINAL_REQUEST_BYTES)?;
    closed(
        value,
        &[
            "expectedRoomEpoch",
            "expectedRevision",
            "expectedControlSeq",
            "generationRequestId",
            "sharedConfig",
            "hostLocalPayloads",
            "generation",
        ],
        &[],
    )?;
    key(&mut value["expectedRoomEpoch"])?;
    integer(&mut value["expectedRevision"], 0, MAX_SAFE_INTEGER)?;
    integer(&mut value["expectedControlSeq"], 0, MAX_SAFE_INTEGER)?;
    id(&mut value["generationRequestId"], 8)?;
    shared_config(&mut value["sharedConfig"])?;
    array(&mut value["hostLocalPayloads"], 0, 289, |entry| {
        closed(entry, &["key", "kind", "payload"], &[])?;
        stable_key(&mut entry["key"])?;
        ensure(text(&entry["key"])?.starts_with("host-local:"))?;
        one_of(&entry["kind"], &["character", "scenario", "material"])?;
        ensure(entry["payload"].is_object())
    })?;
    unique_field(&value["hostLocalPayloads"], "key")?;
    closed(
        &value["generation"],
        &[],
        &[
            "arenaFreeRankingEnabled",
            "isDowngrade",
            "narrativeHistory",
            "adjudicationEvents",
            "questionnaireSelections",
            "questionnaires",
        ],
    )?;
    for field in ["arenaFreeRankingEnabled", "isDowngrade"] {
        if has(&value["generation"], field) {
            ensure(value["generation"][field] == false)?;
        }
    }
    // Safe free JSON runtime inputs are frozen without silently dropping narrative settings.
    bounded(value, MAX_START_ORIGINAL_REQUEST_BYTES)
}
pub(crate) fn freeze_generation_start(
    request: Value,
    owner: u64,
) -> Result<std::sync::Arc<Vec<u8>>, RoomError> {
    if owner == 0 || owner > MAX_SAFE_INTEGER {
        return Err(invalid_request());
    }
    // Final DTO after normalization and any future trusted injection must fit this same gate.
    start_complexity(&request)?;
    bounded(&request, MAX_START_ORIGINAL_REQUEST_BYTES).map_err(|_| invalid_request())?;
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Metadata {
        version: &'static str,
        expected_user_id: u64,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Envelope {
        desktop_room: Metadata,
        request: Value,
    }
    let envelope = Envelope {
        desktop_room: Metadata {
            version: PROTOCOL_VERSION,
            expected_user_id: owner,
        },
        request,
    };
    let size = json_size(&envelope, MAX_START_REQUEST_BYTES).map_err(|_| invalid_request())?;
    let mut bytes = Vec::with_capacity(size);
    serde_json::to_writer(&mut bytes, &envelope).map_err(|_| invalid_request())?;
    // envelope (and its sole AST) is dropped here. Only this frozen wire survives.
    Ok(std::sync::Arc::new(bytes))
}

/// Serialize only the trusted start recovery attach projection with its larger budget.
/// Ordinary attach, ACK, pull and other small command replies keep their existing gates.
pub(crate) fn encode_attach_response(value: &Value) -> Result<String, RoomError> {
    let start_recovery = value["pendingIntent"]["operation"] == "generationStart"
        || value["pendingIntent"]["cancelMode"] == "starting-v1"
        || value
            .get("generationStartFence")
            .is_some_and(|fence| !fence.is_null());
    let maximum = if start_recovery {
        MAX_START_RECOVERY_RESPONSE_BYTES
    } else {
        1024
    };
    encode_small_projection(value, maximum)
}

pub(crate) fn encode_start_tracking_ended_response(value: &Value) -> Result<String, RoomError> {
    encode_small_projection(value, MAX_START_RECOVERY_RESPONSE_BYTES)
}

fn encode_small_projection(value: &Value, maximum: usize) -> Result<String, RoomError> {
    json_size(value, maximum).map_err(|_| RoomError::new("internal-error", "not-applicable"))?;
    serde_json::to_string(value).map_err(|_| RoomError::new("internal-error", "not-applicable"))
}

pub(crate) fn parse_request(raw: &Value) -> Result<Request, RoomError> {
    bounded(raw, MAX_IPC_REQUEST_BYTES)
        .and_then(|_| closed(raw, &["handle", "request"], &[]))
        .map_err(|_| invalid_request())?;
    let mut handle = raw["handle"].clone();
    id(&mut handle, 1).map_err(|_| invalid_request())?;
    let mut v = raw["request"].clone();
    let mut check = || -> Result<Action, ()> {
        let kind = text(&v["kind"])?.to_owned();
        let get = |v: &Value, name: &str| -> Result<String, ()> { Ok(text(&v[name])?.to_owned()) };
        match kind.as_str() {
            "end-generation-start-tracking" => {
                closed(&v, &["kind", "intentId"], &[])?;
                id(&mut v["intentId"], 1)?;
                Ok(Action::EndGenerationStartTracking {
                    intent_id: get(&v, "intentId")?,
                })
            }
            "cancel-generation-start" => {
                closed(&v, &["kind", "intentId"], &[])?;
                id(&mut v["intentId"], 1)?;
                Ok(Action::CancelGenerationStart {
                    intent_id: get(&v, "intentId")?,
                })
            }
            "retry-generation-start" => {
                closed(&v, &["kind", "intentId"], &[])?;
                id(&mut v["intentId"], 1)?;
                Ok(Action::RetryGenerationStart {
                    intent_id: get(&v, "intentId")?,
                })
            }
            "generation-cancel" => {
                closed(
                    &v,
                    &[
                        "kind",
                        "roomId",
                        "generationId",
                        "expectedRoomEpoch",
                        "expectedAttempt",
                    ],
                    &[],
                )?;
                desktop_path_id(&v["roomId"])?;
                desktop_path_id(&v["generationId"])?;
                key(&mut v["expectedRoomEpoch"])?;
                integer(&mut v["expectedAttempt"], 1, MAX_SAFE_INTEGER)?;
                Ok(Action::GenerationCancel {
                    room_id: get(&v, "roomId")?,
                    generation_id: get(&v, "generationId")?,
                    expected_room_epoch: get(&v, "expectedRoomEpoch")?,
                    expected_attempt: safe_u64(&v["expectedAttempt"])?,
                })
            }
            "generation-read" => {
                closed(
                    &v,
                    &[
                        "kind",
                        "generationId",
                        "expectedRoomEpoch",
                        "expectedAttempt",
                    ],
                    &[],
                )?;
                desktop_path_id(&v["generationId"])?;
                key(&mut v["expectedRoomEpoch"])?;
                integer(&mut v["expectedAttempt"], 1, MAX_SAFE_INTEGER)?;
                Ok(Action::GenerationRead {
                    generation_id: get(&v, "generationId")?,
                    expected_room_epoch: get(&v, "expectedRoomEpoch")?,
                    expected_attempt: safe_u64(&v["expectedAttempt"])?,
                })
            }
            "discover" => {
                closed(&v, &["kind", "query"], &[])?;
                Ok(Action::Discover {
                    query: validate_discover_query(&v["query"]).map_err(|_| ())?,
                })
            }
            "create" => {
                closed(&v, &["kind", "request"], &[])?;
                original_request(Operation::Create, &mut v["request"])?;
                Ok(Action::Create {
                    request: v["request"].clone(),
                })
            }
            "resume-create" => {
                closed(&v, &["kind", "intentId"], &[])?;
                id(&mut v["intentId"], 1)?;
                Ok(Action::ResumeCreate {
                    intent_id: get(&v, "intentId")?,
                })
            }
            "join" => {
                closed(&v, &["kind", "roomId", "request"], &[])?;
                key(&mut v["roomId"])?;
                original_request(Operation::Join, &mut v["request"])?;
                Ok(Action::Join {
                    room_id: get(&v, "roomId")?,
                    request: v["request"].clone(),
                })
            }
            "config" => {
                closed(&v, &["kind", "roomId", "request"], &[])?;
                key(&mut v["roomId"])?;
                original_request(Operation::Config, &mut v["request"])?;
                Ok(Action::Config {
                    room_id: get(&v, "roomId")?,
                    request: v["request"].clone(),
                })
            }
            "proposal-submit" => {
                closed(&v, &["kind", "roomId", "request"], &[])?;
                desktop_path_id(&v["roomId"])?;
                original_request(Operation::ProposalSubmit, &mut v["request"])?;
                Ok(Action::ProposalSubmit {
                    room_id: get(&v, "roomId")?,
                    request: v["request"].clone(),
                })
            }
            "proposal-withdraw" | "proposal-resolve" => {
                closed(&v, &["kind", "roomId", "proposalId", "request"], &[])?;
                desktop_path_id(&v["roomId"])?;
                desktop_path_id(&v["proposalId"])?;
                let withdraw = kind == "proposal-withdraw";
                original_request(
                    if withdraw {
                        Operation::ProposalWithdraw
                    } else {
                        Operation::ProposalResolve
                    },
                    &mut v["request"],
                )?;
                let room_id = get(&v, "roomId")?;
                let proposal_id = get(&v, "proposalId")?;
                let request = v["request"].clone();
                Ok(if withdraw {
                    Action::ProposalWithdraw {
                        room_id,
                        proposal_id,
                        request,
                    }
                } else {
                    Action::ProposalResolve {
                        room_id,
                        proposal_id,
                        request,
                    }
                })
            }
            "end-proposal-tracking" => {
                closed(&v, &["kind", "intentId"], &[])?;
                id(&mut v["intentId"], 1)?;
                Ok(Action::EndProposalTracking {
                    intent_id: get(&v, "intentId")?,
                })
            }
            "end-config-tracking" => {
                closed(&v, &["kind", "intentId"], &[])?;
                id(&mut v["intentId"], 1)?;
                Ok(Action::EndConfigTracking {
                    intent_id: get(&v, "intentId")?,
                })
            }
            "session" => {
                closed(&v, &["kind", "roomId"], &[])?;
                key(&mut v["roomId"])?;
                Ok(Action::Session {
                    room_id: get(&v, "roomId")?,
                })
            }
            "leave" | "close" => {
                closed(&v, &["kind", "roomId", "expectedRoomEpoch"], &[])?;
                key(&mut v["roomId"])?;
                key(&mut v["expectedRoomEpoch"])?;
                let room_id = get(&v, "roomId")?;
                let expected_room_epoch = get(&v, "expectedRoomEpoch")?;
                Ok(if kind == "leave" {
                    Action::Leave {
                        room_id,
                        expected_room_epoch,
                    }
                } else {
                    Action::Close {
                        room_id,
                        expected_room_epoch,
                    }
                })
            }
            "pull" => {
                closed(&v, &["kind", "subscriptionId"], &[])?;
                id(&mut v["subscriptionId"], 1)?;
                Ok(Action::Pull {
                    subscription_id: get(&v, "subscriptionId")?,
                })
            }
            "ack" => {
                closed(&v, &["kind", "subscriptionId", "batchId", "sequence"], &[])?;
                id(&mut v["subscriptionId"], 1)?;
                id(&mut v["batchId"], 1)?;
                integer(&mut v["sequence"], 0, MAX_SAFE_INTEGER)?;
                Ok(Action::Ack {
                    subscription_id: get(&v, "subscriptionId")?,
                    batch_id: get(&v, "batchId")?,
                    sequence: safe_u64(&v["sequence"])?,
                })
            }
            _ => Err(()),
        }
    };
    let action = check().map_err(|_| {
        if v["kind"] == "generation-read" {
            RoomError::new("invalid-request", "not-applicable")
        } else {
            invalid_request()
        }
    })?;
    Ok(Request {
        handle: handle.as_str().unwrap().to_owned(),
        action,
    })
}

fn generation_event(v: &mut Value, kind: &str) -> Check {
    let mut req = vec![
        "generationRequestId",
        "generationId",
        "attempt",
        "configRevision",
        "snapshotDigest",
        "collaborativeInfluence",
        "participantUserIds",
    ];
    if kind == "generation.completed" {
        req.push("generationRecordId");
    }
    if kind == "generation.failed" {
        req.push("errorCode");
    }
    closed(v, &req, &["hostAccountUserId"])?;
    generation_fields(v)?;
    if kind == "generation.completed" {
        key(&mut v["generationRecordId"])?;
    }
    if kind == "generation.failed" {
        one_of(&v["errorCode"], ARENA_CODES)?;
    }
    Ok(())
}
fn server_message(v: &mut Value) -> Check {
    let kind = text(&v["type"])?.to_owned();
    if kind == "room.resync.required" {
        closed(v, &["protocolVersion", "type", "reason"], &[])?;
        version(&mut v["protocolVersion"])?;
        return one_of(
            &v["reason"],
            &["state-not-attached", "replay-unavailable", "slow-consumer"],
        );
    }
    if kind == "room.presence" {
        closed(
            v,
            &[
                "protocolVersion",
                "type",
                "roomId",
                "roomEpoch",
                "onlineUserIds",
            ],
            &[],
        )?;
        version(&mut v["protocolVersion"])?;
        key(&mut v["roomId"])?;
        key(&mut v["roomEpoch"])?;
        array(&mut v["onlineUserIds"], 0, 32, key)?;
        return unique_strings(&v["onlineUserIds"]);
    }
    let story = kind == "story.delta";
    closed(
        v,
        if story {
            &[
                "protocolVersion",
                "type",
                "roomId",
                "roomEpoch",
                "generationId",
                "chunkSeq",
                "timestamp",
                "payload",
            ]
        } else {
            &[
                "protocolVersion",
                "type",
                "roomId",
                "roomEpoch",
                "controlSeq",
                "timestamp",
                "payload",
            ]
        },
        &[],
    )?;
    version(&mut v["protocolVersion"])?;
    key(&mut v["roomId"])?;
    key(&mut v["roomEpoch"])?;
    timestamp(&v["timestamp"])?;
    if story {
        key(&mut v["generationId"])?;
        integer(&mut v["chunkSeq"], 0, MAX_SAFE_INTEGER)?;
    } else {
        integer(&mut v["controlSeq"], 0, MAX_SAFE_INTEGER)?;
    }
    let payload = &mut v["payload"];
    match kind.as_str() {
        "room.snapshot" => snapshot(payload)?,
        "room.member.joined" | "room.member.left" | "room.host.offline" | "room.host.online" => {
            closed(payload, &["member"], &[])?;
            member(&mut payload["member"])?;
        }
        "room.config.updated" => {
            closed(payload, &["revision", "sharedConfig"], &[])?;
            integer(&mut payload["revision"], 0, MAX_SAFE_INTEGER)?;
            shared_config(&mut payload["sharedConfig"])?;
        }
        "proposal.submitted" | "proposal.updated" => {
            closed(payload, &["proposal"], &[])?;
            proposal(&mut payload["proposal"])?;
            if kind == "proposal.submitted" {
                literal(&payload["proposal"]["status"], "submitted")?;
            }
        }
        "proposal.resolved" => {
            closed(payload, &["proposalId", "status"], &[])?;
            proposal_id(&mut payload["proposalId"])?;
            resolved_status(&payload["status"])?;
        }
        "generation.started" | "generation.completed" | "generation.failed" => {
            generation_event(payload, &kind)?
        }
        "room.closing" => {
            closed(payload, &[], &["reason"])?;
            if has(payload, "reason") {
                string(&mut payload["reason"], 1, 200, true)?;
            }
        }
        "story.delta" => {
            closed(payload, &["delta"], &[])?;
            ensure(text(&payload["delta"])?.len() <= MAX_WEBSOCKET_BYTES)?;
        }
        _ => return Err(()),
    }
    if kind == "room.snapshot" {
        for f in ["roomId", "roomEpoch", "controlSeq"] {
            ensure(v[f] == v["payload"][f])?;
        }
    }
    if matches!(kind.as_str(), "proposal.submitted" | "proposal.updated") {
        ensure(v["roomId"] == v["payload"]["proposal"]["roomId"])?;
    }
    Ok(())
}
pub(crate) fn parse_server_message(raw: &[u8]) -> Result<Value, RoomError> {
    let mut value = decode(raw, MAX_WEBSOCKET_BYTES, "not-applicable")?;
    server_message(&mut value)
        .and_then(|_| bounded(&value, MAX_WEBSOCKET_BYTES))
        .map_err(|_| RoomError::new("invalid-response", "not-applicable"))?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../packages/contracts/fixtures/desktop-room-session.json"
        ))
        .unwrap()
    }
    fn encode(v: &Value) -> Vec<u8> {
        serde_json::to_vec(v).unwrap()
    }
    fn response(op: Operation, value: &Value) -> Result<Value, RoomError> {
        validate_http_response(
            op,
            if value.get("error").is_some() {
                429
            } else if op == Operation::Create {
                201
            } else {
                200
            },
            &encode(value),
            42,
        )
    }
    fn proposal_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../packages/contracts/fixtures/desktop-room-proposals.json"
        ))
        .unwrap()
    }
    fn proposal_action(operation: Operation) -> Value {
        let fixture = proposal_fixture();
        let kind = match operation {
            Operation::ProposalSubmit => "proposal-submit",
            Operation::ProposalWithdraw => "proposal-withdraw",
            Operation::ProposalResolve => "proposal-resolve",
            _ => unreachable!(),
        };
        let mut action = json!({"kind":kind,"roomId":"room_01JARENAEXAMPLE","request":fixture[operation.as_str()]["request"]["request"]});
        if operation != Operation::ProposalSubmit {
            action["proposalId"] = json!("desktop-proposal-1");
        }
        json!({"handle":"native-handle","request":action})
    }
    #[test]
    fn proposal_operations_match_producer_dtos_and_closed_receipts() {
        let fixture = proposal_fixture();
        for op in [
            Operation::ProposalSubmit,
            Operation::ProposalWithdraw,
            Operation::ProposalResolve,
        ] {
            assert!(op.is_post());
            assert_eq!(serde_json::to_value(op).unwrap(), json!(op.as_str()));
            let wire = &fixture[op.as_str()];
            assert_eq!(
                validate_service_request(op, &wire["request"], 42).unwrap(),
                wire["request"]
            );
            assert_eq!(response(op, &wire["success"]).unwrap(), wire["success"]);
            assert_eq!(response(op, &wire["error"]).unwrap(), wire["error"]);
            assert!(parse_request(&proposal_action(op)).is_ok());
            let mut bad = wire["success"].clone();
            bad["desktopRoom"]["viewerUserId"] = json!(43);
            assert_eq!(response(op, &bad).unwrap_err().outcome, "unknown");
            for field in ["controlSeq", "revision"] {
                let mut bad = wire["success"].clone();
                bad["result"][field] = json!(MAX_SAFE_INTEGER + 1);
                assert!(response(op, &bad).is_err());
            }
            for field in ["role", "url", "cookie", "authorUserId", "createdAt"] {
                let mut bad = proposal_action(op);
                bad["request"]["request"][field] = json!("injected");
                assert!(parse_request(&bad).is_err());
                let mut bad = wire["success"].clone();
                bad["result"][field] = json!("injected");
                assert!(response(op, &bad).is_err());
            }
        }
        let mut submit = fixture["proposalSubmit"]["success"].clone();
        submit["result"]["result"] = json!("idempotent");
        assert!(response(Operation::ProposalSubmit, &submit).is_ok());
        submit["result"]["status"] = json!("accepted");
        assert!(response(Operation::ProposalSubmit, &submit).is_err());
        let mut withdraw = fixture["proposalWithdraw"]["success"].clone();
        withdraw["result"]["result"] = json!("idempotent");
        assert!(response(Operation::ProposalWithdraw, &withdraw).is_err());
        for field in ["sharedConfig", "snapshot"] {
            let mut bad = fixture["proposalResolve"]["success"].clone();
            bad["result"].as_object_mut().unwrap().remove(field);
            assert!(response(Operation::ProposalResolve, &bad).is_err());
        }
        for field in ["roomId", "roomEpoch", "revision", "controlSeq"] {
            let mut bad = fixture["proposalResolve"]["success"].clone();
            bad["result"]["snapshot"][field] = if matches!(field, "revision" | "controlSeq") {
                json!(99)
            } else {
                json!("other")
            };
            assert!(response(Operation::ProposalResolve, &bad).is_err());
        }
        let mut bad = fixture["proposalResolve"]["success"].clone();
        bad["result"]["sharedConfig"]["combatants"][0]["ref"]["versionToken"] =
            json!("other-version");
        assert!(response(Operation::ProposalResolve, &bad).is_err());
        for status in ["accepted", "partially_accepted", "rejected"] {
            let mut valid = fixture["proposalResolve"]["success"].clone();
            valid["result"]["status"] = json!(status);
            assert!(response(Operation::ProposalResolve, &valid).is_ok());
        }
    }
    #[test]
    fn proposal_targets_are_canonical_without_rewriting_unicode_or_spaces() {
        for value in [
            "房间 提案😀",
            "a?b#c&d+e=f:@$;,[]",
            "a!~*'()_-.",
            "a\tb",
            "a\0b",
        ] {
            assert!(canonical_path_id(value), "{value:?}");
            for op in [
                Operation::ProposalSubmit,
                Operation::ProposalWithdraw,
                Operation::ProposalResolve,
            ] {
                let mut input = proposal_action(op);
                input["request"]["roomId"] = json!(value);
                if op == Operation::ProposalSubmit {
                    input["request"]["request"]["proposalId"] = json!(value);
                } else {
                    input["request"]["proposalId"] = json!(value);
                }
                match parse_request(&input).unwrap().action {
                    Action::ProposalSubmit { room_id, request } => {
                        assert_eq!(room_id, value);
                        assert_eq!(request["proposalId"], value);
                    }
                    Action::ProposalWithdraw {
                        room_id,
                        proposal_id,
                        ..
                    }
                    | Action::ProposalResolve {
                        room_id,
                        proposal_id,
                        ..
                    } => {
                        assert_eq!(room_id, value);
                        assert_eq!(proposal_id, value);
                    }
                    _ => panic!("wrong proposal action"),
                }
            }
        }
        for value in [
            "",
            ".",
            "..",
            " x",
            "x ",
            "\u{feff}x",
            "x\u{3000}",
            "a/b",
            "a\\b",
            "%2e",
            "%252f",
            "100%",
        ] {
            assert!(!canonical_path_id(value), "{value:?}");
            for op in [
                Operation::ProposalSubmit,
                Operation::ProposalWithdraw,
                Operation::ProposalResolve,
            ] {
                let mut bad = proposal_action(op);
                bad["request"]["roomId"] = json!(value);
                assert!(parse_request(&bad).is_err());
                let mut bad = proposal_action(op);
                if op == Operation::ProposalSubmit {
                    bad["request"]["request"]["proposalId"] = json!(value);
                } else {
                    bad["request"]["proposalId"] = json!(value);
                }
                assert!(parse_request(&bad).is_err());
            }
        }
        assert!(canonical_path_id(&"😀".repeat(128)));
        assert!(!canonical_path_id(&"😀".repeat(129)));
    }
    #[test]
    fn proposal_requests_preserve_existing_merge_rules_and_original_byte_budget() {
        let mut submit = proposal_action(Operation::ProposalSubmit);
        submit["request"]["request"]["baseRevision"] = json!(0);
        assert!(parse_request(&submit).is_ok());
        for changes in [
            json!([]),
            json!([{"changeId":"x","type":"setUserGuidance","value":"new","expectedBase":{"kind":"value","value":"old"},"dependsOn":["missing"]}]),
        ] {
            let mut bad = submit.clone();
            bad["request"]["request"]["changes"] = changes;
            assert!(parse_request(&bad).is_err());
        }
        let mut resolve = proposal_action(Operation::ProposalResolve);
        resolve["request"]["request"] = json!({"expectedRoomEpoch":"epoch_01JARENA","resolution":"accept-selected","selectedChangeIds":["guidance-1"]});
        assert!(parse_request(&resolve).is_ok()); // Ordinary acceptance has no global revision precondition.
        resolve["request"]["request"]["overrideChangeIds"] = json!(["guidance-1"]);
        assert!(parse_request(&resolve).is_err());
        resolve["request"]["request"]["expectedRevision"] = json!(7);
        assert!(parse_request(&resolve).is_ok());
        for overrides in [json!(["other"]), json!(["guidance-1", "guidance-1"])] {
            let mut bad = resolve.clone();
            bad["request"]["request"]["overrideChangeIds"] = overrides;
            assert!(parse_request(&bad).is_err());
        }
        resolve["request"]["request"]["resolution"] = json!("reject");
        assert!(parse_request(&resolve).is_err());
        let mut padded = proposal_action(Operation::ProposalWithdraw);
        let original = &mut padded["request"]["request"];
        let padding = MAX_ORIGINAL_REQUEST_BYTES - byte_len(original).unwrap();
        original["expectedRoomEpoch"] = json!(format!("{}epoch_01JARENA", " ".repeat(padding)));
        assert!(parse_request(&padded).is_ok());
        padded["request"]["request"]["expectedRoomEpoch"] =
            json!(format!("{}epoch_01JARENA", " ".repeat(padding + 1)));
        assert!(parse_request(&padded).is_err());
        let ended = json!({"handle":"native-handle","request":{"kind":"end-proposal-tracking","intentId":"intent-a"}});
        assert!(matches!(
            parse_request(&ended).unwrap().action,
            Action::EndProposalTracking { .. }
        ));
        let mut bad = ended;
        bad["request"]["cancelServer"] = json!(true);
        assert!(parse_request(&bad).is_err());
    }
    #[test]
    fn config_protocol_is_closed_bounded_and_matches_producer_wire() {
        let session = fixture()["operations"]["session"]["success"].clone();
        let snapshot = &session["result"]["snapshot"];
        let original = json!({"expectedRoomEpoch":snapshot["roomEpoch"],"expectedRevision":snapshot["revision"],
            "expectedControlSeq":snapshot["controlSeq"],"sharedConfig":snapshot["sharedConfig"]});
        let input = json!({"handle":"native-handle","request":{"kind":"config","roomId":snapshot["roomId"],"request":original}});
        assert!(matches!(
            parse_request(&input).unwrap().action,
            Action::Config { .. }
        ));
        for field in ["expectedRevision", "expectedControlSeq"] {
            let mut bad = input.clone();
            bad["request"]["request"][field] = json!(MAX_SAFE_INTEGER + 1);
            assert!(parse_request(&bad).is_err());
        }
        let mut bad = input.clone();
        bad["request"]["request"]["url"] = json!("https://not-allowed.invalid");
        assert!(parse_request(&bad).is_err());
        bad = input.clone();
        bad["request"]["request"]["sharedConfig"]["userGuidance"] =
            json!(" ".repeat(MAX_ORIGINAL_REQUEST_BYTES));
        assert!(parse_request(&bad).is_err());
        assert!(response(Operation::Config, &session).is_ok());
        let mut bad_response = session.clone();
        bad_response["desktopRoom"]["viewerUserId"] = json!(43);
        assert!(response(Operation::Config, &bad_response).is_err());
        assert!(matches!(parse_request(&json!({"handle":"native-handle","request":{"kind":"end-config-tracking","intentId":"intent-a"}})).unwrap().action, Action::EndConfigTracking { .. }));
        assert!(parse_request(&json!({"handle":"native-handle","request":{"kind":"end-config-tracking","intentId":"intent-a","cancelServer":true}})).is_err());
        if let Some(directory) = std::env::var_os("MAHO_ROOM_CONFIG_PRODUCER_DIR") {
            let directory = std::path::PathBuf::from(directory);
            let request: Value = serde_json::from_slice(
                &std::fs::read(directory.join("config.request.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(
                validate_service_request(Operation::Config, &request, 42).unwrap()["request"],
                original
            );
            validate_http_response(
                Operation::Config,
                200,
                &std::fs::read(directory.join("config.response.json")).unwrap(),
                42,
            )
            .unwrap();
            validate_http_response(
                Operation::Config,
                429,
                &std::fs::read(directory.join("config.error.json")).unwrap(),
                42,
            )
            .unwrap();
        }
    }

    fn all_objects(value: &Value, path: String, output: &mut Vec<String>) {
        match value {
            Value::Object(o) => {
                output.push(path.clone());
                for (key, child) in o {
                    all_objects(child, format!("{path}/{key}"), output);
                }
            }
            Value::Array(a) => {
                for (index, child) in a.iter().enumerate() {
                    all_objects(child, format!("{path}/{index}"), output);
                }
            }
            _ => {}
        }
    }
    fn injected_objects(value: &Value) -> Vec<Value> {
        let mut paths = Vec::new();
        all_objects(value, String::new(), &mut paths);
        paths
            .into_iter()
            .map(|p| {
                let mut copy = value.clone();
                copy.pointer_mut(&p)
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .insert("unexpectedCanary".into(), json!("secret-canary"));
                copy
            })
            .collect()
    }
    fn op_list() -> [Operation; 7] {
        [
            Operation::Discover,
            Operation::Create,
            Operation::Join,
            Operation::Session,
            Operation::Ticket,
            Operation::Leave,
            Operation::Close,
        ]
    }
    #[test]
    fn real_producer_golden_covers_all_seven_operations_and_boundaries() {
        let f = fixture();
        assert_eq!(f["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(f["limits"]["responseBodyBytes"], MAX_RESPONSE_BYTES);
        assert_eq!(f["limits"]["maxJsonDepth"], MAX_JSON_DEPTH);
        for op in op_list() {
            let sample = &f["operations"][op.as_str()];
            assert_eq!(response(op, &sample["success"]).unwrap(), sample["success"]);
            assert_eq!(response(op, &sample["error"]).unwrap(), sample["error"]);
            if op.is_post() {
                assert_eq!(
                    validate_service_request(op, &sample["request"], 42).unwrap(),
                    sample["request"]
                );
            }
        }
        assert_eq!(
            validate_service_request(Operation::Create, &f["createResumeOnlyRequest"], 42).unwrap(),
            f["createResumeOnlyRequest"]
        );
        for (op, field) in [
            (Operation::Session, "sessionWith32Members"),
            (Operation::Discover, "directoryWith50Items"),
        ] {
            assert_eq!(
                response(op, &f["boundaryExamples"][field]).unwrap(),
                f["boundaryExamples"][field]
            );
        }
    }
    #[test]
    fn rejects_unknown_fields_at_every_golden_schema_object() {
        let f = fixture();
        for op in op_list() {
            let sample = &f["operations"][op.as_str()];
            for raw in injected_objects(&sample["success"]) {
                assert!(response(op, &raw).is_err(), "{}", op.as_str());
            }
            for raw in injected_objects(&sample["error"]) {
                assert!(response(op, &raw).is_err());
            }
            if op.is_post() {
                for raw in injected_objects(&sample["request"]) {
                    assert!(validate_service_request(op, &raw, 42).is_err());
                }
            }
        }
    }
    #[test]
    fn rejects_legacy_nonobject_wrong_owner_and_version_without_raw_errors() {
        let f = fixture();
        for op in op_list() {
            let sample = &f["operations"][op.as_str()]["success"];
            for raw in [
                Value::Null,
                json!([]),
                json!(true),
                json!(7),
                json!("secret-canary"),
                sample["result"].clone(),
            ] {
                let e = response(op, &raw).unwrap_err();
                assert_eq!(e.code, "invalid-response");
                assert_eq!(e.outcome, op.rejected_outcome());
                assert!(!serde_json::to_string(&e).unwrap().contains("secret-canary"));
            }
            let mut bad = sample.clone();
            bad["desktopRoom"]["viewerUserId"] = json!(43);
            assert_eq!(response(op, &bad).unwrap_err().code, "invalid-response");
            bad["desktopRoom"]["viewerUserId"] = json!(42);
            bad["desktopRoom"]["version"] = json!("legacy");
            assert!(response(op, &bad).is_err());
        }
        for raw in [
            b"{secret-canary".as_slice(),
            b"{\"bad\":\"\xff\"}".as_slice(),
        ] {
            let e = validate_http_response(Operation::Join, 200, raw, 42).unwrap_err();
            assert_eq!(e.outcome, "unknown");
            assert_eq!(e.message, "多人房间操作未完成");
        }
    }
    #[test]
    fn decimal_json_integers_are_accepted_and_unsafe_nested_numbers_rejected() {
        let f = fixture();
        let sample = &f["operations"]["session"]["success"];
        let mut valid = sample.clone();
        valid["desktopRoom"]["viewerUserId"] = json!(42.0);
        valid["result"]["snapshot"]["revision"] = json!(7.0);
        assert_eq!(response(Operation::Session, &valid).unwrap(), *sample);
        for n in [
            json!(0),
            json!(-1),
            json!(42.5),
            json!("42"),
            json!(9_007_199_254_740_992u64),
        ] {
            let mut bad = sample.clone();
            bad["desktopRoom"]["viewerUserId"] = n;
            assert!(response(Operation::Session, &bad).is_err());
        }
        let mut bad = sample.clone();
        bad["result"]["snapshot"]["revision"] = json!(9_007_199_254_740_992u64);
        assert!(response(Operation::Session, &bad).is_err());
        let mut max = sample.clone();
        max["desktopRoom"]["viewerUserId"] = json!(MAX_SAFE_INTEGER);
        assert!(
            validate_http_response(Operation::Session, 200, &encode(&max), MAX_SAFE_INTEGER)
                .is_ok()
        );
    }
    #[test]
    fn original_utf8_request_budget_is_checked_before_trimming() {
        let f = fixture();
        let mut request = f["operations"]["join"]["request"].clone();
        request["request"]["displayName"] = json!("成员😀 \\\"\n");
        let remaining = MAX_ORIGINAL_REQUEST_BYTES - encode(&request["request"]).len();
        request["request"]["displayName"] = json!(format!(
            "{}{}",
            request["request"]["displayName"].as_str().unwrap(),
            " ".repeat(remaining)
        ));
        assert_eq!(
            encode(&request["request"]).len(),
            MAX_ORIGINAL_REQUEST_BYTES
        );
        assert!(validate_service_request(Operation::Join, &request, 42).is_ok());
        let extra = format!("{} ", request["request"]["displayName"].as_str().unwrap());
        request["request"]["displayName"] = json!(extra);
        assert!(validate_service_request(Operation::Join, &request, 42).is_err());
        let mut unicode = f["operations"]["join"]["request"].clone();
        unicode["request"]["displayName"] = json!(format!("成员{}", "\u{3000}".repeat(22_000)));
        assert!(validate_service_request(Operation::Join, &unicode, 42).is_err());
    }
    #[test]
    fn complete_http_raw_receive_boundary_and_unbounded_fractional_timestamp() {
        let f = fixture();
        let mut value = f["operations"]["discover"]["success"].clone();
        value["result"]["items"][0]["createdAt"] = json!("2026-10-12T00:00:00.0Z");
        let remaining = MAX_RESPONSE_BYTES - encode(&value).len();
        value["result"]["items"][0]["createdAt"] = json!(format!(
            "2026-10-12T00:00:00.{}Z",
            "0".repeat(remaining + 1)
        ));
        let raw = encode(&value);
        assert_eq!(raw.len(), MAX_RESPONSE_BYTES);
        assert!(validate_http_response(Operation::Discover, 200, &raw, 42).is_ok());
        let mut extra = raw;
        extra.push(b' ');
        assert_eq!(
            validate_http_response(Operation::Discover, 200, &extra, 42)
                .unwrap_err()
                .code,
            "response-too-large"
        );
        assert_eq!(
            validate_http_response(Operation::Join, 200, &extra, 42)
                .unwrap_err()
                .outcome,
            "unknown"
        );
    }
    #[test]
    fn ticket_is_internal_fixed_and_counts_original_utf8() {
        let f = fixture();
        let sample = &f["operations"]["ticket"]["success"];
        let ticket = parse_ticket(&response(Operation::Ticket, sample).unwrap()).unwrap();
        assert_eq!(ticket.token, sample["result"]["ticket"].as_str().unwrap());
        assert!(ticket.expires_in_seconds <= 60);
        for (field, value) in [
            (
                "ticket",
                json!(format!("t{}", " ".repeat(MAX_TICKET_BYTES))),
            ),
            ("ticket", json!("😀".repeat(1025))),
            ("expiresInSeconds", json!(61)),
            ("expiresInSeconds", json!(0)),
        ] {
            let mut bad = sample.clone();
            bad["result"][field] = value;
            assert!(response(Operation::Ticket, &bad).is_err());
            assert!(parse_ticket(&bad).is_err());
        }
        for field in ["path", "protocol"] {
            let mut bad = sample.clone();
            bad["result"]["websocket"][field] = json!("https://canary.invalid/");
            assert!(response(Operation::Ticket, &bad).is_err());
        }
        assert!(
            parse_request(&json!({"handle":"h", "request":{"kind":"ticket","roomId":"r"}}))
                .is_err()
        );
    }
    #[test]
    fn error_identity_http_status_and_outcomes_are_paired() {
        for (code, status) in [
            ("ROOM_AUTHENTICATION_REQUIRED", 401),
            ("ROOM_AUTHENTICATION_DENIED", 403),
            ("ROOM_DESKTOP_OWNER_MISMATCH", 409),
        ] {
            for op in [Operation::Join, Operation::Session] {
                let outcome = if op.is_post() {
                    "not-applied"
                } else {
                    "not-applicable"
                };
                let good = json!({"desktopRoom":{"version":PROTOCOL_VERSION,"viewerUserId":null},"error":{"code":code,"message":"safe","outcome":outcome}});
                assert!(validate_http_response(op, status, &encode(&good), 42).is_ok());
                let mut bad = good.clone();
                bad["desktopRoom"]["viewerUserId"] = json!(42);
                assert!(validate_http_response(op, status, &encode(&bad), 42).is_err());
                bad = good.clone();
                bad["error"]["outcome"] = json!("unknown");
                assert!(validate_http_response(op, status, &encode(&bad), 42).is_err());
                for wrong in [200, 400, 401, 403, 409, 500] {
                    if wrong != status {
                        assert!(validate_http_response(op, wrong, &encode(&good), 42).is_err());
                    }
                }
            }
        }
        let f = fixture();
        let mut bad = f["operations"]["join"]["error"].clone();
        bad["desktopRoom"]["viewerUserId"] = Value::Null;
        assert!(response(Operation::Join, &bad).is_err());
        bad = f["operations"]["join"]["error"].clone();
        bad["error"]["retryAfterSeconds"] = json!(86_401);
        assert!(response(Operation::Join, &bad).is_err());
        assert_eq!(
            RoomError::new("raw-canary", "raw-canary").with_server_code("raw-canary"),
            RoomError::new("internal-error", "not-applicable")
        );
    }
    #[test]
    fn ipc_closed_objects_nonce_and_js_safe_fields() {
        let good = json!({"documentNonce":"a".repeat(64),"attachIntent":7.0,"expectedUserId":42.0});
        assert_eq!(parse_attach(&good).unwrap().attach_intent, 7);
        for bad in injected_objects(&good) {
            assert!(parse_attach(&bad).is_err());
        }
        for nonce in ["a".repeat(63), "A".repeat(64), "😀".repeat(16)] {
            let mut bad = good.clone();
            bad["documentNonce"] = json!(nonce);
            assert!(parse_attach(&bad).is_err());
        }
        for input in [json!([]), json!(null), json!("body"), json!(false)] {
            assert!(parse_attach(&input).is_err());
            assert!(parse_request(&input).is_err());
            assert!(parse_subscribe(&input).is_err());
            assert!(parse_detach(&input).is_err());
        }
        assert!(
            parse_subscribe(&json!({"handle":"h","roomId":"r","expectedRoomEpoch":"e"})).is_ok()
        );
        assert!(parse_detach(&json!({"handle":"h"})).is_ok());
        assert!(parse_detach(&json!({"handle":"h","cookie":"canary"})).is_err());
        assert!(parse_request(&json!({"handle":"h","request":{"kind":"ack","subscriptionId":"s","batchId":"b","sequence":7.0}})).is_ok());
        assert!(parse_request(&json!({"handle":"h","request":{"kind":"ack","subscriptionId":"s","batchId":"b","sequence":9_007_199_254_740_992u64}})).is_err());
        assert_eq!(
            validate_discover_query(&json!({})).unwrap(),
            json!({"limit":20})
        );
        assert!(validate_discover_query(&json!({"search":"anything"})).is_err());
    }
    #[test]
    fn bounded_guard_rejects_unsafe_keys_and_deep_containers_without_node_cap() {
        let mut value = json!({});
        for _ in 0..MAX_JSON_DEPTH {
            value = json!({"child":value});
        }
        assert!(bounded(&value, MAX_RESPONSE_BYTES).is_ok());
        value = json!({"child":value});
        assert!(bounded(&value, MAX_RESPONSE_BYTES).is_err());
        for unsafe_key in ["__proto__", "constructor", "prototype"] {
            let mut v = json!({});
            v.as_object_mut()
                .unwrap()
                .insert(unsafe_key.into(), json!({}));
            assert!(bounded(&v, MAX_RESPONSE_BYTES).is_err());
        }
        let many_nodes = json!({"items":vec![json!(null); 10_001]});
        assert!(bounded(&many_nodes, MAX_RESPONSE_BYTES).is_ok());
    }
    fn frame(kind: &str, payload: Value) -> Value {
        json!({"protocolVersion":1,"type":kind,"roomId":"room_01JARENAEXAMPLE","roomEpoch":"epoch_01JARENA","controlSeq":24,
            "timestamp":"2026-10-12T00:00:00.000Z","payload":payload})
    }
    fn parse_frame(v: &Value) -> Result<Value, RoomError> {
        parse_server_message(&encode(v))
    }
    #[test]
    fn snapshot_members_and_config_semantic_relations_are_enforced() {
        let f = fixture();
        let good = f["operations"]["session"]["success"].clone();
        for pointer in [
            "/result/snapshot/roomId",
            "/result/snapshot/roomEpoch",
            "/result/self/displayName",
        ] {
            let mut bad = good.clone();
            *bad.pointer_mut(pointer).unwrap() = json!("different");
            assert!(response(Operation::Session, &bad).is_err());
        }
        let mut bad = good.clone();
        bad["result"]["snapshot"]["members"][1]["userId"] =
            bad["result"]["snapshot"]["members"][0]["userId"].clone();
        assert!(response(Operation::Session, &bad).is_err());
        let mut bad = good.clone();
        bad["result"]["snapshot"]["members"][1]["role"] = json!("host");
        assert!(response(Operation::Session, &bad).is_err());
        for value in [json!("data-card:wrong"), json!("host-local:character-001")] {
            let mut bad = good.clone();
            bad["result"]["snapshot"]["sharedConfig"]["combatants"][0]["key"] = value;
            assert!(response(Operation::Session, &bad).is_err());
        }
        let mut bad = good.clone();
        bad["result"]["snapshot"]["sharedConfig"]["teams"][0]["combatantKeys"] =
            json!(["data-card:unknown"]);
        assert!(response(Operation::Session, &bad).is_err());
    }
    #[test]
    fn all_closed_server_message_branches_are_covered() {
        let f = fixture();
        let snap = &f["operations"]["session"]["success"]["result"]["snapshot"];
        let member = snap["members"][0].clone();
        let generation = json!({"generationRequestId":"request","generationId":"generation","attempt":1,"configRevision":7,"snapshotDigest":"digest", "collaborativeInfluence":true,"participantUserIds":[42],"hostAccountUserId":42});
        let mut frames = vec![
            frame("room.snapshot", snap.clone()),
            frame(
                "room.config.updated",
                json!({"revision":7,"sharedConfig":snap["sharedConfig"]}),
            ),
            frame(
                "proposal.resolved",
                json!({"proposalId":"p","status":"accepted"}),
            ),
            frame("room.closing", json!({"reason":"closed"})),
            json!({"protocolVersion":1,"type":"room.resync.required","reason":"slow-consumer"}),
            json!({"protocolVersion":1,"type":"room.presence","roomId":"r","roomEpoch":"e","onlineUserIds":["user-host"]}),
        ];
        for kind in [
            "room.member.joined",
            "room.member.left",
            "room.host.offline",
            "room.host.online",
        ] {
            frames.push(frame(kind, json!({"member":member})));
        }
        for kind in [
            "generation.started",
            "generation.completed",
            "generation.failed",
        ] {
            let mut payload = generation.clone();
            if kind == "generation.completed" {
                payload["generationRecordId"] = json!("record");
            }
            if kind == "generation.failed" {
                payload["errorCode"] = json!("generation-failed");
            }
            frames.push(frame(kind, payload));
        }
        frames.push(json!({"protocolVersion":1,"type":"story.delta","roomId":"r","roomEpoch":"e","generationId":"g","chunkSeq":0,"timestamp":"2026-10-12T00:00Z","payload":{"delta":"正文😀\\\"\n"}}));
        for good in frames {
            assert_eq!(parse_frame(&good).unwrap(), good);
            for bad in injected_objects(&good) {
                assert!(parse_frame(&bad).is_err());
            }
        }
    }
    #[test]
    fn websocket_complete_frame_utf8_budget_includes_envelope() {
        let mut good = json!({"protocolVersion":1,"type":"story.delta","roomId":"r","roomEpoch":"e","generationId":"g","chunkSeq":0,"timestamp":"2026-10-12T00:00Z","payload":{"delta":"😀\"\\"}});
        let padding = MAX_WEBSOCKET_BYTES - encode(&good).len();
        good["payload"]["delta"] = json!(format!("😀\"\\{}", "x".repeat(padding)));
        let bytes = encode(&good);
        assert_eq!(bytes.len(), MAX_WEBSOCKET_BYTES);
        assert!(parse_server_message(&bytes).is_ok());
        good["payload"]["delta"] =
            json!(format!("{}x", good["payload"]["delta"].as_str().unwrap()));
        assert_eq!(parse_frame(&good).unwrap_err().code, "response-too-large");
        let bad_presence = json!({"protocolVersion":1,"type":"room.presence","roomId":"r","roomEpoch":"e","onlineUserIds":["u","u"]});
        assert!(parse_frame(&bad_presence).is_err());
    }
    fn proposal_with(change: Value) -> Value {
        json!({"proposalVersion":1,"proposalId":"proposal-a","roomId":"room_01JARENAEXAMPLE","authorUserId":"user-host","baseRevision":7,"status":"submitted","changes":[change],"createdAt":"2026-10-12T00:00:00Z"})
    }
    fn changes() -> Vec<Value> {
        let character = json!({"id":"a","kind":"character","versionToken":"v"});
        let scenario = json!({"id":"a","kind":"scenario","versionToken":"v"});
        let material = json!({"id":"a","kind":"material","versionToken":"v"});
        let history = fixture()["operations"]["session"]["success"]["result"]["snapshot"]
            ["sharedConfig"]["historySettings"]
            .clone();
        let web = json!({"id":"web","version":"v1","digest":format!("sha256:{}", "a".repeat(64))});
        let mut all = vec![
            json!({"type":"addCombatant","ref":character,"expectedBase":{"kind":"absent"}}),
            json!({"type":"removeCombatant","combatantKey":"data-card:a","expectedBase":{"kind":"present","ref":character}}),
            json!({"type":"setCharacterGuidance","combatantKey":"data-card:a","value":null,"expectedBase":{"kind":"value","value":"previous"}}),
            json!({"type":"assignTeam","combatantKey":"data-card:a","teamKey":"team","expectedBase":{"kind":"value","value":null}}),
            json!({"type":"addTeam","teamKey":"team","displayName":"队伍","expectedBase":{"kind":"absent"}}),
            json!({"type":"removeTeam","teamKey":"team","expectedBase":{"kind":"present","ref":{"key":"team","displayName":"队伍","combatantKeys":[]}}}),
            json!({"type":"renameTeam","teamKey":"team","value":"新队伍","expectedBase":{"kind":"value","value":"旧队伍"}}),
            json!({"type":"setReportFormat","value":"web","expectedBase":{"kind":"value","value":"markdown"}}),
            json!({"type":"setWebPackageRef","value":web,"expectedBase":{"kind":"value","value":null}}),
            json!({"type":"setBattleMode","value":"daily","expectedBase":{"kind":"value","value":"classic"}}),
            json!({"type":"setSelectedLanguage","value":"zh-CN","expectedBase":{"kind":"value","value":"en"}}),
            json!({"type":"setScenario","ref":scenario,"expectedBase":{"kind":"ref","ref":null}}),
            json!({"type":"addAuxScenario","ref":scenario,"expectedBase":{"kind":"absent"}}),
            json!({"type":"removeAuxScenario","scenarioKey":"data-card:a","expectedBase":{"kind":"present","ref":scenario}}),
            json!({"type":"addMaterial","ref":material,"expectedBase":{"kind":"absent"}}),
            json!({"type":"removeMaterial","materialKey":"data-card:a","expectedBase":{"kind":"present","ref":material}}),
            json!({"type":"setUserGuidance","value":"next","expectedBase":{"kind":"value","value":"previous"}}),
            json!({"type":"setStoryLength","value":"long","customStoryLength":null,"expectedBase":{"kind":"value","value":{"storyLength":"short","customStoryLength":"100"}}}),
            json!({"type":"setHistorySettings","value":history,"expectedBase":{"kind":"value","value":history}}),
        ];
        for kind in [
            "reorderCombatants",
            "reorderTeams",
            "reorderTeamCombatants",
            "reorderAuxScenarios",
            "reorderMaterials",
        ] {
            let mut change = json!({"type":kind,"value":["data-card:b","data-card:a"],"expectedBase":{"kind":"value","value":["data-card:a","data-card:b"]}});
            if kind == "reorderTeamCombatants" {
                change["teamKey"] = json!("team");
            }
            all.push(change);
        }
        for c in &mut all {
            c["changeId"] = json!("change-a");
        }
        all
    }
    #[test]
    fn every_proposal_change_is_closed_and_preserves_full_authoritative_content() {
        let changes = changes();
        assert_eq!(changes.len(), 24);
        for change in changes {
            let proposal = proposal_with(change);
            for kind in ["proposal.submitted", "proposal.updated"] {
                let good = frame(kind, json!({"proposal":proposal}));
                assert_eq!(parse_frame(&good).unwrap(), good);
                for bad in injected_objects(&good) {
                    assert!(parse_frame(&bad).is_err());
                }
            }
            let mut session = fixture()["operations"]["session"]["success"].clone();
            session["result"]["snapshot"]["proposals"] = json!([proposal]);
            assert_eq!(response(Operation::Session, &session).unwrap(), session);
        }
    }
    #[test]
    fn proposal_semantics_reject_drafts_cycles_missing_dependencies_and_false_identities() {
        let mut proposal = proposal_with(changes()[0].clone());
        proposal["status"] = json!("draft");
        assert!(parse_frame(&frame("proposal.updated", json!({"proposal":proposal}))).is_err());
        proposal["status"] = json!("accepted");
        assert!(parse_frame(&frame("proposal.submitted", json!({"proposal":proposal}))).is_err());
        proposal["status"] = json!("submitted");
        for dependency in ["missing", "change-a"] {
            proposal["changes"][0]["dependsOn"] = json!([dependency]);
            assert!(parse_frame(&frame("proposal.updated", json!({"proposal":proposal}))).is_err());
        }
        let mut first = changes()[0].clone();
        first["dependsOn"] = json!(["change-b"]);
        let mut second = changes()[1].clone();
        second["changeId"] = json!("change-b");
        second["dependsOn"] = json!(["change-a"]);
        proposal["changes"] = json!([first, second]);
        assert!(parse_frame(&frame("proposal.updated", json!({"proposal":proposal}))).is_err());
        let mut remove = changes()[1].clone();
        remove["combatantKey"] = json!("preset:a");
        assert!(parse_frame(&frame(
            "proposal.updated",
            json!({"proposal":proposal_with(remove.clone())})
        ))
        .is_err());
        remove["expectedBase"]["key"] = json!("preset:a");
        assert!(parse_frame(&frame(
            "proposal.updated",
            json!({"proposal":proposal_with(remove)})
        ))
        .is_ok());
        let mut reorder = changes()[19].clone();
        reorder["value"] = reorder["expectedBase"]["value"].clone();
        assert!(parse_frame(&frame(
            "proposal.updated",
            json!({"proposal":proposal_with(reorder)})
        ))
        .is_err());
    }
    #[test]
    fn timestamp_and_ecmascript_trim_match_existing_schema_edges() {
        for good in [
            "2000-02-29T12:30Z",
            "0000-02-29T23:59:59.000000000000001-23:59",
            "2026-10-12T00:00:00+00:00",
        ] {
            assert!(timestamp(&json!(good)).is_ok());
        }
        for bad in [
            "1900-02-29T12:30Z",
            "2026-02-30T00:00Z",
            "2026-10-12t00:00Z",
            "2026-10-12T24:00Z",
            "2026-10-12T00:00:60Z",
            "2026-10-12T00:00+24:00",
            "2026-10-12T00:00+0000",
        ] {
            assert!(timestamp(&json!(bad)).is_err());
        }
        let mut value = json!("\u{feff} 😀 \u{feff}");
        display_name(&mut value).unwrap();
        assert_eq!(value, "😀");
        let mut value = json!("\u{0085}x\u{0085}");
        display_name(&mut value).unwrap();
        assert_eq!(value, "\u{0085}x\u{0085}");
    }
    #[test]
    fn native_unicode_boundary_consumes_shared_ipc_raw_json_cases() {
        let ipc: Value = serde_json::from_str(include_str!(
            "../../../../packages/contracts/fixtures/desktop-room-ipc.json"
        ))
        .unwrap();
        assert_eq!(ipc["limits"]["requestBytes"], MAX_IPC_REQUEST_BYTES);
        assert!(parse_attach(&ipc["attachRequest"]).is_ok());
        assert!(parse_subscribe(&ipc["subscribeRequest"]).is_ok());
        assert!(parse_detach(&ipc["detachRequest"]).is_ok());
        for request in ipc["requests"].as_array().unwrap() {
            assert!(parse_request(request).is_ok());
            for invalid in injected_objects(request) {
                assert!(parse_request(&invalid).is_err());
            }
        }
        let cases = &ipc["unicodeBoundary"];
        let invalid = cases["invalidJsonTexts"].as_array().unwrap();
        assert_eq!(invalid.len(), 4);
        for raw in invalid {
            let raw = raw.as_str().unwrap();
            // The outer fixture is valid Unicode; each inner JSON text retains
            // the exact invalid escape instead of a replacement character.
            assert!(!raw.contains('\u{fffd}'));
            assert!(serde_json::from_str::<Value>(raw).is_err());
            for operation in [Operation::Session, Operation::Join] {
                let error = validate_http_response(operation, 200, raw.as_bytes(), 42).unwrap_err();
                assert_eq!(error.code, "invalid-response");
                assert_eq!(error.outcome, operation.rejected_outcome());
            }
        }
        let valid_raw = cases["validJsonText"].as_str().unwrap();
        assert!(valid_raw.contains("\\ud83d\\ude00"));
        let valid: Value = serde_json::from_str(valid_raw).unwrap();
        match parse_request(&valid).unwrap().action {
            Action::Join { request, .. } => assert_eq!(request["displayName"], "成员😀"),
            _ => panic!("fixture must be a join"),
        }
        let good = fixture()["operations"]["session"]["success"].clone();
        let original_name = serde_json::to_string(&good["result"]["self"]["displayName"]).unwrap();
        let encoded = String::from_utf8(encode(&good)).unwrap();
        for escaped in [r#""\ud800""#, r#""\udc00""#] {
            let raw = encoded.replacen(&original_name, escaped, 1);
            assert!(serde_json::from_str::<Value>(&raw).is_err());
            for operation in [Operation::Session, Operation::Join] {
                let error = validate_http_response(operation, 200, raw.as_bytes(), 42).unwrap_err();
                assert_eq!(error.code, "invalid-response");
                assert_eq!(error.outcome, operation.rejected_outcome());
            }
        }
    }
}

#[cfg(test)]
mod start_budget_tests {
    use super::*;
    #[test]
    fn complete_start_invoke_wrapper_is_counted_at_the_exact_boundary() {
        #[derive(Serialize)]
        struct Invoke<'a> {
            request: &'a Value,
        }
        let empty = json!({"padding":""});
        let overhead = json_size(&Invoke { request: &empty }, usize::MAX).unwrap();
        let mut value = json!({"padding":"a".repeat(MAX_START_IPC_REQUEST_BYTES-overhead)});
        assert_eq!(
            json_size(&Invoke { request: &value }, MAX_START_IPC_REQUEST_BYTES).unwrap(),
            MAX_START_IPC_REQUEST_BYTES
        );
        value["padding"] = json!(format!("{}a", value["padding"].as_str().unwrap()));
        assert!(json_size(&value, MAX_START_IPC_REQUEST_BYTES).is_ok());
        assert!(json_size(&Invoke { request: &value }, MAX_START_IPC_REQUEST_BYTES).is_err());
    }
    #[test]
    fn start_http_counter_and_other_operation_budgets_stay_distinct() {
        let mut value = json!({"padding":""});
        let overhead = json_size(&value, usize::MAX).unwrap();
        value["padding"] = json!("a".repeat(MAX_START_REQUEST_BYTES - overhead));
        assert_eq!(
            json_size(&value, MAX_START_REQUEST_BYTES).unwrap(),
            MAX_START_REQUEST_BYTES
        );
        value["padding"] = json!(format!("{}a", value["padding"].as_str().unwrap()));
        assert!(json_size(&value, MAX_START_REQUEST_BYTES).is_err());
        assert_eq!(
            (
                MAX_ORIGINAL_REQUEST_BYTES,
                MAX_REQUEST_BYTES,
                MAX_IPC_REQUEST_BYTES
            ),
            (64 * 1024, 65 * 1024, 67 * 1024)
        );
        let oversized = json!({"handle":"handle","request":{"kind":"discover","query":{"cursor":"x".repeat(MAX_IPC_REQUEST_BYTES)}}});
        assert!(parse_request(&oversized).is_err());
    }
}
