import { SYMBOLS_BY_LENGTH, SYMBOL_TO_CODE } from './currencies.js';
import { normalizeNumberLiterals, type NumberRegion } from './numberFormat.js';

export interface PreprocessContext {
  currencies: Set<string>;
  /** True if math.js already understands the token as a unit (`cup`, `km`). */
  isKnownUnit(word: string): boolean;
  /** Names currently bound in the evaluation scope. */
  scopeNames: Set<string>;
  region: NumberRegion;
}

export interface Preprocessed {
  expr: string;
  /** Tells the formatter the bare number should be rendered as a percentage. */
  hint?: 'percent';
  /** Fixed decimal places requested by the line, e.g. `1/3 to 2 dp`. */
  decimals?: number;
  /** `in full` writes the number out rather than abbreviating it as 300k. */
  notation?: 'full';
}

/**
 * Removes brackets that wrap the whole line.
 *
 * `(8:30 to 17:15)` means exactly what it does without them, but almost every
 * rule here and in the temporal chain is anchored to the start of the string,
 * so a leading bracket stops all of them matching. Only a pair that genuinely
 * encloses everything is removed — `(a) + (b)` also starts and ends with a
 * bracket and must be left alone.
 */
export function stripOuterParens(input: string): string {
  let s = input.trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0;
    let encloses = true;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') {
        depth--;
        if (depth === 0 && i < s.length - 1) {
          encloses = false;
          break;
        }
      }
    }
    if (!encloses || depth !== 0) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

const NUM = String.raw`\d+(?:\.\d+)?`;
/** A sub-expression operand: anything that is not an operator boundary. */
const OPERAND = String.raw`[^,]+?`;

/**
 * Rewrites a line of Soulver-style prose into an expression math.js can parse.
 *
 * Each step is small and order-dependent; the ordering comments matter far
 * more than the individual regexes do.
 */
export function preprocess(input: string, ctx: PreprocessContext): Preprocessed {
  let s = input.trim();

  /*
   * `in full` is stripped before anything else and returned as a formatting
   * instruction. Keeping per-line formatting in the text is deliberate: a
   * sheet is plain text, and hidden per-line state would not survive a copy,
   * an export, or a line being moved.
   */
  let notation: 'full' | undefined;
  const full = /^(.+?)\s+(?:in\s+full|as\s+plain|unabbreviated)\s*$/i.exec(s);
  if (full) {
    notation = 'full';
    s = full[1]!.trim();
  }

  s = stripConversationalPrefix(s);
  s = normalizeOperatorSymbols(s);
  s = normalizeNumberLiterals(s, ctx.region);
  s = rewriteCurrencyAmounts(s);
  s = rewriteMagnitudes(s);
  s = normalizeCurrencyCodes(s, ctx);
  s = rewriteTemperatures(s, ctx);
  s = rewriteReferences(s);

  // Rounding is pulled out before conversions, because `to nearest hundred`
  // and `to 2 dp` both look like unit conversions to the rules further down.
  const rounding = extractRounding(s);
  s = rounding.expr;

  s = spellOutShadowedUnits(s);
  s = rewriteStatistics(s);
  s = rewritePercentages(s);
  s = rewriteMultipliersAndFractions(s);
  s = rewriteRates(s, ctx);
  s = rewriteConversions(s, ctx);
  s = rewriteWordOperators(s);
  s = rewriteConversionWords(s);
  s = rewriteLabelledQuantities(s, ctx);

  const result: Preprocessed = { expr: s.trim() };
  if (rounding.decimals !== undefined) result.decimals = rounding.decimals;
  if (notation) result.notation = notation;
  return result;
}

/** Drops question phrasing and a trailing `=` or `?`. */
function stripConversationalPrefix(s: string): string {
  return s
    .replace(/^(?:what(?:'s| is)|whats|how much is|calculate)\s+/i, '')
    .replace(/[?=]\s*$/, '')
    .trim();
}

/**
 * Normalises the symbols people actually type — from a word processor, an iOS
 * keyboard, or a paste out of a document.
 */
function normalizeOperatorSymbols(s: string): string {
  return s
    .replace(/[×⋅]/g, '*')
    .replace(/[÷]/g, '/')
    .replace(/[−–—]/g, '-')
    .replace(/\*\*/g, '^')
    .replace(/√\s*(\d+(?:\.\d+)?|\()/g, (_m, operand: string) =>
      operand === '(' ? 'sqrt(' : `sqrt(${operand})`,
    )
    .replace(/π/g, 'pi');
}

/** Magnitude suffixes that are safe only next to a currency symbol. */
const CURRENCY_MAGNITUDES: Record<string, number> = {
  k: 1e3, K: 1e3,
  m: 1e6, M: 1e6,
  b: 1e9, B: 1e9, bn: 1e9, G: 1e9,
  t: 1e12, T: 1e12, tn: 1e12,
};

/**
 * `$1,000`, `100$` and `$9bn` all become a plain number with an ISO code.
 *
 * The magnitude suffix is consumed here rather than by `rewriteMagnitudes`
 * because a currency symbol is what makes `m` and `b` unambiguous: bare `5m`
 * is five metres.
 */
function rewriteCurrencyAmounts(s: string): string {
  for (const symbol of SYMBOLS_BY_LENGTH) {
    const code = SYMBOL_TO_CODE[symbol]!;
    const esc = escapeRegExp(symbol);
    s = s.replace(
      new RegExp(`${esc}\\s*(${NUM})(bn|tn|[kKmMbBtTG])?\\b`, 'g'),
      (_m, num: string, suffix?: string) =>
        `${scaleBy(num, suffix ? CURRENCY_MAGNITUDES[suffix] : undefined)} ${code}`,
    );
    s = s.replace(new RegExp(`(${NUM})\\s*${esc}(?![\\w$])`, 'g'), `$1 ${code}`);
  }
  return s;
}

const WORD_MAGNITUDES: Record<string, number> = {
  thousand: 1e3,
  million: 1e6,
  billion: 1e9,
  trillion: 1e12,
};

/**
 * `5k`, `2M` and `2 million` become plain numbers.
 *
 * Only suffixes that are not themselves math.js units are accepted bare:
 * `5K` is 5 kelvin and `5m` is 5 metres, so those are left well alone.
 */
function rewriteMagnitudes(s: string): string {
  s = s.replace(
    new RegExp(`\\b(${NUM})\\s*(thousand|million|billion|trillion)\\b`, 'gi'),
    (_m, num: string, word: string) =>
      String(Number(num) * WORD_MAGNITUDES[word.toLowerCase()]!),
  );
  return s.replace(
    new RegExp(`\\b(${NUM})(k|M|G|T)\\b`, 'g'),
    (_m, num: string, suffix: string) =>
      scaleBy(num, { k: 1e3, M: 1e6, G: 1e9, T: 1e12 }[suffix]),
  );
}

/**
 * Upper-cases bare currency codes (`100 usd in eur`) so math.js finds the unit.
 *
 * A word is only up-cased when math.js does not already know it as a unit and
 * it is not a bound variable, which keeps `100 cup` as a volume rather than
 * silently becoming Cuban pesos.
 */
function normalizeCurrencyCodes(s: string, ctx: PreprocessContext): string {
  return s.replace(/\b[A-Za-z]{3}\b/g, (word) => {
    const upper = word.toUpperCase();
    if (word === upper) return word;
    if (!ctx.currencies.has(upper)) return word;
    if (ctx.isKnownUnit(word) || ctx.scopeNames.has(word)) return word;
    return upper;
  });
}

/**
 * `72 F in C` — the everyday spelling of a temperature.
 *
 * math.js reads a bare `F` as farad and `C` as coulomb, so the line is a real
 * conversion between real units that genuinely do not match, and the error
 * says nothing about temperature. Farad and coulomb lose the abbreviation,
 * which is the right trade for a notepad calculator.
 *
 * Only the two positions a temperature can occupy are rewritten — directly
 * after a number, or as the target of a conversion — so a variable named `C`
 * still resolves to the variable.
 */
function rewriteTemperatures(s: string, ctx: PreprocessContext): string {
  const scaleFor = (letter: string) => (letter.toUpperCase() === 'F' ? 'degF' : 'degC');
  const unbound = (letter: string) =>
    !ctx.scopeNames.has(letter) && !ctx.scopeNames.has(letter.toLowerCase());

  return s
    // `72 F`, `72°F`, `72 degrees F`
    .replace(
      new RegExp(String.raw`(${NUM})\s*(?:°\s*|degrees?\s+)?([FC])\b`, 'g'),
      (match, num: string, letter: string) =>
        unbound(letter) ? `${num} ${scaleFor(letter)}` : match,
    )
    // `in C`, `to °F`
    .replace(
      /\b(in|to)\s+(?:°\s*|degrees?\s+)?([FC])\b/g,
      (match, word: string, letter: string) =>
        unbound(letter) ? `${word} ${scaleFor(letter)}` : match,
    );
}

/** `line 3` and `prev` become the internal identifiers the scope carries. */
function rewriteReferences(s: string): string {
  return s
    .replace(/\bline\s*(\d+)\b/gi, '__line$1')
    .replace(/\b(?:prev|previous|last)\b/gi, '__prev');
}

const ROUND_STEPS: Record<string, number> = {
  ten: 10,
  hundred: 100,
  thousand: 1000,
  million: 1e6,
};

/**
 * Pulls rounding instructions off the end of a line.
 *
 * `to N dp` is display precision — Soulver keeps the unrounded value for
 * subtotals and references — so it is returned as a formatting instruction
 * rather than folded into the expression. `to nearest N` genuinely changes
 * the value, so it becomes arithmetic.
 */
function extractRounding(s: string): { expr: string; decimals?: number } {
  /*
   * Greedy on the left and applied repeatedly, so `1/3 to 4 dp to 2 dp` is
   * read as a re-rounding rather than leaving a stray suffix for math.js. The
   * rightmost instruction is the one the reader wrote last, so it wins.
   */
  const dpPattern = new RegExp(
    String.raw`^(.+)\s+(?:to|as)\s+(\d+)\s*(?:dp|d\.p\.|decimals?|decimal places?|digits?|sig(?:nificant)?\s*(?:figs?|figures?)?)\s*$`,
    'i',
  );
  let decimals: number | undefined;
  let remaining = s;
  for (let guard = 0; guard < 8; guard++) {
    const match = dpPattern.exec(remaining);
    if (!match) break;
    if (decimals === undefined) decimals = Number(match[2]);
    remaining = match[1]!.trim();
  }
  if (decimals !== undefined) return { expr: remaining, decimals };

  const nearest = new RegExp(
    String.raw`^(.+?)\s+(?:rounded\s+)?(?:(up|down)\s+)?to\s+(?:the\s+)?nearest\s+(${NUM}|ten|hundred|thousand|million)\s*$`,
    'i',
  ).exec(s);
  if (nearest) {
    const mode = nearest[2]?.toLowerCase();
    const raw = nearest[3]!.toLowerCase();
    const step = ROUND_STEPS[raw] ?? Number(raw);
    const fn = mode === 'up' ? '"up"' : mode === 'down' ? '"down"' : '"near"';
    return { expr: `roundStep((${nearest[1]!}), ${step}, ${fn})` };
  }

  const plain = /^(.+?)\s+rounded(?:\s+(up|down))?\s*$/i.exec(s);
  if (plain) {
    const mode = plain[2]?.toLowerCase();
    const fn = mode === 'up' ? '"up"' : mode === 'down' ? '"down"' : '"near"';
    return { expr: `roundStep((${plain[1]!}), 1, ${fn})` };
  }

  return { expr: s };
}

/** `total of 3, 4, 7 and 9` — statistics over a list written inline. */
function rewriteStatistics(s: string): string {
  const stat = new RegExp(
    String.raw`^(total|sum|average|mean|count|median)\s+of\s+(.+)$`,
    'i',
  ).exec(s);
  if (!stat) return s;

  const verb = stat[1]!.toLowerCase();
  const list = stat[2]!.replace(/\s*,?\s+and\s+/gi, ', ');
  if (!list.includes(',')) return s;

  const fn =
    verb === 'count'
      ? 'count'
      : verb === 'median'
        ? 'median'
        : verb === 'average' || verb === 'mean'
          ? 'mean'
          : 'sum';
  return fn === 'count' ? `count([${list}])` : `${fn}(${list})`;
}

/**
 * The percentage rules, in the order they must run.
 *
 * Every form ultimately produces `pct(n)`, which evaluates to a real
 * Percentage value, so `10% + 20%` can answer `30%` rather than `0.3`.
 * The more specific phrasings are matched first; each would otherwise be
 * swallowed by a more general rule below it.
 */
function rewritePercentages(s: string): string {
  const P = String.raw`(?:%|percent(?:age)?)`;

  // "20 as a % of 200" / "20 is what % of 200" -> 10%
  s = replaceFirst(s, [
    [new RegExp(`^(${OPERAND})\\s+as\\s+(?:an?\\s+)?${P}\\s+of\\s+(.+)$`, 'i'),
      (a, b) => `pct((${a}) / (${b}) * 100)`],
    [new RegExp(`^(${OPERAND})\\s+is\\s+what\\s+${P}\\s+of\\s+(.+)$`, 'i'),
      (a, b) => `pct((${a}) / (${b}) * 100)`],
    // "180 is what % off 200" -> 10% ; "180 is what % on 150" -> 20%
    [new RegExp(`^(${OPERAND})\\s+is\\s+what\\s+${P}\\s+off\\s+(.+)$`, 'i'),
      (a, b) => `pct((1 - (${a}) / (${b})) * 100)`],
    [new RegExp(`^(${OPERAND})\\s+is\\s+what\\s+${P}\\s+on\\s+(.+)$`, 'i'),
      (a, b) => `pct(((${a}) / (${b}) - 1) * 100)`],
    // "50 to 75 is what %" / "40 to 90 as %" -> the change between them
    [new RegExp(`^(${OPERAND})\\s+to\\s+(${OPERAND})\\s+(?:is\\s+what|as)\\s+${P}\\s*$`, 'i'),
      (a, b) => `pct(((${b}) / (${a}) - 1) * 100)`],
    // Reverse: solve for the original number
    [new RegExp(`^(${OPERAND})\\s+is\\s+(${NUM})\\s*%\\s+of\\s+what\\s*$`, 'i'),
      (a, p) => `((${a}) / (${p} / 100))`],
    [new RegExp(`^(${OPERAND})\\s+is\\s+(${NUM})\\s*%\\s+off\\s+what\\s*$`, 'i'),
      (a, p) => `((${a}) / (1 - ${p} / 100))`],
    [new RegExp(`^(${OPERAND})\\s+is\\s+(${NUM})\\s*%\\s+on\\s+what\\s*$`, 'i'),
      (a, p) => `((${a}) / (1 + ${p} / 100))`],
  ]);

  // "20% off 50" -> 40 ; "20% on 50" -> 60
  s = s.replace(
    new RegExp(String.raw`(${NUM})\s*%\s+off\s+(.+)$`, 'i'),
    (_m, p: string, rest: string) => `((${rest}) * (1 - ${p} / 100))`,
  );
  s = s.replace(
    new RegExp(String.raw`(${NUM})\s*%\s+(?:on|added\s+to)\s+(.+)$`, 'i'),
    (_m, p: string, rest: string) => `((${rest}) * (1 + ${p} / 100))`,
  );

  // "20% of 50", and the fraction/multiplier forms of the same phrase
  s = s.replace(
    new RegExp(String.raw`(${NUM})\s*%\s+of\s+(.+)$`, 'i'),
    (_m, p: string, rest: string) => `((${rest}) * ${p} / 100)`,
  );
  s = s.replace(
    new RegExp(String.raw`\b(${NUM}\s*/\s*${NUM})\s+of\s+(.+)$`, 'i'),
    (_m, frac: string, rest: string) => `((${rest}) * (${frac}))`,
  );

  // "0.35 as %" and the trailing bare "20/200 %"
  s = s.replace(
    new RegExp(`^(${OPERAND})\\s+(?:as|in|to)\\s+(?:an?\\s+)?${P}\\s*$`, 'i'),
    (_m, a: string) => `pct((${a}) * 100)`,
  );
  s = s.replace(
    new RegExp(`^(.+[\\d)])\\s+%\\s*$`),
    (_m, a: string) => `pct((${a}) * 100)`,
  );

  /*
   * Anything still carrying a % is a plain percentage value.
   *
   * Not when the digits sit inside a longer word, though. By this point a
   * reference has become `__line1`, and `line 1 % of 50` would otherwise have
   * its `1` rewritten out of the middle of that placeholder to give
   * `__linepct(1)` — a name that reached the reader as "No function called
   * __linepct". The exponent in `1e3%` is the same shape: the `3` is not the
   * number either.
   */
  return s.replace(
    new RegExp(String.raw`(?<![\w.])(${NUM})\s*%`, 'g'),
    'pct($1)',
  );
}

/**
 * Unit names math.js also has a function for, and what to call them instead.
 *
 * Three of the 271 registered unit names are shadowed by a function on the
 * instance — `min`, `sec` and `chain` — and two of them actually break. A
 * function shadows the unit, so `20 min` is read as twenty times the *minimum
 * function*, and math.js refuses to multiply a number by a function:
 * `300 + 20 min` and even `20 min + 10 min` had no answer. (`chain` survives
 * for reasons of math.js's own resolution order, and is left alone; it is
 * listed here so the next person to check knows it was checked.)
 *
 * A standalone `20 min` always worked, because the temporal parser claims a
 * bare duration before math.js sees it. That made the two inconsistent with
 * each other rather than uniformly broken, which is the worse state.
 */
const SHADOWED_UNITS: Record<string, string> = {
  min: 'minutes',
  sec: 'seconds',
};

/**
 * `20 min` is twenty minutes; `min(2, 3)` is still the smaller of two.
 *
 * The rule is the one a reader already has in their head: a number in front of
 * it means the unit, a bracket after it means the function. Spelling the unit
 * out in full is enough, because nothing shadows `minutes`, and every other
 * position is left exactly as it was written.
 *
 * A bare `20 min` never arrives here at all — the temporal parser claims a
 * lone duration before any of this runs, which is why that form always worked
 * and `300 + 20 min` did not. This is the arithmetic half catching up.
 *
 * The unit wins even where the sheet has declared a variable of the same name.
 * That is deliberate rather than overlooked: `20 min` already meant minutes in
 * the bare form, so letting a declaration change what it means a line later
 * would be the surprising reading, and `min` on its own is still the variable.
 */
function spellOutShadowedUnits(s: string): string {
  return s.replace(
    /(\d)(\s*)(min|sec)\b(?!\s*\()/g,
    (_match, digit: string, gap: string, unit: string) =>
      `${digit}${gap || ' '}${SHADOWED_UNITS[unit]}`,
  );
}

/** Multipliers (`4x`) and fractions, which share the percentage grammar. */
function rewriteMultipliersAndFractions(s: string): string {
  const X = String.raw`(?:x|multiplier|multiple)`;

  s = replaceFirst(s, [
    [new RegExp(`^(${OPERAND})\\s+to\\s+(${OPERAND})\\s+(?:is\\s+what|as)\\s+${X}\\s*$`, 'i'),
      (a, b) => `multiplierOf((${b}) / (${a}))`],
    [new RegExp(`^(${OPERAND})\\s+as\\s+${X}\\s+of\\s+(.+)$`, 'i'),
      (a, b) => `multiplierOf((${a}) / (${b}))`],
    [new RegExp(`^(${OPERAND})\\s+as\\s+${X}\\s+on\\s+(.+)$`, 'i'),
      (a, b) => `multiplierOf((${a}) / (${b}) - 1)`],
    [new RegExp(`^(${OPERAND})\\s+as\\s+${X}\\s+off\\s+(.+)$`, 'i'),
      (a, b) => `multiplierOf(1 - (${a}) / (${b}))`],
    [new RegExp(`^(${OPERAND})\\s+as\\s+(?:an?\\s+)?${X}\\s*$`, 'i'),
      (a) => `multiplierOf(${a})`],
  ]);

  s = s.replace(
    new RegExp(`^(${OPERAND})\\s+(?:as|to|in)\\s+(?:an?\\s+)?fraction\\s*$`, 'i'),
    (_m, a: string) => `toFraction(${a})`,
  );

  s = s.replace(
    new RegExp(`^(${OPERAND})\\s+(?:as|to|in)\\s+sci(?:entific)?(?:\\s+notation)?\\s*$`, 'i'),
    (_m, a: string) => `sciOf(${a})`,
  );

  // "20% as dec" / "5 km as number" — strip the meaning, keep the number.
  return s.replace(
    new RegExp(`^(${OPERAND})\\s+(?:as|to|in)\\s+(?:a\\s+)?(?:number|decimal|dec)\\s*$`, 'i'),
    (_m, a: string) => `asPlainNumber(${a})`,
  );
}

/**
 * Rate quantities: a value per unit of something.
 *
 * math.js models most of these as compound units already; what it cannot do
 * is a unitless numerator (`30 bottles / week`), so the noise word is dropped
 * and the formatter renders the resulting inverse unit as `30/week`.
 */
function rewriteRates(s: string, ctx: PreprocessContext): string {
  s = s.replace(/\bper\s+(?=[A-Za-z])/gi, '/ ');

  /*
   * "30 bottles / week" — the noun is a label, not a unit.
   *
   * Only when a unit follows the slash, which is what makes the line a rate.
   * `12 widgets / 3` is a plain division, and dropping the noun there would
   * throw away a label the answer should keep.
   */
  s = s.replace(
    new RegExp(`\\b(${NUM})\\s+([A-Za-z]+)\\s*/\\s*(?=[A-Za-z])`, 'g'),
    (match, num: string, word: string) =>
      ctx.isKnownUnit(word) || ctx.scopeNames.has(word) ? match : `${num} / `,
  );

  /*
   * "30/week as /month" — re-expressing a rate against another denominator,
   * and "12 GB/s in GB/minute", which renames the numerator as well. The
   * numerator is optional so both shapes reach the same helper; it also
   * catches plain compound conversions like `65 mph in km/h`, which `rateAs`
   * recognises as a unit rather than a rate and converts directly.
   */
  const converted = /^(.+?)\s+(?:as|to|in)\s*(?:([A-Za-z]+)\s*)?\/\s*([A-Za-z]+)\s*$/i.exec(s);
  if (converted) {
    const rate = rewriteRates(converted[1]!, ctx);
    const per = singular(converted[3]!);
    return converted[2]
      ? `rateAs(${rate}, "${converted[2]}", "${per}")`
      : `rateTo(${rate}, "${per}")`;
  }

  /*
   * A bare unit in the denominator makes this a rate rather than a division.
   * The numerator must carry a value, which is what keeps the `km/h` in
   * `65 mph in km/h` from being mistaken for one.
   */
  return s.replace(
    new RegExp(`(^|[\\s(])(${NUM})\\s*([A-Za-z]+)?\\s*/\\s*([A-Za-z]+)\\b(?!\\s*[\\d(])`, 'g'),
    (match, lead: string, num: string, numerUnit: string | undefined, per: string) => {
      if (!ctx.isKnownUnit(per) && !/^(week|month|year|day|hour|workday)s?$/i.test(per)) {
        return match;
      }
      if (numerUnit && !ctx.isKnownUnit(numerUnit) && !ctx.currencies.has(numerUnit)) {
        return match;
      }
      const amount = numerUnit ? `${num} ${numerUnit}` : num;
      return `${lead}rateOf(${amount}, "${singular(per)}")`;
    },
  );
}

/** Rate denominators read better in the singular: `$99/week`, not `/weeks`. */
/**
 * Time abbreviations that end in `s` without being plurals.
 *
 * `s` is the symbol for seconds and `ms` for milliseconds, so the plural rule
 * below would leave `4 MB/s` with an empty denominator rendering as `4 MB/`.
 * Spelled-out and longer forms (`secs`, `hrs`) are genuine plurals and are
 * deliberately absent.
 */
const SINGULAR_ALREADY = new Set(['s', 'ms', 'us', 'µs', 'ns', 'ps', 'fs']);

function singular(unit: string): string {
  if (SINGULAR_ALREADY.has(unit.toLowerCase())) return unit;
  // Never hand back an empty denominator, whatever the input.
  return unit.replace(/s$/i, '') || unit;
}

/**
 * Conversion phrasings beyond the plain `5 km in miles`.
 *
 * Each of these is gated on the tokens actually being units, so ordinary
 * prose ("days in Berlin") is never rewritten into a broken expression.
 */
function rewriteConversions(s: string, ctx: PreprocessContext): string {
  const unitish = (word: string) => ctx.isKnownUnit(word) || ctx.currencies.has(word.toUpperCase());

  /*
   * The same phrasing inside brackets, where it is a sub-expression rather
   * than the whole line: `(days in 3 weeks) * 2`. Handled before the anchored
   * rule below, which can only ever see a line that is nothing else.
   */
  s = s.replace(
    /\(([A-Za-z]+)\s+(?:in|per)\s+(?:an?\s+)?([^()]+)\)/gi,
    (match, unit: string, rest: string) => {
      const target = rest.trim();
      if (!unitish(unit) || !/[A-Za-z]/.test(target)) return match;
      return `((${/^[\d(]/.test(target) ? target : `1 ${target}`}) to ${unit})`;
    },
  );

  // "seconds in a day" / "days in 3 weeks" / "meters in 10 km"
  const reversed = /^([A-Za-z]+)\s+(?:in|per)\s+(?:an?\s+)?(.+)$/i.exec(s);
  if (reversed && unitish(reversed[1]!)) {
    const rest = reversed[2]!.trim();
    const quantity = /^[\d(]/.test(rest) ? rest : `1 ${rest}`;
    if (/[A-Za-z]/.test(rest)) return `(${quantity}) to ${reversed[1]}`;
  }

  // Compound quantities: "5 hours 30 minutes" is a sum.
  s = s.replace(
    new RegExp(`\\b(${NUM})\\s*([A-Za-z]+)\\s+(${NUM})\\s*([A-Za-z]+)\\b`, 'g'),
    (match, n1: string, u1: string, n2: string, u2: string) =>
      unitish(u1) && unitish(u2) ? `(${n1} ${u1} + ${n2} ${u2})` : match,
  );

  // A bare pair of unit names converts one of the first into the second.
  const pair = /^([A-Za-z]+)\s+([A-Za-z]+)$/.exec(s);
  if (pair && unitish(pair[1]!) && unitish(pair[2]!)) {
    return `1 ${pair[1]} to ${pair[2]}`;
  }

  /*
   * A trailing conversion applies to the whole line: `100 km * 2 in miles`.
   *
   * math.js binds `in` tighter than `*`, so unbracketed this reads as
   * `100 km * (2 in miles)` — and because a bare number takes the unit
   * happily, the answer comes back as `200 km in miles` with nothing flagged.
   * A reader skimming the column has no reason to doubt it. That is the whole
   * reason this rule exists: the failure is silent, and silently wrong is
   * worse here than refused.
   *
   * This is not a special case so much as the sibling nobody wrote. Every
   * other trailing conversion in this file — `as %`, `as a fraction`,
   * `in scientific notation`, `as a number`, `in km/h` — is anchored to the
   * whole line already. Plain unit conversion was the one form left falling
   * through to math.js's precedence, which is why it was the one that lied.
   *
   * Anchoring to the end is also what makes the lazy left side pick the *last*
   * conversion keyword, so `10 km in miles to feet` converts twice rather than
   * reading `miles to feet` as a unit name.
   *
   * Gated on the target actually being a unit, which is what keeps `5 in
   * stock` and `3 apples in a basket` as the prose they are.
   *
   * Digits belong in the target's character class because unit names contain
   * them — `m2`, `m3`, `mmH2O`, `cmH2O`. Without them those four fell
   * through to math.js's precedence and answered `200 m2 in m2`, which is the
   * exact sentence this rule was written to stop appearing. Nothing else opens
   * up: a target that is not a unit is still refused by `unitish`, so `100 in
   * 20` is as much prose as it was.
   */
  const trailing = /^(.+?)\s+(?:in|to|as)\s+([A-Za-z0-9µ°]+)\s*$/i.exec(s);
  if (trailing && unitish(trailing[2]!)) {
    return `(${trailing[1]}) to ${trailing[2]}`;
  }

  return s;
}

/**
 * Words that survive every rewrite above and still are not labels.
 *
 * math.js reads these itself, so a number in front of one is arithmetic
 * rather than someone counting things.
 */
const NOT_A_LABEL = new Set(['mod', 'to', 'in', 'as', 'of', 'per', 'and', 'or', 'x', 'e']);

/**
 * `12 widgets` — a number followed by a word nothing else claimed.
 *
 * Deliberately the last rule in the chain. By this point every phrasing the
 * engine understands has been consumed into a function call or an operator,
 * so a surviving `number word` pair is someone counting something the engine
 * has no unit for. Running it earlier would swallow half the vocabulary.
 *
 * A word directly before a bracket is a function call, not a label, which is
 * what keeps `round(1.5)` and friends intact.
 */
function rewriteLabelledQuantities(s: string, ctx: PreprocessContext): string {
  return s.replace(
    new RegExp(String.raw`(^|[^\w.])(${NUM})\s+([A-Za-z_]\w*)\b(?!\s*\()`, 'g'),
    (match, lead: string, num: string, word: string) => {
      const lower = word.toLowerCase();
      if (NOT_A_LABEL.has(lower)) return match;
      if (ctx.isKnownUnit(word) || ctx.currencies.has(word.toUpperCase())) return match;
      if (ctx.scopeNames.has(lower) || word.startsWith('__')) return match;
      return `${lead}labelled(${num}, "${word}")`;
    },
  );
}

/** Spelled-out arithmetic: `plus`, `times`, `divided by`, `to the power of`. */
function rewriteWordOperators(s: string): string {
  return s
    .replace(/\bremainder\s+of\s+(.+?)\s+divided\s+by\s+(.+)$/i, 'mod($1, $2)')
    .replace(/\bdivided\s+by\b/gi, '/')
    .replace(/\bmultiplied\s+by\b/gi, '*')
    .replace(/\bto\s+the\s+power\s+of\b/gi, '^')
    .replace(/\bsquare\s+root\s+of\b/gi, 'sqrt')
    .replace(/\bcube\s+root\s+of\b/gi, 'cbrt')
    .replace(/\bplus\b/gi, '+')
    .replace(/\bminus\b/gi, '-')
    .replace(/\btimes\b/gi, '*');
}

/** `as` and `into` are conversion keywords; math.js spells them `to`. */
function rewriteConversionWords(s: string): string {
  return s.replace(/\b(?:as|into)\b/gi, 'to').replace(/\bsci\b/gi, 'sci');
}

/** Applies the first pattern that matches, and stops. */
function replaceFirst(
  s: string,
  rules: Array<[RegExp, (...groups: string[]) => string]>,
): string {
  for (const [pattern, build] of rules) {
    const m = pattern.exec(s);
    if (m) return build(...m.slice(1).map((g) => g ?? ''));
  }
  return s;
}

function scaleBy(num: string, factor: number | undefined): string {
  return factor ? String(Number(num) * factor) : num;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
