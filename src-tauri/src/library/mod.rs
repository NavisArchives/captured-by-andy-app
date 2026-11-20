//! The photo library: everything that works without Tauri, so it can be tested
//! with plain `cargo test`. The app layer (commands, image protocol) sits on top.
//!
//! Safety rule for the whole module: source files are only ever opened for
//! reading, and never at all when they are iCloud placeholders (see `scan`).
//! The one exception is `trips`, which moves a photo's files to another trip
//! folder when asked to (a rename, never a rewrite).

pub mod accounts;
pub mod albums;
pub mod archive;
pub mod auto;
pub mod backup;
pub mod cleanup;
pub mod cloud_sync;
pub mod dashboard;
pub mod db;
#[cfg(target_os = "macos")]
pub mod download;
pub mod editor_package;
pub mod exif;
pub mod finder;
pub mod fingerprint;
#[cfg(target_os = "macos")]
pub mod gdrive;
#[cfg(target_os = "macos")]
pub mod heal;
pub mod labels;
pub mod lane;
pub mod looks;
#[cfg(target_os = "macos")]
pub mod media;
pub mod model;
pub mod moments;
pub mod offline;
pub mod pairing;
pub mod photos;
pub mod places;
pub mod posts;
pub mod review;
pub mod scan;
pub mod settings;
pub mod sources;
pub mod storage;
pub mod studio;
pub mod tags;
pub mod thumbs;
pub mod trash;
pub mod trips;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("database: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("migration: {0}")]
    Migration(#[from] rusqlite_migration::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Invalid(String),
    #[error("source folder is not reachable: {0}")]
    SourceOffline(String),
    #[error("media: {0}")]
    Media(String),
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// UUIDv7: time-ordered, so new rows land at the end of primary-key indexes.
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}
