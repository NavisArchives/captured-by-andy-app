import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "../api";
import { Hero, Icon, Switch, useToast, Select } from "../components/ui";
import { ACTION_LABELS, DEFAULT_KEYMAP, keyLabel, repairKeymap, unbindable, type Action, type Keymap } from "../keymap";
import { ago, bytes, plural, whenLabel } from "../lib/format";
import { useStore } from "../store";
import type { BackupInfo, LibraryInfo, Location, LookFolder, OfflineInfo, PreviewSpace } from "../types";
import { StudioSettings } from "../studio/StudioSettings";
import { ReviewCopies } from "../components/ReviewCopies";
import { DriveConnection } from "../components/DriveConnection";
import { HistoryCard } from "../components/HistoryCard";

/** ~/Pictures/PhotoResources instead of the full home path. */
function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

function useSetting(key: string, fallback: string) {
  const [value, setValue] = useState<string>(fallback);
  useEffect(() => {
    api.getSetting(key).then((v) => v != null && setValue(v.replace(/^"|"$/g, ""))).catch(() => {});
  }, [key]);
  const save = useCallback(async (v: string) => {
    setValue(v);
    await api.setSetting(key, v);
  }, [key]);
  return [value, save] as const;
}

export function Settings() {
  const { sources, scan, keymap, setKeymap, addFolder, looks, reloadLooks, bump, selection, tags, reloadMeta } = useStore();
  const toast = useToast();
  const [info, setInfo] = useState<LibraryInfo | null>(null);
  const [offline, setOffline] = useState<OfflineInfo | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [greenTag, setGreenTag] = useSetting("finder.greenTag", "true");
  const [autoLook, setAutoLook] = useSetting("looks.autoLook", "");
  const [autoTone, setAutoTone] = useSetting("looks.autoTone", "false");
  const [autoStrength, setAutoStrength] = useSetting("looks.autoStrength", "0.8");
  const [recording, setRecording] = useState<Action | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [showAllBackups, setShowAllBackups] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [space, setSpace] = useState<PreviewSpace | null>(null);
  const [clearing, setClearing] = useState(false);
  const [lookFolders, setLookFolders] = useState<LookFolder[]>([]);
  const [removingLooks, setRemovingLooks] = useState<string | null>(null);
  const [renamingTag, setRenamingTag] = useState<{ id: string; name: string } | null>(null);
  const [deletingTag, setDeletingTag] = useState<string | null>(null);
  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(null));
  }, []);

  const loadAll = useCallback(() => {
    api.libraryInfo().then(setInfo).catch(() => {});
    api.offlineInfo().then(setOffline).catch(() => {});
    api.listLocations().then(setLocations).catch(() => {});
    api.listBackups().then(setBackups).catch(() => {});
    api.previewSpace().then(setSpace).catch(() => {});
    api.lookFolders().then(setLookFolders).catch(() => {});
  }, []);
  useEffect(loadAll, [loadAll]);

  const run = async (what: () => Promise<unknown>, done?: string) => {
    try {
      await what();
      if (done) toast(done);
      loadAll();
      bump();
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };

  // Record a new key for an action.
  useEffect(() => {
    if (!recording) return;
    const onKey = async (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRecording(null);
      if (unbindable(e)) return; // keep listening for a real key
      const raw = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const reserved = ["e", "b", "y", "/", "?", "[", "]", "z", "c", "p", "f", "v", "q", ",", ".", "ArrowUp", "ArrowDown", ...(recording === "focus" ? [] : [" "])];
      if (reserved.includes(raw) || /^[0-9]$/.test(raw) || /^Digit/.test(e.code) && e.shiftKey) {
        toast(`${keyLabel(raw)} is already used by another shortcut: pick another key`, { error: true });
        return;
      }
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const next: Keymap = { ...keymap };
      for (const a of Object.keys(next) as Action[]) next[a] = next[a].filter((k) => k !== key);
      next[recording] = [key];
      // An action that just lost its only key gets a free default key back;
      // if none is free, the change is refused, so no action is unreachable.
      const lost = (Object.keys(next) as Action[]).find((a) => !next[a].length);
      const repaired = repairKeymap(next);
      if (!repaired) {
        toast(`${keyLabel(key)} is the only key for “${lost ? ACTION_LABELS[lost] : "another action"}”: pick another key`, { error: true });
        setRecording(null);
        return;
      }
      Object.assign(next, repaired);
      setKeymap(next);
      await api.setSetting("keymap", JSON.stringify(next));
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, keymap, setKeymap]);

  const setOfflineFlag = (key: string, v: boolean) => run(() => api.setSetting(key, v ? "true" : "false"));
  const collections = [...new Set(looks.map((l) => l.collection))].map((c) => [c, looks.filter((l) => l.collection === c).length] as const);

  const chooseArchive = async () => {
    const path = await open({ directory: true, multiple: false, title: "Choose the archive folder (e.g. on an external drive)" });
    if (typeof path === "string") run(() => api.addLocation(path), "Archive folder added");
  };
  const archiveSelected = async (loc: Location) => {
    setArchiving(true);
    try {
      const ids = selection.size ? [...selection] : await api.photoIds({ review: "selected" }, 0, 200000);
      const r = await api.archivePhotos(loc.id, ids);
      toast(`${r.archived} copied and verified · ${r.already} already there${r.skippedCloud ? ` · ${r.skippedCloud} only online` : ""}${r.failed ? ` · ${r.failed} failed` : ""}`, { error: r.failed > 0 });
      loadAll();
    } catch (e) {
      toast(errorText(e), { error: true });
    } finally {
      setArchiving(false);
    }
  };

  return (
    <div className="screen scroll">
      <Hero title="Library" italic="settings" sub="Everything stays on this Mac · originals are never moved, renamed or changed" />
      <div className="grid-3">
        <ReviewCopies />
        <DriveConnection />
        <StudioSettings />
        <section className="card">
          <p className="eyebrow"><span>Source folders</span><span>{sources.length}</span></p>
          {sources.map((s) => (
            <div key={s.id} className="setrow">
              <div className="t">
                <span className="row-flex" style={{ gap: 8 }}><i className={`dot ${s.online ? "d-ok" : "d-idle"}`} />{s.label}</span>
                <small className="mono">{s.path}</small>
                <small>{plural(s.photoCount, "photo")} · scanned {ago(s.lastScanFinishedMs)}{s.online ? "" : " · not connected"}</small>
                {removing === s.id && (
                  <div className="warnline" style={{ marginTop: 8 }}>
                    Forget this folder? Its photos leave the library (with their albums, tags and post history). The files themselves stay exactly where they are.
                    <div className="row-flex" style={{ marginTop: 8 }}>
                      <button type="button" className="btn small quiet" onClick={() => setRemoving(null)}>Keep</button>
                      <button type="button" className="btn small danger" onClick={() => { setRemoving(null); run(() => api.removeSource(s.id), "Folder forgotten; files untouched"); }}>Forget folder</button>
                    </div>
                  </div>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                <Switch checked={s.enabled} label={`Scan ${s.label}`} onChange={(v) => run(() => api.setSourceEnabled(s.id, v))} />
                <button type="button" className="link" style={{ color: "var(--red)", fontSize: 12 }} onClick={() => setRemoving(s.id)}>Forget…</button>
              </div>
            </div>
          ))}
          <div className="row-flex" style={{ paddingTop: 12, flexWrap: "wrap" }}>
            <button type="button" className="btn primary" onClick={addFolder}>{Icon.folder()} Add folder…</button>
            <button type="button" className="btn quiet" disabled={scan?.running} onClick={() => api.scanAll()}>{scan?.running ? "Scanning…" : "Rescan all"}</button>
            {scan?.running && <button type="button" className="btn quiet" onClick={() => api.cancelScan()}>Stop</button>}
          </div>
          {scan?.error && <p className="error-text">{scan.error}</p>}
        </section>

        <section className="card">
          <p className="eyebrow">Selected photos</p>
          <div className="setrow">
            <div className="t">Green tag in Finder<small>Selected photos (RAW and JPEG) get Finder’s Green tag. Only tags the app added are ever removed; contents and dates never change.</small></div>
            <Switch
              checked={greenTag !== "false"}
              label="Green tag in Finder"
              onChange={(v) => {
                setGreenTag(v ? "true" : "false").then(() =>
                  run(() => (v ? api.finderSyncAll() : api.finderRemoveAdded()), v ? "Tagging selected photos" : "Removed the tags the app added"),
                );
              }}
            />
          </div>
          <div className="setrow">
            <div className="t">Keep selected photos offline<small>Copies each newly selected photo to {offline?.dir ?? "~/Pictures/CapturedByAndy"} · {offline ? `${plural(offline.photos, "photo")}, ${bytes(offline.bytes)}` : ""}</small></div>
            <Switch checked={!!offline?.auto} label="Keep selected offline" onChange={(v) => setOfflineFlag("offline.auto", v)} />
          </div>
          <div className="setrow">
            <div className="t">Include the RAW file<small>Bigger, but lets you re-edit from the RAW later</small></div>
            <Switch checked={!!offline?.includeRaw} label="Include RAW in offline copies" onChange={(v) => setOfflineFlag("offline.includeRaw", v)} />
          </div>
          <div className="setrow">
            <div className="t">Allow full downloads of online photos<small>Needed to keep copies on this Mac or archive photos that only live online (Google Drive, iCloud Drive). Tiles and sharp previews of online photos are made either way: each photo is fetched for a moment and released again.</small></div>
            <Switch checked={!!offline?.allowCloud} label="Allow full downloads of online photos" onChange={(v) => setOfflineFlag("offline.allowCloudDownloads", v)} />
          </div>
          <div className="setrow">
            <div className="t">Offline folder<small className="mono">{offline?.dir}</small></div>
            <button
              type="button"
              className="btn quiet small"
              onClick={async () => {
                const path = await open({ directory: true, multiple: false, title: "Where should offline copies and exports go?" });
                if (typeof path === "string") run(() => api.setSetting("library.localDir", path), "Offline folder changed");
              }}
            >
              Change…
            </button>
          </div>
        </section>

        <section className="card">
          <p className="eyebrow">Automatic edits</p>
          <div className="setrow">
            <div className="t">Auto tone when selected<small>Exposure, contrast, highlights and white balance set from the photo itself. Never overwrites an edit you made.</small></div>
            <Switch checked={autoTone === "true"} label="Auto tone when selected" onChange={(v) => setAutoTone(v ? "true" : "false")} />
          </div>
          <div className="setrow">
            <div className="t" style={{ display: "grid", gap: 6 }}>
              Default look when selected
              <Select className="pick" value={autoLook} onChange={(e) => setAutoLook(e.target.value)} aria-label="Default look">
                <option value="">None</option>
                {looks.filter((l) => l.favorite || l.collection === "Your presets").map((l) => <option key={l.id} value={l.id}>{l.favorite ? `★${l.favorite} ` : ""}{l.name}</option>)}
                <optgroup label="All looks">
                  {looks.map((l) => <option key={`all${l.id}`} value={l.id}>{l.collection} · {l.name}</option>)}
                </optgroup>
              </Select>
            </div>
          </div>
          <div className="setrow">
            <div className="t" style={{ display: "grid", gap: 4 }}>
              <span className="row-flex" style={{ justifyContent: "space-between" }}>Strength of the default look <span className="meta">{Math.round(Number(autoStrength) * 100)}%</span></span>
              <input type="range" min={10} max={100} value={Math.round(Number(autoStrength) * 100)} onChange={(e) => setAutoStrength(String(Number(e.target.value) / 100))} aria-label="Default look strength" />
            </div>
          </div>
          <p className="hint">Culling with A then gives every keeper a first edit on its own. Open the editor to fine-tune.</p>
        </section>

        <section className="card">
          <p className="eyebrow"><span>Looks</span><span>{looks.length}</span></p>
          <div style={{ display: "grid", gap: 4, maxHeight: 190, overflowY: "auto", marginBottom: 10 }}>
            {collections.map(([c, count]) => (
              <div key={c} className="row-flex" style={{ justifyContent: "space-between", fontSize: 13 }}>
                <span>{c}</span>
                <span className="meta">{count}</span>
              </div>
            ))}
          </div>
          <div className="row-flex" style={{ flexWrap: "wrap" }}>
            <button type="button" className="btn quiet small" onClick={() => run(() => api.importLooks(), "Looking for new presets and LUTs…").then(() => setTimeout(reloadLooks, 3000))}>Rescan</button>
            <button
              type="button"
              className="btn quiet small"
              onClick={async () => {
                const path = await open({ directory: true, multiple: false, title: "A folder with .xmp presets, .cube LUTs or HaldCLUT .png files" });
                if (typeof path === "string") run(() => api.addLookFolder(path), "Folder added: importing looks");
              }}
            >
              Add folder…
            </button>
          </div>
          <p className="eyebrow" style={{ marginTop: 16 }}><span>Where looks come from</span><span>{lookFolders.length}</span></p>
          {lookFolders.map((f) => (
            <div key={f.path} className="setrow" style={{ alignItems: "flex-start" }}>
              <div className="t" style={{ minWidth: 0 }}>
                <span className="mono" style={{ fontSize: 12, overflowWrap: "anywhere" }}>{shortPath(f.path)}</span>
                <small>{plural(f.looks, "look")} · {f.added ? "added by you" : "found automatically"}</small>
              </div>
              {removingLooks === f.path ? (
                <div className="row-flex" style={{ gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <span className="meta">Its looks leave the app (looks your photos use stay). The folder isn't touched.</span>
                  <button
                    type="button"
                    className="btn small danger"
                    onClick={() => {
                      setRemovingLooks(null);
                      run(async () => {
                        const [removed, kept] = await api.removeLookFolder(f.path);
                        reloadLooks();
                        toast(`${plural(removed, "look")} removed${kept ? ` · ${kept} kept because photos use them` : ""}`);
                      });
                    }}
                  >
                    Remove
                  </button>
                  <button type="button" className="btn small quiet" onClick={() => setRemovingLooks(null)}>Cancel</button>
                </div>
              ) : (
                <button type="button" className="link" style={{ fontSize: 12, color: "var(--red)" }} onClick={() => setRemovingLooks(f.path)}>Remove…</button>
              )}
            </div>
          ))}
          <p className="hint" style={{ marginTop: 12 }}>Preset and LUT files are only read, never changed. A removed folder can be added back with Add folder….</p>
        </section>

        <section className="card">
          <p className="eyebrow"><span>Tags</span><span>{tags.length}</span></p>
          {tags.length === 0 && <p className="meta">No tags yet: add them from a photo or the picked photos in Pictures.</p>}
          <div style={{ display: "grid", maxHeight: 320, overflowY: "auto" }}>
            {tags.map((t) => (
              <div key={t.id} className="setrow">
                {renamingTag?.id === t.id ? (
                  <form
                    className="row-flex"
                    style={{ gap: 6, flex: 1 }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      const name = renamingTag.name.trim();
                      setRenamingTag(null);
                      if (name && name !== t.name) run(async () => { await api.renameTag(t.id, name); reloadMeta(); }, "Tag renamed");
                    }}
                  >
                    <input
                      id={`tag-${t.id}`}
                      className="box"
                      autoFocus
                      value={renamingTag.name}
                      onChange={(e) => setRenamingTag({ id: t.id, name: e.target.value })}
                      onKeyDown={(e) => e.key === "Escape" && setRenamingTag(null)}
                      aria-label={`New name for #${t.name}`}
                      style={{ flex: 1, minWidth: 0 }}
                    />
                    <button type="submit" className="btn small primary">Save</button>
                  </form>
                ) : deletingTag === t.id ? (
                  <>
                    <div className="t">#{t.name}<small>Remove this tag from {plural(t.usage, "photo")}? The photos stay.</small></div>
                    <div className="row-flex" style={{ gap: 6 }}>
                      <button type="button" className="btn small danger" onClick={() => { setDeletingTag(null); run(async () => { await api.deleteTag(t.id); reloadMeta(); }, "Tag removed"); }}>Remove tag</button>
                      <button type="button" className="btn small quiet" onClick={() => setDeletingTag(null)}>Cancel</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="t">#{t.name}<small>{plural(t.usage, "photo")}</small></div>
                    <div className="row-flex" style={{ gap: 10 }}>
                      <button type="button" className="link" style={{ fontSize: 12 }} onClick={() => setRenamingTag({ id: t.id, name: t.name })}>Rename</button>
                      <button type="button" className="link" style={{ fontSize: 12, color: "var(--red)" }} onClick={() => setDeletingTag(t.id)}>Remove…</button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <p className="eyebrow">Archive</p>
          {locations.map((l) => (
            <div key={l.id} className="setrow">
              <div className="t">
                <span className="row-flex" style={{ gap: 8 }}><i className={`dot ${l.online ? "d-ok" : "d-idle"}`} />{l.label}</span>
                <small className="mono">{l.root}</small>
                <small>{plural(l.archivedCount, "file")} · {bytes(l.archivedBytes)}{l.online ? "" : " · not connected"}</small>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                <button type="button" className="btn quiet small" disabled={!l.online || archiving} onClick={() => archiveSelected(l)}>
                  {archiving ? "Copying…" : selection.size ? `Archive ${selection.size} picked` : "Archive all selected"}
                </button>
                <button type="button" className="link" style={{ fontSize: 12, color: "var(--muted)" }} onClick={() => run(() => api.removeLocation(l.id))}>Forget</button>
              </div>
            </div>
          ))}
          <button type="button" className="btn quiet small" style={{ marginTop: 8 }} onClick={chooseArchive}>{Icon.folder()} Choose archive folder…</button>
          <p className="hint" style={{ marginTop: 12 }}>Originals are copied, checked against the source and never deleted, here or there. Cloud storage can be added later.</p>
        </section>

        <section className="card">
          <p className="eyebrow"><span>Keyboard</span><button type="button" className="link" onClick={async () => { setKeymap(DEFAULT_KEYMAP); await api.setSetting("keymap", JSON.stringify(DEFAULT_KEYMAP)); }}>Reset</button></p>
          <div style={{ display: "grid", gap: 6 }}>
            {(Object.keys(ACTION_LABELS) as Action[]).map((a) => (
              <div key={a} className="row-flex" style={{ justifyContent: "space-between", fontSize: 13.5 }}>
                <span style={{ color: "var(--ink-2)" }}>{ACTION_LABELS[a]}</span>
                <button type="button" className="btn quiet small" onClick={() => setRecording(a)} style={recording === a ? { borderColor: "var(--green)", color: "var(--green)" } : undefined}>
                  {recording === a ? "Press a key…" : keymap[a].map(keyLabel).join(" / ")}
                </button>
              </div>
            ))}
          </div>
          <p className="hint" style={{ marginTop: 12 }}>Editor: [ ] next look · 1–9 favourites · ⌘U auto · \ before · ⌘C ⌘V settings · ⌥⌘V choose what to paste · ⌘⇧V paste on all · P same as previous · ⌘E export</p>
        </section>

        <HistoryCard />

        <section className="card" style={{ gridColumn: "1 / -1" }}>
          <p className="eyebrow">Backups</p>
          <p className="hint" style={{ margin: "0 0 10px" }}>
            Every day the app keeps a copy of your library for a week: marks, albums, tags, edits and posts. Your photos aren't part of it; they stay where they are.
          </p>
          {backups.length === 0 && <p className="meta">No backups yet: the first one is made today.</p>}
          {(showAllBackups ? backups : backups.slice(0, 4)).map((b) => (
            <div key={b.name} className="setrow">
              <div className="t">
                {whenLabel(b.createdMs)}
                <small>
                  {b.kind === "daily" ? "Daily copy" : b.kind === "manual" ? "Made by hand" : b.kind === "before-restore" ? "Your library just before a restore" : "Before an app update"} · {bytes(b.size)}
                </small>
              </div>
              {restoring === b.name ? (
                <div className="row-flex" style={{ gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <span className="meta">The app restarts with this copy. Your library as it is now is kept as a backup, so you can undo this.</span>
                  <button type="button" className="btn small danger" onClick={() => { setRestoring(null); run(() => api.restoreBackup(b.name)); }}>Restore and restart</button>
                  <button type="button" className="btn small quiet" onClick={() => setRestoring(null)}>Cancel</button>
                </div>
              ) : (
                <button type="button" className="link" style={{ fontSize: 12 }} onClick={() => setRestoring(b.name)}>Restore…</button>
              )}
            </div>
          ))}
          <div className="row-flex" style={{ gap: 10, marginTop: 10 }}>
            <button type="button" className="btn small" onClick={() => run(() => api.backupNow(), "Backup made")}>Back up now</button>
            {backups.length > 4 && (
              <button type="button" className="link" style={{ fontSize: 12 }} onClick={() => setShowAllBackups((v) => !v)}>
                {showAllBackups ? "Show fewer" : `Show all ${backups.length}`}
              </button>
            )}
          </div>
        </section>

        <section className="card" style={{ gridColumn: "1 / -1" }}>
          <p className="eyebrow">Help</p>
          <div className="setrow">
            <div className="t">Version<small>Captured by Andy {version ?? "…"}</small></div>
          </div>
          <div className="setrow">
            <div className="t">
              Export diagnostics
              <small>Puts the app's logs and facts about your library (counts, folders, recent scans; no photos) in one folder in Exports, for someone helping you. The app sends nothing anywhere.</small>
            </div>
            <button type="button" className="btn small" onClick={() => run(() => api.exportDiagnostics(), "Diagnostics saved in Exports")}>Export…</button>
          </div>
        </section>

        <section className="card" style={{ gridColumn: "1 / -1" }}>
          <p className="eyebrow">On this Mac</p>
          <dl className="kv">
            <dt>Library</dt><dd className="mono">{info?.dbPath}</dd>
            <dt>Thumbnails</dt><dd className="mono">{info?.cacheDir} · rebuilt automatically if removed</dd>
            <dt>Exports</dt>
            <dd className="mono">
              {info?.exportsDir}
              {info && <button type="button" className="link" style={{ marginLeft: 8 }} onClick={() => api.reveal(info.exportsDir).catch(() => toast("No exports yet"))}>Show</button>}
              <button
                type="button"
                className="link"
                style={{ marginLeft: 8 }}
                onClick={async () => {
                  const path = await open({ directory: true, multiple: false, title: "Where exports go" });
                  if (typeof path === "string") run(() => api.setSetting("exports.dir", path), "Exports go to the new folder");
                }}
              >
                Change…
              </button>
              <button type="button" className="link" style={{ marginLeft: 8 }} onClick={() => run(() => api.setSetting("exports.dir", ""), "Exports back in the default folder")}>Use default</button>
            </dd>
          </dl>
          <div className="setrow" style={{ marginTop: 10 }}>
            <div className="t">
              Sharp previews
              <small>
                {space ? `Using ${bytes(space.used)} of ${bytes(space.max)}. ` : ""}Newest photos first; the least recently viewed go when it's full.
              </small>
            </div>
            <div className="row-flex" style={{ gap: 8 }}>
              <Select
                id="preview-space"
                className="pick"
                aria-label="Space for sharp previews"
                value={space ? String(Math.round(space.max / 1e9)) : "6"}
                onChange={(e) => run(async () => { await api.setSetting("previews.maxGB", e.target.value); }, "Preview space changed")}
              >
                {[2, 4, 6, 10, 20].map((gb) => <option key={gb} value={gb}>{gb} GB</option>)}
              </Select>
              {clearing ? (
                <>
                  <span className="meta">Online photos are fetched again when opened.</span>
                  <button type="button" className="btn small danger" onClick={() => { setClearing(false); run(async () => { const freed = await api.clearPreviews(); toast(`${bytes(freed)} freed`); }); }}>Clear</button>
                  <button type="button" className="btn small quiet" onClick={() => setClearing(false)}>Cancel</button>
                </>
              ) : (
                <button type="button" className="btn small quiet" onClick={() => setClearing(true)}>Clear previews…</button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
