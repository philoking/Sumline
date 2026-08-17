import { SYMBOL_TO_CODE } from './currencies.js';
import { normalizeNumberLiterals, type NumberRegion } from './numberFormat.js';
import { parseDate } from './temporal/parse.js';
import type { RateTable } from './types.js';

/**
 * Converting money at a past date.
 *
 * The live rate table is a single snapshot, so every conversion in a sheet used
 * to happen at today's rate — including one about a trip taken in 2019, silently
 * and with nothing on the line to say so.
 *
 * This is handled outside math.js rather than by registering a second set of
 * currency units. Units are registered per math.js instance, so a rate table per
 * date would mean an instance per date, and building one is expensive enough that
 * a sheet naming five dates would be noticeably slow. A conversion at a named
 * date is a self-contained calculation, so it is done arithmetically here and the
 * result handed back as an ordinary money value.
 */

/** A conversion a line asked for, at a date it named. */
export interface HistoricalConversion {
  amount: number;
  from: string;
  to: string;
  /** The date, as `YYYY-MM-DD`. */
  on: string;
}

/**
 * Rate tables by ISO date, as supplied by the host.
 *
 * Three states, because a sheet has to read differently in each:
 *
 *  - **absent** — not fetched yet. The line waits quietly rather than flashing
 *    an error that resolves itself a moment later.
 *  - **null** — asked for and not available: no network, or a date the provider
 *    does not cover. The line says so.
 *  - **a table** — convert.
 */
export type HistoricalRates = Readonly<Record<string, RateTable | null>>;

/** Only the shape `<amount> in <CUR> on <date>` is claimed. */
const CONVERSION_RE = /^(.+?)\s+(?:in|to|into|as)\s+([A-Za-z]{3})\s+on\s+(.+?)\s*$/i;

/** `100 USD`, `$100`, `USD 100` — an amount with a currency attached. */
const SYMBOL_FIRST_RE = /^([^\d\s.,+\-*/^()]{1,3})\s*([\d.,_ ]+)$/;
const CODE_LAST_RE = /^([\d.,_ ]+)\s*([A-Za-z]{3})$/;
const CODE_FIRST_RE = /^([A-Za-z]{3})\s*([\d.,_ ]+)$/;

export interface ParseOptions {
  region: NumberRegion;
  /** Codes this engine knows, so an unknown one is not read as a currency. */
  currencies: ReadonlySet<string>;
  now: Date;
}

function toNumber(text: string, region: NumberRegion): number | null {
  const normalised = normalizeNumberLiterals(text.trim(), region).replace(/\s/g, '');
  if (!/^\d*\.?\d+$/.test(normalised)) return null;
  const value = Number(normalised);
  return Number.isFinite(value) ? value : null;
}

/** The amount and currency on the left of the conversion. */
function parseAmount(
  text: string,
  options: ParseOptions,
): { amount: number; code: string } | null {
  const trimmed = text.trim();

  const symbolFirst = SYMBOL_FIRST_RE.exec(trimmed);
  if (symbolFirst) {
    const code = SYMBOL_TO_CODE[symbolFirst[1]!];
    const amount = toNumber(symbolFirst[2]!, options.region);
    if (code && amount !== null) return { amount, code };
  }

  for (const [pattern, codeIndex, amountIndex] of [
    [CODE_LAST_RE, 2, 1],
    [CODE_FIRST_RE, 1, 2],
  ] as const) {
    const match = pattern.exec(trimmed);
    if (!match) continue;
    const code = match[codeIndex]!.toUpperCase();
    const amount = toNumber(match[amountIndex]!, options.region);
    if (options.currencies.has(code) && amount !== null) return { amount, code };
  }

  return null;
}

/**
 * Reads a line as a conversion at a named date, or returns null.
 *
 * Deliberately strict. `on` is a common word, and the temporal rules would
 * otherwise be competing for lines like `3 days on holiday`: both currencies
 * have to be codes the engine knows, and the date has to parse, before this
 * claims the line.
 */
export function parseHistoricalConversion(
  line: string,
  options: ParseOptions,
): HistoricalConversion | null {
  const match = CONVERSION_RE.exec(line.trim());
  if (!match) return null;

  const to = match[2]!.toUpperCase();
  if (!options.currencies.has(to)) return null;

  const left = parseAmount(match[1]!, options);
  if (!left) return null;

  const date = parseDate(match[3]!, options.now);
  if (!date) return null;

  return { amount: left.amount, from: left.code, to, on: isoDate(date.date) };
}

/** `YYYY-MM-DD` in local terms, which is how the provider keys its data. */
export function isoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export interface Converted {
  amount: number;
  code: string;
  /** The date the rates actually carry, which may precede the one asked for. */
  date: string;
}

/**
 * Applies a historical table to a conversion.
 *
 * Rates are "how many X per one base", so crossing two currencies goes through
 * the base in both directions. A code missing from the table is reported rather
 * than assumed: a currency the ECB did not publish on that date has no rate, and
 * inventing one would be the silent wrongness this whole feature exists to fix.
 */
export function convertAt(
  conversion: HistoricalConversion,
  table: RateTable,
): Converted | { error: string } {
  const base = table.base.toUpperCase();
  const perBase = (code: string): number | null => {
    if (code === base) return 1;
    const rate = table.rates[code];
    return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : null;
  };

  const from = perBase(conversion.from);
  const to = perBase(conversion.to);
  const missing = from === null ? conversion.from : to === null ? conversion.to : null;
  if (missing !== null || from === null || to === null) {
    return { error: `No ${missing} rate published for ${conversion.on}` };
  }

  return {
    amount: (conversion.amount / from) * to,
    code: conversion.to,
    date: table.date,
  };
}
