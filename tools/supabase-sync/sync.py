#!/usr/bin/env python3
"""Keeps Captured by Andy online (studio.andyssarchives.com) in step with the Mac.

Each round:
  1. pull: brings in what was done on the web: review marks, albums, Studio rows and
     links, project.md files. The newer change wins.
  2. push: sends what changed on the Mac since the last round. That means photo rows (no
     pictures: those stay on Google Drive, the row only carries the Drive file id),
     albums, tags, Studio, and the project.md files in each piece's 00_PLAN.

The first round sends the whole library (rows only; a few minutes). Later rounds only
send what changed, so the Mac barely notices.

    python3 sync.py              # one round
    python3 sync.py --every 15   # a round every 15 minutes, until stopped

Login: ~/.config/captured-by-andy/supabase.json
{"url": "https://….supabase.co", "key": "<secret key>"}. It never goes in git.
Standard library only.
"""
import argparse, base64, ctypes, ctypes.util, glob, json, os, sqlite3, sys, tempfile, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

LIB = os.path.expanduser("~/Library/Application Support/com.capturedbyandy.library")
DB = os.path.join(LIB, "library.db")
CONFIG = os.path.expanduser("~/.config/captured-by-andy/supabase.json")
STATE = os.path.expanduser("~/.config/captured-by-andy/supabase-state.json")
ID_XATTR = b"com.google.drivefs.item-id#S"
BATCH = 1000

# Studio's lists as the app names them, and their tables (see src-tauri/src/library/studio.rs).
STUDIO = {
    "pillars": "studio_pillars", "families": "studio_families", "ideas": "studio_ideas", "pieces": "studio_pieces",
    "saves": "studio_saves", "boards": "studio_boards", "shootDays": "studio_shoot_days", "brandJobs": "studio_brand_jobs",
    "reviews": "studio_reviews", "watch": "studio_watch",
}
# Link kinds as the app names them: table, column for a, column for b.
LINKS = {"saveIdea": ("studio_save_ideas", "save_id", "idea_id"), "pieceMedia": ("studio_piece_media", "piece_id", "photo_id")}
IPHONE = "(COALESCE(p.camera_make, '') = 'Apple' OR (p.camera_make IS NULL AND (a.dir LIKE '%/IPHONE' OR a.dir LIKE '%/IPHONE/%')))"


def now_ms():
    return int(time.time() * 1000)


def camel(s):
    head, *rest = s.split("_")
    return head + "".join(w[:1].upper() + w[1:] for w in rest)


def snake(s):
    return "".join("_" + c.lower() if c.isupper() else c for c in s)


# ---------------------------------------------------------------- Supabase


class Supabase:
    def __init__(self, url, key):
        self.url = url.rstrip("/") + "/rest/v1/"
        self.headers = {"apikey": key, "Content-Type": "application/json", "User-Agent": "capturedbyandy-sync"}
        if key.startswith("eyJ"):  # a legacy JWT key also goes as the bearer
            self.headers["Authorization"] = f"Bearer {key}"

    def call(self, method, path, body=None, prefer=None):
        headers = dict(self.headers)
        if prefer:
            headers["Prefer"] = prefer
        data = json.dumps(body).encode() if body is not None else None
        for attempt in range(4):
            try:
                req = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
                with urllib.request.urlopen(req, timeout=120) as r:
                    raw = r.read()
                    return json.loads(raw) if raw else None
            except urllib.error.HTTPError as e:
                if e.code < 500 or attempt == 3:
                    raise SystemExit(f"Supabase said {e.code} to {method} {path.split('?')[0]}: {e.read().decode()[:400]}")
            except urllib.error.URLError:
                if attempt == 3:
                    raise
            time.sleep(2 ** attempt)

    def upsert(self, table, rows, on=None):
        for i in range(0, len(rows), BATCH):
            q = f"{table}?on_conflict={on}" if on else table
            self.call("POST", q, rows[i:i + BATCH], prefer="resolution=merge-duplicates,return=minimal")

    def changed(self, table, since, select="*"):
        """Rows changed on the web after `since` (their web_ms), oldest first, in pages."""
        out, offset = [], 0
        while True:
            key = {"photos": "id", "albums": "id", "album_photos": "album_id,photo_id", "studio_rows": "list,id", "studio_links": "kind,a,b"}[table]
            page = self.call("GET", f"{table}?select={select}&web_ms=gte.{since}&order=web_ms,{key}&limit={BATCH}&offset={offset}")
            out += page
            if len(page) < BATCH:
                return out
            offset += BATCH

    def all(self, table, select):
        out, offset = [], 0
        while True:
            page = self.call("GET", f"{table}?select={select}&limit={BATCH}&offset={offset}")
            out += page
            if len(page) < BATCH:
                return out
            offset += BATCH


# ---------------------------------------------------------------- Google Drive file ids

_libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)


def drive_id(path):
    """The Drive file id Google Drive for desktop keeps on each file. It reads only
    metadata and never downloads the file."""
    if sys.platform != "darwin":
        return None
    buf = ctypes.create_string_buffer(256)
    # macOS: getxattr(path, name, value, size, position, options)
    n = _libc.getxattr(os.fsencode(path), ID_XATTR, buf, 256, 0, 0)
    return buf.raw[:n].decode() if n > 0 else None


# ---------------------------------------------------------------- the library


def db():
    c = sqlite3.connect(DB, timeout=15)
    c.execute("PRAGMA busy_timeout = 15000")
    c.row_factory = sqlite3.Row
    return c


def columns(c, table):
    return {r[1] for r in c.execute(f"PRAGMA table_info({table})")}


def push_photos(sb, c, since):
    rows = c.execute(f"""
        SELECT p.id, p.captured_at, a.filename, a.path, a.dir, s.path AS root, s.label, p.media_kind, p.is_video, p.duration_s,
               p.width, p.height, p.camera_model, p.review_state, p.reviewed_ms, p.thumbhash,
               MAX(p.updated_ms, a.updated_ms, COALESCE(an.analysed_ms, 0)) AS updated_ms,
               {IPHONE} AS iphone, COALESCE(an.burst_size, 1) AS burst, COALESCE(an.burst_best, 1) AS burst_best,
               an.sharpness, a.storage_state
        FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
        JOIN sources s ON s.id = a.source_id
        LEFT JOIN photo_analysis an ON an.photo_id = p.id
        WHERE p.updated_ms > ?1 OR a.updated_ms > ?1 OR COALESCE(an.analysed_ms, 0) > ?1""", (since,)).fetchall()
    out = []
    for r in rows:
        rel = r["dir"][len(r["root"]):].strip("/") if r["dir"].startswith(r["root"]) else ""
        out.append({
            "id": r["id"], "captured_at": r["captured_at"], "filename": r["filename"], "folder": rel, "source": r["label"],
            "media_kind": r["media_kind"], "is_video": bool(r["is_video"]), "duration_s": r["duration_s"],
            "width": r["width"], "height": r["height"], "camera_model": r["camera_model"], "iphone": bool(r["iphone"]),
            "burst": r["burst"], "burst_best": bool(r["burst_best"]), "soft": r["sharpness"] is not None and r["sharpness"] < 6.0,
            "review": r["review_state"], "reviewed_ms": r["reviewed_ms"],
            "thumbhash": base64.b64encode(r["thumbhash"]).decode() if r["thumbhash"] else None,
            "drive_id": drive_id(r["path"]), "gone": r["storage_state"] == "missing", "updated_ms": r["updated_ms"],
        })
    sb.upsert("photos", out)
    return len(out)


def pull_photos(sb, c, since):
    marks = sb.changed("photos", since, "id,review,web_ms")
    n = 0
    for m in marks:
        # The web's mark wins when it is newer than the Mac's last say on that photo.
        n += c.execute("UPDATE photos SET review_state = ?2, reviewed_ms = ?3, updated_ms = ?4 WHERE id = ?1 AND COALESCE(reviewed_ms, 0) < ?3",
                       (m["id"], m["review"], m["web_ms"], now_ms())).rowcount
    return n, max((m["web_ms"] for m in marks), default=since)


def push_albums(sb, c, since):
    albums = c.execute("SELECT id, name, description, cover_photo_id, updated_ms FROM albums WHERE updated_ms > ?", (since,)).fetchall()
    if albums:
        sb.upsert("albums", [dict(a) | {"deleted": False} for a in albums])
        for a in albums:
            members = c.execute("SELECT photo_id, position FROM photo_albums WHERE album_id = ?", (a["id"],)).fetchall()
            sb.upsert("album_photos", [{"album_id": a["id"], "photo_id": m["photo_id"], "position": m["position"], "deleted": False} for m in members], on="album_id,photo_id")
            keep = {m["photo_id"] for m in members}
            online = sb.call("GET", f"album_photos?select=photo_id&album_id=eq.{a['id']}&deleted=eq.false")
            gone = [{"album_id": a["id"], "photo_id": o["photo_id"], "deleted": True} for o in online if o["photo_id"] not in keep]
            sb.upsert("album_photos", gone, on="album_id,photo_id")
    # Albums deleted on the Mac.
    local = {r[0] for r in c.execute("SELECT id FROM albums")}
    gone = [{"id": a["id"], "name": a["name"], "deleted": True} for a in sb.all("albums", "id,name,deleted") if not a["deleted"] and a["id"] not in local]
    sb.upsert("albums", gone)
    return len(albums)


def pull_albums(sb, c, since):
    n, top = 0, since
    for a in sb.changed("albums", since):
        top = max(top, a["web_ms"])
        if a["deleted"]:
            # Deletions obey the same newer-change rule as edits. A stale web
            # tombstone must not erase an album changed on the Mac meanwhile.
            c.execute("DELETE FROM albums WHERE id = ? AND updated_ms < ?", (a["id"], a["web_ms"]))
        else:
            c.execute("""INSERT INTO albums (id, name, description, cover_photo_id, created_ms, updated_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                         ON CONFLICT (id) DO UPDATE SET name = ?2, description = ?3, cover_photo_id = COALESCE(?4, cover_photo_id), updated_ms = ?5
                         WHERE albums.updated_ms < ?5""", (a["id"], a["name"], a["description"], a["cover_photo_id"], a["web_ms"]))
        n += 1
    for m in sb.changed("album_photos", since):
        top = max(top, m["web_ms"])
        if m["deleted"]:
            c.execute("DELETE FROM photo_albums WHERE album_id = ? AND photo_id = ?", (m["album_id"], m["photo_id"]))
        elif c.execute("SELECT 1 FROM albums WHERE id = ?", (m["album_id"],)).fetchone() and c.execute("SELECT 1 FROM photos WHERE id = ?", (m["photo_id"],)).fetchone():
            c.execute("""INSERT OR IGNORE INTO photo_albums (album_id, photo_id, position, added_ms)
                         VALUES (?1, ?2, (SELECT COALESCE(MAX(position), -1) + 1 FROM photo_albums WHERE album_id = ?1), ?3)""",
                      (m["album_id"], m["photo_id"], m["web_ms"]))
        c.execute("UPDATE albums SET updated_ms = MAX(updated_ms, ?2) WHERE id = ?1", (m["album_id"], m["web_ms"]))
        n += 1
    return n, top


def push_tags(sb, c):
    sb.upsert("tags", [dict(r) for r in c.execute("SELECT id, name, slug FROM tags")])
    sb.upsert("photo_tags", [dict(r) for r in c.execute("SELECT tag_id, photo_id FROM photo_tags")], on="tag_id,photo_id")


def studio_row(r):
    return {camel(k): r[k] for k in r.keys()}


def push_studio(sb, c, since):
    n = 0
    online = {}
    for row in sb.all("studio_rows", "list,id,deleted"):
        if not row["deleted"]:
            online.setdefault(row["list"], set()).add(row["id"])
    for short, table in STUDIO.items():
        rows = c.execute(f"SELECT * FROM {table} WHERE updated_ms > ?", (since,)).fetchall()
        sb.upsert("studio_rows", [{"list": short, "id": r["id"], "data": studio_row(r), "updated_ms": r["updated_ms"], "deleted": False} for r in rows], on="list,id")
        n += len(rows)
        local = {r[0] for r in c.execute(f"SELECT id FROM {table}")}
        gone = [{"list": short, "id": i, "data": {}, "deleted": True} for i in online.get(short, set()) - local]
        sb.upsert("studio_rows", gone, on="list,id")
    online_links = {(l["kind"], l["a"], l["b"]) for l in sb.all("studio_links", "kind,a,b,deleted") if not l["deleted"]}
    local_links = set()
    for kind, (table, ca, cb) in LINKS.items():
        local_links |= {(kind, a, b) for a, b in c.execute(f"SELECT {ca}, {cb} FROM {table}")}
    sb.upsert("studio_links", [{"kind": k, "a": a, "b": b, "deleted": False} for k, a, b in local_links - online_links], on="kind,a,b")
    sb.upsert("studio_links", [{"kind": k, "a": a, "b": b, "deleted": True} for k, a, b in online_links - local_links], on="kind,a,b")
    root = c.execute("SELECT value FROM settings WHERE key = 'studio.root'").fetchone()
    sb.upsert("studio_rows", [{"list": "meta", "id": "root", "data": {"root": root[0] if root else os.path.expanduser("~/Movies/STUDIO")}, "deleted": False}], on="list,id")
    return n


def pull_studio(sb, c, since):
    n, top = 0, since
    for row in sb.changed("studio_rows", since):
        top = max(top, row["web_ms"])
        if row["list"] == "files":
            n += pull_file(row, c)
            continue
        table = STUDIO.get(row["list"])
        if not table:
            continue
        if row["deleted"]:
            n += c.execute(f"DELETE FROM {table} WHERE id = ? AND updated_ms < ?", (row["id"], row["web_ms"])).rowcount
            continue
        mine = c.execute(f"SELECT updated_ms FROM {table} WHERE id = ?", (row["id"],)).fetchone()
        if mine and mine[0] >= row["web_ms"]:
            continue  # changed on the Mac since: the Mac's version stays
        cols = columns(c, table)
        values = {snake(k): v for k, v in row["data"].items() if snake(k) in cols}
        values |= {"id": row["id"], "updated_ms": row["web_ms"]}
        values.setdefault("created_ms", row["web_ms"])
        names = list(values)
        c.execute(f"INSERT INTO {table} ({', '.join(names)}) VALUES ({', '.join('?' * len(names))}) "
                  f"ON CONFLICT (id) DO UPDATE SET {', '.join(f'{k} = excluded.{k}' for k in names if k != 'id')}", [values[k] for k in names])
        n += 1
    for link in sb.changed("studio_links", since):
        top = max(top, link["web_ms"])
        table, ca, cb = LINKS.get(link["kind"], (None, None, None))
        if not table:
            continue
        if link["deleted"]:
            c.execute(f"DELETE FROM {table} WHERE {ca} = ? AND {cb} = ?", (link["a"], link["b"]))
        elif table == "studio_piece_media":
            c.execute("INSERT OR IGNORE INTO studio_piece_media (piece_id, photo_id, added_ms) VALUES (?, ?, ?)", (link["a"], link["b"], link["web_ms"]))
        else:
            c.execute(f"INSERT OR IGNORE INTO {table} ({ca}, {cb}) VALUES (?, ?)", (link["a"], link["b"]))
        n += 1
    return n, top


# ---------------------------------------------------------------- project.md and friends


def pull_file(row, c):
    """Only Markdown directly inside a known project's plan folder or Studio cards."""
    data = row["data"]
    path = Path(row["id"])
    if row["deleted"] or not path.is_absolute() or path.suffix.lower() != ".md":
        return 0
    roots = {Path(folder).resolve() / "00_PLAN" for (folder,) in
             c.execute("SELECT folder FROM studio_pieces WHERE folder IS NOT NULL AND folder != ''")}
    root = c.execute("SELECT value FROM settings WHERE key = 'studio.root'").fetchone()
    roots.add((Path(root[0]) if root else Path.home() / "Movies/STUDIO").resolve() / "_CARDS")
    # Resolving both sides rejects traversal and symlinks that escape the plan folder.
    allowed = {folder.resolve() for folder in roots}
    target = path.resolve()
    if path.parent not in roots or target.parent not in allowed or target != path:
        return 0
    contents = data.get("contents", "")
    if not isinstance(contents, str) or len(contents.encode("utf-8")) >= 1_000_000:
        return 0
    modified = data.get("modifiedMs", 0)
    if not isinstance(modified, (int, float)) or not 0 < modified < float("inf"):
        return 0
    if target.exists() and target.stat().st_mtime * 1000 >= modified:
        return 0
    target.parent.mkdir(parents=True, exist_ok=True)
    # Replace only after the complete file is durable; a failed write leaves the old plan.
    atomic_write(target, contents)
    os.utime(target, (modified / 1000, modified / 1000))
    return 1


def push_files(sb, c, since):
    out = []
    for (folder,) in c.execute("SELECT folder FROM studio_pieces WHERE folder IS NOT NULL AND folder != ''"):
        for path in glob.glob(os.path.join(folder, "00_PLAN", "*.md")):
            mtime = int(os.path.getmtime(path) * 1000)
            if mtime > since and os.path.getsize(path) < 1_000_000:
                with open(path) as f:
                    out.append({"list": "files", "id": path, "data": {"path": path, "contents": f.read(), "modifiedMs": mtime}, "updated_ms": mtime, "deleted": False})
    sb.upsert("studio_rows", out, on="list,id")
    return len(out)


# ---------------------------------------------------------------- a round


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


WEB_STATE = os.path.expanduser("~/.config/captured-by-andy/web-videos.json")
WEB_VIDEO = os.path.expanduser("~/Library/CloudStorage/GoogleDrive-you@example.com/My Drive/STORAGE/WEB-VIDEO")
CAMERA = os.path.expanduser("~/Library/CloudStorage/GoogleDrive-you@example.com/My Drive/*ARCHIVES/CAMERA")


def push_web_videos(sb, c):
    """Each video's web copy (tools/web-video/make.py) once Drive has given it an id: sent as web_video_id."""
    sent = load(WEB_STATE, {})
    rows = c.execute("SELECT p.id, a.path FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1 WHERE p.is_video = 1").fetchall()
    n = 0
    for pid, path in rows:
        if not path.startswith(CAMERA + "/"):
            continue
        web = os.path.join(WEB_VIDEO, os.path.relpath(os.path.dirname(path), CAMERA), os.path.splitext(os.path.basename(path))[0] + ".mp4")
        fid = drive_id(web) if os.path.exists(web) else None
        if fid and sent.get(pid) != fid:
            sb.call("PATCH", f"photos?id=eq.{urllib.parse.quote(pid)}", {"web_video_id": fid}, prefer="return=minimal")
            sent[pid] = fid
            n += 1
    if n:
        os.makedirs(os.path.dirname(WEB_STATE), exist_ok=True)
        with open(WEB_STATE, "w") as f:
            json.dump(sent, f)
    return n


def atomic_write(path, contents):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix="." + path.name, delete=False) as f:
            temporary = f.name
            f.write(contents)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


class PullWindow:
    """Independent stream cursors; old shared checkpoints are replayed once safely."""
    def __init__(self, sb, cursors):
        self.sb = sb
        self.cursors = dict(cursors)

    def changed(self, table, _since, select="*"):
        since = self.cursors.get(table, 0)
        rows = self.sb.changed(table, since, select)
        self.cursors[table] = max([since] + [r["web_ms"] for r in rows])
        return rows


def round_(sb):
    state = load(STATE, {"pushed": 0, "pulled": 0})
    started = now_ms()
    window = PullWindow(sb, state.get("pull_cursors", {}))
    with db() as c:
        p1, t1 = pull_photos(window, c, 0)
        p2, t2 = pull_albums(window, c, 0)
        p3, t3 = pull_studio(window, c, 0)
        c.commit()
        # Anything just pulled is newer than the push cursor too: it goes back up
        # unchanged, which is harmless.
        s1 = push_photos(sb, c, state["pushed"])
        s2 = push_albums(sb, c, state["pushed"])
        push_tags(sb, c)
        s3 = push_studio(sb, c, state["pushed"])
        s4 = push_files(sb, c, state["pushed"])
        s5 = push_web_videos(sb, c)
    state = {"pushed": started, "pulled": max(t1, t2, t3), "pull_cursors": window.cursors}
    atomic_write(STATE, json.dumps(state))
    print(f"{time.strftime('%H:%M')}  from the web: {p1} marks, {p2} album changes, {p3} Studio changes  ·  "
          f"sent: {s1} photos, {s2} albums, {s3} Studio rows, {s4} plan files, {s5} web videos", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--every", type=float, help="minutes between rounds; runs until stopped")
    args = ap.parse_args()
    cfg = load(CONFIG, None)
    if not cfg:
        raise SystemExit(f"No login yet: write {CONFIG} (see docs/web/SETUP.md).")
    sb = Supabase(cfg["url"], cfg["key"])
    while True:
        round_(sb)
        if not args.every:
            return
        time.sleep(args.every * 60)


if __name__ == "__main__":
    main()
