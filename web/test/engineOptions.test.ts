import { describe, expect, it } from 'vitest';
import type { EngineOptions } from '@webcalc/engine';
import { engineOptionsFrom } from '../src/engineOptions';
import { engineInputs } from '../src/useEngine';
import type { HolidayTable, Settings } from '../src/api';

/**
 * The bug this guards is not a wrong value but a missing one.
 *
 * `region` was an engine option, implemented and documented, and simply never
 * passed — so setting it did nothing at all and no test failed. A setting that
 * silently fails to reach the engine looks exactly like a setting that does not
 * work, and neither the engine's tests nor the server's could see it.
 */
describe('the settings that reach the engine', () => {
  it('passes the region through', () => {
    expect(engineOptionsFrom({ region: 'western-europe' })).toMatchObject({
      region: 'western-europe',
    });
  });

  it('passes the timezone through', () => {
    expect(engineOptionsFrom({ zone: 'Europe/Berlin' })).toMatchObject({
      zone: 'Europe/Berlin',
    });
  });

  it('omits what is unset, rather than guessing at the engine’s defaults', () => {
    // A default repeated here is a default that can disagree with the engine's.
    const options = engineOptionsFrom({});
    expect(options).not.toHaveProperty('region');
    expect(options).not.toHaveProperty('zone');
    expect(options).not.toHaveProperty('globals');
  });

  it('prefers the resolved globals to this space’s own', () => {
    // The server owns precedence between a space and Everywhere, so the client
    // must not re-derive it.
    const settings: Settings = {
      globals: { vat: '20%' },
      sharedGlobals: { vat: '5%', mileage: '$0.68' },
      effectiveGlobals: { vat: '20%', mileage: '$0.68' },
    };
    expect(engineOptionsFrom(settings).globals).toEqual({
      vat: '20%',
      mileage: '$0.68',
    });
  });

  it('falls back to a space’s own globals when nothing is resolved', () => {
    expect(engineOptionsFrom({ globals: { vat: '20%' } }).globals).toEqual({
      vat: '20%',
    });
  });

  it('treats an absent notation preference as on', () => {
    expect(engineOptionsFrom({}).largeNumberNotation).toBe(true);
    expect(engineOptionsFrom({ largeNumberNotation: false }).largeNumberNotation).toBe(
      false,
    );
  });

  /*
   * How an answer is *written* is the engine's business, because the engine is
   * what writes it — notation, precision, separators and currency rounding all
   * end up in its `FormatContext`. How the app is *arranged* is not.
   */
  it('treats the other number-format settings as on when absent', () => {
    expect(engineOptionsFrom({}).thousandsSeparators).toBe(true);
    expect(engineOptionsFrom({}).currencyRounding).toBe(true);
    expect(engineOptionsFrom({ thousandsSeparators: false }).thousandsSeparators).toBe(
      false,
    );
    expect(engineOptionsFrom({ currencyRounding: false }).currencyRounding).toBe(false);
  });

  it('leaves precision off entirely when unset, so the engine owns the default', () => {
    expect('precision' in engineOptionsFrom({})).toBe(false);
    expect(engineOptionsFrom({ precision: 2 }).precision).toBe(2);
    // Zero is a real choice and must survive, which `?? 10` would have eaten.
    expect(engineOptionsFrom({ precision: 0 }).precision).toBe(0);
  });

  it('keeps settings about the app, rather than the answer, away from the engine', () => {
    // The corner statistic, the total's visibility, the sidebar order, the text
    // size and the gutter are all the app's business; the engine has no opinion
    // about any of them.
    const options = engineOptionsFrom({
      statistic: 'median',
      showTotal: false,
      sheetOrder: 'manual',
      sheetFontSize: 22,
      showLineNumbers: false,
      countVariablesInTotal: false,
      countReferencedInTotal: false,
    });
    expect(Object.keys(options).sort()).toEqual([
      'currencyRounding',
      'largeNumberNotation',
      'thousandsSeparators',
    ]);
  });

  it('carries every computed setting at once', () => {
    // The regression in full: all four together, since dropping one is exactly
    // what went unnoticed before.
    const options = engineOptionsFrom({
      region: 'eastern-europe',
      zone: 'Europe/Berlin',
      largeNumberNotation: false,
      effectiveGlobals: { vat: '20%' },
    });
    expect(options).toEqual({
      region: 'eastern-europe',
      zone: 'Europe/Berlin',
      largeNumberNotation: false,
      thousandsSeparators: true,
      currencyRounding: true,
      globals: { vat: '20%' },
    });
  });
});

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
