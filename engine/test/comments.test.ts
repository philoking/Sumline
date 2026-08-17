import { describe, expect, it } from 'vitest';
import { answer } from './helpers.js';

describe('parenthesised asides', () => {
  const asides: Array<[string, string]> = [
    ['$999 (for iPhone 16)', '$999.00'],
    ['$50 (per day)', '$50.00'],
    ['1,200 (last quarter)', '1,200'],
  ];

  for (const [input, expected] of asides) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }
});

describe('parenthesised sub-expressions', () => {
  /*
   * These used to be deleted as prose — the test for an aside was "contains
   * two letters and no operator", which an interval satisfies — leaving the
   * rest of the line to evaluate without them and answer confidently wrong.
   */
  const groups: Array<[string, string]> = [
    ['(8:30 to 17:15)', '8 hours 45 minutes'],
    ['(8:30 to 17:15) - 45 minutes', '8 hours'],
    ['(2 hours 45 minutes) in minutes', '165 minutes'],
    ['(days in 3 weeks) * 2', '42 days'],
    ['(seconds in a day)', '86,400 seconds'],
    ['(45 + 55) / 4', '25'],
    ['2 (3)', '6'],
  ];

  for (const [input, expected] of groups) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }

  it('never answers as though the group were absent', () => {
    // The old failure mode: `- 45 minutes` evaluated on its own.
    expect(answer('(8:30 to 17:15) - 45 minutes')).not.toBe('-45 minutes');
  });

  it('leaves brackets that wrap the whole line alone', () => {
    expect(answer('(100 km in miles)')).toBe(answer('100 km in miles'));
    expect(answer('((45 + 55))')).toBe('100');
  });
});
