// The web app's line to Supabase: sign-in, loading the library and Studio
// (kept in this browser so the app opens at once and works without signal),
// and an outbox that sends changes when there is a connection.
import { pendingPhotos, pendingRest, type Change } from "./pending";
import { createClient, type Session } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL || "https://REPLACE_ME.supabase.co";
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
export const configured = !!KEY;
export const sb = createClient(URL, KEY || "missing-key", { auth: { flowType: "pkce", persistSession: true, detectSessionInUrl: true } });

const DRIVE = "https://www.googleapis.com/auth/drive.readonly";

export async function signIn(): Promise<void> {
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { scopes: DRIVE, redirectTo: location.origin + location.pathname, queryParams: { access_type: "offline", prompt: "consent" } },
  });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  await flush();
  if (outbox.length) throw new Error("Your changes are still waiting to sync. Keep this browser signed in and try again when they have been sent.");
  const { error } = await sb.auth.signOut();
  if (error) throw error;
  drive.token = null;
  drive.until = 0;
  sessionStorage.removeItem("drive-token");
  await cache.clear();
  localStorage.removeItem(OUTBOX);
  location.reload();
}

/** Right after Google sign-in: keep the Drive login so the phone stays signed in to Drive. */
export async function keepDriveLogin(session: Session): Promise<void> {
  if (session.provider_token) drive.set(session.provider_token, 3300);
  if (!session.provider_refresh_token || !session.user.email) return;
  await sb.from("google_tokens").upsert({ email: session.user.email.toLowerCase(), refresh_token: session.provider_refresh_token, updated_ms: Date.now() });
}

// ---------------------------------------------------------------- Google Drive access token

export const drive = {
  token: null as string | null,
  until: 0,
  set(token: string, seconds: number) {
    this.token = token;
    this.until = Date.now() + seconds * 1000;
    try {
      sessionStorage.setItem("drive-token", JSON.stringify([token, this.until]));
    } catch {
      /* private mode */
    }
  },
  async get(): Promise<string | null> {
    if (!this.token) {
      try {
        const [t, u] = JSON.parse(sessionStorage.getItem("drive-token") ?? "null") ?? [];
        if (t) [this.token, this.until] = [t, u];
      } catch {
        /* nothing kept */
      }
    }
    if (this.token && this.until > Date.now() + 60_000) return this.token;
    const { data, error } = await sb.functions.invoke<{ access_token: string; expires_in: number }>("drive-token");
    if (error || !data?.access_token) return null;
    this.set(data.access_token, data.expires_in);
    return this.token;
  },
};

// ---------------------------------------------------------------- what's kept in this browser

const DBNAME = "captured-by-andy";
function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DBNAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export const cache = {
  async get<V>(key: string): Promise<V | undefined> {
    try {
      const db = await idb();
      return await new Promise((resolve) => {
        const r = db.transaction("kv").objectStore("kv").get(key);
        r.onsuccess = () => resolve(r.result as V);
        r.onerror = () => resolve(undefined);
      });
    } catch {
      return undefined;
    }
  },
  async set(key: string, value: unknown): Promise<void> {
    try {
      const db = await idb();
      await new Promise<void>((resolve) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch {
      /* no storage: it loads from Supabase next time */
    }
  },
  async clear(): Promise<void> {
    try {
      indexedDB.deleteDatabase(DBNAME);
    } catch {
      /* nothing kept */
    }
  },
};

// ---------------------------------------------------------------- loading

export interface WebPhoto {
  id: string;
  captured_at: string;
  filename: string;
  folder: string;
  source: string;
  media_kind: "raw" | "image" | "raw_image";
  is_video: boolean;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  camera_model: string | null;
  iphone: boolean;
  burst: number;
  burst_best: boolean;
  soft: boolean;
  review: "unreviewed" | "selected" | "maybe" | "rejected";
  reviewed_ms: number | null;
  thumbhash: string | null;
  drive_id: string | null;
  /** The video's web copy on Drive (1080p H.264), what the browser plays; null until it's made. */
  web_video_id: string | null;
  gone: boolean;
  updated_ms: number;
  web_ms: number | null;
}
const PHOTO_COLS = "id,captured_at,filename,folder,source,media_kind,is_video,duration_s,width,height,camera_model,iphone,burst,burst_best,soft,review,reviewed_ms,thumbhash,drive_id,web_video_id,gone,updated_ms,web_ms";
const PAGE = 1000;

/** Every row of a table changed after `since` (or all of them), in parallel pages. */
async function rows<R>(table: string, cols: string, since: number | null, key: string, progress?: (done: number, total: number) => void): Promise<R[]> {
  const filtered = () => {
    const q = sb.from(table).select(cols, { count: "exact" });
    return since == null ? q : q.or(`updated_ms.gt.${since},web_ms.gt.${since}`);
  };
  const first = await filtered().order(key).range(0, PAGE - 1);
  if (first.error) throw first.error;
  const total = first.count ?? first.data.length;
  const out = [...(first.data as R[])];
  progress?.(out.length, total);
  const starts: number[] = [];
  for (let at = PAGE; at < total; at += PAGE) starts.push(at);
  // Six at a time: quick on a good line, gentle on a weak one.
  for (let i = 0; i < starts.length; i += 6) {
    const pages = await Promise.all(
      starts.slice(i, i + 6).map(async (at) => {
        const r = await filtered().order(key).range(at, at + PAGE - 1);
        if (r.error) throw r.error;
        return r.data as R[];
      }),
    );
    for (const p of pages) out.push(...p);
    progress?.(out.length, total);
  }
  return out;
}

interface PhotoCache {
  since: number;
  photos: WebPhoto[];
}

/** The library: from this browser at once, then whatever changed since from Supabase. */
export async function loadPhotos(progress: (done: number, total: number) => void): Promise<{ photos: WebPhoto[]; fresh: Promise<WebPhoto[] | null> }> {
  const kept = await cache.get<PhotoCache>("photos");
  const fetchChanges = async (base: WebPhoto[], since: number | null) => {
    const localChanges = [...outbox];
    const changed = await rows<WebPhoto>("photos", PHOTO_COLS, since, "id", since == null ? progress : undefined);
    const byId = new Map(base.map((p) => [p.id, p]));
    for (const p of changed) byId.set(p.id, p);
    // Only server rows advance the remote cursor; unsent local timestamps must
    // not make another device's earlier change disappear from future deltas.
    const top = changed.reduce((m, p) => Math.max(m, p.updated_ms, p.web_ms ?? 0), since ?? 0);
    const photos = pendingPhotos([...byId.values()], [...localChanges, ...outbox]);
    void cache.set("photos", { since: top, photos } satisfies PhotoCache);
    return { photos, changed: changed.length };
  };
  if (kept?.photos.length) {
    return {
      photos: pendingPhotos(kept.photos, outbox),
      fresh: fetchChanges(kept.photos, kept.since).then((r) => (r.changed ? r.photos : null)).catch(() => null),
    };
  }
  const { photos } = await fetchChanges([], null);
  return { photos, fresh: Promise.resolve(null) };
}

export interface WebAlbum {
  id: string;
  name: string;
  description: string;
  cover_photo_id: string | null;
  updated_ms: number;
  web_ms: number | null;
  deleted: boolean;
}
export interface WebStudioRow {
  list: string;
  id: string;
  data: Record<string, unknown>;
  updated_ms: number;
  web_ms: number | null;
  deleted: boolean;
}
export interface Rest {
  albums: WebAlbum[];
  albumPhotos: { album_id: string; photo_id: string; position: number; deleted: boolean }[];
  tags: { id: string; name: string; slug: string }[];
  photoTags: { tag_id: string; photo_id: string }[];
  studio: WebStudioRow[];
  links: { kind: string; a: string; b: string; deleted: boolean }[];
}

/** Albums, tags and Studio: small, so loaded whole each time (kept for offline starts). */
export async function loadRest(): Promise<Rest> {
  const localChanges = [...outbox];
  const all = async <R,>(table: string, cols: string, key: string) => {
    const out: R[] = [];
    for (let at = 0; ; at += PAGE) {
      const r = await sb.from(table).select(cols).order(key).range(at, at + PAGE - 1);
      if (r.error) throw r.error;
      out.push(...(r.data as R[]));
      if (r.data.length < PAGE) return out;
    }
  };
  try {
    const [albums, albumPhotos, tags, photoTags, studio, links] = await Promise.all([
      all<WebAlbum>("albums", "*", "id"),
      all<Rest["albumPhotos"][number]>("album_photos", "album_id,photo_id,position,deleted", "album_id,photo_id"),
      all<Rest["tags"][number]>("tags", "id,name,slug", "id"),
      all<Rest["photoTags"][number]>("photo_tags", "tag_id,photo_id", "tag_id,photo_id"),
      all<WebStudioRow>("studio_rows", "*", "list,id"),
      all<Rest["links"][number]>("studio_links", "kind,a,b,deleted", "kind,a,b"),
    ]);
    const rest = pendingRest({ albums, albumPhotos, tags, photoTags, studio, links }, [...localChanges, ...outbox]);
    void cache.set("rest", rest);
    return pendingRest(rest, outbox);
  } catch (e) {
    const kept = await cache.get<Rest>("rest");
    if (kept) return pendingRest(kept, outbox);
    throw e;
  }
}

// ---------------------------------------------------------------- the outbox

const OUTBOX = "outbox";
let outbox: Change[] = (() => {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX) ?? "[]");
  } catch {
    return [];
  }
})();
let storageProblem: string | null = null;
const keep = () => {
  try {
    localStorage.setItem(OUTBOX, JSON.stringify(outbox));
    storageProblem = null;
  } catch {
    storageProblem = "This browser cannot save pending changes. Keep this page open until they sync.";
  }
};
export const pending = () => outbox.length;
let sending = false;
let listener: (n: number) => void = () => {};
export const onPending = (f: (n: number) => void) => { listener = f; f(outbox.length); };
export interface SyncStatus { pending: number; sending: boolean; problem: string | null; lastSuccess: number | null }
let syncProblem: string | null = null;
let lastSuccess: number | null = null;
let statusListener: (status: SyncStatus) => void = () => {};
const report = () => statusListener({ pending: outbox.length, sending, problem: storageProblem ?? syncProblem, lastSuccess });
export function onSyncStatus(f: (status: SyncStatus) => void): () => void {
  statusListener = f;
  report();
  return () => { if (statusListener === f) statusListener = () => {}; };
}
// Keep acknowledged local edits in the offline cache too. Serialize read-modify-write
// operations so a rapid series of marks cannot overwrite the previous cache update.
let cacheWrites: Promise<void> = Promise.resolve();
function cacheChange(change: Change): void {
  cacheWrites = cacheWrites.then(async () => {
    if (change.k === "review") {
      const kept = await cache.get<PhotoCache>("photos");
      if (kept) await cache.set("photos", { ...kept, photos: pendingPhotos(kept.photos, [change]) });
    } else {
      const kept = await cache.get<Rest>("rest");
      if (kept) await cache.set("rest", pendingRest(kept, [change]));
    }
  }).catch(() => {});
}

export function send(change: Change): void {
  outbox.push(change);
  cacheChange(change);
  keep();
  listener(outbox.length);
  report();
  void flush();
}

export async function flush(): Promise<void> {
  if (sending || !outbox.length) return;
  sending = true;
  syncProblem = null;
  report();
  try {
    while (outbox.length) {
      const c = outbox[0];
      if (c.k === "review") {
        for (let i = 0; i < c.ids.length; i += 200) {
          const { error } = await sb.from("photos").update({ review: c.review, reviewed_ms: c.ms, web_ms: c.ms }).in("id", c.ids.slice(i, i + 200));
          if (error) throw error;
        }
      } else {
        const { error } = await sb.from(c.table).upsert(c.rows, { onConflict: c.on });
        if (error) throw error;
      }
      await cacheWrites;
      outbox.shift();
      lastSuccess = Date.now();
      keep();
      listener(outbox.length);
      report();
    }
  } catch (e) {
    syncProblem = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String(e.message) : "Could not reach the sync service. Your changes will be retried.";
    // No signal or a hiccup: tried again shortly, and when the phone is back online.
    window.setTimeout(() => void flush(), 15_000);
  } finally {
    sending = false;
    report();
  }
}
window.addEventListener("online", () => void flush());
