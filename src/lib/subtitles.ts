export interface SpeechSegment { start: number; end: number; text: string }
export function speechSegments(json: string | undefined): SpeechSegment[] {
  try {
    const rows: unknown = JSON.parse(json ?? "[]");
    if (!Array.isArray(rows)) return [];
    return rows.filter((row): row is SpeechSegment => !!row && typeof row === "object" &&
      Number.isFinite(row.start) && Number.isFinite(row.end) && row.start >= 0 && row.end > row.start && typeof row.text === "string")
      .map((row) => ({ ...row, text: row.text.replace(/[\r\n]+/g, " ").trim() })).filter((row) => row.text)
      .sort((a, b) => a.start - b.start);
  } catch { return []; }
}
export function subtitleCues(segments: SpeechSegment[]): SpeechSegment[] {
  const cues: SpeechSegment[] = [];
  for (const s of segments) {
    const last = cues[cues.length - 1];
    if (last && s.start - last.end <= 1 && s.end - last.start <= 6 && last.text.length + s.text.length < 60) {
      last.end = Math.max(last.end, s.end);
      last.text += ` ${s.text}`;
    } else cues.push({ ...s });
  }
  return cues;
}
export function subtitles(segments: SpeechSegment[], format: "srt" | "vtt"): string {
  const time = (seconds: number) => {
    const ms = Math.round(seconds * 1000);
    return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}${format === "srt" ? "," : "."}${String(ms % 1000).padStart(3, "0")}`;
  };
  return (format === "vtt" ? "WEBVTT\n\n" : "") + subtitleCues(segments).map((cue, i) =>
    `${i + 1}\n${time(cue.start)} --> ${time(cue.end)}\n${cue.text.replace(/-->/g, "→")}\n`).join("\n");
}
