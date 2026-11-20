//! Posts: an ordered carousel of photos, optionally assigned to an account, moving
//! through idea -> building -> ready -> scheduled -> published. A photo's social
//! state and history are read from here, never stored on the photo.

use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::db::Db;
use super::photos::{self, PhotoRow};
use super::{new_id, now_ms, Error, Result};

/// Instagram's carousel limit.
pub const MAX_PHOTOS: usize = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Idea,
    Building,
    Ready,
    Scheduled,
    Published,
    Archived,
}

impl Status {
    pub const ALL: [Status; 6] =
        [Status::Idea, Status::Building, Status::Ready, Status::Scheduled, Status::Published, Status::Archived];

    pub fn as_str(self) -> &'static str {
        match self {
            Status::Idea => "idea",
            Status::Building => "building",
            Status::Ready => "ready",
            Status::Scheduled => "scheduled",
            Status::Published => "published",
            Status::Archived => "archived",
        }
    }

    pub fn parse(text: &str) -> Result<Self> {
        Status::ALL.into_iter().find(|s| s.as_str() == text).ok_or_else(|| Error::Invalid(format!("unknown status {text}")))
    }

    /// Not yet on Instagram, but meant to be.
    pub fn is_future(self) -> bool {
        matches!(self, Status::Idea | Status::Building | Status::Ready | Status::Scheduled)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Post {
    pub id: String,
    pub account_id: Option<String>,
    pub account_username: Option<String>,
    pub title: String,
    pub caption: String,
    pub notes: String,
    pub status: Status,
    pub scheduled_at: Option<String>,
    pub published_at: Option<String>,
    pub plan_order: Option<f64>,
    pub pinned: bool,
    pub photo_count: i64,
    pub cover_photo_id: Option<String>,
    pub cover_thumbhash: Option<String>,
    pub created_ms: i64,
    pub updated_ms: i64,
    /// "3:4", "4:5" or "1:1": how the post is exported (one ratio per carousel).
    pub export_ratio: String,
    /// Where the 3:4 grid tile sits on the cover, -1 to 1.
    pub tile_offset: f64,
}

/// Where a photo has been used: one line of its history.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub post_id: String,
    pub title: String,
    pub status: Status,
    pub account_username: Option<String>,
    pub published_at: Option<String>,
    pub scheduled_at: Option<String>,
    pub position: i64,
}

/// A photo in this post that is also used in another one.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reuse {
    pub photo_id: String,
    #[serde(flatten)]
    pub usage: Usage,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostDetail {
    #[serde(flatten)]
    pub post: Post,
    pub photos: Vec<PhotoRow>,
    pub reused: Vec<Reuse>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PostInput {
    pub title: Option<String>,
    pub caption: Option<String>,
    pub notes: Option<String>,
    /// `Some("")` unassigns.
    pub account_id: Option<String>,
    pub status: Option<Status>,
    /// `Some("")` clears.
    pub scheduled_at: Option<String>,
    pub published_at: Option<String>,
    pub pinned: Option<bool>,
    pub export_ratio: Option<String>,
    pub tile_offset: Option<f64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PostFilter {
    pub account: Option<String>,
    pub status: Option<Status>,
}

const SELECT: &str = "SELECT po.id, po.account_id, ac.username, po.title, po.caption, po.notes, po.status,
       po.scheduled_at, po.published_at, po.plan_order,
       (SELECT COUNT(*) FROM post_photos pp WHERE pp.post_id = po.id),
       (SELECT pp.photo_id FROM post_photos pp WHERE pp.post_id = po.id ORDER BY pp.position LIMIT 1),
       (SELECT ph.thumbhash FROM post_photos pp JOIN photos ph ON ph.id = pp.photo_id
          WHERE pp.post_id = po.id ORDER BY pp.position LIMIT 1),
       po.created_ms, po.updated_ms, po.pinned, po.export_ratio, po.tile_offset
FROM posts po LEFT JOIN accounts ac ON ac.id = po.account_id";

fn post(r: &rusqlite::Row) -> rusqlite::Result<Post> {
    let status: String = r.get(6)?;
    let hash: Option<Vec<u8>> = r.get(12)?;
    Ok(Post {
        id: r.get(0)?,
        account_id: r.get(1)?,
        account_username: r.get(2)?,
        title: r.get(3)?,
        caption: r.get(4)?,
        notes: r.get(5)?,
        status: Status::parse(&status).unwrap_or(Status::Idea),
        scheduled_at: r.get(7)?,
        published_at: r.get(8)?,
        plan_order: r.get(9)?,
        photo_count: r.get(10)?,
        cover_photo_id: r.get(11)?,
        cover_thumbhash: hash.map(|h| base64::engine::general_purpose::STANDARD.encode(h)),
        created_ms: r.get(13)?,
        updated_ms: r.get(14)?,
        pinned: r.get(15)?,
        export_ratio: r.get(16)?,
        tile_offset: r.get(17)?,
    })
}

pub fn list(db: &Db, filter: &PostFilter) -> Result<Vec<Post>> {
    db.read(|c| {
        let mut stmt = c.prepare_cached(&format!(
            "{SELECT} WHERE (?1 IS NULL OR po.account_id = ?1) AND (?2 IS NULL OR po.status = ?2)
             ORDER BY CASE po.status WHEN 'published' THEN 1 WHEN 'archived' THEN 2 ELSE 0 END,
                      CASE WHEN po.status = 'scheduled' THEN po.scheduled_at END,
                      CASE WHEN po.status IN ('published', 'archived') THEN NULL ELSE po.plan_order END IS NULL,
                      CASE WHEN po.status IN ('published', 'archived') THEN NULL ELSE po.plan_order END,
                      po.published_at DESC, po.updated_ms DESC"
        ))?;
        let rows = stmt
            .query_map(params![filter.account, filter.status.map(Status::as_str)], post)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

fn get_on(c: &Connection, id: &str) -> Result<Post> {
    c.query_row(&format!("{SELECT} WHERE po.id = ?1"), [id], post)
        .optional()?
        .ok_or_else(|| Error::Invalid(format!("unknown post {id}")))
}

pub fn get(db: &Db, id: &str) -> Result<PostDetail> {
    db.read(|c| {
        let post = get_on(c, id)?;
        let ids: Vec<String> = c
            .prepare_cached("SELECT photo_id FROM post_photos WHERE post_id = ?1 ORDER BY position")?
            .query_map([id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let photos = photos::rows_by_id(c, &ids)?;
        let mut reused = Vec::new();
        for photo in &ids {
            for usage in history_for_photo(c, photo)? {
                if usage.post_id != id {
                    reused.push(Reuse { photo_id: photo.clone(), usage });
                }
            }
        }
        Ok(PostDetail { post, photos, reused })
    })
}

fn clean_title(title: &str) -> String {
    let t = title.trim();
    if t.is_empty() { "Untitled post".to_owned() } else { t.to_owned() }
}

fn empty_to_null(value: &Option<String>) -> Option<Option<&str>> {
    value.as_deref().map(|v| if v.trim().is_empty() { None } else { Some(v.trim()) })
}

pub fn create(db: &Db, input: &PostInput, photo_ids: &[String]) -> Result<PostDetail> {
    if photo_ids.len() > MAX_PHOTOS {
        return Err(Error::Invalid(format!("a carousel holds at most {MAX_PHOTOS} photos")));
    }
    let id = new_id();
    let status = input.status.unwrap_or(if photo_ids.is_empty() { Status::Idea } else { Status::Building });
    db.write(|c| {
        let tx = c.transaction()?;
        let now = now_ms();
        let plan: f64 = tx.query_row("SELECT COALESCE(MAX(plan_order), 0) + 1 FROM posts", [], |r| r.get(0))?;
        tx.execute(
            "INSERT INTO posts (id, account_id, title, caption, notes, status, scheduled_at, published_at, plan_order,
                                created_ms, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![
                id,
                empty_to_null(&input.account_id).flatten(),
                clean_title(input.title.as_deref().unwrap_or("")),
                input.caption.as_deref().unwrap_or(""),
                input.notes.as_deref().unwrap_or(""),
                status.as_str(),
                empty_to_null(&input.scheduled_at).flatten(),
                empty_to_null(&input.published_at).flatten(),
                plan,
                now
            ],
        )?;
        insert_photos(&tx, &id, photo_ids, 0)?;
        tx.commit()?;
        Ok(())
    })?;
    get(db, &id)
}

fn insert_photos(tx: &Connection, post: &str, photo_ids: &[String], start: i64) -> Result<usize> {
    let mut stmt = tx.prepare_cached("INSERT OR IGNORE INTO post_photos (post_id, photo_id, position) VALUES (?1, ?2, ?3)")?;
    let mut pos = start;
    let mut added = 0;
    for photo in photo_ids {
        let n = stmt.execute(params![post, photo, pos])?;
        added += n;
        pos += n as i64;
    }
    Ok(added)
}

/// Updates only the fields given. A post needs a photo to become ready,
/// scheduled or published; an idea made ready while it has a date is
/// scheduled. Publishing a scheduled post without a date stamps its planned
/// time when that has passed (marked after the fact), otherwise now; going
/// back to a planned status clears the date, archiving keeps it for the
/// photo's history. An explicit `published_at` always wins.
pub fn update(db: &Db, id: &str, input: &PostInput) -> Result<PostDetail> {
    db.write(|c| {
        let tx = c.transaction()?;
        let current = get_on(&tx, id)?;
        if let Some(ratio) = &input.export_ratio {
            if !matches!(ratio.as_str(), "3:4" | "4:5" | "1:1") {
                return Err(Error::Invalid(format!("not an Instagram ratio: {ratio}")));
            }
            tx.execute("UPDATE posts SET export_ratio = ?2 WHERE id = ?1", params![id, ratio])?;
        }
        if let Some(offset) = input.tile_offset {
            tx.execute("UPDATE posts SET tile_offset = ?2 WHERE id = ?1", params![id, offset.clamp(-1.0, 1.0)])?;
        }
        let scheduled = match empty_to_null(&input.scheduled_at) {
            Some(v) => v.map(str::to_owned),
            None => current.scheduled_at.clone(),
        };
        let mut status = input.status.unwrap_or(current.status);
        if status == Status::Ready && matches!(current.status, Status::Idea | Status::Building) && scheduled.is_some() {
            status = Status::Scheduled;
        }
        let status_changed = status != current.status;
        // Only on a real move into the plan: published posts made without
        // photos can still be pinned, archived and brought back.
        let restoring = status == Status::Published && current.status == Status::Archived;
        if status_changed && !restoring && matches!(status, Status::Ready | Status::Scheduled | Status::Published) {
            let photos: i64 = tx.query_row("SELECT COUNT(*) FROM post_photos WHERE post_id = ?1", [id], |r| r.get(0))?;
            if photos == 0 {
                return Err(Error::Invalid("Add photos first".into()));
            }
        }
        let account = match empty_to_null(&input.account_id) {
            Some(v) => v.map(str::to_owned),
            None => current.account_id.clone(),
        };
        // Both are local "YYYY-MM-DDTHH:MM" strings, so they compare as text.
        let published_at = match empty_to_null(&input.published_at) {
            Some(v) => v.map(str::to_owned),
            None if status == Status::Published && (current.status.is_future() || current.published_at.is_none()) => {
                let now = chrono::Local::now().format("%Y-%m-%dT%H:%M").to_string();
                // Only a post that was scheduled went out at its planned time.
                let planned = (current.status == Status::Scheduled).then_some(()).and(scheduled.as_deref()).map(|s| s.get(..16).unwrap_or(s));
                Some(match planned {
                    Some(at) if at <= now.as_str() => at.to_owned(),
                    _ => now,
                })
            }
            None if status_changed && status.is_future() => None,
            None => current.published_at.clone(),
        };
        if input.pinned == Some(true) && status != Status::Published {
            return Err(Error::Invalid("Only published posts can be pinned".into()));
        }
        if input.pinned == Some(true) && account.is_none() {
            return Err(Error::Invalid("Assign the post to an account before pinning it".into()));
        }
        let pinned = status == Status::Published && account.is_some() && input.pinned.unwrap_or(current.pinned);
        let already_counted = current.pinned && current.status == Status::Published && account == current.account_id;
        if pinned && !already_counted {
            let others: i64 = tx.query_row(
                "SELECT COUNT(*) FROM posts WHERE pinned = 1 AND status = 'published' AND account_id IS ?1 AND id != ?2",
                params![account, id],
                |r| r.get(0),
            )?;
            if others >= 3 {
                return Err(Error::Invalid("Instagram pins at most 3 posts: unpin one first".into()));
            }
        }
        tx.execute("UPDATE posts SET pinned = ?2 WHERE id = ?1", params![id, pinned])?;
        tx.execute(
            "UPDATE posts SET title = ?2, caption = ?3, notes = ?4, account_id = ?5, status = ?6, scheduled_at = ?7,
                    published_at = ?8, updated_ms = ?9 WHERE id = ?1",
            params![
                id,
                input.title.as_deref().map(clean_title).unwrap_or(current.title),
                input.caption.as_deref().unwrap_or(&current.caption),
                input.notes.as_deref().unwrap_or(&current.notes),
                account,
                status.as_str(),
                scheduled,
                published_at,
                now_ms()
            ],
        )?;
        tx.commit()?;
        Ok(())
    })?;
    get(db, id)
}

/// Moves the post to Recently deleted (30 days, restorable). Its photos are untouched.
pub fn delete(db: &Db, id: &str, source: &str) -> Result<()> {
    super::trash::delete(db, "post", id, source)
}

fn touch(c: &Connection, id: &str) -> Result<()> {
    c.execute("UPDATE posts SET updated_ms = ?2 WHERE id = ?1", params![id, now_ms()])?;
    Ok(())
}

pub fn add_photos(db: &Db, id: &str, photo_ids: &[String]) -> Result<usize> {
    db.write(|c| {
        let tx = c.transaction()?;
        let (count, next): (i64, i64) = tx.query_row(
            "SELECT COUNT(*), COALESCE(MAX(position) + 1, 0) FROM post_photos WHERE post_id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let fresh = photo_ids
            .iter()
            .filter(|p| {
                tx.query_row("SELECT 1 FROM post_photos WHERE post_id = ?1 AND photo_id = ?2", params![id, p], |_| Ok(()))
                    .optional()
                    .map(|found| found.is_none())
                    .unwrap_or(false)
            })
            .count();
        if count as usize + fresh > MAX_PHOTOS {
            return Err(Error::Invalid(format!("a carousel holds at most {MAX_PHOTOS} photos")));
        }
        let added = insert_photos(&tx, id, photo_ids, next)?;
        tx.execute("UPDATE posts SET status = 'building' WHERE id = ?1 AND status = 'idea'", [id])?;
        touch(&tx, id)?;
        tx.commit()?;
        Ok(added)
    })
}

pub fn remove_photos(db: &Db, id: &str, photo_ids: &[String]) -> Result<usize> {
    db.write(|c| {
        let tx = c.transaction()?;
        let mut removed = 0;
        {
            let mut stmt = tx.prepare_cached("DELETE FROM post_photos WHERE post_id = ?1 AND photo_id = ?2")?;
            for p in photo_ids {
                removed += stmt.execute(params![id, p])?;
            }
        }
        renumber(&tx, id, None)?;
        touch(&tx, id)?;
        tx.commit()?;
        Ok(removed)
    })
}

/// Sets the carousel order. `ordered` must be exactly the post's photos.
pub fn reorder_photos(db: &Db, id: &str, ordered: &[String]) -> Result<()> {
    db.write(|c| {
        let tx = c.transaction()?;
        renumber(&tx, id, Some(ordered))?;
        touch(&tx, id)?;
        tx.commit()?;
        Ok(())
    })
}

fn renumber(tx: &Connection, id: &str, ordered: Option<&[String]>) -> Result<()> {
    let mut current: Vec<String> = tx
        .prepare_cached("SELECT photo_id FROM post_photos WHERE post_id = ?1 ORDER BY position")?
        .query_map([id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    if let Some(ordered) = ordered {
        let mut a = current.clone();
        let mut b = ordered.to_vec();
        a.sort();
        b.sort();
        if a != b {
            return Err(Error::Invalid("the new order must contain exactly the post's photos".into()));
        }
        current = ordered.to_vec();
    }
    // Two passes so the (post, position) order never collides mid-update.
    tx.execute("UPDATE post_photos SET position = -1 - position WHERE post_id = ?1", [id])?;
    let mut stmt = tx.prepare_cached("UPDATE post_photos SET position = ?3 WHERE post_id = ?1 AND photo_id = ?2")?;
    for (i, photo) in current.iter().enumerate() {
        stmt.execute(params![id, photo, i as i64])?;
    }
    Ok(())
}

pub(crate) fn history_for_photo(c: &Connection, photo_id: &str) -> Result<Vec<Usage>> {
    let mut stmt = c.prepare_cached(
        "SELECT po.id, po.title, po.status, ac.username, po.published_at, po.scheduled_at, pp.position
         FROM post_photos pp JOIN posts po ON po.id = pp.post_id LEFT JOIN accounts ac ON ac.id = po.account_id
         WHERE pp.photo_id = ?1
         ORDER BY po.status = 'published' DESC, po.published_at DESC, po.updated_ms DESC",
    )?;
    let rows = stmt
        .query_map([photo_id], |r| {
            let status: String = r.get(2)?;
            Ok(Usage {
                post_id: r.get(0)?,
                title: r.get(1)?,
                status: Status::parse(&status).unwrap_or(Status::Idea),
                account_username: r.get(3)?,
                published_at: r.get(4)?,
                scheduled_at: r.get(5)?,
                position: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Pipeline {
    pub idea: i64,
    pub building: i64,
    pub ready: i64,
    pub scheduled: i64,
    pub published: i64,
    pub archived: i64,
}

pub fn pipeline(db: &Db, account: Option<&str>) -> Result<Pipeline> {
    db.read(|c| {
        let mut stmt = c.prepare_cached(
            "SELECT status, COUNT(*) FROM posts WHERE (?1 IS NULL OR account_id = ?1) GROUP BY status",
        )?;
        let mut p = Pipeline::default();
        for row in stmt.query_map([account], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
            let (status, n) = row?;
            match Status::parse(&status)? {
                Status::Idea => p.idea = n,
                Status::Building => p.building = n,
                Status::Ready => p.ready = n,
                Status::Scheduled => p.scheduled = n,
                Status::Published => p.published = n,
                Status::Archived => p.archived = n,
            }
        }
        Ok(p)
    })
}

/// The account's grid as Instagram would show it, newest first: planned posts
/// on top (the one planned last comes first), then what is already published.
pub fn grid(db: &Db, account: &str) -> Result<Vec<Post>> {
    db.read(|c| {
        let mut stmt = c.prepare_cached(&format!(
            "{SELECT} WHERE po.account_id = ?1 AND po.status != 'archived'
             ORDER BY po.status = 'published',
                      CASE WHEN po.status = 'published' THEN NULL ELSE po.plan_order END DESC,
                      po.published_at DESC, po.created_ms DESC"
        ))?;
        let rows = stmt.query_map([account], post)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// Sets the posting order of planned posts: `ordered[0]` goes out first.
/// Only the preview changes; published history is never reordered.
pub fn plan(db: &Db, ordered: &[String]) -> Result<()> {
    db.write(|c| {
        let tx = c.transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                "UPDATE posts SET plan_order = ?2, updated_ms = ?3 WHERE id = ?1 AND status NOT IN ('published', 'archived')",
            )?;
            let now = now_ms();
            for (i, id) in ordered.iter().enumerate() {
                stmt.execute(params![id, i as f64 + 1.0, now])?;
            }
        }
        tx.commit()?;
        Ok(())
    })
}
