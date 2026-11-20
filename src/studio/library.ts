// What Studio knows out of the box: format templates, hook types, the
// "why it works" chips, the shoot kit, and the seasonal calendar. Plus the
// pure helpers that turn a brief into a shot list and a shoot card.
import { newId } from "./api";
import type { Beat, Brief, Hook, Piece, Shot } from "./types";

export interface Format {
  id: string;
  name: string;
  lengthS: number;
  hint: string;
  beats: Omit<Beat, "id">[];
}

const b = (visual: string, audio: string, text = "", broll = "", setup = "Main"): Omit<Beat, "id"> => ({ visual, audio, text, broll, setup });

export const FORMATS: Format[] = [
  {
    id: "talking-head",
    name: "Talking head",
    lengthS: 35,
    hint: "Contrarian first line, three points with a punch-in each, payoff.",
    beats: [
      b("Tight shot, start mid-sentence", "The contrarian first line", "The hook in 5 words"),
      b("Medium shot", "Why it matters to them"),
      b("Punch-in", "Point 1", "1/3", "Show it"),
      b("Medium shot", "Point 2", "2/3", "Show it"),
      b("Re-hook, then punch-in", "Point 3", "3/3", "Show it"),
      b("Tight shot", "Payoff + “send this to…”", "Send this to…"),
    ],
  },
  {
    id: "tutorial",
    name: "Tutorial / GRWM",
    lengthS: 45,
    hint: "Result first, products lined up, steps in close-up, one mistake, reveal.",
    beats: [
      b("The finished result", "“This is what we're making”", "Result first", "", "Window light"),
      b("Products lined up on a clean surface", "What you need", "", "Pack shots", "Table"),
      b("Close-up, step 1", "Step 1", "1/3", "", "Close-up"),
      b("Close-up, step 2", "Step 2", "2/3", "", "Close-up"),
      b("Close-up, step 3", "Step 3", "3/3", "", "Close-up"),
      b("Medium shot", "The one mistake everyone makes", "Don't do this"),
      b("Reveal in window light", "Payoff + “save this”", "Save this", "", "Window light"),
    ],
  },
  {
    id: "before-after",
    name: "Before / after",
    lengthS: 20,
    hint: "Same tripod mark, light and white balance. Cut on the beat.",
    beats: [
      b("Before: tripod mark, same light, no filters", "", "Day 1", "", "Tripod mark"),
      b("The process, quick cuts", "", "", "Hands, product, texture", "Close-up"),
      b("After: same mark, same light, cut on the beat", "", "Day 30", "", "Tripod mark"),
      b("Split screen before | after", "", "Products in caption ↓"),
    ],
  },
  {
    id: "ugc-ad",
    name: "Product review / UGC ad",
    lengthS: 30,
    hint: "3–5 hook versions, one shared body, each hook delivered as its own clip.",
    beats: [
      b("Hook (one of the versions)", "The hook", "Hook text"),
      b("Talking to camera", "The problem"),
      b("Pack shot", "", "Product name", "Pack shot on brand colour", "Table"),
      b("Texture close-up", "Up to two approved benefits", "", "Texture swatch", "Close-up"),
      b("Result", "The result", "", "", "Window light"),
      b("Holding the product", "Brand call to action", "CTA"),
    ],
  },
  {
    id: "day-in-life",
    name: "Day in the life",
    lengthS: 40,
    hint: "Time-stamped clips of 2–4 s, a voice-over arc, one surprise.",
    beats: [
      b("07:00 — first clip", "Voice-over: where today starts", "07:00", "", "Home"),
      b("Clips of 2–4 s each", "Voice-over: the middle", "10:00 / 13:00", "Coffee, commute, work", "Out"),
      b("The surprise", "Voice-over: the twist", "", "", "Out"),
      b("Evening wind-down", "Voice-over: the payoff", "22:00", "", "Home"),
    ],
  },
  {
    id: "trend",
    name: "Trend remix",
    lengthS: 15,
    hint: "Reference link, the sound, the beat timings, your twist, and an expiry date.",
    beats: [
      b("Match the original's first beat", "The trending sound", "Your twist in words"),
      b("Your twist, on the beat", "", "", "", "Main"),
      b("Ending beat", "", ""),
    ],
  },
];

export const formatOf = (id: string | undefined) => FORMATS.find((f) => f.id === id);
export const formatName = (id: string | undefined) => formatOf(id)?.name ?? (id || "No format yet");

export const HOOK_TYPES = ["Contrarian", "Result first", "Call-out", "Number list", "Question", "Discovery", "Price", "Visual only"];

export const WHY_CHIPS = ["hook", "format", "edit", "audio", "light", "caption"];

/** What a save can be inspiration for, each with the things to like about it. */
export const TOPICS: { id: string; label: string; chips: string[]; prompt: string }[] = [
  { id: "video", label: "Video", chips: WHY_CHIPS, prompt: "The hook in the first second, the cut on the beat…" },
  { id: "photo", label: "Photo", chips: ["light", "colour", "composition", "mood", "styling"], prompt: "The low sun on the skin, the empty space on the left…" },
  { id: "colour", label: "Colour", chips: ["palette", "grade", "contrast", "skin tones", "mood"], prompt: "Warm browns, greens pulled towards olive…" },
  { id: "portfolio", label: "Portfolio", chips: ["layout", "type", "navigation", "photography", "motion"], prompt: "Huge full-bleed pictures, tiny captions, no menu…" },
  { id: "webapp", label: "Web app", chips: ["layout", "type", "interaction", "motion", "flow"], prompt: "The way the panel slides in, the quiet colours…" },
];
export const topicOf = (id: string) => TOPICS.find((t) => t.id === id) ?? null;

export const KIT = [
  { id: "battery", label: "Batteries charged" },
  { id: "cards", label: "Cards empty and in" },
  { id: "lens", label: "Lens wiped" },
  { id: "dnd", label: "Phone on Do Not Disturb" },
  { id: "fps", label: "25 or 50 fps (no flicker under Belgian 50 Hz lights)" },
  { id: "audio", label: "Mic charged and paired" },
  { id: "light", label: "Light set and white balance locked" },
];

/** About 2.3 spoken words per second of video. */
export const wordBudget = (seconds: number) => Math.round(seconds * 2.3);
export const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

export function beatsFrom(format: Format): Beat[] {
  return format.beats.map((x) => ({ ...x, id: newId() }));
}

/** The shot list from the beats, one shot per picture, grouped by setup. Ticks
 *  and framing already set on a shot with the same text are kept. */
export function shotsFrom(beats: Beat[], old: Shot[] = []): Shot[] {
  const keep = new Map(old.map((s) => [`${s.setup}|${s.what}`, s]));
  const out: Shot[] = [];
  const add = (setup: string, what: string) => {
    if (!what.trim()) return;
    const key = `${setup}|${what}`;
    if (out.some((s) => `${s.setup}|${s.what}` === key)) return;
    const prev = keep.get(key);
    out.push(prev ?? { id: newId(), setup, what, framing: "", done: false });
  };
  for (const beat of beats) {
    const setup = beat.setup.trim() || "Main";
    add(setup, beat.visual);
    for (const part of beat.broll.split(/[,;]/)) add(setup, part.trim() ? `B-roll: ${part.trim()}` : "");
  }
  // Shots typed by hand (not from a beat) stay too.
  for (const s of old) if (!out.some((o) => o.id === s.id) && !beats.some((bt) => bt.visual === s.what)) out.push(s);
  return out.sort((a, c) => a.setup.localeCompare(c.setup));
}

export function chosenHook(brief: Brief): Hook | undefined {
  return brief.hooks?.find((h) => h.chosen) ?? brief.hooks?.[0];
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A phone-sized page for the shoot: kit, shots by setup to tick, hooks, B-roll. */
export function shootCard(title: string, sub: string, items: { piece: Piece; brief: Brief }[], kit: Record<string, boolean>): string {
  const bySetup = new Map<string, { what: string; piece: string; framing: string }[]>();
  for (const { piece, brief } of items) {
    for (const s of brief.shots ?? []) {
      const list = bySetup.get(s.setup) ?? [];
      list.push({ what: s.what, piece: items.length > 1 ? piece.code || piece.title : "", framing: s.framing });
      bySetup.set(s.setup, list);
    }
  }
  const setups = [...bySetup.entries()]
    .map(
      ([setup, shots]) =>
        `<h2>${esc(setup)}</h2><ul>${shots
          .map((s) => `<li><label><input type="checkbox"> ${esc(s.what)}${s.framing ? ` <em>${esc(s.framing)}</em>` : ""}${s.piece ? ` <small>${esc(s.piece)}</small>` : ""}</label></li>`)
          .join("")}</ul>`,
    )
    .join("");
  const hooks = items
    .map(({ piece, brief }) => {
      const hs = (brief.hooks ?? []).filter((h) => h.spoken || h.text);
      if (!hs.length) return "";
      return `<h3>${esc(piece.title)}</h3><ol>${hs.map((h) => `<li>${h.chosen ? "★ " : ""}${esc(h.spoken || h.text)}${h.frame ? ` <em>(${esc(h.frame)})</em>` : ""}</li>`).join("")}</ol>`;
    })
    .join("");
  const kitList = KIT.map((k) => `<li><label><input type="checkbox"${kit[k.id] ? " checked" : ""}> ${esc(k.label)}</label></li>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;margin:0;padding:20px 18px 40px;background:#0b1626;color:#e9eff7}h1{font-size:24px;margin:0 0 4px}p.sub{color:#8a9db8;margin:0 0 18px}
h2{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#8fc5f2;margin:22px 0 8px}h3{font-size:15px;margin:14px 0 6px}ul,ol{padding-left:0;margin:0}ol{padding-left:20px}
li{list-style:none;padding:9px 0;border-bottom:1px solid #1b2e4a}ol li{list-style:decimal}label{display:flex;gap:10px;align-items:flex-start}input{width:20px;height:20px;flex:none;margin-top:1px}
em{color:#bcc9dc;font-style:normal}small{color:#8a9db8;margin-left:auto}</style></head><body>
<h1>${esc(title)}</h1><p class="sub">${esc(sub)}</p><h2>Kit</h2><ul>${kitList}</ul>${setups || "<p>No shots yet: write the beats first.</p>"}${hooks ? `<h2>Hooks</h2>${hooks}` : ""}</body></html>`;
}

// ---------------------------------------------------------------- calendar

export interface Moment {
  date: Date;
  name: string;
  lead: number;
  idea: string;
}

const nthWeekday = (year: number, month: number, weekday: number, n: number) => {
  const d = new Date(year, month, 1);
  const shift = (weekday - d.getDay() + 7) % 7;
  return new Date(year, month, 1 + shift + (n - 1) * 7);
};
const lastWeekday = (year: number, month: number, weekday: number) => {
  const d = new Date(year, month + 1, 0);
  const shift = (d.getDay() - weekday + 7) % 7;
  return new Date(year, month, d.getDate() - shift);
};
// Easter Sunday (anonymous Gregorian algorithm).
function easter(y: number): Date {
  const a = y % 19, b0 = Math.floor(y / 100), c = y % 100, d = Math.floor(b0 / 4), e = b0 % 4, f = Math.floor((b0 + 8) / 25);
  const g = Math.floor((b0 - f + 1) / 3), h = (19 * a + b0 - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}

function momentsOf(y: number): Moment[] {
  return [
    { date: new Date(y, 0, 1), name: "New year", lead: 28, idea: "Resets, routines, “this year I'm…”" },
    { date: nthWeekday(y, 0, 1, 3), name: "Blue Monday", lead: 21, idea: "Self-care, small comforts" },
    { date: new Date(y, 1, 14), name: "Valentine's Day", lead: 28, idea: "Gift guides, date-night looks" },
    { date: new Date(y, 2, 8), name: "International Women's Day", lead: 21, idea: "People who inspire you, brand values" },
    { date: easter(y), name: "Easter", lead: 28, idea: "Spring refresh, family weekend" },
    { date: nthWeekday(y, 4, 0, 2), name: "Mother's Day (Belgium)", lead: 28, idea: "Gift guides, mum's routine" },
    { date: new Date(y, 4, 15), name: "Sun-care season starts", lead: 21, idea: "SPF myths, summer skin" },
    { date: nthWeekday(y, 5, 0, 2), name: "Father's Day (Belgium)", lead: 28, idea: "Gift guides, grooming" },
    { date: new Date(y, 6, 1), name: "Summer holidays start", lead: 21, idea: "Travel kits, holiday hair" },
    { date: lastWeekday(y, 6, 5), name: "Festival season (Tomorrowland weekends)", lead: 35, idea: "Festival looks, what's in my bag" },
    { date: new Date(y, 8, 1), name: "Back to school / la rentrée", lead: 28, idea: "Routines, autumn reset" },
    { date: new Date(y, 9, 31), name: "Halloween", lead: 28, idea: "Looks, transformations" },
    { date: new Date(y, 10, 1), name: "Winter skin", lead: 14, idea: "Dry skin, cold-weather care" },
    { date: (() => { const t = nthWeekday(y, 10, 4, 4); return new Date(y, 10, t.getDate() + 1); })(), name: "Black Friday", lead: 28, idea: "Worth it / skip it, deals you'd actually buy" },
    { date: new Date(y, 11, 6), name: "Sinterklaas", lead: 28, idea: "Gift guides, Belgian traditions" },
    { date: new Date(y, 11, 25), name: "Christmas", lead: 35, idea: "Gift guides, party looks" },
    { date: new Date(y, 11, 31), name: "New Year's Eve", lead: 21, idea: "Party looks, year in review" },
  ];
}

/** Moments whose lead time has started: plan for them now. */
export function upcomingMoments(now = new Date(), within = 60): Moment[] {
  const day = 86_400_000;
  const all = [...momentsOf(now.getFullYear()), ...momentsOf(now.getFullYear() + 1)];
  return all
    .filter((m) => {
      const until = (m.date.getTime() - now.getTime()) / day;
      return until >= -1 && until <= Math.max(within, m.lead);
    })
    .sort((a, c) => a.date.getTime() - c.date.getTime())
    .slice(0, 6);
}

export const daysUntil = (d: Date | string, now = new Date()) => {
  const t = typeof d === "string" ? new Date(`${d}T12:00:00`) : d;
  return Math.round((t.getTime() - now.getTime()) / 86_400_000);
};

export const isoDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 12 ? "Good morning," : h < 18 ? "Good afternoon," : "Good evening,";
}
