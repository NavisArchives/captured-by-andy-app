//! Lists one page of a folder's photos with the app's own query code, to see why a grid stays empty.
//! `cargo run --example list_check -- <library dir> <folder> [review]`
use captured_by_andy_lib::library::{db::Db, model::ReviewState, photos};

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = std::path::PathBuf::from(args.next().expect("library dir"));
    let folder = args.next().expect("folder");
    let review = args.next();
    let db = Db::open(&dir.join("library.db")).expect("open library");
    let mut q = photos::Query { folder: Some(folder), ..Default::default() };
    if let Some(r) = review.as_deref() {
        q.review = Some(match r { "selected" => ReviewState::Selected, "rejected" => ReviewState::Rejected, "maybe" => ReviewState::Maybe, _ => ReviewState::Unreviewed });
    }
    println!("counts: {:?}", photos::counts(&db, &q));
    match photos::list(&db, &q, 0, 200) {
        Ok(rows) => println!("list ok: {} rows, first {:?}", rows.len(), rows.first().map(|r| &r.filename)),
        Err(e) => println!("LIST FAILED: {e}"),
    }
}
