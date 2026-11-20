import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { PostPopover } from "../components/Actions";
import { useMenu } from "../components/ContextMenu";
import { usePostMenu } from "../components/menus";
import { restoreDeleted, SectionMore, useRecentlyDeleted } from "../components/RecentlyDeleted";
import { EditedImage } from "../components/Instagram";
import { Hero, Icon, typing, useToast, Select } from "../components/ui";
import { forgetEdits } from "../gl/edited";
import { formatDay, STATUS_LABEL } from "../lib/format";
import { isDue, moveTarget, needsPhotos, NEXT, prevStep } from "../lib/postFlow";
import { useStore } from "../store";
import type { Post, PostInput, PostStatus } from "../types";

const COLUMNS: PostStatus[] = ["idea", "building", "ready", "scheduled", "published"];
/** Only our own cards: dragged Finder files and text are not board moves. */
const DRAG_TYPE = "application/x-cba-post";
const MAX_PHOTOS = 20;

const POST_KIND: ["post"] = ["post"];

export function Posts() {
  const { go, accounts, version, bump, selection } = useStore();
  const toast = useToast();
  const [posts, setPosts] = useState<Post[]>([]);
  const [account, setAccount] = useState<string>("");
  const [over, setOver] = useState<PostStatus | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const dragId = useRef<string | null>(null);
  // dragenter/dragleave fire for every child a drag crosses: count them per column.
  const depth = useRef<Record<string, number>>({});
  // A card moved with ⌥←/⌥→ lands in another column as a new element: keep it focused.
  const refocus = useRef<{ id: string; until: number } | null>(null);
  const load = () => api.listPosts(account ? { account } : undefined).then(setPosts).catch(() => {});
  useEffect(() => {
    // Covers show the saved edit; it may have changed since the last visit.
    forgetEdits();
    load();
  }, [account, version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const r = refocus.current;
    if (!r || Date.now() > r.until) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    document.querySelector<HTMLElement>(`.board [data-id="${CSS.escape(r.id)}"]`)?.focus();
  }, [posts]);

  const open = (id: string) => go({ name: "post", id });
  const postMenu = usePostMenu();
  const { open: openMenu } = useMenu();
  const recently = useRecentlyDeleted(POST_KIND, "Socials");
  // With photos picked: choose one carousel or a post per photo (or add to a planned post).
  const [newAt, setNewAt] = useState<HTMLElement | null>(null);
  const create = async () => {
    const picked = [...selection];
    try {
      const p = await api.createPost({ title: "New post", accountId: account || accounts[0]?.id }, picked.length ? picked.slice(0, MAX_PHOTOS) : undefined);
      if (picked.length) bump();
      if (picked.length > MAX_PHOTOS) toast("A carousel holds 20 photos: the first 20 were added");
      open(p.id);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  // One move per post at a time (a double click must not also move the card
  // that slides in under the pointer).
  const inFlight = useRef(new Set<string>());
  const move = async (id: string, status: PostStatus, patch: PostInput = {}) => {
    const p = posts.find((x) => x.id === id);
    if (!p) return;
    status = moveTarget(p, status);
    if (p.status === status && !Object.keys(patch).length) return;
    // The same blockers as the post editor. A published post brought back from
    // Archived is history, not a plan: it needs neither.
    const restoring = p.status === "archived" && status === "published";
    if (needsPhotos(status) && !restoring) {
      if (!p.photoCount) return toast("Add photos first", { error: true });
      if (!p.accountId && accounts.length) return toast("Pick an account first: open the post", { error: true });
    }
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    const prev = { status: p.status, scheduledAt: p.scheduledAt, publishedAt: p.publishedAt, pinned: p.pinned };
    setPosts((ps) =>
      ps.map((x) =>
        x.id === id
          ? {
              ...x,
              status,
              scheduledAt: patch.scheduledAt === undefined ? x.scheduledAt : patch.scheduledAt || null,
              publishedAt: status === "published" || status === "archived" ? x.publishedAt : null,
            }
          : x,
      ),
    );
    try {
      await api.updatePost(id, { status, ...patch });
      bump();
      toast(`Moved to ${STATUS_LABEL[status]}`, {
        action: {
          label: "Undo",
          run: () => {
            // Passing the old date (and pin) puts them back when undoing a move out of Published.
            const back: PostInput = {
              status: prev.status,
              scheduledAt: prev.scheduledAt ?? "",
              ...(prev.publishedAt ? { publishedAt: prev.publishedAt } : {}),
              ...(prev.status === "published" && prev.pinned ? { pinned: true } : {}),
            };
            api.updatePost(id, back).then(bump).catch((e) => toast(errorText(e), { error: true }));
          },
        },
      });
    } catch (e) {
      toast(errorText(e), { error: true });
      load();
    } finally {
      inFlight.current.delete(id);
    }
  };

  // Remove takes a post off the plan into Archived (Undo puts it back where it
  // was); from Archived it can be deleted (to Recently deleted, 30 days), after a second click.
  const remove = async (p: Post) => {
    try {
      await api.updatePost(p.id, { status: "archived" });
      setPosts((cur) => cur.map((x) => (x.id === p.id ? { ...x, status: "archived" } : x)));
      bump();
      const back: PostInput = { status: p.status, scheduledAt: p.scheduledAt ?? "", ...(p.publishedAt ? { publishedAt: p.publishedAt } : {}), ...(p.pinned ? { pinned: true } : {}) };
      toast(`Removed “${p.title}” from the plan (kept in Archived)`, {
        action: { label: "Undo", run: () => void api.updatePost(p.id, back).then(bump).catch((e) => toast(errorText(e), { error: true })) },
      });
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const [sure, setSure] = useState<string | null>(null);
  const deleteForGood = async (p: Post) => {
    if (sure !== p.id) return setSure(p.id);
    try {
      await api.deletePost(p.id);
      setSure(null);
      setPosts((cur) => cur.filter((x) => x.id !== p.id));
      bump();
      toast(`“${p.title}” moved to Recently deleted · its photos stay in your library`, { action: { label: "Undo", run: () => void restoreDeleted("post", p.id).then(bump, (e) => toast(errorText(e), { error: true })) } });
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };

  const onCardKey = (e: React.KeyboardEvent<HTMLDivElement>, p: Post) => {
    if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      open(p.id);
      return;
    }
    if (!e.altKey || e.metaKey || e.ctrlKey || typing(e.nativeEvent)) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    if (e.repeat) return; // holding ⌥→ must not walk a post all the way to Published
    const step = e.key === "ArrowRight" ? NEXT[p.status] : prevStep(p);
    if (!step) return;
    refocus.current = { id: p.id, until: Date.now() + 3000 };
    void move(p.id, step.status, step.patch);
  };
  // Enter and Space on a card's own buttons must not also open the card.
  const keepKeys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") e.stopPropagation();
  };
  // WebKit may hide custom types until the drop, so a drag we started counts too.
  const ours = (e: React.DragEvent) => dragId.current != null || e.dataTransfer.types.includes(DRAG_TYPE);
  const endDrag = () => {
    dragId.current = null;
    depth.current = {};
    setDragging(null);
    setOver(null);
  };

  const archived = posts.filter((p) => p.status === "archived").length;
  const columns: PostStatus[] = showArchived ? [...COLUMNS, "archived"] : COLUMNS;
  const onTheWay = posts.filter((p) => p.status !== "published" && p.status !== "archived").length;
  return (
    <div className="screen">
      <Hero title="The" italic="reveal" sub={`${onTheWay} posts on the way · drag a card or use ‹ › to move it`}>
        <Select className="pick" aria-label="Account" value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="">All accounts</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>@{a.username}</option>)}
        </Select>
        {(archived > 0 || showArchived) && (
          <button type="button" className="btn quiet" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
            Archived · {archived}
          </button>
        )}
        <button type="button" className="btn primary" aria-expanded={!!newAt} onClick={(e) => (selection.size > 1 ? setNewAt(newAt ? null : e.currentTarget) : void create())}>
          {Icon.plus()} {selection.size > 1 ? `New from ${selection.size} picked…` : selection.size ? "New post with 1 picked" : "New post"}
        </button>
        {newAt && <PostPopover anchor={newAt} ids={[...selection]} onClose={() => setNewAt(null)} />}
        <SectionMore label="Socials" items={[recently.item]} />
      </Hero>
      <div
        className="board"
        style={showArchived ? { gridTemplateColumns: "repeat(6, minmax(210px, 1fr))" } : undefined}
        onContextMenu={(e) => {
          // Empty space on the board: what can be made here.
          if ((e.target as HTMLElement).closest(".post-card")) return;
          openMenu(e, { header: "Calendar", items: [{ label: selection.size ? `New post with ${selection.size} picked` : "New post", run: () => void create() }, ...recently.menu] });
        }}
      >
        {columns.map((status) => {
          const list = posts.filter((p) => p.status === status);
          return (
            <section
              key={status}
              className={over === status ? "board-col drop" : "board-col"}
              onDragEnter={(e) => {
                if (!ours(e)) return;
                depth.current[status] = (depth.current[status] ?? 0) + 1;
                setOver(status);
              }}
              onDragOver={(e) => {
                if (!ours(e)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOver(status);
              }}
              onDragLeave={(e) => {
                if (!ours(e)) return;
                const left = Math.max(0, (depth.current[status] ?? 0) - 1);
                depth.current[status] = left;
                if (!left) setOver((o) => (o === status ? null : o));
              }}
              onDrop={(e) => {
                const id = e.dataTransfer.getData(DRAG_TYPE) || dragId.current;
                endDrag();
                if (!id) return;
                e.preventDefault();
                void move(id, status);
              }}
            >
              <div className="side-head" style={{ marginBottom: 0 }}>
                <span className={`stagepill st-${status}`}>{STATUS_LABEL[status]}</span>
                <span className="tot">{list.length}</span>
              </div>
              <div className="cards">
                {list.map((p) => {
                  const due = isDue(p);
                  const next = NEXT[p.status];
                  const prev = prevStep(p);
                  const blocked = !!next && needsPhotos(next.status) && !p.photoCount;
                  return (
                    <div
                      key={p.id}
                      className={`post-card${due ? " due" : ""}${dragging === p.id ? " dragging" : ""}`}
                      draggable
                      tabIndex={0}
                      role="button"
                      aria-label={p.title}
                      data-id={p.id}
                      onClick={() => open(p.id)}
                      onContextMenu={(e) => postMenu(e, p)}
                      onKeyDown={(e) => onCardKey(e, p)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DRAG_TYPE, p.id);
                        // WebKit may want a standard type before it starts a drag.
                        e.dataTransfer.setData("text/plain", p.title);
                        e.dataTransfer.effectAllowed = "move";
                        dragId.current = p.id;
                        // Next frame, so the drag image is taken before the card fades.
                        requestAnimationFrame(() => dragId.current === p.id && setDragging(p.id));
                      }}
                      onDragEnd={endDrag}
                    >
                      <span className="cv"><EditedImage id={p.coverPhotoId} hash={p.coverThumbhash} aspect={54 / 67} px={108} /></span>
                      <span style={{ minWidth: 0 }}>
                        <b>{p.title}</b>
                        <span className="meta" style={{ display: "block" }}>{p.accountUsername ? `@${p.accountUsername}` : "No account"}</span>
                        <span className="meta" style={{ display: "block" }}>
                          {p.photoCount} {p.photoCount === 1 ? "photo" : "photos"}
                          {p.publishedAt ? ` · ${formatDay(p.publishedAt)}` : p.scheduledAt ? ` · ${formatDay(p.scheduledAt)}` : ""}
                        </span>
                      </span>
                      <div className="post-card-acts">
                        {p.status === "archived" ? (
                          <button
                            type="button"
                            draggable={false}
                            className={sure === p.id ? "danger" : undefined}
                            title="Delete this post for good (its photos stay in your library)"
                            onClick={(e) => {
                              e.stopPropagation();
                              void deleteForGood(p);
                            }}
                            onBlur={() => sure === p.id && setSure(null)}
                            onKeyDown={keepKeys}
                          >
                            {sure === p.id ? "Sure? Delete" : "Delete…"}
                          </button>
                        ) : (
                          <button
                            type="button"
                            draggable={false}
                            className="remove"
                            aria-label={`Remove ${p.title} from the plan`}
                            title="Remove from the plan (it goes to Archived; Undo in the message)"
                            onClick={(e) => {
                              e.stopPropagation();
                              void remove(p);
                            }}
                            onKeyDown={keepKeys}
                          >
                            Remove
                          </button>
                        )}
                        {prev && (
                          <button
                            type="button"
                            draggable={false}
                            aria-label={`Back to ${STATUS_LABEL[prev.status]}`}
                            title={`Back to ${STATUS_LABEL[prev.status]}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (e.detail > 1) return;
                              void move(p.id, prev.status, prev.patch);
                            }}
                            onKeyDown={keepKeys}
                          >
                            ‹
                          </button>
                        )}
                        {next && (
                          <button
                            type="button"
                            draggable={false}
                            disabled={blocked}
                            title={blocked ? "Add photos first" : `Move to ${STATUS_LABEL[next.status]}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (e.detail > 1) return;
                              void move(p.id, next.status, next.patch);
                            }}
                            onKeyDown={keepKeys}
                          >
                            {due ? "Posted ✓" : `${next.label} ›`}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
                {!list.length && <p className="meta" style={{ margin: "6px 2px" }}>Nothing here</p>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
