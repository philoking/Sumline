import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEngine } from '../src/index.js';

/**
 * The engine reads one clock, and reads it per evaluation.
 *
 * Both halves used to be wrong in a way that only showed on a tab left open:
 * `evaluate()` took a fresh `new Date()` while the formatting context froze one
 * at construction, so `today` was computed against one instant and rendered
 * against another. Nothing in the golden table could catch it, because every
 * example pins `now` and so never lets the two drift apart.
 */
describe('the engine clock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the clock on every evaluation, not once at construction', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 15, 12, 0, 0));
    const engine = createEngine();

    expect(engine.evaluate('today')[0]?.output).toBe('Sat 15 Aug 2026');

    vi.setSystemTime(new Date(2026, 7, 18, 12, 0, 0));
    expect(engine.evaluate('today')[0]?.output).toBe('Tue 18 Aug 2026');
  });

  it('formats against the same instant it evaluated against', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 15, 12, 0, 0));
    const engine = createEngine();

    // Exactly one day, because the relative wording this guards against only
    // appears at plus or minus a day: a zoned clock time is labelled "Tomorrow
    // at …" when it lands on a different day than the reader's. Evaluated and
    // formatted against the same instant it never can, since both sides derive
    // the day from that instant.
    vi.setSystemTime(new Date(2026, 7, 16, 12, 0, 0));

    expect(engine.evaluate('2am PST to GMT')[0]?.output).not.toMatch(
      /Tomorrow|Yesterday/,
    );
  });

  it('pins both clocks when `now` is given', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 15, 12, 0, 0));
    const engine = createEngine({ now: new Date(2026, 7, 15, 12, 0, 0) });

    vi.setSystemTime(new Date(2027, 0, 1, 12, 0, 0));

    // The reference table and every date test depend on this staying fixed.
    expect(engine.evaluate('today')[0]?.output).toBe('Sat 15 Aug 2026');
  });
});
