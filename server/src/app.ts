import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { createEngine, engineOptionsFrom, type EngineSettings } from '@sumline/engine';
import { Store, VersionConflictError, type Lock, type UserId } from './db.js';
import {
  FALLBACK_SPACE,
  deriveSpaceId,
  orphanedOwners,
  resolveSpace,
  spacesFromOwners,
  type Space,
} from './spaces.js';
import { RatesService, type RateFetcher } from './rates.js';
import { HolidayService, type HolidayFetcher } from './holidays.js';
import { Events, frame } from './events.js';
import {
  SESSION_COOKIE,
  SignInAttempts,
  clearedSessionCookie,
  issueToken,
  passwordMatches,
  sessionCookie,
  tokenIsValid,
} from './session.js';
import { WELCOME_SHEET } from './welcome.js';

export interface AppOptions {
  dbPath: string;
  /** Absolute path to the built web assets, or null to serve API only. */
  staticRoot?: string | null;
  rateFetcher?: RateFetcher;
  holidayFetcher?: HolidayFetcher;
  /** ISO country code whose public holidays apply to workday maths. */
  holidayCountry?: string;
  /**
   * Who gets a space on an instance that has none yet.
   *
   * A seed, not an override: an instance with spaces already keeps them, so a
   * space added or removed in the app is not undone by the next restart.
   */
  spaces?: Space[];
  /**
   * One shared password for the whole instance, or absent for no authentication.
   *
   * Absent is the default and changes nothing. See [`session.ts`](./session.ts)
   * for what setting it does and does not protect.
   */
  password?: string;
  /** Skip the background refresh timer; tests drive refreshes by hand. */
  autoRefreshRates?: boolean;
  rateRefreshIntervalMs?: number;
  lockTtlMs?: number;
  logger?: boolean;
  seedWelcomeSheet?: boolean;
  /** How often an idle event stream sends a beat. Tests turn this down. */
  eventHeartbeatMs?: number;
}

export interface App {
  server: FastifyInstance;
  store: Store;
  rates: RatesService;
  holidays: HolidayService;
  events: Events;
}

const DEFAULT_LOCK_TTL_MS = 45_000;

/**
 * How often an idle event stream sends a beat down the wire.
 *
 * Well under the minute most proxies and load balancers give an idle response
 * before closing it, and well under the point at which a phone's radio has
 * quietly dropped the connection without telling either end. The client reads
 * the same beats as proof the stream is still flowing — see `STALE_MS` there.
 */
const EVENT_HEARTBEAT_MS = 20_000;

/**
 * The longest sheet `POST /api/evaluate` will take in one call.
 *
 * Generous against any sheet a person writes and mean against a script that
 * pipes a file in by accident: evaluation is synchronous, so those lines are
 * spent with the event loop held.
 */
const MAX_EVALUATE_LINES = 1_000;

/**
 * How many distinct past dates one `POST /api/evaluate` may ask about.
 *
 * The line cap guards the time this process spends; this guards the requests it
 * makes of somebody else. `ratesNeeded` returns one date per distinct date
 * named, so without it a 1000-line body naming 1000 dates turns one
 * unauthenticated POST into 1000 outbound fetches. Generous against any sheet a
 * person writes — a sheet comparing a dozen invoices is nowhere near it.
 */
const MAX_EVALUATE_DATES = 30;

/** The cookie naming whose space this browser is working in. */
export const USER_COOKIE = 'sumline_user';

/** Returned by a shape check for a value it will not store. */
const INVALID = Symbol('invalid setting');

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
function readColor(value: unknown): string | null | typeof INVALID {
  if (value === null || value === undefined || value === '') return null;
  return readColorName(value);
}

/** A name like `western-europe`. */
const readRegion = shaped(/^[a-z]{2,20}(?:-[a-z]{2,20})?$/);

/** An IANA name like `Europe/Berlin`, or one of the aliases the engine reads. */
const readZone = shaped(/^[A-Za-z][A-Za-z0-9_+\-/ ]{1,60}$/);

/**
 * The settings that change what a sheet computes, rather than how it looks.
 *
 * These are the ones with two tiers — an instance-wide value every space
 * inherits, and a per-space override — because each is usually true of the whole
 * instance and occasionally true of one space alone. Display preferences stay
 * per space and free-form; a wrong one costs an odd-looking toggle.
 */
const COMPUTED_SETTINGS = ['region', 'zone'] as const;

/**
 * Validates one computed setting, or reports why it cannot be stored.
 *
 * `null` is allowed throughout and means "stop overriding": it deletes the
 * space's own value so the instance-wide one shows through again. Without it a
 * space could take an override on and never put it back.
 */
function readComputed(key: string, value: unknown): unknown | typeof INVALID {
  if (value === null) return null;
  switch (key) {
    case 'region':
      return readRegion(value);
    case 'zone':
      return readZone(value);
    default:
      return value;
  }
}

const COMPUTED_HELP: Record<string, string> = {
  region: 'region must be a name like western-europe, or null to inherit',
  zone: 'zone must be a name like Europe/Berlin, or null to inherit',
};

/**
 * Reads the space cookie off a request, without judging it.
 *
 * The cookie is set by the client and carries no signature, which is the point
 * — switching space is a preference, not a login, on an app that has no
 * authentication at all. Whether the value names a configured space is settled
 * by the caller, which has the configuration.
 */
function readCookie(request: FastifyRequest, wanted: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === wanted) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

function readSpaceCookie(request: FastifyRequest): string | undefined {
  return readCookie(request, USER_COOKIE);
}

/**
 * The path of a URL, with its percent-encoding undone.
 *
 * For deciding what an unrouted request *looks* like it was asking for. The
 * router does this before it matches, so `/%61pi/nope` and `/api/nope` are one
 * path to Fastify and must be one path to anything reasoning about it too.
 *
 * A malformed escape — `/%zz` — is left as it came rather than throwing: the
 * caller is choosing between two error shapes, and a request nobody can decode
 * is not an API request.
 */
function decodedPath(url: string): string {
  const path = url.split('?')[0] ?? '';
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export function buildApp(options: AppOptions): App {
  const server = Fastify({ logger: options.logger ?? false });

  // The store is opened before the spaces are settled because an unconfigured
  // instance takes its spaces from what the database already owns. Only the
  // DEFAULT clause for a freshly added owner column needs a value this early,
  // and on a database old enough to need that clause there is nothing to adopt.
  const store = new Store(
    options.dbPath,
    (options.spaces?.[0] ?? FALLBACK_SPACE).id,
  );

  /**
   * Fills the space table on an instance that has none.
   *
   * `SPACES` first, then the ids already stamped on the data — so upgrading an
   * instance that has been running with spaces does not hide everyone's sheets
   * behind a default that owns nothing — and a single generic space for one
   * that is genuinely empty. Runs once: after this the table is the authority
   * and spaces are added and removed through the API.
   */
  store.seedSpaces(
    options.spaces ?? spacesFromOwners(store.owners()) ?? [FALLBACK_SPACE],
  );

  // Read per request rather than captured, because spaces are now editable
  // while the server is running.
  const spaces = (): Space[] => store.listSpaces();

  // The data is intact — every list is filtered by owner and no space asks for
  // these ids — so this says how to get it back rather than merely reporting a
  // count. Reachable when a space is removed while it still owns sheets.
  const orphans = orphanedOwners(spaces(), store.owners());
  if (orphans.length > 0) {
    server.log.warn(
      `${orphans.length} owner id(s) hold sheets but have no space: ` +
        `${orphans.join(', ')}. Those sheets are stored but not shown. ` +
        `Add a space back under the same id to see them again.`,
    );
  }

  /**
   * The space this request is working in.
   *
   * Anything unrecognised resolves to the first space rather than erroring, so
   * a stale or hand-edited cookie — or one naming a space since removed —
   * cannot lock anyone out of the app.
   */
  const currentUser = (request: FastifyRequest): UserId =>
    resolveSpace(spaces(), readSpaceCookie(request));

  /** Gives a new space the sheet that explains the syntax, as startup does. */
  const seedWelcome = (id: string): void => {
    if (options.seedWelcomeSheet === false) return;
    if (store.listSheets(id).length > 0) return;
    store.createSheet(id, 'Welcome', WELCOME_SHEET);
  };

  const lockTtlMs = options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;

  const events = new Events();

  const rates = new RatesService({
    store,
    ...(options.rateFetcher && { fetcher: options.rateFetcher }),
    ...(options.rateRefreshIntervalMs !== undefined && {
      refreshIntervalMs: options.rateRefreshIntervalMs,
    }),
    onUpdate: (table) =>
      events.emit({ type: 'rates', date: table.date, stale: table.stale === true }),
    log: {
      info: (msg) => server.log.info(msg),
      warn: (msg) => server.log.warn(msg),
    },
  });

  const holidays = new HolidayService({
    store,
    ...(options.holidayCountry && { country: options.holidayCountry }),
    ...(options.holidayFetcher && { fetcher: options.holidayFetcher }),
    log: {
      info: (msg) => server.log.info(msg),
      warn: (msg) => server.log.warn(msg),
    },
  });

  // Seeded per space rather than per instance, so whoever opens the app second
  // still meets the sheet that explains the syntax instead of a blank page.
  if (options.seedWelcomeSheet !== false) {
    for (const space of spaces()) seedWelcome(space.id);
  }

  /**
   * The shared password, or null for an instance with no authentication.
   *
   * Whitespace-only is treated as absent: a `SUMLINE_PASSWORD=` left in a
   * compose file should not lock everyone out with a password nobody can type.
   */
  const password = options.password?.trim() ? options.password : null;

  const signedIn = (request: FastifyRequest): boolean =>
    password === null || tokenIsValid(password, readCookie(request, SESSION_COOKIE));

  /**
   * Routes reachable without signing in.
   *
   * `/api/health` stays open on purpose: the deploy workflow's gate polls it to
   * decide whether the container actually serves, and a health check that needs
   * a credential would report every healthy deploy as a failure. It discloses
   * only that the app is up and which date its rates carry.
   *
   * Anything outside `/api/` is the built UI, which has to load before anyone
   * can sign in — and holds no sheet data of its own.
   *
   * **This reads the route Fastify matched, not the URL the client sent, and
   * the difference is a hole big enough to walk through.** The router decodes
   * before it matches, so `/%61pi/sheets` is routed to `/api/sheets` while the
   * text of it does not begin with `/api/`. A guard testing that text answered
   * "open" and handed out every sheet on a password-protected instance. The
   * matched route is what actually decides which handler runs, so it is the
   * only thing safe to decide access from.
   */
  const isOpen = (request: FastifyRequest): boolean => {
    const route = request.routeOptions.url;

    // Two questions, because either one alone has been wrong. The matched route
    // is what decides which handler runs, and it is the only answer that cannot
    // be dressed up by encoding. The path is what an *unrouted* request has
    // instead: with the static plugin registered, `/api/nonexistent` matches its
    // `/*` wildcard rather than nothing at all, so judging by route alone would
    // wave it through and let the 404 that came back tell anyone who had not
    // signed in exactly which endpoints exist.
    const routedToApi = route !== undefined && route.startsWith('/api/');
    const asksForApi = decodedPath(request.url).startsWith('/api/');
    if (!routedToApi && !asksForApi) return true;

    // Under `/api/` by either reading, so only the two open endpoints are open —
    // named by the route they matched, never by how the caller spelled them.
    return route === '/api/health' || route === '/api/session';
  };

  if (password !== null) {
    server.addHook('onRequest', async (request, reply) => {
      if (isOpen(request) || signedIn(request)) return;
      // 401 rather than a redirect: every caller here is either fetch() from the
      // app, which shows the password form on this status, or a script.
      return reply.code(401).send({ error: 'This instance needs a password' });
    });
  }

  /**
   * Whether a password is needed, and whether this browser has given it.
   *
   * Open even when a password is set, because the app has to be able to ask.
   */
  server.get('/api/session', async (request) => ({
    required: password !== null,
    authenticated: signedIn(request),
  }));

  /**
   * Guessing is slowed down, because there is only ever one thing to guess.
   *
   * Held here rather than in the module so that each instance — and each test —
   * starts with an empty count. See `SignInAttempts` for what this does and does
   * not defend against.
   */
  const attempts = new SignInAttempts();

  server.post<{ Body: { password?: unknown } }>(
    '/api/session',
    async (request, reply) => {
      if (password === null) {
        return { required: false, authenticated: true };
      }

      const wait = attempts.delay(request.ip);
      if (wait > 0) {
        // 429 with `Retry-After`, not another 401: the password form should say
        // to come back shortly rather than that this attempt was wrong, and
        // reporting it as wrong would be a guess about a password never checked.
        return reply
          .code(429)
          .header('retry-after', String(Math.ceil(wait / 1000)))
          .send({
            error: 'Too many attempts. Try again shortly.',
            retryAfter: Math.ceil(wait / 1000),
          });
      }

      if (!passwordMatches(password, request.body?.password)) {
        attempts.fail(request.ip);
        return reply.code(401).send({ error: 'That password does not match' });
      }

      // A right answer forgets every wrong one, so someone who mistyped their
      // own password four times is not carrying those four into next week.
      attempts.clear(request.ip);
      return reply
        .header('set-cookie', sessionCookie(issueToken(password)))
        .send({ required: true, authenticated: true });
    },
  );

  server.delete('/api/session', async (_request, reply) =>
    reply
      .header('set-cookie', clearedSessionCookie())
      .send({ required: password !== null, authenticated: false }),
  );

  server.get('/api/users', async (request) => ({
    users: spaces(),
    current: currentUser(request),
  }));

  /**
   * Adds a space.
   *
   * The id is derived from the name unless one is given outright, which is how
   * a space can be created to match owner ids already in the database — the
   * way sheets belonging to a removed person are brought back.
   */
  server.post<{ Body: { name?: unknown; id?: unknown } }>(
    '/api/spaces',
    async (request, reply) => {
      const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
      if (!name) return reply.code(400).send({ error: 'A space needs a name' });

      const given = typeof request.body?.id === 'string' ? request.body.id : name;
      const id = deriveSpaceId(given);
      if (!id) {
        return reply.code(400).send({ error: `No usable id in ${JSON.stringify(given)}` });
      }

      const created = store.createSpace(id, name);
      if (!created) return reply.code(409).send({ error: `Space ${id} already exists` });

      // An id matching existing owners is a restoration, and its sheets are
      // already there — seeding a Welcome sheet over them would be noise.
      seedWelcome(id);
      return reply.code(201).send(created);
    },
  );

  server.patch<{ Params: { id: string }; Body: { name?: unknown } }>(
    '/api/spaces/:id',
    async (request, reply) => {
      const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
      if (!name) return reply.code(400).send({ error: 'A space needs a name' });
      if (!store.renameSpace(request.params.id, name)) {
        return reply.code(404).send({ error: 'No such space' });
      }
      return { id: request.params.id, name };
    },
  );

  /**
   * Removes a space without touching what it owns.
   *
   * Refused for the last one: an instance with no spaces has nowhere to put
   * the next sheet, and every request would resolve to a space that does not
   * exist. The reply reports how much went out of sight so the client can say
   * so rather than implying the sheets were deleted.
   */
  server.delete<{ Params: { id: string } }>('/api/spaces/:id', async (request, reply) => {
    const { id } = request.params;
    if (spaces().length <= 1) {
      return reply.code(409).send({ error: 'The last space cannot be removed' });
    }
    const hidden = store.countOwned(id);
    if (!store.deleteSpace(id)) return reply.code(404).send({ error: 'No such space' });
    return { deleted: true, hidden };
  });

  server.get('/api/health', async () => ({
    status: 'ok',
    rateDate: rates.current().date,
  }));

  /**
   * What changed, as it changes.
   *
   * The app was entirely poll-driven before this: the sheet list refreshed only
   * when *this* browser altered something, and the lock banner was as old as the
   * last 15-second heartbeat. So a second person opening your sheet, or renaming
   * one in the list, was invisible until you happened to act.
   *
   * Server-sent events rather than a socket because every message here goes one
   * way. The browser already has a well-tested client for them with reconnection
   * and backoff built in, and the alternative would be a dependency and a
   * protocol upgrade to send strictly less.
   *
   * The stream carries notice, not data — see `LiveEvent`. A client that misses
   * some is not left inconsistent, only late, and the `hello` it gets on every
   * connect tells it to resync.
   */
  server.get('/api/events', (request, reply) => {
    // Fastify must not try to send its own reply down a socket we are about to
    // hold open for the life of the tab.
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // nginx buffers a proxied response by default, which for a stream that
      // never ends means holding every event forever. This is the header it
      // reads to leave one alone; the client's staleness check is what catches
      // the proxies that have no such header.
      'x-accel-buffering': 'no',
    });

    const write = (chunk: string): void => {
      if (!reply.raw.writableEnded) reply.raw.write(chunk);
    };

    // Slower than the browser's own three-second default. A server that has
    // gone away is usually gone for longer than that, and a room of tabs each
    // retrying three times a second is a denial of service with extra steps.
    write('retry: 5000\n\n');

    const beat = setInterval(
      () => write(frame({ type: 'beat' })),
      options.eventHeartbeatMs ?? EVENT_HEARTBEAT_MS,
    );
    beat.unref?.();

    const unsubscribe = events.subscribe({
      // Fixed at connect time, which is correct: switching space reloads the
      // app, and a reload is a new stream.
      owner: currentUser(request),
      send: (event) => write(frame(event)),
      close: () => reply.raw.end(),
    });

    const stop = (): void => {
      clearInterval(beat);
      unsubscribe();
    };
    request.raw.on('close', stop);
    reply.raw.on('close', stop);

    write(frame({ type: 'hello', rateDate: rates.current().date }));
  });

  /** Says a space's sheet and folder list has moved. */
  const listChanged = (owner: UserId): void => events.emit({ type: 'list', owner });

  /**
   * The current rates, or `?on=YYYY-MM-DD` for a past date.
   *
   * 404 rather than today's table when a past date cannot be answered: the
   * client turns that into "no rates for that date" on the line, where silently
   * substituting the current rate would be the wrong answer wearing the right
   * clothes.
   */
  server.get<{ Querystring: { on?: string } }>(
    '/api/rates',
    async (request, reply) => {
      const on = request.query?.on;
      if (on === undefined) return rates.current();

      const table = await rates.historical(on);
      if (!table) {
        return reply.code(404).send({ error: `No exchange rates available for ${on}` });
      }
      return table;
    },
  );

  /**
   * The public holidays behind workday maths.
   *
   * One table for the whole instance, from `HOLIDAY_COUNTRY`: unlike the region
   * and the zone, a space cannot pin its own country. Which is why this takes
   * no request — there is nothing about the caller that would change the answer.
   */
  server.get('/api/holidays', async () => holidays.current());

/**
   * A space's settings, plus the tier above it and the two resolved together.
   *
   * `sharedGlobals`, `effectiveGlobals`, `shared` and `effective` are derived,
   * not stored here — they are returned so precedence is decided in one place
   * rather than in whichever client happens to be merging. `PUT` refuses them
   * for the same reason.
   */
  const settingsFor = (owner: UserId) => {
    const own = store.getSettings(owner);
    const instance = store.sharedSettings();
    const shared = (instance['globals'] ?? {}) as Record<string, string>;
    const mine = (own['globals'] ?? {}) as Record<string, string>;

    /*
     * The settings that change what a sheet computes get the same two tiers as
     * the globals, and for the same reason: a number region or a time zone is
     * usually true of the whole instance, and occasionally true of one space
     * only. Defining it once and overriding where it differs beats setting it
     * again in every space and beats having no instance-wide answer at all.
     */
    const sharedComputed: Record<string, unknown> = {};
    const effectiveComputed: Record<string, unknown> = {};
    for (const key of COMPUTED_SETTINGS) {
      if (instance[key] !== undefined) sharedComputed[key] = instance[key];
      // Most specific wins, exactly as with a named global.
      const winner = own[key] ?? instance[key];
      if (winner !== undefined) effectiveComputed[key] = winner;
    }

    return {
      ...own,
      sharedGlobals: shared,
      // Most specific wins: a space's own value displaces the shared one of the
      // same name, and a sheet's own declaration displaces both later on.
      effectiveGlobals: { ...shared, ...mine },
      shared: sharedComputed,
      effective: effectiveComputed,
    };
  };

  server.get('/api/settings', async (request) => settingsFor(currentUser(request)));

  server.put<{ Body: Record<string, unknown> }>(
    '/api/settings',
    async (request, reply) => {
      // Dropped rather than stored. A client that echoed a GET response back
      // would otherwise write the merged view into the space, silently promoting
      // every inherited value into one of its own — and then a change to the
      // shared tier would stop reaching it.
      const { sharedGlobals: _s, effectiveGlobals: _e, ...changes } = request.body ?? {};

      /*
       * Only the two settings that change what a sheet *computes* are checked.
       * The rest of this store stays free-form, as it has always been: they are
       * display preferences, and a nonsense value costs a wrong-looking toggle
       * rather than a sheet full of missing answers.
       */
      for (const key of COMPUTED_SETTINGS) {
        if (!(key in changes)) continue;
        const value = readComputed(key, changes[key]);
        if (value === INVALID) {
          return reply.code(400).send({ error: COMPUTED_HELP[key] });
        }
        // Written back because validation normalises: a space that typed `de`
        // and one that typed `DE` must share a holiday table rather than
        // fetching the same calendar twice under two keys.
        changes[key] = value;
      }

      const owner = currentUser(request);
      store.saveSettings(owner, changes);
      events.emit({ type: 'settings', owner });
      return settingsFor(owner);
    },
  );

  /**
   * The globals that apply in every space.
   *
   * Not scoped by the space cookie, because the whole point is that it is not
   * per space. There is no authentication anywhere in this app, so this is
   * editable by anyone who can reach it — the one setting here that reaches
   * past the space you are working in.
   */
  server.put<{ Body: { globals?: unknown } & Record<string, unknown> }>(
    '/api/settings/shared',
    async (request, reply) => {
      /*
       * The computed settings live here as well as per space, and this is the
       * tier a space inherits when it has not overridden one. Validated by the
       * same rules, so an instance-wide value cannot be something a space would
       * have been refused.
       */
      const wide: Record<string, unknown> = {};
      for (const key of COMPUTED_SETTINGS) {
        if (!(key in (request.body ?? {}))) continue;
        const value = readComputed(key, request.body[key]);
        if (value === INVALID) {
          return reply.code(400).send({ error: COMPUTED_HELP[key] });
        }
        wide[key] = value;
      }

      const globals = request.body?.globals;
      // Globals stay optional here: this endpoint is now two things, and setting
      // a region instance-wide should not require sending the variables too.
      if (globals === undefined && Object.keys(wide).length > 0) {
        store.saveSharedSettings(wide);
        // Null owner: this tier is inherited by every space, so every stream
        // hears about it rather than only the one that made the change.
        events.emit({ type: 'settings', owner: null });
        return { ...wide };
      }
      // Arrays are objects, and an array would land as globals named "0", "1"
      // — accepted, stored, and useless.
      if (
        globals === undefined ||
        globals === null ||
        typeof globals !== 'object' ||
        Array.isArray(globals)
      ) {
        return reply.code(400).send({ error: 'globals must be an object of names to values' });
      }
      const cleaned: Record<string, string> = {};
      for (const [name, value] of Object.entries(globals as Record<string, unknown>)) {
        if (name.trim() === '' || typeof value !== 'string') continue;
        cleaned[name.trim()] = value;
      }
      store.saveSharedSettings({ ...wide, globals: cleaned });
      events.emit({ type: 'settings', owner: null });
      return { ...wide, globals: cleaned };
    },
  );

  /**
   * Evaluates a sheet without storing one, in the caller's space.
   *
   * The point is not the evaluation — the engine is pure and a client could
   * carry it — but the *space*. `day rate * 3` has to mean the same thing in a
   * launcher, in a script and in a sheet, and the only way that holds is if the
   * globals, region and zone come from the same place the sheet's do. So this
   * reads the space cookie exactly as `/api/settings` does, and builds its
   * options with the engine's own `engineOptionsFrom` rather than a second
   * mapping that could drift from the browser's.
   *
   * It also does one thing the browser cannot: past rates are fetched here,
   * so `100 USD in EUR on 2020-01-01` is answered in a single call rather than
   * over the two round trips a synchronous engine forces on a client.
   */
  /**
   * The engines `POST /api/evaluate` has already built.
   *
   * `createEngine` builds a whole math.js instance — every factory the library
   * ships, then a `createUnit` call per everyday alias and per currency in the
   * rate table, some thirty of them each mutating the new instance's unit
   * table. Beside that, evaluating a handful of lines is nothing, and this is
   * one synchronous process serving everybody: the cost came out of every other
   * caller's latency, which is the same argument `MAX_EVALUATE_LINES` makes
   * about the lines.
   *
   * Disposability is still the virtue the engine claims for itself — an
   * instance is rebuilt whenever its inputs change, which is what keeps the
   * engine free of mutable global state. That is an argument for rebuilding
   * when the inputs change, not once a request. The browser already reads it
   * that way; `useEngine` memoises on the same things, so it rebuilds when
   * rates land rather than on every keystroke.
   *
   * Keyed on everything that decides the answer: the space's resolved options,
   * the rate and holiday tables, and which past dates are in hand. The two
   * tables are compared by identity rather than by value, which is exact
   * rather than approximate — a refresh installs a new object, and nothing
   * mutates one in place.
   *
   * Four entries, most recent first. An instance has a space or two, and the
   * rate table changes twice a day.
   */
  const ENGINE_CACHE_SIZE = 4;
  const engineCache: Array<{
    key: string;
    rates: object;
    holidays: readonly string[];
    engine: ReturnType<typeof createEngine>;
  }> = [];

  const engineFor = (
    key: string,
    rateTable: object,
    holidayDates: readonly string[],
    build: () => ReturnType<typeof createEngine>,
  ): ReturnType<typeof createEngine> => {
    const at = engineCache.findIndex(
      (entry) =>
        entry.key === key && entry.rates === rateTable && entry.holidays === holidayDates,
    );
    if (at !== -1) {
      const [hit] = engineCache.splice(at, 1);
      engineCache.unshift(hit!);
      return hit!.engine;
    }
    const engine = build();
    engineCache.unshift({ key, rates: rateTable, holidays: holidayDates, engine });
    engineCache.length = Math.min(engineCache.length, ENGINE_CACHE_SIZE);
    return engine;
  };

  server.post<{ Body: { input?: unknown } }>('/api/evaluate', async (request, reply) => {
    const input = request.body?.input;
    const source = Array.isArray(input) ? input : typeof input === 'string' ? input : null;
    if (source === null) {
      return reply.code(400).send({ error: 'input must be a string or an array of lines' });
    }

    const lines = Array.isArray(source) ? source : source.split('\n');
    if (lines.some((line) => typeof line !== 'string')) {
      return reply.code(400).send({ error: 'input must be a string or an array of lines' });
    }
    /*
     * Evaluation is synchronous and this is one process serving everybody, so a
     * sheet long enough to take a second takes the second from every other
     * caller too. The app's own sheets are nowhere near this; a script pasting
     * a log file could be.
     */
    if (lines.length > MAX_EVALUATE_LINES) {
      return reply
        .code(413)
        .send({ error: `input is limited to ${MAX_EVALUATE_LINES} lines` });
    }

    const settings = settingsFor(currentUser(request)) as EngineSettings;
    const options = engineOptionsFrom(settings);
    const rateTable = rates.current();
    const holidayDates = holidays.current().dates;
    const base = { ...options, rates: rateTable, holidays: holidayDates };
    const spaceKey = JSON.stringify(options);

    // Two passes, because the engine reports what it needs by parsing: the
    // first says which past dates the sheet asks about, the second answers
    // with them in hand. Skipped entirely by a sheet that names no date, and
    // both passes come out of the cache above when nothing has moved.
    let engine = engineFor(spaceKey, rateTable, holidayDates, () => createEngine(base));
    const wanted = engine.ratesNeeded(lines);
    if (wanted.length > MAX_EVALUATE_DATES) {
      // Refused before a single fetch goes out, which is the whole point.
      return reply
        .code(413)
        .send({ error: `input is limited to ${MAX_EVALUATE_DATES} past dates` });
    }
    if (wanted.length > 0) {
      const fetched = await Promise.all(
        wanted.map(async (date) => [date, await rates.historical(date)] as const),
      );
      // The dates and what came back for each: a date that could not be
      // answered before and can be now is a different engine, not a hit.
      const past = fetched.map(([date, table]) => `${date}>${table?.date ?? '-'}`).join(',');
      engine = engineFor(`${spaceKey}\u0000${past}`, rateTable, holidayDates, () =>
        createEngine({ ...base, historicalRates: Object.fromEntries(fetched) }),
      );
    }

    const results = engine.evaluate(lines);
    return {
      results: results.map((line) => ({
        index: line.index,
        kind: line.kind,
        input: lines[line.index] ?? '',
        output: line.output,
        ...(line.error !== undefined && { error: line.error }),
      })),
      total: engine.total(results),
      rateDate: engine.rateDate,
    };
  });

  server.get('/api/folders', async (request) => ({
    folders: store.listFolders(currentUser(request)),
  }));

  server.post<{ Body: { name?: string } }>('/api/folders', async (request, reply) => {
    const name = (typeof request.body?.name === 'string' ? request.body.name : '').trim();
    if (!name) return reply.code(400).send({ error: 'name is required' });
    const owner = currentUser(request);
    reply.code(201);
    const folder = store.createFolder(owner, name);
    listChanged(owner);
    return folder;
  });

  server.put<{ Params: { id: string }; Body: { name?: string } }>(
    '/api/folders/:id',
    async (request, reply) => {
      const name = (typeof request.body?.name === 'string' ? request.body.name : '').trim();
      if (!name) return reply.code(400).send({ error: 'name is required' });
      const owner = currentUser(request);
      if (!store.renameFolder(request.params.id, name, owner)) {
        return reply.code(404).send({ error: 'Folder not found' });
      }
      listChanged(owner);
      return { id: request.params.id, name };
    },
  );

  server.put<{ Params: { id: string }; Body: { color?: unknown } }>(
    '/api/folders/:id/color',
    async (request, reply) => {
      const color = readColor(request.body?.color);
      if (color === INVALID) return reply.code(400).send({ error: 'Unusable colour' });
      const owner = currentUser(request);
      if (!store.setFolderColor(request.params.id, color, owner)) {
        return reply.code(404).send({ error: 'Folder not found' });
      }
      listChanged(owner);
      return { id: request.params.id, color };
    },
  );

  server.delete<{ Params: { id: string } }>(
    '/api/folders/:id',
    async (request, reply) => {
      const owner = currentUser(request);
      if (!store.deleteFolder(request.params.id, owner)) {
        return reply.code(404).send({ error: 'Folder not found' });
      }
      listChanged(owner);
      // The folder's sheets are not deleted with it — they return to the top
      // level, because losing notes to a folder tidy-up would be indefensible.
      return { deleted: true };
    },
  );

  server.get<{ Querystring: { folder?: string; q?: string; trash?: string } }>(
    '/api/sheets',
    async (request) => {
      const { folder, q, trash } = request.query ?? {};
      const owner = currentUser(request);
      return {
        sheets: store.listSheets(owner, {
          ...(folder !== undefined && { folderId: folder === '' ? null : folder }),
          ...(q !== undefined && { query: q }),
          ...(trash === '1' && { trashed: true }),
          // Read from this space's settings rather than asked for by the
          // client, so every caller — including a second browser that has
          // never been told — sees the order this space chose.
          ...(store.getSettings(owner)['sheetOrder'] === 'manual' && {
            manualOrder: true,
          }),
        }),
      };
    },
  );

  /**
   * Rearranges the sheets named, in the order given.
   *
   * Switches the space to manual order on the way through, because a drag is
   * an unambiguous statement that the list should stop rearranging itself —
   * asking the client to send a settings change alongside every reorder would
   * only invite the two to disagree.
   */
  server.put<{ Body: { ids?: unknown } }>('/api/sheets/order', async (request, reply) => {
    const ids = request.body?.ids;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
      return reply.code(400).send({ error: 'ids must be an array of sheet ids' });
    }
    const owner = currentUser(request);
    if (!store.reorderSheets(owner, ids as string[])) {
      return reply.code(400).send({ error: 'Nothing to reorder' });
    }
    store.saveSettings(owner, { sheetOrder: 'manual' });
    listChanged(owner);
    // The reorder changed a setting on its way through, and a second browser in
    // this space has to hear about that too or its sidebar goes on offering to
    // sort by recent while the list is arranged by hand.
    events.emit({ type: 'settings', owner });
    return { ordered: true };
  });

  server.post<{ Params: { id: string } }>(
    '/api/sheets/:id/restore',
    async (request, reply) => {
      const owner = currentUser(request);
      if (!store.restoreSheet(request.params.id, owner)) {
        return reply.code(404).send({ error: 'Sheet not found' });
      }
      listChanged(owner);
      return { restored: true };
    },
  );

  server.delete('/api/trash', async (request) => {
    const owner = currentUser(request);
    const purged = store.emptyTrash(owner);
    if (purged > 0) listChanged(owner);
    return { purged };
  });

  server.post<{ Body: { title?: string; content?: string; folderId?: string | null } }>(
    '/api/sheets',
    async (request, reply) => {
      // Anything that is not a string is treated as absent rather than
      // crashing the handler — a client sending the wrong type gets a sheet,
      // not a 500.
      const rawTitle = request.body?.title;
      const rawContent = request.body?.content;
      const title = (typeof rawTitle === 'string' ? rawTitle : '').trim() || 'Untitled';
      const owner = currentUser(request);
      const sheet = store.createSheet(
        owner,
        title,
        typeof rawContent === 'string' ? rawContent : '',
        typeof request.body?.folderId === 'string' ? request.body.folderId : null,
      );
      listChanged(owner);
      reply.code(201);
      return sheet;
    },
  );

  /*
   * What a space protects, for every route below that names a sheet.
   *
   * Reading and editing another space's sheet through a share link is meant to
   * work — that is what the link is for, and the lock still serialises the
   * editing. Destroying it is not: following a link must never put anyone one
   * mis-click from deleting work that is not theirs. So `GET` and `PUT` take
   * the sheet as they find it, and `DELETE` is scoped to the caller's space
   * and answers 404 for anything outside it.
   *
   * Colour goes with the scoped set rather than the editing one, decided
   * rather than defaulted. Recolouring is not an edit to the sheet: it changes
   * how a row looks in a sidebar the caller cannot see, in a space they are
   * not working in, and the lock does not serialise it. Folder colour — the
   * same gesture — was already scoped, because folders have no share link to
   * be reached by. The two halves of one gesture now agree.
   */
  /**
   * Who is editing a sheet, expiring a lapsed lock on the way and saying so.
   *
   * Every other lock transition emits an event — acquired, released, the sheet
   * trashed — and expiry did not, because it happened inside a store read with
   * no access to `events`. A tab that crashes, sleeps or loses its network
   * never gets to say it has let go, so expiry is the only thing that frees
   * the sheet, and it was the one transition nobody heard about.
   *
   * The browser copes either way: a read-only tab schedules a re-ask timed to
   * the holder's expiry. Announcing it makes that timer the fallback rather
   * than the mechanism, which is how the heartbeat poll is already framed.
   */
  const lockNow = (sheetId: string): Lock | null => {
    const lapsed = store.expireLock(sheetId);
    if (lapsed) events.emit({ type: 'lock', sheetId, holder: null });
    return store.lockAsOf(sheetId);
  };

  server.get<{ Params: { id: string } }>(
    '/api/sheets/:id',
    async (request, reply) => {
      const sheet = store.getSheet(request.params.id);
      if (!sheet) return reply.code(404).send({ error: 'Sheet not found' });
      return { ...sheet, lock: lockNow(sheet.id) };
    },
  );

  // Minting is a POST because it can create a slug, and it is deliberately
  // separate from opening a sheet: the URL only ever carries an identifier
  // when someone has explicitly asked for a link to send.
  server.post<{ Params: { id: string } }>(
    '/api/sheets/:id/share',
    async (request, reply) => {
      const slug = store.shareSheet(request.params.id);
      if (!slug) return reply.code(404).send({ error: 'Sheet not found' });
      return { slug };
    },
  );

  // Static `by-slug` sits ahead of the `:id` parameter in the router, so a
  // slug can never be mistaken for a sheet id.
  server.get<{ Params: { slug: string } }>(
    '/api/sheets/by-slug/:slug',
    async (request, reply) => {
      const id = store.resolveSlug(request.params.slug);
      if (!id) return reply.code(404).send({ error: 'Sheet not found' });
      return { id };
    },
  );

  server.put<{
    Params: { id: string };
    Body: {
      title?: string;
      content?: string;
      version?: number;
      folderId?: string | null;
    };
  }>('/api/sheets/:id', async (request, reply) => {
    // Kept, not discarded: the owner is the sheet's own rather than the
    // caller's, so an edit made through a share link tells the list the sheet
    // actually belongs to instead of the list the editor happens to be looking
    // at — which does not hold it.
    const existing = store.getSheet(request.params.id);
    if (!existing) {
      return reply.code(404).send({ error: 'Sheet not found' });
    }
    try {
      const changes: { title?: string; content?: string; folderId?: string | null } = {};
      if (typeof request.body?.title === 'string') changes.title = request.body.title;
      if (typeof request.body?.content === 'string') changes.content = request.body.content;
      if (request.body?.folderId !== undefined) changes.folderId = request.body.folderId;
      const saved = store.updateSheet(request.params.id, changes, request.body?.version);
      events.emit({
        type: 'sheet',
        id: saved.id,
        owner: existing.owner,
        version: saved.version,
      });
      listChanged(existing.owner);
      return saved;
    } catch (error) {
      if (error instanceof VersionConflictError) {
        // Hand back the server's copy so the client can show what it would
        // have overwritten instead of just failing.
        return reply
          .code(409)
          .send({ error: 'Sheet was modified elsewhere', current: error.current });
      }
      throw error;
    }
  });

  server.put<{ Params: { id: string }; Body: { color?: unknown } }>(
    '/api/sheets/:id/color',
    async (request, reply) => {
      const color = readColor(request.body?.color);
      if (color === INVALID) return reply.code(400).send({ error: 'Unusable colour' });
      const owner = currentUser(request);
      if (!store.setSheetColor(request.params.id, color, owner)) {
        return reply.code(404).send({ error: 'Sheet not found' });
      }
      listChanged(owner);
      return { id: request.params.id, color };
    },
  );

  server.delete<{ Params: { id: string }; Querystring: { purge?: string } }>(
    '/api/sheets/:id',
    async (request, reply) => {
      // Deleting moves a sheet to the trash. Permanent removal is opt-in,
      // because a working note is not worth losing to a mis-click.
      //
      // Both are scoped to the caller's space, so a sheet reached through a
      // share link reports 404 here rather than being deleted out from under
      // the person it belongs to.
      const owner = currentUser(request);
      const held = lockNow(request.params.id) !== null;
      const removed =
        request.query?.purge === '1'
          ? store.deleteSheet(request.params.id, owner)
          : store.trashSheet(request.params.id, owner);
      if (!removed) return reply.code(404).send({ error: 'Sheet not found' });
      listChanged(owner);
      // Both paths drop the lock in the store, so a browser sitting on this
      // sheet read-only is told rather than left with a banner about someone
      // editing a sheet that is now in the trash.
      if (held) {
        events.emit({ type: 'lock', sheetId: request.params.id, holder: null });
      }
      return { deleted: true };
    },
  );

  server.post<{
    Params: { id: string };
    Body: { clientId?: string; clientName?: string; force?: boolean };
  }>('/api/sheets/:id/lock', async (request, reply) => {
    const clientId = request.body?.clientId;
    if (!clientId) return reply.code(400).send({ error: 'clientId is required' });
    if (!store.getSheet(request.params.id)) {
      return reply.code(404).send({ error: 'Sheet not found' });
    }

    const before = lockNow(request.params.id);
    const result = store.acquireLock(
      request.params.id,
      clientId,
      request.body?.clientName ?? null,
      lockTtlMs,
      request.body?.force === true,
    );
    // Only when the holder actually changed hands. This endpoint is also the
    // heartbeat, called every fifteen seconds by whoever is editing, and a
    // broadcast on each of those would be a stream of "still the same person".
    if (result.granted && before?.clientId !== result.lock.clientId) {
      events.emit({ type: 'lock', sheetId: request.params.id, holder: result.lock });
    }
    return { granted: result.granted, lock: result.lock, ttlMs: lockTtlMs };
  });

  server.delete<{ Params: { id: string }; Querystring: { clientId?: string } }>(
    '/api/sheets/:id/lock',
    async (request, reply) => {
      const clientId = request.query?.clientId;
      if (!clientId) return reply.code(400).send({ error: 'clientId is required' });
      const before = lockNow(request.params.id);
      store.releaseLock(request.params.id, clientId);
      // Silent unless this really was the holder letting go — every tab that
      // closes calls this for the sheet it had open, whether or not it was the
      // one editing, and the sheet is free either way.
      if (before?.clientId === clientId) {
        events.emit({ type: 'lock', sheetId: request.params.id, holder: null });
      }
      return reply.code(204).send();
    },
  );

  if (options.staticRoot && existsSync(options.staticRoot)) {
    void server.register(fastifyStatic, { root: options.staticRoot });
    // Single-page app: unknown non-API paths return the shell, so a deep link
    // or a refresh does not 404.
    server.setNotFoundHandler((request, reply) => {
      // Nothing matched, so there is no route to read here as there is in the
      // guard above — the path itself is all there is. It is decoded first for
      // the same reason the guard stopped trusting the raw text: `/%61pi/nope`
      // is an API path someone typed wrong, and answering it with the app shell
      // tells a script its endpoint exists. Only the shape of the error rides
      // on this; nothing is let through either way.
      if (decodedPath(request.url).startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  if (options.autoRefreshRates !== false) {
    rates.start();
    holidays.start();
  }

  /*
   * `preClose`, not `onClose`, and that distinction is the whole point of the
   * hook: `onClose` runs *after* Fastify has stopped the HTTP server and waited
   * for its connections to finish. These connections are designed never to
   * finish, so a shutdown would sit there until the last tab was closed — which
   * in a test run means a suite that hangs rather than a server that stops.
   */
  server.addHook('preClose', async () => {
    events.closeAll();
  });

  server.addHook('onClose', async () => {
    rates.stop();
    holidays.stop();
    store.close();
  });

  return { server, store, rates, holidays, events };
}
