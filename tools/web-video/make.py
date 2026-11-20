#!/usr/bin/env python3
"""Web copies of the library's camera videos, for the online app (studio.andyssarchives.com).

The Sony A6700 films H.264 4:2:2 10-bit 4K, which no browser plays. Each video gets a copy browsers do play:
1080p, H.264 High 8-bit 4:2:0, about 4 Mbit/s, faststart; S-Log3 clips get the S-Log3 → Rec.709 LUT too.
Copies go to Google Drive (space Andy already has, nothing to pay), outside the library's sources so they are
never scanned as photos of their own:

    My Drive/STORAGE/WEB-VIDEO/<folder under CAMERA>/<file stem>.mp4

tools/supabase-sync/sync.py finds a copy by that path and sends its Drive id as photos.web_video_id.

    python3 make.py FRANCE/STRASBOURG        # every video under that CAMERA folder
    python3 make.py --evict                  # free copies on this Mac that Drive has uploaded

One video at a time, at low priority. An original that was online-only is freed again after its copy is made.
Stops under FLOOR_GB free.
"""
import os, shutil, sqlite3, subprocess, sys, tempfile

HOME = os.path.expanduser("~")
DB = os.path.join(HOME, "Library/Application Support/com.capturedbyandy.library/library.db")
DRIVE = os.path.join(HOME, "Library/CloudStorage/GoogleDrive-you@example.com/My Drive")
CAMERA = os.path.join(DRIVE, "*ARCHIVES/CAMERA")
OUT = os.path.join(DRIVE, "STORAGE/WEB-VIDEO")
HERE = os.path.dirname(os.path.abspath(__file__))
LUT = os.path.join(HERE, "..", "..", "PROJECTS/portfolio/scripts/slog3-lc709a.cube")
EVICT = os.path.join(HERE, "..", "iphone-import", "evict")
FLOOR_GB = 5.0


def web_path(original):
    """Where an original's web copy lives (sync.py uses the same rule)."""
    rel = os.path.relpath(os.path.dirname(original), CAMERA)
    return os.path.join(OUT, rel, os.path.splitext(os.path.basename(original))[0] + ".mp4")


def dataless(path):
    return b"dataless" in subprocess.run(["ls", "-lO", path], capture_output=True).stdout


def evict(path):
    if os.path.exists(EVICT):
        subprocess.run([EVICT, path], capture_output=True)


def videos(folder):
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    like = os.path.join(CAMERA, folder)
    return c.execute("""SELECT a.path, COALESCE(p.gamma, ''), p.duration_s FROM photos p JOIN assets a ON a.photo_id = p.id AND a.is_primary = 1
                        WHERE p.is_video = 1 AND a.storage_state != 'missing' AND (a.dir = ? OR a.dir LIKE ?) ORDER BY p.captured_at""",
                     (like, like + "/%")).fetchall()


def make(src, gamma):
    out = web_path(src)
    if os.path.exists(out):
        return "there"
    size = os.path.getsize(src)
    if shutil.disk_usage(HOME).free - size * 1.3 < FLOOR_GB * 1e9:
        sys.exit(f"STOP: {shutil.disk_usage(HOME).free / 1e9:.1f} GB free")
    was_online = dataless(src)
    vf = ([f"lut3d=file='{LUT}'"] if gamma.lower().startswith("s-log3") and os.path.exists(LUT) else []) + ["scale=-2:1080:flags=lanczos", "format=yuv420p"]
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="webvid-") as tmp:
        part = os.path.join(tmp, "copy.mp4")
        r = subprocess.run(["nice", "-n", "15", "ffmpeg", "-nostdin", "-v", "error", "-y", "-threads", "4", "-i", src, "-map", "0:v:0", "-map", "0:a:0?",
                            "-vf", ",".join(vf), "-c:v", "h264_videotoolbox", "-profile:v", "high", "-b:v", "4M", "-maxrate", "6M", "-bufsize", "8M",
                            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", part])
        if r.returncode or not os.path.exists(part):
            return "failed"
        shutil.move(part, out)
    if was_online:
        evict(src)
    return f"{os.path.getsize(out) / 1e6:.0f} MB"


def evict_uploaded():
    n = 0
    for root, _, files in os.walk(OUT):
        for f in files:
            p = os.path.join(root, f)
            if not dataless(p):
                evict(p); n += not dataless(p)
    print(f"{n} copies still waiting for Drive's upload")


if __name__ == "__main__":
    if sys.argv[1:] == ["--evict"]:
        evict_uploaded(); sys.exit()
    for folder in sys.argv[1:]:
        rows = videos(folder)
        print(f"{folder}: {len(rows)} videos", flush=True)
        for i, (src, gamma, dur) in enumerate(rows, 1):
            print(f"  {i}/{len(rows)} {os.path.basename(src)} ({gamma or '?'}, {dur or 0:.0f} s): {make(src, gamma)} · {shutil.disk_usage(HOME).free / 1e9:.1f} GB free", flush=True)
            if i % 5 == 0:
                evict_uploaded()
        evict_uploaded()
