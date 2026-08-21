import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/index.js';
import type { Token } from '../src/tokenize.js';
import { TEST_NOW, TEST_RATES } from './helpers.js';

const engine = createEngine({ rates: TEST_RATES, now: TEST_NOW });

/**
 * A line's tokens as `kind:text` pairs.
 *
 * Compared as text rather than as offsets, because an offset that is off by
 * one is unreadable in a failure message while a mis-sliced token is obvious.
 */
function marks(source: string, line = 0): string[] {
  const raw = source.split('\n')[line] ?? '';
  return (engine.tokenize(source)[line] ?? []).map(
    (token: Token) => `${token.kind}:${raw.slice(token.from, token.to)}`,
  );
}

// Issue #69 — the sheet reads as a document, not one flat colour
describe('what a line is made of', () => {
  it('tells numbers, units and operators apart', () => {
    expect(marks('5 km + 3 miles')).toEqual([
      'number:5',
      'unit:km',
      'operator:+',
      'number:3',
      'unit:miles',
    ]);
  });

  it('reads a currency symbol and its amount as two things', () => {
    expect(marks('$1,250.50 in EUR')).toEqual([
      'currency:$',
      'number:1,250.50',
      'keyword:in',
      'currency:EUR',
    ]);
  });

  it('keeps a magnitude suffix inside the number it scales', () => {
    expect(marks('5k + 500')).toEqual(['number:5k', 'operator:+', 'number:500']);
    expect(marks('$9bn')).toEqual(['currency:$', 'number:9bn']);
    // Bare `5m` is five metres, which is exactly why `m` is not a magnitude
    // suffix without a currency symbol in front of it.
    expect(marks('5m')).toEqual(['number:5', 'unit:m']);
  });

  it('marks percentages, brackets and word operators', () => {
    expect(marks('20% of (250 + 50)')).toEqual([
      'number:20',
      'operator:%',
      'keyword:of',
      'operator:(',
      'number:250',
      'operator:+',
      'number:50',
      'operator:)',
    ]);
  });

  it('marks a heading and a comment whole', () => {
    expect(marks('# Trip costs')).toEqual(['heading:# Trip costs']);
    expect(marks('// a note about 5 km')).toEqual(['comment:// a note about 5 km']);
    expect(marks('12 * 3 // three dozen')).toEqual([
      'number:12',
      'operator:*',
      'number:3',
      'comment:// three dozen',
    ]);
  });

  it('marks a tag and the directive that scopes to it', () => {
    expect(marks('groceries $86.40 #home')).toEqual([
      'currency:$',
      'number:86.40',
      'tag:#home',
    ]);
    expect(marks('sum #home')).toEqual(['directive:sum', 'tag:#home']);
  });
});

describe('what the engine will not be reading', () => {
  it('leaves a label alone, numbers and all', () => {
    // `128 GB` is inside the label, so the engine never sees it — colouring it
    // as a quantity would say the opposite.
    expect(marks('Cost of 128 GB iPhone 16: $999')).toEqual(['currency:$', 'number:999']);
  });

  it('greys out the asides it discards', () => {
    expect(marks('$999 (for iPhone 16)')).toEqual([
      'currency:$',
      'number:999',
      'comment:(for iPhone 16)',
    ]);
    expect(marks('Boeing "747" is $386.8M')).toEqual([
      'comment:"747"',
      'keyword:is',
      'currency:$',
      'number:386.8M',
    ]);
  });

  it('keeps a parenthesised expression, which is not an aside', () => {
    expect(marks('(8:30 to 17:15) - 45 minutes')).toEqual([
      'operator:(',
      'number:8',
      'operator::',
      'number:30',
      'keyword:to',
      'number:17',
      'operator::',
      'number:15',
      'operator:)',
      'operator:-',
      'number:45',
      'unit:minutes',
    ]);
  });

  it('says nothing about a line of prose', () => {
    expect(marks('call the bank about the mortgage')).toEqual([
      'keyword:the',
      'keyword:the',
    ]);
  });
});

describe('variables and references', () => {
  it('marks a name where it is declared and where it is read', () => {
    expect(marks('monthly rent = 1500\nmonthly rent * 12', 0)).toEqual([
      'name:monthly rent',
      'operator:=',
      'number:1500',
    ]);
    expect(marks('monthly rent = 1500\nmonthly rent * 12', 1)).toEqual([
      'name:monthly rent',
      'operator:*',
      'number:12',
    ]);
  });

  it('refuses to see a name before it is declared', () => {
    // The same rule evaluation follows, so an undeclared name looks like the
    // prose it currently is.
    expect(marks('rate * 2\nrate = 10', 0)).toEqual(['operator:*', 'number:2']);
  });

  it('shows a name that is also a unit losing to the unit after a number', () => {
    // Issue #40's trap, made visible: `hours` is the variable on one line and
    // the unit on the next, and the engine reads it that way whether or not
    // the writer meant it to.
    const sheet = 'hours = 6.5\nhours * 2\n2 hours + 30 minutes';
    expect(marks(sheet, 1)).toEqual(['name:hours', 'operator:*', 'number:2']);
    expect(marks(sheet, 2)).toEqual([
      'number:2',
      'unit:hours',
      'operator:+',
      'number:30',
      'unit:minutes',
    ]);
  });

  it('marks line and prev references as one token each', () => {
    expect(marks('10\n20\nline 1 + prev', 2)).toEqual([
      'reference:line 1',
      'operator:+',
      'reference:prev',
    ]);
  });

  it('marks a global as the variable it is', () => {
    const withGlobals = createEngine({
      rates: TEST_RATES,
      now: TEST_NOW,
      globals: { 'day rate': '$550' },
    });
    expect(withGlobals.tokenize('day rate * 5')[0]?.map((t) => t.kind)).toEqual([
      'name',
      'operator',
      'number',
    ]);
  });
});

describe('reading the region the sheet is set to', () => {
  it('reads 1.234,56 as one number in western Europe', () => {
    const european = createEngine({ region: 'western-europe' });
    const [tokens] = european.tokenize('1.234,56 + 2');
    expect(tokens?.[0]).toEqual({ from: 0, to: 8, kind: 'number' });
  });

  it('reads the same text as three tokens in North America', () => {
    expect(marks('1.234,56 + 2')).toEqual([
      'number:1.234',
      'operator:,',
      'number:56',
      'operator:+',
      'number:2',
    ]);
  });
});

describe('offsets', () => {
  it('reports positions in the raw line, indentation and all', () => {
    expect(engine.tokenize('   42 km')[0]).toEqual([
      { from: 3, to: 5, kind: 'number' },
      { from: 6, to: 8, kind: 'unit' },
    ]);
  });

  it('returns one entry per line, including the blank ones', () => {
    expect(engine.tokenize('1\n\n2').map((line) => line.length)).toEqual([1, 0, 1]);
  });

  it('never overlaps or runs past the end of its line', () => {
    const sheet = [
      'monthly rent = 1500 // per month',
      'Cost of 128 GB iPhone 16: $999 (a lot)',
      '# Heading',
      'sum #home',
      '2 hours 30 minutes in minutes',
      '$1,250.50 in EUR on 2020-01-01',
    ];
    for (const [index, tokens] of engine.tokenize(sheet).entries()) {
      let previous = 0;
      for (const token of tokens) {
        expect(token.from).toBeGreaterThanOrEqual(previous);
        expect(token.to).toBeGreaterThan(token.from);
        expect(token.to).toBeLessThanOrEqual(sheet[index]!.length);
        previous = token.to;
      }
    }
  });
});
