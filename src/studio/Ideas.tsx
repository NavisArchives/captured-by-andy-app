// Ideas (in Inspire's Library): one line is enough. New ones wait under New; "Sort ideas" goes
// through them like culling (Y keep, M maybe, N park). Each idea gets a
// pillar, a family, a format and a score; green-lighting it makes the piece
// and its folder, ready to write.
import { useAsk, useIdeaMenu } from "../components/menus";
import { useMenu } from "../components/ContextMenu";
import { restoreDeleted, SectionMore, useRecentlyDeleted } from "../components/RecentlyDeleted";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "../api";
import { Hero, Modal, useToast, Select } from "../components/ui";
import { useStore } from "../store";
import { saveThumb, studio } from "./api";
import { FORMATS, formatName } from "./library";
import { ScoreEditor, Verdict, platformName, useDebounced, useList } from "./shared";
import { score, type Family, type Idea, type IdeaStatus, type Pillar } from "./types";

type Tab = "inbox" | "kept" | "greenlit" | "parked";
const TABS: { id: Tab; label: string; statuses: IdeaStatus[] }[] = [
  { id: "inbox", label: "New", statuses: ["inbox"] },
  { id: "kept", label: "Kept", statuses: ["keep", "maybe"] },
  { id: "greenlit", label: "Green-lit", statuses: ["greenlit"] },
  { id: "parked", label: "Parked", statuses: ["parked", "dropped"] },
];

const PROJECT_KINDS: ("idea" | "project")[] = ["idea", "project"];

/** Ideas as their own tab, between Inspire and Production. */
export function Ideas() {
  const { openQuickIdea } = useStore();
  const { open } = useMenu();
  const recently = useRecentlyDeleted(PROJECT_KINDS, "Projects");
  return (
    <div
      className="studio"
      onContextMenu={(e) => {
        // Empty space on Projects: what can be made here.
        if ((e.target as HTMLElement).closest(".idea-card, button, a, input, textarea, select")) return;
        open(e, { header: "Projects", items: [{ label: "New idea", hint: "⌘N", run: () => openQuickIdea() }, ...recently.menu] });
      }}
    >
      <Hero title="Ideas" sub="Score them, green-light the best: a green-lit idea becomes a project in Production">
        <SectionMore label="Projects" items={[recently.item]} />
      </Hero>
      <IdeasPanel />
    </div>
  );
}

/** The ideas, as a panel (its own tab, and Inspire's Library). */
export function IdeasPanel() {
  const toast = useToast();
  const { openQuickIdea } = useStore();
  const [ideas] = useList("ideas");
  const [pillars] = useList("pillars");
  const [families] = useList("families");
  const [tab, setTab] = useState<Tab>("inbox");
  const [picked, setPicked] = useState<string | null>(null);
  const ideaMenu = useIdeaMenu();
  const [sorting, setSorting] = useState(false);
  const [voice, setVoice] = useState(false);

  useEffect(() => {
    studio.parkStale(60).then((n) => n && toast(`${n} idea${n > 1 ? "s" : ""} untouched for 60 days moved to Parked`)).catch(() => {});
  }, [toast]);

  const statuses = TABS.find((t) => t.id === tab)!.statuses;
  const shown = (ideas ?? []).filter((i) => statuses.includes(i.status));
  const count = (t: Tab) => (ideas ?? []).filter((i) => TABS.find((x) => x.id === t)!.statuses.includes(i.status)).length;
  const byPillar = useMemo(() => {
    const cols: { pillar: Pillar | null; ideas: Idea[] }[] = (pillars ?? []).map((p) => ({ pillar: p, ideas: shown.filter((i) => i.pillarId === p.id) }));
    const loose = shown.filter((i) => !i.pillarId || !(pillars ?? []).some((p) => p.id === i.pillarId));
    if (loose.length || !cols.length) cols.push({ pillar: null, ideas: loose });
    return cols;
  }, [shown, pillars]);
  const current = (ideas ?? []).find((i) => i.id === picked) ?? null;

  return (
    <>
      <div className="st-row between" style={{ marginBottom: 12 }}>
        <div className="chipset" role="group" aria-label="Ideas">
          {TABS.map((t) => (
            <button key={t.id} type="button" className="chipbtn" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label} · {count(t.id)}
            </button>
          ))}
        </div>
        <div className="st-row">
          <button type="button" className="btn quiet small" onClick={() => setVoice(true)}>Say an idea</button>
          {count("inbox") > 0 && <button type="button" className="btn quiet small" onClick={() => setSorting(true)}>Sort new ideas</button>}
          <button type="button" className="btn primary small" onClick={() => openQuickIdea()}>New idea <kbd style={{ background: "transparent", color: "inherit", borderColor: "currentColor" }}>⌘N</kbd></button>
        </div>
      </div>
      <div className="st-split">
        <div>
          {ideas && shown.length === 0 ? (
            <p className="st-empty">
              {tab === "inbox" ? "No new ideas. Press ⌘N anywhere, say one, or turn a save into an idea." : "Nothing here yet."}
            </p>
          ) : (
            <div className="idea-cols">
              {byPillar.map(({ pillar, ideas: list }) => (
                <div key={pillar?.id ?? "none"} className="idea-col">
                  <h3>
                    <span>{pillar?.name ?? "No pillar yet"}</span>
                    <span>{list.length}</span>
                  </h3>
                  {list.map((i) => (
                    <button key={i.id} type="button" className={i.id === picked ? "idea-card on" : "idea-card"} onClick={() => setPicked(i.id === picked ? null : i.id)} onContextMenu={(e) => ideaMenu(e, { kind: "idea", row: i })}>
                      <b>{i.title}</b>
                      {i.hook && <span className="hook">“{i.hook}”</span>}
                      <div className="st-row">
                        <Verdict total={score(i)} />
                        {i.format && <span className="st-chip">{formatName(i.format)}</span>}
                        {i.deadline && <span className="st-chip warn">by {i.deadline}</span>}
                        {i.source === "voice" && <span className="st-chip">spoken</span>}
                      </div>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
        <aside className="st-side">
          {current ? (
            <IdeaDetail key={current.id} idea={current} pillars={pillars ?? []} families={families ?? []} onGone={() => setPicked(null)} />
          ) : (
            <section className="card">
              <p className="eyebrow">Score an idea in four</p>
              <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6, color: "var(--ink-2)", fontSize: 13.5 }}>
                <li><b>Hook</b>: does the first line stop the scroll?</li>
                <li><b>Would they send it</b>: Instagram ranks Reels on sends.</li>
                <li><b>Fit</b>: your pillar, your voice.</li>
                <li><b>Ease</b>: can you film it this week?</li>
              </ul>
              <p className="hint" style={{ marginTop: 12 }}>15 or more: write it. 10–14: rework. Under 10: park it. Ideas untouched for 60 days park themselves.</p>
            </section>
          )}
        </aside>
      </div>
      {sorting && <Sorter ideas={(ideas ?? []).filter((i) => i.status === "inbox")} onClose={() => setSorting(false)} />}
      {voice && <VoiceIdea pillars={pillars ?? []} onClose={() => setVoice(false)} />}
    </>
  );
}

function IdeaDetail({ idea, pillars, families, onGone }: { idea: Idea; pillars: Pillar[]; families: Family[]; onGone: () => void }) {
  const toast = useToast();
  const ask = useAsk();
  const { bump } = useStore();
  const { go } = useStore();
  const [title, setTitle] = useState(idea.title);
  const [hook, setHook] = useState(idea.hook);
  const [notes, setNotes] = useState(idea.notes);
  const [saves, setSaves] = useState<string[]>([]);
  const [allSaves] = useList("saves");
  const [newFamily, setNewFamily] = useState<null | { kind: "series" | "campaign"; name: string; client: string }>(null);
  useEffect(() => {
    studio.linked("saveIdea", "b", idea.id).then(setSaves).catch(() => {});
  }, [idea.id]);
  const patch = useCallback((v: Partial<Idea>) => studio.save("ideas", idea.id, v).catch((e) => toast(errorText(e), { error: true })), [idea.id, toast]);
  useDebounced(title, (v) => v.trim() && v !== idea.title && void patch({ title: v.trim() }));
  useDebounced(hook, (v) => v !== idea.hook && void patch({ hook: v }));
  useDebounced(notes, (v) => v !== idea.notes && void patch({ notes: v }));
  const fams = families.filter((f) => f.pillarId === idea.pillarId && !f.archived);
  const platforms = idea.platforms.split(",").filter(Boolean);
  const togglePlatform = (p: string) => void patch({ platforms: (platforms.includes(p) ? platforms.filter((x) => x !== p) : [...platforms, p]).join(",") });

  const greenlight = async () => {
    try {
      const piece = await studio.greenlight(idea.id, idea.familyId);
      toast(`Green-lit: ${piece.code}, folder made in Studio`, { action: { label: "Show folder", run: () => piece.folder && void studio.openFolder(piece.folder) } });
      go({ name: "write", id: piece.id });
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const addFamily = async () => {
    if (!newFamily || !newFamily.name.trim() || !idea.pillarId) return;
    try {
      const f = await studio.save("families", null, { pillarId: idea.pillarId, kind: newFamily.kind, name: newFamily.name.trim(), client: newFamily.client.trim() });
      await patch({ familyId: f.id });
      setNewFamily(null);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };

  return (
    <section className="card st-col">
      <label className="st-field">
        <span>Idea</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="st-field">
        <span>First line (hook)</span>
        <input value={hook} placeholder="The line that stops the scroll" onChange={(e) => setHook(e.target.value)} />
      </label>
      <div className="st-two">
        <label className="st-field">
          <span>Pillar</span>
          <Select value={idea.pillarId ?? ""} onChange={(e) => void patch({ pillarId: e.target.value || null, familyId: null })}>
            <option value="">Choose…</option>
            {pillars.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="st-field">
          <span>Family</span>
          <Select
            value={idea.familyId ?? ""}
            disabled={!idea.pillarId}
            onChange={(e) => (e.target.value === "+series" || e.target.value === "+campaign" ? setNewFamily({ kind: e.target.value.slice(1) as "series" | "campaign", name: "", client: "" }) : void patch({ familyId: e.target.value || null }))}
          >
            <option value="">Single piece</option>
            {fams.map((f) => (
              <option key={f.id} value={f.id}>
                {f.kind === "campaign" ? `${f.client || f.name} · ${f.name}` : f.name}
              </option>
            ))}
            <option value="+series">New series…</option>
            <option value="+campaign">New client campaign…</option>
          </Select>
        </label>
      </div>
      {newFamily && (
        <div className="card tight st-col" style={{ gap: 8, background: "var(--soft-2)" }}>
          <span className="meta">{newFamily.kind === "series" ? "A series: a named format that repeats (2–4 words)" : "A client campaign: its brief, rights and invoice live with it"}</span>
          {newFamily.kind === "campaign" && <input className="st-input" placeholder="Client (e.g. ZEB)" value={newFamily.client} onChange={(e) => setNewFamily({ ...newFamily, client: e.target.value })} />}
          <input className="st-input" autoFocus placeholder={newFamily.kind === "series" ? "e.g. Three-product routines" : "Campaign (e.g. Autumn launch)"} value={newFamily.name} onChange={(e) => setNewFamily({ ...newFamily, name: e.target.value })} onKeyDown={(e) => e.key === "Enter" && void addFamily()} />
          <div className="st-row">
            <button type="button" className="btn primary small" onClick={() => void addFamily()}>
              Add
            </button>
            <button type="button" className="btn quiet small" onClick={() => setNewFamily(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="st-two">
        <label className="st-field">
          <span>Format</span>
          <Select value={idea.format} onChange={(e) => void patch({ format: e.target.value })}>
            <option value="">Later</option>
            {FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="st-field">
          <span>Deadline or trend expiry</span>
          <input type="date" value={idea.deadline ?? ""} onChange={(e) => void patch({ deadline: e.target.value || null })} />
        </label>
      </div>
      <div className="chipset">
        {["tiktok", "instagram", "youtube"].map((p) => (
          <button key={p} type="button" className="chipbtn" aria-pressed={platforms.includes(p)} onClick={() => togglePlatform(p)}>
            {platformName(p)}
            {p === "youtube" ? " (later)" : ""}
          </button>
        ))}
      </div>
      <div>
        <div className="st-row between" style={{ marginBottom: 8 }}>
          <span className="eyebrow" style={{ margin: 0 }}>Score</span>
          <Verdict total={score(idea)} />
        </div>
        <ScoreEditor idea={idea} onChange={(p) => void patch(p)} />
      </div>
      <label className="st-field">
        <span>Notes</span>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      {saves.length > 0 && (
        <div className="media-strip">
          {saves.map((id) => {
            const s = (allSaves ?? []).find((x) => x.id === id);
            return s ? (
              <div key={id} className="m" title={s.title}>
                {saveThumb(s.thumb) ? <img src={saveThumb(s.thumb)} alt="" /> : <span className="meta" style={{ padding: 6, display: "block" }}>{s.platform}</span>}
              </div>
            ) : null;
          })}
        </div>
      )}
      <div className="st-row">
        {idea.status === "greenlit" ? (
          <button type="button" className="btn primary" onClick={() => idea.pieceId && go({ name: "write", id: idea.pieceId })}>
            Open its brief
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={!idea.pillarId} title={idea.pillarId ? "Make the piece and its folder" : "Choose a pillar first"} onClick={() => void greenlight()}>
            Green-light
          </button>
        )}
        {idea.status !== "keep" && idea.status !== "greenlit" && (
          <button type="button" className="btn quiet" onClick={() => void patch({ status: "keep" })}>
            Keep
          </button>
        )}
        {idea.status !== "parked" && idea.status !== "greenlit" && (
          <button type="button" className="btn quiet" onClick={() => void patch({ status: "parked" })}>
            Park
          </button>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="btn danger small"
          onClick={async () => {
            if (!(await ask("Delete this idea?", `« ${idea.title} » goes to Recently deleted for 30 days.`, "Delete idea"))) return;
            try {
              await studio.remove("ideas", idea.id, "menu");
              toast(`« ${idea.title} » moved to Recently deleted`, { action: { label: "Undo", run: () => void restoreDeleted("idea", idea.id).then(() => bump(), (e) => toast(errorText(e), { error: true })) } });
              onGone();
            } catch (e) {
              toast(errorText(e), { error: true });
            }
          }}
        >
          Delete
        </button>
      </div>
    </section>
  );
}

/** Going through new ideas one at a time, with the keys from culling. */
function Sorter({ ideas, onClose }: { ideas: Idea[]; onClose: () => void }) {
  const queue = useRef(ideas).current;
  const [i, setI] = useState(0);
  const [done, setDone] = useState<string[]>([]);
  const idea = queue[i];
  const decide = useCallback(
    async (status: IdeaStatus) => {
      if (!idea) return;
      await studio.save("ideas", idea.id, { status }).catch(() => {});
      setDone((d) => [...d, status]);
      setI((n) => n + 1);
    },
    [idea],
  );
  const decideRef = useRef(decide);
  decideRef.current = decide;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (k === "escape") return onClose();
      if (k === "y" || k === "k" || k === "a") void decideRef.current("keep");
      else if (k === "m") void decideRef.current("maybe");
      else if (k === "n" || k === "p" || k === "x") void decideRef.current("parked");
      else if (k === "arrowleft") setI((n) => Math.max(0, n - 1));
      else if (k === "arrowright" || k === " ") setI((n) => Math.min(queue.length, n + 1));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, queue.length]);
  return (
    <div className="triage">
      <div className="triage-top">
        <b>Sort ideas</b>
        <span className="meta">
          {Math.min(i + 1, queue.length)} of {queue.length}
        </span>
        <span className="spacer" />
        <button type="button" className="btn quiet" onClick={onClose}>
          Done <kbd>Esc</kbd>
        </button>
      </div>
      {idea ? (
        <div className="triage-card">
          <span className="meta">{formatName(idea.format)}</span>
          <h2>{idea.title}</h2>
          {idea.hook && <div className="hook">“{idea.hook}”</div>}
          <div className="triage-keys">
            <button type="button" className="btn primary" onClick={() => void decide("keep")}>
              <kbd>Y</kbd> Keep
            </button>
            <button type="button" className="btn quiet" onClick={() => void decide("maybe")}>
              <kbd>M</kbd> Maybe
            </button>
            <button type="button" className="btn quiet" onClick={() => void decide("parked")}>
              <kbd>N</kbd> Park
            </button>
          </div>
          <span className="meta">← → to move without deciding</span>
        </div>
      ) : (
        <div className="triage-card">
          <h2>All sorted</h2>
          <div className="hook">
            {done.filter((d) => d === "keep").length} kept · {done.filter((d) => d === "maybe").length} maybe · {done.filter((d) => d === "parked").length} parked
          </div>
          <div className="triage-keys">
            <button type="button" className="btn primary" onClick={onClose}>
              Back to ideas
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Say an idea out loud (English, on this Mac); it becomes an idea card. */
function VoiceIdea({ pillars, onClose }: { pillars: Pillar[]; onClose: () => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pillarId, setPillarId] = useState("");
  useEffect(() => {
    let off: (() => void) | undefined;
    let live = true;
    listen<{ text: string; listening: boolean; problem: string | null }>("dictation", (e) => {
      setText(e.payload.text);
      if (e.payload.problem) setProblem(e.payload.problem);
    }).then((u) => (live ? (off = u) : u()));
    invoke("dictate_start")
      .then(() => setListening(true))
      .catch((e) => setProblem(errorText(e)));
    return () => {
      live = false;
      off?.();
      invoke("dictate_stop").catch(() => {});
    };
  }, []);
  const stop = async () => {
    try {
      const final = await invoke<string>("dictate_stop");
      if (final) setText(final);
    } catch (e) {
      setProblem(errorText(e));
    }
    setListening(false);
  };
  const save = async () => {
    const t = text.trim();
    if (!t) return;
    const [first, ...rest] = t.split(/(?<=[.!?])\s+/);
    try {
      await studio.save("ideas", null, { title: first.slice(0, 140), notes: rest.join(" "), source: "voice", pillarId: pillarId || null, platforms: "tiktok,instagram" });
      toast("Spoken idea saved");
      onClose();
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  return (
    <Modal
      title="Say an idea"
      crumb="English · heard on this Mac, never recorded"
      onClose={onClose}
      foot={
        <>
          {listening ? (
            <button type="button" className="btn quiet" onClick={() => void stop()}>
              Stop listening
            </button>
          ) : (
            <span className="meta">Edit the words if needed</span>
          )}
          <span className="spacer" />
          <button type="button" className="btn primary" disabled={!text.trim()} onClick={() => void save()}>
            Save idea
          </button>
        </>
      }
    >
      <div className="st-col">
        <div className="st-row">
          <span className={listening ? "dot d-ok" : "dot d-idle"} />
          <span className="meta">{listening ? "Listening… talk, then press Stop" : "Not listening"}</span>
        </div>
        {problem && <p className="warnline">{problem}</p>}
        <textarea className="st-input" style={{ minHeight: 140, fontSize: 16 }} value={text} placeholder="Your idea appears here as you speak" onChange={(e) => setText(e.target.value)} />
        <label className="st-field">
          <span>Pillar</span>
          <Select value={pillarId} onChange={(e) => setPillarId(e.target.value)}>
            <option value="">Later</option>
            {pillars.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
      </div>
    </Modal>
  );
}
