// What still stands between a post and Instagram. Only blockers stop the next
// step; the rest are reminders you can post anyway.
import type { PostDetail } from "../types";

// Instagram limits posts to 5 hashtags (Dec 2025). Change it here if that moves.
export const HASHTAG_LIMIT = 5;

export type Fix =
  | { kind: "addPhotos" }
  | { kind: "pickAccount" }
  | { kind: "writeCaption" }
  | { kind: "edit"; ids: string[] }
  | null;

export interface Issue {
  key: "photos" | "account" | "caption" | "hashtags" | "unedited";
  text: string;
  /** Stops the post from going to Ready, Scheduled or Published. */
  block: boolean;
  fix: Fix;
}

export function hashtags(caption: string): number {
  return caption.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
}

export function readiness(post: PostDetail, caption: string, hasAccounts: boolean): Issue[] {
  const out: Issue[] = [];
  if (!post.photos.length) out.push({ key: "photos", text: "No photos yet", block: true, fix: { kind: "addPhotos" } });
  // The account grid only shows posts that have an account.
  if (!post.accountId && hasAccounts) out.push({ key: "account", text: "No account", block: true, fix: { kind: "pickAccount" } });
  if (!caption.trim()) out.push({ key: "caption", text: "No caption yet", block: false, fix: { kind: "writeCaption" } });
  const tags = hashtags(caption);
  if (tags > HASHTAG_LIMIT) out.push({ key: "hashtags", text: `${tags} hashtags (Instagram allows ${HASHTAG_LIMIT})`, block: false, fix: null });
  // Weak when Settings applies a look on select, but fine for a reminder.
  const unedited = post.photos.filter((p) => !p.edited).map((p) => p.id);
  if (unedited.length) {
    const text = unedited.length === 1 ? "1 photo without a look" : `${unedited.length} photos without a look`;
    out.push({ key: "unedited", text, block: false, fix: { kind: "edit", ids: unedited } });
  }
  return out;
}

/** The first blocker as a short instruction, or null when nothing blocks. */
export function blocker(issues: Issue[]): string | null {
  const b = issues.find((i) => i.block);
  if (!b) return null;
  return b.key === "photos" ? "Add photos first" : "Pick an account first";
}
