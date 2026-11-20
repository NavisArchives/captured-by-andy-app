// Settings › Google Drive, direct: the app downloads videos straight from
// Google (several pieces at once) instead of through the Google Drive app.
// Andy's own Google Cloud login; kept in the macOS Keychain.
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { errorText } from "../api";
import { useToast } from "./ui";

interface Speed {
  file: string;
  mb: number;
  seconds: number;
}

export function DriveConnection() {
  const toast = useToast();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<"" | "connect" | "test">("");
  const [speed, setSpeed] = useState<Speed | null>(null);
  const load = () =>
    invoke<{ connected: boolean; problem: string | null; offline: boolean }>("gdrive_status")
      .then((s) => {
        setConnected(s.connected);
        setProblem(s.problem);
        setOffline(s.offline);
      })
      .catch(() => setConnected(false));
  const reconnect = async () => {
    setBusy("connect");
    try {
      await invoke("gdrive_reconnect");
      toast("Signed in to Google Drive again");
      await load();
    } catch (e) {
      toast(errorText(e), { error: true });
    } finally {
      setBusy("");
    }
  };
  const [found, setFound] = useState("");
  useEffect(() => void load(), []);
  // A client file downloaded from Google Cloud fills the form by itself.
  useEffect(() => {
    if (connected !== false) return;
    invoke<{ clientId: string; clientSecret: string; file: string } | null>("gdrive_find_client")
      .then((c) => {
        if (!c) return;
        setClientId(c.clientId);
        setSecret(c.clientSecret);
        setFound(c.file);
      })
      .catch(() => {});
  }, [connected]);

  const connect = async () => {
    setBusy("connect");
    try {
      await invoke("gdrive_connect", { clientId, clientSecret: secret });
      setClientId("");
      setSecret("");
      toast("Connected to Google Drive");
      await load();
    } catch (e) {
      toast(errorText(e), { error: true });
    } finally {
      setBusy("");
    }
  };
  const test = async () => {
    setBusy("test");
    try {
      setSpeed(await invoke<Speed>("gdrive_speed_test"));
    } catch (e) {
      toast(errorText(e), { error: true });
    } finally {
      setBusy("");
    }
  };
  const disconnect = () => invoke("gdrive_disconnect").then(load).catch((e) => toast(errorText(e), { error: true }));

  return (
    <section className="card">
      <p className="eyebrow">
        <span>Google Drive, direct</span>
        <span>{connected ? (problem ? "Sign-in expired" : "Connected") : connected === false ? "Not connected" : ""}</span>
      </p>
      <p style={{ margin: "0 0 10px", fontSize: 13.5, color: "var(--ink-2)" }}>
        Downloads videos straight from Google, several pieces at once, instead of through the Google Drive app (about 10 MB/s). Used for review copies. Read-only: the app can't change anything in your Drive.
      </p>
      {connected === null ? (
        <p className="meta" style={{ margin: 0 }}>Checking the connection…</p>
      ) : connected ? (
        <>
          {speed && (
            <p className="meta" style={{ margin: "0 0 10px" }}>
              {speed.file}: {Math.round(speed.mb)} MB in {speed.seconds.toFixed(1)} s · {(speed.mb / speed.seconds).toFixed(1)} MB/s
            </p>
          )}
          {offline && !problem && (
            <p className="meta" style={{ margin: "0 0 10px" }}>
              Can't reach Google right now (no internet?). Thumbnails and previews wait and go on by themselves.
            </p>
          )}
          {problem && (
            <p className="meta" style={{ margin: "0 0 10px", color: "var(--red)" }}>
              Google no longer accepts the sign-in ({problem}), so thumbnails and previews come through the slow Google Drive app. Sign in again: your browser opens, you click Allow.
            </p>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            {problem && (
              <button type="button" className="btn primary small" disabled={!!busy} onClick={() => void reconnect()}>
                {busy === "connect" ? "Waiting for the browser…" : "Sign in again"}
              </button>
            )}
            <button type="button" className={problem ? "btn quiet small" : "btn primary small"} disabled={!!busy} onClick={() => void test()}>
              {busy === "test" ? "Testing…" : "Test speed"}
            </button>
            <button type="button" className="btn quiet small" disabled={!!busy} onClick={() => void disconnect()}>
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
          style={{ display: "grid", gap: 8 }}
        >
          {found && <p className="meta" style={{ margin: 0 }}>Filled in from {found} in Downloads.</p>}
          <input className="box" placeholder="Client ID (….apps.googleusercontent.com)" value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client ID" autoComplete="off" spellCheck={false} />
          <input className="box" type="password" placeholder="Client secret" value={secret} onChange={(e) => setSecret(e.target.value)} aria-label="Client secret" autoComplete="off" />
          <div>
            <button type="submit" className="btn primary small" disabled={!!busy || !clientId.trim() || !secret.trim()}>
              {busy === "connect" ? "Waiting for Google… approve in your browser" : "Connect"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
