// ⌘N from anywhere: one line is enough. Hook, pillar and format are optional;
// opened from a save, the idea stays linked to it.
import { useEffect, useState } from "react";
import { errorText } from "../api";
import { Modal, useToast, Select } from "../components/ui";
import { useStore } from "../store";
import { studio } from "./api";
import { FORMATS } from "./library";
import type { Pillar } from "./types";

export function QuickIdea({ saveId, title: initial, onClose }: { saveId?: string; title?: string; onClose: () => void }) {
  const toast = useToast();
  const { go, route } = useStore();
  const [title, setTitle] = useState(initial ?? "");
  const [hook, setHook] = useState("");
  const [pillarId, setPillarId] = useState("");
  const [format, setFormat] = useState("");
  const [pillars, setPillars] = useState<Pillar[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    studio.list("pillars").then(setPillars).catch(() => {});
  }, []);

  const save = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const idea = await studio.save("ideas", null, {
        title: title.trim(),
        hook: hook.trim(),
        pillarId: pillarId || null,
        format,
        platforms: "tiktok,instagram",
        source: saveId ? "save" : "typed",
      });
      if (saveId) await studio.link("saveIdea", saveId, idea.id, true);
      onClose();
      toast("Idea saved", route.name === "ideas" ? undefined : { action: { label: "Open Ideas", run: () => go({ name: "ideas" }) } });
    } catch (e) {
      toast(errorText(e), { error: true });
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New idea"
      crumb="Projects · ⌘N"
      onClose={onClose}
      foot={
        <>
          <span className="meta">Enter saves · only the first line is needed</span>
          <span className="spacer" />
          <button type="button" className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={busy || !title.trim()} onClick={() => void save()}>
            Save idea
          </button>
        </>
      }
    >
      <div className="st-col" style={{ padding: "4px 0 6px" }}>
        <label className="st-field">
          <span>The idea</span>
          <input
            autoFocus
            value={title}
            placeholder="e.g. My three-product morning routine"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void save()}
          />
        </label>
        <label className="st-field">
          <span>First line (hook)</span>
          <input value={hook} placeholder="e.g. Everyone sells you ten steps. I use three." onChange={(e) => setHook(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
        </label>
        <div className="st-two">
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
          <label className="st-field">
            <span>Format</span>
            <Select value={format} onChange={(e) => setFormat(e.target.value)}>
              <option value="">Later</option>
              {FORMATS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </div>
    </Modal>
  );
}
