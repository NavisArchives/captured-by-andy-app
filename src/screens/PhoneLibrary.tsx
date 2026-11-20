// The phone's Library (NIRMATA spec §4.2): trips first, then an edge-to-edge
// grid. The desktop keeps Pictures.tsx; this only renders when phone() is true.
import { usePhotoMenu } from "../components/menus";
import { MultiDownloadSheet } from "../components/DownloadSheet";
import { WEB } from "../platform";
import { sizedImageUrl } from "../api";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { placeholder } from "../components/Thumb";
import { useStore } from "../store";
import { formatDuration } from "../lib/format";
import { placeName } from "../lib/humanName";
import type { Folder, PhotoRow, Query } from "../types";

type Chip = "all" | "selected" | "unreviewed" | "videos" | "photos" | "rejected";
const CHIPS: [Chip, string][] = [["all", "All"], ["selected", "Selected"], ["unreviewed", "To review"], ["videos", "Videos"], ["photos", "Photos"], ["rejected", "Rejected"]];
const PAGE = 240;

function chipQuery(base: Query, chip: Chip): Query {
  const q: Query = { ...base, order: "newest", review: null, video: null };
  if (chip === "selected") q.review = "selected";
  if (chip === "unreviewed") q.review = "unreviewed";
  if (chip === "videos") q.video = true;
  if (chip === "photos") q.video = false;
  if (chip === "rejected") q.review = "rejected";
  // Browsing shows what was kept; rejects have their own chip.
  else if (!q.review) q.excludeRejected = true;
  return q;
}

/** A trip's cover tile: its newest picture. */
function TripTile({ folder, onOpen }: { folder: Folder; onOpen: () => void }) {
  const [cover, setCover] = useState<PhotoRow | null>(null);
  useEffect(() => {
    let live = true;
    api.listPhotos({ folder: folder.path, order: "newest" }, 0, 1).then((r) => live && setCover(r[0] ?? null)).catch(() => {});
    return () => { live = false; };
  }, [folder.path]);
  return (
    <button type="button" className="pl-trip" onClick={onOpen}>
      <span className="pl-cover" style={cover?.thumbhash ? { backgroundImage: `url(${placeholder(cover.thumbhash)})` } : undefined}>
        {cover && <img src={sizedImageUrl("thumb", cover.id, Math.ceil((window.innerWidth - 44) / 2))} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />}
      </span>
      <span className="pl-name">{placeName(folder.name)}</span>
      <span className="pl-sub">{folder.count.toLocaleString()} {folder.count === 1 ? "picture" : "pictures"}</span>
    </button>
  );
}

export function PhoneLibrary() {
  const { go, version } = useStore();
  const photoMenu = usePhotoMenu();
  // Three tiles across the phone: each is asked for at its shown width × density.
  const tileCss = Math.ceil((window.innerWidth - 24) / 3);
  // Amendment 9c: pick several pictures and download them together (videos one at a time).
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [multi, setMulti] = useState(false);
  const [folders, setFolders] = useState<Folder[] | null>(null);
  // Where we are: the trips, every picture, or one trip.
  const [where, setWhere] = useState<{ kind: "trips" } | { kind: "all" } | { kind: "trip"; folder: Folder }>(() => {
    try {
      const saved = sessionStorage.getItem("pl-where");
      return saved ? JSON.parse(saved) : { kind: "trips" };
    } catch {
      return { kind: "trips" };
    }
  });
  const [chip, setChip] = useState<Chip>("all");
  const [rows, setRows] = useState<PhotoRow[]>([]);
  const [done, setDone] = useState(false);
  const loading = useRef(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { sessionStorage.setItem("pl-where", JSON.stringify(where)); } catch { /* private mode */ }
  }, [where]);
  useEffect(() => {
    api.folders().then((f) => setFolders(f.filter((x) => x.depth === 1).sort((a, b) => b.count - a.count))).catch(() => setFolders([]));
  }, [version]);

  const query: Query | null = where.kind === "trips" ? null : chipQuery(where.kind === "trip" ? { folder: where.folder.path } : {}, chip);
  const key = JSON.stringify(query);
  const more = useCallback(async (from: number) => {
    if (!query || loading.current) return;
    loading.current = true;
    try {
      const page = await api.listPhotos(query, from, PAGE);
      setRows((r) => (from === 0 ? page : [...r, ...page]));
      setDone(page.length < PAGE);
    } finally {
      loading.current = false;
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setRows([]);
    setDone(false);
    void more(0);
  }, [more, version]);
  // The next page when the end of the grid comes into view.
  useEffect(() => {
    const el = end.current;
    if (!el || done) return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && void more(rows.length), { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [more, rows.length, done]);

  if (where.kind === "trips") {
    return (
      <div className="phone-lib">
        <header className="pl-bar">
          <h1>Archive</h1>
        </header>
        <div className="pl-seg" role="group" aria-label="Show">
          <button type="button" aria-pressed="true">Trips</button>
          <button type="button" aria-pressed="false" onClick={() => setWhere({ kind: "all" })}>All</button>
        </div>
        <div className="pl-trips">
          {folders === null ? null : folders.length === 0 ? <p className="pl-empty">No trips yet.</p> : folders.map((f) => <TripTile key={f.path} folder={f} onOpen={() => { setChip("all"); setWhere({ kind: "trip", folder: f }); }} />)}
        </div>
      </div>
    );
  }

  return (
    <div className="phone-lib">
      <header className="pl-bar">
        <button type="button" className="pl-back" aria-label="Back to trips" onClick={() => setWhere({ kind: "trips" })}>
          <svg width="12" height="20" viewBox="0 0 12 20" aria-hidden="true"><path d="M10 2L2 10l8 8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <h2>{where.kind === "trip" ? placeName(where.folder.name) : "All pictures"}</h2>
        {WEB && (
          <button type="button" className="pl-select" onClick={() => { setSelecting((v) => !v); setPicked(new Set()); }}>{selecting ? "Done" : "Select"}</button>
        )}
      </header>
      <div className="pl-chips" role="group" aria-label="Filter">
        {CHIPS.map(([c, label]) => (
          <button key={c} type="button" aria-pressed={chip === c} onClick={() => setChip(c)}>{label}</button>
        ))}
      </div>
      <div className="pl-grid">
        {rows.map((p, i) => (
          <button
            key={p.id}
            type="button"
            className={`pl-tile${p.review === "rejected" ? " rej" : ""}`}
            style={p.thumbhash ? { backgroundImage: `url(${placeholder(p.thumbhash)})` } : undefined}
            aria-pressed={selecting ? picked.has(p.id) : undefined}
            onClick={() => {
              if (!selecting) return query && go({ name: "detail", id: p.id, query, index: i });
              if (p.isVideo) return;
              setPicked((cur) => { const n = new Set(cur); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; });
            }}
            onContextMenu={(e) => photoMenu(e, [p.id], { open: () => query && go({ name: "detail", id: p.id, query, index: i }), edited: p.edited, video: p.isVideo, filename: p.filename })}
            aria-label={p.isVideo ? "Clip" : "Photo"}
          >
            <img src={sizedImageUrl("thumb", p.id, tileCss)} alt="" loading="lazy" decoding="async" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
            {(p.review === "selected" || p.review === "maybe") && <i className={`pl-mark ${p.review}`} />}
            {p.isVideo && <span className="pl-dur">{p.duration ? formatDuration(p.duration) : "Clip"}</span>}
          </button>
        ))}
        {done && rows.length === 0 && <p className="pl-empty">Nothing here with this filter.</p>}
        <div ref={end} className="pl-end" />
      </div>
      {selecting && (
        <div className="pl-pickbar">
          <span>{picked.size ? `${picked.size} picked` : "Tap pictures to pick them · videos one at a time"}</span>
          <button type="button" className="btn primary" disabled={!picked.size} onClick={() => setMulti(true)}>Download {picked.size || ""}</button>
        </div>
      )}
      {multi && <MultiDownloadSheet photoIds={[...picked]} onClose={() => setMulti(false)} />}
    </div>
  );
}
