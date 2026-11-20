//! The assistant against the real model (Amendment 8b, NIRMATA A1): the panel's
//! own system prompt and tools (dumped from src/components/assistantTools.ts),
//! a read-only COPY of the library for the tool results, and the real Rust path
//! (key on curl's stdin). The usage counter lives in a scratch library.
//! cargo run --example assistant_eval -- <spec.json> <library copy.db> <scratch dir>
//! Prints, per sentence: the tools called (with inputs), the tray, the reply.
use captured_by_andy_lib::assistant_cmd::send;
use captured_by_andy_lib::library::db::Db;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::path::PathBuf;

struct Lib {
    c: Connection,
    tray: Vec<String>,
    picked: usize,
    proposed: Option<String>,
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned).filter(|x| !x.is_empty())
}

impl Lib {
    fn trips(&self) -> Vec<(String, i64)> {
        let mut st = self
            .c
            .prepare(
                "SELECT substr(rest, 1, instr(rest, '/') - 1) AS trip, COUNT(*) FROM (
                   SELECT substr(path, instr(path, '/CAMERA/') + 8) AS rest FROM assets WHERE is_primary = 1 AND path LIKE '%/CAMERA/%'
                 ) WHERE instr(rest, '/') > 0 GROUP BY trip ORDER BY 2 DESC",
            )
            .unwrap();
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().flatten().collect()
    }

    fn near(&self, want: &str) -> Vec<String> {
        let w = want.to_uppercase();
        let mut t: Vec<(usize, String)> = self.trips().into_iter().map(|(n, _)| (n.chars().filter(|c| w.contains(*c)).count(), n)).collect();
        t.sort_by(|a, b| b.0.cmp(&a.0));
        t.into_iter().take(3).map(|x| x.1).collect()
    }

    fn run(&mut self, name: &str, i: &Value) -> Value {
        match name {
            "find_pictures" => {
                let mut wh = vec!["1=1".to_string()];
                let mut args: Vec<String> = vec![];
                let mut where_ = String::new();
                if let Some(place) = s(i, "place") {
                    let up = place.to_uppercase();
                    let trip: i64 = self.c.query_row("SELECT COUNT(*) FROM assets WHERE is_primary = 1 AND upper(path) LIKE ?1", [format!("%/{up}/%")], |r| r.get(0)).unwrap();
                    let album: Option<String> = self.c.query_row("SELECT id FROM albums WHERE upper(name) LIKE ?1", [format!("%{up}%")], |r| r.get(0)).ok();
                    if trip > 0 {
                        args.push(format!("%/{up}/%"));
                        wh.push(format!("upper(a.path) LIKE ?{}", args.len()));
                        where_ = format!("trip {place}");
                    } else if let Some(id) = album {
                        args.push(id);
                        wh.push(format!("EXISTS (SELECT 1 FROM photo_albums pa WHERE pa.photo_id = p.id AND pa.album_id = ?{})", args.len()));
                        where_ = format!("album {place}");
                    } else {
                        args.push(format!("%{up}%"));
                        wh.push(format!("(upper(a.path) LIKE ?{n} OR EXISTS (SELECT 1 FROM photo_labels l WHERE l.photo_id = p.id AND upper(l.label) LIKE ?{n}))", n = args.len()));
                        where_ = format!("matching « {place} »");
                    }
                }
                if let Some(al) = s(i, "album") {
                    args.push(format!("%{}%", al.to_uppercase()));
                    wh.push(format!("EXISTS (SELECT 1 FROM photo_albums pa JOIN albums al ON al.id = pa.album_id WHERE pa.photo_id = p.id AND upper(al.name) LIKE ?{})", args.len()));
                }
                if let Some(m) = s(i, "mark") {
                    args.push(m);
                    wh.push(format!("p.review_state = ?{}", args.len()));
                }
                if let Some(k) = s(i, "kind") {
                    wh.push(format!("p.is_video = {}", if k == "video" { 1 } else { 0 }));
                }
                if let Some(f) = s(i, "from") {
                    args.push(f);
                    wh.push(format!("p.captured_at >= ?{}", args.len()));
                }
                if let Some(t) = s(i, "to") {
                    args.push(format!("{t}T23:59:59"));
                    wh.push(format!("p.captured_at <= ?{}", args.len()));
                }
                if let Some(w) = s(i, "words") {
                    args.push(format!("%{}%", w.to_uppercase()));
                    wh.push(format!("(upper(a.path) LIKE ?{n} OR EXISTS (SELECT 1 FROM photo_labels l WHERE l.photo_id = p.id AND upper(l.label) LIKE ?{n}))", n = args.len()));
                }
                if i.get("edited").and_then(Value::as_bool) == Some(true) {
                    wh.push("EXISTS (SELECT 1 FROM photo_looks pl WHERE pl.photo_id = p.id)".into());
                }
                if i.get("never_posted").and_then(Value::as_bool) == Some(true) {
                    wh.push("p.review_state = 'selected' AND NOT EXISTS (SELECT 1 FROM post_photos pp JOIN posts po ON po.id = pp.post_id WHERE pp.photo_id = p.id AND po.status = 'published')".into());
                }
                let sql = format!(
                    "SELECT p.id, substr(a.path, length(rtrim(a.path, replace(a.path, '/', ''))) + 1), substr(p.captured_at, 1, 10), p.review_state, p.is_video
                     FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1 WHERE {} ORDER BY p.captured_at DESC",
                    wh.join(" AND ")
                );
                let mut st = self.c.prepare(&sql).unwrap();
                let rows: Vec<(String, String, String, String, i64)> = st
                    .query_map(rusqlite::params_from_iter(args.iter()), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
                    .unwrap()
                    .flatten()
                    .collect();
                if rows.is_empty() && (where_.starts_with("trip") || where_.starts_with("album")) {
                    return json!({"count": 0, "searched": where_, "note": format!("{where_} exists, but nothing in it matches the other filters")});
                }
                if rows.is_empty() {
                    let nearest = s(i, "place").map(|p| self.near(&p)).unwrap_or_default();
                    return json!({"count": 0, "searched": if where_.is_empty() { "the whole library".into() } else { where_ }, "your_trips": nearest});
                }
                self.tray = rows.iter().take(60).map(|r| r.0.clone()).collect();
                self.picked = 0;
                self.proposed = None;
                json!({"count": rows.len(), "where": where_, "shown_in_tray": self.tray.len(),
                       "first": rows.iter().take(30).map(|r| json!({"id": r.0, "file": r.1, "date": r.2, "mark": r.3, "video": r.4 == 1})).collect::<Vec<_>>()})
            }
            "select_pictures" => {
                let n = if let Some(ids) = i.get("photo_ids").and_then(Value::as_array) {
                    ids.iter().filter(|x| self.tray.iter().any(|t| Some(t.as_str()) == x.as_str())).count()
                } else {
                    i.get("first").and_then(Value::as_u64).unwrap_or(0).min(self.tray.len() as u64) as usize
                };
                self.picked = n;
                json!({"selected": n})
            }
            "list_trips" => json!(self.trips().into_iter().map(|(t, n)| json!({"trip": t, "pictures": n})).collect::<Vec<_>>()),
            "list_albums" => {
                let mut st = self.c.prepare("SELECT al.name, (SELECT COUNT(*) FROM photo_albums pa WHERE pa.album_id = al.id) FROM albums al").unwrap();
                json!(st.query_map([], |r| Ok(json!({"album": r.get::<_, String>(0)?, "pictures": r.get::<_, i64>(1)?}))).unwrap().flatten().collect::<Vec<_>>())
            }
            "list_projects" => {
                let mut st = self.c.prepare("SELECT title, stage FROM studio_pieces WHERE parked = 0 AND stage != 'posted' LIMIT 30").unwrap();
                json!(st.query_map([], |r| Ok(json!({"title": r.get::<_, String>(0)?, "stage": r.get::<_, String>(1)?}))).unwrap().flatten().collect::<Vec<_>>())
            }
            "propose" => {
                self.proposed = s(i, "outcome");
                json!({"shown": true})
            }
            _ => json!({"error": "unknown tool"}),
        }
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let spec: Value = serde_json::from_str(&std::fs::read_to_string(&a[1]).unwrap()).unwrap();
    let c = Connection::open_with_flags(&a[2], OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let scratch = PathBuf::from(&a[3]);
    std::fs::create_dir_all(&scratch).unwrap();
    let db = Db::open(&scratch.join("library.db")).unwrap();
    let mut lib = Lib { c, tray: vec![], picked: 0, proposed: None };
    let system = spec["system"].as_str().unwrap().to_owned();
    let tools = spec["tools"].clone();
    // Sessions: a list of sentences that follow each other in one conversation.
    let sessions: Vec<Vec<&str>> = vec![
        vec!["all the approved pictures from Egypt", "the first three", "put these on Instagram"],
        vec!["les photos sélectionnées de Bangkok"],
        vec!["alle goedgekeurde foto's uit Vietnam", "only the videos"],
        vec!["the selected ones from India that are not already posted"],
        vec!["pictures from Atlantis"],
        vec!["what did I shoot on 2 November 2026?"],
        vec!["everything in the FACES album"],
        vec!["something nice for my feed"],
        vec!["what's the weather in Lima tomorrow?"],
    ];
    for session in sessions {
        let mut messages: Vec<Value> = vec![];
        lib.tray.clear();
        lib.picked = 0;
        lib.proposed = None;
        for sentence in session {
            let screen = format!("Screen: dashboard. {}", if lib.picked > 0 { format!("{} pictures selected in the tray.", lib.picked) } else if !lib.tray.is_empty() { format!("{} pictures in the tray, none selected.", lib.tray.len()) } else { String::new() });
            messages.push(json!({"role": "user", "content": [{"type": "text", "text": format!("{screen}\n\n{sentence}")}]}));
            let mut calls = vec![];
            let mut reply = String::new();
            for _ in 0..5 {
                let res = match send(&db, system.clone(), tools.clone(), json!(messages)) {
                    Ok(v) => v,
                    Err(e) => {
                        reply = format!("ERROR {}", e.split(':').next().unwrap_or("?"));
                        break;
                    }
                };
                messages.push(json!({"role": "assistant", "content": res["content"]}));
                let mut results = vec![];
                for b in res["content"].as_array().into_iter().flatten() {
                    if b["type"] == "text" {
                        reply = b["text"].as_str().unwrap_or("").replace('\n', " ");
                    }
                    if b["type"] == "tool_use" {
                        let name = b["name"].as_str().unwrap_or("");
                        calls.push(format!("{name}{}", b["input"]));
                        let out = lib.run(name, &b["input"]);
                        results.push(json!({"type": "tool_result", "tool_use_id": b["id"], "content": out.to_string()}));
                    }
                }
                if res["stop_reason"] != "tool_use" || results.is_empty() {
                    break;
                }
                messages.push(json!({"role": "user", "content": results}));
            }
            println!("» {sentence}\n   tools: {}\n   tray: {} · picked {} · proposed {:?}\n   reply: {}\n", if calls.is_empty() { "—".into() } else { calls.join(" ; ") }, lib.tray.len(), lib.picked, lib.proposed, reply);
        }
    }
}
