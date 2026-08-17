import type { HistoricalRates } from './historical.js';
import type { NumberRegion } from './numberFormat.js';

export type { NumberRegion };
export type { HistoricalRates };

/** A snapshot of exchange rates, expressed as "how many X per one `base`". */
export interface RateTable {
  base: string;
  /** ISO date the rates were published, e.g. "2026-08-14". */
  date: string;
  rates: Record<string, number>;
  /** True when these are the bundled fallback rates rather than a live fetch. */
  stale?: boolean;
}

export type LineKind =
  | 'blank'
  | 'comment'
  | 'heading'
  | 'assignment'
  | 'directive'
  | 'expression';

export interface LineResult {
  index: number;
  kind: LineKind;
  /** Formatted answer for the answer column. Empty when the line has no answer. */
  output: string;
  /** Present when the line produced a value that later lines can reference. */
  value?: unknown;
  /** Human-readable problem with this line. Never throws; errors are per-line. */
  error?: string;
  /** Variable name, for assignment lines. */
  name?: string;
  /** Tags (`#food`) found on the line. */
  tags?: string[];
}

export interface EngineOptions {
  rates?: RateTable;
  /**
   * Past rate tables by ISO date, for `100 USD in EUR on 2020-01-01`.
   *
   * Supplied by the host rather than fetched here, because evaluation is
   * synchronous and fetching is not. `ratesNeeded` reports which dates a sheet
   * is asking about so the host knows what to go and get.
   */
  historicalRates?: HistoricalRates;
  /** Overrides "now" so date math is testable. */
  now?: Date;
  /** Which convention number literals follow. Defaults to North America. */
  region?: NumberRegion;
  /**
   * Abbreviate large plain numbers as 300k / 3.3M. On by default, matching
   * Soulver. Never applied to currency amounts.
   */
  largeNumberNotation?: boolean;
  /** Public holidays as `YYYY-MM-DD`, excluded from workday calculations. */
  holidays?: readonly string[];
  /** Default frame rate for timecodes that do not name one. */
  fps?: number;
  /**
   * Variables available to every sheet, as `name` to expression. Evaluated
   * before the sheet itself, so a sheet can use or shadow them.
   */
  globals?: Readonly<Record<string, string>>;
}

/** Which figure the sheet-level summary reports. */
export type Statistic = 'total' | 'average' | 'count' | 'median';

export interface Engine {
  evaluate(source: string | string[]): LineResult[];
  /**
   * The ISO dates this sheet asks for past exchange rates on.
   *
   * The host fetches these and passes them back as `historicalRates`; until it
   * does, those lines answer nothing rather than erroring. Reported by the
   * engine because recognising the request means parsing the line, and a second
   * implementation in the host would disagree about what counts as one.
   */
  ratesNeeded(source: string | string[]): string[];
  /**
   * The running total of every value line in a sheet, formatted for display.
   * Directive lines are excluded so a `sum` in the sheet is not counted twice.
   * Empty when there is nothing to add up.
   */
  total(results: LineResult[]): string;
  /**
   * The sheet-level figure, as total, average, count or median. `total` is
   * the same calculation `total()` performs.
   */
  summary(results: LineResult[], statistic: Statistic): string;
  /** ISO codes this engine knows how to convert between. */
  currencies: string[];
  rateDate: string | null;
}
