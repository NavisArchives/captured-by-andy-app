import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "../api";
import { InstagramPhone, PLACEHOLDER } from "../components/Instagram";
import { PhotoPicker } from "../components/PhotoPicker";
import { usePostMenu } from "../components/menus";
import { Thumb } from "../components/Thumb";
import { Icon, Modal, Switch, useToast, Select } from "../components/ui";
import { forgetEdits } from "../gl/edited";
import { compact, formatDay, STATUS_LABEL } from "../lib/format";
import { isDue } from "../lib/postFlow";
import { CADENCE_KEY, CADENCES, loadCadence, nextFreeSlots } from "../lib/slots";
import { useStore } from "../store";
import type { Account as AccountT, Post } from "../types";

export function Account({ id }: { id: string }) {
  const { accounts, albums, go, reloadMeta, version, bump } = useStore();
  const postMenu = usePostMenu();
  const toast = useToast();
  const account = accounts.find((a) => a.id === id);
  const [grid, setGrid] = useState<Post[]>([]);
  const [dark, setDark] = useState(() => localStorage.getItem("ig.dark") === "1");
  const [showPlanned, setShowPlanned] = useState(true);
  const [markPlanned, setMarkPlanned] = useState(true);
  const [editing, setEditing] = useState(false);
  const [avatarPick, setAvatarPick] = useState(false);
  const [cadence, setCadence] = useState(2);
  const [scheduling, setScheduling] = useState(false);
  // Quick grid moves: tap two planned posts to swap them, preview the grid
  // with posts still to come, and leave planned posts out of the preview for now.
  const [swapMode, setSwapMode] = useState(false);
  const [toCome, setToCome] = useState(0);
  const hiddenKey = `grid.hidden.${id}`;
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(`grid.hidden.${id}`) ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const toggleHidden = (postId: string) =>
    setHidden((cur) => {
      const next = new Set(cur);
      if (next.has(postId)) next.delete(postId);
      else next.add(postId);
      try {
        localStorage.setItem(hiddenKey, JSON.stringify([...next]));
      } catch {
        /* private mode: kept for this visit only */
      }
      return next;
    });

  const load = useCallback(() => api.accountGrid(id).then(setGrid).catch(() => {}), [id]);
  useEffect(() => {
    forgetEdits();
    load();
  }, [load, version]);
  useEffect(() => {
    loadCadence().then(setCadence);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("ig.dark", dark ? "1" : "0");
    } catch {
      /* private mode */
    }
  }, [dark]);

  if (!account) return <div className="screen"><p className="meta">Account not found.</p></div>;
  const future = grid.filter((p) => p.status !== "published");
  const published = grid.filter((p) => p.status === "published");
  // Up next: the post going out first sits at the top.
  const upNext = [...future].reverse();
  // What Instagram would show: pinned first, then (planned) newest, then the rest.
  const pinned = published.filter((p) => p.pinned);
  // Posts without photos can't exist on Instagram, so they stay out of the phone.
  const placeholders: Post[] = Array.from({ length: toCome }, (_, i) => ({
    ...(future[0] ?? published[0] ?? ({} as Post)),
    id: `${PLACEHOLDER}${i}`,
    title: `Post to come${toCome > 1 ? ` · ${toCome - i}` : ""}`,
    status: "idea",
    pinned: false,
    photoCount: 1,
    coverPhotoId: null,
    coverThumbhash: null,
  }));
  const phonePosts = [
    ...pinned,
    ...placeholders,
    ...(showPlanned ? future.filter((p) => !hidden.has(p.id)) : []),
    ...published.filter((p) => !p.pinned),
  ].filter((p) => p.photoCount > 0);
  const swap = (a: string, b: string) => {
    const ids = upNext.map((p) => p.id);
    const i = ids.indexOf(a);
    const j = ids.indexOf(b);
    if (i < 0 || j < 0) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void plan(ids);
  };

  const plan = async (orderedFirstOut: string[]) => {
    await api.planPosts(orderedFirstOut);
    load();
    bump();
  };
  // Dropping one planned post onto another moves it into that slot; the ones
  // in between shift along by one.
  const reorder = async (dragged: string, target: string) => {
    const firstOut = upNext.map((p) => p.id);
    const from = firstOut.indexOf(dragged);
    const to = firstOut.indexOf(target);
    if (from < 0 || to < 0) return;
    firstOut.splice(from, 1);
    firstOut.splice(to, 0, dragged);
    await plan(firstOut);
  };

  // Ready posts without a date get the next free slots, first out first, so
  // the dates follow the Up next order.
  const unscheduled = upNext.filter((p) => p.status === "ready" && !p.scheduledAt);
  const scheduleAll = async () => {
    const slots = nextFreeSlots(grid, unscheduled.length, cadence);
    const done: string[] = [];
    let failed: unknown = null;
    setScheduling(true);
    for (const [i, p] of unscheduled.entries()) {
      try {
        await api.updatePost(p.id, { scheduledAt: slots[i], status: "scheduled" });
        done.push(p.id);
      } catch (e) {
        failed = e;
        break;
      }
    }
    setScheduling(false);
    load();
    bump();
    const undo = {
      label: "Undo",
      run: async () => {
        for (const pid of done) await api.updatePost(pid, { status: "ready", scheduledAt: "" }).catch(() => {});
        load();
        bump();
      },
    };
    if (failed) toast(`Scheduled ${done.length}, then: ${errorText(failed)}`, { error: true, action: done.length ? undo : undefined });
    else toast(`Scheduled ${done.length}`, { action: undo });
  };
  const pickCadence = (days: number) => {
    setCadence(days);
    api.setSetting(CADENCE_KEY, String(days)).catch((e) => toast(errorText(e), { error: true }));
  };
  const markPosted = async (postId: string) => {
    try {
      await api.updatePost(postId, { status: "published" });
      load();
      bump();
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };

  const newPost = async () => {
    try {
      const p = await api.createPost({ title: "New post", accountId: id });
      go({ name: "post", id: p.id });
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };

  return (
    <div className="screen scroll">
      <div className="hero" style={{ alignItems: "center" }}>
        <button type="button" onClick={() => setAvatarPick(true)} title="Choose a profile photo" style={{ width: 78, height: 78, borderRadius: "50%", overflow: "hidden", flex: "none", border: 0, padding: 0 }}>
          <Thumb id={account.avatarPhotoId} hash={account.avatarThumbhash} />
        </button>
        <div style={{ minWidth: 0 }}>
          <div className="crumb"><button type="button" onClick={() => go({ name: "accounts" })}>Accounts /</button></div>
          <h1>@{account.username}</h1>
          <p className="sub">{account.displayName || "Instagram"} · counts typed in by you</p>
        </div>
        <div className="acts" style={{ gap: 26, alignItems: "center" }}>
          {([[account.publishedPostCount, "posts"], [account.followerCount, "followers"], [account.followingCount, "following"]] as const).map(([v, l]) => (
            <div key={l}>
              <div className="big" style={{ fontSize: 28 }}>{compact(v)}</div>
              <div className="meta">{l}</div>
            </div>
          ))}
          <button type="button" className="btn quiet" onClick={() => setEditing(true)}>Edit</button>
        </div>
      </div>
      {/* Both columns the same height: the side column scrolls inside it (strict pass, 19 Nov). */}
      <div className="grid-2 ac-grid">
        <section className="card" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, height: "calc(100vh - 196px)", minHeight: 560 }}>
          <div className="row-flex" style={{ width: "100%", flexWrap: "wrap", gap: 14 }}>
            <div className="seg" role="group" aria-label="Instagram theme" style={{ width: 170 }}>
              <button type="button" aria-pressed={!dark} onClick={() => setDark(false)}>Light</button>
              <button type="button" aria-pressed={dark} onClick={() => setDark(true)}>Dark</button>
            </div>
            <label className="row-flex" style={{ fontSize: 13, gap: 8 }}>
              <Switch checked={showPlanned} onChange={setShowPlanned} label="Show planned posts" /> Show planned
            </label>
            <label className="row-flex" style={{ fontSize: 13, gap: 8 }}>
              <Switch checked={markPlanned} onChange={setMarkPlanned} label="Mark planned posts" /> Mark planned
            </label>
            <button type="button" className="chip" aria-pressed={swapMode} onClick={() => setSwapMode((v) => !v)} title="Tap two planned posts to swap them">
              Swap two
            </button>
            <Select className="pick" aria-label="Posts still to come" value={toCome} onChange={(e) => setToCome(Number(e.target.value))} title="See how the grid shifts once more posts go out">
              <option value={0}>Grid as planned</option>
              <option value={1}>+1 post to come</option>
              <option value={2}>+2 posts to come</option>
              <option value={3}>+3 posts to come</option>
            </Select>
            {/* One line that never wraps: the phone below keeps its size whatever it says. */}
            <span className="meta" style={{ marginLeft: "auto", flex: "1 1 0", minWidth: 0, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {swapMode ? "Swapping: tap two planned posts" : "Tap a post to open it · drag planned posts"}
            </span>
          </div>
          <InstagramPhone
            account={account}
            posts={phonePosts}
            highlights={albums.filter((a) => a.coverPhotoId).slice(0, 8)}
            dark={dark}
            markPlanned={markPlanned}
            onReorder={reorder}
            onOpenInApp={(postId) => go({ name: "post", id: postId })}
            onMenu={postMenu}
            swapMode={swapMode}
            onSwap={swap}
          />
          {/* Always there, one line high, so hiding a post never resizes the phone. */}
          <p className="meta" style={{ margin: 0, flex: "none", height: 18, lineHeight: "18px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>
            {hidden.size > 0 && (
              <>
                {hidden.size === 1 ? "1 planned post is" : `${hidden.size} planned posts are`} left out of this preview ·{" "}
                <button type="button" className="link" onClick={() => { setHidden(new Set()); try { localStorage.removeItem(hiddenKey); } catch { /* fine */ } }}>Show all</button>
              </>
            )}
          </p>
        </section>
        <div className="col ac-side">
          <section className="panel">
            <p className="eyebrow"><span>Up next</span><span>{upNext.length} planned</span></p>
            {upNext.length ? (
              <div className="rows">
                {upNext.map((p, i) => {
                  const due = isDue(p);
                  return (
                    <div key={p.id} className="row" style={{ gridTemplateColumns: "auto auto 1fr auto" }}>
                      <span style={{ display: "flex", flexDirection: "column" }}>
                        <button type="button" className="link" style={{ color: "var(--ink)", opacity: i ? 1 : 0.3 }} disabled={!i} aria-label="Earlier" onClick={() => { const ids = upNext.map((x) => x.id); [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; plan(ids); }}>▲</button>
                        <button type="button" className="link" style={{ color: "var(--ink)", opacity: i < upNext.length - 1 ? 1 : 0.3 }} disabled={i === upNext.length - 1} aria-label="Later" onClick={() => { const ids = upNext.map((x) => x.id); [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]]; plan(ids); }}>▼</button>
                      </span>
                      <span style={{ width: 44, height: 55, borderRadius: 8, overflow: "hidden", display: "block" }}><Thumb id={p.coverPhotoId} hash={p.coverThumbhash} /></span>
                      <button type="button" className="who" style={{ background: "none", border: 0, textAlign: "left", color: "inherit", padding: 0 }} onClick={() => go({ name: "post", id: p.id })}>
                        {p.title}
                        <small>{STATUS_LABEL[p.status]}{p.scheduledAt ? ` · ${formatDay(p.scheduledAt)}` : ""} · {p.photoCount} photos</small>
                      </button>
                      <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        {due && (
                          <>
                            <span className="tag t-maybe">Due</span>
                            <button type="button" className="link" style={{ color: "var(--ink)" }} title="It went out: mark it published" onClick={() => markPosted(p.id)}>Posted ✓</button>
                          </>
                        )}
                        <button
                          type="button"
                          className="link"
                          style={{ color: "var(--ink)", opacity: hidden.has(p.id) ? 0.55 : 1 }}
                          aria-pressed={hidden.has(p.id)}
                          title={hidden.has(p.id) ? "Show it in the grid preview again" : "Leave it out of the grid preview for now"}
                          onClick={() => toggleHidden(p.id)}
                        >
                          {hidden.has(p.id) ? "Hidden" : "Hide"}
                        </button>
                        <span className="when">#{i + 1}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p style={{ opacity: 0.75, fontSize: 13.5 }}>Nothing planned yet for @{account.username}.</p>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
              <button type="button" className="btn light" onClick={newPost}>{Icon.plus()} New post</button>
              {unscheduled.length > 0 && (
                <button type="button" className="btn light" disabled={scheduling} onClick={scheduleAll} title="Give each Ready post without a date the next free slot, in this order">
                  Schedule all
                </button>
              )}
              {upNext.length > 0 && (
                <Select className="pick" aria-label="How often you post" title="Spacing for Schedule all and Next free" value={cadence} onChange={(e) => pickCadence(Number(e.target.value))}>
                  {!CADENCES.some((c) => c.days === cadence) && <option value={cadence}>Every {cadence} days</option>}
                  {CADENCES.map((c) => <option key={c.days} value={c.days}>{c.label}</option>)}
                </Select>
              )}
            </div>
          </section>
          <section className="card">
            <p className="eyebrow">This account</p>
            <dl className="kv">
              <dt>Ideas</dt><dd>{account.drafts} in progress</dd>
              <dt>Ready</dt><dd>{account.ready} ready or scheduled</dd>
              <dt>Published</dt><dd>{account.published} tracked here{account.publishedPostCount ? ` · ${account.publishedPostCount} on Instagram` : ""}</dd>
              {published[0] && (<><dt>Last post</dt><dd>{formatDay(published[0].publishedAt)} · {published[0].title}</dd></>)}
            </dl>
            {account.notes && <p className="hint" style={{ marginTop: 14 }}>{account.notes}</p>}
          </section>
        </div>
      </div>
      {editing && <EditAccount account={account} onClose={() => { setEditing(false); reloadMeta(); }} />}
      {avatarPick && (
        <PhotoPicker
          title="Profile photo"
          max={1}
          onClose={() => setAvatarPick(false)}
          onPick={async ([photo]) => {
            setAvatarPick(false);
            await api.updateAccount(id, { avatarPhotoId: photo });
            reloadMeta();
          }}
        />
      )}
    </div>
  );
}

function EditAccount({ account, onClose }: { account: AccountT; onClose: () => void }) {
  const { reloadMeta, replace, forgetRoute } = useStore();
  const toast = useToast();
  const [f, setF] = useState({
    username: account.username,
    displayName: account.displayName,
    followerCount: account.followerCount?.toString() ?? "",
    followingCount: account.followingCount?.toString() ?? "",
    publishedPostCount: account.publishedPostCount?.toString() ?? "",
    notes: account.notes,
    bio: account.bio,
    link: account.link,
    category: account.category,
  });
  const [confirm, setConfirm] = useState(false);
  const num = (v: string) => (v.trim() ? Number(v) : null);
  const save = async () => {
    try {
      await api.updateAccount(account.id, {
        username: f.username,
        displayName: f.displayName,
        followerCount: num(f.followerCount),
        followingCount: num(f.followingCount),
        publishedPostCount: num(f.publishedPostCount),
        notes: f.notes,
        bio: f.bio,
        link: f.link,
        category: f.category,
      });
      onClose();
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const field = (key: keyof typeof f, label: string, numeric = false) => (
    <label style={{ display: "grid", gap: 6 }}>
      <span className="eyebrow" style={{ margin: 0 }}>{label}</span>
      <input className="box" inputMode={numeric ? "numeric" : undefined} value={f[key]} onChange={(e) => setF({ ...f, [key]: numeric ? e.target.value.replace(/\D/g, "") : e.target.value })} />
    </label>
  );
  return (
    <Modal
      title={`@${account.username}`}
      onClose={onClose}
      foot={
        <>
          {confirm ? (
            <button type="button" className="btn danger" onClick={async () => { await api.deleteAccount(account.id); reloadMeta(); forgetRoute(account.id); replace({ name: "accounts" }); }}>Yes, remove it</button>
          ) : (
            <button type="button" className="btn danger" onClick={() => setConfirm(true)}>Remove account…</button>
          )}
          <span className="spacer" />
          <button type="button" className="btn quiet" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={save}>Save</button>
        </>
      }
    >
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
        {field("username", "Username")}
        {field("displayName", "Display name")}
        {field("followerCount", "Followers", true)}
        {field("followingCount", "Following", true)}
        {field("publishedPostCount", "Posts on Instagram", true)}
        {field("category", "Category (e.g. Photographer)")}
        {field("link", "Link in bio")}
        <label style={{ display: "grid", gap: 6, gridColumn: "1 / -1" }}>
          <span className="eyebrow" style={{ margin: 0 }}><span>Bio</span><span>{f.bio.length} / 150</span></span>
          <textarea className="box" rows={4} maxLength={150} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} placeholder="What your profile says under your name…" />
        </label>
        <label style={{ display: "grid", gap: 6, gridColumn: "1 / -1" }}>
          <span className="eyebrow" style={{ margin: 0 }}>Notes</span>
          <textarea className="box" rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </label>
      </div>
      {confirm && <p className="warnline" style={{ marginTop: 12 }}>The posts stay, unassigned. No photo is touched.</p>}
    </Modal>
  );
}
