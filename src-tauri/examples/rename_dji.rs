//! One-off (Andy, 18 Nov): DJI clips get clean names with the app's own rename
//! (files and library together, so marks and previews stay attached):
//!   DJI_20261118203147_0161_D.MP4  ->  DJI_0161_2026-11-18_4K.MP4
//! Photos (JPG) get no resolution tag. A clip whose size the library doesn't
//! know yet is skipped and listed. Undo lines go to stderr.
//!   cargo run --example rename_dji -- <library dir> <folder> [--dry]
use captured_by_andy_lib::library::{db::Db, trips};

fn tag(w: i64, h: i64) -> &'static str {
    match w.max(h) {
        3840.. => "4K",
        2688..=3839 => "2.7K",
        1920..=2687 => "1080p",
        _ => "720p",
    }
}

fn probe(path: &str) -> Option<(i64, i64)> {
    let out = std::process::Command::new("ffprobe")
        .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path])
        .output().ok()?;
    let t = String::from_utf8_lossy(&out.stdout);
    let mut it = t.lines().next()?.split(',');
    Some((it.next()?.trim().parse().ok()?, it.next()?.trim().parse().ok()?))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (dir, folder, dry) = (&args[0], &args[1], args.iter().any(|a| a == "--dry"));
    let db = Db::open(&std::path::Path::new(dir).join("library.db")).expect("library");
    let rows: Vec<(String, String, Option<i64>, Option<i64>)> = db
        .read(|c| {
            let mut st = c.prepare(
                "SELECT p.id, a.filename, p.width, p.height FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
                 WHERE a.dir = ?1 AND a.storage_state != 'missing' ORDER BY a.filename",
            )?;
            let r = st.query_map([folder], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(r)
        })
        .expect("photos");
    let (mut done, mut skipped) = (0, Vec::new());
    for (id, name, w, h) in rows {
        // DJI_YYYYMMDDhhmmss_NNNN_D.EXT
        let stem = name.rsplit_once('.').map(|x| x.0).unwrap_or(&name);
        let parts: Vec<&str> = stem.split('_').collect();
        if parts.len() < 3 || parts[0] != "DJI" || parts[1].len() != 14 || !parts[1].chars().all(|c| c.is_ascii_digit()) {
            continue; // already clean, or not a camera name
        }
        let (d, num) = (parts[1], parts[2]);
        let date = format!("{}-{}-{}", &d[0..4], &d[4..6], &d[6..8]);
        let video = name.to_ascii_lowercase().ends_with(".mp4") || name.to_ascii_lowercase().ends_with(".mov");
        let new = if video {
            match (w, h) {
                (Some(w), Some(h)) if w > 0 => format!("DJI_{num}_{date}_{}", tag(w, h)),
                // Not indexed yet: ask the file itself (ffprobe reads the header only).
                _ => match probe(&format!("{folder}/{name}")) {
                    Some((w, h)) => format!("DJI_{num}_{date}_{}", tag(w, h)),
                    None => { skipped.push(name.clone()); continue; }
                },
            }
        } else {
            format!("DJI_{num}_{date}")
        };
        if dry {
            println!("{name}\t->\t{new}");
            continue;
        }
        match trips::rename_to(&db, &id, &new) {
            Ok(moves) => {
                done += 1;
                for m in moves { eprintln!("UNDO\t{}\t{}\t{}", m.asset_id, m.to, m.from); }
            }
            Err(e) => println!("FAILED {name}: {e}"),
        }
    }
    println!("renamed {done}; skipped (size unknown yet) {}: {:?}", skipped.len(), skipped);
}
