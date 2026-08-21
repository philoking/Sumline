import type { FastifyInstance } from 'fastify';
import { INVALID, readColor } from './shapes.js';
import type { RouteContext } from './context.js';

/**
 * Folders: the five routes that make one, name it, colour it and remove it.
 *
 * The first family lifted out of `app.ts`, and the smallest, which is why it
 * went first: it establishes the shape the rest follow. What it needs from the
 * app is three things and they arrive as an argument, so this file cannot
 * quietly reach for a fourth.
 */
export function folderRoutes(server: FastifyInstance, ctx: RouteContext): void {
  const { store, currentUser, listChanged } = ctx;

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
      const name = (
        typeof request.body?.name === 'string' ? request.body.name : ''
      ).trim();
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
}
