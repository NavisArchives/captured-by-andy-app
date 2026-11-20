//! Indexes files a copy job just placed in a source folder, while they are
//! still on this Mac: records them (date, camera, fingerprint, RAW + JPEG
//! pairs) and makes their thumbnails, with the app's own code. Nothing is
//! listed or downloaded, and the files are only read.
//! `index_paths <library dir> <source folder> <file>...` — prints one line per
//! file: "ok <path>" when it is in the library with its preview, else "no <path>".
use std::path::PathBuf;

use captured_by_andy_lib::library::{auto, db::Db, media, scan, sources, thumbs};

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = PathBuf::from(args.next().expect("library dir"));
    let folder = PathBuf::from(args.next().expect("source folder")).canonicalize().expect("source folder");
    let files: Vec<PathBuf> = args.map(PathBuf::from).collect();
    let db = Db::open(&dir.join("library.db")).expect("open library");
    let cache = thumbs::Cache::new(dir.join("cache")).expect("cache");
    let source = sources::list(&db)
        .expect("sources")
        .into_iter()
        .find(|s| s.path == folder.to_string_lossy())
        .expect("folder is not a source in the library");
    scan::index_files(&db, &source.id, &files, &media::read_metadata).expect("index");

    for f in &files {
        let text = f.to_string_lossy().into_owned();
        let found: Option<(String, bool, String, bool)> = db
            .read(|c| {
                Ok(c.query_row(
                    "SELECT a.photo_id, a.is_primary, p.thumb_state, a.fingerprint IS NOT NULL
                     FROM assets a JOIN photos p ON p.id = a.photo_id WHERE a.path = ?1",
                    [&text],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .ok())
            })
            .expect("read");
        let ok = match found {
            Some((photo, true, thumb, _)) if thumb == "pending" => {
                matches!(thumbs::make_thumbnail(&db, &cache, &photo), Ok(s) if s.as_str() != "pending")
            }
            Some((_, true, thumb, _)) => thumb == "ready" || thumb == "failed",
            Some((_, false, _, has_fp)) => has_fp,
            None => false,
        };
        println!("{} {}", if ok { "ok" } else { "no" }, text);
    }
    let _ = auto::regroup_bursts(&db);
}
