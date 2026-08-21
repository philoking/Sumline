import type { FastifyInstance } from 'fastify';
import { createEngine, engineOptionsFrom, type EngineSettings } from '@sumline/engine';
import type { RatesService } from '../rates.js';
import type { HolidayService } from '../holidays.js';
import { frame } from '../events.js';
import type { RouteContext } from './context.js';

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

/**
 * The endpoints that are about the instance rather than about a resource.
 *
 * Health, the event stream, the rate and holiday tables, and evaluation. They
 * are grouped by what they are not: none of them is a family of CRUD routes,
 * none has an id, and each reads something the app owns rather than the store.
 *
 * `/api/evaluate` belongs here for a reason worth stating. It looks like a
 * pure function and is not: it answers *in a space*, resolving the caller's
 * globals, region and zone, so that `day rate * 3` means the same thing in a
 * launcher as it does in a sheet. That is why it takes `settingsFor` and why
 * it could never live in the engine.
 */
export function instanceRoutes(
  server: FastifyInstance,
  ctx: RouteContext,
  options: {
    rates: RatesService;
    holidays: HolidayService;
    /** How often an idle stream sends a beat. Tests turn this down. */
    heartbeatMs?: number;
  },
): void {
  const { events, currentUser, settingsFor } = ctx;
  const { rates, holidays } = options;
  const heartbeat = options.heartbeatMs ?? EVENT_HEARTBEAT_MS;

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

    const beat = setInterval(() => write(frame({ type: 'beat' })), heartbeat);
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

  /**
   * The current rates, or `?on=YYYY-MM-DD` for a past date.
   *
   * 404 rather than today's table when a past date cannot be answered: the
   * client turns that into "no rates for that date" on the line, where silently
   * substituting the current rate would be the wrong answer wearing the right
   * clothes.
   */
  server.get<{ Querystring: { on?: string } }>('/api/rates', async (request, reply) => {
    const on = request.query?.on;
    if (on === undefined) return rates.current();

    const table = await rates.historical(on);
    if (!table) {
      return reply.code(404).send({ error: `No exchange rates available for ${on}` });
    }
    return table;
  });

  /**
   * The public holidays behind workday maths.
   *
   * One table for the whole instance, from `HOLIDAY_COUNTRY`: unlike the region
   * and the zone, a space cannot pin its own country. Which is why this takes
   * no request — there is nothing about the caller that would change the answer.
   */
  server.get('/api/holidays', async () => holidays.current());

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
    const source = Array.isArray(input)
      ? input
      : typeof input === 'string'
        ? input
        : null;
    if (source === null) {
      return reply
        .code(400)
        .send({ error: 'input must be a string or an array of lines' });
    }

    const lines = Array.isArray(source) ? source : source.split('\n');
    if (lines.some((line) => typeof line !== 'string')) {
      return reply
        .code(400)
        .send({ error: 'input must be a string or an array of lines' });
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
      const past = fetched
        .map(([date, table]) => `${date}>${table?.date ?? '-'}`)
        .join(',');
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
}
