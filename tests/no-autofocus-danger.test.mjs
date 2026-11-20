// A destructive button never takes focus by itself: with autoFocus on the red
// « Delete » button, Enter alone confirmed a delete (found 19 Nov). Focus goes
// to Cancel / Keep instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const files = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : n.endsWith(".tsx") ? [p] : [];
});

test("no danger button has autoFocus", () => {
  const found = [];
  for (const f of files("src")) {
    const src = readFileSync(f, "utf8");
    // Each <button …> opening tag, which may span lines.
    for (const m of src.matchAll(/<button\b[^>]*>/gs)) {
      const tag = m[0];
      if (/\bdanger\b/.test(tag) && /\bautoFocus\b/.test(tag)) found.push(`${f}:${src.slice(0, m.index).split("\n").length}`);
    }
  }
  assert.deepEqual(found, []);
});
