use std::path::Path;
use std::process::Command;

/// Compiles a Swift helper when its source is newer than the binary.
fn helper(name: &str, extra: &[&str], inputs: &[&str]) {
    let src = format!("helpers/{name}.swift");
    let out = format!("helpers/{name}");
    for input in inputs.iter().chain([&src.as_str()]) {
        println!("cargo:rerun-if-changed={input}");
    }
    let built = Path::new(&out).metadata().and_then(|m| m.modified()).ok();
    let stale = inputs.iter().chain([&src.as_str()]).any(|i| match (Path::new(i).metadata().and_then(|m| m.modified()).ok(), built) {
        (Some(s), Some(o)) => s > o,
        _ => true,
    });
    if !stale {
        return;
    }
    let ok = Command::new("xcrun")
        .args(["swiftc", "-O", "-o", &out, &src])
        .args(extra)
        .status()
        .is_ok_and(|s| s.success());
    if !ok {
        panic!("could not compile {src} (needs the Xcode command line tools)");
    }
}

fn main() {
    // Helpers that ship inside the app bundle: video frames (AVFoundation)
    // and voice culling (on-device speech recognition). The voice helper
    // carries its own Info.plist so macOS can explain the microphone prompt.
    helper("videoframe", &[], &[]);
    helper("airdrop", &[], &[]);
    helper("vision", &[], &[]);
    helper("clip", &[], &[]);
    helper("review", &[], &[]);
    helper("webshot", &[], &[]);
    helper("places", &[], &[]);
    helper(
        "bin",
        &["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", "helpers/bin-Info.plist"],
        &["helpers/bin-Info.plist"],
    );
    helper(
        "listen",
        &["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", "helpers/listen-Info.plist"],
        &["helpers/listen-Info.plist"],
    );
    tauri_build::build()
}
