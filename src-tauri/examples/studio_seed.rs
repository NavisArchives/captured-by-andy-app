//! Loads a research pack into Studio through the library's own functions:
//! pillars, series (families), the watchlist, inspiration saves (with the
//! video file left where it is and a thumbnail made the usual way), and ideas.
//! Safe to run again: everything is matched by name, handle, file or title
//! and updated rather than added twice.
//!
//! `cargo run --example studio_seed -- <data dir> <pack.json>`
//! <data dir> is the folder holding library.db (the app's own, or a
//! throwaway one for a trial run); thumbnails go to <data dir>/cache.
use std::path::PathBuf;

use captured_by_andy_lib::library::{db::Db, settings, studio};
use serde_json::{json, Map, Value};

type Row = Map<String, Value>;

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn id_of(r: &Row) -> String {
    r.get("id").and_then(Value::as_str).unwrap_or("").to_owned()
}

fn row(pairs: &[(&str, Value)]) -> Row {
    pairs.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect()
}

fn find(db: &Db, short: &str, col: &str, value: &str) -> Option<Row> {
    studio::list(db, short, &Row::new()).ok()?.into_iter().find(|r| r.get(col).and_then(Value::as_str).is_some_and(|v| v.eq_ignore_ascii_case(value)))
}

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = PathBuf::from(args.next().expect("data dir"));
    let pack: Value = serde_json::from_str(&std::fs::read_to_string(args.next().expect("pack.json")).expect("read pack")).expect("parse pack");
    let db = Db::open(&dir.join("library.db")).expect("open library");
    // A trial run points Studio's folder somewhere harmless.
    if let Some(root) = std::env::var_os("CBA_STUDIO_ROOT") {
        settings::set(&db, "studio.root", &root.to_string_lossy()).expect("studio root");
    }
    let cache_root = dir.join("cache");
    std::fs::create_dir_all(&cache_root).ok();

    // Pillars, by name, in the pack's order.
    let mut pillars: Map<String, Value> = Map::new();
    for (i, p) in pack["pillars"].as_array().into_iter().flatten().enumerate() {
        let name = s(p, "name");
        let r = match find(&db, "pillars", "name", name) {
            Some(r) => r,
            None => studio::save(&db, "pillars", None, &row(&[("name", json!(name)), ("position", json!(i as i64))])).expect("pillar"),
        };
        let id = id_of(&r);
        studio::pillar_dir(&db, &id).expect("pillar folder");
        pillars.insert(name.to_lowercase(), json!(id));
    }
    let pillar = |name: &str| -> Value { pillars.get(&name.to_lowercase()).cloned().unwrap_or(Value::Null) };
    println!("pillars: {}", pillars.len());

    // Series and other families.
    let mut families: Map<String, Value> = Map::new();
    for f in pack["families"].as_array().into_iter().flatten() {
        let name = s(f, "name");
        let values = row(&[("name", json!(name)), ("kind", json!(f.get("kind").and_then(Value::as_str).unwrap_or("series"))), ("code", json!(s(f, "code"))), ("pillarId", pillar(s(f, "pillar")))]);
        let existing = find(&db, "families", "name", name).map(|r| id_of(&r));
        let r = studio::save(&db, "families", existing.as_deref(), &values).expect("family");
        families.insert(name.to_lowercase(), json!(id_of(&r)));
    }
    println!("families: {}", families.len());

    // Watchlist: one row per account, the numbers kept where the page reads them.
    let mut watched = 0;
    for w in pack["watch"].as_array().into_iter().flatten() {
        let handle = s(w, "handle").trim_start_matches('@');
        let mut last = Map::new();
        if let Some(n) = w.get("followers").and_then(Value::as_i64) {
            last.insert("followers_count".into(), json!(n));
        }
        let values = row(&[("handle", json!(handle)), ("platform", json!(w.get("platform").and_then(Value::as_str).unwrap_or("tiktok"))), ("notes", json!(s(w, "notes"))), ("last", json!(Value::Object(last).to_string()))]);
        let existing = find(&db, "watch", "handle", handle).map(|r| id_of(&r));
        studio::save(&db, "watch", existing.as_deref(), &values).expect("watch");
        watched += 1;
    }
    println!("watchlist: {watched}");

    // Saves. A video or picture is added the way a drop is (file left in place,
    // thumbnail made), then given its link, author, why and pillar.
    let mut saves_by_key: Map<String, Value> = Map::new();
    let mut saved = 0;
    for v in pack["saves"].as_array().into_iter().flatten() {
        let file = s(v, "file");
        let title = s(v, "title");
        let id = if !file.is_empty() && std::path::Path::new(file).exists() {
            let p = PathBuf::from(file);
            match find(&db, "saves", "filePath", file) {
                Some(r) => id_of(&r),
                None => studio::add_paths(&db, &cache_root, &[p], "research", true).expect("add file").into_iter().next().map(|r| id_of(&r)).unwrap_or_default(),
            }
        } else {
            match find(&db, "saves", "title", title) {
                Some(r) => id_of(&r),
                None => id_of(&studio::save(&db, "saves", None, &row(&[("kind", json!(v.get("kind").and_then(Value::as_str).unwrap_or("note"))), ("title", json!(title)), ("capturedVia", json!("research"))])).expect("note")),
            }
        };
        if id.is_empty() {
            eprintln!("skipped (no file, no title): {v}");
            continue;
        }
        let mut values = Row::new();
        for k in ["url", "platform", "title", "author", "why", "chips", "tags", "transcript", "status"] {
            if let Some(x) = v.get(k).and_then(Value::as_str).filter(|x| !x.is_empty()) {
                values.insert(k.into(), json!(x));
            }
        }
        if let Some(url) = v.get("url").and_then(Value::as_str).filter(|u| !u.is_empty()) {
            if let Some(c) = studio::clean_link(url) {
                values.insert("urlKey".into(), json!(c.key));
            }
        }
        values.insert("pillarId".into(), pillar(s(v, "pillar")));
        studio::save(&db, "saves", Some(&id), &values).expect("save details");
        if let Some(key) = v.get("key").and_then(Value::as_str) {
            saves_by_key.insert(key.to_owned(), json!(id));
        }
        saved += 1;
    }
    println!("saves: {saved}");

    // Ideas, by title, linked to the save that sparked them when given.
    let mut ideas = 0;
    for i in pack["ideas"].as_array().into_iter().flatten() {
        let title = s(i, "title");
        let mut values = row(&[("title", json!(title)), ("hook", json!(s(i, "hook"))), ("format", json!(s(i, "format"))), ("platforms", json!(s(i, "platforms"))), ("notes", json!(s(i, "notes"))), ("source", json!("save")), ("pillarId", pillar(s(i, "pillar")))]);
        if let Some(fid) = families.get(&s(i, "family").to_lowercase()) {
            values.insert("familyId".into(), fid.clone());
        }
        let existing = find(&db, "ideas", "title", title).map(|r| id_of(&r));
        let r = studio::save(&db, "ideas", existing.as_deref(), &values).expect("idea");
        if let Some(save_id) = i.get("save").and_then(Value::as_str).and_then(|k| saves_by_key.get(k)).and_then(Value::as_str) {
            studio::link(&db, "saveIdea", save_id, &id_of(&r), true).expect("link");
        }
        ideas += 1;
    }
    println!("ideas: {ideas}");
}
