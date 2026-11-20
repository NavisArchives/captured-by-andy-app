/** Photo thumbnail request sizes; keep in sync with web-public/sw.js.
 * Drive video posters may be capped at 640×360 regardless of this request.
 */
export const PHOTO_SIZE_STEPS = [160, 480, 640, 960, 1280, 1600, 2560] as const;

/** Round up rather than undersizing a high-DPR display; bound cache variants. */
export function normalizePhotoPixels(pixels: number): number {
  const wanted = Number.isNaN(pixels) ? 480 : pixels;
  return PHOTO_SIZE_STEPS.find((step) => step >= wanted) ?? 2560;
}

/** Pass the measured image width (e.g. from ResizeObserver), in CSS pixels. */
export function photoPixels(cssWidth: number, dpr = globalThis.devicePixelRatio ?? 1): number {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return normalizePhotoPixels(cssWidth * scale);
}

/** Opt-in helper: existing layout and legacy routes remain unchanged. */
export function photoSizeUrl(fileId: string, cssWidth: number, dpr?: number): string {
  if (!fileId) throw new Error("A Drive file id is required");
  return `/drive/px/${photoPixels(cssWidth, dpr)}/${encodeURIComponent(fileId)}`;
}
