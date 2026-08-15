import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import type { HolidayTable } from '../src/holidays.js';

let app: App;

function build(overrides: Partial<Parameters<typeof buildApp>[0]> = {}): App {
  return buildApp({
    dbPath: ':memory:',
    staticRoot: null,
    autoRefreshRates: false,
    seedWelcomeSheet: false,
    rateFetcher: async () => ({ base: 'USD', date: '2026-08-14', rates: { EUR: 0.8 } }),
    holidayFetcher: async (_country, year) => [`${year}-12-25`, `${year}-07-04`],
    ...overrides,
  });
}

beforeEach(() => {
  app = build();
});

afterEach(async () => {
  await app.server.close();
});

describe('public holidays', () => {
  it('serves a bundled seed before any fetch has happened', async () => {
    const table = (await app.server.inject({ url: '/api/holidays' })).json() as HolidayTable;
    expect(table.dates.length).toBeGreaterThan(0);
    expect(table.stale).toBe(true);
    // The seed is the handful of fixed-date holidays almost everyone observes.
    expect(table.dates.some((date) => date.endsWith('-12-25'))).toBe(true);
  });

  it('serves fetched holidays once a refresh succeeds', async () => {
    await app.holidays.refresh();
    const table = (await app.server.inject({ url: '/api/holidays' })).json() as HolidayTable;
    expect(table.dates.some((date) => date.endsWith('-07-04'))).toBe(true);
    expect(table.stale).toBeFalsy();
  });

  it('covers this year and next', async () => {
    await app.holidays.refresh();
    const table = app.holidays.current();
    const thisYear = new Date().getFullYear();
    expect(table.years).toEqual([thisYear, thisYear + 1]);
  });

  it('falls back to the cached list when the provider fails', async () => {
    const failing = build({
      holidayFetcher: async () => {
        throw new Error('network down');
      },
    });
    await failing.holidays.refresh();
    const table = failing.holidays.current();
    // A provider outage must never leave workday maths without any holidays.
    expect(table.dates.length).toBeGreaterThan(0);
    expect(table.stale).toBe(true);
    await failing.server.close();
  });

  it('honours the configured country', async () => {
    const seen: string[] = [];
    const other = build({
      holidayCountry: 'GB',
      holidayFetcher: async (country) => {
        seen.push(country);
        return ['2026-12-26'];
      },
    });
    await other.holidays.refresh();
    expect(seen).toContain('GB');
    expect(other.holidays.current().country).toBe('GB');
    await other.server.close();
  });
});
