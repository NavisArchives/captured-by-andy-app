// Roadmap: a season of work as a career plan. The plan in phases, every option
// found (clients, stays, tourism, volunteering, grants, moments, selling the
// work), the dates that matter, what to sort before flying, and what only Andy
// can answer. Each option takes his call (yes / talk / not now / done) and a
// note, so the two of us can discuss it here.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorText } from "../api";
import { Hero, useToast } from "../components/ui";
import { useDebounced } from "./shared";
import { LANES, ROADMAP, type Lane, type Option } from "./roadmapData";

type Say = "yes" | "talk" | "no" | "done";
type Mine = {
  say: Record<string, Say>;
  notes: Record<string, string>;
  ticks: Record<string, boolean>;
  answers: Record<string, string>;
};
const EMPTY: Mine = { say: {}, notes: {}, ticks: {}, answers: {} };
const KEY = "roadmap.sample";

const SAYS: { id: Say; label: string }[] = [
  { id: "yes", label: "Yes, go" },
  { id: "talk", label: "Talk about it" },
  { id: "no", label: "Not now" },
  { id: "done", label: "Done" },
];
const SAY_DOT: Record<Say, string> = {
  yes: "var(--green)",
  talk: "var(--amber)",
  no: "var(--idle)",
  done: "var(--ink-2)",
};
const ODDS = {
  strong: "good odds",
  fair: "fair odds",
  long: "long shot",
} as const;
const ODDS_TONE = { strong: "accent", fair: "warn", long: "bad" } as const;
const EFFORT = {
  light: "light lift",
  medium: "some work",
  heavy: "big lift",
} as const;

type View = "plan" | "options" | "calendar" | "fly" | "you";
type Filter = "all" | "picks" | "open" | Say;

/** Andy's calls and notes, kept in the app's settings. */
function useMine() {
  const toast = useToast();
  const [mine, setMine] = useState<Mine | null>(null);
  useEffect(() => {
    api
      .getSetting(KEY)
      .then((v) => setMine(v ? { ...EMPTY, ...(JSON.parse(v) as Partial<Mine>) } : EMPTY))
      .catch(() => setMine(EMPTY));
  }, []);
  const save = useCallback(
    (m: Mine | null) => {
      if (m) api.setSetting(KEY, JSON.stringify(m)).catch((e) => toast(errorText(e), { error: true }));
    },
    [toast],
  );
  useDebounced(mine, save, 400);
  return [mine ?? EMPTY, setMine as (f: (m: Mine | null) => Mine) => void, mine !== null] as const;
}

function fmtDate(iso: string) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
function daysFrom(iso: string) {
  return Math.round((new Date(`${iso}T12:00:00`).getTime() - Date.now()) / 86_400_000);
}

export function Roadmap() {
  const [mine, update, ready] = useMine();
  const [view, setView] = useState<View>("plan");
  const [lane, setLane] = useState<Lane | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(ROADMAP.options.find((o) => o.pick)?.id ?? ROADMAP.options[0]?.id ?? null);

  const say = (id: string, s: Say) =>
    update((m) => {
      const base = m ?? EMPTY;
      const next = { ...base.say };
      if (next[id] === s) delete next[id];
      else next[id] = s;
      return { ...base, say: next };
    });
  const setField = (field: "notes" | "answers", id: string, text: string) =>
    update((m) => {
      const base = m ?? EMPTY;
      return { ...base, [field]: { ...base[field], [id]: text } };
    });
  const tick = (id: string) =>
    update((m) => {
      const base = m ?? EMPTY;
      return { ...base, ticks: { ...base.ticks, [id]: !base.ticks[id] } };
    });

  const byId = useMemo(() => new Map(ROADMAP.options.map((o) => [o.id, o])), []);
  const counts = useMemo(() => {
    const c = { yes: 0, talk: 0, no: 0, done: 0 } as Record<Say, number>;
    for (const o of ROADMAP.options) {
      const s = mine.say[o.id];
      if (s) c[s] += 1;
    }
    return c;
  }, [mine.say]);
  const shown = ROADMAP.options.filter((o) => {
    if (lane && o.lane !== lane) return false;
    const s = mine.say[o.id];
    if (filter === "picks") return !!o.pick;
    if (filter === "open") return !s;
    if (filter !== "all") return s === filter;
    return true;
  });
  const open = openId ? (byId.get(openId) ?? null) : null;
  const jump = (id: string) => {
    setLane(null);
    setFilter("all");
    setOpenId(id);
    setView("options");
  };
  const dated = ROADMAP.options.filter((o) => o.date).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  const asked = ROADMAP.questions.filter((q) => !(mine.answers[q.id] ?? "").trim()).length;

  return (
    <div className="studio roadmap">
      <Hero
        title="Roadmap"
        italic="sample"
        sub={
          <>
            <span>How the trip pays for itself</span>
            <span className="meta">research of {fmtDate(ROADMAP.updated)}</span>
          </>
        }
      />

      {view === "plan" && (
        <section className="panel rm-brief">
          <p className="eyebrow">
            <span>Where we stand</span>
            <span>
              {ROADMAP.options.length} options · {ROADMAP.options.filter((o) => o.pick).length} first picks
            </span>
          </p>
          {ROADMAP.brief.map((p, i) => (
            <p key={i} className={i === 0 ? "rm-para lead" : "rm-para"}>
              {p}
            </p>
          ))}
        </section>
      )}

      <div className="st-row between">
        <div className="st-tabs" role="tablist">
          {(
            [
              ["plan", "The plan", null],
              ["options", "Options", ROADMAP.options.length],
              ["calendar", "Calendar", dated.length],
              ["fly", "Before you fly", ROADMAP.checklist.filter((c) => !mine.ticks[c.id]).length],
              ["you", "Questions for you", asked],
            ] as const
          ).map(([id, label, n]) => (
            <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)}>
              {label}
              {n !== null && <span className="n">{n}</span>}
            </button>
          ))}
        </div>
        <span className="meta">{ready ? `${counts.yes} yes · ${counts.talk} to talk about · ${counts.done} done` : "loading your notes…"}</span>
      </div>

      {view === "plan" && (
        <div className="rm-phases">
          {ROADMAP.phases.map((ph, i) => (
            <section key={ph.id} className="card rm-phase">
              <p className="eyebrow">
                <span>
                  {String(i + 1).padStart(2, "0")} · {ph.when}
                </span>
              </p>
              <h2 className="rm-h">{ph.title}</h2>
              <p className="rm-line">{ph.line}</p>
              <ol className="rm-steps">
                {ph.steps.map((st, k) => {
                  const o = st.option ? byId.get(st.option) : undefined;
                  const s = o ? mine.say[o.id] : undefined;
                  return (
                    <li key={k}>
                      {o ? (
                        <button type="button" className="rm-step" onClick={() => jump(o.id)}>
                          <span
                            className="st-dot"
                            style={{
                              background: s ? SAY_DOT[s] : "var(--line)",
                            }}
                          />
                          <span>{st.text}</span>
                        </button>
                      ) : (
                        <span className="rm-step plain">
                          <span
                            className="st-dot"
                            style={{
                              background: "transparent",
                              border: "1px solid var(--line)",
                            }}
                          />
                          <span>{st.text}</span>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}

      {view === "options" && (
        <>
          <div className="st-col" style={{ gap: 8 }}>
            <div className="chipset">
              <button type="button" className="chipbtn" aria-pressed={lane === null} onClick={() => setLane(null)}>
                Everything
              </button>
              {LANES.map((l) => {
                const n = ROADMAP.options.filter((o) => o.lane === l.id).length;
                if (!n) return null;
                return (
                  <button
                    key={l.id}
                    type="button"
                    className="chipbtn"
                    aria-pressed={lane === l.id}
                    title={l.line}
                    onClick={() => setLane(lane === l.id ? null : l.id)}
                  >
                    {l.label}{" "}
                    <span className="mono" style={{ opacity: 0.6 }}>
                      {n}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="chipset">
              {(
                [
                  ["all", "All"],
                  ["picks", "My first picks"],
                  ["open", "Not decided"],
                  ["yes", "Yes"],
                  ["talk", "To talk about"],
                  ["no", "Not now"],
                  ["done", "Done"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" className="chipbtn" aria-pressed={filter === id} onClick={() => setFilter(id)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="st-split rm-split">
            <div className="st-col">
              {LANES.filter((l) => shown.some((o) => o.lane === l.id)).map((l) => (
                <section key={l.id} className="st-col" style={{ gap: 6 }}>
                  <h6 className="h">
                    {l.label} <span style={{ textTransform: "none", letterSpacing: 0 }}>· {l.line}</span>
                  </h6>
                  <div className="st-list">
                    {shown
                      .filter((o) => o.lane === l.id)
                      .map((o) => {
                        const s = mine.say[o.id];
                        return (
                          <button key={o.id} type="button" className={`st-item${openId === o.id ? " on" : ""}`} onClick={() => setOpenId(o.id)}>
                            <span
                              className="st-dot"
                              style={{
                                background: s ? SAY_DOT[s] : "transparent",
                                border: s ? 0 : "1px solid var(--line)",
                              }}
                            />
                            <span style={{ minWidth: 0 }}>
                              <span className="t">
                                {o.title}
                                {o.pick && <span className="rm-pick"> · first pick</span>}
                              </span>
                              <small>{o.what}</small>
                            </span>
                            <span className={`st-chip ${ODDS_TONE[o.odds]}`}>{ODDS[o.odds]}</span>
                          </button>
                        );
                      })}
                  </div>
                </section>
              ))}
              {shown.length === 0 && <p className="st-empty">Nothing here with these filters.</p>}
            </div>
            <aside className="st-side">{open ? <Detail o={open} mine={mine} say={say} note={(t) => setField("notes", open.id, t)} /> : null}</aside>
          </div>
        </>
      )}

      {view === "calendar" && (
        <section className="card">
          <p className="eyebrow">
            <span>Dates that matter</span>
            <span>deadlines and moments, soonest first</span>
          </p>
          <div className="rm-cal">
            {dated.map((o, i) => {
              const month = new Date(`${o.date}T12:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
              const prev =
                i > 0
                  ? new Date(`${dated[i - 1].date}T12:00:00`).toLocaleDateString("en-GB", {
                      month: "long",
                      year: "numeric",
                    })
                  : null;
              const d = daysFrom(o.date!);
              const s = mine.say[o.id];
              return (
                <div key={o.id} className="rm-cal-block">
                  {month !== prev && <h6 className="h rm-month">{month}</h6>}
                  <button type="button" className={`rm-cal-row${d < 0 ? " past" : ""}`} onClick={() => jump(o.id)}>
                    <span className="rm-cal-day mono">{new Date(`${o.date}T12:00:00`).getDate()}</span>
                    <span style={{ minWidth: 0 }}>
                      <span className="t">{o.title}</span>
                      <small>
                        {o.dateLabel ?? "Date"} · {LANES.find((l) => l.id === o.lane)?.label}
                      </small>
                    </span>
                    <span className="st-row" style={{ gap: 6 }}>
                      {s && <span className="st-chip">{SAYS.find((x) => x.id === s)?.label}</span>}
                      <span className={`st-chip${d >= 0 && d <= 30 ? " warn" : ""}`}>{d < 0 ? "passed" : d === 0 ? "today" : `in ${d} d`}</span>
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {view === "fly" && (
        <section className="card">
          <p className="eyebrow">
            <span>Before you fly</span>
            <span>longest lead time first</span>
          </p>
          <div className="st-list">
            {ROADMAP.checklist.map((c) => (
              <label key={c.id} className={`st-item rm-check${mine.ticks[c.id] ? " ticked" : ""}`}>
                <input type="checkbox" checked={!!mine.ticks[c.id]} onChange={() => tick(c.id)} />
                <span style={{ minWidth: 0 }}>
                  <span className="t rm-wrap">{c.text}</span>
                </span>
                <span className="st-chip">{c.lead}</span>
              </label>
            ))}
          </div>
        </section>
      )}

      {view === "you" && (
        <section className="card">
          <p className="eyebrow">
            <span>Questions for you</span>
            <span>only you know these; they sharpen the plan</span>
          </p>
          <div className="st-col" style={{ gap: 14 }}>
            {ROADMAP.questions.map((q) => (
              <label key={q.id} className="st-field">
                <span>{q.ask}</span>
                <small className="rm-why">{q.why}</small>
                <textarea rows={2} value={mine.answers[q.id] ?? ""} onChange={(e) => setField("answers", q.id, e.target.value)} />
              </label>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Detail({ o, mine, say, note }: { o: Option; mine: Mine; say: (id: string, s: Say) => void; note: (t: string) => void }) {
  const s = mine.say[o.id];
  const lane = LANES.find((l) => l.id === o.lane);
  return (
    <section className="card rm-detail">
      <p className="eyebrow">
        <span>{lane?.label}</span>
        {o.pick && <span>first pick</span>}
      </p>
      <h2 className="rm-h">{o.title}</h2>
      <p className="rm-para">{o.what}</p>
      <div className="st-row" style={{ gap: 6 }}>
        <span className={`st-chip ${ODDS_TONE[o.odds]}`}>{ODDS[o.odds]}</span>
        <span className="st-chip">{EFFORT[o.effort]}</span>
        {o.date && (
          <span className="st-chip">
            {o.dateLabel ?? "Date"}: {fmtDate(o.date)}
          </span>
        )}
      </div>
      <h6 className="h">Why you</h6>
      <p className="rm-para">{o.why}</p>
      <h6 className="h">What you get</h6>
      <p className="rm-para">{o.gives}</p>
      <h6 className="h">How</h6>
      <ol className="rm-how">
        {o.how.map((h, i) => (
          <li key={i}>{h}</li>
        ))}
      </ol>
      {o.links.length > 0 && (
        <>
          <h6 className="h">Sources and contacts</h6>
          <div className="rm-links">
            {o.links.map((l) => (
              <button key={l.href} type="button" className="link" title={l.href} onClick={() => void api.openLink(l.href).catch(() => {})}>
                {l.label} ↗
              </button>
            ))}
          </div>
        </>
      )}
      <h6 className="h">Your call</h6>
      <div className="chipset">
        {SAYS.map((x) => (
          <button key={x.id} type="button" className="chipbtn" aria-pressed={s === x.id} onClick={() => say(o.id, x.id)}>
            {x.label}
          </button>
        ))}
      </div>
      <label className="st-field">
        <span>Your thoughts</span>
        <textarea rows={3} placeholder="What you think, who you know, what worries you" value={mine.notes[o.id] ?? ""} onChange={(e) => note(e.target.value)} />
      </label>
    </section>
  );
}
