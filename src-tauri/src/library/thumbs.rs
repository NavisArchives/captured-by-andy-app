//! Thumbnail and preview cache.
//!
//! Every local photo gets a small thumbnail plus a ThumbHash placeholder in the
//! background. The large preview is made on demand (and ahead of the cursor in
//! cull mode) and the preview cache is size-capped: previews for a whole
//! 60k-photo library would need ~15 GB.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crossbeam_channel::Sender;
use rusqlite::{params, OptionalExtension};

use super::db::Db;
use super::model::{StorageState, ThumbState};
use super::{now_ms, Error, Result};

pub const THUMB_PX: u32 = 320;
pub const PREVIEW_PX: u32 = 2048;
const THUMB_QUALITY: f64 = 0.72;
const PREVIEW_QUALITY: f64 = 0.85;

pub struct Cache {
    root: PathBuf,
}

impl Cache {
    pub fn new(root: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(root.join("thumbs"))?;
        std::fs::create_dir_all(root.join("previews"))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn thumb(&self, id: &str) -> PathBuf {
        self.file("thumbs", id)
    }

    /// "-2k": previews used to be 1600 px; those are left for pruning to age out.
    pub fn preview(&self, id: &str) -> PathBuf {
        self.file("previews", &format!("{id}-2k"))
    }

    /// The whole photo at full resolution, for inspecting it (RAWs developed).
    pub fn original(&self, id: &str) -> PathBuf {
        self.file("previews", &format!("{id}-full-res"))
    }

    /// Sharded on the id's last two characters (random in a UUIDv7), so no
    /// folder ends up with 100k entries.
    /// `name` may carry a suffix after the id ("<id>-2k"): the shard still comes from the id.
    fn file(&self, kind: &str, name: &str) -> PathBuf {
        let id = &name[..name.len().min(36)];
        let shard = &id[id.len().saturating_sub(2)..];
        self.root.join(kind).join(shard).join(format!("{name}.jpg"))
    }
}

/// Photo ids reach the image protocol from the web view: accept only real
/// UUIDs so a request can never name a path.
pub fn is_photo_id(text: &str) -> bool {
    uuid::Uuid::parse_str(text).is_ok_and(|u| u.hyphenated().to_string() == text)
}

struct Primary {
    path: PathBuf,
    is_raw: bool,
    state: StorageState,
    size: u64,
    is_video: bool,
}

fn primary(db: &Db, id: &str) -> Result<Option<Primary>> {
    db.read(|c| {
        let found = c
            .query_row(
                "SELECT a.path, a.is_raw, a.storage_state, lc.path, a.size, p.is_video
                 FROM assets a JOIN photos p ON p.id = a.photo_id LEFT JOIN local_copies lc ON lc.asset_id = a.id
                 WHERE a.photo_id = ?1 AND a.is_primary = 1",
                [id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, bool>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, bool>(5)?,
                    ))
                },
            )
            .optional()?;
        match found {
            // The original when it is here, else the offline copy.
            Some((_, is_raw, state, Some(copy), size, is_video)) if state != "local" && Path::new(&copy).is_file() => {
                Ok(Some(Primary { path: copy.into(), is_raw, state: StorageState::Local, size: size as u64, is_video }))
            }
            Some((path, is_raw, state, _, size, is_video)) => {
                Ok(Some(Primary { path: path.into(), is_raw, state: StorageState::parse(&state)?, size: size as u64, is_video }))
            }
            None => Ok(None),
        }
    })
}

/// Free bytes on the volume that holds `path` (the Mac's disk for iCloud and
/// Google Drive files).
pub fn free_bytes(path: &Path) -> u64 {
    use std::os::unix::ffi::OsStrExt;
    let probe = std::iter::successors(Some(path), |p| p.parent()).find(|p| p.exists()).unwrap_or(Path::new("/"));
    let Ok(c) = std::ffi::CString::new(probe.as_os_str().as_bytes()) else { return 0 };
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return 0;
    }
    st.f_bavail as u64 * st.f_frsize as u64
}

/// Leaves this much free on the Mac whenever an online original is fetched.
const FETCH_RESERVE: u64 = 3_000_000_000;

fn is_downloaded(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| !super::scan::is_dataless(&m))
}

/// Runs `f` on the photo's original. One that lives online only (iCloud Drive,
/// Google Drive) is fetched for the moment by reading it, and released again
/// afterwards, so browsing and exporting never fill the Mac's disk.
#[cfg(target_os = "macos")]
/// Downloads macOS refused to release in a row. Background fetching stops at
/// 3, so a refusing cloud service can't slowly fill a nearly full disk.
static RELEASE_FAILURES: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
const RELEASE_FAILURE_LIMIT: u32 = 3;

#[cfg(target_os = "macos")]
fn release(path: &Path) {
    use std::sync::atomic::Ordering;
    if super::media::release_download(path) {
        RELEASE_FAILURES.store(0, Ordering::Relaxed);
    } else {
        RELEASE_FAILURES.fetch_add(1, Ordering::Relaxed);
    }
}

/// Whether background downloads should pause because releasing keeps failing.
pub fn releases_failing() -> bool {
    RELEASE_FAILURES.load(std::sync::atomic::Ordering::Relaxed) >= RELEASE_FAILURE_LIMIT
}

fn with_original<T>(p: &Primary, f: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
    match p.state {
        StorageState::Local | StorageState::AvailableOffline => f(&p.path),
        StorageState::CloudOnly | StorageState::Downloading => {
            if free_bytes(&p.path) < p.size + FETCH_RESERVE {
                return Err(Error::Media("not enough free space on this Mac to fetch the original".into()));
            }
            let was_online = !is_downloaded(&p.path);
            if was_online {
                super::media::fetch_download(&p.path)?;
            }
            let out = f(&p.path);
            if was_online && is_downloaded(&p.path) {
                release(&p.path);
            }
            out
        }
        StorageState::Missing => Err(Error::Media("original is missing".into())),
    }
}

/// Makes one photo's thumbnail and ThumbHash and records the outcome.
#[cfg(target_os = "macos")]
pub fn make_thumbnail(db: &Db, cache: &Cache, id: &str) -> Result<ThumbState> {
    use super::media;
    let p = primary(db, id)?.ok_or_else(|| Error::Invalid(format!("unknown photo {id}")))?;
    if p.is_video {
        return video_thumbnail(db, cache, id, &p.path);
    }
    let (state, hash) = if p.state != StorageState::Local {
        (ThumbState::Unavailable, None)
    } else {
        match media::thumbnail(&p.path, THUMB_PX, p.is_raw)
            .and_then(|img| media::write_jpeg(&img, &cache.thumb(id), THUMB_QUALITY).map(|()| img))
        {
            Ok(img) => {
                // Measured from the thumbnail while it is decoded anyway: feeds
                // the automatic filters and auto tone.
                if let Some((w, h, rgba)) = media::rgba_scaled(&img, THUMB_PX as usize) {
                    let _ = super::auto::record(db, id, &super::auto::stats(w, h, &rgba));
                }
                (ThumbState::Ready, media::thumbhash(&img))
            }
            Err(_) => (ThumbState::Failed, None),
        }
    };
    db.write(|c| {
        c.execute(
            "UPDATE photos SET thumb_state = ?2, thumbhash = COALESCE(?3, thumbhash), updated_ms = ?4 WHERE id = ?1",
            params![id, state.as_str(), hash, now_ms()],
        )?;
        Ok(())
    })?;
    Ok(state)
}

/// A video's tile: one frame, plus its length and filming date. Works on a
/// video that lives online too, reading only a few MB of it.
#[cfg(target_os = "macos")]
fn video_thumbnail(db: &Db, cache: &Cache, id: &str, path: &Path) -> Result<ThumbState> {
    use super::media;
    let dest = cache.thumb(id);
    // Online clips trickle in through the Google Drive app: 20 s at most, so
    // one slow clip can't hold up a thumbnail worker (it's tried again later).
    let (state, hash, info) = match media::video_frame_within(path, &dest, THUMB_PX, Some(std::time::Duration::from_secs(20))) {
        Ok(info) => {
            let hash = media::thumbnail(&dest, THUMB_PX, false).ok().and_then(|img| media::thumbhash(&img));
            (ThumbState::Ready, hash, Some(info))
        }
        Err(_) => (ThumbState::Failed, None, None),
    };
    db.write(|c| {
        let tx = c.transaction()?;
        tx.execute(
            "UPDATE photos SET thumb_state = ?2, thumbhash = COALESCE(?3, thumbhash), updated_ms = ?4 WHERE id = ?1",
            params![id, state.as_str(), hash, now_ms()],
        )?;
        if let Some(info) = &info {
            tx.execute(
                "UPDATE photos SET duration_s = ?2, width = COALESCE(NULLIF(?3, 0), width), height = COALESCE(NULLIF(?4, 0), height) WHERE id = ?1",
                params![id, info.seconds, info.width, info.height],
            )?;
            // The filming date beats a file date; the camera's own clock beats both.
            if let Some(created) = &info.created {
                let only_file = if info.clock { "" } else { " AND captured_at_source = 'file'" };
                tx.execute(
                    &format!("UPDATE photos SET captured_at = ?2, captured_at_source = 'exif' WHERE id = ?1{only_file}"),
                    params![id, created],
                )?;
                tx.execute(
                    &format!("UPDATE assets SET captured_at = ?2, captured_at_source = 'exif' WHERE photo_id = ?1{only_file}"),
                    params![id, created],
                )?;
            }
            tx.execute(
                "UPDATE photos SET gamma = ?2, camera_model = COALESCE(?3, camera_model) WHERE id = ?1",
                params![id, info.gamma.as_deref().unwrap_or("unknown"), info.camera],
            )?;
        }
        tx.commit()?;
        Ok(())
    })?;
    Ok(state)
}

/// Longest wait for one frame of a clip read through the Google Drive app.
const VIDEO_FRAME_LIMIT: std::time::Duration = std::time::Duration::from_secs(60);

/// Returns the preview file, making it first if needed. Recently used previews
/// get a fresh mtime so pruning removes the least recently viewed first.
#[cfg(target_os = "macos")]
pub fn preview(db: &Db, cache: &Cache, id: &str) -> Result<PathBuf> {
    use super::media;
    let dest = cache.preview(id);
    if dest.exists() {
        let _ = std::fs::File::options().append(true).open(&dest).and_then(|f| f.set_modified(std::time::SystemTime::now()));
        return Ok(dest);
    }
    let p = primary(db, id)?.ok_or_else(|| Error::Invalid(format!("unknown photo {id}")))?;
    if p.is_video {
        // Given up after a minute: a clip freed by the Drive app can hang the
        // read for good, and with it a prefetch worker (13 Nov: three, all night).
        media::video_frame_within(&p.path, &dest, PREVIEW_PX, Some(VIDEO_FRAME_LIMIT))?;
        return Ok(dest);
    }
    with_original(&p, |path| {
        let image = media::thumbnail(path, PREVIEW_PX, p.is_raw)?;
        media::write_jpeg(&image, &dest, PREVIEW_QUALITY)
    })?;
    Ok(dest)
}

/// A larger JPEG for exports, kept beside the previews (and pruned with them).
#[cfg(target_os = "macos")]
pub fn export_source(db: &Db, cache: &Cache, id: &str, max_px: u32) -> Result<PathBuf> {
    use super::media;
    // "-full2": files from before RAWs were always developed could be too small;
    // they are left for `prune_previews` to age out.
    let dest = cache.file("previews", &format!("{id}-full2"));
    if dest.exists() {
        return Ok(dest);
    }
    let p = primary(db, id)?.ok_or_else(|| Error::Invalid(format!("unknown photo {id}")))?;
    if p.is_video {
        // A still of the video (e.g. for a post's cover), never the whole file.
        media::video_frame_within(&p.path, &dest, max_px, Some(VIDEO_FRAME_LIMIT * 2))?;
        return Ok(dest);
    }
    // Always develop: a RAW's embedded preview (~1600 px on Sony) would pass
    // `thumbnail`'s "big enough" test yet come out under 1080 px wide at 4:5.
    with_original(&p, |path| {
        let image = media::thumbnail(path, max_px, false)?;
        media::write_jpeg(&image, &dest, 0.92)
    })?;
    Ok(dest)
}

/// The photo at full resolution, to inspect it: a JPEG/HEIC/PNG original is
/// served as it is (fetched first when it lives online), a RAW is developed
/// once at full size and kept beside the previews.
#[cfg(target_os = "macos")]
pub fn original(db: &Db, cache: &Cache, id: &str) -> Result<PathBuf> {
    use super::media;
    let p = primary(db, id)?.ok_or_else(|| Error::Invalid(format!("unknown photo {id}")))?;
    if p.is_video {
        return Err(Error::Invalid("videos play in the player".into()));
    }
    if !p.is_raw {
        if p.state == StorageState::Missing {
            return Err(Error::Media("original is missing".into()));
        }
        if !is_downloaded(&p.path) {
            if free_bytes(&p.path) < p.size + FETCH_RESERVE {
                return Err(Error::Media("not enough free space on this Mac to fetch the original".into()));
            }
            media::fetch_download(&p.path)?;
        }
        return Ok(p.path);
    }
    let dest = cache.original(id);
    if !dest.exists() {
        with_original(&p, |path| {
            let image = media::thumbnail(path, 100_000, false)?;
            media::write_jpeg(&image, &dest, 0.92)
        })?;
    }
    Ok(dest)
}

/// The video file to play (streamed in parts, so an online one is not
/// downloaded first), and its size.
pub fn video_file(db: &Db, id: &str) -> Result<(PathBuf, u64)> {
    let p = primary(db, id)?.ok_or_else(|| Error::Invalid(format!("unknown photo {id}")))?;
    if !p.is_video || p.state == StorageState::Missing {
        return Err(Error::Invalid("not a playable video".into()));
    }
    Ok((p.path, p.size))
}

/// Makes the sharp preview of every photo that has none yet, newest first,
/// a few at a time, so browsing never waits. Online originals are fetched for
/// the moment and released again. Stops early when `cancel` is set; running
/// it again carries on.
#[cfg(target_os = "macos")]
pub fn prefetch_previews(
    db: &Db,
    cache: &Cache,
    cancel: &std::sync::atomic::AtomicBool,
    max_bytes: u64,
    mut progress: impl FnMut(usize, usize) + Send,
) -> Result<usize> {
    use std::sync::atomic::{AtomicU64, Ordering};
    let ids: Vec<String> = db.read(|c| {
        let mut stmt = c.prepare(
            // Rejected photos are rarely looked at again: no sharp preview made ahead
            // for them (one is still made the moment one is opened).
            "SELECT p.id FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
             WHERE a.storage_state != 'missing' AND p.review_state != 'rejected' ORDER BY p.captured_at DESC",
        )?;
        let rows = stmt.query_map([], |r| r.get(0))?.collect::<std::result::Result<Vec<String>, _>>()?;
        Ok(rows)
    })?;
    let todo: Vec<String> = ids.into_iter().filter(|id| !cache.preview(id).exists()).collect();
    // Stay inside the preview budget while filling it: the newest photos get
    // previews first, older ones are made when opened.
    let used = AtomicU64::new(previews_size(cache));
    let budget = max_bytes.saturating_sub(max_bytes / 20);
    let next = std::sync::atomic::AtomicUsize::new(0);
    let done = std::sync::atomic::AtomicUsize::new(0);
    let total = todo.len();
    let report = Mutex::new(&mut progress);
    if let Ok(mut f) = report.lock() {
        (*f)(0, total);
    }
    std::thread::scope(|scope| {
        for _ in 0..3 {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= todo.len() || cancel.load(Ordering::Relaxed) || releases_failing() || used.load(Ordering::Relaxed) >= budget {
                    break;
                }
                if let Ok(file) = preview(db, cache, &todo[i]) {
                    used.fetch_add(file.metadata().map(|m| m.len()).unwrap_or(0), Ordering::Relaxed);
                    let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                    if let Ok(mut f) = report.lock() {
                        (*f)(n, total);
                    }
                }
            });
        }
    });
    let n = done.into_inner();
    if let Ok(mut f) = report.lock() {
        (*f)(total, total);
    }
    Ok(n)
}

/// Online-only photos (iCloud Drive, Google Drive) get what local ones get:
/// thumbnail, placeholder, capture date, camera, size and analysis. Each
/// primary original is fetched for a moment by reading it and released again,
/// one at a time, always leaving `FETCH_RESERVE` free. Returns how many were
/// done; stops early when space runs short, the network fails or `cancel` is
/// set, and simply carries on the next time it runs.
#[cfg(target_os = "macos")]
pub fn fill_online(db: &Db, cache: &Cache, cancel: &std::sync::atomic::AtomicBool, mut progress: impl FnMut(usize)) -> Result<usize> {
    use std::sync::atomic::Ordering;
    let mut done = 0;
    loop {
        let batch: Vec<(String, String, String, i64, i64, bool, bool)> = db.read(|c| {
            let mut stmt = c.prepare(
                "SELECT p.id, a.id, a.path, a.size, a.mtime_ms, a.is_raw, p.is_video
                 FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
                 WHERE a.storage_state = 'cloud_only' AND p.thumb_state = 'unavailable'
                 ORDER BY p.captured_at DESC LIMIT 25",
            )?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        if batch.is_empty() {
            return Ok(done);
        }
        for (photo, asset, path, size, mtime_ms, is_raw, is_video) in batch {
            if cancel.load(Ordering::Relaxed) || releases_failing() {
                return Ok(done);
            }
            if is_video {
                // A frame is enough, and only a few MB of the video are read for it.
                let state = video_thumbnail(db, cache, &photo, Path::new(&path));
                // Not read because it never came down (network, Drive busy): not broken.
                // It stays waiting and is tried again next time instead of failing for good.
                if !matches!(state, Ok(ThumbState::Ready)) && !is_downloaded(Path::new(&path)) {
                    db.write(|c| {
                        c.execute("UPDATE photos SET thumb_state = 'unavailable', updated_ms = ?2 WHERE id = ?1", params![photo, now_ms()])?;
                        Ok(())
                    })?;
                }
                done += 1;
                progress(done);
                continue;
            }
            if free_bytes(Path::new(&path)) < size as u64 + FETCH_RESERVE {
                return Ok(done);
            }
            let path = PathBuf::from(path);
            let was_online = !is_downloaded(&path);
            let result = fill_one(db, cache, &photo, &asset, &path, size, mtime_ms, is_raw);
            let fetched = is_downloaded(&path);
            if was_online && fetched {
                release(&path);
            }
            match result {
                Ok(()) => done += 1,
                // It never came down: the network or the cloud service. Try again another time.
                Err(_) if !fetched => return Ok(done),
                // It came down but can't be read as a photo.
                Err(_) => {
                    db.write(|c| {
                        c.execute("UPDATE photos SET thumb_state = 'failed', updated_ms = ?2 WHERE id = ?1", params![photo, now_ms()])?;
                        Ok(())
                    })?;
                }
            }
            progress(done);
        }
    }
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn fill_one(db: &Db, cache: &Cache, photo: &str, asset: &str, path: &Path, size: i64, mtime_ms: i64, is_raw: bool) -> Result<()> {
    use super::media;
    // ImageIO won't download a placeholder: fetch it ourselves first.
    if media::fetch_download(path).is_err() || !is_downloaded(path) {
        return Err(Error::Media("could not fetch the original".into()));
    }
    let meta = media::read_metadata(path).unwrap_or_default();
    let fingerprint = super::fingerprint::quick(path, size as u64).ok();
    let image = media::thumbnail(path, THUMB_PX, is_raw)?;
    media::write_jpeg(&image, &cache.thumb(photo), THUMB_QUALITY)?;
    // The sharp preview from the same download, so the original is fetched once.
    let sharp = cache.preview(photo);
    if !sharp.exists() {
        if let Ok(big) = media::thumbnail(path, PREVIEW_PX, is_raw) {
            let _ = media::write_jpeg(&big, &sharp, PREVIEW_QUALITY);
        }
    }
    if let Some((w, h, rgba)) = media::rgba_scaled(&image, THUMB_PX as usize) {
        let _ = super::auto::record(db, photo, &super::auto::stats(w, h, &rgba));
    }
    let hash = media::thumbhash(&image);
    let (captured_at, captured_source) = super::scan::captured(&meta, mtime_ms);
    db.write(|c| {
        let tx = c.transaction()?;
        let now = now_ms();
        tx.execute(
            "UPDATE assets SET fingerprint = COALESCE(?2, fingerprint), captured_at = ?3, captured_at_source = ?4, updated_ms = ?5
             WHERE id = ?1",
            params![asset, fingerprint, captured_at, captured_source, now],
        )?;
        tx.execute(
            "UPDATE photos SET captured_at = ?2, captured_at_source = ?3, camera_make = ?4, camera_model = ?5,
                    width = ?6, height = ?7, orientation = ?8, latitude = ?9, longitude = ?10,
                    thumb_state = 'ready', thumbhash = COALESCE(?11, thumbhash), updated_ms = ?12
             WHERE id = ?1",
            params![
                photo,
                captured_at,
                captured_source,
                meta.camera_make,
                meta.camera_model,
                meta.width,
                meta.height,
                meta.orientation,
                meta.latitude,
                meta.longitude,
                hash,
                now
            ],
        )?;
        tx.commit()?;
        Ok(())
    })
}

/// Videos indexed before their camera metadata was read (clock, camera,
/// picture profile): reads it now, a few MB from each clip's end, never the
/// whole file. Returns how many were updated.
#[cfg(target_os = "macos")]
pub fn refresh_video_meta(db: &Db, cancel: &std::sync::atomic::AtomicBool) -> Result<usize> {
    use std::sync::atomic::Ordering;
    let todo: Vec<(String, String)> = db.read(|c| {
        let mut stmt = c.prepare(
            "SELECT p.id, a.path FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
             WHERE p.is_video = 1 AND p.gamma IS NULL AND a.storage_state != 'missing' ORDER BY p.captured_at DESC",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })?;
    let mut done = 0;
    for (id, path) in todo {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let meta = super::media::clip_meta(Path::new(&path));
        db.write(|c| {
            let tx = c.transaction()?;
            if let Some(created) = &meta.created {
                tx.execute("UPDATE photos SET captured_at = ?2, captured_at_source = 'exif' WHERE id = ?1", params![id, created])?;
                tx.execute("UPDATE assets SET captured_at = ?2, captured_at_source = 'exif' WHERE photo_id = ?1", params![id, created])?;
            }
            tx.execute(
                "UPDATE photos SET gamma = ?2, camera_model = COALESCE(?3, camera_model), updated_ms = ?4 WHERE id = ?1",
                params![id, meta.gamma.as_deref().unwrap_or("unknown"), meta.camera, now_ms()],
            )?;
            tx.commit()?;
            Ok(())
        })?;
        done += 1;
    }
    Ok(done)
}

/// Bytes used by previews (and full-size views) right now.
pub fn previews_size(cache: &Cache) -> u64 {
    walkdir::WalkDir::new(cache.root().join("previews"))
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

/// Deletes the least recently used previews once the cache passes `max_bytes`,
/// down to 80% of it. Only ever touches files inside the preview cache.
pub fn prune_previews(cache: &Cache, max_bytes: u64) -> std::io::Result<u64> {
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(cache.root().join("previews")).into_iter().flatten() {
        if entry.file_type().is_file() {
            let meta = entry.metadata()?;
            files.push((entry.into_path(), meta.len(), meta.modified()?));
        }
    }
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= max_bytes {
        return Ok(0);
    }
    files.sort_by_key(|f| f.2);
    let target = max_bytes / 5 * 4;
    let mut removed = 0;
    for (path, len, _) in files {
        if total <= target {
            break;
        }
        std::fs::remove_file(path)?;
        total -= len;
        removed += len;
    }
    Ok(removed)
}

pub fn pending(db: &Db, limit: i64) -> Result<Vec<String>> {
    db.read(|c| {
        let mut stmt = c.prepare_cached(
            "SELECT id FROM photos WHERE thumb_state = 'pending' ORDER BY captured_at DESC LIMIT ?1",
        )?;
        let ids = stmt.query_map([limit], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(ids)
    })
}

/// A fixed pool of worker threads draining a queue of photo ids.
pub struct ThumbService {
    tx: Sender<String>,
    queued: Arc<Mutex<HashSet<String>>>,
}

impl ThumbService {
    #[cfg(target_os = "macos")]
    pub fn start(db: Arc<Db>, cache: Arc<Cache>, workers: usize, on_done: Arc<dyn Fn(usize) + Send + Sync>) -> Self {
        let (tx, rx) = crossbeam_channel::unbounded::<String>();
        let queued = Arc::new(Mutex::new(HashSet::new()));
        for n in 0..workers.max(1) {
            let (rx, db, cache, queued, on_done) = (rx.clone(), db.clone(), cache.clone(), queued.clone(), on_done.clone());
            std::thread::Builder::new()
                .name(format!("thumbs-{n}"))
                .spawn(move || {
                    for id in rx.iter() {
                        let _ = make_thumbnail(&db, &cache, &id);
                        let remaining = {
                            let mut queued = queued.lock().unwrap_or_else(|e| e.into_inner());
                            queued.remove(&id);
                            queued.len()
                        };
                        on_done(remaining);
                    }
                })
                .expect("spawn thumbnail worker");
        }
        Self { tx, queued }
    }

    /// Queues every photo still waiting for a thumbnail, newest first.
    pub fn enqueue_pending(&self, db: &Db) -> Result<usize> {
        let ids = pending(db, 1_000_000)?;
        let mut queued = self.queued.lock().unwrap_or_else(|e| e.into_inner());
        let mut added = 0;
        for id in ids {
            if queued.insert(id.clone()) && self.tx.send(id).is_ok() {
                added += 1;
            }
        }
        Ok(added)
    }

    pub fn queued(&self) -> usize {
        self.queued.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

/// Measures photos whose thumbnail predates the automatic analysis, from the
/// cached thumbnail (never the original).
#[cfg(target_os = "macos")]
pub fn analyse_backlog(db: &Db, cache: &Cache, cancel: &std::sync::atomic::AtomicBool) -> Result<usize> {
    use super::{auto, media};
    let mut done = 0;
    loop {
        let ids = auto::unanalysed(db, 500)?;
        if ids.is_empty() || cancel.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
        let mut progressed = false;
        for id in ids {
            let path = cache.thumb(&id);
            let stats = media::thumbnail(&path, THUMB_PX, false)
                .ok()
                .and_then(|img| media::rgba_scaled(&img, THUMB_PX as usize))
                .map(|(w, h, rgba)| auto::stats(w, h, &rgba));
            match stats {
                Some(s) => {
                    auto::record(db, &id, &s)?;
                    done += 1;
                    progressed = true;
                }
                None => {
                    // Thumbnail file gone: have it remade (and measured) by the worker.
                    db.write(|c| {
                        c.execute("UPDATE photos SET thumb_state = 'pending' WHERE id = ?1", [&id])?;
                        Ok(())
                    })?;
                }
            }
        }
        if !progressed {
            break;
        }
    }
    auto::regroup_bursts(db)?;
    Ok(done)
}
