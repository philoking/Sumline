import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/index.js';
import { TEST_NOW, TEST_RATES } from './helpers.js';

const engine = createEngine({ rates: TEST_RATES, now: TEST_NOW });

/**
 * An engine with no rate table, which is the state of every browser on first
 * paint — before `/api/rates` returns. Currency codes mean nothing to it, and
 * that is exactly when `1 BTC in USD` used to answer `1 in`.
 */
const rateless = createEngine({ now: TEST_NOW });

function line(source: string, on = engine) {
  return on.evaluate(source)[0]!;
}

/*
 * Issue #58 — an unrecognised code beside `in` left a well-formed expression,
 * because `in` is also the symbol for inches. The answer column showed a
 * number, the running total absorbed it, and nothing said anything was wrong.
 *
 * The mechanism was the prose retry: when math.js rejected `100 USD in XYZ`,
 * the trailing unknown word was dropped and `100 USD in` was evaluated
 * instead, which is a valid expression meaning something else entirely.
 */
describe('a conversion the engine cannot perform', () => {
  const refused: Array<[string, string]> = [
    ['1 BTC in USD', 'No unit or currency called BTC'],
    ['1 BTC to USD', 'No unit or currency called BTC'],
    ['100 USD in XYZ', 'No unit or currency called XYZ'],
    ['5 apples in USD', 'No unit or currency called apples'],
  ];

  for (const [input, message] of refused) {
    it(`${input} — ${message}`, () => {
      expect(line(input).error).toBe(message);
    });
  }

  it('answers nothing rather than a number', () => {
    for (const [input] of refused) expect(line(input).output).toBe('');
  });

  it('refuses before the rate table has arrived, where both codes are unknown', () => {
    expect(line('1 BTC in USD', rateless).error).toBe('No unit or currency called USD');
    expect(line('1 BTC in USD', rateless).output).toBe('');
  });

  it('keeps the line out of the running total', () => {
    // The whole point: a wrong answer here was being silently summed.
    expect(engine.total(engine.evaluate('100\n1 BTC in USD'))).toBe('100');
  });
});

/*
 * The other half of #58: a trailing `in` must never be assimilated as inches
 * on a line that reads as a conversion. Where the tail really is prose the
 * quantity still answers — dropping "in cash" does not change what the line
 * is worth, where dropping "in XYZ" changes the question.
 */
describe('a trailing `in` that is not a unit', () => {
  const cases: Array<[string, string]> = [
    ['10 in binary', '10'],
    ['3 in Berlin', '3'],
    ['2 apples in a basket', '2 apples'],
    ['I paid 45 USD in cash', '$45.00'],
  ];

  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(line(input).output).toBe(expected);
    });
  }

  it('never answers in inches', () => {
    for (const [input] of cases) expect(line(input).output).not.toMatch(/\bin$/);
  });

  it('says nothing while the target is still being typed', () => {
    expect(line('5 km in').output).toBe('');
    expect(line('100 USD in').output).toBe('');
    // Not an error either: the line is unfinished, not wrong.
    expect(line('5 km in').error).toBeUndefined();
  });

  it('still reads inches where a number makes it one', () => {
    expect(line('12 in').output).toBe('12 in');
    expect(line('12 in to cm').output).toBe('30.48 cm');
    expect(line('5 in in cm').output).toBe('12.7 cm');
  });
});

/*
 * Issue #57 — math.js reported failures in the vocabulary of its own
 * implementation. `1 BTC in USD` answered with a DenseMatrix type error, which
 * tells the reader nothing they can act on.
 */
describe('error messages in the app’s own voice', () => {
  it('never mentions math.js internals', () => {
    const internals = /DenseMatrix|SparseMatrix|Matrix|Undefined symbol|index: \d/;
    const broken = [
      '1 BTC in USD',
      '100 USD in XYZ',
      '5 km in kg',
      '5 foo in bar',
      'foo(3)',
      '1 EUROS in USD',
    ];
    for (const source of broken) {
      const { error } = line(source);
      expect(error, source).toBeTruthy();
      expect(error, source).not.toMatch(internals);
    }
  });

  /*
   * math.js quotes the two operands in one order when converting and the other
   * when adding, so the pair is named rather than ordered — the sentence says
   * they do not match, which is true whichever way round it reads.
   */
  it('names the units that failed to match', () => {
    expect(line('5 km in kg').error).toBe('These units do not match: km and kg');
    expect(line('5 km + 3 kg').error).toBe('These units do not match: kg and km');
  });

  it('names an unknown function', () => {
    expect(line('foo(3)').error).toBe('No function called foo');
  });

  /*
   * Arithmetic *after* a conversion is the one shape precedence still decides
   * against the writer: `in` takes `EUR * 2` as its target. math.js reports
   * that its right-hand operand carries a value, which is true of its own
   * internals and says nothing about the mistake that was made.
   *
   * The mirrored form needs no message at all — a trailing conversion is bound
   * to the whole line by `rewriteConversions` and simply answers.
   */
  it('explains a conversion that swallowed the rest of the line', () => {
    const expected =
      'A conversion takes everything after it as the unit — ' +
      'bracket the part being converted, as in (100 USD in EUR) * 2';
    expect(line('100 USD in EUR * 2').error).toBe(expected);
    expect(line('100 km in miles * 2').error).toBe(expected);
    expect(line('2 hours in minutes * 3').error).toBe(expected);
  });

  it('has nothing to explain when the conversion trails', () => {
    expect(line('100 USD * 2 in EUR').error).toBeUndefined();
    expect(line('100 km * 2 in miles').error).toBeUndefined();
  });

  it('leaves the parser’s own plain English alone', () => {
    expect(line('5 +').error).toBe('Unexpected end of expression');
  });
});

/*
 * The suggestion is what turns a refusal into something actionable, and is
 * drawn from the two lists the engine already holds rather than a table of
 * common mistakes that would need maintaining.
 */
describe('did you mean', () => {
  const suggested: Array<[string, string]> = [
    ['100 USD in EURO', 'No unit or currency called EURO — did you mean EUR?'],
    ['1 EUROS in USD', 'No unit or currency called EUROS — did you mean EUR?'],
    ['5 metre in feet', 'No unit or currency called metre — did you mean meter?'],
  ];

  for (const [input, message] of suggested) {
    it(`${input} — ${message}`, () => {
      expect(line(input).error).toBe(message);
    });
  }

  /*
   * A three-letter code has three-letter neighbours: at a distance of two,
   * every currency is a near miss for every other. BTC in particular sits one
   * edit from BTU, a real math.js unit and an absurd thing to suggest to
   * someone asking about bitcoin.
   */
  it('offers nothing when nothing is close', () => {
    expect(line('1 BTC in USD').error).toBe('No unit or currency called BTC');
    expect(line('100 USD in XYZ').error).toBe('No unit or currency called XYZ');
  });
});

/*
 * Issue #88 — the mapping only covered the shapes somebody had happened to
 * meet. Generating 400,000 lines and collecting every distinct message that
 * reached a line turned up the rest: the engine's own placeholders, math.js's
 * internal function names, and its matrix vocabulary.
 */
describe('the engine’s own placeholders', () => {
  const hidden: Array<[string, string]> = [
    ['line 1(25k)', 'No function called line 1'],
    ['prev(100)', 'No function called prev'],
  ];

  for (const [input, message] of hidden) {
    it(`${input} — ${message}`, () => {
      // `__line1` and `__prev` are how a reference reaches math.js. Every
      // branch that words a message composes it out of raw captures, so they
      // used to arrive in the tooltip exactly as the rewriter wrote them.
      expect(line(input).error).toBe(message);
    });
  }

  it('never shows a doubled underscore, whichever branch worded the message', () => {
    const sheet = ['200', 'line 1(2)', 'prev(2)', 'line 1 % of 50'].join('\n');
    for (const result of engine.evaluate(sheet)) {
      expect(result.error ?? '').not.toContain('__');
    }
  });
});

describe('math.js’s internal names for arithmetic', () => {
  it('names the operation the line wrote, not the primitive that refused', () => {
    // "multiplyScalar cannot be used with those values" was the single most
    // common message in the sweep. Nobody writes multiplyScalar; they write *.
    expect(line('0% as fraction 1').error).toBe('Those values cannot be multiplied');
  });

  it('leaves alone the names a sheet can actually contain', () => {
    // `mod` is documented and typed by hand, so naming it is help rather than
    // implementation detail leaking out.
    expect(line('¥400 mod €20').error).toBe('mod cannot be used with those values');
  });
});

describe('arguments a function did not get', () => {
  it('does not recite math.js’s list of accepted types', () => {
    const message = line('atan2(1)').error ?? '';
    expect(message).toBe('atan2 needs more values than that');
    expect(message).not.toContain('DenseMatrix');
  });

  it('says how many were wanted and how many arrived', () => {
    expect(line('sqrt(5, 1)').error).toBe('sqrt takes 1 value, not 2');
    expect(line('nthRoot(1, 2, 3)').error).toBe('nthRoot takes 2 values, not 3');
  });
});

describe('anything still describing math.js itself', () => {
  it('is replaced rather than shown', () => {
    // `16:00 to 03:04:05` is a line somebody could plausibly write, and it
    // answered "Dimension mismatch. Matrix A (0) must match Matrix B (1)".
    expect(line('16:00 to 03:04:05').error).toBe('That cannot be worked out');
  });

  it('does not swallow a good sentence about a word the writer chose', () => {
    // The guard runs only where nothing was mapped. Matrix and Fraction are
    // math.js vocabulary and also words someone can type, and a message naming
    // what they typed is the useful one.
    expect(line('10 + Matrix').error).toBe('No unit, currency or variable called Matrix');
    expect(line('Fraction(1, 2)').error).toBe('No function called Fraction');
  });
});

describe('values that did not survive the arithmetic', () => {
  it('refuses them on the prose-retry path too', () => {
    // The retry that drops surrounding prose formatted its result directly,
    // skipping the checks the first attempt makes — so a line that reached it
    // could answer NaN.
    for (const input of [
      "10 lunch - 'text' today sqrt",
      'true 3 weeks ^ 5k',
      '1e3 ^ 2026-03-01 per',
    ]) {
      const result = line(input);
      expect(result.output, input).toBe('');
      expect(result.error, input).toBeDefined();
    }
  });

  it('refuses a matrix of them', () => {
    expect(line('[1, 2](1e31,000)').output).toBe('');
  });
});
