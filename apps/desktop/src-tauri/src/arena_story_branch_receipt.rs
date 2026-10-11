//! Closed v2 disk shapes. Deliberately separate from the frozen linear-v1 reader.
use super::super::{valid_digest, valid_id, StoryError, MAX_SAFE_INTEGER};
use serde::{Deserialize, Serialize};

pub(super) const RECEIPT_BYTES: usize = 2048;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BranchReceipt {
    pub version: u32,
    pub kind: BranchKind,
    pub operation_id: String,
    pub session_id: String,
    pub chapter_id: String,
    pub chapter_index: u64,
    pub revision: u64,
    pub chapter_count: u64,
    pub prefix_end_index: u64,
    pub anchor_chapter_id: String,
    pub anchor_checkpoint_id: String,
    pub checkpoint_id: String,
    pub request_digest: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum BranchKind {
    #[serde(rename = "branch")]
    Branch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CopyMarker {
    pub version: u32,
    pub kind: CopyKind,
    pub branch_operation_id: String,
    pub session_id: String,
    pub chapter_id: String,
    pub chapter_index: u64,
    pub source_session_id: String,
    pub source_chapter_id: String,
    pub request_digest: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) enum CopyKind {
    #[serde(rename = "branch-copy")]
    Copy,
}

impl BranchReceipt {
    pub(super) fn validate(&self) -> Result<(), StoryError> {
        if self.version != 2
            || ![
                &self.operation_id,
                &self.session_id,
                &self.chapter_id,
                &self.anchor_chapter_id,
                &self.anchor_checkpoint_id,
                &self.checkpoint_id,
            ]
            .into_iter()
            .all(|id| valid_id(id))
            || !valid_digest(&self.request_digest)
            || self.operation_id != self.chapter_id
            || !(1..MAX_SAFE_INTEGER).contains(&self.prefix_end_index)
            || self.chapter_index != self.prefix_end_index + 1
            || self.revision != self.chapter_index
            || self.chapter_count != self.chapter_index
            || self.anchor_chapter_id == self.chapter_id
            || self.anchor_checkpoint_id == self.checkpoint_id
        {
            return Err(StoryError::Corrupt);
        }
        Ok(())
    }
    pub(super) fn encode(&self) -> Result<String, StoryError> {
        self.validate()?;
        encode(self)
    }
    pub(super) fn decode(value: &str) -> Result<Self, StoryError> {
        let receipt: Self = decode(value)?;
        receipt.validate()?;
        Ok(receipt)
    }
}
impl CopyMarker {
    pub(super) fn validate(&self) -> Result<(), StoryError> {
        if self.version != 2
            || ![
                &self.branch_operation_id,
                &self.session_id,
                &self.chapter_id,
                &self.source_session_id,
                &self.source_chapter_id,
            ]
            .into_iter()
            .all(|id| valid_id(id))
            || !valid_digest(&self.request_digest)
            || !(1..MAX_SAFE_INTEGER).contains(&self.chapter_index)
            || self.session_id == self.source_session_id
            || self.branch_operation_id == self.chapter_id
        {
            return Err(StoryError::Corrupt);
        }
        Ok(())
    }
    pub(super) fn encode(&self) -> Result<String, StoryError> {
        self.validate()?;
        encode(self)
    }
    pub(super) fn decode(value: &str) -> Result<Self, StoryError> {
        let marker: Self = decode(value)?;
        marker.validate()?;
        Ok(marker)
    }
}
fn encode(value: &impl Serialize) -> Result<String, StoryError> {
    let value = serde_json::to_string(value).map_err(|_| StoryError::Corrupt)?;
    if value.len() > RECEIPT_BYTES {
        return Err(StoryError::TooLarge);
    }
    Ok(value)
}
fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, StoryError> {
    if value.len() > RECEIPT_BYTES {
        return Err(StoryError::Corrupt);
    }
    serde_json::from_str(value).map_err(|_| StoryError::Corrupt)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maximal_receipt_goldens_are_bounded_without_padding_or_larger_v1_reader() {
        let receipt = BranchReceipt {
            version: 2,
            kind: BranchKind::Branch,
            operation_id: "o".repeat(128),
            session_id: "s".repeat(128),
            chapter_id: "o".repeat(128),
            chapter_index: MAX_SAFE_INTEGER,
            revision: MAX_SAFE_INTEGER,
            chapter_count: MAX_SAFE_INTEGER,
            prefix_end_index: MAX_SAFE_INTEGER - 1,
            anchor_chapter_id: "a".repeat(128),
            anchor_checkpoint_id: "p".repeat(128),
            checkpoint_id: "q".repeat(128),
            request_digest: format!("sha256:{}", "f".repeat(64)),
        };
        let encoded = receipt.encode().unwrap();
        assert_eq!(encoded.len(), 1123);
        assert_eq!(
            crate::arena_story::digest(encoded.as_bytes()),
            "sha256:93d6b217eb2635b61b98b502f0b2ee9948d35cb8bef61320e4a2f4c1b0b67861"
        );
        assert_eq!(BranchReceipt::decode(&encoded).unwrap(), receipt);
        let marker = CopyMarker {
            version: 2,
            kind: CopyKind::Copy,
            branch_operation_id: "o".repeat(128),
            session_id: "s".repeat(128),
            chapter_id: "c".repeat(128),
            chapter_index: MAX_SAFE_INTEGER - 1,
            source_session_id: "u".repeat(128),
            source_chapter_id: "v".repeat(128),
            request_digest: format!("sha256:{}", "f".repeat(64)),
        };
        let encoded = marker.encode().unwrap();
        assert_eq!(encoded.len(), 891);
        assert_eq!(
            crate::arena_story::digest(encoded.as_bytes()),
            "sha256:b5d0cd43e68e9fb930ec936b3b0aad1662b3cb1234ef05e547839634749cbf13"
        );
        assert_eq!(CopyMarker::decode(&encoded).unwrap(), marker);
        assert!(BranchReceipt::decode(&encoded).is_err());
        for invalid in [
            encoded.replace("branch-copy", "branch"),
            encoded.replace("\"version\":2", "\"version\":1"),
            encoded.replace("\"version\":2", "\"version\":2,\"version\":2"),
            encoded.replace("\"version\":2", "\"version\":2,\"opaque\":1"),
            encoded.replace(&"c".repeat(128), &"c".repeat(129)),
            format!("{}{}", encoded, " ".repeat(2049)),
            encoded.replace(&"c".repeat(128), "invalid/id"),
        ] {
            assert!(CopyMarker::decode(&invalid).is_err());
        }
    }
}
