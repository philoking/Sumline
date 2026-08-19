import { describe, expect, it } from 'vitest';
import { createEngine } from '@sumline/engine';
import { WELCOME_SHEET } from '../src/welcome.js';
import { SEED_RATES } from '../src/rates.js';

/**
 * The welcome sheet is the first thing a new user sees, so every line in it
 * has to actually work. It also contains `line N` references, which silently
 * rot if the surrounding lines are edited — this test is what catches that.
 */
describe('welcome sheet', () => {
  const engine = createEngine({ rates: SEED_RATES });
  const results = engine.evaluate(WELCOME_SHEET);
  const lines = WELCOME_SHEET.split('\n');

  it('has no line that fails to evaluate', () => {
    const broken = results
      .filter((result) => result.error)
      .map((result) => `line ${result.index + 1}: ${lines[result.index]}`);
    expect(broken).toEqual([]);
  });

  it('produces an answer for every line that demonstrates a feature', () => {
    const demoLines = results.filter(
      (result) => result.kind === 'expression' || result.kind === 'assignment',
    );
    const silent = demoLines
      .filter((result) => result.output === '')
      .map((result) => `line ${result.index + 1}: ${lines[result.index]}`);
    // The one prose line is expected to stay silent; nothing else should.
    expect(silent).toEqual(['line 3: Type on the left, answers appear on the right.']);
  });

  it('resolves its line reference to the calculation it points at', () => {
    const reference = results.find(
      (result) => lines[result.index]?.startsWith('line 5 +'),
    );
    expect(reference?.output).toBe('508');
  });
});
