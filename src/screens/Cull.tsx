import { listen } from "@tauri-apps/api/event";
import { useSwipe } from "../hooks/useSwipe";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText, imageUrl } from "../api";
import { AlbumModal } from "../components/AlbumModal";
import { VideoMoments, type MomentsHandle } from "../components/VideoMoments";
import { VideoBadge } from "../components/PhotoGrid";
import { placeholder, Thumb } from "../components/Thumb";
import { Icon, useToast } from "../components/ui";
import { actionFor, firstKeyLabel } from "../keymap";
import { bytes, formatDate, formatDay, REVIEW_LABEL, STORAGE_LABEL } from "../lib/format";
import { WEB, touch } from "../platform";
import { useStore, type CullSession } from "../store";
import type { PhotoRow, Post, ReviewState, VoiceCommand, VoiceEvent } from "../types";
import "../styles/cull-summary.css";
import { DownloadDialog, planDownload } from "../components/DownloadDialog";
import { PrepareCull } from "../components/PrepareCull";

import { saveCull, saveCullPosition } from "../lib/cullResume";
import { humanName, shortDay } from "../lib/humanName";

const PAGE = 200;
/** A carousel holds this many photos. */
const MAX_POST = 20;
/** Sessions with at least this many marks end on the summary, not straight away. */
const SUMMARY_FROM = 10;

/** Rows for a fixed list of ids, loaded 200 at a time as the cursor moves. */
export function useIdWindow(ids: string[]) {
  const rows = useRef(new Map<string, PhotoRow>());
  const loading = useRef(new Set<number>());
  const missing = useRef(new Set<string>());
  const [tick, setTick] = useState(0);
  const ensure = useCallback(
    (start: number, end: number) => {
      for (let page = Math.floor(Math.max(0, start) / PAGE); page <= Math.floor(Math.max(0, Math.min(end, ids.length - 1)) / PAGE); page++) {
        if (loading.current.has(page)) continue;
        loading.current.add(page);
        api
          .rows(ids.slice(page * PAGE, page * PAGE + PAGE))
          .then((list) => {
            list.forEach((r) => rows.current.set(r.id, r));
            // Photos gone since the session started (forgotten folder, merged pair).
            for (const id of ids.slice(page * PAGE, page * PAGE + PAGE)) if (!rows.current.has(id)) missing.current.add(id);
            setTick((t) => t + 1);
          })
          .catch(() => {
            loading.current.delete(page);
            setTimeout(() => setTick((t) => t + 1), 1000);
          });
      }
    },
    [ids],
  );
  const get = useCallback((i: number): PhotoRow | undefined => (i >= 0 && i < ids.length ? rows.current.get(ids[i]) : undefined), [ids]);
  const gone = useCallback((i: number) => i >= 0 && i < ids.length && missing.current.has(ids[i]), [ids]);
  return { get, ensure, gone, tick };
}

export function Cull({ session }: { session: CullSession }) {
  const { keymap, endCull, editIds, startCull, go, accounts, bump } = useStore();
  const toast = useToast();
  const { query, total } = session;
  // The photos as they were when the session started: marking a photo in
  // "Unreviewed" must not pull the next one out from under the cursor.
  const { get, ensure, gone, tick } = useIdWindow(session.ids);
  const lastStep = useRef<1 | -1>(1);
  // A photo that no longer exists is skipped in the direction you were going;
  // at either end, turn round to the nearest one that still exists.
  useEffect(() => {
    if (!gone(index)) return;
    const next = index + lastStep.current;
    if (next < 0 || next >= total) lastStep.current = lastStep.current === 1 ? -1 : 1;
    setIndex((i) => Math.max(0, Math.min(total - 1, i + lastStep.current)));
  });
  // Marks (and undos) reach the library one after another, in the order made.
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const write = useCallback((ids: string[], state: ReviewState, shown?: ReviewState) => {
    writes.current = writes.current
      .then(() => api.setReview(ids, state))
      .catch((e) => {
        // Not saved: take the mark off the screen again so it doesn't lie.
        setMarks((m) => {
          const copy = { ...m };
          ids.forEach((id) => (shown ? (copy[id] = shown) : delete copy[id]));
          return copy;
        });
        toast(errorText(e), { error: true });
      });
  }, [toast]);
  const [index, setIndex] = useState(session.start);
  useEffect(() => {
    if (!saveCull(session.ids, session.query, session.key)) toast("This device could not save the session for resume. Your review marks still save normally.", { error: true });
  }, [session, toast]);
  useEffect(() => { saveCullPosition(index, session.key); }, [index, session.key]);
  const [marks, setMarks] = useState<Record<string, ReviewState>>({});
  const [history, setHistory] = useState<{ id: string; was: ReviewState; index: number }[]>([]);
  const [focus, setFocus] = useState(false);
  const [loadedId, setLoadedId] = useState<string | null>(null);

  // Also re-run after a failed page load (tick), so it is retried by itself.
  useEffect(() => ensure(index - 12, index + 40), [index, ensure, tick]);
  const photo = get(index);

  // Warm the previews around the cursor (8 ahead, 2 behind) and keep them
  // decoded, so A-A-D-A at key-repeat speed shows the photo, not the blurred
  // thumbnail. Only this window: previews share the preview cache.
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
    // Oldest first: those are the farthest behind.
    const keep = new Set(want);
    for (const id of warm.current.keys()) {
      if (warm.current.size <= 16) break;
      if (!keep.has(id)) warm.current.delete(id);
    }
  }, [index, get, photo, tick]);

  // Videos play without lag: the next 15 and the previous 3 are kept on this
  // Mac while culling (nearest first), and let go when culling ends.
  useEffect(() => {
    const t = window.setTimeout(() => {
      const ahead: string[] = [];
      const behind: string[] = [];
      if (photo?.isVideo) ahead.push(photo.id);
      for (let d = 1; d <= 60 && ahead.length < 16; d++) {
        const p = get(index + d);
        if (p?.isVideo) ahead.push(p.id);
      }
      for (let d = 1; d <= 12 && behind.length < 3; d++) {
        const p = get(index - d);
        if (p?.isVideo) behind.push(p.id);
      }
      void api.keepVideosLocal([...ahead.slice(0, 2), ...behind, ...ahead.slice(2)]).catch(() => {});
    }, 400);
    return () => window.clearTimeout(t);
  }, [index, get, photo, tick]);
  useEffect(() => () => void api.keepVideosLocal([]).catch(() => {}), []);

  // Which videos around you play straight from this Mac (light green ring)
  // and which would stream from Drive (grey ring). Looked at again every few
  // seconds: review copies and downloads keep arriving.
  const [ready, setReady] = useState<Set<string>>(new Set());
  useEffect(() => {
    const look = () => {
      const near: string[] = [];
      for (let i = Math.max(0, index - 6); i <= index + 6; i++) {
        const p = get(i);
        if (p?.isVideo) near.push(p.id);
      }
      if (!near.length) return;
      api
        .videosReady(near)
        .then((ok) =>
          setReady((prev) => {
            const next = new Set(prev);
            near.forEach((id) => next.delete(id));
            ok.forEach((id) => next.add(id));
            return next;
          }),
        )
        .catch(() => {});
    };
    look();
    const t = window.setInterval(look, 3000);
    return () => window.clearInterval(t);
  }, [index, get, tick]);

  // The farthest and nearest photos reached, for "skipped" in the summary.
  const reach = useRef({ low: session.start, high: session.start });
  useEffect(() => {
    reach.current = { low: Math.min(reach.current.low, index), high: Math.max(reach.current.high, index) };
  }, [index]);
  const [summary, setSummary] = useState(false);
  const [albumFor, setAlbumFor] = useState<string[] | null>(null);
  const summaryShown = useRef(false);

  // Counted by value: an undo leaves the entry holding the old state.
  const byState = (s: ReviewState) => session.ids.filter((id) => marks[id] === s);
  const markedCount = Object.values(marks).filter((s) => s !== "unreviewed").length;

  const mark = useCallback(
    (state: ReviewState) => {
      if (!photo) return;
      const was = marks[photo.id] ?? photo.review;
      setHistory((h) => [...h.slice(-199), { id: photo.id, was, index }]);
      setMarks((m) => ({ ...m, [photo.id]: state }));
      write([photo.id], state, marks[photo.id]);
      lastStep.current = 1;
      setIndex((i) => Math.min(i + 1, total - 1));
    },
    [photo, marks, index, total, write],
  );

  // Z: the photo at 100 % to check focus. C: a scene's frames side by side.
  const [zoom, setZoom] = useState(false);
  const moments = useRef<MomentsHandle>(null);
  const [zoomReady, setZoomReady] = useState(false);
  // C: a duel over a scene's frames. The keeper so far stays on the left; each
  // challenger slides in on the right until one is left standing.
  const [compare, setCompare] = useState<{
    rows: PhotoRow[];
    champ: number;
    /** The frames still to challenge, in order. */
    queue: number[];
    /** Both frames at 100 % on the same spot (0..1 across and down). */
    zoomAt: { x: number; y: number } | null;
  } | null>(null);
  useEffect(() => {
    setZoom(false);
    setZoomReady(false);
  }, [index]);
  const openCompare = () => {
    if (!photo || photo.burst < 2) return toast("No similar shots to compare");
    api.burst(photo.id).then((rows) => {
      if (rows.length < 2) return toast("No similar shots to compare");
      // The photo you were looking at defends first; the others follow in shooting order.
      const champ = Math.max(0, rows.findIndex((r) => r.id === photo.id));
      const queue = [...rows.keys()].filter((i) => i !== champ);
      setCompare({ rows, champ, queue: [...queue.filter((i) => i > champ), ...queue.filter((i) => i < champ)], zoomAt: null });
    }).catch((e) => toast(errorText(e), { error: true }));
  };
  const markRow = (r: PhotoRow, state: ReviewState) => {
    const was = marks[r.id] ?? r.review;
    setHistory((h) => [...h.slice(-199), { id: r.id, was, index }]);
    setMarks((m) => ({ ...m, [r.id]: state }));
    write([r.id], state, marks[r.id]);
  };
  // The keeper wins: selected; whatever wasn't compared yet is rejected with
  // `rejectRest`. Then on past the scene.
  const finishDuel = (c: NonNullable<typeof compare>, rejectRest: boolean) => {
    markRow(c.rows[c.champ], "selected");
    if (rejectRest) for (const i of c.queue) markRow(c.rows[i], "rejected");
    const last = Math.max(...c.rows.map((r) => session.ids.indexOf(r.id)));
    setCompare(null);
    lastStep.current = 1;
    setIndex(Math.min(total - 1, Math.max(index, last) + 1));
  };
  // One duel: the left (keeper so far) or the right (challenger) stays; the
  // other is rejected and the next challenger slides in.
  const duel = (keepRight: boolean) => {
    if (!compare) return;
    const [challenger, ...rest] = compare.queue;
    if (challenger === undefined) return finishDuel(compare, false);
    const loser = keepRight ? compare.champ : challenger;
    markRow(compare.rows[loser], "rejected");
    const next = { ...compare, champ: keepRight ? challenger : compare.champ, queue: rest };
    if (!rest.length) return finishDuel(next, false);
    setCompare(next);
  };
  // A: keep the current keeper now and reject the rest.
  const keepPick = () => compare && finishDuel(compare, true);
  // ↓ / ↑: straight to the next or previous scene (similar shots are one scene).
  const sceneBusy = useRef(false);
  const jumpScene = async (dir: 1 | -1) => {
    if (!photo || sceneBusy.current) return;
    sceneBusy.current = true;
    try {
      const ids = session.ids;
      const members = async (id: string) => new Set((await api.burst(id)).map((r) => r.id));
      const here = await members(photo.id);
      if (dir === 1) {
        let i = index;
        while (i + 1 < total && here.has(ids[i + 1])) i++;
        lastStep.current = 1;
        setIndex(Math.min(total - 1, i + 1));
        return;
      }
      let start = index;
      while (start > 0 && here.has(ids[start - 1])) start--;
      if (start === 0) return setIndex(0);
      const before = await members(ids[start - 1]);
      let p = start - 1;
      while (p > 0 && before.has(ids[p - 1])) p--;
      lastStep.current = -1;
      setIndex(p);
    } catch (e) {
      toast(errorText(e), { error: true });
    } finally {
      sceneBusy.current = false;
    }
  };
  // P: put the photo in a carousel while culling. The first P asks which post;
  // after that every P goes to that post (P again on a photo in it takes it out).
  const [postTarget, setPostTarget] = useState<{ id: string; title: string; ids: Set<string> } | null>(null);
  const [choosingPost, setChoosingPost] = useState<Post[] | null>(null);
  const postBusy = useRef(false);
  const choosePost = () => {
    api.listPosts().then((all) => setChoosingPost(all.filter((x) => ["idea", "building", "ready", "scheduled"].includes(x.status)))).catch((e) => toast(errorText(e), { error: true }));
  };
  const target = async (postId: string | null) => {
    setChoosingPost(null);
    try {
      const detail = postId
        ? await api.getPost(postId)
        : await api.createPost({ title: photo ? formatDay(photo.capturedAt) : "New post", accountId: accounts[0]?.id });
      const t = { id: detail.id, title: detail.title, ids: new Set(detail.photos.map((x) => x.id)) };
      setPostTarget(t);
      if (photo) await toggleInPost(t);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const toggleInPost = async (t = postTarget) => {
    if (!t || !photo || postBusy.current) return;
    postBusy.current = true;
    try {
      if (t.ids.has(photo.id)) {
        await api.postRemovePhotos(t.id, [photo.id]);
        const ids = new Set(t.ids);
        ids.delete(photo.id);
        setPostTarget({ ...t, ids });
        toast(`Taken out of “${t.title}” · ${ids.size}/${MAX_POST}`);
      } else {
        if (t.ids.size >= MAX_POST) return toast(`“${t.title}” is full (${MAX_POST}): press P on the post chip to start another`, { error: true });
        await api.postAddPhotos(t.id, [photo.id]);
        const ids = new Set(t.ids).add(photo.id);
        setPostTarget({ ...t, ids });
        lastStep.current = 1;
        setIndex((i) => Math.min(i + 1, total - 1));
      }
      bump();
    } catch (e) {
      toast(errorText(e), { error: true });
    } finally {
      postBusy.current = false;
    }
  };

  // Drag to move around the zoomed photo.
  const zoomRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  const undo = useCallback(() => {
    const last = history[history.length - 1];
    if (!last) return;
    setHistory((h) => h.slice(0, -1));
    setMarks((m) => ({ ...m, [last.id]: last.was }));
    write([last.id], last.was);
    setIndex(last.index);
  }, [history, write]);

  // Leaving: a session with real work ends on the summary first; from the
  // summary, it closes.
  const finish = useCallback(() => {
    if (summary || markedCount < SUMMARY_FROM) return endCull();
    summaryShown.current = true;
    setSummary(true);
  }, [summary, markedCount, endCull]);

  // --- The summary's next steps: exactly this session's picks.
  const selectedIds = byState("selected");
  const maybeCount = byState("maybe").length;
  const rejectedCount = byState("rejected").length;
  // Up to the last photo passed: the one you stopped on, unmarked, isn't skipped.
  const { low, high } = reach.current;
  const lastPassed = marks[session.ids[high]] && marks[session.ids[high]] !== "unreviewed" ? high : high - 1;
  const seen = Math.max(0, lastPassed - low + 1);
  const skipped: number[] = [];
  for (let i = low; i <= lastPassed && i < total; i++) {
    const p = get(i);
    const s = p ? marks[p.id] : undefined;
    if (p && p.review === "unreviewed" && (s === undefined || s === "unreviewed")) skipped.push(i);
  }
  const editPicks = () => {
    if (!selectedIds.length) return;
    endCull();
    editIds(selectedIds);
  };
  const postPicks = async () => {
    if (!selectedIds.length || selectedIds.length > MAX_POST) return;
    // In shooting order, whatever order the cull ran in.
    const rows = selectedIds.map((id) => get(session.ids.indexOf(id))).filter((r): r is PhotoRow => !!r);
    const ordered = rows.length === selectedIds.length ? [...rows].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)).map((r) => r.id) : selectedIds;
    const first = rows.length ? rows.reduce((a, b) => (b.capturedAt < a.capturedAt ? b : a)) : undefined;
    try {
      const p = await api.createPost({ title: first ? formatDay(first.capturedAt) : "New post", accountId: accounts[0]?.id }, ordered);
      endCull();
      go({ name: "post", id: p.id });
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  // Exactly this session's maybes, not every maybe the filter would find.
  const cullMaybes = () => {
    const ids = byState("maybe");
    if (ids.length) void startCull({ ...query, review: "maybe" }, 0, ids);
  };
  const toSkipped = () => {
    if (!skipped.length) return;
    setSummary(false);
    lastStep.current = 1;
    setIndex(skipped[0]);
  };
  const saveAlbum = () => {
    if (selectedIds.length) setAlbumFor(selectedIds);
  };
  // Done culling: keep the selected originals on this Mac? (sized when the summary opens)
  const [keepOffline, setKeepOffline] = useState<{ count: number; bytes: number } | null>(null);
  const [keepingOffline, setKeepingOffline] = useState(false);
  const selectedKey = selectedIds.join(",");
  useEffect(() => {
    if (!summary || WEB || !selectedIds.length) return setKeepOffline(null);
    let live = true;
    planDownload(selectedIds)
      .then((p) => live && setKeepOffline(p.online ? { count: p.online, bytes: p.onlineBytes } : null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [summary, selectedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const keepSelectedOffline = () => {
    if (keepOffline) setKeepingOffline(true);
  };

  // Q: a quick first pass. The select key keeps anything promising for later
  // (as a maybe); the summary then offers narrowing those down, and a last
  // look at what was passed over or rejected.
  const [quick, setQuick] = useState(false);
  const usedQuick = useRef(false);
  const keepOrSelect = () => mark(quick ? "maybe" : "selected");
  // Phones: the card follows the finger, with the decision it is heading to.
  const [swipeDrag, setSwipeDrag] = useState<{ dx: number; dy: number } | null>(null);
  const swipe = useSwipe((dir) => {
    if (zoom || compare) return;
    if (dir === "right") keepOrSelect();
    else if (dir === "left") void mark("rejected");
    else if (dir === "up") void mark("maybe");
    else undo();
  }, 60, (d) => setSwipeDrag(d && !zoom && !compare && touch() ? d : null));
  const lookAtRejects = () => {
    const ids = byState("rejected");
    if (ids.length) void startCull({ ...query, review: "rejected" }, 0, ids);
  };

  // Voice (V): "yes", "no", "maybe", "back", "skip" and "zoom" work like the
  // keys. Heard on this Mac only; a word only counts when said on its own.
  const [voice, setVoice] = useState<"off" | "starting" | "listening" | "paused">("off");
  // Why voice can't run right now, shown in the pill until fixed.
  const [voiceBlocked, setVoiceBlocked] = useState<null | "mic" | "speech" | "unavailable" | "nomic">(null);
  const [heard, setHeard] = useState<{ word: string; label: string; n: number } | null>(null);
  const voiceOn = voice !== "off";
  const voiceAct = useRef<(command: VoiceCommand, word: string) => void>(() => {});
  voiceAct.current = (command, word) => {
    if (choosingPost || compare || document.querySelector(".scrim")) return;
    if (summary) {
      // From the summary only "back" works, like ⌘Z.
      if (command !== "undo") return;
      setSummary(false);
    } else if (!photo) {
      return;
    }
    const label = { select: quick ? "Kept for later" : "Selected", reject: "Rejected", maybe: "Maybe", undo: "Undone", skip: "Skipped", zoom: zoom ? "Back" : photo?.isVideo ? "Playing" : "100 %" }[command];
    setHeard({ word, label, n: Date.now() });
    switch (command) {
      case "select":
        return keepOrSelect();
      case "reject":
        return mark("rejected");
      case "maybe":
        return mark("maybe");
      case "undo":
        return undo();
      case "skip":
        lastStep.current = 1;
        return setIndex((i) => Math.min(total - 1, i + 1));
      case "zoom":
        return setZoom((z) => !z);
    }
  };
  useEffect(() => {
    if (!heard) return;
    const t = window.setTimeout(() => setHeard(null), 1100);
    return () => window.clearTimeout(t);
  }, [heard]);
  useEffect(() => {
    let live = true;
    let off: (() => void) | undefined;
    listen<VoiceEvent>("voice", ({ payload: v }) => {
      if (v.kind === "listening") setVoice((s) => (s === "off" ? s : "listening"));
      else if (v.kind === "paused") setVoice((s) => (s === "off" ? s : "paused"));
      else if (v.kind === "stopped") setVoice("off");
      else if (v.kind === "command") voiceAct.current(v.command, v.word);
      else if (v.kind === "denied") {
        setVoice("off");
        setVoiceBlocked(v.what === "mic" ? "mic" : "speech");
        toast(`Voice needs ${v.what === "mic" ? "the microphone" : "speech recognition"}: click the Voice button to open the setting`, { error: true });
      } else if (v.kind === "error") toast(`Voice: ${v.message}`, { error: true });
    })
      .then((u) => (live ? (off = u) : u()))
      .catch(() => {});
    return () => {
      live = false;
      off?.();
    };
  }, [toast]);
  const toggleVoice = useCallback(async () => {
    void api.voiceTrace(voiceOn ? "voice off" : "voice on").catch(() => {});
    if (voiceOn) {
      setVoice("off");
      void api.voiceStop().catch(() => {});
      return;
    }
    // Blocked earlier: the button opens the setting to fix it.
    if (voiceBlocked === "mic" || voiceBlocked === "speech") void api.voiceOpenSettings(voiceBlocked).catch(() => {});
    setVoice("starting");
    try {
      const st = await api.voiceStatus();
      const refused = (x: string) => x === "denied" || x === "restricted";
      const blocked = refused(st.mic) ? "mic" : refused(st.speech) ? "speech" : st.microphones === 0 ? "nomic" : !st.ondevice || !st.available ? "unavailable" : null;
      setVoiceBlocked(blocked);
      if (blocked) {
        setVoice("off");
        toast(
          blocked === "mic"
            ? "The microphone is off for Captured by Andy: allow it in System Settings › Privacy & Security › Microphone"
            : blocked === "speech"
              ? "Speech recognition is off for Captured by Andy: allow it in System Settings › Privacy & Security › Speech Recognition"
              : blocked === "nomic"
                ? "No microphone found"
                : "English speech recognition isn't installed: turn on Dictation once in System Settings › Keyboard",
          { error: true },
        );
        return;
      }
      await api.voiceStart();
    } catch (e) {
      setVoice("off");
      toast(errorText(e), { error: true });
    }
  }, [voiceOn, voiceBlocked, toast]);
  // The microphone is let go when culling ends.
  useEffect(() => () => void api.voiceStop().catch(() => {}), []);
  // A playing video would talk over you: listening pauses meanwhile.
  const playing = zoom && !!photo?.isVideo;
  const listening = voice === "listening" || voice === "paused";
  useEffect(() => {
    if (listening) void api.voicePause(playing).catch(() => {});
  }, [playing, listening]);

  useEffect(() => {
    // Capture phase + stopImmediatePropagation: while culling, no screen
    // underneath (the Pictures grid, a photo page) ever sees these keys.
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector(".scrim")) return;
      if (event.key !== "?") event.stopImmediatePropagation();
      if (summary) {
        // ⌘Z and ← / → close the summary and work as always, so a wrong last
        // mark can still be fixed from the keyboard.
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
          event.preventDefault();
          setSummary(false);
          return undo();
        }
        const nav = actionFor(event, keymap);
        if (nav === "previous" || nav === "next") {
          event.preventDefault();
          setSummary(false);
          lastStep.current = nav === "next" ? 1 : -1;
          return setIndex((i) => Math.max(0, Math.min(total - 1, i + lastStep.current)));
        }
        // The summary's own keys; marking keys do nothing here.
        if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
        const k = event.key.toLowerCase();
        const run = k === "e" ? editPicks : k === "n" ? postPicks : k === "m" ? cullMaybes : k === "k" ? toSkipped : k === "r" ? lookAtRejects : k === "l" ? saveAlbum : k === "d" && keepOffline ? keepSelectedOffline : k === "escape" ? endCull : null;
        if (run) {
          event.preventDefault();
          void run();
        }
        return;
      }
      if (choosingPost) {
        if (event.key === "Escape") {
          event.preventDefault();
          setChoosingPost(null);
        }
        return;
      }
      if (!summary && !event.metaKey && !event.ctrlKey && !event.altKey && !event.repeat && event.key.toLowerCase() === "p" && photo) {
        event.preventDefault();
        return postTarget ? void toggleInPost() : choosePost();
      }
      if (compare) {
        // A duel: ← keeps the left, → the right, Z zooms both, A finishes, Esc or C goes back.
        event.preventDefault();
        if (event.repeat) return;
        if (event.key === "ArrowLeft" || event.key === "1") return duel(false);
        if (event.key === "ArrowRight" || event.key === "2") return duel(true);
        if (event.key.toLowerCase() === "z") return setCompare((c) => c && { ...c, zoomAt: c.zoomAt ? null : { x: 0.5, y: 0.5 } });
        if (event.key === "Escape" || event.key.toLowerCase() === "c") return setCompare(null);
        if (actionFor(event, keymap) === "select") return keepPick();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        return undo();
      }
      // Space on a video starts it; while it's open, Space plays and pauses
      // (on a photo Space stays Focus view).
      if (photo?.isVideo && !zoom && event.key === " " && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        if (!event.repeat) setZoom(true);
        return;
      }
      // A video playing: Space J K L move through it, I and O mark a good moment.
      if (zoom && photo?.isVideo && moments.current?.handleKey(event)) {
        event.preventDefault();
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.repeat) {
        const k = event.key.toLowerCase();
        if (k === "z" && photo) {
          event.preventDefault();
          return setZoom((z) => !z);
        }
        if (k === "c") {
          event.preventDefault();
          return openCompare();
        }
        if (k === "q") {
          event.preventDefault();
          usedQuick.current = true;
          setQuick((v) => !v);
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          return void jumpScene(event.key === "ArrowDown" ? 1 : -1);
        }
        if (k === "v" || event.code === "KeyV") {
          event.preventDefault();
          return void toggleVoice();
        }
        if (event.key === "Escape" && zoom) {
          event.preventDefault();
          return setZoom(false);
        }
      }
      if (event.key.toLowerCase() === "e" && photo && !event.metaKey) {
        endCull();
        return editIds([photo.id]);
      }
      const action = actionFor(event, keymap);
      if (!action) return;
      event.preventDefault();
      switch (action) {
        case "select":
          return keepOrSelect();
        case "reject":
          return mark("rejected");
        case "maybe":
          return mark("maybe");
        case "unmark":
          return mark("unreviewed");
        case "previous":
          lastStep.current = -1;
          return setIndex((i) => Math.max(0, i - 1));
        case "next":
          lastStep.current = 1;
          return setIndex((i) => Math.min(total - 1, i + 1));
        case "focus":
          return setFocus((f) => !f);
        case "exit":
          return focus ? setFocus(false) : finish();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const state = photo ? (marks[photo.id] ?? photo.review) : "unreviewed";
  const atEnd = index === total - 1 && photo !== undefined && marks[photo.id] !== undefined;
  // The last photo marked: show what's next, once.
  useEffect(() => {
    if (atEnd && !summaryShown.current) {
      summaryShown.current = true;
      setSummary(true);
    }
  }, [atEnd]);
  const label = query.review ? REVIEW_LABEL[query.review] : "All photos";
  // By touch: right keeps, left rejects, up is Maybe, down undoes.
  const stripStart = Math.max(0, index - 5);

  return (
    <div className={focus ? "cull night focus" : "cull night"}>
      <header className="cull-top focus-hide">
        <button type="button" className="btn quiet" style={{ color: "var(--ink)" }} onClick={finish}>
          {Icon.back()} Done <kbd>{firstKeyLabel(keymap.exit)}</kbd>
        </button>
        <span className="meta not-phone" style={{ letterSpacing: "0.1em", textTransform: "uppercase" }}>
          {label} · {(index + 1).toLocaleString()} of {total.toLocaleString()}
        </span>
        <span className="cull-count phone-only">{(index + 1).toLocaleString()} of {total.toLocaleString()}</span>
        <button type="button" className="btn quiet phone-only" style={{ color: "var(--ink)" }} onClick={undo}>Undo</button>
        <span className="spacer" />
        <div className="bar" style={{ width: 220, background: "var(--line)" }}>
          <i style={{ width: `${((index + 1) / total) * 100}%`, background: "var(--green)" }} />
        </div>
        {postTarget && (
          <button type="button" className="chip" title="Put photos in another post" onClick={choosePost}>
            Post: {postTarget.title} · {postTarget.ids.size}/{MAX_POST}
            {photo && postTarget.ids.has(photo.id) ? " · this one is in" : ""} <kbd>P</kbd>
          </button>
        )}
        <button
          type="button"
          className={`chip voice-pill ${voice}${voice === "off" && voiceBlocked ? " blocked" : ""}`}
          aria-pressed={voiceOn}
          onClick={() => void toggleVoice()}
          title="Say yes, no, maybe, back, skip or zoom. Heard on this Mac only, never recorded."
        >
          <i className="mic-dot" aria-hidden="true" />
          {voice === "off"
            ? voiceBlocked === "mic"
              ? "Voice: allow microphone"
              : voiceBlocked === "speech"
                ? "Voice: allow speech recognition"
                : voiceBlocked === "unavailable"
                  ? "Voice: turn on Dictation once"
                  : voiceBlocked === "nomic"
                    ? "Voice: no microphone"
                    : "Voice"
            : voice === "starting"
              ? "Starting voice…"
              : voice === "paused"
                ? "Voice paused while playing"
                : "Listening · yes / no / maybe"}{" "}
          <kbd>V</kbd>
        </button>
        <div className="seg" role="group" aria-label="Photos or videos" style={{ width: 210 }}>
          {([["All", null], ["Photos", false], ["Videos", true]] as const).map(([label, v]) => (
            <button
              key={label}
              type="button"
              aria-pressed={(query.video ?? null) === v}
              onClick={() => {
                if ((query.video ?? null) === v) return;
                // Same cull, only photos or only videos (marks so far are kept).
                void startCull({ ...query, video: v }, 0);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="meta">{markedCount.toLocaleString()} marked this session</span>
      </header>
      {heard && (
        <div key={heard.n} className="voice-heard" role="status">
          “{heard.word}” <span aria-hidden="true">→</span> {heard.label}
        </div>
      )}
      {choosingPost && (
        <div className="cull-sum" onClick={() => setChoosingPost(null)}>
          <section className="card" role="dialog" aria-label="Put photos in which post" onClick={(e) => e.stopPropagation()}>
            <h2>Put photos in which post?</h2>
            <div className="rows">
              <button type="button" className="row" onClick={() => void target(null)}>
                <kbd>+</kbd>
                <span className="who">New post<small>Named after this photo's day</small></span>
              </button>
              {choosingPost.map((x) => (
                <button key={x.id} type="button" className="row" onClick={() => void target(x.id)}>
                  <kbd>{x.photoCount}</kbd>
                  <span className="who">{x.title}<small>{x.status}{x.accountUsername ? ` · @${x.accountUsername}` : ""} · {x.photoCount}/{MAX_POST}</small></span>
                </button>
              ))}
            </div>
            <p className="meta foot"><kbd>Esc</kbd> cancel · then P puts each photo in that post</p>
          </section>
        </div>
      )}

      {/* A click on a video plays it (in the player, a click is play / pause).
          The thumbnails and bars only hide through this button, never by a
          click on the picture (Andy, 16 Nov). */}
      <div
        className={swipeDrag ? "stage dragging" : "stage"}
        onClick={() => photo?.isVideo && !zoom && setZoom(true)}
        {...swipe}
        style={swipeDrag ? ({ "--dx": `${swipeDrag.dx}px`, "--dy": `${Math.min(0, swipeDrag.dy)}px`, "--rot": `${swipeDrag.dx / 24}deg` } as React.CSSProperties) : undefined}
      >
        {swipeDrag && (() => {
          const drag = swipeDrag;
          const up = -drag.dy > Math.abs(drag.dx);
          const say = up ? "Maybe" : drag.dx > 0 ? "Keep" : "Reject";
          const strength = Math.min(1, Math.max(Math.abs(drag.dx), up ? -drag.dy : 0) / 110);
          return <span className={`swipe-say ${say.toLowerCase()}`} style={{ opacity: strength }}>{say}</span>;
        })()}
        <button
          type="button"
          className="btn quiet small cull-focus-btn"
          aria-pressed={focus}
          onClick={(e) => {
            e.stopPropagation();
            setFocus((f) => !f);
          }}
        >
          {focus ? "Show thumbnails" : photo?.isVideo ? "Only the video" : "Only the photo"}
        </button>
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
            {photo.isVideo && !zoom && (
              <span className={`lbl cull-video-note ${ready.has(photo.id) ? "is-ready" : "is-wait"}`}>
                <i className="avail" />
                <VideoBadge seconds={photo.duration} /> {ready.has(photo.id) ? "On this Mac · Space to play" : "Streams from Drive · Space to play"}
              </span>
            )}
            {photo.isVideo && !zoom && (
              <button type="button" className="btn light cull-play-btn phone-only" onClick={(e) => { e.stopPropagation(); setZoom(true); }}>
                ▶ Play
              </button>
            )}
          </>
        )}
        {zoom && photo?.isVideo && (
          // Z on a video plays it (streamed, nothing downloaded first).
          <div className="cull-zoom cull-play" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="btn quiet cull-close phone-only" onClick={() => setZoom(false)}>Close</button>
            <VideoMoments key={`play-${photo.id}`} ref={moments} photoId={photo.id} autoPlay extraHint="Z or Esc to stop" />
          </div>
        )}
        {zoom && photo && !photo.isVideo && (
          <div
            ref={zoomRef}
            className="cull-zoom"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => {
              const el = zoomRef.current;
              if (!el) return;
              drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
              el.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const el = zoomRef.current;
              const d = drag.current;
              if (!el || !d) return;
              el.scrollLeft = d.left - (e.clientX - d.x);
              el.scrollTop = d.top - (e.clientY - d.y);
            }}
            onPointerUp={() => (drag.current = null)}
          >
            <img
              key={`zoom-${photo.id}`}
              src={imageUrl("original", photo.id)}
              alt={photo.filename}
              draggable={false}
              onLoad={(e) => {
                setZoomReady(true);
                // Start in the middle of the photo.
                const el = zoomRef.current;
                const img = e.currentTarget;
                if (el) {
                  el.scrollLeft = (img.naturalWidth - el.clientWidth) / 2;
                  el.scrollTop = (img.naturalHeight - el.clientHeight) / 2;
                }
              }}
            />
            <span className="lbl zoom-note">{zoomReady ? (touch() ? "100 % · drag to move" : "100 % · drag to move · Z or Esc to go back") : "Loading full size…"}</span>
          </div>
        )}
        {compare && (() => {
          const champ = compare.rows[compare.champ];
          const challenger = compare.queue.length ? compare.rows[compare.queue[0]] : null;
          const done = compare.rows.length - compare.queue.length;
          const frame = (r: PhotoRow, side: "left" | "right") => (
            <button
              key={r.id}
              type="button"
              className={`frame${compare.zoomAt ? " zoomed" : ""}`}
              onClick={(e) => {
                // Click: both photos at 100 % on this spot; click again to fit.
                const box = e.currentTarget.getBoundingClientRect();
                const at = { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height };
                setCompare((c) => c && { ...c, zoomAt: c.zoomAt ? null : at });
              }}
            >
              <img
                src={imageUrl("preview", r.id)}
                alt={r.filename}
                style={compare.zoomAt ? { objectFit: "none", objectPosition: `${compare.zoomAt.x * 100}% ${compare.zoomAt.y * 100}%` } : undefined}
              />
              <span className="lbl">
                {side === "left" ? "Keeper so far" : `Challenger ${done}/${compare.rows.length - 1}`}
              </span>
              <span className="duel-key"><kbd>{side === "left" ? "←" : "→"}</kbd> keep this one</span>
            </button>
          );
          return (
            <div className="cull-compare duel" onClick={(e) => e.stopPropagation()}>
              <div className="frames" style={{ gridTemplateColumns: challenger ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)" }}>
                {frame(champ, "left")}
                {challenger && frame(challenger, "right")}
              </div>
              <p className="meta keys-only">← keep left · → keep right · the other is rejected · click or Z: both at 100 % · A keep the left and reject the rest · Esc back</p>
            </div>
          );
        })()}
        {atEnd && !summary && <div className="end-note">End of this set · Esc to finish</div>}
        {summary && (
          <div className="cull-sum" onClick={(e) => e.stopPropagation()}>
            <section className="card" role="dialog" aria-label="What next">
              <h2>
                {seen.toLocaleString()} frames · {selectedIds.length.toLocaleString()} selected{" "}
                <span>
                  · {maybeCount.toLocaleString()} maybe · {rejectedCount.toLocaleString()} rejected · {skipped.length.toLocaleString()} skipped
                </span>
              </h2>
              <div className="rows">
                {(
                  [
                    ...(keepOffline
                      ? [["D", `Download the ${keepOffline.count.toLocaleString()} selected`, `Download their originals from Google Drive · ${bytes(keepOffline.bytes)} (the size and free space show first)`, false, keepSelectedOffline]]
                      : []),
                    ["E", `Edit the ${selectedIds.length.toLocaleString()} selected`, "One look for all, or one by one", !selectedIds.length, editPicks],
                    [
                      "N",
                      selectedIds.length > MAX_POST ? "One carousel post" : `One carousel post with these ${selectedIds.length.toLocaleString()}`,
                      selectedIds.length > MAX_POST ? `A carousel holds ${MAX_POST}: pick them in Pictures` : "One post you swipe through, in shooting order (for separate posts: Post in Pictures)",
                      !selectedIds.length || selectedIds.length > MAX_POST,
                      postPicks,
                    ],
                    usedQuick.current
                      ? ["M", `Narrow down the ${maybeCount.toLocaleString()} you kept`, "Second pass: select or reject each", !maybeCount, cullMaybes]
                      : ["M", "Go through the maybes", `${maybeCount.toLocaleString()} to decide on`, !maybeCount, cullMaybes],
                    usedQuick.current
                      ? ["K", `Last look at the ${skipped.length.toLocaleString()} you passed over`, "Before you move on", !skipped.length, toSkipped]
                      : ["K", "Back to the first skipped", `${skipped.length.toLocaleString()} left unmarked`, !skipped.length, toSkipped],
                    ["R", `Last look at the ${rejectedCount.toLocaleString()} rejected`, "Rescue any you like after all", !rejectedCount, lookAtRejects],
                    ["L", "Save as album…", "The selected ones, as a new album", !selectedIds.length, saveAlbum],
                  ] as [string, string, string, boolean, () => unknown][]
                ).map(([key, title, sub, off, run]) => (
                  <button key={key} type="button" className="row" disabled={off} onClick={() => void run()}>
                    <kbd>{key}</kbd>
                    <span className="who">{title}<small>{sub}</small></span>
                  </button>
                ))}
              </div>
              <p className="meta foot">
                <kbd>Esc</kbd> close · marks are already saved
              </p>
            </section>
          </div>
        )}
      </div>
      {!WEB && <PrepareCull ids={session.ids} onLater={endCull} />}
      {keepingOffline && (
        <DownloadDialog
          photoIds={selectedIds}
          title="Keep the selected offline"
          intro="Done culling. Download the selected originals from Google Drive so they're on this Mac for editing and posting?"
          onClose={(changed) => {
            setKeepingOffline(false);
            if (changed) setKeepOffline(null);
          }}
        />
      )}
      {albumFor && (
        <AlbumModal
          album="new"
          photoIds={albumFor}
          onClose={() => setAlbumFor(null)}
          onDone={() => {
            setAlbumFor(null);
            bump();
          }}
        />
      )}

      <div className="strip focus-hide" aria-hidden="true">
        {Array.from({ length: 11 }, (_, k) => stripStart + k)
          .filter((i) => i < total)
          .map((i) => {
            const p = get(i);
            const s = p ? (marks[p.id] ?? p.review) : "unreviewed";
            return (
              <button
                key={i}
                type="button"
                tabIndex={-1}
                className={`f${i === index ? " now" : ""}${s === "rejected" ? " rej" : ""}${p?.isVideo ? (ready.has(p.id) ? " vid-ready" : " vid-wait") : ""}`}
                title={p?.isVideo ? (ready.has(p.id) ? "On this Mac: plays straight away" : "Not on this Mac yet: streams from Google Drive") : undefined}
                onClick={() => setIndex(i)}
              >
                {p && <Thumb id={p.id} hash={p.thumbhash} ready={p.thumb === "ready"} />}
                {s !== "unreviewed" && <i className={`dot ${s === "selected" ? "d-ok" : s === "maybe" ? "d-warn" : "d-bad"}`} />}
              </button>
            );
          })}
      </div>

      <footer className="cull-bar focus-hide">
        <span className={`tag ${state === "selected" ? "t-sel" : state === "maybe" ? "t-maybe" : state === "rejected" ? "t-rej" : "t-idle"}`}>{REVIEW_LABEL[state]}</span>
        <div style={{ minWidth: 0 }}>
          <div className="name not-phone">{photo?.filename ?? "…"}</div>
          <div className="name phone-only">{photo ? [humanName(photo.filename).place, humanName(photo.filename).what].filter(Boolean).join(" · ") || shortDay(photo.capturedAt) : "…"}</div>
          <div className="meta">
            {photo ? formatDate(photo.capturedAt) : ""}
            {photo && photo.media !== "image" ? ` · ${photo.media === "raw" ? "RAW" : "RAW + JPEG"}` : ""}
            {photo && photo.storage !== "local" ? ` · ${STORAGE_LABEL[photo.storage]}` : ""}
            {photo && photo.postedCount > 0 ? ` · posted ×${photo.postedCount}` : ""}
          </div>
        </div>
        {photo && photo.burst > 1 && <span className="tag t-idle" title="Press C to compare them side by side">{photo.burst} similar shots · C compares</span>}
        {photo?.soft && <span className="tag t-maybe">Possibly soft</span>}
        <span className="spacer" />
        {(
          [
            ["selected", keymap.select, Icon.check(), quick || touch() ? "Keep" : "Select"],
            ["maybe", keymap.maybe, Icon.q(), "Maybe"],
            ["rejected", keymap.reject, Icon.x(), "Reject"],
          ] as const
        ).map(([s, key, icon, text]) => (
          <button key={s} type="button" className={`markbtn ${s}${state === s ? " on" : ""}`} onClick={() => (s === "selected" ? keepOrSelect() : mark(s))}>
            <kbd>{firstKeyLabel(key)}</kbd>
            {icon}
            {text}
          </button>
        ))}
        <button type="button" className="chip" aria-pressed={quick} onClick={() => { usedQuick.current = true; setQuick((v) => !v); }} title="A quick first pass: keep anything promising, decide later">
          {quick ? "Quick pass: keep what's promising" : "Quick pass"} <kbd>Q</kbd>
        </button>
        <span className="meta keys-only" style={{ marginLeft: 4 }}>marks jump to the next photo · ↓ ↑ next / previous scene · P add to post · Z zoom · C compare · ⌘Z undo · ? keys</span>
      </footer>
    </div>
  );
}
