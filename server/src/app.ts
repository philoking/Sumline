import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { Store, type UserId } from './db.js';
import {
  FALLBACK_SPACE,
  orphanedOwners,
  resolveSpace,
  spacesFromOwners,
  type Space,
} from './spaces.js';
import { RatesService, type RateFetcher } from './rates.js';
import { HolidayService, type HolidayFetcher } from './holidays.js';
import { Events } from './events.js';
import { SESSION_COOKIE, tokenIsValid } from './session.js';
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

/** The cookie naming whose space this browser is working in. */
export const USER_COOKIE = 'sumline_user';

/** Returned by a shape check for a value it will not store. */
import { folderRoutes } from './routes/folders.js';
import { sheetRoutes } from './routes/sheets.js';
import { makeSettingsFor, settingsRoutes } from './routes/settings.js';
import { identityRoutes } from './routes/identity.js';
import { instanceRoutes } from './routes/instance.js';
import type { RouteContext } from './routes/context.js';

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
  const store = new Store(options.dbPath, (options.spaces?.[0] ?? FALLBACK_SPACE).id);

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

  /** Says a space's sheet and folder list has moved. */
  const listChanged = (owner: UserId): void => events.emit({ type: 'list', owner });

  /**
   * What the route modules are allowed to reach.
   *
   * Built once and handed to each family. A module can use what is on this
   * object and nothing else, which is the difference between a split and
   * thirty-three routes that merely live in more files.
   */
  const settingsFor = makeSettingsFor(store);
  const routeContext: RouteContext = {
    store,
    events,
    currentUser,
    listChanged,
    settingsFor,
  };

  instanceRoutes(server, routeContext, {
    rates,
    holidays,
    heartbeatMs: options.eventHeartbeatMs,
  });

  identityRoutes(server, routeContext, { password, signedIn, spaces, seedWelcome });

  settingsRoutes(server, routeContext);

  folderRoutes(server, routeContext);

  sheetRoutes(server, routeContext, { lockTtlMs });

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
