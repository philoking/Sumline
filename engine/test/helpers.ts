import { createEngine } from '../src/index.js';
import type { RateTable } from '../src/types.js';

/**
 * A fixed rate table so currency tests are deterministic. Values are roughly
 * realistic but their exact figures are arbitrary.
 */
export const TEST_RATES: RateTable = {
  base: 'USD',
  date: '2026-08-14',
  rates: {
    EUR: 0.8,
    GBP: 0.75,
    JPY: 160,
    CAD: 1.25,
    AUD: 1.5,
    CHF: 0.9,
  },
};

/** "Now" for every date test: a Saturday. */
export const TEST_NOW = new Date(2026, 7, 15, 12, 0, 0);

const engine = createEngine({ rates: TEST_RATES, now: TEST_NOW });

/** Evaluates a sheet and returns just the answer column. */
export function answers(source: string): string[] {
  return engine.evaluate(source).map((line) => line.output);
}

/** Evaluates a single line and returns its answer. */
export function answer(line: string): string {
  return answers(line)[0] ?? '';
}

/** Runs a table of `input -> expected answer` pairs. */
export function table(cases: Array<[string, string]>): Array<[string, string, string]> {
  return cases.map(([input, expected]) => [input, expected, answer(input)]);
}
