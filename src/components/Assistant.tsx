// The floating assistant (NIRMATA Amendment 8b, Andy 19 Nov: « I press on it and
// I say, okay, pull me up all the pictures from Egypt that have been approved.
// Boom… I like the first three… are we gonna put it on our Instagram? »).
//
// One round button bottom right (⌘K). Claude finds and narrows; Andy's click
// makes: the four outcome buttons are the only things that write, and each has
// Undo. The tools below are read-only wrappers over commands the app already
// has; nothing in this file can delete, reject, publish, export or send.
// Mac only: the key lives on the Mac (the Rust side reads it); online the
// button is shown greyed, « On the Mac ».
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { WEB } from "../platform";
import { useStore } from "../store";
import { studio } from "../studio/api";
import type { Folder, PhotoRow, Query } from "../types";
import { Thumb } from "./Thumb";
import { useToast } from "./ui";
import { SYSTEM, TOOLS } from "./assistantTools";

/** Tray size: the rest is one click away in Archive (D8: « 60 of 84 »). */
const TRAY = 60;
const MAX_TURNS = 5;

type Block = { type: string; [k: string]: unknown };
type Msg = { role: "user" | "assistant"; content: string | Block[] };
type Status = { key: boolean; model: string; today: number; cap: number; spentUsd: number; monthUsd: number; ceilingUsd: number };
type Made = { kind: "post" | "album" | "project" | "website"; id: string; title: string; undo?: () => Promise<void>; open: () => void };
type Outcome = "post" | "website" | "album" | "project";

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
const near = (want: string, names: string[]) => {
  const w = fold(want);
  const score = (n: string) => {
    const f = fold(n);
    if (f.includes(w) || w.includes(f)) return 0;
    let common = 0;
    for (const ch of new Set(w)) if (f.includes(ch)) common++;
    return 100 - common;
  };
  return [...names].sort((a, b) => score(a) - score(b)).slice(0, 3);
};

const SUGGEST: Record<string, string[]> = {
  pictures: ["The selected pictures from the last trip", "Selected and never posted", "Videos from this month"],
  edit: ["The selected ones without a look", "My edits from this week", "Edited and never posted"],
  ideas: ["Start a project from my latest selects", "Pictures for my newest idea", "Selected and never posted"],
  posts: ["Selected and never posted", "Pictures for a new post", "The selected pictures from the last trip"],
  post: ["More pictures like this trip", "Selected and never posted", "The selected pictures from the last trip"],
  dashboard: ["All the approved pictures from my last trip", "Selected and never posted", "Start a project from my latest selects"],
};

export function Assistant() {
  const s = useStore();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [tray, setTray] = useState<PhotoRow[]>([]);
  const [total, setTotal] = useState(0);
  const [trayQuery, setTrayQuery] = useState<Query | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [proposed, setProposed] = useState<{ outcome: Outcome; title?: string } | null>(null);
  const [made, setMade] = useState<Made | null>(null);
  const history = useRef<Msg[]>([]);
  const input = useRef<HTMLTextAreaElement>(null);
  const trayRef = useRef<PhotoRow[]>([]);
  trayRef.current = tray;

  const refresh = useCallback(() => {
    if (WEB) return;
    api.assistantStatus().then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(() => {
    if (open) {
      refresh();
      window.setTimeout(() => input.current?.focus(), 0);
    }
  }, [open, refresh]);

  // ⌘K opens and closes it; Esc closes.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && !e.altKey && (e.key.toLowerCase() === "k" || e.code === "KeyK")) {
        if (WEB) return;
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open && document.activeElement?.closest?.(".as-panel")) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [open]);

  // ---------------------------------------------------------------- tools (read-only)
  const run = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    switch (name) {
      case "find_pictures": {
        const query: Query = { order: "newest" };
        let where = "";
        if (input.place) {
          const want = fold(String(input.place));
          const folders: Folder[] = await api.folders().catch(() => []);
          const trip = folders.find((f) => fold(f.name) === want) ?? folders.find((f) => fold(f.name).includes(want) || fold(f.path).split("/").some((p) => p === want));
          const album = s.albums.find((a) => fold(a.name).includes(want));
          if (trip) { query.folder = trip.path; where = `trip ${trip.name}`; }
          else if (album) { query.album = album.id; where = `album ${album.name}`; }
          else { query.search = String(input.place); where = `matching « ${input.place} »`; }
        }
        if (input.album) {
          const a = s.albums.find((x) => fold(x.name).includes(fold(String(input.album))));
          if (!a) return { count: 0, note: `No album called ${input.album}`, your_albums: near(String(input.album), s.albums.map((x) => x.name)) };
          query.album = a.id;
        }
        if (input.mark) query.review = input.mark as Query["review"];
        if (input.from) query.from = String(input.from);
        if (input.to) query.to = String(input.to);
        if (input.kind) query.video = input.kind === "video";
        if (input.words) query.search = [query.search, String(input.words)].filter(Boolean).join(" ");
        if (input.edited) query.smart = "edited";
        if (input.never_posted) { query.smart = "selected_unposted"; query.review = "selected"; }
        const ids = await api.photoIds(query, 0, 20_000);
        if (!ids.length) {
          // The place exists but the other filters leave nothing: say that, not « nearest places ».
          if (query.folder || query.album) return { count: 0, searched: where, note: `${where} exists, but nothing in it matches the other filters` };
          const folders = await api.folders().catch(() => [] as Folder[]);
          return { count: 0, searched: where || "the whole library", your_trips: input.place ? near(String(input.place), folders.map((f) => f.name)) : [], your_albums: input.place ? near(String(input.place), s.albums.map((a) => a.name)) : [] };
        }
        const rows = await api.rows(ids.slice(0, TRAY));
        setTray(rows);
        setTotal(ids.length);
        setTrayQuery(query);
        setPicked(new Set());
        setProposed(null);
        return {
          count: ids.length,
          where: where || undefined,
          shown_in_tray: rows.length,
          // Text facts only: no picture leaves the Mac.
          first: rows.slice(0, 30).map((r) => ({ id: r.id, file: r.filename, date: r.capturedAt?.slice(0, 10), mark: r.review, video: r.isVideo || undefined, edited: r.edited || undefined, posted: r.postedCount || undefined })),
        };
      }
      case "select_pictures": {
        const ids = Array.isArray(input.photo_ids) ? (input.photo_ids as string[]) : trayRef.current.slice(0, Number(input.first ?? 0)).map((r) => r.id);
        const known = ids.filter((id) => trayRef.current.some((r) => r.id === id));
        setPicked(new Set(known));
        return { selected: known.length };
      }
      case "list_trips":
        return (await api.folders().catch(() => [] as Folder[])).filter((f) => f.depth === 1).map((f) => ({ trip: f.name, pictures: f.count }));
      case "list_albums":
        return s.albums.map((a) => ({ album: a.name, pictures: a.photoCount }));
      case "list_projects":
        return (await studio.list("pieces").catch(() => [])).filter((p) => p.stage !== "posted" && !p.parked).slice(0, 30).map((p) => ({ title: p.title, stage: p.stage }));
      case "propose":
        setProposed({ outcome: input.outcome as Outcome, title: input.title ? String(input.title) : undefined });
        return { shown: true };
      default:
        return { error: `unknown tool ${name}` };
    }
  };

  const ask = async (sentence: string) => {
    const said = sentence.trim();
    if (!said || busy) return;
    setBusy(true);
    setProblem(null);
    setReply(null);
    setText("");
    const screen = `Screen: ${s.route.name}. ${picked.size ? `${picked.size} pictures selected in the tray.` : trayRef.current.length ? `${trayRef.current.length} pictures in the tray, none selected.` : ""}`;
    history.current.push({ role: "user", content: [{ type: "text", text: `${screen}\n\n${said}` }] });
    let answered = false;
    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const res = (await api.assistantSend(SYSTEM, TOOLS, history.current)) as { content: Block[]; stop_reason: string };
        history.current.push({ role: "assistant", content: res.content });
        if (res.stop_reason === "refusal") { setReply("I can't help with that one."); answered = true; break; }
        const calls = res.content.filter((b) => b.type === "tool_use");
        const words = res.content.filter((b) => b.type === "text").map((b) => String(b.text)).join(" ").trim();
        if (words) { setReply(words); answered = true; }
        if (res.stop_reason !== "tool_use" || !calls.length) break;
        // All results in one user message (parallel tool use stays possible).
        const results: Block[] = [];
        for (const c of calls) {
          try {
            results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(await run(String(c.name), (c.input ?? {}) as Record<string, unknown>)) });
          } catch (e) {
            results.push({ type: "tool_result", tool_use_id: c.id, content: errorText(e), is_error: true });
          }
        }
        history.current.push({ role: "user", content: results });
      }
      // Never a blank panel: Claude can end a turn (or run out of turns) without a word.
      if (!answered) {
        const n = trayRef.current.length;
        setReply(n ? `${n} ${n === 1 ? "picture" : "pictures"} in the tray.` : "No answer this time. Try saying it another way.");
      }
    } catch (e) {
      const m = errorText(e);
      setProblem(
        m.startsWith("key") ? "The assistant's key is missing or refused. Everything else works as before."
          : m.startsWith("cap") ? `Today's limit of ${status?.cap ?? 150} requests is reached. It resets tomorrow.`
          : m.startsWith("offline") ? "No connection to Claude. Everything else works offline."
          : m.startsWith("busy") ? "Claude is busy. Try again in a minute."
          : m.startsWith("image") ? "Pictures never leave the Mac; the request was stopped."
          // The month's ceiling, the Anthropic account's limit, an oversized conversation: the Rust side wrote the sentence.
          : ["ceiling: ", "limit: ", "long: ", "counter: "].some((p) => m.startsWith(p)) ? m.slice(m.indexOf(": ") + 2)
          : m,
      );
      // Keep the conversation valid: drop the unanswered turn.
      while (history.current.length && history.current[history.current.length - 1].role === "user") history.current.pop();
    } finally {
      setBusy(false);
      refresh();
    }
  };

  // ---------------------------------------------------------------- the four outcomes (Andy's click)
  const chosen = () => (picked.size ? tray.filter((r) => picked.has(r.id)).map((r) => r.id) : tray.map((r) => r.id));
  const make = async (kind: Outcome) => {
    const ids = chosen();
    if (!ids.length) return toast("Find some pictures first", { error: true });
    const title = proposed?.outcome === kind && proposed.title ? proposed.title : `New ${kind === "post" ? "post" : kind === "album" ? "album" : kind === "project" ? "project" : "page"}`;
    try {
      if (kind === "post") {
        const p = await api.createPost({ title, status: "idea" }, ids.slice(0, 20));
        s.bump();
        const m: Made = { kind, id: p.id, title, undo: async () => { await api.deletePost(p.id, "assistant undo"); s.forgetRoute(p.id); s.bump(); }, open: () => s.go({ name: "post", id: p.id }) };
        setMade(m);
        m.open();
      } else if (kind === "album") {
        const a = await api.createAlbum(title, ids);
        s.reloadMeta();
        const m: Made = { kind, id: a.id, title, undo: async () => { await api.deleteAlbum(a.id, "assistant undo"); s.reloadMeta(); s.bump(); }, open: () => { s.setQuery({ album: a.id, order: "newest" }); s.setSelection(new Set()); s.go({ name: "pictures" }); } };
        setMade(m);
        m.open();
      } else if (kind === "project") {
        const p = await studio.save("pieces", null, { title, stage: "planned" });
        for (const id of ids) await studio.link("pieceMedia", p.id, id, true);
        s.bump();
        const m: Made = { kind, id: p.id, title, undo: async () => { await studio.remove("pieces", p.id, "assistant undo"); s.bump(); }, open: () => s.go({ name: "write", id: p.id }) };
        setMade(m);
        m.open();
      } else {
        // A website page is a draft opened in Portfolio with the pictures picked; nothing is written to the site.
        s.setSelection(new Set(ids));
        const m: Made = { kind, id: "", title, open: () => s.go({ name: "portfolio" }) };
        setMade(m);
        m.open();
        toast(`${ids.length} pictures picked · make the page in Portfolio and save it there`);
      }
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };

  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const reset = () => { history.current = []; setTray([]); setTotal(0); setPicked(new Set()); setProposed(null); setReply(null); setProblem(null); setMade(null); };
  const chips = SUGGEST[s.route.name] ?? SUGGEST.dashboard;

  if (s.cull || s.quickAdd) return null;
  if (WEB) {
    return (
      <button type="button" className="as-fab" disabled aria-label="Assistant, on the Mac" title="The assistant is in the Mac app">
        <span aria-hidden="true">✦</span>
        <small>On the Mac</small>
      </button>
    );
  }
  return (
    <>
      {!open && (
        <button type="button" className="as-fab" aria-label="Assistant (⌘K)" title="Assistant · ⌘K" onClick={() => setOpen(true)}>
          <span aria-hidden="true">✦</span>
        </button>
      )}
      {open && (
        <section className="as-panel" role="dialog" aria-label="Assistant">
          <header className="as-head">
            <b>Assistant</b>
            <span className="meta">{status ? `${status.today}/${status.cap} today · $${(status.monthUsd ?? 0).toFixed(2)} of $${status.ceilingUsd ?? 20}/month` : ""}</span>
            <button type="button" className="as-x" aria-label="New search" title="Start over" onClick={reset}>↺</button>
            <button type="button" className="as-x" aria-label="Close (Esc)" onClick={() => setOpen(false)}>×</button>
          </header>
          {status && !status.key && <p className="as-state">No key yet: the assistant needs its key file on this Mac. Everything else works as before.</p>}
          <form className="as-ask" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
            <textarea
              ref={input}
              rows={2}
              value={text}
              placeholder="e.g. all the approved pictures from Egypt"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(text); } }}
              aria-label="Ask the assistant"
            />
            <button type="submit" className="btn primary small" disabled={busy || !text.trim()}>{busy ? "…" : "Go"}</button>
          </form>
          {!tray.length && !reply && !problem && (
            <div className="as-chips">{chips.map((c) => <button key={c} type="button" className="chip" onClick={() => void ask(c)}>{c}</button>)}</div>
          )}
          {problem && <p className="as-state warn" role="status">{problem}</p>}
          {reply && <p className="as-reply" role="status">{reply}</p>}
          {tray.length > 0 && (
            <>
              <div className="as-count">
                <span>{picked.size ? `${picked.size} of ${tray.length} picked` : total > tray.length ? `${tray.length} of ${total.toLocaleString()}` : `${tray.length} pictures`}</span>
                {total > tray.length && trayQuery && (
                  <button type="button" className="link" onClick={() => { s.setQuery(trayQuery); s.setSelection(new Set()); s.go({ name: "pictures" }); }}>Show all in Archive</button>
                )}
              </div>
              <div className="as-tray">
                {tray.map((r) => (
                  <button key={r.id} type="button" className={`as-pic${picked.has(r.id) ? " on" : ""}`} aria-pressed={picked.has(r.id)} title={r.filename} onClick={() => toggle(r.id)}>
                    <Thumb id={r.id} hash={r.thumbhash} />
                  </button>
                ))}
              </div>
              <div className="as-outcomes" role="group" aria-label="Make">
                {([["post", "Instagram post"], ["website", "Website project"], ["album", "Album"], ["project", "Project"]] as [Outcome, string][]).map(([k, label]) => (
                  <button key={k} type="button" className={`btn small${proposed?.outcome === k ? " primary" : " quiet"}`} onClick={() => void make(k)}>{label}</button>
                ))}
              </div>
            </>
          )}
          {made && (
            <p className="as-made">
              {made.kind === "website" ? "Pictures picked for a new page in Portfolio" : `« ${made.title} » created`}
              <button type="button" className="link" onClick={made.open}>Open</button>
              {made.undo && <button type="button" className="link" onClick={() => void made.undo!().then(() => { setMade(null); toast("Undone: removed what the assistant made"); })}>Undo</button>}
            </p>
          )}
        </section>
      )}
    </>
  );
}
