// Shapes of everything the Rust core sends and receives (serde camelCase).
export type ReviewState = "unreviewed" | "selected" | "maybe" | "rejected";
export type StorageState = "local" | "cloud_only" | "missing" | "downloading" | "available_offline";
export type MediaKind = "raw" | "image" | "raw_image";
export type ThumbState = "pending" | "ready" | "failed" | "unavailable";
export type Social = "unused" | "assigned" | "ready" | "posted";
export type Order = "newest" | "oldest" | "recentlyReviewed";
export type SocialFilter = "unused" | "assigned" | "posted" | "posted_multiple";
export type StorageFilter = "local" | "cloud_only" | "offline" | "missing" | "archived";
export type Smart =
  | "soft"
  | "dark"
  | "bright"
  | "burst_extras"
  | "bursts"
  | "selected_unposted"
  | "no_album"
  | "edited"
  | "not_edited_selected"
  | "last_import";

export interface PhotoRow {
  id: string;
  review: ReviewState;
  media: MediaKind;
  capturedAt: string;
  filename: string;
  storage: StorageState;
  thumb: ThumbState;
  thumbhash: string | null;
  width: number | null;
  height: number | null;
  social: Social;
  postedCount: number;
  archived: boolean;
  edited: boolean;
  burst: number;
  burstBest: boolean;
  soft: boolean;
  isVideo: boolean;
  /** A video's length in seconds. */
  duration: number | null;
}

export interface AssetInfo {
  id: string;
  filename: string;
  path: string;
  format: string;
  size: number;
  storage: StorageState;
  isPrimary: boolean;
  isRaw: boolean;
  localCopy: string | null;
  archivedTo: string[];
  finderTagged: boolean;
}

export interface AlbumRef {
  id: string;
  name: string;
}

export interface Tag {
  id: string;
  name: string;
  slug: string;
  usage: number;
}

export type PostStatus = "idea" | "building" | "ready" | "scheduled" | "published" | "archived";

export interface Usage {
  postId: string;
  title: string;
  status: PostStatus;
  accountUsername: string | null;
  publishedAt: string | null;
  scheduledAt: string | null;
  position: number;
}

export interface PhotoDetail extends PhotoRow {
  capturedAtSource: "exif" | "file";
  cameraMake: string | null;
  cameraModel: string | null;
  latitude: number | null;
  longitude: number | null;
  assets: AssetInfo[];
  albums: AlbumRef[];
  tags: Tag[];
  history: Usage[];
}

export interface Query {
  review?: ReviewState | null;
  order?: Order;
  album?: string | null;
  tag?: string | null;
  media?: MediaKind | null;
  storage?: StorageFilter | null;
  social?: SocialFilter | null;
  account?: string | null;
  /** The iPhone, or any camera. */
  device?: "iphone" | "camera" | null;
  post?: string | null;
  from?: string | null;
  to?: string | null;
  hasLocation?: boolean | null;
  search?: string | null;
  /** What's in the photo, exactly as recognised (`blue_sky`): any of them. */
  labels?: string[] | null;
  smart?: Smart | null;
  /** A trip folder (absolute path): its photos and those of its subfolders. */
  folder?: string | null;
  /** Only videos (true) or only photos (false). */
  video?: boolean | null;
  /** Leave out photos whose original is gone (moved outside the app) and that have no copy. */
  hideMissing?: boolean;
  /** Leave out rejected photos (phone browsing; rejects have their own filter). */
  excludeRejected?: boolean;
  /** Only these photos. */
  ids?: string[] | null;
}

/** A trip folder in the Pictures sidebar. */
export interface Folder {
  path: string;
  name: string;
  source: string;
  depth: 1 | 2;
  count: number;
}

/** One file's move to another trip, kept for Undo. */
export interface FileMove {
  assetId: string;
  from: string;
  to: string;
}

export interface MoveReport {
  moved: number;
  /** Already in that trip. */
  already: number;
  failed: string[];
  undo: FileMove[];
}

/** A photo whose GPS puts it far from the rest of its trip. */
export interface Misplaced {
  id: string;
  /** The trip folder it most likely belongs to. */
  near: string | null;
}

export interface ReviewMark {
  id: string;
  review: ReviewState;
  reviewedMs: number | null;
}

export interface Counts {
  all: number;
  unreviewed: number;
  selected: number;
  maybe: number;
  rejected: number;
}

export interface SmartCounts {
  soft: number;
  dark: number;
  bright: number;
  burstExtras: number;
  /** Burst extras still to review: what the dashboard suggests culling. */
  burstExtrasUnreviewed: number;
  bursts: number;
  burstsUnreviewed: number;
  selectedUnposted: number;
  noAlbum: number;
  edited: number;
  notEditedSelected: number;
  analysed: number;
  /** Photos the last scan with new files added, and how many are unreviewed. */
  lastImport: number;
  lastImportUnreviewed: number;
}

export interface Source {
  id: string;
  path: string;
  label: string;
  enabled: boolean;
  lastScanFinishedMs: number | null;
  photoCount: number;
  online: boolean;
}

/** Adding a folder: the source for it, or the one that already covers it. */
export interface AddedSource {
  source: Source;
  alreadyCovered: boolean;
  /** Folders indexed on their own before, now part of this one (nothing lost). */
  merged: string[];
}

export interface ScanStats {
  discovered: number;
  added: number;
  updated: number;
  moved: number;
  unchanged: number;
  cloudOnly: number;
  missing: number;
  paired: number;
  errors: number;
  /** Files not marked missing because the scan couldn't read everything. */
  held: number;
  cancelled: boolean;
}

/** The online library (Supabase) and this Mac: on the Mac its own last round, online the Mac's last heartbeat. */
export interface SyncStatus {
  configured: boolean;
  running: boolean;
  lastOkMs: number | null;
  error: string | null;
  /** Online: this is the Mac's last sync as the phone sees it. */
  remote?: boolean;
}

export interface ScanStatus {
  running: boolean;
  source: string | null;
  stats: ScanStats;
  error: string | null;
  thumbsQueued: number;
}

export interface LibraryInfo {
  dbPath: string;
  cacheDir: string;
  looksDir: string;
  exportsDir: string;
}

export interface Album {
  id: string;
  name: string;
  description: string;
  coverPhotoId: string | null;
  coverThumbhash: string | null;
  photoCount: number;
  createdMs: number;
  updatedMs: number;
}

export interface Account {
  id: string;
  platform: string;
  displayName: string;
  username: string;
  avatarPhotoId: string | null;
  avatarThumbhash: string | null;
  followerCount: number | null;
  followingCount: number | null;
  publishedPostCount: number | null;
  notes: string;
  bio: string;
  link: string;
  category: string;
  drafts: number;
  ready: number;
  published: number;
  createdMs: number;
  updatedMs: number;
}

export interface AccountInput {
  username?: string;
  displayName?: string;
  avatarPhotoId?: string;
  followerCount?: number | null;
  followingCount?: number | null;
  publishedPostCount?: number | null;
  notes?: string;
  bio?: string;
  link?: string;
  category?: string;
}

export interface Post {
  id: string;
  accountId: string | null;
  accountUsername: string | null;
  title: string;
  caption: string;
  notes: string;
  status: PostStatus;
  scheduledAt: string | null;
  publishedAt: string | null;
  planOrder: number | null;
  pinned: boolean;
  photoCount: number;
  coverPhotoId: string | null;
  coverThumbhash: string | null;
  createdMs: number;
  updatedMs: number;
  /** How the post is exported: one ratio for the whole carousel. */
  exportRatio: PostRatio;
  /** Where the 3:4 grid tile sits on the cover, -1 (left/top) to 1 (right/bottom). */
  tileOffset: number;
}

export type PostRatio = "3:4" | "4:5" | "1:1";

export interface Reuse extends Usage {
  photoId: string;
}

export interface PostDetail extends Post {
  photos: PhotoRow[];
  reused: Reuse[];
}

export interface PostInput {
  exportRatio?: PostRatio;
  tileOffset?: number;
  title?: string;
  caption?: string;
  notes?: string;
  accountId?: string;
  status?: PostStatus;
  scheduledAt?: string;
  publishedAt?: string;
  pinned?: boolean;
}

export interface Pipeline {
  idea: number;
  building: number;
  ready: number;
  scheduled: number;
  published: number;
  archived: number;
}

export interface Summary {
  counts: Counts;
  selectedUnposted: number;
  cloudOnly: number;
  missing: number;
  thumbsPending: number;
  offlineCopies: number;
  pipeline: Pipeline;
  accounts: Account[];
  albums: Album[];
  sources: Source[];
  lastScanMs: number | null;
}

/** `saved`: one of yours, saved from an edit (a look plus its sliders). */
export type LookKind = "preset" | "cube" | "hald" | "saved";

export interface Look {
  id: string;
  kind: LookKind;
  name: string;
  author: string;
  collection: string;
  sourcePath: string;
  effects: { grain: number; vignette: number };
  swatch: string[];
  baked: boolean;
  usedBy: number;
  favorite: number | null;
  /** A saved look's sliders, applied with it (never the crop). */
  adjustments?: Adjustments;
}

export interface Adjustments {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  temperature: number;
  tint: number;
  vibrance: number;
  saturation: number;
  grain: number;
  vignette: number;
  /** Effects, 0..100: a matte fade, softness, film halation, colour fringes,
   *  tape scan lines, gate weave and a light leak. */
  fade: number;
  soften: number;
  halation: number;
  fringe: number;
  scanlines: number;
  weave: number;
  leak: number;
  /** Straightening, degrees clockwise. */
  straighten: number;
  /** Crop centre as an offset from the middle, percent of width / height (down is positive). */
  cropX: number;
  cropY: number;
  /** Extra zoom into the crop, 0..100 (100 = twice as close). */
  cropZoom: number;
}

export const NO_ADJUSTMENTS: Adjustments = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  vibrance: 0,
  saturation: 0,
  grain: 0,
  vignette: 0,
  fade: 0,
  soften: 0,
  halation: 0,
  fringe: 0,
  scanlines: 0,
  weave: 0,
  leak: 0,
  straighten: 0,
  cropX: 0,
  cropY: 0,
  cropZoom: 0,
};

/** Everything the recogniser found across the library, most common first. */
export interface LabelList {
  labels: { label: string; count: number }[];
  /** Everyday words and the labels they stand for ("portrait" → people). */
  synonyms: [string, string[]][];
}

/** An edit without its framing: what a look carries from photo to photo. */
export interface Recipe {
  lookId: string | null;
  strength: number;
  adjustments: Adjustments;
}

/** The look for a photo's album: the album's own (`set`), or a suggestion
 *  from the edit its photos use most. Never the framing. */
export interface AlbumLook extends Recipe {
  albumId: string;
  albumName: string;
  set: boolean;
  /** Set: the album's photos exactly on it. Suggested: photos using its look. */
  uses: number;
  /** This photo's edit is exactly this look. */
  thisPhoto: boolean;
}

/** What changing an album's look did, for Undo. */
export interface AlbumLookChange {
  previous: Recipe | null;
  /** The photos moved along, as they were. */
  updated: PhotoLook[];
  /** Photos with an edit of their own, left alone. */
  leftAlone: number;
}

export interface PhotoLook {
  photoId: string;
  lookId: string | null;
  strength: number;
  adjustments: Adjustments;
  /** A clip filmed in S-Log3: shown and exported in normal colour. */
  log?: boolean;
}

export interface SyncReport {
  tagged: number;
  untagged: number;
  skipped: number;
  failed: number;
}

export interface OfflineReport {
  copied: number;
  already: number;
  skippedCloud: number;
  missing: number;
  failed: number;
  removed: number;
  bytes: number;
}

export interface OfflineInfo {
  dir: string;
  photos: number;
  bytes: number;
  auto: boolean;
  allowCloud: boolean;
  includeRaw: boolean;
}

export interface Location {
  id: string;
  kind: string;
  label: string;
  root: string;
  online: boolean;
  archivedCount: number;
  archivedBytes: number;
  createdMs: number;
}

export interface ArchiveReport {
  archived: number;
  already: number;
  skippedCloud: number;
  missing: number;
  failed: number;
  bytes: number;
  errors: string[];
}

export function totalFor(counts: Counts | null, review: ReviewState | null | undefined): number {
  if (!counts) return 0;
  return review ? counts[review] : counts.all;
}

/** A spoken command in Cull ("yes" → select, "no" → reject…). */
export type VoiceCommand = "select" | "reject" | "maybe" | "undo" | "skip" | "zoom";

/** What the voice helper reports. */
export type VoiceEvent =
  | { kind: "listening" }
  | { kind: "paused" }
  | { kind: "stopped" }
  | { kind: "command"; command: VoiceCommand; word: string }
  | { kind: "denied"; what: string }
  | { kind: "error"; message: string };

/** Voice permissions and availability ("authorized" | "denied" | "restricted" | "undecided"). */
export interface VoiceStatus {
  speech: string;
  mic: string;
  ondevice: boolean;
  available: boolean;
  microphones: number;
}

/** A copy of the library file (marks, albums, tags, edits, posts; never photos). */
export interface BackupInfo {
  name: string;
  createdMs: number;
  size: number;
  kind: "daily" | "manual" | "before-restore" | "before-upgrade";
}

export interface PreviewSpace {
  used: number;
  max: number;
  dir: string;
}

export interface LookFolder {
  path: string;
  /** Added by hand; otherwise found automatically. */
  added: boolean;
  looks: number;
}

/** A good part of a video, marked with in and out points (seconds). */
export interface VideoMoment {
  id: string;
  photoId: string;
  start: number;
  end: number;
}

/** From Apple's image analysis: how far the horizon rises to the right (degrees), and the main subject (x, y, w, h from the top left). */
export interface FrameHint {
  photoId: string;
  horizon: number | null;
  subject: [number, number, number, number] | null;
}

// Clean up: deleting rejected photos for good, one trip at a time.
export interface TripCleanup {
  trip: string;
  name: string;
  photos: number;
  bytes: number;
  toDelete: number;
  bytesToDelete: number;
  kept: number;
  /** Near-copies of a photo that was kept: the safest to delete. */
  copies: number;
  bytesCopies: number;
}
export interface CleanupOverview {
  trips: TripCleanup[];
  protected: number;
}
export type CleanupSet = "copy" | "scene" | "soft" | "utility";
export interface CleanupCandidate {
  id: string;
  mark: "delete" | "keep" | null;
  bytes: number;
  sets: CleanupSet[];
}
export interface CleanupReport {
  batch: string;
  photos: number;
  bytes: number;
  failed: string[];
}
export interface CleanupBatch {
  batch: string;
  trip: string;
  name: string;
  deletedMs: number;
  photos: number;
  bytes: number;
  restored: boolean;
  phoneFound: number;
  phoneDeleted: number;
  phoneChecked: boolean;
}
export interface PhoneFind {
  asked: number;
  found: number;
  denied: boolean;
}

// Places inside a trip (THAILAND › PAI), found from where the photos were taken.
export interface ProposedPlace {
  key: string;
  name: string;
  existing: boolean;
  country: string;
  lat: number;
  lon: number;
  photos: number;
  located: number;
  sample: string[];
}
export interface PlaceProposal {
  trip: string;
  country: string;
  places: ProposedPlace[];
  elsewhere: number;
  loose: number;
  looseLocated: number;
}

// The morning brief: what needs Andy today beyond the photo counts.
export interface MorningBrief {
  cleanupCopies: number;
  cleanupCopiesBytes: number;
  cleanupBytes: number;
  postsReady: number;
  savesInbox: number;
  unpaid: { id: string; client: string; campaign: string; amount: number | null; currency: string | null; fee: string; sentDate: string | null }[];
  diskFree: number | null;
  /** Open decisions on the agency board: "D1 Brand via agency: …". */
  decisions: string[];
}
