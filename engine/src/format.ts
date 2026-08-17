import { CODE_TO_SYMBOL, ZERO_DECIMAL_CURRENCIES } from './currencies.js';
import {
  CalendarDate,
  FrameCount,
  TemporalNumber,
  Timecode,
  Timespan,
} from './temporal/types.js';
import {
  formatFrameCount,
  formatMoment,
  formatTimecode,
  formatTimespan,
} from './temporal/format.js';
import {
  REGION_SEPARATORS,
  group,
  join,
  toSiNotation,
  trimZeros,
  type NumberRegion,
  type Separators,
} from './numberFormat.js';
import { Labelled, Multiplier, Percentage, Rate } from './values.js';

export interface FormatContext {
  currencies: Set<string>;
  /** Reference point for relative wording like "Tomorrow at 9:00 am". */
  now: Date;
  region: NumberRegion;
  largeNumberNotation: boolean;
  /** Fixed number of decimal places requested by the line itself. */
  decimals?: number;
  /**
   * How many decimal places an answer may show before it is rounded.
   *
   * A ceiling, not a width: trailing zeros are still trimmed, so `20.50`
   * answers `20.5` at any precision. Soulver calls this Precision and offers
   * 0–5, 10 and 15, with 10 as its default.
   */
  precision: number;
  /** Whether digits are grouped — `1,234` against `1234`. */
  thousandsSeparators: boolean;
  /**
   * Whether money is held to its currency's usual number of decimals.
   *
   * On, `$10.005` shows as `$10.01` and yen never show a fraction. Off, money
   * is formatted like any other number, which is what you want when the
   * rounding is hiding the difference you are looking for.
   */
  currencyRounding: boolean;
  /** Render a bare number as a percentage. */
  hint?: 'percent';
}

/** Soulver's own default, and the one the menu ticks. */
export const DEFAULT_PRECISION = 10;

/**
 * The decimal places offered, exactly as Soulver's Precision submenu lists
 * them. Six is deliberately absent — it is not one of Soulver's choices, which
 * is what settled the default being ten rather than six.
 *
 * Here rather than in the menu that draws it, beside the default it belongs to:
 * these are the values `formatNumber` actually has to answer well at, so they
 * are what its tests sweep. A list the engine cannot see is a list the engine
 * cannot be tested against.
 */
export const PRECISIONS = [0, 1, 2, 3, 4, 5, 10, 15] as const;

/**
 * How many significant digits a double can be trusted for here.
 *
 * The same twelve `toPrecision(12)` already collapses to; past it the bits
 * describe the representation rather than the answer.
 */
const SIGNIFICANT_DIGITS = 12;

export function defaultContext(currencies: Set<string>): FormatContext {
  return {
    currencies,
    now: new Date(),
    region: 'north-america',
    largeNumberNotation: true,
    precision: DEFAULT_PRECISION,
    thousandsSeparators: true,
    currencyRounding: true,
  };
}

/** Renders an evaluated value for the answer column. */
export function formatValue(value: unknown, ctx: FormatContext): string {
  if (value === null || value === undefined) return '';

  if (value instanceof CalendarDate) return formatMoment(value, ctx.now);
  if (value instanceof Timespan) {
    return formatTimespan(value, (n) => formatNumber(n, { ...ctx, largeNumberNotation: false }));
  }
  if (value instanceof Timecode) return formatTimecode(value);
  if (value instanceof TemporalNumber) {
    // Never abbreviated: `1.79G` is not a readable timestamp.
    return formatNumber(value.value, { ...ctx, largeNumberNotation: false });
  }
  if (value instanceof FrameCount) {
    return formatFrameCount(value, (n) => formatNumber(n, ctx));
  }
  if (value instanceof Percentage) return `${formatNumber(value.ratio * 100, ctx)}%`;
  if (value instanceof Multiplier) return `${formatNumber(value.factor, ctx)}x`;
  if (value instanceof Rate) return `${formatValue(value.amount, ctx)}/${value.per}`;
  // The label is echoed exactly as it was written, so the answer reads back
  // the way the line does.
  if (value instanceof Labelled) {
    return `${formatNumber(value.value, ctx)} ${value.label}`;
  }

  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return ctx.hint === 'percent'
      ? `${formatNumber(value, ctx)}%`
      : formatNumber(value, ctx);
  }

  if (isFraction(value)) return formatFraction(value);
  if (isUnit(value)) return formatUnit(value, ctx);
  if (Array.isArray(value)) {
    return `[${value.map((v) => formatValue(v, ctx)).join(', ')}]`;
  }

  const asString = String(value);
  return asString === '[object Object]' ? '' : asString;
}

interface MathUnit {
  toNumeric(valuelessUnit?: string): number;
  formatUnits(): string;
  units: Array<{ unit: { name: string }; prefix?: { name: string }; power: number }>;
}

/** math.js v14 stores fraction parts as bigints. */
interface MathFraction {
  s: number | bigint;
  n: number | bigint;
  d: number | bigint;
}

function isUnit(value: unknown): value is MathUnit {
  return (
    typeof value === 'object' &&
    value !== null &&
    'units' in value &&
    typeof (value as MathUnit).formatUnits === 'function'
  );
}

function isFraction(value: unknown): value is MathFraction {
  if (typeof value !== 'object' || value === null) return false;
  if (!('s' in value) || !('n' in value) || !('d' in value)) return false;
  if ('units' in value) return false;
  const d = (value as MathFraction).d;
  return typeof d === 'number' || typeof d === 'bigint';
}

function formatFraction(value: MathFraction): string {
  const sign = Number(value.s) < 0 ? '-' : '';
  const numerator = Number(value.n);
  const denominator = Number(value.d);
  return denominator === 1
    ? `${sign}${numerator}`
    : `${sign}${numerator}/${denominator}`;
}

function formatUnit(unit: MathUnit, ctx: FormatContext): string {
  const label = unit.formatUnits();
  const amount = unit.toNumeric(label);

  const code = currencyCode(unit, ctx.currencies);
  if (code) return formatMoney(amount, code, ctx);

  const rate = rateLabel(unit, ctx);
  if (rate) return rate;

  // math.js spaces compound units as "km / h"; people write "km/h".
  return `${formatNumber(amount, ctx)} ${displayUnits(label)}`;
}

/**
 * Units whose everyday spelling differs from the name math.js answers with.
 *
 * Only temperature needs this today: nobody writes `degC`, and the `celsius`
 * spelling reaches the formatter whenever the line was written that way.
 */
const UNIT_DISPLAY: Record<string, string> = {
  degF: '°F',
  degC: '°C',
  fahrenheit: '°F',
  celsius: '°C',
};

function displayUnits(label: string): string {
  return UNIT_DISPLAY[label] ?? label.replace(/ \/ /g, '/');
}

/**
 * Renders a rate — a quantity per unit of something.
 *
 * Two shapes need help. A currency numerator should keep its symbol
 * (`$99.00/week`, not `99 USD / week`), and a unitless numerator arrives from
 * math.js as a negative power that would otherwise print as `49.6 uHz`.
 */
function rateLabel(unit: MathUnit, ctx: FormatContext): string | null {
  const label = unit.formatUnits();
  const amount = unit.toNumeric(label);

  const inverseOnly = /^([A-Za-z]+)\^-1$/.exec(label);
  if (inverseOnly) {
    return `${formatNumber(amount, ctx)}/${inverseOnly[1]}`;
  }

  const parts = /^([A-Za-z]+) \/ ([A-Za-z]+)$/.exec(label);
  if (parts && ctx.currencies.has(parts[1]!)) {
    return `${formatMoney(amount, parts[1]!, ctx)}/${parts[2]}`;
  }

  return null;
}

/** The ISO code, when the unit is a plain single-currency amount. */
function currencyCode(unit: MathUnit, currencies: Set<string>): string | null {
  if (unit.units.length !== 1) return null;
  const entry = unit.units[0];
  const name = entry?.unit.name;
  if (!name || !currencies.has(name) || entry?.power !== 1) return null;
  return entry?.prefix?.name ? null : name;
}

export function formatMoney(
  amount: number,
  code: string,
  ctx: FormatContext,
): string {
  const grouping = groupingFor(ctx);
  const symbol = CODE_TO_SYMBOL[code];
  const money = (body: string, negative: boolean) => {
    const sign = negative ? '-' : '';
    return symbol ? `${sign}${symbol}${body}` : `${sign}${body} ${code}`;
  };

  /*
   * With rounding off, money is formatted like any other number — held to the
   * general precision and trimmed. A line asked for a fixed number of places
   * still gets them: `to 2 dp` is written into the sheet and outranks a
   * preference set in a menu.
   */
  if (!ctx.currencyRounding && ctx.decimals === undefined) {
    return money(formatNumber(Math.abs(amount), ctx), amount < 0);
  }

  const decimals = ctx.decimals ?? (ZERO_DECIMAL_CURRENCIES.has(code) ? 0 : 2);
  const rounded = round(amount, decimals);
  const [whole = '0', fraction] = Math.abs(rounded).toFixed(decimals).split('.');
  return money(join(group(whole, grouping), fraction, grouping), rounded < 0);
}

/**
 * Formats a plain number the way a calculator should: grouped digits, no
 * trailing zero noise, and float artefacts rounded away before display.
 */
export function formatNumber(value: number, ctx: FormatContext): string {
  if (!Number.isFinite(value)) return String(value);
  const grouping = groupingFor(ctx);

  if (ctx.decimals !== undefined) {
    const fixed = round(value, ctx.decimals).toFixed(ctx.decimals);
    const [whole = '0', fraction] = fixed.replace('-', '').split('.');
    const sign = value < 0 && round(value, ctx.decimals) !== 0 ? '-' : '';
    return `${sign}${join(group(whole, grouping), fraction, grouping)}`;
  }

  if (value === 0) return '0';

  const magnitude = Math.abs(value);
  if (magnitude >= 1e15 || magnitude < 1e-6) {
    return trimExponential(value.toExponential(6));
  }

  if (ctx.largeNumberNotation) {
    const si = toSiNotation(Number(value.toPrecision(12)));
    if (si) return si;
  }

  // 12 significant digits keeps real precision while collapsing 0.1 + 0.2
  // into 0.3 rather than 0.30000000000000004.
  const clean = Number(value.toPrecision(12));
  /*
   * The requested precision, capped by the significant digits actually left.
   *
   * Asking for ten decimals of 1,234,567.89 is asking for seventeen
   * significant figures, which a double does not have: `toFixed(10)` answers
   * 1,234,567.8899999999, faithfully printing the noise below the twelve
   * digits promised a line above. Spending the budget on the integer part
   * first is what keeps a large number honest and a small one precise.
   *
   * `toFixed` also does the rounding, rather than `round` — that multiplies by
   * 10^places, which passes 2^53 and loses the low digits at this magnitude.
   */
  const magnitudeDigits = Math.abs(clean) >= 1 ? Math.floor(Math.log10(Math.abs(clean))) + 1 : 1;
  const places = Math.min(ctx.precision, Math.max(0, SIGNIFICANT_DIGITS - magnitudeDigits));
  const fixed = trimZeros(clean.toFixed(places));
  const [whole = '0', fraction] = fixed.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const grouped = group(whole.replace('-', ''), grouping);
  return `${sign}${join(grouped, fraction, grouping)}`;
}

/**
 * The region's separators, with grouping turned off if that is the preference.
 *
 * Emptying the group character rather than branching at every call site: the
 * decimal point still has to be the region's own, and only one of the two is
 * being switched off.
 */
function groupingFor(ctx: FormatContext): Separators {
  const separators = REGION_SEPARATORS[ctx.region];
  return ctx.thousandsSeparators ? separators : { ...separators, group: '' };
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON * Math.sign(value)) * factor) / factor;
}

function trimExponential(text: string): string {
  return text.replace(/\.?0+e/, 'e').replace('e+', 'e');
}
