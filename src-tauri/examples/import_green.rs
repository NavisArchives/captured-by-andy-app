//! Brings Andy's Finder picks along when a folder is copied elsewhere: every
//! photo under `<copy folder>` whose original under `<original folder>` carries
//! the Green Finder tag is marked Selected (only if it is still unreviewed, so
//! a choice made in the app is never overridden).
//! `cargo run --example import_green -- <library dir> <copy folder> <original folder>`
//! Only tags are read from the originals (they stay online, nothing downloads);
//! nothing on disk changes.
use std::path::{Path, PathBuf};

use captured_by_andy_lib::library::model::ReviewState;
use captured_by_andy_lib::library::{db::Db, finder, photos};

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = PathBuf::from(args.next().expect("library dir"));
    let copy = PathBuf::from(args.next().expect("copy folder"));
    let original = PathBuf::from(args.next().expect("original folder"));
    let db = Db::open(&dir.join("library.db")).expect("open library");

    let prefix = format!("{}/", copy.display());
    let rows: Vec<(String, String, String)> = db
        .read(|c| {
            let mut stmt = c.prepare(
                "SELECT a.photo_id, a.path, p.review_state FROM assets a JOIN photos p ON p.id = a.photo_id
                 WHERE substr(a.path, 1, length(?1)) = ?1",
            )?;
            let rows = stmt
                .query_map([&prefix], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .expect("read assets");

    let mut green = Vec::new();
    let (mut seen, mut already) = (0, 0);
    for (photo, path, review) in rows {
        let rel = &path[prefix.len()..];
        let twin = original.join(rel);
        let tagged = finder::read_tags(Path::new(&twin))
            .map(|tags| tags.iter().any(|t| t.split('\n').next() == Some("Green")))
            .unwrap_or(false);
        seen += 1;
        if !tagged {
            continue;
        }
        if review == "unreviewed" {
            green.push(photo);
        } else {
            already += 1;
        }
    }
    green.sort();
    green.dedup();
    let marked = photos::set_review(&db, &green, ReviewState::Selected).expect("mark selected");
    println!("{seen} files checked · {marked} green photos marked Selected · {already} green ones already had a mark");
}
