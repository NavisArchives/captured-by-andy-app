// Full frame: the picture alone, edge to edge on black, with the window in
// macOS full screen. ⇧F goes in and out, Esc comes out. A window that was
// already full screen stays so when you leave.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";

async function windowFull(on: boolean, was: { current: boolean | null }) {
  try {
    const w = getCurrentWindow();
    if (on) {
      was.current = await w.isFullscreen();
      if (!was.current) await w.setFullscreen(true);
    } else {
      if (was.current === false) await w.setFullscreen(false);
      was.current = null;
    }
  } catch {
    /* the browser preview: the picture still fills the window */
  }
}

export function useFullFrame() {
  const [full, setFull] = useState(false);
  const fullRef = useRef(false);
  const was = useRef<boolean | null>(null);
  const set = useCallback((on: boolean) => {
    if (on === fullRef.current) return;
    fullRef.current = on;
    setFull(on);
    void windowFull(on, was);
  }, []);
  useEffect(() => {
    // Capture phase: Esc that leaves full frame never also goes Back.
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector(".scrim")) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || (t.tagName === "INPUT" && (t as HTMLInputElement).type !== "range"))) return;
      if (e.shiftKey && (e.code === "KeyF" || e.key.toLowerCase() === "f")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!e.repeat) set(!fullRef.current);
      } else if (e.key === "Escape" && fullRef.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        set(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [set]);
  // Leaving the screen leaves full frame too.
  useEffect(() => () => {
    if (fullRef.current) void windowFull(false, was);
  }, []);
  const toggle = useCallback(() => set(!fullRef.current), [set]);
  return { full, setFull: set, toggle };
}
