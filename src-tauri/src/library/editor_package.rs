//! Stable working copies for an external editor. Metadata-only planning; no
//! hydration, original edits, database writes, or reliance on evictable proxies.
use super::{db::Db, new_id, scan, thumbs, Error, Result};
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

pub const RESERVE: u64 = 10_000_000_000;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub photo_id: String,
    pub filename: String,
    pub bytes: u64,
    pub status: String,
    pub note: String,
    #[serde(skip)]
    source: Option<PathBuf>,
    #[serde(skip)]
    modified: Option<std::time::SystemTime>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub key: String,
    pub title: String,
    pub destination: String,
    pub items: Vec<Item>,
    pub bytes: u64,
    pub free: u64,
    pub reserve: u64,
    pub allowed: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub piece_id: String,
    pub current: String,
    pub done: usize,
    pub total: usize,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub stage: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub path: String,
    pub files: usize,
    pub bytes: u64,
}

fn local(path: &Path, size: u64) -> Option<fs::Metadata> {
    let meta = fs::symlink_metadata(path).ok()?;
    (meta.is_file() && !scan::is_dataless(&meta) && meta.len() == size).then_some(meta)
}

fn destination(db: &Db, path: &Path) -> Result<PathBuf> {
    let path = fs::canonicalize(path)?;
    if !path.is_dir() {
        return Err(Error::Invalid(
            "Choose an existing destination folder.".into(),
        ));
    }
    if db
        .path()
        .parent()
        .map(|p| fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()))
        .is_some_and(|p| path.starts_with(p))
    {
        return Err(Error::Invalid(
            "Choose a working folder outside the app's library/cache.".into(),
        ));
    }
    let label = path.to_string_lossy();
    if label.contains("/Library/CloudStorage/") || label.contains("/Library/Mobile Documents/") {
        return Err(Error::Invalid("Choose an ordinary local folder or external drive. Cloud-managed working copies can become online-only again.".into()));
    }
    for source in super::sources::list(db)? {
        let root = fs::canonicalize(&source.path).unwrap_or_else(|_| PathBuf::from(&source.path));
        if path.starts_with(root) {
            return Err(Error::Invalid("Choose a destination outside your indexed source folders, so working copies do not become duplicate originals.".into()));
        }
    }
    Ok(path)
}

/// Uses stat only, including for cloud placeholders. Never opens media.
pub fn plan(db: &Db, piece: &str, folder: &Path) -> Result<Plan> {
    plan_with_space(db, piece, folder, thumbs::free_bytes)
}
fn plan_with_space(db: &Db, piece: &str, folder: &Path, space: fn(&Path) -> u64) -> Result<Plan> {
    let dest = destination(db, folder)?;
    let (title, rows) = db.read(|c| {
        let title: String = c.query_row(
            "SELECT title FROM studio_pieces WHERE id=?1",
            [piece],
            |r| r.get(0),
        )?;
        let mut st = c.prepare(
            "SELECT p.id, a.filename, a.path, a.size, a.is_raw, lc.path
            FROM studio_piece_media m JOIN photos p ON p.id=m.photo_id
            LEFT JOIN assets a ON a.photo_id=p.id AND a.is_primary=1
            LEFT JOIN local_copies lc ON lc.asset_id=a.id
            WHERE m.piece_id=?1 ORDER BY m.position, m.added_ms, p.id",
        )?;
        let rows = st
            .query_map([piece], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, Option<bool>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok((title, rows))
    })?;
    let mut items = Vec::new();
    for (id, name, path, size, raw, offline) in rows {
        let bytes = size.unwrap_or(0).max(0) as u64;
        let mut item = Item {
            photo_id: id,
            filename: name.unwrap_or_else(|| "Unknown file".into()),
            bytes,
            status: "unavailable".into(),
            note: "Original unavailable or changed. Reconnect or rescan the source.".into(),
            source: None,
            modified: None,
        };
        if raw.unwrap_or(false) {
            item.status = "unsupported".into();
            item.note = "RAW photo: export an edited JPEG before using it in CapCut.".into();
        } else if let Some(path) = path {
            for candidate in std::iter::once(PathBuf::from(&path)).chain(offline.map(PathBuf::from))
            {
                if let Some(meta) = local(&candidate, bytes) {
                    item.status = "ready".into();
                    item.note.clear();
                    item.modified = meta.modified().ok();
                    item.source = Some(candidate);
                    break;
                }
            }
            if item.source.is_none()
                && fs::symlink_metadata(&path).is_ok_and(|m| scan::is_dataless(&m))
            {
                item.status = "online".into();
                item.note = "Original is online-only. Download it explicitly in Pictures, then check again.".into();
            }
        }
        items.push(item);
    }
    let bytes = items
        .iter()
        .try_fold(0u64, |n, i| n.checked_add(i.bytes))
        .ok_or_else(|| Error::Invalid("Project size is too large.".into()))?;
    let free = space(&dest);
    let allowed = !items.is_empty()
        && items.iter().all(|i| i.status == "ready")
        && free >= RESERVE
        && free - RESERVE >= bytes;
    let mut hash = blake3::Hasher::new();
    hash.update(dest.as_os_str().as_encoded_bytes());
    hash.update(piece.as_bytes());
    for i in &items {
        hash.update(
            serde_json::to_string(i)
                .map_err(|e| Error::Invalid(e.to_string()))?
                .as_bytes(),
        );
        hash.update(format!("{:?}{:?}", i.source, i.modified).as_bytes());
    }
    Ok(Plan {
        key: hash.finalize().to_hex().to_string(),
        title,
        destination: dest.to_string_lossy().into_owned(),
        items,
        bytes,
        free,
        reserve: RESERVE,
        allowed,
    })
}

fn stopped(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(Error::Invalid("Preparation stopped.".into()))
    } else {
        Ok(())
    }
}
fn safe_name(id: &str, name: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let stem: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(60)
        .collect();
    let id: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    let ext = Path::new(name)
        .extension()
        .unwrap_or_default()
        .to_string_lossy();
    let ext: String = ext
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(12)
        .collect();
    format!("{stem}_{id}.{ext}")
}
fn hash_file(path: &Path, cancel: &AtomicBool) -> Result<blake3::Hash> {
    let mut file = File::open(path)?;
    let mut hash = blake3::Hasher::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        stopped(cancel)?;
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(hash.finalize())
}

/// Revalidates the exact plan, then creates a unique package. Partial output is
/// deliberately kept and clearly named on failure; it is never offered as ready.
pub fn prepare(
    db: &Db,
    piece: &str,
    folder: &Path,
    key: &str,
    cancel: &AtomicBool,
    progress: impl FnMut(&Progress),
) -> Result<Report> {
    prepare_with_space(db, piece, folder, key, cancel, progress, thumbs::free_bytes)
}
fn prepare_with_space(
    db: &Db,
    piece: &str,
    folder: &Path,
    key: &str,
    cancel: &AtomicBool,
    mut progress: impl FnMut(&Progress),
    space: fn(&Path) -> u64,
) -> Result<Report> {
    let plan = plan_with_space(db, piece, folder, space)?;
    if plan.key != key {
        return Err(Error::Invalid(
            "The project or its files changed. Check the plan again before copying.".into(),
        ));
    }
    if !plan.allowed {
        return Err(Error::Invalid("Media is unavailable or the destination has insufficient free space. Check the plan again.".into()));
    }
    stopped(cancel)?;
    let partial = Path::new(&plan.destination).join(format!("CBA-{}.partial", new_id()));
    fs::create_dir(&partial)?;
    let result = (|| -> Result<Report> {
        let media = partial.join("Media");
        fs::create_dir(&media)?;
        let mut manifest = Vec::new();
        let mut p = Progress {
            piece_id: piece.into(),
            current: String::new(),
            done: 0,
            total: plan.items.len(),
            bytes_done: 0,
            bytes_total: plan.bytes,
            stage: "copying".into(),
        };
        let mut last = std::time::Instant::now();
        for item in &plan.items {
            stopped(cancel)?;
            let source = item.source.as_ref().expect("allowed plan has sources");
            let before = local(source, item.bytes).ok_or_else(|| {
                Error::Invalid("An original is no longer local. Check the plan again.".into())
            })?;
            if before.modified().ok() != item.modified {
                return Err(Error::Invalid(
                    "An original changed during preparation.".into(),
                ));
            }
            let name = safe_name(&item.photo_id, &item.filename);
            let output = media.join(&name);
            let mut input = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(source)?;
            let mut out = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&output)?;
            let mut hash = blake3::Hasher::new();
            let mut buffer = vec![0; 1024 * 1024];
            let mut copied = 0u64;
            p.current = item.filename.clone();
            p.stage = "copying".into();
            progress(&p);
            loop {
                stopped(cancel)?;
                let n = input.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                if space(&partial) < RESERVE + n as u64 {
                    return Err(Error::Invalid(
                        "Stopped to keep 10 GB free on the destination.".into(),
                    ));
                }
                out.write_all(&buffer[..n])?;
                hash.update(&buffer[..n]);
                copied += n as u64;
                p.bytes_done += n as u64;
                if last.elapsed().as_millis() >= 250 {
                    progress(&p);
                    last = std::time::Instant::now();
                }
            }
            out.sync_all()?;
            if copied != item.bytes || input.metadata()?.modified().ok() != item.modified {
                return Err(Error::Invalid(
                    "An original changed while it was copied.".into(),
                ));
            }
            p.stage = "verifying".into();
            progress(&p);
            if hash.finalize() != hash_file(&output, cancel)? {
                return Err(Error::Invalid("Copy verification failed.".into()));
            }
            if let Some(time) = item.modified {
                out.set_modified(time)?;
            }
            let moments = super::moments::list(db, &item.photo_id)?;
            let trim = super::moments::trim(db, &item.photo_id)?;
            manifest.push(serde_json::json!({ "photoId": item.photo_id, "originalFilename": item.filename, "file": format!("Media/{name}"), "bytes": copied, "blake3": hash.finalize().to_hex().to_string(), "moments": moments, "trim": trim }));
            p.done += 1;
            progress(&p);
        }
        stopped(cancel)?;
        let doc = serde_json::json!({ "version": 1, "pieceId": piece, "title": plan.title, "media": manifest, "kind": "original-working-copies" });
        fs::write(
            partial.join("manifest.json"),
            serde_json::to_vec_pretty(&doc).map_err(|e| Error::Invalid(e.to_string()))?,
        )?;
        fs::write(partial.join("README.md"), "# CapCut working media\n\nImport files from Media into CapCut. These are full-quality source copies, not CapCut proxies. Original sources are unchanged. Edits/looks from Captured by Andy are not baked in. Use CapCut's own proxy mode if needed. Keep this folder and filenames stable for the life of the edit. Camera codecs may need conversion if your CapCut build cannot decode them.\n\nmanifest.json maps stable photo IDs, checksums, saved moments and trims (source-relative seconds). Those notes are not applied automatically to a CapCut timeline. Keep the Media files accessible for final export. This working package is not a substitute for your original backup.\n")?;
        stopped(cancel)?;
        let finished = partial.with_extension("");
        fs::rename(&partial, &finished)?;
        Ok(Report {
            path: finished.to_string_lossy().into_owned(),
            files: plan.items.len(),
            bytes: plan.bytes,
        })
    })();
    result.map_err(|e| Error::Invalid(format!("{e} Incomplete working copies remain at {}. They are not ready to import; originals were not changed.", partial.display())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    fn enough(_: &Path) -> u64 {
        RESERVE + 100_000_000
    }
    fn plan(db: &Db, piece: &str, folder: &Path) -> Result<Plan> {
        super::plan_with_space(db, piece, folder, enough)
    }
    fn prepare(
        db: &Db,
        piece: &str,
        folder: &Path,
        key: &str,
        cancel: &AtomicBool,
        progress: impl FnMut(&Progress),
    ) -> Result<Report> {
        super::prepare_with_space(db, piece, folder, key, cancel, progress, enough)
    }
    struct Fixture {
        _root: tempfile::TempDir,
        _dest: tempfile::TempDir,
        db: Db,
        source: PathBuf,
        dest: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let dest = tempfile::tempdir().unwrap();
            let source = root.path().join("Originals");
            fs::create_dir(&source).unwrap();
            let db = Db::open(&root.path().join("library.db")).unwrap();
            let sid = super::super::sources::add(&db, &source).unwrap().id;
            let original = source.join("shot.mp4");
            fs::write(&original, b"synthetic video fixture, not real footage").unwrap();
            let size = fs::metadata(&original).unwrap().len() as i64;
            db.write(|c| {
                c.execute("INSERT INTO photos (id,media_kind,captured_at,captured_at_source,created_ms,updated_ms,is_video) VALUES ('photo','image','2026-11-18','file',1,1,1)", [])?;
                c.execute("INSERT INTO assets (id,photo_id,source_id,path,dir,stem,filename,format,is_raw,is_primary,size,mtime_ms,storage_state,last_seen_scan,created_ms,updated_ms) VALUES ('asset','photo',?1,?2,?3,'shot','shot.mp4','mp4',0,1,?4,1,'local',1,1,1)",params![sid,original.to_string_lossy(),source.to_string_lossy(),size])?;
                c.execute("INSERT INTO studio_pieces (id,title,created_ms,updated_ms) VALUES ('piece','Demo film',1,1)", [])?;
                c.execute("INSERT INTO studio_piece_media (piece_id,photo_id,added_ms) VALUES ('piece','photo',1)", [])?;
                Ok(())
            }).unwrap();
            let destination = dest.path().to_path_buf();
            Self {
                _root: root,
                _dest: dest,
                db,
                source,
                dest: destination,
            }
        }
    }
    #[test]
    fn copies_verified_originals_and_ranges_without_changing_sources_or_database() {
        let f = Fixture::new();
        let source = f.source.join("shot.mp4");
        let before = fs::metadata(&source).unwrap();
        let original = fs::read(&source).unwrap();
        super::super::moments::add(&f.db, "photo", 1.0, 2.0).unwrap();
        let p = plan(&f.db, "piece", &f.dest).unwrap();
        assert!(p.allowed);
        let r = prepare(
            &f.db,
            "piece",
            &f.dest,
            &p.key,
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(Path::new(&r.path).join("manifest.json")).unwrap())
                .unwrap();
        let media = &manifest["media"][0];
        assert_eq!(
            fs::read(Path::new(&r.path).join(media["file"].as_str().unwrap())).unwrap(),
            original
        );
        assert_eq!(
            media["blake3"],
            blake3::hash(&original).to_hex().to_string()
        );
        assert_eq!(media["moments"][0]["start"], 1.0);
        assert_eq!(
            fs::metadata(&source).unwrap().modified().unwrap(),
            before.modified().unwrap()
        );
        assert_eq!(fs::read(&source).unwrap(), original);
        assert_eq!(fs::read_dir(&f.source).unwrap().count(), 1);
        assert_eq!(
            plan(&f.db, "piece", &f.dest).unwrap().key,
            p.key,
            "packaging does not mutate library identity or selections"
        );
        let second = prepare(
            &f.db,
            "piece",
            &f.dest,
            &p.key,
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert_ne!(r.path, second.path, "packages never overwrite earlier work");
    }
    #[test]
    fn stale_plan_and_cancel_do_not_create_a_package() {
        let f = Fixture::new();
        let p = plan(&f.db, "piece", &f.dest).unwrap();
        assert!(prepare(
            &f.db,
            "piece",
            &f.dest,
            &p.key,
            &AtomicBool::new(true),
            |_| {}
        )
        .is_err());
        fs::write(f.source.join("shot.mp4"), b"changed").unwrap();
        assert!(prepare(
            &f.db,
            "piece",
            &f.dest,
            &p.key,
            &AtomicBool::new(false),
            |_| {}
        )
        .is_err());
        assert_eq!(fs::read_dir(&f.dest).unwrap().count(), 0);
    }
    #[test]
    fn refuses_destination_in_sources_and_marks_raw_and_missing_as_blocked() {
        let f = Fixture::new();
        assert!(plan(&f.db, "piece", &f.source).is_err());
        f.db.write(|c| {
            c.execute("UPDATE assets SET is_raw=1", [])?;
            Ok(())
        })
        .unwrap();
        let p = plan(&f.db, "piece", &f.dest).unwrap();
        assert!(!p.allowed);
        assert_eq!(p.items[0].status, "unsupported");
        f.db.write(|c| {
            c.execute(
                "UPDATE assets SET is_raw=0,path='/nonexistent/demo.mp4'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let p = plan(&f.db, "piece", &f.dest).unwrap();
        assert!(!p.allowed);
        assert_eq!(p.items[0].status, "unavailable");
    }
    #[test]
    fn cancelled_copy_stays_partial_and_sanitized_names_do_not_escape() {
        let f = Fixture::new();
        let p = plan(&f.db, "piece", &f.dest).unwrap();
        let cancel = AtomicBool::new(false);
        let err = prepare(&f.db, "piece", &f.dest, &p.key, &cancel, |_| {
            cancel.store(true, Ordering::Relaxed)
        })
        .unwrap_err();
        assert!(err.to_string().contains("Incomplete"));
        let entries = fs::read_dir(&f.dest)
            .unwrap()
            .collect::<std::io::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0]
            .path()
            .extension()
            .is_some_and(|e| e == "partial"));
        let name = safe_name("../../bad", "../../hostile.mov");
        assert!(!name.contains('/'));
        assert!(name.ends_with(".mov"));
    }
    #[test]
    fn insufficient_space_and_empty_projects_never_start() {
        let f = Fixture::new();
        let p = super::plan_with_space(&f.db, "piece", &f.dest, |_| RESERVE).unwrap();
        assert!(!p.allowed);
        assert!(super::prepare_with_space(
            &f.db,
            "piece",
            &f.dest,
            &p.key,
            &AtomicBool::new(false),
            |_| {},
            |_| RESERVE
        )
        .is_err());
        assert_eq!(fs::read_dir(&f.dest).unwrap().count(), 0);
        f.db.write(|c| {
            c.execute("DELETE FROM studio_piece_media", [])?;
            Ok(())
        })
        .unwrap();
        let p = plan(&f.db, "piece", &f.dest).unwrap();
        assert!(!p.allowed);
        assert!(p.items.is_empty());
    }
    #[test]
    fn destination_space_loss_stops_before_completing() {
        static LOW: AtomicBool = AtomicBool::new(false);
        fn space(_: &Path) -> u64 {
            if LOW.load(Ordering::Relaxed) {
                RESERVE
            } else {
                enough(Path::new("/"))
            }
        }
        let f = Fixture::new();
        let p = plan(&f.db, "piece", &f.dest).unwrap();
        LOW.store(false, Ordering::Relaxed);
        let err = super::prepare_with_space(
            &f.db,
            "piece",
            &f.dest,
            &p.key,
            &AtomicBool::new(false),
            |_| LOW.store(true, Ordering::Relaxed),
            space,
        )
        .unwrap_err();
        assert!(err.to_string().contains("10 GB"));
        assert!(fs::read_dir(&f.dest).unwrap().all(|e| e
            .unwrap()
            .path()
            .extension()
            .is_some_and(|x| x == "partial")));
    }
    #[test]
    fn falls_back_to_recorded_original_copy_but_not_symlinked_sources() {
        let f = Fixture::new();
        let source = f.source.join("shot.mp4");
        let offline = f._root.path().join("offline.mp4");
        let bytes = fs::read(&source).unwrap();
        fs::write(&offline, &bytes).unwrap();
        f.db.write(|c| {c.execute("INSERT INTO local_copies (asset_id,photo_id,path,size,fingerprint,created_ms) VALUES ('asset','photo',?1,?2,'fixture',1)",params![offline.to_string_lossy(),bytes.len() as i64])?; Ok(())}).unwrap();
        fs::remove_file(&source).unwrap();
        assert_eq!(
            plan(&f.db, "piece", &f.dest).unwrap().items[0].status,
            "ready"
        );
        f.db.write(|c| {
            c.execute("DELETE FROM local_copies", [])?;
            Ok(())
        })
        .unwrap();
        std::os::unix::fs::symlink(&offline, &source).unwrap();
        assert_eq!(
            plan(&f.db, "piece", &f.dest).unwrap().items[0].status,
            "unavailable"
        );
        assert!(plan(&f.db, "piece", f.db.path().parent().unwrap()).is_err());
    }
    #[test]
    fn cloud_managed_destinations_are_not_stable_working_folders() {
        let f = Fixture::new();
        let cloud = f.dest.join("Library/CloudStorage/DemoDrive/Work");
        fs::create_dir_all(&cloud).unwrap();
        assert!(plan(&f.db, "piece", &cloud)
            .err()
            .unwrap()
            .to_string()
            .contains("online-only"));
    }
}
