//! Verifies Clean up (Bin, Undo, no ghost photos) and Places (existing folder
//! names kept exactly) on a SCRATCH library built from copies of a few
//! thumbnails, with the real `bin` helper. Never touches the real library.
//!   cargo run --example scratch_verify -- <scratch dir> <a folder of sample .jpg files>
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::io::Write;

use captured_by_andy_lib::library::{cleanup, db::Db, media, model::ReviewState, photos, places, scan, sources};

fn helper(cmd: &str, lines: &[String]) -> Vec<Vec<String>> {
    let bin = concat!(env!("CARGO_MANIFEST_DIR"), "/helpers/bin");
    let mut child = Command::new(bin).arg(cmd).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().expect("helper");
    child.stdin.take().unwrap().write_all(lines.join("\n").as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    String::from_utf8_lossy(&out.stdout).lines().map(|l| l.split('\t').map(str::to_owned).collect()).collect()
}

fn count(db: &Db, sql: &str) -> i64 {
    db.read(|c| Ok(c.query_row(sql, [], |r| r.get(0))?)).unwrap()
}

fn library(dir: &Path) -> (Db, PathBuf, String) {
    let root = dir.join("Photos");
    std::fs::create_dir_all(&root).unwrap();
    let db = Db::open(&dir.join("library.db")).unwrap();
    let source = sources::add(&db, &root).unwrap().id;
    (db, std::fs::canonicalize(&root).unwrap(), source)
}

fn scan_now(db: &Db, source: &str) {
    scan::scan_source(db, source, &media::read_metadata, &std::sync::atomic::AtomicBool::new(false), |_| {}).unwrap();
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let scratch = PathBuf::from(&a[0]);
    let samples: Vec<PathBuf> = std::fs::read_dir(&a[1]).unwrap().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "jpg")).collect();
    assert!(samples.len() >= 30, "need 30 sample jpgs");
    let _ = std::fs::remove_dir_all(&scratch);

    println!("== Clean up: Bin, ghost photos, Undo (real bin helper, scratch files) ==");
    let (db, root, source) = library(&scratch.join("cleanup"));
    let egypt = root.join("EGYPT");
    std::fs::create_dir_all(&egypt).unwrap();
    std::fs::copy(&samples[0], egypt.join("DSC_1.JPG")).unwrap();
    std::fs::write(egypt.join("DSC_1.ARW"), vec![7u8; 20_000]).unwrap(); // a RAW+JPEG pair
    std::fs::copy(&samples[1], egypt.join("DSC_2.JPG")).unwrap();
    std::fs::copy(&samples[2], egypt.join("DSC_3.JPG")).unwrap();
    std::fs::write(egypt.join("DSC_3.ARW"), vec![9u8; 20_000]).unwrap();
    std::fs::copy(&samples[3], egypt.join("DSC_4.JPG")).unwrap(); // stays selected
    scan_now(&db, &source);
    // DSC_3's RAW disappears outside the app: a "missing" file that used to leave a ghost photo.
    std::fs::remove_file(egypt.join("DSC_3.ARW")).unwrap();
    scan_now(&db, &source);
    let rows = photos::list(&db, &photos::Query::default(), 0, 100).unwrap();
    let id = |n: &str| rows.iter().find(|r| r.filename == n).unwrap().id.clone();
    let doomed = vec![id("DSC_1.JPG"), id("DSC_2.JPG"), id("DSC_3.JPG")];
    photos::set_review(&db, &doomed, ReviewState::Rejected).unwrap();
    photos::set_review(&db, &[id("DSC_4.JPG")], ReviewState::Selected).unwrap();
    cleanup::mark(&db, &doomed, Some("delete")).unwrap();
    println!("before: photos {}, assets {} (missing {})", count(&db, "SELECT COUNT(*) FROM photos"), count(&db, "SELECT COUNT(*) FROM assets"), count(&db, "SELECT COUNT(*) FROM assets WHERE storage_state='missing'"));
    let trip = egypt.to_string_lossy().into_owned();
    let none = HashSet::new();
    let trash = |paths: &[String]| -> Vec<Result<String, String>> {
        let answer = helper("trash", paths);
        paths
            .iter()
            .map(|p| match answer.iter().find(|x| x.get(1) == Some(p)) {
                Some(x) if x[0] == "ok" => Ok(x.get(2).filter(|w| !w.is_empty()).cloned().unwrap_or_else(|| format!("(in the Bin) {p}"))),
                Some(x) => Err(x.get(2).cloned().unwrap_or_default()),
                None => Err("no answer".into()),
            })
            .collect()
    };
    let wrong = cleanup::bin_trip(&db, &trip, &doomed[..2], &none, &trash);
    println!("confirming 2 of the 3 marked photos: refused = {}", wrong.is_err());
    let r = cleanup::bin_trip(&db, &trip, &doomed, &none, &trash).unwrap();
    println!("binned: {} photos, {} bytes, failed {:?}", r.photos, r.bytes, r.failed);
    let binned: Vec<(String, String)> = db
        .read(|c| {
            let mut st = c.prepare("SELECT original, binned FROM deletions WHERE batch = ?1")?;
            let v = st.query_map([&r.batch], |x| Ok((x.get(0)?, x.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(v)
        })
        .unwrap();
    for (o, b) in &binned {
        println!("  {} -> {} (in Bin: {}, original gone: {})", Path::new(o).file_name().unwrap().to_string_lossy(), b, Path::new(b).exists(), !Path::new(o).exists());
    }
    println!(
        "after: photos {}, assets {}, ghost rows for DSC_3 {}, DSC_4 still there {}",
        count(&db, "SELECT COUNT(*) FROM photos"),
        count(&db, "SELECT COUNT(*) FROM assets"),
        count(&db, "SELECT COUNT(*) FROM assets WHERE filename LIKE 'DSC_3%'"),
        egypt.join("DSC_4.JPG").exists()
    );
    let restore = |pairs: &[(String, String)]| -> Vec<Result<(), String>> {
        let lines: Vec<String> = pairs.iter().map(|(b, o)| format!("{b}\t{o}")).collect();
        let answer = helper("restore", &lines);
        pairs.iter().map(|(_, o)| match answer.iter().find(|x| x.get(1) == Some(o)) {
            Some(x) if x[0] == "ok" => Ok(()),
            Some(x) => Err(x.get(2).cloned().unwrap_or_default()),
            None => Err("no answer".into()),
        }).collect()
    };
    let u = cleanup::undo(&db, &r.batch, &restore).unwrap();
    println!("undo: {} photos back, failed {:?}", u.photos, u.failed);
    for f in ["DSC_1.JPG", "DSC_1.ARW", "DSC_2.JPG", "DSC_3.JPG"] {
        println!("  {f} back on disk: {}", egypt.join(f).exists());
    }
    println!("after undo: photos {}, rejected {}, marked delete {}", count(&db, "SELECT COUNT(*) FROM photos"), count(&db, "SELECT COUNT(*) FROM photos WHERE review_state='rejected'"), count(&db, "SELECT COUNT(*) FROM cleanup_marks WHERE mark='delete'"));

    println!("\n== Places: an existing folder keeps its exact name ==");
    let (db, root, source) = library(&scratch.join("places"));
    let th = root.join("THAILAND");
    std::fs::create_dir_all(th.join("IPHONE")).unwrap();
    std::fs::create_dir_all(th.join("Pai")).unwrap();
    for i in 0..22 {
        std::fs::copy(&samples[4 + i], th.join("IPHONE").join(format!("IMG_{i}.jpg"))).unwrap();
    }
    std::fs::copy(&samples[29], th.join("Pai").join("OLD.jpg")).unwrap();
    scan_now(&db, &source);
    db.write(|c| Ok(c.execute("UPDATE photos SET latitude = 19.36, longitude = 98.44", [])?)).unwrap();
    let trip = th.to_string_lossy().into_owned();
    let p = places::propose(&db, &trip, &|_| Some(("Pai District".into(), "Thailand".into()))).unwrap();
    for pl in &p.places {
        println!("proposed: {} ({} photos, existing folder: {})", pl.name, pl.photos, pl.existing);
    }
    // Typed in upper case on screen: still the folder that's there, spelled as it is.
    let choices: Vec<places::Choice> = p.places.iter().map(|pl| places::Choice { key: pl.key.clone(), name: "PAI".into() }).collect();
    let r = places::make(&db, &trip, &choices).unwrap();
    let dirs: Vec<String> = db
        .read(|c| {
            let mut st = c.prepare("SELECT DISTINCT dir FROM assets")?;
            let v = st.query_map([], |x| x.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
            Ok(v)
        })
        .unwrap();
    println!("moved {}, failed {:?}", r.moved, r.failed);
    for d in &dirs {
        println!("  library folder: {}", d.strip_prefix(&root.to_string_lossy().into_owned()).unwrap_or(d));
    }
    let on_disk: Vec<String> = std::fs::read_dir(&th).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    println!("  folders on disk in THAILAND: {on_disk:?}");
    let _ = std::fs::remove_dir_all(&scratch);
    println!("\nscratch removed");
}
