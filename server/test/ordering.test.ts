import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import type { Sheet } from '../src/db.js';

let app: App;

beforeEach(() => {
  app = buildApp({
    dbPath: ':memory:',
    staticRoot: null,
    autoRefreshRates: false,
    seedWelcomeSheet: false,
    spaces: [
      { id: 'jason', name: 'Jason' },
      { id: 'kim', name: 'Kim' },
    ],
  });
});

afterEach(async () => {
  await app.server.close();
});

const as = (user: string) => ({ cookie: `webcalc_user=${user}` });

async function make(title: string, owner = 'jason', folderId: string | null = null) {
  const response = await app.server.inject({
    method: 'POST',
    url: '/api/sheets',
    headers: as(owner),
    payload: { title, content: '1', folderId },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as Sheet;
}

async function titles(url = '/api/sheets', owner = 'jason') {
  const response = await app.server.inject({ url, headers: as(owner) });
  return (response.json() as { sheets: Array<{ title: string }> }).sheets.map(
    (sheet) => sheet.title,
  );
}

async function ids(url = '/api/sheets', owner = 'jason') {
  const response = await app.server.inject({ url, headers: as(owner) });
  return (response.json() as { sheets: Array<{ id: string }> }).sheets.map((s) => s.id);
}

const reorder = (order: string[], owner = 'jason') =>
  app.server.inject({
    method: 'PUT',
    url: '/api/sheets/order',
    headers: as(owner),
    payload: { ids: order },
  });

/** Three sheets, newest first: C, B, A. */
async function threeSheets() {
  const a = await make('A');
  const b = await make('B');
  const c = await make('C');
  return { a, b, c };
}

describe('a space that never drags anything', () => {
  it('still lists by what changed last', async () => {
    await threeSheets();
    expect(await titles()).toEqual(['C', 'B', 'A']);

    // Touching the oldest sheet floats it, which is the behaviour the default
    // has always had and must keep.
    const { sheets } = (await app.server.inject({ url: '/api/sheets', headers: as('jason') })).json() as {
      sheets: Array<{ id: string; title: string; version: number }>;
    };
    const a = sheets.find((s) => s.title === 'A')!;
    await app.server.inject({
      method: 'PUT',
      url: `/api/sheets/${a.id}`,
      headers: as('jason'),
      payload: { content: 'touched', version: a.version },
    });
    expect(await titles()).toEqual(['A', 'C', 'B']);
  });

  it('reports no order preference until one is made', async () => {
    await threeSheets();
    const settings = await app.server.inject({ url: '/api/settings', headers: as('jason') });
    expect((settings.json() as { sheetOrder?: string }).sheetOrder).toBeUndefined();
  });
});

describe('dragging a sheet', () => {
  it('holds the order against an edit that would have floated a sheet', async () => {
    const { a, b, c } = await threeSheets();
    expect(await titles()).toEqual(['C', 'B', 'A']);

    // Put A at the top by hand.
    expect((await reorder([a.id, c.id, b.id])).statusCode).toBe(200);
    expect(await titles()).toEqual(['A', 'C', 'B']);

    // Now edit B. Under recency it would jump to the top; the whole point of
    // a manual order is that it does not.
    await app.server.inject({
      method: 'PUT',
      url: `/api/sheets/${b.id}`,
      headers: as('jason'),
      payload: { content: 'edited', version: b.version },
    });
    expect(await titles()).toEqual(['A', 'C', 'B']);
  });

  it('switches the space to manual without being asked separately', async () => {
    const { a, b, c } = await threeSheets();
    await reorder([b.id, a.id, c.id]);
    const settings = await app.server.inject({ url: '/api/settings', headers: as('jason') });
    expect((settings.json() as { sheetOrder?: string }).sheetOrder).toBe('manual');
  });

  it('seeds from the order that was on screen', async () => {
    // Reordering only two of three must leave the third where it was rather
    // than sweeping it to an end, which is what seeding from the displayed
    // order buys.
    const { a, b, c } = await threeSheets();
    expect(await titles()).toEqual(['C', 'B', 'A']);
    await reorder([c.id, a.id, b.id]);
    expect(await titles()).toEqual(['C', 'A', 'B']);
  });

  it('goes back to recency without losing the arrangement', async () => {
    const { a, b, c } = await threeSheets();
    await reorder([a.id, b.id, c.id]);
    expect(await titles()).toEqual(['A', 'B', 'C']);

    await app.server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: as('jason'),
      payload: { sheetOrder: 'recent' },
    });
    expect(await titles()).toEqual(['C', 'B', 'A']);

    // Back again: the positions were never discarded.
    await app.server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: as('jason'),
      payload: { sheetOrder: 'manual' },
    });
    expect(await titles()).toEqual(['A', 'B', 'C']);
  });

  it('puts a newly created sheet at the top rather than the bottom', async () => {
    const { a, b, c } = await threeSheets();
    await reorder([a.id, b.id, c.id]);
    await make('D');
    // A new sheet has no position; landing it silently at the foot of a long
    // arranged list is the behaviour that reads as a bug.
    expect(await titles()).toEqual(['D', 'A', 'B', 'C']);
  });
});

describe('reordering inside a filtered view', () => {
  it('leaves sheets outside the folder exactly where they were', async () => {
    const folder = (
      await app.server.inject({
        method: 'POST',
        url: '/api/folders',
        headers: as('jason'),
        payload: { name: 'Work' },
      })
    ).json() as { id: string };

    const loose1 = await make('Loose one');
    const inA = await make('In A', 'jason', folder.id);
    const loose2 = await make('Loose two');
    const inB = await make('In B', 'jason', folder.id);

    // Arrange the whole list first, so every sheet holds a position.
    await reorder([inB.id, loose2.id, inA.id, loose1.id]);
    expect(await titles()).toEqual(['In B', 'Loose two', 'In A', 'Loose one']);

    // Now swap the two inside the folder, seeing only those two.
    const inFolder = await ids(`/api/sheets?folder=${folder.id}`);
    expect(inFolder).toEqual([inB.id, inA.id]);
    await reorder([inA.id, inB.id]);

    expect(await titles(`/api/sheets?folder=${folder.id}`)).toEqual(['In A', 'In B']);
    // The loose sheets keep both their positions and their neighbours: the
    // folder's sheets borrowed only the slots they already held.
    expect(await titles()).toEqual(['In A', 'Loose two', 'In B', 'Loose one']);
  });
});

describe('what a reorder refuses', () => {
  it('rejects a body that is not a list of ids', async () => {
    await threeSheets();
    for (const bad of [undefined, 'a,b', [1, 2], [{ id: 'x' }], null]) {
      const response = await app.server.inject({
        method: 'PUT',
        url: '/api/sheets/order',
        headers: as('jason'),
        payload: { ids: bad },
      });
      expect(response.statusCode, `should reject ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('ignores ids belonging to another space', async () => {
    const { a, b } = await threeSheets();
    const hers = await make('Hers', 'kim');

    // Kim's sheet named in Jason's reorder must not move, and must not drag
    // one of his slots over to her.
    await reorder([a.id, hers.id, b.id]);
    expect(await titles('/api/sheets', 'kim')).toEqual(['Hers']);

    const settings = await app.server.inject({ url: '/api/settings', headers: as('kim') });
    expect((settings.json() as { sheetOrder?: string }).sheetOrder).toBeUndefined();
  });

  it('refuses when there is nothing to rearrange', async () => {
    const only = await make('Only');
    expect((await reorder([only.id])).statusCode).toBe(400);
    expect((await reorder([])).statusCode).toBe(400);
  });

  it('keeps each space on its own ordering', async () => {
    const { a, b, c } = await threeSheets();
    await make('Hers one', 'kim');
    await make('Hers two', 'kim');

    await reorder([a.id, b.id, c.id]);
    expect(await titles()).toEqual(['A', 'B', 'C']);
    // Kim never dragged anything, so her list is still by recency.
    expect(await titles('/api/sheets', 'kim')).toEqual(['Hers two', 'Hers one']);
  });
});
