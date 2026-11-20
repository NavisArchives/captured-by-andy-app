//! The floating assistant's one door to Claude (NIRMATA Amendment 8b, Andy 19 Nov:
//! « a floating assistant… pull me up all the pictures from Egypt that have been
//! approved »). Mac only.
//!
//! What this side guarantees, whatever the page sends:
//! - The key is read from `~/.config/captured-by-andy/anthropic-key` (placed by
//!   Andy, mode 600) and handed to curl on stdin, never on its command line,
//!   never logged, never returned to the page.
//! - The model, effort and output size are fixed here, not by the page.
//! - No image or document content leaves the Mac: such a block is refused.
//! - A daily cap (requests) is counted in the library's settings; the page
//!   shows the count and the day's spend.
//!
//! The tool loop itself runs in the page over the app's existing read-only
//! commands; every write (a post, an album, a project) is Andy's click.
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::app::AppState;
use crate::library::{db::Db, settings};

type Reply<T> = Result<T, String>;

pub const MODEL: &str = "claude-haiku-5-5";
/// Requests per day (each model turn counts as one).
pub const DAILY_CAP: i64 = 150;
/// Price per token (USD) for the model above: $0.10 in / $0.50 out per million
/// for prompts up to 100K tokens, $0.50 / $2.50 beyond (Anthropic pricing, 20 Nov 2026).
const IN_USD: f64 = 0.10 / 1_000_000.0;
const OUT_USD: f64 = 0.50 / 1_000_000.0;
const IN_USD_LONG: f64 = 0.50 / 1_000_000.0;
const OUT_USD_LONG: f64 = 2.50 / 1_000_000.0;
const LONG_PROMPT: i64 = 100_000;
/// Answer size, fixed here.
pub const MAX_TOKENS: i64 = 2048;
/// The app's hard monthly ceiling for this assistant (Andy, 20 Nov: the key must
/// never pass $100; three assistants at $20 each). Only changed here, in code:
/// neither the panel nor the assistant can raise it.
pub const MONTHLY_CEILING_USD: f64 = 20.0;
/// Largest request body sent. A token is at least one byte, so the body is at
/// most 90,000 tokens; the API adds its own tool-use system prompt on top, which
/// the 10,000-token margin below the 100K price step covers.
pub const MAX_BODY_BYTES: usize = 90_000;
/// Prompt size the worst call is priced at: the whole cheaper band.
pub const WORST_PROMPT_TOKENS: i64 = LONG_PROMPT;
/// The most one call can cost: a 100,000-token prompt written to the cache
/// (×1.25) plus a full answer. $0.0125 + $0.001024 = $0.013524.
pub const WORST_CALL_USD: f64 = WORST_PROMPT_TOKENS as f64 * IN_USD * 1.25 + MAX_TOKENS as f64 * OUT_USD;
const USAGE_KEY: &str = "assistant.usage";
const ENDPOINT: &str = "https://api.anthropic.com/v1/messages";

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

fn config_dir(home: &std::path::Path) -> PathBuf {
    home.join(".config/captured-by-andy")
}

fn read_key_in(home: &std::path::Path) -> Option<String> {
    let k = std::fs::read_to_string(config_dir(home).join("anthropic-key")).ok()?;
    let k = k.trim().to_owned();
    (!k.is_empty()).then_some(k)
}

fn read_key() -> Option<String> {
    read_key_in(&home())
}

// ---------------------------------------------------------------- the month's spend

/// What the key has cost this calendar month (UTC), across every library and
/// test run on this Mac: kept beside the key, not in a library.
#[derive(Clone, Debug, Default, Serialize, serde::Deserialize, PartialEq)]
pub struct Spend {
    pub month: String,
    pub usd: f64,
    pub calls: i64,
}

fn spend_path(home: &std::path::Path) -> PathBuf {
    config_dir(home).join("assistant-spend.json")
}

/// The second copy, outside the key's folder: deleting one file doesn't reopen the month.
fn spend_copy_path(home: &std::path::Path) -> PathBuf {
    home.join("Library/Application Support/captured-by-andy-spend/assistant-spend.json")
}

fn lock_path(home: &std::path::Path) -> PathBuf {
    config_dir(home).join("assistant-spend.lock")
}

pub fn this_month() -> String {
    today()[..7].to_owned()
}

const COUNTER_BROKEN: &str = "counter: The assistant's spend counter can't be read or saved, so it stays off to keep the monthly limit safe. Everything else works as before.";

/// One copy: absent is fine (None); present but unreadable or damaged refuses.
fn read_copy(p: &std::path::Path) -> Result<Option<Spend>, String> {
    match std::fs::read_to_string(p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(COUNTER_BROKEN.into()),
        Ok(t) => serde_json::from_str(&t).map(Some).map_err(|_| COUNTER_BROKEN.to_string()),
    }
}

/// This month's spend: the higher of the two copies. Fails closed.
pub fn read_spend(home: &std::path::Path) -> Result<Spend, String> {
    let month = this_month();
    let mut best = Spend { month: month.clone(), ..Spend::default() };
    for p in [spend_path(home), spend_copy_path(home)] {
        if let Some(s) = read_copy(&p)? {
            if s.month == month && s.usd > best.usd {
                best = s;
            }
        }
    }
    Ok(best)
}

/// For the panel's line only (never for a decision).
pub fn load_spend(home: &std::path::Path) -> Spend {
    read_spend(home).unwrap_or(Spend { month: this_month(), usd: MONTHLY_CEILING_USD, calls: 0 })
}

fn write_copy(p: &std::path::Path, s: &Spend) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let dir = p.parent().unwrap_or(std::path::Path::new("."));
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".assistant-spend-{}.tmp", crate::library::new_id()));
    let written = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp).and_then(|mut f| {
        f.write_all(serde_json::to_string(s).unwrap_or_default().as_bytes())?;
        f.sync_all()
    });
    match written.and_then(|_| std::fs::rename(&tmp, p)) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Both copies, or a refusal.
pub fn write_spend(home: &std::path::Path, s: &Spend) -> Result<(), String> {
    write_copy(&spend_path(home), s).map_err(|_| COUNTER_BROKEN.to_string())?;
    write_copy(&spend_copy_path(home), s).map_err(|_| COUNTER_BROKEN.to_string())
}

/// Runs `f` holding an exclusive lock on the counter (the app and an eval run
/// can't both read the same total and each write their own).
fn with_lock<T>(home: &std::path::Path, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::create_dir_all(config_dir(home)).map_err(|_| COUNTER_BROKEN.to_string())?;
    let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).mode(0o600).open(lock_path(home)).map_err(|_| COUNTER_BROKEN.to_string())?;
    lock.lock().map_err(|_| COUNTER_BROKEN.to_string())?;
    let out = f();
    let _ = lock.unlock();
    out
}

/// Before a request: the ceiling check, then the worst call reserved and saved.
pub fn reserve(home: &std::path::Path) -> Result<(), String> {
    with_lock(home, || {
        let mut s = read_spend(home)?;
        check_ceiling(&s)?;
        s.usd += WORST_CALL_USD;
        s.calls += 1;
        write_spend(home, &s)
    })
}

/// After it: the reservation replaced by what really happened.
pub fn settle(home: &std::path::Path, usd_delta: f64, calls_delta: i64) -> Result<(), String> {
    with_lock(home, || {
        let mut s = read_spend(home)?;
        s.usd = (s.usd + usd_delta).max(0.0);
        s.calls = (s.calls + calls_delta).max(0);
        write_spend(home, &s)
    })
}

/// The cost of one answered call from its `usage`, at the official price:
/// cache writes ×1.25, cache reads ×0.1, the higher band past 100K prompt tokens.
pub fn call_cost(usage: &Value) -> f64 {
    let n = |k: &str| usage[k].as_i64().unwrap_or(0);
    let (fresh, write, read, out) = (n("input_tokens"), n("cache_creation_input_tokens"), n("cache_read_input_tokens"), n("output_tokens"));
    let (inp, outp) = if fresh + write + read > LONG_PROMPT { (IN_USD_LONG, OUT_USD_LONG) } else { (IN_USD, OUT_USD) };
    (fresh as f64 + write as f64 * 1.25 + read as f64 * 0.1) * inp + out as f64 * outp
}

const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/// « November » and « 1 December » for a « YYYY-MM » month.
fn month_names(month: &str) -> (&'static str, &'static str) {
    let m: usize = month.get(5..7).and_then(|x| x.parse().ok()).unwrap_or(1);
    (MONTHS[(m + 11) % 12], MONTHS[m % 12])
}

/// Refuses before the model is called when one more call could pass the ceiling.
pub fn check_ceiling(spend: &Spend) -> Result<(), String> {
    if spend.usd + WORST_CALL_USD > MONTHLY_CEILING_USD {
        let (now, next) = month_names(&spend.month);
        return Err(format!(
            "ceiling: {now}'s assistant budget of ${MONTHLY_CEILING_USD:.0} is used (${:.2}). The assistant resumes on 1 {next}; everything else works as before.",
            spend.usd
        ));
    }
    Ok(())
}

/// What an HTTP answer means. The Console's spend limit (400 « You have reached
/// your specified API usage limits ») and the tier's (429
/// enforced_spend_limit_reached) end in one plain message, never a retry.
pub fn classify(code: u16, v: &Value) -> Result<(), String> {
    let msg = v["error"]["message"].as_str().unwrap_or("");
    match code {
        200 => Ok(()),
        400 if msg.starts_with("You have reached your specified API usage limits") => {
            Err("limit: The Anthropic account's spending limit is reached. The assistant stops until the limit resets; everything else works as before.".into())
        }
        429 if v["error"]["details"]["error_code"].as_str() == Some("enforced_spend_limit_reached") => {
            Err("limit: The Anthropic account's spending limit is reached. The assistant stops until the limit resets; everything else works as before.".into())
        }
        401 | 403 => Err("key: the key was refused".into()),
        429 => Err("busy: Claude is busy, try again in a minute".into()),
        0 => Err("offline: no answer".into()),
        _ => Err(format!("error: Claude said {code}: {}", msg.chars().take(200).collect::<String>())),
    }
}

fn today() -> String {
    chrono_like_day(std::time::SystemTime::now())
}

/// YYYY-MM-DD in UTC (enough for a daily counter; no extra crate).
fn chrono_like_day(t: std::time::SystemTime) -> String {
    let secs = t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let days = secs.div_euclid(86_400);
    // Civil from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}

#[derive(Clone, Debug, Default, Serialize, serde::Deserialize)]
struct Usage {
    day: String,
    count: i64,
    input: i64,
    output: i64,
}

fn usage(db: &Db) -> Usage {
    let u: Usage = settings::get(db, USAGE_KEY).ok().flatten().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    if u.day == today() { u } else { Usage { day: today(), ..Usage::default() } }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    key: bool,
    model: &'static str,
    today: i64,
    cap: i64,
    spent_usd: f64,
    month_usd: f64,
    ceiling_usd: f64,
}

fn status_of(db: &Db) -> Status {
    let u = usage(db);
    let m = load_spend(&home());
    Status {
        key: read_key().is_some(),
        model: MODEL,
        today: u.count,
        cap: DAILY_CAP,
        spent_usd: u.input as f64 * IN_USD + u.output as f64 * OUT_USD,
        month_usd: m.usd,
        ceiling_usd: MONTHLY_CEILING_USD,
    }
}

#[tauri::command]
pub async fn assistant_status(state: State<'_, AppState>) -> Reply<Status> {
    Ok(status_of(&state.db))
}

/// Refuses any block that would send pixels or files: only text, tool calls and tool results (text) go out.
pub fn check_text_only(messages: &Value) -> Result<(), String> {
    fn walk(v: &Value) -> Result<(), String> {
        match v {
            Value::Object(o) => {
                if let Some(t) = o.get("type").and_then(Value::as_str) {
                    if matches!(t, "image" | "document" | "file" | "container_upload") {
                        return Err("image: pictures never leave the Mac".into());
                    }
                }
                o.values().try_for_each(walk)
            }
            Value::Array(a) => a.iter().try_for_each(walk),
            _ => Ok(()),
        }
    }
    walk(messages)
}

/// The request as it goes out: model, effort and size fixed here; system and tools cached.
pub fn request_body(system: &str, tools: &Value, messages: &Value) -> Value {
    let mut tools = tools.clone();
    if let Some(last) = tools.as_array_mut().and_then(|a| a.last_mut()) {
        last["cache_control"] = json!({"type": "ephemeral"});
    }
    json!({
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "output_config": {"effort": "low"},
        "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        "tools": tools,
        "messages": messages,
    })
}

/// curl's arguments: the key is not among them (it goes in the config on stdin).
pub fn curl_args(body_file: &std::path::Path) -> Vec<String> {
    ["-sS", "--connect-timeout", "10", "--max-time", "60", "-K", "-", "-X", "POST", "-w", "\n%{http_code}", "--data-binary"]
        .iter()
        .map(|s| s.to_string())
        .chain([format!("@{}", body_file.display()), ENDPOINT.to_owned()])
        .collect()
}

pub fn curl_config(key: &str) -> String {
    format!("header = \"x-api-key: {key}\"\nheader = \"anthropic-version: 2023-06-01\"\nheader = \"content-type: application/json\"\nheader = \"User-Agent: capturedbyandy-app\"\n")
}

pub fn send(db: &Db, system: String, tools: Value, messages: Value) -> Result<Value, String> {
    send_in(&home(), db, system, tools, messages)
}

/// How a request goes out: curl in the app, a stand-in in tests.
pub type Transport<'a> = &'a dyn Fn(&std::path::Path, &str) -> std::io::Result<std::process::Output>;

fn curl_transport(file: &std::path::Path, key: &str) -> std::io::Result<std::process::Output> {
    let mut child = Command::new("/usr/bin/curl").args(curl_args(file)).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    child.stdin.take().expect("stdin").write_all(curl_config(key).as_bytes())?;
    child.wait_with_output()
}

pub fn send_in(home: &std::path::Path, db: &Db, system: String, tools: Value, messages: Value) -> Result<Value, String> {
    send_via(home, db, system, tools, messages, &curl_transport)
}

pub fn send_via(home: &std::path::Path, db: &Db, system: String, tools: Value, messages: Value, transport: Transport) -> Result<Value, String> {
    let Some(key) = read_key_in(home) else { return Err("key: no key file".into()) };
    let mut u = usage(db);
    if u.count >= DAILY_CAP {
        return Err(format!("cap: {DAILY_CAP} requests today"));
    }
    check_text_only(&messages)?;
    let body = request_body(&system, &tools, &messages);
    if serde_json::to_vec(&body).map_or(usize::MAX, |b| b.len()) > MAX_BODY_BYTES {
        return Err("long: This conversation is too long for one request. Press ↻ to start a new one.".into());
    }
    // The worst this call can cost is counted before it can be billed.
    reserve(home)?;
    let give_back = || {
        let _ = settle(home, -WORST_CALL_USD, -1);
    };
    // The body (his sentence and text facts) through a private file; the key through stdin.
    let file = std::env::temp_dir().join(format!("cba-assistant-{}.json", crate::library::new_id()));
    let written = (|| -> std::io::Result<()> {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&file)?;
        f.write_all(&serde_json::to_vec(&body).unwrap_or_default())
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&file);
        give_back();
        return Err(e.to_string());
    }
    let out = transport(&file, &key);
    let _ = std::fs::remove_file(&file);
    let out = match out {
        Ok(o) => o,
        Err(e) => {
            // curl never started: nothing was sent.
            give_back();
            return Err(format!("offline: {e}"));
        }
    };
    if !out.status.success() {
        if matches!(out.status.code(), Some(6) | Some(7)) {
            // Couldn't resolve or connect: nothing reached Anthropic.
            give_back();
            return Err("offline: no connection to Claude".into());
        }
        // Timed out or cut off after sending (28, 52, 56…): it may have been
        // billed, so the reservation stays and the request counts today.
        u.count += 1;
        let _ = settings::set(db, USAGE_KEY, &serde_json::to_string(&u).unwrap_or_default());
        return Err("offline: no complete answer from Claude".into());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let (reply, code) = text.rsplit_once('\n').unwrap_or(("", &text));
    let code: u16 = code.trim().parse().unwrap_or(0);
    // Every answered request counts, so the cap holds even when they fail.
    u.count += 1;
    let v: Value = serde_json::from_str(reply).unwrap_or(Value::Null);
    u.input += v["usage"]["input_tokens"].as_i64().unwrap_or(0) + v["usage"]["cache_creation_input_tokens"].as_i64().unwrap_or(0) + v["usage"]["cache_read_input_tokens"].as_i64().unwrap_or(0) / 10;
    u.output += v["usage"]["output_tokens"].as_i64().unwrap_or(0);
    let _ = settings::set(db, USAGE_KEY, &serde_json::to_string(&u).unwrap_or_default());
    // The reservation becomes the real price (an error answer is not billed).
    // If this save fails, the full reservation stays counted: safe side.
    // A 200 without a readable usage object keeps the whole reservation (never « free »).
    let readable = v["usage"]["input_tokens"].is_i64() && v["usage"]["output_tokens"].is_i64();
    let cost = if code != 200 { 0.0 } else if readable { call_cost(&v["usage"]) } else { WORST_CALL_USD };
    let _ = settle(home, cost - WORST_CALL_USD, 0);
    classify(code, &v).map(|_| v)
}

#[tauri::command]
pub async fn assistant_send(state: State<'_, AppState>, system: String, tools: Value, messages: Value) -> Reply<Value> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || send(&db, system, tools, messages)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> (tempfile::TempDir, Db) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("library.db")).unwrap();
        // A fake key: if a request were ever sent, Anthropic would refuse it (« key »).
        std::fs::create_dir_all(dir.path().join(".config/captured-by-andy")).unwrap();
        std::fs::write(dir.path().join(".config/captured-by-andy/anthropic-key"), "sk-ant-fake-for-tests").unwrap();
        (dir, db)
    }

    fn hi() -> Value {
        json!([{"role": "user", "content": [{"type": "text", "text": "hello"}]}])
    }

    #[test]
    fn a_call_costs_the_official_price() {
        let c = call_cost(&json!({"input_tokens": 1_000, "output_tokens": 100}));
        assert!((c - (1_000.0 * 0.10 + 100.0 * 0.50) / 1e6).abs() < 1e-12);
        // Cache write ×1.25, cache read ×0.1.
        let c = call_cost(&json!({"input_tokens": 0, "cache_creation_input_tokens": 1_000, "cache_read_input_tokens": 10_000, "output_tokens": 0}));
        assert!((c - (1_250.0 + 1_000.0) * 0.10 / 1e6).abs() < 1e-12);
        // Past 100K prompt tokens, the higher band for the whole call.
        let c = call_cost(&json!({"input_tokens": 120_000, "output_tokens": 1_000}));
        assert!((c - (120_000.0 * 0.50 + 1_000.0 * 2.50) / 1e6).abs() < 1e-12);
    }

    #[test]
    fn the_worst_call_is_known_and_stays_in_the_cheap_band() {
        assert!((WORST_CALL_USD - (100_000.0 * 0.10 * 1.25 + 2_048.0 * 0.50) / 1e6).abs() < 1e-12);
        assert!((MAX_BODY_BYTES as i64) < LONG_PROMPT, "a token is at least one byte: the prompt can't reach the 100K band");
        assert!((WORST_CALL_USD - 0.013524).abs() < 1e-9);
    }

    #[test]
    fn the_ceiling_refuses_before_the_model_is_called() {
        let (dir, db) = scratch();
        write_spend(dir.path(), &Spend { month: this_month(), usd: MONTHLY_CEILING_USD - 0.01, calls: 1_000 }).unwrap();
        let e = send_in(dir.path(), &db, "x".into(), json!([]), hi()).unwrap_err();
        assert!(e.starts_with("ceiling:"), "{e}");
        assert!(e.contains("resumes on 1 "), "{e}");
        // Nothing was sent: the call counter didn't move (a sent request would also have come back « key »).
        assert_eq!(read_spend(dir.path()).unwrap().calls, 1_000);
    }

    #[test]
    fn under_the_ceiling_one_more_call_is_allowed() {
        let s = Spend { month: this_month(), usd: MONTHLY_CEILING_USD - WORST_CALL_USD - 0.001, calls: 0 };
        assert!(check_ceiling(&s).is_ok());
        let s = Spend { usd: MONTHLY_CEILING_USD - WORST_CALL_USD + 0.000_001, ..s };
        assert!(check_ceiling(&s).is_err(), "a call that could pass $20 is refused");
    }

    #[test]
    fn the_message_names_the_month_and_the_first() {
        let e = check_ceiling(&Spend { month: "2026-11".into(), usd: 20.0, calls: 0 }).unwrap_err();
        assert!(e.contains("November's assistant budget of $20") && e.contains("1 December"), "{e}");
        let e = check_ceiling(&Spend { month: "2026-12".into(), usd: 20.0, calls: 0 }).unwrap_err();
        assert!(e.contains("December's") && e.contains("1 January"), "{e}");
    }

    #[test]
    fn a_new_month_starts_at_zero() {
        let (dir, _db) = scratch();
        write_spend(dir.path(), &Spend { month: "2026-10".into(), usd: 19.99, calls: 5 }).unwrap();
        assert_eq!(read_spend(dir.path()).unwrap(), Spend { month: this_month(), usd: 0.0, calls: 0 });
    }

    #[test]
    fn an_oversized_request_is_refused_before_sending() {
        let (dir, db) = scratch();
        let big = json!([{"role": "user", "content": [{"type": "text", "text": "a".repeat(MAX_BODY_BYTES)}]}]);
        let e = send_in(dir.path(), &db, "x".into(), json!([]), big).unwrap_err();
        assert!(e.starts_with("long:"), "{e}");
        assert_eq!(read_spend(dir.path()).unwrap().calls, 0);
    }

    #[test]
    fn the_consoles_spend_limits_end_in_one_plain_message() {
        let console = json!({"type": "error", "error": {"type": "invalid_request_error", "message": "You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC."}});
        assert!(classify(400, &console).unwrap_err().starts_with("limit:"));
        let tier = json!({"type": "error", "error": {"type": "rate_limit_error", "message": "spend limit", "details": {"error_code": "enforced_spend_limit_reached"}}});
        assert!(classify(429, &tier).unwrap_err().starts_with("limit:"));
        // Other answers keep their meaning.
        assert!(classify(429, &json!({"error": {"message": "slow down"}})).unwrap_err().starts_with("busy:"));
        assert!(classify(400, &json!({"error": {"message": "bad request"}})).unwrap_err().starts_with("error:"));
        assert!(classify(401, &json!({})).unwrap_err().starts_with("key:"));
        assert!(classify(200, &json!({})).is_ok());
    }

    #[test]
    fn the_key_never_goes_on_curls_command_line() {
        let key = "sk-ant-test-0000";
        let args = curl_args(std::path::Path::new("/tmp/x.json"));
        assert!(args.iter().all(|a| !a.contains(key) && !a.contains("x-api-key")), "args: {args:?}");
        assert!(args.windows(2).any(|w| w[0] == "-K" && w[1] == "-"), "config comes from stdin");
        assert!(curl_config(key).contains(key));
    }

    #[test]
    fn pictures_and_files_never_leave_the_mac() {
        let ok = json!([{"role": "user", "content": [{"type": "text", "text": "Egypt"}]}, {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "[{\"id\":\"p1\"}]"}]}]);
        assert!(check_text_only(&ok).is_ok());
        for t in ["image", "document", "file"] {
            let bad = json!([{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": [{"type": t, "source": {}}]}]}]);
            assert!(check_text_only(&bad).is_err(), "{t} must be refused");
        }
    }

    #[test]
    fn the_model_and_size_are_fixed_here() {
        let b = request_body("sys", &json!([{"name": "a"}, {"name": "b"}]), &json!([]));
        assert_eq!(b["model"], MODEL);
        assert_eq!(b["max_tokens"], 2048);
        assert_eq!(b["tools"][1]["cache_control"]["type"], "ephemeral");
        assert!(b.get("thinking").is_none());
    }

    #[test]
    fn days_are_counted_in_utc() {
        assert_eq!(chrono_like_day(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_795_000_000)), "2026-11-18");
        assert_eq!(chrono_like_day(std::time::UNIX_EPOCH), "1970-01-01");
    }

    // ---------------------------------------------------------------- Revision 1: reserve, settle, fail closed, lock

    fn exit(code: i32, stdout: &str) -> std::io::Result<std::process::Output> {
        use std::os::unix::process::ExitStatusExt;
        Ok(std::process::Output { status: std::process::ExitStatus::from_raw(code << 8), stdout: stdout.as_bytes().to_vec(), stderr: vec![] })
    }

    fn day_count(db: &Db) -> i64 {
        usage(db).count
    }

    #[test]
    fn a_call_cut_off_after_sending_keeps_its_reservation_and_counts_today() {
        for code in [28, 52, 56] {
            let (dir, db) = scratch();
            write_spend(dir.path(), &Spend { month: this_month(), usd: 1.0, calls: 10 }).unwrap();
            let e = send_via(dir.path(), &db, "x".into(), json!([]), hi(), &|_, _| exit(code, "")).unwrap_err();
            assert!(e.starts_with("offline:"), "{code}: {e}");
            let s = read_spend(dir.path()).unwrap();
            assert!((s.usd - (1.0 + WORST_CALL_USD)).abs() < 1e-12, "{code}: reservation kept");
            assert_eq!(s.calls, 11, "{code}");
            assert_eq!(day_count(&db), 1, "{code}: counts against the 150 a day");
        }
    }

    #[test]
    fn a_call_that_never_left_gives_its_reservation_back() {
        for code in [6, 7] {
            let (dir, db) = scratch();
            write_spend(dir.path(), &Spend { month: this_month(), usd: 1.0, calls: 10 }).unwrap();
            let e = send_via(dir.path(), &db, "x".into(), json!([]), hi(), &|_, _| exit(code, "")).unwrap_err();
            assert!(e.starts_with("offline:"), "{code}: {e}");
            let s = read_spend(dir.path()).unwrap();
            assert!((s.usd - 1.0).abs() < 1e-12, "{code}: given back");
            assert_eq!(s.calls, 10, "{code}");
            assert_eq!(day_count(&db), 0, "{code}");
        }
    }

    #[test]
    fn an_answer_settles_to_its_real_price_and_an_error_answer_to_zero() {
        let (dir, db) = scratch();
        write_spend(dir.path(), &Spend { month: this_month(), usd: 1.0, calls: 0 }).unwrap();
        let ok = r#"{"content":[],"stop_reason":"end_turn","usage":{"input_tokens":1000,"output_tokens":100}}"#.to_string() + "\n200";
        send_via(dir.path(), &db, "x".into(), json!([]), hi(), &|_, _| exit(0, &ok)).unwrap();
        let s = read_spend(dir.path()).unwrap();
        assert!((s.usd - (1.0 + call_cost(&json!({"input_tokens": 1000, "output_tokens": 100})))).abs() < 1e-12);
        let busy = r#"{"type":"error","error":{"type":"overloaded_error","message":"busy"}}"#.to_string() + "\n529";
        assert!(send_via(dir.path(), &db, "x".into(), json!([]), hi(), &|_, _| exit(0, &busy)).is_err());
        assert!((read_spend(dir.path()).unwrap().usd - s.usd).abs() < 1e-12, "an error answer costs nothing");
    }

    #[test]
    fn a_damaged_counter_refuses_and_nothing_is_sent() {
        let (dir, db) = scratch();
        std::fs::write(spend_path(dir.path()), "{ not json").unwrap();
        let sent = std::cell::Cell::new(false);
        let e = send_via(dir.path(), &db, "x".into(), json!([]), hi(), &|_, _| {
            sent.set(true);
            exit(0, "")
        })
        .unwrap_err();
        assert!(e.starts_with("counter:"), "{e}");
        assert!(!sent.get());
    }

    #[test]
    fn a_counter_that_cannot_be_saved_refuses_and_nothing_is_sent() {
        let (dir, db) = scratch();
        // The second copy's folder is a file: the save fails.
        let copy_dir = spend_copy_path(dir.path()).parent().unwrap().to_path_buf();
        std::fs::create_dir_all(copy_dir.parent().unwrap()).unwrap();
        std::fs::write(&copy_dir, "in the way").unwrap();
        let sent = std::cell::Cell::new(false);
        let e = send_via(dir.path(), &db, "x".into(), json!([]), hi(), &|_, _| {
            sent.set(true);
            exit(0, "")
        })
        .unwrap_err();
        assert!(e.starts_with("counter:"), "{e}");
        assert!(!sent.get());
    }

    #[test]
    fn two_reservations_at_the_same_moment_both_land() {
        let (dir, db) = scratch();
        write_spend(dir.path(), &Spend { month: this_month(), usd: 0.0, calls: 0 }).unwrap();
        let home = dir.path();
        // Both calls are cut off after sending, so both reservations stay.
        std::thread::scope(|s| {
            for _ in 0..2 {
                s.spawn(|| {
                    let _ = send_via(home, &db, "x".into(), json!([]), hi(), &|_, _| {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                        exit(28, "")
                    });
                });
            }
        });
        let s = read_spend(home).unwrap();
        assert!((s.usd - 2.0 * WORST_CALL_USD).abs() < 1e-12, "{}", s.usd);
        assert_eq!(s.calls, 2);
    }

    #[test]
    fn deleting_one_copy_does_not_reopen_the_month() {
        let (dir, db) = scratch();
        write_spend(dir.path(), &Spend { month: this_month(), usd: MONTHLY_CEILING_USD - 0.01, calls: 0 }).unwrap();
        std::fs::remove_file(spend_path(dir.path())).unwrap();
        let e = send_via(dir.path(), &db, "x".into(), json!([]), hi(), &|_, _| exit(0, "")).unwrap_err();
        assert!(e.starts_with("ceiling:"), "{e}");
    }

    #[test]
    fn a_200_without_readable_usage_keeps_the_whole_reservation() {
        for body in ["not json at all\n200", "{\"content\":[]}\n200", "{\"usage\":{\"input_tokens\":\"x\"}}\n200"] {
            let (dir, db) = scratch();
            write_spend(dir.path(), &Spend { month: this_month(), usd: 1.0, calls: 0 }).unwrap();
            let _ = send_via(dir.path(), &db, "x".into(), json!([]), hi(), &|_, _| exit(0, body));
            let s = read_spend(dir.path()).unwrap();
            assert!((s.usd - (1.0 + WORST_CALL_USD)).abs() < 1e-12, "{body}: {}", s.usd);
        }
    }

    #[test]
    fn the_request_asks_for_max_tokens_from_the_constant() {
        assert_eq!(request_body("s", &json!([]), &hi())["max_tokens"], MAX_TOKENS);
    }
}
