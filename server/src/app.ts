import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { Store, USERS, VersionConflictError, toUser, type UserId } from './db.js';
import { RatesService, type RateFetcher } from './rates.js';
import { HolidayService, type HolidayFetcher } from './holidays.js';
import { WELCOME_SHEET } from './welcome.js';

export interface AppOptions {
  dbPath: string;
  /** Absolute path to the built web assets, or null to serve API only. */
  staticRoot?: string | null;
  rateFetcher?: RateFetcher;
  holidayFetcher?: HolidayFetcher;
  /** ISO country code whose public holidays apply to workday maths. */
  holidayCountry?: string;
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

/**
 * Reads the current space from the request.
 *
 * The cookie is set by the client and carries no signature, which is the point
 * — switching space is a preference, not a login, on an app that has no
 * authentication at all. Anything unrecognised falls back to the default user
 * rather than erroring, so a stale or hand-edited cookie cannot lock anyone
 * out of their sheets.
 */
function currentUser(request: FastifyRequest): UserId {
  const header = request.headers.cookie;
  if (!header) return toUser(undefined);
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === USER_COOKIE) return toUser(decodeURIComponent(rest.join('=')));
  }
  return toUser(undefined);
}

export function buildApp(options: AppOptions): App {
  const server = Fastify({ logger: options.logger ?? false });
  const store = new Store(options.dbPath);
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
    for (const user of USERS) {
      if (store.listSheets(user.id).length === 0) {
        store.createSheet(user.id, 'Welcome', WELCOME_SHEET);
      }
    }
  }

  server.get('/api/users', async (request) => ({
    users: USERS.map((user) => ({ ...user })),
    current: currentUser(request),
  }));

  server.get('/api/health', async () => ({
    status: 'ok',
    rateDate: rates.current().date,
  }));

  server.get('/api/rates', async () => rates.current());

  server.get('/api/holidays', async () => holidays.current());

  server.get('/api/settings', async (request) => store.getSettings(currentUser(request)));

  server.put<{ Body: Record<string, unknown> }>(
    '/api/settings',
    async (request) => store.saveSettings(currentUser(request), request.body ?? {}),
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
      return {
        sheets: store.listSheets(currentUser(request), {
          ...(folder !== undefined && { folderId: folder === '' ? null : folder }),
          ...(q !== undefined && { query: q }),
          ...(trash === '1' && { trashed: true }),
        }),
      };
    },
  );

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
