// Putting looks back the way they were, for Undo after a look went onto many
// photos at once (the editor's apply-to-all, the number keys in Pictures).
import { api } from "../api";
import type { PhotoLook } from "../types";

/** Restores every photo in `snapshot`; photos that had the same edit go back together. */
export async function restoreLooks(snapshot: PhotoLook[]): Promise<void> {
  const groups = new Map<string, PhotoLook[]>();
  for (const s of snapshot) {
    const key = JSON.stringify([s.lookId, s.strength, s.adjustments]);
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  for (const list of groups.values()) {
    const s = list[0];
    await api.applyLook(list.map((x) => x.photoId), s.lookId, s.strength, s.adjustments);
  }
}
