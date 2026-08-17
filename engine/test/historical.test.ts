import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/index.js';
import type { HistoricalRates, RateTable } from '../src/types.js';
import { TEST_NOW, TEST_RATES } from './helpers.js';

/** 1 January 2020 is a holiday, so the table it answers with is 31 December. */
const PAST: RateTable = {
  base: 'USD',
  date: '2019-12-31',
  rates: { EUR: 0.89, GBP: 0.755, JPY: 108.6 },
};

function engine(historicalRates: HistoricalRates = {}) {
  return createEngine({ rates: TEST_RATES, now: TEST_NOW, historicalRates });
}

function answer(line: string, historicalRates: HistoricalRates = {}) {
  const [result] = engine(historicalRates).evaluate(line);
  return { output: result?.output ?? '', error: result?.error };
}

describe('converting at a past date', () => {
  const supplied = { '2020-01-01': PAST };

  it('uses that date’s rate, not today’s', () => {
    // Today's table puts EUR at 0.8, so €80.00 would be the wrong answer.
    expect(answer('100 USD in EUR on 2020-01-01', supplied).output).toBe('€89.00');
    expect(answer('100 USD in EUR').output).toBe('€80.00');
  });

  it('reads the amount however it is written', () => {
    for (const line of [
      '100 USD in EUR on 2020-01-01',
      '$100 in EUR on 2020-01-01',
      'USD 100 in EUR on 2020-01-01',
      '100 usd to eur on 2020-01-01',
      '100 USD into EUR on 2020-01-01',
    ]) {
      expect(answer(line, supplied).output).toBe('€89.00');
    }
  });

  it('reads the date however it is written', () => {
    for (const line of [
      '100 USD in EUR on 2020-01-01',
      '100 USD in EUR on 1/1/2020',
      '100 USD in EUR on January 1 2020',
      '100 USD in EUR on 1 January 2020',
    ]) {
      expect(answer(line, supplied).output).toBe('€89.00');
    }
  });

  it('crosses two currencies through the base', () => {
    // (100 / 0.89) * 0.755
    expect(answer('100 EUR in GBP on 2020-01-01', supplied).output).toBe('£84.83');
  });

  it('groups and abbreviates the answer like any other money', () => {
    expect(answer('1,000 USD in JPY on 2020-01-01', supplied).output).toBe('¥108,600');
  });

  it('produces a value that totals with other money', () => {
    const sheet = engine(supplied);
    const results = sheet.evaluate('100 USD in EUR on 2020-01-01\n€11');
    expect(results.map((line) => line.output)).toEqual(['€89.00', '€11.00']);
    expect(sheet.total(results)).toBe('€100.00');
  });
});

describe('while the rates are still on their way', () => {
  it('answers nothing, without an error', () => {
    // A line must not flash red between being typed and its rates arriving.
    expect(answer('100 USD in EUR on 2020-01-01')).toEqual({
      output: '',
      error: undefined,
    });
  });
});

describe('when the rates cannot be had', () => {
  it('says so, rather than falling back to today', () => {
    // Converting a 2019 invoice at this morning's rate and saying nothing is the
    // exact failure this feature exists to remove.
    const result = answer('100 USD in EUR on 2020-01-01', { '2020-01-01': null });
    expect(result.output).toBe('');
    expect(result.error).toBe('No exchange rates available for 2020-01-01');
  });

  it('names a currency the table does not carry', () => {
    const thin: RateTable = { base: 'USD', date: '2019-12-31', rates: { EUR: 0.89 } };
    const result = answer('100 USD in GBP on 2020-01-01', { '2020-01-01': thin });
    expect(result.error).toBe('No GBP rate published for 2020-01-01');
  });
});

describe('reporting which dates a sheet wants', () => {
  it('lists each date once', () => {
    expect(
      engine().ratesNeeded(
        '100 USD in EUR on 2020-01-01\n$5 in GBP on 2020-01-01\n$9 in JPY on 2021-06-30',
      ),
    ).toEqual(['2020-01-01', '2021-06-30']);
  });

  it('asks for nothing on a sheet with no past conversions', () => {
    expect(engine().ratesNeeded('2 + 2\n100 USD in EUR\ntoday + 3 weeks')).toEqual([]);
  });

  it('ignores a request inside a comment', () => {
    // Nothing is going to convert on that line, so nothing should be fetched.
    expect(engine().ratesNeeded('// 100 USD in EUR on 2020-01-01')).toEqual([]);
  });
});

describe('lines this must not claim', () => {
  const supplied = { '2020-01-01': PAST };

  it('leaves ordinary conversions, dates and prose alone', () => {
    const cases: Array<[string, string]> = [
      ['100 USD in EUR', '€80.00'],
      ['5 km in miles', '3.106856 miles'],
      ['today + 3 weeks', 'Sat 5 Sep 2026'],
      ['3 days on holiday', '3 days'],
      ['days between 3 March and 30 May', '88 days'],
      ['$100 + €80', '€160.00'],
    ];
    for (const [line, expected] of cases) {
      expect(answer(line, supplied).output).toBe(expected);
    }
  });

  it('does not claim a line whose date will not parse', () => {
    // Falling through is right: a half-understood conversion should not answer.
    expect(answer('100 USD in EUR on someday', supplied).output).not.toBe('€89.00');
  });

  it('does not treat an unknown three-letter word as a currency', () => {
    expect(engine().ratesNeeded('100 USD in CAT on 2020-01-01')).toEqual([]);
  });
});
