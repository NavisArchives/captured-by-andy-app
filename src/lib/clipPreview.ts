// Whether a clip can play at once (its light review copy, or the original on
// this Mac), and, when it can't, its review copy asked for first with the
// progress of making it. An online-only original is never loaded by itself:
// through Google Drive that's minutes before the first frame.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { api } from "../api";
import { WEB, webHooks } from "../platform";

export interface MakerProgress {
  done: number;
  total: number;
  currentId: string;
  currentSize: number;
  current: string;
  lastReady: string;
  note: string;
}

export interface CopiesStatus {
  ready: number;
  bytes: number;
  waiting: number;
  waitingOnlineBytes: number;
  running: boolean;
  capBytes: number;
  speed: number | null;
}

export type ClipSource =
  | { kind: "checking" }
  | { kind: "ready"; version: number }
  | { kind: "original" }
  | { kind: "waiting"; making: boolean; size: number; speed: number | null; behind: string; note: string }
  | { kind: "failed" }
  | { kind: "unavailable"; note: string };

/** Assumed when nothing has been measured yet: the line from Lima, about 1 MB/s. */
export const ASSUMED_SPEED = 1_000_000;

/** How long `size` bytes take at `speed` bytes/s (or the assumed 1 MB/s), in words ("about 9 min"). */
export function eta(size: number, speed: number | null | undefined): string {
  if (!size) return "";
  const s = size / (speed || ASSUMED_SPEED);
  if (s < 60) return "under a minute";
  if (s < 3600) return `about ${Math.round(s / 60)} min`;
  const h = s / 3600;
  return `about ${h < 10 ? Math.round(h * 2) / 2 : Math.round(h)} h`;
}

export function useClipSource(photoId: string): [ClipSource, () => void] {
  const [source, setSource] = useState<ClipSource>({ kind: "checking" });
  useEffect(() => {
    if (WEB) {
      setSource(webHooks.videoAvailable?.(photoId) ? { kind: "ready", version: 0 } : { kind: "unavailable", note: "This clip has no browser playback copy yet. Prepare its web copy on the Mac, then sync again." });
      return;
    }
    let live = true;
    let speed: number | null = null;
    const offs: (() => void)[] = [];
    setSource({ kind: "checking" });
    api
      .videosReady([photoId])
      .then(async (ready) => {
        if (!live) return;
        if (ready.includes(photoId)) return setSource({ kind: "ready", version: 0 });
        setSource({ kind: "waiting", making: false, size: 0, speed: null, behind: "", note: "" });
        offs.push(
          await listen<string>("review-copy-ready", (e) => {
            if (live && e.payload === photoId) setSource({ kind: "ready", version: Date.now() });
          }),
          await listen<string>("review-copy-failed", (e) => {
            if (live && e.payload === photoId) setSource({ kind: "failed" });
          }),
          // Downloaded meanwhile (Download, or the cull window): it plays now.
          await listen("library-changed", () => {
            if (!live) return;
            api.videosReady([photoId]).then((r) => live && r.includes(photoId) && setSource({ kind: "ready", version: Date.now() })).catch(() => {});
          }),
          await listen<MakerProgress>("review-progress", (e) => {
            if (!live) return;
            const p = e.payload;
            setSource((s) =>
              s.kind !== "waiting"
                ? s
                : p.currentId === photoId
                  ? { kind: "waiting", making: true, size: p.currentSize, speed, behind: "", note: p.note }
                  : { ...s, making: false, behind: p.current, note: p.note },
            );
          }),
        );
        if (!live) return offs.forEach((f) => f());
        invoke<CopiesStatus>("review_copies").then((st) => (speed = st.speed)).catch(() => {});
        await invoke("want_preview", { photoId });
      })
      .catch(() => live && setSource({ kind: "failed" }));
    return () => {
      live = false;
      offs.forEach((f) => f());
      // Left before its preview came: it goes back in line (a rejected one drops out).
      if (!WEB) void invoke("unwant_preview", { photoId }).catch(() => {});
    };
  }, [photoId]);
  return [source, () => setSource({ kind: "original" })];
}
