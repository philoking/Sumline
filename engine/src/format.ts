import { CODE_TO_SYMBOL, ZERO_DECIMAL_CURRENCIES } from './currencies.js';
import { CalendarDate, Duration } from './dates.js';

export interface FormatContext {
  currencies: Set<string>;
  hint?: 'percent';
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Renders an evaluated value for the answer column. */
export function formatValue(value: unknown, ctx: FormatContext): string {
  if (value === null || value === undefined) return '';

  if (value instanceof CalendarDate) return formatDate(value);
  if (value instanceof Duration) return formatDuration(value);

  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return ctx.hint === 'percent'
      ? `${formatNumber(value)}%`
      : formatNumber(value);
  }

  if (isUnit(value)) return formatUnit(value, ctx);
  if (Array.isArray(value)) {
    return `[${value.map((v) => formatValue(v, ctx)).join(', ')}]`;
  }

  // math.js matrices, complex numbers, fractions and anything else with a
  // reasonable toString of its own.
  const asString = String(value);
  return asString === '[object Object]' ? '' : asString;
}

interface MathUnit {
  toNumeric(valuelessUnit?: string): number;
  formatUnits(): string;
  units: Array<{ unit: { name: string }; prefix?: { name: string } }>;
}

function isUnit(value: unknown): value is MathUnit {
  return (
    typeof value === 'object' &&
    value !== null &&
    'units' in value &&
    typeof (value as MathUnit).formatUnits === 'function'
  );
}

function formatUnit(unit: MathUnit, ctx: FormatContext): string {
  const label = unit.formatUnits();
  const amount = unit.toNumeric(label);

  const code = currencyCode(unit, ctx.currencies);
  if (code) return formatMoney(amount, code);

  // math.js spaces compound units as "km / h"; people write "km/h".
  return `${formatNumber(amount)} ${label.replace(/ \/ /g, '/')}`;
}

/** The ISO code, when the unit is a plain single-currency amount. */
function currencyCode(unit: MathUnit, currencies: Set<string>): string | null {
  if (unit.units.length !== 1) return null;
  const name = unit.units[0]?.unit.name;
  if (!name || !currencies.has(name)) return null;
  // A prefixed currency ("kUSD") is not money in the everyday sense; render it
  // through the generic unit path instead of inventing "$k".
  const prefix = unit.units[0]?.prefix?.name;
  return prefix ? null : name;
}

export function formatMoney(amount: number, code: string): string {
  const decimals = ZERO_DECIMAL_CURRENCIES.has(code) ? 0 : 2;
  const rounded = round(amount, decimals);
  const body = group(Math.abs(rounded).toFixed(decimals));
  const sign = rounded < 0 ? '-' : '';
  const symbol = CODE_TO_SYMBOL[code];
  return symbol ? `${sign}${symbol}${body}` : `${sign}${body} ${code}`;
}

/**
 * Formats a plain number the way a calculator should: grouped thousands, no
 * trailing zero noise, and float artefacts rounded away before display.
 */
export function formatNumber(value: number): string {
  if (value === 0) return '0';
  if (!Number.isFinite(value)) return String(value);

  const magnitude = Math.abs(value);
  if (magnitude >= 1e15 || magnitude < 1e-6) {
    return trimExponential(value.toExponential(6));
  }

  // 12 significant digits is enough to keep real precision while collapsing
  // 0.1 + 0.2 into 0.3 rather than 0.30000000000000004.
  const clean = Number(value.toPrecision(12));
  const fixed = round(clean, 6).toFixed(6).replace(/\.?0+$/, '');
  const [whole = '0', fraction] = fixed.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const grouped = group(whole.replace('-', ''));
  return fraction ? `${sign}${grouped}.${fraction}` : `${sign}${grouped}`;
}

function formatDate(value: CalendarDate): string {
  const d = value.date;
  return `${WEEKDAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

function formatDuration(value: Duration): string {
  const amount = formatNumber(round(value.amount, 2));
  const plural = Math.abs(value.amount) === 1 ? value.unit : `${value.unit}s`;
  return `${amount} ${plural}`;
}

/** Inserts thousands separators into an unsigned integer string. */
function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON * Math.sign(value)) * factor) / factor;
}

function trimExponential(text: string): string {
  return text.replace(/\.?0+e/, 'e').replace('e+', 'e');
}
