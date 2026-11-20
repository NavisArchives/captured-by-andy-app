// Today on the desktop and the web (NIRMATA Amendment 4, Andy 19 Nov: « a
// dashboard with no scroll… the archive to review, select, and the recent
// albums visible in one »). One screen, never scrolling:
//   header line → five number tiles (doors into Archive) → Culling · Next up ·
//   This week → Recent albums · In progress.
// Principles taken (not pixels): Linear's home keeps a short, ranked queue and
// puts the rest one click away; Apple Photos lets covers carry the albums with
// just a name and a count; Things' Today shows only today and stays calm, with
// one accent. The phone keeps PhoneToday.
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { WEB } from "../platform";
import { Thumb } from "../components/Thumb";
import { Icon } from "../components/ui";
import { ResumeCull } from "../components/ResumeCull";
import { useTodayMenu, usePostMenu } from "../components/menus";
import { bytes, plural } from "../lib/format";
import { isDue } from "../lib/postFlow";
import { studio } from "../studio/api";
import { stageLabel, type Piece } from "../studio/types";
import { LAST_IMPORT_CULL, useStore } from "../store";
import type { MorningBrief, Post, Query, Summary } from "../types";

const NEXT_ROWS = 4;
const LOW_DISK = 10e9;

type Next = { title: string; sub?: string; tone: "warn" | "ok" | "idle"; rank: number; run: () => void };

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const agoShort = (ms: number | null) => {
  if (!ms) return "no scan yet";
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "last scan just now" : m < 60 ? `last scan ${m} min ago` : m < 1440 ? `last scan ${Math.round(m / 60)} h ago` : `last scan ${Math.round(m / 1440)} d ago`;
};

export function Dashboard() {
  const { version, smart, go, startCull, addFolder, setQuery, setSelection, editIds, albums } = useStore();
  const [s, setS] = useState<Summary | null>(null);
  const [brief, setBrief] = useState<MorningBrief | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [ideasWaiting, setIdeasWaiting] = useState(0);
  const [savesWaiting, setSavesWaiting] = useState(0);
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [sheet, setSheet] = useState(false);
  const todayMenu = useTodayMenu();
  const postMenu = usePostMenu();
  useEffect(() => {
    api.dashboard().then(setS).catch(() => {});
    api.morningBrief().then(setBrief).catch(() => {});
    api.listPosts().then(setPosts).catch(() => {});
    studio.list("ideas", { status: "inbox" }).then((r) => setIdeasWaiting(r.length)).catch(() => {});
    studio.list("saves", { status: "inbox" }).then((r) => setSavesWaiting(r.length)).catch(() => {});
    studio.list("pieces").then((r) => setPieces(r.filter((p) => p.stage !== "posted" && p.stage !== "reviewed" && !p.parked))).catch(() => {});
  }, [version]);

  const show = (q: Query) => {
    setQuery({ order: "newest", ...q });
    setSelection(new Set());
    go({ name: "pictures" });
  };

  // The week ahead, today first: which days have a post planned.
  const week = useMemo(() => {
    const start = new Date();
    start.setHours(12, 0, 0, 0);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = dayKey(d);
      const day = posts.filter((p) => p.status === "scheduled" && p.scheduledAt?.slice(0, 10) === key);
      // Today also carries what is overdue: one source with « Next up ».
      return { d, key, posts: i === 0 ? [...posts.filter((p) => isDue(p) && p.scheduledAt!.slice(0, 10) < key), ...day] : day };
    });
  }, [posts]);

  if (!s) return <div className="screen" />;
  const c = s.counts;
  const reviewed = c.all - c.unreviewed;
  const pct = c.all ? Math.round((reviewed / c.all) * 100) : 0;
  const fresh = smart?.lastImportUnreviewed ?? 0;
  const due = posts.filter(isDue);
  // The posts to come, due ones first (they are what « Next up » counts).
  const coming = posts
    .filter((p) => p.status === "scheduled" && p.scheduledAt)
    .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
  const weekCount = week.reduce((n, w) => n + w.posts.filter((p) => !isDue(p)).length, 0);

  // Next up, ranked: due today → the new import → what blocks posting → the rest.
  const next: Next[] = [];
  if (due.length) next.push({ rank: 0, tone: "warn", title: due.length === 1 ? "1 post is due" : `${due.length} posts are due`, sub: "Mark them posted", run: () => go({ name: "posts" }) });
  if (fresh) next.push({ rank: 1, tone: "warn", title: `${plural(fresh, "new picture")} from the last scan`, sub: "Cull just this import", run: () => void startCull(LAST_IMPORT_CULL) });
  if (s.missing) next.push({ rank: 1, tone: "warn", title: `${plural(s.missing, "file")} missing`, sub: "Moved, deleted or the drive is out", run: () => show({ storage: "missing" }) });
  if (brief?.postsReady) next.push({ rank: 2, tone: "ok", title: `${plural(brief.postsReady, "post")} ready, no date yet`, sub: "Give each a day", run: () => go({ name: "posts" }) });
  if (smart?.notEditedSelected) next.push({ rank: 2, tone: "ok", title: `${plural(smart.notEditedSelected, "selected picture")} without a look`, sub: WEB ? "Shown in Archive; edit them on the Mac" : "Opens them in the editor", run: () => {
    const q: Query = { review: "selected", smart: "not_edited_selected", order: "newest" };
    // The Mac edits them straight away; online they open in Archive.
    if (WEB) return show(q);
    void api.photoIds(q, 0, 5000).then((ids) => (ids.length ? editIds(ids) : show(q))).catch(() => show(q));
  } });
  if (smart?.burstsUnreviewed) next.push({ rank: 3, tone: "idle", title: `${plural(smart.burstsUnreviewed, "similar shot")} to compare`, sub: "C in Cull", run: () => show({ smart: "bursts", review: "unreviewed" }) });
  if (ideasWaiting) next.push({ rank: 3, tone: "idle", title: `${plural(ideasWaiting, "idea")} waiting`, sub: "Keep, maybe or drop", run: () => go({ name: "ideas" }) });
  if (savesWaiting) next.push({ rank: 3, tone: "idle", title: `${plural(savesWaiting, "save")} to sort`, sub: "Inspiration you saved", run: () => go({ name: "inspire" }) });
  if (brief?.cleanupCopies) next.push({ rank: 3, tone: "idle", title: `${bytes(brief.cleanupCopiesBytes)} of near-copies can go`, sub: "Clean up", run: () => go({ name: "cleanup" }) });
  if (s.thumbsPending) next.push({ rank: 4, tone: "idle", title: `Thumbnails · ${s.thumbsPending.toLocaleString()} to go`, sub: "Running in the background", run: () => go({ name: "pictures" }) });
  next.sort((a, b) => a.rank - b.rank);

  const hour = new Date().getHours();
  const hello = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const date = new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const disk = brief?.diskFree ?? null;
  const recent = [...albums].sort((a, b) => b.updatedMs - a.updatedMs).slice(0, 6);

  const tiles: [number, string, Query, boolean?][] = [
    [c.unreviewed, "To review", { review: "unreviewed" }],
    [c.selected, "Selected", { review: "selected" }, true],
    [s.selectedUnposted, "Selected, never posted", { review: "selected", smart: "selected_unposted" }],
    [c.rejected, "Rejected", { review: "rejected" }],
    [c.all, "All pictures", {}],
  ];

  const NextRow = ({ n }: { n: Next }) => (
    <button type="button" className="db-next" onClick={() => { setSheet(false); n.run(); }} onContextMenu={(e) => todayMenu(e, n.title, () => { setSheet(false); n.run(); })}>
      <i className={`db-dot ${n.tone}`} />
      <span className="db-next-t">
        <b>{n.title}</b>
        {n.sub && <small>{n.sub}</small>}
      </span>
      <span className="db-chev" aria-hidden="true">›</span>
    </button>
  );

  return (
    <div className="screen dash">
      <header className="db-head">
        <h1>{hello}, <i>Andy</i></h1>
        <span className="meta">{date} · {agoShort(s.lastScanMs)}</span>
        <span className="db-head-r">
          {disk != null && (
            <button type="button" className={`db-chip${disk < LOW_DISK ? " warn" : ""}`} onClick={() => go({ name: "cleanup" })} title="Free space on the Mac">
              {bytes(disk)} free
            </button>
          )}
          {s.sources.length > 0 && (fresh ? (
            <button type="button" className="btn primary" onClick={() => void startCull(LAST_IMPORT_CULL)}>Cull {fresh.toLocaleString()} new</button>
          ) : (
            <button type="button" className="btn primary" disabled={!c.unreviewed} onClick={() => void startCull({ review: "unreviewed", order: "oldest" })}>Start culling</button>
          ))}
        </span>
      </header>

      {!s.sources.length ? (
        <section className="card empty db-first">
          <h3>Start with a folder</h3>
          <p>Point the app at the folder with your photos. It indexes everything without moving, renaming or changing a single file.</p>
          <button type="button" className="btn primary" onClick={addFolder}>{Icon.folder()} Choose folder…</button>
        </section>
      ) : (
        <>
          <nav className="db-tiles" aria-label="Archive">
            {tiles.map(([n, label, q, accent]) => (
              <button key={label} type="button" className={`db-tile${accent ? " accent" : ""}`} onClick={() => show(q)} onContextMenu={(e) => todayMenu(e, label, () => show(q))} aria-label={`${label}: ${n.toLocaleString()}, open in Archive`}>
                <b>{n.toLocaleString()}</b>
                <span>{label}</span>
              </button>
            ))}
          </nav>

          <div className="db-row db-row-3">
            <section className="card db-card" aria-label="Culling">
              <p className="eyebrow"><span>Culling</span><span>{pct}% reviewed</span></p>
              <div className="db-cull-n">{reviewed.toLocaleString()} <span>of {c.all.toLocaleString()}</span></div>
              <div className="bar"><i style={{ width: `${pct}%` }} /></div>
              <p className="meta">{c.selected.toLocaleString()} selected · {c.maybe.toLocaleString()} maybe · {c.unreviewed.toLocaleString()} to go</p>
              <div className="db-actions">
                <button type="button" className="btn primary small" disabled={!c.unreviewed} onClick={() => void startCull({ review: "unreviewed", order: "oldest" })}>Continue</button>
                <button type="button" className="btn quiet small" disabled={!c.maybe} onClick={() => void startCull({ review: "maybe", order: "oldest" })}>Review maybes</button>
                <ResumeCull compact />
              </div>
            </section>

            <section className="card db-card" aria-label="Next up">
              <p className="eyebrow">
                <span>Next up</span>
                {next.length > NEXT_ROWS && <button type="button" className="link" onClick={() => setSheet(true)}>All {next.length}</button>}
              </p>
              {next.length ? (
                <div className="db-next-list">{next.slice(0, NEXT_ROWS).map((n) => <NextRow key={n.title} n={n} />)}</div>
              ) : (
                <p className="db-quiet">Nothing needs you. Everything is reviewed, edited and planned.</p>
              )}
            </section>

            <section className="card db-card db-weekcard" aria-label="This week">
              <p className="eyebrow"><span>This week</span><button type="button" className="link" onClick={() => go({ name: "posts" })}>Open calendar</button></p>
              <div className="db-week">
                {week.map((w, i) => (
                  <button key={w.key} type="button" className={`db-day${i === 0 ? " today" : ""}`} onClick={() => go({ name: "posts" })} aria-label={`${w.d.toLocaleDateString(undefined, { weekday: "long" })}: ${plural(w.posts.length, "post")}${w.posts.some(isDue) ? ", due" : ""}`}>
                    <small>{w.d.toLocaleDateString(undefined, { weekday: "narrow" })}</small>
                    <b>{w.d.getDate()}</b>
                    <i className={w.posts.some(isDue) ? "due" : w.posts.length ? "on" : ""} />
                  </button>
                ))}
              </div>
              <p className="meta db-week-sum">{[due.length ? `${due.length} due` : null, `${weekCount} planned this week`, brief?.postsReady ? `${brief.postsReady} without a day` : null].filter(Boolean).join(" · ")}</p>
              {coming.length ? (
                <div className="db-coming">
                  {coming.slice(0, 3).map((p) => (
                    <button key={p.id} type="button" className="db-next" onClick={() => go({ name: "posts" })} onContextMenu={(e) => postMenu(e, p)}>
                      <i className={`db-dot ${isDue(p) ? "warn" : "ok"}`} />
                      <span className="db-next-t">
                        <b>{p.title || "Untitled post"}</b>
                        <small>{isDue(p) ? "Due · " : ""}{new Date(`${p.scheduledAt!.slice(0, 10)}T12:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}{p.accountUsername ? ` · @${p.accountUsername}` : ""}</small>
                      </span>
                      <span className="db-chev" aria-hidden="true">›</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="db-quiet">No post planned yet. Plan one in Socials.</p>
              )}
            </section>
          </div>

          <div className="db-row db-row-2">
            <section className="card db-card" aria-label="Recent albums">
              <p className="eyebrow"><span>Recent albums</span><button type="button" className="link" onClick={() => go({ name: "albums" })}>All albums</button></p>
              {recent.length ? (
                <div className="db-albums">
                  {recent.map((a) => (
                    <button key={a.id} type="button" className="db-album" onClick={() => show({ album: a.id })} title={a.name}>
                      <div className="db-cover"><Thumb id={a.coverPhotoId} hash={a.coverThumbhash} /></div>
                      <b>{a.name}</b>
                      <small>{plural(a.photoCount, "picture")}</small>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="db-empty"><p className="db-quiet">Your first album appears here. Pick pictures in Archive and choose Album.</p></div>
              )}
            </section>
            <section className="card db-card" aria-label="In progress">
              <p className="eyebrow"><span>In progress</span><button type="button" className="link" onClick={() => go({ name: "write" })}>All projects</button></p>
              {pieces.length ? (
                <div className="db-next-list">
                  {pieces.slice(0, 3).map((p) => (
                    <button key={p.id} type="button" className="db-next" onClick={() => go({ name: "write", id: p.id })}>
                      <span className="db-next-t"><b>{p.title}</b><small>{stageLabel(p.stage)}{p.plannedDate ? ` · for ${p.plannedDate}` : ""}</small></span>
                      <span className="db-chev" aria-hidden="true">›</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="db-empty"><p className="db-quiet">No project in progress. Green-light an idea to start one.</p></div>
              )}
            </section>
          </div>
        </>
      )}

      {sheet && (
        <div className="db-sheet-wrap" onKeyDown={(e) => e.key === "Escape" && setSheet(false)}>
          <div className="db-sheet-catch" onClick={() => setSheet(false)} />
          <aside className="db-sheet" role="dialog" aria-modal="true" aria-label="Next up, all">
            <header><b>Next up · {next.length}</b><button type="button" className="drawer-x" aria-label="Close" autoFocus onClick={() => setSheet(false)}>×</button></header>
            <div className="db-next-list">{next.map((n) => <NextRow key={n.title} n={n} />)}</div>
          </aside>
        </div>
      )}
    </div>
  );
}
