import { useEffect, useRef } from 'react';

/** What counts as somewhere focus can usefully land inside a panel. */
const FOCUSABLE =
  'input:not([type=hidden]), textarea, select, button, [href], [tabindex]:not([tabindex="-1"])';

/**
 * Focus handling for a panel that opens over the sheet.
 *
 * Three things, none of which the panels here did. Focus moves into the panel
 * when it opens, so the keyboard is where the eye is. Escape closes it. And
 * focus returns to whatever opened it, so dismissing a panel does not drop the
 * reader back at the top of the document with no idea where they are.
 *
 * Deliberately *not* a focus trap. Trapping is right for a modal that must be
 * answered before anything else can happen; these panels sit beside a sheet
 * that stays readable, and someone who tabs past the end of one has finished
 * with it. Trapping them would turn a side panel into a cage.
 *
 * Returns the ref to put on the panel element. Give that element
 * `tabIndex={-1}` so it can take focus itself when it holds nothing focusable.
 */
export function useDialog<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const panelRef = useRef<T | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    returnTo.current = document.activeElement as HTMLElement | null;

    /*
     * Where the panel says to start, then whatever it leads with, then the
     * panel itself so focus never stays behind on the page underneath.
     *
     * The marker earns its keep on the settings panels, whose first focusable
     * element is the × in the corner: opening settings from a keyboard and
     * landing on the way out is not what was being asked for.
     */
    const preferred =
      panel?.querySelector<HTMLElement>('[data-autofocus]') ??
      panel?.querySelector<HTMLElement>(FOCUSABLE);
    (preferred ?? panel)?.focus();

    // Bound to the panel rather than the window so the innermost open thing
    // answers Escape. Stopped from propagating for the same reason: without
    // it the app-level handler would close this panel and its parent at once.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onCloseRef.current();
    };
    panel?.addEventListener('keydown', onKey);

    return () => {
      panel?.removeEventListener('keydown', onKey);
      // Only reclaim focus if it is still ours to move. Someone who closed the
      // panel by clicking into the sheet has already said where they want to
      // be, and pulling them back to the button would undo that.
      const active = document.activeElement;
      const ours = !active || active === document.body || panel?.contains(active);
      if (ours) returnTo.current?.focus?.();
    };
  }, [open]);

  return panelRef;
}
