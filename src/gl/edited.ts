// Draws photos *with their saved edit* (look + sliders) into small canvases,
// for places that should show a photo the way it will be posted: the
// Instagram profile preview, post previews. One shared WebGL context.
import { api, imageUrl } from "../api";
import { NO_ADJUSTMENTS, type PhotoLook } from "../types";
import { cropFor, loadBitmap, loadLut, LookRenderer, tileCrop } from "./renderer";

interface Job {
  photoId: string;
  canvas: HTMLCanvasElement;
  aspect: number;
  resolve: (drawn: boolean) => void;
  tile?: TileFrame;
}

const bitmaps = new Map<string, Promise<ImageBitmap>>();
const edits = new Map<string, Promise<PhotoLook>>();
let renderer: LookRenderer | null = null;
let queue: Job[] = [];
let busy = false;

function bitmap(id: string, small: boolean): Promise<ImageBitmap> {
  const key = `${small ? "t" : "p"}:${id}`;
  let p = bitmaps.get(key);
  if (!p) {
    // Avatars and highlights are tiny: the 320 px thumbnail is plenty there.
    p = small
      ? loadBitmap(imageUrl("thumb", id)).catch(() => loadBitmap(imageUrl("preview", id)))
      : loadBitmap(imageUrl("preview", id)).catch(() => loadBitmap(imageUrl("thumb", id)));
    p.catch(() => bitmaps.delete(key));
    bitmaps.set(key, p);
    // Keep memory bounded: a decoded preview is ~7 MB.
    if (bitmaps.size > 24) {
      const [oldest, old] = bitmaps.entries().next().value as [string, Promise<ImageBitmap>];
      bitmaps.delete(oldest);
      old.then((b) => b.close()).catch(() => {});
    }
  }
  return p;
}

/** The saved edit of a photo; cached until `forgetEdits` (after editing). */
export function editOf(id: string): Promise<PhotoLook> {
  let p = edits.get(id);
  if (!p) {
    p = api.photoLook(id).catch(() => ({ photoId: id, lookId: null, strength: 1, adjustments: NO_ADJUSTMENTS }));
    edits.set(id, p);
  }
  return p;
}

export function forgetEdits() {
  edits.clear();
}

const changeListeners = new Set<() => void>();
/** Saved edits changed behind the screen's back (an apply to all, its Undo):
 *  every photo on screen draws again with what is saved now. */
export function editsChanged() {
  edits.clear();
  changeListeners.forEach((fn) => fn());
}
export function onEditsChanged(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => {
    changeListeners.delete(fn);
  };
}

/** Frees every decoded image (when the preview is closed). */
export function releaseEdited() {
  for (const p of bitmaps.values()) p.then((b) => b.close()).catch(() => {});
  bitmaps.clear();
}

/** Draws `photoId`, edited, centre-cropped to `aspect`, into `canvas`. Resolves true when drawn. */
/** How a grid tile crops a post's cover: its export ratio and the tile's shift. */
export interface TileFrame {
  exportAspect: number;
  offset: number;
}

export function drawEdited(photoId: string, canvas: HTMLCanvasElement, aspect: number, tile?: TileFrame): Promise<boolean> {
  return new Promise((resolve) => {
    queue.filter((j) => j.canvas === canvas).forEach((j) => j.resolve(false));
    queue = queue.filter((j) => j.canvas !== canvas);
    queue.push({ photoId, canvas, aspect, tile, resolve });
    if (!busy) void pump();
  });
}

async function pump() {
  busy = true;
  while (queue.length) {
    const job = queue.shift()!;
    let drawn = false;
    try {
      const [bmp, edit] = await Promise.all([bitmap(job.photoId, job.canvas.width <= 200), editOf(job.photoId)]);
      renderer ??= new LookRenderer();
      renderer.setImage(bmp);
      if (edit.lookId) renderer.setLut(edit.lookId, await loadLut(edit.lookId));
      else renderer.setLut(null);
      const w = job.canvas.width;
      const h = job.canvas.height;
      renderer.render({
        width: w,
        height: h,
        strength: edit.strength,
        log: edit.log,
        adjustments: { ...NO_ADJUSTMENTS, ...edit.adjustments },
        ...(job.tile ? tileCrop(bmp.width, bmp.height, job.tile.exportAspect, job.tile.offset, edit.adjustments) : cropFor(bmp.width, bmp.height, job.aspect, edit.adjustments)),
      });
      const ctx = job.canvas.getContext("2d");
      ctx?.clearRect(0, 0, w, h);
      ctx?.drawImage(renderer.canvas, 0, 0);
      drawn = true;
    } catch {
      /* no preview possible (online-only, not fetched): the placeholder stays */
    }
    job.resolve(drawn);
    await new Promise((r) => setTimeout(r, 0));
  }
  busy = false;
}
