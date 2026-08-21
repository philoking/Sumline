import { describe, expect, it } from 'vitest';
import { SHEET_COLORS, colorClass, colorLabel } from '../src/colors';

describe('colorClass', () => {
  it('paints a row for every colour the app offers', () => {
    for (const color of SHEET_COLORS) {
      expect(colorClass(color.id), color.id).toBe(` tinted tint-${color.id}`);
    }
  });

  it('leaves a row plain rather than trusting an unknown token', () => {
    // The stored value can come from a newer version of the app or from a hand
    // edit, and it lands in a class attribute either way. Anything not on the
    // list has to produce no class at all.
    for (const value of ['chartreuse', 'tint-red', 'red ', 'RED', '', '../evil']) {
      expect(colorClass(value), JSON.stringify(value)).toBe('');
    }
  });

  it('treats absent and null as no colour', () => {
    expect(colorClass(null)).toBe('');
    expect(colorClass(undefined)).toBe('');
  });
});

describe('colorLabel', () => {
  it('names every colour the app offers', () => {
    for (const color of SHEET_COLORS) {
      expect(colorLabel(color.id), color.id).toBe(color.label);
    }
  });

  it('falls back for anything it does not know', () => {
    for (const value of ['chartreuse', null, undefined, '']) {
      expect(colorLabel(value)).toBe('No colour');
    }
  });
});

describe('the palette itself', () => {
  it('has no duplicate ids, which would make two swatches the same row', () => {
    const ids = SHEET_COLORS.map((color) => color.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
