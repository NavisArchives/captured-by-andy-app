//! Where archived originals go. One interface, so a cloud bucket can be added
//! later without touching the archive logic; for now only a local folder (an
//! external drive, a NAS mount) exists.
//!
//! No provider ever overwrites: an upload onto an existing key fails.

use std::path::{Path, PathBuf};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::db::Db;
use super::{new_id, now_ms, Error, Result};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectMeta {
    pub key: String,
    pub size: u64,
    pub modified_ms: i64,
}

pub trait StorageProvider: Send + Sync {
    fn kind(&self) -> &'static str;
    fn list(&self, prefix: &str) -> Result<Vec<ObjectMeta>>;
    fn upload(&self, local: &Path, key: &str) -> Result<ObjectMeta>;
    fn download(&self, key: &str, local: &Path) -> Result<()>;
    fn exists(&self, key: &str) -> Result<bool>;
    fn get_metadata(&self, key: &str) -> Result<Option<ObjectMeta>>;
    fn delete(&self, key: &str) -> Result<()>;
    fn get_signed_url(&self, key: &str, expires_secs: u64) -> Result<String>;
    /// A path to read the stored bytes directly, when the provider has one
    /// (lets the archive verify a fingerprint without downloading).
    fn local_path(&self, _key: &str) -> Option<PathBuf> {
        None
    }
}

/// Keys look like `originals/2026-09/abcd1234_IMG_0001.ARW`: relative, `/`
/// separated, no empty, `.` or `..` segments.
pub fn validate_key(key: &str) -> Result<()> {
    let bad = key.is_empty()
        || key.starts_with('/')
        || key.contains('\\')
        || key.contains('\0')
        || key.split('/').any(|s| s.is_empty() || s == "." || s == "..");
    if bad { Err(Error::Invalid(format!("not a storage key: {key:?}"))) } else { Ok(()) }
}

pub struct LocalStorageProvider {
    root: PathBuf,
}

impl LocalStorageProvider {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn path(&self, key: &str) -> Result<PathBuf> {
        validate_key(key)?;
        Ok(self.root.join(key))
    }

    fn meta(key: &str, m: &std::fs::Metadata) -> ObjectMeta {
        let modified_ms = m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        ObjectMeta { key: key.to_owned(), size: m.len(), modified_ms }
    }

    fn online(&self) -> Result<()> {
        if self.root.is_dir() { Ok(()) } else { Err(Error::SourceOffline(self.root.display().to_string())) }
    }
}

impl StorageProvider for LocalStorageProvider {
    fn kind(&self) -> &'static str {
        "local"
    }

    fn list(&self, prefix: &str) -> Result<Vec<ObjectMeta>> {
        self.online()?;
        let mut out = Vec::new();
        for entry in walkdir::WalkDir::new(&self.root).into_iter().filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            let Ok(rel) = entry.path().strip_prefix(&self.root) else { continue };
            let key = rel.to_string_lossy().replace('\\', "/");
            if key.ends_with(".partial") || !key.starts_with(prefix) {
                continue;
            }
            if let Ok(m) = entry.metadata() {
                out.push(Self::meta(&key, &m));
            }
        }
        out.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(out)
    }

    fn upload(&self, local: &Path, key: &str) -> Result<ObjectMeta> {
        self.online()?;
        let dest = self.path(key)?;
        if dest.exists() {
            return Err(Error::Invalid(format!("{key} already exists")));
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = dest.with_file_name(format!(
            "{}.{}.partial",
            dest.file_name().unwrap_or_default().to_string_lossy(),
            &new_id()[24..]
        ));
        let copied = std::fs::copy(local, &tmp).and_then(|n| std::fs::File::open(&tmp)?.sync_all().map(|()| n));
        if let Err(e) = copied {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.into());
        }
        // hard_link + remove never replaces an existing file, unlike rename.
        let placed = std::fs::hard_link(&tmp, &dest);
        let _ = std::fs::remove_file(&tmp);
        placed.map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists { Error::Invalid(format!("{key} already exists")) } else { e.into() }
        })?;
        Ok(Self::meta(key, &std::fs::metadata(&dest)?))
    }

    fn download(&self, key: &str, local: &Path) -> Result<()> {
        let src = self.path(key)?;
        if local.exists() {
            return Err(Error::Invalid(format!("{} already exists", local.display())));
        }
        std::fs::copy(src, local)?;
        Ok(())
    }

    fn exists(&self, key: &str) -> Result<bool> {
        self.online()?;
        Ok(self.path(key)?.is_file())
    }

    fn get_metadata(&self, key: &str) -> Result<Option<ObjectMeta>> {
        self.online()?;
        let path = self.path(key)?;
        match std::fs::metadata(&path) {
            Ok(m) if m.is_file() => Ok(Some(Self::meta(key, &m))),
            Ok(_) => Ok(None),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn delete(&self, key: &str) -> Result<()> {
        let path = self.path(key)?;
        match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }

    fn get_signed_url(&self, key: &str, _expires_secs: u64) -> Result<String> {
        let path = self.path(key)?;
        let mut url = String::from("file://");
        for b in path.to_string_lossy().bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => url.push(b as char),
                _ => url.push_str(&format!("%{b:02X}")),
            }
        }
        Ok(url)
    }

    fn local_path(&self, key: &str) -> Option<PathBuf> {
        self.path(key).ok()
    }
}

/// A configured place to archive to. `config` never holds secrets.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub root: String,
    pub online: bool,
    pub archived_count: i64,
    pub archived_bytes: i64,
    pub created_ms: i64,
}

#[derive(Serialize, Deserialize)]
struct LocalConfig {
    root: String,
}

pub fn list_locations(db: &Db) -> Result<Vec<Location>> {
    db.read(|c| {
        let mut stmt = c.prepare(
            "SELECT sl.id, sl.kind, sl.label, sl.config, sl.created_ms,
                    (SELECT COUNT(*) FROM archived_assets aa WHERE aa.location_id = sl.id),
                    (SELECT COALESCE(SUM(size), 0) FROM archived_assets aa WHERE aa.location_id = sl.id)
             FROM storage_locations sl ORDER BY sl.created_ms",
        )?;
        let rows = stmt
            .query_map([], |r| {
                let config: String = r.get(3)?;
                let root = serde_json::from_str::<LocalConfig>(&config).map(|c| c.root).unwrap_or_default();
                Ok(Location {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    label: r.get(2)?,
                    online: Path::new(&root).is_dir(),
                    root,
                    created_ms: r.get(4)?,
                    archived_count: r.get(5)?,
                    archived_bytes: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// Registers a local folder (e.g. on an external drive) as an archive.
pub fn add_local_location(db: &Db, root: &Path, label: Option<&str>) -> Result<Location> {
    let root = root.canonicalize().map_err(|_| Error::Invalid(format!("folder does not exist: {}", root.display())))?;
    if !root.is_dir() {
        return Err(Error::Invalid(format!("not a folder: {}", root.display())));
    }
    let text = root.to_string_lossy().into_owned();
    let label = label
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| text.clone()));
    let config = serde_json::to_string(&LocalConfig { root: text.clone() }).expect("config");
    let id = db.write(|c| {
        let existing: Option<String> = c
            .query_row("SELECT id FROM storage_locations WHERE kind = 'local' AND config = ?1", [&config], |r| r.get(0))
            .optional()?;
        if let Some(id) = existing {
            return Ok(id);
        }
        let id = new_id();
        c.execute(
            "INSERT INTO storage_locations (id, kind, label, config, created_ms) VALUES (?1, 'local', ?2, ?3, ?4)",
            params![id, label, config, now_ms()],
        )?;
        Ok(id)
    })?;
    list_locations(db)?.into_iter().find(|l| l.id == id).ok_or_else(|| Error::Invalid("location vanished".into()))
}

/// Forgets a location. Nothing stored there is deleted.
pub fn remove_location(db: &Db, id: &str) -> Result<()> {
    db.write(|c| {
        let tx = c.transaction()?;
        tx.execute("DELETE FROM archived_assets WHERE location_id = ?1", [id])?;
        tx.execute("DELETE FROM storage_locations WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    })
}

pub fn provider(location: &Location) -> Result<Box<dyn StorageProvider>> {
    match location.kind.as_str() {
        "local" => Ok(Box::new(LocalStorageProvider::new(&location.root))),
        other => Err(Error::Invalid(format!("storage kind {other} is not available yet"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_cannot_escape_the_root() {
        for bad in ["", "/etc/passwd", "a/../../b", "a//b", "./a", "a\\b", "a/."] {
            assert!(validate_key(bad).is_err(), "{bad:?} accepted");
        }
        validate_key("originals/2026-09/abcd1234_IMG_0001.ARW").unwrap();
    }

    #[test]
    fn local_provider_round_trip_without_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("archive");
        std::fs::create_dir(&root).unwrap();
        let src = dir.path().join("photo.jpg");
        std::fs::write(&src, b"original bytes").unwrap();
        let p = LocalStorageProvider::new(&root);

        let meta = p.upload(&src, "originals/2026-09/x_photo.jpg").unwrap();
        assert_eq!(meta.size, 14);
        assert!(p.exists("originals/2026-09/x_photo.jpg").unwrap());
        assert_eq!(p.list("originals/").unwrap().len(), 1);
        assert!(p.upload(&src, "originals/2026-09/x_photo.jpg").is_err(), "must not overwrite");

        let back = dir.path().join("back.jpg");
        p.download("originals/2026-09/x_photo.jpg", &back).unwrap();
        assert_eq!(std::fs::read(&back).unwrap(), b"original bytes");
        assert!(p.get_signed_url("originals/2026-09/x_photo.jpg", 60).unwrap().starts_with("file:///"));

        p.delete("originals/2026-09/x_photo.jpg").unwrap();
        assert!(!p.exists("originals/2026-09/x_photo.jpg").unwrap());
        assert_eq!(std::fs::read(&src).unwrap(), b"original bytes", "the source is untouched");
    }

    #[test]
    fn an_unplugged_drive_is_reported_as_offline() {
        let p = LocalStorageProvider::new("/Volumes/definitely-not-plugged-in");
        assert!(matches!(p.exists("a/b.jpg"), Err(Error::SourceOffline(_))));
    }
}
