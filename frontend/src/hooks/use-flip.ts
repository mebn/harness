import { useLayoutEffect, useRef } from "react";

const EASING = "cubic-bezier(0.2, 0, 0, 1)";
const DURATION = 200;

/** Slides started here, so a new slide can take over from one still running. */
const slides = new WeakMap<HTMLElement, Animation>();

/** The vertical offset an element is drawn at right now (a running slide or an inline transform). */
export function currentShift(el: HTMLElement): number {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return 0;
  return new DOMMatrixReadOnly(t).m42;
}

/** Draws an element `dy` pixels away from its place and slides it back. */
export function slideFrom(el: HTMLElement, dy: number, duration = DURATION) {
  slides.get(el)?.cancel();
  if (Math.abs(dy) < 1) return;
  const a = el.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], { duration, easing: EASING });
  slides.set(el, a);
  a.onfinish = a.oncancel = () => slides.get(el) === a && slides.delete(el);
}

/**
 * Slides a list's items to their new places when their order changes, instead of jumping.
 * Items are the list's direct children with a `data-flip-key`; the list must be the items'
 * offset parent (position: relative). `order` identifies the order (e.g. the keys joined);
 * `skip` is an item placed by hand (being dragged).
 */
export function useFlip(listRef: React.RefObject<HTMLElement | null>, order: string, skip?: string | null) {
  const tops = useRef(new Map<string, number>());
  const lastOrder = useRef(order);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const items = [...list.children].filter((el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.flipKey);
    if (order !== lastOrder.current) {
      for (const el of items) {
        const key = el.dataset.flipKey!;
        const before = tops.current.get(key);
        if (key === skip || before === undefined) continue;
        // From where it is drawn now, including any slide still running.
        const running = slides.has(el) ? currentShift(el) : 0;
        slideFrom(el, before + running - el.offsetTop);
      }
    }
    tops.current = new Map(items.map((el) => [el.dataset.flipKey!, el.offsetTop]));
    lastOrder.current = order;
  });
}
