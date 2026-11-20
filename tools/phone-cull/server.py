#!/usr/bin/env python3
"""Cull from your phone, Tinder-style: a small server on the Mac that shows the
library's unreviewed photos one at a time and saves each swipe as the app's
review mark (selected / maybe / rejected) in the same database.

    python3 server.py [port]

The passcode is printed at start and kept in passcode.txt next to this file.
Photos are served from the app's preview cache; a missing preview is made once
from the photo with sips and kept in a cache of its own.
"""
import hashlib, http.cookies, http.server, json, os, secrets, socketserver, sqlite3, subprocess, sys, time, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.expanduser("~/Library/Application Support/com.capturedbyandy.library")
DB = os.path.join(LIB, "library.db")
CACHE = os.path.join(LIB, "cache")
OWN_CACHE = os.path.expanduser("~/Library/Caches/capturedbyandy-phone-cull")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
os.makedirs(OWN_CACHE, exist_ok=True)

code_file = os.path.join(HERE, "passcode.txt")
if not os.path.exists(code_file):
    open(code_file, "w").write(f"{secrets.randbelow(900000) + 100000}\n")
PASSCODE = open(code_file).read().strip()
SESSION = hashlib.sha256((PASSCODE + "capturedbyandy").encode()).hexdigest()[:32]
STATES = {"selected", "maybe", "rejected", "unreviewed"}


def db():
    c = sqlite3.connect(DB, timeout=15)
    c.execute("PRAGMA busy_timeout = 15000")
    return c


def shard(kind, name):
    pid = name[:36]
    return os.path.join(CACHE, kind, pid[-2:], f"{name}.jpg")


def picture(pid, big):
    """The best ready image for a photo, or one made now from its file."""
    for path in ([shard("previews", f"{pid}-2k")] if big else []) + [shard("thumbs", pid)] + ([] if big else [shard("previews", f"{pid}-2k")]):
        if os.path.exists(path):
            return path
    made = os.path.join(OWN_CACHE, f"{pid}-{1600 if big else 480}.jpg")
    if os.path.exists(made):
        return made
    with db() as c:
        row = c.execute("SELECT path FROM assets WHERE photo_id = ? AND storage_state != 'missing' ORDER BY is_primary DESC LIMIT 1", (pid,)).fetchone()
    if not row:
        return None
    r = subprocess.run(["/usr/bin/sips", "-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", "1600" if big else "480", row[0], "--out", made],
                       capture_output=True, timeout=120)
    return made if r.returncode == 0 and os.path.exists(made) else None


def folders():
    """Folders with photos still to cull, relative to the CAMERA folder when inside it."""
    with db() as c:
        rows = c.execute("""SELECT a.dir, COUNT(*) FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
                            WHERE p.review_state = 'unreviewed' AND p.is_video = 0 AND a.storage_state != 'missing'
                            GROUP BY a.dir ORDER BY COUNT(*) DESC""").fetchall()
    out = []
    for d, n in rows:
        label = d.split("/CAMERA/", 1)[1] if "/CAMERA/" in d else os.path.basename(d)
        out.append({"dir": d, "label": label, "count": n})
    return out


def queue(d):
    with db() as c:
        rows = c.execute("""SELECT p.id, a.filename, p.captured_at FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
                            WHERE a.dir = ? AND p.review_state = 'unreviewed' AND p.is_video = 0 AND a.storage_state != 'missing'
                            ORDER BY p.captured_at, p.id LIMIT 2000""", (d,)).fetchall()
        done = c.execute("""SELECT COUNT(*) FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
                            WHERE a.dir = ? AND p.review_state != 'unreviewed' AND p.is_video = 0""", (d,)).fetchone()[0]
    return {"photos": [{"id": i, "name": n, "at": t} for i, n, t in rows], "done": done}


def mark(pid, state):
    if state not in STATES:
        raise ValueError(state)
    now = int(time.time() * 1000)
    with db() as c:
        prev = c.execute("SELECT review_state FROM photos WHERE id = ?", (pid,)).fetchone()
        c.execute("UPDATE photos SET review_state = ?, reviewed_ms = ?, updated_ms = ? WHERE id = ?", (state, now, now, pid))
    return prev[0] if prev else None


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def authed(self):
        cookie = http.cookies.SimpleCookie(self.headers.get("Cookie", ""))
        return cookie.get("cull") is not None and cookie["cull"].value == SESSION

    def send(self, code, body, ctype="application/json", extra=None):
        data = body if isinstance(body, bytes) else (json.dumps(body) if ctype == "application/json" else body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store" if ctype != "image/jpeg" else "private, max-age=86400")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path in ("/", "/index.html"):
            return self.send(200, open(os.path.join(HERE, "index.html"), "rb").read(), "text/html; charset=utf-8")
        if u.path == "/manifest.webmanifest":
            return self.send(200, json.dumps({"name": "Cull", "short_name": "Cull", "display": "standalone", "background_color": "#0c0b0a", "theme_color": "#0c0b0a", "start_url": "/"}), "application/manifest+json")
        if not self.authed():
            return self.send(401, {"error": "passcode"})
        q = urllib.parse.parse_qs(u.query)
        if u.path == "/api/folders":
            return self.send(200, folders())
        if u.path == "/api/queue":
            return self.send(200, queue(q.get("dir", [""])[0]))
        if u.path.startswith("/img/"):
            pid = u.path[5:]
            if len(pid) != 36 or not all(ch.isalnum() or ch == "-" for ch in pid):
                return self.send(404, {"error": "not found"})
            path = picture(pid, q.get("s", ["big"])[0] == "big")
            if not path:
                return self.send(404, {"error": "no picture"})
            return self.send(200, open(path, "rb").read(), "image/jpeg")
        return self.send(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/api/login":
            if str(body.get("code", "")).strip() == PASSCODE:
                return self.send(200, {"ok": True}, extra={"Set-Cookie": f"cull={SESSION}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax"})
            time.sleep(1)
            return self.send(403, {"error": "wrong passcode"})
        if not self.authed():
            return self.send(401, {"error": "passcode"})
        if self.path == "/api/mark":
            try:
                prev = mark(body["id"], body["state"])
            except Exception as e:
                return self.send(400, {"error": str(e)})
            return self.send(200, {"ok": True, "previous": prev})
        return self.send(404, {"error": "not found"})


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    print(f"phone cull on http://localhost:{PORT} · passcode {PASSCODE}", flush=True)
    Server(("127.0.0.1", PORT), Handler).serve_forever()
