import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { forgetCull, readCull } from "../lib/cullResume";
import { useStore } from "../store";
import { useToast } from "./ui";

export function ResumeCull({ compact = false }: { compact?: boolean } = {}) {
  const [saved, setSaved] = useState(readCull);
  const [busy, setBusy] = useState(false);
  const { startCull, cull } = useStore();
  useEffect(() => { if (!cull) setSaved(readCull()); }, [cull]);
  const toast = useToast();
  if (!saved) return null;
  const resume = async () => {
    setBusy(true);
    try {
      // Check identity, rather than re-running a review filter that no longer
      // contains the photos already marked during the saved session.
      const available = new Set<string>();
      for (let i = 0; i < saved.ids.length; i += 500) {
        for (const row of await api.rows(saved.ids.slice(i, i + 500))) {
          if (!row.isVideo || row.storage !== "missing") available.add(row.id);
        }
      }
      const ids = saved.ids.filter((id) => available.has(id));
      if (!ids.length) { forgetCull(); setSaved(null); toast("Those photos are no longer in the library."); return; }
      const start = saved.ids.slice(0, saved.start).filter((id) => available.has(id)).length;
      await startCull(saved.query, Math.min(start, ids.length - 1), ids);
    } catch (e) { toast(errorText(e), { error: true }); }
    finally { setBusy(false); }
  };
  // On Today's culling card: one quiet button, no extra card (the page never scrolls).
  if (compact) return <button type="button" className="btn quiet small" disabled={busy} title={`Photo ${saved.start + 1} of ${saved.ids.length.toLocaleString()}, saved on this device`} onClick={() => void resume()}>{busy ? "Checking photos…" : "Resume last cull"}</button>;
  return <section className="card" style={{ marginBottom: 14 }}>
    <div className="row-flex" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
      <div><b>Continue your last cull</b><p className="meta" style={{ margin: "4px 0 0" }}>Photo {saved.start + 1} of {saved.ids.length.toLocaleString()} · saved on this device · undo starts fresh</p></div>
      <div className="row-flex">
        <button type="button" className="btn primary small" disabled={busy} onClick={() => void resume()}>{busy ? "Checking photos…" : "Resume culling"}</button>
        <button type="button" className="btn quiet small" disabled={busy} onClick={() => { forgetCull(); setSaved(null); }}>Dismiss</button>
      </div>
    </div>
  </section>;
}
