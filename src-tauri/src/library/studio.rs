//! Studio: planning videos and posts. Saved inspiration, ideas, pillars and
//! families, pieces with their brief, shoot days, brand jobs and reviews.
//!
//! The lists are plain rows: the page owns their shape (camelCase JSON) and
//! this module checks every column against a fixed list. The work that touches
//! disk or the network lives here too: the Studio folder and its pieces,
//! link previews, importing saves, trends.
//!
//! Folder rule: the app makes Studio's folders and never renames one once it
//! exists, so CapCut keeps finding the clips inside. Each folder carries a
//! hidden `.cba.json` with its id, so a folder moved in Finder is found again.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::types::ValueRef;
use rusqlite::{params, OptionalExtension, ToSql};
use serde::Serialize;
use serde_json::{json, Map, Value};

use super::db::Db;
use super::{new_id, now_ms, settings, Error, Result};

pub type Row = Map<String, Value>;

struct Table {
    /// The name the page uses.
    short: &'static str,
    name: &'static str,
    /// Columns the page may write (snake_case). id and the times are the app's.
    cols: &'static [&'static str],
    order: &'static str,
}

const TABLES: &[Table] = &[
    Table { short: "pillars", name: "studio_pillars", cols: &["name", "position", "folder"], order: "position, created_ms" },
    Table {
        short: "families",
        name: "studio_families",
        cols: &["pillar_id", "kind", "name", "code", "client", "folder", "archived"],
        order: "kind = 'singles', created_ms",
    },
    Table {
        short: "ideas",
        name: "studio_ideas",
        cols: &[
            "title", "hook", "format", "pillar_id", "family_id", "platforms", "status", "score_hook", "score_send", "score_fit", "score_ease",
            "notes", "source", "deadline", "piece_id",
        ],
        order: "created_ms DESC",
    },
    Table {
        short: "pieces",
        name: "studio_pieces",
        cols: &[
            "idea_id", "pillar_id", "family_id", "title", "episode", "code", "format", "platforms", "stage", "parked", "waiting_brand", "folder",
            "brief", "shoot_day_id", "planned_date", "is_paid", "brand_job_id", "disclosure", "posts", "notes",
        ],
        order: "created_ms DESC",
    },
    Table {
        short: "saves",
        name: "studio_saves",
        cols: &[
            "kind", "platform", "url", "url_key", "title", "author", "file_path", "thumb", "why", "chips", "tags", "auto_labels", "ocr_text",
            "transcript", "status", "pillar_id", "captured_via", "analysed_ms", "link_ok", "checked_ms", "resurfaced_ms", "resurface_count",
            "topic", "board_id", "transcription_state", "transcription_error", "transcript_segments", "transcript_language",
        ],
        order: "created_ms DESC",
    },
    Table { short: "boards", name: "studio_boards", cols: &["title", "notes", "client", "pillar_id", "family_id"], order: "updated_ms DESC" },
    Table { short: "shootDays", name: "studio_shoot_days", cols: &["date", "title", "location", "notes"], order: "date, created_ms" },
    Table {
        short: "brandJobs",
        name: "studio_brand_jobs",
        cols: &[
            "client", "campaign", "family_id", "brief", "deliverables", "review_date", "live_date", "revisions_allowed", "revisions_used", "rights",
            "rights_end", "exclusivity_end", "paid_ads_end", "fee", "invoice_no", "invoice_status", "paid_date", "notes", "invoice_sent_date",
            "amount", "currency",
        ],
        order: "created_ms DESC",
    },
    Table {
        short: "reviews",
        name: "studio_reviews",
        cols: &["piece_id", "platform", "views", "watch_time", "skip_rate", "sends", "saves", "follows", "learning"],
        order: "created_ms DESC",
    },
    Table { short: "watch", name: "studio_watch", cols: &["platform", "handle", "notes", "last", "checked_ms"], order: "created_ms" },
];

fn table(short: &str) -> Result<&'static Table> {
    TABLES.iter().find(|t| t.short == short).ok_or_else(|| Error::Invalid(format!("Studio has no list called {short}.")))
}

fn camel(snake: &str) -> String {
    let mut out = String::with_capacity(snake.len());
    let mut up = false;
    for ch in snake.chars() {
        if ch == '_' {
            up = true;
        } else if up {
            out.extend(ch.to_uppercase());
            up = false;
        } else {
            out.push(ch);
        }
    }
    out
}

fn snake(camel: &str) -> String {
    let mut out = String::with_capacity(camel.len() + 4);
    for ch in camel.chars() {
        if ch.is_ascii_uppercase() {
            out.push('_');
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

fn to_sql(v: &Value) -> Box<dyn ToSql> {
    match v {
        Value::Null => Box::new(Option::<i64>::None),
        Value::Bool(b) => Box::new(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Box::new(i),
            None => Box::new(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => Box::new(s.clone()),
        other => Box::new(other.to_string()),
    }
}

fn read_row(r: &rusqlite::Row, names: &[String]) -> rusqlite::Result<Row> {
    let mut m = Map::new();
    for (i, n) in names.iter().enumerate() {
        let v = match r.get_ref(i)? {
            ValueRef::Null => Value::Null,
            ValueRef::Integer(x) => json!(x),
            ValueRef::Real(x) => json!(x),
            ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
            ValueRef::Blob(_) => Value::Null,
        };
        m.insert(camel(n), v);
    }
    Ok(m)
}

fn select(c: &rusqlite::Connection, sql: &str, args: &[Box<dyn ToSql>]) -> Result<Vec<Row>> {
    let mut stmt = c.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let refs: Vec<&dyn ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(refs.as_slice(), |r| read_row(r, &names))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Every row of a list, optionally only those whose columns equal `filter`.
pub fn list(db: &Db, short: &str, filter: &Row) -> Result<Vec<Row>> {
    let t = table(short)?;
    let mut sql = format!("SELECT * FROM {}", t.name);
    let mut args: Vec<Box<dyn ToSql>> = Vec::new();
    let mut first = true;
    for (k, v) in filter {
        let col = snake(k);
        if col != "id" && !t.cols.contains(&col.as_str()) {
            return Err(Error::Invalid(format!("Can't filter {short} by {k}.")));
        }
        sql.push_str(if first { " WHERE " } else { " AND " });
        first = false;
        if v.is_null() {
            sql.push_str(&format!("{col} IS NULL"));
        } else {
            sql.push_str(&format!("{col} = ?"));
            args.push(to_sql(v));
        }
    }
    sql.push_str(&format!(" ORDER BY {}", t.order));
    db.read(|c| select(c, &sql, &args))
}

pub fn get(db: &Db, short: &str, id: &str) -> Result<Option<Row>> {
    let t = table(short)?;
    let sql = format!("SELECT * FROM {} WHERE id = ?", t.name);
    Ok(db.read(|c| select(c, &sql, &[Box::new(id.to_owned())]))?.into_iter().next())
}

fn must(db: &Db, short: &str, id: &str) -> Result<Row> {
    get(db, short, id)?.ok_or_else(|| Error::Invalid("That isn't there anymore. It may have been deleted.".into()))
}

/// Adds a row (no id, or an id that isn't there yet) or changes the given
/// columns of an existing one. Returns the row as it is now.
pub fn save(db: &Db, short: &str, id: Option<&str>, values: &Row) -> Result<Row> {
    let t = table(short)?;
    let mut cols = Vec::new();
    let mut args: Vec<Box<dyn ToSql>> = Vec::new();
    for (k, v) in values {
        let col = snake(k);
        if col == "id" || col.ends_with("_ms") && !t.cols.contains(&col.as_str()) {
            continue;
        }
        if !t.cols.contains(&col.as_str()) {
            return Err(Error::Invalid(format!("{short} has no field {k}.")));
        }
        cols.push(col);
        args.push(to_sql(v));
    }
    let now = now_ms();
    let touched = t.name == "studio_ideas";
    let id = match id {
        Some(id) if get(db, short, id)?.is_some() => {
            let mut sets: Vec<String> = cols.iter().map(|c| format!("{c} = ?")).collect();
            sets.push("updated_ms = ?".into());
            args.push(Box::new(now));
            if touched {
                sets.push("touched_ms = ?".into());
                args.push(Box::new(now));
            }
            args.push(Box::new(id.to_owned()));
            let sql = format!("UPDATE {} SET {} WHERE id = ?", t.name, sets.join(", "));
            db.write(|c| {
                let refs: Vec<&dyn ToSql> = args.iter().map(|b| b.as_ref()).collect();
                c.execute(&sql, refs.as_slice())?;
                Ok(())
            })?;
            id.to_owned()
        }
        given => {
            let id = given.map(str::to_owned).unwrap_or_else(new_id);
            cols.insert(0, "id".into());
            args.insert(0, Box::new(id.clone()));
            for c in ["created_ms", "updated_ms"].into_iter().chain(touched.then_some("touched_ms")) {
                cols.push(c.into());
                args.push(Box::new(now));
            }
            let marks = vec!["?"; cols.len()].join(", ");
            let sql = format!("INSERT INTO {} ({}) VALUES ({marks})", t.name, cols.join(", "));
            db.write(|c| {
                let refs: Vec<&dyn ToSql> = args.iter().map(|b| b.as_ref()).collect();
                c.execute(&sql, refs.as_slice())?;
                Ok(())
            })?;
            id
        }
    };
    must(db, short, &id)
}

pub fn delete(db: &Db, short: &str, id: &str, source: &str) -> Result<()> {
    let t = table(short)?;
    // Ideas and projects go to Recently deleted; the other Studio lists are small notes.
    if let Some(kind) = super::trash::kind_for_table(t.name) {
        return super::trash::delete(db, kind, id, source);
    }
    db.write(|c| {
        c.execute(&format!("DELETE FROM {} WHERE id = ?", t.name), [id])?;
        Ok(())
    })
}

/// Links between two things: a save and the idea it sparked, or a clip from
/// the library and the piece it belongs to.
pub fn link(db: &Db, kind: &str, a: &str, b: &str, on: bool) -> Result<()> {
    db.write(|c| {
        match (kind, on) {
            ("saveIdea", true) => c.execute("INSERT OR IGNORE INTO studio_save_ideas (save_id, idea_id) VALUES (?1, ?2)", [a, b])?,
            ("saveIdea", false) => c.execute("DELETE FROM studio_save_ideas WHERE save_id = ?1 AND idea_id = ?2", [a, b])?,
            ("pieceMedia", true) => c.execute(
                "INSERT OR IGNORE INTO studio_piece_media (piece_id, photo_id, position, added_ms)
                 VALUES (?1, ?2, (SELECT COALESCE(MAX(position), 0) + 1 FROM studio_piece_media WHERE piece_id = ?1), ?3)",
                params![a, b, now_ms()],
            )?,
            ("pieceMedia", false) => c.execute("DELETE FROM studio_piece_media WHERE piece_id = ?1 AND photo_id = ?2", [a, b])?,
            _ => return Err(Error::Invalid(format!("unknown link {kind}"))),
        };
        Ok(())
    })
}

/// The ids linked to `id`: `side` "a" gives the b's of a given a, and the other way round.
pub fn linked(db: &Db, kind: &str, side: &str, id: &str) -> Result<Vec<String>> {
    let sql = match (kind, side) {
        ("saveIdea", "a") => "SELECT idea_id FROM studio_save_ideas WHERE save_id = ?1",
        ("saveIdea", _) => "SELECT save_id FROM studio_save_ideas WHERE idea_id = ?1",
        ("pieceMedia", "a") => "SELECT photo_id FROM studio_piece_media WHERE piece_id = ?1 ORDER BY position",
        ("pieceMedia", _) => "SELECT piece_id FROM studio_piece_media WHERE photo_id = ?1",
        _ => return Err(Error::Invalid(format!("unknown link {kind}"))),
    };
    db.read(|c| {
        let mut stmt = c.prepare(sql)?;
        let ids = stmt.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(ids)
    })
}

// ------------------------------------------------------------------ folders

fn setting(db: &Db, key: &str) -> Option<String> {
    settings::get(db, key).ok().flatten().map(|v| v.trim().trim_matches('"').to_owned()).filter(|v| !v.is_empty())
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"))
}

/// The Studio folder: Settings › Studio, or Movies/STUDIO.
pub fn root(db: &Db) -> PathBuf {
    setting(db, "studio.root").map(PathBuf::from).unwrap_or_else(|| home().join("Movies").join("STUDIO"))
}

pub const INBOX: &str = "00_INBOX";
pub const INSPIRATION: &str = "80_INSPIRATION";
pub const DROP: &str = "81_INSPO_DROP";
pub const LIBRARY: &str = "90_LIBRARY";
pub const ARCHIVE: &str = "99_ARCHIVE";
pub const PIECE_DIRS: &[&str] = &["00_PLAN", "01_FOOTAGE/_INGEST", "01_FOOTAGE/A-ROLL", "01_FOOTAGE/B-ROLL", "02_AUDIO", "03_GRAPHICS", "04_EXPORTS", "05_POSTED"];

const ABOUT: &str = "STUDIO — made by Captured by Andy\n\n\
00_INBOX          new footage that isn't in a piece yet\n\
01_… 02_… 03_…    your pillars; inside each, families (a series or a client campaign) and their pieces\n\
80_INSPIRATION    screenshots and recordings you dropped into Inspire\n\
81_INSPO_DROP     put screenshots, screen recordings or saved links here: they appear in Inspire by themselves\n\
90_LIBRARY        B-roll, music and sound effects, brand kits, templates\n\
99_ARCHIVE        finished families\n\n\
Every piece has the same folders: 00_PLAN, 01_FOOTAGE (_INGEST, A-ROLL, B-ROLL), 02_AUDIO, 03_GRAPHICS, 04_EXPORTS, 05_POSTED.\n\
Don't rename a piece's folder once its clips are in CapCut: CapCut finds clips by their full path.\n";

/// Makes the Studio folder and its fixed parts (once; existing ones are left alone).
pub fn ensure_root(db: &Db) -> Result<PathBuf> {
    let root = root(db);
    for dir in [INBOX, INSPIRATION, DROP, ARCHIVE, "90_LIBRARY/BROLL", "90_LIBRARY/MUSIC-SFX", "90_LIBRARY/BRAND-KITS", "90_LIBRARY/TEMPLATES"] {
        std::fs::create_dir_all(root.join(dir))?;
    }
    let about = root.join("ABOUT THIS FOLDER.txt");
    if !about.exists() {
        std::fs::write(about, ABOUT)?;
    }
    Ok(root)
}

/// Lowercase ASCII with hyphens: "Crème brûlée, 3 ways!" -> "creme-brulee-3-ways".
pub fn slug(text: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for ch in text.chars().flat_map(fold) {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    let out = out.trim_end_matches('-');
    let cut: String = out.chars().take(40).collect();
    let cut = cut.trim_end_matches('-').to_owned();
    if cut.is_empty() { "untitled".into() } else { cut }
}

/// The same as `slug`, in capitals: "Hair care" -> "HAIR-CARE".
pub fn label(text: &str) -> String {
    slug(text).to_ascii_uppercase()
}

fn fold(ch: char) -> Vec<char> {
    let s = match ch {
        'à' | 'á' | 'â' | 'ä' | 'ã' | 'å' | 'À' | 'Á' | 'Â' | 'Ä' | 'Ã' | 'Å' => "a",
        'ç' | 'Ç' => "c",
        'è' | 'é' | 'ê' | 'ë' | 'È' | 'É' | 'Ê' | 'Ë' => "e",
        'ì' | 'í' | 'î' | 'ï' | 'Ì' | 'Í' | 'Î' | 'Ï' => "i",
        'ñ' | 'Ñ' => "n",
        'ò' | 'ó' | 'ô' | 'ö' | 'õ' | 'ø' | 'Ò' | 'Ó' | 'Ô' | 'Ö' | 'Õ' | 'Ø' => "o",
        'ù' | 'ú' | 'û' | 'ü' | 'Ù' | 'Ú' | 'Û' | 'Ü' => "u",
        'ý' | 'ÿ' | 'Ý' => "y",
        'œ' | 'Œ' => "oe",
        'æ' | 'Æ' => "ae",
        'ß' => "ss",
        '&' => " and ",
        _ => return vec![ch],
    };
    s.chars().collect()
}

fn mark(dir: &Path, kind: &str, id: &str) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(".cba.json"), json!({ "app": "captured-by-andy", "kind": kind, "id": id }).to_string())?;
    Ok(())
}

fn text_of(row: &Row, key: &str) -> String {
    row.get(key).and_then(Value::as_str).unwrap_or("").to_owned()
}

fn int_of(row: &Row, key: &str) -> Option<i64> {
    row.get(key).and_then(Value::as_i64)
}

fn set_cols(db: &Db, table: &str, id: &str, sets: &[(&str, Box<dyn ToSql>)]) -> Result<()> {
    let sql = format!(
        "UPDATE {table} SET {}, updated_ms = ? WHERE id = ?",
        sets.iter().map(|(c, _)| format!("{c} = ?")).collect::<Vec<_>>().join(", ")
    );
    db.write(|c| {
        let mut refs: Vec<&dyn ToSql> = sets.iter().map(|(_, v)| v.as_ref()).collect();
        let now = now_ms();
        refs.push(&now);
        refs.push(&id);
        c.execute(&sql, refs.as_slice())?;
        Ok(())
    })
}

/// The pillar's folder, made (and named) the first time it's needed.
pub fn pillar_dir(db: &Db, id: &str) -> Result<PathBuf> {
    let root = ensure_root(db)?;
    let p = must(db, "pillars", id)?;
    let mut folder = text_of(&p, "folder");
    if folder.is_empty() {
        let taken: HashSet<String> = list(db, "pillars", &Row::new())?.iter().map(|r| text_of(r, "folder")).collect();
        let mut n = int_of(&p, "position").unwrap_or(0).max(0) + 1;
        loop {
            let name = format!("{n:02}_{}", label(&text_of(&p, "name")));
            if !taken.contains(&name) && !root.join(&name).exists() || n > 98 {
                folder = name;
                break;
            }
            n += 1;
        }
        set_cols(db, "studio_pillars", id, &[("folder", Box::new(folder.clone()))])?;
    }
    let dir = root.join(&folder);
    if !dir.join(".cba.json").exists() {
        mark(&dir, "pillar", id)?;
    }
    Ok(dir)
}

/// The family's folder inside its pillar: S01_NAME for a series, S00_SINGLES,
/// or CLIENT_2026-10_CAMPAIGN (with _DOCS) for a client campaign.
pub fn family_dir(db: &Db, id: &str) -> Result<PathBuf> {
    let f = must(db, "families", id)?;
    let pillar = pillar_dir(db, &text_of(&f, "pillarId"))?;
    let mut folder = text_of(&f, "folder");
    if folder.is_empty() {
        let kind = text_of(&f, "kind");
        let mut code = text_of(&f, "code");
        folder = match kind.as_str() {
            "singles" => "S00_SINGLES".into(),
            "campaign" => {
                let client = if text_of(&f, "client").is_empty() { text_of(&f, "name") } else { text_of(&f, "client") };
                if code.is_empty() {
                    code = label(&client).chars().take(12).collect();
                }
                format!("{}_{}_{}", label(&client), chrono::Local::now().format("%Y-%m"), label(&text_of(&f, "name")))
            }
            _ => {
                if code.is_empty() {
                    let n = db.read(|c| {
                        Ok(c.query_row(
                            "SELECT COUNT(*) FROM studio_families WHERE pillar_id = ?1 AND kind = 'series' AND code <> ''",
                            [text_of(&f, "pillarId")],
                            |r| r.get::<_, i64>(0),
                        )?)
                    })?;
                    code = format!("S{:02}", n + 1);
                }
                format!("{code}_{}", label(&text_of(&f, "name")))
            }
        };
        set_cols(db, "studio_families", id, &[("folder", Box::new(folder.clone())), ("code", Box::new(code))])?;
    }
    let dir = pillar.join(&folder);
    if !dir.join(".cba.json").exists() {
        mark(&dir, "family", id)?;
        if text_of(&f, "kind") == "campaign" {
            std::fs::create_dir_all(dir.join("_DOCS"))?;
        }
    }
    Ok(dir)
}

/// The "Singles" family of a pillar, made when first needed.
pub fn singles(db: &Db, pillar_id: &str) -> Result<String> {
    let found: Option<String> = db.read(|c| {
        Ok(c.query_row("SELECT id FROM studio_families WHERE pillar_id = ?1 AND kind = 'singles' LIMIT 1", [pillar_id], |r| r.get(0)).optional()?)
    })?;
    if let Some(id) = found {
        return Ok(id);
    }
    let mut v = Row::new();
    v.insert("pillarId".into(), json!(pillar_id));
    v.insert("kind".into(), json!("singles"));
    v.insert("name".into(), json!("Singles"));
    Ok(text_of(&save(db, "families", None, &v)?, "id"))
}

/// Turns an idea into a piece: picks its family (the pillar's Singles if none),
/// numbers it, and makes its folder. The idea is marked green-lit.
pub fn greenlight(db: &Db, idea_id: &str, family_id: Option<&str>) -> Result<Row> {
    let idea = must(db, "ideas", idea_id)?;
    if let Some(piece) = idea.get("pieceId").and_then(Value::as_str) {
        if let Some(p) = get(db, "pieces", piece)? {
            return Ok(p);
        }
    }
    let family_id = family_id.map(str::to_owned).or_else(|| idea.get("familyId").and_then(Value::as_str).map(str::to_owned));
    let (family_id, pillar_id) = match family_id {
        Some(f) => {
            let fam = must(db, "families", &f)?;
            (f, text_of(&fam, "pillarId"))
        }
        None => {
            let pillar = idea
                .get("pillarId")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| Error::Invalid("Choose a pillar for this idea first.".into()))?;
            (singles(db, &pillar)?, pillar)
        }
    };
    let fam = must(db, "families", &family_id)?;
    family_dir(db, &family_id)?; // names the family and gives it its code
    let fam = must(db, "families", &text_of(&fam, "id"))?;
    let next: i64 = db.read(|c| {
        Ok(c.query_row("SELECT COALESCE(MAX(episode), 0) + 1 FROM studio_pieces WHERE family_id = ?1", [&family_id], |r| r.get(0))?)
    })?;
    let code = match text_of(&fam, "kind").as_str() {
        "singles" => "single".to_owned(),
        _ => format!("{}-{next:02}", text_of(&fam, "code")),
    };
    let mut brief = json!({});
    let hook = text_of(&idea, "hook");
    if !hook.is_empty() {
        brief = json!({ "hooks": [{ "id": new_id(), "spoken": hook, "text": "", "frame": "", "type": "", "chosen": true }] });
    }
    let mut v = Row::new();
    v.insert("ideaId".into(), json!(idea_id));
    v.insert("pillarId".into(), json!(pillar_id));
    v.insert("familyId".into(), json!(family_id));
    v.insert("title".into(), json!(text_of(&idea, "title")));
    v.insert("episode".into(), json!(next));
    v.insert("code".into(), json!(code));
    v.insert("format".into(), json!(text_of(&idea, "format")));
    v.insert("platforms".into(), json!(text_of(&idea, "platforms")));
    v.insert("brief".into(), json!(brief.to_string()));
    let piece = save(db, "pieces", None, &v)?;
    let piece_id = text_of(&piece, "id");
    ensure_piece_folder(db, &piece_id)?;
    set_cols(db, "studio_ideas", idea_id, &[("status", Box::new("greenlit")), ("piece_id", Box::new(piece_id.clone()))])?;
    for (save_id,) in linked(db, "saveIdea", "b", idea_id)?.into_iter().map(|s| (s,)) {
        let _ = save_id; // the saves stay linked to the idea, which links to the piece
    }
    must(db, "pieces", &piece_id)
}

/// Looks for a folder with this id's `.cba.json` under the Studio folder.
fn find_marked(root: &Path, id: &str, depth: usize) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() || p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('.')) {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(p.join(".cba.json")) {
            if serde_json::from_str::<Value>(&text).ok().and_then(|v| v.get("id").and_then(Value::as_str).map(|s| s == id)).unwrap_or(false) {
                return Some(p);
            }
        }
        if depth > 0 {
            if let Some(found) = find_marked(&p, id, depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

/// The piece's folder: where it was, found again if it was moved in Finder,
/// or made fresh (with every subfolder) the first time.
pub fn ensure_piece_folder(db: &Db, id: &str) -> Result<PathBuf> {
    let p = must(db, "pieces", id)?;
    let known = text_of(&p, "folder");
    if !known.is_empty() && Path::new(&known).join(".cba.json").exists() {
        let dir = PathBuf::from(&known);
        for sub in PIECE_DIRS {
            std::fs::create_dir_all(dir.join(sub))?;
        }
        return Ok(dir);
    }
    let root = ensure_root(db)?;
    if !known.is_empty() {
        if let Some(found) = find_marked(&root, id, 4) {
            set_cols(db, "studio_pieces", id, &[("folder", Box::new(found.to_string_lossy().into_owned()))])?;
            return Ok(found);
        }
    }
    let family = text_of(&p, "familyId");
    let parent = if family.is_empty() { root.join(INBOX) } else { family_dir(db, &family)? };
    let date = chrono::Local::now().format("%Y-%m-%d");
    let base = format!("{date}_{}_{}", text_of(&p, "code").to_ascii_uppercase(), slug(&text_of(&p, "title")));
    let mut dir = parent.join(&base);
    let mut n = 2;
    while dir.exists() {
        dir = parent.join(format!("{base}-{n}"));
        n += 1;
    }
    mark(&dir, "piece", id)?;
    for sub in PIECE_DIRS {
        std::fs::create_dir_all(dir.join(sub))?;
    }
    std::fs::write(dir.join("00_PLAN").join("README.txt"), format!("{}\n\nThe brief, hooks, shot list and caption live in Captured by Andy › Studio › Write.\n", text_of(&p, "title")))?;
    set_cols(db, "studio_pieces", id, &[("folder", Box::new(dir.to_string_lossy().into_owned()))])?;
    let _ = super::finder::add_tag(&dir, &stage_tag(&text_of(&p, "stage")));
    Ok(dir)
}

pub const STAGES: &[&str] = &["planned", "shot", "editing", "ready", "posted", "reviewed"];

fn stage_tag(stage: &str) -> String {
    let name = match stage {
        "planned" => "Planned",
        "shot" => "Shot",
        "editing" => "In CapCut",
        "ready" => "Ready",
        "posted" => "Posted",
        "reviewed" => "Reviewed",
        other => other,
    };
    format!("Studio · {name}")
}

/// Moves a piece to another stage, and its folder's Finder tag with it.
pub fn set_stage(db: &Db, id: &str, stage: &str) -> Result<Row> {
    if !STAGES.contains(&stage) {
        return Err(Error::Invalid(format!("Unknown stage {stage}.")));
    }
    let p = must(db, "pieces", id)?;
    let old = text_of(&p, "stage");
    set_cols(db, "studio_pieces", id, &[("stage", Box::new(stage.to_owned()))])?;
    let folder = text_of(&p, "folder");
    if !folder.is_empty() && Path::new(&folder).exists() {
        let _ = super::finder::remove_tag(Path::new(&folder), &stage_tag(&old));
        let _ = super::finder::add_tag(Path::new(&folder), &stage_tag(stage));
    }
    must(db, "pieces", id)
}

/// Ideas nobody touched for `days` go to Parked (never deleted).
pub fn park_stale(db: &Db, days: i64) -> Result<usize> {
    let cutoff = now_ms() - days * 86_400_000;
    db.write(|c| {
        Ok(c.execute(
            "UPDATE studio_ideas SET status = 'parked', updated_ms = ?1 WHERE status IN ('inbox', 'keep', 'maybe') AND touched_ms < ?2",
            params![now_ms(), cutoff],
        )?)
    })
}

/// Writes a file the app made (a shoot card, a caption) into a piece's
/// 00_PLAN, or the Studio folder's _CARDS when there's no piece.
pub fn write_plan_file(db: &Db, piece_id: Option<&str>, name: &str, contents: &str) -> Result<PathBuf> {
    let dir = match piece_id {
        Some(id) => ensure_piece_folder(db, id)?.join("00_PLAN"),
        None => ensure_root(db)?.join("_CARDS"),
    };
    std::fs::create_dir_all(&dir)?;
    let safe: String = name.chars().map(|c| if c == '/' || c == ':' { '-' } else { c }).collect();
    let path = dir.join(safe);
    std::fs::write(&path, contents)?;
    Ok(path)
}

/// Keeps the exact file that went online in 05_POSTED (a hard link, so it
/// costs no space when it's on the same disk), and records where it went.
pub fn mark_posted(db: &Db, id: &str, platform: &str, url: &str, file: Option<&str>) -> Result<Row> {
    let p = must(db, "pieces", id)?;
    let mut kept = String::new();
    if let Some(src) = file.filter(|f| !f.is_empty()) {
        let src = Path::new(src);
        if src.is_file() {
            let dir = ensure_piece_folder(db, id)?.join("05_POSTED");
            std::fs::create_dir_all(&dir)?;
            let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("mp4");
            let mut dest = dir.join(format!("{}_{platform}_{}.{ext}", chrono::Local::now().format("%Y-%m-%d"), text_of(&p, "code")));
            let mut n = 2;
            while dest.exists() {
                dest = dir.join(format!("{}_{platform}_{}-{n}.{ext}", chrono::Local::now().format("%Y-%m-%d"), text_of(&p, "code")));
                n += 1;
            }
            if std::fs::hard_link(src, &dest).is_err() {
                std::fs::copy(src, &dest)?;
            }
            kept = dest.to_string_lossy().into_owned();
        }
    }
    let mut posts: Vec<Value> = serde_json::from_str(&text_of(&p, "posts")).unwrap_or_default();
    posts.push(json!({ "platform": platform, "url": url, "at": chrono::Local::now().to_rfc3339(), "file": kept }));
    set_cols(db, "studio_pieces", id, &[("posts", Box::new(Value::Array(posts).to_string()))])?;
    if !matches!(text_of(&p, "stage").as_str(), "posted" | "reviewed") {
        set_stage(db, id, "posted")?;
    }
    must(db, "pieces", id)
}

// ------------------------------------------------------------------ saves

#[derive(Debug, Clone, PartialEq)]
pub struct CleanLink {
    pub url: String,
    pub key: String,
    pub platform: &'static str,
}

/// Tidies a link for keeping and spotting doubles: no tracking bits, no
/// "www.", TikTok/Instagram/YouTube recognised.
pub fn clean_link(raw: &str) -> Option<CleanLink> {
    let raw = raw.trim().trim_matches(|c| c == '<' || c == '>' || c == '"');
    let with_scheme = if raw.starts_with("http://") || raw.starts_with("https://") { raw.to_owned() } else { format!("https://{raw}") };
    let (scheme_rest, fragment_free) = (with_scheme.split('#').next().unwrap_or(""), ());
    let _ = fragment_free;
    let rest = scheme_rest.split_once("://").map(|(_, r)| r)?;
    let (host_port, path_query) = rest.split_once('/').map(|(h, p)| (h, format!("/{p}"))).unwrap_or((rest, "/".into()));
    let host = host_port.split(':').next()?.to_ascii_lowercase();
    if !host.contains('.') || host.contains(' ') {
        return None;
    }
    let host = host.trim_start_matches("www.").trim_start_matches("m.").to_owned();
    let (path, query) = path_query.split_once('?').map(|(p, q)| (p.to_owned(), q.to_owned())).unwrap_or((path_query.clone(), String::new()));
    const DROP: &[&str] = &["igsh", "igshid", "si", "feature", "is_from_webapp", "sender_device", "share_app_id", "share_link_id", "_r", "_t", "fbclid", "gclid", "ref"];
    let kept: Vec<&str> = query
        .split('&')
        .filter(|kv| !kv.is_empty())
        .filter(|kv| {
            let k = kv.split('=').next().unwrap_or("");
            !DROP.contains(&k) && !k.starts_with("utm_")
        })
        .collect();
    let platform = if host.ends_with("tiktok.com") || host.ends_with("tiktokv.com") {
        "tiktok"
    } else if host.ends_with("instagram.com") {
        "instagram"
    } else if host.ends_with("youtube.com") || host == "youtu.be" {
        "youtube"
    } else if host.ends_with("pinterest.com") || host == "pin.it" {
        "pinterest"
    } else if host.ends_with("vimeo.com") {
        "vimeo"
    } else {
        "web"
    };
    let path = path.trim_end_matches('/').to_owned();
    let path = if path.is_empty() { "/".to_owned() } else { path };
    let query = if kept.is_empty() { String::new() } else { format!("?{}", kept.join("&")) };
    // Each platform's own form of its links: TikTok's preview service, for one,
    // only answers for www.tiktok.com.
    let canonical = match platform {
        "tiktok" if host == "tiktok.com" => "www.tiktok.com".to_owned(),
        "instagram" if host == "instagram.com" => "www.instagram.com".to_owned(),
        "youtube" if host == "youtube.com" => "www.youtube.com".to_owned(),
        "web" => host_port.to_ascii_lowercase().trim_start_matches("www.").to_owned(),
        _ => host.clone(),
    };
    let url = format!("https://{canonical}{path}{query}");
    // The key ignores what doesn't change the post: YouTube keeps its video id.
    let key = match platform {
        "youtube" if host == "youtu.be" => format!("youtube:{}", path.trim_start_matches('/')),
        "youtube" if path.starts_with("/shorts/") => format!("youtube:{}", path.trim_start_matches("/shorts/")),
        "youtube" => query
            .trim_start_matches('?')
            .split('&')
            .find_map(|kv| kv.strip_prefix("v="))
            .map(|v| format!("youtube:{v}"))
            .unwrap_or_else(|| format!("{host}{path}")),
        "instagram" => {
            let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
            match parts.as_slice() {
                [kind, code, ..] if ["p", "reel", "reels", "tv"].contains(kind) => format!("instagram:{code}"),
                [_, kind, code, ..] if ["p", "reel"].contains(kind) => format!("instagram:{code}"),
                _ => format!("{host}{path}"),
            }
        }
        "tiktok" => {
            let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
            match parts.iter().position(|p| *p == "video") {
                Some(i) if i + 1 < parts.len() => format!("tiktok:{}", parts[i + 1]),
                _ => format!("{host}{path}"),
            }
        }
        _ => format!("{host}{path}{query}"),
    };
    Some(CleanLink { url, key, platform })
}

/// Percent-encodes a value for a query string.
pub fn encode(value: &str) -> String {
    let mut out = String::new();
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

const AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

/// A GET with macOS's own curl: short timeouts, follows redirects.
pub fn fetch(url: &str, seconds: u32) -> Result<String> {
    let out = Command::new("/usr/bin/curl")
        .args(["-sSL", "--compressed", "--max-time", &seconds.to_string(), "-A", AGENT, "-H", "Accept-Language: en-GB,en;q=0.9,nl;q=0.8"])
        .arg(url)
        .output()?;
    if !out.status.success() {
        return Err(Error::Invalid(format!("The internet didn't answer ({}).", String::from_utf8_lossy(&out.stderr).trim())));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Where a short link (vm.tiktok.com, pin.it, youtu.be…) really goes.
fn expand(url: &str) -> Option<String> {
    let out = Command::new("/usr/bin/curl")
        .args(["-sIL", "-o", "/dev/null", "-w", "%{url_effective}", "--max-time", "8", "-A", AGENT])
        .arg(url)
        .output()
        .ok()?;
    let to = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (to.starts_with("http") && to != url).then_some(to)
}

fn download(url: &str, dest: &Path) -> Result<()> {
    let tmp = dest.with_extension("part");
    let status = Command::new("/usr/bin/curl")
        .args(["-sSL", "--max-time", "20", "-A", AGENT, "-o"])
        .arg(&tmp)
        .arg(url)
        .status()?;
    if !status.success() || std::fs::metadata(&tmp).map(|m| m.len() < 200).unwrap_or(true) {
        let _ = std::fs::remove_file(&tmp);
        return Err(Error::Invalid("The preview picture couldn't be downloaded.".into()));
    }
    std::fs::rename(&tmp, dest)?;
    Ok(())
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub title: String,
    pub author: String,
    pub thumb_url: String,
}

fn meta_tag(html: &str, prop: &str) -> Option<String> {
    for quote in ['"', '\''] {
        for attr in ["property", "name"] {
            let needle = format!("{attr}={quote}{prop}{quote}");
            let mut from = 0;
            while let Some(at) = html[from..].find(&needle) {
                let at = from + at;
                let start = html[..at].rfind('<')?;
                let end = at + html[at..].find('>')?;
                let tag = &html[start..end];
                for q in ['"', '\''] {
                    let key = format!("content={q}");
                    if let Some(c) = tag.find(&key) {
                        let rest = &tag[c + key.len()..];
                        if let Some(stop) = rest.find(q) {
                            return Some(unescape(&rest[..stop]));
                        }
                    }
                }
                from = end;
            }
        }
    }
    None
}

fn unescape(s: &str) -> String {
    s.replace("&amp;", "&").replace("&quot;", "\"").replace("&apos;", "'").replace("&#39;", "'").replace("&#x27;", "'").replace("&lt;", "<").replace("&gt;", ">")
}

/// Title, author and picture of a post: TikTok and YouTube answer without an
/// account; Instagram and other sites only through their page's own tags.
pub fn preview(link: &CleanLink) -> Preview {
    let oembed = |endpoint: String| -> Option<Preview> {
        let text = fetch(&endpoint, 10).ok()?;
        let v: Value = serde_json::from_str(&text).ok()?;
        Some(Preview {
            title: v.get("title").and_then(Value::as_str).unwrap_or("").to_owned(),
            author: v.get("author_name").and_then(Value::as_str).unwrap_or("").to_owned(),
            thumb_url: v.get("thumbnail_url").and_then(Value::as_str).unwrap_or("").to_owned(),
        })
    };
    let found = match link.platform {
        "tiktok" => oembed(format!("https://www.tiktok.com/oembed?url={}", encode(&link.url))),
        "youtube" => oembed(format!("https://www.youtube.com/oembed?format=json&url={}", encode(&link.url))),
        "vimeo" => oembed(format!("https://vimeo.com/api/oembed.json?url={}", encode(&link.url))),
        _ => None,
    };
    if let Some(p) = found.filter(|p| !p.title.is_empty() || !p.thumb_url.is_empty()) {
        return p;
    }
    let Ok(html) = fetch(&link.url, 10) else { return Preview::default() };
    let head = &html[..html.len().min(400_000)];
    Preview {
        title: meta_tag(head, "og:title").or_else(|| meta_tag(head, "twitter:title")).unwrap_or_default(),
        author: meta_tag(head, "og:site_name").unwrap_or_default(),
        thumb_url: meta_tag(head, "og:image").or_else(|| meta_tag(head, "twitter:image")).unwrap_or_default(),
    }
}

static WEBSHOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// The bundled `webshot` helper (a development run uses the one in the source tree).
pub fn set_webshot_helper(path: PathBuf) {
    let _ = WEBSHOT.set(path);
}

/// A picture of a web page as it opens (desktop width, 4:5, like every save
/// card), into `dest`. False when the page couldn't be shown.
fn screenshot(url: &str, dest: &Path) -> bool {
    let helper = WEBSHOT.get().cloned().unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/helpers/webshot").into());
    if !helper.is_file() {
        return false;
    }
    Command::new(helper)
        .arg(url)
        .arg(dest)
        .args(["--width", "1200", "--height", "1500"])
        .stderr(std::process::Stdio::null())
        .output()
        .is_ok_and(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "done")
}

pub fn thumbs_dir(cache_root: &Path) -> PathBuf {
    cache_root.join("studio")
}

/// A small JPEG for a save, from a picture file or a video frame.
#[cfg(target_os = "macos")]
fn make_thumb(src: &Path, dest: &Path, video: bool) -> Result<()> {
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if video {
        super::media::video_frame(src, dest, 720)?;
    } else {
        let image = super::media::thumbnail(src, 720, false)?;
        super::media::write_jpeg(&image, dest, 0.82)?;
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn make_thumb(src: &Path, dest: &Path, _video: bool) -> Result<()> {
    std::fs::copy(src, dest)?;
    Ok(())
}

fn existing(db: &Db, col: &str, value: &str) -> Result<Option<Row>> {
    let sql = format!("SELECT * FROM studio_saves WHERE {col} = ? LIMIT 1");
    Ok(db.read(|c| select(c, &sql, &[Box::new(value.to_owned())]))?.into_iter().next())
}

/// Saves a link, or returns the save it already is (with `"existing": true`).
/// Asks the platform for a title and picture unless `offline`.
/// The knowledge notes (HEADQUARTERS' growth brain): one Markdown file per
/// creator video, with front-matter (title, creator, url, tags, kind) and a
/// "## The idea" section. Folder in iCloud Drive, read only.
pub fn knowledge_dir() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join("Library/Mobile Documents/com~apple~CloudDocs/*SOCIALS/PERSONAL/KNOWLEDGE")
}

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeReport {
    /// Notes with kind: knowledge found in the folder.
    pub notes: usize,
    pub added: usize,
    pub updated: usize,
    /// "file: why" for notes that couldn't be used (no url…).
    pub skipped: Vec<String>,
    /// Saves added now, so their previews can be fetched afterwards.
    pub new_ids: Vec<String>,
}

#[derive(Debug, Default, PartialEq)]
struct Note {
    title: String,
    creator: String,
    url: String,
    tags: Vec<String>,
    kind: String,
    idea: String,
}

/// Front-matter fields and the first paragraph of "## The idea" (plain text, at most ~500 characters).
fn parse_note(text: &str) -> Note {
    let mut n = Note::default();
    let mut lines = text.lines();
    if lines.next().map(str::trim) == Some("---") {
        for l in lines.by_ref() {
            if l.trim() == "---" {
                break;
            }
            let Some((k, v)) = l.split_once(':') else { continue };
            let v = v.trim().trim_matches(|c| c == '\'' || c == '"').to_owned();
            match k.trim() {
                "title" => n.title = v,
                "creator" => n.creator = v,
                "url" => n.url = v,
                "kind" => n.kind = v,
                "tags" => n.tags = v.trim_matches(|c| c == '[' || c == ']').split(',').map(|t| t.trim().trim_matches(|c| c == '\'' || c == '"').to_owned()).filter(|t| !t.is_empty()).collect(),
                _ => {}
            }
        }
    }
    // "## The idea", else the note's first section: its first paragraph.
    let body: Vec<&str> = lines.collect();
    let first_para = |want: Option<&str>| -> Vec<&str> {
        let mut inside = false;
        let mut para: Vec<&str> = Vec::new();
        for l in &body {
            if let Some(h) = l.strip_prefix("## ") {
                if inside {
                    break;
                }
                inside = want.is_none_or(|w| h.trim().eq_ignore_ascii_case(w));
                continue;
            }
            if !inside {
                continue;
            }
            if l.trim().is_empty() {
                if !para.is_empty() {
                    break;
                }
                continue;
            }
            para.push(l.trim());
        }
        para
    };
    let mut para = first_para(Some("the idea"));
    if para.is_empty() {
        para = first_para(None);
    }
    let mut idea = para.join(" ").replace("**", "").replace('`', "");
    if idea.chars().count() > 500 {
        let cut: String = idea.chars().take(500).collect();
        idea = format!("{}…", cut.rsplit_once(' ').map(|(a, _)| a).unwrap_or(&cut));
    }
    n.idea = idea;
    n
}

/// Reads every knowledge note into Inspire as a save, keyed on the cleaned
/// link so a re-import (or a link already saved by hand) never doubles. New
/// ones go to the Library as video inspiration; on an existing save only empty
/// fields are filled and tags are added, so Andy's own words are never replaced.
pub fn import_knowledge(db: &Db, cache_root: &Path, dir: &Path) -> Result<KnowledgeReport> {
    let mut r = KnowledgeReport::default();
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(r) };
    let mut files: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "md")).collect();
    files.sort();
    for f in files {
        let name = f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let Ok(text) = std::fs::read_to_string(&f) else {
            r.skipped.push(format!("{name}: couldn't be read"));
            continue;
        };
        let n = parse_note(&text);
        if n.kind != "knowledge" {
            continue;
        }
        r.notes += 1;
        if n.url.is_empty() {
            r.skipped.push(format!("{name}: no url"));
            continue;
        }
        let row = match add_link(db, cache_root, &n.url, "knowledge", true) {
            Ok(row) => row,
            Err(e) => {
                r.skipped.push(format!("{name}: {e}"));
                continue;
            }
        };
        let id = text_of(&row, "id");
        let existed = row.get("existing").and_then(Value::as_bool).unwrap_or(false);
        let empty = |k: &str| text_of(&row, k).trim().is_empty();
        let mut v = Row::new();
        if empty("title") && !n.title.is_empty() {
            v.insert("title".into(), json!(n.title));
        }
        if empty("author") && !n.creator.is_empty() {
            v.insert("author".into(), json!(n.creator));
        }
        if empty("why") && !n.idea.is_empty() {
            v.insert("why".into(), json!(n.idea));
        }
        if empty("topic") {
            v.insert("topic".into(), json!("video"));
        }
        let mut tags: Vec<String> = text_of(&row, "tags").split(',').map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()).collect();
        let before = tags.len();
        for t in &n.tags {
            if !tags.iter().any(|x| x.eq_ignore_ascii_case(t)) {
                tags.push(t.clone());
            }
        }
        if tags.len() != before {
            v.insert("tags".into(), json!(tags.join(", ")));
        }
        if text_of(&row, "status") == "inbox" {
            v.insert("status".into(), json!("library"));
        }
        if !v.is_empty() {
            save(db, "saves", Some(&id), &v)?;
        }
        if existed {
            r.updated += 1;
        } else {
            r.added += 1;
            r.new_ids.push(id);
        }
    }
    Ok(r)
}

pub fn add_link(db: &Db, cache_root: &Path, raw: &str, via: &str, offline: bool) -> Result<Row> {
    let mut link = clean_link(raw).ok_or_else(|| Error::Invalid("That doesn't look like a link.".into()))?;
    if !offline {
        // Short links say nothing until they're followed.
        let short = link.url.contains("vm.tiktok.com") || link.url.contains("vt.tiktok.com") || link.url.contains("tiktok.com/t/") || link.url.contains("pin.it/");
        if short {
            if let Some(to) = expand(&link.url).and_then(|u| clean_link(&u)) {
                link = to;
            }
        }
    }
    if let Some(mut row) = existing(db, "url_key", &link.key)? {
        row.insert("existing".into(), json!(true));
        return Ok(row);
    }
    let mut v = Row::new();
    v.insert("kind".into(), json!("link"));
    v.insert("platform".into(), json!(link.platform));
    v.insert("url".into(), json!(link.url));
    v.insert("urlKey".into(), json!(link.key));
    v.insert("capturedVia".into(), json!(via));
    // Posts from video apps are inspiration for videos; a website's type is picked.
    if matches!(link.platform, "tiktok" | "youtube" | "instagram" | "vimeo") {
        v.insert("topic".into(), json!("video"));
    }
    let row = save(db, "saves", None, &v)?;
    if offline {
        return Ok(row);
    }
    refresh_preview(db, cache_root, &text_of(&row, "id"))
}

/// Fetches (again) the title and picture of a saved link.
pub fn refresh_preview(db: &Db, cache_root: &Path, id: &str) -> Result<Row> {
    let row = must(db, "saves", id)?;
    let Some(link) = clean_link(&text_of(&row, "url")) else { return Ok(row) };
    let p = preview(&link);
    let mut v = Row::new();
    if !p.title.is_empty() && text_of(&row, "title").is_empty() {
        v.insert("title".into(), json!(p.title.chars().take(300).collect::<String>()));
    }
    if !p.author.is_empty() && text_of(&row, "author").is_empty() {
        v.insert("author".into(), json!(p.author));
    }
    // A website (a portfolio, a web app): a picture of the page itself, as it opens.
    let shot = thumbs_dir(cache_root).join(format!("{id}.shot.jpg"));
    let shown = link.platform == "web"
        && std::fs::create_dir_all(thumbs_dir(cache_root)).is_ok()
        && screenshot(&link.url, &shot)
        && make_thumb(&shot, &thumbs_dir(cache_root).join(format!("{id}.jpg")), false).is_ok();
    let _ = std::fs::remove_file(&shot);
    if shown {
        v.insert("thumb".into(), json!(format!("{id}.jpg")));
    } else if !p.thumb_url.is_empty() {
        let name = format!("{id}.jpg");
        let raw = thumbs_dir(cache_root).join(format!("{id}.download"));
        if std::fs::create_dir_all(thumbs_dir(cache_root)).is_ok() && download(&p.thumb_url, &raw).is_ok() {
            let dest = thumbs_dir(cache_root).join(&name);
            if make_thumb(&raw, &dest, false).is_ok() || std::fs::rename(&raw, &dest).is_ok() {
                v.insert("thumb".into(), json!(name));
            }
            let _ = std::fs::remove_file(&raw);
        }
    }
    v.insert("linkOk".into(), json!(shown || !p.title.is_empty() || !p.thumb_url.is_empty()));
    v.insert("checkedMs".into(), json!(now_ms()));
    save(db, "saves", Some(id), &v)
}

pub fn kind_of(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "heic" | "heif" | "webp" | "gif" | "tif" | "tiff" => Some("image"),
        "mov" | "mp4" | "m4v" => Some("video"),
        "webloc" | "url" | "txt" => Some("link"),
        _ => None,
    }
}

/// The links inside a saved-link file (.webloc, .url) or a text file.
pub fn links_in(path: &Path) -> Vec<String> {
    let Ok(bytes) = std::fs::read(path) else { return Vec::new() };
    let text = String::from_utf8_lossy(&bytes);
    let mut found = Vec::new();
    for word in text.split(|c: char| c.is_whitespace() || c == '<' || c == '>' || c == '"' || c == '\'') {
        let w = word.trim_start_matches("URL=").trim_end_matches(|c: char| c == ',' || c == '.' || c == ')');
        if (w.starts_with("http://") || w.starts_with("https://")) && !found.contains(&w.to_owned()) {
            found.push(w.to_owned());
        }
    }
    found
}

/// Saves screenshots, recordings and link files where they are (nothing is
/// copied or moved). Files already saved are skipped.
pub fn add_paths(db: &Db, cache_root: &Path, paths: &[PathBuf], via: &str, offline_links: bool) -> Result<Vec<Row>> {
    let mut added = Vec::new();
    for path in paths {
        let Some(kind) = kind_of(path) else { continue };
        if kind == "link" {
            for l in links_in(path) {
                if let Ok(r) = add_link(db, cache_root, &l, via, offline_links) {
                    if !r.contains_key("existing") {
                        added.push(r);
                    }
                }
            }
            continue;
        }
        let p = path.to_string_lossy().into_owned();
        if existing(db, "file_path", &p)?.is_some() {
            continue;
        }
        let mut v = Row::new();
        v.insert("kind".into(), json!(kind));
        v.insert("platform".into(), json!("file"));
        v.insert("filePath".into(), json!(p));
        v.insert("title".into(), json!(path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_owned()));
        v.insert("capturedVia".into(), json!(via));
        let row = save(db, "saves", None, &v)?;
        let id = text_of(&row, "id");
        let name = format!("{id}.jpg");
        let row = if make_thumb(path, &thumbs_dir(cache_root).join(&name), kind == "video").is_ok() {
            let mut t = Row::new();
            t.insert("thumb".into(), json!(name));
            save(db, "saves", Some(&id), &t)?
        } else {
            row
        };
        added.push(row);
    }
    Ok(added)
}

/// A file dropped onto Inspire: kept in the Studio folder's 80_INSPIRATION.
pub fn add_bytes(db: &Db, cache_root: &Path, name: &str, bytes: &[u8]) -> Result<Row> {
    let dir = ensure_root(db)?.join(INSPIRATION);
    let clean: String = name.chars().map(|c| if c == '/' || c == ':' { '-' } else { c }).collect();
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H%M%S");
    let path = dir.join(format!("{stamp}_{clean}"));
    if kind_of(&path).is_none() {
        return Err(Error::Invalid("Only pictures, videos and saved links can be dropped here.".into()));
    }
    std::fs::write(&path, bytes)?;
    add_paths(db, cache_root, &[path], "drop", false)?.into_iter().next().ok_or_else(|| Error::Invalid("That file couldn't be saved.".into()))
}

/// Picks up what landed in the drop folder (screenshots, AirDropped
/// recordings, saved links) since last time.
pub fn ingest_drop(db: &Db, cache_root: &Path) -> Result<Vec<Row>> {
    let dir = ensure_root(db)?.join(DROP);
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && kind_of(p).is_some() && !p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('.')))
        .collect();
    paths.sort();
    let mut fresh = Vec::new();
    for p in paths {
        let s = p.to_string_lossy().into_owned();
        if kind_of(&p) == Some("link") {
            // A link file is read once: remember it by its path through a note save.
            if existing(db, "file_path", &s)?.is_some() {
                continue;
            }
            let rows = add_paths(db, cache_root, &[p.clone()], "folder", false)?;
            let mut v = Row::new();
            v.insert("kind".into(), json!("note"));
            v.insert("platform".into(), json!("file"));
            v.insert("filePath".into(), json!(s));
            v.insert("status".into(), json!("archived"));
            v.insert("title".into(), json!(format!("Read {} link(s) from this file", rows.len())));
            save(db, "saves", None, &v)?;
            fresh.extend(rows);
        } else if existing(db, "file_path", &s)?.is_none() {
            fresh.extend(add_paths(db, cache_root, &[p], "folder", false)?);
        }
    }
    Ok(fresh)
}

/// Saves not yet looked at by the on-device analysis.
pub fn unanalysed(db: &Db, limit: i64) -> Result<Vec<Row>> {
    db.read(|c| {
        select(
            c,
            "SELECT * FROM studio_saves WHERE analysed_ms IS NULL AND kind <> 'note' ORDER BY created_ms DESC LIMIT ?",
            &[Box::new(limit)],
        )
    })
}

// ------------------------------------------------------------------ imports

/// Reads Instagram's and TikTok's "download your data" files (JSON), or a
/// folder of them, and saves every post link found in them (no previews yet).
pub fn import_export(db: &Db, cache_root: &Path, path: &Path) -> Result<(usize, usize)> {
    let mut files = Vec::new();
    collect_json(path, &mut files, 6);
    let mut links = Vec::new();
    for f in &files {
        let Ok(text) = std::fs::read_to_string(f) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        walk_links(&v, &mut links);
    }
    let (mut added, mut seen) = (0, 0);
    let mut done = HashSet::new();
    for l in links {
        let Some(clean) = clean_link(&l) else { continue };
        if !matches!(clean.platform, "instagram" | "tiktok" | "youtube") || !done.insert(clean.key.clone()) {
            continue;
        }
        let row = add_link(db, cache_root, &l, "import", true)?;
        if row.contains_key("existing") {
            seen += 1;
        } else {
            added += 1;
            let mut v = Row::new();
            v.insert("status".into(), json!("library"));
            save(db, "saves", Some(&text_of(&row, "id")), &v)?;
        }
    }
    Ok((added, seen))
}

fn collect_json(path: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if path.is_file() {
        if path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("json")) {
            out.push(path.to_owned());
        }
        return;
    }
    if depth == 0 {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(path) {
        for e in entries.flatten() {
            let p = e.path();
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_ascii_lowercase();
            // Only the parts that hold saves, likes and favourites.
            if p.is_dir() || name.contains("saved") || name.contains("favorite") || name.contains("favourite") || name.contains("like") || name.contains("user_data") || name.contains("collection") {
                collect_json(&p, out, depth - 1);
            }
        }
    }
}

fn walk_links(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => {
            if (s.contains("instagram.com/") || s.contains("tiktok") || s.contains("youtube.com/") || s.contains("youtu.be/")) && s.starts_with("http") {
                out.push(s.clone());
            }
        }
        Value::Array(a) => a.iter().for_each(|x| walk_links(x, out)),
        Value::Object(o) => o.values().for_each(|x| walk_links(x, out)),
        _ => {}
    }
}

// ------------------------------------------------------------------ trends and search

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trend {
    pub title: String,
    pub traffic: String,
    pub news: Vec<String>,
    pub link: String,
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(a) = rest.find(open) {
        let after = &rest[a + open.len()..];
        let Some(b) = after.find(close) else { break };
        out.push(&after[..b]);
        rest = &after[b + close.len()..];
    }
    out
}

fn cdata(s: &str) -> String {
    unescape(s.trim().trim_start_matches("<![CDATA[").trim_end_matches("]]>").trim())
}

/// What Belgium (or another country) searches today, from Google Trends' feed.
pub fn trends(geo: &str) -> Result<Vec<Trend>> {
    let xml = fetch(&format!("https://trends.google.com/trending/rss?geo={}", encode(geo)), 12)?;
    Ok(between(&xml, "<item>", "</item>")
        .into_iter()
        .map(|item| Trend {
            title: between(item, "<title>", "</title>").first().map(|s| cdata(s)).unwrap_or_default(),
            traffic: between(item, "<ht:approx_traffic>", "</ht:approx_traffic>").first().map(|s| cdata(s)).unwrap_or_default(),
            news: between(item, "<ht:news_item_title>", "</ht:news_item_title>").into_iter().take(2).map(cdata).collect(),
            link: between(item, "<link>", "</link>").first().map(|s| cdata(s)).unwrap_or_default(),
        })
        .filter(|t| !t.title.is_empty())
        .collect())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub url: String,
    pub title: String,
    pub author: String,
    pub thumb_url: String,
}

/// YouTube Shorts for a few words, with the YouTube key from Settings.
pub fn youtube_search(db: &Db, words: &str) -> Result<Vec<Found>> {
    let key = setting(db, "studio.youtubeKey").ok_or_else(|| Error::Invalid("Add a YouTube API key in Settings › Studio first (free at console.cloud.google.com).".into()))?;
    let url = format!(
        "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoDuration=short&maxResults=12&regionCode=BE&q={}&key={}",
        encode(words),
        encode(&key)
    );
    let v: Value = serde_json::from_str(&fetch(&url, 12)?).map_err(|_| Error::Invalid("YouTube sent something unexpected.".into()))?;
    if let Some(msg) = v.pointer("/error/message").and_then(Value::as_str) {
        return Err(Error::Invalid(format!("YouTube: {msg}")));
    }
    Ok(v.get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|it| {
                    let id = it.pointer("/id/videoId")?.as_str()?;
                    Some(Found {
                        url: format!("https://www.youtube.com/shorts/{id}"),
                        title: unescape(it.pointer("/snippet/title").and_then(Value::as_str).unwrap_or("")),
                        author: it.pointer("/snippet/channelTitle").and_then(Value::as_str).unwrap_or("").to_owned(),
                        thumb_url: it.pointer("/snippet/thumbnails/medium/url").and_then(Value::as_str).unwrap_or("").to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// Followers, posts and the latest posts of an account on the watchlist,
/// through Instagram's business discovery (needs your own token in Settings).
pub fn watch_check(db: &Db, id: &str) -> Result<Row> {
    let w = must(db, "watch", id)?;
    let token = setting(db, "studio.igToken").ok_or_else(|| Error::Invalid("Add your Instagram access token and account id in Settings › Studio first.".into()))?;
    let me = setting(db, "studio.igUserId").ok_or_else(|| Error::Invalid("Add your Instagram account id in Settings › Studio first.".into()))?;
    let handle = text_of(&w, "handle").trim_start_matches('@').to_owned();
    let fields = format!(
        "business_discovery.username({handle}){{username,name,followers_count,media_count,media.limit(6){{caption,like_count,comments_count,permalink,media_type,media_url,thumbnail_url,timestamp}}}}"
    );
    let url = format!("https://graph.facebook.com/v21.0/{}?fields={}&access_token={}", encode(&me), encode(&fields), encode(&token));
    let text = fetch(&url, 15)?;
    let v: Value = serde_json::from_str(&text).map_err(|_| Error::Invalid("Instagram sent something unexpected.".into()))?;
    if let Some(msg) = v.pointer("/error/message").and_then(Value::as_str) {
        return Err(Error::Invalid(format!("Instagram: {msg}")));
    }
    let found = v.get("business_discovery").cloned().unwrap_or(Value::Null);
    let mut patch = Row::new();
    patch.insert("last".into(), json!(found.to_string()));
    patch.insert("checkedMs".into(), json!(now_ms()));
    save(db, "watch", Some(id), &patch)
}

// ------------------------------------------------------------------ look-alikes

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Similar {
    pub saves: Vec<String>,
    pub photos: Vec<String>,
}

fn label_set(text: &str) -> HashSet<String> {
    text.split(',').map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()).collect()
}

/// Saves and library photos that share the most of what's in a save's picture.
pub fn similar(db: &Db, id: &str) -> Result<Similar> {
    let me = must(db, "saves", id)?;
    let mine = label_set(&text_of(&me, "autoLabels"));
    if mine.is_empty() {
        return Ok(Similar::default());
    }
    let mut scored: Vec<(f64, String)> = list(db, "saves", &Row::new())?
        .into_iter()
        .filter(|r| text_of(r, "id") != id)
        .filter_map(|r| {
            let theirs = label_set(&text_of(&r, "autoLabels"));
            let shared = mine.intersection(&theirs).count();
            (shared > 0).then(|| (shared as f64 / mine.union(&theirs).count() as f64, text_of(&r, "id")))
        })
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    let words: Vec<String> = mine.into_iter().collect();
    let marks = vec!["?"; words.len()].join(", ");
    let sql = format!(
        "SELECT photo_id FROM photo_labels WHERE label IN ({marks}) AND confidence >= 0.3
         GROUP BY photo_id ORDER BY COUNT(*) DESC, MAX(confidence) DESC LIMIT 18"
    );
    let photos = db.read(|c| {
        let mut stmt = c.prepare(&sql)?;
        let args: Vec<&dyn ToSql> = words.iter().map(|w| w as &dyn ToSql).collect();
        let ids = stmt.query_map(args.as_slice(), |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ids)
    })?;
    Ok(Similar { saves: scored.into_iter().take(12).map(|(_, id)| id).collect(), photos })
}

// ------------------------------------------------------------------ summary

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub pillars: i64,
    pub ideas_inbox: i64,
    pub ideas_kept: i64,
    pub to_film: i64,
    pub in_progress: i64,
    pub ready: i64,
    pub posting_this_week: i64,
    pub reviews_due: i64,
    pub saves_inbox: i64,
    pub brand_alerts: i64,
    pub root: String,
}

/// The numbers for Today and the dashboard's Studio card.
pub fn summary(db: &Db) -> Result<Summary> {
    let today = chrono::Local::now().date_naive();
    let week = (today + chrono::Duration::days(7)).format("%Y-%m-%d").to_string();
    let soon = (today + chrono::Duration::days(14)).format("%Y-%m-%d").to_string();
    let today_s = today.format("%Y-%m-%d").to_string();
    let week_ago = now_ms() - 7 * 86_400_000;
    let mut s = db.read(|c| {
        let n = |sql: &str, args: &[&dyn ToSql]| -> rusqlite::Result<i64> { c.query_row(sql, args, |r| r.get(0)) };
        Ok(Summary {
            pillars: n("SELECT COUNT(*) FROM studio_pillars", &[])?,
            ideas_inbox: n("SELECT COUNT(*) FROM studio_ideas WHERE status = 'inbox'", &[])?,
            ideas_kept: n("SELECT COUNT(*) FROM studio_ideas WHERE status IN ('keep', 'maybe')", &[])?,
            to_film: n("SELECT COUNT(*) FROM studio_pieces WHERE stage = 'planned' AND parked = 0", &[])?,
            in_progress: n("SELECT COUNT(*) FROM studio_pieces WHERE stage IN ('shot', 'editing') AND parked = 0", &[])?,
            ready: n("SELECT COUNT(*) FROM studio_pieces WHERE stage = 'ready'", &[])?,
            posting_this_week: n(
                "SELECT COUNT(*) FROM studio_pieces WHERE planned_date >= ?1 AND planned_date <= ?2 AND stage NOT IN ('posted', 'reviewed')",
                &[&today_s, &week],
            )?,
            reviews_due: n(
                "SELECT COUNT(*) FROM studio_pieces p WHERE p.stage = 'posted' AND p.updated_ms <= ?1
                 AND NOT EXISTS (SELECT 1 FROM studio_reviews r WHERE r.piece_id = p.id)",
                &[&week_ago],
            )?,
            saves_inbox: n("SELECT COUNT(*) FROM studio_saves WHERE status = 'inbox' AND kind <> 'note'", &[])?,
            brand_alerts: n(
                "SELECT COUNT(*) FROM studio_brand_jobs WHERE
                   (rights_end IS NOT NULL AND rights_end <> '' AND rights_end <= ?1 AND rights_end >= ?2)
                OR (exclusivity_end IS NOT NULL AND exclusivity_end <> '' AND exclusivity_end <= ?1 AND exclusivity_end >= ?2)
                OR (paid_ads_end IS NOT NULL AND paid_ads_end <> '' AND paid_ads_end <= ?1 AND paid_ads_end >= ?2)
                OR (invoice_status = 'sent')",
                &[&soon, &today_s],
            )?,
            root: String::new(),
        })
    })?;
    s.root = root(db).to_string_lossy().into_owned();
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("lib.sqlite")).unwrap();
        settings::set(&db, "studio.root", &format!("\"{}\"", dir.path().join("STUDIO").display())).unwrap();
        (dir, db)
    }

    fn row(pairs: &[(&str, Value)]) -> Row {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn names_for_folders() {
        assert_eq!(slug("Crème brûlée, 3 ways!"), "creme-brulee-3-ways");
        assert_eq!(slug("  "), "untitled");
        assert_eq!(label("Hair & care"), "HAIR-AND-CARE");
        assert_eq!(camel("pillar_id"), "pillarId");
        assert_eq!(snake("pillarId"), "pillar_id");
    }

    #[test]
    fn links_are_cleaned_and_keyed() {
        let l = clean_link("https://www.instagram.com/reel/C9xYz123/?igsh=abc&utm_source=ig").unwrap();
        assert_eq!(l.platform, "instagram");
        assert_eq!(l.url, "https://www.instagram.com/reel/C9xYz123");
        assert_eq!(l.key, "instagram:C9xYz123");
        let t = clean_link("https://www.tiktok.com/@someone/video/7412345678901234567?is_from_webapp=1&sender_device=pc").unwrap();
        assert_eq!(t.key, "tiktok:7412345678901234567");
        assert_eq!(t.url, "https://www.tiktok.com/@someone/video/7412345678901234567");
        let y = clean_link("https://youtube.com/shorts/abcDEF123?si=xyz").unwrap();
        assert_eq!(y.key, "youtube:abcDEF123");
        let y2 = clean_link("https://www.youtube.com/watch?v=abcDEF123&feature=share").unwrap();
        assert_eq!(y2.key, "youtube:abcDEF123");
        assert!(clean_link("not a link").is_none());
        assert_eq!(clean_link("example.com/page/").unwrap().url, "https://example.com/page");
        assert_eq!(clean_link("https://vimeo.com/262466894?fl=pl").unwrap().platform, "vimeo");
        assert_eq!(clean_link("https://ligthelm.work/project/x").unwrap().platform, "web");
    }

    #[test]
    fn rows_save_list_and_delete() {
        let (_d, db) = db();
        let p = save(&db, "pillars", None, &row(&[("name", json!("Hair")), ("position", json!(0))])).unwrap();
        assert_eq!(p["name"], json!("Hair"));
        let id = p["id"].as_str().unwrap().to_owned();
        let p2 = save(&db, "pillars", Some(&id), &row(&[("name", json!("Hair care"))])).unwrap();
        assert_eq!(p2["name"], json!("Hair care"));
        assert_eq!(list(&db, "pillars", &Row::new()).unwrap().len(), 1);
        assert!(save(&db, "pillars", None, &row(&[("nope", json!(1))])).is_err());
        delete(&db, "pillars", &id, "menu").unwrap();
        assert!(list(&db, "pillars", &Row::new()).unwrap().is_empty());
    }

    #[test]
    fn greenlight_makes_a_numbered_piece_with_its_folders() {
        let (_d, db) = db();
        let pillar = save(&db, "pillars", None, &row(&[("name", json!("Skin")), ("position", json!(0))])).unwrap();
        let pid = pillar["id"].as_str().unwrap().to_owned();
        let fam = save(&db, "families", None, &row(&[("pillarId", json!(pid)), ("kind", json!("series")), ("name", json!("Three products"))])).unwrap();
        let fid = fam["id"].as_str().unwrap().to_owned();
        let idea = save(&db, "ideas", None, &row(&[("title", json!("Morning routine")), ("hook", json!("I use three products")), ("familyId", json!(fid))])).unwrap();
        let piece = greenlight(&db, idea["id"].as_str().unwrap(), None).unwrap();
        assert_eq!(piece["code"], json!("S01-01"));
        let folder = PathBuf::from(piece["folder"].as_str().unwrap());
        assert!(folder.join("01_FOOTAGE/A-ROLL").is_dir());
        assert!(folder.join("05_POSTED").is_dir());
        assert!(folder.to_string_lossy().contains("01_SKIN/S01_THREE-PRODUCTS/"));
        assert!(folder.file_name().unwrap().to_string_lossy().ends_with("_S01-01_morning-routine"));
        let idea = get(&db, "ideas", idea["id"].as_str().unwrap()).unwrap().unwrap();
        assert_eq!(idea["status"], json!("greenlit"));
        let brief: Value = serde_json::from_str(piece["brief"].as_str().unwrap()).unwrap();
        assert_eq!(brief["hooks"][0]["spoken"], json!("I use three products"));

        // An idea with only a pillar lands in that pillar's Singles.
        let lone = save(&db, "ideas", None, &row(&[("title", json!("One-off")), ("pillarId", json!(pid))])).unwrap();
        let single = greenlight(&db, lone["id"].as_str().unwrap(), None).unwrap();
        assert_eq!(single["code"], json!("single"));
        assert!(single["folder"].as_str().unwrap().contains("/S00_SINGLES/"));

        // A folder moved in Finder is found again by its id.
        let moved = folder.parent().unwrap().join("moved-here");
        std::fs::rename(&folder, &moved).unwrap();
        let again = ensure_piece_folder(&db, piece["id"].as_str().unwrap()).unwrap();
        assert_eq!(again, moved);
    }

    #[test]
    fn stale_ideas_are_parked_not_deleted() {
        let (_d, db) = db();
        let i = save(&db, "ideas", None, &row(&[("title", json!("Old"))])).unwrap();
        db.write(|c| {
            c.execute("UPDATE studio_ideas SET touched_ms = 0", [])?;
            Ok(())
        })
        .unwrap();
        assert_eq!(park_stale(&db, 60).unwrap(), 1);
        assert_eq!(get(&db, "ideas", i["id"].as_str().unwrap()).unwrap().unwrap()["status"], json!("parked"));
    }

    #[test]
    fn exports_give_their_post_links() {
        let mut out = Vec::new();
        let ig: Value = serde_json::from_str(
            r#"{"saved_saved_media":[{"title":"someone","string_map_data":{"Saved on":{"href":"https://www.instagram.com/reel/ABC123/","timestamp":1}}}]}"#,
        )
        .unwrap();
        walk_links(&ig, &mut out);
        let tt: Value = serde_json::from_str(r#"{"Activity":{"Favorite Videos":{"FavoriteVideoList":[{"Date":"2026-01-01","Link":"https://www.tiktokv.com/share/video/7412345678901234567/"}]}}}"#).unwrap();
        walk_links(&tt, &mut out);
        assert_eq!(out.len(), 2);
        assert_eq!(clean_link(&out[0]).unwrap().key, "instagram:ABC123");
        assert_eq!(clean_link(&out[1]).unwrap().key, "tiktok:7412345678901234567");
    }

    #[test]
    fn page_tags_are_read() {
        let html = r#"<head><meta property="og:title" content="A &amp; B"><meta content='https://x/y.jpg' property='og:image'></head>"#;
        assert_eq!(meta_tag(html, "og:title").as_deref(), Some("A & B"));
        assert_eq!(meta_tag(html, "og:image").as_deref(), Some("https://x/y.jpg"));
    }

    /// Goes online: `cargo test --lib studio -- --ignored`.
    #[test]
    #[ignore]
    fn a_real_tiktok_link_gets_its_preview_and_picture() {
        let (dir, db) = db();
        let cache = dir.path().join("cache");
        let row = add_link(&db, &cache, "https://www.tiktok.com/@scout2015/video/6718335390845095173?is_from_webapp=1", "paste", false).unwrap();
        assert_eq!(row["platform"], json!("tiktok"));
        assert!(!row["title"].as_str().unwrap().is_empty(), "{row:?}");
        let thumb = row["thumb"].as_str().expect("a picture");
        assert!(thumbs_dir(&cache).join(thumb).metadata().unwrap().len() > 2000);
        // The same post again is recognised, not saved twice.
        let again = add_link(&db, &cache, "tiktok.com/@scout2015/video/6718335390845095173", "paste", false).unwrap();
        assert_eq!(again["existing"], json!(true));
        let t = trends("BE").unwrap();
        assert!(!t.is_empty());
    }

    #[test]
    fn links_in_files() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.webloc");
        std::fs::write(&f, r#"<plist><dict><key>URL</key><string>https://www.tiktok.com/@a/video/1</string></dict></plist>"#).unwrap();
        assert_eq!(links_in(&f), vec!["https://www.tiktok.com/@a/video/1".to_owned()]);
    }
}
