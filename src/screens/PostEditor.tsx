import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { api, errorText, showInFinder } from "../api";
import { EditedImage } from "../components/Instagram";
import { PhotoPicker } from "../components/PhotoPicker";
import { VideoBadge } from "../components/PhotoGrid";
import { Thumb } from "../components/Thumb";
import { Icon, Select, useToast } from "../components/ui";
import { useMenu } from "../components/ContextMenu";
import { usePhotoMenu, useAsk } from "../components/menus";
import { forgetEdits, releaseEdited } from "../gl/edited";
import { GRID_TILE, ratioAspect } from "../gl/renderer";
import { formatDay, STATUS_LABEL } from "../lib/format";
import { copyText, exportCarousel } from "../lib/instagramExport";
import { moveTarget, needsPhotos } from "../lib/postFlow";
import { blocker, readiness, type Issue } from "../lib/readiness";
import { DEFAULT_CADENCE, loadCadence, nextFreeSlots } from "../lib/slots";
import { useStore } from "../store";
import type { Post, PostDetail, PostInput, PostStatus } from "../types";

const NEXT_STEP: Partial<Record<PostStatus, { status: PostStatus; label: string }>> = {
  idea: { status: "ready", label: "Mark as ready" },
  building: { status: "ready", label: "Mark as ready" },
  ready: { status: "published", label: "Mark as published" },
  scheduled: { status: "published", label: "Mark as published" },
  archived: { status: "building", label: "Back to building" },
};
// Slides carry this type while dragged, so a file dragged in from Finder never reorders.
const SLIDE_DRAG = "application/x-cba-slide";

export function PostEditor({ id }: { id: string }) {
  const { accounts, go, back, replace, forgetRoute, bump, version, editIds, selection, setQuery, setSelection } = useStore();
  const { open: menu } = useMenu();
  const photoMenu = usePhotoMenu();
  // Narrow windows: Words and Preview share the third column, one at a time.
  const [wordsOpen, setWordsOpen] = useState(true);
  // « No date yet » until a date is picked (no raw dd/mm/yyyy field).
  const [dateOpen, setDateOpen] = useState(false);
  const toast = useToast();
  const [post, setPost] = useState<PostDetail | null>(null);
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [notes, setNotes] = useState("");
  const [picking, setPicking] = useState(false);
  const [slide, setSlide] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  // The shared confirm: focus on Cancel, the red button arms after 0.4 s.
  const ask = useAsk();
  const [exporting, setExporting] = useState<string | null>(null);
  // The grid tile's position on the cover, while the slider moves (saved when it rests).
  const [tileDraft, setTileDraft] = useState<number | null>(null);
  const tileTimer = useRef<number | undefined>(undefined);
  const [accountPosts, setAccountPosts] = useState<Post[] | null>(null);
  const [cadence, setCadence] = useState(DEFAULT_CADENCE);
  const timer = useRef<number | undefined>(undefined);
  const titleRef = useRef<HTMLInputElement>(null);
  const captionRef = useRef<HTMLTextAreaElement>(null);
  const textLoaded = useRef(false);
  const titleFocused = useRef(false);

  // Photos are drawn with their saved edit. The screen remounts on every visit,
  // so coming back from the editor shows the new edits.
  useEffect(() => {
    forgetEdits();
    loadCadence().then(setCadence);
    return releaseEdited;
  }, []);

  const load = useCallback(() => {
    api.getPost(id).then((p) => {
      setPost(p);
      // The text is filled once: a later refresh must not overwrite words
      // still waiting to be saved.
      if (textLoaded.current) return;
      textLoaded.current = true;
      setTitle(p.title);
      setCaption(p.caption);
      setNotes(p.notes);
    }).catch((e) => toast(errorText(e), { error: true }));
  }, [id, toast]);
  useEffect(load, [load]);
  // Something changed elsewhere (Undo in the editor's toast, a look applied
  // from Pictures): the "Edited" labels and the checklist follow. The photos
  // redraw by themselves; the text fields are only filled once.
  const seenVersion = useRef(version);
  useEffect(() => {
    if (seenVersion.current === version) return;
    seenVersion.current = version;
    load();
  }, [version, load]);

  // A fresh post: the title is selected, ready to type over.
  useEffect(() => {
    if (!post || titleFocused.current) return;
    titleFocused.current = true;
    if (post.title === "New post" || post.title === "Untitled post") {
      titleRef.current?.focus();
      titleRef.current?.select();
    }
  }, [post]);

  // The account's other posts, to find its next free day.
  const accountId = post?.accountId ?? null;
  useEffect(() => {
    setAccountPosts(null);
    if (!accountId) return;
    let live = true;
    api.listPosts({ account: accountId }).then((ps) => {
      if (live) setAccountPosts(ps);
    }).catch(() => {});
    return () => {
      live = false;
    };
  }, [accountId]);

  const update = useCallback(async (input: PostInput) => {
    try {
      const p = await api.updatePost(id, input);
      setPost(p);
      bump();
      return p;
    } catch (e) {
      toast(errorText(e), { error: true });
      return null;
    }
  }, [id, bump, toast]);

  // Text saves itself a moment after you stop typing. Edits to different
  // fields in quick succession are merged, and anything pending is saved on leave.
  const pending = useRef<PostInput>({});
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length) void update(patch);
  }, [update]);
  const saveText = (patch: PostInput) => {
    pending.current = { ...pending.current, ...patch };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 500);
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);

  // Hooks stay above the early return below (React needs the same hooks every render).
  // The cover is drawn at its shown width × the screen's density, so it stays
  // sharp at any window size (steps of 80 px, so a resize doesn't redraw it).
  const [coverPx, setCoverPx] = useState(480);
  const coverObs = useRef<ResizeObserver | null>(null);
  const coverRef = useCallback((el: HTMLDivElement | null) => {
    coverObs.current?.disconnect();
    if (!el) return;
    coverObs.current = new ResizeObserver(([e]) => {
      const w = e.contentRect.width * (window.devicePixelRatio || 1);
      if (w > 0) setCoverPx(Math.min(2000, Math.ceil(w / 80) * 80));
    });
    coverObs.current.observe(el);
  }, []);
  if (!post) return <div className="screen" />;
  const photos = post.photos;
  const reorder = async (from: number, to: number) => {
    if (from === to) return;
    const ids = photos.map((p) => p.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    // Optimistic: the server ends up in the same order, so only a failure reloads.
    setPost((cur) => cur && { ...cur, photos: ids.map((pid) => cur.photos.find((p) => p.id === pid)!) });
    try {
      await api.postReorder(id, ids);
    } catch (e) {
      toast(errorText(e), { error: true });
      load();
    }
  };
  const endDrag = () => {
    setDrag(null);
    setOverIdx(null);
  };
  const dropAt = (e: DragEvent, to: number) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData(SLIDE_DRAG);
    const from = drag ?? (raw ? Number(raw) : null);
    endDrag();
    if (from != null) void reorder(from, to);
  };
  const remove = async (photoId: string) => {
    await api.postRemovePhotos(id, [photoId]);
    load();
    bump();
  };
  const add = async (ids: string[]) => {
    setPicking(false);
    try {
      await api.postAddPhotos(id, ids);
      load();
      bump();
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const account = accounts.find((a) => a.id === post.accountId);
  const issues = readiness(post, caption, accounts.length > 0);
  const blocked = blocker(issues);
  // One step at a time: a post is made ready before it can be published.
  const next = NEXT_STEP[post.status];
  // Made ready with a date already set, it is scheduled.
  const nextStatus = next?.status === "ready" && post.scheduledAt ? "scheduled" : next?.status;
  const stepBlock = nextStatus && needsPhotos(nextStatus) ? blocked : null;
  // The checklist matters while the post is on its way to Instagram.
  const onTheWay = next?.status === "ready" || next?.status === "published";
  const scheduled = (post.scheduledAt ?? "").slice(0, 16);
  const reused = post.reused.filter((r) => r.status === "published");
  const shown = Math.min(slide, Math.max(0, photos.length - 1));
  const planning = post.status !== "published" && post.status !== "archived";
  const slot = account && planning && accountPosts ? nextFreeSlots(accountPosts, 1, cadence, post.id)[0] : null;

  // Every move with the same blockers as the next-step button. Once the post
  // is on its way, offer a look at the account's grid.
  const move = async (to: PostStatus) => {
    const s = moveTarget(post, to);
    if (s === post.status) return;
    // A published post brought back from Archived is history, not a plan.
    const restoring = post.status === "archived" && s === "published";
    if (needsPhotos(s) && blocked && !restoring) return toast(blocked, { error: true });
    const done = await update({ status: s });
    if (done && account && needsPhotos(s)) {
      toast(STATUS_LABEL[s], { action: { label: `See on @${account.username} grid`, run: () => go({ name: "account", id: account.id }) } });
    }
  };
  // Clearing the date takes a Scheduled post back to Ready; a date on a Ready
  // post schedules it. Ideas and posts being built keep their status.
  const planFor = (v: string) => {
    const input: PostInput = { scheduledAt: v };
    if (v && post.status === "ready") input.status = "scheduled";
    if (!v && post.status === "scheduled") input.status = "ready";
    void update(input);
  };
  // Exports the carousel; with `send`, AirDrop opens for the files right after.
  const exportForInstagram = (send = false) => {
    // Copy first, straight from the click: after an await it no longer counts as one.
    const text = caption.trim();
    const copied = text ? copyText(caption) : Promise.resolve(false);
    const n = photos.length;
    let done = 0;
    let last = "";
    setExporting(`Exporting 0/${n}…`);
    exportCarousel({ ...post, title }, (d, total, path) => {
      done = d;
      if (path) last = path;
      setExporting(`Exporting ${d}/${total}…`);
    })
      .then(async (paths) => {
        const note = !text ? "" : (await copied) ? " · caption copied" : " · copy the caption by hand";
        if (send) {
          setExporting("Choose your phone in AirDrop…");
          const how = await api.airdrop(paths);
          toast(how === "sent" ? `${n} sent to your phone${note}` : `AirDrop closed · the files are in Exports${note}`, {
            action: { label: "Show in Finder", run: () => void api.reveal(last).catch((e) => toast(errorText(e), { error: true })) },
          });
          return;
        }
        if (last) showInFinder(last);
        toast(`${n} exported${note}`, {
          action: { label: "Show in Finder", run: () => void api.reveal(last).catch((e) => toast(errorText(e), { error: true })) },
        });
      })
      .catch((e) => toast(done < n ? `Stopped after ${done}: ${errorText(e)}` : errorText(e), { error: true }))
      .finally(() => setExporting(null));
  };
  // The checklist beside the publish button: one click fixes the first thing.
  const fixIt = (issue: Issue) => {
    const fix = issue.fix;
    switch (fix?.kind) {
      case "addPhotos":
        return setPicking(true);
      case "pickAccount":
        return (document.querySelector(".pe-account button") as HTMLButtonElement | null)?.click();
      case "writeCaption":
        setWordsOpen(true);
        return window.setTimeout(() => captionRef.current?.focus(), 0);
      case "edit":
        return editIds(fix.ids, 0);
      default:
        setWordsOpen(true);
        return window.setTimeout(() => captionRef.current?.focus(), 0);
    }
  };
  const del = async () => {
    await api.deletePost(id);
    bump();
    forgetRoute(id);
    replace({ name: "posts" });
  };
  const STEPS: PostStatus[] = ["idea", "building", "ready", "scheduled", "published"];
  const stepAt = STEPS.indexOf(post.status);
  const more = (e: { clientX: number; clientY: number; preventDefault?: () => void }) =>
    menu(e, {
      header: post.title || "Post",
      items: [
        ...(post.status === "published" && post.accountId ? [{ label: post.pinned ? "Unpin from profile" : "Pin to profile", run: () => void update({ pinned: !post.pinned }) }] : []),
        { label: "Show its pictures in Archive", disabled: photos.length ? undefined : "No pictures yet", run: () => { setQuery({ post: id, order: "newest" }); setSelection(new Set()); go({ name: "pictures" }); } },
        "sep" as const,
        { label: post.status === "archived" ? "Unarchive (back to Building)" : "Archive post", run: () => void move(post.status === "archived" ? "building" : "archived") },
        { label: "Delete post…", danger: true, run: () => void ask("Delete this post?", `« ${post.title} » goes to Recently deleted for 30 days. Its ${photos.length === 1 ? "picture stays" : `${photos.length} pictures stay`} in Archive.`, "Delete post").then((yes) => { if (yes) void del(); }) },
      ],
    });
  const cover = photos[0];
  const rest = photos.slice(1);
  const slideMenu = (e: React.MouseEvent, i: number) =>
    photoMenu(e, [photos[i].id], { open: () => setSlide(i), edited: photos[i].edited, filename: photos[i].filename, inside: { kind: "post", id, name: title || "post" }, onRemoved: load });
  const dragProps = (i: number) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(SLIDE_DRAG, String(i));
      e.dataTransfer.effectAllowed = "move";
      setDrag(i);
    },
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(SLIDE_DRAG)) return;
      e.preventDefault();
      setOverIdx(i);
    },
    onDragLeave: (e: DragEvent) => {
      if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) return;
      setOverIdx((o) => (o === i ? null : o));
    },
    onDragEnd: endDrag,
    onDrop: (e: DragEvent) => dropAt(e, i),
  });
  const tile = (i: number, big = false) => {
    const p = photos[i];
    return (
      <div
        key={p.id}
        ref={big ? coverRef : undefined}
        className={`pe-tile${big ? " cover" : ""}${drag === i ? " dragging" : ""}${overIdx === i && drag !== i ? " over" : ""}${shown === i ? " shown" : ""}`}
        {...dragProps(i)}
        onClick={() => setSlide(i)}
        onDoubleClick={() => editIds(photos.map((x) => x.id), i)}
        onContextMenu={(e) => slideMenu(e, i)}
        tabIndex={0}
        role="button"
        aria-label={`${big ? "Cover" : `Picture ${i + 1}`}: ${p.filename}. Option and arrow keys move it.`}
        onKeyDown={(e) => {
          // ⌥← ⌥→ move it in the carousel; Enter shows it in the preview.
          if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowUp") && i > 0) { e.preventDefault(); void reorder(i, i - 1); setSlide(i - 1); }
          else if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowDown") && i < photos.length - 1) { e.preventDefault(); void reorder(i, i + 1); setSlide(i + 1); }
          else if (e.key === "Enter") { e.preventDefault(); setSlide(i); }
        }}
        title={p.filename}
      >
        <EditedImage id={p.id} hash={p.thumbhash} aspect={big ? ratioAspect(post.exportRatio) : 1} px={big ? coverPx : 240} />
        <span className="pe-n">{big ? "Cover" : i + 1}</span>
        {p.edited && <span className="pe-ed" aria-label="Edited">✓</span>}
        {p.isVideo && <VideoBadge seconds={p.duration} />}
        <button type="button" className="rm" aria-label={`Remove photo ${i + 1} from post`} onClick={(e) => { e.stopPropagation(); void remove(p.id); }}>✕</button>
        {!big && (
          <button type="button" className="pe-mk" aria-label={`Make photo ${i + 1} the cover`} onClick={(e) => { e.stopPropagation(); void reorder(i, 0); }}>Cover</button>
        )}
      </div>
    );
  };

  const preview = (
    <section className="card pe-col pe-preview" aria-label="Instagram preview">
      <p className="eyebrow"><span>Preview</span><span>{photos.length ? `${shown + 1} / ${photos.length}` : ""}</span></p>
      <div className="seg pe-ratio" role="group" aria-label="Export ratio">
        {(["3:4", "4:5", "1:1"] as const).map((r) => (
          <button key={r} type="button" aria-pressed={post.exportRatio === r} onClick={() => void update({ exportRatio: r })}>{r}</button>
        ))}
      </div>
      <div className="pe-ig">
        <div className="pe-ig-head">
          <span className="pe-av"><Thumb id={account?.avatarPhotoId} hash={account?.avatarThumbhash} /></span>
          <b>{account?.username ?? "your_account"}</b>
        </div>
        <div className="pe-stage">
          <button
            type="button"
            className="frame pe-frame"
            style={{ aspectRatio: String(ratioAspect(post.exportRatio)) }}
            onClick={() => photos.length && setSlide((shown + 1) % photos.length)}
            aria-label="Show the next slide"
          >
            {photos[shown] ? (
              <EditedImage key={photos[shown].id} id={photos[shown].id} hash={photos[shown].thumbhash} aspect={ratioAspect(post.exportRatio)} px={720} />
            ) : (
              <span className="meta">Add pictures to see the post</span>
            )}
            {shown === 0 && photos.length > 0 && post.exportRatio !== "3:4" && <TileOverlay aspect={ratioAspect(post.exportRatio)} offset={tileDraft ?? post.tileOffset} />}
          </button>
        </div>
        <div className="dots">{photos.map((p, i) => <i key={p.id} className={i === shown ? "on" : ""} />)}</div>
        {photos.length > 0 && post.exportRatio !== "3:4" && (
          <label className="tile-shift">
            <span className="meta">Grid tile on the cover</span>
            <input
              id="tile-offset"
              type="range"
              min={-1}
              max={1}
              step={0.05}
              value={tileDraft ?? post.tileOffset}
              onChange={(e) => {
                const v = Number(e.target.value);
                setTileDraft(v);
                setSlide(0);
                window.clearTimeout(tileTimer.current);
                tileTimer.current = window.setTimeout(() => {
                  void update({ tileOffset: v }).then(() => setTileDraft(null));
                }, 350);
              }}
            />
          </label>
        )}
        <div className="pe-cap"><b>{account?.username ?? "your_account"}</b> {caption}</div>
      </div>
    </section>
  );

  return (
    <div className="screen pe">
      <header className="pe-a">
        <button type="button" className="pe-crumb" onClick={() => go({ name: "posts" })}>‹ Socials / Calendar</button>
        <input
          ref={titleRef}
          className="pe-title"
          aria-label="Post title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            saveText({ title: e.target.value });
          }}
        />
        {accounts.length ? (
          <span className="pe-account">
            <Select aria-label="Account" value={post.accountId ?? ""} onChange={(e) => void update({ accountId: e.target.value })}>
              {accounts.map((a) => <option key={a.id} value={a.id}>@{a.username}</option>)}
              <option value="">No account</option>
            </Select>
          </span>
        ) : (
          <button type="button" className="btn quiet small" onClick={() => go({ name: "accounts" })}>{Icon.plus()} Add an account</button>
        )}
        <button type="button" className="btn quiet small pe-more" aria-label="More" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); more({ clientX: r.left, clientY: r.bottom + 4 }); }}>⋯</button>
        <button type="button" className="btn quiet" onClick={back}>Done</button>
      </header>

      <div className="pe-b">
        <ol className="pe-steps" aria-label="Status">
          {STEPS.map((st, i) => (
            <li key={st}>
              <button
                type="button"
                className={`pe-step${post.status === st ? " on" : ""}${stepAt >= 0 && i < stepAt ? " done" : ""}`}
                aria-current={post.status === st ? "step" : undefined}
                onClick={() => void move(st)}
              >
                <i />
                {STATUS_LABEL[st]}
              </button>
            </li>
          ))}
          {post.status === "archived" && <li><span className="pe-step on archived"><i />Archived</span></li>}
        </ol>
        <div className="pe-acts">
          <button type="button" className="btn quiet small" disabled={!photos.length} onClick={() => editIds(photos.map((p) => p.id), 0)}>{Icon.edit()} Edit photos</button>
          <button
            type="button"
            className="btn quiet small"
            disabled={!!exporting || !photos.length}
            aria-label="Export for Instagram" title={`Export for Instagram: every photo with its edit at ${post.exportRatio}, numbered in carousel order; the caption goes on the clipboard`}
            onClick={() => exportForInstagram(false)}
          >
            {Icon.download()} {exporting ?? "Export"}
          </button>
          <button type="button" className="btn quiet small" disabled={!!exporting || !photos.length} aria-label="AirDrop to phone" title="AirDrop to phone: exports the carousel, then opens AirDrop to send the numbered files to your phone" onClick={() => exportForInstagram(true)}>
            AirDrop
          </button>
          {onTheWay && issues.length > 0 && (
            <button type="button" className={`pe-check${blocked ? " block" : ""}`} title={issues.map((x) => x.text).join(" · ")} onClick={() => fixIt(issues[0])}>
              {issues.length} to fix: {issues[0].text.toLowerCase()}
            </button>
          )}
          {next && nextStatus && (
            <button type="button" className="btn primary small" disabled={!!stepBlock} title={stepBlock ?? undefined} onClick={() => move(nextStatus)}>
              {next.label}
            </button>
          )}
        </div>
      </div>

      <div className={`pe-body${wordsOpen ? "" : " show-preview"}`}>
        <section className="card pe-col pe-pics" aria-label="Pictures">
          <p className="eyebrow"><span>Pictures · {photos.length} of 20</span><span>first = cover</span></p>
          <div className="pe-pics-in">
            {cover ? tile(0, true) : <button type="button" className="pe-empty" onClick={() => setPicking(true)}>{Icon.plus()} Add pictures</button>}
            {cover && (
              <div className="pe-grid">
                {rest.map((_, k) => tile(k + 1))}
                {photos.length < 20 && <button type="button" className="pe-add" aria-label="Add pictures" onClick={() => setPicking(true)}>{Icon.plus()}<span>Add</span></button>}
              </div>
            )}
          </div>
          {reused.length > 0 && (
            <p className="meta pe-reused" title={reused.map((r) => `Photo ${photos.findIndex((p) => p.id === r.photoId) + 1} was already posted in « ${r.title} »`).join("\n")}>
              {reused.length === 1 ? "1 picture was posted before" : `${reused.length} pictures were posted before`} · still fine to use
            </p>
          )}
          <div className="pe-pics-acts">
            <button type="button" className="btn quiet small" disabled={!photos.length} onClick={() => editIds(photos.map((p) => p.id), 0)}>{Icon.edit()} Edit all</button>
          </div>
        </section>

        <section className="card pe-col pe-words" aria-label="Words">
          <label className="pe-caption">
            <span className="eyebrow"><span>Caption</span><span>{caption.length.toLocaleString()} / 2,200</span></span>
            <textarea ref={captionRef} className="box" value={caption} maxLength={2200} onChange={(e) => { setCaption(e.target.value); saveText({ caption: e.target.value }); }} placeholder="Write the caption…" />
          </label>
          <div className="pe-plan">
            {post.status === "published" && post.accountId ? (
              <label>
                <span className="eyebrow">Published on</span>
                <input type="datetime-local" className="box" value={(post.publishedAt ?? "").slice(0, 16)} onChange={(e) => update({ publishedAt: e.target.value })} />
              </label>
            ) : (
              <label>
                <span className="eyebrow">Planned for</span>
                {scheduled || dateOpen ? (
                  <input type="datetime-local" className="box" autoFocus={dateOpen && !scheduled} value={scheduled} onChange={(e) => planFor(e.target.value)} onBlur={() => setDateOpen(false)} />
                ) : (
                  <button type="button" className="box pe-nodate" onClick={() => setDateOpen(true)}>No date yet</button>
                )}
              </label>
            )}
            {slot && slot !== scheduled ? (
              <button type="button" className="chip" title={`The first free day on @${account?.username}, at your usual spacing`} onClick={() => planFor(slot)}>
                Next free · {formatDay(slot)} {slot.slice(11)}
              </button>
            ) : scheduled && (post.status === "idea" || post.status === "building") ? (
              <span className="meta">Becomes Scheduled once it's ready</span>
            ) : null}
          </div>
          <label className="pe-notes">
            <span className="eyebrow">Internal notes</span>
            <textarea className="box" rows={3} value={notes} onChange={(e) => { setNotes(e.target.value); saveText({ notes: e.target.value }); }} placeholder="Only you see these…" />
          </label>
        </section>

        {preview}
        <button type="button" className="btn quiet small pe-toggle" onClick={() => setWordsOpen((v) => !v)}>{wordsOpen ? "Preview" : "Words"}</button>
      </div>

      {picking && (
        <PhotoPicker
          title="Add photos to the carousel"
          max={20 - photos.length}
          notInPost
          initial={[...selection].filter((sid) => !photos.some((p) => p.id === sid))}
          onPick={add}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

/** The part of the cover Instagram's 3:4 grid tile shows; the rest is dimmed. */
function TileOverlay({ aspect, offset }: { aspect: number; offset: number }) {
  const wide = aspect > GRID_TILE;
  const size = wide ? GRID_TILE / aspect : aspect / GRID_TILE;
  const start = ((1 - size) / 2) * (1 + offset);
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  return (
    <span className="tile-overlay" aria-hidden="true">
      <i style={wide ? { left: 0, top: 0, bottom: 0, width: pct(start) } : { top: 0, left: 0, right: 0, height: pct(start) }} />
      <i style={wide ? { right: 0, top: 0, bottom: 0, width: pct(1 - start - size) } : { bottom: 0, left: 0, right: 0, height: pct(1 - start - size) }} />
      <b style={wide ? { left: pct(start), width: pct(size), top: 0, bottom: 0 } : { top: pct(start), height: pct(size), left: 0, right: 0 }}>Grid tile</b>
    </span>
  );
}
