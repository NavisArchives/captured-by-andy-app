//! The assistant's failure paths, through the real Rust door (NIRMATA, 20 Nov,
//! assistant health A4). Each case prints the error the panel turns into a
//! plain sentence. Never prints or reads the real key: the « refused key » case
//! uses a fake key in a throwaway HOME.
//!   cargo run --example assistant_failures -- <scratch dir>
use captured_by_andy_lib::assistant_cmd::send;
use captured_by_andy_lib::library::db::Db;
use serde_json::json;
use std::path::PathBuf;

/// What the panel shows for an error (same rule as Assistant.tsx).
fn panel(m: &str) -> &'static str {
    if m.starts_with("key") {
        "The assistant's key is missing or refused. Everything else works as before."
    } else if m.starts_with("cap") {
        "Today's limit of 150 requests is reached. It resets tomorrow."
    } else if m.starts_with("offline") {
        "No connection to Claude. Everything else works offline."
    } else if m.starts_with("busy") {
        "Claude is busy. Try again in a minute."
    } else if m.starts_with("image") {
        "Pictures never leave the Mac; the request was stopped."
    } else {
        "(shown as is)"
    }
}

fn main() {
    let dir = PathBuf::from(std::env::args().nth(1).expect("scratch dir"));
    let db = Db::open(&dir.join("usage.db")).unwrap();
    let tools = json!([]);
    let hi = json!([{"role": "user", "content": [{"type": "text", "text": "hello"}]}]);
    let real_home = std::env::var_os("HOME").unwrap();
    let run = |label: &str, messages: &serde_json::Value| {
        let t = std::time::Instant::now();
        match send(&db, "Answer in one word.".into(), tools.clone(), messages.clone()) {
            Ok(v) => println!("{label}\tOK stop_reason={} ({} ms)", v["stop_reason"], t.elapsed().as_millis()),
            Err(e) => println!("{label}\tERR « {e} » → panel: « {} » ({} ms)", panel(&e), t.elapsed().as_millis()),
        }
    };

    // 1. No key file: a HOME with nothing in it.
    let empty = dir.join("home-empty");
    std::fs::create_dir_all(&empty).unwrap();
    std::env::set_var("HOME", &empty);
    run("no key file", &hi);

    // 2. A key that Anthropic refuses (fake, in a throwaway HOME).
    let fake = dir.join("home-fake");
    std::fs::create_dir_all(fake.join(".config/captured-by-andy")).unwrap();
    std::fs::write(fake.join(".config/captured-by-andy/anthropic-key"), "sk-ant-not-a-real-key").unwrap();
    std::env::set_var("HOME", &fake);
    run("refused key", &hi);

    // 3. No network: curl goes through a proxy that isn't there.
    std::env::set_var("HOME", &real_home);
    std::env::set_var("ALL_PROXY", "socks5h://127.0.0.1:9");
    std::env::set_var("HTTPS_PROXY", "socks5h://127.0.0.1:9");
    run("no network", &hi);
    std::env::remove_var("ALL_PROXY");
    std::env::remove_var("HTTPS_PROXY");

    // 4. A picture in the request: stopped on the Mac before anything is sent.
    let img = json!([{"role": "user", "content": [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "AAAA"}}]}]);
    run("picture in request", &img);

    // 5. The real key, one tiny request: the door works end to end.
    run("real key, hello", &hi);
}
