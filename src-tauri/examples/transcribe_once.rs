//! One video through the transcript queue's own function (NIRMATA, 20 Nov,
//! assistant health A5), on a COPY of the library: model, time, result.
//!   cargo run --example transcribe_once -- <library copy.db> <cache root> <clip helper> <photo id>
use captured_by_andy_lib::library::db::Db;
use captured_by_andy_lib::transcripts_cmd::transcribe_one;
use std::path::PathBuf;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let db = Db::open(&PathBuf::from(&a[1])).unwrap();
    let t = std::time::Instant::now();
    let r = transcribe_one(&PathBuf::from(&a[3]), &db, &PathBuf::from(&a[2]), &a[4]);
    println!("result: {r:?} in {:.1} s", t.elapsed().as_secs_f64());
    let row: (String, String, String, f64, i64, String) = db
        .read(|c| Ok(c.query_row("SELECT state, language, model, COALESCE(seconds, 0), COALESCE(took_ms, 0), substr(text, 1, 300) FROM video_transcripts WHERE photo_id = ?1", [&a[4]], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?))
        .unwrap();
    println!("state {} · language {} · model {} · {:.1} s of video · took {} ms\ntext: {}", row.0, row.1, row.2, row.3, row.4, row.5);
}
