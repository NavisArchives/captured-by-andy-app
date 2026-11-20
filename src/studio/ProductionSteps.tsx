// Production's pieces: the project list with each project's six steps as
// dots, the step card, and steps 2 (inspiration & style), 4 (sound) and
// 5 (cut). Step 1 is the brief and step 6 the post block (in Write.tsx).
import { useIdeaMenu } from "../components/menus";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, errorText } from "../api";
import { Modal, useToast } from "../components/ui";
import { useStore } from "../store";
import { newId, saveThumb, studio } from "./api";
import { askClaude, compareCuts, readCut, statusOf, turnOf } from "./production";
import { StageChip } from "./shared";
import { STEPS, STEP_STATUS, parse, type Board, type Brief, type CutRead, type Family, type Piece, type PieceFile, type Pillar, type Save, type SoundItem, type StepId, type StepStatus, type StyleSheet } from "./types";
import "./production.css";

type SetBrief = <K extends keyof Brief>(k: K, v: Brief[K]) => void;

// ------------------------------------------------------------------ dots and the step card

export function StepDots({ brief }: { brief: Brief }) {
  return (
    <span className="step-dots" aria-label="Steps">
      {STEPS.map((s, i) => {
        const st = statusOf(brief, s.id);
        return <i key={s.id} className={`sd ${st}`} title={`${i + 1}. ${s.label}: ${STEP_STATUS.find((x) => x.id === st)?.label}`} />;
      })}
    </span>
  );
}

export function StepCard({ n, id, brief, setBrief, piece, summary, children }: { n: number; id: StepId; brief: Brief; setBrief: SetBrief; piece: Piece; summary?: ReactNode; children: ReactNode }) {
  const toast = useToast();
  const status = statusOf(brief, id);
  const key = `production.open.${piece.id}.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      if (v != null) return v === "1";
    } catch {
      /* private mode */
    }
    return status !== "done";
  });
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(key, o ? "0" : "1");
      } catch {
        /* private mode */
      }
      return !o;
    });
  };
  const setStatus = (s: StepStatus) => setBrief("steps", { ...(brief.steps ?? {}), [id]: s });
  const handOver = async () => {
    setStatus("claude");
    try {
      await navigator.clipboard.writeText(askClaude(piece, id));
      toast("With Claude: the ask is copied, paste it in a Claude session");
    } catch {
      toast(askClaude(piece, id));
    }
  };
  const label = STEPS.find((s) => s.id === id)?.label ?? id;
  return (
    <section className={`card st-col step-card ${status}`} aria-label={`Step ${n}: ${label}`}>
      <div className="step-head">
        <button type="button" className="step-title" aria-expanded={open} onClick={toggle}>
          <span className={`step-n ${status}`}>{status === "done" ? "✓" : n}</span>
          <span className="t">{label}</span>
          {!open && summary && <span className="meta step-sum">{summary}</span>}
        </button>
        <div className="st-tabs step-status" role="group" aria-label={`Step ${n} status`}>
          {STEP_STATUS.map((s) => (
            <button key={s.id} type="button" className={s.id} aria-pressed={status === s.id} onClick={() => setStatus(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn quiet small" onClick={() => void handOver()} title="Sets the step to With Claude and copies what to say in a Claude session">
          Hand to Claude
        </button>
      </div>
      {open && <div className="step-body st-col">{children}</div>}
    </section>
  );
}

// ------------------------------------------------------------------ the list

/** Production's front page: every project by pillar and series, its steps as dots. */
export function ProjectList({ pieces, pillars, families }: { pieces: Piece[]; pillars: Pillar[]; families: Family[] }) {
  const { go } = useStore();
  const ideaMenu = useIdeaMenu();
  const [search, setSearch] = useState("");
  const [showDone, setShowDone] = useState(false);
  const q = search.trim().toLowerCase();
  const shown = pieces.filter((p) => (!q || `${p.title} ${p.code}`.toLowerCase().includes(q)) && (showDone || p.stage !== "reviewed"));
  const groups = useMemo(() => {
    const byPillar = [...pillars].sort((a, b) => a.position - b.position).map((pl) => ({ key: pl.id, name: pl.name, pieces: shown.filter((p) => p.pillarId === pl.id) }));
    const loose = shown.filter((p) => !p.pillarId || !pillars.some((pl) => pl.id === p.pillarId));
    if (loose.length) byPillar.push({ key: "none", name: "No pillar", pieces: loose });
    return byPillar.filter((g) => g.pieces.length);
  }, [shown, pillars]);
  const series = (list: Piece[]) => {
    const fams = [...new Set(list.map((p) => p.familyId ?? ""))];
    return fams
      .map((fid) => ({ fid, family: families.find((f) => f.id === fid), pieces: list.filter((p) => (p.familyId ?? "") === fid).sort((a, b) => (a.episode ?? 999) - (b.episode ?? 999) || a.code.localeCompare(b.code)) }))
      .sort((a, b) => (a.family ? 0 : 1) - (b.family ? 0 : 1) || (a.family?.name ?? "").localeCompare(b.family?.name ?? ""));
  };
  return (
    <div className="st-col">
      <div className="st-row">
        <input className="st-input" style={{ flex: "1 1 220px", minWidth: 0 }} placeholder="Find a project" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="st-row" style={{ gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show reviewed
        </label>
        <span className="step-legend meta">
          {STEP_STATUS.map((s) => (
            <span key={s.id}>
              <i className={`sd ${s.id}`} /> {s.label}
            </span>
          ))}
        </span>
      </div>
      {!groups.length && <p className="st-empty">{pieces.length ? "Nothing matches." : "No projects yet. Green-light an idea in Ideas and it starts here."}</p>}
      {groups.map((g) => (
        <section key={g.key} className="card st-col project-group">
          <h3 className="h6 project-pillar">{g.name}</h3>
          {series(g.pieces).map(({ fid, family, pieces: list }) => (
            <div key={fid || "singles"} className="project-series">
              <h4>{family ? `${family.code ? `${family.code} · ` : ""}${family.name}` : "Singles"}</h4>
              {list.map((p) => {
                const brief = parse<Brief>(p.brief, {});
                const turn = turnOf(brief);
                return (
                  <button key={p.id} type="button" className="project-row" onClick={() => go({ name: "write", id: p.id })} onContextMenu={(e) => ideaMenu(e, { kind: "project", row: p })}>
                    <span className="code">{p.episode != null ? String(p.episode).padStart(2, "0") : p.code}</span>
                    <span className="t">{p.title}</span>
                    <StepDots brief={brief} />
                    <span className={`turn ${turn?.status ?? "done"}`}>
                      {!turn ? "All done" : turn.status === "andy" ? `Your turn: ${turn.step.label}` : turn.status === "claude" ? `Claude: ${turn.step.label}` : `Next: ${turn.step.label}`}
                    </span>
                    <StageChip stage={p.stage} />
                  </button>
                );
              })}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ step 2: inspiration & style

const STYLE_FIELDS: { key: keyof StyleSheet; label: string; hint: string }[] = [
  { key: "pace", label: "Pace", hint: "Calm, building, fast and punchy…" },
  { key: "cutLength", label: "Cut length", hint: "1–2 s cuts, long takes…" },
  { key: "slowMoments", label: "Slow moments", hint: "Where it breathes: slow-mo, holds, silence" },
  { key: "type", label: "Type", hint: "Font, size, where text sits" },
  { key: "colour", label: "Colour", hint: "Warm film, muted greens, the look to use" },
  { key: "musicMood", label: "Music mood", hint: "Ambient piano, no drums until the turn…" },
];

export function InspoStep({ brief, set }: { brief: Brief; set: SetBrief }) {
  const [saves, setSaves] = useState<Save[]>([]);
  const [boards, setBoards] = useState<Board[]>([]);
  const [picking, setPicking] = useState(false);
  const { studioVersion } = useStore();
  useEffect(() => {
    studio.list("saves").then(setSaves).catch(() => {});
    studio.list("boards").then(setBoards).catch(() => {});
  }, [studioVersion]);
  const links = brief.inspo ?? [];
  const style = brief.style ?? {};
  const upd = (id: string, note: string) => set("inspo", links.map((l) => (l.id === id ? { ...l, note } : l)));
  return (
    <>
      <p className="eyebrow" style={{ margin: 0 }}>
        <span>References</span>
        <button type="button" className="link" onClick={() => setPicking(true)}>
          Link from Inspire
        </button>
      </p>
      {!links.length && <p className="st-empty">Link saves or whole boards from Inspire, then write what you like about each one.</p>}
      <div className="inspo-list">
        {links.map((l) => {
          const s = l.saveId ? saves.find((x) => x.id === l.saveId) : undefined;
          const b = l.boardId ? boards.find((x) => x.id === l.boardId) : undefined;
          const inside = b ? saves.filter((x) => x.boardId === b.id) : [];
          const thumb = s ? saveThumb(s.thumb) : saveThumb(inside.find((x) => x.thumb)?.thumb ?? null);
          return (
            <div key={l.id} className="inspo-link">
              <div className="ph">{thumb ? <img src={thumb} alt="" /> : <span className="meta">{b ? "Board" : s?.platform || "Save"}</span>}</div>
              <div className="st-col" style={{ gap: 6, minWidth: 0 }}>
                <div className="st-row between" style={{ flexWrap: "nowrap" }}>
                  <span className="t">{b ? `Board: ${b.title}` : s?.title || s?.url || "This save is gone"}</span>
                  <span className="st-row" style={{ gap: 6, flexWrap: "nowrap" }}>
                    {s?.url && (
                      <button type="button" className="link" onClick={() => void api.openLink(s.url)}>
                        Open
                      </button>
                    )}
                    <button type="button" className="icon-btn" aria-label="Unlink" onClick={() => set("inspo", links.filter((x) => x.id !== l.id))}>
                      ✕
                    </button>
                  </span>
                </div>
                <small className="meta">{b ? `${inside.length} saves${b.client ? ` · ${b.client}` : ""}` : [s?.platform, s?.author].filter(Boolean).join(" · ")}</small>
                <textarea className="st-input" rows={2} value={l.note} placeholder="What I like about it" onChange={(e) => upd(l.id, e.target.value)} />
              </div>
            </div>
          );
        })}
      </div>
      <p className="eyebrow" style={{ margin: "6px 0 0" }}>
        <span>Style sheet</span>
        <span>Claude fills it from the references, you correct it</span>
      </p>
      <div className="st-three">
        {STYLE_FIELDS.map((f) => (
          <label key={f.key} className="st-field">
            <span>{f.label}</span>
            <textarea rows={2} value={style[f.key] ?? ""} placeholder={f.hint} onChange={(e) => set("style", { ...style, [f.key]: e.target.value })} />
          </label>
        ))}
      </div>
      <label className="st-field">
        <span>Other notes on the style</span>
        <textarea rows={2} value={style.notes ?? ""} onChange={(e) => set("style", { ...style, notes: e.target.value })} />
      </label>
      {picking && (
        <InspoPicker
          saves={saves}
          boards={boards}
          linked={links}
          onClose={() => setPicking(false)}
          onPick={(pick) => set("inspo", [...links, { id: newId(), ...pick, note: "" }])}
        />
      )}
    </>
  );
}

function InspoPicker({ saves, boards, linked, onClose, onPick }: { saves: Save[]; boards: Board[]; linked: NonNullable<Brief["inspo"]>; onClose: () => void; onPick: (p: { saveId?: string; boardId?: string }) => void }) {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"saves" | "boards">("saves");
  const words = q.trim().toLowerCase();
  const has = (id: string) => linked.some((l) => l.saveId === id || l.boardId === id);
  const savesShown = saves
    .filter((s) => s.status !== "archived" && (!words || `${s.title} ${s.author} ${s.platform} ${s.why} ${s.tags} ${s.url}`.toLowerCase().includes(words)))
    .sort((a, b) => b.updatedMs - a.updatedMs)
    .slice(0, 120);
  const boardsShown = boards.filter((b) => !words || `${b.title} ${b.client} ${b.notes}`.toLowerCase().includes(words));
  return (
    <Modal title="Link inspiration" crumb="From Inspire: saves and boards" onClose={onClose} wide>
      <div className="st-row" style={{ marginBottom: 12 }}>
        <div className="st-tabs" role="group" aria-label="Saves or boards">
          <button type="button" aria-pressed={tab === "saves"} onClick={() => setTab("saves")}>
            Saves <span className="n">{saves.length}</span>
          </button>
          <button type="button" aria-pressed={tab === "boards"} onClick={() => setTab("boards")}>
            Boards <span className="n">{boards.length}</span>
          </button>
        </div>
        <input className="st-input" autoFocus style={{ flex: "1 1 240px", minWidth: 0 }} placeholder="Search titles, authors, notes, tags" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="inspo-pick">
        {tab === "saves"
          ? savesShown.map((s) => (
              <button key={s.id} type="button" className="inspo-tile" disabled={has(s.id)} onClick={() => onPick({ saveId: s.id })} title={s.url}>
                <span className="ph">{saveThumb(s.thumb) ? <img src={saveThumb(s.thumb)} alt="" /> : <span className="meta">{s.platform || s.kind}</span>}</span>
                <span className="t">{s.title || s.url || "Untitled"}</span>
                <small className="meta">{has(s.id) ? "Linked" : [s.platform, s.author].filter(Boolean).join(" · ")}</small>
              </button>
            ))
          : boardsShown.map((b) => (
              <button key={b.id} type="button" className="inspo-tile" disabled={has(b.id)} onClick={() => onPick({ boardId: b.id })}>
                <span className="ph">
                  <span className="meta">{saves.filter((s) => s.boardId === b.id).length} saves</span>
                </span>
                <span className="t">{b.title}</span>
                <small className="meta">{has(b.id) ? "Linked" : b.client || "Board"}</small>
              </button>
            ))}
        {tab === "saves" && !savesShown.length && <p className="st-empty">No saves match.</p>}
        {tab === "boards" && !boardsShown.length && <p className="st-empty">No boards match.</p>}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ step 4: sound

const AUDIO = ["wav", "aif", "aiff", "mp3", "m4a", "aac", "flac", "caf"];
const isAudio = (name: string) => AUDIO.includes(name.split(".").pop()?.toLowerCase() ?? "");

export function SoundStep({ piece, brief, set }: { piece: Piece; brief: Brief; set: SetBrief }) {
  const toast = useToast();
  const sounds = brief.sounds ?? [];
  const [files, setFiles] = useState<PieceFile[]>([]);
  useEffect(() => {
    studio.pieceFiles(piece.id).then(setFiles).catch(() => setFiles([]));
  }, [piece.id]);
  const add = (paths: string[]) => {
    const fresh = paths.filter((p) => !sounds.some((s) => s.file === p));
    if (!fresh.length) return;
    set("sounds", [...sounds, ...fresh.map((file): SoundItem => ({ id: newId(), file, kind: /sfx|fx|whoosh|hit|riser/i.test(file.split("/").pop() ?? "") ? "sfx" : "music", source: "", licensed: false }))]);
  };
  const choose = async () => {
    try {
      const picked = await openDialog({ multiple: true, title: "Music and sound effects for this project", filters: [{ name: "Audio", extensions: AUDIO }], defaultPath: piece.folder ? `${piece.folder}/02_AUDIO` : undefined });
      if (picked) add(Array.isArray(picked) ? picked : [picked]);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const upd = (id: string, p: Partial<SoundItem>) => set("sounds", sounds.map((s) => (s.id === id ? { ...s, ...p } : s)));
  const inFolder = files.filter((f) => isAudio(f.name) && !sounds.some((s) => s.file === f.path));
  const unlicensed = sounds.filter((s) => !s.licensed);
  return (
    <>
      <p className="eyebrow" style={{ margin: 0 }}>
        <span>Music and sound effects</span>
        <button type="button" className="link" onClick={() => void choose()}>
          Add files…
        </button>
      </p>
      {unlicensed.length > 0 && (
        <p className="warnline">
          {unlicensed.length === 1 ? "1 sound isn't" : `${unlicensed.length} sounds aren't`} marked licensed. Nothing unlicensed goes into a posted video: tick it once you have the licence, or swap it.
        </p>
      )}
      {!sounds.length && <p className="st-empty">Add the music and sound effects for this project, with where each one is from.</p>}
      {sounds.length > 0 && (
        <div className="sound-list">
          {sounds.map((s) => (
            <div key={s.id} className="sound-row">
              <select className="st-input" value={s.kind} aria-label="Kind" onChange={(e) => upd(s.id, { kind: e.target.value as SoundItem["kind"] })}>
                <option value="music">Music</option>
                <option value="sfx">Sound effect</option>
              </select>
              <span className="file" title={s.file}>
                {s.file.split("/").pop()}
              </span>
              <input className="st-input" value={s.source} placeholder="Where it's from (Artlist, Epidemic, artist, link…)" onChange={(e) => upd(s.id, { source: e.target.value })} />
              <label className={s.licensed ? "lic ok" : "lic"}>
                <input type="checkbox" checked={s.licensed} onChange={(e) => upd(s.id, { licensed: e.target.checked })} /> Licensed
              </label>
              <button type="button" className="icon-btn" aria-label="Remove" onClick={() => set("sounds", sounds.filter((x) => x.id !== s.id))}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {inFolder.length > 0 && (
        <div className="st-row" style={{ gap: 6 }}>
          <span className="meta">In this project's folder:</span>
          {inFolder.slice(0, 12).map((f) => (
            <button key={f.path} type="button" className="chipbtn" title={`${f.folder}/${f.name}`} onClick={() => add([f.path])}>
              + {f.name}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ step 5: cut

const isXml = (name: string) => /\.fcpxmld?$/i.test(name);

export function CutStep({ piece, brief, set }: { piece: Piece; brief: Brief; set: SetBrief }) {
  const toast = useToast();
  const edit = brief.edit ?? {};
  const [files, setFiles] = useState<PieceFile[]>([]);
  const [draft, setDraft] = useState<CutRead | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    studio.pieceFiles(piece.id).then(setFiles).catch(() => setFiles([]));
  }, [piece.id, edit.lastRead?.readMs]);
  const found = files.filter((f) => isXml(f.name));
  // The project's FCPXML: the one chosen, else the oldest in the folder (the draft; exports come later).
  const project = edit.fcpxml ?? (found.length ? found[found.length - 1].path : undefined);
  useEffect(() => {
    if (!project) return setDraft(null);
    studio
      .readFcpxml(project)
      .then((xml) => setDraft(readCut(xml, project)))
      .catch(() => setDraft(null));
  }, [project]);

  const pickProject = async () => {
    const p = await openDialog({ multiple: false, directory: false, title: "The project's Final Cut XML", filters: [{ name: "Final Cut XML", extensions: ["fcpxml", "fcpxmld"] }], defaultPath: piece.folder ?? undefined }).catch(() => null);
    if (typeof p === "string") set("edit", { ...edit, fcpxml: p });
  };
  const openFcp = async () => {
    if (!project) return toast("No FCPXML in this project's folder yet: choose one", { error: true });
    try {
      await studio.openInFinalCut(project);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const readBack = async (path?: string) => {
    let p = path;
    if (!p) {
      const picked = await openDialog({ multiple: false, title: "Your edit, exported from Final Cut (File › Export XML…)", filters: [{ name: "Final Cut XML", extensions: ["fcpxml", "fcpxmld"] }], defaultPath: piece.folder ?? undefined }).catch(() => null);
      if (typeof picked !== "string") return;
      p = picked;
    }
    setBusy(true);
    try {
      const cut = readCut(await studio.readFcpxml(p), p);
      set("edit", { ...edit, fcpxml: project, previous: edit.lastRead, lastRead: cut });
      toast(`Read ${cut.project}: ${cut.clips.length} clips, ${cut.duration.toFixed(1)} s`);
    } catch (e) {
      toast(`Couldn't read that edit: ${errorText(e)}`, { error: true });
    } finally {
      setBusy(false);
    }
  };

  const last = edit.lastRead;
  // What changed: against the edit read before, or the draft the first time.
  const base = edit.previous ?? (draft && last && draft.path !== last.path ? draft : null);
  const diff = last && base ? compareCuts(base, last) : null;
  const exports = found.filter((f) => f.path !== project && (!last || f.path !== last.path));
  const f = (s: number) => `${s.toFixed(1)} s`;
  return (
    <>
      <div className="st-row">
        <button type="button" className="btn primary small" onClick={() => void openFcp()} disabled={!project}>
          Open in Final Cut
        </button>
        <button type="button" className="btn quiet small" disabled={busy} onClick={() => void readBack()}>
          {busy ? "Reading…" : "Read back my edit…"}
        </button>
        <button type="button" className="link" onClick={() => void pickProject()}>
          {project ? "Choose another FCPXML" : "Choose the FCPXML…"}
        </button>
      </div>
      <p className="meta" style={{ margin: 0, wordBreak: "break-all" }}>
        {project ? `Project: ${project.split("/").pop()}${draft ? ` · ${draft.clips.length} clips, ${f(draft.duration)}` : ""}` : "No FCPXML yet: Claude's draft lands in this project's folder, or choose one."}
      </p>
      {exports.length > 0 && (
        <div className="st-row" style={{ gap: 6 }}>
          <span className="meta">Other XML in the folder:</span>
          {exports.slice(0, 6).map((x) => (
            <button key={x.path} type="button" className="chipbtn" onClick={() => void readBack(x.path)} title={x.path}>
              Read {x.name}
            </button>
          ))}
        </div>
      )}
      {last && (
        <div className="cut-read st-col">
          <p className="eyebrow" style={{ margin: 0 }}>
            <span>
              Your edit: {last.project} · {f(last.duration)} · {last.clips.length} clips
            </span>
            <span>read {new Date(last.readMs).toLocaleString()}</span>
          </p>
          {diff && (
            <div className="st-col" style={{ gap: 4 }}>
              <span className="meta">
                Since {edit.previous ? "the last read" : "the draft"}: {diff.durationDelta === 0 ? "same length" : `${diff.durationDelta > 0 ? "+" : ""}${f(diff.durationDelta)}`} · {diff.changes.length ? `${diff.changes.length} changes` : "no clip changes"}
              </span>
              {diff.changes.slice(0, 40).map((c, i) => (
                <span key={i} className={`cut-change ${c.kind}`}>
                  <b>{c.kind}</b> {c.name} <span className="meta">{c.detail}</span>
                </span>
              ))}
            </div>
          )}
          <details>
            <summary className="meta">All clips</summary>
            <div className="cut-clips">
              {last.clips.map((c, i) => (
                <span key={i}>
                  <span className="meta">{f(c.at)}</span> {c.name} <span className="meta">{f(c.duration)}{c.lane ? ` · lane ${c.lane}` : ""}</span>
                </span>
              ))}
            </div>
          </details>
        </div>
      )}
      <p className="hint">Resolve Studio slots in here later. The app never edits for you: Claude makes the draft FCPXML in a Claude session, you cut in Final Cut, then read it back here.</p>
    </>
  );
}

// ------------------------------------------------------------------ step 3: per-clip marks

export function FootageMarks({ brief, set, ids, names }: { brief: Brief; set: SetBrief; ids: string[]; names: Record<string, string> }) {
  const marks = brief.footage ?? {};
  const upd = (id: string, p: { level?: boolean; picks?: string }) => set("footage", { ...marks, [id]: { ...marks[id], ...p } });
  if (!ids.length) return null;
  return (
    <div className="footage-marks">
      {ids.map((id) => (
        <div key={id} className="footage-row">
          <span className="file" title={names[id] ?? id}>
            {names[id] ?? "…"}
          </span>
          <label className={marks[id]?.level ? "lic warn" : "lic"} title="Shot on the a6700 with gyro data: level it in Gyroflow first">
            <input type="checkbox" checked={!!marks[id]?.level} onChange={(e) => upd(id, { level: e.target.checked })} /> Needs levelling
          </label>
          <input className="st-input" value={marks[id]?.picks ?? ""} placeholder="Claude's picks (moments to use)" onChange={(e) => upd(id, { picks: e.target.value })} />
        </div>
      ))}
    </div>
  );
}
