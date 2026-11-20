//! Makes one photo's preview with the app's own code and says how it went.
//! `preview_one <library dir> <photo id>`
use captured_by_andy_lib::library::{db::Db, thumbs};
fn main() {
    let mut a = std::env::args().skip(1);
    let dir = std::path::PathBuf::from(a.next().expect("library dir"));
    let id = a.next().expect("photo id");
    let db = Db::open(&dir.join("library.db")).expect("open");
    let cache = thumbs::Cache::new(dir.join("cache")).expect("cache");
    let t = std::time::Instant::now();
    match thumbs::preview(&db, &cache, &id) {
        Ok(p) => println!("ok in {:.1}s: {}", t.elapsed().as_secs_f32(), p.display()),
        Err(e) => println!("failed in {:.1}s: {e}", t.elapsed().as_secs_f32()),
    }
}
