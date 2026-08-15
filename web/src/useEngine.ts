import { useEffect, useMemo, useState } from 'react';
import { createEngine, type LineResult, type RateTable } from '@webcalc/engine';
import { api, type HolidayTable } from './api';

/**
 * Loads exchange rates once, then builds an engine around them.
 *
 * Evaluation is entirely client-side, so a slow or unreachable API never
 * delays an answer; the engine simply starts without currency support and
 * gains it when the rates arrive.
 */
export function useEngine(options: { largeNumberNotation: boolean }) {
  const [rates, setRates] = useState<RateTable | null>(null);
  const [holidays, setHolidays] = useState<HolidayTable | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Both are optional enrichments: without rates there is no currency
    // conversion, and without holidays workday maths counts weekends only.
    api
      .rates()
      .then((table) => !cancelled && setRates(table))
      .catch(() => undefined);
    api
      .holidays()
      .then((table) => !cancelled && setHolidays(table))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const engine = useMemo(
    () =>
      createEngine({
        ...(rates && { rates }),
        ...(holidays && { holidays: holidays.dates }),
        largeNumberNotation: options.largeNumberNotation,
      }),
    [rates, holidays, options.largeNumberNotation],
  );

  return { engine, rates, holidays };
}

/** Re-evaluates the sheet on a short debounce as the user types. */
export function useResults(
  engine: ReturnType<typeof useEngine>['engine'],
  content: string,
): LineResult[] {
  const [results, setResults] = useState<LineResult[]>([]);

  useEffect(() => {
    const handle = setTimeout(() => setResults(engine.evaluate(content)), 40);
    return () => clearTimeout(handle);
  }, [engine, content]);

  return results;
}
