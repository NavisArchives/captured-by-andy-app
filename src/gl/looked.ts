// The photo page's big picture with a look on it: its saved edit, or a look
// being tried (the album's). Drawn once from the preview into an image URL,
// so the page shows it like any other picture; the last few are kept, so
// Before / After flips without drawing again.
import { useEffect, useState } from "react";
import { imageUrl } from "../api";
import { NO_ADJUSTMENTS, type Adjustments } from "../types";
import { cropFor, loadBitmap, loadLut, LookRenderer } from "./renderer";

export interface LookToDraw {
  lookId: string | null;
  strength: number;
  adjustments: Partial<Adjustments>;
  log?: boolean;
}

let renderer: LookRenderer | null = null;
const drawn = new Map<string, Promise<string>>();
const KEEP = 6;

function draw(photoId: string, edit: LookToDraw): Promise<string> {
  const key = JSON.stringify([photoId, edit.lookId, edit.strength, edit.log ?? false, edit.adjustments]);
  let p = drawn.get(key);
  if (p) return p;
  p = (async () => {
    const bmp = await loadBitmap(imageUrl("preview", photoId));
    try {
      renderer ??= new LookRenderer(undefined, true);
      renderer.setImage(bmp);
      renderer.setLut(edit.lookId, edit.lookId ? await loadLut(edit.lookId) : undefined);
      const adjustments = { ...NO_ADJUSTMENTS, ...edit.adjustments };
      const frame = cropFor(bmp.width, bmp.height, null, adjustments);
      const width = Math.max(1, Math.round(bmp.width * frame.crop[2]));
      const height = Math.max(1, Math.round(bmp.height * frame.crop[3]));
      renderer.render({ width, height, strength: edit.strength, log: edit.log, adjustments, ...frame });
      const blob = await new Promise<Blob | null>((resolve) => renderer!.canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (!blob) throw new Error("could not draw the look");
      return URL.createObjectURL(blob);
    } finally {
      bmp.close();
    }
  })();
  p.catch(() => drawn.delete(key));
  drawn.set(key, p);
  while (drawn.size > KEEP) {
    const [oldest, old] = drawn.entries().next().value as [string, Promise<string>];
    drawn.delete(oldest);
    old.then((url) => URL.revokeObjectURL(url)).catch(() => {});
  }
  return p;
}

/** An image URL of the photo's preview with `edit` on it, or null while it
 *  draws, when there is nothing to draw, or if drawing failed. */
export function useLooked(photoId: string, edit: LookToDraw | null): { url: string | null; drawing: boolean } {
  const key = edit ? JSON.stringify(edit) : "";
  const [state, setState] = useState<{ key: string; url: string | null }>({ key: "", url: null });
  useEffect(() => {
    if (!edit) return;
    let live = true;
    draw(photoId, edit)
      .then((url) => live && setState({ key: `${photoId}|${key}`, url }))
      .catch(() => live && setState({ key: `${photoId}|${key}`, url: null }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoId, key]);
  if (!edit) return { url: null, drawing: false };
  const current = state.key === `${photoId}|${key}`;
  return { url: current ? state.url : null, drawing: !current };
}
