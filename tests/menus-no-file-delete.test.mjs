// Amendment 7, C3: no right-click menu can delete an original file. The menus
// may only call these api / studio functions; Clean up's file deletion
// (cleanupDelete, offlineRelease, archivePhotos…) is never among them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = ['src/components/menus.tsx', 'src/components/ContextMenu.tsx'].map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).join('\n');
const ALLOWED = new Set([
  'detail', 'position', 'reveal', 'driveLink', 'getPost', 'updatePost', 'createPost', 'deletePost', 'listPosts', 'postAddPhotos', 'postRemovePhotos',
  'postReorder', 'albumAdd', 'albumRemove', 'createAlbum', 'deleteAlbum', 'photoIds', 'photoLooks', 'applyLook', 'airdrop', 'updateAlbum', 'siteProjects', 'archiveRead', 'saveOriginal',
]);

test('menus call only api functions that never touch files on disk or Drive', () => {
  const used = new Set([...src.matchAll(/\bapi\.([a-zA-Z]+)\(/g)].map((m) => m[1]));
  const extra = [...used].filter((f) => !ALLOWED.has(f));
  assert.deepEqual(extra, [], `unexpected api calls in menus: ${extra.join(', ')}`);
  for (const bad of ['cleanupDelete', 'cleanup_delete', 'offlineRelease', 'archivePhotos', 'moveToTrip', 'renamePhotos', 'trash']) {
    assert.ok(!src.includes(bad), `menus must not reference ${bad}`);
  }
});

test('the strongest picture action is Reject, and Delete only exists for posts, ideas, projects and albums', () => {
  const deletes = [...src.matchAll(/label: [`"]Delete ([^`"]*)/g)].map((m) => m[1]);
  for (const d of deletes) assert.match(d, /^(post|album|\$\{thing\.kind\})/, `unexpected Delete item: ${d}`);
  assert.ok(src.includes('"Reject"') || src.includes('`Reject'), 'pictures offer Reject');
});
