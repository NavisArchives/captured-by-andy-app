// Every keyboard shortcut in one place. Opens with ? from anywhere.
import { keyLabel, type Keymap } from "../keymap";
import { Modal } from "./ui";

const K = ({ keys }: { keys: string[] }) => (
  <span>
    {keys.map((k) => (
      <kbd key={k}>{k}</kbd>
    ))}
  </span>
);

export function Shortcuts({ keymap, onClose }: { keymap: Keymap; onClose: () => void }) {
  const m = (a: keyof Keymap) => keymap[a].map(keyLabel);
  const groups: [string, [string, string[]][]][] = [
    [
      "Culling · like swiping",
      [
        ["Select, then next", m("select")],
        ["Reject, then next", m("reject")],
        ["Maybe, then next", m("maybe")],
        ["Back to unreviewed", m("unmark")],
        ["Previous / next photo", ["←", "→"]],
        ["Next / previous scene (similar shots)", ["↓", "↑"]],
        ["Quick pass: the select key keeps for later", ["Q"]],
        ["Undo last mark (Cull, photo page, grid)", ["⌘", "Z"]],
        ["Voice: say yes, no, maybe, back, skip, zoom", ["V"]],
        ["Focus (hide everything but the photo)", m("focus")],
        ["Edit this photo", ["E"]],
        ["Done", m("exit")],
      ],
    ],
    [
      "Quick add · an album, photo by photo",
      [
        ["Add to the album, then next", ["Y", ...m("select")]],
        ["Skip (or take back out), then next", ["N", ...m("reject")]],
        ["Previous / next photo", ["←", "→"]],
        ["Undo", ["⌘", "Z"]],
        ["Done", m("exit")],
      ],
    ],
    [
      "Pictures",
      [
        ["Pick one / add to picks / range", ["click", "⌘-click", "⇧-click"]],
        ["Pick everything shown", ["⌘", "A"]],
        ["Move around the grid", ["←", "↑", "→", "↓"]],
        ["Open the photo", ["Space", "↵"]],
        ["Edit the picked photos", ["E"]],
        ["Put a favourite look on the picks", ["1", "–", "9"]],
        ["Take the look off", ["0"]],
        ["Search", ["/"]],
        ["Drag picks onto an album in the sidebar", ["drag"]],
      ],
    ],
    [
      "Editor",
      [
        ["Move through the looks", ["←", "↑", "↓", "→"]],
        ["Preview a look", ["rest the pointer on it"]],
        ["… or", ["]", "["]],
        ["Favourite looks", ["1", "–", "9"]],
        ["No look", ["0"]],
        ["Auto tone", ["⌘", "U"]],
        ["Before (hold)", ["B"]],
        ["Split view", ["Y"]],
        ["Copy / paste settings", ["⌘C", "⌘V"]],
        ["Paste on every photo (Undo in the toast)", ["⌘", "⇧", "V"]],
        ["Choose what a paste carries over", ["⌥", "⌘", "V"]],
        ["Same edit as the previous photo", ["P"]],
        ["Undo / redo", ["⌘Z", "⌘⇧Z"]],
        ["Export", ["⌘", "E"]],
        ["Previous / next photo", [",", "."]],
      ],
    ],
    [
      "Posts",
      [
        ["Move a card one column", ["‹", "›"]],
        ["… or, on a focused card", ["⌥←", "⌥→"]],
        ["Open a card", ["↵"]],
      ],
    ],
    [
      "Projects",
      [
        ["New idea, from anywhere", ["⌘", "N"]],
        ["Paste a link or picture on Inspire", ["⌘", "V"]],
        ["Sort ideas: keep / maybe / park", ["Y", "M", "N"]],
        ["Resurface: use / keep / let go", ["1", "2", "3"]],
      ],
    ],
    [
      "Everywhere",
      [
        ["Archive · Edit · Projects · Socials · Portfolio", ["⌘1", "…", "⌘5"]],
        ["This list", ["?"]],
        ["Close / back", ["Esc", "⌘["]],
      ],
    ],
  ];
  return (
    <Modal title="Keyboard shortcuts" crumb="Change the culling keys in Settings" onClose={onClose} wide>
      <div className="shortcuts">
        {groups.map(([title, rows]) => (
          <section key={title}>
            <h6 className="h">{title}</h6>
            {rows.map(([label, keys]) => (
              <div key={label} className="k">
                <span>{label}</span>
                <K keys={keys} />
              </div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  );
}
