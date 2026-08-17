import { describe, expect, it } from 'vitest';
import { engineOptionsFrom, type EngineOptions } from '@webcalc/engine';
import { engineInputs } from '../src/useEngine';
import type { HolidayTable } from '../src/api';

/**
 * The second half of the same boundary, and the half that has actually broken.
 *
 * `engineOptionsFrom` decides what to send; `engineInputs` is what hands it to
 * `createEngine`. Between the two, options have now been silently dropped
 * twice — `region` once, `zone` a second time — because this step was written
 * as a field-by-field copy rather than a spread, and a copy that omits a field
 * looks exactly like a setting that does not work.
 */
describe('the options that reach the engine', () => {
  const HOLIDAYS: HolidayTable = {
    country: 'US',
    dates: ['2026-07-04'],
    years: [2026],
  };

  it('passes through every key the settings layer produced', () => {
    // Derived from `engineOptionsFrom`'s own output rather than a list written
    // out here, so this asserts about whatever that function currently sends
    // rather than about what it sent the day the test was written.
    const produced = engineOptionsFrom({
      region: 'eastern-europe',
      zone: 'Europe/Berlin',
      precision: 15,
      largeNumberNotation: false,
      thousandsSeparators: false,
      currencyRounding: false,
      effectiveGlobals: { vat: '20%' },
    });

    // Without this the loop below passes vacuously on an empty object.
    expect(Object.keys(produced).length).toBeGreaterThan(5);

    const inputs = engineInputs(produced, null, null, {});
    for (const [key, value] of Object.entries(produced)) {
      expect(inputs[key as keyof EngineOptions]).toEqual(value);
    }
  });

  /*
   * The one that covers the *next* option rather than the current ones.
   *
   * Every other test here names a key, so every one of them had to be written
   * after the option existed — which is why neither previous fix stopped the
   * bug coming back. Nothing about this one needs to know what the key is, so
   * an option added tomorrow is covered by a test written today. It is also
   * the test a field-by-field copy cannot be made to pass, however carefully
   * the fields are listed.
   */
  it('passes through a key it has never heard of', () => {
    const inputs = engineInputs(
      { zone: 'Asia/Tokyo', notYetInvented: 'kept' } as EngineOptions,
      null,
      null,
      {},
    );
    expect(inputs).toMatchObject({ zone: 'Asia/Tokyo', notYetInvented: 'kept' });
  });

  it('adds what the hook fetched for itself', () => {
    const rates = { base: 'USD', date: '2026-08-14', rates: { EUR: 0.8 } };
    const history = { '2020-01-01': null };
    const inputs = engineInputs({}, rates, HOLIDAYS, history);
    expect(inputs.rates).toBe(rates);
    // The dates, not the table: the country and staleness are the app's.
    expect(inputs.holidays).toEqual(['2026-07-04']);
    expect(inputs.historicalRates).toBe(history);
  });

  it('leaves an unfetched table absent rather than present and empty', () => {
    // `holidays: undefined` and no `holidays` key read the same to the engine
    // today, but an empty array would not: it says the year has no holidays,
    // which would quietly change every workday calculation.
    const inputs = engineInputs({}, null, null, {});
    expect('rates' in inputs).toBe(false);
    expect('holidays' in inputs).toBe(false);
  });

  it('lets the fetched tables win over any the caller passed', () => {
    // The fetch is the live one; the caller's would be a stale copy. This is a
    // statement about the order of the spread, which is easy to reverse while
    // tidying and impossible to notice from the answers.
    const stale = { base: 'USD', date: '2020-01-01', rates: { EUR: 0.9 } };
    const fresh = { base: 'USD', date: '2026-08-14', rates: { EUR: 0.8 } };
    const inputs = engineInputs({ rates: stale, historicalRates: { x: null } }, fresh, null, {});
    expect(inputs.rates).toBe(fresh);
    expect(inputs.historicalRates).toEqual({});
  });
});
