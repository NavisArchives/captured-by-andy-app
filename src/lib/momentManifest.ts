import type { VideoMoment } from "../types";
export interface MomentClip { id: string; filename: string; moments: VideoMoment[] }
export function momentManifest(title: string, clips: MomentClip[]): string {
  const cell = (text: string) => text.replace(/[|\r\n]/g, " ");
  let md = `# ${cell(title)} — saved video moments\n\n`;
  md += "Source-relative seconds. These are selection notes, not an edited timeline. Originals are unchanged.\n\n";
  md += "| Clip | Photo ID | Moment ID | In (s) | Out (s) | Duration (s) |\n|---|---|---|---:|---:|---:|\n";
  for (const clip of clips) for (const m of [...clip.moments].sort((a, b) => a.start - b.start)) {
    if (![m.start, m.end].every(Number.isFinite) || m.start < 0 || m.end <= m.start) continue;
    md += `| ${cell(clip.filename)} | ${cell(clip.id)} | ${cell(m.id)} | ${m.start.toFixed(3)} | ${m.end.toFixed(3)} | ${(m.end - m.start).toFixed(3)} |\n`;
  }
  return md;
}
