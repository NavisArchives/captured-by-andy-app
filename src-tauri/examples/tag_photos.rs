//! Tags photos from a list of ids, one per line (blank lines and `#` comments
//! skipped), creating the tag if needed. Marks are untouched.
//! `tag_photos <library dir> "<tag name>" <ids file>`
use std::path::PathBuf;

use captured_by_andy_lib::library::{db::Db, tags};

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = PathBuf::from(args.next().expect("library dir"));
    let name = args.next().expect("tag name");
    let list = std::fs::read_to_string(args.next().expect("ids file")).expect("read ids");
    let ids: Vec<String> = list.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).map(String::from).collect();
    let db = Db::open(&dir.join("library.db")).expect("open library");
    let added = tags::add(&db, &[name.clone()], &ids).expect("tag");
    println!("{added} of {} photos tagged \"{name}\"", ids.len());
}
