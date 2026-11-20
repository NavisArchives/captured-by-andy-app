// "Find places…": a trip's loose photos grouped by where they were taken,
// named on this Mac, ready to become place folders (THAILAND › PAI). Nothing
// moves until "Make places"; Undo puts every file back.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "../api";
import { plural } from "../lib/format";
import { useStore } from "../store";
import type { PlaceProposal } from "../types";
import { Thumb } from "./Thumb";
import { Modal, Switch, useToast } from "./ui";
import "../styles/places.css";

type Pick = { on: boolean; name: string };

export function PlacesSheet({ trip, onClose }: { trip: string; onClose: () => void }) {
  const toast = useToast();
  const { bump } = useStore();
  const tripName = trip.split("/").pop() ?? trip;
  const [p, setP] = useState<PlaceProposal | null>(null);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [busy, setBusy] = useState(false);
  // Found once per trip, however often the screen behind redraws.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    let live = true;
    api
      .tripPlaces(trip)
      .then((r) => {
        if (!live) return;
        setP(r);
        // A place in another country than the trip's is probably misplaced: off to start with.
        setPicks(Object.fromEntries(r.places.map((pl) => [pl.key, { on: !!pl.name && (!pl.country || !r.country || pl.country === r.country), name: pl.name }])));
      })
      .catch((e) => {
        toast(errorText(e), { error: true });
        close.current();
      });
    return () => {
      live = false;
    };
  }, [trip, toast]);

  const chosen = useMemo(() => (p?.places ?? []).filter((pl) => picks[pl.key]?.on && picks[pl.key].name.trim()), [p, picks]);
  const moving = chosen.reduce((n, pl) => n + pl.photos, 0);
  const set = (key: string, patch: Partial<Pick>) => setPicks((x) => ({ ...x, [key]: { ...x[key], ...patch } }));

  const make = async () => {
    setBusy(true);
    try {
      const r = await api.makePlaces(trip, chosen.map((pl) => ({ key: pl.key, name: picks[pl.key].name.trim() })));
      bump();
      onClose();
      if (r.failed.length) toast(`${plural(r.failed.length, "photo")} couldn't move: ${r.failed[0]}`, { error: true });
      toast(`${plural(r.moved, "photo")} sorted into ${plural(chosen.length, "place")} in ${tripName}`, {
        action: {
          label: "Undo",
          run: async () => {
            try {
              await api.undoTripMove(r.undo);
              toast(`Put back in ${tripName}`);
            } catch (e) {
              toast(errorText(e), { error: true });
            }
            bump();
          },
        },
      });
    } catch (e) {
      toast(errorText(e), { error: true });
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title={`Places in ${tripName}`}
      onClose={busy ? () => {} : onClose}
      foot={
        p && (
          <>
            <span className="meta" style={{ flex: 1 }}>
              {p.places.length > 0 && `${plural(p.elsewhere, "photo")} stay in ${tripName}: too few in one place, or nothing to go by.`}
            </span>
            <button type="button" className="btn quiet" onClick={onClose} disabled={busy}>Cancel</button>
            {p.places.length > 0 && (
              <button type="button" className="btn primary" disabled={!chosen.length || busy} onClick={() => void make()}>
                {busy ? "Moving…" : `Make ${plural(chosen.length, "place")} · ${moving.toLocaleString()} photos`}
              </button>
            )}
          </>
        )
      }
    >
      {!p ? (
        <div className="places-wait">
          <span className="spinner" aria-hidden="true" />
          <p className="meta" style={{ margin: 0 }}>Grouping {tripName} by where each photo was taken, and naming the places on this Mac…</p>
        </div>
      ) : p.places.length === 0 ? (
        <p className="meta" style={{ margin: 0 }}>
          No places to make: {p.looseLocated < 20 ? `only ${plural(p.looseLocated, "loose photo")} here know where they were taken.` : `no group of ${tripName}'s loose photos is big enough (20 or more in one place).`}
        </p>
      ) : (
        <>
          <p className="meta" style={{ margin: "0 0 12px" }}>
            {p.loose.toLocaleString()} loose photos in {tripName}, {p.looseLocated.toLocaleString()} with a location. Photos without one go with the nearest photo taken within 12 hours. IPHONE folders are kept inside each place.
          </p>
          <div className="places-list">
            {p.places.map((pl) => {
              const pick = picks[pl.key] ?? { on: false, name: "" };
              const foreign = !!pl.country && !!p.country && pl.country !== p.country;
              return (
                <div key={pl.key} className={pick.on ? "place-row" : "place-row off"}>
                  <div className="place-strip" aria-hidden="true">
                    {pl.sample.slice(0, 4).map((id) => (
                      <Thumb key={id} id={id} hash={null} />
                    ))}
                  </div>
                  <div className="place-main">
                    <input
                      className="place-name"
                      value={pick.name}
                      placeholder="Name this place"
                      aria-label="Place name"
                      onChange={(e) => set(pl.key, { name: e.target.value.toUpperCase() })}
                    />
                    <span className="meta">
                      {pl.photos.toLocaleString()} photos
                      {pl.photos > pl.located && ` (${(pl.photos - pl.located).toLocaleString()} by time)`}
                      {pl.country && ` · ${pl.country}`}
                      {pl.existing && " · the trip already has this folder"}
                    </span>
                    {foreign && <span className="place-warn">Not in {p.country}: probably misplaced. Move these to the right trip instead.</span>}
                  </div>
                  <Switch checked={pick.on} onChange={(v) => set(pl.key, { on: v })} label={`Make ${pick.name || "this place"}`} />
                </div>
              );
            })}
          </div>
        </>
      )}
    </Modal>
  );
}
