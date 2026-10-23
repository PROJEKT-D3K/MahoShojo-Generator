//! Messages text projection. Opaque thinking data is bounded and discarded, never replayed.
use serde::{de::IgnoredAny, Deserialize};

use crate::ai::{AiExecutionUsage, DirectAiError, DirectAiErrorCode};

const MAX_CONTENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_METADATA_BYTES: usize = 16 * 1024;
// Signatures carry encrypted full thinking and can far exceed ordinary metadata.
// This fixed native cap is independent of readable text and keeps no opaque history.
const MAX_OPAQUE_BYTES: usize = 4 * 1024 * 1024;
const MAX_BLOCKS: usize = 1024;

#[derive(Default)]
pub(crate) struct AnthropicDelta {
    pub text: String,
    pub reasoning: String,
    pub usage: Option<AiExecutionUsage>,
}

#[derive(Deserialize)]
struct Message {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    role: String,
    model: String,
    content: Vec<IgnoredAny>,
    stop_reason: Option<String>,
    stop_sequence: Option<String>,
    usage: Option<Usage>,
}

#[derive(Deserialize)]
struct Usage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    // Validate known counts, but no normalized field represents cache writes.
    #[serde(rename = "cache_creation_input_tokens")]
    _cache_creation_input_tokens: Option<u64>,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Block {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "thinking")]
    Thinking { thinking: String, signature: String },
    #[serde(rename = "redacted_thinking")]
    Redacted { data: String },
    #[serde(other)]
    Unsupported,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum BlockDelta {
    #[serde(rename = "text_delta")]
    Text { text: String },
    #[serde(rename = "thinking_delta")]
    Thinking { thinking: String },
    #[serde(rename = "signature_delta")]
    Signature { signature: String },
    #[serde(other)]
    Unsupported,
}

#[derive(Deserialize)]
struct MessageDelta {
    stop_reason: Option<String>,
    stop_sequence: Option<String>,
}

#[derive(Deserialize)]
struct UpstreamError {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Event {
    #[serde(rename = "message_start")]
    Start { message: Message },
    #[serde(rename = "content_block_start")]
    BlockStart { index: usize, content_block: Block },
    #[serde(rename = "content_block_delta")]
    BlockDelta { index: usize, delta: BlockDelta },
    #[serde(rename = "content_block_stop")]
    BlockStop { index: usize },
    #[serde(rename = "message_delta")]
    Delta {
        delta: MessageDelta,
        usage: Option<Usage>,
    },
    #[serde(rename = "message_stop")]
    Stop,
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "error")]
    Error { error: UpstreamError },
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Copy, PartialEq)]
enum BlockKind {
    Text,
    Thinking,
    Redacted,
}

struct OpenBlock {
    kind: BlockKind,
    signature_started: bool,
}

#[derive(Default)]
pub(crate) struct AnthropicStreamState {
    started: bool,
    message_delta_seen: bool,
    completed: bool,
    failed: bool,
    next_index: usize,
    open: Option<OpenBlock>,
    stop_reason: Option<String>,
    has_text: bool,
    content_bytes: usize,
    metadata_bytes: usize,
    opaque_bytes: usize,
    usage: AiExecutionUsage,
}

fn invalid(message: &str) -> DirectAiError {
    DirectAiError {
        code: DirectAiErrorCode::StreamProtocol,
        message: message.into(),
        contract_code: Some("invalid-response".into()),
    }
}

fn rejected(code: &str) -> DirectAiError {
    DirectAiError {
        code: DirectAiErrorCode::UpstreamRejected,
        message: "provider did not complete the Messages response".into(),
        contract_code: Some(code.into()),
    }
}

fn budget_exceeded() -> DirectAiError {
    DirectAiError {
        code: DirectAiErrorCode::StreamProtocol,
        message: "Messages response exceeded its fixed resource budget".into(),
        contract_code: Some("output-too-large".into()),
    }
}

impl AnthropicStreamState {
    pub(crate) fn is_completed(&self) -> bool {
        self.completed && !self.failed
    }

    #[cfg(test)]
    fn finish(&self) -> Result<(), DirectAiError> {
        if self.completed && !self.failed {
            Ok(())
        } else {
            Err(invalid(
                "Messages stream ended without a valid message_stop",
            ))
        }
    }

    fn metadata(&mut self, bytes: usize) -> Result<(), DirectAiError> {
        let total = self.metadata_bytes.saturating_add(bytes);
        if total > MAX_METADATA_BYTES {
            return Err(budget_exceeded());
        }
        self.metadata_bytes = total;
        Ok(())
    }

    fn opaque(&mut self, bytes: usize) -> Result<(), DirectAiError> {
        let total = self.opaque_bytes.saturating_add(bytes);
        if total > MAX_OPAQUE_BYTES {
            return Err(budget_exceeded());
        }
        self.opaque_bytes = total;
        Ok(())
    }

    fn append(
        &mut self,
        text: String,
        reasoning: bool,
        max_content_bytes: Option<usize>,
    ) -> Result<AnthropicDelta, DirectAiError> {
        let total = self.content_bytes.saturating_add(text.len());
        if total > max_content_bytes.unwrap_or(MAX_CONTENT_BYTES) {
            return Err(budget_exceeded());
        }
        self.content_bytes = total;
        let mut delta = AnthropicDelta::default();
        if reasoning {
            delta.reasoning = text;
        } else {
            self.has_text |= !crate::ai::is_blank_output(&text);
            delta.text = text;
        }
        Ok(delta)
    }

    fn merge_usage(&mut self, usage: Option<Usage>) -> Option<AiExecutionUsage> {
        let usage = usage?;
        // Anthropic counts are cumulative. Input excludes cache reads and writes;
        // absent fields preserve earlier knowledge instead of inventing totals.
        if let Some(value) = usage.input_tokens {
            self.usage.input_tokens = Some(value);
        }
        if let Some(value) = usage.output_tokens {
            self.usage.output_tokens = Some(value);
        }
        if let Some(value) = usage.cache_read_input_tokens {
            self.usage.cached_input_tokens = Some(value);
        }
        if self.usage.input_tokens.is_some()
            || self.usage.output_tokens.is_some()
            || self.usage.cached_input_tokens.is_some()
        {
            Some(self.usage.clone())
        } else {
            None
        }
    }

    pub(crate) fn consume(
        &mut self,
        payload: &str,
        max_content_bytes: Option<usize>,
    ) -> Result<AnthropicDelta, DirectAiError> {
        if self.completed || self.failed {
            return Err(invalid("Messages event followed a terminal outcome"));
        }
        let result = self.consume_event(payload, max_content_bytes);
        if result.is_err() {
            self.failed = true;
        }
        result
    }

    fn consume_event(
        &mut self,
        payload: &str,
        max_content_bytes: Option<usize>,
    ) -> Result<AnthropicDelta, DirectAiError> {
        if payload == "[DONE]" {
            return Err(invalid("Messages requires a typed message_stop event"));
        }
        // The shared SSE parser dispatches by data.type, not the event: line.
        // ai.rs bounds the entire raw wire, including ignored fields and framing.
        let event: Event = serde_json::from_str(payload)
            .map_err(|_| invalid("provider sent an unreadable Messages event"))?;
        match event {
            Event::Ping => {}
            Event::Unknown => self.metadata(payload.len())?,
            Event::Error { error } => {
                return Err(rejected(match error.kind.as_str() {
                    "authentication_error" => "authentication-failed",
                    "permission_error" => "permission-denied",
                    "rate_limit_error" => "rate-limited",
                    "overloaded_error" => "service-unavailable",
                    "invalid_request_error" => "invalid-request",
                    "request_too_large" => "output-too-large",
                    _ => "internal-error",
                }));
            }
            Event::Start { message } => {
                if self.started
                    || message.kind != "message"
                    || message.role != "assistant"
                    || message.id.is_empty()
                    || message.model.is_empty()
                    || !message.content.is_empty()
                    || message.stop_reason.is_some()
                    || message.stop_sequence.is_some()
                {
                    return Err(invalid("invalid or repeated Messages message_start"));
                }
                self.metadata(message.id.len().saturating_add(message.model.len()))?;
                self.started = true;
                return Ok(AnthropicDelta {
                    usage: self.merge_usage(message.usage),
                    ..Default::default()
                });
            }
            Event::BlockStart {
                index,
                content_block,
            } => {
                if !self.started
                    || self.message_delta_seen
                    || self.open.is_some()
                    || index != self.next_index
                {
                    return Err(invalid(
                        "Messages content blocks overlap or arrived out of order",
                    ));
                }
                if index >= MAX_BLOCKS {
                    return Err(budget_exceeded());
                }
                let (kind, content, signature_started) = match content_block {
                    Block::Text { text } => (BlockKind::Text, text, false),
                    Block::Thinking {
                        thinking,
                        signature,
                    } => {
                        self.opaque(signature.len())?;
                        (BlockKind::Thinking, thinking, !signature.is_empty())
                    }
                    Block::Redacted { data } => {
                        self.opaque(data.len())?;
                        (BlockKind::Redacted, String::new(), false)
                    }
                    Block::Unsupported => {
                        return Err(invalid("unsupported Messages content block"))
                    }
                };
                let delta = self.append(content, kind == BlockKind::Thinking, max_content_bytes)?;
                self.open = Some(OpenBlock {
                    kind,
                    signature_started,
                });
                return Ok(delta);
            }
            Event::BlockDelta { index, delta } => {
                if index != self.next_index {
                    return Err(invalid(
                        "Messages delta references an unknown content block",
                    ));
                }
                let block = self
                    .open
                    .as_ref()
                    .ok_or_else(|| invalid("Messages delta references a closed content block"))?;
                match (block.kind, delta) {
                    (BlockKind::Text, BlockDelta::Text { text }) => {
                        return self.append(text, false, max_content_bytes);
                    }
                    (BlockKind::Thinking, BlockDelta::Thinking { thinking })
                        if !block.signature_started =>
                    {
                        return self.append(thinking, true, max_content_bytes);
                    }
                    (BlockKind::Thinking, BlockDelta::Signature { signature }) => {
                        self.opaque(signature.len())?;
                        self.open
                            .as_mut()
                            .expect("validated open thinking block")
                            .signature_started = true;
                    }
                    _ => return Err(invalid("unsupported or mismatched Messages content delta")),
                }
            }
            Event::BlockStop { index } => {
                if index != self.next_index || self.open.is_none() {
                    return Err(invalid(
                        "Messages stop references an unknown or closed content block",
                    ));
                }
                self.open = None;
                self.next_index += 1;
            }
            Event::Delta { delta, usage } => {
                if !self.started || self.open.is_some() {
                    return Err(invalid(
                        "Messages message_delta arrived before content closed",
                    ));
                }
                self.message_delta_seen = true;
                if let Some(reason) = delta.stop_reason {
                    self.metadata(reason.len())?;
                    if self
                        .stop_reason
                        .as_ref()
                        .is_some_and(|previous| previous != &reason)
                    {
                        return Err(invalid("Messages stop reason changed"));
                    }
                    self.stop_reason = Some(reason);
                }
                if let Some(sequence) = delta.stop_sequence {
                    self.metadata(sequence.len())?;
                }
                return Ok(AnthropicDelta {
                    usage: self.merge_usage(usage),
                    ..Default::default()
                });
            }
            Event::Stop => {
                if !self.started || !self.message_delta_seen || self.open.is_some() {
                    return Err(invalid(
                        "Messages message_stop arrived before content completed",
                    ));
                }
                match self.stop_reason.as_deref() {
                    Some("end_turn" | "stop_sequence") => {}
                    Some("max_tokens" | "model_context_window_exceeded") => {
                        return Err(rejected("output-too-large"))
                    }
                    Some("refusal") => return Err(rejected("content-filtered")),
                    _ => {
                        return Err(invalid(
                            "Messages ended with an unsupported or missing stop reason",
                        ))
                    }
                }
                if !self.has_text {
                    return Err(invalid(
                        "Messages response completed without consumable text",
                    ));
                }
                self.completed = true;
            }
        }
        Ok(AnthropicDelta::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const FIXTURE: &str =
        include_str!("../../../../packages/contracts/fixtures/anthropic-messages-stream.json");

    fn event(
        state: &mut AnthropicStreamState,
        value: Value,
    ) -> Result<AnthropicDelta, DirectAiError> {
        state.consume(&value.to_string(), Some(128))
    }

    fn start(state: &mut AnthropicStreamState) {
        event(state, json!({"type":"message_start","message":{"id":"msg","model":"fixture-model","type":"message","role":"assistant","content":[],"stop_reason":null}})).unwrap();
    }

    #[test]
    fn shared_success_fixtures_project_text_reasoning_and_cumulative_usage() {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let mut state = AnthropicStreamState::default();
            let mut text = String::new();
            let mut reasoning = String::new();
            let mut usage = None;
            for upstream in case["upstreamEvents"].as_array().unwrap() {
                let delta = state
                    .consume(&upstream.to_string(), None)
                    .unwrap_or_else(|error| panic!("{}: {error:?}", case["name"]));
                text.push_str(&delta.text);
                reasoning.push_str(&delta.reasoning);
                if delta.usage.is_some() {
                    usage = delta.usage;
                }
            }
            state.finish().unwrap();
            let result = &case["events"].as_array().unwrap().last().unwrap()["result"];
            assert_eq!(
                text,
                result["output"]["text"].as_str().unwrap(),
                "{}",
                case["name"]
            );
            assert_eq!(
                reasoning,
                result["output"]["reasoning"].as_str().unwrap_or(""),
                "{}",
                case["name"]
            );
            assert_eq!(
                serde_json::to_value(usage).unwrap(),
                result["usage"],
                "{}",
                case["name"]
            );
            assert!(!format!("{text}{reasoning}").contains("synthetic-opaque"));
            assert!(state.open.is_none());
        }
    }

    #[test]
    fn shared_failure_fixtures_never_succeed_or_leak_upstream_messages() {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        for case in fixture["failureCases"].as_array().unwrap() {
            let mut state = AnthropicStreamState::default();
            let mut error = None;
            for upstream in case["upstreamEvents"].as_array().unwrap() {
                let payload = upstream
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| upstream.to_string());
                if let Err(failure) = state.consume(&payload, None) {
                    error = Some(failure);
                    break;
                }
            }
            let error = error
                .or_else(|| state.finish().err())
                .unwrap_or_else(|| panic!("{} unexpectedly completed", case["name"]));
            assert_eq!(
                error.contract_code.as_deref(),
                case["expectedCode"].as_str(),
                "{}",
                case["name"]
            );
            assert!(!error.message.contains("synthetic-secret"));
        }
    }

    #[test]
    fn initial_content_and_reasoning_share_budget_before_any_delta() {
        let mut state = AnthropicStreamState::default();
        start(&mut state);
        let initial = json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"先想🪄","signature":""}});
        let delta = state.consume(&initial.to_string(), Some(12)).unwrap();
        assert_eq!(delta.reasoning, "先想🪄");
        event(&mut state, json!({"type":"content_block_stop","index":0})).unwrap();
        let text = json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":"abc"}});
        let error = state.consume(&text.to_string(), Some(12)).err().unwrap();
        assert_eq!(error.contract_code.as_deref(), Some("output-too-large"));
        assert_eq!(state.content_bytes, "先想🪄".len());
        assert!(state.open.is_none());
    }

    #[test]
    fn non_arena_content_also_has_a_fixed_cap() {
        let mut state = AnthropicStreamState::default();
        start(&mut state);
        let initial = json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"x".repeat(MAX_CONTENT_BYTES + 1)}});
        let error = state.consume(&initial.to_string(), None).err().unwrap();
        assert_eq!(error.contract_code.as_deref(), Some("output-too-large"));
        assert_eq!(state.content_bytes, 0);
    }

    #[test]
    fn signatures_and_redacted_thinking_larger_than_metadata_limit_are_consumed_without_replay() {
        let mut state = AnthropicStreamState::default();
        start(&mut state);
        let bytes = MAX_METADATA_BYTES + 4096;
        let initial = event(&mut state, json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"思考","signature":"a".repeat(bytes)}})).unwrap();
        assert_eq!(initial.reasoning, "思考");
        assert!(initial.text.is_empty());
        let signature = event(&mut state, json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"b".repeat(bytes)}})).unwrap();
        assert!(signature.text.is_empty() && signature.reasoning.is_empty());
        event(&mut state, json!({"type":"content_block_stop","index":0})).unwrap();
        let redacted = event(&mut state, json!({"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"c".repeat(bytes)}})).unwrap();
        assert!(redacted.text.is_empty() && redacted.reasoning.is_empty());
        event(&mut state, json!({"type":"content_block_stop","index":1})).unwrap();
        let text = event(&mut state, json!({"type":"content_block_start","index":2,"content_block":{"type":"text","text":"回答"}})).unwrap();
        assert_eq!(text.text, "回答");
        event(&mut state, json!({"type":"content_block_stop","index":2})).unwrap();
        event(
            &mut state,
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
        )
        .unwrap();
        event(&mut state, json!({"type":"message_stop"})).unwrap();
        state.finish().unwrap();
        assert_eq!(state.opaque_bytes, bytes * 3);
        assert_eq!(state.content_bytes, "思考回答".len());
        assert!(state.metadata_bytes < MAX_METADATA_BYTES);
        assert!(state.open.is_none());
    }

    #[test]
    fn initial_signatures_fragments_and_redacted_blocks_share_a_cumulative_opaque_cap() {
        let mut state = AnthropicStreamState::default();
        start(&mut state);
        let quarter = MAX_OPAQUE_BYTES / 4;
        event(&mut state, json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":"a".repeat(quarter * 2)}})).unwrap();
        event(&mut state, json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"b".repeat(quarter)}})).unwrap();
        event(&mut state, json!({"type":"content_block_stop","index":0})).unwrap();
        event(&mut state, json!({"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"c".repeat(quarter)}})).unwrap();
        event(&mut state, json!({"type":"content_block_stop","index":1})).unwrap();
        assert_eq!(state.opaque_bytes, MAX_OPAQUE_BYTES);
        let error = event(&mut state, json!({"type":"content_block_start","index":2,"content_block":{"type":"redacted_thinking","data":"d"}})).err().unwrap();
        assert_eq!(error.contract_code.as_deref(), Some("output-too-large"));
        assert_eq!(state.opaque_bytes, MAX_OPAQUE_BYTES);
        assert_eq!(state.content_bytes, 0);
        assert!(state.open.is_none());
        assert!(state.metadata_bytes < MAX_METADATA_BYTES);
    }

    #[test]
    fn single_oversized_signature_or_redacted_block_fails_before_retaining_it() {
        for kind in ["thinking", "redacted_thinking"] {
            let mut state = AnthropicStreamState::default();
            start(&mut state);
            let block = if kind == "thinking" {
                json!({"type":kind,"thinking":"","signature":"x".repeat(MAX_OPAQUE_BYTES + 1)})
            } else {
                json!({"type":kind,"data":"x".repeat(MAX_OPAQUE_BYTES + 1)})
            };
            let error = event(
                &mut state,
                json!({"type":"content_block_start","index":0,"content_block":block}),
            )
            .err()
            .unwrap();
            assert_eq!(error.contract_code.as_deref(), Some("output-too-large"));
            assert_eq!(state.opaque_bytes, 0);
            assert!(state.open.is_none());
        }
    }

    #[test]
    fn unknown_events_cannot_bypass_metadata_budget_with_small_frames() {
        let mut state = AnthropicStreamState::default();
        let payload = json!({"type":"future_event","opaque":"x".repeat(80)}).to_string();
        let expected = MAX_METADATA_BYTES / payload.len();
        for _ in 0..expected {
            state.consume(&payload, None).unwrap();
        }
        assert_eq!(
            state
                .consume(&payload, None)
                .err()
                .unwrap()
                .contract_code
                .as_deref(),
            Some("output-too-large")
        );
        assert!(!state.started);
    }

    #[test]
    fn block_count_is_bounded_without_retaining_closed_blocks() {
        let mut state = AnthropicStreamState::default();
        start(&mut state);
        for index in 0..MAX_BLOCKS {
            event(&mut state, json!({"type":"content_block_start","index":index,"content_block":{"type":"text","text":""}})).unwrap();
            event(
                &mut state,
                json!({"type":"content_block_stop","index":index}),
            )
            .unwrap();
            assert!(state.open.is_none());
        }
        let error = event(&mut state, json!({"type":"content_block_start","index":MAX_BLOCKS,"content_block":{"type":"text","text":""}})).err().unwrap();
        assert_eq!(error.contract_code.as_deref(), Some("output-too-large"));
    }

    #[test]
    fn usage_zero_null_and_missing_fields_do_not_add_or_invent_totals() {
        let mut state = AnthropicStreamState::default();
        start(&mut state);
        let first = event(&mut state, json!({"type":"message_delta","delta":{},"usage":{"input_tokens":9,"output_tokens":5,"cache_read_input_tokens":3,"cache_creation_input_tokens":4}})).unwrap().usage.unwrap();
        assert_eq!(first.input_tokens, Some(9));
        let second = event(&mut state, json!({"type":"message_delta","delta":{},"usage":{"output_tokens":0,"input_tokens":null}})).unwrap().usage.unwrap();
        assert_eq!(second.input_tokens, Some(9));
        assert_eq!(second.output_tokens, Some(0));
        assert_eq!(second.cached_input_tokens, Some(3));
        assert!(second.total_tokens.is_none());
        assert!(second.reasoning_tokens.is_none());
        assert!(event(
            &mut state,
            json!({"type":"message_delta","delta":{},"usage":null})
        )
        .unwrap()
        .usage
        .is_none());
        let preserved = event(
            &mut state,
            json!({"type":"message_delta","delta":{},"usage":{}}),
        )
        .unwrap()
        .usage
        .unwrap();
        assert_eq!(preserved.output_tokens, Some(0));
    }

    #[test]
    fn errors_are_terminal_and_cannot_be_recovered_with_later_success() {
        let mut state = AnthropicStreamState::default();
        start(&mut state);
        assert!(state.consume("[DONE]", None).is_err());
        assert!(event(&mut state, json!({"type":"ping"})).is_err());
        assert!(!state.is_completed());
        assert!(state.finish().is_err());
    }
}
