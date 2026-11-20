import type { Query } from "../types";

const SESSION = "cull.resume.v1";
const CURSOR = "cull.resume.cursor.v1";
export interface SavedCull { ids: string[]; query: Query; start: number; savedAt: number }
export function readCull(storage: Pick<Storage, "getItem"> = localStorage): SavedCull | null {
  try {
    const value = JSON.parse(storage.getItem(SESSION) ?? "null");
    const cursor = JSON.parse(storage.getItem(CURSOR) ?? "null");
    if (!value || !Array.isArray(value.ids) || !value.ids.length || value.ids.length > 200_000 ||
        !value.ids.every((id: unknown) => typeof id === "string" && id.length > 0 && id.length < 100) ||
        !value.query || typeof value.query !== "object" || Array.isArray(value.query) || !Number.isFinite(value.savedAt)) return null;
    const start = cursor?.savedAt === value.savedAt && Number.isInteger(cursor.index) ? cursor.index : 0;
    return { ...value, start: Math.max(0, Math.min(start, value.ids.length - 1)) };
  } catch { return null; }
}
export function saveCull(ids: string[], query: Query, savedAt: number, storage: Pick<Storage, "setItem"> = localStorage): boolean {
  try { storage.setItem(SESSION, JSON.stringify({ ids, query, savedAt })); return true; }
  catch { return false; }
}
export function saveCullPosition(index: number, savedAt: number, storage: Pick<Storage, "setItem"> = localStorage): void {
  try { storage.setItem(CURSOR, JSON.stringify({ index, savedAt })); } catch { /* review marks still persist in SQLite */ }
}
export function forgetCull(storage: Pick<Storage, "removeItem"> = localStorage): void {
  storage.removeItem(SESSION);
  storage.removeItem(CURSOR);
}
