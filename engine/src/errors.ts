/**
 * Failures, said in the app's own voice.
 *
 * math.js reports problems in the vocabulary of its own implementation —
 * "expected: Array or DenseMatrix or Matrix", "Undefined symbol" — and those
 * strings went straight to the answer column's tooltip. An unrecognised
 * currency code is the likeliest way anyone meets one, and "DenseMatrix" tells
 * them nothing about what to do next.
 *
 * Only the shapes that actually occur are mapped. Anything else keeps math.js's
 * wording, which for the parser errors ("Unexpected end of expression") is
 * already a sentence in plain English; inventing a second phrasing for those
 * would add a translation table to maintain and no clarity.
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

/** Turns a thrown value into a sentence, and says whether it is worth retrying. */
export function describeError(error: unknown, vocabulary: Vocabulary): Explained {
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
    return {
      message:
        argument[1] === 'to'
          ? 'That cannot be converted'
          : `${argument[1]} cannot be used with those values`,
    };
  }

  return { message: tidy(raw) };
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
    .replace(/__line(\d+)/g, 'line $1')
    .replace(/__prev/g, 'prev');
}
