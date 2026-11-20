// React needs the same hooks on every render (Rules of Hooks). A hook called
// after an early `return` crashes the screen with React error #310, as the
// post page did after PR #11. This scans every component and custom hook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const files = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [];
});
const START = /^(export )?(default )?(const|function) ([A-Z]\w*|use[A-Z]\w*)\b|^export const \w+ = memo\(function /;
const EARLY = /^  (if \(.*\) )?return\b/;
const HOOK = /\buse[A-Z]\w*\(/;

export function hooksAfterReturn(src) {
  const out = [];
  let inFn = false, ret = 0;
  src.split("\n").forEach((l, k) => {
    const i = k + 1;
    if (START.test(l)) { inFn = true; ret = 0; return; }
    if (/^\}/.test(l)) { inFn = false; ret = 0; return; }
    if (!inFn || l.trim().startsWith("//")) return;
    // A hook inside the return statement itself runs on every render.
    if (ret && HOOK.test(l) && /^  (const|let|use|\w+\.)/.test(l) && !EARLY.test(l)) out.push(i);
    if (EARLY.test(l) && !/^  return[ (]/.test(l)) ret ||= i;
  });
  return out;
}

test("the scan catches a hook after an early return", () => {
  const bad = "export function Page() {\n  const a = useState(0);\n  if (!a) return null;\n  const b = useRef(null);\n  return b;\n}\n";
  assert.deepEqual(hooksAfterReturn(bad), [4]);
  const ok = "export function useList() {\n  const a = useState(0);\n  return [a, useCallback(() => 1, [])];\n}\n";
  assert.deepEqual(hooksAfterReturn(ok), []);
});

test("no component calls a hook after an early return", () => {
  const found = files("src").flatMap((f) => hooksAfterReturn(readFileSync(f, "utf8")).map((n) => `${f}:${n}`));
  assert.deepEqual(found, []);
});
