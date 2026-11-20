//! Finder colour tags for selected photos.
//!
//! The only thing ever written to an original is its `_kMDItemUserTags`
//! extended attribute (what Finder itself writes): file contents and
//! modification time stay as they are. Other tags on the file are kept, and the
//! app only ever removes a tag it recorded adding, so a Green tag you set
//! yourself is never taken away.

use std::path::Path;

use rusqlite::params;
use serde::Serialize;

use super::db::Db;
use super::model::ReviewState;
use super::{now_ms, settings, Error, Result};

const XATTR: &str = "com.apple.metadata:_kMDItemUserTags";
/// Finder's colour index for Green.
const GREEN: u8 = 2;

pub const ENABLED_KEY: &str = "finder.greenTag";
pub const NAME_KEY: &str = "finder.tagName";

pub fn enabled(db: &Db) -> Result<bool> {
    Ok(settings::get(db, ENABLED_KEY)?.map(|v| v != "false").unwrap_or(true))
}

pub fn tag_name(db: &Db) -> Result<String> {
    Ok(settings::get(db, NAME_KEY)?.map(|v| v.trim_matches('"').to_owned()).filter(|v| !v.is_empty()).unwrap_or_else(|| "Green".into()))
}

/// The file's Finder tags, as stored: "Name" or "Name\n<colour index>".
pub fn read_tags(path: &Path) -> Result<Vec<String>> {
    let Some(bytes) = xattr::get(path, XATTR)? else { return Ok(Vec::new()) };
    let value = plist::Value::from_reader(std::io::Cursor::new(bytes)).map_err(|e| Error::Media(format!("tags: {e}")))?;
    Ok(value
        .into_array()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.into_string())
        .collect())
}

fn write_tags(path: &Path, tags: &[String]) -> Result<()> {
    if tags.is_empty() {
        match xattr::remove(path, XATTR) {
            Ok(()) => Ok(()),
            Err(e) if e.raw_os_error() == Some(93) => Ok(()), // ENOATTR: nothing to remove
            Err(e) => Err(e.into()),
        }
    } else {
        let value = plist::Value::Array(tags.iter().cloned().map(plist::Value::String).collect());
        let mut bytes = Vec::new();
        value.to_writer_binary(&mut bytes).map_err(|e| Error::Media(format!("tags: {e}")))?;
        xattr::set(path, XATTR, &bytes)?;
        Ok(())
    }
}

fn tag_base(tag: &str) -> &str {
    tag.split('\n').next().unwrap_or(tag)
}

/// Adds the tag unless the file already has it. True when the app added it.
pub fn add_tag(path: &Path, name: &str) -> Result<bool> {
    let mut tags = read_tags(path)?;
    if tags.iter().any(|t| tag_base(t) == name) {
        return Ok(false);
    }
    tags.push(format!("{name}\n{GREEN}"));
    write_tags(path, &tags)?;
    Ok(true)
}

/// Removes the tag, keeping every other tag.
pub fn remove_tag(path: &Path, name: &str) -> Result<()> {
    let tags = read_tags(path)?;
    let kept: Vec<String> = tags.iter().filter(|t| tag_base(t) != name).cloned().collect();
    if kept.len() != tags.len() {
        write_tags(path, &kept)?;
    }
    Ok(())
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct SyncReport {
    pub tagged: usize,
    pub untagged: usize,
    /// Not on this Mac (iCloud-only or missing): left alone.
    pub skipped: usize,
    pub failed: usize,
}

struct Target {
    asset_id: String,
    path: String,
    local: bool,
    selected: bool,
    ours: bool,
}

/// Brings the tags of these photos in line with their review state: selected
/// photos (every file of the photo, RAW and JPEG) get the tag, others lose the
/// tag the app added. iCloud-only files are never touched.
pub fn sync(db: &Db, photo_ids: &[String]) -> Result<SyncReport> {
    let on = enabled(db)?;
    let name = tag_name(db)?;
    let targets = db.read(|c| {
        let mut stmt = c.prepare_cached(
            "SELECT a.id, a.path, a.storage_state = 'local', p.review_state = ?2,
                    EXISTS (SELECT 1 FROM finder_tags ft WHERE ft.asset_id = a.id)
             FROM assets a JOIN photos p ON p.id = a.photo_id WHERE a.photo_id = ?1",
        )?;
        let mut out = Vec::new();
        for id in photo_ids {
            for t in stmt.query_map(params![id, ReviewState::Selected.as_str()], |r| {
                Ok(Target { asset_id: r.get(0)?, path: r.get(1)?, local: r.get(2)?, selected: r.get(3)?, ours: r.get(4)? })
            })? {
                out.push(t?);
            }
        }
        Ok(out)
    })?;
    let mut report = SyncReport::default();
    for t in targets {
        let want = on && t.selected;
        if want == t.ours {
            continue;
        }
        if !t.local {
            report.skipped += 1;
            continue;
        }
        let path = Path::new(&t.path);
        if want {
            match add_tag(path, &name) {
                Ok(true) => {
                    db.write(|c| {
                        c.execute(
                            "INSERT OR REPLACE INTO finder_tags (asset_id, tagged_ms) VALUES (?1, ?2)",
                            params![t.asset_id, now_ms()],
                        )?;
                        Ok(())
                    })?;
                    report.tagged += 1;
                }
                Ok(false) => {}
                Err(_) => report.failed += 1,
            }
        } else {
            match remove_tag(path, &name) {
                Ok(()) => {
                    db.write(|c| {
                        c.execute("DELETE FROM finder_tags WHERE asset_id = ?1", [&t.asset_id])?;
                        Ok(())
                    })?;
                    report.untagged += 1;
                }
                Err(_) => report.failed += 1,
            }
        }
    }
    Ok(report)
}

/// Every selected photo that should carry the tag but does not yet.
pub fn sync_all(db: &Db) -> Result<SyncReport> {
    let ids: Vec<String> = db.read(|c| {
        let ids = c
            .prepare(
                "SELECT DISTINCT p.id FROM photos p JOIN assets a ON a.photo_id = p.id
                 WHERE (p.review_state = 'selected') != EXISTS (SELECT 1 FROM finder_tags ft WHERE ft.asset_id = a.id)",
            )?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(ids)
    })?;
    sync(db, &ids)
}

/// Takes off every tag the app added (the setting was switched off, or before
/// forgetting a folder). Tags the app did not add stay.
pub fn remove_added(db: &Db, source_id: Option<&str>) -> Result<SyncReport> {
    let name = tag_name(db)?;
    let rows: Vec<(String, String)> = db.read(|c| {
        let rows = c
            .prepare(
                "SELECT a.id, a.path FROM finder_tags ft JOIN assets a ON a.id = ft.asset_id
                 WHERE ?1 IS NULL OR a.source_id = ?1",
            )?
            .query_map([source_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    })?;
    let mut report = SyncReport::default();
    for (asset, path) in rows {
        let path = Path::new(&path);
        let result = if path.exists() { remove_tag(path, &name) } else { Ok(()) };
        match result {
            Ok(()) => {
                db.write(|c| {
                    c.execute("DELETE FROM finder_tags WHERE asset_id = ?1", [&asset])?;
                    Ok(())
                })?;
                report.untagged += 1;
            }
            Err(_) => report.failed += 1,
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_are_added_and_removed_without_touching_anything_else() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("IMG_0001.JPG");
        std::fs::write(&file, b"not really a jpeg").unwrap();
        let before = std::fs::metadata(&file).unwrap().modified().unwrap();

        write_tags(&file, &["Red\n6".into(), "Work".into()]).unwrap();
        assert!(add_tag(&file, "Green").unwrap());
        assert_eq!(read_tags(&file).unwrap(), vec!["Red\n6", "Work", "Green\n2"]);
        assert!(!add_tag(&file, "Green").unwrap(), "already tagged: not ours to add again");

        remove_tag(&file, "Green").unwrap();
        assert_eq!(read_tags(&file).unwrap(), vec!["Red\n6", "Work"]);
        assert_eq!(std::fs::read(&file).unwrap(), b"not really a jpeg");
        assert_eq!(std::fs::metadata(&file).unwrap().modified().unwrap(), before);
    }

    #[test]
    fn a_file_without_tags_reads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.jpg");
        std::fs::write(&file, b"x").unwrap();
        assert!(read_tags(&file).unwrap().is_empty());
        remove_tag(&file, "Green").unwrap();
        assert!(xattr::get(&file, XATTR).unwrap().is_none());
    }
}
