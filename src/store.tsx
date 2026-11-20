// App-wide state: where you are, what the library looks like right now, what
// is picked, and the actions every screen shares (mark, cull, add folder).
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorText } from "./api";
import { useToast } from "./components/ui";
import { DEFAULT_KEYMAP, parseKeymap, type Keymap } from "./keymap";
import { studio } from "./studio/api";
import { applyMode, type Mode } from "./theme";
import type { Account, Album, Counts, Look, Query, ReviewMark, ReviewState, ScanStatus, SmartCounts, Source, Tag } from "./types";

export type Route =
  | { name: "dashboard" }
  | { name: "pictures" }
  | { name: "cleanup"; trip?: string }
  | { name: "detail"; id: string; query: Query; index: number }
  | { name: "edit"; ids: string[]; index: number }
  | { name: "albums" }
  | { name: "portfolio"; slug?: string }
  | { name: "posts" }
  | { name: "post"; id: string }
  | { name: "accounts" }
  | { name: "account"; id: string }
  | { name: "settings" }
  | { name: "today" }
  | { name: "inspire" }
  | { name: "ideas" }
  | { name: "write"; id?: string }
  | { name: "pillars" }
  | { name: "roadmap" };

/** Route names that no longer exist, and where they lead now. */
export type LegacyRoute = { name: "archive"; slug?: string };
export function fromLegacy(r: Route | LegacyRoute): Route {
  if (r.name !== "archive") return r;
  return r.slug ? { name: "portfolio", slug: r.slug } : { name: "pictures" };
}

/** Which mode a screen belongs to; Settings belongs to both. */
export function modeOf(r: Route): Mode | null {
  switch (r.name) {
    case "settings":
      return null;
    case "today":
    case "inspire":
    case "ideas":
    case "write":
    case "pillars":
    case "roadmap":
    case "posts":
    case "post":
    case "accounts":
    case "account":
      return "studio";
    default:
      return "photo";
  }
}

const HOME: Record<Mode, Route> = { photo: { name: "dashboard" }, studio: { name: "today" } };

/** A cull of just what the last scan brought in, in shooting order. */
export const LAST_IMPORT_CULL: Query = { smart: "last_import", review: "unreviewed", order: "oldest" };

/** Same screen for the same thing: a photo, a post, a set of photos. */
function routeKey(r: Route): string {
  return `${r.name}:${"id" in r ? r.id : ""}:${"ids" in r ? r.ids.join(",") : ""}:${"slug" in r ? r.slug ?? "" : ""}`;
}

export interface CullSession {
  query: Query;
  start: number;
  total: number;
  /** The photos as they were when the session started: marking never reshuffles them. */
  ids: string[];
  key: number;
}

/** Quick add: going through `ids` one by one, Y puts a photo in `album`. */
export interface QuickAddSession {
  album: Album;
  ids: string[];
  key: number;
}

interface Store {
  route: Route;
  go: (r: Route | LegacyRoute) => void;
  /** Change screen without adding a Back step (moving between photos). */
  replace: (r: Route) => void;
  back: () => void;
  /** Drops every Back step to this post or account (after deleting it). */
  forgetRoute: (id: string) => void;
  /** Pictures from the editor opens the photo you were editing. */
  openPictures: () => void;
  /** The photo last open on the photo page: the grid comes back to it. */
  lastViewed: { current: string | null };
  version: number;
  bump: () => void;
  counts: Counts | null;
  smart: SmartCounts | null;
  sources: Source[];
  scan: ScanStatus | null;
  keymap: Keymap;
  setKeymap: (k: Keymap) => void;
  looks: Look[];
  reloadLooks: () => void;
  albums: Album[];
  tags: Tag[];
  accounts: Account[];
  reloadMeta: () => void;
  query: Query;
  setQuery: (q: Query) => void;
  selection: Set<string>;
  setSelection: (s: Set<string>) => void;
  cull: CullSession | null;
  /** `ids`: cull exactly these (e.g. this session's maybes) instead of the whole query. */
  startCull: (query: Query, start?: number, ids?: string[]) => Promise<void>;
  endCull: () => void;
  quickAdd: QuickAddSession | null;
  startQuickAdd: (album: Album, ids: string[]) => void;
  endQuickAdd: () => void;
  mark: (ids: string[], state: ReviewState) => Promise<boolean>;
  /** Puts back the last mark made with `mark`; resolves to the photo ids it restored. */
  undoMark: () => Promise<string[]>;
  addFolder: () => Promise<void>;
  editIds: (ids: string[], index?: number) => void;
  /** Photo or Studio: follows the screen, and the switch moves between them. */
  mode: Mode;
  switchMode: (m: Mode) => void;
  /** Goes up whenever Studio's data changes, so its screens read again. */
  studioVersion: number;
  /** ⌘N anywhere: a new idea, optionally linked to a save. */
  quickIdea: { open: boolean; saveId?: string; title?: string };
  openQuickIdea: (opts?: { saveId?: string; title?: string }) => void;
  closeQuickIdea: () => void;
}

const Ctx = createContext<Store | null>(null);
export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("store missing");
  return s;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [route, setRouteRaw] = useState<Route>({ name: "dashboard" });
  const history = useRef<Route[]>([]);
  // Each mode remembers its last screen, so the switch brings you back to it.
  const [mode, setMode] = useState<Mode>("photo");
  const lastRoute = useRef<Record<Mode, Route>>({ ...HOME });
  const modeRef = useRef<Mode>("photo");
  const setRoute = setRouteRaw;
  useEffect(() => {
    const m = modeOf(route) ?? modeRef.current;
    lastRoute.current[m] = route;
    if (m !== modeRef.current) {
      modeRef.current = m;
      setMode(m);
    }
  }, [route]);
  useEffect(() => applyMode(mode), [mode]);
  const [studioVersion, setStudioVersion] = useState(0);
  const [quickIdea, setQuickIdea] = useState<{ open: boolean; saveId?: string; title?: string }>({ open: false });
  const openQuickIdea = useCallback((opts?: { saveId?: string; title?: string }) => setQuickIdea({ open: true, ...opts }), []);
  const closeQuickIdea = useCallback(() => setQuickIdea({ open: false }), []);
  const [version, setVersion] = useState(0);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [smart, setSmart] = useState<SmartCounts | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [keymap, setKeymap] = useState<Keymap>(DEFAULT_KEYMAP);
  const [looks, setLooks] = useState<Look[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [query, setQuery] = useState<Query>({ order: "newest" });
  const queryRef = useRef(query);
  queryRef.current = query;
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [cull, setCull] = useState<CullSession | null>(null);
  const [quickAdd, setQuickAdd] = useState<QuickAddSession | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const studioTimer = useRef<number | undefined>(undefined);
  const takeCaptures = async () => {
    const urls = await studio.pendingCaptures().catch(() => [] as string[]);
    for (const url of urls) {
      try {
        const save = await studio.addLink(url, "browser");
        toast(save.existing ? "Already in Inspire" : `Saved to Inspire${save.title ? `: ${save.title.slice(0, 60)}` : ""}`);
      } catch (e) {
        toast(errorText(e), { error: true });
      }
    }
  };
  const lastViewed = useRef<string | null>(null);

  const routeRef = useRef(route);
  routeRef.current = route;
  // Old route names still land in the right place (Amendment 3, 19 Nov):
  // « archive » used to be the website; it is now the pictures, and the
  // website is « portfolio ». A website page asked for by its old name opens
  // under Portfolio.
  const go = useCallback((to: Route | LegacyRoute) => {
    const r = fromLegacy(to);
    // Going to where you already are is not a step Back has to undo.
    if (routeKey(r) !== routeKey(routeRef.current)) {
      history.current.push(routeRef.current);
      if (history.current.length > 50) history.current.shift();
    }
    setRoute(r);
  }, []);
  const replace = useCallback((r: Route) => setRoute(r), []);
  // After deleting a post or an account, Back must never lead to it again.
  const forgetRoute = useCallback((id: string) => {
    history.current = history.current.filter((r) => !("id" in r && r.id === id));
  }, []);
  // The photo page you last had open, so leaving the editor can return to it.
  const lastDetail = useRef<Extract<Route, { name: "detail" }> | null>(null);
  useEffect(() => {
    if (route.name === "detail") lastDetail.current = route;
  }, [route]);
  const back = useCallback(() => {
    const prev = history.current.pop() ?? HOME[modeRef.current];
    // Out of the editor onto the photo page: the photo you ended on there.
    const now = lastViewed.current;
    if (routeRef.current.name === "edit" && prev.name === "detail" && now && now !== prev.id) return setRoute({ ...prev, id: now });
    setRoute(prev);
  }, [setRoute]);
  /** Pictures from the editor: the photo you were editing, open on its page
   *  (in the view you last browsed it from), not the grid. */
  const openPictures = useCallback(() => {
    const now = lastViewed.current;
    if (routeRef.current.name !== "edit" || !now) return go({ name: "pictures" });
    const from = lastDetail.current;
    go({ name: "detail", id: now, query: from?.query ?? queryRef.current, index: from?.id === now ? from.index : 0 });
  }, [go]);
  const switchMode = useCallback(
    (m: Mode) => {
      if (m === modeRef.current && modeOf(routeRef.current) === m) return go(HOME[m]);
      go(lastRoute.current[m] ?? HOME[m]);
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const refreshCounts = useCallback(() => {
    api.counts().then(setCounts).catch(() => {});
    api.smartCounts().then(setSmart).catch(() => {});
    api.listSources().then(setSources).catch(() => {});
  }, []);
  const reloadMeta = useCallback(() => {
    api.listAlbums().then(setAlbums).catch(() => {});
    api.listTags().then(setTags).catch(() => {});
    api.listAccounts().then(setAccounts).catch(() => {});
  }, []);
  const reloadLooks = useCallback(() => {
    api.listLooks().then(setLooks).catch(() => {});
  }, []);

  // Many events arrive in bursts (thumbnails, scans): refresh at most every 400 ms.
  const bump = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setVersion((v) => v + 1);
      refreshCounts();
      reloadMeta();
    }, 400);
  }, [refreshCounts, reloadMeta]);

  useEffect(() => {
    refreshCounts();
    reloadMeta();
    reloadLooks();
    api.scanStatus().then(setScan).catch(() => {});
    api.getSetting("keymap").then((k) => setKeymap(parseKeymap(k))).catch(() => {});
    let lastQueue = -1;
    const offs = [
      listen<ScanStatus>("scan-progress", (e) => {
        setScan(e.payload);
        bump();
      }),
      listen<ScanStatus>("scan-done", (e) => {
        setScan(e.payload);
        bump();
        const s = e.payload.stats;
        let text = `Scan done: ${s.added.toLocaleString()} new, ${s.moved} moved, ${s.missing} missing`;
        // Part of a folder couldn't be read (Google Drive not running, access refused):
        // those photos are left as they were, and the next scan looks again.
        if (s.held) text += ` · ${s.held.toLocaleString()} couldn't be read and were left as they were`;
        // New photos: one click culls just them, in shooting order.
        if (s.added) {
          toast(text, { action: { label: "Cull them", run: () => void startCullRef.current(LAST_IMPORT_CULL) } });
        } else if (s.moved || s.missing || s.held) {
          toast(text, { error: !!s.held && !s.moved && !s.missing });
        }
      }),
      listen<number>("thumbs-progress", (e) => {
        setScan((s) => (s ? { ...s, thumbsQueued: e.payload } : s));
        bump();
        // Queue ran dry: group bursts over the new photos.
        if (e.payload === 0 && lastQueue !== 0) api.refreshAnalysis().then(bump).catch(() => {});
        lastQueue = e.payload;
      }),
      listen("library-changed", () => bump()),
      listen("looks-changed", () => reloadLooks()),
      listen("studio-changed", () => {
        window.clearTimeout(studioTimer.current);
        studioTimer.current = window.setTimeout(() => setStudioVersion((v) => v + 1), 250);
      }),
      // "Save to Studio" from the browser (capturedbyandy://save?url=…).
      listen<string>("studio-capture", () => void takeCaptures()),
    ];
    void takeCaptures();
    return () => offs.forEach((p) => p.then((off) => off()));
  }, [refreshCounts, reloadMeta, reloadLooks, bump, toast]);

  const starting = useRef(false);
  const startCull = useCallback(async (q: Query, start = 0, only?: string[]) => {
    if (starting.current) return;
    starting.current = true;
    try {
      await begin(q, start, only);
    } finally {
      starting.current = false;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const begin = async (q: Query, start: number, only?: string[]) => {
    // Snapshot the order now: photos leave a filtered view as you mark them,
    // and paging by offset would then skip photos.
    // One read, so the list is consistent even while a scan is running.
    let ids: string[] = only ?? [];
    if (!only) {
      // A clip whose original was moved outside the app can't be shown: the
      // cull would wait on it forever ("This clip is next"). Leave it out.
      const playable = { ...q, hideMissing: true };
      const c = await api.counts(playable);
      if (q.review ? c[q.review] : c.all) ids = await api.photoIds(playable, 0, 200_000);
    }
    if (!ids.length) {
      toast("Nothing to cull here");
      return;
    }
    undoStack.current = [];
    setCull({ query: q, start: Math.min(start, ids.length - 1), total: ids.length, ids, key: Date.now() });
  };
  const endCull = useCallback(() => {
    undoStack.current = [];
    setCull(null);
    bump();
  }, [bump]);
  const startQuickAdd = useCallback((album: Album, ids: string[]) => setQuickAdd({ album, ids, key: Date.now() }), []);
  const endQuickAdd = useCallback(() => {
    setQuickAdd(null);
    bump();
  }, [bump]);
  // The scan toast is wired up before startCull exists.
  const startCullRef = useRef(startCull);
  startCullRef.current = startCull;

  // Back in the window after a while: pick up what changed in the folders
  // (a card imported in Finder, a trip copied over). Only a look at each file.
  const live = useRef({ scan, cull, quickAdd, sources });
  live.current = { scan, cull, quickAdd, sources };
  useEffect(() => {
    const onFocus = () => {
      const { scan, cull, quickAdd, sources } = live.current;
      if (scan?.running || cull || quickAdd || !sources.length) return;
      const newest = Math.max(...sources.map((s) => s.lastScanFinishedMs ?? 0));
      if (Date.now() - newest > 10 * 60_000) api.scanAll().catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Every mark remembers exactly what it replaced (state and time), so ⌘Z and
  // the toast's Undo put it back. Marks and undos run one after another; an
  // undo only restores photos still carrying the mark it undoes.
  type Entry = { before: ReviewMark[]; state: ReviewState; bulk?: boolean };
  const undoStack = useRef<Entry[]>([]);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const serial = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    const run = chain.current.then(job, job);
    chain.current = run.catch(() => {});
    return run;
  }, []);
  const restore = useCallback(async (entry: Entry): Promise<string[]> => {
    const now = await api.reviewMarks(entry.before.map((m) => m.id));
    const still = new Set(now.filter((m) => m.review === entry.state).map((m) => m.id));
    const marks = entry.before.filter((m) => still.has(m.id));
    if (marks.length) await api.restoreMarks(marks);
    bump();
    return marks.map((m) => m.id);
  }, [bump]);
  const mark = useCallback(
    (ids: string[], state: ReviewState): Promise<boolean> =>
      serial(async () => {
        try {
          const bulk = ids.length > 2000;
          const before = bulk ? [] : await api.reviewMarks(ids);
          await api.setReview(ids, state);
          const changed = before.filter((m) => m.review !== state);
          const entry: Entry | null = bulk ? { before: [], state, bulk: true } : changed.length ? { before: changed, state } : null;
          if (entry) {
            undoStack.current.push(entry);
            if (undoStack.current.length > 100) undoStack.current.shift();
          }
          bump();
          if (!entry || entry.bulk) {
            if (ids.length > 1) toast(`${ids.length.toLocaleString()} photos marked ${state}`);
          } else {
            toast(ids.length > 1 ? `${ids.length.toLocaleString()} photos marked ${state}` : `Marked ${state}`, {
              action: {
                label: "Undo",
                run: () => {
                  undoStack.current = undoStack.current.filter((e) => e !== entry);
                  void serial(() => restore(entry));
                },
              },
            });
          }
          return true;
        } catch (e) {
          toast(errorText(e), { error: true });
          return false;
        }
      }),
    [bump, toast, serial, restore],
  );
  const undoMark = useCallback(
    (): Promise<string[]> =>
      serial(async () => {
        const last = undoStack.current.pop();
        if (!last) {
          toast("Nothing to undo");
          return [];
        }
        if (last.bulk) {
          toast("That was too many photos to undo one by one: use the review filters to fix them");
          return [];
        }
        try {
          const ids = await restore(last);
          toast(ids.length ? "Mark undone" : "Already changed since, nothing undone");
          return ids;
        } catch (e) {
          undoStack.current.push(last);
          toast(errorText(e), { error: true });
          return [];
        }
      }),
    [serial, restore, toast],
  );

  const addFolder = useCallback(async () => {
    // Start next to the last folder added: trips tend to sit side by side.
    const last = sources[sources.length - 1]?.path;
    const defaultPath = last ? last.replace(/\/[^/]+\/?$/, "") || undefined : undefined;
    const path = await open({ directory: true, multiple: false, title: "Choose a photo folder to index", defaultPath });
    if (typeof path !== "string") return;
    try {
      const added = await api.addSource(path);
      refreshCounts();
      await api.scanAll();
      if (added.alreadyCovered) {
        // Already indexed as part of a bigger folder: show it instead.
        const name = path.replace(/\/+$/, "").split("/").pop() ?? path;
        setQuery({ order: "newest", search: name });
        setSelection(new Set());
        go({ name: "pictures" });
        toast(`Already part of “${added.source.label}”: rescanning and showing photos matching “${name}”`);
      } else if (added.merged.length) {
        toast(`Folder added. ${added.merged.map((m) => `“${m}”`).join(", ")} ${added.merged.length === 1 ? "is" : "are"} now part of it, with every mark, album and post kept.`);
      } else {
        toast("Folder added. Scanning… originals are only read, never changed.");
      }
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  }, [sources, refreshCounts, go, toast]);

  const editIds = useCallback((ids: string[], index = 0) => go({ name: "edit", ids, index }), [go]);

  const value = useMemo<Store>(
    () => ({
      route, go, replace, back, forgetRoute, openPictures, lastViewed, version, bump, counts, smart, sources, scan, keymap, setKeymap, looks, reloadLooks, albums, tags, accounts,
      reloadMeta, query, setQuery, selection, setSelection, cull, startCull, endCull, quickAdd, startQuickAdd, endQuickAdd, mark, undoMark, addFolder, editIds,
      mode, switchMode, studioVersion, quickIdea, openQuickIdea, closeQuickIdea,
    }),
    [route, go, replace, back, forgetRoute, openPictures, version, bump, counts, smart, sources, scan, keymap, looks, reloadLooks, albums, tags, accounts, reloadMeta, query, selection, cull, startCull, endCull, quickAdd, startQuickAdd, endQuickAdd, mark, undoMark, addFolder, editIds, mode, switchMode, studioVersion, quickIdea, openQuickIdea, closeQuickIdea],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
