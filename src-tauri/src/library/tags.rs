//! User tags: free-form labels, many per photo. Distinct from system states
//! (review, storage, social), which are typed columns, not tags.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;

use super::db::Db;
use super::{new_id, now_ms, Error, Result};

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub usage: i64,
}

/// "Brussels Nights" -> "brussels-nights"; keeps letters of any alphabet.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for ch in name.trim().to_lowercase().chars() {
        if ch.is_alphanumeric() {
            out.push(ch);
        } else if (ch.is_whitespace() || ch == '-' || ch == '_') && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_owned()
}

const SELECT: &str = "SELECT t.id, t.name, t.slug, (SELECT COUNT(*) FROM photo_tags pt WHERE pt.tag_id = t.id) FROM tags t";

fn tag(r: &rusqlite::Row) -> rusqlite::Result<Tag> {
    Ok(Tag { id: r.get(0)?, name: r.get(1)?, slug: r.get(2)?, usage: r.get(3)? })
}

pub fn list(db: &Db) -> Result<Vec<Tag>> {
    db.read(|c| {
        let mut stmt = c.prepare_cached(&format!("{SELECT} ORDER BY 4 DESC, t.name"))?;
        let rows = stmt.query_map([], tag)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// The tag with this name (by slug), created if new.
fn ensure(tx: &Transaction, name: &str) -> Result<String> {
    let name = name.trim();
    let slug = slug(name);
    if slug.is_empty() {
        return Err(Error::Invalid(format!("not a usable tag: {name:?}")));
    }
    if let Some(id) = tx.query_row("SELECT id FROM tags WHERE slug = ?1", [&slug], |r| r.get(0)).optional()? {
        return Ok(id);
    }
    let id = new_id();
    tx.execute("INSERT INTO tags (id, name, slug, created_ms) VALUES (?1, ?2, ?3, ?4)", params![id, name, slug, now_ms()])?;
    Ok(id)
}

/// Tags every photo with every name, creating tags as needed.
pub fn add(db: &Db, names: &[String], photo_ids: &[String]) -> Result<usize> {
    db.write(|c| {
        let tx = c.transaction()?;
        let now = now_ms();
        let mut added = 0;
        for name in names {
            let id = ensure(&tx, name)?;
            let mut stmt =
                tx.prepare_cached("INSERT OR IGNORE INTO photo_tags (photo_id, tag_id, added_ms) VALUES (?1, ?2, ?3)")?;
            for photo in photo_ids {
                added += stmt.execute(params![photo, id, now])?;
            }
        }
        tx.commit()?;
        Ok(added)
    })
}

pub fn remove(db: &Db, tag_id: &str, photo_ids: &[String]) -> Result<usize> {
    db.write(|c| {
        let tx = c.transaction()?;
        let mut removed = 0;
        {
            let mut stmt = tx.prepare_cached("DELETE FROM photo_tags WHERE tag_id = ?1 AND photo_id = ?2")?;
            for photo in photo_ids {
                removed += stmt.execute(params![tag_id, photo])?;
            }
        }
        tx.commit()?;
        Ok(removed)
    })
}

pub fn rename(db: &Db, id: &str, name: &str) -> Result<()> {
    let slug = slug(name);
    if slug.is_empty() {
        return Err(Error::Invalid(format!("not a usable tag: {name:?}")));
    }
    db.write(|c| {
        c.execute("UPDATE tags SET name = ?2, slug = ?3 WHERE id = ?1", params![id, name.trim(), slug])
            .map_err(|_| Error::Invalid(format!("a tag called {name:?} already exists")))?;
        Ok(())
    })
}

pub fn delete(db: &Db, id: &str) -> Result<()> {
    db.write(|c| {
        c.execute("DELETE FROM tags WHERE id = ?1", [id])?;
        Ok(())
    })
}

pub(crate) fn for_photo(c: &Connection, photo_id: &str) -> Result<Vec<Tag>> {
    let mut stmt = c.prepare_cached(&format!(
        "{SELECT} WHERE t.id IN (SELECT tag_id FROM photo_tags WHERE photo_id = ?1) ORDER BY t.name"
    ))?;
    let rows = stmt.query_map([photo_id], tag)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    #[test]
    fn slugs_are_stable_and_unicode_friendly() {
        assert_eq!(super::slug("  Brussels Nights "), "brussels-nights");
        assert_eq!(super::slug("Chiang_Mai -- 2026"), "chiang-mai-2026");
        assert_eq!(super::slug("Ángel's café"), "ángels-café");
        assert_eq!(super::slug("!!!"), "");
    }
}
