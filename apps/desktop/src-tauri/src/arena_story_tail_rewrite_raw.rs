//! Fixed-member edits over the Native source. Unknown tokens never round-trip
//! through a renderer JSON object, including nested provider/summary extensions.
use super::*;

const SESSION: &[&str] = &[
    "id",
    "revision",
    "chapterCount",
    "lastChapterId",
    "workingCheckpointId",
    "lastInputCheckpointId",
    "title",
    "titlePreview",
    "titleTruncated",
    "mode",
    "source",
    "chapterPlan",
    "createdAt",
    "updatedAt",
    "branchOf",
    "branchLabel",
    "sessionSummary",
    "summaryMeta",
    "seed",
    "workingCombatants",
    "lastChapterInputCombatants",
];
const SOURCE: &[&str] = &[
    "mode",
    "language",
    "storyLength",
    "customStoryLength",
    "generationMode",
    "providerMode",
    "providerId",
    "modelId",
];
const SUMMARY: &[&str] = &[
    "coveredUntilChapterIndex",
    "coveredChapterIds",
    "mode",
    "refreshedAt",
];
fn same(a: Option<&&RawValue>, b: Option<&&RawValue>) -> Result<(), StoryError> {
    match (a, b) {
        (None, None) => Ok(()),
        (Some(a), Some(b)) if pending::equivalent(a, b)? => Ok(()),
        _ => Err(StoryError::Invalid),
    }
}
fn same_object(
    a: Option<&&RawValue>,
    b: Option<&&RawValue>,
    keys: &[&'static str],
) -> Result<(), StoryError> {
    match (a, b) {
        (Some(a), Some(b)) if a.get().starts_with('{') && b.get().starts_with('{') => {
            let a = authority(a, keys)?;
            let b = authority(b, keys)?;
            for key in keys {
                same(a.get(key), b.get(key))?;
            }
            Ok(())
        }
        _ => same(a, b),
    }
}
fn raw(text: &str) -> Result<&RawValue, StoryError> {
    serde_json::from_str(text).map_err(|_| StoryError::Invalid)
}

/// Remove whole known members in contiguous runs, or replace just known value
/// spans. Runs deliberately own one adjacent comma; all retained value tokens,
/// key spelling and internal whitespace stay byte-identical.
fn patch(source: &str, replacements: &[(&str, Option<String>)]) -> Result<String, StoryError> {
    let parsed = raw(source)?;
    if !parsed.get().starts_with('{') {
        return Err(StoryError::Invalid);
    }
    let open = source.find('{').ok_or(StoryError::Invalid)?;
    let close = source.rfind('}').ok_or(StoryError::Invalid)?;
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    let mut seen = vec![false; replacements.len()];
    // Only a known-member removal run and the preceding span are retained.
    // Millions of opaque members do not create a member vector or index map.
    let mut removing: Option<(usize, usize, bool)> = None;
    let mut previous_end = open + 1;
    let mut has_member = false;
    for member in pending::member_iter(parsed)? {
        let (key, value) = pending::raw_member_parts(member)?;
        let start = member.as_ptr() as usize - source.as_ptr() as usize;
        let end = start + member.len();
        let mut remove = false;
        for (position, (name, replacement)) in replacements.iter().enumerate() {
            if pending::raw_key_equals(key, name)? {
                if std::mem::replace(&mut seen[position], true) {
                    return Err(StoryError::Invalid);
                }
                if let Some(replacement) = replacement {
                    let start = value.get().as_ptr() as usize - source.as_ptr() as usize;
                    edits.push((start, start + value.get().len(), replacement.clone()));
                } else {
                    remove = true;
                }
                break;
            }
        }
        if remove {
            if let Some((_, last, _)) = removing.as_mut() {
                *last = end;
            } else {
                let first = !has_member;
                let start = if first {
                    open + 1
                } else {
                    source[previous_end..start]
                        .find(',')
                        .ok_or(StoryError::Invalid)?
                        + previous_end
                };
                removing = Some((start, end, first));
            }
        } else {
            if let Some((first, last, at_start)) = removing.take() {
                edits.push((first, if at_start { start } else { last }, String::new()));
            }
            has_member = true;
        }
        previous_end = end;
    }
    if let Some((first, last, at_start)) = removing {
        edits.push((first, if at_start { close } else { last }, String::new()));
    }
    let mut append = String::new();
    for ((name, value), seen) in replacements.iter().zip(seen) {
        if !seen {
            if let Some(value) = value {
                if has_member {
                    append.push(',');
                }
                append.push_str(&serde_json::to_string(name).map_err(|_| StoryError::Invalid)?);
                append.push(':');
                append.push_str(value);
                has_member = true;
            }
        }
    }
    if !append.is_empty() {
        edits.push((close, close, append));
    }
    edits.sort_by_key(|edit| edit.0);
    let mut size = source.len();
    for (start, end, value) in &edits {
        size = size
            .checked_sub(end - start)
            .and_then(|size| size.checked_add(value.len()))
            .ok_or(StoryError::TooLarge)?;
    }
    if size as u64 > CANDIDATE_COMMIT_BYTES {
        return Err(StoryError::TooLarge);
    }
    let mut result = String::new();
    result
        .try_reserve_exact(size)
        .map_err(|_| StoryError::TooLarge)?;
    let mut cursor = 0;
    for (start, end, value) in edits {
        if start < cursor {
            return Err(StoryError::Invalid);
        }
        result.push_str(&source[cursor..start]);
        result.push_str(&value);
        cursor = end;
    }
    result.push_str(&source[cursor..]);
    let _: &RawValue = raw(&result)?;
    Ok(result)
}
fn merge_source(source: &RawValue, candidate: &RawValue) -> Result<String, StoryError> {
    let old = authority(source, SOURCE)?;
    let next = authority(candidate, SOURCE)?;
    for key in [
        "mode",
        "language",
        "storyLength",
        "customStoryLength",
        "generationMode",
    ] {
        same(old.get(key), next.get(key))?;
    }
    let mut replacements = Vec::new();
    for key in ["providerMode", "providerId", "modelId"] {
        if let Some(value) = next.get(key) {
            pending::string_units(value)?;
        }
        // Preserve the original token for unchanged selected values too.
        if same(old.get(key), next.get(key)).is_err() {
            replacements.push((key, next.get(key).map(|v| v.get().to_owned())));
        }
    }
    patch(source.get(), &replacements)
}
pub(super) fn merge_session(
    source: &str,
    candidate: &str,
    tail_index: u64,
) -> Result<String, StoryError> {
    let old = authority(raw(source)?, SESSION)?;
    let next = authority(raw(candidate)?, SESSION)?;
    for key in [
        "id",
        "chapterCount",
        "title",
        "titlePreview",
        "titleTruncated",
        "mode",
        "createdAt",
        "branchLabel",
    ] {
        same(old.get(key), next.get(key))?;
    }
    same_object(
        old.get("chapterPlan"),
        next.get("chapterPlan"),
        &["totalChapters", "source", "locked"],
    )?;
    same_object(
        old.get("branchOf"),
        next.get("branchOf"),
        &["sessionId", "chapterId", "chapterIndex", "chapterTitle"],
    )?;
    for key in ["seed", "workingCombatants", "lastChapterInputCombatants"] {
        if old.contains_key(key) || next.contains_key(key) {
            return Err(StoryError::Invalid);
        }
    }
    let mut changes: Vec<(&str, Option<String>)> = [
        "revision",
        "lastChapterId",
        "workingCheckpointId",
        "lastInputCheckpointId",
        "updatedAt",
    ]
    .iter()
    .map(|key| {
        Ok((
            *key,
            Some(next.get(key).ok_or(StoryError::Invalid)?.get().to_owned()),
        ))
    })
    .collect::<Result<_, StoryError>>()?;
    let merged_source = merge_source(
        old.get("source").ok_or(StoryError::Invalid)?,
        next.get("source").ok_or(StoryError::Invalid)?,
    )?;
    changes.push(("source", Some(merged_source)));
    let meta = old
        .get("summaryMeta")
        .filter(|value| value.get() != "null")
        .map(|value| authority(value, SUMMARY))
        .transpose()?;
    let covered = meta
        .as_ref()
        .and_then(|meta| meta.get("coveredUntilChapterIndex"))
        .map(|v| {
            // This is an existing business original, not a closed wire integer.
            // JSON.parse accepts 1.0 and 1e0 as the same safe integer as 1;
            // retaining a safe summary must retain its original numeric token.
            let number = v.get().parse::<f64>().map_err(|_| StoryError::Invalid)?;
            if !number.is_finite()
                || number < 0.0
                || number > MAX_SAFE_INTEGER as f64
                || number.fract() != 0.0
            {
                return Err(StoryError::Invalid);
            }
            Ok(number as u64)
        })
        .transpose()?
        .unwrap_or(0);
    if covered >= tail_index {
        if next.contains_key("sessionSummary") || next.contains_key("summaryMeta") {
            return Err(StoryError::Invalid);
        }
        changes.push(("sessionSummary", None));
        changes.push(("summaryMeta", None));
    } else {
        same(old.get("sessionSummary"), next.get("sessionSummary"))?;
        same_object(old.get("summaryMeta"), next.get("summaryMeta"), SUMMARY)?;
    }
    patch(source, &changes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opaque_duplicate_member_volume_does_not_change_selected_edit_state() {
        let opaque = r#""x":1.2300e+02,"\ud800":"\udfff","#.repeat(20_000);
        let source = format!("{{\"a\":1,{opaque}\"b\":2}}");
        let output = patch(&source, &[("a", None), ("b", Some("3".into()))]).unwrap();
        assert_eq!(output, format!("{{{opaque}\"b\":3}}"));
    }
    #[test]
    fn removal_runs_preserve_other_value_tokens() {
        for text in [
            r#" { "a":1, "b":2, "x":1.2300e+02, "c":3 } "#,
            r#"{"a":1,"b":2,"c":3}"#,
        ] {
            for mask in 0..8 {
                let keys = ["a", "b", "c"];
                let changes = keys
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| mask & (1 << i) != 0)
                    .map(|(_, k)| (*k, None))
                    .collect::<Vec<_>>();
                let out = patch(text, &changes).unwrap();
                let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
                for (i, k) in keys.iter().enumerate() {
                    assert_eq!(parsed.get(k).is_none(), mask & (1 << i) != 0);
                }
                if text.contains("1.2300e+02") {
                    assert!(out.contains("1.2300e+02"));
                }
            }
        }
    }
}
