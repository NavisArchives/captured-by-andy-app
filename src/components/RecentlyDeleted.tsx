// Recently deleted (NIRMATA, 19 Nov, after 8 posts went missing): posts,
// albums, ideas and projects stay here 30 days after a delete. Restore puts
// one back as it was, with its pictures; « Delete for good » asks first.
// Opened from the ⋯ button and the right-click menu of Socials, Albums and Projects.
import { useCallback, useEffect, useState } from "react";
import { api, errorText, type TrashItem, type TrashKind } from "../api";
import { ago } from "../lib/format";
import { WEB } from "../platform";
import { useStore } from "../store";
import { useMenu, type MenuItem } from "./ContextMenu";
import { useAsk } from "./menus";
import { Icon, Modal, useToast } from "./ui";

const NAME: Record<TrashKind, string> = { post: "post", album: "album", idea: "idea", project: "project" };
const LINKED: Record<TrashKind, [string, string]> = { post: ["picture", "pictures"], album: ["picture", "pictures"], idea: ["save", "saves"], project: ["clip", "clips"] };

/** The ⋯ menu items of a section: « Recently deleted », and what else the section passes. */
export function useRecentlyDeleted(kinds: TrashKind[], title: string) {
  const { popover } = useMenu();
  const show = useCallback(() => popover((_, close) => <RecentlyDeletedModal kinds={kinds} title={title} onClose={close} />), [popover, kinds, title]);
  const item: MenuItem = { label: "Recently deleted…", run: show };
  // Only the Mac keeps deleted items: nothing to show on the web.
  const menu: MenuItem[] = WEB ? [] : ["sep", item];
  return { show, item, menu };
}

/** The ⋯ button for a section header. */
export function SectionMore({ items, label }: { items: MenuItem[]; label: string }) {
  const { open } = useMenu();
  if (WEB) return null;
  return (
    <button type="button" className="btn quiet icon" aria-label={`More for ${label}`} title="More" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); open({ clientX: r.left, clientY: r.bottom + 4, preventDefault: () => {} }, { header: label, items }); }}>
      {Icon.more()}
    </button>
  );
}

function RecentlyDeletedModal({ kinds, title, onClose }: { kinds: TrashKind[]; title: string; onClose: () => void }) {
  const toast = useToast();
  const ask = useAsk();
  const { bump, reloadMeta } = useStore();
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const load = useCallback(() => {
    Promise.all(kinds.map((k) => api.trashList(k)))
      .then((lists) => setItems(lists.flat().sort((a, b) => b.deletedMs - a.deletedMs)))
      .catch((e) => { setItems([]); toast(errorText(e), { error: true }); });
  }, [kinds, toast]);
  useEffect(load, [load]);

  const restore = async (it: TrashItem) => {
    setBusy(it.id);
    try {
      await api.trashRestore(it.id);
      bump();
      reloadMeta();
      toast(`« ${it.title || NAME[it.kind]} » is back`);
      load();
    } catch (e) {
      toast(errorText(e), { error: true });
    } finally {
      setBusy(null);
    }
  };
  const purge = async (it: TrashItem) => {
    if (!(await ask(`Delete « ${it.title || NAME[it.kind]} » for good?`, "It can't be restored after this. Its pictures stay in your library.", "Delete for good"))) return;
    try {
      await api.trashPurge(it.id);
      load();
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };

  return (
    <Modal title={`Recently deleted · ${title}`} onClose={onClose} wide foot={<button type="button" className="btn quiet" autoFocus onClick={onClose}>Close</button>}>
      <p className="meta" style={{ margin: "0 0 12px" }}>Kept 30 days after a delete, then removed. Restore brings it back as it was, with its pictures.</p>
      {items === null ? (
        <p className="meta">Reading…</p>
      ) : items.length === 0 ? (
        <p className="meta">Nothing deleted in the last 30 days.</p>
      ) : (
        <ul className="rd-list">
          {items.map((it) => {
            const left = Math.max(0, 30 - Math.floor((Date.now() - it.deletedMs) / 86_400_000));
            const [one, many] = LINKED[it.kind];
            return (
              <li key={it.id} className="rd-row">
                <div className="rd-what">
                  <strong>{it.title || `Untitled ${NAME[it.kind]}`}</strong>
                  <span className="meta">
                    {kinds.length > 1 ? `${NAME[it.kind]} · ` : ""}
                    {it.linked} {it.linked === 1 ? one : many} · deleted {ago(it.deletedMs)} · from {it.source} · {left} {left === 1 ? "day" : "days"} left
                  </span>
                </div>
                <button type="button" className="btn quiet small" disabled={busy === it.id} onClick={() => void restore(it)}>{busy === it.id ? "Restoring…" : "Restore"}</button>
                <button type="button" className="btn quiet small danger-text" onClick={() => void purge(it)}>Delete for good…</button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

/** Undo of a delete: brings that exact item back from Recently deleted (same id, same pictures). */
export async function restoreDeleted(kind: TrashKind, itemId: string): Promise<void> {
  const it = (await api.trashList(kind)).find((x) => x.itemId === itemId);
  if (!it) throw new Error("It is no longer in Recently deleted");
  await api.trashRestore(it.id, "undo");
}
