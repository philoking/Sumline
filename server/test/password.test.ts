import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  issueToken,
  tokenIsValid,
} from '../src/session.js';

let app: App | null = null;

function build(password?: string): App {
  app = buildApp({
    dbPath: ':memory:',
    staticRoot: null,
    autoRefreshRates: false,
    seedWelcomeSheet: false,
    rateFetcher: async () => ({ base: 'USD', date: '2026-08-14', rates: { EUR: 0.8 } }),
    holidayFetcher: async () => [],
    ...(password !== undefined && { password }),
  });
  return app;
}

/** The session cookie from a `set-cookie` header, ready to send back. */
function cookieFrom(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
  return raw.split(';')[0] ?? '';
}

afterEach(async () => {
  await app?.server.close();
  app = null;
});

describe('with no password configured', () => {
  it('leaves every route open, exactly as before', async () => {
    const { server } = build();
    for (const url of ['/api/sheets', '/api/settings', '/api/users', '/api/folders']) {
      expect((await server.inject({ url })).statusCode).toBe(200);
    }
  });

  it('reports that no password is required', async () => {
    const { server } = build();
    expect((await server.inject({ url: '/api/session' })).json()).toEqual({
      required: false,
      authenticated: true,
    });
  });

  it('treats a blank password as no password at all', async () => {
    // An empty WEBCALC_PASSWORD= left in a compose file must not lock everyone
    // out behind a password nobody can type.
    const { server } = build('   ');
    expect((await server.inject({ url: '/api/sheets' })).statusCode).toBe(200);
    expect((await server.inject({ url: '/api/session' })).json()).toMatchObject({
      required: false,
    });
  });
});

describe('with a password configured', () => {
  it('refuses every API route until the password is given', async () => {
    // Deliberately exhaustive, and it includes routes declared *above* the hook
    // in `app.ts` — `/api/rates` and `/api/holidays` among them. Fastify applies
    // an `onRequest` hook to the whole context rather than to whatever follows
    // it, and this is what keeps that true if the file is ever reordered or a
    // route is added near the top.
    const { server } = build('open sesame');
    for (const url of [
      '/api/rates',
      '/api/rates?on=2020-01-01',
      '/api/holidays',
      '/api/users',
      '/api/spaces',
      '/api/settings',
      '/api/folders',
      '/api/sheets',
      '/api/trash',
    ]) {
      expect((await server.inject({ url })).statusCode, url).toBe(401);
    }
  });

  it('refuses to write instance-wide globals, which is the point of it', async () => {
    // `PUT /api/settings/shared` is deliberately not scoped to a space, so it is
    // the one route where anyone reaching the port could change what every sheet
    // on the instance computes.
    const { server } = build('open sesame');
    const response = await server.inject({
      method: 'PUT',
      url: '/api/settings/shared',
      payload: { globals: { vat: '20%' } },
    });
    expect(response.statusCode).toBe(401);
  });

  it('leaves the health check open, so the deploy gate still works', async () => {
    // The workflow polls /api/health to decide whether the container serves. A
    // health check needing a credential would fail every healthy deploy.
    const { server } = build('open sesame');
    const response = await server.inject({ url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('leaves non-API paths open, since the UI must load to ask', async () => {
    const { server } = build('open sesame');
    // No static root in tests, so the shell 404s rather than being served — the
    // point is that it is not a 401.
    expect((await server.inject({ url: '/' })).statusCode).not.toBe(401);
  });

  it('says a password is required without one being given', async () => {
    const { server } = build('open sesame');
    expect((await server.inject({ url: '/api/session' })).json()).toEqual({
      required: true,
      authenticated: false,
    });
  });

  it('rejects the wrong password and sets no cookie', async () => {
    const { server } = build('open sesame');
    const response = await server.inject({
      method: 'POST',
      url: '/api/session',
      payload: { password: 'guess' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a missing or non-string password', async () => {
    const { server } = build('open sesame');
    for (const payload of [{}, { password: null }, { password: 42 }, { password: '' }]) {
      const response = await server.inject({
        method: 'POST',
        url: '/api/session',
        payload,
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it('opens the API once the password is accepted', async () => {
    const { server } = build('open sesame');
    const signIn = await server.inject({
      method: 'POST',
      url: '/api/session',
      payload: { password: 'open sesame' },
    });
    expect(signIn.statusCode).toBe(200);

    const cookie = cookieFrom(signIn.headers['set-cookie']);
    expect(cookie).toContain(SESSION_COOKIE);

    const sheets = await server.inject({ url: '/api/sheets', headers: { cookie } });
    expect(sheets.statusCode).toBe(200);
  });

  it('keeps the cookie out of reach of scripts and cross-site requests', async () => {
    const { server } = build('open sesame');
    const signIn = await server.inject({
      method: 'POST',
      url: '/api/session',
      payload: { password: 'open sesame' },
    });
    const raw = signIn.headers['set-cookie'];
    const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    // Deliberately absent: a self-hosted instance is commonly plain HTTP, where
    // Secure would make signing in impossible.
    expect(header).not.toContain('Secure');
  });

  it('refuses a forged cookie', async () => {
    const { server } = build('open sesame');
    for (const value of ['nonsense', `${Date.now()}.deadbeef`, '.', 'abc.def']) {
      const response = await server.inject({
        url: '/api/sheets',
        headers: { cookie: `${SESSION_COOKIE}=${value}` },
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it('refuses a cookie signed with a different password', async () => {
    const { server } = build('open sesame');
    const response = await server.inject({
      url: '/api/sheets',
      headers: { cookie: `${SESSION_COOKIE}=${issueToken('something else')}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('clears the cookie on sign out', async () => {
    const { server } = build('open sesame');
    const response = await server.inject({ method: 'DELETE', url: '/api/session' });
    const raw = response.headers['set-cookie'];
    const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
    expect(header).toContain('Max-Age=0');
    expect(response.json()).toEqual({ required: true, authenticated: false });
  });
});

describe('the session token itself', () => {
  const password = 'open sesame';

  it('accepts one it just issued', () => {
    expect(tokenIsValid(password, issueToken(password))).toBe(true);
  });

  it('expires one that has aged out', () => {
    const issued = 1_000_000_000_000;
    const token = issueToken(password, issued);
    const justInside = issued + SESSION_MAX_AGE_SECONDS * 1000;
    expect(tokenIsValid(password, token, justInside)).toBe(true);
    expect(tokenIsValid(password, token, justInside + 1)).toBe(false);
  });

  it('refuses one issued in the future, which is a clock that moved', () => {
    const token = issueToken(password, 2_000_000_000_000);
    expect(tokenIsValid(password, token, 1_000_000_000_000)).toBe(false);
  });

  it('is invalidated by changing the password', () => {
    // The password is the signing key, so every outstanding session dies with
    // it — which is the behaviour you want from the only credential there is.
    const token = issueToken(password);
    expect(tokenIsValid('a new password', token)).toBe(false);
  });

  it('refuses nothing at all', () => {
    expect(tokenIsValid(password, undefined)).toBe(false);
    expect(tokenIsValid(password, '')).toBe(false);
  });
});
