import { describe, expect, it } from 'vitest';
import { answer, answers } from './helpers.js';

/*
 * A number followed by a word the engine has no unit for is a count of
 * something. Before these existed the word was either silently discarded —
 * `4 flurbs` answered `4` — or fatal the moment it appeared in an expression.
 */
describe('labelled quantities', () => {
  const cases: Array<[string, string]> = [
    ['12 widgets + 15 widgets', '27 widgets'],
    ['12 widgets - 5 widgets', '7 widgets'],
    ['28 cameras * 4', '112 cameras'],
    ['12 widgets * 2', '24 widgets'],
    ['12 widgets / 3', '4 widgets'],
    ['4 flurbs', '4 flurbs'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }

  it('drops the label when two different ones meet', () => {
    expect(answer('12 widgets + 3 crates')).toBe('15');
  });

  it('drops the label when mixed with a unit', () => {
    expect(answer('12 widgets + 3 kg')).toBe('15');
  });

  it('reads the count as a multiplier against a unit', () => {
    expect(answer('28 cameras * 4 Mbps in TB/day')).toBe('1.2096 TB/day');
  });

  it('echoes the label exactly as it was written', () => {
    expect(answer('3 Widgets + 2 widgets')).toBe('5 Widgets');
  });

  it('carries through a line reference', () => {
    expect(answers('3 people\nprev * 2')).toEqual(['3 people', '6 people']);
  });

  describe('does not claim words the engine already understands', () => {
    const untouched: Array<[string, string]> = [
      ['I spent $128 + $45 on clothes', '$173.00'],
      ['30 bottles / week', '30/week'],
      ['Cost of 128 GB iPhone 16: $999', '$999.00'],
      ['$999 (for iPhone 16)', '$999.00'],
      ['17 mod 5', '2'],
      ['3 to the power of 2', '9'],
      ['10 plus 5 times 2', '20'],
      ['total of 3, 4, 7 and 9', '23'],
      ['days in 3 weeks', '21 days'],
      ['20 is 10% of what', '200'],
      ['37 to nearest 10', '40'],
      ['4 Mbps', '4 Mbps'],
    ];

    for (const [input, expected] of untouched) {
      it(`${input} -> ${expected}`, () => {
        expect(answer(input)).toBe(expected);
      });
    }
  });
});
