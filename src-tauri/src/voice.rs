//! Voice culling: "yes", "no", "maybe"… said out loud mark the photo in Cull.
//!
//! The `listen` helper (on-device speech recognition, nothing recorded or sent)
//! reports what it hears; this decides when a word counts. Only a command said
//! on its own does: a word that turns out to start a sentence ("no, wait…")
//! is dropped, so talking in the room never marks photos.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command as Process, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// How long a lone command word must stay alone before it counts.
const CONFIRM: Duration = Duration::from_millis(300);
/// Talk that isn't a command is cleared after this much quiet.
const QUIET: Duration = Duration::from_millis(1200);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Command {
    Select,
    Reject,
    Maybe,
    Undo,
    Skip,
    Zoom,
}

/// The command a single spoken word stands for.
pub fn command(word: &str) -> Option<Command> {
    let w: String = word.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
    Some(match w.as_str() {
        "yes" | "yeah" | "yep" | "keep" => Command::Select,
        "no" | "nope" => Command::Reject,
        "maybe" => Command::Maybe,
        "back" | "undo" => Command::Undo,
        "skip" | "next" => Command::Skip,
        "zoom" | "play" => Command::Zoom,
        _ => return None,
    })
}

/// What the page is told.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Event {
    Listening,
    Paused,
    Stopped,
    Command { command: Command, word: String },
    Denied { what: String },
    Error { message: String },
}

/// What the decider wants done after a line or a tick.
#[derive(Debug, PartialEq)]
pub enum Step {
    Nothing,
    /// Act on a command, then start a fresh utterance.
    Fire(Command, String),
    /// Clear talk that wasn't a command.
    Reset,
}

/// Turns the helper's running transcript into commands.
#[derive(Default)]
pub struct Decider {
    task: Option<u64>,
    /// Waiting for the helper to start a fresh utterance after a reset.
    waiting: bool,
    text: String,
    changed: Option<Instant>,
    pending: Option<(Command, String, Instant)>,
}

impl Decider {
    fn reset(&mut self) {
        self.waiting = true;
        self.text.clear();
        self.changed = None;
        self.pending = None;
    }

    /// One line from the helper.
    pub fn line(&mut self, line: &str, now: Instant) -> Step {
        let mut parts = line.splitn(3, ' ');
        let (kind, n, text) = (parts.next().unwrap_or(""), parts.next(), parts.next().unwrap_or("").trim());
        let n = n.and_then(|n| n.parse::<u64>().ok());
        match kind {
            "task" => {
                self.task = n;
                self.waiting = false;
                self.text.clear();
                self.changed = None;
                self.pending = None;
                Step::Nothing
            }
            "partial" | "final" if !self.waiting && n.is_some() && n == self.task => {
                if text != self.text {
                    self.text = text.to_owned();
                    self.changed = Some(now);
                }
                let words: Vec<&str> = text.split_whitespace().collect();
                let lone = match words.as_slice() {
                    [word] => command(word).map(|c| (c, word.to_string())),
                    _ => None,
                };
                match (lone, kind) {
                    // The utterance ended on a lone command: act now.
                    (Some((c, word)), "final") => {
                        self.reset();
                        Step::Fire(c, word)
                    }
                    (Some((c, word)), _) => {
                        if self.pending.as_ref().map(|p| p.0) != Some(c) {
                            self.pending = Some((c, word, now + CONFIRM));
                        }
                        Step::Nothing
                    }
                    // More than one word (or not a command): never act on it.
                    (None, _) => {
                        self.pending = None;
                        Step::Nothing
                    }
                }
            }
            _ => Step::Nothing,
        }
    }

    /// Time passing: a lone word that stayed alone counts; old talk is cleared.
    pub fn tick(&mut self, now: Instant) -> Step {
        if self.waiting {
            return Step::Nothing;
        }
        if let Some((c, word, at)) = self.pending.clone() {
            if now >= at {
                self.reset();
                return Step::Fire(c, word);
            }
            return Step::Nothing;
        }
        if !self.text.is_empty() && self.changed.is_some_and(|t| now.duration_since(t) >= QUIET) {
            self.reset();
            return Step::Reset;
        }
        Step::Nothing
    }
}

struct Session {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct VoiceState(Mutex<Option<Session>>);

fn send(state: &VoiceState, line: &str) {
    if let Some(s) = state.0.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        let _ = writeln!(s.stdin, "{line}");
    }
}

/// Every step of voice mode goes to ~/Library/Logs/com.capturedbyandy.library/voice.log,
/// so a problem can be found without seeing the screen.
pub fn vlog(app: &AppHandle, msg: &str) {
    let Ok(dir) = app.path().app_log_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("voice.log")) {
        let _ = writeln!(f, "{} {msg}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"));
    }
}

/// What macOS allows and offers, asked without any prompt.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub speech: String,
    pub mic: String,
    pub ondevice: bool,
    pub available: bool,
    pub microphones: u32,
}

fn parse_status(line: &str) -> Option<VoiceStatus> {
    let rest = line.strip_prefix("status ")?;
    let mut st = VoiceStatus::default();
    for pair in rest.split_whitespace() {
        let (k, v) = pair.split_once('=')?;
        match k {
            "speech" => st.speech = v.to_owned(),
            "mic" => st.mic = v.to_owned(),
            "ondevice" => st.ondevice = v == "yes",
            "available" => st.available = v == "yes",
            "microphones" => st.microphones = v.parse().unwrap_or(0),
            _ => {}
        }
    }
    Some(st)
}

fn status_now(app: &AppHandle) -> Result<VoiceStatus, String> {
    let helper = helper_path(app);
    let out = Process::new(&helper).arg("--status").stdin(Stdio::null()).output().map_err(|e| {
        let msg = format!("voice helper can't start ({}): {e}", helper.display());
        vlog(app, &msg);
        msg
    })?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    vlog(app, &format!("status: {text} (exit {:?})", out.status.code()));
    parse_status(&text).ok_or_else(|| format!("voice helper said: {text}"))
}

/// At launch: note what voice mode would find (no prompts), and keep the log small.
pub fn startup(app: &AppHandle) {
    let app = app.clone();
    let _ = std::thread::Builder::new().name("voice-status".into()).spawn(move || {
        if let Ok(dir) = app.path().app_log_dir() {
            let log = dir.join("voice.log");
            if log.metadata().is_ok_and(|m| m.len() > 1 << 20) {
                let _ = std::fs::remove_file(&log); // only our own log file
            }
        }
        let helper = helper_path(&app);
        vlog(&app, &format!("app started · helper {} ({})", helper.display(), if helper.is_file() { "found" } else { "MISSING" }));
        let _ = status_now(&app);
    });
}

fn helper_path(app: &AppHandle) -> PathBuf {
    app.path()
        .resolve("helpers/listen", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.is_file())
        .unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/helpers/listen").into())
}

/// Starts listening (once; a second call does nothing).
#[tauri::command]
pub async fn voice_start(app: AppHandle, state: State<'_, VoiceState>) -> Result<(), String> {
    let mut slot = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = slot.as_mut() {
        if s.child.try_wait().ok().flatten().is_none() {
            return Ok(());
        }
    }
    vlog(&app, "start requested");
    let helper = helper_path(&app);
    let mut child = match Process::new(&helper).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(child) => child,
        Err(e) => {
            vlog(&app, &format!("helper failed to start ({}): {e}", helper.display()));
            return Err(format!("Voice couldn't start: {e}"));
        }
    };
    vlog(&app, &format!("helper started, pid {}", child.id()));
    let stdout = child.stdout.take().ok_or("voice helper: no output")?;
    let stdin = child.stdin.take().ok_or("voice helper: no input")?;
    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        let _ = std::thread::Builder::new().name("voice-err".into()).spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                vlog(&app, &format!("helper stderr: {line}"));
            }
        });
    }
    *slot = Some(Session { child, stdin });
    drop(slot);

    let (tx, rx) = mpsc::channel::<String>();
    std::thread::Builder::new()
        .name("voice-read".into())
        .spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        })
        .map_err(|e| e.to_string())?;

    let handle = app.clone();
    std::thread::Builder::new()
        .name("voice".into())
        .spawn(move || {
            let emit = |e: Event| {
                let _ = handle.emit("voice", e);
            };
            let mut decider = Decider::default();
            loop {
                let now = Instant::now();
                let step = match rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(line) => {
                        // What the room says is never written down: only commands
                        // (logged below), status and errors.
                        if !(line.starts_with("partial ") || line.starts_with("final ")) {
                            vlog(&handle, &format!("helper: {line}"));
                        }
                        match line.split_once(' ').map_or(line.as_str(), |(k, _)| k) {
                            "ready" => emit(Event::Listening),
                            "denied" => emit(Event::Denied { what: line[6..].trim().to_owned() }),
                            "error" => emit(Event::Error { message: line[5..].trim().to_owned() }),
                            _ => {}
                        }
                        decider.line(&line, now)
                    }
                    Err(RecvTimeoutError::Timeout) => decider.tick(now),
                    Err(RecvTimeoutError::Disconnected) => break,
                };
                let state = handle.state::<VoiceState>();
                match step {
                    Step::Fire(command, word) => {
                        vlog(&handle, &format!("command {command:?} from \"{word}\""));
                        emit(Event::Command { command, word });
                        send(&state, "reset");
                    }
                    Step::Reset => send(&state, "reset"),
                    Step::Nothing => {}
                }
            }
            // The helper ended (stopped, refused, or failed).
            let state = handle.state::<VoiceState>();
            let taken = state.0.lock().unwrap_or_else(|e| e.into_inner()).take();
            if let Some(mut s) = taken {
                let status = s.child.wait();
                vlog(&handle, &format!("helper ended: {status:?}"));
            } else {
                vlog(&handle, "helper stopped");
            }
            emit(Event::Stopped);
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Stops listening; the microphone is released.
#[tauri::command]
pub async fn voice_stop(app: AppHandle, state: State<'_, VoiceState>) -> Result<(), String> {
    let taken = state.0.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(mut s) = taken {
        vlog(&app, "stop requested");
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
    Ok(())
}

/// Permissions and availability, asked without prompting.
#[tauri::command]
pub async fn voice_status(app: AppHandle) -> Result<VoiceStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status_now(&app)).await.map_err(|e| e.to_string())?
}

/// A step from the page (e.g. "V pressed"), for the voice log.
#[tauri::command]
pub async fn voice_trace(app: AppHandle, message: String) -> Result<(), String> {
    vlog(&app, &format!("page: {}", message.chars().take(200).collect::<String>()));
    Ok(())
}

/// Opens the Privacy pane where the microphone or speech recognition is allowed.
#[tauri::command]
pub async fn voice_open_settings(what: String) -> Result<(), String> {
    let pane = if what == "speech" { "Privacy_SpeechRecognition" } else { "Privacy_Microphone" };
    Process::new("/usr/bin/open")
        .arg(format!("x-apple.systempreferences:com.apple.preference.security?{pane}"))
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Pauses listening (e.g. while a video plays) without releasing the helper.
#[tauri::command]
pub async fn voice_pause(app: AppHandle, state: State<'_, VoiceState>, paused: bool) -> Result<(), String> {
    if state.0.lock().unwrap_or_else(|e| e.into_inner()).is_none() {
        return Ok(());
    }
    send(&state, if paused { "pause" } else { "resume" });
    let _ = app.emit("voice", if paused { Event::Paused } else { Event::Listening });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(ms: u64, start: Instant) -> Instant {
        start + Duration::from_millis(ms)
    }

    #[test]
    fn status_line() {
        let st = parse_status("status speech=authorized mic=undecided recognizer=yes available=yes ondevice=yes microphones=2").unwrap();
        assert_eq!((st.speech.as_str(), st.mic.as_str(), st.ondevice, st.available, st.microphones), ("authorized", "undecided", true, true, 2));
        assert!(parse_status("error nope").is_none());
    }

    #[test]
    fn words() {
        assert_eq!(command("Yes"), Some(Command::Select));
        assert_eq!(command("no."), Some(Command::Reject));
        assert_eq!(command("Maybe?"), Some(Command::Maybe));
        assert_eq!(command("hello"), None);
    }

    #[test]
    fn a_lone_word_counts_after_a_moment() {
        let t = Instant::now();
        let mut d = Decider::default();
        d.line("task 1", t);
        assert_eq!(d.line("partial 1 Yes", at(100, t)), Step::Nothing);
        assert_eq!(d.tick(at(200, t)), Step::Nothing);
        assert_eq!(d.tick(at(450, t)), Step::Fire(Command::Select, "Yes".into()));
        // Nothing more until the fresh utterance starts.
        assert_eq!(d.line("partial 1 Yes", at(500, t)), Step::Nothing);
        assert_eq!(d.tick(at(2000, t)), Step::Nothing);
    }

    #[test]
    fn a_sentence_never_counts() {
        let t = Instant::now();
        let mut d = Decider::default();
        d.line("task 1", t);
        d.line("partial 1 No", at(100, t));
        d.line("partial 1 No wait", at(250, t));
        assert_eq!(d.tick(at(500, t)), Step::Nothing);
        d.line("partial 1 No wait I think", at(600, t));
        assert_eq!(d.tick(at(1000, t)), Step::Nothing);
        // Quiet afterwards: the talk is cleared, no mark.
        assert_eq!(d.tick(at(1900, t)), Step::Reset);
    }

    #[test]
    fn a_final_lone_word_counts_at_once() {
        let t = Instant::now();
        let mut d = Decider::default();
        d.line("task 3", t);
        assert_eq!(d.line("final 3 maybe", at(50, t)), Step::Fire(Command::Maybe, "maybe".into()));
    }

    #[test]
    fn old_utterances_are_ignored() {
        let t = Instant::now();
        let mut d = Decider::default();
        d.line("task 2", t);
        assert_eq!(d.line("final 1 yes", at(10, t)), Step::Nothing);
        assert_eq!(d.tick(at(1000, t)), Step::Nothing);
    }
}
