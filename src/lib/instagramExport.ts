// From a finished post to files ready for the phone: every photo rendered
// with its edit at Instagram's 4:5, numbered in carousel order so the order
// survives AirDrop. Originals are only read; exports are new files in the
// app's Exports folder and never overwrite anything.
import { api, imageUrl } from "../api";
import { exportFor, renderExport } from "../gl/renderer";
import { NO_ADJUSTMENTS, type PostDetail } from "../types";

/** Puts text on the clipboard. Call it straight from a click, before any await. */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the old way */
    }
  }
  const before = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  before?.focus?.();
  return ok;
}

/** A plain ASCII file name from a post title ('Été à Gent!' → 'Ete a Gent'). */
export function safeName(title: string): string {
  const s = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 _().-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return s || "Post";
}

/** Exports the carousel as 'Title 01.jpg', 'Title 02.mp4'… (videos copied as they are). Resolves to the written paths. */
export async function exportCarousel(post: PostDetail, onProgress?: (done: number, total: number, lastPath?: string) => void): Promise<string[]> {
  const ids = post.photos.map((p) => p.id);
  const videos = new Set(post.photos.filter((p) => p.isVideo).map((p) => p.id));
  const looks = new Map((await api.photoLooks(ids)).map((l) => [l.photoId, l]));
  const name = safeName(post.title);
  const spec = exportFor(post.exportRatio);
  // Dates taken one second apart, the first photo newest: Instagram's picker
  // (newest first) then shows the carousel together, in order, at the top.
  const base = Math.floor(Date.now() / 1000) * 1000;
  const paths: string[] = [];
  onProgress?.(0, ids.length);
  for (const [i, id] of ids.entries()) {
    const numbered = `${name} ${String(i + 1).padStart(2, "0")}`;
    if (videos.has(id)) {
      // With its look (and S-Log3 converted) at the post's ratio; untouched when it has none.
      const path = await api.exportClip(id, post.exportRatio, null, null, numbered, true);
      paths.push(path);
      onProgress?.(i + 1, ids.length, path);
      continue;
    }
    const look = looks.get(id);
    const bytes = await renderExport(
      imageUrl("full", id),
      look?.lookId ?? null,
      look?.strength ?? 1,
      { ...NO_ADJUSTMENTS, ...look?.adjustments },
      spec,
    );
    const path = await api.exportImage(bytes, numbered, exifTime(new Date(base - i * 1000)));
    paths.push(path);
    onProgress?.(i + 1, ids.length, path);
  }
  return paths;
}

/** "2026:09:28 23:10:05": local time as EXIF writes it. */
export function exifTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
