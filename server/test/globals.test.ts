import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';

let app: App;

beforeEach(() => {
  app = buildApp({
    dbPath: ':memory:',
    staticRoot: null,
    autoRefreshRates: false,
    seedWelcomeSheet: false,
    spaces: [
      { id: 'consulting', name: 'Consulting' },
      { id: 'teaching', name: 'Teaching' },
    ],
  });
});

afterEach(async () => {
  await app.server.close();
});

const as = (user: string) => ({ cookie: `webcalc_user=${user}` });

interface SettingsView {
  globals?: Record<string, string>;
  sharedGlobals: Record<string, string>;
  effectiveGlobals: Record<string, string>;
  statistic?: string;
}

const settings = async (owner: string) =>
  (await app.server.inject({ url: '/api/settings', headers: as(owner) })).json() as
    SettingsView;

const setSpaceGlobals = (owner: string, globals: Record<string, string>) =>
  app.server.inject({
    method: 'PUT',
    url: '/api/settings',
    headers: as(owner),
    payload: { globals },
  });

const setShared = (globals: unknown) =>
  app.server.inject({
    method: 'PUT',
    url: '/api/settings/shared',
    payload: { globals },
  });

describe('globals that apply everywhere', () => {
  it('reach a space that has none of its own', async () => {
    expect((await setShared({ vat: '20%' })).statusCode).toBe(200);

    for (const space of ['consulting', 'teaching']) {
      const view = await settings(space);
      expect(view.sharedGlobals).toEqual({ vat: '20%' });
      expect(view.effectiveGlobals).toEqual({ vat: '20%' });
      // Still not the space's own — that distinction is what lets the panel
      // show an inherited value as inherited.
      expect(view.globals).toBeUndefined();
    }
  });

  it('are not scoped by the space cookie', async () => {
    // Set with no cookie at all, which for /api/settings would have meant the
    // first space. The shared tier is deliberately not per space.
    await setShared({ mileage: '$0.68/mile' });
    expect((await settings('teaching')).sharedGlobals).toEqual({
      mileage: '$0.68/mile',
    });
  });

  it('are replaced wholesale, like the per-space set', async () => {
    await setShared({ vat: '20%', mileage: '$0.68/mile' });
    await setShared({ vat: '15%' });
    expect((await settings('consulting')).sharedGlobals).toEqual({ vat: '15%' });
  });

  it('refuse a body that is not an object of strings', async () => {
    for (const bad of [undefined, null, 'vat=20%', 42, ['vat']]) {
      const response = await setShared(bad);
      expect(response.statusCode, `should reject ${JSON.stringify(bad)}`).toBe(400);
    }
    // Non-string values inside are dropped rather than rejecting the lot.
    await setShared({ vat: '20%', broken: 5, '': 'x' });
    expect((await settings('consulting')).sharedGlobals).toEqual({ vat: '20%' });
  });
});

describe('precedence between the two scopes', () => {
  it('lets a space displace a shared value by name', async () => {
    await setShared({ vat: '20%', mileage: '$0.68/mile' });
    await setSpaceGlobals('teaching', { vat: '0%' });

    const teaching = await settings('teaching');
    // The one it overrode takes the space's value; the one it did not is
    // inherited untouched.
    expect(teaching.effectiveGlobals).toEqual({ vat: '0%', mileage: '$0.68/mile' });
    expect(teaching.globals).toEqual({ vat: '0%' });
    expect(teaching.sharedGlobals).toEqual({ vat: '20%', mileage: '$0.68/mile' });

    // The other space is untouched by the override.
    expect((await settings('consulting')).effectiveGlobals).toEqual({
      vat: '20%',
      mileage: '$0.68/mile',
    });
  });

  it('follows a change to the shared value where it is not overridden', async () => {
    await setShared({ vat: '20%' });
    await setSpaceGlobals('teaching', { 'day rate': '$120' });

    await setShared({ vat: '15%' });
    const teaching = await settings('teaching');
    expect(teaching.effectiveGlobals).toEqual({ vat: '15%', 'day rate': '$120' });
  });

  it('stops following once the space overrides it', async () => {
    await setShared({ vat: '20%' });
    await setSpaceGlobals('consulting', { vat: '20%' });
    await setShared({ vat: '15%' });

    // Deliberate: an override is a decision, not a copy that tracks its source.
    expect((await settings('consulting')).effectiveGlobals).toEqual({ vat: '20%' });
    expect((await settings('teaching')).effectiveGlobals).toEqual({ vat: '15%' });
  });
});

describe('the derived fields are read-only', () => {
  it('ignores them on the way in', async () => {
    await setShared({ vat: '20%' });

    // Exactly what a careless client would do: read the settings, send them
    // back. If these were stored, every inherited value would silently become
    // one of the space's own and would stop tracking the shared tier.
    const view = await settings('teaching');
    const echoed = await app.server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: as('teaching'),
      payload: view,
    });
    expect(echoed.statusCode).toBe(200);

    const after = await settings('teaching');
    expect(after.globals).toBeUndefined();
    expect(after.effectiveGlobals).toEqual({ vat: '20%' });

    // Proof it is still inherited rather than copied: change the shared value
    // and the space follows it.
    await setShared({ vat: '5%' });
    expect((await settings('teaching')).effectiveGlobals).toEqual({ vat: '5%' });
  });

  it('leaves other settings alone when saving globals', async () => {
    await app.server.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: as('consulting'),
      payload: { statistic: 'median' },
    });
    await setSpaceGlobals('consulting', { vat: '5%' });

    const view = await settings('consulting');
    expect(view.statistic).toBe('median');
    expect(view.globals).toEqual({ vat: '5%' });
  });
});

describe('the vestigial pre-spaces settings table', () => {
  it('is not where shared globals live', async () => {
    // Writing shared globals into `settings` would have them adopted as the
    // first space's own by the pre-spaces migration. They must be somewhere
    // that migration never reads.
    await setShared({ vat: '20%' });
    const consulting = await settings('consulting');
    expect(consulting.globals).toBeUndefined();
    expect(consulting.sharedGlobals).toEqual({ vat: '20%' });
  });
});
