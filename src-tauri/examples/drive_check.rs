//! Checks that files in the Google Drive folder are complete in Google's
//! cloud: for each path, the size (and md5) Google holds against the size this
//! Mac reports, plus an optional local copy elsewhere to compare against.
//! Read-only; prints no secrets.
//!   cargo run --example drive_check -- <drive path>[=<local copy>] ...
use std::path::Path;

use captured_by_andy_lib::library::gdrive;

fn main() {
    for arg in std::env::args().skip(1) {
        let (drive, local) = arg.split_once('=').map_or((arg.as_str(), None), |(d, l)| (d, Some(l)));
        let name = Path::new(drive).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let mac = std::fs::metadata(drive).map(|m| m.len()).ok();
        let other = local.and_then(|l| std::fs::metadata(l).map(|m| m.len()).ok());
        if std::env::var("SHOW_PARENTS").is_ok() {
            if let Some(id) = gdrive::file_id(Path::new(drive)) {
                println!("{name}\t{id}\t{}", gdrive::meta_json(&id).map(|v| v.to_string()).unwrap_or_else(|| "unreachable".into()));
            }
            continue;
        }
        let Some(id) = gdrive::file_id(Path::new(drive)) else {
            println!("{name}\tNO DRIVE ID");
            continue;
        };
        match gdrive::meta(&id) {
            Some((size, md5)) => {
                let want = other.or(mac);
                let ok = want == Some(size);
                println!("{name}\tonline {size}\tmac {}\tlocal {}\tmd5 {}\t{}", mac.map_or("-".into(), |s| s.to_string()), other.map_or("-".into(), |s| s.to_string()), md5.as_deref().unwrap_or("-"), if ok { "MATCH" } else { "DIFFERENT" });
            }
            None => println!("{name}\tNOT FOUND ONLINE ({id})"),
        }
    }
}
