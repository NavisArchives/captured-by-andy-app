//! Google Drive, directly: downloads go straight to Google in parallel pieces
//! instead of through the Google Drive app, which hands over about 10 MB/s per
//! file (measured 2026-10-05 on a 255 Mbit/s line). Uses Andy's own OAuth
//! client (a Google Cloud project) with read-only access; the login (client
//! id, secret, refresh token) lives in the macOS Keychain. Web calls go through
//! /usr/bin/curl like the rest of the app; the access token is handed to curl
//! on stdin, never on its command line.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::Digest;

use super::{Error, Result};

const SERVICE: &str = "Captured by Andy · Google Drive";
const ACCOUNT: &str = "drive";
const SCOPE: &str = "https://www.googleapis.com/auth/drive.readonly";
const ID_XATTR: &str = "com.google.drivefs.item-id#S";
const PIECE: u64 = 16 << 20;
/// Downloads in flight per file.
pub const LANES: u64 = 6;

#[derive(Clone, Serialize, Deserialize)]
struct Login {
    client_id: String,
    client_secret: String,
    refresh_token: String,
}

static LOGIN: Mutex<Option<Option<Login>>> = Mutex::new(None);
/// When reading the login last failed: tried again after a while, not never.
static LOGIN_FAILED: Mutex<Option<Instant>> = Mutex::new(None);
static TOKEN: Mutex<Option<(String, Instant)>> = Mutex::new(None);

fn login() -> Option<Login> {
    let mut g = LOGIN.lock().unwrap_or_else(|e| e.into_inner());
    // A failed read (Keychain busy or locked at launch) is tried again a
    // minute later instead of leaving the app "not connected" until restart.
    let retry = matches!(*g, Some(None)) && LOGIN_FAILED.lock().unwrap_or_else(|e| e.into_inner()).is_some_and(|t| t.elapsed() > Duration::from_secs(60));
    if g.is_none() || retry {
        let out = Command::new("/usr/bin/security").args(["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]).output();
        let found = match &out {
            Ok(o) if o.status.success() => {
                let parsed = serde_json::from_slice::<Login>(String::from_utf8_lossy(&o.stdout).trim().as_bytes()).ok();
                if parsed.is_none() {
                    crate::applog::line("drive login: the Keychain entry isn't a readable login");
                }
                parsed
            }
            // Never the secret: only the exit code and the error text.
            Ok(o) => {
                crate::applog::line(&format!("drive login: Keychain read failed ({}): {}", o.status, String::from_utf8_lossy(&o.stderr).trim()));
                None
            }
            Err(e) => {
                crate::applog::line(&format!("drive login: couldn't run security: {e}"));
                None
            }
        };
        *LOGIN_FAILED.lock().unwrap_or_else(|e| e.into_inner()) = if found.is_none() { Some(Instant::now()) } else { None };
        *g = Some(found);
    }
    g.clone().flatten()
}

/// Whether the app has a Google Drive login. `CBA_DRIVE_API=off` makes the
/// app go through the Google Drive app only (test runs).
pub fn connected() -> bool {
    std::env::var("CBA_DRIVE_API").map_or(true, |v| v != "off") && login().is_some()
}

/// Whether Google still accepts the login (a sign-in left in Google's
/// "Testing" mode lapses after 7 days). Err holds Google's words.
pub fn check() -> Result<()> {
    *TOKEN.lock().unwrap_or_else(|e| e.into_inner()) = None;
    access_token().map(|_| ())
}

/// Signs in again with the stored client (after the sign-in lapsed), so the
/// client file needn't be fetched from Google Cloud again.
pub fn reconnect(open: impl Fn(&str)) -> Result<()> {
    let l = login().ok_or_else(|| Error::Invalid("Google Drive isn't connected yet".into()))?;
    connect(&l.client_id, &l.client_secret, open)
}

/// Forgets the login (Keychain entry and cached token).
pub fn disconnect() -> Result<()> {
    let _ = Command::new("/usr/bin/security").args(["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]).output();
    *LOGIN.lock().unwrap_or_else(|e| e.into_inner()) = Some(None);
    *TOKEN.lock().unwrap_or_else(|e| e.into_inner()) = None;
    Ok(())
}

/// The Drive id of a file in the Google Drive folder, as the Drive app records it.
pub fn file_id(path: &Path) -> Option<String> {
    let raw = xattr::get(path, ID_XATTR).ok().flatten()?;
    let id = String::from_utf8(raw).ok()?.trim_matches(char::from(0)).trim().to_owned();
    (!id.is_empty()).then_some(id)
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn dec(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap_or(b'?'));
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn random(bytes: usize) -> Result<String> {
    let mut buf = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut buf)?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf))
}

/// POSTs a form to Google's token endpoint; the fields go to curl on stdin.
fn token_call(fields: &[(&str, &str)]) -> Result<serde_json::Value> {
    let body = fields.iter().map(|(k, v)| format!("{k}={}", enc(v))).collect::<Vec<_>>().join("&");
    let mut child = Command::new("/usr/bin/curl")
        .args(["-sS", "--max-time", "30", "-X", "POST", "-H", "Content-Type: application/x-www-form-urlencoded", "--data-binary", "@-", "https://oauth2.googleapis.com/token"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child.stdin.take().expect("stdin").write_all(body.as_bytes())?;
    let out = child.wait_with_output()?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|_| Error::Invalid(format!("Google didn't answer ({}).", String::from_utf8_lossy(&out.stderr).trim())))?;
    if let Some(e) = v.get("error") {
        let what = v.get("error_description").and_then(|d| d.as_str()).unwrap_or_else(|| e.as_str().unwrap_or("error"));
        return Err(Error::Invalid(format!("Google said: {what}")));
    }
    Ok(v)
}

fn access_token() -> Result<String> {
    if let Some((t, until)) = TOKEN.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        if until > Instant::now() + Duration::from_secs(120) {
            return Ok(t);
        }
    }
    let l = login().ok_or_else(|| Error::Invalid("Google Drive isn't connected".into()))?;
    let v = token_call(&[("client_id", &l.client_id), ("client_secret", &l.client_secret), ("refresh_token", &l.refresh_token), ("grant_type", "refresh_token")])?;
    let token = v["access_token"].as_str().ok_or_else(|| Error::Invalid("Google sent no access token".into()))?.to_owned();
    let secs = v["expires_in"].as_u64().unwrap_or(3000);
    *TOKEN.lock().unwrap_or_else(|e| e.into_inner()) = Some((token.clone(), Instant::now() + Duration::from_secs(secs)));
    Ok(token)
}

/// Signs in: opens Google's consent page with `open`, waits (up to 5 min) for
/// the browser to come back to a one-off local address, and keeps the login in
/// the Keychain. PKCE (S256) protects the exchange.
pub fn connect(client_id: &str, client_secret: &str, open: impl Fn(&str)) -> Result<()> {
    let (client_id, client_secret) = (client_id.trim(), client_secret.trim());
    if client_id.is_empty() || client_secret.is_empty() {
        return Err(Error::Invalid("Paste both the client ID and the client secret".into()));
    }
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let redirect = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
    let verifier = random(48)?;
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier.as_bytes()));
    let state = random(12)?;
    open(&format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={challenge}&code_challenge_method=S256&access_type=offline&prompt=consent&state={state}",
        enc(client_id),
        enc(&redirect),
        enc(SCOPE)
    ));

    listener.set_nonblocking(true)?;
    let deadline = Instant::now() + Duration::from_secs(300);
    let (mut stream, _) = loop {
        match listener.accept() {
            Ok(s) => break s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    return Err(Error::Invalid("No answer from the browser within 5 minutes".into()));
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(e.into()),
        }
    };
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf)?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let target = request.split_whitespace().nth(1).unwrap_or("");
    let query: Vec<(String, String)> = target
        .split_once('?')
        .map(|(_, q)| q.split('&').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.to_owned(), dec(v))).collect())
        .unwrap_or_default();
    let get = |k: &str| query.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
    let ok = get("state").as_deref() == Some(state.as_str()) && get("code").is_some();
    let page = if ok { "Captured by Andy is connected to Google Drive. You can close this tab." } else { "Captured by Andy couldn't connect. Go back to the app and try again." };
    let html = format!("<!doctype html><meta charset=utf-8><title>Captured by Andy</title><body style=\"font:16px -apple-system,sans-serif;padding:40px\">{page}</body>");
    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}", html.len());
    if !ok {
        return Err(Error::Invalid(get("error").map(|e| format!("Google said: {e}")).unwrap_or_else(|| "The sign-in didn't complete".into())));
    }
    let code = get("code").unwrap_or_default();
    let v = token_call(&[
        ("code", &code),
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("redirect_uri", &redirect),
        ("grant_type", "authorization_code"),
        ("code_verifier", &verifier),
    ])?;
    let refresh = v["refresh_token"].as_str().ok_or_else(|| Error::Invalid("Google sent no lasting login; try again".into()))?;
    let l = Login { client_id: client_id.into(), client_secret: client_secret.into(), refresh_token: refresh.into() };
    let json = serde_json::to_string(&l).map_err(|e| Error::Invalid(e.to_string()))?;
    let st = Command::new("/usr/bin/security").args(["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", &json]).output()?;
    if !st.status.success() {
        return Err(Error::Invalid("Couldn't save the login in the Keychain".into()));
    }
    *LOGIN.lock().unwrap_or_else(|e| e.into_inner()) = Some(Some(l));
    if let (Some(t), Some(s)) = (v["access_token"].as_str(), v["expires_in"].as_u64()) {
        *TOKEN.lock().unwrap_or_else(|e| e.into_inner()) = Some((t.to_owned(), Instant::now() + Duration::from_secs(s)));
    }
    Ok(())
}

/// One byte range of the file, written at its place in `f`.
fn piece(id: &str, start: u64, end: u64, f: &std::fs::File) -> Result<()> {
    let token = access_token()?;
    let url = format!("https://www.googleapis.com/drive/v3/files/{id}?alt=media&supportsAllDrives=true");
    let mut child = Command::new("/usr/bin/curl")
        .args(["-sS", "--fail", "-L", "--max-time", "600", "-K", "-", "-r", &format!("{start}-{end}"), &url])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child.stdin.take().expect("stdin").write_all(format!("header = \"Authorization: Bearer {token}\"\n").as_bytes())?;
    let mut out = child.stdout.take().expect("stdout");
    let mut buf = vec![0u8; 1 << 20];
    let mut at = start;
    loop {
        let n = out.read(&mut buf)?;
        if n == 0 {
            break;
        }
        f.write_all_at(&buf[..n], at)?;
        at += n as u64;
    }
    let status = child.wait()?;
    if !status.success() || at != end + 1 {
        return Err(Error::Invalid(format!("Google Drive refused the download: {}", explain(id).unwrap_or_else(|| "no reason given".into()))));
    }
    Ok(())
}

/// Google's own words for why a file can't be downloaded (its error message).
fn explain(id: &str) -> Option<String> {
    let token = access_token().ok()?;
    let url = format!("https://www.googleapis.com/drive/v3/files/{id}?alt=media&supportsAllDrives=true");
    let mut child = Command::new("/usr/bin/curl")
        .args(["-sS", "-L", "--max-time", "30", "-K", "-", "-r", "0-0", &url])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    child.stdin.take()?.write_all(format!("header = \"Authorization: Bearer {token}\"\n").as_bytes()).ok()?;
    let out = child.wait_with_output().ok()?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let e = &v["error"];
    let reason = e["errors"][0]["reason"].as_str().unwrap_or("");
    Some(format!("{} ({reason})", e["message"].as_str()?))
}

/// Downloads a whole Drive file into `dest`, `LANES` pieces at a time, each
/// retried up to three times.
pub fn download(id: &str, size: u64, dest: &Path, cancel: &AtomicBool) -> Result<()> {
    let f = std::fs::File::create(dest)?;
    f.set_len(size)?;
    let next = AtomicU64::new(0);
    let failed: Mutex<Option<String>> = Mutex::new(None);
    std::thread::scope(|s| {
        for _ in 0..LANES {
            s.spawn(|| loop {
                if cancel.load(Ordering::Relaxed) || failed.lock().map(|g| g.is_some()).unwrap_or(true) {
                    return;
                }
                // A clip playing from the cloud goes first.
                super::lane::yield_to_playback(|| cancel.load(Ordering::Relaxed));
                let start = next.fetch_add(PIECE, Ordering::SeqCst);
                if start >= size {
                    return;
                }
                let end = (start + PIECE).min(size) - 1;
                let mut last = None;
                for attempt in 0..3u64 {
                    match piece(id, start, end, &f) {
                        Ok(()) => {
                            last = None;
                            break;
                        }
                        Err(e) => {
                            last = Some(e.to_string());
                            std::thread::sleep(Duration::from_secs(2 + attempt * 5));
                        }
                    }
                }
                if let Some(e) = last {
                    *failed.lock().unwrap_or_else(|e| e.into_inner()) = Some(e);
                }
            });
        }
    });
    if let Some(e) = failed.into_inner().unwrap_or_else(|e| e.into_inner()) {
        return Err(Error::Invalid(e));
    }
    if cancel.load(Ordering::Relaxed) {
        return Err(Error::Invalid("Stopped".into()));
    }
    f.sync_all()?;
    Ok(())
}

/// A file in My Drive found by its exact name (not trashed): its id and size.
/// For previews made in Google's cloud, which this Mac's Google Drive app may
/// not have synced yet. None when not connected, not found or not reachable.
pub fn find_by_name(name: &str) -> Option<(String, u64)> {
    if !connected() || name.contains('\'') {
        return None;
    }
    let token = access_token().ok()?;
    let q = format!("name = '{name}' and trashed = false");
    let url = format!("https://www.googleapis.com/drive/v3/files?q={}&fields=files(id,size)&pageSize=1&spaces=drive", enc(&q));
    let mut child = Command::new("/usr/bin/curl")
        .args(["-sS", "--fail", "--max-time", "30", "-K", "-", &url])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    child.stdin.take()?.write_all(format!("header = \"Authorization: Bearer {token}\"\n").as_bytes()).ok()?;
    let o = child.wait_with_output().ok()?;
    if !o.status.success() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_slice(&o.stdout).ok()?;
    let f = v["files"].as_array()?.first()?;
    Some((f["id"].as_str()?.to_owned(), f["size"].as_str()?.parse().ok()?))
}

/// What Google holds for a Drive id: size and md5 (None for files Drive
/// keeps no checksum of). For checking a copy is complete online before the
/// local one goes to the Bin. None when not connected or not found.
pub fn meta(id: &str) -> Option<(u64, Option<String>)> {
    if !connected() {
        return None;
    }
    let token = access_token().ok()?;
    let url = format!("https://www.googleapis.com/drive/v3/files/{}?fields=size,md5Checksum,trashed&supportsAllDrives=true", enc(id));
    let mut child = Command::new("/usr/bin/curl")
        .args(["-sS", "--fail", "--max-time", "30", "-K", "-", &url])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    child.stdin.take()?.write_all(format!("header = \"Authorization: Bearer {token}\"\n").as_bytes()).ok()?;
    let o = child.wait_with_output().ok()?;
    if !o.status.success() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_slice(&o.stdout).ok()?;
    if v["trashed"].as_bool() == Some(true) {
        return None;
    }
    Some((v["size"].as_str()?.parse().ok()?, v["md5Checksum"].as_str().map(str::to_owned)))
}

/// A Drive file's raw metadata (name, parents, size, md5, trashed), for
/// checks such as "is it in the folder it should be". None when unreachable.
pub fn meta_json(id: &str) -> Option<serde_json::Value> {
    if !connected() {
        return None;
    }
    let token = access_token().ok()?;
    let url = format!("https://www.googleapis.com/drive/v3/files/{}?fields=name,parents,size,md5Checksum,trashed&supportsAllDrives=true", enc(id));
    let mut child = Command::new("/usr/bin/curl")
        .args(["-sS", "--fail", "--max-time", "30", "-K", "-", &url])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    child.stdin.take()?.write_all(format!("header = \"Authorization: Bearer {token}\"\n").as_bytes()).ok()?;
    let o = child.wait_with_output().ok()?;
    o.status.success().then(|| serde_json::from_slice(&o.stdout).ok()).flatten()
}

/// For making a review copy: when connected, downloads the online original of
/// `path` into `dir` and returns the temporary file (the caller deletes it).
/// None when not connected, not a Drive file, or the download failed.
pub fn fetch_for_copy(path: &Path, size: u64, dir: &Path, cancel: &AtomicBool) -> Option<PathBuf> {
    if !connected() {
        return None;
    }
    let id = file_id(path)?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("mp4");
    let tmp = dir.join(format!(".direct-{}.{ext}", random(6).ok()?));
    match download(&id, size, &tmp, cancel) {
        Ok(()) => Some(tmp),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            crate::applog::line(&format!("direct download failed for {}: {e}", path.display()));
            None
        }
    }
}

/// Times one direct download of `path` (into `dir`, removed afterwards).
/// Returns (bytes, seconds).
pub fn speed_test(path: &Path, dir: &Path) -> Result<(u64, f64)> {
    let id = file_id(path).ok_or_else(|| Error::Invalid("That file has no Drive id".into()))?;
    let size = std::fs::symlink_metadata(path)?.len();
    let tmp = dir.join(format!(".speedtest-{}", random(6)?));
    let started = Instant::now();
    let result = download(&id, size, &tmp, &AtomicBool::new(false));
    let secs = started.elapsed().as_secs_f64();
    let _ = std::fs::remove_file(&tmp);
    result.map(|_| (size, secs))
}

/// Google Drive's own thumbnail of a file (`px` on the long edge) into `dest`:
/// a few KB, nothing of the original is downloaded. False when Drive has none
/// (some RAW formats, a clip still processing) or isn't reachable.
pub fn thumbnail(id: &str, px: u32, dest: &Path) -> bool {
    let Ok(token) = access_token() else { return false };
    let auth = format!("header = \"Authorization: Bearer {token}\"\n");
    let call = |url: &str, with_auth: bool, out: Option<&Path>| -> Option<Vec<u8>> {
        let mut cmd = Command::new("/usr/bin/curl");
        cmd.args(["-sS", "--fail", "-L", "--max-time", "30"]);
        if with_auth {
            cmd.args(["-K", "-"]);
        }
        if let Some(out) = out {
            cmd.arg("-o").arg(out);
        }
        let mut child = cmd.arg(url).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
        let mut stdin = child.stdin.take()?;
        if with_auth {
            stdin.write_all(auth.as_bytes()).ok()?;
        }
        drop(stdin);
        let o = child.wait_with_output().ok()?;
        o.status.success().then_some(o.stdout)
    };
    // The first few refusals go to the app's log, so a pattern can be seen.
    static TOLD: AtomicU64 = AtomicU64::new(0);
    let tell = |what: &str| {
        if TOLD.fetch_add(1, Ordering::Relaxed) < 5 {
            crate::applog::line(&format!("drive thumbnail: {what}"));
        }
    };
    let meta = format!("https://www.googleapis.com/drive/v3/files/{}?fields=thumbnailLink&supportsAllDrives=true", enc(id));
    let Some(body) = call(&meta, true, None) else {
        tell("the file's details didn't come (network or permission)");
        return false;
    };
    let Some(link) = serde_json::from_slice::<serde_json::Value>(&body).ok().and_then(|v| v["thumbnailLink"].as_str().map(str::to_owned)) else {
        tell("Drive has no thumbnail for this file");
        return false;
    };
    // The link ends in "=s220": ask for the size wanted instead.
    let base = match link.rfind("=s") {
        Some(i) if link[i + 2..].chars().all(|c| c.is_ascii_digit()) => &link[..i],
        _ => link.as_str(),
    };
    let url = format!("{base}=s{px}");
    let got = |p: &Path| std::fs::read(p).is_ok_and(|b| b.len() > 100 && b.starts_with(&[0xFF, 0xD8]) || b.starts_with(b"\x89PNG"));
    if call(&url, true, Some(dest)).is_some() && got(dest) {
        return true;
    }
    let ok = call(&url, false, Some(dest)).is_some() && got(dest);
    if !ok {
        tell("the thumbnail link didn't answer with an image");
    }
    ok
}

/// Bytes `start..start+len` of a Drive file, at most `len` (one ranged request).
pub fn range(id: &str, start: u64, len: u64) -> Option<Vec<u8>> {
    let token = access_token().ok()?;
    let url = format!("https://www.googleapis.com/drive/v3/files/{}?alt=media&supportsAllDrives=true", enc(id));
    let mut child = Command::new("/usr/bin/curl")
        .args(["-sS", "--fail", "-L", "--max-time", "60", "-K", "-", "-r", &format!("{start}-{}", start + len.max(1) - 1), &url])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    child.stdin.take()?.write_all(format!("header = \"Authorization: Bearer {token}\"\n").as_bytes()).ok()?;
    let out = child.wait_with_output().ok()?;
    (out.status.success() && !out.stdout.is_empty()).then_some(out.stdout)
}

/// The JPEG preview a camera stores inside a RAW file (Sony ARW, Nikon NEF,
/// Canon CR2, DNG: all TIFF inside), found by reading the file's directory
/// and then only that JPEG, so a 25 MB RAW costs a few hundred KB.
/// `read(start, len)` returns those bytes of the file.
pub fn raw_embedded_jpeg(read: impl Fn(u64, u64) -> Option<Vec<u8>>) -> Option<Vec<u8>> {
    let head = read(0, 256 * 1024)?;
    let at = |buf: &[u8], i: usize, n: usize| buf.get(i..i + n).map(|b| b.to_vec());
    let le = head.get(0..2)? == b"II";
    if !le && head.get(0..2)? != b"MM" {
        return None;
    }
    let u16_ = |b: &[u8]| if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) } as u64;
    let u32_ = |b: &[u8]| if le { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) } as u64;
    if u16_(&head[2..4]) != 42 {
        return None;
    }
    // Bytes at `off` from the head when there, else read for them.
    let bytes = |off: u64, n: u64| -> Option<Vec<u8>> {
        at(&head, off as usize, n as usize).or_else(|| read(off, n).filter(|b| b.len() as u64 == n))
    };
    let mut ifds = vec![u32_(&head[4..8])];
    let mut seen = std::collections::HashSet::new();
    let mut best: Option<(u64, u64)> = None;
    while let Some(ifd) = ifds.pop() {
        if ifd == 0 || !seen.insert(ifd) || seen.len() > 16 {
            continue;
        }
        let count = u16_(&bytes(ifd, 2)?).min(500);
        let table = bytes(ifd + 2, count * 12 + 4)?;
        let (mut off, mut len) = (None, None);
        for e in 0..count as usize {
            let entry = &table[e * 12..e * 12 + 12];
            let (tag, kind, n) = (u16_(&entry[0..2]), u16_(&entry[2..4]), u32_(&entry[4..8]));
            let value = if kind == 3 { u16_(&entry[8..10]) } else { u32_(&entry[8..12]) };
            match tag {
                0x0201 => off = Some(value),
                0x0202 => len = Some(value),
                // SubIFDs: one offset inline, or a list of offsets elsewhere.
                0x014A if n == 1 => ifds.push(value),
                0x014A => {
                    if let Some(list) = bytes(value, n.min(8) * 4) {
                        ifds.extend(list.chunks(4).map(u32_));
                    }
                }
                _ => {}
            }
        }
        if let (Some(o), Some(l)) = (off, len) {
            if l > 500 && l < 8_000_000 && best.is_none_or(|(_, bl)| l > bl) {
                best = Some((o, l));
            }
        }
        ifds.push(u32_(&table[count as usize * 12..count as usize * 12 + 4]));
    }
    let (off, len) = best?;
    let jpeg = bytes(off, len)?;
    jpeg.starts_with(&[0xFF, 0xD8]).then_some(jpeg)
}
