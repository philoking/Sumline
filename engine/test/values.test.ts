import { describe, expect, it } from 'vitest';
import { answer, answers } from './helpers.js';

// Issue #3 — the full percentage vocabulary
describe('percentages: reverse and change', () => {
  const cases: Array<[string, string]> = [
    ['20 is 10% of what', '200'],
    ['180 is 10% off what', '200'],
    ['220 is 10% on what', '200'],
    ['50 to 75 is what %', '50%'],
    ['40 to 90 as %', '125%'],
    ['180 is what % off 200', '10%'],
    ['180 is what % on 150', '20%'],
    ['20 is what % of 200', '10%'],
    ['20 as a % of 200', '10%'],
    ['20/200 as %', '10%'],
    ['0.35 as %', '35%'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }
});

describe('percentages: arithmetic', () => {
  const cases: Array<[string, string]> = [
    ['10% + 20%', '30%'],
    ['90% - 40%', '50%'],
    ['30% + 0.4', '70%'],
    ['100% + 2 + 30%', '330%'],
    ['50% * 30', '15'],
    ['30 * 50%', '15'],
    ['20% as dec', '0.2'],
    ['$100 as number', '100'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }

  it('keeps a percentage on the right of a number scaling it', () => {
    // The order matters: `50 + 20%` grows 50, `20% + 50` is percentage maths.
    expect(answer('50 + 20%')).toBe('60');
    expect(answer('20% + 50')).toBe('5,020%');
  });
});

// Issue #10 — fractions and multipliers
describe('fractions and multipliers', () => {
  const cases: Array<[string, string]> = [
    ['2/10 as fraction', '1/5'],
    ['50% as fraction', '1/2'],
    ['2/3 of 600', '400'],
    ['20/5 as multiplier', '4x'],
    ['50 as x of 5', '10x'],
    ['2 as multiplier of 1', '2x'],
    ['2 as multiplier on 1', '1x'],
    ['1 as x off 2', '0.5x'],
    ['50 to 75 is what x', '1.5x'],
    ['20 to 40 as x', '2x'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }
});

// Issue #18 — rates
describe('rates', () => {
  const cases: Array<[string, string]> = [
    ['3 hours / day', '3 hours/day'],
    ['$99 per week', '$99.00/week'],
    ['30 bottles / week', '30/week'],
    ['90 km / 3 day', '30 km/day'],
    ['$50/week * 12 weeks', '$600.00'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }

  it('adds rates in the last unit named', () => {
    expect(answer('$20/day + $300/week')).toBe('$440.00/week');
  });
});

// Issue #5 — unit assimilation
describe('unit assimilation', () => {
  const cases: Array<[string, string]> = [
    ['300 + 20 km', '320 km'],
    ['$20 + 30', '$50.00'],
    ['1km + 1,000m', '2 km'],
    ['2 hours + 45 minutes', '2.75 hours'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }
});

// Issue #4 — comment forms
describe('comment forms', () => {
  const cases: Array<[string, string]> = [
    ['1 + 2 // this is three', '3'],
    ['Cost of 128 GB iPhone 16: $999', '$999.00'],
    ['$999 (for iPhone 16)', '$999.00'],
    ['Boeing "747" is $386.8M', '$386,800,000.00'],
    ['I spent $128 + $45 on clothes // on 10-02-2019', '$173.00'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }

  it('declares no variable for a labelled line', () => {
    expect(answers('Cost of iPhone: $999\nCost of iPhone * 2')).toEqual([
      '$999.00',
      '',
    ]);
  });

  it('does not mistake real parentheses for a comment', () => {
    expect(answer('(3 + 4) * 5')).toBe('35');
    expect(answer('(2 km + 3 km) * 2')).toBe('10 km');
  });
});

// Issue #7 — conversion phrasing
describe('conversion phrasing', () => {
  const cases: Array<[string, string]> = [
    ['meters in 10 km', '10,000 meters'],
    ['days in 3 weeks', '21 days'],
    ['seconds in a day', '86,400 seconds'],
    ['5 hours 30 minutes to seconds', '19,800 seconds'],
    ['km m', '1,000 m'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }

  it('leaves prose that looks like a conversion alone', () => {
    expect(answer('days in Berlin with the family')).toBe('');
  });
});
