// Archive: the portfolio website's projects (Andy's Archives). The list in site
// order, then one project at a time: its words in English, French and Dutch, its
// frames in rows as the site shows them, and the album it follows. "Update website"
// renders every library frame with its edit and rebuilds the site's web copies.
// The site's file (src/archive.json) is the only copy; every change saves it whole.
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, assets, errorText, imageUrl } from "../api";
import { Thumb } from "../components/Thumb";
import { Hero, Icon, Modal, Popover, useToast, Select } from "../components/ui";
import { EXPORTS, renderExport } from "../gl/renderer";
import * as A from "../lib/archive";
import { plural } from "../lib/format";
import { useStore } from "../store";
import { NO_ADJUSTMENTS } from "../types";
import { LibraryPicker, type Section, SitePages } from "./SitePages";
import "../styles/archive.css";

const ORIGINAL = EXPORTS.find((e) => e.id === "original")!.spec;
const LANG_NAME: Record<A.Lang, string> = { en: "EN", fr: "FR", nl: "NL" };

/** A part of the project page that folds away once it's filled in; the
 *  choice is remembered per project. */
function useFold(key: string, openWhen: boolean): [boolean, () => void] {
  const read = () => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? openWhen : v === "open";
    } catch {
      return openWhen;
    }
  };
  const [open, setOpen] = useState(read);
  useEffect(() => setOpen(read()), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(key, o ? "closed" : "open");
      } catch {
        /* remembered for this visit only */
      }
      return !o;
    });
  return [open, toggle];
}

type Zoom = "large" | "small";
/** How wide the frames board is at each zoom. */
const ZOOM: Record<Zoom, number> = { large: 1, small: 0.3 };

/** The original file behind each of the site's own web copies. */
type Sources = Record<string, { file: string; date: string }>;

/** Frames found in the library by their original file's name (and date when the
 *  name alone isn't enough), or by a file named after the frame: key → photo id. */
async function findInLibrary(keys: string[], sources: Sources): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const src = sources[k];
    if (src) {
      const rows = await api.listPhotos({ search: src.file, order: "newest" }, 0, 20).catch(() => []);
      const same = rows.filter((r) => r.filename.toLowerCase() === src.file.toLowerCase());
      const dated = same.filter((r) => src.date && r.capturedAt.startsWith(src.date.slice(0, 10)));
      const pick = dated.length === 1 ? dated[0] : same.length === 1 ? same[0] : null;
      if (pick) {
        out[k] = pick.id;
        continue;
      }
    }
    // Or a file named after the frame itself (biphasme-47-2.jpg): what's kept in
    // Drive for frames that never had an original of their own, like film stills.
    const rows = await api.listPhotos({ search: k, order: "newest" }, 0, 20).catch(() => []);
    const named = rows.filter((r) => r.filename.replace(/\.[^.]+$/, "").toLowerCase() === k.toLowerCase());
    if (named.length === 1) out[k] = named[0].id;
  }
  return out;
}

type SiteMedia = Record<string, { type: "image" | "video"; src: string; poster?: string; sizes?: number[]; psizes?: number[] }>;

/** A frame's picture: the library photo when it is one, else the site's own web copy. */
function FrameThumb({ frame, k, media }: { frame?: A.ArchiveFrame; k: string; media: SiteMedia }) {
  if (frame?.photo) return <Thumb id={frame.photo} hash={null} />;
  const m = media[k];
  const src = !m ? null : m.type === "image" ? `${m.src}-${m.sizes?.[0] ?? 640}.jpg` : `${m.poster}${m.psizes && m.psizes.length > 1 ? `-${m.psizes[0]}` : ""}.jpg`;
  return (
    <div className="thumb">
      {src && <img className="site" src={assets.site(src)} alt="" loading="lazy" />}
    </div>
  );
}

export function Archive({ slug }: { slug?: string }) {
  const toast = useToast();
  const { go, albums, editIds } = useStore();
  const [doc, setDoc] = useState<A.ArchiveDoc | null>(null);
  const [media, setMedia] = useState<SiteMedia>({});
  const [sources, setSources] = useState<Sources>({});
  const [failed, setFailed] = useState<string | null>(null);
  const version = useRef("");
  // Saves run one after another, each on the version the last one left.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const textTimer = useRef<number | undefined>(undefined);
  const latest = useRef<A.ArchiveDoc | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.archiveRead();
      version.current = r.version;
      const d = JSON.parse(r.json) as A.ArchiveDoc;
      latest.current = d;
      setDoc(d);
      setMedia(JSON.parse(r.media) as SiteMedia);
      setSources(JSON.parse(r.sources || "{}") as Sources);
      setFailed(null);
    } catch (e) {
      setFailed(errorText(e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const write = useCallback(
    (next: A.ArchiveDoc) => {
      queue.current = queue.current.then(async () => {
        try {
          version.current = await api.archiveWrite(JSON.stringify(next, null, 1), version.current);
        } catch (e) {
          toast(errorText(e), { error: true });
          await load();
        }
      });
      return queue.current;
    },
    [toast, load],
  );

  /** A change to the layout saves at once; typing saves when it pauses. */
  const change = useCallback(
    (next: A.ArchiveDoc, typing = false) => {
      latest.current = next;
      setDoc(next);
      window.clearTimeout(textTimer.current);
      if (typing) textTimer.current = window.setTimeout(() => latest.current && void write(latest.current), 700);
      else void write(next);
    },
    [write],
  );
  // Leaving with typing still unsaved: save it now.
  useEffect(() => () => {
    if (textTimer.current !== undefined) {
      window.clearTimeout(textTimer.current);
      if (latest.current) void write(latest.current);
    }
  }, [write]);

  const project = doc?.projects.find((p) => p.slug === slug) ?? null;

  // Every frame found in the library by its file is connected by itself, so it
  // can be edited here; the rest wait for Connect.
  const autoConnected = useRef(false);
  useEffect(() => {
    if (!doc || autoConnected.current || !Object.keys(sources).length) return;
    autoConnected.current = true;
    const loose = doc.projects.flatMap((p) => A.order(p).filter((k) => !p.frames[k]?.photo));
    findInLibrary(loose, sources)
      .then((found) => {
        const n = Object.keys(found).length;
        const d = latest.current;
        if (!n || !d) return;
        change({
          ...d,
          projects: d.projects.map((p) => ({ ...p, frames: Object.fromEntries(Object.entries(p.frames).map(([k, f]) => [k, !f.photo && found[k] ? { ...f, photo: found[k] } : f])) })),
        });
        toast(`${plural(n, "frame")} connected to your library`);
      })
      .catch(() => {});
  }, [doc, sources, change, toast]);

  // A project made from an album follows it: new photos join, photos taken out leave.
  const albumId = project?.album ?? null;
  useEffect(() => {
    if (!albumId || !slug) return;
    let live = true;
    api
      .archiveAlbumPhotos(albumId)
      .then((ids) => {
        const d = latest.current;
        const p = d?.projects.find((x) => x.slug === slug);
        if (!live || !d || !p) return;
        const next = A.followAlbum(p, ids);
        if (JSON.stringify(next) !== JSON.stringify(p)) change(A.replaceProject(d, slug, next));
      })
      .catch((e) => toast(errorText(e), { error: true }));
    return () => {
      live = false;
    };
  }, [albumId, slug, change, toast]);

  if (failed)
    return (
      <div className="screen scroll">
        <Hero title="Archive" italic="the website" sub="The website's projects couldn't be read." />
        <p className="warnline">{failed}</p>
        <button type="button" className="btn" onClick={() => void load()}>Try again</button>
      </div>
    );
  if (!doc) return <div className="screen scroll" />;
  if (slug && project)
    return (
      <ProjectPage
        doc={doc}
        p={project}
        media={media}
        sources={sources}
        albumName={albums.find((a) => a.id === project.album)?.name ?? null}
        onChange={(next, typing) => change(A.replaceProject(doc, project.slug, next), typing)}
        onEdit={(photo) => editIds([photo])}
        onBack={() => go({ name: "portfolio" })}
      />
    );
  return <ProjectList doc={doc} media={media} onChange={change} onSaved={() => queue.current} />;
}

// ------------------------------------------------------------------ the list

function ProjectList({ doc, media, onChange, onSaved }: { doc: A.ArchiveDoc; media: SiteMedia; onChange: (d: A.ArchiveDoc) => void; onSaved: () => Promise<unknown> }) {
  const { go, albums } = useStore();
  const [adding, setAdding] = useState(false);
  // The site's parts: the projects, then the other pages (site.json).
  const [part, setPart] = useState<"projects" | Section>(() => {
    try {
      return (localStorage.getItem("archive.part") as "projects" | Section) || "projects";
    } catch {
      return "projects";
    }
  });
  const pickPart = (p: "projects" | Section) => {
    setPart(p);
    try {
      localStorage.setItem("archive.part", p);
    } catch {
      /* this visit only */
    }
  };
  const work = doc.projects.filter((p) => !p.notebook && !p.proposal);
  const notebook = doc.projects.filter((p) => p.notebook && !p.proposal);
  const proposals = doc.projects.filter((p) => p.proposal);
  // A proposal becomes a real project: kept in place, just no longer a proposal.
  const adopt = (p: A.ArchiveProject, asNotebook: boolean) =>
    onChange(A.moveProject({ ...doc, projects: doc.projects.map((x) => (x.slug === p.slug ? { ...x, proposal: false } : x)) }, p.slug, asNotebook ? doc.projects.length : work.length, asNotebook));
  const frames = doc.projects.reduce((n, p) => n + A.order(p).length, 0);

  const row = (p: A.ArchiveProject) => {
    const i = doc.projects.indexOf(p);
    const group = p.proposal ? proposals : p.notebook ? notebook : work;
    const at = group.indexOf(p);
    const album = albums.find((a) => a.id === p.album);
    return (
      <div key={p.slug} className="archive-row">
        <button type="button" className="archive-open" onClick={() => go({ name: "portfolio", slug: p.slug })} aria-label={`Open ${p.title}`}>
          <span className="archive-cover">
            <FrameThumb frame={p.frames[p.cover]} k={p.cover} media={media} />
          </span>
          <span className="archive-name">
            <strong>
              {p.title}
              {p.proposal && <span className="tag t-idle proposal-tag">Proposal</span>}
            </strong>
            <span className="meta">{[p.kind.en, p.place.en, p.year].filter(Boolean).join(" · ")}</span>
          </span>
          <span className="meta">{album ? `album ${album.name}` : ""}</span>
          <span className="meta">{plural(A.order(p).length, "frame")}</span>
        </button>
        <span className="row-flex" style={{ gap: 4 }}>
          <button type="button" className="btn small quiet" disabled={at === 0} onClick={() => onChange(A.moveProject(doc, p.slug, i - 1))} aria-label={`Move ${p.title} up`}>↑</button>
          <button type="button" className="btn small quiet" disabled={at === group.length - 1} onClick={() => onChange(A.moveProject(doc, p.slug, i + 1))} aria-label={`Move ${p.title} down`}>↓</button>
          {p.proposal ? (
            <>
              <button type="button" className="btn small quiet" onClick={() => adopt(p, false)} title="No longer a proposal: a Work project">To Work</button>
              <button type="button" className="btn small quiet" onClick={() => adopt(p, true)} title="No longer a proposal: a Notebook series">To Notebook</button>
            </>
          ) : (
            <button type="button" className="btn small quiet" onClick={() => onChange(A.moveProject(doc, p.slug, p.notebook ? work.length : doc.projects.length, !p.notebook))}>
              {p.notebook ? "To Work" : "To Notebook"}
            </button>
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="screen scroll">
      <Hero title="Archive" italic="the website" sub={`${plural(doc.projects.length, "project")} · ${plural(frames, "frame")} · Andy's Archives, not published`}>
        <button type="button" className="btn quiet" onClick={() => setAdding(true)}>{Icon.plus()} New project</button>
        <UpdateWebsite doc={doc} onSaved={onSaved} />
      </Hero>
      <div className="st-tabs" role="group" aria-label="Part of the site" style={{ marginBottom: 14, width: "fit-content" }}>
        {(
          [
            ["projects", "Projects"],
            ["brands", "Brand work"],
            ["motion", "Motion"],
            ["names", "Brand names"],
            ["words", "Words & links"],
          ] as ["projects" | Section, string][]
        ).map(([id, label]) => (
          <button key={id} type="button" aria-pressed={part === id} onClick={() => pickPart(id)}>{label}</button>
        ))}
      </div>
      {part !== "projects" ? <SitePages section={part} /> : (<>
      <section className="card" style={{ padding: 8 }}>
        <h3 className="h6" style={{ padding: "8px 10px" }}>Work</h3>
        {work.map(row)}
      </section>
      <section className="card" style={{ padding: 8, marginTop: 16 }}>
        <h3 className="h6" style={{ padding: "8px 10px" }}>Notebook · personal series</h3>
        {notebook.map(row)}
      </section>
      {proposals.length > 0 && (
        <section className="card" style={{ padding: 8, marginTop: 16 }}>
          <h3 className="h6" style={{ padding: "8px 10px" }}>Proposals · new personal series, not yet edited</h3>
          {proposals.map(row)}
        </section>
      )}
      </>)}
      {adding && (
        <NewProject
          doc={doc}
          onClose={() => setAdding(false)}
          onCreate={(p) => {
            onChange(A.moveProject({ ...doc, projects: [...doc.projects, p] }, p.slug, doc.projects.length, p.notebook));
            setAdding(false);
            go({ name: "portfolio", slug: p.slug });
          }}
        />
      )}
    </div>
  );
}

/** A project from an album (it follows the album from then on), or an empty one. */
function NewProject({ doc, onClose, onCreate }: { doc: A.ArchiveDoc; onClose: () => void; onCreate: (p: A.ArchiveProject) => void }) {
  const { albums } = useStore();
  const toast = useToast();
  const used = new Set(doc.projects.map((p) => p.album).filter(Boolean));
  const free = albums.filter((a) => !used.has(a.id));
  const [album, setAlbum] = useState<string>(free[0]?.id ?? "");
  const [title, setTitle] = useState(free[0]?.name ?? "");
  const [notebook, setNotebook] = useState(true);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const ids = album ? await api.archiveAlbumPhotos(album) : [];
      onCreate(A.newProject(doc, title, { album: album || undefined, photoIds: ids, notebook }));
    } catch (e) {
      toast(errorText(e), { error: true });
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New project"
      onClose={onClose}
      foot={
        <>
          <button type="button" className="btn quiet" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!title.trim() || busy} onClick={() => void create()}>Make the project</button>
        </>
      }
    >
      <div className="st-col">
        <label className="st-field">
          <span>From the album</span>
          <Select
            value={album}
            onChange={(e) => {
              const a = albums.find((x) => x.id === e.target.value);
              setAlbum(e.target.value);
              if (a && (!title.trim() || albums.some((x) => x.name === title))) setTitle(a.name);
            }}
          >
            <option value="">No album, start empty</option>
            {free.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {plural(a.photoCount, "photo")}
              </option>
            ))}
          </Select>
        </label>
        <label className="st-field">
          <span>Title on the website</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Monkey's Eyes" />
        </label>
        <div className="st-tabs" role="group" aria-label="Where it goes">
          <button type="button" aria-pressed={!notebook} onClick={() => setNotebook(false)}>Work</button>
          <button type="button" aria-pressed={notebook} onClick={() => setNotebook(true)}>Notebook</button>
        </div>
        <p className="meta">The project follows the album: photos you add to the album join the project, photos you take out leave it.</p>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ update website

/** Renders every library frame with its edit, then runs the site's sync and opens the preview. */
function UpdateWebsite({ doc, onSaved, onDone }: { doc: A.ArchiveDoc; onSaved: () => Promise<unknown>; onDone?: () => void }) {
  const toast = useToast();
  const [state, setState] = useState<string | null>(null);
  const run = async () => {
    const frames = A.libraryFrames(doc);
    const stop = await listen<{ line: string }>("archive-sync", (e) => {
      const m = e.payload.line.match(/^built (.+)$/);
      setState(m ? `Building ${m[1]}…` : e.payload.line);
    });
    try {
      await onSaved();
      const looks = new Map((await api.photoLooks(frames.map((f) => f.photo))).map((l) => [l.photoId, l]));
      const films = new Set((await api.rows([...new Set(frames.map((f) => f.photo))])).filter((r) => r.isVideo).map((r) => r.id));
      for (const [i, f] of frames.entries()) {
        setState(`Rendering ${i + 1} of ${frames.length}`);
        if (films.has(f.photo)) {
          // A film: rendered with its edit and trim (only when they changed).
          const off = await listen<{ key: string; fraction: number }>("archive-clip-progress", (e) => {
            if (e.payload.key === f.key) setState(`Rendering the film ${f.key} · ${Math.round(e.payload.fraction * 100)}%`);
          });
          try {
            await api.archiveWriteClip(f.photo, f.key);
          } finally {
            off();
          }
          continue;
        }
        const look = looks.get(f.photo);
        const bytes = await renderExport(imageUrl("full", f.photo), look?.lookId ?? null, look?.strength ?? 1, { ...NO_ADJUSTMENTS, ...look?.adjustments }, ORIGINAL);
        await api.archiveWriteImage(bytes, f.key, f.photo);
      }
      // Brand films made from library videos, rendered the same way.
      const site = JSON.parse((await api.siteRead()).json) as { brandFilms?: { file: string; photo?: string | null }[] };
      for (const f of (site.brandFilms ?? []).filter((x) => x.photo)) {
        setState(`Rendering the brand film ${f.file}…`);
        await api.archiveWriteClip(f.photo!, `brand-${f.file}`);
      }
      setState("Building the web copies…");
      await api.archiveSync();
      toast("Website updated. Nothing is published.");
      await api.archivePreview();
    } catch (e) {
      toast(errorText(e), { error: true });
    } finally {
      stop();
      setState(null);
      onDone?.();
    }
  };
  return (
    <button type="button" className="btn primary" disabled={state !== null} onClick={() => void run()} title="Render every edited frame and rebuild the site's pictures. Nothing is published.">
      {state ?? "Update website"}
    </button>
  );
}

// ------------------------------------------------------------------ one project

function ProjectPage({
  doc,
  p,
  media,
  sources,
  albumName,
  onChange,
  onEdit,
  onBack,
}: {
  doc: A.ArchiveDoc;
  p: A.ArchiveProject;
  media: SiteMedia;
  sources: Sources;
  albumName: string | null;
  onChange: (p: A.ArchiveProject, typing?: boolean) => void;
  onEdit: (photo: string, key: string) => void;
  onBack: () => void;
}) {
  const [lang, setLang] = useState<A.Lang>("en");
  const keys = A.order(p);
  const set = (patch: Partial<A.ArchiveProject>, typing = true) => onChange({ ...p, ...patch }, typing);
  const setWords = (field: "kind" | "place", v: string) => set({ [field]: { ...p[field], [lang]: v } });
  const partAt = useMemo(() => new Map((p.parts ?? []).map((pt) => [pt.from, pt])), [p.parts]);
  const missing = (w: A.Words) => lang !== "en" && w.en && !w[lang];
  // The words fold into one line once they're there; so do the frames' descriptions and buttons.
  const wordsDone = !!(p.title && p.kind.en && p.intro.en.length);
  const [wordsOpen, toggleWords] = useFold(`archive.fold.${p.slug}.words`, !wordsDone);
  // Dragging: a frame (to join a row, or start one) or a whole row (by its grip).
  const [drag, setDrag] = useState<{ frame: string } | { row: number } | null>(null);
  const [over, setOver] = useState<A.Drop | { rowTo: number } | null>(null);
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  const hover = (d: A.Drop | { rowTo: number }) => setOver((o) => (same(o, d) ? o : d));
  const endDrag = () => {
    setDrag(null);
    setOver(null);
  };
  // Where a drag over row `r` would land: near its top or bottom edge a row
  // of its own above or below; anywhere else in the row, into it, between
  // the frames either side of the pointer.
  const overRow = (e: React.DragEvent<HTMLElement>, r: number) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const box = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - box.top) / box.height;
    if ("row" in drag) return hover({ rowTo: y < 0.5 ? r : r + 1 });
    if (y < 0.2) return hover({ row: r });
    if (y > 0.8 || !A.fits(p, drag.frame, r)) return hover({ row: r + 1 });
    const others = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-frame]")].filter((el) => el.dataset.frame !== drag.frame);
    hover({ into: r, at: others.filter((el) => el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2 < e.clientX).length });
  };
  const dropHere = (e: React.DragEvent) => {
    e.preventDefault();
    if (drag && over) {
      if ("row" in drag && "rowTo" in over) onChange(A.moveRow(p, drag.row, over.rowTo));
      else if ("frame" in drag && !("rowTo" in over)) onChange(A.place(p, drag.frame, over));
    }
    endDrag();
  };
  // Held near the top or bottom while dragging, the page scrolls: faster the closer to the edge.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!drag || !el) return;
    let y = -1;
    const track = (e: DragEvent) => {
      y = e.clientY;
    };
    // A plain timer: it keeps going while the pointer rests at the edge.
    const timer = window.setInterval(() => {
      const b = el.getBoundingClientRect();
      const edge = 110;
      const v = y < 0 ? 0 : y < b.top + edge ? -((b.top + edge - y) / edge) : y > b.bottom - edge ? (y - (b.bottom - edge)) / edge : 0;
      if (v) el.scrollBy(0, Math.round(Math.sign(v) * Math.min(1, Math.abs(v)) * 26));
    }, 16);
    document.addEventListener("dragover", track);
    return () => {
      document.removeEventListener("dragover", track);
      window.clearInterval(timer);
    };
  }, [drag]);
  // Zoom out to see (and rearrange) the whole project at once.
  const [zoom, setZoomState] = useState<Zoom>(() => {
    try {
      return localStorage.getItem("archive.zoom") === "large" ? "large" : "small";
    } catch {
      return "small";
    }
  });
  const setZoom = (z: Zoom) => {
    setZoomState(z);
    try {
      localStorage.setItem("archive.zoom", z);
    } catch {
      /* this visit only */
    }
  };
  const scale = ZOOM[zoom];

  // Which frames are films (library videos), to mark them and render them as films.
  const linked = useMemo(() => keys.map((k) => p.frames[k]?.photo).filter((x): x is string => !!x), [keys, p.frames]);
  const [videos, setVideos] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!linked.length) return setVideos(new Set());
    api.rows(linked).then((r) => setVideos(new Set(r.filter((x) => x.isVideo).map((x) => x.id)))).catch(() => {});
  }, [linked.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // Frames made outside the app: found in the library by their original file's name.
  const unlinked = keys.filter((k) => !p.frames[k]?.photo);
  const [found, setFound] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    findInLibrary(unlinked, sources).then((out) => live && setFound(out)).catch(() => {});
    return () => {
      live = false;
    };
  }, [unlinked.join(","), sources]); // eslint-disable-line react-hooks/exhaustive-deps
  const connect = (pairs: Record<string, string>) =>
    onChange({ ...p, frames: Object.fromEntries(Object.entries(p.frames).map(([k, f]) => [k, pairs[k] ? { ...f, photo: pairs[k] } : f])) });
  const [connectFor, setConnectFor] = useState<string | null>(null);
  // Frames whose edit the website doesn't show yet.
  const [waiting, setWaiting] = useState<Set<string>>(new Set());
  const linkedFrames = keys.filter((k) => p.frames[k]?.photo).map((k) => ({ key: k, photo: p.frames[k].photo as string }));
  const refreshWaiting = useCallback(() => {
    // Waiting: edited (or reset) since the site last got it; unedited frames keep the site's own copy.
    api.archiveFrameStatus(linkedFrames).then((r) => setWaiting(new Set(r.filter((x) => !x.upToDate && (x.edited || x.published)).map((x) => x.key)))).catch(() => {});
  }, [JSON.stringify(linkedFrames)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => refreshWaiting(), [refreshWaiting]);
  const [captionFor, setCaptionFor] = useState<{ key: string; at: HTMLElement } | null>(null);
  const setCaption = (k: string, text: string) => {
    const f = p.frames[k];
    set({ frames: { ...p.frames, [k]: { photo: f?.photo ?? null, alt: { ...(f?.alt ?? { en: "", fr: "", nl: "" }), [lang]: text } } } });
  };
  const summary = [p.title || "Untitled", p.kind[lang] || p.kind.en, p.year, p.place[lang] || p.place.en, p.intro[lang].length ? "intro ✓" : "no intro yet", plural(p.credit.length, "credit")]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="screen scroll" ref={scroller}>
      <Hero
        title={p.title || "Untitled"}
        italic={p.proposal ? "proposal" : p.notebook ? "notebook" : "work"}
        crumb={
          <button type="button" className="link" onClick={onBack}>
            {Icon.back()} Archive
          </button>
        }
        sub={`${plural(keys.length, "frame")}${albumName ? ` · follows the album ${albumName}` : ""} · andyssarchives.com/work/${p.slug}`}
      >
        <button type="button" className="btn quiet" onClick={() => void api.archivePreview(`/work/${p.slug}`)}>See it on the site</button>
        {waiting.size > 0 && <UpdateWebsite doc={doc} onSaved={() => Promise.resolve()} onDone={refreshWaiting} />}
        <div className="st-tabs" role="group" aria-label="Language">
          {A.LANGS.map((l) => (
            <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)}>
              {LANG_NAME[l]}
            </button>
          ))}
        </div>
      </Hero>

      <section className="card archive-words">
        <button type="button" className="archive-fold" aria-expanded={wordsOpen} onClick={toggleWords}>
          <span className="h6">Words</span>
          <span className="meta archive-sum">{wordsOpen ? `${LANG_NAME[lang]} · title, kind, year, place, introduction, credits` : summary}</span>
          <span className="archive-chev" aria-hidden="true">{wordsOpen ? "▴" : "▾"}</span>
        </button>
        {wordsOpen && (<>
        <div className="st-three">
          <label className="st-field">
            <span>Title · every language</span>
            <input value={p.title} onChange={(e) => set({ title: e.target.value })} />
          </label>
          <label className="st-field">
            <span>Kind · {LANG_NAME[lang]}</span>
            <input value={p.kind[lang]} placeholder={missing(p.kind) ? p.kind.en : "Portrait, For Studio Arno…"} onChange={(e) => setWords("kind", e.target.value)} />
          </label>
          <label className="st-field">
            <span>Year</span>
            <input value={p.year} onChange={(e) => set({ year: e.target.value })} />
          </label>
        </div>
        <label className="st-field">
          <span>Place · {LANG_NAME[lang]}</span>
          <input value={p.place[lang]} placeholder={missing(p.place) ? p.place.en : "Left empty when not confirmed"} onChange={(e) => setWords("place", e.target.value)} />
        </label>
        <label className="st-field">
          <span>Introduction · {LANG_NAME[lang]} · a blank line starts a new paragraph</span>
          <textarea
            rows={5}
            value={p.intro[lang].join("\n\n")}
            placeholder={lang !== "en" ? p.intro.en.join("\n\n") : ""}
            onChange={(e) => set({ intro: { ...p.intro, [lang]: e.target.value.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean) } })}
          />
        </label>
        <label className="st-field">
          <span>Credits · one per line, "Role: Name" · roles are translated by the site</span>
          <textarea rows={3} value={p.credit.join("\n")} onChange={(e) => set({ credit: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })} />
        </label>
        </>)}
      </section>

      <div className="row-flex" style={{ margin: "22px 4px 4px", alignItems: "center" }}>
        <h3 className="h6" style={{ margin: 0 }}>Frames, as the site shows them</h3>
        <div className="st-tabs" role="group" aria-label="Zoom" style={{ marginLeft: "auto" }}>
          {(Object.keys(ZOOM) as Zoom[]).map((z) => (
            <button key={z} type="button" aria-pressed={zoom === z} onClick={() => setZoom(z)}>
              {z === "large" ? "Large" : "Small"}
            </button>
          ))}
        </div>
      </div>
      {unlinked.length > 0 && (
        <div className="warnline" style={{ margin: "0 4px 10px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: 1 }}>
            {plural(unlinked.length, "frame")} {unlinked.length === 1 ? "isn't" : "aren't"} connected to your library yet, so {unlinked.length === 1 ? "it" : "they"} can't be edited here.
            {Object.keys(found).length > 0 && ` ${Object.keys(found).length} found by file name.`}
          </span>
          {Object.keys(found).length > 0 && (
            <button type="button" className="btn small primary" onClick={() => connect(found)}>Connect {Object.keys(found).length}</button>
          )}
        </div>
      )}
      <p className="meta" style={{ margin: "0 4px 10px" }}>
        Drag a picture into a row to put it with the others (up to three), or near a row's top or bottom edge to give it a row of its own. Drag a row by its handle to move it. Each picture has its tools: Edit, Replace, Caption, Cover, Remove.
      </p>
      <div className={`archive-board ${zoom}`} style={{ width: `${scale * 100}%` }} onDragEnd={endDrag}>
        {p.rows.map((row, r) => {
          const others = drag && "frame" in drag ? row.filter((k) => k !== drag.frame) : row;
          const into = over && "into" in over && over.into === r ? over.at : -1;
          const lineAbove = !!over && (("row" in over && over.row === r) || ("rowTo" in over && over.rowTo === r));
          const lineBelow = r === p.rows.length - 1 && !!over && (("row" in over && over.row === p.rows.length) || ("rowTo" in over && over.rowTo === p.rows.length));
          return (
            <div
              key={row.join(",")}
              className={`archive-band${lineAbove ? " line-above" : ""}${lineBelow ? " line-below" : ""}${drag && "row" in drag && drag.row === r ? " dragging" : ""}`}
              onDragOver={(e) => overRow(e, r)}
              onDrop={dropHere}
            >
              <button
                type="button"
                className="archive-grip"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/x-archive-row", String(r));
                  e.dataTransfer.effectAllowed = "move";
                  setDrag({ row: r });
                }}
                title="Drag to move this row"
                aria-label="Move this row"
              >
                {Icon.grip()}
              </button>
              {partAt.has(row[0]) && <PartHead part={partAt.get(row[0])!} lang={lang} onChange={(pt) => set({ parts: (p.parts ?? []).map((x) => (x.from === pt.from ? pt : x)) })} onEnd={() => onChange(A.endPart(p, row[0]))} />}
              <div className="archive-frames" style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))`, maxWidth: row.length === 1 ? 420 * scale : row.length === 2 ? 760 * scale : undefined }}>
                {row.map((k) => {
                  const f = p.frames[k];
                  const pos = others.indexOf(k);
                  const bar = into < 0 || pos < 0 ? "" : into === pos ? " drop-before" : into === others.length && pos === others.length - 1 ? " drop-after" : "";
                  return (
                    <figure key={k} data-frame={k} className={`archive-frame${p.cover === k ? " is-cover" : ""}${drag && "frame" in drag && drag.frame === k ? " dragging" : ""}${bar}`}>
                      <div
                        className="archive-pic"
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/x-archive-frame", k);
                          e.dataTransfer.effectAllowed = "move";
                          setDrag({ frame: k });
                        }}
                        title="Drag to move"
                      >
                        <FrameThumb frame={f} k={k} media={media} />
                        {(f?.photo ? videos.has(f.photo) : media[k]?.type === "video") && <span className="archive-badge archive-film">Film</span>}
                        {p.cover === k && <span className="archive-badge">Cover</span>}
                        {waiting.has(k) && <span className="archive-badge archive-waiting" title="Edited since the website was last updated: it updates by itself in a few minutes, or press Update website">Updating the site</span>}
                        <div className="archive-tools" role="group" aria-label="Frame">
                          {f?.photo && <button type="button" onClick={() => onEdit(f.photo!, k)} title="Edit: look, sliders, crop">{Icon.edit(12)}<b>Edit</b></button>}
                          <button type="button" onClick={() => setConnectFor(k)} title={f?.photo ? "Use another photo or video from your library" : "Pick this frame's photo or video in your library"}>
                            ⇄<b>{f?.photo ? "Replace" : "Connect"}</b>
                          </button>
                          {zoom === "small" && (
                            <button type="button" className={f?.alt[lang] ? "" : "todo"} onClick={(e) => setCaptionFor({ key: k, at: e.currentTarget })} title={f?.alt[lang] || "Write a caption"}>
                              Aa<b>Caption</b>
                            </button>
                          )}
                          {p.cover !== k && <button type="button" onClick={() => onChange(A.setCover(p, k))} title="Make this the project's cover">{Icon.star(11)}<b>Cover</b></button>}
                          <button type="button" onClick={() => onChange(A.removeFrame(p, k))} title={p.album && f?.photo ? "Comes back while it is in the album: take it out of the album instead" : "Remove from the project"}>{Icon.x(11)}<b>Remove</b></button>
                        </div>
                      </div>
                      {zoom === "large" && (
                        <>
                          <textarea
                            className="st-input"
                            rows={2}
                            value={f?.alt[lang] ?? ""}
                            placeholder={lang !== "en" && f?.alt.en ? f.alt.en : "Caption: what's in the picture"}
                            onChange={(e) => set({ frames: { ...p.frames, [k]: { photo: f?.photo ?? null, alt: { ...(f?.alt ?? { en: "", fr: "", nl: "" }), [lang]: e.target.value } } } })}
                          />
                        </>
                      )}
                    </figure>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {captionFor && (
        <Popover anchor={captionFor.at} onClose={() => setCaptionFor(null)} width={320}>
          <label className="st-field" style={{ padding: 4 }}>
            <span>Caption · {LANG_NAME[lang]}</span>
            <textarea
              className="st-input"
              autoFocus
              rows={3}
              value={p.frames[captionFor.key]?.alt[lang] ?? ""}
              placeholder={lang !== "en" && p.frames[captionFor.key]?.alt.en ? p.frames[captionFor.key].alt.en : "What's in the picture"}
              onChange={(e) => setCaption(captionFor.key, e.target.value)}
            />
          </label>
        </Popover>
      )}
      {connectFor && (
        <LibraryPicker
          title="Connect to your library"
          start={sources[connectFor]?.file.replace(/\.[^.]+$/, "") ?? ""}
          onClose={() => setConnectFor(null)}
          onPick={(photo) => {
            connect({ [connectFor]: photo });
            setConnectFor(null);
          }}
        />
      )}
      {keys.length === 0 && <p className="meta">No frames yet. Add photos to the album, or pick photos in Pictures and choose Add to project.</p>}
      <p className="meta" style={{ margin: "26px 4px" }}>{doc.projects.length} projects on the site. Changes save to the site's files as you make them; Update website rebuilds its pictures.</p>
    </div>
  );
}

function PartHead({ part, lang, onChange, onEnd }: { part: A.ArchivePart; lang: A.Lang; onChange: (p: A.ArchivePart) => void; onEnd: () => void }) {
  return (
    <div className="archive-part st-row">
      <span className="meta">Part</span>
      <input className="st-input" style={{ maxWidth: 260 }} value={part.title[lang]} placeholder={part.title.en} onChange={(e) => onChange({ ...part, title: { ...part.title, [lang]: e.target.value } })} />
      <span className="meta">by</span>
      <input className="st-input" style={{ maxWidth: 220 }} value={part.by} onChange={(e) => onChange({ ...part, by: e.target.value })} />
      <button type="button" className="btn small quiet" onClick={onEnd}>No part here</button>
    </div>
  );
}
