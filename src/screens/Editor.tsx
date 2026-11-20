// The editor: pick a look (your presets, your LUTs, film emulations), shown
// live on your own photo; adjust the basics; copy settings across a whole set;
// export for Instagram. Everything is stored as settings; originals never change.
// Videos too: edited on the frame under the play head, exported as clips.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, imageUrl, showInFinder } from "../api";
import { slidersText } from "../lib/adjustments";
import { SECTIONS, signed, type SliderDef } from "../lib/sliders";
import { restoreLooks } from "../lib/looksUndo";
import { PostPopover } from "../components/Actions";
import { Thumb } from "../components/Thumb";
import { Hero, Icon, Popover, useToast, Select } from "../components/ui";
import { editsChanged } from "../gl/edited";
import { centreCrop, cropFor, EXPORTS, loadBitmap, loadLut, LookRenderer, ratioAspect, renderExport, renderVideoStill } from "../gl/renderer";
import { useFullFrame } from "../hooks/useFullFrame";
import { currentEffect, type Effect, EFFECTS, effectSettings } from "../lib/effects";
import { formatDuration } from "../lib/format";
import { digitOf, firstKeyLabel } from "../keymap";
import { useStore, type Route } from "../store";
import { NO_ADJUSTMENTS, type Adjustments, type FrameHint, type Look, type PhotoLook, type PhotoRow, type ReviewState } from "../types";
import "../styles/editor.css";

interface EditState {
  lookId: string | null;
  strength: number;
  adj: Adjustments;
}

const EMPTY: EditState = { lookId: null, strength: 1, adj: NO_ADJUSTMENTS };
// Copied settings live for the whole app session, across photos and screens.
let clipboard: EditState | null = null;

// What a paste carries over (Paste… chooses; ⌘V, ⌘⇧V and P use the choice).
type Part = "look" | "strength" | "light" | "wb" | "colour" | "effects" | "crop";
const PARTS: { id: Part; label: string; keys?: (keyof Adjustments)[] }[] = [
  { id: "look", label: "Look" },
  { id: "strength", label: "Look strength" },
  { id: "light", label: "Light: exposure to blacks", keys: ["exposure", "contrast", "highlights", "shadows", "whites", "blacks"] },
  { id: "wb", label: "White balance", keys: ["temperature", "tint"] },
  { id: "colour", label: "Vibrance and saturation", keys: ["vibrance", "saturation"] },
  { id: "effects", label: "Effects: grain, vignette, fade, halation…", keys: ["grain", "vignette", "fade", "soften", "halation", "fringe", "scanlines", "weave", "leak"] },
  { id: "crop", label: "Straighten and crop", keys: ["straighten", "cropX", "cropY", "cropZoom"] },
];
const CROP_KEYS = ["straighten", "cropX", "cropY", "cropZoom"] as const;
/** A photo's own straightening and crop, to keep when light and colour change. */
const cropOf = (adj?: Partial<Adjustments>) => Object.fromEntries(CROP_KEYS.map((k) => [k, adj?.[k] ?? 0])) as Pick<Adjustments, (typeof CROP_KEYS)[number]>;

// How the preview frames the photo (the export or the post decides the real ratio).
type FrameChoice = "whole" | "3:4" | "4:5" | "1:1" | "9:16";
const aspectOf = (f: FrameChoice) => (f === "9:16" ? 9 / 16 : ratioAspect(f));
/** A video's date taken plus `at` seconds, as a photo's date taken ("YYYY:MM:DD HH:MM:SS"). */
function takenAt(captured: string | null | undefined, at: number): string | undefined {
  const d = captured ? new Date(captured.length <= 10 ? `${captured}T00:00:00` : captured) : null;
  if (!d || Number.isNaN(d.getTime())) return undefined;
  d.setTime(d.getTime() + Math.floor(at) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// A video's export formats: its own shape (Full HD or 4K), or Instagram's.
const CLIP_EXPORTS: { id: string; label: string }[] = [
  { id: "original", label: "Original ratio · Full HD (1920)" },
  { id: "original-4k", label: "Original ratio · 4K (3840)" },
  { id: "9:16", label: "Reel / Story 9:16 · 1080 × 1920" },
  { id: "4:5", label: "Instagram 4:5 · 1080 × 1350" },
  { id: "3:4", label: "Instagram 3:4 · 1080 × 1440" },
  { id: "1:1", label: "Instagram 1:1 · 1080 × 1080" },
];
// The frame shown and the export format are one choice: Original ratio shows
// the whole photo in its own shape, Instagram 4:5 shows the 4:5 frame, and so on.
const PHOTO_FRAME: Record<string, FrameChoice> = { original: "whole", tall: "3:4", portrait: "4:5", square: "1:1", story: "9:16" };
const FRAME_EXPORT: Record<FrameChoice, string> = { whole: "original", "3:4": "tall", "4:5": "portrait", "1:1": "square", "9:16": "story" };
const CROP_SLIDERS: SliderDef[] = [
  { key: "straighten", label: "Straighten", min: -15, max: 15, step: 0.1, fmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}°` },
  { key: "cropZoom", label: "Zoom", min: 0, max: 100, step: 1 },
];
let pasteParts = new Set<Part>(PARTS.map((p) => p.id));
const allParts = (parts: Set<Part>) => PARTS.every((p) => parts.has(p.id));
/** `target` with the chosen parts of `src`; everything else stays as it was. */
function merge(target: EditState, src: EditState, parts: Set<Part>): EditState {
  const adj = { ...target.adj };
  for (const p of PARTS) if (parts.has(p.id) && p.keys) for (const k of p.keys) adj[k] = src.adj[k];
  return { lookId: parts.has("look") ? src.lookId : target.lookId, strength: parts.has("strength") ? src.strength : target.strength, adj };
}

const fromSaved = (pl: PhotoLook): EditState => ({ lookId: pl.lookId, strength: pl.strength, adj: { ...NO_ADJUSTMENTS, ...pl.adjustments } });
const sameEdit = (a: EditState, b: EditState) =>
  a.lookId === b.lookId && a.strength === b.strength && (Object.keys(NO_ADJUSTMENTS) as (keyof Adjustments)[]).every((k) => a.adj[k] === b.adj[k]);
// The library keeps an edit only while it has a look or a slider off zero.
const isEdited = (lookId: string | null, adj: Partial<Adjustments>) => !!lookId || Object.values(adj).some((v) => v !== 0);

type Compare = "look" | "split" | "original" | "instagram";

/** How Instagram shows a photo: the export, re-compressed as Instagram does, at phone size. */
async function instagramLook(bytes: Uint8Array): Promise<{ url: string; w: number; h: number; kb: number }> {
  const bmp = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
  const w = Math.min(1080, bmp.width);
  const h = Math.round((bmp.height * w) / bmp.width);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")?.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  // Instagram re-encodes uploads at roughly this quality.
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.74));
  if (!blob) throw new Error("could not make the preview");
  return { url: URL.createObjectURL(blob), w, h, kb: Math.round(blob.size / 1024) };
}

type ApplyMode = "auto" | "look" | "exact";
const APPLY_MODES: { id: ApplyMode; label: string; sub: string }[] = [
  { id: "auto", label: "Look + auto tone each", sub: "Light and colour measured per photo" },
  { id: "look", label: "Look only", sub: "Keeps each photo's own sliders" },
  { id: "exact", label: "Exact copy", sub: "The look and every slider" },
];
// Applying to more photos than this asks first.
const CONFIRM_OVER = 20;
// ↑ ↓ [ ] presses closer together than this are one undo step.
const LOOK_RUN_MS = 1500;

function Slider({ def, value, onChange, onCommit, onStart }: { def: SliderDef; value: number; onChange: (v: number) => void; onCommit: () => void; onStart: () => void }) {
  const fmt = def.fmt ?? signed;
  return (
    <label className={`slider ${def.cls ?? ""}${value !== 0 ? " changed" : ""}`} onDoubleClick={() => { onChange(0); onCommit(); }} title="Double-click to reset">
      <span className="label">
        <span>{def.label}</span>
        <output>{fmt(value)}</output>
      </span>
      <input
        type="range"
        min={def.min}
        max={def.max}
        step={def.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerDown={onStart}
        onKeyDown={(e) => !e.repeat && onStart()}
        onPointerUp={(e) => {
          onCommit();
          (e.currentTarget as HTMLInputElement).blur();
        }}
        onKeyUp={onCommit}
      />
    </label>
  );
}

/** No effect slider is set. */
const EFFECTS_OFF = (adj: Adjustments) => (Object.keys(effectSettings(null)) as (keyof Adjustments)[]).every((k) => !adj[k]);

/** Stops a video and lets go of its file. */
function closeClip(ref: { current: HTMLVideoElement | null }) {
  const v = ref.current;
  ref.current = null;
  if (!v) return;
  v.pause();
  v.removeAttribute("src");
  v.load();
}

/** Renders small previews of the current photo through each look, one at a time. */
class PreviewPool {
  private renderer: LookRenderer | null = null;
  private bitmap: ImageBitmap | null = null;
  private queue: { look: string | null; strength: number; adj?: Partial<Adjustments>; canvas: HTMLCanvasElement; gen: number }[] = [];
  private busy = false;
  gen = 0;
  adj: Adjustments = NO_ADJUSTMENTS;
  /** The open item is an S-Log3 clip: previews convert it first. */
  log = false;

  async setPhoto(id: string) {
    const gen = ++this.gen;
    this.queue = [];
    try {
      const bmp = await loadBitmap(imageUrl("thumb", id));
      if (gen !== this.gen) return bmp.close();
      this.bitmap?.close();
      this.bitmap = bmp;
      this.renderer ??= new LookRenderer();
      this.renderer.setImage(bmp);
    } catch {
      this.bitmap = null;
    }
  }

  request(look: string, canvas: HTMLCanvasElement) {
    this.enqueue({ look, strength: 1, canvas, gen: this.gen });
  }

  /** The photo with its own look and these effect settings on top. */
  requestEffect(adj: Partial<Adjustments>, canvas: HTMLCanvasElement, look: string | null, strength: number) {
    this.enqueue({ look, strength, adj, canvas, gen: this.gen });
  }

  private enqueue(job: PreviewPool["queue"][number]) {
    this.queue = this.queue.filter((j) => j.canvas !== job.canvas);
    this.queue.push(job);
    if (!this.busy) void this.pump();
  }

  private async pump() {
    this.busy = true;
    while (this.queue.length) {
      const job = this.queue.shift()!;
      if (job.gen !== this.gen || !this.bitmap || !this.renderer) continue;
      try {
        const data = job.look ? await loadLut(job.look) : undefined;
        if (job.gen !== this.gen || !this.bitmap) continue;
        const r = this.renderer;
        r.setLut(job.look, data);
        const px = job.canvas.width;
        r.render({ width: px, height: px, strength: job.strength, log: this.log, adjustments: { ...this.adj, grain: 0, ...job.adj }, crop: centreCrop(this.bitmap.width, this.bitmap.height, 1) });
        job.canvas.getContext("2d")?.drawImage(r.canvas, 0, 0);
        job.canvas.dataset.done = String(job.gen);
      } catch {
        /* not baked yet: the swatch stays */
      }
      if (this.queue.length % 6 === 0) await new Promise((res) => setTimeout(res, 0));
    }
    this.busy = false;
  }

  dispose() {
    this.queue = [];
    this.renderer?.dispose();
    this.bitmap?.close();
  }
}

/** One effect, shown on the photo with its look. */
const EffectTile = memo(function EffectTile({ effect, active, pool, gen, lookId, strength, onPick }: { effect: Effect; active: boolean; pool: PreviewPool; gen: number; lookId: string | null; strength: number; onPick: (e: Effect) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) pool.requestEffect({ ...effectSettings(effect), grain: 0 }, ref.current, lookId, strength);
  }, [gen, effect, lookId, strength, pool]);
  return (
    <div className="look-wrap">
      <button type="button" className="look" aria-pressed={active} onClick={() => onPick(effect)} title={effect.note}>
        <span className="pv">
          <canvas ref={ref} width={160} height={160} />
        </span>
        <span className="nm">{effect.name}</span>
      </button>
    </div>
  );
});

const LookTile = memo(function LookTile({ look, active, pool, gen, onPick, onFav, onHover }: { look: Look; active: boolean; pool: PreviewPool; gen: number; onPick: (l: Look) => void; onFav: (l: Look) => void; onHover: (id: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Resting on a look shows it on the photo; a quick pass over it does nothing.
  const hoverTimer = useRef<number | undefined>(undefined);
  const enter = () => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => onHover(look.id), 250);
  };
  const leave = () => {
    window.clearTimeout(hoverTimer.current);
    onHover(null);
  };
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (visible && ref.current && look.baked) pool.request(look.id, ref.current);
  }, [visible, gen, look.id, look.baked, pool]);
  return (
    <div className="look-wrap">
      <button
        type="button"
        className="look"
        data-look={look.id}
        aria-pressed={active}
        onClick={() => {
          leave();
          onPick(look);
        }}
        onMouseEnter={enter}
        onMouseLeave={leave}
        title={[look.name, look.author, look.collection].filter(Boolean).join(" · ")}
      >
        <span className="pv">
          {look.swatch.length > 0 && (
            <span className="swatch" aria-hidden="true">
              {look.swatch.map((c, i) => <i key={i} style={{ background: c }} />)}
            </span>
          )}
          <canvas ref={ref} width={112} height={112} style={{ position: "relative" }} />
          {look.favorite && <span className="key">{look.favorite}</span>}
        </span>
        <span className="nm">{look.name}</span>
      </button>
      <button
        type="button"
        className={look.favorite ? "fav on" : "fav"}
        aria-label={look.favorite ? `Unpin ${look.name} from key ${look.favorite}` : `Pin ${look.name} to a number key`}
        onClick={() => onFav(look)}
      >
        ★
      </button>
    </div>
  );
});

export function Editor({ route }: { route: Extract<Route, { name: "edit" }> }) {
  const { looks, reloadLooks, go, back, bump, mark, keymap, lastViewed } = useStore();
  const toast = useToast();
  const [ids, setIds] = useState<string[]>(route.ids);
  const [rows, setRows] = useState<Record<string, PhotoRow>>({});
  const [index, setIndex] = useState(route.index);
  const [edit, setEdit] = useState<EditState>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  // « Show original » from a right-click menu opens the editor showing the unedited picture.
  const [compare, setCompare] = useState<Compare>(() => {
    try {
      const asked = sessionStorage.getItem("cba.editor.compare");
      sessionStorage.removeItem("cba.editor.compare");
      if (asked === "original") return "original";
    } catch { /* fine */ }
    return "look";
  });
  const [holdOriginal, setHoldOriginal] = useState(false);
  const [split, setSplit] = useState(0.5);
  const [filter, setFilter] = useState("");
  // The left panel: LUTs (looks) or effects; the search opens from its icon.
  const [pane, setPane] = useState<"luts" | "effects">("luts");
  const [searching, setSearching] = useState(false);
  // The looks list opens on your favourites (all looks when none are pinned yet).
  const [pickedGroup, setGroup] = useState("favorites");
  const [exportId, setExportId] = useState(() => localStorage.getItem("export.format") ?? "tall");
  const [clipExport, setClipExport] = useState(() => localStorage.getItem("export.clip") ?? "original");
  // The "Instagram" view: made from the real export a moment after edits settle.
  const [ig, setIg] = useState<{ url: string; w: number; h: number; kb: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { full, toggle: toggleFull } = useFullFrame();
  const [progress, setProgress] = useState<string | null>(null);
  const [applyMenu, setApplyMenu] = useState(false);
  const [pasteMenu, setPasteMenu] = useState(false);
  const [parts, setParts] = useState<Set<Part>>(() => new Set(pasteParts));
  const chooseParts = (next: Set<Part>) => {
    pasteParts = next;
    setParts(next);
  };
  const [confirmAll, setConfirmAll] = useState<{ mode: ApplyMode; paste: boolean } | null>(null);
  const [postAt, setPostAt] = useState<HTMLElement | null>(null);
  const [revealTick, setRevealTick] = useState(0);
  const [gen, setGen] = useState(0);
  const history = useRef<EditState[]>([]);
  const future = useRef<EditState[]>([]);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Dragging the photo inside its frame moves the crop.
  const pan = useRef<{ x: number; y: number; cropX: number; cropY: number; w: number; h: number } | null>(null);
  const shownCrop = useRef<[number, number, number, number]>([0, 0, 1, 1]);
  const renderer = useRef<LookRenderer | null>(null);
  const bitmap = useRef<ImageBitmap | null>(null);
  // What's drawn: the photo, or the video's current frame.
  const source = useRef<{ width: number; height: number } | null>(null);
  // A video: the element its frames come from, its length, and the play head.
  const video = useRef<HTMLVideoElement | null>(null);
  const [clip, setClip] = useState<{ duration: number } | null>(null);
  const [clipTime, setClipTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [clipProgress, setClipProgress] = useState<number | null>(null);

  // A video's smooth copy for editing: how far it is (null when it's there or not needed).
  const [copying, setCopying] = useState<number | null>(null);
  // An online-only video playing straight from Google Drive, and how to make its smooth copy.
  const [streaming, setStreaming] = useState(false);
  // Showing an online clip's light preview (720p, S-Log3 already converted)
  // until a smooth copy is made: instant, and not converted a second time.
  const [onPreview, setOnPreview] = useState(false);
  const smoothCopy = useRef<(() => void) | null>(null);
  // A video's trim: the part that's used. null: the whole clip.
  const [trim, setTrimState] = useState<[number, number] | null>(null);
  const trimRef = useRef(trim);
  trimRef.current = trim;
  const [frameTick, setFrameTick] = useState(0);
  // Filmed in S-Log3: shown (and exported) in normal colour.
  const [log, setLog] = useState(false);
  const drawRef = useRef<(seed?: number) => void>(() => {});
  const pool = useMemo(() => new PreviewPool(), []);
  const [stage, setStage] = useState({ w: 800, h: 600 });
  const saveTimer = useRef<number | undefined>(undefined);
  const id = ids[index];
  const row = id ? rows[id] : undefined;
  const pickExport = (v: string) => {
    setExportId(v);
    try {
      localStorage.setItem("export.format", v);
    } catch {
      /* this visit only */
    }
  };
  const pickClipExport = (v: string) => {
    setClipExport(v);
    try {
      localStorage.setItem("export.clip", v);
    } catch {
      /* this visit only */
    }
  };
  const frame: FrameChoice = row?.isVideo ? (clipExport.startsWith("original") ? "whole" : (clipExport as FrameChoice)) : (PHOTO_FRAME[exportId] ?? "whole");
  const setFrame = (f: FrameChoice) => (row?.isVideo ? pickClipExport(f === "whole" ? "original" : f) : pickExport(FRAME_EXPORT[f]));
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // Back in Pictures, the photo page opens on the photo you ended on.
  useEffect(() => {
    if (id) lastViewed.current = id;
  }, [id, lastViewed]);
  // Which photo `edit` belongs to: until a photo's saved edit has loaded,
  // nothing may be saved onto it (it would get the previous photo's settings).
  const editFor = useRef<string | null>(null);
  const lastCommitted = useRef<EditState>(EMPTY);
  const idRef = useRef(id);
  idRef.current = id;
  const editRef = useRef(edit);
  editRef.current = edit;
  // When the last ↑ ↓ look step happened, to fold a run of them into one undo.
  const lastStep = useRef(0);
  const bulkRunning = useRef(false);
  const applyRef = useRef<HTMLDivElement>(null);
  const looksListRef = useRef<HTMLDivElement>(null);
  const nowRef = useRef<HTMLButtonElement>(null);

  // No photos given: edit what most likely needs it.
  useEffect(() => {
    if (ids.length) return;
    (async () => {
      let list = await api.photoIds({ smart: "not_edited_selected", order: "newest" }, 0, 2000);
      if (!list.length) list = await api.photoIds({ review: "selected", order: "newest" }, 0, 2000);
      setIds(list);
      setIndex(0);
    })().catch(() => {});
  }, [ids.length]);

  useEffect(() => {
    if (!ids.length) return;
    api.rows(ids.slice(0, 2000)).then((r) => {
      setRows(Object.fromEntries(r.map((x) => [x.id, x])));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  useEffect(() => () => {
    pool.dispose();
    renderer.current?.dispose();
    bitmap.current?.close();
    closeClip(video);
    bump();
  }, [pool, bump]);

  // Load the photo, its saved edit, and point the look previews at it.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoaded(false);
    // A pending "apply to all?" would otherwise run with this photo's look.
    setConfirmAll(null);
    editFor.current = null;
    history.current = [];
    future.current = [];
    lastStep.current = 0;
    api.photoLook(id).then((pl) => {
      if (cancelled) return;
      const loadedEdit = fromSaved(pl);
      setEdit(loadedEdit);
      lastCommitted.current = loadedEdit;
      editFor.current = id;
      setLog(!!pl.log);
      if (pool.log !== !!pl.log) {
        pool.log = !!pl.log;
        setGen((g) => g + 1);
      }
    }).catch(() => {
      // Never fall back to an empty edit that could then be saved over the real one.
      if (!cancelled) toast("Couldn't read this photo's edit; changes are off until it loads", { error: true });
    });
    closeClip(video);
    setClip(null);
    setPlaying(false);
    setCopying(null);
    setStreaming(false);
    setOnPreview(false);
    setTrimState(null);
    const known = rowsRef.current[id];
    (known ? Promise.resolve(known) : api.rows([id]).then((r) => r[0])).then((r) => {
      if (cancelled) return;
      const isVideo = !!r?.isVideo;
      // Online-only (Google Drive): it plays straight from Drive; the smooth
      // copy (a full download) only when asked, so it never holds up playing.
      if (isVideo) return openClip(id, () => cancelled, r?.storage === "cloud_only");
      loadBitmap(imageUrl("preview", id))
        .then((bmp) => {
          if (cancelled) return bmp.close();
          renderer.current ??= new LookRenderer(canvasRef.current!);
          renderer.current.setImage(bmp);
          bitmap.current?.close();
          bitmap.current = bmp;
          source.current = { width: bmp.width, height: bmp.height };
          setLoaded(true);
        })
        .catch(() => toast("This photo has no preview: it's online-only and couldn't be fetched right now", { error: true }));
    }).catch(() => {});
    pool.setPhoto(id).then(() => !cancelled && setGen((g) => g + 1));
    return () => {
      cancelled = true;
      closeClip(video);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, pool, toast]);

  // A video is edited on one frame at a time: the one under the play head,
  // drawn through the same renderer as photos. Playing draws every frame,
  // each with its own grain, like the exported clip.
  function openClip(clipId: string, stale: () => boolean, online = false) {
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.loop = true;
    video.current = v;
    const mine = () => !stale() && video.current === v;
    const show = (seed?: number) => {
      if (!mine() || !v.videoWidth) return;
      renderer.current ??= new LookRenderer(canvasRef.current!);
      try {
        renderer.current.setImage(v);
      } catch {
        return toast("This video's frames can't be shown here", { error: true });
      }
      source.current = { width: v.videoWidth, height: v.videoHeight };
      if (seed == null) {
        setLoaded(true);
        setFrameTick((t) => t + 1);
      } else {
        drawRef.current(seed);
      }
    };
    const everyFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
      if (!mine() || v.paused) return;
      show(17 + meta.presentedFrames);
      v.requestVideoFrameCallback(everyFrame);
    };
    v.addEventListener("loadedmetadata", () => {
      if (!mine()) return;
      setClip({ duration: v.duration || 0 });
      v.currentTime = Math.min(1, (v.duration || 0) / 2);
    });
    // Right after a seek WebKit may not have decoded the frame yet (it draws
    // black), so draw again when the frame is shown, and once more a moment later.
    v.addEventListener("seeked", () => {
      if (!mine()) return;
      setClipTime(v.currentTime);
      show();
      v.requestVideoFrameCallback(() => show());
      window.setTimeout(() => v.paused && show(), 120);
      window.setTimeout(() => v.paused && show(), 400);
    });
    v.addEventListener("timeupdate", () => {
      if (!mine()) return;
      setClipTime(v.currentTime);
      // Playing goes round inside the trim.
      const t = trimRef.current;
      if (t && !v.paused && (v.currentTime >= t[1] || v.currentTime < t[0] - 0.05)) v.currentTime = t[0];
    });
    v.addEventListener("play", () => {
      if (!mine()) return;
      setPlaying(true);
      v.requestVideoFrameCallback(everyFrame);
    });
    v.addEventListener("pause", () => {
      if (!mine()) return;
      setPlaying(false);
      show();
    });
    v.addEventListener("error", () => mine() && toast("This video couldn't be opened: it may be online-only and Google Drive isn't reachable", { error: true }));
    // The smooth copy when it's there; the original meanwhile.
    // An online clip with a light preview shows that at once; otherwise the
    // smooth copy when there is one, else the original.
    const startSrc = (preview: boolean) => {
      setOnPreview(preview);
      v.src = preview ? imageUrl("video", clipId) : imageUrl("editvideo", clipId);
    };
    if (online) {
      invoke<boolean>("review_copy_exists", { photoId: clipId })
        .then((has) => mine() && startSrc(has))
        .catch(() => mine() && startSrc(false));
    } else {
      startSrc(false);
    }
    api.videoTrim(clipId).then((t) => mine() && setTrimState(t)).catch(() => {});
    // Make the smooth copy (it downloads the original from Drive), then
    // switch to it at the same moment. Online-only videos wait for the button.
    const makeCopy = () => {
    setStreaming(false);
    setCopying(0);
    let off: (() => void) | undefined;
    listen<{ photoId: string; fraction: number }>("edit-copy-progress", (e) => {
      if (e.payload.photoId === clipId && mine()) setCopying(e.payload.fraction);
    }).then((u) => (mine() ? (off = u) : u())).catch(() => {});
    api.editCopy(clipId)
      .then(() => {
        if (!mine()) return;
        const at = v.currentTime;
        const wasPlaying = !v.paused;
        setOnPreview(false);
        v.src = `${imageUrl("editvideo", clipId)}?smooth=1`;
        v.currentTime = at;
        if (wasPlaying) void v.play().catch(() => {});
      })
      .catch((e) => mine() && toast(`Playing from the original: ${errorText(e)}`, { error: true }))
      .finally(() => {
        off?.();
        if (mine()) setCopying(null);
      });
    };
    smoothCopy.current = makeCopy;
    if (online) setStreaming(true);
    else makeCopy();
  }
  const setTrim = (next: [number, number] | null) => {
    if (!id) return;
    setTrimState(next);
    api.setVideoTrim(id, next?.[0] ?? null, next?.[1] ?? null).catch((e) => toast(errorText(e), { error: true }));
  };
  // I and O: the trim starts or ends at the play head.
  const trimAt = (side: "in" | "out") => {
    const v = video.current;
    if (!v || !clip) return;
    const [a, b] = trim ?? [0, clip.duration];
    const t = v.currentTime;
    setTrim(side === "in" ? [Math.min(t, b - 0.1), b] : [a, Math.max(t, a + 0.1)]);
  };
  const togglePlay = () => {
    const v = video.current;
    if (!v) return;
    if (!v.paused) return v.pause();
    v.muted = false;
    void v.play().catch(() => {});
  };
  const seekClip = (t: number) => {
    const v = video.current;
    if (!v) return;
    v.pause();
    v.currentTime = t;
    setClipTime(t);
  };

  // The filmstrip keeps the current photo in view.
  useEffect(() => {
    nowRef.current?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [index, ids]);

  // A look chosen by key is scrolled into view in the list.
  useEffect(() => {
    if (revealTick) looksListRef.current?.querySelector<HTMLElement>('.look[aria-pressed="true"]')?.scrollIntoView({ block: "nearest" });
  }, [revealTick]);

  // A look the pointer rests on is shown on the photo without being applied.
  const [hoverLook, setHoverLook] = useState<string | null>(null);
  const shownLook = hoverLook ?? edit.lookId;
  const shownStrength = hoverLook && hoverLook !== edit.lookId ? 1 : edit.strength;
  useEffect(() => setHoverLook(null), [id]);

  // Look table for the main view.
  const [lutReady, setLutReady] = useState(0);
  useEffect(() => {
    const look = shownLook;
    if (!look || !renderer.current) return;
    if (renderer.current.hasLut(look)) return setLutReady((n) => n + 1);
    let cancelled = false;
    loadLut(look).then((data) => {
      if (cancelled || !renderer.current) return;
      renderer.current.setLut(look, data);
      setLutReady((n) => n + 1);
    }).catch(() => toast("That look could not be loaded", { error: true }));
    return () => {
      cancelled = true;
    };
  }, [shownLook, loaded, toast]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Draw. A playing video calls this for each frame, with that frame's grain.
  drawRef.current = (seed?: number) => {
    const r = renderer.current;
    const bmp = source.current;
    if (!r || !bmp || !loaded) return;
    {
      // The original is shown whole; otherwise the photo as framed (straightened, cropped).
      const bare = holdOriginal || compare === "original";
      const fr = bare ? { crop: [0, 0, 1, 1] as [number, number, number, number], rotate: 0 } : cropFor(bmp.width, bmp.height, frame === "whole" ? null : aspectOf(frame), edit.adj);
      shownCrop.current = fr.crop;
      const cw = bmp.width * fr.crop[2];
      const ch = bmp.height * fr.crop[3];
      const scale = Math.min((stage.w - 16) / cw, (stage.h - 16) / ch, 4);
      const cssW = Math.max(1, Math.floor(cw * scale));
      const cssH = Math.max(1, Math.floor(ch * scale));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.min(Math.round(cssW * dpr), Math.round(cw * 2));
      const h = Math.round((w * cssH) / cssW);
      r.setLut(shownLook && r.hasLut(shownLook) ? shownLook : null);
      r.render({
        width: w,
        height: h,
        adjustments: edit.adj,
        strength: shownStrength,
        original: bare,
        split: compare === "split" && !holdOriginal ? split : -1,
        crop: fr.crop,
        rotate: fr.rotate,
        log: log && !onPreview,
        seed,
      });
      if (canvasRef.current) {
        canvasRef.current.style.width = `${cssW}px`;
        canvasRef.current.style.height = `${cssH}px`;
      }
    }
  };
  useEffect(() => {
    const raf = requestAnimationFrame(() => drawRef.current());
    return () => cancelAnimationFrame(raf);
  }, [edit, loaded, stage, compare, split, holdOriginal, lutReady, shownLook, shownStrength, frame, frameTick, log, onPreview]);
  // How far a clip export is.
  useEffect(() => {
    if (busy !== "export") return setClipProgress(null);
    let off: (() => void) | undefined;
    let live = true;
    listen<{ photoId: string; fraction: number }>("clip-progress", (e) => setClipProgress(e.payload.fraction))
      .then((u) => (live ? (off = u) : u()))
      .catch(() => {});
    return () => {
      live = false;
      off?.();
    };
  }, [busy]);
  // Back to the photo view when moving from a video (it has no Instagram view).
  useEffect(() => {
    if (clip && compare === "instagram") setCompare("look");
  }, [clip, compare]);

  // The "Instagram" view: made from the real export a moment after edits settle.
  useEffect(() => {
    if (compare !== "instagram" || !id || !loaded) return;
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const spec = (EXPORTS.find((x) => x.id === exportId) ?? EXPORTS[0]).spec;
        const bytes = await renderExport(imageUrl("full", id), edit.lookId, edit.strength, edit.adj, spec);
        const made = await instagramLook(bytes);
        if (cancelled) return URL.revokeObjectURL(made.url);
        setIg((old) => {
          if (old) URL.revokeObjectURL(old.url);
          return made;
        });
      } catch (err) {
        if (!cancelled) toast(errorText(err), { error: true });
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [compare, id, loaded, edit, exportId, toast]);

  // Look previews follow the sliders, a moment after you stop.
  useEffect(() => {
    const t = window.setTimeout(() => {
      pool.adj = edit.adj;
      pool.gen++;
      setGen((g) => g + 1);
    }, 350);
    return () => window.clearTimeout(t);
  }, [edit.adj, pool]);

  // The filmstrip dots follow what is saved.
  const markEditedMany = useCallback((edited: Record<string, boolean>) => {
    setRows((r) => {
      const next = { ...r };
      for (const [pid, on] of Object.entries(edited)) if (next[pid]) next[pid] = { ...next[pid], edited: on };
      return next;
    });
  }, []);
  const markEdited = useCallback((pid: string, edited: boolean) => {
    setRows((r) => (r[pid] && r[pid].edited !== edited ? { ...r, [pid]: { ...r[pid], edited } } : r));
  }, []);

  // Saves a moment after the last change; a pending save for another photo is
  // sent straight away, so quick edits across photos are never dropped.
  const pendingSave = useRef<{ photo: string; edit: EditState } | null>(null);
  const flushSave = useCallback(async () => {
    window.clearTimeout(saveTimer.current);
    const p = pendingSave.current;
    pendingSave.current = null;
    if (!p) return;
    try {
      await api.applyLook([p.photo], p.edit.lookId, p.edit.strength, p.edit.adj);
      markEdited(p.photo, isEdited(p.edit.lookId, p.edit.adj));
    } catch (err) {
      toast(errorText(err), { error: true });
    }
  }, [toast, markEdited]);
  const save = useCallback((photo: string, e: EditState) => {
    if (pendingSave.current && pendingSave.current.photo !== photo) void flushSave();
    pendingSave.current = { photo, edit: e };
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flushSave, 250);
  }, [flushSave]);
  const flushRef = useRef(flushSave);
  flushRef.current = flushSave;
  useEffect(() => () => {
    void flushRef.current();
  }, []);

  // While an apply to all runs, edits wait: the loop would overwrite them, or
  // a photo loaded mid-run would save its old look back.
  const lastBusyNote = useRef(0);
  const blockedByBulk = useCallback(() => {
    if (!bulkRunning.current) return false;
    if (Date.now() - lastBusyNote.current > 2500) {
      lastBusyNote.current = Date.now();
      toast("Applying to the whole set… one moment");
    }
    return true;
  }, [toast]);

  const change = useCallback((next: EditState, commit = true) => {
    if (!id || editFor.current !== id || blockedByBulk()) return;
    lastStep.current = 0; // any other edit ends a run of look steps
    lastCommitted.current = next;
    setEdit((cur) => {
      if (commit) {
        history.current.push(cur);
        if (history.current.length > 100) history.current.shift();
        future.current = [];
      }
      return next;
    });
    if (id) save(id, next);
  }, [id, save, blockedByBulk]);

  const slide = (key: keyof Adjustments, v: number) => {
    if (!id || editFor.current !== id || blockedByBulk()) return;
    setEdit((cur) => {
      const next = { ...cur, adj: { ...cur.adj, [key]: v } };
      if (id) save(id, next);
      return next;
    });
  };
  // Several values at once while dragging (the crop's centre); undo like a slider.
  const slideMany = (patch: Partial<Adjustments>) => {
    if (!id || editFor.current !== id || blockedByBulk()) return;
    setEdit((cur) => {
      const next = { ...cur, adj: { ...cur.adj, ...patch } };
      if (id) save(id, next);
      return next;
    });
  };
  const commitSlide = () => {
    history.current.push(lastCommitted.current);
    future.current = [];
    lastStep.current = 0;
  };
  // The state before a slider drag starts, for undo: taken when the drag begins.
  const startSlide = () => {
    lastCommitted.current = edit;
  };

  // Every way of choosing a look goes through here. `toggle`: choosing the
  // current look again removes it (clicks do that, keys don't). `commit: false`
  // folds this into the previous undo step.
  const applyLookId = useCallback((lookId: string | null, { toggle = false, commit = true } = {}) => {
    const next = toggle && edit.lookId === lookId ? null : lookId;
    if (next === edit.lookId) return;
    // A preset's grain and vignette come along as starting points, never over your own:
    // a value still at zero, or still what the previous look brought, belongs to the look.
    const was = looks.find((l) => l.id === edit.lookId);
    const look = looks.find((l) => l.id === next);
    // One of your saved looks is a whole edit: its sliders come along too
    // (its strength is in the look itself); the photo keeps its own framing.
    if (look?.kind === "saved" && look.adjustments) {
      const { straighten, cropX, cropY, cropZoom } = edit.adj;
      change({ ...edit, lookId: next, strength: 1, adj: { ...NO_ADJUSTMENTS, ...look.adjustments, straighten, cropX, cropY, cropZoom } }, commit);
      return;
    }
    const adj = { ...edit.adj };
    for (const k of ["grain", "vignette"] as const) {
      if (adj[k] === 0 || adj[k] === (was?.effects[k] ?? 0)) adj[k] = look?.effects[k] ?? 0;
    }
    change({ ...edit, lookId: next, adj }, commit);
  }, [change, edit, looks]);
  const pickLook = useCallback((look: Look | null) => applyLookId(look?.id ?? null, { toggle: true }), [applyLookId]);
  // An effect sets every effect slider (the look, light and colour stay).
  const pickEffect = useCallback((fx: Effect | null) => {
    const cur = editRef.current;
    change({ ...cur, adj: { ...cur.adj, ...effectSettings(fx) } });
  }, [change]);

  // This edit as one of your looks (the look under it, its strength and every
  // slider), then on this photo, so the photo and its album know it by name.
  // What the arrow keys move through: the photos, until you click in the
  // looks panel (then the looks grid), and the photos again after a click
  // anywhere else.
  const [arrowsFor, setArrowsFor] = useState<"photos" | "looks">("photos");
  const [saveAt, setSaveAt] = useState<HTMLElement | null>(null);
  const [lookName, setLookName] = useState("");
  const saveAsLook = async () => {
    const name = lookName.trim();
    if (!name || !id) return;
    try {
      const look = await api.saveLook(name, edit.lookId, edit.strength, edit.adj);
      setSaveAt(null);
      setLookName("");
      reloadLooks();
      const { straighten, cropX, cropY, cropZoom } = edit.adj;
      change({ ...edit, lookId: look.id, strength: 1, adj: { ...NO_ADJUSTMENTS, ...look.adjustments, straighten, cropX, cropY, cropZoom } });
      toast(`Saved “${look.name}” in Your looks`);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };

  const auto = useCallback(async () => {
    if (!id) return;
    const forId = id;
    const base = edit;
    try {
      const a = await api.autoAdjust(forId);
      const next = { ...base, adj: { ...a, grain: base.adj.grain, vignette: base.adj.vignette, ...cropOf(base.adj) } };
      if (idRef.current !== forId) {
        // You moved on meanwhile: save it to the photo it was for, leave this one alone.
        await api.applyLook([forId], next.lookId, next.strength, next.adj);
        markEdited(forId, isEdited(next.lookId, next.adj));
        toast("Auto tone applied to the previous photo");
        return;
      }
      change(next);
      toast("Auto tone applied — tweak from here");
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  }, [id, edit, change, toast, markEdited]);

  const undo = () => {
    if (blockedByBulk()) return;
    const prev = history.current.pop();
    if (!prev) return;
    lastStep.current = 0;
    future.current.push(edit);
    setEdit(prev);
    if (id) save(id, prev);
  };
  const redo = () => {
    if (blockedByBulk()) return;
    const next = future.current.pop();
    if (!next) return;
    lastStep.current = 0;
    history.current.push(edit);
    setEdit(next);
    if (id) save(id, next);
  };

  // After a change to the whole set, show what is now saved on this photo;
  // ⌘Z brings back what was on screen before.
  const reloadCurrent = async () => {
    const pid = idRef.current;
    if (!pid) return;
    await flushRef.current();
    const saved = fromSaved(await api.photoLook(pid));
    if (idRef.current !== pid || editFor.current !== pid) return;
    const shown = editRef.current;
    if (!sameEdit(shown, saved)) {
      history.current.push(shown);
      future.current = [];
    }
    lastStep.current = 0;
    lastCommitted.current = saved;
    setEdit(saved);
  };

  // Puts every photo back as it was before an "apply to all". Photos that had
  // the same edit go back together.
  const restore = async (snapshot: PhotoLook[]) => {
    if (bulkRunning.current) return toast("Wait for the apply to finish, then Undo");
    bulkRunning.current = true;
    setBusy("sync");
    try {
      await flushRef.current();
      await restoreLooks(snapshot);
      markEditedMany(Object.fromEntries(snapshot.map((s) => [s.photoId, isEdited(s.lookId, s.adjustments)])));
      await reloadCurrent();
      editsChanged();
      bump();
      toast(`Undone on ${snapshot.length.toLocaleString()} photos`);
    } catch (e) {
      toast(errorText(e), { error: true });
    } finally {
      bulkRunning.current = false;
      setBusy(null);
    }
  };

  // One look on the whole set. `auto`: the look plus auto tone measured per
  // photo; `look`: only the look, each photo keeps its sliders; `exact`: the
  // look and every slider. `paste` uses the copied settings (⌘⇧V).
  const applyAll = async (mode: ApplyMode, paste = false) => {
    const src = paste ? clipboard : edit;
    // Never spread a photo's settings before they have loaded.
    if (!src || ids.length < 2 || bulkRunning.current || (!paste && editFor.current !== id)) return;
    const set = ids;
    bulkRunning.current = true;
    setBusy("sync");
    let snapshot: PhotoLook[] | null = null;
    const edited: Record<string, boolean> = {};
    try {
      await flushRef.current();
      snapshot = await api.photoLooks(set);
      const before = new Map(snapshot.map((s) => [s.photoId, s]));
      let notMeasured = 0;
      if (mode === "auto") {
        for (const [i, pid] of set.entries()) {
          setProgress(`Auto toning ${i + 1}/${set.length}…`);
          let adj: Adjustments | undefined;
          try {
            const a = await api.autoAdjust(pid);
            adj = { ...a, grain: src.adj.grain, vignette: src.adj.vignette, ...cropOf(before.get(pid)?.adjustments) };
          } catch {
            notMeasured++; // not measured yet: the look alone, its sliders stay
          }
          await api.applyLook([pid], src.lookId, src.strength, adj);
          edited[pid] = isEdited(src.lookId, adj ?? before.get(pid)?.adjustments ?? {});
        }
      } else if (paste && !allParts(pasteParts)) {
        // Only the chosen parts: every photo keeps the rest of its own edit.
        for (const [i, pid] of set.entries()) {
          if (i % 25 === 0) setProgress(`Pasting ${i + 1}/${set.length}…`);
          const own = before.get(pid);
          const next = merge(own ? fromSaved(own) : EMPTY, src, pasteParts);
          await api.applyLook([pid], next.lookId, next.strength, next.adj);
          edited[pid] = isEdited(next.lookId, next.adj);
        }
      } else {
        await api.applyLook(set, src.lookId, src.strength, mode === "exact" ? src.adj : undefined);
        for (const pid of set) edited[pid] = isEdited(src.lookId, mode === "exact" ? src.adj : before.get(pid)?.adjustments ?? {});
      }
      markEditedMany(edited);
      const snap = snapshot;
      await reloadCurrent();
      editsChanged();
      toast(`Applied to ${set.length.toLocaleString()}${notMeasured ? ` · ${notMeasured.toLocaleString()} not measured yet, look only` : ""}`, {
        action: { label: "Undo", run: () => void restore(snap) },
      });
    } catch (e) {
      // Stopped part-way: what did change can still be undone.
      const snap = snapshot;
      markEditedMany(edited);
      if (snap) void reloadCurrent().catch(() => {});
      toast(errorText(e), { error: true, action: snap ? { label: "Undo", run: () => void restore(snap) } : undefined });
    } finally {
      bulkRunning.current = false;
      setBusy(null);
      setProgress(null);
    }
  };
  // Straighten (level the horizon) or centre on the subject, from Apple's
  // image analysis of the preview on this Mac.
  const frameOne = async (what: "level" | "subject") => {
    if (!id) return;
    try {
      const [hint] = await api.frameHints([id]);
      if (what === "level") {
        const h = hint?.horizon;
        if (h == null || Math.abs(h) < 0.3) return toast(h == null ? "No horizon found in this photo" : "Already level");
        change({ ...edit, adj: { ...edit.adj, straighten: Math.max(-15, Math.min(15, Math.round(h * 10) / 10)) } });
        return toast(`Straightened ${h > 0 ? "clockwise" : "anticlockwise"} by ${Math.abs(h).toFixed(1)}°`);
      }
      const box = hint?.subject;
      if (!box) return toast("No clear subject found in this photo");
      if (frame === "whole") setFrame("3:4");
      change({ ...edit, adj: { ...edit.adj, cropX: Math.round((box[0] + box[2] / 2 - 0.5) * 1000) / 10, cropY: Math.round((box[1] + box[3] / 2 - 0.5) * 1000) / 10 } });
      toast("Framed on the subject");
    } catch (err) {
      toast(errorText(err), { error: true });
    }
  };
  // Every photo of the set straightened and framed on its own subject; each
  // keeps its look and sliders. Undo in the toast.
  const frameAll = async () => {
    if (ids.length < 2 || bulkRunning.current) return;
    setApplyMenu(false);
    bulkRunning.current = true;
    setBusy("sync");
    let snapshot: PhotoLook[] | null = null;
    try {
      await flushRef.current();
      snapshot = await api.photoLooks(ids);
      const before = new Map(snapshot.map((x) => [x.photoId, x]));
      const hints = new Map<string, FrameHint>();
      for (let i = 0; i < ids.length; i += 40) {
        setProgress(`Looking at ${Math.min(ids.length, i + 40)}/${ids.length}…`);
        for (const h of await api.frameHints(ids.slice(i, i + 40))) hints.set(h.photoId, h);
      }
      const edited: Record<string, boolean> = {};
      let done = 0;
      for (const [i, pid] of ids.entries()) {
        const hint = hints.get(pid);
        if (!hint) continue;
        if (i % 25 === 0) setProgress(`Framing ${i + 1}/${ids.length}…`);
        const own = before.get(pid);
        const cur = own ? fromSaved(own) : EMPTY;
        const h = hint.horizon != null && Math.abs(hint.horizon) >= 0.3 ? Math.max(-15, Math.min(15, Math.round(hint.horizon * 10) / 10)) : cur.adj.straighten;
        const box = hint.subject;
        const adj = {
          ...cur.adj,
          straighten: h,
          cropX: box ? Math.round((box[0] + box[2] / 2 - 0.5) * 1000) / 10 : cur.adj.cropX,
          cropY: box ? Math.round((box[1] + box[3] / 2 - 0.5) * 1000) / 10 : cur.adj.cropY,
        };
        await api.applyLook([pid], cur.lookId, cur.strength, adj);
        edited[pid] = isEdited(cur.lookId, adj);
        done++;
      }
      markEditedMany(edited);
      const snap = snapshot;
      await reloadCurrent();
      editsChanged();
      toast(`${done.toLocaleString()} straightened and framed${done < ids.length ? ` · ${ids.length - done} without a preview on this Mac yet` : ""}`, {
        action: { label: "Undo", run: () => void restore(snap) },
      });
    } catch (e) {
      const snap = snapshot;
      toast(errorText(e), { error: true, action: snap ? { label: "Undo", run: () => void restore(snap) } : undefined });
    } finally {
      bulkRunning.current = false;
      setBusy(null);
      setProgress(null);
    }
  };
  const sameAsPrevious = async () => {
    if (index === 0) return toast("This is the first photo of the set");
    try {
      const prev = fromSaved(await api.photoLook(ids[index - 1]));
      change(merge(edit, prev, pasteParts));
      toast(allParts(pasteParts) ? "Same as the previous photo" : "The chosen parts of the previous photo");
    } catch (err) {
      toast(errorText(err), { error: true });
    }
  };
  // Large sets ask first.
  const requestApply = (mode: ApplyMode, paste = false) => {
    setApplyMenu(false);
    if (ids.length > CONFIRM_OVER) return setConfirmAll({ mode, paste });
    void applyAll(mode, paste);
  };

  const favorites = useMemo(() => looks.filter((l) => l.favorite).sort((a, b) => (a.favorite ?? 0) - (b.favorite ?? 0)), [looks]);
  const group = pickedGroup === "favorites" && looks.length > 0 && !favorites.length ? "all" : pickedGroup;
  const toggleFav = async (look: Look) => {
    const ordered = favorites.map((f) => f.id).filter((f) => f !== look.id);
    if (!look.favorite) {
      if (ordered.length >= 9) return toast("Nine favourites max: unpin one first");
      ordered.push(look.id);
    }
    await api.setLookFavorites(ordered);
    reloadLooks();
  };

  const collections = useMemo(() => [...new Set(looks.map((l) => l.collection))], [looks]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return looks.filter(
      (l) =>
        (group === "all" || (group === "favorites" ? !!l.favorite : l.collection === group)) &&
        (!q || `${l.name} ${l.author} ${l.collection}`.toLowerCase().includes(q)),
    );
  }, [looks, filter, group]);
  const grouped = useMemo(() => {
    const m = new Map<string, Look[]>();
    for (const l of shown) m.set(l.collection, [...(m.get(l.collection) ?? []), l]);
    return [...m.entries()];
  }, [shown]);
  const current = looks.find((l) => l.id === edit.lookId);

  const exportOne = async () => {
    if (!id || !row) return;
    const spec = EXPORTS.find((x) => x.id === exportId) ?? EXPORTS[0];
    setBusy("export");
    try {
      if (row.isVideo) {
        // The clip is made from the saved edit: save what's on screen first.
        await flushRef.current();
        const stem = row.filename.replace(/\.[^.]+$/, "");
        const path = await api.exportClip(id, clipExport, null, null, `${stem}${current ? ` - ${current.name}` : ""}`, false);
        showInFinder(path);
        toast(`Exported ${path.split("/").pop()}`, { action: { label: "Show in Finder", run: () => api.reveal(path) } });
        return;
      }
      const bytes = await renderExport(imageUrl("full", id), edit.lookId, edit.strength, edit.adj, spec.spec);
      const stem = row.filename.replace(/\.[^.]+$/, "");
      const path = await api.exportImage(bytes, `${stem}${current ? ` - ${current.name}` : ""}`);
      showInFinder(path);
      toast(`Exported ${path.split("/").pop()}`, { action: { label: "Show in Finder", run: () => api.reveal(path) } });
    } catch (e) {
      toast(`Export failed: ${errorText(e)}`, { error: true });
    } finally {
      setBusy(null);
    }
  };

  // A video's frame under the play head as a photo in Exports: full size from
  // the original, with the edit and the frame chosen, dated at that moment.
  const exportStill = async () => {
    const v = video.current;
    if (!id || !row?.isVideo || !v || busy) return;
    const at = v.currentTime;
    v.pause();
    setBusy("still");
    try {
      // The original, never the light preview (720p, colour already converted).
      const bytes = await renderVideoStill(imageUrl("fullvideo", id), at, edit.lookId, edit.strength, edit.adj, frame === "whole" ? null : aspectOf(frame), log);
      const stem = row.filename.replace(/\.[^.]+$/, "");
      const mark = `${Math.floor(at / 60)}m${String(Math.floor(at % 60)).padStart(2, "0")}s`;
      const path = await api.exportImage(bytes, `${stem} still ${mark}${current ? ` - ${current.name}` : ""}`, takenAt(row.capturedAt, at));
      showInFinder(path);
      toast(`Still exported: ${path.split("/").pop()}`, { action: { label: "Show in Finder", run: () => api.reveal(path) } });
    } catch (e) {
      toast(`Still failed: ${errorText(e)}`, { error: true });
    } finally {
      setBusy(null);
    }
  };

  // Your edits: every picture you've edited, the most recent first.
  const showEdits = async () => {
    const list = await api.editedIds().catch(() => [] as string[]);
    if (!list.length) return toast("Nothing edited yet");
    await flushRef.current();
    setIds(list);
    setIndex(0);
  };

  const step = useCallback((d: number) => {
    flushRef.current();
    setIndex((i) => Math.max(0, Math.min(ids.length - 1, i + d)));
  }, [ids.length]);

  // The look next to the current one in the grid as it is drawn: left/right in
  // reading order, up/down to the nearest tile in the row above or below.
  // Returns the look id ("" = no look → null), or undefined at an edge.
  const gridNeighbour = (key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"): string | null | undefined => {
    const tiles = [...(looksListRef.current?.querySelectorAll<HTMLElement>(".look[data-look]") ?? [])];
    if (!tiles.length) return undefined;
    const at = tiles.findIndex((t) => t.dataset.look === (edit.lookId ?? ""));
    let target: HTMLElement | undefined;
    if (at < 0) target = tiles[0];
    else if (key === "ArrowRight") target = tiles[at + 1];
    else if (key === "ArrowLeft") target = tiles[at - 1];
    else {
      const here = tiles[at].getBoundingClientRect();
      const cx = here.left + here.width / 2;
      const down = key === "ArrowDown";
      let bestRow = Infinity;
      let bestX = Infinity;
      for (const t of tiles) {
        const r = t.getBoundingClientRect();
        const dy = down ? r.top - here.top : here.top - r.top;
        if (dy < 4) continue; // same row or the wrong way
        const dx = Math.abs(r.left + r.width / 2 - cx);
        if (dy < bestRow - 4 || (Math.abs(dy - bestRow) <= 4 && dx < bestX)) {
          bestRow = dy;
          bestX = dx;
          target = t;
        }
      }
    }
    if (!target) return undefined;
    return target.dataset.look ? target.dataset.look : null;
  };

  // Like swiping: a mark moves on to the next photo of the set.
  const setReview = (state: ReviewState, advance = true) => {
    if (!id) return;
    mark([id], state);
    setRows((r) => (r[id] ? { ...r, [id]: { ...r[id], review: state } } : r));
    if (advance) step(1);
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // A dialog, or the Post popover, has the keys.
      if (document.querySelector(".scrim, .popover")) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const tag = target?.tagName;
      const isText = !!target && (target.isContentEditable || tag === "TEXTAREA" || (tag === "INPUT" && (target as HTMLInputElement).type !== "range"));
      if (isText) return; // the look search box
      const arrows = e.key.startsWith("Arrow");
      // Sliders, dropdowns and the split divider keep their own arrow keys.
      if (arrows && (tag === "SELECT" || target?.closest('[aria-haspopup="listbox"], .select-pop') || (tag === "INPUT" && (target as HTMLInputElement).type === "range") || target?.getAttribute("role") === "slider")) return;
      const meta = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (e.key === " " && video.current && !e.repeat) return e.preventDefault(), togglePlay();
      if (video.current && !meta && (k === "i" || k === "o")) return e.preventDefault(), trimAt(k === "i" ? "in" : "out");
      if (e.key === "\\" || (k === "b" && !meta)) return e.preventDefault(), setHoldOriginal(true);
      // , and . go through the photos; so do ← → unless the looks panel was
      // clicked last (then the arrow keys walk the looks grid).
      if (!meta && (e.key === "." || e.key === ">")) return e.preventDefault(), step(1);
      if (!meta && (e.key === "," || e.key === "<")) return e.preventDefault(), step(-1);
      if (!meta && arrowsFor === "photos" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) return e.preventDefault(), step(e.key === "ArrowRight" ? 1 : -1);
      if (!meta && e.key.startsWith("Arrow") && arrowsFor === "looks") {
        e.preventDefault();
        const next = gridNeighbour(e.key as "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown");
        if (next === undefined) return;
        // Browsing looks in quick succession is one undo step: ⌘Z goes back to the look before.
        const now = Date.now();
        applyLookId(next, { commit: now - lastStep.current > LOOK_RUN_MS });
        lastStep.current = now;
        return setRevealTick((t) => t + 1);
      }
      if (e.key === "Escape") return confirmAll ? setConfirmAll(null) : back();
      if (meta && k === "z") return e.preventDefault(), e.repeat ? undefined : e.shiftKey ? redo() : undo();
      if (meta && k === "c") {
        e.preventDefault();
        clipboard = edit;
        return toast("Settings copied");
      }
      if (meta && k === "v" && clipboard) {
        e.preventDefault();
        if (e.repeat) return;
        // ⌥⌘V: choose what a paste carries over.
        if (e.altKey) return setPasteMenu(true);
        // ⌘⇧V: the copied settings on every photo of the set, with Undo in the toast.
        if (e.shiftKey && ids.length > 1) return requestApply("exact", true);
        return change(merge(edit, clipboard, pasteParts));
      }
      // P: the same edit as the photo before this one in the set (the chosen parts).
      if (!meta && k === "p" && !e.repeat) {
        e.preventDefault();
        void sameAsPrevious();
        return;
      }
      if (meta && k === "u") return e.preventDefault(), void auto();
      if (meta && e.shiftKey && k === "e") return e.preventDefault(), void exportStill();
      if (meta && k === "e") return e.preventDefault(), void exportOne();
      if (meta) return;
      const digit = digitOf(e);
      if (digit != null) {
        if (e.repeat) return;
        const fav = digit === 0 ? null : favorites.find((f) => f.favorite === digit);
        if (digit !== 0 && !fav) return;
        applyLookId(fav?.id ?? null);
        return setRevealTick((t) => t + 1);
      }
      if (e.key === "[" || e.key === "]") {
        e.preventDefault();
        const list = shown.length ? shown : looks;
        const i = list.findIndex((l) => l.id === edit.lookId);
        const forward = e.key === "]";
        const next = i < 0 ? (forward ? list[0] : list[list.length - 1]) : list[(i + (forward ? 1 : -1) + list.length) % list.length];
        if (!next) return;
        // Browsing looks in quick succession is one undo step: ⌘Z goes back to the look before.
        const now = Date.now();
        applyLookId(next.id, { commit: now - lastStep.current > LOOK_RUN_MS });
        lastStep.current = now;
        return setRevealTick((t) => t + 1);
      }
      if (e.repeat) return; // holding a mark key must not run through the set
      if (keymap.select.includes(k)) return setReview("selected");
      if (keymap.maybe.includes(k)) return setReview("maybe");
      if (keymap.unmark.includes(k)) return setReview("unreviewed", false);
      if (k === "y") return setCompare((c) => (c === "split" ? "look" : "split"));
    };
    const up = (e: KeyboardEvent) => (e.key === "\\" || e.key.toLowerCase() === "b") && setHoldOriginal(false);
    const release = () => setHoldOriginal(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
    };
  });

  if (!ids.length) {
    return (
      <div className="screen">
        <Hero title="Edit" italic="looks" sub={`${looks.length.toLocaleString()} looks ready: your Lightroom presets, your LUTs and film emulations`} />
        <section className="card empty">
          <h3>Pick photos to edit</h3>
          <p>In Pictures, pick one or more photos and press E. Selected photos without an edit open here automatically.</p>
          <button type="button" className="btn primary" onClick={() => go({ name: "pictures" })}>Go to Pictures</button>
        </section>
      </div>
    );
  }

  const splitDrag = (e: React.PointerEvent) => {
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => setSplit(Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)));
    const stop = () => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    move(e.nativeEvent);
  };
  const canvasRect = canvasRef.current?.getBoundingClientRect();
  const stageRect = stageRef.current?.getBoundingClientRect();
  const splitLeft = canvasRect && stageRect ? canvasRect.left - stageRect.left + canvasRect.width * split : 0;
  const changedCount = Object.entries(edit.adj).filter(([, v]) => v !== 0).length;

  return (
    <div className="screen">
      <div className="hero" style={{ paddingTop: 0 }}>
        <div style={{ minWidth: 0 }}>
          <div className="crumb">
            <button type="button" onClick={back}>← Back</button> · {index + 1} of {ids.length.toLocaleString()} ·{" "}
            <button type="button" onClick={() => void showEdits()} title="Every picture you've edited, the most recent first">Your edits</button>
          </div>
          <h1 style={{ fontSize: 30, overflowWrap: "anywhere" }}>
            {row?.filename ?? "…"} {current && <em>· {current.name}</em>}
          </h1>
        </div>
      </div>
      <div className="editor" onPointerDownCapture={(e) => setArrowsFor((e.target as HTMLElement).closest(".looks-pane") ? "looks" : "photos")}>
        <section className={`card looks-pane${arrowsFor === "looks" ? " arrows" : ""}`} aria-label="Looks">
          <div className="row-flex" style={{ gap: 6 }}>
            <div className="seg" role="group" aria-label="LUTs or effects" style={{ flex: 1 }}>
              <button type="button" aria-pressed={pane === "luts"} onClick={() => setPane("luts")}>LUTs</button>
              <button type="button" aria-pressed={pane === "effects"} onClick={() => setPane("effects")}>Effects</button>
            </div>
            <button
              type="button"
              className="btn quiet small"
              aria-label="Search looks"
              aria-pressed={searching}
              title={`Search ${looks.length} looks`}
              onClick={() => {
                if (searching) setFilter("");
                setSearching(!searching);
                setPane("luts");
              }}
            >
              {Icon.search()}
            </button>
            <button
              type="button"
              className="btn quiet small"
              disabled={!loaded || !isEdited(edit.lookId, edit.adj)}
              aria-expanded={!!saveAt}
              onClick={(e) => setSaveAt(saveAt ? null : e.currentTarget)}
              title="Keep this edit (look, strength, grain and every slider, not the crop) as a look of your own"
            >
              {Icon.plus()} Save look
            </button>
          </div>
          {searching && pane === "luts" && (
            <input
              className="search"
              autoFocus
              placeholder={`Search ${looks.length} looks…`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setFilter("");
                  setSearching(false);
                }
              }}
              aria-label="Search looks"
            />
          )}
          {saveAt && (
            <Popover anchor={saveAt} onClose={() => setSaveAt(null)} width={300}>
              <form
                className="save-look"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveAsLook();
                }}
              >
                <label className="meta" htmlFor="save-look-name">Name this look</label>
                <input id="save-look-name" className="box" autoFocus value={lookName} onChange={(e) => setLookName(e.target.value)} placeholder="e.g. Faces, Nepal 2026" autoComplete="off" autoCorrect="off" spellCheck={false} />
                <p className="meta">
                  {(looks.find((l) => l.id === edit.lookId)?.name ?? "No look")}
                  {edit.lookId && edit.strength < 1 ? ` at ${Math.round(edit.strength * 100)}%` : ""}
                  {slidersText(edit.adj) ? ` + ${slidersText(edit.adj)}` : ""}
                </p>
                <button type="submit" className="btn primary small" disabled={!lookName.trim()}>Save look</button>
              </form>
            </Popover>
          )}
          {pane === "effects" ? (
            <div className="looks-list">
              <div className="look-grid">
                <button type="button" className="look" aria-pressed={!currentEffect(edit.adj) && EFFECTS_OFF(edit.adj)} onClick={() => pickEffect(null)} title="No effects: grain, vignette and the rest at zero">
                  <span className="pv">
                    {id && <Thumb key={id} id={id} hash={row?.thumbhash} ready={row?.thumb === "ready"} />}
                  </span>
                  <span className="nm">No effect</span>
                </button>
                {EFFECTS.map((fx) => (
                  <EffectTile key={fx.id} effect={fx} active={currentEffect(edit.adj)?.id === fx.id} pool={pool} gen={gen} lookId={edit.lookId} strength={edit.strength} onPick={pickEffect} />
                ))}
              </div>
              <p className="hint">An effect sets grain, vignette, fade, soften, halation, colour fringe, scan lines, gate weave and light leak (under Effects on the right), on top of the look. Fine-tune them there.</p>
            </div>
          ) : (<>
          <Select className="pick" aria-label="Look group" value={group} onChange={(e) => { setGroup(e.target.value); e.currentTarget.blur(); }}>
            <option value="all">All looks</option>
            <option value="favorites">★ Favourites (keys 1–9)</option>
            {collections.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
          <div className="looks-list" ref={looksListRef}>
            {!looks.length && <p className="hint">Finding your presets and LUTs… this runs once in the background.</p>}
            <button type="button" className="look" data-look="" aria-pressed={!edit.lookId} onClick={() => pickLook(null)} style={{ width: "calc((100% - 16px) / 3)", marginBottom: 8 }}>
              <span className="pv">
                {id && <Thumb key={id} id={id} hash={row?.thumbhash} ready={row?.thumb === "ready"} />}
                <span className="key">0</span>
              </span>
              <span className="nm">No look</span>
            </button>
            {grouped.map(([name, list]) => (
              <div key={name} className="look-group">
                <h6 className="h">
                  <span>{name}</span>
                  <span>{list.length}</span>
                </h6>
                <div className="look-grid">
                  {list.map((l) => (
                    <LookTile key={l.id} look={l} active={l.id === edit.lookId} pool={pool} gen={gen} onPick={pickLook} onFav={toggleFav} onHover={setHoverLook} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="hint">{arrowsFor === "looks" ? "Arrow keys move through the looks (click the photo for ← → between photos)" : "← → move between photos (click a look to move through looks)"} · rest the pointer on one to preview · 1–9 favourites · 0 none</p>
          </>)}
        </section>

        <section className={full ? "card canvas-pane night full-frame" : "card canvas-pane night"} aria-label="Photo" style={{ background: "var(--ground)" }}>
          {full && <span className="lbl ff-hint">Esc or ⇧F to leave{clip ? " · Space plays" : ""}</span>}
          <div className="row-flex ff-hide">
            <div className="seg" role="group" aria-label="Compare" style={{ width: 250 }}>
              {(["original", "split", "look", ...(clip ? [] : ["instagram"])] as Compare[]).map((c) => (
                <button key={c} type="button" aria-pressed={compare === c} onClick={() => setCompare(c)} title={c === "instagram" ? "As Instagram shows it: the export, re-compressed, at phone size" : undefined}>
                  {c === "original" ? "Original" : c === "split" ? "Split" : c === "look" ? "Edited" : "Instagram"}
                </button>
              ))}
            </div>
            <span className="meta" style={{ marginLeft: "auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>hold the photo or B for the original · ← → photos</span>
            <button type="button" className="btn small quiet" onClick={toggleFull} title="The picture alone, edge to edge (⇧F, Esc to leave)">Full frame <kbd>⇧F</kbd></button>
          </div>
          <div ref={stageRef} className="canvas-stage">
            {compare === "instagram" && (
              <div className="ig-sim" aria-label="As Instagram shows it">
                {ig ? (
                  <>
                    <figure>
                      <img src={ig.url} alt="As it appears in the feed" />
                      <figcaption className="meta">In the feed · {ig.w} × {ig.h} · about {ig.kb} KB after Instagram's compression</figcaption>
                    </figure>
                    <figure className="ig-sim-tile">
                      <img src={ig.url} alt="As it appears in the profile grid" />
                      <figcaption className="meta">Grid tile (3:4)</figcaption>
                    </figure>
                  </>
                ) : (
                  <span className="meta">Making the Instagram preview…</span>
                )}
              </div>
            )}
            <canvas
              ref={canvasRef}
              aria-label="Edited photo"
              className={frame !== "whole" || edit.adj.cropZoom > 0 ? "pannable" : undefined}
              style={{ visibility: loaded && compare !== "instagram" ? "visible" : "hidden" }}
              onPointerDown={(e) => {
                // Press and hold the photo to see the original (when there's no crop to move).
                if (frame === "whole" && edit.adj.cropZoom <= 0) {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  return setHoldOriginal(true);
                }
                const box = e.currentTarget.getBoundingClientRect();
                startSlide();
                pan.current = { x: e.clientX, y: e.clientY, cropX: edit.adj.cropX, cropY: edit.adj.cropY, w: box.width, h: box.height };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const d = pan.current;
                if (!d) return;
                // Moving the photo right moves the frame left over it.
                const [, , cw, ch] = shownCrop.current;
                const clampPct = (v: number) => Math.max(-50, Math.min(50, v));
                slideMany({
                  cropX: clampPct(d.cropX - ((e.clientX - d.x) / d.w) * cw * 100),
                  cropY: clampPct(d.cropY - ((e.clientY - d.y) / d.h) * ch * 100),
                });
              }}
              onPointerCancel={() => setHoldOriginal(false)}
              onPointerUp={() => {
                setHoldOriginal(false);
                if (!pan.current) return;
                pan.current = null;
                commitSlide();
              }}
            />
            {!loaded && id && (
              <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
                <div style={{ width: "70%", height: "70%" }}>
                  <Thumb key={id} id={id} hash={row?.thumbhash} ready={row?.thumb === "ready"} contain />
                </div>
              </div>
            )}
            {compare === "split" && loaded && !holdOriginal && (
              <>
                <div
                  className="splitter"
                  style={{ left: splitLeft }}
                  onPointerDown={splitDrag}
                  role="slider"
                  aria-label="Before and after divider"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(split * 100)}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                      e.preventDefault();
                      e.stopPropagation();
                      setSplit((v) => Math.min(1, Math.max(0, v + (e.key === "ArrowRight" ? 0.05 : -0.05))));
                    }
                  }}
                />
                <span className="cap" style={{ left: 12 }}>Original</span>
                <span className="cap" style={{ right: 12 }}>{current?.name ?? "Edited"}</span>
              </>
            )}
            {(holdOriginal || compare === "original") && loaded && <span className="cap" style={{ left: 12 }}>Original</span>}
          </div>
          {clip && (
            <div className="row-flex" style={{ gap: 10, alignItems: "center", paddingTop: 8 }}>
              <button type="button" className="btn small quiet" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
                {playing ? "Pause" : "Play"} <kbd>Space</kbd>
              </button>
              <input
                type="range"
                min={0}
                max={clip.duration || 0}
                step={0.01}
                value={clipTime}
                onChange={(e) => seekClip(Number(e.target.value))}
                onPointerUp={(e) => e.currentTarget.blur()}
                aria-label="The frame you edit on"
                style={{
                  flex: 1,
                  // The trimmed part shows green on the track.
                  ...(trim && clip.duration
                    ? { ["--track" as string]: `linear-gradient(to right, var(--line) ${(trim[0] / clip.duration) * 100}%, var(--green) ${(trim[0] / clip.duration) * 100}% ${(trim[1] / clip.duration) * 100}%, var(--line) ${(trim[1] / clip.duration) * 100}%)` }
                    : {}),
                }}
              />
              <span className="meta" style={{ fontVariantNumeric: "tabular-nums" }}>{formatDuration(clipTime)} / {formatDuration(clip.duration)}</span>
              <button type="button" className="btn small quiet" onClick={() => trimAt("in")} title="The clip starts here">Start <kbd>I</kbd></button>
              <button type="button" className="btn small quiet" onClick={() => trimAt("out")} title="The clip ends here">End <kbd>O</kbd></button>
              <button type="button" className="btn small quiet" disabled={!!busy} onClick={() => void exportStill()} title="This frame as a photo in Exports, full size, with the edit (⌘⇧E)">
                {busy === "still" ? "Exporting still…" : "Export still"} <kbd>⌘⇧E</kbd>
              </button>
              {trim && (
                <button type="button" className="btn small quiet" onClick={() => setTrim(null)} title={`Trimmed to ${formatDuration(trim[0])}–${formatDuration(trim[1])}: back to the whole clip`}>
                  {formatDuration(trim[1] - trim[0])} · Untrim
                </button>
              )}
            </div>
          )}
          {copying != null && <p className="meta ff-hide" style={{ margin: "6px 0 0" }}>Making a smooth copy on this Mac for editing… {Math.round(copying * 100)}%</p>}
          {streaming && (
            <p className="meta ff-hide" style={{ margin: "6px 0 0" }}>
              {onPreview ? "Showing the light preview (720p); stills and exports use the original." : "Playing straight from Google Drive."}{" "}
              <button type="button" className="link" onClick={() => smoothCopy.current?.()} title="Downloads the clip and makes a lighter copy on this Mac, for smooth scrubbing">Make a smooth copy</button>
            </p>
          )}
          {ids.length > 1 && (
            <div className="filmstrip ff-hide" aria-label="Photos in this set">
              {ids.slice(Math.max(0, index - 40), index + 60).map((pid, i) => {
                const real = Math.max(0, index - 40) + i;
                const r = rows[pid];
                return (
                  <button key={pid} ref={real === index ? nowRef : undefined} type="button" className={real === index ? "now" : ""} onClick={() => setIndex(real)} aria-label={r?.filename ?? "photo"}>
                    <Thumb id={pid} hash={r?.thumbhash} ready={r?.thumb === "ready"} />
                    {r?.edited && <i className="dot d-ok" />}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="card adjust-pane" aria-label="Adjustments">
          <div className="adjust-top">
            <div className="seg review" role="group" aria-label="Review">
              {/* Rejecting belongs to culling: in the editor a photo is kept or kept in mind. */}
              {(["selected", "maybe"] as ReviewState[]).map((s) => (
                <button key={s} type="button" className={s} aria-pressed={row?.review === s} onClick={() => setReview(s)}>
                  {s === "selected" ? Icon.check() : Icon.q()}
                  {s === "selected" ? "Select" : "Maybe"}
                  <kbd className="seg-key">{firstKeyLabel(s === "selected" ? keymap.select : keymap.maybe)}</kbd>
                </button>
              ))}
            </div>
            <div className="adjust-out">
              {row?.isVideo ? (
                <Select className="pick" style={{ minWidth: 0 }} aria-label="Export format" value={clipExport} onChange={(e) => { setClipExport(e.target.value); e.currentTarget.blur(); try { localStorage.setItem("export.clip", e.target.value); } catch { /* ignore */ } }}>
                  {CLIP_EXPORTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                </Select>
              ) : (
                <Select className="pick" style={{ minWidth: 0 }} aria-label="Export format" value={exportId} onChange={(e) => { setExportId(e.target.value); e.currentTarget.blur(); try { localStorage.setItem("export.format", e.target.value); } catch { /* ignore */ } }}>
                  {EXPORTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                </Select>
              )}
              <button type="button" className="btn quiet small" disabled={!id} aria-expanded={!!postAt} onClick={(e) => setPostAt(postAt ? null : e.currentTarget)}>
                {Icon.plus()} Post
              </button>
              <button type="button" className="btn primary small" disabled={!!busy || !loaded} onClick={exportOne}>
                {Icon.download()} {busy === "export" ? `Exporting…${clipProgress != null ? ` ${Math.round(clipProgress * 100)}%` : ""}` : "Export"}
              </button>
            </div>
          </div>
          <div className="row-flex" style={{ flexWrap: "wrap", gap: 6 }}>
            <button type="button" className="btn primary small" onClick={auto} title="Auto tone (⌘U)">{Icon.sparkle(13)} Auto</button>
            <button type="button" className="btn quiet small" disabled={!changedCount && !edit.lookId} onClick={() => change({ ...EMPTY })}>Reset</button>
            <button type="button" className="btn quiet small" onClick={() => { clipboard = edit; toast("Settings copied"); }} title="⌘C">Copy</button>
            <button type="button" className="btn quiet small" disabled={!clipboard} onClick={() => clipboard && change(merge(edit, clipboard, pasteParts))} title="⌘V">Paste</button>
            <button type="button" className="btn quiet small" onClick={() => setPasteMenu((v) => !v)} aria-expanded={pasteMenu} title="Choose what a paste carries over (⌥⌘V)">
              {allParts(parts) ? "Paste…" : `Paste ${parts.size}/${PARTS.length}…`}
            </button>
            <button type="button" className="btn quiet small" disabled={index === 0} onClick={() => void sameAsPrevious()} title="The edit of the photo before this one (P)">Previous</button>
          </div>
          {pasteMenu && (
            <div className="paste-parts" role="group" aria-label="What a paste carries over">
              {PARTS.map((p) => (
                <label key={p.id} className="row-flex" style={{ gap: 8, fontSize: 13 }}>
                  <input
                    id={`part-${p.id}`}
                    type="checkbox"
                    checked={parts.has(p.id)}
                    onChange={(e) => {
                      const next = new Set(parts);
                      if (e.target.checked) next.add(p.id);
                      else next.delete(p.id);
                      chooseParts(next);
                    }}
                  />
                  {p.label}
                </label>
              ))}
              <div className="row-flex" style={{ gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                <button type="button" className="btn primary small" disabled={!clipboard || !parts.size} onClick={() => { if (clipboard) change(merge(edit, clipboard, parts)); setPasteMenu(false); }}>Paste</button>
                {ids.length > 1 && (
                  <button type="button" className="btn quiet small" disabled={!clipboard || !parts.size} onClick={() => { setPasteMenu(false); requestApply("exact", true); }}>Paste on all {ids.length.toLocaleString()}</button>
                )}
                <button type="button" className="link" style={{ fontSize: 12 }} onClick={() => chooseParts(new Set(allParts(parts) ? ["look", "strength"] : PARTS.map((p) => p.id)))}>
                  {allParts(parts) ? "Only the look" : "Everything"}
                </button>
              </div>
              <p className="hint" style={{ margin: "6px 0 0" }}>⌘V, ⌘⇧V and P (same as the previous photo) use this choice. Each photo keeps what isn't ticked.</p>
            </div>
          )}
          <div className="adjust-scroll">
            <div className="slider" style={{ opacity: edit.lookId ? 1 : 0.45 }}>
              <span className="label">
                <span>{current ? current.name : "No look"}</span>
                <output>{Math.round(edit.strength * 100)}%</output>
              </span>
              <input type="range" min={0} max={100} value={Math.round(edit.strength * 100)} disabled={!edit.lookId} aria-label="Look strength"
                onChange={(e) => { if (!id || editFor.current !== id || blockedByBulk()) return; const next = { ...edit, strength: Number(e.target.value) / 100 }; setEdit(next); save(id, next); }}
                onPointerDown={startSlide}
                onKeyDown={(e) => !e.repeat && startSlide()}
                onPointerUp={(e) => {
                  commitSlide();
                  e.currentTarget.blur();
                }}
                onKeyUp={commitSlide} />
            </div>
            <div className="sec crop-sec">
              <h6 className="h" style={{ margin: 0 }}>Straighten and crop</h6>
              <div className="seg" role="group" aria-label="Preview frame">
                {(["whole", "3:4", "4:5", "1:1", "9:16"] as FrameChoice[]).map((f) => (
                  <button key={f} type="button" aria-pressed={frame === f} onClick={() => setFrame(f)}>{f === "whole" ? "Whole" : f}</button>
                ))}
              </div>
              {CROP_SLIDERS.map((def) => (
                <Slider key={def.key} def={def} value={edit.adj[def.key]} onChange={(v) => slide(def.key, v)} onCommit={commitSlide} onStart={startSlide} />
              ))}
              <div className="row-flex" style={{ gap: 6, flexWrap: "wrap" }}>
                <button type="button" className="btn quiet small" disabled={!loaded} onClick={() => void frameOne("level")} title="Level the horizon (Apple's image analysis, on this Mac)">Auto straighten</button>
                <button type="button" className="btn quiet small" disabled={!loaded} onClick={() => void frameOne("subject")} title="Centre the frame on the main subject">Frame the subject</button>
                <button
                  type="button"
                  className="btn quiet small"
                  disabled={CROP_KEYS.every((k) => edit.adj[k] === 0)}
                  onClick={() => change({ ...edit, adj: { ...edit.adj, straighten: 0, cropX: 0, cropY: 0, cropZoom: 0 } })}
                >
                  Reset crop
                </button>
              </div>
              <p className="hint" style={{ margin: 0 }}>
                {frame === "whole" ? "Pick 3:4, 4:5 or 1:1 to see the frame and drag the photo in it." : "Drag the photo to move the frame."} Exports and posts use their own ratio with this crop.
              </p>
            </div>
            {SECTIONS.map((sec) => (
              <div key={sec.title} className="sec">
                <h6 className="h" style={{ margin: 0 }}>{sec.title}</h6>
                {sec.sliders.map((def) => (
                  <Slider key={def.key} def={def} value={edit.adj[def.key]} onChange={(v) => slide(def.key, v)} onCommit={commitSlide} onStart={startSlide} />
                ))}
              </div>
            ))}
          </div>
          {ids.length > 1 && (confirmAll ? (
            <div className="warnline apply-confirm" role="alertdialog" aria-label="Apply to the whole set">
              <span>Apply to {ids.length.toLocaleString()} photos?</span>
              <button type="button" className="btn primary small" autoFocus onClick={() => { const c = confirmAll; setConfirmAll(null); void applyAll(c.mode, c.paste); }}>Yes</button>
              <button type="button" className="btn quiet small" onClick={() => setConfirmAll(null)}>Cancel</button>
            </div>
          ) : (
            <div className="apply-all" ref={applyRef}>
              <button type="button" className="btn quiet" disabled={!!busy || !loaded} onClick={() => requestApply("auto")} title="The look on every photo, light and colour measured per photo">
                {progress ?? `Apply look to all ${ids.length.toLocaleString()} · auto tone each`}
              </button>
              <button type="button" className="btn quiet more" disabled={!!busy || !loaded} aria-label="Other ways to apply to all" aria-expanded={applyMenu} onClick={() => setApplyMenu((v) => !v)}>▾</button>
            </div>
          ))}
          {applyMenu && (
            <Popover anchor={applyRef.current} onClose={() => setApplyMenu(false)} up width={300}>
              {APPLY_MODES.map((m) => (
                <button key={m.id} type="button" className="opt" onClick={() => requestApply(m.id)}>
                  <span>{m.label}<span className="meta" style={{ display: "block" }}>{m.sub}</span></span>
                  {m.id === "exact" && <small>⌘⇧V pastes</small>}
                </button>
              ))}
              <button type="button" className="opt" onClick={() => void frameAll()}>
                <span>Straighten and frame each<span className="meta" style={{ display: "block" }}>Every photo levelled and framed on its own subject</span></span>
              </button>
            </Popover>
          )}
          <p className="hint">Saved as you go. Your original file is never changed.</p>
        </section>
      </div>
      {postAt && id && <PostPopover anchor={postAt} ids={[id]} onClose={() => setPostAt(null)} />}
    </div>
  );
}
