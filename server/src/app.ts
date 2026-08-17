import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { Store, VersionConflictError, type UserId } from './db.js';
import {
  FALLBACK_SPACE,
  deriveSpaceId,
  orphanedOwners,
  resolveSpace,
  spacesFromOwners,
  type Space,
} from './spaces.js';
import { RatesService, type RateFetcher } from './rates.js';
import { HolidayService, normaliseCountry, type HolidayFetcher } from './holidays.js';
import {
  SESSION_COOKIE,
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
}

export interface App {
  server: FastifyInstance;
  store: Store;
  rates: RatesService;
  holidays: HolidayService;
}

const DEFAULT_LOCK_TTL_MS = 45_000;

/** The cookie naming whose space this browser is working in. */
export const USER_COOKIE = 'webcalc_user';

/** Returned by `readColor` for a value it will not store. */
const INVALID = Symbol('invalid colour');

/**
 * Checks a colour-coding token on its way in.
 *
 * The server never interprets the token — it reaches the browser as part of a
 * class name and the stylesheet decides what it looks like. So what matters
 * here is the charset, not the membership: a name outside this alphabet could
 * escape the class attribute, while an unknown-but-harmless name simply
 * matches no rule and shows no colour. Keeping the palette itself in the web,
 * where the shades live, avoids two lists that have to be kept in step.
 */
function readColor(value: unknown): string | null | typeof INVALID {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return INVALID;
  return /^[a-z]{2,12}$/.test(value) ? value : INVALID;
}

/**
 * Checks a number-region token on its way in.
 *
 * Shape, not membership — the same call as `readColor` above and for the same
 * reason. The list of regions lives in the engine, which the server does not
 * depend on at runtime, so validating membership here would mean a second copy
 * to keep in step. An unrecognised-but-well-formed name is harmless: the engine
 * coerces anything it does not know back to its default.
 */
function readRegion(value: unknown): string | typeof INVALID {
  if (typeof value !== 'string') return INVALID;
  return /^[a-z]{2,20}(?:-[a-z]{2,20})?$/.test(value) ? value : INVALID;
}

/**
 * Checks a timezone name on its way in.
 *
 * Shape, not membership, for the third time and the same reason: the zone table
 * lives in the engine, which this server does not depend on at runtime. An
 * unrecognised-but-well-formed name is harmless — the engine falls back to the
 * reader's own zone, which is what it would have used anyway.
 */
function readZone(value: unknown): string | typeof INVALID {
  if (typeof value !== 'string') return INVALID;
  const name = value.trim();
  return /^[A-Za-z][A-Za-z0-9_+\-/ ]{1,60}$/.test(name) ? name : INVALID;
}

/**
 * Checks a default frame rate on its way in.
 *
 * Everything that reads a timecode divides by this, so it has to be a positive
 * finite number. The bound is generous rather than principled: it exists to
 * reject a typo, not to have an opinion about cinematography.
 */
function readFps(value: unknown): number | typeof INVALID {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1000
    ? value
    : INVALID;
}

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

  const rates = new RatesService({
    store,
    ...(options.rateFetcher && { fetcher: options.rateFetcher }),
    ...(options.rateRefreshIntervalMs !== undefined && {
      refreshIntervalMs: options.rateRefreshIntervalMs,
    }),
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
   * Whitespace-only is treated as absent: a `WEBCALC_PASSWORD=` left in a
   * compose file should not lock everyone out with a password nobody can type.
   */
  const password = options.password?.trim() ? options.password : null;

  const signedIn = (request: FastifyRequest): boolean =>
    password === null || tokenIsValid(password, readCookie(request, SESSION_COOKIE));

  /**
   * Paths reachable without signing in.
   *
   * `/api/health` stays open on purpose: the deploy workflow's gate polls it to
   * decide whether the container actually serves, and a health check that needs
   * a credential would report every healthy deploy as a failure. It discloses
   * only that the app is up and which date its rates carry.
   *
   * Anything outside `/api/` is the built UI, which has to load before anyone
   * can sign in — and holds no sheet data of its own.
   */
  const isOpen = (url: string): boolean => {
    const path = url.split('?')[0] ?? '';
    if (!path.startsWith('/api/')) return true;
    return path === '/api/health' || path === '/api/session';
  };

  if (password !== null) {
    server.addHook('onRequest', async (request, reply) => {
      if (isOpen(request.url) || signedIn(request)) return;
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

  server.post<{ Body: { password?: unknown } }>(
    '/api/session',
    async (request, reply) => {
      if (password === null) {
        return { required: false, authenticated: true };
      }
      if (!passwordMatches(password, request.body?.password)) {
        return reply.code(401).send({ error: 'That password does not match' });
      }
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
   * The public holidays that apply in the caller's space.
   *
   * Scoped by the space cookie like the settings it reads, so a space per client
   * can keep its own country's calendar — the workday maths in a sheet is only
   * as right as the holidays behind it.
   */
  server.get('/api/holidays', async (request) => {
    const country = store.getSettings(currentUser(request))['holidayCountry'];
    return country === undefined ? holidays.current() : holidays.for(country);
  });

/**
   * A space's settings, plus the tier above it and the two resolved together.
   *
   * `sharedGlobals` and `effectiveGlobals` are derived, not stored here — they
   * are returned so precedence is decided in one place rather than in whichever
   * client happens to be merging. `PUT` refuses them for the same reason.
   */
  const settingsFor = (owner: UserId) => {
    const own = store.getSettings(owner);
    const shared = (store.sharedSettings()['globals'] ?? {}) as Record<string, string>;
    const mine = (own['globals'] ?? {}) as Record<string, string>;
    return {
      ...own,
      sharedGlobals: shared,
      // Most specific wins: a space's own value displaces the shared one of the
      // same name, and a sheet's own declaration displaces both later on.
      effectiveGlobals: { ...shared, ...mine },
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
      if ('region' in changes && readRegion(changes['region']) === INVALID) {
        return reply.code(400).send({ error: 'region must be a name like western-europe' });
      }
      if ('fps' in changes && readFps(changes['fps']) === INVALID) {
        return reply.code(400).send({ error: 'fps must be a positive number' });
      }
      if ('zone' in changes && readZone(changes['zone']) === INVALID) {
        return reply
          .code(400)
          .send({ error: 'zone must be a name like Europe/Berlin' });
      }
      if ('holidayCountry' in changes) {
        const country = normaliseCountry(changes['holidayCountry']);
        if (!country) {
          return reply
            .code(400)
            .send({ error: 'holidayCountry must be a two-letter code like DE' });
        }
        // Stored in the shape the provider and the cache both use, so a space
        // that wrote `de` and one that wrote `DE` share a table rather than
        // fetching the same calendar twice under two keys.
        changes['holidayCountry'] = country;
      }

      const owner = currentUser(request);
      store.saveSettings(owner, changes);
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
  server.put<{ Body: { globals?: unknown } }>(
    '/api/settings/shared',
    async (request, reply) => {
      const globals = request.body?.globals;
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
      store.saveSharedSettings({ globals: cleaned });
      return { globals: cleaned };
    },
  );

  server.get('/api/folders', async (request) => ({
    folders: store.listFolders(currentUser(request)),
  }));

  server.post<{ Body: { name?: string } }>('/api/folders', async (request, reply) => {
    const name = (typeof request.body?.name === 'string' ? request.body.name : '').trim();
    if (!name) return reply.code(400).send({ error: 'name is required' });
    reply.code(201);
    return store.createFolder(currentUser(request), name);
  });

  server.put<{ Params: { id: string }; Body: { name?: string } }>(
    '/api/folders/:id',
    async (request, reply) => {
      const name = (typeof request.body?.name === 'string' ? request.body.name : '').trim();
      if (!name) return reply.code(400).send({ error: 'name is required' });
      if (!store.renameFolder(request.params.id, name, currentUser(request))) {
        return reply.code(404).send({ error: 'Folder not found' });
      }
      return { id: request.params.id, name };
    },
  );

  server.put<{ Params: { id: string }; Body: { color?: unknown } }>(
    '/api/folders/:id/color',
    async (request, reply) => {
      const color = readColor(request.body?.color);
      if (color === INVALID) return reply.code(400).send({ error: 'Unusable colour' });
      if (!store.setFolderColor(request.params.id, color, currentUser(request))) {
        return reply.code(404).send({ error: 'Folder not found' });
      }
      return { id: request.params.id, color };
    },
  );

  server.delete<{ Params: { id: string } }>(
    '/api/folders/:id',
    async (request, reply) => {
      if (!store.deleteFolder(request.params.id, currentUser(request))) {
        return reply.code(404).send({ error: 'Folder not found' });
      }
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
    return { ordered: true };
  });

  server.post<{ Params: { id: string } }>(
    '/api/sheets/:id/restore',
    async (request, reply) => {
      if (!store.restoreSheet(request.params.id, currentUser(request))) {
        return reply.code(404).send({ error: 'Sheet not found' });
      }
      return { restored: true };
    },
  );

  server.delete('/api/trash', async (request) => ({
    purged: store.emptyTrash(currentUser(request)),
  }));

  server.post<{ Body: { title?: string; content?: string; folderId?: string | null } }>(
    '/api/sheets',
    async (request, reply) => {
      // Anything that is not a string is treated as absent rather than
      // crashing the handler — a client sending the wrong type gets a sheet,
      // not a 500.
      const rawTitle = request.body?.title;
      const rawContent = request.body?.content;
      const title = (typeof rawTitle === 'string' ? rawTitle : '').trim() || 'Untitled';
      const sheet = store.createSheet(
        currentUser(request),
        title,
        typeof rawContent === 'string' ? rawContent : '',
        typeof request.body?.folderId === 'string' ? request.body.folderId : null,
      );
      reply.code(201);
      return sheet;
    },
  );

  server.get<{ Params: { id: string } }>(
    '/api/sheets/:id',
    async (request, reply) => {
      const sheet = store.getSheet(request.params.id);
      if (!sheet) return reply.code(404).send({ error: 'Sheet not found' });
      return { ...sheet, lock: store.getLock(sheet.id) };
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
    if (!store.getSheet(request.params.id)) {
      return reply.code(404).send({ error: 'Sheet not found' });
    }
    try {
      const changes: { title?: string; content?: string; folderId?: string | null } = {};
      if (typeof request.body?.title === 'string') changes.title = request.body.title;
      if (typeof request.body?.content === 'string') changes.content = request.body.content;
      if (request.body?.folderId !== undefined) changes.folderId = request.body.folderId;
      return store.updateSheet(request.params.id, changes, request.body?.version);
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
      if (!store.setSheetColor(request.params.id, color)) {
        return reply.code(404).send({ error: 'Sheet not found' });
      }
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
      const removed =
        request.query?.purge === '1'
          ? store.deleteSheet(request.params.id, owner)
          : store.trashSheet(request.params.id, owner);
      if (!removed) return reply.code(404).send({ error: 'Sheet not found' });
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

    const result = store.acquireLock(
      request.params.id,
      clientId,
      request.body?.clientName ?? null,
      lockTtlMs,
      request.body?.force === true,
    );
    return { granted: result.granted, lock: result.lock, ttlMs: lockTtlMs };
  });

  server.delete<{ Params: { id: string }; Querystring: { clientId?: string } }>(
    '/api/sheets/:id/lock',
    async (request, reply) => {
      const clientId = request.query?.clientId;
      if (!clientId) return reply.code(400).send({ error: 'clientId is required' });
      store.releaseLock(request.params.id, clientId);
      return reply.code(204).send();
    },
  );

  if (options.staticRoot && existsSync(options.staticRoot)) {
    void server.register(fastifyStatic, { root: options.staticRoot });
    // Single-page app: unknown non-API paths return the shell, so a deep link
    // or a refresh does not 404.
    server.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  if (options.autoRefreshRates !== false) {
    rates.start();
    holidays.start();
  }

  server.addHook('onClose', async () => {
    rates.stop();
    holidays.stop();
    store.close();
  });

  return { server, store, rates, holidays };
}
