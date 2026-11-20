// Effects: ready-made settings of the effect sliders (grain, vignette, fade,
// soften, halation, colour fringe, scan lines, gate weave, light leak). Picking
// one sets all of them and leaves the look, light and colour alone, so it sits
// on top of any LUT.
import type { Adjustments } from "../types";

export const EFFECT_KEYS = ["grain", "vignette", "fade", "soften", "halation", "fringe", "scanlines", "weave", "leak"] as const;
export type EffectKey = (typeof EFFECT_KEYS)[number];
export type EffectSettings = Pick<Adjustments, EffectKey>;

export interface Effect {
  id: string;
  name: string;
  note: string;
  set: Partial<EffectSettings>;
}

export const EFFECTS: Effect[] = [
  { id: "vintage-cam", name: "Vintage cam", note: "A camcorder from the 90s: soft, colour fringes, scan lines, faded", set: { soften: 35, fringe: 45, scanlines: 35, fade: 30, halation: 15, weave: 20, grain: 35, vignette: -25 } },
  { id: "super-8", name: "Super 8", note: "Home movie film: weave, heavy grain, glow and a light leak", set: { weave: 60, grain: 70, fade: 25, halation: 45, leak: 25, soften: 20, vignette: -55 } },
  { id: "16mm", name: "16 mm", note: "Documentary film: grain, a little weave and halation", set: { grain: 80, weave: 35, halation: 30, fade: 15, vignette: -35 } },
  { id: "vhs", name: "VHS", note: "Tape: scan lines, strong colour fringes, soft", set: { scanlines: 70, fringe: 75, soften: 45, fade: 20, grain: 25 } },
  { id: "halation", name: "Halation", note: "The red glow film puts around highlights", set: { halation: 65 } },
  { id: "dream", name: "Dream", note: "Soft and glowing", set: { soften: 55, halation: 35, fade: 15 } },
  { id: "matte", name: "Matte", note: "Lifted blacks, a printed look", set: { fade: 55 } },
  { id: "light-leak", name: "Light leak", note: "Warm light washing in from the side", set: { leak: 65, halation: 20 } },
];

/** All effect sliders as the effect sets them (the rest at zero). */
export function effectSettings(e: Effect | null): EffectSettings {
  return Object.fromEntries(EFFECT_KEYS.map((k) => [k, e?.set[k] ?? 0])) as EffectSettings;
}

/** The effect these sliders match exactly, if any. */
export function currentEffect(adj: Adjustments): Effect | null {
  return EFFECTS.find((e) => EFFECT_KEYS.every((k) => (e.set[k] ?? 0) === adj[k])) ?? null;
}
