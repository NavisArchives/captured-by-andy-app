// Replay local intent over refreshed data until Supabase acknowledges it.
import type { Rest, WebPhoto } from "./remote";

export type Change =
  | { k: "review"; ids: string[]; review: WebPhoto["review"]; ms: number }
  | { k: "upsert"; table: string; on: string; rows: Record<string, unknown>[] };

export function pendingPhotos(photos: WebPhoto[], changes: readonly Change[]): WebPhoto[] {
  const marks = new Map<string, { review: WebPhoto["review"]; ms: number }>();
  for (const c of changes) if (c.k === "review") for (const id of c.ids) marks.set(id, c);
  return photos.map((p) => {
    const mark = marks.get(p.id);
    return mark ? { ...p, review: mark.review, reviewed_ms: mark.ms, web_ms: mark.ms } : p;
  });
}

export function pendingRest(rest: Rest, changes: readonly Change[]): Rest {
  const result = { ...rest };
  const fields = { albums: "albums", album_photos: "albumPhotos", studio_rows: "studio", studio_links: "links" } as const;
  for (const c of changes) {
    if (c.k !== "upsert" || !(c.table in fields)) continue;
    const field = fields[c.table as keyof typeof fields];
    const merge = <T extends object>(base: T[]): T[] => {
      const keys = c.on.split(",");
      const key = (r: object) => JSON.stringify(keys.map((k) => (r as Record<string, unknown>)[k]));
      const rows = new Map<string, T>();
      for (const row of base) rows.set(key(row), { ...row });
      for (const row of c.rows) rows.set(key(row), { updated_ms: 0, ...rows.get(key(row)), ...row } as T);
      return [...rows.values()];
    };
    if (field === "albums") result.albums = merge(result.albums);
    else if (field === "albumPhotos") result.albumPhotos = merge(result.albumPhotos);
    else if (field === "studio") result.studio = merge(result.studio);
    else result.links = merge(result.links);
  }
  return result;
}
