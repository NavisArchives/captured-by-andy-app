// One right-click menu for the whole app (NIRMATA Amendment 7, Andy 19 Nov:
// « when I press right click I get the MacBook reload or whatever »).
// - The webview's own menu (Reload, Inspect…) never shows; text fields keep
//   their normal Cut / Copy / Paste.
// - Opens on right-click and ⌃-click (both arrive as `contextmenu`), on the
//   menu key or Shift+F10 for the focused item, and on a long press on touch
//   screens, where it is a bottom sheet.
// - Order inside a menu: open → change → organise → source → ── → destructive.
//   An action that can't run here is greyed with its reason, never missing.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export type MenuItem =
  | "sep"
  | {
      label: string;
      run?: () => void | Promise<void>;
      /** Shown greyed, with this reason (e.g. « Mac only »). */
      disabled?: string;
      danger?: boolean;
      /** A submenu, shown in place when chosen. */
      items?: MenuItem[];
      checked?: boolean;
      hint?: string;
    };
export interface MenuSpec {
  header?: string;
  items: MenuItem[];
}
type Point = { x: number; y: number };
type Open = (at: Point | { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, spec: MenuSpec) => void;

type Pop = (render: (anchor: HTMLElement, close: () => void) => ReactNode) => void;
const Ctx = createContext<{ open: Open; popover: Pop }>({ open: () => {}, popover: () => {} });
/** `open(event, spec)` from an onContextMenu handler. */
export const useMenu = () => useContext(Ctx);

const isText = (el: EventTarget | null) => {
  const t = el as HTMLElement | null;
  if (!t || !t.closest) return false;
  if (t.closest("textarea, [contenteditable=''], [contenteditable='true']")) return true;
  const input = t.closest("input") as HTMLInputElement | null;
  return !!input && !["button", "checkbox", "radio", "range", "color", "file", "submit", "reset"].includes(input.type);
};
const phoneSheet = () => typeof matchMedia === "function" && (matchMedia("(max-width: 700px)").matches || matchMedia("(pointer: coarse)").matches);

export function ContextMenuHost({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<(MenuSpec & Point & { sheet: boolean }) | null>(null);
  const [path, setPath] = useState<number[]>([]);
  const [focus, setFocus] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const anchorEl = useRef<HTMLElement | null>(null);
  const restore = useRef<HTMLElement | null>(null);
  const last = useRef<Point>({ x: innerWidth / 2, y: innerHeight / 2 });
  const [pop, setPop] = useState<{ render: (anchor: HTMLElement, close: () => void) => ReactNode; anchor: HTMLElement } | null>(null);

  const close = useCallback(() => {
    setMenu(null);
    setPath([]);
    restore.current?.focus?.();
  }, []);

  const open: Open = useCallback((at, spec) => {
    const e = at as { preventDefault?: () => void; stopPropagation?: () => void; clientX?: number; clientY?: number };
    e.preventDefault?.();
    e.stopPropagation?.();
    const x = "clientX" in at ? at.clientX : (at as Point).x;
    const y = "clientY" in at ? at.clientY : (at as Point).y;
    restore.current = document.activeElement as HTMLElement | null;
    last.current = { x, y };
    setPath([]);
    setFocus(0);
    setMenu({ ...spec, x, y, sheet: phoneSheet() });
  }, []);

  // Pickers opened from a menu item (Add to album…) anchor on a hidden
  // element where the menu was.
  const popover: Pop = useCallback((render) => {
    if (!anchorEl.current) {
      const el = document.createElement("div");
      el.className = "cm-anchor";
      el.setAttribute("aria-hidden", "true");
      document.body.appendChild(el);
      anchorEl.current = el;
    }
    anchorEl.current.style.left = `${last.current.x}px`;
    anchorEl.current.style.top = `${last.current.y}px`;
    setPop({ render, anchor: anchorEl.current });
  }, []);

  // No system menu outside text fields; the menu key and Shift+F10 open ours on
  // the focused item; a long press on a touch screen does too.
  useEffect(() => {
    const block = (e: MouseEvent) => {
      if (!isText(e.target)) e.preventDefault();
    };
    const key = (e: KeyboardEvent) => {
      if (!(e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) return;
      const active = document.activeElement as HTMLElement | null;
      if (isText(active)) return;
      e.preventDefault();
      // In a grid the item is the one with the keyboard cursor.
      const target = (active?.querySelector?.(".tile.cursor, [data-menu-cursor]") as HTMLElement | null) ?? active ?? document.body;
      const r = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + Math.min(r.width / 2, 40), clientY: r.top + Math.min(r.height / 2, 40) }));
    };
    let timer = 0;
    let start: { x: number; y: number; t: EventTarget | null } | null = null;
    let swallow = false;
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || isText(e.target)) return;
      start = { x: e.clientX, y: e.clientY, t: e.target };
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!start) return;
        swallow = true;
        (start.t as HTMLElement).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: start.x, clientY: start.y }));
        start = null;
      }, 520);
    };
    const move = (e: PointerEvent) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) {
        window.clearTimeout(timer);
        start = null;
      }
    };
    const up = () => {
      window.clearTimeout(timer);
      start = null;
    };
    const click = (e: MouseEvent) => {
      if (!swallow) return;
      swallow = false;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("contextmenu", block);
    window.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    document.addEventListener("click", click, true);
    return () => {
      document.removeEventListener("contextmenu", block);
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
      document.removeEventListener("click", click, true);
    };
  }, []);

  // The items now shown: the top level, or the submenu chosen.
  let items: MenuItem[] = menu?.items ?? [];
  let title = menu?.header;
  for (const i of path) {
    const it = items[i];
    if (it && it !== "sep" && it.items) {
      title = it.label;
      items = it.items;
    }
  }
  const live = items.map((it, i) => ({ it, i })).filter(({ it }) => it !== "sep" && !it.disabled).map(({ i }) => i);

  const choose = async (i: number) => {
    const it = items[i];
    if (!it || it === "sep" || it.disabled) return;
    if (it.items) {
      setPath((p) => [...p, i]);
      setFocus(0);
      return;
    }
    setMenu(null);
    setPath([]);
    await it.run?.();
  };

  // Keyboard inside the menu; clicks outside or Esc close it.
  useEffect(() => {
    if (!menu) return;
    box.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (path.length) setPath((p) => p.slice(0, -1));
        else close();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const at = live.indexOf(focus);
        const next = e.key === "ArrowDown" ? live[(at + 1) % live.length] : live[(at - 1 + live.length) % live.length];
        if (next != null) setFocus(next);
      } else if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        const it = items[focus];
        if (e.key === "ArrowRight" && !(it && it !== "sep" && it.items)) return;
        void choose(focus);
      } else if (e.key === "ArrowLeft" && path.length) {
        e.preventDefault();
        e.stopPropagation();
        setPath((p) => p.slice(0, -1));
      }
    };
    const away = (e: Event) => {
      if (box.current && !box.current.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  });
  // Start on the first item that can run.
  useEffect(() => {
    if (menu && !live.includes(focus) && live.length) setFocus(live[0]);
  }, [menu, path, live, focus]);

  // Kept on screen: flipped left/up when it would overflow.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!menu || menu.sheet) return setPos(null);
    const el = box.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = menu.x + w + 8 > innerWidth ? Math.max(8, menu.x - w) : menu.x;
    const top = menu.y + h + 8 > innerHeight ? Math.max(8, innerHeight - h - 8) : menu.y;
    setPos({ left, top });
  }, [menu, path]);

  return (
    <Ctx.Provider value={{ open, popover }}>
      {children}
      {pop && pop.render(pop.anchor, () => setPop(null))}
      {menu && (
        <>
          {/* While a menu is open, every screen's key handler sees « a dialog is up » (they all check .scrim). */}
          <i className="scrim cm-guard" hidden />
          {menu.sheet && <div className="cm-scrim" onClick={close} />}
          <div
            ref={box}
            className={menu.sheet ? "cm cm-sheet" : "cm"}
            role="menu"
            tabIndex={-1}
            aria-label={title ?? "Menu"}
            style={menu.sheet ? undefined : { left: pos?.left ?? menu.x, top: pos?.top ?? menu.y, visibility: pos ? "visible" : "hidden" }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {(title || path.length > 0) && (
              <div className="cm-head">
                {path.length > 0 && (
                  <button type="button" className="cm-back" aria-label="Back" onClick={() => setPath((p) => p.slice(0, -1))}>‹</button>
                )}
                <span>{title}</span>
              </div>
            )}
            {items.map((it, i) =>
              it === "sep" ? (
                <hr key={`s${i}`} />
              ) : (
                <button
                  key={`${i}:${it.label}`}
                  type="button"
                  role="menuitem"
                  className={["cm-item", it.danger && "danger", focus === i && "focus"].filter(Boolean).join(" ")}
                  aria-disabled={it.disabled ? true : undefined}
                  title={it.disabled}
                  onMouseEnter={() => !it.disabled && setFocus(i)}
                  onClick={() => void choose(i)}
                >
                  <span className="cm-l">{it.checked != null && <i className="cm-check">{it.checked ? "✓" : ""}</i>}{it.label}</span>
                  {it.disabled ? <small>{it.disabled}</small> : it.items ? <small aria-hidden="true">›</small> : it.hint ? <small className="cm-hint">{it.hint}</small> : null}
                </button>
              ),
            )}
          </div>
        </>
      )}
    </Ctx.Provider>
  );
}
