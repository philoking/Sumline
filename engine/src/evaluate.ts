import { classify, type Classified } from './classify.js';
import {
  CalendarDate,
  FrameCount,
  TemporalNumber,
  Timecode,
  Timespan,
} from './temporal/types.js';
import { evaluateTemporal, looksTemporal } from './temporal/evaluate.js';
import { convertAt, parseHistoricalConversion } from './historical.js';
import { describeError } from './errors.js';
import { DEFAULT_PRECISION, formatValue, type FormatContext } from './format.js';
import { createMathContext, toFps, type MathContext } from './mathInstance.js';
import { toNumberRegion } from './numberFormat.js';
import { toZone, wallClockDate } from './temporal/zones.js';
import { preprocess, stripOuterParens } from './preprocess.js';
import { Labelled, Multiplier, Percentage, Rate } from './values.js';
import type { Engine, EngineOptions, LineResult, Statistic } from './types.js';

export function createEngine(options: EngineOptions = {}): Engine {
  const ctx = createMathContext(
    options.rates,
    new Set(options.holidays ?? []),
    toFps(options.fps),
    options.historicalRates ?? {},
    options.zone === undefined ? null : toZone(options.zone),
  );
  // Coerced once here rather than at each use, so a region written by hand
  // through the settings API cannot leave the sheet answering nothing.
  const region = toNumberRegion(options.region);
  // Null when unset or unrecognised, which is what makes every date resolve in
  // the reader's own zone exactly as it did before this existed.
  const zone = options.zone === undefined ? null : toZone(options.zone);
  const currencies = [...ctx.currencies].sort();

  /**
   * The one clock, read once per call.
   *
   * `options.now` pins it for tests and for the reference table; without it
   * every call reads the wall clock. This used to be read twice — freshly for
   * evaluation, and once at construction for the `FormatContext` — so on a tab
   * left open for hours `today` was computed against one instant and rendered
   * against another. Anything that formats relative to now ("Tomorrow at 9:00
   * am") or infers a year from proximity disagreed with the value it was
   * describing.
   */
  const readClock = (): Date => options.now ?? new Date();

  /** A formatting context bound to a single instant. */
  const contextAt = (now: Date): FormatContext => ({
    currencies: ctx.currencies,
    now,
    region,
    largeNumberNotation: options.largeNumberNotation ?? true,
    // Clamped rather than trusted: these are stored settings, and the README
    // documents writing settings with `curl`, so a negative or absurd value is
    // a real arrival and `toFixed` throws outside 0–100.
    precision: clampPrecision(options.precision),
    thousandsSeparators: options.thousandsSeparators ?? true,
    currencyRounding: options.currencyRounding ?? true,
  });

  return {
    currencies,
    rateDate: options.rates?.date ?? null,
    evaluate(source) {
      const lines = Array.isArray(source) ? source : source.split('\n');
      const now = readClock();
      // The sheet reasons against the zone's wall clock; the true instant stays
      // available for timestamps. Both derive from the one clock read above.
      const wallNow = zone ? wallClockDate(now, zone) : now;
      return evaluateLines(lines, ctx, now, wallNow, contextAt(wallNow), options.globals);
    },
    ratesNeeded(source) {
      const lines = Array.isArray(source) ? source : source.split('\n');
      const now = readClock();
      const dates = new Set<string>();
      for (const raw of lines) {
        // The line is classified first so a commented-out or labelled request is
        // read the same way evaluation will read it, rather than the host
        // fetching rates for a line that is never going to convert anything.
        const line = classify(raw ?? '', (word) => isKnownWord(ctx, EMPTY_SHEET, word));
        if (line.kind !== 'expression' && line.kind !== 'assignment') continue;
        const wanted = parseHistoricalConversion(line.body, {
          region,
          currencies: ctx.currencies,
          now,
        });
        if (wanted) dates.add(wanted.on);
      }
      return [...dates];
    },
    total(results) {
      return this.summary(results, 'total');
    },
    summary(results, statistic, summaryOptions) {
      // Absent means counted, which is what the corner has always done and
      // what Soulver's own Total Options ship ticked.
      const countVariables = summaryOptions?.countVariables !== false;
      const countReferenced = summaryOptions?.countReferenced !== false;
      const values = results
        .filter(
          (r) =>
            (r.kind === 'expression' || (countVariables && r.kind === 'assignment')) &&
            // Two independent filters, as in Soulver: a declaration that is
            // also read later is dropped by either one on its own.
            (countReferenced || !r.referenced),
        )
        .map((r) => r.value)
        .filter(isAddable);
      if (values.length === 0) return '';
      const figure = reduceValues(ctx, values, statistic);
      return figure === undefined ? '' : formatValue(figure, contextAt(readClock()));
    },
  };
}

/** Applies a sheet-level statistic to a list of values. */
function reduceValues(
  ctx: MathContext,
  values: unknown[],
  statistic: Statistic,
): unknown {
  if (statistic === 'count') return values.length;

  if (statistic === 'median') {
    // Sorting needs a comparison that works on units as well as numbers.
    try {
      const sorted = [...values].sort((a, b) =>
        Number(ctx.math.compare(a as never, b as never)),
      );
      const middle = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 1) return sorted[middle];
      return ctx.math.divide(
        ctx.math.add(sorted[middle - 1] as never, sorted[middle] as never) as never,
        2 as never,
      );
    } catch {
      return undefined;
    }
  }

  const sum = addAll(ctx, values);
  if (sum === undefined || statistic === 'total') return sum;
  try {
    return ctx.math.divide(sum as never, values.length as never);
  } catch {
    return undefined;
  }
}

/** Adds a list of values, returning undefined if their types cannot combine. */
function addAll(ctx: MathContext, values: unknown[]): unknown {
  try {
    return values.reduce((acc, value) =>
      acc === undefined ? value : ctx.math.add(acc as never, value as never),
    );
  } catch {
    return undefined;
  }
}

/**
 * A sheet state with nothing declared in it.
 *
 * `ratesNeeded` classifies lines without evaluating them, so no variable has
 * been bound yet and there is nothing for `isKnownWord` to find beyond units and
 * currencies — which is all a currency conversion needs it to recognise.
 */
const EMPTY_SHEET: SheetState = {
  scope: {},
  aliases: new Map(),
  section: [],
  tagged: new Map(),
  referenced: new Set(),
  prevLine: null,
};

/** Mutable state threaded down the sheet as each line is evaluated. */
interface SheetState {
  scope: Record<string, unknown>;
  /** Original variable name (lowercased) -> safe math.js identifier. */
  aliases: Map<string, string>;
  /** Values in the current section, for `sum` / `average`. */
  section: unknown[];
  /** Values by tag, for `sum #food`. */
  tagged: Map<string, unknown[]>;
  /**
   * Line numbers a later line has read, for `countReferenced`.
   *
   * Collected as the sheet is walked rather than scanned for afterwards,
   * because `prev` resolves to the last line that produced a value — which
   * depends on where evaluation had reached, not on the text alone.
   */
  referenced: Set<number>;
  /** The line `prev` currently points at, or null before any value. */
  prevLine: number | null;
}

/** The most decimal places worth offering, and the most `toFixed` accepts. */
const MAX_PRECISION = 15;

function clampPrecision(precision: number | undefined): number {
  if (precision === undefined || !Number.isFinite(precision)) {
    return DEFAULT_PRECISION;
  }
  return Math.min(MAX_PRECISION, Math.max(0, Math.round(precision)));
}

/** `line 3` in a line's own text, matching what `rewriteReferences` rewrites. */
const LINE_REFERENCE = /\bline\s*(\d+)\b/gi;
const PREV_REFERENCE = /\b(?:prev|previous|last)\b/i;

/**
 * Notes which earlier lines this one reads.
 *
 * Only backwards: `line 5` written on line 2 is a forward reference, which the
 * sheet cannot satisfy anyway, and counting line 5 as "used above" would then
 * quietly drop it from the figure.
 */
function noteReferences(body: string, at: number, state: SheetState): void {
  for (const match of body.matchAll(LINE_REFERENCE)) {
    const target = Number(match[1]);
    if (target >= 1 && target < at) state.referenced.add(target);
  }
  if (PREV_REFERENCE.test(body) && state.prevLine !== null) {
    state.referenced.add(state.prevLine);
  }
}

function evaluateLines(
  lines: string[],
  ctx: MathContext,
  now: Date,
  wallNow: Date,
  fmt: FormatContext,
  globals?: Readonly<Record<string, string>>,
): LineResult[] {
  const state: SheetState = {
    scope: {},
    aliases: new Map(),
    section: [],
    tagged: new Map(),
    referenced: new Set(),
    prevLine: null,
  };
  seedGlobals(state, ctx, now, wallNow, fmt, globals);
  const results: LineResult[] = [];

  for (const [index, raw] of lines.entries()) {
    const line = classify(raw ?? '', (word) => isKnownWord(ctx, state, word));
    // Noted before this line is evaluated, while `prevLine` still means what
    // it meant to this line rather than to the one after it.
    if (line.kind === 'expression' || line.kind === 'assignment') {
      noteReferences(line.body, index + 1, state);
    }
    const result = evaluateLine(line, index, state, ctx, now, wallNow, fmt);
    results.push(result);

    // Expose the answer to later lines as `line N` and `prev`.
    if (result.value !== undefined) {
      state.scope[`__line${index + 1}`] = result.value;
      state.scope['__prev'] = result.value;
      state.prevLine = index + 1;
      // A subtotal must not feed the section it just closed, or the next
      // subtotal counts it a second time.
      if (line.kind !== 'directive' && isAddable(result.value)) {
        state.section.push(result.value);
        for (const tag of line.tags) {
          const bucket = state.tagged.get(tag) ?? [];
          bucket.push(result.value);
          state.tagged.set(tag, bucket);
        }
      }
    }
  }

  // Marked at the end, because a line is only known to have been read once
  // every line after it has been looked at.
  for (const line of state.referenced) {
    const result = results[line - 1];
    if (result) result.referenced = true;
  }

  return results;
}

/**
 * Binds instance-wide variables before the sheet runs.
 *
 * They are ordinary scope entries, so a sheet can use them, and can shadow one
 * by declaring the same name — which is what makes them a default rather than
 * a constant.
 */
function seedGlobals(
  state: SheetState,
  ctx: MathContext,
  now: Date,
  wallNow: Date,
  fmt: FormatContext,
  globals?: Readonly<Record<string, string>>,
): void {
  for (const [name, expression] of Object.entries(globals ?? {})) {
    if (!name.trim() || !expression.trim()) continue;
    const computed = compute(expression, state, ctx, now, wallNow, fmt);
    if (computed.value !== undefined) {
      state.scope[aliasFor(name, state)] = computed.value;
    }
  }
}

function evaluateLine(
  line: Classified,
  index: number,
  state: SheetState,
  ctx: MathContext,
  now: Date,
  wallNow: Date,
  fmt: FormatContext,
): LineResult {
  const base: LineResult = { index, kind: line.kind, output: '' };
  if (line.tags.length > 0) base.tags = line.tags;

  switch (line.kind) {
    case 'blank':
    case 'comment':
      return base;

    case 'heading':
      // A heading opens a new section, so subtotals restart beneath it.
      state.section = [];
      return base;

    case 'directive':
      return { ...base, ...runDirective(line, state, ctx, fmt) };

    case 'assignment':
    case 'expression': {
      const computed = compute(line.body, state, ctx, now, wallNow, fmt);
      if (computed.error) {
        return looksComputational(line.body)
          ? { ...base, error: computed.error }
          : base;
      }
      if (computed.value === undefined) return base;

      if (line.kind === 'assignment' && line.name) {
        const alias = aliasFor(line.name, state);
        // `+=` and `-=` fold into whatever the name already holds.
        const stored = applyAssignment(
          ctx,
          line.assignOp ?? '=',
          state.scope[alias],
          computed.value,
        );
        state.scope[alias] = stored;
        base.name = line.name;
        return {
          ...base,
          value: stored,
          output: formatValue(stored, fmt),
        };
      }
      return { ...base, value: computed.value, output: computed.output };
    }
  }
}

interface Computed {
  value?: unknown;
  output: string;
  error?: string;
}

/**
 * Replaces a parenthesised duration with that duration written out.
 *
 * The temporal rules are a chain of anchored patterns with no notion of
 * nesting, so `(8:30 to 17:15) - 45 minutes` cannot be matched as a whole.
 * Resolving the group first leaves `8 hours 45 minutes - 45 minutes`, which
 * the existing rules do handle.
 *
 * Only durations are substituted. A date or a clock time would have to be
 * rendered back into text and re-parsed, and round-tripping an answer through
 * its own display format is how precision goes missing.
 */
function resolveTemporalGroups(
  body: string,
  options: { now: Date; holidays: ReadonlySet<string>; fps: number },
): string {
  if (!body.includes('(')) return body;
  return body.replace(/\(([^()]+)\)/g, (match, inner: string) => {
    if (!looksTemporal(inner)) return match;
    const value = evaluateTemporal(inner, options);
    return value instanceof Timespan ? spellOut(value) : match;
  });
}

/**
 * Writes a duration back out in the units it is held in, so the temporal
 * rules can read it as an operand.
 *
 * The parts are used rather than the display format: `8 hours 45 minutes`
 * re-parses to exactly the value it came from, where an abbreviated or
 * rounded rendering would not.
 */
function spellOut(span: Timespan): string {
  if (span.parts.length === 0) return '0 seconds';
  return span.parts.map((part) => `${part.value} ${part.unit}s`).join(' ');
}

function compute(
  body: string,
  state: SheetState,
  ctx: MathContext,
  now: Date,
  wallNow: Date,
  fmt: FormatContext,
): Computed {
  if (body.trim() === '') return { output: '' };

  /*
   * Brackets are resolved once, up front, and the result is what both the
   * temporal rules and the expression parser see. Feeding the original text
   * to the parser after resolving it for the temporal pass is how
   * `(8:30 to 17:15) - 45 minutes` ended up back at math.js as a range.
   */
  const options = { now, wallNow, zone: ctx.zone, holidays: ctx.holidays, fps: ctx.fps };
  const source = resolveTemporalGroups(stripOuterParens(body), options);

  /*
   * Before the temporal gate, because a conversion at a named date reads as
   * temporal — `on 2020-01-01` is a date by any measure — and the temporal rules
   * would claim the line and answer with the date rather than the money.
   */
  const historical = convertHistorically(source, ctx, wallNow, fmt);
  if (historical) return historical;

  // Dates, times and durations never reach math.js; the gate keeps ordinary
  // arithmetic out of this branch.
  if (looksTemporal(source)) {
    const temporal = evaluateTemporal(source, options);
    if (temporal !== null && temporal !== undefined) {
      return { value: temporal, output: formatValue(temporal, fmt) };
    }
  }

  const { expr, hint, decimals, notation } = preprocess(source, {
    currencies: ctx.currencies,
    isKnownUnit: (word) => isKnownUnit(ctx, word),
    scopeNames: new Set(state.aliases.keys()),
    region: fmt.region,
  });

  const resolved = applyAliases(expr, state.aliases, (word) => isKnownUnit(ctx, word));

  /*
   * `5 km in` — a conversion whose target has not been typed yet.
   *
   * math.js reads the trailing `in` as inches and answers `5 km in`, an area
   * nobody asked for, on every keystroke between `in` and the unit that
   * follows it. A word directly after a number really is inches (`12 in`), so
   * only a dangling one is refused.
   */
  if (isDanglingConversion(resolved)) return { output: '' };

  const format = (value: unknown): Computed => ({
    value,
    output: formatValue(value, {
      ...fmt,
      ...(hint && { hint }),
      ...(decimals !== undefined && { decimals }),
      ...(notation === 'full' && { largeNumberNotation: false }),
    }),
  });

  try {
    const value = ctx.math.evaluate(resolved, state.scope);
    if (value === undefined || typeof value === 'function') return { output: '' };
    // `0/0` and `10^1000` are arithmetic that did not survive. Showing "NaN"
    // or "Infinity" in the answer column is noise; a quiet error is honest.
    if (!isFinitePresentable(value)) {
      return { output: '', error: 'That does not work out to a number' };
    }
    return format(value);
  } catch (error) {
    const explained = describeError(error, {
      currencies: ctx.currencies,
      units: ctx.unitNames,
    });

    /*
     * A line that named a unit or currency the engine does not have is not a
     * note with a number in it, and must not be rescued by dropping the word
     * it got wrong: `1 BTC in USD` would fall to `1 BTC`, answering a question
     * nobody asked. The refusal is the answer.
     */
    if (explained.unknown === undefined) {
      // "I spent $128 + $45 on clothes" is a note with a sum in it, not a broken
      // expression. If the only problem was surrounding prose, drop it and retry.
      const withoutProse = stripProse(resolved, (word) => isKnownWord(ctx, state, word));
      if (withoutProse) {
        try {
          return format(ctx.math.evaluate(withoutProse, state.scope));
        } catch {
          // fall through to the original error, which is the more useful one
        }
      }
    }

    return { output: '', error: explained.message };
  }
}

/**
 * Converts money at a date the line named, or returns null if it is not one.
 *
 * The three states of a requested date are the whole reason this returns a
 * `Computed` rather than a value:
 *
 *  - not fetched yet — an empty answer and no error, so a line does not flash
 *    red for the moment between being typed and its rates arriving;
 *  - fetched and unavailable — an error naming the date, because falling back to
 *    today's rate is exactly the silent wrongness this feature exists to remove;
 *  - fetched — an ordinary money value, so it totals and converts like any other.
 */
function convertHistorically(
  source: string,
  ctx: MathContext,
  now: Date,
  fmt: FormatContext,
): Computed | null {
  const wanted = parseHistoricalConversion(source, {
    region: fmt.region,
    currencies: ctx.currencies,
    now,
  });
  if (!wanted) return null;

  if (!(wanted.on in ctx.historicalRates)) return { output: '' };

  const table = ctx.historicalRates[wanted.on];
  if (!table) {
    return { output: '', error: `No exchange rates available for ${wanted.on}` };
  }

  const converted = convertAt(wanted, table);
  if ('error' in converted) return { output: '', error: converted.error };

  // Handed back as a math.js unit so it behaves like every other money value:
  // it feeds the running total, and a later line can convert or scale it.
  try {
    const value = ctx.math.unit(converted.amount, converted.code);
    return { value, output: formatValue(value, fmt) };
  } catch {
    return { output: '', error: `Cannot express an amount in ${converted.code}` };
  }
}

/** Combines a new value with the variable's previous one, for `+=` and `-=`. */
function applyAssignment(
  ctx: MathContext,
  operator: '=' | '+=' | '-=',
  previous: unknown,
  value: unknown,
): unknown {
  if (operator === '=' || previous === undefined) return value;
  try {
    return operator === '+='
      ? ctx.math.add(previous as never, value as never)
      : ctx.math.subtract(previous as never, value as never);
  } catch {
    return value;
  }
}

/**
 * Whether a value is a number the answer column can honestly show.
 *
 * Anything that has become NaN or Infinity is reported as an error instead:
 * an answer of "NaN" tells the reader nothing they can act on.
 */
function isFinitePresentable(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (value instanceof Percentage) return Number.isFinite(value.ratio);
  if (value instanceof Multiplier) return Number.isFinite(value.factor);
  if (value instanceof Labelled) return Number.isFinite(value.value);
  if (value instanceof Rate) return isFinitePresentable(value.amount);

  const unit = value as { formatUnits?: () => string; toNumeric?: (u: string) => number };
  if (typeof unit?.formatUnits === 'function' && unit.toNumeric) {
    return Number.isFinite(unit.toNumeric(unit.formatUnits()));
  }
  return true;
}

/** Whether a bare word means something to the engine, rather than being prose. */
function isKnownWord(ctx: MathContext, state: SheetState, word: string): boolean {
  return (
    isKnownUnit(ctx, word) ||
    ctx.currencies.has(word.toUpperCase()) ||
    state.aliases.has(word.toLowerCase()) ||
    word.startsWith('__')
  );
}

/**
 * Words that are conversion operators here, whatever else they also mean.
 *
 * `as` and `into` are rewritten to `to` before an expression gets this far, so
 * only the two survivors need naming. Both are also real units — `in` is
 * inches — which is the whole difficulty.
 */
const CONVERSION_WORDS = new Set(['in', 'to']);

/** Whether an expression ends in a conversion whose target is missing. */
function isDanglingConversion(expr: string): boolean {
  const trailing = /^(.*?)\s+([A-Za-z]+)$/.exec(expr.trim());
  if (!trailing || !CONVERSION_WORDS.has(trailing[2]!.toLowerCase())) return false;
  // A number before the word makes it a unit — `12 in` is twelve inches.
  return !/\d$/.test(trailing[1]!.trim());
}

/**
 * Strips the words around an expression, so a line written the way people
 * actually keep notes still produces a number.
 *
 * Both ends are trimmed: a leading label (`lunch $12`) and a trailing aside
 * (`... on clothes`). Only words the engine does not recognise are removed, so
 * units and variables are never mistaken for commentary.
 */
function stripProse(expr: string, isKnown: (word: string) => boolean): string | null {
  const words = /^([A-Za-z_][\w']*(?:\s+[A-Za-z_][\w']*)*)\s+(.+)$/.exec(expr.trim());
  let rest = expr.trim();

  if (words && !words[1]!.split(/\s+/).some(isKnown)) {
    const tail = words[2]!.trim();
    // A leading word followed by an operator is arithmetic on a variable that
    // genuinely failed; only a "label value" shape is worth retrying.
    if (/\d/.test(tail) && !/^[+\-*/^)]/.test(tail)) rest = tail;
  }

  // Drop trailing words one at a time, stopping at the first that means
  // something — otherwise the `USD` in "$45 on clothes" ends the scan early.
  const tokens = rest.split(/\s+/);
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]!;
    /*
     * A conversion keyword at the end is not a word that survived the scan —
     * it is the operator whose right-hand side has just been removed. `in` is
     * also the symbol for inches, so what remained still evaluated, in inches:
     * "10 in binary" answered `10 in`. Dropping the keyword as well leaves the
     * quantity the line was about, which is what a note like "45 USD in cash"
     * meant anyway. A conversion the engine could actually have performed
     * never reaches here — an unknown code is refused before the retry rather
     * than rescued into a different question.
     */
    if (CONVERSION_WORDS.has(last.toLowerCase())) {
      tokens.pop();
      continue;
    }
    if (!/^[A-Za-z_][\w']*$/.test(last) || isKnown(last)) break;
    tokens.pop();
  }
  rest = tokens.join(' ');

  return rest !== expr.trim() && /\d/.test(rest) ? rest : null;
}

function runDirective(
  line: Classified,
  state: SheetState,
  ctx: MathContext,
  fmt: FormatContext,
): Partial<LineResult> {
  const values = line.directiveTag
    ? (state.tagged.get(line.directiveTag) ?? [])
    : state.section;

  if (line.directive === 'count') {
    const count = values.length;
    return { value: count, output: formatValue(count, fmt) };
  }

  if (values.length === 0) return { output: '' };

  // The directive calls it `sum`; the statistic calls the same thing `total`.
  const directive = line.directive ?? 'sum';
  const total = reduceValues(ctx, values, directive === 'sum' ? 'total' : directive);
  if (total === undefined) {
    return { error: 'These values cannot be combined' };
  }

  const output = formatValue(total, fmt);

  // An untagged subtotal closes its section, so stacked totals do not
  // double-count the lines above them.
  if (!line.directiveTag) state.section = [];

  return { value: total, output };
}

/**
 * Maps a user-facing variable name to a math.js-safe identifier.
 *
 * Multi-word names like `monthly rent` are the reason this indirection exists:
 * they read naturally but are not valid identifiers.
 */
function aliasFor(name: string, state: SheetState): string {
  const key = name.toLowerCase();
  const existing = state.aliases.get(key);
  if (existing) return existing;
  const alias = `__v${state.aliases.size}`;
  state.aliases.set(key, alias);
  return alias;
}

/**
 * Substitutes known variable names, longest first so prefixes do not win.
 *
 * A name that is also a unit keeps its unit meaning in the one place it can
 * only be a unit — directly after a number. Without that, `hours = 6.5` on one
 * line quietly redefined `hours` for every line below it, so `2 hours` became
 * thirteen and nothing said so.
 *
 * The guard applies only to names math.js already knows as units. Anything
 * else substitutes everywhere exactly as before, so `apples = 5` still makes
 * `3 apples` fifteen.
 */
function applyAliases(
  expr: string,
  aliases: Map<string, string>,
  isUnit: (word: string) => boolean,
): string {
  if (aliases.size === 0) return expr;
  const names = [...aliases.keys()].sort((a, b) => b.length - a.length);
  let out = expr;
  for (const name of names) {
    const alias = aliases.get(name)!;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const pattern = new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'gi');
    // Tested against the text as actually written, not the lowercased key the
    // alias is stored under: `W` is watt where `w` is nothing, so a variable
    // named `w` still substitutes while the unit `W` is protected.
    out = out.replace(pattern, (match: string, offset: number, whole: string) =>
      isUnit(match) && /\d\s*$/.test(whole.slice(0, offset)) ? match : alias,
    );
  }
  return out;
}

function isKnownUnit(ctx: MathContext, word: string): boolean {
  const Unit = (ctx.math as unknown as {
    Unit?: { isValuelessUnit?(name: string): boolean };
  }).Unit;
  try {
    return Unit?.isValuelessUnit?.(word) ?? false;
  } catch {
    return false;
  }
}

/** Only numbers and units take part in totals; dates and text do not. */
function isAddable(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (value instanceof Labelled) return Number.isFinite(value.value);
  if (
    value instanceof CalendarDate ||
    value instanceof Timespan ||
    value instanceof Timecode ||
    value instanceof FrameCount ||
    value instanceof TemporalNumber
  ) {
    return false;
  }
  return (
    typeof value === 'object' &&
    value !== null &&
    'units' in value &&
    typeof (value as { formatUnits?: unknown }).formatUnits === 'function'
  );
}

/**
 * Whether a failed line is worth flagging.
 *
 * Prose lines fail constantly ("call the bank on Tuesday") and showing an error
 * beside each one would make a sheet unusable, so a line must both contain a
 * number and look like arithmetic before its failure is surfaced.
 */
function looksComputational(body: string): boolean {
  if (!/\d/.test(body)) return false;
  return /[+\-*/^()%]|\b(?:to|in|of|off|per|mod)\b/.test(body);
}
