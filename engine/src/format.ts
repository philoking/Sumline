import { CODE_TO_SYMBOL, ZERO_DECIMAL_CURRENCIES } from './currencies.js';
import { CalendarDate, Duration } from './dates.js';
import {
  REGION_SEPARATORS,
  group,
  join,
  toSiNotation,
  type NumberRegion,
  type Separators,
} from './numberFormat.js';
import { Multiplier, Percentage, Rate } from './values.js';

export interface FormatContext {
  currencies: Set<string>;
  region: NumberRegion;
  largeNumberNotation: boolean;
  /** Fixed number of decimal places requested by the line itself. */
  decimals?: number;
  /** Render a bare number as a percentage. */
  hint?: 'percent';
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function defaultContext(currencies: Set<string>): FormatContext {
  return { currencies, region: 'north-america', largeNumberNotation: true };
}

/** Renders an evaluated value for the answer column. */
export function formatValue(value: unknown, ctx: FormatContext): string {
  if (value === null || value === undefined) return '';

  if (value instanceof CalendarDate) return formatDate(value);
  if (value instanceof Duration) return formatDuration(value, ctx);
  if (value instanceof Percentage) return `${formatNumber(value.ratio * 100, ctx)}%`;
  if (value instanceof Multiplier) return `${formatNumber(value.factor, ctx)}x`;
  if (value instanceof Rate) return `${formatValue(value.amount, ctx)}/${value.per}`;

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
  return `${formatNumber(amount, ctx)} ${label.replace(/ \/ /g, '/')}`;
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
  const decimals = ctx.decimals ?? (ZERO_DECIMAL_CURRENCIES.has(code) ? 0 : 2);
  const separators = REGION_SEPARATORS[ctx.region];
  const rounded = round(amount, decimals);
  const [whole = '0', fraction] = Math.abs(rounded).toFixed(decimals).split('.');
  const body = join(group(whole, separators), fraction, separators);
  const sign = rounded < 0 ? '-' : '';
  const symbol = CODE_TO_SYMBOL[code];
  return symbol ? `${sign}${symbol}${body}` : `${sign}${body} ${code}`;
}

/**
 * Formats a plain number the way a calculator should: grouped digits, no
 * trailing zero noise, and float artefacts rounded away before display.
 */
export function formatNumber(value: number, ctx: FormatContext): string {
  if (!Number.isFinite(value)) return String(value);
  const separators = REGION_SEPARATORS[ctx.region];

  if (ctx.decimals !== undefined) {
    const fixed = round(value, ctx.decimals).toFixed(ctx.decimals);
    const [whole = '0', fraction] = fixed.replace('-', '').split('.');
    const sign = value < 0 && round(value, ctx.decimals) !== 0 ? '-' : '';
    return `${sign}${join(group(whole, separators), fraction, separators)}`;
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
  const fixed = round(clean, 6).toFixed(6).replace(/\.?0+$/, '');
  const [whole = '0', fraction] = fixed.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const grouped = group(whole.replace('-', ''), separators);
  return `${sign}${join(grouped, fraction, separators)}`;
}

function formatDate(value: CalendarDate): string {
  const d = value.date;
  return `${WEEKDAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

function formatDuration(value: Duration, ctx: FormatContext): string {
  const amount = formatNumber(round(value.amount, 2), {
    ...ctx,
    largeNumberNotation: false,
  });
  const plural = Math.abs(value.amount) === 1 ? value.unit : `${value.unit}s`;
  return `${amount} ${plural}`;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON * Math.sign(value)) * factor) / factor;
}

function trimExponential(text: string): string {
  return text.replace(/\.?0+e/, 'e').replace('e+', 'e');
}
