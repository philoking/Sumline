/**
 * Failures, said in the app's own voice.
 *
 * math.js reports problems in the vocabulary of its own implementation —
 * "expected: Array or DenseMatrix or Matrix", "Undefined symbol" — and those
 * strings went straight to the answer column's tooltip. An unrecognised
 * currency code is the likeliest way anyone meets one, and "DenseMatrix" tells
 * them nothing about what to do next.
 *
 * Which shapes occur was settled by generating 400,000 lines through the fuzz
 * generator and collecting every distinct message that reached a line's error
 * — rather than by what anyone happened to notice. Anything left unmapped
 * keeps math.js's wording, which for the parser errors ("Unexpected end of
 * expression") is already a sentence in plain English; inventing a second
 * phrasing for those would add a translation table to maintain and no clarity.
 *
 * Two things catch what enumeration cannot. `tidy` runs over every message
 * rather than only the unmapped ones, so the engine's own placeholders never
 * appear whichever branch worded the sentence. And a message still carrying
 * math.js's implementation vocabulary after all of that is replaced wholesale:
 * a reader told about a DenseMatrix has been told nothing, and the next such
 * phrase to appear is caught without anyone having to meet it first.
 */

/**
 * A unit or currency the line named and the engine does not have.
 *
 * Its own type because the evaluator has to treat it differently from an
 * ordinary failure, not merely word it differently: a line that named an
 * unknown code must not then be retried with the word dropped. See
 * `stripProse` in `evaluate.ts`.
 */
export class UnknownUnitError extends Error {
  constructor(readonly token: string) {
    super(`No unit or currency called ${token}`);
    this.name = 'UnknownUnitError';
  }
}

/** The two lists the engine can offer a correction from. */
export interface Vocabulary {
  currencies: ReadonlySet<string>;
  /** Every unit name registered on this math.js instance. */
  units: ReadonlySet<string>;
}

export interface Explained {
  message: string;
  /**
   * Set when the line named a unit or currency that does not exist.
   *
   * The evaluator reads this as "do not try to rescue this line by dropping
   * words": the word it got wrong is the one the answer depends on.
   */
  unknown?: string;
}

/**
 * math.js's internal names for the arithmetic somebody actually wrote.
 *
 * These reach `Unexpected type of argument in function X` as the name of the
 * primitive that refused, not as anything the line said: nobody writes
 * `multiplyScalar`, they write `*`. Naming the operation instead describes
 * the line, which is the whole point of this file.
 *
 * `mod` and `fraction` are deliberately absent — those are words a sheet can
 * contain, so the writer recognises them.
 */
const OPERATIONS: Record<string, string> = {
  add: 'added together',
  addScalar: 'added together',
  subtract: 'subtracted',
  subtractScalar: 'subtracted',
  multiply: 'multiplied',
  multiplyScalar: 'multiplied',
  divide: 'divided',
  divideScalar: 'divided',
  unaryMinus: 'negated',
  range: 'made into a range',
};

/**
 * Vocabulary that belongs to math.js's implementation and to nothing a person
 * writes: matrix types, its numeric classes, its dispatch machinery.
 */
const IMPLEMENTATION =
  /(?:Dense|Sparse)?Matrix|BigNumber|bigint|\bFraction\b|Scalar|\[object|signature:|elementwise|unaryMinus|unsupported type|Cannot apply (?:a numeric )?index/;

/** When the wording cannot be rescued, say the true thing and stop. */
const UNWORKABLE = 'That cannot be worked out';

/** Turns a thrown value into a sentence, and says whether it is worth retrying. */
export function describeError(error: unknown, vocabulary: Vocabulary): Explained {
  const explained = explain(error, vocabulary);
  // Over every message, not only the unmapped ones: the branches below compose
  // sentences out of raw captures, so `__prev` and `__line1` reached the
  // answer column through any of them that matched.
  return { ...explained, message: tidy(explained.message) };
}

function explain(error: unknown, vocabulary: Vocabulary): Explained {
  if (error instanceof UnknownUnitError) {
    return { message: unknownUnit(error.token, vocabulary), unknown: error.token };
  }

  const raw = error instanceof Error ? error.message : String(error);

  const symbol = /^Undefined symbol (\S+)/.exec(raw);
  if (symbol) {
    const token = symbol[1]!;
    /*
     * A code-shaped token is one the writer meant as a unit or a currency —
     * `XYZ`, `EURO`, `BTC` — where a lowercase word in the same position is
     * far more likely to be prose ("45 USD in cash"). The distinction decides
     * whether the line is refused or rescued, so it is deliberately narrow.
     */
    return isCodeShaped(token)
      ? { message: unknownUnit(token, vocabulary), unknown: token }
      : { message: `No unit, currency or variable called ${token}` };
  }

  const fn = /^Undefined function (\S+)/.exec(raw);
  if (fn) return { message: `No function called ${fn[1]}` };

  /*
   * "Units do not match ('kg' != '5 km')" — the right-hand side is the source
   * text rather than a unit, so both halves are reduced to the unit itself.
   */
  const mismatch = /^Units do not match \('([^']*)' *!= *'([^']*)'\)/.exec(raw);
  if (mismatch) {
    const first = bareUnit(mismatch[1]!);
    const second = bareUnit(mismatch[2]!);
    return { message: `These units do not match: ${second} and ${first}` };
  }

  /*
   * "100 USD in EUR * 2" — the conversion swallowed the rest of the line.
   *
   * `in` binds tighter than `*`, so the target is `EUR * 2` rather than `EUR`,
   * and math.js objects that the thing on its right already carries a value.
   * That is a true statement about its operand and no help at all to the
   * person who wrote the line: what they need to know is that the conversion
   * did not end where they thought it did.
   *
   * The trailing form of this — `100 USD * 2 in EUR` — is not an error at all;
   * `rewriteConversions` binds it to the whole line. Only a conversion with
   * arithmetic *after* it reaches here, and for that one bracketing is the
   * genuine answer rather than a workaround.
   */
  if (/unit with a value/.test(raw)) {
    return {
      message:
        'A conversion takes everything after it as the unit — ' +
        'bracket the part being converted, as in (100 USD in EUR) * 2',
    };
  }

  const argument = /^Unexpected type of argument in function (\w+)/.exec(raw);
  if (argument) {
    const name = argument[1]!;
    const operation = OPERATIONS[name];
    if (operation) return { message: `Those values cannot be ${operation}` };
    return {
      message:
        name === 'to'
          ? 'That cannot be converted'
          : `${name} cannot be used with those values`,
    };
  }

  /*
   * "Too few arguments in function atan2 (expected: number or Array or
   * DenseMatrix or SparseMatrix or BigNumber or bigint or string or Matrix or
   * boolean or Fraction, index: 1)" — the list is math.js enumerating its own
   * accepted types, and the one fact in it a writer can act on is that the
   * function wanted another value.
   */
  const tooFew = /^Too few arguments in function (\w+)/.exec(raw);
  if (tooFew) return { message: `${tooFew[1]} needs more values than that` };

  const tooMany = /^Too many arguments in function (\w+) \(expected: (\d+), actual: (\d+)\)/.exec(raw);
  if (tooMany) {
    const values = tooMany[2] === '1' ? 'value' : 'values';
    return { message: `${tooMany[1]} takes ${tooMany[2]} ${values}, not ${tooMany[3]}` };
  }

  const message = tidy(raw);
  /*
   * Unmapped, and still describing math.js's own machinery: a matrix type, one
   * of its numeric classes, a dispatch signature. `16:00 to 03:04:05` reaching
   * "Dimension mismatch. Matrix A (0) must match Matrix B (1)" is the shape of
   * it — a line somebody could plausibly write, answered in the vocabulary of
   * something they have never heard of.
   *
   * Only here, never over a mapped message: "No unit or currency called
   * Fraction" is a good sentence about a word the writer chose, and a guard
   * running over everything would throw it away. A mapped branch that starts
   * leaking is a test failure rather than something quietly reworded.
   */
  return { message: IMPLEMENTATION.test(message) ? UNWORKABLE : message };
}

/** `No unit or currency called EURO — did you mean EUR?` */
function unknownUnit(token: string, vocabulary: Vocabulary): string {
  /*
   * A code-shaped token is compared against currencies alone. Searching the
   * unit list as well would answer `1 BTC in USD` with "did you mean BTU?",
   * which is a real math.js unit and obvious nonsense as a suggestion.
   */
  const candidates = isCodeShaped(token) ? vocabulary.currencies : vocabulary.units;
  const nearest = suggest(token, candidates);
  return nearest
    ? `No unit or currency called ${token} — did you mean ${nearest}?`
    : `No unit or currency called ${token}`;
}

/** Whether a word was written the way an ISO code or unit symbol is written. */
function isCodeShaped(token: string): boolean {
  return /^[A-Z]{2,5}$/.test(token);
}

/** `5 km` -> `km`, so a mismatch names units rather than quoting the line. */
function bareUnit(text: string): string {
  return text.trim().replace(/^[\d.,\s]+/, '').trim() || text.trim();
}

/**
 * The nearest known spelling, or null if nothing is close enough.
 *
 * The threshold rises with length because a short token has short neighbours:
 * at a distance of two, every three-letter currency is a near miss for every
 * other, and the suggestion would be noise rather than help.
 */
export function suggest(token: string, candidates: Iterable<string>): string | null {
  const limit = token.length <= 4 ? 1 : 2;
  const wanted = token.toLowerCase();
  let best: string | null = null;
  let bestDistance = limit + 1;

  for (const candidate of candidates) {
    if (candidate.toLowerCase() === wanted) continue;
    // Cheap rejection first: an edit cannot change a word's length by more
    // than the number of edits, so this skips most of a 274-unit list.
    if (Math.abs(candidate.length - token.length) > limit) continue;
    const distance = editDistance(wanted, candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return bestDistance <= limit ? best : null;
}

/** Levenshtein distance, one row at a time. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, previous[j]! + 1, current[j - 1]! + 1);
    }
    previous = current;
  }

  return previous[b.length]!;
}

/**
 * Strips the parts of a math.js message that describe the rewritten
 * expression rather than the line as it was written.
 */
function tidy(message: string): string {
  return message
    .replace(/^Error:\s*/, '')
    .replace(/\s*\(char \d+\)$/, '')
    .replace(/__v\d+/g, 'value')
    // The number is optional because a line that named no line still gets
    // the placeholder: `line 1 % of 50` reaches math.js as a bare `__line`,
    // and "No function called __line" is not a sentence about anything the
    // writer typed.
    .replace(/__line(\d*)/g, (_match, number: string) =>
      number ? `line ${number}` : 'line',
    )
    .replace(/__prev/g, 'prev');
}
