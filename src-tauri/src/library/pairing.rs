//! Deciding when two files are one photo: `IMG_3829.CR3` + `IMG_3829.JPG`.
//!
//! Same folder and same name is only a hint - camera counters roll over, and
//! two cameras can write the same name into one folder. The files must also
//! have been taken at the same moment. Anything ambiguous stays separate: a
//! wrong merge hides a photo, a missed merge merely shows two.

use chrono::NaiveDateTime;

/// EXIF capture times of the two files may differ slightly (the camera writes
/// them separately); 2 s allows for that without merging a burst.
const EXIF_TOLERANCE_MS: i64 = 2_000;
/// Without EXIF, fall back to file modification times, which drift more.
const MTIME_TOLERANCE_MS: i64 = 5 * 60 * 1_000;

#[derive(Clone, Debug)]
pub struct Candidate {
    pub is_raw: bool,
    /// Only when the time came from EXIF.
    pub exif_time: Option<NaiveDateTime>,
    pub mtime_ms: i64,
}

pub fn same_shot(raw: &Candidate, image: &Candidate) -> bool {
    match (raw.exif_time, image.exif_time) {
        (Some(a), Some(b)) => (a - b).num_milliseconds().abs() <= EXIF_TOLERANCE_MS,
        _ => (raw.mtime_ms - image.mtime_ms).abs() <= MTIME_TOLERANCE_MS,
    }
}

/// Given every file sharing one folder + stem, return the (raw, image) indexes
/// to pair - only when there is exactly one of each and they match.
pub fn pick_pair(members: &[Candidate]) -> Option<(usize, usize)> {
    let raws: Vec<usize> = (0..members.len()).filter(|&i| members[i].is_raw).collect();
    let images: Vec<usize> = (0..members.len()).filter(|&i| !members[i].is_raw).collect();
    match (raws.as_slice(), images.as_slice()) {
        ([r], [i]) if same_shot(&members[*r], &members[*i]) => Some((*r, *i)),
        _ => None,
    }
}

pub fn parse_captured_at(text: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f").ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(t: &str) -> Option<NaiveDateTime> {
        parse_captured_at(t)
    }
    fn raw(t: Option<NaiveDateTime>, mtime: i64) -> Candidate {
        Candidate { is_raw: true, exif_time: t, mtime_ms: mtime }
    }
    fn img(t: Option<NaiveDateTime>, mtime: i64) -> Candidate {
        Candidate { is_raw: false, exif_time: t, mtime_ms: mtime }
    }

    #[test]
    fn pairs_raw_and_jpeg_taken_together() {
        let m = [raw(at("2026-08-27T16:01:38.000"), 0), img(at("2026-08-27T16:01:38.500"), 0)];
        assert_eq!(pick_pair(&m), Some((0, 1)));
    }

    #[test]
    fn keeps_same_named_files_from_different_moments_apart() {
        // Counter rollover: same name, shot an hour apart.
        let m = [raw(at("2026-08-27T16:01:38"), 0), img(at("2026-08-27T17:01:38"), 0)];
        assert_eq!(pick_pair(&m), None);
    }

    #[test]
    fn falls_back_to_file_times_without_exif() {
        assert_eq!(pick_pair(&[raw(None, 1_000), img(None, 61_000)]), Some((0, 1)));
        assert_eq!(pick_pair(&[raw(None, 0), img(None, 3_600_000)]), None);
    }

    #[test]
    fn ambiguous_groups_stay_separate() {
        let t = at("2026-08-27T16:01:38");
        assert_eq!(pick_pair(&[raw(t, 0), img(t, 0), img(t, 0)]), None, "JPG + HEIC + RAW");
        assert_eq!(pick_pair(&[img(t, 0), img(t, 0)]), None, "no RAW");
        assert_eq!(pick_pair(&[raw(t, 0)]), None, "single file");
    }
}
