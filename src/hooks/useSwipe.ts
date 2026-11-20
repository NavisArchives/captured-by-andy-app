import { useRef } from "react";

export type SwipeDir = "left" | "right" | "up" | "down";

/** One-finger swipes on a touch screen: spread the result on the element. A
 *  short or two-finger movement (a tap, a pinch) is no swipe. `onDrag` follows
 *  the finger (null when it lets go), so a card can move with it. A slow drag
 *  still counts once it has gone far (100 px). */
export function useSwipe(onSwipe: (dir: SwipeDir) => void, min = 60, onDrag?: (d: { dx: number; dy: number } | null) => void) {
  const start = useRef<{ x: number; y: number; t: number } | null>(null);
  return {
    onTouchStart: (e: React.TouchEvent) => {
      start.current = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() } : null;
    },
    onTouchMove: (e: React.TouchEvent) => {
      if (e.touches.length > 1) {
        start.current = null;
        onDrag?.(null);
        return;
      }
      const s = start.current;
      if (s && onDrag) onDrag({ dx: e.touches[0].clientX - s.x, dy: e.touches[0].clientY - s.y });
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const s = start.current;
      start.current = null;
      onDrag?.(null);
      if (!s) return;
      const dx = e.changedTouches[0].clientX - s.x;
      const dy = e.changedTouches[0].clientY - s.y;
      const far = Math.max(Math.abs(dx), Math.abs(dy));
      if (far < min || (Date.now() - s.t > 800 && far < 100)) return;
      onSwipe(Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down");
    },
  };
}
