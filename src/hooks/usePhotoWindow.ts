// Rows for a virtualised view of 100k+ photos, fetched in pages as they scroll
// into view. `version` invalidates cached pages (new scan results, fresh
// thumbnails, marks); pass a fixed version to freeze the list, as cull mode
// does so photos don't shift under the cursor while you review them.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { PhotoRow, Query } from "../types";

const PAGE = 200;

export function queryKey(q: Query): string {
  return JSON.stringify(Object.entries(q).filter(([, v]) => v != null && v !== "").sort());
}

export function usePhotoWindow(query: Query, version: number) {
  const pages = useRef(new Map<number, PhotoRow[]>());
  const loading = useRef(new Set<number>());
  const stale = useRef(new Set<number>());
  const [, setTick] = useState(0);
  const key = queryKey(query);
  const keyRef = useRef(key);
  const queryRef = useRef(query);
  queryRef.current = query;

  if (keyRef.current !== key) {
    keyRef.current = key;
    pages.current = new Map();
    loading.current = new Set();
    stale.current = new Set();
  }

  useEffect(() => {
    stale.current = new Set(pages.current.keys());
    setTick((t) => t + 1);
  }, [version]);

  const load = useCallback((page: number) => {
    if (loading.current.has(page)) return;
    if (pages.current.has(page) && !stale.current.has(page)) return;
    loading.current.add(page);
    const requestKey = keyRef.current;
    api
      .listPhotos(queryRef.current, page * PAGE, PAGE)
      .then((rows) => {
        if (keyRef.current !== requestKey) return;
        pages.current.set(page, rows);
        stale.current.delete(page);
        setTick((t) => t + 1);
      })
      .catch(() => {})
      .finally(() => loading.current.delete(page));
  }, []);

  const ensure = useCallback(
    (start: number, end: number) => {
      for (let page = Math.floor(Math.max(0, start) / PAGE); page <= Math.floor(Math.max(0, end) / PAGE); page++) load(page);
    },
    [load],
  );

  const get = useCallback((index: number): PhotoRow | undefined => pages.current.get(Math.floor(index / PAGE))?.[index % PAGE], []);

  /** Refetch what is on screen now (after a mark reshuffled the view). */
  const refresh = useCallback(() => {
    stale.current = new Set(pages.current.keys());
    setTick((t) => t + 1);
  }, []);

  return { get, ensure, refresh, key };
}
