//! One-off: renames a shoot's photos "<name> NN" with the app's own rename
//! (files and library together, pairs kept), folder by folder, numbering on.
//!   cargo run --example rename_shoot -- <library dir> "<name>" <folder>...
use captured_by_andy_lib::library::{db::Db, trips};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (dir, name, folders) = (&args[0], &args[1], &args[2..]);
    let db = Db::open(&std::path::Path::new(dir).join("library.db")).expect("library");
    let mut next = 1;
    for folder in folders {
        let ids: Vec<String> = db
            .read(|c| {
                let mut st = c.prepare(
                    "SELECT p.id FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
                     WHERE a.dir = ?1 AND a.storage_state != 'missing' ORDER BY p.captured_at, a.filename",
                )?;
                let ids = st.query_map([folder], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
                Ok(ids)
            })
            .expect("photos");
        let report = trips::rename_photos(&db, &ids, name, next).expect("rename");
        println!("{folder}: {} renamed, {} already, {} failed {:?}", report.moved, report.already, report.failed.len(), report.failed);
        for m in &report.undo {
            eprintln!("UNDO\t{}\t{}\t{}", m.asset_id, m.to, m.from);
        }
        next += ids.len();
    }
}
