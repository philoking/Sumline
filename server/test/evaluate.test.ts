import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import type { RateTable } from '../src/rates.js';

/**
 * `POST /api/evaluate` — the engine, answering in a space.
 *
 * What is worth testing here is not the arithmetic, which the engine's own
 * suite covers several hundred times over. It is that the answer arrives out of
 * the *caller's space*: the same globals, the same region, the same zone the
 * sheets in that space compute with. An endpoint that evaluated correctly but
 * in nobody's space would be the failure this exists to prevent — a launcher
 * and a sheet disagreeing about what `day rate` means.
 */

const LIVE_RATES: RateTable = {
  base: 'USD',
  date: '2026-08-14',
  rates: { EUR: 0.8, GBP: 0.75 },
};

const PAST_RATES: RateTable = {
  base: 'USD',
  date: '2020-01-01',
  rates: { EUR: 0.9, GBP: 0.8 },
};

let app: App;
let historicalCalls: string[];

beforeEach(() => {
  historicalCalls = [];
  app = buildApp({
    dbPath: ':memory:',
    staticRoot: null,
    autoRefreshRates: false,
    seedWelcomeSheet: false,
    spaces: [
      { id: 'consulting', name: 'Consulting' },
      { id: 'teaching', name: 'Teaching' },
    ],
    rateFetcher: async (_base: string, on?: string) => {
      if (on === undefined) return LIVE_RATES;
      historicalCalls.push(on);
      if (on !== '2020-01-01') throw new Error(`no rates for ${on}`);
      return PAST_RATES;
    },
  });
});

afterEach(async () => {
  await app.server.close();
});

const as = (space: string) => ({ cookie: `webcalc_user=${space}` });

interface EvaluateResponse {
  results: Array<{ index: number; kind: string; input: string; output: string; error?: string }>;
  total: string;
  rateDate: string | null;
}

async function evaluate(
  input: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: EvaluateResponse }> {
  const response = await app.server.inject({
    method: 'POST',
    url: '/api/evaluate',
    payload: { input },
    headers,
  });
  return { status: response.statusCode, body: response.json() as EvaluateResponse };
}

async function putSettings(space: string, body: Record<string, unknown>) {
  const response = await app.server.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: body,
    headers: as(space),
  });
  expect(response.statusCode).toBe(200);
}

describe('evaluating a line', () => {
  it('answers a single expression', async () => {
    const { status, body } = await evaluate('2 + 2 * 10');
    expect(status).toBe(200);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ index: 0, kind: 'expression', output: '22' });
  });

  it('answers a whole sheet, line by line, and totals it', async () => {
    const { body } = await evaluate('day rate = 550\nday rate * 3\n// a note');
    expect(body.results.map((line) => line.output)).toEqual(['550', '1,650', '']);
    expect(body.results.map((line) => line.kind)).toEqual([
      'assignment',
      'expression',
      'comment',
    ]);
    expect(body.total).toBe('2,200');
  });

  it('takes an array of lines as readily as one string', async () => {
    const { body } = await evaluate(['10', '20', 'sum']);
    expect(body.results.map((line) => line.output)).toEqual(['10', '20', '30']);
  });

  it('echoes each line back beside its answer', async () => {
    // A CLI printing `input = output` should not have to keep its own copy of
    // what it sent, and a caller reading results out of order should not have
    // to index back into the request.
    const { body } = await evaluate('5 km in miles');
    expect(body.results[0]?.input).toBe('5 km in miles');
  });

  it('reports a bad line as an error on that line, not a failed request', async () => {
    const { status, body } = await evaluate('1 + 1\n10 USD in XYZ');
    expect(status).toBe(200);
    expect(body.results[0]?.output).toBe('2');
    expect(body.results[1]?.error).toBe('No unit or currency called XYZ');
  });
});

describe('evaluating in a space', () => {
  it('resolves the caller’s own globals', async () => {
    await putSettings('consulting', { globals: { 'day rate': '$550' } });
    await putSettings('teaching', { globals: { 'day rate': '$120' } });

    const consulting = await evaluate('day rate * 3', as('consulting'));
    const teaching = await evaluate('day rate * 3', as('teaching'));

    expect(consulting.body.results[0]?.output).toBe('$1,650.00');
    expect(teaching.body.results[0]?.output).toBe('$360.00');
  });

  it('inherits an instance-wide global the space has not overridden', async () => {
    await app.server.inject({
      method: 'PUT',
      url: '/api/settings/shared',
      payload: { globals: { mileage: '$0.68' } },
    });
    const { body } = await evaluate('mileage * 120', as('teaching'));
    expect(body.results[0]?.output).toBe('$81.60');
  });

  it('reads numbers by the space’s own region', async () => {
    // The half that makes the region more than a display preference: the same
    // line means a different number, so a launcher that ignored it would answer
    // confidently wrong rather than visibly odd.
    await putSettings('teaching', { region: 'western-europe' });
    const teaching = await evaluate('1.234 + 1', as('teaching'));
    const consulting = await evaluate('1.234 + 1', as('consulting'));
    expect(teaching.body.results[0]?.output).toBe('1.235');
    expect(consulting.body.results[0]?.output).toBe('2.234');
  });

  it('honours the space’s precision and separators', async () => {
    await putSettings('consulting', { precision: 2, thousandsSeparators: false });
    const { body } = await evaluate('10000 / 3', as('consulting'));
    expect(body.results[0]?.output).toBe('3333.33');
  });

  it('resolves dates in the zone the space pinned', async () => {
    // `zone` is the option this whole boundary dropped for as long as it
    // existed, in the layer above; it must not be dropped again down here.
    // Two zones twenty-five hours apart, so `today` cannot be the same date in
    // both at any instant — which makes this assert about the setting rather
    // than about when the suite happens to run.
    await putSettings('consulting', { zone: 'Pacific/Kiritimati' });
    await putSettings('teaching', { zone: 'Pacific/Niue' });
    const ahead = await evaluate('today', as('consulting'));
    const behind = await evaluate('today', as('teaching'));
    expect(ahead.body.results[0]?.output).toBeTruthy();
    expect(ahead.body.results[0]?.output).not.toBe(behind.body.results[0]?.output);
  });
});

describe('rates, current and past', () => {
  it('converts with the rates the instance is serving', async () => {
    await app.rates.refresh();
    const { body } = await evaluate('100 USD in EUR');
    expect(body.results[0]?.output).toBe('€80.00');
    expect(body.rateDate).toBe('2026-08-14');
  });

  it('fetches the past rates a line asks for, in the one call', async () => {
    // The thing a browser cannot do: the engine is synchronous, so a client has
    // to ask, be told which dates are wanted, fetch them and ask again. Here
    // that round trip happens on this side of the wire.
    const { body } = await evaluate('100 USD in EUR on 2020-01-01');
    expect(historicalCalls).toContain('2020-01-01');
    expect(body.results[0]?.output).toBe('€90.00');
  });

  it('asks for nothing when no line mentions a past date', async () => {
    await evaluate('2 + 2');
    expect(historicalCalls).toEqual([]);
  });
});

describe('what it refuses', () => {
  it('refuses a body with no input', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: '/api/evaluate',
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an input that is not text', async () => {
    for (const input of [42, null, { line: '1 + 1' }, ['fine', 7]]) {
      const response = await app.server.inject({
        method: 'POST',
        url: '/api/evaluate',
        payload: { input },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('refuses a sheet long enough to hold the process up', async () => {
    // Synchronous evaluation in a single-process server: a caller that pipes a
    // log file in by accident would otherwise stall every other request.
    const response = await app.server.inject({
      method: 'POST',
      url: '/api/evaluate',
      payload: { input: Array.from({ length: 1_001 }, () => '1 + 1') },
    });
    expect(response.statusCode).toBe(413);
  });

  it('accepts a sheet right up to the limit', async () => {
    const { status } = await evaluate(Array.from({ length: 1_000 }, () => '1 + 1'));
    expect(status).toBe(200);
  });
});

describe('the password, when one is set', () => {
  it('refuses an unauthenticated call, as it does for every other space read', async () => {
    // The endpoint reads a space's globals, so it is exactly as sensitive as
    // `/api/settings` and must not be an unguarded way around it.
    const guarded = buildApp({
      dbPath: ':memory:',
      staticRoot: null,
      autoRefreshRates: false,
      seedWelcomeSheet: false,
      password: 'hunter2',
    });
    const response = await guarded.server.inject({
      method: 'POST',
      url: '/api/evaluate',
      payload: { input: '1 + 1' },
    });
    expect(response.statusCode).toBe(401);
    await guarded.server.close();
  });
});
