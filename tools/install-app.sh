#!/bin/zsh
# Installs the app just built into ~/Applications without tearing it down:
# asks the running app to quit, waits (up to a minute) until it has really
# closed, only then swaps the bundle, and opens the new one.
set -e
NEW="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/target/release/bundle/macos/Captured by Andy.app"
APP="$HOME/Applications/Captured by Andy.app"
[ -d "$NEW" ] || { echo "no build at $NEW"; exit 1; }
running() { pgrep -f "Captured by Andy.app/Contents/MacOS/captured-by-andy" >/dev/null; }
if running; then
  osascript -e 'tell application "Captured by Andy" to quit' >/dev/null 2>&1 || true
  for i in {1..60}; do running || break; sleep 1; done
  if running; then echo "The app didn't close within a minute: left as it is, nothing installed."; exit 1; fi
fi
rm -rf "$APP.old" && { [ -d "$APP" ] && mv "$APP" "$APP.old" || true; }
ditto "$NEW" "$APP"
rm -rf "$APP.old"
open "$APP"
echo "installed and opened"
