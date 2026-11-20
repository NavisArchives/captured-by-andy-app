import { useCallback, useEffect, useRef, useState } from "react";
import { WEB, phone } from "../platform";
import { api, errorText } from "../api";
import { AlbumPopover, PostPopover, ProjectPopover, RenamePopover, TagPopover, TripPopover, useMoveToTrip } from "../components/Actions";
import { AlbumModal } from "../components/AlbumModal";
import { DownloadDialog } from "../components/DownloadDialog";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AddItemSheet } from "../components/AddItemSheet";
import { PlacesSheet } from "../components/PlacesSheet";
import { QuickAddSetup } from "../components/QuickAddSetup";
import { Thumb } from "../components/Thumb";
import { PhotoGrid, type GridHandle } from "../components/PhotoGrid";
import { useAlbumMenu, usePhotoMenu } from "../components/menus";
import { Hero, Icon, SideCard, typing, useToast, Select } from "../components/ui";
import { editsChanged } from "../gl/edited";
import { digitOf, firstKeyLabel } from "../keymap";
import { plural } from "../lib/format";
import { restoreLooks } from "../lib/looksUndo";
import { useStore } from "../store";
import type { Album, Counts, Folder, Misplaced, Query, ReviewState } from "../types";

export const PHOTO_DRAG = "application/x-cba-photos";

/** The Albums section of the Pictures sidebar: filter by album, drop photos on one to add them. */
function AlbumsCard({ albums, active, onPick, onNew, onAll, onDropPhotos, onMenu }: { albums: Album[]; active: string | null; onPick: (id: string | null) => void; onNew: () => void; onAll: () => void; onDropPhotos: (albumId: string, ids: string[]) => void; onMenu?: (e: React.MouseEvent, a: Album) => void }) {
  const [over, setOver] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? albums : albums.slice(0, 8);
  return (
    <section className="card">
      <div className="side-head">
        <h3 className="h6">Albums</h3>
        <button type="button" className="link" style={{ fontSize: 11.5 }} onClick={onAll}>All</button>
      </div>
      <div className="side-list">
        {shown.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`side-row album-row${over === a.id ? " drop" : ""}`}
            aria-pressed={active === a.id}
            onClick={() => onPick(active === a.id ? null : a.id)}
            onContextMenu={(e) => onMenu?.(e, a)}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(PHOTO_DRAG)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                setOver(a.id);
              }
            }}
            onDragLeave={() => setOver((o) => (o === a.id ? null : o))}
            onDrop={(e) => {
              setOver(null);
              try {
                const ids = JSON.parse(e.dataTransfer.getData(PHOTO_DRAG)) as string[];
                if (ids.length) onDropPhotos(a.id, ids);
              } catch {
                /* not our drag */
              }
            }}
            title={`${a.name}: drop photos here to add them`}
          >
            <span className="album-mini"><Thumb id={a.coverPhotoId} hash={a.coverThumbhash} /></span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
            <span className="n">{a.photoCount.toLocaleString()}</span>
          </button>
        ))}
        {albums.length > 8 && (
          <button type="button" className="side-row album-row" onClick={() => setShowAll(!showAll)} style={{ color: "var(--muted)" }}>
            <i />
            <span>{showAll ? "Fewer" : `${albums.length - 8} more`}</span>
            <span />
          </button>
        )}
        <button type="button" className="side-row album-row" onClick={onNew} style={{ color: "var(--green)" }}>
          <i className="album-plus">+</i>
          <span>New album</span>
          <span />
        </button>
      </div>
      {!albums.length && <p className="meta" style={{ margin: "8px 0 0" }}>Drag photos onto an album to add them.</p>}
    </section>
  );
}

type Pop = "album" | "tag" | "post" | "trip" | "project" | "rename" | null;

const DATE_PRESETS: { key: string; label: string; days: number | "year" | null }[] = [
  { key: "", label: "Any date", days: null },
  { key: "7", label: "Last 7 days", days: 7 },
  { key: "30", label: "Last 30 days", days: 30 },
  { key: "90", label: "Last 3 months", days: 90 },
  { key: "year", label: "This year", days: "year" },
];

function dateFrom(preset: string): string | null {
  const p = DATE_PRESETS.find((d) => d.key === preset);
  if (!p || p.days == null) return null;
  const d = p.days === "year" ? new Date(new Date().getFullYear(), 0, 1) : new Date(Date.now() - p.days * 86400000);
  return d.toISOString().slice(0, 10);
}

export function Pictures() {
  const { query, setQuery, version, counts: libCounts, smart, selection, setSelection, keymap, mark, startCull, addFolder, go, albums, tags, sources, editIds, bump, looks, cull, quickAdd, undoMark, lastViewed } = useStore();
  const photoMenu = usePhotoMenu();
  const albumMenu = useAlbumMenu((a) => setAlbumModal(a));
  const gridHandle = useRef<GridHandle | null>(null);
  const toast = useToast();
  const [counts, setCounts] = useState<Counts | null>(null);
  const [sideOpen, setSideOpen] = useState(false);
  const [columns, setColumns] = useState(() => Number(localStorage.getItem("grid.columns")) || (phone() ? 3 : 7));
  const [search, setSearch] = useState(query.search ?? "");
  const [pop, setPop] = useState<Pop>(null);
  const [downloadIds, setDownloadIds] = useState<string[] | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const [albumModal, setAlbumModal] = useState<Album | "new" | null>(null);
  const [quickAddFor, setQuickAddFor] = useState<Album | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [folders, setFolders] = useState<Folder[]>([]);
  // "Add item…": the files picked, waiting for where they go.
  const [adding, setAdding] = useState<string[] | null>(null);
  const pickItems = async () => {
    const picked = await openDialog({
      multiple: true,
      title: "Choose photos or videos to add",
      filters: [{ name: "Photos and videos", extensions: ["jpg", "jpeg", "png", "heic", "heif", "webp", "arw", "cr2", "cr3", "nef", "dng", "mp4", "m4v", "mov"] }],
    });
    if (picked) setAdding(Array.isArray(picked) ? picked : [picked]);
  };
  useEffect(() => {
    api.folders().then(setFolders).catch(() => {});
  }, [version]);
  const trip = folders.find((f) => f.path === query.folder);
  const tops = folders.filter((f) => f.depth === 1);
  const openTop = query.folder ? tops.find((t) => query.folder === t.path || query.folder!.startsWith(`${t.path}/`)) : undefined;
  // A new trip goes next to the open one, else in the source with the most trips.
  const newTripRoot = openTop ? parentOf(openTop.path) : mostCommon(tops.map((t) => parentOf(t.path)));
  const moveToTrip = useMoveToTrip();

  // Photos of the open trip taken somewhere else, going by their GPS.
  const [misplaced, setMisplaced] = useState<Misplaced[]>([]);
  useEffect(() => {
    if (!query.folder) return setMisplaced([]);
    let off = false;
    api.misplaced(query.folder).then((m) => !off && setMisplaced(m ?? [])).catch(() => !off && setMisplaced([]));
    return () => {
      off = true;
    };
  }, [query.folder, version]);

  const set = useCallback((patch: Partial<Query>) => {
    setQuery({ ...query, ...patch });
    setSelection(new Set());
  }, [query, setQuery, setSelection]);

  useEffect(() => {
    api.counts(query).then(setCounts).catch(() => {});
  }, [query, version]);

  // Picks that left this view (marked out of "Unreviewed", or by a cull) are
  // dropped, so the next key or button never acts on a photo you can't see.
  useEffect(() => {
    if (!selection.size || selection.size > 20_000) return;
    const ids = [...selection];
    let cancelled = false;
    api.inView(query, ids).then((still) => {
      if (cancelled || still.length === ids.length) return;
      setSelection(new Set(still));
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, query, cull]);

  const sentSearch = useRef(query.search ?? "");
  useEffect(() => {
    const t = window.setTimeout(() => {
      sentSearch.current = search;
      if ((query.search ?? "") !== search) set({ search: search || null });
    }, 250);
    return () => window.clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
  // A search set from elsewhere (Add folder showing a folder, Clear filters) shows in the box.
  useEffect(() => {
    const q = query.search ?? "";
    if (q !== sentSearch.current) {
      sentSearch.current = q;
      setSearch(q);
    }
  }, [query.search]);

  useEffect(() => {
    try {
      localStorage.setItem("grid.columns", String(columns));
    } catch {
      /* private mode */
    }
  }, [columns]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (cull || quickAdd || typing(e) || e.metaKey || e.ctrlKey || !!document.querySelector(".scrim")) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      // 1–9: put a favourite look on every picked photo; 0 takes the look off.
      const digit = digitOf(e);
      if (digit != null && selection.size) {
        const ids = [...selection];
        const look = digit === 0 ? null : looks.find((l) => l.favorite === digit);
        if (digit !== 0 && !look) return toast(`No look pinned to ${digit} yet: star one in the editor`);
        e.preventDefault();
        void (async () => {
          try {
            // What each photo had before, so the change can be undone.
            const before = await api.photoLooks(ids).catch(() => null);
            await api.applyLook(ids, look?.id ?? null, 1);
            editsChanged();
            bump();
            const n = plural(ids.length, "photo");
            toast(look ? `${look.name} on ${n}` : `Look removed from ${n}`, {
              action: before
                ? {
                    label: "Undo",
                    run: () =>
                      void restoreLooks(before)
                        .then(() => {
                          editsChanged();
                          bump();
                          toast(`Undone on ${n}`);
                        })
                        .catch((err) => toast(errorText(err), { error: true })),
                  }
                : undefined,
            });
          } catch (err) {
            toast(errorText(err), { error: true });
          }
        })();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, looks, toast, bump, cull, quickAdd]);

  const total = counts ? (query.review ? counts[query.review] : counts.all) : 0;
  const album = albums.find((a) => a.id === query.album);
  const picked = [...selection];
  const open = (p: Pop, e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget);
    setPop(p);
  };
  // One picked photo: mark it and move on, exactly like the keys.
  const bulk = (state: ReviewState) => (picked.length === 1 && gridHandle.current ? gridHandle.current.markAndAdvance(state) : mark(picked, state));
  const keepOffline = async () => {
    try {
      const r = await api.offlineKeep(picked);
      toast(`${r.copied} copied to this Mac${r.skippedCloud ? ` · ${r.skippedCloud} only online (allow full downloads in Settings)` : ""}`);
      bump();
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const suggestion = query.smart === "soft";

  if (!sources.length) {
    return (
      <div className="screen">
        <Hero title="Every" italic="picture" sub="Nothing indexed yet" />
        <section className="card empty">
          <h3>Add your first folder</h3>
          <p>Pick the folder on your Kingston stick (or anywhere). Photos are only read, never changed. Files only move when you move photos to another trip. Online-only files (Google Drive, iCloud Drive) are listed without downloading them.</p>
          <button type="button" className="btn primary" onClick={addFolder}>
            {Icon.folder()} Choose folder…
          </button>
        </section>
      </div>
    );
  }

  const cullQuery: Query = query.review ? query : { ...query, review: "unreviewed" };
  const cullCount = query.review ? total : (counts?.unreviewed ?? 0);
  // The date menu shows the filter that is really on, also after coming back
  // from another screen.
  const datePreset = DATE_PRESETS.find((d) => d.key && dateFrom(d.key) === query.from && !query.to)?.key ?? (query.from || query.to ? "custom" : "");
  const filtered = !!(query.search || query.tag || query.media || query.from || query.to || query.account || query.device || query.ids || query.smart || query.social || query.storage || query.album || query.folder || query.video != null);
  const clearFilters = () => {
    setSearch("");
    set({ search: null, tag: null, media: null, from: null, to: null, account: null, device: null, ids: null, smart: null, social: null, storage: null, album: null, folder: null, video: null });
  };
  // The soft list only ever acts on what is still unreviewed
  // (or on the review list you picked): a frame chosen on purpose stays chosen.
  const bulkQuery: Query = query.review ? query : { ...query, review: "unreviewed" };
  const bulkCount = query.review ? total : (counts?.unreviewed ?? 0);
  const bulkWhat = query.review ? "" : " unreviewed";

  return (
    <div className="screen">
      <Hero
        title={album ? album.name : trip ? trip.name : "Every"}
        italic={album || trip ? undefined : "picture"}
        crumb={
          album ? <button type="button" onClick={() => go({ name: "albums" })}>Albums /</button>
          : trip ? <button type="button" onClick={() => set({ folder: null })}>Trips / {trip.source}</button>
          : undefined
        }
        sub={
          <>
            {plural(libCounts?.all ?? 0, "photo")} · {plural(libCounts?.unreviewed ?? 0, "photo")} still to review · review marks and edits preserve originals
          </>
        }
      >
        {album && (
          <>
            <button type="button" className="btn light" onClick={() => setQuickAddFor(album)} title="Go through photos one by one: Y adds, N skips">{Icon.sparkle()} Quick add</button>
            <button type="button" className="btn quiet" onClick={() => setAlbumModal(album)}>{Icon.edit()} Edit album</button>
            <button type="button" className="btn quiet" onClick={() => set({ album: null })}>Show all photos</button>
          </>
        )}
        <button type="button" className="btn quiet phone-only" aria-expanded={sideOpen} onClick={() => setSideOpen(true)}>
          Filters{filtered ? " ·" : ""}
        </button>
        {!WEB && (
          <>
            <button type="button" className="btn quiet" onClick={() => void pickItems()} title="Copy a photo or video from anywhere into a folder, then edit it">
              {Icon.plus()} Add item…
            </button>
            <button type="button" className="btn quiet" onClick={addFolder}>
              {Icon.folder()} Add folder…
            </button>
            <button type="button" className="btn quiet" onClick={() => go({ name: "cleanup" })} title="Delete rejected photos for good, one trip at a time (Drive Bin, 30 days)">
              Clean up
            </button>
          </>
        )}
        <button type="button" className="btn primary" disabled={!cullCount} onClick={() => startCull(cullQuery, 0)}>
          Cull {cullCount.toLocaleString()}
        </button>
      </Hero>
      <div className="pictures-body" style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
        {/* On a phone: a sheet that opens from Filters and closes on a pick. */}
        <div className={sideOpen ? "side open" : "side"} onClick={(e) => (e.target as HTMLElement).closest(".side-row") && setSideOpen(false)}>
          <div className="sheet-head phone-only">
            <b>Filters</b>
            <button type="button" className="btn small quiet" onClick={() => setSideOpen(false)}>Done</button>
          </div>
          <SideCard
            title="Your edits"
            active={query.smart === "edited" ? "edited" : null}
            onPick={(k) => set({ smart: k ? "edited" : null })}
            items={[{ key: "edited", label: "Edited", count: smart?.edited, cls: "st-ready" }]}
          />
          <SideCard
            title="Review"
            total={(counts?.all ?? 0).toLocaleString()}
            active={query.review ?? "all"}
            onPick={(k) => set({ review: !k || k === "all" ? null : (k as ReviewState) })}
            items={[
              { key: "all", label: "All", count: counts?.all, cls: "s-all" },
              { key: "unreviewed", label: "Unreviewed", count: counts?.unreviewed, cls: "s-unrev" },
              { key: "selected", label: "Selected", count: counts?.selected, cls: "s-sel" },
              { key: "maybe", label: "Maybe", count: counts?.maybe, cls: "s-maybe" },
              { key: "rejected", label: "Rejected", count: counts?.rejected, cls: "s-rej" },
            ]}
          />
          {folders.length > 0 && <TripsCard folders={folders} active={query.folder ?? null} onPick={(path) => set({ folder: path, ids: null })} onDropPhotos={(path, ids) => void moveToTrip(ids, path)} />}
          <AlbumsCard
            albums={albums}
            active={query.album ?? null}
            onPick={(id) => set({ album: id })}
            onNew={() => setAlbumModal("new")}
            onMenu={albumMenu}
            onAll={() => go({ name: "albums" })}
            onDropPhotos={async (albumId, ids) => {
              try {
                const n = await api.albumAdd(albumId, ids);
                const name = albums.find((a) => a.id === albumId)?.name ?? "album";
                // Works from any screen, whatever the filters are by then.
                const open = () => {
                  setQuery({ order: "newest", album: albumId });
                  setSelection(new Set());
                  go({ name: "pictures" });
                };
                toast(n ? `${n.toLocaleString()} added to ${name}` : `Already in ${name}`, { action: { label: "Open", run: open } });
                bump();
              } catch (err) {
                toast(errorText(err), { error: true });
              }
            }}
          />
          <SideCard
            title="Automatic"
            total={smart ? `${smart.analysed.toLocaleString()} checked` : undefined}
            active={query.smart ?? null}
            onPick={(k) => set({ smart: (k as Query["smart"]) ?? null })}
            items={[
              { key: "bursts", label: "Similar shots", count: smart?.bursts, cls: "s-auto" },
              { key: "soft", label: "Possibly soft", count: smart?.soft, cls: "s-auto" },
              { key: "dark", label: "Very dark", count: smart?.dark, cls: "s-auto" },
              { key: "bright", label: "Blown out", count: smart?.bright, cls: "s-auto" },
              { key: "not_edited_selected", label: "Selected, no edit", count: smart?.notEditedSelected, cls: "s-sel" },
              { key: "selected_unposted", label: "Selected, never posted", count: smart?.selectedUnposted, cls: "s-sel" },
              { key: "no_album", label: "Not in an album", count: smart?.noAlbum, cls: "s-all" },
            ]}
          />
          <SideCard
            title="Social"
            active={query.social ?? null}
            onPick={(k) => set({ social: (k as Query["social"]) ?? null })}
            items={[
              { key: "unused", label: "Not in a post", cls: "st-idea" },
              { key: "assigned", label: "In a post", cls: "st-ready" },
              { key: "posted", label: "Posted", cls: "st-scheduled" },
              { key: "posted_multiple", label: "Posted 2+ times", cls: "st-published" },
            ]}
          />
          <SideCard
            title="Storage"
            active={query.storage ?? null}
            onPick={(k) => set({ storage: (k as Query["storage"]) ?? null })}
            items={[
              { key: "local", label: "On this Mac", cls: "s-sel" },
              { key: "offline", label: "Offline copy", cls: "st-ready" },
              { key: "cloud_only", label: "Online only", cls: "s-all" },
              { key: "archived", label: "Archived", cls: "st-published" },
              { key: "missing", label: "Missing", cls: "s-rej" },
            ]}
          />
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <section className="card tight" style={{ display: "grid", gap: 10 }}>
            <div className="row-flex">
              {filtered && <button type="button" className="link" style={{ whiteSpace: "nowrap" }} onClick={clearFilters}>Clear filters</button>}
              <input ref={searchRef} className="search" type="search" placeholder="Search what's in photos (sunset, temple, beach), folders, dates (2026-03), cameras, tags…" aria-label="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
              <kbd>/</kbd>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 7 }}>
              <Select className={query.tag ? "pick on" : "pick"} aria-label="Tag" value={query.tag ?? ""} onChange={(e) => set({ tag: e.target.value || null })}>
                <option value="">All tags</option>
                {tags.map((t) => <option key={t.id} value={t.id}>#{t.name}</option>)}
              </Select>
              <Select
                className={query.media || query.video != null ? "pick on" : "pick"}
                aria-label="Type"
                value={query.video ? "video" : query.video === false ? "photo" : (query.media ?? "")}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "video" || v === "photo") set({ video: v === "video", media: null });
                  else set({ media: (v || null) as Query["media"], video: null });
                }}
              >
                <option value="">All types</option>
                <option value="photo">Photos</option>
                <option value="video">Videos</option>
                <option value="raw_image">RAW + JPEG</option>
                <option value="image">JPEG / HEIC</option>
                <option value="raw">RAW only</option>
              </Select>
              <Select className={datePreset ? "pick on" : "pick"} aria-label="Date" value={datePreset} onChange={(e) => set({ from: dateFrom(e.target.value), to: null })}>
                {DATE_PRESETS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                {datePreset === "custom" && <option value="custom" disabled>Custom range</option>}
              </Select>
              <Select className={query.device ? "pick on" : "pick"} aria-label="Device" value={query.device ?? ""} onChange={(e) => set({ device: (e.target.value || null) as Query["device"] })}>
                <option value="">Any device</option>
                <option value="iphone">iPhone</option>
                <option value="camera">Camera</option>
              </Select>
              <Select className="pick" aria-label="Sort" value={query.order ?? "newest"} onChange={(e) => set({ order: e.target.value as Query["order"] })}>
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="recentlyReviewed">Recently reviewed</option>
              </Select>
            </div>
          </section>
          <section className="card tight" style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <p className="eyebrow" style={{ marginBottom: 10 }}>
              <span>
                {total.toLocaleString()} shown{selection.size ? ` · ${selection.size.toLocaleString()} picked` : ""}
              </span>
              <span className="row-flex" style={{ gap: 8 }}>
                <span className="keys-hint keys-only" style={{ textTransform: "none", letterSpacing: 0 }}>
                  <kbd>{firstKeyLabel(keymap.select)}</kbd> select · <kbd>{firstKeyLabel(keymap.maybe)}</kbd> maybe · <kbd>{firstKeyLabel(keymap.reject)}</kbd> reject · <kbd>Space</kbd> open · <kbd>E</kbd> edit · <kbd>?</kbd> all
                </span>
                <span>Size</span>
                <input type="range" min={3} max={12} value={15 - columns} aria-label="Tile size" style={{ width: 96 }} onChange={(e) => setColumns(15 - Number(e.target.value))} />
              </span>
            </p>
            {misplaced.length > 0 && (
              <MisplacedLine
                misplaced={misplaced}
                showing={!!query.ids}
                onShow={(ids) => set({ ids })}
                onShowAll={() => set({ ids: null })}
                onMove={async (ids, path) => {
                  if ((await moveToTrip(ids, path)) && query.ids) set({ ids: null });
                }}
              />
            )}
            {query.smart === "bursts" && total > 0 && (
              <div className="warnline" style={{ marginBottom: 10 }}>
                {plural(total, "photo")} in groups of similar shots (bursts and near-identical frames). Which one is best is yours to say: open one and press C to compare them side by side.
              </div>
            )}
            {suggestion && total > 0 && (
              <div className="warnline" style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ flex: 1 }}>
                  {`${plural(total, "photo")} measured as possibly soft (missed focus or motion). Check before rejecting: grain and fog can fool it.`}
                </span>
                <button type="button" className="btn small quiet" disabled={!bulkCount} onClick={async () => mark(await api.photoIds(bulkQuery, 0, bulkCount), "maybe")}>
                  Mark {bulkCount.toLocaleString()}{bulkWhat} Maybe
                </button>
                {confirmReject ? (
                  <>
                    <span style={{ fontWeight: 600 }}>Reject {bulkCount.toLocaleString()}{bulkWhat}?</span>
                    <button type="button" className="btn small quiet" onClick={() => setConfirmReject(false)}>Cancel</button>
                    <button type="button" className="btn small danger" onClick={async () => { setConfirmReject(false); await mark(await api.photoIds(bulkQuery, 0, bulkCount), "rejected"); }}>Yes, reject</button>
                  </>
                ) : (
                  <button type="button" className="btn small danger" disabled={!bulkCount} onClick={() => setConfirmReject(true)}>Reject {bulkCount.toLocaleString()}{bulkWhat}…</button>
                )}
              </div>
            )}
            {total === 0 ? (
              <div className="empty">
                <h3>Nothing matches</h3>
                <p>Try another filter, or clear them.</p>
                <button type="button" className="btn quiet" onClick={() => { setSearch(""); setQuery({ order: query.order }); }}>Clear filters</button>
              </div>
            ) : (
              <PhotoGrid
                query={query}
                total={total}
                version={version}
                columns={columns}
                selection={selection}
                onSelection={setSelection}
                onOpen={(index, photo) => go({ name: "detail", id: photo.id, query, index })}
                onMark={mark}
                undoMark={undoMark}
                onEdit={(ids) => editIds(ids)}
                onMenu={(e, ids, photo, index) => photoMenu(e, ids, {
                  open: () => go({ name: "detail", id: photo.id, query, index }),
                  edited: photo.edited,
                  video: photo.isVideo,
                  filename: photo.filename,
                  inside: query.album ? { kind: "album", id: query.album, name: albums.find((a) => a.id === query.album)?.name ?? "album" } : query.post ? { kind: "post", id: query.post, name: "post" } : undefined,
                })}
                dragType={PHOTO_DRAG}
                handle={gridHandle}
                focusId={lastViewed.current}
                keymap={keymap}
                active={!pop && !albumModal && !quickAddFor && !cull && !quickAdd}
              />
            )}
            {selection.size > 0 && (
              <div className="selbar" role="toolbar" aria-label="Actions for picked photos">
                <b>{selection.size.toLocaleString()} picked</b>
                <button type="button" onClick={() => bulk("selected")}><span style={{ color: "#8fd3a9" }}>{Icon.check()}</span>Select <kbd>{firstKeyLabel(keymap.select)}</kbd></button>
                <button type="button" onClick={() => bulk("maybe")}><span style={{ color: "#e5b75a" }}>{Icon.q()}</span>Maybe <kbd>{firstKeyLabel(keymap.maybe)}</kbd></button>
                <button type="button" onClick={() => bulk("rejected")}><span style={{ color: "#e8958f" }}>{Icon.x()}</span>Reject <kbd>{firstKeyLabel(keymap.reject)}</kbd></button>
                <span className="dv" />
                {!WEB && <button type="button" onClick={() => editIds(picked)}>{Icon.edit()} Edit <kbd>E</kbd></button>}
                {!WEB && <span className="looks-hint" style={{ fontSize: 12, opacity: 0.6, padding: "0 6px" }}>Looks <kbd>1</kbd>–<kbd>9</kbd></span>}
                <button type="button" onClick={(e) => open("album", e)}>Album</button>
                {!WEB && <button type="button" onClick={(e) => open("tag", e)}>Tag</button>}
                {!WEB && <button type="button" onClick={(e) => open("post", e)}>Post</button>}
                <button type="button" onClick={(e) => open("project", e)}>Project</button>
                {!WEB && (
                  <>
                    <button type="button" onClick={(e) => open("trip", e)}>Move to trip</button>
                    <button type="button" onClick={(e) => open("rename", e)}>Rename…</button>
                    <button type="button" onClick={keepOffline} title="Copies the picked photos into your offline folder (~/Pictures/CapturedByAndy)">Copy to Mac</button>
                    <button type="button" onClick={() => setDownloadIds(picked)} title="Make the online originals available on this Mac (Google Drive), or online-only again">Download</button>
                  </>
                )}
                <span className="dv" />
                <button type="button" style={{ opacity: 0.65 }} onClick={() => setSelection(new Set())}>Clear</button>
              </div>
            )}
          </section>
        </div>
      </div>
      {downloadIds && <DownloadDialog photoIds={downloadIds} title={`Download ${downloadIds.length.toLocaleString()} originals`} onClose={() => setDownloadIds(null)} />}
      {pop === "album" && <AlbumPopover anchor={anchor} ids={picked} onClose={() => setPop(null)} up />}
      {albumModal && (
        <AlbumModal
          album={albumModal}
          photoIds={albumModal === "new" ? picked : undefined}
          onClose={() => setAlbumModal(null)}
          onDone={(a) => {
            if (albumModal === "new" && a) set({ album: a.id });
            if (!a) set({ album: null });
          }}
        />
      )}
      {quickAddFor && <QuickAddSetup album={quickAddFor} onClose={() => setQuickAddFor(null)} />}
      {pop === "tag" && <TagPopover anchor={anchor} ids={picked} onClose={() => setPop(null)} up />}
      {pop === "post" && <PostPopover anchor={anchor} ids={picked} onClose={() => setPop(null)} up />}
      {pop === "project" && <ProjectPopover anchor={anchor} ids={picked} onClose={() => setPop(null)} up />}
      {pop === "rename" && <RenamePopover anchor={anchor} ids={picked} onClose={() => setPop(null)} up />}
      {adding && <AddItemSheet files={adding} folders={folders} start={query.folder ?? null} onClose={() => setAdding(null)} />}
      {pop === "trip" && <TripPopover anchor={anchor} ids={picked} onClose={() => setPop(null)} up trips={tops} root={newTripRoot} />}
    </div>
  );
}

/** Trips: the folders of each source, with photo counts. The active trip opens
 *  to show its subfolders (not IPHONE ones); clicking the active one again shows everything. */
function TripsCard({ folders, active, onPick, onDropPhotos }: { folders: Folder[]; active: string | null; onPick: (path: string | null) => void; onDropPhotos: (path: string, ids: string[]) => void }) {
  const top = folders.filter((f) => f.depth === 1);
  const [over, setOver] = useState<string | null>(null);
  // Photos dragged onto a trip move there.
  const drop = (path: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes(PHOTO_DRAG)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(path);
      }
    },
    onDragLeave: () => setOver((o) => (o === path ? null : o)),
    onDrop: (e: React.DragEvent) => {
      setOver(null);
      try {
        const ids = JSON.parse(e.dataTransfer.getData(PHOTO_DRAG)) as string[];
        if (ids.length) onDropPhotos(path, ids);
      } catch {
        /* not our drag */
      }
    },
  });
  const openParent = active ? top.find((t) => active === t.path || active.startsWith(`${t.path}/`)) : undefined;
  const [placesFor, setPlacesFor] = useState<string | null>(null);
  return (
    <section className="card">
      {placesFor && <PlacesSheet trip={placesFor} onClose={() => setPlacesFor(null)} />}
      <div className="side-head">
        <h3 className="h6">Trips</h3>
        <span className="tot">{top.length}</span>
      </div>
      <div className="side-list">
        {top.map((t) => (
          <div key={t.path}>
            <button type="button" className={`side-row s-all${over === t.path ? " drop" : ""}`} aria-pressed={active === t.path} onClick={() => onPick(active === t.path ? null : t.path)} title={`${t.path}\nDrop photos here to move them to this trip`} {...drop(t.path)}>
              <i className="sw" />
              <span>{t.name}</span>
              <span className="n">{t.count.toLocaleString()}</span>
            </button>
            {openParent === t &&
              folders
                // IPHONE subfolders are left out: the device filter shows iPhone photos.
                .filter((f) => f.depth === 2 && f.path.startsWith(`${t.path}/`) && f.name.toUpperCase() !== "IPHONE")
                .map((sub) => (
                  <button key={sub.path} type="button" className={`side-row s-all${over === sub.path ? " drop" : ""}`} style={{ paddingLeft: 26 }} aria-pressed={active === sub.path} onClick={() => onPick(active === sub.path ? t.path : sub.path)} {...drop(sub.path)}>
                    <i className="sw" />
                    <span>{sub.name}</span>
                    <span className="n">{sub.count.toLocaleString()}</span>
                  </button>
                ))}
            {openParent === t && (
              <button type="button" className="side-row find-places" style={{ paddingLeft: 26 }} onClick={() => setPlacesFor(t.path)} title="Group this trip's loose photos by where they were taken, into place folders">
                <i className="sw" />
                <span>Find places…</span>
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));

function mostCommon(values: string[]): string | null {
  const n = new Map<string, number>();
  for (const v of values) n.set(v, (n.get(v) ?? 0) + 1);
  let best: string | null = null;
  for (const [v, c] of n) if (best === null || c > n.get(best)!) best = v;
  return best;
}

/** "Taken somewhere else": the open trip's photos whose GPS is far from the
 *  rest, grouped by the trip they were most likely taken on. */
function MisplacedLine({ misplaced, showing, onShow, onShowAll, onMove }: {
  misplaced: Misplaced[];
  showing: boolean;
  onShow: (ids: string[]) => void;
  onShowAll: () => void;
  onMove: (ids: string[], trip: string) => void;
}) {
  const groups = new Map<string | null, string[]>();
  for (const m of misplaced) groups.set(m.near, [...(groups.get(m.near) ?? []), m.id]);
  const sorted = [...groups].sort((a, b) => (a[0] === null ? 1 : b[0] === null ? -1 : b[1].length - a[1].length));
  return (
    <div className="warnline" style={{ marginBottom: 10, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
      <span style={{ flex: "1 1 260px" }}>
        {plural(misplaced.length, "photo")} here {misplaced.length === 1 ? "was" : "were"} taken somewhere else, going by GPS.
      </span>
      {sorted.map(([near, ids]) => (
        <span key={near ?? "none"} className="row-flex" style={{ gap: 6 }}>
          <span>{ids.length.toLocaleString()} {near ? `near ${near.split("/").pop()}` : "not near any trip"}</span>
          <button type="button" className="btn small quiet" onClick={() => onShow(ids)}>Show</button>
          {near && <button type="button" className="btn small quiet" onClick={() => onMove(ids, near)}>Move there</button>}
        </span>
      ))}
      {showing && <button type="button" className="btn small quiet" onClick={onShowAll}>Show the whole trip</button>}
    </div>
  );
}
