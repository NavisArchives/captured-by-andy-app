// "Add item…": photos or videos from anywhere (a download, an AirDrop) copied
// into a library folder, optionally into an album and a website project, then
// straight into the editor. The files they came from stay where they are.
import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { addPhotos, replaceProject, type ArchiveDoc } from "../lib/archive";
import { plural } from "../lib/format";
import { useStore } from "../store";
import type { Folder } from "../types";
import { Modal, Select, useToast } from "./ui";

export function AddItemSheet({ files, folders, start, onClose }: { files: string[]; folders: Folder[]; start: string | null; onClose: () => void }) {
  const toast = useToast();
  const { albums, bump, editIds } = useStore();
  // Where it goes: the trip open now, else the first trip. IPHONE folders are the phone's.
  const places = folders.filter((f) => f.name.toUpperCase() !== "IPHONE");
  const [folder, setFolder] = useState(() => places.find((f) => f.path === start)?.path ?? places[0]?.path ?? "");
  const [newFolder, setNewFolder] = useState("");
  const [album, setAlbum] = useState("");
  const [project, setProject] = useState("");
  const [doc, setDoc] = useState<{ raw: ArchiveDoc; version: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .archiveRead()
      .then((r) => setDoc({ raw: JSON.parse(r.json) as ArchiveDoc, version: r.version }))
      .catch(() => setDoc(null));
  }, []);
  const names = files.map((f) => f.split("/").pop() ?? f);

  const add = async () => {
    setBusy(true);
    try {
      const ids = await api.addItems(files, folder, newFolder.trim() || null);
      if (album) await api.albumAdd(album, ids);
      const p = doc?.raw.projects.find((x) => x.slug === project);
      if (p && doc) {
        // A project that follows an album takes them through the album.
        if (p.album) await api.albumAdd(p.album, ids);
        else await api.archiveWrite(JSON.stringify(replaceProject(doc.raw, p.slug, addPhotos(p, ids)), null, 1), doc.version);
      }
      bump();
      onClose();
      const where = [newFolder.trim() || folders.find((f) => f.path === folder)?.name, albums.find((a) => a.id === album)?.name, p?.title].filter(Boolean).join(" · ");
      toast(`${plural(ids.length, "item")} added${where ? ` to ${where}` : ""}`);
      if (ids.length) editIds(ids, 0);
    } catch (e) {
      toast(errorText(e), { error: true });
      setBusy(false);
    }
  };

  return (
    <Modal
      title={files.length === 1 ? `Add ${names[0]}` : `Add ${files.length} items`}
      onClose={busy ? () => {} : onClose}
      foot={
        <>
          <span className="meta" style={{ flex: 1 }}>A copy goes into the folder; the file you picked stays where it is.</span>
          <button type="button" className="btn quiet" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" disabled={!folder || busy} onClick={() => void add()}>
            {busy ? "Adding…" : "Add and edit"}
          </button>
        </>
      }
    >
      {files.length > 1 && <p className="meta" style={{ margin: "0 0 12px" }}>{names.slice(0, 4).join(", ")}{files.length > 4 ? ` and ${files.length - 4} more` : ""}</p>}
      <div className="st-col">
        <div className="st-two">
          <label className="st-field">
            <span>Folder</span>
            <Select value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Folder">
              {places.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.depth === 2 ? `${f.path.split("/").slice(-2, -1)[0]} › ${f.name}` : f.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="st-field">
            <span>In a new folder there (optional)</span>
            <input value={newFolder} placeholder="e.g. STUDIO ARNO" onChange={(e) => setNewFolder(e.target.value.toUpperCase())} />
          </label>
        </div>
        <div className="st-two">
          <label className="st-field">
            <span>Album (optional)</span>
            <Select value={album} onChange={(e) => setAlbum(e.target.value)} aria-label="Album">
              <option value="">None</option>
              {albums.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </Select>
          </label>
          <label className="st-field">
            <span>Website project (optional)</span>
            <Select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Website project" disabled={!doc}>
              <option value="">None</option>
              {(doc?.raw.projects ?? []).map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.title}
                  {p.proposal ? " · proposal" : p.notebook ? " · notebook" : ""}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </div>
    </Modal>
  );
}
