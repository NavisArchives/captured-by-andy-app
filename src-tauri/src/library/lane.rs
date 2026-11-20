//! One download from the cloud at a time, and none while an online original
//! is playing. The line is slow (about 1 MB/s from Lima, less while Google
//! Drive uploads), so two downloads only make both slow, and a clip being
//! watched must not stall behind a preview being made in the background.

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

static LANE: Mutex<()> = Mutex::new(());
static PLAYED: Mutex<Option<Instant>> = Mutex::new(None);

/// How long after the last piece served to a player background downloads wait.
const QUIET: Duration = Duration::from_secs(4);

/// Holds the one download lane until dropped.
pub fn take() -> MutexGuard<'static, ()> {
    LANE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether the Mac runs on mains power (a desktop Mac always does). Unknown
/// counts as yes. `CBA_ASSUME_BATTERY=1` says no, for test runs.
pub fn on_mains() -> bool {
    if std::env::var("CBA_ASSUME_BATTERY").is_ok_and(|v| v == "1") {
        return false;
    }
    std::process::Command::new("/usr/bin/pmset")
        .args(["-g", "batt"])
        .output()
        .map(|o| {
            let first = String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("").to_owned();
            first.is_empty() || first.contains("AC Power")
        })
        .unwrap_or(true)
}

/// The battery's charge in percent, None on mains power or without a battery.
pub fn battery_percent() -> Option<u32> {
    if std::env::var("CBA_ASSUME_BATTERY").is_ok_and(|v| v == "1") {
        return Some(10);
    }
    let out = std::process::Command::new("/usr/bin/pmset").args(["-g", "batt"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    if text.lines().next().unwrap_or("").contains("AC Power") {
        return None;
    }
    let pct = text.split('%').next()?.rsplit(|c: char| !c.is_ascii_digit()).next()?;
    pct.parse().ok()
}

/// Background work may go on: on mains power, or on battery above 30 %
/// (Andy, 12 Nov: "don't pause, go for it"; below 30 % the Mac must not run flat).
pub fn power_ok() -> bool {
    battery_percent().map_or(true, |p| p > 30)
}

/// The lane if it's free now, else None (to say what is being waited for).
pub fn try_take() -> Option<MutexGuard<'static, ()>> {
    LANE.try_lock().ok()
}

/// An online original is being streamed to a player right now.
pub fn playing() {
    *PLAYED.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
}

/// Whether a player streamed an online original in the last few seconds.
pub fn busy_playing() -> bool {
    PLAYED.lock().unwrap_or_else(|e| e.into_inner()).is_some_and(|t| t.elapsed() < QUIET)
}

/// Waits while a player streams (checked between pieces of a download).
/// Returns early when `stop` says so.
pub fn yield_to_playback(stop: impl Fn() -> bool) {
    while busy_playing() && !stop() {
        std::thread::sleep(Duration::from_millis(300));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_downloads_wait_while_a_clip_plays_and_go_on_after() {
        assert!(try_take().is_some(), "free when nothing runs");
        let held = take();
        assert!(try_take().is_none(), "one download at a time");
        drop(held);
        playing();
        assert!(busy_playing());
        let started = Instant::now();
        yield_to_playback(|| started.elapsed() > Duration::from_millis(600));
        assert!(started.elapsed() >= Duration::from_millis(600), "it waited while the clip played");
        *PLAYED.lock().unwrap() = None;
        let started = Instant::now();
        yield_to_playback(|| false);
        assert!(started.elapsed() < Duration::from_millis(50), "nothing playing: no wait");
    }
}
