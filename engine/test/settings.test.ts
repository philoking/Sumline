import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/index.js';
import { DEFAULT_REGION, toNumberRegion } from '../src/numberFormat.js';
import { DEFAULT_FPS, toFps } from '../src/mathInstance.js';

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
