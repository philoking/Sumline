import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import type { Sheet, SheetSummary } from '../src/db.js';

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

async function makeSheet(owner = 'ada', title = 'Budget') {
  const response = await app.server.inject({
    method: 'POST',
    url: '/api/sheets',
    headers: as(owner),
    payload: { title, content: '1 + 1' },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as Sheet;
}

async function makeFolder(owner = 'ada', name = 'Work') {
  const response = await app.server.inject({
    method: 'POST',
    url: '/api/folders',
    headers: as(owner),
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; name: string; color: string | null };
}

const setSheetColor = (id: string, color: unknown, owner = 'ada') =>
  app.server.inject({
    method: 'PUT',
    url: `/api/sheets/${id}/color`,
    headers: as(owner),
    payload: { color },
  });

const setFolderColor = (id: string, color: unknown, owner = 'ada') =>
  app.server.inject({
    method: 'PUT',
    url: `/api/folders/${id}/color`,
    headers: as(owner),
    payload: { color },
  });

describe('colouring a sheet', () => {
  it('starts with no colour', async () => {
    const sheet = await makeSheet();
    expect(sheet.color).toBeNull();
  });

  it('stores the colour and hands it back on the list and the sheet', async () => {
    const sheet = await makeSheet();
    const response = await setSheetColor(sheet.id, 'teal');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: sheet.id, color: 'teal' });

    const listed = await app.server.inject({ url: '/api/sheets', headers: as('ada') });
    expect((listed.json() as { sheets: SheetSummary[] }).sheets[0]?.color).toBe('teal');

    const fetched = await app.server.inject({ url: `/api/sheets/${sheet.id}` });
    expect((fetched.json() as Sheet).color).toBe('teal');
  });

  it('leaves the version and the modified time alone', async () => {
    // Colour is how a sheet is filed, not what it says. A version bump would
    // make tagging a sheet collide with someone editing it, and a new
    // updated_at would jump it up a list ordered by when it last changed.
    const sheet = await makeSheet();
    await setSheetColor(sheet.id, 'red');

    const fetched = (
      await app.server.inject({ url: `/api/sheets/${sheet.id}` })
    ).json() as Sheet;
    expect(fetched.version).toBe(sheet.version);
    expect(fetched.updatedAt).toBe(sheet.updatedAt);
  });

  it('clears back to none', async () => {
    const sheet = await makeSheet();
    await setSheetColor(sheet.id, 'red');
    const cleared = await setSheetColor(sheet.id, null);
    expect(cleared.json()).toEqual({ id: sheet.id, color: null });

    const fetched = await app.server.inject({ url: `/api/sheets/${sheet.id}` });
    expect((fetched.json() as Sheet).color).toBeNull();
  });

  it('treats an empty string as clearing it', async () => {
    const sheet = await makeSheet();
    await setSheetColor(sheet.id, 'red');
    expect((await setSheetColor(sheet.id, '')).json()).toEqual({
      id: sheet.id,
      color: null,
    });
  });

  it('refuses anything outside the token alphabet', async () => {
    const sheet = await makeSheet();
    // The token reaches the browser inside a class attribute, so the charset
    // is what stops a stored colour from escaping it.
    for (const bad of [
      'red; drop',
      '"onload=alert(1)',
      'Red',
      'red-ish',
      'a',
      'aquamarineblue',
      42,
      { id: 'red' },
    ]) {
      const response = await setSheetColor(sheet.id, bad);
      expect(response.statusCode, `should reject ${JSON.stringify(bad)}`).toBe(400);
    }
    const fetched = await app.server.inject({ url: `/api/sheets/${sheet.id}` });
    expect((fetched.json() as Sheet).color).toBeNull();
  });

  it('reports a sheet that is not there', async () => {
    expect((await setSheetColor('nope', 'red')).statusCode).toBe(404);
  });

  it('refuses to colour a sheet in another space, share link or not', async () => {
    // Reading and editing across a share link is the point of one; filing is
    // not. A colour changes how a row looks in a sidebar the caller cannot
    // see, and the lock does not serialise it the way it serialises an edit.
    const sheet = await makeSheet('ada');
    expect((await setSheetColor(sheet.id, 'red', 'grace')).statusCode).toBe(404);

    const fetched = await app.server.inject({ url: `/api/sheets/${sheet.id}` });
    expect((fetched.json() as Sheet).color).toBeNull();
  });

  it('still lets another space read and edit that sheet', async () => {
    // The other half of the rule: scoping the colour must not have made a
    // share link read-only.
    const sheet = await makeSheet('ada');
    const edited = await app.server.inject({
      method: 'PUT',
      url: `/api/sheets/${sheet.id}`,
      headers: as('grace'),
      payload: { content: 'edited from elsewhere', version: sheet.version },
    });
    expect(edited.statusCode).toBe(200);
  });
});

describe('colouring a folder', () => {
  it('stores the colour and lists it', async () => {
    const folder = await makeFolder();
    expect(folder.color).toBeNull();

    const response = await setFolderColor(folder.id, 'purple');
    expect(response.statusCode).toBe(200);

    const listed = await app.server.inject({ url: '/api/folders', headers: as('ada') });
    expect(
      (listed.json() as { folders: Array<{ color: string | null }> }).folders[0]?.color,
    ).toBe('purple');
  });

  it('refuses to colour a folder in another space', async () => {
    // Renaming and deleting a folder are already refused across spaces, and
    // recolouring someone else's filing is the same kind of change.
    const folder = await makeFolder('ada');
    expect((await setFolderColor(folder.id, 'red', 'grace')).statusCode).toBe(404);

    const listed = await app.server.inject({ url: '/api/folders', headers: as('ada') });
    expect(
      (listed.json() as { folders: Array<{ color: string | null }> }).folders[0]?.color,
    ).toBeNull();
  });

  it('refuses an unusable token and an unknown folder', async () => {
    const folder = await makeFolder();
    expect((await setFolderColor(folder.id, 'nope!')).statusCode).toBe(400);
    expect((await setFolderColor('missing', 'red')).statusCode).toBe(404);
  });
});
