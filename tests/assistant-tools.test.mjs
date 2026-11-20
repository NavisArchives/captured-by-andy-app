// Amendment 8b, D2: the assistant's tools can only find, narrow, list and
// propose. No tool deletes, rejects, publishes, exports, sends or writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/components/Assistant.tsx', import.meta.url), 'utf8');
const spec = readFileSync(new URL('../src/components/assistantTools.ts', import.meta.url), 'utf8');
const block = spec.slice(spec.indexOf('export const TOOLS'), spec.indexOf('] as const;'));
const names = [...block.matchAll(/name: "([a-z_]+)"/g)].map((m) => m[1]);

test('the tool list is exactly the read-only set', () => {
  assert.deepEqual(names, ['find_pictures', 'select_pictures', 'list_trips', 'list_albums', 'list_projects', 'propose']);
  for (const n of names) assert.doesNotMatch(n, /delete|remove|reject|publish|export|send|airdrop|create|write|save|update|mark/);
});

test('the tool runner calls only read-only commands', () => {
  const runner = src.slice(src.indexOf('const run = async'), src.indexOf('const ask = async'));
  const calls = [...runner.matchAll(/\b(?:api|studio)\.([a-zA-Z]+)\(/g)].map((m) => m[1]);
  const writes = calls.filter((c) => /create|delete|remove|save|update|set|link|mark|apply|export|airdrop|reveal/i.test(c));
  assert.deepEqual(writes, [], `writes inside the tool runner: ${writes}`);
});

test('the Rust side fixes the model and refuses images (see assistant_cmd.rs tests)', () => {
  const rs = readFileSync(new URL('../src-tauri/src/assistant_cmd.rs', import.meta.url), 'utf8');
  assert.match(rs, /pub const MODEL: &str = "claude-haiku-5-5";/);
  assert.match(rs, /"image" \| "document"/);
  assert.match(rs, /"-K", "-"/);
});
