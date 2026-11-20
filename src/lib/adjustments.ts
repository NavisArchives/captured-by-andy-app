// Saying what an edit's sliders do, in a few words ("grain, contrast").
import type { Adjustments } from "../types";

const NAMES: [keyof Adjustments, string][] = [
  ["exposure", "exposure"],
  ["contrast", "contrast"],
  ["highlights", "highlights"],
  ["shadows", "shadows"],
  ["whites", "whites"],
  ["blacks", "blacks"],
  ["temperature", "warmth"],
  ["tint", "tint"],
  ["vibrance", "vibrance"],
  ["saturation", "saturation"],
  ["grain", "grain"],
  ["vignette", "vignette"],
];

/** The sliders an edit moves, not its framing; "" when none. */
export function slidersText(adj: Partial<Adjustments>, max = 4): string {
  const moved = NAMES.filter(([k]) => (adj[k] ?? 0) !== 0).map(([, name]) => name);
  return moved.length > max ? `${moved.slice(0, max).join(", ")} and ${moved.length - max} more` : moved.join(", ");
}

const LABEL: Partial<Record<keyof Adjustments, string>> = Object.fromEntries(NAMES.map(([k, name]) => [k, name[0].toUpperCase() + name.slice(1)]));

/** Each moved slider with its value, framing left out: "Grain 30", "Exposure +0.3". */
export function sliderValues(adj: Partial<Adjustments>): { key: keyof Adjustments; label: string; value: string }[] {
  return NAMES.filter(([k]) => (adj[k] ?? 0) !== 0).map(([k]) => {
    const v = adj[k] ?? 0;
    const shown = k === "exposure" ? v.toFixed(2).replace(/\.?0+$/, "") : String(Math.round(v));
    // Grain only goes one way; the rest read as + / -.
    const signed = k === "grain" || v < 0 ? shown : `+${shown}`;
    return { key: k, label: LABEL[k] ?? k, value: k === "exposure" ? `${signed} EV` : signed };
  });
}
