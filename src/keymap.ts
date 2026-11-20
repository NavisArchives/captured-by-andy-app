// Keyboard shortcuts are data: the defaults below can be overridden per action
// by a JSON object stored in the `keymap` setting, e.g. {"select": ["p"]}.
export type Action = "select" | "reject" | "maybe" | "unmark" | "previous" | "next" | "focus" | "exit";

export type Keymap = Record<Action, string[]>;

export const DEFAULT_KEYMAP: Keymap = {
  select: ["a"],
  reject: ["d", "r"],
  maybe: ["s"],
  unmark: ["u"],
  previous: ["ArrowLeft"],
  next: ["ArrowRight"],
  focus: [" "],
  exit: ["Escape"],
};

export const ACTION_LABELS: Record<Action, string> = {
  select: "Select, then next",
  reject: "Reject, then next",
  maybe: "Maybe, then next",
  unmark: "Back to unreviewed",
  previous: "Previous photo",
  next: "Next photo",
  focus: "Focus view (on a video: play / pause)",
  exit: "Leave focus / cull",
};

export function parseKeymap(stored: string | null): Keymap {
  if (!stored) return DEFAULT_KEYMAP;
  try {
    const custom = JSON.parse(stored) as Partial<Keymap>;
    const merged = { ...DEFAULT_KEYMAP };
    for (const action of Object.keys(DEFAULT_KEYMAP) as Action[]) {
      const keys = custom[action];
      if (Array.isArray(keys) && keys.length > 0 && keys.every((k) => typeof k === "string" && k.length > 0)) merged[action] = keys;
    }
    return repairKeymap(merged) ?? DEFAULT_KEYMAP;
  } catch {
    return DEFAULT_KEYMAP;
  }
}

/** Gives every action that has no key a free default key; null if impossible. */
export function repairKeymap(k: Keymap): Keymap | null {
  const next = { ...k };
  for (const a of Object.keys(next) as Action[]) {
    if (next[a].length) continue;
    const used = new Set(Object.values(next).flat());
    const free = DEFAULT_KEYMAP[a].filter((x) => !used.has(x));
    if (!free.length) return null;
    next[a] = free;
  }
  return next;
}

/** Keys that can't work as a shortcut on their own. */
export function unbindable(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey || e.altKey || ["Meta", "Control", "Alt", "Shift", "CapsLock", "Tab", "Dead", "Unidentified", "Enter"].includes(e.key);
}

export function actionFor(event: KeyboardEvent, keymap: Keymap): Action | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const target = event.target as HTMLElement | null;
  if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.closest?.('[aria-haspopup="listbox"], .select-pop'))) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  for (const action of Object.keys(keymap) as Action[]) {
    if (keymap[action].some((k) => (k.length === 1 ? k.toLowerCase() : k) === key)) return action;
  }
  return null;
}

export function keyLabel(key: string): string {
  const names: Record<string, string> = { " ": "Space", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc" };
  return names[key] ?? key.toUpperCase();
}

/** The first key bound to an action, for labels; never throws if an action lost its keys. */
export function firstKeyLabel(keys: string[] | undefined): string {
  return keys && keys.length ? keyLabel(keys[0]) : "—";
}

/** The number key pressed (0-9) by its physical position, so AZERTY works without Shift. */
export function digitOf(e: KeyboardEvent): number | null {
  if (e.altKey || e.metaKey || e.ctrlKey) return null;
  const m = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
  if (m) return Number(m[1]);
  return /^[0-9]$/.test(e.key) ? Number(e.key) : null;
}
