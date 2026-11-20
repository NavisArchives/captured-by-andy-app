//! Archive: the portfolio website's projects (Andy's Archives), edited in the app.
//! The site keeps them in one file, `src/archive.json`; these commands read and write
//! it whole, write the rendered edits the site builds its web copies from, and run the
//! site's `npm run sync`. Nothing is published from here.

use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::app::AppState;
use crate::library::{db::Db, settings};

type Reply<T> = Result<T, String>;

/// Setting that points at the site's folder, for when it moves.
const SITE_DIR_KEY: &str = "archive_site_dir";

static SYNCING: AtomicBool = AtomicBool::new(false);

/// The site's folder: the setting, or where the portfolio lives next to the app.
pub fn site_dir(db: &Db) -> PathBuf {
    if let Ok(Some(dir)) = settings::get(db, SITE_DIR_KEY) {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join("Movies/OFFICE/SOCIALS/PROJECTS/portfolio")
}

fn archive_file(site: &Path) -> PathBuf {
    site.join("src/archive.json")
}

/// A fingerprint of the file's contents, so a write can tell it isn't overwriting
/// something it never saw (another window, or an edit made in the site's files).
fn version_of(bytes: &[u8]) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// A frame's key as the site uses it: lower-case letters, digits and dashes.
fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 80 && key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') && !key.starts_with('-')
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveDoc {
    json: String,
    version: String,
    site_dir: String,
    /// The site's own media list (src/media.client.json): where each frame's web copy is.
    media: String,
    /// The original file each web copy was made from, by frame key ({"file", "date"}),
    /// so frames made outside the app can be matched to their library photo.
    sources: String,
}

#[tauri::command]
pub async fn archive_read(state: State<'_, AppState>) -> Reply<ArchiveDoc> {
    let site = site_dir(&state.db);
    let file = archive_file(&site);
    let bytes = std::fs::read(&file).map_err(|e| format!("Can't read the website's projects ({}): {e}", file.display()))?;
    let media = std::fs::read_to_string(site.join("src/media.client.json")).unwrap_or_else(|_| "{}".into());
    Ok(ArchiveDoc { version: version_of(&bytes), json: String::from_utf8(bytes).map_err(|e| e.to_string())?, site_dir: site.display().to_string(), media, sources: sources_of(&site) })
}

/// Replaces archive.json when it is still the version the page read. Returns the new version.
#[tauri::command]
pub async fn archive_write(state: State<'_, AppState>, json: String, version: String) -> Reply<String> {
    let site = site_dir(&state.db);
    let file = archive_file(&site);
    let now = std::fs::read(&file).map_err(|e| e.to_string())?;
    if version_of(&now) != version {
        return Err("The website's projects changed somewhere else. Reload the Archive tab and make the change again.".into());
    }
    let doc: serde_json::Value = serde_json::from_str(&json).map_err(|e| format!("Not valid: {e}"))?;
    if !doc.get("projects").is_some_and(|p| p.is_array()) {
        return Err("Not valid: no projects".into());
    }
    let mut body = json.into_bytes();
    if body.last() != Some(&b'\n') {
        body.push(b'\n');
    }
    // Write next to it, then swap: a crash never leaves half a file.
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, &body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
    Ok(version_of(&body))
}

// ------------------------------------------------------------------ the site's pages

/// The site's pages beyond the projects (Brand work, Motion, the brand list, …):
/// `src/site.json`, read and written whole like archive.json.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteDoc {
    json: String,
    version: String,
}

#[tauri::command]
pub async fn site_read(state: State<'_, AppState>) -> Reply<SiteDoc> {
    let file = site_dir(&state.db).join("src/site.json");
    let bytes = std::fs::read(&file).map_err(|e| format!("Can't read the website's pages ({}): {e}", file.display()))?;
    Ok(SiteDoc { version: version_of(&bytes), json: String::from_utf8(bytes).map_err(|e| e.to_string())? })
}

/// Replaces site.json when it is still the version the page read. Returns the new version.
#[tauri::command]
pub async fn site_write(state: State<'_, AppState>, json: String, version: String) -> Reply<String> {
    let file = site_dir(&state.db).join("src/site.json");
    let now = std::fs::read(&file).map_err(|e| e.to_string())?;
    if version_of(&now) != version {
        return Err("The website's pages changed somewhere else. Reload and make the change again.".into());
    }
    let doc: serde_json::Value = serde_json::from_str(&json).map_err(|e| format!("Not valid: {e}"))?;
    if !doc.get("brands").is_some_and(|b| b.is_array()) {
        return Err("Not valid: no brands".into());
    }
    let mut body = json.into_bytes();
    if body.last() != Some(&b'\n') {
        body.push(b'\n');
    }
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, &body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
    Ok(version_of(&body))
}

/// Copies a logo file into the site (`public/logos/<name>.<ext>`) and returns the
/// path the site uses for it ("/logos/zeb.svg"). The original is only read.
#[tauri::command]
pub async fn site_put_logo(state: State<'_, AppState>, path: String, name: String) -> Reply<String> {
    let src = PathBuf::from(&path);
    let ext = src.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    if !matches!(ext.as_str(), "svg" | "png" | "webp") {
        return Err("A logo needs to be an SVG (best), PNG or WebP with a see-through background.".into());
    }
    let slug: String = name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>().split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    if slug.is_empty() {
        return Err("The brand needs a name first.".into());
    }
    let dir = site_dir(&state.db).join("public/logos");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::copy(&src, dir.join(format!("{slug}.{ext}"))).map_err(|e| e.to_string())?;
    Ok(format!("/logos/{slug}.{ext}"))
}

// ------------------------------------------------------------------ what the site shows

/// Which edit each frame was last sent to the site with (`library/.published.json`):
/// the photo, its edit and, for a video, its trim. Comparing it with the photo's edit
/// now tells whether the site is up to date, and Undo goes back to it.
fn published_file(db: &Db) -> PathBuf {
    site_dir(db).join("library/.published.json")
}

fn published(db: &Db) -> serde_json::Map<String, serde_json::Value> {
    std::fs::read_to_string(published_file(db)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// A photo's edit as the site would show it now.
fn edit_state(db: &Db, photo_id: &str) -> Reply<serde_json::Value> {
    let edit = crate::library::looks::for_photo(db, photo_id).map_err(|e| e.to_string())?;
    let trim = crate::library::moments::trim(db, photo_id).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "photo": photo_id, "edit": edit, "trim": trim }))
}

static PUBLISHED_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Notes that the site now shows this frame with the photo's current edit.
fn mark_published(db: &Db, key: &str, photo_id: &str) -> Reply<()> {
    let state = edit_state(db, photo_id)?;
    let _one = PUBLISHED_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut map = published(db);
    map.insert(key.to_owned(), state);
    let file = published_file(db);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::Value::Object(map).to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

#[derive(serde::Deserialize)]
pub struct FrameRef {
    key: String,
    photo: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameStatus {
    key: String,
    /// The site shows the photo's edit as it is now.
    up_to_date: bool,
    /// The photo has an edit of its own (a look, a slider, a crop or a trim).
    edited: bool,
    /// The edit the site shows (photo, edit, trim), when it was ever sent.
    published: Option<serde_json::Value>,
}

/// For each frame: does the site show its photo's current edit?
#[tauri::command]
pub async fn archive_frame_status(state: State<'_, AppState>, frames: Vec<FrameRef>) -> Reply<Vec<FrameStatus>> {
    let map = published(&state.db);
    frames
        .into_iter()
        .map(|f| {
            let now = edit_state(&state.db, &f.photo)?;
            let was = map.get(&f.key).cloned();
            let look = crate::library::looks::for_photo(&state.db, &f.photo).map_err(|e| e.to_string())?;
            let edited = look.look_id.is_some() || look.adjustments != crate::library::looks::Adjustments::default() || !now["trim"].is_null();
            Ok(FrameStatus { up_to_date: was.as_ref() == Some(&now), edited, key: f.key, published: was })
        })
        .collect()
}

/// Saves a frame's rendered edit as `<site>/library/<key>.jpg`, which `npm run sync`
/// turns into the site's web copies. Body: the JPEG bytes; header `x-key`: the frame key.
#[tauri::command]
pub async fn archive_write_image(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Reply<()> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the image bytes".into());
    };
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Err("not a JPEG".into());
    }
    let key = request.headers().get("x-key").and_then(|v| v.to_str().ok()).unwrap_or("");
    if !valid_key(key) {
        return Err(format!("not a frame key: {key}"));
    }
    let photo = request.headers().get("x-photo").and_then(|v| v.to_str().ok()).map(str::to_owned);
    let dir = site_dir(&state.db).join("library");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{key}.jpg"));
    // The same render as last time: leave the file (and its date) alone, so the site
    // doesn't rebuild a web copy that wouldn't change.
    if !std::fs::read(&file).is_ok_and(|old| old == *bytes) {
        let tmp = dir.join(format!(".{key}.jpg.tmp"));
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        drop(f);
        std::fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
    }
    match photo {
        Some(p) => mark_published(&state.db, key, &p),
        None => Ok(()),
    }
}

/// The original files behind the site's own web copies, from the lists its build
/// scripts keep (`source` is the original's path, `date` when it was taken).
fn sources_of(site: &Path) -> String {
    let mut out = serde_json::Map::new();
    for name in ["media.json", "media.extra.json", "media.more.json", "media.films.json"] {
        let Ok(text) = std::fs::read_to_string(site.join("src").join(name)) else { continue };
        let Ok(serde_json::Value::Object(list)) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        for (key, v) in list {
            let Some(source) = v.get("source").and_then(|x| x.as_str()) else { continue };
            let file = source.rsplit('/').next().unwrap_or(source);
            if file.is_empty() || file.contains(':') {
                continue; // a YouTube still, not a file
            }
            out.insert(key, serde_json::json!({ "file": file, "date": v.get("date").and_then(|d| d.as_str()).unwrap_or("") }));
        }
    }
    serde_json::Value::Object(out).to_string()
}

/// Renders a frame's library video with its edit (look, sliders, effects, crop) and
/// trim into `library/<key>.mp4`, in its own shape, 1920 on the long side: what the
/// site builds that frame's films from. Unchanged since last time: left alone.
#[tauri::command]
pub async fn archive_write_clip(app: AppHandle, state: State<'_, AppState>, photo_id: String, key: String) -> Reply<bool> {
    // A project frame's key, or "brand-<file>" for a brand film (file: letters, digits, _ and -).
    let brand_film = key.strip_prefix("brand-").is_some_and(|f| !f.is_empty() && f.len() <= 80 && f.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
    if !valid_key(&key) && !brand_film {
        return Err(format!("not a frame key: {key}"));
    }
    let (db, looks_dir) = (state.db.clone(), state.looks_dir.clone());
    let dir = site_dir(&db).join("library");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(format!("{key}.mp4"));
    let trim = crate::library::moments::trim(&db, &photo_id).map_err(|e| e.to_string())?;
    let edit = crate::library::looks::for_photo(&db, &photo_id).map_err(|e| e.to_string())?;
    // What the render depends on: when it's the same, so is the film.
    let signature = serde_json::json!({ "photo": photo_id, "edit": edit, "trim": trim }).to_string();
    let sig_file = dir.join(format!(".{key}.mp4.edit"));
    if out.is_file() && std::fs::read_to_string(&sig_file).is_ok_and(|old| old == signature) {
        mark_published(&db, &key, &photo_id)?;
        return Ok(false);
    }
    let tmp = dir.join(format!(".{key}.part.mp4"));
    let _ = std::fs::remove_file(&tmp);
    let (start, end) = trim.map_or((None, None), |(a, b)| (Some(a), Some(b)));
    let cmd = crate::app::clip_command(&app, &db, &looks_dir, &photo_id, &tmp, "auto:1920", start, end)?;
    let events = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Reply<bool> {
        crate::app::run_clip(cmd, &tmp, |f| {
            let _ = events.emit("archive-clip-progress", serde_json::json!({ "key": key, "fraction": f }));
        })
        .map_err(|e| format!("The film couldn't be made: {e}"))?;
        std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
        std::fs::write(&sig_file, signature).map_err(|e| e.to_string())?;
        mark_published(&db, &key, &photo_id)?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// An album's photos (no videos) in the order they were added: what a project made from
/// that album holds. The project keeps its own order; this only says who belongs.
#[tauri::command]
pub async fn archive_album_photos(state: State<'_, AppState>, album: String) -> Reply<Vec<String>> {
    state
        .db
        .read(|c| {
            let mut st = c.prepare(
                "SELECT pa.photo_id FROM photo_albums pa JOIN photos p ON p.id = pa.photo_id
                 WHERE pa.album_id = ?1 AND p.is_video = 0 ORDER BY pa.position, pa.added_ms",
            )?;
            let ids = st.query_map([&album], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
            Ok(ids)
        })
        .map_err(crate::app::text)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncLine {
    line: String,
}

/// Runs the site's `npm run sync` (web copies of the rendered frames, then the browser's
/// media list). Each line it prints goes to the page as an `archive-sync` event.
#[tauri::command]
pub async fn archive_sync(app: AppHandle, state: State<'_, AppState>) -> Reply<()> {
    if SYNCING.swap(true, Ordering::SeqCst) {
        return Err("The website is already updating.".into());
    }
    let site = site_dir(&state.db);
    let result = tauri::async_runtime::spawn_blocking(move || run_sync(&app, &site)).await.map_err(|e| e.to_string());
    SYNCING.store(false, Ordering::SeqCst);
    result?
}

fn run_sync(app: &AppHandle, site: &Path) -> Reply<()> {
    // Apps opened from the Dock get a bare PATH; npm, node and python3 live in Homebrew.
    let path = format!("/opt/homebrew/bin:/usr/local/bin:{}", std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()));
    let mut child = Command::new("npm")
        .args(["run", "--silent", "sync"])
        .current_dir(site)
        .env("PATH", path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Can't start npm in {}: {e}", site.display()))?;
    let stderr = child.stderr.take();
    let err_lines = std::thread::spawn(move || stderr.map(|s| BufReader::new(s).lines().map_while(Result::ok).collect::<Vec<_>>()).unwrap_or_default());
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            let _ = app.emit("archive-sync", SyncLine { line });
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let errors = err_lines.join().unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        let tail: Vec<_> = errors.iter().rev().take(6).rev().cloned().collect();
        Err(if tail.is_empty() { format!("The website update stopped ({status}).") } else { tail.join("\n") })
    }
}

/// Where the site's dev server answers; it shows archive.json edits as they're saved.
const PREVIEW: &str = "127.0.0.1:4187";

/// Opens the site in the browser, at `path` ("/work/cape-town"), first starting its dev
/// server (`npm run dev`) when nothing answers yet. The server keeps running for later.
#[tauri::command]
pub async fn archive_preview(state: State<'_, AppState>, path: Option<String>) -> Reply<()> {
    let site = site_dir(&state.db);
    tauri::async_runtime::spawn_blocking(move || {
        let up = || std::net::TcpStream::connect_timeout(&PREVIEW.parse().expect("address"), std::time::Duration::from_millis(300)).is_ok();
        if !up() {
            let path = format!("/opt/homebrew/bin:/usr/local/bin:{}", std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()));
            Command::new("npm")
                .args(["run", "dev"])
                .current_dir(&site)
                .env("PATH", path)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("Can't start the site's preview: {e}"))?;
            let started = std::time::Instant::now();
            while !up() {
                if started.elapsed().as_secs() > 15 {
                    return Err("The site's preview didn't start.".to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
        }
        let page = path.filter(|p| p.starts_with('/') && !p.contains(char::is_whitespace)).unwrap_or_else(|| "/".into());
        Command::new("open").arg(format!("http://{PREVIEW}{page}")).status().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `cba://localhost/site/<path>`: a file from the site's `public/media`, for the
/// thumbnails of frames that aren't library photos. Only plain names under media/.
pub fn site_file(db: &Db, rel: &str) -> Option<PathBuf> {
    media_path_ok(rel).then(|| site_dir(db).join("public").join(rel))
}

fn media_path_ok(rel: &str) -> bool {
    (rel.starts_with("media/") || rel.starts_with("logos/"))
        && rel.split('/').all(|p| !p.is_empty() && p != "." && p != ".." && p.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_the_sites_own() {
        assert!(valid_key("studio-arno-876b5028"));
        assert!(valid_key("cape-town-228"));
        assert!(!valid_key("../etc"));
        assert!(!valid_key("Cape Town"));
        assert!(!valid_key(""));
    }

    #[test]
    fn site_files_stay_inside_media() {
        assert!(media_path_ok("media/img/cape-town/cape-town-228-640.jpg"));
        assert!(!media_path_ok("media/../../.ssh/id_rsa"));
        assert!(!media_path_ok("src/archive.json"));
        assert!(!media_path_ok("media//x.jpg"));
    }

    #[test]
    fn the_version_follows_the_contents() {
        assert_eq!(version_of(b"{}"), version_of(b"{}"));
        assert_ne!(version_of(b"{}"), version_of(b"{ }"));
    }
}
