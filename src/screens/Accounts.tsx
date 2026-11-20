import { useState } from "react";
import { api, errorText } from "../api";
import { Thumb } from "../components/Thumb";
import { Hero, Icon, Modal, useToast } from "../components/ui";
import { compact } from "../lib/format";
import { useStore } from "../store";

export function Accounts() {
  const { accounts, go, reloadMeta } = useStore();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [followers, setFollowers] = useState("");

  const create = async () => {
    try {
      const a = await api.createAccount({ username, displayName, followerCount: followers ? Number(followers) : null });
      reloadMeta();
      setAdding(false);
      go({ name: "account", id: a.id });
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };

  return (
    <div className="screen scroll">
      <Hero title="Your" italic="accounts" sub="Numbers are typed in by you: nothing connects to Instagram">
        <button type="button" className="btn primary" onClick={() => setAdding(true)}>{Icon.plus()} Add account</button>
      </Hero>
      <div className="grid-3">
        {accounts.map((a) => (
          <button key={a.id} type="button" className="card" onClick={() => go({ name: "account", id: a.id })} style={{ textAlign: "left", display: "flex", gap: 16, alignItems: "center", color: "inherit" }}>
            <span style={{ width: 64, height: 64, borderRadius: "50%", overflow: "hidden", flex: "none", display: "block" }}><Thumb id={a.avatarPhotoId} hash={a.avatarThumbhash} /></span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 17, fontWeight: 600, letterSpacing: "-0.015em" }}>@{a.username}</span>
              <span className="meta" style={{ display: "block" }}>{a.displayName || "Instagram"}</span>
              <span style={{ display: "block", fontSize: 13, marginTop: 6 }}>
                <b>{compact(a.followerCount)}</b> <span className="muted">followers</span> · <b>{a.drafts + a.ready}</b> <span className="muted">planned</span>
              </span>
            </span>
          </button>
        ))}
        <button type="button" className="card dashed" onClick={() => setAdding(true)} style={{ minHeight: 112, color: "var(--muted)", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          {Icon.plus()} Add account
        </button>
      </div>
      {adding && (
        <Modal
          title="Add an Instagram account"
          onClose={() => setAdding(false)}
          foot={
            <>
              <span className="spacer" />
              <button type="button" className="btn quiet" onClick={() => setAdding(false)}>Cancel</button>
              <button type="button" className="btn primary" disabled={!username.trim()} onClick={create}>Add</button>
            </>
          }
        >
          <div style={{ display: "grid", gap: 12 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <span className="eyebrow" style={{ margin: 0 }}>Username</span>
              <input className="box" autoFocus name="username" autoComplete="off" spellCheck={false} placeholder="@capturedbyandy" value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <span className="eyebrow" style={{ margin: 0 }}>Display name</span>
              <input className="box" placeholder="Captured by Andy" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <span className="eyebrow" style={{ margin: 0 }}>Followers (optional)</span>
              <input className="box" inputMode="numeric" value={followers} onChange={(e) => setFollowers(e.target.value.replace(/\D/g, ""))} />
            </label>
            <p className="hint">No password, no login: this only helps you plan. The app never posts or connects to Instagram.</p>
          </div>
        </Modal>
      )}
    </div>
  );
}
