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

/*
 * Issue #79 — the sibling of the setting above. Soulver's View → Total Options
 * offers both "Include Variable Declaration Lines" and "Include Referenced
 * Lines", each ticked by default; only the first of the two existed here.
 */
describe('counting referenced lines in the figure', () => {
  function figure(source: string, countReferenced?: boolean): string {
    const results = engine.evaluate(source);
    return countReferenced === undefined
      ? engine.summary(results, 'total')
      : engine.summary(results, 'total', { countReferenced });
  }

  it('counts them when the option is absent, as Soulver ships it', () => {
    expect(figure('10\n20\nprev + 5')).toBe('55');
    expect(figure('10\n20\nprev + 5', true)).toBe('55');
  });

  /* The 20 was counted once on its own and once inside the 25. */
  it('drops a line a later line consumed when asked to', () => {
    expect(figure('10\n20\nprev + 5', false)).toBe('35');
  });

  it('follows a numbered reference as well as prev', () => {
    expect(figure('10\n20\nline 2 + 5', false)).toBe('35');
  });

  it('leaves a sheet that references nothing alone', () => {
    expect(figure('100\n200\n300', false)).toBe('600');
    expect(figure('rent = 100\nfood = 50', false)).toBe('150');
  });

  it('marks which lines were read, so the flag is not guesswork', () => {
    const results = engine.evaluate('10\n20\nprev + 5');
    expect(results.map((r) => r.referenced === true)).toEqual([false, true, false]);
  });

  /*
   * `prev` means the last line that produced a value, not the line above. A
   * comment between them must not make it point at the comment.
   */
  it('resolves prev past a line that produced nothing', () => {
    const results = engine.evaluate('10\n// a note\nprev + 5');
    expect(results[0]?.referenced).toBe(true);
    expect(figure('10\n// a note\nprev + 5', false)).toBe('15');
  });

  /* A forward reference cannot be satisfied, and treating it as "used above"
     would quietly drop a line the sheet never consumed. */
  it('ignores a reference pointing forwards', () => {
    const results = engine.evaluate('line 3 + 1\n20\n30');
    expect(results[2]?.referenced).toBeUndefined();
  });

  it('applies to every statistic, not only the total', () => {
    const results = engine.evaluate('10\n20\nprev + 5');
    expect(engine.summary(results, 'count', { countReferenced: false })).toBe('2');
    expect(engine.summary(results, 'count', { countReferenced: true })).toBe('3');
  });

  /* The two options are independent: either can drop a declaration alone. */
  it('combines with the variable-line setting rather than overriding it', () => {
    const sheet = 'food = 400\nprev * 2';
    expect(engine.summary(engine.evaluate(sheet), 'total')).toBe('1,200');
    expect(
      engine.summary(engine.evaluate(sheet), 'total', { countReferenced: false }),
    ).toBe('800');
    expect(
      engine.summary(engine.evaluate(sheet), 'total', { countVariables: false }),
    ).toBe('800');
    expect(
      engine.summary(engine.evaluate(sheet), 'total', {
        countVariables: false,
        countReferenced: false,
      }),
    ).toBe('800');
  });
});
