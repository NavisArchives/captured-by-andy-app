// The palette (Marine or Forest, picked under the AH initials, remembered on
// this Mac) and the mode (Photo or Studio), both as attributes on <html> so
// the stylesheet can colour everything from them.
import { getCurrentWindow } from "@tauri-apps/api/window";

export type Palette = "marine" | "forest";
export type Mode = "photo" | "studio";

export const PALETTES: { id: Palette; glyph: string; label: string }[] = [
  { id: "marine", glyph: "◆", label: "Marine" },
  { id: "forest", glyph: "●", label: "Forest" },
];

const KEY = "cba-palette";

export function currentPalette(): Palette {
  try {
    return localStorage.getItem(KEY) === "forest" ? "forest" : "marine";
  } catch {
    return "marine";
  }
}

export function applyPalette(p: Palette) {
  document.documentElement.dataset.palette = p;
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* private storage: the default it is */
  }
}

export function applyMode(m: Mode) {
  document.documentElement.dataset.mode = m;
  try {
    getCurrentWindow()
      .setTitle("Captured by Andy")
      .catch(() => {});
  } catch {
    /* no native window (the dev preview) */
  }
}
