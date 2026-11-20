//! Runs the Inspire knowledge import (the same code as the app's button) and
//! fetches the pictures of new saves.
//!   cargo run --release --example knowledge_import -- <library dir>
use captured_by_andy_lib::library::{db::Db, studio};

fn main() {
    let dir = std::path::PathBuf::from(std::env::args().nth(1).expect("library dir"));
    let db = Db::open(&dir.join("library.db")).expect("library");
    let cache = dir.join("cache");
    let r = studio::import_knowledge(&db, &cache, &studio::knowledge_dir()).expect("import");
    println!("notes {} · added {} · already there {} · skipped {:?}", r.notes, r.added, r.updated, r.skipped);
    let mut pics = 0;
    for id in &r.new_ids {
        if studio::refresh_preview(&db, &cache, id).is_ok() {
            pics += 1;
        }
    }
    println!("previews fetched: {pics}/{}", r.new_ids.len());
}
