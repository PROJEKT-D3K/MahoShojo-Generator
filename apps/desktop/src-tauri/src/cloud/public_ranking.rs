//! Anonymous, fixed-route public ranking reads. No account or provider credentials.
use super::{base_request, CloudError, CloudErrorCode, CloudState, SHORT_REQUEST_TIMEOUT};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

const LEADERBOARD_PATH: &str = "/api/arena/leaderboard";
const SEARCH_PATH: &str = "/api/arena/leaderboard/search";
const TAGS_PATH: &str = "/api/tags";
const SEASONS_PATH: &str = "/config/seasons.json";
const RATING_HISTORY_PATH: &str = "/api/arena/entity-rating-history";
// Client transport guard, not a server eligibility or historical-record cap.
const RATING_HISTORY_MAX_BYTES: usize = 256 * 1024;
const LEADERBOARD_MAX_BYTES: usize = 1024 * 1024;
const SEARCH_MAX_BYTES: usize = 256 * 1024;
const TAGS_MAX_BYTES: usize = 1024 * 1024;
const SEASONS_MAX_BYTES: usize = 256 * 1024;
const ARCHIVE_MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

// Serde's derived structs also accept positional arrays. Every IPC/upstream object
// uses a map-only visitor, including optional objects and elements nested in arrays.
macro_rules! object {
    ($(#[$meta:meta])* $vis:vis struct $name:ident { $($(#[$attr:meta])* $field:ident: $ty:ty,)* }) => {
        #[derive(Debug, Serialize)]
        #[serde(rename_all = "camelCase")]
        $(#[$meta])*
        $vis struct $name { $($(#[$attr])* $field: $ty,)* }
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                $(#[$meta])*
                struct Fields { $($(#[$attr])* $field: $ty,)* }
                struct ObjectOnly;
                impl<'de> serde::de::Visitor<'de> for ObjectOnly {
                    type Value = $name;
                    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        f.write_str(concat!(stringify!($name), " object"))
                    }
                    fn visit_map<A: serde::de::MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
                        let fields = Fields::deserialize(serde::de::value::MapAccessDeserializer::new(map))?;
                        Ok($name { $($field: fields.$field,)* })
                    }
                }
                deserializer.deserialize_map(ObjectOnly)
            }
        }
    };
}

#[derive(Debug, Serialize)]
#[serde(transparent)]
struct SafeInteger(i64);
impl<'de> Deserialize<'de> for SafeInteger {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Integer;
        impl serde::de::Visitor<'_> for Integer {
            type Value = SafeInteger;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a JavaScript safe integer")
            }
            fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Self::Value, E> {
                if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&value) {
                    Ok(SafeInteger(value))
                } else {
                    Err(E::custom("integer outside JavaScript safe range"))
                }
            }
            fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
                if value <= MAX_SAFE_INTEGER as u64 {
                    Ok(SafeInteger(value as i64))
                } else {
                    Err(E::custom("integer outside JavaScript safe range"))
                }
            }
            fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Self::Value, E> {
                if value.is_finite()
                    && value.fract() == 0.0
                    && value.abs() <= MAX_SAFE_INTEGER as f64
                {
                    Ok(SafeInteger(value as i64))
                } else {
                    Err(E::custom("expected JavaScript safe integer"))
                }
            }
        }
        deserializer.deserialize_any(Integer)
    }
}
fn natural<'de, D: serde::Deserializer<'de>>(d: D) -> Result<SafeInteger, D::Error> {
    let value = SafeInteger::deserialize(d)?;
    if value.0 < 0 {
        return Err(serde::de::Error::custom(
            "expected nonnegative safe integer",
        ));
    }
    Ok(value)
}
// A required nullable field must reject absence, not silently act as optional.
fn nullable<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d)
}

fn present<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(d).map(Some)
}

macro_rules! string_enum {
    ($name:ident { $($variant:ident => $wire:literal),* $(,)? }) => {
        #[derive(Debug, Deserialize, Serialize)]
        enum $name { $(#[serde(rename = $wire)] $variant,)* }
    };
}
macro_rules! query_enum {
    ($name:ident { $($variant:ident => $wire:literal),* $(,)? }) => {
        string_enum!($name { $($variant => $wire,)* });
        impl $name {
            fn wire(&self) -> &'static str { match self { $(Self::$variant => $wire,)* } }
        }
    };
}
query_enum!(Queue { Strict => "strict", Free => "free" });
query_enum!(Sort { Rating => "rating", Tech => "tech" });
query_enum!(Order { Desc => "desc", Asc => "asc" });
query_enum!(NativeFilter { Any => "any", Yes => "1", No => "0" });
query_enum!(EntityType { DataCard => "data_card", Preset => "preset" });
string_enum!(StrictQueue { Strict => "strict" });
string_enum!(RatingResult { Win => "win", Loss => "loss", Draw => "draw" });
string_enum!(Tier { Unranked => "无牌", White => "白牌", Word => "字牌", Flower => "花牌", Wand => "权杖" });
string_enum!(TagScope { User => "user", System => "system", Admin => "admin" });
string_enum!(BattleMode { Classic => "classic", Kizuna => "kizuna", Daily => "daily", Scenario => "scenario" });
string_enum!(SeasonStatus { Current => "current", History => "history" });

object! {
    #[serde(deny_unknown_fields)]
    struct RankingFilters {
        queue: Queue,
        sort: Sort,
        order: Order,
        include_presets: bool,
        is_native: NativeFilter,
        include_tag_ids: Vec<String>,
        exclude_tag_ids: Vec<String>,
        #[serde(deserialize_with = "nullable")]
        min_rating: Option<SafeInteger>,
        #[serde(deserialize_with = "nullable")]
        max_rating: Option<SafeInteger>,
        #[serde(deserialize_with = "nullable")]
        min_games: Option<SafeInteger>,
        #[serde(deserialize_with = "nullable")]
        max_games: Option<SafeInteger>,
        #[serde(deserialize_with = "nullable")]
        min_tech_score: Option<SafeInteger>,
        #[serde(deserialize_with = "nullable")]
        max_tech_score: Option<SafeInteger>,
    }
}
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Operation {
    Leaderboard {
        filters: RankingFilters,
        offset: SafeInteger,
        limit: SafeInteger,
    },
    Search {
        filters: RankingFilters,
        q: String,
        limit: SafeInteger,
    },
    RatingHistory {
        #[serde(rename = "entityType")]
        entity_type: EntityType,
        #[serde(rename = "entityId")]
        entity_id: String,
    },
    Tags {},
    Seasons {},
    Archive {
        #[serde(rename = "seasonId")]
        season_id: SeasonId,
    },
}
#[derive(Debug)]
pub struct PublicRankingRequest(Operation);
impl<'de> Deserialize<'de> for PublicRankingRequest {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectOnly;
        impl<'de> serde::de::Visitor<'de> for ObjectOnly {
            type Value = PublicRankingRequest;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a public ranking request object")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                map: A,
            ) -> Result<Self::Value, A::Error> {
                Operation::deserialize(serde::de::value::MapAccessDeserializer::new(map))
                    .map(PublicRankingRequest)
            }
        }
        deserializer.deserialize_map(ObjectOnly)
    }
}
#[derive(Debug, Serialize)]
#[serde(transparent)]
struct SeasonId(String);
impl<'de> Deserialize<'de> for SeasonId {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let value = String::deserialize(d)?;
        if value.is_empty()
            || value.len() > 32
            || !value.as_bytes()[0].is_ascii_alphanumeric()
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err(serde::de::Error::custom("invalid season identifier"));
        }
        Ok(Self(value))
    }
}
fn trim_query(q: &str) -> &str {
    q.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}
impl PublicRankingRequest {
    fn route(&self) -> Result<(String, usize), CloudError> {
        let invalid = || CloudError::new(CloudErrorCode::InvalidRequest, "排行榜读取参数无效");
        let (filters, limit, path, extra, budget) = match &self.0 {
            Operation::RatingHistory {
                entity_type,
                entity_id,
            } => {
                let id = trim_query(entity_id);
                if id.is_empty() {
                    return Err(invalid());
                }
                let mut query = url::form_urlencoded::Serializer::new(String::new());
                query.extend_pairs([
                    ("entityType", entity_type.wire()),
                    ("entityId", id),
                    ("queue", "strict"),
                ]);
                return Ok((
                    format!("{RATING_HISTORY_PATH}?{}", query.finish()),
                    RATING_HISTORY_MAX_BYTES,
                ));
            }
            Operation::Tags {} => return Ok((TAGS_PATH.to_string(), TAGS_MAX_BYTES)),
            Operation::Seasons {} => return Ok((SEASONS_PATH.to_string(), SEASONS_MAX_BYTES)),
            Operation::Archive { season_id } => {
                return Ok((
                    format!("/data/seasons/archive_{}.json", season_id.0),
                    ARCHIVE_MAX_BYTES,
                ))
            }
            Operation::Leaderboard {
                filters,
                offset,
                limit,
            } => {
                if !(0..=300).contains(&offset.0) || !(1..=100).contains(&limit.0) {
                    return Err(invalid());
                }
                (
                    filters,
                    limit,
                    LEADERBOARD_PATH,
                    ("offset", offset.0.to_string()),
                    LEADERBOARD_MAX_BYTES,
                )
            }
            Operation::Search { filters, q, limit } => {
                let q = trim_query(q);
                if q.is_empty() || q.encode_utf16().count() > 80 || !(1..=20).contains(&limit.0) {
                    return Err(invalid());
                }
                (
                    filters,
                    limit,
                    SEARCH_PATH,
                    ("q", q.to_string()),
                    SEARCH_MAX_BYTES,
                )
            }
        };
        for tags in [&filters.include_tag_ids, &filters.exclude_tag_ids] {
            if tags.len() > 100 || tags.iter().any(|tag| tag.encode_utf16().count() > 200) {
                return Err(invalid());
            }
        }
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        query.extend_pairs([
            ("queue", filters.queue.wire()),
            ("sort", filters.sort.wire()),
            ("order", filters.order.wire()),
            (
                "includePresets",
                if filters.include_presets { "1" } else { "0" },
            ),
            ("isNative", filters.is_native.wire()),
        ]);
        query
            .append_pair("limit", &limit.0.to_string())
            .append_pair(extra.0, &extra.1);
        for (name, tags) in [
            ("tagIds", &filters.include_tag_ids),
            ("excludeTagIds", &filters.exclude_tag_ids),
        ] {
            if !tags.is_empty() {
                query.append_pair(name, &tags.join(","));
            }
        }
        for (name, value) in [
            ("minRating", &filters.min_rating),
            ("maxRating", &filters.max_rating),
            ("minGames", &filters.min_games),
            ("maxGames", &filters.max_games),
            ("minTechScore", &filters.min_tech_score),
            ("maxTechScore", &filters.max_tech_score),
        ] {
            if let Some(value) = value {
                query.append_pair(name, &value.0.to_string());
            }
        }
        Ok((format!("{path}?{}", query.finish()), budget))
    }
}

// Only these public fields cross IPC. Unknown upstream keys are discarded at
// every object level. Only declared public identifiers and summary facts survive.
object! { struct RatingOpponent { entity_type: EntityType, entity_id: String, display_name: String, } }
object! {
    struct RatingInitiator {
        #[serde(deserialize_with = "nullable")]
        user_id: Option<SafeInteger>,
        #[serde(deserialize_with = "nullable")]
        username: Option<String>,
    }
}
object! {
    struct RatingHistoryItem {
        generation_id: String,
        created_at: String,
        #[serde(deserialize_with = "nullable")]
        applied_at: Option<String>,
        opponent: RatingOpponent,
        result: RatingResult,
        delta: SafeInteger,
        after_rating: SafeInteger,
        initiator: RatingInitiator,
    }
}
object! {
    pub struct RatingHistory {
        success: bool,
        entity_type: EntityType,
        entity_id: String,
        queue: StrictQueue,
        items: Vec<RatingHistoryItem>,
    }
}
object! { struct SeasonExtreme { rating: f64, games: f64, occurred_at: String, tier: Tier, } }
object! {
    pub struct RankingItem {
        #[serde(deserialize_with = "natural")]
        rank: SafeInteger,
        entity_type: EntityType,
        entity_id: String,
        display_name: String,
        #[serde(deserialize_with = "nullable")]
        author_name: Option<String>,
        rating: f64,
        games: f64,
        wins: f64,
        losses: f64,
        draws: f64,
        tier: String,
        #[serde(deserialize_with = "nullable")]
        tech_score: Option<f64>,
        #[serde(deserialize_with = "nullable")]
        tech_level: Option<String>,
        #[serde(deserialize_with = "nullable")]
        is_native: Option<bool>,
        tag_ids: Vec<String>,
        rating_updated_at: Option<String>,
        season_peak: Option<SeasonExtreme>,
        season_peak_tier: Option<String>,
        season_low: Option<SeasonExtreme>,
    }
}
object! { pub struct RankingList { success: bool, items: Vec<RankingItem>, } }
object! {
    struct RankingTag {
        id: String,
        name: String,
        #[serde(deserialize_with = "nullable")]
        description: Option<String>,
        #[serde(deserialize_with = "nullable")]
        category: Option<String>,
        scope: TagScope,
        is_active: bool,
    }
}
object! { pub struct RankingTags { success: bool, tags: Vec<RankingTag>, } }
object! {
    struct SpecialRules {
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        mode: Option<BattleMode>,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        story_guidance: Option<String>,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        scenario_preset_filename: Option<String>,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        questionnaire_lore_allowed: Option<bool>,
        #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
        questionnaire_lore_preset_ids: Option<Vec<String>>,
    }
}
object! {
    struct SeasonFacts {
        id: SeasonId,
        name: String,
        starts_at: String,
        ends_at: Option<String>,
        description: String,
        special_rules: Option<SpecialRules>,
    }
}
object! {
    struct SeasonMeta {
        #[serde(flatten)]
        facts: SeasonFacts,
        status: SeasonStatus,
        archived_at: Option<String>,
    }
}
#[derive(Debug, Serialize)]
#[serde(transparent)]
struct Version<const V: u8>(u8);
impl<'de, const V: u8> Deserialize<'de> for Version<V> {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        if SafeInteger::deserialize(d)?.0 != i64::from(V) {
            return Err(serde::de::Error::custom("unsupported schema version"));
        }
        Ok(Self(V))
    }
}
object! { pub struct Seasons { schema_version: Version<1>, seasons: Vec<SeasonMeta>, } }
object! {
    struct QueueSnapshot {
        rating: f64,
        games: f64,
        wins: f64,
        losses: f64,
        draws: f64,
        #[serde(deserialize_with = "nullable")]
        rating_updated_at: Option<String>,
        season_peak_rating: Option<f64>,
        season_peak_games: Option<f64>,
        season_peak_at: Option<String>,
        season_peak_tier: Option<String>,
        season_low_rating: Option<f64>,
        season_low_games: Option<f64>,
        season_low_at: Option<String>,
    }
}
object! { struct EntityQueues { strict: Option<QueueSnapshot>, free: Option<QueueSnapshot>, } }
object! {
    struct SeasonEntity {
        entity_type: EntityType,
        entity_id: String,
        display_name: String,
        author_name: Option<String>,
        #[serde(deserialize_with = "nullable")]
        tech_score: Option<f64>,
        #[serde(deserialize_with = "nullable")]
        tech_level: Option<String>,
        #[serde(deserialize_with = "nullable")]
        is_native: Option<bool>,
        tag_ids: Vec<String>,
        queues: EntityQueues,
    }
}
object! { struct EntityRef { entity_type: EntityType, entity_id: String, } }
object! {
    struct ArchiveBoard {
        queue: Queue,
        #[serde(deserialize_with = "natural")]
        total: SafeInteger,
        top: Vec<EntityRef>,
        bottom: Vec<EntityRef>,
    }
}
object! { struct ArchiveBoards { strict: ArchiveBoard, free: ArchiveBoard, } }
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
enum PolicyFields {
    Full,
    TopBottom {
        #[serde(deserialize_with = "natural")]
        top: SafeInteger,
        #[serde(deserialize_with = "natural")]
        bottom: SafeInteger,
    },
}
#[derive(Debug, Serialize)]
#[serde(transparent)]
struct SnapshotPolicy(PolicyFields);
impl<'de> Deserialize<'de> for SnapshotPolicy {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct ObjectOnly;
        impl<'de> serde::de::Visitor<'de> for ObjectOnly {
            type Value = SnapshotPolicy;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a snapshot policy object")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                map: A,
            ) -> Result<Self::Value, A::Error> {
                PolicyFields::deserialize(serde::de::value::MapAccessDeserializer::new(map))
                    .map(SnapshotPolicy)
            }
        }
        d.deserialize_map(ObjectOnly)
    }
}
object! {
    struct EligibleTotals {
        #[serde(deserialize_with = "natural")]
        strict: SafeInteger,
        #[serde(deserialize_with = "natural")]
        free: SafeInteger,
    }
}
object! {
    pub struct ArchiveV2 {
        schema_version: Version<2>,
        generated_at: String,
        season: SeasonFacts,
        entities: Vec<SeasonEntity>,
        leaderboards: ArchiveBoards,
    }
}
object! {
    pub struct ArchiveV3 {
        schema_version: Version<3>,
        generated_at: String,
        season: SeasonFacts,
        entities: Vec<SeasonEntity>,
        snapshot_policy: SnapshotPolicy,
        total_eligible: EligibleTotals,
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum SeasonArchive {
    V2(ArchiveV2),
    V3(ArchiveV3),
}
impl SeasonArchive {
    fn season_id(&self) -> &str {
        match self {
            Self::V2(value) => &value.season.id.0,
            Self::V3(value) => &value.season.id.0,
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum PublicRankingResponse {
    Leaderboard(RankingList),
    Search(RankingList),
    Tags(RankingTags),
    Seasons(Seasons),
    Archive(Box<SeasonArchive>),
    RatingHistory(RatingHistory),
}

pub async fn read_public_ranking(
    state: &CloudState,
    request: PublicRankingRequest,
) -> Result<PublicRankingResponse, CloudError> {
    let (path, budget) = request.route()?;
    // CloudState's client has no default auth headers or cookie jar. Only the
    // private authed_request helper adds credentials; it is never called here.
    let response = base_request(&state.http, reqwest::Method::GET, &state.origin, &path)
        .timeout(SHORT_REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| CloudError::new(CloudErrorCode::NetworkError, "排行榜网络请求失败，请重试"))?;
    if !response.status().is_success() {
        let (code, message) = match response.status().as_u16() {
            404 => (CloudErrorCode::NotFound, "排行榜数据不存在或尚未归档"),
            429 => (
                CloudErrorCode::ServerUnavailable,
                "排行榜请求过于频繁，请稍后重试",
            ),
            _ => (
                CloudErrorCode::ServerUnavailable,
                "排行榜服务暂时不可用，请稍后重试",
            ),
        };
        return Err(CloudError::new(code, message));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|_| CloudError::new(CloudErrorCode::NetworkError, "排行榜读取中断，请重试"))?;
        if chunk.len() > budget.saturating_sub(bytes.len()) {
            return Err(CloudError::new(
                CloudErrorCode::ResponseTooLarge,
                "排行榜内容过大，暂时无法加载",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let incompatible = || {
        CloudError::new(
            CloudErrorCode::ProtocolMismatch,
            "服务器排行榜协议不兼容，请更新服务后重试",
        )
    };
    match request.0 {
        Operation::Leaderboard { limit, offset, .. } => {
            let data: RankingList = serde_json::from_slice(&bytes).map_err(|_| incompatible())?;
            if !data.success
                || data.items.len() > limit.0.min(300 - offset.0) as usize
                || data
                    .items
                    .iter()
                    .enumerate()
                    .any(|(index, item)| item.rank.0 != offset.0 + index as i64 + 1)
            {
                return Err(incompatible());
            }
            Ok(PublicRankingResponse::Leaderboard(data))
        }
        Operation::Search { limit, .. } => {
            let data: RankingList = serde_json::from_slice(&bytes).map_err(|_| incompatible())?;
            if !data.success
                || data.items.len() > limit.0 as usize
                || data.items.iter().any(|item| item.rank.0 != 0)
            {
                return Err(incompatible());
            }
            Ok(PublicRankingResponse::Search(data))
        }
        Operation::RatingHistory {
            entity_type,
            entity_id,
        } => {
            let data: RatingHistory = serde_json::from_slice(&bytes).map_err(|_| incompatible())?;
            if !data.success
                || data.entity_type.wire() != entity_type.wire()
                || data.entity_id != trim_query(&entity_id)
                || data.items.len() > 10
            {
                return Err(incompatible());
            }
            Ok(PublicRankingResponse::RatingHistory(data))
        }
        Operation::Tags {} => {
            let data: RankingTags = serde_json::from_slice(&bytes).map_err(|_| incompatible())?;
            if !data.success {
                return Err(incompatible());
            }
            Ok(PublicRankingResponse::Tags(data))
        }
        Operation::Seasons {} => serde_json::from_slice(&bytes)
            .map(PublicRankingResponse::Seasons)
            .map_err(|_| incompatible()),
        Operation::Archive { season_id } => {
            let data: SeasonArchive = serde_json::from_slice(&bytes).map_err(|_| incompatible())?;
            if data.season_id() != season_id.0 {
                return Err(incompatible());
            }
            Ok(PublicRankingResponse::Archive(Box::new(data)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::oneshot;

    const KINDS: [&str; 6] = [
        "leaderboard",
        "search",
        "tags",
        "seasons",
        "archive",
        "ratingHistory",
    ];
    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../../packages/contracts/fixtures/public-ranking.json"
        ))
        .unwrap()
    }
    fn request(kind: &str) -> PublicRankingRequest {
        serde_json::from_value(fixture()["requests"][kind].clone()).unwrap()
    }
    fn invalid_request(value: Value) -> bool {
        serde_json::from_value::<PublicRankingRequest>(value)
            .map(|request| request.route().is_err())
            .unwrap_or(true)
    }
    async fn server(
        status: u16,
        body: Vec<u8>,
        extra: &str,
    ) -> (
        String,
        oneshot::Receiver<String>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let extra = extra.to_string();
        let (tx, rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut one = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut one).await.unwrap();
                head.push(one[0]);
                assert!(head.len() < 128 * 1024);
            }
            let _ = tx.send(String::from_utf8(head).unwrap());
            if socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n{extra}\r\n").as_bytes()).await.is_err() { return; }
            // Deliberately split UTF-8 scalars across streamed chunks.
            for chunk in body.chunks(32_771) {
                if socket
                    .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                    .await
                    .is_err()
                {
                    return;
                }
                if socket.write_all(chunk).await.is_err() {
                    return;
                }
                if socket.write_all(b"\r\n").await.is_err() {
                    return;
                }
            }
            let _ = socket.write_all(b"0\r\n\r\n").await;
        });
        (origin, rx, task)
    }
    async fn read_bytes(
        kind: &str,
        status: u16,
        bytes: Vec<u8>,
    ) -> Result<PublicRankingResponse, CloudError> {
        let (origin, _, task) = server(status, bytes, "").await;
        let result = read_public_ranking(&CloudState::with_origin(&origin), request(kind)).await;
        task.await.unwrap();
        result
    }
    async fn read(kind: &str, body: Value) -> Result<PublicRankingResponse, CloudError> {
        read_bytes(kind, 200, serde_json::to_vec(&body).unwrap()).await
    }
    fn add_private_fields(value: &mut Value) {
        match value {
            Value::Object(map) => {
                for value in map.values_mut() {
                    add_private_fields(value);
                }
                map.insert("privateMetadata".to_string(), json!("DO-NOT-LEAK"));
                map.insert("apiKey".to_string(), json!("DO-NOT-LEAK"));
                map.insert("cookie".to_string(), json!("DO-NOT-LEAK"));
                map.insert("authorId".to_string(), json!(999));
                map.insert("cardData".to_string(), json!({"secret":"DO-NOT-LEAK"}));
            }
            Value::Array(values) => {
                for value in values {
                    add_private_fields(value);
                }
            }
            _ => {}
        }
    }
    fn object_paths(value: &Value, prefix: &str, paths: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                paths.push(prefix.to_string());
                for (key, value) in map {
                    object_paths(value, &format!("{prefix}/{key}"), paths);
                }
            }
            Value::Array(values) => {
                for (index, value) in values.iter().enumerate() {
                    object_paths(value, &format!("{prefix}/{index}"), paths);
                }
            }
            _ => {}
        }
    }
    fn probe(name: &str, value: &Value) {
        if let Some(directory) = std::env::var_os("PUBLIC_RANKING_NATIVE_WIRE_DIR") {
            std::fs::write(
                std::path::PathBuf::from(directory).join(format!("{name}.json")),
                serde_json::to_vec(value).unwrap(),
            )
            .unwrap();
        }
    }

    #[test]
    fn frozen_paths_budgets_and_strict_requests() {
        let f = fixture();
        for (kind, budget) in [
            ("leaderboard", LEADERBOARD_MAX_BYTES),
            ("search", SEARCH_MAX_BYTES),
            ("tags", TAGS_MAX_BYTES),
            ("seasons", SEASONS_MAX_BYTES),
            ("archive", ARCHIVE_MAX_BYTES),
            ("ratingHistory", RATING_HISTORY_MAX_BYTES),
        ] {
            let route = request(kind).route().unwrap();
            assert_eq!(route.1, budget);
            assert_eq!(f["budgets"][kind], budget);
            assert_eq!(f["paths"][kind], route.0.split('?').next().unwrap());
            for field in [
                "url",
                "method",
                "headers",
                "cookie",
                "body",
                "path",
                "query",
                "expectedUserId",
            ] {
                let mut value = f["requests"][kind].clone();
                value[field] = json!("escape");
                assert!(invalid_request(value), "{kind}/{field}");
            }
            assert!(invalid_request(json!([kind])));
        }
        assert_eq!(request("leaderboard").route().unwrap().0, "/api/arena/leaderboard?queue=strict&sort=rating&order=desc&includePresets=1&isNative=any&limit=50&offset=0");
        assert_eq!(request("search").route().unwrap().0, "/api/arena/leaderboard/search?queue=strict&sort=rating&order=desc&includePresets=1&isNative=any&limit=10&q=%E5%90%8D%E7%A7%B0+%26+%2F+%3F+%E4%B8%AD%E6%96%87");
        assert!(invalid_request(json!({"kind":"unknown"})));
        for value in [json!(null), json!("tags"), json!(["tags"]), json!(1)] {
            assert!(invalid_request(value));
        }
        for path in [
            "", "../x", "a/b", "a\\b", "a?b", "a#b", "%2f", "s\r\n", "😀", "_s", "a.b",
        ] {
            assert!(
                invalid_request(json!({"kind":"archive","seasonId":path})),
                "{path:?}"
            );
        }
        assert!(invalid_request(
            json!({"kind":"archive","seasonId":"a".repeat(33)})
        ));
        assert!(!invalid_request(
            json!({"kind":"archive","seasonId":"A_0-9"})
        ));
        for kind in ["leaderboard", "search"] {
            let mut value = f["requests"][kind].clone();
            value["filters"] = json!([
                "strict",
                "rating",
                "desc",
                true,
                "any",
                [],
                [],
                null,
                null,
                null,
                null,
                null,
                null
            ]);
            assert!(invalid_request(value));
            let mut value = f["requests"][kind].clone();
            value["filters"]["path"] = json!("escape");
            assert!(invalid_request(value));
            for field in [
                "minRating",
                "maxRating",
                "minGames",
                "maxGames",
                "minTechScore",
                "maxTechScore",
            ] {
                for number in [
                    json!("1"),
                    json!(true),
                    json!(1.5),
                    json!(9_007_199_254_740_992_u64),
                    json!(-9_007_199_254_740_992_i64),
                    json!([1]),
                ] {
                    let mut value = f["requests"][kind].clone();
                    value["filters"][field] = number;
                    assert!(invalid_request(value), "{kind}/{field}");
                }
                let mut value = f["requests"][kind].clone();
                value["filters"].as_object_mut().unwrap().remove(field);
                assert!(invalid_request(value), "missing {field}");
                for number in [
                    json!(1.0),
                    json!(-9_007_199_254_740_991_i64),
                    json!(9_007_199_254_740_991_u64),
                    json!(null),
                ] {
                    let mut value = f["requests"][kind].clone();
                    value["filters"][field] = number;
                    assert!(!invalid_request(value), "valid {field}");
                }
            }
            for field in ["includeTagIds", "excludeTagIds"] {
                for tags in [
                    json!(["😀".repeat(101)]),
                    json!(vec!["tag"; 101]),
                    json!([null]),
                    json!("tag"),
                ] {
                    let mut value = f["requests"][kind].clone();
                    value["filters"][field] = tags;
                    assert!(invalid_request(value));
                }
            }
        }
        for (kind, field, bad) in [
            ("leaderboard", "offset", json!(-1)),
            ("leaderboard", "offset", json!(301)),
            ("leaderboard", "limit", json!(101)),
            ("search", "limit", json!(21)),
            ("search", "q", json!("😀".repeat(41))),
            ("search", "q", json!(" \u{feff}\t ")),
        ] {
            let mut value = f["requests"][kind].clone();
            value[field] = bad;
            assert!(invalid_request(value));
        }
        for bad in [json!(0), json!(null), json!("10"), json!([10]), json!(1.5)] {
            let mut value = f["requests"]["leaderboard"].clone();
            value["limit"] = bad;
            assert!(invalid_request(value));
        }
    }

    #[tokio::test]
    async fn anonymous_fixed_gets_project_nested_fields_and_emit_real_wire() {
        for kind in KINDS {
            let mut body = fixture()["responses"][kind].clone();
            add_private_fields(&mut body);
            let (origin, seen, task) = server(
                200,
                serde_json::to_vec(&body).unwrap(),
                "Set-Cookie: synthetic=must-not-persist\r\n",
            )
            .await;
            let state = CloudState::with_origin(&origin);
            // No SecretStore argument exists in this API or its Tauri command.
            let output = read_public_ranking(&state, request(kind)).await.unwrap();
            let head = seen.await.unwrap();
            assert!(head.starts_with(&format!(
                "GET {} HTTP/1.1\r\n",
                request(kind).route().unwrap().0
            )));
            let lower = head.to_ascii_lowercase();
            for forbidden in [
                "authorization:",
                "cookie:",
                "x-api-key:",
                "provider-key",
                "api-key:",
            ] {
                assert!(!lower.contains(forbidden), "{lower}");
            }
            task.await.unwrap();
            let output = serde_json::to_value(output).unwrap();
            let encoded = output.to_string();
            for forbidden in [
                "DO-NOT-LEAK",
                "DROP",
                "privateMetadata",
                "authorId",
                "cardData",
            ] {
                assert!(!encoded.contains(forbidden), "{kind}/{forbidden}");
            }
            assert_eq!(output["kind"], kind);
            probe(kind, &output);
        }
    }

    #[test]
    fn anonymous_command_and_permission_are_registered_without_secret_state() {
        let command = include_str!("../lib.rs");
        let body = command
            .split("async fn cloud_public_ranking_read(")
            .nth(1)
            .unwrap()
            .split("\n}\n")
            .next()
            .unwrap();
        assert!(!body.contains("secrets"));
        assert!(!body.contains("SharedSecretStore"));
        assert!(body.contains("read_public_ranking(&cloud, request).await"));
        assert!(command.contains("            cloud_public_ranking_read,"));
        assert!(include_str!("../../build.rs").contains("\"cloud_public_ranking_read\""));
        let capabilities: Value =
            serde_json::from_str(include_str!("../../capabilities/main-ui.json")).unwrap();
        assert!(capabilities["permissions"]
            .as_array()
            .unwrap()
            .contains(&json!("allow-cloud-public-ranking-read")));
    }

    #[tokio::test]
    async fn unicode_queries_are_trimmed_once_and_encoded_once() {
        let mut value = fixture()["requests"]["search"].clone();
        let q = "中文 😀 +%&?#=";
        value["q"] = json!(format!(" \u{feff}{q}\n"));
        value["filters"]["includeTagIds"] = json!(["中文 +%&?#=", "第二"]);
        value["filters"]["minRating"] = json!(-9_007_199_254_740_991_i64);
        let request: PublicRankingRequest = serde_json::from_value(value).unwrap();
        let (origin, seen, task) = server(
            200,
            serde_json::to_vec(&fixture()["responses"]["search"]).unwrap(),
            "",
        )
        .await;
        read_public_ranking(&CloudState::with_origin(&origin), request)
            .await
            .unwrap();
        let head = seen.await.unwrap();
        let path = head.split_whitespace().nth(1).unwrap();
        let url = url::Url::parse(&format!("{origin}{path}")).unwrap();
        let query: std::collections::HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(query["q"], q);
        assert_eq!(query["tagIds"], "中文 +%&?#=,第二");
        assert_eq!(query["minRating"], "-9007199254740991");
        assert_eq!(url.path(), SEARCH_PATH);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn all_response_objects_reject_positional_arrays() {
        for kind in KINDS {
            let output = read(kind, fixture()["responses"][kind].clone())
                .await
                .unwrap();
            let original = serde_json::to_value(output).unwrap()["data"].clone();
            let mut paths = Vec::new();
            object_paths(&original, "", &mut paths);
            for path in paths {
                let mut body = original.clone();
                let value = body.pointer_mut(&path).unwrap();
                *value = Value::Array(value.as_object().unwrap().values().cloned().collect());
                let error = read(kind, body).await.unwrap_err();
                assert_eq!(
                    error.code,
                    CloudErrorCode::ProtocolMismatch,
                    "{kind}/{path}"
                );
            }
        }
    }

    #[tokio::test]
    async fn response_semantics_optional_fields_and_archive_versions() {
        let original = fixture()["responses"]["archive"].clone();
        let mut ignored_array = original.clone();
        ignored_array["entities"][0]["data"] = json!(["private card body"]);
        let projected =
            serde_json::to_value(read("archive", ignored_array).await.unwrap()).unwrap();
        assert!(projected["data"]["entities"][0].get("data").is_none());
        let mut v3 = original.clone();
        v3["schemaVersion"] = json!(3);
        v3["snapshotPolicy"] = json!({"mode":"full","ignored":"DO-NOT-LEAK"});
        v3["season"].as_object_mut().unwrap().remove("specialRules");
        v3["season"].as_object_mut().unwrap().remove("endsAt");
        for entity in v3["entities"].as_array_mut().unwrap() {
            entity.as_object_mut().unwrap().remove("authorName");
        }
        let output = serde_json::to_value(read("archive", v3.clone()).await.unwrap()).unwrap();
        assert_eq!(output["data"]["snapshotPolicy"], json!({"mode":"full"}));
        probe("archive-full", &output);
        let mut v2 = v3;
        v2["schemaVersion"] = json!(2);
        v2["leaderboards"] = json!({"strict":{"queue":"strict","total":1,"top":[{"entityType":"preset","entityId":"synthetic"}],"bottom":[]},"free":{"queue":"free","total":0,"top":[],"bottom":[]}});
        v2.as_object_mut().unwrap().remove("snapshotPolicy");
        v2.as_object_mut().unwrap().remove("totalEligible");
        let output = serde_json::to_value(read("archive", v2.clone()).await.unwrap()).unwrap();
        assert_eq!(output["data"]["schemaVersion"], 2);
        probe("archive-v2", &output);
        let v2 = output["data"].clone();
        let mut paths = Vec::new();
        object_paths(&v2, "", &mut paths);
        for path in paths {
            let mut body = v2.clone();
            let value = body.pointer_mut(&path).unwrap();
            *value = Value::Array(value.as_object().unwrap().values().cloned().collect());
            assert_eq!(
                read("archive", body).await.unwrap_err().code,
                CloudErrorCode::ProtocolMismatch,
                "v2/{path}"
            );
        }
        let mut top_bottom = original.clone();
        top_bottom["snapshotPolicy"] = json!({"mode":"top_bottom","top":300,"bottom":300});
        let output = serde_json::to_value(read("archive", top_bottom).await.unwrap()).unwrap();
        assert_eq!(
            output["data"]["snapshotPolicy"],
            json!({"mode":"top_bottom","top":300,"bottom":300})
        );
        probe("archive-top-bottom", &output);
        for field in [
            "mode",
            "storyGuidance",
            "scenarioPresetFilename",
            "questionnaireLoreAllowed",
            "questionnaireLorePresetIds",
        ] {
            let mut body = original.clone();
            body["season"]["specialRules"][field] = Value::Null;
            assert_eq!(
                read("archive", body).await.unwrap_err().code,
                CloudErrorCode::ProtocolMismatch,
                "null specialRules/{field}"
            );
        }
        for (kind, path, value) in [
            ("archive", "/schemaVersion", json!(4)),
            ("archive", "/season/id", json!("wrong-season")),
            (
                "archive",
                "/totalEligible/strict",
                json!(9_007_199_254_740_992_u64),
            ),
            (
                "archive",
                "/snapshotPolicy",
                json!({"mode":"top_bottom","top":-1,"bottom":0}),
            ),
            ("seasons", "/schemaVersion", json!(2)),
            ("tags", "/success", json!(false)),
            ("leaderboard", "/success", json!(false)),
            (
                "leaderboard",
                "/items/0/rank",
                json!(9_007_199_254_740_992_u64),
            ),
            ("leaderboard", "/items/0/rank", json!(0)),
            ("search", "/items/0/rank", json!(1)),
        ] {
            let mut body = fixture()["responses"][kind].clone();
            *body.pointer_mut(path).unwrap() = value;
            assert_eq!(
                read(kind, body).await.unwrap_err().code,
                CloudErrorCode::ProtocolMismatch,
                "{kind}/{path}"
            );
        }
        for kind in ["leaderboard", "search"] {
            let mut body = fixture()["responses"][kind].clone();
            let max = fixture()["requests"][kind]["limit"].as_u64().unwrap() as usize;
            body["items"] = json!(vec![body["items"][0].clone(); max + 1]);
            assert_eq!(
                read(kind, body).await.unwrap_err().code,
                CloudErrorCode::ProtocolMismatch
            );
        }
    }

    #[tokio::test]
    async fn streamed_exact_byte_budgets_accept_unicode_and_never_truncate_overflow() {
        for kind in KINDS {
            let budget = request(kind).route().unwrap().1;
            let mut body = fixture()["responses"][kind].clone();
            body["unusedPublicPadding"] =
                json!("😀".repeat((budget - serde_json::to_vec(&body).unwrap().len() - 64) / 4));
            let mut bytes = serde_json::to_vec(&body).unwrap();
            bytes.resize(budget, b' ');
            assert_eq!(bytes.len(), budget);
            assert!(read_bytes(kind, 200, bytes.clone()).await.is_ok(), "{kind}");
            bytes.push(b' ');
            assert_eq!(
                read_bytes(kind, 200, bytes).await.unwrap_err().code,
                CloudErrorCode::ResponseTooLarge,
                "{kind}"
            );
        }
    }

    #[tokio::test]
    async fn status_plaintext_and_redirect_fail_closed_without_disclosure() {
        for (status, code) in [
            (404, CloudErrorCode::NotFound),
            (429, CloudErrorCode::ServerUnavailable),
            (401, CloudErrorCode::ServerUnavailable),
            (500, CloudErrorCode::ServerUnavailable),
        ] {
            let error = read_bytes(
                "leaderboard",
                status,
                b"sensitive upstream diagnostic".to_vec(),
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, code);
            assert!(!error.message.contains("sensitive"));
        }
        for body in [
            b"plain upstream failure".to_vec(),
            b"<html>gateway</html>".to_vec(),
            vec![0xff, 0xfe],
        ] {
            assert_eq!(
                read_bytes("tags", 200, body).await.unwrap_err().code,
                CloudErrorCode::ProtocolMismatch
            );
        }
        let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let location = format!(
            "http://{}/untrusted?token=DO-NOT-LEAK",
            target.local_addr().unwrap()
        );
        let (origin, _, task) = server(
            302,
            b"DO-NOT-LEAK".to_vec(),
            &format!("Location: {location}\r\n"),
        )
        .await;
        let error = read_public_ranking(&CloudState::with_origin(&origin), request("tags"))
            .await
            .unwrap_err();
        assert_eq!(error.code, CloudErrorCode::ServerUnavailable);
        assert!(!error.message.contains("DO-NOT-LEAK"));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), target.accept())
                .await
                .is_err()
        );
        task.await.unwrap();
    }

    #[tokio::test]
    async fn invalid_requests_never_connect() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let state = CloudState::with_origin(&format!("http://{}", listener.local_addr().unwrap()));
        let mut value = fixture()["requests"]["leaderboard"].clone();
        value["offset"] = json!(301);
        let request = serde_json::from_value(value).unwrap();
        assert_eq!(
            read_public_ranking(&state, request).await.unwrap_err().code,
            CloudErrorCode::InvalidRequest
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn rating_history_exact_target_nullable_signed_facts_and_no_extra_authority() {
        for field in ["queue", "seasonId", "limit", "credentials", "token"] {
            let mut value = fixture()["requests"]["ratingHistory"].clone();
            value[field] = json!("forbidden");
            assert!(invalid_request(value), "{field}");
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let state = CloudState::with_origin(&format!("http://{}", listener.local_addr().unwrap()));
        let mut value = fixture()["requests"]["ratingHistory"].clone();
        value["entityId"] = json!(" \u{feff}\n");
        assert_eq!(
            read_public_ranking(&state, serde_json::from_value(value).unwrap())
                .await
                .unwrap_err()
                .code,
            CloudErrorCode::InvalidRequest
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );

        let id = "旧 / ?&+%😀.json";
        let request = serde_json::from_value(json!({"kind":"ratingHistory","entityType":"preset","entityId":format!(" \u{feff}{id}\n")})).unwrap();
        let mut body = fixture()["responses"]["ratingHistory"].clone();
        body["entityType"] = json!("preset");
        body["entityId"] = json!(id);
        let (origin, seen, task) = server(200, serde_json::to_vec(&body).unwrap(), "").await;
        let output = read_public_ranking(&CloudState::with_origin(&origin), request)
            .await
            .unwrap();
        let head = seen.await.unwrap();
        let url = url::Url::parse(&format!(
            "{origin}{}",
            head.split_whitespace().nth(1).unwrap()
        ))
        .unwrap();
        assert_eq!(url.path(), RATING_HISTORY_PATH);
        assert_eq!(
            url.query_pairs().into_owned().collect::<Vec<_>>(),
            vec![
                ("entityType".to_string(), "preset".to_string()),
                ("entityId".to_string(), id.to_string()),
                ("queue".to_string(), "strict".to_string())
            ]
        );
        let output = serde_json::to_value(output).unwrap();
        assert_eq!(output["data"]["items"][0]["appliedAt"], Value::Null);
        assert_eq!(output["data"]["items"][2]["delta"], 0);
        assert_eq!(output["data"]["items"][2]["afterRating"], -10);
        assert_eq!(output["data"]["items"][2]["initiator"]["userId"], -1);
        probe("ratingHistory-preset", &output);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn rating_history_rejects_mismatches_missing_facts_and_overlong_results() {
        let original = fixture()["responses"]["ratingHistory"].clone();
        for (path, value) in [
            ("/success", json!(false)),
            ("/entityType", json!("preset")),
            ("/entityId", json!("another")),
            ("/queue", json!("free")),
            ("/items/0/result", json!("constructor")),
            ("/items/0/result", json!("__proto__")),
            ("/items/0/delta", json!(1.5)),
            ("/items/0/afterRating", json!(9_007_199_254_740_992_u64)),
            ("/items/0/initiator/userId", json!(1.5)),
            ("/items/0/initiator/username", json!(3)),
            ("/items/0/appliedAt", json!(3)),
            ("/items/0/createdAt", json!(null)),
        ] {
            let mut body = original.clone();
            *body.pointer_mut(path).unwrap() = value;
            assert_eq!(
                read("ratingHistory", body).await.unwrap_err().code,
                CloudErrorCode::ProtocolMismatch,
                "{path}"
            );
        }
        for (parent, key) in [
            ("/items/0", "appliedAt"),
            ("/items/0", "delta"),
            ("/items/0", "afterRating"),
            ("/items/0/initiator", "userId"),
            ("/items/0/initiator", "username"),
        ] {
            let mut body = original.clone();
            body.pointer_mut(parent)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(key);
            assert_eq!(
                read("ratingHistory", body).await.unwrap_err().code,
                CloudErrorCode::ProtocolMismatch,
                "missing {parent}/{key}"
            );
        }
        for size in [0, 10, 11] {
            let mut body = original.clone();
            body["items"] = json!(vec![original["items"][0].clone(); size]);
            assert_eq!(read("ratingHistory", body).await.is_ok(), size <= 10);
        }
        for (status, expected) in [
            (404, CloudErrorCode::NotFound),
            (429, CloudErrorCode::ServerUnavailable),
            (500, CloudErrorCode::ServerUnavailable),
        ] {
            let error = read_bytes("ratingHistory", status, b"private debug".to_vec())
                .await
                .unwrap_err();
            assert_eq!(error.code, expected);
            assert!(!error.message.contains("private"));
        }
    }
}
