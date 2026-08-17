import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { normaliseCountry, type HolidayFetcher, type HolidayTable } from '../src/holidays.js';

let app: App | null = null;

/** A distinct, recognisable calendar per country. */
const calendars: Record<string, string[]> = {
  US: ['2026-07-03', '2026-11-26'],
  DE: ['2026-10-03'],
  GB: ['2026-08-31', '2026-12-26', '2026-12-28'],
};

function build(fetcher?: HolidayFetcher, country = 'US'): App {
  app = buildApp({
    dbPath: ':memory:',
    staticRoot: null,
    autoRefreshRates: false,
    seedWelcomeSheet: false,
    holidayCountry: country,
    rateFetcher: async () => ({ base: 'USD', date: '2026-08-14', rates: { EUR: 0.8 } }),
    holidayFetcher:
      fetcher ?? (async (code) => calendars[code] ?? Promise.reject(new Error('no such country'))),
  });
  return app;
}

async function addSpace(name: string) {
  await app!.server.inject({ method: 'POST', url: '/api/spaces', payload: { name } });
}

async function setCountry(space: string, holidayCountry: unknown) {
  return app!.server.inject({
    method: 'PUT',
    url: '/api/settings',
    headers: { cookie: `webcalc_user=${space}` },
    payload: { holidayCountry },
  });
}

async function holidaysFor(space?: string): Promise<HolidayTable> {
  const response = await app!.server.inject({
    url: '/api/holidays',
    ...(space && { headers: { cookie: `webcalc_user=${space}` } }),
  });
  return response.json() as HolidayTable;
}

afterEach(async () => {
  await app?.server.close();
  app = null;
});

describe('a space with its own holiday country', () => {
  it('gets that country’s calendar', async () => {
    build();
    await addSpace('Berlin');
    expect((await setCountry('berlin', 'DE')).statusCode).toBe(200);

    const table = await holidaysFor('berlin');
    expect(table.country).toBe('DE');
    expect(table.dates).toContain('2026-10-03');
  });

  it('leaves other spaces on the instance default', async () => {
    // The point of the whole change: one client in another country must not
    // move everyone else's workday maths.
    build();
    // What startup does. Tests disable the timers, and without this the default
    // country is still the bundled seed rather than a fetched calendar.
    await app!.holidays.refresh();
    await addSpace('Berlin');
    await setCountry('berlin', 'DE');

    const mine = await holidaysFor();
    expect(mine.country).toBe('US');
    expect(mine.dates).toContain('2026-07-03');
    expect(mine.dates).not.toContain('2026-10-03');
  });

  it('holds several countries at once', async () => {
    build();
    await addSpace('Berlin');
    await addSpace('London');
    await setCountry('berlin', 'DE');
    await setCountry('london', 'GB');

    expect((await holidaysFor('berlin')).country).toBe('DE');
    expect((await holidaysFor('london')).country).toBe('GB');
    expect((await holidaysFor()).country).toBe('US');
  });

  it('fetches a country once and then serves it from memory', async () => {
    const fetcher = vi.fn<HolidayFetcher>(async (code) => calendars[code] ?? []);
    build(fetcher);
    await addSpace('Berlin');
    await setCountry('berlin', 'DE');

    await holidaysFor('berlin');
    const afterFirst = fetcher.mock.calls.filter(([code]) => code === 'DE').length;
    await holidaysFor('berlin');
    const afterSecond = fetcher.mock.calls.filter(([code]) => code === 'DE').length;

    expect(afterFirst).toBeGreaterThan(0);
    expect(afterSecond).toBe(afterFirst);
  });

  it('stores the code in one shape, so DE and de share a table', async () => {
    const fetcher = vi.fn<HolidayFetcher>(async (code) => calendars[code] ?? []);
    build(fetcher);
    await addSpace('Berlin');
    await addSpace('Bonn');
    await setCountry('berlin', 'de');
    await setCountry('bonn', 'DE');

    await holidaysFor('berlin');
    await holidaysFor('bonn');

    expect(fetcher.mock.calls.filter(([code]) => code === 'DE').length).toBeGreaterThan(0);
    expect(fetcher.mock.calls.filter(([code]) => code === 'de')).toHaveLength(0);
  });

  it('falls back rather than failing when the provider does not cover a code', async () => {
    // A well-formed code the provider has never heard of. Reported as a country
    // with no holidays, which the panel says out loud, rather than a 500.
    build();
    await addSpace('Nowhere');
    await setCountry('nowhere', 'ZZ');

    const table = await holidaysFor('nowhere');
    expect(table.country).toBe('ZZ');
    expect(table.stale).toBe(true);
    expect(Array.isArray(table.dates)).toBe(true);
  });

  it('refuses a code that is not a country code', async () => {
    build();
    for (const value of ['Germany', 'D', 'DEU', 42, '']) {
      const response = await setCountry('me', value);
      expect(response.statusCode, JSON.stringify(value)).toBe(400);
    }
  });
});

describe('normalising a country code', () => {
  it('accepts a two-letter code in any case', () => {
    expect(normaliseCountry('de')).toBe('DE');
    expect(normaliseCountry(' gb ')).toBe('GB');
  });

  it('rejects anything else', () => {
    for (const value of ['Germany', 'D', 'DEU', '', 42, null, undefined, {}]) {
      expect(normaliseCountry(value)).toBeNull();
    }
  });
});
