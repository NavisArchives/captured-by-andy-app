// A phone-sized Instagram profile, as close to the real app as we can draw it:
// your avatar, stats, bio, highlights (from albums), the 3:4 grid with
// carousel and pin markers, and a post view with swipeable carousels. Every
// photo is drawn with its saved edit, so this is what your profile will look
// like. Icons are drawn here (no Instagram assets).
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { drawEdited, onEditsChanged, releaseEdited, type TileFrame } from "../gl/edited";
import { GRID_TILE, ratioAspect } from "../gl/renderer";
import type { Account, Album, PhotoRow, Post } from "../types";
import { VideoBadge } from "./PhotoGrid";
import { placeholder } from "./Thumb";

// ---------------------------------------------------------------- icons (24 px, 2 px strokes like the app)
const I = ({ children, size = 24, fill = "none", sw = 2 }: { children: ReactNode; size?: number; fill?: string; sw?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
const icons = {
  home: <I><path d="M3.5 10.5 12 3l8.5 7.5V20a1 1 0 0 1-1 1H15v-6.5H9V21H4.5a1 1 0 0 1-1-1z" /></I>,
  search: <I><circle cx="10.5" cy="10.5" r="7" /><path d="M21 21l-5.5-5.5" /></I>,
  add: <I><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M12 8v8M8 12h8" /></I>,
  reels: <I><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M3 8.5h18M9 3l3 5.5M14.5 3l3 5.5" /><path d="M10 12.2v5.1l4.3-2.55z" fill="currentColor" stroke="none" /></I>,
  messages: <I><path d="M21 12a8.5 8.5 0 0 1-12.4 7.6L3.5 21l1.4-4.9A8.5 8.5 0 1 1 21 12z" /><path d="M7.5 13.5l3-3 2.5 2 3.5-3.5" /></I>,
  reposts: <I><path d="M17 3l3 3-3 3M20 6H8a4 4 0 0 0-4 4v1M7 21l-3-3 3-3M4 18h12a4 4 0 0 0 4-4v-1" /></I>,
  menu: <I><path d="M4 6.5h16M4 12h16M4 17.5h16" /></I>,
  plus: <I><path d="M12 5v14M5 12h14" /></I>,
  chevron: <I size={14} sw={2.4}><path d="M6 9l6 6 6-6" /></I>,
  back: <I sw={2.2}><path d="M15 5l-7 7 7 7" /></I>,
  grid: <I><rect x="3" y="3" width="18" height="18" rx="1.5" /><path d="M9 3v18M15 3v18M3 9h18M3 15h18" /></I>,
  tagged: <I><path d="M5 20a7 7 0 0 1 14 0" /><circle cx="12" cy="9" r="3.5" /><rect x="3" y="3" width="18" height="18" rx="4" /></I>,
  heart: <I><path d="M12 20.5s-7.5-4.6-9.2-9.3C1.6 7.8 3.8 4.5 7.3 4.5c2 0 3.6 1.1 4.7 2.8 1.1-1.7 2.7-2.8 4.7-2.8 3.5 0 5.7 3.3 4.5 6.7-1.7 4.7-9.2 9.3-9.2 9.3z" /></I>,
  comment: <I><path d="M20.5 12a8.5 8.5 0 1 1-3.2-6.6A8.4 8.4 0 0 1 20.5 12z" /><path d="M20.5 20.5l-2.3-3.7" /></I>,
  share: <I><path d="M21.5 3 10 13.5M21.5 3l-7 18-4.5-7.5L2.5 9z" /></I>,
  save: <I><path d="M18.5 21 12 15.5 5.5 21V4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1z" /></I>,
  more: <I fill="currentColor" sw={0}><circle cx="5.5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="18.5" cy="12" r="1.6" /></I>,
  addPerson: <I size={18}><circle cx="9.5" cy="8" r="4" /><path d="M2.5 20a7 7 0 0 1 14 0M19 8v6M16 11h6" /></I>,
  link: <I size={14} sw={2.2}><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2" /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2" /></I>,
  carousel: <I size={20} fill="currentColor" sw={0}><path d="M8 3h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-1V8a3 3 0 0 0-3-3H6V5a2 2 0 0 1 2-2z" /><rect x="3" y="7" width="13" height="14" rx="2" /></I>,
  pin: <I size={18} fill="currentColor" sw={0}><path d="M14.8 2.6 21.4 9.2l-1.6 1.1-2.1-.4-3.7 3.7.4 4.2-1.5 1.5-4.1-4.1L4.3 19.7l-.9-.9 4.5-4.5-4.1-4.1 1.5-1.5 4.2.4 3.7-3.7-.4-2.1z" /></I>,
  clock: <I size={12} sw={2.6}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></I>,
};

function compactIG(v: number | null | undefined): string {
  if (v == null) return "0";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (v >= 10_000) return `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return v.toLocaleString("en-US");
}

// ---------------------------------------------------------------- a photo, drawn with its edit
export const EditedImage = memo(function EditedImage({
  id,
  hash,
  aspect,
  px,
  className,
  tile,
}: {
  id: string | null | undefined;
  hash?: string | null;
  aspect: number;
  px: number;
  className?: string;
  /** Draw as a grid tile: the post's export frame, then the 3:4 tile shifted within it. */
  tile?: TileFrame;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);
  // Draws again when edits are changed elsewhere (e.g. Undo of an apply to all).
  const [rev, setRev] = useState(0);
  useEffect(() => onEditsChanged(() => setRev((r) => r + 1)), []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setDrawn(false);
    el.getContext("2d")?.clearRect(0, 0, el.width, el.height);
    if (!id) return;
    let cancelled = false;
    // Look ahead inside the phone's own scroll area, not the window.
    const root = el.closest(".ig-scroll, .ig-highlights");
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      drawEdited(id, el, aspect, tile).then((ok) => !cancelled && setDrawn(ok));
    }, { root, rootMargin: "300px" });
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [id, aspect, px, rev, tile?.exportAspect, tile?.offset]);
  const blur = placeholder(hash);
  return (
    <div className={`ig-img ${className ?? ""}`} style={{ aspectRatio: String(aspect), backgroundImage: blur ? `url(${blur})` : undefined }}>
      <canvas ref={ref} width={px} height={Math.round(px / aspect)} style={{ opacity: drawn ? 1 : 0 }} />
    </div>
  );
});

// ---------------------------------------------------------------- the phone
export interface PhoneProps {
  account: Account;
  /** In grid order: what Instagram would show first comes first. */
  posts: Post[];
  highlights: Album[];
  dark: boolean;
  markPlanned: boolean;
  onReorder?: (dragged: string, target: string) => void;
  onOpenInApp?: (postId: string) => void;
  /** Tap two planned posts to swap them. */
  swapMode?: boolean;
  onSwap?: (a: string, b: string) => void;
  /** Right-click on a grid tile (not on placeholders). */
  onMenu?: (e: React.MouseEvent, post: Post) => void;
}

/** A tile standing in for a post still to come (see how the grid shifts). */
export const PLACEHOLDER = "placeholder:";
const isPlaceholder = (p: Post) => p.id.startsWith(PLACEHOLDER);

type View = { kind: "profile" } | { kind: "posts"; start: number };
type Tab = "grid" | "reels" | "reposts" | "tagged";

export function InstagramPhone({ account, posts, highlights, dark, markPlanned, onReorder, onOpenInApp, swapMode, onSwap, onMenu }: PhoneProps) {
  const real = posts.filter((p) => !isPlaceholder(p));
  const [view, setView] = useState<View>({ kind: "profile" });
  const [tab, setTab] = useState<Tab>("grid");
  const hostRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => releaseEdited, []);

  // Fit the 390 × 844 phone in whatever room there is, never larger than life.
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight;
      const w = el.clientWidth;
      setScale(Math.max(0.5, Math.min(1, (h - 8) / 868, (w - 8) / 414)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={hostRef} className="phone-host">
      <div className={dark ? "phone ig-dark" : "phone"} style={{ transform: `scale(${scale})` }} role="region" aria-label={`Instagram preview of @${account.username}`}>
        <div className="phone-screen">
          <div className="island" aria-hidden="true" />
          <StatusBar />
          {/* Hidden, not unmounted, while a post is open: Back lands on the same scroll spot. */}
          <div style={{ display: "contents", visibility: view.kind === "profile" ? "visible" : "hidden" }} aria-hidden={view.kind !== "profile"}>
            <Profile
              account={account}
              posts={posts}
              highlights={highlights}
              markPlanned={markPlanned}
              tab={tab}
              setTab={setTab}
              onOpen={(id) => setView({ kind: "posts", start: Math.max(0, real.findIndex((p) => p.id === id)) })}
              onReorder={onReorder}
              swapMode={swapMode}
              onSwap={onSwap}
              onMenu={onMenu}
            />
          </div>
          {view.kind === "posts" && (
            <PostsFeed account={account} posts={real} start={view.start} markPlanned={markPlanned} onBack={() => setView({ kind: "profile" })} onOpenInApp={onOpenInApp} />
          )}
          <TabBar account={account} onProfile={() => setView({ kind: "profile" })} />
          <div className="home-indicator" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

function StatusBar() {
  return (
    <div className="ig-status" aria-hidden="true">
      <span className="time">9:41</span>
      <span className="ig-status-right">
        <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="1" /><rect x="5" y="5.5" width="3" height="6.5" rx="1" /><rect x="10" y="3" width="3" height="9" rx="1" /><rect x="15" y="0" width="3" height="12" rx="1" /></svg>
        <svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor"><path d="M8 2.3c2.3 0 4.4.9 6 2.4l1.2-1.3A10.4 10.4 0 0 0 8 .5 10.4 10.4 0 0 0 .8 3.4L2 4.7a8.6 8.6 0 0 1 6-2.4zm0 3.6c1.3 0 2.6.5 3.5 1.4l1.2-1.3A6.8 6.8 0 0 0 8 4.1a6.8 6.8 0 0 0-4.7 1.9l1.2 1.3c.9-.9 2.2-1.4 3.5-1.4zm0 3.5c-.6 0-1.1.2-1.5.6L8 11.5l1.5-1.5c-.4-.4-.9-.6-1.5-.6z" /></svg>
        <svg width="27" height="13" viewBox="0 0 27 13" fill="none"><rect x="0.5" y="0.5" width="23" height="12" rx="3.5" stroke="currentColor" opacity="0.4" /><rect x="2" y="2" width="18" height="9" rx="2" fill="currentColor" /><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2z" fill="currentColor" opacity="0.5" /></svg>
      </span>
    </div>
  );
}

function TabBar({ account, onProfile }: { account: Account; onProfile: () => void }) {
  return (
    <nav className="ig-tabbar" aria-label="Instagram tabs (preview)">
      <span>{icons.home}</span>
      <span>{icons.reels}</span>
      <span>{icons.messages}</span>
      <span>{icons.search}</span>
      <button type="button" className="ig-me" onClick={onProfile} aria-label="Profile">
        <EditedImage id={account.avatarPhotoId} hash={account.avatarThumbhash} aspect={1} px={56} className="round" />
      </button>
    </nav>
  );
}

const GRID_DRAG = "application/x-cba-grid";

function Profile({ account, posts, highlights, markPlanned, tab, setTab, onOpen, onReorder, swapMode, onSwap, onMenu }: {
  account: Account;
  posts: Post[];
  highlights: Album[];
  markPlanned: boolean;
  tab: Tab;
  setTab: (t: Tab) => void;
  onOpen: (postId: string) => void;
  onMenu?: (e: React.MouseEvent, post: Post) => void;
  onReorder?: (dragged: string, target: string) => void;
  swapMode?: boolean;
  onSwap?: (a: string, b: string) => void;
}) {
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [swapFirst, setSwapFirst] = useState<string | null>(null);
  useEffect(() => {
    if (!swapMode) setSwapFirst(null);
  }, [swapMode]);
  const planned = posts.filter((p) => p.status !== "published" && !isPlaceholder(p)).length;
  const postCount = (account.publishedPostCount ?? posts.length - planned) + planned;
  const link = account.link.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <div className="ig-scroll">
      <header className="ig-top">
        <span className="ig-user">
          {account.username} <span className="ig-caret">{icons.chevron}</span>
        </span>
        <span className="ig-top-icons">
          {icons.plus}
          {icons.menu}
        </span>
      </header>
      <section className="ig-head">
        <div className="ig-avatar">
          <EditedImage id={account.avatarPhotoId} hash={account.avatarThumbhash} aspect={1} px={180} className="round" />
        </div>
        <div className="ig-head-right">
          <div className="ig-name">{account.displayName || account.username}</div>
          <div className="ig-stats">
            <span><b>{compactIG(postCount)}</b>posts</span>
            <span><b>{compactIG(account.followerCount)}</b>followers</span>
            <span><b>{compactIG(account.followingCount)}</b>following</span>
          </div>
        </div>
      </section>
      <section className="ig-bio">
        {account.category && <div className="ig-cat">{account.category}</div>}
        {account.bio && <div className="ig-bio-text">{account.bio}</div>}
        {link && (
          <div className="ig-link">
            {icons.link}
            <span>{link}</span>
          </div>
        )}
      </section>
      <div className="ig-buttons">
        <span className="ig-btn">Edit profile</span>
        <span className="ig-btn">Share profile</span>
        <span className="ig-btn icon">{icons.addPerson}</span>
      </div>
      <div className="ig-highlights">
        {highlights.map((h) => (
          <div key={h.id} className="ig-hl">
            <span className="ig-hl-ring">
              <EditedImage id={h.coverPhotoId} hash={h.coverThumbhash} aspect={1} px={130} className="round" />
            </span>
            <span className="ig-hl-name" title={h.name}>{h.name}</span>
          </div>
        ))}
        <div className="ig-hl">
          <span className="ig-hl-ring new">{icons.plus}</span>
          <span className="ig-hl-name">New</span>
        </div>
      </div>
      <div className="ig-tabs" role="tablist" aria-label="Profile tabs">
        {(["grid", "reels", "reposts", "tagged"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} aria-label={t} onClick={() => setTab(t)}>
            {t === "grid" ? icons.grid : t === "reels" ? icons.reels : t === "reposts" ? icons.reposts : icons.tagged}
          </button>
        ))}
      </div>
      {tab === "grid" ? (
        <div className="ig-grid-3">
          {posts.map((p) => {
            if (isPlaceholder(p)) {
              return (
                <div key={p.id} className="ig-cell placeholder" aria-label="A post still to come">
                  <span>{p.title}</span>
                </div>
              );
            }
            const isPlanned = p.status !== "published";
            return (
              <button
                key={p.id}
                type="button"
                className={`ig-cell${over === p.id ? " over" : ""}${swapFirst === p.id ? " picked" : ""}`}
                draggable={isPlanned && !!onReorder}
                onDragStart={(e) => {
                  e.dataTransfer.setData(GRID_DRAG, p.id);
                  e.dataTransfer.effectAllowed = "move";
                  setDrag(p.id);
                }}
                onDragOver={(e) => {
                  // Only our own cells: a file dragged in from Finder is not a reorder.
                  if (isPlanned && drag && drag !== p.id && e.dataTransfer.types.includes(GRID_DRAG)) {
                    e.preventDefault();
                    setOver(p.id);
                  }
                }}
                onDragLeave={() => setOver(null)}
                onDragEnd={() => {
                  setDrag(null);
                  setOver(null);
                }}
                onDrop={(e) => {
                  const dragged = e.dataTransfer.getData(GRID_DRAG) || drag;
                  if (dragged && dragged !== p.id) onReorder?.(dragged, p.id);
                  setDrag(null);
                  setOver(null);
                }}
                onClick={() => {
                  if (swapMode && isPlanned && onSwap) {
                    if (!swapFirst) return setSwapFirst(p.id);
                    if (swapFirst !== p.id) onSwap(swapFirst, p.id);
                    return setSwapFirst(null);
                  }
                  onOpen(p.id);
                }}
                onContextMenu={(e) => !isPlaceholder(p) && onMenu?.(e, p)}
                aria-pressed={swapMode ? swapFirst === p.id : undefined}
                aria-label={`${p.title}${isPlanned ? " (planned)" : ""}`}
              >
                <EditedImage id={p.coverPhotoId} hash={p.coverThumbhash} aspect={GRID_TILE} px={260} tile={{ exportAspect: ratioAspect(p.exportRatio), offset: p.tileOffset }} />
                {p.pinned ? <span className="ig-badge">{icons.pin}</span> : p.photoCount > 1 ? <span className="ig-badge">{icons.carousel}</span> : null}
                {markPlanned && isPlanned && (
                  <span className="ig-planned">
                    {icons.clock}
                    {p.scheduledAt ? new Date(p.scheduledAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "Planned"}
                  </span>
                )}
              </button>
            );
          })}
          {Array.from({ length: (3 - (posts.length % 3)) % 3 }, (_, i) => <span key={`pad${i}`} className="ig-cell pad" />)}
        </div>
      ) : (
        <div className="ig-empty">
          <span className="ig-empty-ring">{tab === "reels" ? icons.reels : tab === "reposts" ? icons.reposts : icons.tagged}</span>
          <b>{tab === "reels" ? "Share a reel" : tab === "reposts" ? "No reposts yet" : "Photos and videos of you"}</b>
          <span>{tab === "reels" ? "Reels aren't planned in Captured by Andy yet." : tab === "reposts" ? "Posts and reels you repost will appear here." : "When people tag you, they'll appear here."}</span>
        </div>
      )}
      <div style={{ height: 90 }} />
    </div>
  );
}

function PostsFeed({ account, posts, start, markPlanned, onBack, onOpenInApp }: { account: Account; posts: Post[]; start: number; markPlanned: boolean; onBack: () => void; onOpenInApp?: (id: string) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLElement | null>(null);
  // Jump to the tapped post inside the phone only (scrollIntoView would also
  // scroll the page around the phone).
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    const el = firstRef.current;
    if (sc && el) sc.scrollTop = el.offsetTop - 44;
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onBack();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);
  return (
    <div className="ig-scroll" ref={scrollRef}>
      <header className="ig-top posts">
        <button type="button" className="ig-plain" onClick={onBack} aria-label="Back to profile">{icons.back}</button>
        <span className="ig-posts-title">
          <small>{account.username.toUpperCase()}</small>
          Posts
        </span>
        <span style={{ width: 24 }} />
      </header>
      {posts.map((p, i) => (
        <FeedPost key={p.id} post={p} account={account} markPlanned={markPlanned} refFn={i === start ? (el) => (firstRef.current = el) : undefined} onOpenInApp={onOpenInApp} />
      ))}
      <div style={{ height: 90 }} />
    </div>
  );
}

function FeedPost({ post, account, markPlanned, refFn, onOpenInApp }: { post: Post; account: Account; markPlanned: boolean; refFn?: (el: HTMLElement | null) => void; onOpenInApp?: (id: string) => void }) {
  const ref = useRef<HTMLElement | null>(null);
  const [photos, setPhotos] = useState<PhotoRow[] | null>(null);
  const [slide, setSlide] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const go = (i: number) => {
    const el = trackRef.current;
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
    setSlide(i);
  };
  const setRef = useCallback((el: HTMLElement | null) => {
    ref.current = el;
    refFn?.(el);
  }, [refFn]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      api.getPost(post.id).then((d) => setPhotos(d.photos)).catch(() => setPhotos([]));
    }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [post.id]);
  const list = photos ?? [];
  const planned = post.status !== "published";
  const when = post.publishedAt ?? post.scheduledAt;
  const date = when ? new Date(when).toLocaleDateString("en-GB", { day: "numeric", month: "long" }) : "";
  const caption = post.caption.trim();
  const long = caption.length > 110 || caption.split("\n").length > 2;
  return (
    <article ref={setRef} className="ig-post">
      <header className="ig-post-head">
        <span className="ig-post-avatar"><EditedImage id={account.avatarPhotoId} hash={account.avatarThumbhash} aspect={1} px={64} className="round" /></span>
        <b>{account.username}</b>
        {markPlanned && planned && <span className="ig-planned-inline">{icons.clock} {post.scheduledAt ? `Planned for ${date}` : "Planned"}</span>}
        <span style={{ marginLeft: "auto" }}>{icons.more}</span>
      </header>
      <div className="ig-media" style={{ aspectRatio: String(ratioAspect(post.exportRatio)) }}>
        <div
          className="ig-track"
          ref={trackRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const i = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
            if (i !== slide) setSlide(i);
          }}
        >
          {(list.length ? list : [{ id: post.coverPhotoId, thumbhash: post.coverThumbhash } as PhotoRow]).map((ph, i) => (
            <div key={`${ph.id}${i}`} className="ig-slide">
              <EditedImage id={ph.id} hash={ph.thumbhash} aspect={ratioAspect(post.exportRatio)} px={780} />
              {ph.isVideo && <VideoBadge seconds={ph.duration} />}
            </div>
          ))}
        </div>
        {list.length > 1 && (
          <>
            <span className="ig-count">{slide + 1}/{list.length}</span>
            {slide > 0 && <button type="button" className="ig-arrow left" aria-label="Previous photo" onClick={() => go(slide - 1)}>‹</button>}
            {slide < list.length - 1 && <button type="button" className="ig-arrow right" aria-label="Next photo" onClick={() => go(slide + 1)}>›</button>}
          </>
        )}
      </div>
      <div className="ig-actions">
        <span className="ig-actions-left">
          {icons.heart}
          {icons.comment}
          {icons.share}
        </span>
        {list.length > 1 && (
          <span className="ig-dots" aria-hidden="true">
            {list.map((_, i) => <i key={i} className={i === slide ? "on" : ""} />)}
          </span>
        )}
        <span className="ig-actions-right">{icons.save}</span>
      </div>
      <div className="ig-caption">
        {caption ? (
          <>
            <b>{account.username}</b> {long && !expanded ? `${caption.slice(0, 110).trimEnd()}… ` : caption}
            {long && !expanded && <button type="button" className="ig-plain muted" onClick={() => setExpanded(true)}>more</button>}
          </>
        ) : (
          <span className="ig-muted">No caption yet{onOpenInApp ? " · " : ""}{onOpenInApp && <button type="button" className="ig-plain link" onClick={() => onOpenInApp(post.id)}>write one</button>}</span>
        )}
      </div>
      <div className="ig-date">{date}{onOpenInApp && <button type="button" className="ig-plain link" onClick={() => onOpenInApp(post.id)}> · Edit in Captured by Andy</button>}</div>
    </article>
  );
}
