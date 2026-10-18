//! Fixed catalog Hosted selection and credential construction, shared by Cloud and Room.
//! No Tauri, network, mutable catalog, caller-supplied endpoint or secret reference.
use crate::secret::{SecretStore, MAX_SECRET_VALUE_BYTES};
use serde::Deserialize;
use serde_json::{json, Value};

const HOSTED_GENERATION_OVERRIDES_MAX_BYTES: usize = 8 * 1024;
const HOSTED_GENERATION_OVERRIDE_MAX_OUTPUT_TOKENS: u64 = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostedPresetError {
    InvalidSelection,
    CredentialUnavailable,
    CredentialChanged,
    StorageUnavailable,
}
fn invalid_request(_: impl Into<String>) -> HostedPresetError {
    HostedPresetError::InvalidSelection
}

/// optional 字段的显式 `null` 拒绝：契约 `.optional()` 只接受「字段缺省」，
/// 而 serde 的 Option 语义会把 `null` 折叠成缺省无法区分——字段存在时统一
/// 走本 helper，null 按类型错误拒绝，其余值照常反序列化。
pub(crate) fn de_optional_non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let value = serde_json::Value::deserialize(deserializer).map_err(serde::de::Error::custom)?;
    if value.is_null() {
        return Err(serde::de::Error::custom(
            "字段不得为 null（缺省与 null 语义不同）",
        ));
    }
    serde_json::from_value(value)
        .map(Some)
        .map_err(serde::de::Error::custom)
}

/// 服务器 BYOK 的公开选择。固定目录身份，不接受 URL 或秘密引用。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedPresetConfig {
    pub provider_id: String,
    pub model_id: String,
    #[serde(default, deserialize_with = "de_optional_non_null")]
    pub generation_overrides: Option<serde_json::Value>,
}

/// `generationOverrides` 的严格受检（D5.1-AIP-r1-r1）：与
/// `DesktopHostedGenerationOverridesSchema` / `UserGenerationOverridesSchema`
/// 同语义——strict 对象、字段类型/范围受检、显式 null 与缺省不同待遇、
/// 原始值大小有界。native 不依赖 renderer schema，独立 fail-closed。
///
/// 返回 `Ok(None)` 表示「无实质覆盖」（空对象 / 全字段缺省），与 Web
/// `hasMeaningfulGenerationOverrides` 折叠语义一致；注入值按规范字段重建，
/// renderer 输入本身不透传。
pub(crate) fn normalize_hosted_generation_overrides(
    value: &serde_json::Value,
) -> Result<Option<serde_json::Value>, HostedPresetError> {
    // 原始载荷大小有界：严格校验之前先拒绝巨型嵌套。
    let size = serde_json::to_vec(value)
        .map_err(|_| invalid_request("generationOverrides 无法序列化"))?
        .len();
    if size > HOSTED_GENERATION_OVERRIDES_MAX_BYTES {
        return Err(invalid_request("generationOverrides 超出大小上限"));
    }
    let serde_json::Value::Object(map) = value else {
        return Err(invalid_request("generationOverrides 必须是 JSON 对象"));
    };
    let mut normalized = serde_json::Map::new();
    for (key, field) in map {
        match key.as_str() {
            "maxOutputTokens" => {
                // 契约要求 1..=1_000_000 的整数。`as_f64` + fract==0 与 zod
                // `int()` 同语义：`5e5`/`500000.0` 这类整数值浮点字面量也
                // 算整数；NaN/±inf 在 JSON 中不存在，无需另行排除。
                let tokens = field.as_f64().filter(|f| f.fract() == 0.0);
                match tokens {
                    Some(t)
                        if (1.0..=HOSTED_GENERATION_OVERRIDE_MAX_OUTPUT_TOKENS as f64)
                            .contains(&t) =>
                    {
                        normalized
                            .insert("maxOutputTokens".to_string(), serde_json::json!(t as u64));
                    }
                    _ => {
                        return Err(invalid_request(
                            "generationOverrides.maxOutputTokens 必须是 1..=1_000_000 的整数",
                        ))
                    }
                }
            }
            "temperature" => match field.as_f64() {
                // 契约 `finite().min(0)`：上限由服务端按模型能力裁决，native 不硬编码。
                Some(temperature) if temperature.is_finite() && temperature >= 0.0 => {
                    normalized.insert("temperature".to_string(), serde_json::json!(temperature));
                }
                _ => {
                    return Err(invalid_request(
                        "generationOverrides.temperature 必须是不小于 0 的有限数字",
                    ))
                }
            },
            "thinking" => {
                normalized.insert(
                    "thinking".to_string(),
                    normalize_hosted_thinking_override(field)?,
                );
            }
            _ => {
                return Err(invalid_request("generationOverrides 含未知字段"));
            }
        }
    }
    Ok(if normalized.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(normalized))
    })
}

/// `thinking` 子对象的严格受检：与 `DesktopHostedThinkingOverrideSchema`
/// 同语义——strict 对象、`mode` 必填且只能为 `default`/`disabled`/`enabled`、
/// `effort` 仅在 `mode=enabled` 时可携带已知档位（显式 null 按类型错误拒绝）。
fn normalize_hosted_thinking_override(
    value: &serde_json::Value,
) -> Result<serde_json::Value, HostedPresetError> {
    let serde_json::Value::Object(map) = value else {
        return Err(invalid_request(
            "generationOverrides.thinking 必须是 JSON 对象",
        ));
    };
    for key in map.keys() {
        if key != "mode" && key != "effort" {
            return Err(invalid_request("generationOverrides.thinking 含未知字段"));
        }
    }
    // 缺省、null、非字符串、未知枚举值统一按非法 mode 拒绝。
    let mode = match map.get("mode").and_then(serde_json::Value::as_str) {
        Some(mode @ ("default" | "disabled" | "enabled")) => mode,
        _ => return Err(invalid_request("generationOverrides.thinking.mode 非法")),
    };
    let effort = match map.get("effort") {
        None => None,
        Some(effort_value) => match effort_value.as_str() {
            Some(effort @ ("minimal" | "low" | "medium" | "high" | "xhigh" | "max")) => {
                Some(effort)
            }
            _ => return Err(invalid_request("generationOverrides.thinking.effort 非法")),
        },
    };
    // zod union：`effort` 只存在于 mode=enabled 变体；default/disabled 携带
    // effort（含显式 null）即 strict 失败。
    if mode != "enabled" && effort.is_some() {
        return Err(invalid_request(
            "generationOverrides.thinking.effort 仅在 mode=enabled 时允许",
        ));
    }
    let mut normalized = serde_json::json!({ "mode": mode });
    if let Some(effort) = effort {
        normalized["effort"] = serde_json::json!(effort);
    }
    Ok(normalized)
}

/// A fully validated non-secret selection. Validation never reads SecretStore.
pub(crate) struct PreparedPreset {
    provider_id: String,
    model_id: String,
    generation_overrides: Option<Value>,
    secret_ref: String,
}
impl PreparedPreset {
    pub(crate) fn validate(config: &HostedPresetConfig) -> Result<Self, HostedPresetError> {
        let model_id =
            crate::provider_target::resolve_preset_model_id(&config.provider_id, &config.model_id)
                .map_err(|_| HostedPresetError::InvalidSelection)?;
        let secret_ref = crate::provider_target::preset_secret_ref(&config.provider_id)
            .map_err(|_| HostedPresetError::InvalidSelection)?;
        let generation_overrides = config
            .generation_overrides
            .as_ref()
            .map(normalize_hosted_generation_overrides)
            .transpose()?
            .flatten();
        Ok(Self {
            provider_id: config.provider_id.clone(),
            model_id,
            generation_overrides,
            secret_ref,
        })
    }
    pub(crate) fn public_config(&self) -> Value {
        let mut value = json!({"providerId":self.provider_id,"modelId":self.model_id});
        if let Some(overrides) = &self.generation_overrides {
            value["generationOverrides"] = overrides.clone();
        }
        value
    }
    pub(crate) fn resolve(
        self,
        secrets: &dyn SecretStore,
    ) -> Result<(Value, PresetKeyGuard), HostedPresetError> {
        let raw = read_key(secrets, &self.secret_ref)?;
        let key = raw.trim().to_owned();
        drop(raw);
        let mut provider =
            json!({"providerId":self.provider_id,"modelId":self.model_id,"apiKey":key});
        if let Some(overrides) = self.generation_overrides {
            provider["generationOverrides"] = overrides;
        }
        Ok((
            provider,
            PresetKeyGuard {
                secret_ref: self.secret_ref,
                key,
            },
        ))
    }
}

/// Private original normalized key. Never Debug/Serialize or returned to the renderer.
/// Drop removes reachable retry material; it does not promise byte-wise zeroization.
pub(crate) struct PresetKeyGuard {
    secret_ref: String,
    key: String,
}
impl PresetKeyGuard {
    pub(crate) fn check(&self, secrets: &dyn SecretStore) -> Result<(), HostedPresetError> {
        let raw = read_key(secrets, &self.secret_ref).map_err(|error| match error {
            HostedPresetError::StorageUnavailable => error,
            _ => HostedPresetError::CredentialChanged,
        })?;
        if raw.trim() != self.key {
            return Err(HostedPresetError::CredentialChanged);
        }
        Ok(())
    }
}
fn read_key(secrets: &dyn SecretStore, reference: &str) -> Result<String, HostedPresetError> {
    let raw = secrets
        .resolve(reference)
        .map_err(|_| HostedPresetError::StorageUnavailable)?
        .ok_or(HostedPresetError::CredentialUnavailable)?;
    // Check raw bytes before trim or further copying; existing/externally-written values
    // may exceed the write-time limit. The store's allocation is outside this boundary.
    if raw.len() > MAX_SECRET_VALUE_BYTES || raw.trim().is_empty() {
        return Err(HostedPresetError::CredentialUnavailable);
    }
    Ok(raw)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::secret::SecretStoreError;
    use std::collections::BTreeMap;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    };

    #[derive(Default)]
    pub(crate) struct SyntheticStore {
        pub(crate) entries: Mutex<BTreeMap<String, String>>,
        pub(crate) reads: Mutex<Vec<String>>,
        pub(crate) fail: AtomicBool,
    }
    impl SecretStore for SyntheticStore {
        fn set(&self, reference: &str, value: &str) -> Result<(), SecretStoreError> {
            self.entries
                .lock()
                .unwrap()
                .insert(reference.into(), value.into());
            Ok(())
        }
        fn exists(&self, reference: &str) -> Result<bool, SecretStoreError> {
            Ok(self.entries.lock().unwrap().contains_key(reference))
        }
        fn delete(&self, reference: &str) -> Result<(), SecretStoreError> {
            self.entries.lock().unwrap().remove(reference);
            Ok(())
        }
        fn resolve(&self, reference: &str) -> Result<Option<String>, SecretStoreError> {
            self.reads.lock().unwrap().push(reference.into());
            if self.fail.load(Ordering::SeqCst) {
                return Err(SecretStoreError::failure_for_test());
            }
            Ok(self.entries.lock().unwrap().get(reference).cloned())
        }
    }
    fn config(provider: &str, model: &str, overrides: Option<Value>) -> HostedPresetConfig {
        HostedPresetConfig {
            provider_id: provider.into(),
            model_id: model.into(),
            generation_overrides: overrides,
        }
    }
    #[test]
    fn real_catalog_selection_and_invalid_overrides_are_secret_free() {
        let store = SyntheticStore::default();
        for c in [
            config("unknown", "m", None),
            config("deepseek", "", None),
            config("deepseek", "m", Some(json!({"temperature":-1}))),
            config("deepseek", "m", Some(json!({"maxOutputTokens":0}))),
            config(
                "deepseek",
                "m",
                Some(json!({"thinking":{"mode":"default","effort":"high"}})),
            ),
            config("deepseek", "m", Some(json!({"url":"no"}))),
            config("deepseek", "m", Some(Value::Null)),
            config("deepseek", &"😀".repeat(101), None),
            config("deepseek", "\u{0085}", None),
        ] {
            assert!(PreparedPreset::validate(&c).is_err());
        }
        assert!(store.reads.lock().unwrap().is_empty());
        let alias =
            PreparedPreset::validate(&config("deepseek", "deepseek-v4-flash-0731", None)).unwrap();
        assert_eq!(alias.public_config()["modelId"], "deepseek-v4-flash");
        assert!(
            PreparedPreset::validate(&config("google-cloudflare", "handwritten", None)).is_ok()
        );
        for model in [
            "my-handwritten-model".into(),
            "😀".repeat(100),
            "\u{feff}model\u{feff}".into(),
        ] {
            assert!(PreparedPreset::validate(&config("deepseek", &model, None)).is_ok());
        }
    }
    #[test]
    fn real_key_guard_checks_raw_budget_and_normalized_original_value() {
        let store = SyntheticStore::default();
        let reference = "preset:deepseek:api-key";
        for value in [
            String::new(),
            " ".into(),
            "x".repeat(8193),
            format!(" {} ", "x".repeat(8191)),
        ] {
            store.set(reference, &value).unwrap();
            assert!(matches!(
                PreparedPreset::validate(&config("deepseek", "handwritten", None))
                    .unwrap()
                    .resolve(&store),
                Err(HostedPresetError::CredentialUnavailable)
            ));
        }
        store
            .set(reference, &format!(" {} ", "x".repeat(8190)))
            .unwrap();
        let (provider, guard) = PreparedPreset::validate(&config(
            "deepseek",
            "handwritten",
            Some(json!({"temperature":0.8,"thinking":{"mode":"enabled","effort":"high"}})),
        ))
        .unwrap()
        .resolve(&store)
        .unwrap();
        assert_eq!(provider["apiKey"].as_str().unwrap().len(), 8190);
        assert_eq!(guard.check(&store), Ok(()));
        store.fail.store(true, Ordering::SeqCst);
        assert_eq!(
            guard.check(&store),
            Err(HostedPresetError::StorageUnavailable)
        );
        store.fail.store(false, Ordering::SeqCst);
        assert_eq!(guard.check(&store), Ok(()));
        store.set(reference, "changed").unwrap();
        assert_eq!(
            guard.check(&store),
            Err(HostedPresetError::CredentialChanged)
        );
        store.delete(reference).unwrap();
        assert_eq!(
            guard.check(&store),
            Err(HostedPresetError::CredentialChanged)
        );
        assert!(store
            .reads
            .lock()
            .unwrap()
            .iter()
            .all(|value| value == reference));
    }
}
