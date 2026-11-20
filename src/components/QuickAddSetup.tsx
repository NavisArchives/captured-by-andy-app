// Quick add, step one: which photos to go through for an album. The choices
// are remembered per album, so the next round for it starts from them.
import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { plural } from "../lib/format";
import { useStore } from "../store";
import type { Album, Counts, Folder, Query } from "../types";
import { TagPicker } from "./TagPicker";
import { Modal, useToast } from "./ui";
import "../styles/quick-add.css";

type Which = "not_rejected" | "selected" | "all";
type Kind = "photos" | "videos" | "both";

interface Filters {
  /** Trip folders; none means the whole library. */
  trips: string[];
  /** `YYYY-MM-DD`, or "" for no bound. */
  from: string;
  to: string;
  which: Which;
  kind: Kind;
  /** What's in them, as recognised: any of these. */
  labels: string[];
  order: "oldest" | "newest";
}

const DEFAULTS: Filters = { trips: [], from: "", to: "", which: "not_rejected", kind: "photos", labels: [], order: "oldest" };
const LIMIT = 200_000;

function remembered(albumId: string): Filters {
  try {
    const saved = JSON.parse(localStorage.getItem(`quickAdd.${albumId}`) ?? "null") as (Partial<Filters> & { search?: unknown }) | null;
    if (!saved) return DEFAULTS;
    // Typed searches (before tags were picked) are let go.
    const { search: _typed, ...kept } = saved;
    return { ...DEFAULTS, ...kept, labels: Array.isArray(kept.labels) ? kept.labels : [] };
  } catch {
    return DEFAULTS;
  }
}

function remember(albumId: string, f: Filters) {
  try {
    localStorage.setItem(`quickAdd.${albumId}`, JSON.stringify(f));
  } catch {
    /* private mode */
  }
}

/** One query per chosen trip, or one for the whole library. */
function queries(f: Filters): Query[] {
  const base: Query = {
    order: f.order,
    from: f.from || null,
    to: f.to || null,
    labels: f.labels.length ? f.labels : null,
    video: f.kind === "both" ? null : f.kind === "videos",
  };
  return f.trips.length ? f.trips.map((folder) => ({ ...base, folder })) : [base];
}

const counted = (c: Counts, which: Which) => (which === "selected" ? c.selected : which === "not_rejected" ? c.all - c.rejected : c.all);

/** How many photos the filters find that aren't in the album yet. */
async function countToGo(album: Album, f: Filters): Promise<number> {
  const per = await Promise.all(
    queries(f).map(async (q) => {
      const [all, inAlbum] = await Promise.all([api.counts(q), api.counts({ ...q, album: album.id })]);
      return counted(all, f.which) - counted(inAlbum, f.which);
    }),
  );
  return Math.max(0, per.reduce((a, b) => a + b, 0));
}

/** The photos to go through, trip by trip, leaving out those already in the album. */
async function idsToGo(album: Album, f: Filters): Promise<string[]> {
  const skip = new Set(await api.photoIds({ album: album.id }, 0, LIMIT));
  const out: string[] = [];
  for (const q of queries(f)) {
    const [ids, rejected] = await Promise.all([
      api.photoIds(f.which === "selected" ? { ...q, review: "selected" } : q, 0, LIMIT),
      f.which === "not_rejected" ? api.photoIds({ ...q, review: "rejected" }, 0, LIMIT) : Promise.resolve([]),
    ]);
    rejected.forEach((id) => skip.add(id));
    for (const id of ids) {
      if (skip.has(id)) continue;
      skip.add(id);
      out.push(id);
    }
  }
  return out;
}

function Seg<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: [T, string][]; onPick: (v: T) => void }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onPick(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

export function QuickAddSetup({ album, onClose }: { album: Album; onClose: () => void }) {
  const { startQuickAdd, version } = useStore();
  const toast = useToast();
  const [f, setF] = useState<Filters>(() => remembered(album.id));
  const set = (patch: Partial<Filters>) => setF((x) => ({ ...x, ...patch }));
  const [folders, setFolders] = useState<Folder[] | null>(null);
  useEffect(() => {
    api.folders().then(setFolders).catch(() => setFolders([]));
  }, []);
  const trips = (folders ?? []).filter((t) => t.depth === 1);
  // A remembered trip that is no longer in the library is let go.
  const chosen = folders ? f.trips.filter((p) => trips.some((t) => t.path === p)) : f.trips;
  const filters: Filters = { ...f, trips: chosen };
  const key = JSON.stringify(filters);

  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!folders) return;
    setCount(null);
    let live = true;
    const t = window.setTimeout(() => {
      countToGo(album, filters)
        .then((n) => live && setCount(n))
        .catch(() => live && setCount(0));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [key, folders, version, album]); // eslint-disable-line react-hooks/exhaustive-deps

  const [starting, setStarting] = useState(false);
  const start = async () => {
    if (starting || !count) return;
    setStarting(true);
    try {
      remember(album.id, filters);
      const ids = await idsToGo(album, filters);
      if (!ids.length) {
        setStarting(false);
        return toast(`Nothing left to go through: every photo these filters find is already in ${album.name}`);
      }
      onClose();
      startQuickAdd(album, ids);
    } catch (e) {
      setStarting(false);
      toast(errorText(e), { error: true });
    }
  };

  const toggleTrip = (path: string) => set({ trips: chosen.includes(path) ? chosen.filter((p) => p !== path) : [...chosen, path] });
  const noun = f.kind === "videos" ? "video" : "photo";

  return (
    <Modal
      title={<>Quick add to <em>{album.name}</em></>}
      crumb="Pick what to go through, then Y adds and N skips"
      onClose={onClose}
      foot={
        <>
          <span className="meta qa-count">
            {count == null ? "Counting…" : `${plural(count, noun)} to go through`} · already in {album.name}: left out
          </span>
          <span className="spacer" />
          <button type="button" className="btn quiet" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!count || starting} onClick={() => void start()}>
            {starting ? "Getting them…" : "Start"} <kbd>↵</kbd>
          </button>
        </>
      }
    >
      <div
        className="qa-setup"
        onKeyDown={(e) => {
          // ↵ starts, also right after clicking a filter (a focused chip would take it).
          if (e.key === "Enter") {
            e.preventDefault();
            void start();
          }
        }}
      >
        <section>
          <h3 className="eyebrow">Trips</h3>
          <div className="qa-trips">
            <button type="button" className="chip" aria-pressed={!chosen.length} onClick={() => set({ trips: [] })}>
              All trips
            </button>
            {trips.map((t) => (
              <button key={t.path} type="button" className="chip" aria-pressed={chosen.includes(t.path)} onClick={() => toggleTrip(t.path)} title={t.path}>
                <span className="qa-trip-name">{t.name}</span>
                <span className="n">{t.count.toLocaleString()}</span>
              </button>
            ))}
            {folders && !trips.length && <span className="meta">No trip folders yet: the whole library is used.</span>}
          </div>
        </section>
        <section>
          <h3 className="eyebrow">Dates</h3>
          <div className="qa-dates">
            <label>
              <span className="meta">From</span>
              <input className="box" type="date" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} />
            </label>
            <label>
              <span className="meta">To</span>
              <input className="box" type="date" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} />
            </label>
            {(f.from || f.to) && (
              <button type="button" className="link" onClick={() => set({ from: "", to: "" })}>Any date</button>
            )}
          </div>
        </section>
        <section>
          <h3 className="eyebrow">What's in them</h3>
          <TagPicker label="What's in them" value={f.labels} onChange={(labels) => set({ labels })} placeholder="Optional: people, boat, market…" />
          <p className="meta qa-note">Pick from what the app recognised in your photos. Photos with any of them count.</p>
        </section>
        <div className="qa-row">
          <section>
            <h3 className="eyebrow">Which</h3>
            <Seg label="Which photos" value={f.which} onPick={(which) => set({ which })} options={[["not_rejected", "All but rejected"], ["selected", "Selected"], ["all", "Everything"]]} />
          </section>
          <section>
            <h3 className="eyebrow">Type</h3>
            <Seg label="Type" value={f.kind} onPick={(kind) => set({ kind })} options={[["photos", "Photos"], ["videos", "Videos"], ["both", "Both"]]} />
          </section>
          <section>
            <h3 className="eyebrow">Order</h3>
            <Seg label="Order" value={f.order} onPick={(order) => set({ order })} options={[["oldest", "Oldest first"], ["newest", "Newest first"]]} />
          </section>
        </div>
      </div>
    </Modal>
  );
}
