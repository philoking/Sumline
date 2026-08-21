/**
 * Shape checks for the free-text settings, in one place.
 *
 * Three families of routes need these — folders and sheets for a colour, the
 * settings endpoints for a region and a zone — so they sit here rather than in
 * whichever file happened to define them first.
 *
 * Deliberately not JSON Schema. What these do that a schema cannot is
 * *normalise*: a region typed `de` and one typed `DE` have to end up as one
 * value or the same holiday calendar gets fetched twice under two keys. A
 * schema can refuse a shape; it cannot return a corrected one.
 */
export const INVALID = Symbol('invalid setting');

/**
 * Builds a check on the shape of a free-text setting, and nothing more.
 *
 * Three of them arrive that way — a colour token, a number region, a zone name
 * — and all three are checked for their charset rather than their membership,
 * for one reason: each list of valid values lives somewhere this file does not
 * depend on. The palette is in the web, with the shades it decides; the regions
 * and the zone table are in the engine, which the server does not depend on at
 * runtime. Checking membership here would mean a second copy of each, kept in
 * step by hand.
 *
 * A well-formed name nobody recognises is harmless in all three cases: the
 * stylesheet matches no rule and shows no colour, and the engine coerces what
 * it does not know back to its default — the number region it started with, the
 * reader's own zone. What the shape is protecting against is narrower and real:
 * a colour token reaches the browser inside a class name, so a value outside
 * its alphabet could escape the attribute.
 *
 * Trimmed before testing, all three, a trailing space being a typo rather than
 * a different setting.
 */
const shaped =
  (pattern: RegExp) =>
  (value: unknown): string | typeof INVALID => {
    if (typeof value !== 'string') return INVALID;
    const name = value.trim();
    return pattern.test(name) ? name : INVALID;
  };

/** An alphabet safe to put in a class name, since that is where it ends up. */
const readColorName = shaped(/^[a-z]{2,12}$/);

/** As above, except that nothing at all means no colour rather than a bad one. */
export function readColor(value: unknown): string | null | typeof INVALID {
  if (value === null || value === undefined || value === '') return null;
  return readColorName(value);
}

/** A name like `western-europe`. */
export const readRegion = shaped(/^[a-z]{2,20}(?:-[a-z]{2,20})?$/);

/** An IANA name like `Europe/Berlin`, or one of the aliases the engine reads. */
export const readZone = shaped(/^[A-Za-z][A-Za-z0-9_+\-/ ]{1,60}$/);
