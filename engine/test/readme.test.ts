import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/index.js';
import {
  REFERENCE_HISTORICAL_RATES,
  REFERENCE_HOLIDAYS,
  REFERENCE_NOW,
  REFERENCE_RATES,
} from '../src/examples.js';

/**
 * README.md's example tables, evaluated the way `examples.ts` is.
 *
 * `examples.ts` cannot claim behaviour the engine lacks, because
 * `examples.test.ts` runs every entry in it and asserts the answer shown. The
 * README's `| You type | You get |` tables have exactly the same shape, are the
 * documentation a contributor reads first, and were pinned by nothing — by the
 * time anyone checked, seven rows disagreed with the engine.
 *
 * Against the same fixed context the in-app reference documents, so the two
 * cannot describe the same line differently either, which is how six of those
 * seven came about: written rounded to 6 dp while the default precision is 10.
 */
const engine = createEngine({
  rates: REFERENCE_RATES,
  now: REFERENCE_NOW,
  holidays: REFERENCE_HOLIDAYS,
  historicalRates: REFERENCE_HISTORICAL_RATES,
});

/**
 * Sections whose answers are read in a named zone rather than the machine's.
 *
 * A Unix timestamp is absolute; the date it renders as is not. The README says
 * which reader those rows assume, and pinning the same zone here is what turns
 * that sentence from a claim into something checked — while keeping the suite
 * green for whoever runs it, wherever they are.
 *
 * Everything else stays on the local clock deliberately. `REFERENCE_NOW` is
 * built from local parts, so a date answer is the same in Tokyo as in CI; a
 * zone forced over the top of that would break the rows it was meant to fix.
 */
const ZONED: Record<string, string> = { Timestamps: 'America/Los_Angeles' };

const zoned = new Map<string, ReturnType<typeof createEngine>>();

function engineFor(heading: string): ReturnType<typeof createEngine> {
  const zone = ZONED[heading];
  if (!zone) return engine;
  const existing = zoned.get(zone);
  if (existing) return existing;
  const made = createEngine({
    rates: REFERENCE_RATES,
    now: REFERENCE_NOW,
    holidays: REFERENCE_HOLIDAYS,
    historicalRates: REFERENCE_HISTORICAL_RATES,
    zone,
  });
  zoned.set(zone, made);
  return made;
}

const README = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

interface Row {
  /** 1-based line in README.md, so a failure says where to go and correct it. */
  line: number;
  /** The `You type` cell verbatim, which is also how a row is named below. */
  raw: string;
  inputs: string[];
  answers: string[];
  /** Whatever the `You get` cell says outside its code spans. */
  describes: string;
  /** The section the table sits under, which is how a zone is picked above. */
  heading: string;
}

/**
 * Splits a table line into cells, honouring the escaped pipe.
 *
 * ``| `5 & 3`, `5 \| 3`, `bitXor(5, 3)` | `1`, `7`, `6` |`` is a real row: a
 * naive `split('|')` reads it as five cells and reports a row that is right.
 */
function cells(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  for (let i = 1; i < line.length; i += 1) {
    if (line[i] === '\\' && line[i + 1] === '|') {
      cell += '|';
      i += 1;
      continue;
    }
    if (line[i] === '|') {
      out.push(cell.trim());
      cell = '';
      continue;
    }
    cell += line[i];
  }
  return out;
}

const spans = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map(([, span]) => span!);

/** A cell with its code spans and the punctuation between them taken out. */
const outsideSpans = (cell: string): string =>
  cell.replace(/`[^`]+`/g, '').replace(/\bor\b/g, '').replace(/[,/\s]/g, '');

/**
 * Every row of every `| You type | You get |` table.
 *
 * Only those: `| Form | Example |` and `| Shortcut | Action |` are not engine
 * input, and running them would fail for reasons that are not drift.
 */
function readmeRows(): Row[] {
  const rows: Row[] = [];
  let inTable = false;
  let heading = '';
  for (const [index, text] of README.split('\n').entries()) {
    const line = text.trim();
    const title = /^#+\s+(.*)$/.exec(line);
    if (title) heading = title[1]!.trim();
    if (/^\|\s*You type\s*\|\s*You get\s*\|$/.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.startsWith('|')) {
      inTable = false;
      continue;
    }
    if (/^\|[\s:|-]+\|$/.test(line)) continue;
    const [typed = '', got = ''] = cells(line);
    rows.push({
      line: index + 1,
      raw: typed,
      inputs: spans(typed),
      answers: spans(got),
      describes: outsideSpans(got),
      heading,
    });
  }
  return rows;
}

/**
 * Rows deliberately left unchecked, and why.
 *
 * Named rather than silently dropped: a row whose answer is described in words
 * looks exactly like a row a parser quietly failed to read, and the difference
 * is the whole value of this file. Anything falling out of the checked set
 * without being listed here is a mistake, which is what the last test says.
 */
const UNPINNED: Record<string, string> = {
  '`$3k`, `$9bn`, `€6M`, `£12tn`': 'one description covering four inputs',
  '`5.5 rounded` / `rounded up` / `rounded down`':
    'the second and third are endings of the first, not lines on their own',
  '`e`, `tau`, `phi`': 'the answer names the constants rather than quoting them',
  '`100 USD in EUR on 2020-01-01`': 'the answer explains what the date does',
  '`$100 in GBP on 1 January 2020`': 'as above',
  '`1,000 USD in JPY on 1/1/2020`': 'as above',
  '`4 days from now` / `3 days ago`': 'the answer says a date rather than which one',
  '`next friday` / `last monday`': 'as above',
  '`6pm Sydney in Chicago`': 'the answer says a clock time rather than which one',
  '`2am PST to GMT`': 'as above',
  '`7:30am LAX to Japan`': 'as above',
  '`time in Paris` / `Tokyo time`': 'the answer is "the current time there"',
  '`date in Vancouver`': 'as above',
  '`April 1, 2019 to timestamp`': 'the answer says a Unix timestamp rather than which one',
  '`1733823083000 to date`': 'the answer explains how the magnitude is read',
  '`current timestamp`': 'the answer is "now", which is not a fixed string',
};

/** A row is checkable when both cells are code and the two sides line up. */
function checkable(row: Row): boolean {
  if (row.raw in UNPINNED) return false;
  if (row.inputs.length === 0 || row.describes !== '') return false;
  return row.answers.length === row.inputs.length || row.answers.length === 1;
}

const rows = readmeRows();

describe('the README’s example tables', () => {
  for (const row of rows.filter(checkable)) {
    for (const [index, input] of row.inputs.entries()) {
      // One answer against several inputs is the `6 × 7`, `84 ÷ 2`, `50 − 8`
      // shape: different ways of writing a line that answers the same thing.
      const expected = row.answers.length === 1 ? row.answers[0] : row.answers[index];
      it(`README.md:${row.line} — ${input} -> ${expected}`, () => {
        expect(engineFor(row.heading).evaluate(input)[0]?.output).toBe(expected);
      });
    }
  }
});

describe('the parsing itself', () => {
  it('finds the tables at all', () => {
    // Without this, a header that changed shape would empty the suite above
    // and the drift would be back with the tests still green.
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.filter(checkable).length).toBeGreaterThan(90);
  });

  it('reads a row containing an escaped pipe', () => {
    const bitwise = rows.find((row) => row.raw.includes('bitXor'));
    expect(bitwise?.inputs).toEqual(['5 & 3', '5 | 3', 'bitXor(5, 3)']);
  });

  it('leaves nothing unchecked that is not accounted for', () => {
    const unchecked = rows.filter((row) => !checkable(row) && !(row.raw in UNPINNED));
    expect(unchecked.map((row) => `README.md:${row.line} ${row.raw}`)).toEqual([]);
  });

  it('keeps the zoned sections naming sections that exist', () => {
    // A renamed heading would otherwise drop the zone silently, and the rows
    // under it would start being read on whichever clock the machine keeps.
    const headings = new Set(rows.map((row) => row.heading));
    expect(Object.keys(ZONED).filter((name) => !headings.has(name))).toEqual([]);
  });

  it('keeps the list of unchecked rows from going stale', () => {
    const present = new Set(rows.map((row) => row.raw));
    const gone = Object.keys(UNPINNED).filter((raw) => !present.has(raw));
    expect(gone).toEqual([]);
  });
});
