//! What's in each photo, for searching by content ("temple", "beach",
//! "sunset"): Apple's on-device image recognition of the tile or preview
//! already on this Mac, run in the background by the `vision` helper. Nothing
//! is uploaded and originals are never read for it.

use std::path::{Path, PathBuf};

use rusqlite::params;

use super::db::Db;
use super::thumbs::Cache;
use super::{now_ms, Result};

/// Labels below this confidence don't count when searching.
pub const SEARCH_CONFIDENCE: f64 = 0.25;

/// Everyday words mapped to the recogniser's own categories (it has 1,303,
/// e.g. `sunset_sunrise`, `rice_field`, `people`).
const SYNONYMS: &[(&str, &[&str])] = &[
    ("dawn", &["sunset_sunrise"]),
    ("sunrise", &["sunset_sunrise"]),
    ("sunset", &["sunset_sunrise"]),
    ("dusk", &["sunset_sunrise"]),
    ("golden", &["sunset_sunrise"]),
    ("sea", &["ocean", "beach"]),
    ("coast", &["beach", "ocean"]),
    ("shore", &["beach"]),
    ("temple", &["monument", "statue"]),
    ("pagoda", &["monument"]),
    ("shrine", &["monument", "statue"]),
    ("stupa", &["monument"]),
    ("church", &["monument", "building"]),
    ("mosque", &["monument", "building"]),
    ("buddha", &["statue"]),
    ("person", &["people", "adult"]),
    ("man", &["people", "adult"]),
    ("men", &["people", "adult"]),
    ("woman", &["people", "adult"]),
    ("women", &["people", "adult"]),
    ("portrait", &["people", "adult"]),
    ("kid", &["child"]),
    ("kids", &["child"]),
    ("children", &["child"]),
    ("city", &["cityscape", "street", "skyscraper"]),
    ("town", &["street", "building"]),
    ("meal", &["food"]),
    ("dinner", &["food"]),
    ("lunch", &["food"]),
    ("breakfast", &["food"]),
    ("motorbike", &["motorcycle", "scooter"]),
    ("moped", &["scooter", "motorcycle"]),
    ("tuktuk", &["rickshaw"]),
    ("waterfalls", &["waterfall"]),
    ("hike", &["hiking", "trail"]),
    ("terrace", &["rice_field"]),
    ("terraces", &["rice_field"]),
];

const STOP_WORDS: &[&str] = &["a", "an", "the", "at", "in", "on", "of", "with", "and", "or", "by", "to", "from", "my", "photo", "photos", "picture", "pictures", "shot", "shots"];

/// A search word, and the categories it stands for.
pub struct Word {
    pub text: String,
    /// The word and its singular, matched against each category's parts.
    pub forms: Vec<String>,
    pub synonyms: Vec<String>,
}

/// The words of a search that mean something (lowercase, filler words out).
pub fn words(search: &str) -> Vec<Word> {
    search
        .split(|c: char| !c.is_alphanumeric() && c != '-')
        .map(|w| w.trim().to_lowercase())
        .filter(|w| w.len() > 1 && !STOP_WORDS.contains(&w.as_str()))
        .map(|w| {
            let singular = w.strip_suffix("ies").map(|s| format!("{s}y")).or_else(|| w.strip_suffix("es").filter(|s| s.ends_with('s') || s.ends_with("ch") || s.ends_with("sh")).map(str::to_owned)).or_else(|| w.strip_suffix('s').filter(|s| s.len() > 2).map(str::to_owned));
            let mut forms = vec![w.clone()];
            forms.extend(singular.filter(|s| *s != w));
            let synonyms = SYNONYMS.iter().filter(|(k, _)| forms.iter().any(|f| f == k)).flat_map(|(_, v)| v.iter().map(|s| s.to_string())).collect();
            Word { text: w, forms, synonyms }
        })
        .collect()
}

/// Something the recogniser found, and in how many photos.
#[derive(Clone, Debug, serde::Serialize, PartialEq)]
pub struct LabelCount {
    pub label: String,
    pub count: i64,
}

/// Every label found in at least one photo (confidently enough to search
/// by), most common first, with the everyday words that stand for them.
#[derive(Clone, Debug, serde::Serialize)]
pub struct LabelList {
    pub labels: Vec<LabelCount>,
    pub synonyms: Vec<(&'static str, &'static [&'static str])>,
}

pub fn list(db: &Db) -> Result<LabelList> {
    let labels = db.read(|c| {
        let mut stmt = c.prepare_cached(
            "SELECT label, COUNT(*) FROM photo_labels WHERE confidence >= ?1 GROUP BY label ORDER BY COUNT(*) DESC, label",
        )?;
        let rows = stmt
            .query_map([SEARCH_CONFIDENCE], |r| Ok(LabelCount { label: r.get(0)?, count: r.get(1)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })?;
    Ok(LabelList { labels, synonyms: SYNONYMS.to_vec() })
}

/// Photos with a tile but not recognised yet, newest first.
pub fn pending(db: &Db, limit: i64) -> Result<Vec<String>> {
    db.read(|c| {
        let mut stmt = c.prepare_cached(
            "SELECT id FROM photos WHERE thumb_state = 'ready' AND labelled_ms IS NULL ORDER BY captured_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(rows)
    })
}

pub fn count_pending(db: &Db) -> Result<i64> {
    db.read(|c| Ok(c.query_row("SELECT COUNT(*) FROM photos WHERE thumb_state = 'ready' AND labelled_ms IS NULL", [], |r| r.get(0))?))
}

/// Replaces a photo's labels.
pub fn record(db: &Db, photo_id: &str, labels: &[(String, f64)]) -> Result<()> {
    db.write(|c| {
        let tx = c.transaction()?;
        tx.execute("DELETE FROM photo_labels WHERE photo_id = ?1", [photo_id])?;
        {
            let mut ins = tx.prepare_cached("INSERT OR REPLACE INTO photo_labels (photo_id, label, confidence) VALUES (?1, ?2, ?3)")?;
            for (label, confidence) in labels {
                ins.execute(params![photo_id, label, confidence])?;
            }
        }
        tx.execute("UPDATE photos SET labelled_ms = ?2 WHERE id = ?1", params![photo_id, now_ms()])?;
        tx.commit()?;
        Ok(())
    })
}

/// A photo's labels, most confident first.
pub fn for_photo(db: &Db, photo_id: &str) -> Result<Vec<(String, f64)>> {
    db.read(|c| {
        let mut stmt = c.prepare_cached("SELECT label, confidence FROM photo_labels WHERE photo_id = ?1 ORDER BY confidence DESC")?;
        let rows = stmt.query_map([photo_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// Recognises what's in photos that haven't been, in batches, from files
/// already on this Mac. `progress(done, total)`. Stops when `cancel` is set.
pub fn run_backlog(
    db: &Db,
    cache: &Cache,
    helper: &Path,
    cancel: &std::sync::atomic::AtomicBool,
    mut progress: impl FnMut(usize, usize),
) -> Result<usize> {
    use std::sync::atomic::Ordering;
    let total = count_pending(db)? as usize;
    let mut done = 0;
    progress(0, total);
    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let ids = pending(db, 40)?;
        if ids.is_empty() {
            break;
        }
        let files: Vec<(String, PathBuf)> = ids
            .iter()
            .map(|id| {
                let preview = cache.preview(id);
                (id.clone(), if preview.is_file() { preview } else { cache.thumb(id) })
            })
            .collect();
        let present: Vec<&(String, PathBuf)> = files.iter().filter(|(_, f)| f.is_file()).collect();
        let mut seen = std::collections::HashSet::new();
        if !present.is_empty() {
            let out = std::process::Command::new(helper).arg("--labels").args(present.iter().map(|(_, f)| f)).output()?;
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                let file = v.get("file").and_then(|f| f.as_str()).unwrap_or_default();
                let Some((id, _)) = present.iter().find(|(_, f)| f.to_string_lossy() == file) else { continue };
                let labels: Vec<(String, f64)> = v
                    .get("labels")
                    .and_then(|l| l.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|pair| Some((pair.get(0)?.as_str()?.to_owned(), pair.get(1)?.as_f64()?)))
                            .collect()
                    })
                    .unwrap_or_default();
                record(db, id, &labels)?;
                seen.insert(id.clone());
            }
        }
        // No file to look at, or it couldn't be read: counted as done, so the
        // queue always moves on (a rescan of the photo brings it back).
        for (id, _) in &files {
            if !seen.contains(id) {
                record(db, id, &[])?;
            }
        }
        done += files.len();
        progress(done.min(total), total);
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_words_and_what_they_stand_for() {
        let w = words("Temples at dawn in the mountains");
        let texts: Vec<&str> = w.iter().map(|x| x.text.as_str()).collect();
        assert_eq!(texts, ["temples", "dawn", "mountains"]);
        assert!(w[0].forms.contains(&"temple".to_owned()));
        assert!(w[0].synonyms.contains(&"monument".to_owned()));
        assert_eq!(w[1].synonyms, ["sunset_sunrise"]);
        assert!(w[2].forms.contains(&"mountain".to_owned()));
        assert!(words("a photo of the").is_empty());
    }
}
