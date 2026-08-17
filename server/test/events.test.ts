import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { concerns, Events, frame, type LiveEvent } from '../src/events.js';
import type { RateTable } from '../src/rates.js';

const LIVE_RATES: RateTable = {
  base: 'USD',
  date: '2026-08-14',
  rates: { EUR: 0.8, GBP: 0.75 },
};

let app: App;
let base: string;

function build(overrides: Partial<Parameters<typeof buildApp>[0]> = {}): App {
  return buildApp({
    dbPath: ':memory:',
    staticRoot: null,
    autoRefreshRates: false,
    seedWelcomeSheet: false,
    rateFetcher: async () => LIVE_RATES,
    ...overrides,
  });
}

/**
 * A real socket, not `inject`.
 *
 * Fastify's injection harness collects a response and hands it over once it has
 * ended, which is exactly what a stream designed never to end will not do. The
 * whole point of the endpoint is what it sends while it is still open, so the
 * tests have to listen to one.
 */
async function listen(instance: App): Promise<string> {
  await instance.server.listen({ port: 0, host: '127.0.0.1' });
  const address = instance.server.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }
  return `http://127.0.0.1:${address.port}`;
}

/** An open event stream, and a way to wait for what it says next. */
async function openStream(url = `${base}/api/events`, init: RequestInit = {}) {
  const response = await fetch(url, {
    headers: { accept: 'text/event-stream' },
    ...init,
  });
  const body = response.body;
  if (!body) throw new Error('The event stream sent no body');
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();

  /*
   * The stream is drained by a loop of its own rather than by `next`.
   *
   * A read raced against a timeout is still a read: it stays pending when the
   * timeout wins, and then swallows the very next chunk into a promise nobody
   * is holding. Every test that waits for silence and then waits for an event
   * would lose that event — which is exactly what happened.
   */
  let buffer = '';
  const pending: LiveEvent[] = [];
  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += chunk.value;
        const records = buffer.split('\n\n');
        buffer = records.pop() ?? '';
        for (const record of records) {
          const line = record.split('\n').find((part) => part.startsWith('data: '));
          if (line) pending.push(JSON.parse(line.slice(6)) as LiveEvent);
        }
      }
    } catch {
      // Cancelled by `close`, or the server went away. Either way there is
      // nothing more to read and nothing to report.
    }
  })();

  /** The next event, or a failure if none arrives inside the timeout. */
  const next = async (timeoutMs = 4_000): Promise<LiveEvent> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ready = pending.shift();
      if (ready) return ready;
      if (Date.now() > deadline) throw new Error('Timed out waiting for an event');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  return {
    response,
    next,
    close: () => void reader.cancel().catch(() => undefined),
  };
}

async function createSheet(title = 'Test', content = '') {
  const response = await app.server.inject({
    method: 'POST',
    url: '/api/sheets',
    payload: { title, content },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; version: number; owner: string };
}

describe('the event bus', () => {
  it('scopes list events to the space they belong to', () => {
    const mine: LiveEvent = { type: 'list', owner: 'work' };
    expect(concerns({ owner: 'work' } as never, mine)).toBe(true);
    expect(concerns({ owner: 'home' } as never, mine)).toBe(false);
  });

  it('sends a sheet and its lock to every space, because links cross them', () => {
    const sheet: LiveEvent = { type: 'sheet', id: 's', owner: 'work', version: 2 };
    const lock: LiveEvent = { type: 'lock', sheetId: 's', holder: null };
    expect(concerns({ owner: 'home' } as never, sheet)).toBe(true);
    expect(concerns({ owner: 'home' } as never, lock)).toBe(true);
  });

  it('sends an instance-wide settings change to every space', () => {
    const shared: LiveEvent = { type: 'settings', owner: null };
    const mine: LiveEvent = { type: 'settings', owner: 'work' };
    expect(concerns({ owner: 'home' } as never, shared)).toBe(true);
    expect(concerns({ owner: 'home' } as never, mine)).toBe(false);
  });

  it('drops a subscriber whose socket has gone, and still tells the others', () => {
    const events = new Events();
    const heard: LiveEvent[] = [];
    events.subscribe({
      owner: 'work',
      send: () => {
        throw new Error('socket closed');
      },
      close: () => undefined,
    });
    events.subscribe({
      owner: 'work',
      send: (event) => heard.push(event),
      close: () => undefined,
    });

    events.emit({ type: 'beat' });
    expect(heard).toEqual([{ type: 'beat' }]);
    expect(events.size).toBe(1);
  });

  it('frames an event so the browser sees a complete record', () => {
    expect(frame({ type: 'beat' })).toBe('data: {"type":"beat"}\n\n');
  });
});

describe('GET /api/events', () => {
  beforeEach(async () => {
    app = build();
    base = await listen(app);
  });

  afterEach(async () => {
    await app.server.close();
  });

  it('opens as an event stream and greets with the rate date', async () => {
    const stream = await openStream();
    expect(stream.response.headers.get('content-type')).toContain('text/event-stream');
    // The header nginx reads to leave a stream unbuffered.
    expect(stream.response.headers.get('x-accel-buffering')).toBe('no');

    expect(await stream.next()).toEqual({
      type: 'hello',
      rateDate: app.rates.current().date,
    });
    stream.close();
  });

  it('announces a sheet created by another browser', async () => {
    const stream = await openStream();
    await stream.next();

    const sheet = await createSheet('Ledger');
    expect(await stream.next()).toEqual({ type: 'list', owner: sheet.owner });
    stream.close();
  });

  it('announces an edit with the version it produced', async () => {
    const sheet = await createSheet('Ledger');
    const stream = await openStream();
    await stream.next();

    await app.server.inject({
      method: 'PUT',
      url: `/api/sheets/${sheet.id}`,
      payload: { content: '2 + 2', version: sheet.version },
    });

    expect(await stream.next()).toEqual({
      type: 'sheet',
      id: sheet.id,
      owner: sheet.owner,
      version: sheet.version + 1,
    });
    expect(await stream.next()).toEqual({ type: 'list', owner: sheet.owner });
    stream.close();
  });

  it('names the browser that took the lock, and says when it is let go', async () => {
    const sheet = await createSheet('Ledger');
    const stream = await openStream();
    await stream.next();

    await app.server.inject({
      method: 'POST',
      url: `/api/sheets/${sheet.id}/lock`,
      payload: { clientId: 'other-tab', clientName: 'Work' },
    });
    expect(await stream.next()).toMatchObject({
      type: 'lock',
      sheetId: sheet.id,
      holder: { clientId: 'other-tab', clientName: 'Work' },
    });

    await app.server.inject({
      method: 'DELETE',
      url: `/api/sheets/${sheet.id}/lock?clientId=other-tab`,
    });
    expect(await stream.next()).toEqual({
      type: 'lock',
      sheetId: sheet.id,
      holder: null,
    });
    stream.close();
  });

  it('stays quiet while the holder is only renewing its lock', async () => {
    const sheet = await createSheet('Ledger');
    const stream = await openStream();
    await stream.next();

    for (let beat = 0; beat < 3; beat++) {
      await app.server.inject({
        method: 'POST',
        url: `/api/sheets/${sheet.id}/lock`,
        payload: { clientId: 'other-tab', clientName: 'Work' },
      });
    }

    // One handover, then silence — a heartbeat is not news.
    expect(await stream.next()).toMatchObject({ type: 'lock' });
    await expect(stream.next(300)).rejects.toThrow(/Timed out/);
    stream.close();
  });

  it('announces a rate table that moved, and not one that did not', async () => {
    const stream = await openStream();
    await stream.next();

    await app.rates.refresh();
    expect(await stream.next()).toEqual({
      type: 'rates',
      date: LIVE_RATES.date,
      stale: false,
    });

    // The same table again is not a change anyone can act on.
    await app.rates.refresh();
    await expect(stream.next(300)).rejects.toThrow(/Timed out/);
    stream.close();
  });

  it('announces rates going stale when a refresh fails', async () => {
    await app.server.close();
    let online = true;
    app = build({
      rateFetcher: async () => {
        if (!online) throw new Error('offline');
        return LIVE_RATES;
      },
    });
    base = await listen(app);

    await app.rates.refresh();
    const stream = await openStream();
    await stream.next();

    online = false;
    await app.rates.refresh();

    expect(await stream.next()).toEqual({
      type: 'rates',
      date: LIVE_RATES.date,
      stale: true,
    });
    stream.close();
  });

  it('keeps an idle stream alive with a beat', async () => {
    await app.server.close();
    app = build({ eventHeartbeatMs: 60 });
    base = await listen(app);

    const stream = await openStream();
    expect(await stream.next()).toMatchObject({ type: 'hello' });
    expect(await stream.next()).toEqual({ type: 'beat' });
    stream.close();
  });

  it('does not send one space its neighbour’s list changes', async () => {
    await app.server.close();
    app = build({
      spaces: [
        { id: 'work', name: 'Work' },
        { id: 'home', name: 'Home' },
      ],
    });
    base = await listen(app);

    const stream = await openStream(`${base}/api/events`, {
      headers: { accept: 'text/event-stream', cookie: 'webcalc_user=home' },
    });
    await stream.next();

    await app.server.inject({
      method: 'POST',
      url: '/api/sheets',
      headers: { cookie: 'webcalc_user=work' },
      payload: { title: 'Work sheet' },
    });
    await expect(stream.next(300)).rejects.toThrow(/Timed out/);

    // ...but its own space still reaches it.
    await app.server.inject({
      method: 'POST',
      url: '/api/sheets',
      headers: { cookie: 'webcalc_user=home' },
      payload: { title: 'Home sheet' },
    });
    expect(await stream.next()).toEqual({ type: 'list', owner: 'home' });
    stream.close();
  });

  it('needs the password on an instance that has one', async () => {
    await app.server.close();
    app = build({ password: 'secret' });
    base = await listen(app);

    const response = await fetch(`${base}/api/events`);
    expect(response.status).toBe(401);
    await response.body?.cancel();
  });

  it('lets go of its subscribers when the server stops', async () => {
    const stream = await openStream();
    await stream.next();
    expect(app.events.size).toBe(1);

    // The real assertion is that this resolves at all: a stream nobody ended
    // would hold the shutdown open until the test runner gave up.
    await app.server.close();
    expect(app.events.size).toBe(0);

    app = build();
    base = await listen(app);
  });
});
