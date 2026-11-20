use std::path::Path;

use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use super::db::Db;
use super::{new_id, now_ms, Error, Result};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub path: String,
    pub label: String,
    pub enabled: bool,
    pub last_scan_finished_ms: Option<i64>,
    pub photo_count: i64,
    pub online: bool,
}

/// What adding a folder did: registered it, or found a source that already
/// covers it (`already_covered`), which is then the source returned.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedSource {
    pub source: Source,
    pub already_covered: bool,
    /// Folders that were indexed on their own and are now part of this one
    /// (their photos, marks, albums and posts come along).
    pub merged: Vec<String>,
}

/// Registers a folder to index. Only the path is recorded; nothing inside it is
/// touched here.
pub fn add(db: &Db, path: &Path) -> Result<Source> {
    add_folder(db, path).map(|a| a.source)
}

/// `add`, saying what happened. Sources never overlap (a file indexed twice
/// would clash with itself and stop the scan):
/// - a folder inside an indexed one is already covered, nothing is added;
/// - a folder around indexed ones takes them over. Their files keep their rows
///   (paths are absolute), so every photo keeps its marks, albums, tags and
///   posts, and the next scan finds them unchanged.
pub fn add_folder(db: &Db, path: &Path) -> Result<AddedSource> {
    let path = path
        .canonicalize()
        .map_err(|_| Error::Invalid(format!("folder does not exist: {}", path.display())))?;
    if !path.is_dir() {
        return Err(Error::Invalid(format!("not a folder: {}", path.display())));
    }
    let text = path.to_string_lossy().into_owned();
    // `starts_with` compares whole components: "Photos 2" is not inside "Photos".
    let existing = list(db)?;
    if let Some(outer) = existing.iter().find(|s| s.path != text && path.starts_with(&s.path)) {
        if !outer.enabled {
            // Adding it on its own would clash with the parent once that is on again.
            return Err(Error::Invalid(format!(
                "This folder is inside “{}”, which is switched off. Switch it on in Settings to index this folder.",
                outer.label
            )));
        }
        return Ok(AddedSource { source: outer.clone(), already_covered: true, merged: Vec::new() });
    }
    let inner: Vec<&Source> = existing.iter().filter(|s| s.path != text && Path::new(&s.path).starts_with(&path)).collect();
    let label = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| text.clone());
    db.write(|c| {
        let tx = c.transaction()?;
        let id = match tx.query_row("SELECT id FROM sources WHERE path = ?1", [&text], |r| r.get::<_, String>(0)).optional()? {
            Some(id) => id,
            None => {
                let id = new_id();
                tx.execute(
                    "INSERT INTO sources (id, path, label, created_ms) VALUES (?1, ?2, ?3, ?4)",
                    params![id, text, label, now_ms()],
                )?;
                id
            }
        };
        for s in &inner {
            tx.execute("UPDATE assets SET source_id = ?1 WHERE source_id = ?2", params![id, s.id])?;
            tx.execute("UPDATE scan_runs SET source_id = ?1 WHERE source_id = ?2", params![id, s.id])?;
            tx.execute("DELETE FROM sources WHERE id = ?1", [&s.id])?;
        }
        tx.commit()?;
        Ok(())
    })?;
    let source = list(db)?.into_iter().find(|s| s.path == text).ok_or_else(|| Error::Invalid("source vanished".into()))?;
    Ok(AddedSource { source, already_covered: false, merged: inner.iter().map(|s| s.label.clone()).collect() })
}

pub fn list(db: &Db) -> Result<Vec<Source>> {
    db.read(|c| {
        let mut stmt = c.prepare(
            "SELECT s.id, s.path, s.label, s.enabled, s.last_scan_finished_ms,
                    (SELECT COUNT(DISTINCT a.photo_id) FROM assets a WHERE a.source_id = s.id)
             FROM sources s ORDER BY s.created_ms",
        )?;
        let rows = stmt
            .query_map([], |r| {
                let path: String = r.get(1)?;
                Ok(Source {
                    id: r.get(0)?,
                    online: Path::new(&path).is_dir(),
                    path,
                    label: r.get(2)?,
                    enabled: r.get(3)?,
                    last_scan_finished_ms: r.get(4)?,
                    photo_count: r.get(5)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

pub fn get(db: &Db, id: &str) -> Result<Source> {
    list(db)?.into_iter().find(|s| s.id == id).ok_or_else(|| Error::Invalid(format!("unknown source {id}")))
}

pub fn set_enabled(db: &Db, id: &str, enabled: bool) -> Result<()> {
    db.write(|c| {
        c.execute("UPDATE sources SET enabled = ?2 WHERE id = ?1", params![id, enabled])?;
        Ok(())
    })
}

/// Forgets a folder: its index rows, and photos that only lived there (with
/// their album, tag and post memberships). The folder and its files are not
/// touched. Callers first undo the app's own side effects (Finder tags,
/// offline copies) while the records that describe them still exist.
pub fn remove(db: &Db, id: &str) -> Result<usize> {
    db.write(|c| {
        let tx = c.transaction()?;
        let photo_ids: Vec<String> = tx
            .prepare("SELECT DISTINCT photo_id FROM assets WHERE source_id = ?1")?
            .query_map([id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for sql in [
            "DELETE FROM finder_tags WHERE asset_id IN (SELECT id FROM assets WHERE source_id = ?1)",
            "DELETE FROM local_copies WHERE asset_id IN (SELECT id FROM assets WHERE source_id = ?1)",
            "DELETE FROM archived_assets WHERE asset_id IN (SELECT id FROM assets WHERE source_id = ?1)",
            "DELETE FROM assets WHERE source_id = ?1",
            "DELETE FROM scan_runs WHERE source_id = ?1",
        ] {
            tx.execute(sql, [id])?;
        }
        let mut removed = 0;
        {
            let mut stmt = tx.prepare(
                "DELETE FROM photos WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM assets WHERE photo_id = ?1)",
            )?;
            for photo in &photo_ids {
                removed += stmt.execute([photo])?;
            }
        }
        tx.execute("DELETE FROM sources WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(removed)
    })
}
