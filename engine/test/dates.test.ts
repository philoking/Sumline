import { describe, expect, it } from 'vitest';
import { answer } from './helpers.js';

// Every case is relative to TEST_NOW: Saturday 15 August 2026.
describe('dates', () => {
  const cases: Array<[string, string]> = [
    ['today', 'Sat 15 Aug 2026'],
    ['tomorrow', 'Sun 16 Aug 2026'],
    ['yesterday', 'Fri 14 Aug 2026'],
    ['today + 3 weeks', 'Sat 5 Sep 2026'],
    ['today - 10 days', 'Wed 5 Aug 2026'],
    ['2026-01-31 + 1 month', 'Sat 28 Feb 2026'],
    ['2026-01-01 + 1 year', 'Fri 1 Jan 2027'],
    ['March 3 2026', 'Tue 3 Mar 2026'],
    ['3 March 2026', 'Tue 3 Mar 2026'],
    ['next friday', 'Fri 21 Aug 2026'],
    ['last monday', 'Mon 10 Aug 2026'],
    // A range answers in calendar components; `days between` answers in days.
    ['2026-01-01 to 2026-08-15', '7 months 2 weeks'],
    ['days between 2026-01-01 and 2026-08-15', '226 days'],
    ['days until 2026-12-25', '132 days'],
    ['weeks until 2026-12-25', '18.86 weeks'],
    ['today + 5 business days', 'Fri 21 Aug 2026'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }

  it('does not intercept ordinary arithmetic', () => {
    expect(answer('100 - 40')).toBe('60');
  });

  it('leaves a date-shaped sentence without an answer', () => {
    expect(answer('meeting on tuesday about the roadmap')).toBe('');
  });
});

/*
 * Issue #59 — the parser handled `12/25/2026` perfectly well inside a larger
 * expression, but a date standing alone never reached it: `looksTemporal` did
 * not recognise the shape, so the line fell through to math.js as two
 * divisions and answered 0.000237.
 */
describe('a date standing on its own', () => {
  const dates: Array<[string, string]> = [
    ['12/25/2026', 'Fri 25 Dec 2026'],
    ['1/2/2026', 'Fri 2 Jan 2026'],
    // Dots are the European reading: day.month.year.
    ['25.12.2026', 'Fri 25 Dec 2026'],
    ['01.05.2005', 'Sun 1 May 2005'],
  ];

  for (const [input, expected] of dates) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }

  it('agrees with the same date inside an expression', () => {
    expect(answer('12/25/2026 + 3 days')).toBe('Mon 28 Dec 2026');
    expect(answer('days between 12/25/2026 and 1/1/2027')).toBe('7 days');
  });

  /*
   * The four-digit year is the whole guard. Chained division is something
   * people genuinely write, and nothing in a line like `3/4/5` distinguishes
   * it from a date with a short year — so the short year stays arithmetic
   * unless something else on the line has already established a date.
   */
  it('leaves chained division alone', () => {
    expect(answer('1/2')).toBe('0.5');
    expect(answer('3/4/5')).toBe('0.15');
    expect(answer('5000/12/2026')).toBe('0.20566');
    expect(answer('100/25/2026')).toBe('0.001974');
  });

  /*
   * `new Date` rolls month 99 forward into a real date eight years out, so a
   * date that does not exist has to be refused rather than constructed — the
   * line is arithmetic, and answering with a plausible Tuesday would be the
   * same silent wrongness this issue is about.
   */
  it('refuses a date that does not exist', () => {
    expect(answer('99/99/2026')).toBe('0.000494');
    expect(answer('13/45/2026')).toBe('0.000143');
    expect(answer('2/30/2026')).toBe('0.000033');
  });
});
