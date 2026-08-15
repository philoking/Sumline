import { useEffect, useMemo, useState } from 'react';
import { createEngine, type LineResult, type RateTable } from '@webcalc/engine';
import { api } from './api';

/**
 * Loads exchange rates once, then builds an engine around them.
 *
 * Evaluation is entirely client-side, so a slow or unreachable API never
 * delays an answer; the engine simply starts without currency support and
 * gains it when the rates arrive.
 */
export function useEngine() {
  const [rates, setRates] = useState<RateTable | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .rates()
      .then((table) => {
        if (!cancelled) setRates(table);
      })
      .catch(() => {
        // Currency conversion is unavailable; everything else still works.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const engine = useMemo(
    () => createEngine(rates ? { rates } : {}),
    [rates],
  );

  return { engine, rates };
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
