//! The automatic part: measurements taken from each thumbnail (sharpness,
//! exposure, clipping, colour cast), burst grouping, smart filters and auto
//! tone. Everything here is a suggestion: nothing is ever rejected or edited
//! without the user doing it.

use rusqlite::{params, Connection};
use serde::Serialize;

use super::db::Db;
use super::looks::Adjustments;
use super::{now_ms, pairing, photos, Error, Result};

/// Below this sharpness a photo counts as soft (see `stats`).
pub const SOFT_BELOW: f64 = 6.0;
/// Frames closer together than this belong to one burst...
const BURST_GAP_MS: i64 = 2_000;
/// ...as long as the whole burst stays this short: a walk shot every 1.5 s is
/// a series of photos, not one burst.
const BURST_SPAN_MS: i64 = 4_000;
/// Beyond bursts, frames join a scene when they look nearly the same (their
/// thumbnails' difference hashes this few bits apart) and were shot this close
/// together, with the whole scene this short.
const SCENE_GAP_MS: i64 = 90_000;
const SCENE_SPAN_MS: i64 = 600_000;
const SIMILAR_BITS: u32 = 8;
/// Against the scene's first frame too, so a slow pan doesn't chain into one scene.
const SIMILAR_TO_FIRST_BITS: u32 = 12;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageStats {
    /// Detail relative to contrast: variance of the Laplacian over the
    /// variance of the image, so a foggy but sharp frame is not called soft.
    pub sharpness: f64,
    /// Mean luma, 0..1.
    pub brightness: f64,
    /// Share of pixels at the top / bottom of the range.
    pub clip_hi: f64,
    pub clip_lo: f64,
    /// Luma percentiles, 0..1.
    pub p01: f64,
    pub p50: f64,
    pub p99: f64,
    pub mean_r: f64,
    pub mean_g: f64,
    pub mean_b: f64,
    /// Difference hash of the frame (9 × 8 luma grid): look-alike frames differ in few bits.
    pub dhash: Option<i64>,
}

/// The 64-bit difference hash of a luma image: each bit says whether a cell of
/// a 9 × 8 grid is darker than its right-hand neighbour.
fn dhash(w: usize, h: usize, luma: &[f64]) -> Option<i64> {
    if w < 9 || h < 8 {
        return None;
    }
    let mut cells = [[0f64; 9]; 8];
    for (r, row) in cells.iter_mut().enumerate() {
        let (y0, y1) = (r * h / 8, ((r + 1) * h / 8).max(r * h / 8 + 1));
        for (c, cell) in row.iter_mut().enumerate() {
            let (x0, x1) = (c * w / 9, ((c + 1) * w / 9).max(c * w / 9 + 1));
            let mut sum = 0f64;
            for y in y0..y1 {
                for x in x0..x1 {
                    sum += luma[y * w + x];
                }
            }
            *cell = sum / ((y1 - y0) * (x1 - x0)) as f64;
        }
    }
    let mut bits = 0u64;
    for row in &cells {
        for c in 0..8 {
            bits = (bits << 1) | u64::from(row[c] < row[c + 1]);
        }
    }
    Some(bits as i64)
}

/// How many bits two difference hashes differ in.
pub fn distance(a: i64, b: i64) -> u32 {
    (a ^ b).count_ones()
}

/// Measures an RGBA image (a thumbnail, ~320 px).
pub fn stats(w: usize, h: usize, rgba: &[u8]) -> ImageStats {
    let n = w * h;
    if n == 0 || rgba.len() < n * 4 {
        return ImageStats::default();
    }
    let mut luma = vec![0f64; n];
    let mut hist = [0u32; 256];
    let (mut sr, mut sg, mut sb) = (0f64, 0f64, 0f64);
    let (mut hi, mut lo) = (0usize, 0usize);
    for i in 0..n {
        let (r, g, b) = (rgba[i * 4] as f64, rgba[i * 4 + 1] as f64, rgba[i * 4 + 2] as f64);
        let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        luma[i] = y;
        hist[y.round().clamp(0.0, 255.0) as usize] += 1;
        sr += r;
        sg += g;
        sb += b;
        if r >= 250.0 || g >= 250.0 || b >= 250.0 {
            hi += 1;
        }
        if y <= 5.0 {
            lo += 1;
        }
    }
    let pct = |p: f64| {
        let target = (p * n as f64).ceil() as u32;
        let mut acc = 0u32;
        for (v, c) in hist.iter().enumerate() {
            acc += c;
            if acc >= target.max(1) {
                return v as f64 / 255.0;
            }
        }
        1.0
    };
    let mean = luma.iter().sum::<f64>() / n as f64;
    let var = luma.iter().map(|y| (y - mean).powi(2)).sum::<f64>() / n as f64;
    let mut lap_sum = 0f64;
    let mut lap_sq = 0f64;
    let mut count = 0f64;
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            let c = luma[y * w + x];
            let l = luma[y * w + x - 1] + luma[y * w + x + 1] + luma[(y - 1) * w + x] + luma[(y + 1) * w + x] - 4.0 * c;
            lap_sum += l;
            lap_sq += l * l;
            count += 1.0;
        }
    }
    let lap_var = if count > 0.0 { lap_sq / count - (lap_sum / count).powi(2) } else { 0.0 };
    ImageStats {
        sharpness: lap_var / (var + 25.0) * 10.0,
        brightness: mean / 255.0,
        clip_hi: hi as f64 / n as f64,
        clip_lo: lo as f64 / n as f64,
        p01: pct(0.01),
        p50: pct(0.5),
        p99: pct(0.99),
        mean_r: sr / n as f64 / 255.0,
        mean_g: sg / n as f64 / 255.0,
        mean_b: sb / n as f64 / 255.0,
        dhash: dhash(w, h, &luma),
    }
}

pub fn record(db: &Db, photo_id: &str, s: &ImageStats) -> Result<()> {
    db.write(|c| {
        c.execute(
            "INSERT INTO photo_analysis (photo_id, sharpness, brightness, clip_hi, clip_lo, p01, p50, p99,
                                         mean_r, mean_g, mean_b, analysed_ms, dhash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT (photo_id) DO UPDATE SET sharpness = excluded.sharpness, brightness = excluded.brightness,
               clip_hi = excluded.clip_hi, clip_lo = excluded.clip_lo, p01 = excluded.p01, p50 = excluded.p50,
               p99 = excluded.p99, mean_r = excluded.mean_r, mean_g = excluded.mean_g, mean_b = excluded.mean_b,
               analysed_ms = excluded.analysed_ms, dhash = excluded.dhash",
            params![
                photo_id,
                s.sharpness,
                s.brightness,
                s.clip_hi,
                s.clip_lo,
                s.p01,
                s.p50,
                s.p99,
                s.mean_r,
                s.mean_g,
                s.mean_b,
                now_ms(),
                s.dhash
            ],
        )?;
        Ok(())
    })
}

pub fn get(db: &Db, photo_id: &str) -> Result<Option<ImageStats>> {
    db.read(|c| {
        use rusqlite::OptionalExtension;
        Ok(c.query_row(
            "SELECT sharpness, brightness, clip_hi, clip_lo, p01, p50, p99, mean_r, mean_g, mean_b, dhash
             FROM photo_analysis WHERE photo_id = ?1",
            [photo_id],
            |r| {
                Ok(ImageStats {
                    sharpness: r.get(0)?,
                    brightness: r.get(1)?,
                    clip_hi: r.get(2)?,
                    clip_lo: r.get(3)?,
                    p01: r.get(4)?,
                    p50: r.get(5)?,
                    p99: r.get(6)?,
                    mean_r: r.get(7)?,
                    mean_g: r.get(8)?,
                    mean_b: r.get(9)?,
                    dhash: r.get(10)?,
                })
            },
        )
        .optional()?)
    })
}

/// Photos with a thumbnail but no measurements yet (made before this existed).
pub fn unanalysed(db: &Db, limit: i64) -> Result<Vec<String>> {
    db.read(|c| {
        let ids = c
            .prepare(
                "SELECT p.id FROM photos p LEFT JOIN photo_analysis pa ON pa.photo_id = p.id
                 WHERE p.thumb_state = 'ready' AND p.is_video = 0 AND (pa.photo_id IS NULL OR pa.dhash IS NULL) LIMIT ?1",
            )?
            .query_map([limit], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(ids)
    })
}

/// Photos measured from their thumbnail but not yet given Apple's quality
/// reading (aesthetics, utility), newest first.
pub fn quality_pending(db: &Db, limit: i64) -> Result<Vec<String>> {
    db.read(|c| {
        let mut stmt = c.prepare_cached(
            "SELECT pa.photo_id FROM photo_analysis pa JOIN photos p ON p.id = pa.photo_id
             WHERE pa.aesthetics IS NULL ORDER BY p.captured_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(rows)
    })
}

/// Not measurable (no thumbnail, unreadable): outside Apple's -1..1, so it is
/// never mistaken for a score and the queue still moves on.
pub const QUALITY_UNKNOWN: f64 = -2.0;

/// Stores Apple's quality reading (utility None when it couldn't be measured).
pub fn record_quality(db: &Db, photo_id: &str, aesthetics: f64, utility: Option<bool>) -> Result<()> {
    db.write(|c| {
        c.execute("UPDATE photo_analysis SET aesthetics = ?2, utility = ?3 WHERE photo_id = ?1", params![photo_id, aesthetics, utility])?;
        Ok(())
    })
}

/// Measures the photos still without a quality reading with the `vision`
/// helper (`--quality`), from their thumbnails, in batches. Stops on `cancel`.
pub fn run_quality_backlog(db: &Db, cache: &super::thumbs::Cache, helper: &std::path::Path, cancel: &std::sync::atomic::AtomicBool) -> Result<usize> {
    use std::sync::atomic::Ordering;
    let mut done = 0;
    while !cancel.load(Ordering::Relaxed) {
        let ids = quality_pending(db, 80)?;
        if ids.is_empty() {
            break;
        }
        let files: Vec<(String, std::path::PathBuf)> = ids.iter().map(|id| (id.clone(), cache.thumb(id))).collect();
        let present: Vec<&(String, std::path::PathBuf)> = files.iter().filter(|(_, f)| f.is_file()).collect();
        let mut seen = std::collections::HashSet::new();
        if !present.is_empty() {
            let out = std::process::Command::new(helper).arg("--quality").args(present.iter().map(|(_, f)| f)).output()?;
            // The helper didn't run at all: stop here and try again another time,
            // rather than writing "not measurable" for photos that are fine.
            if out.stdout.is_empty() {
                break;
            }
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                let file = v.get("file").and_then(|f| f.as_str()).unwrap_or_default();
                let Some((id, _)) = present.iter().find(|(_, f)| f.to_string_lossy() == file) else { continue };
                let Some(score) = v.get("aesthetics").and_then(|a| a.as_f64()) else { continue };
                record_quality(db, id, score, Some(v.get("utility").and_then(|u| u.as_bool()).unwrap_or(false)))?;
                seen.insert(id.clone());
            }
        }
        for (id, _) in &files {
            if !seen.contains(id) {
                record_quality(db, id, QUALITY_UNKNOWN, None)?;
            }
        }
        done += files.len();
    }
    Ok(done)
}

/// Splits frames, sorted by camera and then time, into scenes: bursts (see
/// `bursts`) plus frames that look nearly the same and were shot close
/// together. Frames without a hash only join by the burst rule.
fn scenes<T>(frames: impl IntoIterator<Item = (Option<String>, i64, Option<i64>, T)>) -> Vec<Vec<T>> {
    let mut groups: Vec<Vec<T>> = Vec::new();
    // Camera, previous frame (time, hash), first frame of the group (time, hash).
    let mut last: Option<(Option<String>, i64, Option<i64>, i64, Option<i64>)> = None;
    for (camera, ms, hash, item) in frames {
        let joins = match &last {
            Some((cam, prev, prev_hash, start, first_hash)) if *cam == camera => {
                let burst = ms - prev <= BURST_GAP_MS && ms - start <= BURST_SPAN_MS;
                let similar = match (hash, prev_hash, first_hash) {
                    (Some(h), Some(p), Some(f)) => {
                        ms - prev <= SCENE_GAP_MS && ms - start <= SCENE_SPAN_MS && distance(h, *p) <= SIMILAR_BITS && distance(h, *f) <= SIMILAR_TO_FIRST_BITS
                    }
                    _ => false,
                };
                burst || similar
            }
            _ => false,
        };
        if joins {
            groups.last_mut().expect("group").push(item);
            if let Some(l) = last.as_mut() {
                l.1 = ms;
                l.2 = hash.or(l.2);
            }
        } else {
            groups.push(vec![item]);
            last = Some((camera, ms, hash, ms, hash));
        }
    }
    groups
}

/// How good a frame is as a scene's keeper: sharp, and not badly clipped or dark.
fn keeper_score(sharpness: f64, clip_hi: f64, brightness: f64) -> f64 {
    let clipped = 1.0 - (clip_hi * 10.0).min(0.5);
    let dark = if brightness < 0.1 { 0.6 } else { 1.0 };
    sharpness * clipped * dark
}

/// Groups frames into scenes (bursts, and near-identical shots of the same
/// view) and marks the suggested keeper of each: the sharpest well-exposed one.
pub fn regroup_bursts(db: &Db) -> Result<usize> {
    db.write(|c| {
        let tx = c.transaction()?;
        let rows: Vec<(String, String, Option<String>, f64, f64, f64, Option<i64>)> = tx
            .prepare(
                "SELECT p.id, p.captured_at, p.camera_model, pa.sharpness, pa.clip_hi, pa.brightness, pa.dhash FROM photos p
                 JOIN photo_analysis pa ON pa.photo_id = p.id
                 WHERE p.captured_at_source = 'exif' AND p.is_video = 0 ORDER BY p.camera_model, p.captured_at",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))?
            .collect::<rusqlite::Result<_>>()?;
        tx.execute("UPDATE photo_analysis SET burst_id = NULL, burst_size = 1, burst_best = 1", [])?;
        let groups: Vec<Vec<(String, f64)>> = scenes(rows.into_iter().filter_map(|(id, at, camera, sharp, clip_hi, brightness, hash)| {
            let ms = pairing::parse_captured_at(&at)?.and_utc().timestamp_millis();
            Some((camera, ms, hash, (id, keeper_score(sharp, clip_hi, brightness))))
        }));
        let mut grouped = 0;
        {
            let mut stmt =
                tx.prepare("UPDATE photo_analysis SET burst_id = ?2, burst_size = ?3, burst_best = ?4 WHERE photo_id = ?1")?;
            for g in groups.iter().filter(|g| g.len() > 1) {
                let best = g.iter().max_by(|a, b| a.1.total_cmp(&b.1)).map(|b| b.0.clone()).unwrap_or_default();
                for (id, _) in g {
                    stmt.execute(params![id, g[0].0, g.len() as i64, *id == best])?;
                    grouped += 1;
                }
            }
        }
        tx.commit()?;
        Ok(grouped)
    })
}

/// Sliders that make a decent starting point: exposure towards a mid-grey
/// median, contrast to fill the range, highlights/shadows where clipped, and a
/// grey-world white balance.
pub fn auto_adjust(s: &ImageStats) -> Adjustments {
    let lin = |v: f64| if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
    let median = s.p50.clamp(0.02, 0.98);
    let exposure = ((lin(0.46) / lin(median)).log2() * 0.7).clamp(-1.5, 1.5);
    let spread = (s.p99 - s.p01).max(0.0);
    let contrast = ((0.85 - spread) * 60.0).clamp(-10.0, 30.0);
    let highlights = if s.clip_hi > 0.004 { -(s.clip_hi * 2500.0).min(60.0) } else { 0.0 };
    let shadows = if s.p01 < 0.03 && s.clip_lo > 0.01 { (s.clip_lo * 800.0).min(40.0) } else { 0.0 };
    let whites = ((0.96 - s.p99) * 80.0).clamp(-15.0, 25.0);
    let blacks = if s.p01 > 0.06 { (-(s.p01 - 0.03) * 150.0).max(-30.0) } else { 0.0 };
    let grey = ((s.mean_r + s.mean_g + s.mean_b) / 3.0).max(0.02);
    let temperature = ((s.mean_b - s.mean_r) / grey * 60.0).clamp(-30.0, 30.0);
    let tint = ((s.mean_g - (s.mean_r + s.mean_b) / 2.0) / grey * 80.0).clamp(-20.0, 20.0);
    let round = |v: f64| (v * 100.0).round() / 100.0;
    Adjustments {
        exposure: round(exposure),
        contrast: contrast.round(),
        highlights: highlights.round(),
        shadows: shadows.round(),
        whites: whites.round(),
        blacks: blacks.round(),
        temperature: temperature.round(),
        tint: tint.round(),
        vibrance: 12.0,
        saturation: 0.0,
        grain: 0.0,
        vignette: 0.0,
        // Auto tone is about light and colour: framing stays as it is.
        ..Adjustments::default()
    }
}

pub fn auto_for_photo(db: &Db, photo_id: &str) -> Result<Adjustments> {
    let s = get(db, photo_id)?.ok_or_else(|| Error::Invalid("this photo has not been measured yet".into()))?;
    Ok(auto_adjust(&s))
}

/// The automatic filters, with how many photos each would show.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartCounts {
    pub soft: i64,
    pub dark: i64,
    pub bright: i64,
    pub burst_extras: i64,
    /// Burst extras still to review: what is left for the dashboard to suggest.
    pub burst_extras_unreviewed: i64,
    /// Photos in a group of similar shots, and how many of those are unreviewed.
    pub bursts: i64,
    pub bursts_unreviewed: i64,
    pub selected_unposted: i64,
    pub no_album: i64,
    pub edited: i64,
    pub not_edited_selected: i64,
    pub analysed: i64,
    /// Photos the last scan with new files added, and how many are unreviewed.
    pub last_import: i64,
    pub last_import_unreviewed: i64,
}

pub fn smart_counts(db: &Db) -> Result<SmartCounts> {
    db.read(|c| smart_counts_on(c))
}

fn smart_counts_on(c: &Connection) -> Result<SmartCounts> {
    let n = |sql: &str| -> Result<i64> { Ok(c.query_row(sql, [], |r| r.get(0))?) };
    let last_import = photos::last_import_sql();
    Ok(SmartCounts {
        soft: n(&format!("SELECT COUNT(*) FROM photo_analysis WHERE sharpness < {SOFT_BELOW}"))?,
        dark: n("SELECT COUNT(*) FROM photo_analysis WHERE brightness < 0.18")?,
        bright: n("SELECT COUNT(*) FROM photo_analysis WHERE clip_hi > 0.08 OR brightness > 0.82")?,
        burst_extras: n("SELECT COUNT(*) FROM photo_analysis WHERE burst_size > 1 AND burst_best = 0")?,
        burst_extras_unreviewed: n(
            "SELECT COUNT(*) FROM photo_analysis x JOIN photos p ON p.id = x.photo_id
             WHERE x.burst_size > 1 AND x.burst_best = 0 AND p.review_state = 'unreviewed'",
        )?,
        bursts: n("SELECT COUNT(*) FROM photo_analysis WHERE burst_size > 1")?,
        bursts_unreviewed: n(
            "SELECT COUNT(*) FROM photo_analysis x JOIN photos p ON p.id = x.photo_id WHERE x.burst_size > 1 AND p.review_state = 'unreviewed'",
        )?,
        selected_unposted: n(
            "SELECT COUNT(*) FROM photos p WHERE p.review_state = 'selected' AND NOT EXISTS
               (SELECT 1 FROM post_photos pp JOIN posts po ON po.id = pp.post_id WHERE pp.photo_id = p.id AND po.status = 'published')",
        )?,
        no_album: n("SELECT COUNT(*) FROM photos p WHERE NOT EXISTS (SELECT 1 FROM photo_albums pa WHERE pa.photo_id = p.id)")?,
        edited: n("SELECT COUNT(*) FROM photo_looks")?,
        not_edited_selected: n(
            "SELECT COUNT(*) FROM photos p WHERE p.review_state = 'selected' AND p.is_video = 0 AND NOT EXISTS (SELECT 1 FROM photo_looks pl WHERE pl.photo_id = p.id)",
        )?,
        analysed: n("SELECT COUNT(*) FROM photo_analysis")?,
        last_import: n(&format!("SELECT COUNT(*) FROM photos p WHERE {last_import}"))?,
        last_import_unreviewed: n(&format!(
            "SELECT COUNT(*) FROM photos p WHERE {last_import} AND p.review_state = 'unreviewed'"
        ))?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(w: usize, h: usize, f: impl Fn(usize, usize) -> [u8; 3]) -> Vec<u8> {
        let mut out = Vec::with_capacity(w * h * 4);
        for y in 0..h {
            for x in 0..w {
                let [r, g, b] = f(x, y);
                out.extend_from_slice(&[r, g, b, 255]);
            }
        }
        out
    }

    #[test]
    fn detail_scores_higher_than_blur() {
        let (w, h) = (120, 80);
        // Hard-edged checkerboard vs the same pattern as a smooth gradient.
        let sharp = image(w, h, |x, y| if (x / 4 + y / 4) % 2 == 0 { [40; 3] } else { [210; 3] });
        let soft = image(w, h, |x, y| {
            let v = 125.0 + 85.0 * ((x as f64 / 9.0).sin() * (y as f64 / 9.0).sin());
            [v as u8; 3]
        });
        let (a, b) = (stats(w, h, &sharp), stats(w, h, &soft));
        assert!(a.sharpness > SOFT_BELOW && b.sharpness < SOFT_BELOW, "sharp {} soft {}", a.sharpness, b.sharpness);
    }

    #[test]
    fn auto_tone_brightens_dark_frames_and_warms_blue_ones() {
        let dark = stats(64, 64, &image(64, 64, |x, _| [(20 + x / 2) as u8; 3]));
        assert!(auto_adjust(&dark).exposure > 0.5);
        let blue = stats(64, 64, &image(64, 64, |x, _| [90, 110, (160 + x / 2) as u8]));
        assert!(auto_adjust(&blue).temperature > 0.0);
        let bright = stats(64, 64, &image(64, 64, |x, _| [(215 + x / 2) as u8; 3]));
        assert!(auto_adjust(&bright).exposure < 0.0);
    }

    #[test]
    fn look_alike_frames_form_a_scene() {
        let cam = || Some("ILCE-7M4".to_owned());
        let view: i64 = 0x0F0F_3C3C_5A5A_A5A5;
        let other: i64 = !view;
        let sizes = |groups: Vec<Vec<i64>>| groups.iter().map(Vec::len).collect::<Vec<_>>();
        // The same view, re-shot every 20 s: one scene.
        assert_eq!(sizes(scenes((0..4).map(|i| (cam(), i * 20_000, Some(view ^ (i as i64)), i)))), [4]);
        // Then a different view: a new scene.
        let two = [(cam(), 0, Some(view), 0), (cam(), 20_000, Some(view ^ 3), 1), (cam(), 40_000, Some(other), 2)];
        assert_eq!(sizes(scenes(two)), [2, 1]);
        // Too far apart in time: separate, however alike.
        assert_eq!(sizes(scenes([(cam(), 0, Some(view), 0), (cam(), 200_000, Some(view), 1)])), [1, 1]);
        // No hash (not analysed yet): only the burst rule.
        assert_eq!(sizes(scenes([(cam(), 0, None, 0), (cam(), 20_000, None, 1)])), [1, 1]);
    }

    #[test]
    fn a_keeper_is_sharp_and_well_exposed() {
        assert!(keeper_score(20.0, 0.0, 0.5) > keeper_score(20.0, 0.2, 0.5));
        assert!(keeper_score(20.0, 0.0, 0.5) > keeper_score(20.0, 0.0, 0.05));
        assert!(keeper_score(30.0, 0.0, 0.5) > keeper_score(20.0, 0.0, 0.5));
    }

    #[test]
    fn bursts_are_quick_and_short() {
        let cam = || Some("ILCE-7M4".to_owned());
        let sizes = |groups: Vec<Vec<i64>>| groups.iter().map(Vec::len).collect::<Vec<_>>();
        // Two seconds at 10 fps: one burst.
        let bursts = |frames: Vec<(Option<String>, i64, i64)>| scenes(frames.into_iter().map(|(c, ms, i)| (c, ms, None, i)));
        assert_eq!(sizes(bursts((0..20).map(|i| (cam(), i * 100, i)).collect())), [20]);
        // A two-minute walk, a frame every 1.5 s: never one "burst of 80".
        let walk = bursts((0..80).map(|i| (cam(), i * 1_500, i)).collect());
        assert!(walk.iter().all(|g| g.len() <= 3), "{:?}", sizes(walk.clone()));
        assert_eq!(walk.iter().map(Vec::len).sum::<usize>(), 80);
        // A pause or another camera starts a new group.
        let mixed = [(cam(), 0, 0), (cam(), 500, 1), (cam(), 3_000, 2), (Some("iPhone".into()), 3_100, 3)];
        assert_eq!(sizes(bursts(mixed.to_vec())), [2, 1, 1]);
    }
}

pub const AUTO_LOOK_KEY: &str = "looks.autoLook";
pub const AUTO_TONE_KEY: &str = "looks.autoTone";
pub const AUTO_STRENGTH_KEY: &str = "looks.autoStrength";

/// When a photo is selected and has no edit yet: give it the default look
/// and/or auto tone, if those are switched on in Settings. Returns how many
/// photos got an automatic edit.
pub fn on_selected(db: &Db, photo_ids: &[String]) -> Result<usize> {
    use super::{looks, settings};
    let look = settings::get(db, AUTO_LOOK_KEY)?.map(|v| v.trim_matches('"').to_owned()).filter(|v| !v.is_empty());
    let tone = settings::get(db, AUTO_TONE_KEY)?.is_some_and(|v| v == "true");
    if look.is_none() && !tone {
        return Ok(0);
    }
    let strength = settings::get(db, AUTO_STRENGTH_KEY)?.and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.8);
    let mut done = 0;
    for id in photo_ids {
        let current = looks::for_photo(db, id)?;
        if current.look_id.is_some() || current.adjustments != Adjustments::default() {
            continue; // already edited by hand: leave it
        }
        let adj = if tone { get(db, id)?.map(|s| auto_adjust(&s)) } else { None };
        looks::apply(db, std::slice::from_ref(id), look.as_deref(), strength, adj.as_ref())?;
        done += 1;
    }
    Ok(done)
}
