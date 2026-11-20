//! Retires a folder whose photos are copies of photos in another folder:
//! each copy's review mark moves to its twin (same content fingerprint), then
//! the app forgets the folder like "Forget" in Settings. Only the app's
//! records change; the folder and its files stay on disk untouched.
//! `forget_duplicates <library dir> <copies folder label> <originals folder label>`
use captured_by_andy_lib::library::{db::Db, finder, offline, sources};
use rusqlite::params;

fn main() {
    let mut a = std::env::args().skip(1);
    let dir = std::path::PathBuf::from(a.next().expect("library dir"));
    let copies = a.next().expect("copies label");
    let originals = a.next().expect("originals label");
    let db = Db::open(&dir.join("library.db")).expect("open");
    let all = sources::list(&db).expect("sources");
    let src = all.iter().find(|s| s.label == copies).expect("copies folder");
    let orig = all.iter().find(|s| s.label == originals).expect("originals folder");
    let (moved, unmatched) = db
        .write(|c| {
            let tx = c.transaction()?;
            let pairs: Vec<(String, String, String, Option<i64>)> = {
                let mut stmt = tx.prepare(
                    "SELECT p.id, p.review_state, b.photo_id, p.reviewed_ms
                     FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
                     LEFT JOIN assets b ON b.fingerprint = a.fingerprint AND b.source_id = ?2
                     WHERE a.source_id = ?1 AND p.review_state != 'unreviewed'",
                )?;
                let rows = stmt
                    .query_map(params![src.id, orig.id], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, Option<String>>(2)?.unwrap_or_default(), r.get(3)?)))?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            let (mut moved, mut unmatched) = (0, 0);
            for (_copy, state, twin, when) in pairs {
                if twin.is_empty() {
                    unmatched += 1;
                    continue;
                }
                tx.execute("UPDATE photos SET review_state = ?2, reviewed_ms = ?3 WHERE id = ?1", params![twin, state, when])?;
                moved += 1;
            }
            tx.commit()?;
            Ok((moved, unmatched))
        })
        .expect("move marks");
    if unmatched > 0 {
        println!("{unmatched} marked copies have no twin: nothing forgotten");
        return;
    }
    finder::remove_added(&db, Some(&src.id)).expect("finder tags");
    offline::release_source(&db, &src.id).expect("offline copies");
    let removed = sources::remove(&db, &src.id).expect("forget folder");
    println!("{moved} marks moved to the originals · \"{copies}\" forgotten ({removed} duplicate photos out of the library)");
}
