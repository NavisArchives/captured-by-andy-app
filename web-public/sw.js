// Captured by Andy online: pictures and videos straight from Google Drive.
//
//   /drive/thumb/{fileId}    a small picture (Drive's own thumbnail, 480 px)
//   /drive/preview/{fileId}  a sharp one (1600 px)
//   /drive/full/{fileId}     as big as Drive makes them (2560 px)
//   /drive/px/{n}/{fileId}  photo size rounded to a bounded cache variant
//   /drive/video/{fileId}    the video itself, streamed in pieces (Range)
//
// Read-only: the access token comes from the page (Andy's own Google sign-in).
// Pictures are kept in this phone's cache, so a picture seen once shows at
// once, even without signal.

const VERSION = "v1";
const PICTURES = `drive-pictures-${VERSION}`;
const SIZES = { thumb: 480, preview: 1600, full: 2560 };
// Photo-only size requests. Match src/lib/photoSize.ts; video posters can stay 640×360.
const PHOTO_SIZE_STEPS = [160, 480, 640, 960, 1280, 1600, 2560];
const photoPixels = (px) => PHOTO_SIZE_STEPS.find((step) => step >= px) || 2560;
const API = "https://www.googleapis.com/drive/v3/files/";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith("drive-") && !k.endsWith(VERSION)) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

// ---------------------------------------------------------------- the token

let token = null;
let until = 0;
let asking = null;

async function getToken(fresh = false) {
  if (!fresh && token && until > Date.now() + 60_000) return token;
  if (!asking) {
    asking = (async () => {
      const clients = await self.clients.matchAll({ type: "window" });
      for (const c of clients) {
        const answer = await new Promise((resolve) => {
          const ch = new MessageChannel();
          const t = setTimeout(() => resolve(null), 10_000);
          ch.port1.onmessage = (e) => {
            clearTimeout(t);
            resolve(e.data);
          };
          c.postMessage({ type: "drive-token" }, [ch.port2]);
        });
        if (answer && answer.token) {
          token = answer.token;
          until = answer.until || Date.now() + 3000_000;
          return token;
        }
      }
      return null;
    })().finally(() => (asking = null));
  }
  return asking;
}

async function google(url, init = {}) {
  let t = await getToken();
  if (!t) return new Response("Not signed in to Google Drive", { status: 401 });
  const go = (tok) => fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${tok}` } });
  let res = await go(t);
  if (res.status === 401) {
    t = await getToken(true);
    if (t) res = await go(t);
  }
  return res;
}

// ---------------------------------------------------------------- pictures

const links = new Map();

async function thumbnailLink(id) {
  const kept = links.get(id);
  if (kept && kept.until > Date.now()) return kept;
  const res = await google(`${API}${id}?fields=thumbnailLink,mimeType&supportsAllDrives=true`);
  if (!res.ok) return null;
  const meta = await res.json();
  // Drive's links last a few hours; reread after one.
  const out = { link: meta.thumbnailLink || null, mime: meta.mimeType || "", until: Date.now() + 3600_000 };
  links.set(id, out);
  return out;
}

// The picture cache stays bounded: the oldest entries go past this many.
const MAX_PICTURES = 3000;
async function trim(cache) {
  try {
    const keys = await cache.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PICTURES))) await cache.delete(k);
  } catch {
    /* a full trim can wait for the next picture */
  }
}

const sized = (link, px) => link.replace(/=s\d+(-[a-z0-9-]+)?$/i, "") + `=s${px}`;

async function picture(request, kind, id, px = SIZES[kind], allowOriginal = true) {
  const cache = await caches.open(PICTURES);
  const key = new Request(`/drive/${kind}/${id}`);
  const hit = await cache.match(key);
  if (hit) return hit;
  const meta = await thumbnailLink(id);
  if (meta && meta.link) {
    const url = sized(meta.link, px);
    // Readable when Google allows it (cached, and fine for drawing); otherwise
    // an opaque copy an <img> can still show.
    try {
      const t = await getToken();
      const res = await fetch(url, { headers: t ? { Authorization: `Bearer ${t}` } : {}, mode: "cors" });
      if (res.ok) {
        await cache.put(key, res.clone());
      void trim(cache);
        void trim(cache);
        return res;
      }
    } catch (_) {
      /* not readable from here */
    }
    if (request.mode === "no-cors") {
      try {
        return await fetch(url, { mode: "no-cors" });
      } catch (_) {
        /* fall through */
      }
    }
  }
  // No thumbnail (yet): the file itself, when a browser can show it.
  if (allowOriginal && meta && /^image\/(jpeg|png|webp|gif|avif)$/.test(meta.mime)) {
    const res = await google(`${API}${id}?alt=media&supportsAllDrives=true`);
    if (res.ok) {
      await cache.put(key, res.clone());
      return res;
    }
  }
  return new Response("No picture", { status: 404 });
}

// ---------------------------------------------------------------- videos

// Drive answers a Range request with 206 but doesn't expose Content-Range to this origin, and a
// video element without it can't play (Safari and Chrome alike). So the worker writes it itself,
// from the file's size (asked once per file) and the bytes Drive sent.
const sizes = new Map();

async function sizeOf(id) {
  if (sizes.has(id)) return sizes.get(id);
  const res = await google(`${API}${id}?fields=size&supportsAllDrives=true`);
  const size = res.ok ? Number((await res.json()).size) || null : null;
  if (size) sizes.set(id, size);
  return size;
}

async function video(request, id) {
  const headers = {};
  const range = request.headers.get("Range");
  if (range) headers.Range = range;
  const res = await google(`${API}${id}?alt=media&supportsAllDrives=true`, { headers });
  const out = new Headers();
  for (const h of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"]) if (res.headers.get(h)) out.set(h, res.headers.get(h));
  out.set("Accept-Ranges", "bytes");
  if (res.status === 206 && !out.get("Content-Range")) {
    const size = await sizeOf(id);
    const start = Number((/bytes=(\d+)-/.exec(range || "") || [])[1] || 0);
    const len = Number(res.headers.get("Content-Length")) || (size ? size - start : 0);
    if (size && len) out.set("Content-Range", `bytes ${start}-${start + len - 1}/${size}`);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/drive/")) return;
  const parts = url.pathname.split("/");
  // A whole file straight to the phone's Files (« Save to Files »): streamed from
  // Drive to disk, never held in the page's memory (Amendment 9c, big files).
  if (parts[2] === "download") {
    const id = parts[3];
    const name = (url.searchParams.get("name") || "download").replace(/["\\/\r\n]/g, "_");
    e.respondWith(
      google(`${API}${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`).then((res) => {
        if (!res.ok || !res.body) return new Response(res.status === 401 ? "Sign in to Drive to get this file" : `Drive said ${res.status}`, { status: res.status || 502 });
        const headers = new Headers({ "Content-Type": res.headers.get("content-type") || "application/octet-stream", "Content-Disposition": `attachment; filename="${name}"` });
        const len = res.headers.get("content-length");
        if (len) headers.set("Content-Length", len);
        return new Response(res.body, { status: 200, headers });
      }),
    );
    return;
  }
  if (parts[2] === "px") {
    const [, , , raw, encoded] = parts;
    // photoSizeUrl encodes the id; decode it back (symmetry, Codex 006 review).
    let id = encoded;
    try { id = decodeURIComponent(encoded); } catch { /* a malformed id stays as it is */ }
    if (parts.length !== 5 || !id || !/^-?\d+(?:\.\d+)?$/.test(raw)) {
      e.respondWith(new Response("Invalid photo size route", { status: 404 }));
      return;
    }
    const px = photoPixels(Number(raw));
    // Canonical key: aliases such as 1170 and 1200 share the 1280px entry.
    // A size request must never fall back to downloading an unbounded original.
    e.respondWith(picture(e.request, `px/${px}`, id, px, false));
    return;
  }
  const [, , kind, id] = url.pathname.split("/");
  if (!id) {
    e.respondWith(new Response("Not on Drive", { status: 404 }));
    return;
  }
  e.respondWith(kind === "video" ? video(e.request, id) : SIZES[kind] ? picture(e.request, kind, id) : new Response("", { status: 404 }));
});
