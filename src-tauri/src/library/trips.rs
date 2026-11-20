//! Trips: the folders directly inside a source folder (CAMERA/EGYPT). Photos can
//! be moved from one trip to another: their files are renamed into the other
//! trip's folder, keeping the subfolder they were in (EGYPT/IPHONE goes to
//! FRANCE/IPHONE), and the library follows in the same step. Photos can also be
//! renamed ("Studio Example 01"…). This is the one place the app changes source
//! files (renames only, never their contents), and only when asked.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::{db::Db, now_ms, Error, Result};

/// One file's move, kept so it can be undone.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileMove {
    pub asset_id: String,
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MoveReport {
    pub moved: usize,
    /// Already in that trip.
    pub already: usize,
    /// Filenames that couldn't be moved, with why.
    pub failed: Vec<String>,
    /// Hand back to `undo` to put everything where it was.
    pub undo: Vec<FileMove>,
}

struct Asset {
    id: String,
    path: String,
    filename: String,
    root: String,
}

/// Moves photos into `trip`: a folder directly inside one of the sources, made
/// when it doesn't exist yet (a new trip).
pub fn move_to_trip(db: &Db, photo_ids: &[String], trip: &str) -> Result<MoveReport> {
    let trip = trip.trim_end_matches('/');
    let name = Path::new(trip).file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.is_empty() || name.starts_with('.') {
        return Err(Error::Invalid(format!("not a trip name: {name:?}")));
    }
    let parent = Path::new(trip).parent().and_then(|p| p.to_str()).unwrap_or("").to_owned();

    let mut report = MoveReport::default();
    for pid in photo_ids {
        let assets = assets_of(db, pid)?;
        let Some(first) = assets.first() else { continue };
        if first.root != parent {
            report.failed.push(format!("{}: in another source folder", first.filename));
            continue;
        }
        // Where each file goes: the same place under the other trip.
        let targets: Vec<PathBuf> = assets
            .iter()
            .map(|a| {
                let rel = a.path.strip_prefix(&a.root).unwrap_or(&a.path).trim_start_matches('/');
                let under_trip = rel.split_once('/').map_or("", |(_, rest)| rest);
                Path::new(trip).join(under_trip)
            })
            .collect();
        if assets.iter().zip(&targets).all(|(a, t)| Path::new(&a.path) == t) {
            report.already += 1;
            continue;
        }
        let targets = free_names(&targets);
        let moves: Vec<FileMove> = assets
            .iter()
            .zip(targets)
            .map(|(a, to)| FileMove { asset_id: a.id.clone(), from: a.path.clone(), to: to.to_string_lossy().into_owned() })
            .collect();
        match apply(db, &moves) {
            Ok(()) => {
                report.moved += 1;
                report.undo.extend(moves);
            }
            Err(e) => report.failed.push(format!("{}: {e}", first.filename)),
        }
    }
    Ok(report)
}

/// Moves photos from `from` (a folder they're in) into `to` (a folder in the same
/// source), keeping whatever lies between: THAILAND/IPHONE/x.jpg moved from
/// THAILAND to THAILAND/PAI lands in THAILAND/PAI/IPHONE/x.jpg. Photos outside
/// `from` are left alone (counted as already there).
pub fn move_into(db: &Db, photo_ids: &[String], from: &str, to: &str) -> Result<MoveReport> {
    let (from, to) = (from.trim_end_matches('/'), to.trim_end_matches('/'));
    let mut report = MoveReport::default();
    for pid in photo_ids {
        let assets = assets_of(db, pid)?;
        let Some(first) = assets.first() else { continue };
        if !to.starts_with(&format!("{}/", first.root)) {
            report.failed.push(format!("{}: {to} is in another source folder", first.filename));
            continue;
        }
        let inside: Option<Vec<PathBuf>> = assets
            .iter()
            .map(|a| a.path.strip_prefix(&format!("{from}/")).map(|rest| Path::new(to).join(rest)))
            .collect();
        let Some(targets) = inside else {
            report.already += 1;
            continue;
        };
        let targets = free_names(&targets);
        let moves: Vec<FileMove> = assets
            .iter()
            .zip(targets)
            .map(|(a, t)| FileMove { asset_id: a.id.clone(), from: a.path.clone(), to: t.to_string_lossy().into_owned() })
            .collect();
        match apply(db, &moves) {
            Ok(()) => {
                report.moved += 1;
                report.undo.extend(moves);
            }
            Err(e) => report.failed.push(format!("{}: {e}", first.filename)),
        }
    }
    Ok(report)
}

/// Copies files from elsewhere (a download, an AirDrop, a phone export) into a
/// folder of one of the sources, and adds them to the library. The files they
/// were copied from stay where they are; a name already taken there gets " 2".
/// Returns the new photos' ids in the order given (a RAW + JPEG pair is one photo).
pub fn add_files(db: &Db, files: &[PathBuf], folder: &Path, read_meta: super::scan::MetadataReader) -> Result<Vec<String>> {
    // Inside a library folder, checked before anything is created.
    let within = |f: &Path| super::sources::list(db).map(|all| all.into_iter().find(|s| f.starts_with(&s.path)));
    if within(folder)?.is_none() && within(&std::fs::canonicalize(folder.parent().unwrap_or(folder)).unwrap_or_default())?.is_none() {
        return Err(Error::Invalid(format!("{} isn't inside one of the library's folders", folder.display())));
    }
    std::fs::create_dir_all(folder)?;
    let folder = std::fs::canonicalize(folder)?;
    let source = within(&folder)?.ok_or_else(|| Error::Invalid(format!("{} isn't inside one of the library's folders", folder.display())))?;
    let usable: Vec<&PathBuf> = files
        .iter()
        .filter(|f| f.extension().and_then(|e| e.to_str()).and_then(super::model::Format::from_extension).is_some())
        .collect();
    if usable.is_empty() {
        return Err(Error::Invalid("None of those are photos or videos the library can open.".into()));
    }
    let mut copied = Vec::new();
    for f in usable {
        let name = f.file_name().ok_or_else(|| Error::Invalid(format!("{} has no name", f.display())))?;
        let target = free_names(&[folder.join(name)]).remove(0);
        std::fs::copy(f, &target)?;
        copied.push(target);
    }
    super::scan::index_files(db, &source.id, &copied, read_meta)?;
    let mut ids: Vec<String> = Vec::new();
    db.read(|c| {
        let mut st = c.prepare("SELECT photo_id FROM assets WHERE path = ?1")?;
        for p in &copied {
            if let Ok(id) = st.query_row([p.to_string_lossy()], |r| r.get::<_, String>(0)) {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
        Ok(())
    })?;
    Ok(ids)
}

/// Renames photos to "<name> 01", "<name> 02"… in shooting order, each in its
/// own folder (a RAW and its JPEG keep one name; a number another photo already
/// uses is skipped), counting from `first`. Undo with `undo`.
pub fn rename_photos(db: &Db, photo_ids: &[String], name: &str, first: usize) -> Result<MoveReport> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('.') || name.contains('/') || name.contains(':') {
        return Err(Error::Invalid(format!("not a name for files: {name:?}")));
    }
    let mut ordered: Vec<(String, String)> = db.read(|c| {
        let mut stmt = c.prepare("SELECT captured_at FROM photos WHERE id = ?1")?;
        let mut out = Vec::new();
        for id in photo_ids {
            if let Ok(at) = stmt.query_row([id], |r| r.get::<_, String>(0)) {
                out.push((at, id.clone()));
            }
        }
        Ok(out)
    })?;
    ordered.sort();
    let width = (first + ordered.len()).to_string().len().max(2);
    let mut report = MoveReport::default();
    let mut n = first.max(1) - 1;
    for (_, pid) in ordered {
        let assets = assets_of(db, &pid)?;
        if assets.is_empty() {
            continue;
        }
        // The next number whose files are all free (or already this photo's own).
        let targets = loop {
            n += 1;
            let stem = format!("{name} {n:0width$}");
            let ts: Vec<PathBuf> = assets
                .iter()
                .map(|a| {
                    let p = Path::new(&a.path);
                    let ext = p.extension().and_then(|e| e.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
                    p.with_file_name(format!("{stem}{ext}"))
                })
                .collect();
            let free = assets.iter().zip(&ts).all(|(a, t)| Path::new(&a.path) == t || std::fs::symlink_metadata(t).is_err());
            if free {
                break ts;
            }
        };
        let moves: Vec<FileMove> = assets
            .iter()
            .zip(targets)
            .filter(|(a, t)| Path::new(&a.path) != t)
            .map(|(a, t)| FileMove { asset_id: a.id.clone(), from: a.path.clone(), to: t.to_string_lossy().into_owned() })
            .collect();
        if moves.is_empty() {
            report.already += 1;
            continue;
        }
        match apply(db, &moves) {
            Ok(()) => {
                report.moved += 1;
                report.undo.extend(moves);
            }
            Err(e) => report.failed.push(format!("{}: {e}", assets[0].filename)),
        }
    }
    Ok(report)
}

/// Renames one photo's files to `stem` (each keeps its own extension), files
/// and library together. Returns the moves for undo; empty when already named.
pub fn rename_to(db: &Db, photo_id: &str, stem: &str) -> Result<Vec<FileMove>> {
    if stem.is_empty() || stem.starts_with('.') || stem.contains('/') || stem.contains(':') {
        return Err(Error::Invalid(format!("not a name for files: {stem:?}")));
    }
    let assets = assets_of(db, photo_id)?;
    let moves: Vec<FileMove> = assets
        .iter()
        .map(|a| {
            let p = Path::new(&a.path);
            let ext = p.extension().and_then(|e| e.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
            FileMove { asset_id: a.id.clone(), from: a.path.clone(), to: p.with_file_name(format!("{stem}{ext}")).to_string_lossy().into_owned() }
        })
        .filter(|m| m.from != m.to)
        .collect();
    if !moves.is_empty() {
        apply(db, &moves)?;
    }
    Ok(moves)
}

/// Puts moved files back where they were.
pub fn undo(db: &Db, moves: &[FileMove]) -> Result<usize> {
    let back: Vec<FileMove> = moves.iter().map(|m| FileMove { asset_id: m.asset_id.clone(), from: m.to.clone(), to: m.from.clone() }).collect();
    let mut done = 0;
    for m in &back {
        apply(db, std::slice::from_ref(m))?;
        done += 1;
    }
    Ok(done)
}

/// Renames the files of one photo and points the library at the new paths, all
/// or nothing. Runs under the write lock so a scan can't see the files halfway.
fn apply(db: &Db, moves: &[FileMove]) -> Result<()> {
    db.write(|c| {
        let mut done: Vec<&FileMove> = Vec::new();
        let result = (|| -> Result<()> {
            for m in moves {
                let to = Path::new(&m.to);
                if std::fs::symlink_metadata(to).is_ok() {
                    return Err(Error::Invalid(format!("{} already exists", m.to)));
                }
                if let Some(dir) = to.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                std::fs::rename(&m.from, to)?;
                done.push(m);
            }
            let tx = c.transaction()?;
            for m in moves {
                let to = Path::new(&m.to);
                let filename = to.file_name().and_then(|n| n.to_str()).unwrap_or_default();
                let stem = to.file_stem().and_then(|n| n.to_str()).unwrap_or_default().to_lowercase();
                let dir = to.parent().and_then(|d| d.to_str()).unwrap_or_default();
                tx.execute(
                    "UPDATE assets SET path = ?2, dir = ?3, filename = ?4, stem = ?5, updated_ms = ?6 WHERE id = ?1",
                    params![m.asset_id, m.to, dir, filename, stem, now_ms()],
                )?;
            }
            tx.commit()?;
            Ok(())
        })();
        if result.is_err() {
            for m in done.iter().rev() {
                let _ = std::fs::rename(&m.to, &m.from);
            }
        }
        result
    })
}

/// A photo's files that are on disk, the primary first, with their source folder.
fn assets_of(db: &Db, photo_id: &str) -> Result<Vec<Asset>> {
    db.read(|c| {
        let mut stmt = c.prepare(
            "SELECT a.id, a.path, a.filename, s.path FROM assets a JOIN sources s ON s.id = a.source_id
             WHERE a.photo_id = ?1 AND a.storage_state != 'missing' ORDER BY a.is_primary DESC, a.path",
        )?;
        let rows = stmt
            .query_map([photo_id], |r| Ok(Asset { id: r.get(0)?, path: r.get(1)?, filename: r.get(2)?, root: r.get::<_, String>(3)?.trim_end_matches('/').to_owned() }))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

/// The targets, or when any is taken, all of them with the same " 2" (" 3"…)
/// added to the name, so a RAW and its JPEG keep matching names.
fn free_names(targets: &[PathBuf]) -> Vec<PathBuf> {
    let taken = |ts: &[PathBuf]| ts.iter().any(|t| std::fs::symlink_metadata(t).is_ok());
    if !taken(targets) {
        return targets.to_vec();
    }
    (2..)
        .map(|n| {
            targets
                .iter()
                .map(|t| {
                    let stem = t.file_stem().and_then(|s| s.to_str()).unwrap_or("photo");
                    let name = match t.extension().and_then(|e| e.to_str()) {
                        Some(ext) => format!("{stem} {n}.{ext}"),
                        None => format!("{stem} {n}"),
                    };
                    t.with_file_name(name)
                })
                .collect::<Vec<_>>()
        })
        .find(|ts| !taken(ts))
        .expect("a free name")
}

/// A photo whose GPS puts it far from the rest of its trip.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Misplaced {
    pub id: String,
    /// The trip it was most likely taken on (its folder), when one is near.
    pub near: Option<String>,
}

/// Further than this from the middle of its trip, a photo was taken elsewhere.
const FAR_KM: f64 = 500.0;
/// A trip needs this many photos with GPS before its middle means anything.
const MIN_GPS: usize = 5;

/// The photos in `trip` (or any folder under it) taken far from where the rest
/// of that trip was, each with the trip it most likely belongs to.
pub fn misplaced(db: &Db, trip: &str) -> Result<Vec<Misplaced>> {
    let rows: Vec<(String, String, String, f64, f64)> = db.read(|c| {
        let mut stmt = c.prepare(
            "SELECT p.id, s.path, a.dir, p.latitude, p.longitude FROM photos p
             JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1 JOIN sources s ON s.id = a.source_id
             WHERE p.latitude IS NOT NULL AND p.longitude IS NOT NULL AND a.storage_state != 'missing'",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    // Each photo's trip folder.
    let trip_of = |root: &str, dir: &str| -> Option<String> {
        let root = root.trim_end_matches('/');
        let first = dir.strip_prefix(root)?.trim_start_matches('/').split('/').next().filter(|s| !s.is_empty())?;
        Some(format!("{root}/{first}"))
    };
    let mut spots: BTreeMap<String, Vec<(f64, f64)>> = BTreeMap::new();
    let mut photos: Vec<(String, String, (f64, f64))> = Vec::new();
    for (id, root, dir, lat, lon) in rows {
        if let Some(t) = trip_of(&root, &dir) {
            spots.entry(t.clone()).or_default().push((lat, lon));
            photos.push((id, t, (lat, lon)));
        }
    }
    let middles: HashMap<String, (f64, f64)> = spots
        .into_iter()
        .filter(|(_, s)| s.len() >= MIN_GPS)
        .map(|(t, s)| (t, (median(s.iter().map(|p| p.0).collect()), median(s.iter().map(|p| p.1).collect()))))
        .collect();
    let trip = trip.trim_end_matches('/');
    let mut out = Vec::new();
    for (id, t, at) in photos {
        if !(trip == t || trip.starts_with(&format!("{t}/"))) {
            continue;
        }
        let Some(&middle) = middles.get(&t) else { continue };
        if km(at, middle) <= FAR_KM {
            continue;
        }
        let near = middles
            .iter()
            .filter(|(other, _)| **other != t)
            .map(|(other, m)| (other, km(at, *m)))
            .filter(|(_, d)| *d <= FAR_KM)
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(other, _)| other.clone());
        out.push(Misplaced { id, near });
    }
    Ok(out)
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

/// Great-circle distance in km.
fn km(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (la1, lo1, la2, lo2) = (a.0.to_radians(), a.1.to_radians(), b.0.to_radians(), b.1.to_radians());
    let h = ((la2 - la1) / 2.0).sin().powi(2) + la1.cos() * la2.cos() * ((lo2 - lo1) / 2.0).sin().powi(2);
    6371.0 * 2.0 * h.sqrt().asin()
}

