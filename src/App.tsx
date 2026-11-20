import { listen } from "@tauri-apps/api/event";
import { Fragment, useEffect, useRef, useState } from "react";
import { ScreenGuard } from "./components/Guard";
import { SafeMode } from "./components/SafeMode";
import { Shortcuts } from "./components/Shortcuts";
import { api } from "./api";
import { ToastHost, typing, useToast } from "./components/ui";
import { PrepareNotice } from "./components/PrepareCull";
import { DownloadNotice } from "./components/DownloadDialog";
import { SyncNote } from "./components/SyncNote";
import { followWebsite } from "./lib/websiteFollower";
import { Account } from "./screens/Account";
import { Accounts } from "./screens/Accounts";
import { Albums } from "./screens/Albums";
import { Cull } from "./screens/Cull";
import { QuickAdd } from "./screens/QuickAdd";
import { Dashboard } from "./screens/Dashboard";
import { Detail } from "./screens/Detail";
import { Editor } from "./screens/Editor";
import { PostEditor } from "./screens/PostEditor";
import { Posts } from "./screens/Posts";
import { Pictures } from "./screens/Pictures";
import { Settings } from "./screens/Settings";
import { Cleanup } from "./screens/Cleanup";
import { StoreProvider, useStore, type Route } from "./store";
import { PALETTES, applyPalette, currentPalette, type Palette } from "./theme";
import { QuickIdea } from "./studio/QuickIdea";
import { Inspire } from "./studio/Inspire";
import { Ideas } from "./studio/Ideas";
import { Archive } from "./screens/Archive";
import { Write } from "./studio/Write";
import { Pillars } from "./studio/Pillars";
import { Roadmap } from "./studio/Roadmap";
import { WEB, webHooks } from "./platform";
import { TabBar, phoneTitle, type Tab } from "./components/TabBar";
import { PhoneLibrary } from "./screens/PhoneLibrary";
import { PhoneViewer } from "./screens/PhoneViewer";
import { PhoneToday } from "./screens/PhoneToday";
import { PhoneIdeas } from "./studio/PhoneIdeas";
import { SITE } from "./components/MacOnly";
import { ContextMenuHost } from "./components/ContextMenu";
import { Assistant } from "./components/Assistant";
import { EditList } from "./screens/EditList";
import { WebPortfolio, WebSocials } from "./screens/WebReadOnly";
import "./styles.css";
import "./studio/studio.css";
import "./styles/mobile.css";

type NavItem = {
  name: Route["name"];
  label: string;
  also?: Route["name"][];
  /** A thin line before it: making | posting. */
  sep?: boolean;
  /** Needs the Mac's files: left out online. */
  mac?: boolean;
};
/** One app (NIRMATA Amendment 3, 19 Nov): five tabs. Order (Amendment 5): Archive · Edit · Projects · Socials · Portfolio.
 *  Archive is the pictures, Edit lists every edit, Socials plans posts, Portfolio is the website.
 *  Today is home: the « CAPTURED BY ANDY » wordmark opens it, it is not a tab. */
const SECTIONS: (NavItem & { sub: NavItem[] })[] = [
  {
    name: "pictures", label: "Archive", also: ["detail", "albums", "cleanup"],
    sub: [{ name: "pictures", label: "Pictures", also: ["detail"] }, { name: "albums", label: "Albums" }, { name: "cleanup", label: "Clean up" }],
  },
  { name: "edit", label: "Edit", sub: [] },
  {
    name: "ideas", label: "Projects", also: ["inspire", "write", "pillars", "roadmap"],
    sub: [{ name: "ideas", label: "Ideas" }, { name: "inspire", label: "Saved" }, { name: "write", label: "Making" }, { name: "pillars", label: "Pillars" }, { name: "roadmap", label: "Roadmap" }],
  },
  {
    name: "posts", label: "Socials", also: ["post", "accounts", "account"],
    sub: [{ name: "posts", label: "Calendar", also: ["post"] }, { name: "account", label: "Grid", also: ["accounts"] }],
  },
  { name: "portfolio", label: "Portfolio", sub: [] },
];

// Screens where Esc means Back. Pictures (clears picks), the photo page and the
// editor (their own handlers) and Settings (the key recorder) keep Esc.
const ESC_BACK: Route["name"][] = ["post", "posts", "account", "accounts", "albums"];

/** The phone's side menu: sections of the current mode, the Photo ⇄ Studio switch, Settings and Sign out.
 *  Closes on a tap outside, on Esc and after choosing. */
function Drawer({ groups, current, badge, onClose, onSection, onHome, onSettings, onSignOut }: {
  groups: { title: string; nav: NavItem[] }[];
  current: (n: NavItem) => boolean;
  badge: (n: NavItem) => number;
  onClose: () => void;
  onSection: (name: Route["name"]) => void;
  onHome: () => void;
  onSettings: () => void;
  onSignOut?: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    (panel.current?.querySelector<HTMLElement>("button[aria-current]") ?? panel.current?.querySelector<HTMLElement>("button"))?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("keydown", key, true); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="drawer-wrap">
      <div className="drawer-catch" onClick={onClose} />
      <aside className="drawer" ref={panel} role="dialog" aria-modal="true" aria-label="Menu">
        <div className="drawer-head">
          <button type="button" className="drawer-home" title="Today" onClick={onHome}><b>CAPTURED BY ANDY</b><small>Today</small></button>
          <button type="button" className="drawer-x" aria-label="Close menu" onClick={onClose}>×</button>
        </div>
        {groups.map((g) => (
          <nav key={g.title} className="drawer-nav" aria-label={g.title}>
            <h4 className="drawer-group">{g.title}</h4>
            {g.nav.map((n) => (
              <Fragment key={n.name}>
                {n.sep && <hr />}
                <button type="button" aria-current={current(n) ? "page" : undefined} onClick={() => onSection(n.name)}>
                  {n.label}
                  {badge(n) > 0 && <span className="n">{badge(n).toLocaleString()}</span>}
                </button>
              </Fragment>
            ))}
          </nav>
        ))}
        <a className="btn drawer-site" href={SITE} target="_blank" rel="noreferrer">Open my website</a>
        <div className="drawer-foot">
          <button type="button" onClick={onSettings}>Settings</button>
          {onSignOut && <button type="button" onClick={onSignOut}>Sign out</button>}
        </div>
      </aside>
    </div>
  );
}

function Shell() {
  const s = useStore();
  const { route, go, back, counts, scan, sources, selection, editIds, addFolder, mode } = s;
  // Revision 1 « nothing missing »: every section shows everywhere; online, the
  // parts that need the Mac open a one-line note instead of disappearing.
  const NAV = SECTIONS;
  const inSection = (n: NavItem) => route.name === n.name || !!n.also?.includes(route.name);
  const section = NAV.find(inSection);
  const [menu, setMenu] = useState(false);
  // Phones: the sections, the mode switch and the account items live in a side drawer.
  const [drawer, setDrawer] = useState(false);
  useEffect(() => setDrawer(false), [route.name, mode]);
  // Phone width (NIRMATA spec): the Library and the viewer have their own phone screens.
  const [onPhone, setOnPhone] = useState(() => typeof matchMedia === "function" && matchMedia("(max-width: 700px)").matches);
  useEffect(() => {
    const m = matchMedia("(max-width: 700px)");
    const on = () => setOnPhone(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  useEffect(() => { document.documentElement.dataset.route = route.name; }, [route.name]);
  // The website follows your edits: a few seconds after leaving the editor, and
  // every few minutes, edited pictures it doesn't show yet are sent to it.
  const toastSite = useToast();
  const [siteNote, setSiteNote] = useState<string | null>(null);
  useEffect(() => {
    if (route.name === "edit") return;
    let live = true;
    const run = () =>
      followWebsite((t) => live && setSiteNote(t))
        .then((n) => live && n > 0 && toastSite(`Website updated: ${n === 1 ? "1 picture" : `${n} pictures`} with your latest edits`))
        .catch(() => {});
    const first = window.setTimeout(run, 4000);
    const every = window.setInterval(run, 180_000);
    return () => {
      live = false;
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, [route.name, toastSite]);
  // Switching modes slides the screen in from the side of the switch you picked.
  const [slide, setSlide] = useState<"" | "to-studio" | "to-photo">("");
  const firstMode = useRef(true);
  useEffect(() => {
    if (firstMode.current) {
      firstMode.current = false;
      return;
    }
    setSlide(mode === "studio" ? "to-studio" : "to-photo");
    const t = window.setTimeout(() => setSlide(""), 360);
    return () => window.clearTimeout(t);
  }, [mode]);
  const [palette, setPalette] = useState<Palette>(currentPalette);
  const toast = useToast();
  // Background sharp previews (made newest first, within their space).
  const [previews, setPreviews] = useState<{ done: number; total: number } | null>(null);
  // Recognising what's in photos, for searching by content.
  const [recognising, setRecognising] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    const offs: (() => void)[] = [];
    let live = true;
    for (const [event, set] of [["previews-progress", setPreviews], ["labels-progress", setRecognising]] as const) {
      listen<{ done: number; total: number }>(event, (e) => set(e.payload))
        .then((u) => (live ? offs.push(u) : u()))
        .catch(() => {});
    }
    return () => {
      live = false;
      offs.forEach((u) => u());
    };
  }, []);
  // Right after a restore from Settings: say what happened, once.
  useEffect(() => {
    api.restoreNote().then((name) => {
      if (name) toast("Library restored from the chosen backup. Your library as it was before is kept in Settings › Backups, so you can undo this.");
    }).catch(() => {});
  }, [toast]);
  const [help, setHelp] = useState(false);

  // ⌘1–⌘6 jump between sections, even straight from a text field (the post
  // editor saves pending text when it closes); ⌘[ and Esc go back; ? shows
  // every shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "?" && !typing(e) && !document.querySelector(".scrim")) {
        e.preventDefault();
        setHelp(true);
        return;
      }
      if (!e.metaKey || s.cull || s.quickAdd || document.querySelector(".scrim")) return;
      // ⌘N: a new idea, from any screen in either mode.
      if (!e.ctrlKey && !e.shiftKey && !e.altKey && (e.key.toLowerCase() === "n" || e.code === "KeyN")) {
        e.preventDefault();
        s.openQuickIdea();
        return;
      }
      // The physical key too, like the digits below.
      if (e.key === "[" || e.code === "BracketLeft") {
        e.preventDefault();
        if (!e.repeat) back();
        return;
      }
      // The physical number key, so it works on AZERTY (where 1 is "&") too.
      const digit = /^Digit([0-9])$/.exec(e.code)?.[1] ?? (/^[0-9]$/.test(e.key) ? e.key : null);
      const i = digit == null ? -1 : Number(digit) - 1;
      if (i >= 0 && i < NAV.length) {
        e.preventDefault();
        openSection(NAV[i].name);
      }
    };
    // Capture phase: the page is read before any other Esc handler has closed
    // something (React can re-render between listeners), so Esc that closes a
    // popover, a dialog or the phone's post feed never also goes back.
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || typing(e) || s.cull || s.quickAdd || !ESC_BACK.includes(route.name)) return;
      if (document.querySelector(".scrim, .popover, .ig-top.posts")) return;
      e.preventDefault();
      if (!e.repeat) back();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onEsc, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onEsc, true);
    };
  });

  // Finder drags. With dragDropEnabled off, WebKit would open a dropped file
  // or folder in place of the app, so every file drag is claimed here (it has
  // to happen on dragover: that is where WebKit decides). In-app drags carry
  // application/x-cba-* data and go on to their own drop targets.
  useEffect(() => {
    const files = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const claim = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      if (Array.from(e.dataTransfer?.types ?? []).some((t) => t.startsWith("application/x-cba-"))) return;
      // Inspire takes screenshots and recordings dropped on it.
      if ((e.target as HTMLElement | null)?.closest?.("[data-studio-drop]")) return;
      const entry = e.dataTransfer?.items?.[0]?.webkitGetAsEntry?.();
      toast(entry?.isDirectory ? "Add folders with “Add folder…”: nothing is copied or moved" : "Photos come in by indexing their folder", {
        action: { label: "Choose folder…", run: () => void addFolder() },
      });
    };
    window.addEventListener("dragenter", claim, true);
    window.addEventListener("dragover", claim, true);
    window.addEventListener("drop", drop, true);
    return () => {
      window.removeEventListener("dragenter", claim, true);
      window.removeEventListener("dragover", claim, true);
      window.removeEventListener("drop", drop, true);
    };
  }, [addFolder, toast]);

  const openSection = (name: Route["name"]) => {
    // Edit: the list of every edit (« Edit new… » is on it).
    if (name === "edit") return editIds([]);
    if (name === "pictures") return s.openPictures();
    // Profile: straight to the iPhone view of your account (the list when there are several, or none).
    if (name === "account") {
      const only = s.accounts.length === 1 ? s.accounts[0] : null;
      const last = route.name === "account" ? route.id : null;
      return go(last ? { name: "account", id: last } : only ? { name: "account", id: only.id } : { name: "accounts" });
    }
    go({ name } as Route);
  };

  // Transcripts (Amendment 9b): the queue starts with the app; one quiet line while it works.
  const [transcripts, setTranscripts] = useState<{ done: number; total: number; state: string } | null>(null);
  useEffect(() => {
    if (WEB) return;
    void api.transcriptsStart().catch(() => {});
    api.transcriptsStatus().then(setTranscripts).catch(() => {});
    let off: (() => void) | undefined;
    let live = true;
    listen<{ done: number; total: number; state: string }>("transcripts-progress", (e) => setTranscripts(e.payload))
      .then((u) => (live ? (off = u) : u()))
      .catch(() => {});
    return () => { live = false; off?.(); };
  }, []);
  const online = sources.filter((x) => x.online).length;
  const previewsLeft = previews ? previews.total - previews.done : 0;
  const recognisingLeft = recognising ? recognising.total - recognising.done : 0;
  const status = siteNote
    ? siteNote
    : scan?.running
    ? `Scanning ${scan.stats.discovered.toLocaleString()}`
    : (scan?.thumbsQueued ?? 0) > 0
      ? `Thumbnails · ${scan?.thumbsQueued.toLocaleString()} to go`
      : recognisingLeft > 0
        ? `Recognising photos · ${recognisingLeft.toLocaleString()} to go`
        : previewsLeft > 0
        ? `Sharp previews · ${previewsLeft.toLocaleString()} to go`
        : transcripts?.state === "running" && transcripts.done < transcripts.total
        ? `Transcripts: ${transcripts.done.toLocaleString()} of ${transcripts.total.toLocaleString()}`
        : sources.length
        ? online === sources.length
          ? `${sources.length === 1 ? sources[0].label : `${sources.length} folders`} connected`
          : `${sources.length - online} folder offline`
        : "No folders yet";

  return (
    <div className="app">
      <header className="top" inert={s.cull || s.quickAdd ? true : undefined}>
        {/* Phones: one title, 17 px; the brand and the counts live under More. */}
        <h1 className="phone-title phone-only">{phoneTitle(route.name)}</h1>
        <div className="brand-wrap">
          <button type="button" className="brand" aria-current={route.name === "dashboard" || route.name === "today" ? "page" : undefined} title="Today" onClick={() => go({ name: "dashboard" })}>
            <b>CAPTURED BY ANDY</b>
            <i>{counts ? `${counts.all.toLocaleString()} photos` : "photo library"} · <SyncNote /></i>
          </button>
        </div>
        <nav className={slide ? "pills swap" : "pills"} aria-label="Sections">
          {NAV.map((item) => {
            const current = inSection(item);
            return (
              <Fragment key={item.name}>
              {item.sep && <span className="nav-sep" aria-hidden="true" />}
              <button type="button" aria-current={current ? "page" : undefined} onClick={() => openSection(item.name)}>
                {item.label}
                {item.name === "pictures" && counts && counts.unreviewed > 0 && <span className="n">{counts.unreviewed.toLocaleString()}</span>}
              </button>
              </Fragment>
            );
          })}
        </nav>
        <div className="top-right">
          <button type="button" className="chip-btn" onClick={() => go({ name: "settings" })}>
            <i className={`dot ${scan?.running || (scan?.thumbsQueued ?? 0) > 0 || previewsLeft > 0 || recognisingLeft > 0 ? "d-warn" : sources.length && online === sources.length ? "d-ok" : "d-idle"}`} />
            {status}
          </button>
          <button type="button" className="chip-btn" onClick={() => setHelp(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
            <kbd style={{ border: 0, background: "none", padding: 0 }}>?</kbd> Keys
          </button>
          <div className="avatar-wrap">
            <button type="button" className="avatar" aria-haspopup="menu" aria-expanded={menu} aria-label="Palette and settings" onClick={() => setMenu((v) => !v)}>
              AH
            </button>
            {menu && (
              <>
                <div className="menu-catch" onClick={() => setMenu(false)} />
                <div className="umenu" role="menu" onKeyDown={(e) => e.key === "Escape" && setMenu(false)}>
                  <div className="umenu-who">
                    <b>Captured by Andy</b>
                    <small>{WEB ? "online" : "on this Mac"}</small>
                  </div>
                  {PALETTES.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={palette === p.id}
                      className={palette === p.id ? "umenu-item on" : "umenu-item"}
                      onClick={() => {
                        applyPalette(p.id);
                        setPalette(p.id);
                      }}
                    >
                      {p.glyph}&nbsp; {p.label}
                    </button>
                  ))}
                  <hr />
                  <button type="button" role="menuitem" className="umenu-item" onClick={() => { setMenu(false); go({ name: "settings" }); }}>
                    Settings
                  </button>
                  {webHooks.signOut && (
                    <button type="button" role="menuitem" className="umenu-item" onClick={() => webHooks.signOut?.()}>
                      Sign out
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        <button type="button" className="burger phone-only" aria-label="Menu" aria-haspopup="dialog" aria-expanded={drawer} onClick={() => setDrawer(true)}>
          <span aria-hidden="true" />
        </button>
      </header>
      {section && section.sub.length > 1 && (
        <nav className="subnav not-phone" aria-label={`${section.label} pages`} inert={s.cull || s.quickAdd ? true : undefined}>
          {section.sub.map((x) => (
            <button key={x.name} type="button" aria-current={inSection(x) ? "page" : undefined} onClick={() => openSection(x.name)}>{x.label}</button>
          ))}
        </nav>
      )}
      {drawer && (
        <Drawer
          groups={[
            // The tab order (Amendment 5), each tab with what isn't on the phone's bar.
            { title: "Archive", nav: [{ name: "albums", label: "Albums" }, { name: "cleanup", label: "Clean up" }] },
            { title: "Edit", nav: [{ name: "edit", label: "All edits" }] },
            { title: "Projects", nav: [{ name: "pillars", label: "Pillars" }, { name: "roadmap", label: "Roadmap" }] },
            { title: "Socials", nav: [{ name: "posts", label: "Calendar" }, { name: "account", label: "Grid" }] },
            { title: "Portfolio", nav: [{ name: "portfolio", label: "Website projects" }] },
          ]}
          current={(n) => route.name === n.name || !!n.also?.includes(route.name)}
          badge={(n) => (n.name === "pictures" && counts && counts.unreviewed > 0 ? counts.unreviewed : n.name === "edit" && selection.size > 0 ? selection.size : 0)}
          onClose={() => setDrawer(false)}
          onSection={(name) => { setDrawer(false); openSection(name); }}
          onHome={() => { setDrawer(false); go({ name: "dashboard" }); }}
          onSettings={() => { setDrawer(false); go({ name: "settings" }); }}
          onSignOut={webHooks.signOut ? () => { setDrawer(false); webHooks.signOut?.(); } : undefined}
        />
      )}
      <div className={slide ? `route ${slide}` : "route"} inert={s.cull || s.quickAdd || drawer ? true : undefined}>
        <ScreenGuard key={route.name} onHome={() => go({ name: "dashboard" })}>
        {route.name === "dashboard" && (onPhone ? <PhoneToday /> : <Dashboard />)}
        {route.name === "pictures" && (onPhone ? <PhoneLibrary /> : <Pictures />)}
        {route.name === "cleanup" && <Cleanup trip={route.trip} />}
        {route.name === "detail" && (onPhone ? <PhoneViewer route={route} /> : <Detail key={route.id} route={route} />)}
        {route.name === "edit" && (!WEB && route.ids.length ? <Editor key={route.ids.join(",")} route={route} /> : <EditList />)}
        {route.name === "albums" && <Albums />}
        {WEB && (route.name === "posts" || route.name === "post") && <WebSocials view="calendar" />}
        {WEB && (route.name === "accounts" || route.name === "account") && <WebSocials view="grid" />}
        {WEB && route.name === "portfolio" && <WebPortfolio />}
        {!WEB && route.name === "posts" && <Posts />}
        {!WEB && route.name === "post" && <PostEditor key={route.id} id={route.id} />}
        {!WEB && route.name === "accounts" && <Accounts />}
        {!WEB && route.name === "account" && <Account key={route.id} id={route.id} />}
        {route.name === "settings" && <Settings />}
        {route.name === "today" && (onPhone ? <PhoneToday /> : <Dashboard />)}
        {!WEB && route.name === "portfolio" && <Archive key={route.slug ?? "list"} slug={route.slug} />}
        {route.name === "inspire" && (onPhone ? <PhoneIdeas key="insp" start="inspiration" /> : <Inspire key="saves" />)}
        {route.name === "ideas" && (onPhone ? <PhoneIdeas key="ideas" /> : <Ideas />)}
        {route.name === "write" && <Write key={route.id ?? "none"} id={route.id} />}
        {route.name === "pillars" && <Pillars />}
        {route.name === "roadmap" && <Roadmap />}
        </ScreenGuard>
      </div>
      {!s.cull && !s.quickAdd && route.name !== "detail" && (
        <TabBar
          route={route.name}
          more={drawer}
          badge={counts?.unreviewed ?? 0}
          onTab={(t: Tab) => {
            setDrawer(false);
            if (t === "archive") s.openPictures();
            else if (t === "projects") go({ name: "ideas" });
            else if (t === "cull") void s.startCull({ review: "unreviewed", order: "oldest" });
            else setDrawer(true);
          }}
        />
      )}
      {s.cull && <Cull key={s.cull.key} session={s.cull} />}
      {!WEB && <PrepareNotice />}
      {!WEB && <DownloadNotice />}
      {s.quickAdd && <QuickAdd key={s.quickAdd.key} session={s.quickAdd} />}
      {help && <Shortcuts keymap={s.keymap} onClose={() => setHelp(false)} />}
      {!onPhone && <Assistant />}
      {s.quickIdea.open && <QuickIdea saveId={s.quickIdea.saveId} title={s.quickIdea.title} onClose={s.closeQuickIdea} />}
    </div>
  );
}

export default function App() {
  // A library that couldn't open at launch gets its own screen with a way out.
  const [problem, setProblem] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    api.startupProblem().then(setProblem).catch(() => setProblem(null));
  }, []);
  if (problem === undefined) return null;
  if (problem) return <SafeMode message={problem} />;
  return (
    <ToastHost>
      <StoreProvider>
        <ContextMenuHost>
          <Shell />
        </ContextMenuHost>
      </StoreProvider>
    </ToastHost>
  );
}
