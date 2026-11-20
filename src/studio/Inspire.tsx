import { Transcript } from "./Transcript";
// The scratchboard. Saves come in by pasting a link (⌘V anywhere here),
// dropping screenshots or recordings, the drop folder, the browser button, or
// importing Instagram/TikTok data downloads. Each save gets a "why it works"
// note, chips and a pillar, and can become an idea.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, imageUrl } from "../api";
import { Hero, Icon, Modal, Popover, Select, useToast } from "../components/ui";
import { useStore } from "../store";
import { saveThumb, studio } from "./api";
import { IdeasPanel } from "./Ideas";
import { TOPICS, topicOf } from "./library";
import { platformName, SAVE_DRAG, SaveTile, useDebounced, useList } from "./shared";
import type { Board, Family, Found, Pillar, Save, Trend, Watch } from "./types";

type Tab = "inbox" | "library" | "trends" | "watch" | "archived";

/** Inspiration: new saves; the Library (kept saves, and your ideas); Trends;
 *  the Watchlist. "+" adds a link or files; files can also be dropped anywhere. */
export function Inspire({ start }: { start?: "ideas" }) {
  const toast = useToast();
  const { openQuickIdea } = useStore();
  const [saves] = useList("saves");
  // Websites saved before pages were photographed get their picture once, in the background.
  const shooting = useRef(false);
  useEffect(() => {
    if (!saves || shooting.current) return;
    const todo = saves.filter((s) => s.kind === "link" && s.platform === "web" && !localStorage.getItem(`inspire.shot.${s.id}`));
    if (!todo.length) return;
    shooting.current = true;
    (async () => {
      for (const s of todo) {
        try {
          localStorage.setItem(`inspire.shot.${s.id}`, "1");
        } catch {
          /* tried again next time */
        }
        await studio.refreshPreview(s.id).catch(() => {});
      }
    })().finally(() => {
      shooting.current = false;
    });
  }, [saves]);
  const [pillars] = useList("pillars");
  const [boards] = useList("boards");
  const [families] = useList("families");
  // ⌘- or ⇧-clicked saves, to gather into a board.
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [boardsOnly, setBoardsOnly] = useState(false);
  const [tab, setTab] = useState<Tab>(start === "ideas" ? "library" : "inbox");
  const [picked, setPicked] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [pillarFilter, setPillarFilter] = useState("");
  // Only saves of one type ("none": the ones still without a type).
  // ("ideas": the Library's ideas instead of saves.)
  const [topicFilter, setTopicFilter] = useState(start === "ideas" ? "ideas" : "");
  const [adding, setAdding] = useState(false);
  const [ideas] = useList("ideas");

  // The drop folder is looked at whenever Inspire opens (and every 15 s by the app).
  useEffect(() => {
    studio.root().then(() => studio.ingest()).then((rows) => rows.length && toast(`${rows.length} new from the drop folder`)).catch(() => {});
    // The growth brain's notes (HEADQUARTERS): new ones arrive in the Library.
    studio.importKnowledge().then((r) => r.added && toast(`${r.added} new from the knowledge notes, in the Library`)).catch(() => {});
  }, [toast]);

  const add = useCallback(
    async (url: string) => {
      const u = url.trim();
      if (!u) return;
      setBusy(true);
      try {
        const s = await studio.addLink(u);
        setLink("");
        setPicked(s.id);
        if (s.existing) {
          setTab(s.status === "archived" ? "archived" : s.status);
          toast("You saved this one before: here it is");
        } else {
          setTab("inbox");
          toast(s.title ? `Saved: ${s.title.slice(0, 70)}` : "Saved");
        }
      } catch (e) {
        toast(errorText(e), { error: true });
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );

  const addFiles = useCallback(
    async (files: File[]) => {
      let n = 0;
      for (const f of files) {
        if (f.size > 1_500_000_000) {
          toast(`${f.name} is too big to drop: put it in the drop folder instead`, { error: true });
          continue;
        }
        try {
          const s = await studio.addBytes(f.name, new Uint8Array(await f.arrayBuffer()));
          setPicked(s.id);
          n++;
        } catch (e) {
          toast(`${f.name}: ${errorText(e)}`, { error: true });
        }
      }
      if (n) {
        setTab("inbox");
        toast(`${n} saved to Inspire`);
      }
    },
    [toast],
  );

  // ⌘V anywhere on Inspire (outside a text field): a link or a pasted picture.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length) {
        e.preventDefault();
        void addFiles(files);
        return;
      }
      const text = e.clipboardData?.getData("text") ?? "";
      if (/^\s*(https?:\/\/|www\.)\S+\s*$/i.test(text)) {
        e.preventDefault();
        void add(text);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [add, addFiles]);

  const pick = async () => {
    const paths = await openDialog({ multiple: true, title: "Choose screenshots, recordings or saved links", filters: [{ name: "Inspiration", extensions: ["png", "jpg", "jpeg", "heic", "webp", "gif", "mov", "mp4", "m4v", "webloc", "url", "txt"] }] });
    if (!paths) return;
    try {
      const rows = await studio.addPaths(Array.isArray(paths) ? paths : [paths]);
      toast(rows.length ? `${rows.length} saved (left where they are)` : "Those were already saved");
      if (rows[0]) setPicked(rows[0].id);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };

  const importSaves = async () => {
    const path = await openDialog({ directory: true, title: "Choose your Instagram or TikTok data download (the unzipped folder)" });
    if (typeof path !== "string") return;
    setBusy(true);
    try {
      const r = await studio.importSaves(path);
      setTab("library");
      toast(r.added ? `Imported ${r.added} saved post${r.added > 1 ? "s" : ""}${r.already ? ` (${r.already} were already here)` : ""}. Pictures arrive in the background.` : r.already ? "All of those were already here" : "No saved or liked posts found in that folder");
    } catch (e) {
      toast(errorText(e), { error: true });
    } finally {
      setBusy(false);
    }
  };

  const openDrop = async () => {
    try {
      const root = await studio.root();
      await studio.openFolder(`${root}/81_INSPO_DROP`);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (saves ?? [])
      .filter((s) => s.kind !== "note")
      .filter((s) => (tab === "inbox" || tab === "library" || tab === "archived" ? s.status === tab : true))
      .filter((s) => !pillarFilter || s.pillarId === pillarFilter)
      .filter((s) => !topicFilter || (topicFilter === "none" ? !topicOf(s.topic) : s.topic === topicFilter))
      .filter((s) => {
        if (!q) return true;
        const b = s.boardId ? (boards ?? []).find((x) => x.id === s.boardId) : undefined;
        return [s.title, s.author, s.why, s.tags, s.autoLabels, s.ocrText, s.transcript, s.url, s.chips, b?.title, b?.client].join(" ").toLowerCase().includes(q);
      });
  }, [saves, boards, tab, search, pillarFilter, topicFilter]);
  // What the grid shows: a board once (where its newest save would be), saves on their own.
  const items = useMemo(() => {
    const out: ({ kind: "save"; save: Save } | { kind: "board"; board: Board; saves: Save[] })[] = [];
    const seen = new Set<string>();
    for (const s of shown) {
      const b = s.boardId ? (boards ?? []).find((x) => x.id === s.boardId) : undefined;
      if (b) {
        if (seen.has(b.id)) continue;
        seen.add(b.id);
        out.push({ kind: "board", board: b, saves: (saves ?? []).filter((x) => x.boardId === b.id) });
      } else if (!boardsOnly) out.push({ kind: "save", save: s });
    }
    return out;
  }, [shown, boards, saves, boardsOnly]);
  const boardCount = new Set(shown.map((s) => s.boardId).filter((id) => id && (boards ?? []).some((b) => b.id === id))).size;
  const clients = useMemo(
    () => [...new Set([...(boards ?? []).map((b) => b.client), ...(families ?? []).map((f) => f.client)].map((c) => c.trim()).filter(Boolean))].sort(),
    [boards, families],
  );
  const toggle = (id: string) => setSel((x) => {
    const next = new Set(x);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const makeBoard = async () => {
    const chosen = (saves ?? []).filter((s) => sel.has(s.id));
    if (!chosen.length) return;
    // A name to start from: what they share (the clinic's account), else the first title.
    const authors = [...new Set(chosen.map((s) => s.author).filter(Boolean))];
    const title = authors.length === 1 ? authors[0] : chosen[0].title.slice(0, 60) || "New board";
    try {
      const b = await studio.save("boards", null, { title, pillarId: chosen.find((s) => s.pillarId)?.pillarId ?? null });
      for (const s of chosen) await studio.save("saves", s.id, { boardId: b.id });
      setSel(new Set());
      setPicked(`board:${b.id}`);
      toast(`${chosen.length} saves gathered into a board`);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const addToBoard = async (boardId: string, ids: string[]) => {
    try {
      for (const id of ids) await studio.save("saves", id, { boardId });
      setSel(new Set());
      toast(`Added to ${(boards ?? []).find((b) => b.id === boardId)?.title || "the board"}`);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const listed = (saves ?? []).filter((s) => s.kind !== "note" && s.status === tab);
  const untyped = listed.filter((s) => !topicOf(s.topic)).length;
  const count = (st: string) => (saves ?? []).filter((s) => s.kind !== "note" && s.status === st).length;
  const current = (saves ?? []).find((s) => s.id === picked) ?? null;
  const currentBoard = picked?.startsWith("board:") ? (boards ?? []).find((b) => `board:${b.id}` === picked) ?? null : null;

  return (
    <div
      className={over ? "studio drop-over" : "studio"}
      data-studio-drop
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setOver(false);
      }}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer.files ?? []);
        setOver(false);
        if (!files.length) {
          const text = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text");
          if (text) {
            e.preventDefault();
            void add(text.split("\n")[0]);
          }
          return;
        }
        e.preventDefault();
        void addFiles(files);
      }}
    >
      <Hero
        title="Inspiration"
        sub={`${(saves ?? []).filter((s) => s.kind !== "note").length} saves · ${(ideas ?? []).length} ideas${over ? " · let go to save" : " · drop links or files anywhere here"}`}
      >
        <button type="button" className="btn primary" onClick={() => setAdding(true)} aria-label="Add inspiration" title="Add a link or files">
          {Icon.plus(16)} Add
        </button>
      </Hero>

      {/* One line: where you are, what type, then pillar, search and the archive. */}
      <div className="inspire-bar">
        <div className="st-tabs" role="group" aria-label="Show">
          {(
            [
              ["inbox", "Inspiration", count("inbox")],
              ["library", "Library", count("library")],
              ["trends", "Trends", null],
              ["watch", "Watchlist", null],
            ] as [Tab, string, number | null][]
          ).map(([id, label, n]) => (
            <button key={id} type="button" aria-pressed={tab === id || (id === "inbox" && tab === "archived")} onClick={() => setTab(id)}>
              {label}
              {n != null && <span className="n">{n}</span>}
            </button>
          ))}
        </div>
        {(tab === "inbox" || tab === "library" || tab === "archived") && (
          <>
            <div className="chipset inspire-types" role="group" aria-label="Filter">
              {tab === "library" && (
                <button type="button" className="chipbtn" aria-pressed={topicFilter === "ideas"} onClick={() => setTopicFilter(topicFilter === "ideas" ? "" : "ideas")}>
                  {Icon.idea(12)} Ideas <span className="n">{(ideas ?? []).length}</span>
                </button>
              )}
              {topicFilter !== "ideas" && (
                <>
                  <button type="button" className="chipbtn" aria-pressed={!topicFilter} onClick={() => setTopicFilter("")}>All</button>
                  {TOPICS.map((t) => (
                    <button key={t.id} type="button" className="chipbtn" aria-pressed={topicFilter === t.id} onClick={() => setTopicFilter(topicFilter === t.id ? "" : t.id)}>
                      {t.label}
                    </button>
                  ))}
                  {boardCount > 0 && (
                    <button type="button" className="chipbtn" aria-pressed={boardsOnly} onClick={() => setBoardsOnly(!boardsOnly)} title="Only boards">
                      Boards <span className="n">{boardCount}</span>
                    </button>
                  )}
                  {untyped > 0 && (
                    <button type="button" className="chipbtn" aria-pressed={topicFilter === "none"} onClick={() => setTopicFilter(topicFilter === "none" ? "" : "none")} title="Saves you haven't given a type yet">
                      No type <span className="n">{untyped}</span>
                    </button>
                  )}
                </>
              )}
            </div>
            <span className="spacer" />
            {topicFilter !== "ideas" && (
              <div className="inspire-tools">
                {(pillars ?? []).length > 0 && (
                  <Select className={pillarFilter ? "pick on" : "pick"} value={pillarFilter} onChange={(e) => setPillarFilter(e.target.value)} aria-label="Pillar">
                    <option value="">Every pillar</option>
                    {(pillars ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                )}
                <label className="inspire-search">
                  {Icon.search(13)}
                  <input placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search saves" />
                </label>
                {(count("archived") > 0 || tab === "archived") && (
                  <button
                    type="button"
                    className="icon-btn sd-icon"
                    aria-pressed={tab === "archived"}
                    title={tab === "archived" ? "Back to Inspiration" : `Archived (${count("archived")})`}
                    aria-label="Archived"
                    onClick={() => setTab(tab === "archived" ? "inbox" : "archived")}
                  >
                    {Icon.archive()}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {tab === "trends" ? (
        <Trends pillars={pillars ?? []} onSave={add} />
      ) : tab === "watch" ? (
        <Watchlist />
      ) : tab === "library" && topicFilter === "ideas" ? (
        <IdeasPanel />
      ) : (
        <div className="st-split">
          <div>
            {saves && shown.length === 0 ? (
              <p className="st-empty">
                {topicFilter
                  ? "Nothing of this type here."
                  : tab === "inbox"
                  ? "Nothing new. Paste a link (a video, a portfolio, a web app), drop a screenshot, or put files in the drop folder (Movies › STUDIO › 81_INSPO_DROP)."
                  : tab === "library"
                    ? "Sorted saves land here: open one from Inspiration and press “Keep in library”."
                    : "Nothing archived."}
              </p>
            ) : (
              <>
                <div className="masonry">
                  {items.map((it) =>
                    it.kind === "board" ? (
                      <BoardTile
                        key={`b${it.board.id}`}
                        board={it.board}
                        saves={it.saves}
                        pillar={(pillars ?? []).find((p) => p.id === it.board.pillarId)}
                        on={picked === `board:${it.board.id}`}
                        onClick={() => setPicked(picked === `board:${it.board.id}` ? null : `board:${it.board.id}`)}
                        onDropSaves={(ids) => void addToBoard(it.board.id, ids)}
                        dragging={sel}
                      />
                    ) : (
                      <SaveTile
                        key={it.save.id}
                        save={it.save}
                        on={it.save.id === picked}
                        selected={sel.has(it.save.id)}
                        onClick={(e) => (e.metaKey || e.shiftKey || sel.size ? toggle(it.save.id) : setPicked(it.save.id === picked ? null : it.save.id))}
                      />
                    ),
                  )}
                </div>
                {sel.size > 0 && (
                  <div className="sel-bar" role="toolbar" aria-label="Selected saves">
                    <b>{sel.size} selected</b>
                    <button type="button" className="btn primary small" onClick={() => void makeBoard()}>
                      Make a board
                    </button>
                    {(boards ?? []).length > 0 && (
                      <Select className="pick" aria-label="Add to a board" value="" onChange={(e) => e.target.value && void addToBoard(e.target.value, [...sel])}>
                        <option value="">Add to a board…</option>
                        {(boards ?? []).map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.title || "Untitled board"}
                            {b.client ? ` · ${b.client}` : ""}
                          </option>
                        ))}
                      </Select>
                    )}
                    <button type="button" className="link" onClick={() => setSel(new Set())}>
                      Clear
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
          <aside className="st-side">
            {currentBoard ? (
              <BoardDetail
                key={currentBoard.id}
                board={currentBoard}
                saves={(saves ?? []).filter((x) => x.boardId === currentBoard.id)}
                pillars={pillars ?? []}
                families={families ?? []}
                clients={clients}
                onOpenSave={(id) => setPicked(id)}
                onGone={() => setPicked(null)}
              />
            ) : current ? (
              <SaveDetail
                key={current.id}
                save={current}
                pillars={pillars ?? []}
                board={(boards ?? []).find((b) => b.id === current.boardId) ?? null}
                onOpenBoard={(id) => setPicked(`board:${id}`)}
                onIdea={() => openQuickIdea({ saveId: current.id, title: current.why || current.title })}
                onGone={() => setPicked(null)}
              />
            ) : (
              <section className="card">
                <p className="eyebrow">How saving works</p>
                <ul className="find" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6, color: "var(--ink-2)", fontSize: 13.5 }}>
                  <li>TikTok, YouTube and Vimeo links get their title and picture by themselves.</li>
                  <li>A website (a portfolio, a web app) is photographed as it opens.</li>
                  <li>Pick what each save is inspiration for, and write what you like about it.</li>
                  <li>⌘-click several saves (a clinic's videos and its website) and make them one board, linked to a client.</li>
                  <li>Instagram hides its previews: drop your screenshot next to the link.</li>
                  <li>Mac screenshots: ⌘⇧5 › Options › Save to › 81_INSPO_DROP, and they arrive here.</li>
                  <li>From the iPhone: AirDrop screen recordings, then drag them here.</li>
                  <li>From the browser: the “Save to Studio” button in Settings › Studio.</li>
                </ul>
              </section>
            )}
          </aside>
        </div>
      )}
      {adding && (
        <Modal
          title="Add inspiration"
          onClose={() => setAdding(false)}
          foot={
            <>
              <button type="button" className="link" onClick={() => void importSaves()} disabled={busy}>Import saves from a file…</button>
              <button type="button" className="link" onClick={() => void openDrop()}>Open the drop folder</button>
              <button
                type="button"
                className="link"
                onClick={() =>
                  void studio
                    .importKnowledge()
                    .then((r) => toast(`Knowledge notes: ${r.notes} read · ${r.added} new · ${r.updated} already here${r.skipped.length ? ` · ${r.skipped.length} skipped` : ""}`))
                    .catch((e) => toast(errorText(e), { error: true }))
                }
              >
                Import the knowledge notes
              </button>
            </>
          }
        >
          <div className="st-col">
            <input
              className="st-input"
              autoFocus
              value={link}
              placeholder="Paste a link: TikTok, Instagram, YouTube, Vimeo, a portfolio, a web app"
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && link.trim()) void add(link).then(() => setAdding(false));
              }}
            />
            <div className="st-row">
              <button type="button" className="btn primary" disabled={busy || !link.trim()} onClick={() => void add(link).then(() => setAdding(false))}>
                {busy ? "Saving…" : "Save link"}
              </button>
              <button type="button" className="btn quiet" onClick={() => void pick().then(() => setAdding(false))}>Add files…</button>
              <button type="button" className="btn quiet" onClick={() => (setAdding(false), openQuickIdea())}>New idea</button>
            </div>
            <p className="hint" style={{ margin: 0 }}>You can also drop links, screenshots and recordings anywhere on this page. Mac screenshots arrive by themselves when saved to the drop folder (⌘⇧5 › Options › Save to › 81_INSPO_DROP).</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Where a link lives, short: "brandonyasin.com". */
const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** One save, inspector-style: the picture and Open first, then what it is,
 *  what it's inspiration for and what you like about it. The rest is in "…". */
function SaveDetail({ save, pillars, board, onOpenBoard, onIdea, onGone }: { save: Save; pillars: Pillar[]; board: Board | null; onOpenBoard: (id: string) => void; onIdea: () => void; onGone: () => void }) {
  const toast = useToast();
  const [why, setWhy] = useState(save.why);
  const [tags, setTags] = useState(save.tags);
  const [similar, setSimilar] = useState<{ saves: string[]; photos: string[] } | null>(null);
  const [menuAt, setMenuAt] = useState<HTMLElement | null>(null);
  const [all] = useList("saves");
  const [ideas] = useList("ideas");
  const [linked, setLinked] = useState<string[]>([]);
  useEffect(() => {
    studio.linked("saveIdea", "a", save.id).then(setLinked).catch(() => {});
  }, [save.id, ideas]);
  const fail = useCallback((e: unknown) => toast(errorText(e), { error: true }), [toast]);
  const patch = useCallback((values: Partial<Save>) => studio.save("saves", save.id, values).catch(fail), [save.id, fail]);
  useDebounced(why, (v) => v !== save.why && void patch({ why: v }));
  useDebounced(tags, (v) => v !== save.tags && void patch({ tags: v }));
  const chips = save.chips.split(",").filter(Boolean);
  const topic = topicOf(save.topic);
  const toggleChip = (c: string) => void patch({ chips: (chips.includes(c) ? chips.filter((x) => x !== c) : [...chips, c]).join(",") });
  const src = saveThumb(save.thumb);
  const file = save.filePath && save.kind !== "note" ? save.filePath : null;
  const open = () => (save.url ? api.openLink(save.url).catch(fail) : file ? api.reveal(file).catch(fail) : undefined);
  const inLibrary = save.status === "library";
  const source = [save.platform === "file" ? null : platformName(save.platform), save.author && save.author !== platformName(save.platform) ? save.author : null, save.url ? domainOf(save.url) : null]
    .filter(Boolean)
    .join(" · ");

  const remove = async () => {
    setMenuAt(null);
    await studio.remove("saves", save.id).catch(fail);
    onGone();
    toast(save.filePath ? "Removed from Inspire (the file itself is left where it is)" : "Removed from Inspire");
  };
  const menu = (label: string, run: () => unknown, danger = false) => (
    <button type="button" className="opt" style={danger ? { color: "var(--red)" } : undefined} onClick={() => (setMenuAt(null), void run())}>
      {label}
    </button>
  );

  return (
    <section className="card save-detail">
      <button type="button" className="sd-media" onClick={() => void open()} disabled={!save.url && !file} title={save.url ? `Open ${domainOf(save.url)}` : file ? "Show in Finder" : undefined}>
        {src ? <img src={src} alt="" /> : <span className="ph">{platformName(save.platform)}</span>}
      </button>

      <div className="sd-actions">
        {save.url ? (
          <button type="button" className="btn primary small" onClick={() => void open()}>
            {Icon.open()} Open
          </button>
        ) : file ? (
          <button type="button" className="btn primary small" onClick={() => void open()}>
            {Icon.folder(13)} Show {save.kind === "video" ? "video" : "file"}
          </button>
        ) : null}
        <button type="button" className="btn quiet small" onClick={onIdea}>
          {Icon.idea(13)} Idea
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="icon-btn sd-icon"
          aria-pressed={inLibrary}
          title={inLibrary ? "In your library (click to send it back to Inspiration)" : "Keep in library"}
          aria-label={inLibrary ? "In your library" : "Keep in library"}
          onClick={() => void patch({ status: inLibrary ? "inbox" : "library" })}
        >
          {Icon.book()}
        </button>
        <button type="button" className="icon-btn sd-icon" aria-label="More" title="More" aria-expanded={!!menuAt} onClick={(e) => setMenuAt(menuAt ? null : e.currentTarget)}>
          {Icon.more()}
        </button>
        {menuAt && (
          <Popover anchor={menuAt} onClose={() => setMenuAt(null)} width={210}>
            {menu("More like this", () => studio.similar(save.id).then(setSimilar).catch(fail))}
            {board && menu(`Take out of ${board.title || "the board"}`, () => patch({ boardId: null }))}
            {save.kind === "link" && menu("Fetch the preview again", () => studio.refreshPreview(save.id).catch(fail))}
            {save.url && file && menu(`Show ${save.kind === "video" ? "video" : "file"} in Finder`, () => api.reveal(file).catch(fail))}
            {save.status === "archived" ? menu("Back to Inspiration", () => patch({ status: "inbox" })) : menu("Archive", () => patch({ status: "archived" }))}
            {menu("Remove", remove, true)}
          </Popover>
        )}
      </div>

      {board && (
        <button type="button" className="sd-board" onClick={() => onOpenBoard(board.id)}>
          {Icon.back(11)} {board.title || "Untitled board"}
          {board.client && <span> · {board.client}</span>}
        </button>
      )}
      <div className="sd-head">
        <h3>{save.title || "Untitled"}</h3>
        {source && (
          <button type="button" className="sd-source" onClick={() => void open()} disabled={!save.url} title={save.url ?? undefined}>
            {source}
            {save.url && Icon.open(11)}
          </button>
        )}
        {save.platform === "file" && save.filePath && <span className="sd-source">{save.filePath.split("/").pop()}</span>}
        {save.status === "archived" && <span className="st-chip" style={{ alignSelf: "start" }}>Archived</span>}
      </div>

      <div className="sd-group">
        <span className="sd-label">For</span>
        <div className="chipset" role="group" aria-label="Inspiration for">
          {TOPICS.map((t) => (
            <button key={t.id} type="button" className="chipbtn" aria-pressed={save.topic === t.id} onClick={() => void patch({ topic: save.topic === t.id ? "" : t.id })}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="sd-group">
        <span className="sd-label">What I like</span>
        <textarea className="sd-note" rows={2} value={why} placeholder={topic?.prompt ?? "What caught your eye"} onChange={(e) => setWhy(e.target.value)} aria-label="What I like" />
        <div className="chipset" role="group" aria-label="What works">
          {(topic?.chips ?? TOPICS[0].chips).map((c) => (
            <button key={c} type="button" className="chipbtn small" aria-pressed={chips.includes(c)} onClick={() => toggleChip(c)}>
              {c}
            </button>
          ))}
        </div>
      </div>

      {save.kind === "video" && <Transcript save={save} />}

      <div className="sd-meta">
        <Select className="pick" aria-label="Pillar" value={save.pillarId ?? ""} onChange={(e) => void patch({ pillarId: e.target.value || null })}>
          <option value="">No pillar</option>
          {pillars.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <input className="sd-tags" value={tags} placeholder="Tags, comma separated" onChange={(e) => setTags(e.target.value)} aria-label="Tags" />
      </div>

      {linked.length > 0 && (
        <div className="sd-group">
          <span className="sd-label">Ideas from this</span>
          <div className="st-list">
            {linked.map((id) => {
              const idea = (ideas ?? []).find((i) => i.id === id);
              return idea ? (
                <div key={id} className="st-item">
                  <span className="st-dot" />
                  <span className="t">{idea.title}</span>
                  <span className="st-chip">{idea.status}</span>
                </div>
              ) : null;
            })}
          </div>
        </div>
      )}

      {similar && (
        <div className="sd-group">
          <span className="sd-label">
            More like this
            <button type="button" className="link" style={{ marginLeft: 8 }} onClick={() => setSimilar(null)}>Hide</button>
          </span>
          {similar.saves.length + similar.photos.length === 0 && <span className="meta">Nothing similar yet.</span>}
          <div className="media-strip">
            {similar.saves.map((id) => {
              const s = (all ?? []).find((x) => x.id === id);
              return s && saveThumb(s.thumb) ? (
                <div key={id} className="m" title={s.title}>
                  <img src={saveThumb(s.thumb)} alt="" />
                </div>
              ) : null;
            })}
            {similar.photos.map((id) => (
              <div key={id} className="m" title="From your library">
                <img src={imageUrl("thumb", id)} alt="" />
              </div>
            ))}
          </div>
        </div>
      )}


    </section>
  );
}

/** "3 videos · 1 website": what a board holds. */
function boardKinds(saves: Save[]): string {
  const n = { video: 0, website: 0, picture: 0 };
  for (const s of saves) {
    if (s.kind === "video" || ["tiktok", "youtube", "vimeo", "instagram"].includes(s.platform)) n.video++;
    else if (s.kind === "link") n.website++;
    else n.picture++;
  }
  return [
    n.video && `${n.video} video${n.video > 1 ? "s" : ""}`,
    n.website && `${n.website} website${n.website > 1 ? "s" : ""}`,
    n.picture && `${n.picture} picture${n.picture > 1 ? "s" : ""}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A board in the grid: its first four pictures as one tile; saves dropped on it join it. */
function BoardTile({ board, saves, pillar, on, onClick, onDropSaves, dragging }: { board: Board; saves: Save[]; pillar?: Pillar; on: boolean; onClick: () => void; onDropSaves: (ids: string[]) => void; dragging: Set<string> }) {
  const [over, setOver] = useState(false);
  const pics = saves.map((s) => saveThumb(s.thumb)).filter(Boolean).slice(0, 4) as string[];
  return (
    <button
      type="button"
      className={`save-tile board-tile${on ? " on" : ""}${over ? " drop" : ""}`}
      onClick={onClick}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(SAVE_DRAG)) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(SAVE_DRAG);
        if (!id) return;
        e.preventDefault();
        // Dragging one of several selected saves brings the whole selection.
        onDropSaves(dragging.has(id) ? [...dragging] : [id]);
      }}
    >
      <div className={`pic board-pic n${Math.max(1, pics.length)}`}>
        {pics.length ? pics.map((src, i) => <img key={i} src={src} alt="" loading="lazy" />) : <div className="ph">Board</div>}
        <span className="type">Board · {saves.length}</span>
      </div>
      <div className="meta-line">
        <b>{board.title || "Untitled board"}</b>
        <small>{[board.client, pillar?.name, boardKinds(saves)].filter(Boolean).join(" · ")}</small>
        {board.notes && <span className="why">“{board.notes}”</span>}
      </div>
    </button>
  );
}

/** One board: what it's for (client, pillar, project), notes, and its saves. */
function BoardDetail({ board, saves, pillars, families, clients, onOpenSave, onGone }: {
  board: Board;
  saves: Save[];
  pillars: Pillar[];
  families: Family[];
  clients: string[];
  onOpenSave: (id: string) => void;
  onGone: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState(board.title);
  const [client, setClient] = useState(board.client);
  const [notes, setNotes] = useState(board.notes);
  const [menuAt, setMenuAt] = useState<HTMLElement | null>(null);
  const fail = useCallback((e: unknown) => toast(errorText(e), { error: true }), [toast]);
  const patch = useCallback((values: Partial<Board>) => studio.save("boards", board.id, values).catch(fail), [board.id, fail]);
  useDebounced(title, (v) => v !== board.title && void patch({ title: v }));
  useDebounced(client, (v) => v !== board.client && void patch({ client: v.trim() }));
  useDebounced(notes, (v) => v !== board.notes && void patch({ notes: v }));
  const projects = families.filter((f) => f.kind !== "singles" && !f.archived);
  const links = saves.filter((s) => s.url);
  const ungroup = async () => {
    setMenuAt(null);
    try {
      await studio.remove("boards", board.id);
      onGone();
      toast(`Board ungrouped: its ${saves.length} saves are back on their own`);
    } catch (e) {
      fail(e);
    }
  };
  return (
    <section className="card save-detail board-detail">
      <div className={`board-cover n${Math.min(4, Math.max(1, saves.filter((s) => s.thumb).length))}`}>
        {saves
          .filter((s) => s.thumb)
          .slice(0, 4)
          .map((s) => (
            <button key={s.id} type="button" onClick={() => onOpenSave(s.id)} title={s.title}>
              <img src={saveThumb(s.thumb)} alt="" />
            </button>
          ))}
      </div>
      <div className="sd-actions">
        {links.length > 0 && (
          <button type="button" className="btn primary small" onClick={() => links.slice(0, 8).forEach((s) => void api.openLink(s.url).catch(fail))} title="Each link in your browser">
            {Icon.open()} Open {links.length === 1 ? "the link" : `all ${Math.min(8, links.length)} links`}
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="icon-btn sd-icon" aria-label="More" title="More" aria-expanded={!!menuAt} onClick={(e) => setMenuAt(menuAt ? null : e.currentTarget)}>
          {Icon.more()}
        </button>
        {menuAt && (
          <Popover anchor={menuAt} onClose={() => setMenuAt(null)} width={220}>
            <button type="button" className="opt" onClick={() => void ungroup()}>
              Ungroup (keep the saves)
            </button>
          </Popover>
        )}
      </div>
      <div className="sd-head">
        <input className="board-title" value={title} placeholder="Name this board" aria-label="Board name" onChange={(e) => setTitle(e.target.value)} />
        <span className="sd-source">{boardKinds(saves) || "Empty"}</span>
      </div>
      <div className="sd-group">
        <span className="sd-label">For</span>
        <div className="board-links">
          <label className="board-field">
            <span>Client</span>
            <input list="board-clients" value={client} placeholder="e.g. Dr Example" onChange={(e) => setClient(e.target.value)} aria-label="Client" />
            <datalist id="board-clients">
              {clients.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label className="board-field">
            <span>Pillar</span>
            <Select className="pick" aria-label="Pillar" value={board.pillarId ?? ""} onChange={(e) => void patch({ pillarId: e.target.value || null })}>
              <option value="">None</option>
              {pillars.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </label>
          <label className="board-field">
            <span>Project</span>
            <Select className="pick" aria-label="Series or campaign" value={board.familyId ?? ""} onChange={(e) => void patch({ familyId: e.target.value || null })}>
              <option value="">None</option>
              {projects.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                  {f.kind === "campaign" ? " · campaign" : " · series"}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </div>
      <div className="sd-group">
        <span className="sd-label">What I like</span>
        <textarea className="sd-note" rows={2} value={notes} placeholder="The colours, the pace of the videos, how the site opens…" onChange={(e) => setNotes(e.target.value)} aria-label="Board notes" />
      </div>
      <div className="sd-group">
        <span className="sd-label">In this board · {saves.length}</span>
        <div className="board-items">
          {saves.map((s) => (
            <div key={s.id} className="board-item">
              <button type="button" className="board-item-open" onClick={() => onOpenSave(s.id)}>
                {s.thumb ? <img src={saveThumb(s.thumb)} alt="" /> : <span className="ph" />}
                <span className="t">
                  <b title={s.title || s.url || undefined}>{s.title || s.url || "Untitled save"}</b>
                  <small>{s.platform === "file" ? (s.kind === "video" ? "Recording" : "Screenshot") : platformName(s.platform)}</small>
                </span>
              </button>
              <button type="button" className="icon-btn" aria-label={`Take ${s.title || "this save"} out of the board`} title="Take out of the board" onClick={() => void studio.save("saves", s.id, { boardId: null }).catch(fail)}>
                {Icon.x(10)}
              </button>
            </div>
          ))}
        </div>
        <span className="meta" style={{ fontSize: 12 }}>Drag more saves onto the board's tile to add them.</span>
      </div>
    </section>
  );
}

function Trends({ pillars, onSave }: { pillars: Pillar[]; onSave: (url: string) => Promise<void> }) {
  const toast = useToast();
  const [trends, setTrends] = useState<Trend[] | null>(null);
  const [words, setWords] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    studio.trends("BE").then(setTrends).catch((e) => {
      setTrends([]);
      toast(errorText(e), { error: true });
    });
  }, [toast]);
  const search = async () => {
    if (!words.trim()) return;
    setBusy(true);
    try {
      setFound(await studio.youtube(words.trim()));
    } catch (e) {
      toast(errorText(e), { error: true });
    } finally {
      setBusy(false);
    }
  };
  const pillarWords = pillars.map((p) => p.name.toLowerCase());
  return (
    <div className="grid-2">
      <section className="card st-col">
        <p className="eyebrow">
          <span>Searched in Belgium today</span>
          <span>Google Trends</span>
        </p>
        {trends == null ? (
          <span className="meta">Asking Google…</span>
        ) : trends.length === 0 ? (
          <p className="st-empty">No trends came back. Check the internet connection.</p>
        ) : (
          <div className="st-list">
            {trends.map((t) => (
              <div key={t.title} className="trend">
                <b>{t.title}</b>
                <span className="st-chip">{t.traffic}</span>
                {t.news.length > 0 && <small>{t.news.join(" · ")}</small>}
                {pillarWords.some((w) => t.title.toLowerCase().includes(w)) && <span className="st-chip accent">your pillar</span>}
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="card st-col">
        <p className="eyebrow">
          <span>YouTube Shorts</span>
          <span>needs a key in Settings › Studio</span>
        </p>
        <div className="st-row">
          <input className="st-input" style={{ flex: 1 }} value={words} placeholder="e.g. braids tutorial, spf myths" onChange={(e) => setWords(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void search()} />
          <button type="button" className="btn primary" disabled={busy || !words.trim()} onClick={() => void search()}>
            Search
          </button>
        </div>
        {found && found.length === 0 && <span className="meta">Nothing found.</span>}
        <div className="st-list">
          {(found ?? []).map((f) => (
            <div key={f.url} className="st-item">
              {f.thumbUrl ? <img src={f.thumbUrl} alt="" style={{ width: 64, height: 36, objectFit: "cover", borderRadius: 6 }} /> : <span className="st-dot" />}
              <span style={{ minWidth: 0 }}>
                <span className="t">{f.title}</span>
                <small>{f.author}</small>
              </span>
              <button type="button" className="btn quiet small" onClick={() => void onSave(f.url)}>
                Save
              </button>
            </div>
          ))}
        </div>
        <p className="hint">TikTok has no public trends feed; check its Creative Center in the browser and save what you like with the Save to Studio button.</p>
      </section>
    </div>
  );
}

function Watchlist() {
  const toast = useToast();
  const [rows] = useList("watch");
  const [handle, setHandle] = useState("");
  const add = async () => {
    const h = handle.trim().replace(/^@/, "");
    if (!h) return;
    await studio.save("watch", null, { handle: h, platform: "instagram" }).catch((e) => toast(errorText(e), { error: true }));
    setHandle("");
  };
  const check = (w: Watch) => studio.watchCheck(w.id).catch((e) => toast(errorText(e), { error: true }));
  return (
    <section className="card st-col">
      <p className="eyebrow">
        <span>Accounts to keep an eye on</span>
        <span>Instagram business discovery</span>
      </p>
      <div className="st-row">
        <input className="st-input" style={{ flex: 1, maxWidth: 360 }} value={handle} placeholder="@account (business or creator accounts)" onChange={(e) => setHandle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} />
        <button type="button" className="btn primary" disabled={!handle.trim()} onClick={() => void add()}>
          Add
        </button>
      </div>
      {(rows ?? []).length === 0 && <p className="st-empty">Add accounts whose posts you want to learn from. Checking them needs your Instagram token in Settings › Studio.</p>}
      <div className="st-list">
        {(rows ?? []).map((w) => {
          let last: { followers_count?: number; media_count?: number; media?: { data?: { permalink: string; like_count?: number; comments_count?: number; caption?: string }[] } } = {};
          try {
            last = w.last ? JSON.parse(w.last) : {};
          } catch {
            /* nothing fetched yet */
          }
          return (
            <div key={w.id} className="card tight st-col" style={{ gap: 8 }}>
              <div className="st-row between">
                <b>@{w.handle}</b>
                <div className="st-row">
                  {last.followers_count != null && <span className="st-chip accent">{last.followers_count.toLocaleString()} followers</span>}
                  {w.checkedMs && <span className="meta">checked {new Date(w.checkedMs).toLocaleDateString()}</span>}
                  <button type="button" className="btn quiet small" onClick={() => void check(w)}>
                    Check now
                  </button>
                  <button type="button" className="btn danger small" onClick={() => void studio.remove("watch", w.id)}>
                    Remove
                  </button>
                </div>
              </div>
              {w.notes && <div style={{ fontSize: 13, color: "var(--ink-2)", whiteSpace: "pre-wrap", userSelect: "text" }}>{w.notes}</div>}
              {(last.media?.data ?? []).slice(0, 6).map((m) => (
                <div key={m.permalink} className="st-row between" style={{ fontSize: 13 }}>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{(m.caption ?? "").slice(0, 90) || m.permalink}</span>
                  <span className="meta">
                    {m.like_count ?? "–"} likes · {m.comments_count ?? "–"} comments
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
