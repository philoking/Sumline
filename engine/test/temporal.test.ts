import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/index.js';
import { TEST_NOW, TEST_RATES } from './helpers.js';

// Every case is relative to TEST_NOW: Saturday 15 August 2026, 12:00 local.
const engine = createEngine({
  rates: TEST_RATES,
  now: TEST_NOW,
  // Christmas 2026 falls on a Friday, which the workday cases rely on.
  holidays: ['2026-12-25', '2026-01-01', '2026-07-03', '2026-05-25'],
});

function answer(line: string): string {
  return engine.evaluate(line)[0]?.output ?? '';
}

function table(name: string, cases: Array<[string, string]>): void {
  describe(name, () => {
    for (const [input, expected] of cases) {
      it(`${input} -> ${expected}`, () => {
        expect(answer(input)).toBe(expected);
      });
    }
  });
}

// Issue #14 — calendar phrasing
table('calendar offsets', [
  ['today + 3 weeks', 'Sat 5 Sep 2026'],
  ['today - 10 days', 'Wed 5 Aug 2026'],
  ['2026-01-31 + 1 month', 'Sat 28 Feb 2026'],
  ['2026-01-01 + 1 year', 'Fri 1 Jan 2027'],
  ['April 1, 2019 - 3 months 5 days', 'Thu 27 Dec 2018'],
  ['01.05.2005 + 3 years 2 months 3 weeks', 'Tue 22 Jul 2008'],
  ['3 weeks after March 14, 2019', 'Thu 4 Apr 2019'],
  ['28 days before March 12', 'Thu 12 Feb 2026'],
  ['2 months 3 days after June 5', 'Sat 8 Aug 2026'],
  ['4 days from now', 'Wed 19 Aug 2026'],
  ['3 days ago', 'Wed 12 Aug 2026'],
  ['next friday', 'Fri 21 Aug 2026'],
  ['last monday', 'Mon 10 Aug 2026'],
]);

table('calendar intervals', [
  ['January 10 - February 5', '3 weeks 5 days'],
  ['3 March to 30 May', '2 months 3 weeks 6 days'],
  ['days between 3 March and 30 May', '88 days'],
  ['2026-01-01 to 2026-12-25', '11 months 3 weeks 3 days'],
  ['April 1 through April 30 in days', '30 days'],
  ['days until 2026-12-25', '132 days'],
  ['weeks until 2026-12-25', '18.86 weeks'],
  ['midpoint between March 12 and April 5', 'Tue 24 Mar 2026'],
]);

table('calendar facts', [
  ['week of year', '33'],
  ['week number on march 12, 2021', '10'],
  ['days in Q3', '92 days'],
  ['days in February 2020', '29 days'],
  ['day of the week on January 24, 1984', 'Tuesday'],
  ['weekday on March 9, 2024', 'Saturday'],
]);

// Issue #15 — workdays
table('workdays', [
  ['workdays in 3 weeks', '15 workdays'],
  ['10 March to 17 March in workdays', '5 workdays'],
  ['workdays from April 12 to June 15', '45 workdays'],
  ['today + 5 business days', 'Fri 21 Aug 2026'],
]);

describe('public holidays', () => {
  it('skips a holiday when counting forward', () => {
    // 24 Dec 2026 is a Thursday. Christmas Day is a holiday, so the first
    // workday after it is Monday the 28th and the second is Tuesday the 29th.
    expect(answer('December 24 2026 + 2 workdays')).toBe('Tue 29 Dec 2026');
  });

  it('excludes holidays from a workday count', () => {
    const withHoliday = answer('December 21 2026 to December 28 2026 in workdays');
    expect(withHoliday).toBe('4 workdays');
  });
});

// Issue #11 — clock times
table('clock times', [
  ['16:00 + 3 hours 12 minutes', 'Sat 15 Aug 2026 at 7:12 pm'],
  ['7:30 to 20:45', '13 hours 15 minutes'],
  ['4pm to 3am', '11 hours'],
  ['now + 3 hours 15 minutes', 'Sat 15 Aug 2026 at 3:15 pm'],
]);

// Issue #12 — timespans and laptimes
table('timespans', [
  ['5.5 minutes as timespan', '5 minutes 30 seconds'],
  ['4.54 hours as timespan', '4 hours 32 minutes 24 seconds'],
  ['72 days as timespan', '10 weeks 2 days'],
  ['3h 5m 10s', '3 hours 5 minutes 10 seconds'],
  ['3h 5m 10s in seconds', '11,110 seconds'],
  ['5.5 minutes as laptime', '00:05:30'],
  ['03:04:05 + 01:02:03', '04:06:08'],
  ['00:12:05 - 00:04:09', '00:07:56'],
  ['03:04:05 as timespan', '3 hours 4 minutes 5 seconds'],
  ['12.5 minutes in minutes and seconds', '12 minutes 30 seconds'],
  ['4.5 weeks in days and hours', '31 days 12 hours'],
]);

// Issue #16 — timestamps and ISO8601
describe('timestamps', () => {
  it('converts a date to a Unix timestamp and back', () => {
    const stamp = answer('April 1, 2019 to timestamp');
    expect(Number(stamp.replace(/,/g, ''))).toBeGreaterThan(1_500_000_000);
    expect(answer('1559740303 to date')).toContain('Jun 2019');
  });

  it('reads millisecond timestamps', () => {
    expect(answer('1733823083000 to date')).toContain('Dec 2024');
  });

  it('produces the current timestamp', () => {
    expect(Number(answer('current timestamp').replace(/,/g, ''))).toBe(
      Math.round(TEST_NOW.getTime() / 1000),
    );
  });

  it('formats as ISO8601', () => {
    expect(answer('April 1, 2019 3:30pm as iso8601')).toMatch(
      /^2019-04-01T15:30:00[+-]\d{2}:\d{2}$/,
    );
  });

  /*
   * The same two answers, exactly, in a named zone.
   *
   * A Unix timestamp is absolute; the date it renders as is not, and neither is
   * the offset an ISO string carries — which is why the cases above assert a
   * substring and a shape rather than a string. Pinning the zone is what lets
   * them be pinned whole, and the whole answer is what a reader is shown.
   */
  describe('read on a fixed clock', () => {
    const zoned = createEngine({
      rates: TEST_RATES,
      now: TEST_NOW,
      zone: 'America/Los_Angeles',
    });
    const inLA = (line: string): string => zoned.evaluate(line)[0]?.output ?? '';

    it('renders a timestamp as the date that zone was on', () => {
      expect(inLA('1559740303 to date')).toBe('5 Jun 2019 at 6:11 am');
    });

    it('carries that zone’s offset into the ISO string', () => {
      expect(inLA('April 1, 2019 3:30pm as iso8601')).toBe('2019-04-01T15:30:00-07:00');
    });
  });
});

// Issue #13 — time zones
describe('time zones', () => {
  it('converts a clock time between cities', () => {
    expect(answer('6pm Sydney in Chicago')).toMatch(/^\d{1,2}:\d{2} (am|pm)$/);
  });

  it('accepts US abbreviations and GMT offsets', () => {
    expect(answer('2am PST to GMT')).toMatch(/(am|pm)$/);
    expect(answer('3pm GMT+8 to Paris')).toMatch(/(am|pm)$/);
  });

  it('accepts airport codes and country names', () => {
    expect(answer('7:30am LAX to Japan')).toMatch(/(am|pm)$/);
  });

  it('reports the current time and date in a place', () => {
    expect(answer('time in Paris')).toMatch(/(am|pm)$/);
    expect(answer('Tokyo time')).toMatch(/(am|pm)$/);
    expect(answer('date in Vancouver')).toMatch(/Aug 2026$/);
  });

  it('leaves a difference between two numbers to the expression parser', () => {
    // The gate now lets `difference between … and …` through, so the frame has
    // to be harmless when the two sides are not places. `resolveZone` declines
    // them, the temporal evaluator passes, and the line reaches math.js
    // unchanged — which is what it did before the gate learned this shape.
    expect(answer('difference between 5 and 3')).toBe(answer('5 and 3'));
  });

  it('reports the difference between two zones, with or without the word time', () => {
    /*
     * Soulver documents both forms — `time difference between Seattle and
     * Moscow` and `difference between PDT & AEST` — and only the first
     * answered. `zoneQuery` accepted either all along; what stopped the second
     * was the gate in front of it, which recognised `time` as a temporal word
     * and `difference` as nothing at all. So a documented question was silent,
     * which reads as unsupported rather than as a defect.
     */
    expect(answer('time difference between Seattle and Moscow')).toBe('10 hours');
    expect(answer('difference between Seattle and Moscow')).toBe('10 hours');
    expect(answer('difference between PDT & AEST')).toBe('17 hours');
    expect(answer('time difference between PDT & AEST')).toBe('17 hours');
  });

  it('leaves an unknown place as prose', () => {
    expect(answer('time in Narnia')).toBe('');
  });
});

// Issue #17 — video timecode
table('timecode', [
  ['03:10:20:05 at 30 fps + 50 frames', '03:10:21:25'],
  ['00:10:20:50 @ 60 fps + 10 minutes', '00:20:20:50'],
  ['00:30:10:00 @ 24 fps in frames', '43,440 frames'],
  ['43,440 frames @ 24 fps', '00:30:10:00'],
  ['03:10:20:05 at 12 fps - 00:20:35:00', '02:49:45:05'],
]);

describe('the temporal gate', () => {
  it('does not intercept ordinary arithmetic', () => {
    expect(answer('100 - 40')).toBe('60');
    expect(answer('2 + 2')).toBe('4');
  });

  it('leaves a date-shaped sentence without an answer', () => {
    expect(answer('meeting on tuesday about the roadmap')).toBe('');
  });

  it('leaves plain unit arithmetic to the unit system', () => {
    // math.js owns this one; `as timespan` is how you get the components.
    expect(answer('2 hours + 45 minutes')).toBe('2.75 hours');
    expect(answer('2.75 hours as timespan')).toBe('2 hours 45 minutes');
  });
});
