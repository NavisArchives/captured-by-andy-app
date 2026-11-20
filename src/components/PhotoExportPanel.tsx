// A picture's export on the Mac (NIRMATA Amendment 9a, photos): the size
// (full · 2048 px long edge · 1080 wide), the JPEG quality, the estimated file
// size on the button, and « Save the original file ». The edit (look, sliders,
// crop) is in the export; the original is never changed.
import { useEffect, useState } from "react";
import { api, errorText, imageUrl, showInFinder } from "../api";
import { renderExport } from "../gl/renderer";
import type { PhotoDetail, PhotoLook } from "../types";
import { useToast } from "./ui";

type Size = "full" | "2048" | "1080";
type Quality = "high" | "standard";
const Q = { high: 0.92, standard: 0.8 } as const;
/** Bytes per pixel of a typical camera JPEG at that quality (for the estimate). */
const BPP = { high: 0.42, standard: 0.2 } as const;

export function PhotoExportPanel({ photo }: { photo: PhotoDetail }) {
  const toast = useToast();
  const [size, setSize] = useState<Size>("2048");
  const [quality, setQuality] = useState<Quality>("high");
  const [busy, setBusy] = useState<"export" | "original" | null>(null);
  const [edit, setEdit] = useState<PhotoLook | null>(null);
  useEffect(() => {
    api.photoLook(photo.id).then(setEdit).catch(() => setEdit(null));
  }, [photo.id]);

  const w = photo.width ?? 0;
  const h = photo.height ?? 0;
  const long = Math.max(w, h);
  const dims = (s: Size): [number, number] => {
    if (!w || !h) return [0, 0];
    if (s === "2048" && long > 2048) return w >= h ? [2048, Math.round((2048 * h) / w)] : [Math.round((2048 * w) / h), 2048];
    if (s === "1080" && w > 1080) return [1080, Math.round((1080 * h) / w)];
    return [w, h];
  };
  const [ow, oh] = dims(size);
  const mb = (ow * oh * BPP[quality]) / 1e6;
  const sizes: [Size, string][] = [["full", w && h ? `Full · ${w}×${h}` : "Full"], ...(long > 2048 ? [["2048", "2048 px"] as [Size, string]] : []), ...(w > 1080 ? [["1080", "1080 wide"] as [Size, string]] : [])];

  const doExport = async () => {
    setBusy("export");
    try {
      const spec = size === "full" ? { aspect: null, width: w || 100_000, quality: Q[quality] } : size === "2048" ? { aspect: null, width: 2048, longEdge: true, quality: Q[quality] } : { aspect: null, width: 1080, quality: Q[quality] };
      const bytes = await renderExport(imageUrl("full", photo.id), edit?.lookId ?? null, edit?.strength ?? 1, edit?.adjustments ?? (await api.photoLook(photo.id)).adjustments, spec);
      const stem = photo.filename.replace(/\.[^.]+$/, "");
      const path = await api.exportImage(bytes, `${stem} ${size === "full" ? "full" : size === "2048" ? "2048" : "1080"}`);
      showInFinder(path);
      toast(`Exported ${path.split("/").pop()} · ${(bytes.length / 1e6).toFixed(1)} MB`);
    } catch (e) {
      toast(`Export failed: ${errorText(e)}`, { error: true });
    } finally {
      setBusy(null);
    }
  };
  const saveOriginal = async () => {
    setBusy("original");
    try {
      const path = await api.saveOriginal(photo.id);
      showInFinder(path);
      toast(`Original saved to Downloads · ${path.split("/").pop()}`);
    } catch (e) {
      toast(errorText(e), { error: true });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="clip-panel">
      <h6 className="h" style={{ margin: 0 }}>Export</h6>
      <div className="seg" role="group" aria-label="Size">
        {sizes.map(([k, label]) => (
          <button key={k} type="button" aria-pressed={size === k} onClick={() => setSize(k)}>{label}</button>
        ))}
      </div>
      <div className="seg" role="group" aria-label="Quality">
        <button type="button" aria-pressed={quality === "high"} onClick={() => setQuality("high")}>High</button>
        <button type="button" aria-pressed={quality === "standard"} onClick={() => setQuality("standard")}>Standard</button>
      </div>
      <button type="button" className="btn primary" disabled={!!busy} onClick={() => void doExport()}>
        {busy === "export" ? "Exporting…" : ow ? `Export ${ow}×${oh} · about ${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB` : "Export"}
      </button>
      <button type="button" className="link clip-original" disabled={!!busy} onClick={() => void saveOriginal()}>{busy === "original" ? "Copying the original…" : "Save the original file"}</button>
      <p className="meta" style={{ margin: 0 }}>Saved to Exports with your edit. The original file is never changed.</p>
    </div>
  );
}
