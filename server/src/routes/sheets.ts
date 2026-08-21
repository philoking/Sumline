import type { FastifyInstance } from 'fastify';
import type { Lock } from '../db.js';
import { VersionConflictError } from '../db.js';
import { INVALID, readColor } from './shapes.js';
import type { RouteContext } from './context.js';

/**
 * Sheets, the trash, share links and the editing lock: twelve routes, and by
 * some distance the largest family.
 *
 * The lock lives here rather than in a module of its own. It is not a resource
 * anybody addresses on its own — every one of its routes hangs off a sheet id,
 * and `lockNow` is called from the sheet reads as well as the lock writes, so
 * separating them would put one concern in two files and gain nothing.
 */
export function sheetRoutes(
  server: FastifyInstance,
  ctx: RouteContext,
  options: { lockTtlMs: number },
): void {
  const { store, events, currentUser, listChanged } = ctx;
  const { lockTtlMs } = options;

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

  server.get<{ Params: { id: string } }>('/api/sheets/:id', async (request, reply) => {
    const sheet = store.getSheet(request.params.id);
    if (!sheet) return reply.code(404).send({ error: 'Sheet not found' });
    return { ...sheet, lock: lockNow(sheet.id) };
  });

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
      if (typeof request.body?.content === 'string')
        changes.content = request.body.content;
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
}
