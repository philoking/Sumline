import { describe, expect, it } from 'vitest';
import { parseLiveEvent } from '../src/live';

describe('parseLiveEvent', () => {
  it('reads each kind the server sends', () => {
    expect(parseLiveEvent('{"type":"beat"}')).toEqual({ type: 'beat' });
    expect(parseLiveEvent('{"type":"hello","rateDate":"2026-08-14"}')).toEqual({
      type: 'hello',
      rateDate: '2026-08-14',
    });
    expect(parseLiveEvent('{"type":"list","owner":"work"}')).toEqual({
      type: 'list',
      owner: 'work',
    });
    expect(
      parseLiveEvent('{"type":"sheet","id":"s1","owner":"work","version":4}'),
    ).toEqual({ type: 'sheet', id: 's1', owner: 'work', version: 4 });
    expect(parseLiveEvent('{"type":"rates","date":"2026-08-14","stale":true}')).toEqual({
      type: 'rates',
      date: '2026-08-14',
      stale: true,
    });
  });

  it('keeps a null owner on a settings change, because that tier is everyone’s', () => {
    expect(parseLiveEvent('{"type":"settings","owner":null}')).toEqual({
      type: 'settings',
      owner: null,
    });
    expect(parseLiveEvent('{"type":"settings","owner":"home"}')).toEqual({
      type: 'settings',
      owner: 'home',
    });
    // Neither a space nor "everyone" — there is nothing sound to do with it.
    expect(parseLiveEvent('{"type":"settings","owner":7}')).toBeNull();
  });

  it('carries the lock holder through, and reads anything else as nobody', () => {
    const held = parseLiveEvent(
      '{"type":"lock","sheetId":"s1","holder":' +
        '{"sheetId":"s1","clientId":"c1","clientName":"Work","expiresAt":10}}',
    );
    expect(held).toMatchObject({ holder: { clientId: 'c1', clientName: 'Work' } });

    // Nobody editing is the case that clears the read-only banner, so a holder
    // that is null, malformed or absent all have to mean the same thing.
    for (const payload of [
      '{"type":"lock","sheetId":"s1","holder":null}',
      '{"type":"lock","sheetId":"s1","holder":"c1"}',
      '{"type":"lock","sheetId":"s1","holder":{}}',
      '{"type":"lock","sheetId":"s1"}',
    ]) {
      expect(parseLiveEvent(payload)).toEqual({
        type: 'lock',
        sheetId: 's1',
        holder: null,
      });
    }
  });

  it('ignores anything it cannot trust rather than throwing', () => {
    // A server one deploy ahead: unknown, so left alone rather than fatal.
    expect(parseLiveEvent('{"type":"presence","who":"someone"}')).toBeNull();
    // Known kinds missing the field the caller would act on.
    expect(parseLiveEvent('{"type":"list"}')).toBeNull();
    expect(parseLiveEvent('{"type":"sheet","id":"s1","owner":"work"}')).toBeNull();
    expect(parseLiveEvent('{"type":"lock"}')).toBeNull();
    // Not JSON, not an object, nothing at all.
    expect(parseLiveEvent('not json')).toBeNull();
    expect(parseLiveEvent('null')).toBeNull();
    expect(parseLiveEvent('[1,2]')).toBeNull();
    expect(parseLiveEvent('')).toBeNull();
  });
});
