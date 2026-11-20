// The phone's and browser's Download sheet (NIRMATA Amendment 9c). It lists
// what can really be fetched from Drive with pixel size and file size; sizes
// that only the Mac can make are shown greyed with that reason. Saving goes
// through the phone's share sheet so it lands in Photos.
import { useEffect, useRef, useState } from "react";
import type { Option, Options } from "../web/download";

/** Same limits as web/download.ts (kept here so the demo shows them too). */
const IN_MEMORY_MAX = 150e6;
const PHONE_MAX = 2e9;
const mb = (b: number | null) => (b == null ? "" : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(0.1, b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB`);
const demo = () => typeof document !== "undefined" && document.documentElement.dataset.demo === "1";

/** The demo has no Drive: fixed sizes and a small generated file. */
async function demoOptions(video: boolean): Promise<Options> {
  return video
    ? {
        signedIn: true,
        video: true,
        made: ["1440p", "1080p", "720p"],
        options: [
          { key: "original", label: "Original", width: 3840, height: 2160, bytes: 412_000_000, fileId: "demo", name: "DJI_0094.MP4", mime: "video/mp4" },
          { key: "web", label: "Web copy", width: 960, height: 540, bytes: 18_400_000, fileId: "demo-web", name: "DJI_0094 540p.mp4", mime: "video/mp4" },
        ],
      }
    : {
        signedIn: true,
        video: false,
        made: [],
        options: [
          { key: "original", label: "Original", width: 6000, height: 4000, bytes: 14_800_000, fileId: "demo", name: "DSC04212.JPG", mime: "image/jpeg" },
          { key: "large", label: "Large JPEG", width: 2048, height: 1365, bytes: null, fileId: "demo", px: 2048, name: "DSC04212 2048.jpg", mime: "image/jpeg" },
        ],
      };
}

export function DownloadSheet({ photoId, video = false, onClose }: { photoId: string; video?: boolean; onClose: () => void }) {
  const [opts, setOpts] = useState<Options | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState<Option | null>(null);
  const [busy, setBusy] = useState<{ key: string; done: number; total: number | null } | null>(null);
  const [ready, setReady] = useState<File | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    (demo() ? demoOptions(video) : import("../web/download").then((m) => m.downloadOptions(photoId)))
      .then((o) => live && setOpts(o))
      .catch(() => live && setOpts({ signedIn: false, options: [], video: false, made: [] }));
    return () => {
      live = false;
    };
  }, [photoId]);
  // Leaving stops a download in progress, and says so.
  useEffect(() => () => abort.current?.abort(), []);

  const start = async (o: Option, confirmed = false) => {
    setProblem(null);
    setSaid(null);
    const size = o.bytes ?? 0;
    // Too big for a phone at all.
    if (size > PHONE_MAX) return setProblem(`${mb(size)} is too large for the phone. Get it on the Mac (Save the original file).`);
    const m = demo() ? null : await import("../web/download");
    // Big files never go through the page's memory: an explicit second tap streams them to Files.
    if (size > IN_MEMORY_MAX) {
      if (!confirmed) return setAsking(o);
      setAsking(null);
      if (m) m.streamToFiles(o);
      setSaid(`Downloading ${mb(size)} to Files (Downloads). It continues while you use the app; from Files you can save it to Photos.`);
      return;
    }
    if (!confirmed && size > (m?.ASK_ABOVE ?? 100e6) && (m ? m.onMobileData() !== false : true)) return setAsking(o);
    setAsking(null);
    abort.current = new AbortController();
    setBusy({ key: o.key, done: 0, total: o.bytes });
    try {
      const file = demo()
        ? new File([new Uint8Array(1024)], o.name, { type: o.mime })
        : await m!.fetchFile(o, (done, total) => setBusy({ key: o.key, done, total }), abort.current.signal);
      setReady(file);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setProblem((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  // The share sheet needs a fresh tap (iPhone), so saving is its own button.
  const save = async () => {
    if (!ready) return;
    if (demo()) return setSaid("Saved (demo)");
    const how = await (await import("../web/download")).saveFile(ready);
    setSaid(how === "shared" ? "Saved" : how === "downloaded" ? "Downloaded" : "Not saved");
    if (how !== "cancelled") setReady(null);
  };

  return (
    <div className="dl-wrap" onClick={onClose}>
      <div className="dl-sheet" role="dialog" aria-label="Download" onClick={(e) => e.stopPropagation()}>
        <span className="pv-grab" aria-hidden="true" />
        <header className="dl-head">
          <b>Download</b>
          <button type="button" className="drawer-x" aria-label="Close" onClick={onClose}>×</button>
        </header>
        {!opts && <p className="meta">Asking Drive for the sizes…</p>}
        {opts && !opts.signedIn && (
          <div className="dl-state">
            <p>Sign in to Drive to get the original.</p>
            <button type="button" className="btn primary" onClick={() => void import("../web/remote").then((r) => r.signIn())}>Sign in to Drive</button>
          </div>
        )}
        {opts?.signedIn && opts.options.length === 0 && <p className="dl-state">This one isn't on Drive yet, so there's nothing to download here. It is on the Mac.</p>}
        {opts?.options
          // For a big video the web copy comes first: the original takes an explicit second tap.
          .slice()
          .sort((a, b) => (opts.video && (a.bytes ?? 0) > IN_MEMORY_MAX ? 1 : 0) - (opts.video && (b.bytes ?? 0) > IN_MEMORY_MAX ? 1 : 0))
          .map((o) => (
          <button key={o.key} type="button" className="dl-row" disabled={!!busy} onClick={() => void start(o)}>
            <span>
              <b>{o.label}</b>
              <small>{[o.width && o.height ? `${o.key === "large" ? "about " : ""}${o.width}×${o.height}` : null, o.bytes != null ? mb(o.bytes) : o.key === "large" ? "a few MB" : null, (o.bytes ?? 0) > PHONE_MAX ? "on the Mac only" : (o.bytes ?? 0) > IN_MEMORY_MAX ? "to Files" : opts.video && o.key === "web" ? "best on the phone" : null].filter(Boolean).join(" · ")}</small>
            </span>
            <span className="dl-go">{busy?.key === o.key ? (busy.total ? `${Math.round((100 * busy.done) / busy.total)}%` : mb(busy.done)) : "Get"}</span>
          </button>
        ))}
        {opts && opts.made.length > 0 && <p className="dl-made">{opts.made.join(" · ")}: made on the Mac</p>}
        {asking && (
          <div className="dl-ask" role="alertdialog" aria-label="Large file">
            <p>{(asking.bytes ?? 0) > IN_MEMORY_MAX ? `${mb(asking.bytes)} goes to Files (not Photos) so the phone stays responsive. On mobile data it uses ${mb(asking.bytes)}.` : `${mb(asking.bytes)} on mobile data? Download it now?`}</p>
            <div className="dl-ask-acts">
              <button type="button" className="btn" onClick={() => setAsking(null)}>Not now</button>
              <button type="button" className="btn primary" onClick={() => void start(asking, true)}>{(asking.bytes ?? 0) > IN_MEMORY_MAX ? "Save to Files" : "Download"}</button>
            </div>
          </div>
        )}
        {busy && (
          <div className="dl-progress">
            <progress max={busy.total ?? undefined} value={busy.done} aria-label="Downloading" />
            <button type="button" className="link" onClick={() => abort.current?.abort()}>Stop</button>
          </div>
        )}
        {ready && (
          <button type="button" className="btn primary dl-save" onClick={() => void save()}>Save {ready.type.startsWith("video") ? "video" : "picture"} to the phone</button>
        )}
        {said && <p className="dl-state" role="status">{said}</p>}
        {problem && <p className="dl-state warn" role="alert">{problem}</p>}
      </div>
    </div>
  );
}

/** Several pictures at once. First a size check (the total, and any file too big
 *  to batch); then groups that each fit in the phone's memory, fetched one file at
 *  a time and handed to the share sheet group by group, so memory is released
 *  between groups. Stop works at any point and says what was saved. */
export function MultiDownloadSheet({ photoIds, onClose }: { photoIds: string[]; onClose: () => void }) {
  type Item = { id: string; o: Option | null };
  const [plan, setPlan] = useState<{ items: Item[]; groups: Item[][]; total: number; tooBig: Item[]; missing: number } | null>(null);
  const [group, setGroup] = useState(0);
  const [fetching, setFetching] = useState<{ done: number; of: number } | null>(null);
  const [ready, setReady] = useState<File[] | null>(null);
  const [saved, setSaved] = useState(0);
  const [said, setSaid] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  // The size check.
  useEffect(() => {
    let live = true;
    (async () => {
      const items: Item[] = [];
      for (const id of photoIds) {
        if (demo()) items.push({ id, o: { key: "original", label: "Original", width: 6000, height: 4000, bytes: 14_000_000, fileId: id, name: `picture-${items.length + 1}.jpg`, mime: "image/jpeg" } });
        else {
          const m = await import("../web/download");
          const o = (await m.downloadOptions(id).catch(() => null))?.options.find((x) => x.key === "original") ?? null;
          items.push({ id, o });
        }
        if (!live) return;
      }
      const ok = items.filter((i) => i.o && (i.o.bytes ?? 0) <= IN_MEMORY_MAX);
      const groups: Item[][] = [];
      let cur: Item[] = [];
      let size = 0;
      for (const i of ok) {
        const b = i.o!.bytes ?? 10e6;
        if (cur.length && size + b > IN_MEMORY_MAX) { groups.push(cur); cur = []; size = 0; }
        cur.push(i);
        size += b;
      }
      if (cur.length) groups.push(cur);
      if (live) setPlan({ items, groups, total: ok.reduce((n, i) => n + (i.o!.bytes ?? 0), 0), tooBig: items.filter((i) => i.o && (i.o.bytes ?? 0) > IN_MEMORY_MAX), missing: items.filter((i) => !i.o).length });
    })();
    return () => { live = false; };
  }, [photoIds]);

  const fetchGroup = async (k: number) => {
    if (!plan) return;
    abort.current = new AbortController();
    const list = plan.groups[k];
    const files: File[] = [];
    setFetching({ done: 0, of: list.length });
    for (const i of list) {
      if (abort.current.signal.aborted) break;
      try {
        files.push(demo() ? new File([new Uint8Array(512)], i.o!.name, { type: i.o!.mime }) : await (await import("../web/download")).fetchFile(i.o!, () => {}, abort.current.signal));
      } catch { /* counted as not saved */ }
      setFetching({ done: files.length, of: list.length });
    }
    setFetching(null);
    if (abort.current.signal.aborted) return setSaid(`Stopped. Saved ${saved} of ${photoIds.length}.`);
    setReady(files);
  };
  const saveGroup = async () => {
    if (!ready || !plan) return;
    let ok = false;
    if (demo()) ok = true;
    else {
      const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
      if (nav.canShare?.({ files: ready })) {
        try { await nav.share({ files: ready }); ok = true; } catch (e) { if ((e as Error).name !== "AbortError") ok = false; }
      } else {
        const m = await import("../web/download");
        for (const f of ready) await m.saveFile(f);
        ok = true;
      }
    }
    const n = ok ? saved + ready.length : saved;
    setSaved(n);
    setReady(null); // memory goes back before the next group
    const next = group + 1;
    if (next < plan.groups.length) { setGroup(next); void fetchGroup(next); }
    else setSaid(`Saved ${n} of ${photoIds.length}.${plan.tooBig.length ? ` ${plan.tooBig.length} too big to batch: save them one by one.` : ""}${plan.missing ? ` ${plan.missing} not on Drive.` : ""}`);
  };

  return (
    <div className="dl-wrap" onClick={onClose}>
      <div className="dl-sheet" role="dialog" aria-label="Download pictures" onClick={(e) => e.stopPropagation()}>
        <span className="pv-grab" aria-hidden="true" />
        <header className="dl-head">
          <b>Download {photoIds.length} {photoIds.length === 1 ? "picture" : "pictures"}</b>
          <button type="button" className="drawer-x" aria-label="Close" onClick={onClose}>×</button>
        </header>
        {!plan && <p className="dl-state">Checking sizes…</p>}
        {plan && (
          <p className="dl-state">
            {plan.items.length - plan.tooBig.length - plan.missing} originals · {mb(plan.total)}
            {plan.groups.length > 1 ? ` · in ${plan.groups.length} groups, so the phone never holds more than ${mb(IN_MEMORY_MAX)}` : ""}
            {plan.tooBig.length ? ` · ${plan.tooBig.length} too big to batch` : ""}
            {plan.missing ? ` · ${plan.missing} not on Drive` : ""}
          </p>
        )}
        {plan && !fetching && !ready && !said && saved === 0 && plan.groups.length > 0 && (
          <button type="button" className="btn primary dl-save" onClick={() => void fetchGroup(0)}>Get the originals</button>
        )}
        {fetching && (
          <div className="dl-progress">
            <progress max={fetching.of} value={fetching.done} aria-label="Downloading" />
            <span className="meta">{plan && plan.groups.length > 1 ? `Group ${group + 1} of ${plan.groups.length} · ` : ""}{fetching.done} of {fetching.of}</span>
            <button type="button" className="link" onClick={() => abort.current?.abort()}>Stop</button>
          </div>
        )}
        {ready && plan && (
          <button type="button" className="btn primary dl-save" onClick={() => void saveGroup()}>
            Save {ready.length} to the phone{plan.groups.length > 1 ? ` (group ${group + 1} of ${plan.groups.length})` : ""}
          </button>
        )}
        {said && <p className="dl-state" role="status">{said}</p>}
      </div>
    </div>
  );
}
