// Popovers that act on a set of photos: add to album, tag, add to post, move to a trip,
// add to a website project.
import { useEffect, useMemo, useState } from "react";
import { api, errorText } from "../api";
import { addPhotos, replaceProject, type ArchiveDoc, type ArchiveProject } from "../lib/archive";
import { formatDay, plural, STATUS_LABEL } from "../lib/format";
import { useStore } from "../store";
import type { Folder, Post } from "../types";
import { Icon, Popover, useToast } from "./ui";

interface Props {
  anchor: HTMLElement | null;
  ids: string[];
  onClose: () => void;
  up?: boolean;
}

export function AlbumPopover({ anchor, ids, onClose, up }: Props) {
  const { albums, bump, setQuery, setSelection, go } = useStore();
  const toast = useToast();
  const [name, setName] = useState("");
  const typed = name.trim().toLowerCase();
  const shown = albums.filter((a) => a.name.toLowerCase().includes(typed));
  const exact = albums.find((a) => a.name.toLowerCase() === typed);
  const openAlbum = (id: string) => ({
    label: "Open",
    run: () => {
      setQuery({ order: "newest", album: id });
      setSelection(new Set());
      go({ name: "pictures" });
    },
  });
  const add = async (id: string, label: string) => {
    try {
      const n = await api.albumAdd(id, ids);
      toast(`${n.toLocaleString()} added to ${label}`, { action: openAlbum(id) });
      bump();
      onClose();
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const create = async () => {
    if (!name.trim()) return;
    try {
      const a = await api.createAlbum(name.trim(), ids);
      toast(`New album ${a.name} with ${ids.length.toLocaleString()} photos`, { action: openAlbum(a.id) });
      bump();
      onClose();
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  // Enter: the album with exactly that name, else the only match, else a new one.
  // ("Lisbon" with "Lisbon" and "Lisbon 2025" both there adds to "Lisbon".)
  const enter = (meta: boolean) => {
    if (exact) return add(exact.id, exact.name);
    if (shown.length === 1 && !meta) return add(shown[0].id, shown[0].name);
    return create();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} up={up}>
      <input
        className="search"
        autoFocus
        placeholder="Album name…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void enter(e.metaKey)}
        style={{ width: "100%", marginBottom: 6 }}
      />
      {shown.map((a) => (
        <button key={a.id} type="button" className="opt" onClick={() => add(a.id, a.name)}>
          {a.name}
          <small>{a.photoCount.toLocaleString()}</small>
        </button>
      ))}
      {name.trim() && !albums.some((a) => a.name.toLowerCase() === name.trim().toLowerCase()) && (
        <button type="button" className="opt" onClick={create}>
          {Icon.plus(12)} New album “{name.trim()}”
        </button>
      )}
      {!albums.length && !name && <p className="meta" style={{ padding: "6px 9px", margin: 0 }}>Type a name to make your first album.</p>}
    </Popover>
  );
}

export function TagPopover({ anchor, ids, onClose, up }: Props) {
  const { tags, bump } = useStore();
  const toast = useToast();
  const [text, setText] = useState("");
  const names = text.split(",").map((t) => t.trim()).filter(Boolean);
  const last = names[names.length - 1]?.toLowerCase() ?? "";
  const suggest = tags.filter((t) => !last || t.name.toLowerCase().includes(last)).slice(0, 8);
  const apply = async (list: string[]) => {
    if (!list.length) return;
    try {
      await api.tagPhotos(list, ids);
      toast(`Tagged ${ids.length.toLocaleString()} with ${list.join(", ")}`);
      bump();
      onClose();
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  return (
    <Popover anchor={anchor} onClose={onClose} up={up}>
      <input
        className="search"
        autoFocus
        placeholder="Tags, separated by commas…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && apply(names)}
        style={{ width: "100%", marginBottom: 6 }}
      />
      {suggest.map((t) => (
        <button key={t.id} type="button" className="opt" onClick={() => apply([...names.slice(0, -1), t.name])}>
          # {t.name}
          <small>{t.usage.toLocaleString()}</small>
        </button>
      ))}
      <p className="meta" style={{ padding: "6px 9px", margin: 0 }}>Enter adds every tag typed.</p>
    </Popover>
  );
}

export function PostPopover({ anchor, ids, onClose, up }: Props) {
  const { go, bump, accounts, albums, query } = useStore();
  const toast = useToast();
  const [all, setAll] = useState<Post[]>([]);
  useEffect(() => {
    api.listPosts().then(setAll).catch(() => {});
  }, []);
  // Everything not yet out; adding to a scheduled post keeps it scheduled.
  const posts = all.filter((x) => ["idea", "building", "ready", "scheduled"].includes(x.status));
  const account = useMemo(() => accounts[0]?.id, [accounts]);
  const open = (id: string) => ({ label: "Open", run: () => go({ name: "post", id }) });
  const add = async (p: Post) => {
    try {
      const n = await api.postAddPhotos(p.id, ids);
      toast(`${n} added to ${p.title}`, { action: open(p.id) });
      bump();
      onClose();
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  // Named after the album you're in and the day of the photo, so posts made
  // in a row can be told apart.
  const albumName = query.album ? albums.find((a) => a.id === query.album)?.name : null;
  const uniqueTitle = (capturedAt: string | null | undefined, taken: Set<string>) => {
    const base = [albumName, capturedAt ? formatDay(capturedAt) : ""].filter(Boolean).join(" · ") || "New post";
    let title = base;
    for (let n = 2; taken.has(title); n++) title = `${base} (${n})`;
    taken.add(title);
    return title;
  };
  const titleFor = async () => {
    const [first] = await api.rows([ids[0]]).catch(() => []);
    return uniqueTitle(first?.capturedAt, new Set(all.map((p) => p.title)));
  };
  // One post per photo, each with its own title; Undo deletes them again.
  const createSeparate = async () => {
    const made: string[] = [];
    try {
      const rows = await api.rows(ids).catch(() => []);
      const taken = new Set(all.map((p) => p.title));
      for (const id of ids) {
        const title = uniqueTitle(rows.find((r) => r.id === id)?.capturedAt, taken);
        made.push((await api.createPost({ title, accountId: account }, [id])).id);
      }
      bump();
      onClose();
      toast(`${made.length} new posts, one photo each`, {
        action: { label: "Undo", run: () => void Promise.all(made.map((id) => api.deletePost(id, "undo"))).then(bump).catch((e) => toast(errorText(e), { error: true })) },
      });
    } catch (e) {
      if (made.length) bump();
      toast(errorText(e), { error: true });
    }
  };
  // Stays where you are: the toast opens the post when you want it.
  const create = async () => {
    try {
      const title = await titleFor();
      const p = await api.createPost({ title, accountId: account }, ids.slice(0, 20));
      bump();
      onClose();
      const n = Math.min(ids.length, 20);
      toast(`New post “${title}” · ${n} ${n === 1 ? "photo" : "photos"}${ids.length > 20 ? " (a carousel holds 20)" : ""}`, { action: open(p.id) });
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  return (
    <Popover anchor={anchor} onClose={onClose} up={up}>
      {ids.length === 1 ? (
        <button type="button" className="opt" onClick={create}>
          {Icon.plus(12)} New post with this photo
        </button>
      ) : (
        <>
          <button type="button" className="opt" onClick={create}>
            {Icon.plus(12)} One carousel post with these {Math.min(ids.length, 20)}
            <small>{ids.length > 20 ? "The first 20: a carousel holds 20" : "One post you swipe through"}</small>
          </button>
          <button type="button" className="opt" onClick={() => void createSeparate()}>
            {Icon.plus(12)} {ids.length} separate posts
            <small>One photo each</small>
          </button>
        </>
      )}
      {posts.length > 0 && <p className="meta" style={{ padding: "6px 9px 2px", margin: 0 }}>Or add {ids.length === 1 ? "it" : "them"} to a planned post:</p>}
      {posts.map((p) => (
        <button key={p.id} type="button" className="opt" onClick={() => add(p)}>
          {p.title}
          <small>
            {STATUS_LABEL[p.status]} · {p.photoCount}/20{p.accountUsername ? ` · @${p.accountUsername}` : ""}{p.scheduledAt ? ` · ${formatDay(p.scheduledAt)}` : ""}
          </small>
        </button>
      ))}
    </Popover>
  );
}

/** Moves photos to a trip (their files go into that trip's folder) and offers
 *  Undo. Resolves true when anything moved. */
export function useMoveToTrip() {
  const { bump, setSelection } = useStore();
  const toast = useToast();
  return async (ids: string[], trip: string) => {
    const name = trip.split("/").pop() ?? trip;
    try {
      const r = await api.moveToTrip(ids, trip);
      if (r.failed.length) {
        toast(`${plural(r.failed.length, "photo")} couldn't move: ${r.failed[0]}`, { error: true });
      } else if (!r.moved) {
        toast(`Already in ${name}`);
      }
      if (r.moved) {
        toast(`Moved ${plural(r.moved, "photo")} to ${name}`, {
          action: {
            label: "Undo",
            run: async () => {
              try {
                await api.undoTripMove(r.undo);
                toast(`Moved back from ${name}`);
              } catch (e) {
                toast(errorText(e), { error: true });
              }
              bump();
            },
          },
        });
        setSelection(new Set());
      }
      bump();
      return r.moved > 0;
    } catch (e) {
      toast(errorText(e), { error: true });
      return false;
    }
  };
}

/** Pick the trip to move photos to, or name a new one. `root` is the source
 *  folder a new trip goes in. */
export function TripPopover({ anchor, ids, onClose, up, trips, root }: Props & { trips: Folder[]; root: string | null }) {
  const move = useMoveToTrip();
  const [name, setName] = useState("");
  const typed = name.trim().toUpperCase();
  const shown = trips.filter((t) => t.name.toUpperCase().includes(typed));
  const exact = trips.find((t) => t.name.toUpperCase() === typed && (!root || t.path === `${root}/${t.name}`));
  const go = async (path: string) => {
    onClose();
    await move(ids, path);
  };
  const create = () => {
    if (!typed || !root || typed.includes("/") || typed.startsWith(".")) return;
    void go(`${root}/${typed}`);
  };
  const enter = () => {
    if (exact) return void go(exact.path);
    if (shown.length === 1) return void go(shown[0].path);
    create();
  };
  const sources = new Set(trips.map((t) => t.source));
  return (
    <Popover anchor={anchor} onClose={onClose} up={up}>
      <input
        className="search"
        autoFocus
        placeholder="Move to trip…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && enter()}
        style={{ width: "100%", marginBottom: 6 }}
      />
      <div style={{ maxHeight: 320, overflowY: "auto" }}>
        {shown.map((t) => (
          <button key={t.path} type="button" className="opt" onClick={() => void go(t.path)} title={t.path}>
            {t.name}
            <small>{sources.size > 1 ? `${t.source} · ` : ""}{t.count.toLocaleString()}</small>
          </button>
        ))}
      </div>
      {typed && root && !exact && (
        <button type="button" className="opt" onClick={create}>
          {Icon.plus(12)} New trip “{typed}”
        </button>
      )}
      <p className="meta" style={{ padding: "6px 9px", margin: 0 }}>
        Moves original files into the trip folder. In a Drive folder, those moves also sync to Drive. Selects, edits and albums stay.
      </p>
    </Popover>
  );
}

/** Adds photos to a website project (Archive). A project that follows an album gets
 *  them through its album, so the two never disagree. */
export function ProjectPopover({ anchor, ids, onClose, up }: Props) {
  const { go, bump, albums } = useStore();
  const toast = useToast();
  const [doc, setDoc] = useState<{ projects: ArchiveProject[]; version: string; raw: ArchiveDoc } | null>(null);
  useEffect(() => {
    api
      .archiveRead()
      .then((r) => {
        const raw = JSON.parse(r.json) as ArchiveDoc;
        setDoc({ projects: raw.projects, version: r.version, raw });
      })
      .catch((e) => toast(errorText(e), { error: true }));
  }, [toast]);
  const add = async (p: ArchiveProject) => {
    if (!doc) return;
    try {
      if (p.album) {
        await api.albumAdd(p.album, ids);
        bump();
      } else {
        await api.archiveWrite(JSON.stringify(replaceProject(doc.raw, p.slug, addPhotos(p, ids)), null, 1), doc.version);
      }
      toast(`${plural(ids.length, "photo")} added to ${p.title}`, { action: { label: "Open", run: () => go({ name: "portfolio", slug: p.slug }) } });
      onClose();
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  return (
    <Popover anchor={anchor} onClose={onClose} up={up}>
      {!doc && <p className="meta" style={{ padding: "6px 9px", margin: 0 }}>Reading the website's projects…</p>}
      {doc?.projects.map((p) => (
        <button key={p.slug} type="button" className="opt" onClick={() => void add(p)}>
          {p.title}
          <small>{[p.proposal ? "Proposal" : p.notebook ? "Notebook" : "Work", p.album ? `through the album ${albums.find((a) => a.id === p.album)?.name ?? ""}` : ""].filter(Boolean).join(" · ")}</small>
        </button>
      ))}
    </Popover>
  );
}

/** Rename the picked photos "<name> 01", "<name> 02"… in shooting order. */
export function RenamePopover({ anchor, ids, onClose, up }: Props) {
  const { bump, setSelection } = useStore();
  const toast = useToast();
  const [name, setName] = useState("");
  const go = async () => {
    const n = name.trim();
    if (!n) return;
    onClose();
    try {
      const r = await api.renamePhotos(ids, n);
      if (r.failed.length) toast(`${plural(r.failed.length, "photo")} couldn't be renamed: ${r.failed[0]}`, { error: true });
      if (r.moved)
        toast(`Renamed ${plural(r.moved, "photo")} “${n} 01”…`, {
          action: {
            label: "Undo",
            run: async () => {
              await api.undoTripMove(r.undo).catch((e) => toast(errorText(e), { error: true }));
              bump();
            },
          },
        });
      setSelection(new Set());
      bump();
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  return (
    <Popover anchor={anchor} onClose={onClose} up={up}>
      <input className="search" autoFocus placeholder="New name, e.g. Studio Arno" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void go()} style={{ width: "100%", marginBottom: 6 }} />
      <button type="button" className="opt" disabled={!name.trim()} onClick={() => void go()}>
        Rename {plural(ids.length, "photo")} “{name.trim() || "…"} 01”, “… 02”…
      </button>
      <p className="meta" style={{ padding: "6px 9px", margin: 0 }}>Renames original files in their current folders, in shooting order. Drive synchronizes those names when applicable. Edits, selects and albums stay.</p>
    </Popover>
  );
}
