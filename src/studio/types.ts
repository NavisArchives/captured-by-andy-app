// Studio's records as the Rust side stores them (camelCase rows). JSON
// fields (brief, disclosure, posts) arrive as strings and are parsed here.

export type Platform = "tiktok" | "instagram" | "youtube";
export type IdeaStatus = "inbox" | "keep" | "maybe" | "parked" | "dropped" | "greenlit";
export type Stage = "planned" | "shot" | "editing" | "ready" | "posted" | "reviewed";
export type FamilyKind = "series" | "campaign" | "singles";

interface Stamped {
  id: string;
  createdMs: number;
  updatedMs: number;
}

export interface Pillar extends Stamped {
  name: string;
  position: number;
  folder: string;
}

export interface Family extends Stamped {
  pillarId: string;
  kind: FamilyKind;
  name: string;
  code: string;
  client: string;
  folder: string;
  archived: number;
}

export interface Idea extends Stamped {
  title: string;
  hook: string;
  format: string;
  pillarId: string | null;
  familyId: string | null;
  platforms: string;
  status: IdeaStatus;
  scoreHook: number | null;
  scoreSend: number | null;
  scoreFit: number | null;
  scoreEase: number | null;
  notes: string;
  source: string;
  deadline: string | null;
  pieceId: string | null;
  touchedMs: number;
}

export interface Piece extends Stamped {
  ideaId: string | null;
  pillarId: string | null;
  familyId: string | null;
  title: string;
  episode: number | null;
  code: string;
  format: string;
  platforms: string;
  stage: Stage;
  parked: number;
  waitingBrand: number;
  folder: string | null;
  brief: string;
  shootDayId: string | null;
  plannedDate: string | null;
  isPaid: number;
  brandJobId: string | null;
  disclosure: string;
  posts: string;
  notes: string;
}

export interface Save extends Stamped {
  kind: "link" | "image" | "video" | "note";
  platform: string;
  url: string;
  urlKey: string;
  title: string;
  author: string;
  filePath: string | null;
  thumb: string | null;
  why: string;
  chips: string;
  tags: string;
  autoLabels: string;
  ocrText: string;
  transcript: string;
  transcriptionState?: "" | "queued" | "running" | "complete" | "failed";
  transcriptionError?: string;
  transcriptSegments?: string;
  transcriptLanguage?: string;
  status: "inbox" | "library" | "archived";
  /** What it's inspiration for (see TOPICS); "" until picked. */
  topic: string;
  pillarId: string | null;
  capturedVia: string;
  analysedMs: number | null;
  linkOk: number | null;
  checkedMs: number | null;
  resurfacedMs: number | null;
  resurfaceCount: number;
  /** The board it's gathered into, if any. */
  boardId: string | null;
  existing?: boolean;
}

/** Saves gathered into one: a clinic's videos and its website, for a client or a series. */
export interface Board extends Stamped {
  title: string;
  notes: string;
  /** Who it's for ("Dr Example"); "" when it isn't for a client. */
  client: string;
  pillarId: string | null;
  /** A series or campaign (Studio's projects). */
  familyId: string | null;
}

export interface ShootDay extends Stamped {
  date: string;
  title: string;
  location: string;
  notes: string;
}

export interface BrandJob extends Stamped {
  client: string;
  campaign: string;
  familyId: string | null;
  brief: string;
  deliverables: string;
  reviewDate: string | null;
  liveDate: string | null;
  revisionsAllowed: number | null;
  revisionsUsed: number;
  rights: string;
  rightsEnd: string | null;
  exclusivityEnd: string | null;
  paidAdsEnd: string | null;
  fee: string;
  invoiceNo: string;
  invoiceStatus: "none" | "sent" | "paid";
  paidDate: string | null;
  notes: string;
  /** When the invoice went out ("2026-09-10"). */
  invoiceSentDate: string | null;
  /** The fee as a number, with its currency ("EUR"). */
  amount: number | null;
  currency: string | null;
}

export interface Review extends Stamped {
  pieceId: string;
  platform: string;
  views: number | null;
  watchTime: number | null;
  skipRate: number | null;
  sends: number | null;
  saves: number | null;
  follows: number | null;
  learning: string;
}

export interface Watch extends Stamped {
  platform: string;
  handle: string;
  notes: string;
  last: string;
  checkedMs: number | null;
}

export interface Lists {
  pillars: Pillar;
  families: Family;
  ideas: Idea;
  pieces: Piece;
  saves: Save;
  shootDays: ShootDay;
  brandJobs: BrandJob;
  reviews: Review;
  watch: Watch;
  boards: Board;
}

export interface Summary {
  pillars: number;
  ideasInbox: number;
  ideasKept: number;
  toFilm: number;
  inProgress: number;
  ready: number;
  postingThisWeek: number;
  reviewsDue: number;
  savesInbox: number;
  brandAlerts: number;
  root: string;
}

export interface Trend {
  title: string;
  traffic: string;
  news: string[];
  link: string;
}

export interface Found {
  url: string;
  title: string;
  author: string;
  thumbUrl: string;
}

export interface ExportCheck {
  path: string;
  seconds: number;
  width: number;
  height: number;
  megabytes: number;
  notes: string[];
}

// ---------------------------------------------------------------- the brief

export interface Hook {
  id: string;
  spoken: string;
  text: string;
  frame: string;
  type: string;
  chosen: boolean;
}

export interface Beat {
  id: string;
  visual: string;
  audio: string;
  text: string;
  broll: string;
  setup: string;
}

export interface Shot {
  id: string;
  setup: string;
  what: string;
  framing: string;
  done: boolean;
}

export interface Brief {
  template?: string;
  lengthS?: number;
  goal?: string;
  audience?: string;
  cta?: string;
  hooks?: Hook[];
  beats?: Beat[];
  shots?: Shot[];
  location?: string;
  props?: string;
  wardrobe?: string;
  kit?: Record<string, boolean>;
  sound?: string;
  caption?: string;
  hashtags?: string;
  cover?: string;
  brand?: { product?: string; messages?: string; claims?: string; musts?: string; donts?: string };
  exportPath?: string;
  // ---- Production: one project in six steps (see docs/superpowers/specs/2026-10-29-production-flow-design.md)
  steps?: Partial<Record<StepId, StepStatus>>;
  /** Saves and boards from Inspire, each with what Andy likes about it. */
  inspo?: InspoLink[];
  style?: StyleSheet;
  /** Music and sound effects. (`sound` above is the older one-line note.) */
  sounds?: SoundItem[];
  edit?: EditState;
  /** Per clip (photo id): needs levelling, and Claude's picks. */
  footage?: Record<string, FootageMark>;
  /** Hash of the data last written to 00_PLAN/project.md: a different one there means Claude changed it. */
  fileHash?: string;
}

export type StepId = "script" | "inspo" | "footage" | "sound" | "cut" | "post";
export type StepStatus = "todo" | "andy" | "claude" | "done";

export const STEPS: { id: StepId; label: string }[] = [
  { id: "script", label: "Idea & script" },
  { id: "inspo", label: "Inspiration & style" },
  { id: "footage", label: "Footage" },
  { id: "sound", label: "Sound" },
  { id: "cut", label: "Cut" },
  { id: "post", label: "Finish & post" },
];

export const STEP_STATUS: { id: StepStatus; label: string }[] = [
  { id: "todo", label: "To do" },
  { id: "andy", label: "With Andy" },
  { id: "claude", label: "With Claude" },
  { id: "done", label: "Done" },
];

export interface InspoLink {
  id: string;
  saveId?: string;
  boardId?: string;
  note: string;
}

export interface StyleSheet {
  pace?: string;
  cutLength?: string;
  slowMoments?: string;
  type?: string;
  colour?: string;
  musicMood?: string;
  notes?: string;
}

export interface SoundItem {
  id: string;
  file: string;
  kind: "music" | "sfx";
  /** Where it's from: the library or site, the artist, a link. */
  source: string;
  licensed: boolean;
}

/** One clip on a Final Cut timeline, in seconds. */
export interface CutClip {
  name: string;
  /** Where it sits on the timeline. */
  at: number;
  duration: number;
  /** Where it starts in its source. */
  from: number;
  /** 0 on the main line; other numbers above or below it. */
  lane: number;
  kind: string;
}

export interface CutRead {
  path: string;
  readMs: number;
  project: string;
  duration: number;
  clips: CutClip[];
}

export interface EditState {
  /** The project's FCPXML (Claude's draft, opened in Final Cut). */
  fcpxml?: string;
  /** The last edit read back from Final Cut, and the one before it. */
  lastRead?: CutRead;
  previous?: CutRead;
}

export interface FootageMark {
  level?: boolean;
  picks?: string;
}

export interface PieceFile {
  path: string;
  name: string;
  folder: string;
  size: number;
  modifiedMs: number;
}

export interface PlanFile {
  path: string;
  contents: string;
  modifiedMs: number;
}

export interface Disclosure {
  label?: boolean;
  tag?: boolean;
  toggle?: boolean;
}

export interface Posted {
  platform: string;
  url: string;
  at: string;
  file: string;
}

export function parse<T>(text: string | null | undefined, fallback: T): T {
  try {
    const v = text ? JSON.parse(text) : fallback;
    return v && typeof v === "object" ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export const STAGES: { id: Stage; label: string }[] = [
  { id: "planned", label: "Planned" },
  { id: "shot", label: "Shot" },
  { id: "editing", label: "In CapCut" },
  { id: "ready", label: "Ready" },
  { id: "posted", label: "Posted" },
  { id: "reviewed", label: "Reviewed" },
];

export const stageLabel = (s: Stage) => STAGES.find((x) => x.id === s)?.label ?? s;

export function score(i: Idea): number | null {
  const parts = [i.scoreHook, i.scoreSend, i.scoreFit, i.scoreEase];
  if (parts.every((p) => p == null)) return null;
  return parts.reduce<number>((a, b) => a + (b ?? 0), 0);
}

export function verdict(total: number | null): { label: string; tone: "good" | "mid" | "low" | "none" } {
  if (total == null) return { label: "Not scored", tone: "none" };
  if (total >= 15) return { label: "Write it", tone: "good" };
  if (total >= 10) return { label: "Rework", tone: "mid" };
  return { label: "Park it", tone: "low" };
}

export const platformsOf = (text: string): Platform[] => text.split(",").map((s) => s.trim()).filter(Boolean) as Platform[];
