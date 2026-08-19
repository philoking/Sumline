import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/index.js';
import { TEST_RATES } from './helpers.js';

/**
 * Whole sheets, answer column and all.
 *
 * Nearly every other case in this suite is one line in, one answer out. That
 * shape suits the parts math.js does the work for and suits the parts WebCalc
 * owns very badly: the sheet-level rules are all multi-line and all interact —
 * sections, `sum` closing one so stacked totals do not double-count, tag
 * buckets, `prev` tracking the last line that produced a value, `referenced`,
 * per-line formatting, headings partitioning the sheet. A bug living in the
 * *combination* of two of those has nothing standing in its way, because a
 * single-line table will never enumerate the combinations.
 *
 * So these are realistic sheets rather than minimal ones, each written to mix
 * several features on purpose, and each pinned in full. A change anywhere in
 * the engine shows up as a diff in an `.answers` file, beside the line of the
 * sheet that produced it.
 *
 * The fixtures are two files rather than a snapshot: a snapshot written inside
 * the Docker test stage is written to a container that is then thrown away, so
 * the first run would create it, pass, and pin nothing at all.
 *
 * Nothing here names a date. `now` is deliberately absent from the context so
 * these cannot start failing at midnight, and the sheets are built out of
 * durations and amounts instead.
 */
const engine = createEngine({ rates: TEST_RATES });

const FIXTURES = new URL('./fixtures/', import.meta.url);

const read = (file: string): string => readFileSync(new URL(file, FIXTURES), 'utf8');

/** A fixture file's lines, without the newline every text file ends with. */
const lines = (file: string): string[] => read(file).replace(/\n$/, '').split('\n');

const sheets = readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.sheet'))
  .map((name) => name.replace(/\.sheet$/, ''))
  .sort();

describe('golden sheets', () => {
  it('found the fixtures', () => {
    // A directory that failed to resolve would otherwise empty this file and
    // take the whole sheet surface with it, silently.
    expect(sheets.length).toBeGreaterThanOrEqual(10);
  });

  for (const name of sheets) {
    it(`${name} answers exactly as recorded`, () => {
      const source = lines(`${name}.sheet`);
      const expected = lines(`${name}.answers`);
      const actual = engine.evaluate(source.join('\n')).map((line) => line.output);

      // Compared line by line against the sheet, so a failure names the line
      // that moved rather than handing over two long arrays to diff by eye.
      expect(actual.map((answer, index) => `${source[index]} → ${answer}`)).toEqual(
        expected.map((answer, index) => `${source[index]} → ${answer}`),
      );
    });

    it(`${name} has an answer recorded for every line`, () => {
      // The two files are kept in step by hand, and a sheet that grew a line
      // without its answer would otherwise compare short and pass.
      expect(lines(`${name}.answers`)).toHaveLength(lines(`${name}.sheet`).length);
    });
  }
});
