//! T2 (Amendment 9b): the Archive's own search finds a word said in a video.
//! cargo run --example transcript_search -- <library copy.db> <word>
use captured_by_andy_lib::library::{db::Db, photos};
use std::path::PathBuf;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let db = Db::open(&PathBuf::from(&a[1])).unwrap();
    let q: photos::Query = serde_json::from_value(serde_json::json!({ "search": a[2], "order": "newest" })).unwrap();
    let ids = photos::ids(&db, &q, 0, 50).unwrap();
    println!("search « {} »: {} found", a[2], ids.len());
    for id in ids.iter().take(5) {
        let said: Option<String> = db.read(|c| Ok(c.query_row("SELECT substr(text, 1, 90) FROM video_transcripts WHERE photo_id = ?1", [id], |r| r.get(0)).ok())).unwrap();
        println!("  {id} · {}", said.unwrap_or_else(|| "(matched another field)".into()));
    }
}
