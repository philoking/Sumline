/**
 * Who gets a space, read from configuration rather than compiled in.
 *
 * A space is a place to work, not a login: there are no passwords, and anyone
 * who can reach the app can switch to any of them. What this file decides is
 * who appears in the switcher, not who is allowed in.
 */

export interface Space {
  id: string;
  name: string;
}

/**
 * The space a one-person instance gets when nothing is configured.
 *
 * Deliberately generic. The id is what every row in the database is stamped
 * with, so it is worth it being a word that means the same thing to whoever
 * ends up running this.
 */
export const FALLBACK_SPACE: Space = { id: 'me', name: 'Me' };

/**
 * Turns a display name into the id stored against every sheet.
 *
 * Restricted to lowercase alphanumerics and dashes, which keeps an id safe to
 * put in a cookie, a query string and — via the owner column's DEFAULT clause
 * — in SQL. A name with nothing usable in it yields an empty string and the
 * caller drops the entry rather than inventing an id for it.
 */
export function deriveSpaceId(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Reads the `SPACES` setting.
 *
 * Two forms, comma separated: `Ada` takes its id from the name, and `ada:Ada`
 * states the id outright. The second exists so a person can be renamed without
 * their sheets going with the old id — every sheet, folder and setting is
 * stamped with the id, so a derived id changing is the difference between
 * renaming someone and replacing them.
 *
 * Returns null rather than a default when nothing usable is configured, so the
 * caller can tell "unset" from "set to one space" and fall back to whatever
 * the database already holds.
 */
export function parseSpaces(raw: string | undefined | null): Space[] | null {
  if (!raw) return null;

  const spaces: Space[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    // Only the first colon separates: a name may contain one, an id may not.
    const colon = trimmed.indexOf(':');
    const rawId = colon === -1 ? trimmed : trimmed.slice(0, colon);
    const name = (colon === -1 ? trimmed : trimmed.slice(colon + 1)).trim();
    if (!name) continue;

    // An explicit id is normalised rather than rejected, so a stray capital or
    // space in the configuration is not a startup failure on a personal app.
    const id = deriveSpaceId(rawId);
    if (!id) continue;
    if (spaces.some((space) => space.id === id)) continue;
    spaces.push({ id, name });
  }

  return spaces.length > 0 ? spaces : null;
}

/**
 * Rebuilds a space list from ids already in the database.
 *
 * Used when `SPACES` is unset on an instance that has been running with spaces
 * — an upgrade, or a deployment that never set the variable. Without this the
 * default single space would own none of the existing sheets and the app would
 * open on what looks like an empty database, which is the worst way for a
 * configuration default to announce itself.
 *
 * Names are the id title-cased, which is right for a name-derived id and merely
 * tidy for one that was never a name. Setting `SPACES` replaces the guess.
 */
export function spacesFromOwners(owners: readonly string[]): Space[] | null {
  const spaces = owners
    .filter((id) => id && deriveSpaceId(id) === id)
    .map((id) => ({ id, name: titleCase(id) }));
  return spaces.length > 0 ? spaces : null;
}

function titleCase(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Resolves an untrusted value to a configured space, or the first one. */
export function resolveSpace(spaces: readonly Space[], value: unknown): string {
  const first = spaces[0]?.id ?? FALLBACK_SPACE.id;
  if (typeof value !== 'string') return first;
  return spaces.some((space) => space.id === value) ? value : first;
}

/**
 * Owner ids in the database that no configured space covers.
 *
 * Their sheets are intact but unreachable: every list is filtered by owner and
 * no space asks for these. Naming them at startup is the difference between a
 * recoverable misconfiguration and an instance that appears to have lost
 * someone's work.
 */
export function orphanedOwners(
  spaces: readonly Space[],
  owners: readonly string[],
): string[] {
  return owners.filter((id) => id && !spaces.some((space) => space.id === id));
}
