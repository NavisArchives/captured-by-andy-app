// The portfolio website's projects (Andy's Archives), as the site keeps them in
// src/archive.json. Everything here is a pure edit on that document: the Archive
// screen calls one, then saves the whole file. See
// docs/superpowers/specs/2026-10-12-archive-tab-design.md.

export type Lang = "en" | "fr" | "nl";
export const LANGS: Lang[] = ["en", "fr", "nl"];
export type Words = Record<Lang, string>;

export interface ArchiveFrame {
  /** The library photo this frame is, or null for a web copy made outside the app. */
  photo: string | null;
  alt: Words;
}

export interface ArchivePart {
  from: string;
  by: string;
  title: Words;
}

export interface ArchiveProject {
  slug: string;
  title: string;
  year: string;
  notebook: boolean;
  /** A new personal series the site shows apart ("Proposals", off the homepage) until it's edited. */
  proposal?: boolean;
  mood: string | null;
  rhythm: string | null;
  focus: string | null;
  cover: string;
  kind: Words;
  place: Words;
  intro: Record<Lang, string[]>;
  credit: string[];
  link: unknown;
  film: unknown;
  /** The library album this project follows, or null. */
  album?: string | null;
  frames: Record<string, ArchiveFrame>;
  rows: string[][];
  parts: ArchivePart[] | null;
}

export interface ArchiveDoc {
  version: number;
  projects: ArchiveProject[];
}

/** Frames per row on the site: one, a pair, or a strip of three. */
export const ROW_MAX = 3;

const words = (en = ""): Words => ({ en, fr: "", nl: "" });

export function slugify(title: string): string {
  return title
    .replace(/['’]/g, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";
}

/** A library photo's key in a project: "<slug>-<last 8 of its id>". */
export function frameKey(slug: string, photoId: string): string {
  return `${slug}-${photoId.replace(/[^0-9a-z]/gi, "").slice(-8).toLowerCase()}`;
}

/** The frames in site order. */
export function order(p: ArchiveProject): string[] {
  return p.rows.flat();
}

// ---------------------------------------------------------------- the layout as a list

/** Each frame, and whether it shares a row with the one before it. */
type Slot = { key: string; joined: boolean };

function slots(p: ArchiveProject): Slot[] {
  return p.rows.flatMap((row) => row.map((key, i) => ({ key, joined: i > 0 })));
}

function rowsOf(list: Slot[]): string[][] {
  const rows: string[][] = [];
  for (const s of list) {
    const last = rows[rows.length - 1];
    if (s.joined && last && last.length < ROW_MAX) last.push(s.key);
    else rows.push([s.key]);
  }
  return rows;
}

/** Keeps the cover and every part on a frame that still exists. */
function tidy(p: ArchiveProject, list: Slot[]): ArchiveProject {
  const rows = rowsOf(list);
  const keys = rows.flat();
  const cover = keys.includes(p.cover) ? p.cover : keys[0] ?? "";
  let parts = p.parts;
  if (parts) {
    parts = parts.filter((pt) => keys.includes(pt.from));
    if (!parts.length) parts = null;
  }
  const frames = Object.fromEntries(Object.entries(p.frames).filter(([k]) => keys.includes(k) || k === cover));
  return { ...p, rows, cover, parts, frames };
}

// ---------------------------------------------------------------- edits

/** Moves a frame to `to` (its place in site order after the move), on its own row. */
export function moveFrame(p: ArchiveProject, key: string, to: number): ArchiveProject {
  const list = slots(p);
  const from = list.findIndex((s) => s.key === key);
  if (from < 0) return p;
  const [s] = list.splice(from, 1);
  // It started its row: the next frame of that row starts it now.
  if (!s.joined && list[from]?.joined) list[from] = { ...list[from], joined: false };
  const at = Math.max(0, Math.min(to, list.length));
  list.splice(at, 0, { ...s, joined: false });
  if (list[at + 1]?.joined) list[at + 1] = { ...list[at + 1], joined: false };
  return tidy(p, list);
}

/** Puts a frame in the same row as the one before it (a pair, or a strip of three). */
export function joinPrevious(p: ArchiveProject, key: string): ArchiveProject {
  const list = slots(p);
  const i = list.findIndex((s) => s.key === key);
  if (i <= 0) return p;
  const rowStart = list.slice(0, i).map((s) => s.joined).lastIndexOf(false);
  if (i - rowStart >= ROW_MAX) return p;
  list[i] = { ...list[i], joined: true };
  // What followed it in its old row now starts its own.
  if (list[i + 1]?.joined) list[i + 1] = { ...list[i + 1], joined: false };
  return tidy(p, list);
}

/** Gives a frame a row of its own; the frames after it in that row stay together. */
export function ownRow(p: ArchiveProject, key: string): ArchiveProject {
  const list = slots(p);
  const i = list.findIndex((s) => s.key === key);
  if (i < 0) return p;
  list[i] = { ...list[i], joined: false };
  if (list[i + 1]?.joined) list[i + 1] = { ...list[i + 1], joined: false };
  return tidy(p, list);
}

/** Where a dragged frame goes: into row `into` at position `at` among that
 *  row's other frames (a full row gives it a row of its own right after
 *  instead), or a row of its own before row `row` (the number of rows: at
 *  the end). Row numbers are as before the drag. */
export type Drop = { into: number; at: number } | { row: number };

export function place(p: ArchiveProject, key: string, drop: Drop): ArchiveProject {
  if (!order(p).includes(key)) return p;
  // Taken out first; emptied rows stay until the end so row numbers still match.
  const rows = p.rows.map((r) => r.filter((k) => k !== key));
  if ("row" in drop) {
    rows.splice(Math.max(0, Math.min(drop.row, rows.length)), 0, [key]);
  } else {
    const row = rows[drop.into];
    if (!row) return p;
    if (row.length >= ROW_MAX) rows.splice(drop.into + 1, 0, [key]);
    else row.splice(Math.max(0, Math.min(drop.at, row.length)), 0, key);
  }
  return withParts(p, rows.filter((r) => r.length), key);
}

/** Whether a frame dropped into row `into` would join it (false: the row is full). */
export function fits(p: ArchiveProject, key: string, into: number): boolean {
  const row = p.rows[into];
  return !!row && row.filter((k) => k !== key).length < ROW_MAX;
}

/** Moves a whole row to before row `to` (the number of rows: to the end). */
export function moveRow(p: ArchiveProject, from: number, to: number): ArchiveProject {
  if (from < 0 || from >= p.rows.length || to === from || to === from + 1) return p;
  const rows = [...p.rows];
  const [row] = rows.splice(from, 1);
  rows.splice(to > from ? to - 1 : to, 0, row);
  // Part headings stay where they were in the page, on whatever row is there now.
  const parts = p.parts?.map((pt) => {
    const at = p.rows.findIndex((r) => r[0] === pt.from);
    return at >= 0 && rows[at] ? { ...pt, from: rows[at][0] } : pt;
  }) ?? null;
  return { ...p, rows, parts };
}

/** A part heading stays where it was: when its first frame moves away it
 *  starts at the next one, and it always starts at whatever opens its row. */
function withParts(p: ArchiveProject, kept: string[][], moved: string): ArchiveProject {
  const seq = order(p);
  const next = seq[seq.indexOf(moved) + 1];
  const parts =
    p.parts?.map((pt) => {
      const from = pt.from === moved && next ? next : pt.from;
      return { ...pt, from: kept.find((r) => r.includes(from))?.[0] ?? from };
    }) ?? null;
  return { ...p, rows: kept, parts };
}

export function removeFrame(p: ArchiveProject, key: string): ArchiveProject {
  const list = slots(p);
  const i = list.findIndex((s) => s.key === key);
  if (i < 0) return p;
  const wasStart = !list[i].joined;
  list.splice(i, 1);
  if (wasStart && list[i]?.joined) list[i] = { ...list[i], joined: false };
  // A part that started here starts at the next frame instead.
  const next = list[i]?.key;
  const parts = p.parts?.map((pt) => (pt.from === key && next ? { ...pt, from: next } : pt)) ?? null;
  return tidy({ ...p, parts }, list);
}

export function setCover(p: ArchiveProject, key: string): ArchiveProject {
  return order(p).includes(key) ? { ...p, cover: key } : p;
}

/** Library photos join the end of the project, each on its own row. Already there: skipped. */
export function addPhotos(p: ArchiveProject, photoIds: string[]): ArchiveProject {
  const have = new Set(Object.values(p.frames).map((f) => f.photo).filter(Boolean));
  const add = photoIds.filter((id) => !have.has(id));
  if (!add.length) return p;
  const frames = { ...p.frames };
  const rows = [...p.rows];
  for (const id of add) {
    let key = frameKey(p.slug, id);
    while (frames[key]) key += "x";
    frames[key] = { photo: id, alt: words() };
    rows.push([key]);
  }
  return { ...p, frames, rows, cover: p.cover || rows[0][0] };
}

/** Follows the album: its new photos join the end, photos no longer in it leave.
 *  Frames that aren't library photos are left alone. */
export function followAlbum(p: ArchiveProject, albumPhotoIds: string[]): ArchiveProject {
  const inAlbum = new Set(albumPhotoIds);
  let next = p;
  for (const [key, f] of Object.entries(p.frames)) {
    if (f.photo && !inAlbum.has(f.photo)) next = removeFrame(next, key);
  }
  return addPhotos(next, albumPhotoIds);
}

/** Starts a part at this frame (as Studio Arno's "The clothes" / "The jewellery"). */
export function startPart(p: ArchiveProject, key: string, title: string, by: string): ArchiveProject {
  const keys = order(p);
  if (!keys.includes(key)) return p;
  const others = (p.parts ?? []).filter((pt) => pt.from !== key);
  const parts = [...others, { from: key, by, title: words(title) }].sort((a, b) => keys.indexOf(a.from) - keys.indexOf(b.from));
  return { ...p, parts };
}

export function endPart(p: ArchiveProject, key: string): ArchiveProject {
  const parts = (p.parts ?? []).filter((pt) => pt.from !== key);
  return { ...p, parts: parts.length ? parts : null };
}

/** A new project, empty or from an album's photos. The slug never repeats one in use. */
export function newProject(doc: ArchiveDoc, title: string, opts: { album?: string; photoIds?: string[]; notebook?: boolean } = {}): ArchiveProject {
  const used = new Set(doc.projects.map((p) => p.slug));
  let slug = slugify(title);
  for (let n = 2; used.has(slug); n++) slug = `${slugify(title)}-${n}`;
  const blank: ArchiveProject = {
    slug,
    title: title.trim(),
    year: String(new Date().getFullYear()),
    notebook: opts.notebook ?? true,
    mood: null,
    rhythm: null,
    focus: null,
    cover: "",
    kind: words(),
    place: words(),
    intro: { en: [], fr: [], nl: [] },
    credit: ["Photography: Andy Huizenga"],
    link: null,
    film: null,
    album: opts.album ?? null,
    frames: {},
    rows: [],
    parts: null,
  };
  return addPhotos(blank, opts.photoIds ?? []);
}

export function replaceProject(doc: ArchiveDoc, slug: string, p: ArchiveProject): ArchiveDoc {
  return { ...doc, projects: doc.projects.map((x) => (x.slug === slug ? p : x)) };
}

/** Moves a project to `to` in the site's order; `notebook` says which list it lands in. */
export function moveProject(doc: ArchiveDoc, slug: string, to: number, notebook?: boolean): ArchiveDoc {
  const list = [...doc.projects];
  const from = list.findIndex((p) => p.slug === slug);
  if (from < 0) return doc;
  const [p] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(to, list.length)), 0, notebook === undefined ? p : { ...p, notebook });
  // The site lists main stories first, then the notebook.
  return { ...doc, projects: [...list.filter((x) => !x.notebook), ...list.filter((x) => x.notebook)] };
}

/** The frames that need rendering before the site can be updated. */
export function libraryFrames(doc: ArchiveDoc): { key: string; photo: string; slug: string }[] {
  return doc.projects.flatMap((p) =>
    order(p)
      .filter((k) => p.frames[k]?.photo)
      .map((k) => ({ key: k, photo: p.frames[k].photo as string, slug: p.slug })),
  );
}
