import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { Modal, typing, useToast } from "../components/ui";
import { VideoMoments, type MomentsHandle } from "../components/VideoMoments";
import { formatDuration } from "../lib/format";
import { momentManifest, type MomentClip } from "../lib/momentManifest";
import { WEB } from "../platform";
import { studio } from "./api";

export function ProjectMoments({ pieceId, title, ids }: { pieceId: string; title: string; ids: string[] }) {
  const [clips, setClips] = useState<MomentClip[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const [playing, setPlaying] = useState<{ id: string; start: number } | null>(null);
  const player = useRef<MomentsHandle>(null);
  const toast = useToast();
  const key = JSON.stringify(ids);
  useEffect(() => {
    if (WEB) return;
    let live = true;
    setBusy(true);
    setProblem(null);
    const load = async () => {
      const videos = (await api.rows(ids)).filter((r) => r.isVideo);
      const rows: MomentClip[] = [];
      for (let i = 0; i < videos.length; i += 4) rows.push(...await Promise.all(videos.slice(i, i + 4).map(async (r) => ({ id: r.id, filename: r.filename, moments: await api.videoMoments(r.id) }))));
      if (live) setClips(rows);
    };
    void load().catch((e) => live && setProblem(errorText(e))).finally(() => live && setBusy(false));
    return () => { live = false; };
  }, [key, revision]); // IDs are compared by value, not the parent array's identity.
  const count = clips.reduce((n, clip) => n + clip.moments.length, 0);
  const save = async () => {
    setSaving(true);
    try {
      const path = await studio.writePlan(pieceId, "moments.md", momentManifest(title, clips));
      toast(`Saved moments for your editor: ${path.split("/").pop()}`);
    } catch (e) { toast(errorText(e), { error: true }); }
    finally { setSaving(false); }
  };
  return <section className="card st-col">
    <div className="st-row" style={{ justifyContent: "space-between" }}><b>Saved video moments</b>
      {!WEB && <button type="button" className="btn quiet small" disabled={!count || busy || saving || !!problem} onClick={() => void save()}>{saving ? "Saving…" : "Save moments for editor"}</button>}
    </div>
    {WEB ? <p className="meta">Saved video moments are available on the Mac. They are not synchronized to this browser yet.</p>
      : problem ? <div role="alert"><p>{problem}</p><button type="button" className="btn quiet small" onClick={() => setRevision((n) => n + 1)}>Retry moments</button></div>
      : busy ? <p role="status" className="meta">Loading moments…</p>
      : !count ? <p className="meta">No moments in the attached clips yet. Mark a good section with I and O while reviewing a video.</p>
      : <>{clips.filter((clip) => clip.moments.length).map((clip) => <div key={clip.id} className="st-col" style={{ gap: 6 }}><span>{clip.filename}</span><div className="st-row">{clip.moments.map((m) => <button key={m.id} type="button" className="chipbtn" onClick={() => setPlaying({ id: clip.id, start: m.start })}>{formatDuration(m.start)}–{formatDuration(m.end)}</button>)}</div></div>)}
        <p className="meta">{count} moments · source-relative in/out notes saved to 00_PLAN/moments.md for Final Cut, Resolve or another editor.</p></>}
    {playing && <Modal title="Review saved moment" wide onClose={() => { setPlaying(null); setRevision((n) => n + 1); }}>
      <div onKeyDown={(e) => { if (!typing(e.nativeEvent) && player.current?.handleKey(e.nativeEvent)) { e.preventDefault(); e.stopPropagation(); } }}>
        <VideoMoments ref={player} photoId={playing.id} initialTime={playing.start} autoPlay />
      </div>
    </Modal>}
  </section>;
}
