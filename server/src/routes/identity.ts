import type { FastifyInstance, FastifyRequest } from 'fastify';
import { deriveSpaceId, type Space } from '../spaces.js';
import {
  clearedSessionCookie,
  issueToken,
  passwordMatches,
  sessionCookie,
  SignInAttempts,
} from '../session.js';
import type { RouteContext } from './context.js';

/**
 * Who you are and which space you are in: the session, the space list, and the
 * routes that add or remove one.
 *
 * Together because they answer one question between them, and apart from
 * everything else because the shared password is the only credential this app
 * has and it is easier to reason about in one file than spread through
 * thirteen hundred lines.
 *
 * The password machinery arrives as options rather than on the context. No
 * other family needs it, and putting it somewhere everything could reach would
 * make the one security-relevant piece of state ambient.
 */
export function identityRoutes(
  server: FastifyInstance,
  ctx: RouteContext,
  options: {
    password: string | null;
    signedIn(request: FastifyRequest): boolean;
    spaces(): Space[];
    seedWelcome(id: string): void;
  },
): void {
  const { store, currentUser } = ctx;
  const { password, signedIn, spaces, seedWelcome } = options;

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
        return reply
          .code(400)
          .send({ error: `No usable id in ${JSON.stringify(given)}` });
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
}
