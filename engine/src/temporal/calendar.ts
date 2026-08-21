import { CalendarDate, Timespan, type SpanPart, type SpanUnit } from './types.js';

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Public holidays as `YYYY-MM-DD`, excluded from workday calculations. */
export type HolidaySet = ReadonlySet<string>;

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + Math.trunc(days));
  return next;
}

/** Adds months with end-of-month clamping, so Jan 31 + 1 month is Feb 28. */
export function addMonths(date: Date, months: number): Date {
  const target = new Date(date.getTime());
  const day = target.getDate();
  target.setDate(1);
  target.setMonth(target.getMonth() + Math.trunc(months));
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target;
}

export function isoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Monday to Friday, excluding any public holiday we know about. */
export function isWorkday(date: Date, holidays: HolidaySet): boolean {
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  return !holidays.has(isoDate(date));
}

export function addWorkdays(date: Date, amount: number, holidays: HolidaySet): Date {
  const step = amount >= 0 ? 1 : -1;
  let remaining = Math.abs(Math.trunc(amount));
  let cursor = new Date(date.getTime());
  while (remaining > 0) {
    cursor = addDays(cursor, step);
    if (isWorkday(cursor, holidays)) remaining--;
  }
  return cursor;
}

/** Workdays in the half-open interval [from, to). */
export function countWorkdays(from: Date, to: Date, holidays: HolidaySet): number {
  const step = from <= to ? 1 : -1;
  let cursor = startOfDay(from);
  const end = startOfDay(to);
  let count = 0;
  while (step > 0 ? cursor < end : cursor > end) {
    cursor = addDays(cursor, step);
    if (isWorkday(step > 0 ? cursor : addDays(cursor, 1), holidays)) count++;
  }
  return count * (step > 0 ? 1 : -1);
}

/** Whole days between two dates, immune to daylight-saving shifts. */
export function diffInDays(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

export function diffInSeconds(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 1000;
}

/**
 * The interval between two dates, broken into calendar components.
 *
 * Unlike decomposing a fixed number of seconds, this can use months and years
 * honestly, because it knows both endpoints and can count actual calendar
 * steps: `3 March to 30 May` is `2 months 3 weeks 6 days`.
 */
export function spanBetween(from: Date, to: Date): Timespan {
  const sign = to < from ? -1 : 1;
  const [start, end] = sign > 0 ? [from, to] : [to, from];

  let months = 0;
  while (addMonths(start, months + 1) <= end) months++;

  const afterMonths = addMonths(start, months);
  const days = diffInDays(afterMonths, end);

  const parts: SpanPart[] = [];
  const years = Math.floor(months / 12);
  if (years > 0) parts.push({ value: years * sign, unit: 'year' });
  if (months % 12 > 0) parts.push({ value: (months % 12) * sign, unit: 'month' });

  const weeks = Math.floor(days / 7);
  if (weeks > 0) parts.push({ value: weeks * sign, unit: 'week' });
  if (days % 7 > 0) parts.push({ value: (days % 7) * sign, unit: 'day' });

  if (parts.length === 0) {
    const seconds = Math.round(diffInSeconds(start, end));
    if (seconds > 0) return hoursAndMinutes(seconds * sign);
    return new Timespan([{ value: 0, unit: 'day' }]);
  }
  return new Timespan(parts);
}

/** Hours and minutes for intervals shorter than a day. */
export function hoursAndMinutes(totalSeconds: number): Timespan {
  const sign = totalSeconds < 0 ? -1 : 1;
  let remaining = Math.abs(Math.round(totalSeconds));
  const parts: SpanPart[] = [];
  for (const [unit, size] of [
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ] as Array<[SpanUnit, number]>) {
    const whole = Math.floor(remaining / size);
    if (whole > 0) parts.push({ value: whole * sign, unit });
    remaining -= whole * size;
  }
  return parts.length > 0
    ? new Timespan(parts)
    : new Timespan([{ value: 0, unit: 'minute' }]);
}

/** ISO 8601 week number: weeks start on Monday, week 1 holds the first Thursday. */
export function weekNumber(date: Date): number {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);
  return 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

export function daysInQuarter(year: number, quarter: number): number {
  const firstMonth = (quarter - 1) * 3;
  return [0, 1, 2].reduce(
    (total, offset) => total + daysInMonth(year, firstMonth + offset),
    0,
  );
}

/** Halfway between two moments, rounded to the day when both are dates. */
export function midpoint(a: CalendarDate, b: CalendarDate): CalendarDate {
  const middle = new Date((a.date.getTime() + b.date.getTime()) / 2);
  return a.hasTime || b.hasTime
    ? new CalendarDate(middle, 'minute')
    : new CalendarDate(startOfDay(middle), 'day');
}
