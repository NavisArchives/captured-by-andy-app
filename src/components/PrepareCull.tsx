// Prepare culling (Andy, 12 Nov): starting a cull whose clips are only on
// Google Drive asks first. Preparing downloads each original once, keeps its
// light preview (720p, a few MB) and lets the original go, so every clip then
// plays at once. Culling can start straight away and gets faster as previews
// land; a notice says when they're all in.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { eta } from "../lib/clipPreview";
import { bytes } from "../lib/format";
import { Modal, useToast } from "./ui";

interface PreparePlan {
  clips: number;
  online: number;
  onlineBytes: number;
  speed: number | null;
  free: number;
  ids: string[];
}

// Asked once per set of photos in a run of the app.
const asked = new Set<string>();
// The clips being prepared, to say how many really play at once when it ends.
let preparing: string[] = [];

/** Says when previews being prepared for a cull are all in. Mounted once. */
export function PrepareNotice() {
  const toast = useToast();
  useEffect(() => {
    const off = listen<{ done: number; note: string }>("review-progress-end", () => {
      if (!preparing.length) return;
      const ids = preparing;
      preparing = [];
      api
        .videosReady(ids)
        .then((ready) => {
          const n = ready.length;
          if (n === ids.length) toast(`Ready to cull: all ${n === 1 ? "1 clip plays" : `${n} clips play`} at once now`);
          else toast(`${n} of ${ids.length} clips are ready; the others couldn't be fetched yet and play from Google Drive`, { error: n === 0 });
        })
        .catch(() => {});
    });
    return () => void off.then((u) => u());
  }, [toast]);
  return null;
}

export function PrepareCull({ ids, onLater }: { ids: string[]; onLater: () => void }) {
  const toast = useToast();
  const key = `${ids.length}:${ids[0] ?? ""}:${ids[ids.length - 1] ?? ""}`;
  const [plan, setPlan] = useState<PreparePlan | null>(null);
  const [open, setOpen] = useState(!asked.has(key));
  useEffect(() => {
    if (!open) return;
    asked.add(key);
    invoke<PreparePlan>("prepare_cull_plan", { photoIds: ids })
      .then((p) => (p.online > 0 ? setPlan(p) : setOpen(false)))
      .catch(() => setOpen(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open || !plan) return null;

  const prepare = async (later: boolean) => {
    try {
      await invoke("make_review_copies", { photoIds: plan.ids });
      preparing = [...new Set([...preparing, ...plan.ids])];
      setOpen(false);
      const when = eta(plan.onlineBytes, plan.speed);
      toast(`Preparing ${plan.clips === 1 ? "1 clip" : `${plan.clips} clips`}${when ? `, ready in ${when}` : ""}. You'll get a notice when it's done.`);
      if (later) onLater();
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const when = eta(plan.onlineBytes, plan.speed);
  return (
    <Modal
      title="Prepare culling"
      onClose={() => setOpen(false)}
      foot={
        <>
          <button type="button" className="btn quiet" onClick={() => setOpen(false)}>Cull without preparing</button>
          <button type="button" className="btn quiet" onClick={() => void prepare(true)}>Prepare, cull later</button>
          <button type="button" className="btn primary" onClick={() => void prepare(false)}>Prepare and start culling</button>
        </>
      }
    >
      <p style={{ margin: "0 0 10px" }}>
        <b>{plan.online.toLocaleString()} {plan.online === 1 ? "clip is" : "clips are"} only on Google Drive</b> with no light preview yet, so each would load for minutes before playing.
      </p>
      <dl className="kv">
        <dt>To download</dt>
        <dd>
          {bytes(plan.onlineBytes)}, once · {when} at {plan.speed ? `your last speed (${(plan.speed / 1e6).toFixed(1)} MB/s)` : "about 1 MB/s"}
          <small style={{ display: "block", color: "var(--muted)" }}>An estimate: slower while Google Drive is still uploading, and paused while a clip plays from the cloud.</small>
        </dd>
        <dt>Kept on this Mac</dt>
        <dd>About {bytes(plan.clips * 7_000_000)} of previews; each original is let go again right after</dd>
        <dt>Free space</dt>
        <dd>{bytes(plan.free)}</dd>
      </dl>
      <p className="meta" style={{ margin: "12px 0 0" }}>
        You can cull right away: clips play instantly as their previews come in. When you're done, you can keep the selected originals on this Mac.
      </p>
    </Modal>
  );
}
