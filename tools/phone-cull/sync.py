#!/usr/bin/env python3
"""Keeps the phone cull Worker in step with the app's library. Outbound only.

Every minute:
  1. uploads small copies (1440 px) of unreviewed photos the Worker doesn't have yet, then lists them;
  2. copies marks made on the phone into the library (the newer mark wins);
  3. tells the Worker which listed photos were marked on the Mac meanwhile, so they leave the phone's queue.

    python3 sync.py            # runs until stopped
    python3 sync.py --once     # one round
"""
import concurrent.futures, glob, io, json, os, sqlite3, subprocess, sys, tempfile, time, urllib.request
from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = "https://REPLACE_ME.workers.dev"
TOKEN = open(os.path.join(HERE, "sync-token.txt")).read().strip()
LIB = os.path.expanduser("~/Library/Application Support/com.capturedbyandy.library")
DB = os.path.join(LIB, "library.db")
STATE = os.path.join(HERE, "sync-state.json")
TMP = tempfile.mkdtemp(prefix="cull-")
FIRST = ["NEPAL/IPHONE"]          # folders that go up first


def call(path, body=None, method=None, data=None, ctype="application/json"):
    req = urllib.request.Request(WORKER + path, method=method or ("POST" if body is not None or data is not None else "GET"),
                                 data=data if data is not None else (json.dumps(body).encode() if body is not None else None),
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": ctype, "User-Agent": "capturedbyandy-sync"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read() or b"null")


def db():
    c = sqlite3.connect(DB, timeout=15)
    c.execute("PRAGMA busy_timeout = 15000")
    return c


def picture(pid):
    for kind, name in (("previews", f"{pid}-2k"), ("thumbs", pid)):
        p = os.path.join(LIB, "cache", kind, pid[-2:], f"{name}.jpg")
        if os.path.exists(p):
            return p
    with db() as c:
        row = c.execute("SELECT path FROM assets WHERE photo_id = ? AND storage_state != 'missing' ORDER BY is_primary DESC LIMIT 1", (pid,)).fetchone()
    return row[0] if row else None


def sizes(src):
    """A sharp copy (1280 px, progressive) and a tiny one (360 px) that shows at once."""
    try:
        im = Image.open(src)
    except Exception:
        # HEIC, RAW: let macOS make a JPEG first
        tmp = os.path.join(TMP, os.path.basename(src) + ".jpg")
        subprocess.run(["/usr/bin/sips", "-s", "format", "jpeg", "-Z", "2048", src, "--out", tmp], capture_output=True, timeout=180)
        im = Image.open(tmp)
    im = ImageOps.exif_transpose(im).convert("RGB")
    out = []
    for edge, q in ((1280, 72), (360, 60)):
        c = im.copy(); c.thumbnail((edge, edge), Image.LANCZOS)
        b = io.BytesIO(); c.save(b, "JPEG", quality=q, optimize=True, progressive=True); out.append(b.getvalue())
    return out


def upload(pid, small_only=False):
    src = picture(pid)
    if not src:
        return False
    try:
        big, small = sizes(src)
        call(f"/sync/img/{pid}-s", data=small, method="PUT", ctype="image/jpeg")
        if not small_only:
            call(f"/sync/img/{pid}", data=big, method="PUT", ctype="image/jpeg")
        return True
    except Exception as e:
        print("upload failed", pid, e, flush=True)
        return False


def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {"pushed": [], "phone": {}}


def round_(st, budget=400):
    pushed = set(st["pushed"])
    if not st.get("v2"):
        with concurrent.futures.ThreadPoolExecutor(6) as pool:
            list(pool.map(upload, sorted(pushed)))
        st["v2"] = True
    # 1. push: unreviewed photos not on the Worker yet, the first folders first
    with db() as c:
        rows = c.execute("""SELECT p.id, a.dir, a.filename, p.captured_at FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
                            WHERE p.review_state = 'unreviewed' AND p.is_video = 0 AND a.storage_state != 'missing'""").fetchall()
    def label(d):
        return d.split("/CAMERA/", 1)[1] if "/CAMERA/" in d else os.path.basename(d)
    todo = [r for r in rows if r[0] not in pushed]
    todo.sort(key=lambda r: (0 if label(r[1]) in FIRST else 1, label(r[1]), r[3] or ""))
    todo = todo[:budget]
    sent = []
    with concurrent.futures.ThreadPoolExecutor(6) as pool:
        for row, ok in zip(todo, pool.map(lambda r: upload(r[0]), todo)):
            if ok:
                sent.append({"id": row[0], "dir": row[1], "label": label(row[1]), "name": row[2], "at": row[3]})
    for i in range(0, len(sent), 200):
        call("/sync/photos", sent[i:i + 200])
    pushed.update(s["id"] for s in sent)

    # 2. pull: marks made on the phone
    marks = call("/sync/marks") or []
    applied = []
    with db() as c:
        for m in marks:
            local = c.execute("SELECT review_state, reviewed_ms FROM photos WHERE id = ?", (m["id"],)).fetchone()
            if local and (local[1] or 0) <= m["marked_ms"]:
                c.execute("UPDATE photos SET review_state = ?, reviewed_ms = ?, updated_ms = ? WHERE id = ?", (m["state"], m["marked_ms"], m["marked_ms"], m["id"]))
            st["phone"][m["id"]] = m["marked_ms"]
            applied.append({"id": m["id"], "marked_ms": m["marked_ms"]})
    if applied:
        call("/sync/ack", applied)

    # 3. forget: listed for the phone, marked on the Mac since (and not by the phone)
    with db() as c:
        gone = [pid for (pid,) in c.execute(
            f"SELECT id FROM photos WHERE review_state != 'unreviewed' AND id IN ({','.join('?' * len(pushed))})", list(pushed))] if pushed else []
    gone = [g for g in gone if g not in st["phone"]]
    if gone:
        call("/sync/forget", gone)
        pushed.difference_update(gone)

    st["pushed"] = sorted(pushed)
    json.dump(st, open(STATE, "w"))
    return len(sent), len(applied), len(gone), len(todo) == budget


if __name__ == "__main__":
    st = load_state()
    while True:
        try:
            up, marks, forgot, more = round_(st)
            print(f"{time.strftime('%H:%M:%S')} uploaded {up} · marks from phone {marks} · left the queue {forgot} · on the phone {len(st['pushed'])}", flush=True)
        except Exception as e:
            print(f"{time.strftime('%H:%M:%S')} sync failed, retrying: {e}", flush=True)
            more = False
        if "--once" in sys.argv:
            break
        if not more:
            time.sleep(60)
