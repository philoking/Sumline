import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The optional shared password.
 *
 * No authentication is the default and stays the default: with no password
 * configured, none of this is reached and the app behaves exactly as it did.
 * What this closes is the one hole the README names — `PUT /api/settings/shared`
 * is deliberately not scoped to a space, because instance-wide globals are the
 * point of it, and those values change what every sheet on the instance
 * computes.
 *
 * It is one shared password, not accounts. Spaces stay a preference rather than
 * becoming logins, which is the distinction the rest of the app is careful
 * about: a space says which sheets you are looking at, and this says whether you
 * may look at any of them.
 *
 * **It is not protection against a network attacker.** The cookie is not marked
 * `Secure`, because a self-hosted instance is commonly reached over plain HTTP
 * and marking it would make signing in impossible there. On plain HTTP the
 * password and the cookie both cross the network in the clear. This raises the
 * bar from "anyone who can reach the port" to "anyone who knows the password";
 * for anything stronger, put it behind a reverse proxy that terminates TLS.
 */

export const SESSION_COOKIE = 'webcalc_session';

/** How long a signed-in browser stays signed in. */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Compares two secrets without leaking how far they matched.
 *
 * Both sides are hashed first so the comparison is over fixed-length digests:
 * `timingSafeEqual` throws on a length mismatch, and guarding that with a length
 * check would leak the length of the real password.
 */
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}

/**
 * Signs the moment a session began.
 *
 * The password itself is the HMAC key, which means there is no second secret to
 * configure or to keep in step — and changing the password invalidates every
 * outstanding session for free, which is the behaviour you want from the only
 * credential the instance has.
 */
function sign(password: string, issuedAt: string): string {
  return createHmac('sha256', password).update(issuedAt).digest('hex');
}

export function issueToken(password: string, now: number = Date.now()): string {
  const issuedAt = String(now);
  return `${issuedAt}.${sign(password, issuedAt)}`;
}

/**
 * Whether a cookie was issued by this instance and has not expired.
 *
 * There is no server-side session list, so a token is valid until it ages out or
 * the password changes. That is inherent to a shared password with no accounts:
 * revoking one browser individually would need identities, and there are none.
 */
export function tokenIsValid(
  password: string,
  token: string | undefined,
  now: number = Date.now(),
): boolean {
  if (!token) return false;
  const [issuedAt, signature] = token.split('.');
  if (!issuedAt || !signature) return false;
  if (!/^\d+$/.test(issuedAt)) return false;
  if (!sameSecret(signature, sign(password, issuedAt))) return false;

  // A token from the future is a clock that moved, not a valid session.
  const age = now - Number(issuedAt);
  return age >= 0 && age <= SESSION_MAX_AGE_SECONDS * 1000;
}

export function passwordMatches(expected: string, given: unknown): boolean {
  return typeof given === 'string' && given !== '' && sameSecret(given, expected);
}

/**
 * The `Set-Cookie` value for a signed-in browser.
 *
 * `HttpOnly` so a script cannot read it, `SameSite=Lax` so a cross-site request
 * cannot act with it, and deliberately not `Secure` — see the note above.
 */
export function sessionCookie(token: string): string {
  return (
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`
  );
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
