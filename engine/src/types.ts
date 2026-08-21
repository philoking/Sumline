import type { HistoricalRates } from './historical.js';
import type { NumberRegion } from './numberFormat.js';
import type { Token } from './tokenize.js';

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
  'blank' | 'comment' | 'heading' | 'assignment' | 'directive' | 'expression';

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
  /**
   * True when a later line read this one's value, through `line N` or `prev`.
   *
   * Recorded during evaluation rather than worked out afterwards, because
   * `prev` means "the last line that produced a value", which is only knowable
   * from where the sheet had got to at the time.
   */
  referenced?: boolean;
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
  /**
   * How many decimal places an answer may show. Defaults to 10, as Soulver's
   * Precision does. A ceiling rather than a width: trailing zeros are trimmed,
   * so `20.50` still answers `20.5`.
   */
  precision?: number;
  /** Group digits as `1,234`. On by default. */
  thousandsSeparators?: boolean;
  /**
   * Hold money to its currency's usual decimals — `$10.01`, and no fraction on
   * yen. On by default. Off formats money like any other number.
   */
  currencyRounding?: boolean;
  /** Public holidays as `YYYY-MM-DD`, excluded from workday calculations. */
  holidays?: readonly string[];
  /** Default frame rate for timecodes that do not name one. */
  fps?: number;
  /**
   * The zone this sheet's dates resolve in — an IANA name, or any place name
   * the expression language understands.
   *
   * Omitted means the reader's own, which is the default and usually right:
   * evaluation runs in the browser, so `today` is the reader's today. Set it
   * when a sheet should resolve somewhere in particular no matter who opens it.
   */
  zone?: string;
  /**
   * Variables available to every sheet, as `name` to expression. Evaluated
   * before the sheet itself, so a sheet can use or shadow them.
   */
  globals?: Readonly<Record<string, string>>;
}

/** Which figure the sheet-level summary reports. */
export type Statistic = 'total' | 'average' | 'count' | 'median';

export interface SummaryOptions {
  /**
   * Whether `monthly rent = 1500` lines feed the figure.
   *
   * True by default, which is what the corner has always done. A sheet that
   * declares a few variables and then works with them counts the declarations
   * as well as the results, so the total reads high by exactly the sum of the
   * things it was built from — while a sheet that *is* a list of named amounts
   * needs them counted. Only the writer knows which kind of sheet it is, which
   * is why this is a setting rather than a rule.
   */
  countVariables?: boolean;
  /**
   * Whether a line another line later reads feeds the figure.
   *
   * True by default, matching Soulver, whose View → Total Options ships this
   * ticked. Turned off, `10 / 20 / prev + 5` totals 35 rather than 55: the 20
   * counts once inside the 25 instead of once on its own and once again there.
   * Which of those is wanted depends on whether the sheet is a list of amounts
   * or a calculation shown in steps, so like `countVariables` it is a setting
   * rather than a rule.
   */
  countReferenced?: boolean;
}

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
  summary(results: LineResult[], statistic: Statistic, options?: SummaryOptions): string;
  /**
   * Where every token on each line of a sheet is, and what this engine reads
   * it as — one array of tokens per line, offset from that line's own start.
   *
   * Reported by the engine for the same reason `ratesNeeded` is: recognising a
   * token means reading the line the way evaluation reads it, and a second
   * implementation in the host would eventually disagree. A highlighter that
   * disagreed would be worse than none, because the colour is the only warning
   * that `hours` has stopped meaning hours.
   *
   * Purely a reading of the text — nothing is evaluated, so this costs a pass
   * over the source and is safe to call on every keystroke.
   */
  tokenize(source: string | string[]): Token[][];
  /** ISO codes this engine knows how to convert between. */
  currencies: string[];
  rateDate: string | null;
}
