import { listen } from "@tauri-apps/api/event";
import { memo, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { thumbHashToDataURL } from "thumbhash";
import { sized, sizedImageUrl } from "../api";
import { WEB } from "../platform";

// A tile whose file was gone is made again in the background ("thumb-healed"):
// the tiles showing that photo try once more.
const healedAt = new Map<string, number>();
const waiting = new Map<string, Set<() => void>>();
let listening = false;
function useHealed(id: string | null | undefined): number {
  const [, again] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!id || WEB) return;
    if (!listening) {
      listening = true;
      void listen<string>("thumb-healed", (e) => {
        healedAt.set(e.payload, Date.now());
        waiting.get(e.payload)?.forEach((f) => f());
      });
    }
    const set = waiting.get(id) ?? new Set();
    waiting.set(id, set);
    set.add(again);
    return () => {
      set.delete(again);
      if (!set.size) waiting.delete(id);
    };
  }, [id]);
  return id ? (healedAt.get(id) ?? 0) : 0;
}

const placeholders = new Map<string, string>();

/** The ThumbHash decoded into a tiny blurred image, cached per hash. */
export function placeholder(hash: string | null | undefined): string | undefined {
  if (!hash) return undefined;
  let url = placeholders.get(hash);
  if (!url) {
    try {
      url = thumbHashToDataURL(Uint8Array.from(atob(hash), (c) => c.charCodeAt(0)));
    } catch {
      return undefined;
    }
    placeholders.set(hash, url);
  }
  return url;
}

interface Props {
  id: string | null | undefined;
  hash?: string | null;
  ready?: boolean;
  kind?: "thumb" | "preview";
  contain?: boolean;
}

/** A photo from the cache, over its blurred placeholder so nothing pops in empty. */
export const Thumb = memo(function Thumb({ id, hash, ready = true, kind = "thumb", contain }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const healed = useHealed(id);
  useEffect(() => {
    if (healed) setFailed(false);
  }, [healed]);
  const blur = placeholder(hash);
  // Online, ask for the size the tile is shown at (measured before the first paint).
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!sized.url || !box.current) return;
    const w = Math.round(box.current.getBoundingClientRect().width);
    setWidth(w > 0 ? w : null);
  }, [id]);
  const waiting = !!sized.url && width === null;
  const src = sizedImageUrl(kind, id ?? "", width);
  return (
    <div ref={box} className={contain ? "thumb contain" : "thumb"} style={blur ? { backgroundImage: `url(${blur})` } : undefined}>
      {id && ready && !failed && !waiting && (
        <img
          src={healed ? `${src}?h=${healed}` : src}
          alt=""
          draggable={false}
          decoding="async"
          loading="lazy"
          className={loaded ? "loaded" : undefined}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
});
