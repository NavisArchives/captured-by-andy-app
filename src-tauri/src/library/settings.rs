//! Small key/value settings (JSON values), e.g. the keyboard map.

use rusqlite::{params, OptionalExtension};

use super::db::Db;
use super::Result;

pub fn get(db: &Db, key: &str) -> Result<Option<String>> {
    db.read(|c| Ok(c.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional()?))
}

pub fn set(db: &Db, key: &str, value: &str) -> Result<()> {
    db.write(|c| {
        c.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    })
}
