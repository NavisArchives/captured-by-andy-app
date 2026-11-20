// The phone's Today (NIRMATA spec §4.1, Andy 19 Nov: « compact… an app would
// never function like this »): one thing to do next, then at most five rows
// that each open in one tap. No stat walls, no paths, rows with nothing to do
// are not shown. The desktop keeps Dashboard.tsx.
import { useEffect, useState } from "react";
import { api } from "../api";
import { studio } from "../studio/api";
import { isDue } from "../lib/postFlow";
import { LAST_IMPORT_CULL, useStore } from "../store";

type Row = { title: string; sub?: string; dot: "warn" | "ok" | "idle"; run: () => void };

const n = (x: number, one: string, many = `${one}s`) => `${x.toLocaleString()} ${x === 1 ? one : many}`;

export function PhoneToday() {
  const s = useStore();
  const { counts, smart, version, go, startCull } = s;
  const [due, setDue] = useState(0);
  const [ideas, setIdeas] = useState(0);
  const [saves, setSaves] = useState(0);
  const [pieces, setPieces] = useState<{ title: string; id: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const saveLink = async () => {
    const url = (link ?? "").trim();
    if (!/^https?:\/\//i.test(url)) return;
    await studio.save("saves", null, { kind: "link", url, status: "inbox" }).catch(() => {});
    setLink(null);
    s.bump();
  };
  useEffect(() => {
    api.listPosts({ status: "scheduled" }).then((ps) => setDue(ps.filter(isDue).length)).catch(() => {});
    studio.list("ideas", { status: "inbox" }).then((r) => setIdeas(r.length)).catch(() => {});
    studio.list("saves", { status: "inbox" }).then((r) => setSaves(r.length)).catch(() => {});
    studio.list("pieces").then((r) => {
      const open = r.find((p) => (p as { status?: string }).status !== "done" && (p as { status?: string }).status !== "posted");
      setPieces(open ? { title: (open as { title: string }).title, id: open.id } : null);
    }).catch(() => {});
  }, [version]);

  const hour = new Date().getHours();
  const hello = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const toReview = counts?.unreviewed ?? 0;
  const fresh = smart?.lastImportUnreviewed ?? 0;

  // The one thing to do next.
  const hero = fresh
    ? { kicker: "New from the last import", title: n(fresh, "picture") + " to review", action: "Start culling", run: () => void startCull(LAST_IMPORT_CULL) }
    : toReview
      ? { kicker: "Culling", title: n(toReview, "picture") + " to review", action: "Start culling", run: () => void startCull({ review: "unreviewed", order: "oldest" }) }
      : pieces
        ? { kicker: "Next up", title: pieces.title, action: "Open project", run: () => go({ name: "write", id: pieces.id }) }
        : null;

  const rows: Row[] = [];
  if (due) rows.push({ dot: "warn", title: due === 1 ? "1 post is due today" : `${due} posts are due`, sub: "Mark them posted", run: () => go({ name: "posts" }) });
  if (fresh && toReview > fresh) rows.push({ dot: "warn", title: n(toReview, "picture") + " to review in all", run: () => void startCull({ review: "unreviewed", order: "oldest" }) });
  if (ideas) rows.push({ dot: "ok", title: n(ideas, "idea") + " waiting", sub: "Keep, maybe or drop", run: () => go({ name: "ideas" }) });
  if (saves) rows.push({ dot: "ok", title: n(saves, "save") + " to sort", sub: "Inspiration you saved", run: () => go({ name: "inspire" }) });
  if (smart?.burstsUnreviewed) rows.push({ dot: "idle", title: n(smart.burstsUnreviewed, "similar shot") + " to compare", run: () => void startCull({ smart: "bursts", review: "unreviewed", order: "oldest" }) });
  if (pieces && hero?.action !== "Open project") rows.push({ dot: "idle", title: pieces.title, sub: "Your project in progress", run: () => go({ name: "write", id: pieces.id }) });

  return (
    <div className="phone-today">
      <header className="pt-head">
        <h1>Today</h1>
        <p>{hello}, <i>Andy</i></p>
      </header>

      {hero ? (
        <section className="pt-hero">
          <span className="pt-kicker">{hero.kicker}</span>
          <b>{hero.title}</b>
          <button type="button" className="btn primary" onClick={hero.run}>{hero.action}</button>
        </section>
      ) : (
        <section className="pt-hero">
          <b>All clear.</b>
          <span className="pt-kicker">Nothing needs you right now.</span>
        </section>
      )}

      {rows.length > 0 && (
        <section className="pt-list" aria-label="Needs you">
          <h3>Needs you</h3>
          {rows.slice(0, 5).map((r) => (
            <button key={r.title} type="button" className="pt-row" onClick={r.run}>
              <i className={`pt-dot ${r.dot}`} />
              <span className="pt-t">
                {r.title}
                {r.sub && <small>{r.sub}</small>}
              </span>
              <span className="pt-chev" aria-hidden="true">›</span>
            </button>
          ))}
        </section>
      )}

      {link === null ? (
        <div className="pt-quick">
          <button type="button" className="btn" onClick={() => s.openQuickIdea()}>+ New idea</button>
          <button type="button" className="btn" onClick={() => setLink("")}>Save a link</button>
        </div>
      ) : (
        <form className="pt-link" onSubmit={(e) => { e.preventDefault(); void saveLink(); }}>
          <input type="url" inputMode="url" autoFocus placeholder="Paste a link" value={link} onChange={(e) => setLink(e.target.value)} aria-label="Link to save" />
          <button type="submit" className="btn primary">Save</button>
          <button type="button" className="btn" onClick={() => setLink(null)}>Cancel</button>
        </form>
      )}
    </div>
  );
}
