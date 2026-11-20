//! Clean up, as the app offers it: what can go, the marks, the Bin (files on
//! Drive go to Google Drive's Bin), Undo, and the same photos in Apple Photos.
//! The Bin and Photos work happens in the bundled `bin` helper.

use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::app::{blocking, AppState};
use crate::library::{cleanup, db::Db};

type Reply<T> = Result<T, String>;

static HELPER: OnceLock<PathBuf> = OnceLock::new();

/// The bundled helper (a development run uses the one in the source tree).
pub fn set_helper(path: PathBuf) {
    let _ = HELPER.set(path);
}

/// Runs the helper with one line of work per input line; its answer, line by line.
fn helper(command: &str, lines: &[String]) -> Result<Vec<Vec<String>>, String> {
    let path = HELPER.get().cloned().unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/helpers/bin").into());
    let mut child = Command::new(path).arg(command).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let input = lines.join("\n");
    let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()));
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let _ = writer.join();
    Ok(String::from_utf8_lossy(&out.stdout).lines().map(|l| l.split('\t').map(str::to_owned).collect()).collect())
}

/// Every library photo the website shows or links to (projects, brand films,
/// what was published): those never go, whatever their review mark.
pub(crate) fn website_ids(db: &Db) -> HashSet<String> {
    fn strings(v: &serde_json::Value, out: &mut HashSet<String>) {
        match v {
            serde_json::Value::String(s) => {
                out.insert(s.clone());
            }
            serde_json::Value::Array(a) => a.iter().for_each(|x| strings(x, out)),
            serde_json::Value::Object(o) => o.iter().for_each(|(k, x)| {
                out.insert(k.clone());
                strings(x, out)
            }),
            _ => {}
        }
    }
    let site = crate::archive_cmd::site_dir(db);
    let mut ids = HashSet::new();
    for rel in ["src/archive.json", "src/site.json", "library/.published.json"] {
        if let Some(v) = std::fs::read_to_string(site.join(rel)).ok().and_then(|t| serde_json::from_str(&t).ok()) {
            strings(&v, &mut ids);
        }
    }
    ids
}

#[tauri::command]
pub async fn cleanup_overview(app: AppHandle) -> Reply<cleanup::Overview> {
    blocking(move || {
        let db = &app.state::<AppState>().db;
        cleanup::overview(db, &website_ids(db))
    })
    .await
}

#[tauri::command]
pub async fn cleanup_photos(app: AppHandle, trip: String) -> Reply<Vec<cleanup::Candidate>> {
    blocking(move || {
        let db = &app.state::<AppState>().db;
        cleanup::trip_photos(db, &trip, &website_ids(db))
    })
    .await
}

#[tauri::command]
pub async fn cleanup_mark(state: State<'_, AppState>, photo_ids: Vec<String>, mark: Option<String>) -> Reply<usize> {
    cleanup::mark(&state.db, &photo_ids, mark.as_deref()).map_err(|e| e.to_string())
}

/// Marks a quick-mark group in every trip (marks only; nothing is deleted).
#[tauri::command]
pub async fn cleanup_mark_set(app: AppHandle, set: String, mark: Option<String>) -> Reply<usize> {
    blocking(move || {
        let db = &app.state::<AppState>().db;
        cleanup::mark_set(db, &set, mark.as_deref(), &website_ids(db))
    })
    .await
}

/// Sends a trip's photos marked "delete" to the Bin, after the person typed
/// how many there are; `ids` are exactly the photos they saw marked.
#[tauri::command]
pub async fn cleanup_delete(app: AppHandle, trip: String, ids: Vec<String>) -> Reply<cleanup::BinReport> {
    blocking(move || {
        let db = &app.state::<AppState>().db;
        let trash = |paths: &[String]| -> Vec<Result<String, String>> {
            let answer = helper("trash", paths).unwrap_or_default();
            paths
                .iter()
                .map(|p| match answer.iter().find(|a| a.get(1) == Some(p)) {
                    // In the Bin, even if the system didn't say where: recorded, so it isn't lost track of.
                    Some(a) if a[0] == "ok" => Ok(a.get(2).filter(|w| !w.is_empty()).cloned().unwrap_or_else(|| format!("(in the Bin) {p}"))),
                    Some(a) => Err(a.get(2).cloned().unwrap_or_else(|| "the Bin said no".into())),
                    None => Err("the Bin didn't answer".into()),
                })
                .collect()
        };
        let report = cleanup::bin_trip(db, &trip, &ids, &website_ids(db), &trash)?;
        crate::applog::line(&format!("clean up: {} photos ({} bytes) from {trip} to the Bin, batch {}, {} failed", report.photos, report.bytes, report.batch, report.failed.len()));
        Ok(report)
    })
    .await
}

#[tauri::command]
pub async fn cleanup_history(state: State<'_, AppState>) -> Reply<Vec<cleanup::Batch>> {
    cleanup::history(&state.db).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cleanup_undo(app: AppHandle, batch: String) -> Reply<cleanup::UndoReport> {
    blocking(move || {
        let db = &app.state::<AppState>().db;
        let restore = |pairs: &[(String, String)]| -> Vec<Result<(), String>> {
            let lines: Vec<String> = pairs.iter().map(|(b, o)| format!("{b}\t{o}")).collect();
            let answer = helper("restore", &lines).unwrap_or_default();
            pairs
                .iter()
                .map(|(_, o)| match answer.iter().find(|a| a.get(1) == Some(o)) {
                    Some(a) if a[0] == "ok" => Ok(()),
                    Some(a) => Err(a.get(2).cloned().unwrap_or_default()),
                    None => Err("not in the Bin any more".into()),
                })
                .collect()
        };
        let r = cleanup::undo(db, &batch, &restore)?;
        crate::applog::line(&format!("clean up: undo {batch}: {} photos back, {} failed", r.photos, r.failed.len()));
        Ok(r)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneFind {
    /// Deleted photos looked for, and how many Apple Photos has.
    pub asked: usize,
    pub found: usize,
    /// Photos access was refused (System Settings › Privacy & Security › Photos).
    pub denied: bool,
}

/// Looks for a clean up's photos in Apple Photos (nothing is deleted yet).
#[tauri::command]
pub async fn cleanup_phone_find(app: AppHandle, batch: String) -> Reply<PhoneFind> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = &app.state::<AppState>().db;
        let queries = cleanup::phone_queries(db, &batch).map_err(|e| e.to_string())?;
        let lines: Vec<String> = queries.iter().map(|(id, stem, at)| format!("{id}\t{stem}\t{at}")).collect();
        let answer = if lines.is_empty() { Vec::new() } else { helper("photos-find", &lines)? };
        if answer.iter().any(|a| a[0] == "denied") {
            return Ok(PhoneFind { asked: lines.len(), found: 0, denied: true });
        }
        let found: Vec<(String, String)> = answer.iter().filter(|a| a[0] == "found" && a.len() == 3).map(|a| (a[1].clone(), a[2].clone())).collect();
        if !lines.is_empty() {
            cleanup::phone_found(db, &batch, &found).map_err(|e| e.to_string())?;
        }
        let total = cleanup::phone_ids(db, &batch).map_err(|e| e.to_string())?.len();
        Ok(PhoneFind { asked: lines.len(), found: total, denied: false })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Deletes a clean up's photos from Apple Photos. Apple asks first; they stay
/// in Recently Deleted for 30 days. Answers "deleted", "cancelled" or "denied".
#[tauri::command]
pub async fn cleanup_phone_delete(app: AppHandle, batch: String) -> Reply<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = &app.state::<AppState>().db;
        let ids = cleanup::phone_ids(db, &batch).map_err(|e| e.to_string())?;
        if ids.is_empty() {
            return Ok("deleted".to_owned());
        }
        let answer = helper("photos-delete", &ids)?;
        let first = answer.first().cloned().unwrap_or_default();
        let state = match first.first().map(String::as_str) {
            Some("deleted") => "deleted",
            Some("cancelled") => "cancelled",
            Some("denied") => return Ok("denied".to_owned()),
            _ => return Err(first.get(1).cloned().unwrap_or_else(|| "Photos didn't answer".into())),
        };
        cleanup::phone_done(db, &batch, state).map_err(|e| e.to_string())?;
        crate::applog::line(&format!("clean up: phone {state} for {batch} ({} photos)", ids.len()));
        Ok(state.to_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}
