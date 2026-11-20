//! The app's own log, in ~/Library/Logs/com.capturedbyandy.library/app.log:
//! launches, errors, background jobs and crashes, so a problem can be found
//! afterwards. Never photo contents or anything heard by voice culling. It
//! stays small: past 2 MB the file moves to app.log.1 (the one before goes).

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const MAX_BYTES: u64 = 2 << 20;

static DIR: OnceLock<PathBuf> = OnceLock::new();
static LOCK: Mutex<()> = Mutex::new(());

/// Where logs go; also writes crashes (panics) into the log before the usual report.
pub fn init(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let _ = DIR.set(dir);
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Where it happened, not only what: the thread and the calls leading to it.
        let thread = std::thread::current().name().unwrap_or("unnamed").to_owned();
        let trace = std::backtrace::Backtrace::force_capture();
        line(&format!("crash on thread {thread}: {info}\n{trace}"));
        default(info);
    }));
}

pub fn dir() -> Option<PathBuf> {
    DIR.get().cloned()
}

/// One timestamped line.
pub fn line(msg: &str) {
    let Some(dir) = DIR.get() else { return };
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = dir.join("app.log");
    if path.metadata().is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::rename(&path, dir.join("app.log.1")); // our own log, rotated
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let msg: String = msg.chars().take(if msg.starts_with("crash") { 20_000 } else { 2000 }).collect();
        let _ = writeln!(f, "{} {msg}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"));
    }
}
