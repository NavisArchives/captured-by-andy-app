import { useState } from "react";
import { errorText } from "../api";
import { Select, useToast } from "../components/ui";
import { speechSegments, subtitles } from "../lib/subtitles";
import { formatDuration } from "../lib/format";
import { WEB } from "../platform";
import { studio } from "./api";
import type { Save } from "./types";

export function Transcript({ save }: { save: Save }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const state = save.transcriptionState || (save.transcript ? "complete" : save.analysedMs ? "failed" : "queued");
  const working = busy || state === "running" || state === "queued";
  const segments = speechSegments(save.transcriptSegments);
  const retry = async () => {
    setBusy(true);
    try { await studio.save("saves", save.id, { analysedMs: null, transcriptionState: "queued", transcriptionError: "" }); }
    catch (e) { toast(errorText(e), { error: true }); }
    finally { setBusy(false); }
  };
  const copy = async (format: "srt" | "vtt" | "text") => {
    try { await navigator.clipboard.writeText(format === "text" ? save.transcript : subtitles(segments, format)); toast(`${format === "text" ? "Transcript" : format.toUpperCase() + " captions"} copied`); }
    catch { toast("Could not copy. Select the transcript and press ⌘C.", { error: true }); }
  };
  return <div className="sd-group">
    <span className="sd-label">Transcript · {state === "complete" ? "complete" : state === "failed" ? "needs attention" : WEB ? "waiting for the Mac" : state}</span>
    <div className="st-row">
      <Select aria-label="Transcript language" className="pick" value={save.transcriptLanguage ?? "en-US"} disabled={working} onChange={(e) => void studio.save("saves", save.id, { transcriptLanguage: e.target.value }).catch((e) => toast(errorText(e), { error: true }))}>
        <option value="en-US">English</option><option value="es-ES">Spanish</option><option value="nl-NL">Dutch</option><option value="fr-FR">French</option>
      </Select>
      {!WEB && <button type="button" className="btn quiet small" disabled={working || !save.filePath} onClick={() => void retry()}>{working ? "Transcribing…" : "Retry transcription"}</button>}
      {!!save.transcript && <button type="button" className="link" onClick={() => void copy("text")}>Copy transcript</button>}
      {!!segments.length && <><button type="button" className="link" onClick={() => void copy("srt")}>Copy SRT</button><button type="button" className="link" onClick={() => void copy("vtt")}>Copy VTT</button></>}
    </div>
    {state === "failed" && <p role="alert" className="meta">{save.transcriptionError || "No transcript was stored. Check speech permission and the recording, then retry."}</p>}
    <p className="meta">{WEB ? "Transcription runs on the Mac; results arrive after sync." : "On-device speech recognition. The selected language must be available on this Mac."}</p>
    {!!save.transcript && <details><summary>Read transcript{segments.length ? ` · ${segments.length} timed words` : ""}</summary>
      {segments.length ? <div style={{ maxHeight: 280, overflowY: "auto", lineHeight: 1.7 }}>{segments.map((s, i) => <span key={i} title={`${formatDuration(s.start)}–${formatDuration(s.end)}`}>{s.text} </span>)}</div>
      : <p style={{ whiteSpace: "pre-wrap" }}>{save.transcript}</p>}
    </details>}
  </div>;
}
