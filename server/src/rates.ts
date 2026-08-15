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

/**
 * Rates bundled with the image so a container with no outbound network still
 * starts and does currency maths, rather than failing or silently dropping
 * every currency unit.
 */
export const SEED_RATES: RateTable = JSON.parse(
  readFileSync(fileURLToPath(new URL('./seed-rates.json', import.meta.url)), 'utf8'),
) as RateTable;

export type RateFetcher = (base: string) => Promise<RateTable>;

export async function fetchFromFrankfurter(base: string): Promise<RateTable> {
  const response = await fetch(`${SOURCE_URL}?base=${encodeURIComponent(base)}`, {
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
