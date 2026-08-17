import { describe, expect, it } from 'vitest';
import { engineOptionsFrom, type EngineSettings } from '../src/settings.js';

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
    const settings: EngineSettings = {
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
