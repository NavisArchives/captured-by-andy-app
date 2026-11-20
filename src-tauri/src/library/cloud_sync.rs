//! Keeps the online library (Supabase, used by the phone at studio.andyssarchives.com)
//! in step with this Mac, from inside the app: no script to remember to run.
//!
//! A round:
//!   1. pull: what was done on the web since the last round (review marks, albums,
//!      Studio rows and links, plan files). The newer change wins.
//!   2. push: what changed on the Mac since the last round (photo rows, never the
//!      pictures, which stay on Google Drive; albums, tags, Studio, plan files).
//!   3. heartbeat: a row saying when the Mac last synced and what it counts, so the
//!      web can say "Mac synced 2 min ago" and never passes off an old library as current.
//!
//! The rules are the ones of `tools/supabase-sync/sync.py`, which it replaces in daily
//! use, and it shares that script's login and cursor files, so either can run a round:
//!   ~/.config/captured-by-andy/supabase.json        {"url": "https://….supabase.co", "key": "<secret key>"}
//!   ~/.config/captured-by-andy/supabase-state.json  {"pushed": ms, "pulled": ms, "pull_cursors": {stream: ms}}
//!
//! Network calls go through `/usr/bin/curl` like the rest of the app; the key is
//! handed to curl on stdin, never on its command line.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use base64::Engine as _;
use rusqlite::types::{Value as Sql, ValueRef};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::{db::Db, now_ms, Error, Result};

const BATCH: usize = 1000;
const ID_XATTR: &str = "com.google.drivefs.item-id#S";

/// Studio's lists as the app names them, and their tables (see studio.rs).
const STUDIO: [(&str, &str); 10] = [
    ("pillars", "studio_pillars"),
    ("families", "studio_families"),
    ("ideas", "studio_ideas"),
    ("pieces", "studio_pieces"),
    ("saves", "studio_saves"),
    ("boards", "studio_boards"),
    ("shootDays", "studio_shoot_days"),
    ("brandJobs", "studio_brand_jobs"),
    ("reviews", "studio_reviews"),
    ("watch", "studio_watch"),
];
/// Link kinds as the app names them: table, column for a, column for b.
const LINKS: [(&str, &str, &str, &str); 2] = [
    ("saveIdea", "studio_save_ideas", "save_id", "idea_id"),
    ("pieceMedia", "studio_piece_media", "piece_id", "photo_id"),
];
const IPHONE: &str = "(COALESCE(p.camera_make, '') = 'Apple' OR (p.camera_make IS NULL AND (a.dir LIKE '%/IPHONE' OR a.dir LIKE '%/IPHONE/%')))";

// ---------------------------------------------------------------- files

fn config_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config/captured-by-andy")
}

#[derive(Clone, Debug, Deserialize)]
pub struct Login {
    pub url: String,
    pub key: String,
}

/// The login, or None when this Mac was never set up for the web.
pub fn login() -> Option<Login> {
    let text = std::fs::read_to_string(config_dir().join("supabase.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// Shared with sync.py: each pull stream advances only to its own observed web_ms.
/// `pulled` remains for older readers, never as a new stream's starting point.
/// Unknown top-level and per-stream fields survive the round trip.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Cursor {
    #[serde(default)]
    pub pushed: i64,
    #[serde(default)]
    pub pulled: i64,
    #[serde(default)]
    pub pull_cursors: Map<String, Value>,
    #[serde(flatten)]
    pub other: serde_json::Map<String, serde_json::Value>,
}

impl Cursor {
    fn since(&self, stream: &str) -> i64 {
        // Legacy shared cursors may have skipped slower streams. Replay missing
        // streams from zero once, then use their independent checkpoint.
        self.pull_cursors.get(stream).and_then(Value::as_i64).unwrap_or(0).max(0)
    }
}

fn load_cursor(dir: &Path) -> Cursor {
    std::fs::read_to_string(dir.join("supabase-state.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save_cursor(dir: &Path, c: &Cursor) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join("supabase-state.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(c).map_err(|e| Error::Invalid(e.to_string()))?)?;
    std::fs::rename(tmp, dir.join("supabase-state.json"))?;
    Ok(())
}

// ---------------------------------------------------------------- the web side

/// Supabase's REST API, or a stand-in in tests.
pub trait Remote {
    /// `path` is everything after /rest/v1/. Returns the parsed reply (Null when empty).
    fn call(&self, method: &str, path: &str, body: Option<&Value>, prefer: Option<&str>) -> Result<Value>;
}

pub struct Supabase {
    base: String,
    key: String,
}

impl Supabase {
    pub fn new(login: &Login) -> Self {
        Supabase { base: format!("{}/rest/v1/", login.url.trim_end_matches('/')), key: login.key.clone() }
    }

    fn once(&self, method: &str, path: &str, body: Option<&Value>, prefer: Option<&str>) -> std::result::Result<Value, (bool, String)> {
        let mut headers = format!("header = \"apikey: {}\"\nheader = \"Content-Type: application/json\"\nheader = \"User-Agent: capturedbyandy-app\"\n", self.key);
        if self.key.starts_with("eyJ") {
            headers += &format!("header = \"Authorization: Bearer {}\"\n", self.key);
        }
        if let Some(p) = prefer {
            headers += &format!("header = \"Prefer: {p}\"\n");
        }
        // The body goes through a private file; the key through stdin.
        let body_file = match body {
            Some(b) => {
                let f = std::env::temp_dir().join(format!("cba-sync-{}.json", super::new_id()));
                std::fs::write(&f, serde_json::to_vec(b).unwrap_or_default()).map_err(|e| (false, e.to_string()))?;
                Some(f)
            }
            None => None,
        };
        let url = format!("{}{}", self.base, path);
        let mut args: Vec<String> = ["-sS", "--connect-timeout", "15", "--max-time", "120", "-K", "-", "-X", method, "-w", "\n%{http_code}"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        if let Some(f) = &body_file {
            args.push("--data-binary".into());
            args.push(format!("@{}", f.display()));
        }
        args.push(url);
        let run = || -> std::io::Result<std::process::Output> {
            let mut child = Command::new("/usr/bin/curl").args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
            child.stdin.take().expect("stdin").write_all(headers.as_bytes())?;
            child.wait_with_output()
        };
        let out = run();
        if let Some(f) = body_file {
            let _ = std::fs::remove_file(f);
        }
        let out = out.map_err(|e| (true, e.to_string()))?;
        if !out.status.success() {
            // curl itself failed: no connection, timeout. Worth another try.
            return Err((true, format!("no connection to Supabase ({})", String::from_utf8_lossy(&out.stderr).trim())));
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let (reply, code) = text.rsplit_once('\n').unwrap_or(("", &text));
        let code: u16 = code.trim().parse().unwrap_or(0);
        if !(200..300).contains(&code) {
            let what = path.split('?').next().unwrap_or(path);
            return Err((code >= 500 || code == 429, format!("Supabase said {code} to {method} {what}: {}", reply.chars().take(300).collect::<String>())));
        }
        if reply.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(reply).map_err(|e| (false, format!("Supabase sent something unreadable: {e}")))
    }
}

impl Remote for Supabase {
    fn call(&self, method: &str, path: &str, body: Option<&Value>, prefer: Option<&str>) -> Result<Value> {
        let mut last = String::new();
        for attempt in 0..4 {
            match self.once(method, path, body, prefer) {
                Ok(v) => return Ok(v),
                Err((retry, msg)) => {
                    last = msg;
                    if !retry {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_secs(2u64.pow(attempt)));
                }
            }
        }
        Err(Error::Invalid(last))
    }
}

fn upsert(r: &dyn Remote, table: &str, rows: &[Value], on: Option<&str>) -> Result<()> {
    for chunk in rows.chunks(BATCH) {
        let path = match on {
            Some(on) => format!("{table}?on_conflict={on}"),
            None => table.to_owned(),
        };
        r.call("POST", &path, Some(&Value::Array(chunk.to_vec())), Some("resolution=merge-duplicates,return=minimal"))?;
    }
    Ok(())
}

fn pages(r: &dyn Remote, query: &str) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    let mut offset = 0;
    loop {
        let page = r.call("GET", &format!("{query}&limit={BATCH}&offset={offset}"), None, None)?;
        let page = match page {
            Value::Array(a) => a,
            _ => Vec::new(),
        };
        let n = page.len();
        out.extend(page);
        if n < BATCH {
            return Ok(out);
        }
        offset += BATCH;
    }
}

/// Replay the boundary millisecond; stable primary-key order makes paging deterministic.
fn changed(r: &dyn Remote, table: &str, since: i64, select: &str) -> Result<Vec<Value>> {
    let key = match table {
        "photos" | "albums" => "id",
        "album_photos" => "album_id,photo_id",
        "studio_rows" => "list,id",
        "studio_links" => "kind,a,b",
        _ => return Err(Error::Invalid(format!("unknown sync stream: {table}"))),
    };
    pages(r, &format!("{table}?select={select}&web_ms=gte.{since}&order=web_ms,{key}"))
}

fn all(r: &dyn Remote, table: &str, select: &str) -> Result<Vec<Value>> {
    pages(r, &format!("{table}?select={select}"))
}

fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or("").to_owned()
}
fn ms(v: &Value, k: &str) -> i64 {
    v[k].as_i64().unwrap_or(0)
}
fn yes(v: &Value, k: &str) -> bool {
    v[k].as_bool().unwrap_or(false)
}

// ---------------------------------------------------------------- helpers

fn camel(s: &str) -> String {
    let mut out = String::new();
    for (i, w) in s.split('_').enumerate() {
        if i == 0 {
            out += w;
        } else {
            let mut c = w.chars();
            if let Some(f) = c.next() {
                out.extend(f.to_uppercase());
                out += c.as_str();
            }
        }
    }
    out
}

fn snake(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_uppercase() {
            out.push('_');
            out.extend(c.to_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

fn to_json(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(b) => json!(base64::engine::general_purpose::STANDARD.encode(b)),
    }
}

fn to_sql(v: &Value) -> Sql {
    match v {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(*b as i64),
        Value::Number(n) => n.as_i64().map(Sql::Integer).unwrap_or_else(|| Sql::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(t) => Sql::Text(t.clone()),
        other => Sql::Text(other.to_string()),
    }
}

fn columns(c: &Connection, table: &str) -> Result<HashSet<String>> {
    let mut st = c.prepare(&format!("PRAGMA table_info({table})"))?;
    let cols = st.query_map([], |r| r.get::<_, String>(1))?.collect::<std::result::Result<_, _>>()?;
    Ok(cols)
}

/// The Drive file id Google Drive for desktop keeps on each file (metadata only, no download).
fn drive_id(path: &str) -> Option<String> {
    let v = xattr::get(path, ID_XATTR).ok()??;
    let s = String::from_utf8(v).ok()?;
    (!s.is_empty()).then_some(s)
}

/// "~/Library/CloudStorage/GoogleDrive-…/My Drive", whichever account it is.
fn my_drive() -> Option<PathBuf> {
    let root = PathBuf::from(std::env::var("HOME").ok()?).join("Library/CloudStorage");
    std::fs::read_dir(root).ok()?.flatten().map(|e| e.path()).find(|p| {
        p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("GoogleDrive-")) && p.join("My Drive").is_dir()
    }).map(|p| p.join("My Drive"))
}

// ---------------------------------------------------------------- pull: web → Mac

/// What the web changed, fetched before the library is touched, so the writer lock
/// is held only for the local writes, never during the network.
#[derive(Default)]
pub struct Pulled {
    marks: Vec<Value>,
    albums: Vec<Value>,
    album_photos: Vec<Value>,
    studio: Vec<Value>,
    links: Vec<Value>,
}

impl Pulled {
    pub fn fetch(r: &dyn Remote, cursor: &Cursor) -> Result<Self> {
        Ok(Pulled {
            marks: changed(r, "photos", cursor.since("photos"), "id,review,web_ms")?,
            albums: changed(r, "albums", cursor.since("albums"), "*")?,
            album_photos: changed(r, "album_photos", cursor.since("album_photos"), "*")?,
            studio: changed(r, "studio_rows", cursor.since("studio_rows"), "*")?,
            links: changed(r, "studio_links", cursor.since("studio_links"), "*")?,
        })
    }

    /// Only persist this after the round succeeds, so failures replay safely.
    fn checkpoint(&self, previous: &Cursor, pushed: i64) -> Cursor {
        let mut next = previous.clone();
        next.pushed = pushed;
        for (stream, rows) in [
            ("photos", &self.marks),
            ("albums", &self.albums),
            ("album_photos", &self.album_photos),
            ("studio_rows", &self.studio),
            ("studio_links", &self.links),
        ] {
            let top = rows.iter().map(|row| ms(row, "web_ms")).fold(previous.since(stream), i64::max);
            next.pull_cursors.insert(stream.into(), json!(top));
            next.pulled = next.pulled.max(top);
        }
        next
    }

    /// Writes them into the library, newer change wins. Returns how many took.
    /// A row the library can't take (a link to a photo it doesn't have) is skipped, not fatal.
    pub fn apply(&self, c: &mut Connection) -> Result<usize> {
        let tx = c.transaction()?;
        let mut n = 0;
        let now = now_ms();
        for m in &self.marks {
            // The web's mark wins when it is newer than the Mac's last say on that photo.
            n += tx.execute(
                "UPDATE photos SET review_state = ?2, reviewed_ms = ?3, updated_ms = ?4 WHERE id = ?1 AND COALESCE(reviewed_ms, 0) < ?3",
                params![s(m, "id"), s(m, "review"), ms(m, "web_ms"), now],
            )?;
        }
        for a in &self.albums {
            let (id, web) = (s(a, "id"), ms(a, "web_ms"));
            if yes(a, "deleted") {
                // Deletions obey the same newer-change rule as edits, and go to Recently deleted.
                let older: Option<i64> = tx.query_row("SELECT 1 FROM albums WHERE id = ?1 AND updated_ms < ?2", params![id, web], |r| r.get(0)).optional()?;
                if older.is_some() && super::trash::discard(&tx, "album", &id, "sync")? {
                    n += 1;
                }
            } else {
                // Deleted on the Mac after this web version: it stays in Recently deleted.
                if super::trash::held_back(&tx, "album", &id, web)? {
                    continue;
                }
                n += tx.execute(
                    "INSERT INTO albums (id, name, description, cover_photo_id, created_ms, updated_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                     ON CONFLICT (id) DO UPDATE SET name = ?2, description = ?3, cover_photo_id = COALESCE(?4, cover_photo_id), updated_ms = ?5
                     WHERE albums.updated_ms < ?5",
                    params![id, s(a, "name"), a["description"].as_str().unwrap_or(""), a["cover_photo_id"].as_str(), web],
                )
                .unwrap_or(0);
            }
        }
        for m in &self.album_photos {
            let (album, photo, web) = (s(m, "album_id"), s(m, "photo_id"), ms(m, "web_ms"));
            if yes(m, "deleted") {
                tx.execute("DELETE FROM photo_albums WHERE album_id = ?1 AND photo_id = ?2", params![album, photo])?;
            } else {
                tx.execute(
                    "INSERT OR IGNORE INTO photo_albums (album_id, photo_id, position, added_ms)
                     SELECT ?1, ?2, (SELECT COALESCE(MAX(position), -1) + 1 FROM photo_albums WHERE album_id = ?1), ?3
                     WHERE EXISTS (SELECT 1 FROM albums WHERE id = ?1) AND EXISTS (SELECT 1 FROM photos WHERE id = ?2)",
                    params![album, photo, web],
                )?;
            }
            tx.execute("UPDATE albums SET updated_ms = MAX(updated_ms, ?2) WHERE id = ?1", params![album, web])?;
            n += 1;
        }
        let tables: HashMap<&str, &str> = STUDIO.into_iter().collect();
        for row in &self.studio {
            let (list, id, web) = (s(row, "list"), s(row, "id"), ms(row, "web_ms"));
            if list == "files" {
                n += pull_file(row) as usize;
                continue;
            }
            let Some(table) = tables.get(list.as_str()) else { continue };
            if yes(row, "deleted") {
                if let Some(kind) = super::trash::kind_for_table(table) {
                    // Ideas and projects deleted elsewhere go to Recently deleted here too.
                    let older: Option<i64> = tx.query_row(&format!("SELECT 1 FROM {table} WHERE id = ?1 AND updated_ms < ?2"), params![id, web], |r| r.get(0)).optional()?;
                    if older.is_some() && super::trash::discard(&tx, kind, &id, "sync")? {
                        n += 1;
                    }
                } else {
                    n += tx.execute(&format!("DELETE FROM {table} WHERE id = ?1 AND updated_ms < ?2"), params![id, web]).unwrap_or(0);
                }
                continue;
            }
            if let Some(kind) = super::trash::kind_for_table(table) {
                if super::trash::held_back(&tx, kind, &id, web)? {
                    continue;
                }
            }
            let mine: Option<i64> = tx.query_row(&format!("SELECT updated_ms FROM {table} WHERE id = ?1"), [&id], |r| r.get(0)).ok();
            if mine.is_some_and(|m| m >= web) {
                continue; // changed on the Mac since: the Mac's version stays
            }
            let cols = columns(&tx, table)?;
            let mut values: Vec<(String, Sql)> = Vec::new();
            if let Some(data) = row["data"].as_object() {
                for (k, v) in data {
                    let col = snake(k);
                    if cols.contains(&col) && col != "id" && col != "updated_ms" {
                        values.push((col, to_sql(v)));
                    }
                }
            }
            values.push(("id".into(), Sql::Text(id.clone())));
            values.push(("updated_ms".into(), Sql::Integer(web)));
            if !values.iter().any(|(k, _)| k == "created_ms") && cols.contains("created_ms") {
                values.push(("created_ms".into(), Sql::Integer(web)));
            }
            let names: Vec<&str> = values.iter().map(|(k, _)| k.as_str()).collect();
            let sql = format!(
                "INSERT INTO {table} ({}) VALUES ({}) ON CONFLICT (id) DO UPDATE SET {}",
                names.join(", "),
                vec!["?"; names.len()].join(", "),
                names.iter().filter(|k| **k != "id").map(|k| format!("{k} = excluded.{k}")).collect::<Vec<_>>().join(", ")
            );
            match tx.execute(&sql, rusqlite::params_from_iter(values.iter().map(|(_, v)| v))) {
                Ok(k) => n += k,
                Err(e) => crate::applog::line(&format!("sync: skipped Studio {list} {id}: {e}")),
            }
        }
        for link in &self.links {
            let Some((_, table, ca, cb)) = LINKS.iter().find(|l| l.0 == link["kind"].as_str().unwrap_or("")) else { continue };
            let (a, b) = (s(link, "a"), s(link, "b"));
            let done = if yes(link, "deleted") {
                tx.execute(&format!("DELETE FROM {table} WHERE {ca} = ?1 AND {cb} = ?2"), params![a, b])
            } else if *table == "studio_piece_media" {
                tx.execute("INSERT OR IGNORE INTO studio_piece_media (piece_id, photo_id, added_ms) VALUES (?1, ?2, ?3)", params![a, b, ms(link, "web_ms")])
            } else {
                tx.execute(&format!("INSERT OR IGNORE INTO {table} ({ca}, {cb}) VALUES (?1, ?2)"), params![a, b])
            };
            match done {
                Ok(k) => n += k,
                Err(e) => crate::applog::line(&format!("sync: skipped link {a} → {b}: {e}")),
            }
        }
        tx.commit()?;
        Ok(n)
    }
}

/// A plan file written on the web (project.md): onto the Mac when it is newer.
fn pull_file(row: &Value) -> bool {
    let path = s(row, "id");
    let home = std::env::var("HOME").unwrap_or_default();
    if yes(row, "deleted") || home.is_empty() || !path.starts_with(&format!("{home}/")) || (!path.contains("/00_PLAN/") && !path.contains("/_CARDS/")) || path.contains("/../") {
        return false;
    }
    let data = &row["data"];
    let modified = data["modifiedMs"].as_i64().unwrap_or(0);
    if let Ok(m) = std::fs::metadata(&path).and_then(|m| m.modified()) {
        let mine = m.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        if mine >= modified {
            return false;
        }
    }
    if let Some(dir) = Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&path, data["contents"].as_str().unwrap_or("")).is_ok()
}

// ---------------------------------------------------------------- push: Mac → web

fn photo_rows(c: &Connection, since: i64) -> Result<Vec<Value>> {
    let mut st = c.prepare(&format!(
        "SELECT p.id, p.captured_at, a.filename, a.path, a.dir, s.path AS root, s.label, p.media_kind, p.is_video, p.duration_s,
                p.width, p.height, p.camera_model, p.review_state, p.reviewed_ms, p.thumbhash,
                MAX(p.updated_ms, a.updated_ms, COALESCE(an.analysed_ms, 0)) AS updated_ms,
                {IPHONE} AS iphone, COALESCE(an.burst_size, 1) AS burst, COALESCE(an.burst_best, 1) AS burst_best,
                an.sharpness, a.storage_state
         FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
         JOIN sources s ON s.id = a.source_id
         LEFT JOIN photo_analysis an ON an.photo_id = p.id
         WHERE p.updated_ms > ?1 OR a.updated_ms > ?1 OR COALESCE(an.analysed_ms, 0) > ?1"
    ))?;
    let rows = st.query_map([since], |r| {
        let dir: String = r.get("dir")?;
        let root: String = r.get("root")?;
        let folder = dir.strip_prefix(&root).map(|f| f.trim_matches('/').to_owned()).unwrap_or_default();
        let path: String = r.get("path")?;
        let thumbhash: Option<Vec<u8>> = r.get("thumbhash")?;
        let sharpness: Option<f64> = r.get("sharpness")?;
        Ok(json!({
            "id": r.get::<_, String>("id")?, "captured_at": r.get::<_, Option<String>>("captured_at")?,
            "filename": r.get::<_, String>("filename")?, "folder": folder, "source": r.get::<_, String>("label")?,
            "media_kind": r.get::<_, Option<String>>("media_kind")?, "is_video": r.get::<_, i64>("is_video")? != 0,
            "duration_s": r.get::<_, Option<f64>>("duration_s")?, "width": r.get::<_, Option<i64>>("width")?,
            "height": r.get::<_, Option<i64>>("height")?, "camera_model": r.get::<_, Option<String>>("camera_model")?,
            "iphone": r.get::<_, i64>("iphone")? != 0, "burst": r.get::<_, i64>("burst")?, "burst_best": r.get::<_, i64>("burst_best")? != 0,
            "soft": sharpness.is_some_and(|x| x < 6.0), "review": r.get::<_, String>("review_state")?,
            "reviewed_ms": r.get::<_, Option<i64>>("reviewed_ms")?,
            "thumbhash": thumbhash.map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
            "drive_id": path, // swapped for the Drive id below, outside the query
            "gone": r.get::<_, String>("storage_state")? == "missing", "updated_ms": r.get::<_, i64>("updated_ms")?,
        }))
    })?;
    let mut out: Vec<Value> = rows.collect::<std::result::Result<_, _>>()?;
    for row in &mut out {
        let path = row["drive_id"].as_str().unwrap_or("").to_owned();
        row["drive_id"] = drive_id(&path).map(Value::String).unwrap_or(Value::Null);
    }
    Ok(out)
}

fn studio_json(c: &Connection, table: &str, since: i64) -> Result<Vec<(String, i64, Value)>> {
    let mut st = c.prepare(&format!("SELECT * FROM {table} WHERE updated_ms > ?1"))?;
    let names: Vec<String> = st.column_names().iter().map(|n| n.to_string()).collect();
    let rows = st.query_map([since], |r| {
        let mut m = Map::new();
        for (i, n) in names.iter().enumerate() {
            m.insert(camel(n), to_json(r.get_ref(i)?));
        }
        Ok((r.get::<_, String>("id")?, r.get::<_, i64>("updated_ms")?, Value::Object(m)))
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// What the Mac holds that a deletion on the Mac could take away: compared with the
/// last round's, so the full online listing (to find deletions) is fetched only when it moved.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Shape {
    albums: BTreeSet<String>,
    studio: BTreeSet<(String, String)>,
    links: BTreeSet<(String, String, String)>,
    tags: u64,
    /// Edited photos: how many, and the latest change. A change sends the edit list.
    edits: (i64, i64),
    /// Fingerprints of the posts plan and the website's project list (read-only online).
    posts: u64,
    site: u64,
}

fn fingerprint(v: &Value) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    v.to_string().hash(&mut h);
    h.finish()
}

/// The posting plan for the web's read-only Calendar and Grid: every post that
/// isn't archived, with its account, dates, plan order, cover and photo count.
fn post_list(c: &Connection) -> Result<Value> {
    let mut st = c.prepare(
        "SELECT p.id, p.title, p.caption, p.status, p.scheduled_at, p.published_at, p.plan_order, p.pinned, a.username,
                (SELECT photo_id FROM post_photos pp WHERE pp.post_id = p.id ORDER BY position LIMIT 1),
                (SELECT COUNT(*) FROM post_photos pp WHERE pp.post_id = p.id), p.created_ms, p.updated_ms,
                (SELECT group_concat(photo_id) FROM (SELECT photo_id FROM post_photos pp WHERE pp.post_id = p.id ORDER BY position))
         FROM posts p LEFT JOIN accounts a ON a.id = p.account_id WHERE p.status != 'archived' ORDER BY p.created_ms DESC",
    )?;
    let items: Vec<Value> = st
        .query_map([], |r| {
            Ok(json!({"id": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "caption": r.get::<_, String>(2)?, "status": r.get::<_, String>(3)?,
                "scheduledAt": r.get::<_, Option<String>>(4)?, "publishedAt": r.get::<_, Option<String>>(5)?, "planOrder": r.get::<_, Option<f64>>(6)?,
                "pinned": r.get::<_, i64>(7)? != 0, "accountUsername": r.get::<_, Option<String>>(8)?, "coverPhotoId": r.get::<_, Option<String>>(9)?,
                "photoCount": r.get::<_, i64>(10)?, "createdMs": r.get::<_, i64>(11)?, "updatedMs": r.get::<_, i64>(12)?,
                "photoIds": r.get::<_, Option<String>>(13)?.map(|v| v.split(',').map(str::to_owned).collect::<Vec<_>>()).unwrap_or_default()}))
        })?
        .collect::<std::result::Result<_, _>>()?;
    Ok(json!({ "items": items }))
}

/// The website's projects (slug, title, year) from its archive.json, for the web's read-only Portfolio.
fn site_list(c: &Connection) -> Value {
    let dir: Option<String> = c.query_row("SELECT value FROM settings WHERE key = 'archive_site_dir'", [], |r| r.get(0)).ok().filter(|d: &String| !d.trim().is_empty());
    let dir = dir.map(std::path::PathBuf::from).unwrap_or_else(|| {
        std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_default().join("Movies/OFFICE/SOCIALS/PROJECTS/portfolio")
    });
    let doc: Value = std::fs::read_to_string(dir.join("src/archive.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let projects: Vec<Value> = doc["projects"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|p| {
                    // The library pictures on the page (frames without one are placeholders).
                    let photos: Vec<Value> = p["frames"].as_object().map(|f| f.values().filter_map(|x| x["photo"].as_str().map(|s| json!(s))).collect()).unwrap_or_default();
                    json!({"slug": p["slug"], "title": p["title"], "year": p["year"], "cover": p["cover"], "notebook": p["notebook"], "photos": photos})
                })
                .collect()
        })
        .unwrap_or_default();
    json!({ "projects": projects, "found": doc.is_object() })
}

fn shape(c: &Connection) -> Result<Shape> {
    let mut sh = Shape::default();
    sh.posts = fingerprint(&post_list(c)?);
    sh.site = fingerprint(&site_list(c));
    sh.edits = c.query_row("SELECT COUNT(*), COALESCE(MAX(updated_ms), 0) FROM photo_looks", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let mut st = c.prepare("SELECT id FROM albums")?;
    sh.albums = st.query_map([], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
    for (short, table) in STUDIO {
        let mut st = c.prepare(&format!("SELECT id FROM {table}"))?;
        for id in st.query_map([], |r| r.get::<_, String>(0))? {
            sh.studio.insert((short.to_owned(), id?));
        }
    }
    for (kind, table, ca, cb) in LINKS {
        let mut st = c.prepare(&format!("SELECT {ca}, {cb} FROM {table}"))?;
        for ab in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (a, b) = ab?;
            sh.links.insert((kind.to_owned(), a, b));
        }
    }
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    let mut st = c.prepare("SELECT id, name, slug FROM tags ORDER BY id")?;
    for t in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))? {
        t?.hash(&mut h);
    }
    let mut st = c.prepare("SELECT tag_id, photo_id FROM photo_tags ORDER BY tag_id, photo_id")?;
    for t in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        t?.hash(&mut h);
    }
    sh.tags = h.finish();
    Ok(sh)
}

/// Everything the Mac sends in a round, read in one go from the library.
pub struct Outgoing {
    photos: Vec<Value>,
    albums: Vec<(Value, Vec<Value>)>,
    studio: Vec<(String, Vec<(String, i64, Value)>)>,
    tags: Vec<Value>,
    photo_tags: Vec<Value>,
    root: Option<String>,
    files: Vec<Value>,
    shape: Shape,
    pub counts: Value,
    /// Every edit, the latest first (studio_rows meta/edits), so the web's Edit page lists them.
    edits: Value,
    posts: Value,
    site: Value,
}

/// The Mac's edits as one row for the web: [photo id, last change ms, look name or null], newest first.
/// Read-only online: edits are made and rendered on the Mac only.
fn edit_list(c: &Connection) -> Result<Value> {
    let mut st = c.prepare("SELECT pl.photo_id, pl.updated_ms, l.name FROM photo_looks pl LEFT JOIN looks l ON l.id = pl.look_id ORDER BY pl.updated_ms DESC")?;
    let items: Vec<Value> = st
        .query_map([], |r| Ok(json!([r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<String>>(2)?])))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(json!({ "items": items }))
}

impl Outgoing {
    pub fn read(c: &Connection, since: i64) -> Result<Self> {
        let photos = photo_rows(c, since)?;
        let mut albums = Vec::new();
        let mut st = c.prepare("SELECT id, name, description, cover_photo_id, updated_ms FROM albums WHERE updated_ms > ?1")?;
        let list: Vec<(String, Value)> = st
            .query_map([since], |r| {
                Ok((r.get::<_, String>(0)?, json!({"id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "description": r.get::<_, Option<String>>(2)?,
                    "cover_photo_id": r.get::<_, Option<String>>(3)?, "updated_ms": r.get::<_, i64>(4)?, "deleted": false})))
            })?
            .collect::<std::result::Result<_, _>>()?;
        for (id, album) in list {
            let mut st = c.prepare("SELECT photo_id, position FROM photo_albums WHERE album_id = ?1")?;
            let members = st
                .query_map([&id], |r| Ok(json!({"album_id": id, "photo_id": r.get::<_, String>(0)?, "position": r.get::<_, i64>(1)?, "deleted": false})))?
                .collect::<std::result::Result<_, _>>()?;
            albums.push((album, members));
        }
        let mut studio = Vec::new();
        for (short, table) in STUDIO {
            studio.push((short.to_owned(), studio_json(c, table, since)?));
        }
        let mut st = c.prepare("SELECT id, name, slug FROM tags")?;
        let tags = st.query_map([], |r| Ok(json!({"id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "slug": r.get::<_, String>(2)?})))?.collect::<std::result::Result<_, _>>()?;
        let mut st = c.prepare("SELECT tag_id, photo_id FROM photo_tags")?;
        let photo_tags = st.query_map([], |r| Ok(json!({"tag_id": r.get::<_, String>(0)?, "photo_id": r.get::<_, String>(1)?})))?.collect::<std::result::Result<_, _>>()?;
        let root: Option<String> = c.query_row("SELECT value FROM settings WHERE key = 'studio.root'", [], |r| r.get(0)).ok();
        // Plan files (00_PLAN/*.md) of each piece, changed since.
        let mut files = Vec::new();
        let mut st = c.prepare("SELECT folder FROM studio_pieces WHERE folder IS NOT NULL AND folder != ''")?;
        let folders: Vec<String> = st.query_map([], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
        for folder in folders {
            let Ok(dir) = std::fs::read_dir(Path::new(&folder).join("00_PLAN")) else { continue };
            for e in dir.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) != Some("md") {
                    continue;
                }
                let Ok(meta) = e.metadata() else { continue };
                let mtime = meta.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
                if mtime > since && meta.len() < 1_000_000 {
                    if let Ok(contents) = std::fs::read_to_string(&p) {
                        let path = p.to_string_lossy().into_owned();
                        files.push(json!({"list": "files", "id": path, "data": {"path": path, "contents": contents, "modifiedMs": mtime}, "updated_ms": mtime, "deleted": false}));
                    }
                }
            }
        }
        let counts = c.query_row(
            "SELECT COUNT(*), SUM(p.review_state = 'unreviewed'), SUM(p.review_state = 'selected'), SUM(p.review_state = 'rejected'), SUM(a.storage_state = 'missing')
             FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1",
            [],
            |r| Ok(json!({"photos": r.get::<_, i64>(0)?, "unreviewed": r.get::<_, Option<i64>>(1)?.unwrap_or(0), "selected": r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                          "rejected": r.get::<_, Option<i64>>(3)?.unwrap_or(0), "missing": r.get::<_, Option<i64>>(4)?.unwrap_or(0)})),
        )?;
        Ok(Outgoing { photos, albums, studio, tags, photo_tags, root, files, shape: shape(c)?, counts, edits: edit_list(c)?, posts: post_list(c)?, site: site_list(c) })
    }

    /// Sends it. `last` is the shape the web had after the previous round (None: unknown,
    /// so the full listings are compared). Returns how many rows went up.
    pub fn send(&self, r: &dyn Remote, last: Option<&Shape>) -> Result<usize> {
        let mut n = 0;
        upsert(r, "photos", &self.photos, None)?;
        n += self.photos.len();
        for (album, members) in &self.albums {
            upsert(r, "albums", std::slice::from_ref(album), None)?;
            upsert(r, "album_photos", members, Some("album_id,photo_id"))?;
            let keep: HashSet<&str> = members.iter().filter_map(|m| m["photo_id"].as_str()).collect();
            let id = s(album, "id");
            let online = r.call("GET", &format!("album_photos?select=photo_id&album_id=eq.{}&deleted=eq.false", urlencode(&id)), None, None)?;
            let gone: Vec<Value> = online
                .as_array()
                .map(|a| a.iter().filter(|o| !keep.contains(o["photo_id"].as_str().unwrap_or(""))).map(|o| json!({"album_id": id, "photo_id": o["photo_id"], "deleted": true})).collect())
                .unwrap_or_default();
            upsert(r, "album_photos", &gone, Some("album_id,photo_id"))?;
            n += 1;
        }
        // Studio rows changed on the Mac.
        for (short, rows) in &self.studio {
            let out: Vec<Value> = rows.iter().map(|(id, upd, data)| json!({"list": short, "id": id, "data": data, "updated_ms": upd, "deleted": false})).collect();
            upsert(r, "studio_rows", &out, Some("list,id"))?;
            n += out.len();
        }
        upsert(r, "studio_rows", &self.files, Some("list,id"))?;
        n += self.files.len();
        // Deletions on the Mac, and the tag set: only looked at when they changed.
        if last.is_none_or(|l| l.albums != self.shape.albums) {
            let gone: Vec<Value> = all(r, "albums", "id,name,deleted")?
                .into_iter()
                .filter(|a| !yes(a, "deleted") && !self.shape.albums.contains(&s(a, "id")))
                .map(|a| json!({"id": a["id"], "name": a["name"], "deleted": true}))
                .collect();
            upsert(r, "albums", &gone, None)?;
        }
        if last.is_none_or(|l| l.studio != self.shape.studio) {
            let gone: Vec<Value> = all(r, "studio_rows", "list,id,deleted")?
                .into_iter()
                .filter(|row| !yes(row, "deleted") && STUDIO.iter().any(|(k, _)| *k == s(row, "list")) && !self.shape.studio.contains(&(s(row, "list"), s(row, "id"))))
                .map(|row| json!({"list": row["list"], "id": row["id"], "data": {}, "deleted": true}))
                .collect();
            upsert(r, "studio_rows", &gone, Some("list,id"))?;
        }
        if last.is_none_or(|l| l.links != self.shape.links) {
            let online: BTreeSet<(String, String, String)> =
                all(r, "studio_links", "kind,a,b,deleted")?.into_iter().filter(|l| !yes(l, "deleted")).map(|l| (s(&l, "kind"), s(&l, "a"), s(&l, "b"))).collect();
            let add: Vec<Value> = self.shape.links.difference(&online).map(|(k, a, b)| json!({"kind": k, "a": a, "b": b, "deleted": false})).collect();
            let del: Vec<Value> = online.difference(&self.shape.links).map(|(k, a, b)| json!({"kind": k, "a": a, "b": b, "deleted": true})).collect();
            upsert(r, "studio_links", &add, Some("kind,a,b"))?;
            upsert(r, "studio_links", &del, Some("kind,a,b"))?;
        }
        if last.is_none_or(|l| l.edits != self.shape.edits) {
            upsert(r, "studio_rows", &[json!({"list": "meta", "id": "edits", "data": self.edits, "updated_ms": self.shape.edits.1, "deleted": false})], Some("list,id"))?;
            n += 1;
        }
        if last.is_none_or(|l| l.posts != self.shape.posts) {
            upsert(r, "studio_rows", &[json!({"list": "meta", "id": "posts", "data": self.posts, "updated_ms": now_ms(), "deleted": false})], Some("list,id"))?;
            n += 1;
        }
        if last.is_none_or(|l| l.site != self.shape.site) {
            upsert(r, "studio_rows", &[json!({"list": "meta", "id": "site", "data": self.site, "updated_ms": now_ms(), "deleted": false})], Some("list,id"))?;
            n += 1;
        }
        if last.is_none_or(|l| l.tags != self.shape.tags) {
            upsert(r, "tags", &self.tags, None)?;
            upsert(r, "photo_tags", &self.photo_tags, Some("tag_id,photo_id"))?;
        }
        if last.is_none() {
            let root = self.root.clone().unwrap_or_else(|| format!("{}/Movies/STUDIO", std::env::var("HOME").unwrap_or_default()));
            upsert(r, "studio_rows", &[json!({"list": "meta", "id": "root", "data": {"root": root}, "deleted": false})], Some("list,id"))?;
        }
        Ok(n)
    }
}

fn urlencode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// Each video's web copy (tools/web-video/make.py) once Drive has given it an id: sent as web_video_id.
pub fn push_web_videos(r: &dyn Remote, db: &Db) -> Result<usize> {
    let Some(drive) = my_drive() else { return Ok(0) };
    let camera = drive.join("*ARCHIVES/CAMERA");
    let web = drive.join("STORAGE/WEB-VIDEO");
    let state_file = config_dir().join("web-videos.json");
    let mut sent: HashMap<String, String> = std::fs::read_to_string(&state_file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let videos: Vec<(String, String)> = db.read(|c| {
        let mut st = c.prepare("SELECT p.id, a.path FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1 WHERE p.is_video = 1")?;
        let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<_, _>>()?;
        Ok(v)
    })?;
    let mut n = 0;
    for (id, path) in videos {
        let Ok(rel) = Path::new(&path).strip_prefix(&camera) else { continue };
        let copy = web.join(rel).with_extension("mp4");
        let Some(fid) = copy.exists().then(|| drive_id(&copy.to_string_lossy())).flatten() else { continue };
        if sent.get(&id) != Some(&fid) {
            r.call("PATCH", &format!("photos?id=eq.{}", urlencode(&id)), Some(&json!({"web_video_id": fid})), Some("return=minimal"))?;
            sent.insert(id, fid);
            n += 1;
        }
    }
    if n > 0 {
        std::fs::create_dir_all(config_dir())?;
        std::fs::write(&state_file, serde_json::to_vec(&sent).unwrap_or_default())?;
    }
    Ok(n)
}

// ---------------------------------------------------------------- a round

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub pulled: usize,
    pub sent: usize,
    pub videos: usize,
}

/// One round. `shape` carries what the web was left with between rounds.
pub fn round(r: &dyn Remote, db: &Db, dir: &Path, shape: &mut Option<Shape>, last_scan_ms: Option<i64>, videos: bool) -> Result<Report> {
    let cursor = load_cursor(dir);
    let started = now_ms();
    let pulled = Pulled::fetch(r, &cursor)?;
    let took = db.write(|c| pulled.apply(c))?;
    // Anything just pulled is newer than the push cursor too: it goes back up unchanged, which is harmless.
    let out = db.read(|c| Outgoing::read(c, cursor.pushed))?;
    let sent = out.send(r, shape.as_ref())?;
    let videos = if videos { push_web_videos(r, db)? } else { 0 };
    // The heartbeat: when, and what the Mac counts, so the web can tell how fresh it is.
    let mut beat = out.counts.clone();
    beat["atMs"] = json!(now_ms());
    beat["lastScanMs"] = json!(last_scan_ms);
    upsert(r, "studio_rows", &[json!({"list": "meta", "id": "sync", "data": beat, "updated_ms": now_ms(), "deleted": false})], Some("list,id"))?;
    save_cursor(dir, &pulled.checkpoint(&cursor, started))?;
    *shape = Some(out.shape);
    Ok(Report { pulled: took, sent, videos })
}

/// When the last round (from the app or sync.py) went through, if ever.
pub fn last_pushed(dir: &Path) -> Option<i64> {
    Some(load_cursor(dir).pushed).filter(|t| *t > 0)
}

/// The login and cursor folder, for the app.
pub fn state_dir() -> PathBuf {
    config_dir()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// A Supabase stand-in: answers GETs from canned rows and records every write.
    #[derive(Default)]
    struct Fake {
        gets: RefCell<HashMap<String, Vec<Value>>>,
        writes: RefCell<Vec<(String, String, Value)>>,
        requests: RefCell<Vec<String>>,
        fail: RefCell<Option<(String, String)>>,
    }
    impl Remote for Fake {
        fn call(&self, method: &str, path: &str, body: Option<&Value>, _: Option<&str>) -> Result<Value> {
            let table = path.split('?').next().unwrap().to_owned();
            self.requests.borrow_mut().push(path.into());
            if self.fail.borrow().as_ref().is_some_and(|(m, t)| m == method && t == &table) {
                return Err(Error::Invalid("simulated remote failure".into()));
            }
            if method == "GET" {
                let query: HashMap<&str, &str> = path.split_once('?').map(|(_, q)| q.split('&').filter_map(|v| v.split_once('=')).collect()).unwrap_or_default();
                let mut rows = self.gets.borrow().get(&table).cloned().unwrap_or_default();
                if let Some(filter) = query.get("web_ms") {
                    let (op, value) = filter.split_once('.').unwrap();
                    let since = value.parse::<i64>().unwrap();
                    rows.retain(|r| if op == "gte" { ms(r, "web_ms") >= since } else { ms(r, "web_ms") > since });
                }
                if let Some(order) = query.get("order") {
                    let keys: Vec<&str> = order.split(',').collect();
                    rows.sort_by(|a, b| {
                        keys.iter().map(|key| if *key == "web_ms" { ms(a, key).cmp(&ms(b, key)) } else { s(a, key).cmp(&s(b, key)) })
                            .find(|o| !o.is_eq()).unwrap_or(std::cmp::Ordering::Equal)
                    });
                }
                let offset = query.get("offset").and_then(|v| v.parse().ok()).unwrap_or(0);
                let limit = query.get("limit").and_then(|v| v.parse().ok()).unwrap_or(BATCH);
                return Ok(Value::Array(rows.into_iter().skip(offset).take(limit).collect()));
            }
            self.writes.borrow_mut().push((method.into(), table, body.cloned().unwrap_or(Value::Null)));
            Ok(Value::Null)
        }
    }
    impl Fake {
        fn written(&self, table: &str) -> Vec<Value> {
            self.writes.borrow().iter().filter(|(_, t, _)| t == table).flat_map(|(_, _, b)| b.as_array().cloned().unwrap_or_default()).collect()
        }
    }

    fn library() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("library.db")).unwrap();
        db.write(|c| {
            c.execute_batch(
                "INSERT INTO sources (id, path, label, enabled, created_ms) VALUES ('s1', '/lib', 'CAMERA', 1, 0);",
            )?;
            Ok(())
        })
        .unwrap();
        (dir, db)
    }

    fn add_photo(db: &Db, id: &str, review: &str, reviewed_ms: i64, updated_ms: i64) {
        db.write(|c| {
            c.execute(
                "INSERT INTO photos (id, captured_at, captured_at_source, media_kind, review_state, reviewed_ms, created_ms, updated_ms) VALUES (?1, '2026-11-01T10:00:00', 'exif', 'image', ?2, ?3, 0, ?4)",
                params![id, review, reviewed_ms, updated_ms],
            )?;
            c.execute(
                "INSERT INTO assets (id, photo_id, source_id, path, dir, stem, filename, format, is_raw, is_primary, size, mtime_ms, storage_state, last_seen_scan, created_ms, updated_ms)
                 VALUES (?1, ?1, 's1', '/lib/TRIP/' || ?1 || '.jpg', '/lib/TRIP', ?1, ?1 || '.jpg', 'jpg', 0, 1, 1, 0, 'local', 0, 0, ?2)",
                params![id, updated_ms],
            )?;
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn a_round_keeps_sync_py_pull_checkpoints() {
        let (dir, db) = library();
        std::fs::write(dir.path().join("supabase-state.json"), r#"{"pushed": 1, "pulled": 2, "pull_cursors": {"photos": 7, "albums": 3, "future_stream": {"token": "test"}}, "future_field": {"version": 2}}"#).unwrap();
        let fake = Fake::default();
        let mut shape = None;
        round(&fake, &db, dir.path(), &mut shape, None, false).unwrap();
        let state: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("supabase-state.json")).unwrap()).unwrap();
        assert_eq!(state["pull_cursors"], json!({"photos": 7, "albums": 3, "album_photos": 0, "studio_rows": 0, "studio_links": 0, "future_stream": {"token": "test"}}));
        assert_eq!(state["future_field"], json!({"version": 2}), "Cursor.other survives");
        assert!(state["pushed"].as_i64().unwrap() > 1, "the push cursor moved on");
    }

    #[test]
    fn new_photos_go_up_with_a_heartbeat() {
        let (dir, db) = library();
        add_photo(&db, "p1", "unreviewed", 0, 5_000);
        let fake = Fake::default();
        let mut shape = None;
        round(&fake, &db, dir.path(), &mut shape, Some(42), false).unwrap();
        let photos = fake.written("photos");
        assert_eq!(photos.len(), 1);
        assert_eq!(photos[0]["folder"], "TRIP");
        assert_eq!(photos[0]["source"], "CAMERA");
        let beat: Vec<Value> = fake.written("studio_rows").into_iter().filter(|r| r["id"] == "sync").collect();
        assert_eq!(beat[0]["data"]["photos"], 1);
        assert_eq!(beat[0]["data"]["unreviewed"], 1);
        assert_eq!(beat[0]["data"]["lastScanMs"], 42);
        // The next round sends nothing new and doesn't list everything online again.
        fake.writes.borrow_mut().clear();
        round(&fake, &db, dir.path(), &mut shape, None, false).unwrap();
        assert!(fake.written("photos").is_empty());
        assert!(fake.written("tags").is_empty());
    }

    #[test]
    fn a_web_mark_wins_only_when_newer() {
        let (dir, db) = library();
        add_photo(&db, "old", "unreviewed", 1_000, 1_000);
        add_photo(&db, "new", "selected", 9_000, 9_000);
        let fake = Fake::default();
        fake.gets.borrow_mut().insert(
            "photos".into(),
            vec![json!({"id": "old", "review": "rejected", "web_ms": 5_000}), json!({"id": "new", "review": "rejected", "web_ms": 5_000})],
        );
        let mut shape = None;
        round(&fake, &db, dir.path(), &mut shape, None, false).unwrap();
        let marks: Vec<(String, String)> = db
            .read(|c| {
                let mut st = c.prepare("SELECT id, review_state FROM photos ORDER BY id")?;
                let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<_, _>>()?;
                Ok(v)
            })
            .unwrap();
        assert_eq!(marks, vec![("new".into(), "selected".into()), ("old".into(), "rejected".into())]);
        assert_eq!(load_cursor(dir.path()).pulled, 5_000);
    }

    #[test]
    fn a_stale_web_deletion_keeps_a_newer_album() {
        let (dir, db) = library();
        db.write(|c| {
            c.execute("INSERT INTO albums (id, name, created_ms, updated_ms) VALUES ('a1', 'Coast', 0, 9000)", [])?;
            Ok(())
        })
        .unwrap();
        let fake = Fake::default();
        fake.gets.borrow_mut().insert("albums".into(), vec![json!({"id": "a1", "name": "Coast", "deleted": true, "web_ms": 5_000})]);
        let mut shape = None;
        round(&fake, &db, dir.path(), &mut shape, None, false).unwrap();
        let n: i64 = db.read(|c| Ok(c.query_row("SELECT COUNT(*) FROM albums", [], |r| r.get(0))?)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn a_deletion_from_the_web_goes_to_recently_deleted_and_stays_restorable() {
        let (dir, db) = library();
        add_photo(&db, "p1", "selected", 0, 0);
        db.write(|c| {
            c.execute("INSERT INTO albums (id, name, created_ms, updated_ms) VALUES ('a1', 'Coast', 0, 1000)", [])?;
            c.execute("INSERT INTO photo_albums (album_id, photo_id, position, added_ms) VALUES ('a1', 'p1', 0, 0)", [])?;
            Ok(())
        })
        .unwrap();
        let fake = Fake::default();
        fake.gets.borrow_mut().insert("albums".into(), vec![json!({"id": "a1", "name": "Coast", "deleted": true, "web_ms": 5_000})]);
        let mut shape = None;
        round(&fake, &db, dir.path(), &mut shape, None, false).unwrap();
        let count = |sql: &str| -> i64 { db.read(|c| Ok(c.query_row(sql, [], |r| r.get(0))?)).unwrap() };
        assert_eq!(count("SELECT COUNT(*) FROM albums"), 0, "the newer web deletion applies");
        let kept = super::super::trash::list(&db, Some("album")).unwrap();
        assert_eq!((kept.len(), kept[0].source.as_str(), kept[0].linked), (1, "sync", 1), "but it is kept, with its picture");
        // Restored on the Mac: the same old tombstone, pulled again, can't remove it.
        super::super::trash::restore(&db, kept[0].id, "Recently deleted").unwrap();
        round(&fake, &db, dir.path(), &mut shape, None, false).unwrap();
        assert_eq!(count("SELECT COUNT(*) FROM albums WHERE id = 'a1'"), 1);
        assert_eq!(count("SELECT COUNT(*) FROM photo_albums WHERE album_id = 'a1'"), 1);
        assert_eq!(count("SELECT COUNT(*) FROM trash"), 0, "never resurrected twice or duplicated");
    }

    #[test]
    fn a_mac_delete_sends_the_tombstone_and_a_restore_sends_it_back_live() {
        let (dir, db) = library();
        db.write(|c| {
            c.execute("INSERT INTO albums (id, name, created_ms, updated_ms) VALUES ('a1', 'Coast', 0, 10)", [])?;
            Ok(())
        })
        .unwrap();
        let fake = Fake::default();
        fake.gets.borrow_mut().insert("albums".into(), vec![json!({"id": "a1", "name": "Coast", "deleted": false, "web_ms": 10})]);
        let mut shape = None;
        round(&fake, &db, dir.path(), &mut shape, None, false).unwrap();
        super::super::albums::delete(&db, "a1", "menu").unwrap();
        round(&fake, &db, dir.path(), &mut shape, None, false).unwrap();
        let sent = fake.written("albums");
        assert!(sent.iter().any(|a| a["id"] == "a1" && a["deleted"] == true), "the web hears it was deleted");
        let id = super::super::trash::list(&db, None).unwrap()[0].id;
        super::super::trash::restore(&db, id, "Recently deleted").unwrap();
        round(&fake, &db, dir.path(), &mut shape, None, false).unwrap();
        let sent = fake.written("albums");
        let last = sent.iter().rev().find(|a| a["id"] == "a1").unwrap();
        assert_eq!(last["deleted"], false, "and that it is back");
    }

    fn pull_queries(fake: &Fake) -> Vec<String> {
        fake.requests.borrow().iter().filter(|p| p.contains("web_ms=")).cloned().collect()
    }

    #[test]
    fn boundary_replay_picks_up_a_later_row_in_the_same_millisecond() {
        let (dir, db) = library();
        add_photo(&db, "first", "unreviewed", 0, 0);
        add_photo(&db, "late", "unreviewed", 0, 0);
        let fake = Fake::default();
        fake.gets.borrow_mut().insert("photos".into(), vec![json!({"id": "first", "review": "selected", "web_ms": 500})]);
        let mut shape = None;
        round(&fake, &db, dir.path(), &mut shape, None, false).unwrap();
        fake.gets.borrow_mut().get_mut("photos").unwrap().push(json!({"id": "late", "review": "rejected", "web_ms": 500}));
        fake.requests.borrow_mut().clear();
        let report = round(&fake, &db, dir.path(), &mut shape, None, false).unwrap();
        assert_eq!(report.pulled, 1, "the boundary row is applied, the old mark is not applied twice");
        let mark: String = db.read(|c| Ok(c.query_row("SELECT review_state FROM photos WHERE id = 'late'", [], |r| r.get(0))?)).unwrap();
        assert_eq!(mark, "rejected");
        assert!(pull_queries(&fake)[0].contains("web_ms=gte.500&order=web_ms,id"));
    }

    #[test]
    fn each_stream_uses_and_advances_only_its_own_cursor() {
        let fake = Fake::default();
        let streams = [("photos", 100), ("albums", 200), ("album_photos", 300), ("studio_rows", 400), ("studio_links", 500)];
        let mut cursor = Cursor { pulled: 90_000, ..Cursor::default() };
        for (stream, since) in streams {
            cursor.pull_cursors.insert(stream.into(), json!(since));
            fake.gets.borrow_mut().insert(stream.into(), vec![json!({"id": "new", "web_ms": since + 10}), json!({"id": "old", "web_ms": since - 1})]);
        }
        let pulled = Pulled::fetch(&fake, &cursor).unwrap();
        let next = pulled.checkpoint(&cursor, 123);
        for (stream, since) in streams {
            assert!(pull_queries(&fake).iter().any(|q| q.starts_with(&format!("{stream}?")) && q.contains(&format!("web_ms=gte.{since}&"))));
            assert_eq!(next.since(stream), since + 10);
        }
        assert_eq!(next.pushed, 123);
        // An empty response cannot move an established cursor backwards or to another stream's high-water mark.
        let empty = Fake::default();
        let next = Pulled::fetch(&empty, &next).unwrap().checkpoint(&next, 124);
        for (stream, since) in streams {
            assert_eq!(next.since(stream), since + 10);
        }
    }

    #[test]
    fn legacy_shared_state_replays_once_then_uses_stream_checkpoints() {
        let (dir, db) = library();
        add_photo(&db, "p1", "unreviewed", 0, 0);
        std::fs::write(dir.path().join("supabase-state.json"), r#"{"pushed":0,"pulled":99999}"#).unwrap();
        let fake = Fake::default();
        fake.gets.borrow_mut().insert("photos".into(), vec![json!({"id":"p1","review":"selected","web_ms":100})]);
        fake.gets.borrow_mut().insert("albums".into(), vec![json!({"id":"a1","name":"Coast","web_ms":200})]);
        let mut shape = None;
        round(&fake, &db, dir.path(), &mut shape, None, false).unwrap();
        assert!(pull_queries(&fake).iter().all(|q| q.contains("web_ms=gte.0&")));
        assert_eq!(load_cursor(dir.path()).since("photos"), 100);
        fake.requests.borrow_mut().clear();
        round(&fake, &db, dir.path(), &mut shape, None, false).unwrap();
        let queries = pull_queries(&fake);
        assert!(queries.iter().any(|q| q.starts_with("photos?") && q.contains("web_ms=gte.100&")));
        assert!(queries.iter().any(|q| q.starts_with("albums?") && q.contains("web_ms=gte.200&")));
        assert_eq!(load_cursor(dir.path()).since("studio_links"), 0, "an empty stream has a real zero checkpoint");
    }

    #[test]
    fn absent_stream_in_python_state_replays_without_resetting_known_streams() {
        let cursor: Cursor = serde_json::from_value(json!({"pulled":9000,"pull_cursors":{"photos":8000}})).unwrap();
        let fake = Fake::default();
        fake.gets.borrow_mut().insert("studio_links".into(), vec![json!({"kind":"pieceMedia","a":"piece","b":"photo","web_ms":50})]);
        let next = Pulled::fetch(&fake, &cursor).unwrap().checkpoint(&cursor, 10000);
        assert_eq!(next.since("photos"), 8000);
        assert_eq!(next.since("studio_links"), 50);
        assert!(pull_queries(&fake).iter().any(|q| q.starts_with("studio_links?") && q.contains("web_ms=gte.0&")));
    }

    #[test]
    fn tied_timestamps_page_in_stable_primary_key_order_for_every_stream() {
        for (table, key) in [("photos", "id"), ("albums", "id"), ("album_photos", "album_id,photo_id"), ("studio_rows", "list,id"), ("studio_links", "kind,a,b")] {
            let fake = Fake::default();
            let rows: Vec<Value> = (0..BATCH + 2).rev().map(|i| {
                let id = format!("{i:04}");
                json!({"id":id,"album_id":"album","photo_id":id,"list":"pieces","kind":"pieceMedia","a":"piece","b":id,"web_ms":42})
            }).collect();
            fake.gets.borrow_mut().insert(table.into(), rows);
            let got = changed(&fake, table, 42, "*").unwrap();
            assert_eq!(got.len(), BATCH + 2);
            assert_eq!(got[0]["id"], "0000");
            assert_eq!(got[BATCH + 1]["id"], format!("{:04}", BATCH + 1));
            let queries = pull_queries(&fake);
            assert_eq!(queries.len(), 2);
            assert!(queries.iter().all(|q| q.contains(&format!("order=web_ms,{key}&"))));
            assert!(queries[1].ends_with(&format!("offset={BATCH}")));
        }
    }

    #[test]
    fn failed_fetch_never_advances_the_shared_state_file() {
        let (dir, db) = library();
        let original = r#"{"pushed":1,"pulled":2,"pull_cursors":{"photos":3},"future":true}"#;
        std::fs::write(dir.path().join("supabase-state.json"), original).unwrap();
        let fake = Fake::default();
        *fake.fail.borrow_mut() = Some(("GET".into(), "studio_links".into()));
        let mut shape = None;
        assert!(round(&fake, &db, dir.path(), &mut shape, None, false).is_err());
        assert_eq!(std::fs::read_to_string(dir.path().join("supabase-state.json")).unwrap(), original);
        assert!(shape.is_none());
    }

    #[test]
    fn failed_push_replays_committed_pulls_without_losing_checkpoints() {
        let (dir, db) = library();
        add_photo(&db, "p1", "unreviewed", 0, 0);
        let original = r#"{"pushed":0,"pulled":0,"pull_cursors":{"photos":0},"future":true}"#;
        std::fs::write(dir.path().join("supabase-state.json"), original).unwrap();
        let fake = Fake::default();
        fake.gets.borrow_mut().insert("photos".into(), vec![json!({"id":"p1","review":"selected","web_ms":100})]);
        *fake.fail.borrow_mut() = Some(("POST".into(), "photos".into()));
        let mut shape = None;
        assert!(round(&fake, &db, dir.path(), &mut shape, None, false).is_err());
        assert_eq!(std::fs::read_to_string(dir.path().join("supabase-state.json")).unwrap(), original);
        assert!(shape.is_none());
        *fake.fail.borrow_mut() = None;
        let report = round(&fake, &db, dir.path(), &mut shape, None, false).unwrap();
        assert_eq!(report.pulled, 0, "already committed file mark replays idempotently");
        assert_eq!(load_cursor(dir.path()).since("photos"), 100);
        assert_eq!(load_cursor(dir.path()).other["future"], true);
    }

    #[test]
    fn the_edit_list_goes_up_once_and_again_after_a_change() {
        let (dir, db) = library();
        add_photo(&db, "p1", "selected", 0, 0);
        add_photo(&db, "p2", "selected", 0, 0);
        db.write(|c| {
            c.execute("INSERT INTO photo_looks (photo_id, look_id, strength, adjustments, updated_ms) VALUES ('p1', NULL, 1, '{\"exposure\":1}', 10), ('p2', NULL, 1, '{\"exposure\":1}', 20)", [])?;
            Ok(())
        })
        .unwrap();
        let fake = Fake::default();
        let mut shape = None;
        let edits = |f: &Fake| f.written("studio_rows").into_iter().filter(|r| r["id"] == "edits").collect::<Vec<_>>();
        round(&fake, &db, dir.path(), &mut shape, None, false).unwrap();
        let sent = edits(&fake);
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["data"]["items"], json!([["p2", 20, null], ["p1", 10, null]]), "newest first");
        round(&fake, &db, dir.path(), &mut shape, None, false).unwrap();
        assert_eq!(edits(&fake).len(), 1, "unchanged: not sent again");
        db.write(|c| { c.execute("DELETE FROM photo_looks WHERE photo_id = 'p2'", [])?; Ok(()) }).unwrap();
        round(&fake, &db, dir.path(), &mut shape, None, false).unwrap();
        let sent = edits(&fake);
        assert_eq!(sent.len(), 2, "a removed edit sends the list again");
        assert_eq!(sent[1]["data"]["items"], json!([["p1", 10, null]]));
    }

    #[test]
    fn the_posting_plan_goes_up_read_only_and_only_when_it_changes() {
        let (dir, db) = library();
        db.write(|c| {
            c.execute("INSERT INTO posts (id, title, status, scheduled_at, created_ms, updated_ms) VALUES ('po1', 'Lima light', 'scheduled', '2026-11-20', 1, 1), ('po2', 'Old', 'archived', NULL, 1, 1)", [])?;
            Ok(())
        })
        .unwrap();
        let fake = Fake::default();
        let mut shape = None;
        let posts = |f: &Fake| f.written("studio_rows").into_iter().filter(|r| r["id"] == "posts").collect::<Vec<_>>();
        round(&fake, &db, dir.path(), &mut shape, None, false).unwrap();
        let sent = posts(&fake);
        assert_eq!(sent.len(), 1);
        let items = sent[0]["data"]["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "archived posts stay on the Mac");
        assert_eq!(items[0]["title"], "Lima light");
        assert_eq!(items[0]["scheduledAt"], "2026-11-20");
        round(&fake, &db, dir.path(), &mut shape, None, false).unwrap();
        assert_eq!(posts(&fake).len(), 1, "unchanged: not sent again");
    }

    #[test]
    fn names_convert_both_ways() {
        assert_eq!(camel("shoot_day_id"), "shootDayId");
        assert_eq!(snake("shootDayId"), "shoot_day_id");
        assert_eq!(urlencode("a b/c"), "a%20b%2Fc");
    }
}
