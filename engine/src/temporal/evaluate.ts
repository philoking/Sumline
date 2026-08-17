import {
  CalendarDate,
  FrameCount,
  Timecode,
  TemporalNumber,
  Timespan,
  decomposeSeconds,
  type SpanUnit,
} from './types.js';
import {
  WEEKDAY_NAMES,
  addDays,
  addMonths,
  addWorkdays,
  countWorkdays,
  daysInMonth,
  daysInQuarter,
  diffInDays,
  diffInSeconds,
  hoursAndMinutes,
  isoDate,
  midpoint,
  spanBetween,
  startOfDay,
  weekNumber,
  type HolidaySet,
} from './calendar.js';
import {
  MONTH_PATTERN,
  SPAN_UNIT_PATTERN,
  WEEKDAY_PATTERN,
  parseClockTime,
  parseDate,
  parseLaptime,
  parseMoment,
  parseSpan,
  parseTimecode,
  toSpanUnit,
} from './parse.js';
import {
  instantInZone,
  resolveZone,
  wallClockIn,
  zoneOffsetMinutes,
} from './zones.js';

export interface TemporalOptions {
  /**
   * The true instant. Timestamps and zone offsets are computed from this and
   * nothing else, so they stay right whatever zone the sheet reasons in.
   */
  now: Date;
  holidays: HolidaySet;
  /** Default frame rate for timecodes with none given. */
  fps: number;
  /**
   * The zone this sheet's dates resolve in, or null/absent for the reader's own.
   *
   * Absent is the default and the common case: evaluation runs in the browser,
   * so "here" means wherever the reader is. A space sets this when its sheets
   * should resolve somewhere in particular regardless of who opens them.
   */
  zone?: string | null;
  /**
   * `now` with its local fields reading as the wall clock in `zone`.
   *
   * Every calendar rule below works on local fields, so handing them a shifted
   * date is what makes them compute in another zone without being rewritten.
   * Absent means no zone is set and it is simply `now` — which is what keeps an
   * instance that sets no zone behaving exactly as it did.
   */
  wallNow?: Date;
}

/** The clock the calendar rules reason against. */
function wall(o: TemporalOptions): Date {
  return o.wallNow ?? o.now;
}

/**
 * The real instant a moment names.
 *
 * A moment carrying its own zone already holds one — `time in Paris` is a true
 * instant that merely renders elsewhere. Everything else was built in wall-clock
 * space, so when a zone is set its fields have to be read back as that zone's
 * clock rather than the browser's.
 */
function trueInstant(moment: CalendarDate, o: TemporalOptions): Date {
  if (moment.zone || !o.zone) return moment.date;
  const d = moment.date;
  const at = instantInZone(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    o.zone,
  );
  return new Date(at.getTime() + d.getSeconds() * 1000 + d.getMilliseconds());
}

export type TemporalValue =
  | CalendarDate
  | Timespan
  | Timecode
  | FrameCount
  | TemporalNumber
  /** Weekday names and ISO8601 strings are answers in their own right. */
  | string;

const DATE_TOKEN = new RegExp(
  String.raw`\b(?:today|tomorrow|yesterday|now|timestamp|iso8601|iso|timespan|laptime|time|date\b|workdays?|weekdays?|business\s+days?|week\s+(?:of|number)|fps|frames?|` +
    String.raw`\d{4}-\d{1,2}-\d{1,2}|\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm)|` +
    /*
     * `12/25/2026` and `25.12.2026` — a date standing on its own, which is a
     * legitimate thing to write at the top of a sheet. Without this the line
     * falls through to math.js and answers 0.000237, two divisions.
     *
     * The four-digit year is what makes it safe to claim: `3/4/5` and `1/2/3`
     * are arithmetic people genuinely write, and no reading of the gate can
     * tell those from a date with a short year. `parseDate` still accepts a
     * two-digit year where something else on the line has already established
     * that it is a date — `12/25/26 + 3 days`.
     */
    String.raw`\d{1,2}[/.]\d{1,2}[/.]\d{4}\b|` +
    String.raw`${MONTH_PATTERN}|${WEEKDAY_PATTERN}|` +
    String.raw`(?:next|last|this)\s+(?:week|month|year)|days?\s+(?:until|till|since|from|between|in|ago)|` +
    String.raw`\d+\s*(?:${SPAN_UNIT_PATTERN})\b|\d+\s*[hms]\b\s*\d+\s*[hms]\b)`,
  'i',
);

/** Cheap gate so ordinary arithmetic never reaches the temporal evaluator. */
export function looksTemporal(input: string): boolean {
  return DATE_TOKEN.test(input);
}

/**
 * Evaluates a line as a date, time or duration, or returns null to let the
 * expression parser have it.
 *
 * The order of the rules is the specification: each is more specific than the
 * one below it, and moving any of them changes what a line means.
 */
export function evaluateTemporal(
  input: string,
  options: TemporalOptions,
): TemporalValue | null {
  const s = input.trim();
  if (!s) return null;

  const value =
    timecodeExpression(s, options) ??
    laptimeExpression(s) ??
    conversion(s, options) ??
    zoneQuery(s, options) ??
    countdown(s, options) ??
    calendarFacts(s, options) ??
    interval(s, options) ??
    offsetExpression(s, options) ??
    bareMoment(s, options);

  // `today + 999999 years` runs off the end of what a JavaScript Date can
  // hold. Every field of an invalid date reads NaN, which the formatter would
  // happily render as "undefined NaN undefined NaN" — so it is rejected here,
  // at the one point every temporal answer passes through.
  return isRepresentable(value) ? value : null;
}

function isRepresentable(value: TemporalValue | null): boolean {
  if (value === null) return false;
  if (value instanceof CalendarDate) return !Number.isNaN(value.date.getTime());
  if (value instanceof Timespan) {
    return value.parts.every((part) => Number.isFinite(part.value));
  }
  if (value instanceof Timecode) return Number.isFinite(value.frames);
  if (value instanceof FrameCount) return Number.isFinite(value.frames);
  if (value instanceof TemporalNumber) return Number.isFinite(value.value);
  return true;
}

/* ------------------------------------------------------------------ *
 * Timecodes and laptimes
 * ------------------------------------------------------------------ */

function timecodeExpression(s: string, o: TemporalOptions): TemporalValue | null {
  const rate = /(?:at|@)\s*(\d+(?:\.\d+)?)\s*fps/i.exec(s);
  const fps = rate ? Number(rate[1]) : o.fps;
  const body = rate ? s.replace(rate[0], ' ') : s;

  if (!/\d+:\d+:\d+:\d+/.test(body) && !/\bframes?\b/i.test(body)) return null;

  // "43,440 frames @ 24 fps" — a count of frames becomes a position.
  const fromFrames = /^\s*([\d,]+(?:\.\d+)?)\s*frames?\s*$/i.exec(body);
  if (fromFrames && rate) {
    return new Timecode(Number(fromFrames[1]!.replace(/,/g, '')), fps);
  }

  const terms = body.split(/\s*([+-])\s*/).filter((part) => part.trim() !== '');
  const first = readTimecodeTerm(terms[0] ?? '', fps);
  if (!first) return null;

  let frames = first;
  for (let i = 1; i < terms.length; i += 2) {
    const sign = terms[i] === '-' ? -1 : 1;
    const operand = readTimecodeTerm(terms[i + 1] ?? '', fps);
    if (operand === null) return null;
    frames += sign * operand;
  }

  if (/\bin\s+frames\s*$/i.test(s)) return new FrameCount(Math.round(frames));
  return new Timecode(Math.round(frames), fps);
}

/** A timecode, a frame count, or a written span, all measured in frames. */
function readTimecodeTerm(text: string, fps: number): number | null {
  const trimmed = text.replace(/\bin\s+frames\b/i, '').trim();
  if (!trimmed) return null;

  const code = parseTimecode(trimmed, fps);
  if (code) return code.frames;

  const frames = /^([\d,]+)\s*frames?$/i.exec(trimmed);
  if (frames) return Number(frames[1]!.replace(/,/g, ''));

  const span = parseSpan(trimmed);
  if (span) {
    const extra = span.parts
      .filter((part) => part.unit === 'frame')
      .reduce((total, part) => total + part.value, 0);
    const seconds = span.parts
      .filter((part) => part.unit !== 'frame')
      .reduce((total, part) => total + part.value * secondsIn(part.unit), 0);
    return seconds * fps + extra;
  }
  return null;
}

function secondsIn(unit: SpanUnit): number {
  return { year: 31_556_952, month: 2_629_746, week: 604_800, day: 86_400, workday: 86_400, hour: 3600, minute: 60, second: 1, frame: 0 }[unit];
}

function laptimeExpression(s: string): TemporalValue | null {
  if (!/\d+:\d+:\d+/.test(s) || /\d+:\d+:\d+:\d+/.test(s)) return null;

  const terms = s.split(/\s*([+-])\s*/).filter((part) => part.trim() !== '');
  const first = parseLaptime(terms[0] ?? '');
  if (!first) return null;

  let seconds = first.seconds;
  for (let i = 1; i < terms.length; i += 2) {
    const sign = terms[i] === '-' ? -1 : 1;
    const operand = parseLaptime(terms[i + 1] ?? '') ?? parseSpan(terms[i + 1] ?? '');
    if (!operand) return null;
    seconds += sign * operand.seconds;
  }
  return decomposeSeconds(seconds).as('lap');
}

/* ------------------------------------------------------------------ *
 * Conversions
 * ------------------------------------------------------------------ */

function conversion(s: string, o: TemporalOptions): TemporalValue | null {
  // Greedy on the left so the *last* keyword splits the line:
  // "10 March to 17 March in workdays" is a range converted to workdays.
  const as = /^(.+)\s+(?:as|to|in)\s+(.+?)\s*$/i.exec(s);
  if (!as) return null;
  const [, left, right] = as as unknown as [string, string, string];
  const target = right.trim().toLowerCase();

  if (target === 'timespan') {
    const span = readSpan(left, o);
    return span ? decomposeSeconds(span.seconds) : null;
  }

  if (target === 'laptime') {
    const span = readSpan(left, o);
    return span ? decomposeSeconds(span.seconds).as('lap') : null;
  }

  if (target === 'timestamp' || target === 'unix' || target === 'epoch') {
    const moment = readMoment(left, o);
    // Through `trueInstant`, not the moment's own getTime: with a zone set the
    // moment was built in wall-clock space, and a timestamp is the one answer
    // that must be the real instant rather than the displayed one.
    return moment
      ? new TemporalNumber(Math.round(trueInstant(moment, o).getTime() / 1000))
      : null;
  }

  if (target === 'iso8601' || target === 'iso') {
    const moment = readMoment(left, o);
    return moment ? isoString(moment, o) : null;
  }

  if (target === 'date' || target === 'a date') {
    const stamp = /^[\d.]+$/.exec(left.trim().replace(/,/g, ''));
    if (stamp) {
      const value = Number(stamp[0]);
      // 13 digits is milliseconds, 10 is seconds.
      const ms = value > 1e11 ? value : value * 1000;
      // A timestamp is an absolute instant, so it renders through the space's
      // zone rather than being shifted into wall-clock space like a date is.
      return new CalendarDate(new Date(ms), 'second', o.zone ?? undefined, 'datetime');
    }
    const moment = readMoment(left, o);
    return moment ? moment.displayedAs('datetime') : null;
  }

  // "12.5 minutes in minutes and seconds"
  const pair = /^(\w+)\s+and\s+(\w+)$/.exec(target);
  if (pair) {
    const span = readSpan(left, o);
    const big = toSpanUnit(pair[1]!);
    const small = toSpanUnit(pair[2]!);
    if (span && big && small) return splitInto(span.seconds, big, small);
  }

  // "10 March to 17 March in workdays"
  if (/^(?:workdays?|weekdays?|business\s+days?)$/.test(target)) {
    const between = readRange(left, o);
    if (between) {
      return Timespan.of(
        countWorkdays(between[0].date, between[1].date, o.holidays),
        'workday',
      );
    }
  }

  const unit = toSpanUnit(target);
  if (unit) {
    const between = readRange(left, o);
    if (between) return inUnit(between[0], between[1], unit, o);
    const span = readSpan(left, o);
    if (span) return Timespan.of(round(span.seconds / secondsIn(unit), 6), unit);
  }

  return null;
}

function splitInto(seconds: number, big: SpanUnit, small: SpanUnit): Timespan {
  const bigWhole = Math.floor(seconds / secondsIn(big));
  const rest = seconds - bigWhole * secondsIn(big);
  return new Timespan([
    { value: bigWhole, unit: big },
    { value: round(rest / secondsIn(small), 3), unit: small },
  ]);
}

/* ------------------------------------------------------------------ *
 * Time zones
 * ------------------------------------------------------------------ */

function zoneQuery(s: string, o: TemporalOptions): TemporalValue | null {
  const difference =
    /^(?:time\s+)?difference\s+between\s+(.+?)\s+(?:and|&)\s+(.+?)\s*$/i.exec(s);
  if (difference) {
    const a = resolveZone(difference[1]!);
    const b = resolveZone(difference[2]!);
    if (a && b) {
      const minutes = zoneOffsetMinutes(o.now, b) - zoneOffsetMinutes(o.now, a);
      return hoursAndMinutes(minutes * 60);
    }
  }

  // "6pm Sydney in Chicago" / "2am PST to GMT" — the same instant, elsewhere.
  const moved = /^(.+?)\s+(?:to|in)\s+([A-Za-z][A-Za-z\s+\-0-9]*)$/i.exec(s);
  if (moved) {
    const zone = resolveZone(moved[2]!);
    const moment = parseMoment(moved[1]!, wall(o));
    if (zone && moment) {
      return new CalendarDate(moment.date, 'minute', zone, 'time');
    }
  }

  const timeIn = /^(?:the\s+)?(time|date)\s+in\s+(.+?)\s*$/i.exec(s);
  if (timeIn) {
    const zone = resolveZone(timeIn[2]!);
    if (zone) return zonedNow(zone, o, timeIn[1]!.toLowerCase() === 'date' ? 'date' : 'time');
  }

  const placeTime = /^(.+?)\s+(time|date)\s*$/i.exec(s);
  if (placeTime) {
    const zone = resolveZone(placeTime[1]!);
    if (zone) return zonedNow(zone, o, placeTime[2]!.toLowerCase() === 'date' ? 'date' : 'time');
  }

  return null;
}

/** The wall clock in a zone right now, as a moment that renders in that zone. */
function zonedNow(zone: string, o: TemporalOptions, showAs: 'time' | 'date'): CalendarDate {
  return new CalendarDate(o.now, 'minute', zone, showAs);
}

/* ------------------------------------------------------------------ *
 * Countdowns, facts and intervals
 * ------------------------------------------------------------------ */

function countdown(s: string, o: TemporalOptions): TemporalValue | null {
  const m = new RegExp(
    String.raw`^(${SPAN_UNIT_PATTERN})\s+(until|till|to|since|from)\s+(.+)$`,
    'i',
  ).exec(s);
  if (!m) return null;

  const unit = toSpanUnit(m[1]!);
  const target = readMoment(m[3]!, o);
  if (!unit || !target) return null;

  const backwards = /since|from/i.test(m[2]!);
  const [from, to] = backwards
    ? [target, new CalendarDate(wall(o))]
    : [new CalendarDate(wall(o)), target];
  return inUnit(from, to, unit, o);
}

function calendarFacts(s: string, o: TemporalOptions): TemporalValue | null {
  if (/^current\s+timestamp$/i.test(s)) {
    return new TemporalNumber(Math.round(o.now.getTime() / 1000));
  }

  if (/^week\s+(?:of\s+(?:the\s+)?year|number)$/i.test(s)) {
    return new TemporalNumber(weekNumber(wall(o)));
  }

  const weekOn = /^week\s+number\s+(?:on|of|for)\s+(.+)$/i.exec(s);
  if (weekOn) {
    const date = parseDate(weekOn[1]!, wall(o));
    if (date) return new TemporalNumber(weekNumber(date.date));
  }

  const dow = new RegExp(
    String.raw`^(?:day\s+of\s+the\s+week|weekday|day)\s+(?:on|of|for)\s+(.+)$`,
    'i',
  ).exec(s);
  if (dow) {
    const date = parseDate(dow[1]!, wall(o));
    if (date) return WEEKDAY_NAMES[date.date.getDay()] ?? null;
  }

  const quarter = /^days\s+in\s+q([1-4])(?:\s+(\d{4}))?$/i.exec(s);
  if (quarter) {
    const year = quarter[2] ? Number(quarter[2]) : wall(o).getFullYear();
    return Timespan.of(daysInQuarter(year, Number(quarter[1])), 'day');
  }

  const inMonth = new RegExp(`^days\\s+in\\s+(${MONTH_PATTERN})(?:\\s+(\\d{4}))?$`, 'i').exec(s);
  if (inMonth) {
    const anchor = parseDate(`${inMonth[1]} 1${inMonth[2] ? ` ${inMonth[2]}` : ''}`, wall(o));
    if (anchor) {
      return Timespan.of(
        daysInMonth(anchor.date.getFullYear(), anchor.date.getMonth()),
        'day',
      );
    }
  }

  const workdaysIn = new RegExp(
    String.raw`^(?:workdays?|weekdays?|business\s+days?)\s+in\s+(.+)$`,
    'i',
  ).exec(s);
  if (workdaysIn) {
    const span = parseSpan(workdaysIn[1]!);
    if (span) {
      const end = addDays(startOfDay(wall(o)), Math.round(span.seconds / 86_400));
      return Timespan.of(countWorkdays(startOfDay(wall(o)), end, o.holidays), 'workday');
    }
  }

  const workdaysFrom = new RegExp(
    String.raw`^(?:workdays?|weekdays?|business\s+days?)\s+(?:from|between)\s+(.+?)\s+(?:to|and|until)\s+(.+)$`,
    'i',
  ).exec(s);
  if (workdaysFrom) {
    const from = parseDate(workdaysFrom[1]!, wall(o));
    const to = parseDate(workdaysFrom[2]!, wall(o));
    if (from && to) {
      return Timespan.of(countWorkdays(from.date, to.date, o.holidays), 'workday');
    }
  }

  const mid = /^(?:mid ?point|halfway)\s+between\s+(.+?)\s+and\s+(.+)$/i.exec(s);
  if (mid) {
    const a = readMoment(mid[1]!, o);
    const b = readMoment(mid[2]!, o);
    if (a && b) return midpoint(a, b);
  }

  return null;
}

function interval(s: string, o: TemporalOptions): TemporalValue | null {
  const days = /^days\s+between\s+(.+?)\s+and\s+(.+)$/i.exec(s);
  if (days) {
    const a = parseDate(days[1]!, wall(o));
    const b = parseDate(days[2]!, wall(o));
    if (a && b) return Timespan.of(Math.abs(diffInDays(a.date, b.date)), 'day');
  }

  const through = /^(.+?)\s+through\s+(.+?)(?:\s+in\s+days)?\s*$/i.exec(s);
  if (through) {
    const a = parseDate(through[1]!, wall(o));
    const b = parseDate(through[2]!, wall(o));
    // "through" includes both endpoints, so April 1 through April 30 is 30 days.
    if (a && b) return Timespan.of(Math.abs(diffInDays(a.date, b.date)) + 1, 'day');
  }

  const range = readRange(s, o);
  if (range) return between(range[0], range[1]);

  return null;
}

/** `A to B`, for dates, moments or zones. */
function readRange(s: string, o: TemporalOptions): [CalendarDate, CalendarDate] | null {
  const to = /^(.+?)\s+(?:to|until|till)\s+(.+?)\s*$/i.exec(s);
  if (to) {
    const a = readMoment(to[1]!, o);
    const bZone = resolveZone(to[2]!);
    // "6pm Sydney in Chicago" — the right side names a zone, not a moment.
    if (a && bZone) {
      return [a, new CalendarDate(a.date, 'minute', bZone, 'time')];
    }
    const b = readMoment(to[2]!, o);
    if (a && b) return [a, b];
  }
  return null;
}

/**
 * `A - B` between two moments.
 *
 * The minus sign is genuinely ambiguous between a range and a subtraction, as
 * Soulver's documentation acknowledges. Both readings produce a duration, so
 * the absolute difference is the honest answer either way.
 */
function between(a: CalendarDate, b: CalendarDate): TemporalValue {
  if (b.zone && !a.zone) return b;
  // An interval is a magnitude: which endpoint was typed first does not
  // change how long it is.
  if (!a.hasTime && !b.hasTime && b.date < a.date) [a, b] = [b, a];
  if (a.hasTime && b.hasTime) {
    let seconds = diffInSeconds(a.date, b.date);
    // Clock times with no date wrap to the next day rather than going negative.
    if (seconds < 0) seconds += 86_400;
    return hoursAndMinutes(seconds);
  }
  return spanBetween(a.date, b.date);
}

/* ------------------------------------------------------------------ *
 * Offsets
 * ------------------------------------------------------------------ */

function offsetExpression(s: string, o: TemporalOptions): TemporalValue | null {
  // "3 weeks after March 14" / "28 days before March 12"
  const relative = new RegExp(`^(.+?)\\s+(after|before|from|ago)\\b\\s*(.*)$`, 'i').exec(s);
  if (relative) {
    const span = parseSpan(relative[1]!);
    const word = relative[2]!.toLowerCase();
    const anchorText = relative[3]!.trim();
    if (span) {
      const sign = word === 'before' || word === 'ago' ? -1 : 1;
      const anchor =
        anchorText === '' || /^now$/i.test(anchorText)
          ? new CalendarDate(word === 'ago' || word === 'from' ? startOfDay(wall(o)) : wall(o))
          : readMoment(anchorText, o);
      if (anchor) return applySpan(anchor, span, sign, o);
    }
  }

  // "today + 3 weeks", "April 1, 2019 − 3 months 5 days"
  // Whitespace on both sides is required, otherwise the dashes inside
  // `2026-01-31` would be read as subtraction.
  const signed = /^(.+?)\s+([+-])\s+(.+)$/.exec(s);
  if (signed) {
    const anchor = readMoment(signed[1]!, o);
    const span = parseSpan(signed[3]!);
    if (anchor && span) {
      return applySpan(anchor, span, signed[2] === '-' ? -1 : 1, o);
    }
    // Two moments with a minus between them is an interval.
    if (anchor && signed[2] === '-') {
      const other = readMoment(signed[3]!, o);
      if (other) return between(anchor, other);
    }
  }

  return null;
}

function applySpan(
  anchor: CalendarDate,
  span: Timespan,
  sign: number,
  o: TemporalOptions,
): CalendarDate {
  let date = new Date(anchor.date.getTime());
  let precision = anchor.precision;

  for (const part of span.parts) {
    const amount = part.value * sign;
    switch (part.unit) {
      case 'year': date = addMonths(date, amount * 12); break;
      case 'month': date = addMonths(date, amount); break;
      case 'week': date = addDays(date, amount * 7); break;
      case 'day': date = addDays(date, amount); break;
      case 'workday': date = addWorkdays(date, amount, o.holidays); break;
      case 'hour':
        date = new Date(date.getTime() + amount * 3_600_000);
        precision = 'minute';
        break;
      case 'minute':
        date = new Date(date.getTime() + amount * 60_000);
        precision = 'minute';
        break;
      case 'second':
        date = new Date(date.getTime() + amount * 1000);
        precision = 'second';
        break;
      default: break;
    }
  }

  return new CalendarDate(date, precision, anchor.zone, anchor.showAs);
}

function bareMoment(s: string, o: TemporalOptions): TemporalValue | null {
  const moment = readMoment(s, o);
  if (moment) return moment;
  const span = parseSpan(s);
  return span && /^\s*\d/.test(s) ? span : null;
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

function readMoment(text: string, o: TemporalOptions): CalendarDate | null {
  return parseDate(text, wall(o)) ?? parseMoment(text, wall(o));
}

/** A written span, or the duration implied by a range. */
function readSpan(text: string, o: TemporalOptions): Timespan | null {
  const lap = parseLaptime(text.trim());
  if (lap) return lap;
  const span = parseSpan(text);
  if (span) return span;
  const range = readRange(text, o);
  if (range) {
    return Timespan.of(diffInSeconds(range[0].date, range[1].date), 'second');
  }
  return null;
}

function inUnit(
  from: CalendarDate,
  to: CalendarDate,
  unit: SpanUnit,
  o: TemporalOptions,
): Timespan {
  if (unit === 'workday') {
    return Timespan.of(countWorkdays(from.date, to.date, o.holidays), 'workday');
  }
  if (unit === 'day') {
    return Timespan.of(diffInDays(from.date, to.date), 'day');
  }
  const seconds = diffInSeconds(startOfDay(from.date), startOfDay(to.date));
  return Timespan.of(round(seconds / secondsIn(unit), 2), unit);
}

/**
 * ISO 8601, carrying the offset of whichever zone the moment belongs to.
 *
 * Without a zone that is the reader's own, exactly as before. With one, the
 * offset has to come from that zone at that instant rather than from the
 * browser — writing Berlin's wall clock against a Los Angeles offset would name
 * a different moment entirely.
 */
function isoString(moment: CalendarDate, o: TemporalOptions): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const zone = moment.zone ?? o.zone;

  if (!zone) {
    const d = moment.date;
    const offset = -d.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const abs = Math.abs(offset);
    return (
      `${isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
      `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
    );
  }

  const at = trueInstant(moment, o);
  const f = wallClockIn(at, zone);
  const offset = zoneOffsetMinutes(at, zone);
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${f.year}-${pad(f.month + 1)}-${pad(f.day)}` +
    `T${pad(f.hour)}:${pad(f.minute)}:${pad(at.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export { wallClockIn };
