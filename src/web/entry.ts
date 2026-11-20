// The web app's front door. `?demo=1` runs the same UI on generated sample
// photos and ideas (src/dev/preview.tsx): no sign-in, no Google, nothing
// private. Every screenshot and visual check of the phone layout runs on it.
// Without it, the real app starts (main.tsx: Supabase sign-in, Drive pictures).
if (new URLSearchParams(location.search).has("demo")) {
  document.documentElement.dataset.web = "1";
  document.documentElement.dataset.demo = "1";
  void import("../dev/preview");
} else {
  void import("./main");
}
