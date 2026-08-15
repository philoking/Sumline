/**
 * Temporal value types.
 *
 * Soulver's date and time handling is the part that separates a notepad
 * calculator from a calculator, and math.js has no calendar type at all — so
 * everything here is built from scratch and evaluated before the expression
 * parser is ever reached.
 */

/** How much of a moment is meaningful: a whole day, or a time within it. */
export type Precision = 'day' | 'minute' | 'second';

/** Which parts of a moment to show, when it differs from its precision. */
export type MomentDisplay = 'auto' | 'time' | 'date' | 'datetime';

/** A point in time. `zone` is set only when the user named one. */
export class CalendarDate {
  constructor(
    readonly date: Date,
    readonly precision: Precision = 'day',
    readonly zone?: string,
    readonly showAs: MomentDisplay = 'auto',
  ) {}

  get hasTime(): boolean {
    return this.precision !== 'day';
  }

  with(date: Date): CalendarDate {
    return new CalendarDate(date, this.precision, this.zone, this.showAs);
  }

  displayedAs(showAs: MomentDisplay): CalendarDate {
    return new CalendarDate(this.date, this.precision, this.zone, showAs);
  }

  get iso(): string {
    const y = this.date.getFullYear();
    const m = String(this.date.getMonth() + 1).padStart(2, '0');
    const d = String(this.date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
}

export type SpanUnit =
  | 'year'
  | 'month'
  | 'week'
  | 'day'
  | 'workday'
  | 'hour'
  | 'minute'
  | 'second'
  | 'frame';

export interface SpanPart {
  value: number;
  unit: SpanUnit;
}

/** Seconds in one of each unit, for units that have a fixed size. */
export const UNIT_SECONDS: Record<SpanUnit, number> = {
  year: 365.2425 * 86_400,
  month: 30.436875 * 86_400,
  week: 7 * 86_400,
  day: 86_400,
  workday: 86_400,
  hour: 3_600,
  minute: 60,
  second: 1,
  frame: 0,
};

/** How a span should be written out. */
export type SpanDisplay = 'span' | 'lap' | 'plain';

/**
 * A quantity of time, possibly with several components.
 *
 * `3 weeks 5 days` and `00:05:30` are the same kind of thing shown two ways,
 * so the display style travels with the value rather than being decided by
 * whichever code happens to render it.
 */
export class Timespan {
  constructor(
    readonly parts: SpanPart[],
    readonly display: SpanDisplay = 'span',
  ) {}

  /** Total length in seconds, using nominal sizes for months and years. */
  get seconds(): number {
    return this.parts.reduce(
      (total, part) => total + part.value * UNIT_SECONDS[part.unit],
      0,
    );
  }

  as(display: SpanDisplay): Timespan {
    return new Timespan(this.parts, display);
  }

  static of(value: number, unit: SpanUnit, display: SpanDisplay = 'plain'): Timespan {
    return new Timespan([{ value, unit }], display);
  }
}

/** A video timecode: a whole number of frames at a given frame rate. */
export class Timecode {
  constructor(
    readonly frames: number,
    readonly fps: number,
  ) {}

  get seconds(): number {
    return this.frames / this.fps;
  }
}

/**
 * A number that identifies something rather than measuring it: a Unix
 * timestamp, a week number.
 *
 * Kept distinct from a plain number so the sheet total ignores it. Adding a
 * timestamp to a column of prices produces a figure that means nothing, and
 * the total is more useful when it quietly leaves such answers out.
 */
export class TemporalNumber {
  constructor(readonly value: number) {}
}

/** A count of frames, which is a quantity rather than a position. */
export class FrameCount {
  constructor(readonly frames: number) {}
}

export function isCalendarDate(v: unknown): v is CalendarDate {
  return v instanceof CalendarDate;
}

export function isTimespan(v: unknown): v is Timespan {
  return v instanceof Timespan;
}

export function isTimecode(v: unknown): v is Timecode {
  return v instanceof Timecode;
}

/**
 * Splits a fixed quantity of seconds into components.
 *
 * Months and years are deliberately excluded: they have no fixed length, so
 * `72 days as timespan` reads `10 weeks 2 days` rather than an approximate
 * `2 months 11 days`. Calendar differences use `spanBetween` instead, which
 * can be exact because it knows the two endpoints.
 */
export function decomposeSeconds(totalSeconds: number): Timespan {
  const order: SpanUnit[] = ['week', 'day', 'hour', 'minute', 'second'];
  const parts: SpanPart[] = [];
  let remaining = Math.abs(totalSeconds);
  const sign = totalSeconds < 0 ? -1 : 1;

  for (const unit of order) {
    const size = UNIT_SECONDS[unit];
    const whole = unit === 'second' ? round(remaining, 3) : Math.floor(remaining / size);
    if (whole > 0) parts.push({ value: whole * sign, unit });
    if (unit !== 'second') remaining -= whole * size;
  }

  return parts.length > 0 ? new Timespan(parts) : new Timespan([{ value: 0, unit: 'second' }]);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
