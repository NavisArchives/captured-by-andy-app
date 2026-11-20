import test from 'node:test';
import assert from 'node:assert/strict';
import { saveCull, saveCullPosition, readCull, forgetCull } from '../src/lib/cullResume.ts';
const memory = () => { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) }; };
test('resume preserves frozen order and query while saving cursor separately', () => {
  const store = memory();
  saveCull(['a','b','c'], { review: 'unreviewed', order: 'oldest' }, 100, store);
  saveCullPosition(2, 100, store);
  assert.deepEqual(readCull(store), { ids: ['a','b','c'], query: { review: 'unreviewed', order: 'oldest' }, start: 2, savedAt: 100 });
  saveCull(['d'], {}, 200, store);
  assert.equal(readCull(store).start, 0, 'old cursor cannot move a new session');
  forgetCull(store);
  assert.equal(readCull(store), null);
});
test('corrupted storage and storage limits do not crash culling', () => {
  assert.equal(readCull({ getItem: () => '{bad' }), null);
  assert.equal(readCull({ getItem: () => JSON.stringify({ ids: [3], query: {}, savedAt: 1 }) }), null);
  assert.equal(saveCull(['a'], {}, 1, { setItem: () => { throw new Error('Full'); } }), false);
});
