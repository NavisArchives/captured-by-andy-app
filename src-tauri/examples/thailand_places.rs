//! One-off: splits THAILAND into its places (PAI, CHIANG MAI, BANGKOK, KRABI,
//! SAM ROI YOT) by where each photo was taken, SAMROIYOT included (it holds
//! Krabi too); what's left of SAMROIYOT becomes THAILAND/SAM ROI YOT. Photos without a location go with the nearest located photo taken
//! within 12 hours. Photos elsewhere stay in THAILAND. Shoot folders
//! (RESORT_THAILAND…) move whole, to the place most of their photos are in.
//! Moves files and library together with the app's own move; UNDO lines on stderr.
//!   cargo run --example thailand_places -- <library dir> <CAMERA dir> [--apply]
use std::collections::{BTreeMap, HashMap};

use captured_by_andy_lib::library::{db::Db, trips};
use chrono::NaiveDateTime;

const PLACES: [(&str, f64, f64, f64, f64); 5] = [
    ("PAI", 19.20, 19.60, 98.20, 98.65),
    ("CHIANG MAI", 18.30, 19.20, 98.40, 99.40),
    ("BANGKOK", 13.40, 14.15, 100.20, 101.00),
    ("KRABI", 7.50, 8.40, 98.50, 99.30),
    ("SAM ROI YOT", 11.85, 12.50, 99.65, 100.20),
];

struct Photo {
    id: String,
    dir: String,
    at: i64,
    place: Option<&'static str>,
    located: bool,
}

fn place_of(lat: f64, lon: f64) -> Option<&'static str> {
    PLACES.iter().find(|p| lat >= p.1 && lat < p.2 && lon >= p.3 && lon < p.4).map(|p| p.0)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (dir, camera, apply) = (&args[0], args[1].trim_end_matches('/'), args.iter().any(|a| a == "--apply"));
    let db = Db::open(&std::path::Path::new(dir).join("library.db")).expect("library");
    let (thailand, samroiyot) = (format!("{camera}/THAILAND"), format!("{camera}/SAMROIYOT"));
    let load = |trip: &str| -> Vec<Photo> {
        db.read(|c| {
            let mut st = c.prepare(
                "SELECT p.id, a.dir, p.captured_at, p.latitude, p.longitude FROM photos p
                 JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
                 WHERE (a.dir = ?1 OR a.dir LIKE ?1 || '/%') AND a.storage_state != 'missing'",
            )?;
            let rows = st
                .query_map([trip], |r| {
                    let at: String = r.get(2)?;
                    let at = NaiveDateTime::parse_from_str(&at, "%Y-%m-%dT%H:%M:%S%.f").map(|t| t.and_utc().timestamp()).unwrap_or(0);
                    let (lat, lon): (Option<f64>, Option<f64>) = (r.get(3)?, r.get(4)?);
                    let gps = lat.zip(lon).filter(|(a, b)| *a != 0.0 || *b != 0.0);
                    Ok(Photo { id: r.get(0)?, dir: r.get(1)?, at, place: gps.and_then(|(a, b)| place_of(a, b)), located: gps.is_some() })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .expect("photos")
    };
    let mut photos = load(&thailand);
    let mut sam = load(&samroiyot);
    // Not located: the nearest located photo within 12 hours decides.
    let mut located: Vec<(i64, Option<&'static str>)> = photos.iter().chain(&sam).filter(|p| p.located).map(|p| (p.at, p.place)).collect();
    located.sort_by_key(|l| l.0);
    for p in photos.iter_mut().chain(sam.iter_mut()).filter(|p| !p.located) {
        let i = located.partition_point(|l| l.0 < p.at);
        let near = [i.checked_sub(1), Some(i)].into_iter().flatten().filter_map(|j| located.get(j)).min_by_key(|l| (l.0 - p.at).abs());
        p.place = near.filter(|l| (l.0 - p.at).abs() <= 12 * 3600).and_then(|l| l.1);
    }
    // Shoot folders (anything but the trip itself and IPHONE) move whole.
    let loose = |d: &str| d == thailand || d == format!("{thailand}/IPHONE");
    let mut shoots: BTreeMap<String, HashMap<Option<&str>, usize>> = BTreeMap::new();
    for p in photos.iter().filter(|p| !loose(&p.dir)) {
        let top = p.dir[thailand.len() + 1..].split('/').next().unwrap().to_string();
        *shoots.entry(top).or_default().entry(p.place).or_default() += 1;
    }
    let shoot_place: HashMap<String, Option<&str>> = shoots
        .iter()
        .map(|(name, counts)| {
            let total: usize = counts.values().sum();
            let best = counts.iter().filter(|(k, _)| k.is_some()).max_by_key(|(_, n)| **n).filter(|(_, n)| **n * 10 >= total * 8);
            println!("shoot {name}: {total} photos {counts:?} -> {:?}", best.map(|b| b.0));
            (name.clone(), best.and_then(|b| *b.0))
        })
        .collect();
    let mut by_place: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    let mut stay = 0;
    for p in &photos {
        let place = if loose(&p.dir) { p.place } else { shoot_place[p.dir[thailand.len() + 1..].split('/').next().unwrap()] };
        match place {
            Some(pl) => by_place.entry(pl).or_default().push(p.id.clone()),
            None => stay += 1,
        }
    }
    let mut sam_place: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for p in &sam {
        sam_place.entry(p.place.unwrap_or("SAM ROI YOT")).or_default().push(p.id.clone());
    }
    println!("THAILAND {} photos: {:?}, {stay} stay in THAILAND", photos.len(), by_place.iter().map(|(k, v)| (k, v.len())).collect::<Vec<_>>());
    println!("SAMROIYOT {} photos: {:?}", sam.len(), sam_place.iter().map(|(k, v)| (k, v.len())).collect::<Vec<_>>());
    if !apply {
        return;
    }
    let run = |ids: &[String], from: &str, to: &str| {
        let r = trips::move_into(&db, ids, from, to).expect("move");
        println!("{to}: {} moved, {} already, {} failed {:?}", r.moved, r.already, r.failed.len(), r.failed.iter().take(5).collect::<Vec<_>>());
        for m in &r.undo {
            eprintln!("UNDO\t{}\t{}\t{}", m.asset_id, m.to, m.from);
        }
    };
    for (place, ids) in &sam_place {
        run(ids, &samroiyot, &format!("{thailand}/{place}"));
    }
    for (place, ids) in &by_place {
        run(ids, &thailand, &format!("{thailand}/{place}"));
    }
}
