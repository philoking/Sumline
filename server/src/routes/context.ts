import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store, UserId } from '../db.js';
import type { Events } from '../events.js';

/**
 * What a route family needs from the app around it.
 *
 * Passed rather than closed over, which is the whole point of the split: a
 * module can only reach what is on this object, so what a family of routes
 * depends on is a declaration instead of whatever happened to be in scope in a
 * 1,300-line file.
 *
 * Deliberately small. Anything that turns out to be needed by one family alone
 * belongs in that module, and anything needed by all of them is already here.
 */
export interface RouteContext {
  store: Store;
  events: Events;
  /** Which space this request is working in, from its cookie. */
  currentUser(request: FastifyRequest): UserId;
  /** Announces that a space's sheet list has changed, so every tab refetches. */
  listChanged(owner: UserId): void;
  /**
   * A space's settings with both tiers resolved.
   *
   * Here rather than in the settings module because `/api/evaluate` reads the
   * same view: a line has to mean the same thing to the API as it does to a
   * sheet, and it only can if both go through one function.
   */
  settingsFor(owner: UserId): Record<string, unknown>;
}

/** A family of routes, registered against the server with its context. */
export type Routes = (server: FastifyInstance, context: RouteContext) => void;
