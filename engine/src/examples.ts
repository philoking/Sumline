import type { RateTable } from './types.js';

/**
 * Worked examples of everything the engine understands.
 *
 * This is the single source for both the golden tests and the in-app
 * reference. Documentation written separately from tests goes stale within a
 * release or two; here an example cannot claim something the engine does not
 * do, because `examples.test.ts` runs every line in this file and asserts the
 * answer shown.
 *
 * Adding an entry therefore means adding a test. That is the point.
 */

export interface Example {
  input: string;
  expected: string;
}

export interface ExampleGroup {
  id: string;
  title: string;
  blurb: string;
  /** Shown alongside the group when its answers depend on the date. */
  note?: string;
  examples: Example[];
}

/**
 * The fixed context every example is evaluated against.
 *
 * Rates and "now" are pinned so date and currency answers are reproducible.
 * The figures are realistic but arbitrary.
 */
export const REFERENCE_RATES: RateTable = {
  base: 'USD',
  date: '2026-08-14',
  rates: { EUR: 0.8, GBP: 0.75, JPY: 160, CAD: 1.25, AUD: 1.5, CHF: 0.9 },
};

/**
 * A pinned past table, for the historical-conversion examples.
 *
 * Its `date` deliberately differs from the date the examples ask about: 1 January
 * is a holiday, so the provider answers with the last published day before it,
 * and the reference should show the behaviour rather than a tidied version of it.
 */
export const REFERENCE_HISTORICAL_RATES = {
  '2020-01-01': {
    base: 'USD',
    date: '2019-12-31',
    rates: { EUR: 0.89, GBP: 0.755, JPY: 108.6 },
  } satisfies RateTable,
};

/** Saturday 15 August 2026, midday. */
export const REFERENCE_NOW = new Date(2026, 7, 15, 12, 0, 0);

/** A handful of 2026 US public holidays, for the workday examples. */
export const REFERENCE_HOLIDAYS = [
  '2026-01-01',
  '2026-05-25',
  '2026-07-03',
  '2026-12-25',
];

const DATE_NOTE = 'Answers are relative to Saturday 15 August 2026.';

export const EXAMPLE_GROUPS: ExampleGroup[] = [
  {
    id: 'arithmetic',
    title: 'Arithmetic',
    blurb: 'Ordinary maths, written the way you would say it.',
    examples: [
      { input: '2 + 2', expected: '4' },
      { input: '10 / 4', expected: '2.5' },
      { input: '2^10', expected: '1,024' },
      { input: '(3 + 4) * 5', expected: '35' },
      { input: 'sqrt(144)', expected: '12' },
      { input: '0.1 + 0.2', expected: '0.3' },
      { input: '1,234 + 1', expected: '1,235' },
      { input: '17 mod 5', expected: '2' },
      { input: 'max(1000, 2000)', expected: '2,000' },
      { input: '10 plus 5 times 2', expected: '20' },
      { input: '100 divided by 8', expected: '12.5' },
      { input: '3 to the power of 2', expected: '9' },
      { input: 'remainder of 21 divided by 5', expected: '1' },
      { input: 'what is 6 * 7?', expected: '42' },
      { input: '12 + 8 =', expected: '20' },
      { input: '6 × 7', expected: '42' },
      { input: '84 ÷ 2', expected: '42' },
      { input: '50 − 8', expected: '42' },
      { input: '2 ** 10', expected: '1,024' },
      { input: '√16', expected: '4' },
      { input: 'π', expected: '3.141593' },
    ],
  },
  {
    id: 'numbers',
    title: 'Numbers and notation',
    blurb:
      'Large numbers are abbreviated above 100,000. Currency never is. Add "in full" to any line to write it out.',
    examples: [
      { input: '5k + 500', expected: '5,500' },
      { input: '2 million / 4', expected: '500k' },
      { input: '3 billion', expected: '3G' },
      { input: '1234567 * 2', expected: '2.47M' },
      { input: '100,000 + 200,000', expected: '300k' },
      { input: '100,000 + 200,000 in full', expected: '300,000' },
      { input: '3 million + 10%', expected: '3.3M' },
      { input: '2M', expected: '2M' },
      { input: '3G', expected: '3G' },
      { input: '1.5T', expected: '1.5T' },
      { input: '$3k', expected: '$3,000.00' },
      { input: '$9bn', expected: '$9,000,000,000.00' },
      { input: '€6M', expected: '€6,000,000.00' },
      { input: '£12tn', expected: '£12,000,000,000,000.00' },
      { input: '1_000_000 + 2_000', expected: '1M' },
      { input: '1,700,000 as sci', expected: '1.7e6' },
    ],
  },
  {
    id: 'rounding',
    title: 'Rounding',
    blurb:
      '"to N dp" only changes how the answer looks; totals and references still use the full value. "to nearest N" changes the number itself.',
    examples: [
      { input: '1/3 to 2 dp', expected: '0.33' },
      { input: 'pi to 5 digits', expected: '3.14159' },
      { input: '5.5 rounded', expected: '6' },
      { input: '5.5 rounded up', expected: '6' },
      { input: '5.5 rounded down', expected: '5' },
      { input: '37 to nearest 10', expected: '40' },
      { input: '2,100 to nearest thousand', expected: '2,000' },
      { input: '$490 rounded to nearest hundred', expected: '$500.00' },
      { input: '21 rounded up to nearest 5', expected: '25' },
      { input: '17 rounded down to nearest 3', expected: '15' },
      { input: 'round(4.6)', expected: '5' },
      { input: 'ceil(4.1)', expected: '5' },
      { input: 'floor(4.9)', expected: '4' },
    ],
  },
  {
    id: 'functions',
    title: 'Named functions and constants',
    blurb:
      'math.js supplies these, so they are spelled the way it spells them rather than in the natural phrasing the rest of the engine accepts.',
    examples: [
      { input: 'log(100, 10)', expected: '2' },
      { input: 'log10(1000)', expected: '3' },
      { input: 'log2(1024)', expected: '10' },
      { input: 'exp(1)', expected: '2.718282' },
      { input: 'nthRoot(27, 3)', expected: '3' },
      { input: 'hypot(3, 4)', expected: '5' },
      { input: 'abs(-5)', expected: '5' },
      { input: 'sign(-3)', expected: '-1' },
      { input: 'square(4)', expected: '16' },
      { input: 'cube(3)', expected: '27' },
      { input: '5!', expected: '120' },
      { input: 'combinations(5, 2)', expected: '10' },
      { input: 'permutations(5, 2)', expected: '20' },
      { input: 'gcd(12, 18)', expected: '6' },
      { input: 'lcm(4, 6)', expected: '12' },
      { input: 'std(2, 4, 6)', expected: '2' },
      { input: 'variance(2, 4, 6)', expected: '4' },
      { input: 'e', expected: '2.718282' },
      { input: 'tau', expected: '6.283185' },
      { input: 'phi', expected: '1.618034' },
    ],
  },
  {
    id: 'trigonometry',
    title: 'Trigonometry',
    blurb:
      'Angles are radians unless you write "deg", which is an ordinary unit here — so it converts and composes like any other.',
    examples: [
      { input: 'sin(30 deg)', expected: '0.5' },
      { input: 'cos(60 deg)', expected: '0.5' },
      { input: 'tan(45 deg)', expected: '1' },
      { input: 'sin(90 deg)', expected: '1' },
      { input: 'sin(pi / 2)', expected: '1' },
      { input: 'cos(0)', expected: '1' },
      { input: 'asin(0.5)', expected: '0.523599' },
      { input: 'atan2(1, 1)', expected: '0.785398' },
      { input: '45 deg in rad', expected: '0.785398 rad' },
      { input: '90 deg to rad', expected: '1.570796 rad' },
    ],
  },
  {
    id: 'bases',
    title: 'Number bases and bitwise operators',
    blurb:
      'A literal in another base reads back as a decimal; the hex, bin and oct functions write one out. Note that "255 in hex" does not work — "in" is the unit conversion word.',
    examples: [
      { input: 'hex(255)', expected: '0xff' },
      { input: 'bin(5)', expected: '0b101' },
      { input: 'oct(64)', expected: '0o100' },
      { input: '0xff', expected: '255' },
      { input: '0b1011', expected: '11' },
      { input: '0o777', expected: '511' },
      { input: '0xff + 1', expected: '256' },
      { input: '5 & 3', expected: '1' },
      { input: '5 | 3', expected: '7' },
      { input: 'bitXor(5, 3)', expected: '6' },
      { input: '5 << 2', expected: '20' },
      { input: '20 >> 2', expected: '5' },
      { input: '~5', expected: '-6' },
    ],
  },
  {
    id: 'percentages',
    title: 'Percentages',
    blurb:
      'A percentage is a real value, so it survives arithmetic. Order matters: "50 + 20%" grows fifty, "20% + 50" is percentage maths.',
    examples: [
      { input: '20% of 50', expected: '10' },
      { input: '15% of 1,200', expected: '180' },
      { input: '100 + 15%', expected: '115' },
      { input: '200 - 10%', expected: '180' },
      { input: '20% off 50', expected: '40' },
      { input: '20% on 50', expected: '60' },
      { input: '80 + 10% - 10%', expected: '79.2' },
      { input: '45%', expected: '45%' },
      { input: '10% + 20%', expected: '30%' },
      { input: '90% - 40%', expected: '50%' },
      { input: '30% + 0.4', expected: '70%' },
      { input: '100% + 2 + 30%', expected: '330%' },
      { input: '50% * 30', expected: '15' },
      { input: '30 * 50%', expected: '15' },
      { input: '20% as dec', expected: '0.2' },
      { input: '$100 as number', expected: '100' },
    ],
  },
  {
    id: 'percentage-change',
    title: 'Percentage change',
    blurb: 'Working backwards from a result, or comparing two numbers.',
    examples: [
      { input: '20 is 10% of what', expected: '200' },
      { input: '180 is 10% off what', expected: '200' },
      { input: '220 is 10% on what', expected: '200' },
      { input: '50 to 75 is what %', expected: '50%' },
      { input: '40 to 90 as %', expected: '125%' },
      { input: '180 is what % off 200', expected: '10%' },
      { input: '180 is what % on 150', expected: '20%' },
      { input: '20 is what % of 200', expected: '10%' },
      { input: '20 as a % of 200', expected: '10%' },
      { input: '30 as a percentage of 200', expected: '15%' },
      { input: '20/200 as %', expected: '10%' },
      { input: '0.35 as %', expected: '35%' },
    ],
  },
  {
    id: 'fractions',
    title: 'Fractions and multipliers',
    blurb: 'Either can stand in wherever a percentage can.',
    examples: [
      { input: '2/10 as fraction', expected: '1/5' },
      { input: '50% as fraction', expected: '1/2' },
      { input: '2/3 of 600', expected: '400' },
      { input: '20/5 as multiplier', expected: '4x' },
      { input: '50 as x of 5', expected: '10x' },
      { input: '2 as multiplier of 1', expected: '2x' },
      { input: '2 as multiplier on 1', expected: '1x' },
      { input: '1 as x off 2', expected: '0.5x' },
      { input: '50 to 75 is what x', expected: '1.5x' },
      { input: '20 to 40 as x', expected: '2x' },
    ],
  },
  {
    id: 'units',
    title: 'Units',
    blurb: 'A bare number takes on the unit beside it.',
    examples: [
      { input: '5 km in miles', expected: '3.106856 miles' },
      { input: '100 cm to m', expected: '1 m' },
      { input: '180 lbs in kg', expected: '81.646627 kg' },
      { input: '65 mph in km/h', expected: '104.60736 km/h' },
      { input: '1 GB in MB', expected: '1,000 MB' },
      { input: '1 Gbps in Mbps', expected: '1,000 Mbps' },
      { input: '4 Mbps in MB/s', expected: '0.5 MB/s' },
      { input: '32 degF to degC', expected: '0 °C' },
      { input: '72 F in C', expected: '22.222222 °C' },
      { input: '20 °C in °F', expected: '68 °F' },
      { input: '3 cups in ml', expected: '709.76471 ml' },
      { input: '2 hours + 45 minutes', expected: '2.75 hours' },
      { input: '300 + 20 km', expected: '320 km' },
      { input: '12 widgets + 15 widgets', expected: '27 widgets' },
      { input: '1km + 1,000m', expected: '2 km' },
      { input: 'meters in 10 km', expected: '10,000 meters' },
      { input: 'days in 3 weeks', expected: '21 days' },
      { input: 'seconds in a day', expected: '86,400 seconds' },
      { input: '5 hours 30 minutes to seconds', expected: '19,800 seconds' },
      { input: 'km m', expected: '1,000 m' },
    ],
  },
  {
    id: 'rates',
    title: 'Rates',
    blurb: 'A quantity per unit of something.',
    examples: [
      { input: '3 hours / day', expected: '3 hours/day' },
      { input: '$99 per week', expected: '$99.00/week' },
      { input: '30 bottles / week', expected: '30/week' },
      { input: '90 km / 3 day', expected: '30 km/day' },
      { input: '$20/day + $300/week', expected: '$440.00/week' },
      { input: '$50/week * 12 weeks', expected: '$600.00' },
    ],
  },
  {
    id: 'currency',
    title: 'Currency',
    blurb:
      'Rates come from the European Central Bank. Mixed currencies answer in the last one named.',
    note: 'Answers use the rates bundled with this reference, not today’s.',
    examples: [
      { input: '$100', expected: '$100.00' },
      { input: '$1,250.50 * 2', expected: '$2,501.00' },
      { input: '100 USD in EUR', expected: '€80.00' },
      { input: '100 usd in eur', expected: '€80.00' },
      { input: '£75 to USD', expected: '$100.00' },
      { input: '€40 + €10', expected: '€50.00' },
      { input: '$100 + €80', expected: '€160.00' },
      { input: '1000 JPY in USD', expected: '$6.25' },
      { input: '100 USD in JPY', expected: '¥16,000' },
      { input: '$50 + 20%', expected: '$60.00' },
      { input: '20% of $250', expected: '$50.00' },
    ],
  },
  {
    id: 'past-rates',
    title: 'Rates on a past date',
    blurb:
      'Add "on <date>" to convert at that day’s published rate instead of today’s. A weekend or a holiday uses the last published day before it.',
    note: 'Answers use a pinned table for 1 January 2020, not real history.',
    examples: [
      { input: '100 USD in EUR on 2020-01-01', expected: '€89.00' },
      { input: '$100 in GBP on 2020-01-01', expected: '£75.50' },
      { input: '1,000 USD in JPY on 2020-01-01', expected: '¥108,600' },
    ],
  },
  {
    id: 'dates',
    title: 'Dates',
    blurb:
      'A date with no year takes whichever year is nearest today. ISO dates are unambiguous; slashes read as month/day/year and dots as day.month.year.',
    note: DATE_NOTE,
    examples: [
      { input: 'today', expected: 'Sat 15 Aug 2026' },
      { input: 'tomorrow', expected: 'Sun 16 Aug 2026' },
      { input: 'yesterday', expected: 'Fri 14 Aug 2026' },
      { input: 'today + 3 weeks', expected: 'Sat 5 Sep 2026' },
      { input: 'today - 10 days', expected: 'Wed 5 Aug 2026' },
      { input: '2026-01-31 + 1 month', expected: 'Sat 28 Feb 2026' },
      { input: '2026-01-01 + 1 year', expected: 'Fri 1 Jan 2027' },
      { input: 'April 1, 2019 - 3 months 5 days', expected: 'Thu 27 Dec 2018' },
      { input: '01.05.2005 + 3 years 2 months 3 weeks', expected: 'Tue 22 Jul 2008' },
      { input: '3 weeks after March 14, 2019', expected: 'Thu 4 Apr 2019' },
      { input: '28 days before March 12', expected: 'Thu 12 Feb 2026' },
      { input: '2 months 3 days after June 5', expected: 'Sat 8 Aug 2026' },
      { input: '4 days from now', expected: 'Wed 19 Aug 2026' },
      { input: '3 days ago', expected: 'Wed 12 Aug 2026' },
      { input: 'next friday', expected: 'Fri 21 Aug 2026' },
      { input: 'last monday', expected: 'Mon 10 Aug 2026' },
      { input: 'March 3 2026', expected: 'Tue 3 Mar 2026' },
      { input: '3 March 2026', expected: 'Tue 3 Mar 2026' },
    ],
  },
  {
    id: 'intervals',
    title: 'Intervals and calendar facts',
    blurb:
      'A range answers in calendar components; "days between" answers in whole days.',
    note: DATE_NOTE,
    examples: [
      { input: 'January 10 - February 5', expected: '3 weeks 5 days' },
      { input: '3 March to 30 May', expected: '2 months 3 weeks 6 days' },
      { input: 'days between 3 March and 30 May', expected: '88 days' },
      { input: '2026-01-01 to 2026-12-25', expected: '11 months 3 weeks 3 days' },
      { input: 'April 1 through April 30 in days', expected: '30 days' },
      { input: 'days until 2026-12-25', expected: '132 days' },
      { input: 'weeks until 2026-12-25', expected: '18.86 weeks' },
      { input: 'midpoint between March 12 and April 5', expected: 'Tue 24 Mar 2026' },
      { input: 'week of year', expected: '33' },
      { input: 'week number on march 12, 2021', expected: '10' },
      { input: 'days in Q3', expected: '92 days' },
      { input: 'days in February 2020', expected: '29 days' },
      { input: 'day of the week on January 24, 1984', expected: 'Tuesday' },
      { input: 'weekday on March 9, 2024', expected: 'Saturday' },
    ],
  },
  {
    id: 'workdays',
    title: 'Workdays',
    blurb: 'Monday to Friday, with public holidays excluded.',
    note: DATE_NOTE,
    examples: [
      { input: 'workdays in 3 weeks', expected: '15 workdays' },
      { input: '10 March to 17 March in workdays', expected: '5 workdays' },
      { input: 'workdays from April 12 to June 15', expected: '45 workdays' },
      { input: 'today + 5 business days', expected: 'Fri 21 Aug 2026' },
    ],
  },
  {
    id: 'time',
    title: 'Clock times and durations',
    blurb:
      'A laptime needs two colons and a timecode three, which is how they are told apart from a clock time.',
    note: DATE_NOTE,
    examples: [
      { input: '16:00 + 3 hours 12 minutes', expected: 'Sat 15 Aug 2026 at 7:12 pm' },
      { input: 'now + 3 hours 15 minutes', expected: 'Sat 15 Aug 2026 at 3:15 pm' },
      { input: '7:30 to 20:45', expected: '13 hours 15 minutes' },
      { input: '4pm to 3am', expected: '11 hours' },
      { input: '5.5 minutes as timespan', expected: '5 minutes 30 seconds' },
      { input: '4.54 hours as timespan', expected: '4 hours 32 minutes 24 seconds' },
      { input: '72 days as timespan', expected: '10 weeks 2 days' },
      { input: '3h 5m 10s', expected: '3 hours 5 minutes 10 seconds' },
      { input: '3h 5m 10s in seconds', expected: '11,110 seconds' },
      { input: '5.5 minutes as laptime', expected: '00:05:30' },
      { input: '03:04:05 + 01:02:03', expected: '04:06:08' },
      { input: '00:12:05 - 00:04:09', expected: '00:07:56' },
      { input: '03:04:05 as timespan', expected: '3 hours 4 minutes 5 seconds' },
      { input: '12.5 minutes in minutes and seconds', expected: '12 minutes 30 seconds' },
      { input: '4.5 weeks in days and hours', expected: '31 days 12 hours' },
    ],
  },
  {
    id: 'timezones',
    title: 'Time zones',
    blurb:
      'Cities, countries, IATA airport codes, US abbreviations and GMT offsets. "time in Paris" and "Tokyo time" report the current time there.',
    note: DATE_NOTE,
    examples: [
      { input: 'time difference between Seattle and Moscow', expected: '10 hours' },
    ],
  },
  {
    id: 'timecode',
    title: 'Video timecode',
    blurb: 'Frame arithmetic at any frame rate. 24 fps is assumed if none is given.',
    examples: [
      { input: '03:10:20:05 at 30 fps + 50 frames', expected: '03:10:21:25' },
      { input: '00:10:20:50 @ 60 fps + 10 minutes', expected: '00:20:20:50' },
      { input: '00:30:10:00 @ 24 fps in frames', expected: '43,440 frames' },
      { input: '43,440 frames @ 24 fps', expected: '00:30:10:00' },
      { input: '03:10:20:05 at 12 fps - 00:20:35:00', expected: '02:49:45:05' },
    ],
  },
  {
    id: 'statistics',
    title: 'Statistics',
    blurb: 'Over a list written on one line.',
    examples: [
      { input: 'total of 3, 4, 7 and 9', expected: '23' },
      { input: 'sum of 3, 4, 7 and 9', expected: '23' },
      { input: 'average of 36, 42, 19 and 81', expected: '44.5' },
      { input: 'count of 1, 2, 3, 4, 5', expected: '5' },
      { input: 'median of 10, 20 and 30', expected: '20' },
      { input: 'total of $3, $4 and $7', expected: '$14.00' },
    ],
  },
  {
    id: 'notes',
    title: 'Notes and comments',
    blurb:
      'Four ways to keep text out of the maths. A colon marks a label, not a variable — use = to declare one.',
    examples: [
      { input: '1 + 2 // this is three', expected: '3' },
      { input: 'Cost of 128 GB iPhone 16: $999', expected: '$999.00' },
      { input: '$999 (for iPhone 16)', expected: '$999.00' },
      { input: 'Boeing "747" is $386.8M', expected: '$386,800,000.00' },
      {
        input: 'I spent $128 + $45 on clothes // on 10-02-2019',
        expected: '$173.00',
      },
    ],
  },
];

/** Every example, flattened — handy for tests and for search. */
export const ALL_EXAMPLES: ReadonlyArray<Example & { group: string }> =
  EXAMPLE_GROUPS.flatMap((group) =>
    group.examples.map((example) => ({ ...example, group: group.id })),
  );
