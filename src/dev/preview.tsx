// Dev-only: the real UI in a plain browser against Tauri's IPC mock, with a
// generated library (painted stand-in photos, synthetic looks). Not part of
// the app build: only index.html is built.
import React from "react";
import ReactDOM from "react-dom/client";
import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
// Preview must run in a clean checkout without Andy's private portfolio.
const archiveFile = JSON.stringify({ version: 1, projects: [] });
const siteFile = JSON.stringify({ version: 1, brands: [], brandFilms: [], brandList: [], motion: [] });
const siteMedia = "{}";
import { assets } from "../api";
import App from "../App";
import { applyPalette, currentPalette } from "../theme";
import { seed as seedStudio, studioMock } from "./studioMock";
import hashes from "./thumbhashes.json";
import { NO_ADJUSTMENTS, type Account, type Album, type Look, type PhotoRow, type Post, type Query, type ReviewState, type Tag } from "../types";

const TOTAL = 2400;
const now = Date.now();
const base = Date.parse("2026-09-21T21:40:00");
const id = (prefix: number, i: number) => `0199f0c2-${String(prefix).padStart(4, "0")}-7000-8000-${String(i).padStart(12, "0")}`;
const idx = (pid: string) => Number(pid.slice(-12));
/** Clean up: rejected photos split over three trips, and their marks. */
const cleanupMarks = new Map<string, string>();
const cleanupHistory: Record<string, unknown>[] = [{ batch: "b1", trip: "/Drive/CAMERA/NEPAL", name: "NEPAL", deletedMs: Date.now() - 3 * 86400000, photos: 212, bytes: 5.1e9, restored: false, phoneFound: 40, phoneDeleted: 0, phoneChecked: true }];
const cleanupSets = (p: string) => {
  const i = idx(p);
  return [i % 4 === 1 ? "copy" : i % 4 === 2 ? "scene" : null, i % 5 === 0 ? "soft" : null, i % 11 === 0 ? "utility" : null].filter(Boolean);
};
const cleanupIds = (trip: number) => [...review.entries()].filter(([i, r]) => r === "rejected" && Math.floor(i / 3) % 3 === trip).map(([i]) => id(1, i));

// ---------------------------------------------------------------- painted stand-in photos
const SCENES = [
  ["#f3c08a", "#c2704a", "#2f2420"], ["#1b2440", "#3a4d7c", "#d58a52"], ["#a9c28f", "#4f6b45", "#1d271b"],
  ["#d6e6ec", "#6f9fb3", "#26414e"], ["#e4ded2", "#8d877d", "#2a2825"], ["#f5d2ac", "#d78e6f", "#5e3431"],
  ["#0f131c", "#28334c", "#e3b35c"], ["#cdb99b", "#8e7a5e", "#352c24"],
];
async function paint(i: number, w: number, h: number): Promise<string> {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const [a, b, d] = SCENES[i % SCENES.length];
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, a);
  sky.addColorStop(0.62, b);
  sky.addColorStop(1, d);
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  g.fillStyle = "rgba(255,240,210,0.85)";
  g.beginPath();
  g.arc(w * (0.25 + 0.5 * ((i * 37) % 10) / 10), h * 0.34, h * 0.07, 0, Math.PI * 2);
  g.fill();
  for (let k = 0; k < 3; k++) {
    g.fillStyle = `rgba(20,24,22,${0.35 + k * 0.2})`;
    g.beginPath();
    g.moveTo(0, h * (0.62 + k * 0.1));
    for (let x = 0; x <= w; x += w / 12) g.lineTo(x, h * (0.6 + k * 0.1) - Math.sin(x / w * 6 + i + k) * h * 0.05);
    g.lineTo(w, h);
    g.lineTo(0, h);
    g.fill();
  }
  // A figure, for skin tones and edges.
  g.fillStyle = "#d9a07e";
  g.beginPath();
  g.arc(w * 0.62, h * 0.52, h * 0.05, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#2c3e50";
  g.fillRect(w * 0.585, h * 0.57, w * 0.07, h * 0.22);
  const blob = await new Promise<Blob>((res) => c.toBlob((bl) => res(bl!), "image/jpeg", 0.9));
  return URL.createObjectURL(blob);
}

// ---------------------------------------------------------------- synthetic looks
function lutFor(seed: number): Uint8Array {
  const n = 33;
  const out = new Uint8Array(n * n * n * 4);
  const kind = seed % 6;
  let o = 0;
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++) {
        let R = r / 32, G = g / 32, B = b / 32;
        const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        if (kind === 0) { R = R * 1.08 + 0.03; B = B * 0.88; }
        if (kind === 1) { R = R * 0.9; B = B * 1.1 + 0.02; }
        if (kind === 2) { const t = y; R = y + (R - y) * 1.2 + (t - 0.5) * 0.12; B = y + (B - y) * 1.2 - (t - 0.5) * 0.12; }
        if (kind === 3) { R = G = B = Math.min(1, Math.max(0, (y - 0.5) * 1.25 + 0.5)); }
        if (kind === 4) { R = 0.08 + R * 0.86; G = 0.07 + G * 0.84; B = 0.1 + B * 0.8; }
        if (kind === 5) { R = y + (R - y) * 0.6 + 0.04; G = y + (G - y) * 0.7 + 0.02; }
        out[o++] = Math.round(Math.min(1, Math.max(0, R)) * 255);
        out[o++] = Math.round(Math.min(1, Math.max(0, G)) * 255);
        out[o++] = Math.round(Math.min(1, Math.max(0, B)) * 255);
        out[o++] = 255;
      }
  return out;
}
const LOOK_NAMES: [string, string, string][] = [
  ["Warm", "", "Your presets"], ["Bushell and a Peck", "Cristy Proctor", "Your presets"], ["small details", "Mary Palma", "Your presets"],
  ["Sunny trees", "Ángel F. Badillo Rincón", "Your presets"], ["my friend but cooler", "Alisha Dakota", "Your presets"], ["Kodak Gold 200", "", "Your presets"],
  ["Crash Course Orange Teal", "", "Your LUTs"],
  ["Kodak Professional Portra 400", "", "Resolve · Film emulation"], ["Kodak Vision 2383", "", "Resolve · Film emulation"], ["Fuji Eterna 3513", "", "Resolve · Film emulation"],
  ["Teal and Orange", "", "Resolve · Creative looks"], ["Amelie", "", "Resolve · Creative looks"], ["Blade Runner", "", "Resolve · Creative looks"], ["Moonrise Kingdom", "", "Resolve · Creative looks"],
  ["Agfa Vista 200", "", "RawTherapee film"], ["Fuji Superia 400", "", "RawTherapee film"], ["Ilford HP5 Plus", "", "RawTherapee film · B&W"], ["Kodak Tri-X 400", "", "RawTherapee film · B&W"],
  ["Arabica 12", "", "RocketStock 35 Free LUTs"], ["Kodachrome 64", "", "IWLTBAP Kodachrome LUTs"],
];
const looks: Look[] = LOOK_NAMES.map(([name, author, collection], i) => ({
  id: id(9, i), kind: i < 6 ? "preset" : collection.includes("RawTherapee") ? "hald" : "cube", name, author, collection, sourcePath: "(mock)",
  effects: { grain: name === "Kodak Gold 200" ? 40 : 0, vignette: i < 6 ? -12 : 0 }, swatch: ["#d8a88a", "#7fa3cf", "#5f7f3f", "#8a8a84", "#222"],
  baked: true, usedBy: 0, favorite: i < 3 ? i + 1 : null,
}));

// ---------------------------------------------------------------- library state
const review = new Map<number, ReviewState>();
for (let i = 0; i < TOTAL; i++) if (i % 3 === 0) review.set(i, i % 9 === 0 ? "selected" : i % 7 === 0 ? "rejected" : "maybe");
const PREVIEW_FAIL = new URLSearchParams(location.search).get("fail");
let demoAsk = 0;
const photoLooks = new Map<string, { lookId: string | null; strength: number; adjustments: typeof NO_ADJUSTMENTS }>();
// A few edits so the Edit list has something to show (made-up, like everything here).
for (const i of [3, 9, 14, 22, 27, 31, 40, 52]) photoLooks.set(id(1, i), { lookId: null, strength: 1, adjustments: NO_ADJUSTMENTS });
let albums: Album[] = [["Brussels Nights", 86], ["Pai", 212], ["Portraits", 148], ["Best of 2026", 64]].map(([n, c], i) => ({
  id: id(7, i), name: n as string, description: "", coverPhotoId: id(1, i * 11), coverThumbhash: (hashes as string[])[i], photoCount: c as number, createdMs: now, updatedMs: now - i * 86400000 * 2,
}));
// Dashboard stress cases (Amendment 4, A2): ?worst=long gives a 40-character album
// name and six albums; ?worst=empty gives no albums and no projects.
const WORST = new URLSearchParams(location.search).get("worst");
if (WORST === "long") {
  albums[0] = { ...albums[0], name: "A very long album name of forty chars xx" };
  albums = [...albums, { ...albums[1], id: id(7, 8), name: "Lima, the first week of the trip" }, { ...albums[2], id: id(7, 9), name: "Night buses" }];
}
if (WORST === "empty") albums = [];
const albumPhotos = new Map<string, Set<number>>(albums.map((a, i) => [a.id, new Set(Array.from({ length: a.photoCount }, (_, k) => (k * 7 + i) % TOTAL))]));
let tags: Tag[] = [{ id: id(8, 1), name: "nightlife", slug: "nightlife", usage: 12 }, { id: id(8, 2), name: "belgium", slug: "belgium", usage: 30 }];
let accounts: Account[] = [
  { id: id(6, 1), platform: "instagram", displayName: "Captured by Andy", username: "capturedbyandy", avatarPhotoId: id(1, 3), avatarThumbhash: (hashes as string[])[3], followerCount: 18400, followingCount: 612, publishedPostCount: 241, notes: "", bio: "Photographer & UGC creator · Brussels\nFilm tones, far places, slow evenings\n📩 bookings via link", link: "https://andyssarchives.com", category: "Photographer", drafts: 3, ready: 2, published: 6, createdMs: now, updatedMs: now },
];
let posts: (Post & { photoIds: string[] })[] = [
  ["Brussels at Night", "scheduled", 5], ["Pai, part 3", "ready", 4], ["Portrait series", "building", 3], ["Market mornings", "idea", 0],
  ["Summer Dump", "published", 6], ["Ghent in the rain", "published", 4], ["Chiang Mai", "published", 8], ["Film test", "published", 2],
  ["Pai sunsets", "published", 3], ["Bangkok nights", "published", 1], ["Sri Lanka, part 1", "published", 5], ["Colombo", "published", 1],
  ["Kandy train", "published", 4], ["Nepal", "published", 2], ["Portraits I", "published", 1], ["Winter light", "published", 3],
  ["Market colours", "scheduled", 4], ["Night bus north", "scheduled", 3],
].map(([t, s, n], i) => ({
  id: id(5, i), accountId: accounts[0].id, accountUsername: "capturedbyandy", title: t as string, pinned: i === 5 || i === 9,
  caption: i % 3 === 0 ? `${t}. Rain on the Grand-Place, neon in the puddles, and nobody in a hurry. Shot on the a6700 with Kodak Gold tones.\n\n#brussels #filmlook #travelphotography` : `${t} 🌙`, notes: "", status: s as Post["status"],
  scheduledAt: s === "scheduled" ? (i === 0 ? "2026-09-28T19:30" : `${new Date(now + (i % 5 + 1) * 86400000).toISOString().slice(0, 10)}T18:00`) : null, publishedAt: s === "published" ? `2026-0${8 - (i % 3)}-1${i}T19:00` : null, planOrder: i,
  photoCount: n as number, coverPhotoId: id(1, i * 9 + 1), coverThumbhash: (hashes as string[])[(i * 9 + 1) % 50], createdMs: now, updatedMs: now,
  exportRatio: (s === "published" ? "4:5" : "3:4") as Post["exportRatio"], tileOffset: 0,
  photoIds: Array.from({ length: n as number }, (_, k) => id(1, i * 9 + k)),
}));
const settings = new Map<string, string>();

function row(i: number): PhotoRow {
  const pid = id(1, i);
  const inPosts = posts.filter((p) => p.photoIds.includes(pid));
  const posted = inPosts.filter((p) => p.status === "published").length;
  return {
    id: pid, review: review.get(i) ?? "unreviewed", media: i % 4 === 0 ? "raw_image" : "image",
    capturedAt: new Date(base - i * 45_000).toISOString().slice(0, 23), filename: `DSC0${String(4200 + i).padStart(4, "0")}.JPG`,
    storage: i % 97 === 5 ? "cloud_only" : "local", thumb: "ready", thumbhash: (hashes as string[])[i % (hashes as string[]).length],
    width: 6000, height: 4000, social: posted ? "posted" : inPosts.length ? "assigned" : "unused", postedCount: posted, archived: false,
    edited: photoLooks.has(pid), burst: i % 17 < 3 ? 3 : 1, burstBest: i % 17 !== 1 && i % 17 !== 2, soft: i % 23 === 4,
    ...(i % 11 === 6 ? { filename: `C0${String(900 + i).padStart(4, "0")}.MP4`, media: "image", isVideo: true, duration: 8 + (i % 70), burst: 1, burstBest: true, soft: false } : { isVideo: false, duration: null }),
  };
}

function matching(q: Query): number[] {
  let all = Array.from({ length: TOTAL }, (_, i) => i);
  if (q.album) all = all.filter((i) => albumPhotos.get(q.album!)?.has(i));
  if (q.smart === "burst_extras") all = all.filter((i) => i % 17 === 1 || i % 17 === 2);
  if (q.smart === "soft") all = all.filter((i) => i % 23 === 4);
  if (q.smart === "not_edited_selected") all = all.filter((i) => review.get(i) === "selected" && !photoLooks.has(id(1, i)));
  if (q.smart === "edited") all = all.filter((i) => photoLooks.has(id(1, i)));
  if (q.smart === "selected_unposted") {
    const posted = new Set(posts.filter((p) => p.status === "published").flatMap((p) => p.photoIds));
    all = all.filter((i) => review.get(i) === "selected" && !posted.has(id(1, i)));
  }
  // A trip: a slice of the library stands in for each folder.
  if (q.folder) all = all.filter((i) => i % 7 === q.folder!.length % 7);
  // The newest 300 stand in for what the last scan brought in.
  if (q.smart === "last_import") all = all.filter((i) => i < 300);
  if (q.storage === "cloud_only") all = all.filter((i) => i % 97 === 5);
  if (q.video != null) all = all.filter((i) => (i % 11 === 6) === q.video);
  if (q.search) all = all.filter((i) => row(i).filename.toLowerCase().includes(q.search!.toLowerCase()));
  if (q.order === "oldest") all.reverse();
  return all;
}
const withReview = (q: Query) => matching(q).filter((i) => (!q.review || (review.get(i) ?? "unreviewed") === q.review) && !(q.excludeRejected && review.get(i) === "rejected"));

function counts(q: Query) {
  const c = { all: 0, unreviewed: 0, selected: 0, maybe: 0, rejected: 0 };
  for (const i of matching(q)) {
    c.all++;
    c[review.get(i) ?? "unreviewed"]++;
  }
  return c;
}

function postOut(p: (typeof posts)[number]): Post {
  const { photoIds, ...rest } = p;
  return { ...rest, photoCount: photoIds.length, coverPhotoId: photoIds[0] ?? null, coverThumbhash: photoIds[0] ? row(idx(photoIds[0])).thumbhash : null };
}

let archiveJson = archiveFile;
let siteJson = siteFile;
let siteVersion = 1;
let archiveVersion = 1;

mockIPC((cmd, args) => {
  const a = (args ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (cmd) {
    case "open_agency_board":
      return null;
    case "plugin:dialog|open":
      return ["/Volumes/Work/Downloads/clinic-portrait.jpg", "/Volumes/Work/Downloads/IMG_2041.MOV"];
    case "add_items":
      return [id(1, 3), id(1, 4)];
    case "misplaced":
      return [];
    case "morning_brief":
      return { cleanupCopies: 2404, cleanupCopiesBytes: 14.1e9, cleanupBytes: 303e9, postsReady: 3, savesInbox: 8, decisions: ["D1 Sample brand: approve the second cut", "D2 Rate card numbers"], unpaid: [{ id: "j1", client: "Sample client", campaign: "Sample campaign", amount: 500, currency: "EUR", fee: "", sentDate: "2026-09-02" }], diskFree: 6.2e9 };
    case "trip_places":
      return {
        trip: a.trip, country: "Thailand", loose: 1719, looseLocated: 1181, elsewhere: 195,
        places: [
          ["MAE HONG SON", 366, 226, "Thailand"], ["CHIANG DAO", 323, 259, "Thailand"], ["KO PHA-NGAN", 284, 256, "Thailand"], ["SAWI", 225, 163, "Thailand"],
          ["BANG LAMUNG", 184, 179, "Thailand"], ["HUOIXAI", 110, 24, "Laos"], ["DHARMSALA", 32, 23, "India"],
        ].map(([name, photos, located, country], k) => ({ key: `k${k}`, name, existing: false, country, lat: 0, lon: 0, photos, located, sample: [1, 2, 3, 4].map((j) => id(1, k * 40 + j * 3)) })),
      };
    case "make_places":
      return { moved: 1200, already: 0, failed: [], undo: [] };
    case "cleanup_overview": {
      const trips = ["THAILAND", "EGYPT", "INDIA"].map((name, t) => {
        const ids = cleanupIds(t);
        const del = ids.filter((p) => cleanupMarks.get(p) === "delete");
        const copies = ids.filter((p) => cleanupSets(p).includes("copy")).length;
        return { trip: `/Drive/CAMERA/${name}`, name, photos: ids.length, bytes: ids.length * 24e6, toDelete: del.length, bytesToDelete: del.length * 24e6, kept: ids.filter((p) => cleanupMarks.get(p) === "keep").length, copies, bytesCopies: copies * 24e6 };
      });
      return { trips, protected: 12 };
    }
    case "cleanup_photos": {
      const t = ["THAILAND", "EGYPT", "INDIA"].indexOf(String(a.trip).split("/").pop()!);
      return cleanupIds(t).map((p) => ({ id: p, mark: cleanupMarks.get(p) ?? null, bytes: 24e6, sets: cleanupSets(p) }));
    }
    case "cleanup_mark_set": {
      let n = 0;
      for (const t of [0, 1, 2]) for (const p of cleanupIds(t)) if (cleanupSets(p).includes(String(a.set))) { if (a.mark) cleanupMarks.set(p, String(a.mark)); else cleanupMarks.delete(p); n++; }
      return n;
    }
    case "cleanup_mark":
      for (const p of a.photoIds as string[]) if (a.mark) cleanupMarks.set(p, a.mark as string); else cleanupMarks.delete(p);
      return (a.photoIds as string[]).length;
    case "cleanup_delete": {
      const batch = `b${Date.now()}`;
      const name = String(a.trip).split("/").pop()!;
      const count = (a.ids as string[]).length;
      cleanupHistory.unshift({ batch, trip: a.trip, name, deletedMs: Date.now(), photos: count, bytes: count * 24e6, restored: false, phoneFound: 0, phoneDeleted: 0, phoneChecked: false });
      for (const p of [...cleanupMarks.keys()]) if (cleanupMarks.get(p) === "delete") review.delete(idx(p));
      return { batch, photos: count, bytes: count * 24e6, failed: [] };
    }
    case "cleanup_history":
      return cleanupHistory;
    case "cleanup_undo":
      return { photos: 212, failed: [] };
    case "cleanup_phone_find":
      return { asked: 120, found: 96, denied: false };
    case "cleanup_phone_delete":
      return "deleted";
    case "library_info":
      return { dbPath: "~/Library/Application Support/com.capturedbyandy.library/library.db", cacheDir: "…/cache", looksDir: "…/looks", exportsDir: "~/Pictures/CapturedByAndy/Exports" };
    case "list_sources":
      return [{ id: "s1", path: "/Volumes/KINGSTON/Photos", label: "KINGSTON", enabled: true, lastScanFinishedMs: now - 840000, photoCount: TOTAL, online: true }];
    case "scan_status":
      return { running: false, source: null, stats: { discovered: 0, added: 0, updated: 0, moved: 0, unchanged: 0, cloudOnly: 0, missing: 0, paired: 0, errors: 0, held: 0, cancelled: false }, error: null, thumbsQueued: 0 };
    case "photo_counts":
      return counts(a.query ?? {});
    case "photo_burst": {
      // A burst: the photo and its neighbours, as the mock marks bursts every 17 frames.
      const i = idx(a.id);
      const start = i - (i % 17);
      return row(i).burst > 1 ? [start, start + 1, start + 2].map(row) : [row(i)];
    }
    case "photo_folders":
      return [
        { path: "/Drive/CAMERA/AMSTERDAM", name: "AMSTERDAM", source: "CAMERA", depth: 1, count: 47 },
        { path: "/Drive/CAMERA/INDIA", name: "INDIA", source: "CAMERA", depth: 1, count: 413 },
        { path: "/Drive/CAMERA/SRI LANKA", name: "SRI LANKA", source: "CAMERA", depth: 1, count: 912 },
        { path: "/Drive/CAMERA/SRI LANKA/KITCHEN", name: "KITCHEN", source: "CAMERA", depth: 2, count: 64 },
        { path: "/Drive/CAMERA/SRI LANKA/BEACH", name: "BEACH", source: "CAMERA", depth: 2, count: 120 },
      ];
    case "smart_counts":
      return {
        soft: matching({ smart: "soft" }).length, dark: 12, bright: 4, burstExtras: matching({ smart: "burst_extras" }).length,
        burstExtrasUnreviewed: withReview({ smart: "burst_extras", review: "unreviewed" }).length, bursts: 420, burstsUnreviewed: 64, selectedUnposted: matching({ smart: "selected_unposted" }).length, noAlbum: 1900,
        edited: photoLooks.size, notEditedSelected: matching({ smart: "not_edited_selected" }).length, analysed: TOTAL,
        lastImport: matching({ smart: "last_import" }).length, lastImportUnreviewed: withReview({ smart: "last_import", review: "unreviewed" }).length,
      };
    case "list_photos":
      return withReview(a.query).slice(a.offset, a.offset + a.limit).map(row);
    case "photo_ids":
      return withReview(a.query).slice(a.offset, a.offset + a.limit).map((i) => id(1, i));
    case "photo_position": {
      const i = withReview(a.query).indexOf(idx(a.id));
      return i < 0 ? null : i;
    }
    case "photo_neighbor": {
      // By sort key: walk the unfiltered order from this photo to the next one in the view.
      const q = a.query as Query;
      const order = matching({ ...q, review: null });
      const inView = new Set(withReview(q));
      let k = order.indexOf(idx(a.id));
      if (k < 0) return null;
      for (k += a.dir; k >= 0 && k < order.length; k += a.dir) {
        if (inView.has(order[k])) return [id(1, order[k]), withReview(q).indexOf(order[k])];
      }
      return null;
    }
    // The assistant in the preview: a scripted stand-in (no network, no key).
    // ?fail=nokey|offline|refusal|empty|busy shows how the panel handles each failure.
    case "assistant_status":
      return { key: PREVIEW_FAIL !== "nokey", model: "claude-haiku-5-5", today: demoAsk, cap: 150, spentUsd: demoAsk * 0.0015, monthUsd: PREVIEW_FAIL === "ceiling" ? 19.99 : 0.42 + demoAsk * 0.0015, ceilingUsd: 20 };
    case "assistant_send": {
      demoAsk++;
      if (PREVIEW_FAIL === "nokey") throw "key: no key file";
      if (PREVIEW_FAIL === "offline") throw "offline: no connection to Claude";
      if (PREVIEW_FAIL === "busy") throw "busy: Claude is busy, try again in a minute";
      if (PREVIEW_FAIL === "ceiling") throw "ceiling: November's assistant budget of $20 is used ($19.99). The assistant resumes on 1 December; everything else works as before.";
      if (PREVIEW_FAIL === "limit") throw "limit: The Anthropic account's spending limit is reached. The assistant stops until the limit resets; everything else works as before.";
      if (PREVIEW_FAIL === "refusal") return { content: [], stop_reason: "refusal", usage: { input_tokens: 900, output_tokens: 0 } };
      if (PREVIEW_FAIL === "empty") return { content: [], stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 0 } };
      const msgs = a.messages as { role: string; content: { type: string; text?: string; content?: string }[] }[];
      const last = msgs[msgs.length - 1];
      const said = String(last.content.find((b) => b.type === "text")?.text ?? "").toLowerCase();
      if (last.content[0]?.type === "tool_result") {
        const r = JSON.parse(String(last.content[0].content ?? "{}"));
        const text = r.count === 0 ? `Nothing matches. Nearest trips: ${(r.nearest_trips ?? []).join(", ") || "none"}.` : r.count != null ? `${r.count} pictures${r.where ? ` from ${r.where}` : ""}.` : r.selected != null ? `${r.selected} picked. Instagram post?` : "Done.";
        return { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1200, output_tokens: 40 } };
      }
      const first = /first (\d+|three|two)/.exec(said);
      if (first) {
        const k = { two: 2, three: 3 }[first[1] as "two" | "three"] ?? Number(first[1]);
        return { content: [{ type: "tool_use", id: `t${demoAsk}`, name: "select_pictures", input: { first: k } }], stop_reason: "tool_use", usage: { input_tokens: 1200, output_tokens: 30 } };
      }
      const place = /from ([a-z ]+)/.exec(said)?.[1]?.trim();
      const input: Record<string, unknown> = {};
      if (place && !place.startsWith("my") && !place.startsWith("the")) input.place = place;
      if (/approved|selected/.test(said)) input.mark = "selected";
      if (/never posted/.test(said)) input.never_posted = true;
      return { content: [{ type: "tool_use", id: `t${demoAsk}`, name: "find_pictures", input }], stop_reason: "tool_use", usage: { input_tokens: 1500, output_tokens: 40 } };
    }
    case "video_info":
      return { width: 3840, height: 2160, fps: 30, duration: row(idx(String(a.id))).duration ?? 12 };
    case "save_original":
      return `/Volumes/Work/Downloads/${row(idx(String(a.id))).filename}`;
    // Transcripts in the preview: a fixed demo line set (no whisper here).
    case "transcripts_start":
    case "transcripts_playing":
      return null;
    case "transcripts_status":
      return { done: 34, total: 212, state: "running" };
    case "video_transcript":
      return idx(String(a.id)) % 3 === 0
        ? { state: "no_speech", language: "", text: "", segments: "[]", error: "" }
        : { state: "done", language: "fr", error: "", text: "On était jamais là, à Rome, tu vois ? Non, à Rome il y a des vestiges partout.",
            segments: JSON.stringify([{ start: 1.2, end: 3.6, text: "On était jamais là, à Rome, tu vois ?" }, { start: 4.1, end: 7.8, text: "Non, à Rome il y a des vestiges partout." }]) };
    case "transcribe_video":
      return "done";
    case "set_transcript_lines":
      return null;
    case "drive_link":
      return `https://drive.google.com/file/d/demo-${String(a.id).slice(-6)}/view`;
    case "site_projects":
      return { found: true, projects: [["night-market", "Night Market", "2026"], ["hill-walks", "Hill Walks", "2025"], ["river-days", "River Days", "2025"], ["sketchbook", "Sketchbook", "2024"]].map(([slug, title, year]) => ({ slug, title, year })) };
    case "edited_ids":
      return [...photoLooks.keys()].reverse();
    case "photo_rows":
      return (a.ids as string[]).map((p) => row(idx(p)));
    case "photo_detail": {
      const i = idx(a.id);
      return {
        ...row(i), capturedAtSource: "exif", cameraMake: "SONY", cameraModel: "ILCE-7M4", latitude: 50.846, longitude: 4.352,
        assets: [{ id: "a1", filename: row(i).filename, path: `/Volumes/KINGSTON/Photos/${row(i).filename}`, format: "jpeg", size: 9_100_000, storage: "local", isPrimary: true, isRaw: false, localCopy: null, archivedTo: [], finderTagged: row(i).review === "selected" }],
        albums: albums.filter((al) => albumPhotos.get(al.id)?.has(i)).map((al) => ({ id: al.id, name: al.name })),
        tags: i % 5 === 0 ? tags : [],
        history: posts.filter((p) => p.photoIds.includes(a.id)).map((p) => ({ postId: p.id, title: p.title, status: p.status, accountUsername: p.accountUsername, publishedAt: p.publishedAt, scheduledAt: p.scheduledAt, position: p.photoIds.indexOf(a.id) })),
      };
    }
    case "set_review":
      for (const p of a.ids as string[]) review.set(idx(p), a.review);
      return (a.ids as string[]).length;
    case "list_albums":
      return albums.map((al) => ({ ...al, photoCount: albumPhotos.get(al.id)?.size ?? 0 }));
    case "create_album": {
      const al: Album = { id: id(7, albums.length + 10), name: a.name, description: "", coverPhotoId: a.photoIds?.[0] ?? null, coverThumbhash: null, photoCount: 0, createdMs: Date.now(), updatedMs: Date.now() };
      albums = [al, ...albums];
      albumPhotos.set(al.id, new Set((a.photoIds ?? []).map(idx)));
      return al;
    }
    case "album_add":
      (a.photoIds as string[]).forEach((p) => albumPhotos.get(a.id)?.add(idx(p)));
      return a.photoIds.length;
    case "album_remove":
      (a.photoIds as string[]).forEach((p) => albumPhotos.get(a.id)?.delete(idx(p)));
      return a.photoIds.length;
    case "update_album":
      albums = albums.map((al) => (al.id === a.id ? { ...al, ...a.patch } : al));
      return albums.find((al) => al.id === a.id);
    case "delete_album":
      albums = albums.filter((al) => al.id !== a.id);
      return null;
    case "list_tags":
      return tags;
    case "tag_photos":
      for (const n of a.names as string[]) if (!tags.some((t) => t.name === n)) tags = [...tags, { id: id(8, tags.length + 5), name: n, slug: n, usage: a.photoIds.length }];
      return a.photoIds.length;
    case "list_accounts":
      return accounts;
    case "create_account": {
      const acc: Account = { ...accounts[0], id: id(6, accounts.length + 3), username: String(a.input.username).replace("@", ""), displayName: a.input.displayName ?? "", followerCount: a.input.followerCount ?? null, drafts: 0, ready: 0, published: 0, avatarPhotoId: null, avatarThumbhash: null };
      accounts = [...accounts, acc];
      return acc;
    }
    case "update_account":
      accounts = accounts.map((x) => (x.id === a.id ? { ...x, ...a.input } : x));
      return accounts.find((x) => x.id === a.id);
    case "list_posts":
      return posts.filter((p) => !a.filter?.account || p.accountId === a.filter.account).map(postOut);
    case "get_post":
    case "update_post": {
      const p = posts.find((x) => x.id === a.id)!;
      if (cmd === "update_post") Object.assign(p, Object.fromEntries(Object.entries(a.input).filter(([, v]) => v !== undefined)));
      return { ...postOut(p), photos: p.photoIds.map((x) => row(idx(x))), reused: [] };
    }
    case "delete_post":
      posts = posts.filter((p) => p.id !== a.id);
      return null;
    case "create_post": {
      const p = { ...postOut(posts[0]), id: id(5, posts.length + 20), title: a.input.title ?? "New post", status: (a.photoIds?.length ? "building" : "idea") as Post["status"], scheduledAt: null, publishedAt: null, photoIds: a.photoIds ?? [] };
      posts = [...posts, p];
      return { ...postOut(p), photos: p.photoIds.map((x: string) => row(idx(x))), reused: [] };
    }
    case "post_add_photos": {
      const p = posts.find((x) => x.id === a.id)!;
      p.photoIds = [...p.photoIds, ...(a.photoIds as string[]).filter((x) => !p.photoIds.includes(x))];
      return a.photoIds.length;
    }
    case "post_remove_photos": {
      const p = posts.find((x) => x.id === a.id)!;
      p.photoIds = p.photoIds.filter((x) => !a.photoIds.includes(x));
      return 1;
    }
    case "post_reorder":
      posts.find((x) => x.id === a.id)!.photoIds = a.ordered;
      return null;
    case "account_grid":
      return posts.filter((p) => p.accountId === a.account).sort((x, y) => Number(x.status === "published") - Number(y.status === "published") || (y.planOrder ?? 0) - (x.planOrder ?? 0)).map(postOut);
    case "plan_posts":
      (a.ordered as string[]).forEach((pid, i) => { const p = posts.find((x) => x.id === pid); if (p) p.planOrder = i + 1; });
      return null;
    case "post_pipeline":
      return { idea: 1, building: 1, ready: 1, scheduled: 1, published: 4, archived: 0 };
    case "dashboard":
      return { counts: counts({}), selectedUnposted: matching({ smart: "selected_unposted" }).length, cloudOnly: 24, missing: 0, thumbsPending: 0, offlineCopies: 0, pipeline: { idea: 1, building: 1, ready: 1, scheduled: 1, published: 4, archived: 0 }, accounts, albums: albums.slice(0, 4), sources: [{ id: "s1", path: "/Volumes/KINGSTON/Photos", label: "KINGSTON", enabled: true, lastScanFinishedMs: now - 840000, photoCount: TOTAL, online: true }], lastScanMs: now - 840000 };
    case "offline_info":
      return { dir: "~/Pictures/CapturedByAndy", photos: 0, bytes: 0, auto: false, allowCloud: false, includeRaw: false };
    case "offline_keep":
      return { copied: a.photoIds.length, already: 0, skippedCloud: 0, missing: 0, failed: 0, removed: 0, bytes: 0 };
    case "list_locations":
      return [];
    case "list_looks":
      return looks.map((l) => ({ ...l, usedBy: [...photoLooks.values()].filter((p) => p.lookId === l.id).length }));
    case "set_look_favorites":
      looks.forEach((l) => (l.favorite = null));
      (a.ordered as string[]).forEach((lid, i) => { const l = looks.find((x) => x.id === lid); if (l) l.favorite = i + 1; });
      return null;
    case "photo_looks":
      return (a.photoIds as string[]).map((pid) => ({ photoId: pid, ...(photoLooks.get(pid) ?? { lookId: idx(pid) % 4 === 0 ? looks[idx(pid) % looks.length].id : null, strength: 0.8, adjustments: NO_ADJUSTMENTS }) }));
    case "photo_look":
      return { photoId: a.photoId, ...(photoLooks.get(a.photoId) ?? { lookId: idx(a.photoId) % 4 === 0 ? looks[idx(a.photoId) % looks.length].id : null, strength: 0.8, adjustments: NO_ADJUSTMENTS }) };
    case "apply_look":
      for (const p of a.photoIds as string[]) photoLooks.set(p, { lookId: a.lookId, strength: a.strength, adjustments: a.adjustments ?? photoLooks.get(p)?.adjustments ?? NO_ADJUSTMENTS });
      return a.photoIds.length;
    case "auto_adjust":
      return { ...NO_ADJUSTMENTS, exposure: 0.35, contrast: 12, highlights: -28, shadows: 18, whites: 6, blacks: -8, temperature: 6, tint: -2, vibrance: 12 };
    case "export_image":
      return "~/Pictures/CapturedByAndy/Exports/mock.jpg";
    case "preview_space":
      return { used: 3.4 * 1024 ** 3, max: 6 * 1024 ** 3, dir: "~/Library/Application Support/com.capturedbyandy.library/cache/previews" };
    case "clear_previews":
      return 3.4 * 1024 ** 3;
    case "look_folders":
      return [
        { path: "/Volumes/Work/Library/Application Support/Adobe/CameraRaw/Settings", added: false, looks: 212 },
        { path: "/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT/Film Looks", added: false, looks: 38 },
        { path: "/Volumes/Work/Pictures/PhotoResources", added: false, looks: 240 },
        { path: "/Volumes/Work/Movies/LUT packs", added: true, looks: 32 },
      ];
    case "remove_look_folder":
      return [30, 2];
    case "frame_hints":
      return (a.photoIds as string[]).map((pid, i) => ({ photoId: pid, horizon: i % 2 ? null : 4.5, subject: [0.55, 0.2, 0.3, 0.5] }));
    case "export_clip":
      return "~/Pictures/CapturedByAndy/Exports/mock clip.mp4";
    case "save_video_still":
      return id(1, 7);
    case "photo_labels":
      return [["sunset_sunrise", 0.82], ["mountain", 0.61], ["people", 0.4], ["sky", 0.33], ["outdoor", 0.2]];
    case "video_moments":
      return [];
    case "add_video_moment":
      return { id: `m${Date.now()}`, photoId: a.photoId, start: Math.min(a.start, a.end), end: Math.max(a.start, a.end) };
    case "remove_video_moment":
      return null;
    case "airdrop":
      return "sent";
    case "startup_problem":
      return new URLSearchParams(location.search).has("safe") ? "The library file is damaged (database disk image is malformed). Restore a backup to continue." : null;
    case "safe_backups":
    case "list_backups":
      return [0, 1, 2, 3, 4, 5].map((d) => ({ name: `library-2026-09-${28 - d}.db`, createdMs: now - d * 86_400_000 - 3_600_000, size: 9_100_000 - d * 40_000, kind: "daily" }));
    case "backup_now":
      return { name: "library-2026-09-28-230000-manual.db", createdMs: now, size: 9_120_000, kind: "manual" };
    case "restore_note":
      return null;
    case "voice_start":
      // The mock "hears" nothing; __mockVoice("yes") in the console says a word.
      setTimeout(() => void emit("voice", { kind: "listening" }), 300);
      return null;
    case "voice_stop":
    case "voice_trace":
    case "voice_open_settings":
      return null;
    case "videos_ready":
      // Every other video "has its review copy", so both rings show.
      return (a.photoIds as string[]).filter((pid) => idx(pid) % 2 === 0);
    case "voice_status":
      return { speech: "authorized", mic: "authorized", ondevice: true, available: true, microphones: 1 };
    case "voice_pause":
      setTimeout(() => void emit("voice", { kind: a.paused ? "paused" : "listening" }), 50);
      return null;
    case "get_setting":
      return settings.get(a.key) ?? null;
    case "set_setting":
      settings.set(a.key, a.value);
      return null;
    // Portfolio fixtures are kept only in memory here.
    case "archive_read":
      return { json: archiveJson, version: String(archiveVersion), siteDir: "~/Movies/OFFICE/SOCIALS/PROJECTS/portfolio", media: siteMedia };
    case "archive_write":
      if (a.version !== String(archiveVersion)) throw "The website's projects changed somewhere else.";
      archiveJson = a.json;
      return String(++archiveVersion);
    case "site_read":
      return { json: siteJson, version: String(siteVersion) };
    case "site_write":
      if (a.version !== String(siteVersion)) throw "The website's pages changed somewhere else.";
      siteJson = a.json;
      return String(++siteVersion);
    case "site_put_logo":
      return "/logos/new-logo.svg";
    case "archive_write_clip":
      return false;
    case "archive_frame_status":
      // The first connected frame waits for the site, the rest are up to date.
      return (a.frames as { key: string }[]).map((f, i) => ({ key: f.key, upToDate: i !== 0, published: null }));
    case "archive_album_photos":
      return [...(albumPhotos.get(a.album) ?? [])].map((i) => row(i).id);
    case "archive_write_image":
    case "archive_sync":
    case "archive_preview":
      return null;
    default: {
      const studio = studioMock(cmd, a);
      return studio ? studio.value : null;
    }
  }
}, { shouldMockEvents: true });

const VOICE_WORDS: Record<string, string> = { yes: "select", keep: "select", no: "reject", nope: "reject", maybe: "maybe", back: "undo", undo: "undo", skip: "skip", next: "skip", zoom: "zoom", play: "zoom" };
(window as unknown as { __mockVoice: (word: string) => void }).__mockVoice = (word: string) => {
  const command = VOICE_WORDS[word.toLowerCase()];
  if (command) void emit("voice", { kind: "command", command, word });
};

(async () => {
  const urls = await Promise.all(Array.from({ length: 16 }, (_, i) => paint(i, i % 5 === 0 ? 1067 : 1600, i % 5 === 0 ? 1600 : 1067)));
  // A real clip for the video player when one is around (src/dev/sample.mp4, not committed).
  const sample = await fetch("/src/dev/sample.mp4", { method: "HEAD" }).then((r) => r.ok && (r.headers.get("content-type") ?? "").includes("video")).catch(() => false);
  assets.image = (kind, pid) => (kind === "video" && sample ? "/src/dev/sample.mp4" : urls[idx(pid) % urls.length]);
  seedStudio((i) => urls[(i * 3) % urls.length]);
  applyPalette(currentPalette());
  document.documentElement.dataset.mode = "photo";
  assets.lut = async (lid) => lutFor(idx(lid));
  // The site's own dev server serves its web copies.
  assets.site = (path) => `http://127.0.0.1:4187${path}`;
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
})();
