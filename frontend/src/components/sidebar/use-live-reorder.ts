import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { currentShift, slideFrom, useFlip } from "@/hooks/use-flip";

/** Pointer travel before a press becomes a drag. */
const THRESHOLD = 4;

type Options = {
  /** Item ids in their current order. */
  ids: string[];
  /** The id of the item a press starts dragging, or null if the press isn't a drag handle. */
  pick: (target: HTMLElement) => string | null;
  /** Called when a drag ends somewhere new: `index` is the item's place among the others. */
  onDrop: (id: string, index: number) => void;
};

/** `ids` with `id` moved to `index` among the others. */
export function moveTo(ids: string[], id: string, index: number): string[] {
  const rest = ids.filter((x) => x !== id);
  rest.splice(index, 0, id);
  return rest;
}

/**
 * Drag items of a list up and down. The list reorders live while dragging (the others slide
 * out of the way) and the dragged item follows the pointer. A press without movement stays a
 * click. Items are the list's direct children with `data-flip-key={id}`; the list must be
 * position: relative.
 */
export function useLiveReorder({ ids, pick, onDrop }: Options) {
  const listRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; index: number } | null>(null);
  // Where the dragged item is held: the pointer's y in the list, and where on the item it grabbed.
  const held = useRef<{ id: string; grab: number; y: number } | null>(null);

  const order = useMemo(() => (drag ? moveTo(ids, drag.id, drag.index) : ids), [ids, drag]);
  useFlip(listRef, order.join("\n"), drag?.id);

  const itemEl = (id: string) =>
    listRef.current?.querySelector<HTMLElement>(`:scope > [data-flip-key="${CSS.escape(id)}"]`) ?? null;

  /** Draws the dragged item under the pointer, kept within the list. */
  const follow = () => {
    const h = held.current;
    const list = listRef.current;
    const el = h && itemEl(h.id);
    if (!h || !list || !el) return;
    const top = Math.max(0, Math.min(h.y - h.grab, list.offsetHeight - el.offsetHeight));
    el.style.transform = `translateY(${top - el.offsetTop}px)`;
  };
  // Its place in the list changes as the order does; keep it under the pointer.
  useLayoutEffect(follow);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || ids.length < 2) return;
    const id = pick(e.target as HTMLElement);
    const list = listRef.current;
    if (!id || !list) return;

    const startY = e.clientY;
    const from = ids.indexOf(id);
    let index = from;
    let active = false;
    const listY = (clientY: number) => clientY - list.getBoundingClientRect().top;

    const onMove = (ev: PointerEvent) => {
      if (!active) {
        if (Math.abs(ev.clientY - startY) < THRESHOLD) return;
        const el = itemEl(id);
        if (!el) return;
        active = true;
        held.current = { id, grab: listY(startY) - el.offsetTop, y: listY(ev.clientY) };
        setDrag({ id, index });
        document.body.style.cursor = "grabbing";
      }
      const h = held.current!;
      h.y = listY(ev.clientY);
      // Its place: after every other item whose middle is above the pointer.
      const others = [...list.children].filter(
        (el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.flipKey && el.dataset.flipKey !== id,
      );
      const next = others.filter((el) => el.offsetTop + el.offsetHeight / 2 < h.y).length;
      if (next !== index) {
        index = next;
        setDrag({ id, index });
      }
      follow();
    };

    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      document.body.style.cursor = "";
      // Settle into its place from where it was let go.
      const el = itemEl(id);
      if (el && active) {
        const shift = currentShift(el);
        el.style.transform = "";
        slideFrom(el, shift, 150);
      }
      held.current = null;
      setDrag(null);
    };
    const swallowClick = (ev: Event) => ev.stopPropagation();
    const onUp = () => {
      finish();
      if (!active) return;
      // The drag ends in a click on the item; it shouldn't act on it.
      window.addEventListener("click", swallowClick, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallowClick, { capture: true }), 0);
      if (index !== from) onDrop(id, index);
    };
    const onCancel = () => {
      index = from;
      finish();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  return { listRef, onPointerDown, order, dragId: drag?.id ?? null };
}
