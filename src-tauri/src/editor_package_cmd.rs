//! External-editor package commands. A single cancellable job survives screen
//! navigation; only explicitly requested local working copies are created.
use crate::app::{text, AppState};
use crate::library::editor_package::{self, Plan, Progress, Report};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

type Reply<T> = Result<T, String>;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    piece_id: String,
    running: bool,
    progress: Option<Progress>,
    report: Option<Report>,
    problem: Option<String>,
}
struct Job {
    status: Status,
    cancel: Arc<AtomicBool>,
}
static JOB: Mutex<Option<Job>> = Mutex::new(None);
fn emit(app: &AppHandle) {
    let status = JOB
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|j| j.status.clone());
    let _ = app.emit("editor-package", status);
}
#[tauri::command]
pub async fn studio_editor_plan(
    app: AppHandle,
    piece_id: String,
    destination: String,
) -> Reply<Plan> {
    tauri::async_runtime::spawn_blocking(move || {
        editor_package::plan(
            &app.state::<AppState>().db,
            &piece_id,
            &PathBuf::from(destination),
        )
        .map_err(text)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn studio_editor_status() -> Reply<Option<Status>> {
    Ok(JOB
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|j| j.status.clone()))
}
#[tauri::command]
pub async fn studio_editor_cancel(piece_id: String) -> Reply<()> {
    let slot = JOB.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(job) = slot
        .as_ref()
        .filter(|j| j.status.running && j.status.piece_id == piece_id)
    {
        job.cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}
#[tauri::command]
pub async fn studio_editor_prepare(
    app: AppHandle,
    piece_id: String,
    destination: String,
    key: String,
) -> Reply<()> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = JOB.lock().unwrap_or_else(|p| p.into_inner());
        if slot.as_ref().is_some_and(|j| j.status.running) {
            return Err(
                "Another editor package is being prepared. Wait for it or stop it first.".into(),
            );
        }
        *slot = Some(Job {
            status: Status {
                piece_id: piece_id.clone(),
                running: true,
                progress: None,
                report: None,
                problem: None,
            },
            cancel: cancel.clone(),
        });
    }
    emit(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let result = editor_package::prepare(
            &app.state::<AppState>().db,
            &piece_id,
            &PathBuf::from(destination),
            &key,
            &cancel,
            |p| {
                {
                    let mut slot = JOB.lock().unwrap_or_else(|p| p.into_inner());
                    if let Some(job) = slot.as_mut() {
                        job.status.progress = Some(p.clone());
                    }
                }
                emit(&app);
            },
        );
        {
            let mut slot = JOB.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(job) = slot.as_mut() {
                job.status.running = false;
                match result {
                    Ok(report) => job.status.report = Some(report),
                    Err(e) => job.status.problem = Some(text(e)),
                }
            }
        }
        emit(&app);
    });
    Ok(())
}
