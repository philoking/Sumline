/** Where the reader is, which decides what `1.234,56` means. */
export type NumberRegion = 'north-america' | 'western-europe' | 'eastern-europe';

export interface Separators {
  group: string;
  decimal: string;
}

export const REGION_SEPARATORS: Record<NumberRegion, Separators> = {
  'north-america': { group: ',', decimal: '.' },
  'western-europe': { group: '.', decimal: ',' },
  'eastern-europe': { group: ' ', decimal: ',' },
};

export const DEFAULT_REGION: NumberRegion = 'north-america';

/**
 * Coerces a region arriving from outside the engine.
 *
 * The region is a stored setting, and the README documents writing settings with
 * `curl`, so an unrecognised value is a real possibility rather than something
 * the compiler has already ruled out. It must not be passed through: nothing in
 * `REGION_SEPARATORS` would match it, and the result is not a crash but a sheet
 * where **every** numeric line silently answers nothing.
 *
 * The server validates the shape of this value but deliberately keeps no copy of
 * the list — see `readRegion` in `server/src/app.ts`, and the same reasoning
 * behind `readColor` beside it. So this is the one place that decides what a
 * region name means.
 */
export function toNumberRegion(value: unknown): NumberRegion {
  return typeof value === 'string' && value in REGION_SEPARATORS
    ? (value as NumberRegion)
    : DEFAULT_REGION;
}

/**
 * Rewrites number literals in a line into the plain `1234.56` form math.js
 * parses, according to the reader's region.
 *
 * Only complete groups of three are treated as separators, so a function call
 * like `max(1000, 2000)` keeps its argument comma in every region.
 */
export function normalizeNumberLiterals(text: string, region: NumberRegion): string {
  // Underscores group digits in every region, matching most programming
  // languages, so pasting a number to or from code just works.
  let out = text.replace(/(\d)_(?=\d)/g, '$1');

  // Digit-boundary lookarounds rather than \b, so `1,000m` is still a grouped
  // number even though a letter follows the final digit.
  if (region === 'north-america') {
    return out.replace(/(?<!\d)\d{1,3}(?:,\d{3})+(?!\d)/g, (m) => m.replace(/,/g, ''));
  }

  if (region === 'western-europe') {
    out = out.replace(/(?<!\d)\d{1,3}(?:\.\d{3})+(?!\d)/g, (m) => m.replace(/\./g, ''));
    // A comma between digits is now unambiguously the decimal point.
    return out.replace(/(\d),(\d)/g, '$1.$2');
  }

  out = out.replace(/(?<!\d)\d{1,3}(?:[  ]\d{3})+(?!\d)/g, (m) => m.replace(/[  ]/g, ''));
  return out.replace(/(\d),(\d)/g, '$1.$2');
}

/**
 * SI-inspired symbols for large answers, the way Soulver abbreviates them.
 *
 * Deliberately not applied to currency: Soulver's own documentation shows
 * `300k` for a plain number but writes `$102,877.00` out in full, and money
 * that has been rounded to the nearest hundred thousand is rarely useful.
 */
const SI_SYMBOLS: Array<[number, string]> = [
  [1e12, 'T'],
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
];

/** The threshold below which numbers are always written out in full. */
export const SI_THRESHOLD = 100_000;

export function toSiNotation(value: number): string | null {
  const magnitude = Math.abs(value);
  if (!Number.isFinite(value) || magnitude < SI_THRESHOLD) return null;

  for (const [size, symbol] of SI_SYMBOLS) {
    if (magnitude < size) continue;
    const scaled = value / size;
    const rounded = Math.round(scaled * 100) / 100;
    // 1,000,000 should read as 1M, not 1000k, so reject a mantissa that has
    // rounded up into the next symbol's territory.
    if (Math.abs(rounded) >= 1000) continue;
    return `${trimZeros(rounded.toFixed(2))}${symbol}`;
  }
  return null;
}

/** Inserts group separators into an unsigned integer string. */
export function group(whole: string, separators: Separators): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, separators.group);
}

/** Joins an integer and fraction part with the region's decimal point. */
export function join(
  whole: string,
  fraction: string | undefined,
  separators: Separators,
): string {
  return fraction ? `${whole}${separators.decimal}${fraction}` : whole;
}

/**
 * Drops the trailing zeros a fixed-width rendering leaves behind.
 *
 * Only ever past the decimal point. `'1000'.replace(/\.?0+$/, '')` is `'1'`,
 * which is what this guard is for: with a precision of 0 there is no point in
 * the string for the pattern to stop at.
 */
export function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}
