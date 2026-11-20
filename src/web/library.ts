// The library's commands, answered in the browser from the rows Supabase holds
// (the Mac app answers them from its SQLite). Pictures, culling and albums
// work fully. What needs the Mac's files (editing, export, scans, clean-up)
// says so.
import { emit } from "@tauri-apps/api/event";
import { NO_ADJUSTMENTS, type Album, type Counts, type Folder, type PhotoDetail, type PhotoRow, type Query, type ReviewState, type Tag } from "../types";
import { send, type Rest, type WebPhoto } from "./remote";
import { editedOnMac, macBeat, macEdits, macPosts, macSite, webSyncStatus } from "./studio";

type A = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export class MacOnly extends Error {}
const macOnly = (what: string) => {
  throw `${what} happens on the Mac. Online you can look, cull, sort into albums and write.`;
};

// ---------------------------------------------------------------- state

let photos: WebPhoto[] = [];
/** Rows whose file the Mac can't find: kept out of the grid, but counted like the Mac does. */
let goneCount = 0;
let byId = new Map<string, WebPhoto>();
let albums: Album[] = [];
const albumMembers = new Map<string, string[]>();
let tags: Tag[] = [];
const photoTags = new Map<string, Set<string>>();
const settings = new Map<string, string>();
const SETTINGS = "settings";
try {
  for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(SETTINGS) ?? "{}"))) settings.set(k, String(v));
} catch {
  /* none kept */
}

const newestFirst = (a: WebPhoto, b: WebPhoto) => (a.captured_at < b.captured_at ? 1 : a.captured_at > b.captured_at ? -1 : a.id < b.id ? 1 : -1);

export function setPhotos(rows: WebPhoto[]): void {
  photos = rows.filter((p) => !p.gone).sort(newestFirst);
  goneCount = rows.length - photos.length;
  byId = new Map(photos.map((p) => [p.id, p]));
}

export function setRest(rest: Rest): void {
  albumMembers.clear();
  for (const m of [...rest.albumPhotos].sort((a, b) => a.position - b.position)) {
    if (m.deleted) continue;
    const list = albumMembers.get(m.album_id) ?? [];
    list.push(m.photo_id);
    albumMembers.set(m.album_id, list);
  }
  albums = rest.albums
    .filter((a) => !a.deleted)
    .map((a) => ({ id: a.id, name: a.name, description: a.description, coverPhotoId: a.cover_photo_id, coverThumbhash: null, photoCount: 0, createdMs: a.updated_ms, updatedMs: Math.max(a.updated_ms, a.web_ms ?? 0) }));
  photoTags.clear();
  for (const t of rest.photoTags) {
    const set = photoTags.get(t.photo_id) ?? new Set();
    set.add(t.tag_id);
    photoTags.set(t.photo_id, set);
  }
  const usage = new Map<string, number>();
  for (const t of rest.photoTags) usage.set(t.tag_id, (usage.get(t.tag_id) ?? 0) + 1);
  tags = rest.tags.map((t) => ({ ...t, usage: usage.get(t.id) ?? 0 }));
}

export const driveIdOf = (id: string): string | null => byId.get(id)?.drive_id ?? null;
/** The web's row for a picture (size, kind, name), for the download sheet. */
export const rowOf = (id: string): WebPhoto | undefined => byId.get(id);
/** What a browser can play: the video's web copy (the camera file itself is 4K 10-bit 4:2:2, which no browser decodes),
 *  or for an iPhone video without one, the file itself (H.264/HEVC 8-bit, which phones play). */
export const webVideoOf = (id: string): string | null => {
  const p = byId.get(id);
  return p?.web_video_id ?? (p?.iphone ? p.drive_id : null);
};

// ---------------------------------------------------------------- rows

/** Pictures in a posted post, as the Mac's last sync listed them. */
function postedOnMac(): Set<string> {
  return new Set(macPosts.filter((p) => p.status === "published").flatMap((p) => (Array.isArray(p.photoIds) ? (p.photoIds as string[]) : [])));
}

function row(p: WebPhoto): PhotoRow {
  return {
    id: p.id,
    review: p.review,
    media: p.media_kind,
    capturedAt: p.captured_at,
    filename: p.filename,
    storage: p.drive_id ? "local" : "cloud_only",
    thumb: p.drive_id ? "ready" : "unavailable",
    thumbhash: p.thumbhash,
    width: p.width,
    height: p.height,
    social: "unused",
    postedCount: 0,
    archived: false,
    edited: editedOnMac.has(p.id),
    burst: p.burst,
    burstBest: p.burst_best,
    soft: p.soft,
    isVideo: p.is_video,
    duration: p.duration_s,
  };
}

const folderPath = (p: WebPhoto) => `/${p.source}${p.folder ? `/${p.folder}` : ""}`;

/** Photos matching a view, before the review filter. */
function matching(q: Query = {}): WebPhoto[] {
  let all = photos;
  const keep = (f: (p: WebPhoto) => boolean) => (all = all.filter(f));
  if (q.ids) {
    const set = new Set(q.ids);
    keep((p) => set.has(p.id));
  }
  if (q.album) {
    const order = new Map((albumMembers.get(q.album) ?? []).map((id, i) => [id, i]));
    keep((p) => order.has(p.id));
  }
  if (q.tag) keep((p) => !!photoTags.get(p.id)?.has(q.tag!));
  if (q.media) keep((p) => p.media_kind === q.media);
  if (q.device) keep((p) => p.iphone === (q.device === "iphone"));
  if (q.video != null) keep((p) => p.is_video === q.video);
  if (q.from) keep((p) => p.captured_at >= q.from!);
  if (q.to) keep((p) => p.captured_at.slice(0, q.to!.length) <= q.to!);
  if (q.folder) {
    const f = q.folder;
    keep((p) => {
      const path = folderPath(p);
      return path === f || path.startsWith(`${f}/`);
    });
  }
  if (q.search) {
    const s = q.search.toLowerCase();
    keep((p) => p.filename.toLowerCase().includes(s) || p.folder.toLowerCase().includes(s));
  }
  // Only what the web knows: no posts, accounts, labels, locations or edits here.
  if (q.post || q.account || q.labels?.length || q.hasLocation) all = [];
  if (q.social && q.social !== "unused") all = [];
  if (q.storage === "offline" || q.storage === "missing" || q.storage === "archived") all = [];
  if (q.storage === "cloud_only") keep((p) => !p.drive_id);
  if (q.smart === "soft") keep((p) => p.soft);
  else if (q.smart === "burst_extras") keep((p) => p.burst > 1 && !p.burst_best);
  else if (q.smart === "last_import") {
    const newest = [...photos].sort((a, b) => b.updated_ms - a.updated_ms).slice(0, 300);
    const set = new Set(newest.map((p) => p.id));
    keep((p) => set.has(p.id));
  } else if (q.smart === "no_album") {
    const inAlbum = new Set([...albumMembers.values()].flat());
    keep((p) => !inAlbum.has(p.id));
  } else if (q.smart === "selected_unposted") {
    const used = postedOnMac();
    keep((p) => p.review === "selected" && !used.has(p.id));
  } else if (q.smart) all = [];
  if (q.order === "oldest") all = [...all].reverse();
  else if (q.order === "recentlyReviewed") all = [...all].sort((a, b) => (b.reviewed_ms ?? 0) - (a.reviewed_ms ?? 0));
  else if (q.album) {
    const order = new Map((albumMembers.get(q.album) ?? []).map((id, i) => [id, i]));
    if (!q.order) all = [...all].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  }
  return all;
}
const inView = (q: Query = {}) => matching(q).filter((p) => (!q.review || p.review === q.review) && !(q.excludeRejected && p.review === "rejected"));

function counts(q: Query = {}): Counts {
  const c: Counts = { all: 0, unreviewed: 0, selected: 0, maybe: 0, rejected: 0 };
  for (const p of matching({ ...q, review: null })) {
    c.all++;
    c[p.review]++;
  }
  return c;
}

function folders(): Folder[] {
  const tally = new Map<string, Folder>();
  for (const p of photos) {
    const parts = p.folder.split("/").filter(Boolean);
    for (let depth = 1; depth <= Math.min(2, parts.length); depth++) {
      const path = `/${p.source}/${parts.slice(0, depth).join("/")}`;
      const f = tally.get(path) ?? { path, name: parts[depth - 1], source: p.source, depth: depth as 1 | 2, count: 0 };
      f.count++;
      tally.set(path, f);
    }
  }
  return [...tally.values()].sort((a, b) => a.source.localeCompare(b.source) || a.path.localeCompare(b.path));
}

function albumOut(a: Album): Album {
  const members = albumMembers.get(a.id) ?? [];
  const coverId = a.coverPhotoId && byId.has(a.coverPhotoId) ? a.coverPhotoId : members[0] ?? null;
  return { ...a, coverPhotoId: coverId, coverThumbhash: coverId ? byId.get(coverId)?.thumbhash ?? null : null, photoCount: members.filter((id) => byId.has(id)).length };
}

// ---------------------------------------------------------------- changes

function setReview(ids: string[], review: ReviewState): number {
  const ms = Date.now();
  let n = 0;
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) continue;
    p.review = review;
    p.reviewed_ms = ms;
    p.web_ms = ms;
    n++;
  }
  send({ k: "review", ids, review, ms });
  return n;
}

function saveAlbum(a: Album, deleted = false) {
  const ms = Date.now();
  send({ k: "upsert", table: "albums", on: "id", rows: [{ id: a.id, name: a.name, description: a.description, cover_photo_id: a.coverPhotoId, web_ms: ms, deleted }] });
}

function albumChange(album: string, ids: string[], on: boolean): number {
  const list = albumMembers.get(album) ?? [];
  const has = new Set(list);
  const changed = ids.filter((id) => has.has(id) !== on);
  albumMembers.set(album, on ? [...list, ...changed] : list.filter((id) => !changed.includes(id)));
  const ms = Date.now();
  if (changed.length) send({ k: "upsert", table: "album_photos", on: "album_id,photo_id", rows: changed.map((photo_id, i) => ({ album_id: album, photo_id, position: list.length + i, web_ms: ms, deleted: !on })) });
  albums = albums.map((a) => (a.id === album ? { ...a, updatedMs: ms } : a));
  return changed.length;
}

const uuid = () => crypto.randomUUID();

// ---------------------------------------------------------------- the commands

/** Answers a library command, or undefined when it isn't one of these. */
export function library(cmd: string, a: A): { value: unknown } | undefined {
  const v = (value: unknown) => ({ value });
  switch (cmd) {
    case "photo_counts":
      return v(counts(a.query));
    case "list_photos":
      return v(inView(a.query).slice(a.offset, a.offset + a.limit).map(row));
    case "photo_ids":
      return v(inView(a.query).slice(a.offset, a.offset + a.limit).map((p) => p.id));
    case "photos_in_view": {
      const set = new Set(inView(a.query).map((p) => p.id));
      return v((a.ids as string[]).filter((id) => set.has(id)));
    }
    case "photo_position": {
      const i = inView(a.query).findIndex((p) => p.id === a.id);
      return v(i < 0 ? null : i);
    }
    case "photo_neighbor": {
      // By sort order, ignoring the review filter, to the next photo still in the view.
      const q = a.query as Query;
      const order = matching({ ...q, review: null });
      const view = inView(q);
      const at = new Map(view.map((p, i) => [p.id, i]));
      let k = order.findIndex((p) => p.id === a.id);
      if (k < 0) return v(null);
      for (k += a.dir; k >= 0 && k < order.length; k += a.dir) if (at.has(order[k].id)) return v([order[k].id, at.get(order[k].id)]);
      return v(null);
    }
    case "list_posts": {
      // The Mac's plan as its last sync left it; nothing here changes it.
      const f = (a.filter ?? {}) as { status?: string };
      const posts = macPosts.map((p) => ({ accountId: null, notes: "", coverThumbhash: byId.get(String(p.coverPhotoId))?.thumbhash ?? null, ...p }) as Record<string, unknown>);
      return v(f.status ? posts.filter((p) => p.status === f.status) : posts);
    }
    case "drive_link": {
      const d = driveIdOf(String(a.id));
      return v(d ? `https://drive.google.com/file/d/${encodeURIComponent(d)}/view` : null);
    }
    case "site_projects":
      return v(macSite);
    case "edited_ids":
      // The Mac's edit list, as its last sync left it; only pictures that are online.
      return v(macEdits.map(([id]) => id).filter((id) => byId.has(id)));
    case "photo_rows":
      return v((a.ids as string[]).flatMap((id) => (byId.has(id) ? [row(byId.get(id)!)] : [])));
    case "photo_burst": {
      const p = byId.get(a.id);
      return v(p ? [row(p)] : []);
    }
    case "photo_detail": {
      const p = byId.get(a.id);
      if (!p) throw "This photo isn't online (yet): the Mac sends it on its next sync.";
      const detail: PhotoDetail = {
        ...row(p),
        capturedAtSource: "exif",
        cameraMake: p.iphone ? "Apple" : null,
        cameraModel: p.camera_model,
        latitude: null,
        longitude: null,
        assets: [{ id: p.id, filename: p.filename, path: `${folderPath(p)}/${p.filename}`, format: p.filename.split(".").pop()?.toLowerCase() ?? "", size: 0, storage: p.drive_id ? "local" : "cloud_only", isPrimary: true, isRaw: p.media_kind === "raw", localCopy: null, archivedTo: [], finderTagged: false }],
        albums: albums.filter((al) => albumMembers.get(al.id)?.includes(p.id)).map((al) => ({ id: al.id, name: al.name })),
        tags: tags.filter((t) => photoTags.get(p.id)?.has(t.id)),
        history: [],
      };
      return v(detail);
    }
    case "set_review":
      return v(setReview(a.ids, a.review));
    case "review_marks":
      return v((a.ids as string[]).flatMap((id) => (byId.has(id) ? [{ id, review: byId.get(id)!.review, reviewedMs: byId.get(id)!.reviewed_ms }] : [])));
    case "restore_marks": {
      let n = 0;
      for (const m of a.marks as { id: string; review: ReviewState }[]) n += setReview([m.id], m.review);
      return v(n);
    }
    case "photo_folders":
      return v(folders());
    case "smart_counts": {
      const extras = photos.filter((p) => p.burst > 1 && !p.burst_best);
      const lastImport = matching({ smart: "last_import" });
      const inAlbum = new Set([...albumMembers.values()].flat());
      return v({
        soft: photos.filter((p) => p.soft).length, dark: 0, bright: 0, burstExtras: extras.length,
        burstExtrasUnreviewed: extras.filter((p) => p.review === "unreviewed").length, bursts: 0, burstsUnreviewed: 0,
        selectedUnposted: (() => { const used = postedOnMac(); return photos.filter((p) => p.review === "selected" && !used.has(p.id)).length; })(), noAlbum: photos.filter((p) => !inAlbum.has(p.id)).length,
        edited: 0, notEditedSelected: 0, analysed: photos.length, lastImport: lastImport.length, lastImportUnreviewed: lastImport.filter((p) => p.review === "unreviewed").length,
      });
    }
    case "list_albums":
      return v(albums.map(albumOut).sort((x, y) => y.updatedMs - x.updatedMs));
    case "create_album": {
      const ms = Date.now();
      const al: Album = { id: uuid(), name: a.name, description: a.description ?? "", coverPhotoId: a.photoIds?.[0] ?? null, coverThumbhash: null, photoCount: 0, createdMs: ms, updatedMs: ms };
      albums = [al, ...albums];
      saveAlbum(al);
      if (a.photoIds?.length) albumChange(al.id, a.photoIds, true);
      return v(albumOut(al));
    }
    case "album_add":
      return v(albumChange(a.id, a.photoIds, true));
    case "album_remove":
      return v(albumChange(a.id, a.photoIds, false));
    case "update_album": {
      albums = albums.map((al) => (al.id === a.id ? { ...al, ...Object.fromEntries(Object.entries(a.patch ?? {}).filter(([, x]) => x !== undefined)), updatedMs: Date.now() } : al));
      const al = albums.find((x) => x.id === a.id)!;
      saveAlbum(al);
      return v(albumOut(al));
    }
    case "delete_album": {
      const al = albums.find((x) => x.id === a.id);
      albums = albums.filter((x) => x.id !== a.id);
      if (al) saveAlbum(al, true);
      return v(null);
    }
    case "archive_album_photos":
      return v((albumMembers.get(a.album) ?? []).filter((id) => byId.has(id)));
    case "list_tags":
      return v(tags);
    case "dashboard":
      return v({
        counts: counts(), selectedUnposted: (() => { const used = postedOnMac(); return photos.filter((p) => p.review === "selected" && !used.has(p.id)).length; })(), cloudOnly: photos.filter((p) => !p.drive_id).length, missing: goneCount, thumbsPending: 0, offlineCopies: 0,
        pipeline: { idea: 0, building: 0, ready: 0, scheduled: 0, published: 0, archived: 0 }, accounts: [], albums: albums.map(albumOut).slice(0, 4), sources: sources(), lastScanMs: macBeat?.lastScanMs ?? null,
      });
    case "list_sources":
      return v(sources());
    case "sync_status":
      return v(webSyncStatus());
    case "sync_now":
      return v(null);
    case "scan_status":
      return v({ running: false, source: null, stats: { discovered: 0, added: 0, updated: 0, moved: 0, unchanged: 0, cloudOnly: 0, missing: 0, paired: 0, errors: 0, held: 0, cancelled: false }, error: null, thumbsQueued: 0 });
    case "get_setting":
      return v(settings.get(a.key) ?? null);
    case "set_setting":
      settings.set(a.key, a.value);
      try {
        localStorage.setItem(SETTINGS, JSON.stringify(Object.fromEntries(settings)));
      } catch {
        /* kept for this visit */
      }
      return v(null);
    case "photo_look":
      return v({ photoId: a.photoId, lookId: null, strength: 1, adjustments: NO_ADJUSTMENTS });
    case "photo_looks":
      return v((a.photoIds as string[]).map((photoId) => ({ photoId, lookId: null, strength: 1, adjustments: NO_ADJUSTMENTS })));
    case "library_info":
      return v({ dbPath: "Supabase", cacheDir: "this browser", looksDir: "", exportsDir: "" });
    case "post_pipeline":
      return v({ idea: 0, building: 0, ready: 0, scheduled: 0, published: 0, archived: 0 });
    case "offline_info":
      return v({ dir: "", photos: 0, bytes: 0, auto: false, allowCloud: false, includeRaw: false });
    case "preview_space":
      return v({ used: 0, max: 0, dir: "" });
    case "voice_status":
      return v({ speech: "unavailable", mic: "unavailable", ondevice: false, available: false, microphones: 0 });
    case "cleanup_overview":
      return v({ trips: [], protected: 0 });
    case "list_labels":
      return v({ labels: [], synonyms: [] });
    case "morning_brief":
      return v({ cleanupCopies: 0, cleanupCopiesBytes: 0, cleanupBytes: 0, postsReady: 0, savesInbox: 0, unpaid: [], diskFree: null, decisions: [] });
    case "open_link":
      window.open(String(a.url), "_blank", "noopener");
      return v(null);
    case "startup_problem":
    case "restore_note":
    case "album_look":
    case "video_trim":
      return v(null);
    default:
      return undefined;
  }
}

function sources() {
  const by = new Map<string, number>();
  for (const p of photos) by.set(p.source, (by.get(p.source) ?? 0) + 1);
  return [...by].map(([label, n]) => ({ id: label, path: `/${label}`, label, enabled: true, lastScanFinishedMs: null, photoCount: n, online: true }));
}

/** Commands that return a list: online they are empty rather than an error. */
export const EMPTY_LISTS = new Set([
  "account_grid", "archive_frame_status", "cleanup_history", "cleanup_photos", "frame_hints", "list_accounts", "list_backups",
  "list_locations", "list_looks", "look_folders", "misplaced", "photo_labels", "safe_backups", "video_moments", "videos_ready",
  "studio_ingest", "studio_pending_captures", "studio_piece_files", "studio_trends",
]);
/** Commands with nothing to say online. */
export const QUIET = new Set(["log_page_error", "warm_previews", "voice_stop", "voice_trace", "voice_pause", "archive_preview", "archive_sync", "keep_videos_local", "reveal", "set_look_favorites"]);

export { macOnly };
/** After a refresh: the screens reload what they show. */
export const libraryChanged = () => void emit("library-changed", null);
