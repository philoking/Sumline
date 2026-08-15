import { describe, expect, it } from 'vitest';
import { answer } from './helpers.js';

describe('percentages', () => {
  const cases: Array<[string, string]> = [
    ['20% of 50', '10'],
    ['15% of 1,200', '180'],
    ['100 + 15%', '115'],
    ['200 - 10%', '180'],
    ['20% off 50', '40'],
    ['20% on 50', '60'],
    ['30 as a % of 200', '15%'],
    ['30 as a percentage of 200', '15%'],
    ['45%', '45%'],
    ['80 + 10% - 10%', '79.2'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }
});
