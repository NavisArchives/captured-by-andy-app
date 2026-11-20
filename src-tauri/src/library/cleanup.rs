//! Clean up: deleting rejected photos for good, carefully.
//!
//! Only Rejected photos can go, and never one that is used somewhere: tagged,
//! in an album or a post, edited (a look, a trim, video moments), kept on this
//! Mac, in a Studio piece, or on the website. Rejected photos start as "keep";
//! the last look marks the ones to delete. Deleting goes one trip at a time and
//! needs the exact number of photos as confirmation. Files go to the Bin (Drive
//! files to Google Drive's Bin, 30 days), the library forgets them, and every
//! file is written down in `deletions` so Undo can put it back while the Bin
//! still has it. The same photos in Apple Photos are found and deleted in a
//! separate step, where Apple asks again (see `phone_*`).

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::params;
use serde::Serialize;

use super::{db::Db, now_ms, scan, Error, Result};

/// A photo that is used somewhere stays, whatever its review mark.
const PROTECTED: &str = "(EXISTS (SELECT 1 FROM photo_tags x WHERE x.photo_id = p.id)
    OR EXISTS (SELECT 1 FROM photo_albums x WHERE x.photo_id = p.id)
    OR EXISTS (SELECT 1 FROM post_photos x WHERE x.photo_id = p.id)
    OR EXISTS (SELECT 1 FROM photo_looks x WHERE x.photo_id = p.id)
    OR EXISTS (SELECT 1 FROM video_trims x WHERE x.photo_id = p.id)
    OR EXISTS (SELECT 1 FROM video_moments x WHERE x.photo_id = p.id)
    OR EXISTS (SELECT 1 FROM local_copies x WHERE x.photo_id = p.id)
    OR EXISTS (SELECT 1 FROM studio_piece_media x WHERE x.photo_id = p.id)
    OR EXISTS (SELECT 1 FROM albums x WHERE x.cover_photo_id = p.id)
    OR EXISTS (SELECT 1 FROM accounts x WHERE x.avatar_photo_id = p.id))";

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TripCleanup {
    /// The trip folder (a folder directly inside a source).
    pub trip: String,
    pub name: String,
    /// Rejected photos that could go.
    pub photos: usize,
    pub bytes: i64,
    pub to_delete: usize,
    pub bytes_to_delete: i64,
    pub kept: usize,
    /// Near-copies of a photo that was kept (the safest to delete).
    pub copies: usize,
    pub bytes_copies: i64,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub trips: Vec<TripCleanup>,
    /// Rejected but used somewhere, so never offered.
    pub protected: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    /// "delete", "keep", or None (not looked at yet: kept).
    pub mark: Option<String>,
    pub bytes: i64,
    /// The quick-mark groups it belongs to: "copy" (a near-copy of a kept photo),
    /// "scene" (every similar shot of it was rejected), "soft", "utility"
    /// (a document, receipt or screen).
    pub sets: Vec<&'static str>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BinReport {
    pub batch: String,
    pub photos: usize,
    pub bytes: i64,
    /// Filenames that couldn't go, with why (those photos stay, untouched).
    pub failed: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub batch: String,
    pub trip: String,
    pub name: String,
    pub deleted_ms: i64,
    pub photos: usize,
    pub bytes: i64,
    pub restored: bool,
    /// Photos found in Apple Photos, and how many of those were deleted there.
    pub phone_found: usize,
    pub phone_deleted: usize,
    /// True once the phone step was offered (found or not).
    pub phone_checked: bool,
}

struct Row {
    id: String,
    trip: String,
    mark: Option<String>,
    bytes: i64,
    sets: Vec<&'static str>,
}

/// Every rejected, unprotected photo with its trip, oldest first.
fn candidates(db: &Db, website: &HashSet<String>) -> Result<(Vec<Row>, usize)> {
    db.read(|c| {
        let mut st = c.prepare(&format!(
            "SELECT p.id, s.path, a.dir, m.mark,
                    (SELECT COALESCE(SUM(x.size), 0) FROM assets x WHERE x.photo_id = p.id),
                    {PROTECTED},
                    pa.burst_id IS NOT NULL AND EXISTS (SELECT 1 FROM photo_analysis b JOIN photos q ON q.id = b.photo_id
                        WHERE b.burst_id = pa.burst_id AND q.review_state IN ('selected', 'maybe')),
                    pa.burst_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM photo_analysis b JOIN photos q ON q.id = b.photo_id
                        WHERE b.burst_id = pa.burst_id AND q.review_state != 'rejected'),
                    COALESCE(pa.sharpness < {soft}, 0),
                    COALESCE(pa.utility, 0)
             FROM photos p
             JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
             JOIN sources s ON s.id = a.source_id
             LEFT JOIN cleanup_marks m ON m.photo_id = p.id
             LEFT JOIN photo_analysis pa ON pa.photo_id = p.id
             WHERE p.review_state = 'rejected' AND a.storage_state != 'missing'
             ORDER BY p.captured_at, p.id",
            soft = super::auto::SOFT_BELOW
        ))?;
        let mut protected = 0;
        let mut rows = Vec::new();
        let mut q = st.query([])?;
        while let Some(r) = q.next()? {
            let id: String = r.get(0)?;
            if r.get::<_, bool>(5)? || website.contains(&id) {
                protected += 1;
                continue;
            }
            let (root, dir): (String, String) = (r.get(1)?, r.get(2)?);
            let sets = [(6, "copy"), (7, "scene"), (8, "soft"), (9, "utility")]
                .into_iter()
                .filter_map(|(i, name)| r.get::<_, bool>(i).ok().filter(|b| *b).map(|_| name))
                .collect();
            rows.push(Row { trip: trip_of(&root, &dir), id, mark: r.get(3)?, bytes: r.get(4)?, sets });
        }
        Ok((rows, protected))
    })
}

/// CAMERA/THAILAND/PAI/IPHONE → CAMERA/THAILAND (the folder directly inside the source).
fn trip_of(root: &str, dir: &str) -> String {
    let rest = dir.strip_prefix(root).unwrap_or("").trim_start_matches('/');
    match rest.split('/').next().filter(|s| !s.is_empty()) {
        Some(top) => format!("{root}/{top}"),
        None => root.to_owned(),
    }
}

fn name_of(trip: &str) -> String {
    Path::new(trip).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// What could be cleaned up, trip by trip.
pub fn overview(db: &Db, website: &HashSet<String>) -> Result<Overview> {
    let (rows, protected) = candidates(db, website)?;
    let mut trips: BTreeMap<String, TripCleanup> = BTreeMap::new();
    for r in rows {
        let t = trips.entry(r.trip.clone()).or_insert_with(|| TripCleanup { name: name_of(&r.trip), trip: r.trip.clone(), ..Default::default() });
        t.photos += 1;
        t.bytes += r.bytes;
        if r.sets.contains(&"copy") {
            t.copies += 1;
            t.bytes_copies += r.bytes;
        }
        match r.mark.as_deref() {
            Some("delete") => {
                t.to_delete += 1;
                t.bytes_to_delete += r.bytes;
            }
            Some("keep") => t.kept += 1,
            _ => {}
        }
    }
    let mut trips: Vec<TripCleanup> = trips.into_values().collect();
    trips.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    Ok(Overview { trips, protected })
}

/// The photos of one trip that could go, oldest first, with their marks.
pub fn trip_photos(db: &Db, trip: &str, website: &HashSet<String>) -> Result<Vec<Candidate>> {
    Ok(candidates(db, website)?.0.into_iter().filter(|r| r.trip == trip).map(|r| Candidate { id: r.id, mark: r.mark, bytes: r.bytes, sets: r.sets }).collect())
}

/// Marks photos "delete" or "keep" (None clears the mark: kept, not looked at).
/// Only rejected photos take a mark.
pub fn mark(db: &Db, ids: &[String], mark: Option<&str>) -> Result<usize> {
    if mark.is_some_and(|m| m != "delete" && m != "keep") {
        return Err(Error::Invalid(format!("unknown mark {mark:?}")));
    }
    db.write(|c| {
        let tx = c.transaction()?;
        let mut n = 0;
        for id in ids {
            n += match mark {
                Some(m) => tx.execute(
                    "INSERT INTO cleanup_marks (photo_id, mark, marked_ms)
                     SELECT id, ?2, ?3 FROM photos WHERE id = ?1 AND review_state = 'rejected'
                     ON CONFLICT (photo_id) DO UPDATE SET mark = excluded.mark, marked_ms = excluded.marked_ms",
                    params![id, m, now_ms()],
                )?,
                None => tx.execute("DELETE FROM cleanup_marks WHERE photo_id = ?1", [id])?,
            };
        }
        tx.commit()?;
        Ok(n)
    })
}

/// Marks every candidate in a quick-mark group ("copy", "scene", "soft",
/// "utility"), in every trip, "delete" (or clears the mark with None). Only
/// marks: deleting stays one trip at a time.
pub fn mark_set(db: &Db, set: &str, mark_as: Option<&str>, website: &HashSet<String>) -> Result<usize> {
    let ids: Vec<String> = candidates(db, website)?.0.into_iter().filter(|r| r.sets.contains(&set)).map(|r| r.id).collect();
    mark(db, &ids, mark_as)
}

/// What the Bin did with each path: where it went, or why it couldn't.
pub type Binner<'a> = &'a dyn Fn(&[String]) -> Vec<std::result::Result<String, String>>;

/// Sends one trip's photos marked "delete" to the Bin. `expected` are the
/// photos the person confirmed: unless exactly those are marked (and still
/// unprotected) now, nothing happens.
pub fn bin_trip(db: &Db, trip: &str, expected: &[String], website: &HashSet<String>, trash: Binner) -> Result<BinReport> {
    let doomed: Vec<String> = trip_photos(db, trip, website)?.into_iter().filter(|c| c.mark.as_deref() == Some("delete")).map(|c| c.id).collect();
    let (now_set, asked): (HashSet<&String>, HashSet<&String>) = (doomed.iter().collect(), expected.iter().collect());
    if expected.is_empty() || now_set != asked {
        return Err(Error::Invalid(format!("The photos marked to delete in {} changed ({} now, {} confirmed): look again before deleting.", name_of(trip), doomed.len(), expected.len())));
    }
    struct File {
        asset_id: String,
        source_id: String,
        path: String,
        filename: String,
        size: i64,
        is_primary: bool,
        stem: String,
    }
    struct Photo {
        id: String,
        captured_at: String,
        review_state: String,
        files: Vec<File>,
    }
    let photos: Vec<Photo> = db.read(|c| {
        let mut ps = c.prepare("SELECT captured_at, review_state FROM photos WHERE id = ?1")?;
        let mut fs = c.prepare("SELECT id, source_id, path, filename, size, is_primary, stem FROM assets WHERE photo_id = ?1 AND storage_state != 'missing' ORDER BY is_primary DESC")?;
        doomed
            .iter()
            .map(|id| {
                let (captured_at, review_state) = ps.query_row([id], |r| Ok((r.get(0)?, r.get(1)?)))?;
                let files = fs
                    .query_map([id], |r| {
                        let path: String = r.get(2)?;
                        let filename: String = r.get(3)?;
                        let stem = Path::new(&filename).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                        Ok(File { asset_id: r.get(0)?, source_id: r.get(1)?, path, filename, size: r.get(4)?, is_primary: r.get(5)?, stem })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(Photo { id: id.clone(), captured_at, review_state, files })
            })
            .collect()
    })?;
    let paths: Vec<String> = photos.iter().flat_map(|p| p.files.iter().map(|f| f.path.clone())).collect();
    let results = trash(&paths);
    if results.len() != paths.len() {
        return Err(Error::Invalid("the Bin didn't answer for every file; nothing was recorded".into()));
    }
    let mut landed = results.into_iter();
    let batch = format!("{}-{}", now_ms(), &name_of(trip));
    let mut report = BinReport { batch: batch.clone(), ..Default::default() };
    let now = now_ms();
    db.write(|c| {
        let tx = c.transaction()?;
        for p in &photos {
            let outcome: Vec<std::result::Result<String, String>> = p.files.iter().map(|_| landed.next().unwrap()).collect();
            if let Some(why) = outcome.iter().find_map(|o| o.as_ref().err()) {
                // Part of a pair went: the photo isn't gone, so its files stay in the
                // library; what went is written down, so Undo can bring it back.
                report.failed.push(format!("{}: {why}", p.files.first().map(|f| f.filename.as_str()).unwrap_or("?")));
                for (f, o) in p.files.iter().zip(&outcome) {
                    if let Ok(binned) = o {
                        record(&tx, &batch, trip, p, f.path.as_str(), binned, f.size, f.is_primary, &f.stem, &f.source_id, now)?;
                        tx.execute("UPDATE assets SET storage_state = 'missing' WHERE id = ?1", [&f.asset_id])?;
                    }
                }
                continue;
            }
            for (f, o) in p.files.iter().zip(&outcome) {
                record(&tx, &batch, trip, p, &f.path, o.as_ref().unwrap(), f.size, f.is_primary, &f.stem, &f.source_id, now)?;
                tx.execute("DELETE FROM finder_tags WHERE asset_id = ?1", [&f.asset_id])?;
                tx.execute("DELETE FROM archived_assets WHERE asset_id = ?1", [&f.asset_id])?;
                tx.execute("DELETE FROM assets WHERE id = ?1", [&f.asset_id])?;
                report.bytes += f.size;
            }
            // Files that were already gone before (missing) go with it.
            for sql in [
                "DELETE FROM finder_tags WHERE asset_id IN (SELECT id FROM assets WHERE photo_id = ?1 AND storage_state = 'missing')",
                "DELETE FROM archived_assets WHERE asset_id IN (SELECT id FROM assets WHERE photo_id = ?1 AND storage_state = 'missing')",
                "DELETE FROM local_copies WHERE asset_id IN (SELECT id FROM assets WHERE photo_id = ?1 AND storage_state = 'missing')",
                "DELETE FROM assets WHERE photo_id = ?1 AND storage_state = 'missing'",
            ] {
                tx.execute(sql, [&p.id])?;
            }
            tx.execute("DELETE FROM photos WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM assets WHERE photo_id = ?1)", [&p.id])?;
            report.photos += 1;
        }
        tx.commit()?;
        Ok(())
    })?;

    #[allow(clippy::too_many_arguments)]
    fn record(tx: &rusqlite::Transaction, batch: &str, trip: &str, p: &Photo, original: &str, binned: &str, size: i64, is_primary: bool, stem: &str, source_id: &str, now: i64) -> rusqlite::Result<()> {
        tx.execute(
            "INSERT INTO deletions (batch, trip, photo_id, source_id, original, binned, size, is_primary, stem, captured_at, review_state, deleted_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![batch, trip, p.id, source_id, original, binned, size, is_primary, stem, p.captured_at, p.review_state, now],
        )?;
        Ok(())
    }
    Ok(report)
}

/// Every clean up so far, newest first.
pub fn history(db: &Db) -> Result<Vec<Batch>> {
    db.read(|c| {
        let mut st = c.prepare(
            "SELECT batch, trip, MIN(deleted_ms), COUNT(DISTINCT photo_id), SUM(size), MAX(restored_ms IS NOT NULL),
                    COUNT(DISTINCT CASE WHEN phone_id IS NOT NULL THEN photo_id END),
                    COUNT(DISTINCT CASE WHEN phone_state = 'deleted' THEN photo_id END),
                    MAX(phone_state IS NOT NULL)
             FROM deletions GROUP BY batch ORDER BY MIN(deleted_ms) DESC",
        )?;
        let rows = st
            .query_map([], |r| {
                let trip: String = r.get(1)?;
                Ok(Batch {
                    batch: r.get(0)?,
                    name: name_of(&trip),
                    trip,
                    deleted_ms: r.get(2)?,
                    photos: r.get::<_, i64>(3)? as usize,
                    bytes: r.get(4)?,
                    restored: r.get(5)?,
                    phone_found: r.get::<_, i64>(6)? as usize,
                    phone_deleted: r.get::<_, i64>(7)? as usize,
                    phone_checked: r.get(8)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// Where each binned file should go back to, or why it can't.
pub type Restorer<'a> = &'a dyn Fn(&[(String, String)]) -> Vec<std::result::Result<(), String>>;

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UndoReport {
    pub photos: usize,
    pub failed: Vec<String>,
}

/// Puts a clean up back: files return from the Bin to where they were, the
/// library finds them again, and they are Rejected (and marked "delete") as before.
pub fn undo(db: &Db, batch: &str, restore: Restorer) -> Result<UndoReport> {
    let files: Vec<(i64, String, String, String, String)> = db.read(|c| {
        let mut st = c.prepare("SELECT id, source_id, original, binned, review_state FROM deletions WHERE batch = ?1 AND restored_ms IS NULL ORDER BY is_primary DESC")?;
        let rows = st.query_map([batch], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })?;
    let pairs: Vec<(String, String)> = files.iter().map(|f| (f.3.clone(), f.2.clone())).collect();
    let results = restore(&pairs);
    let mut report = UndoReport::default();
    let mut back: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    let mut states: Vec<(String, String)> = Vec::new();
    for (f, r) in files.iter().zip(results) {
        match r {
            Ok(()) => {
                db.write(|c| Ok(c.execute("UPDATE deletions SET restored_ms = ?2 WHERE id = ?1", params![f.0, now_ms()])?))?;
                back.entry(f.1.clone()).or_default().push(PathBuf::from(&f.2));
                states.push((f.2.clone(), f.4.clone()));
            }
            Err(why) => report.failed.push(format!("{}: {why}", Path::new(&f.2).file_name().map(|n| n.to_string_lossy()).unwrap_or_default())),
        }
    }
    #[cfg(target_os = "macos")]
    let read_meta: scan::MetadataReader = &super::media::read_metadata;
    #[cfg(not(target_os = "macos"))]
    let read_meta: scan::MetadataReader = &|_| None;
    for (source, paths) in &back {
        // A file that was only marked missing (half a pair) is found again by its path.
        db.write(|c| {
            for p in paths {
                c.execute("UPDATE assets SET storage_state = 'local' WHERE path = ?1 AND storage_state = 'missing'", [p.to_string_lossy()])?;
            }
            Ok(())
        })?;
        scan::index_files(db, source, paths, read_meta)?;
    }
    db.write(|c| {
        let tx = c.transaction()?;
        let mut photos = HashSet::new();
        for (path, state) in &states {
            if let Some(pid) = tx.query_row("SELECT photo_id FROM assets WHERE path = ?1", [path], |r| r.get::<_, String>(0)).ok() {
                tx.execute("UPDATE photos SET review_state = ?2, reviewed_ms = COALESCE(reviewed_ms, ?3) WHERE id = ?1", params![pid, state, now_ms()])?;
                if state == "rejected" {
                    tx.execute(
                        "INSERT INTO cleanup_marks (photo_id, mark, marked_ms) VALUES (?1, 'delete', ?2)
                         ON CONFLICT (photo_id) DO UPDATE SET mark = 'delete'",
                        params![pid, now_ms()],
                    )?;
                }
                photos.insert(pid);
            }
        }
        tx.commit()?;
        report.photos = photos.len();
        Ok(())
    })?;
    Ok(report)
}

/// What Apple Photos is asked to look for: one line per deleted photo (its
/// main file's name and the local time it was taken), keyed by photo id.
pub fn phone_queries(db: &Db, batch: &str) -> Result<Vec<(String, String, String)>> {
    db.read(|c| {
        let mut st = c.prepare("SELECT photo_id, stem, captured_at FROM deletions WHERE batch = ?1 AND is_primary = 1 AND restored_ms IS NULL AND phone_state IS NULL")?;
        let rows = st.query_map([batch], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// Writes down which deleted photos were found in Apple Photos (and that the
/// rest weren't), so the phone step can show the count and ask.
pub fn phone_found(db: &Db, batch: &str, found: &[(String, String)]) -> Result<usize> {
    db.write(|c| {
        let tx = c.transaction()?;
        tx.execute("UPDATE deletions SET phone_state = 'not_found' WHERE batch = ?1 AND phone_state IS NULL AND restored_ms IS NULL", [batch])?;
        for (photo, phone) in found {
            tx.execute("UPDATE deletions SET phone_id = ?3, phone_state = 'found' WHERE batch = ?1 AND photo_id = ?2", params![batch, photo, phone])?;
        }
        tx.commit()?;
        Ok(found.len())
    })
}

/// The Apple Photos ids still to delete for a batch.
pub fn phone_ids(db: &Db, batch: &str) -> Result<Vec<String>> {
    db.read(|c| {
        let mut st = c.prepare("SELECT DISTINCT phone_id FROM deletions WHERE batch = ?1 AND phone_state = 'found' AND phone_id IS NOT NULL")?;
        let rows = st.query_map([batch], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(rows)
    })
}

/// After Apple's question: "deleted" or "cancelled" for the photos that were found.
pub fn phone_done(db: &Db, batch: &str, state: &str) -> Result<usize> {
    db.write(|c| Ok(c.execute("UPDATE deletions SET phone_state = ?2 WHERE batch = ?1 AND phone_state IN ('found', 'cancelled')", params![batch, state])?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trips_are_the_folder_inside_the_source() {
        assert_eq!(trip_of("/D/CAMERA", "/D/CAMERA/THAILAND/PAI/IPHONE"), "/D/CAMERA/THAILAND");
        assert_eq!(trip_of("/D/CAMERA", "/D/CAMERA/EGYPT"), "/D/CAMERA/EGYPT");
        assert_eq!(trip_of("/D/CAMERA", "/D/CAMERA"), "/D/CAMERA");
    }
}
