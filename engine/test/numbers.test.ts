import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/index.js';
import { answer, TEST_NOW, TEST_RATES } from './helpers.js';

// Issue #1 — rounding
describe('rounding', () => {
  const cases: Array<[string, string]> = [
    ['1/3 to 2 dp', '0.33'],
    ['pi to 5 digits', '3.14159'],
    ['5.5 rounded', '6'],
    ['5.5 rounded down', '5'],
    ['5.5 rounded up', '6'],
    ['37 to nearest 10', '40'],
    ['$490 rounded to nearest hundred', '$500.00'],
    ['2,100 to nearest thousand', '2,000'],
    ['21 rounded up to nearest 5', '25'],
    ['17 rounded down to nearest 3', '15'],
    ['round(4.6)', '5'],
    ['ceil(4.1)', '5'],
    ['floor(4.9)', '4'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }

  it('keeps display rounding out of the stored value', () => {
    // `to 2 dp` is cosmetic: the full-precision value still feeds the total.
    const engine = createEngine({ rates: TEST_RATES, now: TEST_NOW });
    const results = engine.evaluate('1/3 to 2 dp\n1/3 to 2 dp');
    expect(results[0]?.output).toBe('0.33');
    expect(engine.total(results)).toBe('0.666667');
  });
});

// Issue #2 — large number notation
describe('large numbers', () => {
  const cases: Array<[string, string]> = [
    ['100,000 + 200,000', '300k'],
    ['3 million + 10%', '3.3M'],
    ['2M', '2M'],
    ['3G', '3G'],
    ['1.5T', '1.5T'],
    ['$3k', '$3,000.00'],
    ['$9bn', '$9,000,000,000.00'],
    ['€6M', '€6,000,000.00'],
    ['£12tn', '£12,000,000,000,000.00'],
    ['1,700,000 as sci', '1.7e6'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }

  it('never abbreviates currency, which Soulver writes out in full', () => {
    expect(answer('$102,877')).toBe('$102,877.00');
  });

  it('leaves ambiguous suffixes as the units they are', () => {
    expect(answer('5m to cm')).toBe('500 cm');
    expect(answer('5K to degC')).toContain('degC');
  });

  it('can be switched off entirely', () => {
    const plain = createEngine({ largeNumberNotation: false });
    expect(plain.evaluate('100000 + 200000')[0]?.output).toBe('300,000');
  });
});

// Issue #8 — region number formats
describe('number regions', () => {
  it('reads and writes Western European numbers', () => {
    const engine = createEngine({ region: 'western-europe' });
    expect(engine.evaluate('1.234,5 + 0,5')[0]?.output).toBe('1.235');
    expect(engine.evaluate('1234.56')[0]?.output).toBe('1.234,56');
  });

  it('reads Eastern European numbers, which group with spaces', () => {
    const engine = createEngine({ region: 'eastern-europe' });
    expect(engine.evaluate('1 234 + 1')[0]?.output).toBe('1 235');
  });

  it('accepts underscore grouping in every region', () => {
    expect(answer('1_000_000 + 2_000')).toBe('1M');
    const engine = createEngine({ largeNumberNotation: false });
    expect(engine.evaluate('1_000_000 + 2_000')[0]?.output).toBe('1,002,000');
  });
});

// Issue #9 — operator symbols and phrases
describe('operators', () => {
  const cases: Array<[string, string]> = [
    ['6 × 7', '42'],
    ['84 ÷ 2', '42'],
    ['50 − 8', '42'],
    ['2 ** 10', '1,024'],
    ['3 to the power of 2', '9'],
    ['remainder of 21 divided by 5', '1'],
    ['√16', '4'],
    ['π', '3.141593'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }
});

// Issue #6 — inline statistics
describe('inline statistics', () => {
  const cases: Array<[string, string]> = [
    ['total of 3, 4, 7 and 9', '23'],
    ['sum of 3, 4, 7 and 9', '23'],
    ['average of 36, 42, 19 and 81', '44.5'],
    ['count of 1, 2, 3, 4, 5', '5'],
    ['median of 10, 20 and 30', '20'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }

  it('works with money', () => {
    expect(answer('total of $3, $4 and $7')).toBe('$14.00');
  });
});
