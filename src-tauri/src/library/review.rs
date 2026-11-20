//! Review copies: a light version of each video (720p H.264, about 2.5 Mbit/s,
//! S-Log3 already in normal colour) kept in the app's cache, so reviewing
//! never waits on Google Drive or iCloud and never needs the whole library
//! on this Mac. Made one video at a time: the original is downloaded, read
//! by the `review` helper, and its download released again. Originals are
//! only read.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use super::db::Db;
use super::{Error, Result};

/// Never let the disk go below this while making copies: an original being
/// turned into a preview sits on disk for a moment, and 10 GB stays free for
/// everything else. `CBA_KEEP_FREE_GB` changes it, for test runs only.
fn keep_free() -> u64 {
    std::env::var("CBA_KEEP_FREE_GB").ok().and_then(|v| v.parse::<f64>().ok()).map(|g| (g * 1e9) as u64).unwrap_or(10_000_000_000)
}

pub fn dir(cache_root: &Path) -> PathBuf {
    cache_root.join("review")
}

pub fn copy_path(cache_root: &Path, id: &str) -> PathBuf {
    dir(cache_root).join(format!("{id}.mp4"))
}

/// Edit copies: a sharp, light version of a video for the editor, 1080 on the
/// short side, H.264 with a keyframe every 3 frames so scrubbing back and
/// forth is instant, in the video's own colour (the editor converts S-Log3
/// itself, exactly as the export does). Kept on this Mac, the oldest dropped
/// past `EDIT_SPACE`.
pub fn edit_path(cache_root: &Path, id: &str) -> PathBuf {
    cache_root.join("edit").join(format!("{id}.mp4"))
}

pub fn edit_existing(cache_root: &Path, id: &str) -> Option<PathBuf> {
    let p = edit_path(cache_root, id);
    p.is_file().then_some(p)
}

/// Most space edit copies may take together.
const EDIT_SPACE: u64 = 4_000_000_000;
static EDIT_MAKING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The edit copy of a video, made now if it has none (reading the original,
/// which downloads it when it's online-only). `progress` gets 0..1.
pub fn make_edit_copy(db: &Db, cache_root: &Path, helper: &Path, id: &str, mut progress: impl FnMut(f64)) -> Result<PathBuf> {
    let _one_at_a_time = EDIT_MAKING.lock().unwrap_or_else(|e| e.into_inner());
    let out = edit_path(cache_root, id);
    if out.is_file() {
        // Recently used: kept when older copies make room.
        let _ = std::fs::File::options().append(true).open(&out).and_then(|f| f.set_modified(std::time::SystemTime::now()));
        return Ok(out);
    }
    let (original, size) = super::thumbs::video_file(db, id)?;
    std::fs::create_dir_all(out.parent().expect("edit dir"))?;
    if super::thumbs::free_bytes(cache_root) < size / 3 + keep_free() {
        return Err(Error::Invalid("not enough free space on this Mac for a smooth copy".into()));
    }
    let mut child = std::process::Command::new(helper)
        .arg(&original)
        .arg(&out)
        .args(["--short", "1080", "--bitrate", "12000000", "--keyframes", "3"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    let mut outcome = String::new();
    if let Some(stdout) = child.stdout.take() {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stdout).lines().map_while(std::result::Result::ok) {
            match line.strip_prefix("progress ").and_then(|f| f.trim().parse::<f64>().ok()) {
                Some(f) => progress(f),
                None => outcome = line,
            }
        }
    }
    let _ = child.wait();
    if outcome != "done" || !out.is_file() {
        let _ = std::fs::remove_file(&out);
        return Err(Error::Media(format!("the smooth copy couldn't be made: {}", outcome.trim_start_matches("error "))));
    }
    trim_edit_copies(cache_root, &out);
    Ok(out)
}

/// Drops the oldest edit copies (never `keep`) until they fit `EDIT_SPACE`.
fn trim_edit_copies(cache_root: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(cache_root.join("edit")) else { return };
    let mut copies: Vec<(std::time::SystemTime, u64, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            (m.is_file() && e.path().extension().is_some_and(|x| x == "mp4")).then(|| (m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len(), e.path()))
        })
        .collect();
    copies.sort();
    let mut total: u64 = copies.iter().map(|c| c.1).sum();
    for (_, len, path) in copies {
        if total <= EDIT_SPACE {
            break;
        }
        if path != keep && std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

/// The review copy of a video, if it has one.
pub fn existing(cache_root: &Path, id: &str) -> Option<PathBuf> {
    let p = copy_path(cache_root, id);
    p.is_file().then_some(p)
}

/// Marks a review copy as just played, so the cap drops it last.
pub fn touch(path: &Path) {
    let _ = std::fs::File::options().append(true).open(path).and_then(|f| f.set_modified(std::time::SystemTime::now()));
}

/// Settings key: most space review copies may take, in GB.
pub const CAP_KEY: &str = "review.capGB";
pub const DEFAULT_CAP_GB: f64 = 10.0;

pub fn cap_bytes(db: &Db) -> u64 {
    let gb = super::settings::get(db, CAP_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.trim_matches('"').parse::<f64>().ok())
        .filter(|g| g.is_finite() && *g > 0.0)
        .unwrap_or(DEFAULT_CAP_GB);
    (gb * 1e9) as u64
}

/// Drops the least recently played review copies (never one in `keep`) until
/// `need` more bytes fit under `cap`. Returns whether they fit.
pub fn make_room(cache_root: &Path, cap: u64, need: u64, keep: &[String]) -> bool {
    let Ok(entries) = std::fs::read_dir(dir(cache_root)) else { return need <= cap };
    let mut copies: Vec<(std::time::SystemTime, u64, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            (m.is_file() && e.path().extension().is_some_and(|x| x == "mp4")).then(|| (m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len(), e.path()))
        })
        .collect();
    copies.sort();
    let mut total: u64 = copies.iter().map(|c| c.1).sum();
    for (_, len, path) in copies {
        if total + need <= cap {
            break;
        }
        let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if !keep.iter().any(|k| k == id) && std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
    total + need <= cap
}

/// Clips asked for on screen: their copies are made first. Newest ask first.
static WANTED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// The clip being made now, and whether it was asked for on screen.
static CURRENT: std::sync::Mutex<Option<(String, bool)>> = std::sync::Mutex::new(None);
/// Set when a clip asked for on screen should go before the one in flight.
static ITEM_SKIP: AtomicBool = AtomicBool::new(false);

/// Puts a clip at the front of the queue. A background clip being made right
/// now is interrupted (and made again later), so the one on screen never
/// waits behind a 1.5 GB download.
pub fn want(id: &str) {
    let mut w = WANTED.lock().unwrap_or_else(|e| e.into_inner());
    w.retain(|x| x != id);
    w.insert(0, id.to_owned());
    w.truncate(50);
    if let Some((current, asked)) = CURRENT.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if current != id && !asked {
            ITEM_SKIP.store(true, Ordering::SeqCst);
        }
    }
}

/// Clips a Prepare culling asked for while a run was going: made right after
/// the clips on screen, without interrupting anything.
static PREPARED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

pub fn prepare(ids: &[String]) {
    let mut p = PREPARED.lock().unwrap_or_else(|e| e.into_inner());
    for id in ids {
        if !p.contains(id) {
            p.push(id.clone());
        }
    }
}

/// The clip left the screen before its preview was made: it goes back to its
/// normal place in the queue (a rejected one drops out).
pub fn unwant(id: &str) {
    done_wanting(id);
}

fn wanted() -> Vec<String> {
    WANTED.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn done_wanting(id: &str) {
    WANTED.lock().unwrap_or_else(|e| e.into_inner()).retain(|x| x != id);
}

/// Which clips get a review copy.
#[derive(Debug, Clone)]
pub enum Scope {
    /// Only clips still to review (the first version of review copies).
    Unreviewed,
    /// Every clip that isn't rejected: selected (newest first), then
    /// unreviewed (culling order), then maybes.
    Kept,
    /// Exactly these clips (Prepare culling), in this order.
    Only(Vec<String>),
}

#[derive(Debug, Clone)]
pub struct Todo {
    pub id: String,
    pub path: PathBuf,
    pub size: u64,
    pub log: bool,
    pub online: bool,
    pub rejected: bool,
}

/// Videos in `scope` that have no review copy yet, in the order they're
/// made. Clips asked for on screen (`want`) come first, whatever the scope.
pub fn todo(db: &Db, cache_root: &Path, scope: &Scope) -> Result<Vec<Todo>> {
    let mut list = todo_in(db, scope)?;
    let prepared: Vec<String> = PREPARED.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if !prepared.is_empty() {
        let mut first = todo_in(db, &Scope::Only(prepared))?.into_iter().filter(|t| !t.rejected).collect::<Vec<_>>();
        list.retain(|t| !first.iter().any(|f| f.id == t.id));
        first.extend(list);
        list = first;
    }
    let asked = wanted();
    if !asked.is_empty() {
        let mut first: Vec<Todo> = Vec::new();
        for id in &asked {
            if let Some(i) = list.iter().position(|t| &t.id == id) {
                first.push(list.remove(i));
            } else if let Some(t) = todo_in(db, &Scope::Only(vec![id.clone()]))?.pop() {
                // Rejected after it was asked for: not worth a download.
                if t.rejected {
                    done_wanting(id);
                } else {
                    first.push(t);
                }
            }
        }
        first.extend(list);
        list = first;
    }
    Ok(list.into_iter().filter(|t| existing(cache_root, &t.id).is_none()).collect())
}

/// Of these photos, the clips with no review copy yet (nothing else mixed in).
pub fn missing(db: &Db, cache_root: &Path, ids: &[String]) -> Result<Vec<Todo>> {
    let mut out = Vec::new();
    for chunk in ids.chunks(5000) {
        out.extend(todo_in(db, &Scope::Only(chunk.to_vec()))?.into_iter().filter(|t| existing(cache_root, &t.id).is_none()));
    }
    Ok(out)
}

fn todo_in(db: &Db, scope: &Scope) -> Result<Vec<Todo>> {
    let (filter, order) = match scope {
        Scope::Unreviewed => ("AND p.review_state = 'unreviewed'".to_owned(), "p.captured_at, p.id"),
        // Selected first, newest first (what Andy browses and posts), then the
        // clips still to cull, then maybes.
        Scope::Kept => (
            "AND p.review_state <> 'rejected'".to_owned(),
            "CASE p.review_state WHEN 'selected' THEN 0 WHEN 'unreviewed' THEN 1 ELSE 2 END,
             CASE WHEN p.review_state = 'unreviewed' THEN p.captured_at END, p.captured_at DESC, p.id",
        ),
        Scope::Only(ids) => {
            if ids.is_empty() {
                return Ok(Vec::new());
            }
            // Ids are checked UUIDs; the order is restored below.
            let list = ids.iter().filter(|i| super::thumbs::is_photo_id(i)).map(|i| format!("'{i}'")).collect::<Vec<_>>().join(",");
            (format!("AND p.id IN ({list})"), "p.id")
        }
    };
    let rows = db.read(|c| {
        let mut stmt = c.prepare(&format!(
            "SELECT p.id, a.path, a.size, COALESCE(p.gamma, ''), a.storage_state, p.review_state FROM photos p
             JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
             WHERE p.is_video = 1 AND a.storage_state <> 'missing' {filter}
             ORDER BY {order}"
        ))?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Todo {
                    id: r.get(0)?,
                    path: PathBuf::from(r.get::<_, String>(1)?),
                    size: r.get::<_, i64>(2)?.max(0) as u64,
                    log: r.get::<_, String>(3)?.contains("log"),
                    online: r.get::<_, String>(4)? == "cloud_only",
                    rejected: r.get::<_, String>(5)? == "rejected",
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })?;
    let mut rows = rows;
    if let Scope::Only(ids) = scope {
        rows.sort_by_key(|t| ids.iter().position(|i| i == &t.id).unwrap_or(usize::MAX));
    }
    Ok(rows)
}

/// Rejected videos don't need their original on this Mac: a downloaded one
/// is made online-only again (it stays in the cloud, untouched). `ready` says
/// whether a video may go now. Every clip keeps its review copy, rejected
/// ones too (a few MB each): until 16 Nov a rejected clip lost it, so going
/// back to it, or meeting it in a later cull, streamed from Drive.
/// Returns the number of downloaded originals released and their size.
pub fn offload_culled(db: &Db, cache_root: &Path, mut ready: impl FnMut(&str) -> bool) -> Result<(usize, u64)> {
    let rows = db.read(|c| {
        let mut stmt = c.prepare(
            "SELECT p.id, a.path, a.storage_state FROM photos p
             JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
             WHERE p.is_video = 1 AND p.review_state = 'rejected'",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, PathBuf::from(r.get::<_, String>(1)?), r.get::<_, String>(2)? == "cloud_only")))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })?;
    let (mut removed, mut bytes) = (0, 0);
    let _ = cache_root;
    for (id, path, online) in rows {
        let meta = std::fs::symlink_metadata(&path);
        let downloaded = online && meta.as_ref().is_ok_and(|m| !super::scan::is_dataless(m));
        if !downloaded || !ready(&id) {
            continue;
        }
        let size = meta.map(|m| m.len()).unwrap_or(0);
        super::media::release_download(&path);
        removed += 1;
        bytes += size;
    }
    Ok((removed, bytes))
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: usize,
    pub total: usize,
    pub skipped: usize,
    pub failed: usize,
    pub bytes: u64,
    /// Copies of culled videos removed this run.
    pub offloaded: usize,
    pub current: String,
    /// The clip being made now, and its original's size.
    pub current_id: String,
    pub current_size: u64,
    /// The clip whose copy just landed (players waiting on it switch over).
    pub last_ready: String,
    /// The clip whose copy couldn't be made (its player says so).
    pub last_failed: String,
    pub note: String,
}

/// Makes the missing review copies, one by one, until done or cancelled.
/// Videos too big for the free space are skipped (and named in `note`).
#[cfg(target_os = "macos")]
pub fn run(db: &Db, cache_root: &Path, helper: &Path, scope: &Scope, cancel: &AtomicBool, mut report: impl FnMut(&Progress)) -> Result<Progress> {
    std::fs::create_dir_all(dir(cache_root))?;
    // One maker at a time (the app's, or one started from the command line).
    let lock = dir(cache_root).join(".making");
    if let Ok(pid) = std::fs::read_to_string(&lock) {
        let alive = std::process::Command::new("/bin/kill").args(["-0", pid.trim()]).status().is_ok_and(|s| s.success());
        if alive && pid.trim() != std::process::id().to_string() {
            return Ok(Progress { note: "Review copies are already being made".into(), ..Default::default() });
        }
    }
    std::fs::write(&lock, std::process::id().to_string())?;
    // Downloads left behind by a run that was stopped (app quit, crash): only
    // this maker writes them, so none is in use now. Speed tests get 10 minutes.
    if let Ok(entries) = std::fs::read_dir(dir(cache_root)) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|a| a.as_secs() > 600);
            if name.starts_with(".direct-") || (name.starts_with(".speedtest-") && old) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let result = run_locked(db, cache_root, helper, scope, cancel, &mut report);
    let _ = std::fs::remove_file(&lock);
    result
}

/// What one review copy is counted as before it exists (720p at ~2.5 Mbit/s:
/// a 45 s clip is ~15 MB).
const COPY_ESTIMATE: u64 = 28_000_000;

/// Size of a review copy: 720 px on the short side (1280×720), ~2.5 Mbit/s.
/// The cloud notebook (tools/cloud-previews) makes the same.
const PREVIEW_SHORT: &str = "720";
const PREVIEW_BITRATE: &str = "2500000";

/// Clips whose preview failed in this session: the keeper doesn't start a run
/// just for them (a clip asked for on screen is still tried again).
static GAVE_UP: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// How many clips a background run would make now: waiting, not given up this
/// session, with room under the cap. 0 means there's nothing to start.
pub fn startable(db: &Db, cache_root: &Path) -> usize {
    if space(cache_root).1 + COPY_ESTIMATE > cap_bytes(db) {
        return 0;
    }
    let gave_up = GAVE_UP.lock().unwrap_or_else(|e| e.into_inner()).clone();
    todo(db, cache_root, &Scope::Kept).map(|t| t.iter().filter(|t| !gave_up.contains(&t.id)).count()).unwrap_or(0)
}

/// Settings key: the last measured download speed from Google Drive, bytes/s.
pub const SPEED_KEY: &str = "drive.bytesPerSec";

/// Blends one measured download into the remembered speed (for estimates).
pub fn record_speed(db: &Db, bytes: u64, secs: f64) {
    if secs < 1.0 || bytes < 5_000_000 {
        return;
    }
    let now = bytes as f64 / secs;
    let blended = match speed(db) {
        Some(old) => old * 0.6 + now * 0.4,
        None => now,
    };
    let _ = super::settings::set(db, SPEED_KEY, &format!("{blended:.0}"));
}

/// The remembered download speed from Google Drive, bytes/s.
pub fn speed(db: &Db) -> Option<f64> {
    super::settings::get(db, SPEED_KEY).ok().flatten().and_then(|v| v.trim_matches('"').parse::<f64>().ok()).filter(|v| *v > 0.0)
}

/// How far ahead (in culling order) a smaller video may go first while a big
/// one waits for space.
const LOOKAHEAD: usize = 25;
/// How often a paused run looks again at power and free space.
const PAUSE_CHECK: std::time::Duration = std::time::Duration::from_secs(30);
/// A culled video keeps its copy this long, for a quick look back.
const OFFLOAD_AFTER: std::time::Duration = std::time::Duration::from_secs(180);

#[cfg(target_os = "macos")]
fn run_locked(db: &Db, cache_root: &Path, helper: &Path, scope: &Scope, cancel: &AtomicBool, report: &mut impl FnMut(&Progress)) -> Result<Progress> {
    let mut p = Progress { total: todo(db, cache_root, scope)?.len(), ..Default::default() };
    report(&p);
    // Copies that failed twice aren't tried again this run.
    let mut failed: std::collections::HashSet<String> = std::collections::HashSet::new();
    // When each culled video was first seen culled.
    let mut culled_at: std::collections::HashMap<String, std::time::Instant> = std::collections::HashMap::new();
    loop {
        if cancel.load(Ordering::Relaxed) {
            p.note = "Stopped".into();
            break;
        }
        let now = std::time::Instant::now();
        if let Ok((removed, _)) = offload_culled(db, cache_root, |id| now.duration_since(*culled_at.entry(id.to_owned()).or_insert(now)) >= OFFLOAD_AFTER) {
            p.offloaded += removed;
        }
        // Picked fresh before every video: ones reviewed in the meantime drop
        // out, so the copies stay just ahead of culling.
        let list: Vec<Todo> = todo(db, cache_root, scope)?.into_iter().filter(|t| !failed.contains(&t.id)).collect();
        if list.is_empty() {
            break;
        }
        // Through the Google Drive app a file comes in as a download plus a
        // cache copy (twice its size); a direct download takes it once.
        // Always leave keep_free() (10 GB).
        let free = super::thumbs::free_bytes(cache_root);
        let factor = if super::gdrive::connected() { 1 } else { 2 };
        let floor = keep_free();
        let fits = |t: &Todo| !t.online || free >= t.size * factor + floor;
        p.skipped = list.iter().filter(|t| !fits(t)).count();
        // On battery only a clip asked for on screen is made; the rest waits
        // for mains power (downloading and encoding drain the battery).
        let mains = super::lane::power_ok();
        let asked_now = wanted();
        // A preview already made in Google's cloud is a few MB and no encoding:
        // taken before anything else (asked-for clips aside), even on battery.
        let has_cloud = |t: &Todo| {
            t.online && cloud_previews_folder(&t.path).zip(super::gdrive::file_id(&t.path)).is_some_and(|(f, id)| f.join(format!("{id}.mp4")).is_file())
        };
        let next = list
            .iter()
            .take(LOOKAHEAD)
            .find(|t| fits(t) && asked_now.contains(&t.id))
            .or_else(|| list.iter().find(|t| has_cloud(t)))
            .or_else(|| list.iter().take(LOOKAHEAD).find(|t| fits(t) && mains))
            .cloned();
        let Some(item) = next else {
            // Paused, never given up: it goes on by itself the moment the Mac
            // is plugged in and has room again (Andy, 12 Nov: a paused job sat
            // idle for an hour after he plugged in).
            p.current.clear();
            p.current_id.clear();
            p.note = if !mains {
                "Paused: battery under 30 %. Goes on by itself when the Mac is plugged in".into()
            } else {
                format!("Paused at {:.1} GB free: goes on by itself once {:.0} GB is free", free as f64 / 1e9, floor as f64 / 1e9)
            };
            report(&p);
            let until = std::time::Instant::now() + PAUSE_CHECK;
            while std::time::Instant::now() < until && !cancel.load(Ordering::Relaxed) && wanted() == asked_now {
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
            continue;
        };
        p.note.clear();
        // The cap: copies stop there. A clip asked for on screen makes room by
        // dropping the least recently played copies (never another asked-for one).
        let asked = wanted();
        let cap = cap_bytes(db);
        let fits_cap = if asked.contains(&item.id) { make_room(cache_root, cap, COPY_ESTIMATE, &asked) } else { space(cache_root).1 + COPY_ESTIMATE <= cap };
        if !fits_cap {
            p.note = format!("Previews reached their {:.0} GB limit (Settings › Previews of videos)", cap as f64 / 1e9);
            break;
        }
        p.note.clear();
        p.current = item.path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_owned();
        p.current_id = item.id.clone();
        p.current_size = item.size;
        report(&p);
        let dest = copy_path(cache_root, &item.id);
        // One download at a time, and none while an online clip is playing.
        let lane = super::lane::take();
        super::lane::yield_to_playback(|| cancel.load(Ordering::Relaxed));
        // This clip alone can be stopped: by Stop, or by a clip asked for on screen.
        ITEM_SKIP.store(false, Ordering::SeqCst);
        *CURRENT.lock().unwrap_or_else(|e| e.into_inner()) = Some((item.id.clone(), asked.contains(&item.id)));
        let item_cancel = AtomicBool::new(false);
        let watching = AtomicBool::new(true);
        // Connected to Google Drive: fetch the original straight from Google
        // (several pieces at once), else read it through the Drive app.
        let started = std::time::Instant::now();
        let (direct, out) = std::thread::scope(|s| {
            s.spawn(|| {
                while watching.load(Ordering::Relaxed) {
                    if cancel.load(Ordering::Relaxed) || ITEM_SKIP.load(Ordering::Relaxed) {
                        item_cancel.store(true, Ordering::SeqCst);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(250));
                }
            });
            let made = make_one(&item, &dest, helper, cache_root, &item_cancel);
            watching.store(false, Ordering::Relaxed);
            made
        });
        *CURRENT.lock().unwrap_or_else(|e| e.into_inner()) = None;
        let direct_secs = started.elapsed().as_secs_f64();
        // Only this Mac's download goes; the original stays online, untouched.
        if let Some(tmp) = &direct {
            let _ = std::fs::remove_file(tmp);
        } else if item.online {
            super::media::release_download(&item.path);
        }
        drop(lane);
        // Interrupted for a clip on screen (not stopped): it's made again later.
        if item_cancel.load(Ordering::Relaxed) && !cancel.load(Ordering::Relaxed) {
            let _ = std::fs::remove_file(&dest);
            crate::applog::line(&format!("previews: {} paused for a clip asked for on screen", p.current));
            continue;
        }
        if direct.is_some() && dest.is_file() {
            record_speed(db, item.size, direct_secs);
        }
        match out {
            Ok(o) if String::from_utf8_lossy(&o.stdout).lines().any(|l| l.trim() == "done") && dest.is_file() => {
                p.done += 1;
                p.bytes += dest.metadata().map(|m| m.len()).unwrap_or(0);
                p.last_ready = item.id.clone();
                done_wanting(&item.id);
                // Read through the Drive app: the whole preview's time is the speed
                // that counts for estimates (it's what Andy waits for).
                if item.online && direct.is_none() {
                    record_speed(db, item.size, started.elapsed().as_secs_f64().max(direct_secs));
                }
            }
            Ok(o) => {
                p.failed += 1;
                failed.insert(item.id.clone());
                GAVE_UP.lock().unwrap_or_else(|e| e.into_inner()).push(item.id.clone());
                done_wanting(&item.id);
                p.last_failed = item.id.clone();
                let said = String::from_utf8_lossy(&o.stdout).lines().last().unwrap_or("").to_owned();
                crate::applog::line(&format!("review copy failed for {}: {said}", item.path.display()));
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {
                p.note = "Stopped".into();
                break;
            }
            Err(e) => return Err(Error::Io(e)),
        }
        report(&p);
    }
    p.current.clear();
    p.current_id.clear();
    if !cancel.load(Ordering::Relaxed) && p.note.is_empty() {
        let left = todo(db, cache_root, scope)?.into_iter().filter(|t| !failed.contains(&t.id)).count();
        if left > 0 {
            p.note = format!("{left} video{} left online: not enough free space", if left == 1 { "" } else { "s" });
        }
    }
    report(&p);
    Ok(p)
}

/// The folder in Google Drive where previews made in Google's cloud land
/// (tools/cloud-previews), next to the clip's own Drive: `…/My Drive/STORAGE/CBA-PREVIEWS`.
pub fn cloud_folder(clip: &Path) -> Option<PathBuf> {
    let s = clip.to_string_lossy();
    let at = s.find("/My Drive/")?;
    Some(PathBuf::from(&s[..at + "/My Drive".len()]).join("STORAGE").join("CBA-PREVIEWS"))
}

/// Where the cloud job writes its 720p previews: `…/My Drive/STORAGE/CBA-PREVIEWS-720`.
/// Made by Colab itself (never by this Mac), so it exists in Drive even while
/// the Google Drive app on this Mac can't upload.
pub fn cloud_previews_folder(clip: &Path) -> Option<PathBuf> {
    cloud_folder(clip).map(|f| f.with_file_name("CBA-PREVIEWS-720"))
}

/// A preview made in Google's cloud for this clip, copied into the cache
/// (a few MB through the Google Drive app, instead of the whole original).
fn from_cloud(item: &Todo, dest: &Path, stop: &AtomicBool) -> bool {
    let Some(folder) = cloud_previews_folder(&item.path) else { return false };
    let Some(id) = super::gdrive::file_id(&item.path) else { return false };
    let cloud = folder.join(format!("{id}.mp4"));
    if stop.load(Ordering::Relaxed) {
        return false;
    }
    let tmp = dest.with_extension("cloud.part");
    if !cloud.is_file() {
        // Not synced to this Mac (yet): straight from Drive, a few MB.
        let Some((cid, size)) = super::gdrive::find_by_name(&format!("{id}.mp4")) else { return false };
        let ok = size > 10_000 && super::gdrive::download(&cid, size, &tmp, stop).is_ok() && std::fs::rename(&tmp, dest).is_ok();
        let _ = std::fs::remove_file(&tmp);
        if ok {
            crate::applog::line(&format!("previews: took the cloud preview of {} from Drive", item.path.display()));
        }
        return ok;
    }
    let ok = std::fs::copy(&cloud, &tmp).is_ok_and(|n| n > 10_000) && std::fs::rename(&tmp, dest).is_ok();
    let _ = std::fs::remove_file(&tmp);
    super::media::release_download(&cloud);
    ok
}

/// Writes the list of clips that want a preview into the cloud folder, for
/// the cloud job to read: Drive id, path inside My Drive, and S-Log3 or not.
/// Only rewritten when it changed. Returns how many clips it lists.
pub fn write_cloud_manifest(db: &Db) -> Result<usize> {
    let todo = todo_in(db, &Scope::Kept)?;
    let mut clips = Vec::new();
    let mut folder = None;
    for t in &todo {
        let s = t.path.to_string_lossy().into_owned();
        let (Some(at), Some(id)) = (s.find("/My Drive/"), super::gdrive::file_id(&t.path)) else { continue };
        folder.get_or_insert_with(|| cloud_folder(&t.path));
        clips.push(serde_json::json!({ "drive_id": id, "path": &s[at + "/My Drive/".len()..], "log": t.log }));
    }
    let Some(Some(folder)) = folder else { return Ok(0) };
    std::fs::create_dir_all(&folder)?;
    let body = serde_json::to_vec_pretty(&serde_json::json!({ "written_by": "Captured by Andy", "clips": clips })).map_err(|e| Error::Invalid(e.to_string()))?;
    let path = folder.join("manifest.json");
    if std::fs::read(&path).ok().as_deref() != Some(body.as_slice()) {
        std::fs::write(&path, &body)?;
    }
    Ok(clips.len())
}

/// Downloads (when connected) and turns one clip into its review copy.
/// Stops early when `stop` is set. Returns the temporary download (to remove)
/// and the helper's outcome.
#[cfg(target_os = "macos")]
fn make_one(item: &Todo, dest: &Path, helper: &Path, cache_root: &Path, stop: &AtomicBool) -> (Option<PathBuf>, std::io::Result<std::process::Output>) {
    // Made in Google's cloud already: a few MB instead of the original.
    if item.online && from_cloud(item, dest, stop) {
        use std::os::unix::process::ExitStatusExt;
        return (None, Ok(std::process::Output { status: std::process::ExitStatus::from_raw(0), stdout: b"done\n".to_vec(), stderr: Vec::new() }));
    }
    let direct = if item.online { super::gdrive::fetch_for_copy(&item.path, item.size, &dir(cache_root), stop) } else { None };
    if stop.load(Ordering::Relaxed) {
        return (direct, Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "stopped")));
    }
    let input = direct.clone().unwrap_or_else(|| item.path.clone());
    let make = || -> std::io::Result<std::process::Output> {
        let mut cmd = std::process::Command::new(helper);
        cmd.arg(&input).arg(dest).args(["--short", PREVIEW_SHORT, "--bitrate", PREVIEW_BITRATE]);
        if item.log {
            cmd.arg("--log");
        }
        let mut child = cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn()?;
        // Polled, so a read stuck on the Google Drive app can be stopped.
        loop {
            if child.try_wait()?.is_some() {
                return child.wait_with_output();
            }
            if stop.load(Ordering::Relaxed) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "stopped"));
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    };
    // Google Drive sometimes drops a read halfway: one more try.
    let ok = |o: &std::io::Result<std::process::Output>| o.as_ref().is_ok_and(|o| String::from_utf8_lossy(&o.stdout).lines().any(|l| l.trim() == "done"));
    let mut out = make();
    if !ok(&out) && !stop.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_secs(2));
        out = make();
    }
    (direct, out)
}

/// How many videos have a review copy, and the space they take.
pub fn space(cache_root: &Path) -> (usize, u64) {
    std::fs::read_dir(dir(cache_root))
        .map(|it| {
            it.flatten()
                .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("mp4"))
                .fold((0, 0), |(n, b), e| (n + 1, b + e.metadata().map(|m| m.len()).unwrap_or(0)))
        })
        .unwrap_or((0, 0))
}
