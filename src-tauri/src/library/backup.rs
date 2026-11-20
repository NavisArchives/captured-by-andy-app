//! Copies of the library file: every mark, album, tag, edit and post lives in
//! it, so one is kept each day for a week, plus one before every restore and
//! schema upgrade. Photos are never part of this; they stay where they are.
//!
//! Backups are whole, consistent SQLite files (`VACUUM INTO`) in a `backups`
//! folder next to the library. Restoring happens at launch, before the library
//! is opened, and always saves the current library first so it can be undone.

use std::path::{Path, PathBuf};

use chrono::{Local, TimeZone};
use rusqlite::Connection;
use serde::Serialize;

use super::db::Db;
use super::{Error, Result};

/// Daily copies kept.
pub const KEEP_DAILY: usize = 7;
/// Copies of other kinds (before a restore, before an upgrade, by hand) kept per kind.
pub const KEEP_OTHER: usize = 5;
const MARKER: &str = "restore.json";

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub name: String,
    pub created_ms: i64,
    pub size: u64,
    /// "daily", "manual", "before-restore" or "before-upgrade".
    pub kind: String,
}

/// The backups folder for a library file.
pub fn dir(db_path: &Path) -> PathBuf {
    db_path.parent().unwrap_or(Path::new(".")).join("backups")
}

fn kind_of(name: &str) -> Option<&'static str> {
    let stem = name.strip_prefix("library-")?.strip_suffix(".db")?;
    let (date, rest) = stem.split_at(stem.len().min(10));
    if chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() {
        return None;
    }
    Some(match rest {
        "" => "daily",
        r if r.ends_with("-before-restore") => "before-restore",
        r if r.ends_with("-before-upgrade") => "before-upgrade",
        r if r.ends_with("-manual") => "manual",
        _ => return None,
    })
}

/// A whole, consistent copy of the open library at `dest` (never half-written).
fn snapshot(db: &Db, dest: &Path) -> Result<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = dest.with_extension("db.partial");
    let _ = std::fs::remove_file(&tmp); // a leftover of our own
    let target = tmp.to_str().ok_or_else(|| Error::Invalid("backup path isn't valid text".into()))?.to_owned();
    db.write(|c| {
        c.execute("VACUUM INTO ?1", [&target])?;
        Ok(())
    })?;
    std::fs::rename(&tmp, dest)?;
    Ok(())
}

fn stamp() -> String {
    Local::now().format("%Y-%m-%d-%H%M%S").to_string()
}

/// Today's copy, if there isn't one yet. Returns the new file.
pub fn daily(db: &Db) -> Result<Option<PathBuf>> {
    let dest = dir(db.path()).join(format!("library-{}.db", Local::now().format("%Y-%m-%d")));
    if dest.exists() {
        return Ok(None);
    }
    snapshot(db, &dest)?;
    prune(db.path())?;
    Ok(Some(dest))
}

/// A copy right now, by hand.
pub fn now(db: &Db) -> Result<BackupInfo> {
    let name = format!("library-{}-manual.db", stamp());
    let dest = dir(db.path()).join(&name);
    snapshot(db, &dest)?;
    prune(db.path())?;
    info(&dest).ok_or_else(|| Error::Invalid("backup not found after writing it".into()))
}

fn info(path: &Path) -> Option<BackupInfo> {
    let name = path.file_name()?.to_str()?.to_owned();
    let kind = kind_of(&name)?;
    let meta = path.metadata().ok()?;
    let created_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(BackupInfo { name, created_ms, size: meta.len(), kind: kind.to_owned() })
}

/// Every backup, newest first.
pub fn list(db_path: &Path) -> Vec<BackupInfo> {
    let Ok(entries) = std::fs::read_dir(dir(db_path)) else { return Vec::new() };
    let mut all: Vec<BackupInfo> = entries.flatten().filter_map(|e| info(&e.path())).collect();
    all.sort_by(|a, b| b.created_ms.cmp(&a.created_ms).then(b.name.cmp(&a.name)));
    all
}

/// Keeps the newest copies of each kind; removes only older backup files of our own.
fn prune(db_path: &Path) -> Result<()> {
    let all = list(db_path);
    for kind in ["daily", "manual", "before-restore", "before-upgrade"] {
        let keep = if kind == "daily" { KEEP_DAILY } else { KEEP_OTHER };
        for old in all.iter().filter(|b| b.kind == kind).skip(keep) {
            let file = dir(db_path).join(&old.name);
            let _ = std::fs::remove_file(file.with_extension("db-wal"));
            let _ = std::fs::remove_file(&file);
        }
    }
    Ok(())
}

fn checked(path: &Path) -> Result<()> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let result: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if result != "ok" {
        return Err(Error::Invalid(format!("that backup is damaged ({result})")));
    }
    Ok(())
}

/// Asks for a restore at the next launch: first saves the library as it is now
/// (so the restore can be undone), then leaves a note for [`apply_pending`].
pub fn stage_restore(db: &Db, name: &str) -> Result<()> {
    if kind_of(name).is_none() || name.contains('/') {
        return Err(Error::Invalid(format!("not a backup: {name}")));
    }
    let source = dir(db.path()).join(name);
    if !source.is_file() {
        return Err(Error::Invalid(format!("backup not found: {name}")));
    }
    checked(&source)?;
    snapshot(db, &dir(db.path()).join(format!("library-{}-before-restore.db", stamp())))?;
    prune(db.path())?;
    let marker = db.path().parent().unwrap_or(Path::new(".")).join(MARKER);
    std::fs::write(marker, serde_json::json!({ "name": name }).to_string())?;
    Ok(())
}

/// Like [`stage_restore`] when the library can't even be opened: the current
/// file (and its write-ahead log) is kept as it is, next to the backups.
pub fn stage_restore_raw(db_path: &Path, name: &str) -> Result<()> {
    if kind_of(name).is_none() || name.contains('/') {
        return Err(Error::Invalid(format!("not a backup: {name}")));
    }
    let source = dir(db_path).join(name);
    checked(&source)?;
    if db_path.is_file() {
        let keep = dir(db_path).join(format!("library-{}-before-restore.db", stamp()));
        std::fs::create_dir_all(dir(db_path))?;
        std::fs::copy(db_path, &keep)?;
        let wal = db_path.with_extension("db-wal");
        if wal.is_file() {
            std::fs::copy(&wal, keep.with_extension("db-wal"))?;
        }
    }
    let marker = db_path.parent().unwrap_or(Path::new(".")).join(MARKER);
    std::fs::write(marker, serde_json::json!({ "name": name }).to_string())?;
    Ok(())
}

/// At launch, before the library is opened: puts a staged backup in place.
/// Returns the backup's name when one was restored.
pub fn apply_pending(db_path: &Path) -> Result<Option<String>> {
    let marker = db_path.parent().unwrap_or(Path::new(".")).join(MARKER);
    let Ok(text) = std::fs::read_to_string(&marker) else { return Ok(None) };
    let _ = std::fs::remove_file(&marker); // one attempt only, never a restore loop
    let name = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_owned))
        .filter(|n| kind_of(n).is_some() && !n.contains('/'))
        .ok_or_else(|| Error::Invalid("the restore note was unreadable".into()))?;
    let source = dir(db_path).join(&name);
    checked(&source)?;
    let tmp = db_path.with_extension("db.restoring");
    std::fs::copy(&source, &tmp)?;
    // The old library's write-ahead files belong to the file being replaced (it
    // was saved as a before-restore backup); left behind they'd be replayed
    // onto the restored copy.
    for ext in ["db-wal", "db-shm"] {
        let _ = std::fs::remove_file(db_path.with_extension(ext));
    }
    std::fs::rename(&tmp, db_path)?;
    Ok(Some(name))
}

/// Before a schema upgrade of an existing library: a copy of the library as it was.
pub fn before_upgrade(conn: &Connection, db_path: &Path) -> Result<()> {
    let dest = dir(db_path).join(format!("library-{}-before-upgrade.db", stamp()));
    std::fs::create_dir_all(dir(db_path))?;
    let target = dest.to_str().ok_or_else(|| Error::Invalid("backup path isn't valid text".into()))?.to_owned();
    conn.execute("VACUUM INTO ?1", [&target])?;
    prune(db_path)?;
    Ok(())
}

/// "Today, 22:41" style label, for tests and logs.
pub fn label(created_ms: i64) -> String {
    Local.timestamp_millis_opt(created_ms).single().map(|t| t.format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(kind_of("library-2026-09-28.db"), Some("daily"));
        assert_eq!(kind_of("library-2026-09-28-224100-manual.db"), Some("manual"));
        assert_eq!(kind_of("library-2026-09-28-224100-before-restore.db"), Some("before-restore"));
        assert_eq!(kind_of("library-2026-09-28-224100-before-upgrade.db"), Some("before-upgrade"));
        assert_eq!(kind_of("library.db"), None);
        assert_eq!(kind_of("photo.jpg"), None);
        assert_eq!(kind_of("library-2026-13-40.db"), None);
    }

    #[test]
    fn back_up_restore_and_undo() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.db");
        let db = Db::open(&path).unwrap();
        db.write(|c| {
            c.execute("INSERT INTO settings (key, value) VALUES ('probe', 'before')", [])?;
            Ok(())
        })
        .unwrap();
        let made = daily(&db).unwrap().expect("first daily backup");
        assert!(daily(&db).unwrap().is_none(), "one per day");
        db.write(|c| {
            c.execute("UPDATE settings SET value = 'after' WHERE key = 'probe'", [])?;
            Ok(())
        })
        .unwrap();

        let name = made.file_name().unwrap().to_str().unwrap().to_owned();
        stage_restore(&db, &name).unwrap();
        drop(db);
        assert_eq!(apply_pending(&path).unwrap(), Some(name));
        assert_eq!(apply_pending(&path).unwrap(), None, "a restore happens once");

        let db = Db::open(&path).unwrap();
        let value: String = db.read(|c| Ok(c.query_row("SELECT value FROM settings WHERE key = 'probe'", [], |r| r.get(0))?)).unwrap();
        assert_eq!(value, "before");
        // The library as it was just before the restore is kept, so the restore can be undone.
        assert!(list(&path).iter().any(|b| b.kind == "before-restore"));
    }

    #[test]
    fn a_damaged_library_can_be_restored_without_opening_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.db");
        let db = Db::open(&path).unwrap();
        db.write(|c| {
            c.execute("INSERT INTO settings (key, value) VALUES ('probe', 'good')", [])?;
            Ok(())
        })
        .unwrap();
        let name = daily(&db).unwrap().unwrap().file_name().unwrap().to_str().unwrap().to_owned();
        drop(db);
        std::fs::write(&path, b"this is not a database any more").unwrap();
        let _ = std::fs::remove_file(path.with_extension("db-wal"));

        stage_restore_raw(&path, &name).unwrap();
        assert_eq!(apply_pending(&path).unwrap(), Some(name));
        let db = Db::open(&path).unwrap();
        let value: String = db.read(|c| Ok(c.query_row("SELECT value FROM settings WHERE key = 'probe'", [], |r| r.get(0))?)).unwrap();
        assert_eq!(value, "good");
        // The damaged file is kept, untouched, among the backups.
        let kept = list(&path).into_iter().find(|b| b.kind == "before-restore").unwrap();
        assert_eq!(std::fs::read(super::dir(&path).join(kept.name)).unwrap(), b"this is not a database any more");
    }

    #[test]
    fn keeps_a_week_of_daily_copies() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.db");
        let db = Db::open(&path).unwrap();
        std::fs::create_dir_all(super::dir(&path)).unwrap();
        for day in 1..=10 {
            let p = super::dir(&path).join(format!("library-2026-09-{day:02}.db"));
            std::fs::write(&p, b"x").unwrap();
            let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_790_000_000 + day * 86_400);
            std::fs::File::options().append(true).open(&p).unwrap().set_modified(t).unwrap();
        }
        let photo = dir.path().join("keep-me.jpg");
        std::fs::write(&photo, b"not ours").unwrap();
        prune(&path).unwrap();
        let left: Vec<String> = list(&path).into_iter().map(|b| b.name).collect();
        assert_eq!(left.len(), KEEP_DAILY);
        assert!(left.contains(&"library-2026-09-10.db".to_owned()));
        assert!(!left.contains(&"library-2026-09-01.db".to_owned()));
        assert!(photo.exists(), "only backup files are ever removed");
        drop(db);
    }
}
