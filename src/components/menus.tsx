// What each kind of thing offers on right-click (NIRMATA Amendment 7).
// « Remove » takes it out of a container (album, post, project); « Delete »
// removes the item itself, asks once and offers Undo for 10 s. No menu item
// ever deletes an original file: for pictures the strongest action is Reject;
// permanent deletion stays in Clean up with its own confirmation.
import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { NO_ADJUSTMENTS, type Album, type PhotoLook, type Post, type PostStatus, type Query } from "../types";
import { WEB } from "../platform";
import { useStore } from "../store";
import { STATUS_LABEL } from "../lib/format";
import { exportCarousel, copyText } from "../lib/instagramExport";
import { DEFAULT_CADENCE, loadCadence, nextFreeSlots } from "../lib/slots";
import { studio } from "../studio/api";
import { STAGES, type Idea, type Piece } from "../studio/types";
import { AlbumPopover, PostPopover, ProjectPopover } from "./Actions";
import { useMenu, type MenuItem } from "./ContextMenu";
import { Modal, useToast } from "./ui";
import { DownloadSheet } from "./DownloadSheet";
import { restoreDeleted } from "./RecentlyDeleted";

const MAC_ONLY = "Mac only";
const UNDO_MS = 10_000;
const n = (k: number, one: string, many = `${one}s`) => `${k.toLocaleString()} ${k === 1 ? one : many}`;
const dirOf = (path: string) => path.replace(/\/[^/]*$/, "");

/** A look copied with « Copy look », for « Paste look ». */
let copiedLook: PhotoLook | null = null;

/** Asks once, in the app's own dialog. Focus starts on Cancel and the red
 *  button arms after 0.4 s, so neither Enter nor a double click can confirm a
 *  delete by accident (NIRMATA, 19 Nov). */
export function useAsk() {
  const { popover } = useMenu();
  return (title: string, text: string, ok: string) =>
    new Promise<boolean>((resolve) =>
      popover((_, close) => <AskBody title={title} text={text} ok={ok} done={(yes) => { close(); resolve(yes); }} />),
    );
}

function AskBody({ title, text, ok, done }: { title: string; text: string; ok: string; done: (yes: boolean) => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setArmed(true), 400);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <Modal
      title={title}
      onClose={() => done(false)}
      foot={
        <>
          <button type="button" className="btn quiet" autoFocus onClick={() => done(false)}>Cancel</button>
          <button type="button" className="btn danger" disabled={!armed} onClick={() => done(true)}>{ok}</button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{text}</p>
    </Modal>
  );
}

export type Inside = { kind: "album" | "post" | "project"; id: string; name: string };

/** Right-click on a picture or video, or on a picked set of them. */
export function usePhotoMenu() {
  const s = useStore();
  const { open, popover } = useMenu();
  const toast = useToast();

  const showInArchive = async (id: string) => {
    try {
      const d = await api.detail(id);
      const primary = d.assets.find((a) => a.isPrimary) ?? d.assets[0];
      const query: Query = primary ? { folder: dirOf(primary.path), order: "oldest" } : { order: "newest" };
      const index = (await api.position(query, id).catch(() => null)) ?? 0;
      s.setQuery(query);
      s.setSelection(new Set());
      s.go({ name: "detail", id, query, index });
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const reveal = async (id: string) => {
    try {
      if (WEB) {
        const link = await api.driveLink(id);
        if (!link) return toast("This picture is not on Google Drive yet", { error: true });
        window.open(link, "_blank", "noreferrer");
        return;
      }
      const d = await api.detail(id);
      const primary = d.assets.find((a) => a.isPrimary) ?? d.assets[0];
      if (primary) await api.reveal(primary.path);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };

  return (
    e: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void },
    ids: string[],
    opts: { open?: () => void; edited?: boolean; filename?: string; video?: boolean; inside?: Inside; onRemoved?: () => void } = {},
  ) => {
    if (!ids.length) return;
    const one = ids.length === 1;
    const id = ids[0];
    const mark = (state: "selected" | "maybe" | "rejected" | "unreviewed") => async () => {
      const ok = await s.mark(ids, state);
      if (ok !== false) toast(`${n(ids.length, "picture")} ${state === "unreviewed" ? "unmarked" : `marked ${state === "selected" ? "Select" : state === "maybe" ? "Maybe" : "Reject"}`}`, { action: { label: "Undo", run: () => void s.undoMark() }, ms: UNDO_MS });
    };
    const remove = async () => {
      const inside = opts.inside!;
      try {
        if (inside.kind === "album") {
          await api.albumRemove(inside.id, ids);
          toast(`${n(ids.length, "picture")} removed from ${inside.name} · still in Archive`, { action: { label: "Undo", run: () => void api.albumAdd(inside.id, ids).then(() => { s.bump(); s.reloadMeta(); }) }, ms: UNDO_MS });
          s.reloadMeta();
        } else if (inside.kind === "post") {
          const before = (await api.getPost(inside.id)).photos.map((p) => p.id);
          await api.postRemovePhotos(inside.id, ids);
          toast(`${n(ids.length, "picture")} removed from ${inside.name} · still in Archive`, {
            action: { label: "Undo", run: () => void api.postAddPhotos(inside.id, ids).then(() => api.postReorder(inside.id, before)).then(() => s.bump()) },
            ms: UNDO_MS,
          });
        } else {
          for (const pid of ids) await studio.link("pieceMedia", inside.id, pid, false);
          toast(`${n(ids.length, "picture")} removed from ${inside.name} · still in Archive`, {
            action: { label: "Undo", run: () => void Promise.all(ids.map((pid) => studio.link("pieceMedia", inside.id, pid, true))).then(() => s.bump()) },
            ms: UNDO_MS,
          });
        }
        s.bump();
        opts.onRemoved?.();
      } catch (err) {
        toast(errorText(err), { error: true });
      }
    };
    const items: MenuItem[] = [
      ...(one ? [{ label: "Open", run: opts.open ?? (() => void showInArchive(id)) }] : []),
      { label: one ? "Edit" : `Edit ${ids.length}`, disabled: WEB ? MAC_ONLY : undefined, run: () => s.editIds(ids) },
      "sep",
      { label: "Select", hint: "A", run: mark("selected") },
      { label: "Maybe", hint: "S", run: mark("maybe") },
      { label: "Clear mark", run: mark("unreviewed") },
      "sep",
      { label: "Add to post…", disabled: WEB ? MAC_ONLY : undefined, run: () => popover((a, close) => <PostPopover anchor={a} ids={ids} onClose={close} />) },
      { label: "Add to project…", run: () => popover((a, close) => <ProjectPopover anchor={a} ids={ids} onClose={close} />) },
      { label: "Add to album…", run: () => popover((a, close) => <AlbumPopover anchor={a} ids={ids} onClose={close} />) },
      "sep",
      ...(one
        ? [
            { label: "Show in Archive", run: () => void showInArchive(id) },
            {
              label: "Show original",
              disabled: WEB ? MAC_ONLY : opts.edited === false ? "Not edited" : undefined,
              run: () => {
                try { sessionStorage.setItem("cba.editor.compare", "original"); } catch { /* fine */ }
                s.editIds([id]);
              },
            },
            { label: WEB ? "Open in Drive" : "Reveal in Finder", run: () => void reveal(id) },
            ...(WEB
              ? [{ label: "Download…", run: () => popover((_, close) => <DownloadSheet photoId={id} video={opts.video} onClose={close} />) }]
              : [
                  {
                    label: "Export…",
                    // Videos: the viewer's export panel (size, quality, estimate); pictures: the editor's export.
                    run: () => (opts.video ? (opts.open ? opts.open() : void showInArchive(id)) : s.editIds([id])),
                  },
                  {
                    label: "Save the original file",
                    run: async () => {
                      try {
                        const path = await api.saveOriginal(id);
                        await api.reveal(path).catch(() => {});
                        toast(`Original saved to Downloads · ${path.split("/").pop()}`);
                      } catch (err) {
                        toast(errorText(err), { error: true });
                      }
                    },
                  },
                ]),
            {
              label: "Copy file name",
              disabled: opts.filename ? undefined : "Name unknown",
              run: () => void copyText(opts.filename ?? "").then((ok) => toast(ok ? `Copied ${opts.filename}` : "Couldn't copy", { error: !ok })),
            },
            { label: "Info", run: opts.open ?? (() => void showInArchive(id)) },
          ]
        : [{ label: "Show in Archive", disabled: "One picture at a time" }]),
      "sep",
      ...(one && opts.inside?.kind === "album"
        ? [{
            label: "Set as album cover",
            run: async () => {
              const inside = opts.inside!;
              const before = s.albums.find((a) => a.id === inside.id)?.coverPhotoId ?? undefined;
              await api.updateAlbum(inside.id, { coverPhotoId: id });
              s.reloadMeta();
              toast(`Cover of ${inside.name} set`, { action: { label: "Undo", run: () => void api.updateAlbum(inside.id, { coverPhotoId: before }).then(() => s.reloadMeta()) }, ms: UNDO_MS });
            },
          }]
        : []),
      ...(opts.inside ? [{ label: `Remove from this ${opts.inside.kind}`, run: () => void remove() }] : []),
      { label: one ? "Reject" : `Reject ${ids.length}`, hint: "D", danger: true, run: mark("rejected") },
    ];
    open(e, { header: one ? (opts.filename ?? "Picture") : n(ids.length, "picture"), items });
  };
}

/** Right-click on a post card (Calendar, Grid). */
export function usePostMenu() {
  const s = useStore();
  const { open } = useMenu();
  const toast = useToast();
  const ask = useAsk();

  return (e: { clientX: number; clientY: number; preventDefault?: () => void }, post: Post) => {
    const set = (input: Parameters<typeof api.updatePost>[1], say?: string) => async () => {
      try {
        const before = await api.getPost(post.id);
        await api.updatePost(post.id, input);
        s.bump();
        toast(say ?? "Post updated", {
          action: { label: "Undo", run: () => void api.updatePost(post.id, { status: before.status, scheduledAt: before.scheduledAt ?? "", accountId: before.accountId ?? "" }).then(() => s.bump()) },
          ms: UNDO_MS,
        });
      } catch (err) {
        toast(errorText(err), { error: true });
      }
    };
    const nextFree = async () => {
      const all = await api.listPosts(post.accountId ? { account: post.accountId } : undefined).catch(() => [] as Post[]);
      const cadence = await loadCadence().catch(() => DEFAULT_CADENCE);
      const slot = nextFreeSlots(all, 1, cadence, post.id)[0];
      if (!slot) return toast("No free slot found", { error: true });
      await set({ scheduledAt: slot, ...(post.status === "ready" ? { status: "scheduled" as PostStatus } : {}) }, `Planned for ${slot.replace("T", " ")}`)();
    };
    const duplicate = async () => {
      try {
        const d = await api.getPost(post.id);
        const copy = await api.createPost({ title: `${d.title} (copy)`, caption: d.caption, notes: d.notes, accountId: d.accountId ?? undefined, status: d.status === "published" || d.status === "archived" ? "building" : d.status, exportRatio: d.exportRatio }, d.photos.map((p) => p.id));
        s.bump();
        toast(`Duplicated as « ${copy.title} »`, { action: { label: "Open", run: () => s.go({ name: "post", id: copy.id }) } });
      } catch (err) {
        toast(errorText(err), { error: true });
      }
    };
    const exportIt = async (send: boolean) => {
      try {
        const d = await api.getPost(post.id);
        if (!d.photos.length) return toast("This post has no pictures yet", { error: true });
        if (d.caption.trim()) void copyText(d.caption);
        const paths = await exportCarousel(d, () => {});
        if (send) await api.airdrop(paths);
        toast(`${n(paths.length, "file")} exported${d.caption.trim() ? " · caption copied" : ""}`, { action: { label: "Show in Finder", run: () => void api.reveal(paths[paths.length - 1]) } });
      } catch (err) {
        toast(errorText(err), { error: true });
      }
    };
    const del = async () => {
      if (!(await ask("Delete this post?", `« ${post.title} » goes to Recently deleted for 30 days; its ${n(post.photoCount, "picture")} stay in Archive.`, "Delete post"))) return;
      try {
        const d = await api.getPost(post.id);
        await api.deletePost(post.id);
        s.forgetRoute(post.id);
        s.bump();
        toast(`Post « ${d.title} » moved to Recently deleted · pictures stay`, {
          action: { label: "Undo", run: () => void restoreDeleted("post", post.id).then(() => s.bump(), (e) => toast(errorText(e), { error: true })) },
          ms: UNDO_MS,
        });
      } catch (err) {
        toast(errorText(err), { error: true });
      }
    };
    const statuses: PostStatus[] = ["idea", "building", "ready", "scheduled", "published"];
    const items: MenuItem[] = [
      { label: "Open", run: () => s.go({ name: "post", id: post.id }) },
      "sep",
      { label: "Move to", items: statuses.map((st) => ({ label: STATUS_LABEL[st], checked: post.status === st, run: set({ status: st }, `Moved to ${STATUS_LABEL[st]}`) })) },
      {
        label: "Plan for",
        disabled: WEB ? MAC_ONLY : undefined,
        items: [
          { label: "Next free slot", run: () => void nextFree() },
          { label: "Pick a date…", run: () => s.go({ name: "post", id: post.id }) },
          ...(post.scheduledAt ? [{ label: "Clear the date", run: set({ scheduledAt: "", ...(post.status === "scheduled" ? { status: "ready" as PostStatus } : {}) }, "Date cleared") }] : []),
        ],
      },
      {
        label: "Account",
        disabled: WEB ? MAC_ONLY : s.accounts.length ? undefined : "No account yet",
        items: [...s.accounts.map((a) => ({ label: `@${a.username}`, checked: post.accountId === a.id, run: set({ accountId: a.id }, `Now on @${a.username}`) })), { label: "None", checked: !post.accountId, run: set({ accountId: "" }, "No account") }],
      },
      "sep",
      { label: "Duplicate", disabled: WEB ? MAC_ONLY : undefined, run: () => void duplicate() },
      { label: "Export for Instagram", disabled: WEB ? MAC_ONLY : !post.photoCount ? "No pictures yet" : undefined, run: () => void exportIt(false) },
      { label: "AirDrop to phone", disabled: WEB ? MAC_ONLY : !post.photoCount ? "No pictures yet" : undefined, run: () => void exportIt(true) },
      {
        label: "Show its pictures in Archive",
        disabled: WEB ? MAC_ONLY : undefined,
        run: () => { s.setQuery({ post: post.id, order: "newest" }); s.setSelection(new Set()); s.go({ name: "pictures" }); },
      },
      "sep",
      { label: post.status === "archived" ? "Unarchive post" : "Archive post", disabled: WEB ? MAC_ONLY : undefined, run: set({ status: post.status === "archived" ? "building" : "archived" }, post.status === "archived" ? "Back to Building" : "Post archived") },
      { label: "Delete post…", danger: true, disabled: WEB ? MAC_ONLY : undefined, run: () => void del() },
    ];
    open(e, { header: post.title || "Post", items });
  };
}

/** Right-click on an idea or a project card. */
export function useIdeaMenu() {
  const s = useStore();
  const { open } = useMenu();
  const toast = useToast();
  const ask = useAsk();
  return (e: { clientX: number; clientY: number; preventDefault?: () => void }, thing: { kind: "idea"; row: Idea } | { kind: "project"; row: Piece }) => {
    const list = thing.kind === "idea" ? "ideas" : "pieces";
    const row = thing.row as unknown as Record<string, unknown> & { id: string; title: string };
    const save = (patch: Record<string, unknown>, say: string) => async () => {
      const before = Object.fromEntries(Object.keys(patch).map((k) => [k, row[k] ?? null]));
      await studio.save(list, row.id, patch);
      s.bump();
      toast(say, { action: { label: "Undo", run: () => void studio.save(list, row.id, before).then(() => s.bump()) }, ms: UNDO_MS });
    };
    const mediaIds = async () => (thing.kind === "project" ? await studio.linked("pieceMedia", "a", row.id).catch(() => [] as string[]) : []);
    const del = async () => {
      if (!(await ask(`Delete this ${thing.kind}?`, `« ${row.title} » goes to Recently deleted for 30 days.`, `Delete ${thing.kind}`))) return;
      await studio.remove(list, row.id, "menu");
      s.bump();
      const kind = thing.kind === "idea" ? "idea" : "project";
      toast(`« ${row.title} » moved to Recently deleted`, { action: { label: "Undo", run: () => void restoreDeleted(kind, row.id).then(() => s.bump(), (e) => toast(errorText(e), { error: true })) }, ms: UNDO_MS });
    };
    const ideaSteps: [string, string][] = [["inbox", "New"], ["keep", "Kept"], ["maybe", "Maybe"], ["greenlit", "Green-lit"], ["parked", "Parked"]];
    const items: MenuItem[] = [
      { label: "Open", run: () => s.go(thing.kind === "idea" ? { name: "ideas" } : { name: "write", id: row.id }) },
      "sep",
      thing.kind === "idea"
        ? { label: "Move to", items: ideaSteps.map(([k, l]) => ({ label: l, checked: row.status === k, run: save({ status: k }, `Moved to ${l}`) })) }
        : { label: "Move to", items: STAGES.map((st) => ({ label: st.label, checked: row.stage === st.id, run: save({ stage: st.id }, `Moved to ${st.label}`) })) },
      {
        label: "Make a post from it",
        disabled: WEB ? MAC_ONLY : undefined,
        run: async () => {
          const ids = await mediaIds();
          const p = await api.createPost({ title: row.title, status: ids.length ? "building" : "idea" }, ids);
          s.bump();
          s.go({ name: "post", id: p.id });
        },
      },
      {
        label: "Duplicate",
        run: async () => {
          const { id: _drop, ...rest } = row;
          void _drop;
          await studio.save(list, null, { ...rest, title: `${row.title} (copy)` });
          s.bump();
          toast("Duplicated");
        },
      },
      {
        label: "Show its pictures in Archive",
        disabled: thing.kind === "idea" ? "No pictures" : undefined,
        run: async () => {
          const ids = await mediaIds();
          if (!ids.length) return toast("No pictures in this project yet");
          s.setSelection(new Set(ids));
          s.setQuery({ order: "newest" });
          s.go({ name: "pictures" });
          toast(`${n(ids.length, "picture")} picked in Archive`);
        },
      },
      "sep",
      thing.kind === "idea"
        ? { label: "Archive (park)", run: save({ status: "parked" }, "Parked") }
        : { label: row.parked ? "Unpark" : "Archive (park)", run: save({ parked: !row.parked }, row.parked ? "Back in progress" : "Parked") },
      { label: `Delete ${thing.kind}…`, danger: true, run: () => void del() },
    ];
    open(e, { header: row.title, items });
  };
}

/** Right-click on an album. */
export function useAlbumMenu(rename: (a: Album) => void) {
  const s = useStore();
  const { open } = useMenu();
  const toast = useToast();
  const ask = useAsk();
  return (e: { clientX: number; clientY: number; preventDefault?: () => void }, a: Album) => {
    const show = () => { s.setQuery({ album: a.id, order: "newest" }); s.setSelection(new Set()); s.go({ name: "pictures" }); };
    const del = async () => {
      if (!(await ask("Delete this album?", `« ${a.name} » goes to Recently deleted for 30 days; its ${n(a.photoCount, "picture")} stay in Archive.`, "Delete album"))) return;
      await api.deleteAlbum(a.id, "menu");
      s.reloadMeta();
      s.bump();
      toast(`Album « ${a.name} » moved to Recently deleted · pictures stay`, { action: { label: "Undo", run: () => void restoreDeleted("album", a.id).then(() => { s.reloadMeta(); s.bump(); }, (e) => toast(errorText(e), { error: true })) }, ms: UNDO_MS });
    };
    open(e, {
      header: a.name,
      items: [
        { label: "Open", run: show },
        "sep",
        { label: "Rename…", run: () => rename(a) },
        { label: "Set cover…", run: () => { show(); toast("Right-click the picture you want and choose « Set as album cover »"); } },
        {
          label: "Make a post from it",
          disabled: WEB ? MAC_ONLY : undefined,
          run: async () => {
            const ids = await api.photoIds({ album: a.id, order: "newest" }, 0, 20);
            const p = await api.createPost({ title: a.name, status: ids.length ? "building" : "idea" }, ids);
            s.bump();
            s.go({ name: "post", id: p.id });
          },
        },
        "sep",
        { label: "Delete album…", danger: true, run: () => void del() },
      ],
    });
  };
}

/** Right-click on an edit (the Edit tab). */
export function useEditMenu() {
  const s = useStore();
  const { open } = useMenu();
  const toast = useToast();
  const ask = useAsk();
  const photo = usePhotoMenu();
  void photo;
  return (e: { clientX: number; clientY: number; preventDefault?: () => void }, ids: string[], index: number, filename?: string) => {
    const id = ids[index];
    const revert = async () => {
      if (!(await ask("Revert to the original?", "The look and sliders of this picture are removed. The file itself was never changed.", "Revert"))) return;
      const before = await api.photoLooks([id]);
      await api.applyLook([id], null, 1, NO_ADJUSTMENTS);
      s.bump();
      toast("Reverted to the original", {
        action: { label: "Undo", run: () => void Promise.all(before.map((l) => api.applyLook([l.photoId], l.lookId, l.strength, l.adjustments))).then(() => s.bump()) },
        ms: UNDO_MS,
      });
    };
    const paste = async () => {
      const look = copiedLook;
      if (!look) return;
      const before = await api.photoLooks([id]);
      await api.applyLook([id], look.lookId, look.strength, look.adjustments);
      s.bump();
      toast("Look pasted", { action: { label: "Undo", run: () => void Promise.all(before.map((l) => api.applyLook([l.photoId], l.lookId, l.strength, l.adjustments))).then(() => s.bump()) }, ms: UNDO_MS });
    };
    open(e, {
      header: filename ?? "Edit",
      items: [
        { label: "Open in editor", disabled: WEB ? MAC_ONLY : undefined, run: () => s.editIds(ids, index) },
        {
          label: "Show original",
          disabled: WEB ? MAC_ONLY : undefined,
          run: () => {
            try { sessionStorage.setItem("cba.editor.compare", "original"); } catch { /* fine */ }
            s.editIds([id]);
          },
        },
        "sep",
        { label: "Copy look", disabled: WEB ? MAC_ONLY : undefined, run: async () => { copiedLook = (await api.photoLooks([id]))[0] ?? null; toast(copiedLook ? "Look copied" : "No look to copy"); } },
        { label: "Paste look", disabled: WEB ? MAC_ONLY : copiedLook ? undefined : "Copy a look first", run: () => void paste() },
        "sep",
        {
          label: "Show in Archive",
          run: async () => {
            const query: Query = { order: "newest" };
            const index2 = (await api.position(query, id).catch(() => null)) ?? 0;
            s.setQuery(query);
            s.go({ name: "detail", id, query, index: index2 });
          },
        },
        {
          label: WEB ? "Open in Drive" : "Reveal in Finder",
          run: async () => {
            try {
              if (WEB) {
                const link = await api.driveLink(id);
                return link ? void window.open(link, "_blank", "noreferrer") : toast("Not on Google Drive yet", { error: true });
              }
              const d = await api.detail(id);
              const p = d.assets.find((a) => a.isPrimary) ?? d.assets[0];
              if (p) await api.reveal(p.path);
            } catch (err) {
              toast(errorText(err), { error: true });
            }
          },
        },
        "sep",
        { label: "Revert to original…", danger: true, disabled: WEB ? MAC_ONLY : undefined, run: () => void revert() },
      ],
    });
  };
}

/** Right-click on a portfolio project. */
export function usePortfolioMenu() {
  const s = useStore();
  const { open } = useMenu();
  const toast = useToast();
  return (e: { clientX: number; clientY: number; preventDefault?: () => void }, p: { slug: string; title: string }) => {
    const url = `https://andyssarchives.com/work/${encodeURIComponent(p.slug)}`;
    open(e, {
      header: p.title,
      items: [
        { label: "Open live page", run: () => void window.open(url, "_blank", "noreferrer") },
        { label: "Copy link", run: () => void copyText(url).then((ok) => toast(ok ? "Link copied" : "Couldn't copy", { error: !ok })) },
        { label: "Edit page", disabled: WEB ? MAC_ONLY : undefined, run: () => s.go({ name: "portfolio", slug: p.slug }) },
        {
          label: "Show its pictures in Archive",
          run: async () => {
            try {
              let ids: string[] = [];
              if (WEB) ids = (await api.siteProjects())?.projects.find((x) => x.slug === p.slug)?.photos ?? [];
              else {
                const doc = JSON.parse((await api.archiveRead()).json) as { projects?: { slug: string; frames?: Record<string, { photo?: string | null }> }[] };
                ids = Object.values(doc.projects?.find((x) => x.slug === p.slug)?.frames ?? {}).flatMap((f) => (f.photo ? [f.photo] : []));
              }
              if (!ids.length) return toast("No library pictures on this page yet");
              s.setSelection(new Set(ids));
              s.setQuery({ order: "newest" });
              s.go({ name: "pictures" });
              toast(`${n(ids.length, "picture")} of « ${p.title} » picked in Archive`);
            } catch (err) {
              toast(errorText(err), { error: true });
            }
          },
        },
      ],
    });
  };
}

/** Right-click on a Today tile or row. */
export function useTodayMenu() {
  const { open } = useMenu();
  return (e: { clientX: number; clientY: number; preventDefault?: () => void }, label: string, run: () => void) =>
    open(e, { header: label, items: [{ label: "Open", run }, { label: "Open in new window", disabled: WEB ? "Use a new browser tab" : "Coming next" }] });
}
