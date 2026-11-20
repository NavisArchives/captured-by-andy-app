//! The library end to end on real files in a temp folder, through the same
//! ImageIO path the app uses. `originals_are_never_modified` guards the most
//! important rule: the app never changes, moves or adds to a source folder.
#![cfg(target_os = "macos")]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, SystemTime};

use captured_by_andy_lib::library::model::{MediaKind, ReviewState, StorageState, ThumbState};
use captured_by_andy_lib::library::{albums, cleanup, db::Db, download, gdrive, heal, labels, looks, media, moments, photos, places, review, scan, sources, tags, thumbs, trips, Error};

struct Lib {
    dir: tempfile::TempDir,
    root: PathBuf,
    db: Db,
    source: String,
    cache: thumbs::Cache,
}

impl Lib {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Photos");
        std::fs::create_dir_all(&root).unwrap();
        let db = Db::open(&dir.path().join("library.db")).unwrap();
        let source = sources::add(&db, &root).unwrap().id;
        let cache = thumbs::Cache::new(dir.path().join("cache")).unwrap();
        Self { dir, root, db, source, cache }
    }

    fn path(&self, rel: &str) -> PathBuf {
        let p = self.root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        p
    }

    /// A real JPEG whose colour comes from its name, so every file has distinct content.
    fn jpeg(&self, rel: &str, exif: Option<(&str, &str)>) -> PathBuf {
        let p = self.path(rel);
        let h = blake3::hash(rel.as_bytes());
        media::fixtures::write_jpeg(&p, 400, 300, [h.as_bytes()[0], h.as_bytes()[1], h.as_bytes()[2]], exif).unwrap();
        p
    }

    /// Stands in for a RAW file: right extension, content ImageIO can't decode.
    fn fake_raw(&self, rel: &str) -> PathBuf {
        let p = self.path(rel);
        std::fs::write(&p, blake3::hash(rel.as_bytes()).as_bytes().repeat(512)).unwrap();
        p
    }

    fn scan(&self) -> scan::ScanStats {
        scan::scan_source(&self.db, &self.source, &media::read_metadata, &AtomicBool::new(false), |_| {}).unwrap()
    }

    fn rows(&self) -> Vec<photos::PhotoRow> {
        photos::list(&self.db, &photos::Query::default(), 0, 100_000).unwrap()
    }
}

fn set_mtime(path: &Path, t: SystemTime) {
    std::fs::File::options().append(true).open(path).unwrap().set_modified(t).unwrap();
}

/// Content hash, size and mtime of every file under a folder.
fn snapshot(root: &Path) -> BTreeMap<PathBuf, (String, u64, SystemTime)> {
    walkdir::WalkDir::new(root)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .map(|e| {
            let meta = e.metadata().unwrap();
            let hash = blake3::hash(&std::fs::read(e.path()).unwrap()).to_hex().to_string();
            (e.path().to_owned(), (hash, meta.len(), meta.modified().unwrap()))
        })
        .collect()
}

#[test]
fn indexes_supported_files_and_skips_the_rest() {
    let lib = Lib::new();
    lib.jpeg("a.jpg", None);
    lib.jpeg("b.JPEG", None);
    lib.jpeg("day/c.jpg", None);
    std::fs::write(lib.path("notes.txt"), "not a photo").unwrap();
    std::fs::write(lib.path("._a.jpg"), "AppleDouble metadata, not a photo").unwrap();
    lib.jpeg(".hidden/x.jpg", None);
    lib.jpeg("Photos Library.photoslibrary/originals/y.jpg", None);

    let stats = lib.scan();
    assert_eq!(stats.discovered, 3);
    assert_eq!(stats.added, 3);
    let mut names: Vec<String> = lib.rows().into_iter().map(|r| r.filename).collect();
    names.sort();
    assert_eq!(names, ["a.jpg", "b.JPEG", "c.jpg"]);
}

#[test]
fn rescanning_an_unchanged_library_adds_nothing() {
    let lib = Lib::new();
    for i in 0..5 {
        lib.jpeg(&format!("IMG_{i:04}.JPG"), None);
    }
    lib.scan();
    let again = lib.scan();
    assert_eq!((again.added, again.unchanged, again.updated), (0, 5, 0));
    assert_eq!(lib.rows().len(), 5);
}

#[test]
fn a_raw_and_its_jpeg_become_one_photo() {
    let lib = Lib::new();
    let t = SystemTime::now() - Duration::from_secs(3600);
    set_mtime(&lib.jpeg("IMG_0001.JPG", None), t);
    set_mtime(&lib.fake_raw("IMG_0001.ARW"), t + Duration::from_secs(1));

    let stats = lib.scan();
    assert_eq!(stats.paired, 1);
    let rows = lib.rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].media, MediaKind::RawImage);
    assert_eq!(rows[0].filename, "IMG_0001.JPG", "the JPEG is the primary file");
    let detail = photos::detail(&lib.db, &rows[0].id).unwrap();
    assert_eq!(detail.assets.len(), 2);
    assert!(detail.assets.iter().any(|a| a.is_raw && a.filename == "IMG_0001.ARW"));
}

#[test]
fn same_name_taken_at_different_times_stays_separate() {
    let lib = Lib::new();
    let t = SystemTime::now() - Duration::from_secs(7200);
    set_mtime(&lib.jpeg("IMG_0002.JPG", None), t);
    set_mtime(&lib.fake_raw("IMG_0002.ARW"), t + Duration::from_secs(3600));
    assert_eq!(lib.scan().paired, 0);
    assert_eq!(lib.rows().len(), 2);
}

#[test]
fn review_marks_survive_a_rescan() {
    let lib = Lib::new();
    lib.jpeg("a.jpg", None);
    lib.jpeg("b.jpg", None);
    lib.scan();
    let id = lib.rows()[0].id.clone();
    photos::set_review(&lib.db, &[id.clone()], ReviewState::Selected).unwrap();
    lib.scan();
    let row = lib.rows().into_iter().find(|r| r.id == id).unwrap();
    assert_eq!(row.review, ReviewState::Selected);
    assert_eq!(photos::counts(&lib.db, &photos::Query::default()).unwrap().selected, 1);
}

#[test]
fn a_moved_file_keeps_its_photo_and_review() {
    let lib = Lib::new();
    let original = lib.jpeg("a.jpg", None);
    lib.scan();
    let id = lib.rows()[0].id.clone();
    photos::set_review(&lib.db, &[id.clone()], ReviewState::Selected).unwrap();

    std::fs::rename(&original, lib.path("sorted/renamed.jpg")).unwrap();
    let stats = lib.scan();
    assert_eq!((stats.moved, stats.added, stats.missing), (1, 0, 0));
    let rows = lib.rows();
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0].id.as_str(), rows[0].filename.as_str()), (id.as_str(), "renamed.jpg"));
    assert_eq!(rows[0].review, ReviewState::Selected);
}

#[test]
fn a_deleted_file_is_marked_missing_not_forgotten() {
    let lib = Lib::new();
    let p = lib.jpeg("a.jpg", None);
    lib.scan();
    std::fs::remove_file(p).unwrap();
    assert_eq!(lib.scan().missing, 1);
    let rows = lib.rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].storage, StorageState::Missing);
}

#[test]
fn a_folder_that_cant_be_read_is_not_marked_missing() {
    use std::os::unix::fs::PermissionsExt;
    let lib = Lib::new();
    lib.jpeg("Nepal/a.jpg", None);
    lib.jpeg("Nepal/b.jpg", None);
    lib.jpeg("Ghent/c.jpg", None);
    lib.scan();
    // Ghent really goes away; Nepal can't be read this time (access refused, Drive hiccup).
    std::fs::remove_file(lib.root.join("Ghent/c.jpg")).unwrap();
    let nepal = lib.root.join("Nepal");
    std::fs::set_permissions(&nepal, std::fs::Permissions::from_mode(0o000)).unwrap();
    let stats = lib.scan();
    std::fs::set_permissions(&nepal, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!((stats.missing, stats.held), (1, 2));
    let missing: Vec<String> =
        lib.rows().into_iter().filter(|r| r.storage == StorageState::Missing).map(|r| r.filename).collect();
    assert_eq!(missing, ["c.jpg"]);
}

#[test]
fn an_empty_listing_marks_nothing_missing() {
    let lib = Lib::new();
    for i in 0..25 {
        lib.jpeg(&format!("IMG_{i}.JPG"), None);
    }
    lib.scan();
    // A cloud folder that briefly lists as empty: nothing is taken as gone.
    let moved = lib.dir.path().join("aside");
    std::fs::rename(&lib.root, &moved).unwrap();
    std::fs::create_dir_all(&lib.root).unwrap();
    let stats = lib.scan();
    std::fs::remove_dir(&lib.root).unwrap();
    std::fs::rename(&moved, &lib.root).unwrap();
    assert_eq!((stats.missing, stats.held), (0, 25));
    assert!(lib.rows().iter().all(|r| r.storage != StorageState::Missing));
}

#[test]
fn an_unplugged_source_changes_nothing() {
    let lib = Lib::new();
    lib.jpeg("a.jpg", None);
    lib.scan();
    let unplugged = lib.dir.path().join("elsewhere");
    std::fs::rename(&lib.root, &unplugged).unwrap();
    let result = scan::scan_source(&lib.db, &lib.source, &media::read_metadata, &AtomicBool::new(false), |_| {});
    assert!(matches!(result, Err(Error::SourceOffline(_))));
    std::fs::rename(&unplugged, &lib.root).unwrap();
    assert_eq!(lib.rows()[0].storage, StorageState::Local, "nothing was marked missing");
}

#[test]
fn a_changed_file_is_refreshed() {
    let lib = Lib::new();
    let p = lib.jpeg("a.jpg", None);
    lib.scan();
    let id = lib.rows()[0].id.clone();
    thumbs::make_thumbnail(&lib.db, &lib.cache, &id).unwrap();
    media::fixtures::write_jpeg(&p, 800, 600, [1, 2, 3], None).unwrap();
    set_mtime(&p, SystemTime::now() + Duration::from_secs(5));
    let stats = lib.scan();
    assert_eq!(stats.updated, 1);
    let row = &lib.rows()[0];
    assert_eq!(row.id, id, "same photo");
    assert_eq!(row.thumb, ThumbState::Pending, "thumbnail will be remade");
    assert_eq!(row.width, Some(800));
}

#[test]
fn exif_capture_time_orders_the_library() {
    let lib = Lib::new();
    lib.jpeg("new.jpg", Some(("2026:08:27 16:01:38", "ILCE-7M4")));
    lib.jpeg("old.jpg", Some(("2019:01:05 09:00:00", "ILCE-7M3")));
    lib.scan();
    let names: Vec<String> = lib.rows().into_iter().map(|r| r.filename).collect();
    assert_eq!(names, ["new.jpg", "old.jpg"]);
    let oldest_first = photos::Query { order: photos::Order::Oldest, ..Default::default() };
    let first = &photos::list(&lib.db, &oldest_first, 0, 1).unwrap()[0];
    assert_eq!(first.captured_at, "2019-01-05T09:00:00.000");
}

#[test]
fn thumbnails_come_with_placeholders() {
    let lib = Lib::new();
    lib.jpeg("a.jpg", None);
    lib.scan();
    let id = lib.rows()[0].id.clone();
    assert_eq!(thumbs::make_thumbnail(&lib.db, &lib.cache, &id).unwrap(), ThumbState::Ready);
    let meta = media::read_metadata(&lib.cache.thumb(&id)).unwrap();
    assert!(meta.width.unwrap().max(meta.height.unwrap()) <= thumbs::THUMB_PX as i64);
    let row = &lib.rows()[0];
    assert_eq!(row.thumb, ThumbState::Ready);
    assert!(row.thumbhash.is_some());
}

#[test]
fn listing_windows_filters_and_positions() {
    let lib = Lib::new();
    for i in 0..30 {
        lib.jpeg(&format!("IMG_{i:04}.JPG"), Some((&format!("2026:08:27 16:{i:02}:00"), "cam")));
    }
    lib.scan();
    let all = lib.rows();
    let picked: Vec<String> = all.iter().step_by(6).map(|r| r.id.clone()).collect();
    photos::set_review(&lib.db, &picked, ReviewState::Selected).unwrap();

    let selected = photos::Query::review(ReviewState::Selected);
    assert_eq!(photos::list(&lib.db, &selected, 0, 100).unwrap().len(), 5);

    let window = photos::list(&lib.db, &photos::Query::default(), 10, 10).unwrap();
    let expected: Vec<&str> = all[10..20].iter().map(|r| r.id.as_str()).collect();
    assert_eq!(window.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), expected);

    assert_eq!(photos::position(&lib.db, &photos::Query::default(), &all[17].id).unwrap(), Some(17));
    assert_eq!(photos::position(&lib.db, &selected, &picked[2]).unwrap(), Some(2));
}

#[test]
fn originals_are_never_modified() {
    let lib = Lib::new();
    let t = SystemTime::now() - Duration::from_secs(3600);
    set_mtime(&lib.jpeg("shoot/IMG_0001.JPG", Some(("2026:08:27 16:01:38", "cam"))), t);
    set_mtime(&lib.fake_raw("shoot/IMG_0001.ARW"), t);
    lib.jpeg("shoot/IMG_0002.JPG", None);
    lib.jpeg("other/a.png.jpg", None);
    let before = snapshot(&lib.root);

    lib.scan();
    let ids: Vec<String> = lib.rows().into_iter().map(|r| r.id).collect();
    photos::set_review(&lib.db, &ids, ReviewState::Rejected).unwrap();
    for id in &ids {
        thumbs::make_thumbnail(&lib.db, &lib.cache, id).unwrap();
        thumbs::preview(&lib.db, &lib.cache, id).unwrap();
    }
    lib.scan();

    assert_eq!(snapshot(&lib.root), before, "no source file changed, moved, or appeared");
}

#[test]
fn last_import_is_what_the_latest_scan_added() {
    let lib = Lib::new();
    lib.jpeg("Old/a.jpg", None);
    let started = captured_by_andy_lib::library::now_ms();
    let first = lib.scan();
    photos::note_import(&lib.db, started, first.added).unwrap();
    let last = |lib: &Lib| {
        let q = photos::Query { smart: Some(photos::Smart::LastImport), ..Default::default() };
        photos::list(&lib.db, &q, 0, 100).unwrap().into_iter().map(|r| r.filename).collect::<Vec<_>>()
    };
    assert_eq!(last(&lib), ["a.jpg"]);

    // More files arriving soon after (a slow copy, a sync): the same import.
    std::thread::sleep(Duration::from_millis(5));
    lib.jpeg("Old/a2.jpg", None);
    let started = captured_by_andy_lib::library::now_ms();
    let more = lib.scan();
    photos::note_import(&lib.db, started, more.added).unwrap();
    let mut got = last(&lib);
    got.sort();
    assert_eq!(got, ["a.jpg", "a2.jpg"]);

    // A new trip, hours later: only its photos are the last import.
    let hours_ago = (captured_by_andy_lib::library::now_ms() - 7 * 3_600_000).to_string();
    captured_by_andy_lib::library::settings::set(&lib.db, photos::LAST_IMPORT_KEY, &hours_ago).unwrap();
    std::thread::sleep(Duration::from_millis(5));
    lib.jpeg("Trip/b.jpg", None);
    lib.jpeg("Trip/c.jpg", None);
    let started = captured_by_andy_lib::library::now_ms();
    let second = lib.scan();
    photos::note_import(&lib.db, started, second.added).unwrap();
    let mut got = last(&lib);
    got.sort();
    assert_eq!(got, ["b.jpg", "c.jpg"]);

    // A rescan with nothing new keeps that import.
    std::thread::sleep(Duration::from_millis(5));
    let started = captured_by_andy_lib::library::now_ms();
    let third = lib.scan();
    assert_eq!(third.added, 0);
    photos::note_import(&lib.db, started, third.added).unwrap();
    assert_eq!(last(&lib).len(), 2);
}

#[test]
fn folders_never_overlap() {
    let lib = Lib::new();
    lib.jpeg("Trips/Pai/a.jpg", None);
    lib.jpeg("b.jpg", None);
    lib.scan();
    let culled = lib.rows()[0].id.clone();
    photos::set_review(&lib.db, &[culled.clone()], ReviewState::Selected).unwrap();

    // Inside an indexed folder: that folder is the answer, nothing is added.
    let added = sources::add_folder(&lib.db, &lib.root.join("Trips/Pai")).unwrap();
    assert!(added.already_covered);
    assert_eq!(added.source.id, lib.source);

    // Only whole names count: "Photos 2" sits next to "Photos", not in it.
    let sibling = lib.dir.path().join("Photos 2");
    std::fs::create_dir_all(&sibling).unwrap();
    assert!(!sources::add_folder(&lib.db, &sibling).unwrap().already_covered);

    // Around indexed folders: it takes them over, and every photo keeps its marks.
    let outer = sources::add_folder(&lib.db, lib.dir.path()).unwrap();
    let mut merged = outer.merged.clone();
    merged.sort();
    assert_eq!(merged, ["Photos", "Photos 2"]);
    let all = sources::list(&lib.db).unwrap();
    assert_eq!(all.len(), 1, "one folder left: the new parent");
    assert_eq!(all[0].photo_count, 2);
    let rescan = scan::scan_source(&lib.db, &outer.source.id, &media::read_metadata, &AtomicBool::new(false), |_| {}).unwrap();
    assert_eq!(rescan.added, 0, "the same files, not new photos");
    let row = lib.rows().into_iter().find(|r| r.id == culled).expect("the culled photo is still there");
    assert_eq!(row.review, ReviewState::Selected);

    // A folder inside one that is switched off is not quietly "covered".
    sources::set_enabled(&lib.db, &outer.source.id, false).unwrap();
    assert!(sources::add_folder(&lib.db, &lib.root).is_err());
}

#[test]
fn online_only_photos_get_previews_and_dates() {
    let lib = Lib::new();
    lib.jpeg("Trip/a.jpg", Some(("2025-10-21 14:05:30".replace('-', ":").as_str(), "ILCE-7M4")));
    lib.scan();
    let id = lib.rows()[0].id.clone();
    // As a scan records a file that only lives online: no preview, the file's own date.
    lib.db
        .write(|c| {
            c.execute("UPDATE assets SET storage_state = 'cloud_only', fingerprint = NULL", [])?;
            c.execute("UPDATE photos SET thumb_state = 'unavailable', thumbhash = NULL, captured_at = '2000-01-01T00:00:00.000', camera_model = NULL", [])?;
            Ok(())
        })
        .unwrap();
    let done = thumbs::fill_online(&lib.db, &lib.cache, &AtomicBool::new(false), |_| {}).unwrap();
    assert_eq!(done, 1);
    let row = lib.rows().into_iter().find(|r| r.id == id).unwrap();
    assert_eq!(row.thumb, ThumbState::Ready);
    assert_eq!(row.captured_at, "2025-10-21T14:05:30.000", "the real capture date, read from the photo");
    assert!(row.thumbhash.is_some());
    assert_eq!(row.storage, StorageState::CloudOnly, "still an online file: nothing is kept on the Mac");
    assert!(lib.cache.preview(&id).exists(), "the sharp preview comes from the same download");
    // Nothing left to do the second time.
    assert_eq!(thumbs::fill_online(&lib.db, &lib.cache, &AtomicBool::new(false), |_| {}).unwrap(), 0);
}

#[test]
fn trips_are_folders_with_counts_and_filter_the_grid() {
    let lib = Lib::new();
    lib.jpeg("SRI LANKA/KITCHEN/a.jpg", None);
    lib.jpeg("SRI LANKA/b.jpg", None);
    lib.jpeg("INDIA/c.jpg", None);
    lib.jpeg("INDIA_2/d.jpg", None);
    lib.jpeg("loose.jpg", None);
    lib.scan();
    let folders = photos::folders(&lib.db).unwrap();
    let got: Vec<(String, u8, i64)> = folders.iter().map(|f| (f.name.clone(), f.depth, f.count)).collect();
    assert_eq!(got, [("INDIA".into(), 1, 1), ("INDIA_2".into(), 1, 1), ("SRI LANKA".into(), 1, 2), ("KITCHEN".into(), 2, 1)]);
    let india = folders.iter().find(|f| f.name == "INDIA").unwrap();
    let q = photos::Query { folder: Some(india.path.clone()), ..Default::default() };
    let names: Vec<String> = photos::list(&lib.db, &q, 0, 100).unwrap().into_iter().map(|r| r.filename).collect();
    assert_eq!(names, ["c.jpg"], "INDIA_2 is not inside INDIA");
    let sri = folders.iter().find(|f| f.name == "SRI LANKA").unwrap();
    let q = photos::Query { folder: Some(sri.path.clone()), ..Default::default() };
    assert_eq!(photos::counts(&lib.db, &q).unwrap().all, 2, "a trip includes its subfolders");
}

#[test]
fn search_finds_what_is_in_the_photo() {
    let lib = Lib::new();
    lib.jpeg("NEPAL/a.jpg", None);
    lib.jpeg("GHENT/b.jpg", None);
    lib.jpeg("GHENT/c.jpg", None);
    lib.scan();
    let id = |name: &str| lib.rows().into_iter().find(|r| r.filename == name).unwrap().id;
    labels::record(&lib.db, &id("a.jpg"), &[("sunset_sunrise".into(), 0.8), ("mountain".into(), 0.6)]).unwrap();
    labels::record(&lib.db, &id("b.jpg"), &[("sunset_sunrise".into(), 0.9), ("street".into(), 0.4)]).unwrap();
    labels::record(&lib.db, &id("c.jpg"), &[("street".into(), 0.7), ("sunset_sunrise".into(), 0.1)]).unwrap();
    let find = |q: &str| {
        let mut names: Vec<String> = photos::list(&lib.db, &photos::Query { search: Some(q.into()), ..Default::default() }, 0, 100)
            .unwrap()
            .into_iter()
            .map(|r| r.filename)
            .collect();
        names.sort();
        names
    };
    assert_eq!(find("sunset"), ["a.jpg", "b.jpg"], "a faint label doesn't count");
    assert_eq!(find("dawn"), ["a.jpg", "b.jpg"], "everyday words stand for categories");
    assert_eq!(find("sunset nepal"), ["a.jpg"], "a word can match the folder, another what's in it");
    assert_eq!(find("mountains"), ["a.jpg"], "plurals too");
    assert!(find("temple").is_empty());
    assert_eq!(find("GHENT"), ["b.jpg", "c.jpg"], "folders still match as before");
}

#[test]
fn picked_labels_find_photos_with_any_of_them() {
    let lib = Lib::new();
    for n in ["a.jpg", "b.jpg", "c.jpg", "d.jpg"] {
        lib.jpeg(n, None);
    }
    lib.scan();
    let id = |name: &str| lib.rows().into_iter().find(|r| r.filename == name).unwrap().id;
    labels::record(&lib.db, &id("a.jpg"), &[("people".into(), 0.8), ("blue_sky".into(), 0.6)]).unwrap();
    labels::record(&lib.db, &id("b.jpg"), &[("boat".into(), 0.9)]).unwrap();
    labels::record(&lib.db, &id("c.jpg"), &[("people".into(), 0.1), ("cloudy_sky".into(), 0.7)]).unwrap();

    let list = labels::list(&lib.db).unwrap();
    let counts: Vec<(&str, i64)> = list.labels.iter().map(|l| (l.label.as_str(), l.count)).collect();
    assert_eq!(counts[0], ("blue_sky", 1));
    assert!(counts.contains(&("people", 1)), "a faint label isn't counted: {counts:?}");
    assert!(list.synonyms.iter().any(|(w, l)| *w == "portrait" && l.contains(&"people")));

    let find = |labels: &[&str]| {
        let q = photos::Query { labels: Some(labels.iter().map(|l| l.to_string()).collect()), ..Default::default() };
        let mut names: Vec<String> = photos::list(&lib.db, &q, 0, 100).unwrap().into_iter().map(|r| r.filename).collect();
        names.sort();
        names
    };
    assert_eq!(find(&["people", "boat"]), ["a.jpg", "b.jpg"], "any of them, faint ones left out");
    assert_eq!(find(&["sky"]), Vec::<String>::new(), "exact labels only: sky isn't blue_sky");
    assert_eq!(find(&[]).len(), 4, "no labels picked: no filter");
}

#[test]
fn photos_are_found_by_the_device_that_took_them() {
    let lib = Lib::new();
    for n in ["phone.jpg", "sony.jpg", "unknown.jpg", "TRIP/IPHONE/exported.jpg"] {
        lib.jpeg(n, None);
    }
    lib.scan();
    let id = |name: &str| lib.rows().into_iter().find(|r| r.filename == name).unwrap().id;
    for (name, make) in [("phone.jpg", "Apple"), ("sony.jpg", "SONY")] {
        let pid = id(name);
        lib.db.write(|c| { c.execute("UPDATE photos SET camera_make = ?2 WHERE id = ?1", [pid.as_str(), make])?; Ok(()) }).unwrap();
    }

    let find = |device| {
        let q = photos::Query { device: Some(device), ..Default::default() };
        let mut names: Vec<String> = photos::list(&lib.db, &q, 0, 100).unwrap().into_iter().map(|r| r.filename).collect();
        names.sort();
        let counted = photos::counts(&lib.db, &q).unwrap().all;
        assert_eq!(counted as usize, names.len(), "counts agree with the list");
        names
    };
    assert_eq!(find(photos::Device::Iphone), ["exported.jpg", "phone.jpg"], "no camera recorded, but in an IPHONE folder");
    assert_eq!(find(photos::Device::Camera), ["sony.jpg", "unknown.jpg"]);
}

#[test]
fn a_photo_is_offered_the_look_its_album_uses() {
    let lib = Lib::new();
    for n in ["a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg"] {
        lib.jpeg(n, None);
    }
    lib.scan();
    let id = |name: &str| lib.rows().into_iter().find(|r| r.filename == name).unwrap().id;
    lib.db
        .write(|c| {
            for (look, name) in [("l1", "Blade Runner"), ("l2", "Portra")] {
                c.execute(
                    "INSERT INTO looks (id, kind, name, collection, source_path, created_ms) VALUES (?1, 'cube', ?2, 'Test', ?1, 0)",
                    [look, name],
                )?;
            }
            Ok(())
        })
        .unwrap();
    let faces = albums::create(&lib.db, "FACES", "").unwrap();
    let trips = albums::create(&lib.db, "TRIPS", "").unwrap();
    albums::add_photos(&lib.db, &faces.id, &[id("a.jpg"), id("b.jpg"), id("c.jpg"), id("e.jpg")]).unwrap();
    albums::add_photos(&lib.db, &trips.id, &[id("d.jpg"), id("e.jpg")]).unwrap();

    assert_eq!(looks::album_look(&lib.db, &id("e.jpg")).unwrap(), None, "no look in its albums yet");

    let grain = looks::Adjustments { grain: 30.0, contrast: 12.0, ..Default::default() };
    let cropped = looks::Adjustments { crop_zoom: 40.0, straighten: 2.0, ..grain };
    looks::apply(&lib.db, &[id("a.jpg")], Some("l1"), 0.7, Some(&cropped)).unwrap();
    looks::apply(&lib.db, &[id("b.jpg")], Some("l1"), 0.7, Some(&grain)).unwrap();
    looks::apply(&lib.db, &[id("c.jpg")], Some("l1"), 1.0, None).unwrap();
    looks::apply(&lib.db, &[id("d.jpg")], Some("l2"), 1.0, None).unwrap();

    let offered = looks::album_look(&lib.db, &id("e.jpg")).unwrap().unwrap();
    assert_eq!(offered.album_name, "FACES", "the album with the most uses wins");
    assert!(!offered.set, "a suggestion until the album gets a look of its own");
    assert!(!offered.this_photo);
    assert_eq!(offered.look_id.as_deref(), Some("l1"));
    assert_eq!(offered.uses, 3);
    assert!((offered.strength - 0.7).abs() < 1e-9, "the edit made most");
    assert_eq!(offered.adjustments, grain, "the whole edit, without anyone's crop");
    looks::apply(&lib.db, &[id("e.jpg")], Some("l1"), 0.7, Some(&grain)).unwrap();
    assert!(looks::album_look(&lib.db, &id("e.jpg")).unwrap().unwrap().this_photo, "applied, e is on it");
    looks::apply(&lib.db, &[id("e.jpg")], None, 1.0, Some(&looks::Adjustments::default())).unwrap();

    // The album gets its own look: it wins over the suggestion, and changing
    // it moves the photos still exactly on it (keeping their crop) and no others.
    let recipe = looks::Recipe::new(Some("l1".into()), 0.7, &grain);
    looks::set_album_look(&lib.db, &faces.id, Some(&recipe)).unwrap();
    let own = looks::album_look(&lib.db, &id("e.jpg")).unwrap().unwrap();
    assert!(own.set);
    assert_eq!(own.uses, 2, "a (cropped) and b are on it; c's strength differs");

    let softer = looks::Adjustments { grain: 15.0, ..grain };
    let change = looks::change_album_look(&lib.db, &faces.id, &looks::Recipe::new(Some("l1".into()), 0.7, &softer)).unwrap();
    assert_eq!(change.previous, Some(recipe.clone()));
    let mut moved: Vec<&str> = change.updated.iter().map(|p| p.photo_id.as_str()).collect();
    moved.sort();
    let mut expected = [id("a.jpg"), id("b.jpg")];
    expected.sort();
    assert_eq!(moved, expected.iter().map(String::as_str).collect::<Vec<_>>());
    assert_eq!(change.left_alone, 1, "c was edited its own way");
    let a = looks::for_photo(&lib.db, &id("a.jpg")).unwrap();
    assert_eq!(a.adjustments, looks::Adjustments { grain: 15.0, ..cropped }, "a keeps its crop");
    assert!((looks::for_photo(&lib.db, &id("c.jpg")).unwrap().strength - 1.0).abs() < 1e-9, "c untouched");
    assert_eq!(looks::album_look(&lib.db, &id("e.jpg")).unwrap().unwrap().adjustments.grain, 15.0);

    looks::set_album_look(&lib.db, &faces.id, None).unwrap();
    assert!(!looks::album_look(&lib.db, &id("e.jpg")).unwrap().unwrap().set, "back to a suggestion");
}

#[test]
fn an_edit_saved_as_a_look_keeps_its_sliders_and_strength() {
    let lib = Lib::new();
    let looks_dir = lib.dir.path().join("looks");
    // A LUT that turns everything black, so half strength is easy to see.
    let cube = lib.dir.path().join("black.cube");
    std::fs::write(&cube, format!("LUT_3D_SIZE 2\n{}", "0 0 0\n".repeat(8))).unwrap();
    lib.db
        .write(|c| {
            c.execute(
                "INSERT INTO looks (id, kind, name, collection, source_path, created_ms) VALUES ('black', 'cube', 'Black', 'Your LUTs', ?1, 0)",
                [cube.to_string_lossy()],
            )?;
            Ok(())
        })
        .unwrap();
    let adj = looks::Adjustments { grain: 40.0, exposure: 0.3, crop_zoom: 50.0, ..Default::default() };
    let saved = looks::save(&lib.db, &looks_dir, "  Faces  ", Some("black"), 0.5, &adj).unwrap();
    assert_eq!(saved.name, "Faces");
    assert_eq!(saved.kind, looks::Kind::Saved);
    assert_eq!(saved.collection, looks::YOUR_LOOKS);
    assert!(saved.baked);
    assert_eq!(saved.adjustments, Some(looks::Adjustments { crop_zoom: 0.0, ..adj }), "never the crop");
    assert_eq!(saved.effects.grain, 40.0);

    let table = std::fs::read(looks::lut_path(&looks_dir, &saved.id)).unwrap();
    assert_eq!(&table[table.len() - 4..table.len() - 1], &[128, 128, 128], "white, half way to black");
    assert_eq!(looks::list(&lib.db, &looks_dir).unwrap()[0].id, saved.id, "your looks come first");
    assert!(looks::save(&lib.db, &looks_dir, " ", None, 1.0, &adj).is_err(), "a look needs a name");
}

/// What an online-only (cloud) file looks like to the app when it was first
/// scanned: no fingerprint, because its contents were never read.
fn forget_fingerprints(lib: &Lib) {
    lib.db.write(|c| { c.execute("UPDATE assets SET fingerprint = NULL", [])?; Ok(()) }).unwrap();
}

fn photo_count(lib: &Lib) -> i64 {
    lib.db.read(|c| Ok(c.query_row("SELECT COUNT(*) FROM photos", [], |r| r.get(0))?)).unwrap()
}

#[test]
fn a_moved_cloud_file_keeps_its_photo_and_review() {
    let lib = Lib::new();
    let original = lib.jpeg("ARCHIVE/a.jpg", None);
    lib.scan();
    let id = lib.rows()[0].id.clone();
    photos::set_review(&lib.db, &[id.clone()], ReviewState::Rejected).unwrap();
    forget_fingerprints(&lib);

    std::fs::rename(&original, lib.path("EGYPT/a.jpg")).unwrap();
    let stats = lib.scan();
    assert_eq!((stats.moved, stats.added), (1, 0), "same name and size, old path gone: a move");
    assert_eq!(photo_count(&lib), 1);
    let rows = lib.rows();
    assert_eq!(rows[0].id, id);
    assert_eq!(rows[0].review, ReviewState::Rejected);
}

#[test]
fn duplicates_left_by_an_unmatched_move_are_merged() {
    let lib = Lib::new();
    let original = lib.jpeg("ARCHIVE/b.jpg", None);
    lib.jpeg("ARCHIVE/c.jpg", None);
    lib.scan();
    let id = lib.rows().into_iter().find(|r| r.filename == "b.jpg").unwrap().id;
    photos::set_review(&lib.db, &[id.clone()], ReviewState::Selected).unwrap();
    forget_fingerprints(&lib);

    // A copy first (the original still there), then the original goes: the
    // state a move of cloud-only files used to leave behind.
    std::fs::copy(&original, lib.path("EGYPT/b.jpg")).unwrap();
    lib.scan();
    assert_eq!(photo_count(&lib), 3, "a copy is a new photo while the original is there");
    std::fs::remove_file(&original).unwrap();
    lib.scan();

    assert_eq!(photo_count(&lib), 2, "the duplicate is merged into the original photo");
    let b = lib.rows().into_iter().find(|r| r.filename == "b.jpg").unwrap();
    assert_eq!(b.id, id, "the original photo, with its review, now at the new place");
    assert_eq!(b.review, ReviewState::Selected);
    let dir: String = lib.db.read(|c| Ok(c.query_row("SELECT dir FROM assets WHERE photo_id = ?1", [&id], |r| r.get(0))?)).unwrap();
    assert!(dir.ends_with("EGYPT"), "{dir}");
}

/// A trip folder as the library knows it (the source path, resolved).
fn trip(lib: &Lib, name: &str) -> String {
    std::fs::canonicalize(&lib.root).unwrap().join(name).to_string_lossy().into_owned()
}

#[test]
fn a_photo_moved_to_another_trip_takes_its_files_and_keeps_its_review() {
    let lib = Lib::new();
    lib.jpeg("EGYPT/IPHONE/IMG_1.jpg", None);
    lib.fake_raw("EGYPT/DSC_2.ARW");
    lib.jpeg("EGYPT/DSC_2.JPG", None);
    lib.jpeg("FRANCE/DSC_3.JPG", None);
    lib.scan();
    let id = |name: &str| lib.rows().into_iter().find(|r| r.filename == name).unwrap().id;
    let (phone, pair) = (id("IMG_1.jpg"), id("DSC_2.JPG"));
    photos::set_review(&lib.db, &[phone.clone()], ReviewState::Selected).unwrap();

    let france = trip(&lib, "FRANCE");
    let report = trips::move_to_trip(&lib.db, &[phone.clone(), pair.clone(), id("DSC_3.JPG")], &france).unwrap();
    assert_eq!((report.moved, report.already, report.failed.len()), (2, 1, 0));
    for (gone, there) in [("EGYPT/IPHONE/IMG_1.jpg", "FRANCE/IPHONE/IMG_1.jpg"), ("EGYPT/DSC_2.ARW", "FRANCE/DSC_2.ARW"), ("EGYPT/DSC_2.JPG", "FRANCE/DSC_2.JPG")] {
        assert!(!lib.root.join(gone).exists() && lib.root.join(there).exists(), "{gone} → {there}");
    }
    let row = lib.rows().into_iter().find(|r| r.id == phone).unwrap();
    assert_eq!(row.review, ReviewState::Selected, "the mark stays with the photo");

    let stats = lib.scan();
    assert_eq!((stats.added, stats.missing), (0, 0), "a rescan finds nothing new or lost");
    assert_eq!(lib.rows().len(), 3);

    assert_eq!(trips::undo(&lib.db, &report.undo).unwrap(), 3);
    assert!(lib.root.join("EGYPT/IPHONE/IMG_1.jpg").exists() && lib.root.join("EGYPT/DSC_2.ARW").exists());
    let stats = lib.scan();
    assert_eq!((stats.added, stats.missing), (0, 0));
}

#[test]
fn a_name_already_in_the_trip_gets_a_number_and_a_new_trip_is_made() {
    let lib = Lib::new();
    lib.fake_raw("EGYPT/DSC_1.ARW");
    lib.jpeg("EGYPT/DSC_1.JPG", None);
    lib.jpeg("FRANCE/DSC_1.JPG", None);
    lib.jpeg("EGYPT/DSC_9.JPG", None);
    lib.scan();
    let in_egypt = photos::Query { folder: Some(trip(&lib, "EGYPT")), ..Default::default() };
    let egypt_pair = photos::list(&lib.db, &in_egypt, 0, 10).unwrap().into_iter().find(|r| r.filename == "DSC_1.JPG").unwrap().id;
    let france = trip(&lib, "FRANCE");
    trips::move_to_trip(&lib.db, &[egypt_pair], &france).unwrap();
    assert!(lib.root.join("FRANCE/DSC_1 2.JPG").exists() && lib.root.join("FRANCE/DSC_1 2.ARW").exists(), "the pair keeps matching names");
    assert!(lib.root.join("FRANCE/DSC_1.JPG").exists(), "the photo already there is untouched");

    let nine = lib.rows().into_iter().find(|r| r.filename == "DSC_9.JPG").unwrap().id;
    let thailand = trip(&lib, "THAILAND");
    assert_eq!(trips::move_to_trip(&lib.db, &[nine], &thailand).unwrap().moved, 1);
    assert!(lib.root.join("THAILAND/DSC_9.JPG").exists());
    assert_eq!(lib.scan().added, 0);

    let elsewhere = lib.dir.path().join("Elsewhere/TRIP").to_string_lossy().into_owned();
    let any = lib.rows()[0].id.clone();
    assert_eq!(trips::move_to_trip(&lib.db, &[any], &elsewhere).unwrap().failed.len(), 1, "only into a trip of the same source");
}

#[test]
fn photos_taken_far_from_their_trip_are_flagged_with_where_they_belong() {
    let lib = Lib::new();
    for i in 0..6 {
        lib.jpeg(&format!("EGYPT/e{i}.jpg"), None);
        lib.jpeg(&format!("FRANCE/f{i}.jpg"), None);
    }
    lib.jpeg("EGYPT/paris.jpg", None);
    lib.jpeg("EGYPT/tokyo.jpg", None);
    lib.scan();
    lib.db
        .write(|c| {
            c.execute("UPDATE photos SET latitude = 30.0, longitude = 31.2 WHERE id IN (SELECT photo_id FROM assets WHERE filename LIKE 'e%')", [])?;
            c.execute("UPDATE photos SET latitude = 48.85, longitude = 2.35 WHERE id IN (SELECT photo_id FROM assets WHERE filename LIKE 'f%' OR filename = 'paris.jpg')", [])?;
            c.execute("UPDATE photos SET latitude = 35.7, longitude = 139.7 WHERE id IN (SELECT photo_id FROM assets WHERE filename = 'tokyo.jpg')", [])?;
            Ok(())
        })
        .unwrap();
    let id = |name: &str| lib.rows().into_iter().find(|r| r.filename == name).unwrap().id;
    let egypt = trip(&lib, "EGYPT");
    let france = trip(&lib, "FRANCE");
    let mut found = trips::misplaced(&lib.db, &egypt).unwrap();
    found.sort_by_key(|m| m.near.is_none());
    assert_eq!(found, [
        trips::Misplaced { id: id("paris.jpg"), near: Some(france.clone()) },
        trips::Misplaced { id: id("tokyo.jpg"), near: None },
    ]);
    assert!(trips::misplaced(&lib.db, &france).unwrap().is_empty());

    let q = photos::Query { ids: Some(found.iter().map(|m| m.id.clone()).collect()), ..Default::default() };
    let mut shown: Vec<String> = photos::list(&lib.db, &q, 0, 10).unwrap().into_iter().map(|r| r.filename).collect();
    shown.sort();
    assert_eq!(shown, ["paris.jpg", "tokyo.jpg"], "the flagged photos can be listed on their own");
    assert_eq!(photos::counts(&lib.db, &q).unwrap().all, 2);
}

#[test]
fn a_video_keeps_its_trim() {
    let lib = Lib::new();
    lib.jpeg("a.jpg", None);
    lib.scan();
    let id = lib.rows()[0].id.clone();
    assert_eq!(moments::trim(&lib.db, &id).unwrap(), None, "untrimmed: the whole clip");
    moments::set_trim(&lib.db, &id, 9.5, 2.0).unwrap();
    assert_eq!(moments::trim(&lib.db, &id).unwrap(), Some((2.0, 9.5)), "the two points in either order");
    moments::set_trim(&lib.db, &id, -1.0, 4.0).unwrap();
    assert_eq!(moments::trim(&lib.db, &id).unwrap(), Some((0.0, 4.0)));
    moments::clear_trim(&lib.db, &id).unwrap();
    assert_eq!(moments::trim(&lib.db, &id).unwrap(), None);
}

#[test]
fn a_shoot_is_renamed_with_numbers_and_the_names_can_go_back() {
    let lib = Lib::new();
    lib.fake_raw("SHOOT/abc.ARW");
    lib.jpeg("SHOOT/abc.JPG", Some(("2026:04:25 10:00:01", "ILCE-7M4")));
    lib.jpeg("SHOOT/zzz.jpg", Some(("2026:04:25 10:00:00", "ILCE-7M4")));
    lib.jpeg("SHOOT/Studio Example 02.jpg", Some(("2026:04:25 09:00:00", "ILCE-7M4")));
    lib.scan();
    let id = |name: &str| lib.rows().into_iter().find(|r| r.filename == name).unwrap().id;
    let (pair, single) = (id("abc.JPG"), id("zzz.jpg"));
    let report = trips::rename_photos(&lib.db, &[pair.clone(), single.clone()], "Studio Example", 1).unwrap();
    assert_eq!((report.moved, report.failed.len()), (2, 0));
    // In shooting order; a name already taken by another photo gets skipped over.
    assert!(lib.root.join("SHOOT/Studio Example 01.jpg").exists(), "the earlier shot is 01");
    assert!(lib.root.join("SHOOT/Studio Example 03.JPG").exists() && lib.root.join("SHOOT/Studio Example 03.ARW").exists(), "the pair keeps one name");
    assert!(lib.root.join("SHOOT/Studio Example 02.jpg").exists(), "the photo already called 02 is left alone");
    assert_eq!(lib.scan().added, 0);
    trips::undo(&lib.db, &report.undo).unwrap();
    assert!(lib.root.join("SHOOT/abc.ARW").exists() && lib.root.join("SHOOT/zzz.jpg").exists());
    assert_eq!(lib.scan().added, 0);
}

#[test]
fn photos_move_into_a_place_inside_their_trip() {
    let lib = Lib::new();
    lib.jpeg("THAILAND/IPHONE/IMG_1.jpg", None);
    lib.jpeg("THAILAND/DSC_2.JPG", None);
    lib.jpeg("SAMROIYOT/IPHONE/IMG_3.jpg", None);
    lib.scan();
    let id = |name: &str| lib.rows().into_iter().find(|r| r.filename == name).unwrap().id;
    let thailand = trip(&lib, "THAILAND");
    let r = trips::move_into(&lib.db, &[id("IMG_1.jpg"), id("DSC_2.JPG")], &thailand, &format!("{thailand}/PAI")).unwrap();
    assert_eq!(r.moved, 2);
    assert!(lib.root.join("THAILAND/PAI/IPHONE/IMG_1.jpg").exists() && lib.root.join("THAILAND/PAI/DSC_2.JPG").exists());
    // A whole trip into another one, as a place of it.
    let r = trips::move_into(&lib.db, &[id("IMG_3.jpg")], &trip(&lib, "SAMROIYOT"), &format!("{thailand}/SAM ROI YOT")).unwrap();
    assert_eq!(r.moved, 1);
    assert!(lib.root.join("THAILAND/SAM ROI YOT/IPHONE/IMG_3.jpg").exists());
    assert_eq!(lib.scan().added, 0);
    // Not in `from`: left alone.
    assert_eq!(trips::move_into(&lib.db, &[id("IMG_3.jpg")], &trip(&lib, "SAMROIYOT"), &thailand).unwrap().already, 1);
}

#[test]
fn clean_up_bins_only_rejected_photos_marked_delete_and_undo_brings_them_back() {
    let lib = Lib::new();
    lib.fake_raw("EGYPT/DSC_1.ARW");
    lib.jpeg("EGYPT/DSC_1.JPG", None);
    lib.jpeg("EGYPT/IPHONE/IMG_2.jpg", None);
    lib.jpeg("EGYPT/DSC_3.JPG", None);
    lib.jpeg("EGYPT/DSC_4.JPG", None);
    lib.scan();
    let id = |name: &str| lib.rows().into_iter().find(|r| r.filename == name).map(|r| r.id);
    let (one, two, three, four) = (id("DSC_1.JPG").unwrap(), id("IMG_2.jpg").unwrap(), id("DSC_3.JPG").unwrap(), id("DSC_4.JPG").unwrap());
    photos::set_review(&lib.db, &[one.clone(), two.clone(), three.clone()], ReviewState::Rejected).unwrap();
    photos::set_review(&lib.db, &[four.clone()], ReviewState::Selected).unwrap();
    // Tagged: used, so never offered. On the website: the same.
    tags::add(&lib.db, &["★ Extraordinary".into()], &[three.clone()]).unwrap();
    let website: std::collections::HashSet<String> = [two.clone()].into();
    let egypt = trip(&lib, "EGYPT");
    let o = cleanup::overview(&lib.db, &website).unwrap();
    assert_eq!((o.trips.len(), o.trips[0].photos, o.trips[0].to_delete, o.protected), (1, 1, 0, 2));
    // Rejected photos start as kept; only a mark sends one. A selected photo takes no mark.
    assert_eq!(cleanup::mark(&lib.db, &[one.clone(), four.clone()], Some("delete")).unwrap(), 1);
    let bin = lib.dir.path().join("Bin");
    std::fs::create_dir_all(&bin).unwrap();
    let trash = |paths: &[String]| -> Vec<Result<String, String>> {
        paths
            .iter()
            .map(|p| {
                let to = bin.join(Path::new(p).file_name().unwrap());
                std::fs::rename(p, &to).map(|_| to.to_string_lossy().into_owned()).map_err(|e| e.to_string())
            })
            .collect()
    };
    // The confirmed number must match what's marked now.
    assert!(cleanup::bin_trip(&lib.db, &egypt, &[one.clone(), two.clone()], &website, &trash).is_err());
    assert!(cleanup::bin_trip(&lib.db, &egypt, &[two.clone()], &website, &trash).is_err());
    assert!(lib.root.join("EGYPT/DSC_1.JPG").exists());
    let r = cleanup::bin_trip(&lib.db, &egypt, &[one.clone()], &website, &trash).unwrap();
    assert_eq!((r.photos, r.failed.len()), (1, 0));
    // RAW and JPEG went together; the library forgot the photo; nothing else moved.
    assert!(!lib.root.join("EGYPT/DSC_1.JPG").exists() && !lib.root.join("EGYPT/DSC_1.ARW").exists());
    assert!(bin.join("DSC_1.ARW").exists() && bin.join("DSC_1.JPG").exists());
    assert!(id("DSC_1.JPG").is_none() && id("DSC_3.JPG").is_some() && id("IMG_2.jpg").is_some());
    assert_eq!(lib.scan().added, 0);
    let h = cleanup::history(&lib.db).unwrap();
    assert_eq!((h.len(), h[0].photos, h[0].restored), (1, 1, false));
    assert_eq!(cleanup::phone_queries(&lib.db, &h[0].batch).unwrap().len(), 1);
    // Undo: back in place, Rejected and marked to delete, as before.
    let restore = |pairs: &[(String, String)]| -> Vec<Result<(), String>> { pairs.iter().map(|(b, o)| std::fs::rename(b, o).map_err(|e| e.to_string())).collect() };
    let u = cleanup::undo(&lib.db, &h[0].batch, &restore).unwrap();
    assert_eq!((u.photos, u.failed.len()), (1, 0));
    assert!(lib.root.join("EGYPT/DSC_1.JPG").exists() && lib.root.join("EGYPT/DSC_1.ARW").exists());
    let back = lib.rows().into_iter().find(|r| r.filename == "DSC_1.JPG").unwrap();
    assert_eq!(back.review, ReviewState::Rejected);
    assert_eq!(cleanup::overview(&lib.db, &website).unwrap().trips[0].to_delete, 1);
    assert!(cleanup::history(&lib.db).unwrap()[0].restored);
}

#[test]
fn clean_up_knows_copies_of_kept_photos_whole_rejected_scenes_soft_and_documents() {
    let lib = Lib::new();
    for n in 1..=5 {
        lib.jpeg(&format!("EGYPT/DSC_{n}.JPG"), None);
    }
    lib.scan();
    let id = |n: u32| lib.rows().into_iter().find(|r| r.filename == format!("DSC_{n}.JPG")).unwrap().id;
    let ids: Vec<String> = (1..=5).map(id).collect();
    photos::set_review(&lib.db, &[ids[0].clone(), ids[2].clone(), ids[3].clone(), ids[4].clone()], ReviewState::Rejected).unwrap();
    photos::set_review(&lib.db, &[ids[1].clone()], ReviewState::Selected).unwrap();
    // 1 and 2 are one scene (2 kept); 3 and 4 another (both rejected); 5 is a soft document.
    lib.db
        .write(|c| {
            for (i, (burst, sharp, utility)) in [(Some("s1"), 20.0, 0), (Some("s1"), 20.0, 0), (Some("s2"), 20.0, 0), (Some("s2"), 20.0, 0), (None, 1.0, 1)].iter().enumerate() {
                c.execute(
                    "INSERT OR REPLACE INTO photo_analysis (photo_id, sharpness, brightness, clip_hi, clip_lo, p01, p50, p99, mean_r, mean_g, mean_b, burst_id, burst_size, analysed_ms, utility)
                     VALUES (?1, ?2, 0.5, 0, 0, 0, 0.5, 1, 0.5, 0.5, 0.5, ?3, 2, 0, ?4)",
                    rusqlite::params![ids[i], sharp, burst, utility],
                )?;
            }
            Ok(())
        })
        .unwrap();
    let none = std::collections::HashSet::new();
    let sets: std::collections::HashMap<String, Vec<&str>> = cleanup::trip_photos(&lib.db, &trip(&lib, "EGYPT"), &none).unwrap().into_iter().map(|c| (c.id, c.sets)).collect();
    assert_eq!(sets[&ids[0]], ["copy"]);
    assert_eq!(sets[&ids[2]], ["scene"]);
    assert_eq!(sets[&ids[3]], ["scene"]);
    assert_eq!(sets[&ids[4]], ["soft", "utility"]);
    assert!(!sets.contains_key(&ids[1]));
    let o = cleanup::overview(&lib.db, &none).unwrap();
    assert_eq!(o.trips[0].copies, 1);
    // One group marked everywhere at once; marking never deletes.
    assert_eq!(cleanup::mark_set(&lib.db, "scene", Some("delete"), &none).unwrap(), 2);
    let o = cleanup::overview(&lib.db, &none).unwrap();
    assert_eq!((o.trips[0].to_delete, o.trips[0].photos), (2, 4));
}

#[test]
fn a_trip_splits_into_its_places_and_keeps_existing_place_folders() {
    let lib = Lib::new();
    // name, count, (lat, lon), folder
    let spots = [("PAI", 22, Some((19.36, 98.44)), "THAILAND/IPHONE"), ("BKK", 21, Some((13.75, 100.50)), "THAILAND"), ("KRA", 20, Some((8.05, 98.90)), "THAILAND/IPHONE"), ("FAR", 3, Some((9.5, 100.0)), "THAILAND"), ("NOLOC", 2, None, "THAILAND/IPHONE")];
    let mut n = 0;
    for (tag, count, _, folder) in spots {
        for i in 0..count {
            lib.jpeg(&format!("{folder}/{tag}_{i}.jpg"), None);
            n += 1;
        }
    }
    lib.jpeg("THAILAND/KRABI/OLD_1.jpg", None);
    lib.scan();
    let rows = lib.rows();
    assert_eq!(rows.len(), n + 1);
    lib.db
        .write(|c| {
            for r in &rows {
                let tag = r.filename.split('_').next().unwrap();
                let (loc, at) = match tag {
                    "PAI" => (Some((19.36, 98.44)), "2025-01-10T10:00:00"),
                    "BKK" => (Some((13.75, 100.50)), "2025-01-20T10:00:00"),
                    "KRA" | "OLD" => (Some((8.05, 98.90)), "2025-01-30T10:00:00"),
                    "FAR" => (Some((9.5, 100.0)), "2025-02-05T10:00:00"),
                    _ => (None, "2025-01-10T13:00:00"), // three hours after the Pai photos
                };
                c.execute("UPDATE photos SET latitude = ?2, longitude = ?3, captured_at = ?4 WHERE id = ?1", rusqlite::params![r.id, loc.map(|l| l.0), loc.map(|l| l.1), at])?;
            }
            Ok(())
        })
        .unwrap();
    let thailand = trip(&lib, "THAILAND");
    let named = |probes: &[(f64, f64)]| Some((if probes[0].0 > 19.0 { "Pai District" } else { "Bangkok" }.to_owned(), "Thailand".to_owned()));
    let p = places::propose(&lib.db, &thailand, &named).unwrap();
    let by: std::collections::HashMap<&str, (usize, bool)> = p.places.iter().map(|pl| (pl.name.as_str(), (pl.photos, pl.existing))).collect();
    assert_eq!(by["PAI"], (24, false), "{p:?}"); // 22 + the 2 without a location
    assert_eq!(by["BANGKOK"], (21, false));
    assert_eq!(by["KRABI"], (20, true)); // the folder the trip already has
    assert_eq!(p.elsewhere, 3);
    // Bangkok left out: those photos stay where they are.
    let choices: Vec<places::Choice> = p.places.iter().filter(|pl| pl.name != "BANGKOK").map(|pl| places::Choice { key: pl.key.clone(), name: pl.name.clone() }).collect();
    let r = places::make(&lib.db, &thailand, &choices).unwrap();
    assert_eq!((r.moved, r.failed.len()), (44, 0));
    assert!(lib.root.join("THAILAND/PAI/IPHONE/PAI_0.jpg").exists() && lib.root.join("THAILAND/PAI/IPHONE/NOLOC_1.jpg").exists());
    assert!(lib.root.join("THAILAND/KRABI/IPHONE/KRA_0.jpg").exists());
    assert!(lib.root.join("THAILAND/BKK_0.jpg").exists() && lib.root.join("THAILAND/FAR_0.jpg").exists());
    assert_eq!(lib.scan().added, 0);
    // Undo puts every file back.
    trips::undo(&lib.db, &r.undo).unwrap();
    assert!(lib.root.join("THAILAND/IPHONE/PAI_0.jpg").exists());
}

#[test]
fn saves_gather_into_a_board_that_can_be_linked_and_undone() {
    use captured_by_andy_lib::library::studio;
    let lib = Lib::new();
    let row = |v: serde_json::Value| v.as_object().unwrap().clone();
    let pillar = studio::save(&lib.db, "pillars", None, &row(serde_json::json!({ "name": "Clinics", "position": 0 }))).unwrap();
    let ids: Vec<String> = (0..4)
        .map(|i| {
            let s = studio::save(&lib.db, "saves", None, &row(serde_json::json!({ "kind": "link", "title": format!("Clinic video {i}") }))).unwrap();
            s["id"].as_str().unwrap().to_owned()
        })
        .collect();
    let board = studio::save(&lib.db, "boards", None, &row(serde_json::json!({ "title": "Clinic X", "client": "Dr Example", "pillarId": pillar["id"] }))).unwrap();
    let bid = board["id"].as_str().unwrap().to_owned();
    for id in &ids {
        studio::save(&lib.db, "saves", Some(id), &row(serde_json::json!({ "boardId": bid }))).unwrap();
    }
    let all = studio::list(&lib.db, "saves", &serde_json::Map::new()).unwrap();
    assert_eq!(all.iter().filter(|s| s["boardId"] == serde_json::json!(bid)).count(), 4);
    // Ungrouping (removing the board) keeps every save.
    studio::delete(&lib.db, "boards", &bid, "menu").unwrap();
    let all = studio::list(&lib.db, "saves", &serde_json::Map::new()).unwrap();
    assert_eq!(all.len(), 4);
    assert!(all.iter().all(|s| s["boardId"].is_null()));
}

#[test]
fn an_item_from_elsewhere_is_copied_into_a_folder_and_added() {
    let lib = Lib::new();
    lib.jpeg("EGYPT/DSC_1.JPG", None);
    lib.scan();
    // Files outside the library (a download), one of them a name EGYPT already has.
    let outside = lib.dir.path().join("Downloads");
    std::fs::create_dir_all(&outside).unwrap();
    let a = outside.join("DSC_1.JPG");
    let b = outside.join("portrait.jpg");
    std::fs::copy(lib.root.join("EGYPT/DSC_1.JPG"), &a).unwrap();
    std::fs::copy(lib.root.join("EGYPT/DSC_1.JPG"), &b).unwrap();
    std::fs::write(outside.join("notes.txt"), "not a photo").unwrap();
    let ids = trips::add_files(&lib.db, &[a.clone(), b.clone(), outside.join("notes.txt")], &lib.root.join("EGYPT/STUDIO"), &media::read_metadata).unwrap();
    assert_eq!(ids.len(), 2);
    assert!(lib.root.join("EGYPT/STUDIO/DSC_1.JPG").exists() && lib.root.join("EGYPT/STUDIO/portrait.jpg").exists());
    assert!(a.exists() && b.exists(), "the originals stay where they were");
    assert_eq!(lib.rows().len(), 3);
    assert_eq!(lib.scan().added, 0);
    // Adding the same one again: a second copy, " 2".
    trips::add_files(&lib.db, &[b.clone()], &lib.root.join("EGYPT/STUDIO"), &media::read_metadata).unwrap();
    assert!(lib.root.join("EGYPT/STUDIO/portrait 2.jpg").exists());
    // Outside every library folder: refused, nothing copied.
    assert!(trips::add_files(&lib.db, &[b.clone()], &outside.join("elsewhere"), &media::read_metadata).is_err());
    assert!(!outside.join("elsewhere").exists());
}

#[test]
fn knowledge_notes_become_library_saves_once_and_never_overwrite_andys_words() {
    use captured_by_andy_lib::library::studio;
    let lib = Lib::new();
    let dir = lib.dir.path().join("KNOWLEDGE");
    std::fs::create_dir_all(&dir).unwrap();
    let note = |file: &str, title: &str, url: &str| {
        std::fs::write(
            dir.join(file),
            format!("---\ntitle: '{title}'\ncreator: Kallaway\nurl: {url}\nplatform: instagram\nadded: 2026-10-24\ntags: [hooks,storytelling]\nkind: knowledge\n---\n# {title}\n\n## The idea\nPeople scroll past what they **already know**.\nPresent it as news.\n\nSecond paragraph, not taken.\n\n## The steps\n1. one\n"),
        )
        .unwrap();
    };
    note("a.md", "The Illusion of Novelty", "https://www.instagram.com/reel/Db-zJhiuXP3/?igsh=abc");
    note("b.md", "Visual hooks", "https://www.youtube.com/watch?v=abc123");
    std::fs::write(dir.join("PLAYBOOK.md"), "---\nkind: playbook\n---\n# Playbook\n").unwrap();
    std::fs::write(dir.join("c.md"), "---\ntitle: No link\nkind: knowledge\n---\n## The idea\nx\n").unwrap();
    // A note whose first section has another name: that section's first paragraph.
    std::fs::write(dir.join("d.md"), "---\ntitle: Copy\ncreator: Harry Dry\nurl: https://www.youtube.com/watch?v=zzz\nkind: knowledge\n---\n# Copy\n\n## The thesis\nShow, don't tell.\n\n## Rules\n- one\n").unwrap();
    // Andy saved the first reel by hand already, with his own words.
    let mine = studio::add_link(&lib.db, lib.dir.path(), "https://www.instagram.com/reel/Db-zJhiuXP3/", "paste", true).unwrap();
    let row = |v: serde_json::Value| v.as_object().unwrap().clone();
    studio::save(&lib.db, "saves", Some(mine["id"].as_str().unwrap()), &row(serde_json::json!({ "why": "my own note" }))).unwrap();

    let r = studio::import_knowledge(&lib.db, lib.dir.path(), &dir).unwrap();
    assert_eq!((r.notes, r.added, r.updated, r.skipped.len()), (4, 2, 1, 1), "{r:?}");
    let saves = studio::list(&lib.db, "saves", &serde_json::Map::new()).unwrap();
    assert_eq!(saves.len(), 3);
    assert_eq!(saves.iter().find(|s| s["url"].as_str().unwrap().contains("zzz")).unwrap()["why"], "Show, don't tell.");
    let a = saves.iter().find(|s| s["url"].as_str().unwrap().contains("instagram")).unwrap();
    assert_eq!(a["why"], "my own note");
    assert_eq!(a["title"], "The Illusion of Novelty");
    assert_eq!(a["author"], "Kallaway");
    assert_eq!(a["status"], "library");
    let b = saves.iter().find(|s| s["url"].as_str().unwrap().contains("abc123")).unwrap();
    assert_eq!(b["why"], "People scroll past what they already know. Present it as news.");
    assert_eq!(b["tags"], "hooks, storytelling");
    assert_eq!(b["topic"], "video");
    // Again: nothing new, nothing doubled.
    let again = studio::import_knowledge(&lib.db, lib.dir.path(), &dir).unwrap();
    assert_eq!((again.added, again.updated), (0, 3));
    assert_eq!(studio::list(&lib.db, "saves", &serde_json::Map::new()).unwrap().len(), 3);
}

/// Three "clips" (an .mp4 name is enough for the scan to call it a video),
/// filmed one day apart, with a review copy each.
fn three_clips(lib: &Lib) -> Vec<String> {
    for (i, name) in ["a.mp4", "b.mp4", "c.mp4"].iter().enumerate() {
        let p = lib.fake_raw(name);
        set_mtime(&p, SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000 + i as u64 * 86_400));
    }
    lib.scan();
    let mut rows: Vec<_> = lib.rows().into_iter().filter(|r| r.is_video).collect();
    rows.sort_by(|a, b| a.filename.cmp(&b.filename));
    let ids: Vec<String> = rows.into_iter().map(|r| r.id).collect();
    assert_eq!(ids.len(), 3, "the scan sees three clips");
    std::fs::create_dir_all(review::dir(lib.cache.root())).unwrap();
    for id in &ids {
        std::fs::write(review::copy_path(lib.cache.root(), id), vec![0u8; 1000]).unwrap();
    }
    ids
}

#[test]
fn culling_keeps_every_preview() {
    let lib = Lib::new();
    let ids = three_clips(&lib);
    photos::set_review(&lib.db, &[ids[0].clone()], ReviewState::Selected).unwrap();
    photos::set_review(&lib.db, &[ids[1].clone()], ReviewState::Rejected).unwrap();
    photos::set_review(&lib.db, &[ids[2].clone()], ReviewState::Maybe).unwrap();
    let (removed, _) = review::offload_culled(&lib.db, lib.cache.root(), |_| true).unwrap();
    assert_eq!(removed, 0, "local originals: nothing to release");
    assert!(review::existing(lib.cache.root(), &ids[0]).is_some(), "a selected clip keeps its preview");
    assert!(review::existing(lib.cache.root(), &ids[1]).is_some(), "a rejected clip keeps it too (going back plays instantly)");
    assert!(review::existing(lib.cache.root(), &ids[2]).is_some(), "a maybe keeps it");
}

#[test]
fn previews_are_made_for_kept_clips_unreviewed_first_and_asked_ones_before_all() {
    let lib = Lib::new();
    let ids = three_clips(&lib);
    for id in &ids {
        std::fs::remove_file(review::copy_path(lib.cache.root(), id)).unwrap();
    }
    photos::set_review(&lib.db, &[ids[0].clone()], ReviewState::Selected).unwrap();
    photos::set_review(&lib.db, &[ids[1].clone()], ReviewState::Rejected).unwrap();
    let order = |scope: &review::Scope| review::todo(&lib.db, lib.cache.root(), scope).unwrap().into_iter().map(|t| t.id).collect::<Vec<_>>();
    assert_eq!(order(&review::Scope::Kept), vec![ids[0].clone(), ids[2].clone()], "selected, then unreviewed; never rejected");
    assert_eq!(order(&review::Scope::Unreviewed), vec![ids[2].clone()]);
    assert_eq!(order(&review::Scope::Only(vec![ids[1].clone(), ids[0].clone()])), vec![ids[1].clone(), ids[0].clone()], "Prepare culling keeps its order");
    review::want(&ids[0]);
    assert_eq!(order(&review::Scope::Unreviewed), vec![ids[0].clone(), ids[2].clone()], "a clip asked for on screen goes first");
}

#[test]
fn the_keeper_starts_previews_only_when_there_is_work_and_room() {
    let lib = Lib::new();
    let ids = three_clips(&lib);
    for id in &ids {
        std::fs::remove_file(review::copy_path(lib.cache.root(), id)).unwrap();
    }
    photos::set_review(&lib.db, &[ids[1].clone()], ReviewState::Rejected).unwrap();
    assert_eq!(review::startable(&lib.db, lib.cache.root()), 2, "two kept clips wait (the night of 12 Nov had 303 and nothing ran)");
    for id in &ids {
        std::fs::write(review::copy_path(lib.cache.root(), id), vec![0u8; 1000]).unwrap();
    }
    assert_eq!(review::startable(&lib.db, lib.cache.root()), 0, "all made: nothing to start");
    std::fs::remove_file(review::copy_path(lib.cache.root(), &ids[0])).unwrap();
    captured_by_andy_lib::library::settings::set(&lib.db, review::CAP_KEY, "0.000001").unwrap();
    assert_eq!(review::startable(&lib.db, lib.cache.root()), 0, "the cap is reached: nothing to start");
}

#[test]
fn the_previews_cap_drops_the_least_recently_played_first() {
    let lib = Lib::new();
    let ids = three_clips(&lib);
    for (i, id) in ids.iter().enumerate() {
        set_mtime(&review::copy_path(lib.cache.root(), id), SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000 + i as u64));
    }
    // Played just now: kept although it was made first.
    review::touch(&review::copy_path(lib.cache.root(), &ids[0]));
    assert!(review::make_room(lib.cache.root(), 2500, 500, &[]));
    assert!(review::existing(lib.cache.root(), &ids[0]).is_some());
    assert!(review::existing(lib.cache.root(), &ids[1]).is_none(), "the oldest unplayed copy goes");
    assert!(review::existing(lib.cache.root(), &ids[2]).is_some());
    assert!(!review::make_room(lib.cache.root(), 2500, 5000, &ids), "copies asked for are never dropped");
}

#[test]
fn a_thumbnail_whose_file_is_gone_is_made_again_without_downloading_online_originals() {
    let lib = Lib::new();
    lib.jpeg("here.jpg", None);
    lib.jpeg("online.jpg", None);
    lib.scan();
    let rows = lib.rows();
    let id = |name: &str| rows.iter().find(|r| r.filename == name).unwrap().id.clone();
    let (here, online) = (id("here.jpg"), id("online.jpg"));
    lib.db
        .write(|c| {
            c.execute("UPDATE photos SET thumb_state = 'ready'", [])?;
            c.execute("UPDATE assets SET storage_state = 'cloud_only' WHERE photo_id = ?1", [&online])?;
            Ok(())
        })
        .unwrap();
    assert!(!lib.cache.thumb(&here).is_file());
    assert!(heal::heal_one(&lib.db, &lib.cache, &here), "a local photo's tile comes back from the original");
    assert!(lib.cache.thumb(&here).is_file());
    let before = snapshot(&lib.root);
    assert!(!heal::heal_one(&lib.db, &lib.cache, &online), "nothing to make it from: the placeholder stays");
    assert_eq!(snapshot(&lib.root), before, "originals untouched");
    // Its sharp preview is in the cache: the tile comes from that.
    let preview = lib.cache.preview(&online);
    std::fs::create_dir_all(preview.parent().unwrap()).unwrap();
    std::fs::copy(lib.root.join("online.jpg"), &preview).unwrap();
    assert!(heal::heal_one(&lib.db, &lib.cache, &online));
    let state: String = lib.db.read(|c| Ok(c.query_row("SELECT thumb_state FROM photos WHERE id = ?1", [&online], |r| r.get(0))?)).unwrap();
    assert_eq!(state, "ready", "the photo's row isn't touched");
}

#[test]
fn download_plans_count_only_cloud_folders_and_keep_ten_gb_free() {
    let dir = tempfile::tempdir().unwrap();
    let drive = dir.path().join("Library/CloudStorage/GoogleDrive-x/My Drive");
    let plain = dir.path().join("Photos");
    for (root, name) in [(&drive, "a.jpg"), (&plain, "b.jpg")] {
        std::fs::create_dir_all(root).unwrap();
        media::fixtures::write_jpeg(&root.join(name), 40, 30, [1, 2, 3], None).unwrap();
    }
    let db = Db::open(&dir.path().join("library.db")).unwrap();
    for root in [&drive, &plain] {
        let s = sources::add(&db, root).unwrap().id;
        scan::scan_source(&db, &s, &media::read_metadata, &AtomicBool::new(false), |_| {}).unwrap();
    }
    let ids: Vec<String> = photos::list(&db, &photos::Query::default(), 0, 10).unwrap().into_iter().map(|r| r.id).collect();
    assert_eq!(ids.len(), 2);
    let plan = download::plan(&db, &ids, 50_000_000_000).unwrap();
    assert_eq!((plan.online, plan.downloaded), (0, 1), "the Drive file is on this Mac; the plain folder isn't a cloud folder");
    assert!(plan.allowed);
    // Nothing online to fetch: allowed only while the Mac itself has 10 GB.
    assert!(!download::plan(&db, &ids, 9_000_000_000).unwrap().allowed);
}

/// A RAW-like file: TIFF header, a directory pointing at a JPEG, the JPEG.
fn tiff_with_jpeg(jpeg: &[u8], via_sub_ifd: bool) -> Vec<u8> {
    let mut f = b"II*\0".to_vec();
    f.extend(8u32.to_le_bytes());
    let entry = |tag: u16, kind: u16, value: u32| {
        let mut e = tag.to_le_bytes().to_vec();
        e.extend(kind.to_le_bytes());
        e.extend(1u32.to_le_bytes());
        e.extend(value.to_le_bytes());
        e
    };
    if via_sub_ifd {
        // IFD0 (at 8): one SubIFDs entry pointing at IFD 26, which holds the JPEG tags.
        f.extend(1u16.to_le_bytes());
        f.extend(entry(0x014A, 4, 26));
        f.extend(0u32.to_le_bytes());
        assert_eq!(f.len(), 26);
    }
    let start = f.len() as u32 + 2 + 24 + 4;
    f.extend(2u16.to_le_bytes());
    f.extend(entry(0x0201, 4, start));
    f.extend(entry(0x0202, 4, jpeg.len() as u32));
    f.extend(0u32.to_le_bytes());
    f.extend(jpeg);
    f
}

#[test]
fn a_raw_files_own_jpeg_preview_is_found_by_reading_only_its_directory() {
    let dir = tempfile::tempdir().unwrap();
    let jpg = dir.path().join("p.jpg");
    media::fixtures::write_jpeg(&jpg, 300, 200, [40, 90, 160], None).unwrap();
    let jpeg = std::fs::read(&jpg).unwrap();
    for sub in [false, true] {
        let file = tiff_with_jpeg(&jpeg, sub);
        let reads = std::cell::RefCell::new(Vec::new());
        let got = gdrive::raw_embedded_jpeg(|start, len| {
            reads.borrow_mut().push((start, len));
            let s = start as usize;
            file.get(s..(s + len as usize).min(file.len())).map(|b| b.to_vec())
        });
        assert_eq!(got.as_deref(), Some(jpeg.as_slice()), "sub-IFD: {sub}");
    }
    assert!(gdrive::raw_embedded_jpeg(|_, _| Some(b"not a tiff at all".to_vec())).is_none());
}

#[test]
fn cloud_previews_live_next_to_the_clips_own_drive() {
    let clip = Path::new("/Volumes/x/Library/CloudStorage/GoogleDrive-a@b.c/My Drive/*ARCHIVES/CAMERA/TRIP/C0001.MP4");
    assert_eq!(review::cloud_folder(clip).unwrap(), Path::new("/Volumes/x/Library/CloudStorage/GoogleDrive-a@b.c/My Drive/STORAGE/CBA-PREVIEWS"));
    assert_eq!(review::cloud_previews_folder(clip).unwrap(), Path::new("/Volumes/x/Library/CloudStorage/GoogleDrive-a@b.c/My Drive/STORAGE/CBA-PREVIEWS-720"));
    assert!(review::cloud_folder(Path::new("/Volumes/Kingston/C0001.MP4")).is_none(), "not in Google Drive: no cloud folder");
}

#[test]
fn cull_leaves_out_clips_whose_original_is_gone() {
    let lib = Lib::new();
    let ids = three_clips(&lib);
    // A clip moved outside the app: its row stays, marked missing, no copy.
    std::fs::remove_file(review::copy_path(lib.cache.root(), &ids[1])).unwrap();
    lib.db
        .write(|c| Ok(c.execute("UPDATE assets SET storage_state = 'missing' WHERE photo_id = ?1", [&ids[1]])?))
        .unwrap();
    let all = photos::Query { video: Some(true), ..Default::default() };
    let playable = photos::Query { hide_missing: Some(true), ..all.clone() };
    assert_eq!(photos::ids(&lib.db, &all, 0, 100).unwrap().len(), 3, "the library still lists it");
    let shown = photos::ids(&lib.db, &playable, 0, 100).unwrap();
    assert_eq!(shown.len(), 2, "the cull doesn't");
    assert!(!shown.contains(&ids[1]));
    assert_eq!(photos::counts(&lib.db, &playable).unwrap().all, 2);
}
