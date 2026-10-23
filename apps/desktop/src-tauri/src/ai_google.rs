//! GenerateContent text projection. Candidate zero is the single product answer;
//! opaque thought signatures are bounded and discarded, never replayed.
use serde::{Deserialize, Deserializer};
use serde_json::Value;

use crate::ai::{AiExecutionUsage, DirectAiError, DirectAiErrorCode};

const MAX_CONTENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_OPAQUE_BYTES: usize = 4 * 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Default)]
pub(crate) struct GoogleDelta {
    pub text: String,
    pub reasoning: String,
    pub usage: Option<AiExecutionUsage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    candidates: Option<Vec<Value>>,
    usage_metadata: Option<Usage>,
    prompt_feedback: Option<PromptFeedback>,
    error: Option<UpstreamError>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptFeedback {
    block_reason: Option<String>,
}

#[derive(Deserialize)]
struct UpstreamError {
    #[serde(default, deserialize_with = "optional_count")]
    code: Option<u64>,
    status: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    content: Option<Content>,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct Content {
    parts: Option<Vec<Value>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    #[serde(default, deserialize_with = "optional_count")]
    prompt_token_count: Option<u64>,
    #[serde(default, deserialize_with = "optional_count")]
    candidates_token_count: Option<u64>,
    #[serde(default, deserialize_with = "optional_count")]
    thoughts_token_count: Option<u64>,
    #[serde(default, deserialize_with = "optional_count")]
    cached_content_token_count: Option<u64>,
    #[serde(default, deserialize_with = "optional_count")]
    total_token_count: Option<u64>,
}

// JSON integer values may use an exponent or decimal point (1e0 / 1.0).
// Match the shared JavaScript number contract, not a lexical JSON spelling.
fn safe_integer(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .or_else(|| {
            value
                .as_f64()
                .filter(|value| {
                    value.is_finite()
                        && *value >= 0.0
                        && value.fract() == 0.0
                        && *value <= MAX_SAFE_INTEGER as f64
                })
                .map(|value| value as u64)
        })
}

fn optional_count<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u64>, D::Error> {
    Option::<Value>::deserialize(deserializer)?
        .map(|value| {
            safe_integer(&value)
                .ok_or_else(|| serde::de::Error::custom("expected a safe nonnegative integer"))
        })
        .transpose()
}

#[derive(Default)]
pub(crate) struct GoogleStreamState {
    finish_reason: Option<String>,
    has_text: bool,
    content_bytes: usize,
    opaque_bytes: usize,
    usage: AiExecutionUsage,
}

fn invalid() -> DirectAiError {
    DirectAiError {
        code: DirectAiErrorCode::StreamProtocol,
        message: "provider sent an invalid GenerateContent response".into(),
        contract_code: Some("invalid-response".into()),
    }
}

fn rejected(code: &str) -> DirectAiError {
    DirectAiError {
        code: DirectAiErrorCode::UpstreamRejected,
        message: "provider did not complete the GenerateContent response".into(),
        contract_code: Some(code.into()),
    }
}

fn budget_exceeded() -> DirectAiError {
    DirectAiError {
        code: DirectAiErrorCode::StreamProtocol,
        message: "GenerateContent response exceeded its fixed resource budget".into(),
        contract_code: Some("output-too-large".into()),
    }
}

fn filtered(reason: &str) -> bool {
    matches!(
        reason,
        "SAFETY"
            | "RECITATION"
            | "BLOCKLIST"
            | "PROHIBITED_CONTENT"
            | "SPII"
            | "IMAGE_SAFETY"
            | "IMAGE_PROHIBITED_CONTENT"
            | "IMAGE_RECITATION"
    )
}

impl GoogleStreamState {
    /// Only the caller's normal HTTP EOF can establish completion, not this marker alone.
    pub(crate) fn finish(&self) -> Result<(), DirectAiError> {
        match self.finish_reason.as_deref() {
            Some("STOP") if self.has_text => Ok(()),
            Some("MAX_TOKENS" | "CONTINUATION") => Err(rejected("output-too-large")),
            Some(reason) if filtered(reason) => Err(rejected("content-filtered")),
            _ => Err(invalid()),
        }
    }

    pub(crate) fn consume(
        &mut self,
        payload: &str,
        max_content_bytes: Option<usize>,
    ) -> Result<GoogleDelta, DirectAiError> {
        // Never surface serde errors: their diagnostics can contain upstream secrets.
        let response: Response = serde_json::from_str(payload).map_err(|_| invalid())?;
        if let Some(error) = response.error {
            let code = match (error.code, error.status.as_deref()) {
                (Some(400), _) | (_, Some("INVALID_ARGUMENT" | "FAILED_PRECONDITION")) => {
                    "invalid-request"
                }
                (Some(401), _) | (_, Some("UNAUTHENTICATED")) => "authentication-failed",
                (Some(403), _) | (_, Some("PERMISSION_DENIED")) => "permission-denied",
                (Some(429), _) | (_, Some("RESOURCE_EXHAUSTED")) => "rate-limited",
                (Some(500..=599), _) | (_, Some("INTERNAL" | "UNAVAILABLE")) => {
                    "service-unavailable"
                }
                _ => "invalid-response",
            };
            return Err(rejected(code));
        }
        if let Some(reason) = response
            .prompt_feedback
            .and_then(|feedback| feedback.block_reason)
        {
            if !reason.is_empty() && reason != "BLOCK_REASON_UNSPECIFIED" {
                return Err(rejected(if filtered(&reason) {
                    "content-filtered"
                } else {
                    "invalid-response"
                }));
            }
        }
        let mut delta = GoogleDelta::default();
        let candidates = response.candidates.unwrap_or_default();
        // Explicit indexes take precedence over position. Other candidates need not
        // be contiguous or present in every frame and never enter the selected answer.
        let mut selected = None;
        for candidate in &candidates {
            let object = candidate.as_object().ok_or_else(invalid)?;
            if let Some(index) = object.get("index").filter(|index| !index.is_null()) {
                let index = safe_integer(index).ok_or_else(invalid)?;
                if index == 0 && selected.replace(candidate).is_some() {
                    return Err(invalid());
                }
            }
        }
        let selected = selected.or_else(|| {
            candidates
                .first()
                .filter(|candidate| candidate.get("index").is_none_or(Value::is_null))
        });
        if let Some(candidate) = selected {
            let candidate: Candidate =
                serde_json::from_value(candidate.clone()).map_err(|_| invalid())?;
            let mut opaque_bytes = 0_usize;
            for part in candidate
                .content
                .and_then(|content| content.parts)
                .unwrap_or_default()
            {
                let part = part.as_object().ok_or_else(invalid)?;
                if [
                    "functionCall",
                    "functionResponse",
                    "toolCall",
                    "toolResponse",
                    "inlineData",
                    "fileData",
                    "executableCode",
                    "codeExecutionResult",
                ]
                .iter()
                .any(|field| part.get(*field).is_some_and(|value| !value.is_null()))
                {
                    return Err(invalid());
                }
                if let Some(signature) = part
                    .get("thoughtSignature")
                    .filter(|value| !value.is_null())
                {
                    opaque_bytes =
                        opaque_bytes.saturating_add(signature.as_str().ok_or_else(invalid)?.len());
                }
                let thought = match part.get("thought").filter(|value| !value.is_null()) {
                    Some(value) => value.as_bool().ok_or_else(invalid)?,
                    None => false,
                };
                if let Some(text) = part.get("text").filter(|value| !value.is_null()) {
                    let text = text.as_str().ok_or_else(invalid)?;
                    if self.finish_reason.is_some() && !text.is_empty() {
                        return Err(invalid());
                    }
                    if thought {
                        delta.reasoning.push_str(text);
                    } else {
                        delta.text.push_str(text);
                    }
                }
            }
            let content_bytes = self
                .content_bytes
                .saturating_add(delta.text.len())
                .saturating_add(delta.reasoning.len());
            let opaque_bytes = self.opaque_bytes.saturating_add(opaque_bytes);
            if content_bytes > max_content_bytes.unwrap_or(MAX_CONTENT_BYTES)
                || opaque_bytes > MAX_OPAQUE_BYTES
            {
                return Err(budget_exceeded());
            }
            if let Some(reason) = candidate
                .finish_reason
                .filter(|reason| !reason.is_empty() && reason != "FINISH_REASON_UNSPECIFIED")
            {
                if self
                    .finish_reason
                    .as_ref()
                    .is_some_and(|previous| previous != &reason)
                {
                    return Err(invalid());
                }
                self.finish_reason = Some(reason);
            }
            self.content_bytes = content_bytes;
            self.opaque_bytes = opaque_bytes;
            self.has_text |= !crate::ai::is_blank_output(&delta.text);
        }
        if let Some(usage) = response.usage_metadata {
            let counts = [
                usage.prompt_token_count,
                usage.candidates_token_count,
                usage.thoughts_token_count,
                usage.cached_content_token_count,
                usage.total_token_count,
            ];
            // Snapshots, not deltas. Input already includes cache; total may include
            // unshown candidates, so neither input nor total is recomputed locally.
            for (target, reported) in [
                (&mut self.usage.input_tokens, usage.prompt_token_count),
                (&mut self.usage.output_tokens, usage.candidates_token_count),
                (&mut self.usage.reasoning_tokens, usage.thoughts_token_count),
                (
                    &mut self.usage.cached_input_tokens,
                    usage.cached_content_token_count,
                ),
                (&mut self.usage.total_tokens, usage.total_token_count),
            ] {
                if let Some(value) = reported {
                    *target = Some(value);
                }
            }
            if counts.iter().any(Option::is_some) {
                delta.usage = Some(self.usage.clone());
            }
        }
        // Ordinary repeated envelope metadata is discarded per frame. The transport's
        // cumulative raw-wire bound limits it, not a fictitious 16 KiB lifetime quota.
        Ok(delta)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn feed(state: &mut GoogleStreamState, value: Value) -> Result<GoogleDelta, DirectAiError> {
        state.consume(&value.to_string(), None)
    }

    #[test]
    fn optional_shapes_candidates_and_opaque_parts_preserve_one_answer() {
        let mut state = GoogleStreamState::default();
        for value in [
            json!({}),
            json!({"candidates":[]}),
            json!({"usageMetadata":{}}),
            json!({"candidates":[{"index":8,"content":{"parts":[{"functionCall":{}}]}}]}),
        ] {
            assert!(feed(&mut state, value).unwrap().text.is_empty());
        }
        let delta = feed(&mut state, json!({"candidates":[
            {"index":2,"content":{"parts":[{"text":"ignore"}]}},
            {"index":0,"content":{"role":"", "parts":[{"text":"思考", "thought":true,"thoughtSignature":"opaque"},{"thoughtSignature":"only"},{"text":"魔法","inlineData":null,"functionCall":null},{"text":""},{"text":"少女"}]}}
        ]})).unwrap();
        assert_eq!(delta.text, "魔法少女");
        assert_eq!(delta.reasoning, "思考");
        feed(&mut state, json!({"candidates":[{"finishReason":"STOP"}]})).unwrap();
        feed(
            &mut state,
            json!({"candidates":[{"index":0,"finishReason":"STOP"}]}),
        )
        .unwrap();
        assert!(state.finish().is_ok());
    }

    #[test]
    fn usage_preserves_missing_fields_and_zero_without_recounting() {
        let mut state = GoogleStreamState::default();
        feed(&mut state, json!({"usageMetadata":{"promptTokenCount":10,"cachedContentTokenCount":4,"thoughtsTokenCount":3}})).unwrap();
        assert!(feed(&mut state, json!({"usageMetadata":{}}))
            .unwrap()
            .usage
            .is_none());
        let usage = feed(
            &mut state,
            json!({"usageMetadata":{"candidatesTokenCount":0,"totalTokenCount":18}}),
        )
        .unwrap()
        .usage
        .unwrap();
        assert_eq!(usage.input_tokens, Some(10));
        assert_eq!(usage.output_tokens, Some(0));
        assert_eq!(usage.cached_input_tokens, Some(4));
        assert_eq!(usage.reasoning_tokens, Some(3));
        assert_eq!(usage.total_tokens, Some(18));
        for count in [
            json!(-1),
            json!(1.5),
            json!(MAX_SAFE_INTEGER + 1),
            json!("synthetic-secret"),
        ] {
            assert!(feed(
                &mut state,
                json!({"usageMetadata":{"promptTokenCount":count}})
            )
            .is_err());
        }
    }

    #[test]
    fn integer_json_numbers_need_not_have_integer_lexical_spelling() {
        let mut state = GoogleStreamState::default();
        let delta = state.consume(r#"{"candidates":[{"index":0.0,"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1.0,"candidatesTokenCount":2e0,"totalTokenCount":3.0}}"#, None).unwrap();
        let usage = delta.usage.unwrap();
        assert_eq!(usage.input_tokens, Some(1));
        assert_eq!(usage.output_tokens, Some(2));
        assert_eq!(usage.total_tokens, Some(3));
        assert!(state.finish().is_ok());
        for raw in ["-1.0", "1.5", "9007199254740992.0", "1e99", "\"1\""] {
            let payload = format!(r#"{{"usageMetadata":{{"promptTokenCount":{raw}}}}}"#);
            assert!(GoogleStreamState::default()
                .consume(&payload, None)
                .is_err());
        }
    }

    #[test]
    fn finish_reasons_are_product_completion_evidence_not_provider_diagnostics() {
        for (reason, code) in [
            ("STOP", None),
            ("MAX_TOKENS", Some("output-too-large")),
            ("CONTINUATION", Some("output-too-large")),
            ("SAFETY", Some("content-filtered")),
            ("RECITATION", Some("content-filtered")),
            ("IMAGE_SAFETY", Some("content-filtered")),
            ("OTHER", Some("invalid-response")),
            ("MALFORMED_FUNCTION_CALL", Some("invalid-response")),
            ("", Some("invalid-response")),
            ("FINISH_REASON_UNSPECIFIED", Some("invalid-response")),
        ] {
            let mut state = GoogleStreamState::default();
            assert_eq!(feed(&mut state, json!({"candidates":[{"content":{"parts":[{"text":"partial"}]},"finishReason":reason,"finishMessage":"synthetic-secret"}]})).unwrap().text, "partial");
            assert_eq!(
                state
                    .finish()
                    .err()
                    .and_then(|error| error.contract_code)
                    .as_deref(),
                code
            );
        }
        for parts in [
            json!([]),
            json!([{"text":" \n\u{feff}"}]),
            json!([{"text":"thought","thought":true}]),
        ] {
            let mut state = GoogleStreamState::default();
            feed(
                &mut state,
                json!({"candidates":[{"content":{"parts":parts},"finishReason":"STOP"}]}),
            )
            .unwrap();
            assert!(state.finish().is_err());
        }
    }

    #[test]
    fn metadata_is_not_a_tiny_cumulative_quota_but_content_and_opaque_are_bounded() {
        let mut state = GoogleStreamState::default();
        for _ in 0..100 {
            feed(
                &mut state,
                json!({"modelVersion":"m".repeat(1024),"responseId":"repeated"}),
            )
            .unwrap();
        }
        feed(&mut state, json!({"candidates":[{"content":{"parts":[{"thoughtSignature":"s".repeat(MAX_OPAQUE_BYTES)}]}}]})).unwrap();
        assert_eq!(
            feed(
                &mut state,
                json!({"candidates":[{"content":{"parts":[{"thoughtSignature":"s"}]}}]})
            )
            .err()
            .unwrap()
            .contract_code
            .as_deref(),
            Some("output-too-large")
        );
        let mut state = GoogleStreamState::default();
        feed(
            &mut state,
            json!({"candidates":[{"content":{"parts":[{"text":"a".repeat(MAX_CONTENT_BYTES)}]}}]}),
        )
        .unwrap();
        assert_eq!(
            feed(
                &mut state,
                json!({"candidates":[{"content":{"parts":[{"text":"x"}]}}]})
            )
            .err()
            .unwrap()
            .contract_code
            .as_deref(),
            Some("output-too-large")
        );
    }

    #[test]
    fn malformed_content_and_post_terminal_output_fail_safely() {
        for part in [
            json!({"text":3}),
            json!({"thought":"yes"}),
            json!({"thoughtSignature":false}),
            json!({"text":"text","functionCall":{}}),
            json!({"inlineData":{}}),
            json!({"fileData":{}}),
            json!({"executableCode":{}}),
            json!({"toolCall":{}}),
        ] {
            assert!(feed(
                &mut GoogleStreamState::default(),
                json!({"candidates":[{"content":{"parts":[part]}}]})
            )
            .is_err());
        }
        for value in [
            json!([]),
            json!(null),
            json!({"candidates":1}),
            json!({"candidates":[{"index":"bad"}]}),
            json!({"candidates":[{"index":0},{"index":0}]}),
            json!({"usageMetadata":false}),
        ] {
            assert!(feed(&mut GoogleStreamState::default(), value).is_err());
        }
        for value in [
            json!({"candidates":[{"content":{"parts":[{"text":"late"}]}}]}),
            json!({"candidates":[{"finishReason":"MAX_TOKENS"}]}),
        ] {
            let mut state = GoogleStreamState::default();
            feed(
                &mut state,
                json!({"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}),
            )
            .unwrap();
            assert!(feed(&mut state, value).is_err());
        }
        assert!(GoogleStreamState::default()
            .consume("[DONE]", None)
            .is_err());
    }
}
