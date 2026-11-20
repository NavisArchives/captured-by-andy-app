// The website's pages beyond the projects: the Brand work logo wall and its
// films, Motion, and the plain list of brands. The site keeps them in one file,
// src/site.json; it is read and written whole (with a version check), and
// anything the app doesn't know about in it is kept as it is.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, assets, errorText } from "../api";
import { Thumb } from "../components/Thumb";
import { Icon, Modal, useToast, Select } from "../components/ui";
import type { PhotoRow } from "../types";

type Lang = "en" | "fr" | "nl";
type Words = Record<Lang, string>;
const LANGS: Lang[] = ["en", "fr", "nl"];

export interface Brand {
  brand: string;
  logo: string | null;
  ratio: number;
  films: string[];
}
export interface BrandFilm {
  file: string;
  brand: string;
  subject: Words;
  role: Words;
  /** Colours for the viewer's wash instead of the poster's (["#f1cf5c", …]); absent = from the poster. */
  tint?: string[];
  /** Where it was shot ("Kuala Lumpur, Malaysia"), shown with the year. */
  place?: Words;
  group: "film" | "camera";
  /** The year it was made ("2024"), shown next to the role; empty when unknown. */
  year?: string;
  /** A film made from a library video (rendered with its edit by Update website). */
  photo?: string | null;
}
export interface MotionItem {
  id: string;
  title: Words;
  place: Words;
  year: string;
}
export interface SiteDoc {
  version: number;
  brands: Brand[];
  brandFilms: BrandFilm[];
  brandList: string[];
  motion: MotionItem[];
  [other: string]: unknown;
}

export type Section = "brands" | "motion" | "names" | "words";
const words = (): Words => ({ en: "", fr: "", nl: "" });

/** Reads site.json, and saves it whole as it changes (typing: when it pauses). */
function useSite() {
  const toast = useToast();
  const [doc, setDoc] = useState<SiteDoc | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const version = useRef("");
  const latest = useRef<SiteDoc | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const timer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const r = await api.siteRead();
      version.current = r.version;
      latest.current = JSON.parse(r.json) as SiteDoc;
      setDoc(latest.current);
      setFailed(null);
    } catch (e) {
      setFailed(errorText(e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const write = useCallback(
    (next: SiteDoc) => {
      queue.current = queue.current.then(async () => {
        try {
          version.current = await api.siteWrite(`${JSON.stringify(next, null, 1)}\n`, version.current);
        } catch (e) {
          toast(errorText(e), { error: true });
          await load();
        }
      });
    },
    [toast, load],
  );
  const change = useCallback(
    (next: SiteDoc, typing = false) => {
      latest.current = next;
      setDoc(next);
      window.clearTimeout(timer.current);
      if (typing) timer.current = window.setTimeout(() => latest.current && write(latest.current), 700);
      else write(next);
    },
    [write],
  );
  useEffect(() => () => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      if (latest.current) write(latest.current);
    }
  }, [write]);
  return { doc, failed, load, change };
}

export function SitePages({ section }: { section: Section }) {
  const { doc, failed, load, change } = useSite();
  const [lang, setLang] = useState<Lang>("en");
  if (failed)
    return (
      <section className="card" style={{ padding: 16 }}>
        <p className="warnline">{failed}</p>
        <button type="button" className="btn" onClick={() => void load()}>Try again</button>
      </section>
    );
  if (!doc) return null;
  const langs = (
    <div className="st-tabs" role="group" aria-label="Language">
      {LANGS.map((l) => (
        <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)}>{l.toUpperCase()}</button>
      ))}
    </div>
  );
  if (section === "brands") return <BrandWork doc={doc} lang={lang} langs={langs} change={change} />;
  if (section === "motion") return <Motion doc={doc} lang={lang} langs={langs} change={change} />;
  if (section === "words") return <WordsAndLinks doc={doc} lang={lang} langs={langs} change={change} />;
  return <BrandNames doc={doc} change={change} />;
}

type Change = (next: SiteDoc, typing?: boolean) => void;
const move = <T,>(list: T[], from: number, to: number) => {
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to > from ? to - 1 : to, 0, x);
  return next;
};

/** How wide a logo's drawing is for its height, measured on the drawn pixels
 *  (empty margins in the file don't count), or null when it can't be read. */
function measureLogo(src: string): Promise<number | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onerror = () => resolve(null);
    img.onload = () => {
      const w0 = img.naturalWidth || 800;
      const h0 = img.naturalHeight || 800;
      const scale = 800 / Math.max(w0, h0);
      const w = Math.max(1, Math.round(w0 * scale));
      const h = Math.max(1, Math.round(h0 * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0, w, h);
      let data: Uint8ClampedArray;
      try {
        data = ctx.getImageData(0, 0, w, h).data;
      } catch {
        return resolve(w0 / h0);
      }
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if (data[(y * w + x) * 4 + 3] > 16) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
      resolve(x1 < 0 ? w0 / h0 : Math.round(((x1 - x0 + 1) / (y1 - y0 + 1)) * 100) / 100);
    };
    img.src = src;
  });
}

/** A logo as the site shows it: black, or the name set in type. */
function Logo({ b }: { b: Brand }) {
  return b.logo ? <img className="site-logo" src={assets.site(b.logo)} alt={b.brand} /> : <span className="site-logo-name">{b.brand || "New brand"}</span>;
}

function BrandWork({ doc, lang, langs, change }: { doc: SiteDoc; lang: Lang; langs: React.ReactNode; change: Change }) {
  const toast = useToast();
  const [picked, setPicked] = useState(0);
  const [dragged, setDragged] = useState<number | null>(null);
  const [addingFilm, setAddingFilm] = useState(false);
  // A library video becomes a brand film, opened by the brand being edited.
  const addFilm = (photo: string, row: PhotoRow | undefined) => {
    const file = `${(b?.brand || "FILM").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "") || "FILM"}_${photo.replace(/-/g, "").slice(-8)}`;
    const film: BrandFilm = { file, brand: b?.brand ?? "", subject: { ...words(), en: row?.filename.replace(/\.[^.]+$/, "") ?? "" }, role: words(), place: words(), group: "film", year: "", photo };
    change({
      ...doc,
      brandFilms: [...doc.brandFilms, film],
      brands: doc.brands.map((x, i) => (i === picked ? { ...x, films: [...x.films, file] } : x)),
    });
    setAddingFilm(false);
  };
  const b = doc.brands[picked];
  const setBrand = (patch: Partial<Brand>, typing = false) => change({ ...doc, brands: doc.brands.map((x, i) => (i === picked ? { ...x, ...patch } : x)) }, typing);
  const setFilm = (file: string, patch: Partial<BrandFilm>, typing = true) =>
    change({ ...doc, brandFilms: doc.brandFilms.map((f) => (f.file === file ? { ...f, ...patch } : f)) }, typing);

  const pickLogo = async () => {
    if (!b) return;
    const path = await openDialog({ multiple: false, filters: [{ name: "Logo", extensions: ["svg", "png", "webp"] }] });
    if (typeof path !== "string") return;
    try {
      const logo = await api.sitePutLogo(path, b.brand);
      // The drawing's own shape (not the file's margins) sizes it next to the others.
      const ratio = await measureLogo(assets.site(logo));
      setBrand(ratio ? { logo, ratio } : { logo });
      if (!path.toLowerCase().endsWith(".svg")) toast("A PNG or WebP logo needs a see-through background, or it shows as a black block");
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };

  return (
    <div className="site-split">
      <section className="card" style={{ padding: 16 }}>
        <div className="row-flex" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <h3 className="h6" style={{ margin: 0 }}>Logo wall, as the page shows it</h3>
          <button type="button" className="btn small quiet" onClick={() => (change({ ...doc, brands: [...doc.brands, { brand: "", logo: null, ratio: 3, films: [] }] }), setPicked(doc.brands.length))}>
            {Icon.plus()} Brand
          </button>
        </div>
        <div className="site-wall">
          {doc.brands.map((x, i) => (
            <button
              key={`${x.brand}-${i}`}
              type="button"
              className={`site-wall-tile${i === picked ? " on" : ""}${dragged === i ? " dragging" : ""}`}
              draggable
              onDragStart={() => setDragged(i)}
              onDragEnd={() => setDragged(null)}
              onDragOver={(e) => dragged !== null && e.preventDefault()}
              onDrop={() => {
                if (dragged === null || dragged === i) return;
                change({ ...doc, brands: move(doc.brands, dragged, dragged < i ? i + 1 : i) });
                setPicked(dragged < i ? i : i);
                setDragged(null);
              }}
              onClick={() => setPicked(i)}
              title="Click to edit · drag to reorder"
            >
              <Logo b={x} />
              <small>{x.films.length ? `${x.films.length} film${x.films.length > 1 ? "s" : ""}` : "no film"}</small>
            </button>
          ))}
        </div>
        <p className="hint" style={{ marginBottom: 0 }}>Five a row on a computer, three on a phone. Clicking a logo on the site plays its films, full width.</p>
      </section>

      {b && (
        <section className="card st-col" style={{ padding: 16 }}>
          <div className="row-flex" style={{ justifyContent: "space-between" }}>
            <h3 className="h6" style={{ margin: 0 }}>{b.brand || "New brand"}</h3>
            <button type="button" className="btn small quiet" onClick={() => (change({ ...doc, brands: doc.brands.filter((_, i) => i !== picked) }), setPicked(Math.max(0, picked - 1)))}>Remove</button>
          </div>
          <label className="st-field">
            <span>Brand</span>
            <input value={b.brand} onChange={(e) => setBrand({ brand: e.target.value }, true)} />
          </label>
          <div className="row-flex" style={{ gap: 10, alignItems: "center" }}>
            <div className="site-logo-box"><Logo b={b} /></div>
            <button type="button" className="btn small quiet" onClick={() => void pickLogo()}>{b.logo ? "Replace logo…" : "Add logo…"}</button>
            {b.logo && <button type="button" className="btn small quiet" onClick={() => setBrand({ logo: null })}>Name instead</button>}
          </div>
          <div className="st-field">
            <span>Size next to the other logos</span>
            <div className="row-flex" style={{ gap: 6 }}>
              <button type="button" className="btn small quiet" onClick={() => setBrand({ ratio: Math.round(b.ratio * 1.12 * 100) / 100 })}>Smaller</button>
              <button type="button" className="btn small quiet" onClick={() => setBrand({ ratio: Math.max(0.3, Math.round((b.ratio / 1.12) * 100) / 100) })}>Bigger</button>
              {b.logo && (
                <button type="button" className="btn small quiet" onClick={() => void measureLogo(assets.site(b.logo!)).then((r) => r && setBrand({ ratio: r }))} title="Measure the drawing again, ignoring empty margins">
                  Measure again
                </button>
              )}
              <span className="meta">{b.ratio}</span>
            </div>
          </div>
          <div className="st-field">
            <span>Films this logo opens, in order</span>
            <div className="chipset">
              {doc.brandFilms.map((f) => {
                const on = b.films.includes(f.file);
                return (
                  <button key={f.file} type="button" className="chipbtn" aria-pressed={on} onClick={() => setBrand({ films: on ? b.films.filter((x) => x !== f.file) : [...b.films, f.file] })}>
                    {f.brand} · {f.subject.en || f.file}
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      )}

      <section className="card" style={{ padding: 16, gridColumn: "1 / -1" }}>
        <div className="row-flex" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <h3 className="h6" style={{ margin: 0 }}>Brand films</h3>
          <span className="row-flex" style={{ gap: 8 }}>
            <button type="button" className="btn small quiet" onClick={() => setAddingFilm(true)}>{Icon.plus()} Film from your library</button>
            {langs}
          </span>
        </div>
        <div className="site-films">
          {doc.brandFilms.map((f) => (
            <div key={f.file} className="site-film">
              {f.photo ? <Thumb id={f.photo} hash={null} /> : <img src={assets.site(`/media/brands/${f.file}.jpg`)} alt="" loading="lazy" />}
              <div className="st-col" style={{ gap: 6 }}>
                <div className="row-flex" style={{ gap: 6 }}>
                  <input className="st-input" value={f.brand} onChange={(e) => setFilm(f.file, { brand: e.target.value })} aria-label="Brand" />
                  <input className="st-input" style={{ width: 72, flex: "none" }} value={f.year ?? ""} placeholder="Year" inputMode="numeric" maxLength={4} onChange={(e) => setFilm(f.file, { year: e.target.value.replace(/\D/g, "") })} aria-label="Year" />
                  <Select className="st-input" value={f.group} onChange={(e) => setFilm(f.file, { group: e.target.value as BrandFilm["group"] }, false)} aria-label="Kind">
                    <option value="film">Film I made</option>
                    <option value="camera">On camera</option>
                  </Select>
                </div>
                <input className="st-input" value={f.subject[lang]} placeholder={lang !== "en" ? f.subject.en : "What it is (Stronger With You)"} onChange={(e) => setFilm(f.file, { subject: { ...f.subject, [lang]: e.target.value } })} aria-label="Subject" />
                <input className="st-input" value={f.role[lang]} placeholder={lang !== "en" ? f.role.en : "Concept, shoot and edit"} onChange={(e) => setFilm(f.file, { role: { ...f.role, [lang]: e.target.value } })} aria-label="Role" />
                <input className="st-input" value={f.place?.[lang] ?? ""} placeholder={lang !== "en" ? f.place?.en : "Where (Kuala Lumpur, Malaysia)"} onChange={(e) => setFilm(f.file, { place: { ...(f.place ?? words()), [lang]: e.target.value } })} aria-label="Place" />
                <div className="row-flex film-tint" style={{ gap: 6 }}>
                  <span className="meta">Colours</span>
                  {(f.tint ?? []).map((c, i) => (
                    <input
                      key={i}
                      type="color"
                      value={c}
                      aria-label={`Colour ${i + 1}`}
                      onChange={(e) => setFilm(f.file, { tint: (f.tint ?? []).map((x, j) => (j === i ? e.target.value : x)) })}
                    />
                  ))}
                  {(f.tint?.length ?? 0) < 4 && (
                    <button type="button" className="btn quiet small" onClick={() => setFilm(f.file, { tint: [...(f.tint ?? []), f.tint?.[f.tint.length - 1] ?? "#e8bb48"] }, false)} title="Add a colour to the wash">
                      {Icon.plus(11)}
                    </button>
                  )}
                  {f.tint ? (
                    <button type="button" className="link" onClick={() => setFilm(f.file, { tint: undefined }, false)}>Clear</button>
                  ) : (
                    <span className="meta">from the poster</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
      {addingFilm && <LibraryPicker title={`A film for ${b?.brand || "this brand"}`} videosOnly onClose={() => setAddingFilm(false)} onPick={addFilm} />}
    </div>
  );
}

/** Pick a photo or video in the library, by name, place or date. */
export function LibraryPicker({ title, start = "", videosOnly, onClose, onPick }: { title: string; start?: string; videosOnly?: boolean; onClose: () => void; onPick: (id: string, row?: PhotoRow) => void }) {
  const [q, setQ] = useState(start);
  const [rows, setRows] = useState<PhotoRow[] | null>(null);
  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      api
        .listPhotos({ search: q.trim() || null, order: "newest", video: videosOnly ? true : null }, 0, 60)
        .then((r) => live && setRows(r))
        .catch(() => live && setRows([]));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [q, videosOnly]);
  return (
    <Modal title={title} onClose={onClose} wide>
      <input className="st-input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="File name (C1028), place, date (2025-10-07)…" style={{ width: "100%", marginBottom: 12 }} />
      {rows && rows.length === 0 && <p className="meta">Nothing found.</p>}
      <div className="archive-connect">
        {(rows ?? []).map((r) => (
          <button key={r.id} type="button" onClick={() => onPick(r.id, r)} title={r.filename}>
            <Thumb id={r.id} hash={r.thumbhash} ready={r.thumb === "ready"} />
            <span>{r.filename}{r.isVideo ? " · film" : ""}</span>
            <small>{r.capturedAt.slice(0, 10)}</small>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function Motion({ doc, lang, langs, change }: { doc: SiteDoc; lang: Lang; langs: React.ReactNode; change: Change }) {
  const set = (i: number, patch: Partial<MotionItem>, typing = true) => change({ ...doc, motion: doc.motion.map((m, j) => (j === i ? { ...m, ...patch } : m)) }, typing);
  return (
    <section className="card" style={{ padding: 16 }}>
      <div className="row-flex" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h3 className="h6" style={{ margin: 0 }}>Motion · the films, in order</h3>
        <span className="row-flex" style={{ gap: 8 }}>
          <button type="button" className="btn small quiet" onClick={() => change({ ...doc, motion: [...doc.motion, { id: "", title: words(), place: words(), year: String(new Date().getFullYear()) }] })}>{Icon.plus()} Film</button>
          {langs}
        </span>
      </div>
      <div className="st-col">
        {doc.motion.map((m, i) => (
          <div key={i} className="site-motion">
            <input className="st-input" value={m.id} placeholder="The film's media key (biphasme-lake)" onChange={(e) => set(i, { id: e.target.value.trim() })} aria-label="Film" />
            <input className="st-input" value={m.title[lang]} placeholder={lang !== "en" ? m.title.en : "Title"} onChange={(e) => set(i, { title: { ...m.title, [lang]: e.target.value } })} aria-label="Title" />
            <input className="st-input" value={m.place[lang]} placeholder={lang !== "en" ? m.place.en : "Short film, place…"} onChange={(e) => set(i, { place: { ...m.place, [lang]: e.target.value } })} aria-label="Line under the title" />
            <input className="st-input" value={m.year} onChange={(e) => set(i, { year: e.target.value })} aria-label="Year" style={{ width: 80 }} />
            <span className="row-flex" style={{ gap: 4 }}>
              <button type="button" className="btn small quiet" disabled={i === 0} onClick={() => change({ ...doc, motion: move(doc.motion, i, i - 1) })} aria-label="Earlier">↑</button>
              <button type="button" className="btn small quiet" disabled={i === doc.motion.length - 1} onClick={() => change({ ...doc, motion: move(doc.motion, i, i + 2) })} aria-label="Later">↓</button>
              <button type="button" className="btn small quiet" onClick={() => change({ ...doc, motion: doc.motion.filter((_, j) => j !== i) })}>Remove</button>
            </span>
          </div>
        ))}
      </div>
      <p className="hint" style={{ marginBottom: 0 }}>A film here is one of the site's films: a project's film (its frame key, e.g. stay-552) or Biphasme's.</p>
    </section>
  );
}

function BrandNames({ doc, change }: { doc: SiteDoc; change: Change }) {
  const [text, setText] = useState(doc.brandList.join("\n"));
  return (
    <section className="card st-col" style={{ padding: 16 }}>
      <h3 className="h6" style={{ margin: 0 }}>Brands I've worked with</h3>
      <p className="meta" style={{ margin: 0 }}>The plain list on the home page and on About. One brand per line, in the order shown.</p>
      <textarea
        className="st-input"
        rows={Math.max(8, doc.brandList.length + 2)}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          change({ ...doc, brandList: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) }, true);
        }}
      />
    </section>
  );
}

/** The site's words, by page, and its links. Empty: the site's own wording. */
const TEXTS: { page: string; title: string; fields: { key: string; label: string; long?: boolean; list?: boolean }[] }[] = [
  { page: "home", title: "Home", fields: [
    { key: "descriptor", label: "Line under the name" },
    { key: "lede", label: "The opening sentence", long: true },
    { key: "languages", label: "Languages line" },
    { key: "based", label: "Where you're based" },
  ] },
  { page: "brand", title: "Brand work", fields: [
    { key: "label", label: "Small line above the title" },
    { key: "lede", label: "Introduction", long: true },
    { key: "contact", label: "Line before the email at the bottom" },
  ] },
  { page: "about", title: "About", fields: [
    { key: "paragraphs", label: "The text · a blank line starts a new paragraph", long: true, list: true },
    { key: "based", label: "Based" },
    { key: "languages", label: "Languages" },
    { key: "background", label: "Background" },
  ] },
  { page: "contact", title: "Contact", fields: [
    { key: "prompt", label: "Line under the email" },
    { key: "based", label: "Based" },
  ] },
];

function WordsAndLinks({ doc, lang, langs, change }: { doc: SiteDoc; lang: Lang; langs: React.ReactNode; change: Change }) {
  const text = (doc.text ?? {}) as Record<string, Record<string, Record<Lang, string | string[]>>>;
  const links = (doc.links ?? {}) as Record<string, string>;
  const setText = (page: string, key: string, value: string | string[]) => {
    const pageText = text[page] ?? {};
    const field = (pageText[key] ?? {}) as Record<Lang, string | string[]>;
    change({ ...doc, text: { ...text, [page]: { ...pageText, [key]: { ...field, [lang]: value } } } }, true);
  };
  return (
    <div className="st-col" style={{ gap: 16 }}>
      <section className="card st-col" style={{ padding: 16 }}>
        <h3 className="h6" style={{ margin: 0 }}>Links · used everywhere on the site</h3>
        {(["email", "instagram", "linkedin"] as const).map((k) => (
          <label key={k} className="st-field">
            <span>{k === "email" ? "Email" : k === "instagram" ? "Instagram" : "LinkedIn"}</span>
            <input value={links[k] ?? ""} onChange={(e) => change({ ...doc, links: { ...links, [k]: e.target.value.trim() } }, true)} />
          </label>
        ))}
      </section>
      {TEXTS.map((t) => (
        <section key={t.page} className="card st-col" style={{ padding: 16 }}>
          <div className="row-flex" style={{ justifyContent: "space-between" }}>
            <h3 className="h6" style={{ margin: 0 }}>{t.title}</h3>
            {langs}
          </div>
          {t.fields.map((f) => {
            const v = text[t.page]?.[f.key]?.[lang];
            const en = text[t.page]?.[f.key]?.en;
            const shown = Array.isArray(v) ? v.join("\n\n") : v ?? "";
            const hint = Array.isArray(en) ? en.join("\n\n") : en ?? "";
            return (
              <label key={f.key} className="st-field">
                <span>{f.label} · {lang.toUpperCase()}</span>
                {f.long ? (
                  <textarea
                    rows={f.list ? 8 : 3}
                    value={shown}
                    placeholder={lang !== "en" && hint ? hint : "Empty: the site's own wording"}
                    onChange={(e) => setText(t.page, f.key, f.list ? e.target.value.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean) : e.target.value)}
                  />
                ) : (
                  <input value={shown} placeholder={lang !== "en" && hint ? hint : "Empty: the site's own wording"} onChange={(e) => setText(t.page, f.key, e.target.value)} />
                )}
              </label>
            );
          })}
        </section>
      ))}
    </div>
  );
}
