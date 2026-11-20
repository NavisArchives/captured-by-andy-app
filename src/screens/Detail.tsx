import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSwipe } from "../hooks/useSwipe";
import { api, errorText, imageUrl } from "../api";
import { AlbumPopover, PostPopover, ProjectPopover, TagPopover } from "../components/Actions";
import { VideoMoments, type MomentsHandle } from "../components/VideoMoments";
import { ClipPanel } from "../components/ClipPanel";
import { PhotoExportPanel } from "../components/PhotoExportPanel";
import { TranscriptPanel } from "../components/TranscriptPanel";
import { DownloadDialog } from "../components/DownloadDialog";
import { placeholder } from "../components/Thumb";
import { Icon, Modal, Popover, typing, useToast } from "../components/ui";
import { actionFor, firstKeyLabel } from "../keymap";
import { bytes, formatDate, formatDay, formatDuration, plural, STATUS_LABEL, STORAGE_LABEL } from "../lib/format";
import { editsChanged } from "../gl/edited";
import { useLooked, type LookToDraw } from "../gl/looked";
import { useStore, type Route } from "../store";
import { WEB, webHooks } from "../platform";
import { useFullFrame } from "../hooks/useFullFrame";
import { sliderValues } from "../lib/adjustments";
import { restoreLooks } from "../lib/looksUndo";
import { SECTIONS, signed } from "../lib/sliders";
import { NO_ADJUSTMENTS, type Adjustments, type AlbumLook, type Recipe, type PhotoDetail, type PhotoLook, type PhotoRow, type ReviewState } from "../types";

export function Detail({ route }: { route: Extract<Route, { name: "detail" }> }) {
  const { go, replace, back, keymap, mark, undoMark, editIds, looks, bump, version, cull, selection, setSelection, lastViewed, setQuery } = useStore();
  // A video's side panel: its look and export, or what is said in it.
  const [videoTab, setVideoTab] = useState<"export" | "transcript">("export");
  const toast = useToast();
  const [d, setD] = useState<PhotoDetail | null>(null);
  const [look, setLook] = useState<PhotoLook | null>(null);
  // The look the photo's album uses, offered when it has none of its own.
  const [albumLook, setAlbumLook] = useState<AlbumLook | null>(null);
  // Before / After on an edited photo, and trying the album's look on one that isn't.
  const [before, setBefore] = useState(false);
  const [trying, setTrying] = useState(false);
  const [pop, setPop] = useState<"album" | "tag" | "post" | "project" | null>(null);
  const [downloading, setDownloading] = useState(false);
  // The similar shots of this photo's scene, side by side.
  const [similar, setSimilar] = useState<PhotoRow[] | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [total, setTotal] = useState(0);
  // The photo as shown: the sharp preview, or the full resolution on request
  // ("Render full size"), fit to the screen or at 100 %.
  const [full, setFull] = useState(false);
  // Full frame (⇧F): the picture alone, edge to edge. Not the same as `full`, the full-size render (F).
  const { full: full_, toggle: toggleFull } = useFullFrame();
  const [zoom, setZoom] = useState(false);
  const [shown, setShown] = useState<"loading" | "ready" | "failed">("loading");
  // Online: a failed load can be tried again (a new key remounts the picture or clip).
  const [attempt, setAttempt] = useState(0);
  const retry = () => { setShown("loading"); setAttempt((n) => n + 1); };
  useEffect(() => {
    setFull(false);
    setZoom(false);
    setShown("loading");
    setBefore(false);
    setTrying(false);
  }, [route.id]);
  const renderFull = () => {
    if (full) return;
    setFull(true);
    setZoom(false);
    setShown("loading");
  };
  const loaded = useRef(false);
  const moments = useRef<MomentsHandle>(null);
  // What's in it (Apple's on-device recognition), as chips that search for more.
  const [labels, setLabels] = useState<string[]>([]);
  useEffect(() => {
    api.photoLabels(route.id)
      .then((all) => setLabels(all.filter(([, c]) => c >= 0.25).slice(0, 8).map(([l]) => l.replace(/_/g, " ").replace("sunset sunrise", "sunset"))))
      .catch(() => setLabels([]));
  }, [route.id]);
  const searchFor = (text: string) => {
    setQuery({ order: "newest", search: text });
    go({ name: "pictures" });
  };
  const isVideo = !!d?.isVideo && d.id === route.id;

  // Back in the grid, the photo you ended on is the one picked, unless you
  // were building a set: peeking at one of ten picks keeps all ten.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  useEffect(() => {
    lastViewed.current = route.id;
    if (selectionRef.current.size <= 1) setSelection(new Set([route.id]));
  }, [route.id, setSelection, lastViewed]);
  // After an Undo or a change elsewhere, keep "N of M" right.
  useEffect(() => {
    api.position(route.query, route.id).then((at) => {
      if (at != null && at !== route.index) replace({ ...route, index: at });
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const load = useCallback(() => {
    api.detail(route.id).then(setD).catch((e) => toast(errorText(e), { error: true }));
    api.photoLook(route.id).then(setLook).catch(() => {});
    api.albumLook(route.id).then(setAlbumLook).catch(() => setAlbumLook(null));
  }, [route.id, toast]);
  useEffect(load, [load, version]);

  // Look ahead: prepare the next photos' previews (and the one before) while
  // this one is on screen, so the arrow keys never wait. Kept in a ref so the
  // browser doesn't drop them; a photo already prepared costs nothing.
  const warm = useRef(new Map<string, HTMLImageElement>());
  useEffect(() => {
    let live = true;
    Promise.all([api.photoIds(route.query, route.index + 1, 5), route.index > 0 ? api.photoIds(route.query, route.index - 1, 1) : Promise.resolve([])])
      .then(([ahead, behind]) => {
        if (!live) return;
        for (const pid of [...ahead, ...behind]) {
          if (warm.current.has(pid)) continue;
          const img = new Image();
          img.src = imageUrl("preview", pid);
          warm.current.set(pid, img);
        }
        // Keep only the last few around.
        for (const key of [...warm.current.keys()].slice(0, Math.max(0, warm.current.size - 12))) warm.current.delete(key);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [route.id, route.index, route.query]);
  useEffect(() => {
    api.counts(route.query).then((c) => setTotal(route.query.review ? c[route.query.review] : c.all)).catch(() => {});
  }, [route.query, version]);

  // Neighbours come from the photo's own sort key, so they stay right even
  // after the photo left a filtered view or a mark was undone. Moving between
  // photos is not a Back step: Back returns to the grid.
  const busy = useRef(false);
  // Going through photos one after another (three steps the same way): the next
  // 80 in that direction are made ready in the background, and again every 30.
  const steps = useRef<{ dir: number; run: number; warmedAt: number }>({ dir: 0, run: 0, warmedAt: -1000 });
  const warmAhead = useCallback((index: number, dir: 1 | -1) => {
    const s = steps.current;
    s.run = s.dir === dir ? s.run + 1 : 1;
    s.dir = dir;
    if (s.run < 3 || Math.abs(index - s.warmedAt) < 30) return;
    s.warmedAt = index;
    const from = dir > 0 ? index + 1 : Math.max(0, index - 80);
    api
      .photoIds(route.query, from, 80)
      .then((ids) => api.warmPreviews(dir > 0 ? ids : ids.reverse()))
      .catch(() => {});
  }, [route.query]);

  const move = useCallback(
    async (delta: 1 | -1) => {
      if (busy.current) return;
      busy.current = true;
      try {
        const n = await api.neighbor(route.query, route.id, delta);
        if (n) {
          replace({ name: "detail", id: n[0], query: route.query, index: n[1] });
          warmAhead(n[1], delta);
        }
      } finally {
        busy.current = false;
      }
    },
    [route, replace, warmAhead],
  );
  // By touch: swipe to the next or previous photo.
  const swipe = useSwipe((dir) => {
    if (dir === "left") void move(1);
    else if (dir === "right") void move(-1);
  });

  // Like swiping: marking a photo moves straight on to the next one.
  const setReview = useCallback(
    async (state: ReviewState, advance = true) => {
      if (busy.current) return;
      busy.current = true;
      try {
        // Look up the neighbours before marking: once marked, the photo may
        // have left this view (Unmark in "Recently reviewed") and its sort key
        // with it.
        let next = await api.neighbor(route.query, route.id, 1);
        const prev = advance ? null : await api.neighbor(route.query, route.id, -1);
        const ok = await mark([route.id], state);
        if (!ok) return;
        setD((cur) => (cur ? { ...cur, review: state } : cur));
        if (!advance) {
          const still = await api.position(route.query, route.id);
          if (still != null) return;
          next = next ?? prev;
        }
        if (!next) return;
        const at = await api.position(route.query, next[0]);
        if (at != null) replace({ name: "detail", id: next[0], query: route.query, index: at });
      } finally {
        busy.current = false;
      }
    },
    [mark, route, replace],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || pop || cull || document.querySelector(".scrim")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.repeat) return;
        undoMark().then(async (ids) => {
          if (ids.length !== 1) return;
          const at = await api.position(route.query, ids[0]);
          replace({ name: "detail", id: ids[0], query: route.query, index: at ?? route.index });
        });
        return;
      }
      if (e.repeat && !e.key.startsWith("Arrow")) return;
      if (e.key === "ArrowRight") return move(1);
      if (e.key === "ArrowLeft") return move(-1);
      if (e.key === "Escape") return back();
      if (isVideo) {
        // J K L move through the clip, I and O mark a good moment, Space plays
        // and pauses (keeping the speed).
        if (e.key === " " && !(e.target instanceof HTMLVideoElement)) {
          e.preventDefault();
          moments.current?.handleKey(e);
          return;
        }
        if (moments.current?.handleKey(e)) {
          e.preventDefault();
          return;
        }
      }
      if (e.key.toLowerCase() === "e" && !e.metaKey) return editIds([route.id]);
      if (e.key.toLowerCase() === "f" && !e.metaKey) return isVideo ? undefined : full ? setZoom((z) => !z) : renderFull();
      if (e.key === "\\") return flipLook.current();
      const a = actionFor(e, keymap);
      if (a === "select") setReview("selected");
      if (a === "maybe") setReview("maybe");
      if (a === "reject") setReview("rejected");
      if (a === "unmark") setReview("unreviewed", false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, back, keymap, setReview, editIds, route, pop, cull, undoMark, replace, full, isVideo]);

  const openPop = (p: typeof pop, e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget);
    setPop(p);
  };

  const offline = async (keep: boolean) => {
    try {
      const r = keep ? await api.offlineKeep([route.id]) : await api.offlineRelease([route.id]);
      toast(keep ? (r.copied ? "Copied to this Mac" : r.skippedCloud ? "Only online: allow full downloads in Settings first" : "Already on this Mac") : "Offline copy removed");
      load();
      bump();
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };

  const lookName = look?.lookId ? looks.find((l) => l.id === look.lookId)?.name : null;
  const edited = !!look && (!!look.lookId || Object.values(look.adjustments).some((v) => v !== 0));
  const current = look?.photoId === route.id;
  // The album's look: its own (set on purpose), or for a photo with no edit
  // a suggestion from the edit its photos use most.
  const ownLook = edited && current ? look : null;
  const album = current && !isVideo && albumLook && (albumLook.set || !edited) ? albumLook : null;
  const nameOf = (r: Recipe) => (r.lookId ? looks.find((l) => l.id === r.lookId)?.name ?? "A look" : "Sliders only");
  const framing = (): Partial<Adjustments> => {
    const a = ownLook?.adjustments;
    return a ? { straighten: a.straighten, cropX: a.cropX, cropY: a.cropY, cropZoom: a.cropZoom } : {};
  };
  // Changing the album's look: the draft, drawn on this photo a moment after each change.
  const [draft, setDraft] = useState<Recipe | null>(null);
  const [changeAt, setChangeAt] = useState<HTMLElement | null>(null);
  const [drawnDraft, setDrawnDraft] = useState<Recipe | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => setDrawnDraft(draft), 180);
    return () => window.clearTimeout(t);
  }, [draft]);
  useEffect(() => {
    setDraft(null);
    setChangeAt(null);
  }, [route.id]);
  const drawRecipe = (r: Recipe): LookToDraw => ({ lookId: r.lookId, strength: r.strength, adjustments: { ...r.adjustments, ...framing() }, log: look?.log });
  // The big picture shows the photo's saved edit (Before shows the original),
  // the album's look while previewing or changing it. Full size is always the original.
  const toDraw: LookToDraw | null =
    isVideo || full
      ? null
      : draft
        ? drawnDraft && drawRecipe(drawnDraft)
        : trying && album && !album.thisPhoto
          ? drawRecipe(album)
          : ownLook && !before
            ? ownLook
            : null;
  const looked = useLooked(route.id, toDraw);
  const flipLook = useRef(() => {});
  flipLook.current = () => {
    if (full || draft) return;
    if (album && !album.thisPhoto && (trying || !ownLook)) setTrying((t) => !t);
    else if (ownLook) setBefore((b) => !b);
  };
  const saved = () => {
    editsChanged();
    load();
    bump();
  };
  // Takes the look and every slider off, keeping the photo's framing; Undo puts it all back.
  const removeLook = async () => {
    if (!ownLook) return;
    const id = route.id;
    const was = ownLook;
    const { straighten, cropX, cropY, cropZoom } = was.adjustments;
    try {
      await api.applyLook([id], null, 1, { ...NO_ADJUSTMENTS, straighten, cropX, cropY, cropZoom });
      setBefore(false);
      saved();
      toast(`${lookName ?? "The edit"} removed`, {
        action: { label: "Undo", run: () => void api.applyLook([id], was.lookId, was.strength, { ...NO_ADJUSTMENTS, ...was.adjustments }).then(saved).catch((e) => toast(errorText(e), { error: true })) },
      });
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  // The album's look onto this photo (keeping its crop); Undo puts back what it had.
  const applyAlbumLook = async () => {
    if (!album) return;
    const id = route.id;
    const was = ownLook;
    try {
      await api.applyLook([id], album.lookId, album.strength, { ...NO_ADJUSTMENTS, ...album.adjustments, ...framing() });
      setTrying(false);
      saved();
      const undo = () =>
        void api.applyLook([id], was?.lookId ?? null, was?.strength ?? 1, { ...NO_ADJUSTMENTS, ...was?.adjustments }).then(saved).catch((e) => toast(errorText(e), { error: true }));
      toast(`${album.albumName}'s look applied`, { action: { label: "Undo", run: undo } });
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  // A suggestion becomes the album's own look; nothing on the photos changes.
  const keepAlbumLook = async () => {
    if (!album) return;
    try {
      await api.setAlbumLook(album.albumId, { lookId: album.lookId, strength: album.strength, adjustments: album.adjustments });
      saved();
      toast(`${album.albumName} now has its own look`, { action: { label: "Undo", run: () => void api.setAlbumLook(album.albumId, null).then(saved) } });
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  // This photo's edit (not its crop) becomes the album's own look; nothing else changes.
  const ownAsAlbumLook = async () => {
    const target = d?.albums[0];
    if (!ownLook || !target) return;
    try {
      await api.setAlbumLook(target.id, { lookId: ownLook.lookId, strength: ownLook.strength, adjustments: ownLook.adjustments });
      saved();
      toast(`${target.name} now has this edit as its look`, { action: { label: "Undo", run: () => void api.setAlbumLook(target.id, null).then(saved) } });
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const openChange = (anchor: HTMLElement) => {
    if (!album) return;
    setTrying(false);
    setDraft({ lookId: album.lookId, strength: album.strength, adjustments: { ...NO_ADJUSTMENTS, ...album.adjustments } });
    setChangeAt(anchor);
  };
  const closeChange = () => {
    setDraft(null);
    setChangeAt(null);
  };
  // The album's look changes, and with it every photo still exactly on the
  // old one; photos edited their own way are left alone. One Undo for all.
  const saveChange = async () => {
    if (!album || !draft) return;
    const albumId = album.albumId;
    const name = album.albumName;
    try {
      const change = await api.changeAlbumLook(albumId, draft);
      closeChange();
      saved();
      const moved = change.updated.length;
      const undo = async () => {
        try {
          await restoreLooks(change.updated);
          await api.setAlbumLook(albumId, change.previous);
          saved();
        } catch (e) {
          toast(errorText(e), { error: true });
        }
      };
      toast(
        `${name}'s look updated${moved ? ` on ${plural(moved, "photo")}` : ""}${change.leftAlone ? ` · ${plural(change.leftAlone, "photo")} with an edit of its own left alone` : ""}`,
        { action: { label: "Undo", run: () => void undo() } },
      );
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const forgetAlbumLook = async () => {
    if (!album) return;
    const was: Recipe = { lookId: album.lookId, strength: album.strength, adjustments: album.adjustments };
    try {
      await api.setAlbumLook(album.albumId, null);
      closeChange();
      saved();
      toast(`${album.albumName} no longer has a look of its own (photos keep theirs)`, { action: { label: "Undo", run: () => void api.setAlbumLook(album.albumId, was).then(saved) } });
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const hasCopy = d?.assets.some((a) => a.localCopy);
  const viewInSource = () => {
    if (d) invoke<string>("view_in_source", { photoId: d.id }).catch((e) => toast(errorText(e), { error: true }));
  };
  // The shown original lives in a cloud folder (Google Drive, iCloud Drive): Download / Remove download.
  const driveOriginal = d?.assets.find((a) => a.isPrimary && a.storage !== "missing" && /\/Library\/(CloudStorage|Mobile Documents)\//.test(a.path));
  loaded.current = !!d;

  return (
    <div className="screen">
      <div className="detail-body" style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
        <section {...swipe} className={full_ ? "card night full-frame detail-main" : "card night detail-main"} style={{ flex: 1, display: "flex", flexDirection: "column", padding: 14, minWidth: 0, background: "var(--ground)" }}>
          {full_ && <span className="lbl ff-hint keys-only">Esc or ⇧F to leave{isVideo ? " · Space plays" : ""}</span>}
          <div className="row-flex ff-hide" style={{ marginBottom: 10 }}>
            <button type="button" className="btn quiet" style={{ color: "var(--ink)" }} onClick={back}>{Icon.back()} Back</button>
            <span className="meta">{(route.index + 1).toLocaleString()} of {total.toLocaleString()}</span>
            <span className="spacer" />
            <button type="button" className="btn quiet" style={{ color: "var(--ink)" }} onClick={toggleFull} title="The picture alone, edge to edge (⇧F, Esc to leave)">Full frame <kbd>⇧F</kbd></button>
            <button type="button" className="btn quiet" style={{ color: "var(--ink)" }} onClick={() => move(-1)} aria-label="Previous photo">{Icon.back()}</button>
            <button type="button" className="btn quiet" style={{ color: "var(--ink)" }} onClick={() => move(1)} aria-label="Next photo">{Icon.next()}</button>
            {isVideo ? (
              <span className="meta" style={{ color: "var(--ink)" }}>Video · {formatDuration(d?.duration)} · <kbd>Space</kbd> play</span>
            ) : (
              <>
                <button type="button" className="btn quiet mac-only" style={{ color: "var(--ink)" }} aria-pressed={full} onClick={() => (full ? setZoom((z) => !z) : renderFull())} title="The photo at full resolution; click the photo for 100 %">
                  {full ? (zoom ? "Fit to screen" : "100 %") : "Render full size"} <kbd>F</kbd>
                </button>
                {ownLook && (
                  <button type="button" className="btn quiet" style={{ color: "var(--ink)" }} aria-pressed={before} disabled={full} onClick={() => setBefore((b) => !b)} title="The photo without its look, and back">
                    {before ? "After" : "Before"} <kbd>\</kbd>
                  </button>
                )}
                <button type="button" className="btn primary mac-only" onClick={() => editIds([route.id])}>{Icon.edit()} Edit <kbd>E</kbd></button>
              </>
            )}
          </div>
          <div
            className="detail-stage"
            style={{ flex: 1, minHeight: 0, position: "relative", overflow: zoom ? "auto" : "hidden", display: zoom ? "block" : "grid", gridTemplate: "minmax(0, 1fr) / minmax(0, 1fr)", placeItems: "center" }}
          >
            {d && isVideo && !(WEB && webHooks.videoAvailable && !webHooks.videoAvailable(d.id)) && (
              // Streams straight from where the video lives (Google Drive included):
              // only the part being played is read, nothing is downloaded first.
              <VideoMoments
                key={`${d.id}-${attempt}`}
                ref={moments}
                photoId={d.id}
                onReady={() => setShown("ready")}
                onError={() => setShown("failed")}
              />
            )}
            {d && !isVideo && (
              <img
                key={`${d.id}-${full ? "full" : "preview"}-${attempt}`}
                src={full ? imageUrl("original", d.id) : looked.url ?? imageUrl("preview", d.id)}
                alt={WEB ? "" : d.filename}
                onLoad={(e) => { if (!e.currentTarget.dataset.failed) setShown("ready"); }}
                onError={(e) => {
                  setShown("failed");
                  // Online: never the browser's broken-picture icon; the blurred placeholder stays.
                  const blur = WEB ? placeholder(d.thumbhash) : null;
                  if (blur && e.currentTarget.src !== blur) {
                    e.currentTarget.dataset.failed = "1";
                    e.currentTarget.src = blur;
                  }
                }}
                onClick={() => full && setZoom((z) => !z)}
                style={
                  zoom
                    ? { display: "block", maxWidth: "none", margin: "0 auto", cursor: "zoom-out" }
                    : {
                        width: "100%",
                        height: "100%",
                        objectFit: "contain",
                        cursor: full ? "zoom-in" : "default",
                        // Until the sharp picture is in, the blurred placeholder fills the frame.
                        backgroundImage: shown === "ready" ? undefined : `url(${placeholder(d.thumbhash)})`,
                        backgroundSize: "contain",
                        backgroundRepeat: "no-repeat",
                        backgroundPosition: "center",
                      }
                }
              />
            )}
            {WEB && d && (() => {
              // Online states, in plain words, with one button when there is something to do.
              const noCopy = isVideo && !!webHooks.videoAvailable && !webHooks.videoAvailable(d.id);
              const offline = typeof navigator !== "undefined" && navigator.onLine === false;
              const say = noCopy
                ? "This clip isn't on the phone yet. It uploads from the Mac when the app is open there."
                : shown === "failed"
                  ? offline ? "You're offline. Showing what's saved on this phone." : isVideo ? "Couldn't play this one." : "Couldn't load this one."
                  : null;
              if (!say) return null;
              return (
                <div className="web-state" role="status">
                  <p>{say}</p>
                  {!noCopy && <button type="button" className="btn" onClick={retry}>Try again</button>}
                </div>
              );
            })()}
            {!WEB && shown !== "ready" && !(isVideo && shown !== "failed") && (
              <span className="lbl" style={{ position: "absolute", left: 12, ...(isVideo ? { top: 12 } : { bottom: 12 }) }}>
                {shown === "failed"
                  ? isVideo ? "Video can't play right now (is Google Drive running?)" : full ? "Full size not available right now (is Google Drive running?)" : "Preview not available right now"
                  : isVideo ? "Loading video…" : full ? "Rendering full size…" : "Loading preview…"}
              </span>
            )}
            {!full && shown === "ready" && (looked.drawing || draft || (before && ownLook) || (trying && album && !album.thisPhoto)) && (
              <span className="lbl" style={{ position: "absolute", left: 12, bottom: 12 }}>
                {looked.drawing ? "Putting the look on…" : draft ? `Changing ${album?.albumName}'s look · not saved yet` : trying && album ? `Previewing ${album.albumName}'s look · not saved` : "Before: the original"}
              </span>
            )}
            {full && shown === "ready" && (
              <span className="lbl" style={{ position: "absolute", left: 12, bottom: 12 }}>
                Full size{d?.width && d?.height ? ` · ${d.width} × ${d.height}` : ""} · click for {zoom ? "fit" : "100 %"}
              </span>
            )}
          </div>
        </section>
        <aside className="card detail-aside" aria-label="Photo details" style={{ width: 400, flexShrink: 0, overflowY: "auto" }}>
          {!d ? (
            <p className="meta">Loading…</p>
          ) : (
            <>
              <div className="crumb">Pictures / {d.albums[0]?.name ?? "Archive"}</div>
              <h2 style={{ margin: "4px 0 0", fontSize: 26, fontWeight: 400, letterSpacing: "-0.035em", overflowWrap: "anywhere" }}>{d.filename}</h2>
              <div style={{ fontSize: 13, color: "var(--muted)", margin: "4px 0 14px" }}>
                {formatDate(d.capturedAt)}
                {d.capturedAtSource === "file" && " (file date)"}
                {d.cameraModel && ` · ${d.cameraModel}`}
                {d.latitude != null && ` · ${d.latitude.toFixed(3)}, ${d.longitude?.toFixed(3)}`}
              </div>
              <div className="seg review" role="group" aria-label="Review">
                {(["selected", "maybe", "rejected"] as ReviewState[]).map((s) => (
                  <button key={s} type="button" className={s} aria-pressed={d.review === s} onClick={() => setReview(s)}>
                    {s === "selected" ? Icon.check() : s === "maybe" ? Icon.q() : Icon.x()}
                    {s === "selected" ? "Select" : s === "maybe" ? "Maybe" : "Reject"}
                    <kbd className="seg-key">{firstKeyLabel(s === "selected" ? keymap.select : s === "maybe" ? keymap.maybe : keymap.reject)}</kbd>
                  </button>
                ))}
              </div>
              <p className="meta keys-only" style={{ margin: "8px 0 0" }}>Marking jumps to the next photo · U unmarks · ← → move · {isVideo ? "Space play · E edit" : "E edit"} · Esc back · ? all shortcuts</p>
              {labels.length > 0 && (
                <div className="chips" style={{ marginTop: 10 }} aria-label="What's in it">
                  {labels.map((l) => (
                    <button key={l} type="button" className="chip" title="Find more photos with this" onClick={() => searchFor(l)}>{l}</button>
                  ))}
                </div>
              )}
              {isVideo ? (
                <div className="mac-only">
                  <div className="seg detail-tabs" role="tablist" aria-label="Video">
                    <button type="button" role="tab" aria-selected={videoTab === "export"} aria-pressed={videoTab === "export"} onClick={() => setVideoTab("export")}>Look &amp; export</button>
                    <button type="button" role="tab" aria-selected={videoTab === "transcript"} aria-pressed={videoTab === "transcript"} onClick={() => setVideoTab("transcript")}>Transcript</button>
                  </div>
                  {videoTab === "export" ? <ClipPanel photo={d} /> : <TranscriptPanel photoId={d.id} onSeek={(t) => moments.current?.seek(t)} />}
                </div>
              ) : (
                <div className="mac-only"><PhotoExportPanel photo={d} /></div>
              )}
              {(d.burst > 1 || d.soft) && (
                <div className="chips" style={{ marginTop: 10 }}>
                  {d.burst > 1 && (
                    <button
                      type="button"
                      className="tag t-idle"
                      style={{ cursor: "pointer", border: 0 }}
                      title="See them side by side"
                      onClick={() => api.burst(d.id).then(setSimilar).catch((e) => toast(errorText(e), { error: true }))}
                    >
                      One of {d.burst} similar shots · compare
                    </button>
                  )}
                  {d.soft && <span className="tag t-maybe">Possibly soft</span>}
                </div>
              )}

              {!isVideo && <div className="setrow mac-only" style={{ borderTop: "1px solid var(--line-soft)", marginTop: 14 }}>
                <div className="t">
                  <h6 className="h" style={{ marginBottom: 4 }}>Look</h6>
                  {edited && look ? (
                    <>
                      {lookName ?? "Sliders only"}
                      {album?.set && album.thisPhoto && <span className="meta" style={{ display: "block", fontSize: 12 }}>{album.albumName}'s look</span>}
                      <RecipeValues lookId={look.lookId} strength={look.strength} adjustments={look.adjustments} />
                    </>
                  ) : (
                    <small>Not edited yet</small>
                  )}
                </div>
                <div className="album-look-actions">
                  {ownLook && d.albums.length > 0 && !albumLook?.set && (
                    <button type="button" className="btn quiet small" onClick={() => void ownAsAlbumLook()} title="Make this photo's edit (not its crop) the album's own look, so you can change it for all its photos at once">
                      Make it {d.albums[0].name}'s look
                    </button>
                  )}
                  {ownLook && <button type="button" className="btn quiet small" onClick={() => void removeLook()} title="Back to the original (keeps the crop); Undo in the message">Remove</button>}
                  <button type="button" className="btn quiet small" onClick={() => editIds([d.id])}>{edited ? "Edit" : "Edit look"}</button>
                </div>
              </div>}
              {album && (
                <div className="setrow album-look" style={{ borderTop: "1px solid var(--line-soft)" }}>
                  <div className="t">
                    <h6 className="h" style={{ marginBottom: 4 }}>{album.set ? `${album.albumName}'s look` : "Album look"}</h6>
                    {nameOf(album)}
                    <RecipeValues lookId={album.lookId} strength={album.strength} adjustments={album.adjustments} />
                    <small>
                      {album.set
                        ? `${plural(album.uses, "photo")} in ${album.albumName} on it${album.thisPhoto ? ", this one too" : ""}`
                        : `Suggested: the edit most used in ${album.albumName} (${plural(album.uses, "photo")})`}
                    </small>
                  </div>
                  <div className="album-look-actions">
                    {!album.thisPhoto && (
                      <>
                        <button type="button" className="btn quiet small" aria-pressed={trying} disabled={full || !!draft} onClick={() => setTrying((t) => !t)} title="See it on this photo, without saving">
                          {trying ? "This photo" : "Preview"} <kbd>\</kbd>
                        </button>
                        <button type="button" className="btn primary small" disabled={!!draft} onClick={() => void applyAlbumLook()}>Apply</button>
                      </>
                    )}
                    {album.set ? (
                      <button type="button" className="btn quiet small" aria-expanded={!!changeAt} onClick={(e) => (changeAt ? closeChange() : openChange(e.currentTarget))} title="Change the album's look (grain, strength…) and the photos on it">
                        Change…
                      </button>
                    ) : (
                      <button type="button" className="btn quiet small" onClick={() => void keepAlbumLook()} title="Make this the album's own look, so you can change it for all its photos at once">
                        Make it {album.albumName}'s look
                      </button>
                    )}
                  </div>
                </div>
              )}
              {album && draft && changeAt && (
                <Popover anchor={changeAt} onClose={closeChange} width={340}>
                  <div className="change-look">
                    <h6 className="h">{album.albumName}'s look</h6>
                    <p className="meta">Changes show on this photo. Saving updates the {plural(album.uses, "photo")} on it; photos edited their own way stay as they are.</p>
                    {draft.lookId && (
                      <label className="change-row">
                        <span>{nameOf(draft)} strength</span>
                        <input type="range" min={0} max={100} step={1} value={Math.round(draft.strength * 100)} onChange={(e) => setDraft({ ...draft, strength: Number(e.target.value) / 100 })} />
                        <output>{Math.round(draft.strength * 100)}%</output>
                      </label>
                    )}
                    {SECTIONS.map((sec) => (
                      <div key={sec.title} className="change-group">
                        <span className="eyebrow">{sec.title}</span>
                        {sec.sliders.map((def) => {
                          const v = draft.adjustments[def.key] ?? 0;
                          return (
                            <label key={def.key} className={`change-row${v !== 0 ? " moved" : ""}`}>
                              <span>{def.label}</span>
                              <input
                                type="range"
                                min={def.min}
                                max={def.max}
                                step={def.step}
                                value={v}
                                onChange={(e) => setDraft({ ...draft, adjustments: { ...draft.adjustments, [def.key]: Number(e.target.value) } })}
                                onDoubleClick={() => setDraft({ ...draft, adjustments: { ...draft.adjustments, [def.key]: 0 } })}
                              />
                              <output>{def.fmt ? def.fmt(v) : signed(v)}</output>
                            </label>
                          );
                        })}
                      </div>
                    ))}
                    <div className="row-flex" style={{ gap: 6, marginTop: 10 }}>
                      <button type="button" className="link" onClick={() => void forgetAlbumLook()}>Stop using as album look</button>
                      <span className="spacer" />
                      <button type="button" className="btn quiet small" onClick={closeChange}>Cancel</button>
                      <button type="button" className="btn primary small" onClick={() => void saveChange()}>Save</button>
                    </div>
                  </div>
                </Popover>
              )}

              <div className="setrow" style={{ borderTop: "1px solid var(--line-soft)" }}>
                <div className="t">
                  <h6 className="h">Albums</h6>
                  <div className="chips">
                    {d.albums.map((a) => (
                      <span key={a.id} className="chip">
                        {a.name}
                        <button type="button" className="x" aria-label={`Remove from ${a.name}`} onClick={() => api.albumRemove(a.id, [d.id]).then(() => { load(); bump(); })}>×</button>
                      </span>
                    ))}
                    <button type="button" className="chip add" onClick={(e) => openPop("album", e)} aria-label="Add to album">{Icon.plus(12)}</button>
                  </div>
                </div>
              </div>
              <div className="setrow mac-only" style={{ borderTop: "1px solid var(--line-soft)" }}>
                <div className="t">
                  <h6 className="h">Tags</h6>
                  <div className="chips">
                    {d.tags.map((t) => (
                      <span key={t.id} className="chip">
                        #{t.name}
                        <button type="button" className="x" aria-label={`Remove tag ${t.name}`} onClick={() => api.untagPhotos(t.id, [d.id]).then(() => { load(); bump(); })}>×</button>
                      </span>
                    ))}
                    <button type="button" className="chip add" onClick={(e) => openPop("tag", e)} aria-label="Add tag">{Icon.plus(12)}</button>
                  </div>
                </div>
              </div>
              <div className="setrow mac-only" style={{ borderTop: "1px solid var(--line-soft)", alignItems: "flex-start" }}>
                <div className="t">
                  <h6 className="h">
                    {d.postedCount ? `Posted ×${d.postedCount}` : "Never posted"}
                    {d.history.length > d.postedCount ? ` · ${d.history.length - d.postedCount} planned` : ""}
                  </h6>
                  <div className="rows">
                    {d.history.map((u) => (
                      <button key={u.postId} type="button" className="row" onClick={() => go({ name: "post", id: u.postId })}>
                        <span className={`stagepill st-${u.status}`}>{STATUS_LABEL[u.status]}</span>
                        <span className="who">
                          {u.title}
                          <small>
                            {u.accountUsername ? `@${u.accountUsername}` : "No account"}
                            {u.publishedAt ? ` · ${formatDay(u.publishedAt)}` : u.scheduledAt ? ` · planned ${formatDay(u.scheduledAt)}` : ""}
                          </small>
                        </span>
                        <span className="when">#{u.position + 1}</span>
                      </button>
                    ))}
                  </div>
                  <button type="button" className="btn quiet small" style={{ marginTop: 6 }} onClick={(e) => openPop("post", e)}>{Icon.plus(12)} Add to a post</button>
                </div>
              </div>
              <div className="setrow mac-only" style={{ borderTop: "1px solid var(--line-soft)" }}>
                <div className="t">
                  <h6 className="h">Website</h6>
                  <button type="button" className="btn quiet small" onClick={(e) => openPop("project", e)}>{Icon.plus(12)} Add to a project</button>
                </div>
              </div>
              <div className="setrow" style={{ borderTop: "1px solid var(--line-soft)", alignItems: "flex-start" }}>
                <div className="t">
                  <h6 className="h">Files</h6>
                  <dl className="kv">
                    {d.assets.map((a) => (
                      <div key={a.id} style={{ display: "contents" }}>
                        <dt>{a.isRaw ? "RAW" : a.format.toUpperCase()}</dt>
                        <dd>
                          <button type="button" className="link" onClick={() => api.reveal(a.path).catch((e) => toast(errorText(e), { error: true }))}>{a.filename}</button>
                          <span className="muted"> · {bytes(a.size)} · {STORAGE_LABEL[a.storage]}{a.isPrimary ? " · shown" : ""}</span>
                          {a.finderTagged && <span className="tag t-sel" style={{ marginLeft: 6 }}>Green tag</span>}
                          {a.archivedTo.length > 0 && <span className="tag t-idle" style={{ marginLeft: 6 }}>Archived</span>}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </div>
              {driveOriginal && (
                <div className="setrow mac-only" style={{ borderTop: "1px solid var(--line-soft)" }}>
                  <div className="t">
                    {/\/Library\/Mobile Documents\//.test(driveOriginal.path) ? "Original in iCloud Drive" : "Original on Google Drive"}
                    <small>{driveOriginal.storage === "cloud_only" ? `Online only · ${bytes(driveOriginal.size)}${d.isVideo ? " · plays from its light preview" : ""}` : `Downloaded on this Mac · ${bytes(driveOriginal.size)}`}</small>
                  </div>
                  <span className="row-flex" style={{ gap: 6 }}>
                    <button type="button" className="btn quiet small" onClick={viewInSource} title="Open this file in Google Drive in your browser">
                      View in source
                    </button>
                    <button type="button" className="btn quiet small" onClick={() => setDownloading(true)}>
                      {driveOriginal.storage === "cloud_only" ? "Download" : "Remove download"}
                    </button>
                  </span>
                </div>
              )}
              <div className="setrow mac-only" style={{ borderTop: "1px solid var(--line-soft)" }}>
                <div className="t">
                  Keep a copy on this Mac
                  <small>{hasCopy ? "Copied: viewable and editable when the drive is unplugged" : "For editing and posting without the drive"}</small>
                </div>
                <button type="button" className="btn quiet small" onClick={() => offline(!hasCopy)}>{hasCopy ? "Remove copy" : "Keep offline"}</button>
              </div>
            </>
          )}
        </aside>
      </div>
      {downloading && d && (
        <DownloadDialog
          photoIds={[d.id]}
          what={d.isVideo ? "clip" : "original"}
          title={driveOriginal?.storage === "cloud_only" ? "Download the original" : "The original on this Mac"}
          onClose={(changed) => {
            setDownloading(false);
            if (changed) load();
          }}
        />
      )}
      {pop === "album" && <AlbumPopover anchor={anchor} ids={[route.id]} onClose={() => { setPop(null); load(); }} />}
      {pop === "tag" && <TagPopover anchor={anchor} ids={[route.id]} onClose={() => { setPop(null); load(); }} />}
      {pop === "post" && <PostPopover anchor={anchor} ids={[route.id]} onClose={() => { setPop(null); load(); }} />}
      {pop === "project" && <ProjectPopover anchor={anchor} ids={[route.id]} onClose={() => setPop(null)} />}
      {similar && (
        <Modal title={`${similar.length} similar shots`} onClose={() => setSimilar(null)} wide>
          <div className="similar-shots" style={{ gridTemplateColumns: `repeat(${Math.min(similar.length, 4)}, minmax(0, 1fr))` }}>
            {similar.map((r) => (
              <figure key={r.id} className={r.id === route.id ? "on" : ""}>
                <img src={imageUrl("preview", r.id)} alt="" />
                <figcaption className="row-flex" style={{ gap: 6, flexWrap: "wrap" }}>
                  <span className="meta" style={{ flex: 1 }}>
                    {r.filename}
                  </span>
                  {(["selected", "maybe", "rejected"] as ReviewState[]).map((st) => (
                    <button
                      key={st}
                      type="button"
                      className="btn small quiet"
                      aria-pressed={r.review === st}
                      onClick={async () => {
                        await mark([r.id], st);
                        setSimilar((list) => list?.map((x) => (x.id === r.id ? { ...x, review: st } : x)) ?? null);
                      }}
                    >
                      {st === "selected" ? "Select" : st === "maybe" ? "Maybe" : "Reject"}
                    </button>
                  ))}
                  {r.id !== route.id && (
                    <button type="button" className="btn small quiet" onClick={() => (setSimilar(null), replace({ ...route, id: r.id }))}>Open</button>
                  )}
                </figcaption>
              </figure>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

/** What an edit is made of, value by value: the look's strength, then each moved slider. */
function RecipeValues({ lookId, strength, adjustments }: { lookId: string | null; strength: number; adjustments: Partial<Adjustments> }) {
  const values = sliderValues(adjustments);
  if (!lookId && !values.length) return null;
  return (
    <span className="recipe" aria-label="Its settings">
      {lookId && <span>Strength {Math.round(strength * 100)}%</span>}
      {values.map((v) => (
        <span key={v.key}>
          {v.label} {v.value}
        </span>
      ))}
    </span>
  );
}
