import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

/**
 * The click-anywhere-to-dismiss layer under a menu or a panel.
 *
 * A `div` over the whole window, which is what makes a click outside an open
 * thing close it rather than land on whatever was underneath. It was written
 * out twelve times across eight components; here it has a name.
 */
export function Backdrop(props: { onClose: () => void }) {
  return <div className="menu-backdrop" onClick={props.onClose} aria-hidden="true" />;
}

/**
 * The edges a popover lines itself up with.
 *
 * Expressed as edges rather than as a point or a rectangle, because the two
 * things needing this anchor differently: the answer menu opens from where the
 * pointer was, and a sidebar flyout from the button that raised it. Both come
 * down to "which right edge, which top and bottom, how much gap".
 */
export interface Anchor {
  /** The window x the popover's right edge lines up with. */
  right: number;
  /** The anchor's own top and bottom, which the popover opens away from. */
  top: number;
  bottom: number;
  /** Space between the anchor and the popover. */
  gap?: number;
}

/** Kept clear of the window's edge, so a flipped popover is never flush to it. */
const EDGE = 8;

/**
 * Places a popover against its anchor, flipping it upwards when it would not
 * fit below. Null while nothing is open.
 *
 * Anchored by its *right* edge rather than its left, because both callers sit
 * at the right of the window — the answer column, and the sidebar's row
 * buttons — and a menu growing rightwards from either runs straight off the
 * screen. Growing leftwards puts it over the sheet, which is the roomy
 * direction.
 *
 * The height is **measured**, not guessed. This rule used to be worked out in
 * two places, with three estimated constants and a paragraph in each about why
 * over-estimating was the safe direction — which it was, while nobody could
 * measure. One place can: it lays the popover out downwards, reads its height
 * before the browser paints, and flips it if it has to. The estimates and the
 * reasoning about which way to err both go.
 *
 * The element is passed in rather than handed back, because every caller
 * already has a ref on it — from `useDialog`, or for its own keyboard handling.
 */
export function usePopoverPlacement(
  anchor: Anchor | null,
  element: RefObject<HTMLElement | null>,
): CSSProperties | undefined {
  const [flipped, setFlipped] = useState(false);
  const { right, top, bottom, gap = 0 } = anchor ?? { right: 0, top: 0, bottom: 0 };

  useLayoutEffect(() => {
    if (!anchor) return;
    const height = element.current?.offsetHeight ?? 0;
    // Before paint, so a popover that has to flip is never seen below first.
    setFlipped(height > 0 && bottom + gap + height > window.innerHeight);
    // Depending on the numbers rather than the anchor, which is a fresh object
    // every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor === null, right, top, bottom, gap]);

  if (!anchor) return undefined;
  return {
    right: Math.max(EDGE, window.innerWidth - right),
    ...(flipped
      ? { bottom: Math.max(EDGE, window.innerHeight - top + gap) }
      : { top: bottom + gap }),
  };
}
