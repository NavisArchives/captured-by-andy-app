//! Archiving: copying originals (both files of a RAW+JPEG pair) to a storage
//! location, verifying each copy, and recording it. Nothing is ever deleted,
//! at the source or at the destination.

use std::path::{Path, PathBuf};

use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use super::db::Db;
use super::storage::{self, StorageProvider};
use super::{fingerprint, now_ms, Error, Result};

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveReport {
    pub archived: usize,
    pub already: usize,
    /// Only in iCloud and downloads are not allowed.
    pub skipped_cloud: usize,
    pub missing: usize,
    pub failed: usize,
    pub bytes: u64,
    pub errors: Vec<String>,
}

struct Item {
    asset_id: String,
    photo_id: String,
    filename: String,
    path: String,
    state: String,
    fingerprint: Option<String>,
    captured_at: String,
    local_copy: Option<String>,
    done: bool,
}

/// `originals/<YYYY-MM>/<last 8 of the photo id>_<filename>`: stable, readable,
/// and unique even when two cameras both wrote IMG_0001.JPG.
pub fn key_for(photo_id: &str, captured_at: &str, filename: &str) -> String {
    let month = captured_at.get(..7).filter(|m| m.as_bytes().get(4) == Some(&b'-')).unwrap_or("undated");
    let short = &photo_id[photo_id.len().saturating_sub(8)..];
    let clean: String = filename.chars().map(|c| if c == '/' || c == '\\' || c == '\0' { '_' } else { c }).collect();
    format!("originals/{month}/{short}_{clean}")
}

pub fn archive_photos(
    db: &Db,
    location_id: &str,
    photo_ids: &[String],
    allow_cloud_downloads: bool,
) -> Result<ArchiveReport> {
    let location = storage::list_locations(db)?
        .into_iter()
        .find(|l| l.id == location_id)
        .ok_or_else(|| Error::Invalid(format!("unknown archive location {location_id}")))?;
    let provider = storage::provider(&location)?;
    if !location.online {
        return Err(Error::SourceOffline(location.root.clone()));
    }
    let items = db.read(|c| {
        let mut stmt = c.prepare_cached(
            "SELECT a.id, a.photo_id, a.filename, a.path, a.storage_state, a.fingerprint, p.captured_at,
                    (SELECT lc.path FROM local_copies lc WHERE lc.asset_id = a.id),
                    EXISTS (SELECT 1 FROM archived_assets aa WHERE aa.asset_id = a.id AND aa.location_id = ?2)
             FROM assets a JOIN photos p ON p.id = a.photo_id WHERE a.photo_id = ?1",
        )?;
        let mut out = Vec::new();
        for id in photo_ids {
            for item in stmt.query_map(params![id, location_id], |r| {
                Ok(Item {
                    asset_id: r.get(0)?,
                    photo_id: r.get(1)?,
                    filename: r.get(2)?,
                    path: r.get(3)?,
                    state: r.get(4)?,
                    fingerprint: r.get(5)?,
                    captured_at: r.get(6)?,
                    local_copy: r.get(7)?,
                    done: r.get(8)?,
                })
            })? {
                out.push(item?);
            }
        }
        Ok(out)
    })?;

    let mut report = ArchiveReport::default();
    for item in items {
        if item.done {
            report.already += 1;
            continue;
        }
        let source: PathBuf = match (item.state.as_str(), &item.local_copy) {
            ("local", _) => item.path.clone().into(),
            (_, Some(copy)) if Path::new(copy).is_file() => copy.into(),
            ("cloud_only", _) if allow_cloud_downloads => item.path.clone().into(),
            ("cloud_only", _) => {
                report.skipped_cloud += 1;
                continue;
            }
            _ => {
                report.missing += 1;
                continue;
            }
        };
        match archive_one(provider.as_ref(), &item, &source) {
            Ok((key, size, fp)) => {
                db.write(|c| {
                    c.execute(
                        "INSERT OR REPLACE INTO archived_assets (asset_id, location_id, remote_key, size, fingerprint, archived_ms)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![item.asset_id, location_id, key, size as i64, fp, now_ms()],
                    )?;
                    Ok(())
                })?;
                report.archived += 1;
                report.bytes += size;
            }
            Err(e) => {
                report.failed += 1;
                if report.errors.len() < 20 {
                    report.errors.push(format!("{}: {e}", item.filename));
                }
            }
        }
    }
    Ok(report)
}

/// Copies one file and checks the copy. An identical file already at the key
/// counts as archived; a different one is an error, never overwritten.
fn archive_one(provider: &dyn StorageProvider, item: &Item, source: &Path) -> Result<(String, u64, String)> {
    let size = std::fs::metadata(source)?.len();
    let expected = match &item.fingerprint {
        Some(fp) => fp.clone(),
        None => fingerprint::quick(source, size)?,
    };
    let key = key_for(&item.photo_id, &item.captured_at, &item.filename);
    if provider.get_metadata(&key)?.is_none() {
        provider.upload(source, &key)?;
    }
    let stored = provider.get_metadata(&key)?.ok_or_else(|| Error::Media(format!("{key} vanished after upload")))?;
    if stored.size != size {
        return Err(Error::Media(format!("{key} holds a different file ({} bytes, expected {size})", stored.size)));
    }
    if let Some(path) = provider.local_path(&key) {
        let got = fingerprint::quick(&path, stored.size)?;
        if got != expected {
            return Err(Error::Media(format!("{key} does not match the original")));
        }
    }
    Ok((key, size, expected))
}

pub fn is_archived(db: &Db, asset_id: &str) -> Result<bool> {
    db.read(|c| {
        Ok(c.query_row("SELECT 1 FROM archived_assets WHERE asset_id = ?1", [asset_id], |_| Ok(())).optional()?.is_some())
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn keys_group_by_month_and_stay_unique() {
        let k = super::key_for("0199f0c2-1111-7000-8000-00000000abcd", "2026-09-21T21:42:00.000", "IMG_0001.JPG");
        assert_eq!(k, "originals/2026-09/0000abcd_IMG_0001.JPG");
        assert_eq!(super::key_for("x", "", "a.jpg"), "originals/undated/x_a.jpg");
    }
}
