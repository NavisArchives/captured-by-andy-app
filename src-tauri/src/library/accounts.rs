//! Social accounts (Instagram first). Numbers are entered by hand for now; the
//! schema leaves room for an API integration later.

use base64::Engine;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::db::Db;
use super::{new_id, now_ms, Error, Result};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub platform: String,
    pub display_name: String,
    pub username: String,
    pub avatar_photo_id: Option<String>,
    pub avatar_thumbhash: Option<String>,
    pub follower_count: Option<i64>,
    pub following_count: Option<i64>,
    pub published_post_count: Option<i64>,
    pub notes: String,
    pub bio: String,
    pub link: String,
    pub category: String,
    /// Posts planned in this app, by stage.
    pub drafts: i64,
    pub ready: i64,
    pub published: i64,
    pub created_ms: i64,
    pub updated_ms: i64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AccountInput {
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub avatar_photo_id: Option<String>,
    /// For the counts, a missing field keeps the value and `null` clears it.
    #[serde(deserialize_with = "present")]
    pub follower_count: Option<Option<i64>>,
    #[serde(deserialize_with = "present")]
    pub following_count: Option<Option<i64>>,
    #[serde(deserialize_with = "present")]
    pub published_post_count: Option<Option<i64>>,
    pub notes: Option<String>,
    pub bio: Option<String>,
    pub link: Option<String>,
    pub category: Option<String>,
}

/// Present in the JSON (even as null) -> Some(value); absent -> None (via `default`).
fn present<'de, D, T>(d: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

const SELECT: &str = "SELECT a.id, a.platform, a.display_name, a.username, a.avatar_photo_id,
       (SELECT thumbhash FROM photos WHERE id = a.avatar_photo_id),
       a.follower_count, a.following_count, a.published_post_count, a.notes,
       (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id AND p.status IN ('idea', 'building')),
       (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id AND p.status IN ('ready', 'scheduled')),
       (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id AND p.status = 'published'),
       a.created_ms, a.updated_ms, a.bio, a.link, a.category
FROM accounts a";

fn account(r: &rusqlite::Row) -> rusqlite::Result<Account> {
    let hash: Option<Vec<u8>> = r.get(5)?;
    Ok(Account {
        id: r.get(0)?,
        platform: r.get(1)?,
        display_name: r.get(2)?,
        username: r.get(3)?,
        avatar_photo_id: r.get(4)?,
        avatar_thumbhash: hash.map(|h| base64::engine::general_purpose::STANDARD.encode(h)),
        follower_count: r.get(6)?,
        following_count: r.get(7)?,
        published_post_count: r.get(8)?,
        notes: r.get(9)?,
        drafts: r.get(10)?,
        ready: r.get(11)?,
        published: r.get(12)?,
        created_ms: r.get(13)?,
        updated_ms: r.get(14)?,
        bio: r.get(15)?,
        link: r.get(16)?,
        category: r.get(17)?,
    })
}

fn clean_username(name: &str) -> Result<String> {
    let name = name.trim().trim_start_matches('@').trim();
    if name.is_empty() || name.contains(char::is_whitespace) {
        return Err(Error::Invalid(format!("not a username: {name:?}")));
    }
    Ok(name.to_owned())
}

pub fn list(db: &Db) -> Result<Vec<Account>> {
    db.read(|c| {
        let mut stmt = c.prepare_cached(&format!("{SELECT} ORDER BY a.created_ms"))?;
        let rows = stmt.query_map([], account)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

pub fn get(db: &Db, id: &str) -> Result<Account> {
    db.read(|c| {
        c.query_row(&format!("{SELECT} WHERE a.id = ?1"), [id], account)
            .optional()?
            .ok_or_else(|| Error::Invalid(format!("unknown account {id}")))
    })
}

pub fn create(db: &Db, input: &AccountInput) -> Result<Account> {
    let username = clean_username(input.username.as_deref().unwrap_or(""))?;
    let id = new_id();
    db.write(|c| {
        c.execute(
            "INSERT INTO accounts (id, display_name, username, avatar_photo_id, follower_count, following_count,
                                   published_post_count, notes, created_ms, updated_ms, bio, link, category)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?11, ?12)",
            params![
                id,
                input.display_name.as_deref().unwrap_or("").trim(),
                username,
                input.avatar_photo_id,
                input.follower_count.flatten(),
                input.following_count.flatten(),
                input.published_post_count.flatten(),
                input.notes.as_deref().unwrap_or(""),
                now_ms(),
                input.bio.as_deref().unwrap_or(""),
                input.link.as_deref().unwrap_or("").trim(),
                input.category.as_deref().unwrap_or("").trim()
            ],
        )
        .map_err(|_| Error::Invalid(format!("@{username} already exists")))?;
        Ok(())
    })?;
    get(db, &id)
}

/// Updates only the fields given.
pub fn update(db: &Db, id: &str, input: &AccountInput) -> Result<Account> {
    let username = input.username.as_deref().map(clean_username).transpose()?;
    db.write(|c| {
        c.execute(
            "UPDATE accounts SET username = COALESCE(?2, username), display_name = COALESCE(?3, display_name),
                    avatar_photo_id = COALESCE(?4, avatar_photo_id),
                    follower_count = CASE WHEN ?13 THEN ?5 ELSE follower_count END,
                    following_count = CASE WHEN ?14 THEN ?6 ELSE following_count END,
                    published_post_count = CASE WHEN ?15 THEN ?7 ELSE published_post_count END,
                    notes = COALESCE(?8, notes),
                    updated_ms = ?9, bio = COALESCE(?10, bio), link = COALESCE(?11, link),
                    category = COALESCE(?12, category)
             WHERE id = ?1",
            params![
                id,
                username,
                input.display_name.as_deref().map(str::trim),
                input.avatar_photo_id,
                input.follower_count.flatten(),
                input.following_count.flatten(),
                input.published_post_count.flatten(),
                input.notes,
                now_ms(),
                input.bio,
                input.link.as_deref().map(str::trim),
                input.category.as_deref().map(str::trim),
                input.follower_count.is_some(),
                input.following_count.is_some(),
                input.published_post_count.is_some()
            ],
        )?;
        Ok(())
    })?;
    get(db, id)
}

/// Removes the account; its posts stay, unassigned.
pub fn delete(db: &Db, id: &str) -> Result<()> {
    db.write(|c| {
        let tx = c.transaction()?;
        // Its posts stay, unassigned; a pin only means something on a profile.
        tx.execute("UPDATE posts SET pinned = 0 WHERE account_id = ?1", [id])?;
        tx.execute("DELETE FROM accounts WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    })
}
