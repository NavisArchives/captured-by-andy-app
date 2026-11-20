// The Roadmap tab's data: a plan of options for a season of work, sorted
// into lanes, with phases, a checklist and open questions. This public
// snapshot ships a short FICTIONAL sample; the real plan is private.
// The user's own answers (yes / talk / not now, notes, ticks) live in a
// setting, never here.

export type Lane = "paperwork" | "base" | "clients" | "stays" | "boards" | "volunteer" | "grants" | "events" | "sell" | "audience";

export const LANES: { id: Lane; label: string; line: string }[] = [
  { id: "paperwork", label: "Papers", line: "Entry, insurance, permits, getting paid" },
  { id: "base", label: "Where to live", line: "Cities, rent, coworking, seasons" },
  { id: "clients", label: "Paid clients", line: "Work that pays in money" },
  { id: "stays", label: "Hotels & lodges", line: "Stays and fees in exchange for content" },
  { id: "boards", label: "Tourism", line: "Tourism boards and tour operators" },
  { id: "volunteer", label: "Give & exchange", line: "Volunteering, NGOs, skill swaps" },
  { id: "grants", label: "Grants", line: "Money for personal work, residencies, prizes" },
  { id: "events", label: "Moments", line: "Festivals and seasons worth being there for" },
  { id: "sell", label: "Sell the work", line: "Magazines, licensing, prints, back home" },
  { id: "audience", label: "Audience", line: "What to post and who to know" },
];

export type Odds = "strong" | "fair" | "long";
export type Effort = "light" | "medium" | "heavy";

export type Option = {
  id: string;
  lane: Lane;
  title: string;
  /** What it is, in one or two plain sentences. */
  what: string;
  /** Why it suits Andy (or why it might not). */
  why: string;
  /** What to do, in order. */
  how: string[];
  /** What it gives: money, a bed, exposure, a client for later. */
  gives: string;
  odds: Odds;
  effort: Effort;
  /** A date that matters (deadline, event), ISO, for the calendar. */
  date?: string;
  /** How to read that date, e.g. "Deadline" or "Festival". */
  dateLabel?: string;
  /** My first picks. */
  pick?: boolean;
  links: { label: string; href: string }[];
};

export type Phase = { id: string; title: string; when: string; line: string; steps: { text: string; option?: string }[] };

export type Question = { id: string; ask: string; why: string };

export type Roadmap = {
  updated: string;
  brief: string[];
  phases: Phase[];
  options: Option[];
  checklist: { id: string; text: string; lead: string }[];
  questions: Question[];
};


export const ROADMAP: Roadmap = {
  updated: "2026-01-15",
  brief: [
    "A sample season: three months in the mountains, building one photo series and a few paid commissions around it.",
    "Each option says what it is, why it fits, what it takes and what it gives. Pick a handful; the rest stays here for later.",
  ],
  phases: [
    { id: "ph1", title: "Before you go", when: "Weeks 1–2", line: "Papers, kit and two first pitches", steps: [{ text: "Check insurance and kit", option: "o1" }, { text: "Pitch the lodge series", option: "o2" }] },
    { id: "ph2", title: "On site", when: "Weeks 3–10", line: "Shoot the series, deliver the commissions", steps: [{ text: "Shoot at first light, edit in the afternoon", option: "o3" }] },
  ],
  options: [
    { id: "o1", lane: "paperwork", title: "Travel insurance that covers equipment", what: "A policy that includes cameras and drones.", why: "The kit is the business.", how: ["Compare two policies", "Photograph serial numbers"], gives: "Peace of mind", odds: "strong", effort: "light", links: [{ label: "Example insurer", href: "https://example.org/insurance" }] },
    { id: "o2", lane: "stays", title: "Mountain lodge content exchange", what: "A week's stay in exchange for a photo set of the lodge.", why: "Matches the landscape series.", how: ["Send three sample frames", "Agree on usage rights"], gives: "A bed and a client for later", odds: "fair", effort: "medium", pick: true, links: [{ label: "Example lodge", href: "https://example.org/lodge" }] },
    { id: "o3", lane: "sell", title: "Print sale of the series", what: "A small edition of prints from the season.", why: "Turns personal work into income.", how: ["Choose twelve frames", "Order test prints"], gives: "Money and a portfolio piece", odds: "fair", effort: "heavy", date: "2026-04-01", dateLabel: "Launch", links: [{ label: "Example print lab", href: "https://example.org/prints" }] },
  ],
  checklist: [
    { id: "c1", text: "Back up cards every night", lead: "Daily" },
    { id: "c2", text: "Charge batteries and clean sensors", lead: "Weekly" },
  ],
  questions: [{ id: "q1", ask: "Which lodge answers first?", why: "It sets the first two weeks." }],
};
