/**
 * The colours a sheet or folder can be tagged with.
 *
 * Eight rather than sixteen. These are read at a glance down the side of a
 * list, and a colour code only works while the colours stay tellable apart —
 * past about eight, neighbouring hues start needing a second look, which is
 * exactly the thing colour coding was supposed to save. Eight also lays out as
 * two clean rows of four in a flyout no wider than the sidebar.
 *
 * Extending this list is all it takes to have more: the server stores whatever
 * token it is given and never interprets it, and the stylesheet is keyed on
 * these ids.
 */
export interface SheetColor {
  id: string;
  label: string;
}

export const SHEET_COLORS: SheetColor[] = [
  { id: 'red', label: 'Red' },
  { id: 'orange', label: 'Orange' },
  { id: 'yellow', label: 'Yellow' },
  { id: 'green', label: 'Green' },
  { id: 'teal', label: 'Teal' },
  { id: 'blue', label: 'Blue' },
  { id: 'purple', label: 'Purple' },
  { id: 'pink', label: 'Pink' },
];

const KNOWN = new Set(SHEET_COLORS.map((color) => color.id));

/**
 * The class that paints a row, or nothing at all.
 *
 * Checked against the list rather than trusted: a token stored by a newer
 * version of the app, or by hand, should leave the row plain instead of
 * putting an unknown word into the class attribute.
 */
export function colorClass(color: string | null | undefined): string {
  return color && KNOWN.has(color) ? ` tinted tint-${color}` : '';
}

/** The readable name, for a title or a label. */
export function colorLabel(color: string | null | undefined): string {
  return SHEET_COLORS.find((entry) => entry.id === color)?.label ?? 'No colour';
}
