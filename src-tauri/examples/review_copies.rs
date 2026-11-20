//! Makes review copies (previews) with the app's own code, while the app may
//! be open. Originals are only read; a downloaded original is released again
//! right after its copy is made.
//! `review_copies <library dir>`: every clip still to review.
//! `review_copies <library dir> <id> <id> …`: exactly these clips, and after
//! each one the original's state (still on this Mac or online-only again) and
//! the free space, as proof that nothing piles up on disk.
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use captured_by_andy_lib::library::{db::Db, review, scan, thumbs};

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = PathBuf::from(args.next().expect("library dir"));
    let mut ids: Vec<String> = args.collect();
    // `--pause-test`: 45 s as if on battery, then 45 s as if the disk were
    // short, then normal, to show a paused run goes on by itself.
    if let Some(i) = ids.iter().position(|a| a == "--pause-test") {
        ids.remove(i);
        let free = thumbs::free_bytes(&dir) as f64 / 1e9;
        std::thread::spawn(move || {
            // Safe here: set before and between the run's own reads, test runs only.
            unsafe { std::env::set_var("CBA_ASSUME_BATTERY", "1") };
            println!("(test) as if on battery for 45 s");
            std::thread::sleep(std::time::Duration::from_secs(45));
            unsafe {
                std::env::remove_var("CBA_ASSUME_BATTERY");
                std::env::set_var("CBA_KEEP_FREE_GB", format!("{:.0}", free + 5.0));
            }
            println!("(test) on mains now, but with the floor raised above the free space for 45 s");
            std::thread::sleep(std::time::Duration::from_secs(45));
            unsafe { std::env::remove_var("CBA_KEEP_FREE_GB") };
            println!("(test) back to normal: nobody touches anything from here");
        });
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    let db = Db::open(&dir.join("library.db")).expect("open library");
    let cache = dir.join("cache");
    let helper = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/helpers/review"));
    let cancel = AtomicBool::new(false);
    let scope = if ids.is_empty() { review::Scope::Unreviewed } else { review::Scope::Only(ids.clone()) };
    let gb = |b: u64| b as f64 / 1e9;
    println!("start · {:.2} GB free", gb(thumbs::free_bytes(&cache)));
    let started = std::time::Instant::now();
    let mut last = String::new();
    let mut checked = String::new();
    let result = review::run(&db, &cache, &helper, &scope, &cancel, |p| {
        let line = format!(
            "{} of {} ready · {} failed · {:.0} MB of previews · {}{}",
            p.done,
            p.total,
            p.failed,
            p.bytes as f64 / 1e6,
            p.current,
            if p.note.is_empty() { String::new() } else { format!(" · {}", p.note) }
        );
        if line != last {
            println!("[{:>4}s] {line}", started.elapsed().as_secs());
            last = line;
        }
        // A copy just landed: is its original online-only again, and is nothing left behind?
        if !p.last_ready.is_empty() && p.last_ready != checked {
            checked = p.last_ready.clone();
            if let Ok((path, size)) = thumbs::video_file(&db, &checked) {
                let online = std::fs::symlink_metadata(&path).is_ok_and(|m| scan::is_dataless(&m));
                let preview = review::existing(&cache, &checked).and_then(|c| c.metadata().ok()).map(|m| m.len()).unwrap_or(0);
                let leftovers = std::fs::read_dir(review::dir(&cache)).map(|it| it.flatten().filter(|e| e.file_name().to_string_lossy().starts_with(".direct-")).count()).unwrap_or(0);
                println!(
                    "        ✓ {} · original {:.0} MB {} · preview {:.1} MB · temp downloads left: {} · {:.2} GB free",
                    path.file_name().and_then(|n| n.to_str()).unwrap_or(""),
                    size as f64 / 1e6,
                    if online { "online-only again" } else { "STILL ON THIS MAC" },
                    preview as f64 / 1e6,
                    leftovers,
                    gb(thumbs::free_bytes(&cache))
                );
            }
        }
    })
    .expect("review copies");
    println!("finished in {} s · {:.2} GB free. {}", started.elapsed().as_secs(), gb(thumbs::free_bytes(&cache)), result.note);
}
