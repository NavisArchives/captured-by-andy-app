// Downloads on the phone and in the browser (NIRMATA Amendment 9c, Andy 19 Nov:
// « same on mobile, give me an option to download it! »). Only files that exist
// on Drive can be fetched here: the camera original and, for videos, the web
// copy made for streaming. Other sizes are made on the Mac.
import { drive } from "./remote";
import { driveIdOf, webVideoOf, rowOf } from "./library";

const API = "https://www.googleapis.com/drive/v3/files/";

export type Option = {
  key: "original" | "web" | "large";
  label: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
  fileId: string;
  /** Drive's thumbnail size for « large » photos; null for whole files. */
  px?: number;
  name: string;
  mime: string;
};
export type Options = { signedIn: boolean; options: Option[]; video: boolean; made: string[] };

type Meta = { name: string; mimeType: string; size?: string; imageMediaMetadata?: { width: number; height: number }; videoMediaMetadata?: { width: number; height: number } };

async function meta(fileId: string, token: string): Promise<Meta | null> {
  const r = await fetch(`${API}${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=name,mimeType,size,imageMediaMetadata(width,height),videoMediaMetadata(width,height)`, { headers: { Authorization: `Bearer ${token}` } });
  return r.ok ? ((await r.json()) as Meta) : null;
}

/** What can be fetched for this picture or video, with real pixel sizes and bytes. */
export async function downloadOptions(photoId: string): Promise<Options> {
  const row = rowOf(photoId);
  const video = !!row?.is_video;
  // Sizes a video could have that exist only when the Mac makes them.
  const made = video ? ["1440p", "1080p", "720p"].filter((s) => (row?.height ?? row?.width ?? 0) > Number(s.slice(0, -1))) : [];
  const token = await drive.get();
  if (!token) return { signedIn: false, options: [], video, made };
  const out: Option[] = [];
  const original = driveIdOf(photoId);
  if (original) {
    const m = await meta(original, token).catch(() => null);
    if (m) {
      const dims = m.videoMediaMetadata ?? m.imageMediaMetadata;
      out.push({ key: "original", label: "Original", width: dims?.width ?? row?.width ?? null, height: dims?.height ?? row?.height ?? null, bytes: m.size ? Number(m.size) : null, fileId: original, name: m.name, mime: m.mimeType });
    }
  }
  const web = video ? webVideoOf(photoId) : null;
  if (web && web !== original) {
    const m = await meta(web, token).catch(() => null);
    if (m) {
      const dims = m.videoMediaMetadata;
      out.push({ key: "web", label: "Web copy", width: dims?.width ?? null, height: dims?.height ?? null, bytes: m.size ? Number(m.size) : null, fileId: web, name: m.name, mime: m.mimeType });
    }
  }
  if (!video && original && row?.width && row?.height) {
    // Drive's own large rendering (2048 px on the long side), a lighter JPEG.
    const long = Math.max(row.width, row.height);
    if (long > 2048) {
      const s = 2048 / long;
      out.push({ key: "large", label: "Large JPEG", width: Math.round(row.width * s), height: Math.round(row.height * s), bytes: null, fileId: original, px: 2048, name: (row.filename ?? "picture").replace(/\.[^.]+$/, "") + " 2048.jpg", mime: "image/jpeg" });
    }
  }
  return { signedIn: true, options: out, video, made };
}

/** Fetches the file with progress; resolves to a File ready for the share sheet. */
export async function fetchFile(o: Option, onProgress: (done: number, total: number | null) => void, signal: AbortSignal): Promise<File> {
  const token = await drive.get();
  if (!token) throw new Error("Sign in to Drive to get this file");
  let url = `${API}${encodeURIComponent(o.fileId)}?alt=media&supportsAllDrives=true`;
  if (o.px) {
    const r = await fetch(`${API}${encodeURIComponent(o.fileId)}?supportsAllDrives=true&fields=thumbnailLink`, { headers: { Authorization: `Bearer ${token}` }, signal });
    const link = r.ok ? ((await r.json()) as { thumbnailLink?: string }).thumbnailLink : null;
    if (!link) throw new Error("Drive has no large copy of this picture yet");
    url = link.replace(/=s\d+(-[a-z0-9-]+)?$/i, "") + `=s${o.px}`;
  }
  const res = await fetch(url, { headers: o.px ? {} : { Authorization: `Bearer ${token}` }, signal });
  if (!res.ok || !res.body) throw new Error(res.status === 401 || res.status === 403 ? "Sign in to Drive to get this file" : `Drive said ${res.status}`);
  const total = Number(res.headers.get("content-length")) || o.bytes || null;
  const reader = res.body.getReader();
  const parts: BlobPart[] = [];
  let done = 0;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    parts.push(value);
    done += value.length;
    onProgress(done, total);
  }
  return new File(parts, o.name, { type: o.mime || res.headers.get("content-type") || "application/octet-stream" });
}

/** Hands the file to the phone's share sheet (Save Video / Save Image / Save to Files); a plain download elsewhere. */
export async function saveFile(file: File): Promise<"shared" | "downloaded" | "cancelled"> {
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file] });
      return "shared";
    } catch (e) {
      if ((e as Error).name === "AbortError") return "cancelled";
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}

/** On mobile data (when the browser can tell): ask once above this. */
export const ASK_ABOVE = 100e6;
/** Above this a file is not held in the page's memory: it streams to Files
 *  instead of going through the share sheet. Provisional until measured on
 *  Andy's phone (P1); iPhone Safari tabs are reloaded well before 1 GB. */
export const IN_MEMORY_MAX = 150e6;
/** Above this, not offered on the phone at all: « get it on the Mac ». */
export const PHONE_MAX = 2e9;

/** Streams a whole file to the phone's Files through the service worker, never into memory. */
export function streamToFiles(o: Option): void {
  const a = document.createElement("a");
  a.href = `/drive/download/${encodeURIComponent(o.fileId)}?name=${encodeURIComponent(o.name)}`;
  a.download = o.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
export const onMobileData = (): boolean | null => {
  const c = (navigator as Navigator & { connection?: { type?: string } }).connection;
  return c?.type ? c.type === "cellular" : null;
};
