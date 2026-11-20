//! One real request through the assistant's Rust path (Amendment 8b, D3/D4):
//! a scratch library (not Andy's), one tool, a text-only sentence. Prints the
//! stop reason, the tool call and the token use; never the key.
//! cargo run --example assistant_ping -- <scratch dir>
use captured_by_andy_lib::assistant_cmd::{request_body, send};
use captured_by_andy_lib::library::db::Db;
use serde_json::json;
use std::path::PathBuf;

fn main() {
    let dir = PathBuf::from(std::env::args().nth(1).expect("scratch dir"));
    std::fs::create_dir_all(&dir).unwrap();
    let db = Db::open(&dir.join("library.db")).expect("open scratch library");
    let tools = json!([{
        "name": "find_pictures",
        "description": "Find pictures in Andy's library.",
        "input_schema": {"type": "object", "properties": {"place": {"type": "string"}, "mark": {"type": "string", "enum": ["selected", "maybe", "rejected", "unreviewed"]}}, "additionalProperties": false}
    }]);
    let messages = json!([{"role": "user", "content": [{"type": "text", "text": "Screen: dashboard.\n\nall the approved pictures from Egypt"}]}]);
    // What goes out, minus the key (which is only in curl's stdin config).
    let body = request_body("You help Andy find pictures. Answer from tool results only.", &tools, &messages);
    let wire = serde_json::to_string(&body).unwrap();
    println!("body bytes: {} · has image block: {} · has key-like text: {}", wire.len(), wire.contains("\"image\""), wire.contains("sk-ant"));
    match send(&db, "You help Andy find pictures. Answer from tool results only.".into(), tools, messages) {
        Ok(v) => {
            println!("stop_reason: {}", v["stop_reason"]);
            for b in v["content"].as_array().into_iter().flatten() {
                if b["type"] == "tool_use" { println!("tool_use: {} {}", b["name"], b["input"]); }
                if b["type"] == "text" { println!("text: {}", b["text"]); }
            }
            println!("usage: {}", v["usage"]);
            println!("model: {}", v["model"]);
        }
        Err(e) => println!("error state: {}", e.split(':').next().unwrap_or("?")),
    }
}
