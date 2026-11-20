//! Recently deleted (NIRMATA, 19 Nov, after 8 posts went missing): deleting a
//! post, album, idea or project moves it here, with everything hanging off it
//! (picture links, album look, saves, project media), for 30 days. Restore puts
//! it back as it was; « Delete for good » or the 30-day limit removes it. Every
//! delete, restore and purge is written to `audit_log` and to app.log with its
//! time and source (menu, keyboard, undo, assistant, sync).
//!
//! The item really leaves its table, so every list, count and the sync behave
//! as before: the sync sends the web its usual tombstone. A restore writes the
//! row back with a fresh `updated_ms`, so an older tombstone can never remove
//! it again, and the sync sends it to the web as a live row.

use base64::Engine;
use rusqlite::types::{Value as Sql, ValueRef};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Map, Value};

use super::db::Db;
use super::{now_ms, Error, Result};

/// How long a deleted item can be restored.
pub const KEEP_MS: i64 = 30 * 24 * 3600 * 1000;

struct Kind {
    kind: &'static str,
    table: &'static str,
    title: &'static str,
    /// Rows that belong to the item and go (by cascade) when it goes.
    children: &'static [(&'static str, &'static str)],
    /// Rows elsewhere that only point at it (ON DELETE SET NULL): relinked on restore.
    relink: &'static [(&'static str, &'static str)],
}

const KINDS: [Kind; 4] = [
    Kind { kind: "post", table: "posts", title: "title", children: &[("post_photos", "post_id")], relink: &[] },
    Kind { kind: "album", table: "albums", title: "name", children: &[("photo_albums", "album_id"), ("album_looks", "album_id")], relink: &[] },
    Kind { kind: "idea", table: "studio_ideas", title: "title", children: &[("studio_save_ideas", "idea_id")], relink: &[("studio_pieces", "idea_id")] },
    Kind {
        kind: "project",
        table: "studio_pieces",
        title: "title",
        children: &[("studio_piece_media", "piece_id"), ("studio_reviews", "piece_id")],
        relink: &[],
    },
];

fn kind_of(kind: &str) -> Result<&'static Kind> {
    KINDS.iter().find(|k| k.kind == kind).ok_or_else(|| Error::Invalid(format!("unknown kind {kind}")))
}

/// The kind kept in the trash for a table, if any (posts → post, …).
pub fn kind_for_table(table: &str) -> Option<&'static str> {
    KINDS.iter().find(|k| k.table == table).map(|k| k.kind)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: i64,
    pub kind: String,
    pub item_id: String,
    pub title: String,
    pub deleted_ms: i64,
    pub source: String,
    /// Pictures (or saves) that come back with it.
    pub linked: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLine {
    pub at_ms: i64,
    pub action: String,
    pub kind: String,
    pub item_id: String,
    pub title: String,
    pub source: String,
}

// ---------------------------------------------------------------- rows as JSON

fn to_json(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(b) => json!({ "$blob": base64::engine::general_purpose::STANDARD.encode(b) }),
    }
}

fn to_sql(v: &Value) -> Sql {
    match v {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(*b as i64),
        Value::Number(n) => n.as_i64().map(Sql::Integer).unwrap_or_else(|| Sql::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => Sql::Text(s.clone()),
        Value::Object(o) if o.contains_key("$blob") => {
            Sql::Blob(base64::engine::general_purpose::STANDARD.decode(o["$blob"].as_str().unwrap_or("")).unwrap_or_default())
        }
        other => Sql::Text(other.to_string()),
    }
}

fn rows(c: &Connection, table: &str, col: &str, id: &str) -> Result<Vec<Value>> {
    let mut stmt = c.prepare(&format!("SELECT * FROM {table} WHERE {col} = ?1"))?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let out = stmt
        .query_map([id], |r| {
            let mut m = Map::new();
            for (i, n) in names.iter().enumerate() {
                m.insert(n.clone(), to_json(r.get_ref(i)?));
            }
            Ok(Value::Object(m))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(out)
}

/// Whether every row this one points at (other than `skip`) still exists.
fn targets_exist(c: &Connection, table: &str, row: &Map<String, Value>, skip: &str) -> Result<bool> {
    let mut stmt = c.prepare(&format!("PRAGMA foreign_key_list({table})"))?;
    let fks: Vec<(String, String, String)> =
        stmt.query_map([], |r| Ok((r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?)))?.collect::<rusqlite::Result<_>>()?;
    for (target, from, to) in fks {
        if from == skip {
            continue;
        }
        let v = row.get(&from).cloned().unwrap_or(Value::Null);
        if v.is_null() {
            continue;
        }
        let there: Option<i64> = c.query_row(&format!("SELECT 1 FROM {target} WHERE {to} = ?1"), [to_sql(&v)], |r| r.get(0)).optional()?;
        if there.is_none() {
            return Ok(false);
        }
    }
    Ok(true)
}

fn insert(c: &Connection, table: &str, row: &Map<String, Value>) -> Result<usize> {
    let cols: Vec<&String> = row.keys().collect();
    let sql = format!(
        "INSERT OR IGNORE INTO {table} ({}) VALUES ({})",
        cols.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "),
        vec!["?"; cols.len()].join(", ")
    );
    Ok(c.execute(&sql, rusqlite::params_from_iter(row.values().map(to_sql)))?)
}

// ---------------------------------------------------------------- the log

fn audit(c: &Connection, action: &str, kind: &str, item_id: &str, title: &str, source: &str) -> Result<()> {
    c.execute(
        "INSERT INTO audit_log (at_ms, action, kind, item_id, title, source) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![now_ms(), action, kind, item_id, title, source],
    )?;
    crate::applog::line(&format!("{action} {kind} « {title} » ({item_id}) · source: {source}"));
    Ok(())
}

// ---------------------------------------------------------------- delete, restore, purge

/// Moves the item and everything hanging off it to the trash, inside the
/// caller's transaction. Returns false when there was nothing to delete.
pub fn discard(c: &Connection, kind: &str, id: &str, source: &str) -> Result<bool> {
    let k = kind_of(kind)?;
    let main = rows(c, k.table, "id", id)?;
    let Some(row) = main.first() else { return Ok(false) };
    let title = row[k.title].as_str().unwrap_or("").to_owned();
    let mut data = Map::new();
    data.insert(k.table.into(), Value::Array(main.clone()));
    for (table, col) in k.children {
        data.insert((*table).into(), Value::Array(rows(c, table, col, id)?));
    }
    let mut relink = Map::new();
    for (table, col) in k.relink {
        let mut stmt = c.prepare(&format!("SELECT id FROM {table} WHERE {col} = ?1"))?;
        let ids: Vec<String> = stmt.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        relink.insert(format!("{table}.{col}"), json!(ids));
    }
    data.insert("$relink".into(), Value::Object(relink));
    c.execute(
        "INSERT INTO trash (kind, item_id, title, deleted_ms, source, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![k.kind, id, title, now_ms(), source, Value::Object(data).to_string()],
    )?;
    c.execute(&format!("DELETE FROM {} WHERE id = ?1", k.table), [id])?;
    audit(c, "delete", k.kind, id, &title, source)?;
    Ok(true)
}

/// For the sync pull, before it writes a live row it got from the web: true
/// when the Mac deleted that item after that web version, so the row must not
/// come back. When the web changed it after the Mac's delete, the newer change
/// wins: the item leaves Recently deleted (logged) and the pull may write it.
pub fn held_back(c: &Connection, kind: &str, id: &str, web_ms: i64) -> Result<bool> {
    let row: Option<(i64, String)> = c
        .query_row(
            "SELECT deleted_ms, title FROM trash WHERE kind = ?1 AND item_id = ?2 ORDER BY deleted_ms DESC LIMIT 1",
            params![kind, id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((deleted, title)) = row else { return Ok(false) };
    if deleted >= web_ms {
        return Ok(true);
    }
    c.execute("DELETE FROM trash WHERE kind = ?1 AND item_id = ?2", params![kind, id])?;
    audit(c, "restore", kind, id, &title, "sync (changed elsewhere after the delete)")?;
    Ok(false)
}

/// Deletes (to the trash) in its own transaction.
pub fn delete(db: &Db, kind: &str, id: &str, source: &str) -> Result<()> {
    db.write(|c| {
        let tx = c.transaction()?;
        discard(&tx, kind, id, source)?;
        tx.commit()?;
        Ok(())
    })
}

/// Puts the item back as it was, with a fresh `updated_ms`. Links to pictures
/// or saves that no longer exist are left out. Returns the item's id.
pub fn restore(db: &Db, trash_id: i64, source: &str) -> Result<String> {
    db.write(|c| {
        let tx = c.transaction()?;
        let (kind, item_id, title, data): (String, String, String, String) = tx
            .query_row("SELECT kind, item_id, title, data FROM trash WHERE id = ?1", [trash_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .optional()?
            .ok_or_else(|| Error::Invalid("This item is no longer in Recently deleted".into()))?;
        let k = kind_of(&kind)?;
        let exists: Option<i64> = tx.query_row(&format!("SELECT 1 FROM {} WHERE id = ?1", k.table), [&item_id], |r| r.get(0)).optional()?;
        if exists.is_some() {
            return Err(Error::Invalid(format!("« {title} » is already back")));
        }
        let data: Value = serde_json::from_str(&data).map_err(|e| Error::Invalid(e.to_string()))?;
        let mut main = data[k.table][0].as_object().cloned().ok_or_else(|| Error::Invalid("nothing saved for this item".into()))?;
        if main.contains_key("updated_ms") {
            main.insert("updated_ms".into(), json!(now_ms()));
        }
        // Its own links (an account, a pillar) may be gone: those become empty, the item still comes back.
        let mut stmt = tx.prepare(&format!("PRAGMA foreign_key_list({})", k.table))?;
        let fks: Vec<(String, String, String)> =
            stmt.query_map([], |r| Ok((r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?)))?.collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        for (target, from, to) in fks {
            if let Some(v) = main.get(&from).cloned().filter(|v| !v.is_null()) {
                let there: Option<i64> = tx.query_row(&format!("SELECT 1 FROM {target} WHERE {to} = ?1"), [to_sql(&v)], |r| r.get(0)).optional()?;
                if there.is_none() {
                    main.insert(from, Value::Null);
                }
            }
        }
        insert(&tx, k.table, &main)?;
        for (table, col) in k.children {
            for row in data[*table].as_array().into_iter().flatten().filter_map(|r| r.as_object()) {
                if targets_exist(&tx, table, row, col)? {
                    insert(&tx, table, row)?;
                }
            }
        }
        for (table, col) in k.relink {
            for id in data["$relink"][format!("{table}.{col}")].as_array().into_iter().flatten().filter_map(|v| v.as_str()) {
                tx.execute(&format!("UPDATE {table} SET {col} = ?1 WHERE id = ?2 AND {col} IS NULL"), params![item_id, id])?;
            }
        }
        tx.execute("DELETE FROM trash WHERE id = ?1", [trash_id])?;
        audit(&tx, "restore", k.kind, &item_id, &title, source)?;
        tx.commit()?;
        Ok(item_id)
    })
}

/// Removes it from Recently deleted for good.
pub fn purge(db: &Db, trash_id: i64, source: &str) -> Result<()> {
    db.write(|c| {
        let tx = c.transaction()?;
        purge_one(&tx, trash_id, source)?;
        tx.commit()?;
        Ok(())
    })
}

fn purge_one(c: &Connection, trash_id: i64, source: &str) -> Result<()> {
    let row: Option<(String, String, String)> =
        c.query_row("SELECT kind, item_id, title FROM trash WHERE id = ?1", [trash_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
    let Some((kind, item_id, title)) = row else { return Ok(()) };
    c.execute("DELETE FROM trash WHERE id = ?1", [trash_id])?;
    audit(c, "purge", &kind, &item_id, &title, source)
}

/// Purges what has been in the trash for more than 30 days. Returns how many.
pub fn purge_expired(db: &Db) -> Result<usize> {
    db.write(|c| {
        let tx = c.transaction()?;
        let old: Vec<i64> = {
            let mut stmt = tx.prepare("SELECT id FROM trash WHERE deleted_ms < ?1")?;
            let ids = stmt.query_map([now_ms() - KEEP_MS], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
            ids
        };
        for id in &old {
            purge_one(&tx, *id, "after 30 days")?;
        }
        tx.commit()?;
        Ok(old.len())
    })
}

// ---------------------------------------------------------------- reading

/// What can be restored, newest first; one kind or all.
pub fn list(db: &Db, kind: Option<&str>) -> Result<Vec<TrashItem>> {
    db.read(|c| {
        let mut stmt = c.prepare(
            "SELECT id, kind, item_id, title, deleted_ms, source, data FROM trash WHERE (?1 IS NULL OR kind = ?1) ORDER BY deleted_ms DESC, id DESC",
        )?;
        let out = stmt
            .query_map([kind], |r| {
                let kind: String = r.get(1)?;
                let data: String = r.get(6)?;
                let linked = KINDS
                    .iter()
                    .find(|k| k.kind == kind)
                    .and_then(|k| k.children.first())
                    .and_then(|(t, _)| serde_json::from_str::<Value>(&data).ok().map(|d| d[*t].as_array().map_or(0, |a| a.len() as i64)))
                    .unwrap_or(0);
                Ok(TrashItem { id: r.get(0)?, kind, item_id: r.get(2)?, title: r.get(3)?, deleted_ms: r.get(4)?, source: r.get(5)?, linked })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(out)
    })
}

/// The latest delete / restore / purge lines.
pub fn audit_lines(db: &Db, limit: i64) -> Result<Vec<AuditLine>> {
    db.read(|c| {
        let mut stmt = c.prepare("SELECT at_ms, action, kind, item_id, title, source FROM audit_log ORDER BY at_ms DESC, id DESC LIMIT ?1")?;
        let out = stmt
            .query_map([limit], |r| Ok(AuditLine { at_ms: r.get(0)?, action: r.get(1)?, kind: r.get(2)?, item_id: r.get(3)?, title: r.get(4)?, source: r.get(5)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(out)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("library.db")).unwrap();
        (dir, db)
    }

    fn photo(db: &Db, id: &str) {
        db.write(|c| {
            c.execute(
                "INSERT INTO photos (id, captured_at, captured_at_source, media_kind, review_state, created_ms, updated_ms) VALUES (?1, '2026-06-13T10:00:00', 'exif', 'image', 'selected', 0, 0)",
                [id],
            )?;
            Ok(())
        })
        .unwrap();
    }

    fn count(db: &Db, sql: &str) -> i64 {
        db.read(|c| Ok(c.query_row(sql, [], |r| r.get(0))?)).unwrap()
    }

    fn post_with_pictures(db: &Db) {
        photo(db, "p1");
        photo(db, "p2");
        db.write(|c| {
            c.execute("INSERT INTO posts (id, title, status, caption, scheduled_at, created_ms, updated_ms) VALUES ('po1', 'FACES · Jun 13', 'ready', 'Faces of the valley', '2026-11-24T19:00', 1, 1)", [])?;
            // p2 first: the order must survive, not the insertion order.
            c.execute("INSERT INTO post_photos (post_id, photo_id, position) VALUES ('po1', 'p1', 1), ('po1', 'p2', 0)", [])?;
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn deleting_a_post_never_hard_deletes_it() {
        let (_d, db) = library();
        post_with_pictures(&db);
        // The UI's only door (delete_post → posts::delete).
        super::super::posts::delete(&db, "po1", "menu").unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM posts"), 0, "gone from the plan");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM trash WHERE kind = 'post' AND item_id = 'po1'"), 1, "but kept in Recently deleted");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM audit_log WHERE action = 'delete' AND item_id = 'po1' AND source = 'menu'"), 1);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM photos"), 2, "pictures untouched");
        let items = list(&db, Some("post")).unwrap();
        assert_eq!((items[0].title.as_str(), items[0].linked), ("FACES · Jun 13", 2));
    }

    #[test]
    fn a_restored_post_comes_back_whole_with_a_fresh_change_time() {
        let (_d, db) = library();
        post_with_pictures(&db);
        delete(&db, "post", "po1", "menu").unwrap();
        let id = list(&db, None).unwrap()[0].id;
        assert_eq!(restore(&db, id, "Recently deleted").unwrap(), "po1");
        let (title, status, caption, updated): (String, String, String, i64) = db
            .read(|c| Ok(c.query_row("SELECT title, status, caption, updated_ms FROM posts WHERE id = 'po1'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?))
            .unwrap();
        assert_eq!((title.as_str(), status.as_str(), caption.as_str()), ("FACES · Jun 13", "ready", "Faces of the valley"));
        assert!(updated > 1, "a fresh updated_ms, so an older deletion elsewhere can't win");
        let (date,): (String,) = db.read(|c| Ok(c.query_row("SELECT scheduled_at FROM posts WHERE id = 'po1'", [], |r| Ok((r.get(0)?,)))?)).unwrap();
        assert_eq!(date, "2026-11-24T19:00", "its date");
        let order: Vec<String> = db
            .read(|c| {
                let mut st = c.prepare("SELECT photo_id FROM post_photos WHERE post_id = 'po1' ORDER BY position")?;
                let v = st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
                Ok(v)
            })
            .unwrap();
        assert_eq!(order, vec!["p2", "p1"], "its pictures, in their order");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM trash"), 0);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM audit_log WHERE action = 'restore'"), 1);
        assert!(restore(&db, id, "x").is_err(), "it can't come back twice");
    }

    #[test]
    fn links_to_pictures_deleted_since_are_left_out() {
        let (_d, db) = library();
        post_with_pictures(&db);
        delete(&db, "post", "po1", "menu").unwrap();
        db.write(|c| { c.execute("DELETE FROM photos WHERE id = 'p2'", [])?; Ok(()) }).unwrap();
        restore(&db, list(&db, None).unwrap()[0].id, "Recently deleted").unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM post_photos"), 1);
    }

    #[test]
    fn an_album_comes_back_with_its_pictures_and_look() {
        let (_d, db) = library();
        photo(&db, "p1");
        db.write(|c| {
            c.execute("INSERT INTO albums (id, name, created_ms, updated_ms) VALUES ('a1', 'FACES', 0, 0)", [])?;
            c.execute("INSERT INTO photo_albums (album_id, photo_id, position, added_ms) VALUES ('a1', 'p1', 0, 0)", [])?;
            c.execute("INSERT INTO album_looks (album_id, strength, adjustments, updated_ms) VALUES ('a1', 0.5, '{\"exposure\":1}', 0)", [])?;
            Ok(())
        })
        .unwrap();
        super::super::albums::delete(&db, "a1", "keyboard").unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM photo_albums"), 0);
        restore(&db, list(&db, Some("album")).unwrap()[0].id, "Recently deleted").unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM photo_albums WHERE album_id = 'a1'"), 1);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM album_looks WHERE album_id = 'a1' AND strength = 0.5"), 1);
    }

    #[test]
    fn a_restored_idea_gets_its_projects_back() {
        let (_d, db) = library();
        db.write(|c| {
            c.execute("INSERT INTO studio_ideas (id, title, touched_ms, created_ms, updated_ms) VALUES ('i1', 'Lima markets', 0, 0, 0)", [])?;
            c.execute("INSERT INTO studio_pieces (id, idea_id, title, created_ms, updated_ms) VALUES ('s1', 'i1', 'Market reel', 0, 0)", [])?;
            Ok(())
        })
        .unwrap();
        super::super::studio::delete(&db, "ideas", "i1", "menu").unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM studio_pieces WHERE idea_id IS NULL"), 1, "the project stays, unlinked");
        restore(&db, list(&db, Some("idea")).unwrap()[0].id, "Recently deleted").unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM studio_pieces WHERE idea_id = 'i1'"), 1, "and is linked again");
    }

    #[test]
    fn a_project_and_its_clips_come_back() {
        let (_d, db) = library();
        photo(&db, "v1");
        db.write(|c| {
            c.execute("INSERT INTO studio_pieces (id, title, created_ms, updated_ms) VALUES ('s1', 'Market reel', 0, 0)", [])?;
            Ok(())
        })
        .unwrap();
        super::super::studio::link(&db, "pieceMedia", "s1", "v1", true).unwrap();
        super::super::studio::delete(&db, "pieces", "s1", "assistant undo").unwrap();
        assert_eq!(list(&db, Some("project")).unwrap()[0].source, "assistant undo");
        restore(&db, list(&db, None).unwrap()[0].id, "Recently deleted").unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM studio_piece_media WHERE piece_id = 's1'"), 1);
    }

    #[test]
    fn other_studio_lists_are_not_kept() {
        let (_d, db) = library();
        db.write(|c| {
            c.execute("INSERT INTO studio_pillars (id, name, created_ms, updated_ms) VALUES ('pl1', 'Travel', 0, 0)", [])?;
            Ok(())
        })
        .unwrap();
        super::super::studio::delete(&db, "pillars", "pl1", "menu").unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM trash"), 0);
    }

    #[test]
    fn after_30_days_it_is_purged_and_logged() {
        let (_d, db) = library();
        post_with_pictures(&db);
        delete(&db, "post", "po1", "menu").unwrap();
        assert_eq!(purge_expired(&db).unwrap(), 0, "a fresh delete stays");
        db.write(|c| { c.execute("UPDATE trash SET deleted_ms = deleted_ms - ?1 - 1", [KEEP_MS])?; Ok(()) }).unwrap();
        assert_eq!(purge_expired(&db).unwrap(), 1);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM trash"), 0);
        let lines = audit_lines(&db, 10).unwrap();
        assert_eq!(lines.iter().map(|l| (l.action.as_str(), l.source.as_str())).collect::<Vec<_>>(), vec![("purge", "after 30 days"), ("delete", "menu")]);
    }

    #[test]
    fn delete_for_good_asks_nothing_here_but_is_logged() {
        let (_d, db) = library();
        post_with_pictures(&db);
        delete(&db, "post", "po1", "menu").unwrap();
        purge(&db, list(&db, None).unwrap()[0].id, "Recently deleted").unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM audit_log WHERE action = 'purge'"), 1);
    }
}
