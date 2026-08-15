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
