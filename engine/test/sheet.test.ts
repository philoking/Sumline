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

  // A colon marks a label, not an assignment — see the comment-forms tests.
  it('does not treat a colon as an assignment operator', () => {
    expect(answers('deposit: 250\ndeposit * 4')).toEqual(['250', '']);
  });

  it('carries units through a variable', () => {
    expect(answers('commute = 12 km\ncommute * 2')).toEqual(['12 km', '24 km']);
  });

  /*
   * A variable named after a unit used to replace that unit for every line
   * below it, almost always without an error: `2 hours` quietly became
   * thirteen. The unit wins where only a unit can go — straight after a
   * number — and the variable wins everywhere else.
   */
  describe('a name that is also a unit', () => {
    it('leaves the unit alone directly after a number', () => {
      expect(answers('hours = 6.5\n2 hours + 45 minutes')).toEqual([
        '6.5',
        '2.75 hours',
      ]);
      expect(answers('days = 3\n2 days + 1 day')).toEqual(['3', '3 days']);
      expect(answers('kg = 10\n5 kg in g')).toEqual(['10', '5,000 g']);
    });

    it('protects a unit that is only spelled in upper case', () => {
      expect(answers('W = 4\n65 W in kW')).toEqual(['4', '0.065 kW']);
    });

    it('still resolves the variable everywhere else', () => {
      expect(answers('hours = 6.5\nhours * 2')).toEqual(['6.5', '13']);
    });

    it('does not guard a name that is not a unit', () => {
      expect(answers('apples = 5\n3 apples')).toEqual(['5', '15']);
      expect(answers('w = 4\n3 w')).toEqual(['4', '12']);
    });

    it('keeps a sheet consistent from top to bottom', () => {
      const sheet = 'hours = 6.5\ndraw = 65 W\ndraw * 24 hours in kWh';
      expect(answers(sheet)[2]).toBe('1.56 kWh');
    });
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
