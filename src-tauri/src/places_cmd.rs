//! Places inside a trip, as the app offers them: find them (named on this Mac
//! by the bundled `places` helper, Apple's reverse geocoding), then make them.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

use crate::app::{blocking, AppState};
use crate::library::{db::Db, places, settings, trips};

type Reply<T> = Result<T, String>;

static HELPER: OnceLock<PathBuf> = OnceLock::new();

pub fn set_helper(path: PathBuf) {
    let _ = HELPER.set(path);
}

/// (locality, sub-area, area, country) for each point; cached, so a place is
/// only ever looked up once.
fn geocode(db: &Db, points: &[(f64, f64)]) -> Vec<Option<[String; 4]>> {
    let key = |p: &(f64, f64)| format!("geocode.{:.2},{:.2}", p.0, p.1);
    let mut out: Vec<Option<[String; 4]>> = points
        .iter()
        .map(|p| settings::get(db, &key(p)).ok().flatten().and_then(|v| serde_json::from_str(&v).ok()))
        .collect();
    let missing: Vec<usize> = (0..points.len()).filter(|&i| out[i].is_none()).collect();
    if missing.is_empty() {
        return out;
    }
    let path = HELPER.get().cloned().unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/helpers/places").into());
    let Ok(mut child) = Command::new(path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else { return out };
    if let Some(mut stdin) = child.stdin.take() {
        let lines: String = missing.iter().map(|&i| format!("{}\t{}\n", points[i].0, points[i].1)).collect();
        let _ = stdin.write_all(lines.as_bytes());
    }
    let Ok(answer) = child.wait_with_output() else { return out };
    for (&i, line) in missing.iter().zip(String::from_utf8_lossy(&answer.stdout).lines()) {
        let f: Vec<&str> = line.split('\t').collect();
        if f.first() == Some(&"ok") && f.len() == 5 {
            let v = [f[1].to_owned(), f[2].to_owned(), f[3].to_owned(), f[4].to_owned()];
            let _ = settings::set(db, &key(&points[i]), &serde_json::to_string(&v).unwrap_or_default());
            out[i] = Some(v);
        }
    }
    out
}

/// A place's name and country from a few of its points: the town when the
/// points that know one agree on it (Pai), else the area they share (Bangkok),
/// else the centre's town.
fn name_from(found: &[Option<[String; 4]>]) -> Option<(String, String)> {
    let known: Vec<&[String; 4]> = found.iter().flatten().collect();
    let centre = known.first()?;
    let pick = |i: usize| -> Option<String> {
        let said: Vec<&String> = known.iter().map(|k| &k[i]).filter(|v| !v.trim().is_empty()).collect();
        let first = places::folder_name(said.first()?);
        (!first.is_empty() && said.iter().all(|v| places::folder_name(v) == first)).then(|| said[0].clone())
    };
    let name = pick(0).or_else(|| pick(1)).or_else(|| pick(2)).or_else(|| [&centre[0], &centre[1], &centre[2]].into_iter().find(|s| !s.is_empty()).cloned())?;
    let country = known.iter().map(|k| k[3].clone()).find(|c| !c.is_empty()).unwrap_or_default();
    Some((name, country))
}

#[tauri::command]
pub async fn trip_places(app: AppHandle, trip: String) -> Reply<places::Proposal> {
    blocking(move || {
        let db = &app.state::<AppState>().db;
        places::propose(db, &trip, &|probes| name_from(&geocode(db, probes)))
    })
    .await
}

#[tauri::command]
pub async fn make_places(app: AppHandle, trip: String, choices: Vec<places::Choice>) -> Reply<trips::MoveReport> {
    blocking(move || {
        let db = &app.state::<AppState>().db;
        let r = places::make(db, &trip, &choices)?;
        crate::applog::line(&format!("places: {} photos of {trip} into {} places, {} failed", r.moved, choices.len(), r.failed.len()));
        Ok(r)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(locality: &str, sub: &str, area: &str) -> Option<[String; 4]> {
        Some([locality.into(), sub.into(), area.into(), "Thailand".into()])
    }

    #[test]
    fn a_name_the_points_agree_on() {
        assert_eq!(name_from(&vec![at("Pai District", "Pai District", "Mae Hong Son"); 3]).map(|n| n.0).as_deref(), Some("Pai District"));
        // A big city: districts differ, the area holds.
        let bkk = [at("Phra Nakhon District", "Phra Nakhon District", "Bangkok"), at("Pathum Wan District", "Pathum Wan District", "Bangkok"), at("Bang Rak District", "Bang Rak District", "Bangkok")];
        assert_eq!(name_from(&bkk).map(|n| n.0).as_deref(), Some("Bangkok"));
        // A point without a town doesn't spoil the others' answer.
        assert_eq!(name_from(&[at("Sawi District", "Sawi District", "Chumphon"), at("", "", "")]).map(|n| n.0).as_deref(), Some("Sawi District"));
        assert_eq!(name_from(&[None, None]), None);
    }
}
