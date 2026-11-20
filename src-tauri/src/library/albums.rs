//! Albums: many-to-many collections. Adding a photo never moves or copies it.

use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::db::Db;
use super::{new_id, now_ms, Error, Result};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub id: String,
    pub name: String,
    pub description: String,
    pub cover_photo_id: Option<String>,
    pub cover_thumbhash: Option<String>,
    pub photo_count: i64,
    pub created_ms: i64,
    pub updated_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumRef {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AlbumPatch {
    pub name: Option<String>,
    pub description: Option<String>,
    pub cover_photo_id: Option<String>,
}

// The cover is the chosen one, else the first photo added.
const SELECT: &str = "SELECT x.id, x.name, x.description, x.cover, (SELECT thumbhash FROM photos WHERE id = x.cover),
                             x.n, x.created_ms, x.updated_ms
                      FROM (SELECT al.*, COALESCE(al.cover_photo_id,
                              (SELECT pa.photo_id FROM photo_albums pa WHERE pa.album_id = al.id ORDER BY pa.position LIMIT 1)) AS cover,
                              (SELECT COUNT(*) FROM photo_albums pa WHERE pa.album_id = al.id) AS n
                            FROM albums al) x";

fn album(r: &rusqlite::Row) -> rusqlite::Result<Album> {
    let hash: Option<Vec<u8>> = r.get(4)?;
    Ok(Album {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        cover_photo_id: r.get(3)?,
        cover_thumbhash: hash.map(|h| base64::engine::general_purpose::STANDARD.encode(h)),
        photo_count: r.get(5)?,
        created_ms: r.get(6)?,
        updated_ms: r.get(7)?,
    })
}

pub fn list(db: &Db) -> Result<Vec<Album>> {
    db.read(|c| {
        let mut stmt = c.prepare_cached(&format!("{SELECT} ORDER BY x.updated_ms DESC"))?;
        let rows = stmt.query_map([], album)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

pub fn get(db: &Db, id: &str) -> Result<Album> {
    db.read(|c| {
        c.query_row(&format!("{SELECT} WHERE x.id = ?1"), [id], album)
            .optional()?
            .ok_or_else(|| Error::Invalid(format!("unknown album {id}")))
    })
}

fn clean_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::Invalid("an album needs a name".into()));
    }
    Ok(name.to_owned())
}

pub fn create(db: &Db, name: &str, description: &str) -> Result<Album> {
    let id = new_id();
    let name = clean_name(name)?;
    db.write(|c| {
        c.execute(
            "INSERT INTO albums (id, name, description, created_ms, updated_ms) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, name, description.trim(), now_ms()],
        )?;
        Ok(())
    })?;
    get(db, &id)
}

pub fn update(db: &Db, id: &str, patch: &AlbumPatch) -> Result<Album> {
    let name = patch.name.as_deref().map(clean_name).transpose()?;
    db.write(|c| {
        let changed = c.execute(
            "UPDATE albums SET name = COALESCE(?2, name), description = COALESCE(?3, description),
                    cover_photo_id = COALESCE(?4, cover_photo_id), updated_ms = ?5 WHERE id = ?1",
            params![id, name, patch.description.as_deref().map(str::trim), patch.cover_photo_id, now_ms()],
        )?;
        if changed == 0 {
            return Err(Error::Invalid(format!("unknown album {id}")));
        }
        Ok(())
    })?;
    get(db, id)
}

/// Moves the album (with its memberships and look) to Recently deleted. The photos are untouched.
pub fn delete(db: &Db, id: &str, source: &str) -> Result<()> {
    super::trash::delete(db, "album", id, source)
}

pub fn add_photos(db: &Db, id: &str, photo_ids: &[String]) -> Result<usize> {
    db.write(|c| {
        let tx = c.transaction()?;
        let now = now_ms();
        let mut next: i64 =
            tx.query_row("SELECT COALESCE(MAX(position) + 1, 0) FROM photo_albums WHERE album_id = ?1", [id], |r| r.get(0))?;
        let mut added = 0;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT OR IGNORE INTO photo_albums (album_id, photo_id, position, added_ms) VALUES (?1, ?2, ?3, ?4)",
            )?;
            for photo in photo_ids {
                let n = stmt.execute(params![id, photo, next, now])?;
                added += n;
                next += n as i64;
            }
        }
        tx.execute("UPDATE albums SET updated_ms = ?2 WHERE id = ?1", params![id, now])?;
        tx.commit()?;
        Ok(added)
    })
}

pub fn remove_photos(db: &Db, id: &str, photo_ids: &[String]) -> Result<usize> {
    db.write(|c| {
        let tx = c.transaction()?;
        let mut removed = 0;
        {
            let mut stmt = tx.prepare_cached("DELETE FROM photo_albums WHERE album_id = ?1 AND photo_id = ?2")?;
            for photo in photo_ids {
                removed += stmt.execute(params![id, photo])?;
            }
        }
        tx.execute(
            "UPDATE albums SET updated_ms = ?2,
                    cover_photo_id = CASE WHEN cover_photo_id IN (SELECT photo_id FROM photo_albums WHERE album_id = ?1)
                                          THEN cover_photo_id END
             WHERE id = ?1",
            params![id, now_ms()],
        )?;
        tx.commit()?;
        Ok(removed)
    })
}

pub(crate) fn for_photo(c: &Connection, photo_id: &str) -> Result<Vec<AlbumRef>> {
    let mut stmt = c.prepare_cached(
        "SELECT al.id, al.name FROM photo_albums pa JOIN albums al ON al.id = pa.album_id
         WHERE pa.photo_id = ?1 ORDER BY al.name",
    )?;
    let rows = stmt.query_map([photo_id], |r| Ok(AlbumRef { id: r.get(0)?, name: r.get(1)? }))?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}
