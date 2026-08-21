import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createEngine,
  type EngineOptions,
  type HistoricalRates,
  type LineResult,
  type RateTable,
} from '@sumline/engine';
import { api, type HolidayTable } from './api';

/**
 * The caller's options, plus what this hook fetched for itself.
 *
 * A spread, not a field-by-field copy: the copy is the same mistake
 * `engineOptionsFrom` was written one layer up to prevent, and it had already
 * cost the same thing twice. `zone` was resolved by the server, assembled by
 * the caller, and dropped on this line, so a space that pinned the zone its
 * dates resolve in was quietly ignored for as long as the setting existed;
 * `precision`, `thousandsSeparators` and `currencyRounding` were about to go
 * the same way. A spread cannot forget a key.
 *
 * Lifted out of the `useMemo` that calls it so it can be tested at all. What
 * broke twice was one expression buried in a hook argument, reachable only by
 * rendering — which is exactly why nothing caught it.
 */
export function engineInputs(
  options: EngineOptions,
  rates: RateTable | null,
  holidays: HolidayTable | null,
  history: HistoricalRates,
): EngineOptions {
  return {
    ...options,
    ...(rates && { rates }),
    ...(holidays && { holidays: holidays.dates }),
    historicalRates: history,
  };
}

/**
 * Loads exchange rates once, then builds an engine around them.
 *
 * Evaluation is entirely client-side, so a slow or unreachable API never
 * delays an answer; the engine simply starts without currency support and
 * gains it when the rates arrive.
 */
export function useEngine(options: EngineOptions) {
  const [rates, setRates] = useState<RateTable | null>(null);
  const [holidays, setHolidays] = useState<HolidayTable | null>(null);
  /**
   * Past rate tables the open sheet has asked for.
   *
   * A key present with a null value means asked-and-unavailable, which the engine
   * reads differently from a key that is simply absent — see `HistoricalRates`.
   */
  const [history, setHistory] = useState<HistoricalRates>({});

  /**
   * Re-reads the current rate table.
   *
   * Exposed because the server refreshes on its own timer — twice a day, or
   * after a failed fetch turns the table stale — and the corner of the app that
   * shows which day the rates come from was otherwise as old as the page load.
   * The past-date tables are deliberately not re-read: a published rate for a
   * day gone by does not change.
   */
  const refreshRates = useCallback(async () => {
    const table = await api.rates().catch(() => null);
    if (table) setRates(table);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Optional enrichment: without rates there is no currency conversion.
    api
      .rates()
      .then((table) => !cancelled && setRates(table))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .holidays()
      .then((table) => !cancelled && setHolidays(table))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * `options` is memoised by the caller, so depending on it whole costs no more
   * renders than depending on each of its fields did.
   */
  const engine = useMemo(
    () => createEngine(engineInputs(options, rates, holidays, history)),
    [options, rates, holidays, history],
  );

  /**
   * Fetches the past dates a sheet mentions, once each.
   *
   * `asked` is a ref rather than derived from `history`, because a fetch in
   * flight is not yet in `history` and a second render would start it again.
   * Every answer is recorded, including the failures — a date the provider
   * cannot cover must not be retried on every keystroke.
   */
  const asked = useRef(new Set<string>());

  const needRates = useCallback((dates: readonly string[]) => {
    const wanted = dates.filter((date) => !asked.current.has(date));
    if (wanted.length === 0) return;
    for (const date of wanted) asked.current.add(date);

    // Resolved together and stored in one update, because each change to this
    // map rebuilds the engine: a sheet naming four dates should cost one rebuild
    // rather than four.
    void Promise.all(
      wanted.map((date) =>
        api
          .ratesOn(date)
          .catch(() => null)
          .then((table) => [date, table] as const),
      ),
    ).then((fetched) =>
      setHistory((current) => ({ ...current, ...Object.fromEntries(fetched) })),
    );
  }, []);

  return { engine, rates, holidays, needRates, refreshRates };
}

/**
 * How often an idle sheet is re-checked against the clock.
 *
 * Half a minute rather than a minute, because clock times are displayed to the
 * minute: a slower tick could leave a visibly wrong minute on screen for almost
 * as long as it is right.
 */
const CLOCK_TICK_MS = 30_000;

/** Re-evaluates the sheet on a short debounce as the user types. */
export function useResults(
  engine: ReturnType<typeof useEngine>['engine'],
  content: string,
  needRates?: (dates: readonly string[]) => void,
): LineResult[] {
  const [results, setResults] = useState<LineResult[]>([]);

  useEffect(() => {
    const handle = setTimeout(() => setResults(engine.evaluate(content)), 40);
    return () => clearTimeout(handle);
  }, [engine, content]);

  /*
   * Lines asking about a past date are answered from tables the host supplies,
   * so the sheet has to say which dates it wants. Debounced with the evaluation
   * rather than on its own timer, so typing a date out one character at a time
   * does not ask for every prefix of it.
   */
  useEffect(() => {
    if (!needRates) return;
    const handle = setTimeout(() => needRates(engine.ratesNeeded(content)), 40);
    return () => clearTimeout(handle);
  }, [engine, content, needRates]);

  /*
   * A sheet holding `today`, `now` or `time in Paris` would otherwise answer as
   * of the last keystroke for as long as the tab stays open — overnight, that is
   * yesterday's date presented as today's.
   *
   * Re-evaluating on a tick and keeping the previous array unless an answer
   * actually changed is what makes this cost nothing on the sheets that have no
   * clock in them: one evaluation every 30s, the same work as a single
   * keystroke, and no re-render at all unless something moved. Asking the engine
   * which lines are time-dependent would be a second copy of knowledge that
   * already lives in the temporal rules, and would drift from them.
   */
  useEffect(() => {
    const timer = setInterval(() => {
      const next = engine.evaluate(content);
      setResults((current) => (sameAnswers(current, next) ? current : next));
    }, CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [engine, content]);

  return results;
}

/** Whether two evaluations would look identical in the answer column. */
function sameAnswers(a: readonly LineResult[], b: readonly LineResult[]): boolean {
  return (
    a.length === b.length &&
    a.every((line, index) => {
      const other = b[index];
      return line.output === other?.output && line.error === other?.error;
    })
  );
}
