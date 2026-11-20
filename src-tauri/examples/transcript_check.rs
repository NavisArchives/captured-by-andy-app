//! Transcribes given videos into a SCRATCH copy of the library (Amendment 9b, T1/T4):
//! the real clip helper, whisper.cpp and the app's cache of 540p copies; prints
//! language, timing and the first words. Never writes to Andy's library.
//! cargo run --example transcript_check -- <library copy.db> <cache root> <id>...
use captured_by_andy_lib::library::db::Db;
use captured_by_andy_lib::transcripts_cmd::transcribe_one;
use std::path::PathBuf;
use std::time::Instant;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let db = Db::open(&PathBuf::from(&a[1])).expect("library copy");
    let root = PathBuf::from(&a[2]);
    let clip = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/helpers/clip"));
    for id in &a[3..] {
        let t = Instant::now();
        let r = transcribe_one(&clip, &db, &root, id);
        let row: Option<(String, String, String, Option<f64>, String)> = db
            .read(|c| Ok(c.query_row("SELECT state, language, text, seconds, segments FROM video_transcripts WHERE photo_id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).ok()))
            .unwrap();
        println!("{id} · {:?} · {:.1}s · {:?}", r, t.elapsed().as_secs_f64(), row.map(|(s, l, x, sec, seg)| (s, l, sec, x.chars().take(140).collect::<String>(), seg.chars().take(160).collect::<String>())));
    }
}
