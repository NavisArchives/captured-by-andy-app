// Create, rename or delete an album. Deleting only removes the album: its
// photos stay in the library and on disk.
import { useState } from "react";
import { api, errorText } from "../api";
import { useStore } from "../store";
import type { Album } from "../types";
import { Modal, useToast } from "./ui";

export function AlbumModal({ album, photoIds, onClose, onDone }: { album: Album | "new"; photoIds?: string[]; onClose: () => void; onDone?: (album: Album | null) => void }) {
  const { reloadMeta, bump } = useStore();
  const toast = useToast();
  const [name, setName] = useState(album === "new" ? "" : album.name);
  const [description, setDescription] = useState(album === "new" ? "" : album.description);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async () => {
    try {
      const saved = album === "new" ? await api.createAlbum(name, photoIds) : await api.updateAlbum(album.id, { name, description });
      reloadMeta();
      bump();
      onDone?.(saved);
      onClose();
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const remove = async () => {
    if (album === "new") return;
    await api.deleteAlbum(album.id);
    toast(`Album ${album.name} deleted. Its photos are still in your library.`);
    reloadMeta();
    bump();
    onDone?.(null);
    onClose();
  };

  return (
    <Modal
      title={album === "new" ? "New album" : "Edit album"}
      onClose={onClose}
      foot={
        <>
          {album !== "new" &&
            (confirmDelete ? (
              <button type="button" className="btn danger" onClick={remove}>Yes, delete the album</button>
            ) : (
              <button type="button" className="btn danger" onClick={() => setConfirmDelete(true)}>Delete…</button>
            ))}
          <span className="spacer" />
          <button type="button" className="btn quiet" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!name.trim()} onClick={save}>{album === "new" ? "Create" : "Save"}</button>
        </>
      }
    >
      <label style={{ display: "grid", gap: 6, marginBottom: 12 }}>
        <span className="eyebrow" style={{ margin: 0 }}>Name</span>
        <input className="box" autoFocus value={name} placeholder="Brussels Nights…" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && save()} />
      </label>
      {album !== "new" && (
        <label style={{ display: "grid", gap: 6 }}>
          <span className="eyebrow" style={{ margin: 0 }}>Description</span>
          <textarea className="box" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      )}
      {photoIds && photoIds.length > 0 && album === "new" && <p className="hint" style={{ marginTop: 12 }}>The {photoIds.length.toLocaleString()} picked photos go in straight away.</p>}
      {confirmDelete && <p className="warnline" style={{ marginTop: 12 }}>Only the album goes. Every photo stays in your library and on disk.</p>}
    </Modal>
  );
}
