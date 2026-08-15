import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/index.js';
import { answers, TEST_NOW, TEST_RATES } from './helpers.js';

describe('variables', () => {
  it('assigns and reuses a single-word name', () => {
    expect(answers('rate = 12\nrate * 3')).toEqual(['12', '36']);
  });

  it('assigns and reuses a multi-word name', () => {
    expect(answers('monthly rent = 1500\nmonthly rent * 12')).toEqual([
      '1,500',
      '18,000',
    ]);
  });

  it('accepts a colon as the assignment operator', () => {
    expect(answers('deposit: 250\ndeposit * 4')).toEqual(['250', '1,000']);
  });

  it('carries units through a variable', () => {
    expect(answers('commute = 12 km\ncommute * 2')).toEqual(['12 km', '24 km']);
  });

  it('reports the assigned name on the result', () => {
    const [line] = createEngine().evaluate('take home pay = 4200');
    expect(line?.name).toBe('take home pay');
    expect(line?.kind).toBe('assignment');
  });

  it('does not treat a comparison as an assignment', () => {
    expect(answers('3 == 3')).toEqual(['true']);
  });
});

describe('line references', () => {
  it('references an earlier line by number', () => {
    expect(answers('10 * 10\nline 1 + 5')).toEqual(['100', '105']);
  });

  it('references the previous line', () => {
    expect(answers('7 * 6\nprev / 2')).toEqual(['42', '21']);
  });

  it('carries currency through a reference', () => {
    expect(answers('$80\nprev * 2')).toEqual(['$80.00', '$160.00']);
  });
});

describe('totals', () => {
  it('sums the lines above it', () => {
    expect(answers('10\n20\n30\nsum')).toEqual(['10', '20', '30', '60']);
  });

  it('accepts total and subtotal as aliases for sum', () => {
    expect(answers('5\n5\ntotal')).toEqual(['5', '5', '10']);
  });

  it('averages the lines above it', () => {
    expect(answers('10\n20\n60\naverage')).toEqual(['10', '20', '60', '30']);
  });

  it('counts the value lines above it', () => {
    expect(answers('10\nsome prose\n20\ncount')).toEqual(['10', '', '20', '2']);
  });

  it('starts a new section at a heading', () => {
    expect(answers('# Food\n10\n20\nsum\n\n# Travel\n5\nsum')).toEqual([
      '', '10', '20', '30', '', '', '5', '5',
    ]);
  });

  it('closes the section so stacked totals do not double-count', () => {
    expect(answers('10\n20\nsum\n30\nsum')).toEqual(['10', '20', '30', '30', '30']);
  });

  it('sums money', () => {
    expect(answers('$12.50\n$7.25\nsum')).toEqual(['$12.50', '$7.25', '$19.75']);
  });

  it('sums only the lines carrying a tag', () => {
    const sheet = [
      'lunch $12 #food',
      'train $4 #travel',
      'dinner $28 #food',
      'sum #food',
    ].join('\n');
    expect(answers(sheet)).toEqual(['$12.00', '$4.00', '$28.00', '$40.00']);
  });
});

describe('comments and headings', () => {
  it('ignores a trailing comment', () => {
    expect(answers('2 + 2 // this is four')).toEqual(['4']);
  });

  it('produces no answer for a heading or a comment-only line', () => {
    expect(answers('# Budget\n// just a note')).toEqual(['', '']);
  });
});

describe('engine construction', () => {
  it('exposes the currencies and rate date it was built with', () => {
    const engine = createEngine({ rates: TEST_RATES, now: TEST_NOW });
    expect(engine.rateDate).toBe('2026-08-14');
    expect(engine.currencies).toContain('EUR');
    expect(engine.currencies).toContain('USD');
  });

  it('works without a rate table at all', () => {
    expect(createEngine().evaluate('3 * 3')[0]?.output).toBe('9');
  });
});
