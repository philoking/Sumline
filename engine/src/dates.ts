/**
 * A self-contained date-expression evaluator.
 *
 * math.js has no calendar type, so date lines are recognised and evaluated
 * before the expression parser ever sees them. The gate in `looksLikeDate` is
 * deliberately strict: a line only takes this path when it clearly contains a
 * date token, so ordinary arithmetic is never intercepted.
 */

export class CalendarDate {
  constructor(readonly date: Date) {}
  get iso(): string {
    const y = this.date.getFullYear();
    const m = String(this.date.getMonth() + 1).padStart(2, '0');
    const d = String(this.date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
}

export type DurationUnit = 'day' | 'week' | 'month' | 'year';

export class Duration {
  constructor(readonly amount: number, readonly unit: DurationUnit) {}
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const WEEKDAYS = [
  'sunday', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday',
];

const MONTH_ALT = MONTHS.map((m) => `${m}|${m.slice(0, 3)}`).join('|');
const WEEKDAY_ALT = WEEKDAYS.map((d) => `${d}|${d.slice(0, 3)}`).join('|');

const DATE_TOKEN = new RegExp(
  String.raw`\b(?:today|tomorrow|yesterday|now|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}/\d{1,2}/\d{2,4}|${MONTH_ALT}|(?:next|last|this)\s+(?:${WEEKDAY_ALT}|week|month|year))\b`,
  'i',
);

/** Cheap gate so non-date lines fall straight through to math.js. */
export function looksLikeDate(input: string): boolean {
  return DATE_TOKEN.test(input);
}

export function evaluateDate(
  input: string,
  now: Date,
): CalendarDate | Duration | null {
  const s = input.trim();

  // "days until christmas" / "weeks since 2026-01-01"
  const countdown =
    /^(days?|weeks?|months?|years?)\s+(?:until|till|to|since|from)\s+(.+)$/i.exec(s);
  if (countdown) {
    const target = parseDateExpression(countdown[2]!, now);
    if (!target) return null;
    const days = diffInDays(startOfDay(now), target.date);
    const signed = /since|from/i.test(s) ? -days : days;
    return scaleDuration(signed, countdown[1]!);
  }

  // "2026-01-01 to 2026-08-15" — a span between two dates
  const span = /^(.+?)\s+(?:to|until|till|through)\s+(.+)$/i.exec(s);
  if (span) {
    const from = parseDateExpression(span[1]!, now);
    const to = parseDateExpression(span[2]!, now);
    if (from && to) return new Duration(diffInDays(from.date, to.date), 'day');
  }

  // "2026-08-15 - today" — a difference written with a minus sign
  const minus = /^(.+?)\s+-\s+(.+)$/.exec(s);
  if (minus) {
    const left = parseDateExpression(minus[1]!, now);
    const right = parseDateExpression(minus[2]!, now);
    if (left && right) return new Duration(diffInDays(right.date, left.date), 'day');
  }

  return parseDateExpression(s, now);
}

const OFFSET_UNITS =
  String.raw`business\s+days?|work(?:ing)?\s+days?|weekdays?|days?|weeks?|months?|years?|hours?|minutes?`;

/** A date literal followed by any number of `± N unit` offsets. */
function parseDateExpression(input: string, now: Date): CalendarDate | null {
  let rest = input.trim();
  const offsetRe = new RegExp(
    String.raw`\s*([+\-])\s*(\d+(?:\.\d+)?)\s*(${OFFSET_UNITS})\s*$`,
    'i',
  );

  const offsets: Array<{ sign: number; amount: number; unit: string }> = [];
  for (let guard = 0; guard < 12; guard++) {
    const m = offsetRe.exec(rest);
    if (!m) break;
    offsets.unshift({
      sign: m[1] === '-' ? -1 : 1,
      amount: Number(m[2]!),
      unit: m[3]!.toLowerCase(),
    });
    rest = rest.slice(0, m.index);
  }

  const base = parseDateLiteral(rest.trim(), now);
  if (!base) return null;

  let date = base;
  for (const { sign, amount, unit } of offsets) {
    date = applyOffset(date, sign * amount, unit);
  }
  return new CalendarDate(date);
}

function parseDateLiteral(text: string, now: Date): Date | null {
  const s = text.trim().toLowerCase().replace(/,/g, '');
  if (s === '') return null;

  if (s === 'today' || s === 'now') return startOfDay(now);
  if (s === 'tomorrow') return addDays(startOfDay(now), 1);
  if (s === 'yesterday') return addDays(startOfDay(now), -1);

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) return makeDate(+iso[1]!, +iso[2]! - 1, +iso[3]!);

  // Slash dates follow the month/day/year convention, as JS itself does.
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (slash) {
    const year = +slash[3]!;
    return makeDate(year < 100 ? 2000 + year : year, +slash[1]! - 1, +slash[2]!);
  }

  // "march 3 2026" / "march 3"
  const monthFirst = new RegExp(`^(${MONTH_ALT})\\s+(\\d{1,2})(?:\\s+(\\d{4}))?$`).exec(s);
  if (monthFirst) {
    return makeDate(
      monthFirst[3] ? +monthFirst[3] : now.getFullYear(),
      monthIndex(monthFirst[1]!),
      +monthFirst[2]!,
    );
  }

  // "3 march 2026" / "3rd march"
  const dayFirst = new RegExp(
    `^(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALT})(?:\\s+(\\d{4}))?$`,
  ).exec(s);
  if (dayFirst) {
    return makeDate(
      dayFirst[3] ? +dayFirst[3] : now.getFullYear(),
      monthIndex(dayFirst[2]!),
      +dayFirst[1]!,
    );
  }

  const relative = new RegExp(`^(next|last|this)\\s+(${WEEKDAY_ALT}|week|month|year)$`).exec(s);
  if (relative) return relativeDate(relative[1]!, relative[2]!, now);

  return null;
}

function relativeDate(qualifier: string, target: string, now: Date): Date | null {
  const today = startOfDay(now);
  const direction = qualifier === 'last' ? -1 : 1;

  if (target === 'week') return addDays(today, 7 * direction);
  if (target === 'month') return applyOffset(today, direction, 'month');
  if (target === 'year') return applyOffset(today, direction, 'year');

  const index = WEEKDAYS.findIndex((d) => d.startsWith(target.slice(0, 3)));
  if (index < 0) return null;

  if (qualifier === 'last') {
    let delta = index - today.getDay();
    if (delta >= 0) delta -= 7;
    return addDays(today, delta);
  }
  let delta = index - today.getDay();
  if (delta <= 0) delta += 7;
  return addDays(today, delta);
}

function applyOffset(date: Date, amount: number, unit: string): Date {
  const u = unit.replace(/s$/, '');
  if (/business|work|weekday/.test(u)) return addBusinessDays(date, amount);
  if (u.startsWith('day')) return addDays(date, amount);
  if (u.startsWith('week')) return addDays(date, amount * 7);
  if (u.startsWith('hour')) return new Date(date.getTime() + amount * 3_600_000);
  if (u.startsWith('minute')) return new Date(date.getTime() + amount * 60_000);
  if (u.startsWith('month')) return addMonths(date, amount);
  if (u.startsWith('year')) return addMonths(date, amount * 12);
  return date;
}

/** Adds months with end-of-month clamping, so Jan 31 + 1 month is Feb 28. */
function addMonths(date: Date, months: number): Date {
  const target = new Date(date.getTime());
  const day = target.getDate();
  target.setDate(1);
  target.setMonth(target.getMonth() + Math.trunc(months));
  const lastDay = new Date(
    target.getFullYear(),
    target.getMonth() + 1,
    0,
  ).getDate();
  target.setDate(Math.min(day, lastDay));
  return target;
}

function addBusinessDays(date: Date, amount: number): Date {
  const step = amount >= 0 ? 1 : -1;
  let remaining = Math.abs(Math.trunc(amount));
  let cursor = new Date(date.getTime());
  while (remaining > 0) {
    cursor = addDays(cursor, step);
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) remaining--;
  }
  return cursor;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + Math.trunc(days));
  return next;
}

/** Whole days between two dates, immune to DST shifts. */
function diffInDays(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

/** Re-expresses a day count in whatever unit the question asked for. */
function scaleDuration(days: number, unit: string): Duration {
  const u = unit.toLowerCase();
  if (u.startsWith('week')) return new Duration(days / 7, 'week');
  if (u.startsWith('month')) return new Duration(days / 30.436875, 'month');
  if (u.startsWith('year')) return new Duration(days / 365.2425, 'year');
  return new Duration(days, 'day');
}

function monthIndex(name: string): number {
  return MONTHS.findIndex((m) => m.startsWith(name.slice(0, 3)));
}

function makeDate(year: number, month: number, day: number): Date {
  return new Date(year, month, day);
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
