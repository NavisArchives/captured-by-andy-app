// The library as a virtualised grid: only visible rows exist in the DOM, rows
// load in pages, and selection works like Finder (click, ⌘-click, shift-click,
// ⌘A). Marks (A/S/D) apply to the picked photos, or the one under the cursor.
import { useVirtualizer } from "@tanstack/react-virtual";
import { touch } from "../platform";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import { usePhotoWindow } from "../hooks/usePhotoWindow";
import { actionFor, type Keymap } from "../keymap";
import { formatDuration } from "../lib/format";
import type { PhotoRow, Query, ReviewState } from "../types";
import { Thumb } from "./Thumb";
import { Icon, ReviewBadge, typing } from "./ui";

interface Props {
  query: Query;
  total: number;
  version: number;
  columns: number;
  selection: Set<string>;
  onSelection: (next: Set<string>) => void;
  onOpen: (index: number, photo: PhotoRow) => void;
  onMark: (ids: string[], state: ReviewState) => Promise<boolean | void> | boolean | void;
  /** ⌘Z: put back the last mark; resolves to the restored photo ids. */
  undoMark?: () => Promise<string[]>;
  onEdit?: (ids: string[]) => void;
  keymap: Keymap;
  /** Keyboard shortcuts only while this grid is on screen and no dialog is up. */
  active?: boolean;
  /** When set, tiles can be dragged (e.g. onto an album); data is a JSON list of ids. */
  dragType?: string;
  /** Lets the page run the same mark-and-advance as the keys (for its buttons). */
  handle?: React.MutableRefObject<GridHandle | null>;
  /** With several photos picked, the one to come back to (last open on the photo page). */
  focusId?: string | null;
  /** Right-click: the picked set when the tile is one of them, else just that tile. */
  onMenu?: (e: React.MouseEvent, ids: string[], photo: PhotoRow, index: number) => void;
}

export interface GridHandle {
  markAndAdvance: (state: ReviewState) => void;
}

const GAP = 8;

export function PhotoGrid({ query, total, version, columns, selection, onSelection, onOpen, onMark, undoMark, onEdit, keymap, active = true, dragType, handle, focusId, onMenu }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [cursor, setCursor] = useState(0);
  const anchor = useRef(0);
  const [marks, setMarks] = useState<Record<string, ReviewState>>({});
  const { get, ensure, refresh, key: viewKey } = usePhotoWindow(query, version);
  const [reloads, setReloads] = useState(0);

  useEffect(() => setMarks({}), [version]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // The scroller has 6 px padding each side (room for the pick rings).
    const ro = new ResizeObserver(() => setWidth(el.clientWidth - 12));
    ro.observe(el);
    setWidth(el.clientWidth - 12);
    return () => ro.disconnect();
  }, []);

  const size = Math.max(60, (width - GAP * (columns - 1)) / columns);
  const rows = Math.ceil(total / columns);
  const virtual = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => size + GAP,
    overscan: 4,
  });
  useEffect(() => virtual.measure(), [size, virtual]);

  const items = virtual.getVirtualItems();
  useEffect(() => {
    if (!items.length) return;
    ensure(items[0].index * columns, (items[items.length - 1].index + 1) * columns);
  }, [items, columns, ensure, version, viewKey, reloads]);

  const idsBetween = useCallback(
    async (a: number, b: number) => {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      return api.photoIds(query, lo, hi - lo + 1);
    },
    [query],
  );

  const click = useCallback(
    async (e: React.MouseEvent, index: number, photo: PhotoRow, viaBox = false) => {
      setCursor(index);
      if (e.shiftKey) {
        const ids = await idsBetween(anchor.current, index);
        const next = e.metaKey ? new Set(selection) : new Set<string>();
        ids.forEach((id) => next.add(id));
        onSelection(next);
        return;
      }
      anchor.current = index;
      // By touch: a tap opens, unless photos are being picked.
      if (touch() && !viaBox && !e.metaKey && !e.ctrlKey) {
        if (!selection.size) return onOpen(index, photo);
        viaBox = true;
      }
      if (e.metaKey || e.ctrlKey || viaBox) {
        const next = new Set(selection);
        if (next.has(photo.id)) next.delete(photo.id);
        else next.add(photo.id);
        onSelection(next);
      } else {
        onSelection(selection.size === 1 && selection.has(photo.id) ? new Set() : new Set([photo.id]));
      }
    },
    [idsBetween, onSelection, selection, onOpen],
  );

  const moveCursor = useCallback(
    (to: number) => {
      const i = Math.max(0, Math.min(total - 1, to));
      setCursor(i);
      anchor.current = i;
      virtual.scrollToIndex(Math.floor(i / columns), { align: "auto" });
      // The pick always follows the cursor; if its tile is still loading there
      // is no pick, so a mark can never hit a photo you have scrolled past.
      const p = get(i);
      onSelection(p ? new Set([p.id]) : new Set());
    },
    [total, virtual, columns, get, onSelection],
  );

  // Like swiping: mark, then move on. Note the next photo first (by sort key,
  // so any order works), mark, then find where that next photo sits now: in a
  // filtered view the marked one may have dropped out, or with "Recently
  // reviewed" jumped to the top. Marks pressed meanwhile are ignored, so
  // nothing is marked twice. Latest cursor/selection are read from refs.
  const advancing = useRef(false);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const goTo = useCallback(
    (index: number, id: string | null) => {
      refresh();
      setReloads((n) => n + 1);
      setCursor(index);
      anchor.current = index;
      onSelection(id ? new Set([id]) : new Set());
      virtual.scrollToIndex(Math.floor(index / columns), { align: "auto" });
    },
    [onSelection, virtual, columns, refresh],
  );
  const markAndAdvance = useCallback(
    async (state: ReviewState) => {
      if (advancing.current) return;
      const sel = selectionRef.current;
      const cur = cursorRef.current;
      const ids = sel.size ? [...sel] : get(cur) ? [get(cur)!.id] : [];
      if (!ids.length) return;
      const unshow = () =>
        setMarks((m) => {
          const copy = { ...m };
          ids.forEach((id) => delete copy[id]);
          return copy;
        });
      setMarks((m) => ({ ...m, ...Object.fromEntries(ids.map((id) => [id, state])) }));
      if (ids.length > 1) {
        if ((await onMark(ids, state)) === false) unshow();
        return;
      }
      advancing.current = true;
      try {
        const id = ids[0];
        const next = await api.neighbor(query, id, 1);
        if ((await onMark(ids, state)) === false) return unshow();
        const at = next ? await api.position(query, next[0]) : null;
        if (next && at != null) return goTo(at, next[0]);
        // End of the list: stay on the photo if it is still here, else step back.
        const here = await api.position(query, id);
        if (here != null) return goTo(here, id);
        const prev = await api.neighbor(query, id, -1);
        goTo(prev ? prev[1] : 0, prev ? prev[0] : null);
      } catch {
        unshow();
      } finally {
        advancing.current = false;
      }
    },
    [get, onMark, query, goTo],
  );

  // Coming back to the grid (e.g. from a photo page): put the cursor back on
  // the photo you were on instead of at the top. With one pick that is the
  // pick; with several, the one last open, and the picks stay as they are.
  useEffect(() => {
    const picks = selectionRef.current;
    const only = picks.size === 1 ? [...picks][0] : null;
    const target = only ?? (picks.size > 1 ? focusId : null);
    if (!target) return;
    api.position(query, target).then((at) => {
      if (at == null) return only ? onSelection(new Set()) : undefined;
      setCursor(at);
      anchor.current = at;
      virtual.scrollToIndex(Math.floor(at / columns), { align: "center" });
    }).catch(() => {});
    // Only on mount / when the view changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(query)]);

  if (handle) handle.current = { markAndAdvance };

  useEffect(() => {
    if (!active) return;
    const onKey = async (e: KeyboardEvent) => {
      if (typing(e) || document.querySelector(".scrim")) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z" && undoMark) {
        if (e.repeat) return;
        e.preventDefault();
        const restored = await undoMark();
        if (restored.length === 1) {
          const at = await api.position(query, restored[0]);
          if (at != null) goTo(at, restored[0]);
        }
        return;
      }
      if (meta && e.key.toLowerCase() === "a") {
        e.preventDefault();
        onSelection(new Set(await api.photoIds(query, 0, total)));
        return;
      }
      if (e.key === "Escape" && selection.size) {
        onSelection(new Set());
        return;
      }
      if (e.key === "ArrowRight") return e.preventDefault(), moveCursor(cursor + 1);
      if (e.key === "ArrowLeft") return e.preventDefault(), moveCursor(cursor - 1);
      if (e.key === "ArrowDown") return e.preventDefault(), moveCursor(cursor + columns);
      if (e.key === "ArrowUp") return e.preventDefault(), moveCursor(cursor - columns);
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        // Open the picked photo (it is what the pick ring shows), not whatever
        // a still-refreshing page has at the cursor.
        const only = selection.size === 1 ? [...selection][0] : null;
        const p = get(cursor);
        if (only && p?.id !== only) {
          const at = await api.position(query, only);
          if (at != null) {
            const [row] = await api.rows([only]);
            if (row) onOpen(at, row);
          }
          return;
        }
        if (p) onOpen(cursor, p);
        return;
      }
      if (!meta && e.key.toLowerCase() === "e" && onEdit) {
        const ids = selection.size ? [...selection] : get(cursor) ? [get(cursor)!.id] : [];
        if (ids.length) onEdit(ids);
        return;
      }
      const action = actionFor(e, keymap);
      const state: ReviewState | null =
        action === "select" ? "selected" : action === "reject" ? "rejected" : action === "maybe" ? "maybe" : action === "unmark" ? "unreviewed" : null;
      if (!state) return;
      e.preventDefault();
      if (e.repeat) return; // holding a key must not mark a run of photos
      void markAndAdvance(state);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, query, total, selection, onSelection, cursor, columns, moveCursor, get, onOpen, onEdit, keymap, markAndAdvance, undoMark, goTo]);

  return (
    <div ref={scrollRef} className={selection.size ? "grid-scroll grid-picking" : "grid-scroll"} tabIndex={-1}>
      <div style={{ height: virtual.getTotalSize() + 72, position: "relative" }}>
        {items.map((row) =>
          Array.from({ length: columns }, (_, c) => {
            const index = row.index * columns + c;
            if (index >= total) return null;
            const photo = get(index);
            return (
              <Tile
                key={`i${index}`}
                photo={photo}
                index={index}
                left={c * (size + GAP)}
                top={row.start}
                size={size}
                picked={!!photo && selection.has(photo.id)}
                isCursor={index === cursor}
                review={photo ? (marks[photo.id] ?? photo.review) : "unreviewed"}
                onClick={click}
                onOpen={onOpen}
                onMenu={onMenu ? (e, p) => { setCursor(index); onMenu(e, selection.has(p.id) ? [...selection] : [p.id], p, index); } : undefined}
                onDrag={dragType ? (e, p) => {
                  const ids = selection.has(p.id) ? [...selection] : [p.id];
                  e.dataTransfer.setData(dragType, JSON.stringify(ids));
                  e.dataTransfer.effectAllowed = "copy";
                  const ghost = document.createElement("div");
                  ghost.className = "drag-ghost";
                  ghost.textContent = ids.length === 1 ? "1 photo" : `${ids.length.toLocaleString()} photos`;
                  // WebKit snapshots the label where it sits: off-screen it can
                  // come out blank, so put it under the pointer, behind the page.
                  ghost.style.left = `${e.clientX}px`;
                  ghost.style.top = `${e.clientY}px`;
                  ghost.style.zIndex = "-1";
                  document.body.appendChild(ghost);
                  e.dataTransfer.setDragImage(ghost, 20, 16);
                  setTimeout(() => ghost.remove(), 0);
                } : undefined}
              />
            );
          }),
        )}
      </div>
    </div>
  );
}

interface TileProps {
  photo: PhotoRow | undefined;
  index: number;
  left: number;
  top: number;
  size: number;
  picked: boolean;
  isCursor: boolean;
  review: ReviewState;
  onClick: (e: React.MouseEvent, index: number, photo: PhotoRow, viaBox?: boolean) => void;
  onOpen: (index: number, photo: PhotoRow) => void;
  onDrag?: (e: React.DragEvent, photo: PhotoRow) => void;
  onMenu?: (e: React.MouseEvent, photo: PhotoRow) => void;
}

const Tile = memo(function Tile({ photo, index, left, top, size, picked, isCursor, review, onClick, onOpen, onDrag, onMenu }: TileProps) {
  const cls = ["tile", picked && "picked", isCursor && "cursor", review === "rejected" && "rej"].filter(Boolean).join(" ");
  return (
    <div
      className={cls}
      style={{ left, top, width: size, height: size }}
      onClick={(e) => photo && onClick(e, index, photo)}
      onDoubleClick={() => photo && onOpen(index, photo)}
      onContextMenu={(e) => photo && onMenu?.(e, photo)}
      draggable={!!(onDrag && photo)}
      onDragStart={(e) => photo && onDrag?.(e, photo)}
      role="gridcell"
      aria-selected={picked}
      aria-label={photo?.filename}
    >
      {photo ? <Thumb key={photo.id} id={photo.id} hash={photo.thumbhash} ready={photo.thumb === "ready"} /> : <div className="thumb" />}
      {photo && (
        <>
          <ReviewBadge state={review} />
          <button
            type="button"
            className="pickbox"
            aria-label={picked ? "Unpick" : "Pick"}
            onClick={(e) => {
              e.stopPropagation();
              onClick(e, index, photo, true);
            }}
          >
            {picked && Icon.check(11)}
          </button>
          <div className="lbls">
            {photo.media === "raw_image" && <span className="lbl">RAW+JPG</span>}
            {photo.media === "raw" && <span className="lbl">RAW</span>}
            {photo.postedCount > 0 && <span className="lbl">{photo.postedCount > 1 ? `Posted ×${photo.postedCount}` : "Posted"}</span>}
            {photo.postedCount === 0 && photo.social !== "unused" && <span className="lbl">In a post</span>}
            {photo.edited && <span className="lbl">Edited</span>}
            {photo.burst > 1 && <span className="lbl">Similar {photo.burst}</span>}
            {photo.soft && <span className="lbl warn">Soft</span>}
            {photo.storage === "cloud_only" && <span className="lbl">Online</span>}
            {photo.storage === "missing" && <span className="lbl warn">Missing</span>}
          </div>
          {photo.isVideo && <VideoBadge seconds={photo.duration} />}
        </>
      )}
    </div>
  );
});

/** ▶ and the length, on a video's tile. */
export function VideoBadge({ seconds }: { seconds: number | null }) {
  return (
    <span className="vid-badge" aria-label="Video">
      <svg width="8" height="9" viewBox="0 0 8 9" aria-hidden="true">
        <path d="M0 0.5v8l7.5-4z" fill="currentColor" />
      </svg>
      {formatDuration(seconds)}
    </span>
  );
}
