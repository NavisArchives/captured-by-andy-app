//! The local selected library: copies of chosen photos kept on this Mac, so
//! they can be viewed, edited and posted while the source drive is unplugged
//! or the originals only live in iCloud. Originals are read, never changed;
//! only copies this module made (recorded in `local_copies`) are ever removed.

use std::path::{Path, PathBuf};

use rusqlite::params;
use serde::Serialize;

use super::db::Db;
use super::{fingerprint, now_ms, settings, Error, Result};

pub const DIR_KEY: &str = "library.localDir";
pub const AUTO_KEY: &str = "offline.auto";
pub const CLOUD_KEY: &str = "offline.allowCloudDownloads";
pub const RAW_KEY: &str = "offline.includeRaw";

fn flag(db: &Db, key: &str) -> Result<bool> {
    Ok(settings::get(db, key)?.map(|v| v == "true").unwrap_or(false))
}

pub fn auto(db: &Db) -> Result<bool> {
    flag(db, AUTO_KEY)
}

pub fn allow_cloud(db: &Db) -> Result<bool> {
    flag(db, CLOUD_KEY)
}

/// Where copies live: the setting, else ~/Pictures/CapturedByAndy.
pub fn library_dir(db: &Db) -> Result<PathBuf> {
    if let Some(dir) = settings::get(db, DIR_KEY)?.map(|v| v.trim_matches('"').to_owned()).filter(|v| !v.is_empty()) {
        return Ok(dir.into());
    }
    let home = std::env::var_os("HOME").ok_or_else(|| Error::Invalid("HOME is not set".into()))?;
    Ok(Path::new(&home).join("Pictures").join("CapturedByAndy"))
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OfflineReport {
    pub copied: usize,
    pub already: usize,
    pub skipped_cloud: usize,
    pub missing: usize,
    pub failed: usize,
    pub removed: usize,
    pub bytes: u64,
}

struct Item {
    asset_id: String,
    photo_id: String,
    filename: String,
    path: String,
    state: String,
    size: i64,
    fingerprint: Option<String>,
}

fn copy_path(dir: &Path, photo_id: &str, filename: &str) -> PathBuf {
    let shard = &photo_id[photo_id.len().saturating_sub(2)..];
    let clean: String = filename.chars().map(|c| if c == '/' || c == '\\' || c == '\0' { '_' } else { c }).collect();
    dir.join(shard).join(photo_id).join(clean)
}

/// The automatic copy when photos are selected. Videos are left out: a clip is
/// far too big to copy on its own (selected videos stay online).
pub fn keep_auto(db: &Db, photo_ids: &[String]) -> Result<OfflineReport> {
    let photos: Vec<String> = db.read(|c| {
        let mut stmt = c.prepare_cached("SELECT 1 FROM photos WHERE id = ?1 AND is_video = 0")?;
        let mut out = Vec::new();
        for id in photo_ids {
            if stmt.exists([id])? {
                out.push(id.clone());
            }
        }
        Ok(out)
    })?;
    if photos.is_empty() {
        return Ok(OfflineReport::default());
    }
    keep(db, &photos)
}

/// Moves local copies to the Trash (where they can still be put back) and
/// forgets them: only videos' copies, or all. Originals are never touched.
/// Returns how many went and their size.
pub fn trash_copies(db: &Db, only_videos: bool) -> Result<(usize, u64)> {
    let dir = library_dir(db)?;
    let root = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    let rows: Vec<(String, String, i64)> = db.read(|c| {
        let rows = c
            .prepare(
                "SELECT lc.asset_id, lc.path, lc.size FROM local_copies lc JOIN photos p ON p.id = lc.photo_id
                 WHERE (p.is_video = 1 OR NOT ?1) AND lc.path NOT IN (SELECT path FROM assets)",
            )?
            .query_map([only_videos], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })?;
    let (mut n, mut bytes) = (0, 0);
    for (asset, path, size) in rows {
        let file = PathBuf::from(&path);
        let file = file.canonicalize().unwrap_or(file);
        if file.exists() {
            if !file.starts_with(&root) || !super::media::trash(&file) {
                continue;
            }
            // Tidy the now-empty <shard>/<photo id> folders, never anything above the library.
            let mut parent = file.parent();
            while let Some(p) = parent {
                if p == root || !p.starts_with(&root) || std::fs::remove_dir(p).is_err() {
                    break;
                }
                parent = p.parent();
            }
        }
        db.write(|c| {
            c.execute("DELETE FROM local_copies WHERE asset_id = ?1", [&asset])?;
            Ok(())
        })?;
        n += 1;
        bytes += size.max(0) as u64;
    }
    Ok((n, bytes))
}

/// Copies these photos into the local library: the primary file, plus the RAW
/// when `offline.includeRaw` is on. iCloud-only originals are skipped unless
/// downloads are allowed (reading one makes macOS download it).
pub fn keep(db: &Db, photo_ids: &[String]) -> Result<OfflineReport> {
    let dir = library_dir(db)?;
    let cloud = allow_cloud(db)?;
    let raw = flag(db, RAW_KEY)?;
    let items = db.read(|c| {
        let mut stmt = c.prepare_cached(
            "SELECT a.id, a.photo_id, a.filename, a.path, a.storage_state, a.size, a.fingerprint
             FROM assets a WHERE a.photo_id = ?1 AND (a.is_primary = 1 OR ?2)
               AND NOT EXISTS (SELECT 1 FROM local_copies lc WHERE lc.asset_id = a.id)",
        )?;
        let mut out = Vec::new();
        for id in photo_ids {
            for item in stmt.query_map(params![id, raw], |r| {
                Ok(Item {
                    asset_id: r.get(0)?,
                    photo_id: r.get(1)?,
                    filename: r.get(2)?,
                    path: r.get(3)?,
                    state: r.get(4)?,
                    size: r.get(5)?,
                    fingerprint: r.get(6)?,
                })
            })? {
                out.push(item?);
            }
        }
        Ok(out)
    })?;
    let mut report = OfflineReport::default();
    report.already = photo_ids.len().saturating_sub(items.iter().map(|i| &i.photo_id).collect::<std::collections::HashSet<_>>().len());
    for item in items {
        match item.state.as_str() {
            "local" => {}
            "cloud_only" if cloud => {}
            "cloud_only" => {
                report.skipped_cloud += 1;
                continue;
            }
            _ => {
                report.missing += 1;
                continue;
            }
        }
        match copy_one(&dir, &item) {
            Ok((dest, size, fp)) => {
                db.write(|c| {
                    c.execute(
                        "INSERT INTO local_copies (asset_id, photo_id, path, size, fingerprint, created_ms)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![item.asset_id, item.photo_id, dest.to_string_lossy(), size as i64, fp, now_ms()],
                    )?;
                    Ok(())
                })?;
                report.copied += 1;
                report.bytes += size;
            }
            Err(_) => report.failed += 1,
        }
    }
    Ok(report)
}

fn copy_one(dir: &Path, item: &Item) -> Result<(PathBuf, u64, String)> {
    let src = Path::new(&item.path);
    let dest = copy_path(dir, &item.photo_id, &item.filename);
    if dest.exists() {
        return Err(Error::Invalid(format!("{} already exists and is not a recorded copy", dest.display())));
    }
    std::fs::create_dir_all(dest.parent().expect("copy path has a parent"))?;
    let tmp = dest.with_extension("partial");
    // copyfile won't download an online placeholder: fetch it first, and give
    // the space back once the copy is verified.
    let online = std::fs::symlink_metadata(src).is_ok_and(|m| super::scan::is_dataless(&m));
    if online {
        super::media::fetch_download(src)?;
    }
    let result = (|| -> Result<(u64, String)> {
        let size = std::fs::copy(src, &tmp)?;
        std::fs::File::open(&tmp)?.sync_all()?;
        let fp = fingerprint::quick(&tmp, size)?;
        let matches_index = item.size as u64 == size && item.fingerprint.as_deref().is_none_or(|f| f == fp);
        if !matches_index || fingerprint::quick(src, size)? != fp {
            return Err(Error::Media(format!("copy of {} did not verify", item.filename)));
        }
        Ok((size, fp))
    })();
    match result {
        Ok((size, fp)) => {
            std::fs::rename(&tmp, &dest)?;
            if online {
                super::media::release_download(src);
            }
            Ok((dest, size, fp))
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Removes the local copies of these photos. Only files recorded as copies and
/// lying inside the library folder are deleted; originals never are.
pub fn release(db: &Db, photo_ids: &[String]) -> Result<OfflineReport> {
    let dir = library_dir(db)?;
    let rows: Vec<(String, String)> = db.read(|c| {
        let mut stmt = c.prepare_cached(
            "SELECT lc.asset_id, lc.path FROM local_copies lc
             WHERE lc.photo_id = ?1 AND lc.path NOT IN (SELECT path FROM assets)",
        )?;
        let mut out = Vec::new();
        for id in photo_ids {
            for r in stmt.query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))? {
                out.push(r?);
            }
        }
        Ok(out)
    })?;
    remove_rows(db, &dir, rows)
}

/// Before forgetting a source folder: drop the copies of its photos.
pub fn release_source(db: &Db, source_id: &str) -> Result<OfflineReport> {
    let dir = library_dir(db)?;
    let rows: Vec<(String, String)> = db.read(|c| {
        let rows = c
            .prepare(
                "SELECT lc.asset_id, lc.path FROM local_copies lc JOIN assets a ON a.id = lc.asset_id
                 WHERE a.source_id = ?1 AND lc.path NOT IN (SELECT path FROM assets)",
            )?
            .query_map([source_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    })?;
    remove_rows(db, &dir, rows)
}

fn remove_rows(db: &Db, dir: &Path, rows: Vec<(String, String)>) -> Result<OfflineReport> {
    let mut report = OfflineReport::default();
    let root = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    for (asset, path) in rows {
        let file = PathBuf::from(&path);
        let file = file.canonicalize().unwrap_or(file);
        let inside = file.starts_with(&root);
        if file.exists() {
            if !inside {
                report.failed += 1;
                continue;
            }
            if std::fs::remove_file(&file).is_err() {
                report.failed += 1;
                continue;
            }
            // Tidy the now-empty <shard>/<photo id> folders, never anything above the library.
            let mut parent = file.parent();
            while let Some(p) = parent {
                if p == root || !p.starts_with(&root) || std::fs::remove_dir(p).is_err() {
                    break;
                }
                parent = p.parent();
            }
        }
        db.write(|c| {
            c.execute("DELETE FROM local_copies WHERE asset_id = ?1", [&asset])?;
            Ok(())
        })?;
        report.removed += 1;
    }
    Ok(report)
}

/// Drops records of copies that were deleted by hand, so the UI never promises
/// an offline copy that is not there.
pub fn verify(db: &Db) -> Result<usize> {
    let rows: Vec<(String, String)> =
        db.read(|c| Ok(c.prepare("SELECT asset_id, path FROM local_copies")?.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?))?;
    let gone: Vec<String> = rows.into_iter().filter(|(_, p)| !Path::new(p).is_file()).map(|(a, _)| a).collect();
    db.write(|c| {
        for a in &gone {
            c.execute("DELETE FROM local_copies WHERE asset_id = ?1", [a])?;
        }
        Ok(())
    })?;
    Ok(gone.len())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineInfo {
    pub dir: String,
    pub photos: i64,
    pub bytes: i64,
    pub auto: bool,
    pub allow_cloud: bool,
    pub include_raw: bool,
}

pub fn info(db: &Db) -> Result<OfflineInfo> {
    let (photos, bytes) = db.read(|c| {
        Ok(c.query_row("SELECT COUNT(DISTINCT photo_id), COALESCE(SUM(size), 0) FROM local_copies", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?)
    })?;
    Ok(OfflineInfo {
        dir: library_dir(db)?.to_string_lossy().into_owned(),
        photos,
        bytes,
        auto: auto(db)?,
        allow_cloud: allow_cloud(db)?,
        include_raw: flag(db, RAW_KEY)?,
    })
}

/// Selected photos are kept in full size on this Mac (when that is switched on),
/// so they can be inspected and exported without waiting: fetches the copies
/// still missing, e.g. for photos selected before, or whose copy was removed.
pub fn keep_selected(db: &Db) -> Result<OfflineReport> {
    if !auto(db)? {
        return Ok(OfflineReport::default());
    }
    let ids: Vec<String> = db.read(|c| {
        let mut stmt = c.prepare(
            "SELECT p.id FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
             WHERE p.review_state = 'selected' AND p.is_video = 0 AND a.storage_state != 'local'
               AND NOT EXISTS (SELECT 1 FROM local_copies lc WHERE lc.asset_id = a.id)",
        )?;
        let rows = stmt.query_map([], |r| r.get(0))?.collect::<std::result::Result<Vec<String>, _>>()?;
        Ok(rows)
    })?;
    keep(db, &ids)
}
