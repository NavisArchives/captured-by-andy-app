// Studio online: the same in-memory Studio the preview runs on
// (src/dev/studioMock.ts), filled with Andy's rows and saving every change to
// Supabase. Files (project.md) are kept as rows too; the Mac's sync writes
// them into the piece's 00_PLAN folder.
import { emit } from "@tauri-apps/api/event";
import { LINKS, T, studioHooks, studioMock } from "../dev/studioMock";
import { send, type Rest } from "./remote";

type A = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Row = Record<string, unknown>;

const files = new Map<string, { contents: string; modifiedMs: number }>();
/** The Mac's last sync round (studio_rows meta/sync): when, and what it counted. */
export let macBeat: { atMs: number; lastScanMs: number | null; photos: number; missing: number } | null = null;
let loading = false;
/** The Mac's edits (studio_rows meta/edits): [photo id, last change ms, look name], newest first. Read-only online. */
export let macEdits: [string, number, string | null][] = [];
export const editedOnMac = new Set<string>();
/** The Mac's posting plan and the website's projects (meta/posts, meta/site): read-only online. */
export let macPosts: Record<string, unknown>[] = [];
export let macSite: { projects: { slug: string; title: string; year?: string; notebook?: boolean }[]; found: boolean } | null = null;

export function setStudio(rest: Rest): void {
  loading = true;
  for (const k of Object.keys(T)) T[k] = [];
  for (const k of Object.keys(LINKS)) LINKS[k] = [];
  files.clear();
  for (const r of rest.studio) {
    if (r.deleted) continue;
    if (r.list === "meta" && r.id === "root") studioHooks.root = String(r.data.root ?? studioHooks.root);
    else if (r.list === "meta" && r.id === "sync") macBeat = r.data as typeof macBeat;
    else if (r.list === "meta" && r.id === "posts") macPosts = Array.isArray(r.data.items) ? (r.data.items as Record<string, unknown>[]) : [];
    else if (r.list === "meta" && r.id === "site") macSite = r.data as typeof macSite;
    else if (r.list === "meta" && r.id === "edits") {
      macEdits = Array.isArray(r.data.items) ? (r.data.items as typeof macEdits) : [];
      editedOnMac.clear();
      for (const [id] of macEdits) editedOnMac.add(id);
    }
    else if (r.list === "files") files.set(r.id, { contents: String(r.data.contents ?? ""), modifiedMs: Number(r.data.modifiedMs ?? r.web_ms ?? 0) });
    else if (T[r.list]) T[r.list].push({ ...r.data, id: r.id });
  }
  for (const l of rest.links) if (!l.deleted && LINKS[l.kind]) LINKS[l.kind].push([l.a, l.b]);
  // The Mac's order: newest first, pillars by position.
  for (const rows of Object.values(T)) rows.sort((a, b) => Number(b.createdMs ?? 0) - Number(a.createdMs ?? 0));
  T.pillars?.sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
  loading = false;
  void emit("studio-changed", null);
  void emit("sync-status", webSyncStatus());
}

export const webSyncStatus = () => ({ configured: true, running: false, lastOkMs: macBeat?.atMs ?? null, error: null, remote: true });

const saveRow = (list: string, id: string, data: Row, deleted = false) =>
  send({ k: "upsert", table: "studio_rows", on: "list,id", rows: [{ list, id, data, web_ms: Date.now(), deleted }] });

studioHooks.saved = (list, row) => {
  if (!loading) saveRow(list, String(row.id), { ...row });
};
studioHooks.deleted = (list, id) => saveRow(list, id, {}, true);
studioHooks.linked = (kind, a, b, on) => send({ k: "upsert", table: "studio_links", on: "kind,a,b", rows: [{ kind, a, b, web_ms: Date.now(), deleted: !on }] });

const piece = (id: string) => T.pieces.find((p) => p.id === id);
const planDir = (pieceId: string | null) => {
  const folder = pieceId ? (piece(pieceId)?.folder as string | null) : null;
  return folder ? `${folder}/00_PLAN` : `${studioHooks.root}/_CARDS`;
};

const onMac = (what: string) => {
  throw `${what} happens on the Mac. Online you can write, plan and keep track; the Mac picks it up on its next sync.`;
};

export function studio(cmd: string, a: A): { value: unknown } | undefined {
  const v = (value: unknown) => ({ value });
  switch (cmd) {
    case "studio_write_plan": {
      const path = `${planDir(a.pieceId ?? null)}/${a.name}`;
      const file = { contents: String(a.contents), modifiedMs: Date.now() };
      files.set(path, file);
      saveRow("files", path, { path, ...file });
      return v(path);
    }
    case "studio_read_plan": {
      const path = `${planDir(a.pieceId)}/${a.name}`;
      const f = files.get(path);
      return v(f ? { path, ...f } : null);
    }
    case "studio_add_link": {
      const url = String(a.url).trim();
      const existing = T.saves.find((s) => s.url === url);
      if (existing) return v({ ...existing, existing: true });
      const platform = /tiktok/.test(url) ? "tiktok" : /instagram/.test(url) ? "instagram" : /youtu/.test(url) ? "youtube" : "web";
      // The Mac fetches the title and a picture when it next looks at the inbox.
      return studioMock("studio_save", { list: "saves", id: null, values: { kind: "link", platform, url, urlKey: url, capturedVia: a.via ?? "paste", status: "inbox" } });
    }
    case "studio_refresh_preview":
      return v(T.saves.find((s) => s.id === a.id) ?? null);
    case "studio_similar":
      return v({ saves: [], photos: [] });
    case "studio_import_knowledge":
    case "studio_import":
      return onMac("Importing");
    case "studio_add_bytes":
    case "studio_add_paths":
      return onMac("Adding files");
    case "studio_read_fcpxml":
    case "studio_open_in_final_cut":
    case "studio_open_capcut":
      return onMac("Editing");
    case "studio_check_export":
      return onMac("Checking an export");
    case "studio_open_folder":
      return v(null);
    case "dictate_start":
    case "dictate_stop":
      return onMac("Dictation");
    default:
      return studioMock(cmd, a);
  }
}
