import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/index.js';

/**
 * A sheet that resolves somewhere in particular.
 *
 * Evaluation runs in the browser, so by default "here" is wherever the reader
 * is — which is right nearly always, and stays the default. A space sets a zone
 * when its sheets should resolve in one place no matter who opens them.
 *
 * The instant below is deliberately chosen to fall on different *days* in
 * different zones: 23:30 UTC is still the 17th in Los Angeles and already the
 * 18th in Tokyo. Anything that merely shifted hours would pass a weaker test.
 */
const NOW = new Date(Date.UTC(2026, 7, 17, 23, 30, 0));

function answer(line: string, zone?: string): string {
  const engine = createEngine({ now: NOW, ...(zone && { zone }) });
  return engine.evaluate(line)[0]?.output ?? '';
}

describe('with no zone set', () => {
  it('resolves in the reader’s own zone, as it always has', () => {
    // The guarantee that keeps every other test in this suite meaningful: an
    // instance that sets no zone behaves exactly as it did before zones existed.
    const without = createEngine({ now: NOW });
    const asBefore = createEngine({ now: NOW, zone: undefined });
    for (const line of ['today', 'now', 'tomorrow', 'week of year', 'current timestamp']) {
      expect(without.evaluate(line)[0]?.output).toBe(asBefore.evaluate(line)[0]?.output);
    }
  });

  it('falls back to the reader’s zone when the name means nothing', () => {
    expect(answer('today', 'nonsense-zone')).toBe(answer('today'));
  });
});

describe('with a zone set', () => {
  it('resolves the date in that zone, not the reader’s', () => {
    expect(answer('today', 'America/Los_Angeles')).toBe('Mon 17 Aug 2026');
    expect(answer('today', 'Asia/Tokyo')).toBe('Tue 18 Aug 2026');
  });

  it('resolves the clock in that zone', () => {
    expect(answer('now', 'America/Los_Angeles')).toBe('Mon 17 Aug 2026 at 4:30 pm');
    expect(answer('now', 'Asia/Tokyo')).toBe('Tue 18 Aug 2026 at 8:30 am');
    expect(answer('now', 'Europe/Berlin')).toBe('Tue 18 Aug 2026 at 1:30 am');
  });

  it('carries the zone into everything anchored on today', () => {
    expect(answer('tomorrow', 'Asia/Tokyo')).toBe('Wed 19 Aug 2026');
    expect(answer('yesterday', 'Asia/Tokyo')).toBe('Mon 17 Aug 2026');
    expect(answer('today + 5 business days', 'Asia/Tokyo')).toBe('Tue 25 Aug 2026');
    expect(answer('today + 5 business days', 'America/Los_Angeles')).toBe('Mon 24 Aug 2026');
  });

  it('takes a place name as readily as an IANA identifier', () => {
    // Nobody writes Europe/Berlin in a sheet, but somebody configuring a space
    // reaches for exactly that — so both have to work.
    expect(answer('now', 'Berlin')).toBe(answer('now', 'Europe/Berlin'));
    expect(answer('now', 'Tokyo')).toBe(answer('now', 'Asia/Tokyo'));
  });
});

describe('what a zone must never move', () => {
  it('leaves the timestamp of this instant alone', () => {
    // The correctness risk of the whole design. Dates reason in wall-clock
    // space, but a timestamp is an absolute instant and must not be shifted
    // with them.
    const epoch = String(Math.round(NOW.getTime() / 1000));
    const expected = Number(epoch).toLocaleString('en-US');
    for (const zone of [undefined, 'America/Los_Angeles', 'Asia/Tokyo', 'Europe/Berlin']) {
      expect(answer('current timestamp', zone)).toBe(expected);
    }
  });

  it('converts a date to the instant that date begins in that zone', () => {
    // Midnight on 18 August is a different moment in Tokyo than in LA, and the
    // answer has to be the one the sheet's zone means.
    expect(answer('2026-08-18 to timestamp', 'Asia/Tokyo')).toBe(
      (Date.UTC(2026, 7, 17, 15, 0, 0) / 1000).toLocaleString('en-US'),
    );
    expect(answer('2026-08-18 to timestamp', 'America/Los_Angeles')).toBe(
      (Date.UTC(2026, 7, 18, 7, 0, 0) / 1000).toLocaleString('en-US'),
    );
  });

  it('writes the offset of the sheet’s zone, not the reader’s', () => {
    expect(answer('April 1, 2019 3:30pm as iso8601', 'Asia/Tokyo')).toBe(
      '2019-04-01T15:30:00+09:00',
    );
    expect(answer('April 1, 2019 3:30pm as iso8601', 'Europe/Berlin')).toBe(
      '2019-04-01T15:30:00+02:00',
    );
  });

  it('renders a timestamp as the sheet’s zone shows it', () => {
    expect(answer('1787009400 to date', 'Asia/Tokyo')).toBe('18 Aug 2026 at 8:30 am');
    expect(answer('1787009400 to date', 'America/Los_Angeles')).toBe(
      '17 Aug 2026 at 4:30 pm',
    );
  });

  it('leaves a zone named in the line alone', () => {
    // An explicit zone is an instruction, and a space setting must not override
    // it — `6pm Sydney in Chicago` means the same thing from anywhere.
    for (const zone of [undefined, 'Asia/Tokyo', 'America/Los_Angeles']) {
      expect(answer('6pm Sydney in Chicago', zone)).toBe('3:00 am');
      expect(answer('time difference between Seattle and Moscow', zone)).toBe('10 hours');
    }
  });

  it('leaves a written-out date where it was written', () => {
    // A calendar date names a day, not an instant, so no zone moves it.
    for (const zone of [undefined, 'Asia/Tokyo', 'Pacific/Kiritimati']) {
      expect(answer('April 1, 2019 - 3 months 5 days', zone)).toBe('Thu 27 Dec 2018');
      expect(answer('3 March to 30 May', zone)).toBe('2 months 3 weeks 6 days');
    }
  });
});
