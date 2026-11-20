// Online (browser and phone), a part of the app that needs the Mac's files is
// never just missing: it says where it is, in one line, with what can be done
// here (NIRMATA one-app spec, Amendment 3: unavailable, never invisible).
export const SITE = "https://andyssarchives.com";

const WHAT: Record<string, { title: string; say: string; website?: boolean }> = {
  edit: { title: "Edit", say: "Your edits live on the Mac, next to the full-size originals, so the list of every edit is in the Mac app. Pick pictures here and add them to a project; edit them on the Mac." },
  posts: { title: "Calendar", say: "The posting calendar is in the Mac app for now. It comes online once posts sync." },
  post: { title: "Calendar", say: "The posting calendar is in the Mac app for now. It comes online once posts sync." },
  account: { title: "Grid", say: "The Instagram grid preview is in the Mac app for now." },
  accounts: { title: "Grid", say: "The Instagram grid preview is in the Mac app for now." },
  portfolio: { title: "Portfolio", say: "Editing your website's pages is in the Mac app. You can open the live site from here.", website: true },
};

export function MacOnly({ route }: { route: string }) {
  const w = WHAT[route] ?? { title: "On the Mac", say: "This part is in the Mac app." };
  return (
    <div className="screen mac-only-page">
      <h1>{w.title}</h1>
      <p>{w.say}</p>
      {w.website && <a className="btn primary" href={SITE} target="_blank" rel="noreferrer">Open my website</a>}
    </div>
  );
}
