//! Moves the app's local copies (in ~/Pictures/CapturedByAndy) to the Trash
//! and forgets them; the originals stay where they are, untouched.
//! `trash_video_copies <library dir> [--all]`: videos only, or with `--all`
//! every copy, and then automatic copies on Select are switched off.
use std::path::PathBuf;

use captured_by_andy_lib::library::{db::Db, offline, settings};

fn main() {
    let dir = PathBuf::from(std::env::args().nth(1).expect("library dir"));
    let all = std::env::args().any(|a| a == "--all");
    let db = Db::open(&dir.join("library.db")).expect("open library");
    let (n, bytes) = offline::trash_copies(&db, !all).expect("trash copies");
    println!("{n} copies moved to the Trash ({:.1} GB)", bytes as f64 / 1e9);
    if all {
        settings::set(&db, offline::AUTO_KEY, "false").expect("switch off keep offline");
        println!("keep selects offline: off");
    }
}
