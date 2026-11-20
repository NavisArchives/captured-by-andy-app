// Picks what's in the photos from what the app recognised: picked tags are
// chips, typing suggests tags, ↑ ↓ move, Enter / Space / Tab pick, Esc
// closes the list, Backspace in an empty box takes the last tag off.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { labelText, suggest } from "../lib/labels";
import type { LabelList } from "../types";

export function TagPicker({ value, onChange, placeholder, label }: { value: string[]; onChange: (labels: string[]) => void; placeholder?: string; label: string }) {
  const [list, setList] = useState<LabelList | null>(null);
  useEffect(() => {
    api.listLabels().then(setList).catch(() => setList({ labels: [], synonyms: [] }));
  }, []);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const hits = useMemo(() => (list ? suggest(text, list, value) : []), [text, list, value]);
  const showing = open && text.trim() !== "" && list !== null;
  useEffect(() => {
    document.getElementById(`${listId}-${at}`)?.scrollIntoView({ block: "nearest" });
  }, [at, listId]);
  const counts = useMemo(() => new Map(list?.labels.map((l) => [l.label, l.count])), [list]);

  const pick = (label: string) => {
    onChange([...value, label]);
    setText("");
    setAt(0);
    input.current?.focus();
  };
  const drop = (label: string) => onChange(value.filter((l) => l !== label));

  // Esc and Tab are taken by the dialog before the input sees them (it
  // listens on the window, capturing). This listener is added first, as the
  // dialog's effect runs after its children's, so the list gets them first.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (document.activeElement !== input.current || !showing) return;
    if (e.key === "Escape") {
      e.stopImmediatePropagation();
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "Tab" && !e.shiftKey && hits[at]) {
      e.stopImmediatePropagation();
      e.preventDefault();
      pick(hits[at].label);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="tag-picker">
      <div className="box tag-box" onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), input.current?.focus())}>
        {value.map((l) => (
          <span key={l} className="chip">
            {labelText(l)}
            {counts.has(l) && <span className="n">{counts.get(l)!.toLocaleString()}</span>}
            <button type="button" className="x" aria-label={`Remove ${labelText(l)}`} onClick={() => drop(l)}>×</button>
          </span>
        ))}
        <input
          ref={input}
          value={text}
          placeholder={value.length ? "" : placeholder}
          aria-label={label}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={showing}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showing && hits[at] ? `${listId}-${at}` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setAt(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !text && value.length) {
              drop(value[value.length - 1]);
              return;
            }
            if (!text.trim()) return; // Enter in an empty box goes on to start.
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setOpen(true);
              if (hits.length) setAt((i) => (i + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
            } else if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              if (hits[at]) pick(hits[at].label);
            }
          }}
        />
      </div>
      {showing && (
        <ul className="tag-list" id={listId} role="listbox" aria-label={`${label}: suggestions`}>
          {hits.length ? (
            hits.map((h, i) => (
              <li
                key={h.label}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === at}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(h.label);
                }}
                onMouseMove={() => setAt(i)}
              >
                <span className="name">{labelText(h.label)}</span>
                {h.via && <span className="via">for “{h.via}”</span>}
                <span className="n">{h.count.toLocaleString()}</span>
              </li>
            ))
          ) : (
            <li className="none" aria-disabled="true">Nothing recognised by that name</li>
          )}
        </ul>
      )}
    </div>
  );
}
