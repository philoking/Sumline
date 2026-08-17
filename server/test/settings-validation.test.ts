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
    for (const region of [42, '', 'Western Europe', 'a'.repeat(40), '../etc']) {
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

describe('the timezone setting', () => {
  it('is stored and read back', async () => {
    expect((await put({ zone: 'Europe/Berlin' })).statusCode).toBe(200);
    expect(await settings()).toMatchObject({ zone: 'Europe/Berlin' });
  });

  it('accepts a place name as well as an identifier', async () => {
    expect((await put({ zone: 'Berlin' })).statusCode).toBe(200);
  });

  it('accepts a name it does not recognise, for the engine to fall back on', async () => {
    // Shape, not membership, for the same reason as the region: the zone table
    // lives in the engine, which this server cannot import at runtime.
    expect((await put({ zone: 'Middle/Earth' })).statusCode).toBe(200);
  });

  it('refuses a value that is not a zone name at all', async () => {
    for (const zone of [42, '', '  ', 'x'.repeat(80), 'drop; table']) {
      const response = await put({ zone });
      expect(response.statusCode, JSON.stringify(zone)).toBe(400);
    }
  });
});

describe('the default frame rate', () => {
  it('is stored and read back', async () => {
    expect((await put({ fps: 30 })).statusCode).toBe(200);
    expect(await settings()).toMatchObject({ fps: 30 });
  });

  it('refuses a rate nothing could divide by', async () => {
    for (const fps of [0, -5, 'thirty', 5000]) {
      const response = await put({ fps });
      expect(response.statusCode, JSON.stringify(fps)).toBe(400);
    }
  });

  it('accepts a fractional rate, since 23.976 is a real one', async () => {
    expect((await put({ fps: 23.976 })).statusCode).toBe(200);
  });
});

describe('clearing an override', () => {
  it('removes the key so the tier above shows through again', async () => {
    // null is not a value of "no region" — it is the absence of an override,
    // which is what lets a space go back to following Everywhere.
    await put({ region: 'western-europe' });
    expect(await settings()).toMatchObject({ region: 'western-europe' });

    expect((await put({ region: null })).statusCode).toBe(200);
    expect(await settings()).not.toHaveProperty('region');
  });

  it('accepts null for every computed setting', async () => {
    for (const key of ['region', 'fps', 'zone', 'holidayCountry']) {
      const response = await put({ [key]: null });
      expect(response.statusCode, key).toBe(200);
    }
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

describe('the Everywhere tier', () => {
  async function putShared(payload: Record<string, unknown>) {
    return app.server.inject({
      method: 'PUT',
      url: '/api/settings/shared',
      payload,
    });
  }

  it('is inherited by a space that has not overridden it', async () => {
    // The point of the two tiers: set the region once for the instance rather
    // than once per space.
    expect((await putShared({ region: 'western-europe' })).statusCode).toBe(200);

    const mine = await settings();
    expect(mine.shared).toMatchObject({ region: 'western-europe' });
    expect(mine.effective).toMatchObject({ region: 'western-europe' });
    // Inherited, not adopted: the space still holds no region of its own, so a
    // later change to Everywhere keeps reaching it.
    expect(mine).not.toHaveProperty('region');
  });

  it('is displaced by a space’s own value, leaving other spaces alone', async () => {
    await putShared({ region: 'western-europe' });
    await app.server.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { name: 'Boston' },
    });
    await app.server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: 'webcalc_user=boston' },
      payload: { region: 'north-america' },
    });

    const boston = await app.server.inject({
      url: '/api/settings',
      headers: { cookie: 'webcalc_user=boston' },
    });
    expect(boston.json().effective).toMatchObject({ region: 'north-america' });
    // Everywhere is untouched, and every other space still follows it.
    expect((await settings()).effective).toMatchObject({ region: 'western-europe' });
  });

  it('shows through again once the override is cleared', async () => {
    await putShared({ region: 'western-europe' });
    await put({ region: 'north-america' });
    expect((await settings()).effective).toMatchObject({ region: 'north-america' });

    await put({ region: null });
    expect((await settings()).effective).toMatchObject({ region: 'western-europe' });
  });

  it('can be set without resending the shared variables', async () => {
    await putShared({ globals: { vat: '20%' } });
    expect((await putShared({ zone: 'Europe/Berlin' })).statusCode).toBe(200);
    // Setting a region instance-wide must not wipe the instance-wide globals.
    expect((await settings()).sharedGlobals).toEqual({ vat: '20%' });
  });

  it('refuses instance-wide what it would refuse per space', async () => {
    expect((await putShared({ region: 42 })).statusCode).toBe(400);
    expect((await putShared({ fps: 0 })).statusCode).toBe(400);
  });
});
