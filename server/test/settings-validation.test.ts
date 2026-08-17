import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';

let app: App;

beforeEach(() => {
  app = buildApp({
    dbPath: ':memory:',
    staticRoot: null,
    autoRefreshRates: false,
    seedWelcomeSheet: false,
    rateFetcher: async () => ({ base: 'USD', date: '2026-08-14', rates: { EUR: 0.8 } }),
    holidayFetcher: async () => [],
  });
});

afterEach(async () => {
  await app.server.close();
});

async function put(payload: Record<string, unknown>) {
  return app.server.inject({ method: 'PUT', url: '/api/settings', payload });
}

async function settings() {
  const response = await app.server.inject({ url: '/api/settings' });
  return response.json() as Record<string, unknown>;
}

describe('the region setting', () => {
  it('is stored and read back', async () => {
    expect((await put({ region: 'western-europe' })).statusCode).toBe(200);
    expect(await settings()).toMatchObject({ region: 'western-europe' });
  });

  it('is per space, because it changes what a sheet computes', async () => {
    await app.server.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { name: 'Berlin' },
    });
    await app.server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: 'webcalc_user=berlin' },
      payload: { region: 'western-europe' },
    });

    const berlin = await app.server.inject({
      url: '/api/settings',
      headers: { cookie: 'webcalc_user=berlin' },
    });
    expect(berlin.json()).toMatchObject({ region: 'western-europe' });
    // The first space is untouched: one space reading 1.234 as a thousand must
    // not decide it for the others.
    expect(await settings()).not.toHaveProperty('region');
  });

  it('refuses a value that is not a region name', async () => {
    for (const region of [42, null, '', 'Western Europe', 'a'.repeat(40), '../etc']) {
      const response = await put({ region });
      expect(response.statusCode, JSON.stringify(region)).toBe(400);
    }
  });

  it('accepts a well-formed name it does not recognise', async () => {
    // Shape, not membership: the list lives in the engine, which this server
    // does not depend on at runtime. An unknown name is harmless because the
    // engine coerces anything it does not know back to its default.
    expect((await put({ region: 'south-asia' })).statusCode).toBe(200);
  });

  it('leaves other settings alone when one is refused', async () => {
    await put({ statistic: 'median' });
    expect((await put({ region: 42 })).statusCode).toBe(400);
    expect(await settings()).toMatchObject({ statistic: 'median' });
  });
});

describe('the default frame rate', () => {
  it('is stored and read back', async () => {
    expect((await put({ fps: 30 })).statusCode).toBe(200);
    expect(await settings()).toMatchObject({ fps: 30 });
  });

  it('refuses a rate nothing could divide by', async () => {
    for (const fps of [0, -5, 'thirty', null, 5000]) {
      const response = await put({ fps });
      expect(response.statusCode, JSON.stringify(fps)).toBe(400);
    }
  });

  it('accepts a fractional rate, since 23.976 is a real one', async () => {
    expect((await put({ fps: 23.976 })).statusCode).toBe(200);
  });
});

describe('settings that only affect display', () => {
  it('are still free-form, as they have always been', async () => {
    // Only the two settings that change what a sheet computes are checked. A
    // nonsense display preference costs a wrong-looking toggle, not a sheet
    // full of missing answers.
    const response = await put({ statistic: 'whatever', showTotal: 'maybe' });
    expect(response.statusCode).toBe(200);
  });
});
