import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/index.js';
import type { EngineOptions } from '../src/types.js';
import { TEST_NOW, TEST_RATES } from './helpers.js';

/**
 * Formatting is a view, held to it.
 *
 * The README states it plainly: `to N dp` is cosmetic, and totals and line
 * references still use the unrounded value. It is one of the load-bearing
 * promises of the answer column and nothing asserted it.
 *
 * The wider version of the same gap is that almost every golden case runs in
 * one default context, while `precision`, `region`, `thousandsSeparators`,
 * `currencyRounding`, `largeNumberNotation`, `zone` and `fps` each multiply the
 * behaviour of every case in the suite. The settings have tests of their own;
 * what had none is the claim that they are orthogonal to what gets *computed*.
 * That habit is what let six README rows sit at 6 dp against a default
 * precision of 10 with nothing noticing (#106).
 *
 * So: output strings may change with the settings — that is what they are for.
 * Computed values may not.
 */

/**
 * The settings that decide only how an answer is shown.
 *
 * `region` is deliberately not among them. It is the one setting that also
 * decides how a literal is *read* — `1.234,56` is a thousand under western
 * Europe and a decimal under North America — so a sheet is not the same sheet
 * across two of them. That claim gets its own tests at the bottom, where the
 * literal is written each way round.
 */
const CONTEXTS: Array<{ name: string; options: EngineOptions }> = [
  { name: 'the defaults', options: {} },
  { name: 'precision 0', options: { precision: 0 } },
  { name: 'precision 2', options: { precision: 2 } },
  { name: 'precision 15', options: { precision: 15 } },
  { name: 'no thousands separators', options: { thousandsSeparators: false } },
  { name: 'no currency rounding', options: { currencyRounding: false } },
  { name: 'no large-number notation', options: { largeNumberNotation: false } },
  { name: 'a pinned zone', options: { zone: 'Europe/Berlin' } },
  { name: 'a different frame rate', options: { fps: 25 } },
  {
    name: 'several at once',
    options: {
      precision: 2,
      thousandsSeparators: false,
      currencyRounding: false,
      largeNumberNotation: false,
    },
  },
];

const engineFor = (options: EngineOptions) =>
  createEngine({ rates: TEST_RATES, now: TEST_NOW, ...options });

/** The numbers a sheet worked out, as against the numbers it printed. */
function computed(source: string, options: EngineOptions = {}): unknown[] {
  return engineFor(options)
    .evaluate(source)
    .map((line) => line.value)
    .filter((value) => value !== undefined);
}

/** What the sheet printed, for the assertions about the other half. */
function printed(source: string, options: EngineOptions = {}): string[] {
  return engineFor(options)
    .evaluate(source)
    .map((line) => line.output);
}

const SHEETS: Array<{ name: string; source: string }> = [
  {
    name: 'a sheet reading its own earlier lines',
    source: ['10', '20', 'prev + 5', 'line 1 * 2'].join('\n'),
  },
  {
    name: 'a sheet whose values do not survive rounding',
    source: ['1 / 3', 'prev * 3', 'line 1 + line 2'].join('\n'),
  },
  {
    name: 'a section with a subtotal read by the line after it',
    source: ['# Groceries', '12.5', '7.25', 'sum', 'prev * 2'].join('\n'),
  },
  {
    name: 'a sheet built out of named amounts',
    source: ['apples = 3', 'oranges = 4.5', 'apples + oranges', 'prev / 2'].join('\n'),
  },
  {
    name: 'a sheet in the thousands, where the separators differ',
    source: ['1234.5', 'prev * 1000', 'line 1 + line 2'].join('\n'),
  },
];

describe('the settings change what is printed and not what is computed', () => {
  for (const sheet of SHEETS) {
    describe(sheet.name, () => {
      const baseline = computed(sheet.source);

      it('works something out at all', () => {
        // Guards the assertions below from passing on an empty list, which is
        // what a sheet whose syntax quietly stopped parsing would give them.
        expect(baseline.length).toBeGreaterThan(1);
        expect(baseline.every((value) => typeof value === 'number')).toBe(true);
      });

      for (const context of CONTEXTS) {
        it(`lands on the same numbers under ${context.name}`, () => {
          expect(computed(sheet.source, context.options)).toEqual(baseline);
        });
      }
    });
  }

  it('really is printing differently under those settings', () => {
    // Otherwise every assertion above could be passing because the contexts
    // are doing nothing at all.
    const source = '10000 / 3';
    expect(printed(source, { precision: 2 })).not.toEqual(printed(source));
    expect(printed(source, { region: 'western-europe' })).not.toEqual(printed(source));
    expect(printed('1234567', { largeNumberNotation: false })).not.toEqual(
      printed('1234567'),
    );
    expect(printed('1234.5', { thousandsSeparators: false })).not.toEqual(
      printed('1234.5'),
    );
  });
});

describe('formatting written into a line', () => {
  it('does not change what a later line reading it computes', () => {
    // The README's own promise: `to N dp` is cosmetic, and a reference to that
    // line still gets the unrounded value.
    const rounded = computed(['1 / 3 to 2 dp', 'prev * 3'].join('\n'));
    const plain = computed(['1 / 3', 'prev * 3'].join('\n'));
    expect(rounded).toEqual(plain);
    expect(rounded[1]).toBeCloseTo(1, 10);
  });

  it('does not change what the total counts', () => {
    const rounded = engineFor({});
    const results = rounded.evaluate(['1 / 3 to 2 dp', '2 / 3'].join('\n'));
    // A third and two thirds are one, whatever the first line chose to show.
    expect(rounded.total(results)).toBe('1');
  });

  it('is still doing something to the line it is written on', () => {
    expect(printed('1 / 3 to 2 dp')[0]).toBe('0.33');
    expect(printed('1 / 3')[0]).toBe('0.3333333333');
  });
});

describe('the number region', () => {
  it('reads a European literal as the same number North America writes', () => {
    const european = computed('1.234,56 + 1', { region: 'western-europe' });
    const american = computed('1,234.56 + 1');
    expect(european).toEqual(american);
    // The line's answer, not the literal's: both read the thousand and add one.
    expect(american[0]).toBeCloseTo(1235.56, 10);
  });

  it('agrees about the arithmetic downstream of it', () => {
    const source = ['1.234,56', 'prev / 2', 'line 1 + line 2'].join('\n');
    const european = computed(source, { region: 'western-europe' });
    const american = computed(['1,234.56', 'prev / 2', 'line 1 + line 2'].join('\n'));
    expect(european).toEqual(american);
  });
});
