// Studio's Rust commands in memory, so the preview can show every Studio
// screen with example data. The web app (src/web) runs on the same code with
// Andy's real rows and saves through `studioHooks`. Not part of the Mac build.
import { emit } from "@tauri-apps/api/event";

type Row = Record<string, unknown>;
type A = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const DEFAULTS: Record<string, Row> = {
  pillars: { name: "", position: 0, folder: "" },
  families: { pillarId: null, kind: "series", name: "", code: "", client: "", folder: "", archived: 0 },
  ideas: { title: "", hook: "", format: "", pillarId: null, familyId: null, platforms: "", status: "inbox", scoreHook: null, scoreSend: null, scoreFit: null, scoreEase: null, notes: "", source: "typed", deadline: null, pieceId: null },
  pieces: { ideaId: null, pillarId: null, familyId: null, title: "", episode: null, code: "", format: "", platforms: "", stage: "planned", parked: 0, waitingBrand: 0, folder: null, brief: "{}", shootDayId: null, plannedDate: null, isPaid: 0, brandJobId: null, disclosure: "{}", posts: "[]", notes: "" },
  saves: { kind: "link", platform: "web", url: "", urlKey: "", title: "", author: "", filePath: null, thumb: null, why: "", chips: "", tags: "", autoLabels: "", ocrText: "", transcript: "", status: "inbox", pillarId: null, capturedVia: "paste", analysedMs: null, linkOk: null, checkedMs: null, resurfacedMs: null, resurfaceCount: 0, boardId: null },
  shootDays: { date: "", title: "", location: "", notes: "" },
  brandJobs: { client: "", campaign: "", familyId: null, brief: "", deliverables: "", reviewDate: null, liveDate: null, revisionsAllowed: null, revisionsUsed: 0, rights: "", rightsEnd: null, exclusivityEnd: null, paidAdsEnd: null, fee: "", invoiceNo: "", invoiceStatus: "none", paidDate: null, notes: "", invoiceSentDate: null, amount: null, currency: null },
  reviews: { pieceId: "", platform: "", views: null, watchTime: null, skipRate: null, sends: null, saves: null, follows: null, learning: "" },
  watch: { platform: "instagram", handle: "", notes: "", last: "", checkedMs: null },
  boards: { title: "", notes: "", client: "", pillarId: null, familyId: null },
};
export const T: Record<string, Row[]> = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, []]));
export const LINKS: Record<string, [string, string][]> = { saveIdea: [], pieceMedia: [] };
/** What the web app listens to, to keep its rows; nothing in the preview. */
export const studioHooks = {
  root: "/Volumes/Work/STUDIO",
  saved: (_list: string, _row: Row) => {},
  deleted: (_list: string, _id: string) => {},
  linked: (_kind: string, _a: string, _b: string, _on: boolean) => {},
};
/** A time-ordered id like the Mac's (UUID v7), so rows made anywhere never clash. */
const nid = () => {
  const hex = Date.now().toString(16).padStart(12, "0");
  const r = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7${r.slice(0, 3)}-${((parseInt(r[3], 16) & 3) | 8).toString(16)}${r.slice(4, 7)}-${r.slice(7, 19)}`;
};
const changed = () => void emit("studio-changed", null);

/** Files written into pieces' 00_PLAN folders (project.md); window.__plans lets a test play Claude. */
const PLANS = new Map<string, { contents: string; modifiedMs: number }>();
(window as unknown as { __plans: typeof PLANS }).__plans = PLANS;
const fcpxml = (clips: [string, number, number, number][]) =>
  `<?xml version="1.0" encoding="UTF-8"?><fcpxml version="1.11"><resources><format id="r1" frameDuration="1/25s"/>${clips.map(([n], i) => `<asset id="a${i}" name="${n}" start="0s" duration="60s"/>`).join("")}</resources><library><event name="Leaving Limbo"><project name="Leaving Limbo 01"><sequence format="r1" duration="${clips.reduce((t, c) => t + c[3], 0)}s"><spine>${clips
    .map(([, at, from, d], i) => `<asset-clip ref="a${i}" offset="${at}s" start="${from}s" duration="${d}s"/>`)
    .join("")}</spine></sequence></project></event></library></fcpxml>`;
const FCPXML_DRAFT = fcpxml([["C1269.MP4", 0, 10, 4], ["C1270.MP4", 4, 2, 6], ["C1275.MP4", 10, 0, 5]]);
const FCPXML_CUT = fcpxml([["C1269.MP4", 0, 10, 3], ["C1275.MP4", 3, 0, 5], ["C1281.MP4", 8, 4, 2.5]]);
const day = (d: number) => {
  const t = new Date(Date.now() + d * 86_400_000);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};

function put(list: string, id: string | null, values: Row): Row {
  const rows = T[list];
  const found = id ? rows.find((r) => r.id === id) : undefined;
  const t = Date.now();
  if (found) {
    Object.assign(found, values, { updatedMs: t }, list === "ideas" ? { touchedMs: t } : {});
    studioHooks.saved(list, found);
    return { ...found };
  }
  const row: Row = { id: id ?? nid(), ...DEFAULTS[list], ...values, createdMs: t, updatedMs: t, ...(list === "ideas" ? { touchedMs: t } : {}) };
  rows.unshift(row);
  studioHooks.saved(list, row);
  return { ...row };
}

const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "untitled";

function folderOf(piece: Row): string {
  const fam = T.families.find((f) => f.id === piece.familyId);
  const pil = T.pillars.find((p) => p.id === piece.pillarId);
  return `${studioHooks.root}/${pil?.folder || "01_PILLAR"}/${fam?.folder || "S00_SINGLES"}/${day(0)}_${String(piece.code).toUpperCase()}_${slug(String(piece.title))}`;
}

export function seed(pic: (i: number) => string) {
  const skin = put("pillars", null, { name: "Skin", position: 0, folder: "01_SKIN" });
  const hair = put("pillars", null, { name: "Hair", position: 1, folder: "02_HAIR" });
  const life = put("pillars", null, { name: "Life in Belgium", position: 2, folder: "03_LIFE-IN-BELGIUM" });
  const braids = put("families", null, { pillarId: hair.id, kind: "series", name: "Braids, start to finish", code: "S01", folder: "S01_BRAIDS-START-TO-FINISH" });
  const campaign = put("families", null, { pillarId: skin.id, kind: "campaign", name: "Autumn skin", client: "Example brand", code: "EXAMPLE", folder: "EXAMPLE-BRAND_2026-10_AUTUMN-SKIN" });
  const singles = put("families", null, { pillarId: life.id, kind: "singles", name: "Singles", folder: "S00_SINGLES" });
  const job = put("brandJobs", null, { client: "Example brand", campaign: "Autumn skin", familyId: campaign.id, deliverables: "2 × 30 s Reels with 3 hook versions each, raw footage", reviewDate: day(5), liveDate: day(12), revisionsAllowed: 2, revisionsUsed: 1, rights: "Organic + paid ads, Belgium, 3 months", rightsEnd: day(10), invoiceStatus: "sent", invoiceNo: "2026-041", invoiceSentDate: day(-38), amount: 1800, currency: "EUR" });
  const shoot = put("shootDays", null, { date: day(3), location: "Living room, window light", title: "" });
  const brief = {
    template: "talking-head",
    lengthS: 35,
    goal: "Braids that last a week",
    hooks: [
      { id: "h1", spoken: "Your braids don't last because of one step you skip", text: "The step you skip", frame: "Close-up of frizzy ends", type: "Contrarian", chosen: true },
      { id: "h2", spoken: "Week-long braids in 20 minutes", text: "7 days, 20 min", frame: "Finished braids", type: "Result first", chosen: false },
    ],
    beats: [
      { id: "b1", visual: "Tight shot, mid-sentence", audio: "Your braids don't last because of one step you skip.", text: "The step you skip", broll: "", setup: "Mirror" },
      { id: "b2", visual: "Products lined up", audio: "You need three things.", text: "", broll: "Pack shots, comb", setup: "Table" },
      { id: "b3", visual: "Close-up, sectioning", audio: "Section while the hair is still damp.", text: "1/3", broll: "", setup: "Mirror" },
    ],
    shots: [],
  };
  const p1 = put("pieces", null, { title: "Braids that last a week", pillarId: hair.id, familyId: braids.id, episode: 3, code: "S01-03", format: "talking-head", platforms: "tiktok,instagram", stage: "planned", shootDayId: shoot.id, plannedDate: day(6), brief: JSON.stringify(brief) });
  p1.folder = folderOf(p1);
  put("pieces", p1.id as string, { folder: p1.folder });
  put("pieces", null, { title: "Box braids, part 2", pillarId: hair.id, familyId: braids.id, episode: 2, code: "S01-02", stage: "editing", platforms: "tiktok,instagram", plannedDate: day(2) });
  put("pieces", null, { title: "Three-step autumn routine", pillarId: skin.id, familyId: campaign.id, episode: 1, code: "EXAMPLE-01", stage: "shot", isPaid: 1, brandJobId: job.id, platforms: "instagram" });
  put("pieces", null, { title: "A Sunday in Ghent", pillarId: life.id, familyId: singles.id, code: "single", stage: "posted", platforms: "tiktok" });
  const ideas = [
    { title: "SPF myths I believed for years", hook: "I was putting sunscreen on wrong for ten years", pillarId: skin.id, status: "inbox", format: "talking-head" },
    { title: "Braids for short hair", hook: "", pillarId: hair.id, status: "inbox" },
    { title: "What €20 buys at the Sunday market", hook: "Twenty euros, one market, go", pillarId: life.id, status: "keep", scoreHook: 4, scoreSend: 4, scoreFit: 5, scoreEase: 4, format: "day-in-life" },
    { title: "Night routine, honest version", hook: "", pillarId: skin.id, status: "maybe", scoreHook: 3, scoreSend: 2, scoreFit: 4, scoreEase: 3 },
    { title: "Festival hair that survives the rain", hook: "", pillarId: hair.id, status: "inbox", deadline: day(40) },
  ];
  for (const i of ideas) put("ideas", null, { ...i, platforms: "tiktok,instagram" });
  const saves = [
    { platform: "tiktok", title: "The braid trick nobody talks about", author: "example.creator", why: "Hook in the first frame, result shown before the how", chips: "hook,format", status: "inbox" },
    { platform: "instagram", title: "Instagram reel", author: "", why: "", status: "inbox", url: "https://instagram.com/reel/EXAMPLE1" },
    { platform: "youtube", title: "3 skincare myths in 30 seconds", author: "Example Channel", why: "Numbered list, cut on every beat", chips: "edit,format", status: "library" },
    { platform: "file", kind: "image", title: "Screenshot 2026-09-29 at 21.14.02", why: "Colour palette for the autumn series", chips: "light", status: "library", autoLabels: "hair, person, indoor", ocrText: "WEEK-LONG BRAIDS\nin 20 minutes" },
    { platform: "tiktok", title: "Morning routine in one take", author: "another.creator", why: "One continuous take feels honest", chips: "edit", status: "library" },
    { platform: "file", kind: "video", title: "ScreenRecording_09-28-2026 18-02-11", why: "", status: "inbox" },
  ];
  saves.forEach((s, i) => put("saves", null, { kind: "link", ...s, thumb: pic(i), createdMs: Date.now() - i * 20 * 86_400_000 }));
  for (const r of T.saves) r.createdMs = Date.now() - T.saves.indexOf(r) * 9 * 86_400_000;
}

function summary() {
  const today = day(0);
  const week = day(7);
  return {
    pillars: T.pillars.length,
    ideasInbox: T.ideas.filter((i) => i.status === "inbox").length,
    ideasKept: T.ideas.filter((i) => i.status === "keep" || i.status === "maybe").length,
    toFilm: T.pieces.filter((p) => p.stage === "planned" && !p.parked).length,
    inProgress: T.pieces.filter((p) => (p.stage === "shot" || p.stage === "editing") && !p.parked).length,
    ready: T.pieces.filter((p) => p.stage === "ready").length,
    postingThisWeek: T.pieces.filter((p) => p.plannedDate && String(p.plannedDate) >= today && String(p.plannedDate) <= week && p.stage !== "posted").length,
    reviewsDue: 0,
    savesInbox: T.saves.filter((s) => s.status === "inbox").length,
    brandAlerts: 1,
    root: studioHooks.root,
  };
}

let heard = "";
export function studioMock(cmd: string, a: A): { value: unknown } | undefined {
  if (cmd === "studio_list" && a.list === "pieces" && typeof location !== "undefined" && new URLSearchParams(location.search).get("worst") === "empty") return { value: [] };
  const v = (value: unknown) => ({ value });
  switch (cmd) {
    case "studio_list": {
      const f = (a.filter ?? {}) as Row;
      return v(T[a.list].filter((r) => Object.entries(f).every(([k, x]) => r[k] === x)).map((r) => ({ ...r })));
    }
    case "studio_get":
      return v(T[a.list].find((r) => r.id === a.id) ?? null);
    case "studio_save": {
      const row = put(a.list, a.id, a.values);
      changed();
      return v(row);
    }
    case "studio_import_knowledge":
      return v({ notes: 25, added: 0, updated: 25, skipped: [] });
    case "studio_delete":
      T[a.list] = T[a.list].filter((r) => r.id !== a.id);
      studioHooks.deleted(a.list, a.id);
      // As the database does: a removed board lets go of its saves.
      if (a.list === "boards") for (const r of T.saves) if (r.boardId === a.id) put("saves", r.id as string, { boardId: null });
      changed();
      return v(null);
    case "studio_link": {
      const list = LINKS[a.kind];
      LINKS[a.kind] = list.filter(([x, y]) => !(x === a.a && y === a.b));
      if (a.on) LINKS[a.kind].push([a.a, a.b]);
      studioHooks.linked(a.kind, a.a, a.b, !!a.on);
      changed();
      return v(null);
    }
    case "studio_linked":
      return v(LINKS[a.kind].filter(([x, y]) => (a.side === "a" ? x === a.id : y === a.id)).map(([x, y]) => (a.side === "a" ? y : x)));
    case "studio_root":
      return v(studioHooks.root);
    case "studio_summary":
      return v(summary());
    case "studio_greenlight": {
      const idea = T.ideas.find((i) => i.id === a.ideaId)!;
      let fam = T.families.find((f) => f.id === (a.familyId ?? idea.familyId));
      if (!fam) fam = T.families.find((f) => f.pillarId === idea.pillarId && f.kind === "singles") ?? (put("families", null, { pillarId: idea.pillarId, kind: "singles", name: "Singles", folder: "S00_SINGLES" }) as Row);
      const ep = T.pieces.filter((p) => p.familyId === fam!.id).length + 1;
      const code = fam.kind === "singles" ? "single" : `${fam.code}-${String(ep).padStart(2, "0")}`;
      const piece = put("pieces", null, { ideaId: idea.id, pillarId: fam.pillarId, familyId: fam.id, title: idea.title, episode: ep, code, format: idea.format, platforms: idea.platforms, brief: JSON.stringify(idea.hook ? { hooks: [{ id: "h", spoken: idea.hook, text: "", frame: "", type: "", chosen: true }] } : {}) });
      const folder = folderOf(piece);
      put("pieces", piece.id as string, { folder });
      put("ideas", idea.id as string, { status: "greenlit", pieceId: piece.id });
      changed();
      return v({ ...piece, folder });
    }
    case "studio_piece_folder":
      return v(T.pieces.find((p) => p.id === a.id)?.folder ?? `${studioHooks.root}/00_INBOX`);
    case "studio_family_folder":
      return v(`${studioHooks.root}/${T.families.find((f) => f.id === a.id)?.folder ?? ""}`);
    case "studio_set_stage": {
      const row = put("pieces", a.id, { stage: a.stage });
      changed();
      return v(row);
    }
    case "studio_park_stale":
      return v(0);
    case "studio_add_link": {
      const url = String(a.url);
      const existing = T.saves.find((s) => s.url === url);
      if (existing) return v({ ...existing, existing: true });
      const platform = url.includes("tiktok") ? "tiktok" : url.includes("instagram") ? "instagram" : url.includes("youtu") ? "youtube" : "web";
      const row = put("saves", null, { kind: "link", platform, url, title: platform === "instagram" ? "" : "Saved from the preview", author: platform === "tiktok" ? "someone" : "", capturedVia: a.via });
      changed();
      return v(row);
    }
    case "studio_add_bytes":
    case "studio_add_paths": {
      const row = put("saves", null, { kind: "image", platform: "file", title: "Dropped in the preview", filePath: `${studioHooks.root}/80_INSPIRATION/dropped.png` });
      changed();
      return v(cmd === "studio_add_paths" ? [row] : row);
    }
    case "studio_ingest":
    case "studio_pending_captures":
      return v([]);
    case "studio_refresh_preview":
      return v(T.saves.find((s) => s.id === a.id));
    case "studio_import":
      return v({ added: 0, already: 0 });
    case "studio_trends":
      return v([
        { title: "Example trend one", traffic: "20K+", news: ["A headline about it"], link: "" },
        { title: "Hair braiding championship", traffic: "5K+", news: [], link: "" },
        { title: "Another search", traffic: "2K+", news: ["One more headline"], link: "" },
      ]);
    case "studio_youtube":
      throw "Add a YouTube API key in Settings › Studio first (free at console.cloud.google.com).";
    case "studio_watch_check":
      throw "Add your Instagram access token and account id in Settings › Studio first.";
    case "studio_similar":
      return v({ saves: T.saves.slice(1, 3).map((s) => s.id), photos: [] });
    case "studio_write_plan": {
      const path = a.pieceId ? `${studioHooks.root}/${a.pieceId}/00_PLAN/${a.name}` : `${studioHooks.root}/_CARDS/${a.name}`;
      PLANS.set(path, { contents: String(a.contents), modifiedMs: Date.now() });
      return v(path);
    }
    case "studio_read_plan": {
      const path = `${studioHooks.root}/${a.pieceId}/00_PLAN/${a.name}`;
      const f = PLANS.get(path);
      return v(f ? { path, ...f } : null);
    }
    case "studio_piece_files":
      return v([
        { path: `${studioHooks.root}/${a.id}/04_EXPORTS/My cut.fcpxml`, name: "My cut.fcpxml", folder: "04_EXPORTS", size: 9000, modifiedMs: Date.now() - 3600e3 },
        { path: `${studioHooks.root}/${a.id}/02_AUDIO/Ambient piano.wav`, name: "Ambient piano.wav", folder: "02_AUDIO", size: 4e7, modifiedMs: Date.now() - 7200e3 },
        { path: `${studioHooks.root}/${a.id}/02_AUDIO/whoosh sfx.wav`, name: "whoosh sfx.wav", folder: "02_AUDIO", size: 2e5, modifiedMs: Date.now() - 7300e3 },
        { path: `${studioHooks.root}/${a.id}/Draft 1.fcpxmld`, name: "Draft 1.fcpxmld", folder: "", size: 0, modifiedMs: Date.now() - 86400e3 },
      ]);
    case "studio_read_fcpxml":
      return v(String(a.path).includes("Draft") ? FCPXML_DRAFT : FCPXML_CUT);
    case "studio_open_in_final_cut":
      return v(null);
    case "studio_mark_posted": {
      const p = T.pieces.find((x) => x.id === a.id)!;
      const posts = JSON.parse(String(p.posts || "[]"));
      posts.push({ platform: a.platform, url: a.url, at: new Date().toISOString(), file: a.file ?? "" });
      const row = put("pieces", a.id, { posts: JSON.stringify(posts), stage: "posted" });
      changed();
      return v(row);
    }
    case "studio_check_export":
      return v({ path: a.path, seconds: 34.5, width: 1080, height: 1920, megabytes: 61, notes: [] });
    case "studio_open_capcut":
    case "studio_open_folder":
      return v(null);
    case "dictate_start":
      heard = "";
      ["Braids", "Braids for people", "Braids for people with very short hair, step by step."].forEach((t, i) =>
        setTimeout(() => {
          heard = t;
          void emit("dictation", { text: t, listening: true, problem: null });
        }, 600 * (i + 1)),
      );
      return v(null);
    case "dictate_stop":
      return v(heard);
    default:
      return undefined;
  }
}
