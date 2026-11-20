import test from 'node:test';
import assert from 'node:assert/strict';
import { momentManifest } from '../src/lib/momentManifest.ts';
test('editor notes preserve identities and precise source-relative ranges in order', () => {
  const clips = [{ id: 'photo', filename: 'A|B\n.mov', moments: [
    { id: 'late', start: 12.125, end: 13.5 }, { id: 'early', start: 1, end: 2 }, { id: 'bad', start: 0, end: Infinity },
  ] }];
  const text = momentManifest('Film\nTitle', clips);
  assert.ok(text.includes('| A B .mov | photo | late | 12.125 | 13.500 | 1.375 |'));
  assert.ok(text.indexOf('| early |') < text.indexOf('| late |'));
  assert.ok(!text.includes('| bad |'));
  assert.equal(clips[0].moments[0].id, 'late', 'export does not reorder stored moments');
});
