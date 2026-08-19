import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngine } from '@webcalc/engine';
import { buildApp, type App } from '../src/app.js';
import type { RateFetcher } from '../src/rates.js';

/**
 * That `/api/evaluate` stops rebuilding the evaluator on every request.
 *
 * Counting `createEngine` calls is the only way to see this from outside: two
 * identical requests answer identically whether or not an instance was thrown
 * away between them. The assertion that matters is the second kind — a cache
 * that never invalidated would answer yesterday's rates forever — so every
 * input that decides the answer gets a test that moving it builds again.
 */
vi.mock('@webcalc/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@webcalc/engine')>();
  return { ...actual, createEngine: vi.fn(actual.createEngine) };
});

const built = createEngine as unknown as ReturnType<typeof vi.fn>;

const TODAY = { base: 'USD', date: '2026-08-14', rates: { EUR: 0.8 } };
const TOMORROW = { base: 'USD', date: '2026-08-15', rates: { EUR: 0.5 } };
const PAST = { base: 'USD', date: '2019-12-31', rates: { EUR: 0.89 } };

let app: App;
let latest = TODAY;

const fetcher: RateFetcher = async (_base, onDate) => (onDate ? PAST : latest);

beforeEach(() => {
  latest = TODAY;
  built.mockClear();
  app = buildApp({
    dbPath: ':memory:',
    staticRoot: null,
    autoRefreshRates: false,
    seedWelcomeSheet: false,
    rateFetcher: fetcher,
    holidayFetcher: async () => [],
    spaces: [
      { id: 'ada', name: 'Ada' },
      { id: 'grace', name: 'Grace' },
    ],
  });
});

afterEach(async () => {
  await app.server.close();
});

const evaluate = (input: string, owner = 'ada') =>
  app.server.inject({
    method: 'POST',
    url: '/api/evaluate',
    headers: { cookie: `webcalc_user=${owner}` },
    payload: { input },
  });

describe('the evaluator between requests', () => {
  it('builds one for two identical requests', async () => {
    expect((await evaluate('2 + 2')).statusCode).toBe(200);
    expect(built).toHaveBeenCalledTimes(1);

    expect((await evaluate('3 + 3')).statusCode).toBe(200);
    // Different input, same everything that decides how it is answered.
    expect(built).toHaveBeenCalledTimes(1);
  });

  it('builds another when the rate table moves', async () => {
    await evaluate('100 USD in EUR');
    expect(built).toHaveBeenCalledTimes(1);

    latest = TOMORROW;
    await app.rates.refresh();

    const response = await evaluate('100 USD in EUR');
    expect(built).toHaveBeenCalledTimes(2);
    // The point of invalidating rather than the count: yesterday's rates would
    // otherwise be answered forever.
    expect(response.json().rateDate).toBe('2026-08-15');
    expect(response.json().results[0].output).toBe('€50.00');
  });

  it('builds another for a space whose settings resolve differently', async () => {
    await evaluate('1,234.5', 'ada');
    expect(built).toHaveBeenCalledTimes(1);

    await app.server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: 'webcalc_user=grace' },
      payload: { region: 'western-europe' },
    });

    await evaluate('1,234.5', 'grace');
    expect(built).toHaveBeenCalledTimes(2);

    // And back to the first space without rebuilding, which is what more than
    // one entry is for.
    await evaluate('9 + 9', 'ada');
    expect(built).toHaveBeenCalledTimes(2);
  });
});

describe('the second pass, for a sheet naming a past date', () => {
  it('builds one engine for the dates and reuses it next time', async () => {
    const line = '100 USD in EUR on 2020-01-01';

    await evaluate(line);
    // One for the pass that reports which dates are wanted, one that answers
    // with them in hand.
    expect(built).toHaveBeenCalledTimes(2);

    const again = await evaluate(line);
    expect(built).toHaveBeenCalledTimes(2);
    expect(again.json().results[0].output).toBe('€89.00');
  });

  it('builds another for a different set of dates', async () => {
    await evaluate('100 USD in EUR on 2020-01-01');
    expect(built).toHaveBeenCalledTimes(2);

    // The first pass is a hit — same space, same tables — and only the engine
    // carrying the past rates is new.
    await evaluate('100 USD in EUR on 2020-01-02');
    expect(built).toHaveBeenCalledTimes(3);
  });
});
