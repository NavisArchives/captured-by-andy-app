// Every call Studio makes into the Rust core.
import { invoke } from "@tauri-apps/api/core";
import type * as S from "./types";

type ListName = keyof S.Lists;

function nameHeaders(name: string): Record<string, string> {
  const utf8 = new TextEncoder().encode(name);
  const b64 = btoa(Array.from(utf8, (b) => String.fromCharCode(b)).join(""));
  return /^[\x20-\x7e]*$/.test(name) ? { "x-name": name, "x-name-b64": b64 } : { "x-name-b64": b64 };
}

export const studio = {
  list: <K extends ListName>(list: K, filter?: Partial<Record<keyof S.Lists[K], unknown>>) =>
    invoke<S.Lists[K][]>("studio_list", { list, filter: filter ?? null }),
  get: <K extends ListName>(list: K, id: string) => invoke<S.Lists[K] | null>("studio_get", { list, id }),
  save: <K extends ListName>(list: K, id: string | null, values: Partial<S.Lists[K]>) =>
    invoke<S.Lists[K]>("studio_save", { list, id, values }),
  remove: (list: ListName, id: string, source = "menu") => invoke<void>("studio_delete", { list, id, source }),
  link: (kind: "saveIdea" | "pieceMedia", a: string, b: string, on: boolean) => invoke<void>("studio_link", { kind, a, b, on }),
  linked: (kind: "saveIdea" | "pieceMedia", side: "a" | "b", id: string) => invoke<string[]>("studio_linked", { kind, side, id }),
  root: () => invoke<string>("studio_root"),
  summary: () => invoke<S.Summary>("studio_summary"),
  greenlight: (ideaId: string, familyId?: string | null) => invoke<S.Piece>("studio_greenlight", { ideaId, familyId: familyId ?? null }),
  pieceFolder: (id: string) => invoke<string>("studio_piece_folder", { id }),
  familyFolder: (id: string) => invoke<string>("studio_family_folder", { id }),
  setStage: (id: string, stage: S.Stage) => invoke<S.Piece>("studio_set_stage", { id, stage }),
  parkStale: (days = 60) => invoke<number>("studio_park_stale", { days }),
  addLink: (url: string, via = "paste") => invoke<S.Save>("studio_add_link", { url, via }),
  addPaths: (paths: string[]) => invoke<S.Save[]>("studio_add_paths", { paths }),
  addBytes: (name: string, bytes: Uint8Array) => invoke<S.Save>("studio_add_bytes", bytes, { headers: nameHeaders(name) }),
  ingest: () => invoke<S.Save[]>("studio_ingest"),
  /** HEADQUARTERS' knowledge notes into Inspire as Library saves (never doubled). */
  importKnowledge: () => invoke<{ notes: number; added: number; updated: number; skipped: string[] }>("studio_import_knowledge"),
  refreshPreview: (id: string) => invoke<S.Save>("studio_refresh_preview", { id }),
  importSaves: (path: string) => invoke<{ added: number; already: number }>("studio_import", { path }),
  trends: (geo = "BE") => invoke<S.Trend[]>("studio_trends", { geo }),
  youtube: (words: string) => invoke<S.Found[]>("studio_youtube", { words }),
  watchCheck: (id: string) => invoke<S.Watch>("studio_watch_check", { id }),
  similar: (id: string) => invoke<{ saves: string[]; photos: string[] }>("studio_similar", { id }),
  writePlan: (pieceId: string | null, name: string, contents: string) => invoke<string>("studio_write_plan", { pieceId, name, contents }),
  readPlan: (pieceId: string, name: string) => invoke<S.PlanFile | null>("studio_read_plan", { pieceId, name }),
  pieceFiles: (id: string) => invoke<S.PieceFile[]>("studio_piece_files", { id }),
  readFcpxml: (path: string) => invoke<string>("studio_read_fcpxml", { path }),
  openInFinalCut: (path: string) => invoke<void>("studio_open_in_final_cut", { path }),
  markPosted: (id: string, platform: string, url: string, file: string | null) => invoke<S.Piece>("studio_mark_posted", { id, platform, url, file }),
  checkExport: (path: string) => invoke<S.ExportCheck>("studio_check_export", { path }),
  openCapcut: (id: string) => invoke<void>("studio_open_capcut", { id }),
  openFolder: (path: string) => invoke<void>("studio_open_folder", { path }),
  pendingCaptures: () => invoke<string[]>("studio_pending_captures"),
};

/** A saved inspiration's picture, from the Studio thumbnail cache. */
export function saveThumb(thumb: string | null): string | undefined {
  if (!thumb) return undefined;
  if (/^(data|blob|https?):/.test(thumb)) return thumb; // the dev preview's stand-ins
  const base = navigator.userAgent.includes("Windows") ? "http://cba.localhost" : "cba://localhost";
  return `${base}/studio/${thumb}`;
}

export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
