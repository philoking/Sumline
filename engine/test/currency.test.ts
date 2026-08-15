import { describe, expect, it } from 'vitest';
import { answer, answers } from './helpers.js';

describe('currency', () => {
  const cases: Array<[string, string]> = [
    ['$100', '$100.00'],
    ['$1,250.50 * 2', '$2,501.00'],
    ['100 USD in EUR', '€80.00'],
    ['100 usd in eur', '€80.00'],
    ['£75 to USD', '$100.00'],
    ['€40 + €10', '€50.00'],
    ['1000 JPY in USD', '$6.25'],
    ['100 USD in JPY', '¥16,000'],
    ['$50 + 20%', '$60.00'],
    ['20% of $250', '$50.00'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }

  // Soulver's rule: when units have no common base, the last one wins.
  it('adds mixed currencies in the units of the last term', () => {
    expect(answer('$100 + €80')).toBe('€160.00');
    expect(answer('€80 + $100')).toBe('$200.00');
  });

  it('renders zero-decimal currencies without cents', () => {
    expect(answer('¥1234')).toBe('¥1,234');
  });

  it('works with no rate table, treating currency words as unknown', () => {
    expect(answers('2 + 2')).toEqual(['4']);
  });
});
