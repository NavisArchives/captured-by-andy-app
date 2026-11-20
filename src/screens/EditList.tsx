// Edit (Amendment 3, 19 Nov): every edit ever made, newest first, and
// « Edit new… ». The list is the library's photo_looks table (one row per
// edited photo, ordered by its last change), the same list the editor's
// « Your edits » uses. Nothing is invented: no edits, no tiles. Online the
// list comes from the Mac's last sync (studio_rows meta/edits): you can see
// every edit and open the picture; editing itself stays on the Mac.
import { useEffect, useState } from "react";
import { api } from "../api";
import { Thumb } from "../components/Thumb";
import { useEditMenu } from "../components/menus";
import { WEB } from "../platform";
import { useStore } from "../store";
import type { PhotoRow } from "../types";

const PAGE = 120;

export function EditList() {
  const { go, editIds, selection, version } = useStore();
  const [ids, setIds] = useState<string[] | null>(null);
  const [rows, setRows] = useState<Map<string, PhotoRow>>(new Map());
  const [shown, setShown] = useState(PAGE);
  const editMenu = useEditMenu();

  useEffect(() => {
    let live = true;
    api.editedIds()
      .then(async (list) => {
        if (!live) return;
        setIds(list);
        const r = await api.rows(list.slice(0, PAGE)).catch(() => [] as PhotoRow[]);
        if (live) setRows(new Map(r.map((x) => [x.id, x])));
      })
      .catch(() => live && setIds([]));
    return () => { live = false; };
  }, [version]);

  const more = async () => {
    if (!ids) return;
    const next = ids.slice(shown, shown + PAGE);
    const r = await api.rows(next).catch(() => [] as PhotoRow[]);
    setRows((m) => new Map([...m, ...r.map((x) => [x.id, x] as const)]));
    setShown((n) => n + PAGE);
  };

  const editNew = () => (!WEB && selection.size ? editIds([...selection]) : go({ name: "pictures" }));
  const open = (i: number) => (WEB ? go({ name: "detail", id: ids![i], query: { order: "newest" }, index: 0 }) : editIds(ids!, i));

  return (
    <div className="screen scroll edit-list">
      <div className="el-head">
        <div>
          <h1>Edit</h1>
          <p className="meta">{ids == null ? "Reading your edits…" : ids.length ? `${ids.length.toLocaleString()} edited, the latest first${WEB ? " · photos and videos · edited on the Mac, shown here without the look" : " · photos and videos"}` : "Nothing edited yet."}</p>
        </div>
        {WEB ? (
          <span className="meta el-mac">Editing is in the Mac app</span>
        ) : (
          <button type="button" className="btn primary" onClick={editNew}>
            {selection.size ? `Edit ${selection.size.toLocaleString()} picked…` : "Edit new…"}
          </button>
        )}
      </div>
      {ids && ids.length === 0 && (
        <div className="empty">
          <h3>No edits yet</h3>
          <p>{WEB ? "Edits are made in the Mac app. Once the Mac has synced, every edit shows here, the latest first." : "Pick pictures in Archive and press Edit. Each picture you edit shows here, the latest first."}</p>
        </div>
      )}
      {ids && ids.length > 0 && (
        <div className="el-grid">
          {ids.slice(0, shown).map((id, i) => {
            const r = rows.get(id);
            return (
              <button key={id} type="button" className="el-tile" onClick={() => open(i)} onContextMenu={(e) => editMenu(e, ids, i, r?.filename)} title={r?.filename}>
                <Thumb id={id} hash={r?.thumbhash} ready={r ? r.thumb === "ready" : true} />
                <span>{r?.filename ?? " "}</span>
              </button>
            );
          })}
        </div>
      )}
      {ids && ids.length > shown && (
        <button type="button" className="btn quiet el-more" onClick={() => void more()}>Show more</button>
      )}
    </div>
  );
}
