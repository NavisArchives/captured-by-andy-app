// One-click steps for a post on the board, mirroring the editor's next-step button.
import type { Post, PostInput, PostStatus } from "../types";

export interface Step {
  status: PostStatus;
  /** Fields that change with the move. */
  patch?: PostInput;
}

export const NEXT: Partial<Record<PostStatus, Step & { label: string }>> = {
  idea: { status: "ready", label: "Ready" },
  building: { status: "ready", label: "Ready" },
  ready: { status: "published", label: "Published" },
  scheduled: { status: "published", label: "Posted" },
  archived: { status: "building", label: "Building" },
};

/** One step back, or null at the start of the line. */
export function prevStep(p: Pick<Post, "status" | "scheduledAt">): Step | null {
  switch (p.status) {
    case "building":
      return { status: "idea" };
    case "ready":
      return { status: "building" };
    case "scheduled":
      // Back to Ready means it is no longer planned for a time.
      return { status: "ready", patch: { scheduledAt: "" } };
    case "published":
      return { status: p.scheduledAt ? "scheduled" : "ready" };
    default:
      return null;
  }
}

/** An idea (or post being built) that already has a date is scheduled once it is ready. */
export function moveTarget(p: Pick<Post, "status" | "scheduledAt">, status: PostStatus): PostStatus {
  return status === "ready" && !!p.scheduledAt && (p.status === "idea" || p.status === "building") ? "scheduled" : status;
}

/** Nothing to post yet: these need at least one photo (the backend agrees). */
export function needsPhotos(status: PostStatus): boolean {
  return status === "ready" || status === "scheduled" || status === "published";
}

/** Local time as "YYYY-MM-DDTHH:MM", the format dates are stored in. Not
 *  toISOString: that is UTC and puts Belgium an hour or two behind. */
export function localNow(): string {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Scheduled and its time has come: it has probably gone out. */
export function isDue(p: Pick<Post, "status" | "scheduledAt">): boolean {
  return p.status === "scheduled" && !!p.scheduledAt && p.scheduledAt.slice(0, 16) <= localNow();
}
