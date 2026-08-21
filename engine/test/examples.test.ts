import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/index.js';
import {
  ALL_EXAMPLES,
  EXAMPLE_GROUPS,
  REFERENCE_HISTORICAL_RATES,
  REFERENCE_HOLIDAYS,
  REFERENCE_NOW,
  REFERENCE_RATES,
} from '../src/examples.js';

/**
 * The reference is only trustworthy because of this file.
 *
 * Every example shown in the app is evaluated here against the same fixed
 * context it documents. An entry that claims an answer the engine does not
 * produce fails the build, so the docs cannot drift from the behaviour.
 */
const engine = createEngine({
  rates: REFERENCE_RATES,
  now: REFERENCE_NOW,
  holidays: REFERENCE_HOLIDAYS,
  historicalRates: REFERENCE_HISTORICAL_RATES,
});

describe('documented examples', () => {
  for (const group of EXAMPLE_GROUPS) {
    describe(group.title, () => {
      for (const { input, expected } of group.examples) {
        it(`${input} -> ${expected}`, () => {
          expect(engine.evaluate(input)[0]?.output).toBe(expected);
        });
      }
    });
  }
});

describe('the example set itself', () => {
  it('gives every example an answer', () => {
    const empty = ALL_EXAMPLES.filter(({ expected }) => expected.trim() === '');
    expect(empty).toEqual([]);
  });

  it('has no duplicate inputs', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const { input, group } of ALL_EXAMPLES) {
      const previous = seen.get(input);
      if (previous) duplicates.push(`${input} (${previous} and ${group})`);
      else seen.set(input, group);
    }
    expect(duplicates).toEqual([]);
  });

  it('gives every group an id, a title and a blurb', () => {
    for (const group of EXAMPLE_GROUPS) {
      expect(group.id).toMatch(/^[a-z-]+$/);
      expect(group.title.length).toBeGreaterThan(0);
      expect(group.blurb.length).toBeGreaterThan(0);
      expect(group.examples.length).toBeGreaterThan(0);
    }
  });

  it('covers every area of the engine', () => {
    // A crude but effective guard: if a milestone's worth of syntax is added
    // without a documented example, one of these ids will be missing.
    const ids = EXAMPLE_GROUPS.map((group) => group.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'arithmetic',
        'numbers',
        'rounding',
        'functions',
        'trigonometry',
        'bases',
        'percentages',
        'percentage-change',
        'fractions',
        'units',
        'rates',
        'currency',
        'past-rates',
        'dates',
        'intervals',
        'workdays',
        'time',
        'timecode',
        'statistics',
        'notes',
      ]),
    );
  });
});
