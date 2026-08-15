import type { MathJsInstance } from 'mathjs';

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
      }),

      divide: math.typed('divide', {
        'Percentage, number': (a: Percentage, b: number) => new Percentage(a.ratio / b),
        'number, Percentage': (a: number, b: Percentage) => a / b.ratio,
        'Unit, Percentage': (a: unknown, b: Percentage) => scale(a, 1 / b.ratio),
      }),

      unaryMinus: math.typed('unaryMinus', {
        Percentage: (a: Percentage) => new Percentage(-a.ratio),
        Multiplier: (a: Multiplier) => new Multiplier(-a.factor),
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

  registerAdditionRules(math, combineUnits, assimilate, rateTo);
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
        'any, any': (a: unknown, b: unknown) => originalSubtract(a, b),
      }),
    } as never,
    { override: true } as never,
  );
}
