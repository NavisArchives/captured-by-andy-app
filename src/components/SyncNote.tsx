// The header's word on the online library. On the Mac: when it last synced, and
// a click syncs now. Online: when the Mac last synced, so an old library never
// passes for a current one. It turns to a warning when that is long ago.
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { api } from "../api";
import { ago } from "../lib/format";
import type { SyncStatus } from "../types";

/** Older than this, the line warns. */
const STALE_MS = 30 * 60 * 1000;

export function SyncNote() {
  const [s, setS] = useState<SyncStatus | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    api.syncStatus().then(setS).catch(() => {});
    const off = listen<SyncStatus>("sync-status", (e) => setS(e.payload));
    const t = setInterval(() => tick((n) => n + 1), 30_000); // "2 min ago" keeps moving
    return () => {
      void off.then((f) => f());
      clearInterval(t);
    };
  }, []);
  if (!s || !s.configured) return null;
  const stale = !s.lastOkMs || Date.now() - s.lastOkMs > STALE_MS;
  const text = s.remote
    ? `Mac synced ${ago(s.lastOkMs)}`
    : s.running && !s.lastOkMs
      ? "Syncing…"
      : s.error
        ? `Not synced ${s.lastOkMs ? `since ${ago(s.lastOkMs)}` : "yet"} · trying again`
        : `Synced ${ago(s.lastOkMs)}`;
  const warn = s.error != null || stale;
  const title = s.remote
    ? "The Mac sends its changes here while the app is open on it. Open it to bring this up to date."
    : s.error
      ? `${s.error}\nClick to try now.`
      : "Your phone sees this library. Click to sync now.";
  return (
    <button
      type="button"
      className={warn ? "sync-note warn" : "sync-note"}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        if (!s.remote) void api.syncNow();
      }}
    >
      {text}
    </button>
  );
}
