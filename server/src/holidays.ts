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
  if (!Array.isArray(body)) throw new Error('Holiday provider returned an unexpected payload');
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

export const DEFAULT_COUNTRY = 'US';

/**
 * An ISO 3166-1 alpha-2 code, or null.
 *
 * Shape only. The provider knows which codes it covers and there is no useful
 * list to bundle, so an unrecognised-but-well-formed code is fetched, fails, and
 * falls back — which reports itself in the panel as a country with no holidays
 * rather than as a broken instance.
 */
export function normaliseCountry(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/**
 * Owns the public-holiday cache.
 *
 * Mirrors `RatesService` deliberately: fetch in the background, cache to
 * SQLite, and fall back through cache to a bundled seed so the container still
 * works with no internet access.
 */
export class HolidayService {
  /**
   * One table per country in use, not one per instance.
   *
   * A space can choose its own country, so an instance running Work and a
   * client in Berlin holds both. The store has always been keyed by country;
   * only this service assumed there was a single one.
   */
  private readonly tables = new Map<string, HolidayTable>();
  private readonly fallback: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: HolidayServiceOptions) {
    this.fallback = normaliseCountry(options.country) ?? DEFAULT_COUNTRY;
    this.tables.set(this.fallback, this.load(this.fallback));
  }

  /** The instance default, for a space that has not chosen. */
  current(): HolidayTable {
    return this.tables.get(this.fallback)!;
  }

  /**
   * The table for one country, fetched on first use.
   *
   * Awaited rather than refreshed in the background, because the alternative is
   * handing back the three-date bundled seed and only showing the real calendar
   * after a reload — which reads as a country whose holidays are missing.
   */
  async for(country: unknown): Promise<HolidayTable> {
    const code = normaliseCountry(country) ?? this.fallback;
    const held = this.tables.get(code);
    if (held && !held.stale) return held;

    if (!held) this.tables.set(code, this.load(code));
    return this.refreshCountry(code);
  }

  /** What is known about a country before the network is consulted. */
  private load(country: string): HolidayTable {
    const years = this.years();
    const cached = this.options.store.getHolidays(country);
    return cached
      ? { ...(cached.payload as HolidayTable), stale: true }
      : { country, years, dates: seedHolidays(years), stale: true };
  }

  private years(): number[] {
    const year = (this.options.now?.() ?? new Date()).getFullYear();
    return [year, year + 1];
  }

  /** Refreshes every country this instance has been asked for. */
  async refresh(): Promise<HolidayTable> {
    await Promise.all([...this.tables.keys()].map((code) => this.refreshCountry(code)));
    return this.current();
  }

  private async refreshCountry(country: string): Promise<HolidayTable> {
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
      this.tables.set(country, fresh);
      this.options.log?.info(
        `Public holidays updated (${country}, ${fresh.dates.length} dates)`,
      );
      return fresh;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.log?.warn(
        `Could not refresh public holidays for ${country} (${reason}); using the cached list`,
      );
      const stale = { ...(this.tables.get(country) ?? this.load(country)), stale: true };
      this.tables.set(country, stale);
      return stale;
    }
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
