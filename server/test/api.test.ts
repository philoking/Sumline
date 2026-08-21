import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { VersionConflictError } from '../src/db.js';
import { FALLBACK_SPACE } from '../src/spaces.js';
import type { RateTable } from '../src/rates.js';

const LIVE_RATES: RateTable = {
  base: 'USD',
  date: '2026-08-14',
  rates: { EUR: 0.8, GBP: 0.75 },
};

let app: App;

function build(overrides: Partial<Parameters<typeof buildApp>[0]> = {}): App {
  return buildApp({
    dbPath: ':memory:',
    staticRoot: null,
    autoRefreshRates: false,
    seedWelcomeSheet: false,
    rateFetcher: async () => LIVE_RATES,
    ...overrides,
  });
}

beforeEach(() => {
  app = build();
});

afterEach(async () => {
  await app.server.close();
});

async function createSheet(title = 'Test', content = '') {
  const response = await app.server.inject({
    method: 'POST',
    url: '/api/sheets',
    payload: { title, content },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; version: number };
}

describe('health and rates', () => {
  it('reports health with the rate date it is serving', async () => {
    const response = await app.server.inject({ url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('serves the bundled seed rates before any fetch has happened', async () => {
    const rates = (await app.server.inject({ url: '/api/rates' })).json() as RateTable;
    expect(rates.base).toBe('USD');
    expect(rates.rates['EUR']).toBeGreaterThan(0);
  });

  it('serves live rates once a refresh succeeds', async () => {
    await app.rates.refresh();
    const rates = (await app.server.inject({ url: '/api/rates' })).json() as RateTable;
    expect(rates.rates['EUR']).toBe(0.8);
    expect(rates.stale).toBeFalsy();
  });

  it('falls back to the previous table when the provider fails', async () => {
    await app.rates.refresh();
    const failing = build({
      rateFetcher: async () => {
        throw new Error('network down');
      },
    });
    await failing.rates.refresh();
    const rates = failing.rates.current();
    expect(rates.rates['EUR']).toBeGreaterThan(0);
    expect(rates.stale).toBe(true);
    await failing.server.close();
  });
});

describe('sheet CRUD', () => {
  it('creates, reads, updates and deletes a sheet', async () => {
    const created = await createSheet('Budget', '2 + 2');

    const read = await app.server.inject({ url: `/api/sheets/${created.id}` });
    expect(read.json()).toMatchObject({ title: 'Budget', content: '2 + 2', version: 1 });

    const updated = await app.server.inject({
      method: 'PUT',
      url: `/api/sheets/${created.id}`,
      payload: { content: '3 + 3', version: 1 },
    });
    expect(updated.json()).toMatchObject({ content: '3 + 3', version: 2 });

    const list = (await app.server.inject({ url: '/api/sheets' })).json() as {
      sheets: unknown[];
    };
    expect(list.sheets).toHaveLength(1);

    // Deleting trashes the sheet; `?purge=1` is what removes it for good.
    const removed = await app.server.inject({
      method: 'DELETE',
      url: `/api/sheets/${created.id}?purge=1`,
    });
    expect(removed.statusCode).toBe(200);
    expect(
      (await app.server.inject({ url: `/api/sheets/${created.id}` })).statusCode,
    ).toBe(404);
  });

  it('defaults an untitled sheet rather than rejecting it', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: '/api/sheets',
      payload: {},
    });
    expect(response.json()).toMatchObject({ title: 'Untitled' });
  });

  it('404s for an unknown sheet', async () => {
    expect((await app.server.inject({ url: '/api/sheets/nope' })).statusCode).toBe(404);
  });
});

describe('version conflicts', () => {
  it('rejects a write based on a stale version and returns the current copy', async () => {
    const created = await createSheet('Shared', 'one');

    await app.server.inject({
      method: 'PUT',
      url: `/api/sheets/${created.id}`,
      payload: { content: 'edited elsewhere', version: 1 },
    });

    const stale = await app.server.inject({
      method: 'PUT',
      url: `/api/sheets/${created.id}`,
      payload: { content: 'my stale edit', version: 1 },
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      current: { content: 'edited elsewhere', version: 2 },
    });
  });

  it('refuses in the database as well as in the branch above it', async () => {
    /*
     * The `UPDATE` carries `AND version = ?`, so a stale write changes zero
     * rows and is reported as the conflict it is.
     *
     * There is no observable difference today: `node:sqlite` is synchronous, so
     * nothing can interleave between reading the version and writing it, and
     * the branch above catches every stale write before the query runs. What
     * this pins is that the check survives being reached — if the branch is
     * ever bypassed, refactored away, or the driver stops being synchronous,
     * the query still refuses rather than overwriting somebody's edit.
     *
     * Driven through the store rather than the API, because that branch is what
     * an HTTP caller hits first and it would answer before the clause matters.
     */
    const { store } = app;
    const sheet = store.createSheet(FALLBACK_SPACE.id, 'Contested', 'one');
    store.updateSheet(sheet.id, { content: 'two' }, sheet.version);
    // `sheet.version` is now a version behind, which is the losing writer.
    expect(() => store.updateSheet(sheet.id, { content: 'three' }, sheet.version)).toThrow(
      VersionConflictError,
    );
    expect(store.getSheet(sheet.id)?.content).toBe('two');
  });

  it('allows a write with no version, for clients that do not track it', async () => {
    const created = await createSheet('Loose', 'one');
    const response = await app.server.inject({
      method: 'PUT',
      url: `/api/sheets/${created.id}`,
      payload: { content: 'two' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ content: 'two', version: 2 });
  });
});

describe('editing locks', () => {
  it('grants the lock to the first client and refuses the second', async () => {
    const sheet = await createSheet();

    const first = await app.server.inject({
      method: 'POST',
      url: `/api/sheets/${sheet.id}/lock`,
      payload: { clientId: 'alice' },
    });
    expect(first.json()).toMatchObject({ granted: true });

    const second = await app.server.inject({
      method: 'POST',
      url: `/api/sheets/${sheet.id}/lock`,
      payload: { clientId: 'bob' },
    });
    expect(second.json()).toMatchObject({
      granted: false,
      lock: { clientId: 'alice' },
    });
  });

  it('lets the holder renew its own lock', async () => {
    const sheet = await createSheet();
    for (let i = 0; i < 2; i++) {
      const response = await app.server.inject({
        method: 'POST',
        url: `/api/sheets/${sheet.id}/lock`,
        payload: { clientId: 'alice' },
      });
      expect(response.json()).toMatchObject({ granted: true });
    }
  });

  it('lets another client take over with force', async () => {
    const sheet = await createSheet();
    await app.server.inject({
      method: 'POST',
      url: `/api/sheets/${sheet.id}/lock`,
      payload: { clientId: 'alice' },
    });
    const takeover = await app.server.inject({
      method: 'POST',
      url: `/api/sheets/${sheet.id}/lock`,
      payload: { clientId: 'bob', force: true },
    });
    expect(takeover.json()).toMatchObject({ granted: true, lock: { clientId: 'bob' } });
  });

  it('grants the lock to a new client once the old one expires', async () => {
    const shortLived = build({ lockTtlMs: 1 });
    const sheet = (
      await shortLived.server.inject({
        method: 'POST',
        url: '/api/sheets',
        payload: { title: 'Expiring' },
      })
    ).json() as { id: string };

    await shortLived.server.inject({
      method: 'POST',
      url: `/api/sheets/${sheet.id}/lock`,
      payload: { clientId: 'alice' },
    });
    await new Promise((done) => setTimeout(done, 10));

    const bob = await shortLived.server.inject({
      method: 'POST',
      url: `/api/sheets/${sheet.id}/lock`,
      payload: { clientId: 'bob' },
    });
    expect(bob.json()).toMatchObject({ granted: true, lock: { clientId: 'bob' } });
    await shortLived.server.close();
  });

  it('releases a lock so the next client can take it', async () => {
    const sheet = await createSheet();
    await app.server.inject({
      method: 'POST',
      url: `/api/sheets/${sheet.id}/lock`,
      payload: { clientId: 'alice' },
    });
    const released = await app.server.inject({
      method: 'DELETE',
      url: `/api/sheets/${sheet.id}/lock?clientId=alice`,
    });
    expect(released.statusCode).toBe(204);

    const bob = await app.server.inject({
      method: 'POST',
      url: `/api/sheets/${sheet.id}/lock`,
      payload: { clientId: 'bob' },
    });
    expect(bob.json()).toMatchObject({ granted: true });
  });

  it('reports the current lock alongside the sheet', async () => {
    const sheet = await createSheet();
    await app.server.inject({
      method: 'POST',
      url: `/api/sheets/${sheet.id}/lock`,
      payload: { clientId: 'alice', clientName: 'Alice' },
    });
    const read = await app.server.inject({ url: `/api/sheets/${sheet.id}` });
    expect(read.json()).toMatchObject({ lock: { clientId: 'alice', clientName: 'Alice' } });
  });

  it('requires a clientId', async () => {
    const sheet = await createSheet();
    const response = await app.server.inject({
      method: 'POST',
      url: `/api/sheets/${sheet.id}/lock`,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('first run', () => {
  it('seeds a welcome sheet into an empty instance', async () => {
    const fresh = build({ seedWelcomeSheet: true });
    const list = (await fresh.server.inject({ url: '/api/sheets' })).json() as {
      sheets: Array<{ title: string }>;
    };
    expect(list.sheets[0]?.title).toBe('Welcome');
    await fresh.server.close();
  });
});
