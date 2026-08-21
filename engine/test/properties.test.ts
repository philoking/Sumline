import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/index.js';
import { createMathContext } from '../src/mathInstance.js';
import { TEST_NOW, TEST_RATES } from './helpers.js';

/**
 * The arithmetic invariants, stated once and generated over.
 *
 * `fuzz.test.ts` does the hostile half of this: input nobody would write, the
 * never-throws contract, a differential check against JavaScript's own
 * arithmetic. What it does not do is say what the maths must *satisfy*, over
 * the sets the engine actually registers rather than over cases a person
 * thought of. Examples are finite; every currency in the rate table and every
 * unit alias math.js ships are not.
 *
 * Generated with the same `mulberry32` the fuzz suite uses, rather than by
 * adding `fast-check`. Shrinking would be worth having — a minimal failing case
 * instead of a seed — but it would be the only new dependency in the whole
 * testing plan, and a failure here prints the pair that failed, which is
 * already the minimal case for every property below.
 *
 * Out of scope, deliberately: math.js's own unit table, its trigonometry and
 * its arithmetic. These guard the seams Sumline owns — the rewrites in
 * `preprocess.ts`, the real percentage and multiplier types in `values.ts`, and
 * the sheet semantics in `evaluate.ts`. Anything that could only fail because
 * math.js changed belongs to a version bump, not here.
 */
const engine = createEngine({ rates: TEST_RATES, now: TEST_NOW });

const CONTEXT = createMathContext(TEST_RATES);

/**
 * The unit names this engine registered, which is what a line may name.
 *
 * Minus any whose magnitude is not a real number. math.js 15 added `VAR` —
 * reactive power — and models it the way electrical engineering does, as an
 * imaginary quantity: `unit(1, 'VAR').value` is `Complex { re: 0, im: 1 }`.
 * That is math.js being right, and it means `300 + 20 VAR` has no answer this
 * engine can print. It does not silently print a wrong one either — the line
 * comes back "That does not work out to a number", which is the honest result
 * and the one every other unrepresentable answer gets.
 *
 * Filtered by the property rather than by name, so the next complex unit math.js
 * adds is handled on arrival instead of failing this suite. The header above
 * says it: anything that could only fail because math.js changed belongs to a
 * version bump, not here.
 */
const UNITS = [...CONTEXT.unitNames]
  .filter((name) => typeof CONTEXT.math.unit(1, name).value === 'number')
  .sort();
const CURRENCIES = [...engine.currencies].sort();

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)]!;

const answer = (source: string): string => engine.evaluate(source)[0]?.output ?? '';

/** The answer column read back as a number, for the tolerance comparisons. */
function numeric(output: string): number | null {
  const cleaned = output
    .replace(/,/g, '')
    .replace(/^-?(?:[A-Z]{0,2}\$|[€£¥₹₩₽₺₴฿₪₱₫₾])/, (match) =>
      match.startsWith('-') ? '-' : '',
    )
    .trim();
  const number = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/.exec(cleaned);
  return number ? Number(number[0]) : null;
}

/**
 * Pairs the engine will actually convert between, chosen by asking it.
 *
 * Units belong to dimensions and most pairs are nonsense — `1 km in kg` is not
 * a round-trip that failed, it is a question with no answer. Sampling and then
 * keeping the pairs that converted is what makes this a property over the
 * registered set rather than over a list somebody curated.
 */
function convertiblePairs(
  names: readonly string[],
  seed: number,
  wanted: number,
  attempts: number,
): Array<[string, string]> {
  const random = mulberry32(seed);
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < attempts && pairs.length < wanted; i += 1) {
    const from = pick(random, names);
    const to = pick(random, names);
    if (from === to) continue;
    const line = engine.evaluate(`1 ${from} in ${to}`)[0];
    if (line?.output && !line.error) pairs.push([from, to]);
  }
  return pairs;
}

describe('converting there and back', () => {
  const unitPairs = convertiblePairs(UNITS, 0x5eed, 120, 4000);
  const moneyPairs = convertiblePairs(CURRENCIES, 0xbeef, 60, 600);

  it('found pairs to test, in both sets', () => {
    // Without this the two suites below pass by having nothing to say.
    expect(unitPairs.length).toBeGreaterThan(50);
    expect(moneyPairs.length).toBeGreaterThan(30);
  });

  /**
   * A round trip lands back where it started, or refuses.
   *
   * Both halves matter, and the second is the one worth stating. A unit name
   * can be ambiguous — `1 year in m` answers in minutes, and the same `m`
   * read again beside `year` is metres — so a chain can legitimately have no
   * answer. What it must never do is answer a *different* number, because
   * that is a conversion that quietly lost the amount it was given.
   *
   * In one expression rather than two, so nothing passes through the
   * formatter in between: printing to ten decimal places and reading it back
   * loses five per cent of `100 secs in year`, and that is the display's
   * business rather than the arithmetic's.
   */
  function roundTrips(
    pairs: ReadonlyArray<[string, string]>,
    tolerance: number,
  ): { wrong: string[]; refused: number } {
    const wrong: string[] = [];
    let refused = 0;
    for (const [from, to] of pairs) {
      const there = answer(`100 ${from} in ${to} in ${from}`);
      if (!there) {
        refused += 1;
        continue;
      }
      const back = numeric(there);
      if (back === null || Math.abs(back - 100) > tolerance) {
        wrong.push(`100 ${from} in ${to} in ${from} -> ${there}`);
      }
    }
    return { wrong, refused };
  }

  it('never brings a unit amount back as a different number', () => {
    // A tolerance rather than string equality: some of these are affine
    // (degC, degF) and all of them are floating point.
    const { wrong, refused } = roundTrips(unitPairs, 1e-6);
    expect(wrong).toEqual([]);
    // And it is not passing by refusing everything.
    expect(refused).toBeLessThan(unitPairs.length / 4);
  });

  it('never brings a currency amount back as a different number', () => {
    const { wrong, refused } = roundTrips(moneyPairs, 1e-6);
    expect(wrong).toEqual([]);
    // Codes are unambiguous, so nothing here has an excuse to refuse.
    expect(refused).toBe(0);
  });

  it('reaches the same place whichever way it goes', () => {
    // A → C and A → B → C, for money, which converts through a base rather
    // than pairwise. A rate table that lost its base would still round-trip.
    const random = mulberry32(0xc0ffee);
    const broken: string[] = [];
    for (let i = 0; i < 120; i += 1) {
      const [a, b, c] = [
        pick(random, CURRENCIES),
        pick(random, CURRENCIES),
        pick(random, CURRENCIES),
      ];
      const direct = numeric(answer(`100 ${a} in ${c}`));
      const around = numeric(answer(`100 ${a} in ${b} in ${c}`));
      if (direct === null || around === null) continue;
      // Relative, because the amounts range from fractions to hundreds of
      // thousands depending on the currencies drawn.
      if (Math.abs(direct - around) > Math.max(0.01, Math.abs(direct) * 1e-9)) {
        broken.push(`${a}->${c} = ${direct}, ${a}->${b}->${c} = ${around}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('a bare number beside a unit', () => {
  it('takes the unit of the thing it is added to, for every unit', () => {
    // `300 + 20 km` is `320 km`, documented once and true generally.
    const random = mulberry32(0x1234);
    const broken: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const unit = pick(random, UNITS);
      const output = answer(`300 + 20 ${unit}`);
      const value = numeric(output);
      if (value === null || Math.abs(value - 320) > 1e-9) {
        broken.push(`300 + 20 ${unit} -> ${output}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('rounding to a fixed number of places', () => {
  it('treats the two signs of a magnitude the same way', () => {
    /*
     * `f(-x)` must be `-f(x)`, swept rather than sampled.
     *
     * `Math.round` breaks ties toward positive infinity, so rounding a signed
     * value disagreed with rounding its magnitude: `2.675` went to `2.68` and
     * `-2.675` to `-2.67`. It disagreed only where the epsilon nudge carried
     * one sign across the tie boundary and not the other, so `1.005` and
     * `8.835` looked fine and any hand-picked pair had better-than-even odds
     * of being one of the symmetric ones. A sweep does not get that luck.
     */
    const random = mulberry32(0x5164);
    const broken: string[] = [];
    for (let i = 0; i < 400; i += 1) {
      const magnitude = Math.round(random() * 1e6) / 1000;
      const places = Math.floor(random() * 5);
      const positive = answer(`${magnitude} to ${places} dp`);
      const negative = answer(`-${magnitude} to ${places} dp`);
      if (positive === '' || negative === '') continue;
      if (negative !== `-${positive}` && !/^-?0\.?0*$/.test(positive)) {
        broken.push(`${magnitude} to ${places} dp: ${positive} vs ${negative}`);
      }
    }
    expect(broken.slice(0, 10)).toEqual([]);
  });
});

describe('percentages', () => {
  const random = mulberry32(0xfeed);
  const amounts = Array.from({ length: 60 }, () => ({
    n: Math.round(random() * 10000) / 100,
    x: Math.round(random() * 100000) / 100,
  }));

  it('n% of X is X * n / 100', () => {
    const broken: string[] = [];
    for (const { n, x } of amounts) {
      const stated = numeric(answer(`${n}% of ${x}`));
      const spelt = numeric(answer(`${x} * ${n} / 100`));
      if (stated === null || spelt === null || Math.abs(stated - spelt) > 1e-6) {
        broken.push(`${n}% of ${x} -> ${stated} vs ${spelt}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('X + n% is X * (1 + n / 100)', () => {
    const broken: string[] = [];
    for (const { n, x } of amounts) {
      const stated = numeric(answer(`${x} + ${n}%`));
      const spelt = numeric(answer(`${x} * (1 + ${n} / 100)`));
      if (stated === null || spelt === null || Math.abs(stated - spelt) > 1e-6) {
        broken.push(`${x} + ${n}% -> ${stated} vs ${spelt}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('a sheet’s own arithmetic', () => {
  const random = mulberry32(0xabcd);
  const sheets = Array.from({ length: 40 }, () =>
    Array.from({ length: 2 + Math.floor(random() * 5) }, () =>
      Math.round(random() * 100000) / 100,
    ),
  );

  it('sums a section to what its lines add up to', () => {
    const broken: string[] = [];
    for (const values of sheets) {
      const results = engine.evaluate([...values, 'sum'].join('\n'));
      const printed = numeric(results.at(-1)?.output ?? '');
      const expected = values.reduce((a, b) => a + b, 0);
      if (printed === null || Math.abs(printed - expected) > 1e-6) {
        broken.push(`${values.join(' + ')} -> ${printed} (want ${expected})`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('averages a section to its sum over its count', () => {
    const broken: string[] = [];
    for (const values of sheets) {
      const results = engine.evaluate([...values, 'average'].join('\n'));
      const printed = numeric(results.at(-1)?.output ?? '');
      const expected = values.reduce((a, b) => a + b, 0) / values.length;
      if (printed === null || Math.abs(printed - expected) > 1e-6) {
        broken.push(`average of ${values.join(', ')} -> ${printed} (want ${expected})`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('lets a heading partition the sheet rather than duplicate it', () => {
    const broken: string[] = [];
    for (const values of sheets) {
      const half = Math.max(1, Math.floor(values.length / 2));
      const first = values.slice(0, half);
      const second = values.slice(half);
      if (second.length === 0) continue;
      const results = engine.evaluate(
        ['# One', ...first, 'sum', '# Two', ...second, 'sum'].join('\n'),
      );
      const wantFirst = first.reduce((a, b) => a + b, 0);
      const wantSecond = second.reduce((a, b) => a + b, 0);
      // The second section's subtotal is its own lines and not the sheet's: a
      // heading that failed to partition would answer the whole thing.
      const printedSecond = numeric(results.at(-1)?.output ?? '');
      if (printedSecond === null || Math.abs(printedSecond - wantSecond) > 1e-6) {
        broken.push(
          `second section -> ${printedSecond} (want ${wantSecond}, first was ${wantFirst})`,
        );
      }
    }
    expect(broken).toEqual([]);
  });

  it('does not feed a subtotal back into the section it closed', () => {
    const broken: string[] = [];
    for (const values of sheets) {
      const results = engine.evaluate([...values, 'sum', 'sum'].join('\n'));
      // The second `sum` closes a section containing nothing, because the
      // first one closed the lines above it. Doubling would be the bug.
      const second = numeric(results.at(-1)?.output ?? '');
      const expected = values.reduce((a, b) => a + b, 0);
      if (second !== null && Math.abs(second - expected * 2) < 1e-6) {
        broken.push(`${values.join(' + ')} double-counted as ${second}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('rules the engine holds on purpose', () => {
  it('answers mixed money in the last currency named', () => {
    // Matching Soulver. The kind of thing a refactor reverses quietly, because
    // either currency looks like a reasonable answer in isolation.
    const random = mulberry32(0x9999);
    const broken: string[] = [];
    for (let i = 0; i < 80; i += 1) {
      const first = pick(random, CURRENCIES);
      const last = pick(random, CURRENCIES);
      if (first === last) continue;
      const output = answer(`10 ${first} + 10 ${last}`);
      const alone = answer(`10 ${last}`);
      // Compared by how the answer is written — symbol or code — rather than
      // by value, which is the half that says which currency won.
      const shape = (text: string) => text.replace(/[\d.,\s]/g, '');
      if (output && shape(output) !== shape(alone)) {
        broken.push(`10 ${first} + 10 ${last} -> ${output}, expected ${alone}'s currency`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('lets a trailing conversion cover the whole line', () => {
    // 5b797d4. `100 km * 2 in miles` converts the product, not the 2.
    const pairs = convertiblePairs(UNITS, 0x77, 60, 2000);
    const broken: string[] = [];
    for (const [from, to] of pairs) {
      const trailing = numeric(answer(`100 ${from} * 2 in ${to}`));
      const bracketed = numeric(answer(`(100 ${from} * 2) in ${to}`));
      if (trailing === null || bracketed === null) continue;
      if (Math.abs(trailing - bracketed) > Math.max(1e-6, Math.abs(bracketed) * 1e-9)) {
        broken.push(`100 ${from} * 2 in ${to} -> ${trailing}, bracketed ${bracketed}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('evaluating the same thing twice', () => {
  it('gives the same answer, sheet state and all', () => {
    // Cheap, and it guards the mutable `SheetState` threaded through
    // `evaluateLines`: a sheet that left something behind would answer
    // differently the second time it was asked.
    const random = mulberry32(0x2468);
    const sheet = Array.from({ length: 12 }, () => {
      const value = Math.round(random() * 10000) / 100;
      return pick(random, [
        `${value}`,
        `${value} km`,
        `$${value}`,
        `prev + ${value}`,
        `${value}% of prev`,
        'sum',
        `total = ${value}`,
        '# Section',
      ]);
    }).join('\n');

    const once = engine.evaluate(sheet);
    const twice = engine.evaluate(sheet);
    expect(twice.map((line) => line.output)).toEqual(once.map((line) => line.output));
    expect(twice.map((line) => line.error)).toEqual(once.map((line) => line.error));
    expect(engine.total(twice)).toBe(engine.total(once));
  });
});
