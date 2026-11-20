//! One-off: moves every photo taken inside a box (by its location) out of
//! whatever trip it's in, into one trip folder, keeping what lies below the
//! trip's place folder (THAILAND/SAM ROI YOT/IPHONE/x → NEW YORK/IPHONE/x).
//! Prints a dry run unless --apply; UNDO lines on stderr.
//!   cargo run --example move_by_place -- <library dir> <to trip dir> <lat min> <lat max> <lon min> <lon max> [--apply]
use std::collections::BTreeMap;

use captured_by_andy_lib::library::{db::Db, trips};

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let db = Db::open(&std::path::Path::new(&a[0]).join("library.db")).expect("library");
    let to = a[1].trim_end_matches('/');
    let b: Vec<f64> = a[2..6].iter().map(|x| x.parse().expect("number")).collect();
    let apply = a.iter().any(|x| x == "--apply");
    let rows: Vec<(String, String)> = db
        .read(|c| {
            let mut st = c.prepare(
                "SELECT p.id, a.dir FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
                 WHERE p.latitude BETWEEN ?1 AND ?2 AND p.longitude BETWEEN ?3 AND ?4 AND a.storage_state != 'missing'",
            )?;
            let r = st.query_map([b[0], b[1], b[2], b[3]], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(r)
        })
        .expect("photos");
    // The folder they're moved out of: their own, less a device folder (IPHONE).
    let mut by_from: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (id, dir) in rows.into_iter().filter(|(_, d)| !d.starts_with(&format!("{to}/")) && d != to) {
        let from = dir.strip_suffix("/IPHONE").unwrap_or(&dir).to_string();
        by_from.entry(from).or_default().push(id);
    }
    for (from, ids) in &by_from {
        println!("{from}: {} photos -> {to}", ids.len());
        if apply {
            let r = trips::move_into(&db, ids, from, to).expect("move");
            println!("  {} moved, {} already, {} failed {:?}", r.moved, r.already, r.failed.len(), r.failed);
            for m in &r.undo {
                eprintln!("UNDO\t{}\t{}\t{}", m.asset_id, m.to, m.from);
            }
        }
    }
}
