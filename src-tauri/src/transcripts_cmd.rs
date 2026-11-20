//! What is said in each video (NIRMATA Amendment 9b), made on this Mac with
//! whisper.cpp. The sound comes from a copy that is already on the Mac (the
//! clip's 540p preview, or the original when it is downloaded): a 4K original
//! that lives only on Drive is never downloaded just to be transcribed.
//!
//! The queue runs newest first, only on mains power, and waits while a video
//! plays; on battery it pauses and looks again every minute, so it carries on by
//! itself when the Mac is plugged in. Results go in `video_transcripts`, beside
//! the library, never into the video file.
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::app::AppState;
use crate::library::{db::Db, review, scan, thumbs};

type Reply<T> = Result<T, String>;

static RUNNING: AtomicBool = AtomicBool::new(false);
static PLAYING: AtomicBool = AtomicBool::new(false);
static LAST_PLAY_MS: AtomicU64 = AtomicU64::new(0);

const WHISPER: [&str; 2] = ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"];

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn whisper() -> Option<PathBuf> {
    WHISPER.iter().map(PathBuf::from).find(|p| p.is_file())
}

/// The multilingual model (FR / NL / EN / ES are auto-detected).
fn model() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    ["ggml-small.bin", "ggml-base.bin"].iter().map(|m| home.join(".cache/whisper").join(m)).find(|p| p.is_file())
}

/// On mains power (« AC Power » in pmset), or a desktop without a battery.
pub fn on_mains() -> bool {
    Command::new("/usr/bin/pmset").args(["-g", "batt"]).output().map(|o| {
        let t = String::from_utf8_lossy(&o.stdout);
        t.contains("AC Power") || !t.contains("InternalBattery")
    }).unwrap_or(true)
}

/// The file the sound is read from, when one is on this Mac.
fn sound_source(db: &Db, cache_root: &Path, id: &str) -> Option<PathBuf> {
    if let Some(p) = review::existing(cache_root, id) {
        return Some(p);
    }
    let (path, _) = thumbs::video_file(db, id).ok()?;
    std::fs::symlink_metadata(&path).ok().filter(|m| !scan::is_dataless(m)).map(|_| path)
}

/// Whisper's own markers for sounds that aren't speech.
fn is_marker(t: &str) -> bool {
    let t = t.trim();
    t.is_empty() || (t.starts_with('[') && t.ends_with(']')) || (t.starts_with('(') && t.ends_with(')')) || t == "♪" || t.chars().all(|c| !c.is_alphanumeric())
}

/// The languages he speaks and films in; anything else detected is music or noise.
pub const LANGUAGES: [&str; 4] = ["en", "fr", "nl", "es"];

/// Drops what whisper invents on music and silence: a language outside the four,
/// or the same line said three times or more.
pub fn clean(found: (String, String, Value)) -> (String, String, Value) {
    let (lang, words, segments, _) = clean_why(found);
    (lang, words, segments)
}

/// The same, saying which rule emptied it (kept with the transcript, so the
/// filters can be checked: a filter that hides real speech is worse than a wrong word).
pub fn clean_why((lang, words, segments): (String, String, Value)) -> (String, String, Value, &'static str) {
    let segs = segments.as_array().cloned().unwrap_or_default();
    let mut counts = std::collections::HashMap::new();
    for s in &segs {
        *counts.entry(s["text"].as_str().unwrap_or("").to_lowercase()).or_insert(0) += 1;
    }
    // A loop is one line making up most of what was « heard »; a real talk where
    // « Wow. » comes back three times is still speech (found on his Nepal vlog).
    let top = counts.values().copied().max().unwrap_or(0);
    let looping = top >= 3 && top * 2 >= segs.len();
    // Whisper's stock lines on silence or music, when they are all there is.
    let norm: String = words.to_lowercase().chars().filter(|c| c.is_alphanumeric() || c.is_whitespace()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    const STOCK: [&str; 12] = ["thank you", "thanks for watching", "thank you for watching", "music", "music playing", "you", "bye", "merci", "sous titres réalisés par la communauté damaraorg", "ondertiteld door de amaraorg gemeenschap", "gracias", "look"];
    let why = if words.trim().is_empty() {
        "markers only"
    } else if !LANGUAGES.contains(&lang.as_str()) {
        "other language"
    } else if looping {
        "repeated line"
    } else if STOCK.contains(&norm.as_str()) || (norm.split_whitespace().count() < 25 && ["click the bell", "subscribe to", "like and subscribe", "notified when i post"].iter().any(|p| norm.contains(p))) {
        "stock line"
    } else {
        ""
    };
    if !why.is_empty() {
        return (lang, String::new(), json!([]), why);
    }
    (lang, words, Value::Array(segs), "")
}

/// Cuts a phrase repeated three times or more in a row down to once
/// (« a little bit of a little bit of a little bit of » → « a little bit of »).
pub fn unloop(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut out: Vec<&str> = Vec::with_capacity(words.len());
    let mut i = 0;
    'outer: while i < words.len() {
        for n in (1..=6).rev() {
            if i + 3 * n > words.len() {
                continue;
            }
            let unit = &words[i..i + n];
            let mut k = 1;
            while i + (k + 1) * n <= words.len() && &words[i + k * n..i + (k + 1) * n] == unit {
                k += 1;
            }
            if k >= 3 {
                out.extend_from_slice(unit);
                i += k * n;
                continue 'outer;
            }
        }
        out.push(words[i]);
        i += 1;
    }
    out.join(" ")
}

/// whisper.cpp's JSON → (language, text, timed segments). Markers are left out.
pub fn parse_whisper(json_text: &str) -> Result<(String, String, Value), String> {
    let v: Value = serde_json::from_str(json_text).map_err(|e| format!("unreadable transcript: {e}"))?;
    let lang = v["result"]["language"].as_str().unwrap_or("").to_owned();
    let mut segments: Vec<Value> = vec![];
    let mut words = vec![];
    for t in v["transcription"].as_array().into_iter().flatten() {
        let text = unloop(t["text"].as_str().unwrap_or("").trim());
        if is_marker(&text) {
            continue;
        }
        let from = t["offsets"]["from"].as_f64().unwrap_or(0.0) / 1000.0;
        let to = t["offsets"]["to"].as_f64().unwrap_or(0.0) / 1000.0;
        if to > from {
            // The same line again right after: one line over the whole stretch.
            if let Some(last) = segments.last_mut() {
                if last["text"].as_str() == Some(text.as_str()) {
                    last["end"] = json!(to);
                    continue;
                }
            }
            segments.push(json!({"start": from, "end": to, "text": text}));
            words.push(text);
        }
    }
    Ok((lang, words.join(" "), Value::Array(segments)))
}

fn store(db: &Db, id: &str, state: &str, lang: &str, text: &str, segments: &Value, model: &str, seconds: Option<f64>, took: u64, error: &str) -> Result<(), String> {
    db.write(|c| {
        c.execute(
            "INSERT INTO video_transcripts (photo_id, state, language, text, segments, model, seconds, took_ms, error, made_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT (photo_id) DO UPDATE SET state = ?2, language = ?3, text = ?4, segments = ?5, model = ?6, seconds = ?7, took_ms = ?8, error = ?9, made_ms = ?10",
            rusqlite::params![id, state, lang, text, segments.to_string(), model, seconds, took as i64, error, now_ms() as i64],
        )?;
        Ok(())
    })
    .map_err(|e| e.to_string())
}

/// One video: sound out to a private WAV, whisper over it, the result stored.
pub fn transcribe_one(clip: &Path, db: &Db, cache_root: &Path, id: &str) -> Result<&'static str, String> {
    let corrected: bool = db.read(|c| Ok(c.query_row("SELECT corrected FROM video_transcripts WHERE photo_id = ?1", [id], |r| r.get::<_, i64>(0)).unwrap_or(0) != 0)).unwrap_or(false);
    if corrected {
        return Err("corrected by hand: kept as it is".into());
    }
    let source = sound_source(db, cache_root, id).ok_or("not on this Mac yet")?;
    let (Some(bin), Some(model)) = (whisper(), model()) else { return Err("whisper.cpp or its model is missing".into()) };
    let dir = std::env::temp_dir().join(format!("cba-transcript-{}", crate::library::new_id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let wav = dir.join("sound.wav");
    let started = Instant::now();
    let result = (|| -> Result<&'static str, String> {
        let out = Command::new(clip).arg(&source).arg(&wav).args(["--audio-wav", "1"]).output().map_err(|e| e.to_string())?;
        let said = String::from_utf8_lossy(&out.stdout);
        if said.contains("no sound in this file") {
            store(db, id, "no_speech", "", "", &json!([]), "", None, started.elapsed().as_millis() as u64, "no sound track")?;
            return Ok("no_speech");
        }
        if !wav.is_file() {
            return Err(format!("couldn't read the sound: {}", said.lines().last().unwrap_or("")));
        }
        let seconds = std::fs::metadata(&wav).map(|m| (m.len().saturating_sub(44)) as f64 / 32_000.0).ok();
        let base = dir.join("words");
        let threads = std::thread::available_parallelism().map(|n| (n.get() / 2).max(2)).unwrap_or(4).to_string();
        let w = Command::new(&bin)
            .arg("-m").arg(&model).arg("-f").arg(&wav)
            // No carried context (stops repetition loops) and whisper's own non-speech suppression.
            .args(["-l", "auto", "-oj", "-np", "-mc", "0", "-sns", "-t", &threads, "-of"]).arg(&base)
            .output().map_err(|e| e.to_string())?;
        if !w.status.success() {
            return Err(format!("whisper stopped: {}", String::from_utf8_lossy(&w.stderr).lines().last().unwrap_or("")));
        }
        // whisper.cpp can cut a multi-byte character between two tokens in its JSON
        // (17 of 431 clips on 19 Nov): read it leniently instead of failing the clip.
        let text = String::from_utf8_lossy(&std::fs::read(base.with_extension("json")).map_err(|e| e.to_string())?).into_owned();
        let raw = parse_whisper(&text)?;
        let heard = raw.1.chars().take(200).collect::<String>();
        let (lang, words, segments, why) = clean_why(raw);
        let model_name = model.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let state = if words.trim().is_empty() { "no_speech" } else { "done" };
        // For « No speech », keep why and what whisper heard, so the filters can be audited.
        let note = if why.is_empty() { String::new() } else { format!("{why}: {heard}") };
        store(db, id, state, &lang, &words, &segments, &model_name, seconds, started.elapsed().as_millis() as u64, &note)?;
        Ok(state)
    })();
    let _ = std::fs::remove_dir_all(&dir); // our own temp files only
    if let Err(e) = &result {
        if e != "not on this Mac yet" {
            let _ = store(db, id, "failed", "", "", &json!([]), "", None, started.elapsed().as_millis() as u64, e);
        }
    }
    result
}

/// Videos still to do, newest first.
fn todo(db: &Db) -> Vec<String> {
    db.read(|c| {
        let mut st = c.prepare(
            "SELECT p.id FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
             WHERE p.is_video = 1 AND a.storage_state != 'missing'
               AND NOT EXISTS (SELECT 1 FROM video_transcripts vt WHERE vt.photo_id = p.id
                               -- A failed clip is tried again once a day (a fix may have landed), never in a loop.
                               AND NOT (vt.state = 'failed' AND vt.made_ms < ?1))
             ORDER BY p.captured_at DESC",
        )?;
        let day_ago = crate::library::now_ms() - 24 * 3600 * 1000;
        let ids = st.query_map([day_ago], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(ids)
    })
    .unwrap_or_default()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    done: i64,
    total: i64,
    /// « running », « battery », « playing », « waiting » (nothing on this Mac to do), « missing » (no whisper).
    state: String,
}

fn status(db: &Db, state: &str) -> Status {
    let (done, total) = db
        .read(|c| {
            Ok(c.query_row(
                "SELECT (SELECT COUNT(*) FROM video_transcripts), (SELECT COUNT(*) FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1 WHERE p.is_video = 1 AND a.storage_state != 'missing')",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap_or((0, 0));
    Status { done, total, state: state.into() }
}

fn clip_helper<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .resolve("helpers/clip", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.is_file())
        .unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/helpers/clip").into())
}

/// Starts the queue once; it runs for the life of the app.
#[tauri::command]
pub async fn transcripts_start<R: Runtime>(app: AppHandle<R>) -> Reply<()> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let clip = clip_helper(&app);
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let (db, root) = (state.db.clone(), state.cache.root().to_path_buf());
        let say = |s: &str| {
            let _ = app.emit("transcripts-progress", status(&db, s));
        };
        loop {
            if whisper().is_none() || model().is_none() {
                say("missing");
                std::thread::sleep(Duration::from_secs(600));
                continue;
            }
            if !on_mains() {
                say("battery");
                std::thread::sleep(Duration::from_secs(60));
                continue;
            }
            // While a video plays (and for 20 s after), the Mac's attention is the viewer's.
            if PLAYING.load(Ordering::Relaxed) || now_ms().saturating_sub(LAST_PLAY_MS.load(Ordering::Relaxed)) < 20_000 {
                say("playing");
                std::thread::sleep(Duration::from_secs(5));
                continue;
            }
            let next = todo(&db).into_iter().find(|id| sound_source(&db, &root, id).is_some());
            let Some(id) = next else {
                say("waiting");
                std::thread::sleep(Duration::from_secs(300));
                continue;
            };
            say("running");
            match transcribe_one(&clip, &db, &root, &id) {
                Ok(s) => crate::applog::line(&format!("transcript {id}: {s}")),
                Err(e) => crate::applog::line(&format!("transcript {id} failed: {e}")),
            }
            say("running");
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn transcripts_status(state: State<'_, AppState>) -> Reply<Status> {
    let s = if whisper().is_none() || model().is_none() { "missing" } else if !on_mains() { "battery" } else { "running" };
    Ok(status(&state.db, s))
}

/// The viewer says when a video plays, so the queue keeps out of its way.
#[tauri::command]
pub async fn transcripts_playing(playing: bool) -> Reply<()> {
    PLAYING.store(playing, Ordering::Relaxed);
    if !playing {
        LAST_PLAY_MS.store(now_ms(), Ordering::Relaxed);
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    state: String,
    language: String,
    text: String,
    segments: String,
    error: String,
    corrected: bool,
}

/// A line corrected by hand: the new timed lines replace the old ones, the text
/// follows, and the transcript is marked corrected so no automatic run replaces it.
#[tauri::command]
pub async fn set_transcript_lines(state: State<'_, AppState>, id: String, segments: Value) -> Reply<()> {
    let rows = segments.as_array().ok_or("lines must be a list")?;
    let mut clean = vec![];
    for r in rows {
        let (Some(a), Some(b), Some(t)) = (r["start"].as_f64(), r["end"].as_f64(), r["text"].as_str()) else { return Err("each line needs start, end and text".into()) };
        let t = t.trim();
        if b > a && a >= 0.0 && !t.is_empty() {
            clean.push(json!({"start": a, "end": b, "text": t}));
        }
    }
    let text = clean.iter().map(|r| r["text"].as_str().unwrap_or("")).collect::<Vec<_>>().join(" ");
    let segs = Value::Array(clean).to_string();
    state
        .db
        .write(|c| {
            c.execute("UPDATE video_transcripts SET segments = ?2, text = ?3, corrected = 1 WHERE photo_id = ?1", rusqlite::params![id, segs, text])?;
            Ok(())
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn video_transcript(state: State<'_, AppState>, id: String) -> Reply<Option<Transcript>> {
    state
        .db
        .read(|c| {
            Ok(c.query_row("SELECT state, language, text, segments, error, corrected FROM video_transcripts WHERE photo_id = ?1", [&id], |r| {
                Ok(Transcript { state: r.get(0)?, language: r.get(1)?, text: r.get(2)?, segments: r.get(3)?, error: r.get(4)?, corrected: r.get::<_, i64>(5)? != 0 })
            })
            .ok())
        })
        .map_err(|e| e.to_string())
}

/// This one video now, whatever the power (he asked for it).
#[tauri::command]
pub async fn transcribe_video<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, id: String) -> Reply<String> {
    let (db, root) = (state.db.clone(), state.cache.root().to_path_buf());
    let clip = clip_helper(&app);
    tauri::async_runtime::spawn_blocking(move || transcribe_one(&clip, &db, &root, &id).map(str::to_owned))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markers_are_not_speech() {
        let j = r#"{"result":{"language":"en"},"transcription":[{"offsets":{"from":0,"to":12000},"text":" [Music]"}]}"#;
        let (lang, text, seg) = parse_whisper(j).unwrap();
        assert_eq!(lang, "en");
        assert!(text.is_empty());
        assert_eq!(seg, json!([]));
    }

    #[test]
    fn loops_inside_a_line_are_cut() {
        assert_eq!(unloop("I'm going to make a little bit of a little bit of a little bit of a little bit of"), "I'm going to make a little bit of");
        assert_eq!(unloop("no no no"), "no");
        assert_eq!(unloop("on est à Lima, on est bien"), "on est à Lima, on est bien");
    }

    #[test]
    fn invented_text_on_noise_is_dropped() {
        let other = clean(("nn".into(), "ご飯".into(), json!([{"start": 0.0, "end": 2.0, "text": "ご飯"}])));
        assert!(other.1.is_empty(), "a language outside FR/NL/EN/ES is noise");
        let looping = clean(("en".into(), "x".into(), json!([{"start": 0.0, "end": 4.0, "text": "1/2 tbsp"}, {"start": 4.0, "end": 8.0, "text": "1/2 tbsp"}, {"start": 8.0, "end": 12.0, "text": "1/2 tbsp"}])));
        assert!(looping.1.is_empty(), "the same line three times is a loop");
        let stock = clean(("en".into(), "Thank you.".into(), json!([{"start": 0.0, "end": 2.0, "text": "Thank you."}])));
        assert!(stock.1.is_empty(), "« Thank you. » alone is whisper's line on silence");
        let yt = clean(("en".into(), "Follow the video and click the bell to get notified when I post new videos".into(), json!([{"start": 0.0, "end": 7.0, "text": "x"}])));
        assert!(yt.1.is_empty(), "the YouTube outro the small model invents on music");
        let real = clean(("fr".into(), "Bonjour".into(), json!([{"start": 0.0, "end": 1.0, "text": "Bonjour"}])));
        assert_eq!(real.1, "Bonjour");
    }

    #[test]
    fn the_same_line_in_a_row_becomes_one() {
        let j = r#"{"result":{"language":"en"},"transcription":[{"offsets":{"from":0,"to":2000},"text":" The camera is on."},{"offsets":{"from":2000,"to":4000},"text":" The camera is on."},{"offsets":{"from":4000,"to":6000},"text":" Let's go."}]}"#;
        let (_, text, seg) = parse_whisper(j).unwrap();
        assert_eq!(text, "The camera is on. Let's go.");
        assert_eq!(seg[0]["end"], 4.0);
    }

    #[test]
    fn a_short_line_coming_back_in_real_talk_is_kept() {
        let seg = |t: &str, a: f64| json!({"start": a, "end": a + 1.0, "text": t});
        let talk = json!([seg("Is it stuck?", 0.0), seg("Wow.", 1.0), seg("I didn't vlog a whole of Nepal", 2.0), seg("Wow.", 3.0), seg("so it's time to vlog the trek now.", 4.0), seg("Wow.", 5.0), seg("Okay, let me know.", 6.0)]);
        let kept = clean(("en".into(), "talk".into(), talk));
        assert_eq!(kept.1, "talk", "real speech with a recurring « Wow. » is not a loop");
    }

    #[test]
    fn speech_keeps_its_times() {
        let j = r#"{"result":{"language":"fr"},"transcription":[{"offsets":{"from":1200,"to":3400},"text":" Bonjour à tous"},{"offsets":{"from":3400,"to":3900},"text":" (rires)"},{"offsets":{"from":4000,"to":6500},"text":" on est à Lima"}]}"#;
        let (lang, text, seg) = parse_whisper(j).unwrap();
        assert_eq!(lang, "fr");
        assert_eq!(text, "Bonjour à tous on est à Lima");
        assert_eq!(seg[0]["start"], 1.2);
        assert_eq!(seg[1]["end"], 6.5);
        assert_eq!(seg.as_array().unwrap().len(), 2);
    }
}
