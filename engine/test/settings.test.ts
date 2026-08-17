import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/index.js';
import { DEFAULT_REGION, toNumberRegion } from '../src/numberFormat.js';
import { DEFAULT_FPS, toFps } from '../src/mathInstance.js';
import { PRECISIONS } from '../src/format.js';

/**
 * Settings that change what a sheet computes, and what happens when one arrives
 * malformed.
 *
 * Not a hypothetical: the README documents writing settings with `curl`, so
 * these values reach the engine from outside TypeScript's reach. Both used to be
 * passed straight through, and both failed silently rather than loudly — an
 * unknown region left every numeric line answering nothing at all, which reads
 * as a broken app rather than a bad setting.
 */

function answer(line: string, options: Parameters<typeof createEngine>[0] = {}) {
  return createEngine(options).evaluate(line)[0]?.output ?? '';
}

describe('the number region', () => {
  it('formats according to the region it is given', () => {
    expect(answer('1234567.89 in full', { region: 'north-america' })).toBe('1,234,567.89');
    expect(answer('1234567.89 in full', { region: 'western-europe' })).toBe('1.234.567,89');
    expect(answer('1234567.89 in full', { region: 'eastern-europe' })).toBe('1 234 567,89');
  });

  it('reads input by the same convention it writes', () => {
    // The half that makes this more than a display preference: the same line
    // means different numbers under the two regions, so changing the setting
    // changes what an existing sheet computes.
    expect(answer('1.234 + 1', { region: 'western-europe' })).toBe('1.235');
    expect(answer('1.234 + 1', { region: 'north-america' })).toBe('2.234');
  });

  it('falls back to the default rather than answering nothing', () => {
    // The failure this guards: with no coercion, REGION_SEPARATORS has no entry,
    // and every numeric line in the sheet renders as an empty string.
    expect(answer('1234567.89 in full', { region: 'nonsense' as never })).toBe(
      '1,234,567.89',
    );
  });

  it('coerces anything unrecognised to the default', () => {
    expect(toNumberRegion('western-europe')).toBe('western-europe');
    for (const value of ['nonsense', '', 'NORTH-AMERICA', null, undefined, 7, {}]) {
      expect(toNumberRegion(value)).toBe(DEFAULT_REGION);
    }
  });
});

describe('the default frame rate', () => {
  it('is used by a timecode that names none', () => {
    expect(answer('00:30:10:00 in frames')).toBe('43,440 frames');
    expect(answer('00:30:10:00 in frames', { fps: 30 })).toBe('54,300 frames');
  });

  it('is still overridden by a rate written on the line', () => {
    expect(answer('00:30:10:00 @ 24 fps in frames', { fps: 30 })).toBe('43,440 frames');
  });

  it('refuses a rate that cannot be divided by', () => {
    // Zero turned every timecode into a parse error and a negative one answered
    // with negative frames, both silently.
    for (const fps of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(answer('00:30:10:00 in frames', { fps })).toBe('43,440 frames');
    }
  });

  it('coerces anything unusable to the default', () => {
    expect(toFps(30)).toBe(30);
    expect(toFps(23.976)).toBe(23.976);
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '30', null, undefined]) {
      expect(toFps(value)).toBe(DEFAULT_FPS);
    }
  });
});

/**
 * Precision, at each of the values the menu actually offers.
 *
 * These are regression tests for two faults that were invisible for as long as
 * the setting was hardcoded to six and immediate the moment it could be ten.
 * Both were silent — nothing threw, and the answers stayed plausible — so what
 * pins them is the exact digits, not that a number came back.
 *
 * `in full` on each line switches off large-number notation, which would
 * otherwise abbreviate these to `1.23M` and answer nothing about precision.
 */
describe('the precision ceiling', () => {
  it('does not print more significant digits than a double carries', () => {
    // Ten decimals of a seven-digit number is seventeen significant figures.
    // `toFixed(10)` prints them faithfully — `1,234,567.8899999999` — which
    // describes the representation rather than the answer. The requested
    // precision is capped by the digits left after the whole part.
    expect(answer('1234567.89 in full', { precision: 10 })).toBe('1,234,567.89');
    expect(answer('1234567.89 in full', { precision: 15 })).toBe('1,234,567.89');
  });

  it('rounds a large number without overflowing on the way', () => {
    // The rounding used to multiply by `10 ** places`; at 1,234,567.89 × 1e10
    // the product is past 2^53 and the low digits are gone before anything is
    // rounded. `toFixed` does the rounding instead.
    expect(answer('1234567.89 in full', { precision: 0 })).toBe('1,234,568');
    expect(answer('1234567.89 in full', { precision: 1 })).toBe('1,234,567.9');
  });

  it('keeps the digits of a small number, which the cap must not flatten', () => {
    // The cap spends the significant-digit budget on the whole part first, so a
    // number with no whole part to speak of keeps all of it.
    expect(answer('0.0004935834', { precision: 10 })).toBe('0.0004935834');
    expect(answer('0.0004935834', { precision: 15 })).toBe('0.0004935834');
  });

  it('leaves a whole number whole at zero decimals', () => {
    // `'1000'.replace(/\.?0+$/, '')` is `'1'`: with no decimal point in the
    // string there is nothing for the trailing-zero trim to stop at. Only
    // reachable once precision could be 0.
    expect(answer('1000', { precision: 0 })).toBe('1,000');
    expect(answer('1000', { precision: 0, thousandsSeparators: false })).toBe('1000');
    expect(answer('1,000,000 in full', { precision: 0 })).toBe('1,000,000');
  });

  it('collapses float noise at every precision that has room for the answer', () => {
    // 0.1 + 0.2 is the reason `toPrecision(12)` runs before any of this; a
    // precision high enough to expose 0.30000000000000004 must not.
    for (const precision of PRECISIONS) {
      const expected = precision === 0 ? '0' : '0.3';
      expect(answer('0.1 + 0.2', { precision })).toBe(expected);
    }
  });

  it('is a ceiling rather than a width', () => {
    // Trailing zeros are still trimmed, so a high precision does not pad.
    for (const precision of PRECISIONS) {
      if (precision === 0) continue;
      expect(answer('20.50', { precision })).toBe('20.5');
    }
  });

  it('gives each offered precision the decimals it asks for', () => {
    const expected: Record<number, string> = {
      0: '0',
      1: '0.3',
      2: '0.33',
      3: '0.333',
      4: '0.3333',
      5: '0.33333',
      10: '0.3333333333',
      // Eleven threes, not fifteen: twelve significant digits is what the
      // double is trusted for, and the leading zero is not one of them.
      15: '0.33333333333',
    };
    for (const precision of PRECISIONS) {
      expect(answer('1/3', { precision })).toBe(expected[precision]);
    }
  });
});
