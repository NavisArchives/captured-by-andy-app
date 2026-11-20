//! Renames / moves library files and keeps the library pointing at them, so
//! marks, moments and posts stay attached. Run with the app closed:
//! `relocate_assets <library dir> <plan.csv> [--go]`
//! The plan has `photo_id,old_path,new_path` lines (a header line is skipped).
//! Without `--go` it only checks the plan. Every move it makes is written to
//! `<library dir>/relocations-<time>.csv` (new,old) so it can be undone.
use std::io::Write;
use std::path::{Path, PathBuf};

use captured_by_andy_lib::library::db::Db;
use rusqlite::params;

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = PathBuf::from(args.next().expect("library dir"));
    let plan = std::fs::read_to_string(args.next().expect("plan.csv")).expect("read plan");
    let go = args.any(|a| a == "--go");
    let db = Db::open(&dir.join("library.db")).expect("open library");

    let mut rows = Vec::new();
    for line in plan.lines().skip(1).filter(|l| !l.trim().is_empty()) {
        let mut parts = line.splitn(3, ',');
        let (Some(id), Some(old), Some(new)) = (parts.next(), parts.next(), parts.next()) else { panic!("bad line: {line}") };
        rows.push((id.to_owned(), PathBuf::from(old), PathBuf::from(new)));
    }

    // Check everything before moving anything.
    let mut problems = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (id, old, new) in &rows {
        let recorded: Option<String> = db
            .read(|c| Ok(c.query_row("SELECT path FROM assets WHERE photo_id = ?1 AND is_primary = 1", [id], |r| r.get(0)).ok()))
            .expect("read");
        if recorded.as_deref() != old.to_str() {
            problems.push(format!("{id}: library has {recorded:?}, plan says {}", old.display()));
        }
        if std::fs::symlink_metadata(old).is_err() {
            problems.push(format!("missing: {}", old.display()));
        }
        if std::fs::symlink_metadata(new).is_ok() {
            problems.push(format!("already exists: {}", new.display()));
        }
        if !seen.insert(new.clone()) {
            problems.push(format!("twice in the plan: {}", new.display()));
        }
    }
    if !problems.is_empty() {
        for p in &problems {
            println!("problem: {p}");
        }
        std::process::exit(1);
    }
    println!("{} moves checked", rows.len());
    if !go {
        return;
    }

    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let log_path = dir.join(format!("relocations-{stamp}.csv"));
    let mut log = std::fs::File::create(&log_path).expect("undo log");
    writeln!(log, "photo_id,new_path,old_path").expect("write log");
    let mut moved = 0;
    for (id, old, new) in &rows {
        if let Some(parent) = new.parent() {
            std::fs::create_dir_all(parent).expect("make folder");
        }
        if let Err(e) = std::fs::rename(old, new) {
            println!("could not move {}: {e}", old.display());
            continue;
        }
        let updated = db.write(|c| {
            Ok(c.execute(
                "UPDATE assets SET path = ?2, dir = ?3, stem = ?4, filename = ?5, updated_ms = ?6
                 WHERE photo_id = ?1 AND is_primary = 1 AND path = ?7",
                params![
                    id,
                    new.to_string_lossy(),
                    new.parent().map(Path::to_string_lossy).unwrap_or_default(),
                    new.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default(),
                    new.file_name().map(|s| s.to_string_lossy()).unwrap_or_default(),
                    stamp as i64 * 1000,
                    old.to_string_lossy(),
                ],
            )?)
        });
        if !matches!(updated, Ok(1)) {
            // Keep file and library in step: put the file back.
            let _ = std::fs::rename(new, old);
            println!("library not updated for {}, moved back", old.display());
            continue;
        }
        writeln!(log, "{id},{},{}", new.display(), old.display()).expect("write log");
        moved += 1;
    }
    println!("{moved} of {} moved; undo list: {}", rows.len(), log_path.display());
}
