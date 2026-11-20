//! Voice ideas: the same on-device listener as voice culling, but keeping
//! every word until you stop, so a spoken idea becomes an idea card. Nothing
//! is recorded; the words only go to the page.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
struct Heard {
    done: Vec<String>,
    now: String,
    problem: Option<String>,
}

impl Heard {
    fn text(&self) -> String {
        let mut all = self.done.clone();
        if !self.now.trim().is_empty() {
            all.push(self.now.trim().to_owned());
        }
        all.join(" ")
    }
}

struct Session {
    child: Child,
    stdin: ChildStdin,
    heard: Arc<Mutex<Heard>>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Live {
    text: String,
    listening: bool,
    problem: Option<String>,
}

fn helper(app: &AppHandle) -> PathBuf {
    app.path()
        .resolve("helpers/listen", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.is_file())
        .unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/helpers/listen").into())
}

/// Starts listening for a spoken idea; the words arrive as "dictation" events.
#[tauri::command]
pub async fn dictate_start(app: AppHandle) -> Result<(), String> {
    let mut slot = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_some() {
        return Ok(());
    }
    let mut child = Command::new(helper(&app))
        .arg("--dictate")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Listening couldn't start: {e}"))?;
    let stdout = child.stdout.take().ok_or("no output from the listener")?;
    let stdin = child.stdin.take().ok_or("no input to the listener")?;
    let heard = Arc::new(Mutex::new(Heard::default()));
    *slot = Some(Session { child, stdin, heard: heard.clone() });
    drop(slot);
    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let (kind, rest) = line.split_once(' ').unwrap_or((line.as_str(), ""));
            let mut h = heard.lock().unwrap_or_else(|e| e.into_inner());
            let mut listening = true;
            match kind {
                "partial" => h.now = rest.split_once(' ').map(|(_, t)| t).unwrap_or("").to_owned(),
                "final" => {
                    let t = rest.split_once(' ').map(|(_, t)| t).unwrap_or("").trim().to_owned();
                    if !t.is_empty() {
                        h.done.push(t);
                    }
                    h.now.clear();
                    // A pause ended the sentence: keep listening for the next one.
                    if let Some(s) = SESSION.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                        let _ = writeln!(s.stdin, "reset");
                    }
                }
                "denied" => {
                    h.problem = Some(format!(
                        "macOS didn't allow the {}. Allow Captured by Andy in System Settings › Privacy & Security.",
                        if rest.contains("mic") { "microphone" } else { "speech recognition" }
                    ));
                    listening = false;
                }
                "error" => {
                    h.problem = Some(rest.to_owned());
                    listening = false;
                }
                _ => {}
            }
            let live = Live { text: h.text(), listening, problem: h.problem.clone() };
            drop(h);
            let _ = handle.emit("dictation", live);
        }
    });
    Ok(())
}

/// Stops listening and returns everything heard.
#[tauri::command]
pub async fn dictate_stop() -> Result<String, String> {
    let taken = SESSION.lock().unwrap_or_else(|e| e.into_inner()).take();
    let Some(mut s) = taken else { return Ok(String::new()) };
    // Give the last words a moment to arrive as text.
    std::thread::sleep(std::time::Duration::from_millis(350));
    let text = s.heard.lock().unwrap_or_else(|e| e.into_inner()).text();
    let problem = s.heard.lock().unwrap_or_else(|e| e.into_inner()).problem.clone();
    drop(s.stdin);
    let _ = s.child.kill();
    let _ = s.child.wait();
    match problem {
        Some(p) if text.is_empty() => Err(p),
        _ => Ok(text),
    }
}
