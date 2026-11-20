//! Download / Remove download: an online-only original (Google Drive, iCloud
//! Drive) made available on this Mac in place, through the Drive app, and set
//! back to online-only again. No second copy is made, and nothing on Drive is
//! ever changed or deleted: removing a download only frees this Mac's space.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use rusqlite::params;
use serde::Serialize;

use super::db::Db;
use super::{media, now_ms, review, scan, thumbs, Result};

/// A download never leaves less than this free on the Mac.
pub const KEEP_FREE: u64 = 10_000_000_000;

#[derive(Debug, Clone)]
struct Item {
    asset_id: String,
    path: PathBuf,
    size: u64,
    online: bool,
}

/// In a cloud folder whose files can be online-only (Google Drive, iCloud Drive).
fn in_cloud_folder(path: &Path) -> bool {
    let p = path.to_string_lossy();
    p.contains("/Library/CloudStorage/") || p.contains("/Library/Mobile Documents/")
}

fn is_online(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| scan::is_dataless(&m))
}

/// The shown original of each photo, as it is on disk now.
fn items(db: &Db, ids: &[String]) -> Result<Vec<Item>> {
    let rows: Vec<(String, String, i64)> = db.read(|c| {
        let mut stmt = c.prepare_cached(
            "SELECT a.id, a.path, a.size FROM assets a
             WHERE a.photo_id = ?1 AND a.is_primary = 1 AND a.storage_state <> 'missing'",
        )?;
        let mut out = Vec::new();
        for id in ids {
            if let Some(r) = stmt.query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.next() {
                out.push(r?);
            }
        }
        Ok(out)
    })?;
    Ok(rows
        .into_iter()
        .map(|(asset_id, path, size)| {
            let path = PathBuf::from(path);
            Item { online: is_online(&path), asset_id, path, size: size.max(0) as u64 }
        })
        .filter(|i| in_cloud_folder(&i.path))
        .collect())
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// Originals still online-only, and what downloading them takes.
    pub online: usize,
    pub online_bytes: u64,
    /// Originals already on this Mac (they can be removed again).
    pub downloaded: usize,
    pub downloaded_bytes: u64,
    pub free: u64,
    pub free_after: u64,
    /// Downloading all of them still leaves `KEEP_FREE`.
    pub allowed: bool,
    pub keep_free: u64,
    /// The last measured download speed (bytes/s), for an estimate.
    pub speed: Option<f64>,
}

/// What Download and Remove download would do for these photos.
pub fn plan(db: &Db, ids: &[String], free: u64) -> Result<Plan> {
    let items = items(db, ids)?;
    let (on, down): (Vec<&Item>, Vec<&Item>) = items.iter().partition(|i| i.online);
    let online_bytes: u64 = on.iter().map(|i| i.size).sum();
    let free_after = free.saturating_sub(online_bytes);
    Ok(Plan {
        online: on.len(),
        online_bytes,
        downloaded: down.len(),
        downloaded_bytes: down.iter().map(|i| i.size).sum(),
        free,
        free_after,
        allowed: free_after >= KEEP_FREE,
        keep_free: KEEP_FREE,
        speed: review::speed(db),
    })
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: usize,
    pub total: usize,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub current: String,
    pub failed: usize,
    pub note: String,
}

fn set_state(db: &Db, asset_id: &str, state: &str) {
    let _ = db.write(|c| {
        c.execute("UPDATE assets SET storage_state = ?2, updated_ms = ?3 WHERE id = ?1", params![asset_id, state, now_ms()])?;
        Ok(())
    });
}

/// Reads one online original through the Drive app, which downloads it and
/// keeps it on this Mac. `seen` gets the bytes on disk so far.
fn materialise(path: &Path, size: u64, cancel: &AtomicBool, seen: &AtomicU64) -> std::io::Result<()> {
    // The Drive app may hand data over only once the whole file is in, so the
    // space the file takes on disk is watched too.
    let watching = AtomicBool::new(true);
    std::thread::scope(|s| {
        s.spawn(|| {
            use std::os::unix::fs::MetadataExt;
            while watching.load(Ordering::Relaxed) {
                if let Ok(m) = std::fs::symlink_metadata(path) {
                    seen.fetch_max((m.blocks() * 512).min(size), Ordering::Relaxed);
                }
                std::thread::sleep(std::time::Duration::from_millis(400));
            }
        });
        let result = (|| {
            let mut f = std::fs::File::open(path)?;
            let mut buf = vec![0u8; 4 << 20];
            let mut at = 0u64;
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "stopped"));
                }
                super::lane::yield_to_playback(|| cancel.load(Ordering::Relaxed));
                let n = f.read(&mut buf)?;
                if n == 0 {
                    return Ok(());
                }
                at += n as u64;
                seen.fetch_max(at.min(size), Ordering::Relaxed);
            }
        })();
        watching.store(false, Ordering::Relaxed);
        result
    })
}

/// A file that gets no further for this long is given up (Google Drive stuck).
const STALL: std::time::Duration = std::time::Duration::from_secs(180);

/// `materialise` on a thread of its own, watched: Stop and a stalled Drive
/// app are answered at once, even while a read is blocked inside the Drive app
/// (that read is left to finish by itself).
fn materialise_watched(path: &Path, size: u64, cancel: &AtomicBool, mut progress: impl FnMut(u64)) -> std::io::Result<()> {
    use std::sync::Arc;
    let stop = Arc::new(AtomicBool::new(false));
    let seen = Arc::new(AtomicU64::new(0));
    let (tx, rx) = std::sync::mpsc::channel();
    {
        let (path, stop, seen) = (path.to_path_buf(), stop.clone(), seen.clone());
        std::thread::spawn(move || {
            let _ = tx.send(materialise(&path, size, &stop, &seen));
        });
    }
    let (mut last, mut moved) = (0u64, std::time::Instant::now());
    loop {
        match rx.recv_timeout(std::time::Duration::from_millis(500)) {
            Ok(result) => return result,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Err(std::io::Error::other("the download stopped")),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }
        let now = seen.load(Ordering::Relaxed);
        if now != last {
            last = now;
            moved = std::time::Instant::now();
            progress(now);
        }
        if cancel.load(Ordering::Relaxed) {
            stop.store(true, Ordering::SeqCst);
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "stopped"));
        }
        if moved.elapsed() > STALL && !super::lane::busy_playing() {
            stop.store(true, Ordering::SeqCst);
            return Err(std::io::Error::other("Google Drive sent nothing for 3 minutes"));
        }
    }
}

/// Downloads the online originals of `ids`, one at a time, in order, never
/// going below `KEEP_FREE`. Already-downloaded ones are skipped.
pub fn download(db: &Db, ids: &[String], cancel: &AtomicBool, mut report: impl FnMut(&Progress)) -> Result<Progress> {
    let todo: Vec<Item> = items(db, ids)?.into_iter().filter(|i| i.online).collect();
    let mut p = Progress { total: todo.len(), bytes_total: todo.iter().map(|i| i.size).sum(), ..Default::default() };
    report(&p);
    for item in todo {
        if cancel.load(Ordering::Relaxed) {
            p.note = "Stopped".into();
            break;
        }
        let free = thumbs::free_bytes(&item.path);
        if free < item.size + KEEP_FREE {
            p.note = format!("Stopped to keep {} GB free on this Mac", KEEP_FREE / 1_000_000_000);
            break;
        }
        p.current = item.path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_owned();
        report(&p);
        let lane = match super::lane::try_take() {
            Some(l) => l,
            None => {
                p.note = "Waiting for the preview being made to finish (one download at a time)".into();
                report(&p);
                let l = super::lane::take();
                p.note.clear();
                l
            }
        };
        let base = p.bytes_done;
        let started = std::time::Instant::now();
        let outcome = materialise_watched(&item.path, item.size, cancel, |seen| {
            p.bytes_done = base + seen;
            report(&p);
        });
        match outcome {
            Ok(()) if !is_online(&item.path) => {
                p.done += 1;
                p.bytes_done = base + item.size;
                set_state(db, &item.asset_id, "local");
                review::record_speed(db, item.size, started.elapsed().as_secs_f64());
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {
                p.bytes_done = base;
                p.note = "Stopped".into();
                break;
            }
            other => {
                p.failed += 1;
                p.bytes_done = base;
                crate::applog::line(&format!("download failed for {}: {:?}", item.path.display(), other.err()));
            }
        }
        drop(lane);
        report(&p);
    }
    p.current.clear();
    report(&p);
    Ok(p)
}

/// Sets downloaded originals of `ids` back to online-only. They stay on
/// Google Drive, untouched. Returns how many went and the space freed.
pub fn remove(db: &Db, ids: &[String]) -> Result<(usize, u64)> {
    let (mut n, mut freed) = (0, 0);
    for item in items(db, ids)?.into_iter().filter(|i| !i.online) {
        if media::release_download(&item.path) && is_online(&item.path) {
            set_state(db, &item.asset_id, "cloud_only");
            n += 1;
            freed += item.size;
        }
    }
    Ok((n, freed))
}
