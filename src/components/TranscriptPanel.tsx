// What is said in a video (NIRMATA Amendment 9b): the lines with their times,
// a click jumps the video there, « Copy text », and a line can become a good
// moment (like I / O). Made on the Mac with whisper.cpp; « No speech » when
// nothing is said.
import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { formatDuration } from "../lib/format";
import { speechSegments, subtitleCues, type SpeechSegment } from "../lib/subtitles";
import { WEB } from "../platform";
import { useToast } from "./ui";

const LANG: Record<string, string> = { en: "English", fr: "French", nl: "Dutch", es: "Spanish" };

export function TranscriptPanel({ photoId, onSeek }: { photoId: string; onSeek: (seconds: number) => void }) {
  const toast = useToast();
  const [t, setT] = useState<Awaited<ReturnType<typeof api.videoTranscript>> | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [rev, setRev] = useState(0);
  // The line being corrected (by its place in the list), and its words.
  const [editing, setEditing] = useState<{ i: number; text: string } | null>(null);
  useEffect(() => {
    if (WEB) return setT(null);
    let live = true;
    api.videoTranscript(photoId).then((r) => live && setT(r)).catch(() => live && setT(null));
    return () => { live = false; };
  }, [photoId, rev]);

  const lines: SpeechSegment[] = t?.state === "done" ? subtitleCues(speechSegments(t.segments)) : [];
  const now = async () => {
    setBusy(true);
    try {
      await api.transcribeVideo(photoId);
      setRev((r) => r + 1);
    } catch (e) {
      toast(errorText(e) === "not on this Mac yet" ? "Play it once so a copy is on this Mac, then try again" : errorText(e), { error: true });
    } finally {
      setBusy(false);
    }
  };
  // A corrected line replaces the timed pieces it was made of.
  const saveLine = async (i: number, text: string) => {
    if (!t) return;
    const raw = speechSegments(t.segments);
    const line = lines[i];
    const kept = raw.filter((s) => s.end <= line.start || s.start >= line.end);
    const next = [...kept, { start: line.start, end: line.end, text: text.trim() }].filter((s) => s.text).sort((a, b) => a.start - b.start);
    try {
      await api.setTranscriptLines(photoId, next);
      setEditing(null);
      setRev((r) => r + 1);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const moment = async (s: SpeechSegment) => {
    try {
      await api.addVideoMoment(photoId, s.start, s.end);
      toast(`Moment ${formatDuration(s.start)}–${formatDuration(s.end)} marked`);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };

  if (WEB) return <p className="meta">Transcripts are made on the Mac.</p>;
  if (t === undefined) return <p className="meta">Reading…</p>;
  if (!t) {
    return (
      <div className="tr-empty">
        <p className="meta">Not transcribed yet. The Mac does it by itself on mains power, newest first.</p>
        <button type="button" className="btn quiet small" disabled={busy} onClick={() => void now()}>{busy ? "Listening…" : "Transcribe now"}</button>
      </div>
    );
  }
  if (t.state === "no_speech") return <p className="meta">No speech in this clip.</p>;
  if (t.state === "failed") {
    return (
      <div className="tr-empty">
        <p className="meta">The transcript couldn't be made: {t.error}</p>
        <button type="button" className="btn quiet small" disabled={busy} onClick={() => void now()}>Try again</button>
      </div>
    );
  }
  return (
    <div className="tr">
      <div className="tr-head">
        <span className="meta">Transcript ({t.corrected ? "corrected" : "automatic"}) · {LANG[t.language] ?? t.language} · {lines.length} {lines.length === 1 ? "line" : "lines"}</span>
        <button type="button" className="link" onClick={() => void navigator.clipboard.writeText(t.text).then(() => toast("Transcript copied"), () => toast("Couldn't copy", { error: true }))}>Copy text</button>
      </div>
      <ol className="tr-lines">
        {lines.map((s, i) => (
          <li key={i}>
            {editing?.i === i ? (
              <form className="tr-edit" onSubmit={(e) => { e.preventDefault(); void saveLine(i, editing.text); }}>
                <span className="tr-time">{formatDuration(s.start)}</span>
                <input autoFocus value={editing.text} aria-label="Correct this line" onChange={(e) => setEditing({ i, text: e.target.value })} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setEditing(null))} onBlur={() => void saveLine(i, editing.text)} />
              </form>
            ) : (
              <button type="button" className="tr-line" onClick={() => onSeek(s.start)} onDoubleClick={() => setEditing({ i, text: s.text })} title="Click: play from here · double-click: correct it">
                <span className="tr-time">{formatDuration(s.start)}</span>
                <span>{s.text}</span>
              </button>
            )}
            <button type="button" className="tr-moment" aria-label={`Mark ${formatDuration(s.start)}–${formatDuration(s.end)} as a good moment`} title="Make it a good moment" onClick={() => void moment(s)}>★</button>
          </li>
        ))}
      </ol>
    </div>
  );
}
