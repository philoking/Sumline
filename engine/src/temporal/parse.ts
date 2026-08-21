import {
  CalendarDate,
  Timecode,
  Timespan,
  type SpanPart,
  type SpanUnit,
} from './types.js';
import {
  MONTH_NAMES,
  WEEKDAY_NAMES,
  addDays,
  addMonths,
  startOfDay,
} from './calendar.js';
import { instantInZone, resolveZone } from './zones.js';

const MONTH_ALT = MONTH_NAMES.map(
  (m) => `${m.toLowerCase()}|${m.slice(0, 3).toLowerCase()}`,
).join('|');
const WEEKDAY_ALT = WEEKDAY_NAMES.map(
  (d) => `${d.toLowerCase()}|${d.slice(0, 3).toLowerCase()}`,
).join('|');

export const MONTH_PATTERN = MONTH_ALT;
export const WEEKDAY_PATTERN = WEEKDAY_ALT;

export const SPAN_UNIT_PATTERN = String.raw`business\s*days?|work(?:ing)?\s*days?|weekdays?|years?|yrs?|months?|mos?|weeks?|wks?|days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|frames?`;

/** Normalises a written unit to the canonical span unit. */
export function toSpanUnit(word: string): SpanUnit | null {
  const w = word.trim().toLowerCase();
  if (/business|work|weekday/.test(w)) return 'workday';
  if (/^(years?|yrs?)$/.test(w)) return 'year';
  if (/^(months?|mos?)$/.test(w)) return 'month';
  if (/^(weeks?|wks?)$/.test(w)) return 'week';
  if (/^days?$/.test(w)) return 'day';
  if (/^(hours?|hrs?|h)$/.test(w)) return 'hour';
  if (/^(minutes?|mins?|m)$/.test(w)) return 'minute';
  if (/^(seconds?|secs?|s)$/.test(w)) return 'second';
  if (/^frames?$/.test(w)) return 'frame';
  return null;
}

/**
 * A quantity of time written out: `3 weeks 5 days`, `5 hours 30 minutes`, or
 * the compact `3h 5m 10s`.
 */
export function parseSpan(text: string): Timespan | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const parts: SpanPart[] = [];
  const pattern = new RegExp(
    String.raw`(\d+(?:\.\d+)?)\s*(${SPAN_UNIT_PATTERN}|[hms])\b`,
    'gi',
  );

  let compact = 0;
  for (const match of trimmed.matchAll(pattern)) {
    const unit = toSpanUnit(match[2]!);
    if (!unit) return null;
    if (match[2]!.length === 1) compact++;
    parts.push({ value: Number(match[1]), unit });
  }
  if (parts.length === 0) return null;
  /*
   * `3h 5m 10s` is plainly a duration, but a lone `5m` is five metres far
   * more often than five minutes. Single-letter units therefore only count
   * when several of them appear together.
   */
  if (compact > 0 && parts.length < 2) return null;

  // Reject leftovers, so "3 days of meetings" is prose rather than a span.
  const remainder = trimmed
    .replace(new RegExp(pattern.source, 'gi'), '')
    .replace(/and|[\s,]/gi, '');
  return remainder.length === 0 ? new Timespan(parts) : null;
}

/** `00:05:30` — a laptime needs two colons to tell it from a clock time. */
export function parseLaptime(text: string): Timespan | null {
  const m = /^(\d{1,3}):([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/.exec(text.trim());
  if (!m) return null;
  return new Timespan(
    [
      { value: Number(m[1]), unit: 'hour' },
      { value: Number(m[2]), unit: 'minute' },
      { value: Number(m[3]), unit: 'second' },
    ],
    'lap',
  );
}

/** `03:10:20:05` — hour, minute, second, frames. */
export function parseTimecode(text: string, fps: number): Timecode | null {
  const m = /^(\d{1,3}):([0-5]?\d):([0-5]?\d):(\d{1,3})$/.exec(text.trim());
  if (!m) return null;
  const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return new Timecode(Math.round(seconds * fps) + Number(m[4]), fps);
}

export interface ClockTime {
  hour: number;
  minute: number;
}

/** `6pm`, `6:30 pm`, `16:00`, `7:30`. */
export function parseClockTime(text: string): ClockTime | null {
  const trimmed = text.trim().toLowerCase();

  const meridiem = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(trimmed);
  if (meridiem) {
    let hour = Number(meridiem[1]) % 12;
    if (meridiem[3] === 'pm') hour += 12;
    return { hour, minute: Number(meridiem[2] ?? 0) };
  }

  const twentyFour = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(trimmed);
  if (twentyFour) {
    return { hour: Number(twentyFour[1]), minute: Number(twentyFour[2]) };
  }

  return null;
}

/**
 * A moment: a clock time, optionally in a named place.
 *
 * `6pm Sydney` is resolved against today's date *in Sydney*, which is what
 * makes converting it to another zone meaningful.
 */
export function parseMoment(text: string, now: Date): CalendarDate | null {
  const trimmed = text.trim();
  if (/^now$/i.test(trimmed)) return new CalendarDate(now, 'minute');

  // "April 1, 2019 3:30pm" — a date and a time of day written together.
  const dated = /^(.+?)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2})$/i.exec(trimmed);
  if (dated) {
    const date = parseDate(dated[1]!, now);
    const clock = parseClockTime(dated[2]!);
    if (date && clock) {
      const combined = new Date(date.date.getTime());
      combined.setHours(clock.hour, clock.minute, 0, 0);
      return new CalendarDate(combined, 'minute');
    }
  }

  const withZone = /^(.+?)\s+(?:in\s+)?([A-Za-z][A-Za-z\s+\-0-9]*)$/.exec(trimmed);
  if (withZone) {
    const clock = parseClockTime(withZone[1]!);
    const zone = resolveZone(withZone[2]!);
    if (clock && zone) {
      const local = new Date(now.getTime());
      return new CalendarDate(
        instantInZone(
          local.getFullYear(),
          local.getMonth(),
          local.getDate(),
          clock.hour,
          clock.minute,
          zone,
        ),
        'minute',
        zone,
      );
    }
  }

  const clock = parseClockTime(trimmed);
  if (!clock) return null;
  const base = startOfDay(now);
  base.setHours(clock.hour, clock.minute, 0, 0);
  return new CalendarDate(base, 'minute');
}

/**
 * A date literal.
 *
 * A date written without a year resolves to whichever year puts it nearest to
 * today, so in December `January 12` means next January rather than the one
 * that has already passed.
 */
export function parseDate(text: string, now: Date): CalendarDate | null {
  let s = text.trim().toLowerCase().replace(/,/g, '');
  if (!s) return null;

  /*
   * Dates are rendered as "Thu 3 Sep 2026", so that form has to parse back —
   * otherwise the engine cannot read its own output, and `date + 80 days -
   * 80 days` fails. The lookahead keeps a bare "friday" as a weekday.
   */
  s = s.replace(new RegExp(`^(?:${WEEKDAY_ALT})\\s+(?=\\d|[a-z])`), '');
  if (!s) return null;

  if (s === 'today') return new CalendarDate(startOfDay(now));
  if (s === 'now') return new CalendarDate(now, 'minute');
  if (s === 'tomorrow') return new CalendarDate(addDays(startOfDay(now), 1));
  if (s === 'yesterday') return new CalendarDate(addDays(startOfDay(now), -1));

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) return day(+iso[1]!, +iso[2]! - 1, +iso[3]!);

  const isoTime = /^(\d{4})-(\d{2})-(\d{2})[t ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (isoTime) {
    return new CalendarDate(
      new Date(
        +isoTime[1]!,
        +isoTime[2]! - 1,
        +isoTime[3]!,
        +isoTime[4]!,
        +isoTime[5]!,
        +(isoTime[6] ?? 0),
      ),
      'minute',
    );
  }

  /*
   * Slashes follow month/day/year, as JavaScript itself does. Dots are the
   * European convention and mean day.month.year — `01.05.2005` is 1 May,
   * which is the reading Soulver's own examples assume.
   */
  const separated = /^(\d{1,2})([/.])(\d{1,2})\2(\d{2,4})$/.exec(s);
  if (separated) {
    const rawYear = +separated[4]!;
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    const dayFirstFormat = separated[2] === '.';
    const month = dayFirstFormat ? +separated[3]! : +separated[1]!;
    const date = dayFirstFormat ? +separated[1]! : +separated[3]!;
    /*
     * Refused rather than rolled over. `new Date` reads month 99 as eight
     * years and three months on, so `99/99/2026` would answer with a real
     * date nobody wrote — and a line the engine cannot read as a date is
     * better handed back to the expression parser, where it is arithmetic.
     */
    if (isRealDate(year, month, date)) return day(year, month - 1, date);
  }

  const monthFirst = new RegExp(
    `^(${MONTH_ALT})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?$`,
  ).exec(s);
  if (monthFirst) {
    return nearestYear(monthIndex(monthFirst[1]!), +monthFirst[2]!, monthFirst[3], now);
  }

  const dayFirst = new RegExp(
    `^(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALT})(?:\\s+(\\d{4}))?$`,
  ).exec(s);
  if (dayFirst) {
    return nearestYear(monthIndex(dayFirst[2]!), +dayFirst[1]!, dayFirst[3], now);
  }

  const relative = new RegExp(
    `^(next|last|this)\\s+(${WEEKDAY_ALT}|week|month|year)$`,
  ).exec(s);
  if (relative) return relativeDate(relative[1]!, relative[2]!, now);

  const bareWeekday = new RegExp(`^(${WEEKDAY_ALT})$`).exec(s);
  if (bareWeekday) return relativeDate('next', bareWeekday[1]!, now);

  const bareYear = /^(\d{4})$/.exec(s);
  if (bareYear && +bareYear[1]! > 1200 && +bareYear[1]! < 3000) {
    return day(+bareYear[1]!, 0, 1);
  }

  return null;
}

function day(year: number, month: number, date: number): CalendarDate {
  return new CalendarDate(new Date(year, month, date));
}

/** Whether a month and day exist in that year — 31 February does not. */
function isRealDate(year: number, month: number, date: number): boolean {
  if (month < 1 || month > 12 || date < 1) return false;
  // Day zero of the next month is the last day of this one.
  return date <= new Date(year, month, 0).getDate();
}

/** Picks the year that puts a month/day combination closest to today. */
function nearestYear(
  month: number,
  date: number,
  explicitYear: string | undefined,
  now: Date,
): CalendarDate {
  if (explicitYear) return day(+explicitYear, month, date);

  const candidates = [-1, 0, 1].map(
    (offset) => new Date(now.getFullYear() + offset, month, date),
  );
  const best = candidates.reduce((closest, candidate) =>
    Math.abs(candidate.getTime() - now.getTime()) <
    Math.abs(closest.getTime() - now.getTime())
      ? candidate
      : closest,
  );
  return new CalendarDate(best);
}

function relativeDate(qualifier: string, target: string, now: Date): CalendarDate | null {
  const today = startOfDay(now);
  const direction = qualifier === 'last' ? -1 : 1;

  if (target === 'week') return new CalendarDate(addDays(today, 7 * direction));
  if (target === 'month') return new CalendarDate(addMonths(today, direction));
  if (target === 'year') return new CalendarDate(addMonths(today, 12 * direction));

  const index = WEEKDAY_NAMES.findIndex((d) =>
    d.toLowerCase().startsWith(target.slice(0, 3)),
  );
  if (index < 0) return null;

  let delta = index - today.getDay();
  if (qualifier === 'last') {
    if (delta >= 0) delta -= 7;
  } else if (delta <= 0) {
    delta += 7;
  }
  return new CalendarDate(addDays(today, delta));
}

function monthIndex(name: string): number {
  return MONTH_NAMES.findIndex((m) => m.toLowerCase().startsWith(name.slice(0, 3)));
}
