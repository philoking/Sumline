import { classify, type Classified } from './classify.js';
import {
  CalendarDate,
  FrameCount,
  TemporalNumber,
  Timecode,
  Timespan,
} from './temporal/types.js';
import { evaluateTemporal, looksTemporal } from './temporal/evaluate.js';
import { formatValue, type FormatContext } from './format.js';
import { createMathContext, type MathContext } from './mathInstance.js';
import { preprocess } from './preprocess.js';
import type { Engine, EngineOptions, LineResult } from './types.js';

export function createEngine(options: EngineOptions = {}): Engine {
  const ctx = createMathContext(
    options.rates,
    new Set(options.holidays ?? []),
    options.fps ?? 24,
  );
  const currencies = [...ctx.currencies].sort();
  const base: FormatContext = {
    currencies: ctx.currencies,
    now: options.now ?? new Date(),
    region: options.region ?? 'north-america',
    largeNumberNotation: options.largeNumberNotation ?? true,
  };

  return {
    currencies,
    rateDate: options.rates?.date ?? null,
    evaluate(source) {
      const lines = Array.isArray(source) ? source : source.split('\n');
      return evaluateLines(lines, ctx, options.now ?? new Date(), base);
    },
    total(results) {
      const values = results
        .filter((r) => r.kind === 'expression' || r.kind === 'assignment')
        .map((r) => r.value)
        .filter(isAddable);
      if (values.length === 0) return '';
      const sum = addAll(ctx, values);
      return sum === undefined ? '' : formatValue(sum, base);
    },
  };
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

/** Mutable state threaded down the sheet as each line is evaluated. */
interface SheetState {
  scope: Record<string, unknown>;
  /** Original variable name (lowercased) -> safe math.js identifier. */
  aliases: Map<string, string>;
  /** Values in the current section, for `sum` / `average`. */
  section: unknown[];
  /** Values by tag, for `sum #food`. */
  tagged: Map<string, unknown[]>;
}

function evaluateLines(
  lines: string[],
  ctx: MathContext,
  now: Date,
  fmt: FormatContext,
): LineResult[] {
  const state: SheetState = {
    scope: {},
    aliases: new Map(),
    section: [],
    tagged: new Map(),
  };
  const results: LineResult[] = [];

  for (const [index, raw] of lines.entries()) {
    const line = classify(raw ?? '');
    const result = evaluateLine(line, index, state, ctx, now, fmt);
    results.push(result);

    // Expose the answer to later lines as `line N` and `prev`.
    if (result.value !== undefined) {
      state.scope[`__line${index + 1}`] = result.value;
      state.scope['__prev'] = result.value;
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

  return results;
}

function evaluateLine(
  line: Classified,
  index: number,
  state: SheetState,
  ctx: MathContext,
  now: Date,
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
      const computed = compute(line.body, state, ctx, now, fmt);
      if (computed.error) {
        return looksComputational(line.body)
          ? { ...base, error: computed.error }
          : base;
      }
      if (computed.value === undefined) return base;

      if (line.kind === 'assignment' && line.name) {
        state.scope[aliasFor(line.name, state)] = computed.value;
        base.name = line.name;
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

function compute(
  body: string,
  state: SheetState,
  ctx: MathContext,
  now: Date,
  fmt: FormatContext,
): Computed {
  if (body.trim() === '') return { output: '' };

  // Dates, times and durations never reach math.js; the gate keeps ordinary
  // arithmetic out of this branch.
  if (looksTemporal(body)) {
    const temporal = evaluateTemporal(body, {
      now,
      holidays: ctx.holidays,
      fps: ctx.fps,
    });
    if (temporal !== null && temporal !== undefined) {
      return { value: temporal, output: formatValue(temporal, fmt) };
    }
  }

  const { expr, hint, decimals } = preprocess(body, {
    currencies: ctx.currencies,
    isKnownUnit: (word) => isKnownUnit(ctx, word),
    scopeNames: new Set(state.aliases.keys()),
    region: fmt.region,
  });

  const resolved = applyAliases(expr, state.aliases);
  const format = (value: unknown): Computed => ({
    value,
    output: formatValue(value, {
      ...fmt,
      ...(hint && { hint }),
      ...(decimals !== undefined && { decimals }),
    }),
  });

  try {
    const value = ctx.math.evaluate(resolved, state.scope);
    if (value === undefined || typeof value === 'function') return { output: '' };
    return format(value);
  } catch (error) {
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
    return { output: '', error: cleanError(error) };
  }
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

  let total = addAll(ctx, values);
  if (total === undefined) {
    return { error: 'These values cannot be added together' };
  }
  if (line.directive === 'average') {
    try {
      total = ctx.math.divide(total as never, values.length as never);
    } catch (error) {
      return { error: cleanError(error) };
    }
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

/** Substitutes known variable names, longest first so prefixes do not win. */
function applyAliases(expr: string, aliases: Map<string, string>): string {
  if (aliases.size === 0) return expr;
  const names = [...aliases.keys()].sort((a, b) => b.length - a.length);
  let out = expr;
  for (const name of names) {
    const pattern = new RegExp(
      `(?<![\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![\\w])`,
      'gi',
    );
    out = out.replace(pattern, aliases.get(name)!);
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

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^Error:\s*/, '')
    .replace(/\s*\(char \d+\)$/, '')
    .replace(/__v\d+/g, 'value')
    .replace(/__line(\d+)/g, 'line $1')
    .replace(/__prev/g, 'prev');
}
