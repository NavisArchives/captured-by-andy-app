import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingPhotos, pendingRest } from '../src/web/pending.ts';

const rest = () => ({ albums: [], albumPhotos: [], tags: [], photoTags: [], studio: [], links: [] });
test('review intent survives stale reload and later marks win without mutating cache', () => {
  const photos = [{ id: 'p', review: 'unreviewed', reviewed_ms: null, updated_ms: 10 }];
  const result = pendingPhotos(photos, [
    { k: 'review', ids: ['p'], review: 'selected', ms: 20 },
    { k: 'review', ids: ['p'], review: 'rejected', ms: 30 },
  ]);
  assert.equal(result[0].review, 'rejected');
  assert.equal(result[0].reviewed_ms, 30);
  assert.equal(result[0].updated_ms, 10, 'remote cursor is not advanced by local intent');
  assert.equal(photos[0].review, 'unreviewed');
});
test('pending albums, membership, Studio text and tombstones replay in order', () => {
  const source = rest();
  source.albums = [{ id: 'a', name: 'Server name', updated_ms: 10 }];
  const changes = [
    { k: 'upsert', table: 'albums', on: 'id', rows: [{ id: 'a', name: 'My name', web_ms: 20 }] },
    { k: 'upsert', table: 'album_photos', on: 'album_id,photo_id', rows: [{ album_id: 'a', photo_id: 'p', position: 2, deleted: false }] },
    { k: 'upsert', table: 'album_photos', on: 'album_id,photo_id', rows: [{ album_id: 'a', photo_id: 'p', deleted: true }] },
    { k: 'upsert', table: 'studio_rows', on: 'list,id', rows: [{ list: 'ideas', id: 'i', data: { title: 'My idea' } }] },
    { k: 'upsert', table: 'studio_links', on: 'kind,a,b', rows: [{ kind: 'saveIdea', a: 's', b: 'i', deleted: false }] },
  ];
  const result = pendingRest(source, changes);
  assert.equal(result.albums[0].name, 'My name');
  assert.equal(result.albums[0].updated_ms, 10);
  assert.equal(result.albumPhotos.length, 1);
  assert.equal(result.albumPhotos[0].deleted, true);
  assert.equal(result.albumPhotos[0].position, 2);
  assert.equal(result.studio[0].data.title, 'My idea');
  assert.equal(result.links[0].b, 'i');
  assert.equal(source.albums[0].name, 'Server name');
  assert.equal(source.albumPhotos.length, 0);
  assert.deepEqual(pendingRest(result, changes), result, 'replay is idempotent');
});
