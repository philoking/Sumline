import { describe, expect, it } from 'vitest';
import { engineOptionsFrom } from '../src/engineOptions';
import type { Settings } from '../src/api';

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

  it('passes the frame rate through', () => {
    expect(engineOptionsFrom({ fps: 30 })).toMatchObject({ fps: 30 });
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
    expect(options).not.toHaveProperty('fps');
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

  it('keeps display-only settings away from the engine', () => {
    // The corner statistic, the total's visibility and the sidebar order are the
    // app's business; the engine has no opinion about any of them.
    const options = engineOptionsFrom({
      statistic: 'median',
      showTotal: false,
      sheetOrder: 'manual',
    });
    expect(Object.keys(options)).toEqual(['largeNumberNotation']);
  });

  it('carries every computed setting at once', () => {
    // The regression in full: all four together, since dropping one is exactly
    // what went unnoticed before.
    const options = engineOptionsFrom({
      region: 'eastern-europe',
      fps: 25,
      zone: 'Europe/Berlin',
      holidayCountry: 'DE',
      largeNumberNotation: false,
      effectiveGlobals: { vat: '20%' },
    });
    expect(options).toEqual({
      region: 'eastern-europe',
      fps: 25,
      zone: 'Europe/Berlin',
      holidayCountry: 'DE',
      largeNumberNotation: false,
      globals: { vat: '20%' },
    });
  });
});
