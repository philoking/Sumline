import { describe, expect, it } from 'vitest';
import { answer, answers } from './helpers.js';
import { CODE_TO_SYMBOL, SYMBOL_TO_CODE, SYMBOLS_BY_LENGTH } from '../src/currencies.js';

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
    ['$42.50 * 3', '$127.50'],
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

  /*
   * A price times a quantity is a cash amount, not a compound unit. These used
   * to answer `62.6769 kWh USD` — no symbol, no rounding, and nothing later
   * lines could add to.
   */
  describe('money times a quantity', () => {
    const cases: Array<[string, string]> = [
      ['569.79 kWh * $0.11', '$62.68'],
      ['$0.11 * 569.79 kWh', '$62.68'],
      ['2 kg * $5', '$10.00'],
      ['3 hours * $20', '$60.00'],
      ['(65 W * 1 year in kWh) * $0.11', '$62.68'],
    ];

    for (const [input, expected] of cases) {
      it(`${input} -> ${expected}`, () => {
        expect(answer(input)).toBe(expected);
      });
    }

    it('produces a value later lines can go on using', () => {
      expect(answer('569.79 kWh * $0.11 + $5')).toBe('$67.68');
    });

    it('leaves rates to cancel as they already did', () => {
      expect(answer('$20/hour * 3 hours')).toBe('$60.00');
      expect(answer('$50/week * 12 weeks')).toBe('$600.00');
    });
  });
});

describe('the symbol table against itself', () => {
  it('renders every currency as something that parses back as that currency', () => {
    /*
     * The two maps are independent, and nothing checked them against each
     * other. `CNY` rendered as a bare `¥`, which `SYMBOL_TO_CODE` reads as
     * `JPY`, so an amount this engine printed came back roughly twenty-one
     * times wrong when pasted into a sheet, with nothing in the text to hint
     * that it had changed meaning.
     *
     * Asserted over the whole table rather than over the pair that was wrong.
     * `$` and `kr` are the obvious next candidates, and this is the shape of
     * test that catches the next one before a user does.
     */
    const wrong: string[] = [];
    for (const [code, symbol] of Object.entries(CODE_TO_SYMBOL)) {
      // A code rendered as itself has nothing to round-trip.
      if (symbol === code) continue;
      const back = SYMBOL_TO_CODE[symbol];
      if (back !== code) {
        wrong.push(`${code} renders as ${symbol}, which parses as ${back ?? 'nothing'}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('reads the longer symbol first where one contains another', () => {
    // `CN¥` only survives because `SYMBOLS_BY_LENGTH` tries it before `¥`.
    // Sorting is what makes the fix above work, so it is asserted rather than
    // assumed.
    for (const [long, short] of [
      ['CN¥', '¥'],
      ['C$', '$'],
      ['NZ$', '$'],
    ]) {
      expect(SYMBOLS_BY_LENGTH.indexOf(long!), `${long} before ${short}`).toBeLessThan(
        SYMBOLS_BY_LENGTH.indexOf(short!),
      );
    }
  });
});
