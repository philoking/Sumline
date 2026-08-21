import { CalendarDate, FrameCount, Timecode, Timespan, type SpanPart } from './types.js';
import { diffInDays, startOfDay } from './calendar.js';
import { wallClockIn } from './zones.js';

const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * Renders a moment.
 *
 * A moment carried in another zone is shown on that zone's wall clock, and
 * labelled relative to the reader's own day — a Tokyo answer that lands on the
 * following morning reads "Tomorrow at 12:30 am", which is the fact the reader
 * actually wanted.
 */
export function formatMoment(moment: CalendarDate, now: Date): string {
  const local = moment.zone
    ? zonedFields(moment)
    : {
        year: moment.date.getFullYear(),
        month: moment.date.getMonth(),
        day: moment.date.getDate(),
        hour: moment.date.getHours(),
        minute: moment.date.getMinutes(),
        weekday: moment.date.getDay(),
      };

  const showTime =
    moment.showAs === 'time' || (moment.showAs === 'auto' && moment.hasTime);
  const showDate = moment.showAs !== 'time';
  const time = `${clock(local.hour, local.minute)}`;
  const date = `${SHORT_WEEKDAYS[local.weekday]} ${local.day} ${SHORT_MONTHS[local.month]} ${local.year}`;

  if (moment.showAs === 'datetime')
    return `${local.day} ${SHORT_MONTHS[local.month]} ${local.year} at ${time}`;
  if (showTime && !showDate) return relativeDayPrefix(now, local) + time;
  if (showTime && moment.hasTime) return `${date} at ${time}`;
  return date;
}

/** "Tomorrow at …" when a zoned time falls on a different day than ours. */
function relativeDayPrefix(
  now: Date,
  local: { year: number; month: number; day: number },
): string {
  const there = new Date(local.year, local.month, local.day);
  const delta = diffInDays(startOfDay(now), there);
  if (delta === 1) return 'Tomorrow at ';
  if (delta === -1) return 'Yesterday at ';
  return '';
}

function zonedFields(moment: CalendarDate): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
} {
  const fields = wallClockIn(moment.date, moment.zone!);
  const asLocal = new Date(fields.year, fields.month, fields.day);
  return { ...fields, weekday: asLocal.getDay() };
}

function clock(hour: number, minute: number): string {
  const suffix = hour < 12 ? 'am' : 'pm';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/** Renders a duration as a span, a laptime, or a bare quantity. */
export function formatTimespan(
  span: Timespan,
  formatNumber: (n: number) => string,
): string {
  if (span.display === 'lap') return laptime(span.seconds);

  const parts = span.parts.filter((part) => part.value !== 0);
  if (parts.length === 0) {
    const [first] = span.parts;
    return first ? `0 ${plural(first.unit, 0)}` : '0 seconds';
  }

  return parts
    .map((part) => `${formatNumber(part.value)} ${plural(part.unit, part.value)}`)
    .join(' ');
}

function laptime(totalSeconds: number): string {
  const sign = totalSeconds < 0 ? '-' : '';
  const abs = Math.abs(totalSeconds);
  const hours = Math.floor(abs / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  const seconds = abs % 60;
  const whole = Math.floor(seconds);
  const fraction = round(seconds - whole, 3);
  const fractionText = fraction > 0 ? String(fraction).slice(1) : '';
  return `${sign}${pad(hours)}:${pad(minutes)}:${pad(whole)}${fractionText}`;
}

export function formatTimecode(code: Timecode): string {
  const totalFrames = Math.round(code.frames);
  const frames = totalFrames % Math.round(code.fps);
  const totalSeconds = Math.floor(totalFrames / code.fps);
  return [
    pad(Math.floor(totalSeconds / 3600)),
    pad(Math.floor((totalSeconds % 3600) / 60)),
    pad(totalSeconds % 60),
    pad(frames),
  ].join(':');
}

export function formatFrameCount(
  count: FrameCount,
  formatNumber: (n: number) => string,
): string {
  return `${formatNumber(count.frames)} frames`;
}

function plural(unit: SpanPart['unit'], value: number): string {
  return Math.abs(value) === 1 ? unit : `${unit}s`;
}

function pad(value: number): string {
  return String(Math.abs(value)).padStart(2, '0');
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
