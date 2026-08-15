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
    ['2026-01-01 to 2026-08-15', '226 days'],
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
