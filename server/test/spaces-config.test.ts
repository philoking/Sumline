import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { Store } from '../src/db.js';
import {
  FALLBACK_SPACE,
  deriveSpaceId,
  orphanedOwners,
  parseSpaces,
  resolveSpace,
  spacesFromOwners,
  type Space,
} from '../src/spaces.js';

describe('reading the SPACES setting', () => {
  it('is unset rather than empty when nothing is configured', () => {
    // Null and [] must stay distinguishable: one adopts what the database
    // holds, the other would impose a space list owning nothing.
    expect(parseSpaces(undefined)).toBeNull();
    expect(parseSpaces('')).toBeNull();
    expect(parseSpaces('   ')).toBeNull();
    expect(parseSpaces(',, ,')).toBeNull();
  });

  it('derives an id from a bare name', () => {
    expect(parseSpaces('Jason,Kim')).toEqual([
      { id: 'jason', name: 'Jason' },
      { id: 'kim', name: 'Kim' },
    ]);
  });

  it('takes an explicit id, so a rename keeps the sheets', () => {
    // The whole point of the id form: Kim becomes Kimberley on screen while
    // every row still says `kim`.
    expect(parseSpaces('jason:Jason,kim:Kimberley')).toEqual([
      { id: 'jason', name: 'Jason' },
      { id: 'kim', name: 'Kimberley' },
    ]);
  });

  it('splits on the first colon only, so a name may contain one', () => {
    expect(parseSpaces('desk:Desk: upstairs')).toEqual([
      { id: 'desk', name: 'Desk: upstairs' },
    ]);
  });

  it('tolerates spacing around the separators', () => {
    expect(parseSpaces('  jason : Jason  ,  kim : Kim  ')).toEqual([
      { id: 'jason', name: 'Jason' },
      { id: 'kim', name: 'Kim' },
    ]);
  });

  it('normalises an id rather than refusing to start', () => {
    expect(parseSpaces('Jason M:Jason')).toEqual([
      { id: 'jason-m', name: 'Jason' },
    ]);
    expect(parseSpaces('Zoë,Ann-Marie')).toEqual([
      { id: 'zoe', name: 'Zoë' },
      { id: 'ann-marie', name: 'Ann-Marie' },
    ]);
  });

  it('keeps the first of two entries sharing an id', () => {
    // Otherwise the later one would silently take over a space already full
    // of the earlier one's sheets.
    expect(parseSpaces('jason:Jason,jason:Someone else')).toEqual([
      { id: 'jason', name: 'Jason' },
    ]);
  });

  it('drops an entry with no usable id or no name', () => {
    expect(parseSpaces('!!!,Kim')).toEqual([{ id: 'kim', name: 'Kim' }]);
    expect(parseSpaces('jason:,Kim')).toEqual([{ id: 'kim', name: 'Kim' }]);
    expect(parseSpaces('!!!')).toBeNull();
  });

  it('leaves a name alone while slugging the id', () => {
    expect(deriveSpaceId('Ann-Marie O’Neill')).toBe('ann-marie-o-neill');
    expect(deriveSpaceId('   ')).toBe('');
  });

  it('has no limit on how many people get a space', () => {
    const names = ['Ana', 'Ben', 'Cara', 'Dev', 'Eve', 'Finn', 'Gus', 'Hana'];
    expect(parseSpaces(names.join(','))).toHaveLength(names.length);
  });
});

describe('resolving a request to a space', () => {
  const spaces: Space[] = [
    { id: 'jason', name: 'Jason' },
    { id: 'kim', name: 'Kim' },
  ];

  it('takes a configured space at its word', () => {
    expect(resolveSpace(spaces, 'kim')).toBe('kim');
  });

  it('falls back to the first space for anything else', () => {
    // A cookie naming a space that has been removed from the configuration
    // must not error: it would lock that browser out of the whole app.
    expect(resolveSpace(spaces, 'nobody')).toBe('jason');
    expect(resolveSpace(spaces, undefined)).toBe('jason');
    expect(resolveSpace(spaces, 42)).toBe('jason');
    expect(resolveSpace([], 'kim')).toBe(FALLBACK_SPACE.id);
  });
});

describe('spaces the database already holds', () => {
  it('rebuilds a list from owner ids', () => {
    expect(spacesFromOwners(['jason', 'kim'])).toEqual([
      { id: 'jason', name: 'Jason' },
      { id: 'kim', name: 'Kim' },
    ]);
    expect(spacesFromOwners(['ann-marie'])).toEqual([
      { id: 'ann-marie', name: 'Ann Marie' },
    ]);
  });

  it('is null for an instance with nothing stored', () => {
    expect(spacesFromOwners([])).toBeNull();
  });

  it('names the owners no configured space covers', () => {
    const configured: Space[] = [{ id: 'jason', name: 'Jason' }];
    expect(orphanedOwners(configured, ['jason', 'kim'])).toEqual(['kim']);
    expect(orphanedOwners(configured, ['jason'])).toEqual([]);
  });
});

describe('the store guards the owner it writes into DDL', () => {
  it('refuses an id that is not a slug', () => {
    // This value reaches a DEFAULT clause, where a bound parameter is not
    // allowed, so the charset is the only thing standing between the
    // configuration and arbitrary SQL.
    expect(() => new Store(':memory:', "me'; DROP TABLE sheets; --")).toThrow(
      /Unusable space id/,
    );
    expect(() => new Store(':memory:', '')).toThrow(/Unusable space id/);
  });
});

describe('an instance with SPACES unset', () => {
  const dirs: string[] = [];
  const apps: App[] = [];

  function tempDb(): string {
    const dir = mkdtempSync(join(tmpdir(), 'webcalc-spaces-'));
    dirs.push(dir);
    return join(dir, 'webcalc.db');
  }

  function build(dbPath: string, spaces?: Space[]): App {
    const app = buildApp({
      dbPath,
      staticRoot: null,
      autoRefreshRates: false,
      seedWelcomeSheet: false,
      ...(spaces && { spaces }),
    });
    apps.push(app);
    return app;
  }

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.server.close()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('serves however many spaces are configured', async () => {
    const many = ['Ana', 'Ben', 'Cara', 'Dev', 'Eve', 'Finn'].map((name) => ({
      id: name.toLowerCase(),
      name,
    }));
    const app = build(tempDb(), many);
    const response = await app.server.inject({ url: '/api/users' });
    expect((response.json() as { users: Space[] }).users).toEqual(many);
  });

  it('is a one-person app on an empty database', async () => {
    const app = build(tempDb());
    const response = await app.server.inject({ url: '/api/users' });
    expect(response.json()).toEqual({
      users: [FALLBACK_SPACE],
      current: FALLBACK_SPACE.id,
    });
  });

  it('adopts the spaces the database is already full of', async () => {
    // The upgrade case: an instance that has been running with two people is
    // redeployed before anyone sets SPACES. Defaulting to one generic space
    // would show an empty app over a database full of sheets.
    const dbPath = tempDb();
    const configured = build(dbPath, [
      { id: 'jason', name: 'Jason' },
      { id: 'kim', name: 'Kim' },
    ]);
    for (const [owner, title] of [
      ['jason', 'Bluray sales'],
      ['kim', 'Garden plan'],
    ] as const) {
      const created = await configured.server.inject({
        method: 'POST',
        url: '/api/sheets',
        headers: { cookie: `webcalc_user=${owner}` },
        payload: { title, content: '1 + 1' },
      });
      expect(created.statusCode).toBe(201);
    }
    await configured.server.close();
    apps.splice(apps.indexOf(configured), 1);

    const reopened = build(dbPath);
    const users = await reopened.server.inject({ url: '/api/users' });
    expect(users.json()).toEqual({
      users: [
        { id: 'jason', name: 'Jason' },
        { id: 'kim', name: 'Kim' },
      ],
      current: 'jason',
    });

    // Adoption is only worth anything if the sheets come back with it.
    const sheets = await reopened.server.inject({
      url: '/api/sheets',
      headers: { cookie: 'webcalc_user=kim' },
    });
    expect(
      (sheets.json() as { sheets: Array<{ title: string }> }).sheets.map(
        (sheet) => sheet.title,
      ),
    ).toEqual(['Garden plan']);
  });

  it('adopts owner ids from a database that predates the space table', async () => {
    // The real upgrade: sheets already stamped with owners, no spaces table to
    // read, and nobody has set SPACES. Falling back to one generic space here
    // would open the app on what looks like an empty database.
    const dbPath = tempDb();
    const legacy = new Store(dbPath, 'jason');
    legacy.createSheet('jason', 'Bluray sales', '1 + 1');
    legacy.createSheet('kim', 'Garden plan', '2 + 2');
    legacy.close();

    const upgraded = build(dbPath);
    const users = await upgraded.server.inject({ url: '/api/users' });
    expect((users.json() as { users: Space[] }).users).toEqual([
      { id: 'jason', name: 'Jason' },
      { id: 'kim', name: 'Kim' },
    ]);

    const sheets = await upgraded.server.inject({
      url: '/api/sheets',
      headers: { cookie: 'webcalc_user=kim' },
    });
    expect(
      (sheets.json() as { sheets: Array<{ title: string }> }).sheets.map((s) => s.title),
    ).toEqual(['Garden plan']);
  });

  it('is a seed, so a restart does not undo a space added in the app', async () => {
    const dbPath = tempDb();
    const first = build(dbPath, [{ id: 'jason', name: 'Jason' }]);
    const added = await first.server.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { name: 'Ana' },
    });
    expect(added.statusCode).toBe(201);
    await first.server.close();
    apps.splice(apps.indexOf(first), 1);

    // Restarting with the original SPACES value must not drop Ana, or every
    // space added in the app would live only until the next deploy.
    const restarted = build(dbPath, [{ id: 'jason', name: 'Jason' }]);
    const users = await restarted.server.inject({ url: '/api/users' });
    expect((users.json() as { users: Space[] }).users).toEqual([
      { id: 'jason', name: 'Jason' },
      { id: 'ana', name: 'Ana' },
    ]);
  });
});

describe('managing spaces from the app', () => {
  let app: App;
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'webcalc-manage-'));
    dbPath = join(dir, 'webcalc.db');
    app = buildApp({
      dbPath,
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
    rmSync(dir, { recursive: true, force: true });
  });

  const listSpaces = async () =>
    (
      (await app.server.inject({ url: '/api/users' })).json() as { users: Space[] }
    ).users;

  const addSpace = (payload: unknown) =>
    app.server.inject({ method: 'POST', url: '/api/spaces', payload });

  it('adds a space, deriving its id from the name', async () => {
    const response = await addSpace({ name: 'Ann-Marie' });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: 'ann-marie', name: 'Ann-Marie' });
    expect(await listSpaces()).toHaveLength(3);
  });

  it('keeps adding past any particular number', async () => {
    for (const name of ['Ana', 'Ben', 'Cara', 'Dev', 'Eve']) {
      expect((await addSpace({ name })).statusCode).toBe(201);
    }
    expect(await listSpaces()).toHaveLength(7);
  });

  it('gives a new space its own sheets straight away', async () => {
    await addSpace({ name: 'Ana' });
    const created = await app.server.inject({
      method: 'POST',
      url: '/api/sheets',
      headers: { cookie: 'webcalc_user=ana' },
      payload: { title: 'Seedlings', content: '2 + 2' },
    });
    expect(created.statusCode).toBe(201);
    expect((created.json() as { owner: string }).owner).toBe('ana');

    const others = await app.server.inject({
      url: '/api/sheets',
      headers: { cookie: 'webcalc_user=jason' },
    });
    expect((others.json() as { sheets: unknown[] }).sheets).toEqual([]);
  });

  it('refuses a name it cannot turn into an id, and a blank one', async () => {
    expect((await addSpace({ name: '   ' })).statusCode).toBe(400);
    expect((await addSpace({ name: '!!!' })).statusCode).toBe(400);
    expect((await addSpace({})).statusCode).toBe(400);
  });

  it('refuses an id that is taken', async () => {
    const response = await addSpace({ name: 'Jason' });
    expect(response.statusCode).toBe(409);
    expect(await listSpaces()).toHaveLength(2);
  });

  it('renames without moving the sheets', async () => {
    const created = await app.server.inject({
      method: 'POST',
      url: '/api/sheets',
      headers: { cookie: 'webcalc_user=kim' },
      payload: { title: 'Garden plan', content: '1 + 1' },
    });
    expect(created.statusCode).toBe(201);

    const renamed = await app.server.inject({
      method: 'PATCH',
      url: '/api/spaces/kim',
      payload: { name: 'Kimberley' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(await listSpaces()).toEqual([
      { id: 'jason', name: 'Jason' },
      { id: 'kim', name: 'Kimberley' },
    ]);

    // The id is what every sheet is stamped with, so a rename must leave it
    // alone or it would read as a deletion.
    const sheets = await app.server.inject({
      url: '/api/sheets',
      headers: { cookie: 'webcalc_user=kim' },
    });
    expect(
      (sheets.json() as { sheets: Array<{ title: string }> }).sheets.map((s) => s.title),
    ).toEqual(['Garden plan']);
  });

  it('rejects a rename of a space that is not there, and a blank name', async () => {
    const missing = await app.server.inject({
      method: 'PATCH',
      url: '/api/spaces/nobody',
      payload: { name: 'Someone' },
    });
    expect(missing.statusCode).toBe(404);

    const blank = await app.server.inject({
      method: 'PATCH',
      url: '/api/spaces/kim',
      payload: { name: '  ' },
    });
    expect(blank.statusCode).toBe(400);
  });

  it('hides rather than deletes what a removed space owns', async () => {
    await app.server.inject({
      method: 'POST',
      url: '/api/sheets',
      headers: { cookie: 'webcalc_user=kim' },
      payload: { title: 'Garden plan', content: '1 + 1' },
    });

    const removed = await app.server.inject({
      method: 'DELETE',
      url: '/api/spaces/kim',
    });
    expect(removed.statusCode).toBe(200);
    // The count is what lets the client say "1 sheet will be hidden" rather
    // than implying the work was destroyed.
    expect(removed.json()).toEqual({ deleted: true, hidden: 1 });
    expect(await listSpaces()).toEqual([{ id: 'jason', name: 'Jason' }]);

    // Her cookie now resolves to the remaining space, and the sheet is in
    // nobody's list — but it is still in the database.
    const listed = await app.server.inject({
      url: '/api/sheets',
      headers: { cookie: 'webcalc_user=kim' },
    });
    expect((listed.json() as { sheets: unknown[] }).sheets).toEqual([]);
    expect(app.store.owners()).toContain('kim');
  });

  it('brings the sheets back when the space is added again under its id', async () => {
    await app.server.inject({
      method: 'POST',
      url: '/api/sheets',
      headers: { cookie: 'webcalc_user=kim' },
      payload: { title: 'Garden plan', content: '1 + 1' },
    });
    await app.server.inject({ method: 'DELETE', url: '/api/spaces/kim' });

    // Restoring by id rather than by name is the whole reason the id is
    // separately settable.
    const restored = await addSpace({ id: 'kim', name: 'Kimberley' });
    expect(restored.statusCode).toBe(201);

    const sheets = await app.server.inject({
      url: '/api/sheets',
      headers: { cookie: 'webcalc_user=kim' },
    });
    expect(
      (sheets.json() as { sheets: Array<{ title: string }> }).sheets.map((s) => s.title),
    ).toEqual(['Garden plan']);
  });

  it('refuses to remove the last space', async () => {
    expect(
      (await app.server.inject({ method: 'DELETE', url: '/api/spaces/kim' })).statusCode,
    ).toBe(200);
    // With none left every request would resolve to a space that is not there.
    const last = await app.server.inject({ method: 'DELETE', url: '/api/spaces/jason' });
    expect(last.statusCode).toBe(409);
    expect(await listSpaces()).toEqual([{ id: 'jason', name: 'Jason' }]);
  });

  it('reports removing a space that is not there', async () => {
    const response = await app.server.inject({
      method: 'DELETE',
      url: '/api/spaces/nobody',
    });
    expect(response.statusCode).toBe(404);
  });
});
