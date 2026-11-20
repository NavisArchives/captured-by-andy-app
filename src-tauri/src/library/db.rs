use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, OpenFlags};
use rusqlite_migration::{Migrations, M};

use super::Result;

const MIGRATIONS: &[&str] = &[
    include_str!("migrations/001_core.sql"),
    include_str!("migrations/002_organise_social_storage.sql"),
    include_str!("migrations/003_auto_analysis.sql"),
    include_str!("migrations/004_profile.sql"),
    include_str!("migrations/005_pin_cleanup.sql"),
    include_str!("migrations/006_videos.sql"),
    include_str!("migrations/007_post_export.sql"),
    include_str!("migrations/008_scenes.sql"),
    include_str!("migrations/009_video_moments.sql"),
    include_str!("migrations/010_video_profile.sql"),
    include_str!("migrations/011_labels.sql"),
    include_str!("migrations/012_studio.sql"),
    include_str!("migrations/013_album_looks.sql"),
    include_str!("migrations/014_video_trims.sql"),
    include_str!("migrations/015_save_topics.sql"),
    include_str!("migrations/016_retry_online_videos.sql"),
    include_str!("migrations/017_cleanup.sql"),
    include_str!("migrations/018_quality_money.sql"),
    include_str!("migrations/019_boards.sql"),
    include_str!("migrations/020_transcription.sql"),
    include_str!("migrations/021_video_transcripts.sql"),
    include_str!("migrations/022_recently_deleted.sql"),
];

pub fn migrations() -> Migrations<'static> {
    Migrations::new(MIGRATIONS.iter().map(|sql| M::up(sql)).collect())
}

/// One writer connection behind a mutex (SQLite has a single writer anyway)
/// plus short-lived read-only connections, which WAL lets run while the
/// scanner is writing - so browsing never waits for a scan.
pub struct Db {
    path: PathBuf,
    writer: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let mut conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        // An existing library about to get a newer schema: keep a copy of it as it was.
        let version: usize = conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap_or(0) as usize;
        if version > 0 && version < MIGRATIONS.len() {
            super::backup::before_upgrade(&conn, path)?;
        }
        migrations().to_latest(&mut conn)?;
        Ok(Self { path: path.to_owned(), writer: Mutex::new(conn) })
    }

    pub fn write<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        let mut conn = self.writer.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        f(&mut conn)
    }

    pub fn read<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        f(&conn)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn migrations_are_valid() {
        super::migrations().validate().unwrap();
    }
}
