#!/usr/bin/env python3
"""Makes Captured by Andy's light previews of clips inside Google's network.

Runs in Google Colab with Google Drive mounted at /content/drive. Reads the
list the app wrote (STORAGE/CBA-PREVIEWS/manifest.json: each clip's Drive id,
its path in My Drive and whether it's S-Log3), reads each original at
datacenter speed and writes a 720p H.264 preview (~2.5 Mbit/s, AAC 64 kbit/s,
at most 50 fps) to STORAGE/CBA-PREVIEWS/<drive id>.mp4. S-Log3 clips get the
same colour maths as the app's own previews. Originals are only read. A
preview already there is skipped, so it can be stopped and run again.
"""
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

DRIVE = os.environ.get("CBA_DRIVE", "/content/drive/MyDrive")
FOLDER = os.path.join(DRIVE, "STORAGE", "CBA-PREVIEWS")
# Previews go to their own folder, made here in the cloud (720p since 13 Nov).
OUT = os.path.join(DRIVE, "STORAGE", "CBA-PREVIEWS-720")
# The list of clips: from the notebook itself when it carries one, else from Drive.
LOCAL_MANIFEST = "/content/manifest.json"
LUT_SIZE = 33


def has_gpu():
    try:
        ok = subprocess.run(["nvidia-smi"], capture_output=True).returncode == 0
        enc = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
        return ok and "h264_nvenc" in enc
    except OSError:
        return False


GPU = has_gpu()


def slog3(v):
    if v >= 171.2102946929 / 1023.0:
        return pow(10, (v * 1023 - 420) / 261.5) * 0.19 - 0.01
    return (v * 1023 - 95) * 0.01125 / (171.2102946929 - 95)


def srgb_encode(x):
    return 12.92 * x if x <= 0.0031308 else 1.055 * pow(x, 1 / 2.4) - 0.055


def write_lut(path):
    """The app's S-Log3 / S-Gamut3.Cine to normal colour table (helpers/review.swift)."""
    lines = ["TITLE \"Captured by Andy S-Log3\"", f"LUT_3D_SIZE {LUT_SIZE}"]
    for b in range(LUT_SIZE):
        for g in range(LUT_SIZE):
            for r in range(LUT_SIZE):
                c = [slog3(x / (LUT_SIZE - 1)) for x in (r, g, b)]
                lin = [
                    1.6269474 * c[0] - 0.5401385 * c[1] - 0.0868089 * c[2],
                    -0.1785155 * c[0] + 1.4179409 * c[1] - 0.2394254 * c[2],
                    -0.0444361 * c[0] - 0.1959199 * c[1] + 1.2403560 * c[2],
                ]
                lin = [max(x * 0.8, 0) for x in lin]
                t = [min(max((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0), 1) for x in lin]
                lines.append(" ".join(f"{srgb_encode(x):.6f}" for x in t))
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


def make(clip, lut):
    src = os.path.join(DRIVE, clip["path"])
    out = os.path.join(OUT, clip["drive_id"] + ".mp4")
    if os.path.exists(out) and os.path.getsize(out) > 10_000:
        return "already", 0
    if not os.path.exists(src):
        return "missing", 0
    # Scale first (fast), then the colour table; short side 720, even sizes.
    vf = "scale='if(gt(iw,ih),-2,720)':'if(gt(iw,ih),720,-2)':flags=bicubic"
    if clip.get("log"):
        vf += f",lut3d=file={lut}"
    vf += ",format=yuv420p"
    with tempfile.TemporaryDirectory() as tmp:
        part = os.path.join(tmp, "preview.mp4")
        started = time.time()
        err = "no output"
        # The graphics card (Runtime → Change runtime type → GPU) decodes and
        # encodes many times faster; without one, or if it fails, the processor.
        for gpu in ([True, False] if GPU else [False]):
            cmd = ["ffmpeg", "-nostdin", "-y", "-v", "error"]
            cmd += ["-hwaccel", "cuda"] if gpu else ["-skip_loop_filter", "all", "-flags2", "fast"]
            cmd += ["-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-vf", vf, "-fpsmax", "50"]
            if gpu:
                cmd += ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-b:v", "2500k", "-maxrate", "3500k", "-bufsize", "5000k", "-g", "60"]
            else:
                cmd += ["-c:v", "libx264", "-preset", "veryfast", "-b:v", "2500k", "-maxrate", "3500k", "-bufsize", "5000k", "-g", "60"]
            cmd += ["-c:a", "aac", "-b:a", "64k", "-ac", "2", "-movflags", "+faststart", part]
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode == 0 and os.path.exists(part) and os.path.getsize(part) >= 10_000:
                break
            err = (r.stderr.strip().splitlines() or ["no output"])[-1][:200]
        else:
            return "failed: " + err, 0
        shutil.copyfile(part, out + ".part")
        os.replace(out + ".part", out)
        return "made", time.time() - started


def main():
    manifest = LOCAL_MANIFEST if os.path.exists(LOCAL_MANIFEST) else os.path.join(FOLDER, "manifest.json")
    if not os.path.exists(manifest):
        sys.exit(f"No list of clips at {manifest}: open Captured by Andy once (it writes it), then run again.")
    clips = json.load(open(manifest))["clips"]
    lut = os.path.join(tempfile.gettempdir(), "slog3.cube")
    write_lut(lut)
    os.makedirs(OUT, exist_ok=True)
    todo = [c for c in clips if not os.path.exists(os.path.join(OUT, c["drive_id"] + ".mp4"))]
    print(f"{len(clips)} clips in the list, {len(clips) - len(todo)} already have a preview, {len(todo)} to make.", flush=True)
    done = failed = 0
    started = time.time()
    workers = 3 if GPU else max(1, min(4, (os.cpu_count() or 2)))
    print(("Using the graphics card (fast)." if GPU else
           "No graphics card: using the processor (slow). Faster: stop, Runtime → Change runtime type → T4 GPU, Run all again.")
          + f" {workers} clips at a time.", flush=True)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for clip, (outcome, secs) in zip(todo, pool.map(lambda c: make(c, lut), todo)):
            name = os.path.basename(clip["path"])
            if outcome == "made" or outcome == "already":
                done += 1
            else:
                failed += 1
            left = len(todo) - done - failed
            rate = (time.time() - started) / max(1, done + failed)
            eta = f"about {math.ceil(left * rate / 60)} min left" if left else "all done"
            mb = os.path.getsize(os.path.join(DRIVE, clip["path"])) / 1e6 if os.path.exists(os.path.join(DRIVE, clip["path"])) else 0
            print(f"[{done + failed}/{len(todo)}] {name} ({mb:,.0f} MB, {secs:.0f} s): {outcome} · {eta}", flush=True)
    print(f"Finished: {done} previews made, {failed} failed. Captured by Andy picks them up by itself.", flush=True)


if __name__ == "__main__":
    main()
