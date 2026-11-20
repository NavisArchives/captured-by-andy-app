# Desktop sync: integrity fixes

This script exchanges library metadata and Studio planning data with Supabase.
Running `sync.py` accesses the configured production database and cloud account.
The regression tests below do neither.

## Review scope

This batch fixes two behaviors without a schema migration or a dependency change:

- A photo payload's `updated_ms` now includes its primary asset and analysis
  timestamps. Previously an asset-only rename/move/missing-state update or a
  new analysis could be uploaded with an old photo timestamp, making the browser's
  incremental fetch skip it. The photo's local timestamp and review timestamp
  are not changed by this fix.
- Album and Studio record deletions now use the same strict newer-change rule
  as their updates. A web deletion only removes a local record whose
  `updated_ms` is older than the tombstone's `web_ms`. Equal timestamps retain
  the local record, matching existing update conflict behavior. Studio deletion
  counts now report actual deleted rows, including on replay.

The existing push phase sends surviving, newer local edits back to Supabase.
This is still timestamp-based conflict resolution, not a transactional,
multi-device change log.

## Offline verification

From the repository root:

```sh
python3 -B -m unittest discover -s tools/supabase-sync -p 'test_*.py'
```

The tests load all repository SQLite migrations into an in-memory database and
use a fake cloud transport. Drive ID lookup is mocked. They cover asset-only
and analysis-only browser delta visibility, unchanged-photo filtering, and
older/equal/newer deletion conflicts with replay.

## Deliberately remaining work

- This patch does not backfill previously missed browser changes. An existing
  browser cache can still contain stale rows until refreshed by a later change
  or a separately planned resynchronization.
- Membership and link conflicts, album ordering, deleted-photo propagation,
  and tag removal reconciliation remain separate issues.
- Incoming review side effects and browser outbox durability are unchanged.
- This does not enable foreign keys in the sync writer; doing so requires
  validating dependency ordering and existing orphan records first.
- No live synchronization, original media operations, UI, shortcuts, service
  deployment, or authentication settings are changed by this batch.

For integration, review the diff against the base commit, run the offline tests,
and test any live sync only against disposable library/cloud fixtures first.

## Recovery follow-up

Pull checkpoints are now separate for photos, albums, memberships, Studio rows,
and links. Legacy shared checkpoints replay each stream once from zero; the
existing timestamp guards make record updates replayable. Boundary timestamps
are included on subsequent pulls, with stable key ordering. This does not
provide a server snapshot if rows change during offset pagination.

Checkpoint replacement is atomic. Incoming plan files must be Markdown directly
inside a registered piece's `00_PLAN`, or the configured Studio `_CARDS`.
Traversal, file symlinks and unrelated folders are rejected; complete writes
replace the old file atomically and preserve the remote modification time.
Filesystem and database changes still do not form one atomic transaction.
