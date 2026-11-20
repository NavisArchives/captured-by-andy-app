// The website follows your edits. Every frame of the site that is a library
// photo or video (project frames, and brand films made from the library) shows
// its edited version: when a picture's edit changes (or is reset), its web copy
// is rendered again and the site rebuilds it. Frames without an edit keep the
// site's own copy. The originals are never touched.
import { api, imageUrl } from "../api";
import { EXPORTS, renderExport } from "../gl/renderer";
import { NO_ADJUSTMENTS } from "../types";
import * as A from "./archive";

let running = false;

/** Brings the website up to date with your edits; resolves to how many pictures it updated. */
export async function followWebsite(onStatus?: (text: string | null) => void): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const doc = JSON.parse((await api.archiveRead()).json) as A.ArchiveDoc;
    const frames = A.libraryFrames(doc).map((f) => ({ key: f.key, photo: f.photo }));
    try {
      const site = JSON.parse((await api.siteRead()).json) as { brandFilms?: { file: string; photo?: string | null }[] };
      for (const f of site.brandFilms ?? []) if (f.photo) frames.push({ key: `brand-${f.file}`, photo: f.photo });
    } catch {
      /* no site.json: projects only */
    }
    if (!frames.length) return 0;
    const status = await api.archiveFrameStatus(frames);
    // Edited and not shown yet, or shown with an edit that has since changed or been reset.
    const todo = status.filter((s) => !s.upToDate && (s.edited || s.published));
    if (!todo.length) return 0;
    const photoOf = new Map(frames.map((f) => [f.key, f.photo]));
    const videos = new Set((await api.rows([...new Set(todo.map((t) => photoOf.get(t.key)!))])).filter((r) => r.isVideo).map((r) => r.id));
    const original = EXPORTS.find((e) => e.id === "original")!.spec;
    for (const [i, t] of todo.entries()) {
      const photo = photoOf.get(t.key)!;
      onStatus?.(`Website · ${i + 1} of ${todo.length}`);
      if (videos.has(photo)) {
        await api.archiveWriteClip(photo, t.key);
      } else {
        const pl = await api.photoLook(photo);
        const bytes = await renderExport(imageUrl("full", photo), pl.lookId, pl.strength, { ...NO_ADJUSTMENTS, ...pl.adjustments }, original);
        await api.archiveWriteImage(bytes, t.key, photo);
      }
    }
    onStatus?.("Website · building");
    await api.archiveSync();
    return todo.length;
  } finally {
    running = false;
    onStatus?.(null);
  }
}
