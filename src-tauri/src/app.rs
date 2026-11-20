//! The thin layer between the web view and the library: Tauri commands, the
//! `cba://` image protocol, and background jobs (scanning, thumbnails, looks,
//! Finder tags, offline copies).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, UriSchemeContext, UriSchemeResponder};

use crate::library::model::ReviewState;
use crate::library::{
    accounts, albums, archive, auto, backup, cloud_sync, dashboard, db::Db, finder, labels, looks, media, moments, offline, photos, posts, review, scan, settings,
    sources, storage, tags, thumbs, trips, Error,
};

/// Sharp previews of the whole library (~0.7 MB each) plus full-size views;
/// the least recently viewed go first beyond this.
const PREVIEW_CACHE_BYTES: u64 = 6_000_000_000;

/// The space sharp previews may use: Settings › Previews (in GB), 6 GB unless changed.
fn preview_budget(db: &Db) -> u64 {
    settings::get(db, "previews.maxGB")
        .ok()
        .flatten()
        .and_then(|v| v.trim_matches('"').parse::<f64>().ok())
        .filter(|gb| *gb >= 1.0 && *gb <= 200.0)
        .map(|gb| (gb * 1e9) as u64)
        .unwrap_or(PREVIEW_CACHE_BYTES)
}
/// Long edge of the image the editor renders exports from.
const EXPORT_SOURCE_PX: u32 = 2560;

pub struct AppState {
    pub(crate) db: Arc<Db>,
    pub(crate) cache: Arc<thumbs::Cache>,
    pub looks_dir: PathBuf,
    thumbs: thumbs::ThumbService,
    status: Mutex<ScanStatus>,
    scanning: AtomicBool,
    /// A scan was asked for while one ran: run once more when it ends.
    rescan_requested: AtomicBool,
    /// Previews for online-only photos are being fetched.
    filling: AtomicBool,
    cancel: Arc<AtomicBool>,
    looks_busy: AtomicBool,
    /// Serialises Finder-tag and offline-copy work so rapid culling never races.
    side_effects: Mutex<()>,
    /// The backup put in place at this launch, told to the page once.
    restored: Mutex<Option<String>>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatus {
    running: bool,
    source: Option<String>,
    stats: scan::ScanStats,
    error: Option<String>,
    thumbs_queued: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    db_path: String,
    cache_dir: String,
    looks_dir: String,
    exports_dir: String,
}

type Reply<T> = Result<T, String>;

/// What went wrong in plain words, with what to do about it. Every error is
/// also written to the app log.
pub(crate) fn text(e: Error) -> String {
    crate::applog::line(&format!("error: {e}"));
    friendly(&e)
}

const DISK_FULL: &str = "This Mac's disk is full. Free some space, then try again.";
const DAMAGED: &str = "The library file is damaged. Restore a backup in Settings › Backups.";

pub fn friendly(e: &Error) -> String {
    use rusqlite::ErrorCode;
    match e {
        Error::Io(io) => match (io.kind(), io.raw_os_error()) {
            (_, Some(28)) => DISK_FULL.into(),
            (std::io::ErrorKind::PermissionDenied, _) => "macOS didn't allow access to that file or folder. Allow Captured by Andy in System Settings › Privacy & Security › Files and Folders.".into(),
            (std::io::ErrorKind::NotFound, _) => "That file isn't there anymore: it was moved or deleted, or its drive isn't connected.".into(),
            _ => format!("A file couldn't be read or written ({io})."),
        },
        Error::Db(rusqlite::Error::SqliteFailure(f, _)) => match f.code {
            ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => "The library is busy with another task. Try again in a moment.".into(),
            ErrorCode::DiskFull => DISK_FULL.into(),
            ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase => DAMAGED.into(),
            ErrorCode::ReadOnly | ErrorCode::PermissionDenied => "macOS didn't allow the library file to be changed. Check the permissions of the app's data folder.".into(),
            _ => format!("The library couldn't do that ({e})."),
        },
        Error::Db(_) => format!("The library couldn't do that ({e})."),
        Error::Migration(_) => "The library couldn't be updated for this version of the app. A copy of it as it was is in Settings › Backups.".into(),
        Error::SourceOffline(path) => format!("This folder isn't connected right now: {path}. Plug in the drive or start Google Drive, then scan again."),
        Error::Media(m) => format!("Couldn't read the photo: {m}."),
        Error::Invalid(s) => s.clone(),
    }
}

/// The library couldn't open at launch. The page then shows only this, with
/// the backups that can be restored.
pub struct StartupFailure {
    message: String,
    data_dir: PathBuf,
}

/// Records a failed launch so the page can offer a way out.
pub fn startup_failed(app: &mut tauri::App, e: &(dyn std::error::Error + 'static)) {
    let message = e.downcast_ref::<Error>().map(friendly).unwrap_or_else(|| e.to_string());
    crate::applog::line(&format!("launch failed: {e}"));
    let data_dir = data_dir(app).unwrap_or_default();
    app.manage(StartupFailure { message, data_dir });
}

fn data_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    // CBA_DATA_DIR points a development run at a throwaway library, so testing
    // never touches the real database or cache.
    Ok(match std::env::var_os("CBA_DATA_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => app.path().app_data_dir()?,
    })
}

#[tauri::command]
pub async fn startup_problem<R: Runtime>(app: AppHandle<R>) -> Reply<Option<String>> {
    Ok(app.try_state::<StartupFailure>().map(|f| f.message.clone()))
}

#[tauri::command]
pub async fn safe_backups<R: Runtime>(app: AppHandle<R>) -> Reply<Vec<backup::BackupInfo>> {
    let failure = app.try_state::<StartupFailure>().ok_or("The library opened normally.")?;
    Ok(backup::list(&failure.data_dir.join("library.db")))
}

/// From the launch-problem screen: keeps the current library file as it is
/// (as a backup) and restarts with the chosen backup.
#[tauri::command]
pub async fn safe_restore<R: Runtime>(app: AppHandle<R>, name: String) -> Reply<()> {
    let failure = app.try_state::<StartupFailure>().ok_or("The library opened normally.")?;
    backup::stage_restore_raw(&failure.data_dir.join("library.db"), &name).map_err(text)?;
    app.restart();
}

#[tauri::command]
pub async fn safe_reveal<R: Runtime>(app: AppHandle<R>) -> Reply<()> {
    let failure = app.try_state::<StartupFailure>().ok_or("The library opened normally.")?;
    std::process::Command::new("/usr/bin/open").arg("-R").arg(failure.data_dir.join("library.db")).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// A screen of the page ran into a problem: noted in the log.
#[tauri::command]
pub async fn log_page_error(message: String) -> Reply<()> {
    crate::applog::line(&format!("page error: {}", message.chars().take(1500).collect::<String>()));
    Ok(())
}

/// Runs blocking library work off the async runtime.
pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> crate::library::Result<T> + Send + 'static) -> Reply<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?.map_err(text)
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let dir = data_dir(app)?;
    std::fs::create_dir_all(&dir)?;
    // The bundled video frame helper; a development run uses the one in the source tree.
    if let Ok(helper) = app.path().resolve("helpers/videoframe", tauri::path::BaseDirectory::Resource) {
        if helper.is_file() {
            crate::library::media::set_video_helper(helper);
        }
    }
    if let Ok(helper) = app.path().resolve("helpers/places", tauri::path::BaseDirectory::Resource) {
        if helper.is_file() {
            crate::places_cmd::set_helper(helper);
        }
    }
    if let Ok(helper) = app.path().resolve("helpers/bin", tauri::path::BaseDirectory::Resource) {
        if helper.is_file() {
            crate::cleanup_cmd::set_helper(helper);
        }
    }
    if let Ok(helper) = app.path().resolve("helpers/webshot", tauri::path::BaseDirectory::Resource) {
        if helper.is_file() {
            crate::library::studio::set_webshot_helper(helper);
        }
    }
    // A restore picked in Settings happens now, before the library is opened.
    // If it can't, the library stays exactly as it was.
    let restored = backup::apply_pending(&dir.join("library.db")).unwrap_or(None);
    let db = Arc::new(Db::open(&dir.join("library.db"))?);
    // A damaged library is caught here, with a way out, instead of failing later.
    let check: String = db.read(|c| Ok(c.query_row("PRAGMA quick_check", [], |r| r.get(0))?))?;
    if check != "ok" {
        return Err(Box::new(Error::Invalid(format!("The library file is damaged ({check}). Restore a backup to continue."))));
    }
    if let Some(name) = &restored {
        crate::applog::line(&format!("restored backup {name}"));
    }
    // Recently deleted keeps items 30 days; older ones go now (each is logged).
    if let Ok(n) = crate::library::trash::purge_expired(&db) {
        if n > 0 {
            crate::applog::line(&format!("Recently deleted: {n} items older than 30 days removed"));
        }
    }
    let cache = Arc::new(thumbs::Cache::new(dir.join("cache"))?);
    let looks_dir = dir.join("looks");
    std::fs::create_dir_all(&looks_dir)?;

    // Tell the UI thumbnails landed: at most four times a second, and always
    // once the queue runs dry so the last tiles are never left blurred.
    let handle = app.handle().clone();
    let last = Mutex::new(Instant::now() - Duration::from_secs(1));
    let on_done = Arc::new(move |remaining: usize| {
        let mut last = last.lock().unwrap_or_else(|e| e.into_inner());
        if remaining == 0 || last.elapsed() >= Duration::from_millis(250) {
            *last = Instant::now();
            let _ = handle.emit("thumbs-progress", remaining);
        }
    });
    let workers = std::thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(2).max(1);
    let service = thumbs::ThumbService::start(db.clone(), cache.clone(), workers, on_done);
    service.enqueue_pending(&db)?; // pick up where the last session stopped
    // Thumbnails whose file is gone are made again, what's on screen first.
    let handle = app.handle().clone();
    crate::library::heal::start(db.clone(), cache.clone(), move |id| {
        let _ = handle.emit("thumb-healed", id);
    });

    app.manage(AppState {
        db: db.clone(),
        cache: cache.clone(),
        looks_dir: looks_dir.clone(),
        thumbs: service,
        status: Mutex::new(ScanStatus::default()),
        scanning: AtomicBool::new(false),
        rescan_requested: AtomicBool::new(false),
        filling: AtomicBool::new(false),
        cancel: Arc::new(AtomicBool::new(false)),
        looks_busy: AtomicBool::new(false),
        side_effects: Mutex::new(()),
        restored: Mutex::new(restored),
    });

    // Previews of clips are made in the background without a button: a minute
    // after launch, and looked at again every two minutes, so a run that ended
    // (a single clip asked for on screen, new clips imported, room again under
    // the cap) is picked up without anyone pressing anything. They pause on
    // low battery or disk by themselves. Settings › Previews has Stop.
    let handle = app.handle().clone();
    std::thread::Builder::new().name("previews-keeper".into()).spawn(move || {
        std::thread::sleep(Duration::from_secs(60));
        let mut round: u32 = 0;
        loop {
            let state = handle.state::<AppState>();
            // The list the cloud job (tools/cloud-previews) reads, kept current.
            if round % 15 == 0 {
                match review::write_cloud_manifest(&state.db) {
                    Ok(n) => crate::applog::line(&format!("previews: cloud list has {n} clips")),
                    Err(e) => crate::applog::line(&format!("previews: couldn't write the cloud list: {e}")),
                }
            }
            round = round.wrapping_add(1);
            keep_previews_going(&handle);
            std::thread::sleep(Duration::from_secs(120));
        }
    }).ok();

    // Housekeeping that never blocks the window from opening.
    let handle = app.handle().clone();
    std::thread::Builder::new().name("startup".into()).spawn(move || {
        let state = handle.state::<AppState>();
        // Today's copy of the library (marks, albums, edits, posts), kept for a week.
        let _ = backup::daily(&state.db);
        let _ = thumbs::prune_previews(&state.cache, preview_budget(&state.db));
        let _ = offline::verify(&state.db);
        let never = AtomicBool::new(false);
        if thumbs::analyse_backlog(&state.db, &state.cache, &never).is_ok() {
            let _ = handle.emit("library-changed", "analysis");
        }
        {
            let _guard = state.side_effects.lock().unwrap_or_else(|e| e.into_inner());
            if finder::enabled(&state.db).unwrap_or(false) {
                let _ = finder::sync_all(&state.db);
            }
        }
        // First run: find Andy's presets and LUTs.
        let empty = state.db.read(|c| Ok(c.query_row("SELECT COUNT(*) = 0 FROM looks", [], |r| r.get::<_, bool>(0))?)).unwrap_or(false);
        if empty {
            run_looks_import(&handle);
        } else {
            bake_looks(&handle);
        }
        start_fill_online(&handle);
    })?;
    // The online library (the phone) follows the Mac by itself while the app is open.
    start_cloud_sync(app.handle().clone());
    // The library is up to date on launch: unchanged and iCloud-only files are
    // only looked at, never read.
    start_scan(app.handle())?;
    // And stays up to date while the app is open (a card copied in, files
    // arriving in Google Drive): the same cheap look every five minutes, so new
    // arrivals are read while they are still on this Mac.
    let handle = app.handle().clone();
    std::thread::Builder::new().name("rescan".into()).spawn(move || loop {
        std::thread::sleep(Duration::from_secs(5 * 60));
        let _ = start_scan(&handle);
        let state = handle.state::<AppState>();
        // Open past midnight: the new day gets its copy too.
        let _ = backup::daily(&state.db);
        // Previews and full-size views opened this session stay within their space too.
        let _ = thumbs::prune_previews(&state.cache, preview_budget(&state.db));
    })?;
    Ok(())
}

// ---------------------------------------------------------------- online sync

/// Where the online library stands, for the header ("synced 2 min ago").
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// This Mac has a Supabase login (~/.config/captured-by-andy/supabase.json).
    configured: bool,
    running: bool,
    /// The end of the last round that went through.
    last_ok_ms: Option<i64>,
    /// Why the last round didn't, in words.
    error: Option<String>,
    last: Option<cloud_sync::Report>,
}

static SYNC: Mutex<Option<SyncStatus>> = Mutex::new(None);
/// "Sync now" from the header, or a change worth sending right away.
static SYNC_NOW: AtomicBool = AtomicBool::new(false);

fn sync_status_now() -> SyncStatus {
    SYNC.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_default()
}

fn set_sync(app: &AppHandle, f: impl FnOnce(&mut SyncStatus)) {
    let status = {
        let mut guard = SYNC.lock().unwrap_or_else(|e| e.into_inner());
        let s = guard.get_or_insert_with(SyncStatus::default);
        f(s);
        s.clone()
    };
    let _ = app.emit("sync-status", status);
}

/// Rounds run a few seconds after the library changes (debounced), every two
/// minutes regardless (to bring in what was done on the phone), and at once on
/// "Sync now". A failed round is tried again sooner than that, then less often.
fn start_cloud_sync(app: AppHandle) {
    let Some(login) = cloud_sync::login() else {
        set_sync(&app, |s| s.configured = false);
        crate::applog::line("sync: no Supabase login on this Mac, online library not kept in step");
        return;
    };
    let last = cloud_sync::last_pushed(&cloud_sync::state_dir());
    set_sync(&app, |s| {
        s.configured = true;
        s.last_ok_ms = last;
    });
    let _ = std::thread::Builder::new().name("cloud-sync".into()).spawn(move || {
        let remote = cloud_sync::Supabase::new(&login);
        let wal = {
            let state = app.state::<AppState>();
            let mut p = state.db.path().as_os_str().to_owned();
            p.push("-wal");
            PathBuf::from(p)
        };
        let stamp = |p: &Path| std::fs::metadata(p).ok().map(|m| (m.modified().ok(), m.len()));
        let mut shape = None;
        let mut last_round: Option<Instant> = None;
        let mut seen = stamp(&wal);
        let mut changed_at: Option<Instant> = None;
        let mut fails: u32 = 0;
        let mut rounds: u64 = 0;
        std::thread::sleep(Duration::from_secs(8));
        loop {
            let now_stamp = stamp(&wal);
            if now_stamp != seen {
                seen = now_stamp;
                changed_at = Some(Instant::now());
            }
            let since_round = last_round.map(|t| t.elapsed()).unwrap_or(Duration::MAX);
            let wait = if fails > 0 { Duration::from_secs((15u64 << fails.min(5)).min(600)) } else { Duration::from_secs(120) };
            // A change, once things went quiet for a few seconds (culling is many quick marks).
            let settled = changed_at.is_some_and(|t| t.elapsed() >= Duration::from_secs(4)) && since_round >= Duration::from_secs(30);
            let asked = SYNC_NOW.swap(false, Ordering::SeqCst);
            if asked || since_round >= wait || (fails == 0 && settled) {
                changed_at = None;
                set_sync(&app, |s| s.running = true);
                let state = app.state::<AppState>();
                let last_scan: Option<i64> = state
                    .db
                    .read(|c| Ok(c.query_row("SELECT MAX(last_scan_finished_ms) FROM sources", [], |r| r.get(0))?))
                    .unwrap_or(None);
                // Video web copies are looked for every 15 minutes or so: it walks every clip.
                let videos = rounds % 8 == 0;
                match cloud_sync::round(&remote, &state.db, &cloud_sync::state_dir(), &mut shape, last_scan, videos) {
                    Ok(report) => {
                        fails = 0;
                        if report.pulled > 0 {
                            let _ = app.emit("library-changed", "sync");
                        }
                        if report.pulled + report.sent + report.videos > 0 {
                            crate::applog::line(&format!("sync: {} from the web, {} sent, {} web videos", report.pulled, report.sent, report.videos));
                        }
                        set_sync(&app, |s| {
                            s.running = false;
                            s.error = None;
                            s.last_ok_ms = Some(crate::library::now_ms());
                            s.last = Some(report);
                        });
                    }
                    Err(e) => {
                        fails += 1;
                        crate::applog::line(&format!("sync: round failed ({fails} in a row): {e}"));
                        set_sync(&app, |s| {
                            s.running = false;
                            s.error = Some(e.to_string());
                        });
                    }
                }
                rounds += 1;
                last_round = Some(Instant::now());
                // Our own writes (pulled marks) are not a change to send back.
                seen = stamp(&wal);
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

#[tauri::command]
pub async fn sync_status() -> Reply<SyncStatus> {
    Ok(sync_status_now())
}

/// The header's "Sync now".
#[tauri::command]
pub async fn sync_now() -> Reply<()> {
    SYNC_NOW.store(true, Ordering::SeqCst);
    Ok(())
}

impl AppState {
    fn status(&self) -> ScanStatus {
        let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner()).clone();
        status.thumbs_queued = self.thumbs.queued();
        status
    }

    fn update(&self, app: &AppHandle, f: impl FnOnce(&mut ScanStatus)) {
        f(&mut self.status.lock().unwrap_or_else(|e| e.into_inner()));
        let _ = app.emit("scan-progress", self.status());
    }
}

// ------------------------------------------------------------------ library & sources

#[tauri::command]
pub async fn library_info(state: State<'_, AppState>) -> Reply<LibraryInfo> {
    Ok(LibraryInfo {
        db_path: state.db.path().display().to_string(),
        cache_dir: state.cache.root().display().to_string(),
        looks_dir: state.looks_dir.display().to_string(),
        exports_dir: exports_dir(&state.db).map_err(text)?.display().to_string(),
    })
}

#[tauri::command]
pub async fn list_sources(state: State<'_, AppState>) -> Reply<Vec<sources::Source>> {
    sources::list(&state.db).map_err(text)
}

/// Registers a folder, or points at the source that already covers it.
#[tauri::command]
pub async fn add_source(state: State<'_, AppState>, path: String) -> Reply<sources::AddedSource> {
    sources::add_folder(&state.db, Path::new(&path)).map_err(text)
}

#[tauri::command]
pub async fn set_source_enabled(state: State<'_, AppState>, id: String, enabled: bool) -> Reply<()> {
    sources::set_enabled(&state.db, &id, enabled).map_err(text)
}

/// Forgets a folder. First takes off the Finder tags the app added there and
/// removes its offline copies, while the records of both still exist.
#[tauri::command]
pub async fn remove_source(app: AppHandle, id: String) -> Reply<usize> {
    blocking(move || {
        let state = app.state::<AppState>();
        let _guard = state.side_effects.lock().unwrap_or_else(|e| e.into_inner());
        finder::remove_added(&state.db, Some(&id))?;
        offline::release_source(&state.db, &id)?;
        sources::remove(&state.db, &id)
    })
    .await
}

/// Scans every enabled, reachable source on a background thread; progress
/// arrives as `scan-progress` events, one total across sources.
#[tauri::command]
pub async fn scan_all(app: AppHandle) -> Reply<()> {
    start_scan(&app)
}

/// Starts a scan, or, when one is running, asks for another round right
/// after it: a folder added mid-scan is never left out.
fn start_scan(app: &AppHandle) -> Reply<()> {
    let state = app.state::<AppState>();
    if state.scanning.swap(true, Ordering::SeqCst) {
        state.rescan_requested.store(true, Ordering::SeqCst);
        return Ok(());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let app = app.clone();
    std::thread::Builder::new()
        .name("scanner".into())
        .spawn(move || {
            let state = app.state::<AppState>();
            let started = crate::library::now_ms();
            let mut total = scan::ScanStats::default();
            let mut error = None;
            state.update(&app, |s| *s = ScanStatus { running: true, ..ScanStatus::default() });
            loop {
                state.rescan_requested.store(false, Ordering::SeqCst);
                // The source list is read fresh each round, so a new folder is in it.
                match sources::list(&state.db) {
                    Ok(all) => {
                        for source in all.into_iter().filter(|s| s.enabled && s.online) {
                            state.update(&app, |s| s.source = Some(source.label.clone()));
                            let before = total.clone();
                            let outcome = scan::scan_source(&state.db, &source.id, &media::read_metadata, &state.cancel, |stats| {
                                state.update(&app, |s| s.stats = before.plus(stats));
                            });
                            match outcome {
                                Ok(stats) => total = before.plus(&stats),
                                Err(e) => error = Some(e.to_string()),
                            }
                            state.update(&app, |s| s.stats = total.clone());
                            let _ = state.thumbs.enqueue_pending(&state.db);
                        }
                    }
                    Err(e) => error = Some(e.to_string()),
                }
                if !state.rescan_requested.load(Ordering::SeqCst) || state.cancel.load(Ordering::SeqCst) {
                    break;
                }
            }
            let _ = auto::regroup_bursts(&state.db);
            // What this scan added becomes "Last import".
            let _ = photos::note_import(&state.db, started, total.added);
            state.scanning.store(false, Ordering::SeqCst);
            state.update(&app, |s| {
                s.running = false;
                s.stats = total.clone();
                s.error = error.clone();
            });
            let _ = app.emit("scan-done", state.status());
            // Photos that only live online (iCloud, Google Drive) get their previews.
            start_fill_online(&app);
            // A request that slipped in between the last check and the line
            // above starts a new scan.
            if state.rescan_requested.swap(false, Ordering::SeqCst) && !state.cancel.load(Ordering::SeqCst) {
                let _ = start_scan(&app);
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Fetches previews for online-only photos in the background, one photo at a
/// time (fetched, read, released), telling the screens as they arrive. Runs
/// once at a time; a later call while it runs is a no-op, and a scan that finds
/// more starts it again when it ends.
fn start_fill_online(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.filling.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("online-previews".into()).spawn(move || {
        let state = app.state::<AppState>();
        let never = AtomicBool::new(false);
        let done = thumbs::fill_online(&state.db, &state.cache, &never, |n| {
            if n % 20 == 0 {
                let _ = app.emit("library-changed", "online-previews");
            }
        });
        if matches!(done, Ok(n) if n > 0) {
            let _ = auto::regroup_bursts(&state.db);
            let _ = app.emit("library-changed", "online-previews");
        }
        // What's in each photo, for searching by content (on this Mac, from tiles and previews).
        let helper = vision_helper(&app);
        let found = labels::run_backlog(&state.db, &state.cache, &helper, &never, |done, total| {
            if done == 0 || done == total || done % 200 == 0 {
                let _ = app.emit("labels-progress", serde_json::json!({ "done": done, "total": total }));
            }
        });
        if matches!(found, Ok(n) if n > 0) {
            let _ = app.emit("library-changed", "labels");
        }
        // Apple's quality reading (documents and screens, for Clean up), from tiles.
        if matches!(auto::run_quality_backlog(&state.db, &state.cache, &helper, &never), Ok(n) if n > 0) {
            let _ = app.emit("library-changed", "quality");
        }
        // Videos: the camera's clock, camera and picture profile (a few MB from each clip's end).
        if matches!(thumbs::refresh_video_meta(&state.db, &never), Ok(n) if n > 0) {
            let _ = app.emit("library-changed", "video-meta");
        }
        // Selected photos in full size on this Mac, for inspecting them.
        {
            let _guard = state.side_effects.lock().unwrap_or_else(|e| e.into_inner());
            if matches!(offline::keep_selected(&state.db), Ok(r) if r.copied > 0) {
                let _ = app.emit("library-changed", "offline");
            }
        }
        // Then the sharp previews, so flipping through photos never waits.
        let _ = thumbs::prefetch_previews(&state.db, &state.cache, &never, preview_budget(&state.db), |done, total| {
            if done == 0 || done == total || done % 25 == 0 {
                let _ = app.emit("previews-progress", serde_json::json!({ "done": done, "total": total }));
            }
        });
        state.filling.store(false, Ordering::SeqCst);
    });
    if spawned.is_err() {
        state.filling.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn cancel_scan(state: State<'_, AppState>) -> Reply<()> {
    state.cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn scan_status(state: State<'_, AppState>) -> Reply<ScanStatus> {
    Ok(state.status())
}

/// Re-measures bursts after new thumbnails (the grid calls this when the
/// thumbnail queue runs dry).
#[tauri::command]
pub async fn refresh_analysis(app: AppHandle) -> Reply<usize> {
    blocking(move || {
        let state = app.state::<AppState>();
        let never = AtomicBool::new(false);
        thumbs::analyse_backlog(&state.db, &state.cache, &never)
    })
    .await
}

// ------------------------------------------------------------------ photos

#[tauri::command]
pub async fn photo_counts(state: State<'_, AppState>, query: Option<photos::Query>) -> Reply<photos::Counts> {
    photos::counts(&state.db, &query.unwrap_or_default()).map_err(text)
}

/// The photos with an edit of their own, the most recently edited first.
#[tauri::command]
pub async fn edited_ids(state: State<'_, AppState>) -> Reply<Vec<String>> {
    state
        .db
        .read(|c| {
            let mut stmt = c.prepare("SELECT photo_id FROM photo_looks ORDER BY updated_ms DESC")?;
            let ids = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(ids)
        })
        .map_err(text)
}

/// Trip folders for the Pictures sidebar.
#[tauri::command]
pub async fn photo_folders(state: State<'_, AppState>) -> Reply<Vec<photos::Folder>> {
    photos::folders(&state.db).map_err(text)
}

/// Moves photos to another trip: their files go into that trip's folder.
#[tauri::command]
pub async fn move_to_trip(app: AppHandle, photo_ids: Vec<String>, trip: String) -> Reply<trips::MoveReport> {
    blocking(move || trips::move_to_trip(&app.state::<AppState>().db, &photo_ids, &trip)).await
}

/// The latest warm-up asked for: its number and photos. A newer one replaces it.
static WARM: Mutex<(u64, Vec<String>)> = Mutex::new((0, Vec::new()));

/// Makes the sharp previews of these photos ahead of time (online originals are
/// fetched for a moment and released), four at a time, in the order given: the
/// photos coming next while you browse. A newer call takes over from this one.
#[tauri::command]
pub async fn warm_previews(state: State<'_, AppState>, photo_ids: Vec<String>) -> Reply<()> {
    let generation = {
        let mut w = WARM.lock().unwrap_or_else(|e| e.into_inner());
        w.0 += 1;
        w.1 = photo_ids;
        w.0
    };
    let (db, cache) = (state.db.clone(), state.cache.clone());
    std::thread::Builder::new()
        .name("warm-previews".into())
        .spawn(move || {
            let list = WARM.lock().unwrap_or_else(|e| e.into_inner()).1.clone();
            let next = std::sync::atomic::AtomicUsize::new(0);
            let current = || WARM.lock().unwrap_or_else(|e| e.into_inner()).0 == generation;
            std::thread::scope(|scope| {
                for _ in 0..4 {
                    scope.spawn(|| loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        if i >= list.len() || !current() {
                            break;
                        }
                        if !cache.preview(&list[i]).exists() {
                            let _ = thumbs::preview(&db, &cache, &list[i]);
                        }
                    });
                }
            });
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Renames photos "<name> 01", "<name> 02"… in shooting order.
#[tauri::command]
pub async fn rename_photos(app: AppHandle, photo_ids: Vec<String>, name: String) -> Reply<trips::MoveReport> {
    blocking(move || trips::rename_photos(&app.state::<AppState>().db, &photo_ids, &name, 1)).await
}

/// Copies files picked from anywhere into a library folder (optionally a new
/// subfolder of it) and adds them; their thumbnails follow in the background.
#[tauri::command]
pub async fn add_items(app: AppHandle, paths: Vec<String>, folder: String, new_folder: Option<String>) -> Reply<Vec<String>> {
    let name = new_folder.map(|n| n.trim().to_owned()).filter(|n| !n.is_empty());
    if let Some(n) = &name {
        if n.starts_with('.') || n.contains('/') || n.contains('\\') || n.contains(':') {
            return Err(format!("\"{n}\" can't be a folder name"));
        }
    }
    let ids = blocking({
        let app = app.clone();
        move || {
            let state = app.state::<AppState>();
            let dest = match &name {
                Some(n) => Path::new(&folder).join(n),
                None => PathBuf::from(&folder),
            };
            let files: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
            trips::add_files(&state.db, &files, &dest, &crate::library::media::read_metadata)
        }
    })
    .await?;
    let state = app.state::<AppState>();
    let _ = state.thumbs.enqueue_pending(&state.db);
    let _ = app.emit("library-changed", "added");
    Ok(ids)
}

/// Puts the files of a move back.
#[tauri::command]
pub async fn undo_trip_move(app: AppHandle, moves: Vec<trips::FileMove>) -> Reply<usize> {
    blocking(move || trips::undo(&app.state::<AppState>().db, &moves)).await
}

/// The photos of a trip whose GPS says they were taken somewhere else.
#[tauri::command]
pub async fn misplaced(app: AppHandle, trip: String) -> Reply<Vec<trips::Misplaced>> {
    blocking(move || trips::misplaced(&app.state::<AppState>().db, &trip)).await
}

#[tauri::command]
pub async fn smart_counts(state: State<'_, AppState>) -> Reply<auto::SmartCounts> {
    auto::smart_counts(&state.db).map_err(text)
}

#[tauri::command]
pub async fn list_photos(state: State<'_, AppState>, query: photos::Query, offset: i64, limit: i64) -> Reply<Vec<photos::PhotoRow>> {
    photos::list(&state.db, &query, offset.max(0), limit.clamp(1, 2_000)).map_err(text)
}

#[tauri::command]
pub async fn photo_ids(state: State<'_, AppState>, query: photos::Query, offset: i64, limit: i64) -> Reply<Vec<String>> {
    photos::ids(&state.db, &query, offset.max(0), limit.clamp(1, 200_000)).map_err(text)
}

#[tauri::command]
pub async fn photo_position(state: State<'_, AppState>, query: photos::Query, id: String) -> Reply<Option<i64>> {
    photos::position(&state.db, &query, &id).map_err(text)
}

#[tauri::command]
pub async fn photos_in_view(state: State<'_, AppState>, query: photos::Query, ids: Vec<String>) -> Reply<Vec<String>> {
    photos::in_view(&state.db, &query, &ids).map_err(text)
}

#[tauri::command]
pub async fn review_marks(state: State<'_, AppState>, ids: Vec<String>) -> Reply<Vec<photos::ReviewMark>> {
    photos::review_marks(&state.db, &ids).map_err(text)
}

/// Undo of a mark: exact previous state and time; Finder tags follow along.
#[tauri::command]
pub async fn restore_marks(app: AppHandle, state: State<'_, AppState>, marks: Vec<photos::ReviewMark>) -> Reply<usize> {
    let n = photos::restore_marks(&state.db, &marks).map_err(text)?;
    let ids: Vec<String> = marks.into_iter().map(|m| m.id).collect();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let _guard = state.side_effects.lock().unwrap_or_else(|e| e.into_inner());
        let _ = finder::sync(&state.db, &ids);
    });
    Ok(n)
}

#[tauri::command]
pub async fn photo_neighbor(state: State<'_, AppState>, query: photos::Query, id: String, dir: i32) -> Reply<Option<(String, i64)>> {
    photos::neighbor(&state.db, &query, &id, dir).map_err(text)
}

#[tauri::command]
pub async fn photo_detail(state: State<'_, AppState>, id: String) -> Reply<photos::PhotoDetail> {
    photos::detail(&state.db, &id).map_err(text)
}

/// A photo's burst, for comparing its frames side by side.
#[tauri::command]
pub async fn photo_burst(state: State<'_, AppState>, id: String) -> Reply<Vec<photos::PhotoRow>> {
    photos::burst(&state.db, &id).map_err(text)
}

#[tauri::command]
pub async fn photo_rows(state: State<'_, AppState>, ids: Vec<String>) -> Reply<Vec<photos::PhotoRow>> {
    state.db.read(|c| photos::rows_by_id(c, &ids)).map_err(text)
}

/// Marks photos, then (in the background) brings Finder tags, offline copies
/// and automatic edits in line with the new state.
#[tauri::command]
pub async fn set_review(app: AppHandle, state: State<'_, AppState>, ids: Vec<String>, review: ReviewState) -> Reply<usize> {
    let changed = photos::set_review(&state.db, &ids, review).map_err(text)?;
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let _guard = state.side_effects.lock().unwrap_or_else(|e| e.into_inner());
        let _ = finder::sync(&state.db, &ids);
        if review == ReviewState::Selected {
            let mut touched = false;
            if offline::auto(&state.db).unwrap_or(false) {
                touched |= offline::keep_auto(&state.db, &ids).map(|r| r.copied > 0).unwrap_or(false);
            }
            touched |= auto::on_selected(&state.db, &ids).map(|n| n > 0).unwrap_or(false);
            if touched {
                let _ = app.emit("library-changed", "selected");
            }
        }
    });
    Ok(changed)
}

// ------------------------------------------------------------------ albums & tags

#[tauri::command]
pub async fn list_albums(state: State<'_, AppState>) -> Reply<Vec<albums::Album>> {
    albums::list(&state.db).map_err(text)
}

#[tauri::command]
pub async fn create_album(state: State<'_, AppState>, name: String, description: Option<String>, photo_ids: Option<Vec<String>>) -> Reply<albums::Album> {
    let album = albums::create(&state.db, &name, description.as_deref().unwrap_or("")).map_err(text)?;
    if let Some(ids) = photo_ids.filter(|i| !i.is_empty()) {
        albums::add_photos(&state.db, &album.id, &ids).map_err(text)?;
        return albums::get(&state.db, &album.id).map_err(text);
    }
    Ok(album)
}

#[tauri::command]
pub async fn update_album(state: State<'_, AppState>, id: String, patch: albums::AlbumPatch) -> Reply<albums::Album> {
    albums::update(&state.db, &id, &patch).map_err(text)
}

#[tauri::command]
pub async fn delete_album(state: State<'_, AppState>, id: String, source: Option<String>) -> Reply<()> {
    albums::delete(&state.db, &id, source.as_deref().unwrap_or("menu")).map_err(text)
}

#[tauri::command]
pub async fn album_add(state: State<'_, AppState>, id: String, photo_ids: Vec<String>) -> Reply<usize> {
    albums::add_photos(&state.db, &id, &photo_ids).map_err(text)
}

#[tauri::command]
pub async fn album_remove(state: State<'_, AppState>, id: String, photo_ids: Vec<String>) -> Reply<usize> {
    albums::remove_photos(&state.db, &id, &photo_ids).map_err(text)
}

#[tauri::command]
pub async fn list_tags(state: State<'_, AppState>) -> Reply<Vec<tags::Tag>> {
    tags::list(&state.db).map_err(text)
}

#[tauri::command]
pub async fn tag_photos(state: State<'_, AppState>, names: Vec<String>, photo_ids: Vec<String>) -> Reply<usize> {
    tags::add(&state.db, &names, &photo_ids).map_err(text)
}

#[tauri::command]
pub async fn untag_photos(state: State<'_, AppState>, tag_id: String, photo_ids: Vec<String>) -> Reply<usize> {
    tags::remove(&state.db, &tag_id, &photo_ids).map_err(text)
}

#[tauri::command]
pub async fn rename_tag(state: State<'_, AppState>, id: String, name: String) -> Reply<()> {
    tags::rename(&state.db, &id, &name).map_err(text)
}

#[tauri::command]
pub async fn delete_tag(state: State<'_, AppState>, id: String) -> Reply<()> {
    tags::delete(&state.db, &id).map_err(text)
}

// ------------------------------------------------------------------ accounts & posts

#[tauri::command]
pub async fn list_accounts(state: State<'_, AppState>) -> Reply<Vec<accounts::Account>> {
    accounts::list(&state.db).map_err(text)
}

#[tauri::command]
pub async fn create_account(state: State<'_, AppState>, input: accounts::AccountInput) -> Reply<accounts::Account> {
    accounts::create(&state.db, &input).map_err(text)
}

#[tauri::command]
pub async fn update_account(state: State<'_, AppState>, id: String, input: accounts::AccountInput) -> Reply<accounts::Account> {
    accounts::update(&state.db, &id, &input).map_err(text)
}

#[tauri::command]
pub async fn delete_account(state: State<'_, AppState>, id: String) -> Reply<()> {
    accounts::delete(&state.db, &id).map_err(text)
}

#[tauri::command]
pub async fn list_posts(state: State<'_, AppState>, filter: Option<posts::PostFilter>) -> Reply<Vec<posts::Post>> {
    posts::list(&state.db, &filter.unwrap_or_default()).map_err(text)
}

#[tauri::command]
pub async fn get_post(state: State<'_, AppState>, id: String) -> Reply<posts::PostDetail> {
    posts::get(&state.db, &id).map_err(text)
}

#[tauri::command]
pub async fn create_post(state: State<'_, AppState>, input: posts::PostInput, photo_ids: Option<Vec<String>>) -> Reply<posts::PostDetail> {
    posts::create(&state.db, &input, &photo_ids.unwrap_or_default()).map_err(text)
}

#[tauri::command]
pub async fn update_post(state: State<'_, AppState>, id: String, input: posts::PostInput) -> Reply<posts::PostDetail> {
    posts::update(&state.db, &id, &input).map_err(text)
}

#[tauri::command]
pub async fn delete_post(state: State<'_, AppState>, id: String, source: Option<String>) -> Reply<()> {
    posts::delete(&state.db, &id, source.as_deref().unwrap_or("menu")).map_err(text)
}

// ---------------------------------------------------------------- Recently deleted

#[tauri::command]
pub async fn trash_list(state: State<'_, AppState>, kind: Option<String>) -> Reply<Vec<crate::library::trash::TrashItem>> {
    crate::library::trash::list(&state.db, kind.as_deref()).map_err(text)
}

/// Tells every screen a restore or removal happened: Studio lists (ideas,
/// projects) listen to « studio-changed », the rest to « library-changed ».
fn trash_changed<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit("studio-changed", ());
    let _ = app.emit("library-changed", "trash");
}

#[tauri::command]
pub async fn trash_restore<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, id: i64, source: Option<String>) -> Reply<String> {
    let out = crate::library::trash::restore(&state.db, id, source.as_deref().unwrap_or("Recently deleted")).map_err(text)?;
    trash_changed(&app);
    Ok(out)
}

#[tauri::command]
pub async fn trash_purge<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, id: i64) -> Reply<()> {
    crate::library::trash::purge(&state.db, id, "Recently deleted").map_err(text)?;
    trash_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn audit_lines(state: State<'_, AppState>, limit: Option<i64>) -> Reply<Vec<crate::library::trash::AuditLine>> {
    crate::library::trash::audit_lines(&state.db, limit.unwrap_or(200)).map_err(text)
}

#[tauri::command]
pub async fn post_add_photos(state: State<'_, AppState>, id: String, photo_ids: Vec<String>) -> Reply<usize> {
    posts::add_photos(&state.db, &id, &photo_ids).map_err(text)
}

#[tauri::command]
pub async fn post_remove_photos(state: State<'_, AppState>, id: String, photo_ids: Vec<String>) -> Reply<usize> {
    posts::remove_photos(&state.db, &id, &photo_ids).map_err(text)
}

#[tauri::command]
pub async fn post_reorder(state: State<'_, AppState>, id: String, ordered: Vec<String>) -> Reply<()> {
    posts::reorder_photos(&state.db, &id, &ordered).map_err(text)
}

#[tauri::command]
pub async fn post_pipeline(state: State<'_, AppState>, account: Option<String>) -> Reply<posts::Pipeline> {
    posts::pipeline(&state.db, account.as_deref()).map_err(text)
}

#[tauri::command]
pub async fn account_grid(state: State<'_, AppState>, account: String) -> Reply<Vec<posts::Post>> {
    posts::grid(&state.db, &account).map_err(text)
}

#[tauri::command]
pub async fn plan_posts(state: State<'_, AppState>, ordered: Vec<String>) -> Reply<()> {
    posts::plan(&state.db, &ordered).map_err(text)
}

#[tauri::command]
pub async fn dashboard(state: State<'_, AppState>) -> Reply<dashboard::Summary> {
    dashboard::summary(&state.db).map_err(text)
}

// ------------------------------------------------------------------ Finder tags, offline, archive

#[tauri::command]
pub async fn finder_sync_all(app: AppHandle) -> Reply<finder::SyncReport> {
    blocking(move || {
        let state = app.state::<AppState>();
        let _guard = state.side_effects.lock().unwrap_or_else(|e| e.into_inner());
        finder::sync_all(&state.db)
    })
    .await
}

#[tauri::command]
pub async fn finder_remove_added(app: AppHandle) -> Reply<finder::SyncReport> {
    blocking(move || {
        let state = app.state::<AppState>();
        let _guard = state.side_effects.lock().unwrap_or_else(|e| e.into_inner());
        finder::remove_added(&state.db, None)
    })
    .await
}

#[tauri::command]
pub async fn offline_info(state: State<'_, AppState>) -> Reply<offline::OfflineInfo> {
    offline::info(&state.db).map_err(text)
}

#[tauri::command]
pub async fn offline_keep(app: AppHandle, photo_ids: Vec<String>) -> Reply<offline::OfflineReport> {
    blocking(move || {
        let state = app.state::<AppState>();
        let _guard = state.side_effects.lock().unwrap_or_else(|e| e.into_inner());
        offline::keep(&state.db, &photo_ids)
    })
    .await
}

#[tauri::command]
pub async fn offline_release(app: AppHandle, photo_ids: Vec<String>) -> Reply<offline::OfflineReport> {
    blocking(move || {
        let state = app.state::<AppState>();
        let _guard = state.side_effects.lock().unwrap_or_else(|e| e.into_inner());
        offline::release(&state.db, &photo_ids)
    })
    .await
}

#[tauri::command]
pub async fn list_locations(state: State<'_, AppState>) -> Reply<Vec<storage::Location>> {
    storage::list_locations(&state.db).map_err(text)
}

#[tauri::command]
pub async fn add_location(state: State<'_, AppState>, path: String, label: Option<String>) -> Reply<storage::Location> {
    storage::add_local_location(&state.db, Path::new(&path), label.as_deref()).map_err(text)
}

#[tauri::command]
pub async fn remove_location(state: State<'_, AppState>, id: String) -> Reply<()> {
    storage::remove_location(&state.db, &id).map_err(text)
}

#[tauri::command]
pub async fn archive_photos(app: AppHandle, location_id: String, photo_ids: Vec<String>) -> Reply<archive::ArchiveReport> {
    blocking(move || {
        let state = app.state::<AppState>();
        let allow = offline::allow_cloud(&state.db)?;
        archive::archive_photos(&state.db, &location_id, &photo_ids, allow)
    })
    .await
}

// ------------------------------------------------------------------ looks & editing

fn run_looks_import(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.looks_busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let report = looks::folders(&state.db).and_then(|f| looks::import(&state.db, &state.looks_dir, &f));
    let _ = app.emit("looks-changed", report.as_ref().map(|r| r.added).unwrap_or(0));
    state.looks_busy.store(false, Ordering::SeqCst);
    bake_looks(app);
}

/// Bakes every look's table in the background, telling the UI as batches land.
fn bake_looks(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.looks_busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let never = AtomicBool::new(false);
    let _ = looks::bake_all(&state.db, &state.looks_dir, &never);
    state.looks_busy.store(false, Ordering::SeqCst);
    let _ = app.emit("looks-changed", 0);
}

#[tauri::command]
pub async fn import_looks(app: AppHandle) -> Reply<()> {
    std::thread::spawn(move || run_looks_import(&app));
    Ok(())
}

#[tauri::command]
pub async fn add_look_folder(app: AppHandle, state: State<'_, AppState>, path: String) -> Reply<()> {
    looks::add_folder(&state.db, &path).map_err(text)?;
    std::thread::spawn(move || run_looks_import(&app));
    Ok(())
}

#[tauri::command]
pub async fn list_looks(state: State<'_, AppState>) -> Reply<Vec<looks::Look>> {
    looks::list(&state.db, &state.looks_dir).map_err(text)
}

/// Saves an edit (look, strength and sliders, not the crop) as one of your looks.
#[tauri::command]
pub async fn save_look(
    state: State<'_, AppState>,
    name: String,
    base: Option<String>,
    strength: f64,
    adjustments: looks::Adjustments,
) -> Reply<looks::Look> {
    looks::save(&state.db, &state.looks_dir, &name, base.as_deref(), strength, &adjustments).map_err(text)
}

#[tauri::command]
pub async fn delete_look(state: State<'_, AppState>, id: String) -> Reply<()> {
    looks::delete(&state.db, &state.looks_dir, &id).map_err(text)
}

#[tauri::command]
pub async fn set_look_favorites(state: State<'_, AppState>, ordered: Vec<String>) -> Reply<()> {
    looks::set_favorites(&state.db, &ordered).map_err(text)
}

#[tauri::command]
pub async fn photo_look(state: State<'_, AppState>, photo_id: String) -> Reply<looks::PhotoLook> {
    looks::for_photo(&state.db, &photo_id).map_err(text)
}

/// The look the photo's album uses, for a photo with none of its own.
#[tauri::command]
pub async fn album_look(state: State<'_, AppState>, photo_id: String) -> Reply<Option<looks::AlbumLook>> {
    looks::album_look(&state.db, &photo_id).map_err(text)
}

/// Makes an edit the album's own look, or with `None` lets it go. Photos are not changed.
#[tauri::command]
pub async fn set_album_look(state: State<'_, AppState>, album_id: String, recipe: Option<looks::Recipe>) -> Reply<()> {
    looks::set_album_look(&state.db, &album_id, recipe.as_ref()).map_err(text)
}

/// Changes an album's look and the photos still exactly on the old one.
#[tauri::command]
pub async fn change_album_look(state: State<'_, AppState>, album_id: String, recipe: looks::Recipe) -> Reply<looks::AlbumLookChange> {
    looks::change_album_look(&state.db, &album_id, &recipe).map_err(text)
}

/// Sets the look and/or adjustments on one or many photos ("sync to selection").
#[tauri::command]
pub async fn photo_looks(state: State<'_, AppState>, photo_ids: Vec<String>) -> Reply<Vec<looks::PhotoLook>> {
    looks::for_photos(&state.db, &photo_ids).map_err(text)
}

#[tauri::command]
pub async fn apply_look(
    state: State<'_, AppState>,
    photo_ids: Vec<String>,
    look_id: Option<String>,
    strength: Option<f64>,
    adjustments: Option<looks::Adjustments>,
) -> Reply<usize> {
    looks::apply(&state.db, &photo_ids, look_id.as_deref(), strength.unwrap_or(1.0), adjustments.as_ref()).map_err(text)
}

#[tauri::command]
pub async fn auto_adjust(state: State<'_, AppState>, photo_id: String) -> Reply<looks::Adjustments> {
    auto::auto_for_photo(&state.db, &photo_id).map_err(text)
}

/// Where exports go: Settings › Exports, or "Exports" inside the offline-copies folder.
pub(crate) fn exports_dir(db: &Db) -> crate::library::Result<PathBuf> {
    if let Some(dir) = settings::get(db, "exports.dir")?.map(|v| v.trim_matches('"').to_owned()).filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    Ok(offline::library_dir(db)?.join("Exports"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSpace {
    used: u64,
    max: u64,
    dir: String,
}

#[tauri::command]
pub async fn preview_space(state: State<'_, AppState>) -> Reply<PreviewSpace> {
    let (db, cache) = (state.db.clone(), state.cache.clone());
    tauri::async_runtime::spawn_blocking(move || PreviewSpace {
        used: thumbs::previews_size(&cache),
        max: preview_budget(&db),
        dir: cache.root().join("previews").display().to_string(),
    })
    .await
    .map_err(|e| e.to_string())
}

/// Removes the sharp previews and full-size views (the app's own cache files);
/// they're made again when photos are opened.
#[tauri::command]
pub async fn clear_previews(state: State<'_, AppState>) -> Reply<u64> {
    let cache = state.cache.clone();
    tauri::async_runtime::spawn_blocking(move || thumbs::prune_previews(&cache, 0).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn look_folders(state: State<'_, AppState>) -> Reply<Vec<looks::LookFolder>> {
    looks::folder_list(&state.db).map_err(text)
}

/// Stops using a look folder: its unused looks go, looks photos use stay.
#[tauri::command]
pub async fn remove_look_folder(app: AppHandle, state: State<'_, AppState>, path: String) -> Reply<(usize, usize)> {
    let out = looks::remove_folder(&state.db, &state.looks_dir, &path).map_err(text)?;
    let _ = app.emit("looks-changed", ());
    Ok(out)
}

/// Saves an edited JPEG the editor rendered. Body: the JPEG bytes; header
/// `x-name`: the file name. Never overwrites: adds " 2", " 3"... instead.
#[tauri::command]
pub async fn export_image(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Reply<String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the image bytes".into());
    };
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Err("not a JPEG".into());
    }
    // Headers only carry ASCII, so the page sends the name as base64 UTF-8:
    // "Café · Gent" survives instead of becoming "export".
    let headers = request.headers();
    let decoded = headers.get("x-name-b64").and_then(|v| v.to_str().ok()).and_then(|b| {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.decode(b).ok().and_then(|raw| String::from_utf8(raw).ok())
    });
    let name = decoded.as_deref().or_else(|| headers.get("x-name").and_then(|v| v.to_str().ok())).unwrap_or("export");
    let stem = export_stem(name, ".jpg");
    let dir = exports_dir(&state.db).map_err(text)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // A "date taken" (x-taken, "YYYY:MM:DD HH:MM:SS") puts a carousel's files
    // together and in order in Instagram's photo picker.
    let taken = headers.get("x-taken").and_then(|v| v.to_str().ok()).map(str::to_owned);
    let body = match &taken {
        Some(t) => crate::library::exif::with_taken_time(bytes, t),
        None => bytes.to_vec(),
    };
    let (mut f, file) = new_export_file(&dir, &stem, "jpg")?;
    use std::io::Write;
    f.write_all(&body).map_err(|e| e.to_string())?;
    if let Some(when) = taken.and_then(|t| chrono::NaiveDateTime::parse_from_str(&t, "%Y:%m:%d %H:%M:%S").ok()) {
        use chrono::TimeZone;
        if let Some(local) = chrono::Local.from_local_datetime(&when).single() {
            let _ = f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(local.timestamp().max(0) as u64));
        }
    }
    Ok(file.display().to_string())
}

/// Copies a video, untouched, into Exports as '<name>.mp4'. The original is only read.
#[tauri::command]
pub async fn export_video(state: State<'_, AppState>, id: String, name: String) -> Reply<String> {
    let (path, _) = thumbs::video_file(&state.db, &id).map_err(text)?;
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_else(|| "mp4".into());
    let stem = export_stem(&name, "");
    let dir = exports_dir(&state.db).map_err(text)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut from = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        let (mut to, file) = new_export_file(&dir, &stem, &ext)?;
        if let Err(e) = std::io::copy(&mut from, &mut to) {
            drop(to);
            let _ = std::fs::remove_file(&file); // our own half-written export, never an original
            return Err(e.to_string());
        }
        Ok(file.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A safe file name from what the page sent.
fn export_stem(name: &str, strip_ext: &str) -> String {
    let clean: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || " -_.(),·".contains(c) { c } else { '_' })
        .collect::<String>()
        .trim_matches(['.', ' '])
        .chars()
        .take(120)
        .collect();
    if clean.is_empty() {
        "export".to_owned()
    } else if strip_ext.is_empty() {
        clean
    } else {
        clean.trim_end_matches(strip_ext).to_owned()
    }
}

/// A new file in Exports that never replaces an existing one ('Name 2.jpg' when taken).
fn new_export_file(dir: &Path, stem: &str, ext: &str) -> Result<(std::fs::File, PathBuf), String> {
    for n in 1..10_000 {
        let file = if n == 1 { dir.join(format!("{stem}.{ext}")) } else { dir.join(format!("{stem} {n}.{ext}")) };
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&file) {
            Ok(f) => return Ok((f, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("too many exports with that name".into())
}

/// Shows a file (an export, a source folder) in Finder. Only paths the app
/// knows about: exports, sources and the app's own folders.
#[tauri::command]
pub async fn reveal(state: State<'_, AppState>, path: String) -> Reply<()> {
    let p = Path::new(&path);
    let allowed = p.starts_with(offline::library_dir(&state.db).map_err(text)?)
        || sources::list(&state.db).map_err(text)?.iter().any(|s| p.starts_with(&s.path))
        || p.starts_with(state.cache.root().parent().unwrap_or(state.cache.root()))
        || p.starts_with(crate::library::studio::root(&state.db))
        || p.starts_with(exports_dir(&state.db).map_err(text)?);
    if !allowed || !p.exists() {
        return Err("not a file this app manages".into());
    }
    std::process::Command::new("/usr/bin/open").arg("-R").arg(p).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// Opens a saved link (a web page) in the default browser. Web links only.
/// "View in source": the photo's original opened in Google Drive in the
/// browser (its Drive id comes from the Drive app); a file elsewhere is shown in Finder.
#[tauri::command]
pub async fn view_in_source(state: State<'_, AppState>, photo_id: String) -> Reply<String> {
    let path: String = state
        .db
        .read(|c| Ok(c.query_row("SELECT path FROM assets WHERE photo_id = ?1 AND is_primary = 1", [&photo_id], |r| r.get(0))?))
        .map_err(text)?;
    let path = PathBuf::from(path);
    if let Some(id) = crate::library::gdrive::file_id(&path).filter(|id| id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')) {
        let url = format!("https://drive.google.com/file/d/{id}/view");
        std::process::Command::new("/usr/bin/open").arg(&url).status().map_err(|e| e.to_string())?;
        return Ok("drive".into());
    }
    std::process::Command::new("/usr/bin/open").arg("-R").arg(&path).status().map_err(|e| e.to_string())?;
    Ok("finder".into())
}

#[tauri::command]
pub async fn open_link(url: String) -> Reply<()> {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) || url.chars().any(char::is_whitespace) {
        return Err("not a web link".into());
    }
    std::process::Command::new("/usr/bin/open").arg(url).status().map_err(|e| e.to_string())?;
    Ok(())
}

// ------------------------------------------------------------------ backups

#[tauri::command]
pub async fn list_backups(state: State<'_, AppState>) -> Reply<Vec<backup::BackupInfo>> {
    Ok(backup::list(state.db.path()))
}

#[tauri::command]
pub async fn backup_now(state: State<'_, AppState>) -> Reply<backup::BackupInfo> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || backup::now(&db)).await.map_err(|e| e.to_string())?.map_err(text)
}

/// Saves the library as it is now, then restarts with the chosen backup in place.
#[tauri::command]
pub async fn restore_backup<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, name: String) -> Reply<()> {
    state.cancel.store(true, Ordering::SeqCst);
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || backup::stage_restore(&db, &name))
        .await
        .map_err(|e| e.to_string())?
        .map_err(text)?;
    app.restart();
}

/// The backup restored at this launch, once.
#[tauri::command]
pub async fn restore_note(state: State<'_, AppState>) -> Reply<Option<String>> {
    Ok(state.restored.lock().unwrap_or_else(|e| e.into_inner()).take())
}

// ------------------------------------------------------------------ framing (straighten, subject)

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FrameHint {
    photo_id: String,
    /// Degrees the horizon rises to the right (straighten clockwise by this).
    horizon: Option<f64>,
    /// Where the eye goes: x, y, w, h (0..1 from the top left).
    subject: Option<[f64; 4]>,
}

pub(crate) fn vision_helper<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .resolve("helpers/vision", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.is_file())
        .unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/helpers/vision").into())
}

/// Apple's on-device analysis of the sharp previews (or tiles) already on this
/// Mac: the horizon's tilt and the main subject. Never downloads an original.
#[tauri::command]
pub async fn frame_hints<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, photo_ids: Vec<String>) -> Reply<Vec<FrameHint>> {
    let cache = state.cache.clone();
    let helper = vision_helper(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let mut files: Vec<(String, PathBuf)> = Vec::new();
        for id in photo_ids.into_iter().filter(|id| thumbs::is_photo_id(id)) {
            let preview = cache.preview(&id);
            let file = if preview.is_file() { preview } else { cache.thumb(&id) };
            if file.is_file() {
                files.push((id, file));
            }
        }
        let mut hints = Vec::new();
        for chunk in files.chunks(40) {
            let out = std::process::Command::new(&helper)
                .args(chunk.iter().map(|(_, f)| f))
                .output()
                .map_err(|e| format!("Image analysis couldn't start: {e}"))?;
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                let file = v.get("file").and_then(|f| f.as_str()).unwrap_or_default();
                let Some((id, _)) = chunk.iter().find(|(_, f)| f.to_string_lossy() == file) else { continue };
                let subject = v.get("subject").and_then(|s| s.as_array()).and_then(|a| {
                    let n: Vec<f64> = a.iter().filter_map(|x| x.as_f64()).collect();
                    (n.len() == 4).then(|| [n[0], n[1], n[2], n[3]])
                });
                hints.push(FrameHint { photo_id: id.clone(), horizon: v.get("horizon").and_then(|h| h.as_f64()), subject });
            }
        }
        Ok(hints)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ------------------------------------------------------------------ clips for Instagram

/// A finished clip for Instagram: part of a video (or all of it) with its look,
/// strength, sliders and crop, converted from S-Log3 when filmed in it, at the
/// ratio's size (9:16 reel 1080 x 1920, 4:5, 3:4 or 1:1), written to Exports as
/// `name`. A video without any of that (and `plain_copy`) is copied untouched.
/// Progress goes out as "clip-progress" { photoId, fraction }.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn export_clip<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    photo_id: String,
    ratio: String,
    start: Option<f64>,
    end: Option<f64>,
    name: String,
    plain_copy: Option<bool>,
    out_size: Option<String>,
    bitrate: Option<f64>,
) -> Reply<String> {
    let (db, looks_dir) = (state.db.clone(), state.looks_dir.clone());
    // No part asked for: the video as trimmed (the whole clip when it isn't).
    let (start, end) = match (start, end) {
        (None, None) => moments::trim(&db, &photo_id).map_err(text)?.map_or((None, None), |(a, b)| (Some(a), Some(b))),
        part => part,
    };
    let edit = looks::for_photo(&db, &photo_id).map_err(text)?;
    let a = edit.adjustments;
    let edited = edit.look_id.is_some() || a != looks::Adjustments::default() || edit.log;
    if !edited && plain_copy.unwrap_or(false) && start.is_none() && end.is_none() {
        return export_video(state, photo_id, name).await;
    }
    // An exact size from the export sheet (« 1080x1920 »), even numbers only; else the shape's default.
    let exact = out_size.filter(|s| {
        let v: Vec<u32> = s.split('x').filter_map(|n| n.parse().ok()).collect();
        v.len() == 2 && v.iter().all(|n| *n >= 2 && *n <= 8192 && n % 2 == 0)
    });
    let size: &str = if let Some(e) = &exact { e.as_str() } else { match ratio.as_str() {
        // The video's own shape: Full HD, or 4K (never larger than the video).
        "original" => "auto:1920",
        "original-4k" => "auto:3840",
        "4:5" => "1080x1350",
        "3:4" => "1080x1440",
        "1:1" => "1080x1080",
        _ => "1080x1920",
    } };
    let dir = exports_dir(&db).map_err(text)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (file, out) = new_export_file(&dir, &export_stem(&name, ""), "mp4")?;
    drop(file);
    let mut cmd = clip_command(&app, &db, &looks_dir, &photo_id, &out, size, start, end)?;
    if let Some(b) = bitrate.filter(|b| (200_000.0..=200_000_000.0).contains(b)) {
        cmd.args(["--bitrate", &format!("{}", b.round() as i64)]);
    }
    let events = app.clone();
    let id = photo_id.clone();
    tauri::async_runtime::spawn_blocking(move || -> Reply<String> {
        match run_clip(cmd, &out, |f| {
            let _ = events.emit("clip-progress", serde_json::json!({ "photoId": id, "fraction": f }));
        }) {
            Ok(()) => {
                crate::applog::line(&format!("clip exported: {}", out.display()));
                Ok(out.display().to_string())
            }
            Err(e) => Err(format!("The clip couldn't be made: {e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A video's shown size, frame rate and length, for the export sheet's sizes and estimates.
#[derive(serde::Serialize)]
pub struct VideoInfo {
    width: u32,
    height: u32,
    fps: f64,
    duration: f64,
}

#[tauri::command]
pub async fn video_info<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, id: String) -> Reply<VideoInfo> {
    let (video, _) = thumbs::video_file(&state.db, &id).map_err(text)?;
    let helper = clip_helper(&app);
    tauri::async_runtime::spawn_blocking(move || -> Reply<VideoInfo> {
        let out = std::process::Command::new(helper).arg(&video).arg("-").args(["--info", "1"]).output().map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&out.stdout);
        let line = text.lines().find(|l| l.starts_with("info ")).ok_or_else(|| "couldn't read the video".to_string())?;
        let v: Vec<f64> = line[5..].split_whitespace().filter_map(|n| n.parse().ok()).collect();
        if v.len() != 4 {
            return Err("couldn't read the video".into());
        }
        Ok(VideoInfo { width: v[0] as u32, height: v[1] as u32, fps: v[2], duration: v[3] })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copies a picture's or video's original file, untouched, into Downloads and returns the copy's path.
/// When the original's drive or folder isn't there, says which one to plug in.
#[tauri::command]
pub async fn save_original(state: State<'_, AppState>, id: String) -> Reply<String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || -> Reply<String> {
        let (path, source): (String, String) = db
            .read(|c| {
                Ok(c.query_row(
                    "SELECT a.path, COALESCE(s.label, s.path, '') FROM assets a LEFT JOIN sources s ON s.id = a.source_id WHERE a.photo_id = ?1 AND a.is_primary = 1",
                    [&id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?)
            })
            .map_err(text)?;
        let from = PathBuf::from(&path);
        if !from.exists() {
            return Err(format!("The original is on « {source} », which isn't connected. Plug it in and try again."));
        }
        let dir = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join("Downloads");
        let to = copy_untouched(&from, &dir)?;
        Ok(to.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copies `from` into `dir` under its own name (« name 2.ext » when taken), byte for byte.
/// Never writes over a file; the source is only read.
pub fn copy_untouched(from: &Path, dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let name = from.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "original".into());
    let (stem, ext) = name.rsplit_once('.').map(|(a, b)| (a.to_owned(), b.to_owned())).unwrap_or((name.clone(), String::new()));
    let mut to = dir.join(&name);
    let mut n = 2;
    while to.exists() {
        to = dir.join(if ext.is_empty() { format!("{stem} {n}") } else { format!("{stem} {n}.{ext}") });
        n += 1;
    }
    let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(&to).map_err(|e| e.to_string())?;
    let mut input = std::fs::File::open(from).map_err(|e| e.to_string())?;
    if let Err(e) = std::io::copy(&mut input, &mut out) {
        drop(out);
        let _ = std::fs::remove_file(&to); // our own half-written copy
        return Err(e.to_string());
    }
    Ok(to)
}

#[cfg(test)]
mod save_original_tests {
    #[test]
    fn the_copy_is_byte_identical_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("DJI_0094.MP4");
        let bytes: Vec<u8> = (0..300_000u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
        std::fs::write(&src, &bytes).unwrap();
        let out = dir.path().join("Downloads");
        let a = super::copy_untouched(&src, &out).unwrap();
        let b = super::copy_untouched(&src, &out).unwrap();
        assert_eq!(std::fs::read(&a).unwrap(), bytes);
        assert_eq!(std::fs::read(&b).unwrap(), bytes);
        assert_eq!(b.file_name().unwrap(), "DJI_0094 2.MP4", "a second save gets its own name");
        assert_eq!(std::fs::read(&src).unwrap(), bytes, "the source is untouched");
    }
}

fn clip_helper<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .resolve("helpers/clip", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.is_file())
        .unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/helpers/clip").into())
}

/// The clip helper, set up to make `out` from a video with its saved edit
/// (look, every slider and effect, crop) at `size` ("1920x1080"), from `start`
/// to `end` seconds (None: from the beginning / to the end).
#[allow(clippy::too_many_arguments)]
pub fn clip_command<R: Runtime>(
    app: &AppHandle<R>,
    db: &Db,
    looks_dir: &Path,
    photo_id: &str,
    out: &Path,
    size: &str,
    start: Option<f64>,
    end: Option<f64>,
) -> Reply<std::process::Command> {
    let (video, _) = thumbs::video_file(db, photo_id).map_err(text)?;
    let edit = looks::for_photo(db, photo_id).map_err(text)?;
    let a = edit.adjustments;
    let lut = match &edit.look_id {
        Some(id) => Some(looks::bake(db, looks_dir, id).map_err(text)?),
        None => None,
    };
    let helper = app
        .path()
        .resolve("helpers/clip", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.is_file())
        .unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/helpers/clip").into());
    let mut cmd = std::process::Command::new(helper);
    cmd.arg(&video).arg(out).args(["--size", size]);
    if let Some(s) = start {
        cmd.args(["--start", &format!("{s:.3}")]);
    }
    if let Some(e) = end {
        cmd.args(["--end", &format!("{e:.3}")]);
    }
    if edit.log {
        cmd.arg("--log");
    }
    if let Some(lut) = &lut {
        cmd.arg("--lut").arg(lut).args(["--strength", &format!("{:.3}", edit.strength)]);
    }
    for (flag, v) in [
        ("--exposure", a.exposure),
        ("--contrast", a.contrast),
        ("--highlights", a.highlights),
        ("--shadows", a.shadows),
        ("--whites", a.whites),
        ("--blacks", a.blacks),
        ("--temperature", a.temperature),
        ("--tint", a.tint),
        ("--vibrance", a.vibrance),
        ("--saturation", a.saturation),
        ("--grain", a.grain),
        ("--vignette", a.vignette),
        ("--fade", a.fade),
        ("--soften", a.soften),
        ("--halation", a.halation),
        ("--fringe", a.fringe),
        ("--scanlines", a.scanlines),
        ("--weave", a.weave),
        ("--leak", a.leak),
        ("--straighten", a.straighten),
        ("--cropx", a.crop_x),
        ("--cropy", a.crop_y),
        ("--zoom", a.crop_zoom),
    ] {
        if v != 0.0 {
            cmd.args([flag, &format!("{v:.3}")]);
        }
    }
    Ok(cmd)
}

/// Runs the clip helper to the end, passing on its progress (0..1). On failure
/// the unfinished file is removed and the helper's reason returned.
pub fn run_clip(mut cmd: std::process::Command, out: &Path, mut progress: impl FnMut(f64)) -> Result<(), String> {
    use std::io::BufRead;
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("the clip helper couldn't start: {e}"))?;
    let mut outcome = String::new();
    if let Some(stdout) = child.stdout.take() {
        for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
            match line.strip_prefix("progress ").and_then(|f| f.trim().parse::<f64>().ok()) {
                Some(f) => progress(f),
                None => outcome = line,
            }
        }
    }
    let _ = child.wait();
    if outcome == "done" && out.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        Ok(())
    } else {
        let _ = std::fs::remove_file(out); // our own unfinished file
        Err(outcome.trim_start_matches("error ").to_owned())
    }
}

// ------------------------------------------------------------------ videos kept local while culling

/// The videos Cull wants downloaded (nearest first) and its whole window
/// (copies or not), with a generation number.
static VIDEO_WANT: Mutex<(u64, Vec<String>, Vec<String>)> = Mutex::new((0, Vec::new(), Vec::new()));
static VIDEO_WAKE: std::sync::Condvar = std::sync::Condvar::new();
static VIDEO_WORKER: std::sync::Once = std::sync::Once::new();

/// While culling: download the videos around the cursor (Cull sends the next
/// 15 and the previous 3) so they play without lag, one at a time, nearest
/// first, always leaving 3 GB free. Videos it downloaded that fall out of the
/// window are released again (they stay online, untouched). Selected and
/// rejected videos Cull has moved past are offloaded: review copy removed,
/// any download released.
#[tauri::command]
pub async fn keep_videos_local(state: State<'_, AppState>, photo_ids: Vec<String>) -> Reply<()> {
    let db = state.db.clone();
    let cache_root = state.cache.root().to_path_buf();
    let window = photo_ids.clone();
    // Videos with a review copy play from it: no need to download the original.
    let photo_ids: Vec<String> = photo_ids.into_iter().filter(|id| review::existing(state.cache.root(), id).is_none()).collect();
    VIDEO_WORKER.call_once(move || {
        let _ = std::thread::Builder::new().name("videos-local".into()).spawn(move || {
            let mut fetched: std::collections::HashMap<String, PathBuf> = std::collections::HashMap::new();
            let mut seen = 0u64;
            loop {
                let (gen, want, window) = {
                    let mut g = VIDEO_WANT.lock().unwrap_or_else(|e| e.into_inner());
                    while g.0 == seen {
                        g = VIDEO_WAKE.wait(g).unwrap_or_else(|e| e.into_inner());
                    }
                    g.clone()
                };
                seen = gen;
                // Culled videos Cull has moved past don't need this Mac any more.
                if let Ok((removed, bytes)) = review::offload_culled(&db, &cache_root, |id| !window.iter().any(|w| w == id)) {
                    if removed > 0 {
                        crate::applog::line(&format!("videos-local: offloaded {removed} culled video copies ({:.0} MB)", bytes as f64 / 1e6));
                    }
                }
                // Out of the window: give the space back.
                let gone: Vec<String> = fetched.keys().filter(|id| !want.contains(id)).cloned().collect();
                for id in gone {
                    if let Some(path) = fetched.remove(&id) {
                        media::release_download(&path);
                    }
                }
                for id in &want {
                    if VIDEO_WANT.lock().map(|g| g.0 != gen).unwrap_or(true) {
                        break; // Cull moved on: start from the new window
                    }
                    let Ok((path, size)) = thumbs::video_file(&db, id) else { continue };
                    let online = std::fs::symlink_metadata(&path).is_ok_and(|m| crate::library::scan::is_dataless(&m));
                    if !online || fetched.contains_key(id) {
                        continue;
                    }
                    if thumbs::free_bytes(&path) < size + crate::library::download::KEEP_FREE {
                        crate::applog::line("videos-local: not enough free space to keep more videos local");
                        break;
                    }
                    let _lane = crate::library::lane::take();
                    if media::fetch_download(&path).is_ok() {
                        fetched.insert(id.clone(), path);
                    }
                }
            }
        });
    });
    let mut g = VIDEO_WANT.lock().unwrap_or_else(|e| e.into_inner());
    if g.1 != photo_ids || g.2 != window {
        g.0 += 1;
        g.1 = photo_ids;
        g.2 = window;
        VIDEO_WAKE.notify_all();
    }
    Ok(())
}

// ------------------------------------------------------------------ stills from videos

/// Saves the frame of a video at `at` seconds, full size, as a new photo in
/// the app's own Stills folder (never next to the video), dated at that moment
/// of the clip, and adds it to the library. Returns the new photo's id.
#[tauri::command]
pub async fn save_video_still(state: State<'_, AppState>, photo_id: String, at: f64) -> Reply<String> {
    let (db, cache) = (state.db.clone(), state.cache.clone());
    tauri::async_runtime::spawn_blocking(move || -> Reply<String> {
        let (video, _) = thumbs::video_file(&db, &photo_id).map_err(text)?;
        let captured: String = db
            .read(|c| Ok(c.query_row("SELECT captured_at FROM photos WHERE id = ?1", [&photo_id], |r| r.get(0))?))
            .map_err(text)?;
        let dir = offline::library_dir(&db).map_err(text)?.join("Stills");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stem = video.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Video".into());
        let secs = at.max(0.0);
        let label = format!("{stem} at {}m{:04.1}s", (secs / 60.0).floor() as u64, secs % 60.0);
        let (file, path) = new_export_file(&dir, &export_stem(&label, ""), "jpg")?;
        drop(file);
        let grabbed = media::video_still(&video, &path, secs);
        if let Err(e) = grabbed {
            let _ = std::fs::remove_file(&path); // the empty file we just made
            return Err(text(e));
        }
        // Dated at that moment of the clip, so the still sits next to the video.
        if let Ok(start) = chrono::NaiveDateTime::parse_from_str(&captured[..19.min(captured.len())], "%Y-%m-%dT%H:%M:%S") {
            let when = start + chrono::Duration::milliseconds((secs * 1000.0) as i64);
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            let dated = crate::library::exif::with_taken_time(&bytes, &when.format("%Y:%m:%d %H:%M:%S").to_string());
            std::fs::write(&path, dated).map_err(|e| e.to_string())?;
        }
        let source = sources::add_folder(&db, &dir).map_err(text)?.source;
        scan::index_files(&db, &source.id, std::slice::from_ref(&path), &media::read_metadata).map_err(text)?;
        let path_text = path.canonicalize().unwrap_or(path.clone()).display().to_string();
        let new_id: String = db
            .read(|c| {
                Ok(c.query_row(
                    "SELECT photo_id FROM assets WHERE path = ?1 OR path = ?2",
                    rusqlite::params![path_text, path.display().to_string()],
                    |r| r.get(0),
                )?)
            })
            .map_err(text)?;
        let _ = thumbs::make_thumbnail(&db, &cache, &new_id);
        crate::applog::line(&format!("still saved from a video: {}", path.display()));
        Ok(new_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Everything the recogniser found across the library, most common first.
#[tauri::command]
pub async fn list_labels(state: State<'_, AppState>) -> Reply<labels::LabelList> {
    labels::list(&state.db).map_err(text)
}

/// What's in a photo (most confident first), for the photo page.
#[tauri::command]
pub async fn photo_labels(state: State<'_, AppState>, photo_id: String) -> Reply<Vec<(String, f64)>> {
    labels::for_photo(&state.db, &photo_id).map_err(text)
}

// ------------------------------------------------------------------ video moments

/// A video's trim as [start, end] seconds, or null for the whole clip.
#[tauri::command]
pub async fn video_trim(state: State<'_, AppState>, photo_id: String) -> Reply<Option<(f64, f64)>> {
    moments::trim(&state.db, &photo_id).map_err(text)
}

/// Trims a video; null for both points goes back to the whole clip.
#[tauri::command]
pub async fn set_video_trim(state: State<'_, AppState>, photo_id: String, start: Option<f64>, end: Option<f64>) -> Reply<()> {
    match (start, end) {
        (Some(a), Some(b)) => moments::set_trim(&state.db, &photo_id, a, b),
        _ => moments::clear_trim(&state.db, &photo_id),
    }
    .map_err(text)
}

#[tauri::command]
pub async fn video_moments(state: State<'_, AppState>, photo_id: String) -> Reply<Vec<moments::Moment>> {
    moments::list(&state.db, &photo_id).map_err(text)
}

#[tauri::command]
pub async fn add_video_moment(state: State<'_, AppState>, photo_id: String, start: f64, end: f64) -> Reply<moments::Moment> {
    moments::add(&state.db, &photo_id, start, end).map_err(text)
}

#[tauri::command]
pub async fn remove_video_moment(state: State<'_, AppState>, id: String) -> Reply<()> {
    moments::remove(&state.db, &id).map_err(text)
}

// ------------------------------------------------------------------ airdrop

/// Opens the AirDrop window for exported files (only files in Exports). Resolves
/// with "sent", "cancelled" or "unavailable" once the window closes.
#[tauri::command]
pub async fn airdrop<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, paths: Vec<String>) -> Reply<String> {
    let exports = exports_dir(&state.db).map_err(text)?;
    let exports = exports.canonicalize().unwrap_or(exports);
    let mut files = Vec::new();
    for p in &paths {
        let file = PathBuf::from(p).canonicalize().map_err(|_| format!("That export isn't there anymore: {p}"))?;
        let studio = crate::library::studio::root(&state.db);
        let studio = studio.canonicalize().unwrap_or(studio);
        if !(file.starts_with(&exports) || file.starts_with(&studio)) || !file.is_file() {
            return Err("Only exported files and files in the Studio folder can be sent with AirDrop.".into());
        }
        files.push(file);
    }
    if files.is_empty() {
        return Err("Nothing to send.".into());
    }
    let helper = app
        .path()
        .resolve("helpers/airdrop", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.is_file())
        .unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/helpers/airdrop").into());
    tauri::async_runtime::spawn_blocking(move || {
        let out = std::process::Command::new(helper).args(&files).output().map_err(|e| format!("AirDrop couldn't start: {e}"))?;
        let said = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        crate::applog::line(&format!("airdrop of {} files: {said}", files.len()));
        match said.as_str() {
            "sent" | "cancelled" => Ok(said),
            "unavailable" => Err("AirDrop isn't available: turn on Wi-Fi and Bluetooth, and check AirDrop in Control Centre.".into()),
            other => Err(format!("AirDrop stopped: {other}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ------------------------------------------------------------------ diagnostics

/// Everything useful for finding a problem, in one folder in Exports: the app
/// and voice logs, versions and space, and counts from the library. Shown in
/// Finder; nothing is sent anywhere.
#[tauri::command]
pub async fn export_diagnostics<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>) -> Reply<String> {
    let db = state.db.clone();
    let cache = state.cache.clone();
    let version = app.package_info().version.to_string();
    let voice_log = app.path().app_log_dir().ok().map(|d| d.join("voice.log"));
    let exports = exports_dir(&db).map_err(text)?;
    tauri::async_runtime::spawn_blocking(move || -> Reply<String> {
        let folder = exports.join(format!("Diagnostics {}", chrono::Local::now().format("%Y-%m-%d %H%M%S")));
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        if let Some(logs) = crate::applog::dir() {
            for name in ["app.log", "app.log.1"] {
                let _ = std::fs::copy(logs.join(name), folder.join(name));
            }
        }
        if let Some(v) = voice_log {
            let _ = std::fs::copy(v, folder.join("voice.log"));
        }
        let macos = std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
            .unwrap_or_default();
        let db_size = db.path().metadata().map(|m| m.len()).unwrap_or(0);
        let backups = backup::list(db.path());
        let about = format!(
            "Captured by Andy {version}\nmacOS {macos}\nLibrary: {} ({:.1} MB)\nFree space: {:.1} GB\nPreviews: {:.2} GB\nBackups: {} (newest {})\n",
            db.path().display(),
            db_size as f64 / 1e6,
            thumbs::free_bytes(db.path()) as f64 / 1e9,
            thumbs::previews_size(&cache) as f64 / 1e9,
            backups.len(),
            backups.first().map(|b| backup::label(b.created_ms)).unwrap_or_else(|| "none".into()),
        );
        std::fs::write(folder.join("about.txt"), about).map_err(|e| e.to_string())?;
        let stats = db
            .read(|c| {
                let mut out = String::new();
                let mut section = |title: &str, sql: &str| -> crate::library::Result<()> {
                    out.push_str(&format!("\n## {title}\n"));
                    let mut stmt = c.prepare(sql)?;
                    let cols = stmt.column_count();
                    let mut rows = stmt.query([])?;
                    while let Some(r) = rows.next()? {
                        let cells: Vec<String> = (0..cols)
                            .map(|i| match r.get_ref(i) {
                                Ok(v) => match v {
                                    rusqlite::types::ValueRef::Null => "-".into(),
                                    rusqlite::types::ValueRef::Integer(n) => n.to_string(),
                                    rusqlite::types::ValueRef::Real(f) => format!("{f:.2}"),
                                    rusqlite::types::ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
                                    rusqlite::types::ValueRef::Blob(b) => format!("<{} bytes>", b.len()),
                                },
                                Err(_) => "?".into(),
                            })
                            .collect();
                        out.push_str(&cells.join(" | "));
                        out.push('\n');
                    }
                    Ok(())
                };
                section("Photos by review", "SELECT review_state, is_video, COUNT(*) FROM photos GROUP BY 1, 2")?;
                section("Files by storage", "SELECT storage_state, COUNT(*) FROM assets GROUP BY 1")?;
                section("Tiles", "SELECT thumb_state, COUNT(*) FROM photos GROUP BY 1")?;
                section("Folders", "SELECT label, path, enabled, last_scan_finished_ms FROM sources")?;
                section(
                    "Last scans",
                    "SELECT source_id, datetime(started_ms / 1000, 'unixepoch', 'localtime'), status, discovered, added, missing, errors
                     FROM scan_runs ORDER BY started_ms DESC LIMIT 12",
                )?;
                section("Posts", "SELECT status, COUNT(*) FROM posts GROUP BY 1")?;
                section("Looks", "SELECT COUNT(*) FROM looks")?;
                section("Settings", "SELECT key, value FROM settings ORDER BY key")?;
                Ok(out)
            })
            .map_err(text)?;
        std::fs::write(folder.join("library.txt"), stats).map_err(|e| e.to_string())?;
        let _ = std::process::Command::new("/usr/bin/open").arg("-R").arg(&folder).status();
        Ok(folder.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ------------------------------------------------------------------ settings

#[tauri::command]
pub async fn get_setting(state: State<'_, AppState>, key: String) -> Reply<Option<String>> {
    settings::get(&state.db, &key).map_err(text)
}

/// A line from the UI into the app's log (test builds time the first frame of a clip with it).
#[tauri::command]
pub async fn ui_log(text: String) -> Reply<()> {
    let text: String = text.chars().take(300).collect();
    crate::applog::line(&format!("ui: {text}"));
    Ok(())
}

#[tauri::command]
pub async fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Reply<()> {
    settings::set(&state.db, &key, &value).map_err(text)
}

// ------------------------------------------------------------------ image protocol

/// `cba://localhost/<kind>/<id>`: `thumb` and `preview` (photo JPEGs), `full`
/// (a 2560 px JPEG for exports) and `lut` (a look's 33³ RGBA table). The web
/// view never gets file paths; it asks for an id and this decides what to send.
pub fn protocol<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    let path = request.uri().path().to_owned();
    let range = request.headers().get("range").and_then(|v| v.to_str().ok()).map(str::to_owned);
    tauri::async_runtime::spawn_blocking(move || {
        let p = path.trim_start_matches('/');
        let response = if let Some(id) = p.strip_prefix("video/") {
            serve_video(&app, id, range.as_deref(), false)
        } else if let Some(id) = p.strip_prefix("editvideo/") {
            serve_video(&app, id, range.as_deref(), true)
        } else if let Some(id) = p.strip_prefix("fullvideo/") {
            // The original itself, never a copy: full-size stills.
            serve_original_video(&app, id, range.as_deref())
        } else {
            serve(&app, &path)
        };
        // WebKit may cancel the request meanwhile (a seek in a video, the next
        // clip, a tile scrolled away). It does so on the main thread, so the
        // answer goes there too: wry then sees the cancelled request and drops
        // the answer. Answering from this thread raced the cancel, and the
        // Objective-C exception that followed could not be caught: it crossed
        // a frame that can't unwind and aborted the app (twice on 16 Nov).
        #[cfg(target_os = "macos")]
        {
            let main = app.clone();
            if let Err(e) = main.run_on_main_thread(move || {
                let answered = objc2::exception::catch(std::panic::AssertUnwindSafe(|| responder.respond(response)));
                if let Err(e) = answered {
                    crate::applog::line(&format!("protocol: WebKit refused the answer to {path}: {e:?}"));
                }
            }) {
                crate::applog::line(&format!("protocol: no main thread to answer on: {e}"));
            }
        }
        #[cfg(not(target_os = "macos"))]
        responder.respond(response)
    });
}

/// Largest piece of a video sent per request. The player asks for the next
/// piece as it plays, so an online video streams instead of downloading first.
const VIDEO_CHUNK: u64 = 4 << 20;

/// `cba://localhost/video/<id>`: the video file in pieces (HTTP Range).
fn serve_video<R: Runtime>(app: &AppHandle<R>, id: &str, range: Option<&str>, for_editing: bool) -> Response<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let state = app.state::<AppState>();
    if !thumbs::is_photo_id(id) {
        return status(StatusCode::BAD_REQUEST);
    }
    // For the editor: its smooth copy, in the video's own colour (never the
    // review copy, whose S-Log3 is already converted). Otherwise the review
    // copy when there is one: light, local, and already in normal colour.
    let copy = if for_editing { review::edit_existing(state.cache.root(), id) } else { review::existing(state.cache.root(), id) };
    // Played now: the review copies' cap drops it last.
    if let (Some(c), false, None | Some("bytes=0-")) = (&copy, for_editing, range) {
        review::touch(c);
    }
    // Streaming an original: background downloads hold back meanwhile.
    if copy.is_none() {
        crate::library::lane::playing();
    }
    let path = match copy {
        Some(copy) => copy,
        None => match thumbs::video_file(&state.db, id) {
            Ok((path, _)) => path,
            Err(_) => return status(StatusCode::NOT_FOUND),
        },
    };
    let Ok(mut file) = std::fs::File::open(&path) else { return status(StatusCode::NOT_FOUND) };
    let Ok(total) = file.metadata().map(|m| m.len()) else { return status(StatusCode::NOT_FOUND) };
    let (start, end) = parse_range(range, total);
    if total == 0 || start >= total || end < start {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header("Content-Range", format!("bytes */{total}"))
            .body(Vec::new())
            .expect("static response");
    }
    let end = end.min(start + VIDEO_CHUNK - 1).min(total - 1);
    let mut bytes = vec![0; (end - start + 1) as usize];
    if file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut bytes)).is_err() {
        return status(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let mime = match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("mov") => "video/quicktime",
        _ => "video/mp4",
    };
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes")
        .header("Content-Range", format!("bytes {start}-{end}/{total}"))
        .header("Content-Length", bytes.len().to_string())
        // The same address can switch from the original to its review copy.
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", "*")
        .body(bytes)
        .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR))
}

/// `cba://localhost/fullvideo/<id>`: the original file, never a review or edit copy.
fn serve_original_video<R: Runtime>(app: &AppHandle<R>, id: &str, range: Option<&str>) -> Response<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let state = app.state::<AppState>();
    if !thumbs::is_photo_id(id) {
        return status(StatusCode::BAD_REQUEST);
    }
    let Ok((path, _)) = thumbs::video_file(&state.db, id) else { return status(StatusCode::NOT_FOUND) };
    crate::library::lane::playing();
    let Ok(mut file) = std::fs::File::open(&path) else { return status(StatusCode::NOT_FOUND) };
    let Ok(total) = file.metadata().map(|m| m.len()) else { return status(StatusCode::NOT_FOUND) };
    let (start, end) = parse_range(range, total);
    if total == 0 || start >= total || end < start {
        return Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE).header("Content-Range", format!("bytes */{total}")).body(Vec::new()).expect("static response");
    }
    let end = end.min(start + VIDEO_CHUNK - 1).min(total - 1);
    let mut bytes = vec![0; (end - start + 1) as usize];
    if file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut bytes)).is_err() {
        return status(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let mime = if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("mov")) { "video/quicktime" } else { "video/mp4" };
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes")
        .header("Content-Range", format!("bytes {start}-{end}/{total}"))
        .header("Content-Length", bytes.len().to_string())
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", "*")
        .body(bytes)
        .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR))
}

/// `bytes=a-b`, `bytes=a-` or `bytes=-n` (the last n bytes); no header means from the start.
fn parse_range(header: Option<&str>, total: u64) -> (u64, u64) {
    let last = total.saturating_sub(1);
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else { return (0, last) };
    let spec = spec.split(',').next().unwrap_or("").trim();
    let (a, b) = spec.split_once('-').unwrap_or((spec, ""));
    match (a.trim().parse::<u64>().ok(), b.trim().parse::<u64>().ok()) {
        (Some(a), Some(b)) => (a, b.min(last)),
        (Some(a), None) => (a, last),
        (None, Some(n)) => (total.saturating_sub(n), last),
        (None, None) => (0, last),
    }
}

fn serve<R: Runtime>(app: &AppHandle<R>, path: &str) -> Response<Vec<u8>> {
    let state = app.state::<AppState>();
    let mut parts = path.trim_start_matches('/').splitn(2, '/');
    let (kind, id) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    // `cba://localhost/studio/<save-id>.jpg`: a saved inspiration's picture.
    // `cba://localhost/site/media/…`: a web copy from the portfolio site (Archive tab).
    if kind == "site" {
        let Some(file) = crate::archive_cmd::site_file(&state.db, id) else { return status(StatusCode::BAD_REQUEST) };
        let mime = match file.extension().and_then(|e| e.to_str()) {
            Some("avif") => "image/avif",
            Some("mp4") => "video/mp4",
            Some("svg") => "image/svg+xml",
            Some("png") => "image/png",
            Some("webp") => "image/webp",
            _ => "image/jpeg",
        };
        return match std::fs::read(&file) {
            Ok(bytes) => Response::builder()
                .header("Content-Type", mime)
                .header("Cache-Control", "no-cache")
                .header("Access-Control-Allow-Origin", "*")
                .body(bytes)
                .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR)),
            Err(_) => status(StatusCode::NOT_FOUND),
        };
    }
    if kind == "studio" {
        let ok = id.len() < 80 && id.ends_with(".jpg") && id.trim_end_matches(".jpg").chars().all(|c| c.is_ascii_hexdigit() || c == '-');
        if !ok {
            return status(StatusCode::BAD_REQUEST);
        }
        return match std::fs::read(crate::library::studio::thumbs_dir(state.cache.root()).join(id)) {
            Ok(bytes) => Response::builder()
                .header("Content-Type", "image/jpeg")
                .header("Cache-Control", "max-age=600")
                .header("Access-Control-Allow-Origin", "*")
                .body(bytes)
                .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR)),
            Err(_) => status(StatusCode::NOT_FOUND),
        };
    }
    if !thumbs::is_photo_id(id) {
        return status(StatusCode::BAD_REQUEST);
    }
    let (file, mime) = match kind {
        "thumb" => (state.cache.thumb(id), "image/jpeg"),
        // No preview possible (e.g. the original is iCloud-only)? The thumbnail beats nothing.
        "preview" => (thumbs::preview(&state.db, &state.cache, id).unwrap_or_else(|_| state.cache.thumb(id)), "image/jpeg"),
        "full" => match thumbs::export_source(&state.db, &state.cache, id, EXPORT_SOURCE_PX) {
            Ok(f) => (f, "image/jpeg"),
            Err(_) => (thumbs::preview(&state.db, &state.cache, id).unwrap_or_else(|_| state.cache.thumb(id)), "image/jpeg"),
        },
        // Full resolution, for "Render full size". An error, never a smaller stand-in:
        // the page must not pretend a thumbnail is the full photo.
        "original" => match thumbs::original(&state.db, &state.cache, id) {
            Ok(f) => {
                let mime = match f.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
                    Some("png") => "image/png",
                    Some("heic") | Some("heif") => "image/heic",
                    Some("webp") => "image/webp",
                    _ => "image/jpeg",
                };
                (f, mime)
            }
            Err(_) => return status(StatusCode::NOT_FOUND),
        },
        "lut" => match looks::bake(&state.db, &state.looks_dir, id) {
            Ok(f) => (f, "application/octet-stream"),
            Err(_) => return status(StatusCode::NOT_FOUND),
        },
        _ => return status(StatusCode::NOT_FOUND),
    };
    // A tile whose file is gone (the database still says ready): made again.
    if matches!(kind, "thumb" | "preview") && !file.is_file() {
        crate::library::heal::ask(id);
    }
    match std::fs::read(&file) {
        // CORS: WebGL may only read cross-origin pixels the server allows.
        Ok(bytes) => Response::builder()
            .header("Content-Type", mime)
            .header("Cache-Control", "max-age=3600")
            .header("Access-Control-Allow-Origin", "*")
            .body(bytes)
            .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR)),
        Err(_) => status(StatusCode::NOT_FOUND),
    }
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(code).header("Access-Control-Allow-Origin", "*").body(Vec::new()).expect("static response")
}

#[cfg(test)]
mod range_tests {
    use super::parse_range;

    #[test]
    fn ranges() {
        assert_eq!(parse_range(None, 100), (0, 99));
        assert_eq!(parse_range(Some("bytes=0-1"), 100), (0, 1));
        assert_eq!(parse_range(Some("bytes=50-"), 100), (50, 99));
        assert_eq!(parse_range(Some("bytes=-10"), 100), (90, 99));
        assert_eq!(parse_range(Some("bytes=90-500"), 100), (90, 99));
    }
}


// ------------------------------------------------------------------ review copies

/// Makes sure a video has its smooth copy for the editor (see
/// `review::make_edit_copy`); progress comes as `edit-copy-progress` events.
#[tauri::command]
pub async fn edit_copy(app: AppHandle, photo_id: String) -> Reply<()> {
    blocking(move || {
        let state = app.state::<AppState>();
        let id = photo_id.clone();
        review::make_edit_copy(&state.db, state.cache.root(), &review_helper(&app), &photo_id, |f| {
            let _ = app.emit("edit-copy-progress", serde_json::json!({ "photoId": id, "fraction": f }));
        })
        .map(|_| ())
    })
    .await
}

static REVIEW_BUSY: AtomicBool = AtomicBool::new(false);
static REVIEW_CANCEL: AtomicBool = AtomicBool::new(false);
/// Andy pressed Stop: the keeper leaves previews alone until he starts them again
/// (or the app is opened again).
static REVIEW_USER_STOPPED: AtomicBool = AtomicBool::new(false);

/// Starts the background run of previews when there's work for it and nothing
/// runs: not after Stop, not with Settings › Previews off.
fn keep_previews_going(app: &AppHandle) {
    if REVIEW_USER_STOPPED.load(Ordering::SeqCst) || REVIEW_BUSY.load(Ordering::SeqCst) {
        return;
    }
    let state = app.state::<AppState>();
    let off = settings::get(&state.db, "review.auto").ok().flatten().is_some_and(|v| v.trim_matches('"') == "false");
    if off {
        return;
    }
    let waiting = review::startable(&state.db, state.cache.root());
    if waiting > 0 && !REVIEW_BUSY.swap(true, Ordering::SeqCst) {
        REVIEW_CANCEL.store(false, Ordering::SeqCst);
        crate::applog::line(&format!("previews: {waiting} clips waiting, making them in the background"));
        start_review_maker(app.clone(), review::Scope::Kept);
    }
}

fn review_helper<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .resolve("helpers/review", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.is_file())
        .unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/helpers/review").into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCopies {
    ready: usize,
    bytes: u64,
    waiting: usize,
    /// Of `waiting`, how much has to come down from the cloud first.
    waiting_online_bytes: u64,
    running: bool,
    cap_bytes: u64,
    /// The last measured download speed from Google Drive (bytes/s), if any.
    speed: Option<f64>,
}

#[tauri::command]
pub async fn review_copies(state: State<'_, AppState>) -> Reply<ReviewCopies> {
    let (ready, bytes) = review::space(state.cache.root());
    let todo = review::todo(&state.db, state.cache.root(), &review::Scope::Kept).map_err(text)?;
    Ok(ReviewCopies {
        ready,
        bytes,
        waiting: todo.len(),
        waiting_online_bytes: todo.iter().filter(|t| t.online).map(|t| t.size).sum(),
        running: REVIEW_BUSY.load(Ordering::Relaxed),
        cap_bytes: review::cap_bytes(&state.db),
        speed: review::speed(&state.db),
    })
}

/// Makes review copies in the background ("review-progress" events, and
/// "review-copy-ready" with a clip's id as each lands): of `photo_ids` when
/// given (Prepare culling), else of every clip that isn't rejected.
/// Stop with `stop_review_copies`. Already running: the new clips are asked
/// for first instead.
#[tauri::command]
pub async fn make_review_copies(app: AppHandle, photo_ids: Option<Vec<String>>) -> Reply<()> {
    let scope = match photo_ids {
        Some(ids) => review::Scope::Only(ids),
        None => review::Scope::Kept,
    };
    REVIEW_USER_STOPPED.store(false, Ordering::SeqCst);
    if REVIEW_BUSY.swap(true, Ordering::SeqCst) {
        if let review::Scope::Only(ids) = &scope {
            review::prepare(ids);
        }
        return Ok(());
    }
    REVIEW_CANCEL.store(false, Ordering::SeqCst);
    start_review_maker(app, scope);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparePlan {
    /// Clips in the set without a light preview yet.
    clips: usize,
    /// Of those, the ones only online, and what making theirs downloads.
    online: usize,
    online_bytes: u64,
    speed: Option<f64>,
    free: u64,
    /// The clips to prepare, in culling order.
    ids: Vec<String>,
}

/// What preparing a cull takes: the clips in `photo_ids` that have no
/// preview yet, and how much has to come down from the cloud to make them.
#[tauri::command]
pub async fn prepare_cull_plan(state: State<'_, AppState>, photo_ids: Vec<String>) -> Reply<PreparePlan> {
    let db = state.db.clone();
    let root = state.cache.root().to_path_buf();
    let missing = tauri::async_runtime::spawn_blocking(move || {
        let mut m = review::missing(&db, &root, &photo_ids)?;
        // In the order the cull will reach them.
        let at: std::collections::HashMap<&str, usize> = photo_ids.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
        m.sort_by_key(|t| at.get(t.id.as_str()).copied().unwrap_or(usize::MAX));
        Ok::<_, crate::library::Error>(m)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(text)?;
    let online: Vec<&review::Todo> = missing.iter().filter(|t| t.online).collect();
    Ok(PreparePlan {
        clips: missing.len(),
        online: online.len(),
        online_bytes: online.iter().map(|t| t.size).sum(),
        speed: review::speed(&state.db),
        free: thumbs::free_bytes(state.cache.root()),
        ids: missing.iter().map(|t| t.id.clone()).collect(),
    })
}

/// A clip opened without a preview: its review copy is made first.
#[tauri::command]
pub async fn want_preview(app: AppHandle, photo_id: String) -> Reply<()> {
    if !thumbs::is_photo_id(&photo_id) {
        return Err("not a photo id".into());
    }
    review::want(&photo_id);
    if !REVIEW_BUSY.swap(true, Ordering::SeqCst) {
        REVIEW_CANCEL.store(false, Ordering::SeqCst);
        start_review_maker(app, review::Scope::Only(Vec::new()));
    }
    Ok(())
}

/// Whether a clip has its light preview on this Mac.
#[tauri::command]
pub async fn review_copy_exists(state: State<'_, AppState>, photo_id: String) -> Reply<bool> {
    Ok(thumbs::is_photo_id(&photo_id) && review::existing(state.cache.root(), &photo_id).is_some())
}

/// The clip left the screen before its preview came: it goes back in line.
#[tauri::command]
pub async fn unwant_preview(photo_id: String) -> Reply<()> {
    review::unwant(&photo_id);
    Ok(())
}

fn start_review_maker(app: AppHandle, scope: review::Scope) {
    let helper = review_helper(&app);
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let (mut last, mut last_failed) = (String::new(), String::new());
        let result = review::run(&state.db, state.cache.root(), &helper, &scope, &REVIEW_CANCEL, |p| {
            let _ = app.emit("review-progress", p);
            if !p.last_ready.is_empty() && p.last_ready != last {
                last = p.last_ready.clone();
                let _ = app.emit("review-copy-ready", &last);
                // A clip whose tile was still blurred gets it from its new preview.
                if !state.cache.thumb(&last).is_file() {
                    crate::library::heal::ask(&last);
                }
            }
            if !p.last_failed.is_empty() && p.last_failed != last_failed {
                last_failed = p.last_failed.clone();
                let _ = app.emit("review-copy-failed", &last_failed);
            }
        });
        if let Err(e) = result {
            crate::applog::line(&format!("review copies stopped: {e}"));
        }
        REVIEW_BUSY.store(false, Ordering::SeqCst);
        let _ = app.emit("review-progress-end", ());
        // A run for clips asked for on screen took the slot: the background
        // run goes on straight after it (12 Nov: it never started that night).
        if matches!(scope, review::Scope::Only(_)) {
            keep_previews_going(&app);
        }
    });
}

#[tauri::command]
pub async fn stop_review_copies() -> Reply<()> {
    REVIEW_USER_STOPPED.store(true, Ordering::SeqCst);
    REVIEW_CANCEL.store(true, Ordering::SeqCst);
    Ok(())
}


/// Which of these videos play straight from this Mac: a review copy, or the
/// original downloaded (not an online-only placeholder). Only looks, never fetches.
#[tauri::command]
pub async fn videos_ready(state: State<'_, AppState>, photo_ids: Vec<String>) -> Reply<Vec<String>> {
    let mut ready = Vec::new();
    for id in photo_ids {
        if review::existing(state.cache.root(), &id).is_some() {
            ready.push(id);
            continue;
        }
        if let Ok((path, _)) = thumbs::video_file(&state.db, &id) {
            let local = std::fs::symlink_metadata(&path).is_ok_and(|m| !crate::library::scan::is_dataless(&m));
            if local {
                ready.push(id);
            }
        }
    }
    Ok(ready)
}

// ------------------------------------------------------------------ Download / Remove download

static DOWNLOAD_BUSY: AtomicBool = AtomicBool::new(false);
/// The running download's last progress, for a Download window opened again.
static DOWNLOAD_NOW: Mutex<Option<crate::library::download::Progress>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStatus {
    running: bool,
    progress: Option<crate::library::download::Progress>,
}

/// Whether a download is running, and how far it is.
#[tauri::command]
pub async fn download_status() -> Reply<DownloadStatus> {
    Ok(DownloadStatus { running: DOWNLOAD_BUSY.load(Ordering::Relaxed), progress: DOWNLOAD_NOW.lock().unwrap_or_else(|e| e.into_inner()).clone() })
}
static DOWNLOAD_CANCEL: AtomicBool = AtomicBool::new(false);

/// What downloading (and removing the download of) these photos' online
/// originals involves: counts, sizes, free space after, and whether it's allowed.
#[tauri::command]
pub async fn download_plan(state: State<'_, AppState>, photo_ids: Vec<String>) -> Reply<crate::library::download::Plan> {
    let free = thumbs::free_bytes(state.cache.root());
    crate::library::download::plan(&state.db, &photo_ids, free).map_err(text)
}

/// Downloads the online originals in the background ("download-progress",
/// then "download-done" with the outcome). Refused when it would leave less
/// than 10 GB free.
#[tauri::command]
pub async fn download_originals(app: AppHandle, state: State<'_, AppState>, photo_ids: Vec<String>) -> Reply<()> {
    let plan = crate::library::download::plan(&state.db, &photo_ids, thumbs::free_bytes(state.cache.root())).map_err(text)?;
    if !plan.allowed {
        return Err(format!(
            "Not enough space: this needs {:.1} GB and would leave {:.1} GB free. Keep at least {} GB free.",
            plan.online_bytes as f64 / 1e9,
            plan.free_after as f64 / 1e9,
            plan.keep_free / 1_000_000_000
        ));
    }
    if DOWNLOAD_BUSY.swap(true, Ordering::SeqCst) {
        return Err("A download is already running".into());
    }
    DOWNLOAD_CANCEL.store(false, Ordering::SeqCst);
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let result = crate::library::download::download(&state.db, &photo_ids, &DOWNLOAD_CANCEL, |p| {
            *DOWNLOAD_NOW.lock().unwrap_or_else(|e| e.into_inner()) = Some(p.clone());
            let _ = app.emit("download-progress", p);
        });
        DOWNLOAD_BUSY.store(false, Ordering::SeqCst);
        *DOWNLOAD_NOW.lock().unwrap_or_else(|e| e.into_inner()) = None;
        match result {
            Ok(p) => {
                let _ = app.emit("download-done", &p);
            }
            Err(e) => {
                let _ = app.emit("download-done", crate::library::download::Progress { note: e.to_string(), ..Default::default() });
            }
        }
        let _ = app.emit("library-changed", "download");
    });
    Ok(())
}

#[tauri::command]
pub async fn stop_download() -> Reply<()> {
    DOWNLOAD_CANCEL.store(true, Ordering::SeqCst);
    Ok(())
}

/// Sets downloaded originals back to online-only (they stay on Drive).
/// Returns how many went and the space freed.
#[tauri::command]
pub async fn remove_downloads(app: AppHandle, state: State<'_, AppState>, photo_ids: Vec<String>) -> Reply<(usize, u64)> {
    let db = state.db.clone();
    let r = tauri::async_runtime::spawn_blocking(move || crate::library::download::remove(&db, &photo_ids)).await.map_err(|e| e.to_string())?.map_err(text)?;
    let _ = app.emit("library-changed", "download");
    Ok(r)
}

// ------------------------------------------------------------------ Google Drive, direct

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveStatus {
    connected: bool,
    /// Connected, but Google no longer accepts the sign-in: Google's words.
    problem: Option<String>,
    /// Connected, but Google can't be reached right now (offline): not a lapse.
    offline: bool,
}

#[tauri::command]
pub async fn gdrive_status() -> Reply<DriveStatus> {
    tauri::async_runtime::spawn_blocking(|| {
        let connected = crate::library::gdrive::connected();
        let err = if connected { crate::library::gdrive::check().err().map(|e| e.to_string()) } else { None };
        // Only Google's own refusal means the sign-in lapsed; no answer at all is the line.
        let lapsed = err.as_deref().is_some_and(|e| e.contains("Google said"));
        DriveStatus { connected, offline: err.is_some() && !lapsed, problem: if lapsed { err } else { None } }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Signs in to Google again with the stored client, in the default browser.
#[tauri::command]
pub async fn gdrive_reconnect() -> Reply<()> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::library::gdrive::reconnect(|url| {
            let _ = std::process::Command::new("/usr/bin/open").arg(url).status();
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(text)
}

/// Opens Google's sign-in in the default browser and waits for it.
#[tauri::command]
pub async fn gdrive_connect(client_id: String, client_secret: String) -> Reply<()> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::library::gdrive::connect(&client_id, &client_secret, |url| {
            let _ = std::process::Command::new("/usr/bin/open").arg(url).status();
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(text)
}

#[tauri::command]
pub async fn gdrive_disconnect() -> Reply<()> {
    crate::library::gdrive::disconnect().map_err(text)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveSpeed {
    file: String,
    mb: f64,
    seconds: f64,
}

/// Downloads one online video (200 MB–1.5 GB) straight from Google and times it.
#[tauri::command]
pub async fn gdrive_speed_test(state: State<'_, AppState>) -> Reply<DriveSpeed> {
    let rows: Vec<String> = state
        .db
        .read(|c| {
            let mut stmt = c.prepare(
                "SELECT a.path FROM assets a JOIN photos p ON p.id = a.photo_id
                 WHERE p.is_video = 1 AND a.is_primary = 1 AND a.storage_state = 'cloud_only'
                   AND a.size BETWEEN 200000000 AND 1500000000 ORDER BY a.size LIMIT 20",
            )?;
            let rows = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
            Ok(rows)
        })
        .map_err(text)?;
    let path = rows
        .into_iter()
        .map(PathBuf::from)
        .find(|p| crate::library::gdrive::file_id(p).is_some())
        .ok_or("No online video with a Drive id to test with")?;
    let dir = review::dir(state.cache.root());
    let file = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_owned();
    let (bytes, seconds) = tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir)?;
        crate::library::gdrive::speed_test(&path, &dir)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(text)?;
    Ok(DriveSpeed { file, mb: bytes as f64 / 1e6, seconds })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveClient {
    client_id: String,
    client_secret: String,
    file: String,
}

/// A Google "Desktop app" client file (client_secret_….json) in Downloads,
/// newest first, so the login doesn't have to be pasted.
#[tauri::command]
pub async fn gdrive_find_client() -> Reply<Option<DriveClient>> {
    let Some(home) = std::env::var_os("HOME") else { return Ok(None) };
    let dir = Path::new(&home).join("Downloads");
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(&dir)
        .map(|it| {
            it.flatten()
                .map(|e| e.path())
                .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("client_secret") && n.ends_with(".json")))
                .filter_map(|p| Some((p.metadata().ok()?.modified().ok()?, p)))
                .collect()
        })
        .unwrap_or_default();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, p) in files {
        let Ok(v) = std::fs::read_to_string(&p).map(|t| serde_json::from_str::<serde_json::Value>(&t).unwrap_or_default()) else { continue };
        let c = &v["installed"];
        if let (Some(id), Some(secret)) = (c["client_id"].as_str(), c["client_secret"].as_str()) {
            let file = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_owned();
            return Ok(Some(DriveClient { client_id: id.into(), client_secret: secret.into(), file }));
        }
    }
    Ok(None)
}
