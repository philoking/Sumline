import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp, type App } from '../src/app.js';
import { Store } from '../src/db.js';
import type { Space } from '../src/spaces.js';

let app: App;

/** The two people these tests are about, configured rather than compiled in. */
const PEOPLE: Space[] = [
  { id: 'jason', name: 'Jason' },
  { id: 'kim', name: 'Kim' },
];

/** The space pre-user rows are adopted into: the first one configured. */
const DEFAULT_USER = PEOPLE[0]!.id;

function build(seed = false, spaces: Space[] = PEOPLE): App {
  return buildApp({
    dbPath: ':memory:',
    staticRoot: null,
    autoRefreshRates: false,
    seedWelcomeSheet: seed,
    spaces,
  });
}

/** Every request carries the space in a cookie, exactly as the browser does. */
function as(user: string) {
  return { cookie: `webcalc_user=${user}` };
}

beforeEach(() => {
  app = build();
});

afterEach(async () => {
  await app.server.close();
});

async function createSheet(user: string, title: string, content = '') {
  const response = await app.server.inject({
    method: 'POST',
    url: '/api/sheets',
    headers: as(user),
    payload: { title, content },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; version: number; owner: string };
}

async function listTitles(user: string, url = '/api/sheets') {
  const response = await app.server.inject({ url, headers: as(user) });
  return (response.json() as { sheets: Array<{ title: string }> }).sheets.map(
    (s) => s.title,
  );
}

describe('separate spaces', () => {
  it('keeps each person’s sheets out of the other’s list', async () => {
    await createSheet('jason', 'Bluray sales');
    await createSheet('kim', 'Garden plan');

    expect(await listTitles('jason')).toEqual(['Bluray sales']);
    expect(await listTitles('kim')).toEqual(['Garden plan']);
  });

  it('stamps a new sheet with the space that created it', async () => {
    const sheet = await createSheet('kim', 'Garden plan');
    expect(sheet.owner).toBe('kim');
  });

  it('keeps search inside the space', async () => {
    await createSheet('jason', 'Budget', 'rent = 1200');
    await createSheet('kim', 'Budget', 'rent = 1200');
    expect(await listTitles('kim', '/api/sheets?q=rent')).toEqual(['Budget']);
    expect(await listTitles('kim', '/api/sheets?q=rent')).toHaveLength(1);
  });

  it('keeps folders apart', async () => {
    await app.server.inject({
      method: 'POST',
      url: '/api/folders',
      headers: as('jason'),
      payload: { name: 'Work' },
    });
    const kim = await app.server.inject({ url: '/api/folders', headers: as('kim') });
    expect((kim.json() as { folders: unknown[] }).folders).toEqual([]);
  });

  it('keeps trash apart', async () => {
    const mine = await createSheet('jason', 'Mine');
    await createSheet('kim', 'Hers');
    await app.server.inject({
      method: 'DELETE',
      url: `/api/sheets/${mine.id}`,
      headers: as('jason'),
    });

    expect(await listTitles('jason', '/api/sheets?trash=1')).toEqual(['Mine']);
    expect(await listTitles('kim', '/api/sheets?trash=1')).toEqual([]);

    // Emptying one trash must not reach into the other's.
    const hers = await createSheet('kim', 'Also hers');
    await app.server.inject({
      method: 'DELETE',
      url: `/api/sheets/${hers.id}`,
      headers: as('kim'),
    });
    const purged = await app.server.inject({
      method: 'DELETE',
      url: '/api/trash',
      headers: as('jason'),
    });
    expect(purged.json()).toEqual({ purged: 1 });
    expect(await listTitles('kim', '/api/sheets?trash=1')).toEqual(['Also hers']);
  });

  it('keeps settings apart, including the global variables', async () => {
    await app.server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: as('jason'),
      payload: { statistic: 'median', globals: { rate: '0.2' } },
    });
    const kim = await app.server.inject({ url: '/api/settings', headers: as('kim') });
    expect(kim.json()).toEqual({});
  });
});

describe('crossing a space by share link', () => {
  it('resolves and opens a sheet from the other space', async () => {
    const sheet = await createSheet('jason', 'Kitchen remodel', '1 + 1');
    const share = await app.server.inject({
      method: 'POST',
      url: `/api/sheets/${sheet.id}/share`,
      headers: as('jason'),
    });
    const { slug } = share.json() as { slug: string };

    // The link is the whole point of the feature: it must work for Kim even
    // though the sheet is not in her space.
    const resolved = await app.server.inject({
      url: `/api/sheets/by-slug/${slug}`,
      headers: as('kim'),
    });
    expect(resolved.json()).toEqual({ id: sheet.id });

    const opened = await app.server.inject({
      url: `/api/sheets/${sheet.id}`,
      headers: as('kim'),
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ title: 'Kitchen remodel', owner: 'jason' });
  });

  it('lets the other person edit it, and it stays where it lives', async () => {
    const sheet = await createSheet('jason', 'Kitchen remodel', 'cabinets = 10');
    const saved = await app.server.inject({
      method: 'PUT',
      url: `/api/sheets/${sheet.id}`,
      headers: as('kim'),
      payload: { content: 'cabinets = 20', version: sheet.version },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ content: 'cabinets = 20', owner: 'jason' });
    // Editing does not move it into Kim's list.
    expect(await listTitles('kim')).toEqual([]);
    expect(await listTitles('jason')).toEqual(['Kitchen remodel']);
  });

  it('refuses to let the other person delete it', async () => {
    const sheet = await createSheet('jason', 'Kitchen remodel');

    const trashed = await app.server.inject({
      method: 'DELETE',
      url: `/api/sheets/${sheet.id}`,
      headers: as('kim'),
    });
    expect(trashed.statusCode).toBe(404);

    const purged = await app.server.inject({
      method: 'DELETE',
      url: `/api/sheets/${sheet.id}?purge=1`,
      headers: as('kim'),
    });
    expect(purged.statusCode).toBe(404);

    // Still there, still Jason's.
    expect(await listTitles('jason')).toEqual(['Kitchen remodel']);
  });

  it('refuses to let the other person restore from a trash that is not theirs', async () => {
    const sheet = await createSheet('jason', 'Kitchen remodel');
    await app.server.inject({
      method: 'DELETE',
      url: `/api/sheets/${sheet.id}`,
      headers: as('jason'),
    });
    const restored = await app.server.inject({
      method: 'POST',
      url: `/api/sheets/${sheet.id}/restore`,
      headers: as('kim'),
    });
    expect(restored.statusCode).toBe(404);
  });

  it('refuses to let the other person rename or delete a folder', async () => {
    const created = await app.server.inject({
      method: 'POST',
      url: '/api/folders',
      headers: as('jason'),
      payload: { name: 'Work' },
    });
    const { id } = created.json() as { id: string };

    const renamed = await app.server.inject({
      method: 'PUT',
      url: `/api/folders/${id}`,
      headers: as('kim'),
      payload: { name: 'Hijacked' },
    });
    expect(renamed.statusCode).toBe(404);

    const deleted = await app.server.inject({
      method: 'DELETE',
      url: `/api/folders/${id}`,
      headers: as('kim'),
    });
    expect(deleted.statusCode).toBe(404);
  });
});

describe('choosing a space', () => {
  it('lists the people and reports who the cookie says we are', async () => {
    const response = await app.server.inject({ url: '/api/users', headers: as('kim') });
    expect(response.json()).toMatchObject({
      users: [
        { id: 'jason', name: 'Jason' },
        { id: 'kim', name: 'Kim' },
      ],
      current: 'kim',
    });
  });

  it('falls back to the default space rather than erroring', async () => {
    await createSheet(DEFAULT_USER, 'Default space sheet');

    for (const cookie of ['webcalc_user=nobody', 'webcalc_user=', 'other=1', '']) {
      const response = await app.server.inject({
        url: '/api/sheets',
        ...(cookie ? { headers: { cookie } } : {}),
      });
      const titles = (response.json() as { sheets: Array<{ title: string }> }).sheets;
      expect(titles.map((s) => s.title)).toEqual(['Default space sheet']);
    }
  });

  it('reads the cookie when other cookies sit alongside it', async () => {
    await createSheet('kim', 'Hers');
    const response = await app.server.inject({
      url: '/api/sheets',
      headers: { cookie: 'theme=dark; webcalc_user=kim; other=x' },
    });
    expect((response.json() as { sheets: unknown[] }).sheets).toHaveLength(1);
  });
});

describe('seeding and migration', () => {
  it('gives every space its own Welcome sheet', async () => {
    const seeded = build(true);
    try {
      const jason = await seeded.server.inject({ url: '/api/sheets', headers: as('jason') });
      const kim = await seeded.server.inject({ url: '/api/sheets', headers: as('kim') });
      const titles = (r: typeof jason) =>
        (r.json() as { sheets: Array<{ title: string }> }).sheets.map((s) => s.title);
      expect(titles(jason)).toEqual(['Welcome']);
      expect(titles(kim)).toEqual(['Welcome']);
    } finally {
      await seeded.server.close();
    }
  });

  it('moves pre-user settings into the default space without clobbering them later', () => {
    const dir = mkdtempSync(join(tmpdir(), 'webcalc-spaces-'));
    const path = join(dir, 'old.db');

    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    legacy
      .prepare('INSERT INTO settings VALUES (?, ?)')
      .run('statistic', JSON.stringify('median'));
    legacy.close();

    const first = new Store(path, DEFAULT_USER);
    expect(first.getSettings(DEFAULT_USER)).toEqual({ statistic: 'median' });
    // A preference changed after the migration must survive the next start.
    first.saveSettings(DEFAULT_USER, { statistic: 'count' });
    first.close();

    const second = new Store(path, DEFAULT_USER);
    expect(second.getSettings(DEFAULT_USER)).toEqual({ statistic: 'count' });
    expect(second.getSettings('kim')).toEqual({});
    second.close();

    rmSync(dir, { recursive: true, force: true });
  });

  it('puts pre-user folders in the default space', () => {
    const dir = mkdtempSync(join(tmpdir(), 'webcalc-folders-'));
    const path = join(dir, 'old.db');

    const legacy = new DatabaseSync(path);
    legacy.exec(
      `CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL,
                             position INTEGER NOT NULL DEFAULT 0)`,
    );
    legacy.prepare('INSERT INTO folders VALUES (?, ?, 0)').run('f1', 'Work');
    legacy.close();

    const store = new Store(path, DEFAULT_USER);
    expect(store.listFolders(DEFAULT_USER).map((f) => f.name)).toEqual(['Work']);
    expect(store.listFolders('kim')).toEqual([]);
    store.close();

    rmSync(dir, { recursive: true, force: true });
  });
});
