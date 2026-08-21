import {
  classify,
  findComment,
  labelSpan,
  parentheticalAsides,
  QUOTED_RE,
  TAG_RE,
  type Span,
} from './classify.js';
import { SYMBOLS_BY_LENGTH } from './currencies.js';
import { REGION_SEPARATORS, type NumberRegion } from './numberFormat.js';

/**
 * What the engine reads a run of characters as.
 *
 * Finer than the highlighting needs to be, deliberately. Whether a currency
 * should look like a unit or like a number is a question about a palette, and
 * the palette belongs to whoever is drawing; what the engine can answer is what
 * it *read*, and that is what this says. Kinds that share a colour today can
 * stop sharing one without the engine changing.
 */
export type TokenKind =
  /** `# Heading`, `---` — the whole line. */
  | 'heading'
  /** `// note`, and the quoted or parenthesised asides the engine discards. */
  | 'comment'
  /** `#food`. */
  | 'tag'
  /** A numeric literal, including its grouping and magnitude suffix. */
  | 'number'
  /** A word math.js knows as a unit. */
  | 'unit'
  /** A currency symbol, or an ISO code the rate table covers. */
  | 'currency'
  /** `+`, `*`, `%`, brackets — arithmetic written as punctuation. */
  | 'operator'
  /** `of`, `per`, `divided by` — arithmetic written as words. */
  | 'keyword'
  /** A variable, wherever it is declared or read. */
  | 'name'
  /** `line 5`, `prev`. */
  | 'reference'
  /** The verb of a `sum` / `average` / `count` / `median` line. */
  | 'directive';

/** A token's kind and where it sits, as offsets into its own line. */
export interface Token extends Span {
  kind: TokenKind;
}

export interface TokenizeContext {
  /** ISO codes the engine can convert between. */
  currencies: ReadonlySet<string>;
  /** True if math.js already understands the word as a unit (`cup`, `km`). */
  isKnownUnit(word: string): boolean;
  region: NumberRegion;
  /** Names bound before the sheet runs — the instance's global variables. */
  globals?: Iterable<string>;
}

/**
 * Words that are arithmetic when the engine meets them, not prose.
 *
 * Collected from the rewriters in `preprocess.ts` rather than invented: every
 * word here is one some rule there consumes. `in` is the awkward one — it is
 * both the conversion keyword and the symbol for inches — and is resolved the
 * same way the rewriters resolve it, by what sits in front of it.
 */
const WORD_OPERATORS = new Set([
  // question phrasing
  'what',
  'whats',
  'how',
  'much',
  'is',
  'calculate',
  // spelled-out arithmetic
  'plus',
  'minus',
  'times',
  'multiplied',
  'divided',
  'by',
  'remainder',
  'square',
  'cube',
  'root',
  'power',
  'the',
  'mod',
  // conversion and rates
  'to',
  'in',
  'as',
  'into',
  'per',
  'of',
  'through',
  'until',
  // percentages and multipliers
  'percent',
  'percentage',
  'off',
  'on',
  'added',
  'and',
  'or',
  'x',
  'multiplier',
  'multiple',
  'fraction',
  // rounding and notation
  'rounded',
  'nearest',
  'up',
  'down',
  'dp',
  'decimal',
  'decimals',
  'places',
  'digits',
  'sig',
  'significant',
  'figs',
  'figures',
  'full',
  'plain',
  'unabbreviated',
  'sci',
  'scientific',
  'notation',
  'number',
  'dec',
  // statistics, which are also line directives
  'sum',
  'total',
  'subtotal',
  'average',
  'avg',
  'mean',
  'count',
  'median',
]);

/** Words that scale the number in front of them, and read as part of it. */
const MAGNITUDE_WORDS = new Set(['thousand', 'million', 'billion', 'trillion']);

/** Named constants, which are values however they are spelled. */
const CONSTANTS = new Set(['pi', 'tau', 'phi', 'infinity']);

/** `line 5` and `prev`, exactly as `rewriteReferences` reads them. */
const REFERENCE_RE = /\bline\s*\d+\b|\b(?:prev|previous|last)\b/gi;

/**
 * Punctuation that is arithmetic.
 *
 * `.` and `?` are absent: both are far more often the end of a sentence than
 * an operator, and the engine strips a trailing `?` rather than reading it.
 */
const OPERATOR_RE = /[-+*/^%()=<>,!&|~:°×÷−–—√]+/y;

const WORD_RE = /[A-Za-z_][\w]*/y;

/**
 * A numeric literal, in the reader's own convention.
 *
 * Built from the same separators `normalizeNumberLiterals` reads, so a sheet
 * set to western Europe colours `1.234,56` as the one number the engine will
 * evaluate it as rather than as three.
 */
function numberPattern(region: NumberRegion): RegExp {
  const { group, decimal } = REGION_SEPARATORS[region];
  // The eastern-European group separator is a space, and a non-breaking one
  // arrives whenever a number has been pasted out of a document.
  const g = group === ' ' ? '[ \\u00a0]' : `\\${group}`;
  const d = `\\${decimal}`;
  const grouped = `\\d{1,3}(?:${g}\\d{3})+`;
  const plain = String.raw`\d+(?:_\d+)*`;
  return new RegExp(`0[xbo][0-9a-fA-F]+|(?:${grouped}|${plain})(?:${d}\\d+)?`, 'y');
}

/**
 * Magnitude suffixes, which are part of the number rather than a unit.
 *
 * Two sets, because a currency symbol is what makes `m` and `b` unambiguous —
 * bare `5m` is five metres. `rewriteCurrencyAmounts` and `rewriteMagnitudes`
 * draw the line in exactly this place.
 */
const MAGNITUDE_SUFFIX = /(?:k|M|G|T)(?![\w])/y;
const CURRENCY_SUFFIX = /(?:bn|tn|[kKmMbBtTG])(?![\w])/y;

/**
 * Where every token on each line is, and what the engine reads it as.
 *
 * Walked in order and carrying the names declared above, because that is what
 * the sheet does: a word is only a variable from the line that declares it
 * downwards, and a name that is also a unit keeps its unit meaning directly
 * after a number. Both rules are the engine's, and highlighting that disagreed
 * with them would be worse than none — the colour is supposed to be how you
 * notice `hours` has stopped meaning hours.
 */
export function tokenizeLines(lines: string[], ctx: TokenizeContext): Token[][] {
  const names = new Set<string>();
  for (const global of ctx.globals ?? []) {
    if (global.trim()) names.add(global.trim().toLowerCase());
  }

  const isKnownWord = (word: string): boolean =>
    ctx.isKnownUnit(word) ||
    ctx.currencies.has(word.toUpperCase()) ||
    names.has(word.toLowerCase());

  const number = numberPattern(ctx.region);
  return lines.map((raw) => tokenizeLine(raw ?? '', ctx, names, isKnownWord, number));
}

function tokenizeLine(
  raw: string,
  ctx: TokenizeContext,
  names: Set<string>,
  isKnownWord: (word: string) => boolean,
  number: RegExp,
): Token[] {
  const line = classify(raw, isKnownWord);
  const tokens: Token[] = [];
  /** Characters already spoken for, so the scan below never re-reads them. */
  const covered: boolean[] = new Array(raw.length).fill(false);
  /** The token starting at each offset, for the scan to step over in one go. */
  const starts = new Map<number, Token>();

  const claim = (from: number, to: number, kind?: TokenKind): void => {
    const end = Math.min(to, raw.length);
    if (end <= from || from < 0) return;
    if (kind) {
      const token: Token = { from, to: end, kind };
      tokens.push(token);
      starts.set(from, token);
    }
    for (let at = from; at < end; at++) covered[at] = true;
  };

  // Everything the classifier discards is claimed first, in the order it
  // discards it, so what is left to scan is what the engine actually reads.
  const commentAt = findComment(raw);
  const code = commentAt >= 0 ? raw.slice(0, commentAt) : raw;
  if (commentAt >= 0) claim(commentAt, raw.length, 'comment');

  if (line.kind === 'heading') {
    // A heading is one thing, whatever it is made of. Claiming the body whole
    // keeps `# 3 for the road` from reading as arithmetic inside a title.
    const from = code.length - code.trimStart().length;
    claim(from, code.trimEnd().length, 'heading');
    return sorted(tokens);
  }

  for (const match of code.matchAll(TAG_RE)) {
    const from = (match.index ?? 0) + (match[1]?.length ?? 0);
    claim(from, from + match[0].length - (match[1]?.length ?? 0), 'tag');
  }

  for (const match of code.matchAll(QUOTED_RE)) {
    claim(match.index ?? 0, (match.index ?? 0) + match[0].length, 'comment');
  }

  // Each of these is given a copy with everything claimed before it blanked
  // out, so it sees the text the classifier saw at that point in its own
  // order — asides after the quotes, the label after the asides.
  for (const aside of parentheticalAsides(blank(code, covered), isKnownWord)) {
    claim(aside.from, aside.to, 'comment');
  }
  const label = labelSpan(blank(code, covered));
  // Claimed without a kind: a label is prose, and prose is what is left
  // uncoloured. All this has to do is stop the scan reading `128 GB` in one.
  if (label) claim(label.from, label.to);

  const body = blank(code, covered);
  const at = body.length - body.trimStart().length;

  if (line.kind === 'directive') {
    WORD_RE.lastIndex = at;
    const verb = WORD_RE.exec(body);
    if (verb) claim(at, at + verb[0].length, 'directive');
  }

  // Declared before the scan so the declaration itself is coloured as a name,
  // and so `x = x + 1` shows both halves as the one variable.
  if (line.kind === 'assignment' && line.name) {
    names.add(line.name.toLowerCase());
  }

  for (const match of body.matchAll(REFERENCE_RE)) {
    claim(match.index ?? 0, (match.index ?? 0) + match[0].length, 'reference');
  }

  claimNames(blank(code, covered), names, ctx, claim);
  scan(blank(code, covered), ctx, number, covered, starts, claim);

  return sorted(tokens);
}

/**
 * The text with every claimed character replaced by a space of its own.
 *
 * A space rather than nothing, so every offset still means what it meant in
 * the line the reader is looking at — which is the whole point of doing this
 * in spans rather than by rewriting, as the evaluator does.
 */
function blank(code: string, covered: boolean[]): string {
  const out: string[] = [];
  for (let at = 0; at < code.length; at++) out.push(covered[at] ? ' ' : code[at]!);
  return out.join('');
}

/**
 * Marks the variables a line reads.
 *
 * Longest name first, so `monthly rent` is not claimed as `monthly` — and with
 * the same guard `applyAliases` uses: a name that is also a unit keeps its unit
 * meaning directly after a number, or `hours = 6.5` would quietly recolour
 * every `2 hours` below it as well as quietly redefining it.
 */
function claimNames(
  text: string,
  names: Set<string>,
  ctx: TokenizeContext,
  claim: (from: number, to: number, kind?: TokenKind) => void,
): void {
  if (names.size === 0) return;
  let remaining = text;
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const pattern = new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'gi');
    for (const match of remaining.matchAll(pattern)) {
      const from = match.index ?? 0;
      if (ctx.isKnownUnit(match[0]) && /\d\s*$/.test(remaining.slice(0, from))) continue;
      claim(from, from + match[0].length, 'name');
    }
    // Matched spans become spaces for the names still to be tried, so a
    // shorter name cannot re-read the middle of a longer one.
    remaining = remaining.replace(pattern, (word) => ' '.repeat(word.length));
  }
}

/**
 * Reads what is left, left to right.
 *
 * Order matters in two places. A currency symbol is looked for before a number
 * so `$9bn` may take the wider set of magnitude suffixes, which is only
 * unambiguous next to a symbol. And a word is tested against the engine's
 * vocabulary before its units, so the `in` of `5 km in miles` is a conversion
 * while the `in` of `12 in` is inches — decided, as the rewriters decide it, by
 * whether a number sits in front.
 */
function scan(
  text: string,
  ctx: TokenizeContext,
  number: RegExp,
  covered: boolean[],
  starts: Map<number, Token>,
  claim: (from: number, to: number, kind?: TokenKind) => void,
): void {
  let at = 0;
  /** The token immediately to the left, or nothing across a gap in the line. */
  let previous: Token | undefined;

  while (at < text.length) {
    if (covered[at]) {
      const token = starts.get(at);
      at = token ? token.to : at + 1;
      previous = undefined;
      continue;
    }
    if (/\s/.test(text[at]!)) {
      at++;
      continue;
    }

    const symbol = SYMBOLS_BY_LENGTH.find((candidate) => text.startsWith(candidate, at));
    if (symbol) {
      previous = { from: at, to: at + symbol.length, kind: 'currency' };
      claim(previous.from, previous.to, 'currency');
      at = previous.to;
      continue;
    }

    number.lastIndex = at;
    const literal = number.exec(text);
    if (literal) {
      const suffix = previous?.kind === 'currency' ? CURRENCY_SUFFIX : MAGNITUDE_SUFFIX;
      suffix.lastIndex = at + literal[0].length;
      const scaled = suffix.exec(text);
      const to = at + literal[0].length + (scaled?.[0].length ?? 0);
      previous = { from: at, to, kind: 'number' };
      claim(at, to, 'number');
      at = to;
      continue;
    }

    WORD_RE.lastIndex = at;
    const word = WORD_RE.exec(text);
    if (word) {
      const to = at + word[0].length;
      const kind = readWord(word[0], text.slice(to), previous, ctx);
      if (kind) {
        previous = { from: at, to, kind };
        claim(at, to, kind);
      } else {
        // Prose. It ends whatever ran up to it, so the next word cannot read
        // itself as a unit on the strength of a number two words back.
        previous = undefined;
      }
      at = to;
      continue;
    }

    OPERATOR_RE.lastIndex = at;
    const operator = OPERATOR_RE.exec(text);
    if (operator) {
      const to = at + operator[0].length;
      previous = { from: at, to, kind: 'operator' };
      claim(at, to, 'operator');
      at = to;
      continue;
    }

    previous = undefined;
    at++;
  }
}

/** What a bare word means here, or nothing at all if it is prose. */
function readWord(
  word: string,
  rest: string,
  previous: Token | undefined,
  ctx: TokenizeContext,
): TokenKind | undefined {
  const lower = word.toLowerCase();
  if (MAGNITUDE_WORDS.has(lower) || CONSTANTS.has(lower)) return 'number';
  // A word against a bracket is a function call, which is the same guard
  // `rewriteLabelledQuantities` uses to leave `round(1.5)` alone.
  if (/^\s*\(/.test(rest)) return 'keyword';

  const quantified = previous?.kind === 'number' || previous?.kind === 'currency';
  if (WORD_OPERATORS.has(lower)) {
    if (!quantified || !ctx.isKnownUnit(word)) return 'keyword';
    /*
     * `in` is the awkward one, and the only one this reaches: it is both the
     * conversion keyword and the symbol for inches. What decides it is what
     * comes next, which is how math.js decides it too — `$1,250 in EUR` is a
     * conversion because a unit follows, and `12 in` is twelve inches because
     * nothing does.
     */
    const target = /^\s*([A-Za-z_][\w]*)/.exec(rest)?.[1];
    const converts =
      target !== undefined &&
      (ctx.isKnownUnit(target) || ctx.currencies.has(target.toUpperCase()));
    return converts ? 'keyword' : 'unit';
  }

  const upper = word.toUpperCase();
  // Up-cased on the engine's terms: a lowercase code is only money when
  // math.js does not already know the word as a unit — see
  // `normalizeCurrencyCodes`, which keeps `100 cup` a volume.
  if (ctx.currencies.has(upper) && (word === upper || !ctx.isKnownUnit(word))) {
    return 'currency';
  }
  return ctx.isKnownUnit(word) ? 'unit' : undefined;
}

function sorted(tokens: Token[]): Token[] {
  return tokens.sort((a, b) => a.from - b.from);
}
