// Posting slots: the next free days for an account, spaced by its cadence.
// Stamps are local wall-clock 'YYYY-MM-DDTHH:MM' (what datetime-local inputs
// and the core use), so day maths never goes through UTC.
import { api } from "../api";
import type { Post } from "../types";

export const CADENCE_KEY = "posts.cadenceDays";
export const DEFAULT_CADENCE = 2;
export const CADENCES: { days: number; label: string }[] = [
  { days: 1, label: "Every day" },
  { days: 2, label: "Every 2 days" },
  { days: 3, label: "Every 3 days" },
  { days: 7, label: "Weekly" },
];

const pad = (n: number) => String(n).padStart(2, "0");

/** 'YYYY-MM-DDTHH:MM' in local time. Never toISOString: that is UTC. */
export function localStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Posting cadence in days, from Settings (default every 2 days). */
export async function loadCadence(): Promise<number> {
  const v = Number(await api.getSetting(CADENCE_KEY).catch(() => null));
  return Number.isFinite(v) && v >= 1 ? Math.round(v) : DEFAULT_CADENCE;
}

/**
 * The next `count` free posting slots for an account. Days already taken are
 * those of scheduled and published posts (except `excludeId`, the post being
 * planned). A day is free when no taken day lies closer than the cadence, so
 * the gaps before a post planned far ahead are filled first. Slots start no
 * earlier than one cadence after the last post that went out, at its time of
 * day (19:00 when there is none), and never in the past.
 */
export function nextFreeSlots(posts: Post[], count: number, cadenceDays: number, excludeId?: string, now = new Date()): string[] {
  const cadence = Math.max(1, Math.round(cadenceDays) || DEFAULT_CADENCE);
  const dated = posts
    .filter((p) => p.id !== excludeId)
    .map((p) => ({ status: p.status, at: p.status === "scheduled" ? p.scheduledAt : p.status === "published" ? p.publishedAt : null }))
    .filter((d): d is { status: Post["status"]; at: string } => !!d.at && /^\d{4}-\d{2}-\d{2}/.test(d.at))
    .map((d) => ({ status: d.status, at: d.at.slice(0, 16) }));
  const latestOf = (list: string[]) => list.reduce<string | null>((a, s) => (a == null || s > a ? s : a), null);
  const lastOut = latestOf(dated.filter((d) => d.status === "published").map((d) => d.at));
  const timeFrom = lastOut ?? latestOf(dated.map((d) => d.at));
  const time = timeFrom && /T\d{2}:\d{2}/.test(timeFrom) ? timeFrom.slice(11, 16) : "19:00";
  const [hh, mm] = time.split(":").map(Number);

  // Whole days, so spacing is counted in calendar days whatever the clock says.
  const dayNo = (s: string) => {
    const [y, m, d] = s.slice(0, 10).split("-").map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
  };
  const taken = dated.map((d) => dayNo(d.at));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm);
  // Today only while that time is still ahead.
  let at = today > now ? today : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hh, mm);
  if (lastOut) {
    const [y, m, d] = lastOut.slice(0, 10).split("-").map(Number);
    const after = new Date(y, m - 1, d + cadence, hh, mm);
    if (after > at) at = after;
  }

  const shift = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, hh, mm);
  const free = (d: Date) => {
    const n = dayNo(localStamp(d));
    return taken.every((t) => Math.abs(t - n) >= cadence);
  };
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    // A few years ahead at most, so nothing can loop forever.
    for (let guard = 0; guard < 1100 && !free(at); guard++) at = shift(at, 1);
    const stamp = localStamp(at);
    out.push(stamp);
    taken.push(dayNo(stamp));
    at = shift(at, cadence);
  }
  return out;
}
