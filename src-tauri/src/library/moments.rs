//! Moments: the good parts of a video, marked with in and out points while
//! culling; and its trim, the part used when it's exported. Only these rows
//! change; the video file is never touched.

use rusqlite::params;
use serde::Serialize;

use super::db::Db;
use super::{new_id, now_ms, Error, Result};

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Moment {
    pub id: String,
    pub photo_id: String,
    pub start: f64,
    pub end: f64,
}

pub fn list(db: &Db, photo_id: &str) -> Result<Vec<Moment>> {
    db.read(|c| {
        let mut stmt = c.prepare_cached("SELECT id, photo_id, start_s, end_s FROM video_moments WHERE photo_id = ?1 ORDER BY start_s")?;
        let rows = stmt
            .query_map([photo_id], |r| Ok(Moment { id: r.get(0)?, photo_id: r.get(1)?, start: r.get(2)?, end: r.get(3)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// Records a moment of a video; the two points may come in either order.
pub fn add(db: &Db, photo_id: &str, a: f64, b: f64) -> Result<Moment> {
    let (start, end) = (a.min(b).max(0.0), a.max(b));
    if !(end - start >= 0.2) {
        return Err(Error::Invalid("A moment needs at least a fifth of a second between in and out".into()));
    }
    let is_video: bool = db
        .read(|c| Ok(c.query_row("SELECT is_video FROM photos WHERE id = ?1", [photo_id], |r| r.get(0))?))
        .map_err(|_| Error::Invalid(format!("unknown video {photo_id}")))?;
    if !is_video {
        return Err(Error::Invalid("Moments are for videos".into()));
    }
    let id = new_id();
    db.write(|c| {
        c.execute(
            "INSERT INTO video_moments (id, photo_id, start_s, end_s, created_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, photo_id, start, end, now_ms()],
        )?;
        Ok(())
    })?;
    Ok(Moment { id, photo_id: photo_id.to_owned(), start, end })
}

pub fn remove(db: &Db, id: &str) -> Result<()> {
    db.write(|c| {
        c.execute("DELETE FROM video_moments WHERE id = ?1", [id])?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moments_of_a_video() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("library.db")).unwrap();
        db.write(|c| {
            c.execute(
                "INSERT INTO photos (id, media_kind, captured_at, captured_at_source, thumb_state, created_ms, updated_ms, is_video)
                 VALUES ('v1', 'image', '2026-01-01T00:00:00.000', 'file', 'pending', 0, 0, 1),
                        ('p1', 'image', '2026-01-01T00:00:00.000', 'file', 'pending', 0, 0, 0)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let m = add(&db, "v1", 12.5, 4.0).unwrap();
        assert_eq!((m.start, m.end), (4.0, 12.5), "in and out in either order");
        add(&db, "v1", 20.0, 21.0).unwrap();
        assert_eq!(list(&db, "v1").unwrap().len(), 2);
        assert!(add(&db, "v1", 3.0, 3.05).is_err(), "too short");
        assert!(add(&db, "p1", 1.0, 2.0).is_err(), "photos have no moments");
        remove(&db, &m.id).unwrap();
        assert_eq!(list(&db, "v1").unwrap().iter().map(|m| m.start).collect::<Vec<_>>(), [20.0]);
    }
}

/// A video's trim (start, end in seconds), or None for the whole clip.
pub fn trim(db: &Db, photo_id: &str) -> Result<Option<(f64, f64)>> {
    use rusqlite::OptionalExtension;
    db.read(|c| Ok(c.query_row("SELECT start_s, end_s FROM video_trims WHERE photo_id = ?1", [photo_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?))
}

/// Trims a video; the two points may come in either order.
pub fn set_trim(db: &Db, photo_id: &str, a: f64, b: f64) -> Result<()> {
    let (start, end) = (a.min(b).max(0.0), a.max(b).max(0.0));
    db.write(|c| {
        c.execute(
            "INSERT INTO video_trims (photo_id, start_s, end_s, updated_ms) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (photo_id) DO UPDATE SET start_s = ?2, end_s = ?3, updated_ms = ?4",
            params![photo_id, start, end, now_ms()],
        )?;
        Ok(())
    })
}

/// Back to the whole clip.
pub fn clear_trim(db: &Db, photo_id: &str) -> Result<()> {
    db.write(|c| {
        c.execute("DELETE FROM video_trims WHERE photo_id = ?1", [photo_id])?;
        Ok(())
    })
}
