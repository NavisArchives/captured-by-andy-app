// Cull from the phone: the swipe page, the photos waiting (small copies in R2)
// and the marks made (D1). The Mac pushes photos in and pulls marks out through
// /sync, with a token; nothing ever connects to the Mac.
import page from "../../index.html";

const STATES = new Set(["selected", "maybe", "rejected", "unreviewed"]);

async function sha(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

async function authed(req, env) {
  const m = (req.headers.get("Cookie") || "").match(/(?:^|;\s*)cull=([a-f0-9]+)/);
  return !!m && m[1] === (await sha(env.PASSCODE + "capturedbyandy"));
}
const syncing = (req, env) => req.headers.get("Authorization") === `Bearer ${env.SYNC_TOKEN}`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/" || p === "/index.html") return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    if (p === "/manifest.webmanifest")
      return json({ name: "Cull", short_name: "Cull", display: "standalone", background_color: "#0c0b0a", theme_color: "#0c0b0a", start_url: "/" });

    // ---- the Mac
    if (p.startsWith("/sync/")) {
      if (!syncing(req, env)) return json({ error: "token" }, 401);
      if (p === "/sync/photos" && req.method === "POST") {
        const rows = await req.json();
        const stmt = env.DB.prepare("INSERT INTO photos (id, dir, label, name, at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (id) DO NOTHING");
        for (let i = 0; i < rows.length; i += 50) await env.DB.batch(rows.slice(i, i + 50).map((r) => stmt.bind(r.id, r.dir, r.label, r.name, r.at)));
        return json({ ok: true, count: rows.length });
      }
      if (p.startsWith("/sync/img/") && req.method === "PUT") {
        await env.PHOTOS.put(p.slice(10), req.body, { httpMetadata: { contentType: "image/jpeg" } });
        return json({ ok: true });
      }
      if (p === "/sync/known") {
        const { results } = await env.DB.prepare("SELECT id FROM photos").all();
        return json(results.map((r) => r.id));
      }
      if (p === "/sync/marks") {
        const { results } = await env.DB.prepare("SELECT id, state, marked_ms FROM photos WHERE marked_ms IS NOT NULL AND (synced_ms IS NULL OR synced_ms < marked_ms)").all();
        return json(results);
      }
      if (p === "/sync/ack" && req.method === "POST") {
        // marks now in the app's library: the photo's copy is no longer needed
        const done = await req.json();
        for (const { id, marked_ms } of done) await env.DB.prepare("UPDATE photos SET synced_ms = ?2 WHERE id = ?1").bind(id, marked_ms).run();
        // copies of photos marked over 15 minutes ago (no undo coming) and synced go
        const { results } = await env.DB.prepare(
          "SELECT id FROM photos WHERE state != 'unreviewed' AND cleaned_ms IS NULL AND synced_ms >= marked_ms AND marked_ms < ?1 LIMIT 500",
        ).bind(Date.now() - 15 * 60 * 1000).all();
        for (const { id } of results) {
          await env.PHOTOS.delete([id, `${id}-s`]);
          await env.DB.prepare("UPDATE photos SET cleaned_ms = ?2 WHERE id = ?1").bind(id, Date.now()).run();
        }
        return json({ ok: true, cleaned: results.length });
      }
      if (p === "/sync/forget" && req.method === "POST") {
        // marked on the Mac meanwhile: drop it from the phone's queue
        const ids = await req.json();
        for (const id of ids) {
          await env.DB.prepare("DELETE FROM photos WHERE id = ?1").bind(id).run();
          await env.PHOTOS.delete([id, `${id}-s`]);
        }
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    }

    // ---- the phone
    if (p === "/api/login" && req.method === "POST") {
      const { code } = await req.json().catch(() => ({}));
      if (String(code || "").trim() !== env.PASSCODE) {
        await new Promise((r) => setTimeout(r, 800));
        return json({ error: "wrong passcode" }, 403);
      }
      return json({ ok: true }, 200, { "Set-Cookie": `cull=${await sha(env.PASSCODE + "capturedbyandy")}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax` });
    }
    if (!(await authed(req, env))) return json({ error: "passcode" }, 401);

    if (p === "/api/folders") {
      const { results } = await env.DB.prepare(
        "SELECT dir, label, COUNT(*) AS count FROM photos WHERE state = 'unreviewed' GROUP BY dir, label ORDER BY count DESC",
      ).all();
      return json(results);
    }
    if (p === "/api/queue") {
      const dir = url.searchParams.get("dir") || "";
      const { results } = await env.DB.prepare("SELECT id, name, at FROM photos WHERE dir = ?1 AND state = 'unreviewed' ORDER BY at, id LIMIT 2000").bind(dir).all();
      const done = await env.DB.prepare("SELECT COUNT(*) AS n FROM photos WHERE dir = ?1 AND state != 'unreviewed'").bind(dir).first();
      return json({ photos: results, done: done ? done.n : 0 });
    }
    if (p === "/api/mark" && req.method === "POST") {
      const { id, state } = await req.json();
      if (!STATES.has(state)) return json({ error: "state" }, 400);
      const prev = await env.DB.prepare("SELECT state FROM photos WHERE id = ?1").bind(id).first();
      await env.DB.prepare("UPDATE photos SET state = ?2, marked_ms = ?3 WHERE id = ?1").bind(id, state, Date.now()).run();
      return json({ ok: true, previous: prev ? prev.state : null });
    }
    if (p.startsWith("/img/")) {
      const id = p.slice(5);
      const small = url.searchParams.get("s") === "small";
      const obj = (small && (await env.PHOTOS.get(`${id}-s`))) || (await env.PHOTOS.get(id));
      if (!obj) return json({ error: "no picture" }, 404);
      return new Response(obj.body, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" } });
    }
    return json({ error: "not found" }, 404);
  },
};
