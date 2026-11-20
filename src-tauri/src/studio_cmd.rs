//! Studio's commands: the thin layer between the page and `library::studio`,
//! plus the background work Studio needs (on-device analysis of saves, links
//! handed over by the browser's "Save to Studio" button).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::app::{text, AppState};
use crate::library::studio::{self, Row};
use crate::library::{now_ms, Error};

type Reply<T> = Result<T, String>;

fn changed<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit("studio-changed", ());
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Reply<T> + Send + 'static) -> Reply<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn studio_list(state: State<'_, AppState>, list: String, filter: Option<Row>) -> Reply<Vec<Row>> {
    studio::list(&state.db, &list, &filter.unwrap_or_default()).map_err(text)
}

#[tauri::command]
pub async fn studio_get(state: State<'_, AppState>, list: String, id: String) -> Reply<Option<Row>> {
    studio::get(&state.db, &list, &id).map_err(text)
}

#[tauri::command]
pub async fn studio_save(app: AppHandle, state: State<'_, AppState>, list: String, id: Option<String>, values: Row) -> Reply<Row> {
    let row = studio::save(&state.db, &list, id.as_deref(), &values).map_err(text)?;
    changed(&app);
    if list == "saves" && values.get("analysedMs").is_some_and(Value::is_null) {
        kick_analysis(&app);
    }
    Ok(row)
}

#[tauri::command]
pub async fn studio_delete(app: AppHandle, state: State<'_, AppState>, list: String, id: String, source: Option<String>) -> Reply<()> {
    studio::delete(&state.db, &list, &id, source.as_deref().unwrap_or("menu")).map_err(text)?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn studio_link(app: AppHandle, state: State<'_, AppState>, kind: String, a: String, b: String, on: bool) -> Reply<()> {
    studio::link(&state.db, &kind, &a, &b, on).map_err(text)?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn studio_linked(state: State<'_, AppState>, kind: String, side: String, id: String) -> Reply<Vec<String>> {
    studio::linked(&state.db, &kind, &side, &id).map_err(text)
}

/// The Studio folder, made if it isn't there yet.
#[tauri::command]
pub async fn studio_root(state: State<'_, AppState>) -> Reply<String> {
    Ok(studio::ensure_root(&state.db).map_err(text)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn studio_summary(state: State<'_, AppState>) -> Reply<studio::Summary> {
    studio::summary(&state.db).map_err(text)
}

#[tauri::command]
pub async fn studio_greenlight(app: AppHandle, state: State<'_, AppState>, idea_id: String, family_id: Option<String>) -> Reply<Row> {
    let row = studio::greenlight(&state.db, &idea_id, family_id.as_deref()).map_err(text)?;
    changed(&app);
    Ok(row)
}

/// The piece's folder (made, or found again after a move in Finder).
#[tauri::command]
pub async fn studio_piece_folder(state: State<'_, AppState>, id: String) -> Reply<String> {
    Ok(studio::ensure_piece_folder(&state.db, &id).map_err(text)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn studio_family_folder(state: State<'_, AppState>, id: String) -> Reply<String> {
    Ok(studio::family_dir(&state.db, &id).map_err(text)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn studio_set_stage(app: AppHandle, state: State<'_, AppState>, id: String, stage: String) -> Reply<Row> {
    let row = studio::set_stage(&state.db, &id, &stage).map_err(text)?;
    changed(&app);
    Ok(row)
}

#[tauri::command]
pub async fn studio_park_stale(app: AppHandle, state: State<'_, AppState>, days: i64) -> Reply<usize> {
    let n = studio::park_stale(&state.db, days).map_err(text)?;
    if n > 0 {
        changed(&app);
    }
    Ok(n)
}

#[tauri::command]
pub async fn studio_add_link(app: AppHandle, url: String, via: Option<String>) -> Reply<Row> {
    let a = app.clone();
    let row = blocking(move || {
        let state = a.state::<AppState>();
        studio::add_link(&state.db, state.cache.root(), &url, via.as_deref().unwrap_or("paste"), false).map_err(text)
    })
    .await?;
    changed(&app);
    kick_analysis(&app);
    Ok(row)
}

#[tauri::command]
pub async fn studio_add_paths(app: AppHandle, paths: Vec<String>) -> Reply<Vec<Row>> {
    let a = app.clone();
    let rows = blocking(move || {
        let state = a.state::<AppState>();
        let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
        studio::add_paths(&state.db, state.cache.root(), &paths, "picked", false).map_err(text)
    })
    .await?;
    changed(&app);
    kick_analysis(&app);
    Ok(rows)
}

/// A file dropped on Inspire, sent as raw bytes; its name in the `x-name` header.
#[tauri::command]
pub async fn studio_add_bytes(app: AppHandle, request: tauri::ipc::Request<'_>) -> Reply<Row> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Nothing arrived.".into()) };
    // The name travels as base64 UTF-8 (headers are ASCII), like other uploads.
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let name = header("x-name-b64")
        .and_then(|b| base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b).ok())
        .and_then(|b| String::from_utf8(b).ok())
        .or_else(|| header("x-name").map(|n| decode(&n)))
        .unwrap_or_else(|| "dropped.png".into());
    let bytes = bytes.clone();
    let a = app.clone();
    let row = blocking(move || {
        let state = a.state::<AppState>();
        studio::add_bytes(&state.db, state.cache.root(), &name, &bytes).map_err(text)
    })
    .await?;
    changed(&app);
    kick_analysis(&app);
    Ok(row)
}

fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 3 <= bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What landed in the drop folder since last time.
/// The knowledge notes into Inspire (see `studio::import_knowledge`); the
/// pictures of new ones are fetched afterwards, in the background.
#[tauri::command]
pub async fn studio_import_knowledge(app: AppHandle) -> Reply<studio::KnowledgeReport> {
    let a = app.clone();
    let r = blocking(move || {
        let state = a.state::<AppState>();
        studio::import_knowledge(&state.db, state.cache.root(), &studio::knowledge_dir()).map_err(text)
    })
    .await?;
    if r.added + r.updated > 0 {
        changed(&app);
    }
    if !r.new_ids.is_empty() {
        let (a, ids) = (app.clone(), r.new_ids.clone());
        std::thread::spawn(move || {
            let state = a.state::<AppState>();
            for id in ids {
                let _ = studio::refresh_preview(&state.db, state.cache.root(), &id);
            }
            changed(&a);
        });
    }
    Ok(r)
}

#[tauri::command]
pub async fn studio_ingest(app: AppHandle) -> Reply<Vec<Row>> {
    let a = app.clone();
    let rows = blocking(move || {
        let state = a.state::<AppState>();
        studio::ingest_drop(&state.db, state.cache.root()).map_err(text)
    })
    .await?;
    if !rows.is_empty() {
        changed(&app);
        kick_analysis(&app);
    }
    Ok(rows)
}

#[tauri::command]
pub async fn studio_refresh_preview(app: AppHandle, id: String) -> Reply<Row> {
    let a = app.clone();
    let row = blocking(move || {
        let state = a.state::<AppState>();
        studio::refresh_preview(&state.db, state.cache.root(), &id).map_err(text)
    })
    .await?;
    changed(&app);
    Ok(row)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    added: usize,
    already: usize,
}

#[tauri::command]
pub async fn studio_import(app: AppHandle, path: String) -> Reply<Imported> {
    let a = app.clone();
    let (added, already) = blocking(move || {
        let state = a.state::<AppState>();
        studio::import_export(&state.db, state.cache.root(), Path::new(&path)).map_err(text)
    })
    .await?;
    changed(&app);
    kick_analysis(&app);
    Ok(Imported { added, already })
}

#[tauri::command]
pub async fn studio_trends(geo: Option<String>) -> Reply<Vec<studio::Trend>> {
    blocking(move || studio::trends(geo.as_deref().unwrap_or("BE")).map_err(text)).await
}

#[tauri::command]
pub async fn studio_youtube(app: AppHandle, words: String) -> Reply<Vec<studio::Found>> {
    blocking(move || {
        let state = app.state::<AppState>();
        studio::youtube_search(&state.db, &words).map_err(text)
    })
    .await
}

#[tauri::command]
pub async fn studio_watch_check(app: AppHandle, id: String) -> Reply<Row> {
    let a = app.clone();
    let row = blocking(move || {
        let state = a.state::<AppState>();
        studio::watch_check(&state.db, &id).map_err(text)
    })
    .await?;
    changed(&app);
    Ok(row)
}

#[tauri::command]
pub async fn studio_similar(state: State<'_, AppState>, id: String) -> Reply<studio::Similar> {
    studio::similar(&state.db, &id).map_err(text)
}

#[tauri::command]
pub async fn studio_write_plan(state: State<'_, AppState>, piece_id: Option<String>, name: String, contents: String) -> Reply<String> {
    Ok(studio::write_plan_file(&state.db, piece_id.as_deref(), &name, &contents).map_err(text)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn studio_mark_posted(app: AppHandle, state: State<'_, AppState>, id: String, platform: String, url: String, file: Option<String>) -> Reply<Row> {
    let row = studio::mark_posted(&state.db, &id, &platform, &url, file.as_deref()).map_err(text)?;
    changed(&app);
    Ok(row)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCheck {
    path: String,
    seconds: f64,
    width: i64,
    height: i64,
    megabytes: f64,
    /// Plain-words remarks, one per problem; empty when it's fine everywhere.
    notes: Vec<String>,
}

/// Is this export right for Reels and TikTok? Size, shape and length.
#[tauri::command]
pub async fn studio_check_export(app: AppHandle, path: String) -> Reply<ExportCheck> {
    blocking(move || {
        let state = app.state::<AppState>();
        let p = PathBuf::from(&path);
        let meta = std::fs::metadata(&p).map_err(|_| "That file isn't there anymore.".to_string())?;
        let megabytes = meta.len() as f64 / 1_048_576.0;
        let tmp = studio::thumbs_dir(state.cache.root()).join(format!("check-{}.jpg", now_ms()));
        let info = crate::library::media::video_frame(&p, &tmp, 320).map_err(text)?;
        let _ = std::fs::remove_file(&tmp);
        let (w, h, s) = (info.width, info.height, info.seconds);
        let mut notes = Vec::new();
        if w == 0 || h == 0 {
            notes.push("Couldn't read the video's size.".to_string());
        } else {
            let ratio = w as f64 / h as f64;
            if (ratio - 9.0 / 16.0).abs() > 0.02 {
                notes.push(format!("It's {w}×{h}, not 9:16. Reels and TikTok fill the screen with 1080×1920."));
            }
            if w.min(h) < 720 {
                notes.push(format!("Only {}p: both apps want at least 720p, 1080p is best.", w.min(h)));
            }
        }
        if s < 3.0 {
            notes.push("Shorter than 3 seconds: Instagram won't take it as a Reel.".into());
        }
        if s > 180.0 {
            notes.push("Longer than 3 minutes: Instagram shows Reels up to 3 minutes to people who don't follow you.".into());
        }
        if s > 600.0 {
            notes.push("Longer than 10 minutes: too long for a TikTok upload from the app.".into());
        }
        if megabytes > 4000.0 {
            notes.push("Over 4 GB: too big to upload from your phone.".into());
        }
        Ok(ExportCheck { path, seconds: s, width: w, height: h, megabytes, notes })
    })
    .await
}

/// Shows the piece's folder in Finder and opens CapCut next to it.
#[tauri::command]
pub async fn studio_open_capcut(state: State<'_, AppState>, id: String) -> Reply<()> {
    let dir = studio::ensure_piece_folder(&state.db, &id).map_err(text)?;
    let footage = dir.join("01_FOOTAGE");
    let target = if footage.is_dir() { footage } else { dir };
    std::process::Command::new("/usr/bin/open").arg(&target).status().map_err(|e| e.to_string())?;
    let ok = std::process::Command::new("/usr/bin/open").args(["-a", "CapCut"]).status().map(|s| s.success()).unwrap_or(false);
    if !ok {
        return Err("CapCut isn't installed in Applications. The piece's folder is open in Finder.".into());
    }
    Ok(())
}

/// Opens a Studio folder in Finder (only folders inside the Studio folder).
#[tauri::command]
pub async fn studio_open_folder(state: State<'_, AppState>, path: String) -> Reply<()> {
    let p = Path::new(&path);
    if !p.starts_with(studio::root(&state.db)) || !p.exists() {
        return Err("That folder isn't in the Studio folder.".into());
    }
    std::process::Command::new("/usr/bin/open").arg(p).status().map_err(|e| e.to_string())?;
    Ok(())
}

// ------------------------------------------------------------------ production

fn modified_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanFile {
    path: String,
    contents: String,
    modified_ms: i64,
}

/// A file in a piece's 00_PLAN folder (the mirror of `studio_write_plan`);
/// None when it isn't there yet.
#[tauri::command]
pub async fn studio_read_plan(state: State<'_, AppState>, piece_id: String, name: String) -> Reply<Option<PlanFile>> {
    let dir = studio::ensure_piece_folder(&state.db, &piece_id).map_err(text)?.join("00_PLAN");
    let safe: String = name.chars().map(|c| if c == '/' || c == ':' { '-' } else { c }).collect();
    let path = dir.join(safe);
    match std::fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(PlanFile { path: path.to_string_lossy().into_owned(), contents, modified_ms: modified_ms(&path) })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PieceFile {
    path: String,
    name: String,
    /// The folder it's in, relative to the piece's folder ("02_AUDIO"); "" at the top.
    folder: String,
    size: u64,
    modified_ms: i64,
}

/// Bundles shown as one file and never opened up (Final Cut's).
fn is_bundle(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".fcpxmld") || lower.ends_with(".fcpbundle")
}

/// The files in a piece's folder, three levels deep, newest first.
#[tauri::command]
pub async fn studio_piece_files(state: State<'_, AppState>, id: String) -> Reply<Vec<PieceFile>> {
    let dir = studio::ensure_piece_folder(&state.db, &id).map_err(text)?;
    blocking(move || {
        let mut out = Vec::new();
        let walker = walkdir::WalkDir::new(&dir).min_depth(1).max_depth(3).into_iter().filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            // Never into a bundle's insides or hidden folders.
            !name.starts_with('.') && (e.depth() <= 1 || !e.path().parent().map(|p| is_bundle(&p.to_string_lossy())).unwrap_or(false))
        });
        for entry in walker.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().into_owned();
            let bundle = entry.file_type().is_dir() && is_bundle(&name);
            if !(entry.file_type().is_file() || bundle) {
                continue;
            }
            if entry.path().ancestors().skip(1).any(|a| is_bundle(&a.to_string_lossy())) {
                continue;
            }
            let folder = entry.path().parent().and_then(|p| p.strip_prefix(&dir).ok()).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
            let size = if bundle { 0 } else { entry.metadata().map(|m| m.len()).unwrap_or(0) };
            out.push(PieceFile { path: entry.path().to_string_lossy().into_owned(), name, folder, size, modified_ms: modified_ms(entry.path()) });
            if out.len() >= 2000 {
                break;
            }
        }
        out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
        Ok(out)
    })
    .await
}

/// The XML of a Final Cut project file: a .fcpxml, or the Info.fcpxml inside an .fcpxmld bundle.
#[tauri::command]
pub async fn studio_read_fcpxml(path: String) -> Reply<String> {
    blocking(move || {
        let p = PathBuf::from(&path);
        let lower = path.to_lowercase();
        let file = if lower.trim_end_matches('/').ends_with(".fcpxmld") {
            p.join("Info.fcpxml")
        } else if lower.ends_with(".fcpxml") {
            p
        } else {
            return Err("That isn't a Final Cut XML file (.fcpxml or .fcpxmld).".into());
        };
        let meta = std::fs::metadata(&file).map_err(|_| "That file isn't there anymore.".to_string())?;
        if meta.len() > 64 * 1024 * 1024 {
            return Err("That XML file is too big to read.".into());
        }
        std::fs::read_to_string(&file).map_err(|e| e.to_string())
    })
    .await
}

/// Opens a Final Cut XML file in Final Cut Pro.
#[tauri::command]
pub async fn studio_open_in_final_cut(path: String) -> Reply<()> {
    let lower = path.to_lowercase();
    let lower = lower.trim_end_matches('/');
    if !(lower.ends_with(".fcpxml") || lower.ends_with(".fcpxmld")) {
        return Err("That isn't a Final Cut XML file (.fcpxml or .fcpxmld).".into());
    }
    if !Path::new(&path).exists() {
        return Err("That file isn't there anymore.".into());
    }
    let ok = std::process::Command::new("/usr/bin/open").args(["-a", "Final Cut Pro"]).arg(&path).status().map(|s| s.success()).unwrap_or(false);
    if !ok {
        return Err("Final Cut Pro couldn't open it: is it installed in Applications?".into());
    }
    Ok(())
}

// ------------------------------------------------------------------ links from the browser

static PENDING: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// `capturedbyandy://save?url=…` from the browser button or a Shortcut.
pub fn opened<R: Runtime>(app: &AppHandle<R>, urls: Vec<tauri::Url>) {
    for u in urls {
        if u.scheme() != "capturedbyandy" {
            continue;
        }
        let link = u.query_pairs().find(|(k, _)| k == "url").map(|(_, v)| v.into_owned());
        let Some(link) = link else { continue };
        PENDING.lock().unwrap_or_else(|p| p.into_inner()).push(link.clone());
        let _ = app.emit("studio-capture", link);
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_focus();
    }
}

/// Links that arrived before the page was ready; each is handed out once.
#[tauri::command]
pub async fn studio_pending_captures() -> Reply<Vec<String>> {
    Ok(std::mem::take(&mut *PENDING.lock().unwrap_or_else(|p| p.into_inner())))
}

// ------------------------------------------------------------------ analysis

static ANALYSING: AtomicBool = AtomicBool::new(false);

/// Looks at new saves on this Mac, one at a time in the background: what's in
/// the picture, the words on a screenshot, and missing link previews.
pub fn kick_analysis<R: Runtime>(app: &AppHandle<R>) {
    if ANALYSING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let helper = crate::app::vision_helper(&app);
        let listen = listen_helper(&app);
        'analysis: loop {
            let batch = match studio::unanalysed(&state.db, 8) {
                Ok(b) if !b.is_empty() => b,
                _ => break,
            };
            for save in batch {
                let id = save.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
                if save.get("kind").and_then(Value::as_str) == Some("video") {
                    let mut patch = Row::new();
                    patch.insert("transcriptionState".into(), json!("running"));
                    patch.insert("transcriptionError".into(), json!(""));
                    let _ = studio::save(&state.db, "saves", Some(&id), &patch);
                    changed(&app);
                }
                if let Err(e) = analyse_one(&state, &helper, &listen, &id, &save) {
                    crate::applog::line(&format!("Studio analysis failed for {id}: {e}"));
                    break 'analysis;
                }
                changed(&app);
            }
        }
        ANALYSING.store(false, Ordering::SeqCst);
    });
}

/// The spoken words of a recording, from the `listen` helper's file mode.
fn transcribe(listen: &Path, file: &Path, language: &str) -> Result<(String, Value), String> {
    let out = std::process::Command::new(listen).arg("--file").arg(file).args(["--language", language])
        .stdin(std::process::Stdio::null()).output().map_err(|e| e.to_string())?;
    transcript_output(out.status.success(), &String::from_utf8_lossy(&out.stdout))
}

fn transcript_output(success: bool, output: &str) -> Result<(String, Value), String> {
    let lines: Vec<&str> = output.lines().collect();
    if !success {
        let why = lines.iter().find_map(|l| l.strip_prefix("error ").or_else(|| l.strip_prefix("denied ")))
            .unwrap_or("Speech recognition did not finish. Check macOS Speech Recognition permission and retry.");
        return Err(why.chars().take(500).collect());
    }
    let words = lines.iter().find_map(|l| l.strip_prefix("final 0")).ok_or("The listener returned no transcript")?;
    let segments = lines.iter().find_map(|l| l.strip_prefix("segments 0 "))
        .and_then(|s| serde_json::from_str::<Value>(s).ok()).filter(Value::is_array).unwrap_or_else(|| json!([]));
    Ok((words.trim().to_owned(), segments))
}

fn listen_helper<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .resolve("helpers/listen", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.is_file())
        .unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/helpers/listen").into())
}

fn analyse_one(state: &AppState, helper: &Path, listen: &Path, id: &str, save: &Row) -> Result<(), Error> {
    let str_of = |k: &str| save.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    // An imported link without a picture yet: ask the platform once.
    if str_of("kind") == "link" && str_of("thumb").is_empty() && save.get("checkedMs").map_or(true, Value::is_null) {
        let _ = studio::refresh_preview(&state.db, state.cache.root(), id);
        std::thread::sleep(std::time::Duration::from_millis(400));
    }
    let save = studio::get(&state.db, "saves", id)?.unwrap_or_default();
    let thumb = save.get("thumb").and_then(Value::as_str).map(|t| studio::thumbs_dir(state.cache.root()).join(t));
    // Words read best from the screenshot itself; a picture's labels from the small copy.
    let file = save.get("filePath").and_then(Value::as_str).map(PathBuf::from).filter(|p| studio::kind_of(p) == Some("image") && p.is_file());
    let mut patch = Row::new();
    let mut labels = String::new();
    let mut words = String::new();
    if let Some(img) = file.clone().or(thumb.clone()).filter(|p| p.is_file()) {
        if let Ok(out) = std::process::Command::new(helper).arg("--labels").arg("--text").arg(&img).output() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
                if let Some(list) = v.get("labels").and_then(Value::as_array) {
                    labels = list
                        .iter()
                        .filter_map(|pair| {
                            let name = pair.get(0)?.as_str()?;
                            let conf = pair.get(1)?.as_f64()?;
                            (conf >= 0.2).then(|| name.replace('_', " "))
                        })
                        .take(14)
                        .collect::<Vec<_>>()
                        .join(", ");
                }
                if let Some(t) = v.get("text").and_then(Value::as_str) {
                    words = t.chars().take(4000).collect();
                }
            }
        }
    }
    // File recognition is explicitly on-device. Keep existing words if a retry fails.
    if save.get("kind").and_then(Value::as_str) == Some("video") {
        let language = save.get("transcriptLanguage").and_then(Value::as_str).unwrap_or("en-US");
        let outcome = save.get("filePath").and_then(Value::as_str).map(PathBuf::from)
            .filter(|p| p.is_file()).ok_or_else(|| "The recording is not on this Mac. Reconnect its folder and retry.".to_owned())
            .and_then(|video| transcribe(listen, &video, language));
        match outcome {
            Ok((words, segments)) => {
                patch.insert("transcript".into(), json!(words));
                patch.insert("transcriptSegments".into(), json!(segments.to_string()));
                patch.insert("transcriptionState".into(), json!("complete"));
                patch.insert("transcriptionError".into(), json!(""));
            }
            Err(why) => {
                patch.insert("transcriptionState".into(), json!("failed"));
                patch.insert("transcriptionError".into(), json!(why));
            }
        }
    }
    patch.insert("autoLabels".into(), json!(labels));
    if !words.is_empty() {
        patch.insert("ocrText".into(), json!(words));
    }
    patch.insert("analysedMs".into(), json!(now_ms()));
    studio::save(&state.db, "saves", Some(id), &patch)?;
    Ok(())
}

/// At launch: analyse what's waiting, then look in the drop folder every 15 s.
pub fn startup<R: Runtime>(app: &AppHandle<R>) {
    if app.try_state::<AppState>().is_none() {
        return;
    }
    kick_analysis(app);
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(15));
        let state = app.state::<AppState>();
        // Only once the Studio folder exists: Studio makes it when first opened.
        if !studio::root(&state.db).join(studio::DROP).is_dir() {
            continue;
        }
        if let Ok(rows) = studio::ingest_drop(&state.db, state.cache.root()) {
            if !rows.is_empty() {
                changed(&app);
                kick_analysis(&app);
            }
        }
    });
}

#[cfg(test)]
mod transcript_tests {
    use super::*;
    #[test]
    fn parses_timed_and_legacy_transcripts_and_empty_speech() {
        let (words, segments) = transcript_output(true, "segments 0 [{\"start\":1,\"end\":2,\"text\":\"Hello\"}]\nfinal 0 Hello").unwrap();
        assert_eq!(words, "Hello");
        assert_eq!(segments.as_array().unwrap().len(), 1);
        assert_eq!(transcript_output(true, "final 0 ").unwrap().0, "");
        assert_eq!(transcript_output(true, "final 0 Legacy words").unwrap().1, json!([]));
    }
    #[test]
    fn failures_are_not_silently_empty_transcripts() {
        assert!(transcript_output(false, "denied speech").unwrap_err().contains("speech"));
        assert!(transcript_output(true, "ready").is_err());
    }
}
