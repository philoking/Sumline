import type { MathJsInstance } from 'mathjs';
import { UnknownUnitError } from './errors.js';

/**
 * Value types math.js has no notion of.
 *
 * The problem these solve is the same in every case: a number that carries a
 * meaning the expression parser would otherwise strip. `15%` reduced to
 * `0.15` forgets it was a percentage, so `10% + 20%` cannot answer `30%`.
 * Registering real types with math.js lets that meaning survive arithmetic.
 */

/** A percentage. `ratio` is the decimal form, so 15% is 0.15. */
export class Percentage {
  constructor(readonly ratio: number) {}
}

/** A multiplier, rendered with a trailing x. `4` is `4x`. */
export class Multiplier {
  constructor(readonly factor: number) {}
}

/**
 * A quantity per unit of something: `$99/week`, `3 hours/day`, `30/week`.
 *
 * math.js can express `90 km / 3 day` as a compound unit, but not these. It
 * cancels same-category units, turning `3 hours / day` into `0.125`, and has
 * no way to carry a unitless numerator at all — `30 / week` comes back as
 * `49.6 uHz`. A rate therefore keeps its numerator and denominator apart.
 */
export class Rate {
  constructor(
    readonly amount: unknown,
    readonly per: string,
  ) {}
}

/**
 * A count of something the engine has no unit for: `12 widgets`, `28 cameras`.
 *
 * The label is carried, not understood. Two quantities sharing a label add up
 * and keep it; mixed with anything else the label is dropped and a plain
 * number falls out, because `12 widgets + 3 kg` has no honest answer but 15 is
 * a more useful one than an error. `label` is stored exactly as written, so
 * the answer reads back the way the line does.
 */
export class Labelled {
  constructor(
    readonly value: number,
    readonly label: string,
  ) {}
}

export function isLabelled(value: unknown): value is Labelled {
  return value instanceof Labelled;
}

export function isRate(value: unknown): value is Rate {
  return value instanceof Rate;
}

export function isPercentage(value: unknown): value is Percentage {
  return value instanceof Percentage;
}

export function isMultiplier(value: unknown): value is Multiplier {
  return value instanceof Multiplier;
}

/** Anything that can stand in for a ratio on the right of a percentage. */
function asRatio(value: unknown): number {
  if (value instanceof Percentage) return value.ratio;
  if (typeof value === 'number') return value;
  const numeric = (value as { valueOf?: () => unknown })?.valueOf?.();
  return typeof numeric === 'number' ? numeric : Number.NaN;
}

/**
 * Teaches a math.js instance about the types above.
 *
 * The operand order rules come from Soulver and are not symmetric, which is
 * the whole reason they work:
 *
 *   `10% + 20%` → 30%   percentage plus percentage is a percentage
 *   `30% + 0.4` → 70%   a bare number on the right is read as a ratio
 *   `50 + 20%`  → 60    a percentage on the right of a number scales it
 *   `50% × 30`  → 15    multiplication always yields a plain number
 */
interface UnitLike {
  units: Array<{ unit: { name: string } }>;
  formatUnits(): string;
  toNumeric(valuelessUnit: string): number;
}

export function registerValueTypes(
  math: MathJsInstance,
  currencies: Set<string>,
): void {
  const typed = math.typed as unknown as {
    addType(spec: { name: string; test: (x: unknown) => boolean }): void;
  };

  const isMoney = (u: UnitLike) =>
    u.units.some((part) => currencies.has(part.unit.name));

  /**
   * Adds two units, choosing which one the answer is expressed in.
   *
   * Soulver's rule is that the last currency wins — `$200 + €200` answers in
   * euros — while everything else keeps the first operand's units, which is
   * also what math.js does on its own. Both cases are computed here because a
   * typed-function signature cannot decline a dispatch once it matches.
   */
  const combineUnits = (a: UnitLike, b: UnitLike, sign: 1 | -1): unknown => {
    const aUnits = a.formatUnits();
    const bUnits = b.formatUnits();
    const target = isMoney(a) && isMoney(b) && aUnits !== bUnits ? bUnits : aUnits;
    const total = a.toNumeric(target) + sign * b.toNumeric(target);
    return math.unit(total, target);
  };

  /** A bare number adopts the unit beside it, as Soulver's docs describe. */
  const assimilate = (value: number, unit: UnitLike): unknown =>
    math.unit(value, unit.formatUnits());

  typed.addType({ name: 'Percentage', test: isPercentage });
  typed.addType({ name: 'Multiplier', test: isMultiplier });
  typed.addType({ name: 'Rate', test: isRate });
  typed.addType({ name: 'Labelled', test: isLabelled });

  /** Same label keeps it; anything else falls back to a bare number. */
  const combineLabels = (a: Labelled, b: Labelled, total: number): unknown =>
    a.label.toLowerCase() === b.label.toLowerCase()
      ? new Labelled(total, a.label)
      : total;

  /** The numeric size of an operand a labelled quantity is combined with. */
  const sizeOf = (value: unknown): number => {
    if (value instanceof Labelled) return value.value;
    if (typeof value === 'number') return value;
    const unit = value as UnitLike;
    return typeof unit?.formatUnits === 'function'
      ? unit.toNumeric(unit.formatUnits())
      : Number.NaN;
  };

  /** How many of `from` make one `to` — 1 week is 7 days. */
  const perFactor = (from: string, to: string): number => {
    if (from === to) return 1;
    const converted = math.evaluate(`1 ${to} to ${from}`) as UnitLike;
    return converted.toNumeric(from);
  };

  /** Re-expresses a rate against a different denominator. */
  const rateTo = (rate: Rate, per: string): Rate =>
    new Rate(math.multiply(rate.amount as never, perFactor(rate.per, per) as never), per);

  const scale = (value: unknown, factor: number): unknown =>
    math.multiply(value as never, factor as never);

  math.import(
    {
      /** Constructor used by the preprocessor: `20%` becomes `pct(20)`. */
      pct: (n: number) => new Percentage(n / 100),
      multiplierOf: (n: number) => new Multiplier(n),

      /** `12 widgets` becomes `labelled(12, "widgets")`. */
      labelled: (value: number, label: string) => new Labelled(value, label),

      /** `20% as dec`, `5 km as number` — strip the meaning, keep the number. */
      asPlainNumber: math.typed('asPlainNumber', {
        Percentage: (p: Percentage) => p.ratio,
        Multiplier: (m: Multiplier) => m.factor,
        number: (n: number) => n,
        any: (v: unknown) => {
          const unit = v as { toNumeric?: (u: string) => number; formatUnits?: () => string };
          if (typeof unit?.formatUnits === 'function' && unit.toNumeric) {
            return unit.toNumeric(unit.formatUnits());
          }
          return Number((v as { valueOf?: () => unknown })?.valueOf?.() ?? Number.NaN);
        },
      }),

      /** `1/3 to 2 dp` is display-only; this is the value-changing kind. */
      roundStep: (value: unknown, step: number, mode: string): unknown => {
        const apply = (n: number) => {
          const scaled = n / step;
          const rounded =
            mode === 'up' ? Math.ceil(scaled)
            : mode === 'down' ? Math.floor(scaled)
            : Math.round(scaled);
          return rounded * step;
        };
        if (value instanceof Percentage) return new Percentage(apply(value.ratio * 100) / 100);
        if (typeof value === 'number') return apply(value);
        const unit = value as UnitLike;
        if (typeof unit?.formatUnits === 'function') {
          const label = unit.formatUnits();
          return math.unit(apply(unit.toNumeric(label)), label);
        }
        return value;
      },

      toFraction: (value: unknown) =>
        math.fraction(value instanceof Percentage ? value.ratio : (value as number)),

      rateOf: (amount: unknown, per: string) => new Rate(amount, per),
      rateTo: (rate: unknown, per: string) =>
        rate instanceof Rate ? rateTo(rate, per) : rate,

      /**
       * `12 GB/s in GB/minute` — a conversion naming both halves.
       *
       * The same phrasing covers ordinary compound units (`65 mph in km/h`),
       * which are not rates at all, so anything that is not a `Rate` is handed
       * to math.js as a single `numerator/denominator` conversion.
       */
      rateAs: (value: unknown, numerator: string, per: string): unknown => {
        if (!(value instanceof Rate)) {
          const unit = value as { to?: (target: string) => unknown };
          return typeof unit?.to === 'function' ? unit.to(`${numerator}/${per}`) : value;
        }
        const amount = value.amount as { to?: (target: string) => unknown };
        const renamed =
          typeof amount?.to === 'function' ? amount.to(numerator) : value.amount;
        return rateTo(new Rate(renamed, value.per), per);
      },

      /** `1.7e6` rather than `1.7M`, for the times you want the exponent. */
      sciOf: (value: unknown): string => {
        const n = value instanceof Percentage ? value.ratio : Number(value);
        return n.toExponential().replace('e+', 'e');
      },

      multiply: math.typed('multiply', {
        'Percentage, Percentage': (a: Percentage, b: Percentage) =>
          new Percentage(a.ratio * b.ratio),
        'Percentage, number': (a: Percentage, b: number) => a.ratio * b,
        'number, Percentage': (a: number, b: Percentage) => a * b.ratio,
        'Percentage, Unit': (a: Percentage, b: unknown) => scale(b, a.ratio),
        'Unit, Percentage': (a: unknown, b: Percentage) => scale(a, b.ratio),
        'Multiplier, number': (a: Multiplier, b: number) => a.factor * b,
        'number, Multiplier': (a: number, b: Multiplier) => a * b.factor,
        'Multiplier, Unit': (a: Multiplier, b: unknown) => scale(b, a.factor),
        'Unit, Multiplier': (a: unknown, b: Multiplier) => scale(a, b.factor),
        // A rate times a span of its own denominator collapses to a total:
        // `$50/week × 12 weeks` is $600.
        'Rate, Unit': (a: Rate, b: UnitLike) =>
          math.multiply(a.amount as never, b.toNumeric(a.per) as never),
        'Unit, Rate': (a: UnitLike, b: Rate) =>
          math.multiply(b.amount as never, a.toNumeric(b.per) as never),
        'Rate, number': (a: Rate, b: number) => new Rate(scale(a.amount, b), a.per),
        'number, Rate': (a: number, b: Rate) => new Rate(scale(b.amount, a), b.per),
        // Scaling a count keeps what is being counted; two counts multiplied
        // are not a count of anything, so the label goes.
        'Labelled, number': (a: Labelled, b: number) => new Labelled(a.value * b, a.label),
        'number, Labelled': (a: number, b: Labelled) => new Labelled(a * b.value, b.label),
        'Labelled, Labelled': (a: Labelled, b: Labelled) => a.value * b.value,
        'Labelled, Percentage': (a: Labelled, b: Percentage) =>
          new Labelled(a.value * b.ratio, a.label),
        'Percentage, Labelled': (a: Percentage, b: Labelled) =>
          new Labelled(a.ratio * b.value, b.label),
        // `28 cameras * 4 Mbps` is 112 Mbps: the count is the multiplier and
        // the unit is what the answer is in.
        'Labelled, Unit': (a: Labelled, b: unknown) => scale(b, a.value),
        'Unit, Labelled': (a: unknown, b: Labelled) => scale(a, b.value),
      }),

      divide: math.typed('divide', {
        'Percentage, number': (a: Percentage, b: number) => new Percentage(a.ratio / b),
        'number, Percentage': (a: number, b: Percentage) => a / b.ratio,
        'Unit, Percentage': (a: unknown, b: Percentage) => scale(a, 1 / b.ratio),
        'Labelled, number': (a: Labelled, b: number) => new Labelled(a.value / b, a.label),
        // Sharing counts between counts answers how many times over, not how
        // many things, so the label does not survive.
        'Labelled, Labelled': (a: Labelled, b: Labelled) => a.value / b.value,
        'number, Labelled': (a: number, b: Labelled) => a / b.value,
      }),

      unaryMinus: math.typed('unaryMinus', {
        Percentage: (a: Percentage) => new Percentage(-a.ratio),
        Multiplier: (a: Multiplier) => new Multiplier(-a.factor),
        Labelled: (a: Labelled) => new Labelled(-a.value, a.label),
      }),

      equal: math.typed('equal', {
        'Percentage, Percentage': (a: Percentage, b: Percentage) => a.ratio === b.ratio,
      }),

      compare: math.typed('compare', {
        'Percentage, Percentage': (a: Percentage, b: Percentage) =>
          a.ratio < b.ratio ? -1 : a.ratio > b.ratio ? 1 : 0,
      }),
    } as never,
    // Merge these signatures into the existing functions rather than replacing
    // them, so ordinary number and Unit arithmetic is untouched.
    { override: false } as never,
  );

  registerAdditionRules(math, combineUnits, assimilate, rateTo, combineLabels, sizeOf);
  registerMoneyProducts(math, isMoney);
  registerConversionRules(math);
}

/**
 * Converting something the engine could not identify as a quantity.
 *
 * `1 BTC in USD`, with no BTC in the rate table, reaches math.js as
 * `labelled(1, "BTC") to USD` — a count of BTCs, because that is all an
 * unrecognised word after a number can be. math.js refused it in its own
 * vocabulary ("expected: Array or DenseMatrix or Matrix"), which named neither
 * the line's problem nor its cause.
 *
 * The label is the one thing that identifies what went wrong, so the error
 * carries it and the answer column can say `No unit or currency called BTC`.
 */
function registerConversionRules(math: MathJsInstance): void {
  const originalTo = math.to.bind(math) as (a: unknown, b: unknown) => unknown;

  math.import(
    {
      to: math.typed('to', {
        'Labelled, any': (a: Labelled): never => {
          throw new UnknownUnitError(a.label);
        },
        'any, Labelled': (_a: unknown, b: Labelled): never => {
          throw new UnknownUnitError(b.label);
        },
        'any, any': (a: unknown, b: unknown) => originalTo(a, b),
      }),
    } as never,
    { override: true } as never,
  );
}

/**
 * Money multiplied by a quantity answers in money.
 *
 * `569.79 kWh × $0.11` is dimensionally kWh·USD, which is not a thing anyone
 * means: the writer is pricing something per kilowatt-hour. The quantity is
 * treated as a scalar, so the answer is a cash amount — and, just as
 * importantly, it is a value later lines can add to and the formatter renders
 * with a symbol, where a compound unit carried neither.
 *
 * Only a mixed currency-and-unit product is rewritten. Two currencies, a
 * currency times a bare number, and every rate are left to the rules that
 * already handle them, which is why this is registered as one narrow
 * signature over a fallback to everything math.js did before.
 */
function registerMoneyProducts(
  math: MathJsInstance,
  isMoney: (unit: UnitLike) => boolean,
): void {
  const originalMultiply = math.multiply.bind(math) as (a: unknown, b: unknown) => unknown;

  /** A plain amount in a single currency, with no prefix on the unit. */
  const plainMoney = (unit: UnitLike): boolean =>
    isMoney(unit) && unit.units.length === 1;

  math.import(
    {
      multiply: math.typed('multiply', {
        'Unit, Unit': (a: UnitLike, b: UnitLike) => {
          const aMoney = isMoney(a);
          if (aMoney === isMoney(b)) return originalMultiply(a, b);
          const money = aMoney ? a : b;
          const quantity = aMoney ? b : a;
          if (!plainMoney(money)) return originalMultiply(a, b);
          const label = money.formatUnits();
          const scaled =
            money.toNumeric(label) * quantity.toNumeric(quantity.formatUnits());
          return math.unit(scaled, label);
        },
        'any, any': (a: unknown, b: unknown) => originalMultiply(a, b),
      }),
    } as never,
    { override: true } as never,
  );
}

/**
 * Replaces `add` and `subtract` outright, because both already define
 * `Unit, Unit` and math.js refuses to merge over an existing signature.
 *
 * The original functions are captured first and reinstated as an `any, any`
 * fallback, so every case not named here behaves exactly as before — the
 * specific signatures win the dispatch, and everything else falls through.
 */
function registerAdditionRules(
  math: MathJsInstance,
  combineUnits: (a: UnitLike, b: UnitLike, sign: 1 | -1) => unknown,
  assimilate: (value: number, unit: UnitLike) => unknown,
  rateTo: (rate: Rate, per: string) => Rate,
  combineLabels: (a: Labelled, b: Labelled, total: number) => unknown,
  sizeOf: (value: unknown) => number,
): void {
  const originalAdd = math.add.bind(math) as (a: unknown, b: unknown) => unknown;
  const originalSubtract = math.subtract.bind(math) as (a: unknown, b: unknown) => unknown;
  const scale = (value: unknown, factor: number): unknown =>
    math.multiply(value as never, factor as never);

  math.import(
    {
      add: math.typed('add', {
        'Percentage, Percentage': (a: Percentage, b: Percentage) =>
          new Percentage(a.ratio + b.ratio),
        'Percentage, any': (a: Percentage, b: unknown) =>
          new Percentage(a.ratio + asRatio(b)),
        'number, Percentage': (a: number, b: Percentage) => a * (1 + b.ratio),
        'Unit, Percentage': (a: unknown, b: Percentage) => scale(a, 1 + b.ratio),
        'Unit, Unit': (a: UnitLike, b: UnitLike) => combineUnits(a, b, 1),
        'number, Unit': (a: number, b: UnitLike) =>
          combineUnits(assimilate(a, b) as UnitLike, b, 1),
        'Unit, number': (a: UnitLike, b: number) =>
          combineUnits(a, assimilate(b, a) as UnitLike, 1),
        'Rate, Rate': (a: Rate, b: Rate) =>
          new Rate(math.add(rateTo(a, b.per).amount as never, b.amount as never), b.per),
        'Labelled, Labelled': (a: Labelled, b: Labelled) =>
          combineLabels(a, b, a.value + b.value),
        'Labelled, any': (a: Labelled, b: unknown) => {
          const size = sizeOf(b);
          // A bare number joins the count; a unit or a currency does not, and
          // what is left is the arithmetic without the label.
          return typeof b === 'number'
            ? new Labelled(a.value + b, a.label)
            : a.value + size;
        },
        'any, Labelled': (a: unknown, b: Labelled) =>
          typeof a === 'number'
            ? new Labelled(a + b.value, b.label)
            : sizeOf(a) + b.value,
        'any, any': (a: unknown, b: unknown) => originalAdd(a, b),
      }),

      subtract: math.typed('subtract', {
        'Percentage, Percentage': (a: Percentage, b: Percentage) =>
          new Percentage(a.ratio - b.ratio),
        'Percentage, any': (a: Percentage, b: unknown) =>
          new Percentage(a.ratio - asRatio(b)),
        'number, Percentage': (a: number, b: Percentage) => a * (1 - b.ratio),
        'Unit, Percentage': (a: unknown, b: Percentage) => scale(a, 1 - b.ratio),
        'Unit, Unit': (a: UnitLike, b: UnitLike) => combineUnits(a, b, -1),
        'number, Unit': (a: number, b: UnitLike) =>
          combineUnits(assimilate(a, b) as UnitLike, b, -1),
        'Unit, number': (a: UnitLike, b: number) =>
          combineUnits(a, assimilate(b, a) as UnitLike, -1),
        'Rate, Rate': (a: Rate, b: Rate) =>
          new Rate(math.subtract(rateTo(a, b.per).amount as never, b.amount as never), b.per),
        'Labelled, Labelled': (a: Labelled, b: Labelled) =>
          combineLabels(a, b, a.value - b.value),
        'Labelled, any': (a: Labelled, b: unknown) =>
          typeof b === 'number'
            ? new Labelled(a.value - b, a.label)
            : a.value - sizeOf(b),
        'any, Labelled': (a: unknown, b: Labelled) =>
          typeof a === 'number'
            ? new Labelled(a - b.value, b.label)
            : sizeOf(a) - b.value,
        'any, any': (a: unknown, b: unknown) => originalSubtract(a, b),
      }),
    } as never,
    { override: true } as never,
  );
}
