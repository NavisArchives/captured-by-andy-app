import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as replay from '../src/web/pending.ts';

function browser() {
  const storage = new Map();
  let reachable = false;
  let signedOut = 0;
  const cloud = {
    from: () => ({ update: () => ({ in: async () => ({ error: reachable ? null : new Error('Offline') }) }) }),
    auth: { signOut: async () => { signedOut++; return { error: null }; } },
  };
  const source = readFileSync(new URL('../src/web/remote.ts', import.meta.url), 'utf8').replaceAll('import.meta.env', '({})');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  const localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) };
  const context = { exports, require: name => name === './pending' ? replay : { createClient: () => cloud }, localStorage,
    sessionStorage: localStorage, indexedDB: { open: () => { throw new Error('No cache'); }, deleteDatabase: () => {} },
    window: { addEventListener: () => {}, setTimeout: () => 1 }, location: { reload: () => {} }, console };
  vm.runInNewContext(code, context);
  return { api: exports, storage, online: () => { reachable = true; }, signedOut: () => signedOut };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('offline queue is durable, reports failure, blocks sign-out, then drains on retry', async () => {
  const b = browser();
  const statuses = [];
  b.api.onSyncStatus(s => statuses.push(s));
  b.api.send({ k: 'review', ids: ['p'], review: 'selected', ms: 20 });
  await settle();
  assert.equal(b.api.pending(), 1);
  assert.equal(JSON.parse(b.storage.get('outbox'))[0].review, 'selected');
  assert.equal(statuses.at(-1).problem, 'Offline');
  await assert.rejects(b.api.signOut(), /still waiting to sync/);
  assert.equal(b.signedOut(), 0);
  assert.equal(b.api.pending(), 1);
  b.online();
  await b.api.flush();
  assert.equal(b.api.pending(), 0);
  assert.equal(statuses.at(-1).problem, null);
  assert.ok(statuses.at(-1).lastSuccess);
  await b.api.signOut();
  assert.equal(b.signedOut(), 1);
});
