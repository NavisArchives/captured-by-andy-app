// Small pieces every Studio screen uses: loading a list (and reloading it
// when Studio changes), the first-run pillar setup, stage chips, the idea
// score and save tiles.
import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "../api";
import { useToast } from "../components/ui";
import { useStore } from "../store";
import { saveThumb, studio } from "./api";
import { stageLabel, verdict, type Idea, type Lists, type Save, type Stage } from "./types";
import { topicOf } from "./library";

/** A Studio list, read again whenever anything in Studio changes. */
export function useList<K extends keyof Lists>(list: K): [Lists[K][] | null, () => void] {
  const { studioVersion } = useStore();
  const [rows, setRows] = useState<Lists[K][] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    studio
      .list(list)
      .then((r) => live && setRows(r))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [list, studioVersion, tick]);
  return [rows, useCallback(() => setTick((t) => t + 1), [])];
}

/** Runs `save` after typing pauses; flushes on unmount so nothing is lost. */
export function useDebounced<T>(value: T, save: (v: T) => void, delay = 600) {
  const first = useRef(true);
  const latest = useRef({ value, save, pending: false });
  latest.current.value = value;
  latest.current.save = save;
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    latest.current.pending = true;
    const t = window.setTimeout(() => {
      latest.current.pending = false;
      latest.current.save(latest.current.value);
    }, delay);
    return () => window.clearTimeout(t);
  }, [value, delay]);
  useEffect(
    () => () => {
      if (latest.current.pending) latest.current.save(latest.current.value);
    },
    [],
  );
}

/** Inspire holds saves and ideas: one tab in the bar, this switch on top of both. */
export function StageChip({ stage }: { stage: Stage }) {
  return <span className={`stage-chip ${stage}`}>{stageLabel(stage)}</span>;
}

export function Verdict({ total }: { total: number | null }) {
  const v = verdict(total);
  return (
    <span className={`verdict ${v.tone}`}>
      {total != null ? `${total}/20 · ` : ""}
      {v.label}
    </span>
  );
}

const SCORE_ROWS: { key: keyof Pick<Idea, "scoreHook" | "scoreSend" | "scoreFit" | "scoreEase">; label: string; hint: string }[] = [
  { key: "scoreHook", label: "Hook", hint: "Does the first line stop the scroll?" },
  { key: "scoreSend", label: "Would they send it", hint: "Instagram ranks on sends per reach" },
  { key: "scoreFit", label: "Fit", hint: "Your pillar, your voice" },
  { key: "scoreEase", label: "Ease", hint: "Can you film it this week?" },
];

export function ScoreEditor({ idea, onChange }: { idea: Idea; onChange: (patch: Partial<Idea>) => void }) {
  return (
    <div className="score">
      {SCORE_ROWS.map((r) => (
        <div key={r.key} className="score-row" title={r.hint}>
          <span>{r.label}</span>
          <div className="dots">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" className={idea[r.key] === n ? "on" : undefined} onClick={() => onChange({ [r.key]: idea[r.key] === n ? null : n })}>
                {n}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A save as a card: every card the same shape (a 4:5 picture, then the
 *  title, where it's from and what you liked), whatever it is. */
/** Drag type for a save tile dropped onto a board. */
export const SAVE_DRAG = "application/x-studio-save";

export function SaveTile({ save, on, selected, onClick }: { save: Save; on?: boolean; selected?: boolean; onClick: (e: React.MouseEvent) => void }) {
  const src = saveThumb(save.thumb);
  const where = save.platform === "file" ? (save.kind === "video" ? "Recording" : "Screenshot") : platformName(save.platform);
  const topic = topicOf(save.topic);
  return (
    <button
      type="button"
      className={`save-tile${on ? " on" : ""}${selected ? " selected" : ""}`}
      onClick={onClick}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(SAVE_DRAG, save.id);
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      {selected && <span className="sel-check" aria-hidden="true">✓</span>}
      <div className={`pic${save.platform === "web" ? " page" : ""}`}>
        {src ? <img src={src} alt="" loading="lazy" /> : <div className="ph">{where}</div>}
        <span className={topic ? "type" : "type none"}>{topic ? topic.label : "Pick a type"}</span>
      </div>
      <div className="meta-line">
        <b>{save.title || save.url || "Untitled save"}</b>
        <small>
          {where}
          {save.author && save.author !== save.title ? ` · ${save.author}` : ""}
        </small>
        <span className="why">{save.why ? `“${save.why}”` : ""}</span>
      </div>
    </button>
  );
}

/** First run: Studio asks for the three pillars once. */
export function PillarSetup({ onDone }: { onDone?: () => void }) {
  const toast = useToast();
  const [names, setNames] = useState(["", "", ""]);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const clean = names.map((n) => n.trim()).filter(Boolean);
    if (!clean.length) return toast("Name at least one pillar");
    setBusy(true);
    try {
      for (const [i, name] of clean.entries()) await studio.save("pillars", null, { name, position: i });
      await studio.root();
      toast(`Studio is set up: ${clean.length} pillar${clean.length > 1 ? "s" : ""}, and your Studio folder is in Movies`);
      onDone?.();
    } catch (e) {
      toast(errorText(e), { error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <p className="eyebrow">First things first</p>
      <h2 style={{ margin: "0 0 6px", fontWeight: 400, fontSize: 24, letterSpacing: "-0.02em" }}>Name your three pillars</h2>
      <p style={{ margin: "0 0 14px", color: "var(--ink-2)", maxWidth: "62ch" }}>
        The themes you keep coming back to. Every piece belongs to one; each becomes a folder in Movies › STUDIO and a column on Pillars. You can rename them later.
      </p>
      <div className="st-three">
        {names.map((n, i) => (
          <input
            key={i}
            className="st-input"
            value={n}
            placeholder={["e.g. Skin", "e.g. Hair", "e.g. Life in Belgium"][i]}
            onChange={(e) => setNames((all) => all.map((x, j) => (j === i ? e.target.value : x)))}
            onKeyDown={(e) => e.key === "Enter" && void save()}
          />
        ))}
      </div>
      <div className="st-row" style={{ marginTop: 14 }}>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
          Set up Studio
        </button>
      </div>
    </section>
  );
}

export const platformName = (p: string) => ({ tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", vimeo: "Vimeo", pinterest: "Pinterest", web: "Website" })[p] ?? p;
