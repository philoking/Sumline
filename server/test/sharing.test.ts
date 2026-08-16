import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { slugify } from '../src/db.js';

let app: App;

beforeEach(() => {
  app = buildApp({
    dbPath: ':memory:',
    staticRoot: null,
    autoRefreshRates: false,
    seedWelcomeSheet: false,
  });
});

afterEach(async () => {
  await app.server.close();
});

async function createSheet(title: string) {
  const response = await app.server.inject({
    method: 'POST',
    url: '/api/sheets',
    payload: { title },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; version: number };
}

async function share(id: string): Promise<string> {
  const response = await app.server.inject({
    method: 'POST',
    url: `/api/sheets/${id}/share`,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { slug: string }).slug;
}

async function resolve(slug: string) {
  return app.server.inject({ url: `/api/sheets/by-slug/${encodeURIComponent(slug)}` });
}

async function rename(id: string, title: string, version: number) {
  const response = await app.server.inject({
    method: 'PUT',
    url: `/api/sheets/${id}`,
    payload: { title, version },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { version: number };
}

describe('slugify', () => {
  it('reads a title back as a link', () => {
    expect(slugify('Kitchen remodel')).toBe('kitchen-remodel');
    expect(slugify('Mortgage refi — 2026')).toBe('mortgage-refi-2026');
    expect(slugify('  Spaces  everywhere  ')).toBe('spaces-everywhere');
  });

  it('keeps accented words rather than dropping them', () => {
    expect(slugify('Café budget')).toBe('cafe-budget');
    expect(slugify('Über costs')).toBe('uber-costs');
  });

  it('never ends or begins with a separator', () => {
    expect(slugify('!!! Budget !!!')).toBe('budget');
    expect(slugify('a'.repeat(80))).toBe('a'.repeat(60));
    // A title long enough to be cut mid-word must not keep the dangling dash.
    const cut = slugify(`${'a'.repeat(59)} tail`);
    expect(cut).toBe('a'.repeat(59));
    expect(cut.endsWith('-')).toBe(false);
  });

  it('falls back when a title has nothing to slug', () => {
    expect(slugify('日本語')).toBe('sheet');
    expect(slugify('...')).toBe('sheet');
    expect(slugify('')).toBe('sheet');
  });
});

describe('share links', () => {
  it('mints a readable slug from the title', async () => {
    const sheet = await createSheet('Kitchen remodel');
    expect(await share(sheet.id)).toBe('kitchen-remodel');
  });

  it('returns the same link when a sheet is shared twice', async () => {
    const sheet = await createSheet('Kitchen remodel');
    expect(await share(sheet.id)).toBe(await share(sheet.id));
  });

  it('is stable for a title that ends in a number', async () => {
    // The suffix that resolves collisions is also digits, so a title ending
    // in one must not be mistaken for an already-numbered slug and re-minted
    // on every share.
    const sheet = await createSheet('Trip 2026');
    const first = await share(sheet.id);
    expect(first).toBe('trip-2026');
    expect(await share(sheet.id)).toBe('trip-2026');
  });

  it('resolves a link to its sheet', async () => {
    const sheet = await createSheet('Kitchen remodel');
    const slug = await share(sheet.id);
    const response = await resolve(slug);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: sheet.id });
  });

  it('keeps an old link working after a rename', async () => {
    const sheet = await createSheet('Kitchen remodel');
    const sent = await share(sheet.id);

    const renamed = await rename(sheet.id, 'Kitchen remodel v2', sheet.version);
    const fresh = await share(sheet.id);

    expect(fresh).toBe('kitchen-remodel-v2');
    expect(fresh).not.toBe(sent);
    // The whole point of the history table: the link already sent to someone
    // still lands on the sheet.
    expect((await resolve(sent)).json()).toEqual({ id: sheet.id });
    expect((await resolve(fresh)).json()).toEqual({ id: sheet.id });
    expect(renamed.version).toBe(sheet.version + 1);
  });

  it('numbers a slug when two sheets share a title', async () => {
    const first = await createSheet('Budget');
    const second = await createSheet('Budget');
    expect(await share(first.id)).toBe('budget');
    expect(await share(second.id)).toBe('budget-2');
    expect((await resolve('budget')).json()).toEqual({ id: first.id });
    expect((await resolve('budget-2')).json()).toEqual({ id: second.id });
  });

  it('will not hand a retired slug to a different sheet', async () => {
    const first = await createSheet('Budget');
    const retired = await share(first.id);
    await rename(first.id, 'Old budget', first.version);
    await share(first.id);

    // "Budget" is free by title, but issuing it again would hijack a link
    // already sent for the first sheet.
    const second = await createSheet('Budget');
    expect(await share(second.id)).not.toBe(retired);
    expect((await resolve(retired)).json()).toEqual({ id: first.id });
  });

  it('mints nothing until a sheet is actually shared', async () => {
    await createSheet('Untitled');
    expect((await resolve('untitled')).statusCode).toBe(404);
  });

  it('404s an unknown link and an unknown sheet', async () => {
    expect((await resolve('nothing-here')).statusCode).toBe(404);
    const missing = await app.server.inject({
      method: 'POST',
      url: '/api/sheets/does-not-exist/share',
    });
    expect(missing.statusCode).toBe(404);
  });

  it('survives a slug that looks like a path', async () => {
    expect((await resolve('../../etc/passwd')).statusCode).toBe(404);
  });

  it('drops links when the sheet is permanently deleted', async () => {
    const sheet = await createSheet('Kitchen remodel');
    const slug = await share(sheet.id);
    const deleted = await app.server.inject({
      method: 'DELETE',
      url: `/api/sheets/${sheet.id}?purge=1`,
    });
    expect(deleted.statusCode).toBe(200);
    expect((await resolve(slug)).statusCode).toBe(404);
  });

  it('still resolves a link to a trashed sheet, which can be restored', async () => {
    const sheet = await createSheet('Kitchen remodel');
    const slug = await share(sheet.id);
    await app.server.inject({ method: 'DELETE', url: `/api/sheets/${sheet.id}` });
    expect((await resolve(slug)).json()).toEqual({ id: sheet.id });
  });
});
