//! Imports and bakes every look found in the default folders into a throwaway
//! library, and reports what was found. Reads the preset/LUT files only.
//! `cargo run --example looks_check -- <temp dir>`
use std::collections::BTreeMap;
use std::time::Instant;

use captured_by_andy_lib::library::{db::Db, looks};

fn main() {
    let dir = std::path::PathBuf::from(std::env::args().nth(1).expect("temp dir"));
    std::fs::create_dir_all(&dir).unwrap();
    let db = Db::open(&dir.join("library.db")).unwrap();
    let looks_dir = dir.join("looks");
    let folders = looks::folders(&db).unwrap();
    println!("folders: {folders:#?}");
    let t = Instant::now();
    let report = looks::import(&db, &looks_dir, &folders).unwrap();
    println!("import {:?} in {:.1}s", report, t.elapsed().as_secs_f64());
    let t = Instant::now();
    let never = std::sync::atomic::AtomicBool::new(false);
    let (ok, failed) = looks::bake_all(&db, &looks_dir, &never).unwrap();
    println!("baked {ok}, failed {failed} in {:.1}s", t.elapsed().as_secs_f64());
    let all = looks::list(&db, &looks_dir).unwrap();
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for l in &all {
        groups.entry(l.collection.clone()).or_default().push(format!("{}{}{}", l.name, if l.author.is_empty() { String::new() } else { format!(" ({})", l.author) }, if l.baked { "" } else { " [NOT BAKED]" }));
    }
    for (g, names) in &groups {
        println!("\n== {g} ({})", names.len());
        for n in names.iter().take(12) {
            println!("  {n}");
        }
    }
    for l in all.iter().filter(|l| l.collection == "Your presets") {
        println!("{} swatch {:?} effects {:?}", l.name, l.swatch, l.effects);
    }
}
