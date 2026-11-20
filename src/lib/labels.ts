// What the recogniser found in photos (`blue_sky`, `people`), and the tags
// to suggest for what someone is typing: by how the words start, then
// anywhere in them, then everyday words ("portrait" → people), then close
// spellings ("portait").
import type { LabelList } from "../types";

/** `blue_sky` → "blue sky". */
export const labelText = (label: string) => label.replace(/_/g, " ");

export interface Suggestion {
  label: string;
  count: number;
  /** The everyday word or spelling it was found through, if not its own name. */
  via?: string;
}

/** Edit distance, a swap of two letters counting as one. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** A typo of `word`, or of how it starts. */
function close(q: string, word: string): boolean {
  if (q.length < 4) return false;
  const allowed = q.length >= 6 ? 2 : 1;
  if (distance(q, word) <= allowed) return true;
  // Still typing: "portai" is how "portrait" starts, give or take a letter.
  return word.length > q.length && distance(q, word.slice(0, q.length)) <= 1;
}

export function suggest(typed: string, list: LabelList, picked: string[], max = 8): Suggestion[] {
  const q = typed.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return [];
  const counts = new Map(list.labels.map((l) => [l.label, l.count]));
  const best = new Map<string, { rank: number; via?: string }>();
  const offer = (label: string, rank: number, via?: string) => {
    if (picked.includes(label) || !counts.has(label)) return;
    const was = best.get(label);
    if (!was || rank < was.rank) best.set(label, { rank, via });
  };
  for (const { label } of list.labels) {
    const text = labelText(label);
    const words = text.split(" ");
    if (text === q) offer(label, 0);
    else if (text.startsWith(q)) offer(label, 1);
    else if (words.some((w) => w.startsWith(q))) offer(label, 2);
    else if (text.includes(q)) offer(label, 3);
    else if (words.some((w) => close(q, w))) offer(label, 5);
  }
  for (const [word, labels] of list.synonyms) {
    const rank = word === q || word.startsWith(q) ? 4 : close(q, word) ? 5 : null;
    if (rank != null) labels.forEach((l) => offer(l, rank, word));
  }
  // Close spellings only when the word itself found little ("boat" isn't "goat").
  const sure = [...best.values()].filter((b) => b.rank < 5).length;
  return [...best.entries()]
    .filter(([, b]) => b.rank < 5 || sure < 3)
    .sort(([a, x], [b, y]) => x.rank - y.rank || (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b))
    .slice(0, max)
    .map(([label, { via }]) => ({ label, count: counts.get(label) ?? 0, via }));
}
