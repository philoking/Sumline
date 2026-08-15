import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/index.js';
import { answer, answers } from './helpers.js';

describe('arithmetic', () => {
  const cases: Array<[string, string]> = [
    ['2 + 2', '4'],
    ['10 / 4', '2.5'],
    ['2^10', '1,024'],
    ['(3 + 4) * 5', '35'],
    ['sqrt(144)', '12'],
    ['0.1 + 0.2', '0.3'],
    ['1,234 + 1', '1,235'],
    ['1234567 * 2', '2.47M'],
    ['5k + 500', '5,500'],
    ['2 million / 4', '500k'],
    ['3 billion', '3G'],
    ['10 plus 5 times 2', '20'],
    ['100 divided by 8', '12.5'],
    ['max(1000, 2000)', '2,000'],
    ['what is 6 * 7?', '42'],
    ['12 + 8 =', '20'],
    ['17 mod 5', '2'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }

  it('leaves prose alone', () => {
    expect(answers('shopping list\nremember to call the bank\n')).toEqual([
      '',
      '',
      '',
    ]);
  });

  it('keeps evaluating after a broken line', () => {
    expect(answers('2 + 2\n5 +* 3\n10 * 10')).toEqual(['4', '', '100']);
  });

  it('flags a broken calculation but stays quiet about prose', () => {
    const [calc, prose] = createEngine().evaluate(
      '5 +* 3\nbuy apples at the market',
    );
    expect(calc?.error).toBeTruthy();
    expect(prose?.error).toBeUndefined();
  });
});
