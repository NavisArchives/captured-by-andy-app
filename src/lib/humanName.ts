// Names for people, not file systems (phone layout, NIRMATA spec §4.3).
//   STRASBOURG_2026-10-25_51_ANDY-TALKING-OUTSIDE-GLASS-BUILDING-2.MP4
//     → place "Strasbourg", what "Andy talking outside glass building"
//   DSC07519.JPG → place null, what null (the trip and the date carry the title)

const titleCase = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

/** A folder or place name as people write it: "SRI LANKA" → "Sri Lanka", "pai" → "Pai". */
export function placeName(raw: string): string {
  return raw.replace(/[_-]+/g, " ").trim().split(/\s+/).map(titleCase).join(" ");
}

export function humanName(filename: string): { place: string | null; what: string | null } {
  const stem = filename.replace(/\.[a-z0-9]{2,5}$/i, "");
  const parts = stem.split("_").filter(Boolean);
  // A camera's own name (DSC07519, IMG_1234, C0377, DJI_20261111…) says nothing.
  if (parts.length < 2 || /^(DSC|IMG|DJI|C\d|GOPR|GX|MVI|PXL)/i.test(stem)) return { place: null, what: null };
  const words = (s: string) => s.split("-").filter((w) => w && !/^\d+$/.test(w));
  const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{8}$/.test(s);
  const head = parts[0];
  const place = /^\d/.test(head) || isDate(head) ? null : placeName(head);
  const rest = parts.slice(1).filter((p) => !isDate(p) && !/^\d+$/.test(p));
  const desc = rest.length ? words(rest[rest.length - 1]).join(" ") : "";
  const what = desc ? desc.charAt(0).toUpperCase() + desc.slice(1).toLowerCase() : null;
  return { place, what };
}

/** "Sat 25 Oct" (and the year when it isn't this one). */
export function shortDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}
