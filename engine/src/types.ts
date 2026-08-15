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
  /** Overrides "now" so date math is testable. */
  now?: Date;
}

export interface Engine {
  evaluate(source: string | string[]): LineResult[];
  /**
   * The running total of every value line in a sheet, formatted for display.
   * Directive lines are excluded so a `sum` in the sheet is not counted twice.
   * Empty when there is nothing to add up.
   */
  total(results: LineResult[]): string;
  /** ISO codes this engine knows how to convert between. */
  currencies: string[];
  rateDate: string | null;
}
