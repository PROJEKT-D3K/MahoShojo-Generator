//! Evidence for exactly one immutable, bounded source document. No unchecked
//! constructor or mutable accessor is exposed to branch/storage siblings.
use super::{digest, valid_digest, RawValue, StoryError, CANDIDATE_COMMIT_BYTES};

#[cfg(test)]
thread_local! {
    static CHECKS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
#[cfg(test)]
pub(super) fn check_count() -> usize {
    CHECKS.with(std::cell::Cell::get)
}

pub(super) struct CheckedCopySource<'a> {
    document: &'a str,
    raw: &'a RawValue,
    byte_length: u64,
    digest: &'a str,
}

impl<'a> CheckedCopySource<'a> {
    pub(super) fn checked(
        document: &'a str,
        byte_length: u64,
        expected_digest: &'a str,
    ) -> Result<Self, StoryError> {
        #[cfg(test)]
        CHECKS.with(|count| count.set(count.get() + 1));
        if byte_length == 0 || byte_length > CANDIDATE_COMMIT_BYTES {
            return Err(StoryError::TooLarge);
        }
        if document.len() as u64 != byte_length
            || !valid_digest(expected_digest)
            || digest(document.as_bytes()) != expected_digest
        {
            return Err(StoryError::Corrupt);
        }
        let raw: &RawValue = serde_json::from_str(document).map_err(|_| StoryError::Corrupt)?;
        if !raw.get().starts_with('{') {
            return Err(StoryError::Corrupt);
        }
        Ok(Self {
            document,
            raw,
            byte_length,
            digest: expected_digest,
        })
    }

    pub(super) fn document(&self) -> &'a str {
        self.document
    }
    pub(super) fn raw(&self) -> &'a RawValue {
        self.raw
    }
    pub(super) fn byte_length(&self) -> u64 {
        self.byte_length
    }
    pub(super) fn digest(&self) -> &'a str {
        self.digest
    }
}
