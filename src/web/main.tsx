// Captured by Andy online (studio.andyssarchives.com): the whole app in a
// browser. The Rust side is replaced by answers from Supabase (the app's
// memory, synced from the Mac) and the pictures come straight from Google Drive
// through a service worker. No AI and no keys of Andy's live here: only his own
// Google sign-in.
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Session } from "@supabase/supabase-js";
import { assets, sized, type ImageKind } from "../api";
import { photoSizeUrl } from "../lib/photoSize";
import App from "../App";
import { webHooks } from "../platform";
import { applyPalette, currentPalette } from "../theme";
import { EMPTY_LISTS, QUIET, driveIdOf, library, libraryChanged, setPhotos, setRest, webVideoOf } from "./library";
import { configured, drive, flush, keepDriveLogin, loadPhotos, loadRest, onSyncStatus, sb, signIn, signOut, type SyncStatus } from "./remote";
import { setStudio, studio } from "./studio";
import "./web.css";

document.documentElement.dataset.web = "1";
webHooks.signOut = () => void signOut().catch((e) => window.alert(e instanceof Error ? e.message : String(e)));
webHooks.videoAvailable = (id) => !!webVideoOf(id);
applyPalette(currentPalette());
document.documentElement.dataset.mode = "photo";

// ---------------------------------------------------------------- the commands

mockIPC(
  (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (cmd.startsWith("plugin:")) return null;
    const answer = cmd.startsWith("studio_") || cmd.startsWith("dictate_") ? studio(cmd, a) : library(cmd, a);
    if (answer) return answer.value;
    if (EMPTY_LISTS.has(cmd)) return [];
    if (QUIET.has(cmd) || cmd.startsWith("voice_")) return null;
    throw "That happens on the Mac. Online you can look, cull, sort into albums, and plan and write in Projects.";
  },
  { shouldMockEvents: true },
);

// ---------------------------------------------------------------- pictures from Drive

const DRIVE_KIND: Record<ImageKind, string> = { thumb: "thumb", preview: "preview", full: "full", original: "full", video: "video", editvideo: "video", fullvideo: "video" };
assets.image = (kind, id) => {
  // Videos play from their web copy only; without one there is nothing a browser can show.
  const file = kind === "video" || kind === "editvideo" ? webVideoOf(id) : driveIdOf(id);
  return file ? `/drive/${DRIVE_KIND[kind]}/${file}` : "/drive/none";
};
// Codex 006's size ladder, wired at last: the request follows the shown size.
sized.url = (id, cssWidth) => {
  const file = driveIdOf(id);
  return file ? photoSizeUrl(file, cssWidth, window.devicePixelRatio || 1) : null;
};
assets.lut = async () => {
  throw new Error("Looks are on the Mac.");
};

async function startWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  await navigator.serviceWorker.register("/sw.js");
  // The worker asks for a Drive token whenever it needs one.
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type !== "drive-token" || !e.ports[0]) return;
    void drive.get().then((token) => e.ports[0].postMessage({ token, until: drive.until }));
  });
  await navigator.serviceWorker.ready;
}

// ---------------------------------------------------------------- start

function Boot() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [stage, setStage] = useState<"sign-in" | "loading" | "ready" | "error">("loading");
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ pending: 0, sending: false, problem: null, lastSuccess: null });

  useEffect(() => {
    const unsubscribeStatus = onSyncStatus(setSyncStatus);
    void sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = sb.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === "SIGNED_IN" && s) void keepDriveLogin(s).catch(() => {});
    });
    return () => { data.subscription.unsubscribe(); unsubscribeStatus(); };
  }, []);

  useEffect(() => {
    if (session === undefined) return;
    if (!session) {
      setStage("sign-in");
      return;
    }
    let live = true;
    let removeVisibility = () => {};
    setStage("loading");
    (async () => {
      await startWorker().catch(() => {});
      const [{ photos, fresh }, rest] = await Promise.all([loadPhotos((d, t) => live && setProgress([d, t])), loadRest()]);
      if (!live) return;
      setPhotos(photos);
      setRest(rest);
      setStudio(rest);
      setStage("ready");
      void flush();
      // Whatever changed since this browser last looked, then on every return to the app.
      const refresh = async (wait?: Promise<typeof photos | null>) => {
        const changed = await (wait ?? loadPhotos(() => {}).then((r) => r.fresh));
        const rest = await loadRest().catch(() => null);
        if (!live) return;
        if (changed) setPhotos(changed);
        if (rest) {
          setRest(rest);
          setStudio(rest);
        }
        libraryChanged();
      };
      void refresh(fresh).catch(() => {});
      let last = Date.now();
      const onVisibility = () => {
        if (document.visibilityState === "visible" && Date.now() - last > 60_000) {
          last = Date.now();
          void flush();
          void refresh().catch(() => {});
        }
      };
      document.addEventListener("visibilitychange", onVisibility);
      removeVisibility = () => document.removeEventListener("visibilitychange", onVisibility);
    })().catch((e) => {
      if (!live) return;
      setProblem(e?.message ?? String(e));
      setStage("error");
    });
    return () => {
      live = false;
      removeVisibility();
    };
  }, [session]);

  if (stage === "ready") {
    return (
      <>
        <App />
        {(syncStatus.pending > 0 || syncStatus.problem) && <div className="web-pending" role="status">
          <span>{syncStatus.problem ?? `${syncStatus.pending} ${syncStatus.pending === 1 ? "change" : "changes"} ${syncStatus.sending ? "syncing…" : "waiting to sync"}`}</span>
          {!syncStatus.sending && <button type="button" className="link" onClick={() => void flush()}>Retry sync</button>}
        </div>}
      </>
    );
  }
  return (
    <div className="web-gate">
      <div className="web-gate-card">
        <div className="web-mark">Captured by Andy</div>
        {stage === "sign-in" && (
          <>
            <p>Your pictures, projects and scripts, wherever you are.</p>
            {!configured && <p className="web-problem">This copy isn't connected to Supabase yet (VITE_SUPABASE_ANON_KEY).</p>}
            <button className="primary" disabled={!configured} onClick={() => void signIn().catch((e) => setProblem(e.message))}>
              Sign in with Google
            </button>
            {problem && <p className="web-problem">{problem}</p>}
          </>
        )}
        {stage === "loading" && (
          <>
            <p>{progress ? `Bringing in your library… ${progress[0].toLocaleString()} of ${progress[1].toLocaleString()}` : "Opening your library…"}</p>
            <div className="web-bar">
              <span style={{ width: progress && progress[1] ? `${(100 * progress[0]) / progress[1]}%` : "8%" }} />
            </div>
            <p className="web-note">The first time takes a minute; after that it opens at once, even without signal.</p>
          </>
        )}
        {stage === "error" && (
          <>
            <p className="web-problem">{problem}</p>
            <div className="web-actions">
              <button onClick={() => location.reload()}>Try again</button>
              <button className="ghost" onClick={() => void signOut().catch((e) => setProblem(e instanceof Error ? e.message : String(e)))}>
                Sign out
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Boot />
  </React.StrictMode>,
);
