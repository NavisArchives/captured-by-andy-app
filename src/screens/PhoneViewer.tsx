// The phone's viewer (NIRMATA spec §4.3): the picture or clip full bleed on
// black, a human title (place · day, what happens), and Reject · Maybe · Keep
// for looking only (culling is the Cull tab). Swipe left/right to move.
// The desktop keeps Detail.tsx; this only renders when phone() is true.
import { useEffect, useState } from "react";
import { studio } from "../studio/api";
import { useToast } from "../components/ui";
import { api, imageUrl, sizedImageUrl } from "../api";
import { placeholder } from "../components/Thumb";
import { DownloadSheet } from "../components/DownloadSheet";
import { useSwipe } from "../hooks/useSwipe";
import { formatDuration } from "../lib/format";
import { humanName, placeName, shortDay } from "../lib/humanName";
import { WEB, webHooks } from "../platform";
import { useStore, type Route } from "../store";
import type { Album, PhotoDetail } from "../types";

type Load = "loading" | "ready" | "failed";

export function PhoneViewer({ route }: { route: Extract<Route, { name: "detail" }> }) {
  const { back, replace } = useStore();
  const [ids, setIds] = useState<string[] | null>(null);
  const [d, setD] = useState<PhotoDetail | null>(null);
  const [load, setLoad] = useState<Load>("loading");
  const [attempt, setAttempt] = useState(0);
  const [sheet, setSheet] = useState(false);
  // « Add to… » (spec §4): projects and albums; the last one picked stays one tap away.
  const [adding, setAdding] = useState(false);
  // Amendment 9c: download the original or the web copy to the phone.
  const [downloading, setDownloading] = useState(false);
  const [targets, setTargets] = useState<{ projects: { id: string; title: string }[]; albums: Album[] } | null>(null);
  const [sticky, setSticky] = useState<Target | null>(() => readTarget());
  const toast = useToast();
  const openAdd = async () => {
    setAdding(true);
    const [pieces, albums] = await Promise.all([studio.list("pieces").catch(() => []), api.listAlbums().catch(() => [])]);
    setTargets({ projects: pieces.filter((p) => p.stage !== "posted" && p.stage !== "reviewed" && !p.parked).map((p) => ({ id: p.id, title: p.title })), albums });
  };
  const addTo = async (t: Target) => {
    if (!d) return;
    try {
      if (t.kind === "project") await studio.link("pieceMedia", t.id, d.id, true);
      else await api.albumAdd(t.id, [d.id]);
      setSticky(t);
      writeTarget(t);
      setAdding(false);
      toast(`Added to ${t.name}`);
    } catch {
      toast("Couldn't add it. Try again.", { error: true });
    }
  };
  const [chrome, setChrome] = useState(true);

  useEffect(() => {
    let live = true;
    api.photoIds(route.query, 0, 200_000).then((r) => live && setIds(r)).catch(() => live && setIds([route.id]));
    return () => { live = false; };
  }, [JSON.stringify(route.query)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let live = true;
    setLoad("loading");
    setD(null);
    api.detail(route.id).then((x) => live && setD(x)).catch(() => live && setLoad("failed"));
    return () => { live = false; };
  }, [route.id, attempt]);
  // The overlay bar fades after a moment; a tap brings it back.
  useEffect(() => {
    setChrome(true);
    const t = window.setTimeout(() => setChrome(false), 2000);
    return () => window.clearTimeout(t);
  }, [route.id]);

  const index = ids ? Math.max(0, ids.indexOf(route.id)) : route.index;
  const total = ids?.length ?? 0;
  const goTo = (i: number) => {
    if (!ids || i < 0 || i >= ids.length) return;
    replace({ name: "detail", id: ids[i], query: route.query, index: i });
  };
  // The neighbours' pictures, ready before the swipe.
  useEffect(() => {
    if (!ids) return;
    for (const j of [index + 1, index + 2, index - 1]) if (ids[j]) new Image().src = sizedImageUrl("preview", ids[j], window.innerWidth);
  }, [ids, index]);

  const swipe = useSwipe((dir) => (dir === "left" ? goTo(index + 1) : dir === "right" ? goTo(index - 1) : dir === "down" ? back() : undefined));

  const isVideo = !!d?.isVideo;
  const noCopy = WEB && isVideo && !!webHooks.videoAvailable && !!d && !webHooks.videoAvailable(d.id);
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  // The trip: the folder being browsed, else the first folder under the camera archive.
  const parts = d?.assets.find((a) => a.isPrimary)?.path.split("/") ?? [];
  const cam = parts.findIndex((x) => x.toUpperCase() === "CAMERA");
  const trip = route.query.folder?.split("/").filter(Boolean).pop() ?? (cam >= 0 && parts[cam + 2] ? parts[cam + 1] : parts.slice(-2, -1)[0]);
  const named = d ? humanName(d.filename) : { place: null, what: null };
  const place = named.place ?? (trip ? placeName(trip) : null);
  const title = [place, d ? shortDay(d.capturedAt) : null].filter(Boolean).join(" · ");
  const what = [named.what, isVideo && d?.duration ? formatDuration(d.duration) : null].filter(Boolean).join(" · ");
  const failSay = noCopy
    ? d?.review === "rejected"
      ? "Rejected clip: it has no phone copy, so only its still shows here."
      : "This clip isn't on the phone yet. It uploads from the Mac when the app is open there."
    : load === "failed"
      ? offline ? "You're offline. Showing what's saved on this phone." : isVideo ? "Couldn't play this one." : "Couldn't load this one."
      : null;

  return (
    <div className="phone-viewer" {...swipe} onClick={() => setChrome((c) => !c)}>
      <div className="pv-stage" style={d?.thumbhash && load !== "ready" ? { backgroundImage: `url(${placeholder(d.thumbhash)})` } : undefined}>
        {d && !isVideo && (
          <img
            key={`${d.id}-${attempt}`}
            src={sizedImageUrl("preview", d.id, window.innerWidth)}
            alt=""
            className={load === "ready" ? "in" : ""}
            onLoad={() => setLoad("ready")}
            onError={(e) => { e.currentTarget.style.visibility = "hidden"; setLoad("failed"); }}
          />
        )}
        {d && isVideo && noCopy && (
          <img key={`${d.id}-still`} src={sizedImageUrl("preview", d.id, window.innerWidth)} alt="" className="in" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
        )}
        {d && isVideo && !noCopy && (
          <video
            key={`${d.id}-${attempt}`}
            src={imageUrl("video", d.id)}
            poster={imageUrl("preview", d.id)}
            playsInline
            controls
            muted
            preload="metadata"
            onLoadedData={() => setLoad("ready")}
            onError={() => setLoad("failed")}
            onClick={(e) => e.stopPropagation()}
          />
        )}
        {load === "loading" && !noCopy && <span className="pv-ring" aria-label="Loading" />}
      </div>

      <div className={`pv-top${chrome ? "" : " hide"}`} onClick={(e) => e.stopPropagation()}>
        <button type="button" className="pv-icon" aria-label="Back" onClick={back}>
          <svg width="12" height="20" viewBox="0 0 12 20" aria-hidden="true"><path d="M10 2L2 10l8 8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <span className="pv-count">{total ? `${(index + 1).toLocaleString()} of ${total.toLocaleString()}` : ""}</span>
        <button type="button" className="pv-icon" aria-label="Details" onClick={() => setSheet(true)}>
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6" fill="currentColor" /><circle cx="12" cy="12" r="1.6" fill="currentColor" /><circle cx="19" cy="12" r="1.6" fill="currentColor" /></svg>
        </button>
      </div>

      <div className="pv-bottom" onClick={(e) => e.stopPropagation()}>
        {failSay ? (
          <div className="pv-state" role="status">
            <p>{failSay}</p>
            {!noCopy && <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>Try again</button>}
          </div>
        ) : (
          <div className="pv-caption">
            <b>{title || " "}</b>
            {what && <span>{what}</span>}
          </div>
        )}
        <div className="pv-add">
          {sticky && (
            <button type="button" className="btn primary pv-sticky" disabled={!d} onClick={() => void addTo(sticky)} aria-label={`Add to ${sticky.name}`}>
              <span className="pv-plus" aria-hidden="true">+</span>
              <span className="pv-name">{sticky.name}</span>
            </button>
          )}
          <button type="button" className="btn" disabled={!d} onClick={() => void openAdd()}>Add to…</button>
          <button type="button" className="btn pv-dl" disabled={!d} aria-label="Download" onClick={() => setDownloading(true)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
          </button>
        </div>
      </div>


      {downloading && d && <DownloadSheet photoId={d.id} video={d.isVideo} onClose={() => setDownloading(false)} />}
      {adding && (
        <div className="pv-sheet-wrap" onClick={(e) => { e.stopPropagation(); setAdding(false); }}>
          <div className="pv-sheet" role="dialog" aria-label="Add to" onClick={(e) => e.stopPropagation()}>
            <span className="pv-grab" aria-hidden="true" />
            {!targets ? <p className="pl-empty">Loading…</p> : (
              <>
                <h3 className="pv-h">Projects</h3>
                {targets.projects.length === 0 && <p className="pv-none">No project in progress.</p>}
                {targets.projects.map((p) => (
                  <button key={p.id} type="button" className="pv-target" onClick={() => void addTo({ kind: "project", id: p.id, name: p.title })}>{p.title}</button>
                ))}
                <h3 className="pv-h">Albums</h3>
                {targets.albums.length === 0 && <p className="pv-none">No albums yet.</p>}
                {targets.albums.map((a) => (
                  <button key={a.id} type="button" className="pv-target" onClick={() => void addTo({ kind: "album", id: a.id, name: a.name })}>{a.name}</button>
                ))}
              </>
            )}
            <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}
      {sheet && d && (
        <div className="pv-sheet-wrap" onClick={(e) => { e.stopPropagation(); setSheet(false); }}>
          <div className="pv-sheet" role="dialog" aria-label="Details" onClick={(e) => e.stopPropagation()}>
            <span className="pv-grab" aria-hidden="true" />
            <dl>
              <dt>File</dt><dd>{d.filename}</dd>
              <dt>Taken</dt><dd>{new Date(d.capturedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</dd>
              {(d.cameraMake || d.cameraModel) && (<><dt>Camera</dt><dd>{[d.cameraMake, d.cameraModel].filter(Boolean).join(" ")}</dd></>)}
              {trip && (<><dt>Trip</dt><dd>{placeName(trip)}</dd></>)}
            </dl>
            <button type="button" className="btn" onClick={() => setSheet(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

type Target = { kind: "project" | "album"; id: string; name: string };
function readTarget(): Target | null {
  try {
    const t = JSON.parse(localStorage.getItem("cba-add-target") ?? "null");
    return t && (t.kind === "project" || t.kind === "album") && t.id ? t : null;
  } catch {
    return null;
  }
}
function writeTarget(t: Target) {
  try { localStorage.setItem("cba-add-target", JSON.stringify(t)); } catch { /* private mode */ }
}
