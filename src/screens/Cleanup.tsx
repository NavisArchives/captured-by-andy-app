// Clean up: deleting rejected photos for good, carefully. Only Rejected photos
// that aren't used anywhere are offered, and they start as kept: the last look
// marks what goes. Deleting is one trip at a time, confirmed by typing the
// number; files go to the Google Drive Bin (30 days, Undo here), then the same
// photos on the iPhone, where Apple asks again (Recently Deleted, 30 days).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "../api";
import { VideoBadge } from "../components/PhotoGrid";
import { Thumb } from "../components/Thumb";
import { Hero, Icon, Modal, useToast } from "../components/ui";
import { bytes, formatDate } from "../lib/format";
import { useStore } from "../store";
import type { CleanupBatch, CleanupCandidate, CleanupOverview, CleanupSet, PhotoRow, TripCleanup } from "../types";
import "../styles/cleanup.css";

const DAY = 86_400_000;

/** Quick marks: groups of rejects worth deleting together, safest first. */
const SETS: { id: CleanupSet; label: string; hint: string }[] = [
  { id: "copy", label: "Copies of photos you kept", hint: "Near-identical to a photo you selected in the same moment: nothing is lost" },
  { id: "scene", label: "Whole moment rejected", hint: "Every similar shot of that moment was rejected" },
  { id: "soft", label: "Soft", hint: "Out of focus or shaken" },
  { id: "utility", label: "Documents & screens", hint: "Receipts, signs, screens, notes: Apple calls them utility images" },
];
type Mark = CleanupCandidate["mark"];

export function Cleanup({ trip: start }: { trip?: string }) {
  const toast = useToast();
  const { go, bump } = useStore();
  const [overview, setOverview] = useState<CleanupOverview | null>(null);
  const [history, setHistory] = useState<CleanupBatch[]>([]);
  const [trip, setTrip] = useState<string | null>(start ?? null);
  const [phoneFor, setPhoneFor] = useState<CleanupBatch | null>(null);
  const [undoing, setUndoing] = useState<CleanupBatch | null>(null);
  // Bumped to reload the open trip's photos (after a delete or a mark in every trip).
  const [round, setRound] = useState(0);
  const reload = useCallback(() => {
    api.cleanupOverview().then(setOverview).catch((e) => toast(errorText(e), { error: true }));
    api.cleanupHistory().then(setHistory).catch(() => {});
  }, [toast]);
  useEffect(reload, [reload]);
  // The first trip to start with; another one when the trip shown is all cleaned up.
  useEffect(() => {
    if (overview?.trips.length && !overview.trips.some((t) => t.trip === trip)) setTrip(overview.trips[0].trip);
  }, [overview, trip]);


  const total = overview?.trips.reduce((n, t) => n + t.photos, 0) ?? 0;
  const copyBytes = overview?.trips.reduce((n, t) => n + t.bytesCopies, 0) ?? 0;
  const copyCount = overview?.trips.reduce((n, t) => n + t.copies, 0) ?? 0;
  const totalBytes = overview?.trips.reduce((n, t) => n + t.bytes, 0) ?? 0;
  const current = overview?.trips.find((t) => t.trip === trip) ?? null;

  return (
    <div className="screen cleanup">
      <Hero
        title="Clean up"
        children={
          copyCount > 0 && (
            <button
              type="button"
              className="btn quiet"
              title="Marks every rejected photo that is almost identical to one you kept, in every trip. Nothing is deleted: you still delete trip by trip."
              onClick={() =>
                api
                  .cleanupMarkSet("copy", "delete")
                  .then((n) => {
                    toast(`${n.toLocaleString()} near-copies marked to delete, in every trip`);
                    reload();
                    setRound((r) => r + 1);
                  })
                  .catch((e) => toast(errorText(e), { error: true }))
              }
            >
              Mark every near-copy · {bytes(copyBytes)}
            </button>
          )
        }
        crumb={<button type="button" className="link" onClick={() => go({ name: "pictures" })}>{Icon.back(12)} Pictures</button>}
        sub={
          overview
            ? `${total.toLocaleString()} rejected photos · ${bytes(totalBytes)} · ${bytes(copyBytes)} are near-copies of photos you kept`
            : "Reading the library…"
        }
      />
      <div className="cu-layout">
        <aside className="cu-side">
          <section className="card tight">
            <p className="eyebrow"><span>Trips</span><span>{overview?.trips.length ?? ""}</span></p>
            {overview && overview.trips.length === 0 && <p className="meta" style={{ margin: 0 }}>No rejected photos to clean up.</p>}
            <div className="cu-trips">
              {overview?.trips.map((t) => (
                <TripRow key={t.trip} t={t} on={t.trip === trip} onClick={() => setTrip(t.trip)} />
              ))}
            </div>
            {overview && overview.protected > 0 && (
              <p className="meta cu-protected" title="Tagged, in an album or a post, edited, kept on this Mac, in a Studio piece or on the website">
                {overview.protected.toLocaleString()} rejected photos are used somewhere, so they stay out of this list.
              </p>
            )}
          </section>
          <section className="card tight">
            <p className="eyebrow"><span>Deleted</span><span>{history.length || ""}</span></p>
            {history.length === 0 && <p className="meta" style={{ margin: 0 }}>Nothing deleted yet. What you delete stays in the Google Drive Bin for 30 days, and can be put back from here.</p>}
            <div className="cu-history">
              {history.map((h) => {
                const recoverable = !h.restored && Date.now() - h.deletedMs < 30 * DAY;
                const phoneLeft = !h.restored && (!h.phoneChecked || h.phoneFound > h.phoneDeleted);
                return (
                  <div key={h.batch} className="cu-batch">
                    <div className="cu-batch-main">
                      <b>{h.name}</b>
                      <span className="meta">
                        {h.photos.toLocaleString()} photos · {bytes(h.bytes)} · {formatDate(new Date(h.deletedMs).toISOString())}
                      </span>
                      <span className="meta">
                        {h.restored
                          ? "Put back"
                          : h.phoneDeleted
                            ? `Also off the iPhone (${h.phoneDeleted.toLocaleString()})`
                            : h.phoneChecked
                              ? h.phoneFound ? `${h.phoneFound.toLocaleString()} still on the iPhone` : "Not on the iPhone"
                              : "iPhone not done yet"}
                      </span>
                    </div>
                    <div className="row-flex" style={{ gap: 6 }}>
                      {phoneLeft && (
                        <button type="button" className="btn quiet small" onClick={() => setPhoneFor(h)}>iPhone…</button>
                      )}
                      {recoverable && (
                        <button type="button" className="btn quiet small" onClick={() => setUndoing(h)}>Undo</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </aside>
        <div className="cu-main">
          {current ? (
            <TripPanel
              key={`${current.trip}:${round}`}
              trip={current}
              onChanged={reload}
              onDeleted={(batch) => {
                setRound((r) => r + 1);
                reload();
                bump();
                api.cleanupHistory().then((h) => {
                  setHistory(h);
                  const b = h.find((x) => x.batch === batch);
                  if (b) setPhoneFor(b);
                });
              }}
            />
          ) : (
            <section className="card cu-empty">
              <p className="meta">{overview ? "Pick a trip on the left." : "Reading the library…"}</p>
            </section>
          )}
        </div>
      </div>
      {phoneFor && <PhoneStep batch={phoneFor} onClose={() => (setPhoneFor(null), reload())} />}
      {undoing && (
        <Modal
          title={`Put back ${undoing.photos.toLocaleString()} photos?`}
          onClose={() => setUndoing(null)}
          foot={
            <>
              <span className="spacer" />
              <button type="button" className="btn quiet" onClick={() => setUndoing(null)}>Cancel</button>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  const b = undoing;
                  setUndoing(null);
                  toast("Putting them back…");
                  api
                    .cleanupUndo(b.batch)
                    .then((r) => {
                      toast(r.failed.length ? `${r.photos.toLocaleString()} back · ${r.failed.length} couldn't be found in the Bin` : `${r.photos.toLocaleString()} photos back in ${b.name}`, { error: r.failed.length > 0 });
                      reload();
                      bump();
                    })
                    .catch((e) => toast(errorText(e), { error: true }));
                }}
              >
                Put them back
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            The files come back from the Google Drive Bin to {undoing.name}, Rejected as before. Photos deleted from the iPhone come back from Photos › Recently Deleted (the app can't do that part).
          </p>
        </Modal>
      )}
    </div>
  );
}

function TripRow({ t, on, onClick }: { t: TripCleanup; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={on ? "cu-trip on" : "cu-trip"} onClick={onClick}>
      <span className="cu-trip-name">{t.name}</span>
      <span className="cu-trip-n">{t.photos.toLocaleString()}</span>
      <span className="cu-trip-meta">
        {bytes(t.bytes)}
        {t.toDelete > 0 ? <em> · {t.toDelete.toLocaleString()} to delete</em> : t.copies > 0 && <> · {bytes(t.bytesCopies)} copies</>}
      </span>
      <span className="cu-bar" aria-hidden="true">
        <i className="del" style={{ width: `${(100 * t.toDelete) / Math.max(1, t.photos)}%` }} />
        <i className="keep" style={{ width: `${(100 * t.kept) / Math.max(1, t.photos)}%` }} />
      </span>
    </button>
  );
}

type Show = "all" | "delete" | "keep";

function TripPanel({ trip, onChanged, onDeleted }: { trip: TripCleanup; onChanged: () => void; onDeleted: (batch: string) => void }) {
  const toast = useToast();
  const [cands, setCands] = useState<CleanupCandidate[] | null>(null);
  const [rows, setRows] = useState<Map<string, PhotoRow>>(new Map());
  const [show, setShow] = useState<Show>("all");
  const [looking, setLooking] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [hoverSet, setHoverSet] = useState<CleanupSet | null>(null);
  useEffect(() => {
    let live = true;
    api.cleanupPhotos(trip.trip).then(async (list) => {
      if (!live) return;
      setCands(list);
      const ids = list.map((c) => c.id);
      for (let i = 0; i < ids.length && live; i += 400) {
        const page = await api.rows(ids.slice(i, i + 400)).catch(() => []);
        if (live) setRows((m) => new Map([...m, ...page.map((r) => [r.id, r] as const)]));
      }
    }).catch((e) => toast(errorText(e), { error: true }));
    return () => {
      live = false;
    };
  }, [trip.trip, toast]);

  const setMark = useCallback(
    (ids: string[], mark: Mark) => {
      setCands((cs) => cs?.map((c) => (ids.includes(c.id) ? { ...c, mark } : c)) ?? cs);
      api.cleanupMark(ids, mark).then(onChanged).catch((e) => toast(errorText(e), { error: true }));
    },
    [onChanged, toast],
  );

  const shown = useMemo(() => (cands ?? []).filter((c) => show === "all" || (show === "delete" ? c.mark === "delete" : c.mark !== "delete")), [cands, show]);
  const doomed = (cands ?? []).filter((c) => c.mark === "delete");
  const doomedBytes = doomed.reduce((n, c) => n + c.bytes, 0);
  const unlooked = (cands ?? []).filter((c) => c.mark == null).length;
  const inSet = (set: CleanupSet) => (cands ?? []).filter((c) => c.sets.includes(set));
  // A quick mark sends a whole group to "delete"; pressed again (all marked), it clears them.
  const quickMark = (set: CleanupSet) => {
    const group = inSet(set);
    const all = group.every((c) => c.mark === "delete");
    setMark(group.map((c) => c.id), all ? null : "delete");
  };

  return (
    <>
      <section className="card tight cu-bar-top">
        <div className="cu-title">
          <h2>{trip.name}</h2>
          <span className="meta">
            {trip.photos.toLocaleString()} rejected · {bytes(trip.bytes)} · {unlooked.toLocaleString()} not looked at yet (kept until you mark them)
          </span>
        </div>
        <div className="cu-sets" role="group" aria-label="Quick marks">
          <span className="eyebrow-inline">Mark to delete</span>
          {SETS.map((set) => {
            const group = inSet(set.id);
            if (!group.length) return null;
            const all = group.every((c) => c.mark === "delete");
            return (
              <button key={set.id} type="button" className="chipbtn cu-set" aria-pressed={all} onMouseEnter={() => setHoverSet(set.id)} onMouseLeave={() => setHoverSet(null)} onFocus={() => setHoverSet(set.id)} onBlur={() => setHoverSet(null)} title={`${set.hint}. ${all ? "Click to unmark them." : "Click to mark them all to delete."}`} onClick={() => quickMark(set.id)}>
                {all && Icon.check(10)} {set.label}
                <span className="n">
                  {group.length.toLocaleString()} · {bytes(group.reduce((n, c) => n + c.bytes, 0))}
                </span>
              </button>
            );
          })}
        </div>
        <div className="cu-tools">
          <div className="seg" role="group" aria-label="Show">
            {(
              [
                ["all", `All ${cands?.length ?? ""}`],
                ["delete", `To delete ${doomed.length}`],
                ["keep", `Kept ${(cands?.length ?? 0) - doomed.length}`],
              ] as [Show, string][]
            ).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={show === id} onClick={() => setShow(id)}>
                {label}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <button type="button" className="btn quiet small" disabled={!cands?.length} onClick={() => setLooking(Math.max(0, (cands ?? []).findIndex((c) => c.mark == null)))} title="One by one, big: D deletes, K keeps">
            {Icon.eye()} Last look
          </button>
          <button type="button" className="btn quiet small" disabled={!shown.length} onClick={() => setMark(shown.map((c) => c.id), "delete")} title="Every photo shown here">
            Mark {show === "all" ? "all" : "these"} to delete
          </button>
          <button type="button" className="btn quiet small" disabled={!shown.length} onClick={() => setMark(shown.map((c) => c.id), "keep")}>
            Keep {show === "all" ? "all" : "these"}
          </button>
          <button type="button" className="btn danger-solid small" disabled={!doomed.length} onClick={() => setConfirming(true)}>
            {doomed.length ? `Delete ${doomed.length.toLocaleString()} · ${bytes(doomedBytes)}…` : "Delete…"}
          </button>
        </div>
      </section>
      <section className="card tight cu-grid-card">
        {!cands ? (
          <p className="meta">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="meta">{show === "delete" ? "Nothing marked to delete yet. Click photos, or use Last look." : "Nothing here."}</p>
        ) : (
          <div className="cu-grid">
            {shown.map((c) => {
              const r = rows.get(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`cu-tile ${c.mark === "delete" ? "del" : c.mark === "keep" ? "keep" : ""}${hoverSet ? (c.sets.includes(hoverSet) ? " hl" : " dim") : ""}`}
                  title={`${r?.filename ?? ""} · ${bytes(c.bytes)} · click: ${c.mark === "delete" ? "keep" : "delete"}`}
                  onClick={(e) => (e.altKey ? setLooking((cands ?? []).indexOf(c)) : setMark([c.id], c.mark === "delete" ? "keep" : "delete"))}
                  onDoubleClick={() => setLooking((cands ?? []).indexOf(c))}
                >
                  <Thumb id={c.id} hash={r?.thumbhash ?? null} />
                  {r?.isVideo && <VideoBadge seconds={r.duration} />}
                  {c.mark === "delete" && <span className="cu-flag">{Icon.x(11)}</span>}
                </button>
              );
            })}
          </div>
        )}
      </section>
      {looking != null && cands && (
        <LastLook
          cands={cands}
          rows={rows}
          start={looking}
          onMark={(id, m) => setMark([id], m)}
          onClose={() => setLooking(null)}
        />
      )}
      {confirming && (
        <ConfirmDelete
          trip={trip}
          ids={doomed.map((c) => c.id)}
          size={doomedBytes}
          onClose={() => setConfirming(false)}
          onDone={(batch) => {
            setConfirming(false);
            onDeleted(batch);
          }}
        />
      )}
    </>
  );
}

/** One photo at a time, big: D (or ⌫) deletes, K (or Space) keeps, arrows move. */
function LastLook({ cands, rows, start, onMark, onClose }: { cands: CleanupCandidate[]; rows: Map<string, PhotoRow>; start: number; onMark: (id: string, mark: Mark) => void; onClose: () => void }) {
  const [i, setI] = useState(Math.min(start, cands.length - 1));
  const c = cands[i];
  const r = c ? rows.get(c.id) : undefined;
  const ref = useRef({ i, c });
  ref.current = { i, c };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { i, c } = ref.current;
      if (!c) return;
      const k = e.key.toLowerCase();
      const mark = (m: Mark) => {
        onMark(c.id, m);
        setI(Math.min(cands.length - 1, i + 1));
      };
      if (k === "escape") onClose();
      else if (k === "d" || k === "backspace" || k === "delete") mark("delete");
      else if (k === "k" || k === " ") mark("keep");
      else if (k === "arrowright") setI(Math.min(cands.length - 1, i + 1));
      else if (k === "arrowleft") setI(Math.max(0, i - 1));
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cands.length, onMark, onClose]);
  if (!c) return null;
  return (
    <div className="cu-look" role="dialog" aria-label="Last look">
      <div className="cu-look-top">
        <span className="meta">
          {i + 1} of {cands.length.toLocaleString()} · {r?.filename ?? ""} · {bytes(c.bytes)}
        </span>
        <span className="spacer" />
        <button type="button" className="xbtn" onClick={onClose} aria-label="Close">{Icon.x()}</button>
      </div>
      <div className={`cu-look-pic ${c.mark === "delete" ? "del" : ""}`}>
        <Thumb key={c.id} id={c.id} hash={r?.thumbhash ?? null} kind="preview" contain />
        {c.mark === "delete" && <span className="cu-look-flag">Marked to delete</span>}
      </div>
      <div className="cu-look-keys">
        <button type="button" className="btn quiet" onClick={() => setI(Math.max(0, i - 1))} disabled={i === 0}>{Icon.back()}</button>
        <button type="button" className={c.mark === "delete" ? "btn danger-solid" : "btn danger"} onClick={() => (onMark(c.id, "delete"), setI(Math.min(cands.length - 1, i + 1)))}>
          Delete <kbd>D</kbd>
        </button>
        <button type="button" className={c.mark === "keep" ? "btn primary" : "btn quiet"} onClick={() => (onMark(c.id, "keep"), setI(Math.min(cands.length - 1, i + 1)))}>
          Keep <kbd>K</kbd>
        </button>
        <button type="button" className="btn quiet" onClick={() => setI(Math.min(cands.length - 1, i + 1))} disabled={i === cands.length - 1}>{Icon.next()}</button>
      </div>
    </div>
  );
}

/** The one place things get deleted: says exactly what happens, and needs the number typed. */
function ConfirmDelete({ trip, ids, size, onClose, onDone }: { trip: TripCleanup; ids: string[]; size: number; onClose: () => void; onDone: (batch: string) => void }) {
  const count = ids.length;
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = typed.trim() === String(count);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.cleanupDelete(trip.trip, ids);
      toast(
        r.failed.length
          ? `${r.photos.toLocaleString()} photos in the Drive Bin · ${r.failed.length} couldn't go and stay where they are`
          : `${r.photos.toLocaleString()} photos (${bytes(r.bytes)}) in the Google Drive Bin`,
        { error: r.failed.length > 0 },
      );
      onDone(r.batch);
    } catch (e) {
      toast(errorText(e), { error: true });
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Delete ${count.toLocaleString()} photos from ${trip.name}?`}
      onClose={busy ? () => {} : onClose}
      foot={
        <>
          <span className="spacer" />
          <button type="button" className="btn quiet" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn danger-solid" disabled={!ok || busy} onClick={() => void go()}>
            {busy ? "Moving to the Bin…" : `Delete ${count.toLocaleString()} photos`}
          </button>
        </>
      }
    >
      <ul className="cu-steps">
        <li>
          <b>{count.toLocaleString()} photos, {bytes(size)}</b> go to the Google Drive Bin, RAW and JPEG together. Drive keeps them 30 days; <b>Undo</b> is in Clean up › Deleted.
        </li>
        <li>Only photos marked to delete. Selected, Maybe, unreviewed, tagged, edited, posted, album and website photos are never touched.</li>
        <li>Next, the same photos on your iPhone: the app finds them in Photos and Apple asks you before deleting (Recently Deleted keeps them 30 days).</li>
      </ul>
      <label className="st-field" style={{ marginTop: 14 }}>
        <span>Type {count} to confirm</span>
        <input className="st-input" autoFocus inputMode="numeric" value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ok && !busy && void go()} />
      </label>
    </Modal>
  );
}

/** The iPhone part of a clean up: find the photos in Apple Photos, then Apple asks. */
function PhoneStep({ batch, onClose }: { batch: CleanupBatch; onClose: () => void }) {
  const toast = useToast();
  const [found, setFound] = useState<{ asked: number; found: number; denied: boolean } | null>(null);
  const [state, setState] = useState<"finding" | "ready" | "asking" | "deleted" | "cancelled" | "denied">("finding");
  // Looked up once per clean up, however often the screen behind redraws.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    api
      .cleanupPhoneFind(batch.batch)
      .then((f) => {
        setFound(f);
        setState(f.denied ? "denied" : "ready");
      })
      .catch((e) => {
        toast(errorText(e), { error: true });
        close.current();
      });
  }, [batch.batch, toast]);
  const del = () => {
    setState("asking");
    api
      .cleanupPhoneDelete(batch.batch)
      .then((s) => setState(s))
      .catch((e) => {
        toast(errorText(e), { error: true });
        setState("ready");
      });
  };
  const n = found?.found ?? 0;
  return (
    <Modal
      title={`${batch.name}: the iPhone`}
      onClose={state === "asking" ? () => {} : onClose}
      foot={
        <>
          <span className="spacer" />
          {state === "ready" && n > 0 ? (
            <>
              <button type="button" className="btn quiet" onClick={onClose}>Not now</button>
              <button type="button" className="btn danger-solid" onClick={del}>Delete {n.toLocaleString()} from the iPhone…</button>
            </>
          ) : (
            <button type="button" className="btn primary" onClick={onClose} disabled={state === "asking" || state === "finding"}>Done</button>
          )}
        </>
      }
    >
      <p style={{ margin: 0 }}>
        {state === "finding" && "Looking for these photos in Photos…"}
        {state === "ready" &&
          (n > 0
            ? `${n.toLocaleString()} of the ${found!.asked.toLocaleString()} deleted photos are also in Photos (so on your iPhone). Apple will ask you before deleting them, and keeps them in Recently Deleted for 30 days.`
            : "None of these photos are in Photos: nothing to do on the iPhone.")}
        {state === "asking" && "Answer Apple's question…"}
        {state === "deleted" && `Deleted from Photos and your iPhone. They're in Recently Deleted for 30 days.`}
        {state === "cancelled" && "You said no to Apple: the photos stay on the iPhone. You can do it later from Clean up › Deleted."}
        {state === "denied" && "The app isn't allowed to use Photos. Allow it in System Settings › Privacy & Security › Photos, then press iPhone… in Clean up › Deleted."}
      </p>
    </Modal>
  );
}
