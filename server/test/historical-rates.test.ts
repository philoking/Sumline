import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { isUsableDate, type RateFetcher } from '../src/rates.js';

let app: App | null = null;

const CURRENT = { base: 'USD', date: '2026-08-14', rates: { EUR: 0.8 } };
const PAST = { base: 'USD', date: '2019-12-31', rates: { EUR: 0.89 } };

function build(fetcher: RateFetcher): App {
  app = buildApp({
    dbPath: ':memory:',
    staticRoot: null,
    autoRefreshRates: false,
    seedWelcomeSheet: false,
    rateFetcher: fetcher,
    holidayFetcher: async () => [],
  });
  return app;
}

afterEach(async () => {
  await app?.server.close();
  app = null;
});

describe('GET /api/rates', () => {
  it('returns the current table when no date is asked for', async () => {
    const { server } = build(async () => CURRENT);
    const response = await server.inject({ url: '/api/rates' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ date: '2026-08-14' });
  });

  it('fetches a past date and returns the provider’s own date for it', async () => {
    // 1 January is a holiday, so the answer is the last published day before it.
    // Keeping the provider's date rather than the requested one is what lets a
    // sheet show which day a rate actually came from.
    const { server } = build(async (_base, on) => (on ? PAST : CURRENT));
    const response = await server.inject({ url: '/api/rates?on=2020-01-01' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ date: '2019-12-31', rates: { EUR: 0.89 } });
  });

  it('passes the requested date to the fetcher', async () => {
    const fetcher = vi.fn<RateFetcher>(async (_base, on) => (on ? PAST : CURRENT));
    const { server } = build(fetcher);
    await server.inject({ url: '/api/rates?on=2020-01-01' });
    expect(fetcher).toHaveBeenCalledWith('USD', '2020-01-01');
  });

  it('caches a past date, so it is fetched once and then works offline', async () => {
    // A published past rate does not change, so a hit is permanent.
    const fetcher = vi.fn<RateFetcher>(async (_base, on) => (on ? PAST : CURRENT));
    const { server } = build(fetcher);

    await server.inject({ url: '/api/rates?on=2020-01-01' });
    await server.inject({ url: '/api/rates?on=2020-01-01' });

    const historicalCalls = fetcher.mock.calls.filter(([, on]) => on !== undefined);
    expect(historicalCalls).toHaveLength(1);
  });

  it('404s rather than substituting today’s rates when a date cannot be had', async () => {
    // The whole point: converting a 2019 amount at this morning's rate and
    // saying nothing is the failure this feature exists to remove.
    const { server } = build(async (_base, on) => {
      if (on) throw new Error('offline');
      return CURRENT;
    });
    const response = await server.inject({ url: '/api/rates?on=2020-01-01' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toContain('2020-01-01');
  });

  it('404s on a date that is not a date, without asking the provider', async () => {
    const fetcher = vi.fn<RateFetcher>(async () => CURRENT);
    const { server } = build(fetcher);

    for (const on of ['yesterday', '2020-13-01', '2020-02-30', '01-01-2020', '1998-01-01']) {
      const response = await server.inject({ url: `/api/rates?on=${on}` });
      expect(response.statusCode, on).toBe(404);
    }
    expect(fetcher.mock.calls.filter(([, on]) => on !== undefined)).toHaveLength(0);
  });
});

describe('which dates are worth asking about', () => {
  it('accepts real ISO dates from 1999 on', () => {
    expect(isUsableDate('2020-01-01')).toBe(true);
    expect(isUsableDate('1999-01-04')).toBe(true);
    expect(isUsableDate('2020-02-29')).toBe(true);
  });

  it('rejects malformed, impossible, and pre-series dates', () => {
    // The ECB series starts in 1999, so anything earlier is a typo not a query.
    expect(isUsableDate('1998-12-31')).toBe(false);
    expect(isUsableDate('2021-02-30')).toBe(false);
    expect(isUsableDate('2020-13-01')).toBe(false);
    expect(isUsableDate('20-01-01')).toBe(false);
    expect(isUsableDate('today')).toBe(false);
    expect(isUsableDate('')).toBe(false);
  });
});
