// A modal grid to choose photos (for a post, an album cover, an avatar).
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { Query, ReviewState } from "../types";
import { PhotoGrid } from "./PhotoGrid";
import { Modal, Select } from "./ui";

interface Props {
  title: string;
  max?: number;
  onPick: (ids: string[]) => void;
  onClose: () => void;
  /** Offer 'Not in a post yet' (on by default) and an album filter: for filling a post. */
  notInPost?: boolean;
  /** Photos picked from the start (e.g. what is selected in Pictures). */
  initial?: string[];
}

export function PhotoPicker({ title, max, onPick, onClose, notInPost, initial }: Props) {
  const { keymap, version, mark, albums } = useStore();
  const [review, setReview] = useState<ReviewState | null>("selected");
  const [search, setSearch] = useState("");
  const [unused, setUnused] = useState(!!notInPost);
  const [album, setAlbum] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set((initial ?? []).slice(0, max ?? Infinity)));
  // The footer says where the picks came from until you change them.
  const [seeded, setSeeded] = useState(() => picked.size > 0);
  const [total, setTotal] = useState(0);
  const query: Query = { review, search: search || null, order: "newest", social: unused ? "unused" : null, album: album || null };
  useEffect(() => {
    api.counts(query).then((c) => setTotal(review ? c[review] : c.all)).catch(() => {});
  }, [review, search, unused, album, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const over = max != null && picked.size > max;
  const pick = useCallback((next: Set<string>) => {
    setPicked(next);
    setSeeded(false);
  }, []);
  return (
    <Modal
      wide
      title={title}
      onClose={onClose}
      foot={
        <>
          <span className="meta">
            {picked.size ? `${picked.size} picked${seeded ? " (from Pictures)" : ""}${over ? ` · ${max} max` : ""}` : "Click to pick · ⌘-click or shift-click for more"}
            {picked.size > 0 && (
              <>
                {" · "}
                <button type="button" className="link" style={{ fontSize: "inherit" }} onClick={() => pick(new Set())}>Clear</button>
              </>
            )}
          </span>
          <span className="spacer" />
          <button type="button" className="btn quiet" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!picked.size || over} onClick={() => onPick([...picked])}>
            Add {picked.size || ""}
          </button>
        </>
      }
    >
      <div className="row-flex" style={{ marginBottom: 12, flexWrap: "wrap" }}>
        <div className="tabs">
          {([["selected", "Selected"], ["maybe", "Maybe"], [null, "Everything"]] as const).map(([k, l]) => (
            <button key={l} type="button" className="tab" aria-selected={review === k} onClick={() => setReview(k)}>{l}</button>
          ))}
        </div>
        {notInPost && (
          <>
            <button type="button" className="chip" aria-pressed={unused} onClick={() => setUnused(!unused)}>Not in a post yet</button>
            {albums.length > 0 && (
              <Select className={album ? "pick on" : "pick"} aria-label="Album" value={album} onChange={(e) => setAlbum(e.target.value)}>
                <option value="">All albums</option>
                {albums.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            )}
          </>
        )}
        <input className="search" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div style={{ height: "56vh", display: "flex", flexDirection: "column" }}>
        <PhotoGrid query={query} total={total} version={version} columns={6} selection={picked} onSelection={pick} onOpen={(_, p) => onPick([p.id])} onMark={mark} keymap={keymap} active={false} />
      </div>
    </Modal>
  );
}
