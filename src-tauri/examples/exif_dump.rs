//! Prints capture time, GPS and camera for each path on stdin, one JSON line
//! per file, through the same ImageIO path the app uses. Reads headers only.
use std::io::BufRead;

use captured_by_andy_lib::library::media;

fn main() {
    for line in std::io::stdin().lock().lines() {
        let path = line.expect("line");
        let m = media::read_metadata(std::path::Path::new(&path));
        let v = match m {
            Some(m) => serde_json::json!({ "path": path, "capturedAt": m.captured_at, "lat": m.latitude, "lon": m.longitude, "model": m.camera_model }),
            None => serde_json::json!({ "path": path, "error": "unreadable" }),
        };
        println!("{v}");
    }
}
