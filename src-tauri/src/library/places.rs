//! Places inside a trip: THAILAND › PAI, KOH SAMUI, BANGKOK. The loose photos of
//! a trip (in the trip folder itself or its IPHONE folder) are grouped by where
//! they were taken: locations within `LINK_KM` of each other chain into one
//! place, and places with fewer than `MIN_PHOTOS` stay loose ("elsewhere").
//! Photos without a location go with the nearest located photo of the trip
//! taken within 12 hours. A place that matches a place folder the trip already
//! has keeps that folder. Names come from the caller (reverse geocoding on this
//! Mac) and can be changed before anything moves; moving uses
//! `trips::move_into`, so IPHONE subfolders are kept and every move can be undone.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use super::{db::Db, pairing, trips, Error, Result};

/// Locations this close (km) belong to the same place.
pub const LINK_KM: f64 = 25.0;
/// A place needs this many photos; smaller groups stay in the trip folder.
pub const MIN_PHOTOS: usize = 20;
/// A photo without a location joins the nearest located photo within this time.
const NEAREST_SECONDS: i64 = 12 * 3600;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProposedPlace {
    /// Stable for the same photos, so the choice made on screen finds it again.
    pub key: String,
    /// The folder it would go in: an existing place folder, or a suggestion.
    pub name: String,
    /// True when the trip already has this place's folder.
    pub existing: bool,
    /// The country it's in ("" when unknown): one that isn't the trip's own
    /// country is probably misplaced and starts switched off.
    pub country: String,
    pub lat: f64,
    pub lon: f64,
    /// Loose photos that would move there (with and without a location).
    pub photos: usize,
    pub located: usize,
    /// A few of them, for a glance.
    pub sample: Vec<String>,
    /// Points to name the place from (centre first), for reverse geocoding.
    pub probes: Vec<(f64, f64)>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub trip: String,
    /// The trip's own country: the one most of its places are in.
    pub country: String,
    pub places: Vec<ProposedPlace>,
    /// Loose photos that stay in the trip folder (too few, or nothing to go by).
    pub elsewhere: usize,
    /// Loose photos looked at, and how many have a location.
    pub loose: usize,
    pub loose_located: usize,
}

/// What the person chose for one proposed place.
#[derive(Clone, Debug, Deserialize)]
pub struct Choice {
    pub key: String,
    pub name: String,
}

struct Photo {
    id: String,
    dir: String,
    at: i64,
    loc: Option<(f64, f64)>,
}

fn km(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (la1, la2) = (a.0.to_radians(), b.0.to_radians());
    let (dla, dlo) = (la2 - la1, (b.1 - a.1).to_radians());
    let h = (dla / 2.0).sin().powi(2) + la1.cos() * la2.cos() * (dlo / 2.0).sin().powi(2);
    2.0 * 6371.0 * h.sqrt().asin()
}

/// Single-linkage clusters: points within `link_km` of each other (directly or
/// through a chain) form one cluster. Returns the clusters as index lists,
/// biggest first. Grid-bucketed, so it stays fast for tens of thousands of points.
pub fn cluster(points: &[(f64, f64)], link_km: f64) -> Vec<Vec<usize>> {
    let mut parent: Vec<usize> = (0..points.len()).collect();
    fn find(p: &mut [usize], i: usize) -> usize {
        let mut r = i;
        while p[r] != r {
            p[r] = p[p[r]];
            r = p[r];
        }
        r
    }
    // Cells of about link_km on a side. One longitude scale for every point (the
    // smallest, at the latitude farthest from the equator), so cells are never
    // narrower than link_km and neighbours are always within one cell.
    let max_lat = points.iter().map(|p| p.0.abs()).fold(0.0, f64::max).min(85.0);
    let lon_km = 111.0 * max_lat.to_radians().cos().max(0.05);
    let cell = |&(lat, lon): &(f64, f64)| -> (i64, i64) { ((lon * lon_km / link_km).floor() as i64, (lat * 111.0 / link_km).floor() as i64) };
    let mut grid: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (i, p) in points.iter().enumerate() {
        grid.entry(cell(p)).or_default().push(i);
    }
    for (i, p) in points.iter().enumerate() {
        let (cx, cy) = cell(p);
        for dx in -1..=1 {
            for dy in -1..=1 {
                let Some(near) = grid.get(&(cx + dx, cy + dy)) else { continue };
                for &j in near {
                    if j > i && km(*p, points[j]) <= link_km {
                        let (a, b) = (find(&mut parent, i), find(&mut parent, j));
                        if a != b {
                            parent[a] = b;
                        }
                    }
                }
            }
        }
    }
    let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for i in 0..points.len() {
        let r = find(&mut parent, i);
        groups.entry(r).or_default().push(i);
    }
    let mut out: Vec<Vec<usize>> = groups.into_values().collect();
    out.sort_by(|a, b| b.len().cmp(&a.len()).then(a[0].cmp(&b[0])));
    out
}

/// "Pai District" → "PAI"; folder-safe, upper case like the trips.
pub fn folder_name(name: &str) -> String {
    let mut n = name.trim().to_owned();
    for suffix in [" District", " Province", " City", " Municipality", " Prefecture", " County", " Regency", " Region"] {
        if let Some(s) = n.strip_suffix(suffix) {
            n = s.to_owned();
        }
    }
    for prefix in ["Amphoe ", "Mueang ", "Khet "] {
        if let Some(s) = n.strip_prefix(prefix) {
            n = s.to_owned();
        }
    }
    let n: String = n.chars().filter(|c| !"/\\:*?\"<>|".contains(*c)).collect();
    n.trim().to_uppercase()
}

fn load(db: &Db, trip: &str) -> Result<Vec<Photo>> {
    db.read(|c| {
        let mut st = c.prepare(
            "SELECT p.id, a.dir, p.captured_at, p.latitude, p.longitude FROM photos p
             JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
             WHERE (a.dir = ?1 OR a.dir LIKE ?2 ESCAPE '\\') AND a.storage_state != 'missing'
             ORDER BY p.captured_at, p.id",
        )?;
        let like = format!("{}/%", trip.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        let rows = st
            .query_map(rusqlite::params![trip, like], |r| {
                let at: String = r.get(2)?;
                let at = pairing::parse_captured_at(&at).map(|t| t.and_utc().timestamp()).unwrap_or(0);
                let (lat, lon): (Option<f64>, Option<f64>) = (r.get(3)?, r.get(4)?);
                let loc = lat.zip(lon).filter(|(a, b)| (*a != 0.0 || *b != 0.0) && a.abs() <= 90.0 && b.abs() <= 180.0);
                Ok(Photo { id: r.get(0)?, dir: r.get(1)?, at, loc })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// The place folders a trip already has (THAILAND/PAI), with where their photos were.
fn existing_places(trip: &str, photos: &[Photo]) -> HashMap<String, Vec<(f64, f64)>> {
    let mut out: HashMap<String, Vec<(f64, f64)>> = HashMap::new();
    for p in photos {
        let Some(rest) = p.dir.strip_prefix(&format!("{trip}/")) else { continue };
        let top = rest.split('/').next().unwrap_or_default();
        if top.is_empty() || top.eq_ignore_ascii_case("IPHONE") {
            continue;
        }
        let entry = out.entry(top.to_owned()).or_default();
        if let Some(l) = p.loc {
            entry.push(l);
        }
    }
    out
}

fn is_loose(trip: &str, dir: &str) -> bool {
    dir == trip || dir.strip_prefix(trip).is_some_and(|r| r.eq_ignore_ascii_case("/IPHONE"))
}

/// Where each loose photo would go: (place index into the clusters kept, or None).
struct Plan {
    places: Vec<ProposedPlace>,
    members: Vec<Vec<String>>,
    elsewhere: usize,
    loose: usize,
    loose_located: usize,
}

fn plan(trip: &str, photos: &[Photo]) -> Plan {
    let loose: Vec<&Photo> = photos.iter().filter(|p| is_loose(trip, &p.dir)).collect();
    let located: Vec<&Photo> = loose.iter().copied().filter(|p| p.loc.is_some()).collect();
    let points: Vec<(f64, f64)> = located.iter().map(|p| p.loc.unwrap()).collect();
    let existing = existing_places(trip, photos);
    let mut place_of: HashMap<&str, usize> = HashMap::new();
    let mut places: Vec<ProposedPlace> = Vec::new();
    for group in cluster(&points, LINK_KM).into_iter().filter(|g| g.len() >= MIN_PHOTOS) {
        let n = group.len() as f64;
        let centre = (group.iter().map(|&i| points[i].0).sum::<f64>() / n, group.iter().map(|&i| points[i].1).sum::<f64>() / n);
        // The photo nearest the centre names it; two more from the edges check the name holds.
        let mut by_dist: Vec<usize> = group.clone();
        by_dist.sort_by(|&a, &b| km(points[a], centre).total_cmp(&km(points[b], centre)));
        let probes = [by_dist[0], by_dist[by_dist.len() / 2], by_dist[by_dist.len() - 1]].iter().map(|&i| points[i]).collect::<Vec<_>>();
        // An existing place folder whose photos were taken here.
        let folder = existing
            .iter()
            .filter(|(_, locs)| !locs.is_empty())
            .map(|(name, locs)| (name, locs.iter().map(|l| km(*l, centre)).fold(f64::MAX, f64::min)))
            .filter(|(_, d)| *d <= LINK_KM)
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(name, _)| name.clone());
        let key = format!("{:.2},{:.2}", centre.0, centre.1);
        for &i in &group {
            place_of.insert(&located[i].id, places.len());
        }
        places.push(ProposedPlace {
            key,
            existing: folder.is_some(),
            name: folder.unwrap_or_default(),
            country: String::new(),
            lat: centre.0,
            lon: centre.1,
            photos: 0,
            located: group.len(),
            sample: by_dist.iter().take(6).map(|&i| located[i].id.clone()).collect(),
            probes,
        });
    }
    // Photos without a location: the nearest located photo of the trip (loose
    // or already in a place folder) taken within 12 hours decides.
    let mut timeline: Vec<(i64, Option<usize>, Option<String>)> = photos
        .iter()
        .filter(|p| p.loc.is_some())
        .map(|p| {
            let folder = (!is_loose(trip, &p.dir)).then(|| p.dir[trip.len() + 1..].split('/').next().unwrap_or_default().to_owned());
            (p.at, place_of.get(p.id.as_str()).copied(), folder)
        })
        .collect();
    timeline.sort_by_key(|t| t.0);
    let mut members: Vec<Vec<String>> = vec![Vec::new(); places.len()];
    let mut elsewhere = 0;
    for p in &loose {
        let target = if p.loc.is_some() {
            place_of.get(p.id.as_str()).copied()
        } else {
            let i = timeline.partition_point(|t| t.0 < p.at);
            let near = [i.checked_sub(1), Some(i)].into_iter().flatten().filter_map(|j| timeline.get(j)).min_by_key(|t| (t.0 - p.at).abs());
            near.filter(|t| (t.0 - p.at).abs() <= NEAREST_SECONDS).and_then(|t| {
                t.1.or_else(|| t.2.as_ref().and_then(|f| places.iter().position(|pl| pl.existing && &pl.name == f)))
            })
        };
        match target {
            Some(k) => members[k].push(p.id.clone()),
            None => elsewhere += 1,
        }
    }
    for (pl, m) in places.iter_mut().zip(&members) {
        pl.photos = m.len();
    }
    Plan { places, members, elsewhere, loose: loose.len(), loose_located: located.len() }
}

/// The places a trip's loose photos could go to. `name` answers a place's name
/// and country from its probe points (the first is the centre); None leaves
/// them blank. An existing place folder keeps its own name.
pub fn propose(db: &Db, trip: &str, name: &dyn Fn(&[(f64, f64)]) -> Option<(String, String)>) -> Result<Proposal> {
    let trip = trip.trim_end_matches('/');
    let photos = load(db, trip)?;
    let p = plan(trip, &photos);
    let places: Vec<ProposedPlace> = p
        .places
        .into_iter()
        .map(|mut pl| {
            if let Some((n, country)) = name(&pl.probes) {
                if !pl.existing {
                    pl.name = folder_name(&n);
                }
                pl.country = country;
            }
            pl
        })
        .collect();
    let mut weight: HashMap<&str, usize> = HashMap::new();
    for pl in places.iter().filter(|pl| !pl.country.is_empty()) {
        *weight.entry(pl.country.as_str()).or_default() += pl.photos;
    }
    let country = weight.into_iter().max_by_key(|(_, n)| *n).map(|(c, _)| c.to_owned()).unwrap_or_default();
    Ok(Proposal { trip: trip.to_owned(), country, places, elsewhere: p.elsewhere, loose: p.loose, loose_located: p.loose_located })
}

/// Moves the loose photos of the chosen places into their place folders
/// (THAILAND/IPHONE/x → THAILAND/PAI/IPHONE/x). Places not chosen stay loose.
/// Every choice is checked before anything moves; a name that matches a
/// folder the trip already has uses that folder exactly as it is spelled.
pub fn make(db: &Db, trip: &str, choices: &[Choice]) -> Result<trips::MoveReport> {
    let trip = trip.trim_end_matches('/');
    let photos = load(db, trip)?;
    let p = plan(trip, &photos);
    let folders: Vec<String> = existing_places(trip, &photos).into_keys().collect();
    let mut seen = std::collections::HashSet::new();
    let mut work: Vec<(usize, String)> = Vec::new();
    for c in choices {
        if !seen.insert(c.key.as_str()) {
            continue;
        }
        let wanted = folder_name(&c.name);
        if wanted.is_empty() || wanted.eq_ignore_ascii_case("IPHONE") || wanted.starts_with('.') {
            return Err(Error::Invalid(format!("\"{}\" can't be a place name", c.name)));
        }
        let Some(i) = p.places.iter().position(|pl| pl.key == c.key) else {
            return Err(Error::Invalid("The trip changed since the places were found: look again.".into()));
        };
        let typed = c.name.trim();
        let name = folders
            .iter()
            .find(|f| f.eq_ignore_ascii_case(typed) || f.eq_ignore_ascii_case(&wanted))
            .cloned()
            .unwrap_or(wanted);
        work.push((i, name));
    }
    let mut report = trips::MoveReport::default();
    for (i, name) in work {
        // One place failing doesn't lose the Undo of the ones already moved.
        let r = match trips::move_into(db, &p.members[i], trip, &format!("{trip}/{name}")) {
            Ok(r) => r,
            Err(e) => {
                report.failed.push(format!("{name}: {e}"));
                continue;
            }
        };
        report.moved += r.moved;
        report.already += r.already;
        report.failed.extend(r.failed);
        report.undo.extend(r.undo);
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearby_points_chain_into_one_place() {
        // Pai (two spots 10 km apart), Bangkok, and one lone photo far away.
        let pts = [(19.36, 98.44), (19.40, 98.50), (19.45, 98.52), (13.75, 100.50), (13.76, 100.52), (7.9, 98.3)];
        let groups = cluster(&pts, LINK_KM);
        let sizes: Vec<usize> = groups.iter().map(Vec::len).collect();
        assert_eq!(sizes, [3, 2, 1]);
        assert_eq!(groups[0], [0, 1, 2]);
    }

    #[test]
    fn names_become_folders() {
        assert_eq!(folder_name("Pai District"), "PAI");
        assert_eq!(folder_name("Ko Samui District"), "KO SAMUI");
        assert_eq!(folder_name("Amphoe Mueang Chiang Mai"), "CHIANG MAI");
        assert_eq!(folder_name("Bangkok"), "BANGKOK");
        assert_eq!(folder_name("a/b"), "AB");
    }
}
