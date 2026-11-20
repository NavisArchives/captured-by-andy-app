// The basic sliders, grouped as the editor shows them (also the album look's baseline panel).
import type { Adjustments } from "../types";

export interface SliderDef {
  key: keyof Adjustments;
  label: string;
  min: number;
  max: number;
  step: number;
  cls?: string;
  fmt?: (v: number) => string;
}

export const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`);
export const SECTIONS: { title: string; sliders: SliderDef[] }[] = [
  {
    title: "Light",
    sliders: [
      { key: "exposure", label: "Exposure", min: -3, max: 3, step: 0.05, fmt: (v) => (v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2)) },
      { key: "contrast", label: "Contrast", min: -100, max: 100, step: 1 },
      { key: "highlights", label: "Highlights", min: -100, max: 100, step: 1 },
      { key: "shadows", label: "Shadows", min: -100, max: 100, step: 1 },
      { key: "whites", label: "Whites", min: -100, max: 100, step: 1 },
      { key: "blacks", label: "Blacks", min: -100, max: 100, step: 1 },
    ],
  },
  {
    title: "Colour",
    sliders: [
      { key: "temperature", label: "Temperature", min: -100, max: 100, step: 1, cls: "temp" },
      { key: "tint", label: "Tint", min: -100, max: 100, step: 1, cls: "tint" },
      { key: "vibrance", label: "Vibrance", min: -100, max: 100, step: 1 },
      { key: "saturation", label: "Saturation", min: -100, max: 100, step: 1 },
    ],
  },
  {
    title: "Effects",
    sliders: [
      { key: "grain", label: "Grain", min: 0, max: 100, step: 1 },
      { key: "vignette", label: "Vignette", min: -100, max: 100, step: 1 },
      { key: "fade", label: "Fade", min: 0, max: 100, step: 1 },
      { key: "soften", label: "Soften", min: 0, max: 100, step: 1 },
      { key: "halation", label: "Halation", min: 0, max: 100, step: 1 },
      { key: "fringe", label: "Colour fringe", min: 0, max: 100, step: 1 },
      { key: "scanlines", label: "Scan lines", min: 0, max: 100, step: 1 },
      { key: "weave", label: "Gate weave", min: 0, max: 100, step: 1 },
      { key: "leak", label: "Light leak", min: 0, max: 100, step: 1 },
    ],
  },
];
