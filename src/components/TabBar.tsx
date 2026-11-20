// The phone's floating glass tab bar (the same pattern as HQ's): four tabs
// (Amendment 3: Archive · Projects · Cull · More; Today is the wordmark),
// icon over an 11 px label, the current one in a soft pill. Shown on phones
// only (mobile.css); the desktop keeps its top navigation untouched.
import type { ReactNode } from "react";
import type { Route } from "../store";

export type Tab = "archive" | "projects" | "cull" | "more";

const icon = (d: ReactNode) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "archive", label: "Archive", icon: icon(<><rect x="3" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" /></>) },
  { id: "projects", label: "Projects", icon: icon(<><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2.5h6.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" /></>) },
  { id: "cull", label: "Cull", icon: icon(<><rect x="5" y="3.5" width="14" height="17" rx="2.5" /><path d="M9 12.5l2 2 4-4.5" /></>) },
  { id: "more", label: "More", icon: icon(<><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>) },
];

const ARCHIVE: Route["name"][] = ["pictures", "detail", "albums", "cleanup"];
const PROJECTS: Route["name"][] = ["ideas", "inspire", "write"];

/** Which tab a screen belongs to. */
export function tabOf(route: Route["name"]): Tab | null {
  if (route === "today" || route === "dashboard") return null;
  if (ARCHIVE.includes(route)) return "archive";
  if (PROJECTS.includes(route)) return "projects";
  return "more";
}

export function TabBar({ route, onTab, badge, more }: { route: Route["name"]; onTab: (t: Tab) => void; badge: number; more: boolean }) {
  const current = more ? "more" : tabOf(route);
  return (
    <nav className="tabbar phone-only" aria-label="Sections">
      {TABS.map((t) => (
        <button key={t.id} type="button" aria-label={t.id === "cull" && badge > 0 ? `Cull, ${badge.toLocaleString()} to review` : t.label} aria-current={current === t.id ? "page" : undefined} onClick={() => onTab(t.id)}>
          <span className="tb-i">
            {t.icon}
            {t.id === "cull" && badge > 0 && <span className="tb-dot" aria-label={`${badge.toLocaleString()} to review`} />}
          </span>
          <span className="tb-l">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

/** The phone's top-bar title for a screen. */
export function phoneTitle(route: Route["name"]): string {
  const T: Partial<Record<Route["name"], string>> = {
    today: "Today", dashboard: "Today", pictures: "Archive", albums: "Albums", cleanup: "Clean up",
    ideas: "Projects", inspire: "Saved", write: "Project", pillars: "Pillars", roadmap: "Roadmap",
    posts: "Calendar", post: "Post", accounts: "Grid", account: "Grid", edit: "Edit", portfolio: "Portfolio", settings: "Settings",
  };
  return T[route] ?? "";
}
