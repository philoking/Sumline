import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp, type App } from '../src/app.js';
import { Store, deriveTitle } from '../src/db.js';
import { FALLBACK_SPACE } from '../src/spaces.js';
import type { SheetSummary } from '../src/db.js';

let app: App;

function build(overrides: Partial<Parameters<typeof buildApp>[0]> = {}): App {
  return buildApp({
    dbPath: ':memory:',
    staticRoot: null,
    autoRefreshRates: false,
    seedWelcomeSheet: false,
    rateFetcher: async () => ({ base: 'USD', date: '2026-08-14', rates: { EUR: 0.8 } }),
    holidayFetcher: async () => [],
    ...overrides,
  });
}

async function createSheet(title: string, content = '') {
  const response = await app.server.inject({
    method: 'POST',
    url: '/api/sheets',
    payload: { title, content },
  });
  return response.json() as { id: string; version: number };
}

async function list(query = ''): Promise<SheetSummary[]> {
  const response = await app.server.inject({ url: `/api/sheets${query}` });
  return (response.json() as { sheets: SheetSummary[] }).sheets;
}

beforeEach(() => {
  app = build();
});

afterEach(async () => {
  await app.server.close();
});

describe('trash', () => {
  it('moves a deleted sheet to the trash rather than destroying it', async () => {
    const sheet = await createSheet('Doomed', 'x');
    await app.server.inject({ method: 'DELETE', url: `/api/sheets/${sheet.id}` });

    expect(await list()).toHaveLength(0);
    const trashed = await list('?trash=1');
    expect(trashed.map((s) => s.title)).toEqual(['Doomed']);
    // The sheet itself is still readable, so a restore has something to return.
    expect((await app.server.inject({ url: `/api/sheets/${sheet.id}` })).statusCode).toBe(200);
  });

  it('restores a trashed sheet', async () => {
    const sheet = await createSheet('Back', 'x');
    await app.server.inject({ method: 'DELETE', url: `/api/sheets/${sheet.id}` });
    await app.server.inject({ method: 'POST', url: `/api/sheets/${sheet.id}/restore` });
    expect((await list()).map((s) => s.title)).toEqual(['Back']);
  });

  it('empties the trash permanently', async () => {
    const sheet = await createSheet('Gone', 'x');
    await app.server.inject({ method: 'DELETE', url: `/api/sheets/${sheet.id}` });
    const purged = await app.server.inject({ method: 'DELETE', url: '/api/trash' });
    expect(purged.json()).toMatchObject({ purged: 1 });
    expect((await app.server.inject({ url: `/api/sheets/${sheet.id}` })).statusCode).toBe(404);
  });

  it('deletes outright when asked to purge', async () => {
    const sheet = await createSheet('Immediate', 'x');
    await app.server.inject({
      method: 'DELETE',
      url: `/api/sheets/${sheet.id}?purge=1`,
    });
    expect(await list('?trash=1')).toHaveLength(0);
    expect((await app.server.inject({ url: `/api/sheets/${sheet.id}` })).statusCode).toBe(404);
  });
});

describe('folders', () => {
  it('creates, renames and lists folders', async () => {
    const created = (
      await app.server.inject({ method: 'POST', url: '/api/folders', payload: { name: 'Work' } })
    ).json() as { id: string; name: string };
    expect(created.name).toBe('Work');

    await app.server.inject({
      method: 'PUT',
      url: `/api/folders/${created.id}`,
      payload: { name: 'Projects' },
    });
    const folders = (await app.server.inject({ url: '/api/folders' })).json() as {
      folders: Array<{ name: string }>;
    };
    expect(folders.folders.map((f) => f.name)).toEqual(['Projects']);
  });

  it('filters sheets by folder', async () => {
    const folder = (
      await app.server.inject({ method: 'POST', url: '/api/folders', payload: { name: 'Work' } })
    ).json() as { id: string };
    const sheet = await createSheet('Filed', 'x');
    await createSheet('Loose', 'x');

    await app.server.inject({
      method: 'PUT',
      url: `/api/sheets/${sheet.id}`,
      payload: { folderId: folder.id },
    });

    expect((await list(`?folder=${folder.id}`)).map((s) => s.title)).toEqual(['Filed']);
    expect((await list('?folder=')).map((s) => s.title)).toEqual(['Loose']);
  });

  it('keeps the sheets when a folder is deleted', async () => {
    const folder = (
      await app.server.inject({ method: 'POST', url: '/api/folders', payload: { name: 'Temp' } })
    ).json() as { id: string };
    const sheet = await createSheet('Survivor', 'x');
    await app.server.inject({
      method: 'PUT',
      url: `/api/sheets/${sheet.id}`,
      payload: { folderId: folder.id },
    });

    await app.server.inject({ method: 'DELETE', url: `/api/folders/${folder.id}` });

    // Losing notes to a folder tidy-up would be indefensible.
    const remaining = await list();
    expect(remaining.map((s) => s.title)).toEqual(['Survivor']);
    expect(remaining[0]?.folderId).toBeNull();
  });
});

describe('search', () => {
  it('matches on title and on body', async () => {
    await createSheet('Mortgage', 'monthly repayment');
    await createSheet('Groceries', 'apples and pears');

    expect((await list('?q=mortg')).map((s) => s.title)).toEqual(['Mortgage']);
    expect((await list('?q=pears')).map((s) => s.title)).toEqual(['Groceries']);
    expect(await list('?q=nothinghere')).toHaveLength(0);
  });

  it('does not surface trashed sheets in search', async () => {
    const sheet = await createSheet('Hidden', 'findable text');
    await app.server.inject({ method: 'DELETE', url: `/api/sheets/${sheet.id}` });
    expect(await list('?q=findable')).toHaveLength(0);
  });
});

describe('auto-titling', () => {
  it('names an untitled sheet from its first line', () => {
    expect(deriveTitle('Untitled', '# Budget 2026\n100 + 20')).toBe('Budget 2026');
    expect(deriveTitle('Untitled', '\n\n12 * 34')).toBe('12 * 34');
    expect(deriveTitle('Untitled', '')).toBe('Untitled');
  });

  it('never overwrites a title the user chose', () => {
    expect(deriveTitle('My sheet', 'something else entirely')).toBe('My sheet');
  });

  it('applies on save', async () => {
    const sheet = await createSheet('Untitled', '');
    const saved = await app.server.inject({
      method: 'PUT',
      url: `/api/sheets/${sheet.id}`,
      payload: { content: 'Holiday budget\n1200', version: sheet.version },
    });
    expect(saved.json()).toMatchObject({ title: 'Holiday budget' });
  });
});

describe('settings', () => {
  it('round-trips arbitrary values', async () => {
    await app.server.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { statistic: 'median', globals: { 'day rate': '$550' } },
    });
    const settings = (await app.server.inject({ url: '/api/settings' })).json();
    expect(settings).toMatchObject({
      statistic: 'median',
      globals: { 'day rate': '$550' },
    });
  });

  it('merges rather than replacing', async () => {
    await app.server.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { statistic: 'total' },
    });
    await app.server.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { region: 'western-europe' },
    });
    expect((await app.server.inject({ url: '/api/settings' })).json()).toMatchObject({
      statistic: 'total',
      region: 'western-europe',
    });
  });
});

describe('schema migration', () => {
  it('adds the new columns to a database created before they existed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sumline-migrate-'));
    const path = join(dir, 'old.db');

    // A database shaped like the first release, holding a sheet.
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE sheets (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    legacy
      .prepare('INSERT INTO sheets VALUES (?, ?, ?, 1, ?, ?)')
      .run('old-1', 'Existing', 'kept', '2026-01-01', '2026-01-01');
    legacy.close();

    const store = new Store(path);
    const sheets = store.listSheets(FALLBACK_SPACE.id);
    expect(sheets.map((s) => s.title)).toEqual(['Existing']);
    expect(sheets[0]?.folderId).toBeNull();
    expect(store.getSheet('old-1')?.content).toBe('kept');
    // Sheets predating the user model land in the default space rather than
    // in none, which would hide them from everyone.
    expect(sheets[0]?.owner).toBe(FALLBACK_SPACE.id);
    store.close();

    rmSync(dir, { recursive: true, force: true });
  });
});
