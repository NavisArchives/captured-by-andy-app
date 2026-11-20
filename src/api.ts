// Every call into the Rust core goes through here, so the rest of the UI never
// deals with command names or argument shapes.
import { invoke } from "@tauri-apps/api/core";
import type * as T from "./types";

/** Where a delete came from, written to the audit log. */
export type DeleteSource = "menu" | "keyboard" | "undo" | "assistant undo";
export type TrashKind = "post" | "album" | "idea" | "project";
export type TrashItem = { id: number; kind: TrashKind; itemId: string; title: string; deletedMs: number; source: string; linked: number };
export type AuditLine = { atMs: number; action: "delete" | "restore" | "purge"; kind: string; itemId: string; title: string; source: string };

export const api = {
  // Archive: the portfolio website's projects (src/archive.json in the site's folder).
  /** The assistant (Mac only): the day's count and spend, and whether its key is in place. */
  assistantStatus: () => invoke<{ key: boolean; model: string; today: number; cap: number; spentUsd: number; monthUsd: number; ceilingUsd: number }>("assistant_status"),
  /** One model turn; the Rust side adds the key, the model and the limits. */
  assistantSend: (system: string, tools: readonly unknown[], messages: unknown[]) => invoke<unknown>("assistant_send", { system, tools, messages }),
  /** Transcripts (Mac): the queue runs for the life of the app, on mains power. */
  transcriptsStart: () => invoke<void>("transcripts_start"),
  transcriptsStatus: () => invoke<{ done: number; total: number; state: string }>("transcripts_status"),
  transcriptsPlaying: (playing: boolean) => invoke<void>("transcripts_playing", { playing }),
  videoTranscript: (id: string) => invoke<{ state: "done" | "no_speech" | "failed"; language: string; text: string; segments: string; error: string; corrected?: boolean } | null>("video_transcript", { id }),
  /** Saves lines corrected by hand (they are never replaced by an automatic run). */
  setTranscriptLines: (id: string, segments: { start: number; end: number; text: string }[]) => invoke<void>("set_transcript_lines", { id, segments }),
  transcribeVideo: (id: string) => invoke<string>("transcribe_video", { id }),
  /** Online only: the picture's page on Google Drive (null when it isn't on Drive). */
  driveLink: (id: string) => invoke<string | null>("drive_link", { id }),
  /** Online only: the website's projects as the Mac last synced them (null before the first sync). */
  siteProjects: () => invoke<{ projects: { slug: string; title: string; year?: string; notebook?: boolean; photos?: string[] }[]; found: boolean } | null>("site_projects"),
  archiveRead: () => invoke<{ json: string; version: string; siteDir: string; media: string; sources: string }>("archive_read"),
  /** Saves the whole file if it is still `version`; resolves to the new version. */
  archiveWrite: (json: string, version: string) => invoke<string>("archive_write", { json, version }),
  /** A frame's rendered edit, which the site turns into its web copies. */
  archiveWriteImage: (bytes: Uint8Array, key: string, photo?: string) =>
    invoke<void>("archive_write_image", bytes, { headers: photo ? { "x-key": key, "x-photo": photo } : { "x-key": key } }),
  /** For each frame: does the site show its photo's edit as it is now (and which edit it shows)? */
  archiveFrameStatus: (frames: { key: string; photo: string }[]) =>
    invoke<{ key: string; upToDate: boolean; edited: boolean; published: { photo: string; edit: T.PhotoLook; trim: [number, number] | null } | null }[]>("archive_frame_status", { frames }),
  /** Runs the site's `npm run sync`; its lines arrive as `archive-sync` events. */
  archiveSync: () => invoke<void>("archive_sync"),
  /** Renders a frame's library video with its edit and trim for the site; false when unchanged. */
  archiveWriteClip: (photoId: string, key: string) => invoke<boolean>("archive_write_clip", { photoId, key }),
  // The site's other pages (Brand work, Motion, brands, words, links): src/site.json, whole.
  siteRead: () => invoke<{ json: string; version: string }>("site_read"),
  siteWrite: (json: string, version: string) => invoke<string>("site_write", { json, version }),
  /** Copies a logo into the site's public/logos; resolves to its path there ("/logos/zeb.svg"). */
  sitePutLogo: (path: string, name: string) => invoke<string>("site_put_logo", { path, name }),
  archiveAlbumPhotos: (album: string) => invoke<string[]>("archive_album_photos", { album }),
  /** Opens the site in the browser (starting its preview server when needed). */
  archivePreview: (path?: string) => invoke<void>("archive_preview", { path }),
  libraryInfo: () => invoke<T.LibraryInfo>("library_info"),
  listSources: () => invoke<T.Source[]>("list_sources"),
  addSource: (path: string) => invoke<T.AddedSource>("add_source", { path }),
  setSourceEnabled: (id: string, enabled: boolean) => invoke<void>("set_source_enabled", { id, enabled }),
  removeSource: (id: string) => invoke<number>("remove_source", { id }),
  scanAll: () => invoke<void>("scan_all"),
  cancelScan: () => invoke<void>("cancel_scan"),
  scanStatus: () => invoke<T.ScanStatus>("scan_status"),
  syncStatus: () => invoke<T.SyncStatus>("sync_status"),
  syncNow: () => invoke<void>("sync_now"),
  refreshAnalysis: () => invoke<number>("refresh_analysis"),

  counts: (query: T.Query = {}) => invoke<T.Counts>("photo_counts", { query }),
  smartCounts: () => invoke<T.SmartCounts>("smart_counts"),
  folders: () => invoke<T.Folder[]>("photo_folders"),
  /** Every photo with an edit of its own, the most recently edited first. */
  editedIds: () => invoke<string[]>("edited_ids"),
  moveToTrip: (photoIds: string[], trip: string) => invoke<T.MoveReport>("move_to_trip", { photoIds, trip }),
  /** A video's trim [start, end] in seconds, or null for the whole clip. */
  videoTrim: (photoId: string) => invoke<[number, number] | null>("video_trim", { photoId }),
  setVideoTrim: (photoId: string, start: number | null, end: number | null) => invoke<void>("set_video_trim", { photoId, start, end }),
  /** Makes a video's smooth copy for the editor; progress comes as `edit-copy-progress`. */
  editCopy: (photoId: string) => invoke<void>("edit_copy", { photoId }),
  undoTripMove: (moves: T.FileMove[]) => invoke<number>("undo_trip_move", { moves }),
  /** Renames photos "<name> 01", "<name> 02"… in shooting order (undo with undoTripMove). */
  /** Makes these photos' sharp previews ahead of time (a newer call takes over). */
  warmPreviews: (photoIds: string[]) => invoke<void>("warm_previews", { photoIds }),
  renamePhotos: (photoIds: string[], name: string) => invoke<T.MoveReport>("rename_photos", { photoIds, name }),
  misplaced: (trip: string) => invoke<T.Misplaced[]>("misplaced", { trip }),
  listPhotos: (query: T.Query, offset: number, limit: number) => invoke<T.PhotoRow[]>("list_photos", { query, offset, limit }),
  photoIds: (query: T.Query, offset: number, limit: number) => invoke<string[]>("photo_ids", { query, offset, limit }),
  position: (query: T.Query, id: string) => invoke<number | null>("photo_position", { query, id }),
  inView: (query: T.Query, ids: string[]) => invoke<string[]>("photos_in_view", { query, ids }),
  reviewMarks: (ids: string[]) => invoke<T.ReviewMark[]>("review_marks", { ids }),
  restoreMarks: (marks: T.ReviewMark[]) => invoke<number>("restore_marks", { marks }),
  neighbor: (query: T.Query, id: string, dir: 1 | -1) => invoke<[string, number] | null>("photo_neighbor", { query, id, dir }),
  detail: (id: string) => invoke<T.PhotoDetail>("photo_detail", { id }),
  rows: (ids: string[]) => invoke<T.PhotoRow[]>("photo_rows", { ids }),
  /** Copies picked files into a library folder (or a new folder in it) and adds them; their photo ids. */
  addItems: (paths: string[], folder: string, newFolder: string | null) => invoke<string[]>("add_items", { paths, folder, newFolder }),
  morningBrief: () => invoke<T.MorningBrief>("morning_brief"),
  openAgencyBoard: () => invoke<void>("open_agency_board"),
  tripPlaces: (trip: string) => invoke<T.PlaceProposal>("trip_places", { trip }),
  makePlaces: (trip: string, choices: { key: string; name: string }[]) => invoke<T.MoveReport>("make_places", { trip, choices }),
  cleanupOverview: () => invoke<T.CleanupOverview>("cleanup_overview"),
  cleanupPhotos: (trip: string) => invoke<T.CleanupCandidate[]>("cleanup_photos", { trip }),
  cleanupMark: (photoIds: string[], mark: "delete" | "keep" | null) => invoke<number>("cleanup_mark", { photoIds, mark }),
  cleanupMarkSet: (set: T.CleanupSet, mark: "delete" | null) => invoke<number>("cleanup_mark_set", { set, mark }),
  cleanupDelete: (trip: string, ids: string[]) => invoke<T.CleanupReport>("cleanup_delete", { trip, ids }),
  cleanupHistory: () => invoke<T.CleanupBatch[]>("cleanup_history"),
  cleanupUndo: (batch: string) => invoke<{ photos: number; failed: string[] }>("cleanup_undo", { batch }),
  cleanupPhoneFind: (batch: string) => invoke<T.PhoneFind>("cleanup_phone_find", { batch }),
  cleanupPhoneDelete: (batch: string) => invoke<"deleted" | "cancelled" | "denied">("cleanup_phone_delete", { batch }),
  burst: (id: string) => invoke<T.PhotoRow[]>("photo_burst", { id }),
  setReview: (ids: string[], review: T.ReviewState) => invoke<number>("set_review", { ids, review }),

  listAlbums: () => invoke<T.Album[]>("list_albums"),
  createAlbum: (name: string, photoIds?: string[]) => invoke<T.Album>("create_album", { name, photoIds }),
  updateAlbum: (id: string, patch: { name?: string; description?: string; coverPhotoId?: string }) =>
    invoke<T.Album>("update_album", { id, patch }),
  deleteAlbum: (id: string, source: DeleteSource = "menu") => invoke<void>("delete_album", { id, source }),
  albumAdd: (id: string, photoIds: string[]) => invoke<number>("album_add", { id, photoIds }),
  albumRemove: (id: string, photoIds: string[]) => invoke<number>("album_remove", { id, photoIds }),

  listTags: () => invoke<T.Tag[]>("list_tags"),
  tagPhotos: (names: string[], photoIds: string[]) => invoke<number>("tag_photos", { names, photoIds }),
  untagPhotos: (tagId: string, photoIds: string[]) => invoke<number>("untag_photos", { tagId, photoIds }),
  renameTag: (id: string, name: string) => invoke<void>("rename_tag", { id, name }),
  deleteTag: (id: string) => invoke<void>("delete_tag", { id }),

  listAccounts: () => invoke<T.Account[]>("list_accounts"),
  createAccount: (input: T.AccountInput) => invoke<T.Account>("create_account", { input }),
  updateAccount: (id: string, input: T.AccountInput) => invoke<T.Account>("update_account", { id, input }),
  deleteAccount: (id: string) => invoke<void>("delete_account", { id }),

  listPosts: (filter?: { account?: string; status?: T.PostStatus }) => invoke<T.Post[]>("list_posts", { filter }),
  getPost: (id: string) => invoke<T.PostDetail>("get_post", { id }),
  createPost: (input: T.PostInput, photoIds?: string[]) => invoke<T.PostDetail>("create_post", { input, photoIds }),
  updatePost: (id: string, input: T.PostInput) => invoke<T.PostDetail>("update_post", { id, input }),
  deletePost: (id: string, source: DeleteSource = "menu") => invoke<void>("delete_post", { id, source }),
  /** Recently deleted: posts, albums, ideas and projects, kept 30 days. */
  trashList: (kind?: TrashKind) => invoke<TrashItem[]>("trash_list", { kind: kind ?? null }),
  trashRestore: (id: number, source = "Recently deleted") => invoke<string>("trash_restore", { id, source }),
  trashPurge: (id: number) => invoke<void>("trash_purge", { id }),
  auditLines: (limit = 200) => invoke<AuditLine[]>("audit_lines", { limit }),
  postAddPhotos: (id: string, photoIds: string[]) => invoke<number>("post_add_photos", { id, photoIds }),
  postRemovePhotos: (id: string, photoIds: string[]) => invoke<number>("post_remove_photos", { id, photoIds }),
  postReorder: (id: string, ordered: string[]) => invoke<void>("post_reorder", { id, ordered }),
  pipeline: (account?: string) => invoke<T.Pipeline>("post_pipeline", { account }),
  accountGrid: (account: string) => invoke<T.Post[]>("account_grid", { account }),
  planPosts: (ordered: string[]) => invoke<void>("plan_posts", { ordered }),
  dashboard: () => invoke<T.Summary>("dashboard"),

  finderSyncAll: () => invoke<T.SyncReport>("finder_sync_all"),
  finderRemoveAdded: () => invoke<T.SyncReport>("finder_remove_added"),
  offlineInfo: () => invoke<T.OfflineInfo>("offline_info"),
  offlineKeep: (photoIds: string[]) => invoke<T.OfflineReport>("offline_keep", { photoIds }),
  offlineRelease: (photoIds: string[]) => invoke<T.OfflineReport>("offline_release", { photoIds }),
  listLocations: () => invoke<T.Location[]>("list_locations"),
  addLocation: (path: string, label?: string) => invoke<T.Location>("add_location", { path, label }),
  removeLocation: (id: string) => invoke<void>("remove_location", { id }),
  archivePhotos: (locationId: string, photoIds: string[]) => invoke<T.ArchiveReport>("archive_photos", { locationId, photoIds }),

  importLooks: () => invoke<void>("import_looks"),
  addLookFolder: (path: string) => invoke<void>("add_look_folder", { path }),
  listLooks: () => invoke<T.Look[]>("list_looks"),
  deleteLook: (id: string) => invoke<void>("delete_look", { id }),
  setLookFavorites: (ordered: string[]) => invoke<void>("set_look_favorites", { ordered }),
  photoLook: (photoId: string) => invoke<T.PhotoLook>("photo_look", { photoId }),
  photoLooks: (photoIds: string[]) => invoke<T.PhotoLook[]>("photo_looks", { photoIds }),
  albumLook: (photoId: string) => invoke<T.AlbumLook | null>("album_look", { photoId }),
  setAlbumLook: (albumId: string, recipe: T.Recipe | null) => invoke<void>("set_album_look", { albumId, recipe }),
  changeAlbumLook: (albumId: string, recipe: T.Recipe) => invoke<T.AlbumLookChange>("change_album_look", { albumId, recipe }),
  saveLook: (name: string, base: string | null, strength: number, adjustments: T.Adjustments) =>
    invoke<T.Look>("save_look", { name, base, strength, adjustments }),
  applyLook: (photoIds: string[], lookId: string | null, strength: number, adjustments?: T.Adjustments) =>
    invoke<number>("apply_look", { photoIds, lookId, strength, adjustments }),
  autoAdjust: (photoId: string) => invoke<T.Adjustments>("auto_adjust", { photoId }),
  /** `taken` ("YYYY:MM:DD HH:MM:SS") becomes the file's date taken. */
  exportImage: (bytes: Uint8Array, name: string, taken?: string) =>
    invoke<string>("export_image", bytes, { headers: taken ? { ...nameHeaders(name), "x-taken": taken } : nameHeaders(name) }),
  /** A finished clip (look, S-Log3 conversion, crop, part, size) into Exports; `plainCopy`: untouched copy when there's nothing to apply. */
  exportClip: (photoId: string, ratio: string, start: number | null, end: number | null, name: string, plainCopy: boolean, outSize?: string, bitrate?: number) =>
    invoke<string>("export_clip", { photoId, ratio, start, end, name, plainCopy, outSize, bitrate }),
  /** A video's shown size, frame rate and length (for export sizes and estimates). */
  videoInfo: (id: string) => invoke<{ width: number; height: number; fps: number; duration: number }>("video_info", { id }),
  /** Copies the untouched original into Downloads; returns the copy's path. */
  saveOriginal: (id: string) => invoke<string>("save_original", { id }),
  /** Copies a video, untouched, into Exports. */
  exportVideo: (id: string, name: string) => invoke<string>("export_video", { id, name }),
  /** Why the library couldn't open at launch (null when it opened). */
  startupProblem: () => invoke<string | null>("startup_problem"),
  safeBackups: () => invoke<T.BackupInfo[]>("safe_backups"),
  safeRestore: (name: string) => invoke<void>("safe_restore", { name }),
  safeReveal: () => invoke<void>("safe_reveal"),
  logPageError: (message: string) => invoke<void>("log_page_error", { message }),
  /** Apple's image analysis of the previews on this Mac: horizon tilt and main subject. */
  frameHints: (photoIds: string[]) => invoke<T.FrameHint[]>("frame_hints", { photoIds }),
  /** The frame at `at` seconds as a new photo (full size, in the app's Stills folder); returns its id. */
  saveVideoStill: (photoId: string, at: number) => invoke<string>("save_video_still", { photoId, at }),
  /** What's in a photo, most confident first ([label, confidence]). */
  photoLabels: (photoId: string) => invoke<[string, number][]>("photo_labels", { photoId }),
  listLabels: () => invoke<T.LabelList>("list_labels"),
  /** While culling: these videos (nearest first) are downloaded to play without lag; others are released. */
  keepVideosLocal: (photoIds: string[]) => invoke<void>("keep_videos_local", { photoIds }),
  videosReady: (photoIds: string[]) => invoke<string[]>("videos_ready", { photoIds }),
  videoMoments: (photoId: string) => invoke<T.VideoMoment[]>("video_moments", { photoId }),
  addVideoMoment: (photoId: string, start: number, end: number) => invoke<T.VideoMoment>("add_video_moment", { photoId, start, end }),
  removeVideoMoment: (id: string) => invoke<void>("remove_video_moment", { id }),
  /** Opens AirDrop for exported files; "sent" or "cancelled" when the window closes. */
  airdrop: (paths: string[]) => invoke<string>("airdrop", { paths }),
  /** Logs and library facts in one folder in Exports, shown in Finder. */
  exportDiagnostics: () => invoke<string>("export_diagnostics"),
  previewSpace: () => invoke<T.PreviewSpace>("preview_space"),
  clearPreviews: () => invoke<number>("clear_previews"),
  lookFolders: () => invoke<T.LookFolder[]>("look_folders"),
  /** Stops using a look folder; returns [removed, kept because photos use them]. */
  removeLookFolder: (path: string) => invoke<[number, number]>("remove_look_folder", { path }),
  listBackups: () => invoke<T.BackupInfo[]>("list_backups"),
  backupNow: () => invoke<T.BackupInfo>("backup_now"),
  /** Saves the library as it is now, then restarts the app with this backup in place. */
  restoreBackup: (name: string) => invoke<void>("restore_backup", { name }),
  /** The backup restored at this launch, told once. */
  restoreNote: () => invoke<string | null>("restore_note"),
  /** Voice culling: listen to the microphone (on this Mac only) for yes / no / maybe. */
  voiceStart: () => invoke<void>("voice_start"),
  voiceStop: () => invoke<void>("voice_stop"),
  /** Stop listening for a moment (a video is playing) without letting go of the microphone helper. */
  voicePause: (paused: boolean) => invoke<void>("voice_pause", { paused }),
  /** What macOS allows (microphone, speech recognition), asked without any prompt. */
  voiceStatus: () => invoke<T.VoiceStatus>("voice_status"),
  voiceTrace: (message: string) => invoke<void>("voice_trace", { message }),
  voiceOpenSettings: (what: "mic" | "speech") => invoke<void>("voice_open_settings", { what }),
  reveal: (path: string) => invoke<void>("reveal", { path }),
  openLink: (url: string) => invoke<void>("open_link", { url }),

  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),
};

// Images and LUTs come from the Rust side through the cba:// scheme, by id
// only. The dev preview swaps these for generated stand-ins.
const onWindows = navigator.userAgent.includes("Windows");
const base = onWindows ? "http://cba.localhost" : "cba://localhost";

export type ImageKind = "thumb" | "preview" | "full" | "original" | "video" | "editvideo" | "fullvideo";

export const assets = {
  image: (kind: ImageKind, id: string): string => `${base}/${kind}/${id}`,
  /** A web copy from the portfolio site ("/media/img/…"), for the Archive tab. */
  site: (path: string): string => `${base}/site${path}`,
  lut: async (id: string): Promise<Uint8Array> => {
    const res = await fetch(`${base}/lut/${id}`);
    if (!res.ok) throw new Error(`look ${id}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
};

export function imageUrl(kind: ImageKind, id: string): string {
  return assets.image(kind, id);
}

/** Online: a picture at the size it is shown (CSS width × screen density), so
 *  tiles and the viewer are never blurred by a fixed small size. Null on the
 *  Mac, where the app's own cache serves sharp sizes. */
export const sized: { url: null | ((id: string, cssWidth: number) => string | null) } = { url: null };
export function sizedImageUrl(kind: ImageKind, id: string, cssWidth: number | null): string {
  return (cssWidth && sized.url?.(id, cssWidth)) || imageUrl(kind, id);
}

// Headers carry ASCII only (anything past U+00FF even throws), so a name like
// "Café · Gent" travels as base64 UTF-8; plain names are also sent as is.
function nameHeaders(name: string): Record<string, string> {
  const utf8 = new TextEncoder().encode(name);
  const b64 = btoa(Array.from(utf8, (b) => String.fromCharCode(b)).join(""));
  return /^[\x20-\x7e]*$/.test(name) ? { "x-name": name, "x-name-b64": b64 } : { "x-name-b64": b64 };
}

/** A finished export, shown selected in Finder. */
export function showInFinder(path: string): void {
  void api.reveal(path).catch(() => {});
}

export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
