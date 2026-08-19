import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import type { Store } from '../src/db.js';

/**
 * Writes that are one write, held to it.
 *
 * Several store methods issue a statement per item — one UPDATE per sheet for
 * a reorder, one per key for a settings write. Without a transaction each of
 * those autocommits on its own, so a throw part way through leaves the request
 * half applied: a sidebar in an order that is neither the old one nor the one
 * asked for, or a settings panel showing some of what was submitted.
 *
 * Reaching the database directly is deliberate here. The failures being pinned
 * are the ones the API cannot produce on demand — a statement that throws — and
 * a rollback is only observable in the rows themselves.
 */

let app: App;

beforeEach(() => {
  app = buildApp({
    dbPath: ':memory:',
    staticRoot: null,
    autoRefreshRates: false,
    seedWelcomeSheet: false,
    spaces: [{ id: 'ada', name: 'Ada' }],
  });
});

afterEach(async () => {
  await app.server.close();
});

interface Statement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}

interface Handle {
  prepare(sql: string): Statement;
}

/** The store's own database, for asserting on rows the API does not return. */
const handle = (store: Store): Handle => (store as unknown as { db: Handle }).db;

async function create(title: string): Promise<string> {
  const response = await app.server.inject({
    method: 'POST',
    url: '/api/sheets',
    headers: { cookie: 'webcalc_user=ada' },
    payload: { title, content: '' },
  });
  return (response.json() as { id: string }).id;
}

const positions = (): Array<number | null> =>
  (
    handle(app.store)
      .prepare('SELECT position FROM sheets WHERE owner = ? ORDER BY rowid')
      .all('ada') as Array<{ position: number | null }>
  ).map((row) => row.position);

describe('a reorder that fails part way', () => {
  it('leaves every position as it was, seeding included', async () => {
    const ids = [await create('One'), await create('Two'), await create('Three')];
    expect(positions()).toEqual([null, null, null]);

    // Two statements set a position: the one `seedSheetOrder` uses to number
    // the space, and the one the move itself uses. Failing the second means
    // the seeding really did happen, so this tests the rollback rather than
    // the guard that runs before any of it.
    const db = handle(app.store);
    const real = db.prepare.bind(db);
    let seen = 0;
    db.prepare = (sql: string) => {
      if (sql.includes('SET position') && (seen += 1) === 2) {
        throw new Error('database or disk is full');
      }
      return real(sql);
    };

    expect(() => app.store.reorderSheets('ada', [ids[2]!, ids[0]!, ids[1]!])).toThrow(
      'database or disk is full',
    );

    db.prepare = real;
    // Not "the order is unchanged" but "the arrangement never began". A seed
    // that survived would leave every sheet holding a position, in the order
    // it already had, with the list now claiming to be arranged by hand.
    expect(positions()).toEqual([null, null, null]);
  });

  it('still commits the reorder when nothing throws', async () => {
    const ids = [await create('One'), await create('Two'), await create('Three')];
    expect(app.store.reorderSheets('ada', [ids[2]!, ids[0]!, ids[1]!])).toBe(true);
    expect(positions()).not.toEqual([null, null, null]);
  });
});

describe('a settings write that fails part way', () => {
  // A BigInt is the cheapest value `JSON.stringify` refuses, and it throws on
  // the key rather than on the connection — which is the shape of the real
  // case: some keys written, then a value the write cannot express.
  const unwritable = { region: 'uk', broken: 10n } as Record<string, unknown>;

  it('writes none of a space’s keys when one of them cannot be stored', () => {
    expect(() => app.store.saveSettings('ada', unwritable)).toThrow();
    // `region` comes before `broken`, so without a transaction it would be the
    // one key of the two that landed.
    expect(app.store.getSettings('ada')).not.toHaveProperty('region');
  });

  it('writes none of the instance’s keys either', () => {
    expect(() => app.store.saveSharedSettings(unwritable)).toThrow();
    expect(app.store.sharedSettings()).not.toHaveProperty('region');
  });

  it('leaves an earlier good write standing', () => {
    app.store.saveSettings('ada', { region: 'eu' });
    expect(() => app.store.saveSettings('ada', unwritable)).toThrow();
    // The failed call rolls back to what was there, not to nothing.
    expect(app.store.getSettings('ada')).toEqual({ region: 'eu' });
  });
});
