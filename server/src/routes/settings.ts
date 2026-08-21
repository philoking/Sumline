import type { FastifyInstance } from 'fastify';
import type { Store, UserId } from '../db.js';
import { INVALID, readRegion, readZone } from './shapes.js';
import type { RouteContext } from './context.js';

/**
 * The settings that change what a sheet computes, rather than how it looks.
 *
 * These are the ones with two tiers — an instance-wide value every space
 * inherits, and a per-space override — because each is usually true of the whole
 * instance and occasionally true of one space alone. Display preferences stay
 * per space and free-form; a wrong one costs an odd-looking toggle.
 */
export const COMPUTED_SETTINGS = ['region', 'zone'] as const;

/**
 * Every setting a space may store, and the whole of it.
 *
 * This used to accept whatever it was given. Two thousand invented keys went in
 * and came back out in review, which is unbounded growth in one row and a
 * settings shape no longer knowable from the code: every reader had to cope
 * with names nobody had defined.
 *
 * The free-form store was deliberate once, on the argument that display
 * preferences are harmless and a nonsense value costs a wrong-looking toggle
 * rather than a wrong answer. That still holds for the *values*, which is why
 * only `region` and `zone` are validated below. It does not hold for the
 * *names*: an open key space is a write amplifier for anyone who can reach the
 * port, and nothing in the app ever wanted it.
 *
 * Kept beside the type it mirrors. `Settings` in `web/src/api.ts` is the same
 * list, and `EngineSettings` declares the six the engine reads.
 */
const STORABLE_SETTINGS = new Set([
  // Change what a sheet computes.
  'region',
  'zone',
  'precision',
  'largeNumberNotation',
  'thousandsSeparators',
  'currencyRounding',
  'globals',
  // Change only how it looks, or how the app behaves around it.
  'statistic',
  'sheetOrder',
  'showTotal',
  'countVariablesInTotal',
  'countReferencedInTotal',
  'sheetFontSize',
  'showLineNumbers',
]);

/**
 * Keys `GET` adds and `PUT` must not store.
 *
 * Sending a GET response straight back is an ordinary thing for a client to do,
 * so these are dropped rather than refused. Storing them would promote every
 * inherited value into one of the space's own, and a later change to the shared
 * tier would then stop reaching it.
 */
const DERIVED_SETTINGS = new Set([
  'sharedGlobals',
  'effectiveGlobals',
  'shared',
  'effective',
]);

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
 * The three settings endpoints, and the two tiers behind them.
 *
 * `settingsFor` is not here: `/api/evaluate` needs the same resolved view, so
 * it is built once by the app and reaches both through the context. Everything
 * that is only about *writing* settings is here, including the allow-list that
 * stopped this endpoint storing whatever it was handed.
 */
/**
 * A space's settings, plus the tier above it and the two resolved together.
 *
 * A factory rather than a route helper, because `/api/evaluate` needs exactly
 * this view too: `day rate * 3` has to mean the same thing to the API as it
 * does to a sheet, and it only can if both read one function. The app builds it
 * once and hands it to both through the context.
 */
export function makeSettingsFor(store: Store) {
  return (owner: UserId) => {
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
}

export function settingsRoutes(server: FastifyInstance, ctx: RouteContext): void {
  const { store, events, currentUser, settingsFor } = ctx;

  server.get('/api/settings', async (request) => settingsFor(currentUser(request)));

  server.put<{ Body: Record<string, unknown> }>(
    '/api/settings',
    async (request, reply) => {
      const changes: Record<string, unknown> = {};
      const unknown: string[] = [];
      for (const [key, value] of Object.entries(request.body ?? {})) {
        // Derived keys are dropped in silence; see DERIVED_SETTINGS.
        if (DERIVED_SETTINGS.has(key)) continue;
        if (!STORABLE_SETTINGS.has(key)) {
          unknown.push(key);
          continue;
        }
        changes[key] = value;
      }
      // Refused rather than ignored, and named. A key nobody defined is a bug
      // in whatever sent it, and silently dropping it would leave that bug
      // looking like a setting that will not stick.
      if (unknown.length > 0) {
        return reply.code(400).send({
          error: `Not a setting: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? `, and ${unknown.length - 5} more` : ''}`,
        });
      }

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
        return reply
          .code(400)
          .send({ error: 'globals must be an object of names to values' });
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
}
