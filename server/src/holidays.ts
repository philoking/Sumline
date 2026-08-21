import type { Store } from './db.js';

export interface HolidayTable {
  country: string;
  /** Public holidays as `YYYY-MM-DD`. */
  dates: string[];
  /** Years covered by this table. */
  years: number[];
  /** True when these are bundled or cached rather than freshly fetched. */
  stale?: boolean;
}

const SOURCE = 'https://date.nager.at/api/v3/PublicHolidays';

export type HolidayFetcher = (country: string, year: number) => Promise<string[]>;

export async function fetchFromNager(country: string, year: number): Promise<string[]> {
  const response = await fetch(`${SOURCE}/${year}/${encodeURIComponent(country)}`, {
    signal: AbortSignal.timeout(15_000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Holiday provider returned ${response.status}`);
  const body = (await response.json()) as Array<{ date?: string }>;
  if (!Array.isArray(body))
    throw new Error('Holiday provider returned an unexpected payload');
  return body.map((entry) => entry.date).filter((date): date is string => Boolean(date));
}

/**
 * Weekend-independent fallback: the fixed-date holidays almost every country
 * observes. Enough that workday maths stays sane with no network, without
 * pretending to know a country's full calendar.
 */
function seedHolidays(years: number[]): string[] {
  return years.flatMap((year) => [`${year}-01-01`, `${year}-12-25`, `${year}-12-26`]);
}

export interface HolidayServiceOptions {
  store: Store;
  country?: string;
  fetcher?: HolidayFetcher;
  now?: () => Date;
  log?: { info(msg: string): void; warn(msg: string): void };
}

/**
 * Owns the public-holiday cache.
 *
 * Mirrors `RatesService` deliberately: fetch in the background, cache to
 * SQLite, and fall back through cache to a bundled seed so the container still
 * works with no internet access.
 */
export class HolidayService {
  private table: HolidayTable;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: HolidayServiceOptions) {
    const country = options.country ?? 'US';
    const years = this.years();
    const cached = options.store.getHolidays(country);
    this.table = cached
      ? { ...(cached.payload as HolidayTable), stale: true }
      : { country, years, dates: seedHolidays(years), stale: true };
  }

  current(): HolidayTable {
    return this.table;
  }

  private years(): number[] {
    const year = (this.options.now?.() ?? new Date()).getFullYear();
    return [year, year + 1];
  }

  async refresh(): Promise<HolidayTable> {
    const country = this.options.country ?? 'US';
    const fetcher = this.options.fetcher ?? fetchFromNager;
    const years = this.years();

    try {
      const perYear = await Promise.all(years.map((year) => fetcher(country, year)));
      const fresh: HolidayTable = {
        country,
        years,
        dates: [...new Set(perYear.flat())].sort(),
      };
      this.options.store.saveHolidays(country, fresh);
      this.table = fresh;
      this.options.log?.info(
        `Public holidays updated (${country}, ${fresh.dates.length} dates)`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.log?.warn(
        `Could not refresh public holidays (${reason}); using the cached list`,
      );
      this.table = { ...this.table, stale: true };
    }
    return this.table;
  }

  /** Refreshes now, then weekly. Holidays change far more slowly than rates. */
  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 7 * 24 * 60 * 60 * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
