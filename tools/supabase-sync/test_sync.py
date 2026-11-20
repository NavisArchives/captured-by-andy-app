"""Offline sync regressions: real SQLite migrations, no account or media access.

Run: python3 -B -m unittest discover -s tools/supabase-sync -p 'test_*.py'
"""
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("cba_sync", Path(__file__).with_name("sync.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class Cloud:
    def __init__(self, changes=None):
        self.changes = changes or {}
        self.sent = []

    def changed(self, table, since, select="*"):
        return [r for r in self.changes.get(table, []) if r["web_ms"] > since]

    def upsert(self, table, rows, on=None):
        self.sent.extend((table, dict(row)) for row in rows)


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        for migration in sorted((ROOT / "src-tauri/src/library/migrations").glob("*.sql")):
            self.db.executescript(migration.read_text())

    def photo(self, asset_ms=100, photo_ms=100):
        self.db.execute("INSERT INTO sources (id,path,label,created_ms) VALUES ('s','/library','Camera',1)")
        self.db.execute("""INSERT INTO photos
            (id,media_kind,captured_at,captured_at_source,created_ms,updated_ms)
            VALUES ('p','image','2026-11-18','file',1,?)""", (photo_ms,))
        self.db.execute("""INSERT INTO assets
            (id,photo_id,source_id,path,dir,stem,filename,format,is_raw,is_primary,
             size,mtime_ms,storage_state,last_seen_scan,created_ms,updated_ms)
            VALUES ('a','p','s','/library/Trip/new.jpg','/library/Trip','new',
                    'new.jpg','jpeg',0,1,1000,1,'local',1,1,?)""", (asset_ms,))

    def test_asset_change_reaches_browser_delta_without_changing_review_time(self):
        self.photo(asset_ms=300)
        cloud = Cloud()
        with patch.object(sync, "drive_id", return_value="drive-id"):
            self.assertEqual(sync.push_photos(cloud, self.db, 200), 1)
        payload = cloud.sent[0][1]
        self.assertGreater(payload["updated_ms"], 200)
        self.assertEqual(payload["filename"], "new.jpg")
        self.assertIsNone(payload["reviewed_ms"])
        self.assertEqual(self.db.execute("SELECT updated_ms FROM photos").fetchone()[0], 100)

    def test_analysis_change_reaches_browser_delta(self):
        self.photo()
        self.db.execute("""INSERT INTO photo_analysis
            (photo_id,sharpness,brightness,clip_hi,clip_lo,p01,p50,p99,mean_r,mean_g,mean_b,analysed_ms)
            VALUES ('p',2,0.5,0,0,0,0.5,1,0.5,0.5,0.5,400)""")
        cloud = Cloud()
        with patch.object(sync, "drive_id", return_value=None):
            self.assertEqual(sync.push_photos(cloud, self.db, 200), 1)
        self.assertEqual(cloud.sent[0][1]["updated_ms"], 400)
        self.assertTrue(cloud.sent[0][1]["soft"])

    def test_unchanged_photo_is_not_pushed(self):
        self.photo()
        self.assertEqual(sync.push_photos(Cloud(), self.db, 100), 0)

    def test_album_deletion_respects_newer_or_equal_local_edit_and_replays(self):
        for local_ms in (199, 200, 201):
            with self.subTest(local_ms=local_ms):
                self.db.execute("DELETE FROM albums")
                self.db.execute("INSERT INTO albums (id,name,created_ms,updated_ms) VALUES ('album','Local',1,?)", (local_ms,))
                cloud = Cloud({"albums": [{"id": "album", "deleted": True, "web_ms": 200}]})
                for _ in range(2):
                    _, cursor = sync.pull_albums(cloud, self.db, 0)
                    self.assertEqual(cursor, 200)
                    exists = self.db.execute("SELECT 1 FROM albums WHERE id='album'").fetchone()
                    self.assertEqual(exists is not None, local_ms >= 200)

    def test_studio_deletion_respects_newer_or_equal_local_edit_and_replays(self):
        for local_ms in (199, 200, 201):
            with self.subTest(local_ms=local_ms):
                self.db.execute("DELETE FROM studio_ideas")
                self.db.execute("INSERT INTO studio_ideas (id,title,created_ms,updated_ms,touched_ms) VALUES ('idea','Local',1,?,1)", (local_ms,))
                cloud = Cloud({"studio_rows": [{"list": "ideas", "id": "idea", "deleted": True, "web_ms": 200}]})
                for attempt in range(2):
                    count, cursor = sync.pull_studio(cloud, self.db, 0)
                    self.assertEqual(cursor, 200)
                    self.assertEqual(count, int(local_ms < 200 and attempt == 0))
                    exists = self.db.execute("SELECT 1 FROM studio_ideas WHERE id='idea'").fetchone()
                    self.assertEqual(exists is not None, local_ms >= 200)

    def test_stream_cursors_do_not_skip_slower_tables(self):
        cloud = Cloud({"photos": [{"web_ms": 900}], "albums": [{"web_ms": 300}]})
        window = sync.PullWindow(cloud, {"photos": 800, "albums": 200})
        self.assertEqual(window.changed("photos", 0), [{"web_ms": 900}])
        self.assertEqual(window.changed("albums", 0), [{"web_ms": 300}])
        self.assertEqual(window.cursors, {"photos": 900, "albums": 300})
        # Legacy state replays rather than treating the fastest stream as universal.
        self.assertEqual(sync.PullWindow(cloud, {}).changed("albums", 900), [{"web_ms": 300}])

    def test_cloud_pages_replay_boundary_with_stable_order(self):
        cloud = sync.Supabase("https://example.invalid", "test")
        with patch.object(cloud, "call", return_value=[]) as call:
            cloud.changed("studio_links", 200)
        query = call.call_args.args[1]
        self.assertIn("web_ms=gte.200", query)
        self.assertIn("order=web_ms,kind,a,b", query)

    def test_plan_sync_rejects_unregistered_paths_traversal_and_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            plan = root / "project" / "00_PLAN"
            plan.mkdir(parents=True)
            self.db.execute("INSERT INTO studio_pieces (id,title,folder,created_ms,updated_ms) VALUES ('piece','Test',?,1,1)", (str(plan.parent),))
            good = plan / "project.md"
            row = lambda p: {"id": str(p), "data": {"contents": "New plan", "modifiedMs": 2_000_000_000_000}, "deleted": False}
            self.assertEqual(sync.pull_file(row(good), self.db), 1)
            self.assertEqual(good.read_text(), "New plan")
            self.assertEqual(sync.pull_file(row(good), self.db), 0, "replay leaves the file alone")
            outside = root / "unrelated.md"
            outside.write_text("Keep me")
            for path in (plan / ".." / ".." / "unrelated.md", root / "other/00_PLAN/project.md", plan / "image.jpg"):
                self.assertEqual(sync.pull_file(row(path), self.db), 0)
            (plan / "link.md").symlink_to(outside)
            self.assertEqual(sync.pull_file(row(plan / "link.md"), self.db), 0)
            self.assertEqual(outside.read_text(), "Keep me")

    def test_failed_atomic_replace_preserves_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            path.write_text("old")
            with patch.object(sync.os, "replace", side_effect=OSError("disk failure")):
                with self.assertRaises(OSError):
                    sync.atomic_write(path, "new")
            self.assertEqual(path.read_text(), "old")
            self.assertEqual(list(Path(tmp).iterdir()), [path])

    def test_transcription_upgrade_preserves_existing_words(self):
        old = sqlite3.connect(":memory:")
        self.addCleanup(old.close)
        migrations = ROOT / "src-tauri/src/library/migrations"
        for migration in sorted(migrations.glob("*.sql")):
            if migration.name.startswith("020_"):
                continue
            old.executescript(migration.read_text())
        old.execute("INSERT INTO studio_saves (id,kind,transcript,analysed_ms,created_ms,updated_ms) VALUES ('spoken','video','Keep these words',100,1,1), ('failed','video','',100,1,1), ('new','video','',NULL,1,1)")
        old.executescript((migrations / "020_transcription.sql").read_text())
        self.assertEqual(old.execute("SELECT transcript,transcription_state FROM studio_saves WHERE id='spoken'").fetchone(), ('Keep these words', 'complete'))
        self.assertEqual(old.execute("SELECT transcription_state FROM studio_saves WHERE id='failed'").fetchone()[0], 'failed')
        self.assertEqual(old.execute("SELECT transcription_state FROM studio_saves WHERE id='new'").fetchone()[0], 'queued')


if __name__ == "__main__":
    unittest.main()
