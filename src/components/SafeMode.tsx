// Shown instead of the app when the library couldn't open at launch (a
// damaged file, a failed update): what happened, and the backups to restore.
import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { bytes, whenLabel } from "../lib/format";
import type { BackupInfo } from "../types";

export function SafeMode({ message }: { message: string }) {
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    api.safeBackups().then(setBackups).catch(() => setBackups([]));
  }, []);
  return (
    <div className="app">
      <div className="screen" style={{ display: "grid", placeItems: "start center" }}>
        <section className="card" style={{ maxWidth: 640, width: "100%", marginTop: 48, display: "grid", gap: 14 }}>
          <p className="eyebrow">Captured by Andy</p>
          <h1 style={{ margin: 0, fontWeight: 400, letterSpacing: "-0.04em", fontSize: 34 }}>The library couldn't open</h1>
          <p style={{ margin: 0 }}>{message}</p>
          <p className="meta" style={{ margin: 0 }}>
            Your photos are safe: they are never stored in the library file. Restoring a backup brings back your marks, albums, edits and posts as they were on that day. The current library file is kept too.
          </p>
          {problem && <p style={{ margin: 0, color: "var(--red)" }}>{problem}</p>}
          <div style={{ display: "grid", gap: 0 }}>
            {backups === null && <p className="meta">Looking for backups…</p>}
            {backups?.length === 0 && <p className="meta">No backups found next to the library.</p>}
            {backups?.map((b) => (
              <div key={b.name} className="setrow">
                <div className="t">
                  {whenLabel(b.createdMs)}
                  <small>{b.kind === "daily" ? "Daily copy" : b.kind === "manual" ? "Made by hand" : b.kind === "before-restore" ? "Library just before a restore" : "Before an app update"} · {bytes(b.size)}</small>
                </div>
                {asking === b.name ? (
                  <div className="row-flex" style={{ gap: 8 }}>
                    <button
                      type="button"
                      className="btn small primary"
                      onClick={() => api.safeRestore(b.name).catch((e) => { setAsking(null); setProblem(errorText(e)); })}
                    >
                      Restore and restart
                    </button>
                    <button type="button" className="btn small quiet" onClick={() => setAsking(null)}>Cancel</button>
                  </div>
                ) : (
                  <button type="button" className="btn small" onClick={() => setAsking(b.name)}>Restore…</button>
                )}
              </div>
            ))}
          </div>
          <div className="row-flex" style={{ gap: 8 }}>
            <button type="button" className="btn quiet" onClick={() => void api.safeReveal().catch(() => {})}>Show the library file in Finder</button>
          </div>
        </section>
      </div>
    </div>
  );
}
