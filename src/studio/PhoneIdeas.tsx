// The phone's Ideas (NIRMATA spec §4.5, Andy 19 Nov: « the ideas is very
// good, but I need an overview »). Three lists under one switch; for ideas an
// overview first (how many new, kept, green-lit, parked: tap one to see them),
// then the ideas themselves, each one tap to open and one tap to decide.
// The desktop keeps Ideas / Inspire / Write.
import { useIdeaMenu } from "../components/menus";
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { studio } from "./api";
import type { Idea, IdeaStatus, Piece, Pillar, Save, Stage } from "./types";

type View = "ideas" | "inspiration" | "projects";
const GROUPS: [IdeaStatus, string][] = [["inbox", "New"], ["keep", "Kept"], ["greenlit", "Green-lit"], ["parked", "Parked"]];
const STAGE: Record<Stage, string> = { planned: "Script", shot: "Footage", editing: "Cut", ready: "Ready to post", posted: "Posted", reviewed: "Reviewed" };

const score = (i: Idea) => {
  const s = [i.scoreHook, i.scoreSend, i.scoreFit, i.scoreEase];
  return s.every((x) => x != null) ? s.reduce((a, b) => (a ?? 0) + (b ?? 0), 0) : null;
};

export function PhoneIdeas({ start = "ideas" }: { start?: View }) {
  const { version, bump, go, openQuickIdea } = useStore();
  const [view, setView] = useState<View>(start);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [saves, setSaves] = useState<Save[]>([]);
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [pillars, setPillars] = useState<Pillar[]>([]);
  const [group, setGroup] = useState<IdeaStatus>("inbox");
  const [open, setOpen] = useState<string | null>(null);
  const ideaMenu = useIdeaMenu();
  useEffect(() => {
    studio.list("ideas").then(setIdeas).catch(() => {});
    studio.list("saves", { status: "inbox" }).then(setSaves).catch(() => {});
    studio.list("pieces").then(setPieces).catch(() => {});
    studio.list("pillars").then(setPillars).catch(() => {});
  }, [version]);

  const pillarName = useMemo(() => new Map(pillars.map((p) => [p.id, p.name])), [pillars]);
  const count = (st: IdeaStatus) => ideas.filter((i) => i.status === st || (st === "keep" && i.status === "maybe")).length;
  const shown = ideas.filter((i) => i.status === group || (group === "keep" && i.status === "maybe"));
  const decide = async (i: Idea, status: IdeaStatus) => {
    await studio.save("ideas", i.id, { status });
    setOpen(null);
    bump();
  };
  const activePieces = pieces.filter((p) => p.stage !== "posted" && p.stage !== "reviewed" && !p.parked);

  return (
    <div className="phone-ideas">
      <header className="pi-head">
        <h1>Projects</h1>
      </header>
      <div className="pl-seg pi-seg" role="group" aria-label="Show">
        {([["ideas", "Ideas"], ["projects", "Making"], ["inspiration", "Saved"]] as [View, string][]).map(([v, label]) => (
          <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>{label}</button>
        ))}
      </div>

      {view === "ideas" && (
        <>
          <div className="pi-tiles" role="group" aria-label="Overview">
            {GROUPS.map(([st, label]) => (
              <button key={st} type="button" className="pi-tile" aria-pressed={group === st} onClick={() => setGroup(st)}>
                <b>{count(st)}</b>
                <span>{label}</span>
              </button>
            ))}
          </div>
          <div className="pi-list">
            {shown.length === 0 && <p className="pl-empty">{group === "inbox" ? "No new ideas. Tap + to add one." : "Nothing here yet."}</p>}
            {shown.map((i) => {
              const sc = score(i);
              const isOpen = open === i.id;
              return (
                <div key={i.id} className={`pi-item${isOpen ? " open" : ""}`}>
                  <button type="button" className="pi-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : i.id)} onContextMenu={(e) => ideaMenu(e, { kind: "idea", row: i })}>
                    <span className="pt-t">
                      {i.title}
                      <small>{[i.pillarId ? pillarName.get(i.pillarId) : null, sc != null ? `score ${sc}/20` : "not scored yet", i.status === "maybe" ? "maybe" : null].filter(Boolean).join(" · ")}</small>
                    </span>
                    <span className="pt-chev" aria-hidden="true">{isOpen ? "⌄" : "›"}</span>
                  </button>
                  {isOpen && (
                    <div className="pi-open">
                      {i.hook && <p className="pi-hook">“{i.hook}”</p>}
                      {i.notes && <p className="pi-notes">{i.notes}</p>}
                      <div className="pi-actions">
                        {i.status !== "keep" && <button type="button" className="btn" onClick={() => void decide(i, "keep")}>Keep</button>}
                        {i.status !== "maybe" && i.status !== "greenlit" && <button type="button" className="btn" onClick={() => void decide(i, "maybe")}>Maybe</button>}
                        {i.status !== "parked" && <button type="button" className="btn" onClick={() => void decide(i, "parked")}>Park</button>}
                        {i.status !== "greenlit" && <button type="button" className="btn primary" onClick={() => void decide(i, "greenlit")}>Green-light</button>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {view === "inspiration" && (
        <div className="pi-list">
          <p className="pi-sub">{saves.length ? `${saves.length} saved, waiting to be sorted` : "Nothing waiting. Save links from the share sheet."}</p>
          {saves.map((sv) => (
            <a key={sv.id} className="pi-row" href={sv.url || undefined} target="_blank" rel="noreferrer">
              <span className="pt-t">
                {sv.title || sv.url || "Saved item"}
                <small>{[sv.platform, sv.author].filter(Boolean).join(" · ")}</small>
              </span>
              <span className="pt-chev" aria-hidden="true">›</span>
            </a>
          ))}
        </div>
      )}

      {view === "projects" && (
        <div className="pi-list">
          {activePieces.length === 0 && <p className="pl-empty">No projects in progress. Green-light an idea to start one.</p>}
          {activePieces.map((p) => (
            <button key={p.id} type="button" className="pi-row" onClick={() => go({ name: "write", id: p.id })} onContextMenu={(e) => ideaMenu(e, { kind: "project", row: p })}>
              <span className="pt-t">
                {p.title}
                <small>{[STAGE[p.stage], p.plannedDate ? `for ${p.plannedDate}` : null].filter(Boolean).join(" · ")}</small>
              </span>
              <span className="pi-step">{STAGE[p.stage]}</span>
            </button>
          ))}
        </div>
      )}

      <button type="button" className="pi-plus" aria-label="New idea" onClick={() => openQuickIdea()}>
        <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}
