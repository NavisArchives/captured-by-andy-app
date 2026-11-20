import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PHOTO_SIZE_STEPS, normalizePhotoPixels, photoPixels, photoSizeUrl } from '../src/lib/photoSize.ts';

test('photo size follows CSS width times DPR 1, 2 and 3', () => {
  assert.deepEqual([1, 2, 3].map(dpr => photoPixels(390, dpr)), [480, 960, 1280]);
  assert.equal(photoPixels((390 - 32 - 8) / 3, 3), 480);
  assert.equal(photoPixels(900, 2), 2560);
});
test('sizes round up and clamp, including invalid measurement fallbacks', () => {
  assert.equal(normalizePhotoPixels(640), 640);
  assert.equal(normalizePhotoPixels(640.1), 960);
  assert.equal(photoPixels(0, 3), 160);
  assert.equal(photoPixels(-50, 2), 160);
  assert.equal(photoPixels(10000, 3), 2560);
  assert.equal(photoPixels(Infinity, 3), 2560);
  assert.equal(photoPixels(NaN, 3), 480);
  for (const dpr of [0, -1, NaN, Infinity]) assert.equal(photoPixels(390, dpr), 480);
});
test('helper generates an encoded size route without browser globals', () => {
  assert.equal(photoSizeUrl('photo-id', 390, 3), '/drive/px/1280/photo-id');
  assert.equal(photoSizeUrl('id with /?', 390, 1), '/drive/px/480/id%20with%20%2F%3F');
  assert.equal(photoPixels(390), 480);
  assert.throws(() => photoSizeUrl('', 390, 3), /file id/);
});

function worker() {
  const handlers = new Map(), entries = new Map(), fetched = [];
  class WorkerRequest extends Request {
    constructor(input, init) { super(typeof input === 'string' ? new URL(input, 'https://studio.test') : input, init); }
  }
  const context = vm.createContext({
    self: { addEventListener: (name, cb) => handlers.set(name, cb), location: { origin: 'https://studio.test' } },
    Request: WorkerRequest, Response, URL, Headers, Map, Date, setTimeout, clearTimeout, ReadableStream,
    caches: { open: async () => ({ match: async key => entries.get(key.url)?.clone(), put: async (key, value) => entries.set(key.url, value.clone()), keys: async () => [...entries.keys()].map(u => new WorkerRequest(u)), delete: async key => entries.delete(key.url) }) },
    fetch: async url => { fetched.push(String(url)); return new Response('thumbnail', { status: 200 }); },
  });
  vm.runInContext(readFileSync(new URL('../web-public/sw.js', import.meta.url), 'utf8'), context);
  vm.runInContext(`thumbnailLink = async () => ({ link: 'https://example.test/image=s220', mime: 'image/jpeg' }); getToken = async () => null;`, context);
  return {
    context, fetched, entries,
    sizes: vm.runInContext('Array.from(PHOTO_SIZE_STEPS)', context),
    request: async path => { let result; handlers.get('fetch')({ request: new WorkerRequest(path), respondWith: value => { result = value; } }); return await result; },
  };
}
test('worker and helper share bounded sizes, round aliases to one cache key', async () => {
  const w = worker();
  assert.deepEqual(Array.from(w.sizes), [...PHOTO_SIZE_STEPS]);
  assert.equal((await w.request('/drive/px/1170/p1')).status, 200);
  assert.equal((await w.request('/drive/px/1200/p1')).status, 200);
  assert.equal(w.fetched.length, 1);
  assert.match(w.fetched[0], /=s1280$/);
  assert.equal(w.entries.size, 1);
  for (const [n, px] of [[0, 160], [-1, 160], [100000, 2560], [640.1, 960]]) {
    await w.request(`/drive/px/${n}/p${n}`);
    assert.match(w.fetched.at(-1), new RegExp(`=s${px}$`));
  }
});
test('legacy thumb, preview and full routes keep their sizes', async () => {
  const w = worker();
  for (const [kind, px] of [['thumb', 480], ['preview', 1600], ['full', 2560]]) {
    assert.equal((await w.request(`/drive/${kind}/p1`)).status, 200);
    assert.match(w.fetched.at(-1), new RegExp(`=s${px}$`));
  }
});
test('invalid size routes fail locally, and size routes never fetch originals', async () => {
  const w = worker();
  for (const path of ['/drive/px/nope/p1', '/drive/px/1280/', '/drive/px/1280/p1/extra', '/drive/px/Infinity/p1']) assert.equal((await w.request(path)).status, 404);
  assert.equal(w.fetched.length, 0);
  vm.runInContext(`thumbnailLink = async () => ({ link: null, mime: 'image/jpeg' }); google = async () => new Response('original');`, w.context);
  assert.equal((await w.request('/drive/px/1280/missing')).status, 404);
  assert.equal(await (await w.request('/drive/preview/missing')).text(), 'original', 'legacy fallback remains unchanged');
});
test('« Save to Files » streams the whole file with an attachment name, never buffering it (9c)', async () => {
  const w = worker();
  let asked = null;
  w.context.__body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } });
  vm.runInContext(`google = async (url) => { globalThis.__asked = String(url); return new Response(globalThis.__body, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '3' } }); };`, w.context);
  const res = await w.request('/drive/download/file42?name=DJI_0094%20%22x%22.MP4');
  asked = vm.runInContext('globalThis.__asked', w.context);
  assert.equal(res.status, 200);
  assert.match(asked, /files\/file42\?alt=media/);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="DJI_0094 _x_.MP4"', 'quotes in the name cannot break the header');
  assert.equal(res.headers.get('content-length'), '3');
  assert.ok(res.body, 'the body is a stream passed through, not a buffered blob');
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3]);
});
