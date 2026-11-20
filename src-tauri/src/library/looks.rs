//! Looks: your Lightroom presets, .cube LUTs and HaldCLUT film emulations,
//! all turned into one thing the UI can render live: a 33³ colour lookup table.
//!
//! Nothing here writes to a photo. A look and its adjustments are stored per
//! photo in the database and applied on screen, or baked into an exported copy.
//! Preset files are read (and copied into the app's folder, so the look
//! survives if the original is moved); they are never modified. LUT files are
//! only read: the baked table is what the app keeps.
//!
//! Lightroom presets are approximated: global tone, curves, HSL, colour grading,
//! white balance, vibrance and saturation map well onto a LUT; local effects
//! (clarity, texture, sharpening, noise reduction) cannot, and dehaze is folded
//! in as contrast and saturation. Grain and vignette are spatial, so they become
//! the look's default adjustments instead.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::db::Db;
use super::{new_id, now_ms, settings, Error, Result};

pub const LUT_SIZE: usize = 33;
pub const FOLDERS_KEY: &str = "looks.folders";
/// Preset files are copied into the app (so a look survives the file moving);
/// LUT files are not: their baked table is the app's copy.
const COPY_LIMIT: u64 = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Preset,
    Cube,
    Hald,
    /// One of yours, saved from an edit: a look plus every slider. Stored as
    /// a preset row whose settings hold the recipe.
    Saved,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Preset | Kind::Saved => "preset",
            Kind::Cube => "cube",
            Kind::Hald => "hald",
        }
    }
    fn parse(s: &str) -> Kind {
        match s {
            "cube" => Kind::Cube,
            "hald" => Kind::Hald,
            _ => Kind::Preset,
        }
    }
}

/// Spatial effects a look brings along, used as its default adjustments.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Effects {
    pub grain: f64,
    pub vignette: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Look {
    pub id: String,
    pub kind: Kind,
    pub name: String,
    pub author: String,
    pub collection: String,
    pub source_path: String,
    pub effects: Effects,
    /// Colours of skin, sky, foliage, grey and shadow through the look; empty until baked.
    pub swatch: Vec<String>,
    pub baked: bool,
    pub used_by: i64,
    /// Number key 1-9 in the editor, when pinned.
    pub favorite: Option<i64>,
    /// A saved look's sliders, applied along with it (never the crop).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adjustments: Option<Adjustments>,
}

/// The collection your own looks are listed under.
pub const YOUR_LOOKS: &str = "Your looks";

/// The basic sliders, all -100..100 except exposure (stops).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Adjustments {
    pub exposure: f64,
    pub contrast: f64,
    pub highlights: f64,
    pub shadows: f64,
    pub whites: f64,
    pub blacks: f64,
    pub temperature: f64,
    pub tint: f64,
    pub vibrance: f64,
    pub saturation: f64,
    pub grain: f64,
    pub vignette: f64,
    /// Effects, 0..100: matte fade, softness, film halation, colour fringes,
    /// tape scan lines, gate weave, light leak (drawn by the editor's shader
    /// and the clip helper; none of them can be baked into a look table).
    pub fade: f64,
    pub soften: f64,
    pub halation: f64,
    pub fringe: f64,
    pub scanlines: f64,
    pub weave: f64,
    pub leak: f64,
    /// Straightening in degrees, clockwise.
    pub straighten: f64,
    /// Where the crop is centred, as an offset from the photo's centre in
    /// percent of its width / height (-50..50, down is positive).
    pub crop_x: f64,
    pub crop_y: f64,
    /// Extra zoom into the crop, 0..100 (100 = twice as close).
    pub crop_zoom: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoLook {
    pub photo_id: String,
    pub look_id: Option<String>,
    pub strength: f64,
    pub adjustments: Adjustments,
    /// A clip filmed in S-Log3: shown and exported converted to normal colour.
    pub log: bool,
}

const IS_LOG: &str = "SELECT COALESCE(gamma LIKE 's-log3%', 0) FROM photos WHERE id = ?1";

// ------------------------------------------------------------------ importing

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub added: usize,
    pub known: usize,
    pub skipped: usize,
    pub failed: usize,
}

/// Built-in look folders the user removed in Settings: never searched again.
pub const HIDDEN_KEY: &str = "looks.hiddenFolders";

fn string_list(db: &Db, key: &str) -> Result<Vec<String>> {
    Ok(settings::get(db, key)?.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default())
}

fn set_string_list(db: &Db, key: &str, list: &[String]) -> Result<()> {
    settings::set(db, key, &serde_json::to_string(list).expect("json"))
}

/// Where looks are searched: Lightroom's preset folders, the MEDIA folder, the
/// film library, and any folder added in Settings, minus the ones removed there.
pub fn folders(db: &Db) -> Result<Vec<PathBuf>> {
    let hidden = string_list(db, HIDDEN_KEY)?;
    let mut out = candidate_folders(db)?;
    out.retain(|p| p.is_dir() && !hidden.iter().any(|h| Path::new(h) == p));
    Ok(out)
}

/// A folder looks come from, for Settings.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LookFolder {
    pub path: String,
    /// Added by hand (otherwise found automatically).
    pub added: bool,
    pub looks: usize,
}

/// The folders looks come from, with how many looks each gave.
pub fn folder_list(db: &Db) -> Result<Vec<LookFolder>> {
    let added = string_list(db, FOLDERS_KEY)?;
    let list = folders(db)?;
    db.read(|c| {
        let mut count = c.prepare("SELECT COUNT(*) FROM looks WHERE source_path LIKE ?1 ESCAPE '\\'")?;
        list.iter()
            .map(|p| {
                let text = p.to_string_lossy().into_owned();
                let like = format!("{}/%", text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
                let looks: i64 = count.query_row([like], |r| r.get(0))?;
                Ok(LookFolder { added: added.contains(&text), path: text, looks: looks as usize })
            })
            .collect()
    })
}

/// Adds a folder to search (or brings back a removed built-in one).
pub fn add_folder(db: &Db, path: &str) -> Result<()> {
    let mut hidden = string_list(db, HIDDEN_KEY)?;
    let was_hidden = hidden.iter().any(|h| h == path);
    hidden.retain(|h| h != path);
    set_string_list(db, HIDDEN_KEY, &hidden)?;
    let builtin = candidate_folders(db)?.iter().any(|p| p.to_string_lossy() == path) && !string_list(db, FOLDERS_KEY)?.iter().any(|a| a == path);
    if !(was_hidden && builtin) {
        let mut added = string_list(db, FOLDERS_KEY)?;
        if !added.iter().any(|a| a == path) {
            added.push(path.to_owned());
            set_string_list(db, FOLDERS_KEY, &added)?;
        }
    }
    Ok(())
}

/// Stops searching a folder and removes its looks, except looks photos use
/// (those stay, so no edited photo changes). Returns (removed, kept).
pub fn remove_folder(db: &Db, looks_dir: &Path, path: &str) -> Result<(usize, usize)> {
    let mut added = string_list(db, FOLDERS_KEY)?;
    if added.iter().any(|a| a == path) {
        added.retain(|a| a != path);
        set_string_list(db, FOLDERS_KEY, &added)?;
    } else {
        let mut hidden = string_list(db, HIDDEN_KEY)?;
        if !hidden.iter().any(|h| h == path) {
            hidden.push(path.to_owned());
            set_string_list(db, HIDDEN_KEY, &hidden)?;
        }
    }
    let like = format!("{}/%", path.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let found: Vec<(String, bool)> = db.read(|c| {
        let mut stmt = c.prepare(
            "SELECT l.id, EXISTS (SELECT 1 FROM photo_looks pl WHERE pl.look_id = l.id)
             FROM looks l WHERE l.source_path LIKE ?1 ESCAPE '\\'",
        )?;
        let rows = stmt.query_map([like], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })?;
    let (mut removed, mut kept) = (0, 0);
    for (id, used) in found {
        if used {
            kept += 1;
        } else {
            delete(db, looks_dir, &id)?;
            removed += 1;
        }
    }
    Ok((removed, kept))
}

fn candidate_folders(db: &Db) -> Result<Vec<PathBuf>> {
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(home.join("Pictures")) {
        for e in entries.flatten() {
            if e.path().extension().is_some_and(|x| x == "lrlibrary") {
                out.push(e.path());
            }
        }
    }
    out.push(home.join("Library/Application Support/Adobe/CameraRaw/Settings"));
    // DaVinci Resolve's own creative LUTs (not its camera-log conversions).
    let resolve = Path::new("/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT");
    for dir in ["Film Emulation", "Look LUTs", "Film Looks"] {
        out.push(resolve.join(dir));
    }
    out.push(home.join("Movies/OFFICE/MEDIA"));
    out.push(home.join("Pictures/PhotoResources"));
    out.extend(string_list(db, FOLDERS_KEY)?.into_iter().map(PathBuf::from));
    out.dedup();
    Ok(out)
}

fn skip_dir(name: &str) -> bool {
    name.starts_with('.')
        || name == "node_modules"
        || [".photoslibrary", ".fcpbundle", ".imovielibrary", ".app", ".cocatalog", ".lrdata"].iter().any(|s| name.ends_with(s))
}

struct Candidate {
    kind: Kind,
    name: String,
    author: String,
    collection: String,
    settings: Value,
    path: PathBuf,
    size: u64,
}

/// Finds looks in these folders and records the new ones. Safe to run again:
/// known files and duplicates (same kind, name and size) are skipped.
pub fn import(db: &Db, looks_dir: &Path, roots: &[PathBuf]) -> Result<ImportReport> {
    std::fs::create_dir_all(looks_dir.join("src"))?;
    let mut seen: HashSet<(String, String, i64)> = HashSet::new();
    let mut known_paths: HashSet<String> = HashSet::new();
    db.read(|c| {
        let mut stmt = c.prepare("SELECT kind, lower(name), source_path, json_extract(settings, '$.size') FROM looks")?;
        for row in stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<i64>>(3)?))
        })? {
            let (k, n, p, s) = row?;
            seen.insert((k, n, s.unwrap_or(-1)));
            known_paths.insert(p);
        }
        Ok(())
    })?;
    let mut report = ImportReport::default();
    for root in roots {
        let walker = walkdir::WalkDir::new(root)
            .max_depth(12)
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !e.file_type().is_dir() || !skip_dir(&e.file_name().to_string_lossy()));
        for entry in walker.filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
            if !matches!(ext.as_str(), "xmp" | "cube" | "png") {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if super::scan::is_dataless(&meta) {
                report.skipped += 1;
                continue;
            }
            let text_path = path.to_string_lossy().into_owned();
            if known_paths.contains(&text_path) {
                report.known += 1;
                continue;
            }
            let found = match ext.as_str() {
                "xmp" if meta.len() < 1024 * 1024 => candidate_preset(path, meta.len()),
                "cube" if meta.len() < 64 * 1024 * 1024 => candidate_cube(path, meta.len()),
                "png" if text_path.to_ascii_lowercase().contains("haldclut") => candidate_hald(path, meta.len()),
                _ => Ok(None),
            };
            let cand = match found {
                Ok(Some(c)) => c,
                Ok(None) => continue,
                Err(_) => {
                    report.failed += 1;
                    continue;
                }
            };
            let key = (cand.kind.as_str().to_owned(), cand.name.to_lowercase(), cand.size as i64);
            if !seen.insert(key) {
                report.known += 1;
                continue;
            }
            match record(db, looks_dir, cand) {
                Ok(true) => report.added += 1,
                Ok(false) => report.known += 1,
                Err(_) => report.failed += 1,
            }
        }
    }
    Ok(report)
}

/// Readable group names: "Resolve · Film emulation", "RawTherapee film · B&W",
/// or a downloaded pack's folder name.
fn collection_for(path: &Path, kind: Kind) -> String {
    let text = path.to_string_lossy();
    let lower = text.to_ascii_lowercase();
    let bw = lower.contains("black and white") || lower.contains("black-and-white") || lower.contains("/bw") || lower.contains("b&w");
    if lower.contains("davinci resolve/lut/") {
        return if lower.contains("/look luts/") { "Resolve · Creative looks".into() } else { "Resolve · Film emulation".into() };
    }
    if lower.contains("photoresources") {
        if kind == Kind::Hald {
            return if bw { "RawTherapee film · B&W".into() } else { "RawTherapee film".into() };
        }
        // …/PhotoResources/LUTs/<Category>/<Pack>/…: name the group after the pack.
        let parts: Vec<&str> = text.split('/').collect();
        if let Some(i) = parts.iter().position(|p| *p == "LUTs") {
            if let Some(pack) = parts.get(i + 2).filter(|p| !p.to_ascii_lowercase().ends_with(".cube")) {
                let name = pack.replace(['-', '_'], " ");
                return if bw && !name.to_ascii_lowercase().contains("b&w") { format!("{name} · B&W") } else { name };
            }
        }
        return "Film library".into();
    }
    match kind {
        Kind::Preset => "Your presets".into(),
        _ => "Your LUTs".into(),
    }
}

fn split_author(name: &str) -> (String, String) {
    match name.rsplit_once(" - ") {
        Some((n, a)) if !n.trim().is_empty() && !a.trim().is_empty() => (n.trim().to_owned(), a.trim().to_owned()),
        _ => (name.trim().to_owned(), String::new()),
    }
}

fn candidate_preset(path: &Path, size: u64) -> Result<Option<Candidate>> {
    let text = std::fs::read_to_string(path)?;
    let Some(preset) = parse_preset(&text) else { return Ok(None) };
    let fallback = path.file_stem().map(|s| s.to_string_lossy().replace('+', " ")).unwrap_or_default();
    let raw_name = preset.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or(fallback);
    let (name, author) = split_author(&raw_name);
    let mut settings = preset.to_json();
    settings["size"] = json!(size);
    Ok(Some(Candidate { kind: Kind::Preset, collection: collection_for(path, Kind::Preset), name, author, settings, path: path.into(), size }))
}

fn clean_lut_name(name: &str) -> String {
    // Drop table-size tags ("65x", "33"), "LUT" and dangling dashes: "Fuji 400H 1 - 65x" -> "Fuji 400H 1".
    let words: Vec<&str> = name.split_whitespace().collect();
    let mut keep = words.len();
    while keep > 1 {
        let w = words[keep - 1];
        let size_tag = w.ends_with(['x', 'X']) && w.len() > 1 && w[..w.len() - 1].chars().all(|c| c.is_ascii_digit());
        if size_tag || w == "-" || w == "--" || w.eq_ignore_ascii_case("lut") || w.eq_ignore_ascii_case("luts") {
            keep -= 1;
        } else {
            break;
        }
    }
    words[..keep].join(" ").trim_end_matches(['-', '_']).trim().to_owned()
}

fn candidate_cube(path: &Path, size: u64) -> Result<Option<Candidate>> {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let lower = stem.to_ascii_lowercase();
    // Identity tables do nothing; log conversions and P3 cinema variants wreck normal photos.
    let technical = ["identity", "slog", "s-log", "vlog", "v-log", "clog", "c-log", "logc", "flog", "f-log", "dci-p3", "to rec709", "to video", "false color"];
    if technical.iter().any(|t| lower.contains(t)) || lower.contains("apple log") || lower.contains("conversion") {
        return Ok(None);
    }
    // Only the header: big tables are parsed when baked.
    let mut head = String::new();
    use std::io::Read;
    std::fs::File::open(path)?.take(4096).read_to_string(&mut head).ok();
    let title = head.lines().find_map(|l| l.trim().strip_prefix("TITLE").map(|t| t.trim().trim_matches('"').to_owned()));
    if !head.contains("LUT_3D_SIZE") && !head.contains("LUT_1D_SIZE") {
        return Ok(None);
    }
    // File names are what people chose; embedded titles are often "Untitled".
    let generic = |n: &str| n.is_empty() || n.eq_ignore_ascii_case("untitled") || n.chars().all(|c| c.is_ascii_digit() || c == '_');
    let collection = collection_for(path, Kind::Cube);
    let base = if generic(&stem) { title.filter(|t| !generic(t)).unwrap_or(stem) } else { stem };
    let mut name = clean_lut_name(&base.replace('_', " ").replace(" - Standard", "").replace(" Standard", ""));
    // "IWLTBAP Arapaho" inside the "IWLTBAP Free Cinematic LUTs" group reads as "Arapaho".
    if let Some(prefix) = collection.split_whitespace().next().filter(|p| p.len() > 2) {
        if let Some(rest) = name.strip_prefix(&format!("{prefix} ")) {
            name = rest.trim().to_owned();
        }
    }
    Ok(Some(Candidate {
        kind: Kind::Cube,
        collection,
        name,
        author: String::new(),
        settings: json!({ "size": size }),
        path: path.into(),
        size,
    }))
}

fn candidate_hald(path: &Path, size: u64) -> Result<Option<Candidate>> {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    if stem.to_ascii_lowercase().contains("identity") {
        return Ok(None);
    }
    Ok(Some(Candidate {
        kind: Kind::Hald,
        collection: collection_for(path, Kind::Hald),
        name: stem.replace(['_', '-'], " ").split_whitespace().collect::<Vec<_>>().join(" "),
        author: String::new(),
        settings: json!({ "size": size }),
        path: path.into(),
        size,
    }))
}

fn record(db: &Db, looks_dir: &Path, cand: Candidate) -> Result<bool> {
    let id = new_id();
    // Only preset files (a few KB) are copied: LUTs live on as their baked table.
    let copy = if cand.kind == Kind::Preset && cand.size <= COPY_LIMIT {
        let ext = cand.path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        let dest = looks_dir.join("src").join(format!("{id}.{ext}"));
        std::fs::copy(&cand.path, &dest)?;
        Some(dest.to_string_lossy().into_owned())
    } else {
        None
    };
    db.write(|c| {
        let n = c.execute(
            "INSERT INTO looks (id, kind, name, author, collection, source_path, copy_path, settings, created_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT (source_path) DO NOTHING",
            params![
                id,
                cand.kind.as_str(),
                cand.name,
                cand.author,
                cand.collection,
                cand.path.to_string_lossy(),
                copy,
                cand.settings.to_string(),
                now_ms()
            ],
        )?;
        Ok(n == 1)
    })
}

// ------------------------------------------------------------------ listing

pub fn lut_path(looks_dir: &Path, id: &str) -> PathBuf {
    looks_dir.join("lut").join(format!("{id}.lut"))
}

fn look_row(r: &rusqlite::Row, looks_dir: &Path) -> rusqlite::Result<Look> {
    let id: String = r.get(0)?;
    let kind: String = r.get(1)?;
    let settings: String = r.get(6)?;
    let settings: Value = serde_json::from_str(&settings).unwrap_or(Value::Null);
    let effects = serde_json::from_value(settings.get("effects").cloned().unwrap_or(Value::Null)).unwrap_or_default();
    let swatch = serde_json::from_value(settings.get("swatch").cloned().unwrap_or(Value::Null)).unwrap_or_default();
    let saved = settings.get("saved");
    let adjustments = saved.and_then(|v| serde_json::from_value(v.get("adjustments").cloned().unwrap_or(Value::Null)).ok());
    Ok(Look {
        baked: lut_path(looks_dir, &id).is_file(),
        id,
        kind: if saved.is_some() { Kind::Saved } else { Kind::parse(&kind) },
        name: r.get(2)?,
        author: r.get(3)?,
        collection: r.get(4)?,
        source_path: r.get(5)?,
        effects,
        swatch,
        used_by: r.get(7)?,
        favorite: r.get(8)?,
        adjustments,
    })
}

const SELECT: &str = "SELECT l.id, l.kind, l.name, l.author, l.collection, l.source_path, l.settings,
       (SELECT COUNT(*) FROM photo_looks pl WHERE pl.look_id = l.id),
       (SELECT position FROM look_favorites f WHERE f.look_id = l.id)
FROM looks l";

pub fn list(db: &Db, looks_dir: &Path) -> Result<Vec<Look>> {
    db.read(|c| {
        let mut stmt = c.prepare_cached(&format!(
            "{SELECT} ORDER BY CASE l.collection WHEN 'Your looks' THEN 0 WHEN 'Your presets' THEN 1 WHEN 'Your LUTs' THEN 2 ELSE 3 END,
                      l.collection, l.name COLLATE NOCASE"
        ))?;
        let rows = stmt.query_map([], |r| look_row(r, looks_dir))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

pub fn get(db: &Db, looks_dir: &Path, id: &str) -> Result<Look> {
    db.read(|c| {
        c.query_row(&format!("{SELECT} WHERE l.id = ?1"), [id], |r| look_row(r, looks_dir))
            .optional()?
            .ok_or_else(|| Error::Invalid(format!("unknown look {id}")))
    })
}

/// Forgets a look (and the app's own copy and table). Your preset file stays.
pub fn delete(db: &Db, looks_dir: &Path, id: &str) -> Result<()> {
    let copy: Option<String> =
        db.read(|c| Ok(c.query_row("SELECT copy_path FROM looks WHERE id = ?1", [id], |r| r.get(0)).optional()?.flatten()))?;
    db.write(|c| {
        c.execute("DELETE FROM looks WHERE id = ?1", [id])?;
        Ok(())
    })?;
    let _ = std::fs::remove_file(lut_path(looks_dir, id));
    if let Some(copy) = copy.filter(|p| Path::new(p).starts_with(looks_dir)) {
        let _ = std::fs::remove_file(copy);
    }
    Ok(())
}

impl Adjustments {
    /// The same sliders without the framing (crop and straighten): what a
    /// look carries from one photo to another.
    pub fn without_framing(mut self) -> Self {
        self.straighten = 0.0;
        self.crop_x = 0.0;
        self.crop_y = 0.0;
        self.crop_zoom = 0.0;
        self
    }
}

/// Saves an edit as one of your looks: the look under it (if any) at its
/// strength, and every slider but the framing. Ready to use when it returns.
pub fn save(db: &Db, looks_dir: &Path, name: &str, base: Option<&str>, strength: f64, adjustments: &Adjustments) -> Result<Look> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::Invalid("a look needs a name".into()));
    }
    if let Some(base) = base {
        bake(db, looks_dir, base)?;
    }
    let id = new_id();
    let adj = adjustments.without_framing();
    let settings = json!({
        "saved": { "base": base, "strength": strength.clamp(0.0, 1.0), "adjustments": adj },
        "effects": Effects { grain: adj.grain, vignette: adj.vignette },
    });
    db.write(|c| {
        c.execute(
            "INSERT INTO looks (id, kind, name, author, collection, source_path, settings, created_ms) VALUES (?1, 'preset', ?2, '', ?3, ?4, ?5, ?6)",
            params![id, name, YOUR_LOOKS, format!("saved:{id}"), settings.to_string(), now_ms()],
        )?;
        Ok(())
    })?;
    bake(db, looks_dir, &id)?;
    get(db, looks_dir, &id)
}

/// Pins looks to the number keys, in order (at most nine).
pub fn set_favorites(db: &Db, ordered: &[String]) -> Result<()> {
    db.write(|c| {
        let tx = c.transaction()?;
        tx.execute("DELETE FROM look_favorites", [])?;
        for (i, id) in ordered.iter().take(9).enumerate() {
            tx.execute("INSERT OR IGNORE INTO look_favorites (look_id, position) VALUES (?1, ?2)", params![id, i as i64 + 1])?;
        }
        tx.commit()?;
        Ok(())
    })
}

// ------------------------------------------------------------------ per photo

pub fn for_photo(db: &Db, photo_id: &str) -> Result<PhotoLook> {
    db.read(|c| {
        let log: bool = c.query_row(IS_LOG, [photo_id], |r| r.get(0)).optional()?.unwrap_or(false);
        let found = c
            .query_row(
                "SELECT look_id, strength, adjustments FROM photo_looks WHERE photo_id = ?1",
                [photo_id],
                |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, f64>(1)?, r.get::<_, String>(2)?)),
            )
            .optional()?;
        Ok(match found {
            Some((look_id, strength, adj)) => PhotoLook {
                photo_id: photo_id.to_owned(),
                look_id,
                strength,
                adjustments: serde_json::from_str(&adj).unwrap_or_default(),
                log,
            },
            None => PhotoLook { photo_id: photo_id.to_owned(), look_id: None, strength: 1.0, adjustments: Adjustments::default(), log },
        })
    })
}

/// The saved edit of several photos at once (for grids that show them edited).
pub fn for_photos(db: &Db, photo_ids: &[String]) -> Result<Vec<PhotoLook>> {
    // One connection for the whole set (an undo snapshot can be thousands of photos).
    db.read(|c| {
        let mut stmt = c.prepare_cached("SELECT look_id, strength, adjustments FROM photo_looks WHERE photo_id = ?1")?;
        let mut is_log = c.prepare_cached(IS_LOG)?;
        photo_ids
            .iter()
            .map(|id| {
                let log: bool = is_log.query_row([id], |r| r.get(0)).optional()?.unwrap_or(false);
                let found = stmt
                    .query_row([id], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, f64>(1)?, r.get::<_, String>(2)?)))
                    .optional()?;
                Ok(match found {
                    Some((look_id, strength, adj)) => PhotoLook {
                        photo_id: id.clone(),
                        look_id,
                        strength,
                        adjustments: serde_json::from_str(&adj).unwrap_or_default(),
                        log,
                    },
                    None => PhotoLook { photo_id: id.clone(), look_id: None, strength: 1.0, adjustments: Adjustments::default(), log },
                })
            })
            .collect()
    })
}

/// An edit without its framing: what a look carries from photo to photo.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Recipe {
    pub look_id: Option<String>,
    pub strength: f64,
    pub adjustments: Adjustments,
}

impl Recipe {
    pub fn new(look_id: Option<String>, strength: f64, adjustments: &Adjustments) -> Self {
        Self { look_id, strength: strength.clamp(0.0, 1.0), adjustments: adjustments.without_framing() }
    }
    /// A saved edit is on this recipe: same look, strength and sliders (its framing aside).
    fn matches(&self, look_id: Option<&str>, strength: f64, adjustments: &Adjustments) -> bool {
        self.look_id.as_deref() == look_id
            && (self.look_id.is_none() || (self.strength - strength).abs() < 0.005)
            && self.adjustments == adjustments.without_framing()
    }
    fn is_empty(&self) -> bool {
        self.look_id.is_none() && self.adjustments == Adjustments::default()
    }
}

/// The look for a photo's album: the album's own (`set`), or, when none of
/// its albums has one, a suggestion from the edit its photos use most.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AlbumLook {
    pub album_id: String,
    pub album_name: String,
    /// The album's own look, set on purpose; otherwise a suggestion.
    pub set: bool,
    pub look_id: Option<String>,
    pub strength: f64,
    pub adjustments: Adjustments,
    /// Set: the album's photos exactly on it. Suggested: the photos using its look.
    pub uses: i64,
    /// This photo's edit is exactly this look.
    pub this_photo: bool,
}

struct AlbumEdit {
    album: String,
    album_name: String,
    photo: String,
    look_id: Option<String>,
    strength: f64,
    adjustments: Adjustments,
    updated: i64,
}

fn album_edits(c: &rusqlite::Connection, photo_id: &str) -> rusqlite::Result<Vec<AlbumEdit>> {
    let mut stmt = c.prepare_cached(
        "SELECT al.id, al.name, pa.photo_id, pl.look_id, pl.strength, pl.adjustments, pl.updated_ms
         FROM photo_albums mine
         JOIN albums al ON al.id = mine.album_id
         JOIN photo_albums pa ON pa.album_id = al.id
         JOIN photo_looks pl ON pl.photo_id = pa.photo_id
         WHERE mine.photo_id = ?1",
    )?;
    let rows = stmt
        .query_map([photo_id], |r| {
            let adj: String = r.get(5)?;
            Ok(AlbumEdit {
                album: r.get(0)?,
                album_name: r.get(1)?,
                photo: r.get(2)?,
                look_id: r.get(3)?,
                strength: r.get(4)?,
                adjustments: serde_json::from_str(&adj).unwrap_or_default(),
                updated: r.get(6)?,
            })
        })?
        .collect();
    rows
}

fn read_recipe(c: &rusqlite::Connection, album_id: &str) -> rusqlite::Result<Option<Recipe>> {
    c.query_row("SELECT look_id, strength, adjustments FROM album_looks WHERE album_id = ?1", [album_id], |r| {
        let adj: String = r.get(2)?;
        Ok(Recipe { look_id: r.get(0)?, strength: r.get(1)?, adjustments: serde_json::from_str(&adj).unwrap_or_default() })
    })
    .optional()
}

/// The look offered on a photo's page for its album (see `AlbumLook`).
pub fn album_look(db: &Db, photo_id: &str) -> Result<Option<AlbumLook>> {
    db.read(|c| {
        let edits = album_edits(c, photo_id)?;
        let mine = edits.iter().find(|e| e.photo == photo_id);
        let on = |r: &Recipe, e: Option<&AlbumEdit>| e.is_some_and(|e| r.matches(e.look_id.as_deref(), e.strength, &e.adjustments));

        // An album's own look comes first (by name, when several have one).
        let owned: Option<(String, String, Recipe)> = c
            .query_row(
                "SELECT al.id, al.name, l.look_id, l.strength, l.adjustments FROM photo_albums mine
                 JOIN albums al ON al.id = mine.album_id JOIN album_looks l ON l.album_id = al.id
                 WHERE mine.photo_id = ?1 ORDER BY al.name LIMIT 1",
                [photo_id],
                |r| {
                    let adj: String = r.get(4)?;
                    Ok((r.get(0)?, r.get(1)?, Recipe { look_id: r.get(2)?, strength: r.get(3)?, adjustments: serde_json::from_str(&adj).unwrap_or_default() }))
                },
            )
            .optional()?;
        if let Some((album_id, album_name, recipe)) = owned {
            let uses = edits.iter().filter(|e| e.album == album_id && on(&recipe, Some(e))).count() as i64;
            return Ok(Some(AlbumLook {
                this_photo: on(&recipe, mine),
                album_id,
                album_name,
                set: true,
                look_id: recipe.look_id,
                strength: recipe.strength,
                adjustments: recipe.adjustments,
                uses,
            }));
        }

        // A suggestion: of the other photos' edits, the album and look used most,
        // then the most common edit made with it there (the latest on a tie).
        let others: Vec<&AlbumEdit> = edits
            .iter()
            .filter(|e| e.photo != photo_id)
            .filter(|e| !Recipe::new(e.look_id.clone(), e.strength, &e.adjustments).is_empty())
            .collect();
        let mut by_look: BTreeMap<(&str, Option<&str>), i64> = BTreeMap::new();
        for e in &others {
            *by_look.entry((&e.album, e.look_id.as_deref())).or_default() += 1;
        }
        let name_of = |album: &str| others.iter().find(|e| e.album == album).map(|e| e.album_name.as_str()).unwrap_or("");
        let Some((&(album, look), &uses)) = by_look.iter().max_by(|(a, x), (b, y)| x.cmp(y).then_with(|| name_of(b.0).cmp(name_of(a.0)))) else {
            return Ok(None);
        };
        let mut recipes: BTreeMap<String, (i64, i64, &AlbumEdit)> = BTreeMap::new();
        for e in others.iter().filter(|e| e.album == album && e.look_id.as_deref() == look) {
            let key = format!("{:.2}|{}", e.strength, serde_json::to_string(&e.adjustments.without_framing()).unwrap_or_default());
            let entry = recipes.entry(key).or_insert((0, e.updated, e));
            entry.0 += 1;
            if e.updated > entry.1 {
                entry.1 = e.updated;
                entry.2 = e;
            }
        }
        let (_, _, best) = recipes.into_values().max_by_key(|(n, latest, _)| (*n, *latest)).expect("the album has edits with this look");
        let recipe = Recipe::new(best.look_id.clone(), best.strength, &best.adjustments);
        Ok(Some(AlbumLook {
            this_photo: on(&recipe, mine),
            album_id: best.album.clone(),
            album_name: best.album_name.clone(),
            set: false,
            look_id: recipe.look_id,
            strength: recipe.strength,
            adjustments: recipe.adjustments,
            uses,
        }))
    })
}

/// Makes `recipe` the album's own look (or with `None`, lets it go). Photos are not changed.
pub fn set_album_look(db: &Db, album_id: &str, recipe: Option<&Recipe>) -> Result<()> {
    db.write(|c| {
        match recipe {
            Some(r) => {
                let r = Recipe::new(r.look_id.clone(), r.strength, &r.adjustments);
                c.execute(
                    "INSERT INTO album_looks (album_id, look_id, strength, adjustments, updated_ms) VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT (album_id) DO UPDATE SET look_id = excluded.look_id, strength = excluded.strength,
                       adjustments = excluded.adjustments, updated_ms = excluded.updated_ms",
                    params![album_id, r.look_id, r.strength, serde_json::to_string(&r.adjustments).expect("json"), now_ms()],
                )?;
            }
            None => {
                c.execute("DELETE FROM album_looks WHERE album_id = ?1", [album_id])?;
            }
        }
        Ok(())
    })
}

/// What changing an album's look did, so it can be undone.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumLookChange {
    /// The album's look before, to set back on Undo.
    pub previous: Option<Recipe>,
    /// The photos that were on the old look, as they were (each keeps its framing).
    pub updated: Vec<PhotoLook>,
    /// Photos in the album with an edit of their own, left alone.
    pub left_alone: i64,
}

/// Changes an album's look, and with it every photo of the album still
/// exactly on the old one (each keeps its own framing). Photos edited by
/// hand since are left alone and counted.
pub fn change_album_look(db: &Db, album_id: &str, next: &Recipe) -> Result<AlbumLookChange> {
    let next = Recipe::new(next.look_id.clone(), next.strength, &next.adjustments);
    db.write(|c| {
        let tx = c.transaction()?;
        let previous = read_recipe(&tx, album_id)?;
        let mut updated = Vec::new();
        let mut left_alone = 0;
        {
            let mut stmt = tx.prepare(
                "SELECT pl.photo_id, pl.look_id, pl.strength, pl.adjustments FROM photo_albums pa
                 JOIN photo_looks pl ON pl.photo_id = pa.photo_id WHERE pa.album_id = ?1",
            )?;
            let edits: Vec<(String, Option<String>, f64, Adjustments)> = stmt
                .query_map([album_id], |r| {
                    let adj: String = r.get(3)?;
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, serde_json::from_str(&adj).unwrap_or_default()))
                })?
                .collect::<rusqlite::Result<_>>()?;
            let mut up = tx.prepare("UPDATE photo_looks SET look_id = ?2, strength = ?3, adjustments = ?4, updated_ms = ?5 WHERE photo_id = ?1")?;
            for (photo, look_id, strength, adj) in edits {
                let on_old = previous.as_ref().is_some_and(|p| p.matches(look_id.as_deref(), strength, &adj));
                if !on_old {
                    if !Recipe::new(look_id, strength, &adj).is_empty() {
                        left_alone += 1;
                    }
                    continue;
                }
                let framed = Adjustments { straighten: adj.straighten, crop_x: adj.crop_x, crop_y: adj.crop_y, crop_zoom: adj.crop_zoom, ..next.adjustments };
                up.execute(params![photo, next.look_id, next.strength, serde_json::to_string(&framed).expect("json"), now_ms()])?;
                updated.push(PhotoLook { photo_id: photo, look_id, strength, adjustments: adj, log: false });
            }
        }
        tx.execute(
            "INSERT INTO album_looks (album_id, look_id, strength, adjustments, updated_ms) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (album_id) DO UPDATE SET look_id = excluded.look_id, strength = excluded.strength,
               adjustments = excluded.adjustments, updated_ms = excluded.updated_ms",
            params![album_id, next.look_id, next.strength, serde_json::to_string(&next.adjustments).expect("json"), now_ms()],
        )?;
        tx.commit()?;
        Ok(AlbumLookChange { previous, updated, left_alone })
    })
}

/// Applies (or with `None`, removes) a look and optionally its adjustments on
/// several photos at once. Photos with nothing left are cleared entirely.
pub fn apply(db: &Db, photo_ids: &[String], look_id: Option<&str>, strength: f64, adjustments: Option<&Adjustments>) -> Result<usize> {
    let strength = strength.clamp(0.0, 1.0);
    let adj = adjustments.map(|a| serde_json::to_string(a).expect("adjustments"));
    db.write(|c| {
        let tx = c.transaction()?;
        let now = now_ms();
        let mut n = 0;
        {
            let mut up = tx.prepare_cached(
                "INSERT INTO photo_looks (photo_id, look_id, strength, adjustments, updated_ms)
                 VALUES (?1, ?2, ?3, COALESCE(?4, '{}'), ?5)
                 ON CONFLICT (photo_id) DO UPDATE SET look_id = excluded.look_id, strength = excluded.strength,
                   adjustments = COALESCE(?4, photo_looks.adjustments), updated_ms = excluded.updated_ms",
            )?;
            for id in photo_ids {
                n += up.execute(params![id, look_id, strength, adj, now])?;
            }
        }
        tx.execute("DELETE FROM photo_looks WHERE look_id IS NULL AND adjustments IN ('{}', ?1)", [serde_json::to_string(&Adjustments::default()).expect("json")])?;
        tx.commit()?;
        Ok(n)
    })
}

// ------------------------------------------------------------------ baking

/// A 33³ table of output colours, red changing fastest (the .cube order).
pub type Table = Vec<[f32; 3]>;

fn grid_value(i: usize) -> f32 {
    i as f32 / (LUT_SIZE - 1) as f32
}

fn table_from(f: impl Fn([f32; 3]) -> [f32; 3]) -> Table {
    let mut out = Vec::with_capacity(LUT_SIZE.pow(3));
    for b in 0..LUT_SIZE {
        for g in 0..LUT_SIZE {
            for r in 0..LUT_SIZE {
                let v = f([grid_value(r), grid_value(g), grid_value(b)]);
                out.push([v[0].clamp(0.0, 1.0), v[1].clamp(0.0, 1.0), v[2].clamp(0.0, 1.0)]);
            }
        }
    }
    out
}

/// Makes (once) and returns the look's table file: 33³ RGBA8, red fastest.
pub fn bake(db: &Db, looks_dir: &Path, id: &str) -> Result<PathBuf> {
    let dest = lut_path(looks_dir, id);
    if dest.is_file() {
        return Ok(dest);
    }
    let (kind, source, copy, settings): (String, String, Option<String>, String) = db.read(|c| {
        c.query_row("SELECT kind, source_path, copy_path, settings FROM looks WHERE id = ?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .optional()?
        .ok_or_else(|| Error::Invalid(format!("unknown look {id}")))
    })?;
    let file = copy.filter(|p| Path::new(p).is_file()).unwrap_or(source);
    let mut settings: Value = serde_json::from_str(&settings).unwrap_or_else(|_| json!({}));
    let table = if let Some(saved) = settings.get("saved").cloned() {
        // The look under it, mixed with no change at its strength: the same
        // mix the renderer makes, so the saved look draws exactly as edited.
        let strength = saved.get("strength").and_then(Value::as_f64).unwrap_or(1.0) as f32;
        match saved.get("base").and_then(Value::as_str) {
            Some(base) => {
                let bytes = std::fs::read(bake(db, looks_dir, base)?)?;
                let base: Table = bytes.chunks_exact(4).map(|p| [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0]).collect();
                let at = |v: f32| (v * (LUT_SIZE - 1) as f32).round() as usize;
                table_from(|c| {
                    let v = base[at(c[0]) + at(c[1]) * LUT_SIZE + at(c[2]) * LUT_SIZE * LUT_SIZE];
                    [c[0] + (v[0] - c[0]) * strength, c[1] + (v[1] - c[1]) * strength, c[2] + (v[2] - c[2]) * strength]
                })
            }
            None => table_from(|c| c),
        }
    } else {
        match Kind::parse(&kind) {
        Kind::Preset => {
            let preset = Preset::from_json(&settings).or_else(|| {
                std::fs::read_to_string(&file).ok().and_then(|t| parse_preset(&t))
            });
            let preset = preset.ok_or_else(|| Error::Media("not a Lightroom preset".into()))?;
            table_from(|c| preset.apply(c))
        }
        Kind::Cube => {
            let text = std::fs::read_to_string(&file)?;
            let cube = Cube::parse(&text)?;
            table_from(|c| cube.sample(c))
        }
        Kind::Hald => hald_table(Path::new(&file))?,
        Kind::Saved => unreachable!("parse never gives Saved"),
        }
    };
    let swatch = swatch(&table);
    std::fs::create_dir_all(dest.parent().expect("lut dir"))?;
    let mut bytes = Vec::with_capacity(table.len() * 4);
    for [r, g, b] in &table {
        bytes.extend_from_slice(&[(r * 255.0).round() as u8, (g * 255.0).round() as u8, (b * 255.0).round() as u8, 255]);
    }
    let tmp = dest.with_extension("partial");
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, &dest)?;
    settings["swatch"] = json!(swatch);
    db.write(|c| {
        c.execute("UPDATE looks SET settings = ?2 WHERE id = ?1", params![id, settings.to_string()])?;
        Ok(())
    })?;
    Ok(dest)
}

/// Bakes every look that has no table yet. Returns (baked, failed).
pub fn bake_all(db: &Db, looks_dir: &Path, cancel: &std::sync::atomic::AtomicBool) -> Result<(usize, usize)> {
    let ids: Vec<String> = db.read(|c| Ok(c.prepare("SELECT id FROM looks ORDER BY created_ms")?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?))?;
    let (mut ok, mut failed) = (0, 0);
    for id in ids {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
        if lut_path(looks_dir, &id).is_file() {
            continue;
        }
        match bake(db, looks_dir, &id) {
            Ok(_) => ok += 1,
            Err(_) => failed += 1,
        }
    }
    Ok((ok, failed))
}

fn sample_table(table: &Table, n: usize, c: [f32; 3]) -> [f32; 3] {
    let at = |r: usize, g: usize, b: usize| table[r + g * n + b * n * n];
    trilinear(n, c, at)
}

fn trilinear(n: usize, c: [f32; 3], at: impl Fn(usize, usize, usize) -> [f32; 3]) -> [f32; 3] {
    let scale = (n - 1) as f32;
    let mut i0 = [0usize; 3];
    let mut f = [0f32; 3];
    for k in 0..3 {
        let x = c[k].clamp(0.0, 1.0) * scale;
        let lo = (x.floor() as usize).min(n - 2);
        i0[k] = lo;
        f[k] = x - lo as f32;
    }
    let mut out = [0f32; 3];
    for corner in 0..8 {
        let (dr, dg, db) = (corner & 1, (corner >> 1) & 1, (corner >> 2) & 1);
        let w = (if dr == 1 { f[0] } else { 1.0 - f[0] }) * (if dg == 1 { f[1] } else { 1.0 - f[1] }) * (if db == 1 { f[2] } else { 1.0 - f[2] });
        if w == 0.0 {
            continue;
        }
        let v = at(i0[0] + dr, i0[1] + dg, i0[2] + db);
        for k in 0..3 {
            out[k] += w * v[k];
        }
    }
    out
}

fn swatch(table: &Table) -> Vec<String> {
    let refs = [[0.87, 0.67, 0.55], [0.45, 0.62, 0.85], [0.35, 0.5, 0.25], [0.5, 0.5, 0.5], [0.15, 0.15, 0.17]];
    refs.iter()
        .map(|c| {
            let [r, g, b] = sample_table(table, LUT_SIZE, *c);
            format!("#{:02x}{:02x}{:02x}", (r * 255.0).round() as u8, (g * 255.0).round() as u8, (b * 255.0).round() as u8)
        })
        .collect()
}

// ------------------------------------------------------------------ .cube

pub struct Cube {
    size: usize,
    one_d: bool,
    min: [f32; 3],
    max: [f32; 3],
    data: Vec<[f32; 3]>,
}

impl Cube {
    pub fn parse(text: &str) -> Result<Cube> {
        let (mut size, mut one_d) = (0usize, false);
        let (mut min, mut max) = ([0f32; 3], [1f32; 3]);
        let mut data = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut parts = line.split_whitespace();
            let first = parts.next().unwrap_or("");
            let triple = |parts: &mut std::str::SplitWhitespace| -> Option<[f32; 3]> {
                Some([parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?])
            };
            match first {
                "TITLE" => {}
                "LUT_3D_SIZE" => size = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0),
                "LUT_1D_SIZE" => {
                    size = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                    one_d = true;
                }
                "DOMAIN_MIN" => min = triple(&mut parts).unwrap_or(min),
                "DOMAIN_MAX" => max = triple(&mut parts).unwrap_or(max),
                "LUT_3D_INPUT_RANGE" | "LUT_1D_INPUT_RANGE" => {
                    let lo: f32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
                    let hi: f32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(1.0);
                    min = [lo; 3];
                    max = [hi; 3];
                }
                _ if first.starts_with(|c: char| c.is_ascii_digit() || c == '-' || c == '.') => {
                    let mut all = line.split_whitespace();
                    if let Some(v) = triple(&mut all) {
                        data.push(v);
                    }
                }
                _ => {}
            }
        }
        let expected = if one_d { size } else { size.pow(3) };
        if size < 2 || data.len() != expected {
            return Err(Error::Media(format!("bad .cube: size {size}, {} entries", data.len())));
        }
        Ok(Cube { size, one_d, min, max, data })
    }

    pub fn sample(&self, c: [f32; 3]) -> [f32; 3] {
        let mut x = [0f32; 3];
        for k in 0..3 {
            x[k] = ((c[k] - self.min[k]) / (self.max[k] - self.min[k]).max(1e-6)).clamp(0.0, 1.0);
        }
        if self.one_d {
            let n = self.size;
            let mut out = [0f32; 3];
            for k in 0..3 {
                let p = x[k] * (n - 1) as f32;
                let lo = (p.floor() as usize).min(n - 2);
                let f = p - lo as f32;
                out[k] = self.data[lo][k] * (1.0 - f) + self.data[lo + 1][k] * f;
            }
            out
        } else {
            sample_table(&self.data, self.size, x)
        }
    }
}

// ------------------------------------------------------------------ HaldCLUT

#[cfg(target_os = "macos")]
fn hald_table(path: &Path) -> Result<Table> {
    let px = super::media::raw_pixels(path)?;
    let level = (px.width as f64).cbrt().round() as usize;
    if level < 2 || level.pow(3) != px.width || px.width != px.height {
        return Err(Error::Media(format!("not a HaldCLUT: {}×{}", px.width, px.height)));
    }
    let n = level * level;
    let at = |r: usize, g: usize, b: usize| {
        let i = r + g * n + b * n * n;
        px.rgb(i % px.width, i / px.width)
    };
    Ok(table_from(|c| trilinear(n, c, at)))
}

#[cfg(not(target_os = "macos"))]
fn hald_table(_path: &Path) -> Result<Table> {
    Err(Error::Media("HaldCLUT needs macOS".into()))
}

// ------------------------------------------------------------------ Lightroom presets

/// The parts of a Lightroom / Camera Raw preset that can be expressed as colour.
#[derive(Clone, Debug, Default)]
pub struct Preset {
    pub name: Option<String>,
    pub values: BTreeMap<String, f32>,
    pub flags: BTreeMap<String, String>,
    pub curve: Vec<(f32, f32)>,
    pub curve_rgb: [Vec<(f32, f32)>; 3],
}

/// Reads a preset .xmp. Per-photo sidecars (no `crs:PresetType`) are not presets.
pub fn parse_preset(text: &str) -> Option<Preset> {
    if !text.contains("crs:PresetType=") {
        return None;
    }
    let start = text.find("<rdf:Description")?;
    let end = start + text[start..].find('>')?;
    let head = &text[start..end];
    let mut preset = Preset::default();
    let mut rest = head;
    while let Some(i) = rest.find("crs:") {
        rest = &rest[i + 4..];
        let Some(eq) = rest.find("=\"") else { break };
        let key = rest[..eq].trim().to_owned();
        let after = &rest[eq + 2..];
        let Some(close) = after.find('"') else { break };
        let value = &after[..close];
        rest = &after[close + 1..];
        if key.contains(char::is_whitespace) {
            continue;
        }
        match value.trim_start_matches('+').parse::<f32>() {
            Ok(v) => {
                preset.values.insert(key, v);
            }
            Err(_) => {
                preset.flags.insert(key, value.to_owned());
            }
        }
    }
    preset.name = element_text(text, "crs:Name");
    preset.curve = curve_points(text, "crs:ToneCurvePV2012");
    preset.curve_rgb = [
        curve_points(text, "crs:ToneCurvePV2012Red"),
        curve_points(text, "crs:ToneCurvePV2012Green"),
        curve_points(text, "crs:ToneCurvePV2012Blue"),
    ];
    Some(preset)
}

fn element_body<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let s = text.find(&open)? + open.len();
    let e = s + text[s..].find(&close)?;
    Some(&text[s..e])
}

fn element_text(text: &str, tag: &str) -> Option<String> {
    let body = element_body(text, tag)?;
    let li = body.find("<rdf:li")?;
    let s = li + body[li..].find('>')? + 1;
    let e = s + body[s..].find("</rdf:li>")?;
    Some(xml_unescape(body[s..e].trim()))
}

fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

fn curve_points(text: &str, tag: &str) -> Vec<(f32, f32)> {
    let Some(body) = element_body(text, tag) else { return Vec::new() };
    body.split("<rdf:li>")
        .skip(1)
        .filter_map(|chunk| {
            let v = chunk.split("</rdf:li>").next()?;
            let (x, y) = v.split_once(',')?;
            Some((x.trim().parse::<f32>().ok()? / 255.0, y.trim().parse::<f32>().ok()? / 255.0))
        })
        .collect()
}

impl Preset {
    fn v(&self, key: &str) -> f32 {
        self.values.get(key).copied().unwrap_or(0.0)
    }

    pub fn effects(&self) -> Effects {
        Effects { grain: self.v("GrainAmount") as f64, vignette: self.v("PostCropVignetteAmount") as f64 }
    }

    fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "values": self.values,
            "flags": self.flags,
            "curve": self.curve,
            "curveRgb": self.curve_rgb,
            "effects": self.effects(),
        })
    }

    fn from_json(v: &Value) -> Option<Preset> {
        let values: BTreeMap<String, f32> = serde_json::from_value(v.get("values")?.clone()).ok()?;
        Some(Preset {
            name: v.get("name").and_then(|n| n.as_str()).map(str::to_owned),
            values,
            flags: serde_json::from_value(v.get("flags").cloned().unwrap_or(Value::Null)).unwrap_or_default(),
            curve: serde_json::from_value(v.get("curve").cloned().unwrap_or(Value::Null)).unwrap_or_default(),
            curve_rgb: serde_json::from_value(v.get("curveRgb").cloned().unwrap_or(Value::Null)).unwrap_or_default(),
        })
    }

    /// One sRGB colour through the preset.
    pub fn apply(&self, c: [f32; 3]) -> [f32; 3] {
        let v = |k: &str| self.v(k);
        // White balance, in linear light.
        let (temp, tint) = if self.values.contains_key("IncrementalTemperature") || self.values.contains_key("IncrementalTint") {
            (v("IncrementalTemperature"), v("IncrementalTint"))
        } else if self.flags.get("WhiteBalance").is_some_and(|w| w == "Custom") && self.values.contains_key("Temperature") {
            (((v("Temperature") - 5500.0) / 35.0).clamp(-100.0, 100.0), (v("Tint") * 0.66).clamp(-100.0, 100.0))
        } else {
            (0.0, 0.0)
        };
        let mut lin = c.map(srgb_to_linear);
        let (t, m) = (temp / 100.0, tint / 100.0);
        lin[0] *= 1.0 + 0.18 * t + 0.04 * m;
        lin[1] *= 1.0 - 0.12 * m;
        lin[2] *= 1.0 - 0.18 * t + 0.04 * m;
        let exposure = v("Exposure2012") + if self.values.contains_key("Exposure2012") { 0.0 } else { v("Exposure") };
        lin = lin.map(|x| x * 2f32.powf(exposure));
        let mut rgb = lin.map(linear_to_srgb);

        // Tone, on luminance, then carried back to the channels.
        let dehaze = v("Dehaze") / 100.0;
        let clarity = v("Clarity2012") / 100.0;
        let contrast = (v("Contrast2012") / 100.0 + dehaze * 0.3 + clarity * 0.12).clamp(-1.0, 1.0);
        let l0 = luma(rgb);
        let mut l = l0;
        let lc = l.clamp(0.0, 1.0);
        l += contrast * (lc * lc * (3.0 - 2.0 * lc) - lc);
        let h = v("Highlights2012") / 100.0;
        let wh = smoothstep(0.45, 1.0, l);
        l += if h < 0.0 { h * 0.35 * wh * l } else { h * 0.2 * wh * (1.2 - l).max(0.0) };
        l += v("Shadows2012") / 100.0 * 0.25 * (1.0 - smoothstep(0.0, 0.55, l)) * smoothstep(0.0, 0.15, l);
        l += v("Whites2012") / 100.0 * 0.15 * smoothstep(0.6, 1.0, l);
        l += (v("Blacks2012") / 100.0 - dehaze * 0.3) * 0.12 * (1.0 - smoothstep(0.0, 0.35, l));
        let (s1, s2, s3) = (
            self.values.get("ParametricShadowSplit").copied().unwrap_or(25.0) / 100.0,
            self.values.get("ParametricMidtoneSplit").copied().unwrap_or(50.0) / 100.0,
            self.values.get("ParametricHighlightSplit").copied().unwrap_or(75.0) / 100.0,
        );
        for (key, centre) in [
            ("ParametricShadows", s1 / 2.0),
            ("ParametricDarks", (s1 + s2) / 2.0),
            ("ParametricLights", (s2 + s3) / 2.0),
            ("ParametricHighlights", (s3 + 1.0) / 2.0),
        ] {
            l += v(key) / 100.0 * 0.2 * (1.0 - ((l - centre).abs() / 0.25)).max(0.0);
        }
        rgb = if l0 > 1e-4 { rgb.map(|x| x * l / l0) } else { rgb.map(|x| x + (l - l0)) };
        rgb = rgb.map(|x| x.clamp(0.0, 1.0));

        // Point curves: the master curve on every channel, then per channel.
        if self.curve.len() >= 2 {
            let curve = Curve::new(&self.curve);
            rgb = rgb.map(|x| curve.at(x));
        }
        for k in 0..3 {
            if self.curve_rgb[k].len() >= 2 {
                rgb[k] = Curve::new(&self.curve_rgb[k]).at(rgb[k]);
            }
        }

        // HSL mixer.
        let (mut hue, mut sat, mut lig) = rgb_to_hsl(rgb);
        let bands = [
            ("Red", 0.0),
            ("Orange", 30.0),
            ("Yellow", 60.0),
            ("Green", 120.0),
            ("Aqua", 180.0),
            ("Blue", 240.0),
            ("Purple", 270.0),
            ("Magenta", 300.0),
        ];
        let (mut dh, mut ds, mut dl) = (0.0, 0.0, 0.0);
        for (i, (name, centre)) in bands.iter().enumerate() {
            let prev = bands[(i + bands.len() - 1) % bands.len()].1;
            let next = bands[(i + 1) % bands.len()].1;
            let d = hue_distance(hue, *centre);
            let span = if hue_signed(hue, *centre) < 0.0 { hue_distance(*centre, prev) } else { hue_distance(next, *centre) };
            let w = (1.0 - d / span.max(1.0)).max(0.0);
            if w == 0.0 {
                continue;
            }
            dh += w * v(&format!("HueAdjustment{name}")) / 100.0 * 30.0;
            ds += w * v(&format!("SaturationAdjustment{name}")) / 100.0;
            dl += w * v(&format!("LuminanceAdjustment{name}")) / 100.0;
        }
        hue = (hue + dh).rem_euclid(360.0);
        sat = (sat * (1.0 + ds)).clamp(0.0, 1.0);
        lig = (lig + dl * 0.25 * sat).clamp(0.0, 1.0);
        rgb = hsl_to_rgb(hue, sat, lig);

        // Vibrance (favours muted colours), then saturation.
        let (_, s_now, _) = rgb_to_hsl(rgb);
        let vib = v("Vibrance") / 100.0;
        let sat_amount = v("Saturation") / 100.0 + dehaze * 0.2;
        let y = luma(rgb);
        let factor = (1.0 + vib * (1.0 - s_now)) * (1.0 + sat_amount);
        rgb = rgb.map(|x| (y + (x - y) * factor).clamp(0.0, 1.0));

        // Colour grading: shadows / midtones / highlights, then global.
        let y = luma(rgb);
        let balance = v("SplitToningBalance") / 100.0;
        let pivot = 0.5 - 0.25 * balance;
        let blend = self.values.get("ColorGradeBlending").copied().unwrap_or(50.0) / 100.0;
        let w = 0.15 + 0.35 * blend;
        let high = smoothstep(pivot - w, pivot + w, y);
        let mid = (1.0 - ((y - pivot) / 0.5).powi(2)).max(0.0);
        for (hue_key, sat_key, lum_key, weight) in [
            ("SplitToningShadowHue", "SplitToningShadowSaturation", "ColorGradeShadowLum", 1.0 - high),
            ("SplitToningHighlightHue", "SplitToningHighlightSaturation", "ColorGradeHighlightLum", high),
            ("ColorGradeMidtoneHue", "ColorGradeMidtoneSat", "ColorGradeMidtoneLum", mid),
            ("ColorGradeGlobalHue", "ColorGradeGlobalSat", "ColorGradeGlobalLum", 1.0),
        ] {
            let amount = v(sat_key) / 100.0 * 0.35 * weight;
            if amount > 0.0 {
                let tint = hsl_to_rgb(v(hue_key), 1.0, 0.5);
                let ty = luma(tint).max(1e-3);
                for k in 0..3 {
                    rgb[k] *= 1.0 + amount * (tint[k] / ty - 1.0);
                }
            }
            let lum = v(lum_key) / 100.0 * 0.1 * weight;
            if lum != 0.0 {
                rgb = rgb.map(|x| x + lum);
            }
        }
        if self.flags.get("ConvertToGrayscale").is_some_and(|g| g.eq_ignore_ascii_case("true")) {
            let y = luma(rgb);
            rgb = [y; 3];
        }
        rgb.map(|x| x.clamp(0.0, 1.0))
    }
}

/// Monotone cubic (Fritsch–Carlson) through the curve points: no overshoot.
struct Curve {
    xs: Vec<f32>,
    ys: Vec<f32>,
    ms: Vec<f32>,
}

impl Curve {
    fn new(points: &[(f32, f32)]) -> Curve {
        let mut pts = points.to_vec();
        pts.sort_by(|a, b| a.0.total_cmp(&b.0));
        pts.dedup_by(|a, b| (a.0 - b.0).abs() < 1e-6);
        let xs: Vec<f32> = pts.iter().map(|p| p.0).collect();
        let ys: Vec<f32> = pts.iter().map(|p| p.1).collect();
        let n = xs.len();
        let d: Vec<f32> = (0..n.saturating_sub(1)).map(|i| (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]).max(1e-6)).collect();
        let mut ms = vec![0f32; n];
        if n >= 2 {
            ms[0] = d[0];
            ms[n - 1] = d[n - 2];
            for i in 1..n - 1 {
                ms[i] = if d[i - 1] * d[i] <= 0.0 { 0.0 } else { (d[i - 1] + d[i]) / 2.0 };
            }
            for i in 0..n - 1 {
                if d[i] == 0.0 {
                    ms[i] = 0.0;
                    ms[i + 1] = 0.0;
                } else {
                    let (a, b) = (ms[i] / d[i], ms[i + 1] / d[i]);
                    let s = a * a + b * b;
                    if s > 9.0 {
                        let t = 3.0 / s.sqrt();
                        ms[i] = t * a * d[i];
                        ms[i + 1] = t * b * d[i];
                    }
                }
            }
        }
        Curve { xs, ys, ms }
    }

    fn at(&self, x: f32) -> f32 {
        let n = self.xs.len();
        if x <= self.xs[0] {
            return self.ys[0];
        }
        if x >= self.xs[n - 1] {
            return self.ys[n - 1];
        }
        let i = self.xs.windows(2).position(|w| x >= w[0] && x <= w[1]).unwrap_or(0);
        let h = self.xs[i + 1] - self.xs[i];
        let t = (x - self.xs[i]) / h;
        let (t2, t3) = (t * t, t * t * t);
        (2.0 * t3 - 3.0 * t2 + 1.0) * self.ys[i]
            + (t3 - 2.0 * t2 + t) * h * self.ms[i]
            + (-2.0 * t3 + 3.0 * t2) * self.ys[i + 1]
            + (t3 - t2) * h * self.ms[i + 1]
    }
}

fn srgb_to_linear(x: f32) -> f32 {
    if x <= 0.04045 { x / 12.92 } else { ((x + 0.055) / 1.055).powf(2.4) }
}

fn linear_to_srgb(x: f32) -> f32 {
    let x = x.max(0.0);
    if x <= 0.0031308 { x * 12.92 } else { 1.055 * x.powf(1.0 / 2.4) - 0.055 }
}

fn luma(c: [f32; 3]) -> f32 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn hue_signed(h: f32, centre: f32) -> f32 {
    (h - centre + 540.0).rem_euclid(360.0) - 180.0
}

fn hue_distance(a: f32, b: f32) -> f32 {
    hue_signed(a, b).abs()
}

fn rgb_to_hsl(c: [f32; 3]) -> (f32, f32, f32) {
    let (max, min) = (c[0].max(c[1]).max(c[2]), c[0].min(c[1]).min(c[2]));
    let l = (max + min) / 2.0;
    if max - min < 1e-6 {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
    let h = if max == c[0] {
        ((c[1] - c[2]) / d).rem_euclid(6.0)
    } else if max == c[1] {
        (c[2] - c[0]) / d + 2.0
    } else {
        (c[0] - c[1]) / d + 4.0
    };
    (h * 60.0, s, l)
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> [f32; 3] {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = h.rem_euclid(360.0) / 60.0;
    let x = c * (1.0 - (hp.rem_euclid(2.0) - 1.0).abs());
    let (r, g, b) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    [r + m, g + m, b + m]
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRESET: &str = r#"<x:xmpmeta><rdf:RDF><rdf:Description rdf:about=""
    crs:PresetType="Normal" crs:WhiteBalance="Custom" crs:IncrementalTemperature="+42"
    crs:Exposure2012="+0.50" crs:Contrast2012="+10" crs:Saturation="-100" crs:ConvertToGrayscale="False">
    <crs:Name><rdf:Alt><rdf:li xml:lang="x-default">Bushell and a Peck - Cristy Proctor</rdf:li></rdf:Alt></crs:Name>
    <crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 14</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012>
    <crs:Look><rdf:Description crs:Name="Adobe Color" crs:Amount="1"/></crs:Look>
    </rdf:Description></rdf:RDF></x:xmpmeta>"#;

    #[test]
    fn presets_parse_and_sidecars_do_not() {
        let p = parse_preset(PRESET).unwrap();
        assert_eq!(p.name.as_deref(), Some("Bushell and a Peck - Cristy Proctor"));
        assert_eq!(p.values["Exposure2012"], 0.5);
        assert_eq!(p.values["IncrementalTemperature"], 42.0);
        assert!(!p.values.contains_key("Amount"), "the nested profile is not the preset");
        assert_eq!(p.curve, vec![(0.0, 14.0 / 255.0), (1.0, 1.0)]);
        assert_eq!(split_author("Bushell and a Peck - Cristy Proctor"), ("Bushell and a Peck".into(), "Cristy Proctor".into()));
        assert!(parse_preset(r#"<rdf:Description crs:RawFileName="IMG_1.ARW" crs:Exposure2012="+1">"#).is_none());
    }

    #[test]
    fn preset_math_does_what_the_sliders_say() {
        let p = parse_preset(PRESET).unwrap();
        let grey = p.apply([0.4, 0.4, 0.4]);
        assert!(grey[0] > 0.4, "exposure +0.5 brightens: {grey:?}");
        let colour = p.apply([0.8, 0.3, 0.2]);
        assert!((colour[0] - colour[1]).abs() < 0.02 && (colour[1] - colour[2]).abs() < 0.02, "saturation -100 is grey: {colour:?}");
        assert!(p.apply([0.0, 0.0, 0.0])[0] > 0.04, "the curve lifts black to 14/255");

        let identity = Preset::default();
        for c in [[0.1, 0.5, 0.9], [0.5, 0.5, 0.5], [1.0, 0.0, 0.3]] {
            let out = identity.apply(c);
            for k in 0..3 {
                assert!((out[k] - c[k]).abs() < 0.01, "an empty preset changes nothing: {c:?} -> {out:?}");
            }
        }
    }

    #[test]
    fn cube_files_parse_and_interpolate() {
        let mut text = String::from("TITLE \"Swap\"\nLUT_3D_SIZE 2\n");
        for b in 0..2 {
            for g in 0..2 {
                for r in 0..2 {
                    // Output = input with red and blue swapped.
                    text.push_str(&format!("{} {} {}\n", b, g, r));
                }
            }
        }
        let cube = Cube::parse(&text).unwrap();
        let out = cube.sample([0.25, 0.5, 0.75]);
        assert!((out[0] - 0.75).abs() < 1e-5 && (out[1] - 0.5).abs() < 1e-5 && (out[2] - 0.25).abs() < 1e-5, "{out:?}");
        assert!(Cube::parse("LUT_3D_SIZE 2\n0 0 0\n").is_err());
    }

    #[test]
    fn curves_are_monotone_and_hit_their_points() {
        let c = Curve::new(&[(0.0, 0.05), (0.25, 0.13), (0.5, 0.5), (0.95, 1.0)]);
        assert!((c.at(0.25) - 0.13).abs() < 1e-5);
        let mut last = -1.0;
        for i in 0..=100 {
            let y = c.at(i as f32 / 100.0);
            assert!(y >= last - 1e-6, "not monotone at {i}");
            last = y;
        }
    }

    #[test]
    fn lut_names_are_tidied() {
        assert_eq!(clean_lut_name("Fuji 400H 1 - 65x"), "Fuji 400H 1");
        assert_eq!(clean_lut_name("Fuji Velvia 50 65x"), "Fuji Velvia 50");
        assert_eq!(clean_lut_name("Crash Course Orange Teal LUT"), "Crash Course Orange Teal");
        assert_eq!(clean_lut_name("Arabica 12"), "Arabica 12");
    }

    #[test]
    fn hsl_round_trips() {
        for c in [[0.9, 0.2, 0.1], [0.1, 0.6, 0.3], [0.2, 0.3, 0.8], [0.5, 0.5, 0.5]] {
            let (h, s, l) = rgb_to_hsl(c);
            let back = hsl_to_rgb(h, s, l);
            for k in 0..3 {
                assert!((back[k] - c[k]).abs() < 1e-4, "{c:?} -> {back:?}");
            }
        }
    }
}
