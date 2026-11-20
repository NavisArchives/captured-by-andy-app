// Pillars: your three (or more) themes as columns, their families (a series
// or a client campaign) and every piece with its stage. A board view shows
// all pieces by stage. Client campaigns carry their brand job: deliverables,
// dates, revisions, rights and payment, with reminders before rights end.
import { useIdeaMenu } from "../components/menus";
import { useCallback, useState } from "react";
import { errorText } from "../api";
import { Hero, Modal, useToast, Select } from "../components/ui";
import { useStore } from "../store";
import { studio } from "./api";
import { daysUntil } from "./library";
import { PillarSetup, StageChip, useDebounced, useList } from "./shared";
import { STAGES, type BrandJob, type Family, type Piece, type Pillar, type Stage } from "./types";
import { money, totals } from "./money";
import { isoDay } from "./library";

export function Pillars() {
  const toast = useToast();
  const { go } = useStore();
  const [pillars] = useList("pillars");
  const [families] = useList("families");
  const [pieces] = useList("pieces");
  const [jobs] = useList("brandJobs");
  const [view, setView] = useState<"pillars" | "board">("pillars");
  const [jobFor, setJobFor] = useState<Family | null>(null);
  const [archived, setArchived] = useState(false);

  if (pillars && pillars.length === 0) {
    return (
      <div className="studio">
        <Hero title="Pillars" sub="Your themes, their series and campaigns, every piece" />
        <PillarSetup />
      </div>
    );
  }

  const addPillar = async () => {
    try {
      await studio.save("pillars", null, { name: `Pillar ${(pillars?.length ?? 0) + 1}`, position: pillars?.length ?? 0 });
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const openRoot = async () => {
    try {
      await studio.openFolder(await studio.root());
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const move = async (p: Piece, dir: -1 | 1) => {
    const i = STAGES.findIndex((s) => s.id === p.stage);
    const next = STAGES[i + dir];
    if (!next) return;
    try {
      await studio.setStage(p.id, next.id);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };

  return (
    <div className="studio">
      <Hero title="Pillars" italic="& pieces" sub={`${pillars?.length ?? 0} pillars · ${(families ?? []).filter((f) => f.kind !== "singles").length} series and campaigns · ${(pieces ?? []).length} pieces`}>
        <div className="st-tabs" role="group" aria-label="View">
          <button type="button" aria-pressed={view === "pillars"} onClick={() => setView("pillars")}>
            By pillar
          </button>
          <button type="button" aria-pressed={view === "board"} onClick={() => setView("board")}>
            By stage
          </button>
        </div>
        <button type="button" className="btn quiet" onClick={() => void openRoot()}>
          Studio folder
        </button>
        {(pillars?.length ?? 0) < 5 && (
          <button type="button" className="btn quiet" onClick={() => void addPillar()}>
            Add pillar
          </button>
        )}
      </Hero>

      <MoneyLine jobs={jobs ?? []} />
      {view === "board" ? (
        <div className="st-board">
          {STAGES.map((s) => {
            const here = (pieces ?? []).filter((p) => p.stage === s.id);
            return (
              <div key={s.id} className="st-board-col">
                <h3>
                  <span>{s.label}</span>
                  <span>{here.length}</span>
                </h3>
                {here.map((p) => (
                  <div key={p.id} className="st-board-card">
                    <button type="button" className="link" style={{ textAlign: "left", color: "var(--ink)" }} onClick={() => go({ name: "write", id: p.id })}>
                      {p.title}
                    </button>
                    <div className="mv">
                      <span className="meta">{p.code}</span>
                      <span className="st-row" style={{ gap: 4 }}>
                        <button type="button" className="icon-btn" aria-label="Back a stage" disabled={s.id === "planned"} onClick={() => void move(p, -1)}>
                          ‹
                        </button>
                        <button type="button" className="icon-btn" aria-label="Next stage" disabled={s.id === "reviewed"} onClick={() => void move(p, 1)}>
                          ›
                        </button>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="pillar-cols">
          {(pillars ?? []).map((pl) => (
            <PillarColumn
              key={pl.id}
              pillar={pl}
              families={(families ?? []).filter((f) => f.pillarId === pl.id && (archived || !f.archived))}
              pieces={pieces ?? []}
              jobs={jobs ?? []}
              onJob={setJobFor}
            />
          ))}
        </div>
      )}
      <label className="st-row" style={{ gap: 6, fontSize: 13, color: "var(--muted)" }}>
        <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived families
      </label>
      {jobFor && <BrandJobCard family={jobFor} job={(jobs ?? []).find((j) => j.familyId === jobFor.id) ?? null} onClose={() => setJobFor(null)} />}
    </div>
  );
}

function PillarColumn({ pillar, families, pieces, jobs, onJob }: { pillar: Pillar; families: Family[]; pieces: Piece[]; jobs: BrandJob[]; onJob: (f: Family) => void }) {
  const toast = useToast();
  const { go } = useStore();
  const ideaMenu = useIdeaMenu();
  const [name, setName] = useState(pillar.name);
  const [adding, setAdding] = useState<null | { kind: "series" | "campaign"; name: string; client: string }>(null);
  useDebounced(name, (n) => n.trim() && n !== pillar.name && void studio.save("pillars", pillar.id, { name: n.trim() }));
  const add = async () => {
    if (!adding?.name.trim()) return;
    try {
      const f = await studio.save("families", null, { pillarId: pillar.id, kind: adding.kind, name: adding.name.trim(), client: adding.client.trim() });
      await studio.familyFolder(f.id);
      setAdding(null);
      if (adding.kind === "campaign") onJob(f);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const showFolder = async (f: Family) => {
    try {
      await studio.openFolder(await studio.familyFolder(f.id));
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const total = pieces.filter((p) => p.pillarId === pillar.id).length;
  return (
    <div className="pillar-col">
      <div className="pillar-head">
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Pillar name" />
        <span className="meta">
          {pillar.folder || "folder made with its first piece"} · {total} piece{total === 1 ? "" : "s"}
        </span>
      </div>
      {families.map((f) => {
        const own = pieces.filter((p) => p.familyId === f.id);
        const job = jobs.find((j) => j.familyId === f.id);
        const soon = job ? [job.rightsEnd, job.exclusivityEnd, job.paidAdsEnd].filter((d): d is string => !!d).map((d) => daysUntil(d)).filter((n) => n >= 0 && n <= 14) : [];
        return (
          <div key={f.id} className={f.kind === "campaign" ? "family campaign" : "family"}>
            <div className="family-head">
              <b>{f.kind === "campaign" ? `${f.client || f.name} · ${f.name}` : f.name}</b>
              <span className="st-row" style={{ gap: 6 }}>
                {f.code && <span className="st-chip">{f.code}</span>}
                {soon.length > 0 && <span className="st-chip warn">rights end in {Math.min(...soon)} d</span>}
                {job?.invoiceStatus === "sent" && <span className="st-chip warn">invoice unpaid</span>}
              </span>
            </div>
            {own.length === 0 && <span className="meta">No pieces yet</span>}
            {own.map((p) => (
              <button key={p.id} type="button" className="piece-row" onClick={() => go({ name: "write", id: p.id })} onContextMenu={(e) => ideaMenu(e, { kind: "project", row: p })}>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.title} <small>{p.code}</small>
                </span>
                <StageChip stage={p.stage as Stage} />
              </button>
            ))}
            <div className="st-row" style={{ gap: 6 }}>
              <button type="button" className="btn quiet small" onClick={() => void showFolder(f)}>
                Folder
              </button>
              {f.kind === "campaign" && (
                <button type="button" className="btn quiet small" onClick={() => onJob(f)}>
                  Brand job
                </button>
              )}
              {f.kind !== "singles" && (
                <button type="button" className="btn quiet small" onClick={() => void studio.save("families", f.id, { archived: f.archived ? 0 : 1 })}>
                  {f.archived ? "Unarchive" : "Archive"}
                </button>
              )}
            </div>
          </div>
        );
      })}
      {adding ? (
        <div className="family st-col" style={{ gap: 8 }}>
          <span className="meta">{adding.kind === "series" ? "A series: a named format that repeats" : "A client campaign"}</span>
          {adding.kind === "campaign" && <input className="st-input" placeholder="Client" value={adding.client} onChange={(e) => setAdding({ ...adding, client: e.target.value })} />}
          <input className="st-input" autoFocus placeholder={adding.kind === "series" ? "Series name (2–4 words)" : "Campaign name"} value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} onKeyDown={(e) => e.key === "Enter" && void add()} />
          <div className="st-row">
            <button type="button" className="btn primary small" onClick={() => void add()}>
              Add
            </button>
            <button type="button" className="btn quiet small" onClick={() => setAdding(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="st-row">
          <button type="button" className="btn quiet small" onClick={() => setAdding({ kind: "series", name: "", client: "" })}>
            New series
          </button>
          <button type="button" className="btn quiet small" onClick={() => setAdding({ kind: "campaign", name: "", client: "" })}>
            New client campaign
          </button>
        </div>
      )}
    </div>
  );
}

function BrandJobCard({ family, job, onClose }: { family: Family; job: BrandJob | null; onClose: () => void }) {
  const toast = useToast();
  const [v, setV] = useState<Partial<BrandJob>>(() => job ?? { client: family.client || family.name, campaign: family.name, familyId: family.id, invoiceStatus: "none", revisionsUsed: 0 });
  const text = useCallback(
    (k: keyof BrandJob, label: string, placeholder = "", area = false) => (
      <label className="st-field">
        <span>{label}</span>
        {area ? (
          <textarea value={(v[k] as string | null) ?? ""} placeholder={placeholder} onChange={(e) => setV((x) => ({ ...x, [k]: e.target.value }))} />
        ) : (
          <input value={(v[k] as string | null) ?? ""} placeholder={placeholder} onChange={(e) => setV((x) => ({ ...x, [k]: e.target.value }))} />
        )}
      </label>
    ),
    [v],
  );
  const date = (k: keyof BrandJob, label: string) => (
    <label className="st-field">
      <span>{label}</span>
      <input type="date" value={(v[k] as string | null) ?? ""} onChange={(e) => setV((x) => ({ ...x, [k]: e.target.value || null }))} />
    </label>
  );
  const save = async () => {
    try {
      const { id: _id, createdMs: _c, updatedMs: _u, ...values } = v as BrandJob;
      await studio.save("brandJobs", job?.id ?? null, { ...values, familyId: family.id, client: values.client || family.client || family.name });
      toast("Brand job saved");
      onClose();
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  return (
    <Modal
      wide
      title={`${v.client || "Brand"} · ${v.campaign || family.name}`}
      crumb="Brand job"
      onClose={onClose}
      foot={
        <>
          <span className="meta">Rights, exclusivity and paid-ads end dates show on Today two weeks ahead</span>
          <span className="spacer" />
          <button type="button" className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="st-col">
        <div className="st-two">
          {text("client", "Client")}
          {text("campaign", "Campaign")}
        </div>
        {text("deliverables", "Deliverables", "e.g. 2 × 30 s Reels with 3 hook versions each, raw footage, 1 story", true)}
        {text("brief", "Brief (key points, link to the PDF in _DOCS)", "", true)}
        <div className="st-three">
          {date("reviewDate", "First cut due")}
          {date("liveDate", "Go-live")}
          <div className="st-two">
            <label className="st-field">
              <span>Revisions used</span>
              <input type="number" min={0} value={v.revisionsUsed ?? 0} onChange={(e) => setV((x) => ({ ...x, revisionsUsed: Number(e.target.value) || 0 }))} />
            </label>
            <label className="st-field">
              <span>Allowed</span>
              <input type="number" min={0} value={v.revisionsAllowed ?? ""} onChange={(e) => setV((x) => ({ ...x, revisionsAllowed: e.target.value === "" ? null : Number(e.target.value) }))} />
            </label>
          </div>
        </div>
        {text("rights", "Usage rights", "Channels, paid ads (whitelisting / Spark Ads), territory")}
        <div className="st-three">
          {date("rightsEnd", "Usage rights end")}
          {date("exclusivityEnd", "Exclusivity ends")}
          {date("paidAdsEnd", "Paid-ads use ends")}
        </div>
        <div className="money-row">
          <label className="st-field">
            <span>Fee</span>
            <input type="number" min={0} step="any" inputMode="decimal" value={v.amount ?? ""} placeholder={v.fee || "0"} onChange={(e) => setV((x) => ({ ...x, amount: e.target.value === "" ? null : Number(e.target.value) }))} />
          </label>
          <label className="st-field">
            <span>Currency</span>
            <Select value={v.currency ?? "EUR"} onChange={(e) => setV((x) => ({ ...x, currency: e.target.value }))}>
              {["EUR", "USD", "GBP", "CHF", "THB", "AUD"].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </label>
          {text("invoiceNo", "Invoice number")}
          <label className="st-field">
            <span>Invoice</span>
            <Select
              value={v.invoiceStatus ?? "none"}
              onChange={(e) => {
                const status = e.target.value as BrandJob["invoiceStatus"];
                // Sending it starts the clock: today, unless a date is already there.
                setV((x) => ({ ...x, invoiceStatus: status, invoiceSentDate: status !== "none" ? x.invoiceSentDate || isoDay() : x.invoiceSentDate, paidDate: status === "paid" ? x.paidDate || isoDay() : x.paidDate }));
              }}
            >
              <option value="none">Not sent</option>
              <option value="sent">Sent, not paid</option>
              <option value="paid">Paid</option>
            </Select>
          </label>
        </div>
        {v.invoiceStatus !== "none" && v.invoiceStatus != null && (
          <div className="st-three">
            {date("invoiceSentDate", "Invoice sent on")}
            {v.invoiceStatus === "paid" && date("paidDate", "Paid on")}
          </div>
        )}
        {v.fee && v.amount == null && <p className="hint" style={{ margin: 0 }}>Fee written earlier: “{v.fee}”. Type it as a number above to count it in totals.</p>}
        {text("notes", "Notes", "", true)}
      </div>
    </Modal>
  );
}

/** What's owed and what came in this year, from brand jobs with a fee. */
function MoneyLine({ jobs }: { jobs: BrandJob[] }) {
  const t = totals(jobs);
  if (!t.unpaid.length && !t.paidThisYear.length && !t.overdue) return null;
  const list = (xs: [string, number][]) => xs.map(([c, n]) => money(n, c)).join(" + ");
  return (
    <div className="money-line">
      <span className="eyebrow-inline">Money</span>
      {(t.unpaid.length > 0 || t.overdue > 0) && (
        <span>
          {t.unpaid.length > 0 && <><b>{list(t.unpaid)}</b> unpaid</>}
          {t.overdue > 0 && <em>{t.unpaid.length ? " · " : ""}{t.overdue} overdue</em>}
        </span>
      )}
      {t.paidThisYear.length > 0 && (
        <span>
          <b>{list(t.paidThisYear)}</b> paid in {new Date().getFullYear()}
        </span>
      )}
    </div>
  );
}
