import { useState } from "react";
import { AlbumModal } from "../components/AlbumModal";
import { QuickAddSetup } from "../components/QuickAddSetup";
import { Thumb } from "../components/Thumb";
import { Hero, Icon } from "../components/ui";
import { useMenu } from "../components/ContextMenu";
import { useAlbumMenu } from "../components/menus";
import { SectionMore, useRecentlyDeleted } from "../components/RecentlyDeleted";
import { ago, plural } from "../lib/format";
import { useStore } from "../store";
import type { Album } from "../types";

const ALBUM_KIND: ["album"] = ["album"];

export function Albums() {
  const { albums, go, setQuery, setSelection } = useStore();
  const [editing, setEditing] = useState<Album | "new" | null>(null);
  const [quickAddFor, setQuickAddFor] = useState<Album | null>(null);
  const albumMenu = useAlbumMenu((a) => setEditing(a));
  const { open: openMenu } = useMenu();
  const recently = useRecentlyDeleted(ALBUM_KIND, "Albums");

  const openAlbum = (a: Album) => {
    setQuery({ order: "newest", album: a.id });
    setSelection(new Set());
    go({ name: "pictures" });
  };

  return (
    <div
      className="screen scroll"
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest("article")) return;
        openMenu(e, { header: "Albums", items: [{ label: "New album", run: () => setEditing("new") }, ...recently.menu] });
      }}
    >
      <Hero title="Your" italic="albums" sub={`${plural(albums.length, "album")} · a photo can live in many · files never move or copy`}>
        <button type="button" className="btn quiet" onClick={() => go({ name: "pictures" })}>{Icon.back()} Pictures</button>
        <button type="button" className="btn primary" onClick={() => setEditing("new")}>{Icon.plus()} New album</button>
        <SectionMore label="Albums" items={[recently.item]} />
      </Hero>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 16 }}>
        {albums.map((a) => (
          <article key={a.id} className="card" onContextMenu={(e) => albumMenu(e, a)} style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            <button type="button" onClick={() => openAlbum(a)} style={{ border: 0, padding: 0, background: "none", aspectRatio: "4 / 3", borderRadius: 12, overflow: "hidden" }} aria-label={`Open ${a.name}`}>
              <Thumb id={a.coverPhotoId} hash={a.coverThumbhash} />
            </button>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "0 4px", gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 15.5, fontWeight: 600, letterSpacing: "-0.015em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</h3>
              <span className="meta">{a.photoCount.toLocaleString()}</span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, padding: "0 4px 2px" }}>
              <span className="meta" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>updated {ago(a.updatedMs)}</span>
              <button type="button" className="link" onClick={() => setQuickAddFor(a)} title="Go through photos one by one: Y adds, N skips">Quick add</button>
              <button type="button" className="link" onClick={() => setEditing(a)}>Edit</button>
            </div>
          </article>
        ))}
        <button type="button" className="card dashed" onClick={() => setEditing("new")} style={{ minHeight: 230, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--muted)", fontSize: 14 }}>
          {Icon.plus()} New album
        </button>
      </div>
      {editing && <AlbumModal album={editing} onClose={() => setEditing(null)} />}
      {quickAddFor && <QuickAddSetup album={quickAddFor} onClose={() => setQuickAddFor(null)} />}
    </div>
  );
}
