//! Organising, social planning, looks, automatic filters and storage, end to
//! end on real files in a temp folder.
#![cfg(target_os = "macos")]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::SystemTime;

use captured_by_andy_lib::library::model::{ReviewState, StorageState, ThumbState};
use captured_by_andy_lib::library::{
    accounts, albums, archive, auto, db::Db, finder, looks, media, offline, photos, posts, scan, settings, sources,
    storage, tags, thumbs,
};

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
        settings::set(&db, offline::DIR_KEY, &dir.path().join("Offline").to_string_lossy()).unwrap();
        Self { dir, root, db, source, cache }
    }

    fn jpeg(&self, rel: &str, exif: Option<(&str, &str)>) -> PathBuf {
        let p = self.root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let h = blake3::hash(rel.as_bytes());
        // A pattern, not a flat colour, so sharpness has something to measure.
        let img = media::fixtures::image(400, 300, |x, y| {
            let on = (x / 8 + y / 8) % 2 == 0;
            let b = h.as_bytes();
            if on { [b[0], b[1], b[2]] } else { [b[3] / 2, b[4] / 2, b[5] / 2] }
        });
        media::fixtures::write_image_jpeg(&img, &p, exif).unwrap();
        p
    }

    fn raw(&self, rel: &str) -> PathBuf {
        let p = self.root.join(rel);
        std::fs::write(&p, blake3::hash(rel.as_bytes()).as_bytes().repeat(512)).unwrap();
        p
    }

    fn scan(&self) {
        scan::scan_source(&self.db, &self.source, &media::read_metadata, &AtomicBool::new(false), |_| {}).unwrap();
    }

    fn ids(&self) -> Vec<String> {
        photos::ids(&self.db, &photos::Query { order: photos::Order::Oldest, ..Default::default() }, 0, 10_000).unwrap()
    }

    fn query(&self, q: photos::Query) -> Vec<photos::PhotoRow> {
        photos::list(&self.db, &q, 0, 10_000).unwrap()
    }
}

fn snapshot(root: &Path) -> BTreeMap<PathBuf, (String, u64, SystemTime)> {
    walkdir::WalkDir::new(root)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .map(|e| {
            let meta = e.metadata().unwrap();
            (e.path().to_owned(), (blake3::hash(&std::fs::read(e.path()).unwrap()).to_hex().to_string(), meta.len(), meta.modified().unwrap()))
        })
        .collect()
}

fn five(lib: &Lib) -> Vec<String> {
    for i in 0..5 {
        lib.jpeg(&format!("IMG_{i:04}.JPG"), Some((&format!("2026:09:2{i} 21:00:00"), "ILCE-7M4")));
    }
    lib.scan();
    lib.ids()
}

#[test]
fn albums_and_tags_organise_without_touching_files() {
    let lib = Lib::new();
    let ids = five(&lib);
    let before = snapshot(&lib.root);

    let album = albums::create(&lib.db, "Brussels Nights", "").unwrap();
    assert_eq!(albums::add_photos(&lib.db, &album.id, &ids[..3]).unwrap(), 3);
    assert_eq!(albums::add_photos(&lib.db, &album.id, &ids[..3]).unwrap(), 0, "adding twice is a no-op");
    let a = albums::get(&lib.db, &album.id).unwrap();
    assert_eq!((a.photo_count, a.cover_photo_id.as_deref()), (3, Some(ids[0].as_str())));

    tags::add(&lib.db, &["Night life".into(), "night-life".into()], &ids[1..2]).unwrap();
    let all_tags = tags::list(&lib.db).unwrap();
    assert_eq!(all_tags.len(), 1, "same slug, same tag");

    let in_album = lib.query(photos::Query { album: Some(album.id.clone()), ..Default::default() });
    assert_eq!(in_album.len(), 3);
    let found = lib.query(photos::Query { search: Some("night".into()), ..Default::default() });
    assert_eq!(found.len(), 3, "search finds the album name and the tag");
    let detail = photos::detail(&lib.db, &ids[1]).unwrap();
    assert_eq!(detail.albums[0].name, "Brussels Nights");
    assert_eq!(detail.tags[0].name, "Night life");

    albums::delete(&lib.db, &album.id, "menu").unwrap();
    assert_eq!(lib.ids().len(), 5, "deleting an album keeps its photos");
    assert_eq!(snapshot(&lib.root), before);
}

#[test]
fn posts_track_history_social_state_and_the_planned_grid() {
    let lib = Lib::new();
    let ids = five(&lib);
    let acct = accounts::create(&lib.db, &accounts::AccountInput { username: Some("@capturedbyandy".into()), ..Default::default() }).unwrap();
    assert_eq!(acct.username, "capturedbyandy");

    let input = |title: &str, status: Option<posts::Status>| posts::PostInput {
        title: Some(title.into()),
        account_id: Some(acct.id.clone()),
        status,
        ..Default::default()
    };
    let old = posts::create(&lib.db, &input("Summer Dump", Some(posts::Status::Published)), &ids[..2]).unwrap();
    assert!(old.post.published_at.is_none());
    let old = posts::update(&lib.db, &old.post.id, &posts::PostInput { published_at: Some("2026-08-12T19:00".into()), ..Default::default() }).unwrap();
    let a = posts::create(&lib.db, &input("Brussels at Night", None), &ids[1..4]).unwrap();
    let b = posts::create(&lib.db, &input("Pai part 3", None), &ids[4..5]).unwrap();

    assert_eq!(a.post.status, posts::Status::Building);
    assert_eq!(a.reused.len(), 1, "photo 2 was already in Summer Dump");
    let rows = photos::rows_by_id_for_test(&lib.db, &ids);
    assert_eq!(rows[0].social, photos::Social::Posted);
    assert_eq!(rows[2].social, photos::Social::Assigned);
    // Undo restores the exact previous mark and time.
    let before = photos::review_marks(&lib.db, &ids[..1]).unwrap();
    photos::set_review(&lib.db, &ids[..1], ReviewState::Rejected).unwrap();
    photos::restore_marks(&lib.db, &before).unwrap();
    let after = photos::review_marks(&lib.db, &ids[..1]).unwrap();
    assert_eq!((after[0].review, after[0].reviewed_ms), (before[0].review, before[0].reviewed_ms));
    let unrev = photos::Query::review(ReviewState::Unreviewed);
    assert_eq!(photos::in_view(&lib.db, &unrev, &ids).unwrap().len(), 5);
    assert!(photos::position(&lib.db, &unrev, &ids[4]).unwrap().is_some());
    photos::set_review(&lib.db, &ids[4..5], ReviewState::Selected).unwrap();
    assert_eq!(photos::position(&lib.db, &unrev, &ids[4]).unwrap(), None, "a photo that left the view has no position");
    // Its neighbours are still found by its sort key (default order: newest first).
    let unrev_newest = photos::Query::review(ReviewState::Unreviewed);
    let order: Vec<String> = photos::ids(&lib.db, &unrev_newest, 0, 100).unwrap();
    let (next, at) = photos::neighbor(&lib.db, &unrev_newest, &ids[4], 1).unwrap().unwrap();
    assert_eq!((next.as_str(), at), (order[0].as_str(), 0), "ids are oldest-first, so after the newest comes index 0 of the rest");
    assert!(photos::neighbor(&lib.db, &unrev_newest, &ids[4], -1).unwrap().is_none(), "nothing is newer than the newest");
    let posted = lib.query(photos::Query { social: Some(photos::SocialFilter::Posted), ..Default::default() });
    assert_eq!(posted.len(), 2);
    assert_eq!(photos::detail(&lib.db, &ids[1]).unwrap().history.len(), 2);

    posts::reorder_photos(&lib.db, &a.post.id, &[ids[3].clone(), ids[1].clone(), ids[2].clone()]).unwrap();
    assert_eq!(posts::get(&lib.db, &a.post.id).unwrap().photos[0].id, ids[3]);
    assert!(posts::reorder_photos(&lib.db, &a.post.id, &[ids[3].clone()]).is_err(), "must list every photo");

    // Grid: planned on top, the one going out last first; then published.
    posts::plan(&lib.db, &[b.post.id.clone(), a.post.id.clone()]).unwrap();
    let grid: Vec<String> = posts::grid(&lib.db, &acct.id).unwrap().into_iter().map(|p| p.id).collect();
    assert_eq!(grid, vec![a.post.id.clone(), b.post.id.clone(), old.post.id.clone()]);

    let many: Vec<String> = (0..21).map(|_| ids[0].clone()).collect();
    assert!(posts::create(&lib.db, &posts::PostInput::default(), &many).is_err(), "carousels stop at 20");
    // Pinning: at most three per account.
    let pin = |id: &str| posts::update(&lib.db, id, &posts::PostInput { pinned: Some(true), ..Default::default() });
    assert!(pin(&old.post.id).unwrap().post.pinned);
    let extra: Vec<String> = (0..3)
        .map(|i| posts::create(&lib.db, &input(&format!("p{i}"), Some(posts::Status::Published)), &[]).unwrap().post.id)
        .collect();
    pin(&extra[0]).unwrap();
    pin(&extra[1]).unwrap();
    assert!(pin(&extra[2]).is_err(), "a fourth pin is refused");
    let restated = posts::update(&lib.db, &extra[0], &posts::PostInput { status: Some(posts::Status::Published), ..Default::default() });
    assert!(restated.is_ok(), "a photo-less published post that does not move is left alone");
    for e in &extra {
        posts::delete(&lib.db, e, "menu").unwrap();
    }
    assert!(pin(&a.post.id).is_err(), "only published posts can be pinned");
    let moved_back = posts::update(&lib.db, &old.post.id, &posts::PostInput { status: Some(posts::Status::Ready), ..Default::default() }).unwrap();
    assert!(!moved_back.post.pinned, "leaving published drops the pin");
    assert_eq!(moved_back.post.published_at, None, "back in the plan, the old date goes");
    let again = posts::update(&lib.db, &old.post.id, &posts::PostInput { status: Some(posts::Status::Published), ..Default::default() }).unwrap();
    assert!(again.post.published_at.as_deref().is_some_and(|d| d != "2026-08-12T19:00"), "publishing again stamps a new date");

    // Marked after the fact: a planned time that has passed is when it went out.
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M").to_string();
    let planned = |title: &str, at: &str| {
        let input = posts::PostInput { title: Some(title.into()), status: Some(posts::Status::Scheduled), scheduled_at: Some(at.into()), ..Default::default() };
        posts::create(&lib.db, &input, &ids[..1]).unwrap().post.id
    };
    let publish = |id: &str| posts::update(&lib.db, id, &posts::PostInput { status: Some(posts::Status::Published), ..Default::default() }).unwrap().post;
    let past = planned("Monday", "2020-01-06T19:30");
    let later = planned("Next year", "2999-01-01T09:00");
    let sooner = planned("Sooner", "2998-06-01T09:00");
    let listed = |status: posts::Status| -> Vec<String> {
        posts::list(&lib.db, &posts::PostFilter { status: Some(status), ..Default::default() }).unwrap().into_iter().map(|p| p.id).collect()
    };
    assert_eq!(listed(posts::Status::Scheduled), vec![past.clone(), sooner.clone(), later.clone()], "soonest first");
    assert_eq!(publish(&past).published_at.as_deref(), Some("2020-01-06T19:30"));
    let stamped = publish(&later).published_at.unwrap();
    assert!(stamped != "2999-01-01T09:00" && stamped >= now, "a planned time still ahead is not used: {stamped}");
    let published = listed(posts::Status::Published);
    let at = |id: &str| published.iter().position(|p| p == id).unwrap();
    assert!(at(&later) < at(&past), "newest published first, whatever the plan order");

    let empty = posts::create(&lib.db, &posts::PostInput { title: Some("Empty".into()), ..Default::default() }, &[]).unwrap();
    let to_ready = posts::update(&lib.db, &empty.post.id, &posts::PostInput { status: Some(posts::Status::Ready), ..Default::default() });
    assert!(to_ready.is_err(), "a post needs a photo to be ready");

    // An idea with a date that is made ready is scheduled.
    let dated = posts::create(&lib.db, &posts::PostInput { title: Some("Dated idea".into()), status: Some(posts::Status::Idea), scheduled_at: Some("2020-02-01T19:00".into()), ..Default::default() }, &ids[..1]).unwrap();
    let readied = posts::update(&lib.db, &dated.post.id, &posts::PostInput { status: Some(posts::Status::Ready), ..Default::default() }).unwrap();
    assert_eq!(readied.post.status, posts::Status::Scheduled);
    // A ready post with an old date never "went out" at that date: publishing stamps now.
    let stale = posts::create(&lib.db, &posts::PostInput { title: Some("Stale".into()), status: Some(posts::Status::Ready), scheduled_at: Some("2020-03-01T19:00".into()), ..Default::default() }, &ids[..1]).unwrap();
    let out = publish(&stale.post.id).published_at.unwrap();
    assert!(out >= now, "stamped now, not the stale plan: {out}");
    // A photo-less published post can be archived and brought back.
    let history = posts::create(&lib.db, &posts::PostInput { title: Some("From Instagram".into()), status: Some(posts::Status::Published), ..Default::default() }, &[]).unwrap();
    let to = |s: posts::Status| posts::update(&lib.db, &history.post.id, &posts::PostInput { status: Some(s), ..Default::default() });
    to(posts::Status::Archived).unwrap();
    assert_eq!(to(posts::Status::Published).unwrap().post.status, posts::Status::Published);

    for id in [&past, &later, &sooner, &empty.post.id, &dated.post.id, &stale.post.id, &history.post.id] {
        posts::delete(&lib.db, id, "menu").unwrap();
    }

    // Counts: a missing field keeps the value, null clears it.
    let json = |v: &str| serde_json::from_str::<accounts::AccountInput>(v).unwrap();
    accounts::update(&lib.db, &acct.id, &json(r#"{"followerCount": 18400}"#)).unwrap();
    assert_eq!(accounts::update(&lib.db, &acct.id, &json(r#"{"bio": "x"}"#)).unwrap().follower_count, Some(18400));
    assert_eq!(accounts::update(&lib.db, &acct.id, &json(r#"{"followerCount": null}"#)).unwrap().follower_count, None);
    let acct = accounts::update(&lib.db, &acct.id, &accounts::AccountInput { bio: Some("Brussels · film".into()), link: Some(" andyssarchives.com ".into()), ..Default::default() }).unwrap();
    assert_eq!((acct.bio.as_str(), acct.link.as_str()), ("Brussels · film", "andyssarchives.com"));

    let pipe = posts::pipeline(&lib.db, Some(&acct.id)).unwrap();
    assert_eq!((pipe.building, pipe.published), (2, 1));

    posts::delete(&lib.db, &a.post.id, "menu").unwrap();
    assert_eq!(lib.ids().len(), 5, "deleting a post keeps its photos");
}

#[test]
fn selected_photos_get_a_green_finder_tag_and_lose_only_ours() {
    let lib = Lib::new();
    let jpg = lib.jpeg("shoot/IMG_0001.JPG", Some(("2026:09:21 21:00:00", "cam")));
    let arw = lib.raw("shoot/IMG_0001.ARW");
    let mine = lib.jpeg("shoot/IMG_0002.JPG", None);
    lib.scan();
    let before = snapshot(&lib.root);
    let ids = lib.ids();
    // Andy tagged this one Green himself before the app existed.
    finder::add_tag(&mine, "Green").unwrap();

    photos::set_review(&lib.db, &ids, ReviewState::Selected).unwrap();
    let report = finder::sync(&lib.db, &ids).unwrap();
    assert_eq!(report.tagged, 2, "the JPEG and its RAW, not the pre-tagged file");
    for f in [&jpg, &arw, &mine] {
        assert!(finder::read_tags(f).unwrap().iter().any(|t| t.starts_with("Green")), "{f:?}");
    }

    photos::set_review(&lib.db, &ids, ReviewState::Maybe).unwrap();
    finder::sync(&lib.db, &ids).unwrap();
    assert!(finder::read_tags(&jpg).unwrap().is_empty() && finder::read_tags(&arw).unwrap().is_empty());
    assert_eq!(finder::read_tags(&mine).unwrap(), vec!["Green\n2"], "a tag the app did not add stays");

    photos::set_review(&lib.db, &ids, ReviewState::Selected).unwrap();
    finder::sync(&lib.db, &ids).unwrap();
    settings::set(&lib.db, finder::ENABLED_KEY, "false").unwrap();
    finder::remove_added(&lib.db, None).unwrap();
    assert!(finder::read_tags(&jpg).unwrap().is_empty());
    assert_eq!(snapshot(&lib.root), before, "contents and modification times unchanged");
}

#[test]
fn offline_copies_serve_thumbnails_when_the_original_is_gone() {
    let lib = Lib::new();
    let ids = five(&lib);
    let report = offline::keep(&lib.db, &ids[..2]).unwrap();
    assert_eq!(report.copied, 2);
    assert_eq!(offline::keep(&lib.db, &ids[..2]).unwrap().copied, 0, "already kept");
    let row = &photos::rows_by_id_for_test(&lib.db, &ids[..1])[0];
    assert_eq!(row.storage, StorageState::AvailableOffline);

    // The drive is unplugged: move the original away and rescan.
    let original = lib.root.join("IMG_0000.JPG");
    let away = lib.dir.path().join("IMG_0000.JPG");
    std::fs::rename(&original, &away).unwrap();
    lib.scan();
    assert_eq!(thumbs::make_thumbnail(&lib.db, &lib.cache, &ids[0]).unwrap(), ThumbState::Ready, "made from the copy");
    let offline_rows = lib.query(photos::Query { storage: Some(photos::StorageFilter::Offline), ..Default::default() });
    assert_eq!(offline_rows.len(), 2);

    std::fs::rename(&away, &original).unwrap();
    let released = offline::release(&lib.db, &ids[..2]).unwrap();
    assert_eq!(released.removed, 2);
    assert!(original.is_file(), "releasing copies never touches originals");
    assert!(!lib.dir.path().join("Offline").join(&ids[0][ids[0].len() - 2..]).exists(), "empty folders tidied");
}

#[test]
fn archiving_copies_verifies_and_never_overwrites() {
    let lib = Lib::new();
    let ids = five(&lib);
    let before = snapshot(&lib.root);
    let target = lib.dir.path().join("ArchiveDrive");
    std::fs::create_dir(&target).unwrap();
    let loc = storage::add_local_location(&lib.db, &target, Some("Archive drive")).unwrap();

    let r = archive::archive_photos(&lib.db, &loc.id, &ids, false).unwrap();
    assert_eq!((r.archived, r.failed), (5, 0), "{:?}", r.errors);
    assert_eq!(archive::archive_photos(&lib.db, &loc.id, &ids, false).unwrap().already, 5);
    assert_eq!(snapshot(&target).len(), 5);
    assert!(lib.query(photos::Query::default()).iter().all(|p| p.archived));

    // A different file already sits where a new archive copy would go.
    lib.jpeg("IMG_9999.JPG", Some(("2026:09:25 10:00:00", "cam")));
    lib.scan();
    let new_id = photos::ids(&lib.db, &photos::Query::default(), 0, 1).unwrap().remove(0);
    let key = archive::key_for(&new_id, "2026-09-25T10:00:00.000", "IMG_9999.JPG");
    std::fs::create_dir_all(target.join(&key).parent().unwrap()).unwrap();
    std::fs::write(target.join(&key), b"someone else's file").unwrap();
    let r = archive::archive_photos(&lib.db, &loc.id, &[new_id], false).unwrap();
    assert_eq!(r.failed, 1);
    assert_eq!(std::fs::read(target.join(&key)).unwrap(), b"someone else's file");
    let mut after = snapshot(&lib.root);
    after.retain(|p, _| before.contains_key(p));
    assert_eq!(after, before);
}

const PRESET: &str = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description rdf:about=""
 crs:PresetType="Normal" crs:Exposure2012="+0.39" crs:Contrast2012="-5" crs:Shadows2012="+40" crs:Saturation="-5"
 crs:GrainAmount="40" crs:PostCropVignetteAmount="-15">
 <crs:Name><rdf:Alt><rdf:li xml:lang="x-default">Kodak Gold 200</rdf:li></rdf:Alt></crs:Name>
 </rdf:Description></rdf:RDF></x:xmpmeta>"#;

#[test]
fn looks_import_bake_and_apply() {
    let lib = Lib::new();
    let ids = five(&lib);
    let src = lib.dir.path().join("Presets");
    std::fs::create_dir_all(src.join("HaldCLUT")).unwrap();
    std::fs::write(src.join("Kodak+Gold+200.xmp"), PRESET).unwrap();
    std::fs::write(src.join("sidecar.xmp"), r#"<rdf:Description crs:RawFileName="IMG_1.ARW" crs:Exposure2012="+1">"#).unwrap();
    let mut cube = String::from("TITLE \"Warm Swap LUT\"\nLUT_3D_SIZE 2\n");
    for b in 0..2 {
        for g in 0..2 {
            for r in 0..2 {
                cube.push_str(&format!("{b} {g} {r}\n"));
            }
        }
    }
    std::fs::write(src.join("Warm Swap LUT 33x.cube"), cube).unwrap();
    // Identity HaldCLUT, level 4: a 64×64 image holding a 16³ cube.
    let hald = media::fixtures::image(64, 64, |x, y| {
        let i = (y * 64 + x) as usize;
        let v = |k: usize| (k as f64 * 255.0 / 15.0).round() as u8;
        [v(i % 16), v((i / 16) % 16), v(i / 256)]
    });
    media::fixtures::write_png(&hald, &src.join("HaldCLUT").join("Identity Film.png")).unwrap();
    std::fs::copy(src.join("HaldCLUT").join("Identity Film.png"), src.join("HaldCLUT").join("Neutral Stock.png")).unwrap();

    let looks_dir = lib.dir.path().join("looks");
    let report = looks::import(&lib.db, &looks_dir, &[src.clone()]).unwrap();
    assert_eq!(report.added, 3, "{report:?}: preset, cube, one hald (identity skipped, sidecar ignored)");
    assert_eq!(looks::import(&lib.db, &looks_dir, &[src]).unwrap().added, 0, "second import finds nothing new");

    let all = looks::list(&lib.db, &looks_dir).unwrap();
    let by_name = |n: &str| all.iter().find(|l| l.name == n).unwrap_or_else(|| panic!("{n} in {all:?}")).clone();
    let gold = by_name("Kodak Gold 200");
    assert_eq!(gold.kind, looks::Kind::Preset);
    assert_eq!(gold.effects, looks::Effects { grain: 40.0, vignette: -15.0 });
    assert_eq!(by_name("Warm Swap").kind, looks::Kind::Cube);
    let neutral = by_name("Neutral Stock");

    for l in &all {
        let file = looks::bake(&lib.db, &looks_dir, &l.id).unwrap();
        assert_eq!(std::fs::metadata(file).unwrap().len(), (looks::LUT_SIZE.pow(3) * 4) as u64);
    }
    // The identity Hald bakes to (nearly) identity.
    let bytes = std::fs::read(looks::lut_path(&looks_dir, &neutral.id)).unwrap();
    let n = looks::LUT_SIZE;
    let at = |r: usize, g: usize, b: usize| &bytes[(r + g * n + b * n * n) * 4..][..3];
    assert!(at(16, 8, 30).iter().zip([16 * 255 / 32, 8 * 255 / 32, 30 * 255 / 32]).all(|(a, e)| (*a as i32 - e as i32).abs() <= 3));
    assert_eq!(looks::get(&lib.db, &looks_dir, &gold.id).unwrap().swatch.len(), 5);

    let adj = looks::Adjustments { exposure: 0.3, vibrance: 10.0, ..Default::default() };
    assert_eq!(looks::apply(&lib.db, &ids[..3], Some(&gold.id), 0.8, Some(&adj)).unwrap(), 3);
    let pl = looks::for_photo(&lib.db, &ids[0]).unwrap();
    assert_eq!((pl.look_id.as_deref(), pl.strength, pl.adjustments), (Some(gold.id.as_str()), 0.8, adj));
    assert!(photos::rows_by_id_for_test(&lib.db, &ids[..1])[0].edited);
    assert_eq!(looks::get(&lib.db, &looks_dir, &gold.id).unwrap().used_by, 3);
    looks::apply(&lib.db, &ids[..1], None, 1.0, Some(&looks::Adjustments::default())).unwrap();
    assert!(!photos::rows_by_id_for_test(&lib.db, &ids[..1])[0].edited, "clearing everything removes the edit");
}

#[test]
fn automatic_filters_find_bursts_and_suggest_tone() {
    let lib = Lib::new();
    for (i, t) in ["21:00:00", "21:00:01", "21:00:02", "21:05:00"].iter().enumerate() {
        lib.jpeg(&format!("B_{i}.JPG"), Some((&format!("2026:09:21 {t}"), "ILCE-7M4")));
    }
    lib.scan();
    let ids = lib.ids();
    for id in &ids {
        thumbs::make_thumbnail(&lib.db, &lib.cache, id).unwrap();
    }
    assert!(auto::get(&lib.db, &ids[0]).unwrap().is_some(), "measured while making the thumbnail");
    assert_eq!(auto::regroup_bursts(&lib.db).unwrap(), 3);
    let counts = auto::smart_counts(&lib.db).unwrap();
    assert_eq!((counts.burst_extras, counts.analysed), (2, 4));
    let extras = lib.query(photos::Query { smart: Some(photos::Smart::BurstExtras), ..Default::default() });
    assert_eq!(extras.len(), 2);
    assert!(extras.iter().all(|r| r.burst == 3 && !r.burst_best));

    // Auto edit on select, when switched on.
    photos::set_review(&lib.db, &ids[..1], ReviewState::Selected).unwrap();
    assert_eq!(auto::on_selected(&lib.db, &ids[..1]).unwrap(), 0, "off by default");
    settings::set(&lib.db, auto::AUTO_TONE_KEY, "true").unwrap();
    assert_eq!(auto::on_selected(&lib.db, &ids[..1]).unwrap(), 1);
    assert_ne!(looks::for_photo(&lib.db, &ids[0]).unwrap().adjustments, looks::Adjustments::default());
    assert_eq!(auto::on_selected(&lib.db, &ids[..1]).unwrap(), 0, "never overwrites an existing edit");
    let _ = auto::auto_for_photo(&lib.db, &ids[1]).unwrap();
}

#[test]
fn forgetting_a_folder_keeps_its_files() {
    let lib = Lib::new();
    let ids = five(&lib);
    let before = snapshot(&lib.root);
    let album = albums::create(&lib.db, "Keep", "").unwrap();
    albums::add_photos(&lib.db, &album.id, &ids).unwrap();
    photos::set_review(&lib.db, &ids, ReviewState::Selected).unwrap();
    finder::sync(&lib.db, &ids).unwrap();

    finder::remove_added(&lib.db, Some(&lib.source)).unwrap();
    offline::release_source(&lib.db, &lib.source).unwrap();
    assert_eq!(sources::remove(&lib.db, &lib.source).unwrap(), 5);
    assert!(lib.ids().is_empty());
    assert_eq!(albums::get(&lib.db, &album.id).unwrap().photo_count, 0);
    assert_eq!(snapshot(&lib.root), before);
    assert!(finder::read_tags(&lib.root.join("IMG_0000.JPG")).unwrap().is_empty(), "our tags came off first");
}
