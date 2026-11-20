//! One read for the dashboard: library counts, what needs attention, the post
//! pipeline, accounts and recent albums.

use serde::Serialize;

use super::db::Db;
use super::photos::{self, Query};
use super::posts::{self, Pipeline};
use super::sources::{self, Source};
use super::{accounts, albums, Result};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub counts: photos::Counts,
    pub selected_unposted: i64,
    pub cloud_only: i64,
    pub missing: i64,
    pub thumbs_pending: i64,
    pub offline_copies: i64,
    pub pipeline: Pipeline,
    pub accounts: Vec<accounts::Account>,
    pub albums: Vec<albums::Album>,
    pub sources: Vec<Source>,
    pub last_scan_ms: Option<i64>,
}

pub fn summary(db: &Db) -> Result<Summary> {
    let counts = photos::counts(db, &Query::default())?;
    let (selected_unposted, cloud_only, missing, thumbs_pending, offline_copies) = db.read(|c| {
        Ok(c.query_row(
            "SELECT
               (SELECT COUNT(*) FROM photos p WHERE p.review_state = 'selected' AND NOT EXISTS
                  (SELECT 1 FROM post_photos pp JOIN posts po ON po.id = pp.post_id
                   WHERE pp.photo_id = p.id AND po.status = 'published')),
               (SELECT COUNT(*) FROM assets WHERE is_primary = 1 AND storage_state = 'cloud_only'),
               (SELECT COUNT(*) FROM assets WHERE is_primary = 1 AND storage_state = 'missing'),
               (SELECT COUNT(*) FROM photos WHERE thumb_state = 'pending'),
               (SELECT COUNT(DISTINCT photo_id) FROM local_copies)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )?)
    })?;
    let sources = sources::list(db)?;
    let last_scan_ms = sources.iter().filter_map(|s| s.last_scan_finished_ms).max();
    let mut albums = albums::list(db)?;
    albums.truncate(4);
    Ok(Summary {
        counts,
        selected_unposted,
        cloud_only,
        missing,
        thumbs_pending,
        offline_copies,
        pipeline: posts::pipeline(db, None)?,
        accounts: accounts::list(db)?,
        albums,
        sources,
        last_scan_ms,
    })
}
