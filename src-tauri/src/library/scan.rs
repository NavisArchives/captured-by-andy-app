//! Indexing a source folder: walk it, record every supported file, pair RAW
//! with JPEG, and mark what disappeared.
//!
//! Source files are only ever opened for reading, and files that exist only in
//! iCloud are never opened at all - `stat()` flags them as placeholders
//! (SF_DATALESS) and reading one would start a download.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;

use chrono::TimeZone;
use rusqlite::{params, Transaction};
use serde::Serialize;
use walkdir::{DirEntry, WalkDir};

use super::db::Db;
use super::model::{Format, MediaKind, Metadata, StorageState};
use super::pairing::{self, Candidate};
use super::{fingerprint, new_id, now_ms, sources, Error, Result};

/// Files per write transaction: big enough to be fast, small enough that the UI
/// sees progress and review writes are never held up for long.
const BATCH: usize = 400;

/// Folders that are really app libraries (Photos, Lightroom, Final Cut). They
/// hold caches and derivatives; indexing them would duplicate every photo.
const LIBRARY_BUNDLES: &[&str] =
    &[".photoslibrary", ".lrlibrary", ".lrdata", ".fcpbundle", ".imovielibrary", ".cocatalog", ".app"];

const SF_DATALESS: u32 = 0x4000_0000;

pub type MetadataReader<'a> = &'a (dyn Fn(&Path) -> Option<Metadata> + Sync);

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStats {
    pub discovered: u64,
    pub added: u64,
    pub updated: u64,
    pub moved: u64,
    pub unchanged: u64,
    pub cloud_only: u64,
    pub missing: u64,
    pub paired: u64,
    pub errors: u64,
    /// Files not marked missing because the scan couldn't read everything
    /// (Google Drive dropped out, access refused, an empty listing).
    pub held: u64,
    pub cancelled: bool,
}

impl ScanStats {
    /// The two added up: one scan over several sources reports one total.
    pub fn plus(&self, o: &ScanStats) -> ScanStats {
        ScanStats {
            discovered: self.discovered + o.discovered,
            added: self.added + o.added,
            updated: self.updated + o.updated,
            moved: self.moved + o.moved,
            unchanged: self.unchanged + o.unchanged,
            cloud_only: self.cloud_only + o.cloud_only,
            missing: self.missing + o.missing,
            paired: self.paired + o.paired,
            errors: self.errors + o.errors,
            held: self.held + o.held,
            cancelled: self.cancelled || o.cancelled,
        }
    }
}

struct Known {
    id: String,
    photo_id: String,
    size: i64,
    mtime_ms: i64,
    state: StorageState,
}

struct Found {
    path: PathBuf,
    format: Format,
    size: i64,
    mtime_ms: i64,
    dataless: bool,
}

/// What reading a local file produced, gathered before taking the write lock.
struct Read {
    fingerprint: Option<String>,
    meta: Metadata,
}

pub fn scan_source(
    db: &Db,
    source_id: &str,
    read_meta: MetadataReader,
    cancel: &AtomicBool,
    mut progress: impl FnMut(&ScanStats),
) -> Result<ScanStats> {
    let source = sources::get(db, source_id)?;
    let root = PathBuf::from(&source.path);
    let started = now_ms();
    if !root.is_dir() {
        // An unplugged drive is not a deleted library: record it and touch nothing.
        db.write(|c| {
            c.execute(
                "INSERT INTO scan_runs (source_id, started_ms, finished_ms, status) VALUES (?1, ?2, ?2, 'offline')",
                params![source_id, started],
            )?;
            Ok(())
        })?;
        return Err(Error::SourceOffline(source.path));
    }
    let scan_id = db.write(|c| {
        c.execute(
            "INSERT INTO scan_runs (source_id, started_ms, status) VALUES (?1, ?2, 'running')",
            params![source_id, started],
        )?;
        let id = c.last_insert_rowid();
        c.execute("UPDATE sources SET last_scan_started_ms = ?2 WHERE id = ?1", params![source_id, started])?;
        Ok(id)
    })?;

    let known = load_known(db, source_id)?;
    let mut stats = ScanStats::default();
    let mut groups = HashSet::new();
    let mut batch = Vec::with_capacity(BATCH);

    // What the walk couldn't read: the photos in there weren't seen, but they
    // aren't gone either.
    let mut unreadable: Vec<PathBuf> = Vec::new();
    let mut root_unreadable = false;
    let walker = WalkDir::new(&root).follow_links(false).into_iter().filter_entry(|e| e.depth() == 0 || !skipped(e));
    for entry in walker {
        if cancel.load(Ordering::Relaxed) {
            stats.cancelled = true;
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                stats.errors += 1;
                match err.path() {
                    Some(p) if p != root.as_path() => unreadable.push(p.to_path_buf()),
                    _ => root_unreadable = true,
                }
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let Some(format) = entry.path().extension().and_then(|e| e.to_str()).and_then(Format::from_extension) else {
            continue;
        };
        let Ok(meta) = entry.metadata() else {
            stats.errors += 1;
            unreadable.push(entry.path().to_path_buf());
            continue;
        };
        stats.discovered += 1;
        batch.push(Found {
            path: entry.into_path(),
            format,
            size: meta.len() as i64,
            mtime_ms: mtime_ms(&meta),
            dataless: is_dataless(&meta),
        });
        if batch.len() >= BATCH {
            process(db, source_id, scan_id, &known, std::mem::take(&mut batch), read_meta, &mut stats, &mut groups)?;
            progress(&stats);
        }
    }
    process(db, source_id, scan_id, &known, batch, read_meta, &mut stats, &mut groups)?;

    stats.paired = db.write(|c| {
        let tx = c.transaction()?;
        let n = pair_groups(&tx, &groups)?;
        tx.commit()?;
        Ok(n)
    })?;
    // Only a complete, readable walk can say a file is gone.
    if !stats.cancelled {
        let present_before = known.values().filter(|k| k.state != StorageState::Missing).count() as u64;
        let (missing, held) = mark_missing(db, source_id, scan_id, &root, &unreadable, root_unreadable, stats.discovered, present_before)?;
        stats.missing = missing;
        stats.held = held;
        let healed = heal_moves(db)? as u64;
        stats.moved += healed;
        stats.missing = stats.missing.saturating_sub(healed);
    }
    finish(db, source_id, scan_id, &stats)?;
    progress(&stats);
    Ok(stats)
}

/// Indexes just these files of a source, without walking its folder: for a
/// copy job that knows exactly what it just put there, while the files are
/// still on this Mac (so nothing has to come back down from the cloud). New
/// files are added, known ones refreshed, RAW + JPEG paired as in a scan;
/// nothing is ever marked missing, since the folder was not walked.
pub fn index_files(db: &Db, source_id: &str, paths: &[PathBuf], read_meta: MetadataReader) -> Result<ScanStats> {
    let started = now_ms();
    let scan_id = db.write(|c| {
        c.execute(
            "INSERT INTO scan_runs (source_id, started_ms, status) VALUES (?1, ?2, 'running')",
            params![source_id, started],
        )?;
        Ok(c.last_insert_rowid())
    })?;
    let known = load_known(db, source_id)?;
    let mut stats = ScanStats::default();
    let mut groups = HashSet::new();
    let mut batch = Vec::with_capacity(paths.len());
    for path in paths {
        let Some(format) = path.extension().and_then(|e| e.to_str()).and_then(Format::from_extension) else {
            continue;
        };
        let Ok(meta) = std::fs::symlink_metadata(path) else {
            stats.errors += 1;
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        stats.discovered += 1;
        batch.push(Found { path: path.clone(), format, size: meta.len() as i64, mtime_ms: mtime_ms(&meta), dataless: is_dataless(&meta) });
    }
    process(db, source_id, scan_id, &known, batch, read_meta, &mut stats, &mut groups)?;
    stats.paired = db.write(|c| {
        let tx = c.transaction()?;
        let n = pair_groups(&tx, &groups)?;
        tx.commit()?;
        Ok(n)
    })?;
    finish(db, source_id, scan_id, &stats)?;
    Ok(stats)
}

fn skipped(entry: &DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy().to_lowercase();
    // Hidden files include the "._IMG_1234.JPG" AppleDouble files macOS writes on exFAT drives.
    name.starts_with('.')
        || (entry.file_type().is_dir() && LIBRARY_BUNDLES.iter().any(|suffix| name.ends_with(suffix)))
}

pub fn is_dataless(meta: &std::fs::Metadata) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        meta.st_flags() & SF_DATALESS != 0
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = meta;
        false
    }
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Marks what this scan didn't see as missing, except where it couldn't look:
/// inside unreadable folders, or when the whole folder seems to have
/// vanished mid-scan (a drive or Google Drive dropping out) or reads as
/// empty. Returns (marked missing, held back).
#[allow(clippy::too_many_arguments)]
fn mark_missing(
    db: &Db,
    source_id: &str,
    scan_id: i64,
    root: &Path,
    unreadable: &[PathBuf],
    root_unreadable: bool,
    discovered: u64,
    present_before: u64,
) -> Result<(u64, u64)> {
    let unseen: Vec<(String, String)> = db.read(|c| {
        let mut stmt = c.prepare(
            "SELECT id, path FROM assets WHERE source_id = ?1 AND last_seen_scan < ?2 AND storage_state != 'missing'",
        )?;
        let rows = stmt.query_map(params![source_id, scan_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })?;
    if unseen.is_empty() {
        return Ok((0, 0));
    }
    let root_gone = std::fs::read_dir(root).is_err();
    // A folder that suddenly lists as empty (a cloud drive that isn't running)
    // is a glitch; a few deleted photos are just deleted.
    let empty_listing = discovered == 0 && present_before > 20;
    // Most of a large library gone at once is far more likely a glitch than a deletion.
    let mass_vanish = unseen.len() > 500 && (unseen.len() as u64) * 2 > present_before;
    if root_unreadable || root_gone || empty_listing || mass_vanish || unreadable.len() > 200 {
        return Ok((0, unseen.len() as u64));
    }
    let blocked = |path: &str| {
        let p = Path::new(path);
        unreadable.iter().any(|u| p == u || p.starts_with(u))
    };
    let (held, gone): (Vec<_>, Vec<_>) = unseen.into_iter().partition(|(_, path)| blocked(path));
    let now = now_ms();
    let marked = db.write(|c| {
        let tx = c.transaction()?;
        let mut n = 0;
        {
            let mut stmt = tx.prepare("UPDATE assets SET storage_state = 'missing', updated_ms = ?2 WHERE id = ?1")?;
            for (id, _) in &gone {
                n += stmt.execute(params![id, now])? as u64;
            }
        }
        tx.commit()?;
        Ok(n)
    })?;
    Ok((marked, held.len() as u64))
}

fn load_known(db: &Db, source_id: &str) -> Result<HashMap<String, Known>> {
    db.read(|c| {
        let mut stmt =
            c.prepare("SELECT id, photo_id, path, size, mtime_ms, storage_state FROM assets WHERE source_id = ?1")?;
        let mut rows = stmt.query([source_id])?;
        let mut known = HashMap::new();
        while let Some(r) = rows.next()? {
            let state: String = r.get(5)?;
            known.insert(
                r.get::<_, String>(2)?,
                Known {
                    id: r.get(0)?,
                    photo_id: r.get(1)?,
                    size: r.get(3)?,
                    mtime_ms: r.get(4)?,
                    state: StorageState::parse(&state)?,
                },
            );
        }
        Ok(known)
    })
}

#[allow(clippy::too_many_arguments)]
fn process(
    db: &Db,
    source_id: &str,
    scan_id: i64,
    known: &HashMap<String, Known>,
    batch: Vec<Found>,
    read_meta: MetadataReader,
    stats: &mut ScanStats,
    groups: &mut HashSet<(String, String)>,
) -> Result<()> {
    if batch.is_empty() {
        return Ok(());
    }
    // Read files first, outside the write lock. Unchanged and iCloud-only files are not opened.
    let work: Vec<(Found, Option<Read>)> = batch
        .into_iter()
        .map(|f| {
            let unchanged = known.get(f.path.to_string_lossy().as_ref()).is_some_and(|k| {
                k.size == f.size && k.mtime_ms == f.mtime_ms && k.state == StorageState::Local
            });
            let read = (!f.dataless && !unchanged).then(|| Read {
                fingerprint: fingerprint::quick(&f.path, f.size as u64).ok(),
                meta: read_meta(&f.path).unwrap_or_default(),
            });
            (f, read)
        })
        .collect();

    db.write(|c| {
        let tx = c.transaction()?;
        let now = now_ms();
        for (f, read) in work {
            match known.get(f.path.to_string_lossy().as_ref()) {
                Some(k) => update_known(&tx, k, &f, read, scan_id, now, stats)?,
                None => add_new(&tx, source_id, &f, read, scan_id, now, stats, groups)?,
            }
        }
        tx.commit()?;
        Ok(())
    })
}

fn update_known(
    tx: &Transaction,
    k: &Known,
    f: &Found,
    read: Option<Read>,
    scan_id: i64,
    now: i64,
    stats: &mut ScanStats,
) -> Result<()> {
    let state = if f.dataless { StorageState::CloudOnly } else { StorageState::Local };
    if k.size == f.size && k.mtime_ms == f.mtime_ms && k.state == state {
        tx.execute("UPDATE assets SET last_seen_scan = ?2 WHERE id = ?1", params![k.id, scan_id])?;
        stats.unchanged += 1;
        return Ok(());
    }
    match read {
        // Went (or stayed) iCloud-only: record what stat() says, read nothing.
        None => {
            tx.execute(
                "UPDATE assets SET size = ?2, mtime_ms = ?3, storage_state = ?4, last_seen_scan = ?5, updated_ms = ?6
                 WHERE id = ?1",
                params![k.id, f.size, f.mtime_ms, state.as_str(), scan_id, now],
            )?;
            stats.cloud_only += u64::from(f.dataless);
        }
        // Changed, reappeared or came down from iCloud: refresh everything we know.
        Some(r) => {
            let (captured_at, captured_source) = captured(&r.meta, f.mtime_ms);
            tx.execute(
                "UPDATE assets SET size = ?2, mtime_ms = ?3, fingerprint = ?4, captured_at = ?5,
                        captured_at_source = ?6, storage_state = 'local', last_seen_scan = ?7, updated_ms = ?8
                 WHERE id = ?1",
                params![k.id, f.size, f.mtime_ms, r.fingerprint, captured_at, captured_source, scan_id, now],
            )?;
            tx.execute(
                "UPDATE photos SET captured_at = ?3, captured_at_source = ?4, camera_make = ?5, camera_model = ?6,
                        width = ?7, height = ?8, orientation = ?9, latitude = ?10, longitude = ?11,
                        thumb_state = 'pending', updated_ms = ?12
                 WHERE id = ?1 AND EXISTS (SELECT 1 FROM assets WHERE id = ?2 AND is_primary = 1)",
                params![
                    k.photo_id,
                    k.id,
                    captured_at,
                    captured_source,
                    r.meta.camera_make,
                    r.meta.camera_model,
                    r.meta.width,
                    r.meta.height,
                    r.meta.orientation,
                    r.meta.latitude,
                    r.meta.longitude,
                    now
                ],
            )?;
        }
    }
    stats.updated += 1;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn add_new(
    tx: &Transaction,
    source_id: &str,
    f: &Found,
    read: Option<Read>,
    scan_id: i64,
    now: i64,
    stats: &mut ScanStats,
    groups: &mut HashSet<(String, String)>,
) -> Result<()> {
    let path = f.path.to_string_lossy().into_owned();
    let dir = f.path.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let stem = f.path.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    let filename = f.path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();

    // A known file under a new name or in a new folder: follow it, keeping its
    // photo and everything attached to it, instead of adding a duplicate. By
    // content when it can be read; a cloud-only file (never read, so never
    // fingerprinted) by its name and exact size.
    let by_content = match read.as_ref().and_then(|r| r.fingerprint.as_deref()) {
        Some(fp) => find_moved(tx, fp)?,
        None => None,
    };
    let moved = match by_content {
        Some(id) => Some(id),
        None => find_moved_by_name(tx, &filename, f.size)?,
    };
    {
        if let Some(asset_id) = moved {
            tx.execute(
                "UPDATE assets SET source_id = ?2, path = ?3, dir = ?4, stem = ?5, filename = ?6, size = ?7,
                        mtime_ms = ?8, storage_state = 'local', last_seen_scan = ?9, updated_ms = ?10
                 WHERE id = ?1",
                params![asset_id, source_id, path, dir, stem, filename, f.size, f.mtime_ms, scan_id, now],
            )?;
            stats.moved += 1;
            return Ok(());
        }
    }

    let meta = read.as_ref().map(|r| r.meta.clone()).unwrap_or_default();
    let fingerprint = read.as_ref().and_then(|r| r.fingerprint.clone());
    let (captured_at, captured_source) = captured(&meta, f.mtime_ms);
    let (storage, thumb) = if f.dataless { (StorageState::CloudOnly, "unavailable") } else { (StorageState::Local, "pending") };
    let media = if f.format.is_raw() { MediaKind::Raw } else { MediaKind::Image };
    let photo_id = new_id();
    tx.execute(
        "INSERT INTO photos (id, media_kind, captured_at, captured_at_source, camera_make, camera_model,
                             width, height, orientation, latitude, longitude, thumb_state, created_ms, updated_ms, is_video)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, ?14)",
        params![
            photo_id,
            media.as_str(),
            captured_at,
            captured_source,
            meta.camera_make,
            meta.camera_model,
            meta.width,
            meta.height,
            meta.orientation,
            meta.latitude,
            meta.longitude,
            thumb,
            now,
            f.format.is_video()
        ],
    )?;
    tx.execute(
        "INSERT INTO assets (id, photo_id, source_id, path, dir, stem, filename, format, is_raw, is_primary,
                             size, mtime_ms, fingerprint, captured_at, captured_at_source, storage_state,
                             last_seen_scan, created_ms, updated_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)",
        params![
            new_id(),
            photo_id,
            source_id,
            path,
            dir,
            stem,
            filename,
            f.format.as_str(),
            f.format.is_raw(),
            f.size,
            f.mtime_ms,
            fingerprint,
            captured_at,
            captured_source,
            storage.as_str(),
            scan_id,
            now
        ],
    )?;
    stats.added += 1;
    stats.cloud_only += u64::from(f.dataless);
    groups.insert((dir, stem));
    Ok(())
}

/// The one asset with this file name and exact size whose recorded path no
/// longer exists has moved. None when there are several: too uncertain.
fn find_moved_by_name(tx: &Transaction, filename: &str, size: i64) -> Result<Option<String>> {
    let mut stmt = tx.prepare_cached("SELECT id, path FROM assets WHERE filename = ?1 AND size = ?2")?;
    let gone: Vec<String> = stmt
        .query_map(params![filename, size], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|(_, path)| !Path::new(path).exists())
        .map(|(id, _)| id)
        .collect();
    Ok(if gone.len() == 1 { gone.into_iter().next() } else { None })
}

/// Merges what an unmatched move left behind: a missing asset (the original,
/// with its review, edits and albums) and a present file with the same name
/// and size that became a new, untouched photo. The original takes the new
/// place; the duplicate goes. Only one-to-one pairs, and only duplicates
/// nobody has touched (unreviewed, in no album, post or look, untagged).
pub fn heal_moves(db: &Db) -> Result<usize> {
    db.write(|c| {
        let tx = c.transaction()?;
        let pairs: Vec<(String, String, String)> = {
            let mut stmt = tx.prepare(
                "SELECT o.id, n.id, n.photo_id FROM assets o
                 JOIN assets n ON n.filename = o.filename AND n.size = o.size AND n.photo_id <> o.photo_id
                 JOIN photos np ON np.id = n.photo_id
                 WHERE o.storage_state = 'missing' AND n.storage_state <> 'missing'
                   AND np.review_state = 'unreviewed'
                   AND NOT EXISTS (SELECT 1 FROM photo_albums x WHERE x.photo_id = n.photo_id)
                   AND NOT EXISTS (SELECT 1 FROM photo_tags x WHERE x.photo_id = n.photo_id)
                   AND NOT EXISTS (SELECT 1 FROM post_photos x WHERE x.photo_id = n.photo_id)
                   AND NOT EXISTS (SELECT 1 FROM photo_looks x WHERE x.photo_id = n.photo_id)
                   AND (SELECT COUNT(*) FROM assets o2 WHERE o2.filename = o.filename AND o2.size = o.size AND o2.storage_state = 'missing') = 1
                   AND (SELECT COUNT(*) FROM assets n2 WHERE n2.filename = o.filename AND n2.size = o.size AND n2.storage_state <> 'missing') = 1",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };
        let now = super::now_ms();
        let mut dropped_photos = HashSet::new();
        for (old, new, new_photo) in &pairs {
            let (source_id, path, dir, stem, filename, size, mtime, state, seen, fp): (String, String, String, String, String, i64, i64, String, i64, Option<String>) =
                tx.query_row(
                    "SELECT source_id, path, dir, stem, filename, size, mtime_ms, storage_state, last_seen_scan, fingerprint FROM assets WHERE id = ?1",
                    [new],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?)),
                )?;
            tx.execute("DELETE FROM assets WHERE id = ?1", [new])?;
            tx.execute(
                "UPDATE assets SET source_id = ?2, path = ?3, dir = ?4, stem = ?5, filename = ?6, size = ?7, mtime_ms = ?8,
                        storage_state = ?9, last_seen_scan = ?10, fingerprint = COALESCE(fingerprint, ?11), updated_ms = ?12
                 WHERE id = ?1",
                params![old, source_id, path, dir, stem, filename, size, mtime, state, seen, fp, now],
            )?;
            dropped_photos.insert(new_photo.clone());
        }
        for p in &dropped_photos {
            tx.execute("DELETE FROM photos WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM assets WHERE photo_id = ?1)", [p])?;
        }
        tx.commit()?;
        Ok(pairs.len())
    })
}

/// An asset with this content whose recorded path no longer exists has moved.
/// If the old path still exists, the new file is a copy, not a move.
fn find_moved(tx: &Transaction, fingerprint: &str) -> Result<Option<String>> {
    let mut stmt = tx.prepare_cached("SELECT id, path FROM assets WHERE fingerprint = ?1")?;
    let candidates: Vec<(String, String)> =
        stmt.query_map([fingerprint], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<_, _>>()?;
    Ok(candidates.into_iter().find(|(_, path)| !Path::new(path).exists()).map(|(id, _)| id))
}

pub(crate) fn captured(meta: &Metadata, mtime_ms: i64) -> (String, &'static str) {
    match &meta.captured_at {
        Some(t) => (t.clone(), "exif"),
        None => (file_time(mtime_ms), "file"),
    }
}

fn file_time(mtime_ms: i64) -> String {
    chrono::Local
        .timestamp_millis_opt(mtime_ms)
        .single()
        .map(|t| t.format("%Y-%m-%dT%H:%M:%S%.3f").to_string())
        .unwrap_or_else(|| "1970-01-01T00:00:00.000".into())
}

struct Member {
    asset_id: String,
    photo_id: String,
    review: String,
    asset_count: i64,
    candidate: Candidate,
}

/// Merges RAW + JPEG pairs found in the folders this scan added files to.
fn pair_groups(tx: &Transaction, groups: &HashSet<(String, String)>) -> Result<u64> {
    let now = now_ms();
    let mut paired = 0;
    let mut stmt = tx.prepare_cached(
        "SELECT a.id, a.photo_id, a.is_raw, a.captured_at, a.captured_at_source, a.mtime_ms, p.review_state,
                (SELECT COUNT(*) FROM assets x WHERE x.photo_id = a.photo_id)
         FROM assets a JOIN photos p ON p.id = a.photo_id
         WHERE a.dir = ?1 AND a.stem = ?2 AND a.storage_state != 'missing' AND p.is_video = 0",
    )?;
    for (dir, stem) in groups {
        let members: Vec<Member> = stmt
            .query_map(params![dir, stem], |r| {
                let captured: Option<String> = r.get(3)?;
                let source: Option<String> = r.get(4)?;
                Ok(Member {
                    asset_id: r.get(0)?,
                    photo_id: r.get(1)?,
                    review: r.get(6)?,
                    asset_count: r.get(7)?,
                    candidate: Candidate {
                        is_raw: r.get(2)?,
                        exif_time: if source.as_deref() == Some("exif") {
                            captured.as_deref().and_then(pairing::parse_captured_at)
                        } else {
                            None
                        },
                        mtime_ms: r.get(5)?,
                    },
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        let candidates: Vec<Candidate> = members.iter().map(|m| m.candidate.clone()).collect();
        let Some((r, i)) = pairing::pick_pair(&candidates) else { continue };
        let (raw, image) = (&members[r], &members[i]);
        if raw.photo_id == image.photo_id || raw.asset_count != 1 || image.asset_count != 1 {
            continue;
        }
        // Keep whichever photo was already reviewed; never merge two reviewed photos.
        let (keep, gone) = match (raw.review != "unreviewed", image.review != "unreviewed") {
            (true, true) => continue,
            (true, false) => (&raw.photo_id, &image.photo_id),
            _ => (&image.photo_id, &raw.photo_id),
        };
        tx.execute(
            "UPDATE assets SET photo_id = ?1, is_primary = (id = ?2), updated_ms = ?4 WHERE id IN (?2, ?3)",
            params![keep, image.asset_id, raw.asset_id, now],
        )?;
        // The JPEG becomes the primary file, so the thumbnail is remade from it.
        tx.execute(
            "UPDATE photos SET media_kind = 'raw_image', thumb_state = 'pending', updated_ms = ?2 WHERE id = ?1",
            params![keep, now],
        )?;
        // Carry everything attached to the absorbed photo over before its
        // (now empty) index row goes: albums, tags, posts, covers, avatars.
        for sql in [
            "UPDATE OR IGNORE photo_albums SET photo_id = ?1 WHERE photo_id = ?2",
            "UPDATE OR IGNORE photo_tags SET photo_id = ?1 WHERE photo_id = ?2",
            "UPDATE OR IGNORE post_photos SET photo_id = ?1 WHERE photo_id = ?2",
            "UPDATE local_copies SET photo_id = ?1 WHERE photo_id = ?2",
            "UPDATE albums SET cover_photo_id = ?1 WHERE cover_photo_id = ?2",
            "UPDATE accounts SET avatar_photo_id = ?1 WHERE avatar_photo_id = ?2",
        ] {
            tx.execute(sql, params![keep, gone])?;
        }
        // The emptied photo row is our own index entry, never a file.
        tx.execute(
            "DELETE FROM photos WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM assets WHERE photo_id = ?1)",
            params![gone],
        )?;
        paired += 1;
    }
    Ok(paired)
}

fn finish(db: &Db, source_id: &str, scan_id: i64, s: &ScanStats) -> Result<()> {
    let now = now_ms();
    db.write(|c| {
        c.execute(
            "UPDATE scan_runs SET finished_ms = ?2, status = 'done', discovered = ?3, added = ?4, updated = ?5,
                    moved = ?6, unchanged = ?7, cloud_only = ?8, missing = ?9, errors = ?10
             WHERE id = ?1",
            params![
                scan_id,
                now,
                s.discovered as i64,
                s.added as i64,
                s.updated as i64,
                s.moved as i64,
                s.unchanged as i64,
                s.cloud_only as i64,
                s.missing as i64,
                s.errors as i64
            ],
        )?;
        c.execute("UPDATE sources SET last_scan_finished_ms = ?2 WHERE id = ?1", params![source_id, now])?;
        Ok(())
    })
}
