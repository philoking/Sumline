import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/index.js';
import { TEST_NOW, TEST_RATES } from './helpers.js';

const engine = createEngine({ rates: TEST_RATES, now: TEST_NOW });

function total(source: string): string {
  return engine.total(engine.evaluate(source));
}

describe('sheet total', () => {
  it('adds every value line', () => {
    expect(total('10\n20\n30')).toBe('60');
  });

  it('adds money', () => {
    expect(total('$12.50\n$7.25')).toBe('$19.75');
  });

  it('ignores prose, headings and comments', () => {
    expect(total('# Costs\n10\nsome note\n// ignored\n20')).toBe('30');
  });

  it('does not count a sum directive twice', () => {
    expect(total('10\n20\nsum')).toBe('30');
  });

  it('includes assignments, which show a value of their own', () => {
    expect(total('rent = 100\n50')).toBe('150');
  });

  it('is empty for a sheet with nothing to add', () => {
    expect(total('just some notes\n# heading')).toBe('');
  });

  it('is empty rather than wrong when the units cannot combine', () => {
    expect(total('5 km\n10 USD')).toBe('');
  });
});

/*
 * Issue #54 — a sheet that declares variables and then works with them counted
 * the declarations as well as the results, and the setting that was supposed to
 * govern that was declared in the web layer and read by nothing.
 */
describe('counting variable lines in the figure', () => {
  const sheet = 'monthly rent = 1500\nfood = 400\nprev * 2';

  function summary(source: string, countVariables?: boolean): string {
    const results = engine.evaluate(source);
    return countVariables === undefined
      ? engine.summary(results, 'total')
      : engine.summary(results, 'total', { countVariables });
  }

  it('counts them when the option is absent, as it always has', () => {
    expect(summary(sheet)).toBe('2,700');
    expect(summary(sheet, true)).toBe('2,700');
  });

  it('leaves the declarations out when asked to', () => {
    expect(summary(sheet, false)).toBe('800');
  });

  it('applies to every statistic, not only the total', () => {
    const results = engine.evaluate(sheet);
    expect(engine.summary(results, 'count', { countVariables: false })).toBe('1');
    expect(engine.summary(results, 'count', { countVariables: true })).toBe('3');
  });

  it('leaves a sheet of nothing but expressions alone', () => {
    expect(summary('10\n20\n30', false)).toBe('60');
  });

  /*
   * A list of named amounts is the case the setting cannot be a rule for: here
   * the declarations *are* the sheet, and excluding them empties the corner.
   */
  it('empties the figure on a sheet that is only declarations', () => {
    expect(summary('rent = 100\nfood = 50', false)).toBe('');
    expect(summary('rent = 100\nfood = 50', true)).toBe('150');
  });
});
