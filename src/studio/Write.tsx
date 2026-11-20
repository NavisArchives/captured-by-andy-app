// Production: every project by pillar and series, each one in six steps
// (script, inspiration & style, footage, sound, cut, post), made together
// with Claude through the project's 00_PLAN/project.md. Shoot days batch
// several projects into one shoot.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, imageUrl } from "../api";
import { PhotoPicker } from "../components/PhotoPicker";
import { Hero, useToast, Select } from "../components/ui";
import { useStore } from "../store";
import { newId, studio } from "./api";
import { FORMATS, HOOK_TYPES, KIT, beatsFrom, formatOf, isoDay, shootCard, shotsFrom, wordBudget, words } from "./library";
import { platformName, useDebounced, useList } from "./shared";
import { STAGES, parse, type Beat, type BrandJob, type Brief, type Disclosure, type ExportCheck, type Hook, type Piece, type Posted, type Review, type ShootDay, type Stage } from "./types";
import { CutStep, FootageMarks, InspoStep, ProjectList, SoundStep, StepCard, StepDots } from "./ProductionSteps";
import { dataHash, projectMarkdown, readData, statusOf } from "./production";

import { ProjectMoments } from "./ProjectMoments";

export function Write({ id }: { id?: string }) {
  const { go } = useStore();
  const [pieces] = useList("pieces");
  const [days] = useList("shootDays");
  const [families] = useList("families");
  const [pillars] = useList("pillars");
  const [dayOpen, setDayOpen] = useState<string | null>(null);
  const piece = (pieces ?? []).find((p) => p.id === id) ?? null;
  const famName = (fid: string | null) => {
    const f = (families ?? []).find((x) => x.id === fid);
    return f ? (f.kind === "campaign" ? `${f.client || f.name}` : f.name) : "";
  };
  const pillarName = (pid: string | null) => (pillars ?? []).find((x) => x.id === pid)?.name ?? "";

  if (id && piece) {
    return (
      <div className="studio">
        <Hero
          title={piece.title}
          crumb={<button type="button" onClick={() => go({ name: "write" })}>Production /{pillarName(piece.pillarId) ? ` ${pillarName(piece.pillarId)} /` : ""}{famName(piece.familyId) ? ` ${famName(piece.familyId)} /` : ""}</button>}
          sub={<span className="st-row" style={{ gap: 10 }}>{piece.code} <StepDots brief={parse<Brief>(piece.brief, {})} /></span>}
        />
        <div className="production-page">
          <PieceEditor key={piece.id} piece={piece} days={days ?? []} />
        </div>
      </div>
    );
  }
  return (
    <div className="studio">
      <Hero title="Production" sub={id && pieces ? "That project is gone: here are the others" : "Every project in six steps: script, inspiration & style, footage, sound, cut, post"} />
      <div className="production-layout">
        <div className="write-main">
          <ProjectList pieces={pieces ?? []} pillars={pillars ?? []} families={families ?? []} />
        </div>
        <div className="write-list">
          <ShootDays days={days ?? []} pieces={pieces ?? []} open={dayOpen} setOpen={setDayOpen} />
        </div>
      </div>
    </div>
  );
}

function PieceEditor({ piece, days }: { piece: Piece; days: ShootDay[] }) {
  const toast = useToast();
  const [brief, setBrief] = useState<Brief>(() => parse<Brief>(piece.brief, {}));
  const briefRef = useRef(brief);
  briefRef.current = brief;
  const [title, setTitle] = useState(piece.title);
  const [jobs] = useList("brandJobs");
  const [reviews] = useList("reviews");
  const [media, setMedia] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [confirmFormat, setConfirmFormat] = useState<string | null>(null);
  const savePiece = useCallback((v: Partial<Piece>) => studio.save("pieces", piece.id, v).catch((e) => toast(errorText(e), { error: true })), [piece.id, toast]);
  const [notes, setNotes] = useState(piece.notes);
  useDebounced(title, (t) => t.trim() && t !== piece.title && void savePiece({ title: t.trim() }));
  useDebounced(notes, (n) => n !== piece.notes && void savePiece({ notes: n }));
  useEffect(() => {
    studio.linked("pieceMedia", "a", piece.id).then(setMedia).catch(() => {});
  }, [piece.id]);
  // The clips' file names, for the footage step and project.md.
  const [clipNames, setClipNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!media.length) return;
    api.rows(media).then((rows) => setClipNames(Object.fromEntries(rows.map((r) => [r.id, r.filename])))).catch(() => {});
  }, [media]);

  // ---- 00_PLAN/project.md: the whole project, written on every save. Claude
  // changes its data block in a Claude session; a block that differs from what
  // the app last wrote is Claude's, and is loaded instead of written over.
  const [saves] = useList("saves");
  const [boards] = useList("boards");
  const [pillars] = useList("pillars");
  const [families] = useList("families");
  const ctx = useRef({ piece, saves, boards, pillars, families, clipNames, media, notes });
  ctx.current = { piece, saves, boards, pillars, families, clipNames, media, notes };
  const loaded = useRef(false);
  /** Loads Claude's changes when project.md was changed outside the app; true when it did. */
  const takeFromFile = useCallback(async (b: Brief): Promise<boolean> => {
    const file = await studio.readPlan(piece.id, "project.md").catch(() => null);
    const there = file ? readData(file.contents) : null;
    if (!file || !there) return false;
    const h = dataHash(there);
    if (h === dataHash(b)) return false;
    const changedOutside = b.fileHash ? h !== b.fileHash : file.modifiedMs > piece.updatedMs;
    if (!changedOutside) return false;
    setBrief({ ...there, fileHash: h });
    toast("Loaded the changes made to project.md (Claude's work)");
    return true;
  }, [piece.id, piece.updatedMs, toast]);
  const writeFile = useCallback(async (b: Brief) => {
    if (await takeFromFile(b)) return;
    const c = ctx.current;
    const md = projectMarkdown({ ...c.piece, notes: c.notes }, b, {
      pillar: (c.pillars ?? []).find((x) => x.id === c.piece.pillarId),
      family: (c.families ?? []).find((x) => x.id === c.piece.familyId),
      saves: c.saves ?? [],
      boards: c.boards ?? [],
      clipNames: c.clipNames,
      clipIds: c.media,
    });
    await studio.writePlan(piece.id, "project.md", md);
    const h = dataHash(b);
    if (b.fileHash !== h) setBrief((cur) => (dataHash(cur) === h ? { ...cur, fileHash: h } : cur));
  }, [piece.id, takeFromFile]);
  useDebounced(brief, (b) => {
    void savePiece({ brief: JSON.stringify(b) });
    void writeFile(b).catch((e) => toast(`project.md: ${errorText(e)}`, { error: true }));
  }, 700);
  // Opening the project, and coming back to the window: Claude may have worked on it.
  useEffect(() => {
    const look = () => void takeFromFile(briefRef.current).then((took) => {
      if (!took && !loaded.current) void writeFile(briefRef.current).catch(() => {});
      loaded.current = true;
    });
    // Once the lists the file mentions are in.
    if (saves && boards && pillars && families) look();
    window.addEventListener("focus", look);
    return () => window.removeEventListener("focus", look);
  }, [takeFromFile, writeFile, saves, boards, pillars, families]);
  const set = <K extends keyof Brief>(k: K, v: Brief[K]) => setBrief((b) => ({ ...b, [k]: v }));
  const hooks = brief.hooks ?? [];
  const beats = brief.beats ?? [];
  const shots = brief.shots ?? [];
  const length = brief.lengthS ?? formatOf(brief.template ?? piece.format)?.lengthS ?? 30;
  const spoken = beats.reduce((n, b) => n + words(b.audio), 0);
  const budget = wordBudget(length);
  const platforms = piece.platforms.split(",").filter(Boolean);
  const disclosure = parse<Disclosure>(piece.disclosure, {});
  const posted = parse<Posted[]>(piece.posts, []);
  const review = (reviews ?? []).find((r) => r.pieceId === piece.id) ?? null;
  const job = (jobs ?? []).find((j) => j.id === piece.brandJobId) ?? null;
  const paid = !!piece.isPaid || !!piece.brandJobId;

  const applyFormat = (fid: string) => {
    const f = formatOf(fid);
    if (!f) return;
    setBrief((b) => ({ ...b, template: fid, lengthS: f.lengthS, beats: beatsFrom(f) }));
    void savePiece({ format: fid });
    setConfirmFormat(null);
  };
  const pickFormat = (fid: string) => {
    if (!fid) return;
    if (beats.some((b) => b.visual || b.audio)) setConfirmFormat(fid);
    else applyFormat(fid);
  };
  const setStage = async (s: Stage) => {
    if (s === "ready" && paid && !(disclosure.label && disclosure.tag && disclosure.toggle)) {
      toast("Paid work: tick the three disclosure steps in Post first", { error: true });
      return;
    }
    try {
      await studio.setStage(piece.id, s);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const folder = async () => {
    try {
      const path = await studio.pieceFolder(piece.id);
      await studio.openFolder(path);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };

  // ---- shoot card
  const card = async (send: boolean) => {
    try {
      const day = days.find((d) => d.id === piece.shootDayId);
      const html = shootCard(piece.title, [piece.code, day ? `${day.date} · ${day.location}` : "", brief.location ?? ""].filter(Boolean).join(" · "), [{ piece, brief }], brief.kit ?? {});
      const path = await studio.writePlan(piece.id, "shoot-card.html", html);
      if (send) {
        const r = await api.airdrop([path]);
        toast(r === "sent" ? "Shoot card sent: open it on your phone" : "AirDrop closed", r === "sent" ? undefined : { error: false });
      } else {
        toast("Shoot card saved in 00_PLAN", { action: { label: "Show", run: () => void api.reveal(path) } });
      }
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };

  return (
    <>
      <section className="card st-col">
        <div className="st-row between">
          <input className="st-input" style={{ fontSize: 22, fontWeight: 400, letterSpacing: "-0.02em", flex: 1, minWidth: 240 }} value={title} onChange={(e) => setTitle(e.target.value)} />
          <span className="st-chip accent">{piece.code}</span>
        </div>
        <div className="st-tabs" role="group" aria-label="Stage">
          {STAGES.map((s) => (
            <button key={s.id} type="button" aria-pressed={piece.stage === s.id} onClick={() => void setStage(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="st-three">
          <label className="st-field">
            <span>Posting date</span>
            <input type="date" value={piece.plannedDate ?? ""} onChange={(e) => void savePiece({ plannedDate: e.target.value || null })} />
          </label>
          <label className="st-field">
            <span>Shoot day</span>
            <Select value={piece.shootDayId ?? ""} onChange={(e) => void savePiece({ shootDayId: e.target.value || null })}>
              <option value="">None yet</option>
              {days.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.date} {d.title || d.location}
                </option>
              ))}
            </Select>
          </label>
          <div className="st-field">
            <span>Platforms</span>
            <div className="chipset">
              {["tiktok", "instagram", "youtube"].map((p) => (
                <button
                  key={p}
                  type="button"
                  className="chipbtn"
                  aria-pressed={platforms.includes(p)}
                  onClick={() => void savePiece({ platforms: (platforms.includes(p) ? platforms.filter((x) => x !== p) : [...platforms, p]).join(",") })}
                >
                  {platformName(p)}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="st-row">
          <button type="button" className="btn quiet small" onClick={() => void folder()}>
            Show folder
          </button>
          <button type="button" className="btn quiet small" onClick={() => studio.openCapcut(piece.id).catch((e) => toast(errorText(e), { error: true }))}>
            Open in CapCut
          </button>
          <label className="st-row" style={{ gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={!!piece.parked} onChange={(e) => void savePiece({ parked: e.target.checked ? 1 : 0 })} /> Parked
          </label>
          <label className="st-row" style={{ gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={!!piece.waitingBrand} onChange={(e) => void savePiece({ waitingBrand: e.target.checked ? 1 : 0 })} /> Waiting for the brand
          </label>
          <label className="st-row" style={{ gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={!!piece.isPaid} onChange={(e) => void savePiece({ isPaid: e.target.checked ? 1 : 0 })} /> Paid, gifted or loaned
          </label>
          {piece.folder && <span className="meta" style={{ wordBreak: "break-all" }}>{piece.folder}</span>}
        </div>
      </section>

      <StepCard n={1} id="script" brief={brief} setBrief={set} piece={piece} summary={hooks.find((h) => h.chosen)?.spoken || `${beats.length} beats`}>
      <section className="card st-col">
        <p className="eyebrow" style={{ margin: 0 }}>
          <span>Format and goal</span>
          <span className={spoken > budget ? "budget over" : "budget"}>
            {spoken} / {budget} words for {length} s
          </span>
        </p>
        <div className="st-three">
          <label className="st-field">
            <span>Format template</span>
            <Select value={brief.template ?? piece.format ?? ""} onChange={(e) => pickFormat(e.target.value)}>
              <option value="">Choose…</option>
              {FORMATS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} · {f.lengthS} s
                </option>
              ))}
            </Select>
          </label>
          <label className="st-field">
            <span>Length (seconds)</span>
            <input type="number" min={5} max={600} value={length} onChange={(e) => set("lengthS", Number(e.target.value) || 30)} />
          </label>
          <label className="st-field">
            <span>Call to action</span>
            <input value={brief.cta ?? ""} placeholder="Send this to… / save this / link in bio" onChange={(e) => set("cta", e.target.value)} />
          </label>
        </div>
        {confirmFormat && (
          <p className="warnline">
            Replace your beats with the {formatOf(confirmFormat)?.name} template?{" "}
            <button type="button" className="link" onClick={() => applyFormat(confirmFormat)}>
              Replace
            </button>{" "}
            ·{" "}
            <button type="button" className="link" onClick={() => setConfirmFormat(null)}>
              Keep mine
            </button>
          </p>
        )}
        {formatOf(brief.template)?.hint && <p className="hint">{formatOf(brief.template)?.hint}</p>}
        <div className="st-two">
          <label className="st-field">
            <span>Goal: the one takeaway</span>
            <input value={brief.goal ?? ""} onChange={(e) => set("goal", e.target.value)} />
          </label>
          <label className="st-field">
            <span>For whom</span>
            <input value={brief.audience ?? ""} onChange={(e) => set("audience", e.target.value)} />
          </label>
        </div>
      </section>

      <section className="card st-col">
        <p className="eyebrow" style={{ margin: 0 }}>
          <span>Hooks: write 3 to 5, film the chosen one</span>
          <button type="button" className="link" onClick={() => set("hooks", [...hooks, { id: newId(), spoken: "", text: "", frame: "", type: "", chosen: !hooks.length }])}>
            Add hook
          </button>
        </p>
        <div className="hook-row av-row head" style={{ gridTemplateColumns: "28px minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr) 130px auto" }}>
          <span />
          <span>Spoken line</span>
          <span>On-screen text</span>
          <span>First frame</span>
          <span>Type</span>
          <span />
        </div>
        {hooks.length === 0 && <p className="st-empty">No hooks yet. The first second decides: write a few and pick the strongest.</p>}
        {hooks.map((h, idx) => {
          const upd = (p: Partial<Hook>) => set("hooks", hooks.map((x) => (x.id === h.id ? { ...x, ...p } : p.chosen ? { ...x, chosen: false } : x)));
          return (
            <div key={h.id} className="hook-row">
              <input type="radio" name={`chosen-${piece.id}`} checked={h.chosen} onChange={() => upd({ chosen: true })} title="Film this one" />
              <input value={h.spoken} placeholder={`Hook ${idx + 1}: what you say`} onChange={(e) => upd({ spoken: e.target.value })} />
              <input value={h.text} placeholder="What it says on screen" onChange={(e) => upd({ text: e.target.value })} />
              <input value={h.frame} placeholder="What we see first" onChange={(e) => upd({ frame: e.target.value })} />
              <Select value={h.type} onChange={(e) => upd({ type: e.target.value })}>
                <option value="">Type…</option>
                {HOOK_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </Select>
              <button type="button" className="icon-btn" aria-label="Remove hook" onClick={() => set("hooks", hooks.filter((x) => x.id !== h.id))}>
                ✕
              </button>
            </div>
          );
        })}
      </section>

      <section className="card st-col">
        <p className="eyebrow" style={{ margin: 0 }}>
          <span>Beats: what we see and hear</span>
          <button type="button" className="link" onClick={() => set("beats", [...beats, { id: newId(), visual: "", audio: "", text: "", broll: "", setup: beats[beats.length - 1]?.setup ?? "Main" }])}>
            Add beat
          </button>
        </p>
        <div className="av-table">
          <div className="av-row head">
            <span>#</span>
            <span>Visual</span>
            <span>Spoken (exact words)</span>
            <span>On-screen text</span>
            <span>B-roll</span>
            <span>Setup</span>
            <span />
          </div>
          {beats.length === 0 && <p className="st-empty">Choose a format template above to start from its beats, or add your own.</p>}
          {beats.map((bt, idx) => {
            const upd = (p: Partial<Beat>) => set("beats", beats.map((x) => (x.id === bt.id ? { ...x, ...p } : x)));
            const move = (d: -1 | 1) => {
              const next = [...beats];
              const j = idx + d;
              if (j < 0 || j >= next.length) return;
              [next[idx], next[j]] = [next[j], next[idx]];
              set("beats", next);
            };
            return (
              <div key={bt.id} className="av-row">
                <span className="n">{idx + 1}</span>
                <textarea rows={2} value={bt.visual} onChange={(e) => upd({ visual: e.target.value })} />
                <textarea rows={2} value={bt.audio} onChange={(e) => upd({ audio: e.target.value })} />
                <textarea rows={2} value={bt.text} onChange={(e) => upd({ text: e.target.value })} />
                <textarea rows={2} value={bt.broll} placeholder="comma, separated" onChange={(e) => upd({ broll: e.target.value })} />
                <input value={bt.setup} onChange={(e) => upd({ setup: e.target.value })} />
                <div className="acts">
                  <button type="button" className="icon-btn" aria-label="Move up" onClick={() => move(-1)}>
                    ▲
                  </button>
                  <button type="button" className="icon-btn" aria-label="Move down" onClick={() => move(1)}>
                    ▼
                  </button>
                  <button type="button" className="icon-btn" aria-label="Remove beat" onClick={() => set("beats", beats.filter((x) => x.id !== bt.id))}>
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card st-col">
        <label className="st-field">
          <span>Notes</span>
          <textarea rows={3} value={notes} placeholder="Anything else: the feeling, what it's really about, lines you don't want to lose" onChange={(e) => setNotes(e.target.value)} />
        </label>
      </section>

      <section className="card st-col">
        <p className="eyebrow" style={{ margin: 0 }}>
          <span>Shot list, by setup</span>
          <span className="st-row">
            <button type="button" className="link" onClick={() => set("shots", shotsFrom(beats, shots))}>
              Build from beats
            </button>
            <button type="button" className="link" onClick={() => set("shots", [...shots, { id: newId(), setup: "Main", what: "", framing: "", done: false }])}>
              Add shot
            </button>
          </span>
        </p>
        {shots.length === 0 ? (
          <p className="st-empty">“Build from beats” makes one shot per picture and groups them by setup, so you film everything in one spot at once.</p>
        ) : (
          [...new Set(shots.map((s) => s.setup))].map((setup) => (
            <div key={setup} className="shot-group">
              <h4>{setup}</h4>
              {shots
                .filter((s) => s.setup === setup)
                .map((s) => {
                  const upd = (p: Partial<typeof s>) => set("shots", shots.map((x) => (x.id === s.id ? { ...x, ...p } : x)));
                  return (
                    <div key={s.id} className={s.done ? "shot done" : "shot"}>
                      <input type="checkbox" checked={s.done} onChange={(e) => upd({ done: e.target.checked })} />
                      {s.what ? <span>{s.what}</span> : <input type="text" placeholder="What to film" value={s.what} onChange={(e) => upd({ what: e.target.value })} />}
                      <input type="text" placeholder="Framing / angle" value={s.framing} onChange={(e) => upd({ framing: e.target.value })} />
                      <button type="button" className="icon-btn" aria-label="Remove shot" onClick={() => set("shots", shots.filter((x) => x.id !== s.id))}>
                        ✕
                      </button>
                    </div>
                  );
                })}
            </div>
          ))
        )}
      </section>

      <section className="card st-col">
        <p className="eyebrow" style={{ margin: 0 }}>
          <span>On set</span>
          <span className="st-row">
            <button type="button" className="link" onClick={() => void card(false)}>
              Save shoot card
            </button>
            <button type="button" className="link" onClick={() => void card(true)}>
              Shoot card to phone (AirDrop)
            </button>
          </span>
        </p>
        <div className="st-three">
          <label className="st-field">
            <span>Location and light</span>
            <input value={brief.location ?? ""} onChange={(e) => set("location", e.target.value)} />
          </label>
          <label className="st-field">
            <span>Props and products</span>
            <input value={brief.props ?? ""} onChange={(e) => set("props", e.target.value)} />
          </label>
          <label className="st-field">
            <span>Wardrobe, hair, make-up</span>
            <input value={brief.wardrobe ?? ""} onChange={(e) => set("wardrobe", e.target.value)} />
          </label>
        </div>
        <label className="st-field">
          <span>Sound</span>
          <input value={brief.sound ?? ""} placeholder="Trending sound link, or original audio / voice-over (licensed music for paid work)" onChange={(e) => set("sound", e.target.value)} />
        </label>
        <div className="check-list" style={{ gridTemplateColumns: "1fr 1fr" }}>
          {KIT.map((k) => (
            <label key={k.id}>
              <input type="checkbox" checked={!!brief.kit?.[k.id]} onChange={(e) => set("kit", { ...(brief.kit ?? {}), [k.id]: e.target.checked })} />
              {k.label}
            </label>
          ))}
        </div>
      </section>

      {paid && <BrandBlock brief={brief} set={set} piece={piece} jobs={jobs ?? []} job={job} savePiece={savePiece} />}
      </StepCard>

      <StepCard n={2} id="inspo" brief={brief} setBrief={set} piece={piece} summary={`${(brief.inspo ?? []).length} references`}>
        <InspoStep brief={brief} set={set} />
      </StepCard>

      <StepCard n={3} id="footage" brief={brief} setBrief={set} piece={piece} summary={`${media.length} clips${Object.values(brief.footage ?? {}).some((m) => m.level) ? " · some need levelling" : ""}`}>

      <section className="card st-col">
        <p className="eyebrow" style={{ margin: 0 }}>
          <span>Your clips and photos</span>
          <button type="button" className="link" onClick={() => setPicking(true)}>
            Add from library
          </button>
        </p>
        {media.length === 0 ? (
          <p className="st-empty">Attach the clips from your library that belong to this piece (B-roll, takes, stills). Footage in this piece's folder shows up in the library once the Studio folder is in Pictures (Settings › Studio).</p>
        ) : (
          <div className="media-strip">
            {media.map((mid) => (
              <div key={mid} className="m">
                <img src={imageUrl("thumb", mid)} alt="" />
                <button
                  type="button"
                  aria-label="Remove from this piece"
                  onClick={async () => {
                    await studio.link("pieceMedia", piece.id, mid, false);
                    setMedia((m) => m.filter((x) => x !== mid));
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <ProjectMoments pieceId={piece.id} title={piece.title} ids={media} />
      <FootageMarks brief={brief} set={set} ids={media} names={clipNames} />
      </StepCard>

      <StepCard n={4} id="sound" brief={brief} setBrief={set} piece={piece} summary={`${(brief.sounds ?? []).length} sounds${(brief.sounds ?? []).some((x) => !x.licensed) ? " · not all licensed" : ""}`}>
        <SoundStep piece={piece} brief={brief} set={set} />
      </StepCard>

      <StepCard n={5} id="cut" brief={brief} setBrief={set} piece={piece} summary={brief.edit?.lastRead ? `${brief.edit.lastRead.clips.length} clips, ${brief.edit.lastRead.duration.toFixed(1)} s` : brief.edit?.fcpxml ? "Draft ready" : undefined}>
        <CutStep piece={piece} brief={brief} set={set} />
      </StepCard>

      <StepCard n={6} id="post" brief={brief} setBrief={set} piece={piece} summary={posted.length ? `Posted ${posted.length}×` : undefined}>
      {(brief.sounds ?? []).some((x) => !x.licensed) && (
        <p className="warnline">Step 4 has sounds that aren't marked licensed: don't post this until every one is licensed or swapped.</p>
      )}
      {statusOf(brief, "cut") !== "done" && <p className="hint">The cut (step 5) isn't marked done yet.</p>}
      <PostBlock piece={piece} brief={brief} set={set} paid={paid} disclosure={disclosure} posted={posted} savePiece={savePiece} />
      {(piece.stage === "posted" || piece.stage === "reviewed" || review) && <ReviewBlock piece={piece} review={review} />}
      </StepCard>

      {picking && (
        <PhotoPicker
          title="Clips and photos for this piece"
          initial={media}
          onClose={() => setPicking(false)}
          onPick={async (ids) => {
            setPicking(false);
            for (const pid of ids) if (!media.includes(pid)) await studio.link("pieceMedia", piece.id, pid, true).catch(() => {});
            for (const pid of media) if (!ids.includes(pid)) await studio.link("pieceMedia", piece.id, pid, false).catch(() => {});
            setMedia(ids);
            toast(`${ids.length} attached`);
          }}
        />
      )}
    </>
  );
}

function BrandBlock({ brief, set, piece, jobs, job, savePiece }: { brief: Brief; set: <K extends keyof Brief>(k: K, v: Brief[K]) => void; piece: Piece; jobs: BrandJob[]; job: BrandJob | null; savePiece: (v: Partial<Piece>) => unknown }) {
  const brand = brief.brand ?? {};
  const upd = (p: Partial<NonNullable<Brief["brand"]>>) => set("brand", { ...brand, ...p });
  return (
    <section className="card st-col" style={{ borderColor: "color-mix(in srgb, var(--amber) 40%, var(--line-soft))" }}>
      <p className="eyebrow" style={{ margin: 0 }}>
        <span>Brand block</span>
        <span>stay within the approved claims</span>
      </p>
      <div className="st-two">
        <label className="st-field">
          <span>Brand job</span>
          <Select value={piece.brandJobId ?? ""} onChange={(e) => void savePiece({ brandJobId: e.target.value || null })}>
            <option value="">None</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.client}
                {j.campaign ? ` · ${j.campaign}` : ""}
              </option>
            ))}
          </Select>
        </label>
        <label className="st-field">
          <span>Product</span>
          <input value={brand.product ?? ""} onChange={(e) => upd({ product: e.target.value })} />
        </label>
      </div>
      <div className="st-two">
        <label className="st-field">
          <span>Key messages (up to three)</span>
          <textarea value={brand.messages ?? ""} onChange={(e) => upd({ messages: e.target.value })} />
        </label>
        <label className="st-field">
          <span>Approved claims (word for word)</span>
          <textarea value={brand.claims ?? ""} onChange={(e) => upd({ claims: e.target.value })} />
        </label>
      </div>
      <div className="st-two">
        <label className="st-field">
          <span>Must-haves</span>
          <textarea value={brand.musts ?? ""} placeholder="Logo on screen, code, link…" onChange={(e) => upd({ musts: e.target.value })} />
        </label>
        <label className="st-field">
          <span>Don'ts</span>
          <textarea value={brand.donts ?? ""} onChange={(e) => upd({ donts: e.target.value })} />
        </label>
      </div>
      {job && (
        <p className="hint">
          {job.client}: {job.deliverables || "deliverables not filled in"} · review {job.reviewDate || "–"} · live {job.liveDate || "–"} · revisions {job.revisionsUsed}/{job.revisionsAllowed ?? "–"}
        </p>
      )}
    </section>
  );
}

function PostBlock({
  piece,
  brief,
  set,
  paid,
  disclosure,
  posted,
  savePiece,
}: {
  piece: Piece;
  brief: Brief;
  set: <K extends keyof Brief>(k: K, v: Brief[K]) => void;
  paid: boolean;
  disclosure: Disclosure;
  posted: Posted[];
  savePiece: (v: Partial<Piece>) => unknown;
}) {
  const toast = useToast();
  const [check, setCheck] = useState<ExportCheck | null>(null);
  const [platform, setPlatform] = useState(piece.platforms.split(",").filter(Boolean)[0] ?? "instagram");
  const [url, setUrl] = useState("");
  const caption = brief.caption ?? "";
  const labelled = /^\s*(advertentie|publiciteit|reclame|publicité|publicite)\b/i.test(caption);
  const tick = (k: keyof Disclosure, v: boolean) => void savePiece({ disclosure: JSON.stringify({ ...disclosure, [k]: v }) });
  useEffect(() => {
    if (paid && labelled && !disclosure.label) tick("label", true);
  }, [paid, labelled]); // eslint-disable-line react-hooks/exhaustive-deps

  const chooseExport = async () => {
    const folder = piece.folder ? `${piece.folder}/04_EXPORTS` : undefined;
    const path = await openDialog({ title: "Choose the export to post", defaultPath: folder, filters: [{ name: "Video", extensions: ["mp4", "mov", "m4v"] }] });
    if (typeof path !== "string") return;
    set("exportPath", path);
    try {
      setCheck(await studio.checkExport(path));
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const copyCaption = async () => {
    const text = [caption, brief.hashtags].filter(Boolean).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      toast("Caption and hashtags copied");
    } catch {
      toast("Couldn't copy: select the caption and press ⌘C", { error: true });
    }
  };
  const send = async () => {
    if (!brief.exportPath) return;
    try {
      const r = await api.airdrop([brief.exportPath]);
      if (r === "sent") toast("Sent to your phone: post it from the app, then mark it posted here");
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const markPosted = async () => {
    if (paid && !(disclosure.label && disclosure.tag && disclosure.toggle)) {
      toast("Paid work: tick the three disclosure steps first", { error: true });
      return;
    }
    try {
      await studio.markPosted(piece.id, platform, url.trim(), brief.exportPath ?? null);
      setUrl("");
      toast(`Marked posted on ${platformName(platform)}${brief.exportPath ? "; the posted file is kept in 05_POSTED" : ""}`);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };

  return (
    <section className="card st-col">
      <p className="eyebrow" style={{ margin: 0 }}>
        <span>Post</span>
        <span>post from your phone: trending sounds and labels stay available</span>
      </p>
      <label className="st-field">
        <span>Caption {paid && <em style={{ color: "var(--amber)", fontStyle: "normal" }}>· start with “Advertentie” or “Publiciteit”</em>}</span>
        <textarea value={caption} placeholder="Hook, value, call to action" onChange={(e) => set("caption", e.target.value)} />
      </label>
      <div className="st-two">
        <label className="st-field">
          <span>Hashtags (3–5)</span>
          <input value={brief.hashtags ?? ""} onChange={(e) => set("hashtags", e.target.value)} />
        </label>
        <label className="st-field">
          <span>Cover text (inside the 3:4 crop)</span>
          <input value={brief.cover ?? ""} onChange={(e) => set("cover", e.target.value)} />
        </label>
      </div>
      <div className="st-row">
        <button type="button" className="btn quiet small" onClick={() => void chooseExport()}>
          {brief.exportPath ? "Choose another export" : "Choose the export…"}
        </button>
        <button type="button" className="btn quiet small" disabled={!caption && !brief.hashtags} onClick={() => void copyCaption()}>
          Copy caption
        </button>
        <button type="button" className="btn quiet small" disabled={!brief.exportPath} onClick={() => void send()}>
          AirDrop to phone
        </button>
        {brief.exportPath && <span className="meta" style={{ wordBreak: "break-all" }}>{brief.exportPath.split("/").pop()}</span>}
      </div>
      {check && (
        <div className="hint">
          {check.width}×{check.height} · {Math.round(check.seconds)} s · {check.megabytes.toFixed(0)} MB
          {check.notes.length === 0 ? " · fits Reels and TikTok" : ""}
          {check.notes.length > 0 && (
            <ul className="notes-list">
              {check.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {paid && (
        <div className="check">
          <h3 style={{ margin: 0, fontSize: 14.5 }}>Paid, gifted or loaned: the Belgian disclosure</h3>
          <div className="check-list">
            <label>
              <input type="checkbox" checked={!!disclosure.label} onChange={(e) => tick("label", e.target.checked)} />
              The caption (or an overlay) starts with “Advertentie” or “Publiciteit”, visible without “more”. #ad, sponsored or gifted are not enough.
            </label>
            <label>
              <input type="checkbox" checked={!!disclosure.tag} onChange={(e) => tick("tag", e.target.checked)} />
              The brand is tagged at the start of the caption.
            </label>
            <label>
              <input type="checkbox" checked={!!disclosure.toggle} onChange={(e) => tick("toggle", e.target.checked)} />
              The platform's label is on: Instagram “Paid partnership”, TikTok's commercial content toggle.
            </label>
          </div>
          <p className="meta" style={{ margin: 0 }}>FOD Economie and the VRM (Flanders) want all three on every video, Stories too. Not legal advice.</p>
        </div>
      )}
      <div className="st-row">
        <Select className="st-input" style={{ width: 150 }} value={platform} onChange={(e) => setPlatform(e.target.value)}>
          {["instagram", "tiktok", "youtube"].map((p) => (
            <option key={p} value={p}>
              {platformName(p)}
            </option>
          ))}
        </Select>
        <input className="st-input" style={{ flex: 1, minWidth: 200 }} placeholder="Link to the post (optional)" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button type="button" className="btn primary" onClick={() => void markPosted()}>
          Mark posted
        </button>
      </div>
      {posted.length > 0 && (
        <div className="st-list">
          {posted.map((p, i) => (
            <div key={i} className="st-item">
              <span className="st-dot" />
              <span style={{ minWidth: 0 }}>
                <span className="t">
                  {platformName(p.platform)} · {new Date(p.at).toLocaleDateString()}
                </span>
                <small>{p.url || p.file || "no link"}</small>
              </span>
              <span className="st-chip accent">posted</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ReviewBlock({ piece, review }: { piece: Piece; review: Review | null }) {
  const toast = useToast();
  const [v, setV] = useState<Partial<Review>>(() => review ?? { platform: piece.platforms.split(",")[0] ?? "" });
  const num = (k: keyof Review, label: string, step = 1) => (
    <label className="st-field">
      <span>{label}</span>
      <input type="number" step={step} value={(v[k] as number | null | undefined) ?? ""} onChange={(e) => setV((x) => ({ ...x, [k]: e.target.value === "" ? null : Number(e.target.value) }))} />
    </label>
  );
  const save = async () => {
    try {
      const values = { pieceId: piece.id, platform: v.platform ?? "", views: v.views ?? null, watchTime: v.watchTime ?? null, skipRate: v.skipRate ?? null, sends: v.sends ?? null, saves: v.saves ?? null, follows: v.follows ?? null, learning: v.learning ?? "" };
      await studio.save("reviews", review?.id ?? null, values);
      if (piece.stage !== "reviewed") await studio.setStage(piece.id, "reviewed");
      toast("Review saved");
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  return (
    <section className="card st-col">
      <p className="eyebrow" style={{ margin: 0 }}>
        <span>7-day review</span>
        <span>numbers from the platform's insights</span>
      </p>
      <div className="st-three">
        {num("views", "Views")}
        {num("watchTime", "Average watch time (s)", 0.1)}
        {num("skipRate", "Skip rate (%)", 0.1)}
        {num("sends", "Sends")}
        {num("saves", "Saves")}
        {num("follows", "Follows")}
      </div>
      <label className="st-field">
        <span>One line: what did you learn?</span>
        <input value={v.learning ?? ""} onChange={(e) => setV((x) => ({ ...x, learning: e.target.value }))} />
      </label>
      <div className="st-row">
        <button type="button" className="btn primary" onClick={() => void save()}>
          Save review
        </button>
      </div>
    </section>
  );
}

function ShootDays({ days, pieces, open, setOpen }: { days: ShootDay[]; pieces: Piece[]; open: string | null; setOpen: (id: string | null) => void }) {
  const toast = useToast();
  const [date, setDate] = useState(isoDay());
  const [loc, setLoc] = useState("");
  const add = async () => {
    try {
      const d = await studio.save("shootDays", null, { date, location: loc.trim(), title: "" });
      setLoc("");
      setOpen(d.id);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const dayCard = async (d: ShootDay, send: boolean) => {
    const items = pieces.filter((p) => p.shootDayId === d.id).map((p) => ({ piece: p, brief: parse<Brief>(p.brief, {}) }));
    if (!items.length) return toast("No pieces on this day yet: pick it as the shoot day in a piece's brief");
    try {
      const kit = items[0].brief.kit ?? {};
      const html = shootCard(`Shoot day ${d.date}`, [d.location, `${items.length} pieces`].filter(Boolean).join(" · "), items, kit);
      const path = await studio.writePlan(null, `${d.date}-shoot-day.html`, html);
      if (send) {
        const r = await api.airdrop([path]);
        if (r === "sent") toast("Shoot day card sent to your phone");
      } else toast("Shoot day card saved in Studio › _CARDS", { action: { label: "Show", run: () => void api.reveal(path) } });
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const upcoming = useMemo(() => [...days].sort((a, b) => a.date.localeCompare(b.date)), [days]);
  return (
    <div className="card tight st-col" style={{ marginTop: 10 }}>
      <p className="eyebrow" style={{ margin: 0 }}>Shoot days</p>
      <div className="st-row">
        <input className="st-input" type="date" style={{ width: 150 }} value={date} onChange={(e) => setDate(e.target.value)} />
        <input className="st-input" style={{ flex: 1, minWidth: 90 }} placeholder="Where" value={loc} onChange={(e) => setLoc(e.target.value)} />
        <button type="button" className="btn quiet small" onClick={() => void add()}>
          Add
        </button>
      </div>
      {upcoming.map((d) => {
        const on = pieces.filter((p) => p.shootDayId === d.id);
        return (
          <div key={d.id} className="st-col" style={{ gap: 6 }}>
            <button type="button" className={open === d.id ? "st-item on" : "st-item"} onClick={() => setOpen(open === d.id ? null : d.id)}>
              <span className="st-dot" style={{ background: "var(--amber)" }} />
              <span style={{ minWidth: 0 }}>
                <span className="t">{d.date}</span>
                <small>{d.location || "no place yet"}</small>
              </span>
              <span className="st-chip">{on.length}</span>
            </button>
            {open === d.id && (
              <div className="st-col" style={{ gap: 6, paddingLeft: 8 }}>
                {on.map((p) => (
                  <span key={p.id} className="meta">
                    {p.code} {p.title}
                  </span>
                ))}
                <div className="st-row">
                  <button type="button" className="btn quiet small" onClick={() => void dayCard(d, false)}>
                    Save card
                  </button>
                  <button type="button" className="btn quiet small" onClick={() => void dayCard(d, true)}>
                    Card to phone
                  </button>
                  <button type="button" className="btn danger small" onClick={() => void studio.remove("shootDays", d.id)}>
                    Delete
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
