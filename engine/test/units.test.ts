import { describe, expect, it } from 'vitest';
import { answer } from './helpers.js';

describe('units', () => {
  const cases: Array<[string, string]> = [
    ['5 km in miles', '3.106856 miles'],
    ['100 cm to m', '1 m'],
    ['2 hours + 45 minutes', '2.75 hours'],
    ['180 lbs in kg', '81.646627 kg'],
    ['1 GB in MB', '1,000 MB'],
    ['32 degF to degC', '0 degC'],
    ['65 mph in km/h', '104.60736 km/h'],
    ['3 cups in ml', '709.76471 ml'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }

  it('does not mistake the volume unit `cup` for the Cuban peso', () => {
    expect(answer('2 cup to ml')).toContain('ml');
  });
});
