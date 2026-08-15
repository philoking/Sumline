import { SYMBOLS_BY_LENGTH, SYMBOL_TO_CODE } from './currencies.js';

export interface PreprocessContext {
  currencies: Set<string>;
  /** True if math.js already understands the token as a unit (`cup`, `km`). */
  isKnownUnit(word: string): boolean;
  /** Names currently bound in the evaluation scope. */
  scopeNames: Set<string>;
}

export interface Preprocessed {
  expr: string;
  /** Tells the formatter the bare number should be rendered as a percentage. */
  hint?: 'percent';
}

const NUM = String.raw`\d+(?:\.\d+)?`;

/**
 * Rewrites a line of Soulver-style prose into an expression math.js can parse.
 *
 * Each step is deliberately small and order-dependent; the ordering comments
 * matter more than the regexes do.
 */
export function preprocess(input: string, ctx: PreprocessContext): Preprocessed {
  let s = input.trim();
  let hint: 'percent' | undefined;

  s = stripConversationalPrefix(s);
  s = rewriteCurrencySymbols(s);
  s = stripThousandsSeparators(s);
  s = rewriteMagnitudes(s);
  s = normalizeCurrencyCodes(s, ctx);
  s = rewriteReferences(s);

  const percent = rewritePercentages(s);
  s = percent.expr;
  hint = percent.hint;

  s = rewriteWordOperators(s);
  s = rewriteConversionWords(s);

  return hint ? { expr: s.trim(), hint } : { expr: s.trim() };
}

/** Drops question phrasing and a trailing `=` or `?`. */
function stripConversationalPrefix(s: string): string {
  return s
    .replace(/^(?:what(?:'s| is)|whats|how much is|calculate)\s+/i, '')
    .replace(/[?=]\s*$/, '')
    .trim();
}

/** `$1,000` and `100$` both become `1000 USD`. */
function rewriteCurrencySymbols(s: string): string {
  for (const symbol of SYMBOLS_BY_LENGTH) {
    const code = SYMBOL_TO_CODE[symbol]!;
    const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(
      new RegExp(`${esc}\\s*(${NUM}(?:,\\d{3})*(?:\\.\\d+)?)`, 'g'),
      `$1 ${code}`,
    );
    s = s.replace(
      new RegExp(`(${NUM})\\s*${esc}(?![\\w$])`, 'g'),
      `$1 ${code}`,
    );
  }
  return s;
}

/**
 * Removes digit-grouping commas only. The pattern requires full groups of
 * three, so function arguments like `max(1000, 2000)` are left alone.
 */
function stripThousandsSeparators(s: string): string {
  return s.replace(/\b\d{1,3}(?:,\d{3})+\b/g, (m) => m.replace(/,/g, ''));
}

const MAGNITUDES: Record<string, number> = {
  thousand: 1e3,
  million: 1e6,
  billion: 1e9,
  trillion: 1e12,
};

/**
 * `5k` and `2 million` become plain numbers.
 *
 * Only lowercase `k` is supported as a suffix: `5K` is 5 kelvin, and `5m`
 * is 5 metres. Anything ambiguous with a real unit stays a unit.
 */
function rewriteMagnitudes(s: string): string {
  s = s.replace(
    new RegExp(`\\b(${NUM})\\s*(thousand|million|billion|trillion)\\b`, 'gi'),
    (_m, num: string, word: string) =>
      String(Number(num) * MAGNITUDES[word.toLowerCase()]!),
  );
  return s.replace(new RegExp(`\\b(${NUM})k\\b`, 'g'), (_m, num: string) =>
    String(Number(num) * 1000),
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

/** `line 3` and `prev` become the internal identifiers the scope carries. */
function rewriteReferences(s: string): string {
  return s
    .replace(/\bline\s*(\d+)\b/gi, '__line$1')
    .replace(/\b(?:prev|previous|last)\b/gi, '__prev');
}

/**
 * The percentage rules, in the order they must run.
 *
 * `X as a % of Y` is matched before `X% of Y`, and the trailing `± X%` form is
 * matched before the bare `X%` fallback, otherwise earlier rules eat the input
 * the later ones need.
 */
function rewritePercentages(s: string): { expr: string; hint?: 'percent' } {
  let hint: 'percent' | undefined;

  // "30 as a % of 200" -> 15 %
  const asPercentOf = new RegExp(
    String.raw`^(.+?)\s+as\s+(?:an?\s+)?(?:%|percent(?:age)?)\s+of\s+(.+)$`,
    'i',
  );
  const asMatch = asPercentOf.exec(s);
  if (asMatch) {
    hint = 'percent';
    s = `((${asMatch[1]!}) / (${asMatch[2]!}) * 100)`;
    return { expr: s, hint };
  }

  // "20% off 50" -> 40 ; "20% on 50" -> 60
  s = s.replace(
    new RegExp(String.raw`(${NUM})\s*%\s+off\s+(.+)$`, 'i'),
    (_m, pct: string, rest: string) => `((${rest}) * (1 - ${pct} / 100))`,
  );
  s = s.replace(
    new RegExp(String.raw`(${NUM})\s*%\s+(?:on|added\s+to)\s+(.+)$`, 'i'),
    (_m, pct: string, rest: string) => `((${rest}) * (1 + ${pct} / 100))`,
  );

  // "20% of 50" -> 10
  s = s.replace(
    new RegExp(String.raw`(${NUM})\s*%\s+of\s+(.+)$`, 'i'),
    (_m, pct: string, rest: string) => `((${rest}) * ${pct} / 100)`,
  );

  // "50 + 20%" -> 60. Recursive rather than iterative: the left operand must be
  // rewritten before it is wrapped, or "80 + 10% - 10%" leaves an inner "+ 10%"
  // behind for the bare-percentage rule to misread as "+ 0.1".
  s = rewriteTrailingPercent(s);

  // Anything left is a plain proportion: "15%" -> 0.15
  s = s.replace(new RegExp(String.raw`(${NUM})\s*%`, 'g'), '($1 / 100)');

  return hint ? { expr: s, hint } : { expr: s };
}

const TRAILING_PERCENT = new RegExp(String.raw`^(.+?)\s*([+\-])\s*(${NUM})\s*%\s*$`);

function rewriteTrailingPercent(s: string, depth = 0): string {
  if (depth > 8) return s;
  const m = TRAILING_PERCENT.exec(s);
  if (!m) return s;
  const left = rewriteTrailingPercent(m[1]!, depth + 1);
  const sign = m[2] === '-' ? '-' : '+';
  return `((${left}) * (1 ${sign} ${m[3]!} / 100))`;
}

/** Spelled-out arithmetic: `plus`, `times`, `divided by`. */
function rewriteWordOperators(s: string): string {
  return s
    .replace(/\bdivided\s+by\b/gi, '/')
    .replace(/\bmultiplied\s+by\b/gi, '*')
    .replace(/\bplus\b/gi, '+')
    .replace(/\bminus\b/gi, '-')
    .replace(/\btimes\b/gi, '*');
}

/** `as` and `into` are conversion keywords; math.js spells them `to`. */
function rewriteConversionWords(s: string): string {
  return s.replace(/\b(?:as|into)\b/gi, 'to');
}
