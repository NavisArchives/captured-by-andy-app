// Download / Remove download for online-only originals (Google Drive): the
// file is made available on this Mac in place, through the Drive app, and can
// be set back to online-only. Shows the size first, refuses to leave less than
// 10 GB free, and shows progress while it runs. Nothing on Drive is deleted.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { errorText } from "../api";
import { eta } from "../lib/clipPreview";
import { bytes } from "../lib/format";
import { Modal, useToast } from "./ui";

export interface DownloadPlan {
  online: number;
  onlineBytes: number;
  downloaded: number;
  downloadedBytes: number;
  free: number;
  freeAfter: number;
  allowed: boolean;
  keepFree: number;
  speed: number | null;
}

interface Progress {
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  current: string;
  failed: number;
  note: string;
}

export const planDownload = (photoIds: string[]) => invoke<DownloadPlan>("download_plan", { photoIds });

/** Says how a download ended, whether or not its window is still open. Mounted once. */
export function DownloadNotice() {
  const toast = useToast();
  useEffect(() => {
    const off = listen<Progress>("download-done", (e) => {
      const r = e.payload;
      const bad = r.failed > 0 || (r.done === 0 && !!r.note && r.note !== "Stopped");
      toast(`${r.done === 1 ? "1 original" : `${r.done} originals`} downloaded${r.failed ? ` · ${r.failed} failed` : ""}${r.note ? ` · ${r.note}` : ""}`, { error: bad });
    });
    return () => void off.then((u) => u());
  }, [toast]);
  return null;
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/** Download (or remove the download of) these photos' online originals. */
export function DownloadDialog({ photoIds, what = "original", title, intro, onClose }: { photoIds: string[]; what?: string; title?: string; intro?: string; onClose: (changed: boolean) => void }) {
  const toast = useToast();
  const [plan, setPlan] = useState<DownloadPlan | null>(null);
  const [p, setP] = useState<Progress | null>(null);
  const [running, setRunning] = useState(false);
  const [changed, setChanged] = useState(false);

  const load = () => planDownload(photoIds).then(setPlan).catch((e) => toast(errorText(e), { error: true }));
  useEffect(() => {
    load();
    // A download still running (the window was closed meanwhile): show it.
    invoke<{ running: boolean; progress: Progress | null }>("download_status")
      .then((s) => {
        if (!s.running) return;
        setRunning(true);
        setP(s.progress);
      })
      .catch(() => {});
    // The result itself is said by DownloadNotice, also when this window is closed.
    const offs = [
      listen<Progress>("download-progress", (e) => setP(e.payload)),
      listen<Progress>("download-done", () => {
        setRunning(false);
        setChanged(true);
        void load();
      }),
    ];
    return () => offs.forEach((o) => o.then((u) => u()));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    try {
      setP(null);
      await invoke("download_originals", { photoIds });
      setRunning(true);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const remove = async () => {
    try {
      const [n, freed] = await invoke<[number, number]>("remove_downloads", { photoIds });
      toast(`${plural(n, what)} back to online-only · ${bytes(freed)} freed on this Mac`);
      onClose(true);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };

  const pct = p && p.bytesTotal ? Math.min(100, (p.bytesDone / p.bytesTotal) * 100) : 0;
  const close = () => onClose(changed);
  return (
    <Modal
      title={title ?? "Download originals"}
      onClose={close}
      foot={
        running ? (
          <button type="button" className="btn quiet" onClick={() => void invoke("stop_download")}>Stop</button>
        ) : (
          <>
            {plan && plan.downloaded > 0 && (
              <button type="button" className="btn quiet" onClick={() => void remove()} title="Set them back to online-only: they stay on Google Drive">
                Remove download ({bytes(plan.downloadedBytes)})
              </button>
            )}
            <button type="button" className="btn quiet" onClick={close}>{changed ? "Done" : "Cancel"}</button>
            {plan && plan.online > 0 && (
              <button type="button" className="btn primary" disabled={!plan.allowed} onClick={() => void start()}>
                Download {bytes(plan.onlineBytes)}
              </button>
            )}
          </>
        )
      }
    >
      {intro && <p style={{ margin: "0 0 12px" }}>{intro}</p>}
      {!plan ? (
        <p className="meta">Checking…</p>
      ) : running ? null : (
        <dl className="kv">
          <dt>Online only</dt>
          <dd>{plan.online ? `${plural(plan.online, what)} · ${bytes(plan.onlineBytes)}${eta(plan.onlineBytes, plan.speed) ? ` · ${eta(plan.onlineBytes, plan.speed)}` : ""}` : "None"}</dd>
          <dt>On this Mac</dt>
          <dd>{plan.downloaded ? `${plural(plan.downloaded, what)} · ${bytes(plan.downloadedBytes)}` : "None"}</dd>
          <dt>Free space</dt>
          <dd>
            {bytes(plan.free)} now{plan.online ? ` · ${bytes(plan.freeAfter)} after` : ""}
            {!plan.allowed && plan.online > 0 && (
              <span className="tag t-rej" style={{ marginLeft: 6 }}>
                Needs {bytes(plan.keepFree)} left free
              </span>
            )}
          </dd>
        </dl>
      )}
      {running && (
        <div style={{ display: "grid", gap: 8 }}>
          <div className="dl-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <p className="meta" style={{ margin: 0 }}>
            {p ? `${p.done} of ${plural(p.total, what)} · ${bytes(p.bytesDone)} of ${bytes(p.bytesTotal)}${p.current ? ` · ${p.current}` : ""}${p.note ? ` · ${p.note}` : ""}` : "Starting…"}
          </p>
        </div>
      )}
      {!running && plan && !plan.allowed && plan.online > 0 && (
        <p className="meta" style={{ margin: "12px 0 0" }}>
          Downloading these would leave {bytes(plan.freeAfter)} on this Mac. Pick fewer, or free some space first (Settings › On this Mac).
        </p>
      )}
      <p className="meta" style={{ margin: "12px 0 0" }}>Originals stay on Google Drive. Remove download only frees this Mac's space.</p>
    </Modal>
  );
}
