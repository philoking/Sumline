import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Store } from './db.js';

export interface RateTable {
  base: string;
  date: string;
  rates: Record<string, number>;
  /** True when these are cached or bundled rather than freshly fetched. */
  stale?: boolean;
}

export const DEFAULT_BASE = 'USD';
const SOURCE_URL = 'https://api.frankfurter.dev/v1/latest';
const HISTORY_URL = 'https://api.frankfurter.dev/v1';

/** A date the provider can be asked about: `YYYY-MM-DD`, and a real one. */
export function isUsableDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    // The ECB series starts in 1999; anything earlier is a typo, not a query.
    year >= 1999
  );
}

/**
 * Rates bundled with the image so a container with no outbound network still
 * starts and does currency maths, rather than failing or silently dropping
 * every currency unit.
 */
export const SEED_RATES: RateTable = JSON.parse(
  readFileSync(fileURLToPath(new URL('./seed-rates.json', import.meta.url)), 'utf8'),
) as RateTable;

/**
 * Fetches a rate table. `onDate` asks for a past date rather than the latest.
 *
 * One function for both, because the provider's two endpoints differ only in
 * their path and return the same shape.
 */
export type RateFetcher = (base: string, onDate?: string) => Promise<RateTable>;

export async function fetchFromFrankfurter(
  base: string,
  onDate?: string,
): Promise<RateTable> {
  const url = onDate
    ? `${HISTORY_URL}/${onDate}?base=${encodeURIComponent(base)}`
    : `${SOURCE_URL}?base=${encodeURIComponent(base)}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Rate provider returned ${response.status}`);
  }
  const body = (await response.json()) as Partial<RateTable>;
  if (!body.rates || typeof body.rates !== 'object' || !body.date) {
    throw new Error('Rate provider returned an unexpected payload');
  }
  // `date` is the provider's, not the one asked for: a weekend or a holiday
  // answers with the last published day before it. Keeping its answer rather
  // than the request is what lets a sheet show which day a rate came from.
  return { base, date: body.date, rates: body.rates };
}

export interface RatesServiceOptions {
  store: Store;
  fetcher?: RateFetcher;
  base?: string;
  refreshIntervalMs?: number;
  log?: { info(msg: string): void; warn(msg: string): void };
}

/**
 * Owns the rate cache and its refresh timer.
 *
 * `current()` never throws and never returns nothing: it falls back from live
 * data, to the last cached table, to the bundled seed.
 */
export class RatesService {
  private table: RateTable;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: RatesServiceOptions) {
    const base = options.base ?? DEFAULT_BASE;
    const cached = options.store.getRates(base);
    this.table = cached
      ? { ...(cached.payload as RateTable), stale: true }
      : SEED_RATES;
  }

  current(): RateTable {
    return this.table;
  }

  async refresh(): Promise<RateTable> {
    const base = this.options.base ?? DEFAULT_BASE;
    const fetcher = this.options.fetcher ?? fetchFromFrankfurter;
    try {
      const fresh = await fetcher(base);
      this.options.store.saveRates(base, fresh);
      this.table = fresh;
      this.options.log?.info(`Exchange rates updated (${fresh.date})`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.log?.warn(
        `Could not refresh exchange rates (${reason}); using rates from ${this.table.date}`,
      );
      this.table = { ...this.table, stale: true };
    }
    return this.table;
  }

  /**
   * Rates on a past date, or null if they cannot be had.
   *
   * Null rather than a fallback to today's snapshot, deliberately: converting a
   * 2019 invoice at this morning's rate and saying nothing is the exact failure
   * this exists to remove, so a date that cannot be answered is reported as
   * unanswerable and the sheet says so on the line.
   *
   * A published past rate never changes, so a hit here is permanent — which also
   * means a date already asked about keeps working with no network at all.
   */
  async historical(onDate: string): Promise<RateTable | null> {
    const base = this.options.base ?? DEFAULT_BASE;
    if (!isUsableDate(onDate)) return null;

    const cached = this.options.store.getHistoricalRates(onDate, base);
    if (cached) return cached as RateTable;

    const fetcher = this.options.fetcher ?? fetchFromFrankfurter;
    try {
      const table = await fetcher(base, onDate);
      this.options.store.saveHistoricalRates(onDate, base, table);
      return table;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.log?.warn(`No exchange rates for ${onDate} (${reason})`);
      return null;
    }
  }

  /** Refreshes now, then on an interval. Failures never stop the timer. */
  start(): void {
    void this.refresh();
    const interval = this.options.refreshIntervalMs ?? 12 * 60 * 60 * 1000;
    this.timer = setInterval(() => void this.refresh(), interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
