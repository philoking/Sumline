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

export const SESSION_COOKIE = 'sumline_session';

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

/** Wrong answers one address may give before it has to wait. */
export const SIGN_IN_ATTEMPT_LIMIT = 10;

/**
 * How long the counter remembers a wrong answer, and how long the wait is once
 * the limit is reached — deliberately the same number, so there is one thing to
 * reason about rather than two.
 */
export const SIGN_IN_WINDOW_MS = 5 * 60 * 1000;

/**
 * Wrong passwords, counted per address.
 *
 * The shared password is the only credential the instance has, and a form that
 * answers as fast as it is asked turns it into whatever an attacker is willing
 * to spend an afternoon enumerating. Ten tries per five minutes leaves someone
 * who mistyped their own password entirely unbothered and makes guessing at any
 * useful rate impossible.
 *
 * What it is not: a defence against a distributed attacker. The count is per
 * address and lives in this process, so it is forgotten on restart and says
 * nothing about a thousand addresses trying once each. Like the password
 * itself, it raises the bar rather than closing the door — see the note at the
 * top of this file.
 *
 * Behind a reverse proxy, every request arrives from the proxy and the whole
 * instance shares one counter. That is less wrong than it sounds here: there is
 * exactly one password, so an attacker guessing it and a user typing it are the
 * same event as far as this can tell, and locking out "everyone" is locking out
 * the one credential. It does mean an instance behind a proxy should be reading
 * the forwarded address if it wants this per-user, which needs Fastify's
 * `trustProxy` and a proxy that is actually trustworthy.
 */
export class SignInAttempts {
  private readonly failures = new Map<string, { count: number; until: number }>();

  /**
   * Milliseconds this address must wait, or 0 if it may try now.
   *
   * Expiry is checked on the way past rather than swept on a timer: an entry
   * exists only because someone got the password wrong, and it is dropped the
   * first time it is looked at after its window.
   */
  delay(address: string, now: number = Date.now()): number {
    const seen = this.failures.get(address);
    if (!seen) return 0;
    if (now >= seen.until) {
      this.failures.delete(address);
      return 0;
    }
    return seen.count >= SIGN_IN_ATTEMPT_LIMIT ? seen.until - now : 0;
  }

  /**
   * Records a wrong password.
   *
   * A blocked attempt is never recorded, so hammering the form does not extend
   * the wait indefinitely: someone locked out by an attacker sharing their
   * address still gets back in five minutes after the last wrong answer that
   * was actually checked.
   */
  fail(address: string, now: number = Date.now()): void {
    const seen = this.failures.get(address);
    const count = seen && now < seen.until ? seen.count + 1 : 1;
    this.failures.set(address, { count, until: now + SIGN_IN_WINDOW_MS });
    this.prune(now);
  }

  /** Forgets an address, which a correct password does. */
  clear(address: string): void {
    this.failures.delete(address);
  }

  /**
   * Drops expired entries once the map is larger than any real instance needs.
   *
   * Only reached from `fail`, so the cost falls on whoever is guessing rather
   * than on the people signing in successfully.
   */
  private prune(now: number): void {
    if (this.failures.size <= 1000) return;
    for (const [address, seen] of this.failures) {
      if (now >= seen.until) this.failures.delete(address);
    }
  }
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
