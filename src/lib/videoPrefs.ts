// Video sound, for every player in the app at once: off unless turned on,
// remembered on this Mac.
import { useEffect, useState } from "react";

const KEY = "cba-video-muted";

export function videoMuted(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function setVideoMuted(muted: boolean) {
  try {
    localStorage.setItem(KEY, muted ? "1" : "0");
  } catch {
    /* private storage: this session only */
  }
  window.dispatchEvent(new CustomEvent("cba-video-muted", { detail: muted }));
}

export function useVideoMuted(): [boolean, (muted: boolean) => void] {
  const [muted, setMuted] = useState(videoMuted);
  useEffect(() => {
    const on = (e: Event) => setMuted((e as CustomEvent<boolean>).detail);
    window.addEventListener("cba-video-muted", on);
    return () => window.removeEventListener("cba-video-muted", on);
  }, []);
  return [muted, setVideoMuted];
}
