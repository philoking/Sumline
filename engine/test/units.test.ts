import { describe, expect, it } from 'vitest';
import { answer } from './helpers.js';

describe('units', () => {
  const cases: Array<[string, string]> = [
    ['5 km in miles', '3.1068559612 miles'],
    ['100 cm to m', '1 m'],
    ['2 hours + 45 minutes', '2.75 hours'],
    ['180 lbs in kg', '81.6466266 kg'],
    ['1 GB in MB', '1,000 MB'],
    ['32 degF to degC', '0 °C'],
    ['72 F in C', '22.2222222222 °C'],
    ['20 C in F', '68 °F'],
    ['72 °F in °C', '22.2222222222 °C'],
    ['65 mph in km/h', '104.60736 km/h'],
    ['3 cups in ml', '709.7647095 ml'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }

  it('does not mistake the volume unit `cup` for the Cuban peso', () => {
    expect(answer('2 cup to ml')).toContain('ml');
  });

  describe('data transfer', () => {
    const rates: Array<[string, string]> = [
      ['4 Mbps', '4 Mbps'],
      ['1 Gbps in Mbps', '1,000 Mbps'],
      ['500 kbps in Mbps', '0.5 Mbps'],
      ['4 Mbps in MB/s', '0.5 MB/s'],
      ['120 GB / 940 Mbps in minutes', '17.0212765957 minutes'],
      ['12 GB / s in GB/minute', '720 GB/minute'],
    ];

    for (const [input, expected] of rates) {
      it(`${input} -> ${expected}`, () => {
        expect(answer(input)).toBe(expected);
      });
    }

    it('keeps megabits and megabytes eight bits apart', () => {
      expect(answer('8 Mbps in MB/s')).toBe('1 MB/s');
    });

    it('reads a lowercase mbps as megabits, not millibits', () => {
      expect(answer('100 mbps in Mbps')).toBe('100 Mbps');
    });
  });

  describe('rate denominators', () => {
    const cases: Array<[string, string]> = [
      ['4 MB/s', '4 MB/s'],
      ['5 m/s', '5 m/s'],
      ['30 bottles / s', '30/s'],
      ['4 MB per second', '4 MB/second'],
    ];

    for (const [input, expected] of cases) {
      it(`${input} -> ${expected}`, () => {
        expect(answer(input)).toBe(expected);
      });
    }
  });
});
