// Quick add, step two: one photo at a time, like swiping. Y puts it in the
// album, N passes it by (and takes it out again if a Y put it in earlier).
// Only the album changes: review marks, files and folders stay as they are.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText, imageUrl } from "../api";
import { VideoBadge } from "../components/PhotoGrid";
import { placeholder, Thumb } from "../components/Thumb";
import { Icon, useToast } from "../components/ui";
import { actionFor, firstKeyLabel } from "../keymap";
import { formatDate, plural, STORAGE_LABEL } from "../lib/format";
import { useStore, type QuickAddSession } from "../store";
import { useIdWindow } from "./Cull";
import "../styles/cull-summary.css";
import "../styles/quick-add.css";

export function QuickAdd({ session }: { session: QuickAddSession }) {
  const { keymap, endQuickAdd, go, setQuery, setSelection, bump } = useStore();
  const toast = useToast();
  const { album, ids } = session;
  const total = ids.length;
  const { get, ensure, gone, tick } = useIdWindow(ids);
  const [index, setIndex] = useState(0);
  // What this round put in the album (photos already in it were left out).
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<{ id: string; was: boolean; index: number }[]>([]);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [focus, setFocus] = useState(false);
  const [done, setDone] = useState(false);
  const doneShown = useRef(false);
  const lastStep = useRef<1 | -1>(1);

  // A photo that no longer exists is skipped in the direction you were going.
  useEffect(() => {
    if (!gone(index)) return;
    const next = index + lastStep.current;
    if (next < 0 || next >= total) lastStep.current = lastStep.current === 1 ? -1 : 1;
    setIndex((i) => Math.max(0, Math.min(total - 1, i + lastStep.current)));
  });
  useEffect(() => ensure(index - 12, index + 40), [index, ensure, tick]);
  const photo = get(index);

  // The next previews are decoded ahead, so Y-N-N-Y at full speed shows the
  // photo, not the blurred thumbnail.
  const warm = useRef(new Map<string, HTMLImageElement>());
  useEffect(() => {
    const want: string[] = [];
    for (let d = -2; d <= 8; d++) {
      const p = d ? get(index + d) : undefined;
      if (p) want.push(p.id);
    }
    for (const id of want) {
      if (warm.current.has(id)) continue;
      const img = new Image();
      img.decoding = "async";
      img.src = imageUrl("preview", id);
      img.decode().catch(() => {});
      warm.current.set(id, img);
    }
    const keep = new Set(want);
    for (const id of warm.current.keys()) {
      if (warm.current.size <= 16) break;
      if (!keep.has(id)) warm.current.delete(id);
    }
  }, [index, get, photo, tick]);

  // Album changes reach the library one after another, in the order made.
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const put = useCallback(
    (id: string, inAlbum: boolean) => {
      const show = (on: boolean) =>
        setAdded((s) => {
          const next = new Set(s);
          if (on) next.add(id);
          else next.delete(id);
          return next;
        });
      show(inAlbum);
      writes.current = writes.current
        .then(() => (inAlbum ? api.albumAdd(album.id, [id]) : api.albumRemove(album.id, [id])))
        .catch((e) => {
          // Not saved: the screen goes back to what the album really holds.
          show(!inAlbum);
          toast(errorText(e), { error: true });
        });
    },
    [album.id, toast],
  );

  const decide = useCallback(
    (yes: boolean) => {
      if (!photo) return;
      const was = added.has(photo.id);
      setHistory((h) => [...h.slice(-199), { id: photo.id, was, index }]);
      if (yes !== was) put(photo.id, yes);
      lastStep.current = 1;
      setIndex((i) => Math.min(i + 1, total - 1));
    },
    [photo, added, index, total, put],
  );

  const undo = useCallback(() => {
    const last = history[history.length - 1];
    if (!last) return toast("Nothing to undo");
    setHistory((h) => h.slice(0, -1));
    if (added.has(last.id) !== last.was) put(last.id, last.was);
    setIndex(last.index);
  }, [history, added, put, toast]);

  const openAlbum = useCallback(() => {
    setQuery({ order: "newest", album: album.id });
    setSelection(new Set());
    go({ name: "pictures" });
  }, [album.id, setQuery, setSelection, go]);

  const finish = useCallback(
    (open = false) => {
      endQuickAdd();
      // Once the last change is saved, every screen shows the album as it is.
      void writes.current.then(bump);
      if (open) return openAlbum();
      const n = added.size;
      toast(n ? `${plural(n, "photo")} added to ${album.name}` : `Nothing added to ${album.name}`, n ? { action: { label: "Open", run: openAlbum } } : undefined);
    },
    [endQuickAdd, bump, openAlbum, added, album.name, toast],
  );

  const atEnd = index === total - 1 && !!photo && history.some((h) => h.id === photo.id);
  useEffect(() => {
    if (atEnd && !doneShown.current) {
      doneShown.current = true;
      setDone(true);
    }
  }, [atEnd]);

  useEffect(() => {
    // Capture phase: no screen underneath ever sees these keys.
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".scrim")) return;
      if (e.key !== "?") e.stopImmediatePropagation();
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        setDone(false);
        return undo();
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const action = actionFor(e, keymap);
      if (done) {
        if (e.key === "Enter" || e.key.toLowerCase() === "o") {
          e.preventDefault();
          return finish(true);
        }
        if (action === "exit" || e.key === "Escape") {
          e.preventDefault();
          return finish();
        }
        if (action === "previous") {
          e.preventDefault();
          return setDone(false);
        }
        return;
      }
      const k = e.key.toLowerCase();
      // Y and N, or the select and reject keys used for culling.
      if (k === "y" || action === "select") {
        e.preventDefault();
        // Holding the key never fills the album by accident.
        if (!e.repeat) decide(true);
        return;
      }
      if (k === "n" || action === "reject") {
        e.preventDefault();
        return decide(false);
      }
      switch (action) {
        case "previous":
          e.preventDefault();
          lastStep.current = -1;
          return setIndex((i) => Math.max(0, i - 1));
        case "next":
          e.preventDefault();
          lastStep.current = 1;
          return setIndex((i) => Math.min(total - 1, i + 1));
        case "focus":
          e.preventDefault();
          return setFocus((f) => !f);
        case "exit":
          e.preventDefault();
          return focus ? setFocus(false) : finish();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        finish();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const inAlbum = !!photo && added.has(photo.id);
  const stripStart = Math.max(0, index - 5);

  return (
    <div className={focus ? "cull night focus quick-add" : "cull night quick-add"}>
      <header className="cull-top focus-hide">
        <button type="button" className="btn quiet" style={{ color: "var(--ink)" }} onClick={() => finish()}>
          {Icon.back()} Done <kbd>{firstKeyLabel(keymap.exit)}</kbd>
        </button>
        <span className="meta qa-title">
          Quick add to <b>{album.name}</b> · {(index + 1).toLocaleString()} of {total.toLocaleString()}
        </span>
        <span className="spacer" />
        <div className="bar qa-progress" style={{ background: "var(--line)" }}>
          <i style={{ width: `${((index + 1) / total) * 100}%`, background: "var(--green)" }} />
        </div>
        <span className="meta">{plural(added.size, "photo")} added</span>
      </header>

      <div className="stage" onClick={() => setFocus((f) => !f)}>
        {photo && (
          <>
            <img
              key={`under-${photo.id}`}
              className="stage-under"
              alt=""
              src={photo.thumb === "ready" ? imageUrl("thumb", photo.id) : placeholder(photo.thumbhash)}
              style={{ visibility: loadedId === photo.id ? "hidden" : "visible" }}
              onError={(e) => {
                const blur = placeholder(photo.thumbhash);
                if (blur && e.currentTarget.src !== blur) e.currentTarget.src = blur;
                else e.currentTarget.style.visibility = "hidden";
              }}
            />
            <img
              key={photo.id}
              className="stage-image"
              alt={photo.filename}
              src={imageUrl("preview", photo.id)}
              onLoad={() => setLoadedId(photo.id)}
              onError={(e) => (e.currentTarget.style.visibility = "hidden")}
            />
            {photo.isVideo && (
              <span className="lbl cull-video-note">
                <VideoBadge seconds={photo.duration} /> Video
              </span>
            )}
            {inAlbum && (
              <span className="lbl qa-in">
                {Icon.check()} In {album.name}
              </span>
            )}
          </>
        )}
        {done && (
          <div className="cull-sum" onClick={(e) => e.stopPropagation()}>
            <section className="card" role="dialog" aria-label="All done">
              <h2>
                That's all {total.toLocaleString()} · <span>{plural(added.size, "photo")} added to {album.name}</span>
              </h2>
              <div className="rows">
                <button type="button" className="row" onClick={() => finish(true)}>
                  <kbd>↵</kbd>
                  <span className="who">Open {album.name}<small>The album as it is now</small></span>
                </button>
                <button type="button" className="row" onClick={() => setDone(false)}>
                  <kbd>←</kbd>
                  <span className="who">Back to the photos<small>Change your mind on any of them</small></span>
                </button>
              </div>
              <p className="meta foot">
                <kbd>Esc</kbd> close · every Y is already saved
              </p>
            </section>
          </div>
        )}
      </div>

      <div className="strip focus-hide" aria-hidden="true">
        {Array.from({ length: 11 }, (_, k) => stripStart + k)
          .filter((i) => i < total)
          .map((i) => {
            const p = get(i);
            return (
              <button key={i} type="button" tabIndex={-1} className={`f${i === index ? " now" : ""}`} onClick={() => setIndex(i)}>
                {p && <Thumb id={p.id} hash={p.thumbhash} ready={p.thumb === "ready"} />}
                {p && added.has(p.id) && <i className="dot d-ok" />}
              </button>
            );
          })}
      </div>

      <footer className="cull-bar focus-hide">
        <span className={`tag ${inAlbum ? "t-sel" : "t-idle"}`}>{inAlbum ? "Added" : "Not added"}</span>
        <div className="qa-file">
          <div className="name">{photo?.filename ?? "…"}</div>
          <div className="meta">
            {photo ? formatDate(photo.capturedAt) : ""}
            {photo && photo.storage !== "local" ? ` · ${STORAGE_LABEL[photo.storage]}` : ""}
          </div>
        </div>
        <span className="spacer" />
        <button type="button" className={`markbtn selected${inAlbum ? " on" : ""}`} onClick={() => decide(true)}>
          <kbd>Y</kbd>
          {Icon.check()}
          Add
        </button>
        <button type="button" className="markbtn" onClick={() => decide(false)}>
          <kbd>N</kbd>
          {Icon.x()}
          {inAlbum ? "Take out" : "Skip"}
        </button>
        <span className="meta qa-keys">← → move · Space focus · ⌘Z undo</span>
      </footer>
    </div>
  );
}
