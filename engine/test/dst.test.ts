import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/index.js';
import { SUPPORTED_ZONES } from '../src/temporal/zones.js';

/**
 * Daylight saving, tested against an oracle rather than against dates picked
 * by hand.
 *
 * Temporal is the engine's highest-risk surface and the one where written-down
 * expectations age worst: a hand-chosen date passes for years and then breaks
 * on a rule change nobody modelled, and the failure arrives as a wrong answer
 * rather than an error — `today` resolving to yesterday for a reader in a zone
 * the test set never named.
 *
 * So the transitions are generated. `Intl.DateTimeFormat` is walked across the
 * year for every zone the app supports, and each offset change is bisected to
 * the minute. A zone whose rules change is covered the next time this runs,
 * and a zone added to the tables in `zones.ts` is covered without anybody
 * remembering to add it here.
 *
 * The offset reader below is deliberately its own, rather than
 * `zoneOffsetMinutes` from the source: an oracle that shares its implementation
 * with the thing it is checking agrees with it about the bugs too.
 */
const YEAR = 2026;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  const existing = formatters.get(zone);
  if (existing) return existing;
  const made = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatters.set(zone, made);
  return made;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** What a zone's clock reads at an instant, straight from `Intl`. */
function wallClock(at: Date, zone: string): WallClock {
  const parts = formatterFor(zone).formatToParts(at);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % 24,
    minute: read('minute'),
  };
}

/** Minutes the zone is ahead of UTC at that instant. */
function offsetMinutes(at: Date, zone: string): number {
  const clock = wallClock(at, zone);
  const parts = formatterFor(zone).formatToParts(at);
  const seconds = Number(parts.find((part) => part.type === 'second')?.value ?? '0');
  const asUtc = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute,
    seconds,
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

interface Transition {
  zone: string;
  /** The first instant on the new offset, to the minute. */
  at: Date;
  before: number;
  after: number;
}

/**
 * Every offset change a zone makes in the year, found by scanning and then
 * bisecting the day it changed on.
 *
 * A day at a time rather than an hour: 76 zones across a year is 28,000 reads
 * this way and 666,000 the other, for the same answer.
 */
function transitionsIn(zone: string, year: number): Transition[] {
  const found: Transition[] = [];
  const start = Date.UTC(year, 0, 1);
  let previous = offsetMinutes(new Date(start), zone);

  for (let day = 1; day <= 366; day += 1) {
    const at = new Date(start + day * 86_400_000);
    const current = offsetMinutes(at, zone);
    if (current === previous) continue;

    let low = at.getTime() - 86_400_000;
    let high = at.getTime();
    while (high - low > 60_000) {
      const mid = low + Math.floor((high - low) / 2 / 60_000) * 60_000;
      if (mid === low) break;
      if (offsetMinutes(new Date(mid), zone) === previous) low = mid;
      else high = mid;
    }
    found.push({ zone, at: new Date(high), before: previous, after: current });
    previous = current;
  }
  return found;
}

const TRANSITIONS: Transition[] = SUPPORTED_ZONES.flatMap((zone) =>
  transitionsIn(zone, YEAR),
);

/** An instant at which the zone's clock reads the given date and time. */
function instantAt(zone: string, clock: WallClock): Date {
  const naive = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute);
  let stamp = naive - offsetMinutes(new Date(naive), zone) * 60_000;
  stamp = naive - offsetMinutes(new Date(stamp), zone) * 60_000;
  return new Date(stamp);
}

/** Whether a zone's clock ever reads that time — false in a spring-forward gap. */
function timeExists(zone: string, clock: WallClock): boolean {
  const shown = wallClock(instantAt(zone, clock), zone);
  return shown.hour === clock.hour && shown.minute === clock.minute && shown.day === clock.day;
}

/** `2026-03-08`, from the date part of a wall clock. */
const iso = (clock: Pick<WallClock, 'year' | 'month' | 'day'>): string =>
  `${clock.year}-${String(clock.month).padStart(2, '0')}-${String(clock.day).padStart(2, '0')}`;

/** The calendar date `days` away, done on the date alone so no zone is involved. */
function shiftDate(clock: WallClock, days: number): WallClock {
  const moved = new Date(Date.UTC(clock.year, clock.month - 1, clock.day + days));
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
    hour: clock.hour,
    minute: clock.minute,
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Reads `Sun 8 Mar 2026` and `Sun 8 Mar 2026 at 3:30 am` back apart. */
function readAnswer(output: string): (WallClock & { timed: boolean }) | null {
  const match = /^\w{3} (\d{1,2}) (\w{3}) (\d{4})(?: at (\d{1,2}):(\d{2}) (am|pm))?$/.exec(output);
  if (!match) return null;
  const month = MONTHS.indexOf(match[2]!) + 1;
  if (month === 0) return null;
  const hour12 = match[4] === undefined ? 0 : Number(match[4]);
  const pm = match[6] === 'pm';
  return {
    year: Number(match[3]),
    month,
    day: Number(match[1]),
    hour: match[4] === undefined ? 0 : (hour12 % 12) + (pm ? 12 : 0),
    minute: Number(match[5] ?? 0),
    timed: match[4] !== undefined,
  };
}

const answerIn = (zone: string, now: Date, line: string): string =>
  createEngine({ zone, now }).evaluate(line)[0]?.output ?? '';

describe('the transitions themselves', () => {
  it('finds them where they are and not where they are not', () => {
    // The oracle checked against what everyone knows, so the properties below
    // cannot pass by having generated nothing.
    const zonesWithDst = new Set(TRANSITIONS.map((t) => t.zone));
    expect(zonesWithDst.size).toBeGreaterThan(25);
    expect(TRANSITIONS.length).toBeGreaterThan(50);

    for (const zone of ['Europe/London', 'America/New_York', 'Australia/Sydney']) {
      expect(TRANSITIONS.filter((t) => t.zone === zone), zone).toHaveLength(2);
    }
    for (const zone of ['UTC', 'Asia/Tokyo', 'Asia/Kolkata']) {
      expect(TRANSITIONS.filter((t) => t.zone === zone), zone).toHaveLength(0);
    }
  });

  it('moves the clock by a whole number of minutes, one way then back', () => {
    const odd = TRANSITIONS.filter((t) => Math.abs(t.after - t.before) < 15);
    expect(odd).toEqual([]);
  });
});

describe('a calendar day across a transition', () => {
  it('is still one day', () => {
    // The failure this is written against is the quiet one: an hour lost or
    // gained turning `+ 1 day` into the same date or the one after next.
    const wrong: string[] = [];
    for (const { zone, at } of TRANSITIONS) {
      const onTheDay = wallClock(at, zone);
      const dayBefore = shiftDate(onTheDay, -1);
      // Noon, so the reading is nowhere near either side of midnight.
      const now = instantAt(zone, { ...dayBefore, hour: 12, minute: 0 });
      const answered = readAnswer(answerIn(zone, now, 'today + 1 day'));
      if (!answered || iso(answered) !== iso(onTheDay)) {
        wrong.push(`${zone} ${iso(dayBefore)} + 1 day -> ${answerIn(zone, now, 'today + 1 day')}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('counts the days between two dates the way the calendar does', () => {
    const wrong: string[] = [];
    for (const { zone, at } of TRANSITIONS) {
      const onTheDay = wallClock(at, zone);
      const from = iso(shiftDate(onTheDay, -1));
      const to = iso(shiftDate(onTheDay, 1));
      const now = instantAt(zone, { ...onTheDay, hour: 12, minute: 0 });
      const forwards = answerIn(zone, now, `days between ${from} and ${to}`);
      const backwards = answerIn(zone, now, `days between ${to} and ${from}`);
      // Two days, from either end. A transition inside the range must not
      // round it to 1 or stretch it to 3.
      if (forwards !== '2 days' || backwards !== '2 days') {
        wrong.push(`${zone} ${from}..${to} -> ${forwards} / ${backwards}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('counts workdays across one the way it counts them anywhere', () => {
    const wrong: string[] = [];
    for (const { zone, at } of TRANSITIONS) {
      const onTheDay = wallClock(at, zone);
      const from = shiftDate(onTheDay, -3);
      const to = shiftDate(onTheDay, 4);
      const now = instantAt(zone, { ...onTheDay, hour: 12, minute: 0 });
      const answered = answerIn(zone, now, `${iso(from)} to ${iso(to)} in workdays`);

      // The oracle: count the weekdays in the same span, on plain UTC dates,
      // where no zone and no transition can reach.
      let expected = 0;
      for (let day = 1; day <= 7; day += 1) {
        const date = new Date(Date.UTC(from.year, from.month - 1, from.day + day));
        const weekday = date.getUTCDay();
        if (weekday !== 0 && weekday !== 6) expected += 1;
      }
      if (answered !== `${expected} workdays`) {
        wrong.push(`${zone} ${iso(from)}..${iso(to)} -> ${answered}, want ${expected}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe('what a zone must never move, across a transition', () => {
  it('leaves the timestamp of an instant alone', () => {
    // Restated from `zone.test.ts` as a property: a timestamp is an instant,
    // and no zone setting may change which instant it is — least of all at the
    // moment the offset moves.
    const wrong: string[] = [];
    for (const { zone, at } of TRANSITIONS.slice(0, 40)) {
      const here = createEngine({ now: at }).evaluate('current timestamp')[0]?.output;
      const there = createEngine({ zone, now: at }).evaluate('current timestamp')[0]?.output;
      if (here !== there) wrong.push(`${zone} at ${at.toISOString()}: ${here} vs ${there}`);
    }
    expect(wrong).toEqual([]);
  });
});

/*
 * The wall clock a transition creates or repeats.
 *
 * 02:30 does not exist on a spring-forward morning and 01:30 happens twice on
 * a fall-back one. Whatever the engine does there should be a decision written
 * down, rather than whatever falls out of the arithmetic — which is what these
 * pin.
 */
describe('a time the clock skipped', () => {
  it('answers a time that exists, rather than one that does not', () => {
    const wrong: string[] = [];
    for (const { zone, at, before, after } of TRANSITIONS) {
      if (after <= before) continue; // Only the springs forward skip anything.
      const gap = wallClock(new Date(at.getTime() - 60_000), zone);
      // Half an hour past the last minute of the old offset is inside the gap
      // for every transition of an hour or more.
      const skipped = { ...gap, minute: 30 };
      if (timeExists(zone, skipped)) continue;

      const now = instantAt(zone, { ...gap, hour: 12, minute: 0 });
      const line = `${iso(skipped)} ${String(skipped.hour).padStart(2, '0')}:30`;
      const answered = readAnswer(answerIn(zone, now, line));
      if (!answered?.timed) {
        wrong.push(`${zone} ${line} -> ${answerIn(zone, now, line)}`);
        continue;
      }
      if (!timeExists(zone, answered)) {
        wrong.push(`${zone} ${line} -> ${answerIn(zone, now, line)}, which does not exist`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('moves it forward into the hour the clock jumped to', () => {
    // The decision, on the transition everyone recognises: 2:30 am on the
    // second Sunday in March in New York is answered as 3:30 am, not 1:30.
    const now = new Date(Date.UTC(2026, 2, 1, 12));
    expect(answerIn('America/New_York', now, '2026-03-08 02:30')).toBe(
      'Sun 8 Mar 2026 at 3:30 am',
    );
    // And the hours either side of the gap are left where they were written.
    expect(answerIn('America/New_York', now, '2026-03-08 01:30')).toBe(
      'Sun 8 Mar 2026 at 1:30 am',
    );
    expect(answerIn('America/New_York', now, '2026-03-08 03:30')).toBe(
      'Sun 8 Mar 2026 at 3:30 am',
    );
  });

  it('takes the first of the two readings of a repeated hour', () => {
    const now = new Date(Date.UTC(2026, 10, 1, 12));
    expect(answerIn('America/New_York', now, '2026-11-01 01:30')).toBe(
      'Sun 1 Nov 2026 at 1:30 am',
    );
  });
});

describe('a duration spanning a transition', () => {
  /*
   * The distinction worth keeping: a *day* is a calendar day and a *duration*
   * is an amount of time. The day the clocks go forward is 23 hours long, so
   * midnight plus twenty-four hours is 1 am the next day — and the day the
   * clocks go back is 25 hours long, so the same sum lands at 11 pm the same
   * evening. Both are right, and both would look like bugs to anyone who
   * expected `+ 24 hours` and `+ 1 day` to be the same thing.
   */
  const march = new Date(Date.UTC(2026, 2, 1, 12));
  const november = new Date(Date.UTC(2026, 10, 1, 12));

  it('is an amount of time, not a calendar day', () => {
    expect(answerIn('America/New_York', march, '2026-03-08 00:00 + 24 hours')).toBe(
      'Mon 9 Mar 2026 at 1:00 am',
    );
    expect(answerIn('America/New_York', november, '2026-11-01 00:00 + 24 hours')).toBe(
      'Sun 1 Nov 2026 at 11:00 pm',
    );
  });

  it('while a day stays a day', () => {
    expect(answerIn('America/New_York', march, '2026-03-07 + 1 day')).toBe('Sun 8 Mar 2026');
    expect(answerIn('America/New_York', november, '2026-10-31 + 1 day')).toBe('Sun 1 Nov 2026');
  });
});
