// Studio's home: the next piece to make, what waits, what posts this week,
// what needs a review, brand dates coming up, and three saves from the past.
import { useEffect, useMemo, useState } from "react";
import { errorText } from "../api";
import { Hero, useToast } from "../components/ui";
import { useStore } from "../store";
import { studio } from "./api";
import { daysUntil, greeting, isoDay, upcomingMoments } from "./library";
import { PillarSetup, SaveTile, StageChip, useList } from "./shared";
import type { Piece, Save, Summary } from "./types";
import { invoiceLine } from "./money";

export function Today() {
  const { go, studioVersion, openQuickIdea } = useStore();
  const toast = useToast();
  const [pillars] = useList("pillars");
  const [pieces] = useList("pieces");
  const [saves] = useList("saves");
  const [jobs] = useList("brandJobs");
  const [days] = useList("shootDays");
  const [reviews] = useList("reviews");
  const [sum, setSum] = useState<Summary | null>(null);
  useEffect(() => {
    studio.summary().then(setSum).catch(() => {});
  }, [studioVersion]);
  // Ideas nobody touched for 60 days step aside (never deleted).
  useEffect(() => {
    studio.parkStale(60).then((n) => n && toast(`${n} idea${n > 1 ? "s" : ""} untouched for 60 days moved to Parked`)).catch(() => {});
  }, [toast]);

  const today = isoDay();
  const live = (pieces ?? []).filter((p) => !p.parked);
  const dayOf = (p: Piece) => (days ?? []).find((d) => d.id === p.shootDayId)?.date ?? null;
  const next = useMemo(() => {
    const todo = live.filter((p) => p.stage === "planned" || p.stage === "shot" || p.stage === "editing");
    return todo.sort((a, b) => (dayOf(a) ?? a.plannedDate ?? "9999").localeCompare(dayOf(b) ?? b.plannedDate ?? "9999"))[0];
  }, [live, days]); // eslint-disable-line react-hooks/exhaustive-deps
  const week = live
    .filter((p) => p.plannedDate && p.plannedDate >= today && daysUntil(p.plannedDate) <= 7 && p.stage !== "posted" && p.stage !== "reviewed")
    .sort((a, b) => (a.plannedDate ?? "").localeCompare(b.plannedDate ?? ""));
  const reviewed = new Set((reviews ?? []).map((r) => r.pieceId));
  const due = live.filter((p) => p.stage === "posted" && !reviewed.has(p.id) && Date.now() - p.updatedMs >= 7 * 86_400_000);
  const shootDays = (days ?? []).filter((d) => d.date >= today).slice(0, 3);
  const alerts = (jobs ?? []).flatMap((j) => {
    const out: { id: string; text: string; tone: "warn" | "bad" }[] = [];
    const check = (date: string | null, what: string) => {
      if (!date) return;
      const n = daysUntil(date);
      if (n >= 0 && n <= 14) out.push({ id: `${j.id}${what}`, text: `${j.client}: ${what} ends in ${n} day${n === 1 ? "" : "s"} (${date})`, tone: n <= 3 ? "bad" : "warn" });
    };
    check(j.rightsEnd, "usage rights");
    check(j.exclusivityEnd, "exclusivity");
    check(j.paidAdsEnd, "paid-ads use");
    if (j.invoiceStatus === "sent") {
      const line = invoiceLine(j);
      out.push({ id: `${j.id}inv`, text: line.overdue ? `${line.text} · overdue` : line.text, tone: line.overdue ? "bad" : "warn" });
    }
    return out;
  });
  // Three older saves to look at again, a different three every day.
  const resurfaced = useMemo(() => {
    const old = (saves ?? []).filter((s) => s.kind !== "note" && s.status !== "archived" && Date.now() - s.createdMs > 14 * 86_400_000);
    const seed = Number(today.replace(/-/g, ""));
    return old
      .map((s, i) => ({ s, k: (seed * (i + 7)) % 997 }))
      .sort((a, b) => a.k - b.k)
      .slice(0, 3)
      .map((x) => x.s);
  }, [saves, today]);
  const moments = upcomingMoments();

  if (pillars && pillars.length === 0) {
    return (
      <div className="studio">
        <Hero title={greeting()} italic="Andy" sub="Studio: from saved inspiration to a posted video" />
          <PillarSetup />
      </div>
    );
  }

  const openPiece = (p: Piece) => go({ name: "write", id: p.id });
  const capcut = (p: Piece) => studio.openCapcut(p.id).catch((e) => toast(errorText(e), { error: true }));

  return (
    <div className="studio">
      <Hero title={greeting()} italic="Andy" sub={sum ? <span className="mono">{sum.root}</span> : undefined}>
        <button type="button" className="btn quiet" onClick={() => openQuickIdea()}>
          New idea <kbd>⌘N</kbd>
        </button>
        <button type="button" className="btn primary" onClick={() => go({ name: "inspire" })}>
          Save inspiration
        </button>
      </Hero>
      <div className="grid-2">
        <section className="panel">
          <p className="eyebrow">
            <span>Next up</span>
            {next && <StageChip stage={next.stage} />}
          </p>
          {next ? (
            <div className="st-col">
              <div className="big" style={{ fontSize: 28 }}>{next.title}</div>
              <span className="meta">
                {next.code ? `${next.code} · ` : ""}
                {dayOf(next) ? `shoot day ${dayOf(next)}` : next.plannedDate ? `posting ${next.plannedDate}` : "no date yet"}
              </span>
              <div className="st-row">
                <button type="button" className="btn primary" onClick={() => openPiece(next)}>
                  Open brief
                </button>
                <button type="button" className="btn quiet" onClick={() => void capcut(next)}>
                  Open in CapCut
                </button>
              </div>
            </div>
          ) : (
            <div className="st-col">
              <div className="big" style={{ fontSize: 26 }}>Nothing to film yet</div>
              <span style={{ color: "var(--ink-2)", fontSize: 14 }}>Green-light an idea and it lands here with its folder ready.</span>
              <div className="st-row">
                <button type="button" className="btn primary" onClick={() => go({ name: "ideas" })}>
                  Go to ideas
                </button>
              </div>
            </div>
          )}
        </section>
        <div className="st-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <button type="button" className="card" style={{ textAlign: "left", color: "inherit" }} onClick={() => go({ name: "ideas" })}>
            <p className="eyebrow">Ideas waiting</p>
            <div className="big">{sum?.ideasInbox ?? "–"}</div>
            <span className="meta">{sum ? `${sum.ideasKept} kept for later` : ""}</span>
          </button>
          <button type="button" className="card" style={{ textAlign: "left", color: "inherit" }} onClick={() => go({ name: "inspire" })}>
            <p className="eyebrow">Saves to sort</p>
            <div className="big">{sum?.savesInbox ?? "–"}</div>
            <span className="meta">new in Inspiration</span>
          </button>
          <button type="button" className="card" style={{ textAlign: "left", color: "inherit" }} onClick={() => go({ name: "pillars" })}>
            <p className="eyebrow">In progress</p>
            <div className="big">{sum ? sum.toFilm + sum.inProgress : "–"}</div>
            <span className="meta">{sum ? `${sum.toFilm} to film · ${sum.inProgress} shot or editing` : ""}</span>
          </button>
          <button type="button" className="card" style={{ textAlign: "left", color: "inherit" }} onClick={() => go({ name: "posts" })}>
            <p className="eyebrow">Ready to post</p>
            <div className="big">{sum?.ready ?? "–"}</div>
            <span className="meta">publish kit in Production</span>
          </button>
        </div>
      </div>

      <div className="grid-3">
        <section className="card">
          <p className="eyebrow">
            <span>Posting this week</span>
            <span>{week.length}</span>
          </p>
          {week.length ? (
            <div className="st-list">
              {week.map((p) => (
                <button key={p.id} type="button" className="st-item" onClick={() => openPiece(p)}>
                  <span className="st-dot" />
                  <span style={{ minWidth: 0 }}>
                    <span className="t">{p.title}</span>
                    <small>{p.plannedDate}</small>
                  </span>
                  <StageChip stage={p.stage} />
                </button>
              ))}
            </div>
          ) : (
            <p className="st-empty">Give a piece a posting date in Production and it shows here.</p>
          )}
          {shootDays.length > 0 && (
            <>
              <p className="eyebrow" style={{ marginTop: 16 }}>Shoot days</p>
              <div className="st-list">
                {shootDays.map((d) => (
                  <button key={d.id} type="button" className="st-item" onClick={() => go({ name: "write" })}>
                    <span className="st-dot" style={{ background: "var(--amber)" }} />
                    <span style={{ minWidth: 0 }}>
                      <span className="t">{d.title || "Shoot day"}</span>
                      <small>
                        {d.date}
                        {d.location ? ` · ${d.location}` : ""}
                      </small>
                    </span>
                    <span className="st-chip">{(pieces ?? []).filter((p) => p.shootDayId === d.id).length} pieces</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </section>
        <section className="card">
          <p className="eyebrow">
            <span>Needs you</span>
            <span>{due.length + alerts.length}</span>
          </p>
          {due.length + alerts.length === 0 ? (
            <p className="st-empty">No reviews due and no brand dates coming up.</p>
          ) : (
            <div className="st-list">
              {due.map((p) => (
                <button key={p.id} type="button" className="st-item" onClick={() => openPiece(p)}>
                  <span className="st-dot" />
                  <span style={{ minWidth: 0 }}>
                    <span className="t">Review: {p.title}</span>
                    <small>posted over a week ago · six numbers and one lesson</small>
                  </span>
                  <span className="st-chip accent">7-day</span>
                </button>
              ))}
              {alerts.map((a) => (
                <button key={a.id} type="button" className="st-item" onClick={() => go({ name: "pillars" })}>
                  <span className="st-dot" style={{ background: a.tone === "bad" ? "var(--red)" : "var(--amber)" }} />
                  <span style={{ minWidth: 0 }}>
                    <span className="t">{a.text}</span>
                  </span>
                  <span className={`st-chip ${a.tone}`}>brand</span>
                </button>
              ))}
            </div>
          )}
        </section>
        <section className="card">
          <p className="eyebrow">
            <span>Coming up</span>
            <span>start in time</span>
          </p>
          <div className="st-list">
            {moments.map((m) => (
              <button
                key={m.name + m.date.toISOString()}
                type="button"
                className="st-item"
                onClick={() => openQuickIdea({ title: `${m.name}: ` })}
                title="Turn into an idea"
              >
                <span className="st-dot" style={{ background: "var(--idle)" }} />
                <span style={{ minWidth: 0 }}>
                  <span className="t">{m.name}</span>
                  <small>{m.idea}</small>
                </span>
                <span className="st-chip">{Math.max(0, daysUntil(m.date))} d</span>
              </button>
            ))}
          </div>
        </section>
      </div>

      {resurfaced.length > 0 && (
        <section className="card">
          <p className="eyebrow">
            <span>From your saves</span>
            <button type="button" className="link" onClick={() => go({ name: "inspire" })}>
              Open Inspiration
            </button>
          </p>
          <div className="st-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
            {resurfaced.map((s: Save) => (
              <SaveTile key={s.id} save={s} onClick={() => go({ name: "inspire" })} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
