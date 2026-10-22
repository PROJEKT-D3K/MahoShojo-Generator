//! IMG-ASSET: device-owned immutable raster bytes, with a dedicated real FK consumer.
use std::io::{Cursor, Read, Write};
use std::path::Path;
use std::sync::Mutex;

use base64::Engine as _;
use image::{ImageDecoder, ImageFormat, ImageReader, Limits};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::blob::{self, BlobStore, BlobWriteOutcome};
use crate::store::{lock_connection, SharedConnection};

pub const MAX_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_EDGE: u32 = 8192;
pub const MAX_PIXELS: u64 = 16 * 1024 * 1024;
pub(crate) const MIGRATION_12: &str = r#"
CREATE TABLE local_image_asset (
 id TEXT PRIMARY KEY NOT NULL,
 digest TEXT NOT NULL UNIQUE,
 title TEXT NOT NULL,
 mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp')),
 byte_length INTEGER NOT NULL CHECK(byte_length > 0 AND byte_length <= 10485760),
 width INTEGER NOT NULL CHECK(width > 0 AND width <= 8192),
 height INTEGER NOT NULL CHECK(height > 0 AND height <= 8192),
 created_at TEXT NOT NULL,
 deleted_at TEXT,
 CHECK(width * height <= 16777216)
) STRICT;
CREATE TABLE image_asset_blob_ref (
 image_id TEXT PRIMARY KEY NOT NULL REFERENCES local_image_asset(id) ON DELETE CASCADE,
 digest TEXT NOT NULL REFERENCES blob(digest)
) STRICT;
CREATE INDEX image_asset_blob_ref_by_digest ON image_asset_blob_ref(digest);
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageError {
    Invalid,
    TooLarge,
    Unsupported,
    Decode,
    NotFound,
    Corrupt,
    NotDeleted,
    Unavailable,
    Failed,
    Maintenance,
    RestorePending,
}
impl ImageError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Invalid => "image-invalid-input",
            Self::TooLarge => "image-too-large",
            Self::Unsupported => "image-unsupported",
            Self::Decode => "image-decode-failed",
            Self::NotFound => "image-not-found",
            Self::Corrupt => "image-corrupt",
            Self::NotDeleted => "image-not-deleted",
            Self::Unavailable => "image-unavailable",
            Self::Failed => "image-failed",
            Self::Maintenance => "maintenance-busy",
            Self::RestorePending => "restore-pending",
        }
    }
}
impl Serialize for ImageError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serde_json::json!({"code":self.code(),"message": match self {
            Self::Invalid => "图片输入无效。", Self::TooLarge => "图片超过本地字节或尺寸上限。",
            Self::Unsupported => "只支持静态 PNG、JPEG、WebP 图片。", Self::Decode => "图片无法完整解码。",
            Self::NotFound => "本地图片不存在。", Self::Corrupt => "本地图片损坏，请保留原件并检查本地库。",
            Self::NotDeleted => "只有回收站图片可以彻底删除。", Self::Unavailable => "本地图片存储暂不可用。",
            Self::Maintenance => "本地库正在维护，请稍后重试。", Self::RestorePending => "本地库恢复已安排，请重启。",
            Self::Failed => "图片操作未能确认完成，请保留原图并重新查看本地库。",
        }}).serialize(serializer)
    }
}
impl From<rusqlite::Error> for ImageError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Failed
    }
}
impl From<crate::store::StoreError> for ImageError {
    fn from(_: crate::store::StoreError) -> Self {
        Self::Unavailable
    }
}
impl From<blob::BlobError> for ImageError {
    fn from(value: blob::BlobError) -> Self {
        match value {
            blob::BlobError::TooLarge => Self::TooLarge,
            blob::BlobError::Unavailable => Self::Unavailable,
            blob::BlobError::NotFound | blob::BlobError::Corrupt { .. } => Self::Corrupt,
            _ => Self::Failed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageAsset {
    pub schema_version: u8,
    pub id: String,
    pub digest: String,
    pub title: String,
    pub mime_type: String,
    pub byte_length: u64,
    pub width: u32,
    pub height: u32,
    pub created_at: String,
    pub deleted_at: Option<String>,
    pub source: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Payload {
    pub encoding: String,
    pub data: String,
    pub byte_length: usize,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveRequest {
    pub title: String,
    pub payload: Payload,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IdRequest {
    pub id: String,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListRequest {
    pub view: String,
    pub limit: usize,
    pub cursor: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub items: Vec<ImageAsset>,
    pub next_cursor: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct SaveResult {
    pub asset: ImageAsset,
    pub outcome: &'static str,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub absolute_path: String,
    pub byte_length: u64,
}

fn valid_id(id: &str) -> bool {
    id.strip_prefix("image-").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
fn title(value: &str) -> Result<&str, ImageError> {
    // Match ECMAScript trim used by the shared schema (including BOM, excluding NEL).
    let value =
        value.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
    if value.is_empty()
        || value.len() > 240
        || value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
    {
        return Err(ImageError::Invalid);
    }
    Ok(value)
}
fn now() -> Result<String, ImageError> {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| ImageError::Failed)
}
fn dimensions(width: u32, height: u32) -> Result<(), ImageError> {
    if width == 0 || height == 0 {
        return Err(ImageError::Decode);
    }
    if width > MAX_EDGE || height > MAX_EDGE || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(ImageError::TooLarge);
    }
    Ok(())
}

/// The standard raster decoder may accept only an animation's first frame. Reject its container markers first.
fn static_format(bytes: &[u8]) -> Result<ImageFormat, ImageError> {
    let format = image::guess_format(bytes).map_err(|_| ImageError::Unsupported)?;
    match format {
        ImageFormat::Png => {
            let mut offset = 8usize;
            let mut ended = false;
            while offset + 12 <= bytes.len() {
                let length = u32::from_be_bytes(
                    bytes[offset..offset + 4]
                        .try_into()
                        .map_err(|_| ImageError::Decode)?,
                ) as usize;
                if length > bytes.len() - offset - 12 {
                    return Err(ImageError::Decode);
                }
                let kind = &bytes[offset + 4..offset + 8];
                if kind == b"acTL" || kind == b"fcTL" || kind == b"fdAT" {
                    return Err(ImageError::Unsupported);
                }
                offset += 12 + length;
                if kind == b"IEND" {
                    if length != 0 || offset != bytes.len() {
                        return Err(ImageError::Decode);
                    }
                    ended = true;
                    break;
                }
            }
            if !ended {
                return Err(ImageError::Decode);
            }
        }
        ImageFormat::WebP => {
            if bytes.len() < 12 {
                return Err(ImageError::Decode);
            }
            let declared =
                u32::from_le_bytes(bytes[4..8].try_into().map_err(|_| ImageError::Decode)?)
                    as usize;
            if declared.checked_add(8) != Some(bytes.len()) {
                return Err(ImageError::Decode);
            }
            let mut offset = 12usize;
            while offset + 8 <= bytes.len() {
                let kind = &bytes[offset..offset + 4];
                let length = u32::from_le_bytes(
                    bytes[offset + 4..offset + 8]
                        .try_into()
                        .map_err(|_| ImageError::Decode)?,
                ) as usize;
                if length > bytes.len() - offset - 8 {
                    return Err(ImageError::Decode);
                }
                if kind == b"ANIM"
                    || kind == b"ANMF"
                    || (kind == b"VP8X" && length > 0 && bytes[offset + 8] & 2 != 0)
                {
                    return Err(ImageError::Unsupported);
                }
                offset += 8 + length + (length % 2);
            }
            if offset != bytes.len() {
                return Err(ImageError::Decode);
            }
        }
        ImageFormat::Jpeg => {}
        _ => return Err(ImageError::Unsupported),
    }
    Ok(format)
}

fn decode(bytes: &[u8]) -> Result<(&'static str, u32, u32), ImageError> {
    if bytes.len() > MAX_BYTES {
        return Err(ImageError::TooLarge);
    }
    if bytes.is_empty() {
        return Err(ImageError::Invalid);
    }
    let format = static_format(bytes)?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_EDGE);
    limits.max_image_height = Some(MAX_EDGE);
    // Auxiliary decoder allocation accounting, not a claim about process RSS.
    limits.max_alloc = Some(128 * 1024 * 1024);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let decoder = reader.into_decoder().map_err(|e| {
        if matches!(e, image::ImageError::Limits(_)) {
            ImageError::TooLarge
        } else {
            ImageError::Decode
        }
    })?;
    let (width, height) = decoder.dimensions();
    dimensions(width, height)?;
    let decoded = image::DynamicImage::from_decoder(decoder).map_err(|_| ImageError::Decode)?;
    if decoded.width() != width || decoded.height() != height {
        return Err(ImageError::Decode);
    }
    let mime = match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::WebP => "image/webp",
        _ => return Err(ImageError::Unsupported),
    };
    Ok((mime, width, height))
}

/// Reopening/auditing does not allocate a full pixel buffer. Stored shape is checked against
/// the same format parser and a bounded decoder header, independently of renderer metadata.
pub(crate) fn check_shape(asset: &ImageAsset, bytes: &[u8]) -> Result<(), ImageError> {
    if bytes.len() > MAX_BYTES {
        return Err(ImageError::Corrupt);
    }
    let format = static_format(bytes).map_err(|_| ImageError::Corrupt)?;
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_EDGE);
    limits.max_image_height = Some(MAX_EDGE);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let (width, height) = reader.into_dimensions().map_err(|_| ImageError::Corrupt)?;
    dimensions(width, height).map_err(|_| ImageError::Corrupt)?;
    if asset.width != width || asset.height != height || asset.mime_type != format.to_mime_type() {
        return Err(ImageError::Corrupt);
    }
    Ok(())
}

fn read_file(asset: &ImageAsset, path: &Path) -> Result<Vec<u8>, ImageError> {
    let file = std::fs::File::open(path).map_err(|_| ImageError::Corrupt)?;
    if file.metadata().map_err(|_| ImageError::Corrupt)?.len() != asset.byte_length {
        return Err(ImageError::Corrupt);
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ImageError::Corrupt)?;
    if bytes.len() as u64 != asset.byte_length || blob::digest_of(&bytes) != asset.digest {
        return Err(ImageError::Corrupt);
    }
    check_shape(asset, &bytes)?;
    Ok(bytes)
}

const SELECT: &str="SELECT id,digest,title,mime_type,byte_length,width,height,created_at,deleted_at FROM local_image_asset";
fn row_asset(row: &rusqlite::Row<'_>) -> rusqlite::Result<ImageAsset> {
    Ok(ImageAsset {
        schema_version: 1,
        id: row.get(0)?,
        digest: row.get(1)?,
        title: row.get(2)?,
        mime_type: row.get(3)?,
        byte_length: row.get(4)?,
        width: row.get(5)?,
        height: row.get(6)?,
        created_at: row.get(7)?,
        deleted_at: row.get(8)?,
        source: "uploaded".into(),
    })
}
pub(crate) fn validate_asset(asset: &ImageAsset) -> Result<(), ImageError> {
    let valid_time = |value: &str| {
        value.ends_with('Z')
            && time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
                .is_ok()
    };
    if !valid_id(&asset.id)
        || asset.digest != format!("sha256:{}", &asset.id[6..])
        || title(&asset.title).ok() != Some(asset.title.as_str())
        || !matches!(
            asset.mime_type.as_str(),
            "image/png" | "image/jpeg" | "image/webp"
        )
        || asset.byte_length == 0
        || asset.byte_length > MAX_BYTES as u64
        || dimensions(asset.width, asset.height).is_err()
        || !valid_time(&asset.created_at)
        || asset.deleted_at.as_ref().is_some_and(|value| {
            !valid_time(value)
                || time::OffsetDateTime::parse(
                    value,
                    &time::format_description::well_known::Rfc3339,
                )
                .ok()
                    < time::OffsetDateTime::parse(
                        &asset.created_at,
                        &time::format_description::well_known::Rfc3339,
                    )
                    .ok()
        })
    {
        return Err(ImageError::Corrupt);
    }
    Ok(())
}
fn get(connection: &Connection, id: &str) -> Result<ImageAsset, ImageError> {
    if !valid_id(id) {
        return Err(ImageError::Invalid);
    }
    let asset = connection
        .query_row(&format!("{SELECT} WHERE id=?1"), [id], row_asset)
        .optional()?
        .ok_or(ImageError::NotFound)?;
    validate_asset(&asset)?;
    Ok(asset)
}
fn check_reference(connection: &Connection, asset: &ImageAsset) -> Result<(), ImageError> {
    let relation:Option<(String,u64)>=connection.query_row("SELECT r.digest,b.byte_length FROM image_asset_blob_ref r JOIN blob b ON b.digest=r.digest WHERE r.image_id=?1",[&asset.id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if relation != Some((asset.digest.clone(), asset.byte_length)) {
        return Err(ImageError::Corrupt);
    }
    Ok(())
}

pub struct ImageAssetStore {
    connection: SharedConnection,
    decode_gate: Mutex<()>,
}
impl ImageAssetStore {
    pub fn new(connection: SharedConnection) -> Self {
        Self {
            connection,
            decode_gate: Mutex::new(()),
        }
    }
    /// Caller retains a write permit throughout this function. The decoder permit lives in the actual blocking worker.
    pub fn save(&self, blobs: &BlobStore, request: SaveRequest) -> Result<SaveResult, ImageError> {
        let _decode = self
            .decode_gate
            .try_lock()
            .map_err(|_| ImageError::Unavailable)?;
        let title = title(&request.title)?.to_owned();
        let payload = request.payload;
        if payload.byte_length > MAX_BYTES || payload.data.len() > MAX_BYTES.div_ceil(3) * 4 {
            return Err(ImageError::TooLarge);
        }
        if payload.encoding != "base64" {
            return Err(ImageError::Invalid);
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload.data)
            .map_err(|_| ImageError::Invalid)?;
        if bytes.len() != payload.byte_length {
            return Err(ImageError::Invalid);
        }
        let (mime, width, height) = decode(&bytes)?;
        let digest = blob::digest_of(&bytes);
        let id = format!("image-{}", &digest[7..]);
        let time = now()?;
        let connection = lock_connection(&self.connection)?;
        let existing = match get(&connection, &id) {
            Ok(asset) => Some(asset),
            Err(ImageError::NotFound) => None,
            Err(e) => return Err(e),
        };
        if let Some(asset) = &existing {
            // Metadata/ref corruption is not silently rewritten by a byte repair.
            check_reference(&connection, asset)?;
            if asset.mime_type != mime
                || asset.width != width
                || asset.height != height
                || asset.byte_length != bytes.len() as u64
            {
                return Err(ImageError::Corrupt);
            }
        }
        let outcome = blobs.write_locked(&connection, &digest, &bytes, &time)?;
        if let Some(asset) = existing {
            return Ok(SaveResult {
                asset,
                outcome: if outcome == BlobWriteOutcome::Repaired {
                    "repaired"
                } else {
                    "already-present"
                },
            });
        }
        let asset = ImageAsset {
            schema_version: 1,
            id,
            digest,
            title,
            mime_type: mime.into(),
            byte_length: bytes.len() as u64,
            width,
            height,
            created_at: time,
            deleted_at: None,
            source: "uploaded".into(),
        };
        let transaction = connection.unchecked_transaction()?;
        transaction.execute("INSERT INTO local_image_asset(id,digest,title,mime_type,byte_length,width,height,created_at,deleted_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,NULL)",params![asset.id,asset.digest,asset.title,asset.mime_type,asset.byte_length,asset.width,asset.height,asset.created_at])?;
        transaction.execute(
            "INSERT INTO image_asset_blob_ref(image_id,digest) VALUES(?1,?2)",
            params![asset.id, asset.digest],
        )?;
        transaction.commit()?;
        Ok(SaveResult {
            asset,
            outcome: if outcome == BlobWriteOutcome::Repaired {
                "repaired"
            } else {
                "stored"
            },
        })
    }
    pub fn list(&self, request: ListRequest) -> Result<Page, ImageError> {
        if !matches!(request.view.as_str(), "active" | "trash")
            || !(1..=100).contains(&request.limit)
            || request.cursor.as_ref().is_some_and(|id| !valid_id(id))
        {
            return Err(ImageError::Invalid);
        }
        let connection = lock_connection(&self.connection)?;
        let sql=format!("{SELECT} WHERE (deleted_at IS NOT NULL)=?1 AND (?2 IS NULL OR id>?2) ORDER BY id ASC LIMIT ?3");
        let mut stmt = connection.prepare(&sql)?;
        let mut items = stmt
            .query_map(
                params![
                    request.view == "trash",
                    request.cursor,
                    (request.limit + 1) as i64
                ],
                row_asset,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        for asset in &items {
            validate_asset(asset)?;
            check_reference(&connection, asset)?;
        }
        let more = items.len() > request.limit;
        items.truncate(request.limit);
        let next_cursor = if more {
            items.last().map(|x| x.id.clone())
        } else {
            None
        };
        Ok(Page { items, next_cursor })
    }
    pub fn read(&self, root: &Path, id: &str) -> Result<(ImageAsset, Vec<u8>), ImageError> {
        let connection = lock_connection(&self.connection)?;
        let asset = get(&connection, id)?;
        check_reference(&connection, &asset)?;
        let path = blob::blob_path(&blob::BlobPaths::under(root), &asset.digest)?;
        let bytes = read_file(&asset, &path)?;
        Ok((asset, bytes))
    }
    pub fn transition(&self, id: &str, restore: bool) -> Result<(), ImageError> {
        let connection = lock_connection(&self.connection)?;
        let asset = get(&connection, id)?;
        if restore {
            connection.execute(
                "UPDATE local_image_asset SET deleted_at=NULL WHERE id=?1",
                [id],
            )?;
        } else if asset.deleted_at.is_none() {
            let current = now()?;
            let time = if time::OffsetDateTime::parse(
                &current,
                &time::format_description::well_known::Rfc3339,
            )
            .map_err(|_| ImageError::Failed)?
                < time::OffsetDateTime::parse(
                    &asset.created_at,
                    &time::format_description::well_known::Rfc3339,
                )
                .map_err(|_| ImageError::Corrupt)?
            {
                asset.created_at
            } else {
                current
            };
            connection.execute(
                "UPDATE local_image_asset SET deleted_at=?2 WHERE id=?1",
                params![id, time],
            )?;
        }
        Ok(())
    }
    pub fn purge(&self, id: &str) -> Result<(), ImageError> {
        let connection = lock_connection(&self.connection)?;
        let asset = match get(&connection, id) {
            Ok(a) => a,
            Err(ImageError::NotFound) => return Ok(()),
            Err(e) => return Err(e),
        };
        if asset.deleted_at.is_none() {
            return Err(ImageError::NotDeleted);
        }
        connection.execute(
            "DELETE FROM local_image_asset WHERE id=?1 AND deleted_at IS NOT NULL",
            [id],
        )?;
        Ok(())
    }
    pub fn export(&self, root: &Path, id: &str) -> Result<ExportResult, ImageError> {
        let (asset, bytes) = self.read(root, id)?;
        let directory = root.join("exports").join("images");
        std::fs::create_dir_all(&directory).map_err(|_| ImageError::Unavailable)?;
        let extension = match asset.mime_type.as_str() {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            _ => return Err(ImageError::Corrupt),
        };
        let mut temporary =
            tempfile::NamedTempFile::new_in(&directory).map_err(|_| ImageError::Unavailable)?;
        temporary
            .write_all(&bytes)
            .map_err(|_| ImageError::Failed)?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|_| ImageError::Failed)?;
        for suffix in 0_u64.. {
            let name = if suffix == 0 {
                format!("{}.{extension}", asset.id)
            } else {
                format!("{}-{}.{extension}", asset.id, suffix + 1)
            };
            let path = directory.join(name);
            match temporary.persist_noclobber(&path) {
                Ok(_) => {
                    return Ok(ExportResult {
                        absolute_path: path.to_string_lossy().into_owned(),
                        byte_length: bytes.len() as u64,
                    })
                }
                Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                    temporary = error.file
                }
                Err(_) => return Err(ImageError::Failed),
            }
        }
        Err(ImageError::Failed)
    }
}

/// Exact SQLite objects prevent a pre-release history-12 or weakened FK shape masquerading as image-12.
pub(crate) fn verify_schema(connection: &Connection, version: i64) -> Result<(), ImageError> {
    fn objects(c: &Connection) -> Result<Vec<(String, String, Option<String>)>, ImageError> {
        let mut stmt=c.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name IN ('local_image_asset','image_asset_blob_ref') ORDER BY type,name")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    let actual = objects(connection)?;
    if version < 12 {
        return if actual.is_empty() {
            Ok(())
        } else {
            Err(ImageError::Corrupt)
        };
    }
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(MIGRATION_12)?;
    if objects(&expected)? != actual {
        return Err(ImageError::Corrupt);
    }
    Ok(())
}
pub(crate) fn all_assets(connection: &Connection) -> Result<Vec<ImageAsset>, ImageError> {
    let mut stmt = connection.prepare(SELECT)?;
    let rows = stmt
        .query_map([], row_asset)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
pub(crate) fn verify_relations(connection: &Connection) -> Result<(), ImageError> {
    for asset in all_assets(connection)? {
        validate_asset(&asset)?;
        check_reference(connection, &asset)?;
    }
    Ok(())
}

pub(crate) fn verify_files(connection: &Connection, blobs_root: &Path) -> Result<(), ImageError> {
    for asset in all_assets(connection)? {
        validate_asset(&asset)?;
        check_reference(connection, &asset)?;
        let hex = blob::parse_digest(&asset.digest).map_err(|_| ImageError::Corrupt)?;
        read_file(&asset, &blobs_root.join(hex))?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "image_asset_tests.rs"]
mod tests;
