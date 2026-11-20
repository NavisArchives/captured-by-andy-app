// Settings › Studio: where the Studio folder lives, the optional keys for
// YouTube search and the Instagram watchlist, and the browser button that
// sends a page to Inspire.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "../api";
import { useToast } from "../components/ui";
import { useStore } from "../store";
import { studio } from "./api";

function useSetting(key: string) {
  const [value, setValue] = useState("");
  useEffect(() => {
    api.getSetting(key).then((v) => v != null && setValue(v.replace(/^"|"$/g, ""))).catch(() => {});
  }, [key]);
  const save = useCallback(async (v: string) => {
    setValue(v);
    await api.setSetting(key, v);
  }, [key]);
  return [value, setValue, save] as const;
}

const BOOKMARKLET = "javascript:location.href='capturedbyandy://save?url='+encodeURIComponent(location.href)";

export function StudioSettings() {
  const toast = useToast();
  const { sources } = useStore();
  const [root, setRoot] = useState("");
  const [, , saveRoot] = useSetting("studio.root");
  const [yt, setYt, saveYt] = useSetting("studio.youtubeKey");
  const [token, setToken, saveToken] = useSetting("studio.igToken");
  const [igId, setIgId, saveIgId] = useSetting("studio.igUserId");
  useEffect(() => {
    studio.summary().then((s) => setRoot(s.root)).catch(() => {});
  }, []);

  const move = async () => {
    const path = await openDialog({ directory: true, title: "Where should the STUDIO folder live?" });
    if (typeof path !== "string") return;
    const target = path.replace(/\/+$/, "").endsWith("/STUDIO") ? path : `${path.replace(/\/+$/, "")}/STUDIO`;
    await saveRoot(target);
    try {
      setRoot(await studio.root());
      toast("New pieces go to the new Studio folder. Folders made before stay where they are (move them in Finder if you like: the app finds them by their hidden id).");
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`);
    } catch {
      toast("Couldn't copy: select the text and press ⌘C", { error: true });
    }
  };

  return (
    <section className="card" style={{ gridColumn: "1 / -1" }}>
      <p className="eyebrow">
        <span>Studio</span>
        <span>videos and posts</span>
      </p>
      <div className="grid-3" style={{ gap: 18 }}>
        <div className="st-col">
          <b style={{ fontWeight: 500 }}>Studio folder</b>
          <span className="meta" style={{ wordBreak: "break-all" }}>{root || "Movies/STUDIO"}</span>
          <span style={{ fontSize: 13, color: "var(--ink-2)" }}>Pillars, families and pieces get their folders here. The Mac is nearly full: an external SSD works too, as long as its name stays the same.</span>
          {root && !sources.some((x) => root.startsWith(x.path.replace(/\/+$/, "")) || x.path.startsWith(root)) && (
            <div className="st-col" style={{ gap: 6 }}>
              <span style={{ fontSize: 13, color: "var(--ink-2)" }}>Add it to Pictures so footage in your pieces can be culled and attached to pieces. Nothing is copied.</span>
              <button
                type="button"
                className="btn primary small"
                style={{ justifySelf: "start" }}
                onClick={() =>
                  api
                    .addSource(root)
                    .then(() => api.scanAll())
                    .then(() => toast("Studio folder added to Pictures: scanning"))
                    .catch((e) => toast(errorText(e), { error: true }))
                }
              >
                Add the Studio folder to Pictures
              </button>
            </div>
          )}
          <div className="st-row">
            <button type="button" className="btn quiet small" onClick={() => void move()}>
              Choose another place…
            </button>
            <button type="button" className="btn quiet small" onClick={() => root && studio.openFolder(root).catch((e) => toast(errorText(e), { error: true }))}>
              Show in Finder
            </button>
          </div>
        </div>
        <div className="st-col">
          <b style={{ fontWeight: 500 }}>Save to Studio, from the browser</b>
          <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
            Make a bookmark (⌘D) in Safari or Chrome, then paste this as its address. Clicking it on a TikTok, Instagram or YouTube page saves that page to Inspire.
          </span>
          <code className="hint" style={{ wordBreak: "break-all", userSelect: "text" }}>{BOOKMARKLET}</code>
          <div className="st-row">
            <button type="button" className="btn quiet small" onClick={() => void copy(BOOKMARKLET, "Bookmark address")}>
              Copy bookmark address
            </button>
          </div>
          <span className="meta">From your iPhone: AirDrop screenshots and screen recordings, then drag them onto Inspire, or put them in 81_INSPO_DROP.</span>
        </div>
        <div className="st-col">
          <b style={{ fontWeight: 500 }}>Optional keys</b>
          <label className="st-field">
            <span>YouTube API key (Shorts search in Trends)</span>
            <input type="password" value={yt} placeholder="Free at console.cloud.google.com" onChange={(e) => setYt(e.target.value)} onBlur={() => void saveYt(yt.trim())} />
          </label>
          <label className="st-field">
            <span>Instagram access token (watchlist)</span>
            <input type="password" value={token} placeholder="From your own Meta developer app" onChange={(e) => setToken(e.target.value)} onBlur={() => void saveToken(token.trim())} />
          </label>
          <label className="st-field">
            <span>Your Instagram account id</span>
            <input value={igId} placeholder="17841…" onChange={(e) => setIgId(e.target.value)} onBlur={() => void saveIgId(igId.trim())} />
          </label>
          <span className="meta">Everything else in Studio works without them.</span>
        </div>
      </div>
    </section>
  );
}
