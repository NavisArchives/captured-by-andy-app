// Settings › Previews of videos: a light, local copy of every clip that isn't
// rejected, so clips play at once without waiting on Google Drive.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { errorText } from "../api";
import { eta, type CopiesStatus } from "../lib/clipPreview";
import { bytes } from "../lib/format";
import { useToast } from "./ui";

type Status = CopiesStatus;
interface Progress {
  done: number;
  total: number;
  skipped: number;
  failed: number;
  offloaded: number;
  current: string;
  note: string;
}

export function ReviewCopies() {
  const toast = useToast();
  const [s, setS] = useState<Status | null>(null);
  const [p, setP] = useState<Progress | null>(null);
  const load = () => invoke<Status>("review_copies").then(setS).catch(() => {});
  useEffect(() => {
    load();
    const t = window.setInterval(load, 15_000);
    const offs = [
      listen<Progress>("review-progress", (e) => setP(e.payload)),
      listen("review-progress-end", () => {
        load();
        setP((x) => {
          if (x?.note) toast(x.note);
          return x;
        });
      }),
    ];
    return () => {
      window.clearInterval(t);
      offs.forEach((o) => o.then((u) => u()));
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setCap = (gb: number) =>
    invoke("set_setting", { key: "review.capGB", value: String(gb) })
      .then(load)
      .catch((e) => toast(errorText(e), { error: true }));
  const start = () => invoke("make_review_copies").then(load).catch((e) => toast(errorText(e), { error: true }));
  const stop = () => invoke("stop_review_copies").catch(() => {});

  return (
    <section className="card">
      <p className="eyebrow">
        <span>Previews of videos</span>
        <span>{s ? `${s.ready} ready` : ""}</span>
      </p>
      <p style={{ margin: "0 0 10px", fontSize: 13.5, color: "var(--ink-2)" }}>
        A light copy of each clip you haven't rejected (720p, S-Log3 already in normal colour), kept on this Mac so clips play at once, even when the original is only on Google Drive. Making one downloads the original once and lets it go again. Rejected clips lose theirs; originals stay where they are.
      </p>
      {s && (
        <p className="meta" style={{ margin: "0 0 10px" }}>
          {s.ready} ready · {bytes(s.bytes)} of {bytes(s.capBytes)} · {s.waiting} to make
          {s.waitingOnlineBytes ? ` (${bytes(s.waitingOnlineBytes)} to download${eta(s.waitingOnlineBytes, s.speed) ? `, ${eta(s.waitingOnlineBytes, s.speed)}` : ""})` : ""}
          {p && s.running ? ` · ${p.done} of ${p.total} this run${p.current ? ` · ${p.current}` : ""}${p.note ? ` · ${p.note}` : ""}` : ""}
        </p>
      )}
      <div className="row-flex" style={{ gap: 8 }}>
        {s?.running ? (
          <button type="button" className="btn quiet small" onClick={() => void stop()}>
            Stop
          </button>
        ) : (
          <button type="button" className="btn primary small" disabled={!s?.waiting} onClick={() => void start()}>
            {s?.waiting ? `Make ${s.waiting} previews` : "Every clip has one"}
          </button>
        )}
        <label className="meta row-flex" style={{ gap: 6 }}>
          At most
          <select value={s ? String(Math.round(s.capBytes / 1e9)) : "10"} onChange={(e) => void setCap(Number(e.target.value))} aria-label="Most space previews may take">
            {[2, 5, 10, 20, 40].map((g) => (
              <option key={g} value={g}>
                {g} GB
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}
