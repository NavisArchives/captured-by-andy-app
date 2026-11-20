export function formatDate(captured: string | null | undefined): string {
  if (!captured) return "";
  const d = new Date(captured.length <= 10 ? `${captured}T00:00:00` : captured);
  if (Number.isNaN(d.getTime())) return captured;
  return d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatDay(captured: string | null | undefined): string {
  if (!captured) return "";
  const d = new Date(captured.length <= 10 ? `${captured}T00:00:00` : captured);
  if (Number.isNaN(d.getTime())) return captured;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function today(): string {
  return new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

export function ago(ms: number | null | undefined): string {
  if (!ms) return "never";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86400);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** Sizes as Finder and Google Drive show them (1 GB = 1,000,000,000 bytes). */
export function bytes(n: number): string {
  if (n < 1000) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function n(v: number | null | undefined): string {
  return (v ?? 0).toLocaleString();
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export function compact(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}m`;
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}k`;
  return v.toLocaleString();
}

export const REVIEW_LABEL = { unreviewed: "Unreviewed", selected: "Selected", maybe: "Maybe", rejected: "Rejected" } as const;
export const STORAGE_LABEL = {
  local: "On this Mac",
  cloud_only: "Online only",
  missing: "Missing",
  downloading: "Downloading",
  available_offline: "Offline copy",
} as const;
export const STATUS_LABEL = {
  idea: "Idea",
  building: "Building",
  ready: "Ready",
  scheduled: "Scheduled",
  published: "Published",
  archived: "Archived",
} as const;

/** A video's length: 53 → '0:53', 3725 → '1:02:05'. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "";
  const t = Math.round(seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** "Today, 22:41", "Yesterday, 09:10", "Sat 27 Sep, 09:10". */
export function whenLabel(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86_400_000);
  if (diff === 0) return `Today, ${time}`;
  if (diff === 1) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
}
