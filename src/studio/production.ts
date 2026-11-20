// Production's logic without the screens: the six steps, 00_PLAN/project.md
// (the whole project in one file Claude reads and writes back), and reading a
// Final Cut edit (FCPXML) to show what changed.
import { STEPS, type Board, type Brief, type CutClip, type CutRead, type Family, type Piece, type Pillar, type Save, type StepId, type StepStatus } from "./types";

// ------------------------------------------------------------------ steps

export const statusOf = (brief: Brief, id: StepId): StepStatus => brief.steps?.[id] ?? "todo";

/** Whose turn it is: the first step with Andy or with Claude, else the first one not done. */
export function turnOf(brief: Brief): { step: (typeof STEPS)[number]; status: StepStatus } | null {
  for (const s of STEPS) {
    const st = statusOf(brief, s.id);
    if (st === "andy" || st === "claude") return { step: s, status: st };
  }
  const next = STEPS.find((s) => statusOf(brief, s.id) !== "done");
  return next ? { step: next, status: statusOf(brief, next.id) } : null;
}

/** What Andy says in a Claude session to have a step done. */
export const askClaude = (piece: Piece, step: StepId) => {
  const n = STEPS.findIndex((s) => s.id === step) + 1;
  return `Work on ${piece.code || piece.title} (${piece.title}), step ${n} (${STEPS[n - 1].label}): read 00_PLAN/project.md in its folder${piece.folder ? ` (${piece.folder})` : ""}, do the step, write your results into the data block and set the step to "andy".`;
};

// ------------------------------------------------------------------ project.md

/** A short fingerprint of the project's data, to notice changes made outside the app. */
export function hashOf(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** The brief as it's stored in the file: everything but the fingerprint. */
export function fileData(brief: Brief): Brief {
  const { fileHash: _, ...rest } = brief;
  void _;
  return rest;
}

export const dataHash = (brief: Brief) => hashOf(JSON.stringify(fileData(brief)));

const FENCE = "```json project-data";

/** The data block of a project.md (null when there's none or it doesn't parse). */
export function readData(md: string): Brief | null {
  const at = md.lastIndexOf(FENCE);
  if (at < 0) return null;
  const start = md.indexOf("\n", at) + 1;
  const end = md.indexOf("\n```", start);
  if (end < 0) return null;
  try {
    const v = JSON.parse(md.slice(start, end)) as { brief?: Brief };
    return v && typeof v.brief === "object" && v.brief ? v.brief : null;
  } catch {
    return null;
  }
}

export interface MdContext {
  pillar?: Pillar;
  family?: Family;
  saves: Save[];
  boards: Board[];
  /** Photo id → file name, for the footage. */
  clipNames: Record<string, string>;
  clipIds: string[];
}

const line = (label: string, v: string | number | undefined | null) => (v === undefined || v === null || v === "" ? "" : `- ${label}: ${String(v).replace(/\n+/g, " ")}\n`);
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
const STATUS_WORD: Record<StepStatus, string> = { todo: "to do", andy: "with Andy", claude: "with Claude", done: "done" };

/** The whole project in one Markdown file, readable by Andy and by Claude. */
export function projectMarkdown(piece: Piece, brief: Brief, ctx: MdContext): string {
  const data = fileData(brief);
  let md = `# ${piece.code ? `${piece.code} · ` : ""}${piece.title}\n\n`;
  md += [ctx.pillar ? `Pillar: ${ctx.pillar.name}` : "", ctx.family ? `Series: ${ctx.family.name}` : "", `Stage: ${piece.stage}`, piece.plannedDate ? `Posting: ${piece.plannedDate}` : ""].filter(Boolean).join(" · ");
  md += `\n\n> Written by Captured by Andy every time the project is saved. For Claude: to work on a step, change the JSON in the "Data" block at the end (keep its shape),\n> then set that step to "andy" in \`steps\`. The app loads the block back the next time the project is opened or the window comes back into focus.\n> Everything above the Data block is a summary and is rewritten from it.\n\n`;

  md += "## Steps\n\n";
  STEPS.forEach((s, i) => (md += `${i + 1}. ${s.label}: ${STATUS_WORD[statusOf(brief, s.id)]}\n`));

  md += `\n## 1. Idea & script\n\n`;
  md += line("Goal", brief.goal) + line("For whom", brief.audience) + line("Call to action", brief.cta) + line("Length (s)", brief.lengthS) + line("Format", brief.template ?? piece.format);
  const hooks = brief.hooks ?? [];
  if (hooks.length) {
    md += `\n### Hooks\n\n`;
    hooks.forEach((h) => (md += `- ${h.chosen ? "**(chosen)** " : ""}${h.spoken || "…"}${h.text ? ` · on screen: ${h.text}` : ""}${h.frame ? ` · first frame: ${h.frame}` : ""}\n`));
  }
  const beats = brief.beats ?? [];
  if (beats.length) {
    md += `\n### Beats\n\n| # | What we see | What's said | On screen | B-roll |\n|---|---|---|---|---|\n`;
    const cell = (s: string) => (s || "").replace(/\|/g, "/").replace(/\n+/g, " ");
    beats.forEach((b, i) => (md += `| ${i + 1} | ${cell(b.visual)} | ${cell(b.audio)} | ${cell(b.text)} | ${cell(b.broll)} |\n`));
  }
  if (piece.notes.trim()) md += `\n### Notes\n\n${piece.notes.trim()}\n`;

  md += `\n## 2. Inspiration & style\n\n`;
  const inspo = brief.inspo ?? [];
  if (!inspo.length) md += "Nothing linked yet.\n";
  for (const l of inspo) {
    if (l.boardId) {
      const b = ctx.boards.find((x) => x.id === l.boardId);
      const inside = ctx.saves.filter((s) => s.boardId === l.boardId);
      md += `- Board **${b?.title ?? "(gone)"}** (${inside.length} saves)${l.note ? `: ${l.note}` : ""}\n`;
      for (const s of inside.slice(0, 20)) md += `  - ${s.title || s.url || "untitled"}${s.url ? ` <${s.url}>` : ""}\n`;
    } else {
      const s = ctx.saves.find((x) => x.id === l.saveId);
      md += `- **${s?.title || s?.url || "(gone)"}**${s ? ` (${[s.platform, s.author].filter(Boolean).join(", ")})` : ""}${s?.url ? ` <${s.url}>` : ""}\n`;
      if (l.note) md += `  - Andy likes: ${l.note.replace(/\n+/g, " ")}\n`;
      if (s?.why) md += `  - Saved because: ${s.why.replace(/\n+/g, " ")}\n`;
      if (s?.transcript) md += `  - Transcript: ${cut(s.transcript.replace(/\s+/g, " "), 1500)}\n`;
    }
  }
  const st = brief.style ?? {};
  md += `\n### Style sheet\n\n`;
  md += line("Pace", st.pace) + line("Cut length", st.cutLength) + line("Slow moments", st.slowMoments) + line("Type", st.type) + line("Colour", st.colour) + line("Music mood", st.musicMood) + line("Notes", st.notes);
  if (!Object.values(st).some(Boolean)) md += "Not filled in yet.\n";

  md += `\n## 3. Footage\n\n`;
  if (!ctx.clipIds.length) md += "No clips attached yet.\n";
  for (const id of ctx.clipIds) {
    const m = brief.footage?.[id];
    md += `- ${ctx.clipNames[id] ?? id}${m?.level ? " · needs levelling (Gyroflow)" : ""}${m?.picks ? ` · picks: ${m.picks.replace(/\n+/g, " ")}` : ""}\n`;
  }

  md += `\n## 4. Sound\n\n`;
  const sounds = brief.sounds ?? [];
  if (!sounds.length) md += "No music or sound effects yet.\n";
  for (const s of sounds) md += `- ${s.kind === "sfx" ? "Sound effect" : "Music"}: ${s.file.split("/").pop()} · from ${s.source || "?"} · ${s.licensed ? "licensed" : "**NOT licensed**"}\n`;

  md += `\n## 5. Cut\n\n`;
  md += line("Final Cut project (FCPXML)", brief.edit?.fcpxml);
  const r = brief.edit?.lastRead;
  if (r) md += `- Last edit read back: ${r.project}, ${r.duration.toFixed(1)} s, ${r.clips.length} clips (${r.path})\n`;
  if (!brief.edit?.fcpxml && !r) md += "Nothing yet.\n";

  md += `\n## 6. Finish & post\n\n`;
  md += line("Export", brief.exportPath) + line("Caption", brief.caption) + line("Hashtags", brief.hashtags);
  if (!brief.exportPath && !brief.caption) md += "Nothing yet.\n";

  md += `\n## Data\n\n${FENCE}\n${JSON.stringify({ pieceId: piece.id, brief: data }, null, 2)}\n\`\`\`\n`;
  return md;
}

// ------------------------------------------------------------------ Final Cut XML

/** FCPXML times: "3003/30000s", "12s", "0s" (and "2.5s"). */
export function seconds(t: string | null | undefined): number {
  if (!t) return 0;
  const m = /^(-?\d+(?:\.\d+)?)(?:\/(\d+))?s$/.exec(t.trim());
  if (!m) return 0;
  return Number(m[1]) / (m[2] ? Number(m[2]) : 1);
}

const CLIP_TAGS = new Set(["asset-clip", "clip", "ref-clip", "mc-clip", "sync-clip", "video", "audio", "title", "gap"]);

/** The first project's timeline in an FCPXML: its clips in order, connected clips with their lane. */
export function readCut(xml: string, path: string): CutRead {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("That file isn't readable XML");
  const names = new Map<string, string>();
  doc.querySelectorAll("resources > *[id]").forEach((r) => names.set(r.getAttribute("id")!, r.getAttribute("name") ?? ""));
  const project = doc.querySelector("project");
  const sequence = (project ?? doc).querySelector("sequence");
  const spine = sequence?.querySelector(":scope > spine");
  if (!sequence || !spine) throw new Error("No timeline found in that file");
  const clips: CutClip[] = [];
  const walk = (parent: Element, base: number, parentStart: number, lane: number) => {
    for (const el of Array.from(parent.children)) {
      const tag = el.tagName;
      if (tag === "spine") {
        // A secondary storyline: its own clips, on its lane.
        walk(el, base + seconds(el.getAttribute("offset")) - parentStart, 0, Number(el.getAttribute("lane") ?? lane));
        continue;
      }
      if (!CLIP_TAGS.has(tag)) continue;
      const offset = seconds(el.getAttribute("offset"));
      const start = seconds(el.getAttribute("start"));
      const at = base + offset - parentStart;
      const myLane = el.hasAttribute("lane") ? Number(el.getAttribute("lane")) : lane;
      if (tag !== "gap") {
        clips.push({
          name: el.getAttribute("name") || names.get(el.getAttribute("ref") ?? "") || tag,
          at,
          duration: seconds(el.getAttribute("duration")),
          from: start,
          lane: myLane,
          kind: tag,
        });
      }
      // Connected clips sit inside, timed against this clip's own start.
      walk(el, at, start, myLane);
    }
  };
  walk(spine, 0, 0, 0);
  clips.sort((a, b) => a.lane - b.lane || a.at - b.at);
  const main = clips.filter((c) => c.lane === 0);
  const end = Math.max(seconds(sequence.getAttribute("duration")), ...main.map((c) => c.at + c.duration), 0);
  return { path, readMs: Date.now(), project: project?.getAttribute("name") ?? path.split("/").pop() ?? "Project", duration: end, clips };
}

export interface CutChange {
  kind: "added" | "removed" | "trimmed" | "moved";
  name: string;
  detail: string;
}

/** What changed from one edit to the next, clip by clip (by name and source point). */
export function compareCuts(before: CutRead, after: CutRead): { changes: CutChange[]; durationDelta: number } {
  const key = (c: CutClip) => `${c.name}@${c.from.toFixed(1)}`;
  const was = new Map(before.clips.map((c) => [key(c), c]));
  const now = new Map(after.clips.map((c) => [key(c), c]));
  const changes: CutChange[] = [];
  const f = (s: number) => `${s.toFixed(1)} s`;
  for (const [k, c] of now) {
    const old = was.get(k);
    if (!old) changes.push({ kind: "added", name: c.name, detail: `${f(c.duration)} at ${f(c.at)}` });
    else if (Math.abs(old.duration - c.duration) > 0.04) changes.push({ kind: "trimmed", name: c.name, detail: `${f(old.duration)} → ${f(c.duration)}` });
    else if (Math.abs(old.at - c.at) > 0.04) changes.push({ kind: "moved", name: c.name, detail: `${f(old.at)} → ${f(c.at)}` });
  }
  for (const [k, c] of was) if (!now.has(k)) changes.push({ kind: "removed", name: c.name, detail: `was ${f(c.duration)} at ${f(c.at)}` });
  return { changes, durationDelta: after.duration - before.duration };
}
