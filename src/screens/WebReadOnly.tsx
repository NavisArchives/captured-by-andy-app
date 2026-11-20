// Online, Socials and Portfolio are read-only views of what the Mac last
// synced (NIRMATA Revision 2, 19 Nov: unavailable is fine, a dead end is not).
// The calendar, the grid and the website's projects can be looked at here;
// planning posts and editing pages stay in the Mac app.
import { useEffect, useState } from "react";
import { api } from "../api";
import { Thumb } from "../components/Thumb";
import { SITE } from "../components/MacOnly";
import { useStore } from "../store";
import { usePortfolioMenu, usePostMenu } from "../components/menus";
import type { Post } from "../types";

const WORD: Record<string, string> = { scheduled: "Planned", ready: "Ready", building: "Building", idea: "Idea", published: "Posted" };
const day = (iso: string | null) => {
  const d = iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? new Date(`${iso.slice(0, 10)}T12:00`) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) : "";
};

function usePosts(): Post[] | null {
  const { version } = useStore();
  const [posts, setPosts] = useState<Post[] | null>(null);
  useEffect(() => { api.listPosts().then(setPosts).catch(() => setPosts([])); }, [version]);
  return posts;
}

function PostRow({ p }: { p: Post }) {
  const postMenu = usePostMenu();
  return (
    <div className="ro-row" onContextMenu={(e) => postMenu(e, p)}>
      <div className="ro-cover">{p.coverPhotoId ? <Thumb id={p.coverPhotoId} hash={p.coverThumbhash} /> : null}</div>
      <div className="ro-t">
        <b>{p.title || "Untitled post"}</b>
        <span className="meta">{[WORD[p.status] ?? p.status, day(p.status === "published" ? p.publishedAt : p.scheduledAt), p.accountUsername ? `@${p.accountUsername}` : null, `${p.photoCount} ${p.photoCount === 1 ? "picture" : "pictures"}`].filter(Boolean).join(" · ")}</span>
      </div>
    </div>
  );
}

export function WebSocials({ view }: { view: "calendar" | "grid" }) {
  const posts = usePosts();
  const postMenu = usePostMenu();
  const planned = (posts ?? []).filter((p) => p.status === "scheduled").sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
  const waiting = (posts ?? []).filter((p) => p.status === "ready" || p.status === "building" || p.status === "idea");
  const posted = (posts ?? []).filter((p) => p.status === "published").sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  // The grid as it would read on the profile: the next post on top, then what is already posted.
  const grid = [...[...planned, ...waiting.filter((p) => p.status === "ready")].sort((a, b) => (b.planOrder ?? 0) - (a.planOrder ?? 0)), ...posted];
  return (
    <div className="screen scroll ro-page">
      <div className="ro-head">
        <h1>{view === "calendar" ? "Calendar" : "Grid"}</h1>
        <p className="meta">{view === "grid" ? "Planning preview · not connected to Instagram · " : ""}Read-only here, as your Mac last synced it. Plan and change posts in the Mac app.</p>
      </div>
      {posts === null && <p className="meta">Reading the plan…</p>}
      {posts && posts.length === 0 && (
        <div className="empty"><h3>No posts synced yet</h3><p>Posts you plan in the Mac app show here after its next sync.</p></div>
      )}
      {posts && posts.length > 0 && view === "calendar" && (
        <>
          {[["Planned", planned], ["Waiting", waiting], ["Posted", posted.slice(0, 12)]].map(([title, list]) =>
            (list as Post[]).length ? (
              <section key={title as string} className="ro-group">
                <h3>{title as string}</h3>
                {(list as Post[]).map((p) => <PostRow key={p.id} p={p} />)}
              </section>
            ) : null,
          )}
        </>
      )}
      {posts && posts.length > 0 && view === "grid" && (
        <div className="ro-grid">
          {grid.map((p) => (
            <div key={p.id} className="ro-cell" title={p.title} onContextMenu={(e) => postMenu(e, p)}>
              {p.coverPhotoId ? <Thumb id={p.coverPhotoId} hash={p.coverThumbhash} /> : <span>{p.title}</span>}
              {p.status !== "published" && <i>{WORD[p.status]}</i>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WebPortfolio() {
  const { version } = useStore();
  const [site, setSite] = useState<Awaited<ReturnType<typeof api.siteProjects>> | undefined>(undefined);
  useEffect(() => { api.siteProjects().then(setSite).catch(() => setSite(null)); }, [version]);
  const projects = site?.projects ?? [];
  const portfolioMenu = usePortfolioMenu();
  return (
    <div className="screen scroll ro-page">
      <div className="ro-head el-head">
        <div>
          <h1>Portfolio</h1>
          <p className="meta">Your website's projects, as your Mac last synced them. Pages are edited in the Mac app.</p>
        </div>
        <a className="btn primary" href={SITE} target="_blank" rel="noreferrer">Open my website</a>
      </div>
      {site === undefined && <p className="meta">Reading the website's projects…</p>}
      {site !== undefined && projects.length === 0 && (
        <div className="empty"><h3>No projects synced yet</h3><p>The list shows here after the Mac app's next sync.</p></div>
      )}
      {projects.length > 0 && (
        <section className="ro-group">
          {projects.map((p) => (
            <a key={p.slug} className="ro-row ro-link" onContextMenu={(e) => portfolioMenu(e, p)} aria-label={`${p.title}, open on andyssarchives.com`} href={`${SITE}/work/${encodeURIComponent(p.slug)}`} target="_blank" rel="noreferrer">
              <div className="ro-t">
                <b>{p.title}</b>
                <span className="meta">{[p.year, p.notebook ? "notebook" : null, `andyssarchives.com/work/${p.slug}`].filter(Boolean).join(" · ")}</span>
              </div>
              <span className="pt-chev" aria-hidden="true">↗</span>
            </a>
          ))}
        </section>
      )}
    </div>
  );
}
