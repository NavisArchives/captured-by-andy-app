//! Adds a source folder to a library and scans it, with the app's own code.
//! `cargo run --example add_folder -- <library dir> <folder>`
//! The folder is only read; nothing in it changes.
use std::sync::atomic::AtomicBool;

use captured_by_andy_lib::library::{auto, db::Db, media, scan, sources};

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = std::path::PathBuf::from(args.next().expect("library dir"));
    let folder = std::path::PathBuf::from(args.next().expect("folder"));
    let db = Db::open(&dir.join("library.db")).expect("open library");
    let source = sources::add(&db, &folder).expect("add folder");
    println!("source {} ({})", source.label, source.path);
    let stats = scan::scan_source(&db, &source.id, &media::read_metadata, &AtomicBool::new(false), |_| {}).expect("scan");
    println!("{stats:?}");
    let grouped = auto::regroup_bursts(&db).unwrap_or(0);
    println!("bursts regrouped over {grouped} photos");
    for s in sources::list(&db).expect("list") {
        println!("{:>6} photos  {}", s.photo_count, s.path);
    }
}
