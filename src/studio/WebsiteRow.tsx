// A project's place on andyssarchives.com, in one row (NIRMATA one-app spec,
// Revision 1): « On the site → Open » or « Not on the site yet ». Read-only for
// now; the Mac opens the page in Portfolio, the web opens the live site.
import { useEffect, useState } from "react";
import { api } from "../api";
import { WEB } from "../platform";
import { useStore } from "../store";

const SITE = "https://andyssarchives.com";
const slugOf = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function WebsiteRow({ title }: { title: string }) {
  const { go } = useStore();
  const [found, setFound] = useState<{ slug: string; title: string } | null | undefined>(WEB ? null : undefined);
  useEffect(() => {
    if (WEB) return;
    let live = true;
    api.archiveRead()
      .then((r) => {
        const doc = JSON.parse(r.json) as { projects?: { slug: string; title: string }[] };
        const want = slugOf(title);
        const hit = (doc.projects ?? []).find((p) => p.slug === want || slugOf(p.title) === want) ?? null;
        if (live) setFound(hit);
      })
      .catch(() => live && setFound(null));
    return () => { live = false; };
  }, [title]);

  return (
    <div className="website-row">
      <span className="wr-k">Website</span>
      {WEB ? (
        <>
          <span className="wr-v">Its page is edited in the Mac app.</span>
          <a className="btn quiet small" href={SITE} target="_blank" rel="noreferrer">Open my website</a>
        </>
      ) : found === undefined ? (
        <span className="wr-v">Checking…</span>
      ) : found ? (
        <>
          <span className="wr-v ok">On the site</span>
          <button type="button" className="btn quiet small" onClick={() => go({ name: "portfolio", slug: found.slug })}>Open its page</button>
        </>
      ) : (
        <>
          <span className="wr-v">Not on the site yet</span>
          <button type="button" className="btn quiet small" onClick={() => go({ name: "portfolio" })}>Open Portfolio</button>
        </>
      )}
    </div>
  );
}
