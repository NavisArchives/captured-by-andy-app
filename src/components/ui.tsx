// Small shared building blocks in the Headquarters style.
import { Children, createContext, isValidElement, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

const svg = (d: ReactNode, size = 12, sw = 2.6, fill = false) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill ? "currentColor" : "none"}
    stroke={fill ? undefined : "currentColor"}
    strokeWidth={sw}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {d}
  </svg>
);

export const Icon = {
  check: (s = 12) => svg(<path d="M5 12.5l4.5 4.5L19 7.5" />, s, 3),
  x: (s = 12) => svg(<path d="M6 6l12 12M18 6L6 18" />, s, 3),
  q: (s = 12) => svg(<><path d="M9 9a3 3 0 1 1 4.5 2.6c-.9.5-1.5 1.2-1.5 2.4" /><path d="M12 18h.01" /></>, s),
  plus: (s = 14) => svg(<path d="M12 5v14M5 12h14" />, s, 2.4),
  back: (s = 14) => svg(<path d="M15 6l-6 6 6 6" />, s, 2.4),
  next: (s = 14) => svg(<path d="M9 6l6 6-6 6" />, s, 2.4),
  grip: (s = 14) => svg(<><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></>, s, 0, true),
  star: (s = 12) => svg(<path d="M12 3.5l2.6 5.5 6 .7-4.5 4.1 1.2 5.9L12 16.8 6.7 19.7l1.2-5.9L3.4 9.7l6-.7z" />, s, 2),
  sparkle: (s = 14) => svg(<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6" />, s, 2),
  edit: (s = 13) => svg(<><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>, s, 2),
  eye: (s = 14) => svg(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>, s, 2),
  download: (s = 14) => svg(<><path d="M12 4v11M7 10l5 5 5-5" /><path d="M5 20h14" /></>, s, 2.2),
  folder: (s = 14) => svg(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />, s, 2),
  search: (s = 14) => svg(<><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>, s, 2.2),
  chevron: (s = 12) => svg(<path d="M7 10l5 5 5-5" />, s, 2.4),
  open: (s = 13) => svg(<><path d="M10 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4" /><path d="M14 4h6v6M20 4l-9 9" /></>, s, 2.2),
  book: (s = 15) => svg(<><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z" /><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z" /></>, s, 1.9),
  archive: (s = 15) => svg(<><rect x="3.5" y="4.5" width="17" height="4" rx="1" /><path d="M5 8.5V18a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18V8.5M10 12.5h4" /></>, s, 1.9),
  idea: (s = 14) => svg(<><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" /></>, s, 1.9),
  more: (s = 15) => svg(<><circle cx="5.5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="18.5" cy="12" r="1.7" /></>, s, 0, true),
};

export function ReviewBadge({ state }: { state: string }) {
  if (state === "selected") return <span className="badge b-sel" title="Selected">{Icon.check()}</span>;
  if (state === "maybe") return <span className="badge b-maybe" title="Maybe">{Icon.q()}</span>;
  if (state === "rejected") return <span className="badge b-rej" title="Rejected">{Icon.x()}</span>;
  return null;
}

export function Hero({ title, italic, sub, children, crumb }: { title: string; italic?: string; sub?: ReactNode; children?: ReactNode; crumb?: ReactNode }) {
  return (
    <div className="hero">
      <div style={{ minWidth: 0 }}>
        {crumb && <div className="crumb">{crumb}</div>}
        <h1>
          {title} {italic && <em>{italic}</em>}
        </h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {children && <div className="acts">{children}</div>}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" className="switch" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />;
}

export interface SideItem {
  key: string;
  label: string;
  count?: number;
  cls: string;
}

export function SideCard({ title, total, items, active, onPick }: { title: string; total?: string; items: SideItem[]; active: string | null; onPick: (key: string | null) => void }) {
  return (
    <section className="card">
      <div className="side-head">
        <h3 className="h6">{title}</h3>
        {total && <span className="tot">{total}</span>}
      </div>
      <div className="side-list">
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            className={`side-row ${it.cls}${it.count === 0 ? " zero" : ""}`}
            aria-pressed={active === it.key}
            onClick={() => onPick(active === it.key ? null : it.key)}
          >
            <i className="sw" />
            <span>{it.label}</span>
            <span className="n">{it.count == null ? "" : it.count.toLocaleString()}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

let modalSeq = 0;

export function Modal({ title, crumb, onClose, children, foot, wide }: { title: ReactNode; crumb?: ReactNode; onClose: () => void; children: ReactNode; foot?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [titleId] = useState(() => `modal-title-${++modalSeq}`);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // An open menu inside the dialog closes first; the dialog on the next Esc.
        if (document.querySelector(".popover")) return;
        e.stopImmediatePropagation();
        onClose();
      }
      // Keep Tab inside the dialog.
      if (e.key === "Tab" && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]")].filter(
          (el) => !el.hasAttribute("disabled") && el.tabIndex >= 0 && el.offsetParent !== null,
        );
        if (!items.length) return e.preventDefault();
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        const outside = !ref.current.contains(active) || active === ref.current;
        if (outside) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  // Focus moves into the dialog, and back to where it was when it closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    if (ref.current && !ref.current.contains(document.activeElement)) {
      const auto = ref.current.querySelector<HTMLElement>("[autofocus], input, textarea");
      (auto ?? ref.current).focus();
    }
    return () => before?.focus?.();
  }, []);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} className={wide ? "modal wide" : "modal"} role="dialog" aria-modal="true" aria-labelledby={titleId} style={{ outline: "none" }}>
        <div className="modal-head">
          <div>
            {crumb && <div className="crumb">{crumb}</div>}
            <h2 id={titleId}>{title}</h2>
          </div>
          <button type="button" className="xbtn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

/** A floating panel under an anchor element; closes on outside click or Esc. */
export function Popover({ anchor, onClose, children, width = 280, up = false, align = "center", className = "" }: { anchor: HTMLElement | null; onClose: () => void; children: ReactNode; width?: number; up?: boolean; align?: "center" | "start"; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number }>({ left: 0, top: 0 });
  // Placed before it is painted, so it never flashes in the corner.
  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const left = Math.min(Math.max(8, align === "start" ? r.left : r.left + r.width / 2 - width / 2), window.innerWidth - width - 8);
    // Opens upwards when asked, or when there's no room below.
    const above = up || (r.bottom + 300 > window.innerHeight && r.top > window.innerHeight - r.bottom);
    setPos(above ? { left, bottom: window.innerHeight - r.top + 6 } : { left, top: r.bottom + 6 });
  }, [anchor, width, up, align]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, onClose]);
  return (
    <div ref={ref} className={`popover ${className}`} style={{ position: "fixed", width, ...pos }}>
      {children}
    </div>
  );
}

/** What Select hands to onChange: shaped like a select's change event, so it drops in for one. */
export interface SelectEvent {
  target: { value: string };
  currentTarget: { value: string; blur: () => void };
}
const textOf = (n: ReactNode): string =>
  typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(textOf).join("") : isValidElement<{ children?: ReactNode }>(n) ? textOf(n.props.children) : "";
function optionsOf(children: ReactNode): { value: string; label: string; disabled: boolean }[] {
  return Children.toArray(children).flatMap((c) => {
    if (!isValidElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>(c)) return [];
    if (c.type !== "option") return optionsOf(c.props.children);
    const label = textOf(c.props.children);
    return [{ value: String(c.props.value ?? label), label, disabled: !!c.props.disabled }];
  });
}

/** The app's dropdown: a quiet button that opens the same menu as every other
 *  popover. Takes <option> children and a select-style onChange, like <select>. */
export function Select({ value, onChange, children, className = "", style, disabled, title, id, "aria-label": ariaLabel }: {
  value: string | number | null | undefined;
  onChange?: (e: SelectEvent) => void;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  title?: string;
  id?: string;
  "aria-label"?: string;
}) {
  const [at, setAt] = useState<HTMLButtonElement | null>(null);
  const options = optionsOf(children);
  const current = options.find((o) => o.value === String(value ?? ""));
  const pick = (v: string, button: HTMLButtonElement | null) => {
    setAt(null);
    button?.focus();
    if (v !== String(value ?? "")) onChange?.({ target: { value: v }, currentTarget: { value: v, blur: () => button?.blur() } });
  };
  const step = (by: number, button: HTMLButtonElement) => {
    const usable = options.filter((o) => !o.disabled);
    const i = usable.findIndex((o) => o.value === current?.value);
    const next = usable[Math.min(usable.length - 1, Math.max(0, i + by))];
    if (next) pick(next.value, button);
  };
  return (
    <>
      <button
        type="button"
        id={id}
        className={`select ${className}`}
        style={style}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={!!at}
        onClick={(e) => setAt(at ? null : e.currentTarget)}
        onKeyDown={(e) => {
          // Arrows, Space and Enter belong to the dropdown, never to the app's shortcuts.
          if (["ArrowDown", "ArrowUp", " ", "Enter"].includes(e.key)) e.stopPropagation();
          if (at || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
          e.preventDefault();
          step(e.key === "ArrowDown" ? 1 : -1, e.currentTarget);
        }}
      >
        <span className="select-label">{current?.label ?? String(value ?? "")}</span>
        <span className="select-chev">{Icon.chevron(11)}</span>
      </button>
      {at && (
        <Popover anchor={at} onClose={() => setAt(null)} width={Math.min(320, Math.max(at.offsetWidth, 180))} align="start" className="select-pop">
          <div role="listbox" aria-label={ariaLabel}>
            {options.map((o, i) => (
              <button
                key={`${i}:${o.value}`}
                type="button"
                role="option"
                aria-selected={o.value === current?.value}
                className={o.value === current?.value ? "opt active" : "opt"}
                disabled={o.disabled}
                ref={o.value === current?.value ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                onClick={() => pick(o.value, at)}
              >
                {o.label}
                {o.value === current?.value && <small>{Icon.check(11)}</small>}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

interface Toast {
  id: number;
  text: string;
  error?: boolean;
  action?: { label: string; run: () => void };
}
const ToastContext = createContext<(text: string, opts?: { error?: boolean; action?: Toast["action"]; ms?: number }) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const stack = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);
  // Toasts with a button (Undo, Open) or an error stay longer, and none
  // leaves while the pointer rests on the stack.
  const push = useCallback((text: string, opts?: { error?: boolean; action?: Toast["action"]; ms?: number }) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, ...opts }]);
    const expire = () => {
      if (hovered.current) window.setTimeout(expire, 1500);
      else setToasts((t) => t.filter((x) => x.id !== id));
    };
    window.setTimeout(expire, opts?.ms ?? (opts?.error || opts?.action ? 7000 : 3800));
  }, []);
  // A toast removed under the pointer never sends mouseleave: ask again.
  useEffect(() => {
    hovered.current = !!stack.current?.querySelector(".toast:hover");
  }, [toasts]);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div ref={stack} className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={t.error ? "toast error" : "toast"} onMouseEnter={() => (hovered.current = true)} onMouseLeave={() => (hovered.current = false)}>
            <span>{t.text}</span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action?.run();
                  setToasts((all) => all.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** True while the user is typing somewhere: global shortcuts stay out of the way. */
/** The app's dropdown (Select) or its open menu: keys belong to it, not to shortcuts. */
export function isDropdown(el: Element | null): boolean {
  return !!el?.closest?.('[aria-haspopup="listbox"], .select-pop');
}

export function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || isDropdown(t));
}
