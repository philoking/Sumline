import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/index.js';
import { TEST_NOW, TEST_RATES } from './helpers.js';

const engine = createEngine({ rates: TEST_RATES, now: TEST_NOW });

function answers(source: string): string[] {
  return engine.evaluate(source).map((line) => line.output);
}

// Issue #30 — variable ergonomics
describe('variables', () => {
  it('redefines a name from that line down', () => {
    expect(
      answers(
        [
          'monthly rent = 1900 // 2018',
          'monthly rent = 2150 // 2019',
          'monthly rent / 4',
        ].join('\n'),
      ),
    ).toEqual(['1,900', '2,150', '537.5']);
  });

  it('modifies a variable in place with += and -=', () => {
    expect(answers('budget = 100\nbudget += 50\nbudget -= 20\nbudget')).toEqual([
      '100',
      '150',
      '130',
      '130',
    ]);
  });

  it('folds compound assignment into money too', () => {
    expect(answers('pot = $100\npot += $25.50')).toEqual(['$100.00', '$125.50']);
  });

  it('refuses to see a variable before it is declared', () => {
    // Deliberate, and consistent with programming languages.
    expect(answers('rate * 2\nrate = 10')).toEqual(['', '10']);
  });

  it('binds global variables before the sheet runs', () => {
    const withGlobals = createEngine({
      rates: TEST_RATES,
      now: TEST_NOW,
      globals: { 'day rate': '$550', vat: '20%' },
    });
    expect(withGlobals.evaluate('day rate * 5')[0]?.output).toBe('$2,750.00');
    expect(withGlobals.evaluate('1000 + vat')[0]?.output).toBe('1,200');
  });

  it('lets a sheet shadow a global', () => {
    const withGlobals = createEngine({
      rates: TEST_RATES,
      now: TEST_NOW,
      globals: { 'day rate': '$550' },
    });
    expect(
      withGlobals.evaluate('day rate = $600\nday rate * 2').map((l) => l.output),
    ).toEqual(['$600.00', '$1,200.00']);
  });
});

// Issue #29 — the configurable floating total
describe('sheet summary', () => {
  const sheet = '10\n20\n60\n30';

  it('reports each statistic over the same values', () => {
    const results = engine.evaluate(sheet);
    expect(engine.summary(results, 'total')).toBe('120');
    expect(engine.summary(results, 'average')).toBe('30');
    expect(engine.summary(results, 'count')).toBe('4');
    expect(engine.summary(results, 'median')).toBe('25');
  });

  it('takes the middle value when the count is odd', () => {
    const results = engine.evaluate('10\n20\n60');
    expect(engine.summary(results, 'median')).toBe('20');
  });

  it('works on money', () => {
    const results = engine.evaluate('$10\n$20\n$60');
    expect(engine.summary(results, 'average')).toBe('$30.00');
    expect(engine.summary(results, 'median')).toBe('$20.00');
  });

  it('total() and summary(total) agree', () => {
    const results = engine.evaluate(sheet);
    expect(engine.total(results)).toBe(engine.summary(results, 'total'));
  });

  it('is empty when nothing can be combined', () => {
    const results = engine.evaluate('5 km\n10 USD');
    expect(engine.summary(results, 'total')).toBe('');
  });
});

describe('median as a line directive', () => {
  it('takes the median of the section above', () => {
    expect(answers('10\n20\n60\nmedian')).toEqual(['10', '20', '60', '20']);
  });
});

// Issue #28 — per-line formatting, expressed in the text itself
describe('per-line formatting', () => {
  it('writes a number out in full on request', () => {
    expect(answers('100,000 + 200,000')).toEqual(['300k']);
    expect(answers('100,000 + 200,000 in full')).toEqual(['300,000']);
    expect(answers('2,469,134 as plain')).toEqual(['2,469,134']);
  });

  it('still honours decimal places alongside it', () => {
    expect(answers('1/3 to 2 dp')).toEqual(['0.33']);
  });
});
