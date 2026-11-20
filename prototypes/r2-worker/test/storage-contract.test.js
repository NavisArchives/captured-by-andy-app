import { describe, it, expect } from 'vitest';
import { StorageProvider } from '../src/storage/provider.js';
import { MemoryStorageProvider } from '../src/storage/memory.js';
import { R2StorageProvider } from '../src/storage/r2.js';
import { fakeR2 } from './fake-r2.js';

// Every provider runs the same suite. The app is written against the contract,
// so a backend that drifts from it is a bug even when its own tests pass.
const SIGNING = { accountId: 'acc123', bucketName: 'photos', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' };
const providers = {
  memory: () => new MemoryStorageProvider(),
  r2: () => new R2StorageProvider(fakeR2(), SIGNING),
};

const read = (download) => new Response(download.body).text();

for (const [name, make] of Object.entries(providers)) {
  describe(`${name} provider`, () => {
    it('is a StorageProvider', () => {
      expect(make()).toBeInstanceOf(StorageProvider);
    });

    it('uploads and reports metadata', async () => {
      const s = make();
      const meta = await s.upload('galleries/sofie/01.jpg', 'jpeg-bytes',
        { contentType: 'image/jpeg', customMetadata: { client: 'Sofie' } });
      expect(meta).toMatchObject({ key: 'galleries/sofie/01.jpg', size: 10, contentType: 'image/jpeg',
        customMetadata: { client: 'Sofie' } });
      expect(meta.etag).toBeTruthy();
      expect(new Date(meta.uploadedAt).toISOString()).toBe(meta.uploadedAt);
      expect(await s.getMetadata('galleries/sofie/01.jpg')).toEqual(meta);
    });

    it('defaults contentType to null and customMetadata to {}', async () => {
      const meta = await make().upload('a.bin', new Uint8Array([1, 2, 3]));
      expect(meta).toMatchObject({ size: 3, contentType: null, customMetadata: {} });
    });

    it('downloads the bytes as a stream alongside the metadata', async () => {
      const s = make();
      await s.upload('notes/brief.txt', 'shoot at 9', { contentType: 'text/plain' });
      const d = await s.download('notes/brief.txt');
      expect(d).toMatchObject({ key: 'notes/brief.txt', size: 10, contentType: 'text/plain' });
      expect(d.body).toBeInstanceOf(ReadableStream);
      expect(await read(d)).toBe('shoot at 9');
    });

    it('accepts a ReadableStream as the upload body', async () => {
      const s = make();
      await s.upload('stream.txt', new Response('streamed').body);
      expect(await read(await s.download('stream.txt'))).toBe('streamed');
    });

    it('answers null / false for a missing key instead of throwing', async () => {
      const s = make();
      expect(await s.download('nope.jpg')).toBeNull();
      expect(await s.getMetadata('nope.jpg')).toBeNull();
      expect(await s.exists('nope.jpg')).toBe(false);
    });

    it('overwrites an existing key', async () => {
      const s = make();
      await s.upload('k.txt', 'first');
      await s.upload('k.txt', 'second');
      expect(await read(await s.download('k.txt'))).toBe('second');
      expect((await s.list()).items).toHaveLength(1);
    });

    it('deletes one key, several keys, and missing keys without complaint', async () => {
      const s = make();
      for (const k of ['a', 'b', 'c']) await s.upload(k, k);
      await s.delete('a');
      await s.delete(['b', 'never-existed']);
      await s.delete([]);
      expect(await s.exists('a')).toBe(false);
      expect(await s.exists('b')).toBe(false);
      expect(await s.exists('c')).toBe(true);
    });

    it('lists by prefix in key order', async () => {
      const s = make();
      for (const k of ['g/b.jpg', 'g/a.jpg', 'other/x.jpg', 'g/sub/c.jpg']) await s.upload(k, 'x');
      const { items, cursor } = await s.list({ prefix: 'g/' });
      expect(items.map((i) => i.key)).toEqual(['g/a.jpg', 'g/b.jpg', 'g/sub/c.jpg']);
      expect(cursor).toBeNull();
    });

    it('pages through a listing with limit and cursor, visiting each key once', async () => {
      const s = make();
      const keys = ['p/1', 'p/2', 'p/3', 'p/4', 'p/5'];
      for (const k of keys) await s.upload(k, 'x');
      const seen = [];
      const sizes = [];
      let cursor;
      do {
        const page = await s.list({ prefix: 'p/', limit: 2, cursor });
        sizes.push(page.items.length);
        seen.push(...page.items.map((i) => i.key));
        cursor = page.cursor;
      } while (cursor);
      expect(sizes).toEqual([2, 2, 1]);
      expect(seen).toEqual(keys);
    });

    it('rejects keys that are empty, absolute, or climb out of their folder', async () => {
      const s = make();
      for (const bad of ['', '/abs.jpg', 'a/../b.jpg', '..', 'a//b.jpg', 'a/./b.jpg', 42]) {
        await expect(s.upload(bad, 'x'), `key ${JSON.stringify(bad)}`).rejects.toThrow(/key/i);
      }
      await expect(s.exists('../x')).rejects.toThrow(/key/i);
    });

    it('validates signed URL options', async () => {
      const s = make();
      await expect(s.getSignedUrl('a.jpg', { expiresIn: 0 })).rejects.toThrow(/expiresIn/);
      await expect(s.getSignedUrl('a.jpg', { expiresIn: 604801 })).rejects.toThrow(/expiresIn/);
      await expect(s.getSignedUrl('a.jpg', { expiresIn: 1.5 })).rejects.toThrow(/expiresIn/);
      await expect(s.getSignedUrl('a.jpg', { method: 'POST' })).rejects.toThrow(/method/);
    });

    it('returns a signed URL for GET and for PUT', async () => {
      const s = make();
      const get = await s.getSignedUrl('galleries/sofie/01.jpg');
      const put = await s.getSignedUrl('galleries/sofie/01.jpg', { method: 'PUT', expiresIn: 60 });
      expect(() => new URL(get)).not.toThrow();
      expect(put).not.toBe(get);
    });
  });
}
