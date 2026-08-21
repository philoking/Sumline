import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';

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

/**
 * The keyboard a `role="menu"` promises.
 *
 * Declaring that role is a claim about behaviour, not a styling hook: a screen
 * reader tells its user this is a menu, and its user then expects arrow keys to
 * move through it, Home and End to reach the ends, and Escape to leave. Three
 * of the four menus in this app made the claim and handled no keys at all,
 * which is worse than not making it — someone told to press Down pressed Down
 * and nothing happened.
 *
 * The fourth had a correct implementation, inline in the editor. This is that
 * one, lifted so there is a single answer rather than four that drift.
 *
 * Focus moves to the first item on opening, because a menu raised from the
 * keyboard is no use if focus stays behind on the button that raised it.
 * Disabled items are skipped rather than focused and stepped over: the view
 * menu greys out "Bigger text" at maximum size, and stopping on it would be a
 * dead key press.
 */
export function useMenuKeys(
  menu: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): (event: ReactKeyboardEvent<HTMLElement>) => void {
  useEffect(() => {
    if (!open) return;
    items(menu)[0]?.focus();
  }, [open, menu]);

  return useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      const reachable = items(menu);
      if (reachable.length === 0) return;

      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        (event.key === 'Home' ? reachable[0] : reachable[reachable.length - 1])?.focus();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const at = reachable.indexOf(document.activeElement as HTMLElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      // Wrapping, which is what the menu pattern asks for: Down on the last
      // item reaches the first rather than doing nothing.
      reachable[(at + step + reachable.length) % reachable.length]?.focus();
    },
    [menu, onClose],
  );
}

/** The items a keyboard can actually land on, in the order they are shown. */
function items(menu: RefObject<HTMLElement | null>): HTMLElement[] {
  return [
    ...(menu.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []),
  ];
}
