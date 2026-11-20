// A video's look and a finished clip for Instagram (the full edit, every
// slider, is in the editor): a look at a strength
// (S-Log3 clips are converted to normal colour automatically), the part to
// use (the whole clip or a marked moment) and the size, exported into Exports.
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { api, errorText, showInFinder } from "../api";
import { editsChanged } from "../gl/edited";
import { ratioAspect } from "../gl/renderer";
import { formatDuration } from "../lib/format";
import { useStore } from "../store";
import type { PhotoDetail, PhotoLook, VideoMoment } from "../types";
import { EditedImage } from "./Instagram";
import { useToast, Select } from "./ui";

const SIZES = [
  { id: "original", label: "Original" },
  { id: "9:16", label: "Reel 9:16" },
  { id: "4:5", label: "4:5" },
  { id: "3:4", label: "3:4" },
] as const;

/** Output heights (short side) offered, never above the source (Amendment 9a). */
const LEVELS = [2160, 1440, 1080, 720, 540] as const;
/** Bits per pixel per frame for each quality: the writer holds this average bitrate. */
const QUALITY = { high: 0.12, standard: 0.07, small: 0.035 } as const;
type Quality = keyof typeof QUALITY;
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** The exact output size for a shape (width / height) at a level (short side). */
export function outSize(shape: number, level: number): [number, number] {
  return shape >= 1 ? [even(level * shape), even(level)] : [even(level), even(level / shape)];
}
/** Estimated file size in MB: video at the chosen bitrate plus 192 kb/s of sound. */
export function estimateMB(w: number, h: number, fps: number, seconds: number, q: Quality): number {
  return ((w * h * fps * QUALITY[q] + 192_000) * seconds) / 8 / 1e6;
}

export function ClipPanel({ photo }: { photo: PhotoDetail }) {
  const { looks, editIds } = useStore();
  const toast = useToast();
  const [edit, setEdit] = useState<PhotoLook | null>(null);
  const [moments, setMoments] = useState<VideoMoment[]>([]);
  // Set in the editor; "whole" exports the clip as trimmed.
  const [trim, setTrim] = useState<[number, number] | null>(null);
  const [part, setPart] = useState<string>("whole");
  const [size, setSize] = useState<(typeof SIZES)[number]["id"]>("original");
  const [progress, setProgress] = useState<number | null>(null);
  const [info, setInfo] = useState<{ width: number; height: number; fps: number; duration: number } | null>(null);
  const [level, setLevel] = useState<number | "original">(1080);
  const [quality, setQuality] = useState<Quality>("high");
  const [saving, setSaving] = useState(false);
  const [rev, setRev] = useState(0);

  useEffect(() => {
    api.photoLook(photo.id).then(setEdit).catch(() => setEdit(null));
    api.videoMoments(photo.id).then(setMoments).catch(() => setMoments([]));
    api.videoTrim(photo.id).then(setTrim).catch(() => setTrim(null));
  }, [photo.id, rev]);
  useEffect(() => {
    setInfo(null);
    api.videoInfo(photo.id).then(setInfo).catch(() => setInfo(null));
  }, [photo.id]);
  useEffect(() => {
    let off: (() => void) | undefined;
    let live = true;
    listen<{ photoId: string; fraction: number }>("clip-progress", (e) => {
      if (e.payload.photoId === photo.id) setProgress(e.payload.fraction);
    })
      .then((u) => (live ? (off = u) : u()))
      .catch(() => {});
    return () => {
      live = false;
      off?.();
    };
  }, [photo.id]);

  const save = async (lookId: string | null, strength: number) => {
    try {
      await api.applyLook([photo.id], lookId, strength);
      editsChanged();
      setRev((r) => r + 1);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const ordered = [...looks].sort((a, b) => (a.favorite ?? 99) - (b.favorite ?? 99) || a.name.localeCompare(b.name));
  const moment = moments.find((m) => m.id === part);
  // The clip's frame: its own shape for "Original", else the chosen ratio.
  const shape = size === "original" ? (info ? info.width / info.height : photo.width && photo.height ? photo.width / photo.height : 16 / 9) : size === "9:16" ? 9 / 16 : ratioAspect(size);

  // Sizes: the source's own short side first (« Original »), then the levels below it.
  const srcW = info?.width ?? photo.width ?? 1920;
  const srcH = info?.height ?? photo.height ?? 1080;
  const srcShort = Math.min(srcW, srcH);
  // The largest short side this shape can have without upscaling (a 9:16 cut of 4K is 1215 wide).
  const cap = size === "original" ? srcShort : shape >= 1 ? Math.min(srcH, srcW / shape) : Math.min(srcW, srcH * shape);
  const top = even(Math.floor(cap));
  const levels = size === "original"
    ? LEVELS.filter((l) => l < srcShort)
    : [...((LEVELS as readonly number[]).includes(top) || top >= 2160 ? [] : [top]), ...LEVELS.filter((l) => l <= cap)];
  const lv = size === "original" && (level === "original" || level >= srcShort) ? srcShort : level === "original" ? (levels[0] ?? even(cap)) : Math.min(level, levels[0] ?? even(cap));
  const [outW, outH] = size === "original" && lv === srcShort ? [even(srcW), even(srcH)] : outSize(shape, lv);
  const fps = info?.fps || 30;
  const seconds = moment ? moment.end - moment.start : trim ? trim[1] - trim[0] : (info?.duration ?? photo.duration ?? 0);
  const mb = estimateMB(outW, outH, fps, seconds, quality);
  const bitrate = outW * outH * fps * QUALITY[quality];
  const saveOriginal = async () => {
    setSaving(true);
    try {
      const path = await api.saveOriginal(photo.id);
      showInFinder(path);
      toast(`Original saved to Downloads · ${path.split("/").pop()}`);
    } catch (e) {
      toast(errorText(e), { error: true });
    } finally {
      setSaving(false);
    }
  };

  const exportClip = async () => {
    setProgress(0);
    try {
      const base = photo.filename.replace(/\.[^.]+$/, "");
      const path = await api.exportClip(photo.id, size, moment?.start ?? null, moment?.end ?? null, `${base} ${size === "9:16" ? "reel" : size === "original" ? "edit" : "clip"} ${outH}p`, false, `${outW}x${outH}`, bitrate);
      showInFinder(path);
      toast("Clip ready in Exports", {
        action: {
          label: "AirDrop",
          run: () => void api.airdrop([path]).catch((e) => toast(errorText(e), { error: true })),
        },
      });
    } catch (e) {
      toast(errorText(e), { error: true });
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="clip-panel">
      <div className="row-flex" style={{ justifyContent: "space-between" }}>
        <h6 className="h" style={{ margin: 0 }}>Look and clip for Instagram</h6>
        <button type="button" className="btn quiet small" onClick={() => editIds([photo.id])} title="Every slider, the looks, grain and vignette, on the moving picture">
          Edit in editor <kbd>E</kbd>
        </button>
      </div>
      {edit?.log && <p className="hint" style={{ margin: 0 }}>Filmed in S-Log3: shown and exported in normal colour automatically.</p>}
      <div className="clip-preview" style={{ aspectRatio: String(shape) }}>
        <EditedImage key={`${photo.id}-${size}-${rev}`} id={photo.id} hash={photo.thumbhash} aspect={shape} px={320} />
      </div>
      <label className="clip-row">
        <span className="meta">Look</span>
        <Select
          id="clip-look"
          className="pick"
          value={edit?.lookId ?? ""}
          onChange={(e) => void save(e.target.value || null, edit?.lookId ? edit.strength : 0.8)}
        >
          <option value="">No look</option>
          {ordered.map((l) => (
            <option key={l.id} value={l.id}>{l.favorite ? `${l.favorite} · ` : ""}{l.name}</option>
          ))}
        </Select>
      </label>
      {edit?.lookId && (
        <label className="clip-row">
          <span className="meta">Strength {Math.round((edit.strength ?? 1) * 100)}%</span>
          <input
            id="clip-strength"
            type="range"
            min={0}
            max={100}
            value={Math.round((edit.strength ?? 1) * 100)}
            onChange={(e) => setEdit({ ...edit, strength: Number(e.target.value) / 100 })}
            onPointerUp={() => void save(edit.lookId, edit.strength)}
            onKeyUp={() => void save(edit.lookId, edit.strength)}
          />
        </label>
      )}
      <label className="clip-row">
        <span className="meta">Part</span>
        <Select id="clip-part" className="pick" value={part} onChange={(e) => setPart(e.target.value)}>
          <option value="whole">
            {trim ? `As trimmed · ${formatDuration(trim[0])}–${formatDuration(trim[1])}` : `The whole clip${photo.duration ? ` · ${formatDuration(photo.duration)}` : ""}`}
          </option>
          {moments.map((m) => (
            <option key={m.id} value={m.id}>Moment {formatDuration(m.start)}–{formatDuration(m.end)}</option>
          ))}
        </Select>
      </label>
      <div className="seg" role="group" aria-label="Clip size">
        {SIZES.map((s) => (
          <button key={s.id} type="button" aria-pressed={size === s.id} onClick={() => setSize(s.id)}>{s.label}</button>
        ))}
      </div>
      <div className="seg" role="group" aria-label="Size">
        {size === "original" && (
          <button type="button" aria-pressed={lv === srcShort} title={`The video's own size: ${srcW}×${srcH}`} onClick={() => setLevel("original")}>
            {srcShort >= 2160 ? "4K" : `${srcShort}p`}
          </button>
        )}
        {levels.map((l) => (
          <button key={l} type="button" aria-pressed={lv === l} onClick={() => setLevel(l)}>{l}p</button>
        ))}
      </div>
      <div className="seg" role="group" aria-label="Quality">
        {(["high", "standard", "small"] as Quality[]).map((q) => (
          <button key={q} type="button" aria-pressed={quality === q} onClick={() => setQuality(q)}>{q === "high" ? "High" : q === "standard" ? "Standard" : "Small"}</button>
        ))}
      </div>
      <button type="button" className="btn primary" disabled={progress != null} onClick={() => void exportClip()} title={`${outW}×${outH} · ${fps.toFixed(0)} fps · ${(bitrate / 1e6).toFixed(1)} Mb/s`}>
        {progress != null ? `Making the clip… ${Math.round(progress * 100)}%` : `Export ${outW}×${outH} · about ${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`}
      </button>
      <button type="button" className="link clip-original" disabled={saving} onClick={() => void saveOriginal()}>{saving ? "Copying the original…" : "Save the original file"}</button>
      <p className="meta" style={{ margin: 0 }}>Saved to Exports. Your video file is never changed.</p>
    </div>
  );
}
