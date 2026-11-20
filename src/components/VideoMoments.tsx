// A video player with moments: J / K / L to move through the clip, I and O to
// mark the start and end of a good part, M for sound. One timeline: click or
// drag it to scrub; the moments sit on it. Moments are saved in the library;
// the video file is never touched.
import { invoke } from "@tauri-apps/api/core";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api, errorText, imageUrl } from "../api";
import { eta, useClipSource } from "../lib/clipPreview";
import { bytes, formatDuration } from "../lib/format";
import { useVideoMuted } from "../lib/videoPrefs";
import type { VideoMoment } from "../types";
import { useStore } from "../store";
import { WEB } from "../platform";
import { useToast } from "./ui";

export interface MomentsHandle {
  /** Handles Space J K L I O for this player; returns whether the key was used. */
  handleKey: (e: KeyboardEvent) => boolean;
  /** Jumps to `seconds` and plays (a transcript line clicked). */
  seek: (seconds: number) => void;
}

type Props = {
  photoId: string;
  initialTime?: number;
  autoPlay?: boolean;
  onReady?: () => void;
  onError?: () => void;
  className?: string;
  /** Added in front of the key hints, e.g. how to close the player. */
  extraHint?: string;
};

const RATES = [1, 2, 4];

export const VideoMoments = forwardRef<MomentsHandle, Props>(function VideoMoments({ photoId, initialTime = 0, autoPlay, onReady, onError, className, extraHint }, ref) {
  const toast = useToast();
  const { bump, editIds } = useStore();
  const video = useRef<HTMLVideoElement>(null);
  const [moments, setMoments] = useState<VideoMoment[]>([]);
  const [markIn, setMarkIn] = useState<number | null>(null);
  const [duration, setDuration] = useState(0);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useVideoMuted();
  const track = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  // An online clip plays from its light copy; one without waits for it.
  const [source, playOriginal] = useClipSource(photoId);
  // How long from opening a clip to its first frame, one line in the app's log.
  const opened = useRef(performance.now());
  const timed = useRef(false);
  useEffect(() => {
    opened.current = performance.now();
    timed.current = false;
  }, [photoId]);
  const timeFirstFrame = () => {
    if (WEB || timed.current) return;
    timed.current = true;
    void invoke("ui_log", { text: `first frame ${Math.round(performance.now() - opened.current)} ms · ${photoId} · ${source.kind === "ready" ? "preview or local" : source.kind}` }).catch(() => {});
  };
  const src = source.kind === "ready" ? `${imageUrl("video", photoId)}${source.version ? `?v=${source.version}` : ""}` : source.kind === "original" ? imageUrl("video", photoId) : undefined;

  useEffect(() => {
    let live = true;
    setMarkIn(null);
    setDuration(0);
    setNow(0);
    setMoments([]);
    api.videoMoments(photoId).then((rows) => live && setMoments(rows)).catch(() => live && setMoments([]));
    return () => { live = false; };
  }, [photoId]);

  const add = useCallback(
    async (start: number, end: number) => {
      try {
        const m = await api.addVideoMoment(photoId, start, end);
        setMoments((all) => [...all, m].sort((a, b) => a.start - b.start));
        toast(`Moment kept: ${formatDuration(m.start)}–${formatDuration(m.end)}`);
      } catch (e) {
        toast(errorText(e), { error: true });
      }
    },
    [photoId, toast],
  );

  // G: this frame, full size, as a new photo to edit and post.
  const grabbing = useRef(false);
  const grab = useCallback(async () => {
    const v = video.current;
    if (!v || grabbing.current) return;
    grabbing.current = true;
    v.pause();
    try {
      const id = await api.saveVideoStill(photoId, v.currentTime);
      bump();
      toast(`Frame at ${formatDuration(v.currentTime)} saved as a photo`, { action: { label: "Edit it", run: () => editIds([id]) } });
    } catch (e) {
      toast(errorText(e), { error: true });
    } finally {
      grabbing.current = false;
    }
  }, [photoId, toast, bump, editIds]);

  const handleKey = useCallback(
    (e: KeyboardEvent): boolean => {
      const v = video.current;
      if (!v || e.metaKey || e.ctrlKey || e.altKey) return false;
      if (e.key === " ") {
        // Space plays and pauses, at the speed you were watching.
        if (!e.repeat) {
          if (v.paused) void v.play();
          else v.pause();
        }
        return true;
      }
      const k = e.key.toLowerCase();
      if (k === "k") {
        if (v.paused) void v.play();
        else v.pause();
        v.playbackRate = 1;
        return true;
      }
      if (k === "l") {
        // L plays; L again while playing goes faster.
        const next = v.paused ? 1 : RATES[Math.min(RATES.length - 1, RATES.indexOf(v.playbackRate) + 1)] ?? 1;
        v.playbackRate = next;
        void v.play();
        return true;
      }
      if (k === "j") {
        v.currentTime = Math.max(0, v.currentTime - (e.shiftKey ? 5 : 1));
        return true;
      }
      if (k === "i") {
        setMarkIn(v.currentTime);
        return true;
      }
      if (k === "m") {
        setMuted(!muted);
        return true;
      }
      if (k === "g") {
        void grab();
        return true;
      }
      if (k === "o") {
        const start = markIn ?? 0;
        setMarkIn(null);
        void add(start, v.currentTime);
        return true;
      }
      return false;
    },
    [markIn, add, grab, muted, setMuted],
  );
  useImperativeHandle(ref, () => ({
    handleKey,
    seek: (t: number) => {
      const v = video.current;
      if (!v) return;
      v.currentTime = Math.max(0, t);
      void v.play().catch(() => {});
    },
  }), [handleKey]);

  const remove = async (id: string) => {
    try {
      await api.removeVideoMoment(id);
      setMoments((all) => all.filter((m) => m.id !== id));
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const playFrom = (t: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = t;
    void v.play();
  };
  const pct = (t: number) => `${duration ? Math.min(100, (t / duration) * 100) : 0}%`;

  // One timeline: click or drag anywhere on it to scrub.
  const seekAt = (clientX: number, exact: boolean) => {
    const v = video.current;
    const el = track.current;
    if (!v || !el || !duration) return;
    const r = el.getBoundingClientRect();
    const t = Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
    const fast = (v as HTMLVideoElement & { fastSeek?: (t: number) => void }).fastSeek;
    if (!exact && fast) fast.call(v, t);
    else v.currentTime = t;
    setNow(t);
  };
  const togglePlay = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  };
  const cycleRate = () => {
    const v = video.current;
    if (!v) return;
    const next = RATES[(RATES.indexOf(v.playbackRate) + 1) % RATES.length] ?? 1;
    v.playbackRate = next;
  };

  return (
    <div className={`moments-player ${className ?? ""}`}>
      {(source.kind === "checking" || source.kind === "unavailable") && <div className="vp-waiting">
        <div className="vp-waiting-card" role="status"><b>{source.kind === "checking" ? "Checking clip availability…" : "Clip unavailable online"}</b>
          {source.kind === "unavailable" && <span>{source.note}</span>}
        </div>
      </div>}
      {source.kind === "failed" && (
        <div className="vp-waiting" style={{ backgroundImage: `url("${imageUrl("preview", photoId)}")` }}>
          <div className="vp-waiting-card">
            <b>Couldn't make a preview</b>
            <span>Google Drive didn't hand this clip over just now. It's tried again later; you can play the original meanwhile.</span>
            <button type="button" className="btn quiet small" onClick={playOriginal}>Play the original</button>
          </div>
        </div>
      )}
      {source.kind === "waiting" && (
        <div className="vp-waiting" style={{ backgroundImage: `url("${imageUrl("preview", photoId)}")` }}>
          <div className="vp-waiting-card">
            <b>{source.making ? "Getting this clip ready" : "This clip is next"}</b>
            <span role="status">
              {source.note || (source.making
                ? `Fetching it once from Google Drive (${bytes(source.size)}${eta(source.size, source.speed) ? `, ${eta(source.size, source.speed)}` : ""}). It plays by itself when it's ready, and instantly from then on.`
                : "It starts in a moment and plays by itself when it's ready.")}
            </span>
            <button type="button" className="btn quiet small" onClick={playOriginal}>Play the original instead</button>
          </div>
        </div>
      )}
      <video
        ref={video}
        src={src}
        poster={imageUrl("preview", photoId)}
        playsInline
        autoPlay={autoPlay}
        muted={muted}
        preload="auto"
        onClick={togglePlay}
        onLoadedMetadata={(e) => {
          const length = e.currentTarget.duration;
          setDuration(Number.isFinite(length) ? length : 0);
          if (Number.isFinite(initialTime) && initialTime > 0 && Number.isFinite(length)) e.currentTarget.currentTime = Math.min(initialTime, length);
        }}
        onLoadedData={() => {
          timeFirstFrame();
          onReady?.();
        }}
        onCanPlay={onReady}
        onError={onError}
        onPlay={() => { setPlaying(true); if (!WEB) void api.transcriptsPlaying(true).catch(() => {}); }}
        onPause={() => { setPlaying(false); if (!WEB) void api.transcriptsPlaying(false).catch(() => {}); }}
        onRateChange={(e) => setRate(e.currentTarget.playbackRate)}
        onTimeUpdate={(e) => !scrubbing.current && setNow(e.currentTarget.currentTime)}
      />
      <div className="vp-bar">
        <button type="button" className="vp-btn" aria-label={playing ? "Pause (Space)" : "Play (Space)"} title={playing ? "Pause (Space)" : "Play (Space)"} onClick={togglePlay}>
          {playing ? (
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" /></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" fill="currentColor" /></svg>
          )}
        </button>
        <span className="vp-time">
          {formatDuration(now)} <i>/ {formatDuration(duration)}</i>
        </span>
        <div
          ref={track}
          className="vp-timeline"
          role="slider"
          tabIndex={0}
          aria-valuetext={`${formatDuration(now)} of ${formatDuration(duration)}`}
          onKeyDown={(e) => {
            const v = video.current;
            if (!v || !duration || e.metaKey || e.ctrlKey || e.altKey) return;
            let next: number;
            if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = v.currentTime - (e.shiftKey ? 5 : 1);
            else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = v.currentTime + (e.shiftKey ? 5 : 1);
            else if (e.key === "Home") next = 0;
            else if (e.key === "End") next = duration;
            else return;
            e.preventDefault();
            e.stopPropagation();
            v.currentTime = Math.max(0, Math.min(duration, next));
            setNow(v.currentTime);
          }}
          aria-label="Position"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(now)}
          onPointerDown={(e) => {
            scrubbing.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            seekAt(e.clientX, false);
          }}
          onPointerMove={(e) => scrubbing.current && seekAt(e.clientX, false)}
          onPointerUp={(e) => {
            if (!scrubbing.current) return;
            scrubbing.current = false;
            seekAt(e.clientX, true);
          }}
          onPointerCancel={() => (scrubbing.current = false)}
        >
          <div className="vp-track">
            <i className="vp-played" style={{ width: pct(now) }} />
            {moments.map((m) => (
              <i key={m.id} className="vp-moment" style={{ left: pct(m.start), width: `calc(${pct(m.end)} - ${pct(m.start)})` }} title={`${formatDuration(m.start)}–${formatDuration(m.end)}`} />
            ))}
            {markIn != null && <i className="vp-in" style={{ left: pct(markIn) }} />}
            <i className="vp-head" style={{ left: pct(now) }} />
          </div>
        </div>
        <button type="button" className="vp-btn vp-rate" title="Speed (L)" onClick={cycleRate}>
          {rate}×
        </button>
        <button type="button" className={muted ? "vp-btn vp-sound off" : "vp-btn vp-sound"} aria-pressed={!muted} title={muted ? "Sound is off for all videos · M" : "Sound on · M"} onClick={() => setMuted(!muted)}>
          {muted ? (
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor" /><path d="M17 9l5 6M22 9l-5 6" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor" /><path d="M16.5 8.5a5 5 0 0 1 0 7M19.5 5.5a9 9 0 0 1 0 13" /></svg>
          )}
        </button>
      </div>
      <div className="moments-list">
        {moments.map((m) => (
          <span key={m.id} className="chip">
            <button type="button" className="link" onClick={() => playFrom(m.start)}>{formatDuration(m.start)}–{formatDuration(m.end)}</button>
            <button type="button" className="link" aria-label="Remove this moment" onClick={() => void remove(m.id)}>✕</button>
          </span>
        ))}
        <button type="button" className="btn quiet small" disabled={!duration} onClick={() => void grab()} title="This frame, full size, as a new photo (G)">Save frame</button>
        <span className="meta keys-only">
          {extraHint ? `${extraHint} · ` : ""}
          {markIn != null ? `In at ${formatDuration(markIn)} · O to set the end` : "Space play / pause · J back · L faster · I / O mark a good moment · G save frame · M sound"}
        </span>
      </div>
    </div>
  );
});
