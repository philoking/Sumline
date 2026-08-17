import {
  create,
  all,
  type FactoryFunctionMap,
  type MathJsInstance,
} from 'mathjs';
import { RESERVED_CODES } from './currencies.js';
import type { HistoricalRates } from './historical.js';
import { registerValueTypes } from './values.js';
import type { RateTable } from './types.js';

export interface MathContext {
  math: MathJsInstance;
  /** ISO codes registered as units on this instance. */
  currencies: Set<string>;
  /** Public holidays as `YYYY-MM-DD`, excluded from workday calculations. */
  holidays: ReadonlySet<string>;
  /** Default frame rate for timecodes that do not name one. */
  fps: number;
  /**
   * Past rate tables by ISO date.
   *
   * Reference data the evaluator consults, like `holidays` — not something
   * math.js knows about. Registering a unit set per date would mean a math.js
   * instance per date; see [`historical.ts`](./historical.ts).
   */
  historicalRates: HistoricalRates;
}

/**
 * Builds a math.js instance with one unit per currency in the rate table.
 *
 * Currencies are registered relative to the table's base, which lets math.js's
 * own unit system handle conversion, mixed-currency arithmetic and summing for
 * free. The instance is disposable: refreshing rates means building a new one,
 * which keeps the engine free of mutable global state.
 */
export function createMathContext(
  rates?: RateTable,
  holidays: ReadonlySet<string> = new Set(),
  fps = 24,
  historicalRates: HistoricalRates = {},
): MathContext {
  // `all` is typed as optionally undefined by mathjs, but is always populated.
  const math = create(all as FactoryFunctionMap, {
    number: 'number',
  }) as MathJsInstance;
  const currencies = new Set<string>();

  addEverydayUnits(math);
  registerCurrencies(math, currencies, rates);
  // Registered last: the value types read `currencies` to decide which unit a
  // mixed-currency sum answers in, so the set must already be populated.
  registerValueTypes(math, currencies);

  return { math, currencies, holidays, fps, historicalRates };
}

function registerCurrencies(
  math: MathJsInstance,
  currencies: Set<string>,
  rates?: RateTable,
): void {
  if (!rates) return;

  const base = rates.base.toUpperCase();
  if (!register(math, base)) return;
  currencies.add(base);

  for (const [rawCode, perBase] of Object.entries(rates.rates)) {
    const code = rawCode.toUpperCase();
    if (code === base || !Number.isFinite(perBase) || perBase <= 0) continue;
    // rates are "X per one base", so one X is worth 1/rate of the base
    if (register(math, code, `${1 / perBase} ${base}`)) currencies.add(code);
  }
}

/**
 * Units people write in notes that math.js does not ship with.
 *
 * Each is a plain alias for a composite it already understands, so conversions
 * and arithmetic behave exactly as if the user had spelled it out.
 */
const EVERYDAY_UNITS: Array<[string, string]> = [
  ['mph', '1 mi/h'],
  ['kph', '1 km/h'],
  ['kmh', '1 km/h'],
  ['fps', '1 ft/s'],
  ['sqft', '1 ft^2'],
  ['sqm', '1 m^2'],
  ['kcal', '1000 cal'],
  ['rpm', '1 / min'],

  /*
   * Bit rates. math.js ships bits and bytes but no per-second aliases, so
   * `940 Mbps` was an undefined symbol. Both cases of each are registered
   * because people type `mbps` as readily as `Mbps`, and the SI reading of a
   * lowercase `m` — millibits per second — is not something anyone means.
   * Byte rates need nothing: `MB/s` already parses as a rate.
   */
  ['bps', '1 b/s'],
  ['kbps', '1 kb/s'], ['Kbps', '1 kb/s'],
  ['mbps', '1 Mb/s'], ['Mbps', '1 Mb/s'],
  ['gbps', '1 Gb/s'], ['Gbps', '1 Gb/s'],
  ['tbps', '1 Tb/s'], ['Tbps', '1 Tb/s'],
  ['Pbps', '1 Pb/s'],
  ['Ebps', '1 Eb/s'],
];

function addEverydayUnits(math: MathJsInstance): void {
  for (const [name, definition] of EVERYDAY_UNITS) {
    try {
      math.createUnit(name, { definition });
    } catch {
      // Already known to this build of math.js; its definition wins.
    }
  }
}

/**
 * Registers a single currency unit, returning false if the code is unusable.
 *
 * Some ISO codes collide with built-in math.js units; rather than override
 * physical units (and quietly break `5 cd` or similar), we skip the currency.
 */
function register(
  math: MathJsInstance,
  code: string,
  definition?: string,
): boolean {
  if (!/^[A-Z]{3}$/.test(code) || RESERVED_CODES.has(code)) return false;
  try {
    math.createUnit(code, definition ? { definition } : {});
    return true;
  } catch {
    return false;
  }
}
