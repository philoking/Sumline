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

  /*
   * A trailing conversion covers the whole line rather than the token before
   * it. Written unbracketed this used to read as `100 km * (2 in miles)`, and
   * because a bare number takes a unit happily it answered `200 km in miles`
   * — the words echoed back, no error, and nothing to tell a reader skimming
   * the column that the number beside them was not in miles.
   */
  describe('a trailing conversion applies to everything before it', () => {
    const equivalent: Array<[string, string]> = [
      ['100 km * 2 in miles', '(100 km * 2) in miles'],
      ['100 km * 2 in m', '(100 km * 2) in m'],
      ['$1000 * 2 in EUR', '($1000 * 2) in EUR'],
      ['$1000 * 2.5 in EUR', '($1000 * 2.5) in EUR'],
      ['2 hours * 3 in minutes', '(2 hours * 3) in minutes'],
      ['10 km / 2 as miles', '(10 km / 2) as miles'],
      ['5 km + 3 km to m', '(5 km + 3 km) to m'],
    ];

    for (const [written, bracketed] of equivalent) {
      it(`${written} answers as ${bracketed}`, () => {
        expect(answer(written)).toBe(answer(bracketed));
      });
    }

    it('converts rather than echoing the words back', () => {
      const result = answer('100 km * 2 in miles');
      expect(result).not.toContain('in miles');
      expect(result).toBe('124.274238447 miles');
    });

    it('does not leave a compound unit where a conversion was meant', () => {
      expect(answer('$1000 * 2 in EUR')).toBe('€1,600.00');
    });

    /*
     * Anchoring to the end of the line means the lazy left side stops at the
     * *last* conversion keyword, so this converts twice instead of reading
     * `miles to feet` as the name of a unit.
     */
    it('takes the last conversion keyword when a line has two', () => {
      expect(answer('10 km in miles to feet')).toBe(answer('(10 km in miles) to feet'));
    });

    it('leaves a plain conversion exactly as it was', () => {
      expect(answer('5 km in miles')).toBe('3.1068559612 miles');
      expect(answer('100 USD in EUR')).toBe('€80.00');
    });

    /*
     * The rule is gated on the target being a unit, which is the whole of what
     * keeps ordinary prose out of it.
     */
    it('leaves prose alone when the trailing word is not a unit', () => {
      expect(answer('5 in stock')).not.toContain('(');
      expect(answer('12 widgets')).toBe('12 widgets');
    });

    it('still reads a trailing `in` as inches', () => {
      expect(answer('10 cm in in')).toBe(answer('(10 cm) in in'));
    });
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

/*
 * Issue #112 — three of the 271 registered unit names are also functions on
 * this math.js instance: `min`, `sec` and `chain`. A function shadows the
 * unit, so `20 min` was read as twenty times the minimum *function*, and
 * math.js will not multiply a number by a function.
 *
 * A bare `20 min` always worked, because the temporal parser claims a lone
 * duration before math.js sees it. That made the two forms inconsistent with
 * each other rather than uniformly broken.
 */
describe('a unit math.js also has a function for', () => {
  const abbreviations: Array<[string, string]> = [
    ['300 + 20 min', '320 minutes'],
    ['300 + 20 sec', '320 seconds'],
    ['20 min + 10 min', '30 minutes'],
    ['20 sec + 10 sec', '30 seconds'],
    ['5 hours 30 min', '5 hours 30 minutes'],
    ['2 * 30 min', '60 minutes'],
  ];

  for (const [input, expected] of abbreviations) {
    it(`${input} -> ${expected}`, () => {
      expect(answer(input)).toBe(expected);
    });
  }

  it('agrees with the bare form the temporal parser already answered', () => {
    expect(answer('20 min')).toBe('20 minutes');
    expect(answer('20 sec')).toBe('20 seconds');
  });

  it('leaves the function alone where a function is what was written', () => {
    // The bracket is the whole distinction: a number in front means the unit,
    // a bracket after means the function.
    expect(answer('min(1000, 2000)')).toBe('1,000');
    expect(answer('max(1000, 2000)')).toBe('2,000');
    expect(answer('sec(0)')).toBe('1');
  });

  it('leaves `chain` alone, which never needed the help', () => {
    // Shadowed by a function too, and resolves as a unit regardless — listed
    // in the source so the next person knows it was checked rather than
    // missed.
    expect(answer('300 + 20 chain')).toBe('320 chain');
  });
});
