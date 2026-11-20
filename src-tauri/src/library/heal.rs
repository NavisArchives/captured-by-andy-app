//! Thumbnails whose file is gone from the cache (the database still says
//! ready, so the grid shows only the blurred placeholder) are made again,
//! newest request first: what is on screen now. Nothing about the photo
//! changes but the file: its marks, date and analysis stay. Sources, in order
//! of cost: the clip's review copy, the sharp preview in the cache, the
//! original when it is on this Mac, Google Drive's own thumbnail (a few KB),
//! and for a clip a frame read from the online original (a few MB). An
//! online-only photo's original is never downloaded for a tile.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex, Once};

use super::db::Db;
use super::thumbs::{Cache, THUMB_PX};
use super::{gdrive, media, review};

const QUALITY: f64 = 0.72;
const WORKERS: usize = 4;
/// Longest a frame read through the Google Drive app may take.
const FRAME_LIMIT: std::time::Duration = std::time::Duration::from_secs(20);

/// Which way each tile was made (or not), summed up in the app's log.
static TALLY: Mutex<[usize; 8]> = Mutex::new([0; 8]);
const HOW: [&str; 8] = ["review copy", "sharp preview", "local original", "Drive thumbnail", "clip frame", "nothing", "not needed", "RAW's own preview"];

fn tally(how: Option<usize>) {
    let mut t = TALLY.lock().unwrap_or_else(|e| e.into_inner());
    t[how.unwrap_or(5)] += 1;
    let total: usize = t.iter().sum();
    if total % 25 == 0 {
        let parts: Vec<String> = HOW.iter().zip(t.iter()).filter(|(_, n)| **n > 0).map(|(h, n)| format!("{h} {n}")).collect();
        crate::applog::line(&format!("thumb-heal: {total} tiles · {}", parts.join(" · ")));
    }
}
/// Requests kept waiting; older ones drop off (they're asked again when seen).
const MAX_WAITING: usize = 30_000;

static QUEUE: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
static WAKE: Condvar = Condvar::new();
static STARTED: Once = Once::new();

/// A tile asked for a thumbnail that isn't there: make it soon.
pub fn ask(id: &str) {
    let mut q = QUEUE.lock().unwrap_or_else(|e| e.into_inner());
    if q.front().is_some_and(|f| f == id) {
        return;
    }
    q.retain(|x| x != id);
    q.push_front(id.to_owned());
    q.truncate(MAX_WAITING);
    WAKE.notify_one();
}

/// Queued behind anything asked for on screen.
fn ask_later(ids: Vec<String>) {
    let mut q = QUEUE.lock().unwrap_or_else(|e| e.into_inner());
    for id in ids {
        if q.len() >= MAX_WAITING {
            break;
        }
        if !q.contains(&id) {
            q.push_back(id);
        }
    }
    WAKE.notify_one();
}

/// Starts the one worker (once), and queues every clip whose tile is missing.
/// `healed` is told each id whose thumbnail is back.
pub fn start(db: Arc<Db>, cache: Arc<Cache>, healed: impl Fn(&str) + Send + Sync + 'static) {
    STARTED.call_once(|| {
        // Clips first, then every photo, newest first: by morning no tile is blurred.
        let clips: Vec<String> = db
            .read(|c| {
                let mut stmt = c.prepare("SELECT id FROM photos WHERE thumb_state = 'ready' ORDER BY is_video DESC, captured_at DESC")?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .unwrap_or_default();
        ask_later(clips.into_iter().filter(|id| !cache.thumb(id).is_file()).collect());
        // Several at once: each mostly waits on the network (a Drive thumbnail
        // is one small request), and one slow clip mustn't hold up the rest.
        let healed = Arc::new(healed);
        for n in 0..WORKERS {
            let (db, cache, healed) = (db.clone(), cache.clone(), healed.clone());
            let _ = std::thread::Builder::new().name(format!("thumb-heal-{n}")).spawn(move || loop {
                let id = {
                    let mut q = QUEUE.lock().unwrap_or_else(|e| e.into_inner());
                    loop {
                        if let Some(id) = q.pop_front() {
                            break id;
                        }
                        q = WAKE.wait(q).unwrap_or_else(|e| e.into_inner());
                    }
                };
                if cache.thumb(&id).is_file() {
                    continue;
                }
                let how = heal_how(&db, &cache, &id);
                tally(how);
                if how.is_some() {
                    healed(&id);
                }
            });
        }
    });
}

struct Row {
    path: String,
    online: bool,
    is_video: bool,
    is_raw: bool,
}

fn row(db: &Db, id: &str) -> Option<Row> {
    db.read(|c| {
        Ok(c.query_row(
            "SELECT a.path, a.storage_state, p.is_video, a.is_raw FROM photos p
             JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
             WHERE p.id = ?1 AND p.thumb_state = 'ready' AND a.storage_state <> 'missing'",
            [id],
            |r| Ok(Row { path: r.get(0)?, online: r.get::<_, String>(1)? == "cloud_only", is_video: r.get(2)?, is_raw: r.get(3)? }),
        )?)
    })
    .ok()
}

/// Makes one missing thumbnail. Returns whether it is there now.
pub fn heal_one(db: &Db, cache: &Cache, id: &str) -> bool {
    heal_how(db, cache, id).is_some()
}

/// Makes one missing thumbnail; says which way (an index into `HOW`).
fn heal_how(db: &Db, cache: &Cache, id: &str) -> Option<usize> {
    let dest = cache.thumb(id);
    let r = row(db, id)?;
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let from_image = |src: &Path, is_raw: bool| media::thumbnail(src, THUMB_PX, is_raw).and_then(|img| media::write_jpeg(&img, &dest, QUALITY)).is_ok();
    if r.is_video {
        if let Some(copy) = review::existing(cache.root(), id) {
            if media::video_frame_within(&copy, &dest, THUMB_PX, Some(FRAME_LIMIT)).is_ok() {
                return Some(0);
            }
        }
    }
    let preview = cache.preview(id);
    if preview.is_file() && from_image(&preview, false) {
        return Some(1);
    }
    let path = Path::new(&r.path);
    if !r.online {
        // Limited too: "on this Mac" can be stale (the Drive app freed it since),
        // and a read of a freed clip can hang for good (13 Nov: three for 17 min).
        let ok = if r.is_video { media::video_frame_within(path, &dest, THUMB_PX, Some(FRAME_LIMIT)).is_ok() } else { from_image(path, r.is_raw) };
        return ok.then_some(2);
    }
    if let Some(drive_id) = gdrive::connected().then(|| gdrive::file_id(path)).flatten() {
        let tmp = dest.with_extension("drive.jpg");
        let ok = gdrive::thumbnail(&drive_id, THUMB_PX, &tmp) && from_image(&tmp, false);
        let _ = std::fs::remove_file(&tmp);
        if ok {
            return Some(3);
        }
        // A RAW Drive has no thumbnail for: the camera's own JPEG inside it,
        // read with two or three small ranged requests.
        if r.is_raw {
            if let Some(jpeg) = gdrive::raw_embedded_jpeg(|start, len| gdrive::range(&drive_id, start, len)) {
                let ok = std::fs::write(&tmp, &jpeg).is_ok() && from_image(&tmp, false);
                let _ = std::fs::remove_file(&tmp);
                if ok {
                    return Some(7);
                }
            }
        }
    }
    // A clip: one frame needs only a few MB of it, read through the Drive app,
    // given up after FRAME_LIMIT so the queue keeps moving.
    (r.is_video && media::video_frame_within(path, &dest, THUMB_PX, Some(FRAME_LIMIT)).is_ok()).then_some(4)
}
