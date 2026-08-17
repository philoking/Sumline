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
      { id: 'ada', name: 'Ada' },
      { id: 'grace', name: 'Grace' },
    ],
  });
});

afterEach(async () => {
  await app.server.close();
});

const as = (user: string) => ({ cookie: `webcalc_user=${user}` });

/**
 * Lets the clock move on between writes.
 *
 * Sheets created in one go otherwise share a millisecond, and every ordering
 * assertion then rests on the tie-break rather than on the timestamps it
 * claims to be about — which quietly makes these tests agree with almost any
 * behaviour. A few milliseconds buys real recency to assert against.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

async function make(title: string, owner = 'ada', folderId: string | null = null) {
  const response = await app.server.inject({
    method: 'POST',
    url: '/api/sheets',
    headers: as(owner),
    payload: { title, content: '1', folderId },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as Sheet;
}

async function titles(url = '/api/sheets', owner = 'ada') {
  const response = await app.server.inject({ url, headers: as(owner) });
  return (response.json() as { sheets: Array<{ title: string }> }).sheets.map(
    (sheet) => sheet.title,
  );
}

async function ids(url = '/api/sheets', owner = 'ada') {
  const response = await app.server.inject({ url, headers: as(owner) });
  return (response.json() as { sheets: Array<{ id: string }> }).sheets.map((s) => s.id);
}

const reorder = (order: string[], owner = 'ada') =>
  app.server.inject({
    method: 'PUT',
    url: '/api/sheets/order',
    headers: as(owner),
    payload: { ids: order },
  });

/** Three sheets, newest first: C, B, A. */
async function threeSheets() {
  const a = await make('A');
  await tick();
  const b = await make('B');
  await tick();
  const c = await make('C');
  await tick();
  return { a, b, c };
}

describe('a space that never drags anything', () => {
  it('still lists by what changed last', async () => {
    await threeSheets();
    expect(await titles()).toEqual(['C', 'B', 'A']);

    // Touching the oldest sheet floats it, which is the behaviour the default
    // has always had and must keep.
    const { sheets } = (await app.server.inject({ url: '/api/sheets', headers: as('ada') })).json() as {
      sheets: Array<{ id: string; title: string; version: number }>;
    };
    const a = sheets.find((s) => s.title === 'A')!;
    await tick();
    await app.server.inject({
      method: 'PUT',
      url: `/api/sheets/${a.id}`,
      headers: as('ada'),
      payload: { content: 'touched', version: a.version },
    });
    expect(await titles()).toEqual(['A', 'C', 'B']);
  });

  it('reports no order preference until one is made', async () => {
    await threeSheets();
    const settings = await app.server.inject({ url: '/api/settings', headers: as('ada') });
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
    await tick();
    await app.server.inject({
      method: 'PUT',
      url: `/api/sheets/${b.id}`,
      headers: as('ada'),
      payload: { content: 'edited', version: b.version },
    });
    expect(await titles()).toEqual(['A', 'C', 'B']);
  });

  it('switches the space to manual without being asked separately', async () => {
    const { a, b, c } = await threeSheets();
    await reorder([b.id, a.id, c.id]);
    const settings = await app.server.inject({ url: '/api/settings', headers: as('ada') });
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
      headers: as('ada'),
      payload: { sheetOrder: 'recent' },
    });
    expect(await titles()).toEqual(['C', 'B', 'A']);

    // Back again: the positions were never discarded.
    await app.server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: as('ada'),
      payload: { sheetOrder: 'manual' },
    });
    expect(await titles()).toEqual(['A', 'B', 'C']);
  });

  it('puts a newly created sheet at the top rather than the bottom', async () => {
    const { a, b, c } = await threeSheets();
    await reorder([a.id, b.id, c.id]);
    await tick();
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
        headers: as('ada'),
        payload: { name: 'Work' },
      })
    ).json() as { id: string };

    const loose1 = await make('Loose one');
    await tick();
    const inA = await make('In A', 'ada', folder.id);
    await tick();
    const loose2 = await make('Loose two');
    await tick();
    const inB = await make('In B', 'ada', folder.id);
    await tick();

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
        headers: as('ada'),
        payload: { ids: bad },
      });
      expect(response.statusCode, `should reject ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('ignores ids belonging to another space', async () => {
    const { a, b } = await threeSheets();
    const hers = await make('Hers', 'grace');

    // Grace's sheet named in Ada's reorder must not move, and must not drag
    // one of his slots over to her.
    await reorder([a.id, hers.id, b.id]);
    expect(await titles('/api/sheets', 'grace')).toEqual(['Hers']);

    const settings = await app.server.inject({ url: '/api/settings', headers: as('grace') });
    expect((settings.json() as { sheetOrder?: string }).sheetOrder).toBeUndefined();
  });

  it('refuses when there is nothing to rearrange', async () => {
    const only = await make('Only');
    expect((await reorder([only.id])).statusCode).toBe(400);
    expect((await reorder([])).statusCode).toBe(400);
  });

  it('writes nothing at all when it refuses', async () => {
    // A rejected call used to seed positions before deciding it had nothing to
    // do, so any stray request — a health probe, a retry, a bad client — left
    // every sheet in the space stamped with a position and the list quietly
    // frozen out of recency order.
    const { a, b, c } = await threeSheets();
    expect(await titles()).toEqual(['C', 'B', 'A']);

    expect((await reorder([])).statusCode).toBe(400);
    expect((await reorder([a.id])).statusCode).toBe(400);
    expect((await reorder(['not-a-sheet', 'nor-this'])).statusCode).toBe(400);

    // Still recency, and still no preference recorded: nothing was written.
    expect(await titles()).toEqual(['C', 'B', 'A']);
    const settings = await app.server.inject({ url: '/api/settings', headers: as('ada') });
    expect((settings.json() as { sheetOrder?: string }).sheetOrder).toBeUndefined();

    // The lasting damage of the old behaviour only showed later: positions
    // written behind a refusal are an arrangement nobody made, waiting for
    // the day the space switches to manual. So edit a sheet, then switch —
    // with nothing written, manual has no positions to use and must agree
    // exactly with recency. Comparing the two orders rather than naming one
    // keeps this from depending on which millisecond anything landed in.
    await tick();
    await app.server.inject({
      method: 'PUT',
      url: `/api/sheets/${a.id}`,
      headers: as('ada'),
      payload: { content: 'touched', version: a.version },
    });
    const byRecency = await titles();
    // A was the oldest and has just been touched, so recency must now lead
    // with it — if it does not, the comparison below proves nothing.
    expect(byRecency[0]).toBe('A');

    await app.server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: as('ada'),
      payload: { sheetOrder: 'manual' },
    });
    expect(await titles()).toEqual(byRecency);
  });

  it('keeps each space on its own ordering', async () => {
    const { a, b, c } = await threeSheets();
    await make('Hers one', 'grace');
    await tick();
    await make('Hers two', 'grace');

    await reorder([a.id, b.id, c.id]);
    expect(await titles()).toEqual(['A', 'B', 'C']);
    // Grace never dragged anything, so her list is still by recency.
    expect(await titles('/api/sheets', 'grace')).toEqual(['Hers two', 'Hers one']);
  });
});
