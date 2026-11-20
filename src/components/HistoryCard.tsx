// Settings → History (NIRMATA, 19 Nov): every delete, restore and removal of a
// post, album, idea or project, with when and from where. Read-only.
import { useEffect, useState } from "react";
import { api, type AuditLine } from "../api";
import { ago } from "../lib/format";

const VERB: Record<AuditLine["action"], string> = { delete: "Deleted", restore: "Restored", purge: "Removed for good" };

export function HistoryCard() {
  const [lines, setLines] = useState<AuditLine[] | null>(null);
  useEffect(() => {
    api.auditLines(50).then(setLines).catch(() => setLines([]));
  }, []);
  return (
    <section className="card" style={{ gridColumn: "1 / -1" }}>
      <p className="eyebrow"><span>History</span><span>deletes · restores · last 50</span></p>
      {lines === null ? (
        <p className="meta">Reading…</p>
      ) : lines.length === 0 ? (
        <p className="meta" style={{ margin: 0 }}>Nothing deleted yet. Deleted posts, albums, ideas and projects stay in Recently deleted for 30 days.</p>
      ) : (
        <ol className="hist">
          {lines.map((l, i) => (
            <li key={`${l.atMs}-${i}`}>
              <span className="mono hist-when" title={new Date(l.atMs).toLocaleString()}>{ago(l.atMs)}</span>
              <span className="hist-what">{VERB[l.action]} {l.kind} « {l.title || "untitled"} »</span>
              <span className="meta">from {l.source}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
