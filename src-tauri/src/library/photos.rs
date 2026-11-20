use base64::Engine;
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::db::Db;
use super::model::{MediaKind, ReviewState, StorageState, ThumbState};
use super::{albums, auto, labels, now_ms, posts, settings, tags, Error, Result};

/// Settings key: when the last scan that found new files started.
pub const LAST_IMPORT_KEY: &str = "import.lastMs";

/// SQL condition (on `photos p`) for "Last import": photos first indexed by
/// that scan. A moved file keeps its row and creation time, so it never counts.
/// No import yet matches nothing.
pub fn last_import_sql() -> String {
    format!(
        "p.created_ms >= COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = '{LAST_IMPORT_KEY}'), {})",
        i64::MAX
    )
}

/// Scans this close after the start of the last import belong to it: a trip
/// arriving over hours (a slow copy, files syncing in) is one import.
const IMPORT_WINDOW_MS: i64 = 6 * 60 * 60 * 1000;

/// After a scan: if it made new photos, they become the last import. A scan
/// that found nothing new, or only files that joined existing photos (a RAW
/// next to its JPEG), leaves the previous import as it was, and so does one
/// that is part of an import still arriving.
pub fn note_import(db: &Db, started_ms: i64, added: u64) -> Result<()> {
    if added == 0 {
        return Ok(());
    }
    let fresh: i64 = db.read(|c| Ok(c.query_row("SELECT COUNT(*) FROM photos WHERE created_ms >= ?1", [started_ms], |r| r.get(0))?))?;
    if fresh == 0 {
        return Ok(());
    }
    let previous = settings::get(db, LAST_IMPORT_KEY)?.and_then(|v| v.parse::<i64>().ok());
    if previous.is_some_and(|p| p <= started_ms && started_ms - p < IMPORT_WINDOW_MS) {
        return Ok(());
    }
    settings::set(db, LAST_IMPORT_KEY, &started_ms.to_string())
}

/// How a photo has been used on social: derived from posts, never stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Social {
    Unused,
    Assigned,
    Ready,
    Posted,
}

/// One grid tile: deliberately small, because the UI fetches thousands.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoRow {
    pub id: String,
    pub review: ReviewState,
    pub media: MediaKind,
    pub captured_at: String,
    pub filename: String,
    pub storage: StorageState,
    pub thumb: ThumbState,
    pub thumbhash: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub social: Social,
    pub posted_count: i64,
    pub archived: bool,
    /// A look or adjustments are applied.
    pub edited: bool,
    /// Frames in its burst (1 = not part of one) and whether it is the sharpest.
    pub burst: i64,
    pub burst_best: bool,
    pub soft: bool,
    pub is_video: bool,
    /// A video's length in seconds.
    pub duration: Option<f64>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Order {
    #[default]
    Newest,
    Oldest,
    RecentlyReviewed,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SocialFilter {
    Unused,
    Assigned,
    Posted,
    PostedMultiple,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StorageFilter {
    Local,
    CloudOnly,
    Offline,
    Missing,
    Archived,
}

/// The device a photo was taken with: its EXIF make, or for a photo without
/// one, whether it sits in an IPHONE folder (exports from Photos).
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Device {
    Iphone,
    Camera,
}

const BY_IPHONE: &str = r"(COALESCE(p.camera_make, '') = 'Apple' OR (p.camera_make IS NULL AND (a.dir LIKE '%/IPHONE' OR a.dir LIKE '%/IPHONE/%')))";

/// The automatic filters.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Smart {
    Soft,
    Dark,
    Bright,
    BurstExtras,
    Bursts,
    SelectedUnposted,
    NoAlbum,
    Edited,
    NotEditedSelected,
    LastImport,
}

/// Everything the Pictures page can filter and sort by. Every field is optional.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Query {
    pub review: Option<ReviewState>,
    pub order: Order,
    pub album: Option<String>,
    pub tag: Option<String>,
    pub media: Option<MediaKind>,
    pub storage: Option<StorageFilter>,
    pub social: Option<SocialFilter>,
    pub account: Option<String>,
    pub device: Option<Device>,
    pub post: Option<String>,
    /// Inclusive `YYYY-MM-DD` bounds on the capture date.
    pub from: Option<String>,
    pub to: Option<String>,
    pub has_location: Option<bool>,
    pub search: Option<String>,
    /// What's in the photo, exactly as recognised (`blue_sky`): any of them.
    pub labels: Option<Vec<String>>,
    pub smart: Option<Smart>,
    /// A folder (absolute path): the photos in it and in its subfolders.
    pub folder: Option<String>,
    /// Only videos (true) or only photos (false).
    pub video: Option<bool>,
    /// Only these photos.
    pub ids: Option<Vec<String>>,
    /// Leave out photos whose original is gone and that have no copy here
    /// (a file moved or renamed outside the app): the cull can't show them.
    pub hide_missing: Option<bool>,
}

impl Query {
    pub fn review(state: ReviewState) -> Self {
        Self { review: Some(state), ..Self::default() }
    }
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Counts {
    pub all: i64,
    pub unreviewed: i64,
    pub selected: i64,
    pub maybe: i64,
    pub rejected: i64,
}

const FROM: &str = "FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1";
const USED_IN: &str = "SELECT 1 FROM post_photos pp JOIN posts po ON po.id = pp.post_id WHERE pp.photo_id = p.id";
const HAS_COPY: &str = "EXISTS (SELECT 1 FROM local_copies lc WHERE lc.photo_id = p.id)";

fn select_row() -> String {
    format!(
        "SELECT p.id, p.review_state, p.media_kind, p.captured_at, a.filename,
                CASE WHEN {HAS_COPY} THEN 'available_offline' ELSE a.storage_state END,
                p.thumb_state, p.thumbhash, p.width, p.height,
                (SELECT COUNT(*) FROM post_photos pp JOIN posts po ON po.id = pp.post_id
                  WHERE pp.photo_id = p.id AND po.status = 'published'),
                (SELECT COUNT(*) FROM post_photos pp JOIN posts po ON po.id = pp.post_id
                  WHERE pp.photo_id = p.id AND po.status IN ('ready', 'scheduled')),
                (SELECT COUNT(*) FROM post_photos pp JOIN posts po ON po.id = pp.post_id
                  WHERE pp.photo_id = p.id AND po.status IN ('idea', 'building')),
                EXISTS (SELECT 1 FROM archived_assets aa JOIN assets ax ON ax.id = aa.asset_id WHERE ax.photo_id = p.id),
                EXISTS (SELECT 1 FROM photo_looks pl WHERE pl.photo_id = p.id),
                COALESCE(an.burst_size, 1), COALESCE(an.burst_best, 1), an.sharpness,
                p.is_video, p.duration_s
         {FROM} LEFT JOIN photo_analysis an ON an.photo_id = p.id"
    )
}

fn row(r: &Row) -> rusqlite::Result<PhotoRow> {
    let bad = |e: Error| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e));
    let text = |i| -> rusqlite::Result<String> { r.get(i) };
    let hash: Option<Vec<u8>> = r.get(7)?;
    let (posted, ready, drafts): (i64, i64, i64) = (r.get(10)?, r.get(11)?, r.get(12)?);
    Ok(PhotoRow {
        id: text(0)?,
        review: ReviewState::parse(&text(1)?).map_err(bad)?,
        media: MediaKind::parse(&text(2)?).map_err(bad)?,
        captured_at: text(3)?,
        filename: text(4)?,
        storage: StorageState::parse(&text(5)?).map_err(bad)?,
        thumb: ThumbState::parse(&text(6)?).map_err(bad)?,
        thumbhash: hash.map(|h| base64::engine::general_purpose::STANDARD.encode(h)),
        width: r.get(8)?,
        height: r.get(9)?,
        social: if posted > 0 {
            Social::Posted
        } else if ready > 0 {
            Social::Ready
        } else if drafts > 0 {
            Social::Assigned
        } else {
            Social::Unused
        },
        posted_count: posted,
        archived: r.get(13)?,
        edited: r.get(14)?,
        burst: r.get(15)?,
        burst_best: r.get(16)?,
        soft: r.get::<_, Option<f64>>(17)?.is_some_and(|s| s < auto::SOFT_BELOW),
        is_video: r.get(18)?,
        duration: r.get(19)?,
    })
}

/// SQL conditions + their parameters for a query, bound positionally.
struct Filter {
    clauses: Vec<String>,
    params: Vec<Value>,
}

impl Filter {
    fn new(q: &Query, with_review: bool) -> Self {
        let mut f = Filter { clauses: Vec::new(), params: Vec::new() };
        let text = |s: &str| Value::Text(s.to_owned());
        if with_review {
            if let Some(r) = q.review {
                f.add("p.review_state = ?", [text(r.as_str())]);
            }
        }
        if let Some(album) = &q.album {
            f.add("EXISTS (SELECT 1 FROM photo_albums pa WHERE pa.photo_id = p.id AND pa.album_id = ?)", [text(album)]);
        }
        if let Some(folder) = q.folder.as_deref().map(|d| d.trim_end_matches('/')).filter(|d| !d.is_empty()) {
            let under = format!("{}/%", folder.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
            f.add(r"(a.dir = ? OR a.dir LIKE ? ESCAPE '\')", [text(folder), Value::Text(under)]);
        }
        if let Some(tag) = &q.tag {
            f.add("EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.tag_id = ?)", [text(tag)]);
        }
        if let Some(media) = q.media {
            // A photo type: videos are not photos.
            f.add("p.media_kind = ? AND p.is_video = 0", [text(media.as_str())]);
        }
        if let Some(video) = q.video {
            f.add(if video { "p.is_video = 1" } else { "p.is_video = 0" }, []);
        }
        if let Some(storage) = q.storage {
            let sql = match storage {
                StorageFilter::Local => "a.storage_state = 'local'".to_owned(),
                StorageFilter::CloudOnly => format!("a.storage_state = 'cloud_only' AND NOT {HAS_COPY}"),
                StorageFilter::Offline => HAS_COPY.to_owned(),
                StorageFilter::Missing => format!("a.storage_state = 'missing' AND NOT {HAS_COPY}"),
                StorageFilter::Archived => "EXISTS (SELECT 1 FROM archived_assets aa JOIN assets ax ON ax.id = aa.asset_id WHERE ax.photo_id = p.id)".to_owned(),
            };
            f.add(&sql, []);
        }
        if q.hide_missing == Some(true) {
            f.add(&format!("NOT (a.storage_state = 'missing' AND NOT {HAS_COPY})"), []);
        }
        if let Some(social) = q.social {
            let sql = match social {
                SocialFilter::Unused => format!("NOT EXISTS ({USED_IN} AND po.status != 'archived')"),
                SocialFilter::Assigned => format!("EXISTS ({USED_IN} AND po.status IN ('idea', 'building', 'ready', 'scheduled'))"),
                SocialFilter::Posted => format!("EXISTS ({USED_IN} AND po.status = 'published')"),
                SocialFilter::PostedMultiple => "(SELECT COUNT(*) FROM post_photos pp JOIN posts po ON po.id = pp.post_id WHERE pp.photo_id = p.id AND po.status = 'published') >= 2".to_owned(),
            };
            f.add(&sql, []);
        }
        if let Some(account) = &q.account {
            f.add(&format!("EXISTS ({USED_IN} AND po.account_id = ?)"), [text(account)]);
        }
        if let Some(ids) = &q.ids {
            let marks = vec!["?"; ids.len()].join(", ");
            f.add(&if ids.is_empty() { "0".to_owned() } else { format!("p.id IN ({marks})") }, ids.iter().map(|i| text(i)));
        }
        if let Some(device) = q.device {
            f.add(&if device == Device::Iphone { BY_IPHONE.to_owned() } else { format!("NOT {BY_IPHONE}") }, []);
        }
        if let Some(post) = &q.post {
            f.add("EXISTS (SELECT 1 FROM post_photos pp WHERE pp.photo_id = p.id AND pp.post_id = ?)", [text(post)]);
        }
        if let Some(from) = &q.from {
            f.add("p.captured_at >= ?", [text(from)]);
        }
        if let Some(to) = &q.to {
            // "T~" sorts after any time of day, so the whole end date is included.
            f.add("p.captured_at <= ?", [text(&format!("{to}T~"))]);
        }
        if let Some(smart) = q.smart {
            let an = |cond: &str| format!("EXISTS (SELECT 1 FROM photo_analysis x WHERE x.photo_id = p.id AND {cond})");
            let sql = match smart {
                Smart::Soft => an(&format!("x.sharpness < {}", auto::SOFT_BELOW)),
                Smart::Dark => an("x.brightness < 0.18"),
                Smart::Bright => an("(x.clip_hi > 0.08 OR x.brightness > 0.82)"),
                Smart::BurstExtras => an("x.burst_size > 1 AND x.burst_best = 0"),
                Smart::Bursts => an("x.burst_size > 1"),
                Smart::SelectedUnposted => {
                    format!("p.review_state = 'selected' AND NOT EXISTS ({USED_IN} AND po.status = 'published')")
                }
                Smart::NoAlbum => "NOT EXISTS (SELECT 1 FROM photo_albums pa WHERE pa.photo_id = p.id)".to_owned(),
                Smart::Edited => "EXISTS (SELECT 1 FROM photo_looks pl WHERE pl.photo_id = p.id)".to_owned(),
                Smart::NotEditedSelected => {
                    "p.review_state = 'selected' AND NOT EXISTS (SELECT 1 FROM photo_looks pl WHERE pl.photo_id = p.id)".to_owned()
                }
                Smart::LastImport => last_import_sql(),
            };
            f.add(&sql, []);
        }
        match q.has_location {
            Some(true) => f.add("p.latitude IS NOT NULL", []),
            Some(false) => f.add("p.latitude IS NULL", []),
            None => {}
        }
        if let Some(labels) = q.labels.as_ref().filter(|l| !l.is_empty()) {
            let marks = vec!["?"; labels.len()].join(", ");
            f.add(
                &format!(
                    "EXISTS (SELECT 1 FROM photo_labels pl WHERE pl.photo_id = p.id AND pl.confidence >= {} AND pl.label IN ({marks}))",
                    labels::SEARCH_CONFIDENCE
                ),
                labels.iter().map(|l| text(l)),
            );
        }
        if let Some(term) = q.search.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            let like = |t: &str| format!("%{}%", t.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
            // The folder is matched relative to its source ("Trips/Pai"), so the
            // source's own path never matches everything in it. Dates match as
            // written: "2026-03", "2026-03-14".
            const FIELDS: &str = r"(a.filename LIKE ? ESCAPE '\'
                  OR p.review_state LIKE ? ESCAPE '\'
                  OR substr(a.dir, length((SELECT s.path FROM sources s WHERE s.id = a.source_id)) + 2) LIKE ? ESCAPE '\'
                  OR p.captured_at LIKE ? ESCAPE '\'
                  OR p.camera_model LIKE ? ESCAPE '\'
                  OR EXISTS (SELECT 1 FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
                             WHERE pt.photo_id = p.id AND t.name LIKE ? ESCAPE '\')
                  OR EXISTS (SELECT 1 FROM photo_albums pa JOIN albums al ON al.id = pa.album_id
                             WHERE pa.photo_id = p.id AND al.name LIKE ? ESCAPE '\')
                  OR EXISTS (SELECT 1 FROM post_photos pp JOIN posts po ON po.id = pp.post_id
                             LEFT JOIN accounts ac ON ac.id = po.account_id
                             WHERE pp.photo_id = p.id
                               AND (po.title LIKE ? ESCAPE '\' OR po.status LIKE ? ESCAPE '\' OR ac.username LIKE ? ESCAPE '\'))
                  OR EXISTS (SELECT 1 FROM video_transcripts vt WHERE vt.photo_id = p.id AND vt.text LIKE ? ESCAPE '\'))";
            let mut sql = FIELDS.to_owned();
            let mut values: Vec<Value> = std::iter::repeat_n(Value::Text(like(term)), 11).collect();
            // Or word by word, each in those fields or in what's in the photo:
            // "sunset nepal" finds sunsets in the NEPAL folder.
            let words = labels::words(term);
            if !words.is_empty() {
                let mut clauses = Vec::new();
                for w in &words {
                    let mut content: Vec<String> = Vec::new();
                    let mut content_values: Vec<Value> = Vec::new();
                    for form in &w.forms {
                        content.push("('_' || pl.label || '_') LIKE ? ESCAPE '\\'".to_owned());
                        content_values.push(Value::Text(format!("%\\_{form}\\_%")));
                    }
                    for syn in &w.synonyms {
                        content.push("pl.label = ?".to_owned());
                        content_values.push(Value::Text(syn.clone()));
                    }
                    clauses.push(format!(
                        "({FIELDS} OR EXISTS (SELECT 1 FROM photo_labels pl WHERE pl.photo_id = p.id AND pl.confidence >= {} AND ({})))",
                        labels::SEARCH_CONFIDENCE,
                        content.join(" OR ")
                    ));
                    values.extend(std::iter::repeat_n(Value::Text(like(&w.text)), 11));
                    values.extend(content_values);
                }
                sql = format!("{sql} OR ({})", clauses.join(" AND "));
            }
            f.add(&sql, values);
        }
        f
    }

    fn add(&mut self, sql: &str, params: impl IntoIterator<Item = Value>) {
        self.clauses.push(format!("({sql})"));
        self.params.extend(params);
    }

    fn sql(&self) -> String {
        if self.clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", self.clauses.join(" AND "))
        }
    }
}

fn order_by(order: Order) -> &'static str {
    match order {
        Order::Newest => "ORDER BY p.captured_at DESC, p.id DESC",
        Order::Oldest => "ORDER BY p.captured_at ASC, p.id ASC",
        Order::RecentlyReviewed => "ORDER BY COALESCE(p.reviewed_ms, 0) DESC, p.id DESC",
    }
}

/// A window of the (filtered, ordered) library for the virtualised grid.
pub fn list(db: &Db, q: &Query, offset: i64, limit: i64) -> Result<Vec<PhotoRow>> {
    db.read(|c| {
        let f = Filter::new(q, true);
        let sql = format!("{} {} {} LIMIT ? OFFSET ?", select_row(), f.sql(), order_by(q.order));
        let mut params = f.params;
        params.extend([Value::Integer(limit), Value::Integer(offset)]);
        let mut stmt = c.prepare_cached(&sql)?;
        let rows = stmt.query_map(params_from_iter(params), row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// Just the ids of a window - for range selection and "select all".
pub fn ids(db: &Db, q: &Query, offset: i64, limit: i64) -> Result<Vec<String>> {
    db.read(|c| {
        let f = Filter::new(q, true);
        let sql = format!("SELECT p.id {FROM} {} {} LIMIT ? OFFSET ?", f.sql(), order_by(q.order));
        let mut params = f.params;
        params.extend([Value::Integer(limit), Value::Integer(offset)]);
        let mut stmt = c.prepare_cached(&sql)?;
        let ids = stmt.query_map(params_from_iter(params), |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(ids)
    })
}

/// Review counts within every other filter of the query, for the tab badges.
pub fn counts(db: &Db, q: &Query) -> Result<Counts> {
    db.read(|c| {
        let f = Filter::new(q, false);
        let sql = format!("SELECT p.review_state, COUNT(*) {FROM} {} GROUP BY p.review_state", f.sql());
        let mut stmt = c.prepare_cached(&sql)?;
        let mut rows = stmt.query(params_from_iter(f.params))?;
        let mut counts = Counts::default();
        while let Some(r) = rows.next()? {
            let n: i64 = r.get(1)?;
            counts.all += n;
            match ReviewState::parse(&r.get::<_, String>(0)?)? {
                ReviewState::Unreviewed => counts.unreviewed = n,
                ReviewState::Selected => counts.selected = n,
                ReviewState::Maybe => counts.maybe = n,
                ReviewState::Rejected => counts.rejected = n,
            }
        }
        Ok(counts)
    })
}

/// Where a photo sits in a filtered, ordered view (to open it in context).
pub fn position(db: &Db, q: &Query, id: &str) -> Result<Option<i64>> {
    db.read(|c| {
        let key: Option<(String, i64)> = c
            .query_row("SELECT captured_at, COALESCE(reviewed_ms, 0) FROM photos WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        let Some((at, reviewed)) = key else { return Ok(None) };
        let (before, a, b) = match q.order {
            Order::Newest => ("(p.captured_at > ? OR (p.captured_at = ? AND p.id > ?))", Value::Text(at.clone()), Value::Text(at)),
            Order::Oldest => ("(p.captured_at < ? OR (p.captured_at = ? AND p.id < ?))", Value::Text(at.clone()), Value::Text(at)),
            Order::RecentlyReviewed => (
                "(COALESCE(p.reviewed_ms, 0) > ? OR (COALESCE(p.reviewed_ms, 0) = ? AND p.id > ?))",
                Value::Integer(reviewed),
                Value::Integer(reviewed),
            ),
        };
        // Not in this (filtered) view at all: no position.
        let mut own = Filter::new(q, true);
        own.add("p.id = ?", [Value::Text(id.to_owned())]);
        let present: i64 = c.query_row(&format!("SELECT COUNT(*) {FROM} {}", own.sql()), params_from_iter(own.params), |r| r.get(0))?;
        if present == 0 {
            return Ok(None);
        }
        let mut f = Filter::new(q, true);
        f.add(before, [a, b, Value::Text(id.to_owned())]);
        let n: i64 = c.query_row(&format!("SELECT COUNT(*) {FROM} {}", f.sql()), params_from_iter(f.params), |r| r.get(0))?;
        Ok(Some(n))
    })
}

/// The next (`dir` = 1) or previous (-1) photo after `id` in this view's order,
/// with its position. Works even when `id` itself has just left the view (a
/// photo marked out of "Unreviewed"), because it goes by the photo's sort key.
pub fn neighbor(db: &Db, q: &Query, id: &str, dir: i32) -> Result<Option<(String, i64)>> {
    let found = db.read(|c| {
        let key: Option<(String, i64)> = c
            .query_row("SELECT captured_at, COALESCE(reviewed_ms, 0) FROM photos WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        let Some((at, reviewed)) = key else { return Ok(None) };
        // "after" in display order, for dir = 1; "before" for dir = -1.
        let (cond, a, b, order) = match (q.order, dir > 0) {
            (Order::Newest, true) => ("(p.captured_at < ? OR (p.captured_at = ? AND p.id < ?))", Value::Text(at.clone()), Value::Text(at), "ORDER BY p.captured_at DESC, p.id DESC"),
            (Order::Newest, false) => ("(p.captured_at > ? OR (p.captured_at = ? AND p.id > ?))", Value::Text(at.clone()), Value::Text(at), "ORDER BY p.captured_at ASC, p.id ASC"),
            (Order::Oldest, true) => ("(p.captured_at > ? OR (p.captured_at = ? AND p.id > ?))", Value::Text(at.clone()), Value::Text(at), "ORDER BY p.captured_at ASC, p.id ASC"),
            (Order::Oldest, false) => ("(p.captured_at < ? OR (p.captured_at = ? AND p.id < ?))", Value::Text(at.clone()), Value::Text(at), "ORDER BY p.captured_at DESC, p.id DESC"),
            (Order::RecentlyReviewed, true) => (
                "(COALESCE(p.reviewed_ms, 0) < ? OR (COALESCE(p.reviewed_ms, 0) = ? AND p.id < ?))",
                Value::Integer(reviewed),
                Value::Integer(reviewed),
                "ORDER BY COALESCE(p.reviewed_ms, 0) DESC, p.id DESC",
            ),
            (Order::RecentlyReviewed, false) => (
                "(COALESCE(p.reviewed_ms, 0) > ? OR (COALESCE(p.reviewed_ms, 0) = ? AND p.id > ?))",
                Value::Integer(reviewed),
                Value::Integer(reviewed),
                "ORDER BY COALESCE(p.reviewed_ms, 0) ASC, p.id ASC",
            ),
        };
        let mut f = Filter::new(q, true);
        f.add(cond, [a, b, Value::Text(id.to_owned())]);
        let sql = format!("SELECT p.id {FROM} {} {order} LIMIT 1", f.sql());
        Ok(c.query_row(&sql, params_from_iter(f.params), |r| r.get::<_, String>(0)).optional()?)
    })?;
    match found {
        Some(next) => Ok(position(db, q, &next)?.map(|at| (next, at))),
        None => Ok(None),
    }
}

/// Which of these photos are in this (filtered) view: used to drop picks that
/// were marked out of it, so a hidden photo is never acted on.
pub fn in_view(db: &Db, q: &Query, ids: &[String]) -> Result<Vec<String>> {
    db.read(|c| {
        let mut out = Vec::new();
        for chunk in ids.chunks(500) {
            let mut f = Filter::new(q, true);
            let marks = vec!["?"; chunk.len()].join(",");
            f.add(&format!("p.id IN ({marks})"), chunk.iter().map(|i| Value::Text(i.clone())));
            let mut stmt = c.prepare(&format!("SELECT p.id {FROM} {}", f.sql()))?;
            let found = stmt.query_map(params_from_iter(f.params), |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            out.extend(found);
        }
        Ok(out)
    })
}

/// A photo's review mark with the time it was made, for undo.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewMark {
    pub id: String,
    pub review: ReviewState,
    pub reviewed_ms: Option<i64>,
}

pub fn review_marks(db: &Db, ids: &[String]) -> Result<Vec<ReviewMark>> {
    db.read(|c| {
        let mut stmt = c.prepare_cached("SELECT review_state, reviewed_ms FROM photos WHERE id = ?1")?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some((state, at)) = stmt.query_row([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?))).optional()? {
                out.push(ReviewMark { id: id.clone(), review: ReviewState::parse(&state)?, reviewed_ms: at });
            }
        }
        Ok(out)
    })
}

/// Undo: puts marks back exactly as they were, including when they were made,
/// so "Recently reviewed" keeps its order.
pub fn restore_marks(db: &Db, marks: &[ReviewMark]) -> Result<usize> {
    db.write(|c| {
        let tx = c.transaction()?;
        let mut n = 0;
        {
            let mut stmt = tx.prepare_cached("UPDATE photos SET review_state = ?2, reviewed_ms = ?3, updated_ms = ?4 WHERE id = ?1")?;
            let now = now_ms();
            for m in marks {
                n += stmt.execute(params![m.id, m.review.as_str(), m.reviewed_ms, now])?;
            }
        }
        tx.commit()?;
        Ok(n)
    })
}

/// Marks photos. Rejecting only ever changes this field.
pub fn set_review(db: &Db, ids: &[String], state: ReviewState) -> Result<usize> {
    db.write(|c| {
        let tx = c.transaction()?;
        let now = now_ms();
        let mut changed = 0;
        {
            let mut stmt =
                tx.prepare_cached("UPDATE photos SET review_state = ?2, reviewed_ms = ?3, updated_ms = ?3 WHERE id = ?1")?;
            for id in ids {
                changed += stmt.execute(params![id, state.as_str(), now])?;
            }
        }
        tx.commit()?;
        Ok(changed)
    })
}

pub fn review_of(c: &Connection, id: &str) -> Result<Option<ReviewState>> {
    let s: Option<String> = c.query_row("SELECT review_state FROM photos WHERE id = ?1", [id], |r| r.get(0)).optional()?;
    s.map(|s| ReviewState::parse(&s)).transpose()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInfo {
    pub id: String,
    pub filename: String,
    pub path: String,
    pub format: String,
    pub size: i64,
    pub storage: StorageState,
    pub is_primary: bool,
    pub is_raw: bool,
    pub local_copy: Option<String>,
    pub archived_to: Vec<String>,
    pub finder_tagged: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoDetail {
    #[serde(flatten)]
    pub row: PhotoRow,
    pub captured_at_source: String,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub assets: Vec<AssetInfo>,
    pub albums: Vec<albums::AlbumRef>,
    pub tags: Vec<tags::Tag>,
    pub history: Vec<posts::Usage>,
}

pub fn detail(db: &Db, id: &str) -> Result<PhotoDetail> {
    db.read(|c| {
        let row = c
            .query_row(&format!("{} WHERE p.id = ?1", select_row()), [id], row)
            .optional()?
            .ok_or_else(|| Error::Invalid(format!("unknown photo {id}")))?;
        let (captured_at_source, camera_make, camera_model, latitude, longitude) = c.query_row(
            "SELECT captured_at_source, camera_make, camera_model, latitude, longitude FROM photos WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )?;
        let mut stmt = c.prepare_cached(
            "SELECT a.id, a.filename, a.path, a.format, a.size, a.storage_state, a.is_primary, a.is_raw,
                    (SELECT lc.path FROM local_copies lc WHERE lc.asset_id = a.id),
                    (SELECT group_concat(sl.label, '\u{1f}') FROM archived_assets aa
                       JOIN storage_locations sl ON sl.id = aa.location_id WHERE aa.asset_id = a.id),
                    EXISTS (SELECT 1 FROM finder_tags ft WHERE ft.asset_id = a.id)
             FROM assets a WHERE a.photo_id = ?1 ORDER BY a.is_primary DESC, a.filename",
        )?;
        let assets = stmt
            .query_map([id], |r| {
                let state: String = r.get(5)?;
                let archived: Option<String> = r.get(9)?;
                Ok(AssetInfo {
                    id: r.get(0)?,
                    filename: r.get(1)?,
                    path: r.get(2)?,
                    format: r.get(3)?,
                    size: r.get(4)?,
                    storage: StorageState::parse(&state).unwrap_or(StorageState::Missing),
                    is_primary: r.get(6)?,
                    is_raw: r.get(7)?,
                    local_copy: r.get(8)?,
                    archived_to: archived.map(|s| s.split('\u{1f}').map(str::to_owned).collect()).unwrap_or_default(),
                    finder_tagged: r.get(10)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(PhotoDetail {
            row,
            captured_at_source,
            camera_make,
            camera_model,
            latitude,
            longitude,
            assets,
            albums: albums::for_photo(c, id)?,
            tags: tags::for_photo(c, id)?,
            history: posts::history_for_photo(c, id)?,
        })
    })
}

/// A few rows by id, in the order given (post carousels, pickers).
pub fn rows_by_id(c: &Connection, ids: &[String]) -> Result<Vec<PhotoRow>> {
    let mut stmt = c.prepare_cached(&format!("{} WHERE p.id = ?1", select_row()))?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(r) = stmt.query_row([id], row).optional()? {
            out.push(r);
        }
    }
    Ok(out)
}

/// `rows_by_id` on its own connection (tests and one-off callers).
pub fn rows_by_id_for_test(db: &Db, ids: &[String]) -> Vec<PhotoRow> {
    db.read(|c| rows_by_id(c, ids)).expect("rows")
}

/// One trip folder for the Pictures sidebar: a folder of a source (first and
/// second level), with how many photos it holds including its subfolders.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub path: String,
    pub name: String,
    pub source: String,
    /// 1 = directly in the source folder, 2 = one below.
    pub depth: u8,
    pub count: i64,
}

/// The folders photos live in, grouped two levels deep under each source,
/// sorted by name. Photos lying loose in a source folder are not a trip.
pub fn folders(db: &Db) -> Result<Vec<Folder>> {
    let rows: Vec<(String, String, String, i64)> = db.read(|c| {
        let mut stmt = c.prepare(
            "SELECT s.label, s.path, a.dir, COUNT(*) FROM photos p
             JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
             JOIN sources s ON s.id = a.source_id
             WHERE a.storage_state != 'missing'
             GROUP BY s.id, a.dir",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;
    let mut tally: std::collections::BTreeMap<(String, String), (String, String, u8, i64)> = std::collections::BTreeMap::new();
    for (label, root, dir, count) in rows {
        let Some(rel) = dir.strip_prefix(&root).map(|r| r.trim_start_matches('/')) else { continue };
        let parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
        for depth in 1..=parts.len().min(2) {
            let path = format!("{root}/{}", parts[..depth].join("/"));
            let key = (label.clone(), path.clone());
            let e = tally.entry(key).or_insert((path, parts[depth - 1].to_owned(), depth as u8, 0));
            e.3 += count;
        }
    }
    Ok(tally
        .into_iter()
        .map(|((source, _), (path, name, depth, count))| Folder { path, name, source, depth, count })
        .collect())
}

/// The frames of this photo's burst in shooting order (just the photo itself
/// when it is not part of one), for comparing them side by side.
pub fn burst(db: &Db, id: &str) -> Result<Vec<PhotoRow>> {
    db.read(|c| {
        let ids: Vec<String> = c
            .prepare(
                "SELECT p.id FROM photos p JOIN photo_analysis an ON an.photo_id = p.id
                 WHERE an.burst_id IS NOT NULL AND an.burst_id = (SELECT burst_id FROM photo_analysis WHERE photo_id = ?1)
                 ORDER BY p.captured_at, p.id",
            )?
            .query_map([id], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        let ids = if ids.is_empty() { vec![id.to_owned()] } else { ids };
        rows_by_id(c, &ids)
    })
}
